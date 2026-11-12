-- Additive generic workforce tasks for CEO direct and Bot-delegated work.
CREATE TABLE "workforce_tasks" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CEO_DIRECT',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "acceptanceCriteria" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "assigneeBotId" TEXT,
    "assigneeUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "parentRunId" TEXT,
    "parentMeetingActionId" TEXT,
    "delegatorBotId" TEXT,
    "delegationDepth" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "taskId" TEXT,
    "botRunId" TEXT,
    "executionAttempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "resultStatus" TEXT,
    "resultSummary" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "blockedReason" TEXT,
    "acceptanceStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workforce_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workforce_tasks_spaceId_createdAt_idx" ON "workforce_tasks"("spaceId", "createdAt");
CREATE INDEX "workforce_tasks_assigneeBotId_idx" ON "workforce_tasks"("assigneeBotId");
CREATE INDEX "workforce_tasks_botRunId_idx" ON "workforce_tasks"("botRunId");
ALTER TABLE "workforce_tasks"
    ADD CONSTRAINT "workforce_tasks_assigneeBotId_fkey"
    FOREIGN KEY ("assigneeBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "workforce_tasks"
    ADD CONSTRAINT "workforce_tasks_parentTaskId_fkey"
    FOREIGN KEY ("parentTaskId") REFERENCES "workforce_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "workforce_task_attempts" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "taskRunId" TEXT,
    "botRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "resultStatus" TEXT,
    "resultSummary" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workforce_task_attempts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workforce_task_attempts_taskId_attemptNumber_key"
    ON "workforce_task_attempts"("taskId", "attemptNumber");
CREATE INDEX "workforce_task_attempts_spaceId_createdAt_idx"
    ON "workforce_task_attempts"("spaceId", "createdAt");
CREATE INDEX "workforce_task_attempts_botRunId_idx"
    ON "workforce_task_attempts"("botRunId");
ALTER TABLE "workforce_task_attempts"
    ADD CONSTRAINT "workforce_task_attempts_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "workforce_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workforce_task_acceptances" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "clientNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workforce_task_acceptances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workforce_task_acceptances_taskId_clientNonce_key"
    ON "workforce_task_acceptances"("taskId", "clientNonce");
CREATE INDEX "workforce_task_acceptances_spaceId_createdAt_idx"
    ON "workforce_task_acceptances"("spaceId", "createdAt");
ALTER TABLE "workforce_task_acceptances"
    ADD CONSTRAINT "workforce_task_acceptances_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "workforce_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
