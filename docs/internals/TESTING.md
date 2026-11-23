# Mnemosyne — Testing & Parallel Build Strategy

> How to build 20 packages with AI agents in parallel, each in its own
> worktree, with confidence that everything integrates correctly on merge.

---

## Core Insight: Package Boundaries = Parallelism Boundaries

```
If two packages don't import each other → two agents can build them simultaneously.
If a package only imports @mnemo-ai/types → it can be built BEFORE core exists.
If tests pass in isolation → merge is safe.
```

---

## 1. The Test Pyramid (Per Package)

Every package has THREE test layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                   │
│  Layer 3: INTEGRATION TESTS (run post-merge, CI only)           │
│  ├── Cross-package wiring (does server + core + storage work?)  │
│  ├── Real PG/Redis via Testcontainers                           │
│  ├── E2E recall pipeline (request → response)                   │
│  └── Runs in: ci.yml integration job (non-blocking)             │
│                                                                   │
│  Layer 2: CONTRACT TESTS (run per-PR, adapter compliance)       │
│  ├── "Does this adapter fulfill the interface?"                 │
│  ├── Shared test suite from @mnemo-ai/types                    │
│  ├── Every adapter runs THE SAME contract suite                 │
│  └── Runs in: ci.yml per-package test job                       │
│                                                                   │
│  Layer 1: UNIT TESTS (run per-PR, fast, no I/O)                │
│  ├── Pure logic (scoring, fusion, graph traversal, etc.)        │
│  ├── Mocked adapters (interfaces, not implementations)          │
│  ├── Each test file < 2s                                        │
│  └── Runs in: ci.yml per-package test job                       │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 1: Unit Tests (every package, every PR)

```typescript
// Example: @mnemo-ai/core unit test
// NO real DB, NO network, ONLY interfaces

import { RecallPipeline } from "../src/recall/pipeline";
import { createMockStorage, createMockCache, createMockTelemetry } from "@mnemo-ai/test-utils";

describe("RecallPipeline", () => {
  it("falls through tiers when hot tier misses", async () => {
    const cache = createMockCache({ get: async () => null }); // Always misses
    const storage = createMockStorage({
      ftsSearch: async () => [{ fact: mockFact(), rank: 0.9 }],
    });

    const pipeline = new RecallPipeline({ cache, storage, telemetry: createMockTelemetry() });
    const hits = await pipeline.execute({ query: "deploy", workspaceId: "ws_1" });

    expect(hits).toHaveLength(1);
    expect(cache.get).toHaveBeenCalledWith(expect.stringContaining("ws_1"));
    expect(storage.ftsSearch).toHaveBeenCalled();
  });
});
```

**Rules:**

- No `import` from implementation packages (only `@mnemo-ai/types`)
- No Docker, no network, no filesystem
- < 2s per file, < 30s per package
- Mocks follow the INTERFACE, not the impl

---

### Layer 2: Contract Tests (the secret weapon)

**Problem:** How do you know `@mnemo-ai/adapter-redis` actually fulfills `CacheAdapter`?

**Solution:** A shared compliance test suite that ANY adapter must pass.

```typescript
// @mnemo-ai/test-utils/src/contracts/cache-adapter.contract.ts
//
// ANY package implementing CacheAdapter imports this and runs it
// against their implementation. If it passes → the adapter is correct.

export function cacheAdapterContract(
  createAdapter: () => Promise<CacheAdapter>,
  cleanup?: () => Promise<void>
) {
  describe("CacheAdapter Contract", () => {
    let adapter: CacheAdapter;

    beforeEach(async () => {
      adapter = await createAdapter();
    });
    afterEach(async () => {
      await cleanup?.();
    });

    describe("get/set", () => {
      it("returns null for missing key", async () => {
        expect(await adapter.get("missing")).toBeNull();
      });

      it("stores and retrieves a value", async () => {
        await adapter.set("key1", { data: "hello" });
        expect(await adapter.get("key1")).toEqual({ data: "hello" });
      });

      it("respects TTL", async () => {
        await adapter.set("key2", "value", { ttlMs: 50 });
        expect(await adapter.get("key2")).toBe("value");
        await new Promise((r) => setTimeout(r, 100));
        expect(await adapter.get("key2")).toBeNull();
      });

      it("overwrites existing key", async () => {
        await adapter.set("key3", "v1");
        await adapter.set("key3", "v2");
        expect(await adapter.get("key3")).toBe("v2");
      });
    });

    describe("delete", () => {
      it("removes a key", async () => {
        await adapter.set("key4", "value");
        await adapter.delete("key4");
        expect(await adapter.get("key4")).toBeNull();
      });

      it("is idempotent on missing key", async () => {
        await expect(adapter.delete("nonexistent")).resolves.not.toThrow();
      });
    });

    describe("deletePattern", () => {
      it("removes keys matching pattern", async () => {
        await adapter.set("ws:abc:recall:1", "a");
        await adapter.set("ws:abc:recall:2", "b");
        await adapter.set("ws:xyz:recall:3", "c");

        const deleted = await adapter.deletePattern("ws:abc:*");
        expect(deleted).toBe(2);
        expect(await adapter.get("ws:xyz:recall:3")).toBe("c"); // Not affected
      });
    });

    describe("healthCheck", () => {
      it("reports healthy when operational", async () => {
        const status = await adapter.healthCheck();
        expect(status.status).toBe("healthy");
      });
    });

    // Conditional: sorted set operations (Redis-only)
    if (adapter.capabilities?.sortedSets) {
      describe("sorted sets (optional)", () => {
        it("adds and retrieves by score range", async () => {
          await adapter.zadd!("hot:ws1", 0.9, "fact_1");
          await adapter.zadd!("hot:ws1", 0.7, "fact_2");
          await adapter.zadd!("hot:ws1", 0.3, "fact_3");

          const top2 = await adapter.zrangeByScore!("hot:ws1", 0.5, 1.0, 2);
          expect(top2).toEqual(["fact_2", "fact_1"]); // Ascending by score
        });
      });
    }
  });
}
```

**Usage in adapter packages:**

```typescript
// packages/adapter-redis/src/__tests__/contract.test.ts
// Real package: @mnemo-ai/adapter-redis  (class RedisCacheAdapter, adapter id "redis")

import { cacheAdapterContract } from "@mnemo-ai/test-utils";
import { RedisCacheAdapter } from "../src";
import { GenericContainer } from "testcontainers";

describe("RedisCacheAdapter", () => {
  let container;

  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  });
  afterAll(async () => {
    await container.stop();
  });

  cacheAdapterContract(
    () =>
      Promise.resolve(
        new RedisCacheAdapter({ url: `redis://localhost:${container.getMappedPort(6379)}` })
      ),
    () => {
      /* flush redis */
    }
  );
});
```

```typescript
// packages/adapter-redis/src/__tests__/memory-contract.test.ts
// (MemoryCacheAdapter is built into adapter-redis or core as a fallback)

import { cacheAdapterContract } from "@mnemo-ai/test-utils";
import { createMemoryCache } from "../src";

describe("MemoryCache", () => {
  cacheAdapterContract(() => Promise.resolve(createMemoryCache({ maxSize: 1000 })));
});
```

**The beauty:** If tomorrow you write `@mnemo-ai/cache-dragonfly`, you import `cacheAdapterContract`, run it, and if it passes → it's a drop-in replacement. Zero additional test code.

---

### Layer 3: Integration Tests (post-merge, real infra)

There is no `packages/integration-tests`: each package keeps its own `*.integration.test.ts`
files (most in `adapter-postgres`, `server` and `mcp`) and runs them with
`pnpm --filter <package> test:integration`, against containers started by testcontainers.
The engine factory is `createCore(deps, config)` from `@mnemo-ai/core/cognitive`, which takes
injected adapters; there is no `createCore({ databaseUrl })`.

---

## 2. The Shared Test Utilities Package

```
@mnemo-ai/test-utils
├── src/
│   ├── mocks/
│   │   ├── storage.ts        — createMockStorage() (fulfills StorageAdapter)
│   │   ├── cache.ts          — createMockCache() (fulfills CacheAdapter)
│   │   ├── vector.ts         — createMockVector() (fulfills VectorAdapter)
│   │   ├── embed.ts          — createMockEmbed() (fulfills EmbedAdapter)
│   │   ├── llm.ts            — createMockLLM() (fulfills LLMAdapter)
│   │   ├── queue.ts          — createMockQueue() (fulfills QueueAdapter)
│   │   ├── logger.ts         — createMockLogger() (captures logs for assertions)
│   │   └── telemetry.ts      — createMockTelemetry() (captures spans/metrics)
│   ├── contracts/
│   │   ├── storage-adapter.contract.ts
│   │   ├── cache-adapter.contract.ts
│   │   ├── vector-adapter.contract.ts
│   │   ├── embed-adapter.contract.ts
│   │   ├── llm-adapter.contract.ts
│   │   └── queue-adapter.contract.ts
│   ├── fixtures/
│   │   ├── facts.ts           — createFact(), createFactBatch()
│   │   ├── entities.ts        — createEntity(), createGraph()
│   │   ├── workspaces.ts      — createWorkspace()
│   │   └── sessions.ts        — createSession(), createTurns()
│   └── helpers/
│       ├── containers.ts      — startPg(), startRedis() (testcontainers wrappers)
│       └── assertions.ts      — expectRecallHit(), expectNoError()
```

**EVERY package imports `@mnemo-ai/test-utils` as devDep.** This guarantees:

- Consistent mock behavior across all tests
- Contract tests are the source of truth for interface compliance
- Fixtures are shared (no drift between "what core expects" and "what storage returns")

---

## 3. Parallel Agent Build Strategy

### The Dependency DAG (determines parallelism)

```
                    ┌──────────────┐
                    │ @mnemo-ai/  │
          ┌────────│    types     │────────────────────────────┐
          │        └──────────────┘                            │
          │     (Logger/Telemetry/ConfigProvider interfaces     │
          │      defined here; impls in packages/server/src/   │
          │      telemetry/. No separate logger/errors/         │
          │      telemetry/config packages.)                    │
          │                │                                    │
          │                ▼                                    │
          │         ┌───────────┐                              │
          │         │test-utils │ (mocks from types)           │
          │         └───────────┘                              │
          │                                                     │
          ▼                                                     ▼
   ┌─────────┐                             ┌──────────────────────────┐
   │  core   │                             │ Adapter packages (real)  │
   │(pure    │                             │  adapter-postgres         │
   │ logic)  │                             │  adapter-redis            │
   └─────────┘                             │  adapter-vector           │
          │                                │  adapter-llm              │
          │                                │  llm-providers (7 impls)  │
          └────────────────────────────────┴────────────┬─────────────┘
                                                         │
                                                         ▼
                                               ┌───────────────────┐
                                               │   server          │
                                               │ (composition root │
                                               │  pino/OTel wired  │
                                               │  here in boot.ts) │
                                               └───────┬───────────┘
                                                       │
                                              ┌────────┴──────┐
                                              ▼               ▼
                                           ┌─────┐        ┌──────┐
                                           │ mcp │        │ cli  │
                                           └─────┘        └──────┘
```

### Waves of Parallel Work

```
WAVE 0 (1 agent, SERIAL — everything depends on this):
  └── @mnemo-ai/types
      └── Define ALL interfaces: StorageAdapter, CacheAdapter, VectorAdapter,
          EmbedAdapter, LLMAdapter, QueueAdapter, Logger, Telemetry, ConfigProvider
      └── Define ALL domain types: FactRecord, EntityRecord, RecallHit, etc.
      └── Tests: Type-level only (TypeScript compiles = passes)
      └── Time: 1-2 days

WAVE 1 (3 agents in parallel):
  ├── Agent A: @mnemo-ai/types — interfaces for Logger, Telemetry, ConfigProvider,
  │             StorageAdapter, CacheAdapter, VectorAdapter, EmbedAdapter, LLMAdapter,
  │             QueueAdapter + all domain types. Error classes / codes live in
  │             packages/server/src/errors.ts; pino/OTel impls in
  │             packages/server/src/telemetry/. No separate errors/logger/telemetry/config pkg.
  │   └── Tests: type-level only (TypeScript compiler = passing)
  │
  ├── Agent B: @mnemo-ai/test-utils
  │   └── All mock factories + contract test suites + fixtures
  │   └── Tests: meta (contract tests pass against mock impls)
  │
  └── Agent C: @mnemo-ai/core (pure business logic, zero infra imports)
      └── Tests: unit with mock adapters

WAVE 2 (4 agents in parallel — real adapter packages):
  ├── Agent D: @mnemo-ai/adapter-postgres
  │   └── DrizzleStorageAdapter — Drizzle + postgres.js
  │   └── Tests: contract suite + Testcontainers PG
  │
  ├── Agent E: @mnemo-ai/adapter-redis
  │   └── RedisCacheAdapter (id "redis") wrapping ioredis + MemoryCacheAdapter fallback
  │   └── Tests: contract suite + Testcontainers Redis
  │
  ├── Agent F: @mnemo-ai/adapter-vector
  │   └── PgVectorAdapter (id "pgvector") wrapping pgvector SQL
  │   └── Tests: contract suite + Testcontainers PG+pgvector
  │
  └── Agent G: @mnemo-ai/llm-providers + @mnemo-ai/adapter-llm
      └── Provider impls: Anthropic, OpenAI, Ollama, Voyage, Cohere, Gemini, Mistral (7 total)
      └── adapter-llm bridges llm-providers → LLMAdapter + EmbedAdapter ports
      └── Tests: contract suite + mock HTTP (MSW)

WAVE 3 (1-2 agents, SERIAL — server composition root):
  └── @mnemo-ai/server WIRING
      └── packages/server/src/boot.ts assembles DrizzleStorageAdapter, RedisCacheAdapter,
          PgVectorAdapter, llm-providers impls, pino logger, OTel telemetry → createCore()
      └── Tests: integration tests (full stack)

WAVE 4 (3 agents in parallel):
  ├── Agent H: @mnemo-ai/server (HTTP routes + middleware)
  ├── Agent I: @mnemo-ai/mcp (MCP server)
  └── Agent J: @mnemo-ai/client-ts (TypeScript SDK)
      └── Tests: integration tests (full stack)
```

### Worktree Strategy

```bash
# Each agent works in its own worktree
git worktree add ../mnemo-types    feature/types
git worktree add ../mnemo-logger   feature/logger
git worktree add ../mnemo-errors   feature/errors
git worktree add ../mnemo-config   feature/config
# ...

# Each worktree:
# 1. Creates its package directory
# 2. Writes code + tests
# 3. Runs `pnpm test --filter @mnemo-ai/{package}`
# 4. Opens PR
# 5. PR merges to main (after CI)
# 6. Next wave starts from updated main
```

### Merge Order (strictly enforced)

```
main ←── types (merge first, always)
  ↑        (errors/logger/telemetry/config are interfaces in types, not separate packages)
  │
  ├── test-utils    (after types)
  ├── core          (after types) ← business logic
  │
  ├── adapter-postgres  (after types + test-utils)   DrizzleStorageAdapter
  ├── adapter-redis     (after types + test-utils)   RedisCacheAdapter (id "redis")
  ├── adapter-vector    (after types + test-utils)   PgVectorAdapter (id "pgvector")
  ├── llm-providers     (after types, independent)   7 provider impls
  ├── adapter-llm       (after types + llm-providers) bridges to ports
  │
  ├── server    (after core + all adapters) ← pino/OTel impls live here
  ├── mcp       (after core)
  └── client-ts (after types, independent)
```

---

## 4. CI Pipeline for 20 Packages

### Turborepo Task Graph

```json
// turbo.json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"],
      "env": ["CI"]
    },
    "test:contract": {
      "dependsOn": ["^build"],
      "cache": false
    },
    "test:integration": {
      "dependsOn": ["^build"],
      "cache": false
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {}
  }
}
```

### CI Workflow

```yaml
# .github/workflows/ci.yml

name: CI

on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  # ─── Fast checks (all PRs) ───────────────────────────────────
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run build typecheck lint test
        # Turbo only runs affected packages (based on git diff)
        # Cache hits for unchanged packages = instant

  # ─── Contract tests (adapter packages only) ──────────────────
  contracts:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: check
    # Only runs if adapter packages changed
    if: contains(github.event.pull_request.labels.*.name, 'adapter') ||
      contains(needs.check.outputs.affected, 'cache-') ||
      contains(needs.check.outputs.affected, 'storage-') ||
      contains(needs.check.outputs.affected, 'vector-') ||
      contains(needs.check.outputs.affected, 'queue-')
    services:
      postgres:
        image: pgvector/pgvector:pg17
        ports: ["5432:5432"]
        env: { POSTGRES_PASSWORD: test }
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run test:contract

  # ─── Integration tests (post-merge or labeled PRs) ──────────
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    needs: check
    if: github.ref == 'refs/heads/main' ||
      contains(github.event.pull_request.labels.*.name, 'integration')
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run test:integration
        # Uses Testcontainers (Docker-in-Docker)
```

### Affected Package Detection

```yaml
# turbo.json handles this natively:
# `turbo run test --filter=...[HEAD~1]`
# Only runs tests for packages that changed since last commit.
# Dependencies are transitively included:
#   - If @mnemo-ai/types changes → ALL packages retest
#   - If @mnemo-ai/adapter-redis changes → only cache-redis retests
#   - If @mnemo-ai/core changes → core + server + mcp retest
```

---

## 5. Contract Test Coverage Matrix

Each adapter MUST pass its contract. This is the acceptance criteria for "package is done":

| Package (real name)                                           | Contract Suite           | Infrastructure Needed        | Agent Can Build In Isolation? |
| ------------------------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------- |
| `@mnemo-ai/adapter-redis` (MemoryCacheAdapter fallback)       | `cacheAdapterContract`   | None                         | ✅ Yes                        |
| `@mnemo-ai/adapter-redis` (RedisCacheAdapter, id `"redis"`)   | `cacheAdapterContract`   | Redis (Testcontainers)       | ✅ Yes                        |
| `@mnemo-ai/adapter-postgres` (DrizzleStorageAdapter)          | `storageAdapterContract` | PG (Testcontainers)          | ✅ Yes                        |
| `@mnemo-ai/adapter-vector` (PgVectorAdapter, id `"pgvector"`) | `vectorAdapterContract`  | PG+pgvector (Testcontainers) | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (OpenAI embed provider)             | `embedAdapterContract`   | MSW (mock HTTP)              | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (Ollama embed provider)             | `embedAdapterContract`   | MSW (mock HTTP)              | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (Voyage embed provider)             | `embedAdapterContract`   | MSW (mock HTTP)              | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (Anthropic LLM provider)            | `llmAdapterContract`     | MSW (mock HTTP)              | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (OpenAI LLM provider)               | `llmAdapterContract`     | MSW (mock HTTP)              | ✅ Yes                        |
| `@mnemo-ai/llm-providers` (Ollama LLM provider)               | `llmAdapterContract`     | MSW (mock HTTP)              | ✅ Yes                        |

**Key insight:** EVERY package can be built in isolation. The contract suite lives in `@mnemo-ai/test-utils` (available from Wave 1). The adapter just imports it and runs it against its implementation.

---

## 6. Regression Safety for Core Refactor (Wave 3)

The most dangerous step. Here's how we make it safe:

### Before refactor: snapshot current behavior

```typescript
// packages/core/src/__tests__/regression/recall.snapshot.test.ts
//
// Records the EXACT output of recall for known inputs.
// If ANY output changes during refactor → test fails.

import { existingCreateCore } from "../src/factory"; // Current impl

const REGRESSION_CASES = [
  { query: "deploy process", workspace: "ws_test", expectedMinHits: 3 },
  { query: "redis config", workspace: "ws_test", expectedFactIds: ["fact_1", "fact_2"] },
  // ... 50+ cases from real usage patterns
];

describe("Recall regression (pre-refactor snapshot)", () => {
  for (const tc of REGRESSION_CASES) {
    it(`recall("${tc.query}") returns expected results`, async () => {
      const core = await existingCreateCore({ databaseUrl: TEST_PG_URL });
      const hits = await core.recall(tc.workspace, { query: tc.query });

      expect(hits.length).toBeGreaterThanOrEqual(tc.expectedMinHits);
      if (tc.expectedFactIds) {
        expect(hits.map((h) => h.fact.id)).toEqual(expect.arrayContaining(tc.expectedFactIds));
      }
      // Snapshot the FULL output for comparison
      expect(hits).toMatchSnapshot();
    });
  }
});
```

### During refactor: both implementations pass same tests

```typescript
// The refactored core MUST produce identical output to the current core
// for all snapshot cases. This is the acceptance criteria for Phase 4.
```

### After refactor: contract tests replace snapshots

Once the refactor is merged and stable, snapshots are replaced by:

- Contract tests (adapter compliance)
- Unit tests (business logic with mocks)
- Integration tests (full stack)

---

## 7. Test Commands (Developer & Agent UX)

```bash
# Run all tests for one package (fast, unit only)
pnpm test --filter @mnemo-ai/adapter-redis

# Run contract tests for one adapter
pnpm test:contract --filter @mnemo-ai/adapter-redis

# Run all tests affected by your changes
pnpm turbo run test --filter=...[main]

# Run full integration suite (needs Docker)
pnpm test:integration

# Run specific test file
pnpm --filter @mnemo-ai/core test -- src/__tests__/recall.test.ts

# Watch mode (for development)
pnpm --filter @mnemo-ai/core test:watch
```

### For AI Agents (in worktree)

```bash
# Agent instruction: "Build @mnemo-ai/adapter-redis"
# Agent actions:
cd /path/to/worktree
mkdir -p packages/adapter-redis/src packages/adapter-redis/src/__tests__
# ... write code ...

# Verify:
pnpm install
pnpm --filter @mnemo-ai/adapter-redis build
pnpm --filter @mnemo-ai/adapter-redis test        # Unit
pnpm --filter @mnemo-ai/adapter-redis test:contract # Contract
# If both pass → PR ready
```

---

## 8. Test Configuration Template

Every package gets the same vitest config:

```typescript
// packages/{name}/vitest.config.ts

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/*.contract.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    // Fail fast — no sense running 100 tests if first one fails
    bail: 1,
    // Timeout per test
    testTimeout: 5000,
  },
});
```

Contract tests have their own config:

```typescript
// packages/{name}/vitest.contract.config.ts

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.contract.test.ts"],
    testTimeout: 30000, // Testcontainers startup can be slow
  },
});
```

---

## 9. Coverage Expectations

| Package Type                    | Minimum Coverage      | Rationale                                                       |
| ------------------------------- | --------------------- | --------------------------------------------------------------- |
| `types`                         | N/A (no runtime code) | TypeScript compiler is the test                                 |
| `core`                          | 85%                   | Business logic must be well-tested                              |
| `adapter-postgres`              | 80% + contract pass   | Contract suite IS the coverage                                  |
| `adapter-redis`                 | 80% + contract pass   | Contract suite IS the coverage                                  |
| `adapter-vector`                | 80% + contract pass   | Contract suite IS the coverage                                  |
| `adapter-llm` / `llm-providers` | 80% + contract pass   | Contract suite IS the coverage                                  |
| `server`                        | 75%                   | HTTP layer; pino/OTel/errors wired here — cover flag eval paths |
| `mcp`                           | 75%                   | Thin wrapper, MCP SDK handles transport                         |
| `test-utils`                    | 60%                   | Meta-testing, mocks are the product                             |

---

## 10. Summary: What Makes This Strategy Work

| Principle          | Implementation                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| **Isolation**      | Each package builds/tests independently in its own worktree                      |
| **Contracts**      | Shared test suites prove adapter compliance (any impl that passes = correct)     |
| **Parallelism**    | Dependency DAG defines 5 waves; within each wave, agents run simultaneously      |
| **Safety**         | Regression snapshots protect the core refactor; contracts protect adapters       |
| **Speed**          | Turbo caching means unchanged packages skip tests (~30s per PR)                  |
| **Agent-friendly** | Each task is self-contained: "build X, run these tests, if pass → PR"            |
| **Replaceable**    | New adapter = import contract test + implement interface + pass = done           |
| **CI**             | Three tiers: fast checks (every PR), contracts (adapter PRs), integration (main) |
