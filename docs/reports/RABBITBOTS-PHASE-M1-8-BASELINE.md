# RabbitBots Phase M1.8 — Baseline Inspection

Status: pre-implementation inspection. No code modifications were made during Phase 0.

## 1. Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **150 paths** — 98 modified, 52 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

M1.2–M1.7 meeting, task, attempt and acceptance data is preserved.

## 2. Runtime capabilities

- `Run` is a real durable row driven by `run.continue`; `waiting_input` and approval replay exist for
  user interactions, but there is no general in-place "resume this same Run" API.
- The orchestration module already proves the right pattern: parent Run settles, children run
  independently, then a **new join Run** is created once children are terminal.
- M1.7 `delegate_task` starts a child immediately and returns; the parent has no durable wait and must
  poll `delegated_task_status`.
- `WorkforceTask` has parent links but no waiting, delivery record or continuation fields.
- No background job currently delivers child results into a parent.
- Existing `reconcileActiveMeetings`/`reconcileActiveWorkforceTasks` sweeps are the right recovery
  hooks.

## 3. Design decision

Do not fake an in-place resume. Use the existing runtime's proven continuation pattern:

- Persist the wait and delegation rows first.
- Let the original parent Run settle naturally.
- Deliver each child's real terminal/submitted result into its own durable row.
- Create exactly one new **continuation Run** under the same parent `WorkforceTask`, with
  `parentRunId` and `continuationOfRunId` pointing at the original Run.
- Never mark the parent COMPLETED; CEO Acceptance remains final.

This preserves original Runs and Attempts and is honest about the runtime boundary.

## 4. Acceptance constraints

Build a four-Bot, three-level real tree: CEO Assistant parent, Research child, Operations grandchild,
plus Finance and Operations sibling children. Verify both nested continuation and a real worker
process restart while the parent is waiting. No simulated child results.
