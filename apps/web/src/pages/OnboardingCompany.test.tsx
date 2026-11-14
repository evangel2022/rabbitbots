// @vitest-environment jsdom

import type { WorkforceCompanyStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("./onboarding/use-onboarding-model", () => ({
  useOnboardingModel: () => ({}),
}));
vi.mock("./onboarding/model-step", () => ({
  ModelStep: () => <div data-testid="model-step">Model step</div>,
}));

const rpcMock = vi.hoisted(() => ({
  me: vi.fn(),
  models: { list: vi.fn() },
  workforce: {
    company: { status: vi.fn(), create: vi.fn() },
    tasks: { create: vi.fn(), execute: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));

import { OnboardingCompanyPage } from "./OnboardingCompany";

const bots: WorkforceCompanyStatus["bots"] = [
  {
    roleKey: "ceo",
    role: "CEO / Chair",
    id: "bot-ceo",
    name: "CEO / Chair",
    description: "Chairs.",
  },
  {
    roleKey: "research",
    role: "Research",
    id: "bot-research",
    name: "Research",
    description: "Researches.",
  },
  {
    roleKey: "finance",
    role: "Finance",
    id: "bot-finance",
    name: "Finance",
    description: "Finances.",
  },
  {
    roleKey: "operations",
    role: "Operations",
    id: "bot-operations",
    name: "Operations",
    description: "Operates.",
  },
];

const emptyCompany: WorkforceCompanyStatus = {
  created: false,
  name: null,
  description: null,
  bots: [],
  meetingId: null,
  meetingTitle: "First AI Company Strategy Meeting",
};

const createdCompany: WorkforceCompanyStatus = {
  created: true,
  name: "Acme AI",
  description: "A focused AI company.",
  bots,
  meetingId: "meeting-1",
  meetingTitle: "First AI Company Strategy Meeting",
};

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(host: HTMLElement, text: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

async function render(path = "/onboarding/company") {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/onboarding/company" element={<OnboardingCompanyPage />} />
          <Route path="/app" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
  return { host, root };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  rpcMock.me.mockResolvedValue({ needsModel: true, billingEnabled: false });
  rpcMock.models.list.mockResolvedValue([]);
  rpcMock.workforce.company.status.mockResolvedValue(emptyCompany);
  rpcMock.workforce.company.create.mockResolvedValue(createdCompany);
  rpcMock.workforce.tasks.create.mockResolvedValue({
    id: "task-1",
    title: "Research a market opportunity",
    executionStatus: "OPEN",
    assigneeBotId: "bot-ceo",
  });
  rpcMock.workforce.tasks.execute.mockResolvedValue({
    id: "task-1",
    title: "Research a market opportunity",
    executionStatus: "IN_PROGRESS",
    assigneeBotId: "bot-ceo",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("creates the company only after the explicit create action", async () => {
  const { host } = await render();
  expect(host.textContent).toContain("Welcome to RabbitBots");
  expect(rpcMock.workforce.company.create).not.toHaveBeenCalled();

  await act(async () => button(host, "Create Your AI Company").click());
  await act(async () => button(host, "Continue").click());
  await flush();
  expect(host.textContent).toContain("Build your AI team");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Name for ceo"]')?.value).toBe(
    "CEO / Chair",
  );

  await act(async () => button(host, "Continue").click());
  await flush();
  expect(host.querySelector('[data-testid="model-step"]')).not.toBeNull();
  expect(rpcMock.workforce.company.create).not.toHaveBeenCalled();

  await act(async () => button(host, "Skip for now").click());
  await flush();
  expect(host.textContent).toContain("Your AI company is ready to create");
  expect(rpcMock.workforce.company.create).not.toHaveBeenCalled();

  await act(async () => button(host, "Create Your AI Company").click());
  await flush();
  expect(rpcMock.workforce.company.create).toHaveBeenCalledTimes(1);
  expect(rpcMock.workforce.company.create).toHaveBeenCalledWith(
    expect.objectContaining({ name: "My AI Company" }),
  );
  expect(host.textContent).toContain("Acme AI");
  expect(host.textContent).toContain("Company ready");
  expect(host.textContent).toContain("Model not connected");
});

it("does not create twice when the create button is clicked twice", async () => {
  let resolveCreate: (value: WorkforceCompanyStatus) => void = () => {};
  rpcMock.workforce.company.create.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveCreate = resolve;
    }),
  );
  const { host } = await render("/onboarding/company?step=ready");
  const createButton = button(host, "Create Your AI Company");
  await act(async () => createButton.click());
  await act(async () => createButton.click());
  expect(rpcMock.workforce.company.create).toHaveBeenCalledTimes(1);
  await act(async () => resolveCreate(createdCompany));
  await flush();
  expect(host.textContent).toContain("Company ready");
});

it("keeps an unsent profile draft across a remount", async () => {
  const first = await render("/onboarding/company?step=profile");
  await act(async () => setValue(first.host.querySelector("#company-name")!, "Draft Co"));
  await act(async () => button(first.host, "Continue").click());
  await flush();
  first.root.unmount();
  first.host.remove();

  const second = await render("/onboarding/company?step=profile");
  expect(second.host.querySelector<HTMLInputElement>("#company-name")?.value).toBe("Draft Co");
});

it("sends an existing company to the app instead of the wizard", async () => {
  rpcMock.workforce.company.status.mockResolvedValue(createdCompany);
  const { host } = await render();
  expect(host.querySelector('[data-testid="dashboard"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Welcome to RabbitBots");
});

it("guides a user without a model when starting a task", async () => {
  rpcMock.workforce.company.status.mockResolvedValue(createdCompany);
  const { host } = await render("/onboarding/company?step=ready");
  expect(host.textContent).toContain("Acme AI");
  await act(async () => button(host, "Start Your First Task").click());
  await act(async () =>
    setValue(host.querySelector<HTMLTextAreaElement>("#first-task")!, "Research the market"),
  );
  await act(async () => button(host, "Send to your AI company").click());
  await flush();
  expect(host.textContent).toContain("Connect a model before starting a task");
  expect(rpcMock.workforce.tasks.create).not.toHaveBeenCalled();
});

it("requires a company name before moving on", async () => {
  const { host } = await render("/onboarding/company?step=profile");
  await act(async () => {
    setValue(host.querySelector<HTMLInputElement>("#company-name")!, "   ");
    button(host, "Continue").click();
  });
  await flush();
  expect(host.textContent).toContain("Give your company a name first");
  expect(host.textContent).toContain("Name your AI company");
});

it("shows a create failure and can retry safely", async () => {
  rpcMock.workforce.company.create
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValueOnce(createdCompany);
  const { host } = await render("/onboarding/company?step=ready");
  const createButton = button(host, "Create Your AI Company");
  await act(async () => createButton.click());
  await flush();
  expect(host.textContent).toContain("network down");
  expect(rpcMock.workforce.company.create).toHaveBeenCalledTimes(1);
  await act(async () => button(host, "Create Your AI Company").click());
  await flush();
  expect(rpcMock.workforce.company.create).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Company ready");
});

it("creates and starts a real first task when a model is connected", async () => {
  rpcMock.me.mockResolvedValue({ needsModel: false, billingEnabled: false });
  rpcMock.workforce.company.status.mockResolvedValue(createdCompany);
  const { host } = await render("/onboarding/company?step=ready");
  await act(async () => button(host, "Start Your First Task").click());
  await act(async () =>
    setValue(host.querySelector<HTMLTextAreaElement>("#first-task")!, "Plan a launch"),
  );
  await act(async () => button(host, "Send to your AI company").click());
  await flush();
  expect(rpcMock.workforce.tasks.create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Plan a launch", assigneeBotId: "bot-ceo" }),
  );
  expect(rpcMock.workforce.tasks.execute).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Task created");
  expect(host.textContent).toContain("IN PROGRESS");
});
