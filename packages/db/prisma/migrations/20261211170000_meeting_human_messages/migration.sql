-- Additive human participation and meeting-scoped messages.
CREATE TABLE "meeting_human_participants" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'HUMAN_CEO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_human_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_human_participants_meetingId_userId_key"
    ON "meeting_human_participants"("meetingId", "userId");
CREATE INDEX "meeting_human_participants_userId_idx"
    ON "meeting_human_participants"("userId");

INSERT INTO "meeting_human_participants" ("id", "meetingId", "userId", "role", "createdAt")
SELECT 'human-' || "id", "id", "createdBy", 'HUMAN_CEO', CURRENT_TIMESTAMP
FROM "meetings"
ON CONFLICT ("meetingId", "userId") DO NOTHING;

CREATE TABLE "meeting_messages" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "agendaId" TEXT,
    "authorType" TEXT NOT NULL DEFAULT 'HUMAN_CEO',
    "authorUserId" TEXT,
    "authorBotId" TEXT,
    "content" TEXT NOT NULL,
    "clientNonce" TEXT,
    "seq" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_messages_seq_key" ON "meeting_messages"("seq");
CREATE UNIQUE INDEX "meeting_messages_meetingId_clientNonce_key"
    ON "meeting_messages"("meetingId", "clientNonce");
CREATE INDEX "meeting_messages_meetingId_seq_idx"
    ON "meeting_messages"("meetingId", "seq");
CREATE INDEX "meeting_messages_meetingId_agendaId_seq_idx"
    ON "meeting_messages"("meetingId", "agendaId", "seq");
CREATE INDEX "meeting_messages_authorUserId_idx"
    ON "meeting_messages"("authorUserId");

ALTER TABLE "meeting_human_participants"
    ADD CONSTRAINT "meeting_human_participants_meetingId_fkey"
    FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_messages"
    ADD CONSTRAINT "meeting_messages_meetingId_fkey"
    FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_messages"
    ADD CONSTRAINT "meeting_messages_agendaId_fkey"
    FOREIGN KEY ("agendaId") REFERENCES "meeting_agendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
