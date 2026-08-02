# nikoflow_record_tdd

> Records machine-checkable, gate-bound RED, GREEN, or no-runtime-waiver evidence for the active Nikoflow Execute ticket.

## Source
- Entry: `packages/coding-agent/src/tools/nikoflow-record-tdd.ts`
- Execute-phase instruction: `packages/coding-agent/src/nikoflow/prompts.ts`
- Key collaborators:
  - `packages/coding-agent/src/nikoflow/tickets.ts` — defines, validates, and rebinds TDD evidence.
  - `packages/coding-agent/src/session/agent-session.ts` — correlates submitted evidence with authoritative completed Bash runs and current ticket/gate state.
  - `packages/coding-agent/src/nikoflow/mode.ts` — keeps the Execute gate closed until the active ticket has valid evidence.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `stage` | `"red" \| "green" \| "waiver"` | Yes | TDD obligation being recorded. |
| `ticket_id` | `string` | Yes | Active Nikoflow ticket id. |
| `gate_id` | `string` | Yes | Current Execute gate id from `nikoflow-context`. |
| `command` | `string` | RED/GREEN | Exact focused test command observed through Bash. |
| `exit_code` | `integer` | RED/GREEN | Observed Bash exit code: non-zero for RED and zero for GREEN. |
| `expected_failure` | `string` | RED | Expected pre-change behavioral failure demonstrated by RED. |
| `reason` | `string` | Waiver | Justification for a ticket with no runtime surface. |

## Outputs
- `content`: one text part saying whether evidence was recorded or rejected.
- `details`:
  - `evidence: NikoflowTddEvidence | null`
  - `stored: boolean`
  - `errors?: string[]`
- `isError: true` when validation fails; rejected calls do not replace valid evidence.

## Validation
- Ticket and gate ids must match the active Execute state.
- RED must match a completed, non-zero Bash run after the current gate was minted.
- GREEN must match a later completed, zero-exit Bash run for the same focused command and ticket.
- RED must be recorded before GREEN.
- A waiver is accepted only with a non-empty reason and replaces RED/GREEN evidence for that ticket.
- Rotating an Execute review gate retains RED but intentionally clears GREEN; rerun the previous GREEN command once under the new gate before review resumes.

## Flow
1. The tool normalizes the structured stage payload.
2. `AgentSession.recordNikoflowTddEvidence(...)` verifies active ticket/gate identity and correlates RED/GREEN with observed Bash results.
3. Valid evidence is stored in Nikoflow mode state and updates the ticket status (`red` or `green`).
4. Invalid or stale evidence returns explicit errors and leaves the gate closed.

## Side Effects
- Mutates only in-memory Nikoflow TDD evidence and ticket status, then persists the updated Nikoflow ticket DAG when applicable.
- Does not execute tests itself, write source files, or call external services.
