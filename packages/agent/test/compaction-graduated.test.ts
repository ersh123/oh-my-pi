import { describe, expect, it } from "bun:test";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction/compaction";
import type { ProviderCacheProfile } from "@oh-my-pi/pi-agent-core/compaction/cache-profile";
import {
	classifyCompactionPhase,
	GRADUATED_FORCE_RATIO,
	GRADUATED_SNIP_RATIO,
	GRADUATED_SOFT_RATIO,
	resolveGraduatedThresholds,
	resolveThresholdTokens,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";

const base: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: 80,
	thresholdTokens: -1,
	keepRecentTokens: 20000,
};

describe("graduated compaction phases", () => {
	it("spaces soft/snip/high/force as fixed fractions of the threshold", () => {
		const cw = 200_000;
		const thresholds = resolveGraduatedThresholds(cw, base);
		// high = 80% of 200k = 160k
		expect(thresholds.high).toBe(160_000);
		expect(thresholds.soft).toBe(Math.floor(160_000 * GRADUATED_SOFT_RATIO));
		expect(thresholds.snip).toBe(Math.floor(160_000 * GRADUATED_SNIP_RATIO));
		expect(thresholds.force).toBe(Math.min(cw - 1, Math.ceil(160_000 * GRADUATED_FORCE_RATIO)));
		expect(thresholds.soft).toBeLessThan(thresholds.snip);
		expect(thresholds.snip).toBeLessThan(thresholds.high);
		expect(thresholds.high).toBeLessThan(thresholds.force);
	});

	it("classifies usage into the correct phase at each boundary", () => {
		const cw = 200_000;
		const thresholds = resolveGraduatedThresholds(cw, base);
		expect(classifyCompactionPhase(thresholds.soft - 1, cw, base)).toBe("none");
		expect(classifyCompactionPhase(thresholds.soft, cw, base)).toBe("soft");
		expect(classifyCompactionPhase(thresholds.snip - 1, cw, base)).toBe("soft");
		expect(classifyCompactionPhase(thresholds.snip, cw, base)).toBe("snip");
		expect(classifyCompactionPhase(thresholds.high, cw, base)).toBe("snip");
		expect(classifyCompactionPhase(thresholds.high + 1, cw, base)).toBe("compact");
		expect(classifyCompactionPhase(thresholds.force - 1, cw, base)).toBe("compact");
		expect(classifyCompactionPhase(thresholds.force, cw, base)).toBe("force");
	});

	it("returns none when compaction is disabled or off", () => {
		const cw = 200_000;
		expect(classifyCompactionPhase(cw, cw, { ...base, enabled: false })).toBe("none");
		expect(classifyCompactionPhase(cw, cw, { ...base, strategy: "off" })).toBe("none");
	});

	it("scales phases with the model context window (adaptive per model)", () => {
		// A 32k model and a 1M model get proportionally identical phase layouts.
		const small = resolveGraduatedThresholds(32_000, { ...base, keepRecentTokens: 4000 });
		const large = resolveGraduatedThresholds(1_000_000, base);
		const ratio = (t: { soft: number; snip: number; high: number }) => ({
			soft: t.soft / t.high,
			snip: t.snip / t.high,
		});
		const smallRatios = ratio(small);
		const largeRatios = ratio(large);
		expect(Math.abs(smallRatios.soft - largeRatios.soft)).toBeLessThan(0.01);
		expect(Math.abs(smallRatios.snip - largeRatios.snip)).toBeLessThan(0.01);
	});
});

describe("percent threshold math", () => {
	it("resolves the percent threshold as a fraction of the window", () => {
		// 80% of 200k = 160k; 80% of 30k = 24k. The graduated phases derive
		// from this value, so the whole pipeline scales with the model window.
		expect(resolveThresholdTokens(200_000, base)).toBe(160_000);
		expect(resolveThresholdTokens(30_000, base)).toBe(24_000);
	});
});

describe("mode=none provider still reaches compact/force on overflow (regression guard)", () => {
	// A cache-less provider (Bedrock NO_EXPLICIT_CHECKPOINTS -> profile.mode="none")
	// must still be protected from context overflow. classifyCompactionPhase reads
	// enabled/strategy/window/thresholds, NOT profile.mode, so at/above the high
	// threshold it returns compact/force regardless of mode. This pins the
	// precondition the maintenance code relies on: if anyone adds an early
	// `if (cacheProfile.mode === "none") return COMPACTION_CHECK_NONE` at the top
	// of checkCompaction (a plausible "tidy" — no cache, so skip the graduated
	// logic), compact/force would stop firing for opt-out providers and they
	// would crash on overflow instead of compacting. The "cache intact" notice
	// text for soft/snip is separately suppressed for mode=none in
	// session-maintenance (that banner would be a lie with no cache), but that
	// suppression is scoped to the notice INSIDE the soft/snip branches and must
	// NOT be promoted to a whole-phase early return.
	const noCache = {
		mode: "none",
		readDiscount: 0,
		writeCostRatio: 0,
		cacheTtlMs: 10 * 60_000,
		minimumTokens: 1024,
	} satisfies ProviderCacheProfile;
	const cw = 200_000;
	const thresholds = resolveGraduatedThresholds(cw, base, noCache);
	expect(classifyCompactionPhase(thresholds.high + 1, cw, base, noCache)).toBe("compact");
	expect(classifyCompactionPhase(thresholds.force, cw, base, noCache)).toBe("force");
});
