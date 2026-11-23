/**
 * EmbedAdapter shim — wraps an `LLMProviderLike` (embed(text, model): number[])
 * into the `@mnemo-ai/types` `EmbedAdapter` port (embed(texts): Float32Array[]).
 *
 * Extracted from packages/server/src/index.ts's boot function so the
 * embedWithUsage → recordLlmUsage wiring (ADP-5) is unit-testable without
 * standing up the whole server boot sequence.
 */
import type { EmbedAdapter } from "@mnemo-ai/types";
import type { LLMProviderLike } from "./deps.js";
import { NotImplementedError } from "./errors.js";

/**
 * Requests in flight for one `embed(texts)` call. Collapse passes every turn of
 * a session at once; unbounded, hundreds of requests queued at the provider and
 * the per-text deadline expired on the tail of the queue.
 */
export const EMBED_BATCH_CONCURRENCY = 8;

export interface EmbedUsageEvent {
  provider: string;
  model: string;
  tokens: number;
  costUSD?: number;
}

export function createEmbedAdapter(
  embedProvider: LLMProviderLike | undefined,
  embedModel: string,
  embedDimensions: number,
  onUsage?: (usage: EmbedUsageEvent) => void,
  /**
   * P115: `false` when `embedProvider` is the MNEMO_EMBED_STUB hash embedder,
   * so consumers that make irreversible decisions from cosine similarity can
   * stand down. Defaults to true — a real provider is the normal case, and the
   * one caller that knows it is stubbed is the boot path that built the stub.
   */
  semantic = true
): EmbedAdapter {
  if (!embedProvider) {
    return {
      id: "no-embed",
      model: "none",
      dimensions: embedDimensions,
      // Not merely "not meaningful" — there are no vectors at all; every call
      // throws. Flagging it keeps a semantic gate from taking the whole collapse
      // down with a NO_EMBED_ADAPTER error instead of standing down cleanly.
      semantic: false,
      async embed(_texts: string[]): Promise<Float32Array[]> {
        throw new NotImplementedError(
          "No embed adapter configured: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY to enable semantic recall",
          { code: "NO_EMBED_ADAPTER" }
        );
      },
      async embedSingle(_text: string): Promise<Float32Array> {
        throw new NotImplementedError(
          "No embed adapter configured: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY to enable semantic recall",
          { code: "NO_EMBED_ADAPTER" }
        );
      },
      async healthCheck() {
        return {
          status: "degraded" as const,
          latencyMs: 0,
          detail: "no embed provider configured",
        };
      },
    };
  }

  // ADP-5: embedWithUsage carries the vendor's real token count + cost (same
  // round-trip cost as embed — no extra API call). When present, prefer it and
  // forward to onUsage so the caller can wire it into recordLlmUsage(kind:
  // "embedding"), the same accounting the completion side already gets.
  // Providers that don't implement it (embedWithUsage is optional on
  // LLMProviderLike) fall back to plain embed() with no usage/cost recorded —
  // same behavior as before this fix, not a regression.
  /**
   * P128 follow-up — a per-call deadline for embedding.
   *
   * The budgets were inverted. The provider's HTTP timeout defaults to 60s, the
   * `llm.embed` breaker allows 10s, and the `storage.read` breaker that wraps
   * recall cuts at 5s. The innermost call was allowed twelve times the budget
   * of the outermost one, so a hanging provider could never fail early enough
   * for the FTS fallback to run inside the request — measured at 3.5s just for
   * DNS to give up against a stopped container, against a 5s ceiling with a
   * database query still to do.
   *
   * A deadline is not a substitute for the provider's own timeout: this bounds
   * how long we WAIT, while the underlying request keeps running until the
   * provider's AbortController fires. That is the honest description. It is
   * still the right layer, because it covers the case boot-time configuration
   * cannot: when `MNEMO_EMBED_PROVIDER` is unset the embedder SHARES the
   * completion provider, whose long timeout is correct for generation and
   * wrong here.
   *
   * Cold starts are the reason this is not tighter. A local Ollama loading
   * `mxbai-embed-large` on its first call after idle can take seconds, and a
   * deadline that trips there would turn a warm-up into a silent downgrade to
   * lexical search. The readiness probe added in P127 embeds every ~10s, which
   * keeps the model resident and makes that window much rarer — but the knob
   * exists for operators whose provider is genuinely slower.
   *
   * 3000ms is measured, not rounded. Against the local stack: a warm embed is
   * ~170ms, and a COLD one — first call after Ollama reloads
   * `mxbai-embed-large` — is ~2.3s. At 2500ms that left roughly 200ms of
   * margin, which is not margin. 3000ms leaves ~700ms over the observed cold
   * start while still leaving 2000ms under the 5s `storage.read` breaker for
   * the FTS query the fallback has to run. Both sides of that trade are real:
   * too tight silently downgrades healthy requests to lexical search, too
   * loose means the fallback never gets to run at all.
   */
  const EMBED_TIMEOUT_MS = Number(process.env.MNEMO_EMBED_TIMEOUT_MS ?? 3000);

  async function withDeadline<T>(op: () => Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        op(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `embed timed out after ${EMBED_TIMEOUT_MS}ms (${label}). The provider may be ` +
                    `unreachable or slow; recall degrades to full-text search. Raise ` +
                    `MNEMO_EMBED_TIMEOUT_MS if your provider is legitimately slower than this.`
                )
              ),
            EMBED_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function embedOne(text: string): Promise<number[]> {
    return withDeadline(() => embedOneInner(text), embedModel);
  }

  async function embedOneInner(text: string): Promise<number[]> {
    if (embedProvider!.embedWithUsage) {
      const result = await embedProvider!.embedWithUsage(text, embedModel);
      onUsage?.({
        provider: result.provider,
        model: result.model,
        tokens: result.tokensUsed,
        ...(result.costUSD !== undefined ? { costUSD: result.costUSD } : {}),
      });
      return result.vector;
    }
    return embedProvider!.embed(text, embedModel);
  }

  /**
   * P117: the width the provider ACTUALLY returned must match the width this
   * adapter advertises, which the vector store was sized from.
   *
   * `resolveEmbedDimensions` now rejects an unsupported MNEMO_EMBED_DIMENSIONS
   * at boot, but that only validates what the operator DECLARED. The model is
   * free to disagree — point MNEMO_EMBED_MODEL at a 1024-dim model while the
   * config says 1536 and every vector is silently the wrong shape, with no
   * config error to find. Checking the returned array is the only place that
   * catches the disagreement, and it is cheap: one length comparison per embed.
   *
   * Throwing beats truncating or padding. A resized vector is not a worse
   * embedding, it is a different point in a space it was never computed in —
   * it would rank against everything else as noise while looking perfectly
   * healthy in the database.
   */
  /** P127: see healthCheck below — a readiness probe must not bill per poll. */
  const HEALTH_TTL_MS = 10_000;
  let healthCache: { value: { status: "ok" | "down"; latencyMs: number }; until: number } | null =
    null;

  function checkWidth(vec: number[]): number[] {
    if (vec.length !== embedDimensions) {
      throw new Error(
        `embed: model "${embedModel}" returned a ${vec.length}-dim vector but the ` +
          `vector store is configured for ${embedDimensions}. Set MNEMO_EMBED_DIMENSIONS ` +
          `to ${vec.length} (if the schema supports it) or switch to a ${embedDimensions}-dim model.`
      );
    }
    return vec;
  }

  return {
    id: semantic ? "llm-provider-embed" : "hash-stub-embed",
    model: embedModel,
    dimensions: embedDimensions,
    semantic,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const results: number[][] = new Array(texts.length);
      let next = 0;
      const worker = async () => {
        while (next < texts.length) {
          const i = next++;
          results[i] = await embedOne(texts[i]!);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(EMBED_BATCH_CONCURRENCY, texts.length) }, worker)
      );
      return results.map((vec) => new Float32Array(checkWidth(vec)));
    },
    async embedSingle(text: string): Promise<Float32Array> {
      const vec = await embedOne(text);
      return new Float32Array(checkWidth(vec));
    },
    /**
     * P127 — actually contact the provider.
     *
     * This returned a hardcoded `{ status: "ok" }`. It was the second layer of
     * the same lie: the health route defaulted an unwired adapter to "ok", and
     * the adapter it should have been calling would have said "ok" regardless
     * too. Wiring the route alone would have changed the code and not the
     * answer — with ollama stopped, `/health/ready` still reported `embed: ok`.
     *
     * Probes with a one-character string: the cheapest call that still crosses
     * the network and exercises auth, and the result is cached briefly because
     * a readiness endpoint is polled every few seconds and a paid provider
     * should not be billed for that. The cache is deliberately short — long
     * enough to absorb a probe loop, short enough that an outage surfaces in
     * seconds rather than minutes.
     *
     * The stub embedder (`semantic: false`) reports ok without a call: it has
     * no provider to be down, and pretending otherwise would make every
     * stub-mode deployment permanently degraded.
     */
    async healthCheck() {
      if (!semantic) return { status: "ok" as const, latencyMs: 0 };

      const now = Date.now();
      if (healthCache && now < healthCache.until) return healthCache.value;

      const started = now;
      try {
        await embedOne("x");
        const value = { status: "ok" as const, latencyMs: Date.now() - started };
        healthCache = { value, until: Date.now() + HEALTH_TTL_MS };
        return value;
      } catch (err) {
        const value = {
          status: "down" as const,
          latencyMs: Date.now() - started,
          detail: err instanceof Error ? err.message : String(err),
        };
        // Cached like a success so a hard outage does not turn every probe
        // into another timeout against a provider that is already struggling.
        healthCache = { value, until: Date.now() + HEALTH_TTL_MS };
        return value;
      }
    },
  };
}
