// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { OrchestrationView } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

import { OrchestrationStrip } from "./orchestration-strip";

let container: HTMLDivElement;
let root: Root;

function render(orchestration: OrchestrationView, onOpenBot = vi.fn(), onOpenReport = vi.fn()) {
  act(() => {
    root.render(
      <OrchestrationStrip
        orchestration={orchestration}
        onOpenBot={onOpenBot}
        onOpenReport={onOpenReport}
      />,
    );
  });
  return { onOpenBot, onOpenReport };
}

function view(overrides: Partial<OrchestrationView> = {}): OrchestrationView {
  return {
    id: "orchestration-1",
    goal: "Analyze Glean for investment.",
    status: "running",
    outcome: null,
    parentBotId: "ceo",
    createdAt: "2026-11-10T12:00:00.000Z",
    deadlineAt: "2026-11-10T12:15:00.000Z",
    completedAt: null,
    reportMessageId: null,
    children: [
      {
        id: "child-research",
        role: "research",
        botId: "research",
        botName: "Research Bot",
        status: "running",
        error: null,
        runId: "run-research",
        threadId: "thread-research",
        completedAt: null,
      },
      {
        id: "child-finance",
        role: "finance",
        botId: "finance",
        botName: "Finance Bot",
        status: "pending",
        error: null,
        runId: null,
        threadId: null,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows each child's real state and opens its chat", () => {
  const onOpenBot = vi.fn();
  render(view(), onOpenBot);
  const text = container.textContent ?? "";
  expect(text).toContain("Analyze Glean for investment.");
  expect(text).toContain("Delegation running");
  expect(text).toContain("Research Bot");
  expect(text).toContain("Working");
  expect(text).toContain("Finance Bot");
  expect(text).toContain("Queued");
  expect(text).not.toContain("View report");

  const research = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Research Bot"),
  );
  act(() => research?.click());
  expect(onOpenBot).toHaveBeenCalledWith("research");
});

it("shows a timed-out child and a partial report", () => {
  render(
    view({
      status: "completed",
      outcome: "partial",
      reportMessageId: "message-timeout",
      children: [
        {
          id: "child-research",
          role: "research",
          botId: "research",
          botName: "Research Bot",
          status: "completed",
          error: null,
          runId: "run-research",
          threadId: "thread-research",
          completedAt: "2026-11-10T12:04:00.000Z",
        },
        {
          id: "child-finance",
          role: "finance",
          botId: "finance",
          botName: "Finance Bot",
          status: "timed_out",
          error: "Deadline passed.",
          runId: "run-finance",
          threadId: "thread-finance",
          completedAt: "2026-11-10T12:15:00.000Z",
        },
      ],
    }),
  );
  expect(container.textContent).toContain("Timed out");
  expect(container.textContent).toContain("Report ready · partial");
});

it("shows a completed partial report and jumps to it", () => {
  const onOpenReport = vi.fn();
  render(
    view({
      status: "completed",
      outcome: "partial",
      completedAt: "2026-11-10T12:05:00.000Z",
      reportMessageId: "message-report",
      children: [
        {
          id: "child-research",
          role: "research",
          botId: "research",
          botName: "Research Bot",
          status: "completed",
          error: null,
          runId: "run-research",
          threadId: "thread-research",
          completedAt: "2026-11-10T12:04:00.000Z",
        },
        {
          id: "child-finance",
          role: "finance",
          botId: "finance",
          botName: "Finance Bot",
          status: "failed",
          error: "The model provider refused the request.",
          runId: "run-finance",
          threadId: "thread-finance",
          completedAt: "2026-11-10T12:04:30.000Z",
        },
      ],
    }),
    vi.fn(),
    onOpenReport,
  );
  const text = container.textContent ?? "";
  expect(text).toContain("Report ready · partial");
  expect(text).toContain("Failed");
  const report = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("View report"),
  );
  act(() => report?.click());
  expect(onOpenReport).toHaveBeenCalledWith("message-report");
});
