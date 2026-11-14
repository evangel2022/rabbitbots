import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";

export type OwnBotIdentityChange = {
  botId: string;
  beforeName: string;
  beforeDescription: string;
  name?: string;
  description?: string;
};

export const OWN_BOT_IDENTITY_KEY = "identityUpdate";

export function ownBotIdentityChange(value: unknown): OwnBotIdentityChange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.botId !== "string" ||
    typeof row.beforeName !== "string" ||
    typeof row.beforeDescription !== "string" ||
    (row.name !== undefined && typeof row.name !== "string") ||
    (row.description !== undefined && typeof row.description !== "string") ||
    (row.name === undefined && row.description === undefined)
  )
    return undefined;
  return {
    botId: row.botId,
    beforeName: row.beforeName,
    beforeDescription: row.beforeDescription,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.description !== undefined ? { description: row.description } : {}),
  };
}

export function sameOwnBotIdentityChange(left: unknown, right: unknown): boolean {
  const a = ownBotIdentityChange(left);
  const b = ownBotIdentityChange(right);
  return Boolean(
    a &&
      b &&
      a.botId === b.botId &&
      a.beforeName === b.beforeName &&
      a.beforeDescription === b.beforeDescription &&
      a.name === b.name &&
      a.description === b.description,
  );
}

export type UpdateBotPatch = {
  name?: string;
  description?: string;
  color?: string;
  notifyOnFinish?: boolean;
  dailyCheckIns?: boolean;
};

function hasUpdateBotAvatarArgs(args: Record<string, unknown>): boolean {
  return (
    args.color !== undefined || args.artifact_id !== undefined || args.use_attached_image === true
  );
}

export function parseUpdateBotPatch(
  args: Record<string, unknown>,
): { error: string } | { patch: UpdateBotPatch } {
  const patch: UpdateBotPatch = {};
  if (args.name !== undefined) patch.name = String(args.name);
  if (args.description !== undefined) patch.description = String(args.description);
  if (args.dailyCheckIns !== undefined) {
    if (typeof args.dailyCheckIns !== "boolean")
      return { error: "dailyCheckIns must be true or false." };
    patch.dailyCheckIns = args.dailyCheckIns;
  }
  const notifyRaw = args.notifyOnFinish !== undefined ? args.notifyOnFinish : args.notify_on_finish;
  if (notifyRaw !== undefined) {
    if (typeof notifyRaw !== "boolean") {
      return { error: "notifyOnFinish must be true or false." };
    }
    patch.notifyOnFinish = notifyRaw;
  }
  if (Object.keys(patch).length === 0 && !hasUpdateBotAvatarArgs(args)) {
    return {
      error:
        "Provide at least one of name, description, notifyOnFinish, color, artifact_id, or use_attached_image.",
    };
  }
  if (patch.name !== undefined) {
    const nextName = patch.name.trim();
    if (!nextName) return { error: "name cannot be empty." };
    if (nextName.length > BOT_NAME_MAX_LENGTH) {
      return { error: `name must be at most ${BOT_NAME_MAX_LENGTH} characters.` };
    }
    patch.name = nextName;
  }
  if (patch.description !== undefined) {
    const nextDescription = patch.description.trim();
    if (nextDescription.length > BOT_DESCRIPTION_MAX_LENGTH) {
      return { error: `description must be at most ${BOT_DESCRIPTION_MAX_LENGTH} characters.` };
    }
    patch.description = nextDescription;
  }
  return { patch };
}

/** The bot's current values that an own `update_bot` call can repeat. */
export type OwnBotCurrentValues = {
  name: string;
  description: string | null;
  instructions: string;
  color: string;
  notifyOnFinish: boolean;
  dailyCheckIns: boolean;
  thinkingLevel: string | null;
  autoSpeak: boolean;
  voiceId: string | null;
};

/**
 * Some models fill in every field of a tool call, repeating current values and `false` for
 * switches they mean to leave alone. A value the bot already has is not a change, so drop it:
 * otherwise a plain read looks like a write and is refused or held.
 */
export function dropUnchangedOwnBotArgs(
  args: Record<string, unknown>,
  current: OwnBotCurrentValues,
  /** Every way the model the bot runs on is written: its id, provider/id and its read label. */
  currentModelNames: string[] = [],
  /** The thinking level this run uses, which a bot on the default level reports as its own. */
  runningThinkingLevel?: string | null,
): Record<string, unknown> {
  const same: Record<string, unknown[]> = {
    name: [current.name],
    description: [current.description ?? ""],
    instructions: [current.instructions],
    color: [current.color],
    notifyOnFinish: [current.notifyOnFinish],
    notify_on_finish: [current.notifyOnFinish],
    dailyCheckIns: [current.dailyCheckIns],
    model: currentModelNames.map((name) => name.toLowerCase()),
    thinkingLevel: current.thinkingLevel
      ? [current.thinkingLevel]
      : ["default", ...(runningThinkingLevel ? [runningThinkingLevel] : [])],
    readAloud: [current.autoSpeak],
    voice: [current.voiceId ?? "default"],
    use_attached_image: [false],
    // Reading from the start is the default, not a request to page.
    instructions_offset: [0],
    instructionsOffset: [0],
  };
  const kept: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
    const values = same[key] ?? [];
    // Switches sometimes arrive as the text "true" or "false".
    const value =
      typeof values[0] === "boolean" && (raw === "true" || raw === "false") ? raw === "true" : raw;
    const compared =
      typeof value !== "string"
        ? value
        : key === "model"
          ? value.trim().toLowerCase()
          : value.trim();
    const repeated = values.some((known) =>
      typeof known === "string" ? known.trim() === compared : known === compared,
    );
    if (!repeated) kept[key] = value;
  }
  return kept;
}

/** How many ignored fields a paged read names, and how much of each value it shows. */
const IGNORED_FIELDS_SHOWN = 8;
const IGNORED_VALUE_PREVIEW = 60;

/** The fields a paged read did not apply, bounded so the read keeps its own size budget. */
export function ignoredFieldsNote(fields: Record<string, unknown>): string | undefined {
  const given = Object.entries(fields).filter(([, value]) => argumentGiven(value));
  if (!given.length) return undefined;
  const shown = given.slice(0, IGNORED_FIELDS_SHOWN).map(([key, value]) => {
    const json = JSON.stringify(value) ?? "";
    return `${key}=${json.length > IGNORED_VALUE_PREVIEW ? `${json.slice(0, IGNORED_VALUE_PREVIEW)}…` : json}`;
  });
  const more = given.length - shown.length;
  return `This was a read, so these were not applied: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. To change one, call update_bot with just that field and no instructions_offset.`;
}

/** Providers send omitted optional fields as null or blank; only anything else counts as given. */
export function argumentGiven(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}
