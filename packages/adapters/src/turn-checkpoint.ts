import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { withoutThinkingFrom } from "./thinking-signatures.js";

export interface ComputerModeSelection {
  provider: string;
  id: string;
  connectionId?: string;
  auth: "oauth" | "api-key";
  thinkingLevel?: AgentRunModel["thinkingLevel"];
}

export interface ComputerModeCheckpoint {
  version: 1;
  mode: "main" | "computer";
  main: ComputerModeSelection;
  computer: ComputerModeSelection;
}

/** Internal, versioned transcript; never a client event payload. */
export interface PendingToolInvocationCheckpoint {
  invocationId: string;
  executionId: string;
  toolName: string;
  toolCallIndex?: number | null;
  runtimeDepth?: number;
  parentInvocationId?: string | null;
  invocationSequence?: number | null;
}

export interface TurnCheckpoint {
  version: 1;
  /** Credential-free role state; absent on legacy checkpoints. */
  computerMode?: ComputerModeCheckpoint;
  provider: string;
  model: string;
  systemPrompt: string;
  pendingToolCallId: string;
  /** Legacy single-call field retained for checkpoints written before R3. */
  pendingToolInvocationId?: string;
  /** Runtime-generated durable identities for all pending calls, including parallel calls. */
  pendingToolInvocations?: PendingToolInvocationCheckpoint[];
  messages: Message[];
  historyMessageIds?: string[];
  /** The instructions the saved system prompt was built from; own writes resume guarding on it. */
  ownInstructionsBaseline?: string;
  /** Executor-assigned occurrences include canonical arguments and the paused call. */
  effectOccurrences?: Array<{ executionId: string; fingerprint: string; occurrence: number }>;
  /** Only explicit sequential checkpoints guarantee an unstarted tail. */
  executionMode?: "parallel" | "sequential";
}

export function serializeTurnCheckpoint(checkpoint: TurnCheckpoint): string {
  return JSON.stringify(checkpoint);
}

export function restoreTurnCheckpoint(
  blob: string,
  model: Pick<AgentRunModel, "provider" | "id">,
): TurnCheckpoint {
  const checkpoint = JSON.parse(blob) as TurnCheckpoint;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.systemPrompt !== "string" ||
    typeof checkpoint.provider !== "string" ||
    typeof checkpoint.model !== "string" ||
    typeof checkpoint.pendingToolCallId !== "string" ||
    !Array.isArray(checkpoint.messages)
  ) {
    throw new Error("Unsupported turn checkpoint");
  }
  const messages = [...checkpoint.messages];
  while (messages.at(-1)?.role === "assistant") {
    const tail = messages.at(-1)!;
    if (tail.role !== "assistant" || (tail.stopReason !== "aborted" && tail.stopReason !== "error"))
      break;
    messages.pop();
  }
  return {
    ...checkpoint,
    messages:
      checkpoint.provider === model.provider && checkpoint.model === model.id
        ? messages
        : withoutThinkingFrom(messages, 0),
  };
}

/** Match results in transcript order: wire IDs may repeat in later responses. */
export function unresolvedTurnCheckpointCalls(messages: Message[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.content) if (call.type === "toolCall") pending.set(call.id, call);
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  return [...pending.values()];
}

/**
 * The Pi runtime resumes exactly one pending wire call (`pendingToolCallId`).
 * Other pending collection entries must not be treated as resumable.
 */
export function resumableInvocationIdsOf(checkpoint: string | undefined): Set<string> {
  if (!checkpoint) return new Set();
  try {
    const parsed = JSON.parse(checkpoint) as {
      pendingToolCallId?: unknown;
      pendingToolInvocationId?: unknown;
      pendingToolInvocations?: Array<{ invocationId?: unknown; executionId?: unknown }>;
    };
    if (Array.isArray(parsed.pendingToolInvocations)) {
      const pendingExecutionId =
        typeof parsed.pendingToolCallId === "string"
          ? JSON.stringify(["pi-tool", "main", parsed.pendingToolCallId])
          : undefined;
      const match = parsed.pendingToolInvocations.find(
        (entry) =>
          typeof entry.invocationId === "string" &&
          pendingExecutionId !== undefined &&
          entry.executionId === pendingExecutionId,
      );
      if (match && typeof match.invocationId === "string") return new Set([match.invocationId]);
    }
    if (typeof parsed.pendingToolInvocationId === "string") {
      return new Set([parsed.pendingToolInvocationId]);
    }
    return new Set();
  } catch {
    return new Set();
  }
}
