# RabbitBots Phase M1.7 — Universal Task Intake & Delegation

Status: **PASS** for the unified-intake vertical slice, with the limitations listed below.

CEO Direct and Bot Delegated tasks now enter the same Workforce surface as Meeting Decision tasks,
using the existing `Task`/`Run` runtime and the same immutable attempt/evidence/CEO acceptance
semantics in the read model.

## 1. Git

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **147 paths** — 97 modified, 50 untracked |
| Final | **150 paths** — 98 modified, 52 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

## 2. Migration

Applied `20261211220000_workforce_generic_tasks`:

- `workforce_tasks` — source, title/description/criteria, priority, due date, assignee, creator,
  parent Task/Run, parent meeting action, delegator, depth, current Task/Run, result, evidence,
  blocked reason, acceptance, timestamps.
- `workforce_task_attempts` — independent attempt number, Task/Run, status, result, evidence, error,
  timestamps; unique per task and attempt.
- `workforce_task_acceptances` — immutable CEO decisions keyed by client nonce.
- Indexes for Space/time, assignee, Run and parent traversal.

No M1.2–M1.6 table or row was deleted or rewritten.

## 3. CEO Direct Task

The Workforce header now has **New task**. The composer collects:

- title and description;
- acceptance criteria;
- target Bot;
- priority and optional due date.

The API takes the Space and user only from the authenticated session. It rejects a Bot that is
archived or outside the Space. Creating the task writes a real `workforce_tasks` row with
`source = CEO_DIRECT`; Execute creates a real `Task` and `Run`, then a generic attempt. The worker
reconciles the result through `workforce.task.reconcile`.

Real browser acceptance:

| Item | Value |
| --- | --- |
| Task | `cmwdpaqqq0004xjt6quurm004` |
| Source | CEO_DIRECT |
| Assignee | Research Bot |
| Priority/status | NORMAL → COMPLETED / ACCEPTED |
| Created | 2026-11-12 23:26:36 Asia/Shanghai |
| Completed | 2026-11-12 23:36:25 Asia/Shanghai |

Three real attempts were preserved because the first two returned PARTIAL and the CEO requested
another execution.

| Attempt | Task | Run | Result |
| --- | --- | --- | --- |
| 1 | `cmwdpctiw000bxjt6f8dwzauv` | `cmwdpctiz000cxjt6pojogftw` | PARTIAL |
| 2 | `cmwdpgwip0003ift63nrl7yfv` | `cmwdpgwis0004ift6892rlp3t` | PARTIAL |
| 3 | `cmwdpkdwy0003sbt6yio8043q` | `cmwdpkdx00004sbt6k4q81plp` | SUCCESS |

CEO acceptance `cmwdpnctz001tsbt6cozni13s`:
“Accepted parent result incorporating the delegated Finance result.”

## 4. Real Bot Delegation

The Finance child was created **by the Research Run itself** through the `delegate_task` built-in
tool. The tool receives the real parent Run, verifies the Run belongs to the delegating Bot and
Space, records the parent task and Run, and starts a real Finance Task/Run.

| Item | Value |
| --- | --- |
| Child | `cmwdplwzv000osbt6v4kv395o` |
| Source | BOT_DELEGATED |
| Parent task | `cmwdpaqqq0004xjt6quurm004` |
| Parent Run | `cmwdpkdx00004sbt6k4q81plp` |
| Delegator | Research Bot `cmwax3rn2nyeo6kia61x42mys` |
| Assignee | Finance Bot `cmwax3rp2nh23uan93mt69jpi` |
| Depth | 1 |
| Task/Run | `cmwdplx08000psbt6o49wnfyv` / `cmwdplx0b000qsbt6a5vmfgbj` |
| Result | SUCCESS |
| CEO acceptance | `cmwdpncot001ssbt69rpmk08l` |

The parent result explicitly records that it delegated one bounded arithmetic child, read it with
`delegated_task_status`, and incorporated the returned result. The child did not automatically make
the parent COMPLETED; the parent was separately accepted.

The first delegation attempt exposed and fixed a real cycle-guard bug: the parent assignee was being
treated as an ancestor before the target check. The fixed guard now rejects only the delegating Bot
and actual ancestors. A subsequent real Run succeeded.

## 5. Assign and Cancel

A second CEO Direct task was created via the browser:

- Task `cmwdpnsc4001wsbt6bi5itt1z`
- Initially Research Bot.
- Reassigned to Finance Bot in the Workforce detail.
- Cancelled by the CEO.
- Final state `BLOCKED / CANCELLED` with reason “Cancelled by CEO.”
- Acceptance record `cmwdpnxr4001xsbt69x37fpdc`.

## 6. Unified Workforce

Added without rewriting the three-column shell:

- Source filters: Meeting, CEO Direct, Bot Delegated.
- Bot and status filters.
- Today / last 7 days time filter.
- Source and parent identifier in task detail.
- Parent link / delegated subtasks section.
- Generic and meeting attempts, evidence, errors and CEO acceptance in one detail panel.
- Real Operations Summary combining both stores.
- New task composer and generic Run/Retry/Assign/Cancel/Accept controls.

Screenshots:

- [Workforce with source filters and delegated subtasks](assets/phaseM17-workforce.png)
- [Delegated child detail](assets/phaseM17-child.png)
- [CEO Direct composer](assets/phaseM17-create.png)
- [Assign and Cancel](assets/phaseM17-controls.png)

## 7. Safety controls

- `delegate_task` only works from a real parent Run; the Run must belong to the delegating Bot and
  Space.
- Self-delegation and ancestor cycles are rejected.
- Maximum depth 3; maximum 5 children per parent.
- Child failure/blocked is stored on the child and never auto-completes the parent.
- Generic executors use server-derived Space/user and never trust client ownership.
- CEO acceptance is required for completion; a Bot cannot accept.
- No payment, purchase, email or irreversible external action is introduced.
- No automatic retry loop.

## 8. Tests

| Check | Result |
| --- | --- |
| Focused suite | **69 passed** |
| Built-in tool/runtime regressions | **247 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed**, 344 skipped |
| TypeScript | all affected packages passed |
| Production build | passed |
| Biome | changed files pass |

New focused coverage:

- CEO Direct creation and permission-safe Bot validation.
- Real Task/Run creation and idempotent generic execution.
- Independent generic attempts.
- Parent/child lineage from a real parent Run.
- Self-delegation and ancestor-cycle rejection.
- Child failure does not complete the parent.
- Generic worker recovery enqueue.
- M1.3-B, M1.4, M1.5, M1.6 regressions through the existing suites.

## 9. Files

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/workforce.ts`
- `packages/contracts/src/rpc.ts`
- `packages/contracts/src/builtin-tools.ts`
- `packages/adapter-kit/src/types.ts`
- `packages/adapter-kit/src/background-jobs.ts`
- `packages/adapters/src/workforce.ts`
- `packages/adapters/src/meetings.ts`
- `packages/adapters/src/background-job-handlers.ts`
- `packages/adapters/src/builtin-tools.ts`
- `packages/adapters/src/run-tools-tasks.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/src/meetings.approval.postgres.test.ts`
- `apps/api/src/routes/workforce.ts`
- `apps/web/src/pages/WorkforcePage.tsx`

New:

- `packages/adapters/src/workforce-tasks.ts`
- `packages/db/prisma/migrations/20261211220000_workforce_generic_tasks/migration.sql`

Reports and assets are under `docs/reports/`.

## 10. Known limitations

1. Meeting tasks still use `meeting_action_attempts`; CEO Direct/delegated tasks use
   `workforce_task_attempts`. The API/UI unifies them as one read model, but the two stores are not
   physically one table.
2. Delegation does not automatically deliver child results into the parent's prompt context. The
   parent must call `delegated_task_status`; the real parent did so and incorporated the child.
3. A child never auto-completes its parent. This is intentional; the CEO still accepts the parent.
4. Depth 3 and max 5 children are enforced in code; only self/ancestor cycle and failure propagation
   are covered by focused tests. Deep/wide trees are not exhausted in integration tests.
5. `delegated_task_status` can return `IN_PROGRESS` with a populated `resultStatus` while the wrapper
   metadata is still settling; the parent used the returned result despite that lag.
6. Generic worker recovery is covered by enqueue tests, not a live worker process restart.
7. The Workforce list still includes all historical actions (109 open tasks from earlier test
   meetings); filtering now exists but there is no default recency window.
8. The real failed-child scenario is test-only. The acceptance parent had PARTIAL then SUCCESS, not a
   child FAILED.
9. No automated Playwright e2e; acceptance used a real browser.
10. CEO Direct priority/due controls are implemented, but the live acceptance task used default
    normal priority and no due date.

## 11. PASS / NOT TESTED / BLOCKED

### PASS

- Meeting Decision, CEO Direct and Bot Delegated sources in one Workforce.
- Real CEO Direct Task and real Task/Run/attempt.
- Real parent Run calling `delegate_task` and creating a Finance child.
- Parent/child lineage, depth 1, source and evidence.
- Parent result incorporating child result.
- CEO acceptance of parent and child.
- Real Assign and Cancel.
- Attempt history, idempotent execution, worker recovery enqueue.
- Failure/blocked not auto-completing parent (test).
- Source/bot/status/time filters and parent/child display.
- Full tests, TypeScript, build and Biome.

### NOT TESTED

- Exhaustive depth-3 and 5-child trees.
- Live worker restart during a generic task.
- Real failed Finance child in the acceptance meeting.
- Automated browser e2e.
- Non-default priority/due date in the live composer.

### BLOCKED

- None.

No commit or push was made.

## 12. Recommended next step

Unify both task stores behind one physical execution-attempt/acceptance schema, then add automatic
child-result delivery into the parent Run (a durable parent wait/continuation) so delegation no longer
depends on the parent choosing to call `delegated_task_status`. Add a fourth distinct Bot and a
wide-tree fixture to test depth 3 and the five-child cap.
