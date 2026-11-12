# RabbitBots Phase M1.3-B — CEO Decision & Meeting-Native Approval

Status: **PASS**

The human CEO can now approve, approve with conditions, reject, or defer a persisted meeting agenda
decision inside the Meeting Room. The approval is durable, authorized from the session, idempotent,
recorded in immutable history, and has no side effects. Completed meetings stay completed and their
transcript stays read-only.

## 1. Git baseline and final state

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Baseline | **136 paths** — 97 modified, 39 untracked |
| Final | **138 paths** — 97 modified, 41 untracked |
| Commit / push | none |
| `.env` | not read, printed, modified or replaced |

The two added paths are the decision-approval migration and its PostgreSQL test. No existing
migration, meeting, transcript, decision, action item or Docker volume was deleted or reset.

## 2. Data model and migration

Additive migration `20261211180000_meeting_decision_approvals`, applied successfully.

### `meeting_decision_approvals`

- `id`, `meetingId`, `decisionId`.
- `actorUserId`, `actorName` snapshot.
- `action` (`APPROVE`, `APPROVE_WITH_CONDITIONS`, `REJECT`, `DEFER`).
- `previousStatus`, `newStatus`.
- `rationale`, `conditions`.
- `clientNonce`, `createdAt`.
- Unique `(decisionId, clientNonce)` for idempotency.
- Indexes on `(meetingId, createdAt)` and `(decisionId, createdAt)`.
- Foreign keys to Meeting and MeetingDecision.

`MeetingDecision` keeps its existing `approvalRequired` and `approvalStatus` columns. No existing
decision row was rewritten by the migration.

Approval status values now include:

```
NOT_REQUIRED
PENDING
APPROVED
APPROVED_WITH_CONDITIONS
REJECTED
DEFERRED
```

## 3. API and transition rules

`rpc.meetings.decisions.approve`:

```ts
{
  meetingId,
  decisionId,
  action: "APPROVE" | "APPROVE_WITH_CONDITIONS" | "REJECT" | "DEFER",
  rationale?: string,
  conditions?: string,
  clientNonce
}
-> { approval, decision }
```

Transition rules:

```
PENDING -> APPROVED
PENDING -> APPROVED_WITH_CONDITIONS   conditions required
PENDING -> REJECTED                   rationale required
PENDING -> DEFERRED                   rationale required
```

There is no transition from a final status. The server rejects:

- `APPROVE_WITH_CONDITIONS` with blank conditions;
- `REJECT` or `DEFER` with blank rationale;
- a decision that does not require approval;
- a decision from another meeting;
- a second final approval;
- a retry with the same nonce but different action/rationale/conditions.

Identical retries with the same nonce return the same approval row and do not append history.

## 4. Authorization and persistence

- The approving user is derived from the authenticated session; no client actor/role/status fields
  exist.
- The meeting must be in the actor's Space.
- The actor must have a `MeetingHumanParticipant` row for that meeting.
- The decision must belong to the requested meeting.
- Bots have no human participant row and cannot approve.
- The service uses `updateMany` claiming only `approvalStatus = PENDING` inside a transaction, then
  creates the immutable approval row. A concurrent final approval cannot overwrite the first.
- Approval does **not** change meeting status, `completedAt`, transcript, turns, action items,
  decisions other than the approval fields, jobs, runs, payments or external connectors.
- COMPLETED, CANCELLED and FAILED meetings with pending decisions remain approvable; they are not
  reopened and their transcript stays read-only.

## 5. Meeting Room UI

`MeetingsPage.tsx` now provides:

- A **Pending approvals** section listing every pending agenda decision.
- Decision cards with agenda title, decision type/text, rationale, timestamp, related action items,
  approval status and immutable approval history.
- Four explicit actions on a pending decision: **Approve**, **Approve with conditions**, **Reject**,
  **Defer**.
- A confirmation dialog before submission. Conditional approval requires conditions; reject/defer
  requires a rationale; approval allows an optional rationale.
- Server confirmation before closing the dialog. No optimistic success state is shown.
- After success the meeting query is invalidated and refetched; the persisted approval/history is
  shown.
- Finalized decisions show the final status, actor, timestamp, rationale and conditions; no further
  action buttons.
- The existing transcript, agenda selector, summary and read-only terminal behavior are unchanged.

## 6. Real browser acceptance

**Glean CEO Approval Meeting — M1.3-B**
`cmwc7yswm0002d0t6w66easps`

- Real Bots completed both agendas and the meeting reached **COMPLETED** at
  `2026-11-11 14:38:58 UTC`.
- Both decisions were initially `PENDING` with `approvalRequired = true`.
- The CEO approved decision 1 with conditions in the Meeting Room.
- The page was refreshed; the final status, conditions, actor and history remained.
- The CEO rejected decision 2 with a rationale.
- The transcript composer remained disabled/read-only after completion.
- No new Bot Run or task was created by either approval.

### Final decisions and approvals

| Agenda | Decision | Approval | Actor | Timestamp |
| --- | --- | --- | --- | --- |
| Key investment risks | `cmwc81ztn001z6kt6g4v34cuo` — APPROVED_WITH_CONDITIONS | `cmwc86c68000dd0t62jmqdxn2` — APPROVE_WITH_CONDITIONS | RabbitBots Demo (`SeQBX2Bj7UYmjn2OArYT3MVSEkwzy49R`) | 2026-11-11 14:39:31.616 UTC |
| Final recommendation | `cmwc844ms003a6kt64xnqkqmj` — REJECTED | `cmwc87oxd000gd0t62dsbkv2q` — REJECT | RabbitBots Demo (`SeQBX2Bj7UYmjn2OArYT3MVSEkwzy49R`) | 2026-11-11 14:40:34.801 UTC |

Conditional approval record:

- previous `PENDING`, new `APPROVED_WITH_CONDITIONS`;
- conditions: “Proceed only after the gate figures are independently verified.”;
- rationale: “Conditional approval recorded by the human CEO.”

Rejection record:

- previous `PENDING`, new `REJECTED`;
- rationale: “Rejected because the gate figures are not verified.”

Screenshots:

- [Pending approvals on the completed meeting](assets/phaseM13B-pending.png)
- [Conditional approval confirmation](assets/phaseM13B-conditional-confirm.png)
- [Finalized approval after refresh](assets/phaseM13B-after-refresh.png)
- [Approval history, conditions and action items](assets/phaseM13B-history.png)
- [Rejection confirmation](assets/phaseM13B-reject-confirm.png)
- [Rejected meeting with read-only transcript](assets/phaseM13B-rejected.png)

## 7. Tests and build

| Check | Result |
| --- | --- |
| Focused suite | **58 passed** |
| Full web | **230 files / 2,033 passed** |
| API | **94 files / 1,680 passed; 344 skipped** |
| TypeScript | adapter-kit, contracts, adapters, API, web all passed |
| Production web build | passed |
| Biome | passed on changed files |
| Migration | applied |

The 8 new approval PostgreSQL tests cover:

1. conditional approval and actor/history persistence;
2. empty conditions rejection;
3. reject and defer with rationale;
4. empty rationale rejection;
5. non-member, Bot and cross-meeting rejection;
6. completed meeting approval without reopening;
7. approval after CANCELLED and FAILED with meeting status unchanged;
8. idempotent retry and conflicting final approval rejection;
9. immutable approval rows;
10. no new Bot Run/task from approval;
11. transcript read-only after completion.

Existing meeting, message, orchestration and background-job tests remain green. M1.3-A human-message
evidence and M1.2-B five-decision evidence were not modified.

## 8. Files changed

Modified:

- `packages/db/prisma/schema.prisma` — approval model/relations.
- `packages/contracts/src/meetings.ts` — approval statuses/actions, approval view/history/input.
- `packages/contracts/src/rpc.ts` — `meetings.decisions.approve`.
- `packages/adapters/src/meetings.ts` — approval service, decision history mapping.
- `apps/api/src/routes/meetings.ts` — approval procedure and authorization.
- `apps/web/src/pages/MeetingsPage.tsx` — pending/finalized approvals, confirmation dialog, history.

New:

- `packages/db/prisma/migrations/20261211180000_meeting_decision_approvals/migration.sql`
- `packages/adapters/src/meetings.approval.postgres.test.ts`
- `docs/reports/RABBITBOTS-PHASE-M1-3-B-BASELINE.md`
- `docs/reports/RABBITBOTS-PHASE-M1-3-B-IMPLEMENTATION.md`
- `docs/reports/assets/phaseM13B-*.png`

## 9. Known limitations

1. One final approval per decision; there is no amend/revoke workflow in this MVP.
2. Only the meeting creator is provisioned as a human participant; multiple CEO approvers and
   multi-human approval workflow are not implemented.
3. Approval history currently contains the single transition associated with finalization.
   Immutability is enforced by the service/API and absence of update/delete paths, not by a database
   trigger.
4. Decisions with `approvalRequired = false` display no approval controls.
5. The approval confirmation dialog is scrollable for long decision text.
6. No dedicated API-route unit test or frontend component test was added; the service is covered by
   PostgreSQL tests and the UI was exercised in a real browser.
7. No payment or external-action integration was exercised because approval is intentionally an
   authorization record only.

## 10. PASS / NOT TESTED / BLOCKED

### PASS

- Approve, conditional approve, reject and defer.
- Required conditions/rationale validation.
- Server-derived actor and meeting membership.
- Cross-meeting, non-member and Bot rejection.
- Idempotent retries; conflicting final rejection.
- Immutable history with actor/timestamp/rationale/conditions.
- Completed meeting pending approval without reopening.
- No Bot Run/task side effects.
- Meeting transcript remains read-only.
- Refresh persistence.
- Focused, web, API, TypeScript and build checks.

### NOT TESTED

- Multiple human approvers or delegated approval.
- Amending/revoking a final approval.
- A database-level immutability trigger.
- Automated Playwright e2e in CI; the live browser run is reported separately.
- Payment/external-action integration; none is expected from approval.

### BLOCKED

- None.

No commit or push was made.
