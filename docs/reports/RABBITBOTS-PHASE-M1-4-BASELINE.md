# RabbitBots Phase M1.4 — Baseline Inspection

Status: pre-implementation inspection. No code was modified during Phase 0.

## 1. Actual Git baseline

| Item | Actual |
| --- | --- |
| Branch | `main` |
| HEAD | `6c7e1bcc6` |
| Working tree | **138 paths** — 97 modified, 41 untracked |
| Commit / push | none |
| `.env` | not read, printed or modified |

M1.3-A human messages, M1.3-B approvals, M1.2 meetings and all reports/assets are preserved.

## 2. Existing components that already satisfy part of M1.4

- CEO Assistant is the meeting chair and has a separate opening/review/evaluation/decision/summary
  prompt.
- Research Bot and Finance Bot already receive role-specific reporting prompts and responsibilities.
- Per-agenda lifecycle already separates `AGENDA_REVIEW`, `AGENDA_RESPONSE`,
  `AGENDA_EVALUATION`, `AGENDA_DECISION` and final `SUMMARY`.
- `MEETING_MAX_DISCUSSION_ROUNDS = 2`; no third round.
- A second round is created only when the chair evaluation names new evidence and a question.
- Each agenda has one persisted decision and linked action items.
- The M1.3-B approval flow already provides CEO approval, immutable records and server-derived actor.
- The meeting page already has agenda selection, transcript, decisions, approvals and actions.

## 3. Gaps found

1. `MeetingDecision` did not explicitly persist a discussion state
   (`AGREEMENT`, `DISAGREEMENT`, `INSUFFICIENT_EVIDENCE`, `UNRESOLVED`).
2. Decisions had evidence/risks/dissent but no distinct supporting-opinion and evidence-gap fields.
3. Action items had no acceptance criterion.
4. The chair stage summary was not exposed with consensus/disagreement/gap sections.
5. The final summary was generated before CEO approvals and therefore became a stale snapshot; there
   was no current formal minutes view derived from persisted approval records.
6. Round-2 participant prompts did not include the earlier-round responses, so duplicate-argument
   suppression relied only on generic instructions.

## 4. Smallest implementation path

- Add additive `discussionState`, `supportingOpinions`, `evidenceGaps` decision columns and
  `acceptanceCriteria` action column.
- Extend chair review/decision/summary JSON contracts and tolerant parsers.
- Add state/summary fields to the review card, decision fields to the decision card and a formal
  minutes section derived from the persisted meeting view.
- Include earlier responses in round-2 participant prompts and evaluation-selected participant names.
- Reuse M1.3-B approval UI and service without changing its semantics.
- Add focused parser/orchestration and minutes tests.
- Run a fresh real meeting with browser closed, then approve in the room and verify refresh.

## 5. Risk notes

- Formal minutes must not be a temporary frontend synthesis. It is built server-side from persisted
  decisions, approvals, turns and action items on every read.
- The chair's closing summary is a historical Bot output and must not be presented as the current
  CEO approval state. The formal minutes section renders the current persisted approval state.
- A failed participant response remains visible and must not be counted as agreement.
- A deferred decision is not an approval; the UI and minutes must keep that distinction.
