import { describe, expect, it } from "vitest";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider.js";
import { listPiCatalog } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

const requiredNative = ["deepseek", "openai", "anthropic", "google", "openrouter"] as const;
const compatibleExtras = ["minimax", "moonshotai", "zai"] as const;

describe("provider capability matrix", () => {
  it("keeps the required native providers in the catalog", () => {
    const catalog = listPiCatalog();
    for (const provider of requiredNative) {
      const models = catalog.filter((entry) => entry.provider === provider);
      expect(models.length, provider).toBeGreaterThan(0);
      expect(
        models.some((entry) => entry.images),
        `${provider} vision`,
      ).toBe(true);
      expect(
        models.some((entry) => entry.reasoning),
        `${provider} reasoning`,
      ).toBe(true);
    }
  });

  it("keeps the custom and local connection paths available", () => {
    const catalog = listPiCatalog();
    expect(catalog.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID)).toBe(true);
    expect(LOCAL_PROVIDER_ID).toBe("local");
  });

  it("lists native adapters for MiniMax, Moonshot/Kimi and Z.AI/GLM", () => {
    const providers = new Set(listPiCatalog().map((entry) => entry.provider));
    for (const provider of compatibleExtras) expect(providers.has(provider), provider).toBe(true);
  });
});
