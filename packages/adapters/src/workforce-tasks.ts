import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  meetingActionReconcileJob,
  runContinueJob,
  workforceTaskReconcileJob,
} from "@rakazo/adapter-kit";
import type {
  MeetingActionAcceptanceAction,
  MeetingActionAcceptanceView,
  MeetingActionAttemptView,
  WorkforceTaskSource,
  WorkforceTaskView,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { cancelRunsInTransaction, isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createUnifiedAttempt, updateUnifiedAttempt } from "./execution-attempts.js";
import { readRunOutcome } from "./orchestration.js";

export type WorkforceDeps = { prisma: PrismaClient; jobs: JobPublisher };
type TaskRow = Awaited<ReturnType<typeof findTask>>;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_DELEGATION_DEPTH = 3;
const MAX_CHILDREN = 5;
const DELEGATION_TIMEOUT_MS = 15 * 60_000;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

async function findTask(prisma: PrismaClient, taskId: string) {
  return prisma.workforceTask.findUnique({
    where: { id: taskId },
    include: {
      assigneeBot: { select: { name: true } },
      attempts: { orderBy: { attemptNumber: "asc" } },
      executionAttempts: { orderBy: { attemptNumber: "asc" } },
      acceptances: { orderBy: { createdAt: "asc" } },
      delegations: { orderBy: { createdAt: "asc" } },
    },
  });
}

export function workforceTaskView(
  task: NonNullable<TaskRow>,
  assigneeUserName: string | null = null,
): WorkforceTaskView {
  return {
    id: task.id,
    source: task.source as WorkforceTaskSource,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    assigneeBotId: task.assigneeBotId,
    assigneeBotName: task.assigneeBot?.name ?? null,
    assigneeUserId: task.assigneeUserId,
    assigneeUserName,
    meetingId: null,
    meetingTitle: null,
    decisionId: null,
    decisionType: null,
    approvalStatus: null,
    conditionsConfirmedAt: null,
    executionStatus: task.status as WorkforceTaskView["executionStatus"],
    linkedExecutionStatus: null,
    latestResultStatus: (task.resultStatus as WorkforceTaskView["latestResultStatus"]) ?? null,
    latestResultSummary: task.resultSummary,
    acceptanceStatus: task.acceptanceStatus,
    blockedReason: task.blockedReason,
    priority: task.priority as WorkforceTaskView["priority"],
    dueAt: task.dueAt?.toISOString() ?? null,
    parentTaskId: task.parentTaskId,
    parentMeetingActionId: task.parentMeetingActionId,
    linkedWorkforceTaskId: null,
    parentRunId: task.parentRunId,
    delegatorBotId: task.delegatorBotId,
    delegationDepth: task.delegationDepth,
    waitingForChildren: task.waitingForChildren,
    waitingSince: task.waitingSince?.toISOString() ?? null,
    continuationRunId: task.continuationRunId,
    delegationDeadlineAt: task.delegationDeadlineAt?.toISOString() ?? null,
    delegations: task.delegations.map((delegation) => ({
      id: delegation.id,
      parentTaskId: delegation.parentTaskId,
      childTaskId: delegation.childTaskId,
      parentRunId: delegation.parentRunId,
      childRunId: delegation.childRunId,
      delegatorBotId: delegation.delegatorBotId,
      assigneeBotId: delegation.assigneeBotId,
      status: delegation.status as "WAITING" | "COMPLETED" | "FAILED" | "BLOCKED" | "TIMED_OUT",
      resultStatus: delegation.resultStatus,
      resultSummary: delegation.resultSummary,
      evidence: arrayValue(delegation.evidence),
      error: delegation.error,
      toolInvocationId: delegation.toolInvocationId,
      deliveredAt: delegation.deliveredAt?.toISOString() ?? null,
      completedAt: delegation.completedAt?.toISOString() ?? null,
      deadlineAt: delegation.deadlineAt?.toISOString() ?? null,
      timedOutAt: delegation.timedOutAt?.toISOString() ?? null,
      lateResultStatus: delegation.lateResultStatus,
      lateResultSummary: delegation.lateResultSummary,
      lateResultAt: delegation.lateResultAt?.toISOString() ?? null,
      createdAt: delegation.createdAt.toISOString(),
    })),
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    attempts: task.attempts.map(
      (attempt): MeetingActionAttemptView => ({
        id: attempt.id,
        actionItemId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        taskId: attempt.taskRunId,
        botRunId: attempt.botRunId,
        status: attempt.status as MeetingActionAttemptView["status"],
        resultStatus: attempt.resultStatus as MeetingActionAttemptView["resultStatus"],
        resultSummary: attempt.resultSummary,
        evidence: arrayValue(attempt.evidence),
        error: attempt.error,
        startedAt: attempt.startedAt?.toISOString() ?? null,
        completedAt: attempt.completedAt?.toISOString() ?? null,
        createdAt: attempt.createdAt.toISOString(),
      }),
    ),
    acceptances: task.acceptances.map(
      (acceptance): MeetingActionAcceptanceView => ({
        id: acceptance.id,
        actionItemId: acceptance.taskId,
        action: acceptance.action as MeetingActionAcceptanceView["action"],
        actorUserId: acceptance.actorUserId,
        actorName: acceptance.actorName,
        comment: acceptance.comment,
        createdAt: acceptance.createdAt.toISOString(),
      }),
    ),
  };
}

async function loadView(prisma: PrismaClient, taskId: string): Promise<WorkforceTaskView> {
  const task = await findTask(prisma, taskId);
  if (!task) throw new Error("Workforce task not found.");
  const user = task.assigneeUserId
    ? await prisma.user.findUnique({ where: { id: task.assigneeUserId }, select: { name: true } })
    : null;
  return workforceTaskView(task, user?.name ?? null);
}

export async function createDirectWorkforceTask(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    assigneeBotId: string;
    priority: string;
    dueAt?: string | null;
    /** Internal demo linkage; the normal create API does not set this. */
    parentMeetingActionId?: string | null;
  },
): Promise<WorkforceTaskView> {
  const bot = await prisma.bot.findFirst({
    where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) throw new Error("The selected Bot is not available in this Space.");
  const task = await prisma.workforceTask.create({
    data: {
      spaceId: input.spaceId,
      source: "CEO_DIRECT",
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      priority: input.priority,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      assigneeBotId: bot.id,
      createdByUserId: input.userId,
      parentMeetingActionId: input.parentMeetingActionId ?? null,
      delegationDepth: 0,
      status: "OPEN",
    },
  });
  return loadView(prisma, task.id);
}

/** Create the durable parent task for a normal Meeting Action inside the caller's transaction. */
export async function createMeetingActionWorkforceTask(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    userId: string;
    actionItemId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    assigneeBotId: string;
    dueAt: Date | null;
  },
): Promise<{
  id: string;
  spaceId: string;
  status: string;
  executionAttempt: number;
  taskId: string | null;
  botRunId: string | null;
  startedAt: Date | null;
  assigneeBotId: string | null;
}> {
  const bot = await tx.bot.findFirst({
    where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) throw new Error("The assigned Bot is not available in this Space.");
  return tx.workforceTask.create({
    data: {
      spaceId: input.spaceId,
      source: "MEETING_DECISION",
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      priority: "NORMAL",
      dueAt: input.dueAt,
      assigneeBotId: bot.id,
      createdByUserId: input.userId,
      parentMeetingActionId: input.actionItemId,
      delegationDepth: 0,
      status: "OPEN",
    },
    select: {
      id: true,
      spaceId: true,
      status: true,
      executionAttempt: true,
      taskId: true,
      botRunId: true,
      startedAt: true,
      assigneeBotId: true,
    },
  });
}

/**
 * Start one parent execution attempt inside a caller-owned transaction.
 * The caller owns the action/workflow row lock and all higher-level validation.
 */
export async function startWorkforceExecutionInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    task: {
      id: string;
      spaceId: string;
      executionAttempt: number;
      status: string;
      assigneeBotId: string | null;
    };
    bot: { id: string; threadId: string };
    userId: string;
    prompt: string;
    runTrigger: "workforce_task" | "meeting_action";
    meetingAction?: { meetingId: string; actionId: string };
    startedAt?: Date;
  },
): Promise<{
  taskId: string;
  runId: string;
  attemptNumber: number;
  workforceTaskAttemptId: string;
  meetingActionAttemptId: string | null;
  executionAttemptId: string;
}> {
  if (input.task.status === "COMPLETED" || input.task.status === "BLOCKED") {
    throw new Error("This task is already complete or blocked.");
  }
  const startedAt = input.startedAt ?? new Date();
  const attemptNumber = input.task.executionAttempt + 1;
  const clientNonce = input.meetingAction
    ? `meeting-action:${input.meetingAction.actionId}:${attemptNumber}`
    : `workforce-task:${input.task.id}:${attemptNumber}`;
  const taskRow = await tx.task.create({
    data: {
      spaceId: input.task.spaceId,
      botId: input.bot.id,
      threadId: input.bot.threadId,
      userId: input.userId,
      prompt: input.prompt,
      status: "queued",
    },
    select: { id: true },
  });
  const run = await tx.run.create({
    data: {
      spaceId: input.task.spaceId,
      botId: input.bot.id,
      threadId: input.bot.threadId,
      taskId: taskRow.id,
      userId: input.userId,
      status: "queued",
      trigger: input.runTrigger,
      clientNonce,
      maxOutputTokens: 3_000,
    },
    select: { id: true },
  });
  const workforceAttempt = await tx.workforceTaskAttempt.create({
    data: {
      spaceId: input.task.spaceId,
      taskId: input.task.id,
      attemptNumber,
      taskRunId: taskRow.id,
      botRunId: run.id,
      status: "RUNNING",
      startedAt,
    },
    select: { id: true },
  });
  let meetingActionAttemptId: string | null = null;
  if (input.meetingAction) {
    const meetingAttempt = await tx.meetingActionAttempt.create({
      data: {
        meetingId: input.meetingAction.meetingId,
        actionItemId: input.meetingAction.actionId,
        attemptNumber,
        taskId: taskRow.id,
        botRunId: run.id,
        status: "RUNNING",
        startedAt,
      },
      select: { id: true },
    });
    meetingActionAttemptId = meetingAttempt.id;
    await tx.executionAttempt.create({
      data: {
        id: `ux-meeting:${meetingAttempt.id}`,
        spaceId: input.task.spaceId,
        sourceType: "MEETING_ACTION",
        sourceId: input.meetingAction.actionId,
        meetingActionId: input.meetingAction.actionId,
        workforceTaskId: input.task.id,
        taskId: taskRow.id,
        runId: run.id,
        attemptNumber,
        status: "RUNNING",
        startedAt,
      },
    });
  } else {
    await tx.executionAttempt.create({
      data: {
        id: `ux-workforce:${workforceAttempt.id}`,
        spaceId: input.task.spaceId,
        sourceType: "WORKFORCE_TASK",
        sourceId: input.task.id,
        workforceTaskId: input.task.id,
        taskId: taskRow.id,
        runId: run.id,
        attemptNumber,
        status: "RUNNING",
        startedAt,
      },
    });
  }
  await tx.workforceTask.update({
    where: { id: input.task.id },
    data: {
      status: "IN_PROGRESS",
      executionAttempt: attemptNumber,
      taskId: taskRow.id,
      botRunId: run.id,
      startedAt,
      completedAt: null,
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      blockedReason: null,
      acceptanceStatus: null,
      waitingForChildren: false,
      waitingSince: null,
      continuationRunId: null,
      continuationOfRunId: null,
      delegationDeadlineAt: null,
    },
  });
  const executionAttempt = await tx.executionAttempt.findFirstOrThrow({
    where: input.meetingAction
      ? { meetingActionId: input.meetingAction.actionId, attemptNumber }
      : { workforceTaskId: input.task.id, attemptNumber },
    select: { id: true },
  });
  return {
    taskId: taskRow.id,
    runId: run.id,
    attemptNumber,
    workforceTaskAttemptId: workforceAttempt.id,
    meetingActionAttemptId,
    executionAttemptId: executionAttempt.id,
  };
}

function actionResult(text: string): { resultStatus: string; summary: string; evidence: string[] } {
  // The runtime's empty-completion fallback is not a model result. Do not let an
  // empty provider response become a successful Workforce result.
  if (!text.trim() || text.trim() === "No response. Try again.") {
    return {
      resultStatus: "FAILED",
      summary: "The model returned no response. The task did not produce a result.",
      evidence: [],
    };
  }
  let object: Record<string, unknown> | null = null;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    object =
      start >= 0 && end > start
        ? (JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>)
        : null;
  } catch {
    object = null;
  }
  const summary = object
    ? stringValue(object.summary) || stringValue(object.resultSummary)
    : text.trim().slice(0, 4_000);
  return {
    resultStatus: object ? stringValue(object.resultStatus).toUpperCase() || "SUCCESS" : "SUCCESS",
    summary: summary || "The Bot returned no summary.",
    evidence: object ? arrayValue(object.evidence) : [],
  };
}

export const DEMO_DELEGATION_MARKER = "[[rabbitbots-demo-delegation]]";

const DEMO_CHILD_TITLE = "Research and compare two developer launch channels";
const DEMO_CHILD_DESCRIPTION =
  "Research two developer launch channels for RabbitBots using verifiable primary sources. Separate FACT, ASSUMPTION and UNVERIFIED information, record access dates and failed retrievals, and do not publish, contact, spend or perform any irreversible action.";
const DEMO_CHILD_ACCEPTANCE =
  "Two launch channels are compared; every FACT has a source and access date; assumptions and unverified items are explicit; failed retrievals are recorded; no external action is taken.";

async function createDeterministicDemoChild(
  deps: WorkforceDeps,
  input: {
    spaceId: string;
    userId: string;
    parentTaskId: string;
    parentRunId: string;
    parentBotId: string;
  },
): Promise<void> {
  const candidates = await deps.prisma.bot.findMany({
    where: {
      spaceId: input.spaceId,
      archivedAt: null,
      name: { in: ["Research Bot", "Operations Bot", "Finance Bot"] },
    },
    select: { id: true, name: true },
  });
  const target =
    candidates.find((bot) => bot.name === "Research Bot" && bot.id !== input.parentBotId) ??
    candidates.find((bot) => bot.id !== input.parentBotId);
  if (!target) {
    throw new Error("The Developer Demo needs a second Bot for delegation.");
  }
  try {
    await delegateWorkforceTask(deps, {
      spaceId: input.spaceId,
      parentRunId: input.parentRunId,
      delegatorBotId: input.parentBotId,
      userId: input.userId,
      assigneeBotId: target.id,
      title: DEMO_CHILD_TITLE,
      description: DEMO_CHILD_DESCRIPTION,
      acceptanceCriteria: DEMO_CHILD_ACCEPTANCE,
      priority: "HIGH",
    });
  } catch (error) {
    await deps.prisma.workforceTask.update({
      where: { id: input.parentTaskId },
      data: {
        status: "BLOCKED",
        resultStatus: "FAILED",
        blockedReason:
          error instanceof Error ? error.message : "The Developer Demo delegation could not start.",
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

/** The prompt shared by direct execution and delegated child execution. */
function workforceTaskPrompt(input: {
  source: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: string;
  parentRunId: string | null;
}) {
  return `You are acting as an AI employee executing a ${input.source.replaceAll("_", " ").toLowerCase()} task.

Task: ${input.title}
Description: ${input.description || "(none)"}
Acceptance criteria: ${input.acceptanceCriteria}
Priority: ${input.priority}
${input.parentRunId ? `This task was delegated by another Bot Run (${input.parentRunId}). Its result will be handed back to the delegating bot.` : ""}

If the task specifically needs another Bot role, use delegate_task to create one bounded child task (never yourself, never a cycle, at most three levels), then use delegated_task_status to read its result. Do not claim the child succeeded unless its returned status is SUCCESS or PARTIAL.

Work safely and stay within your role. If this task can be completed from the available task context, do so without external tools. Do not send email, contact a company, purchase, spend, sign, or perform an irreversible action.
When finished, return ONE JSON object:
{"resultStatus":"SUCCESS"|"PARTIAL"|"FAILED"|"BLOCKED","summary":"what you did and what remains","evidence":["URLs, file paths or concrete verification references"],"acceptanceCriteriaCheck":"how the criterion was met or not met"}`;
}

/**
 * Execute a generic Workforce task through the existing Task/Run runtime. CEO Direct tasks are
 * authorized by the authenticated creator; delegated tasks are authorized by their parent task.
 */
export async function executeWorkforceTask(
  deps: WorkforceDeps,
  input: { spaceId: string; userId: string; taskId: string; clientNonce: string },
  options?: { runTrigger?: "workforce_task" | "meeting_action"; prompt?: string },
): Promise<WorkforceTaskView> {
  const task = await findTask(deps.prisma, input.taskId);
  if (!task || task.spaceId !== input.spaceId) throw new Error("Task not found in this Space.");
  if (task.status === "COMPLETED" || task.status === "BLOCKED") {
    throw new Error("This task is already complete or blocked.");
  }
  // An evidence request is an explicit CEO request for a new execution attempt.
  // Keep the prior Task/Run rows for audit history; only the active pointers move.
  if (task.taskId && task.botRunId && task.acceptanceStatus !== "EVIDENCE_REQUESTED") {
    return loadView(deps.prisma, task.id);
  }
  if (!task.assigneeBotId) throw new Error("The task has no Bot assignee.");
  const bot = await deps.prisma.bot.findFirst({
    where: { id: task.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new Error("The assigned Bot has no execution thread.");
  const threadId = bot.thread.id;
  const attempt = task.executionAttempt + 1;
  const clientNonce = `workforce-task:${task.id}:${attempt}`;
  const prompt = options?.prompt ?? workforceTaskPrompt(task);
  const taskRow = await deps.prisma.task.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: input.userId,
      prompt,
      status: "queued",
    },
    select: { id: true },
  });
  let runId: string;
  try {
    const run = await deps.prisma.run.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId,
        taskId: taskRow.id,
        userId: input.userId,
        status: "queued",
        trigger: options?.runTrigger ?? "workforce_task",
        clientNonce,
        maxOutputTokens: 3_000,
      },
      select: { id: true },
    });
    runId = run.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.prisma.run.findUniqueOrThrow({
      where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce } },
      select: { id: true },
    });
    runId = raced.id;
  }
  const legacyAttempt = await deps.prisma.workforceTaskAttempt.create({
    data: {
      spaceId: input.spaceId,
      taskId: task.id,
      attemptNumber: attempt,
      taskRunId: taskRow.id,
      botRunId: runId,
      status: "RUNNING",
      startedAt: new Date(),
    },
    select: { id: true },
  });
  await createUnifiedAttempt(deps.prisma, {
    id: `ux-workforce:${legacyAttempt.id}`,
    spaceId: input.spaceId,
    sourceType: "WORKFORCE_TASK",
    sourceId: task.id,
    workforceTaskId: task.id,
    taskId: taskRow.id,
    runId,
    attemptNumber: attempt,
    status: "RUNNING",
  });
  await deps.prisma.workforceTask.update({
    where: { id: task.id },
    data: {
      status: "IN_PROGRESS",
      executionAttempt: attempt,
      taskId: taskRow.id,
      botRunId: runId,
      startedAt: new Date(),
      completedAt: null,
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      blockedReason: null,
      acceptanceStatus: null,
    },
  });
  if (task.description.startsWith(DEMO_DELEGATION_MARKER) && task.delegations.length === 0) {
    await createDeterministicDemoChild(deps, {
      spaceId: input.spaceId,
      userId: input.userId,
      parentTaskId: task.id,
      parentRunId: runId,
      parentBotId: bot.id,
    });
    const parentRun = await deps.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, taskId: true, userId: true, spaceId: true },
    });
    if (parentRun) {
      const now = new Date();
      await deps.prisma.$transaction(async (tx) => {
        await cancelRunsInTransaction(tx, [parentRun], now);
        await tx.workforceTaskAttempt.updateMany({
          where: { taskId: task.id, botRunId: runId, status: "RUNNING" },
          data: {
            status: "FAILED",
            error: "Parent run was replaced by the deterministic demo delegation.",
            completedAt: now,
          },
        });
      });
    }
    return loadView(deps.prisma, task.id);
  }
  await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
    getLogger().error("workforce task run enqueue failed", error);
  });
  await deps.jobs.enqueue(workforceTaskReconcileJob(task.id)).catch((error) => {
    getLogger().error("workforce task reconcile enqueue failed", error);
  });
  return loadView(deps.prisma, task.id);
}

async function settleOrphanedAttempts(deps: WorkforceDeps, taskId: string): Promise<void> {
  const attempts = await deps.prisma.workforceTaskAttempt.findMany({
    where: { taskId, status: "RUNNING", botRunId: { not: null } },
    select: { id: true, botRunId: true },
  });
  for (const attempt of attempts) {
    const run = attempt.botRunId
      ? await deps.prisma.run.findUnique({
          where: { id: attempt.botRunId },
          select: { status: true, error: true, completedAt: true },
        })
      : null;
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const failed = run.status !== "completed";
    await deps.prisma.workforceTaskAttempt.updateMany({
      where: { id: attempt.id, status: "RUNNING" },
      data: {
        status: failed ? "FAILED" : "COMPLETED",
        error: failed ? (run.error ?? "Parent run ended before the task finished.") : null,
        completedAt: run.completedAt ?? new Date(),
      },
    });
  }
}

export async function reconcileWorkforceTask(deps: WorkforceDeps, taskId: string): Promise<void> {
  const task = await deps.prisma.workforceTask.findUnique({ where: { id: taskId } });
  if (!task) return;
  await settleOrphanedAttempts(deps, task.id);
  // A delegated or meeting parent owns its completion only after its own
  // continuation Run is terminal. A finished child never reaches this branch.
  if (
    (task.source === "BOT_DELEGATED" ||
      task.source === "MEETING_DECISION" ||
      Boolean(task.parentMeetingActionId)) &&
    task.status === "IN_PROGRESS" &&
    task.resultStatus &&
    task.botRunId &&
    !task.waitingForChildren
  ) {
    const run = await deps.prisma.run.findUnique({
      where: { id: task.botRunId },
      select: { status: true, completedAt: true },
    });
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) {
      await deps.prisma.workforceTask.update({
        where: { id: task.id },
        data: {
          status:
            task.resultStatus === "FAILED" || task.resultStatus === "BLOCKED"
              ? "BLOCKED"
              : "COMPLETED",
          completedAt: run.completedAt ?? new Date(),
        },
      });
      return;
    }
  }
  if (task.status === "WAITING_FOR_CHILDREN") {
    await settleWaitingParentRun(deps, task);
    await continueParentIfReady(deps, task.id);
    return;
  }
  if (!task.botRunId || task.status !== "IN_PROGRESS" || task.resultStatus) return;
  const run = await deps.prisma.run.findUnique({ where: { id: task.botRunId } });
  if (!run) return;
  if (ACTIVE_RUN_STATUSES.includes(run.status as never)) {
    await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
    return;
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
  const attempt = await deps.prisma.workforceTaskAttempt.findFirst({
    where: { taskId: task.id, attemptNumber: task.executionAttempt },
    select: { id: true },
  });
  const outcome = await readRunOutcome(deps.prisma, run.id);
  if (run.status === "failed" || run.status === "cancelled" || !outcome.text.trim()) {
    await deps.prisma.workforceTask.update({
      where: { id: task.id },
      data: {
        status: task.waitingForChildren ? "WAITING_FOR_CHILDREN" : "BLOCKED",
        resultStatus: "FAILED",
        blockedReason: run.error ?? "The Bot run produced no usable result.",
        resultSummary: outcome.text.slice(0, 4_000) || null,
        completedAt: new Date(),
      },
    });
    if (attempt) {
      await deps.prisma.workforceTaskAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "FAILED",
          resultStatus: "FAILED",
          resultSummary: outcome.text.slice(0, 4_000) || null,
          error: run.error ?? "The Bot run produced no usable result.",
          completedAt: new Date(),
        },
      });
    }
    await updateUnifiedAttempt(deps.prisma, "WORKFORCE_TASK", task.id, task.executionAttempt, {
      status: "FAILED",
      resultStatus: "FAILED",
      resultSummary: outcome.text.slice(0, 4_000) || null,
      evidence: [],
      error: run.error ?? "The Bot run produced no usable result.",
      completedAt: new Date(),
    });
    await deliverChildDelegation(deps, task.id);
    return;
  }
  const parsed = actionResult(outcome.text);
  const failed = parsed.resultStatus === "FAILED" || parsed.resultStatus === "BLOCKED";
  const waiting = task.waitingForChildren;
  // Executing successfully is not the same as the human CEO accepting the result.
  // A terminal run marks the task complete even when acceptance is still pending.
  await deps.prisma.workforceTask.update({
    where: { id: task.id },
    data: {
      status: waiting ? "WAITING_FOR_CHILDREN" : failed ? "BLOCKED" : "COMPLETED",
      resultStatus: parsed.resultStatus,
      resultSummary: parsed.summary,
      evidence: parsed.evidence,
      blockedReason: failed ? parsed.summary : null,
      completedAt: waiting || failed ? null : (run.completedAt ?? new Date()),
    },
  });
  if (attempt) {
    await deps.prisma.workforceTaskAttempt.update({
      where: { id: attempt.id },
      data: {
        status: failed ? "FAILED" : "COMPLETED",
        resultStatus: parsed.resultStatus,
        resultSummary: parsed.summary,
        evidence: parsed.evidence,
        error: failed ? parsed.summary : null,
        completedAt: new Date(),
      },
    });
  }
  await updateUnifiedAttempt(deps.prisma, "WORKFORCE_TASK", task.id, task.executionAttempt, {
    status: failed ? (parsed.resultStatus === "BLOCKED" ? "BLOCKED" : "FAILED") : "COMPLETED",
    resultStatus: parsed.resultStatus,
    resultSummary: parsed.summary,
    evidence: parsed.evidence,
    error: failed ? parsed.summary : null,
    completedAt: new Date(),
  });
  await deliverChildDelegation(deps, task.id);
}

export async function acceptWorkforceTask(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    taskId: string;
    action: MeetingActionAcceptanceAction;
    comment?: string;
    clientNonce: string;
  },
): Promise<WorkforceTaskView> {
  const task = await findTask(prisma, input.taskId);
  if (!task || task.spaceId !== input.spaceId) throw new Error("Task not found in this Space.");
  if (task.source === "MEETING_DECISION") {
    throw new Error("Meeting actions must be accepted through the meeting action acceptance flow.");
  }
  const comment = input.comment?.trim() || null;
  const existing = await prisma.workforceTaskAcceptance.findUnique({
    where: { taskId_clientNonce: { taskId: task.id, clientNonce: input.clientNonce } },
  });
  if (existing) {
    if (existing.action !== input.action || (existing.comment ?? null) !== comment) {
      throw new Error("This acceptance retry conflicts with the recorded acceptance.");
    }
    return loadView(prisma, task.id);
  }
  if (
    (input.action === "REJECT" ||
      input.action === "BLOCK" ||
      input.action === "REQUEST_EVIDENCE") &&
    !comment
  ) {
    throw new Error("A comment is required for this acceptance action.");
  }
  if (
    input.action === "ACCEPT" &&
    ((task.status !== "IN_PROGRESS" && task.status !== "COMPLETED") ||
      (task.resultStatus !== "SUCCESS" && task.resultStatus !== "PARTIAL"))
  ) {
    throw new Error("Only a submitted SUCCESS or PARTIAL result can be accepted.");
  }
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { name: true },
  });
  if (!actor) throw new Error("Accepting user was not found.");
  const now = new Date();
  const update =
    input.action === "ACCEPT"
      ? { status: "COMPLETED", acceptanceStatus: "ACCEPTED", completedAt: now }
      : input.action === "REQUEST_EVIDENCE"
        ? { status: "IN_PROGRESS", acceptanceStatus: "EVIDENCE_REQUESTED" }
        : input.action === "RE_EXECUTE"
          ? {
              status: "OPEN",
              acceptanceStatus: "RE_EXECUTE_REQUESTED",
              taskId: null,
              botRunId: null,
              startedAt: null,
              completedAt: null,
              resultStatus: null,
              resultSummary: null,
              evidence: [],
              blockedReason: null,
            }
          : {
              status: "BLOCKED",
              acceptanceStatus:
                input.action === "REJECT"
                  ? "REJECTED"
                  : input.action === "CANCEL"
                    ? "CANCELLED"
                    : "BLOCKED",
              blockedReason: comment ?? (input.action === "CANCEL" ? "Cancelled by CEO." : null),
              completedAt: now,
            };
  await prisma.$transaction(async (tx) => {
    await tx.workforceTaskAcceptance.create({
      data: {
        spaceId: task.spaceId,
        taskId: task.id,
        actorUserId: input.userId,
        actorName: actor.name,
        action: input.action,
        comment,
        clientNonce: input.clientNonce,
      },
    });
    await tx.workforceTask.update({ where: { id: task.id }, data: update });
  });
  return loadView(prisma, task.id);
}

export async function assignWorkforceTask(
  prisma: PrismaClient,
  input: { spaceId: string; taskId: string; assigneeBotId: string },
): Promise<WorkforceTaskView> {
  const task = await findTask(prisma, input.taskId);
  if (!task || task.spaceId !== input.spaceId) throw new Error("Task not found in this Space.");
  if (task.status === "IN_PROGRESS" || task.status === "COMPLETED") {
    throw new Error("A running or completed task cannot be reassigned.");
  }
  const bot = await prisma.bot.findFirst({
    where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!bot) throw new Error("The new assignee Bot is not available in this Space.");
  await prisma.workforceTask.update({
    where: { id: task.id },
    data: {
      assigneeBotId: bot.id,
      status: "OPEN",
      taskId: null,
      botRunId: null,
      startedAt: null,
      completedAt: null,
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      blockedReason: null,
      acceptanceStatus: "REASSIGNED",
    },
  });
  return loadView(prisma, task.id);
}

/** Canonical digest of only the validated business delegation fields. */
export function delegationRequestDigest(input: {
  assigneeBotId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: string;
}): string {
  return createHash("sha256")
    .update(
      stableJsonValue({
        assigneeBotId: input.assigneeBotId,
        title: input.title,
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        priority: input.priority,
      }),
    )
    .digest("hex");
}

/** Create a child from a real parent Bot Run and start it atomically. Used by the delegation tool. */
export async function delegateWorkforceTask(
  deps: WorkforceDeps,
  input: {
    spaceId: string;
    parentRunId: string;
    delegatorBotId: string;
    userId: string;
    assigneeBotId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    /** Runtime-owned identity; never a model argument. */
    toolInvocationId?: string | null;
  },
): Promise<WorkforceTaskView> {
  const toolInvocationId = input.toolInvocationId?.trim() || null;
  const requestDigest = delegationRequestDigest({
    assigneeBotId: input.assigneeBotId,
    title: input.title,
    description: input.description,
    acceptanceCriteria: input.acceptanceCriteria,
    priority: input.priority,
  });
  if (input.assigneeBotId === input.delegatorBotId) {
    throw new Error("A Bot cannot delegate to itself.");
  }

  let outcome: { kind: "existing" | "created"; childTaskId: string; runId?: string };
  try {
    outcome = await deps.prisma.$transaction(
      async (tx) => {
        const parentRun = await tx.run.findUnique({
          where: { id: input.parentRunId },
          select: { id: true, spaceId: true, botId: true, status: true },
        });
        if (
          !parentRun ||
          parentRun.spaceId !== input.spaceId ||
          parentRun.botId !== input.delegatorBotId
        ) {
          throw new Error("The delegation was not started by this Bot in this Space.");
        }
        const target = await tx.bot.findFirst({
          where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
          select: { id: true, thread: { select: { id: true } } },
        });
        if (!target) throw new Error("The delegated Bot is not available in this Space.");
        if (!target.thread) throw new Error("The delegated Bot has no execution thread.");

        let parentWorkforce = await tx.workforceTask.findFirst({
          where: {
            spaceId: input.spaceId,
            OR: [
              { botRunId: input.parentRunId },
              // After a delegation continuation the parent points at its continuation Run,
              // but a replay of the original Invocation still names the original parent Run.
              { parentRunId: input.parentRunId, parentTaskId: null },
              { continuationOfRunId: input.parentRunId },
            ],
          },
        });
        const parentAction = parentWorkforce
          ? null
          : await tx.meetingActionItem.findFirst({
              where: { botRunId: input.parentRunId, meeting: { spaceId: input.spaceId } },
              select: { id: true, assigneeBotId: true },
            });
        if (!parentWorkforce && !parentAction) {
          throw new Error("The delegation was not started by a real task run.");
        }
        if (parentWorkforce) {
          await tx.$queryRaw`SELECT "id" FROM "workforce_tasks" WHERE "id" = ${parentWorkforce.id} FOR UPDATE`;
          parentWorkforce = await tx.workforceTask.findUniqueOrThrow({
            where: { id: parentWorkforce.id },
          });
        } else if (parentAction) {
          await tx.$queryRaw`SELECT "id" FROM "meeting_action_items" WHERE "id" = ${parentAction.id} FOR UPDATE`;
        }

        if (toolInvocationId) {
          const existing = await tx.workforceDelegation.findUnique({
            where: { toolInvocationId },
            select: {
              id: true,
              spaceId: true,
              parentRunId: true,
              parentTaskId: true,
              childTaskId: true,
              requestDigest: true,
            },
          });
          if (existing) {
            if (
              existing.spaceId !== input.spaceId ||
              existing.parentRunId !== input.parentRunId ||
              existing.parentTaskId !== (parentWorkforce?.id ?? existing.parentTaskId) ||
              existing.requestDigest !== requestDigest
            ) {
              throw new Error(
                "This delegation invocation was already used with different business arguments.",
              );
            }
            return { kind: "existing" as const, childTaskId: existing.childTaskId };
          }
        }

        if (!parentWorkforce) {
          // Legacy meeting-action-only runs have no parent WorkforceTask to attach a delegation
          // row to. Keep their existing non-idempotent behavior.
        } else {
          const invocation = toolInvocationId
            ? await tx.toolInvocation.findUnique({
                where: {
                  spaceId_invocationId: { spaceId: input.spaceId, invocationId: toolInvocationId },
                },
                select: { runId: true, spaceId: true, status: true },
              })
            : null;
          if (
            toolInvocationId &&
            (!invocation ||
              invocation.runId !== input.parentRunId ||
              invocation.spaceId !== input.spaceId)
          ) {
            throw new Error("The delegation invocation does not belong to this parent Run.");
          }
          if (invocation && (invocation.status === "UNCERTAIN" || invocation.status === "FAILED")) {
            throw new Error(
              "The delegation invocation is uncertain; no new child task may be created.",
            );
          }
          if (invocation && invocation.status !== "RECEIVED" && invocation.status !== "EXECUTING") {
            throw new Error("The delegation invocation is already complete.");
          }
        }

        const depth = parentWorkforce ? parentWorkforce.delegationDepth + 1 : 1;
        if (depth > MAX_DELEGATION_DEPTH) throw new Error("Delegation depth limit reached.");
        const parentTaskId = parentWorkforce?.id ?? null;
        const parentMeetingActionId = parentAction?.id ?? null;
        const children = await tx.workforceTask.count({
          where: {
            OR: [
              ...(parentTaskId ? [{ parentTaskId }] : []),
              ...(parentMeetingActionId ? [{ parentMeetingActionId }] : []),
            ],
          },
        });
        if (children >= MAX_CHILDREN) {
          throw new Error("The parent task has reached its delegation limit.");
        }
        let cursor = parentWorkforce;
        const seenBots = new Set<string>();
        while (cursor) {
          if (cursor.assigneeBotId) {
            if (seenBots.has(cursor.assigneeBotId)) throw new Error("Delegation cycle detected.");
            seenBots.add(cursor.assigneeBotId);
          }
          cursor = cursor.parentTaskId
            ? await tx.workforceTask.findUnique({ where: { id: cursor.parentTaskId } })
            : null;
        }
        if (seenBots.has(input.assigneeBotId)) throw new Error("Delegation cycle detected.");

        const child = await tx.workforceTask.create({
          data: {
            spaceId: input.spaceId,
            source: "BOT_DELEGATED",
            title: input.title,
            description: input.description,
            acceptanceCriteria: input.acceptanceCriteria,
            priority: input.priority,
            assigneeBotId: target.id,
            createdByUserId: input.userId,
            parentTaskId,
            parentMeetingActionId,
            parentRunId: input.parentRunId,
            delegatorBotId: input.delegatorBotId,
            delegationDepth: depth,
            status: "OPEN",
          },
        });
        const started = await startWorkforceExecutionInTransaction(tx, {
          task: {
            id: child.id,
            spaceId: child.spaceId,
            executionAttempt: child.executionAttempt,
            status: child.status,
            assigneeBotId: child.assigneeBotId,
          },
          bot: { id: target.id, threadId: target.thread.id },
          userId: input.userId,
          prompt: workforceTaskPrompt(child),
          runTrigger: "workforce_task",
        });

        if (parentWorkforce) {
          const deadlineAt = new Date(Date.now() + DELEGATION_TIMEOUT_MS);
          await tx.workforceDelegation.create({
            data: {
              spaceId: input.spaceId,
              toolInvocationId,
              requestDigest,
              parentTaskId: parentWorkforce.id,
              parentRunId: input.parentRunId,
              childTaskId: child.id,
              childRunId: started.runId,
              delegatorBotId: input.delegatorBotId,
              assigneeBotId: target.id,
              status: "WAITING",
              deadlineAt,
            },
          });
          await tx.workforceTask.update({
            where: { id: parentWorkforce.id },
            data: {
              status: "WAITING_FOR_CHILDREN",
              waitingForChildren: true,
              waitingSince: new Date(),
              delegationDeadlineAt: deadlineAt,
            },
          });
        }
        return { kind: "created" as const, childTaskId: child.id, runId: started.runId };
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (!toolInvocationId || !isUniqueViolation(error)) throw error;
    const raced = await deps.prisma.workforceDelegation.findUnique({
      where: { toolInvocationId },
      select: {
        spaceId: true,
        parentRunId: true,
        parentTaskId: true,
        childTaskId: true,
        requestDigest: true,
      },
    });
    if (!raced) throw error;
    if (
      raced.spaceId !== input.spaceId ||
      raced.parentRunId !== input.parentRunId ||
      raced.requestDigest !== requestDigest
    ) {
      throw new Error(
        "This delegation invocation was already used with different business arguments.",
      );
    }
    outcome = { kind: "existing", childTaskId: raced.childTaskId };
  }

  if (outcome.kind === "created") {
    // The child Worker only starts after the business transaction has committed.
    if (outcome.runId) {
      await deps.jobs.enqueue(runContinueJob(outcome.runId)).catch((error) => {
        getLogger().error("workforce delegation run enqueue failed", error);
      });
    }
    await deps.jobs.enqueue(workforceTaskReconcileJob(outcome.childTaskId)).catch((error) => {
      getLogger().error("workforce delegation reconcile enqueue failed", error);
    });
  }
  return loadView(deps.prisma, outcome.childTaskId);
}

/** Resolve the original delegated child from a committed delegation, without creating anything. */
export async function recoverDelegatedTaskForInvocation(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    invocationId: string;
    args: Record<string, unknown>;
  },
): Promise<WorkforceTaskView | null> {
  const delegation = await prisma.workforceDelegation.findUnique({
    where: { toolInvocationId: input.invocationId },
    select: { spaceId: true, childTaskId: true, requestDigest: true },
  });
  if (!delegation || delegation.spaceId !== input.spaceId) return null;
  const digest = delegationRequestDigest({
    assigneeBotId: String(input.args.assigneeBotId ?? ""),
    title: String(input.args.title ?? ""),
    description: String(input.args.description ?? ""),
    acceptanceCriteria: String(input.args.acceptanceCriteria ?? ""),
    priority: input.args.priority ? String(input.args.priority) : "NORMAL",
  });
  if (delegation.requestDigest !== digest) {
    throw new Error(
      "This delegation invocation was already used with different business arguments.",
    );
  }
  return loadView(prisma, delegation.childTaskId);
}

export async function getWorkforceTaskView(
  prisma: PrismaClient,
  spaceId: string,
  taskId: string,
): Promise<WorkforceTaskView | null> {
  const task = await findTask(prisma, taskId);
  if (!task || task.spaceId !== spaceId) return null;
  return loadView(prisma, task.id);
}

async function settleWaitingParentRun(
  deps: WorkforceDeps,
  task: { id: string; botRunId: string | null; executionAttempt: number; status: string },
): Promise<void> {
  if (!task.botRunId) return;
  const run = await deps.prisma.run.findUnique({
    where: { id: task.botRunId },
    select: { id: true, status: true, error: true, completedAt: true },
  });
  if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return;
  const outcome = await readRunOutcome(deps.prisma, run.id);
  const parsed = actionResult(outcome.text);
  const failed =
    run.status !== "completed" ||
    parsed.resultStatus === "FAILED" ||
    parsed.resultStatus === "BLOCKED";
  await deps.prisma.workforceTaskAttempt.updateMany({
    where: { taskId: task.id, attemptNumber: task.executionAttempt, botRunId: run.id },
    data: {
      status: run.status === "completed" ? (failed ? "FAILED" : "COMPLETED") : "FAILED",
      resultStatus: failed
        ? parsed.resultStatus === "BLOCKED"
          ? "BLOCKED"
          : "FAILED"
        : parsed.resultStatus,
      resultSummary: parsed.summary,
      evidence: parsed.evidence,
      error: failed ? (run.error ?? parsed.summary) : null,
      completedAt: run.completedAt ?? new Date(),
    },
  });
  await updateUnifiedAttempt(deps.prisma, "WORKFORCE_TASK", task.id, task.executionAttempt, {
    status: run.status === "completed" ? (failed ? "FAILED" : "COMPLETED") : "FAILED",
    resultStatus: failed
      ? parsed.resultStatus === "BLOCKED"
        ? "BLOCKED"
        : "FAILED"
      : parsed.resultStatus,
    resultSummary: parsed.summary,
    evidence: parsed.evidence,
    error: failed ? (run.error ?? parsed.summary) : null,
    completedAt: run.completedAt ?? new Date(),
  });
}

export async function reconcileExpiredDelegations(
  deps: WorkforceDeps,
  now = new Date(),
): Promise<void> {
  const expired = await deps.prisma.workforceDelegation.findMany({
    where: { status: "WAITING", deadlineAt: { lte: now } },
    take: 100,
    select: { id: true, parentTaskId: true, deadlineAt: true },
  });
  const parents = new Set<string>();
  for (const delegation of expired) {
    const reason = `The delegated task did not finish by ${
      delegation.deadlineAt?.toISOString() ?? now.toISOString()
    }.`;
    const updated = await deps.prisma.workforceDelegation.updateMany({
      where: { id: delegation.id, status: "WAITING" },
      data: {
        status: "TIMED_OUT",
        resultStatus: "TIMED_OUT",
        error: reason,
        timedOutAt: now,
        deliveredAt: now,
        completedAt: now,
      },
    });
    if (updated.count === 1) parents.add(delegation.parentTaskId);
  }
  for (const parentTaskId of parents) {
    await continueParentIfReady(deps, parentTaskId, now).catch((error) =>
      getLogger().error("workforce delegation timeout continuation", error),
    );
  }
}

export async function deliverChildDelegation(
  deps: WorkforceDeps,
  childTaskId: string,
): Promise<void> {
  const child = await deps.prisma.workforceTask.findUnique({
    where: { id: childTaskId },
    select: {
      id: true,
      status: true,
      resultStatus: true,
      resultSummary: true,
      evidence: true,
      blockedReason: true,
      completedAt: true,
    },
  });
  if (
    !child ||
    !(
      child.status === "COMPLETED" ||
      child.status === "BLOCKED" ||
      (child.status === "IN_PROGRESS" &&
        (child.resultStatus === "SUCCESS" ||
          child.resultStatus === "PARTIAL" ||
          child.resultStatus === "FAILED" ||
          child.resultStatus === "BLOCKED"))
    )
  ) {
    return;
  }
  const delegation = await deps.prisma.workforceDelegation.findFirst({
    where: { childTaskId: child.id },
    select: { id: true, parentTaskId: true, status: true },
  });
  if (!delegation) return;
  if (delegation.status === "TIMED_OUT") {
    await deps.prisma.workforceDelegation.update({
      where: { id: delegation.id },
      data: {
        lateResultStatus: child.resultStatus ?? child.status,
        lateResultSummary: child.resultSummary,
        lateResultAt: new Date(),
      },
    });
    return;
  }
  const status =
    child.resultStatus === "SUCCESS" || child.resultStatus === "PARTIAL"
      ? "COMPLETED"
      : child.resultStatus === "FAILED"
        ? "FAILED"
        : child.status === "BLOCKED"
          ? "BLOCKED"
          : "COMPLETED";
  await deps.prisma.workforceDelegation.update({
    where: { id: delegation.id },
    data: {
      status,
      resultStatus: child.resultStatus,
      resultSummary: child.resultSummary,
      evidence: arrayValue(child.evidence),
      error: child.blockedReason,
      completedAt: child.completedAt ?? new Date(),
      deliveredAt: new Date(),
    },
  });
  await continueParentIfReady(deps, delegation.parentTaskId);
}

async function continueParentIfReady(
  deps: WorkforceDeps,
  parentTaskId: string,
  now = new Date(),
): Promise<void> {
  const parent = await deps.prisma.workforceTask.findUnique({
    where: { id: parentTaskId },
    include: {
      assigneeBot: { select: { id: true, thread: { select: { id: true } } } },
      delegations: { orderBy: { createdAt: "asc" } },
    },
  });
  if (
    !parent?.waitingForChildren ||
    parent.status !== "WAITING_FOR_CHILDREN" ||
    parent.acceptanceStatus === "CANCELLED" ||
    parent.acceptanceStatus === "REJECTED"
  ) {
    return;
  }
  for (const delegation of parent.delegations) {
    if (delegation.status !== "WAITING") continue;
    if (delegation.deadlineAt && delegation.deadlineAt <= now) {
      await deps.prisma.workforceDelegation.update({
        where: { id: delegation.id },
        data: {
          status: "TIMED_OUT",
          resultStatus: "TIMED_OUT",
          error: `The delegated task did not finish by ${delegation.deadlineAt.toISOString()}.`,
          completedAt: now,
          deliveredAt: now,
          timedOutAt: now,
        },
      });
      continue;
    }
    return;
  }
  if (parent.continuationRunId) return;
  if (!parent.botRunId) return;
  const parentRun = await deps.prisma.run.findUnique({
    where: { id: parent.botRunId },
    select: { id: true, status: true, taskId: true, userId: true, spaceId: true },
  });
  if (!parentRun) return;
  if (!TERMINAL_RUN_STATUSES.has(parentRun.status)) {
    // A parent Run that is still active while all children are terminal cannot resume on its
    // own. End the stale run before creating the single deterministic continuation.
    if (!ACTIVE_RUN_STATUSES.includes(parentRun.status as never)) return;
    await deps.prisma.$transaction(async (tx) => {
      await cancelRunsInTransaction(tx, [parentRun], now);
      await tx.workforceTaskAttempt.updateMany({
        where: {
          taskId: parent.id,
          botRunId: parentRun.id,
          status: "RUNNING",
        },
        data: {
          status: "FAILED",
          error: "Parent run cancelled after the delegation deadline.",
          completedAt: now,
        },
      });
    });
  }
  const bot = parent.assigneeBot;
  if (!bot?.thread) {
    getLogger().error("workforce delegation continuation missing bot thread", {
      "workforce.task.id": parent.id,
    });
    return;
  }
  const threadId = bot.thread.id;
  const childTasks = await deps.prisma.workforceTask.findMany({
    where: { id: { in: parent.delegations.map((row) => row.childTaskId) } },
    select: { id: true, title: true, assigneeBotId: true, status: true, resultStatus: true },
  });
  const childById = new Map(childTasks.map((child) => [child.id, child]));
  const lines = parent.delegations.map((delegation) => {
    const child = childById.get(delegation.childTaskId);
    const evidence = arrayValue(delegation.evidence);
    return `- [${delegation.status}] ${child?.title ?? delegation.childTaskId} (task ${delegation.childTaskId}): result=${delegation.resultStatus ?? "none"}; summary=${delegation.resultSummary ?? "none"}; error=${delegation.error ?? "none"}; evidence=${evidence.join("; ") || "none"}`;
  });
  const prompt = `You are resuming your original task after durable delegated subtasks settled. Continue as the parent Bot; do not treat a failed or blocked child as success.

Original task: ${parent.title}
Acceptance criteria: ${parent.acceptanceCriteria}
Delegated child results:
${lines.join("\n")}

Use these real child results to finish the parent task. State any unresolved failure or missing evidence plainly. Do not send email, contact a counterparty, purchase, spend, sign, or perform an irreversible action.
Return ONE JSON object:
{"resultStatus":"SUCCESS"|"PARTIAL"|"FAILED"|"BLOCKED","summary":"final parent result and how child results were used","evidence":["URLs, file paths or concrete verification references"],"acceptanceCriteriaCheck":"how the criterion was met or not met"}`;
  const clientNonce = `workforce-continuation:${parent.id}`;
  const attemptNumber = parent.executionAttempt + 1;
  const continuation = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workforce_tasks WHERE id = ${parent.id} FOR UPDATE`;
    const current = await tx.workforceTask.findUnique({
      where: { id: parent.id },
      select: {
        status: true,
        waitingForChildren: true,
        continuationRunId: true,
        botRunId: true,
        executionAttempt: true,
      },
    });
    if (
      current?.status !== "WAITING_FOR_CHILDREN" ||
      !current.waitingForChildren ||
      current.continuationRunId
    ) {
      return null;
    }
    const existing = await tx.run.findUnique({
      where: { spaceId_clientNonce: { spaceId: parent.spaceId, clientNonce } },
      select: { id: true, taskId: true },
    });
    if (existing) return { runId: existing.id, taskId: existing.taskId };
    const taskRow = await tx.task.create({
      data: {
        spaceId: parent.spaceId,
        botId: bot.id,
        threadId,
        userId: parent.createdByUserId,
        prompt,
        status: "queued",
      },
      select: { id: true },
    });
    const run = await tx.run.create({
      data: {
        spaceId: parent.spaceId,
        botId: bot.id,
        threadId,
        taskId: taskRow.id,
        userId: parent.createdByUserId,
        status: "queued",
        trigger: "delegation_continuation",
        clientNonce,
        parentRunId: current.botRunId,
        continuationOfRunId: current.botRunId,
        maxOutputTokens: 3_000,
      },
      select: { id: true },
    });
    const legacyAttempt = await tx.workforceTaskAttempt.create({
      data: {
        spaceId: parent.spaceId,
        taskId: parent.id,
        attemptNumber,
        taskRunId: taskRow.id,
        botRunId: run.id,
        status: "RUNNING",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await tx.executionAttempt.create({
      data: {
        id: `ux-workforce:${legacyAttempt.id}`,
        spaceId: parent.spaceId,
        sourceType: "WORKFORCE_TASK",
        sourceId: parent.id,
        workforceTaskId: parent.id,
        taskId: taskRow.id,
        runId: run.id,
        parentRunId: current.botRunId,
        continuationOfRunId: current.botRunId,
        attemptNumber,
        status: "RUNNING",
        startedAt: new Date(),
      },
    });
    await tx.workforceTask.update({
      where: { id: parent.id },
      data: {
        status: "IN_PROGRESS",
        waitingForChildren: false,
        waitingSince: null,
        continuationRunId: run.id,
        continuationOfRunId: current.botRunId,
        taskId: taskRow.id,
        botRunId: run.id,
        executionAttempt: attemptNumber,
        startedAt: new Date(),
        completedAt: null,
        resultStatus: null,
        resultSummary: null,
        evidence: [],
        blockedReason: null,
        acceptanceStatus: null,
      },
    });
    let meetingActionItemId: string | null = null;
    if (parent.parentMeetingActionId) {
      const action = await tx.meetingActionItem.findUnique({
        where: { id: parent.parentMeetingActionId },
        select: { id: true, meetingId: true, executionAttempt: true },
      });
      if (action) {
        meetingActionItemId = action.id;
        const nextActionAttempt = Math.max(action.executionAttempt + 1, attemptNumber);
        await tx.meetingActionItem.update({
          where: { id: action.id },
          data: {
            status: "IN_PROGRESS",
            executionAttempt: nextActionAttempt,
            taskId: taskRow.id,
            botRunId: run.id,
            startedAt: new Date(),
            completedAt: null,
            resultStatus: null,
            resultSummary: null,
            evidence: [],
            blockedReason: null,
            acceptanceStatus: null,
          },
        });
        // Keep the first attempt and its original Run as history; the continuation gets its
        // own attempt row instead of overwriting the original execution identity.
        await tx.meetingActionAttempt.updateMany({
          where: {
            actionItemId: action.id,
            attemptNumber: action.executionAttempt,
            status: "RUNNING",
          },
          data: {
            status: "CANCELLED",
            error: "Superseded by the parent continuation.",
            completedAt: new Date(),
          },
        });
        if (action.executionAttempt > 0) {
          await tx.executionAttempt.updateMany({
            where: {
              meetingActionId: action.id,
              attemptNumber: action.executionAttempt,
              status: "RUNNING",
            },
            data: {
              status: "CANCELLED",
              error: "Superseded by the parent continuation.",
              completedAt: new Date(),
            },
          });
        }
        await tx.meetingActionAttempt.create({
          data: {
            meetingId: action.meetingId,
            actionItemId: action.id,
            attemptNumber: nextActionAttempt,
            taskId: taskRow.id,
            botRunId: run.id,
            status: "RUNNING",
            startedAt: new Date(),
          },
        });
      }
    }
    return { runId: run.id, taskId: taskRow.id, meetingActionItemId };
  });
  if (!continuation) return;
  await deps.jobs.enqueue(runContinueJob(continuation.runId)).catch((error) => {
    getLogger().error("workforce delegation continuation enqueue", error);
  });
  await deps.jobs.enqueue(workforceTaskReconcileJob(parent.id)).catch((error) => {
    getLogger().error("workforce delegation continuation reconcile enqueue", error);
  });
  if (continuation.meetingActionItemId) {
    await deps.jobs
      .enqueue(meetingActionReconcileJob(continuation.meetingActionItemId))
      .catch((error) => {
        getLogger().error("workforce delegation continuation action reconcile enqueue", error);
      });
  }
}

/** Periodic recovery for generic task runs whose terminal hook was lost. */
export async function reconcileActiveWorkforceTasks(
  deps: WorkforceDeps,
  options: { staleAfterMs?: number; take?: number; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const take = Math.min(Math.max(options.take ?? 100, 1), 500);
  const waitingDeliveries = await deps.prisma.workforceDelegation.findMany({
    where: { status: "WAITING" },
    orderBy: { createdAt: "asc" },
    take,
    select: { childTaskId: true },
  });
  for (const delivery of waitingDeliveries) {
    await deliverChildDelegation(deps, delivery.childTaskId).catch((error) =>
      getLogger().error("workforce delegation delivery recovery", error),
    );
  }
  await reconcileExpiredDelegations(deps, now);
  const rows = await deps.prisma.workforceTask.findMany({
    where: {
      OR: [
        {
          status: "IN_PROGRESS",
          resultStatus: null,
          botRunId: { not: null },
          startedAt: { lt: new Date(now.getTime() - staleAfterMs) },
        },
        { status: "WAITING_FOR_CHILDREN", waitingForChildren: true },
        { status: "IN_PROGRESS", resultStatus: { not: null }, botRunId: { not: null } },
      ],
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true },
  });
  for (const row of rows) {
    await deps.jobs
      .enqueue(workforceTaskReconcileJob(row.id))
      .catch((error) => getLogger().error("workforce task recovery enqueue", error));
  }
}
