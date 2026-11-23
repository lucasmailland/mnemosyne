/**
 * P127 — `/health/ready` reports what it MEASURED, not a constant.
 *
 * Found by stopping containers one at a time. With ollama down, 100% of reads
 * and writes returned 500 and this endpoint answered
 * `{"status":"ready","degraded":false,"checks":{...,"cache":"ok"}}`. With redis
 * stopped it still said `cache: "ok"`. Only Postgres was ever noticed.
 *
 * The cause was one `??` per dependency:
 *
 *   adapters?.cache?.healthCheck() ?? Promise.resolve({ status: "ok" })
 *
 * `adapters` is `deps.healthAdapters`, and nothing in production populated it —
 * the identifier existed in this route and in three TEST files that inject it.
 * So `vector` and `cache` were literals, `degraded` was computed from literals
 * and could never be true, and the alerting branch it guards was unreachable.
 *
 * The existing tests all INJECT healthAdapters, which is why they passed: they
 * prove the logic works if you hand it adapters, never that anything does.
 * This file therefore asserts two different things — that a wired adapter's
 * verdict REACHES the response (it can change), and that an unwired one reports
 * `unknown` rather than `ok` (absent is not healthy).
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mountProbes } from "../../routes/health.js";
import type { ServerDeps } from "../../deps.js";

const okAdapter = () => ({ healthCheck: vi.fn(async () => ({ status: "ok", latencyMs: 1 })) });
const downAdapter = () => ({ healthCheck: vi.fn(async () => ({ status: "down", latencyMs: 1 })) });

function appWith(healthAdapters: Record<string, unknown> | undefined) {
  const app = new Hono();
  mountProbes(app, {
    storage: okAdapter(),
    bus: undefined,
    ...(healthAdapters ? { healthAdapters } : {}),
  } as unknown as ServerDeps);
  return app;
}

async function ready(app: Hono) {
  const res = await app.request("/health/ready");
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("P127 — the readiness check can actually change", () => {
  it("reports ok for every dependency when all are healthy", async () => {
    const { status, body } = await ready(
      appWith({
        storage: okAdapter(),
        vector: okAdapter(),
        cache: okAdapter(),
        embed: okAdapter(),
      })
    );

    expect(status).toBe(200);
    expect(body.degraded).toBe(false);
    expect(body.checks).toMatchObject({
      postgres: "ok",
      vector: "ok",
      cache: "ok",
      embed: "ok",
    });
  });

  for (const dep of ["vector", "cache", "embed"] as const) {
    it(`a down ${dep} reaches the response and flips degraded`, async () => {
      // THE test. Before the fix, `vector` and `cache` could not move off "ok"
      // no matter what the adapter said, and `embed` was not consulted at all.
      // If a check cannot change, it is not a check.
      const adapters: Record<string, unknown> = {
        storage: okAdapter(),
        vector: okAdapter(),
        cache: okAdapter(),
        embed: okAdapter(),
      };
      adapters[dep] = downAdapter();

      const { status, body } = await ready(appWith(adapters));

      expect(status).toBe(200); // still serving — this is not a 503 case
      expect((body.checks as Record<string, string>)[dep]).toBe("down");
      expect(body.degraded, `a down ${dep} did not mark the instance degraded`).toBe(true);
    });
  }

  it("a 503 from /health/ready tells the caller when to retry (V-3)", async () => {
    const { status, retryAfter } = await (async () => {
      const res = await appWith({ storage: downAdapter() }).request("/health/ready");
      return { status: res.status, retryAfter: res.headers.get("Retry-After") };
    })();
    expect(status).toBe(503);
    expect(retryAfter).toBe("5");
  });

  it("an UNWIRED adapter reports unknown, never ok", async () => {
    // The inversion that caused the whole thing, and the same one as P120:
    // absent means "nobody looked". Reporting `ok` there is an assurance about
    // a dependency that was never contacted.
    const { body } = await ready(appWith({ storage: okAdapter() }));

    const checks = body.checks as Record<string, string>;
    expect(checks.vector).toBe("unknown");
    expect(checks.cache).toBe("unknown");
    expect(checks.embed).toBe("unknown");
    // And unknown is not health: an instance nobody has probed is degraded.
    expect(body.degraded).toBe(true);
  });

  it("does not query workspace webhooks when readiness is degraded", async () => {
    const listWebhookEndpoints = vi.fn();
    const storage = {
      healthCheck: vi.fn(async () => ({ status: "ok", latencyMs: 1 })),
      listWebhookEndpoints,
    };
    const app = new Hono();
    mountProbes(app, {
      storage,
      bus: undefined,
      healthAdapters: {
        storage,
        vector: downAdapter(),
        cache: okAdapter(),
        embed: okAdapter(),
      },
    } as unknown as ServerDeps);

    const { status, body } = await ready(app);

    expect(status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(listWebhookEndpoints).not.toHaveBeenCalled();
  });

  it("still 503s when Postgres is down, and does not call it degraded-but-ready", async () => {
    // The one check that always worked. Kept here so the fix cannot regress it
    // while making the others honest.
    const { status, body } = await ready(
      appWith({
        storage: { healthCheck: vi.fn(async () => ({ status: "down", latencyMs: 1 })) },
        vector: okAdapter(),
        cache: okAdapter(),
        embed: okAdapter(),
      })
    );

    expect(status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.reason).toBe("postgres_unavailable");
  });

  it("the adapters are really called — the route does not answer from a cache", async () => {
    const cache = okAdapter();
    const embed = okAdapter();
    await ready(appWith({ storage: okAdapter(), vector: okAdapter(), cache, embed }));

    expect(cache.healthCheck).toHaveBeenCalled();
    expect(embed.healthCheck).toHaveBeenCalled();
  });
});

describe("P127 — the boot path actually wires the probes", () => {
  /**
   * The other half, and the half that was missing for the entire life of this
   * endpoint: the route's logic was fine, nothing ever handed it adapters.
   *
   * Asserted against the SOURCE of index.ts rather than by booting a server,
   * because booting requires Postgres/Redis/ollama and this must fail in plain
   * `pnpm test` — the same run where someone deleting the wiring would
   * otherwise see green. It is a coarse check on purpose: it cannot verify the
   * adapters work, only that the boot path passes them, which is precisely
   * what was absent.
   */
  it("index.ts passes storage, vector, cache AND embed to healthAdapters", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"),
      "utf8"
    );

    const block = src.slice(src.indexOf("healthAdapters:"), src.indexOf("healthAdapters:") + 600);
    expect(src).toContain("healthAdapters:");
    for (const dep of ["storage:", "vector:", "cache:", "embed:"]) {
      expect(block, `boot does not wire ${dep} into healthAdapters`).toContain(dep);
    }
  });

  it("ServerDeps declares healthAdapters, so the wiring is type-checked", () => {
    // It used to exist only as a local widening on the route's signature
    // (`ServerDeps & { healthAdapters?: … }`), which is why nothing in the
    // shared contract ever mentioned it and no one noticed it was unset.
    const deps = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deps.ts"),
      "utf8"
    );
    expect(deps).toContain("healthAdapters?:");
  });
});
