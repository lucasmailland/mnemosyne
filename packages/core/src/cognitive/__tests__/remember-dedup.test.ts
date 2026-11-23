import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";

// ── Minimal fakes ─────────────────────────────────────────────────────────────

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    vector: {
      search: async () => [],
    },
    embed: {
      embedSingle: async () => new Float32Array(3).fill(0.1),
    },
    telemetry: {
      startSpan: () => ({ end: () => {} }),
    },
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {
      surpriseThreshold: 0, // always above threshold → never staged
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
    },
  } as never;
}

const auth: AuthContext = {
  workspaceId: "ws-test",
  actorId: "agent-1",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

describe("remember() — fact_hash dedup (Wave E8)", () => {
  it("upserts fact_hash on first remember", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const req = {
      workspaceId: "ws-test",
      kind: "fact" as const,
      content: "TypeScript is awesome",
      subject: "typescript",
    };

    await remember(ctx, req, auth);

    const hash = createHash("sha256")
      .update("typescript is awesome|typescript|fact")
      .digest("hex");
    const entry = await storage.lookupFactHash("ws-test", hash);
    expect(entry?.seenCount).toBe(1);
  });

  it("increments seenCount on duplicate remember", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage);
    const req = {
      workspaceId: "ws-test",
      kind: "fact" as const,
      content: "TypeScript is awesome",
      subject: "typescript",
    };

    await remember(ctx, req, auth);
    await remember(ctx, req, auth);

    const hash = createHash("sha256")
      .update("typescript is awesome|typescript|fact")
      .digest("hex");
    const entry = await storage.lookupFactHash("ws-test", hash);
    expect(entry?.seenCount).toBe(2);
  });
});
