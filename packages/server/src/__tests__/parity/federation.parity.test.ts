/**
 * Tier A parity — `routes/federation.ts`'s `GET /memory/federation/items`
 * (design.md D3, flatten-legacy-dual-core PR15, task 6c.2 / Phase 6b.4).
 *
 * This route requires the §6 mTLS + service-JWT peer gate
 * (`gateFederationRequest`), not the standard bearer-key auth
 * `buildMountHarness` wires — so this file follows
 * `federation-since.test.ts`'s existing harness pattern (custom
 * `OpenAPIHono` + `withFedAuth` + `mountFederation` directly) rather than
 * `buildMountHarness`. `federation-since.test.ts` already covers the
 * `?since=` → `updatedSince` cursor forwarding in isolation (ported to
 * `deps.storage.queryFactsPage` by this same PR); this file widens coverage
 * to the rest of the call — the fixed filter fields (`status`/`sortBy`/
 * `order`), `limit` default/cap, and the response item mapping — confirmed
 * against the legacy `listFacts({workspaceId, status:'active',
 * sortBy:'updated_at', order:'asc', limit, updatedSince})` call this route
 * made before the port (`apply-progress.md` PR15 section).
 *
 * Ported onto `deps.storage.queryFactsPage` — `FactPageFilter` already
 * exposed every field this route needs (D6.3, PR9b), confirmed by reading
 * `ports.ts` directly before porting (no new port surface). DISCLOSED
 * call-shape differences: `queryFactsPage` returns `MnemoFact[]` (Date
 * fields for `validFrom`/`validTo`), wire-mapped inline by the route
 * (`.toISOString()`), where legacy's `CoreMemoryFact[]` already carried ISO
 * strings.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountFederation } from "../../routes/federation.js";
import { signServiceJwt, InMemoryJtiStore } from "@mnemo-ai/core";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
const AUD = "mnemo:instance:self";
const WORKSPACE = "ws_fed_parity_test";
const NOW = "2026-06-20T00:00:00.000Z"; // determinism-ok: fixed fixture timestamp, not derived from Date.now()

function withFedAuth(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE);
    c.set("apiKeyPrefix" as never, "mk_fed_");
    c.set("scopes" as never, []);
    await next();
  });
}

function makeFedDeps() {
  const token = signServiceJwt(privateKey, {
    iss: "peer-a",
    aud: AUD,
    workspaceScope: [WORKSPACE],
  });
  const peerStore = {
    async get(id: string) {
      return id === "peer-a"
        ? {
            peerId: "peer-a",
            pinnedCertDer: pinnedDer,
            trustWeight: 1,
            approvedAt: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
            enabled: true,
          }
        : null;
    },
    async list() {
      return [];
    },
  };
  const jtiStore = new InMemoryJtiStore();
  return {
    peerStore,
    jtiStore,
    selfAudience: AUD,
    token,
    mtls: { processAnnounce: vi.fn(), approveKeyRotation: vi.fn() },
    jobStore: { create: vi.fn(), update: vi.fn(), get: vi.fn() },
    syncEngine: null,
    serveCrypto: undefined,
    // x-mnemo-tls-protocol is set as a TLS-terminating proxy would.
    transport: { trustProxyHeaders: true },
  };
}

function makeFedRequest(fedDeps: ReturnType<typeof makeFedDeps>, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: {
      "x-mnemo-service-jwt": fedDeps.token,
      "x-mnemo-peer-id": "peer-a",
      "x-mnemo-client-cert": Buffer.from(pinnedDer).toString("base64url"),
      "x-mnemo-tls-protocol": "TLSv1.3",
    },
  });
}

function v3FactRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: WORKSPACE,
    scope: "global" as const,
    statement: "objective fact statement",
    subject: "user",
    kind: "other" as const,
    confidence: 1,
    relevance: 1,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 1,
    worthBeta: 1,
    worth: 1,
    memoryType: "semantic" as const,
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "objective_fact" as const,
    sourceMessageIds: [] as string[],
    linkedMemoryIds: [] as string[],
    revisionCount: 1,
    protocolVersion: "v3",
    status: "active" as const,
    pinned: false,
    canonical: false,
    sensitivity: "internal" as const,
    embeddingStale: false,
    validFrom: new Date(NOW),
    validTo: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    metadata: {},
    ...overrides,
  };
}

async function buildApp(
  overrides: { queryFactsPage?: ReturnType<typeof vi.fn>; serveMark?: Date | null } = {}
) {
  const queryFactsPage =
    overrides.queryFactsPage ??
    vi.fn().mockResolvedValue({ items: [v3FactRecord("fact_1")], nextCursor: null, total: 1 });
  const fedDeps = makeFedDeps();
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  withFedAuth(app);
  const deps = {
    storage: {
      queryFactsPage,
      // 0070: what this server served the peer bounds its tombstones.
      federationServeMark: vi.fn().mockResolvedValue(overrides.serveMark ?? null),
      raiseFederationServeMark: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServerDeps["storage"],
    federation: fedDeps,
    telemetry: {
      startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }),
    },
  } as unknown as ServerDeps;
  mountFederation(app, deps);
  return { app, fedDeps, queryFactsPage };
}

describe("Tier A parity: GET /memory/federation/items", () => {
  it("forwards workspaceId/status/sortBy/order and the default limit (100)", async () => {
    const { app, fedDeps, queryFactsPage } = await buildApp();
    const res = await app.request(makeFedRequest(fedDeps, "/memory/federation/items"));
    expect(res.status).toBe(200);
    // "all": a forgotten or merged fact is served too, as a tombstone.
    expect(queryFactsPage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      status: "all",
      sortBy: "updated_at",
      order: "asc",
      limit: 100,
    });
  });

  it("caps limit at 200 even when a larger value is requested", async () => {
    const { app, fedDeps, queryFactsPage } = await buildApp();
    await app.request(makeFedRequest(fedDeps, "/memory/federation/items?limit=9999"));
    expect(queryFactsPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it("maps items to remoteId/version/peerDomain/payload", async () => {
    const { app, fedDeps } = await buildApp({
      queryFactsPage: vi.fn().mockResolvedValue({
        items: [
          v3FactRecord("fact_1", {
            statement: "hello world",
            sensitivity: "confidential",
            validTo: new Date(NOW),
          }),
        ],
        nextCursor: "cursor_1",
        total: 1,
      }),
    });
    const res = await app.request(makeFedRequest(fedDeps, "/memory/federation/items"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        remoteId: string;
        version: number;
        peerDomain: string;
        payload: Record<string, unknown>;
      }>;
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBe("cursor_1");
    expect(body.items).toEqual([
      {
        remoteId: "fact_1",
        version: 1,
        peerDomain: "localhost",
        payload: {
          statement: "hello world",
          kind: "objective_fact",
          attribution: "federation_received",
          sensitivity: "confidential",
          validFrom: NOW,
          validTo: NOW,
        },
      },
    ]);
  });

  describe("tombstones", () => {
    const page = () =>
      vi.fn().mockResolvedValue({
        items: [
          v3FactRecord("fact_1", { revisionCount: 3 }),
          v3FactRecord("fact_2", { status: "forgotten", revisionCount: 2, validTo: new Date(NOW) }),
        ],
        nextCursor: null,
        total: 2,
        itemCursors: ["after_1", "after_2"],
      });
    const known = (v: string) =>
      Buffer.from(JSON.stringify({ v, id: "x" }), "utf8").toString("base64url");
    async function items(query: string, serveMark: Date | null = new Date(NOW)) {
      const { app, fedDeps } = await buildApp({ queryFactsPage: page(), serveMark });
      const res = await app.request(makeFedRequest(fedDeps, `/memory/federation/items${query}`));
      return (await res.json()) as { items: Array<Record<string, unknown>>; nextCursor: string };
    }

    it("serves the revisionCount as version, and a fact the puller may hold as a tombstone", async () => {
      // NOW is 2026-06-20T00:00:00Z; the puller's previous sync ended after it.
      const body = await items(`?knownCursor=${known("2026-06-21T10:00:00.000000Z")}`);
      expect(body.items[0]).toMatchObject({ remoteId: "fact_1", version: 3 });
      expect(body.items[0]).not.toHaveProperty("deletedAt");
      expect(body.items[1]).toEqual({
        remoteId: "fact_2",
        version: 2,
        peerDomain: "localhost",
        deletedAt: "2026-06-20T00:00:00.000Z", // the day only
        payload: {},
      });
      // The last page still says where it ended, for the next incremental sync.
      expect(body.nextCursor).toBe("after_2");
    });

    it("a first sync (no knownCursor) gets no tombstones, and the cursor still moves", async () => {
      const body = await items("");
      expect(body.items.map((i) => i.remoteId)).toEqual(["fact_1"]);
      expect(body.nextCursor).toBe("after_2");
    });

    it("no tombstone without a serve mark, whatever knownCursor says", async () => {
      const body = await items(`?knownCursor=${known("2099-01-01T00:00:00.000000Z")}`, null);
      expect(body.items.map((i) => i.remoteId)).toEqual(["fact_1"]);
    });

    it("no tombstone for a fact created after the latest fact served to the peer", async () => {
      const body = await items(
        `?knownCursor=${known("2099-01-01T00:00:00.000000Z")}`,
        new Date("2026-06-19T00:00:00.000Z")
      );
      expect(body.items.map((i) => i.remoteId)).toEqual(["fact_1"]);
    });

    it("no tombstone for a fact created after the puller's previous sync", async () => {
      const body = await items(`?knownCursor=${known("2026-06-19T00:00:00.000000Z")}`);
      expect(body.items.map((i) => i.remoteId)).toEqual(["fact_1"]);
    });
  });

  it("forwards ?cursor= to the keyset page", async () => {
    const { app, fedDeps, queryFactsPage } = await buildApp();
    await app.request(makeFedRequest(fedDeps, "/memory/federation/items?cursor=abc"));
    expect(queryFactsPage).toHaveBeenCalledWith(expect.objectContaining({ cursor: "abc" }));
  });

  it("returns 403 when the peer gate fails (no cert header)", async () => {
    const { app, fedDeps } = await buildApp();
    const req = new Request("http://localhost/memory/federation/items", {
      method: "GET",
      headers: { "x-mnemo-service-jwt": fedDeps.token, "x-mnemo-peer-id": "peer-a" },
    });
    const res = await app.request(req);
    expect(res.status).toBe(403);
  });
});
