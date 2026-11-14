import type { Actor, WorkforceDemoStatus } from "@rakazo/contracts";
import { AI_COMPANY_DEMO_AGENDA, AI_COMPANY_DEMO_MEETING_TITLE } from "@rakazo/contracts";
import type { createRepos, PrismaClient } from "@rakazo/db";
import { AI_COMPANY_ROLES, createAiCompany, getAiCompanyStatus } from "./workforce-company.js";

type Repos = ReturnType<typeof createRepos>;
export type DemoStatusBase = Omit<WorkforceDemoStatus, "modelReady">;

const DEMO_MARKER =
  "RabbitBots demo · GitHub launch strategy. Human CEO approval remains required.";
export const DEMO_CONTEXT = `FACT: RabbitBots is an open-source (Apache-2.0), self-hosted AI company workspace. Its current product surface includes four default AI employees, an Executive Boardroom with CEO approval, an AI Workforce with tasks, execution attempts, evidence and CEO acceptance, bounded autonomous delegation, and real computer/browser use by Bots. The workspace package version is 0.1.0 and the current checkout is based on commit 18ad7da; the uncommitted A1/A2/A3 work being demonstrated adds the RabbitBots brand, Create AI Company and this one-click demo. Repository sources include README.md, LICENSE, docs/getting-started.md and docs/run-execution.md. No verified public GitHub stars, downloads, user counts, revenue, market size or competitor metrics are present in this context; never invent them.
ASSUMPTION: The first launch audience is developers who want to build an AI company with open-source, self-hostable employees. A GitHub-first launch, with a public repository, README, demo and developer documentation, is the initial distribution hypothesis. The launch uses no paid promotion and is supported by existing maintainers; any spend or external publishing requires the human CEO.
OPEN QUESTION: Which developer segment has the strongest need; which channel produces qualified users; what support load follows; what trademark, licence or security claims need legal review; whether a hosted demo is affordable; and whether paid support is wanted.`;
const DEMO_DESCRIPTION = `${DEMO_MARKER}

${DEMO_CONTEXT}`;
const DEMO_SPAWN_PREFIX = "rabbitbots:ai-company:";

const DEMO_AGENDA_DESCRIPTIONS = [
  "Decide the developer-facing positioning and the audience assumptions that still need verification.",
  "Produce the GitHub launch plan, owners, evidence and the actions that need CEO approval.",
];

async function findDemoMeeting(prisma: PrismaClient, spaceId: string) {
  return prisma.meeting.findFirst({
    where: {
      spaceId,
      title: AI_COMPANY_DEMO_MEETING_TITLE,
      description: { startsWith: DEMO_MARKER },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true },
  });
}

export async function getDemoStatus(
  prisma: PrismaClient,
  spaceId: string,
): Promise<DemoStatusBase> {
  const [company, meeting] = await Promise.all([
    getAiCompanyStatus(prisma, spaceId),
    findDemoMeeting(prisma, spaceId),
  ]);
  return {
    created: meeting !== null,
    companyCreated: company.created,
    bots: company.bots,
    meetingId: meeting?.id ?? null,
    meetingTitle: AI_COMPANY_DEMO_MEETING_TITLE,
    meetingStatus: meeting?.status ?? null,
  };
}

/** Ensures the A2 company, then creates one draft GitHub launch meeting. Never starts or approves it. */
export async function launchAiCompanyDemo(
  prisma: PrismaClient,
  repos: Repos,
  actor: Actor,
): Promise<DemoStatusBase> {
  await createAiCompany(prisma, repos, actor, { createInitialMeeting: false });
  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      spawnKey: { in: AI_COMPANY_ROLES.map((role) => `${DEMO_SPAWN_PREFIX}${role.key}`) },
    },
    select: { id: true, name: true, spawnKey: true, thread: { select: { id: true } } },
  });
  const bySpawnKey = new Map(bots.map((bot) => [bot.spawnKey, bot]));
  const ordered = AI_COMPANY_ROLES.map((role) => {
    const bot = bySpawnKey.get(`${DEMO_SPAWN_PREFIX}${role.key}`);
    if (!bot?.thread) throw new Error(`The ${role.name} could not be prepared for the demo.`);
    return { role, bot, threadId: bot.thread.id };
  });

  await prisma.$transaction(async (tx) => {
    const lockKey = `rabbitbots-ai-company-demo:${actor.spaceId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})) IS NULL`;
    const existing = await tx.meeting.findFirst({
      where: {
        spaceId: actor.spaceId,
        title: AI_COMPANY_DEMO_MEETING_TITLE,
        description: DEMO_DESCRIPTION,
      },
      select: { id: true },
    });
    if (existing) return;
    await tx.meeting.create({
      data: {
        spaceId: actor.spaceId,
        createdBy: actor.userId,
        title: AI_COMPANY_DEMO_MEETING_TITLE,
        description: DEMO_DESCRIPTION,
        chairBotId: ordered[0]!.bot.id,
        status: "DRAFT",
        agenda: {
          create: AI_COMPANY_DEMO_AGENDA.map((title, index) => ({
            title,
            description: DEMO_AGENDA_DESCRIPTIONS[index] ?? "",
            sequence: index + 1,
            timeLimitSeconds: 300,
            maxDiscussionRounds: 1,
          })),
        },
        participants: {
          create: ordered.map(({ role, bot, threadId }) => ({
            botId: bot.id,
            threadId,
            role: role.key === "ceo" ? "Chairperson" : role.role,
            responsibilities: role.description,
          })),
        },
        humanParticipants: { create: { userId: actor.userId, role: "HUMAN_CEO" } },
      },
    });
  });
  return getDemoStatus(prisma, actor.spaceId);
}
