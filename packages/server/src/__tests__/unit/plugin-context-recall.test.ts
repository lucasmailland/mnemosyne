/**
 * Unit tests for ctx.recall in buildPluginContext.
 *
 * flatten-legacy-dual-core Phase 6d (PR17): D3 Tier A parity coverage for
 * `deps.core.recall` — one of the 3 previously-undiscovered `deps.core` call
 * sites outside `packages/server/src/routes/**` (the D4 allowlist scanner's
 * glob never covered `plugins/context.ts`). Ported to `deps.cognitive.recall`
 * in the same PR — see that commit for the AuthContext-construction rationale
 * (plugins are fully-trusted server code per S11/PLUGIN_SPEC.md, so the
 * ceiling is set to preserve legacy's genuinely UNGATED sensitivity behavior,
 * not silently narrow it).
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { createRouterTransport, createClient } from "@connectrpc/connect";
import { finalizeRecallObservation } from "@mnemo-ai/core/cognitive";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createMnemosyneRoutes, createAuthInterceptor } from "../../grpc.js";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-plugin-test";
const PLUGIN = "test-plugin";

function makeCtx(deps: ServerDeps, config: Record<string, string | undefined> = {}) {
  return buildPluginContext({
    pluginId: PLUGIN,
    config,
    workspaceId: WS,
    deps,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("ctx.recall", () => {
  it("delegates to deps.cognitive.recall with workspaceId/text/limit", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [
        {
          id: "f1",
          primitive: "fact",
          content: "hello world",
          score: 0.87,
          sensitivity: "internal",
          injectionScore: 0,
          provenance: "user_stated",
          origin: "local",
          contested: false,
          validFrom: new Date("2026-01-01T00:00:00.000Z"),
          validTo: null,
          tags: [],
          relations: [],
        },
      ],
      total: 1,
      query: { text: "hello", limit: 10, offset: 0 },
      latencyMs: 3,
      fromHotTier: false,
    });
    const deps = { cognitive: { recall } } as unknown as ServerDeps;
    const ctx = makeCtx(deps);

    const results = await ctx.recall("hello");

    expect(recall).toHaveBeenCalledTimes(1);
    const [query, auth] = recall.mock.calls[0]!;
    expect(query).toMatchObject({ workspaceId: WS, text: "hello", limit: 10 });
    expect(auth.workspaceId).toBe(WS);
    expect(auth.actorId).toBe(`plugin:${PLUGIN}`);
    expect(results).toEqual([{ id: "f1", content: "hello world", score: 0.87 }]);
  });

  it("maps every hit to {id, content, score} only, dropping the rest of RecallHit", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [
        {
          id: "f2",
          primitive: "fact",
          content: "second",
          score: 0.5,
          sensitivity: "public",
          injectionScore: 0,
          provenance: "extracted",
          origin: "local",
          contested: false,
          validFrom: new Date(), // determinism-ok: fixture timestamp, not asserted
          validTo: null,
          tags: ["a", "b"],
          relations: [],
        },
      ],
      total: 1,
      query: { text: "q", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = { cognitive: { recall } } as unknown as ServerDeps;
    const ctx = makeCtx(deps);

    const results = await ctx.recall("q");
    expect(results).toEqual([{ id: "f2", content: "second", score: 0.5 }]);
  });

  it("returns an empty array when recall finds no hits", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: [],
      total: 0,
      query: { text: "nothing", limit: 10, offset: 0 },
      latencyMs: 1,
      fromHotTier: false,
    });
    const deps = { cognitive: { recall } } as unknown as ServerDeps;
    const ctx = makeCtx(deps);
    await expect(ctx.recall("nothing")).resolves.toEqual([]);
  });
});

describe("gRPC and plugin recall observation context", () => {
  const TOKEN = "mns_live_abcdefghijklmnopqrstu";
  const GRPC_WS = "00000000-0000-0000-0000-000000000001";

  /** Fake core: owns the single observation exactly like createCore's finalizer. */
  function fakeCore(hits: unknown[], fail = false) {
    const record = vi.fn().mockResolvedValue(undefined);
    const recall = vi.fn(async (query: any, auth: any, opts?: any) => {
      const context = {
        requestId: "core-default",
        trafficOrigin: "unknown" as const,
        clientVersion: "unknown",
        pluginVersion: "unknown",
        serverVersion: "unknown",
        ...opts?.observation,
      };
      const deps = {
        storage: { recordRecallObservation: record },
        logger: { warn: vi.fn() } as any,
      };
      if (fail) {
        const error = new Error("boom");
        await finalizeRecallObservation(deps, { context, query, auth, error });
        throw error;
      }
      const response = { hits, total: hits.length, query, latencyMs: 1, fromHotTier: false };
      await finalizeRecallObservation(deps, { context, query, auth, response: response as any });
      return response;
    });
    return { record, recall, cognitive: { recall } };
  }

  async function grpcClient(cognitive: unknown) {
    const apiKeys = {
      listActive: vi.fn().mockResolvedValue([]),
      findByLookupHash: vi.fn().mockResolvedValue({
        id: "k1",
        keyHash: await bcrypt.hash(TOKEN, 12),
        workspaceId: GRPC_WS,
        scopes: ["memory:read"],
      }),
      touch: vi.fn(),
    };
    const deps = { apiKeys, cognitive } as unknown as ServerDeps;
    const transport = createRouterTransport((r) => createMnemosyneRoutes(r, deps), {
      router: { interceptors: [createAuthInterceptor(deps)] },
    });
    return createClient(MnemosyneService, transport);
  }
  const headers = { authorization: `Bearer ${TOKEN}` };
  const hit = {
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
  };

  it("each transport identifies itself and the core records one observation per call", async () => {
    const core = fakeCore([hit]);
    const client = await grpcClient(core.cognitive);
    await client.recall({ query: "hello", limit: 5 }, { headers });
    await makeCtx(core as unknown as ServerDeps).recall("hello");

    expect(core.recall).toHaveBeenCalledTimes(2);
    expect(core.record).toHaveBeenCalledTimes(2);
    const [[grpcReq, grpcHits], [pluginReq, pluginHits]] = core.record.mock.calls;
    expect(grpcReq.requestId).not.toBe(pluginReq.requestId);
    expect(grpcReq.declaredCaller).toBe("grpc:recall");
    expect(pluginReq.declaredCaller).toBe(`plugin:${PLUGIN}`);
    expect(grpcReq.workspaceId).toBe(GRPC_WS);
    expect(grpcReq.verifiedActor).toMatchObject({
      type: expect.any(String),
      id: expect.any(String),
    });
    expect(pluginReq.verifiedActor).toEqual({ type: "system", id: `plugin:${PLUGIN}` });
    expect(grpcReq).toMatchObject({ status: "ok", resultCount: 1 });
    expect(grpcHits).toHaveLength(1);
    expect(pluginHits).toHaveLength(1);
    // Authenticated context is still what core receives.
    const [, grpcAuth] = core.recall.mock.calls[0]!;
    const [, pluginAuth] = core.recall.mock.calls[1]!;
    expect(grpcAuth.workspaceId).toBe(GRPC_WS);
    expect(grpcAuth.scopes).toEqual(["memory:read"]);
    expect(pluginAuth.maxSensitivity).toBe("restricted");
    expect(core.recall.mock.calls[0]![2].deferEffects).toBeUndefined();
    expect(core.recall.mock.calls[1]![2].deferEffects).toBeUndefined();
  });

  it("retains zero-hit recalls as empty", async () => {
    const core = fakeCore([]);
    const client = await grpcClient(core.cognitive);
    await client.recall({ query: "none", limit: 5 }, { headers });
    await makeCtx(core as unknown as ServerDeps).recall("none");
    expect(core.record).toHaveBeenCalledTimes(2);
    for (const [req, hits] of core.record.mock.calls) {
      expect(req).toMatchObject({ status: "empty", resultCount: 0 });
      expect(hits).toEqual([]);
    }
  });

  it("retains core errors as a single error observation", async () => {
    const core = fakeCore([], true);
    const client = await grpcClient(core.cognitive);
    await expect(client.recall({ query: "x", limit: 5 }, { headers })).rejects.toBeDefined();
    await expect(makeCtx(core as unknown as ServerDeps).recall("x")).rejects.toThrow("boom");
    expect(core.record).toHaveBeenCalledTimes(2);
    for (const [req] of core.record.mock.calls) expect(req.status).toBe("error");
  });
});
