import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { redactToolArgsForReview } from "./auto-review.js";

export const TOOL_INVOCATION_STATUS = {
  received: "RECEIVED",
  executing: "EXECUTING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  uncertain: "UNCERTAIN",
} as const;

export type ToolInvocationStatus =
  (typeof TOOL_INVOCATION_STATUS)[keyof typeof TOOL_INVOCATION_STATUS];

export const TOOL_INVOCATION_STAGE = {
  received: "RECEIVED",
  claimed: "CLAIMED",
  handlerStarted: "HANDLER_STARTED",
  resultPersisted: "RESULT_PERSISTED",
  uncertain: "UNCERTAIN",
  failed: "FAILED",
} as const;

export type ToolInvocationStage =
  (typeof TOOL_INVOCATION_STAGE)[keyof typeof TOOL_INVOCATION_STAGE];

export const TOOL_INVOCATION_RECOVERABILITY = {
  full: "FULL",
  needsCheckpoint: "NEEDS_CHECKPOINT",
  needsSecretReference: "NEEDS_SECRET_REFERENCE",
  unknown: "UNKNOWN",
} as const;

export type ToolInvocationRecoverability =
  (typeof TOOL_INVOCATION_RECOVERABILITY)[keyof typeof TOOL_INVOCATION_RECOVERABILITY];

/** Minimal durable projection carried by a runtime turn checkpoint. */
export interface PendingToolInvocation {
  invocationId: string;
  executionId: string;
  toolName: string;
  toolCallIndex?: number | null;
  runtimeDepth?: number;
  parentInvocationId?: string | null;
  invocationSequence?: number | null;
}

const TOOL_INVOCATION_LEASE_MS = 5 * 60_000;

const SENSITIVE_KEY = /(?:secret|token|password|api[_-]?key|authorization|cookie|credential)/i;

export class ToolInvocationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInvocationConflictError";
  }
}

export class ToolInvocationLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInvocationLeaseError";
  }
}

export type PreparedToolInvocation =
  | {
      terminal: true;
      result: unknown;
      status: ToolInvocationStatus;
    }
  | {
      terminal: false;
      /** The row is EXECUTING/CLAIMED and this caller may reclaim it safely. */
      reclaim?: boolean;
      row: {
        id: string;
        invocationId: string;
        status: string;
        executionStage: string;
        recoverability: string;
      };
    };

function normalizedJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return String(value);
  }
}

function redactNested(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactNested(item, secrets));
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      SENSITIVE_KEY.test(key) ? key : redactSecrets(key, secrets),
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactNested(nested, secrets),
    ]),
  );
}

function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.flatMap((value, index) =>
      changedPaths(value, after[index], `${prefix}[${index}]`),
    );
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return [prefix || "<root>"];
}

function invocationRequest(
  args: Record<string, unknown>,
  secrets: readonly string[],
): {
  request: unknown;
  digest: string;
  recoverability: ToolInvocationRecoverability;
  secretReferences: { fields: string[] } | null;
} {
  const normalized = normalizedJson(args) as Record<string, unknown>;
  const digest = createHash("sha256").update(stableJsonValue(normalized)).digest("hex");
  const redacted = redactNested(redactToolArgsForReview(normalized, [...secrets]), secrets);
  const complete = stableJsonValue(normalized) === stableJsonValue(redacted);
  return {
    request: complete ? normalized : redacted,
    digest,
    recoverability: complete
      ? TOOL_INVOCATION_RECOVERABILITY.full
      : TOOL_INVOCATION_RECOVERABILITY.needsSecretReference,
    secretReferences: complete
      ? null
      : { fields: changedPaths(normalized, redacted).slice(0, 100) },
  };
}

function invocationResult(result: unknown, secrets: readonly string[]): unknown {
  return redactNested(normalizedJson(result), secrets);
}

function terminalFromRow(row: {
  status: string;
  result: unknown;
  error: string | null;
}): PreparedToolInvocation | undefined {
  if (row.status === TOOL_INVOCATION_STATUS.succeeded) {
    return {
      terminal: true,
      result: row.result,
      status: TOOL_INVOCATION_STATUS.succeeded,
    };
  }
  if (row.status === TOOL_INVOCATION_STATUS.failed) {
    return {
      terminal: true,
      result: { error: row.error ?? "This tool invocation failed." },
      status: TOOL_INVOCATION_STATUS.failed,
    };
  }
  if (row.status === TOOL_INVOCATION_STATUS.uncertain) {
    return {
      terminal: true,
      result: {
        error: row.error ?? "The earlier tool invocation has an uncertain result.",
        uncertain: true,
      },
      status: TOOL_INVOCATION_STATUS.uncertain,
    };
  }
  return undefined;
}

function activeLease(row: { leaseOwner: string | null; leaseExpiresAt: Date | null }) {
  return (
    Boolean(row.leaseOwner) &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() > Date.now()
  );
}

function canReclaim(
  row: {
    status: string;
    executionStage: string;
    recoverability: string;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
  },
  recovered: boolean,
) {
  return (
    row.status === TOOL_INVOCATION_STATUS.executing &&
    row.executionStage === TOOL_INVOCATION_STAGE.claimed &&
    row.recoverability === TOOL_INVOCATION_RECOVERABILITY.full &&
    (recovered || !activeLease(row))
  );
}

type ExistingRow = {
  id: string;
  spaceId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  status: string;
  executionStage: string;
  recoverability: string;
  requestDigest: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  result: unknown;
  error: string | null;
};

function resolveExisting(
  row: ExistingRow,
  input: {
    runId: string;
    toolName: string;
    digest: string;
    recovered?: boolean;
  },
): PreparedToolInvocation {
  if (row.runId !== input.runId) {
    throw new ToolInvocationConflictError(
      "This tool invocation belongs to another run in this Space.",
    );
  }
  if (row.toolName !== input.toolName || row.requestDigest !== input.digest) {
    throw new ToolInvocationConflictError(
      "The same tool invocation id was reused with different tool arguments.",
    );
  }
  const terminal = terminalFromRow(row);
  if (terminal) return terminal;
  if (row.status === TOOL_INVOCATION_STATUS.executing) {
    if (canReclaim(row, Boolean(input.recovered))) {
      return {
        terminal: false,
        reclaim: true,
        row: {
          id: row.id,
          invocationId: row.invocationId,
          status: row.status,
          executionStage: row.executionStage,
          recoverability: row.recoverability,
        },
      };
    }
    if (activeLease(row) && !input.recovered) {
      return {
        terminal: true,
        result: { error: "This tool invocation is already being executed." },
        status: TOOL_INVOCATION_STATUS.executing,
      };
    }
    return {
      terminal: true,
      result: {
        error: "The earlier tool invocation may have run, but its result was not recorded.",
        uncertain: true,
      },
      status: TOOL_INVOCATION_STATUS.uncertain,
    };
  }
  if (input.recovered && row.recoverability !== TOOL_INVOCATION_RECOVERABILITY.full) {
    return {
      terminal: true,
      result: {
        error: "This tool invocation cannot be resumed safely because its request was redacted.",
        uncertain: true,
      },
      status: TOOL_INVOCATION_STATUS.uncertain,
    };
  }
  if (
    row.status !== TOOL_INVOCATION_STATUS.received &&
    row.status !== TOOL_INVOCATION_STATUS.executing
  ) {
    throw new ToolInvocationConflictError(`Unsupported tool invocation status: ${row.status}`);
  }
  return {
    terminal: false,
    row: {
      id: row.id,
      invocationId: row.invocationId,
      status: row.status,
      executionStage: row.executionStage,
      recoverability: row.recoverability,
    },
  };
}

/**
 * Persist or retrieve the durable identity for one runtime tool call.
 *
 * `invocationId` is supplied only when the call was restored from a turn checkpoint.
 * A new call always gets a new runtime-generated id, even when its tool name and
 * arguments match an earlier call. Provider ids remain diagnostic.
 */
export async function prepareToolInvocation(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    runId: string;
    toolName: string;
    args: Record<string, unknown>;
    secrets: readonly string[];
    providerToolCallId?: string | null;
    invocationId?: string | null;
    turnId?: string | null;
    messageId?: string | null;
    toolCallIndex?: number | null;
    runtimeDepth?: number;
    parentInvocationId?: string | null;
    invocationSequence?: number | null;
    /** True only when the id came from a restored checkpoint. */
    recovered?: boolean;
  },
): Promise<PreparedToolInvocation> {
  const request = invocationRequest(input.args, input.secrets);
  let row = input.invocationId
    ? await prisma.toolInvocation.findUnique({
        where: {
          spaceId_invocationId: {
            spaceId: input.spaceId,
            invocationId: input.invocationId,
          },
        },
      })
    : null;

  if (row) {
    const resolved = resolveExisting(row, {
      runId: input.runId,
      toolName: input.toolName,
      digest: request.digest,
      recovered: input.recovered,
    });
    if (resolved.terminal && resolved.status === TOOL_INVOCATION_STATUS.uncertain) {
      await markToolInvocationUncertain(prisma, row.id, "The invocation cannot be resumed safely.");
    }
    return resolved;
  }

  const invocationId = input.invocationId ?? randomUUID();
  try {
    row = await prisma.toolInvocation.create({
      data: {
        spaceId: input.spaceId,
        runId: input.runId,
        invocationId,
        providerToolCallId: input.providerToolCallId ?? null,
        toolName: input.toolName,
        turnId: input.turnId ?? null,
        messageId: input.messageId ?? null,
        toolCallIndex: input.toolCallIndex ?? null,
        runtimeDepth: input.runtimeDepth ?? 0,
        parentInvocationId: input.parentInvocationId ?? null,
        invocationSequence: input.invocationSequence ?? null,
        executionStage: TOOL_INVOCATION_STAGE.received,
        recoverability: request.recoverability,
        secretReferences: request.secretReferences as never,
        request: request.request as never,
        requestDigest: request.digest,
        status: TOOL_INVOCATION_STATUS.received,
      },
    });
    return {
      terminal: false,
      row: {
        id: row.id,
        invocationId: row.invocationId,
        status: row.status,
        executionStage: row.executionStage,
        recoverability: row.recoverability,
      },
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.toolInvocation.findUnique({
      where: {
        spaceId_invocationId: { spaceId: input.spaceId, invocationId },
      },
    });
    if (!raced) throw error;
    const resolved = resolveExisting(raced, {
      runId: input.runId,
      toolName: input.toolName,
      digest: request.digest,
      recovered: input.recovered,
    });
    if (resolved.terminal && resolved.status === TOOL_INVOCATION_STATUS.uncertain) {
      await markToolInvocationUncertain(
        prisma,
        raced.id,
        "The invocation cannot be resumed safely.",
      );
    }
    return resolved;
  }
}

export async function claimToolInvocation(
  prisma: PrismaClient,
  input: {
    id: string;
    workerId: string;
    fence: number;
    leaseMs?: number;
    reclaim?: boolean;
  },
): Promise<
  | { claimed: true; fencingToken: number }
  | { claimed: false; row: { status: string; result: unknown; error: string | null } }
> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? TOOL_INVOCATION_LEASE_MS));
  const updated = await prisma.toolInvocation.updateMany({
    where: input.reclaim
      ? {
          id: input.id,
          status: TOOL_INVOCATION_STATUS.executing,
          executionStage: TOOL_INVOCATION_STAGE.claimed,
        }
      : { id: input.id, status: TOOL_INVOCATION_STATUS.received },
    data: {
      status: TOOL_INVOCATION_STATUS.executing,
      executionStage: TOOL_INVOCATION_STAGE.claimed,
      attempt: { increment: 1 },
      fencingToken: { increment: 1 },
      leaseOwner: input.workerId,
      leaseExpiresAt,
      startedAt: now,
    },
  });
  if (updated.count === 1) {
    const row = await prisma.toolInvocation.findUniqueOrThrow({
      where: { id: input.id },
      select: { fencingToken: true },
    });
    return { claimed: true, fencingToken: row.fencingToken };
  }
  const row = await prisma.toolInvocation.findUniqueOrThrow({
    where: { id: input.id },
    select: { status: true, result: true, error: true },
  });
  return { claimed: false, row };
}

/** Persist the boundary immediately before tool handler code can run. */
export async function markToolHandlerStarted(
  prisma: PrismaClient,
  input: { id: string; workerId: string; fence: number; leaseMs?: number },
): Promise<void> {
  const updated = await prisma.toolInvocation.updateMany({
    where: {
      id: input.id,
      status: TOOL_INVOCATION_STATUS.executing,
      executionStage: TOOL_INVOCATION_STAGE.claimed,
      leaseOwner: input.workerId,
      fencingToken: input.fence,
    },
    data: {
      executionStage: TOOL_INVOCATION_STAGE.handlerStarted,
      leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? TOOL_INVOCATION_LEASE_MS)),
    },
  });
  if (updated.count !== 1) {
    throw new ToolInvocationLeaseError("The tool invocation execution lease was lost.");
  }
}

/** Extend the invocation lease while a handler is running. False means execution lost. */
export async function renewToolInvocationLease(
  prisma: PrismaClient,
  input: { id: string; workerId: string; fence: number; leaseMs?: number },
): Promise<boolean> {
  const updated = await prisma.toolInvocation.updateMany({
    where: {
      id: input.id,
      status: TOOL_INVOCATION_STATUS.executing,
      executionStage: TOOL_INVOCATION_STAGE.handlerStarted,
      leaseOwner: input.workerId,
      fencingToken: input.fence,
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? TOOL_INVOCATION_LEASE_MS)),
    },
  });
  return updated.count === 1;
}

export async function completeToolInvocation(
  prisma: PrismaClient,
  input: {
    id: string;
    workerId: string;
    fence: number;
    result: unknown;
    secrets: readonly string[];
  },
): Promise<void> {
  const completed = await prisma.toolInvocation.updateMany({
    where: {
      id: input.id,
      status: TOOL_INVOCATION_STATUS.executing,
      executionStage: {
        in: [TOOL_INVOCATION_STAGE.claimed, TOOL_INVOCATION_STAGE.handlerStarted],
      },
      leaseOwner: input.workerId,
      fencingToken: input.fence,
    },
    data: {
      status: TOOL_INVOCATION_STATUS.succeeded,
      executionStage: TOOL_INVOCATION_STAGE.resultPersisted,
      result: invocationResult(input.result, input.secrets) as never,
      error: null,
      completedAt: new Date(),
      leaseExpiresAt: null,
    },
  });
  if (completed.count !== 1) {
    throw new ToolInvocationLeaseError("The tool invocation execution lease was lost.");
  }
}

export async function failToolInvocation(
  prisma: PrismaClient,
  input: {
    id: string;
    workerId: string;
    fence: number;
    error: string;
  },
): Promise<void> {
  const failed = await prisma.toolInvocation.updateMany({
    where: {
      id: input.id,
      status: TOOL_INVOCATION_STATUS.executing,
      executionStage: {
        in: [TOOL_INVOCATION_STAGE.claimed, TOOL_INVOCATION_STAGE.handlerStarted],
      },
      leaseOwner: input.workerId,
      fencingToken: input.fence,
    },
    data: {
      status: TOOL_INVOCATION_STATUS.failed,
      executionStage: TOOL_INVOCATION_STAGE.failed,
      error: input.error.slice(0, 8_000),
      completedAt: new Date(),
      leaseExpiresAt: null,
    },
  });
  if (failed.count !== 1) {
    throw new ToolInvocationLeaseError("The tool invocation execution lease was lost.");
  }
}

/**
 * Resolve an invocation whose executor vanished. This never returns it to RECEIVED
 * and never re-runs a handler.
 */
export async function markToolInvocationUncertain(
  prisma: PrismaClient,
  id: string,
  error: string,
  recoverability?: ToolInvocationRecoverability,
): Promise<void> {
  await prisma.toolInvocation.updateMany({
    where: {
      id,
      status: { in: [TOOL_INVOCATION_STATUS.received, TOOL_INVOCATION_STATUS.executing] },
    },
    data: {
      status: TOOL_INVOCATION_STATUS.uncertain,
      executionStage: TOOL_INVOCATION_STAGE.uncertain,
      recoverability: recoverability ?? undefined,
      error: error.slice(0, 8_000),
      completedAt: new Date(),
      leaseExpiresAt: null,
    },
  });
}

/**
 * Lightweight database recovery for a run the executor is about to resume.
 * Rows represented by the turn checkpoint remain for the runtime to resume.
 * Rows lacking runtime state are made UNCERTAIN; they are never re-executed.
 */
export async function recoverPendingToolInvocations(
  prisma: PrismaClient,
  input: {
    runId: string;
    checkpointInvocationIds: ReadonlySet<string>;
  },
): Promise<{ recovered: number; uncertain: number }> {
  const rows = await prisma.toolInvocation.findMany({
    where: {
      runId: input.runId,
      status: { in: [TOOL_INVOCATION_STATUS.received, TOOL_INVOCATION_STATUS.executing] },
    },
    select: { id: true, invocationId: true },
  });
  let uncertain = 0;
  for (const row of rows) {
    if (input.checkpointInvocationIds.has(row.invocationId)) continue;
    await markToolInvocationUncertain(
      prisma,
      row.id,
      "The tool invocation has no resumable runtime checkpoint; its outcome is uncertain.",
      TOOL_INVOCATION_RECOVERABILITY.needsCheckpoint,
    );
    uncertain += 1;
  }
  return { recovered: rows.length - uncertain, uncertain };
}

export interface UncertainToolInvocationView {
  id: string;
  spaceId: string;
  runId: string;
  invocationId: string;
  toolName: string;
  executionStage: string;
  recoverability: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/** Lightweight diagnostics/query surface; deliberately read-only. */
export async function listUncertainToolInvocations(
  prisma: PrismaClient,
  input: { spaceId?: string; runId?: string; limit?: number } = {},
): Promise<UncertainToolInvocationView[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  return prisma.toolInvocation.findMany({
    where: {
      status: TOOL_INVOCATION_STATUS.uncertain,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      spaceId: true,
      runId: true,
      invocationId: true,
      toolName: true,
      executionStage: true,
      recoverability: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  });
}

/**
 * Persist a result recovered from a committed business transaction. Used only when
 * the business row proves the handler effect exists; it never re-runs a handler.
 */
export async function recoverToolInvocationResult(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    invocationId: string;
    result: unknown;
    secrets: readonly string[];
  },
): Promise<void> {
  const updated = await prisma.toolInvocation.updateMany({
    where: {
      spaceId: input.spaceId,
      invocationId: input.invocationId,
      status: {
        in: [
          TOOL_INVOCATION_STATUS.received,
          TOOL_INVOCATION_STATUS.executing,
          TOOL_INVOCATION_STATUS.uncertain,
        ],
      },
    },
    data: {
      status: TOOL_INVOCATION_STATUS.succeeded,
      executionStage: TOOL_INVOCATION_STAGE.resultPersisted,
      result: invocationResult(input.result, input.secrets) as never,
      error: null,
      completedAt: new Date(),
      leaseExpiresAt: null,
    },
  });
  if (updated.count !== 1) {
    throw new ToolInvocationLeaseError(
      "The tool invocation could not be recovered from its business result.",
    );
  }
}

/**
 * Rewind a runtime invocation whose handler is safe to replay because its business
 * transaction is atomic. Only delegation uses this after proving no delegation row exists.
 */
export async function rewindToolInvocationForSafeRetry(
  prisma: PrismaClient,
  input: { spaceId: string; invocationId: string },
): Promise<boolean> {
  const updated = await prisma.toolInvocation.updateMany({
    where: {
      spaceId: input.spaceId,
      invocationId: input.invocationId,
      status: TOOL_INVOCATION_STATUS.executing,
    },
    data: {
      status: TOOL_INVOCATION_STATUS.received,
      executionStage: TOOL_INVOCATION_STAGE.received,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      error: null,
    },
  });
  return updated.count === 1;
}
