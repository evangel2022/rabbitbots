# RabbitBots Phase M1.6 — Baseline Inspection

Status: pre-implementation inspection. No code modifications were made during Phase 0.

## 1. Actual Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **142 paths** — 97 modified, 45 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

M1.2–M1.5 meeting, execution, approval and acceptance data is preserved.

## 2. Existing execution primitives

- `MeetingActionItem` already has activation, task/run pointers, result, evidence, blocked reason,
  acceptance status and an `executionAttempt` counter.
- `MeetingActionAcceptance` is immutable and keyed by client nonce.
- `Task` + `Run` are the real Bot execution engine; `meeting.action.reconcile` exists for terminal
  Runs.
- `reconcileActiveMeetings` is the periodic worker recovery sweep for meetings.
- M1.5 action APIs already support execute/accept and the Meeting Room panel.

## 3. Gaps

- Re-execution overwrites the current action's `taskId`/`botRunId`/result; there is no immutable
  per-attempt table.
- The worker sweep does not recover an action Run that completed after a worker restart.
- There is no Workforce/Operations API, page or navigation entry.
- There is no cross-meeting task list with attempts, source meeting/decision and real Bot aggregate.
- Assign/Cancel management controls are not present.

## 4. Minimal path

- Add an additive `meeting_action_attempts` table and backfill one known latest attempt for existing
  executed actions.
- Create a new attempt on every real execute; keep current fields on the action as a pointer/snapshot.
- Update attempt/action together on reconciliation; never overwrite older attempts.
- Extend `reconcileActiveMeetings` to enqueue action reconciliation for stale running attempts.
- Add a read-only `workforce.overview` API derived from real actions, attempts, decisions and
  acceptance records.
- Add `/app/workforce` with Bot list, task list and execution/acceptance details; add a sidebar entry.
- Add Assign/Cancel controls where the service can authorize them.

## 5. Acceptance constraints

The real demo can reuse the completed M1.5 execution meeting and its real Research/Finance Tasks, then
perform one genuine re-execution to produce independent attempt 1 and attempt 2 records. The attempt
history, results, evidence and CEO acceptance must all be persisted before the Workforce page is read.
