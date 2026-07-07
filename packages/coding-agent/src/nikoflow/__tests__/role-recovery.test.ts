import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { classifyRoleRecovery } from "../roles";

describe("nikoflow role recovery taxonomy", () => {
	test("keeps transient failures in class a for the retry loop", () => {
		for (const id of [
			429,
			AIError.create(AIError.Flag.Transient),
			AIError.create(AIError.Flag.Timeout),
			AIError.create(AIError.Flag.ThinkingLoop),
			AIError.create(AIError.Flag.MalformedFunctionCall),
			AIError.create(AIError.Flag.StaleResponsesItem),
			AIError.create(AIError.Flag.ProviderFinishError),
		]) {
			expect(classifyRoleRecovery(id)).toEqual({ class: "a", providerWide: false });
		}
	});

	test("classifies persistent model/provider failures as class b", () => {
		expect(classifyRoleRecovery(404)).toEqual({ class: "b", providerWide: false });
		expect(classifyRoleRecovery(AIError.create(AIError.Flag.Grammar))).toEqual({
			class: "b",
			providerWide: false,
		});
		expect(classifyRoleRecovery(AIError.create(AIError.Flag.AuthFailed))).toEqual({
			class: "b",
			providerWide: true,
		});
		expect(classifyRoleRecovery(AIError.create(AIError.Flag.OAuthExpiry))).toEqual({
			class: "b",
			providerWide: true,
		});
	});

	test("uses credential-rotation outcome for provider-wide usage limits", () => {
		const usage = AIError.create(AIError.Flag.UsageLimit);

		expect(classifyRoleRecovery(usage, { switched: true })).toEqual({ class: "b", providerWide: false });
		expect(classifyRoleRecovery(usage, { switched: false, retryAtMs: Date.now() + 60_000 })).toEqual({
			class: "b",
			providerWide: false,
		});
		expect(classifyRoleRecovery(usage, { switched: false })).toEqual({ class: "b", providerWide: true });
	});

	test("keeps request-shaped failures out of model switching", () => {
		expect(classifyRoleRecovery(413)).toEqual({ class: "c", providerWide: false });
		expect(classifyRoleRecovery(AIError.create(AIError.Flag.ContextOverflow))).toEqual({
			class: "c",
			providerWide: false,
		});
		expect(classifyRoleRecovery(400)).toEqual({ class: "c", providerWide: false });
	});
});
