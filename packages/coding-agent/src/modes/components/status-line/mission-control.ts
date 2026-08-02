import { currentPhase, materializePhases, type NikoflowPhase, type NikoflowState } from "../../../nikoflow/state";

export type MissionControlSignal = "active" | "waiting" | "ready" | "red" | "green" | "waived" | "complete";

export interface MissionControlNikoflowState {
	phase: NikoflowPhase | null;
	phaseLabel: string;
	signal: MissionControlSignal;
	activeTicketId: string | null;
	completedTickets: number;
	totalTickets: number;
	phases: readonly NikoflowPhase[];
	completedPhaseCount: number;
}

const PHASE_LABELS: Record<NikoflowPhase, string> = {
	grilling: "GRILL",
	adr: "ADR",
	prd: "PRD",
	tickets: "TICKETS",
	execute: "EXEC",
	research: "RESEARCH",
	verify: "VERIFY",
};

/**
 * Projects durable Nikoflow state into the small, display-only vocabulary used
 * by the mission-control HUD. This module deliberately owns no rendering or
 * ANSI styling: the status line can map the same semantic signal through the
 * active OMP theme in dark, light, and ASCII-capable terminals.
 */
export function getMissionControlNikoflowState(state: NikoflowState): MissionControlNikoflowState {
	const phase = currentPhase(state);
	const phases = materializePhases(state.depth);
	const activeTicket = state.tickets.find(ticket => ticket.id === state.activeTicketId) ?? null;
	const completedTickets = state.tickets.filter(ticket => ticket.status === "done").length;

	let signal: MissionControlSignal;
	if (!phase) {
		signal = "complete";
	} else if (state.gateRequestId) {
		signal = "waiting";
	} else if (phase === "execute" && state.tddEvidence?.ticketId === state.activeTicketId) {
		signal = state.tddEvidence.waiver
			? "waived"
			: state.tddEvidence.green
				? "green"
				: state.tddEvidence.red
					? "red"
					: "active";
	} else if (phase === "execute" && activeTicket?.status === "green") {
		signal = "green";
	} else {
		signal = "active";
	}

	return {
		phase,
		phaseLabel: phase ? PHASE_LABELS[phase] : "COMPLETE",
		signal,
		activeTicketId: activeTicket?.id ?? state.activeTicketId,
		completedTickets,
		totalTickets: state.tickets.length,
		phases,
		completedPhaseCount: Math.min(state.phaseIndex, phases.length),
	};
}
