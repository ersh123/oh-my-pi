/**
 * Provider cache profile — derives cache economics and TTL from the model's
 * own metadata (`cost`, `compat`) so the compaction engine can adapt its
 * graduated thresholds and idle-flush timing per provider without hardcoding
 * provider names.
 *
 * Official spec facts (verified 2026-07-27):
 * - Anthropic: read = 10% of input (90% discount), write = 1.25× (5m) or 2× (1h),
 *   TTL = 5m default / 1h with `ttl: "1h"`, explicit byte-match, min ~1024 tokens.
 * - OpenAI <5.6: read = 50% of input, write = FREE, TTL = in-memory ~5-10 min,
 *   automatic, min 1024 tokens.
 * - OpenAI ≥5.6: read = 50% of input, write = 1.25×, TTL = in-memory / 24h ext,
 *   automatic + explicit breakpoints, min 1024 tokens.
 * - Bedrock: explicit checkpoints, 5m / 1h TTL, min 1024-4096 per model.
 * - Unknown / proxy: conservative defaults (50% read discount, free write, 10m TTL).
 */

import type { Api, Model } from "@oh-my-pi/pi-ai";

export type CacheMode = "explicit" | "automatic" | "none";

export interface ProviderCacheProfile {
	/** How the provider caches: explicit breakpoints, automatic prefix, or none. */
	mode: CacheMode;
	/** Discount on cache-read tokens vs fresh input (0..1). 0.9 = 90% cheaper. */
	readDiscount: number;
	/** Cost of cache-write relative to input price. 0 = free, 1.25 = 25% premium, 2 = double. */
	writeCostRatio: number;
	/** Effective cache TTL in milliseconds. Used for idle-flush adaptation. */
	cacheTtlMs: number;
	/** Minimum prefix tokens for the cache to activate. */
	minimumTokens: number;
}

/** Conservative defaults when the model carries no cache metadata. */
const UNKNOWN_PROFILE: ProviderCacheProfile = {
	mode: "automatic",
	readDiscount: 0.5,
	writeCostRatio: 0,
	cacheTtlMs: 10 * 60_000,
	minimumTokens: 1024,
};

/**
 * Write-cost premium assumed for explicit prompt caching when the catalog
 * carries no write tariff. Per the verified spec set the cheapest explicit
 * write is 1.25× the input price (OpenAI ≥5.6 and Anthropic 5-minute
 * retention); Anthropic 1-hour retention is 2×. We use the floor so an
 * un-tariffed explicit provider (e.g. Codex gpt-5.6, whose catalog entry
 * has a zero cacheWrite) still defers compaction conservatively instead of
 * collapsing to the free-write (neutral) path and cratering its cache.
 * Known unverified boundary: the Bedrock explicit write premium was NOT
 * spec-confirmed at authoring time (docs search was unreachable), so the
 * 1.25x floor for an un-tariffed explicit Bedrock model is an assumption —
 * worst-case safe (it over-defers compaction; soft/snip + force still bound
 * the tail and overflow, and the miss marker never under-reports a rewrite).
 */
const EXPLICIT_WRITE_COST_RATIO_FLOOR = 1.25;

/**
 * Derive a cache profile from the model's cost and compat metadata.
 * Pure function — no I/O, no provider-name hardcoding.
 */
export function resolveProviderCacheProfile(model: Model<Api> | undefined | null): ProviderCacheProfile {
	if (!model) return UNKNOWN_PROFILE;

	const cost = model.cost;
	const compat = model.compat as Record<string, unknown> | undefined;

	// --- mode ---
	// Two distinct questions, kept separate:
	//   1. Does the provider cache at all?        -> drives `mode`.
	//   2. Is there a catalog tariff for it?      -> drives the ratios below.
	// A zero catalog tariff is MISSING DATA for config/custom providers
	// (calculateCost fabricates usage.cost from model.cost, so a zero there
	// means "no price row", not "the provider does not cache"). The fleet
	// observation (3581 reqs, every provider echoes cacheRead>0) shows the
	// whole active fleet caches despite zero tariffs. So the absence of a
	// tariff AND of explicit compat flags must NOT collapse to mode "none" —
	// that previously mis-classified codex/qwen as cache-less, which forced
	// resolveIdleFlushMs down to the bare 10-minute margin and risked
	// flushing a still-warm ~10-minute automatic prefix. We treat missing
	// evidence optimistically as `automatic` (the safe default: writeRatio 0
	// = neutral push factor, readDiscount falls back to the unknown default,
	// idle-flush gets the automatic TTL + margin). mode "none" is reserved
	// for an EXPLICIT opt-out (Bedrock no-checkpoints sets
	// promptCacheMode:"none"), where the provider truly cannot cache.
	const promptCacheMode = compat?.promptCacheMode as string | undefined;
	const supportsBreakpoints = compat?.supportsPromptCacheBreakpoints === true;
	const hasCacheReadPricing = typeof cost?.cacheRead === "number" && cost.cacheRead > 0;
	const hasCacheWritePricing = typeof cost?.cacheWrite === "number" && cost.cacheWrite > 0;
	// Anthropic's resolved compat carries NO promptCacheMode / supportsBreakpoints
	// fields — explicit caching is implicit in the anthropic-messages protocol
	// (the wire layer always sends cache_control unless retention is "none").
	// The only Anthropic-specific long-retention flag is supportsLongCacheRetention
	// (without the word "Prompt"), which the OpenAI/Bedrock vocab uses as
	// supportsLongPromptCacheRetention. We read both below for TTL; here we
	// detect the protocol itself so Anthropic-direct resolves to explicit,
	// not automatic (which would give a 10-min TTL and flush a warm 1h prefix).
	const isAnthropicProtocol = model.api === "anthropic-messages";

	let mode: CacheMode;
	if (promptCacheMode === "none") {
		mode = "none";
	} else if (promptCacheMode === "explicit" || supportsBreakpoints || isAnthropicProtocol) {
		mode = "explicit";
	} else {
		mode = "automatic";
	}

	if (mode === "none") {
		return { ...UNKNOWN_PROFILE, mode: "none", readDiscount: 0, writeCostRatio: 0 };
	}

	// --- readDiscount ---
	let readDiscount: number;
	if (hasCacheReadPricing && typeof cost.input === "number" && cost.input > 0) {
		readDiscount = Math.max(0, Math.min(1, 1 - cost.cacheRead / cost.input));
	} else {
		readDiscount = UNKNOWN_PROFILE.readDiscount;
	}

	// --- writeCostRatio ---
	// Derived by caching MECHANISM, not by provider name, because the catalog
	// tariff (`model.cost.cacheWrite`) is frequently absent: `calculateCost`
	// fabricates `usage.cost.cacheWrite` from it, so a zero there is missing
	// data, not a measured free write. The mechanism tells the truth:
	//   - explicit caching (Anthropic / Bedrock / OpenAI ≥5.6 breakpoints)
	//     ALWAYS charges a write premium per spec, so an absent tariff falls
	//     back to the spec floor (1.25×) — treating an expensive rewrite as
	//     free would under-defer compaction and crater the cache.
	//   - automatic caching (OpenAI <5.6, most relays) writes for free per
	//     spec, so a rewrite costs nothing extra → neutral push factor.
	let writeCostRatio: number;
	if (hasCacheWritePricing && typeof cost.input === "number" && cost.input > 0) {
		writeCostRatio = cost.cacheWrite / cost.input;
	} else if (mode === "explicit") {
		writeCostRatio = EXPLICIT_WRITE_COST_RATIO_FLOOR;
	} else {
		writeCostRatio = 0;
	}
	// Fleet observation (verified 2026-07-28 against 3581 requests across 46
	// sessions, every provider in the active fleet): the provider echoes
	// cacheWrite TOKENS as 0 on every turn while cacheRead is non-zero, i.e.
	// all of them behave as automatic-style caching from the billing side.
	// That matches the `mode === "automatic"` → writeCostRatio = 0 outcome
	// produced above for empty-compat models (codex gpt-5.6, alibaba qwen3.8).
	// If a provider ever starts billing explicit writes in tokens, the
	// `hasCacheWritePricing` branch takes over and the measured ratio replaces
	// the mechanism-based default — no code change.

	// --- cacheTtlMs ---
	const supportsLong =
		compat?.supportsLongPromptCacheRetention === true ||
		compat?.supportsLongCacheRetention === true;
	const breakpointTtl = compat?.promptCacheBreakpointTtl as string | undefined;
	let cacheTtlMs: number;
	if (supportsLong) {
		// 1h for Anthropic/Bedrock long retention, 24h for OpenAI extended.
		// We use 1h as the conservative default for idle-flush; OpenAI 24h is opt-in.
		cacheTtlMs = 60 * 60_000;
	} else if (breakpointTtl === "30m") {
		cacheTtlMs = 30 * 60_000;
	} else if (mode === "explicit") {
		// Anthropic/Bedrock default ephemeral = 5 minutes.
		cacheTtlMs = 5 * 60_000;
	} else {
		// OpenAI automatic in-memory ≈ 5-10 minutes; use 10 as conservative upper bound.
		cacheTtlMs = 10 * 60_000;
	}

	// --- minimumTokens ---
	const minTokens = compat?.promptCacheMinimumTokens as number | undefined;
	const minimumTokens = typeof minTokens === "number" && minTokens > 0 ? minTokens : 1024;

	return { mode, readDiscount, writeCostRatio, cacheTtlMs, minimumTokens };
}

/**
 * Idle-flush margin added on top of the cache TTL before the supersede pass
 * is allowed to rewrite the sent region. 10 minutes gives the provider time
 * to expire the cache naturally before we bust it ourselves.
 */
const IDLE_FLUSH_MARGIN_MS = 10 * 60_000;

/**
 * Compute the adaptive idle-flush threshold for a given model.
 * Replaces the hardcoded `PRUNE_IDLE_FLUSH_MS = 90 * 60_000` which was
 * calibrated for Anthropic's 1h TTL but left OpenAI's ~10m cache dead
 * for 80 extra minutes of wasted tail context.
 */
export function resolveIdleFlushMs(model: Model<Api> | undefined | null): number {
	const profile = resolveProviderCacheProfile(model);
	if (profile.mode === "none") return IDLE_FLUSH_MARGIN_MS;
	return profile.cacheTtlMs + IDLE_FLUSH_MARGIN_MS;
}
