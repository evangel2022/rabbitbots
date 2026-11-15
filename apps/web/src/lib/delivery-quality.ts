export type EvidenceTrust = "VERIFIED" | "UNVERIFIED" | "INVALID";

export type EvidenceAssessment = {
  raw: string;
  trust: EvidenceTrust;
  reason: string | null;
};

export type DeliveryQuality = {
  criteria: string;
  /** Structural result of reading the result against the criteria. */
  criteriaStatus: "STRUCTURALLY_MET" | "STRUCTURALLY_INCOMPLETE" | "NOT_VERIFIED";
  findings: { required: number | null; found: number; met: boolean };
  verificationNote: { required: boolean; found: boolean; met: boolean };
  evidence: {
    required: boolean;
    count: number;
    invalid: number;
    verified: number;
    unverified: number;
  };
  evidenceItems: EvidenceAssessment[];
  /** Safe, human-readable reasons to review before accepting. */
  warnings: string[];
};

const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
]);

function normalizedHost(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** A URL is only invalid when its host is a known placeholder or its URL is malformed. */
export function assessEvidence(raw: string): EvidenceAssessment {
  const value = raw.trim();
  if (!value) return { raw: value, trust: "INVALID", reason: "Empty evidence" };
  const host = normalizedHost(value);
  if (host) {
    if (
      PLACEHOLDER_HOSTS.has(host) ||
      host.endsWith(".localhost") ||
      host.endsWith(".invalid") ||
      host === "example.com" ||
      host.endsWith(".example.com") ||
      host === "example.org" ||
      host.endsWith(".example.org") ||
      host === "example.net" ||
      host.endsWith(".example.net")
    ) {
      return {
        raw: value,
        trust: "INVALID",
        reason: "Placeholder or loopback host, not a traceable source.",
      };
    }
    // There is no verification record in the current data model. A syntactically
    // valid URL is evidence the user can inspect, not proof that it was checked.
    return { raw: value, trust: "UNVERIFIED", reason: null };
  }
  if (/^https?:\/\//i.test(value)) {
    return { raw: value, trust: "INVALID", reason: "Malformed or unsupported URL." };
  }
  // File paths and other concrete references can be useful, but no verification
  // process has run for them.
  return { raw: value, trust: "UNVERIFIED", reason: null };
}

function countFindings(text: string): number {
  const numbered = new Set<number>();
  for (const match of text.matchAll(/\bfindings?\s*(?:#|no\.?\s*)?(\d+)\b/gi)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) numbered.add(value);
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bulletCount = lines.filter((line) => /^(?:\d+[.)]|[-*•])\s+\S/.test(line)).length;
  return Math.max(numbered.size, bulletCount);
}

function requiredFindings(criteria: string): number | null {
  const match = criteria.match(/\b(?:three|3)\s+(?:(?:numbered|key)\s+)*findings?\b/i);
  return match ? 3 : null;
}

function requiresVerificationNote(criteria: string): boolean {
  return /verification\s+note|verification-note/i.test(criteria);
}

function requiresEvidence(criteria: string): boolean {
  return /\bevidence\b|\bsources?\b/i.test(criteria);
}

function hasVerificationNote(result: string): boolean {
  return /verification\s+note|verification-note|verified\s+(?:against|by|using)|sources?\s+checked/i.test(
    result,
  );
}

/** Evaluate structure and evidence trust without claiming that facts are true. */
export function assessDeliveryQuality(input: {
  criteria: string;
  resultSummary: string | null | undefined;
  evidence: readonly string[];
}): DeliveryQuality {
  const result = input.resultSummary?.trim() ?? "";
  const findingsRequired = requiredFindings(input.criteria);
  const findingsFound = countFindings(result);
  const noteRequired = requiresVerificationNote(input.criteria);
  const noteFound = hasVerificationNote(result);
  const evidenceRequired = requiresEvidence(input.criteria);
  const evidenceItems = input.evidence.map(assessEvidence);
  const invalid = evidenceItems.filter((item) => item.trust === "INVALID").length;
  const verified = evidenceItems.filter((item) => item.trust === "VERIFIED").length;
  const unverified = evidenceItems.filter((item) => item.trust === "UNVERIFIED").length;
  const findingsMet = findingsRequired === null || findingsFound >= findingsRequired;
  const noteMet = !noteRequired || noteFound;
  const evidenceMet =
    !evidenceRequired || (evidenceItems.length > 0 && invalid < evidenceItems.length);

  const warnings: string[] = [];
  if (findingsRequired !== null && !findingsMet) {
    warnings.push(`Expected ${findingsRequired} findings, found ${findingsFound}.`);
  }
  if (noteRequired && !noteMet) warnings.push("The requested verification note is missing.");
  if (!evidenceMet) warnings.push("The requested evidence is missing or entirely invalid.");
  if (invalid > 0) {
    warnings.push(`${invalid} evidence item(s) use a placeholder or invalid source.`);
  }
  if (unverified > 0) {
    warnings.push(`${unverified} evidence item(s) have no verification record.`);
  }
  if (!result) warnings.push("No result summary is recorded.");

  const structurallyComplete =
    findingsMet && noteMet && (input.evidence.length > 0 || !evidenceRequired);
  const criteriaStatus =
    !structurallyComplete ||
    warnings.some((warning) => /missing|Expected|entirely invalid/i.test(warning))
      ? "STRUCTURALLY_INCOMPLETE"
      : "NOT_VERIFIED";
  if (!warnings.length) {
    warnings.push("No content verification record exists for this result.");
  }

  return {
    criteria: input.criteria,
    criteriaStatus,
    findings: { required: findingsRequired, found: findingsFound, met: findingsMet },
    verificationNote: { required: noteRequired, found: noteFound, met: noteMet },
    evidence: {
      required: evidenceRequired,
      count: evidenceItems.length,
      invalid,
      verified,
      unverified,
    },
    evidenceItems,
    warnings,
  };
}

export function evidenceTrustLabel(trust: EvidenceTrust): string {
  return trust === "VERIFIED" ? "VERIFIED" : trust === "INVALID" ? "INVALID" : "UNVERIFIED";
}
