/**
 * In-process idempotency store — suitable for single-process dev/test.
 * For multi-replica production, replace with a Redis-backed implementation
 * that uses SETNX + expire for atomic serializable deduplication.
 */
import type { IdempotencyStore, BeginResult, RecoveryPoint } from "./idempotency.js";

interface IdempotencyRecord {
  requestHash: string;
  state: "in_flight" | "complete";
  recoveryPoint: RecoveryPoint;
  responseCode?: number;
  responseBody?: string;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>();

  async begin(workspaceId: string, key: string, requestHash: string): Promise<BeginResult> {
    const mapKey = `${workspaceId}:${key}`;
    const existing = this.records.get(mapKey);

    if (!existing) {
      this.records.set(mapKey, { requestHash, state: "in_flight", recoveryPoint: "started" });
      return { state: "new" };
    }

    if (existing.requestHash !== requestHash) {
      return { state: "mismatch" };
    }

    if (existing.state === "in_flight") {
      return { state: "in_flight" };
    }

    return {
      state: "replay",
      responseCode: existing.responseCode!,
      responseBody: existing.responseBody!,
    };
  }

  async complete(
    workspaceId: string,
    key: string,
    responseCode: number,
    responseBody: string,
  ): Promise<void> {
    const mapKey = `${workspaceId}:${key}`;
    const existing = this.records.get(mapKey);
    if (existing) {
      existing.state = "complete";
      existing.recoveryPoint = "completed";
      existing.responseCode = responseCode;
      existing.responseBody = responseBody;
    }
  }

  async recordPhase(
    workspaceId: string,
    key: string,
    phase: RecoveryPoint,
  ): Promise<void> {
    const existing = this.records.get(`${workspaceId}:${key}`);
    if (existing) existing.recoveryPoint = phase;
  }

  async getRecoveryPoint(
    workspaceId: string,
    key: string,
  ): Promise<RecoveryPoint | null> {
    return this.records.get(`${workspaceId}:${key}`)?.recoveryPoint ?? null;
  }
}

/**
 * §Idempotency RDD9: choose which idempotency store to construct. Pure so boot
 * wiring stays testable. Precedence:
 *   1. MNEMO_IDEMPOTENCY_STORE=postgres + a databaseUrl → "postgres"
 *      (DrizzleIdempotencyStore — durable recovery_point in PG, per-replica DB).
 *   2. MNEMO_IDEMPOTENCY_STORE=postgres + no databaseUrl → "memory" (explicit
 *      postgres opt-in cannot silently degrade to redis — surface the misconfig).
 *   3. a redis url                                        → "redis"
 *      (RedisIdempotencyStore — multi-replica shared recovery_point).
 *   4. otherwise                                          → "memory" (dev/test).
 */
export function selectIdempotencyStoreKind(opts: {
  idempotencyStoreEnv: string | undefined;
  redisUrl: string | undefined;
  databaseUrl: string | undefined;
}): "postgres" | "redis" | "memory" {
  if (opts.idempotencyStoreEnv === "postgres") {
    return opts.databaseUrl ? "postgres" : "memory";
  }
  if (opts.redisUrl) return "redis";
  return "memory";
}
