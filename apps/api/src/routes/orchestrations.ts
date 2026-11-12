import { readRunOutcome } from "@rakazo/adapters";
import type {
  OrchestrationChildStatus,
  OrchestrationChildView,
  OrchestrationOutcome,
  OrchestrationStatus,
  OrchestrationView,
} from "@rakazo/contracts";
import type { Run } from "@rakazo/db";
import type { RouterContext } from "./context.js";

const ORCHESTRATIONS_PER_BOT = 5;

/**
 * The parent chat's recent delegations, with each child's live run state. The stored statuses are
 * reconciled by the worker, but a report that just finished should not wait for the next pass:
 * the join run and its last message are read here as well.
 */
export function orchestrationsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  return {
    orchestrations: {
      list: authed.orchestrations.list.handler(async ({ context, input }) => {
        const spaceId = context.actor.spaceId;
        const rows = await deps.prisma.orchestration.findMany({
          where: { spaceId, parentBotId: input.botId },
          orderBy: { createdAt: "desc" },
          take: ORCHESTRATIONS_PER_BOT,
          include: { children: { orderBy: { createdAt: "asc" } } },
        });
        if (rows.length === 0) return { orchestrations: [] };

        const botIds = [
          ...new Set(rows.flatMap((row) => row.children.map((child) => child.botId))),
        ];
        const runIds = [
          ...new Set(
            rows.flatMap((row) =>
              [row.joinRunId, ...row.children.map((child) => child.runId)].filter(
                (id): id is string => Boolean(id),
              ),
            ),
          ),
        ];
        const [bots, runs] = await Promise.all([
          deps.prisma.bot.findMany({
            where: { id: { in: botIds }, spaceId },
            select: { id: true, name: true },
          }),
          deps.prisma.run.findMany({
            where: { id: { in: runIds }, spaceId },
            select: {
              id: true,
              status: true,
              error: true,
              completedAt: true,
            },
          }),
        ]);
        const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
        const runsById = new Map(runs.map((run) => [run.id, run]));

        const views = await Promise.all(
          rows.map(async (row): Promise<OrchestrationView> => {
            const joinRun = row.joinRunId ? runsById.get(row.joinRunId) : undefined;
            const children = row.children.map((child): OrchestrationChildView => {
              const run = child.runId ? runsById.get(child.runId) : undefined;
              const status = childStatus(child.status, run, row.deadlineAt);
              return {
                id: child.id,
                role: child.role,
                botId: child.botId,
                botName: botNames.get(child.botId) ?? child.botId,
                status,
                error: child.error ?? run?.error ?? null,
                runId: child.runId,
                threadId: child.threadId,
                completedAt:
                  child.completedAt?.toISOString() ?? run?.completedAt?.toISOString() ?? null,
              };
            });
            const allSettled = children.every((child) => isSettled(child.status));
            const completed = children.filter((child) => child.status === "completed").length;
            const status = overallStatus(row.status, joinRun, allSettled);
            const outcome: OrchestrationOutcome | null =
              status === "completed"
                ? completed === children.length
                  ? "success"
                  : completed > 0
                    ? "partial"
                    : "failed"
                : status === "failed"
                  ? "failed"
                  : null;
            const report =
              joinRun?.status === "completed"
                ? await readRunOutcome(deps.prisma, joinRun.id)
                : null;
            return {
              id: row.id,
              goal: row.goal,
              status,
              outcome,
              parentBotId: row.parentBotId,
              createdAt: row.createdAt.toISOString(),
              deadlineAt: row.deadlineAt.toISOString(),
              completedAt:
                joinRun?.completedAt?.toISOString() ?? row.completedAt?.toISOString() ?? null,
              reportMessageId: report?.messageId ?? null,
              children,
            };
          }),
        );
        return { orchestrations: views };
      }),
    },
  };
}

function isSettled(status: OrchestrationChildStatus): boolean {
  return status === "completed" || status === "failed" || status === "timed_out";
}

function childStatus(
  stored: string,
  run: Pick<Run, "status"> | undefined,
  deadlineAt: Date,
): OrchestrationChildStatus {
  if (stored === "timed_out") return "timed_out";
  if (run) {
    if (run.status === "completed") return "completed";
    if (run.status === "failed" || run.status === "cancelled") return "failed";
    if (Date.now() >= deadlineAt.getTime()) return "timed_out";
    return "running";
  }
  if (stored === "completed" || stored === "failed") return stored;
  if (Date.now() >= deadlineAt.getTime()) return "timed_out";
  return stored === "running" ? "running" : "pending";
}

function overallStatus(
  stored: string,
  joinRun: Pick<Run, "status"> | undefined,
  allSettled: boolean,
): OrchestrationStatus {
  if (joinRun?.status === "completed") return "completed";
  if (joinRun && (joinRun.status === "failed" || joinRun.status === "cancelled")) return "failed";
  if (joinRun) return "joining";
  if (stored === "completed" || stored === "failed") return stored;
  if (stored === "joining" || allSettled) return "joining";
  return "running";
}
