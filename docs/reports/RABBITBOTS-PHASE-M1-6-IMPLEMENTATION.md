# RabbitBots Phase M1.6 — AI Workforce Operations Center

Status: **PASS** for the operations-center and immutable-attempt vertical slice, with the limitations
listed below.

RabbitBots now has an independent Workforce page that reads real Bot tasks, execution attempts,
results, evidence, source meetings/decisions and CEO acceptance from PostgreSQL. Re-execution creates
a new immutable attempt instead of overwriting the previous execution.

## 1. Git baseline and final state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **142 paths** — 97 modified, 45 untracked |
| Final | **147 paths** — 97 modified, 50 untracked |
| Commit / push | none |
| `.env` | not read, printed, modified or replaced |

The five added paths are the attempt migration, Workforce contracts/service/API/page. Existing M1.2,
M1.3-A, M1.3-B, M1.4 and M1.5 records and reports are preserved.

## 2. Migration

Applied `20261211210000_meeting_action_attempts`:

### `meeting_action_attempts`

- `id`, `meetingId`, `actionItemId`
- `attemptNumber`, unique per action
- `taskId`, `botRunId`
- `status`: RUNNING / COMPLETED / FAILED / BLOCKED
- `resultStatus`, `resultSummary`, `evidence`, `error`
- `startedAt`, `completedAt`, `createdAt`

Existing executed actions were backfilled with one attempt from their current Task/Run/result. New
executions create new rows. Older attempts are not overwritten by later re-execution.

## 3. Execution attempts and recovery

- `executeMeetingAction` creates an immutable attempt row before launching the Task/Run and points the
  action snapshot at that attempt.
- `meeting.action.reconcile` updates the **current** attempt with terminal result/evidence/error and
  the action snapshot.
- `acceptMeetingAction` only changes action acceptance fields; it never mutates attempt history or
  decision approval.
- `RE_EXECUTE` resets the current action pointer but leaves all prior attempts intact.
- `reconcileActiveMeetings` now also scans stale `IN_PROGRESS` actions with a Bot Run and enqueues
  action reconciliation, so a worker restart can recover an action that lost its queue delivery.
- FAILED/BLOCKED/PARTIAL runs never become COMPLETED automatically.

## 4. Workforce API and page

Read-only `workforce.overview` returns real database aggregates:

- **Bots**: name, role from meeting participation, WORKING/IDLE/BLOCKED, current task, completed
  today, failed today and latest execution time.
- **Tasks**: title, assignee (Bot or human owner), source meeting, decision/approval status,
  execution status, latest result, CEO acceptance, acceptance criteria, blocked reason, timestamps.
- **Attempts**: every task-attempt with attempt number, Task/Run IDs, status, result, summary,
  evidence, error and timestamps.
- **Acceptances**: actor, action, comment and time.
- **Operations summary**: OPEN, IN_PROGRESS, COMPLETED, BLOCKED, FAILED, PENDING_ACCEPTANCE.

The new `/app/workforce` page uses a three-column layout:

- Bot overview and current work.
- Task list with source meeting and latest result.
- Detail panel with task criteria, execution status, CEO controls, full attempt history, evidence and
  acceptance history.

A sidebar **AI Workforce** entry and a `/app/workforce` route were added. The Meeting Room and normal
Bot workspace were not rewritten.

The page provides Run/Retry, Accept, Request evidence, Re-run, Block, Cancel and Assign controls.
All operations call the server; the client does not trust local state.

## 5. Real acceptance evidence

The M1.5 execution meeting and its real Research/Finance actions were extended with a genuine Finance
re-execution, producing two immutable attempts:

**Meeting** `cmwdmmn7n00024at686gv4ujs`
**Decision** `cmwdmpy04001z23t6uovn7uf0` — APPROVED_WITH_CONDITIONS, conditions confirmed.

**Action with two attempts** `cmwdmqgye002f23t6m97jpstz`
“Keep the label of management-sourced evidence attached to both gated items” — Finance Bot.

| Attempt | Task | Run | Result | Summary |
| --- | --- | --- | --- | --- |
| 1 | `cmwdogv9u0002jtt6z36379ti` | `cmwdogv9x0003jtt64s0ppdgv` | SUCCESS | Issued the binding label card and per-item verification statement. |
| 2 | `cmwdoifea0008jtt64kfua8x7` | `cmwdoifec0009jtt6wcuvkh9q` | SUCCESS | Executed the label-attachment action from the approved decision and meeting record. |

- Attempt 1 remains preserved after re-execution.
- CEO requested the second attempt via `RE_EXECUTE` acceptance record
  `cmwdoif970007jtt6a8p42ud4`.
- CEO accepted attempt 2 via `cmwdojzwn000djtt6svf9cx4m`:
  “Accepted the second execution attempt and evidence.”
- Action is `COMPLETED / ACCEPTED`.

Other real actions remain visible in the same Workforce data:

- Research safe action `cmwdmqgy8002d23t6ta6n8z5t` — Task
  `cmwdnf7q50003t3t6c1u1qg9t`, Run `cmwdnf7q90004t3t6vfugfp0d`, SUCCESS, accepted.
- Finance safe action `cmwdmqgyh002g23t6ycwnkpcz` — Task
  `cmwdndczz0005ldt6bxhyz7l5`, Run `cmwdndd010006ldt6pa6dx0vp`, SUCCESS, accepted.

The Workforce page was loaded after the actions and re-execution; it showed the real tasks, two
attempts, result/evidence and acceptance history. A page reload reads the same persisted rows.

## 6. Screenshots

- [AI Workforce overview](assets/phaseM16-workforce.png)
- [Task detail with execution status and attempt history](assets/phaseM16-task.png)
- [Second attempt and CEO acceptance record](assets/phaseM16-attempts.png)

## 7. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **67 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed**, 344 skipped |
| TypeScript | all affected packages passed |
| Production web build | passed |
| Biome | passed on changed files |
| Migration | applied |

New tests cover:

- immutable attempts across RE_EXECUTE;
- duplicate execute returns one Task/Run per attempt;
- worker recovery enqueue for stale in-progress actions;
- failed result cannot be accepted; it can be BLOCKED;
- non-member acceptance rejection;
- real Workforce task/attempt aggregates.

Existing M1.3-B approvals, M1.4 chair/minutes, M1.5 execute/accept and M1.2 agenda tests remain green.

## 8. Files changed

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/meetings.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/index.ts`
- `packages/adapters/src/meetings.ts`
- `packages/adapters/src/background-job-handlers.ts`
- `packages/adapter-kit/src/background-jobs.ts`
- `packages/adapter-kit/src/types.ts`
- `packages/adapters/src/meetings.approval.postgres.test.ts`
- `apps/api/src/router.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/pages/shell/sidebar-header.tsx`
- `apps/web/src/pages/shell/shell-sidebar.tsx`
- `apps/web/src/pages/WorkforcePage.tsx` (new)
- `apps/api/src/routes/workforce.ts` (new)
- `packages/adapters/src/workforce.ts` (new)
- `packages/contracts/src/workforce.ts` (new)

New migration:

- `packages/db/prisma/migrations/20261211210000_meeting_action_attempts/migration.sql`

Reports/assets:

- `docs/reports/RABBITBOTS-PHASE-M1-6-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-6-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM16-*.png`

No commit or push was made.

## 9. Known limitations

1. The M1.6 acceptance extended the real M1.5 execution meeting rather than creating a brand-new
   meeting. The attempts and re-execution are real, but the meeting itself predates M1.6.
2. The real two-attempt action had SUCCESS on both attempts; a failed real attempt is covered by tests,
   not by the acceptance meeting. This satisfies the “failure or re-execution” requirement via genuine
   re-execution.
3. Existing M1.5 action attempts were backfilled only for the latest known execution; older historical
   attempts that were not captured by the old schema cannot be reconstructed.
4. The Workforce page lists every historical action (59 tasks, including old test meetings). There is
   no date/source filter yet.
5. Assign/Cancel are implemented and server-authorized but were not exercised in the real browser
   acceptance.
6. Worker recovery is covered by a focused test that asserts the action recovery job is enqueued; no
   live worker process restart was performed.
7. No CEO Direct Task or Bot Delegated Task source is implemented; Meeting Decision is the complete
   supported source.
8. No automatic retry loop; retries are explicit.
9. No automated Playwright e2e; acceptance used a real browser.
10. Human-owner assignment is displayable but not executable by a Bot.

## 10. PASS / NOT TESTED / BLOCKED

### PASS

- Independent immutable execution attempts and current pointer.
- Re-execution preserving attempt 1 and creating attempt 2.
- Worker recovery sweep for stale action Runs.
- Real Research/Finance Tasks and Runs.
- CEO acceptance and immutable acceptance history.
- Workforce Bot/Task/Attempt/Operations views from PostgreSQL.
- Task source meeting/decision/approval/acceptance lineage.
- Refresh persistence and browser-independent worker execution.
- Focused, web, API, TypeScript, build and Biome checks.

### NOT TESTED

- CEO Direct Task and Bot Delegated Task sources.
- Live Assign/Cancel browser flow.
- A real failed attempt in the acceptance meeting; failed/blocked behavior is covered by tests.
- Live worker process restart; recovery enqueue is tested.
- Full historical attempt reconstruction for M1.5 actions.
- Automated Playwright e2e / frontend component tests.

### BLOCKED

- None.

No commit or push was made.
