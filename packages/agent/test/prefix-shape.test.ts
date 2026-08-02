import { describe, expect, it } from "bun:test";
import {
	capturePrefixShape,
	diffPrefixShape,
	fnv1aHex,
	resolveCarryMessagesHash,
} from "@oh-my-pi/pi-agent-core/prefix-shape";

// `messagesFreshSeq` is the live mutation counter the agent threads through.
// In these unit tests there is no real agent, so we model it explicitly: a
// constant seq means "no rewrite happened", a bumped seq means "a rewrite
// happened between captures". The diff itself never reads the seq — it only
// compares hashes — so the seq's only job is to gate the carry decision in
// resolveCarryMessagesHash, exactly as in production.
const SEQ = 0;

describe("prefix-shape diagnostics", () => {
	it("fnv1aHex is deterministic and 8 chars", () => {
		expect(fnv1aHex("hello")).toBe(fnv1aHex("hello"));
		expect(fnv1aHex("hello")).not.toBe(fnv1aHex("world"));
		expect(fnv1aHex("")).toHaveLength(8);
	});

	it("reports no change on the first capture", () => {
		const shape = capturePrefixShape(["sys"], [], [{ role: "user" }], SEQ);
		expect(diffPrefixShape(undefined, shape)).toEqual({ prefixChanged: false, reasons: [] });
	});

	it("detects a system prompt change", () => {
		const a = capturePrefixShape(["sys v1"], [], [{ role: "user" }], SEQ);
		const b = capturePrefixShape(["sys v2"], [], [{ role: "user" }], SEQ);
		const diag = diffPrefixShape(a, b);
		expect(diag.prefixChanged).toBe(true);
		expect(diag.reasons).toContain("system");
		expect(diag.reasons).not.toContain("tools");
	});

	it("detects a tool schema change", () => {
		const toolA = { name: "read", parameters: { type: "object", properties: { path: {} } } };
		const toolB = { name: "read", parameters: { type: "object", properties: { path: {}, sel: {} } } };
		const a = capturePrefixShape(["sys"], [toolA], [{ role: "user" }], SEQ);
		const b = capturePrefixShape(["sys"], [toolB], [{ role: "user" }], SEQ);
		const diag = diffPrefixShape(a, b);
		expect(diag.reasons).toEqual(["tools"]);
	});

	it("does NOT flag a plain message append when caller carries the hash", () => {
		// The carry contract: diff compares messagesHash directly, so a pure
		// append is only invisible when the caller carries the previous hash
		// (proving append-only via an unchanged mutation sequence).
		const a = capturePrefixShape(["sys"], [], [{ role: "user", content: "hi" }], SEQ);
		const b = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "yo" },
			],
			SEQ,
			a.messagesHash, // seq unchanged → carry valid
		);
		expect(diffPrefixShape(a, b).reasons).toEqual([]);
	});

	it("flags append WITHOUT carry as messages churn (regression guard)", () => {
		// If the caller omits the carry, the hash is computed fresh and
		// differs from the previous one, so the append is reported. This is
		// intentional: omitting the carry means "I did not verify append-only,
		// compute fresh" — which flags any change including append.
		const a = capturePrefixShape(["sys"], [], [{ role: "user", content: "hi" }], SEQ);
		const b = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "yo" },
			],
			SEQ,
		);
		expect(diffPrefixShape(a, b).reasons).toContain("messages");
	});

	it("flags a history rewrite (compaction / pruning) as messages churn", () => {
		const a = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
			],
			SEQ,
		);
		// Compaction collapses three messages into a summary: count shrank,
		// content changed → the cached prefix is dead. No carry (seq bumped).
		const b = capturePrefixShape(["sys"], [], [{ role: "user", content: "summary of one/two/three" }], SEQ + 1);
		const diag = diffPrefixShape(a, b);
		expect(diag.reasons).toContain("messages");
	});

	it("reports multiple simultaneous causes in evaluation order", () => {
		const a = capturePrefixShape(["sys"], [{ name: "t", parameters: {} }], [{ role: "user" }], SEQ);
		const b = capturePrefixShape(["sys2"], [{ name: "t2", parameters: {} }], [{ role: "summary" }], SEQ + 1);
		expect(diffPrefixShape(a, b).reasons).toEqual(["system", "tools", "messages"]);
	});

	it("flags a same-length in-place rewrite (pruning / mid-turn injection)", () => {
		// Three messages before and after — count identical, so only the
		// order-sensitive streaming hash catches the mutated middle.
		const a = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "three" },
			],
			SEQ,
		);
		const b = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "one" },
				{ role: "assistant", content: "PRUNED" },
				{ role: "user", content: "three" },
			],
			SEQ + 1,
		);
		const diag = diffPrefixShape(a, b);
		expect(diag.reasons).toContain("messages");
	});

	it("does NOT flag identical messages (deterministic hash)", () => {
		const msgs = [{ role: "user", content: "same" }];
		const a = capturePrefixShape(["sys"], [], msgs, SEQ);
		const b = capturePrefixShape(["sys"], [], msgs, SEQ);
		expect(diffPrefixShape(a, b).reasons).toEqual([]);
	});
});

describe("resolveCarryMessagesHash (carry invariant)", () => {
	it("returns undefined on the first capture (no previous shape)", () => {
		expect(resolveCarryMessagesHash(undefined, 0)).toBeUndefined();
	});

	it("carries when the live sequence still equals the fresh sequence (append-only)", () => {
		const shape = capturePrefixShape(["sys"], [], [{ role: "user" }], 7);
		// No rewrite since seq 7 → the hash is still a faithful description of
		// the cached prefix, so carrying it is both correct and O(1).
		expect(resolveCarryMessagesHash(shape, 7)).toBe(shape.messagesHash);
	});

	it("refuses to carry after ANY non-append mutation bumped the sequence", () => {
		const shape = capturePrefixShape(["sys"], [], [{ role: "user" }], 7);
		// A rewrite/prune/pop happened (seq 7 → 8). Carrying the stale hash
		// would hide the broken prefix → false-negative miss marker. Refuse.
		expect(resolveCarryMessagesHash(shape, 8)).toBeUndefined();
	});

	it("refuses to carry on the mid-turn rewrite case the old heuristic missed", () => {
		// Regression for the v3 atLastCapture bug: a rewrite that lands
		// BETWEEN a capture and its diff used to be masked because the diff
		// re-stamped the seq. With the fresh-seq stamped on the shape itself,
		// the next capture sees live(8) !== fresh(7) and recomputes.
		const beforeRewrite = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
			],
			7,
		);
		// Mid-turn compact rewrites the history; the agent bumps seq to 8.
		// The carry decision at the next sync must NOT reuse beforeRewrite's
		// hash even though "the last diff also saw seq 8" — the shape's own
		// fresh seq (7) is the authority, and 7 !== 8.
		expect(resolveCarryMessagesHash(beforeRewrite, 8)).toBeUndefined();
	});

	it("chains carries across many append-only turns", () => {
		// Turn 1: fresh hash at seq 3.
		const t1 = capturePrefixShape(["sys"], [], [{ role: "user", content: "u1" }], 3);
		// Turn 2: append-only, seq still 3 → carry t1's hash, fresh seq stays 3.
		const t2 = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "u1" },
				{ role: "assistant", content: "a1" },
			],
			3,
			resolveCarryMessagesHash(t1, 3),
		);
		expect(t2.messagesHash).toBe(t1.messagesHash);
		expect(t2.messagesFreshSeq).toBe(3);
		// Turn 3: still append-only, seq still 3 → carry t2's (== t1's) hash.
		const t3 = capturePrefixShape(
			["sys"],
			[],
			[
				{ role: "user", content: "u1" },
				{ role: "assistant", content: "a1" },
				{ role: "user", content: "u2" },
			],
			3,
			resolveCarryMessagesHash(t2, 3),
		);
		expect(t3.messagesHash).toBe(t1.messagesHash);
		// A diff against t1 sees identical hashes → no false "messages" churn.
		expect(diffPrefixShape(t1, t3).reasons).toEqual([]);
	});
});
