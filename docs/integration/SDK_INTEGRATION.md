# Mnemosyne — Integration Guide

**English** · [Español](SDK_INTEGRATION.es.md)

How a program talks to a Mnemosyne server: which transports exist, which client packages
ship, and how each one behaves, taken from the code. The endpoint contract is in
[docs/architecture/API.md](../architecture/API.md).

---

## Table of Contents

1. [Integration Methods Overview](#1-integration-methods-overview)
2. [Embedded Mode — `@mnemo-ai/core`](#2-embedded-mode--mnemo-aicore)
3. [REST API Client — `@mnemo-ai/client-ts` and SDKs](#3-rest-api-client--mnemo-aiclient-ts-and-sdks)
4. [MCP Integration — AI Agents](#4-mcp-integration--ai-agents)
5. [gRPC Integration — Service-to-Service](#5-grpc-integration--service-to-service)
6. [WebSocket Integration — Real-Time Subscriptions](#6-websocket-integration--real-time-subscriptions)
7. [CLI Integration — `mnemo` binary](#7-cli-integration--mnemo-binary)
8. [Agent Framework Integrations](#8-agent-framework-integrations)
9. [Provider Configuration](#9-provider-configuration)
10. [Client-Side Resilience](#10-client-side-resilience)
11. [Event Consumption Decision Tree](#11-event-consumption-decision-tree)
12. [Multi-Transport Composition](#12-multi-transport-composition)
13. [Memory Protocol (Agent System Prompt)](#13-memory-protocol-agent-system-prompt)

---

## 1. Integration Methods Overview

Everything goes through one server process: REST, ConnectRPC and the WebSocket share its
port (`PORT`, 3939 by default). MCP is a separate stdio process that calls the REST API.

### Comparison Table

| Method        | Package                                              | Use case                                        | Auth                                  | Streaming                   |
| ------------- | ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------- | --------------------------- |
| **REST**      | `@mnemo-ai/client-ts` / `mnemo-ai-sdk` (Python) / Go | Web apps, backends, scripts, CI                 | `Authorization: Bearer <key>`         | No                          |
| **MCP stdio** | `@mnemo-ai/mcp`                                      | AI agents (Claude Desktop, Cursor, Windsurf, …) | `MNEMO_KEY` in the MCP client config  | No                          |
| **gRPC**      | ConnectRPC in `@mnemo-ai/server`                     | Services that want protobuf or server streaming | `authorization: Bearer <key>` header  | Server and client streaming |
| **WebSocket** | `GET /memory/ws` in `@mnemo-ai/server`               | Live dashboards and feeds                       | `?token=<key>` query parameter        | Push                        |
| **CLI**       | `@mnemo-ai/cli` (`mnemo`)                            | Shell use, scripting, admin                     | `MNEMO_KEY` or `~/.mnemo/config.json` | No                          |

### Decision Tree: Which Integration Should I Use?

```
Are you an AI agent with tool use?
├── Yes → MCP (@mnemo-ai/mcp over stdio, pointed at a running server)
│
└── No
    ├── Do you need real-time push (live UI, graph viewer)?
    │   └── Yes → WebSocket (GET /memory/ws)
    │
    ├── Do you want protobuf or a server stream from a service?
    │   └── Yes → ConnectRPC (section 5; bidirectional needs MNEMO_GRPC_PORT)
    │
    ├── Are you scripting or administering from a shell?
    │   └── Yes → CLI (mnemo)
    │
    └── Everything else → REST (TypeScript, Python or Go client)
```

---

## 2. Embedded Mode — `@mnemo-ai/core`

There is no supported embedded mode for applications. `@mnemo-ai/core` and the adapters
(`@mnemo-ai/adapter-postgres`, `-redis`, `-vector`, `-llm`) are private workspace packages,
not published to npm; they run inside the server.

Inside the monorepo, `createCore(deps, config)` (exported from `@mnemo-ai/core/cognitive`)
builds the engine from injected ports: `storage`, `vector`, `embed`, `outbox`, `logger` and
`telemetry` are required; `cache`, `llm`, `queue` and `auth` are optional. It takes no
database URL, opens no connection and runs no migrations. The server does this wiring in
`packages/server/src/index.ts`; the details are in
[packages/core/README.md](../../packages/core/README.md).

---

## 3. REST API Client — `@mnemo-ai/client-ts` and SDKs

All three clients send `Authorization: Bearer <key>` and call the routes at the root of the
server (no `/v1` prefix).

### TypeScript SDK

#### Installation and Initialization

```bash
bun add @mnemo-ai/client-ts
```

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({
  url: "http://localhost:3939", // Self-hosted default (note: "url" not "baseUrl")
  apiKey: "mk_live_abc123",
});
```

Other options: `timeout` (ms, default 30 000), `retry` (`{ attempts, initialDelayMs, shouldRetry }`),
`userAgent`, `workspaceId` (for a `uk_live_` user token), `locale` (sent as
`Accept-Language`) and `fetch`.

#### Core Operations

```typescript
// Recall — returns { hits: RecallHit[] }
const { hits } = await mnemo.recall({
  query: "What do we know about Redis caching?",
  topK: 5,
});
for (const h of hits) console.log(`[${h.score.toFixed(3)}] ${h.content}`);

// Remember / create a fact
const fact = await mnemo.createFact({
  content: "PostgreSQL is the primary datastore",
});

// Forget a fact
await mnemo.forgetFact("fact_xyz");

// Export workspace
const exported = await mnemo.exportWorkspace();
```

`exportWorkspace()` returns one JSON object: `meta` plus arrays such as `facts` and
`decisions`, without embeddings.

#### Idempotency

```typescript
// Idempotency: pass a stable key as the 3rd argument to avoid duplicate writes on retry
const fact = await mnemo.createFact(
  { content: "Redis 8.0 is deployed" },
  undefined, // AbortSignal (optional)
  crypto.randomUUID() // idempotency key
);
```

#### Error Handling

```typescript
import {
  MnemosyneError,
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";

try {
  await mnemo.createFact({ content: "Redis is optional" });
} catch (error) {
  if (error instanceof MnemosyneAPIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else if (error instanceof MnemosyneNetworkError) {
    console.error(`Network error: ${error.message}`);
  } else if (error instanceof MnemosyneTimeoutError) {
    console.error(`Request timed out`);
  } else if (error instanceof MnemosyneError) {
    console.error(`Mnemosyne error: ${error.message}`);
  }
}
```

`health()` calls `GET /health` and `healthReady()` calls `GET /health/ready`; the client
does no background health checks and emits no events.

### Python SDK

```bash
# Not on PyPI yet: install from the repository
pip install "git+https://github.com/lucasmailland/mnemosyne.git#subdirectory=packages/sdk-python"
```

```python
from mnemo import MnemosyneClient, AsyncMnemosyneClient
from mnemo import MnemosyneAPIError, MnemosyneNetworkError
import asyncio

# Sync client
client = MnemosyneClient(
    url="http://localhost:3939",
    api_key="mk_live_abc123",
    timeout=30.0,
    max_retries=3,
)

# Recall — returns a plain dict; hits are at result["hits"]
result = client.recall(
    query="What do we know about Redis caching?",
    top_k=5,
)
for hit in result["hits"]:
    print(f"[{hit['score']:.3f}] {hit['content']}")

# Create a fact (flat method, not client.facts.create)
fact = client.create_fact("PostgreSQL is the primary datastore")

# Forget a fact
client.forget_fact("fact_xyz")


# Async client
async def main():
    async_client = AsyncMnemosyneClient(
        url="http://localhost:3939",
        api_key="mk_live_abc123",
    )
    try:
        result = await async_client.recall(query="Redis caching")
        for hit in result["hits"]:
            print(f"[{hit['score']:.3f}] {hit['content']}")
    except MnemosyneAPIError as e:
        print(f"API error {e.status}: {e.message}")
    except MnemosyneNetworkError as e:
        print(f"Network error: {e}")

asyncio.run(main())
```

### Go SDK

`packages/sdk-go` (module `github.com/lucasmailland/mnemosyne/packages/sdk-go`) is a REST
client built on `net/http`.

```go
import "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"

// NewClient returns (*Client, error) — no functional options
client, err := mnemo.NewClient("http://localhost:3939", "mk_live_abc123")
if err != nil {
    log.Fatal(err)
}

ctx := context.Background()

// Recall — response.Hits is []map[string]interface{}
response, err := client.Recall(ctx, mnemo.RecallInput{
    Query: "deploy process",
    TopK:  5,
})
if err != nil {
    var apiErr *mnemo.APIError
    if errors.As(err, &apiErr) {
        log.Printf("API error %d: %s", apiErr.Status, apiErr.Message)
    }
    return err
}
for _, hit := range response.Hits {
    fmt.Printf("[%.3f] %v\n", hit["score"], hit["content"])
}

// Create a fact (flat method on *Client)
fact, err := client.CreateFact(ctx, mnemo.FactInput{
    Content: "PostgreSQL is the primary datastore",
})
if err != nil {
    return err
}
_ = fact

// Forget a fact
if err := client.ForgetFact(ctx, "fact_xyz"); err != nil {
    return err
}
```

---

## 4. MCP Integration — AI Agents

`@mnemo-ai/mcp` is a separate process: an MCP server over stdio that forwards every tool
call to a running Mnemosyne server through `@mnemo-ai/client-ts`. The Mnemosyne server
does not serve MCP itself, and there is no HTTP transport for MCP. It reads `MNEMO_URL`
and `MNEMO_KEY` (both required), plus the optional `MNEMO_WORKSPACE_ID` and `MNEMO_LOCALE`.

### 4a. Client Configuration

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "mk_live_abc123"
      }
    }
  }
}
```

#### Cursor, Windsurf, Continue and other clients

The same block: `command: "npx"`, `args: ["-y", "@mnemo-ai/mcp"]`, and `MNEMO_URL` and
`MNEMO_KEY` in `env`. Cursor reads it from `~/.cursor/mcp.json` or `.cursor/mcp.json`;
Windsurf from `~/.codeium/windsurf/mcp_config.json`. `mnemo install` in the CLI installs
the MCP server into every AI coding agent it detects.

#### What the Agent Sees

All 37 tools by default, among them `memory_recall`, `memory_remember`, `memory_forget`,
`memory_pin`, `memory_decide`, `memory_entity`, `memory_relate`, `memory_episode_start` and
`memory_episode_end` (`MNEMO_MCP_TOOLS=core` trims the list to the 9 most used). The list, the schemas and the scope each one needs are in
[packages/mcp/README.md](../../packages/mcp/README.md) and
[docs/guides/MCP_TOOLS.md](../guides/MCP_TOOLS.md). In its initialize handshake the MCP
process also sends the memory protocol as `instructions` (section 13).

### 4b. Providers

The MCP process calls no LLM and computes no embeddings: extraction, embeddings and
consolidation run on the Mnemosyne server with the providers configured there (section 9).

---

## 5. gRPC Integration — Service-to-Service

**Transport**: ConnectRPC, served by `@mnemo-ai/server` under `/mnemosyne.v1.MnemosyneService/`
on the same port as REST. The service is defined in
`packages/server/proto/mnemosyne.proto`.

The main listener is `node:http` on `PORT`: HTTP/1.1, no TLS. With `MNEMO_GRPC_PORT` set,
the server also listens on that port with cleartext HTTP/2 (h2c), serving only this service
([SERVICES.md](../deploy/SERVICES.md) §1):

| Protocol                                    | Unary | Server streaming | Client streaming | Bidirectional |
| ------------------------------------------- | :---: | :--------------: | :--------------: | :-----------: |
| Connect or gRPC-Web on `PORT`               |  Yes  |       Yes        |       Yes        | No (HTTP 505) |
| gRPC on `PORT`                              |  No   |        No        |        No        |      No       |
| Any of the three on h2c (`MNEMO_GRPC_PORT`) |  Yes  |       Yes        |       Yes        |      Yes      |

So `Session` and `FederationSync`, the two bidirectional RPCs, need `MNEMO_GRPC_PORT`; without
it they cannot be called over the network. Keys of the `mk_*` scoped scheme are refused; the default keys work. The
repository ships no generated client: generate one from the `.proto` (the server's own
TypeScript stubs are in `packages/server/src/gen/`). The proto sets no `go_package`, and no
Go stubs ship; from Go, use the REST client in section 3.

`FederationSync` answers `Unimplemented` to every key, whatever the transport: federation is
pull-only, and a pull starts with `POST /memory/federation/sync`
([FEDERATION.md](../architecture/FEDERATION.md) §14).

### Connection Setup (TypeScript)

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
// Generated from packages/server/proto/mnemosyne.proto (protoc-gen-es)
import { MnemosyneService } from "./gen/mnemosyne_pb.js";

const client = createClient(
  MnemosyneService,
  createConnectTransport({ baseUrl: "http://localhost:3939", httpVersion: "1.1" })
);
const headers = { authorization: "Bearer mns_live_..." };

// Unary
const { results } = await client.recall({ query: "deploy process", limit: 5 }, { headers });
for (const item of results) console.log(`[${item.worth.toFixed(2)}] ${item.content}`);

const remembered = await client.remember(
  { content: "PostgreSQL is the primary datastore", type: "fact", topicKey: "infra/datastore" },
  { headers }
);
if (remembered.conflictDetected) console.warn(`conflict on ${remembered.id}`);

// Server streaming
for await (const event of client.watchMemory({ channels: ["facts.*"] }, { headers })) {
  console.log(event.channel, event.type);
}

// Client streaming
async function* items() {
  yield { content: "Larkspur Robotics ships on Fridays", type: "fact" };
}
const summary = await client.ingestBatch(items(), { headers });
console.log(`accepted=${summary.accepted} rejected=${summary.rejected}`);
```

For a bidirectional RPC, point an HTTP/2 transport at `MNEMO_GRPC_PORT` (50051 here):

```typescript
import { createGrpcTransport } from "@connectrpc/connect-node";

const h2 = createClient(
  MnemosyneService,
  createGrpcTransport({ baseUrl: "http://localhost:50051" })
);
async function* frames() {
  yield { payload: { case: "controlFrame" as const, value: 'start {"agentId":"acme-agent"}' } };
  yield { payload: { case: "userTurn" as const, value: "Larkspur Robotics ships on Fridays" } };
}
for await (const reply of h2.session(frames(), { headers })) console.log(reply.payload);
// started:<session id>, then ack:<turn length>
```

`createConnectTransport({ httpVersion: "1.1" })` is the transport the server's own test
uses (`packages/server/src/__tests__/unit/grpc-read-max-bytes.test.ts`); the HTTP/2 one is in
`packages/server/src/__tests__/integration/grpc-h2c.integration.test.ts`. Each message is
capped at 1 MiB. The scope each RPC needs is in
[SECURITY.md](../architecture/SECURITY.md) §3.

---

## 6. WebSocket Integration — Real-Time Subscriptions

**Endpoint**: `ws://host/memory/ws`

Use it for live dashboards and feeds. It is push-only: requests go over REST.

### Connection

Auth is via `?token=` query param — the server verifies it on upgrade and closes with code 1008 if missing or invalid. There is no header-based auth for WebSocket upgrades.

```typescript
// Token must be in the query string
const ws = new WebSocket("ws://localhost:3939/memory/ws?token=mk_live_abc123");
```

### Subscribe to Channels

The server protocol uses `{ subscribe: { channel, filter? } }` per-channel frames (not a single multi-channel action). Send one frame per channel you want:

```typescript
ws.onopen = () => {
  // Subscribe to each channel with a separate frame
  ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));
  ws.send(JSON.stringify({ subscribe: { channel: "tasks.*" } }));
  // Optional filter narrows events within the channel
  ws.send(
    JSON.stringify({
      subscribe: {
        channel: "facts.*",
        filter: { agentId: "agent_coder_01" }, // Only events from this agent
      },
    })
  );
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data: MnemoBusEvent — { id, channel, type, payload, timestamp, traceId }
  switch (data.type) {
    case "fact.created":
      updateFactList(data.payload);
      break;
    case "task.transitioned":
      updateTaskBoard(data.payload);
      break;
  }
};
```

The filter fields are `entityId`, `agentId` and `memoryType`. The socket only delivers
events of the token's workspace.

### React Dashboard Example

```typescript
import { useEffect, useRef, useState } from "react";

function useMnemosyneStream(channels: string[]) {
  const wsRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<MnemoEvent[]>([]);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    let retryDelay = 1000;

    function connect() {
      const ws = new WebSocket(
        `ws://localhost:3939/memory/ws?token=${process.env.NEXT_PUBLIC_MNEMO_KEY}`
      );

      ws.onopen = () => {
        retryDelay = 1000; // Reset on success

        if (lastEventIdRef.current) {
          // Reconnect with catch-up — server replays missed events
          ws.send(JSON.stringify({
            resubscribe: { channels, lastEventId: lastEventIdRef.current },
          }));
        } else {
          // Initial connect — subscribe per channel
          for (const channel of channels) {
            ws.send(JSON.stringify({ subscribe: { channel } }));
          }
        }
      };

      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === "ws.gap") {
          // Missed events — re-sync via REST
          syncMissedEvents(data.oldestAvailable);
        } else {
          lastEventIdRef.current = data.id;
          setEvents((prev) => [...prev.slice(-99), data]); // Keep last 100
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000); // Exponential backoff, max 30s
      };

      wsRef.current = ws;
    }

    connect();
    return () => wsRef.current?.close();
  }, [channels]);

  return events;
}

// Usage
function MemoryFeed() {
  const events = useMnemosyneStream(["facts.*", "tasks.*"]);
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>{e.type}: {JSON.stringify(e.payload)}</li>
      ))}
    </ul>
  );
}
```

### Event Replay on Reconnect

On reconnect, pass the last received `event.id` to recover missed events. Exact channels, wildcards (`tasks.*`, `*`) and domain aliases all work, and an event that matches several of your channels arrives once. The server keeps the last 200 events per workspace, for up to 1 hour, in Redis; without `MNEMO_REDIS_URL` nothing is kept and every resubscribe answers with a gap:

```typescript
ws.send(
  JSON.stringify({
    resubscribe: {
      channels: ["facts.*"],
      lastEventId: "evt_ws12_1717500000000_0042",
    },
  })
);

// The server then sends the missed events as ordinary event frames, oldest first,
// OR, when lastEventId is no longer buffered, one frame per channel:
// { type: "ws.gap", channel: "facts.*", oldestAvailable: "...", message: "..." }
// and you resync over REST.
```

The REST counterpart is `GET /memory/events?since=<eventId>&channel=<channel>`.

---

## 7. CLI Integration — `mnemo` binary

```bash
npm install -g @mnemo-ai/cli
```

The `mnemo` binary is HTTP-only: it talks to a running server. It reads `MNEMO_URL` and
`MNEMO_KEY` first, then `~/.mnemo/config.json` (`mnemo login` or `mnemo config set` write
it):

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mk_live_abc123
mnemo recall "what's our deploy process?"
mnemo recall --json "deploy" | jq '.hits[].content'
```

Every command, flag and output format is in [docs/guides/CLI.md](../guides/CLI.md).

---

## 8. Agent Framework Integrations

There are no adapter packages for agent frameworks (LangChain, the Vercel AI SDK, CrewAI,
AutoGen). Connect through MCP if the framework supports MCP tools, or call the REST client
around your model calls:

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({ url: "http://localhost:3939", apiKey: "mk_live_abc123" });

// Pattern: recall before each LLM call, remember after
async function agentStep(userMessage: string): Promise<string> {
  // 1. Recall relevant context — recall() returns { hits: RecallHit[] }
  const { hits } = await mnemo.recall({ query: userMessage, topK: 5 });
  const context = hits.map((h) => h.content).join("\n");

  // 2. Call the LLM with context injected
  const response = await llm.generate({
    system: `Context from memory:\n${context}`,
    messages: [{ role: "user", content: userMessage }],
  });

  // 3. Remember important information from the interaction
  if (response.decisionsFound) {
    await mnemo.createFact({ content: response.decisionsFound });
  }

  return response.content;
}
```

---

## 9. Provider Configuration

The server, not the client, holds the LLM and embedding configuration.

**Environment** (read at boot): `MNEMO_LLM_PROVIDER`, `MNEMO_LLM_MODEL`, `MNEMO_LLM_API_KEY`,
`MNEMO_LLM_BASE_URL`; `MNEMO_EMBED_PROVIDER`, `MNEMO_EMBED_MODEL`, `MNEMO_EMBED_API_KEY`,
`MNEMO_EMBED_BASE_URL`; and per-task overrides such as `MNEMO_LLM_JUDGE_PROVIDER` or
`MNEMO_LLM_SUMMARY_PROVIDER`. The full list is in
[docs/deploy/SERVICES.md](../deploy/SERVICES.md).

**At runtime**: `PUT /admin/config/llm` sets the instance-wide configuration and
`PUT /config/llm` a workspace's own; `GET` on either returns it with the key masked.
Writing the instance config needs `admin:workspace`, the workspace config `memory:admin`.
Storing an API key needs `MNEMO_MASTER_KEY` (501 without it).

```bash
curl -X PUT http://localhost:3939/config/llm \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "provider": "ollama", "embedModel": "nomic-embed-text", "llmModel": "llama3.1" }'
```

### Supported Providers

`packages/llm-providers/src/factory.ts` accepts:

| Provider    | Notes                                                    |
| ----------- | -------------------------------------------------------- |
| `openai`    | Also any OpenAI-compatible endpoint through the base URL |
| `anthropic` | No embeddings                                            |
| `google`    | Alias `gemini`                                           |
| `cohere`    |                                                          |
| `mistral`   |                                                          |
| `voyage`    |                                                          |
| `ollama`    | Local, no API key                                        |
| `bedrock`   | API key or IAM credentials                               |
| `nvidia`    | OpenAI-compatible NIM endpoint                           |

---

## 10. Client-Side Resilience

What the three REST clients do (`packages/client-ts/src/http.ts`,
`packages/sdk-python/mnemo/client.py`, `packages/sdk-go/mnemo/client.go`):

- **Retries**: TypeScript makes up to 3 attempts in all (`retry.attempts`); Python and Go
  retry up to 3 times after the first attempt (`max_retries`, `maxRetries`). The wait is
  full-jitter exponential backoff from a 200 ms base, or the server's `Retry-After` when it
  sends one. Retried: connection errors, 429 and 5xx (TypeScript), or 429, 500, 502, 503
  and 504 (Python and Go). Timeouts and other 4xx are not retried.
- **Replay safety**: only reads (`GET`, and `POST /recall`) and writes that carry an
  `Idempotency-Key` are retried. A write that failed with an unknown outcome is marked
  `outcomeUnknown` instead of being sent again.
- **Timeout**: 30 s per request by default.

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: process.env.MNEMO_KEY!,
  timeout: 10_000,
  retry: { attempts: 5, initialDelayMs: 500 },
});
```

There is no circuit breaker, request coalescing, offline write queue or background health
check in any client.

---

## 11. Event Consumption Decision Tree

```
Need real-time updates?
│
├── No
│   └── REST polling
│       Use: GET /memory/events?since=<eventId> (the WebSocket replay buffer; needs Redis)
│       or list the resources you care about on an interval
│
└── Yes — What kind of update?
    │
    ├── Push to an external system (Slack, GitHub, PagerDuty, your webhook)
    │   └── Webhooks (POST /webhooks to register an endpoint)
    │       HMAC-SHA256 signed. Retries after 5 m, 30 m, 2 h and 24 h,
    │       then dead letter after the 5th failed attempt.
    │
    ├── Live UI or dashboard
    │   └── WebSocket (ws://host/memory/ws)
    │       Per-channel subscriptions, catch-up from the last 200 events / 1 hour.
    │
    └── Internal service that processes events
        └── gRPC server streaming (WatchMemory, WatchTasks, StreamHealth)
            Over Connect or gRPC-Web on HTTP/1.1 (section 5).
```

---

## 12. Multi-Transport Composition

One application can use several transports at once against the same server and workspace;
they all read and write the same Postgres database.

- **The same key works on REST, ConnectRPC, the WebSocket and MCP**, except `mk_*` keys of
  the scoped scheme, which gRPC refuses.
- **Rate limits and idempotency keys are HTTP-only.** The request limiter (with Redis) and
  the idempotency store do not apply to ConnectRPC calls
  ([SECURITY.md](../architecture/SECURITY.md) §4.4).
- **Workspace switching** (`X-Workspace-Id` with a `uk_live_` user token) is HTTP-only.

### Workspace Isolation for Multi-Tenant Apps

Each workspace key reaches one workspace. Use separate keys for separate tenants:

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

// Tenant A's agent
const mnemoA = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: "mk_live_tenant_a_xxx",
});

// Tenant B's agent
const mnemoB = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: "mk_live_tenant_b_yyy",
});

// mnemoA.recall() and mnemoB.recall() are completely isolated — no data leakage
```

Server-side, PostgreSQL row-level security enforces the workspace boundary as long as the
server connects with a role without `BYPASSRLS` ([SECURITY.md](../architecture/SECURITY.md) §4).

---

## 13. Memory Protocol (Agent System Prompt)

The text that tells an agent how to use the memory tools exists in three places that are
kept in step by hand (`packages/mcp/src/instructions.ts` explains why):

| Copy                                                     | Who gets it                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `MCP_INSTRUCTIONS` in `packages/mcp/src/instructions.ts` | Any MCP client, as `instructions` in the initialize handshake |
| `packages/plugin/skills/memory/SKILL.md`                 | Claude Code and the other plugin hosts                        |
| The hook scripts in `packages/plugin/scripts/`           | Injected by the plugin's hooks                                |

A REST integration gets none of them: put your own instructions in the agent's system
prompt.

`@mnemo-ai/core` also exports `MEMORY_PROTOCOL_V2` (version tag `MEMORY_PROTOCOL_VERSION`,
currently `v1.4.0`) and `MEMORY_RECALL_GUIDANCE` (`packages/core/src/protocol/v1.ts`). No
MCP tool, route or job reads them, and the `protocol_version` column of a stored fact is
not set from this tag.
