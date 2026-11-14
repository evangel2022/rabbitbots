import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  prepareToolInvocation,
  recoverToolInvocationResult,
  rewindToolInvocationForSafeRetry,
} from "./tool-invocations.js";
import {
  createDirectWorkforceTask,
  delegateWorkforceTask,
  delegationRequestDigest,
  executeWorkforceTask,
  getWorkforceTaskView,
  recoverDelegatedTaskForInvocation,
} from "./workforce-tasks.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

function fakeJobs(): JobPublisher {
  return {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  } as unknown as JobPublisher;
}

/**
 * Wraps a real Prisma client and fails one model's create operation inside a
 * business transaction. The delegate transaction must roll back every row.
 */
function failingTransactionPrisma(
  prisma: PrismaClient,
  failOn: "workforceTask" | "task" | "run" | "workforceDelegation",
): PrismaClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          target.$transaction(async (tx) => {
            const wrapped = new Proxy(tx as object, {
              get(txTarget, model, txReceiver) {
                if (model !== failOn) return Reflect.get(txTarget, model, txReceiver);
                return new Proxy((txTarget as Record<string, object>)[model]!, {
                  get(modelTarget, operation, modelReceiver) {
                    if (operation === "create") {
                      return async () => {
                        throw new Error(`injected ${failOn}.create failure`);
                      };
                    }
                    const value = Reflect.get(modelTarget, operation, modelReceiver);
                    return typeof value === "function" ? value.bind(modelTarget) : value;
                  },
                });
              },
            });
            return fn(wrapped);
          }, options as never);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describePostgres("workforce delegation idempotency (PostgreSQL)", () => {
  const itPostgres = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("delegation idempotency test", fn));
  let prisma: PrismaClient;
  let secondPrisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let delegatorBotId: string;
  let assigneeBotId: string;
  let otherAssigneeBotId: string;

  beforeAll(() =>
    runAsSystem("delegation idempotency setup", async () => {
      const db = createDb(databaseUrl!);
      const second = createDb(databaseUrl!);
      prisma = db.prisma;
      secondPrisma = second.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await second.prisma.$disconnect();
        await db.pool.end();
        await second.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `delegation-idempotency-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Delegation CEO",
          email: `delegation-${stamp}@example.com`,
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
        email: `delegation-${stamp}@example.com`,
        isDeploymentOwner: false,
      });
      const bots: string[] = [];
      for (const [name, key] of [
        ["Delegator Bot", "delegation-parent"],
        ["Child Bot A", "delegation-child-a"],
        ["Child Bot B", "delegation-child-b"],
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
      delegatorBotId = bots[0]!;
      assigneeBotId = bots[1]!;
      otherAssigneeBotId = bots[2]!;
    }),
  );

  afterAll(() =>
    runAsSystem("delegation idempotency cleanup", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  async function createParent() {
    const task = await createDirectWorkforceTask(prisma, {
      spaceId,
      userId,
      title: "Idempotency parent",
      description: "Delegate one child.",
      acceptanceCriteria: "Child exists once.",
      assigneeBotId: delegatorBotId,
      priority: "NORMAL",
    });
    const running = await executeWorkforceTask(
      { prisma, jobs: fakeJobs() },
      { spaceId, userId, taskId: task.id, clientNonce: `parent-${task.id}` },
    );
    return {
      task,
      running,
      parentRunId: running.attempts[0]!.botRunId!,
    };
  }

  async function prepareInvocation(parentRunId: string, args: Record<string, unknown>) {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId: parentRunId,
      toolName: "delegate_task",
      args,
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal invocation");
    return prepared.row.invocationId;
  }

  it("canonicalizes only validated business fields", () => {
    const first = delegationRequestDigest({
      assigneeBotId: "bot-a",
      title: "Title",
      description: "Description",
      acceptanceCriteria: "Criteria",
      priority: "HIGH",
    });
    const reordered = delegationRequestDigest({
      priority: "HIGH",
      acceptanceCriteria: "Criteria",
      description: "Description",
      title: "Title",
      assigneeBotId: "bot-a",
    });
    expect(reordered).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      delegationRequestDigest({
        assigneeBotId: "bot-a",
        title: "Title",
        description: "Description",
        acceptanceCriteria: "Criteria",
        priority: "LOW",
      }),
    ).not.toBe(first);
  });

  itPostgres("returns the original child for the same invocation and digest", async () => {
    const parent = await createParent();
    const args = {
      assigneeBotId: assigneeBotId,
      title: "Same invocation",
      description: "Create once.",
      acceptanceCriteria: "One child.",
      priority: "NORMAL",
    };
    const invocationId = await prepareInvocation(parent.parentRunId, args);
    const deps = { prisma, jobs: fakeJobs() };
    const first = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: args.title,
      description: args.description,
      acceptanceCriteria: args.acceptanceCriteria,
      priority: args.priority,
      toolInvocationId: invocationId,
    });
    const second = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: args.title,
      description: args.description,
      acceptanceCriteria: args.acceptanceCriteria,
      priority: args.priority,
      toolInvocationId: invocationId,
    });
    expect(second.id).toBe(first.id);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
    const delegations = await prisma.workforceDelegation.findMany({
      where: { parentTaskId: parent.task.id },
    });
    expect(delegations).toHaveLength(1);
    expect(delegations[0]).toMatchObject({
      toolInvocationId: invocationId,
      childTaskId: first.id,
    });
    expect(delegations[0]!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await getWorkforceTaskView(prisma, spaceId, parent.task.id)).toMatchObject({
      executionStatus: "WAITING_FOR_CHILDREN",
      waitingForChildren: true,
    });
  });

  itPostgres("rejects the same invocation with different business arguments", async () => {
    const parent = await createParent();
    const firstArgs = {
      assigneeBotId,
      title: "Original title",
      description: "Original body.",
      acceptanceCriteria: "Original criteria.",
      priority: "NORMAL",
    };
    const invocationId = await prepareInvocation(parent.parentRunId, firstArgs);
    const deps = { prisma, jobs: fakeJobs() };
    await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: firstArgs.title,
      description: firstArgs.description,
      acceptanceCriteria: firstArgs.acceptanceCriteria,
      priority: firstArgs.priority,
      toolInvocationId: invocationId,
    });
    await expect(
      delegateWorkforceTask(deps, {
        spaceId,
        parentRunId: parent.parentRunId,
        delegatorBotId,
        userId,
        assigneeBotId,
        title: "Changed title",
        description: firstArgs.description,
        acceptanceCriteria: firstArgs.acceptanceCriteria,
        priority: firstArgs.priority,
        toolInvocationId: invocationId,
      }),
    ).rejects.toThrow("different business arguments");
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
    expect(
      await prisma.workforceDelegation.count({ where: { parentTaskId: parent.task.id } }),
    ).toBe(1);
  });

  itPostgres("creates different children for different invocation ids", async () => {
    const parent = await createParent();
    const deps = { prisma, jobs: fakeJobs() };
    const firstInvocation = await prepareInvocation(parent.parentRunId, { title: "one" });
    const secondInvocation = await prepareInvocation(parent.parentRunId, { title: "two" });
    const first = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: "First child",
      description: "",
      acceptanceCriteria: "One.",
      priority: "NORMAL",
      toolInvocationId: firstInvocation,
    });
    const second = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId: otherAssigneeBotId,
      title: "Second child",
      description: "",
      acceptanceCriteria: "Two.",
      priority: "HIGH",
      toolInvocationId: secondInvocation,
    });
    expect(second.id).not.toBe(first.id);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(2);
    expect(
      await prisma.workforceDelegation.count({ where: { parentTaskId: parent.task.id } }),
    ).toBe(2);
  });

  itPostgres("returns the original child when the invocation result was not written", async () => {
    const parent = await createParent();
    const args = {
      assigneeBotId,
      title: "Result lost",
      description: "",
      acceptanceCriteria: "Still one child.",
      priority: "NORMAL",
    };
    const invocationId = await prepareInvocation(parent.parentRunId, args);
    const deps = { prisma, jobs: fakeJobs() };
    const first = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: args.title,
      description: args.description,
      acceptanceCriteria: args.acceptanceCriteria,
      priority: args.priority,
      toolInvocationId: invocationId,
    });
    await prisma.toolInvocation.update({
      where: {
        spaceId_invocationId: { spaceId, invocationId },
      },
      data: { status: "EXECUTING", executionStage: "HANDLER_STARTED" },
    });
    const replay = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: args.title,
      description: args.description,
      acceptanceCriteria: args.acceptanceCriteria,
      priority: args.priority,
      toolInvocationId: invocationId,
    });
    expect(replay.id).toBe(first.id);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
  });

  itPostgres(
    "recovers the original child and invocation result from a committed delegation",
    async () => {
      const parent = await createParent();
      const args = {
        assigneeBotId,
        title: "Recovered result",
        description: "",
        acceptanceCriteria: "Original child is returned.",
        priority: "NORMAL",
      };
      const invocationId = await prepareInvocation(parent.parentRunId, args);
      const deps = { prisma, jobs: fakeJobs() };
      const child = await delegateWorkforceTask(deps, {
        spaceId,
        parentRunId: parent.parentRunId,
        delegatorBotId,
        userId,
        assigneeBotId,
        title: args.title,
        description: args.description,
        acceptanceCriteria: args.acceptanceCriteria,
        priority: args.priority,
        toolInvocationId: invocationId,
      });
      await prisma.toolInvocation.update({
        where: { spaceId_invocationId: { spaceId, invocationId } },
        data: { status: "UNCERTAIN", executionStage: "UNCERTAIN" },
      });
      const recovered = await recoverDelegatedTaskForInvocation(prisma, {
        spaceId,
        invocationId,
        args,
      });
      expect(recovered?.id).toBe(child.id);
      await expect(
        recoverDelegatedTaskForInvocation(prisma, {
          spaceId,
          invocationId,
          args: { ...args, title: "Different" },
        }),
      ).rejects.toThrow("different business arguments");
      const result = {
        taskId: child.id,
        assigneeBotId: child.assigneeBotId,
        assigneeBotName: child.assigneeBotName,
        status: child.executionStatus,
      };
      await recoverToolInvocationResult(prisma, {
        spaceId,
        invocationId,
        result,
        secrets: [],
      });
      const invocation = await prisma.toolInvocation.findUniqueOrThrow({
        where: { spaceId_invocationId: { spaceId, invocationId } },
      });
      expect(invocation.status).toBe("SUCCEEDED");
      expect(invocation.result).toMatchObject(result);
      expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
    },
  );

  itPostgres("rewinds an uncommitted delegation handler for a safe replay", async () => {
    const parent = await createParent();
    const args = {
      assigneeBotId,
      title: "Safe replay",
      description: "",
      acceptanceCriteria: "Creates one child.",
      priority: "NORMAL",
    };
    const invocationId = await prepareInvocation(parent.parentRunId, args);
    await prisma.toolInvocation.update({
      where: { spaceId_invocationId: { spaceId, invocationId } },
      data: { status: "EXECUTING", executionStage: "HANDLER_STARTED" },
    });
    await expect(rewindToolInvocationForSafeRetry(prisma, { spaceId, invocationId })).resolves.toBe(
      true,
    );
    const row = await prisma.toolInvocation.findUniqueOrThrow({
      where: { spaceId_invocationId: { spaceId, invocationId } },
    });
    expect(row).toMatchObject({ status: "RECEIVED", executionStage: "RECEIVED" });
    const child = await delegateWorkforceTask(
      { prisma, jobs: fakeJobs() },
      {
        spaceId,
        parentRunId: parent.parentRunId,
        delegatorBotId,
        userId,
        assigneeBotId,
        title: args.title,
        description: args.description,
        acceptanceCriteria: args.acceptanceCriteria,
        priority: args.priority,
        toolInvocationId: invocationId,
      },
    );
    expect(child.parentTaskId).toBe(parent.task.id);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
  });

  itPostgres("serializes two workers using the same invocation", async () => {
    const parent = await createParent();
    const args = {
      assigneeBotId,
      title: "Concurrent same invocation",
      description: "",
      acceptanceCriteria: "One child.",
      priority: "NORMAL",
    };
    const invocationId = await prepareInvocation(parent.parentRunId, args);
    const run = (client: PrismaClient) =>
      runAsSystem("delegation concurrent worker", () =>
        delegateWorkforceTask(
          { prisma: client, jobs: fakeJobs() },
          {
            spaceId,
            parentRunId: parent.parentRunId,
            delegatorBotId,
            userId,
            assigneeBotId,
            title: args.title,
            description: args.description,
            acceptanceCriteria: args.acceptanceCriteria,
            priority: args.priority,
            toolInvocationId: invocationId,
          },
        ),
      );
    const [first, second] = await Promise.all([run(prisma), run(secondPrisma)]);
    expect(first.id).toBe(second.id);
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(1);
    expect(
      await prisma.workforceDelegation.count({ where: { parentTaskId: parent.task.id } }),
    ).toBe(1);
  });

  itPostgres("does not create a child from an uncertain invocation", async () => {
    const parent = await createParent();
    const invocationId = await prepareInvocation(parent.parentRunId, { title: "uncertain" });
    await prisma.toolInvocation.update({
      where: { spaceId_invocationId: { spaceId, invocationId } },
      data: { status: "UNCERTAIN", executionStage: "UNCERTAIN" },
    });
    await expect(
      delegateWorkforceTask(
        { prisma, jobs: fakeJobs() },
        {
          spaceId,
          parentRunId: parent.parentRunId,
          delegatorBotId,
          userId,
          assigneeBotId,
          title: "Must not exist",
          description: "",
          acceptanceCriteria: "No child.",
          priority: "NORMAL",
          toolInvocationId: invocationId,
        },
      ),
    ).rejects.toThrow("uncertain");
    expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(0);
  });

  itPostgres("enqueues the child worker only after the delegation commit", async () => {
    const parent = await createParent();
    const enqueueObserved: number[] = [];
    const jobs = {
      enqueue: vi.fn(async () => {
        enqueueObserved.push(
          await prisma.workforceDelegation.count({ where: { parentTaskId: parent.task.id } }),
        );
        return undefined;
      }),
      cancel: vi.fn(async () => undefined),
    } as unknown as JobPublisher;
    await delegateWorkforceTask(
      { prisma, jobs },
      {
        spaceId,
        parentRunId: parent.parentRunId,
        delegatorBotId,
        userId,
        assigneeBotId,
        title: "Enqueue after commit",
        description: "",
        acceptanceCriteria: "Committed first.",
        priority: "NORMAL",
      },
    );
    expect(enqueueObserved.length).toBeGreaterThanOrEqual(1);
    expect(enqueueObserved.every((count) => count === 1)).toBe(true);
  });

  itPostgres("keeps historical delegations without invocation ids compatible", async () => {
    const parent = await createParent();
    const deps = { prisma, jobs: fakeJobs() };
    const first = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId,
      title: "Historical delegation",
      description: "",
      acceptanceCriteria: "Compatible.",
      priority: "NORMAL",
    });
    const second = await delegateWorkforceTask(deps, {
      spaceId,
      parentRunId: parent.parentRunId,
      delegatorBotId,
      userId,
      assigneeBotId: otherAssigneeBotId,
      title: "Historical delegation two",
      description: "",
      acceptanceCriteria: "Compatible.",
      priority: "NORMAL",
    });
    expect(first.id).not.toBe(second.id);
    const delegations = await prisma.workforceDelegation.findMany({
      where: { parentTaskId: parent.task.id },
    });
    expect(delegations).toHaveLength(2);
    expect(delegations.every((delegation) => delegation.toolInvocationId === null)).toBe(true);
    expect(delegations.every((delegation) => delegation.requestDigest !== null)).toBe(true);
  });

  it.each(["workforceTask", "task", "run", "workforceDelegation"] as const)(
    "rolls back the whole delegation when %s creation fails",
    async (failOn) =>
      runAsSystem("delegation rollback test", async () => {
        const parent = await createParent();
        const beforeTasks = await prisma.task.count({ where: { botId: assigneeBotId } });
        const beforeRuns = await prisma.run.count({ where: { botId: assigneeBotId } });
        const failing = failingTransactionPrisma(prisma, failOn);
        const jobs = fakeJobs();
        await expect(
          delegateWorkforceTask(
            { prisma: failing, jobs },
            {
              spaceId,
              parentRunId: parent.parentRunId,
              delegatorBotId,
              userId,
              assigneeBotId,
              title: `Rollback ${failOn}`,
              description: "",
              acceptanceCriteria: "Rolled back.",
              priority: "NORMAL",
            },
          ),
        ).rejects.toThrow("injected");
        expect(await prisma.workforceTask.count({ where: { parentTaskId: parent.task.id } })).toBe(
          0,
        );
        expect(
          await prisma.workforceDelegation.count({ where: { parentTaskId: parent.task.id } }),
        ).toBe(0);
        expect(await prisma.task.count({ where: { botId: assigneeBotId } })).toBe(beforeTasks);
        expect(await prisma.run.count({ where: { botId: assigneeBotId } })).toBe(beforeRuns);
        expect(jobs.enqueue).not.toHaveBeenCalled();
        expect(await getWorkforceTaskView(prisma, spaceId, parent.task.id)).toMatchObject({
          executionStatus: "IN_PROGRESS",
          waitingForChildren: false,
        });
      }),
  );
});
