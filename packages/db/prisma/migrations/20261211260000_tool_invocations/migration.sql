-- Durable runtime tool-call invocation identity and execution lifecycle.
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "providerToolCallId" TEXT,
    "toolName" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tool_invocations_spaceId_invocationId_key"
    ON "tool_invocations"("spaceId", "invocationId");

CREATE INDEX "tool_invocations_runId_status_idx"
    ON "tool_invocations"("runId", "status");

CREATE INDEX "tool_invocations_status_leaseExpiresAt_idx"
    ON "tool_invocations"("status", "leaseExpiresAt");

ALTER TABLE "tool_invocations"
    ADD CONSTRAINT "tool_invocations_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tool_invocations"
    ADD CONSTRAINT "tool_invocations_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
