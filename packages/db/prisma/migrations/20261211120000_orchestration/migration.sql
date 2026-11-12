-- Additive: tracked parallel delegations. No existing table or row is changed.
CREATE TABLE "orchestrations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentBotId" TEXT NOT NULL,
    "parentThreadId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "clientNonce" TEXT,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "joinRunId" TEXT,
    "joinedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "orchestrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orchestration_children" (
    "id" TEXT NOT NULL,
    "orchestrationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT,
    "taskId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL,
    "resultText" TEXT,
    "resultMessageId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "orchestration_children_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orchestrations_spaceId_clientNonce_key" ON "orchestrations"("spaceId", "clientNonce");
CREATE INDEX "orchestrations_spaceId_parentBotId_createdAt_idx" ON "orchestrations"("spaceId", "parentBotId", "createdAt");
CREATE INDEX "orchestrations_status_deadlineAt_idx" ON "orchestrations"("status", "deadlineAt");
CREATE INDEX "orchestrations_joinRunId_idx" ON "orchestrations"("joinRunId");
CREATE INDEX "orchestration_children_orchestrationId_idx" ON "orchestration_children"("orchestrationId");
CREATE INDEX "orchestration_children_runId_idx" ON "orchestration_children"("runId");
CREATE INDEX "orchestration_children_botId_idx" ON "orchestration_children"("botId");

ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
