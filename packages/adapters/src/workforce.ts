import type {
  WorkforceBotView,
  WorkforceOverview,
  WorkforceSummary,
  WorkforceTaskView,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { workforceTaskView } from "./workforce-tasks.js";

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

/** Real database aggregates for the Workforce Operations Center. */
export async function getWorkforceOverview(
  prisma: PrismaClient,
  spaceId: string,
  now = new Date(),
): Promise<WorkforceOverview> {
  const [bots, participants, actions, generic] = await Promise.all([
    prisma.bot.findMany({
      where: { spaceId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, description: true },
    }),
    prisma.meetingParticipant.findMany({
      where: { meeting: { spaceId } },
      orderBy: { createdAt: "desc" },
      select: { botId: true, role: true },
    }),
    prisma.meetingActionItem.findMany({
      where: { meeting: { spaceId } },
      orderBy: { createdAt: "desc" },
      include: {
        meeting: { select: { id: true, title: true } },
        decision: {
          select: {
            id: true,
            decisionType: true,
            approvalStatus: true,
            conditionsConfirmedAt: true,
          },
        },
        assigneeBot: { select: { name: true } },
        attempts: { orderBy: { attemptNumber: "asc" } },
        executionAttempts: { orderBy: { attemptNumber: "asc" } },
        acceptances: { orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.workforceTask.findMany({
      where: { spaceId },
      orderBy: { createdAt: "desc" },
      include: {
        assigneeBot: { select: { name: true } },
        attempts: { orderBy: { attemptNumber: "asc" } },
        executionAttempts: { orderBy: { attemptNumber: "asc" } },
        acceptances: { orderBy: { createdAt: "asc" } },
        delegations: { orderBy: { createdAt: "asc" } },
      },
    }),
  ]);
  const roleByBot = new Map<string, string>();
  for (const participant of participants) {
    if (!roleByBot.has(participant.botId)) roleByBot.set(participant.botId, participant.role);
  }
  const userIds = [
    ...new Set(
      [
        ...actions.map((action) => action.assigneeUserId),
        ...generic.map((task) => task.assigneeUserId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const userNames = new Map(users.map((user) => [user.id, user.name]));

  const meetingTasks: WorkforceTaskView[] = actions.map((action) => {
    const latestAttempt = action.executionAttempts.at(-1);
    return {
      id: action.id,
      source: "MEETING_DECISION" as const,
      title: action.title,
      description: action.description,
      acceptanceCriteria: action.acceptanceCriteria,
      assigneeBotId: action.assigneeBotId,
      assigneeBotName: action.assigneeBot?.name ?? null,
      assigneeUserId: action.assigneeUserId,
      assigneeUserName: action.assigneeUserId
        ? (userNames.get(action.assigneeUserId) ?? "Human owner")
        : null,
      meetingId: action.meeting.id,
      meetingTitle: action.meeting.title,
      decisionId: action.decision?.id ?? null,
      decisionType: (action.decision?.decisionType as WorkforceTaskView["decisionType"]) ?? null,
      approvalStatus:
        (action.decision?.approvalStatus as WorkforceTaskView["approvalStatus"]) ?? null,
      conditionsConfirmedAt: iso(action.decision?.conditionsConfirmedAt),
      executionStatus: action.status as WorkforceTaskView["executionStatus"],
      latestResultStatus:
        (latestAttempt?.resultStatus as WorkforceTaskView["latestResultStatus"]) ??
        (action.resultStatus as WorkforceTaskView["latestResultStatus"]),
      latestResultSummary: latestAttempt?.resultSummary ?? action.resultSummary,
      acceptanceStatus: action.acceptanceStatus,
      blockedReason: action.blockedReason,
      priority: "NORMAL" as const,
      dueAt: iso(action.dueAt),
      parentTaskId: null,
      parentMeetingActionId: null,
      parentRunId: null,
      delegatorBotId: null,
      delegationDepth: 0,
      waitingForChildren: false,
      waitingSince: null,
      continuationRunId: null,
      delegationDeadlineAt: null,
      delegations: [],
      createdAt: action.createdAt.toISOString(),
      startedAt: iso(action.startedAt),
      completedAt: iso(action.completedAt),
      attempts: action.executionAttempts.map((attempt) => ({
        id: attempt.id,
        actionItemId: action.id,
        attemptNumber: attempt.attemptNumber,
        taskId: attempt.taskId,
        botRunId: attempt.runId,
        status: attempt.status as "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED",
        resultStatus: attempt.resultStatus as WorkforceTaskView["latestResultStatus"],
        resultSummary: attempt.resultSummary,
        evidence: Array.isArray(attempt.evidence)
          ? attempt.evidence.filter((value): value is string => typeof value === "string")
          : [],
        error: attempt.error,
        startedAt: iso(attempt.startedAt),
        completedAt: iso(attempt.completedAt),
        createdAt: attempt.createdAt.toISOString(),
      })),
      acceptances: action.acceptances.map((acceptance) => ({
        id: acceptance.id,
        actionItemId: acceptance.actionItemId,
        action: acceptance.action as WorkforceTaskView["acceptances"][number]["action"],
        actorUserId: acceptance.actorUserId,
        actorName: acceptance.actorName,
        comment: acceptance.comment,
        createdAt: acceptance.createdAt.toISOString(),
      })),
    };
  });

  const genericTasks = generic.map((task) =>
    workforceTaskView(
      task,
      task.assigneeUserId ? (userNames.get(task.assigneeUserId) ?? "Human owner") : null,
    ),
  );
  const tasks: WorkforceTaskView[] = [...meetingTasks, ...genericTasks];
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const botViews: WorkforceBotView[] = bots.map((bot) => {
    const assigned = tasks.filter((task) => task.assigneeBotId === bot.id);
    const active = assigned.find((task) => task.executionStatus === "IN_PROGRESS");
    const waiting = assigned.find((task) => task.executionStatus === "WAITING_FOR_CHILDREN");
    const current =
      active ??
      waiting ??
      assigned.find((task) => task.executionStatus === "OPEN" && task.attempts.length === 0);
    const latestAttempts = assigned.flatMap((task) => task.attempts);
    const completedToday = assigned.filter(
      (task) =>
        task.executionStatus === "COMPLETED" &&
        task.completedAt !== null &&
        new Date(task.completedAt) >= startOfDay,
    ).length;
    const failedToday = latestAttempts.filter(
      (attempt) =>
        (attempt.resultStatus === "FAILED" || attempt.resultStatus === "BLOCKED") &&
        attempt.completedAt !== null &&
        new Date(attempt.completedAt) >= startOfDay,
    ).length;
    const latestExecution = latestAttempts
      .map((attempt) => attempt.startedAt ?? attempt.createdAt)
      .sort()
      .at(-1);
    const blocked = assigned.some((task) => task.executionStatus === "BLOCKED");
    return {
      id: bot.id,
      name: bot.name,
      role: roleByBot.get(bot.id) ?? "Executive Bot",
      status: active ? "WORKING" : waiting ? "WAITING" : blocked ? "BLOCKED" : "IDLE",
      currentTaskId: current?.id ?? null,
      currentTaskTitle: current?.title ?? null,
      completedToday,
      failedToday,
      lastExecutedAt: latestExecution ?? null,
    };
  });

  const summary: WorkforceSummary = {
    open: tasks.filter((task) => task.executionStatus === "OPEN").length,
    inProgress: tasks.filter((task) => task.executionStatus === "IN_PROGRESS").length,
    completed: tasks.filter((task) => task.executionStatus === "COMPLETED").length,
    blocked: tasks.filter((task) => task.executionStatus === "BLOCKED").length,
    failed: tasks.filter((task) => task.latestResultStatus === "FAILED").length,
    waiting: tasks.filter((task) => task.executionStatus === "WAITING_FOR_CHILDREN").length,
    pendingAcceptance: tasks.filter(
      (task) =>
        task.executionStatus === "IN_PROGRESS" &&
        (task.latestResultStatus === "SUCCESS" || task.latestResultStatus === "PARTIAL") &&
        !task.acceptanceStatus,
    ).length,
  };
  return { bots: botViews, tasks, summary };
}
