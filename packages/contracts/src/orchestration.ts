import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** The run that writes the final report after every child has settled. */
export const ORCHESTRATION_JOIN_TRIGGER = "orchestration_join";

export const ORCHESTRATION_GOAL_MAX_LENGTH = 4_000;
export const ORCHESTRATION_TASK_MAX_LENGTH = 8_000;
export const ORCHESTRATION_MIN_CHILDREN = 2;
export const ORCHESTRATION_MAX_CHILDREN = 4;
export const ORCHESTRATION_DEFAULT_TIMEOUT_SECONDS = 900;
export const ORCHESTRATION_MAX_TIMEOUT_SECONDS = 3_600;

export const OrchestrationStatus = z.enum(["running", "joining", "completed", "failed"]);
export type OrchestrationStatus = z.infer<typeof OrchestrationStatus>;

export const OrchestrationChildStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "timed_out",
]);
export type OrchestrationChildStatus = z.infer<typeof OrchestrationChildStatus>;

/** How the combined report reads, derived from the children rather than stored separately. */
export const OrchestrationOutcome = z.enum(["success", "partial", "failed"]);
export type OrchestrationOutcome = z.infer<typeof OrchestrationOutcome>;

export const OrchestrationChildView = z.object({
  id: Id,
  role: z.string(),
  botId: Id,
  botName: z.string(),
  status: OrchestrationChildStatus,
  error: z.string().nullable(),
  runId: Id.nullable(),
  threadId: Id.nullable(),
  completedAt: IsoDate.nullable(),
});
export type OrchestrationChildView = z.infer<typeof OrchestrationChildView>;

export const OrchestrationView = z.object({
  id: Id,
  goal: z.string(),
  status: OrchestrationStatus,
  /** Null while the orchestration is still running or joining. */
  outcome: OrchestrationOutcome.nullable(),
  parentBotId: Id,
  createdAt: IsoDate,
  deadlineAt: IsoDate,
  completedAt: IsoDate.nullable(),
  /** The final report's message in the parent chat, once the join run wrote one. */
  reportMessageId: Id.nullable(),
  children: z.array(OrchestrationChildView),
});
export type OrchestrationView = z.infer<typeof OrchestrationView>;

export const OrchestrationListInput = z.object({ botId: Id });
export type OrchestrationListInput = z.infer<typeof OrchestrationListInput>;

export const OrchestrationListOutput = z.object({
  orchestrations: z.array(OrchestrationView),
});
export type OrchestrationListOutput = z.infer<typeof OrchestrationListOutput>;
