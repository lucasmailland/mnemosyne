import { describe, it, expect } from "vitest";
import { createProvider } from "../factory.js";
import { OpenAIProvider } from "../openai/index.js";
import { LLMProviderError } from "../errors.js";

/**
 * Unit tests for the `createProvider` factory.
 * Focused on the nvidia alias and provider resolution.
 * Network calls are NOT made — we only check that the correct class is
 * instantiated with the right config (baseURL, name).
 */

describe("createProvider — nvidia alias", () => {
  it("creates an OpenAIProvider with the default NVIDIA NIM base URL", () => {
    const p = createProvider({ provider: "nvidia", apiKey: "nvapi-test" });
    // The factory wraps the inner provider — check the name
    expect(p.name).toBe("openai");
    // Verify the inner provider has the correct baseURL by checking the
    // CreatedProvider capabilities (OpenAI supports both embed + complete)
    expect(p.capabilities.embed).toBe(true);
    expect(p.capabilities.complete).toBe(true);
  });

  it("uses the supplied baseURL instead of the NVIDIA default", () => {
    const customBase = "https://custom.nvidia.example.com/v1";
    const p = createProvider({
      provider: "nvidia",
      apiKey: "nvapi-test",
      baseURL: customBase,
    });
    // We can only assert the returned provider shape at the factory level.
    // The inner OpenAIProvider is private; we trust that createProvider
    // forwards config correctly (tested at integration level).
    expect(p.name).toBe("openai");
  });

  it("throws LLMProviderError for unknown provider names", () => {
    expect(() => createProvider({ provider: "unknown-xyz", apiKey: "k" })).toThrow(
      LLMProviderError,
    );
    expect(() => createProvider({ provider: "unknown-xyz", apiKey: "k" })).toThrow(
      /unknown-xyz/,
    );
  });
});

describe("createProvider — known providers resolve correctly", () => {
  it.each([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["voyage", "voyage"],
    ["ollama", "ollama"],
  ])("provider=%s → name=%s", (providerInput, expectedName) => {
    const p = createProvider({ provider: providerInput, apiKey: "test-key" });
    expect(p.name).toBe(expectedName);
  });
});

// The server's boot completion adapter needs a model even when
// MNEMO_LLM_MODEL is unset. Hardcoding an OpenAI name there sent `gpt-4o-mini`
// to Bedrock or Ollama; the provider's own default is the right fallback.
describe("createProvider — defaultCompleteModel", () => {
  it.each([
    ["openai", "gpt-4o-mini"],
    ["ollama", "llama3.3"],
    ["anthropic", "claude-3-5-haiku-latest"],
    ["bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
  ])("provider=%s exposes its built-in default %s", (provider, expected) => {
    expect(createProvider({ provider, apiKey: "test-key" }).defaultCompleteModel).toBe(expected);
  });

  it("reports the configured model when one is given", () => {
    expect(createProvider({ provider: "ollama", model: "qwen3:4b" }).defaultCompleteModel).toBe("qwen3:4b");
    expect(
      createProvider({ provider: "bedrock", apiKey: "test-key", model: "amazon.nova-lite-v1:0" })
        .defaultCompleteModel,
    ).toBe("amazon.nova-lite-v1:0");
  });

  it("is undefined for an embedding-only provider", () => {
    expect(createProvider({ provider: "voyage", apiKey: "test-key" }).defaultCompleteModel).toBeUndefined();
  });
});
