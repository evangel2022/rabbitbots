import type { ConnectorTool } from "@rakazo/adapter-kit";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { expect, it } from "vitest";
import { namedAgentTools } from "./pi-runtime-tools.js";
import type { RunContext } from "./run-context.js";
import { nextMutatingEffectOccurrence, restoreTurnCheckpointEffects } from "./run-context.js";
import { PausedTurnToolsUnavailableError } from "./run-lifecycle.js";

function fixture(tools: ConnectorTool[] = []) {
  return {
    runId: "run-1",
    tools: { offered: tools },
    state: {
      effects: {
        occurrences: [],
        counts: new Map(),
        restoredPending: undefined,
        pendingToolInvocationIds: new Map(),
        pendingToolInvocationMeta: new Map(),
        invocationSequence: 0,
      },
    },
  } as unknown as RunContext;
}
const tool = (name: string): ConnectorTool => ({
  name,
  description: "Fixture",
  inputSchema: { type: "object" },
});
const model = { provider: "fixture", id: "main" };
function checkpoint(name: string, mode?: "main" | "computer") {
  return JSON.stringify({
    version: 1,
    provider: model.provider,
    model: model.id,
    systemPrompt: "Fixture",
    pendingToolCallId: "pending",
    executionMode: "sequential",
    computerMode: mode
      ? {
          version: 1,
          mode,
          main: { ...model, auth: "api-key", connectionId: "main-account" },
          computer: { ...model, id: "computer", auth: "api-key", connectionId: "computer-account" },
        }
      : undefined,
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "pending", name, arguments: {} }] },
    ],
  });
}
it.each([
  ["main", "enter_computer_mode"],
  ["computer", "leave_computer_mode"],
] as const)("accepts only the runtime transition for authenticated %s mode", (mode, name) => {
  const blob = checkpoint(name, mode);
  expect(restoreTurnCheckpointEffects(fixture(), blob, model, mode)).toBe(blob);
  expect(restoreTurnCheckpointEffects(fixture(), blob, model)).toBeUndefined();
});
it.each([
  ["main", "leave_computer_mode"],
  ["computer", "enter_computer_mode"],
] as const)("rejects wrong-mode transition in %s", (mode, name) => {
  expect(
    restoreTurnCheckpointEffects(fixture(), checkpoint(name, mode), model, mode),
  ).toBeUndefined();
});
it.each(["enter_computer_mode", "leave_computer_mode"])(
  "does not authorize %s on a legacy checkpoint",
  (name) => {
    expect(restoreTurnCheckpointEffects(fixture(), checkpoint(name), model)).toBeUndefined();
    expect(
      restoreTurnCheckpointEffects(fixture(), checkpoint(name), model, "main"),
    ).toBeUndefined();
  },
);
it.each(["enter_computer_mode", "leave_computer_mode", "leave.computer.mode"])(
  "rejects connector wire-name collisions with %s",
  (name) => {
    expect(
      restoreTurnCheckpointEffects(
        fixture([tool(name)]),
        checkpoint("leave_computer_mode", "computer"),
        model,
        "computer",
      ),
    ).toBeUndefined();
  },
);
it("keeps canonical wire names and saved effect occurrences unchanged", () => {
  const tools = [tool("destination.write"), tool("destination_write")];
  const named = namedAgentTools(tools).find((entry) => entry.tool.name === "destination.write")!;
  const ctx = fixture(tools);
  const saved = JSON.parse(checkpoint(named.name, "computer"));
  const executionId = JSON.stringify(["pi-tool", "main", "pending"]);
  const fingerprint = toolEffectIdempotencyKey("run-1", "destination.write", {});
  saved.effectOccurrences = [{ executionId, fingerprint, occurrence: 3 }];
  const blob = JSON.stringify(saved);
  expect(restoreTurnCheckpointEffects(ctx, blob, model, "computer")).toBe(blob);
  expect(nextMutatingEffectOccurrence(ctx, "destination.write", {}, executionId)).toBe(3);
  expect(nextMutatingEffectOccurrence(ctx, "destination.write", {}, "later")).toBe(4);
  expect(ctx.state.effects.occurrences[0]).toEqual(saved.effectOccurrences[0]);
});
it("reports a pinned turn whose pending tool is offline as unavailable, not incompatible", () => {
  expect(() =>
    restoreTurnCheckpointEffects(
      fixture(),
      checkpoint("desktop_run", "computer"),
      model,
      "computer",
    ),
  ).toThrow(PausedTurnToolsUnavailableError);
  expect(restoreTurnCheckpointEffects(fixture(), checkpoint("desktop_run"), model)).toBeUndefined();
});

it("restores the durable invocation id for the pending tool call", () => {
  const ctx = fixture([tool("fixture_tool")]);
  const saved = JSON.parse(checkpoint("fixture_tool"));
  saved.effectOccurrences = [];
  saved.pendingToolInvocationId = "invocation-1";
  const blob = JSON.stringify(saved);
  expect(restoreTurnCheckpointEffects(ctx, blob, model)).toBe(blob);
  expect(
    ctx.state.effects.pendingToolInvocationIds.get(JSON.stringify(["pi-tool", "main", "pending"])),
  ).toBe("invocation-1");
});

it("restores every parallel pending invocation and its order", () => {
  const ctx = fixture([tool("fixture_tool")]);
  const saved = JSON.parse(checkpoint("fixture_tool"));
  saved.effectOccurrences = [];
  saved.pendingToolInvocations = [
    {
      invocationId: "invocation-a",
      executionId: JSON.stringify(["pi-tool", "main", "call-a"]),
      toolName: "fixture_tool",
      toolCallIndex: 0,
      runtimeDepth: 0,
      toolCallSequence: 4,
      invocationSequence: 4,
    },
    {
      invocationId: "invocation-b",
      executionId: JSON.stringify(["pi-tool", "helper", "call-b"]),
      toolName: "fixture_tool",
      toolCallIndex: 1,
      runtimeDepth: 1,
      parentInvocationId: "parent-invocation",
      invocationSequence: 5,
    },
  ];
  const blob = JSON.stringify(saved);
  expect(restoreTurnCheckpointEffects(ctx, blob, model)).toBe(blob);
  expect(ctx.state.effects.pendingToolInvocationMeta.size).toBe(2);
  expect(
    ctx.state.effects.pendingToolInvocationIds.get(JSON.stringify(["pi-tool", "main", "call-a"])),
  ).toBe("invocation-a");
  expect(
    ctx.state.effects.pendingToolInvocationIds.get(JSON.stringify(["pi-tool", "helper", "call-b"])),
  ).toBe("invocation-b");
  expect(ctx.state.effects.invocationSequence).toBe(5);
});
