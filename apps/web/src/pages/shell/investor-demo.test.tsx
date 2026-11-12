// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  BotAvatar: () => <span data-testid="bot-avatar" />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import {
  findInvestorDemoTeam,
  INVESTOR_DEMO_TASK,
  InvestorDemoDialog,
  InvestorDemoWelcome,
} from "./investor-demo";

let container: HTMLDivElement;
let root: Root;

const bot = (id: string, name: string, spawnKey: string) =>
  ({
    id,
    name,
    spawnKey,
    color: "#1CC3B0",
    avatarSet: {} as Bot["avatarSet"],
    status: "offline",
  }) as Bot;
const team = {
  ceo: bot("ceo", "CEO Assistant", "rabbitbots:ceo"),
  research: bot("research", "Research Bot", "rabbitbots:research"),
  finance: bot("finance", "Finance Bot", "rabbitbots:finance"),
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("finds the seeded demo trio and ignores an incomplete roster", () => {
  expect(findInvestorDemoTeam([team.research, team.ceo, team.finance])).toEqual(team);
  expect(findInvestorDemoTeam([team.ceo, team.research])).toBeNull();
});

it("states the preset task without embedding a report", () => {
  expect(INVESTOR_DEMO_TASK).toContain("Glean");
  expect(INVESTOR_DEMO_TASK).toContain("Research Bot");
  expect(INVESTOR_DEMO_TASK).toContain("Finance Bot");
  expect(INVESTOR_DEMO_TASK).not.toContain("Report ready");
});

it("shows the three responsibilities and opens confirmation", () => {
  const onStart = vi.fn();
  act(() => {
    root.render(<InvestorDemoWelcome team={team} busy={false} onStart={onStart} />);
  });
  const text = container.textContent ?? "";
  expect(text).toContain("Investor demo");
  expect(text).toContain("CEO Assistant");
  expect(text).toContain("Research Bot");
  expect(text).toContain("Finance Bot");
  expect(text).toContain("live run");
  act(() => {
    (container.querySelector('[data-testid="investor-demo-open"]') as HTMLButtonElement).click();
  });
  expect(onStart).toHaveBeenCalledTimes(1);
});

it("sends the preset only after the dialog is confirmed", async () => {
  const onStart = vi.fn(async () => true);
  const onClose = vi.fn();
  act(() => {
    root.render(
      <InvestorDemoDialog team={team} busy={false} onClose={onClose} onStart={onStart} />,
    );
  });
  expect(container.textContent).toContain(INVESTOR_DEMO_TASK);
  await act(async () => {
    (container.querySelector('[data-testid="investor-demo-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("reports a failed start", async () => {
  const onStart = vi.fn(async () => false);
  act(() => {
    root.render(
      <InvestorDemoDialog team={team} busy={false} onClose={vi.fn()} onStart={onStart} />,
    );
  });
  await act(async () => {
    (container.querySelector('[data-testid="investor-demo-start"]') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not start");
});
