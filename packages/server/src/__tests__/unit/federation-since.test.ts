/**
 * Unit test: GET /memory/federation/items?since= cursor is honoured.
 *
 * The federation items handler must pass the `since` query param as
 * `updatedSince` to the fact-listing call so remote peers can do
 * incremental pulls instead of re-receiving the full first page on
 * every sync.
 *
 * RED before fix: the route ignores `since` → the fact-listing call is made
 *   without updatedSince → assertion fails.
 * GREEN after fix: updatedSince is threaded through.
 *
 * flatten-legacy-dual-core PR15 (task 6c.2, folds into 6b.4): ported off the
 * legacy core client's `listFacts({..., updatedSince: string})` onto
 * `deps.storage.queryFactsPage`'s pre-existing `FactPageFilter.updatedSince`
 * (a direct swap-the-call — confirmed by reading `ports.ts` before porting,
 * no new port surface needed). DISCLOSED call-shape difference: legacy
 * passed the raw ISO `since` string through unchanged;
 * `FactPageFilter.updatedSince` is typed `Date`, so this port wraps it in
 * `new Date(since)` — the assertion below now checks a `Date`, not a string.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountFederation } from "../../routes/federation.js";
import { signServiceJwt, InMemoryJtiStore } from "@mnemo-ai/core";

// ── Crypto fixtures ─────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedDer = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
const AUD = "mnemo:instance:self";
const WORKSPACE = "ws_fed_test";

// ── Auth middleware ─────────────────────────────────────────────────────────────

function withFedAuth(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE);
    // apiKeyPrefix must be "mk_fed_" to pass the federation gate
    c.set("apiKeyPrefix" as never, "mk_fed_");
    c.set("scopes" as never, []);
    await next();
  });
}

// ── Minimal federation deps stub ────────────────────────────────────────────────

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
    mtls: {
      processAnnounce: vi.fn(),
      approveKeyRotation: vi.fn(),
    },
    jobStore: {
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
    },
    syncEngine: null,
    serveCrypto: undefined,
    // x-mnemo-tls-protocol is set as a TLS-terminating proxy would.
    transport: { trustProxyHeaders: true },
  };
}

// ── Build a request that passes the federation gate ─────────────────────────────

function makeFedRequest(fedDeps: ReturnType<typeof makeFedDeps>, path: string): Request {
  const url = `http://localhost${path}`;
  return new Request(url, {
    method: "GET",
    headers: {
      "x-mnemo-service-jwt": fedDeps.token,
      "x-mnemo-peer-id": "peer-a",
      "x-mnemo-client-cert": Buffer.from(pinnedDer).toString("base64url"),
      "x-mnemo-tls-protocol": "TLSv1.3",
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("GET /memory/federation/items — since cursor", () => {
  it("passes updatedSince (as a Date) to queryFactsPage when ?since= is provided", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFedAuth(app);

    const queryFactsPage = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 0,
    });

    const fedDeps = makeFedDeps();

    const deps = {
      storage: { queryFactsPage } as unknown as ServerDeps["storage"],
      federation: fedDeps,
      telemetry: {
        startSpan: () => ({
          setAttribute() {},
          setStatus() {},
          end() {},
        }),
      },
    } as unknown as ServerDeps;

    mountFederation(app, deps);

    const since = "2026-06-01T00:00:00.000Z";
    const req = makeFedRequest(
      fedDeps,
      `/memory/federation/items?since=${encodeURIComponent(since)}`
    );
    const res = await app.request(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: null };
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("nextCursor");

    // The critical assertion: queryFactsPage must have been called with updatedSince.
    expect(queryFactsPage).toHaveBeenCalledOnce();
    const callArgs = queryFactsPage.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs["updatedSince"]).toEqual(new Date(since));
  });

  it("omits updatedSince when ?since= is absent (full pull)", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFedAuth(app);

    const queryFactsPage = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 0,
    });

    const fedDeps = makeFedDeps();

    const deps = {
      storage: { queryFactsPage } as unknown as ServerDeps["storage"],
      federation: fedDeps,
      telemetry: {
        startSpan: () => ({
          setAttribute() {},
          setStatus() {},
          end() {},
        }),
      },
    } as unknown as ServerDeps;

    mountFederation(app, deps);

    const req = makeFedRequest(fedDeps, "/memory/federation/items");
    const res = await app.request(req);

    expect(res.status).toBe(200);
    expect(queryFactsPage).toHaveBeenCalledOnce();
    const callArgs = queryFactsPage.mock.calls[0][0] as Record<string, unknown>;
    // No updatedSince key, or it is undefined.
    expect(callArgs["updatedSince"]).toBeUndefined();
  });
});
