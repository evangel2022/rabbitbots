import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { advanceMeeting, createMeeting, getMeetingView, startMeeting } from "./meetings.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("meetings per-agenda (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  const bots: Array<{ id: string; threadId: string; name: string }> = [];
  let jobs: JobPublisher & { enqueue: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

  beforeAll(() =>
    runAsSystem("agenda test setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `agenda-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Agenda Test",
          email: `agenda-${stamp}@example.com`,
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
        email: `agenda-${stamp}@example.com`,
        isDeploymentOwner: false,
      });
      for (const [name, key] of [
        ["CEO Assistant", "rabbitbots:ceo"],
        ["Research Bot", "rabbitbots:research"],
        ["Finance Bot", "rabbitbots:finance"],
      ] as const) {
        const bot = await repos.createBot(actor(), {
          name,
          description: name,
          instructions: "",
          notifyOnFinish: true,
          spawnKey: key,
        });
        bots.push({ id: bot.id, threadId: bot.threadId ?? "", name: bot.name });
      }
      jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as typeof jobs;
    }),
  );

  afterAll(() =>
    runAsSystem("agenda test cleanup", async () => {
      if (prisma) {
        await prisma.meeting.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  const postgresIt = (name: string, fn: () => Promise<void>) =>
    it(name, () => runAsSystem("per-agenda meeting test", fn));

  const bot = (id: string) => bots.find((candidate) => candidate.id === id)!;

  async function completeRun(runId: string, botId: string, text: string) {
    const threadId = bot(botId).threadId;
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    const max = await prisma.message.aggregate({ where: { threadId }, _max: { seq: true } });
    await prisma.message.create({
      data: {
        threadId,
        seq: (max._max.seq ?? 0) + 1,
        role: "bot",
        botId,
        runId,
        blocks: [{ kind: "text", text }],
      },
    });
  }

  async function completeTurn(meetingId: string, phase: string, agendaId: string, text: string) {
    const turn = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, phase, agendaId },
      orderBy: { createdAt: "desc" },
    });
    expect(turn.runId).toBeTruthy();
    await completeRun(turn.runId!, turn.participantBotId, text);
  }

  async function completeCurrentAgendaDecision(
    meetingId: string,
    agendaId: string,
    decisionType: string,
    decisionText: string,
  ) {
    const turn = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, agendaId, phase: "AGENDA_DECISION" },
      orderBy: { createdAt: "desc" },
    });
    await completeRun(
      turn.runId!,
      turn.participantBotId,
      JSON.stringify({
        decisionType,
        decisionText,
        rationale: `Evidence-specific rationale for ${decisionText}.`,
        supportingEvidence: ["https://example.com/source"],
        risks: ["Evidence remains incomplete."],
        dissentingOpinions: decisionType === "DEFERRED" ? ["The panel would defer."] : [],
        conditions: decisionType === "APPROVED_WITH_CONDITIONS" ? ["Obtain audited ARR."] : [],
      }),
    );
  }

  const review = (material: boolean, question = "") =>
    JSON.stringify({
      materialDisagreement: material,
      reason: material ? "The reports conflict on a material point." : "No material disagreement.",
      question,
      participants: material ? ["Research", "Finance"] : [],
    });

  postgresIt("completes two independent agenda decisions and one final summary", async () => {
    const meetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Per-agenda boardroom",
      description: "Independent agenda decisions.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((candidate) => candidate.id),
      agenda: [
        { title: "Market opportunity", description: "", timeLimitSeconds: 300 },
        { title: "Competitive position", description: "", timeLimitSeconds: 300 },
      ],
    });
    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      include: { agenda: { orderBy: { sequence: "asc" } } },
    });
    const [firstAgenda, secondAgenda] = meeting.agenda;

    await startMeeting({ prisma, jobs }, { spaceId, meetingId });
    await advanceMeeting({ prisma, jobs }, meetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, phase: "OPENING" },
    });
    await completeRun(opening.runId!, bots[0]!.id, "The chair opens the meeting.");
    await advanceMeeting({ prisma, jobs }, meetingId);

    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId, phase: "REPORTING" },
    });
    for (const report of reports) {
      await completeRun(
        report.runId!,
        report.participantBotId,
        "Risk: material uncertainty and conflicting evidence at https://example.com/report; however the conclusion is contested.",
      );
    }
    await advanceMeeting({ prisma, jobs }, meetingId);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })).status).toBe(
      "DISCUSSION",
    );

    const firstReview = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, agendaId: firstAgenda!.id, phase: "AGENDA_REVIEW" },
    });
    await completeRun(
      firstReview.runId!,
      bots[0]!.id,
      review(true, "Which new evidence changes the market conclusion?"),
    );
    await advanceMeeting({ prisma, jobs }, meetingId);

    const firstResponses = await prisma.meetingTurn.findMany({
      where: { meetingId, agendaId: firstAgenda!.id, phase: "AGENDA_RESPONSE" },
    });
    expect(firstResponses).toHaveLength(2);
    for (const response of firstResponses) {
      await completeRun(
        response.runId!,
        response.participantBotId,
        "New evidence: the audited figure contradicts the earlier claim; risk remains.",
      );
    }
    await advanceMeeting({ prisma, jobs }, meetingId);
    await completeTurn(
      meetingId,
      "AGENDA_EVALUATION",
      firstAgenda!.id,
      JSON.stringify({
        needsAnotherRound: false,
        reason: "The new evidence resolves the material point.",
        newEvidence: ["audited figure"],
        question: null,
      }),
    );
    await advanceMeeting({ prisma, jobs }, meetingId);
    await completeCurrentAgendaDecision(
      meetingId,
      firstAgenda!.id,
      "APPROVED_WITH_CONDITIONS",
      "Proceed to bounded diligence.",
    );
    await advanceMeeting({ prisma, jobs }, meetingId);

    const secondReview = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, agendaId: secondAgenda!.id, phase: "AGENDA_REVIEW" },
    });
    await completeRun(secondReview.runId!, bots[0]!.id, review(false));
    await advanceMeeting({ prisma, jobs }, meetingId);
    expect(
      await prisma.meetingTurn.count({
        where: { meetingId, agendaId: secondAgenda!.id, phase: "AGENDA_RESPONSE" },
      }),
    ).toBe(0);
    await completeCurrentAgendaDecision(
      meetingId,
      secondAgenda!.id,
      "DEFERRED",
      "Defer competitive conclusion.",
    );
    await advanceMeeting({ prisma, jobs }, meetingId);

    const summaryTurn = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, phase: "SUMMARY" },
    });
    await completeRun(
      summaryTurn.runId!,
      bots[0]!.id,
      JSON.stringify({
        summary: "Two agenda decisions were persisted; one is conditional and one is deferred.",
        minutes: "Agenda one was discussed; agenda two required no discussion.",
        actionItems: [
          {
            title: "Collect audited ARR",
            description: "Request the data-room figure.",
            assigneeRole: "Finance",
            agendaSequence: 1,
            dueAt: null,
          },
        ],
      }),
    );
    await advanceMeeting({ prisma, jobs }, meetingId);

    const view = await getMeetingView(prisma, spaceId, meetingId);
    expect(view?.status).toBe("COMPLETED");
    expect(view?.decisions).toHaveLength(2);
    expect(view?.decisions[0]?.agendaId).toBe(firstAgenda!.id);
    expect(view?.decisions[0]?.decisionType).toBe("APPROVED_WITH_CONDITIONS");
    expect(view?.decisions[0]?.approvalStatus).toBe("PENDING");
    expect(view?.decisions[1]?.agendaId).toBe(secondAgenda!.id);
    expect(view?.decisions[1]?.decisionType).toBe("DEFERRED");
    expect(view?.turns.filter((turn) => turn.phase === "AGENDA_REVIEW")).toHaveLength(2);
    expect(view?.actionItems).toHaveLength(1);
    expect(view?.meetingSummary).toContain("Two agenda decisions");
  });
});
