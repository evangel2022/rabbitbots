import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";

const INTERNAL_REVIEW_PHASES = new Set(["AGENDA_REVIEW", "AGENDA_EVALUATION", "AGENDA_DECISION"]);

type JsonObject = Record<string, unknown>;

export type MeetingReviewResult = {
  kind: "review";
  state: string;
  materialDisagreement?: boolean;
  reason: string;
  consensus: string[];
  disagreements: string[];
  evidenceGaps: string[];
  question: string;
  participants: string[];
};

export type MeetingStructuredContent = {
  lead: string;
  review: MeetingReviewResult | null;
  /** True when the turn contains a JSON object, even if its schema is unknown. */
  jsonLike: boolean;
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

/** Find the first balanced JSON object, including one embedded after prose or a code fence. */
function findObject(content: string): { object: JsonObject; start: number; end: number } | null {
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < content.length; index += 1) {
      const character = content[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const object = asObject(JSON.parse(content.slice(start, index + 1)));
            if (object) return { object, start, end: index + 1 };
          } catch {
            // Keep scanning: prose can contain braces before the real object.
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Parse a meeting turn without treating arbitrary prose or user-authored JSON as a decision.
 * The returned lead keeps the human-readable prose that preceded an embedded object.
 */
export function parseMeetingStructuredContent(content: string): MeetingStructuredContent {
  const source = content.trim();
  if (!source) return { lead: "", review: null, jsonLike: false };
  const found = findObject(source);
  if (!found) {
    const jsonStart = source.indexOf("{");
    return {
      lead: jsonStart > 0 ? source.slice(0, jsonStart).trim() : "",
      review: null,
      jsonLike:
        jsonStart === 0 ||
        /"(?:materialDisagreement|decisionType|consensus|evidenceGaps)"\s*:/.test(source),
    };
  }

  const object = found.object;
  // A review is identified by its decision-shaped fields, not by merely being JSON.
  const reviewLike =
    typeof object.materialDisagreement === "boolean" ||
    (Array.isArray(object.consensus) && Array.isArray(object.evidenceGaps)) ||
    (typeof object.state === "string" && Array.isArray(object.consensus)) ||
    (typeof object.state === "string" && typeof object.reason === "string");
  const lead = source
    .slice(0, found.start)
    .replace(/```(?:json)?\s*$/i, "")
    .trim();
  if (!reviewLike) {
    return { lead, review: null, jsonLike: true };
  }
  const materialDisagreement =
    typeof object.materialDisagreement === "boolean" ? object.materialDisagreement : undefined;
  return {
    lead,
    jsonLike: true,
    review: {
      kind: "review",
      state: text(object.state) || (materialDisagreement ? "DISAGREEMENT" : "AGREEMENT"),
      ...(materialDisagreement !== undefined ? { materialDisagreement } : {}),
      reason: text(object.reason),
      consensus: list(object.consensus),
      disagreements: list(object.disagreements),
      evidenceGaps: list(object.evidenceGaps),
      question: text(object.question),
      participants: list(object.participants),
    },
  };
}

function ReviewList({ title, values, tone }: { title: string; values: string[]; tone?: string }) {
  if (!values.length) return null;
  return (
    <div className="mt-2">
      <div className="text-label font-medium text-foreground">{title}</div>
      <ul className="mt-1 list-disc space-y-1 ps-5 text-label text-muted-foreground">
        {values.map((value, index) => (
          <li key={`${title}-${index}`} className={tone}>
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewCard({ review }: { review: MeetingReviewResult }) {
  return (
    <div
      data-testid="meeting-structured-decision"
      className="rounded-lg border border-border bg-background px-3 py-2"
    >
      <div className="text-label font-medium uppercase tracking-wide text-muted-foreground">
        <Trans>Meeting decision</Trans>
      </div>
      <div className="mt-1 text-body-sm font-medium">
        <Trans>State:</Trans> {review.state.replaceAll("_", " ")}
      </div>
      {review.materialDisagreement !== undefined ? (
        <div className="mt-1 text-label text-muted-foreground">
          <Trans>Material disagreement:</Trans>{" "}
          {review.materialDisagreement ? <Trans>Yes</Trans> : <Trans>No</Trans>}
        </div>
      ) : null}
      {review.reason ? <p className="mt-2 text-body-sm text-foreground">{review.reason}</p> : null}
      <ReviewList title="Consensus" values={review.consensus} />
      <ReviewList title="Disagreements" values={review.disagreements} tone="text-warning" />
      <ReviewList title="Evidence gaps" values={review.evidenceGaps} />
      {review.question ? (
        <div className="mt-2 text-body-sm">
          <span className="font-medium">
            <Trans>Next question:</Trans>
          </span>{" "}
          {review.question}
        </div>
      ) : null}
      <ReviewList title="Participants" values={review.participants} />
    </div>
  );
}

/**
 * Render a persisted meeting turn. Internal structured turns get a readable decision card;
 * unknown internal JSON gets a non-raw fallback. Ordinary prose still uses ChatMarkdown.
 */
export function MeetingStructuredTurn({ content, phase }: { content: string; phase: string }) {
  const parsed = parseMeetingStructuredContent(content);
  if (parsed.review) {
    return (
      <div data-testid="meeting-turn-structured">
        {parsed.lead ? <ChatMarkdown>{parsed.lead}</ChatMarkdown> : null}
        <div className="mt-2">
          <ReviewCard review={parsed.review} />
        </div>
      </div>
    );
  }
  if (parsed.jsonLike && INTERNAL_REVIEW_PHASES.has(phase)) {
    return (
      <div data-testid="meeting-turn-structured-fallback">
        {parsed.lead ? <ChatMarkdown>{parsed.lead}</ChatMarkdown> : null}
        <p className="text-body-sm text-muted-foreground">
          <Trans>
            Structured meeting output is saved in the meeting record. It cannot be displayed here
            without exposing raw internal data.
          </Trans>
        </p>
      </div>
    );
  }
  return <ChatMarkdown>{content}</ChatMarkdown>;
}
