/**
 * Prefix-shape diagnostics for provider prompt-cache reuse.
 *
 * Ported from Reasonix `internal/agent/cache_shape.go`: hash the portions of
 * the request prefix that influence provider-side prompt-cache reuse, compare
 * snapshots across model calls, and explain *why* a cache miss happened.
 *
 * The provider caches the request prefix byte-for-byte. Appending messages
 * grows the tail without breaking the cached head; rewriting history
 * (compaction, in-place pruning, mid-turn injection) or changing the
 * system prompt / tool schemas invalidates it. These hashes turn an opaque
 * "cacheRead collapsed to zero" into a named cause.
 */

import type { Tool } from "@oh-my-pi/pi-ai";

/** Hashed snapshot of the cache-relevant request prefix. */
export interface PrefixShape {
	systemHash: string;
	toolsHash: string;
	messagesHash: string;
	/**
	 * The mutation-sequence value at which `messagesHash` was last computed
	 * fresh (not carried). A carry is only valid while the live sequence
	 * still equals this — any rewrite/prune/pop between the fresh compute
	 * and the next capture bumps the sequence, breaks the equality, and
	 * forces a fresh hash so a mid-turn rewrite can never ride a stale
	 * carried hash into a false-negative miss marker.
	 */
	messagesFreshSeq: number;
}

/** What changed between two prefix snapshots. */
export interface PrefixDiagnostics {
	/** True when any cache-relevant prefix component changed. */
	prefixChanged: boolean;
	/** Named causes, in evaluation order: system → tools → messages. */
	reasons: Array<"system" | "tools" | "messages">;
}

/**
 * FNV-1a over a string, rendered as 8 hex chars. Collision-resistant enough
 * for change detection within one session (the comparison is same-process,
 * same-lifetime); deliberately not cryptographic.
 */
export function fnv1aHex(input: string): string {
	return (fnv1aString(input, 0x811c9dc5) >>> 0).toString(16).padStart(8, "0");
}

/**
 * Feed one string into a running FNV-1a accumulator and return the new state.
 * Lets us hash a sequence of values (the messages array, the tools array) by
 * streaming each element's serialization into ONE accumulator instead of
 * building a single giant `JSON.stringify(wholeArray)` string. Peak allocation
 * drops from O(entire context) to O(largest single element) — the context can
 * be hundreds of KB and this runs on the hot pre-model-call path every turn.
 */
function fnv1aString(input: string, seed: number): number {
	let hash = seed;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash;
}

/**
 * Hash a sequence by streaming each mapped element's JSON into one FNV
 * accumulator. Order-sensitive, so a rewrite-in-place (same length, changed
 * middle) still moves the hash — which is exactly the churn we must catch.
 * No concatenation of the whole sequence: peak allocation is one element.
 */
function hashSequence<T>(items: readonly T[], map: (item: T) => unknown): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < items.length; i++) {
		hash = fnv1aString(JSON.stringify(map(items[i])), hash);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Capture the prefix shape about to be sent to the model. Call from the
 * pre-model-call context sync so the hashes describe exactly what the
 * provider sees.
 *
 * The tools hash covers name + schema only: description prose changes are
 * cheap and provider-tolerated, while schema changes force a miss. Each
 * component is hashed by streaming its elements so we never allocate one
 * string the size of the whole context.
 */
export function capturePrefixShape(
	systemPrompt: readonly string[],
	tools: readonly Pick<Tool, "name" | "parameters">[],
	messages: readonly unknown[],
	/**
	 * The live mutation sequence at this capture. Recorded verbatim as
	 * `messagesFreshSeq` when the hash is computed fresh; carried through
	 * unchanged (via `carryMessagesHash`) when the caller proves the prefix
	 * is append-only. See {@link PrefixShape.messagesFreshSeq}.
	 */
	messagesFreshSeq: number,
	/**
	 * Optional pre-computed messages hash to reuse instead of re-hashing the
	 * whole context. This is a CORRECTNESS contract, not just an optimisation:
	 * `diffPrefixShape` compares the messages hash directly, so a pure
	 * tail-append (which leaves the cached prefix intact) MUST carry the
	 * previous hash verbatim or it will be misreported as a rewrite. The
	 * caller proves append-only by checking the previous shape's
	 * `messagesFreshSeq` against the live sequence; any rewrite/prune/pop
	 * breaks that equality, the caller omits the carry, and the hash is
	 * computed fresh so the churn is caught. On the carried path this also
	 * skips the O(context-bytes) hash.
	 */
	carryMessagesHash?: string,
): PrefixShape {
	return {
		systemHash: hashSequence(systemPrompt, (block) => block),
		toolsHash: hashSequence(tools, (tool) => ({ name: tool.name, parameters: tool.parameters ?? null })),
		messagesHash: carryMessagesHash ?? hashSequence(messages, (message) => message),
		messagesFreshSeq,
	};
}

/**
 * Diff two prefix snapshots into named churn reasons by comparing each
 * component hash directly. The messages hash is compared as-is: a pure
 * append is NOT flagged because the caller carries the previous hash on
 * append-only steps (see `capturePrefixShape`'s carry contract), so the
 * two snapshots agree. A rewrite, prune, or pop that the caller did not
 * carry through produces a fresh, different hash and is reported. This
 * keeps the miss marker honest even for prune-then-grow sequences where a
 * message-count heuristic would silently miss the broken middle.
 */
export function diffPrefixShape(prev: PrefixShape | undefined, cur: PrefixShape): PrefixDiagnostics {
	if (!prev) return { prefixChanged: false, reasons: [] };
	const reasons: PrefixDiagnostics["reasons"] = [];
	if (prev.systemHash !== cur.systemHash) reasons.push("system");
	if (prev.toolsHash !== cur.toolsHash) reasons.push("tools");
	if (prev.messagesHash !== cur.messagesHash) reasons.push("messages");
	return { prefixChanged: reasons.length > 0, reasons };
}

/**
 * Decide whether the previous messages hash may be carried into the next
 * capture, returning it when safe and `undefined` otherwise. Pure so the
 * carry invariant is unit-testable in isolation from the agent.
 *
 * A carry is safe exactly when the live mutation sequence still equals the
 * sequence stamped on the previous shape's fresh hash (`messagesFreshSeq`):
 * that proves no rewrite/prune/pop has touched the history since the hash
 * was computed, so the carried hash still describes the cached prefix. The
 * common append-only step leaves the sequence untouched (append does not
 * bump it) and the prefix is intact, so the carry both skips the
 * O(context-bytes) rehash AND keeps `diffPrefixShape` honest. Any
 * non-append mutation bumps the sequence, the equality breaks, and we
 * return `undefined` so the hash is recomputed and the churn is reported —
 * including the mid-turn rewrite case that a "compare against the seq at
 * last diff" heuristic would miss.
 */
export function resolveCarryMessagesHash(
	previousShape: PrefixShape | undefined,
	liveMutationSeq: number,
): string | undefined {
	if (!previousShape) return undefined;
	return previousShape.messagesFreshSeq === liveMutationSeq ? previousShape.messagesHash : undefined;
}
