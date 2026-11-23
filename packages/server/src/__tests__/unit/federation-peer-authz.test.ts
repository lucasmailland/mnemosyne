/**
 * Unit tests for p55-federation-peer-authz — inline defence-in-depth on the
 * 5 peer-management routes.
 *
 * Design note: `_mountHarness.ts` builds its sub-router WITHOUT the central
 * `app.ts` `getScopeForRequest()` guard (see its own header comment: "no
 * rate-limit / idempotency / RBAC middleware"). That means these tests
 * exercise ONLY the inline `requirePeerAdmin()` / `requireScopes()` layer
 * added directly inside `routes/federation.ts` — never the router-level
 * scope gate, which is covered separately by `scope-matrix.test.ts`. This is
 * deliberate: D5 in the design states neither layer is the sole gate, so
 * each layer needs its own independent proof.
 *
 * Harness pattern: mirrors `federation-audit-emit.test.ts`'s `withFedAuth()`
 * stub middleware (`c.set("scopes", [...])`) plus `app.onError(toErrorBody)`
 * so a thrown `RbacError` (403 `INSUFFICIENT_SCOPE`) is visible in the
 * response body exactly as it would be through the real error middleware.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountFederation } from "../../routes/federation.js";
import { toErrorBody } from "../../errors.js";

const WORKSPACE = "ws_peer_authz_test";
const USER_ID = "user-p55-peer-authz-001";
const RAW_ACTOR_ID = "key-p55-peer-authz-001";

function makePeerStore() {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockImplementation(async (id: string) =>
      id === "peer-a"
        ? {
            peerId: "peer-a",
            pinnedCertDer: new Uint8Array([1, 2, 3, 4]),
            trustWeight: 1,
            approvedAt: "2026-01-01T00:00:00.000Z",
            enabled: true,
          }
        : null
    ),
    deletePeer: vi.fn().mockResolvedValue(undefined),
    addPeer: vi.fn().mockResolvedValue(true),
  };
}

function makeApp(scopes: string[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 403 | 404 | 422 | 500);
  });

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE);
    c.set("apiKeyPrefix", "mk_fed_");
    c.set("scopes", scopes);
    c.set("userId", USER_ID);
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "federation");
    await next();
  });

  const peerStore = makePeerStore();
  const mtls = {
    processAnnounce: vi.fn().mockResolvedValue({ accepted: true, reason: "operator_approved" }),
    approveKeyRotation: vi.fn().mockResolvedValue(undefined),
  };
  const jobStore = { create: vi.fn(), update: vi.fn(), get: vi.fn() };

  const fedDeps = {
    peerStore,
    mtls,
    jobStore,
    syncEngine: null,
    jtiStore: undefined,
    selfAudience: "mnemo:instance:self",
    serveCrypto: undefined,
  };

  const deps = {
    core: {},
    federation: fedDeps,
    storage: {
      appendAuditEntry: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServerDeps["storage"],
    telemetry: {
      startSpan: () => ({
        setAttribute() {},
        setStatus() {},
        end() {},
      }),
    },
  } as unknown as ServerDeps;

  mountFederation(app, deps);

  return { app, peerStore, mtls };
}

function certBody(): Record<string, unknown> {
  return { newCertDer: Buffer.from(new Uint8Array([9, 9, 9])).toString("base64") };
}

interface RouteCase {
  name: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}

const ROUTES: RouteCase[] = [
  { name: "GET /peers", method: "GET", path: "/memory/federation/peers" },
  { name: "GET /peers/pending", method: "GET", path: "/memory/federation/peers/pending" },
  {
    name: "POST /peers",
    method: "POST",
    path: "/memory/federation/peers",
    body: { peerId: "peer-new", pinnedCertDer: "AQID", trustWeight: 0.5 },
  },
  {
    name: "POST /peers/:id/approve",
    method: "POST",
    path: "/memory/federation/peers/peer-a/approve",
    body: certBody(),
  },
  {
    name: "POST /peers/:id/approve-key",
    method: "POST",
    path: "/memory/federation/peers/peer-a/approve-key",
    body: certBody(),
  },
  { name: "DELETE /peers/:id", method: "DELETE", path: "/memory/federation/peers/peer-a" },
];

function makeRequest(route: RouteCase): Request {
  const init: RequestInit = { method: route.method };
  if (route.body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(route.body);
  }
  return new Request(`http://localhost${route.path}`, init);
}

describe("federation peer routes — inline requirePeerAdmin() defence-in-depth", () => {
  describe.each(ROUTES)("$name", (route) => {
    it("403s with INSUFFICIENT_SCOPE for a memory:federation-only key", async () => {
      const { app } = makeApp(["memory:federation"]);
      const res = await app.request(makeRequest(route));
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("INSUFFICIENT_SCOPE");
    });

    it("does not 403 with INSUFFICIENT_SCOPE for a federation:admin key", async () => {
      const { app } = makeApp(["federation:admin"]);
      const res = await app.request(makeRequest(route));
      if (res.status === 403) {
        const json = (await res.json()) as { error: { code: string } };
        expect(json.error.code).not.toBe("INSUFFICIENT_SCOPE");
      } else {
        expect(res.status).not.toBe(403);
      }
    });
  });

  it("control: POST /memory/federation/sync with memory:federation is NOT rejected by the inline peer-admin layer", async () => {
    const { app } = makeApp(["memory:federation"]);
    const res = await app.request(
      new Request("http://localhost/memory/federation/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerId: "peer-a" }),
      })
    );
    // No federation auth headers are set on this request, so
    // gateFederationRequest() will reject it — but with a DIFFERENT error
    // than requirePeerAdmin() would produce. The route must never reach
    // INSUFFICIENT_SCOPE, proving the inline peer-admin check is not applied
    // to the data-plane sync route.
    if (res.status === 403) {
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).not.toBe("INSUFFICIENT_SCOPE");
    }
  });

  describe("regression: scope check precedes mutation", () => {
    it("DELETE /peers/:id with memory:federation-only never invokes peerStore.deletePeer", async () => {
      const { app, peerStore } = makeApp(["memory:federation"]);
      const res = await app.request(
        makeRequest({ name: "", method: "DELETE", path: "/memory/federation/peers/peer-a" })
      );
      expect(res.status).toBe(403);
      expect(peerStore.deletePeer).not.toHaveBeenCalled();
    });

    it("POST /peers with memory:federation-only never invokes peerStore.addPeer", async () => {
      const { app, peerStore } = makeApp(["memory:federation"]);
      const res = await app.request(makeRequest(ROUTES.find((r) => r.name === "POST /peers")!));
      expect(res.status).toBe(403);
      expect(peerStore.addPeer).not.toHaveBeenCalled();
    });
  });
});
