import { describe, expect, test } from "bun:test";
import {
	advancePhase,
	clearGateRequest,
	createState,
	currentPhase,
	currentRole,
	gateMatches,
	inferDepthFromPrompt,
	isComplete,
	isHumanGatePhase,
	markPhaseTurnStarted,
	materializePhases,
	mintGateRequest,
	nikoflowModeData,
	nikoflowStateFromModeData,
	rotateGateRequest,
	setTicketDag,
} from "../state";
import type { NikoflowTicket } from "../tickets";

describe("nikoflow state", () => {
	test("materializes phases per depth", () => {
		expect(materializePhases("tactical")).toEqual(["grilling", "execute", "verify"]);
		expect(materializePhases("standard")).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
		expect(materializePhases("deep")).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
	});

	test("infers depth from explicit flags or no-question prompts", () => {
		expect(inferDepthFromPrompt("niko flow:deep build")).toBe("deep");
		expect(inferDepthFromPrompt("делай в режиме никофлоу и не задавай вопросов")).toBe("standard");
		expect(inferDepthFromPrompt("давай никофлоу")).toBeNull();
		expect(inferDepthFromPrompt("не задавай вопросов")).toBeNull();
	});

	test("advances to complete and maps roles", () => {
		let state = createState("standard");
		expect(currentPhase(state)).toBe("grilling");
		expect(currentRole(state)).toBe("plan");
		state = advancePhase(state);
		expect(currentPhase(state)).toBe("adr");
		expect(currentRole(state)).toBe("plan");
		state = advancePhase(advancePhase(advancePhase(state)));
		expect(currentPhase(state)).toBe("execute");
		expect(currentRole(state)).toBe("default");
		state = advancePhase(state);
		expect(currentPhase(state)).toBe("verify");
		expect(currentRole(state)).toBe("advisor");
		state = advancePhase(state);
		expect(isComplete(state)).toBe(true);
		expect(currentPhase(state)).toBeNull();
		expect(currentRole(state)).toBeNull();
	});

	test("detects human-gate phases", () => {
		let state = createState("standard");
		expect(isHumanGatePhase(state)).toBe(true);
		state = advancePhase(state);
		expect(isHumanGatePhase(state)).toBe(true);
		state = advancePhase(advancePhase(advancePhase(state)));
		expect(currentPhase(state)).toBe("execute");
		expect(isHumanGatePhase(state)).toBe(false);
	});

	test("gate ids mint, rotate, clear, and fail closed", () => {
		const initial = createState("tactical");
		const minted = mintGateRequest(initial, "g1", 123);
		const rotated = rotateGateRequest(minted, "g2", 456);
		const cleared = clearGateRequest(rotated);

		expect(gateMatches(initial, "g1")).toBe(false);
		expect(gateMatches(minted, "g1")).toBe(true);
		expect(minted.gateMintedAt).toBe(123);
		expect(gateMatches(rotated, "g1")).toBe(false);
		expect(gateMatches(rotated, "g2")).toBe(true);
		expect(rotated.gateMintedAt).toBe(456);
		expect(gateMatches(cleared, "g2")).toBe(false);
		expect(cleared.gateMintedAt).toBeNull();
		expect(gateMatches(cleared, null)).toBe(false);
	});

	test("tracks autonomous batch mode in state", () => {
		const interactive = createState("standard");
		const batch = createState("standard", { autonomous: true });
		const ready = { ...batch, batchGateAcceptedAt: 123 };

		expect(interactive.autonomous).toBe(false);
		expect(batch.autonomous).toBe(true);
		expect(advancePhase(ready).batchGateAcceptedAt).toBeNull();
	});

	test("round-trips grilling mode through mode data", () => {
		const state = createState("standard", { grillingMode: "interview", originalTask: "fix the gate" });
		const restored = nikoflowStateFromModeData(nikoflowModeData(state));

		expect(state.grillingMode).toBe("interview");
		expect(restored?.grillingMode).toBe("interview");
		expect(restored?.originalTask).toBe("fix the gate");
	});

	test("restores missing or unknown grilling mode as null", () => {
		expect(nikoflowStateFromModeData({ depth: "standard", phaseIndex: 0 })?.grillingMode).toBeNull();
		expect(
			nikoflowStateFromModeData({
				depth: "standard",
				phaseIndex: 0,
				grillingMode: "marathon",
			})?.grillingMode,
		).toBeNull();
	});

	test("mutators return new objects", () => {
		const initial = createState("tactical");
		const minted = mintGateRequest(initial, "g1");
		const advanced = advancePhase(minted);

		expect(minted).not.toBe(initial);
		expect(advanced).not.toBe(minted);
		expect(initial.gateRequestId).toBeNull();
		expect(minted.gateRequestId).toBe("g1");
		expect(advanced.gateRequestId).toBeNull();
		expect(advanced.gateMintedAt).toBeNull();
	});

	test("tracks whether a model turn started in the current phase", () => {
		const initial = createState("tactical");
		const started = markPhaseTurnStarted(initial);
		const execute = advancePhase(started);

		expect(initial.phaseTurnStarted).toBe(false);
		expect(started.phaseTurnStarted).toBe(true);
		expect(execute.phaseTurnStarted).toBe(false);
		expect(markPhaseTurnStarted(started)).toBe(started);
	});

	test("restores resumable mode data at execute and preserves recovered ticket statuses", () => {
		let state = createState("standard", { autonomous: true });
		state = advancePhase(advancePhase(advancePhase(advancePhase(state))));
		state = mintGateRequest(state, "execute-gate", 123);

		const restored = nikoflowStateFromModeData(nikoflowModeData(state));
		expect(restored).not.toBeNull();
		expect(currentPhase(restored!)).toBe("execute");
		expect(restored!.gateRequestId).toBe("execute-gate");
		expect(restored!.gateMintedAt).toBe(123);
		expect(restored!.autonomous).toBe(true);

		const tickets: NikoflowTicket[] = [
			{
				id: "TSK-001",
				acceptance: ["base works"],
				blocked_by: [],
				implementation_notes: "base",
				status: "done",
			},
			{
				id: "TSK-002",
				acceptance: ["next works"],
				blocked_by: ["TSK-001"],
				implementation_notes: "next",
				status: "review",
			},
		];
		const withTickets = setTicketDag(restored!, tickets);

		expect(currentPhase(withTickets)).toBe("execute");
		expect(withTickets.tickets.map(ticket => [ticket.id, ticket.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "review"],
		]);
	});
});
