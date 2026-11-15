// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assessDeliveryQuality } from "../lib/delivery-quality";
import { DeliveryQualityNotice } from "./DeliveryQualityNotice";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(quality: ReturnType<typeof assessDeliveryQuality>) {
  await act(async () => root.render(<DeliveryQualityNotice quality={quality} />));
  return document.body.textContent ?? "";
}

it("shows invalid evidence and structural warnings without claiming verification", async () => {
  const text = await render(
    assessDeliveryQuality({
      criteria: "Provide three findings and one verification note.",
      resultSummary: "The comparison was completed.",
      evidence: ["https://example.com/obsidian-review", "https://example.com/logseq-review"],
    }),
  );
  expect(text).toContain("STRUCTURALLY INCOMPLETE");
  expect(text).toContain("INVALID");
  expect(text).toContain("example.com/obsidian-review");
  expect(text).toContain("Expected 3 findings, found 0.");
  expect(text).not.toContain("VERIFIED-CORRECT");
});

it("marks a normal URL as unverified, not invalid", async () => {
  const text = await render(
    assessDeliveryQuality({
      criteria: "Provide evidence.",
      resultSummary: "Result.",
      evidence: ["https://www.wikipedia.org/wiki/Obsidian"],
    }),
  );
  expect(text).toContain("UNVERIFIED");
  expect(text).not.toContain("INVALID");
});

it("shows no evidence clearly", async () => {
  const text = await render(
    assessDeliveryQuality({
      criteria: "Provide evidence.",
      resultSummary: "Result.",
      evidence: [],
    }),
  );
  expect(text).toContain("No evidence recorded");
});
