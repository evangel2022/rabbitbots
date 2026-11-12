-- M1.1 additive reliability fields and idempotency constraints.
ALTER TABLE "runs" ADD COLUMN "maxOutputTokens" INTEGER;

ALTER TABLE "meetings" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "meetings" ADD COLUMN "cancellationReason" TEXT;

CREATE UNIQUE INDEX "meeting_turns_meetingId_phase_participantBotId_round_key"
  ON "meeting_turns"("meetingId", "phase", "participantBotId", "round");
CREATE UNIQUE INDEX "meeting_decisions_meetingId_agendaId_key"
  ON "meeting_decisions"("meetingId", "agendaId");
CREATE UNIQUE INDEX "meeting_action_items_decisionId_title_key"
  ON "meeting_action_items"("decisionId", "title");
