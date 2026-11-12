import type { PrismaClient } from "@rakazo/db";
import {
  bootstrapUserSpace,
  createDb,
  createRepos,
  createThreadMessage,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { buildJoinPrompt, readRunOutcome, reconcileOrchestration } from "./orchestration.js";
import { startOrchestration } from "./orchestration-start.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describe("buildJoinPrompt", () => {
  it("labels a fully successful report and quotes both results", () => {
    const prompt = buildJoinPrompt({
      goal: "Investment analysis",
      children: [
        {
          role: "research",
          botName: "Research Bot",
          status: "completed",
          result: "Market is competitive.",
          error: null,
        },
        {
          role: "finance",
          botName: "Finance Bot",
          status: "completed",
          result: "Margins are thin.",
          error: null,
        },
      ],
    });
    expect(prompt).toContain("overall status: success");
    expect(prompt).toContain("Market is competitive.");
    expect(prompt).toContain("Margins are thin.");
    expect(prompt).not.toContain("This report is partial");
  });

  it("keeps a failed child visible and labels the report partial", () => {
    const prompt = buildJoinPrompt({
      goal: "Investment analysis",
      children: [
        {
          role: "research",
          botName: "Research Bot",
          status: "completed",
          result: "Market is competitive.",
          error: null,
        },
        {
          role: "finance",
          botName: "Finance Bot",
          status: "failed",
          result: null,
          error: "The model provider refused the request.",
        },
      ],
    });
    expect(prompt).toContain("overall status: partial");
    expect(prompt).toContain("The model provider refused the request.");
    expect(prompt).toContain("This report is partial");
  });

  it("does not pretend a fully failed delegation produced results", () => {
    const prompt = buildJoinPrompt({
      goal: "Investment analysis",
      children: [
        {
          role: "research",
          botName: "Research Bot",
          status: "timed_out",
          result: null,
          error: "Timed out.",
        },
        {
          role: "finance",
          botName: "Finance Bot",
          status: "failed",
          result: null,
          error: "Provider error.",
        },
      ],
    });
    expect(prompt).toContain("overall status: failed");
    expect(prompt).toContain("Timed out.");
    expect(prompt).toContain("Provider error.");
  });
});

describePostgres("orchestration (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let ceo: { id: string; name: string };
  let research: { id: string; name: string };
  let finance: { id: string; name: string };
  let parentThreadId: string;
  let parentRunId: string;
  let sequence = 0;

  const actor = () => ({
    userId,
    spaceId,
    email: "orchestration@example.com",
    isDeploymentOwner: false,
  });

  beforeAll(() =>
    runAsSystem("orchestration test setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `orch-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Orchestration Test",
          email: `orch-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      spaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: userId },
          {
            signupsEnabled: undefined,
            signupAllowlist: undefined,
          },
        )
      ).spaceId;
      const repos = createRepos(prisma);
      const makeBot = (name: string) =>
        repos.createBot(actor(), {
          name,
          description: "",
          instructions: "",
          notifyOnFinish: true,
        });
      ceo = await makeBot("CEO Assistant");
      research = await makeBot("Research Bot");
      finance = await makeBot("Finance Bot");
      const parentThread = await prisma.thread.findFirstOrThrow({ where: { botId: ceo.id } });
      parentThreadId = parentThread.id;
      const task = await prisma.task.create({
        data: {
          spaceId,
          botId: ceo.id,
          threadId: parentThreadId,
          userId,
          prompt: "Prepare the investment analysis.",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          botId: ceo.id,
          threadId: parentThreadId,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "user",
        },
      });
      parentRunId = run.id;
    }),
  );

  afterAll(() =>
    runAsSystem("orchestration test cleanup", async () => {
      if (prisma) {
        await prisma.orchestration.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  const postgresIt = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("orchestration test", fn));

  function fakeJobs() {
    return { enqueue: vi.fn(async () => undefined) };
  }

  async function start(
    options: { goal?: string; nonce?: string; tasks?: Array<Record<string, unknown>> } = {},
  ) {
    const jobs = fakeJobs();
    const result = await startOrchestration(
      {
        prisma,
        jobs: jobs as unknown as ExecutorDeps["jobs"],
        events: { notify: vi.fn(async () => undefined) } as unknown as ExecutorDeps["events"],
        runLease: undefined,
      },
      { id: ceo.id, name: ceo.name },
      {
        id: parentRunId,
        spaceId,
        threadId: parentThreadId,
        botId: ceo.id,
        userId,
        sourceMessageId: null,
        trigger: "user",
      },
      {
        goal: options.goal ?? "Analyze a company for investment.",
        tasks: (options.tasks ?? [
          { botId: research.id, task: "Research the market.", role: "research" },
          { botId: finance.id, task: "Analyze the financials.", role: "finance" },
        ]) as never,
        clientNonce: options.nonce ?? `test-orchestration-${sequence++}`,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const orchestration = await prisma.orchestration.findUniqueOrThrow({
      where: { id: result.orchestrationId },
      include: { children: { orderBy: { createdAt: "asc" } } },
    });
    return { orchestration, result, jobs };
  }

  async function child(orchId: string, botId: string) {
    return prisma.orchestrationChild.findFirstOrThrow({
      where: { orchestrationId: orchId, botId },
    });
  }

  async function createBotText(threadId: string, runId: string, botId: string, text: string) {
    return createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId,
      blocks: [{ kind: "text", text }],
    });
  }

  async function completeChild(orchId: string, botId: string, text: string) {
    const row = await child(orchId, botId);
    await prisma.run.update({
      where: { id: row.runId! },
      data: { status: "completed", completedAt: new Date() },
    });
    await createBotText(row.threadId!, row.runId!, botId, text);
    return row;
  }

  async function failChild(orchId: string, botId: string, error: string) {
    const row = await child(orchId, botId);
    await prisma.run.update({
      where: { id: row.runId! },
      data: { status: "failed", error, completedAt: new Date() },
    });
    return row;
  }

  async function reconcile(orchId: string) {
    const jobs = fakeJobs();
    await reconcileOrchestration({ prisma, jobs: jobs as unknown as ExecutorDeps["jobs"] }, orchId);
    return jobs;
  }

  async function joinRun(orchId: string) {
    const row = await prisma.orchestration.findUniqueOrThrow({ where: { id: orchId } });
    expect(row.joinRunId).toBeTruthy();
    return prisma.run.findUniqueOrThrow({ where: { id: row.joinRunId! } });
  }

  postgresIt(
    "creates both child tasks and runs before returning, each in its own chat",
    async () => {
      const { orchestration, result, jobs } = await start();
      expect(orchestration.children).toHaveLength(2);
      expect(result.children.map((entry) => entry.botName).sort()).toEqual([
        "Finance Bot",
        "Research Bot",
      ]);
      for (const row of orchestration.children) {
        expect(row.runId).toBeTruthy();
        expect(row.taskId).toBeTruthy();
        expect(row.threadId).toBeTruthy();
        const run = await prisma.run.findUniqueOrThrow({ where: { id: row.runId! } });
        expect(run.trigger).toBe("bot_message");
        expect(run.botId).toBe(row.botId);
        expect(run.threadId).toBe(row.threadId);
      }
      const researchChild = await child(orchestration.id, research.id);
      const financeChild = await child(orchestration.id, finance.id);
      expect(researchChild.threadId).not.toBe(financeChild.threadId);
      expect(jobs.enqueue).toHaveBeenCalledTimes(2);
      const inbound = await prisma.message.findMany({
        where: { threadId: { in: [researchChild.threadId!, financeChild.threadId!] } },
        select: { threadId: true, blocks: true },
      });
      for (const message of inbound) {
        expect(message.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "bot_message_received",
              orchestrationId: orchestration.id,
            }),
          ]),
        );
      }
      const join = await prisma.run.count({
        where: { spaceId, trigger: "orchestration_join" },
      });
      expect(join).toBe(0);
    },
  );

  postgresIt("returns the same orchestration when the tool call is retried", async () => {
    const nonce = `retry-${sequence++}`;
    const first = await start({ nonce });
    const second = await start({ nonce });
    expect(second.result.replayed).toBe(true);
    expect(second.orchestration.id).toBe(first.orchestration.id);
    const count = await prisma.orchestration.count({
      where: { spaceId, clientNonce: nonce },
    });
    expect(count).toBe(1);
    expect(second.jobs.enqueue).not.toHaveBeenCalled();
  });

  postgresIt("joins both successes exactly once and writes the final report", async () => {
    const { orchestration } = await start();
    await completeChild(orchestration.id, research.id, "Research result: the market is crowded.");
    await completeChild(orchestration.id, finance.id, "Finance result: margins are thin.");

    await reconcile(orchestration.id);
    await reconcile(orchestration.id);

    const settled = await prisma.orchestration.findUniqueOrThrow({
      where: { id: orchestration.id },
      include: { children: true },
    });
    expect(settled.status).toBe("joining");
    expect(settled.children.every((entry) => entry.status === "completed")).toBe(true);
    const join = await joinRun(orchestration.id);
    expect(join.botId).toBe(ceo.id);
    expect(join.threadId).toBe(parentThreadId);
    expect(join.trigger).toBe("orchestration_join");
    const task = await prisma.task.findUniqueOrThrow({ where: { id: join.taskId } });
    expect(task.prompt).toContain("overall status: success");
    expect(task.prompt).toContain("Research result: the market is crowded.");
    expect(task.prompt).toContain("Finance result: margins are thin.");
    const joins = await prisma.run.count({
      where: {
        spaceId,
        clientNonce: `orchestration-join:${orchestration.id}`,
      },
    });
    expect(joins).toBe(1);

    await prisma.run.update({
      where: { id: join.id },
      data: { status: "completed", completedAt: new Date() },
    });
    const report = await createBotText(parentThreadId, join.id, ceo.id, "Final investment report.");
    await reconcile(orchestration.id);
    const completed = await prisma.orchestration.findUniqueOrThrow({
      where: { id: orchestration.id },
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();
    expect(await readRunOutcome(prisma, join.id)).toMatchObject({
      text: "Final investment report.",
      messageId: report.id,
    });
  });

  postgresIt("keeps a failed child visible and still writes a partial report", async () => {
    const { orchestration } = await start();
    await completeChild(orchestration.id, research.id, "Research result: viable segment.");
    await failChild(orchestration.id, finance.id, "The model provider refused the request.");

    await reconcile(orchestration.id);

    const settled = await prisma.orchestration.findUniqueOrThrow({
      where: { id: orchestration.id },
      include: { children: true },
    });
    expect(settled.children.find((entry) => entry.botId === finance.id)?.status).toBe("failed");
    expect(settled.children.find((entry) => entry.botId === finance.id)?.error).toContain(
      "refused",
    );
    const join = await joinRun(orchestration.id);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: join.taskId } });
    expect(task.prompt).toContain("overall status: partial");
    expect(task.prompt).toContain("The model provider refused the request.");
    expect(task.prompt).toContain("This report is partial");
    expect(task.prompt).not.toContain("Finance result");
  });

  postgresIt("joins two failed children without inventing a result", async () => {
    const { orchestration } = await start();
    await failChild(orchestration.id, research.id, "Research failed.");
    await failChild(orchestration.id, finance.id, "Finance failed.");

    await reconcile(orchestration.id);

    const settled = await prisma.orchestration.findUniqueOrThrow({
      where: { id: orchestration.id },
      include: { children: true },
    });
    expect(settled.children.every((entry) => entry.status === "failed")).toBe(true);
    const join = await joinRun(orchestration.id);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: join.taskId } });
    expect(task.prompt).toContain("overall status: failed");
    expect(task.prompt).toContain("Research failed.");
    expect(task.prompt).toContain("Finance failed.");
  });

  postgresIt(
    "marks a child timed out at the deadline and joins with the timeout visible",
    async () => {
      const { orchestration } = await start();
      await prisma.orchestration.update({
        where: { id: orchestration.id },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });

      await reconcile(orchestration.id);

      const settled = await prisma.orchestration.findUniqueOrThrow({
        where: { id: orchestration.id },
        include: { children: true },
      });
      expect(settled.children.every((entry) => entry.status === "timed_out")).toBe(true);
      const join = await joinRun(orchestration.id);
      const task = await prisma.task.findUniqueOrThrow({ where: { id: join.taskId } });
      expect(task.prompt).toContain("overall status: failed");
      expect(task.prompt).toContain("timed_out");
    },
  );

  postgresIt("waits through worker retries and duplicate completion passes", async () => {
    const { orchestration } = await start();
    const researchChild = await child(orchestration.id, research.id);
    const financeChild = await child(orchestration.id, finance.id);
    await prisma.run.update({
      where: { id: researchChild.runId! },
      data: { status: "running", startedAt: new Date() },
    });
    await prisma.run.update({
      where: { id: financeChild.runId! },
      data: { status: "running", startedAt: new Date() },
    });

    await reconcile(orchestration.id);
    expect(
      await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } }),
    ).toMatchObject({ status: "running", joinRunId: null });

    await completeChild(orchestration.id, research.id, "Research result after a retry.");
    await reconcile(orchestration.id);
    expect(
      await prisma.orchestration.findUniqueOrThrow({ where: { id: orchestration.id } }),
    ).toMatchObject({ status: "running", joinRunId: null });

    await completeChild(orchestration.id, finance.id, "Finance result after a retry.");
    await reconcile(orchestration.id);
    await reconcile(orchestration.id);
    const join = await joinRun(orchestration.id);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: join.taskId } });
    expect(task.prompt).toContain("Research result after a retry.");
    expect(task.prompt).toContain("Finance result after a retry.");
    const joins = await prisma.run.count({
      where: {
        spaceId,
        clientNonce: `orchestration-join:${orchestration.id}`,
      },
    });
    expect(joins).toBe(1);
  });
});
