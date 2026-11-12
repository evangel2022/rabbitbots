import { ORPCError } from "@orpc/server";
import {
  acceptMeetingAction,
  approveMeetingDecision,
  assignMeetingAction,
  cancelMeeting,
  confirmMeetingConditions,
  createMeeting,
  executeMeetingAction,
  getMeetingView,
  listMeetingMessages,
  listMeetings,
  sendMeetingMessage,
  startMeeting,
  updateDraftMeeting,
} from "@rakazo/adapters";
import { IsolationError } from "@rakazo/db";
import type { RouterContext } from "./context.js";

async function requireMeetingHuman(
  prisma: RouterContext["deps"]["prisma"],
  spaceId: string,
  meetingId: string,
  userId: string,
) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, spaceId },
    select: { id: true },
  });
  const human = meeting
    ? await prisma.meetingHumanParticipant.findUnique({
        where: { meetingId_userId: { meetingId, userId } },
        select: { id: true },
      })
    : null;
  if (!meeting || !human) throw new IsolationError();
}

export function meetingsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    meetings: {
      list: authed.meetings.list.handler(async ({ context }) => ({
        meetings: await listMeetings(deps.prisma, context.actor.spaceId),
      })),
      get: authed.meetings.get.handler(async ({ context, input }) => {
        // Read-only by contract: the worker reconciles meetings. Polling this
        // procedure merely refreshes the persisted view.
        const view = await getMeetingView(deps.prisma, context.actor.spaceId, input.meetingId);
        if (!view) throw new IsolationError();
        return view;
      }),
      create: authed.meetings.create.handler(async ({ context, input }) => {
        try {
          const meetingId = await createMeeting(deps.prisma, {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            title: input.title,
            description: input.description,
            chairBotId: input.chairBotId,
            participantBotIds: input.participantBotIds,
            agenda: input.agenda,
          });
          const view = await getMeetingView(deps.prisma, context.actor.spaceId, meetingId);
          if (!view) throw new Error("Meeting was not persisted.");
          return view;
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not create the meeting.",
          });
        }
      }),
      update: authed.meetings.update.handler(async ({ context, input }) => {
        try {
          await updateDraftMeeting(deps.prisma, {
            spaceId: context.actor.spaceId,
            meetingId: input.meetingId,
            title: input.title,
            description: input.description,
            agenda: input.agenda,
          });
          const view = await getMeetingView(deps.prisma, context.actor.spaceId, input.meetingId);
          if (!view) throw new IsolationError();
          return view;
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not update the meeting.",
          });
        }
      }),
      start: authed.meetings.start.handler(async ({ context, input }) => {
        try {
          return await startMeeting(
            { prisma: deps.prisma, jobs: deps.jobs },
            {
              spaceId: context.actor.spaceId,
              meetingId: input.meetingId,
            },
          );
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Could not start the meeting.",
          });
        }
      }),
      cancel: authed.meetings.cancel.handler(async ({ context, input }) => {
        const view = await cancelMeeting(
          { prisma: deps.prisma, jobs: deps.jobs },
          {
            spaceId: context.actor.spaceId,
            meetingId: input.meetingId,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        );
        if (!view) throw new IsolationError();
        return view;
      }),
      decisions: {
        confirmConditions: authed.meetings.decisions.confirmConditions.handler(
          async ({ context, input }) => {
            await requireMeetingHuman(
              deps.prisma,
              context.actor.spaceId,
              input.meetingId,
              context.actor.userId,
            );
            try {
              return await confirmMeetingConditions(deps.prisma, {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                meetingId: input.meetingId,
                decisionId: input.decisionId,
              });
            } catch (error) {
              throw new ORPCError("BAD_REQUEST", {
                message:
                  error instanceof Error ? error.message : "Could not confirm the conditions.",
              });
            }
          },
        ),
        approve: authed.meetings.decisions.approve.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          try {
            return await approveMeetingDecision(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              meetingId: input.meetingId,
              decisionId: input.decisionId,
              action: input.action,
              ...(input.rationale ? { rationale: input.rationale } : {}),
              ...(input.conditions ? { conditions: input.conditions } : {}),
              clientNonce: input.clientNonce,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not approve the decision.",
            });
          }
        }),
      },
      actions: {
        execute: authed.meetings.actions.execute.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          try {
            return await executeMeetingAction(
              { prisma: deps.prisma, jobs: deps.jobs },
              {
                spaceId: context.actor.spaceId,
                userId: context.actor.userId,
                meetingId: input.meetingId,
                actionItemId: input.actionItemId,
                clientNonce: input.clientNonce,
              },
            );
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not execute the action.",
            });
          }
        }),
        assign: authed.meetings.actions.assign.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          try {
            return await assignMeetingAction(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              meetingId: input.meetingId,
              actionItemId: input.actionItemId,
              assigneeBotId: input.assigneeBotId,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not reassign the action.",
            });
          }
        }),
        accept: authed.meetings.actions.accept.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          try {
            return await acceptMeetingAction(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              meetingId: input.meetingId,
              actionItemId: input.actionItemId,
              action: input.action,
              ...(input.comment ? { comment: input.comment } : {}),
              clientNonce: input.clientNonce,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message: error instanceof Error ? error.message : "Could not record the acceptance.",
            });
          }
        }),
      },
      messages: {
        list: authed.meetings.messages.list.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          return listMeetingMessages(deps.prisma, {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            meetingId: input.meetingId,
            afterSeq: input.afterSeq,
            limit: input.limit,
          });
        }),
        send: authed.meetings.messages.send.handler(async ({ context, input }) => {
          await requireMeetingHuman(
            deps.prisma,
            context.actor.spaceId,
            input.meetingId,
            context.actor.userId,
          );
          try {
            return await sendMeetingMessage(deps.prisma, {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              meetingId: input.meetingId,
              ...(input.agendaId ? { agendaId: input.agendaId } : {}),
              content: input.content,
              clientNonce: input.clientNonce,
            });
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
              message:
                error instanceof Error ? error.message : "Could not send the meeting message.",
            });
          }
        }),
      },
    },
  };
}
