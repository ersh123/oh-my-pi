# nikoflow_grilling_converged

> Records that Nikoflow Grilling has converged through a structured tool call.

## Source
- Entry: `packages/coding-agent/src/tools/nikoflow-grilling-converged.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/nikoflow-grilling-converged.md`
- Key collaborators:
  - `packages/coding-agent/src/nikoflow/gates.ts` — normalizes the convergence payload.
  - `packages/coding-agent/src/nikoflow/mode.ts` — advances the Grilling gate only from this tool result with no open questions.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `open_questions` | `string[]` | Yes | Material questions that remain unresolved. Must be empty for convergence. |
| `assumptions` | `string[]` | Yes | Explicit assumptions made to close Grilling. |
| `risks` | `string[]` | Yes | Known risks remaining after Grilling. |

## Outputs
- `content`: one text part saying whether convergence was recorded or rejected.
- `details`:
  - `openQuestions: string[]`
  - `assumptions: string[]`
  - `risks: string[]`
  - `accepted: boolean`
- `isError: true` when `open_questions` is non-empty.

## Flow
1. The tool receives structured Grilling convergence data.
2. Empty `open_questions` returns an accepted result.
3. Non-empty `open_questions` returns an error result; the Nikoflow Grilling gate stays closed.

## Side Effects
- No file writes.
- No external calls.
- Does not mutate session state directly; the Nikoflow gate reads the structured tool result.
