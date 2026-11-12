-- Additive immutable approval history for meeting agenda decisions.
CREATE TABLE "meeting_decision_approvals" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "rationale" TEXT,
    "conditions" TEXT,
    "clientNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_decision_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meeting_decision_approvals_decisionId_clientNonce_key"
    ON "meeting_decision_approvals"("decisionId", "clientNonce");
CREATE INDEX "meeting_decision_approvals_meetingId_createdAt_idx"
    ON "meeting_decision_approvals"("meetingId", "createdAt");
CREATE INDEX "meeting_decision_approvals_decisionId_createdAt_idx"
    ON "meeting_decision_approvals"("decisionId", "createdAt");

ALTER TABLE "meeting_decision_approvals"
    ADD CONSTRAINT "meeting_decision_approvals_meetingId_fkey"
    FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_decision_approvals"
    ADD CONSTRAINT "meeting_decision_approvals_decisionId_fkey"
    FOREIGN KEY ("decisionId") REFERENCES "meeting_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
