import { describe, expect, it } from "vitest";
import {
  canAddDiscussionRound,
  parseAgendaDecision,
  parseAgendaReview,
  parseDiscussionEvaluation,
} from "./meetings.js";

describe("M1.4 chair orchestration", () => {
  it("captures a chair stage summary with consensus, disagreement and evidence gaps", () => {
    const review = parseAgendaReview(
      JSON.stringify({
        materialDisagreement: true,
        state: "DISAGREEMENT",
        reason: "The lanes disagree about whether the window is urgent.",
        consensus: ["The category is large."],
        disagreements: ["The duration of the window is unmeasured."],
        evidenceGaps: ["A dated procurement-cycle source."],
        question: "Which evidence establishes the timing?",
        participants: ["Research", "Finance"],
      }),
    );
    expect(review).toMatchObject({
      state: "DISAGREEMENT",
      consensus: ["The category is large."],
      disagreements: ["The duration of the window is unmeasured."],
      evidenceGaps: ["A dated procurement-cycle source."],
    });
  });

  it("allows a second round only with named new evidence and relevant participants", () => {
    const evaluation = parseDiscussionEvaluation(
      JSON.stringify({
        needsAnotherRound: true,
        reason: "The financial gate was not answered.",
        newEvidence: ["Finance supplied a cost classification."],
        question: "Which gate governs?",
        participants: ["Finance"],
      }),
    );
    expect(evaluation).toMatchObject({
      needsAnotherRound: true,
      participants: ["Finance"],
      newEvidence: ["Finance supplied a cost classification."],
    });
    expect(
      parseDiscussionEvaluation(
        JSON.stringify({
          needsAnotherRound: true,
          reason: "repeat",
          newEvidence: [],
          question: "Again?",
        }),
      ),
    ).toBeNull();
  });

  it("keeps a decision's discussion state, supporting opinions and evidence gaps", () => {
    const decision = parseAgendaDecision(
      JSON.stringify({
        decisionType: "DEFERRED",
        decisionText: "Defer until the financial evidence exists.",
        rationale: "The record cannot establish feasibility.",
        supportingEvidence: ["Cash statement absent."],
        supportingOpinions: ["Finance would defer."],
        risks: ["Runway is unknown."],
        dissentingOpinions: ["Research would proceed on direction."],
        evidenceGaps: ["Audited ARR", "Burn and runway"],
        conditions: [],
        discussionState: "INSUFFICIENT_EVIDENCE",
      }),
    );
    expect(decision).toMatchObject({
      decisionType: "DEFERRED",
      discussionState: "INSUFFICIENT_EVIDENCE",
      supportingOpinions: ["Finance would defer."],
      evidenceGaps: ["Audited ARR", "Burn and runway"],
    });
  });

  it("enforces the two-round ceiling", () => {
    expect(canAddDiscussionRound(1, 2)).toBe(true);
    expect(canAddDiscussionRound(2, 2)).toBe(false);
    expect(canAddDiscussionRound(1, 99)).toBe(true);
    expect(canAddDiscussionRound(2, 99)).toBe(false);
  });
});
