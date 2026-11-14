import * as z from "zod";
import { Id, IsoDate } from "./ids.js";
import {
  MeetingActionAcceptanceView,
  MeetingActionAttemptView,
  MeetingActionResultStatus,
  MeetingApprovalStatus,
  MeetingDecisionType,
} from "./meetings.js";

export const WorkforceBotView = z.object({
  id: Id,
  name: z.string(),
  role: z.string(),
  status: z.enum(["WORKING", "WAITING", "IDLE", "BLOCKED"]),
  currentTaskId: Id.nullable(),
  currentTaskTitle: z.string().nullable(),
  completedToday: z.number().int(),
  failedToday: z.number().int(),
  lastExecutedAt: IsoDate.nullable(),
});
export type WorkforceBotView = z.infer<typeof WorkforceBotView>;

export const WORKFORCE_TASK_SOURCES = ["MEETING_DECISION", "CEO_DIRECT", "BOT_DELEGATED"] as const;
export const WorkforceTaskSource = z.enum(WORKFORCE_TASK_SOURCES);
export type WorkforceTaskSource = z.infer<typeof WorkforceTaskSource>;

export const WORKFORCE_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const WorkforcePriority = z.enum(WORKFORCE_PRIORITIES);
export type WorkforcePriority = z.infer<typeof WorkforcePriority>;

export const WorkforceExecutionStatus = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CHILDREN",
  "COMPLETED",
  "BLOCKED",
]);
export type WorkforceExecutionStatus = z.infer<typeof WorkforceExecutionStatus>;

export const WorkforceDelegationView = z.object({
  id: Id,
  parentTaskId: Id,
  childTaskId: Id,
  parentRunId: Id,
  childRunId: Id.nullable(),
  delegatorBotId: Id,
  assigneeBotId: Id,
  status: z.enum(["WAITING", "COMPLETED", "FAILED", "BLOCKED", "TIMED_OUT"]),
  resultStatus: z.string().nullable(),
  resultSummary: z.string().nullable(),
  evidence: z.array(z.string()),
  error: z.string().nullable(),
  toolInvocationId: z.string().nullable(),
  deliveredAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  deadlineAt: IsoDate.nullable(),
  timedOutAt: IsoDate.nullable(),
  lateResultStatus: z.string().nullable(),
  lateResultSummary: z.string().nullable(),
  lateResultAt: IsoDate.nullable(),
  createdAt: IsoDate,
});
export type WorkforceDelegationView = z.infer<typeof WorkforceDelegationView>;

export const WorkforceTaskView = z.object({
  id: Id,
  source: WorkforceTaskSource,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  assigneeBotId: Id.nullable(),
  assigneeBotName: z.string().nullable(),
  assigneeUserId: Id.nullable(),
  assigneeUserName: z.string().nullable(),
  meetingId: Id.nullable(),
  meetingTitle: z.string().nullable(),
  decisionId: Id.nullable(),
  decisionType: MeetingDecisionType.nullable(),
  approvalStatus: MeetingApprovalStatus.nullable(),
  conditionsConfirmedAt: IsoDate.nullable(),
  executionStatus: WorkforceExecutionStatus,
  /** Execution status of the linked parent WorkforceTask, when this row is an Action. */
  linkedExecutionStatus: WorkforceExecutionStatus.nullable(),
  latestResultStatus: MeetingActionResultStatus.nullable(),
  latestResultSummary: z.string().nullable(),
  acceptanceStatus: z.string().nullable(),
  blockedReason: z.string().nullable(),
  priority: WorkforcePriority,
  dueAt: IsoDate.nullable(),
  parentTaskId: Id.nullable(),
  parentMeetingActionId: Id.nullable(),
  /** The WorkforceTask that owns this action's real execution, when it exists. */
  linkedWorkforceTaskId: Id.nullable(),
  parentRunId: Id.nullable(),
  delegatorBotId: Id.nullable(),
  delegationDepth: z.number().int(),
  waitingForChildren: z.boolean(),
  waitingSince: IsoDate.nullable(),
  continuationRunId: Id.nullable(),
  delegationDeadlineAt: IsoDate.nullable(),
  delegations: z.array(WorkforceDelegationView),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  attempts: z.array(MeetingActionAttemptView),
  acceptances: z.array(MeetingActionAcceptanceView),
});
export type WorkforceTaskView = z.infer<typeof WorkforceTaskView>;

export const WorkforceSummary = z.object({
  open: z.number().int(),
  inProgress: z.number().int(),
  completed: z.number().int(),
  blocked: z.number().int(),
  failed: z.number().int(),
  waiting: z.number().int(),
  pendingAcceptance: z.number().int(),
});
export type WorkforceSummary = z.infer<typeof WorkforceSummary>;

export const WorkforceOverview = z.object({
  bots: z.array(WorkforceBotView),
  tasks: z.array(WorkforceTaskView),
  summary: WorkforceSummary,
});
export type WorkforceOverview = z.infer<typeof WorkforceOverview>;

export const WorkforceDirectTaskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(4_000).default(""),
  acceptanceCriteria: z.string().trim().min(1).max(4_000),
  assigneeBotId: Id,
  priority: WorkforcePriority.default("NORMAL"),
  dueAt: IsoDate.nullable().optional(),
});
export type WorkforceDirectTaskInput = z.infer<typeof WorkforceDirectTaskInput>;

export const WorkforceTaskExecuteInput = z.object({
  taskId: Id,
  clientNonce: z.string().min(8).max(128),
});
export type WorkforceTaskExecuteInput = z.infer<typeof WorkforceTaskExecuteInput>;

export const WorkforceTaskAcceptanceInput = z.object({
  taskId: Id,
  action: z.enum(["ACCEPT", "REQUEST_EVIDENCE", "RE_EXECUTE", "REJECT", "BLOCK", "CANCEL"]),
  comment: z.string().trim().max(2_000).optional(),
  clientNonce: z.string().min(8).max(128),
});
export type WorkforceTaskAcceptanceInput = z.infer<typeof WorkforceTaskAcceptanceInput>;

export const AI_COMPANY_MEETING_TITLE = "First AI Company Strategy Meeting";

export const AI_COMPANY_DEMO_MEETING_TITLE =
  "Launch RabbitBots on GitHub — AI Company Launch Strategy";

export const AI_COMPANY_DEMO_AGENDA = [
  "Product Positioning and Developer Audience",
  "GitHub Launch Plan and Execution",
] as const;

export const WorkforceCompanyBotView = z.object({
  roleKey: z.enum(["ceo", "research", "finance", "operations"]),
  role: z.string(),
  id: Id,
  name: z.string(),
  description: z.string(),
});
export type WorkforceCompanyBotView = z.infer<typeof WorkforceCompanyBotView>;

export const WorkforceCompanyStatus = z.object({
  created: z.boolean(),
  /** The AI company profile chosen in onboarding; absent on spaces created before it. */
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  bots: z.array(WorkforceCompanyBotView),
  meetingId: Id.nullable(),
  meetingTitle: z.string(),
});
export type WorkforceCompanyStatus = z.infer<typeof WorkforceCompanyStatus>;

export const WORKFORCE_COMPANY_ROLE_KEYS = ["ceo", "research", "finance", "operations"] as const;
export const WorkforceCompanyRoleKey = z.enum(WORKFORCE_COMPANY_ROLE_KEYS);
export type WorkforceCompanyRoleKey = z.infer<typeof WorkforceCompanyRoleKey>;

export const WorkforceCompanyRoleInput = z.object({
  key: WorkforceCompanyRoleKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
});
export type WorkforceCompanyRoleInput = z.infer<typeof WorkforceCompanyRoleInput>;

export const WorkforceCompanyCreateInput = z.object({
  /** Optional for older callers that only need the default company. */
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  /** Names and responsibilities only; role instructions stay fixed. */
  roles: z.array(WorkforceCompanyRoleInput).length(4).optional(),
});
export type WorkforceCompanyCreateInput = z.infer<typeof WorkforceCompanyCreateInput>;

export const WorkforceDemoStatus = z.object({
  created: z.boolean(),
  companyCreated: z.boolean(),
  bots: z.array(WorkforceCompanyBotView),
  meetingId: Id.nullable(),
  meetingTitle: z.string(),
  meetingStatus: z.string().nullable(),
  modelReady: z.boolean(),
});
export type WorkforceDemoStatus = z.infer<typeof WorkforceDemoStatus>;

export const WorkforceTaskAssignInput = z.object({
  taskId: Id,
  assigneeBotId: Id,
  clientNonce: z.string().min(8).max(128),
});
export type WorkforceTaskAssignInput = z.infer<typeof WorkforceTaskAssignInput>;
