# RabbitBots Phase M1.2-B — Baseline Inspection

Status: pre-run baseline for the final-budget acceptance. No code changes were made for this
inspection.

## 1. Actual Git state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **132 paths** — 97 modified, 35 untracked |
| Last commit | none in this milestone |
| `.env` | not modified |

No reset, clean, checkout restore, commit or push was performed. The Phase M1, M1.1 and M1.2-A
working tree is preserved.

## 2. Services and migrations

- API `:3100` healthy.
- Web `:5173` serving `/app/meetings`.
- Worker, API and web dev processes are running under the existing Turbo dev stack.
- Applied M1.2-A migration `20261211160000_meeting_agenda_turn_key`.
- Previous meeting migrations remain applied; no new migration is needed for M1.2-B.

## 3. Actual final token budgets

`tokenLimitForPhase` in `packages/adapters/src/meetings.ts` currently returns:

| Phase | Budget |
| --- | ---: |
| `OPENING` | 500 |
| `REPORTING` | 1,200 |
| `AGENDA_REVIEW` | 2,000 |
| `AGENDA_RESPONSE` | 1,200 |
| `AGENDA_EVALUATION` | 2,000 |
| `AGENDA_DECISION` | 2,400 |
| `SUMMARY` | 3,200 |

These match the M1.2-B acceptance target. The turn uniqueness includes `agendaId`:

```
(meetingId, agendaId, phase, participantBotId, round)
```

## 4. Existing acceptance state

M1.2-A implemented:

- per-agenda `AGENDA_REVIEW` → `AGENDA_RESPONSE` → `AGENDA_EVALUATION` → `AGENDA_DECISION`;
- explicit no-material-disagreement skip;
- two-round ceiling;
- one decision per exact agenda ID;
- a final `SUMMARY` over persisted decisions;
- agenda selection and per-agenda detail in `MeetingsPage.tsx`;
- worker-driven progression and M1.1 cancellation/late-result guards.

The completed M1.2-A meeting used an earlier 800-token budget for review/evaluation and had several
visible model-output failures. It is not sufficient as final-budget acceptance evidence.

## 5. M1.2-B plan

1. Run focused tests and typechecks first.
2. Create a fresh five-agenda meeting titled **Glean Strategic Investment Review — M1.2-B**.
3. Close all meeting browser sessions immediately after start.
4. Let the existing Graphile worker advance the meeting; approvals are answered only through the
   normal Bot chat approval surface.
5. Validate from PostgreSQL and the API:
   - five independent agenda decisions;
   - exact agenda IDs;
   - real participant Runs and response turns;
   - review/evaluation parsing;
   - maximum one/two rounds;
   - final summary/action linkage;
   - persisted timestamps rather than model prose;
   - approvals remain PENDING when required.
6. If a concrete failure appears, make only the smallest necessary fix and rerun the full meeting.
7. Capture the meeting UI, run regressions/typechecks/build, and write the final acceptance report.

## 6. Risks

- Model output can still be verbose/malformed; the implementation has tolerant JSON extraction but
  no guarantee of semantic quality.
- Participant tool calls may pause for approvals; the normal Bot chat remains the only approval
  surface.
- The meeting deadline is 25 minutes; a five-agenda meeting may need most of it.
- Existing test meetings clutter the meeting list; final acceptance is identified by meeting ID.
