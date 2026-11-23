/**
 * Retry-After through the real app (createApp): the wait a client is told is
 * the one the server knows — the limiter's bucket refill or its concurrency
 * wait for a 429 (CLIENTS-7, WP-2), and a short pause for a database that is
 * down or too slow right now (CHAOS-10) — in the header AND in the envelope's
 * `retryAfterSeconds`. Never the old hardcoded 60 when a real value exists.
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";

import { createApp } from "../app.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";

const PLAINTEXT_KEY = "mns_live_retryaftertestkey000000001";
const WS_ID = "00000000-0000-0000-0000-000000000077";

async function keyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      {
        id: "key-retry",
        keyHash,
        workspaceId: WS_ID,
        scopes: ["memory:read", "memory:write", "admin:keys"],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

type Backend = NonNullable<ServerDeps["rateLimitBackend"]>;

function backend(over: Partial<Backend> = {}): Backend {
  return {
    healthy: true,
    consumeToken: async () => ({ allowed: true, remaining: 99, resetSeconds: 60 }),
    acquireSlot: async () => ({ acquired: true, inFlight: 1 }),
    releaseSlot: async () => {},
    ...over,
  } as Backend;
}

/** A storage port whose every call fails the way a stopped Postgres does. */
function downStorage(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return async () => {
          throw new Error("Failed query: select …", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
              code: "ECONNREFUSED",
            }),
          });
        };
      },
    }
  );
}

async function buildApp(rateLimitBackend: Backend, storage?: unknown, fleetUtil?: () => number) {
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys: await keyLookup(),
    rateLimitBackend,
    ...(storage ? { storage } : {}),
    ...(fleetUtil ? { fleetUtil } : {}),
    llm: undefined,
    embedModel: "text-embedding-3-small",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
  } as unknown as ServerDeps;
  return createApp({ deps, version: "0.0.0-test" });
}

const headers = {
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
};

interface Envelope {
  error: {
    code: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}

describe("Retry-After through createApp", () => {
  it("a token-bucket 429 carries the bucket's refill time, not 60", async () => {
    const app = await buildApp(
      backend({ consumeToken: async () => ({ allowed: false, remaining: 0, resetSeconds: 13 }) })
    );
    const res = await app.request("/facts", { headers });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("13");
    const body = (await res.json()) as Envelope;
    expect(body.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterSeconds: 13,
    });
    expect(body.error.details).toMatchObject({ retryAfterSeconds: 13, reason: "request_rate" });
  });

  it("a concurrency 429 carries the 1 s concurrency wait, not 60", async () => {
    const app = await buildApp(
      backend({ acquireSlot: async () => ({ acquired: false, inFlight: 10 }) })
    );
    const res = await app.request("/facts", { headers });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = (await res.json()) as Envelope;
    expect(body.error.retryAfterSeconds).toBe(1);
    expect(body.error.details).toMatchObject({ retryAfterSeconds: 1, reason: "concurrency" });
  });

  it("a database outage is a retryable 503 with Retry-After in the header and the envelope", async () => {
    const app = await buildApp(backend(), downStorage());
    const res = await app.request("/facts", { headers });
    expect(res.status).toBe(503);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(retryAfter).not.toBe("60");
    const body = (await res.json()) as Envelope;
    expect(body.error).toMatchObject({ code: "service_unavailable", retryable: true });
    expect(body.error.retryAfterSeconds).toBe(Number(retryAfter));
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  it("the server's fleet utilization sheds normal routes at 70% and spares important ones", async () => {
    const app = await buildApp(backend(), undefined, () => 0.75);
    const shed = await app.request("/admin/keys", { headers });
    expect(shed.status).toBe(503);
    expect(shed.headers.get("Mnemosyne-Rate-Limited-Reason")).toBe("fleet_shed");
    expect(shed.headers.get("Retry-After")).toBe("5");
    const kept = await app.request("/facts", { headers });
    expect(kept.headers.get("Mnemosyne-Rate-Limited-Reason")).toBeNull();
  });
});
