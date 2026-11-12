import type { RunTrigger } from "@rakazo/contracts";
import {
  ORCHESTRATION_DEFAULT_TIMEOUT_SECONDS,
  ORCHESTRATION_GOAL_MAX_LENGTH,
  ORCHESTRATION_MAX_CHILDREN,
  ORCHESTRATION_MAX_TIMEOUT_SECONDS,
  ORCHESTRATION_MIN_CHILDREN,
  ORCHESTRATION_TASK_MAX_LENGTH,
} from "@rakazo/contracts";
import { clampBotMessage, resolveBotAddress } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { loadBotMessageContext, messageBot } from "./bot-messages.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { reconcileOrchestration } from "./orchestration.js";

const MIN_TIMEOUT_SECONDS = 60;

export type OrchestrationTaskInput = {
  botId?: string;
  botName?: string;
  task: string;
  role?: string;
};

export type StartOrchestrationResult =
  | {
      ok: true;
      orchestrationId: string;
      status: "running";
      children: Array<{
        id: string;
        role: string;
        botId: string;
        botName: string;
        status: string;
      }>;
      replayed?: true;
    }
  | { ok: false; error: string };

type ParentRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  sourceMessageId?: string | null;
  trigger: RunTrigger;
};

/**
 * Create a tracked orchestration and dispatch one async bot message per child. The child runs
 * execute independently; the join run is created only after every child settles.
 */
export async function startOrchestration(
  deps: Pick<ExecutorDeps, "prisma" | "events" | "jobs" | "runLease">,
  parent: { id: string; name: string },
  run: ParentRun,
  input: {
    goal: string;
    tasks: OrchestrationTaskInput[];
    timeoutSeconds?: number;
    clientNonce?: string;
  },
): Promise<StartOrchestrationResult> {
  const goal = input.goal.trim();
  if (!goal) return { ok: false, error: "goal is required" };
  if (goal.length > ORCHESTRATION_GOAL_MAX_LENGTH)
    return { ok: false, error: `goal exceeds ${ORCHESTRATION_GOAL_MAX_LENGTH} characters` };
  if (
    input.tasks.length < ORCHESTRATION_MIN_CHILDREN ||
    input.tasks.length > ORCHESTRATION_MAX_CHILDREN
  )
    return {
      ok: false,
      error: `tasks must contain ${ORCHESTRATION_MIN_CHILDREN} to ${ORCHESTRATION_MAX_CHILDREN} items`,
    };

  const source = await loadBotMessageContext(deps.prisma, run.sourceMessageId);
  if (source?.orchestrationId)
    return { ok: false, error: "A delegated task cannot start another delegation." };

  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, archivedAt: null },
    select: { id: true, name: true, description: true },
  });
  const resolved: Array<{
    botId: string;
    botName: string;
    task: string;
    role: string;
  }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.tasks.entries()) {
    const task = String(raw.task ?? "").trim();
    if (!task) return { ok: false, error: `tasks[${index}].task is required` };
    if (task.length > ORCHESTRATION_TASK_MAX_LENGTH)
      return {
        ok: false,
        error: `tasks[${index}].task exceeds ${ORCHESTRATION_TASK_MAX_LENGTH} characters`,
      };
    const bot = resolveBotAddress(candidates, {
      botId: raw.botId,
      name: raw.botName,
    });
    if (!bot)
      return {
        ok: false,
        error: `tasks[${index}] does not name a bot in this space (use an exact bot name or id)`,
      };
    if (bot.id === parent.id)
      return { ok: false, error: "the parent bot cannot delegate to itself" };
    if (seen.has(bot.id)) return { ok: false, error: `${bot.name} is listed more than once` };
    seen.add(bot.id);
    const role = (raw.role?.trim() || bot.name).slice(0, 80);
    resolved.push({ botId: bot.id, botName: bot.name, task, role });
  }

  const timeoutSeconds = clampTimeout(input.timeoutSeconds);
  if (input.clientNonce) {
    const existing = await deps.prisma.orchestration.findUnique({
      where: { spaceId_clientNonce: { spaceId: run.spaceId, clientNonce: input.clientNonce } },
      include: { children: true },
    });
    if (existing) return orchestrationResult(deps.prisma, existing, true);
  }

  const now = new Date();
  let orchestration: { id: string };
  try {
    orchestration = await deps.prisma.orchestration.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        parentBotId: parent.id,
        parentThreadId: run.threadId,
        parentRunId: run.id,
        clientNonce: input.clientNonce,
        goal,
        status: "running",
        deadlineAt: new Date(now.getTime() + timeoutSeconds * 1_000),
        children: {
          create: resolved.map((child) => ({
            role: child.role,
            botId: child.botId,
            status: "pending",
          })),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    if (input.clientNonce && isUniqueViolation(error)) {
      const existing = await deps.prisma.orchestration.findUnique({
        where: { spaceId_clientNonce: { spaceId: run.spaceId, clientNonce: input.clientNonce } },
        include: { children: true },
      });
      if (existing) return orchestrationResult(deps.prisma, existing, true);
    }
    throw error;
  }

  const children = await deps.prisma.orchestrationChild.findMany({
    where: { orchestrationId: orchestration.id },
    orderBy: { createdAt: "asc" },
  });
  for (const child of children) {
    const target = resolved.find((item) => item.botId === child.botId)!;
    const message = clampBotMessage(delegationMessage(goal, target.task, parent.name));
    const sent = await messageBot(
      deps,
      run,
      { id: parent.id, name: parent.name },
      {
        bot_id: child.botId,
        message,
        intent: "request",
        deliveryKey: `orchestration:${orchestration.id}:${child.id}`,
        orchestrationId: orchestration.id,
        orchestrationChildId: child.id,
      },
    ).catch((error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : "Could not deliver the task.",
    }));
    if (!sent.ok) {
      await deps.prisma.orchestrationChild.updateMany({
        where: { id: child.id, status: "pending" },
        data: { status: "failed", error: sent.error, completedAt: new Date() },
      });
    }
  }

  // Both children can fail before any run starts; let the join run explain that.
  await reconcileOrchestration({ prisma: deps.prisma, jobs: deps.jobs }, orchestration.id).catch(
    () => undefined,
  );
  const current = await deps.prisma.orchestration.findUniqueOrThrow({
    where: { id: orchestration.id },
    include: { children: true },
  });
  return orchestrationResult(deps.prisma, current, false);
}

function clampTimeout(value: number | undefined): number {
  const raw = Number.isFinite(value) ? Number(value) : ORCHESTRATION_DEFAULT_TIMEOUT_SECONDS;
  return Math.min(
    ORCHESTRATION_MAX_TIMEOUT_SECONDS,
    Math.max(MIN_TIMEOUT_SECONDS, Math.round(raw)),
  );
}

function delegationMessage(goal: string, task: string, parentName: string): string {
  return [
    `Delegated by ${parentName} as one part of a larger request.`,
    "",
    `Overall goal: ${goal}`,
    "",
    `Your task: ${task}`,
    "",
    "Put the complete result in your final answer. It is collected automatically; do not message",
    "the requester and do not start another delegation. If you cannot finish, say what blocked you.",
  ].join("\n");
}

async function orchestrationResult(
  prisma: PrismaClient,
  orchestration: {
    id: string;
    children: Array<{
      id: string;
      role: string;
      botId: string;
      status: string;
    }>;
  },
  replayed: boolean,
): Promise<StartOrchestrationResult> {
  const bots = await prisma.bot.findMany({
    where: { id: { in: orchestration.children.map((child) => child.botId) } },
    select: { id: true, name: true },
  });
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  return {
    ok: true,
    orchestrationId: orchestration.id,
    status: "running",
    replayed: replayed || undefined,
    children: orchestration.children.map((child) => ({
      id: child.id,
      role: child.role,
      botId: child.botId,
      botName: names.get(child.botId) ?? child.botId,
      status: child.status,
    })),
  };
}
