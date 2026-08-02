import {
	cloneNikoflowTddEvidence,
	cloneTickets,
	invalidateNikoflowTddGreen,
	type NikoflowTddCommandEvidence,
	type NikoflowTddEvidence,
	type NikoflowTddRedEvidence,
	type NikoflowTddWaiverEvidence,
	type NikoflowTicket,
} from "./tickets";

export const NIKOFLOW_DEPTHS = ["light", "max", "research"] as const;
export type NikoflowDepth = (typeof NIKOFLOW_DEPTHS)[number];

export const NIKOFLOW_GRILLING_MODES = ["interview", "brief"] as const;
export type NikoflowGrillingMode = (typeof NIKOFLOW_GRILLING_MODES)[number];

export type NikoflowPhase = "grilling" | "adr" | "prd" | "tickets" | "execute" | "verify" | "research";

export const NIKOFLOW_PHASES: Record<NikoflowDepth, readonly NikoflowPhase[]> = {
	light: ["grilling", "prd", "tickets", "execute", "verify"],
	max: ["grilling", "adr", "prd", "tickets", "execute", "verify"],
	research: ["grilling", "research", "verify"],
} as const;

export type NikoflowRole = "plan" | "default" | "advisor";

export const PHASE_ROLE: Record<NikoflowPhase, NikoflowRole> = {
	grilling: "plan",
	adr: "plan",
	prd: "plan",
	tickets: "plan",
	research: "plan",
	execute: "default",
	verify: "advisor",
} as const;

export type NikoflowRoleOverrides = Partial<Record<NikoflowRole, string>>;
export type NikoflowRoleSwitchCounts = Partial<Record<NikoflowRole, number>>;

export interface NikoflowState {
	depth: NikoflowDepth;
	autonomous: boolean;
	grillingMode: NikoflowGrillingMode | null;
	originalTask: string;
	phaseIndex: number;
	gateRequestId: string | null;
	gateMintedAt: number | null;
	batchGateAcceptedAt: number | null;
	phaseTurnStarted: boolean;
	tickets: NikoflowTicket[];
	activeTicketId: string | null;
	roleOverrides: NikoflowRoleOverrides;
	roleSwitchCounts: NikoflowRoleSwitchCounts;
	deadSelectors: string[];
	tddEvidence: NikoflowTddEvidence | null;
}

export interface NikoflowModeData {
	depth: NikoflowDepth;
	autonomous: boolean;
	grillingMode: NikoflowGrillingMode | null;
	originalTask: string;
	phaseIndex: number;
	gateRequestId: string | null;
	gateMintedAt: number | null;
	batchGateAcceptedAt: number | null;
	phaseTurnStarted: boolean;
	tickets: NikoflowTicket[];
	activeTicketId: string | null;
	roleOverrides: NikoflowRoleOverrides;
	roleSwitchCounts: NikoflowRoleSwitchCounts;
	deadSelectors: string[];
	tddEvidence: NikoflowTddEvidence | null;
}

function normalizeGrillingMode(value: unknown): NikoflowGrillingMode | null {
	return typeof value === "string" && NIKOFLOW_GRILLING_MODES.includes(value as NikoflowGrillingMode)
		? (value as NikoflowGrillingMode)
		: null;
}

function normalizeRoleOverrides(value: unknown): NikoflowRoleOverrides {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const output: NikoflowRoleOverrides = {};
	for (const role of ["plan", "default", "advisor"] satisfies NikoflowRole[]) {
		const selector = input[role];
		if (typeof selector === "string" && selector.trim()) output[role] = selector;
	}
	return output;
}

function normalizeRoleSwitchCounts(value: unknown): NikoflowRoleSwitchCounts {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const output: NikoflowRoleSwitchCounts = {};
	for (const role of ["plan", "default", "advisor"] satisfies NikoflowRole[]) {
		const count = input[role];
		if (typeof count === "number" && Number.isInteger(count) && count > 0) output[role] = count;
	}
	return output;
}

function normalizeDeadSelectors(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((selector): selector is string => typeof selector === "string" && selector.trim().length > 0);
}

function normalizeTickets(value: unknown): NikoflowTicket[] {
	return Array.isArray(value) ? cloneTickets(value as NikoflowTicket[]) : [];
}
function normalizeTddEvidence(value: unknown): NikoflowTddEvidence | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (typeof input.ticketId !== "string" || !input.ticketId.trim()) return null;
	if (typeof input.gateId !== "string" || !input.gateId.trim()) return null;

	const commandEvidence = (candidate: unknown): NikoflowTddCommandEvidence | undefined => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
		const record = candidate as Record<string, unknown>;
		return typeof record.command === "string" &&
			typeof record.exitCode === "number" &&
			typeof record.recordedAt === "number"
			? { command: record.command, exitCode: record.exitCode, recordedAt: record.recordedAt }
			: undefined;
	};
	const redBase = commandEvidence(input.red);
	const redRecord = input.red as Record<string, unknown> | undefined;
	const red: NikoflowTddRedEvidence | undefined =
		redBase && typeof redRecord?.expectedFailure === "string"
			? { ...redBase, expectedFailure: redRecord.expectedFailure }
			: undefined;
	const green = commandEvidence(input.green);
	const waiverRecord = input.waiver as Record<string, unknown> | undefined;
	const waiver: NikoflowTddWaiverEvidence | undefined =
		waiverRecord && typeof waiverRecord.reason === "string" && typeof waiverRecord.recordedAt === "number"
			? { reason: waiverRecord.reason, recordedAt: waiverRecord.recordedAt }
			: undefined;
	if (!red && !green && !waiver) return null;
	return {
		ticketId: input.ticketId,
		gateId: input.gateId,
		...(red ? { red } : {}),
		...(green ? { green } : {}),
		...(waiver ? { waiver } : {}),
	};
}

export function createState(
	depth: NikoflowDepth,
	options: { autonomous?: boolean; grillingMode?: NikoflowGrillingMode | null; originalTask?: string } = {},
): NikoflowState {
	return {
		depth,
		autonomous: options.autonomous === true,
		grillingMode: normalizeGrillingMode(options.grillingMode),
		originalTask: typeof options.originalTask === "string" ? options.originalTask : "",
		phaseIndex: 0,
		gateRequestId: null,
		gateMintedAt: null,
		batchGateAcceptedAt: null,
		phaseTurnStarted: false,
		tickets: [],
		activeTicketId: null,
		roleOverrides: {},
		roleSwitchCounts: {},
		deadSelectors: [],
		tddEvidence: null,
	};
}

export function nikoflowModeData(state: NikoflowState): NikoflowModeData {
	return {
		depth: state.depth,
		autonomous: state.autonomous,
		grillingMode: state.grillingMode,
		originalTask: state.originalTask,
		phaseIndex: state.phaseIndex,
		gateRequestId: state.gateRequestId,
		gateMintedAt: state.gateMintedAt,
		batchGateAcceptedAt: state.batchGateAcceptedAt,
		phaseTurnStarted: state.phaseTurnStarted,
		tickets: cloneTickets(state.tickets),
		activeTicketId: state.activeTicketId,
		roleOverrides: { ...state.roleOverrides },
		roleSwitchCounts: { ...state.roleSwitchCounts },
		deadSelectors: [...state.deadSelectors],
		tddEvidence: cloneNikoflowTddEvidence(state.tddEvidence),
	};
}

export function nikoflowStateFromModeData(
	modeData: NikoflowModeData | Record<string, unknown> | undefined,
): NikoflowState | null {
	if (!modeData) return null;
	const depth = modeData.depth;
	if (typeof depth !== "string" || !NIKOFLOW_DEPTHS.includes(depth as NikoflowDepth)) return null;
	const state = createState(depth as NikoflowDepth, {
		autonomous: modeData?.autonomous === true,
		grillingMode: normalizeGrillingMode(modeData.grillingMode),
		originalTask: typeof modeData.originalTask === "string" ? modeData.originalTask : "",
	});
	const phases = materializePhases(state.depth);
	const phaseIndex = modeData.phaseIndex;
	if (typeof phaseIndex !== "number" || !Number.isInteger(phaseIndex)) return state;
	if (phaseIndex < 0 || phaseIndex > phases.length) return state;
	const gateRequestId = modeData.gateRequestId;
	const gateMintedAt = modeData.gateMintedAt;
	const batchGateAcceptedAt = modeData.batchGateAcceptedAt;
	const activeTicketId = modeData.activeTicketId;
	return {
		...state,
		phaseIndex,
		gateRequestId: typeof gateRequestId === "string" && gateRequestId.length > 0 ? gateRequestId : null,
		gateMintedAt: typeof gateMintedAt === "number" ? gateMintedAt : null,
		batchGateAcceptedAt: typeof batchGateAcceptedAt === "number" ? batchGateAcceptedAt : null,
		phaseTurnStarted: modeData.phaseTurnStarted === true,
		tickets: normalizeTickets(modeData.tickets),
		activeTicketId: typeof activeTicketId === "string" && activeTicketId.length > 0 ? activeTicketId : null,
		roleOverrides: normalizeRoleOverrides(modeData.roleOverrides),
		roleSwitchCounts: normalizeRoleSwitchCounts(modeData.roleSwitchCounts),
		deadSelectors: normalizeDeadSelectors(modeData.deadSelectors),
		tddEvidence: normalizeTddEvidence(modeData.tddEvidence),
	};
}

export function materializePhases(depth: NikoflowDepth): NikoflowPhase[] {
	return [...NIKOFLOW_PHASES[depth]];
}

export function inferDepthFromPrompt(prompt: string): NikoflowDepth | null {
	const activation = /(?:\$?nikoflow|niko[\s-]+flow|nflow|нико[\s-]*флоу)/i.test(prompt);
	if (!activation) return null;
	const explicit = new RegExp(
		`(?:\\$?nikoflow|niko[\\s-]+flow|nflow|нико[\\s-]*флоу)(?::|\\s+)?(${NIKOFLOW_DEPTHS.join("|")})\\b`,
		"i",
	).exec(prompt);
	if (explicit?.[1]) return explicit[1].toLowerCase() as NikoflowDepth;
	if (
		/(?:не\s+(?:задавай\s+вопросов|спрашивай)|без\s+вопросов|no\s+questions|do\s+not\s+ask|don't\s+ask)/i.test(prompt)
	) {
		return "max";
	}
	return null;
}

export function currentPhase(state: NikoflowState): NikoflowPhase | null {
	return materializePhases(state.depth)[state.phaseIndex] ?? null;
}

export function currentRole(state: NikoflowState): NikoflowRole | null {
	const phase = currentPhase(state);
	return phase ? PHASE_ROLE[phase] : null;
}

export function isHumanGatePhase(state: NikoflowState): boolean {
	const phase = currentPhase(state);
	return phase === "grilling" || phase === "adr" || phase === "prd" || phase === "tickets";
}

export function advancePhase(state: NikoflowState): NikoflowState {
	const nextIndex = Math.min(state.phaseIndex + 1, materializePhases(state.depth).length);
	const nextPhase = materializePhases(state.depth)[nextIndex] ?? null;
	return {
		...state,
		phaseIndex: nextIndex,
		gateRequestId: null,
		gateMintedAt: null,
		batchGateAcceptedAt: null,
		phaseTurnStarted: false,
		activeTicketId: nextPhase === "execute" ? state.activeTicketId : null,
		tddEvidence: null,
	};
}

export function isComplete(state: NikoflowState): boolean {
	return state.phaseIndex >= materializePhases(state.depth).length;
}

export function mintGateRequest(state: NikoflowState, id: string, mintedAt: number | null = null): NikoflowState {
	const tddEvidence =
		currentPhase(state) === "execute" && state.tddEvidence?.ticketId === state.activeTicketId
			? invalidateNikoflowTddGreen({ ...state.tddEvidence, gateId: id })
			: null;
	return { ...state, gateRequestId: id, gateMintedAt: mintedAt, batchGateAcceptedAt: null, tddEvidence };
}

export function rotateGateRequest(state: NikoflowState, id: string, mintedAt: number | null = null): NikoflowState {
	return mintGateRequest(state, id, mintedAt);
}

export function clearGateRequest(state: NikoflowState): NikoflowState {
	return { ...state, gateRequestId: null, gateMintedAt: null };
}

export function gateMatches(state: NikoflowState, id: string | null | undefined): boolean {
	return id != null && state.gateRequestId === id;
}

export function markPhaseTurnStarted(state: NikoflowState): NikoflowState {
	return state.phaseTurnStarted ? state : { ...state, phaseTurnStarted: true };
}

export function setTicketDag(state: NikoflowState, tickets: readonly NikoflowTicket[]): NikoflowState {
	return { ...state, tickets: cloneTickets(tickets), activeTicketId: null, tddEvidence: null };
}

export function currentTicket(state: NikoflowState): NikoflowTicket | null {
	return state.tickets.find(ticket => ticket.id === state.activeTicketId) ?? null;
}
