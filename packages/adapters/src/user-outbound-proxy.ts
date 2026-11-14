import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { Dispatcher } from "undici";
import type { DeploymentOutboundProxyRoute } from "./outbound-proxy.js";
import {
  createProxyAwareModelFetch,
  normalizeBypass,
  OutboundProxyValidationError,
  readDeploymentOutboundProxyConfig,
  validateOutboundProxyUrl,
} from "./outbound-proxy.js";
import { createCheckedProxyDispatcherFor } from "./proxy-dispatcher.js";
import { dispatcherFetch } from "./undici-fetch.js";

export const USER_OUTBOUND_PROXY_RECORD_PREFIX = "user-outbound-proxy";

export type UserOutboundProxyMode = "inherit" | "direct" | "custom";

export type UserOutboundProxyRoute =
  | { mode: "direct" }
  | { mode: "proxy"; url: string; bypass: string[] };

export function userOutboundProxyRecordId(userId: string): string {
  return `${USER_OUTBOUND_PROXY_RECORD_PREFIX}:${userId}`;
}

type StoredUserProxy = { url?: unknown; bypass?: unknown };

function parseUserProxy(plaintext: string): { url: string; bypass: string[] } {
  let value: StoredUserProxy;
  try {
    value = JSON.parse(plaintext) as StoredUserProxy;
  } catch {
    throw new OutboundProxyValidationError("Saved user proxy settings could not be read");
  }
  if (!value || typeof value.url !== "string" || !value.url.trim()) {
    throw new OutboundProxyValidationError("Saved user proxy settings could not be read");
  }
  return {
    url: validateOutboundProxyUrl(value.url),
    bypass: normalizeBypass(
      Array.isArray(value.bypass)
        ? value.bypass.filter((entry): entry is string => typeof entry === "string")
        : [],
    ),
  };
}

export async function resolveUserProxyRoute(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
): Promise<UserOutboundProxyRoute> {
  const row = await runAsSystem("read a user's outbound proxy", () =>
    prisma.userNetworkProxy.findUnique({
      where: { userId },
      select: { mode: true, proxyCipher: true },
    }),
  );
  const mode = row?.mode ?? "inherit";
  if (mode === "direct") return { mode: "direct" };
  if (mode === "custom") {
    if (!row?.proxyCipher) {
      throw new OutboundProxyValidationError("Saved user proxy settings are incomplete");
    }
    const plaintext = await secrets.load(row.proxyCipher, {
      recordId: userOutboundProxyRecordId(userId),
    });
    const stored = parseUserProxy(plaintext);
    return { mode: "proxy", url: stored.url, bypass: stored.bypass };
  }
  if (mode !== "inherit") {
    throw new OutboundProxyValidationError("Saved user proxy mode could not be read");
  }
  return (await readDeploymentOutboundProxyConfig(prisma, secrets)) as DeploymentOutboundProxyRoute;
}

const resolveHostname = (hostname: string) => lookup(hostname, { all: true, verbatim: true });
const acceptAddresses = () => undefined;
const MAX_CACHED_DISPATCHERS = 16;
const dispatchers = new Map<string, Dispatcher>();

function dispatcherFor(route: UserOutboundProxyRoute): Dispatcher {
  const key = createHash("sha256")
    .update(route.mode === "proxy" ? JSON.stringify([route.url, route.bypass]) : "direct")
    .digest("hex");
  const cached = dispatchers.get(key);
  if (cached) {
    dispatchers.delete(key);
    dispatchers.set(key, cached);
    return cached;
  }
  const dispatcher = createCheckedProxyDispatcherFor(
    resolveHostname,
    acceptAddresses,
    route.mode === "proxy"
      ? {
          httpProxy: route.url,
          httpsProxy: route.url,
          noProxy: route.bypass.join(","),
        }
      : {},
  );
  dispatchers.set(key, dispatcher);
  if (dispatchers.size > MAX_CACHED_DISPATCHERS) {
    const oldest = dispatchers.keys().next().value;
    if (oldest !== undefined && oldest !== key) {
      const evicted = dispatchers.get(oldest);
      dispatchers.delete(oldest);
      void evicted?.close().catch(() => undefined);
    }
  }
  return dispatcher;
}

/** A fetch scoped to one user. The route is resolved from the database on every model call. */
export function createUserProxyModelFetch(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  userId: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const route = await resolveUserProxyRoute(prisma, secrets, userId);
    return dispatcherFetch(input, {
      ...init,
      dispatcher: dispatcherFor(route),
    } as RequestInit & { dispatcher: Dispatcher });
  };
}

/**
 * Pi runtime transport resolver. A run without a verified user identity uses the
 * deployment-wide policy rather than borrowing somebody else's proxy.
 */
export function createUserProxyModelFetchResolver(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): (request: unknown, context: { userId?: string } | undefined) => typeof globalThis.fetch {
  const systemFetch = createProxyAwareModelFetch();
  return (_request, context) =>
    context?.userId ? createUserProxyModelFetch(prisma, secrets, context.userId) : systemFetch;
}
