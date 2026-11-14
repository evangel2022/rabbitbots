// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityModeBanner } from "./shell-sidebar";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + (index > 0 ? values[index - 1] : "") + part, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("shows the Activity title and returns to chats", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onBack = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<ActivityModeBanner onBack={onBack} />));
  expect(host.querySelector('[data-testid="activity-mode-banner"]')).not.toBeNull();
  expect(host.textContent).toContain("Activity");
  const back = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Back to chats",
  );
  expect(back).toBeTruthy();
  await act(async () => back!.click());
  expect(onBack).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
