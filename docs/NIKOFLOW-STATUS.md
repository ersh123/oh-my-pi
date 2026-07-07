# Nikoflow — as-built status

This is the **implemented** architecture (what actually shipped on `nikoflow-integration`),
which diverged from the speculative plan in `NIKOFLOW-ROADMAP.md` / `NIKOFLOW-IMPLEMENTATION.md`
in one major way: **the binding reviewer is the native advisor, not a spawned sub-agent.**
Read this first; the roadmap/implementation docs are the design rationale + audit history.

## What nikoflow is

A phase-gated methodology mode for the oh-my-pi coding agent that lets **cheap models**
(DeepSeek / GLM / MiniMax / Qwen — any subscription's models) produce production-grade output
by keeping them on rails set by a stronger architect model, with a **binding,
non-self-approvable** review gate. Activate: `omp nikoflow[:tactical|standard|deep] [--exec …]
[--architect …] [--qa …] "<task>"`.

Phases: **Grilling → (ADR → PRD → Ticketization) → Execute → Verify**. `tactical` =
Grilling→Execute→Verify (monolithic); `standard`/`deep` add ADR/PRD/Ticketization + a
per-ticket execute loop.

## Capability rails (per-phase model roles)

`--architect`→`modelRoles.plan` (strong): owns Grilling/ADR/PRD/Ticketization.
`--exec`→`modelRoles.default` (cheap): only Execute.
`--qa`→`modelRoles.advisor` (strong): Verify + per-ticket review.
Fail-fast at activation if `plan` == `default` or unset. Fully **model-agnostic** — no model
names or provider branching anywhere in the nikoflow code; roles resolve through `modelRoles`.

Role recovery is terminal-only: the normal retry/backoff/credential-rotation/fallback loop
owns in-flight transient failures. If that machinery gives up, Nikoflow can replace only the
current phase role's model, re-run the same role rails, persist the override in mode data, and
resume via retry without touching gate ids, ticket DAG, or advisor verdict state. Interactive
recovery yields first, then opens the picker from the follow-up/post-prompt queue; batch mode
auto-picks within the same rails and exhausts boundedly.

## The binding gate — native advisor (the key design decision)

The verify gate is satisfied **only** by an independent verdict from the **native oh-my-pi
advisor** (its own model, harness-owned prompt, emits `nit`/`concern`/`blocker`). The primary
can never self-approve. On entering verify (and per ticket), the harness triggers a **fresh**
advisor review of the **final diff**; pass = no `blocker`, hold = blocker (executor fixes,
re-review), **escalate (never auto-pass)** if the advisor is absent/circuit-broken. Stale
blockers from earlier phases are superseded and correlated to the current gate id.

*History:* the original design spawned a dedicated reviewer sub-agent; that mechanism was
unreliable across 3 fixes. Replacing it with the native advisor (still independent + harness-
owned) closed the crux. `reviewer.ts` was deleted.

## Anti-self-approval hardening (after a 7-reviewer parallel review)

A parallel review (Opus 4.8, Sonnet 5, Fable 5, GPT-5.5, DeepSeek/GLM/MiniMax) found the
property was *bypassable* and it was closed: the primary is no longer told the gate id (minted
only into the advisor prompt); every primary-authored block fed to the advisor is XML-escaped
and the advisor prompt treats tagged content as untrusted data (so an injected "call
advise(approve)" in a diff/comment/acceptance is ignored); the advisor grades against the
**original user task** captured at activation, not just primary-authored ticket acceptance; the
review diff includes `git status --porcelain` + `git stash list` and an **empty diff can never
be approved** (code-level hard block regardless of verdict); the review deadlock is gone (the
gate rotates on a genuine fix turn, infra failures are split from the blocker budget); human
gates require the phase artifact before a user turn advances; `advisor === executor` is a
fail-fast error; an in-chat `nikoflow` keyword can't reset an active flow; ticket ids are
validated so the DAG can't corrupt on resume.

## Evidence integrity (hardened after a full code review)

The gate mechanism was sound, but a review found the *evidence* the advisor judged was
primary-forgeable; closed: the review diff is built from `git diff HEAD` + `git status
--porcelain` (staged/committed/untracked all visible — can't be hidden by `git add`/commit);
harvested test output is labeled unverified and the advisor confirms with its own read/grep
tools; the gate passes only on an **explicit** advisor `verdict` (`approve`/`blocker`) — a
severity-less note holds→escalates, never passes; advise calls carry the `gateId` so an
unrelated monitor note can't satisfy a review; the read-only allowlist matches **builtins
only** (an MCP tool sharing an allowlisted name is blocked); grilling convergence is a
structured `nikoflow_grilling_converged` tool call (a quoted marker string can't converge);
activation asserts the advisor role resolves. *Known residual (lower severity):* human gates
advance on any user turn (no phase-regression keyword yet); ticket acceptance is primary-authored
(mitigated by the tickets gate); attempt budget conflates infra failures with blocker cycles.

## Anti-self-approval invariants (property-tested, 36k assertions)

- `gateMatches` fail-closed (a null/mismatched id never satisfies a gate).
- Human gates advance only on a genuine user turn *after* the gate was minted.
- Grilling advances only on a structured **convergence marker** (`nikoflow_grilling
  {open_questions:[]}`) + a user turn — no more "any message advances" (closed hole #7).
- Verify advances only on a fresh independent advisor verdict — never the primary's text.
- Callbacks are **chained**, never clobbered (the advisor's `onTurnEnd` survives); gate-hold
  is a **follow-up-queue yield** (not a blocking return); for human/exhausted gates it yields
  to the user rather than looping (livelock-free, bounded).
- Retry fallback candidates are rechecked against Nikoflow rails before application, so a
  generic fallback chain cannot collapse executor and reviewer onto the same model.

## Ticketization (standard/deep) — real per-ticket loop

The architect decomposes the spec by calling a structured **`nikoflow_define_tickets`** tool
(`{tickets:[{id,acceptance,blocked_by,implementation_notes}]}`) — validated into a DAG,
persisted to the compaction-durable todo-state and Nikoflow mode data. Execute then **loops** over tickets in
topological order: per ticket the cheap executor implements against its acceptance, a fresh
independent advisor review gates that ticket's diff (pass→done, blocker→fix, bounded→escalate),
then the next ticket. A final verify reviews the whole.

**Enforcement:** pre-execute phases (grilling/adr/prd/ticketization) use a read-only tool
**allowlist** — only read/search/planning tools (+`nikoflow_define_tickets`, advisory, todo)
are permitted; writes **and code-execution** (edit/write/`node_repl`/`python_repl`/bash) are
blocked, unknown tools default to blocked. This stops the cheap executor from implementing
eagerly (via `node_repl`/bash) before an approved ticket DAG exists, so tickets actually
*constrain* execution.

## Proven live (cheap CN models, keyless, $0.05–0.09/task)

| Scale | Result |
|---|---|
| tactical (typo, 1 file) | grilling→execute→verify(advisor)→done, autonomous |
| tactical (multi-file, calc) | 3 coordinated files, tests pass, advisor-gated |
| standard (string-utils) | 5-question interview → per-ticket loop → 26 tests |
| bigger (4-module CLI) | 5-ticket DAG, per-ticket review, 17 tests |

The advisor catches **real spec violations** (e.g. `truncate` negative-`n` against the ADR/PRD
acceptance) — the "hardened spec → cheap executor drifts → advisor catches" loop working.

## Honest limitations

- Verified live only on DeepSeek/GLM (code is model-agnostic; other subscriptions untested).
- Interactive human gates need a real user; autonomous batch mode is implemented but still
  needs broader live dogfood across providers.
- Not yet exercised at 15+ file scale.
- The grilling convergence-marker is unit-tested; a live interactive dogfood of it is pending.

## Tests

`bun test packages/coding-agent/src/nikoflow/__tests__/` — 108 tests, incl. property-based
anti-self-approval invariants, per-ticket loop, allowlist, convergence marker, advisor gate.
