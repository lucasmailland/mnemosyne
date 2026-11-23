# @mnemo-ai/adapter-llm

**English** · [Español](README.es.md)

> **AI pointer:** Bridges the LLMAdapter port to concrete llm-providers. Handles per-task routing, budget guard, and provider fallback.
>
> **Depends on:** @mnemo-ai/types, @mnemo-ai/llm-providers
>
> **Exposes:** LlmProviderAdapter
>
> **Status:** STABLE
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [@mnemo-ai/llm-providers](../llm-providers/README.md)

Bridges `@mnemo-ai/llm-providers` concrete providers to the `LLMAdapter` hexagonal port.

## Overview

In Mnemosyne's hexagonal architecture, the core domain depends only on abstract ports — it
never imports concrete infrastructure. `@mnemo-ai/adapter-llm` is the anti-corruption layer
that sits between the two:

- **Infrastructure layer** — `@mnemo-ai/llm-providers` contains `CreatedProvider`, a concrete
  object that knows how to call OpenAI, Anthropic, or any other vendor.
- **Domain port** — `@mnemo-ai/types` exports `LLMAdapter`, the abstract interface the core
  depends on.
- **This package** — provides `LlmProviderAdapter`, which wraps any `CreatedProvider` and makes
  it satisfy `LLMAdapter` without leaking infrastructure concerns inward.

This means the core can be tested with a mock adapter, swapped to a different vendor with a
one-line config change, and is never contaminated by `openai`, `@anthropic-ai/sdk`, or any other
SDK import.

## Installation

```bash
# pnpm (recommended)
pnpm add @mnemo-ai/adapter-llm @mnemo-ai/llm-providers

# npm
npm install @mnemo-ai/adapter-llm @mnemo-ai/llm-providers
```

`@mnemo-ai/llm-providers` is a peer dependency — install it alongside this package.

## Quick Start

```typescript
import { createProvider } from "@mnemo-ai/llm-providers";
import { createLlmAdapter } from "@mnemo-ai/adapter-llm";
import { z } from "zod";

// 1. Create a concrete provider (infrastructure layer)
const provider = createProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

// 2. Wrap it in an adapter (adapter layer)
const adapter = createLlmAdapter(provider, { model: "gpt-4o-mini" });

// 3. Use the adapter through the port (domain layer sees only LLMAdapter)
const output = await adapter.generate({
  system: "You are a concise assistant.",
  messages: [{ role: "user", content: "What is hexagonal architecture?" }],
});

console.log(output.content);
// → "Hexagonal architecture separates business logic from infrastructure..."

// 4. Parse structured output directly into a Zod schema
const FactSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1),
});

const fact = await adapter.generateStructured(
  {
    system: "Extract a semantic triple from the user's statement as JSON.",
    messages: [
      { role: "user", content: "The Eiffel Tower is located in Paris." },
    ],
  },
  FactSchema
);

console.log(fact);
// → { subject: "Eiffel Tower", predicate: "located in", object: "Paris", confidence: 0.99 }
```

## API Reference

### `LlmProviderAdapterOptions`

| Option      | Type      | Required | Default           | Description                                                    |
|-------------|-----------|----------|-------------------|----------------------------------------------------------------|
| `model`     | `string`  | Yes      | —                 | Model name forwarded to the provider (e.g. `"gpt-4o-mini"`).  |
| `id`        | `string`  | No       | `provider.name`   | Logical identifier for this adapter instance. Useful when running multiple adapters side-by-side. |

### `createLlmAdapter(provider, opts)`

Convenience factory. Prefer this over `new LlmProviderAdapter(...)` at call sites.

```typescript
function createLlmAdapter(
  provider: CreatedProvider,
  opts: LlmProviderAdapterOptions
): LLMAdapter
```

**Parameters**

| Name       | Type                        | Description                         |
|------------|-----------------------------|-------------------------------------|
| `provider` | `CreatedProvider`           | Any provider created by `@mnemo-ai/llm-providers`. |
| `opts`     | `LlmProviderAdapterOptions` | Adapter configuration (see above).  |

**Returns** — `LLMAdapter` (the abstract port type from `@mnemo-ai/types`).

**Example**

```typescript
const adapter = createLlmAdapter(provider, {
  id: "primary-llm",
  model: "claude-3-5-haiku-20241022",
});

console.log(adapter.id);    // "primary-llm"
console.log(adapter.model); // "claude-3-5-haiku-20241022"
```

### `LlmProviderAdapter`

The class that backs `createLlmAdapter`. Implements `LLMAdapter` from `@mnemo-ai/types`.

#### `generate(input: LLMInput): Promise<LLMOutput>`

Calls `provider.complete()` and maps the response to `LLMOutput`.

```typescript
interface LLMInput {
  system?: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

interface LLMOutput {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  finishReason: "stop" | "length" | "tool_use";
}
```

**Message serialization** — `messages` are serialized as `role: content` lines (with the optional
`system` prepended). This produces the flat prompt string that `CreatedProvider.complete` expects.

**Finish reason mapping**

| Provider value          | `LLMOutput.finishReason` |
|-------------------------|--------------------------|
| `"stop"`                | `"stop"`                 |
| `"length"` / `"max_tokens"` | `"length"`           |
| `"tool_use"` / `"tool_calls"` | `"tool_use"`       |
| anything else           | `"stop"`                 |

**Throws** — `Error` if `input.messages` is empty.

#### `generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T>`

Calls `provider.complete()` with `json: true` when the provider advertises `jsonMode` support,
then JSON-parses the result and runs `schema.parse(parsed)`.

```typescript
interface SchemaLike<T> {
  parse(data: unknown): T;
}
```

Any schema with a `.parse()` method works — Zod, Valibot, Arktype, or a hand-rolled validator.

```typescript
const result = await adapter.generateStructured(
  { messages: [{ role: "user", content: 'Return {"answer": 42}' }] },
  z.object({ answer: z.number() })
);
// result.answer === 42
```

**Throws** — `Error` if `input.messages` is empty, JSON parsing fails, or schema validation fails.
Each error includes a diagnostic excerpt of the raw content.

#### `healthCheck(): Promise<HealthStatus>`

Sends a minimal `complete({ prompt: "ping", maxTokens: 1 })` to the provider and measures
round-trip latency.

```typescript
interface HealthStatus {
  status: "ok" | "degraded";
  latencyMs: number;
  detail?: string;  // populated on "degraded"
}
```

```typescript
const health = await adapter.healthCheck();

if (health.status === "ok") {
  console.log(`LLM reachable in ${health.latencyMs}ms`);
} else {
  console.error(`LLM degraded: ${health.detail}`);
}
```

Returns `{ status: "degraded", latencyMs: 0 }` immediately if the underlying provider does not
expose a `complete` method.

## Architecture

This package occupies the **adapter** ring of the hexagonal stack:

```
┌─────────────────────────────────────────────────────────────────┐
│  @mnemo-ai/core  (domain)                                      │
│                                                                 │
│   depends on ──→  LLMAdapter port  (@mnemo-ai/types)           │
└────────────────────────┬────────────────────────────────────────┘
                         │  implemented by
┌────────────────────────▼────────────────────────────────────────┐
│  @mnemo-ai/adapter-llm  (adapter)                              │
│                                                                 │
│   LlmProviderAdapter  wraps ──→  CreatedProvider                │
└────────────────────────┬────────────────────────────────────────┘
                         │  provided by
┌────────────────────────▼────────────────────────────────────────┐
│  @mnemo-ai/llm-providers  (infrastructure)                     │
│                                                                 │
│   createProvider({ provider: "openai", ... })                   │
│   createProvider({ provider: "anthropic", ... })                │
└─────────────────────────────────────────────────────────────────┘
```

**Hexagonal-purity guarantee** — `@mnemo-ai/adapter-llm` has zero imports from `drizzle-orm`,
`pg`, `redis`, `@neondatabase`, or any other persistence layer. The core remains fully portable
and testable in isolation.

**Dependency rule** — dependencies point inward only:

```
llm-providers  →  adapter-llm  →  types (port)
                                   ↑
                       core ───────┘
```

## Error Handling

| Scenario                                 | Thrown error                                                           |
|------------------------------------------|------------------------------------------------------------------------|
| `input.messages` is empty                | `"LlmProviderAdapter(<id>): LLMInput.messages must contain at least one message."` |
| Provider does not expose `complete`      | `"... does not support completions (complete is undefined)."`          |
| `generateStructured` receives non-JSON   | `"... provider returned non-JSON content. Parse error: ... Raw content (first 200 chars): ..."` |
| `generateStructured` schema parse fails  | `"... schema validation failed after JSON parse. <zod message>"`       |
| Network / provider error in `generate`   | Re-thrown from the underlying provider — no wrapping.                  |

All errors include the adapter `id` in the message to simplify debugging when multiple adapters
are wired into the same application.

## Testing

The package ships 20 unit tests covering:

- `generate()` — happy path, system message prepending, finish reason mapping, empty messages guard
- `generateStructured<T>()` — JSON mode flag, parse errors, schema validation errors
- `healthCheck()` — ok path, degraded on provider error, degraded when `complete` is absent
- `createLlmAdapter()` — id defaulting, id override

Run the tests:

```bash
# from the package root
pnpm test

# from the monorepo root
pnpm --filter @mnemo-ai/adapter-llm test

# watch mode
pnpm --filter @mnemo-ai/adapter-llm test:watch
```

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
