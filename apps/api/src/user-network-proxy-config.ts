import { ORPCError } from "@orpc/server";
import {
  normalizeBypass,
  outboundProxyHasCredentials,
  outboundProxyHost,
  readDeploymentOutboundProxyConfig,
  resolveUserProxyRoute,
  testOutboundProxy,
  USER_OUTBOUND_PROXY_RECORD_PREFIX,
  validateOutboundProxyUrl,
} from "@rakazo/adapters";
import type {
  UserNetworkProxySettings,
  UserNetworkProxyTestResult,
  UserNetworkProxyUpdate,
} from "@rakazo/contracts";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

export type UserProxyDeps = Pick<RouterDeps, "prisma" | "secrets" | "env">;

type StoredUserProxy = { url: string; bypass: string[] };

function recordId(userId: string) {
  return `${USER_OUTBOUND_PROXY_RECORD_PREFIX}:${userId}`;
}

function modeOf(value: string | null | undefined): "inherit" | "direct" | "custom" {
  return value === "direct" || value === "custom" ? value : "inherit";
}

async function userRow(deps: UserProxyDeps, userId: string) {
  return runAsSystem("read a user's outbound proxy", () =>
    deps.prisma.userNetworkProxy.findUnique({
      where: { userId },
      select: { mode: true, proxyCipher: true },
    }),
  );
}

function parseStored(plaintext: string): StoredUserProxy {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Saved user proxy settings could not be read.",
    });
  }
  if (!value || typeof value !== "object") {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Saved user proxy settings could not be read.",
    });
  }
  const record = value as { url?: unknown; bypass?: unknown };
  if (typeof record.url !== "string" || !record.url.trim()) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Saved user proxy settings could not be read.",
    });
  }
  try {
    return {
      url: validateOutboundProxyUrl(record.url),
      bypass: normalizeBypass(
        Array.isArray(record.bypass)
          ? record.bypass.filter((entry): entry is string => typeof entry === "string")
          : [],
      ),
    };
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message:
        error instanceof Error ? error.message : "Saved user proxy settings could not be read.",
    });
  }
}

async function view(deps: UserProxyDeps, userId: string): Promise<UserNetworkProxySettings> {
  const row = await userRow(deps, userId);
  const mode = modeOf(row?.mode);
  const deploymentRow = await runAsSystem("read the deployment's outbound proxy source", () =>
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { outboundProxyMode: true },
    }),
  );
  const effective = await resolveUserProxyRoute(deps.prisma, deps.secrets, userId);
  const deployment = await readDeploymentOutboundProxyConfig(deps.prisma, deps.secrets);
  const deploymentHost = deployment.mode === "proxy" ? outboundProxyHost(deployment.url) : null;
  const deploymentConfigured = deployment.mode === "proxy";
  if (mode === "direct") {
    return {
      mode,
      source: "direct",
      proxyHost: null,
      hasCredentials: false,
      bypass: [],
      deploymentProxyHost: deploymentHost,
      deploymentProxyConfigured: deploymentConfigured,
    };
  }
  if (mode === "custom") {
    if (effective.mode !== "proxy") {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Saved user proxy settings could not be read.",
      });
    }
    return {
      mode,
      source: "saved",
      proxyHost: outboundProxyHost(effective.url),
      hasCredentials: outboundProxyHasCredentials(effective.url),
      bypass: effective.bypass,
      deploymentProxyHost: deploymentHost,
      deploymentProxyConfigured: deploymentConfigured,
    };
  }
  return {
    mode,
    source:
      deployment.mode !== "proxy"
        ? "default"
        : deploymentRow?.outboundProxyMode === "proxy"
          ? "deployment"
          : "environment",
    proxyHost: deployment.mode === "proxy" ? outboundProxyHost(deployment.url) : null,
    hasCredentials:
      deployment.mode === "proxy" ? outboundProxyHasCredentials(deployment.url) : false,
    bypass: deployment.mode === "proxy" ? deployment.bypass : [],
    deploymentProxyHost: deploymentHost,
    deploymentProxyConfigured: deploymentConfigured,
  };
}

export async function getUserNetworkProxySettings(
  deps: UserProxyDeps,
  actor: { userId: string; spaceId: string },
): Promise<UserNetworkProxySettings> {
  return view(deps, actor.userId);
}

export async function updateUserNetworkProxySettings(
  deps: UserProxyDeps,
  actor: { userId: string; spaceId: string },
  input: UserNetworkProxyUpdate,
): Promise<UserNetworkProxySettings> {
  const existing = await userRow(deps, actor.userId);
  const nextMode = input.mode;
  let cipher: string | null = null;
  let config: StoredUserProxy | null = null;
  if (input.mode === "custom") {
    let url: string;
    try {
      let saved: StoredUserProxy | null = null;
      if (existing?.mode === "custom" && existing.proxyCipher) {
        saved = parseStored(
          await deps.secrets.load(existing.proxyCipher, { recordId: recordId(actor.userId) }),
        );
      }
      url = validateOutboundProxyUrl(input.url?.trim() || saved?.url || "");
      config = {
        url,
        bypass: normalizeBypass(input.bypass ?? saved?.bypass ?? []),
      };
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Proxy URL is invalid",
      });
    }
    const sealed = await deps.secrets.put(
      JSON.stringify(config),
      {
        operationId: "user-network-proxy",
        traceId: "user-network-proxy",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      },
      { recordId: recordId(actor.userId) },
    );
    cipher = sealed.ciphertext;
  } else {
    try {
      normalizeBypass(input.bypass ?? []);
    } catch (error) {
      throw new ORPCError("BAD_REQUEST", {
        message: error instanceof Error ? error.message : "Bypass hosts are invalid",
      });
    }
  }
  let replaced: string | null | undefined;
  try {
    replaced = await withTransactionRetry(() =>
      runAsSystem("save a user's outbound proxy", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.userNetworkProxy.findUnique({
              where: { userId: actor.userId },
              select: { proxyCipher: true },
            });
            await tx.userNetworkProxy.upsert({
              where: { userId: actor.userId },
              create: { userId: actor.userId, mode: nextMode, proxyCipher: cipher },
              update: { mode: nextMode, proxyCipher: cipher },
            });
            return current?.proxyCipher;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    if (cipher)
      await deps.secrets
        .delete(cipher, { recordId: recordId(actor.userId) })
        .catch(() => undefined);
    throw error;
  }
  if (replaced && replaced !== cipher) {
    await deps.secrets
      .delete(replaced, { recordId: recordId(actor.userId) })
      .catch(() => undefined);
  }
  return view(deps, actor.userId);
}

export async function testUserNetworkProxy(
  deps: UserProxyDeps,
  actor: { userId: string; spaceId: string },
): Promise<UserNetworkProxyTestResult> {
  const route = await resolveUserProxyRoute(deps.prisma, deps.secrets, actor.userId);
  if (route.mode === "direct") return { ok: false, message: "No proxy is configured" };
  return testOutboundProxy(route.url);
}
