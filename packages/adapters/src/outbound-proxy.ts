import { lookup } from "node:dns/promises";
import type { SecretStore } from "@rakazo/adapter-kit";
import { isCloudMetadataHost, isLinkLocalAddress } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { Dispatcher } from "undici";
import { ProxyAgent, request } from "undici";
import { createCheckedProxyDispatcher } from "./proxy-dispatcher.js";
import { dispatcherFetch } from "./undici-fetch.js";

/** Secret record id owned by the deployment, so account deletion cannot remove it. */
export const DEPLOYMENT_OUTBOUND_PROXY_RECORD = "deployment-outbound-proxy";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

const baselineEnv = new Map<string, string | undefined>(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

// Keep the self-hosted stack's own links and loopback off the proxy unless an
// administrator removes them; public traffic still uses the proxy.
const DEFAULT_BYPASS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres",
  "supervisor",
  "api",
  "worker",
  "web",
];

export type OutboundProxyConfig = {
  mode: "direct" | "proxy";
  /** Full proxy URL, optionally carrying credentials. Never return or log this value. */
  url?: string;
  bypass: string[];
};

export class OutboundProxyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundProxyValidationError";
  }
}

function proxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundProxyValidationError("Proxy URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundProxyValidationError("Proxy URL must use http or https");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) throw new OutboundProxyValidationError("Proxy URL needs a host");
  if (isCloudMetadataHost(hostname) || isLinkLocalAddress(hostname)) {
    throw new OutboundProxyValidationError(
      "Proxy URL targets a blocked metadata or link-local host",
    );
  }
  return url;
}

export function validateOutboundProxyUrl(raw: string): string {
  return proxyUrl(raw).toString().replace(/\/$/, "");
}

/** Host:port only, never credentials. */
export function outboundProxyHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = proxyUrl(raw);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

export function outboundProxyHasCredentials(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function normalizeBypass(values: readonly string[] | undefined): string[] {
  const seen = new Set(DEFAULT_BYPASS);
  for (const value of values ?? []) {
    const entry = value.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes("/") || entry.includes(" ")) {
      throw new OutboundProxyValidationError("Bypass entries must be hostnames, not URLs");
    }
    seen.add(entry);
  }
  return [...seen];
}

/** Apply the saved choice to this process. Null restores the deployment's original environment. */
export function applyOutboundProxyConfig(config: OutboundProxyConfig | null): void {
  if (config === null) {
    for (const key of PROXY_ENV_KEYS) {
      const value = baselineEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return;
  }
  if (config.mode === "direct") {
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    return;
  }
  if (!config.url) throw new OutboundProxyValidationError("Proxy URL is required");
  const url = validateOutboundProxyUrl(config.url);
  const bypass = normalizeBypass(config.bypass).join(",");
  process.env.HTTP_PROXY = url;
  process.env.http_proxy = url;
  process.env.HTTPS_PROXY = url;
  process.env.https_proxy = url;
  process.env.NO_PROXY = bypass;
  process.env.no_proxy = bypass;
}

export type StoredOutboundProxy = {
  mode: "direct" | "proxy";
  url?: string;
  bypass: string[];
};

function parseStored(ciphertext: string): { url?: string; bypass?: unknown } {
  try {
    const value: unknown = JSON.parse(ciphertext);
    if (!value || typeof value !== "object") return {};
    const record = value as { url?: unknown; bypass?: unknown };
    return {
      url: typeof record.url === "string" ? record.url : undefined,
      bypass: record.bypass,
    };
  } catch {
    return {};
  }
}

function storedConfig(
  mode: string | null | undefined,
  ciphertext: string | null | undefined,
): StoredOutboundProxy | null {
  if (mode !== "direct" && mode !== "proxy") return null;
  if (mode === "direct") return { mode, bypass: [...DEFAULT_BYPASS] };
  if (!ciphertext) return null;
  const parsed = parseStored(ciphertext);
  if (!parsed.url) return null;
  return {
    mode,
    url: parsed.url,
    bypass: normalizeBypass(
      Array.isArray(parsed.bypass) ? parsed.bypass.filter((v) => typeof v === "string") : [],
    ),
  };
}

/** Load and apply the deployment's saved proxy. Null means the environment remains in charge. */
export async function loadAndApplyOutboundProxy(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): Promise<StoredOutboundProxy | null> {
  const row = await runAsSystem("read the deployment's outbound proxy", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { outboundProxyMode: true, outboundProxyCipher: true },
    }),
  );
  let config: StoredOutboundProxy | null = null;
  if (row?.outboundProxyMode === "proxy" && !row.outboundProxyCipher) {
    throw new OutboundProxyValidationError("Saved proxy settings are incomplete");
  }
  if (row?.outboundProxyMode === "proxy" && row.outboundProxyCipher) {
    const plaintext = await secrets.load(row.outboundProxyCipher, {
      recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD,
    });
    config = storedConfig("proxy", plaintext);
    // A secret that no longer decrypts must fail closed instead of silently using a different route.
    if (!config) throw new OutboundProxyValidationError("Saved proxy settings could not be read");
    applyOutboundProxyConfig(config);
    return config;
  }
  if (row?.outboundProxyMode === "direct") {
    applyOutboundProxyConfig({ mode: "direct", bypass: [] });
    return { mode: "direct", bypass: [...DEFAULT_BYPASS] };
  }
  applyOutboundProxyConfig(null);
  return config;
}

/** Effective deployment route, without applying it to the shared process environment. */
export type DeploymentOutboundProxyRoute =
  | { mode: "direct" }
  | { mode: "proxy"; url: string; bypass: string[] };

function environmentRoute(): DeploymentOutboundProxyRoute {
  const url =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY;
  if (!url) return { mode: "direct" };
  const bypass = (process.env.no_proxy ?? process.env.NO_PROXY ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return { mode: "proxy", url: validateOutboundProxyUrl(url), bypass: normalizeBypass(bypass) };
}

/** Read the deployment's effective proxy, including its environment fallback. */
export async function readDeploymentOutboundProxyConfig(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
): Promise<DeploymentOutboundProxyRoute> {
  const row = await runAsSystem("read the deployment's outbound proxy", () =>
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { outboundProxyMode: true, outboundProxyCipher: true },
    }),
  );
  if (row?.outboundProxyMode === "proxy" && !row.outboundProxyCipher) {
    throw new OutboundProxyValidationError("Saved proxy settings are incomplete");
  }
  if (row?.outboundProxyMode === "proxy" && row.outboundProxyCipher) {
    const plaintext = await secrets.load(row.outboundProxyCipher, {
      recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD,
    });
    const config = storedConfig("proxy", plaintext);
    if (!config?.url) {
      throw new OutboundProxyValidationError("Saved proxy settings could not be read");
    }
    return { mode: "proxy", url: config.url, bypass: config.bypass };
  }
  if (row?.outboundProxyMode === "direct") return { mode: "direct" };
  return environmentRoute();
}

/**
 * Native Pi providers do not all read HTTP(S)_PROXY themselves. The runtime accepts
 * this fetch as its model transport, so every provider request follows the same
 * checked proxy route as OpenAI-compatible and web traffic.
 */
export function createProxyAwareModelFetch(): typeof globalThis.fetch {
  const resolve = (hostname: string) => lookup(hostname, { all: true, verbatim: true });
  let dispatcher: Dispatcher | undefined;
  let fingerprint = "";
  const validate = () => undefined;
  return async (input, init) => {
    const next = [
      process.env.HTTP_PROXY,
      process.env.http_proxy,
      process.env.HTTPS_PROXY,
      process.env.https_proxy,
      process.env.NO_PROXY,
      process.env.no_proxy,
    ].join("\n");
    if (!dispatcher || next !== fingerprint) {
      const previous = dispatcher;
      dispatcher = createCheckedProxyDispatcher(resolve, validate);
      fingerprint = next;
      await previous?.close().catch(() => undefined);
    }
    return dispatcherFetch(input, {
      ...init,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  };
}

/** Test proxy reachability without exposing the URL or credentials in the result. */
export async function testOutboundProxy(url: string): Promise<{ ok: boolean; message: string }> {
  let target: string;
  try {
    target = validateOutboundProxyUrl(url);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Proxy URL is invalid",
    };
  }
  const dispatcher = new ProxyAgent(target);
  try {
    const response = await request("https://example.com/", {
      method: "HEAD",
      dispatcher,
      signal: AbortSignal.timeout(10_000),
    });
    await response.body.dump();
    return {
      ok: response.statusCode < 500,
      message:
        response.statusCode < 500
          ? "Proxy reachable"
          : `Proxy returned HTTP ${response.statusCode}`,
    };
  } catch {
    return { ok: false, message: "Could not reach the proxy" };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
