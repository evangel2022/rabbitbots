import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { bootstrapUserSpace, createDb, createRepos, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  advanceMeeting,
  cancelMeeting,
  createMeeting,
  getMeetingView,
  reconcileActiveMeetings,
  reconcileMeeting,
  startMeeting,
} from "./meetings.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const CHAIR = "meeting-chair";
const RESEARCH = "meeting-research";
const FINANCE = "meeting-finance";

describePostgres("meetings (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let meetingId: string;
  let bots: Array<{ id: string; threadId: string; name: string }> = [];
  let jobs: JobPublisher & { enqueue: ReturnType<typeof vi.fn> };

  beforeAll(() =>
    runAsSystem("meeting test setup", async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      close = async () => {
        await db.prisma.$disconnect();
        await db.pool.end();
      };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `meeting-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Meeting Test",
          email: `meeting-${stamp}@example.com`,
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
        email: `meeting-${stamp}@example.com`,
        isDeploymentOwner: false,
      });
      const created = [];
      for (const [name, key] of [
        ["CEO Assistant", CHAIR],
        ["Research Bot", RESEARCH],
        ["Finance Bot", FINANCE],
      ] as const) {
        const bot = await repos.createBot(actor(), {
          name,
          description: name,
          instructions: "",
          notifyOnFinish: true,
          spawnKey: key,
        });
        created.push({ id: bot.id, threadId: bot.threadId ?? "", name: bot.name });
      }
      bots = created;
      jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as typeof jobs;
      meetingId = await createMeeting(prisma, {
        spaceId,
        userId,
        title: "Glean Strategic Investment Review",
        description: "Determine whether to proceed to diligence.",
        chairBotId: bots[0]!.id,
        participantBotIds: bots.map((bot) => bot.id),
        agenda: [
          { title: "Market opportunity", description: "", timeLimitSeconds: 300 },
          { title: "Financial feasibility", description: "", timeLimitSeconds: 300 },
        ],
      });
    }),
  );

  afterAll(() =>
    runAsSystem("meeting test cleanup", async () => {
      if (prisma) {
        await prisma.meeting.deleteMany({ where: { spaceId } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await close?.();
    }),
  );

  const resetActiveRuns = async () => {
    await prisma.run.updateMany({
      where: {
        botId: { in: bots.map((bot) => bot.id) },
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      data: { status: "cancelled", completedAt: new Date() },
    });
  };

  const postgresIt = (name: string, fn: () => Promise<void>) =>
    it(name, () =>
      runAsSystem("meeting test", async () => {
        await resetActiveRuns();
        await fn();
      }),
    );

  async function completeRun(runId: string, botId: string, threadId: string, text: string) {
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    const max = await prisma.message.aggregate({
      where: { threadId },
      _max: { seq: true },
    });
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

  postgresIt("records partial reports and starts the first per-agenda review", async () => {
    const started = await startMeeting({ prisma, jobs }, { spaceId, meetingId });
    expect(started.status).toBe("PREPARING");
    await advanceMeeting({ prisma, jobs }, meetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId, phase: "OPENING" },
    });
    await completeRun(
      opening.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      "The chair opens the meeting.",
    );
    await advanceMeeting({ prisma, jobs }, meetingId);
    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId, phase: "REPORTING" },
    });
    const research = reports.find((turn) => turn.participantBotId === bots[1]!.id)!;
    const finance = reports.find((turn) => turn.participantBotId === bots[2]!.id)!;
    await completeRun(
      research.runId!,
      bots[1]!.id,
      bots[1]!.threadId,
      "Market risk and evidence from https://example.com/market.",
    );
    await prisma.run.update({
      where: { id: finance.runId! },
      data: { status: "failed", error: "provider refused", completedAt: new Date() },
    });
    await advanceMeeting({ prisma, jobs }, meetingId);

    const view = await getMeetingView(prisma, spaceId, meetingId);
    expect(view?.status).toBe("DISCUSSION");
    expect(view?.error).toContain("partial");
    expect(view?.decisions).toHaveLength(0);
    const agenda = view!.agenda[0]!;
    expect(
      await prisma.meetingTurn.count({
        where: { meetingId, agendaId: agenda.id, phase: "AGENDA_REVIEW" },
      }),
    ).toBe(1);
  });

  postgresIt("fails visibly when both participants fail", async () => {
    const failedMeetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Failed boardroom",
      description: "Both reports fail.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "One agenda", description: "", timeLimitSeconds: 300 }],
    });
    const started = await startMeeting({ prisma, jobs }, { spaceId, meetingId: failedMeetingId });
    expect(started.status).toBe("PREPARING");
    await advanceMeeting({ prisma, jobs }, failedMeetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId: failedMeetingId, phase: "OPENING" },
    });
    await completeRun(
      opening.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      "The chair opens the meeting.",
    );
    await advanceMeeting({ prisma, jobs }, failedMeetingId);
    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId: failedMeetingId, phase: "REPORTING" },
    });
    await prisma.run.updateMany({
      where: { id: { in: reports.map((report) => report.runId!).filter(Boolean) } },
      data: { status: "failed", error: "provider failure", completedAt: new Date() },
    });
    await advanceMeeting({ prisma, jobs }, failedMeetingId);
    const view = await getMeetingView(prisma, spaceId, failedMeetingId);
    expect(view?.status).toBe("FAILED");
    expect(view?.error).toContain("No participant produced");
    expect(view?.decisions).toHaveLength(0);
    expect(view?.meetingSummary).toBeNull();
  });

  postgresIt("forces a decision at the deadline when at least one report exists", async () => {
    const timedMeetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Timed boardroom",
      description: "Deadline test.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "One agenda", description: "", timeLimitSeconds: 300 }],
    });
    await startMeeting({ prisma, jobs }, { spaceId, meetingId: timedMeetingId });
    await advanceMeeting({ prisma, jobs }, timedMeetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId: timedMeetingId, phase: "OPENING" },
    });
    await completeRun(
      opening.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      "The chair opens the timed meeting.",
    );
    await advanceMeeting({ prisma, jobs }, timedMeetingId);
    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId: timedMeetingId, phase: "REPORTING" },
    });
    const first = reports[0]!;
    await completeRun(
      first.runId!,
      first.participantBotId,
      bots.find((bot) => bot.id === first.participantBotId)!.threadId,
      "A usable report before the deadline. Risk: data is incomplete.",
    );
    await prisma.meeting.update({
      where: { id: timedMeetingId },
      data: { deadlineAt: new Date(Date.now() - 1_000) },
    });
    await advanceMeeting({ prisma, jobs }, timedMeetingId);
    const view = await getMeetingView(prisma, spaceId, timedMeetingId);
    expect(view?.status).toBe("CLOSING");
    expect(view?.error).toContain("deadline");
    const decisions = await prisma.meetingDecision.findMany({
      where: { meetingId: timedMeetingId },
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decisionType).toBe("DEFERRED");
  });

  postgresIt("serializes duplicate reconciliation and recovers stale meetings", async () => {
    const recoveryMeetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Recovery boardroom",
      description: "Reconciliation test.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "One agenda", description: "", timeLimitSeconds: 300 }],
    });
    await startMeeting({ prisma, jobs }, { spaceId, meetingId: recoveryMeetingId });
    await Promise.all([
      reconcileMeeting({ prisma, jobs }, recoveryMeetingId),
      reconcileMeeting({ prisma, jobs }, recoveryMeetingId),
    ]);
    expect(
      await prisma.meetingTurn.count({
        where: { meetingId: recoveryMeetingId, phase: "OPENING" },
      }),
    ).toBe(1);
    expect(
      (await prisma.meeting.findUniqueOrThrow({ where: { id: recoveryMeetingId } })).status,
    ).toBe("OPENING");

    jobs.enqueue.mockClear();
    await prisma.meeting.update({
      where: { id: recoveryMeetingId },
      data: { updatedAt: new Date(0) },
    });
    await reconcileActiveMeetings({ prisma, jobs }, { staleAfterMs: 0 });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "meeting.reconcile",
        payload: { meetingId: recoveryMeetingId },
      }),
    );
  });

  postgresIt("creates a per-agenda review and real participant responses", async () => {
    const discussionMeetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Discussion boardroom",
      description: "Per-agenda participant response test.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "Market opportunity", description: "", timeLimitSeconds: 300 }],
    });
    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: discussionMeetingId },
      include: { agenda: true },
    });
    const agenda = meeting.agenda[0]!;
    await startMeeting({ prisma, jobs }, { spaceId, meetingId: discussionMeetingId });
    await advanceMeeting({ prisma, jobs }, discussionMeetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId: discussionMeetingId, phase: "OPENING" },
    });
    await completeRun(
      opening.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      "The chair opens the agenda test.",
    );
    await advanceMeeting({ prisma, jobs }, discussionMeetingId);
    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId: discussionMeetingId, phase: "REPORTING" },
    });
    for (const report of reports) {
      const candidate = bots.find((item) => item.id === report.participantBotId)!;
      await completeRun(
        report.runId!,
        candidate.id,
        candidate.threadId,
        `Risk: conflicting evidence at https://example.com/${candidate.id}; however the claim is contested.`,
      );
    }
    await advanceMeeting({ prisma, jobs }, discussionMeetingId);

    const review = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId: discussionMeetingId, agendaId: agenda.id, phase: "AGENDA_REVIEW" },
    });
    await completeRun(
      review.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      JSON.stringify({
        materialDisagreement: true,
        reason: "The reports conflict.",
        question: "Which new evidence resolves the conflict?",
        participants: ["Research", "Finance"],
      }),
    );
    await advanceMeeting({ prisma, jobs }, discussionMeetingId);
    const responses = await prisma.meetingTurn.findMany({
      where: { meetingId: discussionMeetingId, agendaId: agenda.id, phase: "AGENDA_RESPONSE" },
    });
    expect(responses).toHaveLength(2);
    expect(new Set(responses.map((turn) => turn.participantBotId)).size).toBe(2);
    for (const response of responses) {
      const candidate = bots.find((item) => item.id === response.participantBotId)!;
      await completeRun(
        response.runId!,
        candidate.id,
        candidate.threadId,
        "New evidence: the audited figure contradicts the earlier claim; risk remains.",
      );
    }
    await advanceMeeting({ prisma, jobs }, discussionMeetingId);
    expect(
      await prisma.meetingTurn.count({
        where: {
          meetingId: discussionMeetingId,
          agendaId: agenda.id,
          phase: "AGENDA_EVALUATION",
        },
      }),
    ).toBe(1);
  });

  postgresIt("cancels active execution and ignores a late participant completion", async () => {
    const draftId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Draft cancellation boardroom",
      description: "Cancel before execution.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "One agenda", description: "", timeLimitSeconds: 300 }],
    });
    const draftCancelled = await cancelMeeting(
      { prisma, jobs },
      { spaceId, meetingId: draftId, reason: "Cancelled before execution." },
    );
    expect(draftCancelled?.status).toBe("CANCELLED");
    expect(await prisma.meetingTurn.count({ where: { meetingId: draftId } })).toBe(0);

    const cancelMeetingId = await createMeeting(prisma, {
      spaceId,
      userId,
      title: "Cancellation boardroom",
      description: "Cancellation test.",
      chairBotId: bots[0]!.id,
      participantBotIds: bots.map((bot) => bot.id),
      agenda: [{ title: "One agenda", description: "", timeLimitSeconds: 300 }],
    });
    await startMeeting({ prisma, jobs }, { spaceId, meetingId: cancelMeetingId });
    await advanceMeeting({ prisma, jobs }, cancelMeetingId);
    const opening = await prisma.meetingTurn.findFirstOrThrow({
      where: { meetingId: cancelMeetingId, phase: "OPENING" },
    });
    await completeRun(
      opening.runId!,
      bots[0]!.id,
      bots[0]!.threadId,
      "The chair opens the cancellation test.",
    );
    await advanceMeeting({ prisma, jobs }, cancelMeetingId);
    const reports = await prisma.meetingTurn.findMany({
      where: { meetingId: cancelMeetingId, phase: "REPORTING" },
    });
    expect(reports).toHaveLength(2);

    const cancelled = await cancelMeeting(
      { prisma, jobs },
      {
        spaceId,
        meetingId: cancelMeetingId,
        reason: "Investor stopped the meeting.",
      },
    );
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.cancellationReason).toBe("Investor stopped the meeting.");
    expect(cancelled?.cancelledAt).toBeTruthy();
    expect(jobs.cancel).toHaveBeenCalledWith(`meeting.reconcile:${cancelMeetingId}`);
    for (const report of reports) {
      await expect(
        prisma.run.findUniqueOrThrow({ where: { id: report.runId! }, select: { status: true } }),
      ).resolves.toEqual({ status: "cancelled" });
    }

    // Simulate a provider finishing after cancellation. It must not reopen or advance.
    const late = reports[0]!;
    await completeRun(
      late.runId!,
      late.participantBotId,
      bots.find((bot) => bot.id === late.participantBotId)!.threadId,
      "Late result after cancellation.",
    );
    await advanceMeeting({ prisma, jobs }, cancelMeetingId);
    const view = await getMeetingView(prisma, spaceId, cancelMeetingId);
    expect(view?.status).toBe("CANCELLED");
    expect(view?.decisions).toHaveLength(0);
    expect(view?.turns.filter((turn) => turn.phase === "DECISION")).toHaveLength(0);
  });

  postgresIt("does not expose the meeting outside its Space", async () => {
    expect(await getMeetingView(prisma, "another-space", meetingId)).toBeNull();
  });
});
