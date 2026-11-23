# @mnemo-ai/mock-server

**English** · [Español](README.es.md)

> **AI pointer:** Deterministic offline mock of a subset of the Mnemosyne HTTP API. Runs in-memory with no DB or Redis required — designed for local dev and CI tests that need a real HTTP server without infrastructure.
>
> **Depends on:** hono
>
> **Exposes:** `createMockApp` (ESM export) · `mnemo-mock` (CLI binary)
>
> **Status:** ALPHA — version 3.0.0-alpha.0
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.md](../client-ts/README.md)

`@mnemo-ai/mock-server` is a lightweight in-memory HTTP server that fakes a subset of the Mnemosyne API. It ships with three deterministic seed facts and accepts any Bearer token without validation. No Postgres, no Redis, no environment variables required.

**Mocked routes (exactly what `app.ts` implements):**

| Route               | Method | Behavior                                                                         |
| ------------------- | ------ | -------------------------------------------------------------------------------- |
| `POST /recall`      | POST   | Returns up to 5 in-memory facts as `{ hits, total }`                             |
| `POST /remember`    | POST   | Appends a fact to the in-memory store, returns `{ id, status: "created" }` (201) |
| `GET /health`       | GET    | Returns `{ status: "ok", version: "3.0.0-mock", tiers: { hot, cold, vector } }`  |
| `GET /health/ready` | GET    | Returns `{ status: "ok" }`                                                       |
| `GET /usage`        | GET    | Returns fixed quota counters                                                     |
| `GET /sessions`     | GET    | Returns `{ items: [], total: 0 }`                                                |
| `GET /tasks`        | GET    | Returns `{ items: [], total: 0 }`                                                |
| `GET /events`       | GET    | Returns `{ items: [], total: 0 }`                                                |
| `GET /export`       | GET    | Returns in-memory facts as NDJSON (`application/x-ndjson`)                       |
| Everything else     | any    | 404 JSON error                                                                   |

This is a **subset** of the full server API. Routes like `/facts`, `/timeline`, and all authenticated write endpoints other than `remember` are not implemented. If you need those, run `@mnemo-ai/server` locally.

## Running the mock server

### Via npx (no install)

```bash
npx @mnemo-ai/mock-server
# → mnemo-mock server running on http://127.0.0.1:3999
```

### Specifying a port

```bash
npx @mnemo-ai/mock-server --port=4000
```

The default port is **3999**. Pass `--port=0` to bind to a random free port (useful in tests).

### Via pnpm (from the repo)

```bash
pnpm --filter @mnemo-ai/mock-server start
# or after building:
node packages/mock-server/dist/index.js --port=3999
```

## Using `createMockApp` in tests

Import the app factory directly to get programmatic control over the port and to close the server when the test finishes:

```ts
import { createMockApp } from "@mnemo-ai/mock-server";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app, port } = await createMockApp(0); // 0 = random free port
  server = app.server as Server;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

it("recalls facts", async () => {
  const res = await fetch(`${baseUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer any_key" },
    body: JSON.stringify({ query: "TypeScript" }),
  });
  const body = await res.json();
  expect(body.hits.length).toBeGreaterThan(0);
});
```

`createMockApp(port?: number)` returns `Promise<{ app: { server: Server }, port: number }>`. The `port` field reflects the actually-bound port, which differs from the argument when you pass `0`.

## Authentication

The mock server accepts **any** Bearer token. No key validation is performed. This is intentional — the mock is for local dev and automated tests only.

## Seed data

The server starts with three deterministic in-memory facts:

```
mock-fact-0001  TypeScript generics enable type-safe reuse.         (score: 0.91)
mock-fact-0002  Hexagonal architecture separates ports from adapters. (score: 0.87)
mock-fact-0003  Mnemosyne uses pgvector HNSW for semantic search.     (score: 0.82)
```

`POST /remember` appends new facts to the in-memory store for the lifetime of the process. The store resets on restart.

## Running tests

```bash
pnpm --filter @mnemo-ai/mock-server test
```

## Requirements

Node.js >= 20.0.0

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
