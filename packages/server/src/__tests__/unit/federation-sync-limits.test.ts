/**
 * A sync job reads a bounded number of pages and keeps a bounded outcome.
 *
 * The peer here never runs out: every page has 3 items and a next cursor. The
 * job must stop after SYNC_MAX_PAGES (50) pages, record the cursor it reached
 * so the next sync goes on from there (and tells the peer, as knownCursor,
 * where the previous one ended), and store counts per outcome plus at most
 * 100 per-item results, never one entry per item.
 */
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryJtiStore } from "@mnemo-ai/core";
import { InMemorySyncStorage, SyncEngine } from "@mnemo-ai/federation";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { InMemoryJobStore } from "../../federation/JobStore.js";
import { federationIdentityFromEnv } from "../../federation/federationIdentity.js";
import { mountFederation } from "../../routes/federation.js";

const WORKSPACE = "ws_fed_limits";
const requests: URLSearchParams[] = [];
let peer: Server;
let peerUrl: string;

beforeAll(async () => {
  peer = createServer((req, res) => {
    const params = new URL(req.url ?? "/", "http://peer").searchParams;
    requests.push(params);
    const at = Number((params.get("cursor") ?? "c0").slice(1));
    const items = [1, 2, 3].map((i) => ({
      remoteId: `fact-${at}-${i}`,
      version: 1,
      peerDomain: "whatever.example",
      payload: { statement: `Larkspur order ${at}.${i}` },
    }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ items, nextCursor: `c${at + 1}` }));
  });
  await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("no port");
  peerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => peer.close(() => r()));
});

function app(jobStore: InMemoryJobStore) {
  const privatePem = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const acme = {
    peerId: "acme.example",
    pinnedCertDer: new Uint8Array([1]),
    trustWeight: 1,
    approvedAt: "2026-01-01T00:00:00.000Z",
    enabled: true,
    url: peerUrl,
    apiKey: "mk_fed_test",
  };
  const logger = { warn() {}, info() {}, debug() {} };
  const deps = {
    telemetry: { startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }) },
    federation: {
      peerStore: {
        get: async (id: string) => (id === acme.peerId ? acme : null),
        list: async () => [acme],
      },
      mtls: {},
      jobStore,
      syncEngine: new SyncEngine({
        storage: new InMemorySyncStorage(),
        logger,
        workspaceId: "default",
      }),
      jtiStore: new InMemoryJtiStore(),
      selfAudience: "larkspur.example",
      identity: federationIdentityFromEnv({
        MNEMO_FED_PEER_ID: "larkspur.example",
        MNEMO_FEDERATION_PRIVATE_KEY: privatePem,
      }),
    },
  } as unknown as ServerDeps;
  const hono = new OpenAPIHono<{ Variables: AuthVariables }>();
  hono.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["memory:federation"]);
    c.set("actorId", "key-limits");
    await next();
  });
  mountFederation(hono, deps);
  return hono;
}

async function sync(hono: OpenAPIHono<{ Variables: AuthVariables }>, jobStore: InMemoryJobStore) {
  const res = await hono.request("/memory/federation/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peerId: "acme.example" }),
  });
  const { jobId } = (await res.json()) as { jobId: string };
  for (let i = 0; i < 200; i++) {
    const job = await jobStore.get(jobId, WORKSPACE);
    if (job?.status === "done" || job?.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("sync job did not finish");
}

describe("sync job limits", () => {
  it("stops after 50 pages, keeps counts and 100 results, and the next sync goes on", async () => {
    const jobStore = new InMemoryJobStore();
    const hono = app(jobStore);

    const first = await sync(hono, jobStore);
    expect(first.status).toBe("done");
    expect(requests).toHaveLength(50);
    expect(first.outcome).toMatchObject({
      itemsProcessed: 150,
      outcomes: { upserted: 150 },
      cursor: "c50",
      more: true,
    });
    expect((first.outcome as { results: unknown[] }).results).toHaveLength(100);
    // A first sync tells the peer it holds nothing yet: no knownCursor.
    expect(requests[0]!.get("knownCursor")).toBeNull();

    requests.length = 0;
    await sync(hono, jobStore);
    expect(requests[0]!.get("cursor")).toBe("c50");
    expect(requests[0]!.get("knownCursor")).toBe("c50");
  });
});
