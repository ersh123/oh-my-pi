import * as AIError from "@oh-my-pi/pi-ai/error";
import type { NikoflowPhase, NikoflowRole } from "./state";
import { PHASE_ROLE } from "./state";

export interface ResolvedRoleModel {
	model?: string | null;
	provider?: string | null;
}

export type RoleModelResolver = (role: NikoflowRole) => ResolvedRoleModel | string | null | undefined;

export interface NikoflowResolvedRoles {
	plan: string;
	default: string | null;
	advisor: string | null;
}

export interface NikoflowRoleRecoveryUsageOutcome {
	switched: boolean;
	retryAtMs?: number;
}

export interface NikoflowRoleRecoveryDecision {
	class: "a" | "b" | "c";
	providerWide: boolean;
}

export function roleForPhase(phase: NikoflowPhase): NikoflowRole {
	return PHASE_ROLE[phase];
}

function modelKey(value: ResolvedRoleModel | string | null | undefined): string | null {
	if (typeof value === "string") return value || null;
	if (!value?.model) return null;
	return value.provider ? `${value.provider}/${value.model}` : value.model;
}

export function assertNikoflowRoleRails(resolve: RoleModelResolver): NikoflowResolvedRoles {
	const plan = modelKey(resolve("plan"));
	const defaultRole = modelKey(resolve("default"));
	const advisor = modelKey(resolve("advisor"));

	if (!plan) {
		throw new Error("Nikoflow requires modelRoles.plan to resolve. Pass --architect or configure modelRoles.plan.");
	}
	if (defaultRole && plan === defaultRole) {
		throw new Error(
			"Nikoflow requires modelRoles.plan to differ from modelRoles.default. Pass --architect/--exec or configure distinct roles.",
		);
	}
	if (!advisor) {
		throw new Error("Nikoflow requires modelRoles.advisor to resolve. Pass --qa or configure modelRoles.advisor.");
	}
	if (defaultRole && advisor === defaultRole) {
		throw new Error(
			"Nikoflow requires the QA/advisor model to differ from the executor (default) model for an independent review.",
		);
	}

	return { plan, default: defaultRole, advisor };
}

export function shouldReassertNikoflowRoleRails(event: string | { type?: string; event?: string }): boolean {
	if (typeof event === "string") return event === "retry_fallback_applied";
	return event.type === "retry_fallback_applied" || event.event === "retry_fallback_applied";
}

export function reassertNikoflowRoleRails(
	event: string | { type?: string; event?: string },
	resolve: RoleModelResolver,
): NikoflowResolvedRoles | null {
	return shouldReassertNikoflowRoleRails(event) ? assertNikoflowRoleRails(resolve) : null;
}

export function classifyRoleRecovery(
	errorId: number,
	usageOutcome?: NikoflowRoleRecoveryUsageOutcome,
): NikoflowRoleRecoveryDecision {
	if (errorId === 413 || AIError.is(errorId, AIError.Flag.ContextOverflow)) {
		return { class: "c", providerWide: false };
	}
	if (
		errorId === 401 ||
		errorId === 403 ||
		AIError.is(errorId, AIError.Flag.AuthFailed) ||
		AIError.is(errorId, AIError.Flag.OAuthExpiry)
	) {
		return { class: "b", providerWide: true };
	}
	if (AIError.is(errorId, AIError.Flag.UsageLimit)) {
		return {
			class: "b",
			providerWide: usageOutcome?.switched === false && usageOutcome.retryAtMs === undefined,
		};
	}
	if (errorId === 404 || AIError.is(errorId, AIError.Flag.Grammar)) {
		return { class: "b", providerWide: false };
	}
	if (
		errorId === 429 ||
		AIError.is(errorId, AIError.Flag.Transient) ||
		AIError.is(errorId, AIError.Flag.Timeout) ||
		AIError.is(errorId, AIError.Flag.ThinkingLoop) ||
		AIError.is(errorId, AIError.Flag.MalformedFunctionCall) ||
		AIError.is(errorId, AIError.Flag.StaleResponsesItem) ||
		AIError.is(errorId, AIError.Flag.ProviderFinishError)
	) {
		return { class: "a", providerWide: false };
	}
	return { class: "c", providerWide: false };
}
