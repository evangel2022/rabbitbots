# RabbitBots Phase M1.4 — Executive Meeting Orchestration

Status: **PASS** for the chair-led executive meeting vertical slice, with the limitations listed below.

A fresh real-Bot meeting ran under CEO Assistant as chair, with Research and Finance taking different
positions, a two-round bounded discussion, independent decisions, evidence-based deferral, linked
action items, a CEO conditional approval and a formal minutes view that reflects persisted approvals.

## 1. Git baseline and final state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **138 paths** — 97 modified, 41 untracked |
| Final | **140 paths** — 97 modified, 43 untracked |
| Commit / push | none |
| `.env` | not read, printed, modified or replaced |

The two added paths are the M1.4 additive migration and the orchestration test. All M1.3-A human
messages, M1.3-B approvals, M1.2 records, reports and assets remain intact.

## 2. Meeting flow

The existing M1.2 per-agenda state machine is preserved:

```
REPORTING
  -> for each agenda:
       AGENDA_REVIEW (chair: state, consensus, disagreement, gaps, question, participants)
       -> AGENDA_RESPONSE (role-specific Bot, round 1)
       -> AGENDA_EVALUATION (new evidence? another round? which participants?)
       -> optional AGENDA_REVIEW/RESPONSE/EVALUATION round 2
       -> AGENDA_DECISION (one per agenda)
   -> SUMMARY
   -> COMPLETED
   -> CEO approval remains available in the Meeting Room
```

Changes made for M1.4:

- the chair review now emits and persists an explicit discussion state:
  `AGREEMENT`, `DISAGREEMENT`, `INSUFFICIENT_EVIDENCE`, `UNRESOLVED`;
- the chair records consensus, disagreements and evidence gaps for the stage summary;
- round 2 receives the earlier-round responses and is explicitly told not to repeat them;
- round 2 invites only the participants named by the chair evaluation;
- decisions store `supportingOpinions` and `evidenceGaps` in addition to existing evidence, risks
  and dissenting opinions;
- action items store `acceptanceCriteria`;
- the final summary asks for an acceptance criterion for each action;
- a server-derived **formal minutes** view is built on every read from persisted decisions, approval
  history, turns, agenda and action items.

The M1.3-B approval service remains the only approval path. It still enforces one final transition,
server-derived actor, idempotency and immutable history.

## 3. Data model and migration

Additive migration `20261211190000_meeting_formal_minutes` — **applied**:

- `MeetingDecision.discussionState` (default `UNRESOLVED`)
- `MeetingDecision.supportingOpinions` JSON
- `MeetingDecision.evidenceGaps` JSON
- `MeetingActionItem.acceptanceCriteria` (default `""`)

No existing decision, action, turn, approval, meeting or transcript row was deleted or rewritten.
`MeetingDecisionView`, action views and `MeetingView.formalMinutes` were extended.

## 4. Real meeting

**Glean Executive Investment Review — M1.4-C**
`cmwc9so6u000putt63qoq4ve3`

- Started `2026-11-11 15:24:53 UTC` (23:24 Asia/Shanghai).
- Completed `2026-11-11 15:30:54 UTC` (23:30 Asia/Shanghai).
- Browser closed after creation/start; the worker completed the meeting independently.
- Chair: CEO Assistant.
- Participants: RabbitBots Demo (HUMAN_CEO), Research Bot, Finance Bot.
- 2 independent agenda decisions.
- 12 action items, all linked to their agenda decision.
- 1 CEO approval pending/approved path; no fabricated approval.

### Agenda outcomes

| Agenda | Decision | Type | Discussion state | Round(s) | Approval |
| --- | --- | --- | --- | --- | --- |
| Market opportunity | `cmwc9w1750073u1t6ex8akpwq` | APPROVED_WITH_CONDITIONS | **DISAGREEMENT** | **2** | APPROVED_WITH_CONDITIONS |
| Financial feasibility | `cmwc9yrbb008au1t6mmb5bkg6` | DEFERRED | UNRESOLVED | 1 | NOT_REQUIRED |

The first agenda is the real disagreement case:

- Chair review round 1 found a material disagreement about whether the market window supplies urgency
  and whether the two lanes actually disagreed on conduct.
- Research and Finance both responded; Finance's first-round run failed visibly and was not treated
  as agreement.
- The chair evaluation found new evidence and opened a second round, naming Finance as the relevant
  participant.
- Round 2 was confined to the unanswered evidence point; the chair evaluation then stopped discussion.
- No third round was created.
- Decision state `DISAGREEMENT`; supporting opinions, opposing opinions and evidence gaps are persisted.

The second agenda is the deferral case:

- The chair found a material financial-evidence dispute.
- Only Finance was invited; its response resolved the gate question but not the financial feasibility.
- The decision is **DEFERRED**, explicitly stating feasibility was not established; it is not an
  approval.
- The persisted state is `UNRESOLVED` because a gate remains unresolved. The `INSUFFICIENT_EVIDENCE`
  state is supported by the contract/parser and a supplementary real M1.4 run
  (`cmwc9hpsq0002utt6ykghwd8j`, financial feasibility `DEFERRED` with
  `INSUFFICIENT_EVIDENCE`).

### Action items

12 action items were persisted. Representative examples:

- “Put the agenda 1 recommendation to the human owner with its pending status on its face” — agenda 1
  decision, Chairperson, acceptance criterion present, `OPEN`.
- “Request only the two obtainable-without-spend deliverables, in writing and dated” — agenda 1
  decision, Finance Bot, acceptance criterion present, `OPEN`.
- “Resolve Finance's inverted conditional on the record” — agenda 2 decision, Finance Bot, acceptance
  criterion present, `OPEN`.
- “Set the spend ceiling, per-step caps and named approver before any spend-bearing step” — agenda 2
  decision, Chairperson, acceptance criterion present, `OPEN`.

Every action has `acceptanceCriteria`; all `dueAt` values are null because no date was established.
No action was marked `COMPLETED`.

### CEO approval

Approval `cmwca26890011utt6csgg7ipe` for the agenda 1 decision:

- action `APPROVE_WITH_CONDITIONS`;
- previous `PENDING` → `APPROVED_WITH_CONDITIONS`;
- actor RabbitBots Demo (`SeQBX2Bj7UYmjn2OArYT3MVSEkwzy49R`);
- timestamp `2026-11-11 15:32:16.521 UTC`;
- conditions: “Proceed only to a zero-cash, cost-capped data stage; no spend-bearing step without a
  written ceiling and named approver.”;
- rationale: “CEO conditional approval after the M1.4 executive review.”

The approval was made in the Meeting Room after the meeting was COMPLETED. It did not reopen the
meeting or modify the transcript. The page was refreshed and the approval/history remained.

## 5. Formal minutes

The server builds `MeetingView.formalMinutes` on every read from persisted records; it is not a
temporary frontend string. It includes:

- meeting title, objective, chair and database timestamps;
- human and Bot participants with roles;
- every agenda, discussion state, rounds and completed response count;
- the Chair recommendation explicitly labelled **“Bot, not CEO approval”**;
- basis, supporting opinions, opposing opinions, unresolved risks and evidence gaps;
- the CEO approval status and every immutable approval record with actor, time, rationale and
  conditions;
- the Chair's closing summary, labelled as such;
- every action item with assignee, linked agenda/decision, status, due date and acceptance criterion;
- aggregate unresolved risks and evidence gaps.

The formal minutes therefore distinguishes Bot recommendations, the chair's historical closing
summary and the current CEO approval record. It is refreshed from the same persisted rows after the
CEO approves.

The current minutes include `CEO approval: APPROVED WITH CONDITIONS` and the approval record above;
the chair's historical closing summary still contains the language “approval PENDING” because it was
generated at meeting close. The UI labels that separate panel **Chair closing summary**, while the
**Formal meeting minutes** is current.

## 6. UI

- Chair/participants/roles and the current agenda remain visible.
- Chair review card now shows discussion state, consensus, disagreement and evidence gaps when the
  chair supplied them.
- Agenda cards show actual discussion rounds (decision retries do not inflate them).
- Decision cards show discussion state, supporting/opposing opinions and evidence gaps.
- Action items show acceptance criteria.
- Formal meeting minutes appear below the transcript and survive refresh.
- Pending/finalized CEO approvals use the M1.3-B confirmation flow; the transcript remains read-only
  after completion.
- Internal structured review/decision turns are no longer dumped as raw JSON in the transcript.

## 7. Screenshots

- [Pending approval on the completed M1.4-C meeting](assets/phaseM14-pending.png)
- [Chair review, disagreement and evidence gaps](assets/phaseM14-review.png)
- [CEO conditional approval confirmation](assets/phaseM14-confirmation.png)
- [Approved state after refresh](assets/phaseM14-approved.png)
- [Formal meeting minutes with decisions/actions](assets/phaseM14-minutes.png)

## 8. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **62 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed; 344 skipped** |
| TypeScript | adapter-kit, contracts, adapters, API, web all passed |
| Production web build | passed |
| Biome | passed on changed files |
| Migration | applied |

New M1.4 orchestration tests cover:

- chair state/consensus/disagreement/evidence-gap parsing;
- second-round gate: named new evidence, focused question and selected participants;
- decision discussion state, supporting opinions and evidence gaps;
- two-round ceiling.

Existing tests continue to cover:

- per-agenda independence and exact decision IDs;
- one summary/action path;
- M1.3-A human message persistence and cursor replay;
- M1.3-B approval authority, conflicts, idempotency and immutable history;
- formal minutes containing approval records and action acceptance criteria.

## 9. Files changed

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/meetings.ts`
- `packages/adapters/src/meetings.ts`
- `packages/adapters/src/meetings.test.ts`
- `packages/adapters/src/meetings.approval.postgres.test.ts`
- `apps/web/src/pages/MeetingsPage.tsx`

New:

- `packages/db/prisma/migrations/20261211190000_meeting_formal_minutes/migration.sql`
- `packages/adapters/src/meetings.orchestration.test.ts`
- `docs/reports/RABBITBOTS-PHASE-M1-4-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-4-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM14-*.png`

No commit or push was made.

## 10. Known limitations

1. `formalMinutes` is a server-derived view over persisted rows, not a separately stored text column.
   It survives refresh because all source rows are durable.
2. The primary M1.4-C deferred agenda is `UNRESOLVED`; `INSUFFICIENT_EVIDENCE` is covered in a
   supplementary real run and in tests.
3. Finance's first-round response on agenda 1 failed visibly due a provider output-limit failure; the
   chair evaluation correctly opened a second round rather than treating silence as agreement.
4. The chair's closing summary is historical and can say “pending” after a later CEO approval; the
   formal minutes is the current approval source of truth.
5. No automated Playwright e2e or dedicated frontend component tests were added; the live browser was
   used for acceptance.
6. Approval remains one final transition per decision, with no amend/revoke workflow.
7. No voice/video or multi-human approval delegation.

## 11. PASS / NOT TESTED / BLOCKED

### PASS

- CEO Assistant chairing and explicit chair stage summaries.
- Research/Finance role-specific participation.
- Independent agenda progression.
- Real material disagreement with two bounded rounds and no third.
- Deferred financial feasibility decision.
- Independent agenda decisions and linked acceptance-criteria action items.
- Existing CEO approval flow in the Meeting Room.
- Formal persisted-source minutes reflecting CEO approval.
- Refresh persistence and read-only completed transcript.
- Worker progression with browser closed.
- Focused, web, API, TypeScript, build and Biome checks.

### NOT TESTED

- Voice/video and screen sharing.
- Multiple human approvers or delegated approval.
- Approval amendment/revocation.
- Automated Playwright e2e in CI.
- A real meeting whose only deferred agenda is explicitly `INSUFFICIENT_EVIDENCE` while also
  containing a separate disagreement agenda; the two states were demonstrated in separate real runs.
- External tool/payment execution from a meeting decision; approval remains an authorization record.

### BLOCKED

- None.

No commit or push was made.
