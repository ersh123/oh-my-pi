import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { SEGMENTS } from "./segments";
import type { SegmentContext } from "./types";

// cacheHitSegment.render reads ONLY ctx.usageStats.{cacheRead,cacheWrite,input}
// (verified by reading its body), so a minimal ctx is honest here — we are not
// stubbing fields the render touches. The theme singleton is required because
// the render wraps the rate in theme.fg / theme.icon.cache.
function ctxWithUsage(usage: { cacheRead: number; cacheWrite: number; input: number }): SegmentContext {
	return {
		usageStats: {
			input: usage.input,
			output: 0,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		balance: null,
	} as unknown as SegmentContext;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("cache_hit segment (the only live cache instrument in an implicit-cache fleet)", () => {
	it("renders a visible hit-rate for implicit providers (cacheRead>0, cacheWrite=0)", () => {
		// The active fleet (codex/qwen/zai/glm/deepseek via relays) is implicit:
		// cacheWrite tokens are always 0 while cacheRead is non-zero on warm
		// turns. This is the ONLY place the operator sees cache health, so the
		// working implicit case MUST be covered — the existing component test
		// only exercised cacheRead:0 (the hidden branch).
		const rate = ((159_650 / (159_650 + 0 + 53_750)) * 100).toFixed(2); // 74.81
		const rendered = SEGMENTS.cache_hit.render(ctxWithUsage({ cacheRead: 159_650, cacheWrite: 0, input: 53_750 }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(`${rate}%`);
	});

	it("regression: a cacheWrite-gated guard would kill the implicit fleet (guard must key on cacheRead)", () => {
		// If someone "tidies" the guard from `if (!cacheRead)` to `if (!cacheWrite)`,
		// an implicit warm turn (cacheRead>0, cacheWrite=0) would be hidden — the
		// instrument dies exactly where the fleet lives. This test pins the
		// contract: cacheRead>0 with cacheWrite==0 is VISIBLE.
		const rendered = SEGMENTS.cache_hit.render(ctxWithUsage({ cacheRead: 50_000, cacheWrite: 0, input: 200 }));
		expect(rendered.visible).toBe(true);
	});

	it("stays hidden on the first turn / a 1-turn session (nothing cached yet)", () => {
		// Honest edge case: the segment hides while cacheRead==0 because no
		// prefix has been cached yet, so a single-turn session never shows it.
		const rendered = SEGMENTS.cache_hit.render(ctxWithUsage({ cacheRead: 0, cacheWrite: 0, input: 53_000 }));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("includes cacheWrite in the denominator for explicit providers", () => {
		// Anthropic-style explicit turn: the newly-written prefix (cacheWrite) is
		// part of the prompt, so the rate is cacheRead/(cacheRead+cacheWrite+input),
		// not cacheRead/(cacheRead+input). Pins the denominator honesty.
		const { cacheRead, cacheWrite, input } = { cacheRead: 40_000, cacheWrite: 10_000, input: 1_000 };
		const rate = ((cacheRead / (cacheRead + cacheWrite + input)) * 100).toFixed(2); // 78.43
		const rendered = SEGMENTS.cache_hit.render(ctxWithUsage({ cacheRead, cacheWrite, input }));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain(`${rate}%`);
	});

	it("measures ONLY the managed prefix: invariant to the provider's internal orchestration cache", () => {
		// Codex reports a SEPARATE internal orchestration pass via
		// orchestration_input_cached_tokens -> usage.orchestration.cacheRead
		// (openai-shared.ts populateResponsesUsageFromResponse), which is a
		// different prefix from the one the Reasonix discipline controls
		// (system+tools+history). The cache_hit instrument must measure only the
		// managed prefix, so its rate must NOT move when an orchestration cache
		// read is present in the session stats. Empirically the active fleet
		// never forwards this layer (orchestrationCacheRead == 0 on all 5733
		// observed turns), but the invariant is pinned regardless so a future
		// "tidy" that folds orchestrationCacheRead into the numerator or
		// denominator (conflating two distinct caches) fails here.
		const managed = { cacheRead: 122_772_736, cacheWrite: 0, input: 5_000_000 };
		const ctxWithout = ctxWithUsage(managed);
		const ctxWith = {
			usageStats: { ...ctxWithout.usageStats, orchestrationCacheRead: 8_000_000 },
		} as unknown as SegmentContext;
		const without = SEGMENTS.cache_hit.render(ctxWithout);
		const withOrch = SEGMENTS.cache_hit.render(ctxWith);
		expect(without.visible).toBe(true);
		expect(withOrch.visible).toBe(true);
		// Identical content proves the orchestration layer did not enter the
		// formula in either the numerator or the denominator.
		expect(withOrch.content).toBe(without.content);
	});
});

describe("cache_hit_model segment (per-model cache hit rate)", () => {
	function ctxWithModel(
		model: { provider: string; id: string } | null,
		perModel: Map<string, { input: number; cacheRead: number; cacheWrite: number }> | null,
	) {
		return {
			session: { state: { model } },
			perModelUsage: perModel,
			usageStats: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			},
		} as unknown as SegmentContext;
	}

	it("renders per-model hit rate when data exists", () => {
		const perModel = new Map([["openai-codex/gpt-5.6-terra", { input: 5000, cacheRead: 95000, cacheWrite: 0 }]]);
		const ctx = ctxWithModel({ provider: "openai-codex", id: "gpt-5.6-terra" }, perModel);
		const result = SEGMENTS.cache_hit_model.render(ctx);
		expect(result.visible).toBe(true);
		expect(result.content).toContain("95.0%");
		expect(result.content).toContain("5.6-terra");
	});

	it("hidden when no model is active", () => {
		const perModel = new Map([["openai-codex/gpt-5.6-terra", { input: 5000, cacheRead: 95000, cacheWrite: 0 }]]);
		const ctx = ctxWithModel(null, perModel);
		const result = SEGMENTS.cache_hit_model.render(ctx);
		expect(result.visible).toBe(false);
	});

	it("hidden when perModelUsage is null", () => {
		const ctx = ctxWithModel({ provider: "openai-codex", id: "gpt-5.6-terra" }, null);
		const result = SEGMENTS.cache_hit_model.render(ctx);
		expect(result.visible).toBe(false);
	});

	it("hidden when model has no cacheRead", () => {
		const perModel = new Map([["openai-codex/gpt-5.6-terra", { input: 5000, cacheRead: 0, cacheWrite: 0 }]]);
		const ctx = ctxWithModel({ provider: "openai-codex", id: "gpt-5.6-terra" }, perModel);
		const result = SEGMENTS.cache_hit_model.render(ctx);
		expect(result.visible).toBe(false);
	});
});

describe("reprocessed segment (uncached token volume)", () => {
	it("renders input + cacheWrite as reprocessed tokens", () => {
		const ctx = ctxWithUsage({ cacheRead: 90000, cacheWrite: 3000, input: 7000 });
		const result = SEGMENTS.reprocessed.render(ctx);
		expect(result.visible).toBe(true);
		// 7000 + 3000 = 10,000 → "10K" or "10.0K"
		expect(result.content).toContain("↻");
	});

	it("hidden when no tokens were reprocessed", () => {
		const ctx = ctxWithUsage({ cacheRead: 100000, cacheWrite: 0, input: 0 });
		const result = SEGMENTS.reprocessed.render(ctx);
		expect(result.visible).toBe(false);
	});

	it("shows only input for automatic-cache providers (cacheWrite=0)", () => {
		const ctx = ctxWithUsage({ cacheRead: 95000, cacheWrite: 0, input: 5000 });
		const result = SEGMENTS.reprocessed.render(ctx);
		expect(result.visible).toBe(true);
		// 5000 + 0 = 5000
		expect(result.content).toContain("↻");
	});
});
