# @mnemo-ai/llm-providers

**English** · [Español](README.es.md)

> **AI pointer:** Pluggable LLM backends (OpenAI, Anthropic, local). Never imported by core — always injected via adapter-llm.
>
> **Depends on:** provider SDKs (openai, @anthropic-ai/sdk, etc.)
>
> **Exposes:** OpenAIProvider, AnthropicProvider, createProvider
>
> **Status:** STABLE
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [CLAUDE.md §Package dependency map](../../CLAUDE.md)

> Pluggable LLM adapters for [Mnemosyne](https://github.com/lucasmailland/mnemosyne). Bring-your-own-model embeddings and judgments — OpenAI, Anthropic, Google, Cohere, Mistral, Voyage, Ollama.

`@mnemo-ai/llm-providers` is the "BYO LLM" half of Mnemosyne. The core library (`@mnemo-ai/core`) never imports a vendor SDK directly — it accepts an `LLMProvider` interface. This package implements that interface for the major providers and ships a router + budget guard so workspaces can mix and match.

## Why

Cognitive memory has two LLM-shaped needs:

1. **Embeddings** — turn text into a vector for storage and recall.
2. **Judgments** — fact extraction, conflict resolution, summarization, prefilter.

The optimal provider for each is rarely the same vendor. With this package you can:

- Use **Voyage** for embeddings (best-in-class retrieval quality)
- Use **Anthropic** for judgments (best-in-class reasoning)
- Cap daily spend with a **BudgetGuard**
- Fall back to a single OpenAI key when you just want to ship

## Capabilities matrix

| Provider  | Embed | Complete | Streaming | JSON mode | Local |
| --------- | :---: | :------: | :-------: | :-------: | :---: |
| OpenAI    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Anthropic |       |    ✓     |     ✓     |   (\*)    |       |
| Google    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Cohere    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Mistral   |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Voyage    |   ✓   |          |           |           |       |
| Ollama    |   ✓   |    ✓     |           |   (\*)    |   ✓   |

(\*) Coaxed via prompt — no native API mode. Callers should validate output.

## Install

```bash
pnpm add @mnemo-ai/llm-providers
```

Zero peer dependencies. Bundles `zod` for runtime response validation.
Uses native `fetch` — no vendor SDKs, no transitive risk.

## Usage

### 1. Single provider (the simple case)

```ts
import { OpenAIProvider } from "@mnemo-ai/llm-providers";

const llm = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Embed
const { vectors, costUSD } = await llm.embed({
  texts: ["user said the meeting is on tuesday"],
});

// Judge
const { text } = await llm.complete({
  prompt: "Extract facts from this transcript: ...",
  system: "You are a careful fact extractor.",
  json: true,
});
```

### 2. Router — best provider per task

```ts
import {
  LLMRouter,
  OpenAIProvider,
  VoyageProvider,
  AnthropicProvider,
} from "@mnemo-ai/llm-providers";

const router = new LLMRouter({
  default: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  perTask: {
    embed: new VoyageProvider({ apiKey: process.env.VOYAGE_API_KEY! }),
    judge: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    summary: new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      defaultCompleteModel: "claude-3-5-haiku-latest", // cheaper for summaries
    }),
  },
});

await router.embed({ texts: ["..."] }); // → Voyage
await router.complete({ prompt: "...", task: "judge" }); // → Claude Sonnet
await router.complete({ prompt: "...", task: "summary" }); // → Claude Haiku
await router.complete({ prompt: "..." }); // → OpenAI (default)
```

Pass `router` straight to `@mnemo-ai/core` — it sees a single `LLMProvider`.

### 3. Budget guard — hard daily cap

```ts
import { BudgetGuard, OpenAIProvider } from "@mnemo-ai/llm-providers";

const guarded = new BudgetGuard({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  dailyUSDCap: 25.0,
  perRequestCap: 0.5,
  onSpend: (delta, total) => metrics.gauge("llm_spend_usd", total),
});

try {
  await guarded.embed({ texts: ["..."] });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // surface to user, do NOT retry
  }
}

// Reset from a midnight cron / scheduled function
guarded.reset();
```

BudgetGuard works inside a router too — wrap individual per-task providers
to keep your judgments budget independent from your embeddings budget.

**In the server.** `@mnemo-ai/server` arms a BudgetGuard when
`MNEMO_LLM_DAILY_BUDGET_USD` is set: a cap in USD on the completions of the
`MNEMO_LLM_*` provider, reset at 00:00 UTC, with the running total in the
`mnemo_llm_daily_spend_usd` gauge. Once it is reached, collapse, rerank, HyDE
and conflict checks degrade as they do when the LLM is down. Embeddings are not
capped, so writes keep working. A model missing from the price table is not
counted; the server warns at boot.

The server builds an `LLMRouter` when `MNEMO_LLM_JUDGE_*`, `MNEMO_LLM_SUMMARY_*`
or `MNEMO_LLM_PREFILTER_*` is set (`_PROVIDER`, `_MODEL`, `_API_KEY`): each
engine completion declares its task, and a task without its own variables runs
on `MNEMO_LLM_PROVIDER`. The daily cap counts every task's provider. See
[`docs/guides/LOCAL_DEV_SETUP.md`](../../docs/guides/LOCAL_DEV_SETUP.md).

### 4. Custom provider — bring your own

```ts
import type { LLMProvider, EmbedRequest, EmbedResponse } from "@mnemo-ai/llm-providers";

class MyInternalProvider implements LLMProvider {
  readonly name = "internal-bedrock-proxy";
  readonly capabilities = {
    embed: true,
    complete: false,
    streaming: false,
    jsonMode: false,
  };

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    // Call your internal endpoint, return the standardized shape.
    return {
      vectors: await myInternalEmbed(input.texts),
      tokensUsed: 0,
      model: "internal-v1",
      provider: this.name,
    };
  }
}

// Drop it in anywhere a provider goes — including inside a router.
const router = new LLMRouter({
  default: new OpenAIProvider({ apiKey }),
  perTask: { embed: new MyInternalProvider() },
});
```

## Errors

| Error                         | When                          | What to do                    |
| ----------------------------- | ----------------------------- | ----------------------------- |
| `LLMProviderError`            | Generic vendor failure        | Log, surface to user          |
| `RateLimitedError`            | HTTP 429 — has `retryAfterMs` | Back off and retry            |
| `ContextOverflowError`        | Input too long for model      | Chunk input, retry            |
| `CapabilityNotSupportedError` | `embed()` on Anthropic, etc.  | Route to a different provider |
| `BudgetExceededError`         | Daily or per-request cap hit  | Surface — do NOT retry        |

## Configuration

Every provider accepts the same `ProviderConfig`:

```ts
{
  apiKey?: string;            // required for hosted; ignored by Ollama
  baseURL?: string;           // override for Azure / proxy / local emulators
  defaultEmbedModel?: string;
  defaultCompleteModel?: string;
  timeoutMs?: number;         // default 60_000 (120_000 for Ollama)
}
```

## Pricing

A static table in `src/pricing.ts` powers the `costUSD` field on every
response. Rates are as of **2026-Q2**. To override (enterprise rates,
private deployments), edit your local copy or wrap the provider — the
pricing helpers are exported so you can reuse them.

Models not in the table return `costUSD: undefined`. `BudgetGuard`'s
default `unknownCostPolicy` is `"block"`, so misconfigured model names
fail loudly instead of silently overspending.

## License

Apache-2.0
