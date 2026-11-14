import { describe, expect, it } from "vitest";
import { delegatedWorkforceApprovalDenial } from "./run-tool-gate.js";

describe("delegated workforce approval boundary", () => {
  it("denies approval-required tools without creating a hidden approval card", () => {
    const message = delegatedWorkforceApprovalDenial(
      "BOT_DELEGATED",
      "workforce_task",
      "web_fetch",
    );
    expect(message).toContain("delegated child has no approval surface");
    expect(message).toContain("continue with the available evidence");
    expect(message).toContain("web_fetch");
  });

  it("keeps CEO Direct and other run approval semantics unchanged", () => {
    expect(
      delegatedWorkforceApprovalDenial("CEO_DIRECT", "workforce_task", "web_fetch"),
    ).toBeNull();
    expect(delegatedWorkforceApprovalDenial("BOT_DELEGATED", "user", "web_fetch")).toBeNull();
    expect(delegatedWorkforceApprovalDenial(undefined, "workforce_task", "web_fetch")).toBeNull();
  });
});
