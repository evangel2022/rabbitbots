// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { withCreatedBot } from "./roster-create";

const bot = { id: "new-bot", name: "New Bot" } as Bot;

it("puts a newly created bot in the roster immediately and never duplicates it", () => {
  const current = [{ id: "old-bot", name: "Old Bot" } as Bot];
  const next = withCreatedBot(current, bot);
  expect(next).toEqual([bot, current[0]]);
  expect(withCreatedBot(next, bot)).toBe(next);
});
