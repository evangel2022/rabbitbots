# RabbitBots Phase M1.1 — Meeting Reliability & Discussion Completion

Status: **PASS for the reliability vertical slice**, with the scope limits listed below. A fresh
Glean meeting progressed from PREPARING to COMPLETED while no browser was open, produced two real
participant discussion responses, completed a decision, and another live meeting was cancelled during
two active discussion response runs without generating a decision.

## 1. Initial and final Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Initial working tree | **119 paths** — 89 modified, 30 untracked |
| Final working tree | **130 paths** — 97 modified, 33 untracked |
| Commit / push | none |
| `.env` | not modified |

The three added untracked paths are the M1.1 migrations. No reset, clean, checkout or restore was
used. Existing M1 work and the completed M1 meeting were preserved.

## 2. M1.1-A — worker-driven reconciliation

### Architecture

```
meetings.start (API)
  -> enqueue meeting.reconcile (keyed by meeting id)
worker run.continue for a meeting turn
  -> after the stage attempt, enqueue meeting.reconcile
worker meeting.reconcile
  -> reconcileMeeting() claims a 90s DB lease
  -> advanceMeeting()
  -> next stage creates real Task/Run rows with trigger meeting_turn
worker reconciliation sweep (every 30s)
  -> active meetings older than 60s -> enqueue meeting.reconcile
meetings.get (API)
  -> read-only persisted view
```

The API no longer calls `advanceMeeting`. `meetings.get` is read-only, and the UI only refreshes.
There is no browser dependency for progression.

### Files

- `packages/adapter-kit/src/background-jobs.ts` — `meeting.reconcile` payload, keyed builder and
  `meetingReconcileJobKey`.
- `packages/adapter-kit/src/types.ts` — payload/handler type.
- `packages/adapters/src/background-job-handlers.ts` — owner-scoped job handler; the `run.continue`
  handler enqueues reconciliation after a meeting turn.
- `packages/adapters/src/job-reconciler.ts` — periodic meeting recovery pass.
- `packages/adapters/src/run-runtime.ts` — wires the sweep into the existing worker reconciler.
- `packages/adapters/src/meetings.ts` — `reconcileMeeting`, `reconcileActiveMeetings`, lease and
  status guards.
- `apps/api/src/routes/meetings.ts` — read-only `get`, worker-owned `start`.

### Idempotency

- One queue job per meeting with `replaceKey = meeting.reconcile:<meetingId>` and `maxAttempts: 8`.
- A meeting reconciliation lease (`reconcileLeaseUntil`) serializes concurrent deliveries. An expired
  lease is reclaimable after a crashed worker; a successful pass releases the lease.
- Real runs use deterministic `clientNonce` values; `Run (spaceId, clientNonce)` is unique.
- Meeting turns are protected by
  `@@unique([meetingId, phase, participantBotId, round])`.
- Decisions and action items use unique keys and upserts:
  `meeting_decisions(meetingId, agendaId)`, `meeting_action_items(decisionId, title)`.
- `createTurnRun` checks that the meeting is still active after cancellation.
- `finishDecision` re-checks that the meeting is still in `DECISION` before persisting final minutes.
- A completed stage is never re-created: existing turn/run rows are reused, and duplicate start
  remains idempotent.

### Recovery

The worker's existing reconciliation loop now calls `reconcileActiveMeetings`. Meetings in
PREPARING/OPENING/REPORTING/DISCUSSION/DECISION/CLOSING with `updatedAt` older than 60 seconds get
one keyed reconciliation job. The lease prevents a duplicate from double-advancing. A live job is
preserved with `keepExisting`; a job locked by a dead worker can be replaced after `replaceLockedBefore`.

### Migrations

- `20261211150000_meeting_reliability` — cancellation fields, `Run.maxOutputTokens`, meeting
  turn/decision/action uniqueness.
- `20261211151000_meeting_reconcile_lease` — reconciliation lease.
- `20261211152000_meeting_participant_threads` — participant `threadId` cache.

All three were applied with `prisma migrate deploy`. No data was deleted.

## 3. M1.1-B — real participant discussion

The old single chair `DISCUSSION` turn was replaced by a bounded phase sequence:

1. `DISCUSSION_QUESTION` — the chair identifies material disagreement and returns a structured
   question and participant list.
2. `DISCUSSION_RESPONSE` — each selected participant receives a real Task/Run. The prompt includes
   the question, reports, and a facts/assumptions/evidence/risks/recommendation structure; it must
   say `NO_NEW_INFORMATION` rather than repeat itself.
3. `DISCUSSION_EVALUATION` — the chair evaluates the responses and returns:
   `needsAnotherRound`, `reason`, `newEvidence`, `question`.
4. If and only if there is named new evidence, a question, and the round is below the agenda's
   `maxDiscussionRounds` (hard ceiling 2), a final question round is created. A second evaluation
   cannot start a third round.
5. The meeting then forces DECISION.

Selection falls back to all reporting participants if the chair's named roles cannot be resolved.
The chair is never selected. A participant who failed remains visibly failed and does not block the
meeting. Dissent is preserved in the decision prompt and output.

The real M1.1 meeting produced two real `DISCUSSION_RESPONSE` runs. Both completed, the chair evaluated
them, and the decision followed. A PostgreSQL test also exercises the two-round ceiling, duplicate
response prevention and a round-2 `needsAnotherRound: true` response that cannot open round 3.

## 4. M1.1-C — live cancellation

`cancelMeeting` now runs in a transaction that locks the meeting row, writes
`status = CANCELLED`, `cancelledAt`, `cancellationReason`, and `completedAt`, then calls
`cancelRunsInTransaction` for every active run linked through a meeting turn. It uses the shared
core `ACTIVE_RUN_STATUSES`, including `waiting_input`; an early implementation omitted that status
and left paused participant runs active, so the final implementation imports the shared set.

After commit it removes the meeting reconciliation key and each active run's queue key. Late
completion is ignored because:
- every advance starts with terminal-status checks;
- `createTurnRun` refuses to create work for a terminal meeting;
- `finishDecision` refuses to persist decisions if the meeting is no longer in DECISION.

No provider process is forcibly killed. The runtime's durable `cancelled` status and queue removal
are the supported controls; a provider request already in flight can still finish at the provider.
The meeting remains CANCELLED, and no late output can advance it. This limitation is explicit.

### Real cancellation evidence

Meeting `cmwbp86t30002b6t6r37iehyb`:

- started 2026-11-11 13:49:05 Asia/Shanghai;
- cancelled 13:49:34 while **two `DISCUSSION_RESPONSE` runs were active**;
- reason: `Cancelled during live participant discussion.`;
- final status CANCELLED;
- **0 decisions**, no DECISION turn;
- all meeting runs terminal/cancelled, 0 active;
- opening, two reports, question and both pending response turns remain in the transcript.

## 5. M1.1-D — response length

`Run.maxOutputTokens` is nullable and is copied into the runtime's `AgentRunModel.maxTokens`; the
existing Pi/OpenRouter completion budget path applies the provider request cap. Meeting turns set:

| Phase | Provider cap |
| --- | --- |
| OPENING | 500 |
| REPORTING | 1,200 |
| DISCUSSION_QUESTION | 800 |
| DISCUSSION_RESPONSE | 800 |
| DISCUSSION_EVALUATION | 800 |
| DECISION | 2,400 |

The original 500-token attempt was tested first. A worker-closed smoke meeting showed the Finance
report failing with `The model hit its output limit before writing a response.` Reason-capable
models spend completion budget before writing. The reporting budget was raised to 1,200; discussion
turns use a bounded 800; the structured decision needs 2,400 to remain valid JSON. **This is a
deviation from the original 500-token target and is documented as a limitation, not hidden.**

Returned text is also validated before it is accepted: normal meeting text above 12,000 characters,
or a decision above 32,000 characters, is marked FAILED instead of being silently truncated. The
decision parser still applies its bounded one-retry rule for malformed JSON.

## 6. Real M1.1 meeting

**Glean Strategic Investment Review — M1.1**
Meeting id: `cmwboxa5i0004axt6t1l0e05n`

Created 13:40:36, started 13:40:36, completed **13:47:07** Asia/Shanghai. The browser was closed
immediately after start and no `meetings.get` polling was used. The worker progressed the meeting
through all stages.

| Turn | Round | Run id | Run status | Cap |
| --- | --- | --- | --- | --- |
| OPENING | 1 | `cmwboxa7g0001apt61xv0fu9p` | completed | 500 |
| REPORTING Research | 1 | `cmwboxczi0008apt6rhzmy0bm` | completed | 1,200 |
| REPORTING Finance | 1 | `cmwboxczu000aapt6t69clu95` | completed | 1,200 |
| DISCUSSION_QUESTION | 1 | `cmwbp2md900bqapt6m40x7zcx` | completed | 800 |
| DISCUSSION_RESPONSE Research | 1 | `cmwbp2pul00c6apt6dzfgz0et` | completed | 800 |
| DISCUSSION_RESPONSE Finance | 1 | `cmwbp2puy00c8apt6gkdausmm` | completed | 800 |
| DISCUSSION_EVALUATION | 1 | `cmwbp3u3t00xeapt6ijjyu6m3` | completed | 800 |
| DECISION attempt 1 | 1 | `cmwbp457f00xtapt68zbie0sd` | completed but invalid JSON | 2,400 |
| DECISION retry | 2 | `cmwbp51sr00y3apt66g9ady6s` | completed | 2,400 |

Result: **5 decisions, 5 action items, 9 turns**, executive summary persisted. Decision types:
2 × `APPROVED_WITH_CONDITIONS` with `approvalRequired = true` / `approvalStatus = PENDING`, and 3 ×
`DEFERRED`. No human approval is claimed. Action items have Bot assignees and **no fabricated due
dates**.

Screenshots:

- [Completed boardroom](assets/phaseM11-completed-focus.png)
- [Participant discussion question and real response](assets/phaseM11-discussion-focus.png)
- [Decisions and approval state](assets/phaseM11-decisions-focus.png)
- [Action items](assets/phaseM11-actions-focus.png)
- [Cancelled live meeting](assets/phaseM11-cancelled-focus.png)

The chair's generated summary says “13:30–13:46”; the persisted `startedAt`/`completedAt` are
13:40:36/13:47:07. The model-authored minutes contain an inaccurate time phrase. The database times
and run timestamps are authoritative. This is a model-quality limitation, not a timestamp generated
by the orchestrator.

## 7. Tests executed

| Suite | Result |
| --- | --- |
| `meetings.test.ts` unit | **11 passed** |
| `meetings.postgres.test.ts` | **7 passed** — partial report, both fail, timeout, two-round discussion, live cancellation + late result, duplicate reconciliation/lease, cross-space isolation |
| `orchestration.postgres.test.ts` | **10 passed** |
| `background-jobs.test.ts` | **10 passed** |
| Full web | **229 files / 2,030 tests passed** |
| API | **94 files / 1,680 tests passed; 344 skipped** (DB-gated tests) |
| TypeScript: adapter-kit, contracts, adapters, API, web | **all passed** |
| Production web build | **passed** |
| Biome check on M1.1 files | no errors; one non-blocking warning |

The real meeting and cancellation were also exercised through the live API and the existing Graphile
worker with no browser open. No Playwright e2e suite was run.

## 8. Files changed

New M1.1 migrations:

- `packages/db/prisma/migrations/20261211150000_meeting_reliability/migration.sql`
- `packages/db/prisma/migrations/20261211151000_meeting_reconcile_lease/migration.sql`
- `packages/db/prisma/migrations/20261211152000_meeting_participant_threads/migration.sql`

Modified for M1.1:

- `packages/adapter-kit/src/background-jobs.ts`
- `packages/adapter-kit/src/types.ts`
- `packages/adapters/src/background-job-handlers.ts`
- `packages/adapters/src/job-reconciler.ts`
- `packages/adapters/src/run-runtime.ts`
- `packages/adapters/src/executor.ts`
- `packages/adapters/src/meetings.ts`
- `packages/contracts/src/meetings.ts`
- `packages/contracts/src/rpc.ts`
- `packages/db/prisma/schema.prisma`
- `apps/api/src/routes/meetings.ts`
- `apps/web/src/pages/MeetingsPage.tsx`
- test files for meetings, job contracts and wakeup handler maps

Existing M1 files and reports were preserved. `packages/adapters/src/meetings.ts` and
`apps/web/src/pages/MeetingsPage.tsx` existed as untracked M1 work and were extended rather than
recreated.

## 9. Known limitations / remaining work

1. **Per-agenda discussion coverage.** The current discussion phase runs for the first open agenda
   item and enforces the two-round ceiling there. It does not yet loop a full discussion through
   every agenda item. The real M1.1 meeting therefore discusses agenda item 1, then the decision
   covers all five items.
2. **Approvals surface in the normal Bot chat.** Meeting participant runs use the existing Bot
   threads so approval cards remain reachable. The meeting page does not yet render or answer those
   approvals. A hidden-thread isolation was attempted and removed because it made participant
   approvals unreachable; this is the reason the delivered runs use normal threads.
3. **No forced provider termination.** Cancellation cancels durable Runs, attempts and Tasks and
   removes queue jobs, but a provider request already streaming can still finish. Late output is
   ignored and cannot reopen or advance the meeting.
4. **500-token cap is not global.** The strict 500 cap applies to opening; participant discussion
   uses 800 because 500 produced empty reasoning-limit failures; reports use 1,200 and the structured
   decision 2,400. These are bounded provider caps, not prompt-only.
5. **Model-authored minutes can contain inaccurate dates/times.** The real summary has a time phrase
   that disagrees with persisted timestamps. Do not treat prose timestamps as evidence.
6. **No client-disconnected worker restart test.** The lease and stale sweep are covered by a
   concurrency/sweep test; a process kill at an exact stage was not exercised in this environment.
7. No Playwright e2e; the 344 skipped API tests require their database fixtures.
8. No external human-approval workflow; approvals remain pending records.

## 10. PASS / BLOCKED / NOT TESTED

### PASS

- Worker-driven meeting progression with no browser open.
- Keyed job scheduling, duplicate delivery protection, reconciliation lease and stale sweep.
- Read-only `meetings.get`.
- Real participant discussion response, chair evaluation, bounded second round and forced decision.
- Live cancellation during two active participant runs, with zero decisions and late-result guard.
- Per-run provider output caps and length validation.
- Real Glean meeting with two participant responses, 5 decisions, 5 action items and pending human
  approval.
- Focused tests, existing orchestration, full web, API and build.

### NOT TESTED

- Worker process kill at each exact intermediate stage (lease/sweep logic tested, not process kill).
- Forced provider request termination.
- Discussion rounds for every agenda item.
- Full Playwright e2e and every DB-gated API suite.

### BLOCKED

- None for this M1.1 vertical slice. The remaining items are scope extensions, not environment blockers.
