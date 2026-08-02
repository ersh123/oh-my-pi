import { buildModel } from "@oh-my-pi/pi-catalog/build";

import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveProviderCacheProfile, resolveIdleFlushMs, type ProviderCacheProfile } from "@oh-my-pi/pi-agent-core/compaction";
import { classifyCompactionPhase, resolveGraduatedThresholds } from "@oh-my-pi/pi-agent-core/compaction";

// Minimal model stub — only the fields the profile resolver reads.
// Cast through unknown: the resolver touches a small known subset of Model.
function stubModel(overrides: Record<string, unknown> = {}): Model<Api> {
	return {
		id: "test-model",
		provider: "test",
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, total: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		compat: {},
		...overrides,
	} as unknown as Model<Api>;
}

describe("resolveProviderCacheProfile", () => {
	it("zero-tariff + empty compat → automatic (fleet reality), NOT none", () => {
		// v6 bug: a zero catalog tariff used to collapse to mode "none", but for
		// config/custom providers zero means MISSING price data, not "no cache".
		// Every provider in the active fleet caches (cacheRead>0) despite zero
		// tariffs, so the optimistic default is automatic. This is what makes
		// resolveIdleFlushMs return the automatic TTL + margin (20 min) instead
		// of the bare 10-min margin that risked flushing a warm prefix.
		const m = stubModel({ cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } });
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("automatic");
		expect(p.writeCostRatio).toBe(0);
		expect(p.readDiscount).toBe(0.5); // unknown-tariff default, not 0
	});

	it("explicit promptCacheMode 'none' → none (Bedrock no-checkpoints opt-out)", () => {
		// The ONLY path to mode "none" now: the provider explicitly declares it
		// cannot cache (Bedrock's NO_EXPLICIT_CHECKPOINTS sets promptCacheMode
		// "none"). readDiscount/writeCostRatio are zeroed because there is
		// genuinely no cache to price.
		const m = stubModel({
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
			compat: { promptCacheMode: "none" },
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("none");
		expect(p.readDiscount).toBe(0);
		expect(p.writeCostRatio).toBe(0);
	});

	it("detects Anthropic-direct explicit via real buildModel (protocol, not name)", () => {
		// v6.1 bug: the resolver only checked OpenAI/Bedrock vocab for explicit
		// mode, so Anthropic-direct (which carries supportsLongCacheRetention
		// without the word "Prompt", and no promptCacheMode at all) fell to
		// automatic + 10-min TTL — risking a warm-prefix flush under the 1h
		// OAuth retention. Now the protocol itself (api === "anthropic-messages")
		// drives explicit, and the long-retention flag is read from BOTH vocabs.
		const m = buildModel({
			id: "claude-sonnet-4-6",
			provider: "anthropic",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 8192,
			reasoning: false,
			input: ["text"],
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("explicit");
		expect(p.readDiscount).toBeCloseTo(0.9, 1);
		expect(p.writeCostRatio).toBeCloseTo(1.25, 1);
		expect(p.cacheTtlMs).toBe(60 * 60_000); // 1h via supportsLongCacheRetention
		expect(resolveIdleFlushMs(m)).toBe(70 * 60_000);
	});

	it("Anthropic proxy without long retention → explicit + 5min ephemeral", () => {
		// A non-official Anthropic-compatible proxy: buildAnthropicCompat sets
		// supportsLongCacheRetention=false, so the profile gets the 5-min
		// ephemeral default (not 1h), and idle-flush = 15 min.
		const m = buildModel({
			id: "claude-sonnet-4-6",
			provider: "anthropic",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://proxy.example.com/v1",
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 8192,
			reasoning: false,
			input: ["text"],
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("explicit");
		expect(p.cacheTtlMs).toBe(5 * 60_000);
		expect(resolveIdleFlushMs(m)).toBe(15 * 60_000);
	});

	it("detects OpenAI <5.6 automatic cache with free writes", () => {
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
			compat: { supportsPromptCacheBreakpoints: false },
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("automatic");
		expect(p.readDiscount).toBeCloseTo(0.5, 1); // 50% discount
		expect(p.writeCostRatio).toBe(0); // free writes
		expect(p.cacheTtlMs).toBe(10 * 60_000); // ~10min in-memory
	});

	it("detects OpenAI ≥5.6 with 1.25× write cost", () => {
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.125 },
			compat: { supportsPromptCacheBreakpoints: true, supportsLongPromptCacheRetention: true },
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("explicit");
		expect(p.writeCostRatio).toBeCloseTo(1.25, 1);
		expect(p.cacheTtlMs).toBe(60 * 60_000); // long retention
	});

	it("returns unknown profile for null model", () => {
		const p = resolveProviderCacheProfile(null);
		expect(p.mode).toBe("automatic");
		expect(p.readDiscount).toBe(0.5);
	});

	it("explicit cache with NO catalog write tariff still defers compaction (Codex gpt-5.6 pattern)", () => {
		// Codex gpt-5.6 is explicit (supportsPromptCacheBreakpoints) but its
		// catalog entry carries a zero cacheWrite, so calculateCost fabricates
		// a zero usage cost. The mechanism, not the tariff, must drive the
		// ratio: explicit writes are never free per spec, so we fall back to
		// the 1.25× floor and push compaction later — NOT the neutral path.
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
			compat: { supportsPromptCacheBreakpoints: true, supportsLongPromptCacheRetention: true },
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("explicit");
		expect(p.writeCostRatio).toBeCloseTo(1.25, 2);
		expect(p.writeCostRatio).toBeGreaterThan(0);
	});

	it("automatic cache with NO catalog write tariff stays neutral (free writes)", () => {
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
			compat: {},
		});
		const p = resolveProviderCacheProfile(m);
		expect(p.mode).toBe("automatic");
		expect(p.writeCostRatio).toBe(0);
	});
});

describe("resolveIdleFlushMs adapts to provider TTL", () => {
	it("Anthropic 1h (real buildModel) → 70min flush", () => {
		const m = buildModel({
			id: "claude-sonnet-4-6",
			provider: "anthropic",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 8192,
			reasoning: false,
			input: ["text"],
		});
		expect(resolveIdleFlushMs(m)).toBe(70 * 60_000);
	});

	it("OpenAI automatic ~10min → 20min flush", () => {
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
			compat: {},
		});
		expect(resolveIdleFlushMs(m)).toBe(20 * 60_000);
	});

	it("none mode (explicit opt-out) → just margin (10min)", () => {
		const m = stubModel({
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
			compat: { promptCacheMode: "none" },
		});
		expect(resolveIdleFlushMs(m)).toBe(10 * 60_000);
	});

	it("zero-tariff fleet model → 20min flush (v6 regression guard)", () => {
		// The exact v6 failure: codex/qwen with zero catalog cost used to land
		// in mode "none" → 10-min flush → warm ~10-min automatic prefix at risk.
		// After the fix they are automatic → 10-min TTL + 10-min margin = 20 min.
		const m = stubModel({ cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } });
		expect(resolveProviderCacheProfile(m).mode).toBe("automatic");
		expect(resolveIdleFlushMs(m)).toBe(20 * 60_000);
	});
});

describe("graduated thresholds adapt to write cost", () => {
	const settings = { enabled: true, strategy: "context-full" as const, thresholdPercent: 80, keepRecentTokens: 20_000 };

	it("free writes (OpenAI <5.6) → default ratios", () => {
		const freeProfile = { mode: "automatic" as const, readDiscount: 0.5, writeCostRatio: 0, cacheTtlMs: 600_000, minimumTokens: 1024 };
		const t = resolveGraduatedThresholds(200_000, settings, freeProfile);
		// pushFactor = 1 + 0 * 0.1 = 1.0 → default ratios
		expect(t.soft).toBe(Math.floor(160_000 * 0.625));
		expect(t.snip).toBe(Math.floor(160_000 * 0.75));
	});

	it("expensive writes (Anthropic 1h, 2×) → pushed 20% later", () => {
		const expensiveProfile = { mode: "explicit" as const, readDiscount: 0.9, writeCostRatio: 2, cacheTtlMs: 3_600_000, minimumTokens: 1024 };
		const t = resolveGraduatedThresholds(200_000, settings, expensiveProfile);
		// pushFactor = 1 + min(2,2)*0.1 = 1.2
		expect(t.soft).toBe(Math.floor(160_000 * 0.625 * 1.2));
		expect(t.snip).toBe(Math.floor(160_000 * 0.75 * 1.2));
		expect(t.force).toBe(Math.min(199_999, Math.ceil(160_000 * 1.125 * 1.2)));
	});

	it("classifyCompactionPhase respects adaptive thresholds", () => {
		const expensiveProfile = { mode: "explicit" as const, readDiscount: 0.9, writeCostRatio: 2, cacheTtlMs: 3_600_000, minimumTokens: 1024 };
		const freeProfile = { mode: "automatic" as const, readDiscount: 0.5, writeCostRatio: 0, cacheTtlMs: 600_000, minimumTokens: 1024 };
		// At 130k tokens: with free writes, soft=100k → phase=soft;
		// At 130k: free (soft=100k, snip=120k) → snip; expensive (soft=120k,
		// snip=144k) → still soft, because the expensive-write push moved the
		// snip boundary past 130k. This is the adaptive behaviour: costly
		// prefix rewrites are deferred longer.
		expect(classifyCompactionPhase(130_000, 200_000, settings, freeProfile)).toBe("snip");
		expect(classifyCompactionPhase(130_000, 200_000, settings, expensiveProfile)).toBe("soft");
	});
});

describe("resolved-compat consistency (offline fleet cross-check)", () => {
	// These imitate the RESOLVED compat each real provider's Model carries after
	// buildModel — the resolver reads resolved fields, never re-detects. They
	// pin the contract the throwaway v4 validation script exercised, now
	// persistent, with an undefined-guard so a branch that forgets to assign
	// writeCostRatio fails the suite instead of silently producing NaN logic
	// (the exact class of mistake an ad-hoc script hid behind a typo).
	const assertDefined = (p: ProviderCacheProfile) => {
		expect(typeof p.writeCostRatio).toBe("number");
		expect(Number.isFinite(p.writeCostRatio)).toBe(true);
	};

	it("empty compat (codex gpt-5.6 / qwen3.8 resolved shape) → automatic, free writes", () => {
		const p = resolveProviderCacheProfile(stubModel({ compat: {} }));
		expect(p.mode).toBe("automatic");
		expect(p.writeCostRatio).toBe(0);
		assertDefined(p);
	});

	it("non-official host (breakpoints explicitly false) → automatic, free writes", () => {
		const p = resolveProviderCacheProfile(stubModel({ compat: { supportsPromptCacheBreakpoints: false } }));
		expect(p.mode).toBe("automatic");
		expect(p.writeCostRatio).toBe(0);
		assertDefined(p);
	});

	it("explicit + zero tariff → explicit, spec floor (not neutral)", () => {
		const p = resolveProviderCacheProfile(
			stubModel({
				cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				compat: { supportsPromptCacheBreakpoints: true, supportsLongPromptCacheRetention: true },
			}),
		);
		expect(p.mode).toBe("explicit");
		expect(p.writeCostRatio).toBe(1.25);
		assertDefined(p);
	});

	it("explicit + measured tariff → measured ratio wins over the floor", () => {
		const p = resolveProviderCacheProfile(
			stubModel({
				cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.125 },
				compat: { supportsPromptCacheBreakpoints: true },
			}),
		);
		expect(p.mode).toBe("explicit");
		expect(p.writeCostRatio).toBeCloseTo(1.25, 2);
		assertDefined(p);
	});
});

describe("cacheTtlMs covers every spec branch", () => {
	it("30m breakpoint TTL → 30 min base, 40 min idle flush", () => {
		const m = stubModel({
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 3.125 },
			compat: { supportsPromptCacheBreakpoints: true, promptCacheBreakpointTtl: "30m" },
		});
		expect(resolveProviderCacheProfile(m).cacheTtlMs).toBe(30 * 60_000);
		expect(resolveIdleFlushMs(m)).toBe(40 * 60_000);
	});

	it("explicit without long retention or breakpoint TTL → 5 min (Anthropic ephemeral)", () => {
		const m = stubModel({
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			compat: { promptCacheMode: "explicit" },
		});
		expect(resolveProviderCacheProfile(m).cacheTtlMs).toBe(5 * 60_000);
		expect(resolveIdleFlushMs(m)).toBe(15 * 60_000);
	});
});
