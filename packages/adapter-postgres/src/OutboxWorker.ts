import { isSensitiveTier, lshBands, sensitiveTextMayReachEmbedder } from "@mnemo-ai/types";
import { randomUUID } from "node:crypto";
import type {
  StorageAdapter,
  VectorAdapter,
  CacheAdapter,
  QueueAdapter,
  EmbedAdapter,
  EmbeddableTable,
  Logger,
  EnqueueOpts,
  WebhookFirePayload,
  Sensitivity,
  SensitiveTextPolicy,
} from "@mnemo-ai/types";
import type { OutboxEntry } from "@mnemo-ai/types";

// Primitive kinds that own an `embedding halfvec` column in their table and can
// therefore be semantically indexed (see EMBED_TABLE_META in DrizzleStorageAdapter
// + EmbeddableTable in ports.ts). `fact` lives in mnemo_fact and is written via
// the VectorAdapter (the only table that adapter targets); the rest are written
// in place via StorageAdapter.updateEmbeddingVector. `episode` gained its
// embedding column in DELTAMEM §16. `entity` gained its column in P16.
// `workflow` gained its column in P65 / migration 0033.
// Kinds NOT listed here (hyperedge) have no embedding column and
// cannot be vector-indexed without a schema migration — their vector_upsert
// entries are logged and skipped, which is why adding a kind to
// RECALLABLE_KINDS without adding it here produces an entry that is marked
// processed and indexes nothing.
const EMBEDDABLE_NON_FACT_KINDS: ReadonlySet<EmbeddableTable> = new Set<EmbeddableTable>([
  "decision",
  "skill",
  "strategy",
  "reasoning",
  "episode",
  "entity", // P16 — entity embedding
  "workflow", // P65 — migration 0033 added the column
  "task", // P65 — migration 0034
  "event", // P65 — migration 0034
]);

export interface OutboxWorkerConfig {
  batchSize?: number; // default: 50
  pollIntervalMs?: number; // default: 1000
  maxRetries?: number; // default: 3
  /**
   * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7). Under `none`, with an
   * embedder that is not local, a text-form job is embedded only after the
   * row's own tier is read back and found to be public or internal.
   */
  sensitiveTextToProviders?: SensitiveTextPolicy;
}

export class OutboxWorker {
  private batchSize: number;
  private pollIntervalMs: number;
  private maxRetries: number;
  private sensitiveTextToProviders: SensitiveTextPolicy | undefined;
  private cycleCount = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly vector: VectorAdapter,
    private readonly cache: CacheAdapter,
    private readonly queue: QueueAdapter,
    private readonly logger: Logger,
    config: OutboxWorkerConfig = {},
    // Optional embedder. When provided, the vector_upsert handler can index
    // text-form payloads (producers that enqueue { id, kind, text } without a
    // precomputed vector) by embedding here. When omitted, text-form payloads
    // for embeddable kinds FAIL (markOutboxFailed → retry → dead-letter) so
    // they are never acked as processed without the embedding being applied.
    private readonly embed?: EmbedAdapter
  ) {
    this.batchSize = config.batchSize ?? 50;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.maxRetries = config.maxRetries ?? 5;
    this.sensitiveTextToProviders = config.sensitiveTextToProviders;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async reaperBatch(): Promise<void> {
    const reaped = await this.storage.reapDeadLetters(this.maxRetries);
    if (reaped > 0) {
      this.logger.warn("outbox dead-letter reaper moved exhausted entries", {
        operation: "outbox.reaper",
        count: reaped,
        maxRetries: this.maxRetries,
      });
    }
  }

  async runBatch(): Promise<number> {
    this.cycleCount++;
    // Run the dead-letter reaper every 10 cycles to move permanently-failed
    // entries out of the claimable queue without hammering the DB.
    if (this.cycleCount % 10 === 0) {
      await this.reaperBatch();
    }

    const entries = await this.storage.claimOutbox(this.batchSize);
    if (entries.length === 0) return 0;

    const results = await Promise.allSettled(entries.map((e) => this.process(e)));

    let processed = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const entry = entries[i]!;
      if (result.status === "fulfilled") {
        await this.storage.markOutboxProcessed([entry.id]);
        processed++;
      } else {
        const error =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        await this.storage.markOutboxFailed(entry.id, error);
        this.logger.warn("outbox entry failed", {
          operation: "outbox.process",
          error: { type: "OutboxError", message: error },
        });
      }
    }
    return processed;
  }

  /**
   * vector_upsert handler. Producers enqueue one of two payload shapes:
   *
   *   - vector-form: { id, kind, vector } — embedding precomputed by the caller
   *     (e.g. core/v3 remember.ts). Routed straight to the sink.
   *   - text-form:   { id, kind, text }   — embedding NOT precomputed (e.g. the
   *     DrizzleStorageAdapter.createDecision/Skill/Strategy/Reasoning producers,
   *     and createFact which uses `statement`). Embedded here when an embedder
   *     was injected.
   *
   * Sink routing is dictated by where each kind stores its embedding:
   *   - fact → VectorAdapter.upsert (mnemo_fact is the only table that adapter
   *     targets).
   *   - decision/skill/strategy/reasoning/episode/entity → StorageAdapter.updateEmbeddingVector,
   *     which writes the embedding into that primitive's own table.
   *   - kinds with no embedding column (task, event, workflow,
   *     hyperedge) cannot be indexed; a precomputed vector for them would no-op
   *     against mnemo_fact, so we log and skip explicitly.
   */
  private async processVectorUpsert(entry: OutboxEntry): Promise<void> {
    const {
      id,
      kind,
      vector,
      text,
      spaceId,
      model: payloadModel,
      dimensions,
      source,
    } = entry.payload as {
      id: string;
      kind: string;
      vector?: number[];
      text?: string;
      revision?: number;
      spaceId?: string;
      model?: string;
      dimensions?: number;
      source?: string;
    };

    // Resolve the embedding: precomputed vector wins; otherwise embed the
    // text-form payload if we have an embedder.
    let embedding: Float32Array | undefined;
    let embeddingModel: string | undefined;
    if (vector) {
      embedding = new Float32Array(vector);
    } else if (typeof text === "string" && text.length > 0) {
      if (!this.embed) {
        // No embedder wired → cannot index a text-form payload. Throw so the
        // caller marks the entry failed (retry → dead-letter) instead of
        // acking an embedding that was never applied.
        throw new Error(
          `vector_upsert: text-form payload but no embedder injected (entry ${entry.id}, kind ${kind})`
        );
      }
      if (!sensitiveTextMayReachEmbedder(this.sensitiveTextToProviders, this.embed)) {
        // Re-read the tier at embedding time: the payload carries none, and a
        // row whose tier cannot be read counts as sensitive (fail closed).
        const tier = this.storage.getEmbeddingSourceSensitivity
          ? await this.storage.getEmbeddingSourceSensitivity(
              kind as EmbeddableTable,
              id,
              entry.workspaceId
            )
          : null;
        if (isSensitiveTier(tier as Sensitivity | null)) {
          this.logger.info("vector_upsert: confidential+ text not sent to the embedder", {
            operation: "outbox.vector_upsert",
            entryId: entry.id,
            kind,
          });
          return;
        }
      }
      embedding = await this.embed.embedSingle(text);
      embeddingModel = this.embed.model;
    } else {
      // Neither a vector nor indexable text — the payload is malformed and
      // can never be applied. Fail it so it dead-letters after maxRetries.
      throw new Error(
        `vector_upsert: payload has neither vector nor text (entry ${entry.id}, kind ${kind})`
      );
    }

    if (kind === "fact") {
      // mnemo_fact is the table PgVectorAdapter targets. Stamp the embedding
      // model when we computed it so embedding_model/embedding_stale stay correct.
      const metadata: Record<string, unknown> = { kind, workspaceId: entry.workspaceId };
      const model = embeddingModel ?? payloadModel;
      if (model !== undefined) metadata.model = model;
      if (entry.payload.revision !== undefined) metadata.revision = entry.payload.revision;
      if (spaceId !== undefined) metadata.spaceId = spaceId;
      if (dimensions !== undefined) metadata.dimensions = dimensions;
      if (source !== undefined) metadata.source = source;
      await this.vector.upsert(id, embedding, metadata);
      if (entry.payload.indexLsh === true) {
        const revision = entry.payload.revision as number;
        if (!Number.isSafeInteger(revision) || revision! < 1)
          throw new Error("Managed LSH indexing requires a valid fact revision");
        await this.storage.upsertFactLsh({
          workspaceId: entry.workspaceId,
          factId: id,
          revision: revision!,
          bands: lshBands(embedding, spaceId),
        });
      }
      return;
    }

    if (EMBEDDABLE_NON_FACT_KINDS.has(kind as EmbeddableTable)) {
      // These primitives carry their own embedding column. updateEmbeddingVector
      // writes it in place (workspace-scoped) and clears the stale flag. The
      // VectorAdapter is fact-only and would no-op here.
      const model = embeddingModel ?? this.embed?.model;
      if (model === undefined) {
        // vector-form payload for a non-fact kind without an embedder to supply
        // the canonical model id. updateEmbeddingVector requires a model stamp;
        // writing an unattributable embedding is not an option, and acking
        // without writing violates "processed ⇒ applied" — so fail the entry.
        throw new Error(
          `vector_upsert: non-fact embedding without a model stamp (entry ${entry.id}, kind ${kind})`
        );
      }
      await this.storage.updateEmbeddingVector(
        kind as EmbeddableTable,
        id,
        entry.workspaceId,
        Array.from(embedding),
        model
      );
      return;
    }

    // Kind has no embedding column (task/event/workflow/hyperedge).
    // Indexing is impossible without a schema migration; record it explicitly.
    this.logger.warn("vector_upsert: kind has no embedding column, not indexed", {
      operation: "outbox.vector_upsert",
      entryId: entry.id,
      kind,
    });
  }

  private async process(entry: OutboxEntry): Promise<void> {
    switch (entry.eventType) {
      case "vector_upsert": {
        await this.processVectorUpsert(entry);
        return;
      }
      case "vector_delete": {
        const { id, kind } = entry.payload as { id: string; kind?: string };
        // PRIM-10 — the vector adapter is the FACT index (mnemo_fact.embedding).
        // A non-fact delete used to be aimed at it with that kind's id: it
        // cleared nothing it should, and could clear a fact it should not. The
        // other kinds leave recall through their own liveness predicate
        // (status / valid_to per table), so there is nothing to do here.
        // Payloads without a kind predate the field; only facts produced them.
        if (kind !== undefined && kind !== "fact") {
          this.logger.debug("vector_delete: non-fact kind, fact index untouched", {
            operation: "outbox.vector_delete",
            entryId: entry.id,
            kind,
          });
          return;
        }
        await this.vector.delete(id, entry.workspaceId);
        return;
      }
      case "cache_bust": {
        const { pattern } = entry.payload as { pattern: string };
        await this.cache.deletePattern(pattern);
        return;
      }
      case "cache_set": {
        const { key, value, ttlMs } = entry.payload as {
          key: string;
          value: unknown;
          ttlMs: number;
        };
        await this.cache.set(key, value, { ttlMs });
        return;
      }
      case "queue_job": {
        const { job, data, opts, ...rest } = entry.payload as {
          job: string;
          data?: unknown;
          opts?: EnqueueOpts;
          [k: string]: unknown;
        };
        // P74: producers used to disagree on the payload shape. The canonical
        // form nests arguments under `data`, but two producers
        // (`staging_evaluation`, `anomaly_review`) wrote them flat alongside
        // `job`, so `data` came back undefined and `{}` was enqueued — the
        // content never travelled and nothing failed. Both producers are fixed,
        // but rows written before the fix are still sitting in `mnemo_outbox`
        // (purge_outbox() has never had a caller), so the flat form has to stay
        // readable for the backfill to recover them.
        let args = data;
        if (args === undefined && Object.keys(rest).length > 0) {
          this.logger.warn("queue_job: legacy flat payload, promoting siblings to data", {
            operation: "outbox.queue_job",
            entryId: entry.id,
            job,
          });
          args = rest;
        }
        await this.queue.enqueue(job, args ?? {}, opts);
        return;
      }
      case "webhook_fire": {
        const p = entry.payload as unknown as WebhookFirePayload;
        // RDD-8: Hand off to the spec-laddered delivery cron instead of delivering inline.
        // The mnemo.webhook.deliver cron (runWebhookDeliveryBatch) is the sole retrier;
        // it uses the [immediate,5m,30m,2h,24h] spec ladder and owns 3-strike auto-disable.
        // Inserting attempt=1 with nextAttemptAt=null makes the row immediately eligible.
        await this.storage.recordWebhookDelivery({
          id: randomUUID(),
          webhookId: p.webhookId,
          workspaceId: p.workspaceId,
          eventType: p.eventType,
          payload: p.payload,
          status: "pending",
          attempt: 1,
          // nextAttemptAt defaults to null → immediately eligible in listPendingWebhookDeliveries
        });
        return; // markOutboxProcessed is called by the caller; no re-throw
      }
      case "hyperedge_bump": {
        const { hyperedgeId } = entry.payload as { hyperedgeId: string };
        await this.storage.bumpHyperedgeActivation(hyperedgeId, entry.workspaceId);
        return;
      }
      case "lsh_upsert": {
        const { factId, revision, bands } = entry.payload as {
          factId: string;
          revision: number;
          bands: Array<{ bandIdx: number; bandHash: string }>;
        };
        if (!factId || !Number.isInteger(revision) || !Array.isArray(bands)) {
          this.logger.warn("lsh_upsert: malformed payload, skipping", { entryId: entry.id });
          return;
        }
        await this.storage.upsertFactLsh({
          workspaceId: entry.workspaceId,
          factId,
          revision,
          bands: bands.map((b) => ({ bandIdx: b.bandIdx, bandHash: BigInt(b.bandHash) })),
        });
        return;
      }
      default: {
        // APP-010: not consumed. During a rolling deploy an older replica can
        // claim an entry a newer one wrote; failing it leaves it for a replica
        // that knows the type (and dead-letters it if none ever does).
        const _exhaustive: never = entry.eventType;
        void _exhaustive;
        throw new Error(`unknown outbox event type "${String(entry.eventType)}"`);
      }
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.runBatch();
      } catch (err) {
        this.logger.warn("outbox batch error", {
          operation: "outbox.runBatch",
          error: {
            type: "BatchError",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
      this.scheduleNext();
    }, this.pollIntervalMs);
  }
}
