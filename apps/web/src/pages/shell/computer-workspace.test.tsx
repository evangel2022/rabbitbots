// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));
vi.mock("../../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));

import { ComputerWorkspace } from "./computer-workspace";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "dedicated",
    kind: "docker",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: state === "running",
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(status: ComputerStatus, handlers: Partial<Record<string, () => void>> = {}) {
  const onOpen = vi.fn();
  const onStart = vi.fn();
  const onCollapse = vi.fn();
  const onTakeControl = vi.fn();
  await act(async () => {
    root.render(
      <ComputerWorkspace
        bot={bot}
        computer={status}
        computerOpen={false}
        embeddedScreenUrl={status.state === "running" ? "https://screen.example.test/" : null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        booting={false}
        showingRecoveryHint={false}
        showComputerRecoveryHint={false}
        onRecovered={() => undefined}
        onRecoveryDismissed={() => undefined}
        onOpen={onOpen}
        hasControl={false}
        onCollapse={onCollapse}
        onStart={onStart}
        onTakeControl={onTakeControl}
        {...handlers}
      />,
    );
  });
  return { onOpen, onStart, onCollapse, onTakeControl };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows a stopped computer's real state and starts it in place", async () => {
  const { onStart, onOpen } = await render(computer("stopped"));
  expect(container.querySelector('[data-testid="computer-workspace"]')).not.toBeNull();
  expect(container.textContent).toContain("Ada’s computer");
  expect(container.textContent).toContain("Stopped");
  const start = container.querySelector<HTMLButtonElement>(
    '[data-testid="computer-preview-open"]',
  )!;
  expect(start.textContent).toContain("Start");
  await act(async () => start.click());
  expect(onStart).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();
});

it("shows the live screen and offers control once the computer runs", async () => {
  const { onTakeControl } = await render(computer("running"));
  expect(container.querySelector('[data-testid="computer-workspace"] iframe')).not.toBeNull();
  expect(container.textContent).toContain("Live");
  const control = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Take control",
  )!;
  await act(async () => control.click());
  expect(onTakeControl).toHaveBeenCalledOnce();
});

it("can hide the rail and open the full-screen view", async () => {
  const { onCollapse, onOpen } = await render(computer("stopped"));
  const hide = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Hide computer",
  )!;
  await act(async () => hide.click());
  expect(onCollapse).toHaveBeenCalledOnce();
  const expand = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Open in full window",
  )!;
  await act(async () => expand.click());
  expect(onOpen).toHaveBeenCalledOnce();
});
