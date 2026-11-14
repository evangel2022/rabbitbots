import { ORPCError } from "@orpc/server";
import {
  acceptWorkforceTask,
  assignWorkforceTask,
  createAiCompany,
  createDirectWorkforceTask,
  executeWorkforceTask,
  getAiCompanyStatus,
  getDemoStatus,
  getWorkforceOverview,
  launchAiCompanyDemo,
} from "@rakazo/adapters";
import type { RouterContext } from "./context.js";
import { botsRunOwnModels, modelSetup } from "./shared.js";

export function workforceRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  const demoWithModelReadiness = async (
    actor: Parameters<typeof modelSetup>[1],
    status: Awaited<ReturnType<typeof getDemoStatus>>,
  ) => {
    const setup = await modelSetup(deps, actor);
    const modelReady =
      !setup.needsModel ||
      (status.bots.length > 0 &&
        (await botsRunOwnModels(
          deps,
          actor,
          status.bots.map((bot) => bot.id),
        )));
    return { ...status, modelReady };
  };
  const badRequest = (error: unknown, fallback: string) =>
    new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : fallback,
    });
  return {
    workforce: {
      overview: authed.workforce.overview.handler(async ({ context }) => {
        try {
          return await getWorkforceOverview(deps.prisma, context.actor.spaceId);
        } catch (error) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: error instanceof Error ? error.message : "Could not load workforce data.",
          });
        }
      }),
      company: {
        status: authed.workforce.company.status.handler(async ({ context }) => {
          try {
            return await getAiCompanyStatus(deps.prisma, context.actor.spaceId);
          } catch (error) {
            throw badRequest(error, "Could not load the AI company.");
          }
        }),
        create: authed.workforce.company.create.handler(async ({ context, input }) => {
          try {
            return await createAiCompany(deps.prisma, repos, context.actor, input ?? {});
          } catch (error) {
            throw badRequest(error, "Could not create the AI company.");
          }
        }),
      },
      demo: {
        status: authed.workforce.demo.status.handler(async ({ context }) => {
          try {
            return await demoWithModelReadiness(
              context.actor,
              await getDemoStatus(deps.prisma, context.actor.spaceId),
            );
          } catch (error) {
            throw badRequest(error, "Could not load the AI Company demo.");
          }
        }),
        launch: authed.workforce.demo.launch.handler(async ({ context }) => {
          try {
            const status = await launchAiCompanyDemo(deps.prisma, repos, context.actor);
            return await demoWithModelReadiness(context.actor, status);
          } catch (error) {
            throw badRequest(error, "Could not launch the AI Company demo.");
          }
        }),
      },
      tasks: {
        create: authed.workforce.tasks.create.handler(async ({ context, input }) => {
          try {
            return await createDirectWorkforceTask(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              title: input.title,
              description: input.description,
              acceptanceCriteria: input.acceptanceCriteria,
              assigneeBotId: input.assigneeBotId,
              priority: input.priority,
              dueAt: input.dueAt ?? null,
            });
          } catch (error) {
            throw badRequest(error, "Could not create the task.");
          }
        }),
        execute: authed.workforce.tasks.execute.handler(async ({ context, input }) => {
          try {
            return await executeWorkforceTask(
              { prisma: deps.prisma, jobs: deps.jobs },
              {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                taskId: input.taskId,
                clientNonce: input.clientNonce,
              },
            );
          } catch (error) {
            throw badRequest(error, "Could not execute the task.");
          }
        }),
        assign: authed.workforce.tasks.assign.handler(async ({ context, input }) => {
          try {
            return await assignWorkforceTask(deps.prisma, {
              spaceId: context.actor.spaceId,
              taskId: input.taskId,
              assigneeBotId: input.assigneeBotId,
            });
          } catch (error) {
            throw badRequest(error, "Could not reassign the task.");
          }
        }),
        accept: authed.workforce.tasks.accept.handler(async ({ context, input }) => {
          try {
            return await acceptWorkforceTask(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              taskId: input.taskId,
              action: input.action as never,
              ...(input.comment ? { comment: input.comment } : {}),
              clientNonce: input.clientNonce,
            });
          } catch (error) {
            throw badRequest(error, "Could not record the task decision.");
          }
        }),
      },
    },
  };
}
