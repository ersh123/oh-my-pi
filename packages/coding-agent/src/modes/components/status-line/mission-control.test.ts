import { describe, expect, it } from "bun:test";
import { advancePhase, createState, mintGateRequest, setTicketDag } from "../../../nikoflow/state";
import { getMissionControlNikoflowState, renderMissionControlSparkline } from "./mission-control";

const tickets = [
	{
		id: "TSK-001",
		acceptance: ["first ticket works"],
		blocked_by: [],
		implementation_notes: "implement the first ticket",
		status: "done" as const,
	},
	{
		id: "TSK-002",
		acceptance: ["second ticket works"],
		blocked_by: ["TSK-001"],
		implementation_notes: "implement the second ticket",
		status: "red" as const,
	},
];

describe("Nikoflow mission-control state", () => {
	it("maps active execute work and ticket progress without styling", () => {
		let state = setTicketDag(createState("light"), tickets);
		state = advancePhase(advancePhase(advancePhase(state)));
		state = { ...state, activeTicketId: "TSK-002" };

		expect(getMissionControlNikoflowState(state)).toEqual({
			phase: "execute",
			phaseLabel: "EXEC",
			signal: "active",
			activeTicketId: "TSK-002",
			completedTickets: 1,
			totalTickets: 2,
			phases: ["grilling", "prd", "tickets", "execute", "verify"],
			completedPhaseCount: 3,
		});
	});

	it("reports a gate wait ahead of all other state", () => {
		const state = mintGateRequest(createState("max"), "gate-42");
		const hud = getMissionControlNikoflowState(state);

		expect(hud.phaseLabel).toBe("GRILL");
		expect(hud.signal).toBe("waiting");
	});

	it("reports TDD RED and GREEN evidence for the active ticket", () => {
		let state = setTicketDag(createState("light"), tickets);
		state = advancePhase(advancePhase(advancePhase(state)));
		state = { ...state, activeTicketId: "TSK-002", gateRequestId: null };
		state = {
			...state,
			tddEvidence: {
				ticketId: "TSK-002",
				gateId: "gate-42",
				red: { command: "bun test", exitCode: 1, expectedFailure: "fails first", recordedAt: 1 },
			},
		};
		expect(getMissionControlNikoflowState(state).signal).toBe("red");

		state = {
			...state,
			tddEvidence: {
				...state.tddEvidence!,
				green: { command: "bun test", exitCode: 0, recordedAt: 2 },
			},
		};
		expect(getMissionControlNikoflowState(state).signal).toBe("green");
	});

	it("renders token-rate samples as a compact terminal graph", () => {
		expect(renderMissionControlSparkline([])).toBe("");
		expect(renderMissionControlSparkline([0, 1, 2, 4])).toBe("▁▃▅█");
	});
});
