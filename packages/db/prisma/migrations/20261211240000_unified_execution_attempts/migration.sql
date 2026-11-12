-- Unified execution attempts. Both legacy tables remain for rollback and comparison.
CREATE TABLE "execution_attempts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "meetingActionId" TEXT,
    "workforceTaskId" TEXT,
    "taskId" TEXT,
    "runId" TEXT,
    "parentRunId" TEXT,
    "continuationOfRunId" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "resultStatus" TEXT,
    "resultSummary" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "execution_attempts_sourceType_sourceId_attemptNumber_key"
    ON "execution_attempts"("sourceType", "sourceId", "attemptNumber");
CREATE UNIQUE INDEX "execution_attempts_meetingActionId_attemptNumber_key"
    ON "execution_attempts"("meetingActionId", "attemptNumber");
CREATE UNIQUE INDEX "execution_attempts_workforceTaskId_attemptNumber_key"
    ON "execution_attempts"("workforceTaskId", "attemptNumber");
CREATE INDEX "execution_attempts_spaceId_createdAt_idx"
    ON "execution_attempts"("spaceId", "createdAt");
CREATE INDEX "execution_attempts_runId_idx" ON "execution_attempts"("runId");
CREATE INDEX "execution_attempts_parentRunId_idx" ON "execution_attempts"("parentRunId");

ALTER TABLE "execution_attempts"
    ADD CONSTRAINT "execution_attempts_meetingActionId_fkey"
    FOREIGN KEY ("meetingActionId") REFERENCES "meeting_action_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "execution_attempts"
    ADD CONSTRAINT "execution_attempts_workforceTaskId_fkey"
    FOREIGN KEY ("workforceTaskId") REFERENCES "workforce_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "execution_attempts" (
    "id", "spaceId", "sourceType", "sourceId", "meetingActionId", "workforceTaskId",
    "taskId", "runId", "parentRunId", "continuationOfRunId", "attemptNumber",
    "status", "resultStatus", "resultSummary", "evidence", "error",
    "startedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
    'ux-meeting:' || a."id",
    m."spaceId",
    'MEETING_ACTION',
    a."actionItemId",
    a."actionItemId",
    NULL,
    a."taskId",
    a."botRunId",
    r."parentRunId",
    r."continuationOfRunId",
    a."attemptNumber",
    a."status",
    a."resultStatus",
    a."resultSummary",
    a."evidence",
    a."error",
    a."startedAt",
    a."completedAt",
    a."createdAt",
    a."createdAt"
FROM "meeting_action_attempts" a
JOIN "meeting_action_items" i ON i."id" = a."actionItemId"
JOIN "meetings" m ON m."id" = i."meetingId"
LEFT JOIN "runs" r ON r."id" = a."botRunId"
ON CONFLICT ("sourceType", "sourceId", "attemptNumber") DO NOTHING;

INSERT INTO "execution_attempts" (
    "id", "spaceId", "sourceType", "sourceId", "meetingActionId", "workforceTaskId",
    "taskId", "runId", "parentRunId", "continuationOfRunId", "attemptNumber",
    "status", "resultStatus", "resultSummary", "evidence", "error",
    "startedAt", "completedAt", "createdAt", "updatedAt"
)
SELECT
    'ux-workforce:' || a."id",
    w."spaceId",
    'WORKFORCE_TASK',
    a."taskId",
    NULL,
    a."taskId",
    a."taskRunId",
    a."botRunId",
    r."parentRunId",
    r."continuationOfRunId",
    a."attemptNumber",
    a."status",
    a."resultStatus",
    a."resultSummary",
    a."evidence",
    a."error",
    a."startedAt",
    a."completedAt",
    a."createdAt",
    a."createdAt"
FROM "workforce_task_attempts" a
JOIN "workforce_tasks" w ON w."id" = a."taskId"
LEFT JOIN "runs" r ON r."id" = a."botRunId"
ON CONFLICT ("sourceType", "sourceId", "attemptNumber") DO NOTHING;
