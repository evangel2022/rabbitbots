-- B2.2 delegation idempotency identity. Additive: historical delegations stay null.
ALTER TABLE "workforce_delegations"
    ADD COLUMN IF NOT EXISTS "toolInvocationId" TEXT,
    ADD COLUMN IF NOT EXISTS "requestDigest" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "workforce_delegations_toolInvocationId_key"
    ON "workforce_delegations"("toolInvocationId");
