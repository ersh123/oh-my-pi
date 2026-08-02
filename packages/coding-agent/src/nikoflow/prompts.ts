import { currentPhase, currentRole, currentTicket, type NikoflowState } from "./state";
import { getNextTicket } from "./tickets";

const GRILLING_TAIL =
	"Each turn, maintain an explicit open_questions list; when it is genuinely empty, call nikoflow_grilling_converged with { open_questions: [], assumptions: [], risks: [] }. Do not fabricate convergence to end the phase. No implementation writes.";

const PHASE_PROMPTS: Record<string, string> = {
	grilling: `Grilling phase. Interrogate the user with specific, concrete questions about every material ambiguity, risk, and assumption before implementation. Do not exit grilling while any material question is unresolved. ${GRILLING_TAIL}`,
	adr: "ADR phase. Record only hard-to-reverse tradeoffs. Otherwise write a visible skip reason.",
	prd: "PRD phase. Write user stories with Given/When/Then acceptance criteria and test seams.",
	research:
		"Research phase. Investigate implementation, project, runtime, and web evidence only; no edits or implementation actions. Before yielding, call nikoflow_record_research with a scoped title, hypotheses, evidence locators, contradictions, open questions, and a decision. The durable artifact is required for independent advisor review.",
	tickets:
		"Ticketization phase. Split the PRD into dependency-ordered vertical tickets and call nikoflow_define_tickets with the full DAG. Do not write tickets as prose or todo text.",
	execute:
		"Execute phase. Work one unblocked ticket at a time. Use nikoflow_record_tdd to record a non-zero RED, implement the minimum code, then record a zero-exit GREEN with the exact same focused command. Use a reasoned waiver only for a ticket with no runtime surface. Independent review is blocked until this gate-bound evidence is complete.",
	verify:
		"Verify phase. Run local validation and require an independent structured reviewer verdict. No primary self-approval.",
};

function phasePrompt(state: NikoflowState, phase: string): string {
	if (phase === "grilling") {
		if (!state.autonomous && state.grillingMode === "interview") {
			return `Grilling phase — there is no existing project context; the spec must be built from your questions. Interrogate until scope, users, constraints, non-goals, and acceptance criteria are each pinned by an explicit answer; converge only with the resulting assumptions and risks named. ${GRILLING_TAIL}`;
		}
		if (!state.autonomous && state.grillingMode === "brief") {
			return `Grilling phase — fast scoping pass. Ask only the few questions whose answers would change the implementation; resolve everything else as explicit named assumptions and converge. ${GRILLING_TAIL}`;
		}
		if (!state.autonomous) return PHASE_PROMPTS[phase] ?? "";
		return [
			"Batch grilling phase. There is no human to interrogate.",
			"Write a spec-completeness artifact with assumptions, risks, and open questions.",
			"Resolve every open question as an explicit flagged assumption because batch assumptions are unverified by a human.",
			'When complete, call nikoflow_grilling_converged with { open_questions: [], assumptions: ["human-unverified: ..."], risks: [] }.',
			"Then yield for independent advisor review. The primary must not self-approve.",
		].join(" ");
	}
	if (!state.autonomous) return PHASE_PROMPTS[phase] ?? "";
	if (phase === "adr" || phase === "prd" || phase === "research" || phase === "tickets") {
		return `${PHASE_PROMPTS[phase]} Batch mode: yield for independent advisor review; the primary must not self-approve.`;
	}
	return PHASE_PROMPTS[phase] ?? "";
}

export function getPhasePrompt(state: NikoflowState): string {
	const phase = currentPhase(state);
	if (!phase) return "Nikoflow is complete.";
	const ticket = phase === "execute" ? (currentTicket(state) ?? getNextTicket(state.tickets)) : null;
	const ticketContext = ticket
		? [
				`Active ticket: ${ticket.id}`,
				"Acceptance:",
				...(ticket.acceptance.length > 0 ? ticket.acceptance.map(item => `- ${item}`) : ["- (not supplied)"]),
				`Implementation notes: ${ticket.implementation_notes || "(not supplied)"}`,
				`Execute gate: ${state.gateRequestId ?? "(not minted)"}`,
			]
		: [];
	return [
		`Nikoflow phase: ${phase}`,
		`Required role: ${currentRole(state)}`,
		`Mode: ${state.autonomous ? "batch" : "interactive"}`,
		phasePrompt(state, phase),
		...ticketContext,
		"Visible artifacts only. Do not rely on hidden reasoning across phase boundaries.",
	].join("\n");
}

export function getCurrentPhaseProtocol(state: NikoflowState): string {
	return `<nikoflow-context>\n${getPhasePrompt(state)}\n</nikoflow-context>`;
}
