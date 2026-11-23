/**
 * @mnemo-ai/mock-server — offline dev mock (spec §35 line 4298).
 *
 * Exposes the same REST surface as @mnemo-ai/server with:
 *  - In-memory deterministic fixture responses (no DB, no Redis)
 *  - Zero infrastructure deps — suitable for `npx` usage
 *  - Core endpoints: /recall, /remember, /health,
 *    /usage, /sessions, /tasks, /events, /export
 *
 * Every API key is accepted (no auth enforcement in mock mode).
 */

import { Hono } from "hono";
import { createServer } from "node:http";
import type { Server } from "node:http";

// ── Fixture data ─────────────────────────────────────────────────────────────

let factStore: Array<{ id: string; statement: string; score: number }> = [
  {
    id: "mock-fact-0001",
    statement: "TypeScript generics enable type-safe reuse.",
    score: 0.91,
  },
  {
    id: "mock-fact-0002",
    statement: "Hexagonal architecture separates ports from adapters.",
    score: 0.87,
  },
  {
    id: "mock-fact-0003",
    statement: "Mnemosyne uses pgvector HNSW for semantic search.",
    score: 0.82,
  },
];

let factIdCounter = 4;

// ── App ──────────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();

  // Auth: accept any Bearer token (mock mode — no validation)
  app.use("*", async (c, next) => {
    await next();
  });

  // POST /recall
  app.post("/recall", (c) => {
    return c.json({ hits: factStore.slice(0, 5), total: factStore.length });
  });

  // POST /remember
  app.post("/remember", async (c) => {
    const body = (await c.req.json().catch(() => {})) as { statement?: string };
    const id = `mock-fact-${String(factIdCounter++).padStart(4, "0")}`;
    factStore.push({ id, statement: body?.statement ?? "(empty)", score: 0.75 });
    return c.json({ id, status: "created" }, 201);
  });

  // GET /health (also /health/ready)
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: "3.0.0-mock",
      tiers: { hot: "ok", cold: "ok", vector: "ok" },
    });
  });

  app.get("/health/ready", (c) => {
    return c.json({ status: "ok" });
  });

  // GET /usage
  app.get("/usage", (c) => {
    return c.json({
      recall: { used: 42, limit: 1000 },
      write: { used: 7, limit: 1000 },
      storage_gb: { used: 0.001, limit: 10 },
    });
  });

  // GET /sessions
  app.get("/sessions", (c) => {
    return c.json({ items: [], total: 0 });
  });

  // GET /tasks
  app.get("/tasks", (c) => {
    return c.json({ items: [], total: 0 });
  });

  // GET /events
  app.get("/events", (c) => {
    return c.json({ items: [], total: 0 });
  });

  // GET /export — JSONL stream of all facts
  app.get("/export", (c) => {
    const lines = factStore.map((f) => JSON.stringify(f)).join("\n");
    return new Response(lines, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  // 404 fallback
  app.notFound((c) => {
    return c.json(
      { error: { type: "not_found_error", code: "not_found", message: "Not found" } },
      404
    );
  });

  return app;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface MockApp {
  app: { server: Server };
  port: number;
}

/**
 * Create and start the mock server on the given port (0 = random).
 * Returns the app handle and the bound port number.
 */
export async function createMockApp(port = 3999): Promise<MockApp> {
  const honoApp = buildApp();

  return new Promise((resolve, reject) => {
    // Create a plain Node.js HTTP server driven by Hono's fetch handler
    const server = createServer(async (req, res) => {
      // Build a Request from the Node IncomingMessage
      const url = `http://localhost${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }

      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Buffer[] = [];
        for await (const chunk of req as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }

      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        body: body?.length ? (body as BodyInit) : undefined,
      });

      const response = await honoApp.fetch(request);

      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ app: { server }, port: addr.port });
    });
  });
}
