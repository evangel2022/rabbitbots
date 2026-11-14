import type {
  Actor,
  WorkforceCompanyBotView,
  WorkforceCompanyRoleInput,
  WorkforceCompanyStatus,
} from "@rakazo/contracts";
import { AI_COMPANY_MEETING_TITLE } from "@rakazo/contracts";
import type { createRepos, PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";

type Repos = ReturnType<typeof createRepos>;

const MEETING_DESCRIPTION =
  "The first strategy meeting of this AI company. Human CEO approval remains required.";
const COMPANY_SPAWN_PREFIX = "rabbitbots:ai-company:";

export const AI_COMPANY_ROLES = [
  {
    key: "ceo",
    role: "CEO Assistant",
    name: "CEO Assistant",
    description: "Chairs the boardroom, frames decisions and coordinates the company.",
    instructions:
      "You are the CEO Assistant for this AI company. Chair executive meetings, frame agenda decisions, identify disagreements and help coordinate the other AI employees. You do not replace the human CEO: never approve a decision, accept work, or claim the CEO approved anything. Ask the human CEO when authority is unclear.",
    color: "#8B93A8",
  },
  {
    key: "research",
    role: "Research",
    name: "Research Bot",
    description: "Finds evidence, compares options and briefs the company.",
    instructions:
      "You are the Research Bot for this AI company. Find relevant evidence, compare options and brief the company with sources and dates. Clearly separate facts, assumptions and open questions. Never invent a source or claim a page you did not open.",
    color: "#1CC3B0",
  },
  {
    key: "finance",
    role: "Finance",
    name: "Finance Bot",
    description: "Checks spend, scenarios, cash flow and financial risk.",
    instructions:
      "You are the Finance Bot for this AI company. Analyze budgets, costs, scenarios and financial risk. Do not invent financial data; state missing inputs and label estimates and assumptions. Do not authorize spend; the human CEO retains financial authority.",
    color: "#00C972",
  },
  {
    key: "operations",
    role: "Operations",
    name: "Operations Bot",
    description: "Turns decisions into checklists, owners and operating cadence.",
    instructions:
      "You are the Operations Bot for this AI company. Turn approved decisions into checklists, owners and operating cadence, and track delivery. Do not bypass the human CEO's approval or acceptance. Do not start irreversible external actions.",
    color: "#F5A03C",
  },
] as const;

function botView(
  role: (typeof AI_COMPANY_ROLES)[number],
  bot: { id: string; name: string; description: string },
): WorkforceCompanyBotView {
  return {
    roleKey: role.key,
    role: role.role,
    id: bot.id,
    name: bot.name,
    description: bot.description,
  };
}

async function findCompanyBots(
  prisma: PrismaClient,
  spaceId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    description: string;
    spawnKey: string | null;
    thread: { id: string } | null;
  }>
> {
  return prisma.bot.findMany({
    where: {
      spaceId,
      archivedAt: null,
      spawnKey: { in: AI_COMPANY_ROLES.map((role) => `${COMPANY_SPAWN_PREFIX}${role.key}`) },
    },
    select: {
      id: true,
      name: true,
      description: true,
      spawnKey: true,
      thread: { select: { id: true } },
    },
  });
}

async function findCompanyMeeting(prisma: PrismaClient, spaceId: string, botIds: string[]) {
  if (botIds.length !== AI_COMPANY_ROLES.length) return null;
  return prisma.meeting.findFirst({
    where: {
      spaceId,
      OR: [
        { title: AI_COMPANY_MEETING_TITLE, description: MEETING_DESCRIPTION },
        { AND: botIds.map((botId) => ({ participants: { some: { botId } } })) },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

export async function getAiCompanyStatus(
  prisma: PrismaClient,
  spaceId: string,
): Promise<WorkforceCompanyStatus> {
  const [space, bots] = await Promise.all([
    prisma.space.findUnique({
      where: { id: spaceId },
      select: { companyName: true, companyDescription: true },
    }),
    findCompanyBots(prisma, spaceId),
  ]);
  const bySpawnKey = new Map(bots.map((bot) => [bot.spawnKey, bot]));
  const meeting = await findCompanyMeeting(
    prisma,
    spaceId,
    bots.map((bot) => bot.id),
  );
  const views = AI_COMPANY_ROLES.flatMap((role) => {
    const bot = bySpawnKey.get(`${COMPANY_SPAWN_PREFIX}${role.key}`);
    return bot ? [botView(role, bot)] : [];
  });
  return {
    created: views.length === AI_COMPANY_ROLES.length && meeting !== null,
    name: space?.companyName ?? null,
    description: space?.companyDescription ?? null,
    bots: views,
    meetingId: meeting?.id ?? null,
    meetingTitle: AI_COMPANY_MEETING_TITLE,
  };
}

/** Creates the four AI employees and one draft boardroom meeting; never starts or approves it. */
export async function createAiCompany(
  prisma: PrismaClient,
  repos: Repos,
  actor: Actor,
  options: {
    name?: string;
    description?: string;
    roles?: WorkforceCompanyRoleInput[];
    createInitialMeeting?: boolean;
  } = {},
): Promise<WorkforceCompanyStatus> {
  const roleOverrides = roleOverridesFor(options.roles);
  const existingCompany = await getAiCompanyStatus(prisma, actor.spaceId);
  if (existingCompany.created) {
    // A retry after a lost response must not overwrite the company the user already has.
    if (options.name && !existingCompany.name) {
      await prisma.space.updateMany({
        where: { id: actor.spaceId, companyName: null },
        data: {
          companyName: options.name,
          companyDescription: options.description?.trim() || null,
        },
      });
    }
    return getAiCompanyStatus(prisma, actor.spaceId);
  }

  for (const role of AI_COMPANY_ROLES) {
    const spawnKey = `${COMPANY_SPAWN_PREFIX}${role.key}`;
    const existing = await prisma.bot.findUnique({
      where: { spaceId_spawnKey: { spaceId: actor.spaceId, spawnKey } },
      select: { id: true, archivedAt: true },
    });
    if (existing && !existing.archivedAt) continue;
    const override = roleOverrides.get(role.key);
    try {
      await repos.createBot(actor, {
        name: override?.name ?? role.name,
        description: override?.description ?? role.description,
        instructions: role.instructions,
        notifyOnFinish: true,
        spawnKey,
        color: role.color,
      });
    } catch (error) {
      // Two creation requests can race on the spawn key; the winner is this role's bot.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const bots = await findCompanyBots(prisma, actor.spaceId);
  const bySpawnKey = new Map(bots.map((bot) => [bot.spawnKey, bot]));
  const ordered = AI_COMPANY_ROLES.map((role) => {
    const bot = bySpawnKey.get(`${COMPANY_SPAWN_PREFIX}${role.key}`);
    if (!bot?.thread) throw new Error(`The ${role.name} could not be prepared for the boardroom.`);
    return { role, bot, threadId: bot.thread.id };
  });

  if (options.createInitialMeeting === false) {
    if (options.name) await persistCompanyProfile(prisma, actor.spaceId, options);
    return {
      created: false,
      name: options.name ?? null,
      description: options.description?.trim() || null,
      bots: ordered.map(({ role, bot }) => botView(role, bot)),
      meetingId: null,
      meetingTitle: AI_COMPANY_MEETING_TITLE,
    };
  }

  const meeting = await prisma.$transaction(async (tx) => {
    const lockKey = `rabbitbots-ai-company:${actor.spaceId}`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})) IS NULL`;
    const botIds = ordered.map(({ bot }) => bot.id);
    const existing = await tx.meeting.findFirst({
      where: {
        spaceId: actor.spaceId,
        OR: [
          { title: AI_COMPANY_MEETING_TITLE, description: MEETING_DESCRIPTION },
          { AND: botIds.map((botId) => ({ participants: { some: { botId } } })) },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) return existing;
    return tx.meeting.create({
      data: {
        spaceId: actor.spaceId,
        createdBy: actor.userId,
        title: AI_COMPANY_MEETING_TITLE,
        description: MEETING_DESCRIPTION,
        chairBotId: ordered[0]!.bot.id,
        status: "DRAFT",
        agenda: {
          create: [
            {
              title: "Company Mission",
              description: "Define the company mission and the CEO's mandate.",
              sequence: 1,
              timeLimitSeconds: 300,
            },
            {
              title: "Current Priorities",
              description: "Identify the most important current priorities.",
              sequence: 2,
              timeLimitSeconds: 300,
            },
            {
              title: "Research and Opportunities",
              description: "Review evidence, opportunities and open questions.",
              sequence: 3,
              timeLimitSeconds: 300,
            },
            {
              title: "Finance and Resource Allocation",
              description: "Review resource constraints and financial assumptions.",
              sequence: 4,
              timeLimitSeconds: 300,
            },
            {
              title: "Operations and Next Actions",
              description: "Propose owners, checkpoints and next actions for CEO approval.",
              sequence: 5,
              timeLimitSeconds: 300,
            },
          ],
        },
        participants: {
          create: ordered.map(({ role, bot, threadId }) => ({
            botId: bot.id,
            threadId,
            role: role.key === "ceo" ? "Chairperson" : role.role,
            responsibilities: role.description,
          })),
        },
        humanParticipants: {
          create: { userId: actor.userId, role: "HUMAN_CEO" },
        },
      },
      select: { id: true },
    });
  });

  if (options.name) await persistCompanyProfile(prisma, actor.spaceId, options);
  return {
    created: true,
    name: options.name ?? existingCompany.name ?? null,
    description: (options.description?.trim() || existingCompany.description) ?? null,
    bots: ordered.map(({ role, bot }) => botView(role, bot)),
    meetingId: meeting.id,
    meetingTitle: AI_COMPANY_MEETING_TITLE,
  };
}

function roleOverridesFor(
  roles: WorkforceCompanyRoleInput[] | undefined,
): Map<string, WorkforceCompanyRoleInput> {
  if (!roles) return new Map();
  const overrides = new Map<string, WorkforceCompanyRoleInput>();
  for (const role of roles) {
    if (overrides.has(role.key)) throw new Error(`Duplicate company role: ${role.key}`);
    overrides.set(role.key, role);
  }
  return overrides;
}

async function persistCompanyProfile(
  prisma: PrismaClient,
  spaceId: string,
  options: { name?: string; description?: string },
) {
  if (!options.name) return;
  await prisma.space.updateMany({
    where: { id: spaceId, companyName: null },
    data: {
      companyName: options.name,
      companyDescription: options.description?.trim() || null,
    },
  });
}
