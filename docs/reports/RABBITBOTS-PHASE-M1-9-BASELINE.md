# RabbitBots Phase M1.9 — Baseline Inspection

Status: pre-implementation inspection. No code modifications were made during Phase 0.

## 1. Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **151 paths** — 98 modified, 53 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

## 2. Runtime assessment

- `RunStatus` has `queued`, `leased`, `running`, `waiting_input`, `waiting_takeover`, `completed`,
  `failed`, `cancelled`; there is no `SUSPENDED`.
- `TurnCheckpoint` serializes the transcript and a pending tool call for takeover/retry paths.
- The executor owns the tool loop in process; there is no public operation to suspend a delegation
  wait and resume the exact Run at a durable tool boundary.
- Effects and checkpoints make retries safer, but not a general Resumable Run API.
- M1.8's continuation Run is therefore retained. It must not be replaced by a fake same-Run resume.

**Conclusion:** native Suspend/Resume is **NOT IMPLEMENTED** in M1.9. Keep M1.8 continuation.

## 3. Attempt baseline

- `meeting_action_attempts`: meeting actions.
- `workforce_task_attempts`: CEO Direct and delegated generic tasks.
- Both are exposed through separate service joins; the Workforce view already unifies the read shape.
- Existing rows must be backfilled, not reconstructed or invented.

## 4. Gaps

- Unified physical `execution_attempts` table with source/lineage fields and rollback window.
- Legacy writes must continue during the window, while reads move to the new table.
- Delegation timeout: the deadline was checked only when continuation was attempted; no independent
  worker scan, timeout delivery timestamp, or late-result audit fields.
- Timeout must be idempotent across scans and worker restarts.
- Automated browser E2E is not yet present for the Workforce intake.

## 5. Scope

Implement unified schema + backfill + dual-write/read switch, timeout scan/delivery/late result,
retain continuation, add E2E spec, verify all M1.3–M1.8 regressions.
