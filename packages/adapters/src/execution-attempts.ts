import type { MeetingActionAttemptView } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

function evidenceStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function executionAttemptView(attempt: {
  id: string;
  sourceId: string;
  attemptNumber: number;
  taskId: string | null;
  runId: string | null;
  status: string;
  resultStatus: string | null;
  resultSummary: string | null;
  evidence: unknown;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): MeetingActionAttemptView {
  return {
    id: attempt.id,
    actionItemId: attempt.sourceId,
    attemptNumber: attempt.attemptNumber,
    taskId: attempt.taskId,
    botRunId: attempt.runId,
    status: attempt.status as MeetingActionAttemptView["status"],
    resultStatus: attempt.resultStatus as MeetingActionAttemptView["resultStatus"],
    resultSummary: attempt.resultSummary,
    evidence: evidenceStrings(attempt.evidence),
    error: attempt.error,
    startedAt: attempt.startedAt?.toISOString() ?? null,
    completedAt: attempt.completedAt?.toISOString() ?? null,
    createdAt: attempt.createdAt.toISOString(),
  };
}

export function unifiedAttemptId(
  sourceType: "MEETING_ACTION" | "WORKFORCE_TASK",
  legacyId: string,
): string {
  return `ux-${sourceType === "MEETING_ACTION" ? "meeting" : "workforce"}:${legacyId}`;
}

export async function createUnifiedAttempt(
  prisma: PrismaClient,
  input: {
    id: string;
    spaceId: string;
    sourceType: "MEETING_ACTION" | "WORKFORCE_TASK";
    sourceId: string;
    meetingActionId?: string;
    workforceTaskId?: string;
    taskId: string | null;
    runId: string | null;
    parentRunId?: string | null;
    continuationOfRunId?: string | null;
    attemptNumber: number;
    status: string;
    startedAt?: Date;
  },
): Promise<void> {
  await prisma.executionAttempt.create({
    data: {
      id: input.id,
      spaceId: input.spaceId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      meetingActionId: input.meetingActionId,
      workforceTaskId: input.workforceTaskId,
      taskId: input.taskId,
      runId: input.runId,
      parentRunId: input.parentRunId ?? null,
      continuationOfRunId: input.continuationOfRunId ?? null,
      attemptNumber: input.attemptNumber,
      status: input.status,
      startedAt: input.startedAt ?? new Date(),
    },
  });
}

export async function updateUnifiedAttempt(
  prisma: PrismaClient,
  sourceType: "MEETING_ACTION" | "WORKFORCE_TASK",
  sourceId: string,
  attemptNumber: number,
  data: {
    status?: string;
    resultStatus?: string | null;
    resultSummary?: string | null;
    evidence?: string[];
    error?: string | null;
    completedAt?: Date | null;
  },
): Promise<void> {
  await prisma.executionAttempt.updateMany({
    where: { sourceType, sourceId, attemptNumber },
    data,
  });
}
