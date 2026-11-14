// @vitest-environment jsdom

import type { WorkforceCompanyStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateAiCompany } from "./CreateAiCompany";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const status: WorkforceCompanyStatus = {
  created: true,
  meetingId: "meeting-1",
  meetingTitle: "First AI Company Strategy Meeting",
  bots: [
    {
      roleKey: "ceo",
      role: "CEO Assistant",
      id: "bot-1",
      name: "CEO Assistant",
      description: "Chairs.",
    },
    {
      roleKey: "research",
      role: "Research",
      id: "bot-2",
      name: "Research Bot",
      description: "Researches.",
    },
    {
      roleKey: "finance",
      role: "Finance",
      id: "bot-3",
      name: "Finance Bot",
      description: "Finances.",
    },
    {
      roleKey: "operations",
      role: "Operations",
      id: "bot-4",
      name: "Operations Bot",
      description: "Operates.",
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(ui: ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter>{ui}</MemoryRouter>);
  });
}

function byTestId(id: string) {
  const found = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`No test id ${id}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("CreateAiCompany", () => {
  it("shows the four roles and does not create until the user confirms", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(
      <CreateAiCompany status={undefined} busy={false} error={null} onCreate={onCreate} />,
    );
    expect(byTestId("create-ai-company")).toBeTruthy();
    expect(document.body.textContent).toContain("CEO Assistant");
    expect(document.body.textContent).toContain("Research Bot");
    expect(document.body.textContent).toContain("Finance Bot");
    expect(document.body.textContent).toContain("Operations Bot");
    expect(onCreate).not.toHaveBeenCalled();

    await click(byTestId("create-ai-company-open"));
    expect(document.body.textContent).toContain("Create your AI Company");
    expect(onCreate).not.toHaveBeenCalled();

    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    if (!cancel) throw new Error("No Cancel button");
    await click(cancel);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("creates once and prevents a duplicate request", async () => {
    let resolve!: () => void;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await render(
      <CreateAiCompany status={undefined} busy={false} error={null} onCreate={onCreate} />,
    );
    await click(byTestId("create-ai-company-open"));
    const confirm = byTestId("create-ai-company-confirm");
    await click(confirm);
    await click(confirm);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(confirm.textContent).toContain("Creating…");
    await act(async () => resolve());
  });

  it("shows the created company and a boardroom entry without another create action", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(<CreateAiCompany status={status} busy={false} error={null} onCreate={onCreate} />);
    expect(byTestId("ai-company-ready")).toBeTruthy();
    expect(byTestId("open-boardroom").getAttribute("href")).toBe("/app/meetings?meeting=meeting-1");
    expect(document.querySelector('[data-testid="create-ai-company"]')).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("shows an error and retries", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(
      <CreateAiCompany
        status={undefined}
        busy={false}
        error="Could not create your AI Company"
        onCreate={onCreate}
      />,
    );
    expect(document.body.textContent).toContain("Could not create your AI Company");
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    if (!retry) throw new Error("No Retry button");
    await click(retry);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("renders as the secondary custom-company entry", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(
      <CreateAiCompany
        status={undefined}
        busy={false}
        error={null}
        onCreate={onCreate}
        secondary
      />,
    );
    expect(byTestId("create-ai-company-secondary")).toBeTruthy();
    expect(document.body.textContent).toContain("Create a Custom AI Company");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("disables creation while the parent reports a create in progress", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(<CreateAiCompany status={undefined} busy error={null} onCreate={onCreate} />);
    const open = byTestId("create-ai-company-open") as HTMLButtonElement;
    expect(open.disabled).toBe(true);
  });
});
