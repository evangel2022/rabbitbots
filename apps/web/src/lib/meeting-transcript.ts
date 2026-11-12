import type { MeetingMessageView, MeetingTurnView } from "@rakazo/contracts";

export type MeetingTranscriptItem =
  | { kind: "turn"; id: string; createdAt: string; turn: MeetingTurnView }
  | { kind: "human"; id: string; createdAt: string; message: MeetingMessageView };

/**
 * One chronological transcript for persisted human messages and real Bot turns.
 * Ties keep the human message first so an immediate Bot answer cannot visually
 * jump ahead of the instruction that prompted it.
 */
export function mergeMeetingTranscript(
  turns: MeetingTurnView[],
  messages: MeetingMessageView[],
): MeetingTranscriptItem[] {
  return [
    ...turns.map(
      (turn): MeetingTranscriptItem => ({
        kind: "turn",
        id: turn.id,
        createdAt: turn.createdAt,
        turn,
      }),
    ),
    ...messages.map(
      (message): MeetingTranscriptItem => ({
        kind: "human",
        id: message.id,
        createdAt: message.createdAt,
        message,
      }),
    ),
  ].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byTime !== 0) return byTime;
    if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
