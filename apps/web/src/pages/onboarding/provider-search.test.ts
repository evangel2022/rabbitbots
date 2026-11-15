import { describe, expect, it } from "vitest";
import { filterProviderChoices } from "./provider-search.js";

const choices = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "endpoint-preset:https://ollama.com/v1", label: "Ollama Cloud" },
  { value: "openai", label: "OpenAI API" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "anthropic", label: "Anthropic API" },
];

describe("filterProviderChoices", () => {
  it("matches names and provider/type values without case or surrounding whitespace", () => {
    expect(filterProviderChoices(choices, " OLLAMA ").map((choice) => choice.label)).toEqual([
      "Ollama Cloud",
    ]);
    expect(
      filterProviderChoices(choices, "openai-compatible").map((choice) => choice.label),
    ).toEqual(["OpenAI-compatible"]);
    expect(filterProviderChoices(choices, "deepseek").map((choice) => choice.label)).toEqual([
      "DeepSeek",
    ]);
  });

  it("returns an empty result when nothing matches", () => {
    expect(filterProviderChoices(choices, "not-a-provider")).toEqual([]);
  });

  it("clears the filter when the query is empty", () => {
    expect(filterProviderChoices(choices, "   ")).toEqual(choices);
  });
});
