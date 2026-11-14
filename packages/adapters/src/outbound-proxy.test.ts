import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOutboundProxyConfig,
  DEPLOYMENT_OUTBOUND_PROXY_RECORD,
  loadAndApplyOutboundProxy,
  normalizeBypass,
  OutboundProxyValidationError,
  outboundProxyHasCredentials,
  outboundProxyHost,
  validateOutboundProxyUrl,
} from "./outbound-proxy.js";

const keys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  applyOutboundProxyConfig(null);
});

describe("outbound proxy configuration", () => {
  it("validates HTTP proxy URLs and rejects blocked or non-HTTP destinations", () => {
    expect(validateOutboundProxyUrl("http://proxy.example.test:3128/")).toBe(
      "http://proxy.example.test:3128",
    );
    expect(() => validateOutboundProxyUrl("socks5://proxy.example.test:1080")).toThrow(
      OutboundProxyValidationError,
    );
    expect(() => validateOutboundProxyUrl("http://169.254.169.254/latest")).toThrow(
      /blocked metadata/,
    );
  });

  it("never exposes credentials through the saved view helpers", () => {
    const url = "http://user:secret@proxy.example.test:3128";
    expect(outboundProxyHost(url)).toBe("proxy.example.test:3128");
    expect(outboundProxyHost(url)).not.toContain("secret");
    expect(outboundProxyHasCredentials(url)).toBe(true);
    expect(outboundProxyHasCredentials("http://proxy.example.test:3128")).toBe(false);
  });

  it("adds loopback bypass defaults without dropping configured hosts", () => {
    expect(normalizeBypass(["models.internal", "localhost"])).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "postgres",
      "supervisor",
      "api",
      "worker",
      "web",
      "models.internal",
    ]);
    expect(() => normalizeBypass(["https://internal.example"])).toThrow(/hostnames/);
  });

  it("applies proxy and direct modes to the process environment", () => {
    applyOutboundProxyConfig({
      mode: "proxy",
      url: "http://proxy.example.test:3128",
      bypass: [".internal"],
    });
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.example.test:3128");
    expect(process.env.NO_PROXY).toContain(".internal");
    expect(process.env.NO_PROXY).toContain("localhost");

    applyOutboundProxyConfig({ mode: "direct", bypass: [] });
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("loads a saved encrypted proxy without returning its URL", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          outboundProxyMode: "proxy",
          outboundProxyCipher: "cipher",
        })),
      },
    };
    const secrets = {
      load: vi.fn(async () =>
        JSON.stringify({ url: "http://proxy.example.test:3128", bypass: ["api.internal"] }),
      ),
    };
    const loaded = await loadAndApplyOutboundProxy(prisma as never, secrets as never);
    expect(secrets.load).toHaveBeenCalledWith("cipher", {
      recordId: DEPLOYMENT_OUTBOUND_PROXY_RECORD,
    });
    expect(loaded).toMatchObject({
      mode: "proxy",
      bypass: [
        "localhost",
        "127.0.0.1",
        "::1",
        "postgres",
        "supervisor",
        "api",
        "worker",
        "web",
        "api.internal",
      ],
    });
    expect(JSON.stringify(loaded)).not.toContain("password");
    expect(process.env.HTTPS_PROXY).toBe("http://proxy.example.test:3128");
  });

  it("fails closed when a saved proxy cannot be read", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          outboundProxyMode: "proxy",
          outboundProxyCipher: "cipher",
        })),
      },
    };
    const secrets = { load: vi.fn(async () => "not-json") };
    await expect(loadAndApplyOutboundProxy(prisma as never, secrets as never)).rejects.toThrow(
      /could not be read/,
    );
  });
});
