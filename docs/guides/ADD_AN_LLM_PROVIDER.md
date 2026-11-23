# How to Add a New LLM Provider

**English** · [Español](ADD_AN_LLM_PROVIDER.es.md)

> **Status: Implemented guide — verified 2026-06-13**
> Verified against: `packages/types/src/ports.ts`, `packages/llm-providers/src/`, `packages/adapter-llm/src/index.ts`, `packages/server/src/index.ts`, `packages/server/src/deps.ts`

---

## 0. When to Add a New Provider vs. Using an Existing One

**Add a new provider when:**
- You need a vendor not in the current list (`openai`, `anthropic`, `google`, `cohere`, `mistral`, `voyage`, `ollama`).
- You want to point at a self-hosted inference server with a different wire protocol (not OpenAI-compatible).
- You need an embedding-only service (like Voyage, but for a different vendor).

**Do NOT add a new provider when:**
- You only need a different model from an existing vendor — pass `MNEMO_EMBED_MODEL` or supply `model` in `EmbedRequest`/`CompleteRequest`.
- You need to proxy through Azure OpenAI or AWS Bedrock (OpenAI-compatible) — pass `baseURL` to `OpenAIProvider`; the request body is identical.
- You want to cap spending — use `BudgetGuard` (re-exported from `@mnemo-ai/llm-providers`) to wrap any existing provider.
- You want to mix-and-match two existing providers (e.g. Voyage for embeddings + Anthropic for completions) — use `LLMRouter` instead of writing a new class.

---

## 1. Understand the Two Interface Layers

There are two distinct interfaces in play. Read both before writing any code.

### 1a. `LLMProvider` — the internal provider contract

**File:** `packages/llm-providers/src/types.ts`

```typescript
export interface LLMProvider {
  readonly name: string;
  readonly capabilities: LLMCapabilities;
  embed?(input: EmbedRequest): Promise<EmbedResponse>;
  complete?(input: CompleteRequest): Promise<CompleteResponse>;
}
```

Both `embed` and `complete` are **optional**. A provider declares what it can do via `capabilities` flags (`embed: boolean`, `complete: boolean`, `streaming: boolean`, `jsonMode: boolean`). `LLMRouter` checks these before routing.

- Implement **only `embed`** if your vendor is embedding-only (like Voyage AI).
- Implement **only `complete`** if your vendor is completion-only (like Anthropic, which has no native embeddings API as of 2026-Q2).
- Implement **both** if your vendor supports both (like OpenAI, Google, Cohere, Mistral, Ollama).

### 1b. `LLMAdapter` — the hexagonal port used by `@mnemo-ai/core`

**File:** `packages/types/src/ports.ts`

```typescript
export interface LLMAdapter {
  readonly id: string;
  readonly model: string;
  generate(input: LLMInput): Promise<LLMOutput>;
  generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T>;
  healthCheck(): Promise<HealthStatus>;
}
```

**You do not implement `LLMAdapter` directly.** The `LlmProviderAdapter` class in `packages/adapter-llm/src/index.ts` already bridges any `CreatedProvider` (the shape returned by `createProvider()`) into `LLMAdapter`. You only implement `LLMProvider`.

Similarly, the server also consumes a slimmer `LLMProviderLike` interface (defined in `packages/server/src/deps.ts`) that only requires `embed(text, model)`. The `createProvider()` factory in `packages/llm-providers/src/factory.ts` shapes any `LLMProvider` into this contract automatically.

---

## 2. Ordered Checklist

### Step 1 — Create the provider file
- [ ] Create `packages/llm-providers/src/<vendorname>/index.ts`
- [ ] Implement `LLMProvider` using raw `fetch` via the shared `httpJson` helper (see §3 for skeleton)
- [ ] Declare accurate `capabilities` flags

### Step 2 — Add pricing rates (if hosted/metered)
- [ ] Add a rate entry to the `PRICING` table in `packages/llm-providers/src/pricing.ts`

### Step 3 — Register the provider in the factory
- [ ] Add a `case "<vendorname>":` branch in `packages/llm-providers/src/factory.ts`
- [ ] Add `"<vendorname>"` to the `ProviderName` union type in the same file

### Step 4 — Export from the package index
- [ ] Add `export { <VendorName>Provider } from "./<vendorname>/index.js";` to `packages/llm-providers/src/index.ts`

### Step 5 — Wire the server (if you want boot-time auto-detection)
- [ ] No changes needed to `packages/server/src/index.ts` — it already calls `createProvider({ provider: process.env.MNEMO_LLM_PROVIDER, apiKey: process.env.MNEMO_LLM_API_KEY })`. The factory `switch` statement (Step 3) is the only wiring required.

### Step 6 — Write tests
- [ ] Create `packages/llm-providers/src/__tests__/<vendorname>.test.ts` with a fake-HTTP test suite (see §5)

### Step 7 — Verify the 501 errors go away
- [ ] Set env vars and run the integration smoke test (see §6)

---

## 3. File-by-File: What to Add

### 3a. `packages/llm-providers/src/<vendorname>/index.ts`

[Full skeleton using `LLMProvider`, `httpJson`, zod validation, `estimateEmbedCost`/`estimateCompleteCost` — same pattern as `OpenAIProvider`. For embed-only follow `VoyageProvider`; for complete-only follow `AnthropicProvider`.]

### 3b. `packages/llm-providers/src/pricing.ts`

Add a rate block and add the key to the `PRICING` export map.

### 3c. `packages/llm-providers/src/factory.ts`

Two changes: add to `ProviderName` union; add `case "<vendorname>":` switch branch; update the default error message; add import.

### 3d. `packages/llm-providers/src/index.ts`

Add one export line alongside existing providers.

---

## 4. How the Wiring Flows to the Server

No changes to `packages/server/src/index.ts` or `packages/server/src/deps.ts` are needed. `bootFromEnv()` already calls `createProvider({ provider: MNEMO_LLM_PROVIDER, apiKey: MNEMO_LLM_API_KEY })`. The factory `switch` you added in Step 3 is the only connection point.

---

## 5. How to Test

Unit-test strategy: mock `fetch` with `vi.stubGlobal`, test success paths and error classification (`RateLimitedError`, `ContextOverflowError`). Run with:

```bash
pnpm --filter @mnemo-ai/llm-providers test
```

---

## 6. Verify the 501 Errors Go Away

Set `MNEMO_LLM_PROVIDER=<vendorname>` and `MNEMO_LLM_API_KEY=<key>`. Successful boot logs `llm.provider_ready`. Then:

```bash
mnemo recall "test query"
```

Before: `error: 501 not_implemented — no embed adapter: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY`
After: results table (or empty table if workspace has no facts).

---

## 7. Security Note

`MNEMO_LLM_API_KEY` must never appear in `NEXT_PUBLIC_*` env vars, never be logged, never be committed to version control. It is read only in `packages/server/src/index.ts` at boot time and never reaches the client or CLI.

---

## 8. What NOT to Do

- Do not import from `@mnemo-ai/core` inside a provider.
- Do not implement `LLMAdapter` directly — implement `LLMProvider` and let `LlmProviderAdapter` wrap it.
- Do not bypass `httpJson()` — it handles timeout and typed error classification.
- Do not return `costUSD: 0` for metered providers — use `estimateEmbedCost`/`estimateCompleteCost` which returns `undefined` for unknown models.

---

**Written file path:** `docs/guides/ADD_AN_LLM_PROVIDER.md`
