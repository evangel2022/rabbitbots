import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acceptMeetingAction,
  approveMeetingDecision,
  confirmMeetingConditions,
  executeMeetingAction,
  getMeetingView,
  reconcileActiveMeetings,
  reconcileMeetingAction,
  sendMeetingMessage,
} from "./meetings.js";
import {
  acceptWorkforceTask,
  createDirectWorkforceTask,
  delegateWorkforceTask,
  deliverChildDelegation,
  executeWorkforceTask,
  getWorkforceTaskView,
  reconcileExpiredDelegations,
  reconcileWorkforceTask,
} from "./workforce-tasks.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("meeting decision approvals (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let meetingId: string;
  let botId: string;
  let researchBotId: string;
  let financeBotId: string;
  let decisions: Array<{ id: string; agendaId: string }> = [];
  let otherDecisionId: string;

  beforeAll(() =>
    runAsSystem("meeting approval setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `approval-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Approving CEO",
          email: `approval-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      spaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: userId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      const repos = createRepos(prisma);
      const actor = () => ({
        userId,
        spaceId,
        email: `approval-${stamp}@example.com`,
        isDeploymentOwner: false,
      });
      const bots = [];
      for (const [name, key] of [
        ["CEO Assistant", "approval-chair"],
        ["Research Bot", "approval-research"],
        ["Finance Bot", "approval-finance"],
      ] as const) {
        const bot = await repos.createBot(actor(), {
          name,
          description: name,
          instructions: "",
          notifyOnFinish: true,
          spawnKey: `${key}-${stamp}`,
        });
        bots.push(bot.id);
      }
      botId = bots[0]!;
      researchBotId = bots[1]!;
      financeBotId = bots[2]!;
      const agendaTitles = [
        "Market opportunity",
        "Competitive position",
        "Financial feasibility",
        "Final recommendation",
      ];
      const created = await prisma.meeting.create({
        data: {
          spaceId,
          createdBy: userId,
          title: "Approval test meeting",
          description: "",
          chairBotId: bots[0]!,
          status: "COMPLETED",
          completedAt: new Date(),
          humanParticipants: { create: { userId, role: "HUMAN_CEO" } },
          participants: {
            create: bots.map((botId) => ({
              botId,
              role: "Participant",
              responsibilities: "",
            })),
          },
          agenda: {
            create: agendaTitles.map((title, sequence) => ({
              title,
              sequence: sequence + 1,
              maxDiscussionRounds: 2,
              timeLimitSeconds: 300,
            })),
          },
        },
        include: { agenda: { orderBy: { sequence: "asc" } } },
      });
      meetingId = created.id;
      decisions = [];
      for (const agenda of created.agenda) {
        const decision = await prisma.meetingDecision.create({
          data: {
            meetingId,
            agendaId: agenda.id,
            decisionType: "APPROVED_WITH_CONDITIONS",
            decisionText: `Recommendation for ${agenda.title}`,
            rationale: "Recorded by the chair.",
            supportingEvidence: [],
            risks: [],
            dissentingOpinions: [],
            conditions: ["Existing condition"],
            approvalRequired: true,
            approvalStatus: "PENDING",
          },
        });
        decisions.push({ id: decision.id, agendaId: agenda.id });
      }
      const other = await prisma.meeting.create({
        data: {
          spaceId,
          createdBy: userId,
          title: "Other approval meeting",
          description: "",
          chairBotId: bots[0]!,
          status: "COMPLETED",
          humanParticipants: { create: { userId, role: "HUMAN_CEO" } },
          agenda: {
            create: [
              { title: "Other agenda", sequence: 1, maxDiscussionRounds: 2, timeLimitSeconds: 300 },
            ],
          },
        },
        include: { agenda: true },
      });
      otherDecisionId = (
        await prisma.meetingDecision.create({
          data: {
            meetingId: other.id,
            agendaId: other.agenda[0]!.id,
            decisionType: "APPROVED",
            decisionText: "Other recommendation",
            rationale: "Other rationale",
            approvalRequired: true,
            approvalStatus: "PENDING",
          },
        })
      ).id;
    }),
  );

  afterAll(() =>
    runAsSystem("meeting approval cleanup", async () => {
      if (prisma) {
        await prisma.meeting.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  const itPostgres = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("meeting approval test", fn));

  itPostgres("approves with conditions and preserves actor/history", async () => {
    const result = await approveMeetingDecision(prisma, {
      spaceId,
      userId,
      meetingId,
      decisionId: decisions[0]!.id,
      action: "APPROVE_WITH_CONDITIONS",
      conditions: "Proceed only after the data-room gate.",
      rationale: "Approved for a bounded next step.",
      clientNonce: "approval-conditional-1",
    });
    expect(result.approval).toMatchObject({
      action: "APPROVE_WITH_CONDITIONS",
      previousStatus: "PENDING",
      newStatus: "APPROVED_WITH_CONDITIONS",
      actorUserId: userId,
      actorName: "Approving CEO",
      conditions: "Proceed only after the data-room gate.",
    });
    expect(result.decision.approvalStatus).toBe("APPROVED_WITH_CONDITIONS");
    expect(result.decision.approvalHistory).toHaveLength(1);
    expect(result.decision.approvalHistory[0]!.actorUserId).toBe(userId);
    expect(result.decision.approvalHistory[0]!.createdAt).toBeTruthy();
  });

  itPostgres("requires conditions for conditional approval", async () => {
    await expect(
      approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decisions[1]!.id,
        action: "APPROVE_WITH_CONDITIONS",
        conditions: "   ",
        clientNonce: "approval-empty-conditions",
      }),
    ).rejects.toThrow(/conditions are required/i);
  });

  itPostgres("rejects and defers with a rationale", async () => {
    const rejected = await approveMeetingDecision(prisma, {
      spaceId,
      userId,
      meetingId,
      decisionId: decisions[1]!.id,
      action: "REJECT",
      rationale: "The evidence does not support this step.",
      clientNonce: "approval-reject-1",
    });
    expect(rejected.decision.approvalStatus).toBe("REJECTED");
    const deferred = await approveMeetingDecision(prisma, {
      spaceId,
      userId,
      meetingId,
      decisionId: decisions[2]!.id,
      action: "DEFER",
      rationale: "Wait for the missing evidence.",
      clientNonce: "approval-defer-1",
    });
    expect(deferred.decision.approvalStatus).toBe("DEFERRED");
    await expect(
      approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decisions[3]!.id,
        action: "REJECT",
        rationale: " ",
        clientNonce: "approval-empty-rationale",
      }),
    ).rejects.toThrow(/rationale is required/i);
  });

  itPostgres("rejects non-members, Bots and cross-meeting decision IDs", async () => {
    await expect(
      approveMeetingDecision(prisma, {
        spaceId,
        userId: "not-a-human",
        meetingId,
        decisionId: decisions[3]!.id,
        action: "APPROVE",
        clientNonce: "approval-nonmember",
      }),
    ).rejects.toThrow(/not a human participant/i);
    await expect(
      approveMeetingDecision(prisma, {
        spaceId,
        userId: botId,
        meetingId,
        decisionId: decisions[3]!.id,
        action: "APPROVE",
        clientNonce: "approval-bot",
      }),
    ).rejects.toThrow(/not a human participant/i);
    await expect(
      approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: otherDecisionId,
        action: "APPROVE",
        clientNonce: "approval-cross-meeting",
      }),
    ).rejects.toThrow(/decision not found/i);
    expect(
      (await prisma.meetingDecision.findUniqueOrThrow({ where: { id: decisions[3]!.id } }))
        .approvalStatus,
    ).toBe("PENDING");
  });

  itPostgres(
    "allows a completed meeting to approve a pending decision without reopening it",
    async () => {
      const before = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
      const result = await approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decisions[3]!.id,
        action: "APPROVE",
        rationale: "Human owner approval after close.",
        clientNonce: "approval-completed-1",
      });
      expect(result.decision.approvalStatus).toBe("APPROVED");
      const after = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
      expect(after.status).toBe("COMPLETED");
      expect(after.completedAt?.toISOString()).toBe(before.completedAt?.toISOString());
      await expect(
        sendMeetingMessage(prisma, {
          spaceId,
          userId,
          meetingId,
          content: "This must stay read-only after completion.",
          clientNonce: "approval-transcript-readonly",
        }),
      ).rejects.toThrow(/read-only/i);
    },
  );

  itPostgres("allows pending decisions to be approved after cancellation or failure", async () => {
    for (const [index, status] of ["CANCELLED", "FAILED"].entries()) {
      const agenda = await prisma.meetingAgenda.create({
        data: {
          meetingId,
          title: `Post-close agenda ${index + 1}`,
          sequence: 10 + index,
          maxDiscussionRounds: 2,
          timeLimitSeconds: 300,
        },
      });
      const decision = await prisma.meetingDecision.create({
        data: {
          meetingId,
          agendaId: agenda.id,
          decisionType: "APPROVED",
          decisionText: `Post-close decision ${index + 1}`,
          rationale: "Recorded before close.",
          approvalRequired: true,
          approvalStatus: "PENDING",
        },
      });
      await prisma.meeting.update({ where: { id: meetingId }, data: { status } });
      const result = await approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decision.id,
        action: "APPROVE",
        rationale: `Approved after ${status.toLowerCase()}.`,
        clientNonce: `approval-${status.toLowerCase()}`,
      });
      expect(result.decision.approvalStatus).toBe("APPROVED");
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
        status,
      );
    }
  });

  itPostgres(
    "is idempotent for identical retries and rejects conflicting final approvals",
    async () => {
      const first = await approveMeetingDecision(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decisions[0]!.id,
        action: "APPROVE_WITH_CONDITIONS",
        conditions: "Proceed only after the data-room gate.",
        rationale: "Approved for a bounded next step.",
        clientNonce: "approval-conditional-1",
      });
      expect(first.decision.approvalHistory).toHaveLength(1);
      await expect(
        approveMeetingDecision(prisma, {
          spaceId,
          userId,
          meetingId,
          decisionId: decisions[0]!.id,
          action: "REJECT",
          rationale: "Conflicting retry.",
          clientNonce: "approval-conditional-1",
        }),
      ).rejects.toThrow(/conflicts with the recorded approval/i);
      await expect(
        approveMeetingDecision(prisma, {
          spaceId,
          userId,
          meetingId,
          decisionId: decisions[0]!.id,
          action: "APPROVE",
          clientNonce: "approval-second-final",
        }),
      ).rejects.toThrow(/already final/i);
      expect(
        await prisma.meetingDecisionApproval.count({ where: { decisionId: decisions[0]!.id } }),
      ).toBe(1);
    },
  );

  itPostgres("does not execute an action whose conditional decision is unconfirmed", async () => {
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Execute only after conditions are confirmed",
        description: "A test action.",
        acceptanceCriteria: "A run exists and the CEO accepts it.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    await expect(
      executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "action-unconfirmed",
        },
      ),
    ).rejects.toThrow(/not CEO-approved|conditions/i);
    expect(
      (await prisma.meetingActionItem.findUniqueOrThrow({ where: { id: action.id } })).status,
    ).toBe("OPEN");
  });

  itPostgres(
    "activates confirmed actions, starts exactly one Task/Run, and records CEO acceptance",
    async () => {
      const action = await prisma.meetingActionItem.findFirstOrThrow({
        where: { meetingId, title: "Execute only after conditions are confirmed" },
      });
      await confirmMeetingConditions(prisma, {
        spaceId,
        userId,
        meetingId,
        decisionId: decisions[0]!.id,
      });
      const activated = await prisma.meetingActionItem.findUniqueOrThrow({
        where: { id: action.id },
      });
      expect(activated.activatedAt).not.toBeNull();
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const started = await executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "action-confirmed",
        },
      );
      expect(started).toMatchObject({ executionStatus: "IN_PROGRESS" });
      expect(started.taskId).toBeTruthy();
      expect(started.botRunId).toBeTruthy();
      const again = await executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "action-confirmed-repeat",
        },
      );
      expect(again.taskId).toBe(started.taskId);
      expect(again.botRunId).toBe(started.botRunId);
      await prisma.meetingActionItem.update({
        where: { id: action.id },
        data: {
          status: "IN_PROGRESS",
          resultStatus: "SUCCESS",
          resultSummary: "The requested read-only analysis was completed and cited.",
          evidence: ["https://example.com/evidence"],
        },
      });
      const accepted = await acceptMeetingAction(prisma, {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        action: "ACCEPT",
        comment: "Evidence is sufficient.",
        clientNonce: "action-accept",
      });
      expect(accepted.executionStatus).toBe("COMPLETED");
      expect(accepted.acceptanceStatus).toBe("ACCEPTED");
      expect(accepted.acceptanceHistory.at(-1)).toMatchObject({
        action: "ACCEPT",
        actorUserId: userId,
        comment: "Evidence is sufficient.",
      });
      await expect(
        acceptMeetingAction(prisma, {
          spaceId,
          userId: "not-a-member",
          meetingId,
          actionItemId: action.id,
          action: "ACCEPT",
          clientNonce: "action-accept-nonmember",
        }),
      ).rejects.toThrow(/not a human participant/i);
    },
  );

  itPostgres("blocks a failed result instead of accepting it", async () => {
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Blocked failed action",
        description: "A failed execution.",
        acceptanceCriteria: "A verifiable result.",
        assigneeBotId: botId,
        status: "IN_PROGRESS",
        resultStatus: "FAILED",
        resultSummary: "The provider failed.",
      },
    });
    await expect(
      acceptMeetingAction(prisma, {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        action: "ACCEPT",
        clientNonce: "blocked-action-accept",
      }),
    ).rejects.toThrow(/SUCCESS|PARTIAL/i);
    const blocked = await acceptMeetingAction(prisma, {
      spaceId,
      userId,
      meetingId,
      actionItemId: action.id,
      action: "BLOCK",
      comment: "The provider failed; block until rerun.",
      clientNonce: "blocked-action-block",
    });
    expect(blocked.executionStatus).toBe("BLOCKED");
    expect(blocked.acceptanceStatus).toBe("BLOCKED");
  });

  itPostgres(
    "retains attempt history across RE_EXECUTE and recovers an in-flight action",
    async () => {
      const action = await prisma.meetingActionItem.create({
        data: {
          meetingId,
          decisionId: decisions[0]!.id,
          title: "Attempt history action",
          description: "A safe desk action.",
          acceptanceCriteria: "A result exists.",
          assigneeBotId: botId,
          activatedAt: new Date(),
          status: "OPEN",
        },
      });
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const first = await executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "attempt-history-one",
        },
      );
      expect(first.attempts).toHaveLength(1);
      await acceptMeetingAction(prisma, {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        action: "RE_EXECUTE",
        comment: "Retry for attempt history.",
        clientNonce: "attempt-history-reset",
      });
      const second = await executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "attempt-history-two",
        },
      );
      expect(second.attempts).toHaveLength(2);
      expect(second.attempts[0]!.botRunId).toBe(first.botRunId);
      expect(second.attempts[1]!.botRunId).not.toBe(first.botRunId);
      await prisma.meetingActionItem.update({
        where: { id: action.id },
        data: {
          startedAt: new Date(Date.now() - 120_000),
          status: "IN_PROGRESS",
          resultStatus: null,
        },
      });
      await reconcileActiveMeetings(
        { prisma, jobs },
        { staleAfterMs: 0, take: 20, now: new Date() },
      );
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "meeting.action.reconcile" }),
      );
      await prisma.workforceTask.create({
        data: {
          spaceId,
          source: "CEO_DIRECT",
          title: "Recoverable generic task",
          acceptanceCriteria: "A run exists.",
          assigneeBotId: researchBotId,
          createdByUserId: userId,
          status: "IN_PROGRESS",
          botRunId: "stale-generic-run",
          startedAt: new Date(Date.now() - 120_000),
        },
      });
      await reconcileActiveMeetings(
        { prisma, jobs },
        { staleAfterMs: 0, take: 20, now: new Date() },
      );
      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "workforce.task.reconcile" }),
      );
    },
  );

  itPostgres("exposes real workforce aggregates and task lineage", async () => {
    const { getWorkforceOverview } = await import("./workforce.js");
    const view = await getWorkforceOverview(prisma, spaceId);
    expect(view.tasks.length).toBeGreaterThan(0);
    expect(view.tasks.some((task) => task.attempts.length > 0)).toBe(true);
    expect(view.summary.open).toBeGreaterThanOrEqual(0);
    expect(view.summary.completed).toBeGreaterThan(0);
  });

  itPostgres("creates a CEO direct task with idempotent generic attempts", async () => {
    const task = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "CEO direct test task",
      description: "A safe desk task.",
      acceptanceCriteria: "A recorded result exists.",
      assigneeBotId: researchBotId,
      priority: "HIGH",
    });
    expect(task.source).toBe("CEO_DIRECT");
    expect(task.attempts).toHaveLength(0);
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const first = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: task.id,
        clientNonce: "direct-attempt-one",
      },
    );
    const duplicate = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: task.id,
        clientNonce: "direct-attempt-duplicate",
      },
    );
    expect(first.attempts).toHaveLength(1);
    expect(duplicate.attempts[0]?.taskId).toBe(first.attempts[0]?.taskId);
    expect(duplicate.attempts[0]?.botRunId).toBe(first.attempts[0]?.botRunId);
    await expect(
      acceptWorkforceTask(prisma, {
        spaceId,
        userId,
        taskId: task.id,
        action: "CANCEL",
        comment: "Test cancellation.",
        clientNonce: "direct-cancel",
      }),
    ).resolves.toMatchObject({ acceptanceStatus: "CANCELLED", executionStatus: "BLOCKED" });
  });

  itPostgres("completes a successful direct task before CEO acceptance", async () => {
    const task = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Direct completion task",
      description: "Complete this task before acceptance.",
      acceptanceCriteria: "A completed attempt is visible.",
      assigneeBotId: researchBotId,
      priority: "NORMAL",
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const started = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: task.id,
        clientNonce: "direct-complete-before-accept",
      },
    );
    const runId = started.attempts[0]!.botRunId!;
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const lastMessage = await prisma.message.findFirst({
      where: { threadId: run.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        threadId: run.threadId,
        seq: (lastMessage?.seq ?? 0) + 1,
        role: "bot",
        botId: researchBotId,
        runId,
        blocks: [
          {
            kind: "text",
            text: JSON.stringify({
              resultStatus: "SUCCESS",
              summary: "The task completed before the CEO reviewed it.",
              evidence: [],
            }),
          },
        ],
      },
    });

    await reconcileWorkforceTask({ prisma, jobs }, task.id);
    const completed = await getWorkforceTaskView(prisma, spaceId, task.id);
    expect(completed).toMatchObject({
      executionStatus: "COMPLETED",
      latestResultStatus: "SUCCESS",
      latestResultSummary: "The task completed before the CEO reviewed it.",
      acceptanceStatus: null,
    });

    const accepted = await acceptWorkforceTask(prisma, {
      spaceId,
      userId,
      taskId: task.id,
      action: "ACCEPT",
      clientNonce: "direct-complete-accept",
    });
    expect(accepted).toMatchObject({
      executionStatus: "COMPLETED",
      acceptanceStatus: "ACCEPTED",
    });
  });

  itPostgres("does not mark an empty model response as a successful task", async () => {
    const task = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Empty model response task",
      description: "The model returns no text.",
      acceptanceCriteria: "A result is returned.",
      assigneeBotId: researchBotId,
      priority: "NORMAL",
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const started = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: task.id,
        clientNonce: "direct-empty-model-response",
      },
    );
    const runId = started.attempts[0]!.botRunId!;
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    const lastMessage = await prisma.message.findFirst({
      where: { threadId: run.threadId },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        threadId: run.threadId,
        seq: (lastMessage?.seq ?? 0) + 1,
        role: "bot",
        botId: researchBotId,
        runId,
        blocks: [{ kind: "text", text: "No response. Try again." }],
      },
    });

    await reconcileWorkforceTask({ prisma, jobs }, task.id);
    const result = await getWorkforceTaskView(prisma, spaceId, task.id);
    expect(result).toMatchObject({
      executionStatus: "BLOCKED",
      latestResultStatus: "FAILED",
      latestResultSummary: "The model returned no response. The task did not produce a result.",
    });
  });

  itPostgres("delegates a child from a real parent run and rejects self-delegation", async () => {
    const parent = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Delegating parent",
      description: "Create a bounded child.",
      acceptanceCriteria: "Child has a Task and attempt.",
      assigneeBotId: researchBotId,
      priority: "NORMAL",
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const running = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: parent.id,
        clientNonce: "parent-run",
      },
    );
    const child = await delegateWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        parentRunId: running.attempts[0]!.botRunId!,
        delegatorBotId: researchBotId,
        userId,
        assigneeBotId: financeBotId,
        title: "Delegated arithmetic",
        description: "Check two numbers.",
        acceptanceCriteria: "Verdicts are returned.",
        priority: "NORMAL",
      },
    );
    expect(child.source).toBe("BOT_DELEGATED");
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.delegationDepth).toBe(1);
    expect(child.attempts).toHaveLength(1);
    await expect(
      delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: running.attempts[0]!.botRunId!,
          delegatorBotId: researchBotId,
          userId,
          assigneeBotId: researchBotId,
          title: "Self delegation",
          description: "",
          acceptanceCriteria: "Must fail.",
          priority: "NORMAL",
        },
      ),
    ).rejects.toThrow("itself");
    await expect(
      delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: child.attempts[0]!.botRunId!,
          delegatorBotId: financeBotId,
          userId,
          assigneeBotId: researchBotId,
          title: "Ancestor cycle",
          description: "",
          acceptanceCriteria: "Must fail.",
          priority: "NORMAL",
        },
      ),
    ).rejects.toThrow("cycle");
    expect(await getWorkforceTaskView(prisma, spaceId, child.id)).toMatchObject({
      parentTaskId: parent.id,
    });
    await prisma.workforceTask.update({
      where: { id: child.id },
      data: { status: "BLOCKED", resultStatus: "FAILED", blockedReason: "Child failed." },
    });
    const afterFailure = await getWorkforceTaskView(prisma, spaceId, parent.id);
    expect(afterFailure?.executionStatus).not.toBe("COMPLETED");
    expect(afterFailure?.latestResultStatus).not.toBe("SUCCESS");
  });

  itPostgres(
    "persists a delegation wait, delivers child results once and continues the parent once",
    async () => {
      const parent = await createDirectWorkforceTask(prisma, {
        spaceId,
        userId,
        title: "Durable parent",
        description: "Wait for two children.",
        acceptanceCriteria: "Both child results are present in the continuation.",
        assigneeBotId: researchBotId,
        priority: "HIGH",
      });
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const parentRun = await executeWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          userId,
          taskId: parent.id,
          clientNonce: "durable-parent-run",
        },
      );
      const childOne = await delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: parentRun.attempts[0]!.botRunId!,
          delegatorBotId: researchBotId,
          userId,
          assigneeBotId: financeBotId,
          title: "Durable child one",
          description: "First bounded child.",
          acceptanceCriteria: "Returns a result.",
          priority: "NORMAL",
        },
      );
      const childTwo = await delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: parentRun.attempts[0]!.botRunId!,
          delegatorBotId: researchBotId,
          userId,
          assigneeBotId: financeBotId,
          title: "Durable child two",
          description: "Second bounded child.",
          acceptanceCriteria: "Returns a result.",
          priority: "NORMAL",
        },
      );
      const waiting = await getWorkforceTaskView(prisma, spaceId, parent.id);
      expect(waiting).toMatchObject({
        executionStatus: "WAITING_FOR_CHILDREN",
        waitingForChildren: true,
      });
      expect(waiting?.delegations).toHaveLength(2);
      await prisma.run.update({
        where: { id: parentRun.attempts[0]!.botRunId! },
        data: { status: "completed", completedAt: new Date() },
      });
      await prisma.workforceTask.update({
        where: { id: childOne.id },
        data: {
          status: "COMPLETED",
          resultStatus: "SUCCESS",
          resultSummary: "Child one done.",
          completedAt: new Date(),
        },
      });
      await deliverChildDelegation({ prisma, jobs }, childOne.id);
      expect((await getWorkforceTaskView(prisma, spaceId, parent.id))?.executionStatus).toBe(
        "WAITING_FOR_CHILDREN",
      );
      await prisma.workforceTask.update({
        where: { id: childTwo.id },
        data: {
          status: "BLOCKED",
          resultStatus: "FAILED",
          resultSummary: "Child two failed.",
          completedAt: new Date(),
        },
      });
      await deliverChildDelegation({ prisma, jobs }, childTwo.id);
      const resumed = await getWorkforceTaskView(prisma, spaceId, parent.id);
      expect(resumed?.waitingForChildren).toBe(false);
      expect(resumed?.continuationRunId).toBeTruthy();
      expect(resumed?.delegations.every((row) => row.deliveredAt !== null)).toBe(true);
      expect(resumed?.attempts).toHaveLength(2);
      const continuationRun = await prisma.run.findUnique({
        where: { id: resumed!.continuationRunId! },
        select: { parentRunId: true, continuationOfRunId: true, trigger: true },
      });
      expect(continuationRun).toMatchObject({
        parentRunId: parentRun.attempts[0]!.botRunId,
        continuationOfRunId: parentRun.attempts[0]!.botRunId,
        trigger: "delegation_continuation",
      });
      await deliverChildDelegation({ prisma, jobs }, childTwo.id);
      expect(await prisma.workforceTaskAttempt.count({ where: { taskId: parent.id } })).toBe(2);
    },
  );

  itPostgres("rejects the sixth child and depth four boundaries", async () => {
    const parent = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Boundary parent",
      description: "Create five children, then reject the sixth.",
      acceptanceCriteria: "Limits hold.",
      assigneeBotId: researchBotId,
      priority: "NORMAL",
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const parentRun = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: parent.id,
        clientNonce: "boundary-parent-run",
      },
    );
    const children = [];
    for (let index = 0; index < 5; index += 1) {
      children.push(
        await delegateWorkforceTask(
          { prisma, jobs },
          {
            spaceId,
            parentRunId: parentRun.attempts[0]!.botRunId!,
            delegatorBotId: researchBotId,
            userId,
            assigneeBotId: financeBotId,
            title: `Boundary child ${index + 1}`,
            description: "Bounded child.",
            acceptanceCriteria: "Returns.",
            priority: "NORMAL",
          },
        ),
      );
    }
    await expect(
      delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: parentRun.attempts[0]!.botRunId!,
          delegatorBotId: researchBotId,
          userId,
          assigneeBotId: financeBotId,
          title: "Sixth child",
          description: "Must be rejected.",
          acceptanceCriteria: "Must fail.",
          priority: "NORMAL",
        },
      ),
    ).rejects.toThrow("delegation limit");
    const depthParent = children[0]!;
    await prisma.workforceTask.update({
      where: { id: depthParent.id },
      data: { delegationDepth: 3 },
    });
    await expect(
      delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: depthParent.attempts[0]!.botRunId!,
          delegatorBotId: financeBotId,
          userId,
          assigneeBotId: researchBotId,
          title: "Depth four",
          description: "Must be rejected.",
          acceptanceCriteria: "Must fail.",
          priority: "NORMAL",
        },
      ),
    ).rejects.toThrow("depth limit");
  });

  itPostgres("does not revive a cancelled parent from a late child result", async () => {
    const parent = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Cancelled durable parent",
      description: "Delegate once.",
      acceptanceCriteria: "Cancel wins.",
      assigneeBotId: researchBotId,
      priority: "NORMAL",
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const parentRun = await executeWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        taskId: parent.id,
        clientNonce: "cancelled-parent-run",
      },
    );
    const child = await delegateWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        parentRunId: parentRun.attempts[0]!.botRunId!,
        delegatorBotId: researchBotId,
        userId,
        assigneeBotId: financeBotId,
        title: "Late child",
        description: "Arrives after cancel.",
        acceptanceCriteria: "Must not revive.",
        priority: "NORMAL",
      },
    );
    await prisma.workforceTask.update({
      where: { id: parent.id },
      data: { status: "BLOCKED", acceptanceStatus: "CANCELLED" },
    });
    await prisma.workforceTask.update({
      where: { id: child.id },
      data: { status: "COMPLETED", resultStatus: "SUCCESS", resultSummary: "Late success." },
    });
    await deliverChildDelegation({ prisma, jobs }, child.id);
    expect((await getWorkforceTaskView(prisma, spaceId, parent.id))?.continuationRunId).toBeNull();
  });

  itPostgres(
    "times out a delegation idempotently and keeps a late child result auditable",
    async () => {
      const parent = await createDirectWorkforceTask(prisma, {
        spaceId,
        userId,
        title: "Timeout parent",
        description: "One child will time out.",
        acceptanceCriteria: "Timeout is visible.",
        assigneeBotId: researchBotId,
        priority: "NORMAL",
      });
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const parentRun = await executeWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          userId,
          taskId: parent.id,
          clientNonce: "timeout-parent-run",
        },
      );
      const child = await delegateWorkforceTask(
        { prisma, jobs },
        {
          spaceId,
          parentRunId: parentRun.attempts[0]!.botRunId!,
          delegatorBotId: researchBotId,
          userId,
          assigneeBotId: financeBotId,
          title: "Timed out child",
          description: "Never finishes in time.",
          acceptanceCriteria: "Returns.",
          priority: "NORMAL",
        },
      );
      await prisma.workforceDelegation.updateMany({
        where: { childTaskId: child.id },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });
      await reconcileExpiredDelegations({ prisma, jobs }, new Date());
      const timedOut = await getWorkforceTaskView(prisma, spaceId, parent.id);
      expect(timedOut?.delegations[0]).toMatchObject({
        status: "TIMED_OUT",
        resultStatus: "TIMED_OUT",
      });
      expect(timedOut?.continuationRunId).toBeTruthy();
      expect(timedOut?.acceptanceStatus).toBeNull();
      expect(timedOut?.attempts.find((attempt) => attempt.attemptNumber === 1)?.status).toBe(
        "FAILED",
      );
      const attemptsAfterTimeout = await prisma.workforceTaskAttempt.count({
        where: { taskId: parent.id },
      });
      await reconcileExpiredDelegations({ prisma, jobs }, new Date());
      expect(await prisma.workforceTaskAttempt.count({ where: { taskId: parent.id } })).toBe(
        attemptsAfterTimeout,
      );
      await prisma.workforceTask.update({
        where: { id: child.id },
        data: { status: "COMPLETED", resultStatus: "SUCCESS", resultSummary: "Late success." },
      });
      await deliverChildDelegation({ prisma, jobs }, child.id);
      const late = await getWorkforceTaskView(prisma, spaceId, parent.id);
      expect(late?.delegations[0]).toMatchObject({
        status: "TIMED_OUT",
        lateResultStatus: "SUCCESS",
      });
      expect(await prisma.workforceTaskAttempt.count({ where: { taskId: parent.id } })).toBe(
        attemptsAfterTimeout,
      );
    },
  );

  itPostgres("creates no Bot Run or task and preserves immutable approval rows", async () => {
    const runsBefore = await prisma.run.count({ where: { spaceId } });
    const tasksBefore = await prisma.task.count({ where: { spaceId } });
    await prisma.meetingDecision.update({
      where: { id: decisions[0]!.id },
      data: {
        discussionState: "DISAGREEMENT",
        supportingOpinions: ["Research supports a bounded next step."],
        evidenceGaps: ["Audited ARR remains unavailable."],
      },
    });
    await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Collect audited ARR",
        description: "Obtain the audited figure.",
        acceptanceCriteria: "Audited ARR is received and tied to the data room.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const view = await getMeetingView(prisma, spaceId, meetingId);
    expect(view?.formalMinutes).toContain("FORMAL MEETING MINUTES");
    expect(view?.formalMinutes).toContain("Approval record");
    expect(view?.formalMinutes).toContain("Audited ARR remains unavailable");
    expect(view?.formalMinutes).toContain("Collect audited ARR");
    expect(view?.formalMinutes).toContain("Acceptance criterion: Audited ARR is received");
    const approvals = await prisma.meetingDecisionApproval.findMany({ where: { meetingId } });
    expect(approvals.length).toBeGreaterThan(0);
    expect(await prisma.run.count({ where: { spaceId } })).toBe(runsBefore);
    expect(await prisma.task.count({ where: { spaceId } })).toBe(tasksBefore);
    for (const approval of approvals) {
      expect(approval.actorUserId).toBe(userId);
      expect(approval.previousStatus).toBe("PENDING");
      expect(approval.newStatus).not.toBe("PENDING");
      expect(approval.createdAt).toBeInstanceOf(Date);
    }
  });
  itPostgres("starts a deterministic parent and child from the Developer Demo action", async () => {
    const demo = await prisma.meeting.create({
      data: {
        spaceId,
        createdBy: userId,
        title: "Launch RabbitBots on GitHub — AI Company Launch Strategy",
        description: "RabbitBots demo · deterministic delegation test.",
        chairBotId: botId,
        status: "COMPLETED",
        completedAt: new Date(),
        humanParticipants: { create: { userId, role: "HUMAN_CEO" } },
        participants: {
          create: [botId, researchBotId, financeBotId].map((id) => ({
            botId: id,
            role: "Participant",
            responsibilities: "",
          })),
        },
        agenda: {
          create: {
            title: "GitHub Launch Plan and Execution",
            sequence: 1,
            maxDiscussionRounds: 1,
            timeLimitSeconds: 300,
          },
        },
      },
      include: { agenda: true },
    });
    const decision = await prisma.meetingDecision.create({
      data: {
        meetingId: demo.id,
        agendaId: demo.agenda[0]!.id,
        decisionType: "APPROVED_WITH_CONDITIONS",
        decisionText: "Prepare a GitHub launch execution recommendation.",
        rationale: "The approved action needs a real child research task.",
        supportingEvidence: [],
        risks: [],
        dissentingOpinions: [],
        conditions: [],
        approvalRequired: true,
        approvalStatus: "APPROVED",
        conditionsConfirmedAt: new Date(),
      },
    });
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId: demo.id,
        decisionId: decision.id,
        title: "Prepare a GitHub launch execution recommendation",
        description: "Delegate the channel research and review the child result.",
        acceptanceCriteria:
          "A real child research result is reviewed without claiming CEO acceptance.",
        assigneeBotId: botId,
        status: "OPEN",
        activatedAt: new Date(),
      },
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId: demo.id,
        actionItemId: action.id,
        clientNonce: "demo-deterministic-action",
      },
    );
    const parent = await prisma.workforceTask.findFirst({
      where: { parentMeetingActionId: action.id },
      include: { delegations: true, attempts: true },
    });
    expect(parent).not.toBeNull();
    expect(parent?.status).toBe("WAITING_FOR_CHILDREN");
    expect(parent?.waitingForChildren).toBe(true);
    expect(parent?.delegations).toHaveLength(1);
    const child = await prisma.workforceTask.findFirst({
      where: { parentTaskId: parent!.id },
      include: { attempts: true },
    });
    expect(child?.source).toBe("BOT_DELEGATED");
    expect(child?.assigneeBotId).toBe(researchBotId);
    expect(child?.assigneeBotId).not.toBe(parent?.assigneeBotId);
    expect(child?.delegationDepth).toBe(1);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent!.id } })).toBe(1);
    await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId: demo.id,
        actionItemId: action.id,
        clientNonce: "demo-deterministic-action-retry",
      },
    );
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent!.id } })).toBe(1);
    await prisma.workforceTask.update({
      where: { id: child!.id },
      data: {
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        resultSummary: "Research found two verifiable launch channels.",
        evidence: ["https://docs.github.com/"],
        completedAt: new Date(),
      },
    });
    await deliverChildDelegation({ prisma, jobs }, child!.id);
    const resumed = await getWorkforceTaskView(prisma, spaceId, parent!.id);
    expect(resumed?.waitingForChildren).toBe(false);
    expect(resumed?.continuationRunId).toBeTruthy();
    expect(resumed?.delegations[0]?.status).toBe("COMPLETED");
    expect(resumed?.delegations[0]?.resultStatus).toBe("SUCCESS");
  });
  itPostgres(
    "starts a normal meeting action through one parent WorkforceTask and one parent run",
    async () => {
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const action = await prisma.meetingActionItem.create({
        data: {
          meetingId,
          decisionId: decisions[0]!.id,
          title: "Unified parent execution action",
          description: "Exercise the normal unified entry.",
          acceptanceCriteria: "Exactly one durable parent execution exists.",
          assigneeBotId: botId,
          status: "OPEN",
        },
      });
      const started = await executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "unified-parent-start",
        },
      );
      const parent = await prisma.workforceTask.findFirstOrThrow({
        where: { parentMeetingActionId: action.id },
        include: { attempts: true, executionAttempts: true },
      });
      expect(parent).toMatchObject({
        source: "MEETING_DECISION",
        status: "IN_PROGRESS",
        parentMeetingActionId: action.id,
        assigneeBotId: botId,
        taskId: started.taskId,
        botRunId: started.botRunId,
      });
      expect(parent.executionAttempt).toBe(1);
      expect(parent.attempts).toHaveLength(1);
      expect(parent.executionAttempts).toHaveLength(1);
      expect(parent.executionAttempts[0]).toMatchObject({
        sourceType: "MEETING_ACTION",
        sourceId: action.id,
        meetingActionId: action.id,
        workforceTaskId: parent.id,
        taskId: started.taskId,
        runId: started.botRunId,
        attemptNumber: 1,
        status: "RUNNING",
      });
      const run = await prisma.run.findUniqueOrThrow({ where: { id: started.botRunId! } });
      expect(run.trigger).toBe("meeting_action");
      const refreshed = await prisma.meetingActionItem.findUniqueOrThrow({
        where: { id: action.id },
      });
      expect(refreshed).toMatchObject({
        status: "IN_PROGRESS",
        executionAttempt: 1,
        taskId: started.taskId,
        botRunId: started.botRunId,
      });
      expect(
        await prisma.workforceTask.count({ where: { parentMeetingActionId: action.id } }),
      ).toBe(1);
      expect(await prisma.workforceTaskAttempt.count({ where: { taskId: parent.id } })).toBe(1);
      expect(await prisma.meetingActionAttempt.count({ where: { actionItemId: action.id } })).toBe(
        1,
      );
    },
  );

  itPostgres("serializes concurrent execute requests to one parent task and one run", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Concurrent parent execution action",
        description: "Race the normal unified entry.",
        acceptanceCriteria: "One durable parent and one run exist.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const [first, second] = await Promise.all([
      executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "concurrent-unified-one",
        },
      ),
      executeMeetingAction(
        { prisma, jobs },
        {
          spaceId,
          userId,
          meetingId,
          actionItemId: action.id,
          clientNonce: "concurrent-unified-two",
        },
      ),
    ]);
    const parents = await prisma.workforceTask.findMany({
      where: { parentMeetingActionId: action.id },
      include: { attempts: true },
    });
    expect(parents).toHaveLength(1);
    expect(parents[0]!.attempts).toHaveLength(1);
    expect(await prisma.task.count({ where: { id: parents[0]!.taskId! } })).toBe(1);
    expect(await prisma.run.count({ where: { id: parents[0]!.botRunId! } })).toBe(1);
    expect(first.taskId).toBe(second.taskId);
    expect(first.botRunId).toBe(second.botRunId);
    expect(await prisma.workforceTaskAttempt.count({ where: { taskId: parents[0]!.id } })).toBe(1);
    expect(await prisma.meetingActionAttempt.count({ where: { actionItemId: action.id } })).toBe(1);
  });

  itPostgres(
    "rolls back a failed parent run creation without an orphan task or pointer",
    async () => {
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const action = await prisma.meetingActionItem.create({
        data: {
          meetingId,
          decisionId: decisions[0]!.id,
          title: "Rollback parent execution action",
          description: "Force the run unique constraint.",
          acceptanceCriteria: "No partial parent execution remains.",
          assigneeBotId: botId,
          status: "OPEN",
        },
      });
      const bot = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { thread: { select: { id: true } } },
      });
      const taskBefore = await prisma.task.count({ where: { spaceId } });
      const blocker = await prisma.task.create({
        data: {
          spaceId,
          botId,
          threadId: bot.thread!.id,
          userId,
          prompt: "Preexisting blocker task.",
          status: "completed",
        },
      });
      await prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId: bot.thread!.id,
          taskId: blocker.id,
          userId,
          status: "completed",
          trigger: "meeting_action",
          clientNonce: `meeting-action:${action.id}:1`,
        },
      });
      await expect(
        executeMeetingAction(
          { prisma, jobs },
          {
            spaceId,
            userId,
            meetingId,
            actionItemId: action.id,
            clientNonce: "rollback-unified-parent",
          },
        ),
      ).rejects.toThrow();
      expect(
        await prisma.workforceTask.count({ where: { parentMeetingActionId: action.id } }),
      ).toBe(0);
      const unchanged = await prisma.meetingActionItem.findUniqueOrThrow({
        where: { id: action.id },
      });
      expect(unchanged).toMatchObject({
        status: "OPEN",
        taskId: null,
        botRunId: null,
        executionAttempt: 0,
      });
      expect(await prisma.task.count({ where: { spaceId } })).toBe(taskBefore + 1);
      expect(await prisma.meetingActionAttempt.count({ where: { actionItemId: action.id } })).toBe(
        0,
      );
    },
  );

  itPostgres("makes the parent run discoverable by delegateWorkforceTask", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Delegation recognition action",
        description: "The parent run must be visible to delegation.",
        acceptanceCriteria: "The parent task owns one waiting delegation.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const started = await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        clientNonce: "delegation-recognition-start",
      },
    );
    const delegated = await delegateWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        userId,
        parentRunId: started.botRunId!,
        delegatorBotId: started.assigneeBotId!,
        assigneeBotId: researchBotId,
        title: "Delegate a bounded research child",
        description: "Research the bounded question.",
        acceptanceCriteria: "A child result exists.",
        priority: "NORMAL",
      },
    );
    const parent = await prisma.workforceTask.findFirstOrThrow({
      where: { parentMeetingActionId: action.id },
      include: { delegations: true },
    });
    expect(parent.waitingForChildren).toBe(true);
    expect(parent.status).toBe("WAITING_FOR_CHILDREN");
    expect(parent.delegations).toHaveLength(1);
    expect(parent.delegations[0]).toMatchObject({
      childTaskId: delegated.id,
      parentRunId: started.botRunId,
      status: "WAITING",
    });
    const child = await prisma.workforceTask.findUniqueOrThrow({ where: { id: delegated.id } });
    expect(child).toMatchObject({
      source: "BOT_DELEGATED",
      parentTaskId: parent.id,
      parentRunId: started.botRunId,
      assigneeBotId: researchBotId,
    });
  });

  itPostgres("does not duplicate the meeting action in the workforce overview", async () => {
    const { getWorkforceOverview } = await import("./workforce.js");
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Overview dedupe action",
        description: "The parent task must not be rendered twice.",
        acceptanceCriteria: "One action row exists.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        clientNonce: "overview-dedupe-start",
      },
    );
    const parent = await prisma.workforceTask.findFirstOrThrow({
      where: { parentMeetingActionId: action.id },
    });
    const overview = await getWorkforceOverview(prisma, spaceId);
    expect(overview.tasks.filter((task) => task.id === action.id)).toHaveLength(1);
    expect(overview.tasks.some((task) => task.id === parent.id)).toBe(false);
  });

  itPostgres("unifies a demo parent into the action row with continuation history", async () => {
    const { getWorkforceOverview } = await import("./workforce.js");
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Demo lifecycle overview action",
        description: "A direct parent linked to a meeting action must not render twice.",
        acceptanceCriteria: "One action row carries the parent and continuation history.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        clientNonce: "overview-demo-start",
      },
    );
    const parent = await prisma.workforceTask.findFirstOrThrow({
      where: { parentMeetingActionId: action.id },
    });
    await prisma.run.update({
      where: { id: parent.botRunId! },
      data: { status: "completed", completedAt: new Date() },
    });
    const botRow = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { thread: { select: { id: true } } },
    });
    const continuationTask = await prisma.task.create({
      data: {
        spaceId,
        botId,
        threadId: botRow.thread!.id,
        userId,
        prompt: "Continuation fixture",
        status: "completed",
      },
    });
    const continuationRun = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId: botRow.thread!.id,
        taskId: continuationTask.id,
        userId,
        status: "completed",
        trigger: "delegation_continuation",
        clientNonce: "overview-demo-continuation",
        completedAt: new Date(),
      },
    });
    await prisma.workforceTaskAttempt.create({
      data: {
        spaceId,
        taskId: parent.id,
        attemptNumber: 2,
        taskRunId: continuationTask.id,
        botRunId: continuationRun.id,
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        resultSummary: "Continuation completed.",
        evidence: ["continuation evidence"],
        completedAt: new Date(),
      },
    });
    await prisma.workforceTask.update({
      where: { id: parent.id },
      data: {
        source: "CEO_DIRECT",
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        resultSummary: "Parent completed.",
        executionAttempt: 2,
        taskId: continuationTask.id,
        botRunId: continuationRun.id,
        continuationRunId: continuationRun.id,
        completedAt: new Date(),
      },
    });
    const child = await prisma.workforceTask.create({
      data: {
        spaceId,
        source: "BOT_DELEGATED",
        title: "Demo child",
        description: "Child fixture.",
        acceptanceCriteria: "Child exists.",
        assigneeBotId: researchBotId,
        createdByUserId: userId,
        parentTaskId: parent.id,
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        completedAt: new Date(),
      },
    });
    const standalone = await prisma.workforceTask.create({
      data: {
        spaceId,
        source: "CEO_DIRECT",
        title: "Standalone overview task",
        description: "No meeting action link.",
        acceptanceCriteria: "Still visible.",
        assigneeBotId: botId,
        createdByUserId: userId,
        status: "OPEN",
      },
    });
    await prisma.workforceDelegation.create({
      data: {
        spaceId,
        parentTaskId: parent.id,
        parentRunId: parent.continuationOfRunId ?? continuationRun.id,
        childTaskId: child.id,
        childRunId: null,
        delegatorBotId: botId,
        assigneeBotId: researchBotId,
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        resultSummary: "Deterministic demo child.",
        evidence: ["demo evidence"],
        completedAt: new Date(),
      },
    });
    const overview = await getWorkforceOverview(prisma, spaceId);
    const rows = overview.tasks.filter((task) => task.id === action.id);
    expect(rows).toHaveLength(1);
    expect(overview.tasks.some((task) => task.id === parent.id)).toBe(false);
    expect(rows[0]).toMatchObject({
      source: "MEETING_DECISION",
      linkedWorkforceTaskId: parent.id,
      continuationRunId: continuationRun.id,
      executionStatus: "IN_PROGRESS",
      linkedExecutionStatus: "COMPLETED",
    });
    expect(rows[0]!.attempts).toHaveLength(2);
    expect(rows[0]!.delegations).toHaveLength(1);
    expect(rows[0]!.delegations[0]!.toolInvocationId).toBeNull();
    expect(rows[0]!.attempts[0]).toMatchObject({
      attemptNumber: 1,
      runStatus: "completed",
      runTrigger: "meeting_action",
    });
    expect(rows[0]!.attempts[1]).toMatchObject({
      attemptNumber: 2,
      botRunId: continuationRun.id,
      runStatus: "completed",
      runTrigger: "delegation_continuation",
      evidence: ["continuation evidence"],
    });
    expect(overview.tasks.some((task) => task.id === child.id)).toBe(true);
    expect(overview.tasks.some((task) => task.id === standalone.id)).toBe(true);
  });

  itPostgres("does not auto-complete a Meeting Action when the parent run ends", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "No automatic acceptance action",
        description: "Only the CEO may complete this action.",
        acceptanceCriteria: "The action remains unaccepted until the CEO acts.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    const started = await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        clientNonce: "no-auto-accept-start",
      },
    );
    await prisma.run.update({
      where: { id: started.botRunId! },
      data: { status: "completed", completedAt: new Date() },
    });
    await reconcileWorkforceTask(
      { prisma, jobs },
      (
        await prisma.workforceTask.findFirstOrThrow({
          where: { parentMeetingActionId: action.id },
        })
      ).id,
    );
    const parent = await prisma.workforceTask.findFirstOrThrow({
      where: { parentMeetingActionId: action.id },
    });
    const meetingAction = await prisma.meetingActionItem.findUniqueOrThrow({
      where: { id: action.id },
    });
    expect(parent.status).not.toBe("COMPLETED");
    expect(meetingAction.status).not.toBe("COMPLETED");
    expect(meetingAction.acceptanceStatus).not.toBe("ACCEPTED");
  });
  async function lifecycleFixture(
    resultStatus: "SUCCESS" | "FAILED",
    source: "MEETING_DECISION" | "CEO_DIRECT" = "MEETING_DECISION",
  ) {
    const botRow = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { thread: { select: { id: true } } },
    });
    const threadId = botRow.thread!.id;
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        prompt: "Parent lifecycle fixture",
        status: resultStatus === "SUCCESS" ? "completed" : "failed",
      },
      select: { id: true },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: resultStatus === "SUCCESS" ? "completed" : "failed",
        trigger: "delegation_continuation",
        clientNonce: `lifecycle-${resultStatus}-${Date.now()}-${Math.random()}`,
        completedAt: new Date(),
        error: resultStatus === "FAILED" ? "Parent continuation failed." : null,
      },
      select: { id: true },
    });
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: `Lifecycle action ${resultStatus} ${Date.now()}-${Math.random()}`,
        description: "Parent lifecycle fixture.",
        acceptanceCriteria: "Parent state follows continuation.",
        assigneeBotId: botId,
        status: resultStatus === "SUCCESS" ? "IN_PROGRESS" : "BLOCKED",
        resultStatus,
        taskId: task.id,
        botRunId: run.id,
        executionAttempt: 1,
      },
      select: { id: true },
    });
    const parent = await prisma.workforceTask.create({
      data: {
        spaceId,
        source,
        title: "Lifecycle parent",
        description: "Parent lifecycle fixture.",
        acceptanceCriteria: "No child completion shortcut.",
        assigneeBotId: botId,
        createdByUserId: userId,
        parentMeetingActionId: action.id,
        status: "IN_PROGRESS",
        resultStatus,
        taskId: task.id,
        botRunId: run.id,
        executionAttempt: 1,
        completedAt: null,
      },
      select: { id: true },
    });
    const attempt = await prisma.meetingActionAttempt.create({
      data: {
        meetingId,
        actionItemId: action.id,
        attemptNumber: 1,
        taskId: task.id,
        botRunId: run.id,
        status: "RUNNING",
        startedAt: new Date(),
      },
      select: { id: true },
    });
    return { parent, action, run, task, attempt };
  }

  itPostgres(
    "completes a meeting parent only after its continuation and keeps attempts",
    async () => {
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const fixture = await lifecycleFixture("SUCCESS");
      await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
      await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
      const parent = await prisma.workforceTask.findUniqueOrThrow({
        where: { id: fixture.parent.id },
      });
      expect(parent).toMatchObject({
        status: "COMPLETED",
        resultStatus: "SUCCESS",
        acceptanceStatus: null,
        botRunId: fixture.run.id,
        taskId: fixture.task.id,
      });
      expect(parent.completedAt).toBeTruthy();
      expect(
        await prisma.meetingActionAttempt.count({ where: { actionItemId: fixture.action.id } }),
      ).toBe(1);
      expect(
        await prisma.meetingActionAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
      ).toMatchObject({ taskId: fixture.task.id, botRunId: fixture.run.id });
      expect(await prisma.run.count({ where: { id: fixture.run.id } })).toBe(1);
      expect(
        await prisma.workforceTaskAttempt.count({ where: { taskId: fixture.parent.id } }),
      ).toBe(0);
    },
  );

  itPostgres("completes a demo parent sourced from a meeting action", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const fixture = await lifecycleFixture("SUCCESS", "CEO_DIRECT");
    await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
    await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
    const parent = await prisma.workforceTask.findUniqueOrThrow({
      where: { id: fixture.parent.id },
    });
    expect(parent).toMatchObject({
      source: "CEO_DIRECT",
      parentMeetingActionId: fixture.action.id,
      status: "COMPLETED",
      resultStatus: "SUCCESS",
      acceptanceStatus: null,
    });
  });

  itPostgres("marks a failed meeting parent continuation BLOCKED and idempotent", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const fixture = await lifecycleFixture("FAILED");
    await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
    await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
    const parent = await prisma.workforceTask.findUniqueOrThrow({
      where: { id: fixture.parent.id },
    });
    expect(parent.status).toBe("BLOCKED");
    expect(parent.resultStatus).toBe("FAILED");
    expect(parent.completedAt).toBeTruthy();
    expect(await prisma.run.count({ where: { id: fixture.run.id } })).toBe(1);
  });

  itPostgres("syncs CEO acceptance to the parent without auto-accepting it", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const fixture = await lifecycleFixture("SUCCESS");
    await reconcileWorkforceTask({ prisma, jobs }, fixture.parent.id);
    const before = await prisma.workforceTask.findUniqueOrThrow({
      where: { id: fixture.parent.id },
    });
    expect(before.status).toBe("COMPLETED");
    expect(before.acceptanceStatus).toBeNull();
    const completedAtBefore = before.completedAt;
    await acceptMeetingAction(prisma, {
      spaceId,
      userId,
      meetingId,
      actionItemId: fixture.action.id,
      action: "ACCEPT",
      comment: "Lifecycle acceptance.",
      clientNonce: `lifecycle-accept-${Date.now()}`,
    });
    const after = await prisma.workforceTask.findUniqueOrThrow({
      where: { id: fixture.parent.id },
    });
    expect(after).toMatchObject({
      status: "COMPLETED",
      acceptanceStatus: "ACCEPTED",
      botRunId: fixture.run.id,
      taskId: fixture.task.id,
    });
    expect(after.completedAt).toEqual(completedAtBefore);
  });

  itPostgres(
    "keeps the original action attempt when recovering a continuation pointer",
    async () => {
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher;
      const fixture = await lifecycleFixture("SUCCESS");
      const botRow = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { thread: { select: { id: true } } },
      });
      const threadId = botRow.thread!.id;
      const continuationTask = await prisma.task.create({
        data: {
          spaceId,
          botId,
          threadId,
          userId,
          prompt: "Continuation attempt fixture",
          status: "completed",
        },
        select: { id: true },
      });
      const continuationRun = await prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId: continuationTask.id,
          userId,
          status: "completed",
          trigger: "delegation_continuation",
          clientNonce: `lifecycle-continuation-${Date.now()}`,
          completedAt: new Date(),
        },
        select: { id: true },
      });
      await prisma.workforceTask.update({
        where: { id: fixture.parent.id },
        data: {
          executionAttempt: 2,
          taskId: continuationTask.id,
          botRunId: continuationRun.id,
          continuationRunId: continuationRun.id,
          continuationOfRunId: fixture.run.id,
        },
      });
      await reconcileMeetingAction({ prisma, jobs }, fixture.action.id);
      const action = await prisma.meetingActionItem.findUniqueOrThrow({
        where: { id: fixture.action.id },
      });
      const attempts = await prisma.meetingActionAttempt.findMany({
        where: { actionItemId: fixture.action.id },
        orderBy: { attemptNumber: "asc" },
      });
      expect(action.executionAttempt).toBe(2);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        attemptNumber: 1,
        taskId: fixture.task.id,
        botRunId: fixture.run.id,
      });
      expect(attempts[1]).toMatchObject({
        attemptNumber: 2,
        taskId: continuationTask.id,
        botRunId: continuationRun.id,
      });
      expect(await prisma.run.count({ where: { id: fixture.run.id } })).toBe(1);
    },
  );

  itPostgres("rejects a workforce acceptance bypass for a meeting-sourced parent", async () => {
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    const action = await prisma.meetingActionItem.create({
      data: {
        meetingId,
        decisionId: decisions[0]!.id,
        title: "Acceptance authority action",
        description: "CEO acceptance must remain meeting-native.",
        acceptanceCriteria: "Only the meeting action acceptance can complete it.",
        assigneeBotId: botId,
        status: "OPEN",
      },
    });
    await executeMeetingAction(
      { prisma, jobs },
      {
        spaceId,
        userId,
        meetingId,
        actionItemId: action.id,
        clientNonce: "acceptance-authority-start",
      },
    );
    const parent = await prisma.workforceTask.findFirstOrThrow({
      where: { parentMeetingActionId: action.id },
    });
    await expect(
      acceptWorkforceTask(prisma, {
        spaceId,
        userId,
        taskId: parent.id,
        action: "ACCEPT",
        clientNonce: "acceptance-authority-bypass",
      }),
    ).rejects.toThrow(/meeting action/i);
    const unchanged = await prisma.meetingActionItem.findUniqueOrThrow({
      where: { id: action.id },
    });
    expect(unchanged.status).toBe("IN_PROGRESS");
    expect(unchanged.acceptanceStatus).not.toBe("ACCEPTED");
  });
});
