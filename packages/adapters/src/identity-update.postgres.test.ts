import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimApprovedEffect } from "./approval-effect.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { updateOwnBotIdentityFromTool } from "./fleet-tools.js";
import type { OwnBotIdentityChange } from "./update-bot-patch.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("identity update atomicity and effect binding (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let actor: Actor;
  let userId: string;
  let spaceId: string;
  const notify = async () => undefined;
  const deps = () => ({ prisma: system, events: { notify } }) as never as ExecutorDeps;
  const thread = (bot: { threadId: string | null }) => {
    if (!bot.threadId) throw new Error("fixture bot has no thread");
    return bot.threadId;
  };

  beforeAll(async () => {
    await runAsSystem("identity update test setup", async () => {
      db = createDb(databaseUrl!);
      system = asSystem(db.prisma);
      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      userId = `identity-${stamp}`;
      await system.user.create({
        data: {
          id: userId,
          name: "Identity Test",
          email: `identity-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      spaceId = (
        await bootstrapUserSpace(
          system,
          { id: userId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      actor = { userId, spaceId, email: `identity-${stamp}@example.com`, isDeploymentOwner: false };
    });
  });

  afterAll(async () => {
    await runAsSystem("identity update test cleanup", async () => {
      await system.organization.deleteMany({ where: { id: spaceId } }).catch(() => undefined);
      await system.user.deleteMany({ where: { id: userId } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function newBot(name: string) {
    return createRepos(system).createBot(actor, {
      name,
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
  }

  async function newRun(botId: string, threadId: string, status = "running") {
    const task = await system.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "identity fixture", status },
    });
    return system.run.create({
      data: { spaceId, userId, botId, threadId, taskId: task.id, status, trigger: "user" },
    });
  }

  async function newEffect(
    runId: string,
    _botId: string,
    change: OwnBotIdentityChange,
    status = "executing",
  ) {
    return system.externalEffect.create({
      data: {
        spaceId,
        runId,
        kind: "update_bot",
        idempotencyKey: `identity-${randomUUID()}`,
        status,
        request: { identityUpdate: change },
      },
    });
  }

  function change(bot: { id: string; name: string }, name: string): OwnBotIdentityChange {
    return { botId: bot.id, beforeName: bot.name, beforeDescription: "", name };
  }

  it("lets exactly one of two concurrent writes based on one baseline win", async () => {
    const bot = await newBot("New");
    const threadId = thread(bot);
    const runA = await newRun(bot.id, threadId);
    const runB = await newRun(bot.id, threadId);
    const changeA = change(bot, "Short");
    const changeB = change(bot, "Other");
    const effectA = await newEffect(runA.id, bot.id, changeA);
    const effectB = await newEffect(runB.id, bot.id, changeB);

    const results = await Promise.all([
      updateOwnBotIdentityFromTool(
        deps(),
        { id: runA.id, spaceId },
        threadId,
        bot,
        changeA,
        effectA.id,
      ),
      updateOwnBotIdentityFromTool(
        deps(),
        { id: runB.id, spaceId },
        threadId,
        bot,
        changeB,
        effectB.id,
      ),
    ]);
    const winners = results.filter((result) => "ok" in result);
    const losers = results.filter((result) => "error" in result);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.error).toContain("changed before the approval was applied");

    const finalBot = await system.bot.findUniqueOrThrow({ where: { id: bot.id } });
    expect(["Short", "Other"]).toContain(finalBot.name);
    const events = await system.event.findMany({
      where: { threadId, type: "bot.updated", runId: { in: [runA.id, runB.id] } },
      select: { payload: true, runId: true },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { name?: string }).name).toBe(finalBot.name);
  });

  it("rolls back the Bot and event when the event append fails", async () => {
    const bot = await newBot("Rollback");
    const threadId = thread(bot);
    const cancelled = await newRun(bot.id, threadId, "cancelled");
    const proposal = change(bot, "ShouldNotApply");
    const effect = await newEffect(cancelled.id, bot.id, proposal);

    const result = await updateOwnBotIdentityFromTool(
      deps(),
      { id: cancelled.id, spaceId },
      threadId,
      bot,
      proposal,
      effect.id,
    );
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).name).toBe("Rollback");
    expect(
      await system.event.count({
        where: { threadId, type: "bot.updated", runId: cancelled.id },
      }),
    ).toBe(0);
  });

  it("allows only one of two concurrent claims of an approved effect", async () => {
    const bot = await newBot("Claim");
    const run = await newRun(bot.id, thread(bot));
    const effect = await newEffect(run.id, bot.id, change(bot, "Short"), "approved");
    const claims = await Promise.all([
      claimApprovedEffect(system, effect.id),
      claimApprovedEffect(system, effect.id),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    expect(
      (await system.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
    ).toBe("executing");
  });

  it("rejects an effect whose run or bot does not match the write context", async () => {
    const botA = await newBot("A");
    const botB = await newBot("B");
    const runA = await newRun(botA.id, thread(botA));
    const runB = await newRun(botB.id, thread(botB));
    const proposalA = change(botA, "Short");
    const effectA = await newEffect(runA.id, botA.id, proposalA);

    const runMismatch = await updateOwnBotIdentityFromTool(
      deps(),
      { id: runB.id, spaceId },
      thread(botA),
      botA,
      proposalA,
      effectA.id,
    );
    expect(runMismatch).toEqual(expect.objectContaining({ error: expect.any(String) }));

    const botMismatch = await updateOwnBotIdentityFromTool(
      deps(),
      { id: runA.id, spaceId },
      thread(botA),
      botB,
      { ...proposalA, botId: botB.id },
      effectA.id,
    );
    expect(botMismatch).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect((await system.bot.findUniqueOrThrow({ where: { id: botA.id } })).name).toBe("A");
    expect((await system.bot.findUniqueOrThrow({ where: { id: botB.id } })).name).toBe("B");
  });

  it.each(["denied", "completed", "uncertain", "expired"] as const)(
    "does not execute an identity effect in %s state",
    async (status) => {
      const bot = await newBot(`State-${status}`);
      const run = await newRun(bot.id, thread(bot));
      const proposal = change(bot, "ShouldNotApply");
      const effect = await newEffect(run.id, bot.id, proposal, status);
      const result = await updateOwnBotIdentityFromTool(
        deps(),
        { id: run.id, spaceId },
        thread(bot),
        bot,
        proposal,
        effect.id,
      );
      expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
      expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).name).toBe(
        `State-${status}`,
      );
      expect(
        await system.event.count({ where: { threadId: thread(bot), type: "bot.updated" } }),
      ).toBe(0);
    },
  );

  it("does not repeat a write when the same executing effect is called twice", async () => {
    const bot = await newBot("Repeat");
    const run = await newRun(bot.id, thread(bot));
    const proposal = change(bot, "Once");
    const effect = await newEffect(run.id, bot.id, proposal);
    const first = await updateOwnBotIdentityFromTool(
      deps(),
      { id: run.id, spaceId },
      thread(bot),
      bot,
      proposal,
      effect.id,
    );
    const second = await updateOwnBotIdentityFromTool(
      deps(),
      { id: run.id, spaceId },
      thread(bot),
      bot,
      proposal,
      effect.id,
    );
    expect(first).toEqual(expect.objectContaining({ ok: true }));
    expect(second).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect((await system.bot.findUniqueOrThrow({ where: { id: bot.id } })).name).toBe("Once");
    expect(
      await system.event.count({ where: { threadId: thread(bot), type: "bot.updated" } }),
    ).toBe(1);
  });
});
