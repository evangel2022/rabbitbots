# RabbitBots Phase M1 — Baseline and Minimal Architecture

Status: baseline inspected; no destructive conflict found. Implementation proceeds additively.

## 1. Actual Git baseline

| Item | Value |
| --- | --- |
| Repository | `/home/root1/workspaces/RabbitBots` |
| Branch | `main` |
| HEAD | `6c7e1bcc6a44156295b01d4af32d1c1ddcec5418` |
| `git status --short` | **110 paths** — 87 modified, 23 untracked |
| Commit / push | none |
| `.env` | not read for output, not modified |

The dirty state includes the unreleased Phase 1B/1C/1D/1E/1F work. It is preserved. The only files
M1 will change are additive meeting files plus the smallest required router/schema/nav/message-view
touch points.

## 2. Runtime and data baseline

- Web/API/Supervisor are reachable at `127.0.0.1:5173`, `:3100`, `:7091`.
- PostgreSQL `rakazo-dev-postgres` is reachable through the branch database `rakazo_main_0d6e4079`.
- The seeded demo account has CEO Assistant, Research Bot and Finance Bot with real thread/run
  history. M1 will reuse those Bot rows; it will not create duplicate Bots.
- Existing `Task`, `Run`, `Thread`, `Message`, `Event`, `Bot` and `Orchestration` models are the
  execution trace to reuse. M1 is additive: no existing table is rewritten.

## 3. Relevant existing source

### Data / runtime

- `packages/db/prisma/schema.prisma` — Space/Bot/Thread/Task/Run/Message/Event/Orchestration models;
  migrations live under `packages/db/prisma/migrations`.
- `packages/adapters/src/executor.ts` — Pi run execution, history and bot reply persistence.
- `packages/adapters/src/bot-messages.ts` — real bot-to-bot delivery and child run creation.
- `packages/adapters/src/orchestration.ts`, `orchestration-start.ts` — the Phase 1C parallel/Join
  implementation; not modified by M1.
- `apps/worker/src/index.ts` and `packages/adapters/src/background-job-handlers.ts` — durable worker
  and `run.continue` job path.
- `packages/adapter-kit/src/background-jobs.ts` — `runContinueJob` and job validation.

### API

- `apps/api/src/router.ts` and `apps/api/src/routes/context.ts` — oRPC composition and `authed`
  procedures with `context.actor.spaceId` / `userId`.
- `apps/api/src/routes/orchestrations.ts` — closest view/status pattern.
- `apps/api/src/routes/threads.ts`, `thread-target.ts` — real run creation/enqueue patterns.

### Web

- `apps/web/src/pages/Shell.tsx` — three-column application and chat/route integration.
- `apps/web/src/pages/shell/orchestration-strip.tsx` and its tests — status representation and child
  navigation.
- `apps/web/src/pages/Board.tsx` — a full-page list/detail route using the existing UI primitives.
- `apps/web/src/components/SidebarFooter.tsx` / `apps/web/src/pages/shell/shell-sidebar.tsx` —
  existing navigation entry points.
- `apps/web/src/pages/Shell.tsx` / `message-view.tsx` — existing report reading and evidence style.

## 4. Reusable services and components

- Real Bot identities and their existing `Thread` rows.
- Existing Task/Run creation and `runContinueJob` queue path for real participant execution.
- `readRunOutcome` to collect a participant's actual final answer.
- Existing status components, `Button`, `Dialog`, `ChatMarkdown`, layout tokens and the
  side-panel/three-column visual language.
- Existing oRPC `authed` procedures and actor space scoping.
- Existing test conventions: Vitest unit tests and PostgreSQL tests with `VERIFY_DATABASE=1`.

## 5. Proposed minimal integration points

1. **New additive Prisma models** for Meeting, Agenda, Participant, Turn, Decision and ActionItem,
   with `spaceId` ownership and foreign keys to Space/Bot; one additive SQL migration.
2. **New Meeting Orchestrator service** in `packages/adapters/src/meetings.ts`:
   - controlled status transition function;
   - deterministic run creation with idempotent nonces;
   - one real chair opening run, real Research/Finance reporting runs, one bounded chair discussion
     run, one chair decision run;
   - strict max 2 rounds, one speaker turn per round, meeting deadline, duplicate protection and
     failure/timeout handling;
   - parse the chair's structured decision JSON, persist decisions/actions/minutes; invalid output
     gets one bounded retry and then a visible failed/deferred result, never invented approval.
3. **New oRPC meeting routes** scoped by `context.actor.spaceId`; `get` advances a meeting when safe,
   so refresh recovers persisted state.
4. **New Meetings page** under `/app/meetings`, with list, create dialog (Glean template), room
   transcript/roster/agenda/status, decisions/actions and summary. A footer navigation item links
   to it. The page uses its own three columns inside the existing visual system and does not touch
   the chat three-column behavior.
5. **Focused tests** for transitions, anti-debate limits, decision parsing/approval, plus regression
   tests for existing chat/orchestration.

## 6. Risks and controls

- **Long LLM turns**: the meeting uses a small number of bounded runs; the UI polls persisted state.
  A run that never terminates is marked timed out at the meeting deadline and the meeting proceeds
  or fails visibly. No unbounded retries.
- **Tenant isolation**: every query filters `spaceId` from `context.actor`; bot IDs/agenda IDs are
  verified in that space; the API returns 404/forbidden for out-of-space meetings.
- **Double execution**: deterministic run nonces (`meeting:<id>:<phase>:<participant>`) and unique
  constraints prevent duplicate runs/joins; `get` can advance a meeting repeatedly without creating
  duplicate turns.
- **Chat pollution**: meeting participant runs use the participants' existing bot threads, so their
  textual output is traceable in those chats. The Meeting Turn stores the meeting's copy; ordinary
  chat behavior is unchanged. A future hidden helper thread could isolate this fully.
- **Structured output fragility**: the chair decision prompt requests strict JSON; parsing is
  validated. A malformed output is retried once, then persisted as a failed meeting or deferred
  items, never silently converted into an approval.
- **Authority**: no external side effect is executed by M1. Approval-required decisions are stored as
  `pending` human approval; CEO output is a recommendation, not a human approval.
- **Schema migration**: additive only, no reset; applied through the repository migration mechanism.

## 7. Scope boundary

M1 will not modify Pi Agent Runtime, Computer Runtime, Phase 1C orchestration or the existing Investor
Demo flow. It will reuse the actual Bot identities and execution infrastructure. The smallest
end-to-end vertical slice is:

`create meeting -> chair opening -> Research/Finance reporting -> bounded chair discussion -> structured decision -> minutes/actions -> completed`.
