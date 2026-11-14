import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveUserProxyRoute } from "./user-outbound-proxy.js";

const findUser = vi.fn();
const findDeployment = vi.fn();
const load = vi.fn();
const prisma = {
  userNetworkProxy: { findUnique: findUser },
  deploymentSettings: { findUnique: findDeployment },
};
const secrets = { load };

beforeEach(() => {
  vi.clearAllMocks();
  findDeployment.mockResolvedValue(null);
  findUser.mockResolvedValue(null);
});

describe("user outbound proxy resolution", () => {
  it("uses the signed-in user's custom route and never another user's row", async () => {
    findUser.mockResolvedValue({ mode: "custom", proxyCipher: "cipher" });
    load.mockResolvedValue(
      JSON.stringify({ url: "http://user:pass@proxy.example.test:3128", bypass: ["api.internal"] }),
    );
    await expect(
      resolveUserProxyRoute(prisma as never, secrets as never, "user-a"),
    ).resolves.toMatchObject({
      mode: "proxy",
      url: "http://user:pass@proxy.example.test:3128",
      bypass: expect.arrayContaining(["api.internal", "localhost"]),
    });
    expect(findUser).toHaveBeenCalledWith({
      where: { userId: "user-a" },
      select: expect.any(Object),
    });
  });

  it("honors direct without reading deployment or secrets", async () => {
    findUser.mockResolvedValue({ mode: "direct", proxyCipher: null });
    await expect(
      resolveUserProxyRoute(prisma as never, secrets as never, "user-a"),
    ).resolves.toEqual({
      mode: "direct",
    });
    expect(load).not.toHaveBeenCalled();
    expect(findDeployment).not.toHaveBeenCalled();
  });

  it("inherits the deployment route, including a saved deployment proxy", async () => {
    findDeployment.mockResolvedValue({
      outboundProxyMode: "proxy",
      outboundProxyCipher: "deployment",
    });
    load.mockResolvedValue(
      JSON.stringify({ url: "http://deployment.example.test:3128", bypass: [] }),
    );
    await expect(
      resolveUserProxyRoute(prisma as never, secrets as never, "user-b"),
    ).resolves.toMatchObject({
      mode: "proxy",
      url: "http://deployment.example.test:3128",
    });
  });

  it("fails closed when a saved custom route cannot be read", async () => {
    findUser.mockResolvedValue({ mode: "custom", proxyCipher: "bad" });
    load.mockResolvedValue("not-json");
    await expect(
      resolveUserProxyRoute(prisma as never, secrets as never, "user-a"),
    ).rejects.toThrow();
  });
});
