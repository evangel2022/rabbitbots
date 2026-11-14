import type { Bot } from "@rakazo/contracts";

/** A bot created here belongs in the roster before the next list request answers. */
export function withCreatedBot(current: Bot[], bot: Bot): Bot[] {
  return current.some((item) => item.id === bot.id) ? current : [bot, ...current];
}
