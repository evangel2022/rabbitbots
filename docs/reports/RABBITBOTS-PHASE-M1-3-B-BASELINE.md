# RabbitBots Phase M1.3-B — Baseline Inspection

Status: pre-implementation inspection. No code was changed while inspecting.

## 1. Actual Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **136 paths** — 97 modified, 39 untracked |
| M1.3-A evidence | human message meeting completed; reports/assets present |
| `.env` | not read, printed or modified |

## 2. Current meeting decision model

`MeetingDecision` already has:

- `approvalRequired: Boolean`
- `approvalStatus: String` with values used in practice:
  `NOT_REQUIRED`, `PENDING`, `APPROVED`, `REJECTED`
- decision text, rationale, evidence, risks, dissent, conditions and action items.
- unique `(meetingId, agendaId)`.

There is **no approval history table**, no approver/actor column, no idempotency key and no
conditional/deferred approval status.

## 3. Current approval infrastructure

The existing `approval-effect.ts` and Bot Chat approval cards govern **tool/action approvals**
(`allow`/`always`/`deny`) and are not a meeting-decision approval service. There is no existing
meeting decision approval RPC or persistence path.

`MeetingsPage.tsx` displays the decision and a passive "Human approval pending" label. It has no
approve/reject/defer controls.

## 4. Existing authorization

- `meetings.get` is Space-scoped and read-only.
- M1.3-A added `MeetingHumanParticipant` with role `HUMAN_CEO`, backfilled from each meeting's
  creator.
- M1.3-A message APIs derive the actor from the session and require a human participant row.
- Meeting completion/cancellation does not delete decisions.

## 5. Smallest implementation path

1. Add an additive `meeting_decision_approvals` table with immutable transition rows.
2. Extend the approval status contract with `APPROVED_WITH_CONDITIONS` and `DEFERRED`.
3. Add `meetings.decisions.approve` with server-derived actor and a unique
   `(decisionId, clientNonce)` idempotency key.
4. Atomically claim `PENDING` with a conditional update and create the history row; reject a second
   final approval.
5. Include approval history in `MeetingDecisionView`.
6. Add pending/finalized approval panels and a confirmation dialog in `MeetingsPage.tsx`.
7. Allow approval after the meeting is COMPLETED/CANCELLED/FAILED; never change meeting status,
   transcript or turns.
8. Add focused PostgreSQL tests, run the real browser acceptance, then regressions/build.

## 6. Transition rules to implement

```
PENDING -> APPROVED
PENDING -> APPROVED_WITH_CONDITIONS   (conditions required)
PENDING -> REJECTED                   (rationale required)
PENDING -> DEFERRED                   (rationale required)
```

No transition from a final status. Repeated identical requests with the same nonce return the same
record; a different request with the same nonce or a new final request is rejected.

## 7. Risks

- The existing `approvalStatus` values are not constrained in PostgreSQL, so new values can be added
  without rewriting decision rows.
- History must not be mutated by future requests; one transition row per final approval is enough
  for this MVP.
- The approval UI must remain usable after the meeting has closed while the transcript composer stays
  read-only.
- The approval service must not touch jobs, runs, payments or external connectors.
