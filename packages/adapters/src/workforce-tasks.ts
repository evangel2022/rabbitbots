import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob, workforceTaskReconcileJob } from "@rakazo/adapter-kit";
import type {
  MeetingActionAcceptanceAction,
  MeetingActionAcceptanceView,
  MeetingActionAttemptView,
  WorkforceTaskSource,
  WorkforceTaskView,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
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
    latestResultStatus: (task.resultStatus as WorkforceTaskView["latestResultStatus"]) ?? null,
    latestResultSummary: task.resultSummary,
    acceptanceStatus: task.acceptanceStatus,
    blockedReason: task.blockedReason,
    priority: task.priority as WorkforceTaskView["priority"],
    dueAt: task.dueAt?.toISOString() ?? null,
    parentTaskId: task.parentTaskId,
    parentMeetingActionId: task.parentMeetingActionId,
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
      delegationDepth: 0,
      status: "OPEN",
    },
  });
  return loadView(prisma, task.id);
}

function actionResult(text: string): { resultStatus: string; summary: string; evidence: string[] } {
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

/**
 * Execute a generic Workforce task through the existing Task/Run runtime. CEO Direct tasks are
 * authorized by the authenticated creator; delegated tasks are authorized by their parent task.
 */
export async function executeWorkforceTask(
  deps: WorkforceDeps,
  input: { spaceId: string; userId: string; taskId: string; clientNonce: string },
): Promise<WorkforceTaskView> {
  const task = await findTask(deps.prisma, input.taskId);
  if (!task || task.spaceId !== input.spaceId) throw new Error("Task not found in this Space.");
  if (task.status === "COMPLETED" || task.status === "BLOCKED") {
    throw new Error("This task is already complete or blocked.");
  }
  if (task.taskId && task.botRunId) return loadView(deps.prisma, task.id);
  if (!task.assigneeBotId) throw new Error("The task has no Bot assignee.");
  const bot = await deps.prisma.bot.findFirst({
    where: { id: task.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new Error("The assigned Bot has no execution thread.");
  const threadId = bot.thread.id;
  const attempt = task.executionAttempt + 1;
  const clientNonce = `workforce-task:${task.id}:${attempt}`;
  const prompt = `You are acting as an AI employee executing a ${task.source.replaceAll("_", " ").toLowerCase()} task.

Task: ${task.title}
Description: ${task.description || "(none)"}
Acceptance criteria: ${task.acceptanceCriteria}
Priority: ${task.priority}
${task.parentRunId ? `This task was delegated by another Bot Run (${task.parentRunId}). Its result will be handed back to the delegating bot.` : ""}

If the task specifically needs another Bot role, use delegate_task to create one bounded child task (never yourself, never a cycle, at most three levels), then use delegated_task_status to read its result. Do not claim the child succeeded unless its returned status is SUCCESS or PARTIAL.

Work safely and stay within your role. If this task can be completed from the available task context, do so without external tools. Do not send email, contact a company, purchase, spend, sign, or perform an irreversible action.
When finished, return ONE JSON object:
{"resultStatus":"SUCCESS"|"PARTIAL"|"FAILED"|"BLOCKED","summary":"what you did and what remains","evidence":["URLs, file paths or concrete verification references"],"acceptanceCriteriaCheck":"how the criterion was met or not met"}`;
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
        trigger: "workforce_task",
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
  await deps.jobs.enqueue(runContinueJob(runId)).catch((error) => {
    getLogger().error("workforce task run enqueue failed", error);
  });
  await deps.jobs.enqueue(workforceTaskReconcileJob(task.id)).catch((error) => {
    getLogger().error("workforce task reconcile enqueue failed", error);
  });
  return loadView(deps.prisma, task.id);
}

export async function reconcileWorkforceTask(deps: WorkforceDeps, taskId: string): Promise<void> {
  const task = await deps.prisma.workforceTask.findUnique({ where: { id: taskId } });
  if (!task) return;
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
  await deps.prisma.workforceTask.update({
    where: { id: task.id },
    data: {
      status: task.waitingForChildren ? "WAITING_FOR_CHILDREN" : failed ? "BLOCKED" : "IN_PROGRESS",
      resultStatus: parsed.resultStatus,
      resultSummary: parsed.summary,
      evidence: parsed.evidence,
      blockedReason: failed ? parsed.summary : null,
      completedAt: null,
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
    (task.status !== "IN_PROGRESS" ||
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

/** Create a child from a real parent Bot Run and start it. Used by the delegation tool. */
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
  },
): Promise<WorkforceTaskView> {
  if (input.assigneeBotId === input.delegatorBotId)
    throw new Error("A Bot cannot delegate to itself.");
  const parentRun = await deps.prisma.run.findUnique({
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
  const target = await deps.prisma.bot.findFirst({
    where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true },
  });
  if (!target) throw new Error("The delegated Bot is not available in this Space.");
  const parentWorkforce = await deps.prisma.workforceTask.findFirst({
    where: { botRunId: input.parentRunId, spaceId: input.spaceId },
  });
  const parentAction = parentWorkforce
    ? null
    : await deps.prisma.meetingActionItem.findFirst({
        where: { botRunId: input.parentRunId, meeting: { spaceId: input.spaceId } },
        select: { id: true, assigneeBotId: true },
      });
  if (!parentWorkforce && !parentAction)
    throw new Error("The delegation was not started by a real task run.");
  const depth = parentWorkforce ? parentWorkforce.delegationDepth + 1 : 1;
  if (depth > MAX_DELEGATION_DEPTH) throw new Error("Delegation depth limit reached.");
  const parentTaskId = parentWorkforce?.id ?? null;
  const parentMeetingActionId = parentAction?.id ?? null;
  const children = await deps.prisma.workforceTask.count({
    where: {
      OR: [
        ...(parentTaskId ? [{ parentTaskId }] : []),
        ...(parentMeetingActionId ? [{ parentMeetingActionId }] : []),
      ],
    },
  });
  if (children >= MAX_CHILDREN)
    throw new Error("The parent task has reached its delegation limit.");
  let cursor = parentWorkforce;
  const seenBots = new Set<string>();
  while (cursor) {
    if (cursor.assigneeBotId) {
      if (seenBots.has(cursor.assigneeBotId)) throw new Error("Delegation cycle detected.");
      seenBots.add(cursor.assigneeBotId);
    }
    cursor = cursor.parentTaskId
      ? await deps.prisma.workforceTask.findUnique({ where: { id: cursor.parentTaskId } })
      : null;
  }
  if (input.assigneeBotId === input.delegatorBotId || seenBots.has(input.assigneeBotId)) {
    throw new Error("Delegation cycle detected.");
  }
  const child = await deps.prisma.workforceTask.create({
    data: {
      spaceId: input.spaceId,
      source: "BOT_DELEGATED",
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      priority: input.priority,
      assigneeBotId: target.id,
      createdByUserId: input.userId,
      parentTaskId: parentTaskId,
      parentMeetingActionId: parentMeetingActionId,
      parentRunId: input.parentRunId,
      delegatorBotId: input.delegatorBotId,
      delegationDepth: depth,
      status: "OPEN",
    },
  });
  const running = await executeWorkforceTask(deps, {
    spaceId: input.spaceId,
    userId: input.userId,
    taskId: child.id,
    clientNonce: `delegation:${child.id}`,
  });
  if (parentWorkforce) {
    const deadlineAt = new Date(Date.now() + DELEGATION_TIMEOUT_MS);
    await deps.prisma.$transaction(async (tx) => {
      await tx.workforceDelegation.create({
        data: {
          spaceId: input.spaceId,
          parentTaskId: parentWorkforce.id,
          parentRunId: input.parentRunId,
          childTaskId: child.id,
          childRunId: running.attempts[0]?.botRunId ?? null,
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
    });
  }
  return running;
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
    select: { status: true },
  });
  if (!parentRun || !TERMINAL_RUN_STATUSES.has(parentRun.status)) return;
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
    return { runId: run.id, taskId: taskRow.id };
  });
  if (!continuation) return;
  await deps.jobs.enqueue(runContinueJob(continuation.runId)).catch((error) => {
    getLogger().error("workforce delegation continuation enqueue", error);
  });
  await deps.jobs.enqueue(workforceTaskReconcileJob(parent.id)).catch((error) => {
    getLogger().error("workforce delegation continuation reconcile enqueue", error);
  });
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
