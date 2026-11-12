-- Durable delegation wait, result delivery and continuation runs.
ALTER TABLE "workforce_tasks"
    ADD COLUMN IF NOT EXISTS "waitingForChildren" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "waitingSince" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "continuationRunId" TEXT,
    ADD COLUMN IF NOT EXISTS "continuationOfRunId" TEXT,
    ADD COLUMN IF NOT EXISTS "delegationDeadlineAt" TIMESTAMP(3);

ALTER TABLE "runs"
    ADD COLUMN IF NOT EXISTS "parentRunId" TEXT,
    ADD COLUMN IF NOT EXISTS "continuationOfRunId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "runs_continuationOfRunId_key"
    ON "runs"("continuationOfRunId");

CREATE TABLE IF NOT EXISTS "workforce_delegations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "parentTaskId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "childTaskId" TEXT NOT NULL,
    "childRunId" TEXT,
    "delegatorBotId" TEXT NOT NULL,
    "assigneeBotId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "resultStatus" TEXT,
    "resultSummary" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workforce_delegations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "workforce_delegations_parentTaskId_childTaskId_key"
    ON "workforce_delegations"("parentTaskId", "childTaskId");
CREATE INDEX IF NOT EXISTS "workforce_delegations_spaceId_status_idx"
    ON "workforce_delegations"("spaceId", "status");
CREATE INDEX IF NOT EXISTS "workforce_delegations_parentTaskId_status_idx"
    ON "workforce_delegations"("parentTaskId", "status");
CREATE INDEX IF NOT EXISTS "workforce_delegations_childTaskId_idx"
    ON "workforce_delegations"("childTaskId");
ALTER TABLE "workforce_delegations"
    DROP CONSTRAINT IF EXISTS "workforce_delegations_parentTaskId_fkey";
ALTER TABLE "workforce_delegations"
    ADD CONSTRAINT "workforce_delegations_parentTaskId_fkey"
    FOREIGN KEY ("parentTaskId") REFERENCES "workforce_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
