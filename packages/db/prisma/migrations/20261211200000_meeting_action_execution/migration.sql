-- Additive decision condition confirmation, action execution, and CEO acceptance.
ALTER TABLE "meeting_decisions"
    ADD COLUMN "conditionsConfirmedAt" TIMESTAMP(3),
    ADD COLUMN "conditionsConfirmedByUserId" TEXT;

ALTER TABLE "meeting_action_items"
    ADD COLUMN "assigneeUserId" TEXT,
    ADD COLUMN "activatedAt" TIMESTAMP(3),
    ADD COLUMN "taskId" TEXT,
    ADD COLUMN "botRunId" TEXT,
    ADD COLUMN "startedAt" TIMESTAMP(3),
    ADD COLUMN "completedAt" TIMESTAMP(3),
    ADD COLUMN "resultStatus" TEXT,
    ADD COLUMN "resultSummary" TEXT,
    ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "blockedReason" TEXT,
    ADD COLUMN "acceptanceStatus" TEXT;

CREATE INDEX "meeting_action_items_botRunId_idx"
    ON "meeting_action_items"("botRunId");

CREATE TABLE "meeting_action_acceptances" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "clientNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_action_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_action_acceptances_actionItemId_clientNonce_key"
    ON "meeting_action_acceptances"("actionItemId", "clientNonce");
CREATE INDEX "meeting_action_acceptances_meetingId_createdAt_idx"
    ON "meeting_action_acceptances"("meetingId", "createdAt");
CREATE INDEX "meeting_action_acceptances_actionItemId_createdAt_idx"
    ON "meeting_action_acceptances"("actionItemId", "createdAt");

ALTER TABLE "meeting_action_acceptances"
    ADD CONSTRAINT "meeting_action_acceptances_actionItemId_fkey"
    FOREIGN KEY ("actionItemId") REFERENCES "meeting_action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
