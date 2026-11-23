/**
 * P134 — take the model cold start off the first request's critical path.
 *
 * Measured against the local stack. `POST /recall` is wrapped by the
 * `storage.read` circuit breaker at 5000ms, and the first call after a restart
 * blew it:
 *
 *   embed cold (bge-m3)        1409–1669 ms
 *   generate cold (qwen 0.5b)     836 ms
 *   recall pipeline, warm      1400–2955 ms
 *
 * No single component is near 5s. The sum is, and the fourth call onwards runs
 * in ~145ms — so the whole cost is loading weights that the very next request
 * would have found resident.
 *
 * Ollama also evicts on idle: `ollama ps` reports `UNTIL 3 minutes from now`
 * against a five-minute default `keep_alive`, on a host using 1.1 GB of 30.5 GB.
 * Nothing is under memory pressure; the models simply time out. So warming once
 * at boot is half the fix — the local override also pins `OLLAMA_KEEP_ALIVE`,
 * because a warmup that a five-minute idle undoes only helps the first user.
 *
 * NOT enabled by default. A warmup is free on a self-hosted ollama and is a
 * billed API call on OpenAI, where there is no cold start to amortise. It is
 * switched on where the local model stack is configured, the same way
 * `MNEMO_REMINDER_SEMANTIC_THRESHOLD` is — the deployment that picks the models
 * is the one that knows whether they need warming.
 */

export interface WarmModelsDeps {
  /** Embed port. Warmed with a one-character input. */
  embed?: { embedSingle(text: string): Promise<Float32Array> };
  /** LLM port. Warmed with a one-token prompt. */
  llm?: {
    generate(input: {
      messages: Array<{ role: string; content: string }>;
      task?: string;
    }): Promise<unknown>;
  };
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
  };
}

export function warmModelsEnabled(): boolean {
  return process.env.MNEMO_WARM_MODELS_ON_BOOT === "true";
}

/**
 * Fire-and-forget. Never throws, never blocks the listener, never fails boot.
 *
 * A warmup that can break startup would be strictly worse than the cold start
 * it prevents: the provider being unreachable is exactly the condition under
 * which the server most needs to come up and degrade (B5.9 / P128), not refuse
 * to start.
 */
export function warmModels(deps: WarmModelsDeps): void {
  if (!warmModelsEnabled()) return;

  const started = Date.now(); // determinism-ok: measuring elapsed time IS the point

  void (async () => {
    const results: Record<string, string> = {};

    if (deps.embed) {
      try {
        await deps.embed.embedSingle("x");
        results["embed"] = "warm";
      } catch (err) {
        results["embed"] = err instanceof Error ? err.message : String(err);
      }
    }

    if (deps.llm) {
      try {
        await deps.llm.generate({ messages: [{ role: "user", content: "ok" }], task: "default" });
        results["llm"] = "warm";
      } catch (err) {
        results["llm"] = err instanceof Error ? err.message : String(err);
      }
    }

    const elapsedMs = Date.now() - started; // determinism-ok: elapsed duration, not a fixed instant
    const failed = Object.entries(results).filter(([, v]) => v !== "warm");

    if (failed.length > 0) {
      // Warn, not error: a failed warmup costs latency on the first request and
      // nothing else. The request path has its own degradation.
      deps.logger.warn(
        { operation: "boot.warm_models", elapsedMs, results },
        "model warmup incomplete — first request will pay the cold start"
      );
      return;
    }
    deps.logger.info({ operation: "boot.warm_models", elapsedMs, results }, "models warmed");
  })();
}
