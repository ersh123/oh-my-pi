import { afterEach, describe, expect, test, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import {
	assertNikoflowRoleRails,
	type RoleModelResolver,
	reassertNikoflowRoleRails,
	roleForPhase,
	shouldReassertNikoflowRoleRails,
} from "../roles";

describe("nikoflow roles", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("maps phases to required model roles", () => {
		expect(roleForPhase("grilling")).toBe("plan");
		expect(roleForPhase("adr")).toBe("plan");
		expect(roleForPhase("prd")).toBe("plan");
		expect(roleForPhase("tickets")).toBe("plan");
		expect(roleForPhase("execute")).toBe("default");
		expect(roleForPhase("verify")).toBe("advisor");
	});

	test("fails fast when plan is unset or equals default", () => {
		expect(() => assertNikoflowRoleRails(() => null)).toThrow("modelRoles.plan");
		expect(() => assertNikoflowRoleRails(role => ({ model: role === "advisor" ? "qa" : "same" }))).toThrow(
			"modelRoles.plan",
		);
		expect(() =>
			assertNikoflowRoleRails(role => (role === "plan" ? "strong" : role === "default" ? "cheap" : null)),
		).toThrow("modelRoles.advisor");
	});

	test("accepts separated plan/default roles", () => {
		const resolve: RoleModelResolver = role => ({
			provider: "openai",
			model: role === "plan" ? "strong" : role === "advisor" ? "qa" : "cheap",
		});
		expect(assertNikoflowRoleRails(resolve)).toEqual({
			plan: "openai/strong",
			default: "openai/cheap",
			advisor: "openai/qa",
		});
	});

	test("warns when advisor resolves to the default model", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const roles = assertNikoflowRoleRails(role => (role === "plan" ? "strong" : "cheap"));

		expect(roles).toEqual({ plan: "strong", default: "cheap", advisor: "cheap" });
		expect(warn).toHaveBeenCalledWith(
			"Nikoflow modelRoles.advisor equals modelRoles.default; independence is context-level only.",
			{ advisor: "cheap" },
		);
	});

	test("reasserts only on retry fallback events", () => {
		const resolve: RoleModelResolver = role => (role === "plan" ? "strong" : role === "advisor" ? "qa" : "cheap");
		expect(shouldReassertNikoflowRoleRails("retry_fallback_applied")).toBe(true);
		expect(shouldReassertNikoflowRoleRails({ event: "retry_fallback_applied" })).toBe(true);
		expect(reassertNikoflowRoleRails("other", resolve)).toBeNull();
		expect(reassertNikoflowRoleRails("retry_fallback_applied", resolve)?.plan).toBe("strong");
	});
});
