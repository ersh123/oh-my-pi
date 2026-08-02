export type TicketStatus = "todo" | "red" | "green" | "review" | "done";

export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "red", "green", "review", "done"];

export interface NikoflowTicket {
	id: string;
	acceptance: string[];
	blocked_by: string[];
	implementation_notes: string;
	status: TicketStatus;
}

export const NIKOFLOW_DEFINE_TICKETS_TOOL_NAME = "nikoflow_define_tickets";
export const NIKOFLOW_RECORD_TDD_TOOL_NAME = "nikoflow_record_tdd";

export interface NikoflowTddCommandEvidence {
	command: string;
	exitCode: number;
	recordedAt: number;
}

export interface NikoflowTddRedEvidence extends NikoflowTddCommandEvidence {
	expectedFailure: string;
}

export interface NikoflowTddWaiverEvidence {
	reason: string;
	recordedAt: number;
}

export interface NikoflowTddEvidence {
	ticketId: string;
	gateId: string;
	red?: NikoflowTddRedEvidence;
	green?: NikoflowTddCommandEvidence;
	waiver?: NikoflowTddWaiverEvidence;
}

export type NikoflowTddEvidenceStage =
	| {
			stage: "red";
			ticketId: string;
			gateId: string;
			command: string;
			exitCode: number;
			expectedFailure: string;
	  }
	| {
			stage: "green";
			ticketId: string;
			gateId: string;
			command: string;
			exitCode: number;
	  }
	| {
			stage: "waiver";
			ticketId: string;
			gateId: string;
			reason: string;
	  };

export interface NikoflowTddEvidenceResult {
	evidence: NikoflowTddEvidence | null;
	errors: string[];
}

export function cloneNikoflowTddEvidence(evidence: NikoflowTddEvidence | null | undefined): NikoflowTddEvidence | null {
	if (!evidence) return null;
	return {
		ticketId: evidence.ticketId,
		gateId: evidence.gateId,
		...(evidence.red ? { red: { ...evidence.red } } : {}),
		...(evidence.green ? { green: { ...evidence.green } } : {}),
		...(evidence.waiver ? { waiver: { ...evidence.waiver } } : {}),
	};
}

export function recordNikoflowTddEvidence(
	current: NikoflowTddEvidence | null | undefined,
	stage: NikoflowTddEvidenceStage,
	recordedAt = Date.now(),
): NikoflowTddEvidenceResult {
	const ticketId = stage.ticketId.trim();
	const gateId = stage.gateId.trim();
	if (!ticketId || !gateId) return { evidence: null, errors: ["ticket_id and gate_id are required"] };

	if (stage.stage === "waiver") {
		const reason = stage.reason.trim();
		return reason
			? { evidence: { ticketId, gateId, waiver: { reason, recordedAt } }, errors: [] }
			: { evidence: null, errors: ["waiver reason must not be empty"] };
	}

	const command = stage.command.trim();
	if (!command) return { evidence: null, errors: [`${stage.stage} command must not be empty`] };
	if (stage.stage === "red") {
		const expectedFailure = stage.expectedFailure.trim();
		if (stage.exitCode === 0) return { evidence: null, errors: ["RED exit_code must be non-zero"] };
		if (!expectedFailure) return { evidence: null, errors: ["RED expected_failure must not be empty"] };
		return {
			evidence: {
				ticketId,
				gateId,
				red: { command, exitCode: stage.exitCode, expectedFailure, recordedAt },
			},
			errors: [],
		};
	}

	if (stage.exitCode !== 0) return { evidence: null, errors: ["GREEN exit_code must be zero"] };
	if (!current || current.ticketId !== ticketId || current.gateId !== gateId || !current.red) {
		return { evidence: null, errors: ["GREEN requires RED evidence for the same ticket and gate"] };
	}
	if (current.red.command !== command) {
		return { evidence: null, errors: ["GREEN command must exactly match the recorded RED command"] };
	}
	return {
		evidence: {
			ticketId,
			gateId,
			red: { ...current.red },
			green: { command, exitCode: stage.exitCode, recordedAt },
		},
		errors: [],
	};
}

export function isNikoflowTddEvidenceComplete(
	evidence: NikoflowTddEvidence | null | undefined,
	ticketId: string | null | undefined,
	gateId: string | null | undefined,
): boolean {
	if (!evidence || !ticketId || !gateId || evidence.ticketId !== ticketId || evidence.gateId !== gateId) return false;
	return evidence.waiver !== undefined || (evidence.red !== undefined && evidence.green !== undefined);
}

export function invalidateNikoflowTddGreen(
	evidence: NikoflowTddEvidence | null | undefined,
): NikoflowTddEvidence | null {
	if (!evidence?.green) return cloneNikoflowTddEvidence(evidence);
	const { green: _green, ...withoutGreen } = evidence;
	return cloneNikoflowTddEvidence(withoutGreen);
}

export interface NikoflowTicketInput {
	id: string;
	acceptance: string[];
	blocked_by?: string[];
	implementation_notes: string;
}

export interface NikoflowTicketDefinitionResult {
	tickets: NikoflowTicket[];
	errors: string[];
}

export interface TicketTodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
}

export interface TicketTodoPhase {
	name: string;
	tasks: TicketTodoTask[];
}

export interface DagValidation {
	ok: boolean;
	errors: string[];
}

export function cloneTickets(tickets: readonly NikoflowTicket[]): NikoflowTicket[] {
	return tickets.map(ticket => ({
		id: ticket.id,
		acceptance: [...ticket.acceptance],
		blocked_by: [...ticket.blocked_by],
		implementation_notes: ticket.implementation_notes,
		status: ticket.status,
	}));
}

function ticketSet(tickets: readonly NikoflowTicket[]): Set<string> {
	return new Set(tickets.map(ticket => ticket.id));
}

export function validateTicketDag(tickets: readonly NikoflowTicket[]): DagValidation {
	const errors: string[] = [];
	const ids = ticketSet(tickets);
	if (ids.size !== tickets.length) errors.push("ticket ids must be unique");

	for (const ticket of tickets) {
		for (const dep of ticket.blocked_by) {
			if (!ids.has(dep)) errors.push(`${ticket.id} blocked_by unknown ticket ${dep}`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));

	const visit = (id: string, path: string[]): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			errors.push(`dependency cycle: ${[...path, id].join(" -> ")}`);
			return;
		}
		const ticket = byId.get(id);
		if (!ticket) return;
		visiting.add(id);
		for (const dep of ticket.blocked_by) {
			visit(dep, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
	};

	for (const ticket of tickets) {
		visit(ticket.id, []);
	}

	return { ok: errors.length === 0, errors };
}

function cleanList(values: readonly string[]): string[] {
	return values.map(value => value.trim()).filter(Boolean);
}

const TICKET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function hasTodoTextDelimiter(value: string): boolean {
	return value.includes(" | ") || value.includes("notes=");
}

export function normalizeDefinedTickets(inputs: readonly NikoflowTicketInput[]): NikoflowTicketDefinitionResult {
	const errors: string[] = [];
	const tickets: NikoflowTicket[] = inputs.map((input, index) => {
		const position = index + 1;
		const id = input.id.trim();
		const acceptance = cleanList(input.acceptance);
		const blocked_by = cleanList(input.blocked_by ?? []);
		const implementation_notes = input.implementation_notes.trim();

		if (!id) errors.push(`ticket ${position} id is required`);
		if (id && !TICKET_ID_PATTERN.test(id)) {
			errors.push(`ticket ${id} id must match ^[A-Za-z0-9_-]+$ for durable resume; re-issue the ticket DAG.`);
		}
		if (acceptance.length === 0) errors.push(`ticket ${id || position} acceptance must not be empty`);
		acceptance.forEach((item, itemIndex) => {
			if (hasTodoTextDelimiter(item)) {
				errors.push(
					`ticket ${id || position} acceptance ${itemIndex + 1} contains a reserved todo delimiter; re-issue the ticket DAG without " | " or "notes=" in acceptance text.`,
				);
			}
		});
		for (const dep of blocked_by) {
			if (!TICKET_ID_PATTERN.test(dep)) {
				errors.push(`ticket ${id || position} blocked_by ${dep} must match ^[A-Za-z0-9_-]+$ for durable resume.`);
			}
		}
		if (!implementation_notes) errors.push(`ticket ${id || position} implementation_notes is required`);
		if (implementation_notes.includes(" notes=")) {
			errors.push(
				`ticket ${id || position} implementation_notes contains a reserved todo delimiter; re-issue the ticket DAG without " notes=" in notes.`,
			);
		}

		return {
			id,
			acceptance,
			blocked_by,
			implementation_notes,
			status: "todo",
		};
	});

	if (tickets.length === 0) errors.push("ticket list must not be empty");
	const validation = validateTicketDag(tickets);
	errors.push(...validation.errors);
	return { tickets, errors };
}

export function getNextTicket(tickets: readonly NikoflowTicket[]): NikoflowTicket | null {
	const done = new Set(tickets.filter(ticket => ticket.status === "done").map(ticket => ticket.id));
	return tickets.find(ticket => ticket.status !== "done" && ticket.blocked_by.every(dep => done.has(dep))) ?? null;
}

export function markStatus(tickets: readonly NikoflowTicket[], id: string, status: TicketStatus): NikoflowTicket[] {
	return tickets.map(ticket => (ticket.id === id ? { ...ticket, status } : ticket));
}

function todoStatus(status: TicketTodoTask["status"]): TicketStatus {
	if (status === "completed") return "done";
	if (status === "in_progress") return "review";
	return "todo";
}

export function parseTicketTodoContent(
	content: string,
	status: TicketTodoTask["status"] = "pending",
): NikoflowTicket | null {
	const separator = content.indexOf(":");
	if (separator <= 0) return null;
	const id = content.slice(0, separator).trim();
	const body = content.slice(separator + 1).trim();
	if (!id) return null;
	if (!/\b(?:acceptance|notes)=/.test(body)) return null;

	const notesMarker = " notes=";
	const notesIndex = body.lastIndexOf(notesMarker);
	const fields = notesIndex >= 0 ? body.slice(0, notesIndex).trim() : body;
	const implementation_notes = notesIndex >= 0 ? body.slice(notesIndex + notesMarker.length).trim() : "";
	const blockedMatch = /(?:^|\s)blocked_by=([^\s]+)/.exec(fields);
	const acceptanceMatch = /(?:^|\s)acceptance=(.*)$/.exec(fields);
	const acceptance =
		acceptanceMatch?.[1]
			?.split(" | ")
			.map(item => item.trim())
			.filter(Boolean) ?? [];

	return {
		id,
		acceptance,
		blocked_by:
			blockedMatch?.[1]
				.split(",")
				.map(dep => dep.trim())
				.filter(Boolean) ?? [],
		implementation_notes,
		status: todoStatus(status),
	};
}

export function ticketDagFromTodoPhases(phases: readonly TicketTodoPhase[]): NikoflowTicket[] {
	const tickets: NikoflowTicket[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const ticket = parseTicketTodoContent(task.content, task.status);
			if (ticket) tickets.push(ticket);
		}
	}
	return tickets;
}
