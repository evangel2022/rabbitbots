# RabbitBots Phase M1.8 — Durable Delegation & Autonomous Continuation

Status: **PASS** for durable task waiting, child-result delivery, automatic parent continuation,
four-Bot nested tree and real worker restart, with the architectural limitations listed below.

## 1. Runtime assessment

The runtime has durable `Run` rows and a worker, but no general API to suspend and resume the same Run
in place. Reusing `waiting_input` would have faked a user interaction; mutating a finished Run would
have faked a resume.

The implementation therefore uses the runtime's existing continuation pattern:

1. Persist the parent wait and each delegation before the worker releases the parent Run.
2. Let the original parent Run settle normally.
3. Persist each child result as its own delivery row.
4. Create exactly one new continuation Run under the same parent `WorkforceTask`, linked with
   `parentRunId` and `continuationOfRunId`.
5. Keep the parent `IN_PROGRESS` until CEO Acceptance.

Original Runs and Attempts are never overwritten.

## 2. Migration

Applied `20261211230000_workforce_durable_delegation`.

`WorkforceTask` additions:

- `waitingForChildren`
- `waitingSince`
- `continuationRunId`
- `continuationOfRunId`
- `delegationDeadlineAt`

`Run` additions:

- `parentRunId`
- `continuationOfRunId` (unique)

New `workforce_delegations`:

- parent Task / parent Run / child Task / child Run;
- delegator and assignee Bot;
- WAITING / COMPLETED / FAILED / BLOCKED / TIMED_OUT;
- result status/summary/evidence/error;
- delivered/completed/deadline timestamps;
- unique `(parentTaskId, childTaskId)`.

No historical rows were deleted or rewritten.

## 3. Durable flow

`delegate_task` now:

- creates the child `WorkforceTask`;
- starts its real Task/Run;
- writes a `workforce_delegations` row;
- sets the parent to `WAITING_FOR_CHILDREN` with a 15-minute deadline.

When a child reaches a submitted terminal result (`SUCCESS`, `PARTIAL`, `FAILED`, `BLOCKED`), the
worker:

- records the delivery exactly once per child row;
- checks all siblings and the deadline;
- creates a continuation Run only after the original parent Run is terminal;
- preserves the original parent Run and attempt;
- creates a new attempt for the continuation Run.

The continuation prompt contains each child's real title, status, result, evidence and error. It
never upgrades a failed child. The parent remains uncompleted and requires CEO Acceptance.

Recovery paths:

- `reconcileActiveWorkforceTasks` scans waiting parents and undelivered children.
- Run completion enqueues parent/child reconciliation.
- `workforce.task.reconcile` handles both waiting parents and continuation results.
- A parent with `CANCELLED` acceptance is never revived by a late child result.

## 4. Four-Bot three-level tree

Operations Bot was created as the fourth Bot:

`cmwdqu0szfuck6yhwukw6bael` — Operations Bot

Bots in the tree:

- CEO Assistant `cmwax3rm1ro45tmwqj5mnj4rf`
- Research Bot `cmwax3rn2nyeo6kia61x42mys`
- Finance Bot `cmwax3rp2nh23uan93mt69jpi`
- Operations Bot `cmwdqu0szfuck6yhwukw6bael`

Root Task:

`cmwdr1ssg0007yat6ddo4uzoj` — “Three-level workforce delegation tree”

| Node | Task | Depth | Status |
| --- | --- | --- | --- |
| CEO Assistant parent | `cmwdr1ssg0007yat6ddo4uzoj` | 0 | PARTIAL / ACCEPTED |
| Research child | `cmwdr2jjj000gyat6omivx80b` | 1 | PARTIAL / ACCEPTED |
| Finance child | `cmwdr2ndp000oyat6l0t3a34e` | 1 | SUCCESS / ACCEPTED |
| Operations child | `cmwdr2s05000wyat6bh1c4let` | 1 | SUCCESS / ACCEPTED |
| Operations grandchild | `cmwdr3149000qyht61ccddo6u` | 2 | FAILED / BLOCKED |

The tree is three levels deep (parent → child → grandchild). Each node has its own Task/Run/Attempt.

Parent Attempts:

| Attempt | Task | Run | Result |
| --- | --- | --- | --- |
| 1 | `cmwdr1sxw0008yat65yr644uu` | `cmwdr1sxy0009yat6134ptaz1` | PARTIAL |
| 2 | `cmwdr5rdw019wyht6tl8dgpni` | `cmwdr5rdx019xyht61yqgbsfq` | PARTIAL |

Research Attempts:

- `cmwdr2jjj...` has 2 attempts; continuation Run `cmwdr59pk019kyht6ngbmmt9h`.
- Finance and Operations children each have one attempt.
- Operations grandchild has one attempt, Run `cmwdr314h000syht61h1d92k9`, BLOCKED because the model
  hit its output limit.

Delivery records:

- Finance delivered `2026-11-12 16:17:14 UTC`
- Operations child delivered `2026-11-12 16:17:10 UTC`
- Research delivered `2026-11-12 16:18:43 UTC`
- Operations grandchild delivered `2026-11-12 16:18:20 UTC` with real error
  “The model hit its output limit before writing a response.”

The Research and root continuations happened automatically; no parent polling was required.

CEO acceptances:

- Root `cmwdr83fd001kyat66tgvj35u` — accepted despite the failed grandchild.
- Research `cmwdr83eg001jyat65qh9fo3f` — accepted after reporting the failed grandchild.

## 5. Real worker restart drill

Second durable task:

- Parent `cmwdraxnr002kyat6xwxrnqzs` — “Restart drill second”
- Child `cmwdrb65f01dqyht6hhbgchej` — Operations, 12-step checklist
- Original parent Run `cmwdraxoj002myat6nibnw9my`
- Continuation Run `cmwdrcr7h00082rt6tdtlumve`
- Parent attempts: `cmwdraxoi002lyat6x75z7f1n` (PARTIAL), `cmwdrcr7f00072rt6inpxrb81`
  (continuation PARTIAL)

At 00:22:44 Asia/Shanghai the parent was started. At 00:23:20 the parent was already
`WAITING_FOR_CHILDREN` and the child was `IN_PROGRESS`; the worker process was restarted by touching
the watched worker source. Process PIDs changed from the 00:13 worker (`128242/128249`) to new
watcher processes `129699/129711` at 00:23:20–22.

After the restart, the child completed at 00:25:06, the delivery was processed, the continuation Run
`cmwdrcr7h...` was created with:

- `parentRunId = cmwdraxoj002myat6nibnw9my`
- `continuationOfRunId = cmwdraxoj002myat6nibnw9my`
- `trigger = delegation_continuation`

and the parent result was written by the continuation. CEO acceptances:

- Child `cmwdrdyy7000233t64qskh3ua`
- Parent `cmwdrdyze000333t6aalpaaxd`

The parent result explicitly says it was “RESUMED AS PARENT … across the worker restart.”

## 6. Boundary controls

- Max delegation depth 3.
- Max 5 direct children per parent; the 6th is rejected.
- Self-delegation rejected.
- Ancestor cycle rejected.
- Parent cancellation wins over late child results.
- Child failure is delivered as FAILED/BLOCKED, never promoted to SUCCESS.
- Parent never auto-completes; CEO Acceptance is final.

Focused tests cover the 5/6 child boundary, depth-4 rejection, self/ancestor cycles and late cancellation.

## 7. Workforce UI

No three-column rewrite. Added:

- `WAITING_FOR_CHILDREN` task and Bot states.
- Waiting count in Operations.
- “Delegation wait” panel with waiting/completed/failed counts, waiting-since, deadline and
  continuation Run.
- Delivery rows with child Task and result/error.
- Recursive **Task tree** with indentation and clickable descendants.
- Multi-level statuses and failed grandchild shown under the root.
- Attempt history and acceptance history remain.

Screenshots:

- [Waiting parent with in-flight child](assets/phaseM18-waiting.png)
- [Three-level tree and delivered results](assets/phaseM18-tree.png)
- [Parent continued after worker restart](assets/phaseM18-restart.png)

## 8. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **72 passed** |
| Built-in tool/runtime | **247 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed**, 344 skipped |
| TypeScript | all affected packages passed |
| Production build | passed |
| Biome | changed files pass |

New tests:

- parent persisted waiting;
- two children, partial delivery remains waiting;
- second delivery creates exactly one continuation;
- duplicate delivery does not create a second attempt;
- child failure delivery;
- late child after parent cancellation does not revive parent;
- five/six child boundary;
- depth-4 boundary;
- self/ancestor cycle;
- generic recovery enqueue;
- M1.3-B–M1.7 regressions.

## 9. Files

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/workforce.ts`
- `packages/adapters/src/workforce.ts`
- `packages/adapters/src/workforce-tasks.ts`
- `packages/adapters/src/meetings.approval.postgres.test.ts`
- `apps/web/src/pages/WorkforcePage.tsx`

New migration:

- `packages/db/prisma/migrations/20261211230000_workforce_durable_delegation/migration.sql`

Reports/assets under `docs/reports/`.

## 10. Limitations

1. **The original parent Run is not suspended.** The durable wait is on the parent `WorkforceTask`
   and `workforce_delegations`; the original Run settles, and a clearly linked continuation Run
   performs the resumed work. This is an explicit architectural boundary, not a fake same-Run resume.
2. Child result delivery occurs when a child submits its terminal result, before CEO acceptance of
   that child. This allows the parent to continue; CEO Acceptance remains final for both.
3. Timeout is persisted as a 15-minute delegation deadline and a TIMED_OUT delivery status, but no
   live timeout acceptance was run.
4. The real tree is three levels (parent/child/grandchild); depth-4 rejection is test-level. Depth 3
   refers to the configured maximum below root.
5. Physical attempt tables remain split (`meeting_action_attempts` and `workforce_task_attempts`);
   M1.8 keeps the service/read-contract boundary and does not migrate history.
6. Worker restart was a real watched-process restart, not a Docker/container kill.
7. The real grandchild failed on an output limit; the root accepted PARTIAL. No separate retry of the
   failed grandchild was performed.
8. Workforce still lists all historical tasks; filters are available but no default recency window.
9. No automated Playwright e2e.
10. Child delivery and continuation are idempotent at row/unique-key level; delivery timestamps can
    update on a repeated processing pass even though no duplicate event/row is created.

## 11. PASS / NOT TESTED / BLOCKED

### PASS

- Persistent parent wait before worker release.
- Per-child durable delivery records.
- Automatic parent continuation without parent polling.
- Original parent Run preserved; continuation linked by `parentRunId`/`continuationOfRunId`.
- Nested three-level, four-Bot real tree.
- Failed grandchild visible; parent not auto-completed.
- Real worker process restart with automatic continuation.
- 5/6 child and depth-4 boundaries, self/ancestor cycle, late cancellation.
- CEO Acceptance on root and branches.
- Full focused/web/API/TypeScript/build/Biome checks.

### NOT TESTED

- Live 15-minute timeout.
- Suspending/resuming the exact same original Run in place.
- Docker/container worker kill instead of watched-process restart.
- Automated browser e2e.
- Physical attempt-table unification.

### BLOCKED

- None.

No commit or push was made.

## 12. Next stage

Implement a runtime-native suspended Run state so the original parent Run can wait without completing,
then unify the two attempt stores behind one physical schema after a compatibility/validation plan.
Add automatic timeout acceptance and a durable parent wait that does not need a separate continuation
Run.
