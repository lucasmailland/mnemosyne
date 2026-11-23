/**
 * autonomous-memory Requirement 1/4 — POST /recall best-effort stamps
 * metadata.lastRecallAt on the session named by the optional `sessionId`
 * field, via StorageAdapter.recordSessionRecall. Detached via setImmediate
 * (same discipline as recall-audit.test.ts's audit entry) — a bad id or a
 * storage failure must never fail the recall response itself.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_recallsessioncorrtest0001";
const WS_ID = "00000000-0000-0000-0000-000000000015";

function makeCoreDeps() {
  return { recall: async () => [] } as unknown as ServerDeps["core"];
}

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key001",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "public",
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed() {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" };
}

describe("POST /recall — session correlation (autonomous-memory Req 1/4)", () => {
  it("stamps recordSessionRecall when sessionId is supplied", async () => {
    const recordSessionRecall = vi.fn().mockResolvedValue(undefined);
    const storage = {
      appendAuditEntry: async () => {},
      getRelations: async () => [],
      recordCoRecallStdp: async () => {},
      recordSessionRecall,
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: makeMockCognitive(),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, sessionId: "ses_abc123" }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(recordSessionRecall).toHaveBeenCalledWith("ses_abc123", WS_ID);
  });

  it("does not call recordSessionRecall when sessionId is omitted", async () => {
    const recordSessionRecall = vi.fn().mockResolvedValue(undefined);
    const storage = {
      appendAuditEntry: async () => {},
      getRelations: async () => [],
      recordCoRecallStdp: async () => {},
      recordSessionRecall,
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: makeMockCognitive(),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5 }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(recordSessionRecall).not.toHaveBeenCalled();
  });

  it("a recordSessionRecall failure never fails the recall response", async () => {
    const recordSessionRecall = vi.fn().mockRejectedValue(new Error("db down"));
    const storage = {
      appendAuditEntry: async () => {},
      getRelations: async () => [],
      recordCoRecallStdp: async () => {},
      recordSessionRecall,
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: makeMockCognitive(),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, sessionId: "ses_bad" }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(recordSessionRecall).toHaveBeenCalled();
  });

  it("does not throw when storage has no recordSessionRecall method (optional port method)", async () => {
    const storage = {
      appendAuditEntry: async () => {},
      getRelations: async () => [],
      recordCoRecallStdp: async () => {},
      // recordSessionRecall intentionally absent
    } as unknown as StorageAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: makeMockCognitive(),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "auth module", topK: 5, sessionId: "ses_abc123" }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
  });
});
