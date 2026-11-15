import { describe, expect, it } from "vitest";
import { assessDeliveryQuality, assessEvidence } from "./delivery-quality.js";

describe("assessEvidence", () => {
  it("marks example.com, example.org, example.net and localhost as invalid", () => {
    for (const raw of [
      "https://example.com/report",
      "https://docs.example.org/a",
      "http://example.net/b",
      "http://localhost:11434/v1",
      "http://127.0.0.1:8000/evidence",
    ]) {
      expect(assessEvidence(raw)).toMatchObject({ trust: "INVALID" });
    }
  });

  it("keeps a normal external URL unverified rather than invalid or verified", () => {
    expect(assessEvidence("https://research.example.test/source")).toMatchObject({
      trust: "UNVERIFIED",
    });
    expect(assessEvidence("https://www.wikipedia.org/wiki/Obsidian")).toMatchObject({
      trust: "UNVERIFIED",
    });
    expect(assessEvidence("https://www.wikipedia.org/wiki/Obsidian").reason).toBeNull();
  });

  it("does not invent VERIFIED status without a verification record", () => {
    const results = [
      assessEvidence("https://example.org/report"),
      assessEvidence("https://www.wikipedia.org/wiki/Obsidian"),
      assessEvidence("reports/notes.md"),
    ];
    expect(results.some((result) => result.trust === "VERIFIED")).toBe(false);
  });

  it("treats an empty evidence value as invalid", () => {
    expect(assessEvidence("   ")).toMatchObject({ trust: "INVALID" });
  });
});

describe("assessDeliveryQuality", () => {
  it("warns when required findings and verification note are missing", () => {
    const quality = assessDeliveryQuality({
      criteria: "Provide three findings and one verification note.",
      resultSummary: "The comparison was completed.",
      evidence: ["https://example.com/obsidian-review", "https://example.com/logseq-review"],
    });
    expect(quality.findings).toMatchObject({ required: 3, found: 0, met: false });
    expect(quality.verificationNote).toMatchObject({ required: true, found: false, met: false });
    expect(quality.criteriaStatus).toBe("STRUCTURALLY_INCOMPLETE");
    expect(quality.evidence).toMatchObject({ invalid: 2, unverified: 0 });
    expect(quality.warnings.join(" ")).toMatch(/Expected 3 findings/);
    expect(quality.warnings.join(" ")).toMatch(/placeholder/);
  });

  it("recognizes 'exactly three numbered findings' as a structural requirement", () => {
    const quality = assessDeliveryQuality({
      criteria: "Provide exactly three numbered findings.",
      resultSummary: "The comparison was completed.",
      evidence: [],
    });
    expect(quality.findings).toMatchObject({ required: 3, found: 0, met: false });
    expect(quality.criteriaStatus).toBe("STRUCTURALLY_INCOMPLETE");
  });

  it("marks structurally complete output as not verified, not verified-correct", () => {
    const quality = assessDeliveryQuality({
      criteria: "Provide three findings and one verification note.",
      resultSummary:
        "Three findings:\n1. Finding one.\n2. Finding two.\n3. Finding three.\nVerification note: checked the local notes.",
      evidence: ["https://www.wikipedia.org/wiki/Obsidian"],
    });
    expect(quality.findings).toMatchObject({ required: 3, found: 3, met: true });
    expect(quality.verificationNote).toMatchObject({ required: true, found: true, met: true });
    expect(quality.evidence).toMatchObject({ invalid: 0, unverified: 1 });
    expect(quality.criteriaStatus).toBe("NOT_VERIFIED");
    expect(quality.warnings.join(" ")).toMatch(/no verification record/);
  });

  it("reports no evidence without inventing a warning about a broken URL", () => {
    const quality = assessDeliveryQuality({
      criteria: "Provide evidence.",
      resultSummary: "Result with three findings:\n1. One.\n2. Two.\n3. Three.",
      evidence: [],
    });
    expect(quality.evidence).toMatchObject({ count: 0, invalid: 0, unverified: 0 });
    expect(quality.criteriaStatus).toBe("STRUCTURALLY_INCOMPLETE");
    expect(quality.warnings.join(" ")).toMatch(/evidence is missing/);
  });

  it("does not require evidence when the criteria does not ask for it", () => {
    const quality = assessDeliveryQuality({
      criteria: "Summarize the decision.",
      resultSummary: "The decision is summarized.",
      evidence: [],
    });
    expect(quality.evidence.required).toBe(false);
    expect(quality.warnings.join(" ")).not.toMatch(/evidence is missing/);
  });
});
