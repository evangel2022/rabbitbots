# RabbitBots Phase M1.3-A — Baseline Inspection

Status: baseline captured before M1.3-A edits. This milestone adds human CEO participation and live
text to the existing Executive Boardroom; it does not change the M1/M1.1/M1.2 worker or decision model.

## 1. Actual Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **132 paths** — 97 modified, 35 untracked |
| Commit / push | none |
| `.env` | not inspected or modified |

The M1.2-B acceptance meeting, reports and screenshots remain in the working tree and database.

## 2. Existing meeting model

`Meeting` has no human-participant relation. `MeetingParticipant` is Bot-only:

```
botId String (required)
role   String
```

`MeetingTurn` stores only Bot turns. `MeetingDecision`, `MeetingActionItem` and the per-agenda
lifecycle are already present. There is no meeting message table.

The existing turn unique key is `(meetingId, agendaId, phase, participantBotId, round)`. It must not
be weakened.

## 3. Existing realtime/event infrastructure

`packages/adapters/src/realtime.ts` provides `PostgresRealtimeFanout`/`InMemoryRealtimeFanout` with
topic-based publish/subscribe over PostgreSQL `NOTIFY`.

The API exposes an authenticated async stream for **threads** (`threads.subscribe`) using
`ThreadEvents.follow` and `withHeartbeats`. Boards have an analogous space stream. There is **no
meeting-scoped subscription** and `RouterDeps` exposes only thread/board event stores, not a generic
meeting event store.

The existing Meeting UI already polls `meetings.get` every 2 seconds and the API is read-only for
that procedure. For M1.3-A, a meeting-scoped cursor-polling transport is the smallest compatible
transport: it reuses the existing authenticated API, persists before any client sees a message, and
replays missed messages by `seq`. No Redis or broker is needed. A dedicated meeting fanout can be
added later without changing the persisted message contract.

## 4. Existing meeting API/UI

- API: `meetings.list/get/create/update/start/cancel`.
- `meetings.get` is read-only and already tenant/space scoped.
- UI: `MeetingsPage.tsx` shows agenda selector, per-agenda Bot transcript, decisions, summary,
  actions and a 2-second meeting poll.
- There is no composer, human roster entry, meeting message cursor, or connection indicator.

## 5. Existing worker/context integration

`packages/adapters/src/meetings.ts` builds all real Bot prompts and creates Task/Run rows with
`trigger: "meeting_turn"`. The worker executes them through the existing runtime; M1.3-A must not
replace any of that.

Human messages must be appended to subsequent meeting prompts from the same meeting only. They must
not create Bots or runs automatically.

## 6. Planned additive data model

A new `MeetingHumanParticipant` row links the authenticated `createdBy` user to a meeting with role
`HUMAN_CEO`. Existing meetings will be backfilled with their creator.

A new `MeetingMessage` table stores human messages only:

- meeting ID, optional agenda ID;
- author type `HUMAN_CEO`;
- author user ID derived server-side;
- content, client nonce, stable server timestamp;
- meeting-scoped ordering via an auto-incrementing sequence;
- unique `(meetingId, clientNonce)` for idempotency;
- indices for `(meetingId, seq)` and agenda.

Bot turns remain `MeetingTurn` rows. The UI merges persisted human messages and Bot turns into one
chronological transcript; it does not rewrite Bot turns as human messages.

## 7. Planned authorization/message policy

- Read/send requires the meeting to be in the actor's Space and the actor to have a
  `MeetingHumanParticipant` row.
- `HUMAN_CEO` and author user ID are derived from the server session.
- Client input contains no author fields.
- DRAFT and active meetings accept new human messages.
- COMPLETED, CANCELLED and FAILED meetings are read-only for messages; they are not silently reopened.
- Cursor list is meeting-scoped and tenant-scoped.
- Human messages do not trigger external effects or Bot runs.

## 8. Planned UI/transport

- Add a human CEO roster entry from `MeetingView.humanParticipants`.
- Add a unified transcript merging selected-agenda human messages and Bot turns.
- Add a textarea composer with explicit sending/error states and nonce-based retry.
- Poll human messages by `afterSeq` with an initial cursor and append only returned persisted rows.
- Show a live/reconnecting indicator based on the poll result.
- On refresh, load from cursor zero; on reconnect, continue from the last persisted `seq`.

## 9. Tests planned

- PostgreSQL: CEO membership, non-member denial, spoofed author ignored, idempotency, cursor replay,
  meeting isolation, terminal meeting rejection, Bot prompt context inclusion.
- Adapter/unit: message view mapping, idempotency key, cursor arithmetic, transcript merge.
- API/web: focused type/tests; real browser scenario with refresh and offline/reconnect.
- Preserve and rerun existing 43 focused meeting/orchestration/job tests and the existing web/API
  regressions.

## 10. Risks

- Adding a required `MeetingView` field changes the view contract; all API and UI consumers must be
  updated together.
- Existing meetings need a backfill for the human participant row.
- Polling is near-real-time rather than push; the cursor makes reconnection correct and the design
  can be upgraded without a data migration.
- Human text is untrusted; it must be labelled as user input in Bot prompts, never treated as tool
  authorization.
- Terminal meetings must remain readable but not writable.
