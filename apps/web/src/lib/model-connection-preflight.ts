import { plural, t } from "@lingui/core/macro";
import type { ModelCredential } from "@rakazo/contracts";

type ModelPreflightOutcome =
  | "timeout"
  | "rate_limit"
  | "unauthorized"
  | "unavailable_model"
  | "connection_refused"
  | "dns"
  | "invalid_url"
  | "model_not_found"
  | "provider_response"
  | "unreachable"
  | "needs_sign_in"
  | "missing_fields"
  | "private_endpoint"
  | "unknown";

export type ModelPreflightFailure = {
  outcome: ModelPreflightOutcome;
  message: string;
  nextAction: string;
};

type StoredModelAuthKind = NonNullable<ModelCredential["authKind"]>;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{8,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._-]+\b/gi,
  /\bapi[_-]?key[=:]\s*\S+/gi,
];

/** Strip patterns that look like credentials from user-visible errors. */
export function sanitizeModelConnectionError(raw: string): string {
  let text = raw.trim();
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "•••");
  }
  return text;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return sanitizeModelConnectionError(error.message);
  return sanitizeModelConnectionError(String(error));
}

export function classifyModelConnectionFailure(
  error: unknown,
  context: { modelId?: string; discoveredModels?: string[]; manualEntry?: boolean } = {},
): ModelPreflightFailure {
  const message = messageFromError(error);
  const lower = message.toLowerCase();

  if (context.modelId && context.discoveredModels && context.discoveredModels.length > 0) {
    const modelId = sanitizeModelConnectionError(context.modelId.trim());
    if (modelId && !context.discoveredModels.includes(context.modelId.trim())) {
      return {
        outcome: "unavailable_model",
        message: t`Model "${modelId}" was not listed.`,
        nextAction:
          context.manualEntry === false
            ? t`Pick a model from the catalog.`
            : t`Pick a model from the list or enter a model id served by this endpoint.`,
      };
    }
  }

  if (
    lower.includes("invalid url") ||
    lower.includes("url is invalid") ||
    lower.includes("url is not valid") ||
    lower.includes("invalid endpoint") ||
    lower.includes("invalid base url") ||
    lower.includes("not a valid url") ||
    lower.includes("must use https") ||
    lower.includes("url must use") ||
    lower.includes("unsupported protocol") ||
    lower.includes("url scheme")
  ) {
    return {
      outcome: "invalid_url",
      message: message || t`The server URL is invalid.`,
      nextAction: t`Use the full base URL, including /v1 and the http or https scheme.`,
    };
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      outcome: "timeout",
      message: message || t`The connection timed out.`,
      nextAction: t`Check the server URL and network, then test again.`,
    };
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate-limit")) {
    return {
      outcome: "rate_limit",
      message: message || t`The provider is rate-limiting requests.`,
      nextAction: t`Wait a moment and test again.`,
    };
  }

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return {
      outcome: "unauthorized",
      message: message || t`Authentication failed.`,
      nextAction: t`Check the API key or sign-in, then test again.`,
    };
  }

  if (lower.includes("mcp_allow_private_endpoint") || lower.includes("private model endpoint")) {
    return {
      outcome: "private_endpoint",
      message: message || t`Local model endpoint is not allowed by this deployment.`,
      nextAction: t`Set MCP_ALLOW_PRIVATE_ENDPOINT=true on both API and Worker, then restart the services.`,
    };
  }

  if (
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("no such model")
  ) {
    return {
      outcome: "model_not_found",
      message: message || t`The model was not found on this server.`,
      nextAction: t`Use Find models or enter an exact model id returned by the server.`,
    };
  }

  if (
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("getaddrinfo") ||
    lower.includes("name or service not known") ||
    lower.includes("temporary failure in name resolution") ||
    lower.includes("no such host") ||
    lower.includes("could not resolve host")
  ) {
    return {
      outcome: "dns",
      message: message || t`The model server hostname could not be resolved.`,
      nextAction: t`Check the hostname and DNS/VPN settings, then test again.`,
    };
  }

  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return {
      outcome: "connection_refused",
      message: message || t`The model server refused the connection.`,
      nextAction: t`Confirm the server is running and listening on the URL and port you entered.`,
    };
  }

  if (
    /\b5[0-9]{2}\b/.test(lower) ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout") ||
    lower.includes("provider error") ||
    lower.includes("provider returned") ||
    lower.includes("upstream") ||
    lower.includes("server error")
  ) {
    return {
      outcome: "provider_response",
      message: message || t`The provider returned a server error.`,
      nextAction: t`Check the provider status and server logs, then test again.`,
    };
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("could not reach") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach")
  ) {
    return {
      outcome: "unreachable",
      message: message || t`Could not reach the model server.`,
      nextAction: t`Confirm the URL is reachable from this browser session, then test again.`,
    };
  }

  return {
    outcome: "unknown",
    message: message || t`Connection test failed.`,
    nextAction: t`Review provider settings and test again.`,
  };
}

/** Failure when a non-empty model list omits the selected id. Empty lists stay reachable. */
export function unavailableSelectedModel(
  modelId: string | undefined,
  discoveredModels: string[],
  options?: { manualEntry?: boolean },
): ModelPreflightFailure | null {
  const trimmed = modelId?.trim() ?? "";
  if (!trimmed || discoveredModels.length === 0 || discoveredModels.includes(trimmed)) return null;
  return classifyModelConnectionFailure(new Error("model not listed"), {
    modelId: trimmed,
    discoveredModels,
    manualEntry: options?.manualEntry,
  });
}

type ListedModelCredential = {
  id?: string;
  provider: string;
  authKind?: StoredModelAuthKind;
  modelId?: string;
  isDefault?: boolean;
  reconnectRequired?: boolean;
};

/**
 * Newest-first list. The row that owns `modelId` wins, then the space default,
 * then any saved model for the provider, then the newest row.
 */
function credentialForSpaceModel<T extends ListedModelCredential>(
  credentials: readonly T[],
  provider: string,
  modelId?: string,
): T | undefined {
  const rows = credentials.filter((entry) => entry.provider === provider);
  const requested = modelId?.trim() ?? "";
  if (requested) {
    const owner = rows.find((entry) => entry.modelId?.trim() === requested);
    if (owner) return owner;
  }
  return (
    rows.find((entry) => entry.isDefault) ??
    rows.find((entry) => Boolean(entry.modelId?.trim())) ??
    rows[0]
  );
}

/** Separate a failed credential lookup from an empty list or an unreadable secret. */
export async function loadStoredModelAuth(
  provider: string,
  listCredentials: () => Promise<ReadonlyArray<ListedModelCredential>>,
  modelId?: string,
  credentialId?: string | null,
): Promise<{
  storedAuthKind: StoredModelAuthKind | null;
  credentialLookupFailed: boolean;
  credentialUnreadable: boolean;
  reconnectRequired: boolean;
}> {
  try {
    const credentials = await listCredentials();
    const match =
      credentialId === undefined
        ? credentialForSpaceModel(credentials, provider, modelId)
        : credentials.find((entry) => entry.id === credentialId && entry.provider === provider);
    return {
      storedAuthKind: match?.authKind ?? null,
      credentialLookupFailed: false,
      credentialUnreadable: Boolean(match && match.authKind === undefined),
      reconnectRequired: match?.reconnectRequired === true,
    };
  } catch {
    return {
      storedAuthKind: null,
      credentialLookupFailed: true,
      credentialUnreadable: false,
      reconnectRequired: false,
    };
  }
}

type ModelConnectionPreflightInput = {
  authKind: "api-key" | "oauth";
  provider: string;
  apiKey?: string;
  modelId?: string;
  /** Kind of the stored credential, when a lookup succeeded and the secret was readable. */
  storedAuthKind?: StoredModelAuthKind | null;
  credentialLookupFailed?: boolean;
  /** A credential row exists but its kind could not be read. */
  credentialUnreadable?: boolean;
  /** The stored subscription sign-in was rejected and has to be signed in again. */
  reconnectRequired?: boolean;
  /** Catalog entry says this provider has a pinned models-list URL. */
  catalogProbe?: boolean;
  probeCatalog?: (input: { provider: string; apiKey: string }) => Promise<{ models: string[] }>;
};

export async function runModelConnectionPreflight(
  input: ModelConnectionPreflightInput,
): Promise<
  { ok: true; discoveredModels: string[] } | { ok: false; failure: ModelPreflightFailure }
> {
  if (input.authKind === "oauth") {
    if (input.credentialLookupFailed || input.credentialUnreadable) {
      return {
        ok: false,
        failure: {
          outcome: "unknown",
          message: t`Could not check stored credentials.`,
          nextAction: t`Try the test again.`,
        },
      };
    }
    if (input.reconnectRequired) {
      return {
        ok: false,
        failure: {
          outcome: "needs_sign_in",
          message: t`This provider is not connected yet.`,
          nextAction: t`Finish subscription sign-in, then test again.`,
        },
      };
    }
    if (input.storedAuthKind === "oauth") {
      return { ok: true, discoveredModels: [] };
    }
    if (input.storedAuthKind === "api_key" || input.storedAuthKind === "openai_compatible") {
      return {
        ok: false,
        failure: {
          outcome: "needs_sign_in",
          message: t`An API key is stored for this provider, not a subscription sign-in.`,
          nextAction: t`Sign in with the subscription, or test the API key instead.`,
        },
      };
    }
    return {
      ok: false,
      failure: {
        outcome: "needs_sign_in",
        message: t`This provider is not connected yet.`,
        nextAction: t`Finish subscription sign-in, then test again.`,
      },
    };
  }

  const trimmedKey = input.apiKey?.trim() ?? "";
  const trimmedModel = input.modelId?.trim() ?? "";

  if (trimmedKey.length < 8) {
    return {
      ok: false,
      failure: {
        outcome: "missing_fields",
        message: t`Enter an API key before testing.`,
        nextAction: t`Paste your API key, then test again.`,
      },
    };
  }
  if (!input.catalogProbe || !input.probeCatalog) {
    return {
      ok: false,
      failure: {
        outcome: "unknown",
        message: t`This provider cannot be tested without saving.`,
        nextAction: t`Use Connect to verify the key.`,
      },
    };
  }
  try {
    const { models } = await input.probeCatalog({
      provider: input.provider,
      apiKey: trimmedKey,
    });
    const unavailable = unavailableSelectedModel(trimmedModel, models, { manualEntry: false });
    if (unavailable) return { ok: false, failure: unavailable };
    return { ok: true, discoveredModels: models };
  } catch (error) {
    return {
      ok: false,
      failure: classifyModelConnectionFailure(error, { modelId: trimmedModel }),
    };
  }
}

/** Catalog models-list result. Custom servers use `openAiCompatibleProbeSuccessMessage`. */
export function modelPreflightSuccessMessage(modelCount: number): string {
  if (modelCount === 0) {
    return t`No models listed.`;
  }
  return t`Models list OK. ${plural(modelCount, {
    one: "# model",
    other: "# models",
  })} available. Chat was not tested.`;
}
