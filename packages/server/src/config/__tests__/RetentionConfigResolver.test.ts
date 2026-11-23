import { describe, it, expect, beforeEach } from "vitest";
import { RetentionConfigResolver } from "../RetentionConfigResolver.js";
import { GLOBAL_SENTINEL_ID } from "../WorkspaceConfigStore.js";
import type { WorkspaceConfigStore } from "../WorkspaceConfigStore.js";
import type { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

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
  };
}

/** Fake keyRing — no real crypto, stores values with ENC: prefix. */
function makeKms(): KeyRingAdapter {
  return {
    encryptSecret(_wsId: string, _ctx: string, plaintext: string): string {
      return `ENC:${plaintext}`;
    },
    decryptSecret(_wsId: string, _ctx: string, blob: string): string {
      if (!blob.startsWith("ENC:")) throw new Error("bad blob");
      return blob.slice(4);
    },
  } as unknown as KeyRingAdapter;
}

const BOOT_DEFAULTS = {
  internalDays: 730,
  confidentialDays: 365,
  restrictedDays: 90,
  transcriptDays: 30,
};

const WS_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RetentionConfigResolver", () => {
  beforeEach(() => {
    delete process.env["MNEMO_RETENTION_CONFIG_TTL_SECONDS"];
  });

  // 1. Env tier: no workspace row, no global row → bootConfig with source "env"
  it("returns bootConfig with source:env when no DB rows exist", async () => {
    const store = makeStore();
    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);

    const result = await resolver.resolve(WS_ID);

    expect(result.internalDays).toBe(730);
    expect(result.confidentialDays).toBe(365);
    expect(result.restrictedDays).toBe(90);
    expect(result.source).toBe("env");
  });

  // 2. Global tier: global row present → returns global values with source "global"
  it("returns global values with source:global when global sentinel row exists", async () => {
    const rows = new Map<string, string>([
      [`${GLOBAL_SENTINEL_ID}/retention_internal_days`, "ENC:500"],
      [`${GLOBAL_SENTINEL_ID}/retention_confidential_days`, "ENC:180"],
      [`${GLOBAL_SENTINEL_ID}/retention_restricted_days`, "ENC:60"],
    ]);
    const store = makeStore(rows);
    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);

    const result = await resolver.resolve(WS_ID);

    expect(result.internalDays).toBe(500);
    expect(result.confidentialDays).toBe(180);
    expect(result.restrictedDays).toBe(60);
    expect(result.source).toBe("global");
  });

  // 3. Workspace tier: workspace row present → returns workspace values with source "workspace"
  it("returns workspace values with source:workspace when workspace row exists", async () => {
    const rows = new Map<string, string>([
      [`${WS_ID}/retention_internal_days`, "ENC:200"],
      [`${WS_ID}/retention_confidential_days`, "ENC:100"],
      [`${WS_ID}/retention_restricted_days`, "ENC:30"],
    ]);
    const store = makeStore(rows);
    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);

    const result = await resolver.resolve(WS_ID);

    expect(result.internalDays).toBe(200);
    expect(result.confidentialDays).toBe(100);
    expect(result.restrictedDays).toBe(30);
    expect(result.source).toBe("workspace");
  });

  // 4. Partial workspace override: only internalDays set → internalDays from workspace, others from env
  it("supports partial override: workspace internalDays overrides, others fall through to env", async () => {
    const rows = new Map<string, string>([
      [`${WS_ID}/retention_internal_days`, "ENC:999"],
      // No confidentialDays or restrictedDays for workspace
    ]);
    const store = makeStore(rows);
    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);

    const result = await resolver.resolve(WS_ID);

    expect(result.internalDays).toBe(999);
    expect(result.confidentialDays).toBe(365); // from env
    expect(result.restrictedDays).toBe(90); // from env
    expect(result.source).toBe("workspace");
  });

  // 5. Cache hit within TTL: resolver called twice, store.get called only once per key set
  it("returns cached result on second call within TTL (no extra DB reads)", async () => {
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get() {
        callCount++;
        return null;
      },
      async set() {},
      async delete() {},
    };

    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);
    await resolver.resolve(WS_ID);
    const countAfterFirst = callCount;
    await resolver.resolve(WS_ID);

    // No additional DB calls — cache hit
    expect(callCount).toBe(countAfterFirst);
  });

  // 6. Cache invalidation: after invalidate(workspaceId), next resolve hits DB again
  it("forces a fresh DB read after invalidate(workspaceId)", async () => {
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get() {
        callCount++;
        return null;
      },
      async set() {},
      async delete() {},
    };

    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);
    await resolver.resolve(WS_ID);
    const countBefore = callCount;

    resolver.invalidate(WS_ID);
    await resolver.resolve(WS_ID);

    expect(callCount).toBeGreaterThan(countBefore);
  });

  // 7. invalidate also evicts GLOBAL_SENTINEL_ID from cache
  it("invalidate() also evicts GLOBAL_SENTINEL_ID from cache", async () => {
    let callCount = 0;
    const store: WorkspaceConfigStore = {
      async get() {
        callCount++;
        return null;
      },
      async set() {},
      async delete() {},
    };

    const resolver = new RetentionConfigResolver(store, makeKms(), BOOT_DEFAULTS);

    // Prime cache for both workspace and global sentinel
    await resolver.resolve(WS_ID);
    await resolver.resolve(GLOBAL_SENTINEL_ID);
    const countBefore = callCount;

    resolver.invalidate(WS_ID);

    // Resolving GLOBAL_SENTINEL_ID after invalidation should hit DB again
    await resolver.resolve(GLOBAL_SENTINEL_ID);
    expect(callCount).toBeGreaterThan(countBefore);
  });
});

describe("managed transcript retention window", () => {
  beforeEach(() => {
    delete process.env["MNEMO_RETENTION_CONFIG_TTL_SECONDS"];
  });

  it("falls back to the boot default when no row sets it", async () => {
    const resolver = new RetentionConfigResolver(makeStore(), makeKms(), BOOT_DEFAULTS);
    const result = await resolver.resolve(WS_ID);
    expect(result.transcriptDays).toBe(30);
    expect(result.source).toBe("env");
  });

  it("resolves the workspace window over the global one", async () => {
    const rows = new Map([
      [`${GLOBAL_SENTINEL_ID}/retention_transcript_days`, "ENC:14"],
      [`${WS_ID}/retention_transcript_days`, "ENC:7"],
    ]);
    const resolver = new RetentionConfigResolver(makeStore(rows), makeKms(), BOOT_DEFAULTS);
    expect((await resolver.resolve(WS_ID)).transcriptDays).toBe(7);
  });

  it("falls through per field, so a workspace that only narrows transcripts keeps the rest", async () => {
    const rows = new Map([[`${WS_ID}/retention_transcript_days`, "ENC:3"]]);
    const resolver = new RetentionConfigResolver(makeStore(rows), makeKms(), BOOT_DEFAULTS);
    const result = await resolver.resolve(WS_ID);
    expect(result).toMatchObject({ transcriptDays: 3, internalDays: 730, restrictedDays: 90 });
  });

  it("ignores a non-positive stored window rather than deleting transcripts immediately", async () => {
    const rows = new Map([[`${WS_ID}/retention_transcript_days`, "ENC:0"]]);
    const resolver = new RetentionConfigResolver(makeStore(rows), makeKms(), BOOT_DEFAULTS);
    expect((await resolver.resolve(WS_ID)).transcriptDays).toBe(30);
  });
});
