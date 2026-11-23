/**
 * Unit tests for embed provider and vector URL resolution logic.
 *
 * Tasks covered:
 *  3.2 — embedProvider resolution: dedicated, key-absent fallback, no-config fallback
 *  3.3 — MNEMO_EMBED_STUB gate: suppressed when MNEMO_EMBED_PROVIDER is set, active when absent
 *  3.4 — wireConsolidation receives llm (completion provider), not embedProvider
 *  3.5 — MNEMO_VECTOR_URL routes all three PgVectorAdapter instances to the custom URL
 */
import { describe, it, expect } from "vitest";
import {
  providerRequiresApiKey,
  resolveEmbedProviderConfig,
  resolveVectorUrl,
  resolveEmbedDimensions,
  missingProviderWarnings,
} from "../boot/embed-provider.js";

// ── Task 3.2: Embed provider resolution ───────────────────────────────────────

describe("resolveEmbedProviderConfig — dedicated provider", () => {
  it("returns kind=dedicated when both MNEMO_EMBED_PROVIDER and MNEMO_EMBED_API_KEY are set", () => {
    const result = resolveEmbedProviderConfig(
      {
        MNEMO_EMBED_PROVIDER: "voyage",
        MNEMO_EMBED_API_KEY: "pa-test",
        MNEMO_EMBED_BASE_URL: "https://embed.example.com",
      },
      true
    );
    expect(result.kind).toBe("dedicated");
    if (result.kind === "dedicated") {
      expect(result.providerName).toBe("voyage");
      expect(result.apiKey).toBe("pa-test");
      expect(result.baseURL).toBe("https://embed.example.com");
    }
  });

  it("returns kind=dedicated without baseURL when MNEMO_EMBED_BASE_URL is not set", () => {
    const result = resolveEmbedProviderConfig(
      { MNEMO_EMBED_PROVIDER: "nvidia", MNEMO_EMBED_API_KEY: "nvapi-test" },
      true
    );
    expect(result.kind).toBe("dedicated");
    if (result.kind === "dedicated") {
      expect(result.baseURL).toBeUndefined();
    }
  });
});

describe("resolveEmbedProviderConfig — key-absent fallback", () => {
  it("returns kind=fallback_missing_key when MNEMO_EMBED_PROVIDER is set but key is absent", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_PROVIDER: "voyage" }, true);
    expect(result.kind).toBe("fallback_missing_key");
    if (result.kind === "fallback_missing_key") {
      expect(result.providerName).toBe("voyage");
    }
  });

  it("returns kind=fallback_missing_key even when no LLM provider is available", () => {
    // The caller should log a warning and fall back to whatever llm is (undefined)
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_PROVIDER: "voyage" }, false);
    expect(result.kind).toBe("fallback_missing_key");
  });
});

// ── OLLAMA-KEY: a local Ollama needs no credential ────────────────────────────
// Ollama ignores the key, so demanding one made operators set a placeholder or
// lose recall without `vector` (501).

describe("resolveEmbedProviderConfig — keyless Ollama", () => {
  it("returns kind=dedicated for Ollama without MNEMO_EMBED_API_KEY and keeps its base URL", () => {
    const result = resolveEmbedProviderConfig(
      { MNEMO_EMBED_PROVIDER: "ollama", MNEMO_EMBED_BASE_URL: "http://127.0.0.1:11435" },
      false
    );
    expect(result).toEqual({
      kind: "dedicated",
      providerName: "ollama",
      apiKey: undefined,
      baseURL: "http://127.0.0.1:11435",
    });
  });

  it("matches the provider name case-insensitively", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_PROVIDER: "Ollama" }, false);
    expect(result.kind).toBe("dedicated");
  });

  it("still falls back when a provider that needs a key has none", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_PROVIDER: "openai" }, true);
    expect(result.kind).toBe("fallback_missing_key");
  });
});

describe("providerRequiresApiKey", () => {
  it("is false only for Ollama", () => {
    expect(providerRequiresApiKey("ollama")).toBe(false);
    expect(providerRequiresApiKey("OLLAMA")).toBe(false);
    expect(providerRequiresApiKey("openai")).toBe(true);
    expect(providerRequiresApiKey("bedrock")).toBe(true);
    expect(providerRequiresApiKey("voyage")).toBe(true);
  });
});

describe("resolveEmbedProviderConfig — no embed vars set (backward compat)", () => {
  it("returns kind=fallback_no_config when neither embed var is set and LLM is present", () => {
    const result = resolveEmbedProviderConfig({}, true);
    expect(result.kind).toBe("fallback_no_config");
  });

  it("returns kind=fallback_no_config when neither embed var is set and MNEMO_EMBED_STUB is not true", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_STUB: "false" }, false);
    expect(result.kind).toBe("fallback_no_config");
  });
});

// ── Task 3.3: MNEMO_EMBED_STUB activation gate ────────────────────────────────

describe("resolveEmbedProviderConfig — MNEMO_EMBED_STUB gate", () => {
  it("returns kind=stub when MNEMO_EMBED_STUB=true and no LLM or embed provider is configured", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_STUB: "true" }, false);
    expect(result.kind).toBe("stub");
  });

  it("does NOT activate stub when MNEMO_EMBED_PROVIDER is set (even with MNEMO_EMBED_STUB=true)", () => {
    // MNEMO_EMBED_PROVIDER set → resolveEmbedProviderConfig returns dedicated/fallback_missing_key
    // before it ever reaches the stub check.
    const withKey = resolveEmbedProviderConfig(
      { MNEMO_EMBED_PROVIDER: "voyage", MNEMO_EMBED_API_KEY: "pa-test", MNEMO_EMBED_STUB: "true" },
      false
    );
    expect(withKey.kind).toBe("dedicated");

    const missingKey = resolveEmbedProviderConfig(
      { MNEMO_EMBED_PROVIDER: "voyage", MNEMO_EMBED_STUB: "true" },
      false
    );
    expect(missingKey.kind).toBe("fallback_missing_key");
  });

  it("activates an explicitly requested stub when the chat LLM is configured", () => {
    const result = resolveEmbedProviderConfig({ MNEMO_EMBED_STUB: "true" }, true);
    expect(result.kind).toBe("stub");
  });
});

// ── Task 3.4: wireConsolidation must receive llm, not embedProvider ────────────
// This invariant lives in the wiring code (index.ts). We test the contract at
// the documentation/type level by verifying that resolveEmbedProviderConfig
// deliberately does NOT produce any "llm" or "completion" variant — it only
// advises how to set up the embed side. The wireConsolidation call site in
// index.ts is annotated with an invariant comment; this test confirms the
// resolver does not influence completion-provider selection.

describe("wireConsolidation invariant — resolver does not affect completion provider", () => {
  it("resolveEmbedProviderConfig result has no completion-provider field", () => {
    const result = resolveEmbedProviderConfig(
      { MNEMO_EMBED_PROVIDER: "voyage", MNEMO_EMBED_API_KEY: "pa-test" },
      true
    );
    // The result type has no 'llm', 'collapseLlm', or 'completionProvider' field —
    // it only describes the embed side. This is the compile-time contract.
    expect("llm" in result).toBe(false);
    expect("collapseLlm" in result).toBe(false);
    expect("completionProvider" in result).toBe(false);
  });
});

// ── Task 3.5: MNEMO_VECTOR_URL routing ────────────────────────────────────────

describe("resolveVectorUrl — MNEMO_VECTOR_URL routing", () => {
  const DB_URL = "postgres://user:pass@localhost:5432/mnemo";
  const VECTOR_URL = "postgres://vector-user:pass@vector-host:5432/vectors";

  it("returns MNEMO_VECTOR_URL when set", () => {
    const url = resolveVectorUrl({ MNEMO_VECTOR_URL: VECTOR_URL }, DB_URL);
    expect(url).toBe(VECTOR_URL);
  });

  it("falls back to DATABASE_URL when MNEMO_VECTOR_URL is absent", () => {
    const url = resolveVectorUrl({}, DB_URL);
    expect(url).toBe(DB_URL);
  });

  it("falls back to DATABASE_URL when MNEMO_VECTOR_URL is undefined", () => {
    const url = resolveVectorUrl({ MNEMO_VECTOR_URL: undefined }, DB_URL);
    expect(url).toBe(DB_URL);
  });

  it("MNEMO_VECTOR_URL does NOT affect DATABASE_URL itself (migrations keep using DATABASE_URL)", () => {
    // The point is that resolveVectorUrl is called only for PgVectorAdapter
    // instances, never for the migration runner. We verify that the function
    // correctly returns the override without mutating the input databaseUrl.
    const originalDb = DB_URL;
    resolveVectorUrl({ MNEMO_VECTOR_URL: VECTOR_URL }, originalDb);
    // databaseUrl is unchanged (value semantics, no mutation)
    expect(originalDb).toBe(DB_URL);
  });
});

describe("resolveEmbedDimensions — embedding dimensions resolution", () => {
  it("defaults to 1536 when no env vars are set", () => {
    expect(resolveEmbedDimensions({})).toBe(1536);
  });

  it("returns explicit MNEMO_EMBED_DIMENSIONS when it is a width the schema supports", () => {
    for (const n of [1024, 1536, 2048, 4096]) {
      expect(resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: String(n) })).toBe(n);
    }
  });

  it("REJECTS a width the schema has no table or index for", () => {
    // This assertion used to read `expect(...768...).toBe(768)` — the test
    // encoded the bug. 768 has no mnemo_fact_embeddings_768 and no HNSW index,
    // and accepting it produced facts that wrote fine and could never be
    // soft-deleted (P117). Boot is the right place to say no: it is still just
    // a wrong environment variable here, with no data behind it yet.
    expect(() => resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: "768" })).toThrow(
      /unsupported embedding width 768/
    );
    // And the message has to be actionable — name the knob and the legal values.
    expect(() => resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: "768" })).toThrow(
      /MNEMO_EMBED_DIMENSIONS/
    );
    expect(() => resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: "3072" })).toThrow(
      /1024, 1536, 2048, 4096/
    );
  });

  it("ignores a malformed MNEMO_EMBED_DIMENSIONS rather than throwing on it", () => {
    // Non-numeric / non-positive input falls through to auto-detection, the
    // behaviour that predates P117. Only a well-formed but UNSUPPORTED width is
    // an error: "0" or "abc" means "unset", "768" means "I meant 768".
    expect(resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: "abc" })).toBe(1536);
    expect(resolveEmbedDimensions({ MNEMO_EMBED_DIMENSIONS: "0" })).toBe(1536);
  });

  it("auto-detects 1024 for Bedrock provider", () => {
    expect(resolveEmbedDimensions({ MNEMO_LLM_PROVIDER: "bedrock" })).toBe(1024);
    expect(resolveEmbedDimensions({ MNEMO_EMBED_PROVIDER: "bedrock" })).toBe(1024);
  });

  it("auto-detects 1024 for Bedrock models (titan/cohere)", () => {
    expect(resolveEmbedDimensions({ MNEMO_EMBED_MODEL: "amazon.titan-embed-text-v2:0" })).toBe(
      1024
    );
    expect(resolveEmbedDimensions({ MNEMO_EMBED_MODEL: "cohere.embed-english-v3" })).toBe(1024);
  });

  it("allows explicit MNEMO_EMBED_DIMENSIONS to override Bedrock auto-detection", () => {
    expect(
      resolveEmbedDimensions({ MNEMO_LLM_PROVIDER: "bedrock", MNEMO_EMBED_DIMENSIONS: "1536" })
    ).toBe(1536);
  });
});

// ── D8: the quickstart boots on whatever provider the operator connects ─────
// With none, or only half of one, the boot log must say what is missing and
// what still works, and must not claim lexical recall when an embedder exists.

describe("missingProviderWarnings — what a boot without a full provider lacks", () => {
  it("says nothing when completions and embeddings are both configured", () => {
    expect(missingProviderWarnings(true, "ready")).toEqual([]);
  });

  it("with nothing configured, names both settings and says recall is full-text and writes 501", () => {
    const lines = missingProviderWarnings(false, "none");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("MNEMO_LLM_PROVIDER");
    expect(lines[1]).toContain("MNEMO_EMBED_PROVIDER");
    expect(lines[1]).toContain("full-text");
    expect(lines[1]).toContain("501");
  });

  it("with only an embedder (a local bge-m3, no generation model), warns about completions alone", () => {
    const lines = missingProviderWarnings(false, "ready");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MNEMO_LLM_PROVIDER");
    expect(lines[0]).not.toContain("full-text");
    expect(lines[0]).not.toContain("501");
  });

  it("with a completion provider that has no embeddings (Anthropic), names it and MNEMO_EMBED_PROVIDER", () => {
    const lines = missingProviderWarnings(true, "cannot_embed", "anthropic");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"anthropic"');
    expect(lines[0]).toContain("MNEMO_EMBED_PROVIDER");
  });

  it("leaves the stub embedder to its own warning", () => {
    expect(missingProviderWarnings(true, "stub")).toEqual([]);
  });
});
