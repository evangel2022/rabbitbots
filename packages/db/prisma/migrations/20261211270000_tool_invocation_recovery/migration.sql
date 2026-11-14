-- Additive durable invocation recovery metadata. Existing rows keep their status and receive safe defaults.
ALTER TABLE "tool_invocations"
    ADD COLUMN IF NOT EXISTS "turnId" TEXT,
    ADD COLUMN IF NOT EXISTS "messageId" TEXT,
    ADD COLUMN IF NOT EXISTS "toolCallIndex" INTEGER,
    ADD COLUMN IF NOT EXISTS "runtimeDepth" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "parentInvocationId" TEXT,
    ADD COLUMN IF NOT EXISTS "invocationSequence" INTEGER,
    ADD COLUMN IF NOT EXISTS "executionStage" TEXT NOT NULL DEFAULT 'RECEIVED',
    ADD COLUMN IF NOT EXISTS "recoverability" TEXT NOT NULL DEFAULT 'UNKNOWN',
    ADD COLUMN IF NOT EXISTS "secretReferences" JSONB;

CREATE INDEX IF NOT EXISTS "tool_invocations_runId_invocationSequence_idx"
    ON "tool_invocations"("runId", "invocationSequence");

CREATE INDEX IF NOT EXISTS "tool_invocations_status_executionStage_idx"
    ON "tool_invocations"("status", "executionStage");
