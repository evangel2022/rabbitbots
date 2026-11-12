# RabbitBots Phase M1.1 — Baseline Inspection

Status: baseline captured before M1.1 edits. This document records the actual working tree, not a
clean checkout.

## 1. Actual Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **119 paths** — 89 modified, 30 untracked |
| M1 state | Phase M1 complete; completed meeting data and M1 report/assets are present |

No reset, clean, checkout or restore was performed for this inspection. `.env` and the running
database were not touched.

## 2. Phase M1 implementation being preserved

- `packages/adapters/src/meetings.ts` — 1,242-line meeting state machine and prompts.
- `packages/contracts/src/meetings.ts` — meeting lifecycle, view, create/update contracts.
- `apps/api/src/routes/meetings.ts` — list/get/create/update/start/cancel.
- `apps/web/src/pages/MeetingsPage.tsx` — three-column meeting list/room/summary.
- `packages/db/prisma/schema.prisma` — Meeting, MeetingAgenda, MeetingParticipant, MeetingTurn,
  MeetingDecision, MeetingActionItem.
- `packages/db/prisma/migrations/20261211140000_meetings/migration.sql` — applied additive migration.
- `docs/reports/RABBITSBOTS-PHASE-M1-IMPLEMENTATION.md` — M1 implementation and real demo evidence.

The completed M1 meeting (`cmwbmky2l0006nbt6z37zxim0`) and its five real runs remain in the database.

## 3. How meeting progression works today

`apps/api/src/routes/meetings.ts` calls `advanceMeeting(...)` inside `meetings.get`. `startMeeting`
also calls `advanceMeeting` once immediately after changing DRAFT to PREPARING. The UI polls
`meetings.get` every two seconds while the selected meeting is active.

Consequences:

- progress depends on an open browser polling the API;
- `meetings.get` is not read-only;
- no background job or reconciliation pass drives a meeting;
- an interrupted API request can leave a meeting in an intermediate state until a client polls;
- there is no worker-side recovery scan for these meetings.

The M1 demo completed only because its browser room stayed open.

## 4. Background job architecture

- Job payloads and builders: `packages/adapter-kit/src/background-jobs.ts`.
- Job union/handler map: `packages/adapter-kit/src/types.ts` (`BackgroundJobPayloads`,
  `BackgroundJobHandlers`).
- Graphile worker host: `apps/worker/src/index.ts` and `packages/adapters/src/wakeup.ts`.
- Job handler composition: `createRunRuntime` → `createBackgroundJobHandlers`
  (`packages/adapters/src/run-runtime.ts`, `background-job-handlers.ts`).
- Periodic recovery: `createJobReconciler` in `packages/adapters/src/job-reconciler.ts`; the worker
  starts it with `createRunReconciler` in `apps/worker/src/index.ts`.

Existing conventions:

- `replaceKey` deduplicates queue rows; `keepExisting` preserves a job that still has attempts.
- `maxAttempts` bounds retries.
- `GraphileJobPublisher.cancel(key)` removes a queued job by key.
- `RunJobPublisher.cancel` ignores `run:` keys because run status is the durable cancellation.
- `run.continue` is the existing execution job; `runJobKey(runId)` is its key.
- `reconcileOrchestrations` is the existing periodic recovery pattern and is a useful model for a
  meeting sweep.

## 5. Current Meeting schema and gaps

`Meeting` has id/space/title/chair/status/startedAt/completedAt/deadlineAt/summary/error and
relations. It does **not** record cancellation time or reason.

`MeetingTurn` has `phase`, `round`, `participantBotId`, content, evidence and optional `runId`; it has
no unique constraint on `(meetingId, phase, participantBotId, round)`, although M1 uses deterministic
IDs.

`MeetingDecision` has no uniqueness per `(meetingId, agendaId)`; duplicate final minutes are guarded
only by a count check. `MeetingActionItem` has no uniqueness guard.

`Run` has no per-run output-token field. `AgentRunModel.maxTokens` and Pi's
`resolveCompletionMaxTokens` already support a request-level cap, but meeting-created runs cannot
pass one today.

## 6. Current discussion implementation

M1 creates one `DISCUSSION` turn for the chair after reports. The chair's prompt asks it to identify
material disagreements and summarize unresolved issues. There is no participant second turn, no
structured discussion question, no per-round participant turns, and no chair evaluation of new
evidence. The decision prompt reads the reporting and discussion turns.

`detectMaterialDisagreement` is a deterministic gate over the two reports. It can skip discussion
when reports have no supported objection.

## 7. Existing cancellation capabilities

- `packages/db/src/cancel-runs.ts` exports `cancelRunsInTransaction`. It conditionally updates active
  runs to `cancelled`, clears run secrets/lease state, cancels active attempts and marks tasks
  cancelled.
- `apps/api/src/thread-stop.ts` uses that helper plus sandbox/computer teardown. It requires the
  message/thread target and the sandbox/events deps.
- The meeting API currently only changes the meeting row to CANCELLED. It does not cancel
  meeting-specific runs or jobs, and it has no cancellation reason/time fields.

A late meeting run can still finish in its bot thread; `advanceMeeting` checks terminal meeting
status at its start, which is the current late-result guard. M1.1 must make this guard explicit and
test it.

## 8. Token-limit capabilities

- `AgentRunModel.maxTokens` is the request-level provider output cap.
- `resolveCompletionMaxTokens` in `packages/adapters/src/pi-runtime-limits.ts` applies the cap,
  including provider/model ceilings and OpenRouter credit error handling.
- `packages/adapters/src/pi-runtime.ts` passes `request.model.maxTokens` through
  `modelForCompletion` and the stream options.
- Meeting runs do not set it; M1's 500-token limit is prompt-only. The clean extension is a nullable
  `Run.maxOutputTokens` set by the meeting task builder and copied into the runtime request model.

## 9. M1.1 implementation plan

1. Add a `meeting.reconcile` background job and handler; schedule it on start and on completion of a
   meeting run; add a periodic worker reconciliation sweep for stale active meetings.
2. Make `meetings.get` read-only. The API no longer advances meetings.
3. Add structured discussion phases and real participant runs: chair question → selected participant
   responses → chair evaluation → optional second round → forced decision.
4. Add meeting cancellation fields, cancel active meeting runs in a transaction, cancel queued jobs,
   and guard every late advancement. Record the best-effort runtime limitation honestly.
5. Add `Run.maxOutputTokens`, pass it into the runtime request, and set the limit on meeting turns.
6. Add focused unit/PostgreSQL tests and then run regressions, a fresh worker-driven investor meeting,
   and a separate cancellation demonstration.

## 10. Risks

- The current state machine has a single `DISCUSSION` turn; changing phases must keep existing M1
  meeting rows readable and not rewrite them.
- Concurrent worker delivery and cancellation need conditional transitions; new unique constraints
  must be checked against existing rows before migration.
- Participant discussion adds real runs and can lengthen a meeting; the deadline and retry bounds must
  still force a terminal result.
- Per-run `maxOutputTokens` changes a shared runtime path; it must remain optional so existing runs
  behave exactly as before.
- The worker reconciler is additive; existing orchestration and run reconciliation must continue.
