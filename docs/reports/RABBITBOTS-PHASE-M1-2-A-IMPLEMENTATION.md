# RabbitBots Phase M1.2-A — Per-Agenda Discussion & Decision

Status: **PASS for the per-agenda lifecycle**, with the evidence limitations listed below. The
orchestrator now gives every agenda its own review, participant discussion, evaluation and persisted
decision, then produces one executive summary and action list after all five agendas.

## 1. Git baseline and final state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Initial working tree | **130 paths** — 97 modified, 33 untracked |
| Final working tree | **132 paths** — 97 modified, 35 untracked |
| Commit / push | none |
| `.env` | not modified |

The two new untracked paths are the per-agenda turn-key migration and the per-agenda PostgreSQL test
file. Existing M1/M1.1 work, database records and volumes were preserved. No destructive Git
operation was used.

## 2. Architecture change

The single meeting-wide discussion/decision tail was replaced with a deterministic per-agenda loop
inside `advanceMeeting`:

```
REPORTING complete
  -> DISCUSSION
     for each agenda with no terminal decision:
       ACTIVE
       -> AGENDA_REVIEW (chair: material disagreement? structured question? participants?)
       -> AGENDA_RESPONSE (one real Bot Run per selected participant, round 1)
       -> AGENDA_EVALUATION (chair: new evidence? another round?)
       -> optional AGENDA_REVIEW round 2 (only with named new evidence)
       -> optional AGENDA_RESPONSE/AGENDA_EVALUATION round 2
       -> AGENDA_DECISION (one decision for this exact agenda ID)
       -> DECIDED or DEFERRED
     -> CLOSING
     -> SUMMARY (one chair run over the five persisted decisions)
     -> COMPLETED
```

The chair can set `materialDisagreement=false`; then no participant runs or evaluation are created
and the agenda moves directly to its decision. A failed review or evaluation remains visibly failed
and produces an honest `DEFERRED` decision rather than a fabricated conclusion.

### Turn identity and migration

`MeetingTurn` previously had a unique key that omitted the agenda, so agenda 2 could collide with
agenda 1. The additive migration
`20261211160000_meeting_agenda_turn_key` replaces it with:

```
(meetingId, agendaId, phase, participantBotId, round)
```

The deterministic run nonce and turn ID now include the agenda ID. Different agendas cannot reuse or
overwrite turns, and a participant can speak at most once per agenda per round. The migration dropped
only the old index and preserved all rows.

`MeetingAgenda.status` now progresses through `PENDING`, `ACTIVE`, `DISCUSSION`, `DECIDED`, and
`DEFERRED`. A new agenda is selected only when every earlier agenda has a persisted decision.

### Decisions and final summary

- One `MeetingDecision` per agenda, upserted by `(meetingId, agendaId)`.
- Exact agenda ID, type, statement, rationale, evidence, risks, dissent, conditions and approval
  state are preserved.
- All approval flags remain `PENDING` when required; no external action is taken.
- No decision is combined across agendas.
- After all five decisions, the `SUMMARY` run receives the persisted decisions and returns one
  executive summary, minutes and action items.
- Action items link to the matching agenda decision and keep `dueAt = null` when no date was given.
- The summary task is unique by meeting/phase; a retry cannot create a second final summary.

### Worker, recovery and cancellation

The M1.1 worker architecture is unchanged:

- start and every meeting-turn run enqueue `meeting.reconcile`;
- `reconcileMeeting` holds the 90-second lease;
- stale active meetings are swept every 60 seconds;
- `meetings.get` remains read-only;
- duplicate jobs cannot create duplicate turns or decisions.

Recovery derives the current agenda from its persisted status and phase, then resumes only the missing
review/response/evaluation/decision. Completed agenda decisions are never replayed.

Cancellation and late-result guards remain: cancellation writes CANCELLED and cancellation reason,
cancels active meeting runs/jobs, and blocks new turns and decision persistence. The M1.1 PostgreSQL
cancellation test still passes.

## 3. Frontend

`MeetingsPage.tsx` now lets the operator select an agenda. The agenda list shows:

- Pending / Active / Discussion / Decided / Deferred;
- actual discussion round / maximum rounds;
- completed participant response count;
- decision type and pending-approval label.

The centre pane filters the transcript to the selected agenda (opening remains visible), shows the
chair's actual question and response count, and keeps the meeting-level opening/summary distinct. The
right column shows the selected agenda's decision with rationale, evidence, risks, dissent and
conditions, plus the **Overall meeting summary** and pending human approvals. No progress is
fabricated.

## 4. Real M1.2-A investor meeting

Meeting **Glean Strategic Investment Review — M1.2-A**
ID `cmwc3xuu40002w2t68qx9w9go`

- Started `2026-11-11 12:36:15` UTC (20:36 Asia/Shanghai).
- Completed `12:40:04` UTC (20:40 Asia/Shanghai).
- Browser was closed immediately after start; no client polling was used.
- Five agenda decisions, seven action items, one final summary.
- All five agenda decisions were **DEFERRED** because the record did not support closing them; this
  is an honest evidence outcome, not a fabricated approval.

| Agenda | Decision ID | Type | Approval |
| --- | --- | --- | --- |
| 1 Market opportunity | `cmwc3z9bh001svwt6eq0xaslr` | DEFERRED | NOT_REQUIRED |
| 2 Competitive position | `cmwc410jq0033vwt63uti2lxa` | DEFERRED | NOT_REQUIRED |
| 3 Financial feasibility | `cmwc42fo10047vwt6veul0i01` | DEFERRED | NOT_REQUIRED |
| 4 Key investment risks | `cmwc43ro6005cvwt6bghao5pg` | DEFERRED | NOT_REQUIRED |
| 5 Final recommendation | `cmwc44256005jvwt614vyg4fj` | DEFERRED | NOT_REQUIRED |

Key real Runs:

- Opening `cmwc3xuwt0001vwt60w9ixxgc`
- Research report `cmwc3xx6f0008vwt659uzw4gh`
- Finance report `cmwc3xx6t000avwt6zeaf2jg1`
- Agenda 1 review `cmwc3y6tz000ovwt6add48zf0`
- Agenda 1 responses `cmwc3ydnn000wvwt66l8ixeip`, `cmwc3ydnz000yvwt6c0aq3ryu`
- Agenda 1 decision `cmwc3yvkx001lvwt62vc10x8w`
- Agenda 2 review `cmwc3z9by001uvwt6iux3c2pn`
- Agenda 2 decision `cmwc40few002wvwt6q1pi13ge`
- Agenda 3 decision `cmwc41uxs0040vwt6upttr8ky`
- Agenda 4 decision `cmwc438r30055vwt6salfekt4`
- Final summary `cmwc4425o005lvwt62bv99idu`

The final summary names all five persisted decisions and avoids inventing a sixth. Seven action
items are linked to the agenda decisions with real Bot assignees and null due dates where unspecified.

Screenshots:

- [Completed M1.2-A boardroom](assets/phaseM12A-completed-focus.png)
- [Selected agenda detail](assets/phaseM12A-agenda-focus.png)
- [Overall meeting summary](assets/phaseM12A-summary-focus.png)
- [Agenda decision](assets/phaseM12A-decisions-focus.png)
- [Action items](assets/phaseM12A-actions-focus.png)

## 5. Evidence limitations in this run

This real run was completed before the final review/evaluation token-budget correction was applied.
It therefore contains visible machinery failures:

- agenda 2 and agenda 3 chair evaluations hit the 800-token output ceiling;
- one agenda 4 participant response hit the 800-token ceiling;
- the agenda 5 chair review hit the output ceiling;
- the agenda 1-3 summary text says the chair review was unusable, and those decisions are DEFERRED.

The fallback decisions are honest `DEFERRED` records, not fabricated conclusions. After this run the
per-agenda budgets were raised to 2,000 tokens for review, 1,200 for participant responses, 2,000 for
evaluation, 2,400 for decision and 3,200 for summary. A subsequent five-agenda run was started to
verify those budgets but was cancelled before completion; it is not cited as evidence.

The implementation therefore proves the per-agenda state machine and persistence with the completed
run above, but the final budget setting has not yet completed a five-agenda investor run.

## 6. Tests executed

| Suite | Result |
| --- | --- |
| `meetings.test.ts` unit | **15 passed** |
| `meetings.postgres.test.ts` M1/M1.1 regressions | **7 passed** |
| `meetings.agenda.postgres.test.ts` | **1 passed** — two independent agendas, no-discussion skip, per-agenda decision IDs, one summary/action |
| `orchestration.postgres.test.ts` | **10 passed** |
| `background-jobs.test.ts` | **10 passed** |
| Full web | **229 files / 2,030 tests passed** |
| API | **94 files / 1,680 tests passed; 344 skipped** |
| TypeScript (adapter-kit, contracts, adapters, API, web) | **all passed** |
| Production web build | **passed** |
| Biome check on M1.2-A files | no errors |

Focused total: **43 passing tests**. The new per-agenda DB test exercises two agenda decisions,
no-material-disagreement skipping, exact agenda IDs, unique turn keys and the final summary. The
real meeting exercises five agendas and the worker path with the browser closed.

## 7. Files changed for M1.2-A

New:

- `packages/db/prisma/migrations/20261211160000_meeting_agenda_turn_key/migration.sql`
- `packages/adapters/src/meetings.agenda.postgres.test.ts`
- `docs/reports/RABBITBOTS-PHASE-M1-2-A-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-2-A-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM12A-*.png`

Modified:

- `packages/db/prisma/schema.prisma` — agenda-inclusive turn uniqueness
- `packages/adapters/src/meetings.ts` — per-agenda loop, parsers, decisions, summary, budgets
- `packages/adapters/src/meetings.test.ts` — per-agenda parser/token unit tests
- `packages/adapters/src/meetings.postgres.test.ts` — M1/M1.1 behavior adapted to the per-agenda flow
- `packages/contracts/src/meetings.ts` — new phases
- `apps/web/src/pages/MeetingsPage.tsx` — agenda selection, status/rounds/responses and selected decision
- `docs/reports/RABBITBOTS-PHASE-M1-2-A-BASELINE.md` — baseline (new)

Existing M1/M1.1 reports, worker code, cancellation guards, database data and Docker volumes were
preserved. No commit or push was made.

## 8. Known limitations / remaining work

1. The completed five-agenda run has **all five decisions DEFERRED** and several visible review/
   evaluation failures because it predated the final budget correction. A full five-agenda run on the
   final budget setting remains to be completed.
2. Per-agenda review/evaluation output is still verbose and can hit token ceilings. The parser has
   tolerant extraction for malformed decision JSON, but structured model output remains fragile.
3. The two-round branch is implemented and guarded, but the completed real run used one round. The
   two-round ceiling is covered by unit/state logic and the per-agenda test setup, not by a second
   live full meeting.
4. Cancellation during agenda 2 of a five-agenda meeting was not exercised live in M1.2-A; M1.1
   cancellation and late-result tests pass and the same guards are in the path.
5. The UI shows an agenda-specific transcript and decision, but the agenda list still contains older
   verification meetings in this working database; those are test artifacts, not product data.
6. The normal Bot chat approval cards remain the approval surface; the meeting UI does not answer
   them.
7. No Playwright e2e and no full DB-gated API suite were run.

## 9. PASS / BLOCKED / NOT TESTED

### PASS

- Per-agenda activation and review.
- Independent real participant responses and evaluations where the model produced them.
- One decision per agenda with exact agenda ID.
- No-discussion path when the chair reports no material disagreement.
- Agenda-level decisions plus one final summary/action list.
- Worker-driven five-agenda meeting with browser closed.
- Read-only polling and cancellation guards preserved.
- Per-agenda UI selection and detail.
- Focused, web, API and build checks.

### NOT TESTED

- A completed five-agenda run on the final 2,000/1,200/2,000/2,400/3,200 budgets.
- Live cancellation specifically during agenda 2.
- A live two-round agenda.
- Full Playwright e2e and every DB-gated API test.

### BLOCKED

- None. The remaining items are verification/quality work, not environment blockers.
