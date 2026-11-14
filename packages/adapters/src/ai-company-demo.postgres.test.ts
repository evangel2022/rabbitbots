import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDemoStatus, launchAiCompanyDemo } from "./ai-company-demo.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("Launch Demo (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let otherActor: Actor;

  beforeAll(() =>
    runAsSystem("Launch Demo setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const userId = `d-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Demo CEO",
          email: `demo-${stamp}@example.com`,
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
      actor = { userId, spaceId, email: `demo-${stamp}@example.com`, isDeploymentOwner: false };

      const otherUserId = `do-${stamp}`;
      await prisma.user.create({
        data: {
          id: otherUserId,
          name: "Other CEO",
          email: `demo-other-${stamp}@example.com`,
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
        email: `demo-other-${stamp}@example.com`,
        isDeploymentOwner: false,
      };
    }),
  );

  afterAll(async () => close?.());

  const itDemo = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("Launch Demo test", fn));

  itDemo(
    "creates four employees and one draft GitHub launch meeting without tasks or runs",
    async () => {
      const repos = createRepos(prisma);
      const before = await getDemoStatus(prisma, actor.spaceId);
      expect(before).toMatchObject({
        created: false,
        companyCreated: false,
        bots: [],
        meetingId: null,
      });

      const custom = await repos.createBot(actor, {
        name: "My custom Bot",
        description: "Keep me.",
        instructions: "Do not replace me.",
        notifyOnFinish: true,
        spawnKey: "custom:demo-keep",
      });

      const launched = await launchAiCompanyDemo(prisma, repos, actor);
      expect(launched.created).toBe(true);
      expect(launched.companyCreated).toBe(true);
      expect(launched.meetingTitle).toBe(
        "Launch RabbitBots on GitHub — AI Company Launch Strategy",
      );
      expect(launched.meetingStatus).toBe("DRAFT");
      expect(launched.bots.map((bot) => bot.name).sort()).toEqual([
        "CEO Assistant",
        "Finance Bot",
        "Operations Bot",
        "Research Bot",
      ]);
      expect(launched.meetingId).toBeTruthy();

      const meeting = await prisma.meeting.findUniqueOrThrow({
        where: { id: launched.meetingId! },
        include: { agenda: true, participants: true, humanParticipants: true },
      });
      expect(meeting.title).toBe("Launch RabbitBots on GitHub — AI Company Launch Strategy");
      expect(meeting.description).toContain("RabbitBots demo");
      expect(meeting.description).toContain("FACT:");
      expect(meeting.description).toContain("ASSUMPTION:");
      expect(meeting.description).toContain("OPEN QUESTION:");
      expect(meeting.agenda.map((item) => item.title)).toEqual([
        "Product Positioning and Developer Audience",
        "GitHub Launch Plan and Execution",
      ]);
      expect(meeting.participants).toHaveLength(4);
      expect(meeting.humanParticipants).toHaveLength(1);
      expect(meeting.participants.find((item) => item.botId === meeting.chairBotId)?.role).toBe(
        "Chairperson",
      );
      expect(await prisma.workforceTask.count({ where: { spaceId: actor.spaceId } })).toBe(0);
      expect(await prisma.task.count({ where: { spaceId: actor.spaceId } })).toBe(0);
      expect(await prisma.run.count({ where: { spaceId: actor.spaceId } })).toBe(0);
      expect(await prisma.bot.findUnique({ where: { id: custom.id } })).not.toBeNull();
    },
  );

  itDemo("is idempotent and does not duplicate the meeting", async () => {
    const repos = createRepos(prisma);
    const before = await getDemoStatus(prisma, actor.spaceId);
    const again = await launchAiCompanyDemo(prisma, repos, actor);
    expect(again.meetingId).toBe(before.meetingId);
    expect(
      await prisma.meeting.count({
        where: {
          spaceId: actor.spaceId,
          title: "Launch RabbitBots on GitHub — AI Company Launch Strategy",
        },
      }),
    ).toBe(1);
    expect(await prisma.meeting.count({ where: { spaceId: actor.spaceId } })).toBe(1);
    expect(
      await prisma.meeting.count({
        where: { spaceId: actor.spaceId, title: "First AI Company Strategy Meeting" },
      }),
    ).toBe(0);
  });

  itDemo("does not expose another Space's demo", async () => {
    const status = await getDemoStatus(prisma, otherActor.spaceId);
    expect(status).toMatchObject({ created: false, companyCreated: false, bots: [] });
  });
});
