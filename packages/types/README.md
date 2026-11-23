# @mnemo-ai/types

**English** · [Español](README.es.md)

> The shared domain types and port interfaces of [Mnemosyne](https://github.com/lucasmailland/mnemosyne), cognitive memory for AI agents. Almost no runtime code (a small locale helper); the CLI, the MCP server and the client install it for you.
>
> [Repository](https://github.com/lucasmailland/mnemosyne) · [Data model](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/DATA_MODEL.md) · [Status](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Shared TypeScript interfaces, enums, and domain types for the entire Mnemosyne
hexagonal architecture. This package is the single source of truth for every port
contract and domain primitive used across adapters, core, and server.

**Types and contracts, no infrastructure, one small locale helper.**
Import from here when you need types — never from an adapter package.

---

## Architecture Role

In Mnemosyne's hexagonal (ports-and-adapters) architecture, `@mnemo-ai/types`
defines the **ports** — the abstract interfaces that the core domain depends on.
Concrete adapters (postgres, redis, vector, etc.) implement these interfaces.
Nothing in `@mnemo-ai/types` contains executable code; it is a pure type boundary.

```
@mnemo-ai/types  (ports / contracts)
       ↑
@mnemo-ai/core   (domain logic — depends on ports, never on adapters)
       ↑
@mnemo-ai/adapter-*  (concrete implementations of each port)
```

---

## Installation

```bash
pnpm add @mnemo-ai/types
# or
npm install @mnemo-ai/types
```

No peer dependencies. No runtime requirements.

---

## Port Interfaces

Each port represents one hexagonal boundary between core and infrastructure.

| Port             | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `StorageAdapter` | Persist and query sessions, turns, facts, and entities in relational storage  |
| `VectorAdapter`  | Upsert and search dense embeddings via nearest-neighbor (pgvector or similar) |
| `CacheAdapter`   | Hot-tier key/value cache and sorted-set operations (Redis / Valkey)           |
| `LLMAdapter`     | Send prompts and receive completions from any LLM backend                     |
| `EmbedAdapter`   | Generate dense vector embeddings from text                                    |
| `QueueAdapter`   | Publish jobs to a durable work queue (consolidation, recall tasks)            |
| `OutboxAdapter`  | Transactional outbox for reliably delivering domain events                    |
| `AuthAdapter`    | Validate API keys and resolve workspace/tenant identity                       |

---

## Domain Types

### Session & Turn

| Type                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `MnemoSession`       | A single conversation or context window tracked by the system |
| `SessionTurn`        | One turn (message pair) within a session                      |
| `CreateSessionInput` | Input shape for opening a new session                         |

### Facts & Recall

| Type               | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `UpdateFactInput`  | Mutation shape for updating an existing fact                        |
| `RememberRequest`  | Inbound payload to store a new memory                               |
| `RememberResponse` | Confirmation with assigned IDs and extracted entities               |
| `RecallQuery`      | Search parameters for memory retrieval                              |
| `RecallHit`        | A single scored result returned from recall                         |
| `PrimitiveKind`    | Enum of the 10 cognitive fact types (fact, decision, episode, etc.) |
| `WorthDelta`       | Value object representing a change in a fact's worth score          |

### LLM I/O

| Type         | Description                                             |
| ------------ | ------------------------------------------------------- |
| `LLMInput`   | Prompt + parameters sent to an LLM adapter              |
| `LLMOutput`  | Completion response with token counts and finish reason |
| `LLMMessage` | A single role/content message in a chat thread          |

### System & Auth

| Type           | Description                                          |
| -------------- | ---------------------------------------------------- |
| `HealthStatus` | System health report emitted by `/health` endpoints  |
| `SchemaLike`   | Generic shape for Zod-compatible schema objects      |
| `AuthContext`  | Resolved workspace identity after API key validation |

---

## Usage Example

```typescript
import type {
  StorageAdapter,
  VectorAdapter,
  MnemoSession,
  RecallQuery,
  RecallHit,
  PrimitiveKind,
} from "@mnemo-ai/types";

// Implement a custom storage adapter
class MyStorageAdapter implements StorageAdapter {
  async createSession(input: CreateSessionInput): Promise<MnemoSession> {
    // ...
  }
  // implement remaining methods...
}

// Use domain types for recall
const query: RecallQuery = {
  workspaceId: "ws_abc123",
  text: "What did we decide about the auth system?",
  kinds: [PrimitiveKind.Decision],
  limit: 10,
};
```

---

## When to Use This Package

- **Building a custom adapter** — implement the relevant port interface
- **Writing core domain logic** — depend only on port types, never on adapters
- **Extending the server** — use domain types for request/response shapes
- **Writing tests** — mock any port interface without importing infrastructure

If you find yourself importing from `@mnemo-ai/adapter-*` in domain code,
that is an architecture violation. Depend on `@mnemo-ai/types` instead.

---

## Notes

- Port interfaces are **stable**. Breaking changes to any interface require a
  semver major bump and a migration note in CHANGELOG.md.
- The 10 `PrimitiveKind` values are the cognitive taxonomy that drives
  consolidation, recall ranking, and federation attribution.
- This package ships CommonJS + ESM dual builds with full `.d.ts` declarations.

See [`docs/architecture/DATA_MODEL.md`](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/DATA_MODEL.md) for the full primitive type reference.
