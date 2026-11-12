// @vitest-environment jsdom

import type { RefObject } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
}));

import { MessageOutline, outlineHeadings, TextWithOutline } from "./message-outline";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("extracts readable h1–h3 labels and ignores deeper headings", () => {
  expect(
    outlineHeadings(
      "# Title\n\n## **Market**\n\n### [Customers](https://glean.com)\n\n#### Too deep",
    ),
  ).toEqual([
    { level: 1, text: "Title" },
    { level: 2, text: "Market" },
    { level: 3, text: "Customers" },
  ]);
});

it("shows a contents list only for long structured answers and jumps to a heading", () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  const text = `## One\n${"x".repeat(800)}\n### Two\n${"y".repeat(800)}\n## Three`;
  act(() => {
    root.render(
      <TextWithOutline text={text}>
        <h2>One</h2>
        <h3>Two</h3>
        <h2>Three</h2>
      </TextWithOutline>,
    );
  });
  expect(container.querySelector('[data-testid="message-outline"]')).not.toBeNull();
  const two = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Two",
  );
  act(() => two?.click());
  expect(scrollIntoView).toHaveBeenCalled();
});

it("renders nothing for a short answer or one with too few headings", () => {
  act(() => {
    root.render(
      <MessageOutline
        text={"## One\\nshort"}
        containerRef={{ current: null } as RefObject<HTMLElement | null>}
      />,
    );
  });
  expect(container.querySelector('[data-testid="message-outline"]')).toBeNull();
});
