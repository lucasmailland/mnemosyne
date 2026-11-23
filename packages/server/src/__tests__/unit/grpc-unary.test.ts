import { describe, it, expect, vi } from "vitest";
import { createRouterTransport, createClient } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import bcrypt from "bcrypt";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";

function fakeApiKeys() {
  return {
    listActive: vi.fn().mockResolvedValue([]),
    findByLookupHash: vi.fn().mockResolvedValue(null),
    touch: vi.fn(),
  };
}

function makeClient(deps: Partial<ServerDeps>, authHeader?: string) {
  const fullDeps = deps as ServerDeps;
  const transport = createRouterTransport((r) => createMnemosyneRoutes(r, fullDeps), {
    router: { interceptors: [createAuthInterceptor(fullDeps)] },
  });
  const client = createClient(MnemosyneService, transport);
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return { client, headers };
}

describe("gRPC auth interceptor rejects", () => {
  it("missing token → Code.Unauthenticated", async () => {
    const { client } = makeClient({ apiKeys: fakeApiKeys() });
    await expect(client.recall({ query: "x", limit: 5 }, { headers: {} })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it("invalid token → Code.Unauthenticated", async () => {
    const { client, headers } = makeClient(
      { apiKeys: { ...fakeApiKeys(), findByLookupHash: vi.fn().mockResolvedValue(null) } },
      "Bearer mns_live_invalidkeyxxxxxxxxxxxxxxx"
    );
    await expect(client.recall({ query: "x", limit: 5 }, { headers })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });
});

describe("gRPC unary — handlers reuse deps", () => {
  async function authedDeps(overrides: Partial<ServerDeps>): Promise<ServerDeps> {
    const keyHash = await bcrypt.hash(TOKEN, 12);
    const apiKeys = {
      ...fakeApiKeys(),
      findByLookupHash: vi.fn().mockResolvedValue({
        id: "k1",
        keyHash,
        workspaceId: WS,
        scopes: ["memory:read", "memory:write", "memory:delete", "memory:self_edit"],
      }),
    };
    return { apiKeys, cognitive: makeMockCognitive(), ...overrides } as unknown as ServerDeps;
  }

  it("Recall calls deps.cognitive.recall and maps hits → MemoryItem[]", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [
        {
          id: "f1",
          primitive: "fact",
          content: "hello",
          score: 0.9,
          sensitivity: "internal",
          injectionScore: 0,
          provenance: "user_stated",
          origin: "local",
          contested: false,
          validFrom: new Date("2026-06-16T00:00:00.000Z"),
          validTo: null,
          tags: [],
          relations: [],
        },
      ],
      total: 1,
      query: { text: "hello", limit: 5, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = await authedDeps({ cognitive: makeMockCognitive({ recall }) });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.recall({ query: "hello", limit: 5 }, { headers });
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, text: "hello", limit: 5 }),
      expect.objectContaining({ workspaceId: WS }),
      // Third arg: gRPC identifies its transport for the core recall observation.
      expect.objectContaining({
        observation: expect.objectContaining({ declaredCaller: "grpc:recall" }),
      })
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("f1");
  });

  it("Recall hands core the effective transport ceiling, so it never records undelivered hits", async () => {
    const prev = process.env.MNEMO_SENSITIVITY_CEILING;
    process.env.MNEMO_SENSITIVITY_CEILING = "public";
    try {
      const recall = vi.fn().mockResolvedValue({ hits: [], total: 0, latencyMs: 1 });
      const deps = await authedDeps({ cognitive: makeMockCognitive({ recall }) });
      const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
      await client.recall({ query: "hello", limit: 5 }, { headers });
      expect(recall.mock.calls[0]![1]).toMatchObject({ maxSensitivity: "public" });
    } finally {
      if (prev === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
      else process.env.MNEMO_SENSITIVITY_CEILING = prev;
    }
  });

  it("Remember calls deps.cognitive.remember and returns the new id", async () => {
    const remember = vi
      .fn()
      .mockResolvedValue({ id: "new-fact", kind: "fact", staged: false, vectorSearchable: true });
    const deps = await authedDeps({ cognitive: makeMockCognitive({ remember }) });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.remember({ content: "x", type: "fact" }, { headers });
    expect(remember).toHaveBeenCalledTimes(1);
    const [arg, auth] = remember.mock.calls[0]!;
    expect(arg.workspaceId).toBe(WS);
    expect(arg.content).toBe("x");
    expect(auth.actorId).toBe("key:k1");
    expect(auth.userId).toBeNull();
    expect(auth.actorType).toBe("user");
    expect(res.id).toBe("new-fact");
  });

  it("CreateTask calls deps.storage.createTask", async () => {
    const createTask = vi.fn().mockResolvedValue({
      id: "t1",
      title: "T",
      status: "pending",
      priority: "high",
      assignedTo: "a",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const deps = await authedDeps({ storage: { createTask } as never });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.createTask(
      { title: "T", priority: "high", assignedTo: "a" },
      { headers }
    );
    expect(createTask).toHaveBeenCalledOnce();
    expect(res.id).toBe("t1");
  });

  it("SelfEdit → Code.Unavailable when storage is absent", async () => {
    const deps = await authedDeps({ core: {} as never });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    await expect(
      client.selfEdit({ action: "noop", targetId: "x" }, { headers })
    ).rejects.toMatchObject({ code: Code.Unavailable });
  });

  it("Forget calls deps.storage.getFact + archiveFact and returns success", async () => {
    const getFact = vi.fn().mockResolvedValue({ id: "f1", workspaceId: WS, validTo: null });
    const archiveFact = vi.fn().mockResolvedValue(undefined);
    const deps = await authedDeps({
      storage: { getFact, archiveFact, appendAuditEntry: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.forget({ id: "f1", reason: "stale" }, { headers });
    expect(res.success).toBe(true);
    expect(getFact).toHaveBeenCalledWith("f1", WS);
    expect(archiveFact).toHaveBeenCalledWith("f1", WS);
  });

  // APP-030 (audit 2026-11-22): a delete over the Connect/gRPC port left no
  // mnemo_audit_log row; the same delete over HTTP writes one.
  it("Forget appends the same audit entry as DELETE /facts/:id", async () => {
    const getFact = vi.fn().mockResolvedValue({ id: "f1", workspaceId: WS, validTo: null });
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const deps = await authedDeps({
      storage: { getFact, archiveFact: vi.fn().mockResolvedValue(true), appendAuditEntry } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    await client.forget({ id: "f1", reason: "stale" }, { headers });
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        action: "delete",
        resourceKind: "fact",
        resourceId: "f1",
        actorId: expect.stringMatching(/^key:/),
        detail: { reason: "stale" },
      })
    );
  });

  it("Forget → NotFound when fact missing", async () => {
    const deps = await authedDeps({
      storage: { getFact: vi.fn().mockResolvedValue(null), archiveFact: vi.fn() } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    await expect(client.forget({ id: "x", reason: "" }, { headers })).rejects.toMatchObject({
      code: Code.NotFound,
    });
  });

  it("Forget → NotFound when fact already closed (validTo set)", async () => {
    const deps = await authedDeps({
      storage: {
        getFact: vi.fn().mockResolvedValue({ id: "x", workspaceId: WS, validTo: new Date() }), // determinism-ok: fixture timestamp, not asserted
        archiveFact: vi.fn(),
      } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    await expect(client.forget({ id: "x", reason: "" }, { headers })).rejects.toMatchObject({
      code: Code.NotFound,
    });
  });

  it("a row above the ceiling reads as missing: Forget, UpdateTask, ResolveReasoning", async () => {
    // Default ceiling is internal; nothing is written and nothing is served.
    const archiveFact = vi.fn();
    const updateTask = vi.fn();
    const deps = await authedDeps({
      storage: {
        getFact: vi.fn().mockResolvedValue({ id: "x", workspaceId: WS, sensitivity: "restricted" }),
        archiveFact,
        getTask: vi.fn().mockResolvedValue({ id: "t", sensitivity: "restricted" }),
        updateTask,
        getReasoning: vi
          .fn()
          .mockResolvedValue({ id: "r", chain: ["secret"], sensitivity: "restricted" }),
      } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    await expect(client.forget({ id: "x", reason: "" }, { headers })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    await expect(client.updateTask({ id: "t", title: "y" }, { headers })).rejects.toMatchObject({
      code: Code.NotFound,
    });
    const res = await client.resolveReasoning({ query: "r" }, { headers });
    expect([res.cacheHit, res.reasoningId, res.chain]).toEqual([false, "", ""]);
    expect(archiveFact).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("SelfEdit on a fact or strategy above the ceiling reads as missing, for every action", async () => {
    const updateWorth = vi.fn();
    const archiveFact = vi.fn();
    const archiveStrategy = vi.fn();
    const deps = await authedDeps({
      storage: {
        getFact: vi.fn(async (id: string) =>
          id === "hidden" ? { id, workspaceId: WS, sensitivity: "restricted" } : null
        ),
        getStrategy: vi.fn(async (id: string) =>
          id === "hidden" ? { id, workspaceId: WS, sensitivity: "restricted" } : null
        ),
        updateWorth,
        archiveFact,
        archiveStrategy,
      } as any,
    });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    for (const action of ["append", "strengthen", "weaken", "forget"]) {
      for (const targetId of ["hidden", "missing", "strategy:hidden", "strategy:missing"]) {
        await expect(
          client.selfEdit({ action, targetId, content: "x", reason: "r" }, { headers })
        ).rejects.toMatchObject({ code: Code.NotFound, rawMessage: "Self-edit target not found" });
      }
    }
    expect(updateWorth).not.toHaveBeenCalled();
    expect(archiveFact).not.toHaveBeenCalled();
    expect(archiveStrategy).not.toHaveBeenCalled();
  });

  it("RecordReasoning persists and returns reasoningId", async () => {
    const createReasoning = vi.fn().mockResolvedValue({ id: "r1" });
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const deps = await authedDeps({ storage: { createReasoning, updateWorth } as any });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.recordReasoning(
      { query: "q", chain: "step1->step2", confidence: 0.9 },
      { headers }
    );
    expect(res.reasoningId).toBe("r1");
    expect(updateWorth).toHaveBeenCalledWith("r1", WS, "reasoning", {
      success: 1,
      failure: 0,
      creditWeight: 1,
    });
  });

  it("GetHealth returns status + vitals checks", async () => {
    const healthCheck = vi.fn().mockResolvedValue({ status: "ok" });
    const getWorkspaceVitals = vi.fn().mockResolvedValue({
      workspaceId: WS,
      factsLive: 5,
      factsClosed: 1,
      pinnedCount: 2,
      lastRecallAt: null,
      lastWriteAt: null,
      embeddings: { indexed: 4, pending: 1 },
    });
    const deps = await authedDeps({ storage: { healthCheck, getWorkspaceVitals } as any });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.getHealth({}, { headers });
    expect(res.status).toBe("healthy");
    expect(res.checks?.facts_live).toBe("5");
  });

  it("GetHealth degrades to status=degraded when healthCheck reports not-ok", async () => {
    const healthCheck = vi.fn().mockResolvedValue({ status: "error" });
    const getWorkspaceVitals = vi.fn().mockResolvedValue({
      workspaceId: WS,
      factsLive: 0,
      factsClosed: 0,
      pinnedCount: 0,
      lastRecallAt: null,
      lastWriteAt: null,
      embeddings: { indexed: 0, pending: 0 },
    });
    const deps = await authedDeps({ storage: { healthCheck, getWorkspaceVitals } as any });
    const { client, headers } = makeClient(deps, `Bearer ${TOKEN}`);
    const res = await client.getHealth({}, { headers });
    expect(res.status).toBe("degraded");
  });
});
