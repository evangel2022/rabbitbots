import { createStoredPreference } from "./stored-preference";

export type ComputerWorkspacePreference = "open" | "closed";

export const COMPUTER_WORKSPACE_STORAGE_KEY = "rabbitbots:computer-workspace";

/** The computer rail is on unless someone hid it; a fresh demo starts with it open. */
export function normalizeComputerWorkspacePreference(
  raw: string | null | undefined,
): ComputerWorkspacePreference {
  return raw?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

export const computerWorkspacePreference = createStoredPreference<ComputerWorkspacePreference>({
  key: COMPUTER_WORKSPACE_STORAGE_KEY,
  parse: normalizeComputerWorkspacePreference,
  serialize: (value) => value,
});
