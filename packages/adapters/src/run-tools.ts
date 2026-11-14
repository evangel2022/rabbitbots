import { randomUUID } from "node:crypto";
import type { AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { BACKGROUND_HELPER_TRIGGER, toolResultTaintsRun } from "@rakazo/core";
import { isTerminatingReplyResult } from "./approval-effect.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS, MODEL_CANNOT_SEE_MESSAGE } from "./model-vision.js";
import type { RunContext } from "./run-context.js";
import { persistTurnCheckpoint } from "./run-context.js";
import { noteComputerTaskStep } from "./run-progress.js";
import type { ToolHandler } from "./run-tool-gate.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { prepareToolRequest, resolveToolRequest } from "./run-tool-request.js";
import {
  BACKGROUND_HELPER_TOOL_NAMES,
  BUILTIN_AGENT_TOOL_NAMES,
  PAGE_BROWSER_TOOL_NAMES,
} from "./run-tool-selection.js";
import { computerTools, pageBrowserTool } from "./run-tools-computer.js";
import { emailTools } from "./run-tools-email.js";
import { feedbackTools } from "./run-tools-feedback.js";
import { fileTools } from "./run-tools-files.js";
import { fleetTools } from "./run-tools-fleet.js";
import { cloudAgentTool, connectorTool, integrationTools } from "./run-tools-integrations.js";
import { memoryTools } from "./run-tools-memory.js";
import { messagingTools } from "./run-tools-messaging.js";
import { pageTools } from "./run-tools-pages.js";
import { preferenceTools } from "./run-tools-preferences.js";
import { purchaseTools } from "./run-tools-purchases.js";
import { secretTools } from "./run-tools-secrets.js";
import { taskTools } from "./run-tools-tasks.js";
import {
  USER_COMPUTER_ACT_TOOL,
  USER_COMPUTER_OBSERVE_TOOL,
  USER_COMPUTER_SHELL_TOOL,
  userComputerAct,
  userComputerObserve,
  userComputerShell,
} from "./run-tools-user-computer.js";
import { strategicInitiativeToolAllowed } from "./strategic-initiative.js";
import {
  claimToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  markToolHandlerStarted,
  markToolInvocationUncertain,
  prepareToolInvocation,
  recoverToolInvocationResult,
  renewToolInvocationLease,
  rewindToolInvocationForSafeRetry,
} from "./tool-invocations.js";
import type { PendingToolInvocationCheckpoint } from "./turn-checkpoint.js";
import { argumentGiven } from "./update-bot-patch.js";
import { recoverDelegatedTaskForInvocation } from "./workforce-tasks.js";

const TOOL_HANDLERS = new Map<string, ToolHandler>([
  ...Object.entries(computerTools),
  ...Object.entries(fileTools),
  ...Object.entries(pageTools),
  ...Object.entries(memoryTools),
  ...Object.entries(integrationTools),
  ...Object.entries(taskTools),
  ...Object.entries(messagingTools),
  ...Object.entries(secretTools),
  ...Object.entries(fleetTools),
  [USER_COMPUTER_SHELL_TOOL, userComputerShell],
  [USER_COMPUTER_OBSERVE_TOOL, userComputerObserve],
  [USER_COMPUTER_ACT_TOOL, userComputerAct],
  ...Object.entries(purchaseTools),
  ...Object.entries(preferenceTools),
  ...Object.entries(feedbackTools),
  ...Object.entries(emailTools),
  ...[...PAGE_BROWSER_TOOL_NAMES].map((name) => [name, pageBrowserTool] as const),
]);

function toolHandler(name: string): ToolHandler {
  return (
    TOOL_HANDLERS.get(name) ?? (name.startsWith("cloud_agent_") ? cloudAgentTool : connectorTool)
  );
}

/** Nested helper calls carry a non-main namespace; depth 0 is the root agent. */
function runtimeDepthOf(executionId: string) {
  try {
    const parsed = JSON.parse(executionId) as unknown;
    if (!Array.isArray(parsed) || parsed[0] !== "pi-tool") return 0;
    return parsed[1] === "main" ? 0 : 1;
  } catch {
    return 0;
  }
}

/** Run one tool call of this run's model: gate it, then hand it to its tool family. */
export async function applyTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  _route?: unknown,
  observer?: AgentToolExecutionObserver,
) {
  // A bot naming itself in bot_id means its own settings. Dropping it here sends the call down
  // the own path everywhere: preparation, the stored approval, the handler and the check below.
  if (
    name === "update_bot" &&
    typeof args.bot_id === "string" &&
    args.bot_id.trim() === ctx.bot.id
  ) {
    const { bot_id: _self, ...own } = args;
    args = own;
  }
  try {
    return await dispatchTool(ctx, name, args, executionId, observer);
  } finally {
    // Editing its own profile returns only what this run wrote; a child's profile is another bot's.
    const ownProfile = name === "update_bot" && !argumentGiven(args.bot_id);
    if (toolResultTaintsRun(name) && !ownProfile) ctx.state.tainted = true;
  }
}

async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  observer: AgentToolExecutionObserver | undefined,
) {
  ctx.context.signal.throwIfAborted();
  if (!strategicInitiativeToolAllowed(name, ctx.run)) {
    return { error: "Daily check-ins can only ask or message the user." };
  }
  if (ctx.state.handedOff) {
    return {
      error: "This stage was handed off. End the turn without more tool calls.",
    };
  }
  if (ctx.tools.disabled.has(name)) {
    return { error: "This tool is disabled for this bot." };
  }
  // Only offered tools reach the model, but a runtime can still emit any name, and a connector
  // tool named like a local one still runs the local handler.
  if (
    ctx.run.trigger === BACKGROUND_HELPER_TRIGGER &&
    (BUILTIN_AGENT_TOOL_NAMES.has(name) || TOOL_HANDLERS.has(name)) &&
    !BACKGROUND_HELPER_TOOL_NAMES.has(name)
  ) {
    return {
      error: `${name} is not available to a background helper. Don't retry; say in your result what the bot should do.`,
    };
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name) && !ctx.computer.pageBrowserAllowed) {
    return { error: "Page browser is unavailable on this computer." };
  }
  if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !ctx.computer.acceptsImages) {
    return { error: MODEL_CANNOT_SEE_MESSAGE };
  }
  const request = await resolveToolRequest(ctx, name, args, executionId);
  if ("error" in request) return request;
  // A catalog call resolves to a connector tool after the checks above; one named like a local
  // tool (message_agent, cloud_agent_*, ...) would otherwise run that local handler instead.
  if (request.catalogRemapped && toolHandler(request.name) !== connectorTool) {
    return { error: "Connector tool name conflicts with a built-in tool" };
  }
  const refused = await prepareToolRequest(ctx, request);
  if (refused) return refused;
  noteComputerTaskStep(ctx.state.reply, request.name);
  const gate = await gateToolCall(ctx, request, observer);
  if ("result" in gate) return gate.result;
  const handler = toolHandler(gate.call.name);
  // Test doubles and non-runtime callers do not carry the durable invocation table.
  if (!ctx.deps.prisma.toolInvocation) {
    if (!gate.call.applied) return handler(ctx, gate.call);
    let outcome: "success" | "failure" = "failure";
    try {
      const result = await handler(ctx, gate.call);
      if (!isToolError(result)) outcome = "success";
      return result;
    } finally {
      await auditToolCall(ctx, gate.call.name, outcome, {
        effectId: gate.call.applied.effect.id,
        autoApproved: gate.call.bypassApproval,
      });
    }
  }

  const { effects } = ctx.state;
  const restoredInvocationId = effects.pendingToolInvocationIds.get(executionId);
  const invocationId = restoredInvocationId ?? randomUUID();
  effects.pendingToolInvocationIds.set(executionId, invocationId);
  effects.invocationSequence = (effects.invocationSequence ?? 0) + 1;
  const pendingMeta: PendingToolInvocationCheckpoint = {
    invocationId,
    executionId,
    toolName: gate.call.name,
    toolCallIndex: effects.invocationSequence,
    runtimeDepth: runtimeDepthOf(executionId),
    parentInvocationId: null,
    invocationSequence: effects.invocationSequence,
  };
  effects.pendingToolInvocationMeta.set(executionId, pendingMeta);
  let prepared: Awaited<ReturnType<typeof prepareToolInvocation>>;
  try {
    // A delegation transaction may commit before its invocation result can be stored. The
    // delegation row is stronger evidence than the stale invocation state, so return its
    // original child without re-entering the handler or creating another child.
    if (restoredInvocationId && gate.call.name === "delegate_task") {
      const recovered = await recoverDelegatedTaskForInvocation(ctx.deps.prisma, {
        spaceId: ctx.run.spaceId,
        invocationId: restoredInvocationId,
        args: gate.call.args,
      });
      if (recovered) {
        const result = {
          taskId: recovered.id,
          assigneeBotId: recovered.assigneeBotId,
          assigneeBotName: recovered.assigneeBotName,
          status: recovered.executionStatus,
        };
        await recoverToolInvocationResult(ctx.deps.prisma, {
          spaceId: ctx.run.spaceId,
          invocationId: restoredInvocationId,
          result,
          secrets: ctx.secrets,
        });
        return result;
      }
      // No delegation row exists, so the delegation transaction did not commit. Its
      // business transaction is atomic, which makes a replay of this handler safe.
      await rewindToolInvocationForSafeRetry(ctx.deps.prisma, {
        spaceId: ctx.run.spaceId,
        invocationId: restoredInvocationId,
      });
    }
    // Persist the assistant tool call and its runtime invocation id before creating the
    // execution row. A resumed pending call therefore knows the id even if the row write
    // was interrupted, while the handler still cannot run before the row is persisted.
    if (effects.pendingTurnCheckpoints.has(executionId)) {
      await persistTurnCheckpoint(ctx, executionId);
    }
    prepared = await prepareToolInvocation(ctx.deps.prisma, {
      spaceId: ctx.run.spaceId,
      runId: ctx.runId,
      toolName: gate.call.name,
      args: gate.call.args,
      secrets: ctx.secrets,
      providerToolCallId: executionId,
      invocationId,
      turnId: ctx.attempt?.id ?? null,
      toolCallIndex: pendingMeta.toolCallIndex,
      runtimeDepth: pendingMeta.runtimeDepth,
      parentInvocationId: pendingMeta.parentInvocationId,
      invocationSequence: pendingMeta.invocationSequence,
      recovered: Boolean(restoredInvocationId),
    });
    if (prepared.terminal) return prepared.result;

    const claim = await claimToolInvocation(ctx.deps.prisma, {
      id: prepared.row.id,
      workerId: ctx.workerId,
      fence: ctx.fence,
      reclaim: prepared.reclaim,
    });
    if (!claim.claimed) {
      prepared = await prepareToolInvocation(ctx.deps.prisma, {
        spaceId: ctx.run.spaceId,
        runId: ctx.runId,
        toolName: gate.call.name,
        args: gate.call.args,
        secrets: ctx.secrets,
        providerToolCallId: executionId,
        invocationId: prepared.row.invocationId,
      });
      if (prepared.terminal) return prepared.result;
      return { error: "This tool invocation is already being executed." };
    }

    const invocationRow = prepared.row;
    // Persist the handler boundary before any handler code runs. If this write is
    // lost, no handler is invoked and recovery may safely reclaim the CLAIMED row.
    try {
      await markToolHandlerStarted(ctx.deps.prisma, {
        id: invocationRow.id,
        workerId: ctx.workerId,
        fence: claim.fencingToken,
      });
    } catch (error) {
      await markToolInvocationUncertain(
        ctx.deps.prisma,
        prepared.row.id,
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      throw error;
    }

    let leaseLost = false;
    let leaseRenewing = false;
    const leaseTimer = setInterval(() => {
      if (leaseRenewing || leaseLost) return;
      leaseRenewing = true;
      void renewToolInvocationLease(ctx.deps.prisma, {
        id: invocationRow.id,
        workerId: ctx.workerId,
        fence: claim.fencingToken,
      })
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            ctx.runtimeAbortController.abort(
              new Error("Tool invocation execution lease was lost."),
            );
          }
        })
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          leaseRenewing = false;
        });
    }, 5_000);
    leaseTimer.unref?.();

    const handlerCall = { ...gate.call, invocationId: invocationRow.invocationId };
    let outcome: "success" | "failure" = "failure";
    let result: unknown;
    try {
      result = await handler(ctx, handlerCall);
    } catch (error) {
      if (leaseLost) {
        await markToolInvocationUncertain(
          ctx.deps.prisma,
          invocationRow.id,
          "The tool handler may have started after its execution lease was lost.",
        ).catch(() => undefined);
      } else {
        await failToolInvocation(ctx.deps.prisma, {
          id: invocationRow.id,
          workerId: ctx.workerId,
          fence: claim.fencingToken,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(leaseTimer);
    }
    if (leaseLost) {
      await markToolInvocationUncertain(
        ctx.deps.prisma,
        invocationRow.id,
        "The tool handler completed after its execution lease was lost; its effect is uncertain.",
      ).catch(() => undefined);
      throw new Error("Tool invocation lease was lost while the handler was running.");
    }
    try {
      await completeToolInvocation(ctx.deps.prisma, {
        id: invocationRow.id,
        workerId: ctx.workerId,
        fence: claim.fencingToken,
        result,
        secrets: ctx.secrets,
      });
    } catch (error) {
      // The handler returned, so the side effect is not provably absent. Preserve uncertainty
      // instead of letting a later worker run it again.
      await markToolInvocationUncertain(
        ctx.deps.prisma,
        invocationRow.id,
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      throw error;
    }
    if (!isToolError(result)) outcome = "success";
    if (gate.call.applied) {
      await auditToolCall(ctx, gate.call.name, outcome, {
        effectId: gate.call.applied.effect.id,
        autoApproved: gate.call.bypassApproval,
      });
    }
    return result;
  } finally {
    effects.pendingToolInvocationIds.delete(executionId);
    effects.pendingToolInvocationMeta.delete(executionId);
  }
}

export function isToolError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("error" in result) return true;
  return isTerminatingReplyResult(result);
}
