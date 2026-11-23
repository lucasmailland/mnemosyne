import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgSessionTimeoutParams, resolvePgSessionTimeouts, type PgSessionTimeouts } from '@mnemo-ai/types';
import * as schema from './schema/index.js';
import type { DrizzleClient } from './DrizzleStorageAdapter.js';

export interface PoolConfig {
  /** Primary database connection string (required). */
  url: string;
  /** Optional read-replica connection string. Reads are routed here when set. */
  replicaUrl?: string;
  /** Maximum pool connections. Default: 10. */
  max: number;
  /** Close connections idle for this many seconds. Default: 20. */
  idleTimeout: number;
  /** Recycle connections after this many seconds. Default: 1800. */
  maxLifetime: number;
  /**
   * Give up connecting after this many seconds. Default: 10 (was 30: with the
   * database unreachable, requests hung up to 35 s before failing — CHAOS-10).
   */
  connectTimeout: number;
  /**
   * PG-TIMEOUTS: statement / lock / idle-in-transaction limits sent on every
   * connection (`MNEMO_PG_*_TIMEOUT_MS`). Absent → the defaults.
   */
  sessionTimeouts?: PgSessionTimeouts;
}

type DeployMode = 'embedded' | 'standalone' | 'ha';

const DEPLOY_MODE_POOL_MAX: Record<DeployMode, number> = {
  embedded:   5,
  standalone: 10,
  ha:         20,
};

function isDeployMode(value: string): value is DeployMode {
  return value in DEPLOY_MODE_POOL_MAX;
}

/** Returns the pool-max default for a given deploy mode. Unknown/absent mode returns 10. */
export function resolvePoolDefaults(mode: string | undefined): { max: number } {
  if (mode !== undefined && isDeployMode(mode)) {
    return { max: DEPLOY_MODE_POOL_MAX[mode] };
  }
  return { max: 10 };
}

function parseIntEnv(val: string | undefined, defaultVal: number): number {
  const n = Number(val);
  return val !== undefined && val !== '' && !Number.isNaN(n) ? n : defaultVal;
}

/** Build a PoolConfig from process.env (or a supplied env object for testing). */
export function makePoolConfigFromEnv(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): PoolConfig {
  const url = env.DATABASE_URL ?? env.MNEMO_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const modeDefault = resolvePoolDefaults(env.MNEMO_DEPLOY_MODE).max;
  return {
    url,
    replicaUrl: env.DATABASE_REPLICA_URL,
    max:            parseIntEnv(env.MNEMO_PG_POOL_MAX,          modeDefault),
    idleTimeout:    parseIntEnv(env.MNEMO_PG_IDLE_TIMEOUT,      20),
    maxLifetime:    parseIntEnv(env.MNEMO_PG_MAX_LIFETIME,    1800),
    connectTimeout: parseIntEnv(env.MNEMO_PG_CONNECT_TIMEOUT,   10),
    sessionTimeouts: resolvePgSessionTimeouts(env),
  };
}

/** Internal helper — creates a postgres-js + drizzle pair for ONE connection string. */
function makePgPair(url: string, config: Omit<PoolConfig, 'url' | 'replicaUrl'>): {
  db: DrizzleClient;
  pgClient: postgres.Sql;
} {
  const pgClient = postgres(url, {
    max: config.max,
    idle_timeout: config.idleTimeout,
    connect_timeout: config.connectTimeout,
    max_lifetime: config.maxLifetime,
    connection: {
      search_path: 'mnemosyne,public',
      ...pgSessionTimeoutParams(config.sessionTimeouts ?? resolvePgSessionTimeouts({})),
    },
  });
  const db = drizzle(pgClient, { schema });
  return { db, pgClient };
}

/**
 * Creates primary + optional replica pools from a PoolConfig.
 * When replicaUrl is set, returns a replicaDb/replicaPgClient pair for routing reads.
 */
export function createDrizzlePool(config: PoolConfig): {
  db: DrizzleClient;
  pgClient: postgres.Sql;
  replicaDb: DrizzleClient | null;
  replicaPgClient: postgres.Sql | null;
} {
  const { db, pgClient } = makePgPair(config.url, config);
  if (config.replicaUrl) {
    const { db: replicaDb, pgClient: replicaPgClient } = makePgPair(config.replicaUrl, config);
    return { db, pgClient, replicaDb, replicaPgClient };
  }
  return { db, pgClient, replicaDb: null, replicaPgClient: null };
}
