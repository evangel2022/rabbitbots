# RabbitBots Phase M1.2-B — Final-Budget Meeting Acceptance

Status: **PASS**

A fresh five-agenda meeting completed under the actual final token budgets with the browser closed.
All five agendas produced independent persisted decisions; the summary references those five decisions,
and nine action items are linked to the correct agenda decisions. Three approved recommendations
remain pending human approval.

## 1. Baseline and final Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline working tree | **132 paths** — 97 modified, 35 untracked |
| Final working tree | **132 paths** — 97 modified, 35 untracked |
| Commit / push | none |
| `.env` | not modified |

The M1.2-B changes are a minimal fix in `packages/adapters/src/meetings.ts` plus the baseline,
acceptance report and screenshots. No new migration was needed.

## 2. Final token budgets verified in source

| Phase | Actual `tokenLimitForPhase` |
| --- | ---: |
| `OPENING` | 500 |
| `REPORTING` | 1,200 |
| `AGENDA_REVIEW` | 2,000 |
| `AGENDA_RESPONSE` | 1,200 |
| `AGENDA_EVALUATION` | 2,000 |
| `AGENDA_DECISION` | 2,400 |
| `SUMMARY` | 3,200 |

The real Run rows confirm these budgets were applied to the corresponding phases.

## 3. Minimal fix made during acceptance

The first M1.2-B run exposed a concrete defect: the second-round `AGENDA_REVIEW` turn was persisted
as a plain question string instead of the structured review JSON. The orchestrator therefore could
not parse round 2 and recorded agenda 1–3 as DEFERRED after successful round-1 evaluations.

The fix was limited to that turn's persisted content:

```json
{
  "materialDisagreement": true,
  "reason": "<evaluation reason>",
  "question": "<evaluation question>",
  "participants": []
}
```

No budget increase was used to hide the defect. The full five-agenda meeting was then rerun from
scratch.

## 4. Final M1.2-B meeting

**Glean Strategic Investment Review — M1.2-B**
ID `cmwc5olxb0002o3t6sae414su`

- Started `2026-11-11 13:29:45` UTC (21:29 Asia/Shanghai).
- Completed `2026-11-11 13:37:28` UTC (21:37 Asia/Shanghai).
- Browser was closed immediately after start; no polling or API `get` calls were required.
- 30 persisted turns.
- **5 agenda decisions**.
- **9 action items**.
- One final `SUMMARY` run.

Database timestamps, not model prose, are the authoritative meeting times.

### Agenda outcomes

| Agenda | Status | Decision | Round(s) | Responses | Approval |
| --- | --- | --- | --- | --- | --- |
| 1 Market opportunity | DECIDED | `cmwc5qilz0019nit6b62u2vjf` — APPROVED_WITH_CONDITIONS | 1 | 0 (no material disagreement) | PENDING |
| 2 Competitive position | DEFERRED | `cmwc5s3ls002cnit6j5nbsmou` — DEFERRED | 1 | 2 | NOT_REQUIRED |
| 3 Financial feasibility | DEFERRED | `cmwc5tcnd003enit6qrh951gc` — DEFERRED | 1 | 2 | NOT_REQUIRED |
| 4 Key investment risks | DECIDED | `cmwc5w4sg0057nit6fti4h9mn` — APPROVED_WITH_CONDITIONS | **2** | 2 + 2 | PENDING |
| 5 Final recommendation | DECIDED | `cmwc5xzi9006dnit6kqpfftbl` — APPROVED_WITH_CONDITIONS | 1 | 2 | PENDING |

Three recommendations are `APPROVED_WITH_CONDITIONS` with `approvalStatus = PENDING`. No human
approval was claimed. Agenda 4 exercised a real second round with a fresh `AGENDA_REVIEW` round 2,
two new participant responses, a second chair evaluation and only then its decision. No third round
was created.

### Key real Runs

- Opening: `cmwc5om7r0001nit6pi44qqga` (500)
- Research report: `cmwc5op720008nit61fh9t32k` (1,200)
- Finance report: `cmwc5op7g000anit628qayw9p` (1,200)
- Agenda 1 review: `cmwc5pun7000vnit6orq46zav` (2,000)
- Agenda 1 decision: `cmwc5pzu90012nit6obbl8mpj` (2,400)
- Agenda 2 review: `cmwc5qimi001bnit6w3clev3f` (2,000)
- Agenda 2 responses: `cmwc5qyvo001jnit68c3ofb3m`, `cmwc5qyw1001lnit61fkfwsdz` (1,200)
- Agenda 2 evaluation: `cmwc5rdbs001ynit685t2nk6e` (2,000)
- Agenda 3 decision: `cmwc5sjjg0036nit63ygv4os7` (2,400)
- Agenda 4 second-round review: completed turn with no run (chair question from round-1 evaluation)
- Agenda 4 second-round responses: `cmwc5uky4004anit6mf55neh5`, `cmwc5ukyg004cnit6gvxmh8m8` (1,200)
- Agenda 4 second evaluation: `cmwc5v98i004tnit6o3olngq2` (2,000)
- Agenda 4 decision: `cmwc5vilz0050nit6bhg29kii` (2,400)
- Agenda 5 decision: `cmwc5xa6j0065nit63nuyvzp0` (2,400)
- Final summary: `cmwc5xzj2006fnit6rcva97jn` (3,200)

One agenda 4 round-1 participant response failed visibly (`cmwc5tmow003pnit64r3sb5i8`). It remained
a failed turn and did not block the agenda or get counted as agreement; the second round still ran
with both participants.

### Summary and action items

The final summary explicitly says five agenda decisions were persisted, no sixth decision was
created, and none was merged. It reports the three pending approvals and the two DEFERRED items.

Nine action items are linked to the correct decision IDs, including both approved conditions and
deferred workstreams. No due date was fabricated; every unspecified `dueAt` remains `null`.

Screenshots:

- [Completed M1.2-B boardroom](assets/phaseM12B-completed-focus.png)
- [Agenda 4 with two rounds and four responses](assets/phaseM12B-agenda-focus.png)
- [Overall meeting summary and pending approvals](assets/phaseM12B-summary-focus.png)
- [Selected agenda decision](assets/phaseM12B-decisions-focus.png)
- [Action items](assets/phaseM12B-actions-focus.png)

## 5. Output-quality checks

- Every agenda review, evaluation, decision and summary was parsed from a completed Run.
- No agenda review/evaluation failure occurred in the final meeting.
- Participant responses are real `AGENDA_RESPONSE` Runs; agenda 4 has two actual rounds.
- Facts, assumptions, evidence, risks and recommendations are present in the participant response
  prompts and outputs; source/access-date material is retained.
- All five decisions reference the exact agenda ID.
- Decision rationales are persisted; no generic combined decision exists.
- The final summary references the five persisted decisions, not a sixth.
- Action items reference decision IDs resolved from their agenda sequence.
- Three approvals remain PENDING; no external action was executed.
- The meeting used database timestamps `13:29:45`–`13:37:28`; model-authored timestamps were not used
  as evidence.
- No DEFERRED item was represented as APPROVED.

## 6. Tests and build

All commands below were executed after the second-round fix.

| Check | Result |
| --- | --- |
| Focused meetings/orchestration/jobs suites | **43 passed** |
| Full web suite | **229 files / 2,030 tests passed** |
| API suite | **94 files / 1,680 passed; 344 skipped** (DB-gated) |
| TypeScript: adapter-kit, contracts, adapters, API, web | **all passed** |
| Production web build | **passed** |
| Biome check | no errors on changed files |

Focused total includes 15 unit, 7 M1/M1.1 PostgreSQL regressions, 1 per-agenda PostgreSQL test,
10 orchestration and 10 background-job tests.

## 7. Migrations and database

All existing migrations remain applied:

- `20261211140000_meetings`
- `20261211150000_meeting_reliability`
- `20261211151000_meeting_reconcile_lease`
- `20261211152000_meeting_participant_threads`
- `20261211160000_meeting_agenda_turn_key`

M1.2-B added no migration and deleted no data. Existing meetings and test records were preserved.

## 8. Files changed for M1.2-B

Modified:

- `packages/adapters/src/meetings.ts` — persist structured JSON for second-round agenda reviews.

New documentation/assets:

- `docs/reports/RABBITBOTS-PHASE-M1-2-B-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-2-B-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM12B-*.png`

No code outside the meeting orchestrator was changed for this acceptance. No commit or push was
made.

## 9. Remaining limitations

1. The normal Bot chat remains the only approval surface; the meeting page shows pending approvals
   but does not answer them.
2. One participant response failed in agenda 4 round 1; it is preserved as failed and the second
   round completed. This is visible evidence, not a hidden success.
3. No forced provider-process termination exists; cancellation remains durable-state/job based.
4. No Playwright e2e suite was run.
5. The token budgets are larger than the original 500-token target for reasoning-capable models:
   2,000 review, 1,200 response, 2,000 evaluation, 2,400 decision, 3,200 summary. This is the final
   configured behavior; it is documented, not hidden.
6. The meeting page still lists older verification meetings in this working database; the accepted
   meeting is identified by ID.

## 10. Acceptance result

**PASS.**

Required evidence is present:

1. Final-budget five-agenda meeting: `cmwc5olxb0002o3t6sae414su`.
2. Five independent decision IDs listed above.
3. Real participant Run IDs and outputs.
4. Round counts per agenda, including a real two-round agenda.
5. Final summary and nine linked action items.
6. Worker completion with the browser closed.
7. Meeting/agenda screenshots.
8. Tests, TypeScript and production build results.
9. Baseline and implementation reports.

No commit, push, database deletion or `.env` change was made.
