# nikoflow_define_tickets

> Captures the Nikoflow Ticketization DAG from a structured tool call and stores it in executable mode state.

## Source
- Entry: `packages/coding-agent/src/tools/nikoflow-define-tickets.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/nikoflow-define-tickets.md`
- Key collaborators:
  - `packages/coding-agent/src/nikoflow/tickets.ts` — normalizes ticket payloads and validates the DAG.
  - `packages/coding-agent/src/nikoflow/mode.ts` — blocks Ticketization/Execute gates when the DAG is missing or invalid.
  - `packages/coding-agent/src/session/agent-session.ts` — writes `state.tickets` and persists a source-tagged todo mirror.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tickets` | `{ id: string; acceptance: string[]; blocked_by: string[]; implementation_notes: string }[]` | Yes | Complete executable ticket DAG for standard/deep Nikoflow execution. |

Each ticket is normalized into `NikoflowTicket` with status `todo`. Empty ids, empty acceptance, empty implementation notes, duplicate ids, unknown dependencies, and dependency cycles are rejected.

## Outputs
- `content`: one text part saying whether the DAG was captured or rejected.
- `details`:
  - `tickets: NikoflowTicket[]`
  - `stored: boolean`
  - `errors?: string[]`
- `isError: true` when validation fails; failed calls do not mutate state.

## Flow
1. `NikoflowDefineTicketsTool.execute(...)` receives structured `tickets`.
2. The session handler calls `normalizeDefinedTickets(...)`.
3. On success, `AgentSession.defineNikoflowTickets(...)` writes `state.tickets`, clears any pending forced define-ticket choice, and persists a source-tagged `user_todo_edit` mirror for durability/UI.
4. On failure, the tool returns a clear rejection message and leaves existing Nikoflow state untouched.

## Side Effects
- Mutates only in-memory Nikoflow mode state and session todo state.
- Appends a `user_todo_edit` custom entry with `source: "nikoflow_define_tickets"`.
- Does not write files or call external services.
