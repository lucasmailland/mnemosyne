import {
  DECAY_HALF_LIVES,
  decideProceduralTransition,
  runProceduralOptimization,
  migrateWorkspace,
  type EmbedMigrationEmbed,
  runGraduationTick,
} from "@mnemo-ai/core";
import {
  governanceSweep,
  hotTierKey,
  buildKnowledgeScheduler,
  extractionPriority,
} from "@mnemo-ai/core/cognitive";
import { parseConditionDsl, parseActionDsl } from "@mnemo-ai/types";
import { runWebhookDeliveryBatch } from "./webhookDelivery.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { MNEMO_CODES, type MnemoCode } from "../errorCodes.js";
import type {
  StorageAdapter,
  Telemetry,
  CacheAdapter,
  LLMAdapter,
  OutboxAdapter,
} from "@mnemo-ai/types";
import type { CronJob } from "./registry.js";
import { verifyCodebaseForWorkspace, type FileReader } from "./verify-codebase.js";
import { runStaleTaskCron } from "./staleTask.js";
import { kekRotateHandler } from "./kekRotate.js";
import { auditPartitionHandler } from "./auditPartition.js";
import {
  pluginSyncJobs,
  pluginVerifyHandler,
  type PluginLoaderLike,
  type PluginContextLike,
} from "./pluginSync.js";
import { retentionPurgeHandler, type RetentionPurgeDeps } from "./retention-purge.js";
import { managedSessionRetentionHandler } from "./managed-session-retention.js";

export const ALL_CRON_KEYS = [
  "mnemo.session.collapse",
  "mnemo.governance.propagate",
  "mnemo.reasoning.decay",
  "mnemo.semantic.decay",
  "mnemo.procedural.decay",
  "mnemo.hot.rebuild",
  "mnemo.verify.codebase",
  "mnemo.type.schedule",
  "mnemo.anticipate.mine",
  "mnemo.metacognition.refresh",
  "mnemo.hot.decay",
  "mnemo.reasoning.prune",
  "mnemo.hebbian.normalize",
  "mnemo.composition.validate",
  "mnemo.task.stale",
  "mnemo.procedural.evaluate",
  "mnemo.querycache.evict",
  "mnemo.audit.merkle",
  "mnemo.audit.merkle.publish",
  "mnemo.embed.migration",
  "mnemo.idempotency.reap",
  "mnemo.webhook.deliver",
  "mnemo.workspace.graduate",
  "mnemo.kek.rotate",
  "mnemo.audit.partition",
  "mnemo.plugin.verify",
  "mnemo.retention.purge",
  "mnemo.session.retention",
  "mnemo.outbox.purge",
  "mnemo.health.snapshot",
] as const;

export interface CronDeps {
  storage: StorageAdapter;
  /**
   * flatten-legacy-dual-core Phase 6d (PR17): a `core: { collapseSession(...) }`
   * field used to live here, populated from the server's legacy core client
   * in `boot/crons.ts`.
   * Investigated (not assumed) before porting: it was NEVER read anywhere in
   * this file — the "mnemo.session.collapse" job below only ever calls
   * `deps.collapseStaleSessions()` (wired from `index.ts`'s own
   * `sweepInactiveSessions`, which drives the LEGACY factory `core` instance
   * directly and is out of this PR's scope). Dead plumbing removed outright
   * rather than re-pointed at `deps.cognitive` — same "duck-type probe was
   * unreachable in production" class of finding as PR13's `metrics.ts` port,
   * except here the field was unreachable from EVERY caller, not just
   * production. See apply-progress.md PR17 for the full investigation trail.
   */
  cache?: CacheAdapter;
  llm?: LLMAdapter;
  /** RDD-5: transactional outbox adapter — used by graduation cron to enqueue hot rebuild. */
  outbox?: OutboxAdapter;
  /** §35(p) embedding-model migration: batch re-embedder. Absent → cron no-ops. */
  embed?: EmbedMigrationEmbed;
  /** False: `embed` may not get confidential+ text, so such rows are never re-embedded (SECURITY.md §7). */
  sensitiveTextToEmbedder?: boolean;
  fileReader?: FileReader;
  listWorkspaceIds: () => Promise<string[]>;
  /**
   * LIFECYCLE-14: may resolve with the tick's tally. `failed > 0` fails the
   * tick (cron.tick_error + an `error` run counter) instead of `cron.tick_ok`.
   */
  collapseStaleSessions: () => Promise<void | SessionSweepTally>;
  /** Managed recovery is independent of legacy candidate discovery failures. */
  runManagedSessions?: () => Promise<void>;
  /** Effective managed-transcript retention window for a workspace, in days.
   * Absent when no retention resolver is configured, which disables the purge. */
  resolveTranscriptDays?: (workspaceId: string) => Promise<number>;
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
    debug(o: object, m?: string): void;
    /**
     * Error-level sink for escalations that must page, not just log (§5/§3
     * audit-trail integrity). Optional so structural callers/tests need not
     * supply it; the real pino logger wired in index.ts implements it, so in
     * production this is always present.
     */
    error?(o: object, m?: string): void;
  };
  telemetry: Telemetry;
  /**
   * §5/§6.2 optional alert/page hook. When present, audit-integrity failures
   * (broken Merkle chain) fire it in addition to the error log + counter so a
   * PushNotification/PagerDuty bridge can page on-call. Absent → cron stays
   * observability-only (log + metric). Fire-and-forget; never throws into the
   * cron handler.
   */
  alert?: (event: {
    code: MnemoCode;
    severity: "critical" | "warning";
    workspaceId: string;
    message: string;
    details?: Record<string, unknown>;
  }) => void | Promise<void>;
  /** §35 Idempotency reaper — remove stuck in_flight records older than 72h. Optional. */
  reapIdempotency?: () => Promise<{ reaped: number }>;
  /**
   * Plugin loader duck-typed to keep the cron module decoupled from the
   * optional @mnemo-ai/plugins peer dependency.
   */
  pluginLoader?: PluginLoaderLike;
  /**
   * Factory for PluginContext instances, forwarded into the plugin crons.
   * When absent (import failed or plugin system disabled), the handler no-ops.
   */
  buildPluginContext?: (opts: {
    pluginId: string;
    config: Record<string, string | undefined>;
    workspaceId: string;
    deps: unknown;
    logger: {
      info(obj: Record<string, unknown>, msg?: string): void;
      warn(obj: Record<string, unknown>, msg?: string): void;
      error(obj: Record<string, unknown>, msg?: string): void;
    };
  }) => PluginContextLike;
  /** Raw server deps forwarded into buildPluginContext. */
  serverDeps?: unknown;
  /**
   * F12: decrypts the workspace-KEK-encrypted signing secret before HMAC in the
   * webhook delivery worker. When absent (dev), endpoint.secretHash is used as-is.
   */
  webhookSecretCipher?: import("../encryption/webhookSecretCipher.js").WebhookSecretCipher;
  /**
   * Optional per-workspace retention config resolver (P29).
   * When present, each retention purge tick resolves the effective windows per
   * workspace (3-tier: workspace → global sentinel → env). Absent → env fallback.
   */
  retentionConfigResolver?: import("../config/RetentionConfigResolver.js").RetentionConfigResolver;
}

const perWorkspace = async (deps: CronDeps, fn: (ws: string) => Promise<void>) => {
  for (const ws of await deps.listWorkspaceIds()) {
    try {
      await fn(ws);
    } catch (err) {
      deps.logger.warn({ ws, err }, "cron.workspace_error");
    }
  }
};

/** What one legacy session-sweep tick did with its candidates. */
export interface SessionSweepTally {
  total: number;
  collapsed: number;
  skipped: number;
  failed: number;
  /** Sessions archived because their last collapse attempt failed. */
  abandoned: number;
}

export function buildCronJobs(deps: CronDeps): CronJob[] {
  return [
    {
      key: "mnemo.session.collapse",
      schedule: { kind: "interval", ms: 300_000 },
      handler: async () => {
        const results = await Promise.allSettled([
          deps.collapseStaleSessions(),
          deps.runManagedSessions?.(),
        ]);
        for (const result of results)
          if (result.status === "rejected")
            deps.logger.warn(
              { error: "session_worker_unavailable" },
              "cron.session.recovery_error"
            );
        // LIFECYCLE-14: a tick is ok only if both workers ran and no collapse
        // failed. Both always run first (allSettled); then a rejected worker
        // (including a failed legacy discovery) or a failed collapse fails the
        // tick, so the registry logs cron.tick_error instead of cron.tick_ok.
        const [legacy, managed] = results;
        const problems: string[] = [];
        if (legacy.status === "rejected") {
          problems.push(`legacy session sweep failed: ${String(legacy.reason)}`);
        } else if (legacy.value && legacy.value.failed > 0) {
          problems.push(`${legacy.value.failed} of ${legacy.value.total} session collapses failed`);
        }
        if (managed.status === "rejected") {
          problems.push(`managed session worker failed: ${String(managed.reason)}`);
        }
        if (problems.length > 0) throw new Error(`session sweep: ${problems.join("; ")}`);
      },
    },
    {
      key: "mnemo.governance.propagate",
      schedule: { kind: "dailyUtc", hour: 2, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const tally = await governanceSweep(
            { storage: deps.storage, cache: deps.cache, maxHotTierSize: 1000 },
            ws
          );
          deps.logger.info({ ws, ...tally }, "cron.governance.propagate");
          deps.telemetry.counter("mnemo_governance_actions_total", tally.canonical, {
            ws,
            action: "canonical",
          });
          deps.telemetry.counter("mnemo_governance_actions_total", tally.promote, {
            ws,
            action: "promote",
          });
          deps.telemetry.counter("mnemo_governance_actions_total", tally.demote, {
            ws,
            action: "demote",
          });
        }),
    },
    {
      key: "mnemo.reasoning.decay",
      schedule: { kind: "dailyUtc", hour: 3, minute: 0 },
      handler: () =>
        perWorkspace(deps, (ws) =>
          deps.storage.decayKind(ws, "reasoning", DECAY_HALF_LIVES.reasoning).then(() => undefined)
        ),
    },
    // §25.2: drive the remaining kind-differentiated decay classes. semantic =
    // all active facts (H=58d); procedural = strategy/workflow/skill (H=173d).
    // (episodic is a no-op — Event is immutable, Episode carries no Beta columns.)
    {
      key: "mnemo.semantic.decay",
      schedule: { kind: "dailyUtc", hour: 3, minute: 15 },
      handler: () =>
        perWorkspace(deps, (ws) =>
          deps.storage.decayKind(ws, "semantic", DECAY_HALF_LIVES.semantic).then(() => undefined)
        ),
    },
    {
      key: "mnemo.procedural.decay",
      schedule: { kind: "dailyUtc", hour: 3, minute: 30 },
      handler: () =>
        perWorkspace(deps, (ws) =>
          deps.storage
            .decayKind(ws, "procedural", DECAY_HALF_LIVES.procedural)
            .then(() => undefined)
        ),
    },
    {
      key: "mnemo.embed.migration",
      schedule: { kind: "dailyUtc", hour: 6, minute: 45 },
      // §35(p) embedding-model migration: re-embed stale rows (embedding_model
      // != current) in batches via the core engine. No-op when no embedder is
      // configured, or when nothing is stale (the common case) — safe to run daily.
      handler: async () => {
        const embed = deps.embed;
        if (!embed) return;
        await perWorkspace(deps, async (ws) => {
          const res = await migrateWorkspace({
            storage: deps.storage,
            embed,
            workspaceId: ws,
            sensitiveTextToEmbedder: deps.sensitiveTextToEmbedder === true,
          });
          if (res.migrated > 0 || res.errors.length > 0) {
            deps.logger.info(
              { ws, migrated: res.migrated, errors: res.errors.length },
              "cron.embed.migration"
            );
            deps.telemetry.counter("mnemo_embed_migration_migrated_total", res.migrated, { ws });
          }
        });
      },
    },
    {
      // P68 — L3 query-cache eviction, the fast-follow P59 registered when it
      // chose Option A (insert-only, no eviction). Every eligible recall that
      // resolves from facts appends a row and nothing removed it except
      // replaceFact's whole-workspace bust, so storage grew without bound.
      //
      // Read cost was never the problem: lookupQueryCache is already bounded by
      // a 5-minute freshness window and a 200-row cap. Nothing older than that
      // window can ever be served, so an hour of retention is far past any
      // possible hit and leaves ample room for clock skew and a missed run.
      //
      // Hourly rather than daily because the table is append-per-recall: a busy
      // workspace accumulates far faster than the daily decay passes below, and
      // the delete is a bounded index scan per workspace.
      key: "mnemo.querycache.evict",
      schedule: { kind: "interval", ms: 3_600_000 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          if (!deps.storage.pruneQueryCache) return;
          const RETENTION_MS = 3_600_000;
          const pruned = await deps.storage.pruneQueryCache(ws, RETENTION_MS);
          if (pruned > 0) {
            deps.logger.info({ ws, pruned }, "cron.querycache.evict");
            // P68 task 2 — row-count visibility before growth becomes an
            // operational problem, rather than after.
            deps.telemetry.counter("mnemo_query_cache_evicted_total", pruned, { ws });
          }
        }),
    },
    {
      key: "mnemo.hot.rebuild",
      schedule: { kind: "dailyUtc", hour: 4, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          if (!deps.cache?.zincrby) return;
          const key = hotTierKey(ws);
          const TOP_N = 1000;
          const page = await deps.storage.queryFacts({
            workspaceId: ws,
            status: "active",
            offset: 0,
            limit: TOP_N,
          });
          // Sort by worth DESC and re-seed; idempotent because we only add positive
          // potentiation. Stale entries decay out via mnemo.hot.decay.
          const ranked = [...page.items].sort((a, b) => (b.worth ?? 0) - (a.worth ?? 0));
          let seeded = 0;
          for (const fact of ranked) {
            const score = Math.max(1, Math.round((fact.worth ?? 0.5) * 100));
            await deps.cache.zincrby(key, score, fact.id).catch(() => undefined);
            seeded++;
          }
          deps.logger.info({ ws, seeded }, "cron.hot.rebuild");
        }),
    },
    {
      key: "mnemo.verify.codebase",
      schedule: { kind: "dailyUtc", hour: 5, minute: 30 },
      handler: () =>
        perWorkspace(deps, (ws) =>
          verifyCodebaseForWorkspace({
            workspaceId: ws,
            storage: deps.storage,
            fileReader: deps.fileReader,
            llm: deps.llm,
            telemetry: deps.telemetry,
            logger: deps.logger,
          }).then(() => undefined)
        ),
    },
    {
      key: "mnemo.type.schedule",
      schedule: { kind: "dailyUtc", hour: 6, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const dist = await deps.storage.getKnowledgeDistribution(ws);
          const scheduler = buildKnowledgeScheduler(dist);
          const under = extractionPriority(scheduler).filter((p) => p.bias > 0);
          deps.logger.info(
            { ws, underrepresented: under.map((p) => `${p.type}:${p.bias.toFixed(3)}`) },
            "cron.type.schedule"
          );
          deps.telemetry.gauge("mnemo_knowledge_type_bias_count", under.length, { ws });
        }),
    },
    {
      key: "mnemo.anticipate.mine",
      schedule: { kind: "dailyUtc", hour: 6, minute: 30 },
      handler: () => deps.storage.refreshAnticipationViews(),
    },
    {
      key: "mnemo.metacognition.refresh",
      schedule: { kind: "dailyUtc", hour: 7, minute: 0 },
      handler: () => deps.storage.refreshMetacognitionViews(),
    },
    {
      key: "mnemo.hot.decay",
      schedule: { kind: "interval", ms: 3_600_000 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          if (!deps.cache?.zincrby || !deps.cache.zrangeByScore) return;
          const key = hotTierKey(ws);
          const DECAY = 1; // ACT-R hourly decrement; one recall (=+1) offsets one idle hour
          const members = await deps.cache
            .zrangeByScore(key, 1, Infinity)
            .catch(() => [] as string[]);
          let decayed = 0;
          for (const id of members) {
            await deps.cache.zincrby(key, -DECAY, id).catch(() => undefined);
            decayed++;
          }
          deps.logger.debug({ ws, decayed }, "cron.hot.decay");
        }),
    },
    {
      key: "mnemo.reasoning.prune",
      schedule: { kind: "weeklyUtc", weekday: 0, hour: 3, minute: 30 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const PRUNE_AFTER_DAYS = 30;
          const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86_400_000;
          const PAGE = 200;
          let offset = 0;
          let pruned = 0;
          // Only archived rows are prune-eligible; active/golden/quarantined are left alone.
          for (;;) {
            const page = await deps.storage.queryReasoning({
              workspaceId: ws,
              status: "archived",
              offset,
              limit: PAGE,
            });
            if (page.items.length === 0) break;
            for (const r of page.items) {
              const last = (r.lastUsedAt ?? r.updatedAt) as Date | undefined;
              const lastMs = last ? new Date(last).getTime() : 0;
              if (lastMs < cutoff) {
                await deps.storage.setReasoningStatus(r.id, ws, "pruned").catch(() => undefined);
                pruned++;
              }
            }
            offset += page.items.length;
            if (page.items.length < PAGE) break;
            if (offset >= 5000) break; // hard bound per tick
          }
          deps.logger.info({ ws, pruned }, "cron.reasoning.prune");
        }),
    },
    {
      key: "mnemo.hebbian.normalize",
      schedule: { kind: "weeklyUtc", weekday: 0, hour: 4, minute: 30 },
      handler: () =>
        perWorkspace(deps, (ws) => deps.storage.normalizeHebbianWeights(ws).then(() => undefined)),
    },
    {
      key: "mnemo.composition.validate",
      schedule: { kind: "weeklyUtc", weekday: 0, hour: 5, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const PAGE = 200;
          let offset = 0;
          let checked = 0;
          let deactivated = 0;
          for (;;) {
            const page = await deps.storage.queryCompositionRules({
              workspaceId: ws,
              isActive: true,
              offset,
              limit: PAGE,
            });
            if (page.items.length === 0) break;
            for (const rule of page.items) {
              checked++;
              let valid = true;
              try {
                parseConditionDsl(rule.conditionDsl);
                parseActionDsl(rule.actionDsl);
              } catch {
                valid = false;
              }
              if (!valid) {
                await deps.storage
                  .updateCompositionRule(rule.id, ws, { isActive: false })
                  .catch((err: unknown) => {
                    deps.logger.warn(
                      {
                        ws,
                        ruleId: rule.id,
                        ruleName: rule.name,
                        err: err instanceof Error ? err.message : String(err),
                      },
                      "cron.composition.validate.deactivate_failed — rule remains active despite invalid DSL"
                    );
                  });
                deactivated++;
                deps.logger.warn(
                  { ws, ruleId: rule.id, ruleName: rule.name },
                  "cron.composition.validate.deactivated"
                );
              }
            }
            offset += page.items.length;
            if (page.items.length < PAGE) break;
            if (offset >= 5000) break;
          }
          deps.logger.info({ ws, checked, deactivated }, "cron.composition.validate");
        }),
    },
    // T4: stale-task cron — flags tasks inactive for > 14 days to review queue
    {
      key: "mnemo.task.stale",
      schedule: { kind: "dailyUtc", hour: 8, minute: 0 },
      handler: () =>
        perWorkspace(deps, (ws) => runStaleTaskCron(ws, deps.storage).then(() => undefined)),
    },
    // §14 Procedural memory — weekly evaluate + A/B transition for all agents (spec §14, Wave U)
    {
      key: "mnemo.procedural.evaluate",
      schedule: { kind: "weeklyUtc", weekday: 1 /* Monday */, hour: 3, minute: 0 },
      handler: () => {
        if (!deps.llm) return Promise.resolve();
        return perWorkspace(deps, async (ws) => {
          // Discover agents that have scored trajectories
          const trajectories = await deps.storage.listScoredTrajectories?.(ws, "*", 1);
          // If trajectories exist, run per-agent optimization + transition
          // For now run a single pass with a wildcard agent — real deployments
          // extend this with a listActiveAgents() call when the port is added.
          const agentIds: string[] = [];
          if (trajectories && trajectories.length > 0) {
            // Unique agent ids from the first 100 trajectories
            const sample = (await deps.storage.listScoredTrajectories?.(ws, "*", 100)) ?? [];
            for (const t of sample) {
              const aid = t.promptVersionId ?? "default";
              if (!agentIds.includes(aid)) agentIds.push(aid);
            }
          }
          for (const agentId of agentIds) {
            try {
              await runProceduralOptimization(deps.storage, deps.llm!, ws, agentId);
              await decideProceduralTransition(deps.storage, ws, agentId);
            } catch (err) {
              deps.logger.warn({ ws, agentId, err }, "procedural.evaluate.agent_error");
            }
          }
        });
      },
    },
    // §6.2 Merkle root publication — hourly computation of Merkle tree root over last 1 000 audit
    // entries per workspace. Emits a structured log line for external anchoring (SECURITY.md §6.2).
    {
      key: "mnemo.audit.merkle.publish",
      schedule: { kind: "interval", ms: 3_600_000 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const entries = await deps.storage.listAuditLog(ws, 1_000);
          if (entries.length === 0) return;
          const { computeMerkleRoot } = await import("@mnemo-ai/adapter-postgres");
          const { root, entryCount, firstId, lastId } = computeMerkleRoot(entries);
          if (root === null) return;
          const hourUtc = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
          deps.logger.info(
            { ws, hourUtc, entryCount, firstId, lastId, merkleRoot: root, audit_merkle_root: true },
            "audit.merkle.root"
          );
          deps.telemetry.counter("audit.merkle.root_published", 1, { workspaceId: ws });
        }),
    },
    // §6 Merkle audit chain integrity verification — weekly scan per workspace.
    // A broken chain means the append-only audit log was tampered with (rows
    // deleted/edited/reordered), so it is a SECURITY incident, not a warning.
    // The cron registry swallows throws (see registry.ts runOnce), so detection
    // here is observability-only by construction — we therefore ESCALATE: emit
    // an error-level log + MNEMO_008 + a dedicated alert counter, and fire the
    // optional alert/page hook.
    //
    // PRODUCTION: wire `deps.alert` to PagerDuty/Opsgenie and alert on
    // `audit.merkle.broken` / `audit.merkle.integrity_alert` — on-call MUST be
    // paged on a broken chain; this is a tamper signal, not a degradation.
    {
      key: "mnemo.audit.merkle",
      schedule: { kind: "weeklyUtc", weekday: 2 /* Tuesday */, hour: 2, minute: 30 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          // Widened from 1 000 → 10 000: a 1 000-row cap let an attacker hide
          // tampering older than the most recent 1 000 entries. The bound stays
          // finite to keep the weekly scan O(bounded) per workspace.
          const VERIFY_WINDOW = 10_000;
          const entries = await deps.storage.listAuditLog(ws, VERIFY_WINDOW);
          if (entries.length === 0) return;
          // Dynamic import keeps @mnemo-ai/adapter-postgres as a peer dep
          // at the server boundary rather than a hard top-level import in the cron module.
          const { verifyAuditChain } = await import("@mnemo-ai/adapter-postgres");
          const broken = verifyAuditChain(entries);
          if (broken === -1) {
            deps.logger.info({ ws, checked: entries.length }, "audit.merkle.ok");
            return;
          }
          const detail = {
            ws,
            brokenIndex: broken,
            entryId: entries[broken]?.id,
            checked: entries.length,
            code: "MNEMO_008",
            reason: MNEMO_CODES.MNEMO_008,
          };
          // ESCALATE to error level (was warn) — broken chain = audit-integrity alert.
          const errorLog = deps.logger.error ?? deps.logger.warn;
          errorLog.call(deps.logger, detail, "audit.merkle.chain_broken");
          // Existing counter (kept) + a clearly-named alert counter so an
          // alerting rule can fire without parsing the broken-index label.
          // Labels are bounded (workspaceId only) — no per-entry cardinality.
          deps.telemetry.counter("audit.merkle.broken", 1, { workspaceId: ws });
          deps.telemetry.counter("audit.merkle.integrity_alert", 1, { workspaceId: ws });
          // Fire the optional page hook (fire-and-forget; must not break the loop).
          if (deps.alert) {
            try {
              await deps.alert({
                code: "MNEMO_008",
                severity: "critical",
                workspaceId: ws,
                message: MNEMO_CODES.MNEMO_008,
                details: {
                  brokenIndex: broken,
                  entryId: entries[broken]?.id,
                  checked: entries.length,
                },
              });
            } catch (err) {
              deps.logger.warn({ ws, err }, "audit.merkle.alert_hook_failed");
            }
          }
        }),
    },
    // §35 Idempotency reaper — purge stuck in_flight records older than 72h.
    // Only meaningful for Redis-backed stores (InMemory store has no reap method).
    {
      key: "mnemo.idempotency.reap",
      schedule: { kind: "dailyUtc", hour: 4, minute: 0 },
      handler: async () => {
        if (!deps.reapIdempotency) return;
        const { reaped } = await deps.reapIdempotency();
        deps.logger.info({ reaped }, "cron.idempotency.reaped");
        deps.telemetry.counter("mnemo_idempotency_reaped_total", reaped, {});
      },
    },
    // P74/P111 — outbox retention. `purgeOutbox` was implemented in every
    // adapter and had NO caller, so `mnemo_outbox` only ever grew: 2308 rows on
    // the dev instance, 1090 of them long past any retention.
    //
    // It stayed caller-less because of an ordering rule — "wire the purge only
    // after running the P74 backfill" — that lived in a backlog entry and
    // nowhere else. The rule was right: those discarded writes are marked
    // processed despite having gone nowhere, so a plain purge deletes content
    // that exists in no other table. The rule is now a predicate inside
    // `purgeOutbox` itself, where it cannot be forgotten, which is what made
    // wiring this safe.
    {
      key: "mnemo.outbox.purge",
      schedule: { kind: "dailyUtc", hour: 5, minute: 30 },
      handler: async () => {
        const retentionMs = Number(
          process.env.MNEMO_OUTBOX_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000
        );
        const purged = await deps.storage.purgeOutbox(retentionMs);
        if (purged > 0) {
          deps.logger.info({ purged, retentionMs }, "cron.outbox.purged");
        }
        deps.telemetry.counter("mnemo_outbox_purged_total", purged, {});
      },
    },
    // Webhook delivery worker — HMAC POST + 5-step backoff + dead-letter + 3-strike disable.
    // Runs every minute to pick up deliveries due for their next attempt.
    {
      key: "mnemo.webhook.deliver",
      schedule: { kind: "interval", ms: 60_000 },
      handler: async () => {
        const result = await runWebhookDeliveryBatch({
          storage: deps.storage,
          logger: deps.logger,
          telemetry: deps.telemetry,
          webhookSecretCipher: deps.webhookSecretCipher,
        });
        if (result.delivered + result.failed + result.retried > 0) {
          deps.logger.info(result, "cron.webhook.deliver");
        }
      },
    },
    // RDD-5: Workspace graduation — promote learning→production when any graduation
    // criterion is met (factCount≥50 | sessionCount≥10 | entityCount≥5 | days≥14).
    // Runs daily at 04:00 UTC. No-ops gracefully when adapter lacks mode methods.
    {
      key: "mnemo.workspace.graduate",
      schedule: { kind: "dailyUtc", hour: 4, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          if (!deps.outbox) return;
          // Wrap CronDeps.logger into the full @mnemo-ai/types Logger contract.
          const l = deps.logger;
          const graduationLogger: import("@mnemo-ai/types").Logger = {
            debug: (msg, ctx) => l.debug({ ...(ctx ?? {}), msg }),
            info: (msg, ctx) => l.info({ ...(ctx ?? {}), msg }),
            warn: (msg, ctx) => l.warn({ ...(ctx ?? {}), msg }),
            error: (msg, ctx) => (l.error ?? l.warn).call(l, { ...(ctx ?? {}), msg }),
            child: () => graduationLogger,
            fatal: (msg, ctx) => (l.error ?? l.warn).call(l, { ...(ctx ?? {}), msg }),
          };
          const result = await runGraduationTick(deps.storage, deps.outbox, graduationLogger, ws);
          if (result.graduated && result.eventName) {
            deps.logger.info({ ws, eventName: result.eventName }, "cron.workspace.graduated");
            deps.telemetry.counter("mnemo_workspace_graduations_total", 1, { ws });
            await dispatchWebhookEvent(deps, ws, result.eventName, { workspaceId: ws }).catch(
              () => undefined
            );
          }
        }),
    },
    // §35 KEK rotation — re-wrap all workspace DEKs under a new KEK version.
    // Gated behind MNEMO_KEK_ROTATE_ENABLED=true. No-ops when flag is absent
    // or when the storage adapter does not implement rotateWorkspaceKek().
    // Per-workspace errors are caught non-fatally so one failure cannot abort
    // the rotation of the remaining workspaces.
    // Schedule: 03:00 UTC on the first day of each quarter (Jan/Apr/Jul/Oct).
    {
      key: "mnemo.kek.rotate",
      schedule: { kind: "weeklyUtc", weekday: 0 /* Sunday */, hour: 3, minute: 0 },
      handler: () =>
        kekRotateHandler({
          listWorkspaceIds: deps.listWorkspaceIds,
          storage: deps.storage as { rotateWorkspaceKek?: (workspaceId: string) => Promise<void> },
          logger: deps.logger,
        }),
    },
    // §7-year audit-log retention floor — create next partition + optional prune.
    // Create-ahead: always runs (idempotent PG function from migration 0062).
    // Prune: only when MNEMO_AUDIT_DROP_ENABLED=true to prevent accidental loss.
    // Schedule: weekly on Sunday 01:00 UTC — low-traffic window, off-peak.
    {
      key: "mnemo.audit.partition",
      schedule: { kind: "weeklyUtc", weekday: 0 /* Sunday */, hour: 1, minute: 0 },
      handler: () =>
        auditPartitionHandler({
          storage: deps.storage as {
            runSql?: (query: string) => Promise<Array<Record<string, unknown>>>;
          },
          logger: deps.logger,
        }),
    },
    // §21 Plugin verify: each plugin's verify() over its own workspace's code
    // facts, failures to the review queue (see cron/pluginSync.ts).
    {
      key: "mnemo.plugin.verify",
      schedule: { kind: "dailyUtc", hour: 5, minute: 45 },
      handler: () => pluginVerifyHandler(deps).then(() => undefined),
    },
    // §21 Plugin sync: one `mnemo.plugin.sync:<id>` job per syncing plugin, on
    // its own syncInterval (see cron/pluginSync.ts).
    ...pluginSyncJobs(deps),
    // B1 SOC2 CF3 — Retention purge cron: soft-close facts past their tier
    // retention window per workspace; crypto-erase actor DEKs when all
    // encrypted facts are expired. Runs daily at 02:30 UTC.
    // Env vars: MNEMO_RETENTION_INTERNAL_DAYS (730), _CONFIDENTIAL_DAYS (365),
    // _RESTRICTED_DAYS (90), MNEMO_RETENTION_DRY_RUN (false).
    {
      key: "mnemo.session.retention",
      // An hour after the fact-retention purge, so the two never contend for the
      // same workspaces on the same connections.
      schedule: { kind: "dailyUtc", hour: 3, minute: 30 },
      handler: async () => {
        if (!deps.resolveTranscriptDays) return;
        await managedSessionRetentionHandler({
          storage: deps.storage,
          listWorkspaceIds: deps.listWorkspaceIds,
          resolveTranscriptDays: deps.resolveTranscriptDays,
          logger: deps.logger,
        });
      },
    },
    {
      key: "mnemo.retention.purge",
      schedule: { kind: "dailyUtc", hour: 2, minute: 30 },
      handler: () =>
        retentionPurgeHandler({
          listWorkspaceIds: deps.listWorkspaceIds,
          storage: deps.storage as RetentionPurgeDeps["storage"],
          logger: deps.logger,
          telemetry: deps.telemetry,
          retentionConfigResolver: deps.retentionConfigResolver,
        }),
    },
    // STATS-1 (docs/STATUS.md memory_stats finding, 2026-07-28): nothing in
    // this registry ever called getHealthSnapshot({fresh:true}) — the only
    // caller was the operator-only GET /governance/drift?fresh=true escape
    // hatch, which a human has to know to hit explicitly. mnemo_health could
    // therefore never receive a row through any automatic path, so
    // memory_stats permanently reported archived/withZeroHits/
    // decisions.active/relations.conflicts/hitRate30d as 0/null regardless
    // of the true numbers. @mnemo-ai/core's health/index.ts doc comment
    // already documented "Computed by the daily cron in
    // apps/web/worker/health-job.ts" — that cron lived in the original host
    // app this package was extracted from and was never ported here. This
    // is that port. Schedule: daily 03:00 UTC, after retention.purge (02:30)
    // and governance.propagate (02:00) settle each workspace's numbers for
    // the day, before anticipate.mine (06:30) / metacognition.refresh (07:00).
    //
    // flatten-legacy-dual-core Phase 9 (task 9.1): the handler itself now
    // calls `deps.storage.getHealthSnapshot(...)` (v3 StorageAdapter port)
    // instead of importing `@mnemo-ai/core`'s `getHealthSnapshot` directly —
    // same computed-metric definitions, implemented in adapter-postgres's
    // HealthRepository.
    {
      key: "mnemo.health.snapshot",
      schedule: { kind: "dailyUtc", hour: 3, minute: 0 },
      handler: () =>
        perWorkspace(deps, async (ws) => {
          const snap = await deps.storage.getHealthSnapshot({ workspaceId: ws, fresh: true });
          deps.logger.debug({ ws, factsArchived: snap?.factCountArchived }, "cron.health.snapshot");
        }),
    },
  ];
}
