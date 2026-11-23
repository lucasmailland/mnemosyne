import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMAdapter, LLMInput, LLMOutput } from "@mnemo-ai/types";
import {
  buildWorkspaceLlmAdapter,
  completionFallsBackToEmbedProvider,
  toFinishReason,
} from "../WorkspaceLlmAdapter.js";
import { LlmConfigResolver } from "../LlmConfigResolver.js";
import { GLOBAL_SENTINEL_ID } from "../WorkspaceConfigStore.js";
import type { WorkspaceConfigStore } from "../WorkspaceConfigStore.js";
import type { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import type { LLMProviderLike } from "../../deps.js";

// The DB tiers build their provider through createProvider; this double records
// which model each DB-configured provider was built with.
vi.mock("@mnemo-ai/llm-providers", () => ({
  createProvider: vi.fn(({ provider, model }: { provider: string; model?: string }) => ({
    name: provider,
    embed: async () => [0],
    complete: vi.fn(async (input: { model?: string }) => ({
      text: "from-db-provider",
      tokensIn: 1,
      tokensOut: 1,
      model: input.model ?? model ?? "db-provider-default",
      provider,
    })),
  })),
}));

describe("WorkspaceLlmAdapter finishReason", () => {
  it("maps vendor stop reasons onto the port's union", () => {
    expect(toFinishReason("max_tokens")).toBe("length");
    expect(toFinishReason("length")).toBe("length");
    expect(toFinishReason("tool_use")).toBe("tool_use");
    expect(toFinishReason("end_turn")).toBe("stop");
    expect(toFinishReason(undefined)).toBe("stop");
  });

  it("reports a Bedrock reply cut at maxTokens as truncated", async () => {
    const resolver = {
      resolve: async () => ({
        provider: {
          complete: async () => ({
            text: '{"goal": "dep',
            tokensIn: 1,
            tokensOut: 2048,
            model: "haiku",
            provider: "bedrock",
            finishReason: "max_tokens",
          }),
        },
      }),
    } as unknown as LlmConfigResolver;
    const adapter = await buildWorkspaceLlmAdapter("ws", resolver, undefined);
    const out = await adapter!.generate({ messages: [{ role: "user", content: "x" }] });
    expect(out.finishReason).toBe("length");
  });
});

describe("buildWorkspaceLlmAdapter — stable identity per resolved provider", () => {
  // remember() pauses its write-time classifier per adapter object after a
  // failure (WP-7). A new wrapper per request would defeat the pause, so the
  // same cached provider must come back as the same adapter object.
  it("returns the same adapter for the same provider and a new one for another", async () => {
    const make = () => ({
      complete: async () => ({ text: "ok", tokensIn: 1, tokensOut: 1, model: "m", provider: "p" }),
    });
    let provider = make();
    const resolver = {
      resolve: async () => ({ provider, source: "workspace" }),
    } as unknown as LlmConfigResolver;
    const a = await buildWorkspaceLlmAdapter("ws", resolver, undefined);
    const b = await buildWorkspaceLlmAdapter("ws", resolver, undefined);
    expect(a).toBe(b);
    provider = make();
    const c = await buildWorkspaceLlmAdapter("ws", resolver, undefined);
    expect(c).not.toBe(a);
  });
});

// ── LIFECYCLE-1 / CHAOS-6 / AGENTSIM-2 (P157) ─────────────────────────────────
// With MNEMO_MASTER_KEY set, every workspace completion (collapse, capture,
// conflict validator, anticipation) goes through buildWorkspaceLlmAdapter. With
// no DB config the resolver's env tier is the boot EMBEDDING provider, and its
// complete() ran on that provider's built-in default model (Ollama `llama3.3`,
// Bedrock Haiku), ignoring MNEMO_LLM_PROVIDER and MNEMO_LLM_MODEL.

const WS = "11111111-1111-1111-1111-111111111111";
const INPUT: LLMInput = { messages: [{ role: "user", content: "extract" }] };

function makeStore(rows: Map<string, string> = new Map()): WorkspaceConfigStore {
  return {
    async get(workspaceId, key) {
      return rows.get(`${workspaceId}/${key}`) ?? null;
    },
    async set(workspaceId, key, valueEnc) {
      rows.set(`${workspaceId}/${key}`, valueEnc);
    },
    async delete(workspaceId, key) {
      rows.delete(`${workspaceId}/${key}`);
    },
    async getMany(workspaceId, keys) {
      const out = new Map<string, string>();
      for (const key of keys) {
        const v = rows.get(`${workspaceId}/${key}`);
        if (v !== undefined) out.set(key, v);
      }
      return out;
    },
    async replaceGroup(workspaceId, group, values) {
      for (const key of group) rows.delete(`${workspaceId}/${key}`);
      for (const [key, v] of Object.entries(values)) rows.set(`${workspaceId}/${key}`, v);
    },
  };
}

const kms = {
  encryptSecret: (_ws: string, _ctx: string, plaintext: string) => `ENC:${plaintext}`,
  decryptSecret: (_ws: string, _ctx: string, blob: string) => blob.slice(4),
} as unknown as KeyRingAdapter;

/** An embedding provider that can also complete — Ollama and Bedrock both can. */
function makeEmbedProvider() {
  const complete = vi.fn(async (input: { model?: string }) => ({
    text: "from-embed-provider",
    tokensIn: 1,
    tokensOut: 1,
    model: input.model ?? "llama3.3",
    provider: "ollama",
  }));
  const provider = { name: "ollama", embed: async () => [0], complete };
  return { provider: provider as unknown as LLMProviderLike, complete };
}

/** The boot completion adapter: MNEMO_LLM_PROVIDER + MNEMO_LLM_MODEL. */
function makeBootAdapter(model = "configured-llm-model") {
  const generate = vi.fn(async (): Promise<LLMOutput> => ({
    content: "from-boot-adapter",
    tokensUsed: { input: 1, output: 1 },
    model,
    finishReason: "stop",
  }));
  const adapter = { id: "boot", model, generate } as unknown as LLMAdapter;
  return { adapter, generate };
}

describe("buildWorkspaceLlmAdapter — completion provider selection", () => {
  beforeEach(() => {
    delete process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"];
  });

  it("uses the boot completion adapter (MNEMO_LLM_*) when the workspace has no DB config", async () => {
    const embed = makeEmbedProvider();
    const boot = makeBootAdapter();
    const resolver = new LlmConfigResolver(makeStore(), kms, embed.provider, "bge-m3");

    const adapter = await buildWorkspaceLlmAdapter(WS, resolver, boot.adapter);
    const out = await adapter!.generate(INPUT);

    expect(out.model).toBe("configured-llm-model");
    expect(boot.generate).toHaveBeenCalledTimes(1);
    expect(embed.complete).not.toHaveBeenCalled();
  });

  it("keeps using the boot completion adapter on a cache hit", async () => {
    const embed = makeEmbedProvider();
    const boot = makeBootAdapter();
    const resolver = new LlmConfigResolver(makeStore(), kms, embed.provider, "bge-m3");

    await buildWorkspaceLlmAdapter(WS, resolver, boot.adapter);
    const adapter = await buildWorkspaceLlmAdapter(WS, resolver, boot.adapter);
    await adapter!.generate(INPUT);

    expect(boot.generate).toHaveBeenCalledTimes(1);
    expect(embed.complete).not.toHaveBeenCalled();
  });

  it("falls back to the embedding provider only when no completion adapter is configured", async () => {
    const embed = makeEmbedProvider();
    const resolver = new LlmConfigResolver(makeStore(), kms, embed.provider, "bge-m3");

    const adapter = await buildWorkspaceLlmAdapter(WS, resolver, undefined);
    const out = await adapter!.generate(INPUT);

    expect(out.content).toBe("from-embed-provider");
    expect(embed.complete).toHaveBeenCalledTimes(1);
  });

  it("lets a workspace DB config win over the boot adapter, with its own llmModel", async () => {
    const embed = makeEmbedProvider();
    const boot = makeBootAdapter();
    const rows = new Map([
      [`${WS}/llm_provider`, "ENC:ollama"],
      [`${WS}/llm_model`, "ENC:workspace-model"],
    ]);
    const resolver = new LlmConfigResolver(makeStore(rows), kms, embed.provider, "bge-m3");

    const adapter = await buildWorkspaceLlmAdapter(WS, resolver, boot.adapter);
    const out = await adapter!.generate(INPUT);

    expect(out.content).toBe("from-db-provider");
    expect(out.model).toBe("workspace-model");
    expect(boot.generate).not.toHaveBeenCalled();
    expect(embed.complete).not.toHaveBeenCalled();
  });

  it("lets the global DB config win over the boot adapter", async () => {
    const embed = makeEmbedProvider();
    const boot = makeBootAdapter();
    const rows = new Map([
      [`${GLOBAL_SENTINEL_ID}/llm_provider`, "ENC:ollama"],
      [`${GLOBAL_SENTINEL_ID}/llm_model`, "ENC:global-model"],
    ]);
    const resolver = new LlmConfigResolver(makeStore(rows), kms, embed.provider, "bge-m3");

    const adapter = await buildWorkspaceLlmAdapter(WS, resolver, boot.adapter);
    const out = await adapter!.generate(INPUT);

    expect(out.model).toBe("global-model");
    expect(boot.generate).not.toHaveBeenCalled();
  });
});

describe("completionFallsBackToEmbedProvider — boot diagnostic", () => {
  it("is true when there is no completion adapter and the embed provider can complete", () => {
    expect(completionFallsBackToEmbedProvider(undefined, makeEmbedProvider().provider)).toBe(true);
  });

  it("is false when MNEMO_LLM_* produced a completion adapter", () => {
    const embed = makeEmbedProvider().provider;
    expect(completionFallsBackToEmbedProvider(makeBootAdapter().adapter, embed)).toBe(false);
  });

  it("is false when the embed provider cannot complete or is absent", () => {
    const embedOnly = { embed: async () => [0] } as LLMProviderLike;
    expect(completionFallsBackToEmbedProvider(undefined, embedOnly)).toBe(false);
    expect(completionFallsBackToEmbedProvider(undefined, undefined)).toBe(false);
  });
});
