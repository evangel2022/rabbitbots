import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { MeetingStructuredTurn, parseMeetingStructuredContent } from "./MeetingStructuredContent";

const review = {
  materialDisagreement: false,
  reason: "The reports agree on the customer segment.",
  state: "AGREEMENT",
  consensus: ["SMB teams are the initial segment.", "Activation is the primary metric."],
  disagreements: [],
  evidenceGaps: ["Audited market size for the chosen segment."],
  question: "",
  participants: [],
};

const currentFixture = `Let us begin with Agenda item 1 — Product Positioning. Who speaks first?

${JSON.stringify(review)}`;

function render(content: string, phase = "AGENDA_REVIEW") {
  return renderToStaticMarkup(<MeetingStructuredTurn content={content} phase={phase} />);
}

describe("meeting structured content", () => {
  it("renders the current review fixture without exposing raw JSON", () => {
    const html = render(currentFixture);
    expect(html).not.toContain("materialDisagreement");
    expect(html).not.toContain('"consensus"');
    expect(html).not.toContain('"evidenceGaps"');
    expect(html).toContain("Let us begin with Agenda item 1");
    expect(html).toContain("Meeting decision");
    expect(html).toContain("AGREEMENT");
    expect(html).toContain("The reports agree on the customer segment.");
    expect(html).toContain("SMB teams are the initial segment.");
    expect(html).toContain("Activation is the primary metric.");
    expect(html).toContain("Audited market size for the chosen segment.");
  });

  it("renders material disagreement, next question and participants when present", () => {
    const html = render(
      JSON.stringify({
        materialDisagreement: true,
        state: "DISAGREEMENT",
        reason: "The reports use different assumptions.",
        consensus: [],
        disagreements: ["The finance case uses a different base year."],
        evidenceGaps: ["A current audited ARR figure."],
        question: "Which base year should the board use?",
        participants: ["Research", "Finance"],
      }),
    );
    expect(html).toContain("Material disagreement:");
    expect(html).toContain("Yes");
    expect(html).toContain("The finance case uses a different base year.");
    expect(html).toContain("Which base year should the board use?");
    expect(html).toContain("Research");
    expect(html).toContain("Finance");
  });

  it("does not render empty optional sections", () => {
    const html = render(currentFixture);
    expect(html).not.toContain("Disagreements");
    expect(html).not.toContain("Next question");
    expect(html).not.toContain("Participants");
  });

  it("keeps ordinary chat text normal", () => {
    expect(render("Hello, how can I help?", "AGENDA_RESPONSE")).toContain("Hello, how can I help?");
  });

  it("does not treat user-style arbitrary JSON as a meeting decision", () => {
    const parsed = parseMeetingStructuredContent('{"hello":"world"}');
    expect(parsed.review).toBeNull();
    expect(parsed.jsonLike).toBe(true);
    const html = render('{"hello":"world"}', "AGENDA_RESPONSE");
    expect(html).toContain("hello");
    expect(html).toContain("world");
    expect(html).not.toContain("meeting-turn-structured");
  });

  it.each([
    ["AGREEMENT", "AGREEMENT"],
    ["DISAGREEMENT", "DISAGREEMENT"],
    ["NEEDS_DISCUSSION", "NEEDS DISCUSSION"],
  ])("renders %s without hiding meaningful fields", (state, label) => {
    const html = render(
      JSON.stringify({
        ...review,
        state,
        materialDisagreement: state === "DISAGREEMENT",
        disagreements:
          state === "DISAGREEMENT" ? ["The finance report uses a different base case."] : [],
      }),
    );
    expect(html).toContain(label);
    expect(html).toContain("Material disagreement");
  });

  it("handles missing optional fields without inventing empty sections", () => {
    const html = render(
      JSON.stringify({
        state: "INSUFFICIENT_EVIDENCE",
        reason: "No dated source is available.",
      }),
    );
    expect(html).toContain("INSUFFICIENT EVIDENCE");
    expect(html).toContain("No dated source is available.");
    expect(html).not.toContain("Consensus");
    expect(html).not.toContain("Evidence gaps");
  });

  it("does not expose malformed or unknown internal JSON", () => {
    const malformed = render('{"state":"AGREEMENT", "consensus": ["unfinished"]', "AGENDA_REVIEW");
    expect(malformed).toContain("cannot be displayed here");
    expect(malformed).not.toContain('"state"');
    expect(malformed).not.toContain('"consensus"');

    const unknown = render('{"state":"AGREEMENT","foo":"bar"}', "AGENDA_REVIEW");
    expect(unknown).toContain("cannot be displayed here");
    expect(unknown).not.toContain('"foo"');
    expect(unknown).not.toContain('"state"');
  });

  it("keeps a historical persisted review readable on the same path", () => {
    const historic = `The chair’s note:\n\n\`\`\`json\n${JSON.stringify({
      ...review,
      state: "DISAGREEMENT",
      materialDisagreement: true,
      disagreements: ["One source conflicts with the primary report."],
    })}\n\`\`\``;
    const html = render(historic);
    expect(html).toContain("The chair");
    expect(html).toContain("One source conflicts with the primary report.");
    expect(html).not.toContain("```json");
    expect(html).not.toContain('"materialDisagreement"');
  });
});
