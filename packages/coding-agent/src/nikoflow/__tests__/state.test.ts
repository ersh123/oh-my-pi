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
		expect(materializePhases("research")).toEqual(["grilling", "research", "verify"]);
		expect(materializePhases("light")).toEqual(["grilling", "prd", "tickets", "execute", "verify"]);
		expect(materializePhases("max")).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
	});

	test("infers depth from explicit flags or no-question prompts", () => {
		expect(inferDepthFromPrompt("niko flow:research build")).toBe("research");
		expect(inferDepthFromPrompt("niko flow:research")).toBe("research");
		expect(inferDepthFromPrompt("niko flow:max build")).toBe("max");
		expect(inferDepthFromPrompt("делай в режиме никофлоу и не задавай вопросов")).toBe("max");
		expect(inferDepthFromPrompt("niko flow:deep build")).toBeNull();
	});

	test("advances to complete and maps roles", () => {
		let state = createState("max");
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
		let state = createState("max");
		expect(isHumanGatePhase(state)).toBe(true);
		state = advancePhase(state);
		expect(isHumanGatePhase(state)).toBe(true);
		state = advancePhase(advancePhase(advancePhase(state)));
		expect(currentPhase(state)).toBe("execute");
		expect(isHumanGatePhase(state)).toBe(false);
	});

	test("gate ids mint, rotate, clear, and fail closed", () => {
		const initial = createState("light");
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
		const interactive = createState("max");
		const batch = createState("max", { autonomous: true });
		const ready = { ...batch, batchGateAcceptedAt: 123 };

		expect(interactive.autonomous).toBe(false);
		expect(batch.autonomous).toBe(true);
		expect(advancePhase(ready).batchGateAcceptedAt).toBeNull();
	});

	test("round-trips grilling mode through mode data", () => {
		const state = createState("max", { grillingMode: "interview", originalTask: "fix the gate" });
		const restored = nikoflowStateFromModeData(nikoflowModeData(state));

		expect(state.grillingMode).toBe("interview");
		expect(restored?.grillingMode).toBe("interview");
		expect(restored?.originalTask).toBe("fix the gate");
	});

	test("restores missing or unknown grilling mode as null", () => {
		expect(nikoflowStateFromModeData({ depth: "max", phaseIndex: 0 })?.grillingMode).toBeNull();
		expect(
			nikoflowStateFromModeData({
				depth: "max",
				phaseIndex: 0,
				grillingMode: "marathon",
			})?.grillingMode,
		).toBeNull();
	});

	test("mutators return new objects", () => {
		const initial = createState("light");
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
		const initial = createState("light");
		const started = markPhaseTurnStarted(initial);
		const execute = advancePhase(started);

		expect(initial.phaseTurnStarted).toBe(false);
		expect(started.phaseTurnStarted).toBe(true);
		expect(execute.phaseTurnStarted).toBe(false);
		expect(markPhaseTurnStarted(started)).toBe(started);
	});

	test("restores resumable mode data at execute and preserves recovered ticket statuses", () => {
		let state = createState("max", { autonomous: true });
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

	test("round-trips durable recovery and ticket state through mode data", () => {
		const tickets: NikoflowTicket[] = [
			{
				id: "TSK-001",
				acceptance: ["done works"],
				blocked_by: [],
				implementation_notes: "ship first",
				status: "done",
			},
			{
				id: "TSK-002",
				acceptance: ["review works"],
				blocked_by: ["TSK-001"],
				implementation_notes: "ship second",
				status: "review",
			},
		];
		const state = {
			...mintGateRequest(setTicketDag(markPhaseTurnStarted(createState("max")), tickets), "gate-1", 321),
			activeTicketId: "TSK-002",
			roleOverrides: {
				plan: "openai/gpt-5.5",
				advisor: "anthropic/claude-sonnet-4-5",
			},
			roleSwitchCounts: {
				plan: 2,
				advisor: 1,
			},
			deadSelectors: ["openai/dead-model", "anthropic/dead-model"],
		};

		const restored = nikoflowStateFromModeData(nikoflowModeData(state));

		expect(restored?.phaseTurnStarted).toBe(true);
		expect(restored?.gateRequestId).toBe("gate-1");
		expect(restored?.activeTicketId).toBe("TSK-002");
		expect(restored?.tickets.map(ticket => [ticket.id, ticket.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "review"],
		]);
		expect(restored?.roleOverrides).toEqual({
			plan: "openai/gpt-5.5",
			advisor: "anthropic/claude-sonnet-4-5",
		});
		expect(restored?.roleSwitchCounts).toEqual({ plan: 2, advisor: 1 });
		expect(restored?.deadSelectors).toEqual(["openai/dead-model", "anthropic/dead-model"]);
	});

	test("round-trips TDD evidence and drops stale GREEN when the execute gate rotates", () => {
		const tickets: NikoflowTicket[] = [
			{
				id: "TSK-001",
				acceptance: ["works"],
				blocked_by: [],
				implementation_notes: "ship",
				status: "red",
			},
		];
		let state = advancePhase(advancePhase(advancePhase(advancePhase(createState("max")))));
		state = mintGateRequest({ ...setTicketDag(state, tickets), activeTicketId: "TSK-001" }, "gate-1", 100);
		state = {
			...state,
			tddEvidence: {
				ticketId: "TSK-001",
				gateId: "gate-1",
				red: { command: "bun test focused", exitCode: 1, expectedFailure: "expected", recordedAt: 1 },
				green: { command: "bun test focused", exitCode: 0, recordedAt: 2 },
			},
		};

		const restored = nikoflowStateFromModeData(nikoflowModeData(state));
		expect(restored?.tddEvidence).toEqual(state.tddEvidence);

		const rotated = rotateGateRequest(restored!, "gate-2", 200);
		expect(rotated.tddEvidence).toEqual({
			ticketId: "TSK-001",
			gateId: "gate-2",
			red: state.tddEvidence?.red,
		});
	});
});
