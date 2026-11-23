# @mnemo-ai/client-ts

**English** · [Español](README.es.md)

> The typed TypeScript client for the [Mnemosyne](https://github.com/lucasmailland/mnemosyne) HTTP API, cognitive memory for AI agents. No runtime dependencies beyond `fetch`.
>
> [Repository](https://github.com/lucasmailland/mnemosyne) · [API reference](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/API.md) · [Status](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Zero runtime dependencies. Works in Node 20+, Bun, Deno, Cloudflare Workers, and modern browsers. It talks to a Mnemosyne server over HTTP, so your app never embeds the engine or touches the database.

> **Needs a running Mnemosyne server and an API key.** The [quickstart](https://github.com/lucasmailland/mnemosyne#quickstart) starts one with Docker in a few minutes.

## Install

```bash
pnpm add @mnemo-ai/client-ts
# or
npm i @mnemo-ai/client-ts
```

## 30-second start

```ts
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const memory = new MnemosyneClient({
  url: "https://memory.example.com",
  apiKey: process.env.MNEMO_KEY!,
});

const { hits } = await memory.recall({ query: "user email preferences" });
console.log(hits);
```

## Examples

### 1. Basic recall

```ts
const result = await memory.recall({
  query: "Acme's preferred communication language",
  topK: 5,
});

for (const hit of result.hits) {
  console.log(`${hit.score.toFixed(2)} — ${hit.content}`);
}
```

### 2. Recall with a pre-embedded vector

Useful when you already have the query vector from a shared embedding cache, or you want to use a non-default embedding model. The server skips its own embedding pass when you pass `vector`.

```ts
import OpenAI from "openai";

const openai = new OpenAI();
const { data } = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: "billing escalation policy",
});

const result = await memory.recall({
  query: "billing escalation policy",
  vector: data[0].embedding,
  topK: 10,
});
```

### 3. Create a fact

`createFact` is idempotent via content-hash on the server — re-sending the same content won't duplicate. The response is the created `Fact` (including its assigned `id`).

```ts
const result = await memory.createFact({
  content: "Acme prefers communication in Spanish.",
  attribution: { source: "user_stated" },
  tags: ["client:acme"],
});

console.log("stored fact:", result.id);
```

### 4. Time-travel recall with `asOf`

Ask what memory knew at a past instant — useful for replaying historical agent decisions and for audit trails.

```ts
const snapshot = await memory.recall({
  query: "team escalation owner",
  asOf: "2026-01-15T00:00:00Z",
  topK: 3,
});
// `snapshot.hits` reflects facts as they existed on Jan 15, 2026.
```

### 5. Error handling

The SDK throws a typed error hierarchy. Branch on the class — not the message — for resilient retry/UX logic.

```ts
import {
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";

try {
  await memory.recall({ query: "anything" });
} catch (err) {
  if (err instanceof MnemosyneTimeoutError) {
    // Server is alive but slow — degrade gracefully.
  } else if (err instanceof MnemosyneAPIError && err.status === 401) {
    // Rotate API key.
  } else if (err instanceof MnemosyneNetworkError) {
    // DNS / TLS / connection refused. Retry or fail open.
  } else if (err instanceof MnemosyneAPIError) {
    console.error(`Mnemosyne ${err.status} [${err.code}] ${err.requestId}`);
    throw err;
  }
}
```

## Configuration

```ts
new MnemosyneClient({
  url: "https://memory.example.com",
  apiKey: process.env.MNEMO_KEY!,

  // Inject a custom fetch (defaults to global fetch). Useful in tests
  // or when wrapping for tracing.
  fetch: undici.fetch,

  // Per-request timeout in milliseconds. Default 30_000.
  timeout: 10_000,

  // Retry policy for transient failures (5xx + network errors).
  // Default: 3 attempts, exponential backoff with full jitter (200ms,
  // 400ms, 800ms). 4xx errors and timeouts are NOT retried by default.
  retry: {
    attempts: 5,
    initialDelayMs: 100,
    shouldRetry: (err, attempt) => attempt < 5,
  },

  // Optional User-Agent suffix to distinguish traffic in server logs.
  userAgent: "my-app/1.2.3",

  // Optional locale tag (e.g. "es-419"), sent as Accept-Language on every
  // request so the server localizes error messages. Omit to send no header.
  locale: "es-419",
});
```

## API

| Method                                                   | HTTP                                             | Description                                                       |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `recall(input)`                                          | `POST /recall`                                   | Top-K relevant facts                                              |
| `createFact(input)`                                      | `POST /remember`                                 | Persist a new fact (idempotent)                                   |
| `getFact(id)`                                            | `GET /facts/:id`                                 | Fetch one fact                                                    |
| `pinFact(id)` / `unpinFact(id)`                          | `POST /facts/:id/pin` (`{ pinned: true/false }`) | Protect from auto-prune; ranking is unchanged                     |
| `forgetFact(id)`                                         | `DELETE /facts/:id`                              | Soft-delete (bitemporal close)                                    |
| `timeline(input)`                                        | `GET /timeline`                                  | Recent fact activity                                              |
| `health()`                                               | `GET /health`                                    | Liveness + per-component readiness                                |
| `listAgentPolicies()`                                    | `GET /admin/agent-policies`                      | Every agent RBAC policy of the workspace (`memory:admin`)         |
| `getAgentPolicy(agentId)` / `deleteAgentPolicy(agentId)` | `GET` / `DELETE /admin/agent-policy?agentId=`    | Read or delete one agent's policy                                 |
| `putAgentPolicy(input)`                                  | `PUT /admin/agent-policy`                        | Create or replace one agent's policy; a key cannot change its own |

## When to use this vs. `@mnemo-ai/core`

| Pick `@mnemo-ai/client-ts` if…                          | Pick `@mnemo-ai/core` directly if…                               |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| You're talking to a shared memory server from many apps | You want sub-millisecond in-process recall                       |
| Your runtime can't host Postgres / pgvector / Drizzle   | You already have a Postgres pool and want to reuse it            |
| You need a stable wire contract across engine refactors | You want the full hookable internals (extraction, consolidation) |

## License

Apache-2.0 © Lucas Mailland
