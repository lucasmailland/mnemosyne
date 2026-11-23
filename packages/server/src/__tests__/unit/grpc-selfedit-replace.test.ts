import bcrypt from "bcrypt";
import { createClient, createRouterTransport, Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import type { ServerDeps } from "../../deps.js";
import { MnemosyneService } from "../../gen/mnemosyne_pb.js";
import { createAuthInterceptor, createMnemosyneRoutes } from "../../grpc.js";

const WS = "00000000-0000-0000-0000-000000000001";
const TOKEN = "mns_live_abcdefghijklmnopqrstu";
const KEY_PREFIX = "mns_live_";

/**
 * `actorId` here must be the NAMESPACED ActorRef form (e.g. "key:key-record-id")
 * to simulate a fact written under the current provenance model — resolveGrpcProvenance
 * namespaces the authenticated key's raw id the same way. `userId` is a
 * separate field (a real fact.userId column, not folded into actorId).
 */
function fact(actorId: string | undefined, sensitivity = "internal", userId: string | null = null) {
  return {
    id: "fact-1",
    workspaceId: WS,
    actorId,
    userId,
    status: "active",
    validTo: null,
    sensitivity,
    statement: "old",
  } as never;
}

async function makeHarness(options: {
  owner?: string | null;
  /** The fact's own userId field (distinct from the key's bound userId below). */
  factUserId?: string | null;
  userId?: string | null;
  maxSensitivity?: string | null;
  scopes?: string[];
  factOverride?: unknown;
  replacement?: unknown;
  cache?: ServerDeps["cache"];
}) {
  const keyHash = await bcrypt.hash(TOKEN, 12);
  const getFact = vi
    .fn()
    .mockResolvedValue(
      options.factOverride === undefined
        ? fact(
            options.owner === null ? undefined : options.owner,
            "internal",
            options.factUserId ?? null
          )
        : options.factOverride
    );
  const replaceFact = vi.fn().mockResolvedValue(
    options.replacement === undefined
      ? {
          previous: fact(options.owner ?? undefined, "internal", options.factUserId ?? null),
          replacement: { id: "fact-2" },
        }
      : options.replacement
  );
  const deps = {
    apiKeys: {
      listActive: vi.fn().mockResolvedValue([]),
      touch: vi.fn(),
      findByLookupHash: vi.fn().mockResolvedValue({
        id: "key-record-id",
        keyHash,
        workspaceId: WS,
        scopes: options.scopes ?? ["memory:self_edit"],
        userId: options.userId ?? null,
        maxSensitivity: options.maxSensitivity ?? null,
      }),
    },
    // p50-audit-log-emitters (PR7): applySelfEdit now unconditionally emits a
    // self_edit audit entry via ctx.storage.appendAuditEntry when req.provenance
    // is present — grpc.ts always resolves and passes it, so every authenticated
    // selfEdit call needs this stubbed, even though this suite's assertions are
    // about replaceFact/getFact, not the audit trail.
    storage: { getFact, replaceFact, appendAuditEntry: vi.fn().mockResolvedValue(undefined) },
    cache: options.cache,
  } as unknown as ServerDeps;
  const transport = createRouterTransport((router) => createMnemosyneRoutes(router, deps), {
    router: { interceptors: [createAuthInterceptor(deps)] },
  });
  return {
    client: createClient(MnemosyneService, transport),
    headers: { authorization: `Bearer ${TOKEN}` },
    getFact,
    replaceFact,
  };
}

describe("gRPC bitemporal fact replacement", () => {
  it("authorizes ownership by userId match (does NOT feed the actor-id RLS backstop — see routes/self.ts)", async () => {
    // fact.userId matches the key's bound userId; fact.actorId is unset.
    const { client, headers, replaceFact } = await makeHarness({
      owner: undefined,
      userId: "user-1",
      factUserId: "user-1",
    });

    const response = await client.selfEdit(
      { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
      { headers }
    );

    expect(response).toMatchObject({ applied: true, targetKind: "fact", replacementId: "fact-2" });
    expect(replaceFact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fact-1",
        workspaceId: WS,
        statement: "new",
        requestedBy: "user-1",
        agentId: "key-record-id",
      })
    );
    // routes/self.ts now forwards userIsolationId on a userId-only match,
    // activating the user-isolation RLS backstop for that HTTP path. grpc.ts
    // does NOT yet forward it for this same match — that asymmetry is a
    // tracked, deliberate open question (see design doc), not fixed here.
    // This test therefore still asserts neither isolation id is set on the
    // gRPC path, since grpc.ts itself is untouched by this change.
    expect(replaceFact).toHaveBeenCalledWith(
      expect.not.objectContaining({ actorIsolationId: expect.anything() })
    );
    expect(replaceFact).toHaveBeenCalledWith(
      expect.not.objectContaining({ userIsolationId: expect.anything() })
    );
  });

  it("authorizes ownership by the namespaced key-record actorId and forwards it as actorIsolationId", async () => {
    // fact.actorId is the namespaced ActorRef the same key would produce today.
    const { client, headers, replaceFact } = await makeHarness({ owner: "key:key-record-id" });

    const response = await client.selfEdit(
      { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
      { headers }
    );

    expect(response).toMatchObject({ applied: true, targetKind: "fact", replacementId: "fact-2" });
    expect(replaceFact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "fact-1",
        workspaceId: WS,
        statement: "new",
        requestedBy: "key:key-record-id",
        agentId: "key-record-id",
        actorIsolationId: "key:key-record-id",
      })
    );
  });

  it("allows a legacy fact without an owner", async () => {
    const { client, headers, replaceFact } = await makeHarness({ owner: null });

    const response = await client.selfEdit(
      { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
      { headers }
    );

    expect(response.replacementId).toBe("fact-2");
    expect(replaceFact).toHaveBeenCalledWith(
      expect.not.objectContaining({ actorIsolationId: expect.anything() })
    );
  });

  it("does NOT authorize ownership by API-key prefix (security fix — apiKeyPrefix is a shared constant, not an identity)", async () => {
    // Before the fix, any legacy-key holder in the workspace matched any fact
    // whose actorId equalled the shared apiKeyPrefix constant (e.g. "mns_live_").
    const { client, headers, replaceFact } = await makeHarness({ owner: KEY_PREFIX, userId: null });

    await expect(
      client.selfEdit(
        { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect(replaceFact).not.toHaveBeenCalled();
  });

  it("allows memory:admin to replace a foreign-owned fact", async () => {
    const { client, headers } = await makeHarness({
      owner: "another-owner",
      scopes: ["memory:self_edit", "memory:admin"],
    });

    await expect(
      client.selfEdit(
        { action: "replace", targetId: "fact-1", content: "new", reason: "admin correction" },
        { headers }
      )
    ).resolves.toMatchObject({ replacementId: "fact-2" });
  });

  it.each([
    ["missing", null],
    ["closed", fact("key-record-id")],
    ["foreign owner", fact("another-owner")],
    ["above ceiling", fact("key-record-id", "internal")],
  ])(
    "returns anti-probing NOT_FOUND for %s facts without advancing budgets",
    async (kind, candidate) => {
      if (kind === "closed" && candidate) {
        (candidate as { validTo: Date | null }).validTo = new Date(); // determinism-ok: test date
      }
      const incrWithTtl = vi.fn();
      const set = vi.fn();
      const cache = {
        get: vi.fn().mockResolvedValue(null),
        incrWithTtl,
        set,
      } as unknown as ServerDeps["cache"];
      const { client, headers, replaceFact } = await makeHarness({
        owner: "key-record-id",
        factOverride: candidate,
        maxSensitivity: kind === "above ceiling" ? "public" : null,
        cache,
      });

      await expect(
        client.selfEdit(
          { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
          { headers }
        )
      ).rejects.toMatchObject({ code: Code.NotFound });
      expect(replaceFact).not.toHaveBeenCalled();
      expect(incrWithTtl).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    }
  );

  it("maps a replacement race to NOT_FOUND without advancing budgets", async () => {
    const incrWithTtl = vi.fn();
    const set = vi.fn();
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      incrWithTtl,
      set,
    } as unknown as ServerDeps["cache"];
    const { client, headers } = await makeHarness({
      owner: "key:key-record-id",
      replacement: null,
      cache,
    });

    await expect(
      client.selfEdit(
        { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
        { headers }
      )
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect(incrWithTtl).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("returns the committed replacement when Redis counter writes fail", async () => {
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      incrWithTtl: vi.fn().mockRejectedValue(new Error("redis down")),
      set: vi.fn().mockRejectedValue(new Error("redis down")),
    } as unknown as ServerDeps["cache"];
    const { client, headers } = await makeHarness({ owner: "key:key-record-id", cache });

    await expect(
      client.selfEdit(
        { action: "replace", targetId: "fact-1", content: "new", reason: "correction" },
        { headers }
      )
    ).resolves.toMatchObject({
      applied: true,
      targetKind: "fact",
      replacementId: "fact-2",
    });
  });

  // PRIM-1: the proto's `content` is a plain string, so "" is what an omitted
  // field looks like on the wire. It must be INVALID_ARGUMENT, never a replace
  // that writes an empty successor, and it must not read or charge budgets.
  it.each(["", "   "])(
    "rejects replace with blank content %j as INVALID_ARGUMENT",
    async (content) => {
      const cache = {
        get: vi.fn().mockResolvedValue(null),
        incrWithTtl: vi.fn().mockResolvedValue(1),
        set: vi.fn().mockResolvedValue(undefined),
      } as unknown as ServerDeps["cache"];
      const { client, headers, replaceFact } = await makeHarness({
        owner: "key:key-record-id",
        cache,
      });

      await expect(
        client.selfEdit(
          { action: "replace", targetId: "fact-1", content, reason: "fix" },
          { headers }
        )
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
      expect(replaceFact).not.toHaveBeenCalled();
      expect(
        (cache as unknown as { incrWithTtl: ReturnType<typeof vi.fn> }).incrWithTtl
      ).not.toHaveBeenCalled();
      expect((cache as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
    }
  );
});
