import type { MeetingMessageView, MeetingTurnView } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { mergeMeetingTranscript } from "./meeting-transcript";

const turn = (overrides: Partial<MeetingTurnView> = {}): MeetingTurnView => ({
  id: "turn-1",
  agendaId: "agenda-1",
  participantBotId: "bot-1",
  participantBotName: "Research Bot",
  phase: "AGENDA_RESPONSE",
  round: 1,
  content: "Bot reply",
  evidence: {},
  status: "COMPLETED",
  createdAt: "2026-11-11T10:00:01.000Z",
  ...overrides,
});

const message = (overrides: Partial<MeetingMessageView> = {}): MeetingMessageView => ({
  id: "message-1",
  meetingId: "meeting-1",
  agendaId: "agenda-1",
  authorType: "HUMAN_CEO",
  authorName: "Human CEO",
  authorUserId: "user-1",
  authorBotId: null,
  content: "Human message",
  seq: 1,
  createdAt: "2026-11-11T10:00:00.000Z",
  ...overrides,
});

describe("mergeMeetingTranscript", () => {
  it("keeps human and Bot messages in one chronological transcript", () => {
    const merged = mergeMeetingTranscript([turn()], [message()]);
    expect(merged.map((item) => item.kind)).toEqual(["human", "turn"]);
    expect(merged[0]!.kind === "human" && merged[0]!.message.authorType).toBe("HUMAN_CEO");
    expect(merged[1]!.kind === "turn" && merged[1]!.turn.participantBotName).toBe("Research Bot");
  });

  it("shows a human instruction before a Bot message created at the same instant", () => {
    const merged = mergeMeetingTranscript(
      [turn({ createdAt: "2026-11-11T10:00:00.000Z" })],
      [message()],
    );
    expect(merged.map((item) => item.kind)).toEqual(["human", "turn"]);
  });

  it("does not invent a speaker for an empty transcript", () => {
    expect(mergeMeetingTranscript([], [])).toEqual([]);
  });
});
