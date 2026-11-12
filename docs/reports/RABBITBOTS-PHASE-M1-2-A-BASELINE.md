# RabbitBots Phase M1.2-A — Baseline Inspection

Status: baseline captured before M1.2-A edits. This is an incremental change to the working M1.1
implementation; no clean checkout exists.

## 1. Actual Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **130 paths** — 97 modified, 33 untracked |
| M1/M1.1 status | Worker-driven meeting, participant discussion, cancellation and token caps implemented |
| Runtime | API `:3100` healthy; Web/worker dev processes running |

No reset, clean, checkout restore, commit or push was performed. `.env` and database records were
not modified for this inspection.

## 2. Current meeting flow

`packages/adapters/src/meetings.ts` currently implements:

```
DRAFT -> PREPARING -> OPENING -> REPORTING
      -> DISCUSSION (only if detectMaterialDisagreement(reports))
         -> chair DISCUSSION_QUESTION -> participant DISCUSSION_RESPONSE
         -> chair DISCUSSION_EVALUATION -> optional round 2
      -> DECISION (one chair run, one combined decision JSON)
      -> CLOSING -> COMPLETED
```

For the M1.1 demo, all five agenda decisions were produced by a single `DECISION` run. The
`DISCUSSION_QUESTION`, discussion responses and evaluation were attached to the first open agenda
only. The persisted decisions did get individual `agendaId` values, but they were not independently
discussed per agenda.

## 3. Existing agenda model

`MeetingAgenda` already has:

- `id`, `meetingId`, `sequence`, `title`, `description`;
- `timeLimitSeconds`, `maxDiscussionRounds` (default 2);
- `status` default `PENDING`, `decision` text;
- relations to `MeetingTurn` and `MeetingDecision`.

`MeetingDecision` already has a unique `(meetingId, agendaId)` constraint and all required fields:
type, statement, rationale, evidence, risks, dissent, conditions, approval requirement/status.

Therefore no new table is required. An additional **turn uniqueness correction** is required:
`MeetingTurn` currently has `@@unique([meetingId, phase, participantBotId, round])`, which prevents
the same phase/participant/round from existing for agenda 1 and agenda 2. The unique key must add
`agendaId`.

## 4. Current discussion/decision code

- `advanceMeeting` dispatches:
  - `REPORTING` -> `finishReporting`
  - `DISCUSSION` -> `advanceDiscussion`
  - `DECISION` -> `finishDecision`
  - `CLOSING` -> COMPLETED
- `finishReporting` runs the global `detectMaterialDisagreement` gate, sets DISCUSSION, and calls
  `advanceDiscussion`.
- `advanceDiscussion` chooses only the first open agenda. It creates at most one chair question,
  participant responses per round, a chair evaluation, and a second question only with named new
  evidence. After evaluation it sets DECISION.
- `beginDecision` creates one chair DECISION run with all reports/discussion turns.
- `finishDecision` parses one `ChairOutput` containing an array of decisions, then `persistDecision`
  writes one decision per agenda and all action items at once.
- The final summary is embedded in the same decision run (`meetingSummary` from `ChairOutput.summary`).

## 5. Worker/recovery/cancellation baseline

M1.1 already provides:

- `meeting.reconcile` jobs (`replaceKey`, max attempts 8);
- a 90-second `reconcileLeaseUntil` claim;
- post-run enqueue in `run.continue`;
- a 60-second stale-meeting recovery sweep in the worker reconciler;
- read-only `meetings.get`;
- cancellation transaction, run/job cancellation, and late-result guards;
- per-run `maxOutputTokens` and meeting response budget validation.

These must remain unchanged. The per-agenda loop will run inside `advanceMeeting` and therefore
inherits the same lease, scheduling and cancellation behavior.

## 6. Turn keying and idempotency

`createTurnRun` currently uses:

- deterministic run `clientNonce = meeting:<meetingId>:<phase>:<botId>:<round>`;
- deterministic turn ID `meeting:<meetingId>:<phase>:<botId>:<round>`;
- turn upsert by that ID;
- `MeetingTurn` unique `(meetingId, phase, participantBotId, round)`.

The nonce and ID omit `agendaId`, so a second agenda would either collide or reuse the first agenda's
turn. M1.2-A must include `agendaId` in:
- the provider run nonce;
- the deterministic turn ID;
- the database unique key.

Opening has no agenda; it can use `agendaId = null` or a stable `no-agenda` segment.

## 7. UI baseline

`apps/web/src/pages/MeetingsPage.tsx` currently renders:

- all agenda items with status, time and rounds;
- a single transcript of all turns, with phase/round labels;
- decisions in the right column, each with type/approval/dissent/conditions;
- one overall executive summary.

It does not select an agenda, filter its turns/decisions, show per-agenda discussion round counts, or
distinguish agenda-level decision/approval state from the overall summary. The schema already exposes
enough data to do so.

## 8. M1.2-A implementation plan

1. Extend `MeetingTurn` uniqueness to include `agendaId` with an additive migration; update the
   deterministic nonce/turn ID.
2. Replace the one-discussion/one-decision tail with a deterministic per-agenda loop:
   `AGENDA_REVIEW` -> participant `DISCUSSION_RESPONSE` -> `DISCUSSION_EVALUATION` -> optional final
   round -> `AGENDA_DECISION` -> next agenda.
3. Mark the current agenda `ACTIVE`/discussing; mark it `DECIDED` or `DEFERRED` only after its
   decision is persisted. Never advance before a terminal decision.
4. Add one final `SUMMARY` phase after all agendas to generate the meeting summary and action items
   from the persisted decisions.
5. Update tests to exercise five independent agendas, no-disagreement skip, one/two rounds, no third
   round, duplicate response rejection, decision isolation and worker recovery.
6. Update the UI to select an agenda and display its discussion/decision; keep the overall summary
   distinct.
7. Run a fresh five-agenda Glean meeting with the browser closed; capture evidence.

## 9. Risks

- Adding `agendaId` to a unique constraint must be checked against existing rows; allowing NULL
  affects the opening turn, so uniqueness for agenda-less turns needs a stable convention.
- The M1/M1.1 tests assert the old single-decision flow and will need behavior updates, not deletion.
- A per-agenda loop multiplies real Bot runs; bounded rounds, deadlines and cancellation must remain
  effective.
- The final summary must reference persisted decisions, not re-decide them.
- No schema table is needed, but the migration is still additive-only and must preserve existing
  records.
