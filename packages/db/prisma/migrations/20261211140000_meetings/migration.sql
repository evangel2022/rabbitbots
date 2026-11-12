-- Additive Executive Boardroom tables. No existing table is altered.
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "chairBotId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "meetingSummary" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_agendas" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sequence" INTEGER NOT NULL,
    "timeLimitSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxDiscussionRounds" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_agendas_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "responsibilities" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_turns" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "agendaId" TEXT,
    "participantBotId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_turns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_decisions" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "agendaId" TEXT,
    "decisionType" TEXT NOT NULL,
    "decisionText" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "supportingEvidence" JSONB NOT NULL DEFAULT '[]',
    "risks" JSONB NOT NULL DEFAULT '[]',
    "dissentingOpinions" JSONB NOT NULL DEFAULT '[]',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvalStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_decisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_action_items" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "decisionId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assigneeBotId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_action_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_agendas_meetingId_sequence_key" ON "meeting_agendas"("meetingId", "sequence");
CREATE UNIQUE INDEX "meeting_participants_meetingId_botId_key" ON "meeting_participants"("meetingId", "botId");
CREATE INDEX "meetings_spaceId_createdAt_idx" ON "meetings"("spaceId", "createdAt");
CREATE INDEX "meetings_spaceId_status_updatedAt_idx" ON "meetings"("spaceId", "status", "updatedAt");
CREATE INDEX "meeting_agendas_meetingId_sequence_idx" ON "meeting_agendas"("meetingId", "sequence");
CREATE INDEX "meeting_participants_botId_idx" ON "meeting_participants"("botId");
CREATE INDEX "meeting_turns_meetingId_createdAt_idx" ON "meeting_turns"("meetingId", "createdAt");
CREATE INDEX "meeting_turns_meetingId_phase_idx" ON "meeting_turns"("meetingId", "phase");
CREATE INDEX "meeting_turns_runId_idx" ON "meeting_turns"("runId");
CREATE INDEX "meeting_decisions_meetingId_createdAt_idx" ON "meeting_decisions"("meetingId", "createdAt");
CREATE INDEX "meeting_decisions_meetingId_agendaId_idx" ON "meeting_decisions"("meetingId", "agendaId");
CREATE INDEX "meeting_action_items_meetingId_createdAt_idx" ON "meeting_action_items"("meetingId", "createdAt");
CREATE INDEX "meeting_action_items_assigneeBotId_idx" ON "meeting_action_items"("assigneeBotId");

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_chairBotId_fkey" FOREIGN KEY ("chairBotId") REFERENCES "bots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "meeting_agendas" ADD CONSTRAINT "meeting_agendas_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "meeting_turns" ADD CONSTRAINT "meeting_turns_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_turns" ADD CONSTRAINT "meeting_turns_agendaId_fkey" FOREIGN KEY ("agendaId") REFERENCES "meeting_agendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_turns" ADD CONSTRAINT "meeting_turns_participantBotId_fkey" FOREIGN KEY ("participantBotId") REFERENCES "bots"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_decisions" ADD CONSTRAINT "meeting_decisions_agendaId_fkey" FOREIGN KEY ("agendaId") REFERENCES "meeting_agendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "meeting_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_assigneeBotId_fkey" FOREIGN KEY ("assigneeBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
