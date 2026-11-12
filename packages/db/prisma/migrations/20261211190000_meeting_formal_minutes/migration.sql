-- Additive discussion/decision and action-item acceptance fields for formal meeting minutes.
ALTER TABLE "meeting_decisions"
    ADD COLUMN "discussionState" TEXT NOT NULL DEFAULT 'UNRESOLVED',
    ADD COLUMN "supportingOpinions" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "evidenceGaps" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "meeting_action_items"
    ADD COLUMN "acceptanceCriteria" TEXT NOT NULL DEFAULT '';
