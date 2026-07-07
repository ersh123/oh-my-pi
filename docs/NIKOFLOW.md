# Nikoflow — trustworthy coding with cheap models

Nikoflow is a **phase-gated methodology mode** for the oh-my-pi coding agent. It lets **cheap
models** (DeepSeek, GLM, MiniMax, Qwen — whatever your subscription has) produce
production-grade output by keeping them on rails set by a **stronger architect model**, and by
putting a **binding review gate the coding model cannot approve for itself**.

> One line: *a strong model plans and reviews, a cheap model writes, and the cheap model can
> never sign off on its own work.*

This document is the entry point. For depth see:
`NIKOFLOW-STATUS.md` (as-built architecture) · `NIKOFLOW-ROADMAP.md` (design rationale + audit
history) · `NIKOFLOW-IMPLEMENTATION.md` (build spec).

---

## The problem it solves

Cheap models are cheap for a reason: on a real task they drift off the spec, skip edge cases,
declare success on broken code, and — worst of all — **grade their own homework**. Hand one a
vague task and it will confidently ship something wrong.

Nikoflow fixes this by separating the work into roles a single cheap model would otherwise
conflate:

- **Deciding what to build** (scope, architecture, acceptance criteria) — hard reasoning →
  a **strong architect** model.
- **Writing the code** — mechanical → a **cheap executor** model.
- **Judging whether it's correct** — must be independent → a **strong reviewer**, and the
  executor's own claims never count.

The result: you pay cheap-model prices for the bulk of the work while a strong model owns the
judgment calls, and a structural gate stops the cheap model from waving through its own bugs.

---

## Quickstart

Three equivalent ways to start it:

```bash
# 1. In an omp chat, just type the keyword + your task:
никофлоу:standard добавь функцию X с тестами
nikoflow:deep build me a mobile web UI for the CLI

# 2. As a shell command:
omp nikoflow:standard "add function X with tests"

# 3. With explicit model flags (skips the model picker):
omp nikoflow:standard --architect=<strong> --exec=<cheap> --qa=<strong> "task"

# Run unattended (no human at the gates):
omp nikoflow:deep --batch "build a small todo CLI"
```

When you start without model flags, nikoflow **asks you which model to put on each role** from
the models your subscription has (a picker), then begins.

Depth tiers:

| Tier | Phases | Use for |
|---|---|---|
| `tactical` | Grilling → Execute → Verify | small change, one file |
| `standard` | + ADR → PRD → Ticketization + per-ticket loop | a feature, several files |
| `deep`     | same as standard (reserved for future divergence) | large work |

---

## How it works

### Phases

```
Grilling → [ADR → PRD → Ticketization] → Execute → Verify
```

- **Grilling** — the architect interrogates you (or, in `--batch`, records explicit
  assumptions) until the scope, risks, and acceptance criteria are pinned down. It cannot exit
  until it has no open questions.
- **ADR / PRD / Ticketization** (standard/deep) — the architect records the decisions, writes
  the requirements, and decomposes the work into a validated **ticket DAG**.
- **Execute** — the cheap executor implements, **one ticket at a time**. It has no write access
  before the tickets are approved, so it can't just do everything at once.
- **Verify** — an independent review of the finished work.

### Capability rails (per-phase model roles)

Each phase runs on the role suited to it:

| Flag | Role | Owns | Should be |
|---|---|---|---|
| `--architect` | `modelRoles.plan` | Grilling, ADR, PRD, Ticketization | strong |
| `--exec` | `modelRoles.default` | Execute | cheap |
| `--qa` | `modelRoles.advisor` | Verify + per-ticket review | strong |

Nikoflow **fails fast** at start if the architect resolves to the same model as the executor
(or if the reviewer is unset / equals the executor) — an independent review is the whole point.
The code is fully **model-agnostic**: no model names are hardcoded; roles resolve through
`modelRoles`, so any subscription's models work.

### The binding gate — you can't approve your own work

This is the core guarantee. A gate advances only via an **independent signal**, never the
coding model's own say-so:

- **Human gates** (Grilling / ADR / PRD / Ticketization) advance only on a real user turn that
  happens *after* the gate is opened.
- **Verify and per-ticket gates** are satisfied only by an independent verdict from oh-my-pi's
  **native advisor** — a separate model with a harness-owned prompt. The executor's text,
  comments, or claims can never satisfy the gate.
- In `--batch` mode the advisor stands in for the human at every gate, so it runs unattended
  without becoming self-approving.

The advisor judges the **real** work: the review diff includes staged, committed, and untracked
changes (you can't hide work with `git add`/`stash`), an empty diff can never be approved, and
everything the coding model wrote is treated as untrusted data — an injected "approve me" in a
code comment is ignored.

---

## Features

- **Interactive model picker** — pick which model plays each role from your available models,
  with cost/context shown, or pass `--architect/--exec/--qa` to skip it.
- **In-chat keyword** — `никофлоу <task>` / `nikoflow <task>` activates the mode from a running
  chat (and won't reset an already-running flow).
- **Thin-context triage** — on an empty repo with a vague task it asks: *deep interview* (build
  the spec from nothing) or *short brief* (a few questions, then go). On a real repo it stays
  out of your way.
- **Autonomous `--batch`** — the whole pipeline runs without a human; the advisor gates every
  phase.
- **Role-model recovery** — if a role's model hits a quota / auth / rate-limit failure that the
  normal retry can't clear, nikoflow offers to switch that role to another available model (or
  auto-switches in batch) and resumes where it left off — without weakening the review gate.

---

## Security model (anti-self-approval)

The property nikoflow guarantees: **the coding model cannot advance any gate without the
required independent signal.** It has been hardened through a full code review and a 5-model
adversarial review (Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5, GPT-5.5), which found and closed
real bypasses:

- the coding model is never told the gate id (it can't forge a verdict carrying it);
- the reviewer prompt escapes and distrusts all model-authored content (no prompt injection);
- the reviewer grades against the **original user task**, not just model-written acceptance;
- an empty / hidden diff can't be approved; a non-committal reviewer note holds, never passes;
- the review can't deadlock (fresh attempts on a genuine fix), and role-recovery can't collapse
  executor==reviewer or route around a refusal.

Property-based tests (36k+ assertions) exercise these invariants. See `NIKOFLOW-STATUS.md` for
the per-fix detail.

---

## Configuration

Roles come from CLI flags, the interactive picker, or your config's `modelRoles`
(`~/.omp/agent/config.yml`):

```yaml
modelRoles:
  plan:    deepseek/deepseek-v4-pro      # architect (strong)
  default: freeinference/minimax-m3      # executor (cheap)
  advisor: freeinference/glm-5.1         # reviewer (strong)
```

With all three set, the picker is skipped and nikoflow uses them directly. List your models
with `omp models`.

> Non-Anthropic providers may need the Anthropic-only proxy unset (`env -u HTTP_PROXY
> -u HTTPS_PROXY ...`) if you route Anthropic traffic through one.

---

## Building & installing (from this fork)

Nikoflow lives in this fork (`packages/coding-agent/src/nikoflow/`), not yet in a released
`omp`. To run it:

```bash
# run the dev CLI directly
bun --cwd=packages/coding-agent src/cli.ts nikoflow:standard "task"

# or build a binary and use it as your omp
cd packages/coding-agent && bun scripts/build-binary.ts
cp dist/omp ~/.local/bin/omp        # (use mv if the file is busy)
```

Config lives in `~/.omp/` and is unchanged by the swap, so auth and models keep working.

Tests: `bun test packages/coding-agent/src/nikoflow/`.

---

## Status & honest limits

Proven live on cheap Chinese models at **$0.05–0.09/task**: tactical, standard (per-ticket),
a 4-module CLI, and a fully autonomous `--batch` run. The advisor has caught real spec
violations (e.g. a wrong `truncate` edge case against the ADR/PRD).

Not yet covered: verified live only on DeepSeek/GLM/MiniMax (code is model-agnostic, others
untested); not exercised at 15+ file scale; a couple of narrow silent-path escalations are
follow-ups. See `NIKOFLOW-STATUS.md` → *Honest limitations*.
