import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_COMPANY_ROLES, createAiCompany, getAiCompanyStatus } from "./workforce-company.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("Create AI Company (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let otherActor: Actor;
  let retryActor: Actor;
  let profileActor: Actor;

  beforeAll(() =>
    runAsSystem("Create AI Company setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const userId = `c-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "AI Company CEO",
          email: `ai-company-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      const spaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: userId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      actor = {
        userId,
        spaceId,
        email: `ai-company-${stamp}@example.com`,
        isDeploymentOwner: false,
      };

      const otherUserId = `o-${stamp}`;
      await prisma.user.create({
        data: {
          id: otherUserId,
          name: "Other CEO",
          email: `ai-company-other-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      const otherSpaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: otherUserId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      otherActor = {
        userId: otherUserId,
        spaceId: otherSpaceId,
        email: `ai-company-other-${stamp}@example.com`,
        isDeploymentOwner: false,
      };

      const retryUserId = `r-${stamp}`;
      await prisma.user.create({
        data: {
          id: retryUserId,
          name: "Retry CEO",
          email: `ai-company-retry-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      const retrySpaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: retryUserId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      retryActor = {
        userId: retryUserId,
        spaceId: retrySpaceId,
        email: `ai-company-retry-${stamp}@example.com`,
        isDeploymentOwner: false,
      };

      const profileUserId = `p-${stamp}`;
      await prisma.user.create({
        data: {
          id: profileUserId,
          name: "Profile CEO",
          email: `ai-company-profile-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      const profileSpaceId = (
        await bootstrapUserSpace(
          prisma,
          { id: profileUserId },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        )
      ).spaceId;
      profileActor = {
        userId: profileUserId,
        spaceId: profileSpaceId,
        email: `ai-company-profile-${stamp}@example.com`,
        isDeploymentOwner: false,
      };
    }),
  );

  afterAll(async () => close?.());

  const itCompany = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("Create AI Company test", fn));

  itCompany(
    "creates four employees and a draft boardroom meeting without executing work",
    async () => {
      const repos = createRepos(prisma);
      const status = await createAiCompany(prisma, repos, actor);
      expect(status.created).toBe(true);
      expect(status.bots.map((bot) => bot.roleKey).sort()).toEqual(
        AI_COMPANY_ROLES.map((role) => role.key).sort(),
      );
      expect(status.bots.map((bot) => bot.name).sort()).toEqual([
        "CEO Assistant",
        "Finance Bot",
        "Operations Bot",
        "Research Bot",
      ]);
      expect(status.meetingId).toBeTruthy();

      const bots = await prisma.bot.findMany({
        where: { spaceId: actor.spaceId, spawnKey: { startsWith: "rabbitbots:ai-company:" } },
        include: { thread: true },
      });
      expect(bots).toHaveLength(4);
      expect(bots.every((bot) => bot.thread?.id)).toBe(true);

      const meeting = await prisma.meeting.findUniqueOrThrow({
        where: { id: status.meetingId! },
        include: { agenda: true, participants: true, humanParticipants: true },
      });
      expect(meeting.status).toBe("DRAFT");
      expect(meeting.title).toBe("First AI Company Strategy Meeting");
      expect(meeting.agenda).toHaveLength(5);
      expect(meeting.participants).toHaveLength(4);
      expect(
        meeting.participants.find((participant) => participant.botId === meeting.chairBotId)?.role,
      ).toBe("Chairperson");
      expect(meeting.humanParticipants).toHaveLength(1);
      expect(await prisma.task.count({ where: { spaceId: actor.spaceId } })).toBe(0);
      expect(await prisma.run.count({ where: { spaceId: actor.spaceId } })).toBe(0);
      expect(await prisma.workforceTask.count({ where: { spaceId: actor.spaceId } })).toBe(0);
    },
  );

  itCompany("is idempotent for repeated clicks and preserves custom bots", async () => {
    const repos = createRepos(prisma);
    const custom = await repos.createBot(actor, {
      name: "My existing custom Bot",
      description: "Keep me.",
      instructions: "Do not replace me.",
      notifyOnFinish: true,
      spawnKey: "custom:keep-me",
    });
    const first = await createAiCompany(prisma, repos, actor);
    const second = await createAiCompany(prisma, repos, actor);
    const companyBots = await prisma.bot.count({
      where: { spaceId: actor.spaceId, spawnKey: { startsWith: "rabbitbots:ai-company:" } },
    });
    expect(companyBots).toBe(4);
    expect(second.bots.map((bot) => bot.id)).toEqual(first.bots.map((bot) => bot.id));
    expect(second.meetingId).toBe(first.meetingId);
    expect(await prisma.bot.findUnique({ where: { id: custom.id } })).not.toBeNull();
    expect(await prisma.meeting.count({ where: { spaceId: actor.spaceId } })).toBe(1);
  });

  itCompany(
    "serializes concurrent creates and fills a partially created company on retry",
    async () => {
      const repos = createRepos(prisma);
      const [first, second] = await Promise.all([
        createAiCompany(prisma, repos, actor),
        createAiCompany(prisma, repos, actor),
      ]);
      expect(first.bots).toHaveLength(4);
      expect(second.bots).toHaveLength(4);
      expect(new Set([...first.bots, ...second.bots].map((bot) => bot.id)).size).toBe(4);
      expect(await prisma.meeting.count({ where: { spaceId: actor.spaceId } })).toBe(1);

      await prisma.bot.update({
        where: { id: first.bots.find((bot) => bot.roleKey === "operations")!.id },
        data: { archivedAt: new Date() },
      });
      const retried = await createAiCompany(prisma, repos, actor);
      expect(retried.bots).toHaveLength(4);
      expect(retried.created).toBe(true);
      expect(await prisma.meeting.count({ where: { spaceId: actor.spaceId } })).toBe(1);
    },
  );

  itCompany(
    "resumes after a partial create failure without duplicating successful bots",
    async () => {
      const repos = createRepos(prisma);
      let failed = false;
      const failingRepos = new Proxy(repos, {
        get(target, property, receiver) {
          if (property === "createBot") {
            return async (actor: Actor, input: Parameters<typeof repos.createBot>[1]) => {
              if (input.name === "Finance Bot" && !failed) {
                failed = true;
                throw new Error("simulated create failure");
              }
              return target.createBot(actor, input);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(
        createAiCompany(prisma, failingRepos as typeof repos, retryActor),
      ).rejects.toThrow("simulated create failure");
      const partial = await prisma.bot.findMany({
        where: { spaceId: retryActor.spaceId, spawnKey: { startsWith: "rabbitbots:ai-company:" } },
        select: { name: true },
      });
      expect(partial.map((bot) => bot.name)).toEqual(["CEO Assistant", "Research Bot"]);

      const retried = await createAiCompany(prisma, repos, retryActor);
      expect(retried.bots).toHaveLength(4);
      expect(retried.created).toBe(true);
      expect(
        await prisma.bot.count({
          where: {
            spaceId: retryActor.spaceId,
            spawnKey: { startsWith: "rabbitbots:ai-company:" },
          },
        }),
      ).toBe(4);
      expect(await prisma.meeting.count({ where: { spaceId: retryActor.spaceId } })).toBe(1);
    },
  );

  itCompany("saves the onboarding profile and customized employee names once", async () => {
    const repos = createRepos(prisma);
    const created = await createAiCompany(prisma, repos, profileActor, {
      name: "Acme AI",
      description: "A focused company.",
      roles: [
        { key: "ceo", name: "Nova", description: "Chairs the company." },
        { key: "research", name: "Scout", description: "Finds evidence." },
        { key: "finance", name: "Ledger", description: "Checks the numbers." },
        { key: "operations", name: "Runner", description: "Keeps work moving." },
      ],
    });
    expect(created.created).toBe(true);
    expect(created.name).toBe("Acme AI");
    expect(created.description).toBe("A focused company.");
    expect(created.bots.map((bot) => bot.name).sort()).toEqual([
      "Ledger",
      "Nova",
      "Runner",
      "Scout",
    ]);

    const repeated = await createAiCompany(prisma, repos, profileActor, {
      name: "Overwrite attempt",
    });
    expect(repeated.name).toBe("Acme AI");
    expect(repeated.description).toBe("A focused company.");
    expect(repeated.bots.map((bot) => bot.id)).toEqual(created.bots.map((bot) => bot.id));
    expect(
      await prisma.bot.count({
        where: {
          spaceId: profileActor.spaceId,
          spawnKey: { startsWith: "rabbitbots:ai-company:" },
        },
      }),
    ).toBe(4);
  });

  itCompany("does not expose another Space's company", async () => {
    expect(otherActor.spaceId).not.toBe(actor.spaceId);
    expect(await prisma.bot.count({ where: { spaceId: otherActor.spaceId } })).toBe(0);
    const status = await getAiCompanyStatus(prisma, otherActor.spaceId);
    expect(status.created).toBe(false);
    expect(status.bots).toHaveLength(0);
    const repos = createRepos(prisma);
    const other = await createAiCompany(prisma, repos, otherActor);
    expect(other.bots).toHaveLength(4);
    expect(await prisma.meeting.count({ where: { spaceId: otherActor.spaceId } })).toBe(1);
  });
});
