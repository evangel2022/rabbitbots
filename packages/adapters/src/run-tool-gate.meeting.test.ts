import { describe, expect, it } from "vitest";
import { meetingTurnApprovalDenial } from "./run-tool-gate.js";

describe("meeting turn tool approval boundary", () => {
  it("returns a model-visible denial instead of creating an unanswerable approval card", () => {
    const message = meetingTurnApprovalDenial("meeting_turn", "web_fetch");
    expect(message).toContain("boardroom turn cannot ask");
    expect(message).toContain("continue with the available evidence");
    expect(message).toContain("web_fetch");
  });

  it("does not change approval for ordinary user and workforce runs", () => {
    expect(meetingTurnApprovalDenial("user", "web_fetch")).toBeNull();
    expect(meetingTurnApprovalDenial("meeting_action", "web_fetch")).toBeNull();
    expect(meetingTurnApprovalDenial("routine", "web_fetch")).toBeNull();
  });
});
