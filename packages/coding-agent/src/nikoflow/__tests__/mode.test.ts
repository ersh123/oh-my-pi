import { describe, expect, test } from "bun:test";
import { NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME } from "../gates";
import { NIKOFLOW_RECORD_RESEARCH_TOOL_NAME } from "../research";
import {
	advanceNikoflowAdvisorGate,
	advanceNikoflowExecuteGate,
	advanceNikoflowHumanGate,
	createNikoflowBeforeToolCall,
	createNikoflowCallbackBundle,
	createNikoflowGetToolChoice,
	createNikoflowOnBeforeYield,
	createNikoflowOnTurnEnd,
	enterNikoflowPhase,
	formatGateHoldMessage,
	installNikoflowAgentSessionMode,
	installNikoflowCallbacks,
	isNikoflowReadOnlyPhaseToolAllowed,
	type MinimalToolCallContext,
	type NikoflowAdvisorReview,
	type NikoflowAgentSessionHost,
	type NikoflowCallbackHost,
	type NikoflowPhaseEntryHost,
	nikoflowToolViolation,
	requiresTicketDag,
} from "../mode";
import { getPhasePrompt } from "../prompts";
import {
	advancePhase,
	createState,
	currentPhase,
	currentRole,
	isComplete,
	markPhaseTurnStarted,
	mintGateRequest,
	type NikoflowDepth,
	type NikoflowPhase,
	type NikoflowState,
	rotateGateRequest,
	setTicketDag,
} from "../state";
import type { NikoflowTicket } from "../tickets";

const readOnlyReason = (phase: string, gate = "the Ticketization gate advances") =>
	`Nikoflow ${phase} is read-only; only read/search/planning tools are allowed. Writes and code-execution tools are blocked until ${gate}.`;

const tool = (name: string, args: Record<string, unknown> = {}, toolSource = "builtin"): MinimalToolCallContext => ({
	toolCall: { name },
	args,
	toolSource,
});

const customTool = (name: string, args: Record<string, unknown> = {}): MinimalToolCallContext =>
	tool(name, args, "custom");

type GateMessage = {
	role: "user" | "assistant" | "toolResult";
	timestamp: number;
	content?: string;
	toolName?: string;
	details?: unknown;
};

const gateOptions = {
	isGenuineUserTurn: (message: GateMessage) => message.role === "user",
	messageTimestamp: (message: GateMessage) => message.timestamp,
	messageToolName: (message: GateMessage) => (message.role === "toolResult" ? message.toolName : undefined),
	messageToolResult: (message: GateMessage) => (message.role === "toolResult" ? message.details : undefined),
	nextGateRequestId: () => "next-gate",
	now: () => 20,
};

const grillingConvergedMessage = (
	timestamp: number,
	openQuestions: string[] = [],
	assumptions: string[] = [],
	risks: string[] = [],
): GateMessage => ({
	role: "toolResult",
	timestamp,
	toolName: NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME,
	details: { openQuestions, assumptions, risks },
});

interface MockModel {
	provider: string;
	id: string;
}

function roleModel(role: string): MockModel {
	return {
		provider: "mock",
		id: role === "plan" ? "strong" : role,
	};
}

function phaseEntryHost(
	events: string[],
	advisorReviews: unknown[],
	setState: (state: NikoflowState) => void,
): NikoflowPhaseEntryHost<MockModel> {
	return {
		resolveRoleModelWithThinking: role => ({
			model: roleModel(role),
			explicitThinkingLevel: false,
		}),
		applyRoleModel: entry => {
			events.push(`role:${entry.role}`);
		},
		setState: state => {
			setState(state);
			events.push(`state:${currentPhase(state) ?? "complete"}:${state.gateRequestId ?? "none"}`);
		},
		sendNikoflowContext: state => {
			events.push(`context:${currentPhase(state) ?? "complete"}:${state.gateRequestId ?? "none"}`);
		},
		requestAdvisorReview: state => {
			events.push(`advisor:${state.gateRequestId ?? "none"}`);
			return advisorReviews.shift();
		},
	};
}

function advisorReview(
	gateId: string,
	severity: "nit" | "concern" | "blocker" = "nit",
	note = "ok",
): NikoflowAdvisorReview {
	const verdict = severity === "blocker" ? "blocker" : "approve";
	return { gateId, reviewed: true, verdict, notes: [{ severity, note, gateId, verdict }] };
}

const ticket = (id: string, blocked_by: string[] = [], status: NikoflowTicket["status"] = "todo"): NikoflowTicket => ({
	id,
	acceptance: [`${id} acceptance`],
	blocked_by,
	implementation_notes: `${id} notes`,
	status,
});

function withCompleteTddEvidence(state: NikoflowState): NikoflowState {
	const ticketId = state.activeTicketId;
	const gateId = state.gateRequestId;
	if (!ticketId || !gateId) throw new Error("Expected active ticket and execute gate");
	return {
		...state,
		tddEvidence: {
			ticketId,
			gateId,
			red: { command: "bun test focused", exitCode: 1, expectedFailure: "expected", recordedAt: 1 },
			green: { command: "bun test focused", exitCode: 0, recordedAt: 2 },
		},
	};
}

function stateAtPhase(
	depth: NikoflowDepth,
	phase: NikoflowPhase,
	options: Parameters<typeof createState>[1] = {},
): NikoflowState {
	let state = createState(depth, options);
	while (currentPhase(state) !== phase) {
		if (isComplete(state)) throw new Error(`Nikoflow ${depth} has no ${phase} phase`);
		state = advancePhase(state);
	}
	return state;
}

function completedExecuteState(): NikoflowState {
	return setTicketDag(stateAtPhase("light", "execute"), [ticket("TSK-001", [], "done")]);
}

describe("nikoflow mode callback helpers", () => {
	test("chains onTurnEnd after the previous handler", async () => {
		const calls: string[] = [];
		const chained = createNikoflowOnTurnEnd(
			async () => {
				calls.push("previous");
			},
			async () => {
				calls.push("nikoflow");
			},
		);

		await chained([]);
		expect(calls).toEqual(["previous", "nikoflow"]);
	});

	test("allows only explicit read-only planning tools before execute", () => {
		for (const name of ["read", "glob", "grep", "nikoflow_define_tickets", "nikoflow_grilling_converged"]) {
			expect(isNikoflowReadOnlyPhaseToolAllowed(tool(name))).toBe(true);
		}
		for (const name of ["bash", "node_repl", "python_repl", "edit", "write", "unknown_tool"]) {
			expect(isNikoflowReadOnlyPhaseToolAllowed(tool(name))).toBe(false);
		}
	});

	test("blocks custom tools that reuse read-only allowlist names before execute", () => {
		const state = createState("max");

		expect(isNikoflowReadOnlyPhaseToolAllowed(tool("read"))).toBe(true);
		expect(isNikoflowReadOnlyPhaseToolAllowed(customTool("read"))).toBe(false);
		expect(isNikoflowReadOnlyPhaseToolAllowed(customTool("search"))).toBe(false);
		expect(nikoflowToolViolation(state, customTool("search"))).toBe(readOnlyReason("grilling"));
	});
	test("permits read-only virtual Nikoflow tools routed through Write", () => {
		const grilling = createState("research", { autonomous: true });
		const research = advancePhase(grilling);

		expect(
			nikoflowToolViolation(grilling, tool("write", { path: `xd://${NIKOFLOW_GRILLING_CONVERGED_TOOL_NAME}` })),
		).toBeNull();
		expect(
			nikoflowToolViolation(research, tool("write", { path: `xd://${NIKOFLOW_RECORD_RESEARCH_TOOL_NAME}` })),
		).toBeNull();
		expect(nikoflowToolViolation(research, tool("write", { path: "xd://write" }))).toBe(
			readOnlyReason("research", "the Verify gate advances"),
		);
	});

	test("blocks writes, code execution, and unknown tools before execute", async () => {
		const state = createState("max");
		const before = createNikoflowBeforeToolCall(() => state);
		const blockedTools = ["bash", "node_repl", "python_repl", "edit", "write", "apply_patch", "unknown_tool"];
		const allowedTools = ["read", "glob", "grep", "nikoflow_define_tickets", "nikoflow_grilling_converged"];

		let preExecute = state;
		for (const phase of ["grilling", "adr", "prd", "tickets"] as const) {
			expect(currentPhase(preExecute)).toBe(phase);
			for (const name of allowedTools) {
				expect(nikoflowToolViolation(preExecute, tool(name))).toBeNull();
			}
			for (const name of blockedTools) {
				expect(nikoflowToolViolation(preExecute, tool(name))).toBe(readOnlyReason(phase));
			}
			preExecute = advancePhase(preExecute);
		}
		expect(await before(tool("write"))).toEqual({ block: true, reason: readOnlyReason("grilling") });
	});

	test("preserves a previous beforeToolCall block", async () => {
		const before = createNikoflowBeforeToolCall(
			() => createState("max"),
			() => ({ block: true, reason: "previous" }),
		);
		expect(await before(tool("write"))).toEqual({ block: true, reason: "previous" });
	});

	test("allows execute writes after ticketization", () => {
		const executeState = stateAtPhase("light", "execute");
		for (const name of ["write", "edit", "apply_patch", "bash", "eval", "node_repl", "python_repl"]) {
			expect(nikoflowToolViolation(executeState, tool(name))).toBeNull();
		}
	});

	test("names the ticketization gate in light read-only blocks", () => {
		const grilling = createState("light");
		expect(nikoflowToolViolation(grilling, tool("bash"))).toBe(readOnlyReason("grilling"));
	});

	test("keeps Research read-only without requiring a ticket DAG", () => {
		const research = stateAtPhase("research", "research");

		expect(requiresTicketDag(research)).toBe(false);
		expect(nikoflowToolViolation(research, tool("read"))).toBeNull();
		expect(nikoflowToolViolation(research, tool("write"))).toBe(
			readOnlyReason("research", "the Verify gate advances"),
		);
	});

	test("holds Research until durable evidence exists, then sends it to advisor review", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("research", "research"), "research-gate", 10));
		let hasArtifact = false;
		const holds: string[] = [];
		const reviews: string[] = [];
		const bundle = createNikoflowCallbackBundle({
			getState: () => state,
			isGateSatisfied: () => false,
			enqueueFollowUp: message => {
				holds.push(message);
			},
			requestAdvisorReview: current => {
				reviews.push(current.gateRequestId ?? "missing");
				return advisorReview(current.gateRequestId ?? "missing");
			},
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			hasResearchArtifact: () => hasArtifact,
		});

		await bundle.onBeforeYield();

		expect(currentPhase(state)).toBe("research");
		expect(reviews).toEqual([]);
		expect(holds).toHaveLength(1);
		expect(holds[0]).toContain(NIKOFLOW_RECORD_RESEARCH_TOOL_NAME);

		hasArtifact = true;
		await bundle.onBeforeYield();

		expect(reviews).toEqual(["research-gate"]);
		expect(currentPhase(state)).toBe("verify");
	});

	test("advances non-grilling human gates only from later genuine user turns", async () => {
		type Message = { role: "user" | "assistant" | "toolResult"; timestamp: number };
		const options = {
			isGenuineUserTurn: (message: Message) => message.role === "user",
			messageTimestamp: (message: Message) => message.timestamp,
			nextGateRequestId: () => "next-gate",
			now: () => 20,
		};

		const preArtifact = mintGateRequest(advancePhase(createState("max")), "gate-1", 10);
		const rejected = advanceNikoflowHumanGate(preArtifact, [{ role: "user", timestamp: 11 }], options);
		expect(currentPhase(rejected)).toBe("adr");
		expect(rejected.gateRequestId).toBe("gate-1");

		const adr = markPhaseTurnStarted(preArtifact);
		const prd = advanceNikoflowHumanGate(adr, [{ role: "user", timestamp: 11 }], options);
		expect(currentPhase(prd)).toBe("prd");
		expect(prd.gateRequestId).toBeNull();

		const assistantOnly = advanceNikoflowHumanGate(adr, [{ role: "assistant", timestamp: 11 }], options);
		expect(currentPhase(assistantOnly)).toBe("adr");
		expect(assistantOnly.gateRequestId).toBe("gate-1");

		const toolOnly = advanceNikoflowHumanGate(adr, [{ role: "toolResult", timestamp: 11 }], options);
		expect(currentPhase(toolOnly)).toBe("adr");
		expect(toolOnly.gateRequestId).toBe("gate-1");

		const staleUser = advanceNikoflowHumanGate(adr, [{ role: "user", timestamp: 9 }], options);
		expect(currentPhase(staleUser)).toBe("adr");
		expect(staleUser.gateRequestId).toBe("gate-1");
	});

	test("grilling gate does not advance without a convergence marker", () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);
		const next = advanceNikoflowHumanGate<GateMessage>(grilling, [{ role: "user", timestamp: 12 }], gateOptions);

		expect(currentPhase(next)).toBe("grilling");
		expect(next.gateRequestId).toBe("gate-1");
	});

	test("grilling gate does not advance while open questions remain", () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);
		const next = advanceNikoflowHumanGate<GateMessage>(
			grilling,
			[grillingConvergedMessage(12, ["Which command proves this?"]), { role: "user", timestamp: 13 }],
			gateOptions,
		);

		expect(currentPhase(next)).toBe("grilling");
		expect(next.gateRequestId).toBe("gate-1");
	});

	test("quoted convergence marker string in prose does not advance grilling", () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);
		const quotedMarker = [
			'When done I will emit {"nikoflow_grilling":{"open_questions":[],"assumptions":[],"risks":[]}}.',
			"Do not treat this sentence as convergence.",
		].join("\n");
		const next = advanceNikoflowHumanGate<GateMessage>(
			grilling,
			[
				{ role: "assistant", timestamp: 12, content: quotedMarker },
				{ role: "user", timestamp: 13 },
			],
			gateOptions,
		);

		expect(currentPhase(next)).toBe("grilling");
		expect(next.gateRequestId).toBe("gate-1");
	});

	test("grilling gate advances only after structured convergence tool call and later user turn", async () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);

		const toolOnly = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12, [], ["scope is limited"], ["tests may fail"])],
			gateOptions,
		);
		expect(currentPhase(toolOnly)).toBe("grilling");

		const userBeforeTool = advanceNikoflowHumanGate(
			grilling,
			[{ role: "user", timestamp: 11 }, grillingConvergedMessage(12)],
			gateOptions,
		);
		expect(currentPhase(userBeforeTool)).toBe("grilling");

		const prd = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12, [], ["scope is limited"], ["tests may fail"]), { role: "user", timestamp: 13 }],
			gateOptions,
		);
		expect(currentPhase(prd)).toBe("prd");
		expect(prd.gateRequestId).toBeNull();
		expect(await createNikoflowBeforeToolCall(() => prd)(tool("write"))).toEqual({
			block: true,
			reason: readOnlyReason("prd"),
		});
	});

	test("interview grilling requires a named assumption or risk in the convergence marker", () => {
		const grilling = mintGateRequest(createState("light", { grillingMode: "interview" }), "gate-1", 10);
		const emptyMarker = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12), { role: "user", timestamp: 13 }],
			gateOptions,
		);

		expect(currentPhase(emptyMarker)).toBe("grilling");
		expect(emptyMarker.gateRequestId).toBe("gate-1");
		expect(formatGateHoldMessage(emptyMarker)).toContain(
			"Deep interview requires at least one named assumption or risk",
		);

		const withAssumption = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12, [], ["scope is bounded"]), { role: "user", timestamp: 13 }],
			gateOptions,
		);
		expect(currentPhase(withAssumption)).toBe("prd");
	});

	test("brief and default grilling keep the current empty-assumptions convergence bar", () => {
		const brief = mintGateRequest(createState("light", { grillingMode: "brief" }), "gate-1", 10);
		const defaultMode = mintGateRequest(createState("light"), "gate-1", 10);

		expect(
			currentPhase(
				advanceNikoflowHumanGate(
					brief,
					[grillingConvergedMessage(12), { role: "user", timestamp: 13 }],
					gateOptions,
				),
			),
		).toBe("prd");
		expect(
			currentPhase(
				advanceNikoflowHumanGate(
					defaultMode,
					[grillingConvergedMessage(12), { role: "user", timestamp: 13 }],
					gateOptions,
				),
			),
		).toBe("prd");
	});

	test("batch grilling advances on clean advisor review, not primary text alone", () => {
		const grilling = mintGateRequest(createState("light", { autonomous: true }), "gate-1", 10);
		const primaryTextOnly = advanceNikoflowHumanGate(
			grilling,
			[
				{
					role: "assistant",
					timestamp: 12,
					content: 'Converged text only: {"nikoflow_grilling":{"open_questions":[],"assumptions":[],"risks":[]}}',
				},
			],
			gateOptions,
		);
		expect(primaryTextOnly.batchGateAcceptedAt).toBeNull();

		const ready = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12, [], ["human-unverified: default to existing behavior"], ["needs tests"])],
			gateOptions,
		);

		expect(currentPhase(ready)).toBe("grilling");
		expect(ready.batchGateAcceptedAt).toBe(12);

		const next = advanceNikoflowAdvisorGate(ready, advisorReview("gate-1"));
		expect(currentPhase(next)).toBe("prd");
		expect(next.gateRequestId).toBeNull();
	});

	test("batch grilling ignores a stale interview grilling mode", () => {
		const grilling = mintGateRequest(
			createState("light", { autonomous: true, grillingMode: "interview" }),
			"gate-1",
			10,
		);
		const ready = advanceNikoflowHumanGate(grilling, [grillingConvergedMessage(12)], gateOptions);

		expect(currentPhase(ready)).toBe("grilling");
		expect(ready.batchGateAcceptedAt).toBe(12);
	});

	test("batch grilling blocks non-empty open questions even with a clean advisor review", () => {
		const grilling = mintGateRequest(createState("light", { autonomous: true }), "gate-1", 10);
		const blocked = advanceNikoflowHumanGate(
			grilling,
			[grillingConvergedMessage(12, ["Which tests prove this?"], ["human-unverified: use the smallest test"])],
			gateOptions,
		);

		expect(blocked.batchGateAcceptedAt).toBeNull();
		expect(currentPhase(advanceNikoflowAdvisorGate(blocked, advisorReview("gate-1")))).toBe("grilling");
	});

	test("interactive human gates ignore advisor reviews", () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);
		expect(advanceNikoflowAdvisorGate(grilling, advisorReview("gate-1"))).toBe(grilling);
	});

	test("grilling gate rejects a fabricated convergence marker after questions remain", () => {
		const grilling = mintGateRequest(createState("light"), "gate-1", 10);
		const next = advanceNikoflowHumanGate(
			grilling,
			[
				grillingConvergedMessage(12, [], ["looks done"], []),
				grillingConvergedMessage(13, ["Still unresolved"]),
				{ role: "user", timestamp: 14 },
			],
			gateOptions,
		);

		expect(currentPhase(next)).toBe("grilling");
		expect(next.gateRequestId).toBe("gate-1");
	});

	test("blocks ticketization approval until the ticket DAG is captured", () => {
		const ticketsPhase = mintGateRequest(advancePhase(advancePhase(advancePhase(createState("max")))), "g1", 10);
		const next = advanceNikoflowHumanGate(ticketsPhase, [{ role: "user", timestamp: 11 }], {
			isGenuineUserTurn: message => message.role === "user",
			messageTimestamp: message => message.timestamp,
			nextGateRequestId: () => "next-gate",
			now: () => 20,
		});

		expect(currentPhase(next)).toBe("tickets");
		expect(next.gateRequestId).toBe("g1");
		expect(formatGateHoldMessage(next)).toContain("nikoflow_define_tickets");
	});

	test("batch ADR gate advances through advisor review instead of a human turn", () => {
		const adr = markPhaseTurnStarted(
			mintGateRequest(advancePhase(createState("max", { autonomous: true })), "adr-gate", 10),
		);
		const ready = advanceNikoflowHumanGate(adr, [], {
			isGenuineUserTurn: () => false,
			messageTimestamp: () => undefined,
			nextGateRequestId: () => "next-gate",
			now: () => 20,
		});

		expect(currentPhase(ready)).toBe("adr");
		expect(ready.batchGateAcceptedAt).toBe(10);
		expect(currentPhase(advanceNikoflowAdvisorGate(ready, advisorReview("adr-gate")))).toBe("prd");
	});

	test("chains tool choice without swallowing the previous directive", () => {
		expect(
			createNikoflowGetToolChoice(
				() => "previous",
				() => "nikoflow",
			)(),
		).toBe("previous");
		expect(
			createNikoflowGetToolChoice(
				() => undefined,
				() => "nikoflow",
			)(),
		).toBe("nikoflow");
	});

	test("yields human gates instead of queuing a follow-up", async () => {
		const calls: string[] = [];
		const externalActions: string[] = [];
		const state = mintGateRequest(createState("max"), "g1");
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				calls.push(message);
			},
			() => {
				calls.push("previous");
			},
			undefined,
			undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		expect(calls).toEqual(["previous"]);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("human approval");
	});

	test("queues one hold before completed execute advances to verify", async () => {
		let state = completedExecuteState();
		const events: string[] = [];
		const followUps: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "verify-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			state => host.requestAdvisorReview?.(state),
		);

		await onBeforeYield();
		expect(currentPhase(state)).toBe("execute");
		expect(followUps).toEqual([
			"Nikoflow execute phase has no valid unblocked ticket. Yield now; ticket DAG needs plan/human repair.",
		]);

		state = markPhaseTurnStarted(state);
		await onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("verify-gate");
		expect(events).toEqual([
			"role:advisor",
			"state:verify:verify-gate",
			"context:verify:verify-gate",
			"advisor:verify-gate",
		]);
	});

	test("runs a max-depth ticket through execute, advisor review, and done", async () => {
		let state = createState("max");
		state = advancePhase(advancePhase(advancePhase(advancePhase(state))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const events: string[] = [];
		const followUps: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const entered = await enterNikoflowPhase(host, "tickets", "execute", state, {
			nextGateRequestId: () => "unused",
			now: () => 100,
			requestAdvisorReview: false,
		});
		state = entered.state;

		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets[0].status).toBe("red");

		state = markPhaseTurnStarted(withCompleteTddEvidence(state));
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			current => current.gateRequestId === null,
			message => {
				followUps.push(message);
			},
			undefined,
			current => {
				state = advanceNikoflowExecuteGate(current, {
					nextGateRequestId: () => "ticket-gate",
					now: () => 200,
				});
			},
			current => advisorReview(current.gateRequestId ?? "missing"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
		);

		await onBeforeYield();

		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "red"],
		]);
		expect(state.activeTicketId).toBe("TSK-002");
		expect(currentPhase(state)).toBe("execute");
		expect(followUps.at(-1)).toContain("Nikoflow execute ticket TSK-002 is blocked on TDD evidence.");
	});

	test("execute exposes only the active ticket until advisor review marks it done", async () => {
		let state = advancePhase(advancePhase(advancePhase(advancePhase(createState("max")))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		state = (
			await enterNikoflowPhase(host, "tickets", "execute", state, {
				nextGateRequestId: () => "unused",
				now: () => 100,
				requestAdvisorReview: false,
			})
		).state;

		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-001");
		expect(getPhasePrompt(state)).not.toContain("TSK-002");

		state = advanceNikoflowExecuteGate(markPhaseTurnStarted(withCompleteTddEvidence(state)), {
			nextGateRequestId: () => "ticket-gate",
			now: () => 200,
		});
		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "review"],
			["TSK-002", "todo"],
		]);
		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-001");
		expect(getPhasePrompt(state)).not.toContain("Active ticket: TSK-002");

		const gateId = state.gateRequestId ?? "missing";
		const blocked = advanceNikoflowAdvisorGate(state, advisorReview(gateId, "blocker", "missing test"));
		expect(blocked).toBe(state);
		expect(blocked.activeTicketId).toBe("TSK-001");

		state = advanceNikoflowAdvisorGate(state, advisorReview(gateId));
		expect(state.tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "red"],
		]);
		expect(getPhasePrompt(state)).toContain("Active ticket: TSK-002");
	});

	test("a stuck active ticket escalates boundedly without aborting execute", async () => {
		let state = advancePhase(advancePhase(advancePhase(advancePhase(createState("max")))));
		state = setTicketDag(state, [ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]);
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		state = (
			await enterNikoflowPhase(host, "tickets", "execute", state, {
				nextGateRequestId: () => "unused",
				now: () => 100,
				requestAdvisorReview: false,
			})
		).state;
		const followUps: string[] = [];
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();

		expect(followUps).toHaveLength(3);
		expect(
			followUps.every(message => message.includes("Nikoflow execute ticket TSK-001 is blocked on TDD evidence.")),
		).toBe(true);
		expect(followUps.some(message => message.includes("TSK-002"))).toBe(false);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
		expect(currentPhase(state)).toBe("execute");
		expect(state.activeTicketId).toBe("TSK-001");
	});

	test("execute does not skip to verify when the captured DAG is missing", () => {
		const execute = markPhaseTurnStarted(advancePhase(advancePhase(advancePhase(advancePhase(createState("max"))))));
		const next = advanceNikoflowExecuteGate(execute);

		expect(currentPhase(next)).toBe("execute");
		expect(next.gateRequestId).toBeNull();
		expect(formatGateHoldMessage(next)).toContain("return to Ticketization");
	});

	test("missing post-ticketization DAG yields externally without follow-up loop", async () => {
		const state = advancePhase(advancePhase(advancePhase(advancePhase(createState("max")))));
		const followUps: string[] = [];
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(followUps).toEqual([]);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("nikoflow_define_tickets");
	});

	test("sends a blocked ticket to the block handler without aborting the run", async () => {
		let state = createState("max");
		state = advancePhase(advancePhase(advancePhase(advancePhase(state))));
		state = setTicketDag(state, [ticket("TSK-001")]);
		state = withCompleteTddEvidence(
			mintGateRequest({ ...state, activeTicketId: "TSK-001", phaseTurnStarted: true }, "ticket-gate", 100),
		);
		const blocks: string[] = [];
		const externalActions: string[] = [];

		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			current => current.gateRequestId === null,
			() => {},
			undefined,
			current => {
				state = advanceNikoflowExecuteGate(current, {
					nextGateRequestId: () => "ticket-gate",
					now: () => 200,
				});
			},
			current => advisorReview(current.gateRequestId ?? "missing", "blocker", "acceptance missing"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			(_current, review) => {
				blocks.push(review.notes[0]?.note ?? "");
			},
			(_current, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(blocks).toEqual(["acceptance missing"]);
		expect(externalActions).toEqual([]);
		expect(currentPhase(state)).toBe("execute");
		expect(state.activeTicketId).toBe("TSK-001");
		expect(state.tickets[0].status).toBe("review");
	});

	test("does not enqueue when there is no pending gate or the gate is satisfied", async () => {
		const calls: string[] = [];
		await createNikoflowOnBeforeYield(
			() => createState("max"),
			() => false,
			message => {
				calls.push(message);
			},
		)();
		await createNikoflowOnBeforeYield(
			() => mintGateRequest(createState("max"), "g1"),
			() => true,
			message => {
				calls.push(message);
			},
		)();
		expect(calls).toEqual([]);
	});

	test("creates a callback bundle without clobbering previous hooks", async () => {
		const calls: string[] = [];
		const state = mintGateRequest(createState("max"), "g1");
		const bundle = createNikoflowCallbackBundle<string[], undefined, string>({
			getState: () => state,
			isGateSatisfied: () => false,
			enqueueFollowUp: message => {
				calls.push(message);
			},
			beforeToolCall: () => undefined,
			onTurnEnd: () => {
				calls.push("previous-turn");
			},
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			onBeforeYield: () => {
				calls.push("previous-yield");
			},
			getToolChoice: () => "previous-choice",
			nikoflowToolChoice: () => "nikoflow-choice",
		});

		await bundle.onTurnEnd?.([]);
		await bundle.onBeforeYield();

		expect(await bundle.beforeToolCall(tool("write"))).toEqual({
			block: true,
			reason: readOnlyReason("grilling"),
		});
		expect(bundle.getToolChoice?.()).toBe("previous-choice");
		expect(calls[0]).toBe("previous-turn");
		expect(calls[1]).toBe("nikoflow-turn");
		expect(calls[2]).toBe("previous-yield");
	});

	test("installs callbacks on a host and restores the previous hooks", async () => {
		const calls: string[] = [];
		const state = mintGateRequest(createState("max"), "g1");
		const previousBefore = () => {
			calls.push("previous-before");
			return undefined;
		};
		const previousTurn = () => {
			calls.push("previous-turn");
		};
		const previousYield = () => {
			calls.push("previous-yield");
		};
		const previousChoice = () => "previous-choice";
		let installedTurn: ((messages: string[]) => Promise<void> | void) | undefined;
		let installedYield: (() => Promise<void> | void) | undefined;
		let installedChoice: (() => string | undefined) | undefined;
		const host: NikoflowCallbackHost<string[], undefined, string> = {
			beforeToolCall: previousBefore,
			setOnTurnEnd: (fn: typeof installedTurn) => {
				installedTurn = fn;
			},
			setOnBeforeYield: (fn: typeof installedYield) => {
				installedYield = fn;
			},
			setGetToolChoice: (fn: typeof installedChoice) => {
				installedChoice = fn;
			},
		};

		const installed = installNikoflowCallbacks<string[], undefined, string>(host, {
			getState: () => state,
			isGateSatisfied: () => false,
			enqueueFollowUp: message => {
				calls.push(message);
			},
			onTurnEnd: previousTurn,
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			onBeforeYield: previousYield,
			getToolChoice: previousChoice,
			nikoflowToolChoice: () => "nikoflow-choice",
		});

		await installedTurn?.([]);
		await installedYield?.();

		expect(await host.beforeToolCall?.(tool("write"))).toEqual({
			block: true,
			reason: readOnlyReason("grilling"),
		});
		expect(installed.bundle.getToolChoice?.()).toBe("previous-choice");
		expect(installedChoice?.()).toBe("previous-choice");
		expect(calls).toEqual(["previous-turn", "nikoflow-turn", "previous-yield", "previous-before"]);

		installed.uninstall();
		expect(host.beforeToolCall).toBe(previousBefore);
		expect(installedTurn).toBe(previousTurn);
		expect(installedYield).toBe(previousYield);
		expect(installedChoice).toBe(previousChoice);
	});

	test("attaches to an AgentSession-like host without clobbering existing handlers", async () => {
		const calls: string[] = [];
		const followUps: string[] = [];
		const appliedRoles: string[] = [];
		let state = mintGateRequest(createState("max"), "g1");
		let gateSatisfied = false;
		let installedTurn: ((messages: string[]) => Promise<void> | void) | undefined = () => {
			calls.push("advisor-turn");
		};
		let installedYield: (() => Promise<void> | void) | undefined = () => {
			calls.push("previous-yield");
		};
		let installedChoice: (() => string | undefined) | undefined = () => "previous-choice";

		const host: NikoflowAgentSessionHost<string[], undefined, string, MockModel> = {
			beforeToolCall: () => {
				calls.push("previous-before");
				return undefined;
			},
			getOnTurnEnd: () => installedTurn,
			setOnTurnEnd: fn => {
				installedTurn = fn;
			},
			getOnBeforeYield: () => installedYield,
			setOnBeforeYield: fn => {
				installedYield = fn;
			},
			getGetToolChoice: () => installedChoice,
			setGetToolChoice: fn => {
				installedChoice = fn;
			},
			resolveRoleModelWithThinking: role => ({
				model: roleModel(role),
				explicitThinkingLevel: false,
			}),
			applyRoleModel: entry => {
				appliedRoles.push(entry.role);
			},
		};

		await installNikoflowAgentSessionMode(host, {
			getState: () => state,
			isGateSatisfied: () => gateSatisfied,
			enqueueFollowUp: message => {
				followUps.push(message);
			},
			afterTurnEnd: () => {
				calls.push("nikoflow-turn");
			},
			nikoflowToolChoice: () => undefined,
		});

		await installedTurn?.([]);
		expect(calls.slice(0, 2)).toEqual(["advisor-turn", "nikoflow-turn"]);
		expect(appliedRoles).toEqual([]);

		expect(await installedYield?.()).toBeUndefined();
		expect(followUps).toEqual([]);

		gateSatisfied = true;
		expect(await installedYield?.()).toBeUndefined();
		expect(followUps).toEqual([]);

		expect(await host.beforeToolCall?.(tool("write"))).toEqual({
			block: true,
			reason: readOnlyReason("grilling"),
		});
		expect(calls).toContain("previous-before");
		expect(installedChoice?.()).toBe("previous-choice");

		state = stateAtPhase("light", "execute");
		await installedTurn?.([]);
		expect(appliedRoles).toEqual([]);
	});

	test("enters a phase with role, fresh context, gate mint, and advisor review in one driver", async () => {
		let state = createState("max");
		const events: string[] = [];
		const advisorReviews: unknown[] = [advisorReview("verify-gate")];
		const host = phaseEntryHost(events, advisorReviews, next => {
			state = next;
		});

		await enterNikoflowPhase(host, null, "grilling", state, {
			nextGateRequestId: () => "human-gate",
			now: () => 10,
		});
		expect(events).toEqual(["role:plan", "state:grilling:human-gate", "context:grilling:human-gate"]);
		expect(state.gateRequestId).toBe("human-gate");

		events.length = 0;
		const execute = markPhaseTurnStarted(completedExecuteState());
		const verify = advanceNikoflowExecuteGate(execute);
		const result = await enterNikoflowPhase(host, "execute", "verify", verify, {
			nextGateRequestId: () => "verify-gate",
			now: () => 20,
		});

		expect(result.advisorReview).toEqual(advisorReview("verify-gate"));
		expect(currentRole(state)).toBe("advisor");
		expect(events).toEqual([
			"role:advisor",
			"state:verify:verify-gate",
			"context:verify:verify-gate",
			"advisor:verify-gate",
		]);
	});

	test("execute completion enters verify through the driver and requests advisor review", async () => {
		let gateCounter = 0;
		let state = completedExecuteState();
		const events: string[] = [];
		const followUps: string[] = [];
		const blocked: string[] = [];
		const advisorReviews: unknown[] = [advisorReview("gate-1", "blocker", "needs fixes")];
		const host = phaseEntryHost(events, advisorReviews, next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], { toolResults?: unknown[] }, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: message => {
				followUps.push(message);
			},
			afterTurnEnd: () => undefined,
			advanceHumanGate: () => {
				if (currentPhase(state) === "execute") state = markPhaseTurnStarted(state);
			},
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100,
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			requestAdvisorReview: state => host.requestAdvisorReview?.(state),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
			},
		});

		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("execute");
		expect(currentRole(state)).toBe("default");
		expect(isComplete(state)).toBe(false);
		expect(followUps).toHaveLength(1);
		expect(events).toEqual([]);

		await bundle.onTurnEnd?.([], undefined, { toolResults: [] });
		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(currentRole(state)).toBe("advisor");
		expect(isComplete(state)).toBe(false);
		const gateId = state.gateRequestId;
		expect(gateId).toBe("gate-1");
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "advisor:gate-1"]);
		expect(followUps).toHaveLength(1);
		expect(blocked).toEqual(["needs fixes"]);

		await bundle.onTurnEnd?.(
			[{ role: "assistant", content: [{ type: "text", text: `{"gateId":"${gateId}","verdict":"pass"}` }] }],
			undefined,
			{ toolResults: [{ type: "tool_result", content: { gateId, verdict: "pass", score: 10 } }] },
		);
		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
	});

	test("stale empty-diff blocker from execute handoff does not block a fresh clean verify review", async () => {
		let state = markPhaseTurnStarted(completedExecuteState());
		const events: string[] = [];
		const blocked: string[] = [];
		const externalActions: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
				return advisorReview("grilling-gate", "blocker", "Empty diff, acceptance not met, no code written");
			},
			requestAdvisorReview: current => advisorReview(current.gateRequestId ?? "none", "nit", "final diff clean"),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
			},
			onGateNeedsExternalAction: (_state, message) => {
				externalActions.push(message);
			},
		});

		await bundle.onBeforeYield();

		expect(isComplete(state)).toBe(true);
		expect(blocked).toEqual([]);
		expect(externalActions).toEqual([]);
		expect(events).toEqual(["role:advisor", "state:verify:final-gate", "context:verify:final-gate"]);
	});

	test("fresh final-diff blocker holds the verify gate", async () => {
		let state = markPhaseTurnStarted(completedExecuteState());
		const blocked: string[] = [];
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
			},
			requestAdvisorReview: current => advisorReview(current.gateRequestId ?? "none", "blocker", "real diff fails"),
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: (_current, review) => {
				blocked.push(review.notes[0]?.note ?? "");
			},
		});

		await bundle.onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("final-gate");
		expect(isComplete(state)).toBe(false);
		expect(blocked).toEqual(["real diff fails"]);
	});

	test("missing fresh verify review escalates instead of accepting stale handoff success", async () => {
		let state = markPhaseTurnStarted(completedExecuteState());
		const externalActions: string[] = [];
		const host = phaseEntryHost([], [], next => {
			state = next;
		});
		const bundle = createNikoflowCallbackBundle<unknown[], undefined, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => "final-gate",
					now: () => 100,
					requestAdvisorReview: false,
				});
				return advisorReview("final-gate", "nit", "stale handoff clean");
			},
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onGateNeedsExternalAction: (_state, message) => {
				externalActions.push(message);
			},
		});

		await bundle.onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});

	test("advisor blocker retry uses the rotated production gate for the next fix review", async () => {
		let gateCounter = 0;
		let reviewerAttempt = 0;
		let state = markPhaseTurnStarted(completedExecuteState());
		const events: string[] = [];
		const blocked: string[] = [];
		const host = phaseEntryHost(events, [], next => {
			state = next;
		});
		host.requestAdvisorReview = current => {
			events.push(`advisor:${current.gateRequestId ?? "none"}`);
			reviewerAttempt++;
			return advisorReview(
				current.gateRequestId ?? "none",
				reviewerAttempt === 1 ? "blocker" : "nit",
				reviewerAttempt === 1 ? "needs fixes" : "clean",
			);
		};
		const bundle = createNikoflowCallbackBundle<unknown[], { toolResults?: unknown[] }, string>({
			getState: () => state,
			isGateSatisfied: current => current.gateRequestId === null,
			enqueueFollowUp: () => undefined,
			advanceExecuteGate: async current => {
				const next = advanceNikoflowExecuteGate(current);
				const result = await enterNikoflowPhase(host, currentPhase(current), currentPhase(next), next, {
					nextGateRequestId: () => `gate-${++gateCounter}`,
					now: () => 100 + gateCounter,
					requestAdvisorReview: false,
				});
				return result.advisorReview;
			},
			requestAdvisorReview: async current => {
				return host.requestAdvisorReview?.(current);
			},
			advanceAdvisorGate: (current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			onAdvisorBlock: current => {
				blocked.push(current.gateRequestId ?? "none");
				state = rotateGateRequest(
					{ ...current, phaseTurnStarted: false },
					`gate-${++gateCounter}`,
					100 + gateCounter,
				);
			},
		});

		await bundle.onBeforeYield();
		expect(currentPhase(state)).toBe("verify");
		expect(state.gateRequestId).toBe("gate-2");
		expect(state.phaseTurnStarted).toBe(false);
		expect(blocked).toEqual(["gate-1"]);
		expect(events).toEqual(["role:advisor", "state:verify:gate-1", "context:verify:gate-1", "advisor:gate-1"]);

		state = markPhaseTurnStarted(state);
		await bundle.onBeforeYield();
		expect(isComplete(state)).toBe(true);
		expect(events.slice(4)).toEqual(["advisor:gate-2"]);
	});

	test("verify gate passes only after a clean native advisor review", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("light", "verify"), "gate-1"));
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => advisorReview("gate-1", "concern", "non-blocking caveat"),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(isComplete(state)).toBe(true);
		expect(externalActions).toEqual([]);
	});

	test("severity-less advisor note without an explicit verdict does not pass the verify gate", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("light", "verify"), "gate-1"));
		const externalActions: string[] = [];
		let reviewAttempts = 0;
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => {
				reviewAttempts++;
				return { gateId: "gate-1", reviewed: true, notes: [{ gateId: "gate-1", note: "could not fully review" }] };
			},
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(reviewAttempts).toBe(2);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});

	test("advisor note without the gate id does not satisfy the verify gate", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("light", "verify"), "gate-1"));
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => ({
				gateId: "gate-1",
				reviewed: true,
				verdict: "approve",
				notes: [{ severity: "nit", note: "clean but unrelated monitor aside", verdict: "approve" }],
			}),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});

	test("primary text never satisfies the verify gate", async () => {
		let state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("light", "verify"), "gate-1"));
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			() => undefined,
			undefined,
			undefined,
			() => ({ type: "tool_result", content: { gateId: "gate-1", verdict: "pass" } }),
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();

		expect(currentPhase(state)).toBe("verify");
		expect(isComplete(state)).toBe(false);
		expect(externalActions).toHaveLength(1);
	});

	test("holds externally when advisor review is absent or down", async () => {
		const state = markPhaseTurnStarted(mintGateRequest(stateAtPhase("light", "verify"), "gate-1"));
		const followUps: string[] = [];
		const externalActions: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => false,
			message => {
				followUps.push(message);
			},
			undefined,
			undefined,
			() => undefined,
			undefined,
			undefined,
			(_state, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();

		expect(followUps).toHaveLength(0);
		expect(externalActions).toHaveLength(4);
		expect(externalActions[0]).toContain("yielding instead of queuing another follow-up");
	});

	test("batch advisor blocker holds and stops boundedly when review cannot approve", async () => {
		let state = markPhaseTurnStarted(
			advanceNikoflowHumanGate(
				mintGateRequest(createState("light", { autonomous: true }), "gate-1", 10),
				[grillingConvergedMessage(12, [], ["human-unverified: minimal path"], ["review may block"])],
				gateOptions,
			),
		);
		let attempts = 0;
		const blocks: string[] = [];
		const externalActions: string[] = [];
		const followUps: string[] = [];
		const onBeforeYield = createNikoflowOnBeforeYield(
			() => state,
			() => state.gateRequestId === null,
			message => {
				followUps.push(message);
			},
			undefined,
			undefined,
			() => {
				attempts++;
				if (attempts > 3) return undefined;
				return advisorReview("gate-1", "blocker", `blocked ${attempts}`);
			},
			(current, review) => {
				state = advanceNikoflowAdvisorGate(current, review);
			},
			(_current, review) => {
				blocks.push(review.notes[0]?.note ?? "");
			},
			(_current, message) => {
				externalActions.push(message);
			},
		);

		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();
		await onBeforeYield();

		expect(blocks).toEqual(["blocked 1", "blocked 2", "blocked 3"]);
		expect(followUps).toEqual([]);
		expect(externalActions).toHaveLength(1);
		expect(externalActions[0]).toContain("Nikoflow batch gate stopped for human resume");
		expect(currentPhase(state)).toBe("grilling");
	});
});
