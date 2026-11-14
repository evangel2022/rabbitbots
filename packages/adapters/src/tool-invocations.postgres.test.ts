import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@rakazo/db";
import {
  bootstrapUserSpace,
  createDb,
  createRepos,
  loadRunTurnCheckpoint,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistTurnCheckpoint } from "./run-context.js";
import {
  claimToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  listUncertainToolInvocations,
  markToolHandlerStarted,
  prepareToolInvocation,
  recoverPendingToolInvocations,
  ToolInvocationConflictError,
  ToolInvocationLeaseError,
} from "./tool-invocations.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("durable tool invocations (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let secondDb: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let secondPrisma: PrismaClient;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let taskId: string;
  let runId: string;

  beforeAll(() =>
    runAsSystem("tool invocation setup", async () => {
      db = createDb(databaseUrl!);
      secondDb = createDb(databaseUrl!);
      prisma = db.prisma;
      secondPrisma = secondDb.prisma;
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      userId = `tool-invocation-user-${stamp}`;
      await prisma.user.create({
        data: {
          id: userId,
          name: "Invocation Test User",
          email: `tool-invocation-${stamp}@example.com`,
          emailVerified: true,
        },
      });
      const boot = await bootstrapUserSpace(
        prisma,
        { id: userId },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      );
      spaceId = boot.spaceId;
      const repos = createRepos(prisma);
      const bot = await repos.createBot(
        {
          userId,
          spaceId,
          email: `tool-invocation-${stamp}@example.com`,
          isDeploymentOwner: false,
        },
        {
          name: "Invocation Bot",
          description: "Invocation fixture",
          instructions: "",
          notifyOnFinish: true,
          spawnKey: `tool-invocation-${stamp}`,
        },
      );
      botId = bot.id;
      const botRow = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { thread: { select: { id: true } } },
      });
      threadId = botRow.thread!.id;
      const task = await prisma.task.create({
        data: {
          spaceId,
          botId,
          threadId,
          userId,
          prompt: "Invocation fixture task",
          status: "queued",
        },
        select: { id: true },
      });
      taskId = task.id;
      const run = await prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId,
          userId,
          status: "running",
          trigger: "user",
          leaseOwner: "checkpoint-worker",
          leaseFence: 1,
        },
        select: { id: true },
      });
      runId = run.id;
    }),
  );

  afterAll(() =>
    runAsSystem("tool invocation cleanup", async () => {
      if (prisma) {
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await db?.prisma.$disconnect();
      await secondDb?.prisma.$disconnect();
      await db?.pool.end();
      await secondDb?.pool.end();
    }),
  );

  it("persists a new runtime invocation before execution", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "A", value: 1 },
      secrets: [],
    });
    expect(prepared.terminal).toBe(false);
    if (prepared.terminal) throw new Error("unexpected terminal");
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row).toMatchObject({
      spaceId,
      runId,
      toolName: "delegate_task",
      status: "RECEIVED",
      attempt: 0,
    });
    expect(row.invocationId).toBeTruthy();
    expect(row.request).toEqual({ title: "A", value: 1 });
    expect(row.requestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes the invocation id into the durable turn checkpoint", () =>
    runAsSystem("tool invocation checkpoint test", async () => {
      const prepared = await prepareToolInvocation(prisma, {
        spaceId,
        runId,
        toolName: "delegate_task",
        args: { title: "checkpoint mapping" },
        secrets: [],
      });
      if (prepared.terminal) throw new Error("unexpected terminal");
      const executionId = JSON.stringify(["pi-tool", "main", "checkpoint-call"]);
      const checkpoint = {
        version: 1,
        provider: "fixture",
        model: "fixture",
        systemPrompt: "fixture",
        pendingToolCallId: "checkpoint-call",
        executionMode: "parallel",
        messages: [],
      };
      const ctx = {
        deps: { prisma },
        run: { id: runId, spaceId },
        workerId: "checkpoint-worker",
        fence: 1,
        state: {
          effects: {
            occurrences: [],
            counts: new Map(),
            restoredPending: undefined,
            pendingTurnCheckpoints: new Map([[executionId, () => JSON.stringify(checkpoint)]]),
            pendingToolInvocationIds: new Map([[executionId, prepared.row.invocationId]]),
            storedTurnCheckpoint: false,
          },
          ownInstructionsBaseline: "",
        },
      } as never;
      await persistTurnCheckpoint(ctx, executionId);
      const stored = await loadRunTurnCheckpoint(prisma, { id: runId, spaceId });
      expect(JSON.parse(stored!)).toMatchObject({
        pendingToolCallId: "checkpoint-call",
        pendingToolInvocationId: prepared.row.invocationId,
      });
    }));

  it("reuses the invocation id with the same request and rejects different arguments", async () => {
    const first = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "B" },
      secrets: [],
    });
    if (first.terminal) throw new Error("unexpected terminal");
    const second = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "B" },
      secrets: [],
      invocationId: first.row.invocationId,
    });
    expect(second.terminal).toBe(false);
    if (second.terminal) throw new Error("unexpected terminal");
    expect(second.row.id).toBe(first.row.id);
    await expect(
      prepareToolInvocation(prisma, {
        spaceId,
        runId,
        toolName: "delegate_task",
        args: { title: "B changed" },
        secrets: [],
        invocationId: first.row.invocationId,
      }),
    ).rejects.toBeInstanceOf(ToolInvocationConflictError);
    expect(
      await prisma.toolInvocation.count({
        where: { runId, invocationId: first.row.invocationId },
      }),
    ).toBe(1);
  });

  it("keeps the durable id when only the provider tool-call id changes", async () => {
    const first = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "provider diagnostic" },
      secrets: [],
      providerToolCallId: "provider-call-a",
    });
    if (first.terminal) throw new Error("unexpected terminal");
    const second = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "provider diagnostic" },
      secrets: [],
      providerToolCallId: "provider-call-b",
      invocationId: first.row.invocationId,
    });
    expect(second.terminal).toBe(false);
    if (second.terminal) throw new Error("unexpected terminal");
    expect(second.row.id).toBe(first.row.id);
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: first.row.id } });
    expect(row.providerToolCallId).toBe("provider-call-a");
  });

  it("creates a different invocation for the same arguments when no id is supplied", async () => {
    const first = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "same arguments" },
      secrets: [],
    });
    const second = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "same arguments" },
      secrets: [],
    });
    if (first.terminal || second.terminal) throw new Error("unexpected terminal");
    expect(first.row.invocationId).not.toBe(second.row.invocationId);
    expect(first.row.id).not.toBe(second.row.id);
  });

  it("serializes concurrent preparation with the same invocation id", async () => {
    const invocationId = `concurrent-${Date.now()}`;
    const first = await Promise.all([
      prepareToolInvocation(prisma, {
        spaceId,
        runId,
        toolName: "delegate_task",
        args: { title: "concurrent" },
        secrets: [],
        invocationId,
      }),
      prepareToolInvocation(secondPrisma, {
        spaceId,
        runId,
        toolName: "delegate_task",
        args: { title: "concurrent" },
        secrets: [],
        invocationId,
      }),
    ]);
    if (first.some((entry) => entry.terminal)) throw new Error("unexpected terminal");
    const nondeterministic = first as Array<Extract<(typeof first)[number], { terminal: false }>>;
    expect(nondeterministic[0]!.row.id).toBe(nondeterministic[1]!.row.id);
    expect(await prisma.toolInvocation.count({ where: { invocationId } })).toBe(1);
  });

  it("allows only one of two independent connections to claim the invocation", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "claim race" },
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const claims = await Promise.all([
      claimToolInvocation(prisma, { id: prepared.row.id, workerId: "worker-a", fence: 1 }),
      claimToolInvocation(secondPrisma, { id: prepared.row.id, workerId: "worker-b", fence: 2 }),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row.status).toBe("EXECUTING");
    expect(row.attempt).toBe(1);
    expect(row.fencingToken).toBe(1);
  });

  it("stores a successful result once and fences stale writers", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "fenced result" },
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const claimed = await claimToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-c",
      fence: 3,
    });
    if (!claimed.claimed) throw new Error("claim failed");
    await expect(
      completeToolInvocation(prisma, {
        id: prepared.row.id,
        workerId: "worker-stale",
        fence: claimed.fencingToken + 1,
        result: { ok: false },
        secrets: [],
      }),
    ).rejects.toBeInstanceOf(ToolInvocationLeaseError);
    await completeToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-c",
      fence: claimed.fencingToken,
      result: { ok: true },
      secrets: ["secret-value"],
    });
    const recovered = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "fenced result" },
      secrets: [],
      invocationId: prepared.row.invocationId,
    });
    expect(recovered).toMatchObject({
      terminal: true,
      status: "SUCCEEDED",
      result: { ok: true },
    });
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.fencingToken).toBe(1);
  });

  it("turns an abandoned executing invocation into uncertain instead of re-running it", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "crash recovery" },
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const claimed = await claimToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-d",
      fence: 4,
      leaseMs: 0,
    });
    if (!claimed.claimed) throw new Error("claim failed");
    const reclaimable = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "crash recovery" },
      secrets: [],
      invocationId: prepared.row.invocationId,
      recovered: true,
    });
    expect(reclaimable).toMatchObject({ terminal: false, reclaim: true });
    const reclaimed = await claimToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-e",
      fence: 5,
      reclaim: true,
    });
    if (!reclaimed.claimed) throw new Error("reclaim failed");
    await markToolHandlerStarted(prisma, {
      id: prepared.row.id,
      workerId: "worker-e",
      fence: reclaimed.fencingToken,
    });
    const recovered = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "crash recovery" },
      secrets: [],
      invocationId: prepared.row.invocationId,
      recovered: true,
    });
    expect(recovered).toMatchObject({ terminal: true, status: "UNCERTAIN" });
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row.status).toBe("UNCERTAIN");
    await expect(
      claimToolInvocation(prisma, { id: prepared.row.id, workerId: "worker-f", fence: 6 }),
    ).resolves.toMatchObject({ claimed: false });
  });

  it("fails an explicitly failed invocation without creating a new one", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "failure result" },
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const claimed = await claimToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-f",
      fence: 6,
    });
    if (!claimed.claimed) throw new Error("claim failed");
    await failToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-f",
      fence: claimed.fencingToken,
      error: "known failure",
    });
    const recovered = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "failure result" },
      secrets: [],
      invocationId: prepared.row.invocationId,
    });
    expect(recovered).toMatchObject({ terminal: true, status: "FAILED" });
  });

  it("persists runtime depth, order, turn and recoverability metadata", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "metadata" },
      secrets: [],
      turnId: "turn-fixture",
      messageId: "message-fixture",
      toolCallIndex: 7,
      runtimeDepth: 1,
      parentInvocationId: "parent-invocation",
      invocationSequence: 11,
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row).toMatchObject({
      turnId: "turn-fixture",
      messageId: "message-fixture",
      toolCallIndex: 7,
      runtimeDepth: 1,
      parentInvocationId: "parent-invocation",
      invocationSequence: 11,
      executionStage: "RECEIVED",
      recoverability: "FULL",
    });
  });

  it("recovers pending calls from a checkpoint and makes unresumable rows uncertain", async () => {
    const resumable = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "resumable" },
      secrets: [],
    });
    const orphan = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "orphan" },
      secrets: [],
    });
    if (resumable.terminal || orphan.terminal) throw new Error("unexpected terminal");
    const result = await recoverPendingToolInvocations(prisma, {
      runId,
      checkpointInvocationIds: new Set([resumable.row.invocationId]),
    });
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect(result.uncertain).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.toolInvocation.findUniqueOrThrow({ where: { id: resumable.row.id } }),
    ).toMatchObject({ status: "RECEIVED" });
    const uncertainRow = await prisma.toolInvocation.findUniqueOrThrow({
      where: { id: orphan.row.id },
    });
    expect(uncertainRow).toMatchObject({ status: "UNCERTAIN", recoverability: "NEEDS_CHECKPOINT" });
    const uncertain = await listUncertainToolInvocations(prisma, { runId });
    expect(uncertain.some((row) => row.id === orphan.row.id)).toBe(true);
  });

  it("marks handler-start and renews the lease only for the current owner", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "handler stage" },
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const claimed = await claimToolInvocation(prisma, {
      id: prepared.row.id,
      workerId: "worker-stage",
      fence: 8,
    });
    if (!claimed.claimed) throw new Error("claim failed");
    await markToolHandlerStarted(prisma, {
      id: prepared.row.id,
      workerId: "worker-stage",
      fence: claimed.fencingToken,
    });
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row).toMatchObject({ status: "EXECUTING", executionStage: "HANDLER_STARTED" });
  });

  it("keeps duplicate provider call ids as separate invocations", async () => {
    const first = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "same provider id" },
      secrets: [],
      providerToolCallId: "provider-call-reused",
    });
    const second = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "same provider id" },
      secrets: [],
      providerToolCallId: "provider-call-reused",
    });
    if (first.terminal || second.terminal) throw new Error("unexpected terminal");
    expect(first.row.invocationId).not.toBe(second.row.invocationId);
  });

  it("refuses safe recovery when the durable request had redacted secret fields", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "secret recovery", apiKey: "secret-value" },
      secrets: ["secret-value"],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const recovered = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "secret recovery", apiKey: "secret-value" },
      secrets: ["secret-value"],
      invocationId: prepared.row.invocationId,
      recovered: true,
    });
    expect(recovered).toMatchObject({ terminal: true, status: "UNCERTAIN" });
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(row).toMatchObject({ status: "UNCERTAIN", recoverability: "NEEDS_SECRET_REFERENCE" });
  });

  async function runCrashStage(stage: "received" | "claimed" | "handler" | "result") {
    const args = { stage, nonce: `${stage}-${Date.now()}-${Math.random()}` };
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "crash_fixture",
      args,
      secrets: [],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const counterDir = mkdtempSync(join(tmpdir(), "rakazo-r3-"));
    const counterFile = join(counterDir, "side-effects.log");
    const worker = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/tool-invocation-crash-worker.ts", import.meta.url)),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TOOL_INVOCATION_ID: prepared.row.invocationId,
          TOOL_INVOCATION_RUN_ID: runId,
          TOOL_INVOCATION_SPACE_ID: spaceId,
          TOOL_INVOCATION_WORKER_ID: `crash-worker-${stage}`,
          TOOL_INVOCATION_COUNTER: counterFile,
          TOOL_INVOCATION_CRASH_STAGE: stage,
        },
        stdio: "pipe",
      },
    );
    let output = "";
    let errorOutput = "";
    worker.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not reach ${stage}`)), 20_000);
      const check = () => {
        if (!output.includes("READY")) return;
        clearTimeout(timer);
        resolve();
      };
      worker.stdout.on("data", check);
      worker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`worker exited before ${stage}: ${code}; ${errorOutput}`));
      });
    });
    return { args, prepared, counterFile, worker, ready, exit: once(worker, "exit") };
  }

  const counterLines = (file: string) =>
    readFileSync(file, "utf8").trim().split("\n").filter(Boolean);

  it("SIGKILL before claim leaves a durable RECEIVED invocation", async () => {
    const run = await runCrashStage("received");
    await run.ready;
    try {
      expect(counterLines(run.counterFile)).toEqual(["received"]);
      const row = await prisma.toolInvocation.findUniqueOrThrow({
        where: { id: run.prepared.row.id },
      });
      expect(row.status).toBe("RECEIVED");
      run.worker.kill("SIGKILL");
      await run.exit;
      const recovery = await recoverPendingToolInvocations(prisma, {
        runId,
        checkpointInvocationIds: new Set(),
      });
      expect(recovery.uncertain).toBeGreaterThanOrEqual(1);
      const after = await prisma.toolInvocation.findUniqueOrThrow({
        where: { id: run.prepared.row.id },
      });
      expect(after.status).toBe("UNCERTAIN");
    } finally {
      if (!run.worker.killed) run.worker.kill("SIGKILL");
    }
  }, 30_000);

  it("SIGKILL after claim but before handler allows safe reclaim", async () => {
    const run = await runCrashStage("claimed");
    await run.ready;
    try {
      const row = await prisma.toolInvocation.findUniqueOrThrow({
        where: { id: run.prepared.row.id },
      });
      expect(row).toMatchObject({ status: "EXECUTING", executionStage: "CLAIMED" });
      run.worker.kill("SIGKILL");
      await run.exit;
      const recovered = await prepareToolInvocation(prisma, {
        spaceId,
        runId,
        toolName: "crash_fixture",
        args: run.args,
        secrets: [],
        invocationId: run.prepared.row.invocationId,
        recovered: true,
      });
      // The fixture args include a nonce; the durable row still proves recovery is safe.
      expect(recovered.terminal).toBe(false);
      if (!recovered.terminal) expect(recovered.reclaim).toBe(true);
      expect(counterLines(run.counterFile)).toEqual(["claimed"]);
    } finally {
      if (!run.worker.killed) run.worker.kill("SIGKILL");
    }
  }, 30_000);

  it("SIGKILL after handler side effect becomes UNCERTAIN and does not run again", async () => {
    const run = await runCrashStage("handler");
    await run.ready;
    try {
      const row = await prisma.toolInvocation.findUniqueOrThrow({
        where: { id: run.prepared.row.id },
      });
      expect(row).toMatchObject({ status: "EXECUTING", executionStage: "HANDLER_STARTED" });
      run.worker.kill("SIGKILL");
      await run.exit;
      const recovered = await prepareToolInvocation(prisma, {
        spaceId,
        runId,
        toolName: "crash_fixture",
        args: run.args,
        secrets: [],
        invocationId: run.prepared.row.invocationId,
        recovered: true,
      });
      expect(recovered).toMatchObject({ terminal: true, status: "UNCERTAIN" });
      expect(counterLines(run.counterFile)).toEqual(["claimed", "handler"]);
      const after = await prisma.toolInvocation.findUniqueOrThrow({
        where: { id: run.prepared.row.id },
      });
      expect(after.status).toBe("UNCERTAIN");
    } finally {
      if (!run.worker.killed) run.worker.kill("SIGKILL");
    }
  }, 30_000);

  it("returns a persisted result after the result-persisting worker exits", async () => {
    const run = await runCrashStage("result");
    void run.ready.catch(() => undefined);
    await run.exit;
    const row = await prisma.toolInvocation.findUniqueOrThrow({
      where: { id: run.prepared.row.id },
    });
    expect(row).toMatchObject({ status: "SUCCEEDED", executionStage: "RESULT_PERSISTED" });
    const recovered = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "crash_fixture",
      args: run.args,
      secrets: [],
      invocationId: run.prepared.row.invocationId,
      recovered: true,
    });
    expect(recovered).toMatchObject({ terminal: true, status: "SUCCEEDED" });
    expect(counterLines(run.counterFile)).toEqual(["claimed", "handler", "result"]);
  }, 30_000);

  it("redacts invocation arguments and results", async () => {
    const prepared = await prepareToolInvocation(prisma, {
      spaceId,
      runId,
      toolName: "delegate_task",
      args: { title: "redaction", apiKey: "secret-value", nested: { password: "secret-value" } },
      secrets: ["secret-value"],
    });
    if (prepared.terminal) throw new Error("unexpected terminal");
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id: prepared.row.id } });
    expect(JSON.stringify(row.request)).not.toContain("secret-value");
    expect(row).toMatchObject({ recoverability: "NEEDS_SECRET_REFERENCE" });
    expect(row.secretReferences).toBeTruthy();
  });
});
