/**
 * P111 — GET /composition/inferences.
 *
 * The inference log had a writer and no reader. `compositionality.ts` appends an
 * entry on every derivation, and `materialiseInference` writes one atomically
 * with the derived fact, but `queryInferences` was implemented on every adapter
 * with no caller: "why does this fact exist?" had no answer outside the
 * database.
 *
 * `derivedId` is the filter that makes it a provenance tool rather than a dump,
 * so it gets its own guard.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { StorageAdapter, MnemoInferenceLogEntry } from "@mnemo-ai/types";
import { mountComposition } from "../routes/composition.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_inferencetest0000000001";
const WS_ID = "00000000-0000-0000-0000-000000000025";
const NOW = new Date("2026-08-12T00:00:00.000Z");

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes: [] }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

function fakeEntry(over: Partial<MnemoInferenceLogEntry> = {}): MnemoInferenceLogEntry {
  return {
    id: "inf-1",
    workspaceId: WS_ID,
    ruleId: "rule-1",
    inputFactIds: ["f-1", "f-2"],
    derivedKind: "fact",
    derivedId: "f-3",
    confidence: 0.8,
    rationale: "transitivity",
    createdAt: NOW,
    ...over,
  };
}

async function harness(queryInferences: StorageAdapter["queryInferences"]) {
  const deps = {
    core: { recall: async () => [] } as unknown as ServerDeps["core"],
    apiKeys: await makeKeyLookup(),
    embedModel: "text-embedding-3-small",
    storage: { queryInferences, findHiddenIds: async () => [] } as unknown as StorageAdapter,
  } as unknown as ServerDeps;
  return buildMountHarness(deps, [mountComposition]);
}

describe("GET /composition/inferences (P111)", () => {
  it("returns the log with dates serialised and optional fields preserved", async () => {
    const app = await harness((async () => ({
      items: [fakeEntry()],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    })) as StorageAdapter["queryInferences"]);

    const res = await app.request("/composition/inferences", { headers: authed() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; derivedId: string; rationale: string; createdAt: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]!.derivedId).toBe("f-3");
    expect(body.items[0]!.rationale).toBe("transitivity");
    expect(body.items[0]!.createdAt).toBe(NOW.toISOString());
  });

  it("passes derivedId through — the 'why does this fact exist?' query", async () => {
    let captured: Record<string, unknown> | undefined;
    const app = await harness((async (filter: unknown) => {
      captured = filter as Record<string, unknown>;
      return { items: [], total: 0, offset: 0, limit: 50, hasMore: false };
    }) as StorageAdapter["queryInferences"]);

    await app.request("/composition/inferences?derivedId=f-3", { headers: authed() });

    expect(captured!.derivedId).toBe("f-3");
    expect(captured!.workspaceId).toBe(WS_ID);
    // Absent filters must not travel as undefined keys.
    expect(captured).not.toHaveProperty("ruleId");
  });

  it("parses `since` into a Date rather than forwarding the raw string", async () => {
    let captured: Record<string, unknown> | undefined;
    const app = await harness((async (filter: unknown) => {
      captured = filter as Record<string, unknown>;
      return { items: [], total: 0, offset: 0, limit: 50, hasMore: false };
    }) as StorageAdapter["queryInferences"]);

    await app.request("/composition/inferences?since=2026-08-01T00%3A00%3A00.000Z", {
      headers: authed(),
    });

    expect(captured!.since).toBeInstanceOf(Date);
  });
});
