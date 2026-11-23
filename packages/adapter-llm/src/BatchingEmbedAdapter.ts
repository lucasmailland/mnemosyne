/**
 * AB7.3 — Batching EmbedAdapter decorator (spec §35 lines 4437–4438).
 *
 * Wraps an EmbedAdapter and micro-batches individual embedSingle() calls
 * into one embed(texts[]) call per batch window.
 *
 * Flush triggers:
 *   1. Buffer reaches maxItems (default 100) — flush immediately
 *   2. maxWaitMs (default 50ms) elapses since first item in current batch
 *
 * Hexagonal-purity: depends only on @mnemo-ai/types — no DB/redis imports.
 * Instantiate in the server/factory layer and pass as ctx.embed.
 */

import type { EmbedAdapter, HealthStatus } from "@mnemo-ai/types";

export interface BatchingEmbedOptions {
  /** Max items per batch (default: 100). Spec line 4437. */
  maxItems?: number;
  /** Max wait in ms before flushing a partial batch (default: 50). Spec line 4438. */
  maxWaitMs?: number;
}

interface Pending {
  text: string;
  resolve: (v: Float32Array) => void;
  reject: (e: unknown) => void;
}

export class BatchingEmbedAdapter implements EmbedAdapter {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;

  private readonly base: EmbedAdapter;
  private readonly maxItems: number;
  private readonly maxWaitMs: number;
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(base: EmbedAdapter, opts: BatchingEmbedOptions = {}) {
    this.base = base;
    this.id = `batching:${base.id}`;
    this.model = base.model;
    this.dimensions = base.dimensions;
    this.maxItems = opts.maxItems ?? 100;
    this.maxWaitMs = opts.maxWaitMs ?? 50;
  }

  embedSingle(text: string): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });

      if (this.queue.length >= this.maxItems) {
        // Flush immediately — maxItems reached
        this.flush();
      } else if (!this.timer) {
        // Schedule flush after maxWaitMs
        this.timer = setTimeout(() => this.flush(), this.maxWaitMs);
      }
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    // For bulk calls, go through the base adapter directly (no micro-batching overhead)
    return this.base.embed(texts);
  }

  healthCheck(): Promise<HealthStatus> {
    return this.base.healthCheck();
  }

  /** Clear the flush timer (call in tests/teardown). */
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Reject any pending items
    for (const p of this.queue) {
      p.reject(new Error("BatchingEmbedAdapter destroyed"));
    }
    this.queue = [];
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    const texts = batch.map((p) => p.text);

    this.base.embed(texts).then(
      (vecs) => {
        for (let i = 0; i < batch.length; i++) {
          const vec = vecs[i];
          if (vec) {
            batch[i]!.resolve(vec);
          } else {
            batch[i]!.reject(new Error(`No embedding returned for index ${i}`));
          }
        }
      },
      (err) => {
        for (const p of batch) p.reject(err);
      },
    );
  }
}
