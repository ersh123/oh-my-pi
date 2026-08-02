import { describe, expect, test } from "bun:test";
import { NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME } from "../gates";
import {
	advanceNikoflowAdvisorGate,
	advanceNikoflowExecuteGate,
	advanceNikoflowHumanGate,
	enterNikoflowPhase,
	type MinimalToolCallContext,
	type NikoflowAdvisorReview,
	type NikoflowPhaseEntryHost,
	type NikoflowSessionModel,
	nikoflowToolViolation,
} from "../mode";
import {
	advancePhase,
	createState,
	currentPhase,
	currentTicket,
	isComplete,
	markPhaseTurnStarted,
	materializePhases,
	mintGateRequest,
	type NikoflowPhase,
	nikoflowModeData,
	nikoflowStateFromModeData,
	setTicketDag,
} from "../state";
import { type NikoflowTicket, recordNikoflowTddEvidence } from "../tickets";

type GateMessage = {
	role: "user" | "toolResult";
	timestamp: number;
	toolName?: string;
	details?: unknown;
};

const tickets: NikoflowTicket[] = [
	{
		id: "TSK-001",
		acceptance: ["Given a focused regression, when it runs, then the original bug is reproduced"],
		blocked_by: [],
		implementation_notes: "Add the smallest failing test.",
		status: "todo",
	},
	{
		id: "TSK-002",
		acceptance: ["Given the fix, when the same focused command runs, then it passes"],
		blocked_by: ["TSK-001"],
		implementation_notes: "Implement and verify the root-cause fix.",
		status: "todo",
	},
];

const gateOptions = (nextGateRequestId: () => string, now: () => number) => ({
	isGenuineUserTurn: (message: GateMessage) => message.role === "user",
	messageTimestamp: (message: GateMessage) => message.timestamp,
	messageToolName: (message: GateMessage) => (message.role === "toolResult" ? message.toolName : undefined),
	messageToolResult: (message: GateMessage) => (message.role === "toolResult" ? message.details : undefined),
	nextGateRequestId,
	now,
});

function approvedReview(gateId: string): NikoflowAdvisorReview {
	return {
		gateId,
		reviewed: true,
		verdict: "approve",
		notes: [{ gateId, severity: "nit", verdict: "approve", note: "All acceptance checks pass." }],
	};
}

function blockerReview(gateId: string): NikoflowAdvisorReview {
	return {
		gateId,
		reviewed: true,
		verdict: "blocker",
		notes: [{ gateId, severity: "blocker", verdict: "blocker", note: "Missing regression evidence." }],
	};
}

function builtinTool(name: string): MinimalToolCallContext {
	return { toolCall: { name }, args: {}, toolSource: "builtin" };
}

describe("Nikoflow lifecycle end to end", () => {
	test("drives an interactive max flow through human gates, ticket TDD, resume, advisor, and verify", async () => {
		let clock = 100;
		let gateSequence = 0;
		let state = createState("max", { originalTask: "Fix the async quiescence regression" });
		const enteredPhases: Array<NikoflowPhase | null> = [];
		const roles: string[] = [];
		const nextGateRequestId = () => `gate-${++gateSequence}`;
		const now = () => ++clock;
		const host: NikoflowPhaseEntryHost<NikoflowSessionModel> = {
			resolveRoleModelWithThinking: role => ({
				model: { provider: "mock", id: role },
				explicitThinkingLevel: false,
			}),
			applyRoleModel: entry => {
				roles.push(entry.role);
			},
			setState: next => {
				state = next;
			},
			sendNikoflowContext: next => {
				enteredPhases.push(currentPhase(next));
			},
		};
		const enter = async (previous: NikoflowPhase | null, next: NikoflowPhase) => {
			state = (
				await enterNikoflowPhase(host, previous, next, state, {
					nextGateRequestId,
					now,
					requestAdvisorReview: false,
				})
			).state;
		};
		const approveHumanGate = () => {
			state = markPhaseTurnStarted(state);
			state = advanceNikoflowHumanGate(
				state,
				[{ role: "user", timestamp: now() } satisfies GateMessage],
				gateOptions(nextGateRequestId, now),
			);
		};
		const recordRed = () => {
			const ticket = currentTicket(state);
			const gateId = state.gateRequestId;
			if (!ticket || !gateId) throw new Error("Expected an active ticket gate");
			const red = recordNikoflowTddEvidence(
				state.tddEvidence,
				{
					stage: "red",
					ticketId: ticket.id,
					gateId,
					command: `bun test ${ticket.id}.test.ts`,
					exitCode: 1,
					expectedFailure: "Focused regression fails before the implementation",
				},
				now(),
			);
			expect(red.errors).toEqual([]);
			state = { ...state, tddEvidence: red.evidence };
		};
		const recordGreen = () => {
			const ticket = currentTicket(state);
			const gateId = state.gateRequestId;
			const command = state.tddEvidence?.red?.command;
			if (!ticket || !gateId || !command) throw new Error("Expected gate-bound RED evidence");
			const green = recordNikoflowTddEvidence(
				state.tddEvidence,
				{ stage: "green", ticketId: ticket.id, gateId, command, exitCode: 0 },
				now(),
			);
			expect(green.errors).toEqual([]);
			state = { ...state, tddEvidence: green.evidence };
		};

		await enter(null, "grilling");
		expect(nikoflowToolViolation(state, builtinTool("write"))).toContain("read-only");
		state = advanceNikoflowHumanGate(
			state,
			[
				{
					role: "toolResult",
					timestamp: now(),
					toolName: NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME,
					details: { openQuestions: [], assumptions: ["Tests use an isolated model registry"], risks: [] },
				} satisfies GateMessage,
				{ role: "user", timestamp: now() } satisfies GateMessage,
			],
			gateOptions(nextGateRequestId, now),
		);
		expect(currentPhase(state)).toBe("adr");

		await enter("grilling", "adr");
		approveHumanGate();
		await enter("adr", "prd");
		approveHumanGate();
		await enter("prd", "tickets");
		state = setTicketDag(state, tickets);
		approveHumanGate();
		await enter("tickets", "execute");
		expect(nikoflowToolViolation(state, builtinTool("write"))).toBeNull();

		for (let index = 0; index < tickets.length; index++) {
			state = markPhaseTurnStarted(state);
			state = advanceNikoflowExecuteGate(state, { nextGateRequestId, now });
			recordRed();
			if (index === 0) {
				state = nikoflowStateFromModeData(nikoflowModeData(state)) ?? state;
				expect(state.tddEvidence?.red?.exitCode).toBe(1);
			}
			recordGreen();
			state = advanceNikoflowExecuteGate(state, { nextGateRequestId, now });
			expect(currentTicket(state)?.status).toBe("review");
			const reviewGate = state.gateRequestId;
			if (!reviewGate) throw new Error("Expected ticket advisor gate");
			if (index === 0) {
				const blocked = advanceNikoflowAdvisorGate(state, blockerReview(reviewGate));
				expect(blocked).toBe(state);
			}
			state = advanceNikoflowAdvisorGate(state, approvedReview(reviewGate));
		}

		expect(currentPhase(state)).toBe("verify");
		await enter("execute", "verify");
		const verifyGate = state.gateRequestId;
		if (!verifyGate) throw new Error("Expected verify advisor gate");
		state = advanceNikoflowAdvisorGate(state, approvedReview(verifyGate));

		expect(isComplete(state)).toBe(true);
		expect(state.tickets.map(ticket => ticket.status)).toEqual(["done", "done"]);
		expect(enteredPhases).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
		expect(roles).toEqual(["plan", "plan", "plan", "plan", "default", "advisor"]);
	});

	test("routes light development through PRD and tickets without ADR", async () => {
		let state = createState("light", { originalTask: "Build a small feature" });
		const phases = materializePhases("light");
		const enteredPhases: Array<NikoflowPhase | null> = [];
		const roles: string[] = [];
		const host: NikoflowPhaseEntryHost<NikoflowSessionModel> = {
			resolveRoleModelWithThinking: role => ({
				model: { provider: "mock", id: role },
				explicitThinkingLevel: false,
			}),
			applyRoleModel: entry => {
				roles.push(entry.role);
			},
			setState: next => {
				state = next;
			},
			sendNikoflowContext: next => {
				enteredPhases.push(currentPhase(next));
			},
		};

		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index];
			if (!phase) throw new Error("Expected light phase");
			state = (
				await enterNikoflowPhase(host, phases[index - 1] ?? null, phase, state, {
					nextGateRequestId: () => `light-${index}`,
					now: () => index,
					mintGate: false,
					requestAdvisorReview: false,
				})
			).state;
			state = advancePhase(state);
		}

		expect(isComplete(state)).toBe(true);
		expect(enteredPhases).toEqual(["grilling", "prd", "tickets", "execute", "verify"]);
		expect(roles).toEqual(["plan", "plan", "plan", "default", "advisor"]);
	});

	test("drives light batch mode through planning, ticket TDD, and independent approvals", async () => {
		let clock = 200;
		let state = mintGateRequest(createState("light", { autonomous: true }), "batch-grilling", clock);
		const now = () => ++clock;
		const nextGateRequestId = () => `batch-${clock}`;
		const options = gateOptions(nextGateRequestId, now);
		const approveBatchPhase = (gateId: string) => {
			state = mintGateRequest(markPhaseTurnStarted(state), gateId, now());
			state = advanceNikoflowHumanGate(state, [], options);
			expect(state.batchGateAcceptedAt).not.toBeNull();
			state = advanceNikoflowAdvisorGate(state, approvedReview(gateId));
		};

		state = advanceNikoflowHumanGate(
			state,
			[
				{
					role: "toolResult",
					timestamp: now(),
					toolName: NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME,
					details: {
						openQuestions: [],
						assumptions: ["human-unverified: preserve existing behavior"],
						risks: ["independent verification required"],
					},
				} satisfies GateMessage,
			],
			options,
		);
		expect(advanceNikoflowAdvisorGate(state, blockerReview("batch-grilling"))).toBe(state);
		state = advanceNikoflowAdvisorGate(state, approvedReview("batch-grilling"));
		expect(currentPhase(state)).toBe("prd");

		approveBatchPhase("batch-prd");
		expect(currentPhase(state)).toBe("tickets");
		state = setTicketDag(state, [{ ...tickets[0]!, blocked_by: [], status: "todo" }]);
		approveBatchPhase("batch-tickets");
		expect(currentPhase(state)).toBe("execute");
		const firstTicket = state.tickets[0];
		if (!firstTicket) throw new Error("Expected light ticket DAG");
		state = {
			...state,
			tickets: state.tickets.map(ticket => (ticket.id === firstTicket.id ? { ...ticket, status: "red" } : ticket)),
			activeTicketId: firstTicket.id,
		};

		state = mintGateRequest(markPhaseTurnStarted(state), "batch-execute", now());
		const ticket = currentTicket(state);
		if (!ticket) throw new Error("Expected active light ticket");
		const red = recordNikoflowTddEvidence(
			state.tddEvidence,
			{
				stage: "red",
				ticketId: ticket.id,
				gateId: "batch-execute",
				command: "bun test light-e2e",
				exitCode: 1,
				expectedFailure: "focused light regression fails",
			},
			now(),
		);
		const green = recordNikoflowTddEvidence(
			red.evidence,
			{
				stage: "green",
				ticketId: ticket.id,
				gateId: "batch-execute",
				command: "bun test light-e2e",
				exitCode: 0,
			},
			now(),
		);
		state = { ...state, tddEvidence: green.evidence };
		state = advanceNikoflowExecuteGate(state, { nextGateRequestId, now });
		expect(currentTicket(state)?.status).toBe("review");
		state = advanceNikoflowAdvisorGate(state, approvedReview("batch-execute"));
		expect(currentPhase(state)).toBe("verify");

		state = mintGateRequest(state, "batch-verify", now());
		expect(advanceNikoflowAdvisorGate(state, blockerReview("batch-verify"))).toBe(state);
		state = advanceNikoflowAdvisorGate(state, approvedReview("batch-verify"));

		expect(isComplete(state)).toBe(true);
	});
});
