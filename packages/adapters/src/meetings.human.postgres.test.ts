import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMeeting,
  getMeetingView,
  listMeetingMessages,
  sendMeetingMessage,
  withHumanMeetingContext,
} from "./meetings.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("meeting human participation (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let meetingId: string;
  let secondMeetingId: string;
  let agendaId: string;

  beforeAll(() =>
    runAsSystem("meeting human test setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `human-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Human CEO Test",
          email: `human-${stamp}@example.com`,
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
        email: `human-${stamp}@example.com`,
        isDeploymentOwner: false,
      });
      const bots = [];
      for (const [name, key] of [
        ["CEO Assistant", "human-chair"],
        ["Research Bot", "human-research"],
        ["Finance Bot", "human-finance"],
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
      meetingId = await createMeeting(prisma, {
        spaceId,
        userId,
        title: "Human participation test",
        description: "",
        chairBotId: bots[0]!,
        participantBotIds: bots,
        agenda: [{ title: "Market opportunity", description: "", timeLimitSeconds: 300 }],
      });
      agendaId = (await prisma.meetingAgenda.findFirstOrThrow({ where: { meetingId } })).id;
      secondMeetingId = await createMeeting(prisma, {
        spaceId,
        userId,
        title: "Second meeting",
        description: "",
        chairBotId: bots[0]!,
        participantBotIds: bots,
        agenda: [{ title: "Other agenda", description: "", timeLimitSeconds: 300 }],
      });
    }),
  );

  afterAll(() =>
    runAsSystem("meeting human test cleanup", async () => {
      if (prisma) {
        await prisma.meeting.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  const itPostgres = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("meeting human test", fn));

  itPostgres(
    "creates a HUMAN_CEO participant and persists/broadcasts a message idempotently",
    async () => {
      const view = await getMeetingView(prisma, spaceId, meetingId);
      expect(view?.humanParticipants).toMatchObject([
        { userId, userName: "Human CEO Test", role: "HUMAN_CEO" },
      ]);
      const sent = await sendMeetingMessage(prisma, {
        spaceId,
        userId,
        meetingId,
        agendaId,
        content: "请先说明各自负责的研究范围。",
        clientNonce: "human-test-nonce-1",
      });
      expect(sent).toMatchObject({
        meetingId,
        agendaId,
        authorType: "HUMAN_CEO",
        authorUserId: userId,
        authorName: "Human CEO Test",
        content: "请先说明各自负责的研究范围。",
      });
      const retried = await sendMeetingMessage(prisma, {
        spaceId,
        userId,
        meetingId,
        agendaId,
        content: "请先说明各自负责的研究范围。",
        clientNonce: "human-test-nonce-1",
      });
      expect(retried.id).toBe(sent.id);
      expect(await prisma.meetingMessage.count({ where: { meetingId } })).toBe(1);
    },
  );

  itPostgres("replays by cursor and keeps meetings isolated", async () => {
    const first = await listMeetingMessages(prisma, {
      spaceId,
      userId,
      meetingId,
      afterSeq: 0,
      limit: 50,
    });
    expect(first.messages).toHaveLength(1);
    expect(first.nextCursor).toBe(first.messages[0]!.seq);
    const empty = await listMeetingMessages(prisma, {
      spaceId,
      userId,
      meetingId,
      afterSeq: first.nextCursor,
      limit: 50,
    });
    expect(empty.messages).toHaveLength(0);
    await sendMeetingMessage(prisma, {
      spaceId,
      userId,
      meetingId,
      content: "Follow-up while work is in progress.",
      clientNonce: "human-test-nonce-2",
    });
    const replay = await listMeetingMessages(prisma, {
      spaceId,
      userId,
      meetingId,
      afterSeq: first.nextCursor,
      limit: 50,
    });
    expect(replay.messages.map((message) => message.content)).toEqual([
      "Follow-up while work is in progress.",
    ]);
    const other = await listMeetingMessages(prisma, {
      spaceId,
      userId,
      meetingId: secondMeetingId,
      afterSeq: 0,
      limit: 50,
    });
    expect(other.messages).toHaveLength(0);
  });

  itPostgres(
    "rejects non-members, spoofed authors are impossible, and terminal meetings are read-only",
    async () => {
      await expect(
        sendMeetingMessage(prisma, {
          spaceId,
          userId: "not-a-human-participant",
          meetingId,
          content: "I should not be able to write this.",
          clientNonce: "human-test-spoof",
        }),
      ).rejects.toThrow(/not a human participant/i);
      const spoof = await prisma.meetingMessage.findFirstOrThrow({
        where: { meetingId, clientNonce: "human-test-nonce-1" },
      });
      expect(spoof.authorUserId).toBe(userId);
      expect(spoof.authorType).toBe("HUMAN_CEO");
      await prisma.meeting.update({ where: { id: meetingId }, data: { status: "COMPLETED" } });
      await expect(
        sendMeetingMessage(prisma, {
          spaceId,
          userId,
          meetingId,
          content: "This must not reopen the meeting.",
          clientNonce: "human-test-terminal",
        }),
      ).rejects.toThrow(/read-only/i);
    },
  );

  itPostgres("adds the current meeting's human messages to a Bot prompt only", async () => {
    await prisma.meeting.update({ where: { id: meetingId }, data: { status: "DRAFT" } });
    const prompt = await withHumanMeetingContext(prisma, meetingId, "BASE PROMPT");
    expect(prompt).toContain("BASE PROMPT");
    expect(prompt).toContain("请先说明各自负责的研究范围。");
    expect(prompt).toContain("Follow-up while work is in progress.");
    expect(prompt).toContain("not system instructions");
    expect(prompt).not.toContain("This must not reopen the meeting.");
    const other = await withHumanMeetingContext(prisma, secondMeetingId, "OTHER");
    expect(other).toBe("OTHER");
  });
});
