import { ORPCError } from "@orpc/server";
import {
  applyOutboundProxyConfig,
  DEPLOYMENT_OUTBOUND_PROXY_RECORD,
  normalizeBypass,
  outboundProxyHasCredentials,
  outboundProxyHost,
  testOutboundProxy,
  validateOutboundProxyUrl,
} from "@rakazo/adapters";
import type { NetworkProxySettings, NetworkProxyTestResult } from "@rakazo/contracts";
import { Prisma, runAsSystem, withTransactionRetry } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

export type NetworkProxyDeps = Pick<RouterDeps, "prisma" | "secrets" | "env">;

type StoredProxy = { url: string; bypass: string[] };

const ENV_PROXY_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;

function envProxyUrl(): string | undefined {
  return ENV_PROXY_KEYS.map((key) => process.env[key]?.trim()).find(Boolean);
}

function envBypass(): string[] {
  const value = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function proxyView(
  mode: "direct" | "proxy" | null,
  stored: StoredProxy | null,
  envUrl: string | undefined,
): NetworkProxySettings {
  if (mode === "direct") {
    return {
      configured: true,
      mode: "direct",
      source: "saved",
      proxyHost: null,
      hasCredentials: false,
      bypass: [],
    };
  }
  if (mode === "proxy" && stored) {
    return {
      configured: true,
      mode: "proxy",
      source: "saved",
      proxyHost: outboundProxyHost(stored.url),
      hasCredentials: outboundProxyHasCredentials(stored.url),
      bypass: stored.bypass,
    };
  }
  if (envUrl) {
    return {
      configured: false,
      mode: "proxy",
      source: "environment",
      proxyHost: outboundProxyHost(envUrl),
      hasCredentials: outboundProxyHasCredentials(envUrl),
      bypass: envBypass(),
    };
  }
  return {
    configured: false,
    mode: "direct",
    source: "default",
    proxyHost: null,
    hasCredentials: false,
    bypass: [],
  };
}

async function readStored(
  deps: NetworkProxyDeps,
): Promise<{ mode: "direct" | "proxy" | null; stored: StoredProxy | null; cipher: string | null }> {
  const row = await runAsSystem("read the deployment's outbound proxy", () =>
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { outboundProxyMode: true, outboundProxyCipher: true },
    }),
  );
  const mode =
    row?.outboundProxyMode === "direct" || row?.outboundProxyMode === "proxy"
      ? row.outboundProxyMode
      : null;
  let stored: StoredProxy | null = null;
  if (mode === "proxy" && row?.outboundProxyCipher) {
    const plaintext = await deps.secrets.load(row.outboundProxyCipher, {
      recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD,
    });
    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (parsed && typeof parsed === "object") {
        const value = parsed as { url?: unknown; bypass?: unknown };
        if (typeof value.url === "string" && value.url.trim()) {
          stored = {
            url: validateOutboundProxyUrl(value.url),
            bypass: normalizeBypass(
              Array.isArray(value.bypass)
                ? value.bypass.filter((entry): entry is string => typeof entry === "string")
                : [],
            ),
          };
        }
      }
    } catch {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Saved proxy settings could not be read.",
      });
    }
    if (!stored) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Saved proxy settings could not be read.",
      });
    }
  }
  return { mode, stored, cipher: row?.outboundProxyCipher ?? null };
}

function encrypt(
  deps: NetworkProxyDeps,
  actor: { userId: string; spaceId: string },
  config: StoredProxy,
) {
  return deps.secrets.put(
    JSON.stringify(config),
    {
      operationId: "deployment-network-proxy",
      traceId: "deployment-network-proxy",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
    { recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD },
  );
}

export async function getNetworkProxySettings(
  deps: NetworkProxyDeps,
  actor: { userId: string; spaceId: string },
): Promise<NetworkProxySettings> {
  await requireAdmin(deps, actor.userId);
  const { mode, stored } = await readStored(deps);
  return proxyView(mode, stored, envProxyUrl());
}

export async function updateNetworkProxySettings(
  deps: NetworkProxyDeps,
  actor: { userId: string; spaceId: string },
  input: {
    mode: "direct" | "proxy";
    url?: string;
    bypass?: string[];
  },
): Promise<NetworkProxySettings> {
  await requireAdmin(deps, actor.userId);
  const existing = await readStored(deps);
  if (input.mode === "direct") {
    await runAsSystem("an admin clears the deployment outbound proxy", () =>
      deps.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", outboundProxyMode: "direct", outboundProxyCipher: null },
        update: { outboundProxyMode: "direct", outboundProxyCipher: null },
      }),
    );
    if (existing.cipher) {
      await deps.secrets
        .delete(existing.cipher, { recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD })
        .catch(() => undefined);
    }
    applyOutboundProxyConfig({ mode: "direct", bypass: [] });
    return proxyView("direct", null, envProxyUrl());
  }
  let url: string;
  try {
    url = validateOutboundProxyUrl(input.url?.trim() || existing.stored?.url || "");
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Proxy URL is invalid",
    });
  }
  let bypass: string[];
  try {
    bypass = normalizeBypass(input.bypass ?? existing.stored?.bypass ?? []);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Bypass hosts are invalid",
    });
  }
  const config = { url, bypass };
  const applied = { mode: "proxy" as const, url, bypass };
  const record = await encrypt(deps, actor, config);
  let replaced: string | null | undefined;
  try {
    replaced = await withTransactionRetry(() =>
      runAsSystem("an admin configures the deployment outbound proxy", () =>
        deps.prisma.$transaction(
          async (tx) => {
            const current = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { outboundProxyCipher: true },
            });
            await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: {
                id: "default",
                outboundProxyMode: "proxy",
                outboundProxyCipher: record.ciphertext,
              },
              update: {
                outboundProxyMode: "proxy",
                outboundProxyCipher: record.ciphertext,
              },
            });
            return current?.outboundProxyCipher;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      ),
    );
  } catch (error) {
    await deps.secrets
      .delete(record.ciphertext, { recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD })
      .catch(() => undefined);
    throw error;
  }
  if (replaced && replaced !== record.ciphertext) {
    await deps.secrets
      .delete(replaced, { recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD })
      .catch(() => undefined);
  }
  applyOutboundProxyConfig(applied);
  return proxyView("proxy", config, envProxyUrl());
}

export async function testNetworkProxy(
  deps: NetworkProxyDeps,
  actor: { userId: string; spaceId: string },
): Promise<NetworkProxyTestResult> {
  await requireAdmin(deps, actor.userId);
  const { mode, stored } = await readStored(deps);
  if (mode === "direct") return { ok: false, message: "No proxy is configured" };
  const url = mode === "proxy" ? stored?.url : envProxyUrl();
  if (!url) return { ok: false, message: "No proxy is configured" };
  return testOutboundProxy(url);
}
