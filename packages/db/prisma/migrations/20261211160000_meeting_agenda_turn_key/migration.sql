-- Per-agenda turns: agenda ID joins the turn identity. Additive and
-- backwards-compatible with existing M1/M1.1 rows (one per old tuple).
DROP INDEX "meeting_turns_meetingId_phase_participantBotId_round_key";
CREATE UNIQUE INDEX "meeting_turns_meetingId_agendaId_phase_participantBotId_round_key"
  ON "meeting_turns"("meetingId", "agendaId", "phase", "participantBotId", "round");
