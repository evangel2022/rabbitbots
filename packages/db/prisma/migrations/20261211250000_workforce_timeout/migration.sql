-- Explicit timeout delivery and late-result audit fields.
ALTER TABLE "workforce_delegations"
    ADD COLUMN IF NOT EXISTS "timedOutAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lateResultStatus" TEXT,
    ADD COLUMN IF NOT EXISTS "lateResultSummary" TEXT,
    ADD COLUMN IF NOT EXISTS "lateResultAt" TIMESTAMP(3);
