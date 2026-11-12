# RabbitBots Phase M1.7 — Baseline Inspection

Status: pre-implementation inspection. No code modifications were made during Phase 0.

## 1. Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **147 paths** — 97 modified, 50 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

M1.2–M1.6 meeting, action, attempt, acceptance and Workforce data remains intact.

## 2. Existing task primitives

- `Task` is the real execution unit. It has `spaceId`, `botId`, `threadId`, `userId`, `prompt`,
  `status`, timestamps and `runs`; it has no source/acceptance/parent fields.
- `Run` belongs to `Task` and is driven by the existing worker and `run.continue` jobs.
- `MeetingActionItem` already provides source, acceptance criteria, assignee, Task/Run pointers,
  result/evidence and acceptance history for meeting-originated work.
- `meeting_action_attempts` provides immutable meeting-action attempts.
- Workforce already reads meeting actions and attempts, but has no CEO Direct or Bot Delegated source.
- No generic task intake, parent/child delegation, delegation depth limit or delegation tool exists.

## 3. Gaps

- CEO Direct Task creation and a CEO identity-backed intake API.
- A task record shared by Meeting, CEO and delegated sources without breaking M1.5.
- Generic attempts/acceptances for non-meeting tasks and their worker reconciliation.
- A Bot-callable bounded delegation tool with parent Run lineage, self/cycle guards, depth and child
  count limits.
- Parent/child display, source/time/status filters and a CEO task composer.

## 4. Minimal path

- Keep `MeetingActionItem` and `meeting_action_attempts` unchanged.
- Add additive `workforce_tasks`, `workforce_task_attempts` and `workforce_task_acceptances` for
  CEO Direct and Bot Delegated work.
- Create real `Task` and `Run` rows for every generic task; all execution still uses the existing
  runtime.
- Add `workforce.task.reconcile` and include generic tasks in the existing worker recovery sweep.
- Map both stores into one `WorkforceTaskView` read model and one `/app/workforce` surface.
- Add two built-in tools: `delegate_task` and `delegated_task_status`; the tool receives the real
  parent Run context and records `parentTaskId`, `parentRunId`, `delegatorBotId` and depth.
- Enforce self/ancestor cycle guards, max depth 3 and max 5 children per parent.

## 5. Acceptance constraints

The real browser flow must create a Research task, let Research run, have Research delegate a
Finance child from its Run, let both settle, accept both, then prove Assign and Cancel on another
task. No simulated results.
