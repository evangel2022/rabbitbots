// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => ({
  workforce: { company: { status: vi.fn() } },
}));
vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { OnboardingPage } from "./Onboarding";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/onboarding/company" element={<div data-testid="wizard" />} />
          <Route path="/app" element={<div data-testid="app" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

it("sends a user without an AI company to the creation wizard", async () => {
  rpcMock.workforce.company.status.mockResolvedValue({
    created: false,
    bots: [],
    meetingId: null,
    meetingTitle: "",
  });
  const { host } = await render();
  expect(host.querySelector('[data-testid="wizard"]')).not.toBeNull();
});

it("does not force an existing AI company back into onboarding", async () => {
  rpcMock.workforce.company.status.mockResolvedValue({
    created: true,
    bots: [],
    meetingId: "meeting-1",
    meetingTitle: "First AI Company Strategy Meeting",
  });
  const { host } = await render();
  expect(host.querySelector('[data-testid="app"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="wizard"]')).toBeNull();
});
