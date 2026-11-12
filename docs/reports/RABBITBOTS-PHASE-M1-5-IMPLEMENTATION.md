# RabbitBots Phase M1.5 — Decision-to-Execution Loop

Status: **PASS** for the investor-demo vertical slice, with the execution limitations described below.

A real meeting decision was approved by the human CEO, its conditions were confirmed, its action items
were activated, Research Bot and Finance Bot each received and executed a real Task/Run, both
submitted results, and the CEO accepted both results inside the Meeting Room. A subsequent page
refresh preserved the execution and acceptance records.

## 1. Git baseline and final state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **140 paths** — 97 modified, 43 untracked |
| Final | **142 paths** — 97 modified, 45 untracked |
| Commit / push | none |
| `.env` | not read, printed, modified or replaced |

The two added paths are the M1.5 execution migration and the action-attempt migration. Existing M1.2,
M1.3-A, M1.3-B, M1.4 meetings, messages, approvals, minutes, reports and assets were preserved.

## 2. Migration

Applied:

- `20261211200000_meeting_action_execution`
- `20261211201000_meeting_action_attempt`

Additive changes:

### MeetingDecision

- `conditionsConfirmedAt`
- `conditionsConfirmedByUserId`

### MeetingActionItem

- `assigneeUserId` (human owner support)
- `activatedAt`
- `taskId`
- `botRunId`
- `executionAttempt`
- `startedAt`
- `completedAt`
- `resultStatus`
- `resultSummary`
- `evidence` JSON
- `blockedReason`
- `acceptanceStatus`

### MeetingActionAcceptance

- immutable id, meetingId, actionItemId
- actorUserId / actorName
- action (`ACCEPT`, `REQUEST_EVIDENCE`, `RE_EXECUTE`, `REJECT`, `BLOCK`)
- comment
- clientNonce
- createdAt
- unique `(actionItemId, clientNonce)`

No meeting, decision, turn, approval, message, action or acceptance row was deleted.

## 3. Execution lifecycle

```
Only approved decision:
  APPROVED (or APPROVED_WITH_CONDITIONS + conditions confirmed)
    -> activate linked action items (activatedAt)
    -> execute action (real Task/Run)
    -> action IN_PROGRESS
    -> Bot result SUCCESS/PARTIAL/FAILED/BLOCKED
    -> CEO acceptance
       ACCEPT -> COMPLETED
       REQUEST_EVIDENCE -> IN_PROGRESS
       RE_EXECUTE -> OPEN (new attempt)
       REJECT/BLOCK -> BLOCKED
```

- `PENDING`, `REJECTED` and `DEFERRED` decisions cannot activate or execute actions.
- Conditional approval does not activate anything until the CEO explicitly confirms conditions.
- Bot success leaves the action pending CEO acceptance; the Bot cannot mark an action COMPLETED.
- Failed/cancelled/empty runs become BLOCKED with a persisted failure reason.
- Repeated Execute returns the existing Task/Run for that action; no duplicate Task is created.
- CEO acceptance writes immutable acceptance history and does not change the decision approval.

## 4. Real meeting

**Glean Decision-to-Execution Review — M1.5**
`cmwdmmn7n00024at686gv4ujs`

- Started `2026-11-12 14:11:53 UTC`.
- Completed `2026-11-12 14:14:51 UTC`.
- Chair: CEO Assistant; participants Research Bot and Finance Bot plus HUMAN_CEO.
- One independent agenda decision:
  `cmwdmpy04001z23t6uovn7uf0` — **APPROVED_WITH_CONDITIONS**, approval PENDING initially.
- 12 persisted action items.

### CEO approval and activation

Approval `cmwdmr6qc000e4at6xapma19w`:

- action `APPROVE_WITH_CONDITIONS`;
- PENDING → APPROVED_WITH_CONDITIONS;
- actor RabbitBots Demo;
- timestamp `2026-11-12 14:15:25.140 UTC`;
- conditions: “Proceed only to a zero-cash, cost-capped information-acquisition stage; no spend-bearing
  step without a written ceiling and named approver.”

Conditions were explicitly confirmed by the CEO at `2026-11-12 14:16:19.736 UTC`; only then were the
linked actions activated.

### Real executed actions

Research Bot — `cmwdmqgy8002d23t6ta6n8z5t`
“Draft the instrument-scoping note for the two gated counterparty items”

- Task `cmwdnf7q50003t3t6c1u1qg9t`
- Run `cmwdnf7q90004t3t6vfugfp0d`
- Result `SUCCESS`
- Summary: drafted a desk-only instrument-scoping note; no request, NDA, contact, spend or external
  action.
- Evidence: four verifiable decision/record references persisted on the action.
- CEO acceptance `cmwdngwur000ct3t68n2xcn5b` — ACCEPT, “Accepted research execution result and
  evidence.”
- The action history also contains an earlier RE_EXECUTE record after the first attempt hit an
  output/tool-approval loop.

Finance Bot — `cmwdmqgyh002g23t6ycwnkpcz`
“Record the unresolved measurability of inference cost per query and per mode”

- Task `cmwdndczz0005ldt6bxhyz7l5`
- Run `cmwdndd010006ldt6pa6dx0vp`
- Result `SUCCESS`
- Summary: recorded the unresolved measurability of per-query/per-mode inference cost without
  asserting a price or commissioning an engagement.
- CEO acceptance `cmwdngx9g000dt3t61jr4nne9` — ACCEPT, “Accepted finance execution result and
  evidence.”

The two actions are now `COMPLETED` with `acceptanceStatus = ACCEPTED`; the others remain `OPEN` and
were not falsely completed. Formal minutes reports:

```
Progress: 10 open; 0 in progress; 2 completed; 0 blocked.
```

### Browser/refresh evidence

The meeting worker completed without a browser after creation/start. The execution/acceptance actions
were made in the Meeting Room, then the page was reloaded; both acceptance records and the action
statuses were still present.

## 5. Meeting Room UI

- Action items show assignee (Bot or human owner), execution status, acceptance criteria, due state,
  result status, result summary, evidence and blocked reason.
- Approved actions show **Run**.
- Conditional decisions show **Confirm conditions** before actions activate.
- Submitted results show **Accept**, **Request evidence**, **Re-run**, **Reject** and **Block**.
- CEO acceptance is confirmed in a dialog and persisted before the UI updates.
- Acceptance history shows actor, action, timestamp and comment.
- Formal minutes includes open/in-progress/completed/blocked counts, result/evidence, blocked reason
  and every acceptance record.
- The transcript remains read-only after completion; approval and execution controls remain usable.

## 5.1 Screenshots

- [CEO conditional approval and conditions confirmation](assets/phaseM15-approval.png)
- [Action items ready for execution](assets/phaseM15-actions-ready.png)
- [Bot execution results before CEO acceptance](assets/phaseM15-results.png)
- [CEO accepted action with history](assets/phaseM15-accepted.png)
- [Formal minutes with action progress and acceptance](assets/phaseM15-minutes.png)
## 6. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **65 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed**, 344 skipped |
| TypeScript | adapter-kit, contracts, adapters, API, web all passed |
| Production web build | passed |
| Biome | passed on changed files |
| Migrations | applied |

New action tests cover:

- unconfirmed conditional decision cannot execute;
- condition confirmation activates actions;
- exactly one Task/Run is created for repeated execute;
- CEO accept persists COMPLETED and actor/comment history;
- non-member acceptance rejected;
- failed result cannot be ACCEPTed and can be BLOCKed.

Existing M1.3-A messages, M1.3-B approvals, M1.4 chair/discussion/minutes and M1.2 agenda tests remain
green.

## 7. Files changed

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/meetings.ts`
- `packages/contracts/src/rpc.ts`
- `packages/adapters/src/meetings.ts`
- `packages/adapters/src/background-job-handlers.ts`
- `packages/adapter-kit/src/background-jobs.ts`
- `packages/adapter-kit/src/types.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/web/src/pages/MeetingsPage.tsx`
- `packages/adapters/src/meetings.approval.postgres.test.ts`

New:

- `packages/db/prisma/migrations/20261211200000_meeting_action_execution/migration.sql`
- `packages/db/prisma/migrations/20261211201000_meeting_action_attempt/migration.sql`
- `packages/adapters/src/meetings.orchestration.test.ts` (M1.4)
- `docs/reports/RABBITBOTS-PHASE-M1-5-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-5-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM15-*.png`

No commit or push was made.

## 8. Known limitations

1. The first broad Research action (“public displacement evidence”) entered a long tool-approval loop
   and was reset through the CEO RE_EXECUTE path; the completed Research task is the safer
   desk-only instrument-scoping action.
2. One Research action run hit the 1,200-token action budget; action execution now uses 3,000 tokens
   and the retry succeeded. This is a real model-output limitation, not hidden.
3. The Finance run's parsed `evidence` array is empty; the Research action carries the verifiable
   evidence required by the acceptance scenario. Both result summaries are persisted.
4. Re-execution overwrites the action's current `taskId`/`botRunId`/result; immutable acceptance
   history is retained but there is no separate execution-attempt table.
5. Human-owner actions are displayable/assignable but cannot be executed by a Bot; no human execution
   UI is implemented.
6. No payment, email, purchase or external irreversible action is authorized or executed by the
   action runtime.
7. No automated Playwright e2e or frontend component test; acceptance used a real browser.
8. The action-execution worker job uses the existing Task/Run runtime; no new execution engine was
   introduced.

## 9. PASS / NOT TESTED / BLOCKED

### PASS

- Real Research and Finance execution Runs.
- CEO approval → condition confirmation → activation.
- Real Task/Run linkage and result/evidence persistence.
- CEO acceptance, with immutable actor/comment history.
- Unapproved/invalid execution rejection and duplicate-task prevention.
- Failed result handling and BLOCKED state.
- Action progress in formal minutes.
- Refresh persistence and completed transcript read-only.
- Focused, web, API, TypeScript, build and Biome checks.

### NOT TESTED

- Human-owner action execution.
- Payment/external tool execution; deliberately forbidden.
- Multiple execution attempts as separately browsable records.
- Automated Playwright e2e / frontend component tests.
- A full end-to-end run where every one of the 12 generated actions is executed and accepted.

### BLOCKED

- None.

No commit or push was made.
