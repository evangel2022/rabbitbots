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
      await prisma.run.update({
        where: { id: parentRun.attempts[0]!.botRunId! },
        data: { status: "completed", completedAt: new Date() },
      });
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
});
