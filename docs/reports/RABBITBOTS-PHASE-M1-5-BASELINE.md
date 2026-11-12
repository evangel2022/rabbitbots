# RabbitBots Phase M1.5 — Baseline Inspection

Status: pre-implementation inspection. No code was modified during Phase 0.

## 1. Actual Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **140 paths** — 97 modified, 43 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

M1.2, M1.3-A, M1.3-B and M1.4 meetings, messages, approvals, minutes and assets remain in the
database and working tree.

## 2. Existing execution primitives

- `MeetingActionItem` already has title, description, assignee Bot, due date, status and a decision
  link.
- `Task` and `Run` are the real Bot execution primitive used by meeting turns.
- `Run` completion is already handled by a worker job; `meeting.reconcile` advances meeting turns.
- M1.3-B already provides server-derived CEO approval and immutable decision approval history.
- M1.4 already persists discussion state, supporting opinions, evidence gaps, acceptance criteria and
  a formal minutes view.

## 3. Gaps

`MeetingActionItem` has no activation, execution, result, evidence, blocked reason or CEO acceptance
record. There is no execution job for action Runs. There is no condition-confirmation record for
`APPROVED_WITH_CONDITIONS`, no action acceptance RPC and no action progress in the UI/minutes.

## 4. Reusable design

- Keep `Task`/`Run` as the only execution engine.
- Add a small `meeting.action.reconcile` worker job, mirroring the existing meeting reconcile job,
  so a completed action Run is synced without browser polling.
- Add additive fields to the action item and a small immutable `MeetingActionAcceptance` table.
- Confirm conditions on the decision, then activate its linked actions atomically.
- Keep the decision approval history untouched by execution/acceptance.
- Derive action progress counts in the existing formal minutes view.

## 5. Planned rules

```
OPEN -> IN_PROGRESS -> COMPLETED
OPEN/IN_PROGRESS -> BLOCKED
```

Only a CEO-approved decision (or a conditionally approved decision whose conditions were explicitly
confirmed) may activate actions. REJECTED/DEFERRED decisions cannot execute. A Bot result is
`SUCCESS|PARTIAL|FAILED|BLOCKED`; a successful run leaves the action `IN_PROGRESS` until CEO
acceptance. No client actor fields are trusted.

## 6. Risk notes

- Open-ended Research tasks can trigger many tool approvals; the execution prompt must prefer desk-only
  work and forbid external/irreversible actions.
- The action Run must not create a duplicate Task on retry; `executionAttempt` and the existing action
  task/run fields provide the guard.
- Re-execution changes the latest execution pointer; CEO acceptance history remains immutable.
- Human-owner actions are displayable but cannot be run as a Bot.
