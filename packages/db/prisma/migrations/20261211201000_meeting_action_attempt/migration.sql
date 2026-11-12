ALTER TABLE "meeting_action_items"
    ADD COLUMN IF NOT EXISTS "executionAttempt" INTEGER NOT NULL DEFAULT 0;
