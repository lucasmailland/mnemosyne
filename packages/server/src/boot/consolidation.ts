import { sensitiveTextMayReachLlm } from "@mnemo-ai/types";
import { logger } from "../logging.js";

/**
 * SECURITY.md §7: the consolidation storage opens sealed facts only when their
 * text may reach the server's own judge (`all`, or a local `judge`). Otherwise
 * it gets no unwrapper and such rows read `[unreadable]`, which every
 * consolidation path skips. A workspace's own provider is never local, and the
 * scoped check still decides per adapter.
 */
export function consolidationDekUnwrapper<T>(
  policy: import("@mnemo-ai/types").SensitiveTextPolicy | undefined,
  bootLlm: import("@mnemo-ai/types").LLMAdapter | undefined,
  unwrapper: T | undefined
): T | undefined {
  // Every task consolidation can route, not only the judge: a locally answered
  // judge must not open text that another job then sends to an external model.
  const tasks = ["judge", "summary", "prefilter", "default"] as const;
  return unwrapper && tasks.every((t) => sensitiveTextMayReachLlm(policy, bootLlm, t))
    ? unwrapper
    : undefined;
}

export async function wireConsolidation(ctx: {
  databaseUrl: string;
  storageForDeps: import("../deps.js").ServerDeps["storage"];
  llm?: import("../deps.js").LLMProviderLike;
  v3?: import("../deps.js").MnemoCore;
  deps: import("../deps.js").ServerDeps;
  /**
   * auto-trigger-scoped-consolidation: the shared shedding-wrapped job queue.
   * When present, the scoped-conflict-check handler is registered against it
   * here — BEFORE the caller's outbox worker starts draining — so no job
   * appended in the window between queue creation and registration is lost.
   */
  queue?: import("@mnemo-ai/types").QueueAdapter;
  /** SECURITY.md §7, forwarded to the scoped conflict check. */
  sensitiveTextToProviders?: import("@mnemo-ai/types").SensitiveTextPolicy;
  /**
   * Opens confidential+ facts for the scoped check when the policy lets their
   * text reach the judge; without it they read `[unreadable]` and are skipped.
   */
  dekUnwrapper?: (workspaceId: string, actorId: string, wrapped: string) => Buffer;
}): Promise<{ stop(): void } | undefined> {
  const { databaseUrl, llm, v3, deps, queue, sensitiveTextToProviders, dekUnwrapper } = ctx;
  let schedStop: (() => void) | undefined;
  try {
    const [consolidationMod, adapterMod] = await Promise.all([
      import("@mnemo-ai/consolidation"),
      import("@mnemo-ai/adapter-postgres"),
    ]);

    const { db, pgClient } = adapterMod.createDrizzleClient(databaseUrl);
    const storage = new adapterMod.DrizzleStorageAdapter(
      db,
      undefined,
      consolidationDekUnwrapper(sensitiveTextToProviders, deps.llmAdapter, dekUnwrapper)
    );

    const schedulerCtx: import("@mnemo-ai/consolidation").SchedulerContext = {
      storage,
      actor: consolidationMod.CONSOLIDATION_SYSTEM_ACTOR,
      // Default-on kill switch; only an explicit "false" disables deep mode.
      mode: process.env.MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED !== "false" ? "deep" : "fast",
      // replayValidator is wired below when the LLM provider supplies a generate() method.
      // The LLMProviderLike interface only guarantees embed(); generate() is added by
      // concrete LLM adapters (e.g. adapter-llm). We check at runtime to keep the
      // server boot safe even when the LLM provider doesn't support text generation.
      replayValidator: (() => {
        const llmAny = llm as unknown as Record<string, unknown>;
        if (typeof llmAny?.["generate"] !== "function" || !v3) return undefined;
        return {
          llm: {
            generate: (
              opts: Parameters<import("@mnemo-ai/consolidation").ValidatorLLM["generate"]>[0]
            ) =>
              (llmAny["generate"] as Function)(opts) as ReturnType<
                import("@mnemo-ai/consolidation").ValidatorLLM["generate"]
              >,
          },
          recall: {
            search: (opts: { workspaceId: string; text: string; limit: number }) =>
              // v3.recall is (query, auth) => RecallResponse; we use the consolidated recall
              // by passing a synthetic auth context and flattening the result hits.
              (
                v3!.recall as unknown as {
                  search: (o: unknown) => Promise<Array<{ id: string; score?: number }>>;
                }
              )
                .search({
                  workspaceId: opts.workspaceId,
                  text: opts.text,
                  limit: opts.limit,
                })
                .then((r) => r.map((hit) => ({ id: hit.id, score: hit.score ?? 0 }))),
          },
          storage: {
            getRecentQueriesForFacts: (workspaceId: string, factIds: string[], limit: number) =>
              storage.getRecentQueriesForFacts(workspaceId, factIds, limit),
          },
        } satisfies import("@mnemo-ai/consolidation").ReplayValidatorContext;
      })(),
      async listWorkspaceIds(): Promise<string[]> {
        // The server runs as a non-superuser, non-BYPASSRLS role, so a raw read
        // of mnemo_fact here saw no rows under FORCE RLS and the scheduler never
        // consolidated a single workspace. Enumeration goes through the SECURITY
        // DEFINER function behind the storage port instead (migration 0041).
        return storage.listWorkspaceIds();
      },
      // P6: per-workspace replay validator resolver — uses workspace LLM config.
      // Falls back to the boot-time global validator when no workspace config exists.
      getReplayValidator: deps?.llmConfigResolver
        ? async (workspaceId: string) => {
            const { buildWorkspaceLlmAdapter } = await import("../config/WorkspaceLlmAdapter.js");
            const adapter = await buildWorkspaceLlmAdapter(
              workspaceId,
              deps.llmConfigResolver!,
              deps.llmAdapter
            );
            if (!adapter) return schedulerCtx.replayValidator;
            // Build a ValidatorLLM from the workspace adapter
            const llmAny = adapter as unknown as Record<string, unknown>;
            if (typeof llmAny?.["generate"] !== "function" || !v3)
              return schedulerCtx.replayValidator;
            return {
              ...schedulerCtx.replayValidator,
              llm: {
                // Only the server's own (env) adapter can be local; one a
                // workspace configured through /config/llm never is.
                ...(adapter === deps.llmAdapter && adapter.localTasks
                  ? { localTasks: adapter.localTasks }
                  : {}),
                generate: (
                  opts: Parameters<import("@mnemo-ai/consolidation").ValidatorLLM["generate"]>[0]
                ) =>
                  (llmAny["generate"] as Function)(opts) as ReturnType<
                    import("@mnemo-ai/consolidation").ValidatorLLM["generate"]
                  >,
              },
            } as import("@mnemo-ai/consolidation").ReplayValidatorContext;
          }
        : undefined,
    };

    // B6.35: Expose replay validator on deps for manual consolidation trigger route
    deps.replayValidator = schedulerCtx.replayValidator;
    deps.getReplayValidator = schedulerCtx.getReplayValidator as (
      workspaceId: string
    ) => Promise<unknown>;

    // auto-trigger-scoped-consolidation: register the write-time scoped
    // semantic conflict check handler against the shared job queue, when the
    // caller has one. This MUST happen before the caller starts draining its
    // outbox worker — the caller (server/index.ts) enforces that ordering by
    // calling wireConsolidation() before outboxWorker.start(). Non-fatal on
    // failure: consolidation itself still starts either way.
    if (queue) {
      try {
        const handler = consolidationMod.createScopedConflictCheckHandler({
          storage,
          actor: consolidationMod.CONSOLIDATION_SYSTEM_ACTOR,
          replayValidator: schedulerCtx.replayValidator,
          getReplayValidator: schedulerCtx.getReplayValidator,
          ...(sensitiveTextToProviders ? { sensitiveTextToProviders } : {}),
          logger: {
            warn: (msg: string, warnCtx?: Record<string, unknown>) =>
              logger.warn(warnCtx ?? {}, msg),
          },
        });
        await queue.process(consolidationMod.SCOPED_CONFLICT_JOB, handler);
        logger.info("scoped_conflict_check.registered");
      } catch (err) {
        // Non-fatal — matches the outer catch's posture: the server runs
        // without the scoped conflict check if registration fails.
        logger.warn({ err }, "scoped_conflict_check.registration_failed");
      }
    }

    const sched = consolidationMod.startConsolidationScheduler(schedulerCtx);
    schedStop = () => {
      sched.stop();
      // Close the scheduler's own DB pool gracefully.
      pgClient.end({ timeout: 5 }).catch(() => undefined);
    };

    logger.info({ mode: schedulerCtx.mode }, "consolidation.scheduler_started");
    return { stop: schedStop };
  } catch (err) {
    // Non-fatal — the server runs without consolidation if the peer dep is absent.
    logger.warn(
      { err },
      "consolidation.scheduler_unavailable — install @mnemo-ai/consolidation + @mnemo-ai/adapter-postgres to enable"
    );
    return undefined;
  }
}
