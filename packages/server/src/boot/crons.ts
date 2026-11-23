import { logger } from "../logging.js";

export async function wireCrons(ctx: {
  databaseUrl: string;
  storageForDeps: NonNullable<import("../deps.js").ServerDeps["storage"]>;
  llm?: import("../deps.js").LLMProviderLike;
  outboxAdapter: unknown;
  /** LIFECYCLE-14: may return the tick's tally; failures then fail the cron tick. */
  sweepInactiveSessions: () => Promise<void | import("../cron/jobs.js").SessionSweepTally>;
  runManagedSessions?: () => Promise<void>;
  idempotencyStore: unknown;
  deps: import("../deps.js").ServerDeps;
  webhookSecretCipher: unknown;
  lastUtil: () => number;
  pluginLoader?: import("@mnemo-ai/plugins").PluginLoader;
  /** False when the embedder may not get confidential+ text (SECURITY.md §7). */
  sensitiveTextToEmbedder?: boolean;
  /** Drops agent policy change rows past every cache's TTL (migration 0067). */
  purgePolicyChanges?: () => Promise<number>;
}): Promise<{ stop(): void } | undefined> {
  // ── §28 cron registry startup (Wave Y2) ──────────────────────────────────────
  // Starts all 12 Wave-Y crons at their spec UTC schedules. Folds:
  //   mnemo.session.collapse  — was inline sessionSweepInterval (5 min)
  //   mnemo.metacognition.refresh — was inline metacognitionTimer (daily 07:00 UTC)
  //   mnemo.anticipate.mine — was inline anticipationMineInterval (daily 06:30 UTC)
  // plus 9 new crons from §28. Each tick is logged + metered. A throwing job
  // never stops the schedule (fault isolation via try/catch in runOnce).
  try {
    const { buildCronJobs } = await import("../cron/jobs.js");
    const { startCronRegistry, cronScope } = await import("../cron/registry.js");
    const disabled = new Set(
      (process.env["MNEMO_CRON_DISABLE"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    // Through the storage port, not a raw query: there is no workspace to set
    // the RLS GUC to, so as the application role a direct read of mnemo_fact
    // saw no rows and every per-workspace cron iterated nothing (migration 0041).
    const listWorkspaceIds = (): Promise<string[]> => ctx.storageForDeps.listWorkspaceIds();
    const cronTelemetry: import("@mnemo-ai/types").Telemetry = {
      startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    };
    // §35(p) embedding-migration embedder for the cron registry — built from the
    // configured LLM provider; absent when none is configured (cron no-ops).
    const cronEmbedModel = process.env.MNEMO_EMBED_MODEL ?? "text-embedding-3-small";
    const cronEmbed = ctx.llm
      ? {
          model: cronEmbedModel,
          embed: async (texts: string[]): Promise<Float32Array[]> => {
            const vs = await Promise.all(texts.map((t) => ctx.llm!.embed(t, cronEmbedModel)));
            return vs.map((v) => Float32Array.from(v));
          },
        }
      : undefined;
    // Wire plugin sync deps into the cron registry (replaces the raw setInterval
    // that was at ~lines 1096-1115). Dynamic import keeps the optional plugin
    // peer dep from becoming a hard build dependency at the cron level.
    let cronBuildPluginContext:
      import("../cron/jobs.js").CronDeps["buildPluginContext"] | undefined;
    try {
      const { buildPluginContext: bpcForCron } = await import("../plugins/context.js");
      // Wrap to match the CronDeps signature (which uses unknown for deps).
      cronBuildPluginContext = (opts) =>
        bpcForCron({ ...opts, deps: opts.deps as import("../deps.js").ServerDeps });
    } catch {
      /* plugin system unavailable — cron will no-op gracefully */
    }

    const jobs = buildCronJobs({
      storage: ctx.storageForDeps,
      // flatten-legacy-dual-core Phase 6d (PR17): the `core` field this used
      // to pass (a cast of the legacy core client into `{collapseSession(...)}`)
      // was investigated and confirmed dead — `CronDeps.core` was never read by any job
      // handler in `cron/jobs.ts` (the session-collapse job calls
      // `deps.collapseStaleSessions()` instead). Removed outright rather
      // than re-pointed at `deps.cognitive` — see `cron/jobs.ts`'s
      // `CronDeps` doc comment and apply-progress.md PR17.
      cache: ctx.deps.cache as any,
      llm: undefined,
      embed: cronEmbed,
      sensitiveTextToEmbedder: ctx.sensitiveTextToEmbedder === true,
      fileReader: undefined,
      outbox: ctx.outboxAdapter as import("@mnemo-ai/types").OutboxAdapter | undefined,
      listWorkspaceIds,
      collapseStaleSessions: ctx.sweepInactiveSessions,
      runManagedSessions: ctx.runManagedSessions,
      logger: logger as {
        info(o: object, m?: string): void;
        warn(o: object, m?: string): void;
        debug(o: object, m?: string): void;
      },
      telemetry: cronTelemetry,
      reapIdempotency: (
        ctx.idempotencyStore as { reap?(): Promise<{ reaped: number }> }
      ).reap?.bind(ctx.idempotencyStore),
      pluginLoader: ctx.pluginLoader as import("../cron/jobs.js").CronDeps["pluginLoader"],
      buildPluginContext: cronBuildPluginContext,
      serverDeps: ctx.deps,
      webhookSecretCipher: ctx.webhookSecretCipher as
        import("../encryption/webhookSecretCipher.js").WebhookSecretCipher | undefined,
      retentionConfigResolver: ctx.deps.retentionConfigResolver,
      // Only wired when a resolver exists: without one there is no agreed window,
      // and the managed retention job stays off rather than assuming a default.
      ...(ctx.deps.retentionConfigResolver
        ? {
            resolveTranscriptDays: async (workspaceId: string) =>
              (await ctx.deps.retentionConfigResolver!.resolve(workspaceId)).transcriptDays,
          }
        : {}),
    });
    const { decideShed, isPaused, priorityOf } = await import("@mnemo-ai/core");
    let shedState: import("@mnemo-ai/core").ShedState = { stage: 0, paused: new Set() };
    const shedGate = {
      isShed(jobKey: string): boolean {
        shedState = decideShed(ctx.lastUtil(), shedState);
        return isPaused(shedState, priorityOf(jobKey));
      },
    };
    // F15: durable meter persistence — drain the in-memory queue → mnemo_meter_event
    // every 5 minutes, alongside the existing crons. Fire-and-forget; failures are
    // logged inside persistDrainedMeterEvents and never stop the schedule.
    {
      const { persistDrainedMeterEvents } = await import("../metering/persist.js");
      const { globalMeterStore } = await import("../metering/MeterEmitter.js");
      const { aggregateMeterEvents } = await import("../metering/aggregate.js");
      jobs.push({
        key: "mnemo.meter.persist",
        schedule: { kind: "interval", ms: 300_000 },
        handler: async () => {
          // Snapshot the queue for the warm in-memory accumulator first (existing
          // behaviour), then write-through the same events to the durable table.
          const drained = globalMeterStore.peek();
          aggregateMeterEvents(drained.slice());
          const n = await persistDrainedMeterEvents(globalMeterStore, ctx.storageForDeps);
          logger.info({ persisted: n }, "meter.persist.tick");
        },
      });
    }
    // The agent policy change log the replicas poll (rbac-policy.ts) only needs
    // the last minute or so; one replica per run trims it.
    if (ctx.purgePolicyChanges) {
      const purge = ctx.purgePolicyChanges;
      jobs.push({
        key: "mnemo.policy.change.purge",
        schedule: { kind: "interval", ms: 3_600_000 },
        handler: async () => {
          logger.info({ purged: await purge() }, "policy.change_purge.tick");
        },
      });
    }
    // One replica per run: shared-state jobs take a Postgres advisory lock (see
    // cron/registry.ts cronScope). A connection per concurrently running job,
    // opened lazily; no session timeouts, since the lock's transaction stays
    // open while its job runs and ending it early would drop the lock.
    const { createPgCronLock } = await import("../cron/pgLock.js");
    const { default: postgres } = await import("postgres");
    const lockSql = postgres(ctx.databaseUrl, {
      max: Math.max(1, jobs.filter((j) => cronScope(j.key) === "cluster").length),
      idle_timeout: 60,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
    const cronRegistry = startCronRegistry(jobs, {
      logger: logger as { info(o: object, m?: string): void; warn(o: object, m?: string): void },
      telemetry: cronTelemetry,
      disabled,
      shedGate,
      lock: createPgCronLock(lockSql),
    });
    logger.info({ count: jobs.length }, "cron.registry_started");
    // APP-001: the audit-log partitions are ensured now, not next Sunday.
    {
      const { runAuditPartitionAtBoot } = await import("../cron/auditPartition.js");
      void runAuditPartitionAtBoot(jobs, disabled, logger);
    }
    return {
      stop() {
        cronRegistry.stop();
        void lockSql.end({ timeout: 5 }).catch(() => undefined);
      },
    };
  } catch (err) {
    logger.warn({ err }, "cron.registry_start_failed");
    return undefined;
  }
}
