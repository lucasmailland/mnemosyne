/**
 * §5 Audit trail — recall must produce an audit entry (deep re-audit P0-3).
 *
 * The recall path is the hottest path, so the audit entry is appended
 * best-effort and DETACHED (setImmediate). The test flushes the macrotask
 * queue before asserting. Regression target: before the fix, recall produced
 * NO audit entry at all (only create/delete were audited).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { AuditLogEntry, AuthAdapter, StorageAdapter } from "@mnemo-ai/types";
import { makeMockCognitive } from "./helpers/mockCognitive.js";

const PLAINTEXT_KEY = "mns_live_recallaudittest00000001";
const WS_ID = "00000000-0000-0000-0000-000000000015";

function makeCoreDeps() {
  return {
    recall: async () => [],
  } as unknown as ServerDeps["core"];
}

function makeStorageSpy() {
  const calls: Array<Omit<AuditLogEntry, "id" | "createdAt">> = [];
  const storage = {
    appendAuditEntry: async (entry: Omit<AuditLogEntry, "id" | "createdAt">) => {
      calls.push(entry);
    },
    getRelations: async () => [],
    recordCoRecallStdp: async () => {},
  } as unknown as StorageAdapter;
  return { storage, calls };
}

async function makeKeyLookup(
  scopes: string[] = ["memory:read", "memory:admin"]
): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key001",
        keyHash,
        workspaceId: WS_ID,
        scopes,
        maxSensitivity: "public",
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json", ...extra };
}

describe("§5 recall auditing (P0-3)", () => {
  it("POST /recall (lexical blend) appends a detached 'recall' audit entry", async () => {
    const { storage, calls } = makeStorageSpy();
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
      body: JSON.stringify({ query: "exfiltration probe", topK: 5 }),
    });
    expect(res.status).toBe(200);

    // Audit is detached via setImmediate — flush the macrotask queue.
    await new Promise((r) => setImmediate(r));

    const recallAudits = calls.filter((c) => c.action === "recall");
    expect(recallAudits).toHaveLength(1);
    expect(recallAudits[0]!.resourceKind).toBe("recall");
    expect(recallAudits[0]!.isTerminal).toBe(false);
    expect((recallAudits[0]!.detail as { topK: number }).topK).toBe(5);
    // §6: the recall audit must carry the actor origin threaded from the auth
    // context. Legacy mns_* keys are stamped 'user' by the auth middleware.
    expect(recallAudits[0]!.actorType).toBe("user");
  });

  it("POST /recall (v3 tiered) appends a detached 'recall' audit entry", async () => {
    const { storage, calls } = makeStorageSpy();
    const recall = vi.fn().mockResolvedValue({ hits: [] });
    const v3 = makeMockCognitive({ recall });
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: v3,
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "exfiltration probe", topK: 5 }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const recallAudits = calls.filter((c) => c.action === "recall");
    expect(recallAudits).toHaveLength(1);
    expect(recallAudits[0]!.resourceKind).toBe("recall");
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0]![1]).toEqual({
      workspaceId: WS_ID,
      actorId: "key:key001",
      actorType: "user",
      userId: null,
      scopes: ["memory:read", "memory:admin"],
      maxSensitivity: "public",
    });
  });

  it("passes scoped-key actor context and effective ceiling to v3 recall", async () => {
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "internal");
    const { storage } = makeStorageSpy();
    const recall = vi.fn().mockResolvedValue({ hits: [] });
    const scopedAuthAdapter = {
      id: "scoped-test",
      authenticate: vi.fn().mockResolvedValue({
        ok: true,
        context: {
          workspaceId: WS_ID,
          actorId: "peer-007",
          actorType: "federation",
          scopes: ["memory:read", "memory:admin"],
          keyType: "mk_fed_",
          maxSensitivity: "restricted",
        },
      }),
      authorize: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }),
    } as unknown as AuthAdapter;
    const deps = {
      core: makeCoreDeps(),
      apiKeys: await makeKeyLookup(),
      scopedAuthAdapter,
      embedModel: "text-embedding-3-small",
      storage,
      cognitive: makeMockCognitive({ recall }),
    } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });

    const res = await app.request("/recall", {
      method: "POST",
      headers: {
        authorization: "Bearer mk_fed_keyid001_secretsecretsecret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "federated context", topK: 5 }),
    });

    expect(res.status).toBe(200);
    expect(recall).toHaveBeenCalledOnce();
    expect(recall.mock.calls[0]![1]).toEqual({
      workspaceId: WS_ID,
      actorId: "key:peer-007",
      actorType: "federation",
      userId: null,
      scopes: ["memory:read", "memory:admin"],
      maxSensitivity: "internal",
    });
    vi.unstubAllEnvs();
  });

  describe("outer observation", () => {
    const hit = (id: string, sensitivity = "public") => ({
      id,
      primitive: "fact",
      content: "x".repeat(400),
      score: 0.9,
      sensitivity,
    });
    async function setup(
      recall: ReturnType<typeof vi.fn>,
      session: unknown = { id: "s1" },
      ports?: Record<string, unknown>,
      extraDeps: Record<string, unknown> = {}
    ) {
      const obs: Array<[Record<string, unknown>, Array<Record<string, unknown>>]> = [];
      const { storage } = makeStorageSpy();
      Object.assign(
        storage,
        { getSession: async () => session },
        ports ?? { recordRecallObservation: async (r: never, h: never) => void obs.push([r, h]) }
      );
      const apiKeys = await makeKeyLookup();
      const cognitive = makeMockCognitive({ recall });
      const deps = {
        core: makeCoreDeps(),
        apiKeys,
        storage,
        cognitive,
        ...extraDeps,
      } as unknown as ServerDeps;
      const app = createApp({ deps, version: "0.0.0-test" });
      const post = async (extra: object = {}, headers: Record<string, string> = {}) => {
        const res = await app.request("/recall", {
          method: "POST",
          headers: authed(headers),
          body: JSON.stringify({ query: "q", topK: 5, ...extra }),
        });
        await new Promise((r) => setImmediate(r)); // observation writes are detached
        return res;
      };
      return { obs, post, app, storage };
    }

    it("records one observation matching the compact, ceiling-filtered response", async () => {
      const resp = { hits: [hit("a"), hit("b", "restricted"), hit("c")], total: 3 };
      const { obs, post } = await setup(vi.fn().mockResolvedValue(resp));
      const res = await post({ projection: "compact" });
      const body = (await res.json()) as { hits: Array<{ id: string }> };
      expect(body.hits.map((h) => h.id)).toEqual(["a", "c"]);
      expect(obs).toHaveLength(1);
      expect(obs[0]![0].requestId).toBe(res.headers.get("x-request-id"));
      expect(obs[0]![1].map((h) => `${h.memoryId}${h.rank}`)).toEqual(["a0", "c1"]);
    });

    // APP-015: the observation records how much memory text the recall served
    // (the two hits under the ceiling, cut to 300 chars each by the compact
    // projection), so served
    // context can be reported and compared.
    it("records the characters of memory content it served", async () => {
      const resp = { hits: [hit("a"), hit("b", "restricted"), hit("c")], total: 3 };
      const { obs, post } = await setup(vi.fn().mockResolvedValue(resp));
      await post({ projection: "compact" });
      expect(obs[0]![0].servedChars).toBe(600);
    });

    it("asks core to skip only its own observation, keeping reinforcement/composition", async () => {
      const recall = vi.fn().mockResolvedValue({ hits: [hit("a")] });
      const { post } = await setup(recall);
      await post();
      expect(recall.mock.calls[0]![2]).toEqual({
        deferObservation: true,
        onRecallMeta: expect.any(Function),
      });
    });

    it("writes multi-level hits under their own workspace, never the caller's", async () => {
      const other = "00000000-0000-0000-0000-0000000000aa";
      const resp = { hits: [hit("a"), { ...hit("p"), _workspaceId: other }], total: 2 };
      const { obs, post } = await setup(vi.fn().mockResolvedValue(resp));
      await post({ sessionId: "s1" });
      const byWs = Object.fromEntries(obs.map(([r, h]) => [r.workspaceId as string, [r, h]]));
      expect(Object.keys(byWs).sort()).toEqual([WS_ID, other].sort());
      const [mainReq, mainHits] = byWs[WS_ID]!;
      const [otherReq, otherHits] = byWs[other]!;
      expect(mainHits.map((h: any) => [h.memoryId, h.rank, h.workspaceId])).toEqual([
        ["a", 0, WS_ID],
      ]);
      expect(otherHits.map((h: any) => [h.memoryId, h.rank, h.workspaceId])).toEqual([
        ["p", 1, other],
      ]);
      // The session was validated against the caller's workspace only.
      expect(mainReq).toMatchObject({ sessionId: "s1" });
      expect(otherReq).toMatchObject({ sessionId: null, sessionNullReason: "other_workspace" });
    });

    it("gives fact hits TD(λ) credit at their global rank and bounds the declared caller", async () => {
      const resp = { hits: [hit("a"), hit("b")], total: 2 };
      const { obs, post } = await setup(vi.fn().mockResolvedValue(resp));
      await post({}, { "x-mnemo-caller": "x".repeat(5000) });
      expect(obs[0]![1].map((h) => h.tdCredit)).toEqual([1, 0.7]);
      expect((obs[0]![0].declaredCaller as string).length).toBe(128);
    });

    it("records declared client/plugin versions and the real server version", async () => {
      const { obs, post } = await setup(vi.fn().mockResolvedValue({ hits: [hit("a")] }));
      await post({}, { "x-mnemo-client-version": "1.2.3", "x-mnemo-plugin-version": "0.9.0" });
      await post();
      expect(obs[0]![0]).toMatchObject({
        clientVersion: "1.2.3",
        pluginVersion: "0.9.0",
        serverVersion: "0.0.0-test",
      });
      expect(obs[1]![0]).toMatchObject({ clientVersion: "unknown", pluginVersion: "unknown" });
    });

    it("records core's measured tier, L3 cache hit and phase timings", async () => {
      const meta = { tiers: ["l3_cache"], cacheHit: true, phaseDurationsMs: { embedding: 3 } };
      const recall = vi.fn(async (_q: unknown, _a: unknown, o: any) => {
        o.onRecallMeta(meta);
        return { hits: [hit("a")] };
      });
      const { obs, post } = await setup(recall);
      await post();
      expect(obs[0]![0]).toMatchObject(meta);
    });

    it("falls back to legacy recordRecall when the observation port is absent", async () => {
      const recordRecall = vi.fn(async () => undefined);
      const resp = { hits: [{ ...hit("e"), primitive: "episode" }, hit("a")] };
      const { post } = await setup(vi.fn().mockResolvedValue(resp), { id: "s1" }, { recordRecall });
      expect((await post({ sessionId: "s1" })).status).toBe(200);
      expect(recordRecall.mock.calls).toEqual([
        [expect.objectContaining({ factId: "a", sessionId: "s1", hitRank: 1, tdCredit: 0.7 })],
      ]);
    });

    it("legacy fallback logs personal/tenant fact hits under their own workspace", async () => {
      const other = "00000000-0000-0000-0000-0000000000aa";
      const recordRecall = vi.fn(async (_e: unknown) => undefined);
      const resp = { hits: [hit("a"), { ...hit("p"), _workspaceId: other }] };
      const { post } = await setup(vi.fn().mockResolvedValue(resp), { id: "s1" }, { recordRecall });
      await post({ sessionId: "s1" });
      const entries = recordRecall.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(entries).toEqual([
        expect.objectContaining({ workspaceId: WS_ID, factId: "a", sessionId: "s1", hitRank: 0 }),
        expect.objectContaining({ workspaceId: other, factId: "p", hitRank: 1 }),
      ]);
      // The session was validated for the caller's workspace only.
      expect(entries[1]).not.toHaveProperty("sessionId");
    });

    it("hands the query text to fact-bearing observations only", async () => {
      const resp = { hits: [hit("a")] };
      const { obs, post } = await setup(vi.fn().mockResolvedValue(resp));
      await post();
      expect(obs[0]![0]).toMatchObject({ queryText: "q" });
      const none = await setup(vi.fn().mockResolvedValue({ hits: [] }));
      await none.post();
      expect(none.obs[0]![0]).not.toHaveProperty("queryText");
    });

    it("validates the session behind the storage breaker (open breaker fails fast)", async () => {
      const getSession = vi.fn(() => new Promise(() => {})); // stalled pool
      const open = { storageRead: () => Promise.reject(new Error("breaker open")) };
      const { post } = await setup(
        vi.fn().mockResolvedValue({ hits: [] }),
        null,
        { getSession },
        { circuitBreakers: open }
      );
      const status = await Promise.race([
        post({ sessionId: "s1" }).then((r) => r.status),
        new Promise((r) => setTimeout(r, 2000, "hung")),
      ]);
      expect(status).not.toBe("hung");
      expect(status).toBeGreaterThanOrEqual(500);
    });

    it("session feedback right after a recall waits for its in-flight history write", async () => {
      const history: string[] = [];
      const updateWorth = vi.fn(async () => undefined);
      const ports = {
        recordRecallObservation: (_r: unknown, hits: Array<{ memoryId: string }>) =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              history.push(...hits.map((h) => h.memoryId));
              resolve();
            }, 50)
          ),
        getRecalledFactIds: async () => [...history],
        recordSessionOutcome: async () => true,
        updateWorth,
      };
      const { app, post } = await setup(
        vi.fn().mockResolvedValue({ hits: [hit("a")] }),
        { id: "s1" },
        ports,
        {
          apiKeys: await makeKeyLookup(["memory:read", "memory:write", "memory:admin"]),
          cache: { healthCheck: async () => ({ status: "ok" }) },
        }
      );
      expect((await post({ sessionId: "s1" })).status).toBe(200);
      const res = await app.request("/session/s1/feedback", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(204);
      expect(updateWorth).toHaveBeenCalledWith("a", WS_ID, "fact", expect.any(Object));
    });

    it("never waits on a stalled observation write (success or breaker error)", async () => {
      const stalled = { recordRecallObservation: () => new Promise(() => {}) };
      const race = (p: Promise<Response>) =>
        Promise.race([p.then((r) => r.status), new Promise((r) => setTimeout(r, 4000, "hung"))]);
      const ok = await setup(vi.fn().mockResolvedValue({ hits: [hit("a")] }), null, stalled);
      expect(await race(ok.post())).toBe(200);
      const failing = await setup(vi.fn().mockRejectedValue(new Error("db")), null, stalled);
      expect(await race(failing.post())).toBe(500);
    });

    it("records an error observation when core throws", async () => {
      const { obs, post } = await setup(vi.fn().mockRejectedValue(new Error("boom")));
      expect((await post()).status).toBe(500);
      expect(obs[0]![0]).toMatchObject({ status: "error", resultCount: 0 });
    });

    it("foreign session never fails recall; declared caller cannot override auth; replay reuses id", async () => {
      const recall = vi.fn().mockResolvedValue({ hits: [] });
      const { obs, post } = await setup(recall, null);
      const h = { "x-mnemo-caller": "evil", "x-request-id": "rid-1" };
      expect((await post({ sessionId: "foreign", actorId: "admin" }, h)).status).toBe(200);
      await post({}, h);
      await post();
      const [first, replay, fresh] = obs.map((o) => o[0]);
      expect(first).toMatchObject({ sessionId: null, sessionNullReason: "not_found_in_workspace" });
      expect(first!.verifiedActor).toEqual({ type: "user", id: "key:key001" });
      expect(first!.declaredCaller).toBe("evil");
      expect(recall.mock.calls[0]![1].sessionId).toBeUndefined();
      // A replay of the same query under the same id is the same observation.
      expect(replay!.requestId).toBe(first!.requestId);
      expect(String(replay!.requestId)).toMatch(/^rid-1/);
      expect(String(fresh!.requestId)).not.toMatch(/^rid-1/);
    });

    // APP-074 (audit 2026-11-22): the observation was keyed on the client's
    // X-Request-Id alone, so a client or proxy that reused one id for
    // different recalls kept only the first: no log rows, hit counts or credit
    // for the rest, and no signal. A replay (same id, same query) still dedupes.
    it("the same X-Request-Id on a different query is a different observation", async () => {
      const recall = vi.fn().mockResolvedValue({ hits: [] });
      const { obs, post } = await setup(recall, null);
      const h = { "x-request-id": "rid-shared" };
      await post({ query: "first question" }, h);
      await post({ query: "a different question" }, h);
      const [a, b] = obs.map((o) => o[0]);
      expect(a!.requestId).not.toBe(b!.requestId);
    });

    it("bounds a client request id", async () => {
      const recall = vi.fn().mockResolvedValue({ hits: [] });
      const { obs, post } = await setup(recall, null);
      await post({}, { "x-request-id": "x".repeat(5000) });
      expect(String(obs[0]![0].requestId).length).toBeLessThanOrEqual(160);
    });
  });

  it("CORS preflight accepts the SDK observation headers", async () => {
    const deps = { core: makeCoreDeps(), apiKeys: await makeKeyLookup() } as unknown as ServerDeps;
    const app = createApp({ deps, version: "0.0.0-test" });
    const res = await app.request("/recall", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-mnemo-caller,x-mnemo-client-version",
      },
    });
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const h of ["x-mnemo-caller", "x-mnemo-client-version", "x-mnemo-plugin-version"])
      expect(allowed).toContain(h);
  });
});
