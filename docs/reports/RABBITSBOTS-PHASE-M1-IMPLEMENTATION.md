# RabbitBots Phase M1 — Executive Boardroom MVP

Status: **PASS for the investor-demo vertical slice**. A real Glean boardroom meeting was created,
chaired by the existing CEO Assistant, reported by the existing Research Bot and Finance Bot, closed
with structured decisions and action items, and persisted end to end. The remaining product gaps are
listed explicitly below; there is no fabricated result in the delivered flow.

## 1. Baseline and preservation

| Item | Before M1 | After M1 |
| --- | --- | --- |
| Branch / HEAD | `main` / `6c7e1bcc6` | `main` / `6c7e1bcc6` |
| `git status --short` | **110 paths** (87 modified, 23 untracked) | **119 paths** (89 modified, 30 untracked) |
| Commit / push | none | none |

All existing uncommitted work was preserved. No reset, clean, checkout, rebase or destructive
operation was used. `.env` was not modified. The locale catalog changes present in the tree are the
pre-existing RabbitBots brand edits, not M1 changes.

The baseline/source survey is in
[`RABBITSBOTS-PHASE-M1-BASELINE.md`](RABBITSBOTS-PHASE-M1-BASELINE.md).

## 2. Implemented features

### Data model

Added additive Prisma models (new migration `20261211140000_meetings`):

- `Meeting` — space ownership, chair, status, timestamps, deadline, summary, error.
- `MeetingAgenda` — sequence, description, time limit, max discussion rounds, status, decision.
- `MeetingParticipant` — existing Bot reference, role, responsibilities, status.
- `MeetingTurn` — phase, round, participant, content, evidence JSON, real run id, status.
- `MeetingDecision` — type, text, rationale, evidence, risks, dissent, conditions, approval state.
- `MeetingActionItem` — title, description, assignee Bot, optional real due date, status, source decision.

Existing `Bot`, `Thread`, `Task`, `Run`, `Message` and Phase 1C orchestration models were reused; no
existing table was rewritten or recreated.

### Meeting Orchestrator

`packages/adapters/src/meetings.ts` owns the deterministic state machine. It creates real `Task` and
`Run` rows with trigger `meeting_turn`, enqueues them through the existing `run.continue` job path,
and reads each actual final message through `readRunOutcome`. Five real runs complete one meeting:

1. CEO opening (chair rules, agenda).
2. Research reporting.
3. Finance reporting (parallel with Research).
4. CEO bounded discussion (material disagreements only).
5. CEO structured decision, minutes and actions.

A `run`/`turn` client nonce and upsert make repeated API polling idempotent. The orchestrator and API
are the only writers of meeting state; participant messages cannot advance it.

### API

New authed oRPC routes in `apps/api/src/routes/meetings.ts`:

- `meetings.list`
- `meetings.get` — also advances/recover a persisted meeting while polling
- `meetings.create`
- `meetings.update` (draft only)
- `meetings.start` (idempotent; only DRAFT -> PREPARING)
- `meetings.cancel`

Every query filters `context.actor.spaceId`; Bot IDs and meeting IDs are validated in that Space. An
out-of-space `get` returns an isolation error. The PostgreSQL test confirms cross-space access returns
`null`.

### UI

`apps/web/src/pages/MeetingsPage.tsx` is a full-page three-column boardroom:

- left: persisted meeting list with real status;
- centre: status, agenda, participants, current agenda/speaker/round, live transcript, sources;
- right: executive summary, decisions with approval state, conditions/evidence/risks/dissent, action items.

A **Meetings** icon was added to the existing sidebar header. The page is available at
`/app/meetings` and accepts `?meeting=<id>` so a refresh restores the room. It polls the persisted
meeting while active and stops after a terminal state. The create dialog ships with the Glean
Strategic Investment Review template, five agenda items, the existing bots and a 300-second limit.

The list cache is invalidated when the selected meeting reaches a new status; the completed capture
shows the list and room both **Completed**.

## 3. Lifecycle

Implemented statuses and controlled transitions:

```
DRAFT -> PREPARING -> OPENING -> REPORTING
                    -> DISCUSSION (only when material disagreement exists)
                    -> DECISION -> CLOSING -> COMPLETED
any active state -> CANCELLED / FAILED
```

Invalid transitions are rejected by the pure transition table and never written by the API. A
duplicate start after DRAFT returns the persisted meeting; it cannot create a second opening run.
Terminal meetings cannot be advanced.

## 4. Anti-debate enforcement

Enforced in the orchestrator, not only in prompts:

- at most **2 discussion rounds** per agenda; the implementation creates one bounded chair discussion
  turn and never starts an unrestricted bot-to-bot loop;
- one participant turn per phase/round (deterministic turn id + run nonce);
- 300-second default agenda limit and a meeting deadline capped at 1,800 seconds;
- discussion starts only when both reports contain material objections with evidence/risk/contradiction/
  alternative signals; a bare “I disagree” is not material;
- no new information means no further round;
- the chair summarizes unresolved disagreements;
- timeouts force DECISION when at least one report exists, otherwise the meeting fails visibly;
- duplicate start/polling cannot create duplicate runs or multiple joins;
- malformed chair JSON gets one bounded retry, then a visible FAILED result with no invented approval;
- no external side effect is executed by any decision.

A 500-token response cap is requested in prompts; the underlying executor has no hard token-cap
setting in this MVP, so that cap is not mechanically enforced.

## 5. Decisions and action items

Decision types `APPROVED`, `APPROVED_WITH_CONDITIONS`, `DEFERRED`, `REJECTED` are parsed and persisted.
Approved financial decisions are stored with `approvalRequired = true` and `approvalStatus = PENDING`;
the CEO never marks a human owner as having approved. Decisions preserve evidence, risks, dissent and
conditions. Action items preserve explicit assignees and leave `dueAt = null` when no date was given.

The real meeting produced:

- five decisions (three `APPROVED_WITH_CONDITIONS`, two `DEFERRED`);
- four action items with Research Bot, Finance Bot or CEO Assistant ownership and **no fabricated due
  dates**;
- an executive summary and a decision transcript.

## 6. Real investor demonstration

Meeting:

`cmwbmky2l0006nbt6z37zxim0` — **Glean Strategic Investment Review**

Started `2026-11-11 12:35:04` and completed `12:35:57` (Asia/Shanghai). Five real runs:

| Phase | Bot | Run ID | Completed |
| --- | --- | --- | --- |
| Opening | CEO Assistant (chair) | `cmwbml03c000gnbt6otmbnwnf` | 12:35:11 |
| Reporting | Research Bot | `cmwbml6f6000nnbt6d4oohf6x` | 12:35:20 |
| Reporting | Finance Bot | `cmwbml6fj000pnbt673a7zqws` | 12:35:23 |
| Discussion | CEO Assistant | `cmwbmlfze0011nbt6jn5kkj9r` | 12:35:33 |
| Decision | CEO Assistant | `cmwbmlnu10018nbt6fhz4bf10` | 12:35:57 |

The meeting had one opening turn, two reporting turns, one bounded discussion turn and one decision
turn. It used the existing Bot identities and real execution; no old Investor Demo report was copied
into the meeting. The reporting turns contain source URLs and the discussions/decisions preserve the
disagreements and missing information from those reports.

Screenshots:

- [Meeting list and creation entry](assets/phaseM1-meetings-list-1440.png)
- [Create meeting template](assets/phaseM1-create-dialog-1440.png)
- [Draft meeting with Start](assets/phaseM1-draft-1440.png)
- [Reporting phase](assets/phaseM1-reporting-room-1440.png)
- [Completed room and summary](assets/phaseM1-completed-1440.png)
- [Executive summary](assets/phaseM1-summary-1440.png)
- [Decisions, conditions, evidence, dissent, approval pending](assets/phaseM1-decisions-1440.png)
- [Session transcript end](assets/phaseM1-transcript-end-1440.png)
- [Action items with no fabricated due dates](assets/phaseM1-actions-1440.png)

## 7. Tests

All commands below were actually executed with the repository-local binaries (the pinned
`pnpm@12.18.0` manager attempted a network self-install in this shell, so direct local binaries were
used for the final run).

| Check | Result |
| --- | --- |
| `meetings.test.ts` unit tests | **7 passed** |
| `meetings.postgres.test.ts` | **4 passed** — partial report, both-failure, timeout, duplicate start, cross-space isolation |
| `orchestration.postgres.test.ts` regression | **10 passed** |
| Full web tests | **229 files / 2,030 tests passed** |
| TypeScript: contracts, adapters, API, web | **all passed** |
| Production web build | **passed** (existing chunk-size warning) |
| Biome check on M1 files | no errors; remaining warning is non-blocking |

The PostgreSQL meeting test creates its own Space/Bots, runs the real service against the branch
database, and cleans up; it does not use the demo data.

## 8. Files changed

New:

- `packages/contracts/src/meetings.ts`
- `packages/adapters/src/meetings.ts`
- `packages/adapters/src/meetings.test.ts`
- `packages/adapters/src/meetings.postgres.test.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/web/src/pages/MeetingsPage.tsx`
- `packages/db/prisma/migrations/20261211140000_meetings/migration.sql`
- `docs/reports/RABBITSBOTS-PHASE-M1-BASELINE.md`
- `docs/reports/RABBITSBOTS-PHASE-M1-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM1-*.png`

Modified:

- `packages/db/prisma/schema.prisma`
- `packages/contracts/src/index.ts`, `rpc.ts`, `runs.ts`
- `packages/adapters/src/index.ts`
- `apps/api/src/router.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/pages/shell/sidebar-header.tsx`, `shell-sidebar.tsx`

Not modified: Pi Agent Runtime, Computer Runtime, Phase 1C orchestration/join logic, the Investor
Demo implementation, `.env`, API keys. No commit or push.

## 9. Known limitations and remaining work

1. **Meeting advancement is API-poll driven.** `meetings.get` advances/recover a meeting while the
   room is open. If every client closes the page, an active meeting pauses until the next poll or a
   recovery request. A production worker tick is the next reliability step.
2. **Discussion is chair-led analysis, not a full participant response round.** The chair identifies
   disagreements and records dissent, but no participant is invited to a second speaking turn. The
   data model and turn limits support that extension; it is not in this slice.
3. **Participant runs use their normal Bot threads.** Meeting turns are separately persisted, but the
   participant's chat also receives its normal bot reply. A hidden meeting-only thread would isolate
   the chat surface more completely.
4. **Cancellation marks the meeting CANCELLED but does not terminate in-flight participant runs.**
   Late replies cannot advance the meeting; they may still appear in the participant chats.
5. **The 500-token response limit is prompt-only.** No executor-level max-token control was added.
6. **No participant-to-participant unrestricted conversation.** This is intentional anti-debate
   behavior; the current discussion is even more constrained than the requirement.
7. **No external approval workflow or side effects.** Approved recommendations remain pending human
   approval; this is deliberate.
8. New UI strings are not added to translation catalogs (repository feature rules); some labels
   remain English in the Chinese UI.
9. No Playwright e2e was possible on Ubuntu 20.04; browser evidence is from headless Windows Chrome.
10. Live cancellation and a client-disconnected long-running meeting were not exercised; the
    timeout, partial failure, both-failure, duplicate start and tenant isolation paths are covered by
    the PostgreSQL tests.

## 10. PASS / BLOCKED / NOT TESTED

### PASS

- Persistent meeting/agenda/participant/turn/decision/action model and additive migration.
- Controlled lifecycle with invalid transition rejection.
- Real CEO/Research/Finance execution through existing Task/Run/worker infrastructure.
- Bounded reporting, material disagreement detection, discussion and decision.
- Human approval recorded as pending, not invented.
- Structured decisions, evidence, risks, dissent, conditions, minutes and action items.
- Authorized oRPC APIs with Space scoping.
- Meetings navigation, list, create, room, live transcript, summary and actions.
- Real Glean investor meeting completed with five runs.
- Partial report, both-failure, timeout, duplicate start and tenant isolation tests.
- Existing web tests, orchestration regression, typechecks and build.

### NOT TESTED / NOT IMPLEMENTED

- Worker-driven advancement with no open client.
- Participant response discussion rounds (chair-only in this slice).
- Live cancellation of active runs.
- External human approval workflow / external side effects.
- Playwright e2e.

### BLOCKED

- None for the MVP vertical slice. The remaining items are known product extensions, not environment
  blockers.
