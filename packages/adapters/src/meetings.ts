import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  meetingActionReconcileJob,
  meetingReconcileJob,
  meetingReconcileJobKey,
  runContinueJob,
  runJobKey,
} from "@rakazo/adapter-kit";
import type {
  MeetingActionAcceptanceAction,
  MeetingActionItemView,
  MeetingApprovalAction,
  MeetingDecisionApprovalResult,
  MeetingDecisionApprovalView,
  MeetingDecisionType,
  MeetingDecisionView,
  MeetingListItem,
  MeetingMessagesListOutput,
  MeetingMessageView,
  MeetingStatus,
  MeetingView,
} from "@rakazo/contracts";
import {
  MEETING_DECISION_TYPES,
  MEETING_DISCUSSION_STATES,
  MEETING_MAX_DISCUSSION_ROUNDS,
  MEETING_MAX_TOTAL_SECONDS,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { cancelRunsInTransaction, isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createUnifiedAttempt, updateUnifiedAttempt } from "./execution-attempts.js";
import { readRunOutcome } from "./orchestration.js";
import { reconcileActiveWorkforceTasks } from "./workforce-tasks.js";

/**
 * Executive Boardroom. The state machine is deterministic and persisted; the model only writes a
 * participant turn. No chat message can change a meeting, and no unbounded agent discussion exists.
 */

export type MeetingDeps = { prisma: PrismaClient; jobs: JobPublisher };

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_MEETING_STATUSES = new Set<MeetingStatus>(["COMPLETED", "CANCELLED", "FAILED"]);
class MeetingStoppedError extends Error {
  constructor() {
    super("Meeting is no longer active.");
  }
}

const ACTIVE_MEETING_STATUSES = [
  "PREPARING",
  "OPENING",
  "REPORTING",
  "DISCUSSION",
  "DECISION",
  "CLOSING",
] as const;
const VALID_TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  DRAFT: ["PREPARING", "CANCELLED"],
  PREPARING: ["OPENING", "CLOSING", "FAILED", "CANCELLED"],
  OPENING: ["REPORTING", "CLOSING", "FAILED", "CANCELLED"],
  REPORTING: ["DISCUSSION", "DECISION", "CLOSING", "FAILED", "CANCELLED"],
  DISCUSSION: ["DECISION", "CLOSING", "FAILED", "CANCELLED"],
  DECISION: ["CLOSING", "FAILED", "CANCELLED"],
  CLOSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransitionMeeting(from: string, to: MeetingStatus): boolean {
  return (VALID_TRANSITIONS[from as MeetingStatus] ?? []).includes(to);
}

/** Participant turns are one per phase/round, so a repeated advance cannot add a second turn. */
export function canAddDiscussionRound(round: number, maxRounds: number): boolean {
  return round < Math.min(maxRounds, MEETING_MAX_DISCUSSION_ROUNDS);
}

/** A material objection must carry evidence, a concrete risk, a contradiction or an alternative. */
export function hasSupportedObjection(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const evidence =
    /https?:\/\/\S+/i.test(value) ||
    /\b\d+(?:\.\d+)?\s?(?:%|x|m|b|k|million|billion|美元|亿|万)/i.test(value);
  // Saying "I disagree" with no evidence is not a material objection.
  if (
    !evidence &&
    /(nothing else|nothing more|no new evidence|no evidence|without evidence)/i.test(value)
  )
    return false;
  return (
    evidence ||
    /(risk|concern|uncertain|风险|不确定)/i.test(value) ||
    /(contradict|however|but\s|challenge|矛盾|然而|但)/i.test(value) ||
    /(alternative|instead|could\s+use|建议改为|替代)/i.test(value)
  );
}

/**
 * We only start a discussion when the two reports contain a material disagreement. A report that
 * fails or is empty cannot manufacture one.
 */
export function detectMaterialDisagreement(reports: Array<string | null | undefined>): boolean {
  const present = reports.filter((report): report is string => Boolean(report?.trim()));
  if (present.length < 2) return false;
  const combined = present.join("\n");
  if (/no material disagreement|无重大分歧|没有重大分歧/i.test(combined)) return false;
  return hasSupportedObjection(present[1] ?? "") && hasSupportedObjection(present[0] ?? "");
}

export type ChairOutput = {
  summary: string;
  minutes: string;
  decisions: Array<{
    agendaSequence: number;
    decisionType: MeetingDecisionType;
    decisionText: string;
    rationale: string;
    supportingEvidence: string[];
    risks: string[];
    dissentingOpinions: string[];
    conditions: string[];
    approvalRequired: boolean;
    approvalStatus: string;
  }>;
  actionItems: Array<{
    title: string;
    description: string;
    assigneeRole: string;
    dueAt: string | null;
  }>;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The chair is asked for JSON; tolerate a fenced block or prose around the object. */
export function parseChairOutput(text: string): ChairOutput | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const object = parsed as Record<string, unknown>;
  const summary = stringValue(object.summary) || stringValue(object.minutes);
  const minutes = stringValue(object.minutes) || summary;
  if (!summary || !minutes) return null;
  const rawDecisions = Array.isArray(object.decisions) ? object.decisions : [];
  const decisions: ChairOutput["decisions"] = [];
  for (const [index, raw] of rawDecisions.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const decision = raw as Record<string, unknown>;
    const type = stringValue(decision.decisionType).toUpperCase() as MeetingDecisionType;
    if (!MEETING_DECISION_TYPES.includes(type)) continue;
    const agendaSequence =
      typeof decision.agendaSequence === "number" && Number.isFinite(decision.agendaSequence)
        ? decision.agendaSequence
        : index + 1;
    const decisionText = stringValue(decision.decisionText);
    const rationale = stringValue(decision.rationale);
    if (!decisionText || !rationale) continue;
    const financeDecision = type === "APPROVED" || type === "APPROVED_WITH_CONDITIONS";
    decisions.push({
      agendaSequence,
      decisionType: type,
      decisionText,
      rationale,
      supportingEvidence: stringArray(decision.supportingEvidence),
      risks: stringArray(decision.risks),
      dissentingOpinions: stringArray(decision.dissentingOpinions),
      conditions: stringArray(decision.conditions),
      approvalRequired: financeDecision,
      approvalStatus: financeDecision ? "PENDING" : "NOT_REQUIRED",
    });
  }
  if (!decisions.length) return null;
  const rawActions = Array.isArray(object.actionItems) ? object.actionItems : [];
  const actionItems: ChairOutput["actionItems"] = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = stringValue(item.title);
    if (!title) continue;
    const due = stringValue(item.dueAt);
    const dueAt = due && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null;
    actionItems.push({
      title,
      description: stringValue(item.description),
      assigneeRole: stringValue(item.assigneeRole) || stringValue(item.assignee),
      dueAt,
    });
  }
  return { summary, minutes, decisions, actionItems };
}

export type DiscussionQuestion = {
  question: string;
  participants: string[];
  agendaSequence?: number;
};

export type DiscussionEvaluation = {
  needsAnotherRound: boolean;
  reason: string;
  question: string;
  newEvidence: string[];
  participants: string[];
};

/**
 * Models occasionally emit a literal newline or tab inside a JSON string. That is
 * invalid JSON even though the surrounding object is otherwise well formed. Repair
 * only control characters inside strings; never rewrite values or evidence.
 */
function repairJsonStringControls(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        output += character;
        escaped = false;
      } else if (character === "\\") {
        output += character;
        escaped = true;
      } else if (character === '"') {
        output += character;
        inString = false;
      } else if (character === "\n") {
        output += "\\n";
      } else if (character === "\r") {
        output += "\\r";
      } else if (character === "\t") {
        output += "\\t";
      } else {
        output += character;
      }
    } else {
      if (character === '"') inString = true;
      output += character;
    }
  }
  return output;
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(repairJsonStringControls(text.slice(start, end + 1)));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The chair returns a structured question. Prose is accepted as a question so a
 * provider formatting miss cannot block the meeting; participant selection then
 * falls back to all reporting participants.
 */
export function parseDiscussionQuestion(text: string): DiscussionQuestion | null {
  const object = jsonObject(text);
  const question = object ? stringValue(object.question) : "";
  const participants = object ? stringArray(object.participants) : [];
  const agendaSequence =
    object && typeof object.agendaSequence === "number" && Number.isFinite(object.agendaSequence)
      ? object.agendaSequence
      : undefined;
  // Providers occasionally close a JSON object badly or prepend prose. Recover
  // the named fields rather than storing malformed JSON as the discussion question.
  const questionMatch = text.match(/"question"\s*:\s*"((?:\\.|[^"\\])*)"/s);
  const participantsMatch = text.match(/"participants"\s*:\s*\[([^\]]*)\]/s);
  const recoveredQuestion = questionMatch
    ? questionMatch[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n").trim()
    : "";
  const recoveredParticipants =
    participantsMatch && !participants.length
      ? [...participantsMatch[1]!.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
          match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim(),
        )
      : [];
  const fallback = text.trim();
  const resolvedQuestion = question || recoveredQuestion || fallback;
  if (!resolvedQuestion) return null;
  return {
    question: resolvedQuestion,
    participants: participants.length ? participants : recoveredParticipants,
    ...(agendaSequence !== undefined ? { agendaSequence } : {}),
  };
}

/**
 * A second round is permitted only when the chair names evidence that actually
 * changed a material point and the round ceiling still allows one.
 */
export function parseDiscussionEvaluation(text: string): DiscussionEvaluation | null {
  const object = jsonObject(text);
  if (!object) return null;
  const needsAnotherRound = object.needsAnotherRound === true;
  const reason = stringValue(object.reason) || stringValue(object.summary);
  const question = stringValue(object.question);
  const newEvidence = stringArray(object.newEvidence);
  const participants = stringArray(object.participants);
  if (!needsAnotherRound)
    return { needsAnotherRound: false, reason, question: "", newEvidence, participants };
  if (!newEvidence.length || !question) return null;
  return { needsAnotherRound: true, reason, question, newEvidence, participants };
}

/** Select requested roles by name/role; otherwise every reporting participant. */
export function selectDiscussionParticipants(
  participants: Array<{ botId: string; role: string; bot: { name: string } }>,
  requested: string[],
  eligibleBotIds: ReadonlySet<string>,
): string[] {
  const eligible = participants.filter(
    (participant) => participant.botId !== "" && eligibleBotIds.has(participant.botId),
  );
  const wanted = requested.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const matched = wanted.length
    ? eligible.filter((participant) => {
        const role = participant.role.toLowerCase();
        const name = participant.bot.name.toLowerCase();
        return wanted.some(
          (value) =>
            role.includes(value) ||
            value.includes(role) ||
            name.includes(value) ||
            value.includes(name),
        );
      })
    : [];
  const selected = matched.length ? matched : eligible;
  return [...new Set(selected.map((participant) => participant.botId))].slice(0, 4);
}

/** Every source is stored with its URL; no source text is invented. */
export function extractEvidence(text: string): { sources: string[]; retrievedAt: string } {
  const sources = [
    ...new Set(
      (text.match(/https?:\/\/[^\s)\]]+/g) ?? []).map((url) => url.replace(/[.,;:]+$/, "")),
    ),
  ];
  return { sources, retrievedAt: new Date().toISOString() };
}

const MEETING_INCLUDE = {
  chairBot: { select: { id: true, name: true } },
  participants: {
    orderBy: { createdAt: "asc" },
    include: { bot: { select: { id: true, name: true, description: true, spawnKey: true } } },
  },
  humanParticipants: { orderBy: { createdAt: "asc" } },
  agenda: { orderBy: { sequence: "asc" } },
  turns: { orderBy: { createdAt: "asc" }, include: { participantBot: { select: { name: true } } } },
  decisions: {
    orderBy: { createdAt: "asc" },
    include: { approvals: { orderBy: { createdAt: "asc" } } },
  },
  actionItems: {
    orderBy: { createdAt: "asc" },
    include: {
      assigneeBot: { select: { name: true } },
      decision: { select: { agendaId: true } },
      acceptances: { orderBy: { createdAt: "asc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
      executionAttempts: { orderBy: { attemptNumber: "asc" } },
    },
  },
} as const;

export async function listMeetings(
  prisma: PrismaClient,
  spaceId: string,
): Promise<MeetingListItem[]> {
  const rows = await prisma.meeting.findMany({
    where: { spaceId },
    orderBy: { updatedAt: "desc" },
    include: {
      chairBot: { select: { name: true } },
      participants: { include: { bot: { select: { name: true } } } },
      humanParticipants: { select: { userId: true } },
    },
  });
  const humanIds = [
    ...new Set(rows.flatMap((row) => row.humanParticipants.map((item) => item.userId))),
  ];
  const humans = humanIds.length
    ? await prisma.user.findMany({
        where: { id: { in: humanIds } },
        select: { id: true, name: true },
      })
    : [];
  const humanNames = new Map(humans.map((human) => [human.id, human.name]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as MeetingStatus,
    chairBotName: row.chairBot.name,
    participantNames: [
      ...row.participants.map((participant) => participant.bot.name),
      ...row.humanParticipants.map((item) => humanNames.get(item.userId) ?? "Human CEO"),
    ],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }));
}

const MESSAGE_READ_ONLY_MEETING_STATUSES = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

async function requireMeetingHuman(
  prisma: PrismaClient,
  meetingId: string,
  spaceId: string,
  userId: string,
): Promise<{ id: string; status: string }> {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, spaceId },
    select: { id: true, status: true },
  });
  if (!meeting) throw new Error("Meeting not found.");
  const human = await prisma.meetingHumanParticipant.findUnique({
    where: { meetingId_userId: { meetingId, userId } },
    select: { id: true },
  });
  if (!human) throw new Error("You are not a human participant in this meeting.");
  return meeting;
}

async function meetingMessageView(
  prisma: PrismaClient,
  message: {
    id: string;
    meetingId: string;
    agendaId: string | null;
    authorType: string;
    authorUserId: string | null;
    authorBotId: string | null;
    content: string;
    seq: number;
    createdAt: Date;
  },
): Promise<MeetingMessageView> {
  const [user, bot] = await Promise.all([
    message.authorUserId
      ? prisma.user.findUnique({ where: { id: message.authorUserId }, select: { name: true } })
      : null,
    message.authorBotId
      ? prisma.bot.findUnique({ where: { id: message.authorBotId }, select: { name: true } })
      : null,
  ]);
  return {
    id: message.id,
    meetingId: message.meetingId,
    agendaId: message.agendaId,
    authorType: message.authorType as MeetingMessageView["authorType"],
    authorName: user?.name ?? bot?.name ?? "Meeting participant",
    authorUserId: message.authorUserId,
    authorBotId: message.authorBotId,
    content: message.content,
    seq: message.seq,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Persist a human CEO message. The identity is always the authenticated actor;
 * the meeting and agenda are validated in the actor's Space. The unique
 * (meetingId, clientNonce) row makes retries return the same persisted message.
 */
export async function sendMeetingMessage(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    agendaId?: string;
    content: string;
    clientNonce: string;
  },
): Promise<MeetingMessageView> {
  const meeting = await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  if (MESSAGE_READ_ONLY_MEETING_STATUSES.has(meeting.status)) {
    throw new Error("This meeting has ended; its transcript is read-only.");
  }
  if (input.agendaId) {
    const agenda = await prisma.meetingAgenda.findFirst({
      where: { id: input.agendaId, meetingId: input.meetingId },
      select: { id: true },
    });
    if (!agenda) throw new Error("That agenda item does not belong to this meeting.");
  }
  const content = input.content.trim();
  if (!content) throw new Error("A meeting message needs text.");
  const existing = await prisma.meetingMessage.findUnique({
    where: {
      meetingId_clientNonce: { meetingId: input.meetingId, clientNonce: input.clientNonce },
    },
  });
  if (existing) return meetingMessageView(prisma, existing);
  try {
    const created = await prisma.meetingMessage.create({
      data: {
        meetingId: input.meetingId,
        agendaId: input.agendaId ?? null,
        authorType: "HUMAN_CEO",
        authorUserId: input.userId,
        content,
        clientNonce: input.clientNonce,
      },
    });
    return meetingMessageView(prisma, created);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.meetingMessage.findUniqueOrThrow({
      where: {
        meetingId_clientNonce: { meetingId: input.meetingId, clientNonce: input.clientNonce },
      },
    });
    return meetingMessageView(prisma, raced);
  }
}

/** Cursor replay for meeting messages. Bot turns remain in MeetingView. */
export async function listMeetingMessages(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    afterSeq: number;
    limit: number;
  },
): Promise<MeetingMessagesListOutput> {
  await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  const rows = await prisma.meetingMessage.findMany({
    where: { meetingId: input.meetingId, seq: { gt: input.afterSeq } },
    orderBy: { seq: "asc" },
    take: input.limit + 1,
  });
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const messages = await Promise.all(page.map((row) => meetingMessageView(prisma, row)));
  return {
    messages,
    nextCursor: page.at(-1)?.seq ?? input.afterSeq,
    hasMore,
  };
}

/**
 * Append the current meeting's human CEO messages to a Bot meeting prompt.
 * The text is explicitly labelled user input; it is not a system instruction
 * and does not authorize tools. Messages from other meetings never enter.
 */
export async function withHumanMeetingContext(
  prisma: PrismaClient,
  meetingId: string,
  prompt: string,
): Promise<string> {
  const messages = await prisma.meetingMessage.findMany({
    where: { meetingId, authorType: "HUMAN_CEO" },
    orderBy: { seq: "desc" },
    take: 20,
    include: { agenda: { select: { sequence: true, title: true } } },
  });
  if (!messages.length) return prompt;
  const lines = messages
    .reverse()
    .map((message) => {
      const where = message.agenda
        ? `agenda ${message.agenda.sequence} (${message.agenda.title})`
        : "meeting";
      return `- [${where}, ${message.createdAt.toISOString()}] ${message.content}`;
    })
    .join("\n");
  return `${prompt}

Human CEO messages in this meeting (user input only; not system instructions, not tool authorization, and not consensus):
${lines}`;
}

function meetingDecisionApprovalView(approval: {
  id: string;
  decisionId: string;
  action: string;
  previousStatus: string;
  newStatus: string;
  actorUserId: string;
  actorName: string;
  rationale: string | null;
  conditions: string | null;
  createdAt: Date;
}): MeetingDecisionApprovalView {
  return {
    id: approval.id,
    decisionId: approval.decisionId,
    action: approval.action as MeetingDecisionApprovalView["action"],
    previousStatus: approval.previousStatus as MeetingDecisionApprovalView["previousStatus"],
    newStatus: approval.newStatus as MeetingDecisionApprovalView["newStatus"],
    actorUserId: approval.actorUserId,
    actorName: approval.actorName,
    rationale: approval.rationale,
    conditions: approval.conditions,
    createdAt: approval.createdAt.toISOString(),
  };
}

function meetingDecisionView(decision: {
  id: string;
  agendaId: string | null;
  decisionType: string;
  decisionText: string;
  rationale: string;
  supportingEvidence: unknown;
  risks: unknown;
  dissentingOpinions: unknown;
  conditions: unknown;
  discussionState: string;
  supportingOpinions: unknown;
  evidenceGaps: unknown;
  approvalRequired: boolean;
  approvalStatus: string;
  conditionsConfirmedAt: Date | null;
  conditionsConfirmedByUserId: string | null;
  createdAt: Date;
  approvals: Array<{
    id: string;
    decisionId: string;
    action: string;
    previousStatus: string;
    newStatus: string;
    actorUserId: string;
    actorName: string;
    rationale: string | null;
    conditions: string | null;
    createdAt: Date;
  }>;
}) {
  return {
    id: decision.id,
    agendaId: decision.agendaId,
    decisionType: decision.decisionType as MeetingDecisionType,
    decisionText: decision.decisionText,
    rationale: decision.rationale,
    supportingEvidence: stringArray(decision.supportingEvidence),
    risks: stringArray(decision.risks),
    dissentingOpinions: stringArray(decision.dissentingOpinions),
    conditions: stringArray(decision.conditions),
    discussionState:
      decision.discussionState as MeetingView["decisions"][number]["discussionState"],
    supportingOpinions: stringArray(decision.supportingOpinions),
    evidenceGaps: stringArray(decision.evidenceGaps),
    approvalRequired: decision.approvalRequired,
    approvalStatus: decision.approvalStatus as MeetingView["decisions"][number]["approvalStatus"],
    conditionsConfirmedAt: decision.conditionsConfirmedAt?.toISOString() ?? null,
    conditionsConfirmedByUserId: decision.conditionsConfirmedByUserId,
    approvalHistory: decision.approvals.map(meetingDecisionApprovalView),
    createdAt: decision.createdAt.toISOString(),
  };
}

/** Confirm the CEO's conditions, activating only that decision's action items. */
export async function confirmMeetingConditions(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    decisionId: string;
  },
): Promise<MeetingDecisionView> {
  await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  const decision = await prisma.meetingDecision.findFirst({
    where: { id: input.decisionId, meetingId: input.meetingId },
    include: { approvals: { orderBy: { createdAt: "asc" } } },
  });
  if (!decision) throw new Error("Decision not found for this meeting.");
  if (decision.approvalStatus !== "APPROVED_WITH_CONDITIONS") {
    throw new Error("Only a conditionally approved decision needs condition confirmation.");
  }
  if (!decision.conditionsConfirmedAt) {
    const confirmedAt = new Date();
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.meetingDecision.updateMany({
        where: {
          id: input.decisionId,
          meetingId: input.meetingId,
          conditionsConfirmedAt: null,
        },
        data: {
          conditionsConfirmedAt: confirmedAt,
          conditionsConfirmedByUserId: input.userId,
        },
      });
      if (claimed.count !== 1) return;
      await tx.meetingActionItem.updateMany({
        where: { decisionId: input.decisionId, activatedAt: null },
        data: { activatedAt: confirmedAt },
      });
    });
  }
  const updated = await prisma.meetingDecision.findUniqueOrThrow({
    where: { id: input.decisionId },
    include: { approvals: { orderBy: { createdAt: "asc" } } },
  });
  return meetingDecisionView(updated);
}

const ACTION_TERMINAL_RESULTS = new Set(["FAILED", "BLOCKED"]);

function actionResultStatus(value: unknown): "SUCCESS" | "PARTIAL" | "FAILED" | "BLOCKED" {
  const normalized = stringValue(value).toUpperCase();
  return normalized === "PARTIAL" || normalized === "FAILED" || normalized === "BLOCKED"
    ? normalized
    : "SUCCESS";
}

function parseActionExecutionResult(text: string): {
  resultStatus: "SUCCESS" | "PARTIAL" | "FAILED" | "BLOCKED";
  summary: string;
  evidence: string[];
} {
  const object = jsonObject(text);
  const summary = object
    ? stringValue(object.summary) || stringValue(object.resultSummary)
    : text.trim().slice(0, 4_000);
  const evidence = object
    ? [...stringArray(object.evidence), ...extractEvidence(text).sources]
    : extractEvidence(text).sources;
  return {
    resultStatus: object ? actionResultStatus(object.resultStatus) : "SUCCESS",
    summary: summary || "The Bot completed the action without a written summary.",
    evidence: [...new Set(evidence)],
  };
}

async function loadActionForView(prisma: PrismaClient, actionItemId: string) {
  const item = await prisma.meetingActionItem.findUniqueOrThrow({
    where: { id: actionItemId },
    include: {
      assigneeBot: { select: { name: true } },
      decision: { select: { agendaId: true } },
      acceptances: { orderBy: { createdAt: "asc" } },
      attempts: { orderBy: { attemptNumber: "asc" } },
      executionAttempts: { orderBy: { attemptNumber: "asc" } },
    },
  });
  const user = item.assigneeUserId
    ? await prisma.user.findUnique({ where: { id: item.assigneeUserId }, select: { name: true } })
    : null;
  return meetingActionView(item, user?.name ?? (item.assigneeUserId ? "Human owner" : null));
}

/**
 * Start a real Bot execution for one approved action item. The Task/Run pair is
 * the existing execution primitive; the action row only records which run is the
 * current attempt. A repeated call returns the existing attempt and never starts a
 * second Task.
 */
export async function executeMeetingAction(
  deps: MeetingDeps,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    actionItemId: string;
    clientNonce: string;
  },
): Promise<MeetingActionItemView> {
  await requireMeetingHuman(deps.prisma, input.meetingId, input.spaceId, input.userId);
  const action = await deps.prisma.meetingActionItem.findFirst({
    where: { id: input.actionItemId, meetingId: input.meetingId },
    include: {
      decision: {
        select: {
          approvalStatus: true,
          conditionsConfirmedAt: true,
          decisionType: true,
          decisionText: true,
          rationale: true,
          agenda: { select: { sequence: true, title: true } },
        },
      },
    },
  });
  if (!action) throw new Error("Action item not found for this meeting.");
  if (!action.decision) throw new Error("Action item has no decision.");
  const approved =
    action.decision.approvalStatus === "APPROVED" ||
    (action.decision.approvalStatus === "APPROVED_WITH_CONDITIONS" &&
      Boolean(action.decision.conditionsConfirmedAt));
  if (!approved) {
    throw new Error(
      "This action belongs to a decision that is not CEO-approved or whose conditions are not confirmed.",
    );
  }
  if (!action.assigneeBotId)
    throw new Error("This action is assigned to a human owner and cannot start a Bot run.");
  if (!action.activatedAt) {
    await deps.prisma.meetingActionItem.update({
      where: { id: action.id },
      data: { activatedAt: new Date() },
    });
  }
  if (action.status === "COMPLETED" || action.status === "BLOCKED") {
    throw new Error("This action is already complete or blocked.");
  }
  if (action.taskId && action.botRunId) {
    return loadActionForView(deps.prisma, action.id);
  }
  const bot = await deps.prisma.bot.findFirst({
    where: { id: action.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, name: true, description: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new Error("The assigned Bot has no execution thread.");
  const participant = await deps.prisma.meetingParticipant.findFirst({
    where: { meetingId: input.meetingId, botId: bot.id },
    select: { threadId: true, role: true },
  });
  const threadId = participant?.threadId ?? bot.thread.id;
  const attempt = action.executionAttempt + 1;
  const clientNonce = `meeting-action:${action.id}:${attempt}`;
  const existingRun = await deps.prisma.run.findUnique({
    where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce } },
    select: { id: true, taskId: true },
  });
  if (existingRun) {
    await deps.prisma.meetingActionItem.update({
      where: { id: action.id },
      data: {
        status: "IN_PROGRESS",
        executionAttempt: attempt,
        taskId: existingRun.taskId,
        botRunId: existingRun.id,
        startedAt: action.startedAt ?? new Date(),
      },
    });
    await enqueueRun(deps.jobs, existingRun.id);
    await deps.jobs.enqueue(meetingActionReconcileJob(action.id)).catch(() => undefined);
    return loadActionForView(deps.prisma, action.id);
  }
  const prompt = `You are the ${participant?.role || bot.name} executing ONE approved executive meeting action.

Meeting action: ${action.title}
Description: ${action.description || "(none)"}
Acceptance criteria: ${action.acceptanceCriteria || "(none recorded)"}

Approved decision for agenda ${action.decision.agenda?.sequence ?? "?"}: ${action.decision.agenda?.title ?? "unknown"}
Decision type: ${action.decision.decisionType}
Chair recommendation: ${action.decision.decisionText}
Rationale: ${action.decision.rationale}

Do the allowed work for this action. Remain within your role. This is not a new meeting decision and you cannot approve anything.
If the action can be completed from the approved decision and the existing meeting record, do so without tool calls. Do not browse the web unless the action explicitly requires a fresh external source; do not send email, contact a company, purchase, spend, sign, or perform any external or irreversible action. Do not claim the CEO accepted the work; only the human CEO can accept it.
When finished, return ONE JSON object only:
{
  "resultStatus": "SUCCESS" | "PARTIAL" | "FAILED" | "BLOCKED",
  "summary": "what you actually did and what remains",
  "evidence": ["URLs, file paths, source names or concrete verification references"],
  "acceptanceCriteriaCheck": "how the acceptance criterion was or was not met"
}
Never report SUCCESS without describing the work and at least one verifiable evidence reference where one exists.`;
  const task = await deps.prisma.task.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId,
      userId: input.userId,
      prompt,
      status: "queued",
    },
    select: { id: true },
  });
  let runId: string;
  try {
    const run = await deps.prisma.run.create({
      data: {
        spaceId: input.spaceId,
        botId: bot.id,
        threadId,
        taskId: task.id,
        userId: input.userId,
        status: "queued",
        trigger: "meeting_action",
        clientNonce,
        maxOutputTokens: 3_000,
      },
      select: { id: true },
    });
    runId = run.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await deps.prisma.run.findUniqueOrThrow({
      where: { spaceId_clientNonce: { spaceId: input.spaceId, clientNonce } },
      select: { id: true },
    });
    runId = raced.id;
  }
  const legacyAttempt = await deps.prisma.meetingActionAttempt.create({
    data: {
      meetingId: input.meetingId,
      actionItemId: action.id,
      attemptNumber: attempt,
      taskId: task.id,
      botRunId: runId,
      status: "RUNNING",
      startedAt: new Date(),
    },
    select: { id: true },
  });
  await createUnifiedAttempt(deps.prisma, {
    id: `ux-meeting:${legacyAttempt.id}`,
    spaceId: input.spaceId,
    sourceType: "MEETING_ACTION",
    sourceId: action.id,
    meetingActionId: action.id,
    taskId: task.id,
    runId,
    attemptNumber: attempt,
    status: "RUNNING",
  });
  await deps.prisma.meetingActionItem.update({
    where: { id: action.id },
    data: {
      status: "IN_PROGRESS",
      executionAttempt: attempt,
      taskId: task.id,
      botRunId: runId,
      startedAt: new Date(),
      completedAt: null,
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      blockedReason: null,
      acceptanceStatus: null,
    },
  });
  await enqueueRun(deps.jobs, runId);
  await deps.jobs.enqueue(meetingActionReconcileJob(action.id)).catch(() => undefined);
  return loadActionForView(deps.prisma, action.id);
}

/** Sync a terminal Bot run into the durable action result. It never marks the action COMPLETED. */
export async function reconcileMeetingAction(
  deps: MeetingDeps,
  actionItemId: string,
): Promise<void> {
  const action = await deps.prisma.meetingActionItem.findUnique({
    where: { id: actionItemId },
    select: { id: true, status: true, botRunId: true, executionAttempt: true },
  });
  if (!action?.botRunId || action.status !== "IN_PROGRESS") return;
  const run = await deps.prisma.run.findUnique({ where: { id: action.botRunId } });
  if (!run) return;
  if (ACTIVE_RUN_STATUSES.includes(run.status as never)) {
    await enqueueRun(deps.jobs, run.id);
    return;
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
  const attempt = await deps.prisma.meetingActionAttempt.findFirst({
    where: { actionItemId: action.id, attemptNumber: action.executionAttempt },
    select: { id: true },
  });
  const outcome = await readRunOutcome(deps.prisma, run.id);
  if (run.status === "failed" || run.status === "cancelled" || !outcome.text.trim()) {
    await deps.prisma.meetingActionItem.update({
      where: { id: action.id },
      data: {
        status: "BLOCKED",
        resultStatus: "FAILED",
        blockedReason: run.error ?? "The Bot run produced no usable result.",
        resultSummary: outcome.text.slice(0, 4_000) || null,
        completedAt: new Date(),
      },
    });
    if (attempt) {
      await deps.prisma.meetingActionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "FAILED",
          resultStatus: "FAILED",
          resultSummary: outcome.text.slice(0, 4_000) || null,
          error: run.error ?? "The Bot run produced no usable result.",
          completedAt: new Date(),
        },
      });
    }
    return;
  }
  const parsed = parseActionExecutionResult(outcome.text);
  const failed = ACTION_TERMINAL_RESULTS.has(parsed.resultStatus);
  await deps.prisma.meetingActionItem.update({
    where: { id: action.id },
    data: {
      status: failed ? "BLOCKED" : "IN_PROGRESS",
      resultStatus: parsed.resultStatus,
      resultSummary: parsed.summary,
      evidence: parsed.evidence,
      blockedReason: failed ? parsed.summary : null,
      completedAt: null,
    },
  });
  if (attempt) {
    await deps.prisma.meetingActionAttempt.update({
      where: { id: attempt.id },
      data: {
        status: failed ? (parsed.resultStatus === "BLOCKED" ? "BLOCKED" : "FAILED") : "COMPLETED",
        resultStatus: parsed.resultStatus,
        resultSummary: parsed.summary,
        evidence: parsed.evidence,
        error: failed ? parsed.summary : null,
        completedAt: new Date(),
      },
    });
    await updateUnifiedAttempt(deps.prisma, "MEETING_ACTION", action.id, action.executionAttempt, {
      status: failed ? (parsed.resultStatus === "BLOCKED" ? "BLOCKED" : "FAILED") : "COMPLETED",
      resultStatus: parsed.resultStatus,
      resultSummary: parsed.summary,
      evidence: parsed.evidence,
      error: failed ? parsed.summary : null,
      completedAt: new Date(),
    });
  }
}

/** Reassign an open/blocked action to another authorized Bot. */
export async function assignMeetingAction(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    actionItemId: string;
    assigneeBotId: string;
  },
): Promise<MeetingActionItemView> {
  await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  const action = await prisma.meetingActionItem.findFirst({
    where: { id: input.actionItemId, meetingId: input.meetingId },
    include: { decision: { select: { approvalStatus: true, conditionsConfirmedAt: true } } },
  });
  if (!action) throw new Error("Action item not found for this meeting.");
  if (action.status === "IN_PROGRESS" || action.status === "COMPLETED") {
    throw new Error("A running or completed action cannot be reassigned.");
  }
  const approved =
    action.decision?.approvalStatus === "APPROVED" ||
    (action.decision?.approvalStatus === "APPROVED_WITH_CONDITIONS" &&
      Boolean(action.decision.conditionsConfirmedAt));
  if (!approved) throw new Error("The decision is not approved for execution.");
  const bot = await prisma.bot.findFirst({
    where: { id: input.assigneeBotId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!bot) throw new Error("The new assignee Bot is not available in this Space.");
  const participant = await prisma.meetingParticipant.findFirst({
    where: { meetingId: input.meetingId, botId: bot.id },
    select: { id: true },
  });
  if (!participant) throw new Error("The new assignee Bot is not a meeting participant.");
  await prisma.meetingActionItem.update({
    where: { id: action.id },
    data: {
      assigneeBotId: bot.id,
      assigneeUserId: null,
      status: "OPEN",
      taskId: null,
      botRunId: null,
      startedAt: null,
      completedAt: null,
      resultStatus: null,
      resultSummary: null,
      evidence: [],
      blockedReason: null,
      acceptanceStatus: "REASSIGNED",
    },
  });
  return loadActionForView(prisma, action.id);
}

/**
 * CEO acceptance. This changes only the action's acceptance/execution fields and
 * writes an immutable acceptance row; it never changes the decision approval.
 */
export async function acceptMeetingAction(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    actionItemId: string;
    action: MeetingActionAcceptanceAction;
    comment?: string;
    clientNonce: string;
  },
): Promise<MeetingActionItemView> {
  await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  const action = await prisma.meetingActionItem.findFirst({
    where: { id: input.actionItemId, meetingId: input.meetingId },
  });
  if (!action) throw new Error("Action item not found for this meeting.");
  const comment = input.comment?.trim() || null;
  if (
    (input.action === "REJECT" ||
      input.action === "BLOCK" ||
      input.action === "REQUEST_EVIDENCE") &&
    !comment
  ) {
    throw new Error("A comment is required for this acceptance action.");
  }
  const existing = await prisma.meetingActionAcceptance.findUnique({
    where: {
      actionItemId_clientNonce: {
        actionItemId: input.actionItemId,
        clientNonce: input.clientNonce,
      },
    },
  });
  if (existing) {
    if (existing.action !== input.action || (existing.comment ?? null) !== comment) {
      throw new Error("This acceptance retry conflicts with the recorded acceptance.");
    }
    return loadActionForView(prisma, action.id);
  }
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { name: true },
  });
  if (!actor) throw new Error("Accepting user was not found.");
  if (input.action === "ACCEPT") {
    if (
      action.status !== "IN_PROGRESS" ||
      (action.resultStatus !== "SUCCESS" && action.resultStatus !== "PARTIAL")
    ) {
      throw new Error("Only a submitted SUCCESS or PARTIAL result can be accepted.");
    }
  }
  if (input.action === "RE_EXECUTE" && action.status === "COMPLETED") {
    throw new Error("A completed action cannot be re-executed without a new revision.");
  }
  const now = new Date();
  const update =
    input.action === "ACCEPT"
      ? {
          status: "COMPLETED",
          acceptanceStatus: "ACCEPTED",
          completedAt: now,
        }
      : input.action === "REQUEST_EVIDENCE"
        ? { status: "IN_PROGRESS", acceptanceStatus: "EVIDENCE_REQUESTED" }
        : input.action === "RE_EXECUTE"
          ? {
              status: "OPEN",
              acceptanceStatus: "RE_EXECUTE_REQUESTED",
              taskId: null,
              botRunId: null,
              startedAt: null,
              completedAt: null,
              resultStatus: null,
              resultSummary: null,
              evidence: [],
              blockedReason: null,
            }
          : {
              status: "BLOCKED",
              acceptanceStatus:
                input.action === "REJECT"
                  ? "REJECTED"
                  : input.action === "CANCEL"
                    ? "CANCELLED"
                    : "BLOCKED",
              blockedReason: comment ?? (input.action === "CANCEL" ? "Cancelled by CEO." : null),
              completedAt: now,
            };
  const result = await prisma.$transaction(async (tx) => {
    const acceptance = await tx.meetingActionAcceptance.create({
      data: {
        meetingId: input.meetingId,
        actionItemId: action.id,
        actorUserId: input.userId,
        actorName: actor.name,
        action: input.action,
        comment,
        clientNonce: input.clientNonce,
      },
    });
    await tx.meetingActionItem.update({ where: { id: action.id }, data: update });
    return acceptance;
  });
  void result;
  return loadActionForView(prisma, action.id);
}

function approvalActionStatus(action: MeetingApprovalAction): string {
  if (action === "APPROVE") return "APPROVED";
  if (action === "APPROVE_WITH_CONDITIONS") return "APPROVED_WITH_CONDITIONS";
  if (action === "REJECT") return "REJECTED";
  return "DEFERRED";
}

/**
 * The CEO's meeting-native approval. It records one immutable transition from
 * PENDING to a final status. It never changes meeting status, transcript,
 * turns, payments or Bot runs.
 */
export async function approveMeetingDecision(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    meetingId: string;
    decisionId: string;
    action: MeetingApprovalAction;
    rationale?: string;
    conditions?: string;
    clientNonce: string;
  },
): Promise<MeetingDecisionApprovalResult> {
  await requireMeetingHuman(prisma, input.meetingId, input.spaceId, input.userId);
  const rationale = input.rationale?.trim() || null;
  const conditions = input.conditions?.trim() || null;
  if (input.action === "APPROVE_WITH_CONDITIONS" && !conditions) {
    throw new Error("Conditions are required for a conditional approval.");
  }
  if ((input.action === "REJECT" || input.action === "DEFER") && !rationale) {
    throw new Error("A rationale is required for rejection or deferral.");
  }
  const decision = await prisma.meetingDecision.findFirst({
    where: { id: input.decisionId, meetingId: input.meetingId },
    include: { approvals: { orderBy: { createdAt: "asc" } } },
  });
  if (!decision) throw new Error("Decision not found for this meeting.");
  if (!decision.approvalRequired) throw new Error("This decision does not require approval.");

  const existing = await prisma.meetingDecisionApproval.findUnique({
    where: {
      decisionId_clientNonce: {
        decisionId: input.decisionId,
        clientNonce: input.clientNonce,
      },
    },
  });
  if (existing) {
    if (
      existing.action !== input.action ||
      (existing.rationale ?? null) !== rationale ||
      (existing.conditions ?? null) !== conditions
    ) {
      throw new Error("This approval retry conflicts with the recorded approval.");
    }
    if (decision.approvalStatus === "APPROVED") {
      await prisma.meetingActionItem.updateMany({
        where: { decisionId: input.decisionId, activatedAt: null },
        data: { activatedAt: new Date() },
      });
    }
    return {
      approval: meetingDecisionApprovalView(existing),
      decision: meetingDecisionView(decision),
    };
  }
  if (decision.approvalStatus !== "PENDING") {
    throw new Error("This decision is already final.");
  }
  const newStatus = approvalActionStatus(input.action);
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { name: true },
  });
  if (!actor) throw new Error("Approving user was not found.");

  try {
    const approval = await prisma.$transaction(async (tx) => {
      const claimed = await tx.meetingDecision.updateMany({
        where: {
          id: input.decisionId,
          meetingId: input.meetingId,
          approvalStatus: "PENDING",
        },
        data: { approvalStatus: newStatus },
      });
      if (claimed.count !== 1) throw new Error("This decision is already final.");
      if (newStatus === "APPROVED") {
        await tx.meetingActionItem.updateMany({
          where: { decisionId: input.decisionId, activatedAt: null },
          data: { activatedAt: new Date() },
        });
      }
      return tx.meetingDecisionApproval.create({
        data: {
          meetingId: input.meetingId,
          decisionId: input.decisionId,
          actorUserId: input.userId,
          actorName: actor.name,
          action: input.action,
          previousStatus: "PENDING",
          newStatus,
          rationale,
          conditions,
          clientNonce: input.clientNonce,
        },
      });
    });
    const updated = await prisma.meetingDecision.findUniqueOrThrow({
      where: { id: input.decisionId },
      include: { approvals: { orderBy: { createdAt: "asc" } } },
    });
    return {
      approval: meetingDecisionApprovalView(approval),
      decision: meetingDecisionView(updated),
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.meetingDecisionApproval.findUniqueOrThrow({
      where: {
        decisionId_clientNonce: {
          decisionId: input.decisionId,
          clientNonce: input.clientNonce,
        },
      },
    });
    if (
      raced.action !== input.action ||
      (raced.rationale ?? null) !== rationale ||
      (raced.conditions ?? null) !== conditions
    ) {
      throw new Error("This approval retry conflicts with the recorded approval.");
    }
    const updated = await prisma.meetingDecision.findUniqueOrThrow({
      where: { id: input.decisionId },
      include: { approvals: { orderBy: { createdAt: "asc" } } },
    });
    return {
      approval: meetingDecisionApprovalView(raced),
      decision: meetingDecisionView(updated),
    };
  }
}

function buildFormalMinutes(meeting: Omit<MeetingView, "formalMinutes">): string | null {
  if (!meeting.decisions.length) return null;
  const lines: string[] = [];
  lines.push(`FORMAL MEETING MINUTES`);
  lines.push(`Meeting: ${meeting.title}`);
  lines.push(`Objective: ${meeting.description}`);
  lines.push(`Chair: ${meeting.chairBotName}`);
  lines.push(
    `Opened: ${meeting.startedAt ?? meeting.createdAt}; Closed: ${meeting.completedAt ?? "not closed"}`,
  );
  lines.push("");
  lines.push("PARTICIPANTS");
  for (const human of meeting.humanParticipants) {
    lines.push(`- ${human.userName} — ${human.role.replaceAll("_", " ")}`);
  }
  for (const bot of meeting.participants) {
    lines.push(`- ${bot.botName} — ${bot.role}`);
  }
  lines.push("");
  lines.push("AGENDA AND CHAIR DISCUSSIONS");
  for (const agenda of meeting.agenda) {
    const decision = meeting.decisions.find((item) => item.agendaId === agenda.id);
    const turns = meeting.turns.filter(
      (turn) =>
        turn.agendaId === agenda.id && turn.phase !== "AGENDA_DECISION" && turn.phase !== "SUMMARY",
    );
    const rounds = Math.max(1, ...turns.map((turn) => turn.round));
    const responses = turns.filter(
      (turn) => turn.phase === "AGENDA_RESPONSE" && turn.status === "COMPLETED",
    ).length;
    lines.push(
      `${agenda.sequence}. ${agenda.title} — status ${agenda.status}; rounds ${rounds}/${agenda.maxDiscussionRounds}; completed participant responses ${responses}.`,
    );
    if (!decision) {
      lines.push("   Decision: not yet recorded.");
      continue;
    }
    lines.push(`   Discussion state: ${decision.discussionState}.`);
    lines.push(`   Chair recommendation (Bot, not CEO approval): ${decision.decisionText}`);
    lines.push(`   Basis: ${decision.rationale}`);
    if (decision.supportingOpinions.length) {
      lines.push(`   Supporting opinions: ${decision.supportingOpinions.join("; ")}`);
    }
    if (decision.dissentingOpinions.length) {
      lines.push(`   Opposing opinions: ${decision.dissentingOpinions.join("; ")}`);
    }
    if (decision.risks.length) lines.push(`   Unresolved risks: ${decision.risks.join("; ")}`);
    if (decision.evidenceGaps.length) {
      lines.push(`   Evidence gaps: ${decision.evidenceGaps.join("; ")}`);
    }
    lines.push(
      `   CEO approval: ${decision.approvalStatus.replaceAll("_", " ")} (${decision.approvalRequired ? "required" : "not required"}).`,
    );
    for (const approval of decision.approvalHistory) {
      lines.push(
        `   Approval record: ${approval.actorName} — ${approval.action} at ${approval.createdAt}.`,
      );
      if (approval.rationale) lines.push(`     Rationale: ${approval.rationale}`);
      if (approval.conditions) lines.push(`     Conditions: ${approval.conditions}`);
    }
  }
  lines.push("");
  lines.push("CHAIR'S MEETING SUMMARY (Bot)");
  lines.push(meeting.meetingSummary ?? "(not published)");
  lines.push("");
  lines.push("ACTION ITEMS");
  const actionCounts = {
    open: meeting.actionItems.filter((item) => item.executionStatus === "OPEN").length,
    inProgress: meeting.actionItems.filter((item) => item.executionStatus === "IN_PROGRESS").length,
    completed: meeting.actionItems.filter((item) => item.executionStatus === "COMPLETED").length,
    blocked: meeting.actionItems.filter((item) => item.executionStatus === "BLOCKED").length,
  };
  lines.push(
    `Progress: ${actionCounts.open} open; ${actionCounts.inProgress} in progress; ${actionCounts.completed} completed; ${actionCounts.blocked} blocked.`,
  );
  if (!meeting.actionItems.length) {
    lines.push("- None recorded.");
  } else {
    for (const item of meeting.actionItems) {
      const decision = meeting.decisions.find((candidate) => candidate.id === item.decisionId);
      const agenda = meeting.agenda.find((candidate) => candidate.id === decision?.agendaId);
      lines.push(
        `- ${item.title} — assignee ${item.assigneeBotName ?? item.assigneeUserName ?? "unassigned"}; agenda ${agenda?.sequence ?? "?"} ${agenda?.title ?? ""}; status ${item.executionStatus}; due ${item.dueAt ?? "not set"}.`,
      );
      if (item.acceptanceCriteria) {
        lines.push(`  Acceptance criterion: ${item.acceptanceCriteria}`);
      }
      if (item.resultStatus) {
        lines.push(`  Result: ${item.resultStatus} — ${item.resultSummary ?? "no summary"}`);
      }
      if (item.evidence.length) lines.push(`  Evidence: ${item.evidence.join("; ")}`);
      if (item.blockedReason) lines.push(`  Blocked reason: ${item.blockedReason}`);
      if (item.acceptanceStatus) lines.push(`  CEO acceptance: ${item.acceptanceStatus}`);
      for (const acceptance of item.acceptanceHistory) {
        lines.push(
          `  Acceptance record: ${acceptance.actorName} — ${acceptance.action} at ${acceptance.createdAt}${acceptance.comment ? ` — ${acceptance.comment}` : ""}`,
        );
      }
    }
  }
  lines.push("");
  lines.push("UNRESOLVED RISKS AND EVIDENCE GAPS");
  const risks = [...new Set(meeting.decisions.flatMap((decision) => decision.risks))];
  const gaps = [...new Set(meeting.decisions.flatMap((decision) => decision.evidenceGaps))];
  lines.push(
    risks.length ? risks.map((risk) => `- Risk: ${risk}`).join("\n") : "- No risk recorded.",
  );
  lines.push(
    gaps.length ? gaps.map((gap) => `- Gap: ${gap}`).join("\n") : "- No evidence gap recorded.",
  );
  return lines.join("\n");
}

function meetingActionView(
  item: {
    id: string;
    meetingId: string;
    decisionId: string | null;
    title: string;
    description: string;
    acceptanceCriteria: string;
    assigneeBotId: string | null;
    assigneeBot: { name: string } | null;
    assigneeUserId: string | null;
    activatedAt: Date | null;
    taskId: string | null;
    botRunId: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    resultStatus: string | null;
    resultSummary: string | null;
    evidence: unknown;
    blockedReason: string | null;
    acceptanceStatus: string | null;
    dueAt: Date | null;
    status: string;
    createdAt: Date;
    decision: { agendaId: string | null } | null;
    executionAttempts: Array<{
      id: string;
      sourceId: string;
      attemptNumber: number;
      taskId: string | null;
      runId: string | null;
      status: string;
      resultStatus: string | null;
      resultSummary: string | null;
      evidence: unknown;
      error: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }>;
    attempts: Array<{
      id: string;
      actionItemId: string;
      attemptNumber: number;
      taskId: string | null;
      botRunId: string | null;
      status: string;
      resultStatus: string | null;
      resultSummary: string | null;
      evidence: unknown;
      error: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
    }>;
    acceptances: Array<{
      id: string;
      actionItemId: string;
      action: string;
      actorUserId: string;
      actorName: string;
      comment: string | null;
      createdAt: Date;
    }>;
  },
  assigneeUserName: string | null,
): MeetingActionItemView {
  return {
    id: item.id,
    meetingId: item.meetingId,
    decisionId: item.decisionId,
    agendaId: item.decision?.agendaId ?? null,
    title: item.title,
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    assigneeBotId: item.assigneeBotId,
    assigneeBotName: item.assigneeBot?.name ?? null,
    assigneeUserId: item.assigneeUserId,
    assigneeUserName,
    activatedAt: item.activatedAt?.toISOString() ?? null,
    taskId: item.taskId,
    botRunId: item.botRunId,
    startedAt: item.startedAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
    resultStatus: item.resultStatus as MeetingActionItemView["resultStatus"],
    resultSummary: item.resultSummary,
    evidence: stringArray(item.evidence),
    blockedReason: item.blockedReason,
    acceptanceStatus: item.acceptanceStatus,
    acceptanceHistory: item.acceptances.map((acceptance) => ({
      id: acceptance.id,
      actionItemId: acceptance.actionItemId,
      action: acceptance.action as MeetingActionItemView["acceptanceHistory"][number]["action"],
      actorUserId: acceptance.actorUserId,
      actorName: acceptance.actorName,
      comment: acceptance.comment,
      createdAt: acceptance.createdAt.toISOString(),
    })),
    attempts: item.executionAttempts.map((attempt) => ({
      id: attempt.id,
      actionItemId: item.id,
      attemptNumber: attempt.attemptNumber,
      taskId: attempt.taskId,
      botRunId: attempt.runId,
      status: attempt.status as "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED",
      resultStatus: attempt.resultStatus as MeetingActionItemView["resultStatus"],
      resultSummary: attempt.resultSummary,
      evidence: stringArray(attempt.evidence),
      error: attempt.error,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      completedAt: attempt.completedAt?.toISOString() ?? null,
      createdAt: attempt.createdAt.toISOString(),
    })),
    dueAt: item.dueAt?.toISOString() ?? null,
    executionStatus: item.status as MeetingActionItemView["executionStatus"],
    status: item.status,
    createdAt: item.createdAt.toISOString(),
  };
}

export async function getMeetingView(
  prisma: PrismaClient,
  spaceId: string,
  meetingId: string,
): Promise<MeetingView | null> {
  const row = await prisma.meeting.findFirst({
    where: { id: meetingId, spaceId },
    include: MEETING_INCLUDE,
  });
  if (!row) return null;
  const humanIds = [
    ...row.humanParticipants.map((item) => item.userId),
    ...row.actionItems.map((item) => item.assigneeUserId).filter((id): id is string => Boolean(id)),
  ];
  const humans = humanIds.length
    ? await prisma.user.findMany({
        where: { id: { in: humanIds } },
        select: { id: true, name: true },
      })
    : [];
  const humanNames = new Map(humans.map((human) => [human.id, human.name]));
  const currentAgenda = row.agenda.find(
    (item) => item.status !== "DECIDED" && item.status !== "DEFERRED",
  );
  const view: Omit<MeetingView, "formalMinutes"> = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as MeetingStatus,
    chairBotId: row.chairBotId,
    chairBotName: row.chairBot.name,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    currentAgendaId: currentAgenda?.id ?? null,
    meetingSummary: row.meetingSummary,
    error: row.error,
    participants: row.participants.map((participant) => ({
      id: participant.id,
      botId: participant.botId,
      botName: participant.bot.name,
      role: participant.role,
      responsibilities: participant.responsibilities,
      status: participant.status,
    })),
    humanParticipants: row.humanParticipants.map((participant) => ({
      id: participant.id,
      userId: participant.userId,
      userName: humanNames.get(participant.userId) ?? "Human CEO",
      role: participant.role as "HUMAN_CEO",
      createdAt: participant.createdAt.toISOString(),
    })),
    agenda: row.agenda.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      title: item.title,
      description: item.description,
      timeLimitSeconds: item.timeLimitSeconds,
      maxDiscussionRounds: item.maxDiscussionRounds,
      status: item.status,
      decision: item.decision,
    })),
    turns: row.turns.map((turn) => ({
      id: turn.id,
      agendaId: turn.agendaId,
      participantBotId: turn.participantBotId,
      participantBotName: turn.participantBot.name,
      phase: turn.phase,
      round: turn.round,
      content: turn.content,
      evidence: turn.evidence,
      status: turn.status,
      createdAt: turn.createdAt.toISOString(),
    })),
    decisions: row.decisions.map(meetingDecisionView),
    actionItems: row.actionItems.map((item) =>
      meetingActionView(
        item,
        item.assigneeUserId ? (humanNames.get(item.assigneeUserId) ?? "Human owner") : null,
      ),
    ),
  };
  return { ...view, formalMinutes: buildFormalMinutes(view) };
}

export async function createMeeting(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    userId: string;
    title: string;
    description: string;
    chairBotId: string;
    participantBotIds: string[];
    agenda: Array<{ title: string; description: string; timeLimitSeconds: number }>;
  },
): Promise<string> {
  const botIds = [...new Set([input.chairBotId, ...input.participantBotIds])];
  const bots = await prisma.bot.findMany({
    where: { id: { in: botIds }, spaceId: input.spaceId, archivedAt: null },
    select: {
      id: true,
      name: true,
      description: true,
      spawnKey: true,
      thread: { select: { id: true } },
    },
  });
  if (bots.length !== botIds.length) throw new Error("A meeting participant is not in this space.");
  if (!input.participantBotIds.includes(input.chairBotId))
    throw new Error("The chair must also be a participant.");
  const chair = bots.find((bot) => bot.id === input.chairBotId);
  if (!chair) throw new Error("The chair is not available.");
  if (!chair.thread) throw new Error("The chair has no chat thread.");
  const agenda = input.agenda.map((item, index) => ({
    title: item.title.trim(),
    description: item.description.trim(),
    sequence: index + 1,
    timeLimitSeconds: Math.min(Math.max(item.timeLimitSeconds || 300, 30), 3_600),
  }));
  if (!agenda.length || agenda.some((item) => !item.title))
    throw new Error("Every agenda item needs a title.");
  return prisma.$transaction(async (tx) => {
    const participants = [];
    for (const botId of input.participantBotIds) {
      const bot = bots.find((candidate) => candidate.id === botId)!;
      if (!bot.thread) throw new Error("A participant has no chat thread.");
      const isChair = bot.id === chair.id;
      const isFinance = /finance/i.test(bot.name) || bot.spawnKey === "rabbitbots:finance";
      const isResearch = /research/i.test(bot.name) || bot.spawnKey === "rabbitbots:research";
      participants.push({
        botId: bot.id,
        threadId: bot.thread.id,
        role: isChair
          ? "Chairperson"
          : isFinance
            ? "Finance"
            : isResearch
              ? "Research"
              : "Participant",
        responsibilities: isChair
          ? "Chairs the meeting, frames the agenda, identifies disagreements and summarizes decisions."
          : isFinance
            ? "Revenue, cost, budget, cash flow, financial assumptions and financial risks."
            : isResearch
              ? "Market research, competitors, customer demand, external evidence and market risks."
              : bot.description || "Contributes evidence and recommendations.",
      });
    }
    const meeting = await tx.meeting.create({
      data: {
        spaceId: input.spaceId,
        createdBy: input.userId,
        title: input.title.trim(),
        description: input.description.trim(),
        chairBotId: chair.id,
        status: "DRAFT",
        agenda: { create: agenda },
        participants: { create: participants },
        humanParticipants: {
          create: { userId: input.userId, role: "HUMAN_CEO" },
        },
      },
      select: { id: true },
    });
    return meeting.id;
  });
}

export async function updateDraftMeeting(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    meetingId: string;
    title?: string;
    description?: string;
    agenda?: Array<{ title: string; description: string; timeLimitSeconds: number }>;
  },
): Promise<void> {
  const meeting = await prisma.meeting.findFirst({
    where: { id: input.meetingId, spaceId: input.spaceId, status: "DRAFT" },
    select: { id: true },
  });
  if (!meeting) throw new Error("Only a draft meeting can be edited.");
  await prisma.$transaction(async (tx) => {
    await tx.meeting.update({
      where: { id: meeting.id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      },
    });
    if (input.agenda) {
      await tx.meetingAgenda.deleteMany({ where: { meetingId: meeting.id } });
      await tx.meetingAgenda.createMany({
        data: input.agenda.map((item, index) => ({
          meetingId: meeting.id,
          title: item.title.trim(),
          description: item.description.trim(),
          sequence: index + 1,
          timeLimitSeconds: Math.min(Math.max(item.timeLimitSeconds || 300, 30), 3_600),
        })),
      });
    }
  });
}

/**
 * Periodic worker recovery: meetings can be left between a completed run and its
 * next delivery (worker crash, lost queue row, old release). A keyed job keeps one
 * outstanding reconciliation per meeting, and the handler is idempotent.
 */
export async function reconcileActiveMeetings(
  deps: MeetingDeps,
  options: { staleAfterMs?: number; take?: number; now?: Date } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const take = Math.min(Math.max(options.take ?? 100, 1), 500);
  const rows = await deps.prisma.meeting.findMany({
    where: {
      status: { in: [...ACTIVE_MEETING_STATUSES] },
      updatedAt: { lt: new Date(now.getTime() - staleAfterMs) },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true },
  });
  for (const row of rows) {
    await deps.jobs
      .enqueue(
        meetingReconcileJob(row.id, {
          keepExisting: true,
          replaceLockedBefore: new Date(now.getTime() - 5 * 60_000),
        }),
      )
      .catch((error) => getLogger().error("meeting recovery enqueue", error));
  }
  // Meeting actions execute after a meeting is terminal, so the meeting sweep
  // above does not cover their runs. Recover any action run left without a
  // result after a worker restart or a lost queue delivery.
  const actionRows = await deps.prisma.meetingActionItem.findMany({
    where: {
      status: "IN_PROGRESS",
      resultStatus: null,
      botRunId: { not: null },
      startedAt: { lt: new Date(now.getTime() - staleAfterMs) },
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true },
  });
  for (const row of actionRows) {
    await deps.jobs
      .enqueue(meetingActionReconcileJob(row.id))
      .catch((error) => getLogger().error("meeting action recovery enqueue", error));
  }
  await reconcileActiveWorkforceTasks(deps, { staleAfterMs, take, now }).catch((error) =>
    getLogger().error("workforce task recovery", error),
  );
}

export async function startMeeting(
  deps: MeetingDeps,
  input: { spaceId: string; meetingId: string },
): Promise<MeetingView> {
  const meeting = await deps.prisma.meeting.findFirst({
    where: { id: input.meetingId, spaceId: input.spaceId },
    include: { agenda: true, participants: true },
  });
  if (!meeting) throw new Error("Meeting not found.");
  if (meeting.status !== "DRAFT")
    return (await getMeetingView(deps.prisma, input.spaceId, meeting.id))!;
  if (!meeting.agenda.length) throw new Error("A meeting needs at least one agenda item.");
  if (!meeting.participants.some((participant) => participant.botId === meeting.chairBotId))
    throw new Error("The chair must be a participant.");
  if (meeting.participants.length < 2)
    throw new Error("A meeting needs at least two participants.");
  const now = new Date();
  const agendaSeconds = meeting.agenda.reduce(
    (total, item) => total + Math.max(item.timeLimitSeconds, 30),
    0,
  );
  const deadlineAt = new Date(
    now.getTime() + Math.min(agendaSeconds, MEETING_MAX_TOTAL_SECONDS) * 1_000,
  );
  const claimed = await deps.prisma.meeting.updateMany({
    where: { id: meeting.id, spaceId: input.spaceId, status: "DRAFT" },
    data: { status: "PREPARING", startedAt: now, deadlineAt, error: null },
  });
  if (!claimed.count) {
    // A duplicate start returns the one persisted meeting; it never starts a second execution.
    return (await getMeetingView(deps.prisma, input.spaceId, meeting.id))!;
  }
  // Persist the start, then let the worker own every execution step. No browser
  // poll is needed for the opening or any later stage.
  await deps.jobs.enqueue(meetingReconcileJob(meeting.id)).catch((error) => {
    // The PREPARING row and the periodic meeting recovery scan are durable; a
    // transient queue outage must not roll back the start.
    getLogger().error("meeting start reconciliation enqueue", error);
  });
  return (await getMeetingView(deps.prisma, input.spaceId, meeting.id))!;
}

export async function cancelMeeting(
  deps: MeetingDeps,
  input: { spaceId: string; meetingId: string; reason?: string },
): Promise<MeetingView | null> {
  const reason = input.reason?.trim() || "Cancelled from the Executive Boardroom.";
  const outcome = await deps.prisma.$transaction(async (tx) => {
    // Serialize cancellation with itself; a late orchestration write is blocked by
    // the terminal status checks in the stage functions.
    await tx.$queryRaw`SELECT id FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
    const meeting = await tx.meeting.findFirst({
      where: { id: input.meetingId, spaceId: input.spaceId },
      select: { id: true, status: true },
    });
    if (!meeting) return null;
    if (TERMINAL_MEETING_STATUSES.has(meeting.status as MeetingStatus)) {
      return { changed: false, runIds: [] as string[] };
    }
    if (!canTransitionMeeting(meeting.status, "CANCELLED")) {
      return { changed: false, runIds: [] as string[] };
    }
    const now = new Date();
    const turns = await tx.meetingTurn.findMany({
      where: { meetingId: meeting.id, runId: { not: null } },
      select: { runId: true },
    });
    const runIds = [...new Set(turns.flatMap((turn) => (turn.runId ? [turn.runId] : [])))];
    const runs = runIds.length
      ? await tx.run.findMany({
          where: {
            id: { in: runIds },
            spaceId: input.spaceId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: { id: true, taskId: true, userId: true, spaceId: true },
        })
      : [];
    await tx.meeting.update({
      where: { id: meeting.id },
      data: {
        status: "CANCELLED",
        completedAt: now,
        cancelledAt: now,
        cancellationReason: reason,
        error: `Cancelled: ${reason}`,
      },
    });
    const cancelled = await cancelRunsInTransaction(tx, runs, now);
    return { changed: true, runIds: cancelled.map((run) => run.id) };
  });
  if (!outcome) return null;
  if (outcome.changed) {
    // Stop future meeting jobs and the execution jobs of runs that were active
    // when cancellation committed. A run status is the durable gate; queue
    // removal is best effort.
    await deps.jobs.cancel(meetingReconcileJobKey(input.meetingId)).catch((error) => {
      getLogger().error("meeting cancellation job removal", error);
    });
    await Promise.all(
      outcome.runIds.map((runId) =>
        deps.jobs.cancel(runJobKey(runId)).catch((error) => {
          getLogger().error("meeting cancellation run job removal", error);
        }),
      ),
    );
  }
  return getMeetingView(deps.prisma, input.spaceId, input.meetingId);
}

/**
 * Claim one meeting reconciliation lease. Two queued deliveries for the same
 * meeting must not both create turns or decide a round; the loser returns and
 * the completed stage's run hook schedules the next pass. An expired lease is
 * reclaimable after a worker crash.
 */
export async function reconcileMeeting(deps: MeetingDeps, meetingId: string): Promise<void> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 90_000);
  const claimed = await deps.prisma.meeting.updateMany({
    where: {
      id: meetingId,
      status: { in: [...ACTIVE_MEETING_STATUSES] },
      OR: [{ reconcileLeaseUntil: null }, { reconcileLeaseUntil: { lte: now } }],
    },
    data: { reconcileLeaseUntil: leaseUntil },
  });
  if (!claimed.count) return;
  try {
    await advanceMeeting(deps, meetingId);
  } finally {
    await deps.prisma.meeting
      .updateMany({
        where: { id: meetingId, reconcileLeaseUntil: leaseUntil },
        data: { reconcileLeaseUntil: null },
      })
      .catch((error) => getLogger().error("meeting reconcile lease release", error));
  }
}

/** Advance exactly one persisted step. Safe to poll repeatedly; duplicate runs are prevented by nonce. */
export async function advanceMeeting(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await deps.prisma.meeting.findUnique({
    where: { id: meetingId },
    include: { agenda: { orderBy: { sequence: "asc" } }, participants: true },
  });
  if (!meeting || TERMINAL_MEETING_STATUSES.has(meeting.status as MeetingStatus)) return;
  if (meeting.status === "DRAFT") return;
  await syncReportTurns(deps, meetingId);
  const now = Date.now();
  if (
    meeting.deadlineAt &&
    now >= meeting.deadlineAt.getTime() &&
    !["CLOSING"].includes(meeting.status)
  ) {
    const reports = await deps.prisma.meetingTurn.findMany({
      where: { meetingId, phase: "REPORTING" },
      select: { content: true, status: true },
    });
    const hasReport = reports.some(
      (report) => report.status === "COMPLETED" && report.content.trim(),
    );
    if (!hasReport) {
      await deps.prisma.meeting.update({
        where: { id: meetingId },
        data: {
          status: "FAILED",
          error: "Meeting deadline reached before any participant report.",
        },
      });
      return;
    }
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { error: "Meeting deadline reached; remaining agendas are recorded DEFERRED." },
    });
    await expireRemainingAgendas(
      deps,
      meetingId,
      "The meeting deadline was reached before this agenda completed.",
    );
  }
  try {
    const current = await deps.prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    switch (current.status) {
      case "PREPARING":
        await beginOpening(deps, meetingId);
        break;
      case "OPENING":
        await finishOpening(deps, meetingId);
        break;
      case "REPORTING":
        await finishReporting(deps, meetingId);
        break;
      case "DISCUSSION":
        await advanceAgendaLoop(deps, meetingId);
        break;
      case "DECISION":
        // A legacy in-flight decision resumes the agenda loop rather than
        // writing one combined decision.
        await advanceAgendaLoop(deps, meetingId);
        break;
      case "CLOSING":
        await beginSummary(deps, meetingId);
        break;
      default:
        break;
    }
  } catch (error) {
    getLogger().error("meeting advance failed", error);
    await deps.prisma.meeting
      .updateMany({
        where: { id: meetingId, status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] } },
        data: {
          status: "FAILED",
          error: "Meeting execution failed; see the persisted transcript.",
        },
      })
      .catch(() => undefined);
  }
}

async function setMeetingStatus(
  prisma: PrismaClient,
  meetingId: string,
  next: MeetingStatus,
): Promise<void> {
  const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  if (!canTransitionMeeting(meeting.status, next)) return;
  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      status: next,
      ...(next === "CLOSING" || next === "COMPLETED" ? { completedAt: new Date() } : {}),
    },
  });
}

async function beginOpening(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await deps.prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    include: { agenda: { orderBy: { sequence: "asc" } }, participants: true },
  });
  const chair = meeting.participants.find(
    (participant) => participant.botId === meeting.chairBotId,
  );
  if (!chair) throw new Error("Chair is missing.");
  const existing = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId, phase: "OPENING" },
    select: { id: true, runId: true },
  });
  const runId =
    existing?.runId ??
    (await createTurnRun(deps, {
      meeting,
      participant: chair,
      phase: "OPENING",
      round: 1,
      agendaId: null,
      prompt: openingPrompt(meeting),
    }));
  await deps.prisma.meeting.update({
    where: { id: meetingId },
    data: { status: "OPENING" },
  });
  await enqueueRun(deps.jobs, runId);
}

async function finishOpening(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await deps.prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    include: { agenda: { orderBy: { sequence: "asc" } }, participants: true },
  });
  const turn = await deps.prisma.meetingTurn.findFirst({ where: { meetingId, phase: "OPENING" } });
  if (!turn?.runId) return;
  const run = await deps.prisma.run.findUnique({ where: { id: turn.runId } });
  if (!run) return;
  if (ACTIVE_RUN_STATUSES.includes(run.status as never)) {
    await enqueueRun(deps.jobs, run.id);
    return;
  }
  if (run.status === "failed" || run.status === "cancelled") {
    await deps.prisma.meetingParticipant.updateMany({
      where: { meetingId, botId: meeting.chairBotId },
      data: { status: "FAILED" },
    });
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "FAILED", error: "The chair could not open the meeting." },
    });
    return;
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return;
  const outcome = await readRunOutcome(deps.prisma, run.id);
  await deps.prisma.meetingTurn.update({
    where: { id: turn.id },
    data: { content: outcome.text, status: "COMPLETED", evidence: extractEvidence(outcome.text) },
  });
  await deps.prisma.meetingParticipant.updateMany({
    where: { meetingId, botId: meeting.chairBotId },
    data: { status: "DONE" },
  });
  await setMeetingStatus(deps.prisma, meetingId, "REPORTING");
  await beginReports(deps, meetingId);
}

async function beginReports(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await deps.prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    include: { agenda: { orderBy: { sequence: "asc" } }, participants: true },
  });
  const reporters = meeting.participants.filter(
    (participant) => participant.botId !== meeting.chairBotId,
  );
  for (const participant of reporters) {
    const existing = await deps.prisma.meetingTurn.findFirst({
      where: { meetingId, phase: "REPORTING", participantBotId: participant.botId, round: 1 },
      select: { runId: true },
    });
    if (existing?.runId) continue;
    const runId = await createTurnRun(deps, {
      meeting,
      participant,
      phase: "REPORTING",
      round: 1,
      agendaId: meeting.agenda[0]?.id ?? null,
      prompt: reportingPrompt(meeting, participant),
    });
    await enqueueRun(deps.jobs, runId);
  }
}

/** Persist completed report runs even while another participant is still working. */
async function syncReportTurns(deps: MeetingDeps, meetingId: string): Promise<void> {
  const turns = await deps.prisma.meetingTurn.findMany({
    where: { meetingId, phase: "REPORTING", status: "PENDING" },
  });
  for (const turn of turns) {
    if (!turn.runId) continue;
    const run = await deps.prisma.run.findUnique({ where: { id: turn.runId } });
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const outcome = await readRunOutcome(deps.prisma, run.id);
    const failed =
      run.status === "failed" ||
      run.status === "cancelled" ||
      !outcome.text.trim() ||
      !meetingTextFits(outcome.text, "DISCUSSION_RESPONSE");
    await deps.prisma.meetingTurn.update({
      where: { id: turn.id },
      data: {
        content: outcome.text || `Participant failed: ${run.error ?? "no output"}`,
        status: failed ? "FAILED" : "COMPLETED",
        evidence: extractEvidence(outcome.text),
      },
    });
    await deps.prisma.meetingParticipant.updateMany({
      where: { meetingId, botId: turn.participantBotId },
      data: { status: failed ? "FAILED" : "DONE" },
    });
  }
}

async function finishReporting(deps: MeetingDeps, meetingId: string): Promise<void> {
  const turns = await deps.prisma.meetingTurn.findMany({
    where: { meetingId, phase: "REPORTING" },
  });
  const terminal = await Promise.all(
    turns.map(async (turn) => {
      if (!turn.runId) return { turn, done: false, run: null };
      const run = await deps.prisma.run.findUnique({ where: { id: turn.runId } });
      return { turn, done: run ? TERMINAL_RUN_STATUSES.has(run.status) : true, run };
    }),
  );
  if (terminal.some((entry) => !entry.done)) {
    for (const entry of terminal) {
      if (entry.run && ACTIVE_RUN_STATUSES.includes(entry.run.status as never)) {
        await enqueueRun(deps.jobs, entry.run.id);
      }
    }
    return;
  }
  const reports: string[] = [];
  let failedReports = 0;
  for (const entry of terminal) {
    if (!entry.run) {
      failedReports += 1;
      await deps.prisma.meetingTurn.update({
        where: { id: entry.turn.id },
        data: { status: "FAILED", content: "No participant run was recorded." },
      });
      continue;
    }
    const outcome = await readRunOutcome(deps.prisma, entry.run.id);
    const failed =
      entry.run.status === "failed" ||
      entry.run.status === "cancelled" ||
      !outcome.text.trim() ||
      !meetingTextFits(outcome.text, "REPORTING");
    await deps.prisma.meetingTurn.update({
      where: { id: entry.turn.id },
      data: {
        content: outcome.text || `Participant failed: ${entry.run.error ?? "no output"}`,
        status: failed ? "FAILED" : "COMPLETED",
        evidence: extractEvidence(outcome.text),
      },
    });
    await deps.prisma.meetingParticipant.updateMany({
      where: { meetingId, botId: entry.turn.participantBotId },
      data: { status: failed ? "FAILED" : "DONE" },
    });
    if (failed) failedReports += 1;
    else reports.push(outcome.text);
  }
  if (!reports.length) {
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "FAILED", error: "No participant produced a usable report." },
    });
    return;
  }
  if (failedReports > 0) {
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { error: `${failedReports} participant report(s) failed; the meeting is partial.` },
    });
  }
  // Each agenda now has its own review; the old global disagreement gate is
  // intentionally not used to decide whether the whole meeting discusses.
  await setMeetingStatus(deps.prisma, meetingId, "DISCUSSION");
  await advanceAgendaLoop(deps, meetingId);
}

type AgendaMeeting = {
  id: string;
  spaceId: string;
  createdBy: string;
  title: string;
  description: string;
  chairBotId: string;
  agenda: Array<{
    id: string;
    sequence: number;
    title: string;
    description: string;
    status: string;
    maxDiscussionRounds: number;
  }>;
  participants: Array<{
    id: string;
    botId: string;
    threadId: string | null;
    role: string;
    responsibilities: string;
    bot: { name: string };
  }>;
};

export type AgendaReview = {
  materialDisagreement: boolean;
  state: string;
  reason: string;
  consensus: string[];
  disagreements: string[];
  evidenceGaps: string[];
  question: string;
  participants: string[];
};

export type AgendaDecisionOutput = {
  decisionType: MeetingDecisionType;
  decisionText: string;
  rationale: string;
  supportingEvidence: string[];
  supportingOpinions: string[];
  risks: string[];
  dissentingOpinions: string[];
  evidenceGaps: string[];
  conditions: string[];
  discussionState: string;
};

export type MeetingSummaryOutput = {
  summary: string;
  minutes: string;
  actionItems: Array<{
    title: string;
    description: string;
    assigneeRole: string;
    dueAt: string | null;
    agendaSequence: number | null;
    acceptanceCriteria: string;
  }>;
};

function reviewState(value: unknown, fallback: string): string {
  const normalized = stringValue(value).toUpperCase();
  return MEETING_DISCUSSION_STATES.includes(normalized as never) ? normalized : fallback;
}

function extractAgendaReview(text: string): AgendaReview | null {
  const material = text.match(/"materialDisagreement"\s*:\s*(true|false)/);
  if (!material) return null;
  const materialDisagreement = material[1] === "true";
  const reason = extractedJsonString(text, "reason", [
    "consensus",
    "disagreements",
    "evidenceGaps",
    "question",
    "participants",
  ]);
  const question = extractedJsonString(text, "question", ["participants"]);
  const participants = extractedJsonArray(text, "participants");
  if (materialDisagreement && !question) return null;
  return {
    materialDisagreement,
    state: reviewState(
      extractedJsonString(text, "state", ["reason"]),
      materialDisagreement ? "DISAGREEMENT" : "AGREEMENT",
    ),
    reason,
    consensus: extractedJsonArray(text, "consensus"),
    disagreements: extractedJsonArray(text, "disagreements"),
    evidenceGaps: extractedJsonArray(text, "evidenceGaps"),
    question,
    participants,
  };
}

export function parseAgendaReview(text: string): AgendaReview | null {
  const object = jsonObject(text);
  if (!object) return extractAgendaReview(text);
  const materialDisagreement = object.materialDisagreement === true;
  const reason = stringValue(object.reason);
  const question = stringValue(object.question);
  const participants = stringArray(object.participants);
  if (materialDisagreement && !question) return extractAgendaReview(text);
  return {
    materialDisagreement,
    state: reviewState(object.state, materialDisagreement ? "DISAGREEMENT" : "AGREEMENT"),
    reason,
    consensus: stringArray(object.consensus),
    disagreements: stringArray(object.disagreements),
    evidenceGaps: stringArray(object.evidenceGaps),
    question,
    participants,
  };
}

function extractedJsonString(text: string, key: string, nextKeys: string[]): string {
  const start = text.search(new RegExp(`"${key}"\\s*:\\s*"`));
  if (start < 0) return "";
  const rest = text.slice(text.indexOf(":", start) + 1).trimStart();
  if (!rest.startsWith('"')) return "";
  const body = rest.slice(1);
  const next = body.search(new RegExp(`"\\s*,\\s*"(?:${nextKeys.join("|")})"`));
  const raw = next >= 0 ? body.slice(0, next) : body.slice(0, body.lastIndexOf('"'));
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .trim();
}

function extractedJsonArray(text: string, key: string): string[] {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return [];
  return [...match[1]!.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((item) =>
      item[1]!
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Last-resort extraction for a provider that returned a correct decision object but
 * malformed JSON quoting. Fields are read verbatim from their named slots; nothing
 * is invented or truncated.
 */
function extractAgendaDecision(text: string): AgendaDecisionOutput | null {
  const type = text.match(/"decisionType"\s*:\s*"([^"]+)"/)?.[1]?.toUpperCase() as
    | MeetingDecisionType
    | undefined;
  if (!type || !MEETING_DECISION_TYPES.includes(type)) return null;
  const decisionText = extractedJsonString(text, "decisionText", [
    "rationale",
    "supportingEvidence",
    "risks",
    "dissentingOpinions",
    "conditions",
  ]);
  const rationale = extractedJsonString(text, "rationale", [
    "supportingEvidence",
    "risks",
    "dissentingOpinions",
    "conditions",
  ]);
  if (!decisionText || !rationale) return null;
  return {
    decisionType: type,
    decisionText,
    rationale,
    supportingEvidence: extractedJsonArray(text, "supportingEvidence"),
    supportingOpinions: extractedJsonArray(text, "supportingOpinions"),
    risks: extractedJsonArray(text, "risks"),
    dissentingOpinions: extractedJsonArray(text, "dissentingOpinions"),
    evidenceGaps: extractedJsonArray(text, "evidenceGaps"),
    conditions: extractedJsonArray(text, "conditions"),
    discussionState: reviewState(
      extractedJsonString(text, "discussionState", ["decisionType"]),
      type === "DEFERRED" ? "INSUFFICIENT_EVIDENCE" : "UNRESOLVED",
    ),
  };
}

export function parseAgendaDecision(text: string): AgendaDecisionOutput | null {
  const object = jsonObject(text);
  if (!object) return extractAgendaDecision(text);
  const type = stringValue(object.decisionType).toUpperCase() as MeetingDecisionType;
  if (!MEETING_DECISION_TYPES.includes(type)) return extractAgendaDecision(text);
  const decisionText = stringValue(object.decisionText);
  const rationale = stringValue(object.rationale);
  if (!decisionText || !rationale) return extractAgendaDecision(text);
  return {
    decisionType: type,
    decisionText,
    rationale,
    supportingEvidence: stringArray(object.supportingEvidence),
    supportingOpinions: stringArray(object.supportingOpinions),
    risks: stringArray(object.risks),
    dissentingOpinions: stringArray(object.dissentingOpinions),
    evidenceGaps: stringArray(object.evidenceGaps),
    conditions: stringArray(object.conditions),
    discussionState: reviewState(
      object.discussionState,
      type === "DEFERRED" ? "INSUFFICIENT_EVIDENCE" : "UNRESOLVED",
    ),
  };
}

function bracketEnd(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractActionItems(text: string): MeetingSummaryOutput["actionItems"] {
  const key = text.search(/"actionItems"\s*:\s*\[/);
  if (key < 0) return [];
  const start = text.indexOf("[", key);
  const end = bracketEnd(text, start, "[", "]");
  if (end < 0) return [];
  const region = text.slice(start + 1, end);
  const items: MeetingSummaryOutput["actionItems"] = [];
  let cursor = 0;
  while (cursor < region.length) {
    const objectStart = region.indexOf("{", cursor);
    if (objectStart < 0) break;
    const objectEnd = bracketEnd(region, objectStart, "{", "}");
    if (objectEnd < 0) break;
    const objectText = region.slice(objectStart, objectEnd + 1);
    const parsed = jsonObject(objectText);
    const title = parsed
      ? stringValue(parsed.title)
      : extractedJsonString(objectText, "title", [
          "description",
          "assigneeRole",
          "agendaSequence",
          "dueAt",
        ]);
    if (title) {
      const description = parsed
        ? stringValue(parsed.description)
        : extractedJsonString(objectText, "description", [
            "assigneeRole",
            "agendaSequence",
            "dueAt",
          ]);
      const role = parsed
        ? stringValue(parsed.assigneeRole) || stringValue(parsed.assignee)
        : extractedJsonString(objectText, "assigneeRole", ["agendaSequence", "dueAt"]);
      const sequenceMatch = objectText.match(/"agendaSequence"\s*:\s*(\d+)/);
      const due = parsed ? stringValue(parsed.dueAt) : extractedJsonString(objectText, "dueAt", []);
      const dueAt = due && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null;
      items.push({
        title,
        description,
        assigneeRole: role,
        dueAt,
        agendaSequence: sequenceMatch ? Number(sequenceMatch[1]) : null,
        acceptanceCriteria: extractedJsonString(objectText, "acceptanceCriteria", [
          "assigneeRole",
          "agendaSequence",
          "dueAt",
        ]),
      });
    }
    cursor = objectEnd + 1;
  }
  return items;
}

function extractMeetingSummary(text: string): MeetingSummaryOutput | null {
  const summary = extractedJsonString(text, "summary", ["minutes", "actionItems"]);
  const minutes = extractedJsonString(text, "minutes", ["actionItems"]);
  if (!summary || !minutes) return null;
  return { summary, minutes, actionItems: extractActionItems(text) };
}

export function parseMeetingSummary(text: string): MeetingSummaryOutput | null {
  const object = jsonObject(text);
  if (!object) return extractMeetingSummary(text);
  const summary = stringValue(object.summary);
  const minutes = stringValue(object.minutes);
  if (!summary || !minutes) return extractMeetingSummary(text);
  const rawActions = Array.isArray(object.actionItems) ? object.actionItems : [];
  const actionItems: MeetingSummaryOutput["actionItems"] = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = stringValue(item.title);
    if (!title) continue;
    const due = stringValue(item.dueAt);
    const dueAt = due && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null;
    const agendaSequence =
      typeof item.agendaSequence === "number" && Number.isFinite(item.agendaSequence)
        ? item.agendaSequence
        : null;
    actionItems.push({
      title,
      description: stringValue(item.description),
      assigneeRole: stringValue(item.assigneeRole) || stringValue(item.assignee),
      dueAt,
      agendaSequence,
      acceptanceCriteria: stringValue(item.acceptanceCriteria),
    });
  }
  return { summary, minutes, actionItems };
}

async function loadAgendaMeeting(prisma: PrismaClient, meetingId: string): Promise<AgendaMeeting> {
  return prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    include: {
      agenda: { orderBy: { sequence: "asc" } },
      participants: { include: { bot: { select: { name: true } } } },
    },
  });
}

async function agendaReports(
  prisma: PrismaClient,
  meetingId: string,
): Promise<{
  turns: Array<{ participantBotId: string; content: string }>;
  texts: string[];
  eligible: Set<string>;
}> {
  const turns = await prisma.meetingTurn.findMany({
    where: { meetingId, phase: "REPORTING" },
    orderBy: { createdAt: "asc" },
  });
  const completed = turns.filter((turn) => turn.status === "COMPLETED" && turn.content.trim());
  return {
    turns: completed.map((turn) => ({
      participantBotId: turn.participantBotId,
      content: turn.content,
    })),
    texts: completed.map((turn) => turn.content),
    eligible: new Set(completed.map((turn) => turn.participantBotId)),
  };
}

async function priorAgendaDecisions(
  prisma: PrismaClient,
  meeting: AgendaMeeting,
  currentAgendaId: string,
): Promise<string> {
  const decisions = await prisma.meetingDecision.findMany({
    where: { meetingId: meeting.id, agendaId: { not: currentAgendaId } },
    orderBy: { createdAt: "asc" },
  });
  if (!decisions.length) return "(none)";
  return decisions
    .map((decision) => {
      const agenda = meeting.agenda.find((item) => item.id === decision.agendaId);
      return `Agenda ${agenda?.sequence ?? "?"} (${agenda?.title ?? "unknown"}): ${decision.decisionType} — ${decision.decisionText}`;
    })
    .join("\n");
}

async function syncAgendaRunTurn(
  deps: MeetingDeps,
  turn: { id: string; runId: string | null; phase: string; agendaId: string | null },
): Promise<{ terminal: boolean; text: string; failed: boolean }> {
  if (!turn.runId) {
    const stored = await deps.prisma.meetingTurn.findUnique({ where: { id: turn.id } });
    return {
      terminal: true,
      text: stored?.content ?? "",
      failed: stored?.status === "FAILED" || !stored?.content.trim(),
    };
  }
  const run = await deps.prisma.run.findUnique({ where: { id: turn.runId } });
  if (!run) return { terminal: true, text: "", failed: true };
  if (ACTIVE_RUN_STATUSES.includes(run.status as never)) {
    await enqueueRun(deps.jobs, run.id);
    return { terminal: false, text: "", failed: false };
  }
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { terminal: false, text: "", failed: false };
  const outcome = await readRunOutcome(deps.prisma, run.id);
  const failed =
    run.status === "failed" ||
    run.status === "cancelled" ||
    !outcome.text.trim() ||
    !meetingTextFits(outcome.text, turn.phase);
  await deps.prisma.meetingTurn.update({
    where: { id: turn.id },
    data: {
      content: outcome.text || `Participant failed: ${run.error ?? "no output"}`,
      status: failed ? "FAILED" : "COMPLETED",
      evidence: extractEvidence(outcome.text),
    },
  });
  return { terminal: true, text: outcome.text, failed };
}

async function markAgenda(
  prisma: PrismaClient,
  agendaId: string,
  status: string,
  decision?: string,
): Promise<void> {
  await prisma.meetingAgenda.update({
    where: { id: agendaId },
    data: { status, ...(decision ? { decision } : {}) },
  });
}

async function persistDeferredAgenda(
  prisma: PrismaClient,
  meetingId: string,
  agenda: AgendaMeeting["agenda"][number],
  reason: string,
): Promise<void> {
  await prisma.meetingDecision.upsert({
    where: { meetingId_agendaId: { meetingId, agendaId: agenda.id } },
    update: {},
    create: {
      meetingId,
      agendaId: agenda.id,
      decisionType: "DEFERRED",
      decisionText: "Deferred because this agenda could not produce a complete decision.",
      rationale: reason,
      supportingEvidence: [],
      risks: [],
      dissentingOpinions: [],
      conditions: [],
      approvalRequired: false,
      approvalStatus: "NOT_REQUIRED",
    },
  });
  await markAgenda(prisma, agenda.id, "DEFERRED", "Deferred");
}

async function createAgendaReviewRun(
  deps: MeetingDeps,
  meeting: AgendaMeeting,
  agenda: AgendaMeeting["agenda"][number],
  reports: string[],
  prior: string,
): Promise<void> {
  const chair = meeting.participants.find(
    (participant) => participant.botId === meeting.chairBotId,
  );
  if (!chair) throw new Error("Chair is missing.");
  const runId = await createTurnRun(deps, {
    meeting,
    participant: chair,
    phase: "AGENDA_REVIEW",
    round: 1,
    agendaId: agenda.id,
    prompt: agendaReviewPrompt(meeting, agenda, reports, prior),
  });
  await markAgenda(deps.prisma, agenda.id, "ACTIVE");
  await enqueueRun(deps.jobs, runId);
}

async function ensureAgendaResponses(
  deps: MeetingDeps,
  meeting: AgendaMeeting,
  agenda: AgendaMeeting["agenda"][number],
  round: number,
  selectedBotIds: string[],
  question: string,
  reports: Array<{ participantBotId: string; content: string }>,
  priorResponses: Array<{ participantBotId: string; content: string }> = [],
): Promise<{
  ready: boolean;
  responses: Array<{ participantBotId: string; content: string }>;
}> {
  for (const botId of selectedBotIds) {
    const participant = meeting.participants.find((candidate) => candidate.botId === botId);
    if (!participant) continue;
    const existing = await deps.prisma.meetingTurn.findFirst({
      where: {
        meetingId: meeting.id,
        agendaId: agenda.id,
        phase: "AGENDA_RESPONSE",
        participantBotId: botId,
        round,
      },
    });
    if (!existing) {
      const runId = await createTurnRun(deps, {
        meeting,
        participant,
        phase: "AGENDA_RESPONSE",
        round,
        agendaId: agenda.id,
        prompt: agendaParticipantPrompt(
          meeting,
          agenda,
          participant,
          question,
          reports,
          priorResponses,
        ),
      });
      await enqueueRun(deps.jobs, runId);
    }
  }
  const turns = await deps.prisma.meetingTurn.findMany({
    where: {
      meetingId: meeting.id,
      agendaId: agenda.id,
      phase: "AGENDA_RESPONSE",
      round,
      participantBotId: { in: selectedBotIds },
    },
    orderBy: { createdAt: "asc" },
  });
  let ready = true;
  for (const botId of selectedBotIds) {
    const turn = turns.find((candidate) => candidate.participantBotId === botId);
    if (!turn) {
      ready = false;
      continue;
    }
    const synced = await syncAgendaRunTurn(deps, turn);
    if (!synced.terminal) ready = false;
  }
  const finalTurns = await deps.prisma.meetingTurn.findMany({
    where: {
      meetingId: meeting.id,
      agendaId: agenda.id,
      phase: "AGENDA_RESPONSE",
      round,
      participantBotId: { in: selectedBotIds },
    },
    orderBy: { createdAt: "asc" },
  });
  return {
    ready,
    responses: finalTurns.map((turn) => ({
      participantBotId: turn.participantBotId,
      content: turn.content,
    })),
  };
}

async function createAgendaEvaluationRun(
  deps: MeetingDeps,
  meeting: AgendaMeeting,
  agenda: AgendaMeeting["agenda"][number],
  round: number,
  question: string,
  responses: Array<{ participantBotId: string; content: string }>,
): Promise<void> {
  const existing = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId: meeting.id, agendaId: agenda.id, phase: "AGENDA_EVALUATION", round },
  });
  if (existing?.runId) {
    await enqueueRun(deps.jobs, existing.runId);
    return;
  }
  const chair = meeting.participants.find(
    (participant) => participant.botId === meeting.chairBotId,
  );
  if (!chair) throw new Error("Chair is missing.");
  const runId = await createTurnRun(deps, {
    meeting,
    participant: chair,
    phase: "AGENDA_EVALUATION",
    round,
    agendaId: agenda.id,
    prompt: agendaEvaluationPrompt(meeting, agenda, question, responses),
  });
  await enqueueRun(deps.jobs, runId);
}

async function createAgendaDecisionRun(
  deps: MeetingDeps,
  meeting: AgendaMeeting,
  agenda: AgendaMeeting["agenda"][number],
  review: AgendaReview,
  responses: Array<{ participantBotId: string; content: string }>,
  evaluation: string,
  reports: string[],
  prior: string,
): Promise<void> {
  const existing = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId: meeting.id, agendaId: agenda.id, phase: "AGENDA_DECISION" },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }],
  });
  if (existing?.runId) {
    const synced = await syncAgendaRunTurn(deps, existing);
    if (!synced.terminal) return;
    const parsed = synced.failed ? null : parseAgendaDecision(synced.text);
    if (parsed) {
      await persistAgendaDecision(deps.prisma, meeting, agenda, parsed);
      await markAgenda(
        deps.prisma,
        agenda.id,
        parsed.decisionType === "DEFERRED" ? "DEFERRED" : "DECIDED",
        parsed.decisionText,
      );
      await advanceAgendaLoop(deps, meeting.id);
      return;
    }
    if (existing.round >= 2) {
      await persistDeferredAgenda(
        deps.prisma,
        meeting.id,
        agenda,
        "The chair did not produce a valid per-agenda decision after the bounded retry.",
      );
      await deps.prisma.meeting.update({
        where: { id: meeting.id },
        data: { error: `Agenda ${agenda.sequence} decision was invalid; recorded DEFERRED.` },
      });
      await advanceAgendaLoop(deps, meeting.id);
      return;
    }
    const chair = meeting.participants.find(
      (participant) => participant.botId === meeting.chairBotId,
    );
    if (!chair) throw new Error("Chair is missing.");
    const runId = await createTurnRun(deps, {
      meeting,
      participant: chair,
      phase: "AGENDA_DECISION",
      round: 2,
      agendaId: agenda.id,
      prompt: `${agendaDecisionPrompt(meeting, agenda, reports, review, responses, evaluation, prior)}\n\nYour previous answer was not valid JSON for this single agenda. Return only valid JSON now.`,
    });
    await enqueueRun(deps.jobs, runId);
    return;
  }

  const chair = meeting.participants.find(
    (participant) => participant.botId === meeting.chairBotId,
  );
  if (!chair) throw new Error("Chair is missing.");
  const runId = await createTurnRun(deps, {
    meeting,
    participant: chair,
    phase: "AGENDA_DECISION",
    round: 1,
    agendaId: agenda.id,
    prompt: agendaDecisionPrompt(meeting, agenda, reports, review, responses, evaluation, prior),
  });
  await enqueueRun(deps.jobs, runId);
}

async function persistAgendaDecision(
  prisma: PrismaClient,
  meeting: AgendaMeeting,
  agenda: AgendaMeeting["agenda"][number],
  decision: AgendaDecisionOutput,
): Promise<void> {
  const approvalRequired =
    decision.decisionType === "APPROVED" || decision.decisionType === "APPROVED_WITH_CONDITIONS";
  await prisma.meetingDecision.upsert({
    where: { meetingId_agendaId: { meetingId: meeting.id, agendaId: agenda.id } },
    update: {},
    create: {
      meetingId: meeting.id,
      agendaId: agenda.id,
      decisionType: decision.decisionType,
      decisionText: decision.decisionText,
      rationale: decision.rationale,
      supportingEvidence: decision.supportingEvidence,
      risks: decision.risks,
      dissentingOpinions: decision.dissentingOpinions,
      conditions: decision.conditions,
      discussionState: decision.discussionState,
      supportingOpinions: decision.supportingOpinions,
      evidenceGaps: decision.evidenceGaps,
      approvalRequired,
      approvalStatus: approvalRequired ? "PENDING" : "NOT_REQUIRED",
    },
  });
}

async function advanceAgendaLoop(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await loadAgendaMeeting(deps.prisma, meetingId);
  const agenda = meeting.agenda.find(
    (item) => item.status !== "DECIDED" && item.status !== "DEFERRED",
  );
  if (!agenda) {
    await setMeetingStatus(deps.prisma, meetingId, "CLOSING");
    await beginSummary(deps, meetingId);
    return;
  }
  const existingDecision = await deps.prisma.meetingDecision.findFirst({
    where: { meetingId, agendaId: agenda.id },
    select: { decisionType: true, decisionText: true },
  });
  if (existingDecision) {
    await markAgenda(
      deps.prisma,
      agenda.id,
      existingDecision.decisionType === "DEFERRED" ? "DEFERRED" : "DECIDED",
      existingDecision.decisionText,
    );
    await advanceAgendaLoop(deps, meetingId);
    return;
  }
  if (agenda.status === "PENDING") await markAgenda(deps.prisma, agenda.id, "ACTIVE");

  const reports = await agendaReports(deps.prisma, meetingId);
  if (!reports.texts.length) {
    await persistDeferredAgenda(
      deps.prisma,
      meetingId,
      agenda,
      "No completed participant report was available for this agenda.",
    );
    await advanceAgendaLoop(deps, meetingId);
    return;
  }
  const prior = await priorAgendaDecisions(deps.prisma, meeting, agenda.id);

  const review = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId, agendaId: agenda.id, phase: "AGENDA_REVIEW" },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }],
  });
  if (!review) {
    await createAgendaReviewRun(deps, meeting, agenda, reports.texts, prior);
    return;
  }
  const reviewSync = await syncAgendaRunTurn(deps, review);
  if (!reviewSync.terminal) return;
  if (reviewSync.failed) {
    await persistDeferredAgenda(
      deps.prisma,
      meetingId,
      agenda,
      "The chair could not complete the agenda review.",
    );
    await advanceAgendaLoop(deps, meetingId);
    return;
  }
  const reviewParsed = parseAgendaReview(reviewSync.text);
  if (!reviewParsed) {
    await persistDeferredAgenda(
      deps.prisma,
      meetingId,
      agenda,
      "The chair review did not return a usable structured review.",
    );
    await advanceAgendaLoop(deps, meetingId);
    return;
  }
  if (!reviewParsed.materialDisagreement) {
    await markAgenda(deps.prisma, agenda.id, "ACTIVE");
    await createAgendaDecisionRun(
      deps,
      meeting,
      agenda,
      reviewParsed,
      [],
      "",
      reports.texts,
      prior,
    );
    return;
  }
  await markAgenda(deps.prisma, agenda.id, "DISCUSSION");
  const selected = selectDiscussionParticipants(
    meeting.participants,
    reviewParsed.participants,
    reports.eligible,
  );
  if (!selected.length) {
    await createAgendaDecisionRun(
      deps,
      meeting,
      agenda,
      reviewParsed,
      [],
      "",
      reports.texts,
      prior,
    );
    return;
  }
  const round = review.round;
  const priorResponseTurns =
    round > 1
      ? await deps.prisma.meetingTurn.findMany({
          where: {
            meetingId,
            agendaId: agenda.id,
            phase: "AGENDA_RESPONSE",
            round: { lt: round },
            status: "COMPLETED",
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
  const responses = await ensureAgendaResponses(
    deps,
    meeting,
    agenda,
    round,
    selected,
    reviewParsed.question,
    reports.turns,
    priorResponseTurns.map((turn) => ({
      participantBotId: turn.participantBotId,
      content: turn.content,
    })),
  );
  if (!responses.ready) return;
  const evaluation = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId, agendaId: agenda.id, phase: "AGENDA_EVALUATION", round },
  });
  if (!evaluation) {
    await createAgendaEvaluationRun(
      deps,
      meeting,
      agenda,
      round,
      reviewParsed.question,
      responses.responses,
    );
    return;
  }
  const evaluationSync = await syncAgendaRunTurn(deps, evaluation);
  if (!evaluationSync.terminal) return;
  if (evaluationSync.failed) {
    await createAgendaDecisionRun(
      deps,
      meeting,
      agenda,
      reviewParsed,
      responses.responses,
      "Evaluation failed; decide from the participant responses already recorded.",
      reports.texts,
      prior,
    );
    return;
  }
  const evaluationParsed = parseDiscussionEvaluation(evaluationSync.text);
  const maxRounds = Math.min(
    Math.max(agenda.maxDiscussionRounds, 1),
    MEETING_MAX_DISCUSSION_ROUNDS,
  );
  if (
    evaluationParsed?.needsAnotherRound &&
    evaluationParsed.newEvidence.length > 0 &&
    round < maxRounds
  ) {
    const chair = meeting.participants.find(
      (participant) => participant.botId === meeting.chairBotId,
    );
    if (!chair) throw new Error("Chair is missing.");
    const turnId = `${meetingId}:${agenda.id}:AGENDA_REVIEW:${chair.botId}:${round + 1}`;
    await deps.prisma.meetingTurn.upsert({
      where: { id: turnId },
      update: {},
      create: {
        id: turnId,
        meetingId,
        agendaId: agenda.id,
        participantBotId: chair.botId,
        phase: "AGENDA_REVIEW",
        round: round + 1,
        content: JSON.stringify({
          materialDisagreement: true,
          reason: evaluationParsed.reason,
          question: evaluationParsed.question,
          participants: evaluationParsed.participants,
          state: "DISAGREEMENT",
          consensus: [],
          disagreements: [evaluationParsed.reason],
          evidenceGaps: evaluationParsed.newEvidence,
        }),
        evidence: {
          fromEvaluationTurnId: evaluation.id,
          newEvidence: evaluationParsed.newEvidence,
        },
        status: "COMPLETED",
      },
    });
    await advanceAgendaLoop(deps, meetingId);
    return;
  }
  await createAgendaDecisionRun(
    deps,
    meeting,
    agenda,
    reviewParsed,
    responses.responses,
    evaluationSync.text,
    reports.texts,
    prior,
  );
}

async function expireRemainingAgendas(
  deps: MeetingDeps,
  meetingId: string,
  reason: string,
): Promise<void> {
  const meeting = await loadAgendaMeeting(deps.prisma, meetingId);
  for (const agenda of meeting.agenda) {
    const existing = await deps.prisma.meetingDecision.findFirst({
      where: { meetingId, agendaId: agenda.id },
      select: { id: true },
    });
    if (!existing) await persistDeferredAgenda(deps.prisma, meetingId, agenda, reason);
  }
  await setMeetingStatus(deps.prisma, meetingId, "CLOSING");
  await beginSummary(deps, meetingId);
}

async function beginSummary(deps: MeetingDeps, meetingId: string): Promise<void> {
  const meeting = await loadAgendaMeeting(deps.prisma, meetingId);
  const decisions = await deps.prisma.meetingDecision.findMany({
    where: { meetingId },
    orderBy: { createdAt: "asc" },
  });
  if (!decisions.length) {
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "FAILED", error: "No agenda decision was persisted." },
    });
    return;
  }
  const existing = await deps.prisma.meetingTurn.findFirst({
    where: { meetingId, phase: "SUMMARY" },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }],
  });
  if (existing) {
    const synced = await syncAgendaRunTurn(deps, existing);
    if (!synced.terminal) return;
    if (!synced.failed) {
      await finishSummary(deps, meetingId, existing, synced.text);
      return;
    }
    if (existing.round >= 2) {
      await deps.prisma.meeting.update({
        where: { id: meetingId },
        data: { status: "FAILED", error: "The final executive summary could not be generated." },
      });
      return;
    }
  }
  const chair = meeting.participants.find(
    (participant) => participant.botId === meeting.chairBotId,
  );
  if (!chair) throw new Error("Chair is missing.");
  const runId = await createTurnRun(deps, {
    meeting,
    participant: chair,
    phase: "SUMMARY",
    round: existing ? 2 : 1,
    agendaId: null,
    prompt: meetingSummaryPrompt(meeting, decisions),
  });
  await enqueueRun(deps.jobs, runId);
}

async function finishSummary(
  deps: MeetingDeps,
  meetingId: string,
  turn: { id: string; runId: string | null; round: number },
  text: string,
): Promise<void> {
  const parsed = parseMeetingSummary(text);
  if (!parsed) {
    if (turn.round < 2) {
      const meeting = await loadAgendaMeeting(deps.prisma, meetingId);
      const decisions = await deps.prisma.meetingDecision.findMany({ where: { meetingId } });
      const chair = meeting.participants.find(
        (participant) => participant.botId === meeting.chairBotId,
      );
      if (!chair) throw new Error("Chair is missing.");
      const runId = await createTurnRun(deps, {
        meeting,
        participant: chair,
        phase: "SUMMARY",
        round: 2,
        agendaId: null,
        prompt: `${meetingSummaryPrompt(meeting, decisions)}\n\nYour previous answer was not valid JSON. Return only valid JSON using the five persisted decisions.`,
      });
      await enqueueRun(deps.jobs, runId);
      return;
    }
    await deps.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "FAILED", error: "The final executive summary could not be generated." },
    });
    return;
  }
  const meeting = await loadAgendaMeeting(deps.prisma, meetingId);
  const decisions = await deps.prisma.meetingDecision.findMany({
    where: { meetingId },
    orderBy: { createdAt: "asc" },
  });
  await deps.prisma.meeting.update({
    where: { id: meetingId },
    data: { meetingSummary: parsed.summary, status: "CLOSING" },
  });
  await deps.prisma.meetingTurn.update({
    where: { id: turn.id },
    data: { content: parsed.minutes, status: "COMPLETED", evidence: extractEvidence(text) },
  });
  for (const action of parsed.actionItems) {
    const decision =
      decisions.find((candidate) => {
        const agenda = meeting.agenda.find((item) => item.id === candidate.agendaId);
        return action.agendaSequence !== null && agenda?.sequence === action.agendaSequence;
      }) ?? decisions[0];
    if (!decision) continue;
    const requested = action.assigneeRole.toLowerCase();
    const normalized = requested === "ceo" ? "chairperson" : requested;
    const assignee = meeting.participants.find((participant) => {
      const role = participant.role.toLowerCase();
      return normalized ? role.includes(normalized) || normalized.includes(role) : false;
    });
    if (!assignee) continue;
    await deps.prisma.meetingActionItem.upsert({
      where: { decisionId_title: { decisionId: decision.id, title: action.title } },
      update: {},
      create: {
        meetingId,
        decisionId: decision.id,
        title: action.title,
        description: action.description,
        acceptanceCriteria: action.acceptanceCriteria ?? "",
        assigneeBotId: assignee.botId,
        activatedAt:
          decision.approvalStatus === "APPROVED" ||
          (decision.approvalStatus === "APPROVED_WITH_CONDITIONS" &&
            Boolean(decision.conditionsConfirmedAt))
            ? new Date()
            : null,
        dueAt: action.dueAt ? new Date(action.dueAt) : null,
        status: "OPEN",
      },
    });
  }
  await deps.prisma.meeting.update({
    where: { id: meetingId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

async function createTurnRun(
  deps: MeetingDeps,
  input: {
    meeting: {
      id: string;
      spaceId: string;
      createdBy: string;
      participants: Array<{ id: string; botId: string }>;
    };
    participant: { id: string; botId: string; threadId?: string | null };
    phase: string;
    round: number;
    agendaId: string | null;
    prompt: string;
  },
): Promise<string> {
  const { meeting, participant } = input;
  const currentMeeting = await deps.prisma.meeting.findUnique({
    where: { id: meeting.id },
    select: { status: true },
  });
  // A cancellation that commits while a stage is being built wins: never create
  // another participant run for a terminal meeting.
  if (!currentMeeting || TERMINAL_MEETING_STATUSES.has(currentMeeting.status as MeetingStatus)) {
    throw new MeetingStoppedError();
  }
  const bot = await deps.prisma.bot.findFirst({
    where: { id: participant.botId, spaceId: meeting.spaceId, archivedAt: null },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) throw new Error("Participant has no chat thread.");
  const threadId = participant.threadId ?? bot.thread.id;
  if (!participant.threadId) {
    await deps.prisma.meetingParticipant.updateMany({
      where: { meetingId: meeting.id, botId: bot.id },
      data: { threadId },
    });
  }
  const active = await deps.prisma.run.findFirst({
    where: { threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  if (active) throw new Error("Participant already has an active run.");
  const agendaKey = input.agendaId ?? "none";
  const clientNonce = `meeting:${meeting.id}:${agendaKey}:${input.phase}:${participant.botId}:${input.round}`;
  const existing = await deps.prisma.run.findUnique({
    where: { spaceId_clientNonce: { spaceId: meeting.spaceId, clientNonce } },
    select: { id: true },
  });
  let runId: string;
  if (existing) {
    runId = existing.id;
  } else {
    const prompt = await withHumanMeetingContext(deps.prisma, meeting.id, input.prompt);
    const task = await deps.prisma.task.create({
      data: {
        spaceId: meeting.spaceId,
        botId: bot.id,
        threadId,
        userId: meeting.createdBy,
        prompt,
        status: "queued",
      },
      select: { id: true },
    });
    try {
      const run = await deps.prisma.run.create({
        data: {
          spaceId: meeting.spaceId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          userId: meeting.createdBy,
          status: "queued",
          trigger: "meeting_turn",
          clientNonce,
          maxOutputTokens: tokenLimitForPhase(input.phase),
        },
        select: { id: true },
      });
      runId = run.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await deps.prisma.run.findUniqueOrThrow({
        where: { spaceId_clientNonce: { spaceId: meeting.spaceId, clientNonce } },
        select: { id: true },
      });
      runId = raced.id;
    }
  }
  const turnId = `${meeting.id}:${agendaKey}:${input.phase}:${participant.botId}:${input.round}`;
  await deps.prisma.meetingTurn.upsert({
    where: { id: turnId },
    create: {
      id: turnId,
      meetingId: meeting.id,
      agendaId: input.agendaId,
      participantBotId: participant.botId,
      phase: input.phase,
      round: input.round,
      content: "",
      evidence: {},
      runId,
      status: "PENDING",
    },
    update: { runId, status: "PENDING" },
  });
  return runId;
}

/** 500 tokens for a normal turn; a structured decision needs enough room to stay valid JSON. */
export const MEETING_MAX_RESPONSE_CHARS = 12_000;
export const MEETING_MAX_DECISION_CHARS = 32_000;

/** Validate a returned response without silently truncating it. */
export function meetingTextFits(text: string, phase: string): boolean {
  const structured = phase === "DECISION" || phase === "AGENDA_DECISION" || phase === "SUMMARY";
  return text.length <= (structured ? MEETING_MAX_DECISION_CHARS : MEETING_MAX_RESPONSE_CHARS);
}

/**
 * Bounded per-phase provider budgets. Participant discussion is held to the
 * 500-token product limit. A reporting turn needs room to include evidence, and
 * the structured decision needs room to remain valid JSON; both stay bounded.
 */
export const MEETING_REPORT_MAX_RESPONSE_TOKENS = 1_200;
export const MEETING_DECISION_MAX_RESPONSE_TOKENS = 2_400;
export function tokenLimitForPhase(phase: string): number {
  if (phase === "DECISION" || phase === "AGENDA_DECISION")
    return MEETING_DECISION_MAX_RESPONSE_TOKENS;
  if (phase === "SUMMARY") return 3_200;
  if (phase === "REPORTING") return MEETING_REPORT_MAX_RESPONSE_TOKENS;
  // Reasoning-capable models spend part of the completion budget before the
  // answer. 500 tokens repeatedly produced an empty failure in the boardroom;
  // 800 keeps the turn bounded while leaving room for a real participant reply.
  if (phase === "AGENDA_REVIEW") return 2_000;
  if (phase === "AGENDA_RESPONSE") return 1_200;
  if (phase === "AGENDA_EVALUATION") return 2_000;
  if (phase.startsWith("DISCUSSION_")) return 800;
  return 500;
}

async function enqueueRun(jobs: JobPublisher, runId: string): Promise<void> {
  await jobs.enqueue(runContinueJob(runId)).catch((error) => {
    // The run is durable; the next get/advance enqueues it again.
    getLogger().error("meeting run enqueue failed", error);
  });
}

function meetingAgendaLines(meeting: {
  agenda: Array<{ sequence: number; title: string; description: string }>;
}): string {
  return meeting.agenda
    .map(
      (item) =>
        `${item.sequence}. ${item.title}${item.description ? ` — ${item.description}` : ""}`,
    )
    .join("\n");
}

function openingPrompt(meeting: {
  title: string;
  description: string;
  agenda: Array<{ sequence: number; title: string; description: string }>;
}): string {
  return `You are the chairperson of an executive boardroom meeting.

Meeting: ${meeting.title}
Objective: ${meeting.description}
Agenda:
${meetingAgendaLines(meeting)}

Open the meeting in a concise chair statement (under 300 words). State the objective, the agenda, the discussion rules (maximum two rounds), and that recommendations requiring financial commitments or external actions need the human owner's approval. Do not invent evidence or claim a human approval.`;
}

function reportingPrompt(
  meeting: {
    title: string;
    description: string;
    agenda: Array<{ sequence: number; title: string; description: string }>;
  },
  participant: { role: string; responsibilities: string },
): string {
  return `You are the ${participant.role} in an executive boardroom meeting. Stay within this responsibility: ${participant.responsibilities}

Meeting: ${meeting.title}
Objective: ${meeting.description}
Agenda:
${meetingAgendaLines(meeting)}

Provide a concise (maximum 500 words) evidence-based report for the meeting. Structure it as:
1. Facts
2. Assumptions
3. Risks
4. Recommendation
5. Missing information
Include source names/URLs and access dates where available. Clearly label vendor claims, third-party estimates, and unknown data. If a source cannot be retrieved, say so; never claim a successful search that failed. Do not make decisions for the chair and do not claim human approval.`;
}

function agendaReviewPrompt(
  meeting: { title: string; description: string },
  agenda: { sequence: number; title: string; description: string },
  reports: string[],
  prior: string,
): string {
  return `You are the chairperson reviewing ONE agenda item. This is a new meeting; do not reuse an earlier meeting's question or decision.

Meeting: ${meeting.title}
Objective: ${meeting.description}
Current agenda: ${agenda.sequence}. ${agenda.title}${agenda.description ? ` — ${agenda.description}` : ""}

Participant reports:
${reports.map((report, index) => `--- Report ${index + 1} ---\n${report}`).join("\n\n")}

Previous agenda decisions (for boundary only; do not combine):
${prior}

Decide whether this agenda has a material disagreement that needs participant discussion. A material disagreement requires new evidence, a concrete risk, a logical contradiction, or a feasible alternative. If there is none, set materialDisagreement false and do not ask a cosmetic question. If there is one, ask ONE specific question and select only the participants whose evidence is needed. Never select the chair.

Return ONLY valid JSON:
{
  "materialDisagreement": true | false,
  "reason": "why discussion is or is not required",
  "state": "AGREEMENT" | "DISAGREEMENT" | "INSUFFICIENT_EVIDENCE" | "UNRESOLVED",
  "consensus": ["what the reports already agree on"],
  "disagreements": ["the specific unresolved disagreement"],
  "evidenceGaps": ["the evidence needed to close it"],
  "question": "the specific question, or an empty string when no discussion is required",
  "participants": ["Research", "Finance"]
}

Do not make the agenda decision. Do not invent evidence. Keep reason under 120 words and the question under 120 words.`;
}

function agendaParticipantPrompt(
  meeting: { title: string; description: string },
  agenda: { sequence: number; title: string; description: string },
  participant: { role: string; responsibilities: string },
  question: string,
  reports: Array<{ participantBotId: string; content: string }>,
  priorResponses: Array<{ participantBotId: string; content: string }> = [],
): string {
  const prior = priorResponses.length
    ? `Earlier round responses (do not repeat them; address only the new evidence or the chair's unresolved point):\n${priorResponses
        .map((response) => `--- ${response.participantBotId} ---\n${response.content}`)
        .join("\n\n")}\n`
    : "";
  return `You are the ${participant.role} answering the chair on ONE agenda item. Stay within this responsibility: ${participant.responsibilities}

Meeting: ${meeting.title}
Agenda item: ${agenda.sequence}. ${agenda.title}
Chair's actual question:
${question}

Reports for context:
${reports.map((report, index) => `--- Report ${index + 1} ---\n${report.content}`).join("\n\n")}

${prior}Answer ONLY that question. Do not repeat your initial report or an earlier round. If the question requires a point another participant raised, explicitly connect it to that point; otherwise do not debate them. Structure the answer as:
1. Facts
2. Assumptions
3. New evidence (URLs/access dates; say when a source failed)
4. Risks
5. Recommendation
If you have no new information, say "NO_NEW_INFORMATION". Do not claim consensus or human approval, and do not address another bot directly. Keep it under 500 words.`;
}

function agendaEvaluationPrompt(
  meeting: { title: string; description: string },
  agenda: { sequence: number; title: string },
  question: string,
  responses: Array<{ participantBotId: string; content: string }>,
): string {
  return `You are the chairperson evaluating participant responses on ONE agenda item. Do not fabricate consensus.

Meeting: ${meeting.title}
Agenda item: ${agenda.sequence}. ${agenda.title}
Question: ${question}

Responses:
${responses.map((response, index) => `--- Response ${index + 1} ---\n${response.content}`).join("\n\n")}

Return ONLY valid JSON:
{
  "needsAnotherRound": true | false,
  "reason": "what changed or remains unresolved",
  "newEvidence": ["specific new evidence supplied by a participant"],
  "question": "one focused question for a final round, or null",
  "participants": ["only participants whose evidence is needed for that final round"]
}

Set needsAnotherRound true only when a participant supplied new evidence that changes a material point, the round ceiling allows another round, and one focused question can resolve it. Never use it to repeat opinions. Preserve dissent. Do not make the decision.`;
}

function agendaDecisionPrompt(
  meeting: { title: string; description: string },
  agenda: { sequence: number; title: string; description: string },
  reports: string[],
  review: { materialDisagreement: boolean; reason: string; question: string },
  responses: Array<{ participantBotId: string; content: string }>,
  evaluation: string,
  prior: string,
): string {
  return `You are the chairperson deciding ONE agenda item. This is not the executive summary and must not decide another agenda.

Meeting: ${meeting.title}
Objective: ${meeting.description}
Current agenda: ${agenda.sequence}. ${agenda.title}${agenda.description ? ` — ${agenda.description}` : ""}

Participant reports:
${reports.map((report, index) => `--- Report ${index + 1} ---\n${report}`).join("\n\n")}

Chair review:
${JSON.stringify(review)}

Participant responses:
${responses.map((response, index) => `--- Response ${index + 1} ---\n${response.content}`).join("\n\n") || "(no participant discussion was required)"}

Chair evaluation:
${evaluation || "(no discussion was required)"}

Previous agenda decisions (for boundary only):
${prior}

Return ONLY valid JSON:
{
  "decisionType": "APPROVED" | "APPROVED_WITH_CONDITIONS" | "DEFERRED" | "REJECTED",
  "decisionText": "the decision for this agenda only",
  "rationale": "why",
  "supportingEvidence": ["..."],
  "supportingOpinions": ["..."],
  "risks": ["..."],
  "dissentingOpinions": ["..."],
  "evidenceGaps": ["..."],
  "conditions": ["..."],
  "discussionState": "AGREEMENT" | "DISAGREEMENT" | "INSUFFICIENT_EVIDENCE" | "UNRESOLVED"
}

Rules: if the evidence is insufficient, use DEFERRED and discussionState INSUFFICIENT_EVIDENCE rather than inventing a conclusion. Distinguish supporting opinions from dissenting opinions and list concrete evidence gaps. Any APPROVED or APPROVED_WITH_CONDITIONS is a recommendation requiring the human owner's approval; do not claim human approval. Do not combine agendas. Do not invent action items or due dates here.`;
}

function meetingSummaryPrompt(
  meeting: {
    title: string;
    description: string;
    agenda: Array<{ id: string; sequence: number; title: string }>;
  },
  decisions: Array<{
    agendaId: string | null;
    decisionType: string;
    decisionText: string;
    rationale: string;
    risks: unknown;
    dissentingOpinions: unknown;
    conditions: unknown;
    approvalRequired: boolean;
    approvalStatus: string;
  }>,
): string {
  const lines = decisions
    .map((decision) => {
      const agenda = meeting.agenda.find((item) => item.id === decision.agendaId);
      return `Agenda ${agenda?.sequence ?? "?"} — ${agenda?.title ?? "unknown"}: ${decision.decisionType}\nDecision: ${decision.decisionText}\nRationale: ${decision.rationale}\nApproval: ${decision.approvalStatus}`;
    })
    .join("\n\n");
  return `You are the chairperson closing the meeting after every agenda item has its own persisted decision. Summarize those decisions; do not create, alter or merge any decision.

Meeting: ${meeting.title}
Objective: ${meeting.description}

Persisted agenda decisions:
${lines}

Return ONLY valid JSON:
{
  "summary": "executive summary that references every agenda decision",
  "minutes": "meeting minutes distinguishing agreements, dissent, evidence, risks and unresolved matters",
  "actionItems": [
    {
      "title": "...",
      "description": "...",
      "assigneeRole": "Research" | "Finance" | "Chairperson",
      "agendaSequence": 1,
      "acceptanceCriteria": "how completion will be verified",
      "dueAt": null
    }
  ]
}

Rules: reference all decisions and do not fabricate a sixth decision. Specify a concrete acceptance criterion for every action. Do not fabricate due dates; use null unless a date was specified. Any approved recommendation remains pending human approval. Do not execute external actions.`;
}
