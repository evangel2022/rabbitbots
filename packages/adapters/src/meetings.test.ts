import { describe, expect, it } from "vitest";
import {
  canAddDiscussionRound,
  canTransitionMeeting,
  detectMaterialDisagreement,
  extractEvidence,
  hasSupportedObjection,
  meetingTextFits,
  parseAgendaDecision,
  parseAgendaReview,
  parseChairOutput,
  parseDiscussionEvaluation,
  parseDiscussionQuestion,
  parseMeetingSummary,
  selectDiscussionParticipants,
  tokenLimitForPhase,
} from "./meetings.js";

describe("meeting lifecycle", () => {
  it("allows the controlled path and rejects invalid jumps", () => {
    expect(canTransitionMeeting("DRAFT", "PREPARING")).toBe(true);
    expect(canTransitionMeeting("PREPARING", "OPENING")).toBe(true);
    expect(canTransitionMeeting("OPENING", "REPORTING")).toBe(true);
    expect(canTransitionMeeting("REPORTING", "DISCUSSION")).toBe(true);
    expect(canTransitionMeeting("REPORTING", "DECISION")).toBe(true);
    expect(canTransitionMeeting("DISCUSSION", "DECISION")).toBe(true);
    expect(canTransitionMeeting("DECISION", "CLOSING")).toBe(true);
    expect(canTransitionMeeting("CLOSING", "COMPLETED")).toBe(true);

    expect(canTransitionMeeting("DRAFT", "COMPLETED")).toBe(false);
    expect(canTransitionMeeting("PREPARING", "DECISION")).toBe(false);
    expect(canTransitionMeeting("COMPLETED", "OPENING")).toBe(false);
    expect(canTransitionMeeting("FAILED", "OPENING")).toBe(false);
    expect(canTransitionMeeting("CANCELLED", "COMPLETED")).toBe(false);
  });

  it("bounds discussion to two rounds and one turn per round", () => {
    expect(canAddDiscussionRound(1, 2)).toBe(true);
    expect(canAddDiscussionRound(2, 2)).toBe(false);
    expect(canAddDiscussionRound(1, 99)).toBe(true);
    expect(canAddDiscussionRound(2, 99)).toBe(false);
  });
});

describe("anti-debate materiality", () => {
  it("requires evidence, risk, a contradiction or an alternative", () => {
    expect(hasSupportedObjection("")).toBe(false);
    expect(hasSupportedObjection("I disagree but have nothing else to add.")).toBe(false);
    expect(
      hasSupportedObjection(
        "New evidence: https://example.com/source shows 42% growth, so the claim is contradicted.",
      ),
    ).toBe(true);
    expect(hasSupportedObjection("The report offers no new evidence or risk.")).toBe(false);
    expect(
      hasSupportedObjection("Risk: ARR composition is unknown and the denominator is unverified."),
    ).toBe(true);
  });

  it("skips discussion with one report or an explicit no-disagreement statement", () => {
    expect(detectMaterialDisagreement(["only one report"])).toBe(false);
    expect(
      detectMaterialDisagreement([
        "There is a risk and evidence at https://example.com.",
        "NO_MATERIAL_DISAGREEMENT",
      ]),
    ).toBe(false);
    expect(
      detectMaterialDisagreement([
        "Risk: the market estimate is uncertain; evidence https://example.com/a.",
        "However, the financial claim is contradicted by the retained data.",
      ]),
    ).toBe(true);
  });
});

const validOutput = {
  summary: "Proceed to diligence with conditions.",
  minutes: "The board agreed to continue diligence; no human approval was given.",
  decisions: [
    {
      agendaSequence: 1,
      decisionType: "APPROVED_WITH_CONDITIONS",
      decisionText: "Continue to Stage 2 diligence.",
      rationale: "Evidence supports a staged review.",
      supportingEvidence: ["https://example.com/source"],
      risks: ["ARR composition is unknown."],
      dissentingOpinions: ["Finance would defer."],
      conditions: ["Obtain audited ARR."],
    },
    {
      agendaSequence: 2,
      decisionType: "DEFERRED",
      decisionText: "Defer the valuation decision.",
      rationale: "The denominator is unverified.",
    },
    {
      agendaSequence: 3,
      decisionType: "REJECTED",
      decisionText: "Do not make a financial commitment now.",
      rationale: "Human approval is required.",
    },
    {
      agendaSequence: 4,
      decisionType: "APPROVED",
      decisionText: "Continue the risk review.",
      rationale: "The risk register is a useful basis.",
    },
  ],
  actionItems: [
    {
      title: "Collect audited ARR",
      description: "Request the data-room figure.",
      assigneeRole: "Finance",
      dueAt: null,
    },
  ],
};

describe("participant discussion", () => {
  it("parses a structured question and falls back to prose without inventing participants", () => {
    expect(
      parseDiscussionQuestion(
        JSON.stringify({
          agendaSequence: 1,
          question: "What new ARR evidence changes the margin conclusion?",
          participants: ["Research", "Finance"],
        }),
      ),
    ).toMatchObject({
      question: "What new ARR evidence changes the margin conclusion?",
      participants: ["Research", "Finance"],
      agendaSequence: 1,
    });
    expect(parseDiscussionQuestion("Which evidence resolves the disagreement?")).toEqual({
      question: "Which evidence resolves the disagreement?",
      participants: [],
    });
    expect(
      parseDiscussionQuestion(
        '{"agendaSequence":1,"question":"Which ARR date?","participants":["Finance","Research"]]}',
      ),
    ).toMatchObject({
      question: "Which ARR date?",
      participants: ["Finance", "Research"],
    });
    expect(parseDiscussionQuestion("   ")).toBeNull();
  });

  it("selects requested roles, excludes the chair and falls back to eligible participants", () => {
    const participants = [
      { botId: "chair", role: "Chairperson", bot: { name: "CEO Assistant" } },
      { botId: "research", role: "Research", bot: { name: "Research Bot" } },
      { botId: "finance", role: "Finance", bot: { name: "Finance Bot" } },
    ];
    expect(
      selectDiscussionParticipants(participants, ["Finance"], new Set(["research", "finance"])),
    ).toEqual(["finance"]);
    expect(
      selectDiscussionParticipants(participants, ["Unknown"], new Set(["research", "finance"])),
    ).toEqual(["research", "finance"]);
    expect(selectDiscussionParticipants(participants, [], new Set(["research"]))).toEqual([
      "research",
    ]);
  });

  it("permits another round only with named new evidence and a question", () => {
    expect(
      parseDiscussionEvaluation(
        JSON.stringify({
          needsAnotherRound: true,
          reason: "ARR denominator changed",
          newEvidence: ["audited ARR certificate"],
          question: "Which audited ARR figure should the panel use?",
        }),
      ),
    ).toMatchObject({ needsAnotherRound: true, newEvidence: ["audited ARR certificate"] });
    expect(
      parseDiscussionEvaluation(
        JSON.stringify({ needsAnotherRound: true, newEvidence: [], question: "again?" }),
      ),
    ).toBeNull();
    expect(
      parseDiscussionEvaluation('{"needsAnotherRound":false,"reason":"no new evidence"}'),
    ).toEqual({
      needsAnotherRound: false,
      reason: "no new evidence",
      question: "",
      newEvidence: [],
      participants: [],
    });
  });

  it("uses 500 tokens for normal turns and a larger structured decision budget", () => {
    expect(tokenLimitForPhase("REPORTING")).toBe(1_200);
    expect(tokenLimitForPhase("DISCUSSION_RESPONSE")).toBe(800);
    expect(tokenLimitForPhase("DECISION")).toBe(2_400);
    expect(meetingTextFits("short", "REPORTING")).toBe(true);
    expect(meetingTextFits("x".repeat(12_001), "REPORTING")).toBe(false);
    expect(meetingTextFits("x".repeat(32_001), "DECISION")).toBe(false);
  });
});

describe("per-agenda structured output", () => {
  it("requires a question only when the agenda review finds material disagreement", () => {
    expect(
      parseAgendaReview(
        JSON.stringify({
          materialDisagreement: false,
          reason: "No material disagreement.",
          question: "",
          participants: [],
        }),
      ),
    ).toMatchObject({ materialDisagreement: false });
    expect(
      parseAgendaReview(
        JSON.stringify({
          materialDisagreement: true,
          state: "DISAGREEMENT",
          reason: "Conflicting ARR evidence.",
          consensus: ["The category is large."],
          disagreements: ["ARR is unaudited."],
          evidenceGaps: ["Audited ARR."],
          question: "Which ARR date is verified?",
          participants: ["Research", "Finance"],
        }),
      ),
    ).toMatchObject({
      question: "Which ARR date is verified?",
      state: "DISAGREEMENT",
      consensus: ["The category is large."],
      disagreements: ["ARR is unaudited."],
      evidenceGaps: ["Audited ARR."],
    });
    expect(
      parseAgendaReview(
        JSON.stringify({ materialDisagreement: true, reason: "conflict", question: "" }),
      ),
    ).toBeNull();
  });

  it("parses one agenda decision and never invents approval", () => {
    const parsed = parseAgendaDecision(
      JSON.stringify({
        decisionType: "APPROVED_WITH_CONDITIONS",
        decisionText: "Proceed to Stage 2 diligence.",
        rationale: "The evidence supports a bounded next step.",
        supportingEvidence: ["https://example.com/source"],
        supportingOpinions: ["Research supports proceeding."],
        risks: ["ARR is unaudited."],
        dissentingOpinions: ["Finance would defer."],
        evidenceGaps: ["Audited ARR."],
        conditions: ["Obtain audited ARR."],
        discussionState: "DISAGREEMENT",
      }),
    );
    expect(parsed).toMatchObject({
      decisionType: "APPROVED_WITH_CONDITIONS",
      supportingEvidence: ["https://example.com/source"],
      supportingOpinions: ["Research supports proceeding."],
      evidenceGaps: ["Audited ARR."],
      discussionState: "DISAGREEMENT",
    });
    expect(
      parseAgendaDecision(
        JSON.stringify({ decisionType: "MAYBE", decisionText: "x", rationale: "y" }),
      ),
    ).toBeNull();
  });

  it("parses the final summary and action items with an agenda reference", () => {
    expect(
      parseMeetingSummary(
        JSON.stringify({
          summary: "Five agenda decisions were recorded.",
          minutes: "The chair closed each agenda independently.",
          actionItems: [
            {
              title: "Collect audited ARR",
              description: "Request the data-room figure.",
              assigneeRole: "Finance",
              agendaSequence: 3,
              dueAt: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      summary: "Five agenda decisions were recorded.",
      actionItems: [{ agendaSequence: 3, dueAt: null }],
    });
    expect(parseMeetingSummary(JSON.stringify({ summary: "x" }))).toBeNull();
    expect(
      parseMeetingSummary(
        '{"summary":"Five agenda decisions were recorded.","minutes":"The chair closed each agenda independently.","actionItems":[{"title":"Collect audited ARR","description":"Request the data-room figure.","assigneeRole":"Finance","agendaSequence":3,"dueAt":null},]}',
      ),
    ).toMatchObject({
      summary: "Five agenda decisions were recorded.",
      actionItems: [{ title: "Collect audited ARR", agendaSequence: 3, assigneeRole: "Finance" }],
    });
  });

  it("gives agenda phases bounded token budgets", () => {
    expect(tokenLimitForPhase("AGENDA_REVIEW")).toBe(2_000);
    expect(tokenLimitForPhase("AGENDA_RESPONSE")).toBe(1_200);
    expect(tokenLimitForPhase("AGENDA_EVALUATION")).toBe(2_000);
    expect(tokenLimitForPhase("AGENDA_DECISION")).toBe(2_400);
    expect(tokenLimitForPhase("SUMMARY")).toBe(3_200);
  });
});

describe("chair structured output", () => {
  it("parses all four decision types and never claims human approval", () => {
    const parsed = parseChairOutput(JSON.stringify(validOutput));
    expect(parsed).not.toBeNull();
    expect(parsed?.decisions.map((decision) => decision.decisionType)).toEqual([
      "APPROVED_WITH_CONDITIONS",
      "DEFERRED",
      "REJECTED",
      "APPROVED",
    ]);
    expect(parsed?.decisions[0]?.approvalRequired).toBe(true);
    expect(parsed?.decisions[0]?.approvalStatus).toBe("PENDING");
    expect(parsed?.decisions[1]?.approvalRequired).toBe(false);
    expect(parsed?.decisions[2]?.approvalRequired).toBe(false);
    expect(parsed?.decisions[3]?.approvalRequired).toBe(true);
    expect(parsed?.actionItems[0]?.dueAt).toBeNull();
    expect(parsed?.actionItems[0]?.assigneeRole).toBe("Finance");
  });

  it("accepts a fenced JSON block and rejects malformed or incomplete output", () => {
    expect(
      parseChairOutput(`Here is the result:\n\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``),
    ).not.toBeNull();
    expect(parseChairOutput("The meeting decided to proceed.")).toBeNull();
    expect(
      parseChairOutput(JSON.stringify({ summary: "x", minutes: "y", decisions: [] })),
    ).toBeNull();
  });

  it("stores source URLs without inventing one", () => {
    expect(
      extractEvidence("Source: https://example.com/a and https://example.com/a."),
    ).toMatchObject({
      sources: ["https://example.com/a"],
    });
    expect(extractEvidence("No source here.").sources).toEqual([]);
  });
});
