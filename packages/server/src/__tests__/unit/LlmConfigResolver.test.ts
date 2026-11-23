import { describe, it, expect, vi, beforeEach } from "vitest";
import { LlmConfigResolver } from "../../config/LlmConfigResolver.js";
import { GLOBAL_SENTINEL_ID } from "../../config/WorkspaceConfigStore.js";
import type { WorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import type { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";
import type { LLMProviderLike } from "../../deps.js";

// --- Fakes ---

function makeStore(rows: Map<string, string> = new Map()): WorkspaceConfigStore {
  return {
    async get(workspaceId: string, key: string): Promise<string | null> {
      return rows.get(`${workspaceId}/${key}`) ?? null;
    },
    async set(workspaceId: string, key: string, valueEnc: string): Promise<void> {
      rows.set(`${workspaceId}/${key}`, valueEnc);
    },
    async delete(workspaceId: string, key: string): Promise<void> {
      rows.delete(`${workspaceId}/${key}`);
    },
    async getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const key of keys) {
        const v = rows.get(`${workspaceId}/${key}`);
        if (v !== undefined) out.set(key, v);
      }
      return out;
    },
    async replaceGroup(workspaceId, group, values): Promise<void> {
      for (const key of group) rows.delete(`${workspaceId}/${key}`);
      for (const [key, v] of Object.entries(values)) rows.set(`${workspaceId}/${key}`, v);
    },
  };
}

/** Fake keyRing that stores/retrieves values in plaintext (no real crypto). */
function makeKms(): Pick<KeyRingAdapter, "decryptSecret" | "encryptSecret"> {
  return {
    encryptSecret(_wsId: string, _ctx: string, plaintext: string): string {
      return `ENC:${plaintext}`;
    },
    decryptSecret(_wsId: string, _ctx: string, blob: string): string {
      if (!blob.startsWith("ENC:")) throw new Error("bad blob");
      return blob.slice(4);
    },
  };
}

function makeBootProvider(): LLMProviderLike {
  return {
    async embed(_text: string, _model: string): Promise<number[]> {
      return [1, 2, 3];
    },
  };
}

// Mock @mnemo-ai/llm-providers so we don't need the real package in unit tests.
vi.mock("@mnemo-ai/llm-providers", () => ({
  createProvider: vi.fn(({ provider, apiKey }: { provider: string; apiKey?: string }) => ({
    name: provider,
    embed: async (_text: string, _model: string) => [4, 5, 6],
    _apiKey: apiKey,
  })),
}));

const BOOT_EMBED_MODEL = "text-embedding-3-small";

describe("LlmConfigResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"];
  });

  it("returns boot provider when no DB config exists", async () => {
    const store = makeStore();
    const kms = makeKms() as unknown as KeyRingAdapter;
    const boot = makeBootProvider();
    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);

    const result = await resolver.resolve("ws-no-config");
    expect(result.provider).toBe(boot);
    expect(result.embedModel).toBe(BOOT_EMBED_MODEL);
  });

  it("returns null provider when no DB config and no boot provider", async () => {
    const store = makeStore();
    const kms = makeKms() as unknown as KeyRingAdapter;
    const resolver = new LlmConfigResolver(store, kms, undefined, BOOT_EMBED_MODEL);

    const result = await resolver.resolve("ws-no-provider");
    expect(result.provider).toBeNull();
    expect(result.embedModel).toBe(BOOT_EMBED_MODEL);
  });

  it("returns workspace DB config when workspace row exists", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const wsId = "ws-with-config";
    const rows = new Map<string, string>([
      [`${wsId}/llm_provider`, "ENC:openai"],
      [`${wsId}/llm_api_key`, "ENC:sk-test-key"],
    ]);
    const store = makeStore(rows);
    const boot = makeBootProvider();
    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);

    const result = await resolver.resolve(wsId);
    expect(result.provider).not.toBeNull();
    // The fake createProvider would have been called with provider='openai'
    expect((result.provider as { name: string }).name).toBe("openai");
  });

  it("falls back to global sentinel when workspace row is absent", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const rows = new Map<string, string>([
      [`${GLOBAL_SENTINEL_ID}/llm_provider`, "ENC:voyage"],
      [`${GLOBAL_SENTINEL_ID}/llm_api_key`, "ENC:voy-global-key"],
    ]);
    const store = makeStore(rows);
    const boot = makeBootProvider();
    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);

    const result = await resolver.resolve("ws-no-row");
    expect(result.provider).not.toBeNull();
    expect((result.provider as { name: string }).name).toBe("voyage");
  });

  it("cache hit within TTL: second resolve() skips DB (store.get not called again)", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const boot = makeBootProvider();
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get(_wsId, _key) {
        callCount++;
        return null;
      },
      async getMany() {
        callCount++;
        return new Map();
      },
      async set() {},
      async delete() {},
      async replaceGroup() {},
    };

    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);
    await resolver.resolve("ws-cache-test");
    const countAfterFirst = callCount;
    await resolver.resolve("ws-cache-test");
    // Same call count — cache hit, no additional DB calls
    expect(callCount).toBe(countAfterFirst);
  });

  it("cache miss after TTL: fresh DB lookup is performed", async () => {
    process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"] = "0"; // effectively instant expiry
    const kms = makeKms() as unknown as KeyRingAdapter;
    const boot = makeBootProvider();
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get(_wsId, _key) {
        callCount++;
        return null;
      },
      async getMany() {
        callCount++;
        return new Map();
      },
      async set() {},
      async delete() {},
      async replaceGroup() {},
    };

    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);
    await resolver.resolve("ws-ttl-test");
    const countAfterFirst = callCount;
    // Wait 1ms — with TTL=0 the entry is immediately stale
    await new Promise((r) => setTimeout(r, 1));
    await resolver.resolve("ws-ttl-test");
    // New DB calls issued
    expect(callCount).toBeGreaterThan(countAfterFirst);
  });

  it("invalidate() clears the workspace entry causing a fresh lookup", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const boot = makeBootProvider();
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get(_wsId, _key) {
        callCount++;
        return null;
      },
      async getMany() {
        callCount++;
        return new Map();
      },
      async set() {},
      async delete() {},
      async replaceGroup() {},
    };

    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL);
    await resolver.resolve("ws-invalidate-test");
    const countBefore = callCount;
    resolver.invalidate("ws-invalidate-test");
    await resolver.resolve("ws-invalidate-test");
    expect(callCount).toBeGreaterThan(countBefore);
  });
});

// ── Which tier answered (P157) and why a tier was skipped (LIFECYCLE-2) ──────

describe("LlmConfigResolver — source and lookup diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"];
  });

  function makeLogger() {
    return { warn: vi.fn() };
  }

  it("reports source=env, workspace or global for the tier that answered", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const rows = new Map<string, string>([
      ["ws-own/llm_provider", "ENC:ollama"],
      [`${GLOBAL_SENTINEL_ID}/llm_provider`, "ENC:ollama"],
    ]);
    const withGlobal = new LlmConfigResolver(
      makeStore(rows),
      kms,
      makeBootProvider(),
      BOOT_EMBED_MODEL
    );
    expect((await withGlobal.resolve("ws-own")).source).toBe("workspace");
    expect((await withGlobal.resolve("ws-other")).source).toBe("global");

    const empty = new LlmConfigResolver(makeStore(), kms, makeBootProvider(), BOOT_EMBED_MODEL);
    expect((await empty.resolve("ws-none")).source).toBe("env");
    // Cached entries keep their source.
    expect((await empty.resolve("ws-none")).source).toBe("env");
  });

  it("warns, without the config values, when a tier lookup fails, then falls back", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const logger = makeLogger();
    const store: WorkspaceConfigStore = {
      async get() {
        throw new Error('invalid input syntax for type uuid: ""');
      },
      async getMany() {
        throw new Error('invalid input syntax for type uuid: ""');
      },
      async set() {},
      async delete() {},
      async replaceGroup() {},
    };
    const boot = makeBootProvider();
    const resolver = new LlmConfigResolver(store, kms, boot, BOOT_EMBED_MODEL, logger);

    const result = await resolver.resolve("ws-broken");

    expect(result.provider).toBe(boot);
    expect(result.source).toBe("env");
    // One warning per tier (workspace row, then global row).
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const [fields, msg] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toContain("llm_config_resolver.lookup_failed");
    expect(fields).toMatchObject({
      workspaceId: "ws-broken",
      stage: "read",
      error: 'invalid input syntax for type uuid: ""',
    });
  });

  it("does not echo the error message when a stored value fails to decode", async () => {
    const logger = makeLogger();
    const kms = {
      decryptSecret(_ws: string, _ctx: string, blob: string) {
        return blob.slice(4);
      },
    } as unknown as KeyRingAdapter;
    // Bedrock credentials that decrypt to something that is not JSON: V8's
    // SyntaxError message quotes the input, which here is a secret.
    const rows = new Map<string, string>([
      ["ws-bad/llm_provider", "ENC:bedrock"],
      ["ws-bad/llm_credentials", "ENC:AKIA-secret-not-json"],
    ]);
    const resolver = new LlmConfigResolver(
      makeStore(rows),
      kms,
      undefined,
      BOOT_EMBED_MODEL,
      logger
    );

    await resolver.resolve("ws-bad");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      workspaceId: "ws-bad",
      stage: "decode",
      errorName: "SyntaxError",
    });
    expect(JSON.stringify(fields)).not.toContain("AKIA-secret");
  });

  it("stays silent when there is simply no config row", async () => {
    const kms = makeKms() as unknown as KeyRingAdapter;
    const logger = makeLogger();
    const resolver = new LlmConfigResolver(
      makeStore(),
      kms,
      makeBootProvider(),
      BOOT_EMBED_MODEL,
      logger
    );

    await resolver.resolve("ws-none");

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ── Review round: invalidate() must win over a lookup already in flight ──────

describe("LlmConfigResolver — invalidation during a lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["MNEMO_LLM_CONFIG_TTL_SECONDS"];
  });

  it("does not let a lookup that started before invalidate() fill the cache", async () => {
    // A PUT commits and invalidates while a cold resolve is still reading the
    // previous config. Caching that read would serve the old config (an old
    // endpoint, an old key) for a whole TTL after the PUT answered 200.
    const kms = makeKms() as unknown as KeyRingAdapter;
    const base = makeStore(new Map([["ws-race/llm_provider", "ENC:ollama"]]));
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = async <T>(read: () => Promise<T>): Promise<T> => {
      reads++;
      if (reads === 1) await gate;
      return read();
    };
    const store = {
      ...base,
      get: (ws: string, key: string) => gated(() => base.get(ws, key)),
      getMany: (ws: string, keys: readonly string[]) => gated(() => base.getMany(ws, keys)),
    } as WorkspaceConfigStore;
    const resolver = new LlmConfigResolver(store, kms, makeBootProvider(), BOOT_EMBED_MODEL);

    const inFlight = resolver.resolve("ws-race");
    await new Promise((r) => setTimeout(r, 0));
    resolver.invalidate("ws-race");
    release();
    await inFlight;

    const readsBefore = reads;
    await resolver.resolve("ws-race");
    expect(reads).toBeGreaterThan(readsBefore);
  });
});
