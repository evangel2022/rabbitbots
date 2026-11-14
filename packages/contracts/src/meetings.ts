import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const MEETING_STATUSES = [
  "DRAFT",
  "PREPARING",
  "OPENING",
  "REPORTING",
  "DISCUSSION",
  "DECISION",
  "CLOSING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export const MeetingStatus = z.enum(MEETING_STATUSES);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

export const MEETING_PHASES = [
  "OPENING",
  "REPORTING",
  "DISCUSSION",
  "DISCUSSION_QUESTION",
  "DISCUSSION_RESPONSE",
  "DISCUSSION_EVALUATION",
  "AGENDA_REVIEW",
  "AGENDA_RESPONSE",
  "AGENDA_EVALUATION",
  "AGENDA_DECISION",
  "SUMMARY",
  "DECISION",
] as const;
export type MeetingPhase = (typeof MEETING_PHASES)[number];

export const MEETING_DECISION_TYPES = [
  "APPROVED",
  "APPROVED_WITH_CONDITIONS",
  "DEFERRED",
  "REJECTED",
] as const;
export const MeetingDecisionType = z.enum(MEETING_DECISION_TYPES);
export type MeetingDecisionType = z.infer<typeof MeetingDecisionType>;

export const MEETING_APPROVAL_STATUSES = [
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "APPROVED_WITH_CONDITIONS",
  "REJECTED",
  "DEFERRED",
] as const;
export const MeetingApprovalStatus = z.enum(MEETING_APPROVAL_STATUSES);
export type MeetingApprovalStatus = z.infer<typeof MeetingApprovalStatus>;

export const MEETING_DISCUSSION_STATES = [
  "AGREEMENT",
  "DISAGREEMENT",
  "INSUFFICIENT_EVIDENCE",
  "UNRESOLVED",
] as const;
export const MeetingDiscussionState = z.enum(MEETING_DISCUSSION_STATES);
export type MeetingDiscussionState = z.infer<typeof MeetingDiscussionState>;

export const MEETING_ACTION_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED", "BLOCKED"] as const;
export const MeetingActionStatus = z.enum(MEETING_ACTION_STATUSES);
export type MeetingActionStatus = z.infer<typeof MeetingActionStatus>;

export const MEETING_ACTION_RESULT_STATUSES = ["SUCCESS", "PARTIAL", "FAILED", "BLOCKED"] as const;
export const MeetingActionResultStatus = z.enum(MEETING_ACTION_RESULT_STATUSES);
export type MeetingActionResultStatus = z.infer<typeof MeetingActionResultStatus>;

export const MEETING_ACTION_ACCEPTANCE_ACTIONS = [
  "ACCEPT",
  "REQUEST_EVIDENCE",
  "RE_EXECUTE",
  "REJECT",
  "BLOCK",
  "CANCEL",
] as const;
export const MeetingActionAcceptanceAction = z.enum(MEETING_ACTION_ACCEPTANCE_ACTIONS);
export type MeetingActionAcceptanceAction = z.infer<typeof MeetingActionAcceptanceAction>;

export const MeetingActionAttemptView = z.object({
  id: Id,
  actionItemId: Id,
  attemptNumber: z.number().int(),
  taskId: Id.nullable(),
  botRunId: Id.nullable(),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"]),
  resultStatus: MeetingActionResultStatus.nullable(),
  resultSummary: z.string().nullable(),
  evidence: z.array(z.string()),
  error: z.string().nullable(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  /** Run metadata for Workforce execution history; null on non-Run attempts. */
  runStatus: z.string().nullable().optional(),
  runTrigger: z.string().nullable().optional(),
});
export type MeetingActionAttemptView = z.infer<typeof MeetingActionAttemptView>;

export const MeetingActionAcceptanceView = z.object({
  id: Id,
  actionItemId: Id,
  action: MeetingActionAcceptanceAction,
  actorUserId: Id,
  actorName: z.string(),
  comment: z.string().nullable(),
  createdAt: IsoDate,
});
export type MeetingActionAcceptanceView = z.infer<typeof MeetingActionAcceptanceView>;

export const MEETING_APPROVAL_ACTIONS = [
  "APPROVE",
  "APPROVE_WITH_CONDITIONS",
  "REJECT",
  "DEFER",
] as const;
export const MeetingApprovalAction = z.enum(MEETING_APPROVAL_ACTIONS);
export type MeetingApprovalAction = z.infer<typeof MeetingApprovalAction>;

export const MeetingDecisionApprovalView = z.object({
  id: Id,
  decisionId: Id,
  action: MeetingApprovalAction,
  previousStatus: MeetingApprovalStatus,
  newStatus: MeetingApprovalStatus,
  actorUserId: Id,
  actorName: z.string(),
  rationale: z.string().nullable(),
  conditions: z.string().nullable(),
  createdAt: IsoDate,
});
export type MeetingDecisionApprovalView = z.infer<typeof MeetingDecisionApprovalView>;

export const MeetingDecisionApprovalInput = z.object({
  meetingId: Id,
  decisionId: Id,
  action: MeetingApprovalAction,
  rationale: z.string().trim().max(2_000).optional(),
  conditions: z.string().trim().max(4_000).optional(),
  clientNonce: z.string().min(8).max(128),
});
export type MeetingDecisionApprovalInput = z.infer<typeof MeetingDecisionApprovalInput>;

export const MEETING_HUMAN_ROLES = ["HUMAN_CEO"] as const;
export const MeetingHumanRole = z.enum(MEETING_HUMAN_ROLES);
export type MeetingHumanRole = z.infer<typeof MeetingHumanRole>;

export const MeetingHumanParticipantView = z.object({
  id: Id,
  userId: Id,
  userName: z.string(),
  role: MeetingHumanRole,
  createdAt: IsoDate,
});
export type MeetingHumanParticipantView = z.infer<typeof MeetingHumanParticipantView>;

export const MEETING_MESSAGE_AUTHOR_TYPES = [
  "HUMAN_CEO",
  "CHAIR_BOT",
  "PARTICIPANT_BOT",
  "SYSTEM",
] as const;
export const MeetingMessageAuthorType = z.enum(MEETING_MESSAGE_AUTHOR_TYPES);
export type MeetingMessageAuthorType = z.infer<typeof MeetingMessageAuthorType>;

export const MeetingMessageView = z.object({
  id: Id,
  meetingId: Id,
  agendaId: Id.nullable(),
  authorType: MeetingMessageAuthorType,
  authorName: z.string(),
  authorUserId: Id.nullable(),
  authorBotId: Id.nullable(),
  content: z.string(),
  seq: z.number().int(),
  createdAt: IsoDate,
});
export type MeetingMessageView = z.infer<typeof MeetingMessageView>;

export const MeetingMessagesListInput = z.object({
  meetingId: Id,
  /** Return messages with a sequence greater than this cursor. */
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type MeetingMessagesListInput = z.infer<typeof MeetingMessagesListInput>;

export const MeetingMessagesListOutput = z.object({
  messages: z.array(MeetingMessageView),
  nextCursor: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type MeetingMessagesListOutput = z.infer<typeof MeetingMessagesListOutput>;

export const MeetingMessageSendInput = z.object({
  meetingId: Id,
  agendaId: Id.optional(),
  content: z.string().trim().min(1).max(8_000),
  /** Client idempotency key; retries with the same key return the same row. */
  clientNonce: z.string().min(8).max(128),
});
export type MeetingMessageSendInput = z.infer<typeof MeetingMessageSendInput>;

export const MeetingParticipantView = z.object({
  id: Id,
  botId: Id,
  botName: z.string(),
  role: z.string(),
  responsibilities: z.string(),
  status: z.string(),
});
export type MeetingParticipantView = z.infer<typeof MeetingParticipantView>;

export const MeetingAgendaView = z.object({
  id: Id,
  sequence: z.number().int(),
  title: z.string(),
  description: z.string(),
  timeLimitSeconds: z.number().int(),
  maxDiscussionRounds: z.number().int(),
  status: z.string(),
  decision: z.string().nullable(),
});
export type MeetingAgendaView = z.infer<typeof MeetingAgendaView>;

export const MeetingTurnView = z.object({
  id: Id,
  agendaId: Id.nullable(),
  participantBotId: Id,
  participantBotName: z.string(),
  phase: z.string(),
  round: z.number().int(),
  content: z.string(),
  evidence: z.unknown(),
  status: z.string(),
  createdAt: IsoDate,
});
export type MeetingTurnView = z.infer<typeof MeetingTurnView>;

export const MeetingDecisionView = z.object({
  id: Id,
  agendaId: Id.nullable(),
  decisionType: MeetingDecisionType,
  decisionText: z.string(),
  rationale: z.string(),
  supportingEvidence: z.array(z.string()),
  risks: z.array(z.string()),
  dissentingOpinions: z.array(z.string()),
  conditions: z.array(z.string()),
  discussionState: MeetingDiscussionState,
  supportingOpinions: z.array(z.string()),
  evidenceGaps: z.array(z.string()),
  approvalRequired: z.boolean(),
  approvalStatus: MeetingApprovalStatus,
  conditionsConfirmedAt: IsoDate.nullable(),
  conditionsConfirmedByUserId: Id.nullable(),
  approvalHistory: z.array(MeetingDecisionApprovalView),
  createdAt: IsoDate,
});
export type MeetingDecisionView = z.infer<typeof MeetingDecisionView>;

export const MeetingActionAssignInput = z.object({
  meetingId: Id,
  actionItemId: Id,
  assigneeBotId: Id,
  clientNonce: z.string().min(8).max(128),
});
export type MeetingActionAssignInput = z.infer<typeof MeetingActionAssignInput>;

export const MeetingActionExecuteInput = z.object({
  meetingId: Id,
  actionItemId: Id,
  clientNonce: z.string().min(8).max(128),
});
export type MeetingActionExecuteInput = z.infer<typeof MeetingActionExecuteInput>;

export const MeetingActionAcceptanceInput = z.object({
  meetingId: Id,
  actionItemId: Id,
  action: MeetingActionAcceptanceAction,
  comment: z.string().trim().max(2_000).optional(),
  clientNonce: z.string().min(8).max(128),
});
export type MeetingActionAcceptanceInput = z.infer<typeof MeetingActionAcceptanceInput>;

export const MeetingConditionsConfirmInput = z.object({
  meetingId: Id,
  decisionId: Id,
  clientNonce: z.string().min(8).max(128),
});
export type MeetingConditionsConfirmInput = z.infer<typeof MeetingConditionsConfirmInput>;

export const MeetingDecisionApprovalResult = z.object({
  approval: MeetingDecisionApprovalView,
  decision: MeetingDecisionView,
});
export type MeetingDecisionApprovalResult = z.infer<typeof MeetingDecisionApprovalResult>;

export const MeetingActionItemView = z.object({
  id: Id,
  meetingId: Id,
  decisionId: Id.nullable(),
  agendaId: Id.nullable(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  assigneeBotId: Id.nullable(),
  assigneeBotName: z.string().nullable(),
  assigneeUserId: Id.nullable(),
  assigneeUserName: z.string().nullable(),
  activatedAt: IsoDate.nullable(),
  taskId: Id.nullable(),
  botRunId: Id.nullable(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  resultStatus: MeetingActionResultStatus.nullable(),
  resultSummary: z.string().nullable(),
  evidence: z.array(z.string()),
  blockedReason: z.string().nullable(),
  acceptanceStatus: z.string().nullable(),
  acceptanceHistory: z.array(MeetingActionAcceptanceView),
  attempts: z.array(MeetingActionAttemptView),
  dueAt: IsoDate.nullable(),
  executionStatus: MeetingActionStatus,
  status: z.string(),
  createdAt: IsoDate,
});
export type MeetingActionItemView = z.infer<typeof MeetingActionItemView>;

export const MeetingView = z.object({
  id: Id,
  title: z.string(),
  description: z.string(),
  status: MeetingStatus,
  chairBotId: Id,
  chairBotName: z.string(),
  createdBy: Id,
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  cancelledAt: IsoDate.nullable(),
  cancellationReason: z.string().nullable(),
  deadlineAt: IsoDate.nullable(),
  currentAgendaId: Id.nullable(),
  meetingSummary: z.string().nullable(),
  formalMinutes: z.string().nullable(),
  error: z.string().nullable(),
  participants: z.array(MeetingParticipantView),
  humanParticipants: z.array(MeetingHumanParticipantView),
  agenda: z.array(MeetingAgendaView),
  turns: z.array(MeetingTurnView),
  decisions: z.array(MeetingDecisionView),
  actionItems: z.array(MeetingActionItemView),
});
export type MeetingView = z.infer<typeof MeetingView>;

export const MeetingListItem = z.object({
  id: Id,
  title: z.string(),
  status: MeetingStatus,
  chairBotName: z.string(),
  participantNames: z.array(z.string()),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  completedAt: IsoDate.nullable(),
});
export type MeetingListItem = z.infer<typeof MeetingListItem>;

export const MeetingListOutput = z.object({ meetings: z.array(MeetingListItem) });
export type MeetingListOutput = z.infer<typeof MeetingListOutput>;

export const MeetingIdInput = z.object({ meetingId: Id });

export const CancelMeetingInput = z.object({
  meetingId: Id,
  reason: z.string().trim().max(500).optional(),
});
export type CancelMeetingInput = z.infer<typeof CancelMeetingInput>;

export const MeetingAgendaInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).default(""),
  timeLimitSeconds: z.number().int().min(30).max(3_600).default(300),
});

export const CreateMeetingInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  chairBotId: Id,
  participantBotIds: z.array(Id).min(2).max(8),
  agenda: z.array(MeetingAgendaInput).min(1).max(12),
});
export type CreateMeetingInput = z.infer<typeof CreateMeetingInput>;

export const UpdateMeetingInput = z.object({
  meetingId: Id,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).optional(),
  agenda: z.array(MeetingAgendaInput).min(1).max(12).optional(),
});
export type UpdateMeetingInput = z.infer<typeof UpdateMeetingInput>;

/** At most two discussion rounds per agenda item. */
export const MEETING_MAX_DISCUSSION_ROUNDS = 2;
/** Default per-agenda time limit, in seconds. */
export const MEETING_DEFAULT_AGENDA_SECONDS = 300;
/** Maximum total meeting duration is bounded so a participant cannot block forever. */
export const MEETING_MAX_TOTAL_SECONDS = 1_800;
export const MEETING_MAX_RESPONSE_TOKENS = 500;
