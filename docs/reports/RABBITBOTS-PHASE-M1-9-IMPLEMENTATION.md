# RabbitBots Phase M1.9 — Runtime Reliability & Unified Execution History

Status: **PASS** for unified attempts, timeout recovery and M1.8 reliability, with these explicit
NOT TESTED/ NOT IMPLEMENTED items:

- Native Suspend/Resume: **NOT IMPLEMENTED** (not reliably available; M1.8 continuation retained).
- Automated Playwright E2E: spec added, **NOT TESTED** here because Playwright 1.64 refuses to install
  Chromium on this Ubuntu 20.04 environment; the same browser flows were exercised with real Windows
  Chrome automation and screenshots.

## 1. Git

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **151 paths** — 98 modified, 53 untracked |
| Final | **155 paths** — 98 modified, 57 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

## 2. Runtime Suspend/Resume

### Assessment

- No `SUSPENDED` Run status exists.
- No public suspend/resume API exists.
- `TurnCheckpoint` is a transcript/tool-call checkpoint used by takeover/retry paths, not a general
  external suspension point.
- Tool dispatch and the pending tool call live in the executor process; there is no durable
  "resume this exact tool loop" contract.
- Lease/cancel logic is designed for running/retrying runs, not indefinitely paused delegation waits.

### Decision

**NOT IMPLEMENTED.** M1.8's durable task wait + explicitly linked continuation Run remains.
No completed Run was modified, and no new Run was represented as the original Run.

## 3. Unified Execution Attempt

### Schema

New physical table `execution_attempts`:

- `id`, `spaceId`
- `sourceType` (`MEETING_ACTION` / `WORKFORCE_TASK`), `sourceId`
- `meetingActionId`, `workforceTaskId`
- `taskId`, `runId`
- `parentRunId`, `continuationOfRunId`
- `attemptNumber`, `status`, `resultStatus`, `resultSummary`, `evidence`, `error`
- `startedAt`, `completedAt`, `createdAt`, `updatedAt`

Constraints:

- unique `(sourceType, sourceId, attemptNumber)`
- unique `(meetingActionId, attemptNumber)`
- unique `(workforceTaskId, attemptNumber)`
- indexes for Space/time, Run and parent Run
- FKs to the owning Meeting Action / Workforce Task

### Migration mapping

| Legacy | Unified |
| --- | --- |
| `meeting_action_attempts.id` | `ux-meeting:<legacy id>` |
| `actionItemId` | `sourceId`, `meetingActionId` |
| `meetingId` → meeting | `spaceId` |
| `taskId` | `taskId` |
| `botRunId` | `runId` |
| `runs.parentRunId` | `parentRunId` |
| `runs.continuationOfRunId` | `continuationOfRunId` |
| `workforce_task_attempts.id` | `ux-workforce:<legacy id>` |
| `taskId` | `sourceId`, `workforceTaskId` |
| `taskRunId` | `taskId` |
| `spaceId` | `spaceId` |
| `botRunId` | `runId` |
| status/result/summary/evidence/error/timestamps | copied 1:1 |

Legacy IDs are prefixed, not guessed or synthesized as attempts that never existed.

### Migration validation

Applied:

- `20261211240000_unified_execution_attempts`
- `20261211250000_workforce_timeout`

Before/final counts after all M1.9 activity:

| Table | Rows |
| --- | --- |
| `meeting_action_attempts` | 4 |
| `workforce_task_attempts` | 209 |
| `execution_attempts` | 213 |
| `MEETING_ACTION` unified | 4 |
| `WORKFORCE_TASK` unified | 209 |
| `meeting_action_acceptances` | 6 |
| `workforce_task_acceptances` | 34 |

Integrity checks:

- 0 missing/mismatched `MEETING_ACTION` rows against the legacy table.
- 0 missing/mismatched `WORKFORCE_TASK` rows against the legacy table.
- 0 wrong/missing `meetingActionId` or `workforceTaskId`.
- Evidence, error, summary and status compare equal.
- Acceptance tables were not touched.

### Write/read switch

- New executions dual-write the legacy row and `execution_attempts`.
- New continuation attempts dual-write as well.
- Meeting view and Workforce view now read `execution_attempts`.
- Legacy tables remain populated for rollback and the old release.
- Old tables are not dropped.

## 4. Timeout delivery

Timeout scan is part of the worker recovery sweep:

1. Find `WAITING` delegations whose `deadlineAt` has passed.
2. Conditional update only while status is still `WAITING`.
3. Set `TIMED_OUT`, `resultStatus = TIMED_OUT`, `timedOutAt`, reason, delivered/completed timestamps.
4. Trigger one continuation only if the parent is still waiting and not cancelled.
5. Late child result is written to `lateResultStatus/lateResultSummary/lateResultAt`; it does not
   replace the timeout, acceptance or continuation.
6. Repeated scans cannot create a second Attempt/continuation.

The timeout is an execution outcome only; CEO Acceptance remains unset until the CEO acts.

## 5. Real controlled-timeout acceptance

Task: **Timeout acceptance parent** `cmwds5anm0002ebt69eh6ptxc`

- Child: `cmwds5hng000aebt6bzf01ttb` — Operations Bot, 20-step checklist
- Delegation: `cmwds5ho6000eebt6aeuqa57j`
- Deadline was moved into the past as the controlled test clock after the child was waiting.
- Worker process restart: PIDs `147846/147864` started at 00:46:50/52 Asia/Shanghai.
- Timeout scan wrote `TIMED_OUT` at `2026-11-12 16:47:23 UTC`.
- Reason: `The delegated task did not finish by 2026-11-12T16:45:30.531Z.`
- Continuation Run: `cmwds6ne6000f2ut6crjwmwg7`
- Parent result: `PARTIAL` — explicitly reported timeout, not success.
- Child later produced `SUCCESS`; it was recorded only as `lateResultStatus = SUCCESS`, while the
  delegation remained `TIMED_OUT`.
- Parent was not auto-accepted; CEO acceptance was manually recorded as
  `cmwds9dq500063ct68519solg`:
  “Accepted the real timeout outcome; it was not converted into success.”

Screenshot: [Workforce timeout and late child](assets/phaseM19-timeout.png)

## 6. Workforce page

Added without a three-column rewrite:

- unified Attempt history from `execution_attempts`;
- `WAITING_FOR_CHILDREN` and parent continuation indicators;
- timeout status, timeout reason, timed-out timestamp;
- late child result label;
- recursive Task tree with status/result at each depth;
- delegation progress and resume history;
- distinction among running, waiting, resumed, failed, timed out and pending CEO acceptance.

The existing M1.8 waiting/tree/restart screenshots still represent the same UI:
[waiting](assets/phaseM18-waiting.png), [tree](assets/phaseM18-tree.png),
[restart](assets/phaseM18-restart.png).

## 7. Automated E2E

Added `apps/web/e2e/workforce-direct.spec.ts`:

- CEO creates a direct task in the real Workforce composer;
- task appears as CEO Direct;
- page reload and source filter preserve it.

Test discovery succeeds:

`[chromium] › workforce-direct.spec.ts:4:1 › CEO creates a direct task and it survives the Workforce reload`

Execution was not possible in this environment:

- Playwright 1.64 reports it does not support Chromium on Ubuntu 20.04.
- No Chromium binary is installed in the WSL environment.
- A direct Chrome-for-Testing download timed out in the available network window.

The M1.9 real browser acceptance was still performed with Windows Chrome automation (screenshots
above); only the packaged Playwright runner remains untested here. This is an environment limitation,
not a product-data shortcut.

## 8. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **73 passed** |
| Built-in tool/runtime | **247 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed**, 344 skipped |
| TypeScript | all affected packages passed |
| Production build | passed |
| Biome | changed files pass |

New M1.9 coverage:

- unified attempt view and write path;
- timeout idempotence and controlled-timeout continuation;
- late result audit;
- timeout does not create an accepted task;
- repeated timeout scan does not create a second Attempt;
- existing M1.8 durable wait/delivery/continuation tests;
- M1.3-B–M1.8 focused regressions.

## 9. PASS / NOT TESTED / BLOCKED

### PASS

- Unified execution-attempt schema, backfill, dual-write and read switch.
- Legacy tables retained, with counts/field/FK comparison clean.
- Timeout scan, idempotent TIMED_OUT delivery, parent continuation.
- Late child audit without reactivation or false success.
- Real worker restart followed by timeout recovery.
- Manual browser acceptance and screenshots.
- All focused/web/API/TypeScript/build/Biome checks.

### NOT TESTED

- Packaged automated Playwright execution (environment/browser unavailability).
- Native Suspend/Resume (NOT IMPLEMENTED by design).
- A full 15-minute wall-clock wait; a controlled test clock moved the deadline into the past.
- Container-level worker kill; the watcher process was restarted.

### BLOCKED

- None.

No commit or push was made.

## 10. Next

- Install a Playwright-supported Chromium in CI (or use the existing CI Ubuntu version) and run the
  new Workforce E2E.
- Add a runtime-native suspend state only if the executor can persist and safely resume an exact
  tool boundary without replay or dual execution.
- After the rollback window, retire the legacy attempt tables with a deferred migration and final
  reconciliation.
