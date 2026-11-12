-- Additive immutable action execution attempt history and backfill known latest attempts.
CREATE TABLE "meeting_action_attempts" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "actionItemId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "taskId" TEXT,
    "botRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "resultStatus" TEXT,
    "resultSummary" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_action_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_action_attempts_actionItemId_attemptNumber_key"
    ON "meeting_action_attempts"("actionItemId", "attemptNumber");
CREATE INDEX "meeting_action_attempts_meetingId_createdAt_idx"
    ON "meeting_action_attempts"("meetingId", "createdAt");
CREATE INDEX "meeting_action_attempts_botRunId_idx"
    ON "meeting_action_attempts"("botRunId");

ALTER TABLE "meeting_action_attempts"
    ADD CONSTRAINT "meeting_action_attempts_actionItemId_fkey"
    FOREIGN KEY ("actionItemId") REFERENCES "meeting_action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "meeting_action_attempts" (
    "id", "meetingId", "actionItemId", "attemptNumber", "taskId", "botRunId",
    "status", "resultStatus", "resultSummary", "evidence", "startedAt", "completedAt", "createdAt"
)
SELECT
    'attempt-' || "id",
    "meetingId",
    "id",
    GREATEST("executionAttempt", 1),
    "taskId",
    "botRunId",
    CASE
        WHEN "status" = 'COMPLETED' THEN 'COMPLETED'
        WHEN "status" = 'BLOCKED' THEN 'FAILED'
        WHEN "status" = 'IN_PROGRESS' AND "resultStatus" IS NOT NULL THEN 'COMPLETED'
        ELSE 'RUNNING'
    END,
    "resultStatus",
    "resultSummary",
    "evidence",
    "startedAt",
    "completedAt",
    "createdAt"
FROM "meeting_action_items"
WHERE "taskId" IS NOT NULL OR "botRunId" IS NOT NULL
ON CONFLICT ("actionItemId", "attemptNumber") DO NOTHING;
