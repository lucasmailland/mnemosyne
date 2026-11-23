// packages/core/src/api-key-lookup.ts
//
// `createApiKeyLookup` queries `mnemo_api_keys` (the table installed by
// core migration `0063_server_api_keys.sql`). It exposes
// `listActive()` + `touch()` — the exact pair the server's middleware in
// `server/src/auth.ts` consumes: it pulls the active key hashes and verifies
// the bearer token with BCRYPT behind a 60s LRU cache. There is ONE auth
// story (bcrypt); no parallel sha256 path.
//
// Extracted from factory.ts (lines 2731–2922) for maintainability.

import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { schema, type DbClient } from "./db";
import { isWorkspaceId, pgSessionTimeoutParams, resolvePgSessionTimeouts } from "@mnemo-ai/types";

// ─────────────────────────────────────────────────────────────────────
// API key lookup
// ─────────────────────────────────────────────────────────────────────

export interface ApiKeyLookupResult {
  workspaceId: string;
}

/**
 * The shape the @mnemo-ai/server boot path consumes from `app.ts`.
 * `listActive()` is the O(n) fallback for pre-0064 rows without a
 * lookup_hash. `findByLookupHash()` is the O(1) fast path added in
 * migration 0064 — call it first, fallback to listActive() only when
 * no row is found (meaning the key was issued before 0064 and hasn't
 * been lazy-backfilled yet). `setLookupHash()` performs that backfill.
 */
export interface CoreApiKeyLookup {
  listActive(): Promise<
    ReadonlyArray<{
      id: string;
      keyHash: string;
      workspaceId: string;
      scopes: string[];
      plan: string;
      ipAllowlist: string[];
      deprecatedAt: Date | null;
      userId: string | null;
      tenantId: string | null;
      keyKind: string;
      maxSensitivity: string | null;
      /** APP-026: the row has a lookup hash, so the O(n) bcrypt fallback skips it. */
      hasLookupHash: boolean;
    }>
  >;
  findByLookupHash(
    hash: string
  ): Promise<{
    id: string;
    keyHash: string;
    workspaceId: string;
    scopes: string[];
    plan: string;
    ipAllowlist: string[];
    deprecatedAt: Date | null;
    userId: string | null;
    tenantId: string | null;
    keyKind: string;
    maxSensitivity: string | null;
  } | null>;
  setLookupHash(id: string, hash: string): Promise<void>;
  /**
   * Best-effort `last_used_at` stamp for ONE key (`mnemo_api_keys.id`) —
   * never a workspace. Written at most once per {@link KEY_TOUCH_INTERVAL_MS}
   * per key, on its own one-connection pool (CHAOS-2).
   */
  touch(keyId: string): Promise<void>;
  verifyWorkspaceMember(userId: string, workspaceId: string): Promise<boolean>;
  /**
   * Return the caller's role in a workspace (owner/admin/write/read), or null
   * if not a member. Supersedes verifyWorkspaceMember for callers that need
   * to narrow scopes by role, not just gate on plain membership.
   */
  getWorkspaceMemberRole(userId: string, workspaceId: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface CreateApiKeyLookupOptions {
  databaseUrl: string;
}

/**
 * CHAOS-2: `last_used_at` is telemetry, so it is written at most once per key
 * per interval. It used to be rewritten on EVERY request for EVERY key of the
 * caller's workspace: wrong timestamps on keys never used, deadlocks between
 * concurrent multi-row updates, and an unbounded queue of updates on the auth
 * pool that stalled cold authentications for 15 s.
 */
export const KEY_TOUCH_INTERVAL_MS = 60_000;

export interface KeyTouchSchedulerOptions {
  /** Performs the actual write for one key. */
  write: (keyId: string) => Promise<void>;
  /** Minimum time between two writes for the same key. */
  intervalMs?: number;
  /** Most keys remembered at once; the least recently touched is forgotten first. */
  maxTracked?: number;
  /** Most writes outstanding at once; touches beyond it are dropped, not queued. */
  maxInFlight?: number;
  now?: () => number;
}

/**
 * Debounce `last_used_at` writes per key, in-process. A burst on one key
 * coalesces into one write (the key is stamped before the write starts). A
 * failed write keeps its stamp, so a failing database is not retried on every
 * request. Outstanding work is bounded: when `maxInFlight` writes are pending,
 * new touches are dropped.
 */
export function createKeyTouchScheduler(
  opts: KeyTouchSchedulerOptions
): (keyId: string) => Promise<void> {
  const intervalMs = opts.intervalMs ?? KEY_TOUCH_INTERVAL_MS;
  const maxTracked = opts.maxTracked ?? 10_000;
  const maxInFlight = opts.maxInFlight ?? 8;
  const now = opts.now ?? Date.now;
  // Insertion order doubles as recency order: re-stamping deletes first.
  const lastTouched = new Map<string, number>();
  let inFlight = 0;

  return async function touch(keyId: string): Promise<void> {
    if (!keyId) return;
    const at = now();
    const last = lastTouched.get(keyId);
    if (last !== undefined && at - last < intervalMs) return;
    if (inFlight >= maxInFlight) return;
    lastTouched.delete(keyId);
    lastTouched.set(keyId, at);
    if (lastTouched.size > maxTracked) {
      const oldest = lastTouched.keys().next().value;
      if (oldest !== undefined) lastTouched.delete(oldest);
    }
    inFlight++;
    try {
      await opts.write(keyId);
    } finally {
      inFlight--;
    }
  };
}

export function createApiKeyLookup(opts: CreateApiKeyLookupOptions): CoreApiKeyLookup {
  const { databaseUrl } = opts;
  if (!databaseUrl) {
    throw new Error("[@mnemo-ai/core] createApiKeyLookup: databaseUrl is required");
  }

  // INTENTIONAL EXCEPTION to the withMnemoTx rule — documented in CLAUDE.md.
  //
  // `mnemo_api_keys` is the auth bootstrap table. It is the ONLY mnemo_* table
  // that does NOT have ENABLE ROW LEVEL SECURITY (see migration 0001_baseline.sql).
  // The reason is a deliberate chicken-and-egg: `withMnemoTx` requires a known
  // workspaceId to set the session GUC — but the API key lookup IS what establishes
  // the workspaceId. You cannot look up the key through RLS because you don't yet
  // know which workspace to scope to.
  //
  // Security posture:
  //   - No RLS on the table by design; isolation is enforced by the lookup_hash
  //     (or bcrypt comparison) ensuring only the holder of the raw key can match.
  //   - Workspace isolation is enforced by returning the workspace_id from the
  //     matched row and setting it in the Hono context — all subsequent DB calls
  //     go through withMnemoTx with that workspace_id.
  //   - Invalid/unknown workspace_ids are rejected by isWorkspaceId() above.
  //
  // DO NOT add withMnemoTx here. DO NOT add RLS to mnemo_api_keys.

  // We open a SECOND, low-concurrency pool here rather than reusing the
  // one inside `createCore`. The auth path is hot but tiny; keeping the
  // pool separate avoids head-of-line blocking when recall jobs saturate
  // the main pool. Dynamic import for the same reason as createCore.
  //
  // We hold the raw postgres clients (lazily created) so `close()` can drain
  // the pools on host shutdown — otherwise they leak.
  //
  // CHAOS-2: `touch` gets its OWN one-connection pool. On the auth pool, a
  // backlog of touches queued ahead of the lookups that authenticate requests.
  type PoolClient = { end: (opts?: { timeout?: number }) => Promise<void> };
  const clientRefs: PoolClient[] = [];
  function lazyPool(max: number): () => Promise<DbClient> {
    let dbPromise: Promise<DbClient> | null = null;
    return () => {
      if (!dbPromise) {
        dbPromise = (async () => {
          const postgresMod = (await import("postgres")) as unknown as {
            default: (url: string, opts?: Record<string, unknown>) => unknown;
          };
          const client = postgresMod.default(databaseUrl, {
            max,
            connect_timeout: 10,
            connection: {
              search_path: "mnemosyne,public",
              // PG-TIMEOUTS: a stuck auth query or touch must not hold its
              // connection forever (MNEMO_PG_*_TIMEOUT_MS).
              ...pgSessionTimeoutParams(resolvePgSessionTimeouts(process.env)),
            },
          }) as PoolClient;
          clientRefs.push(client);
          return drizzlePg(client as never, { schema }) as unknown as DbClient;
        })();
      }
      return dbPromise;
    };
  }
  const getDbLocal = lazyPool(4);
  const getTouchDb = lazyPool(1);

  const touch = createKeyTouchScheduler({
    write: async (keyId) => {
      const db = await getTouchDb();
      // The interval is re-checked in SQL so replicas don't each write it.
      await db.execute(sql`
        UPDATE mnemo_api_keys
        SET last_used_at = now()
        WHERE id = ${keyId} AND revoked_at IS NULL
          AND (last_used_at IS NULL
               OR last_used_at < now() - make_interval(secs => ${KEY_TOUCH_INTERVAL_MS / 1000}))
      `);
    },
  });

  return {
    async listActive() {
      const db = await getDbLocal();
      const rows = (await db.execute(sql`
        SELECT id, key_hash, workspace_id, COALESCE(scopes, '{}'::text[]) AS scopes,
               COALESCE(plan, 'free') AS plan,
               COALESCE(ip_allowlist, '{}'::text[]) AS ip_allowlist,
               deprecated_at, user_id, tenant_id, COALESCE(key_kind, 'workspace') AS key_kind, max_sensitivity,
               (lookup_hash IS NOT NULL) AS has_lookup_hash
        FROM mnemo_api_keys
        WHERE revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
      `)) as unknown as Array<{
        id: string;
        key_hash: string;
        workspace_id: string;
        scopes: string[];
        plan: string;
        ip_allowlist: string[];
        deprecated_at: Date | null;
        user_id: string | null;
        tenant_id: string | null;
        key_kind: string;
        max_sensitivity: string | null;
        has_lookup_hash: boolean;
      }>;
      return rows
        .filter((r) => {
          if (!isWorkspaceId(r.workspace_id)) {
            console.warn(
              `[mnemo] API key has non-UUID workspace_id="${r.workspace_id}" — key rejected`
            );
            return false;
          }
          return true;
        })
        .map((r) => ({
          id: r.id,
          keyHash: r.key_hash,
          workspaceId: r.workspace_id,
          scopes: r.scopes ?? [],
          plan: r.plan ?? "free",
          ipAllowlist: r.ip_allowlist ?? [],
          deprecatedAt: r.deprecated_at ?? null,
          userId: r.user_id,
          tenantId: r.tenant_id,
          keyKind: r.key_kind ?? "workspace",
          maxSensitivity: r.max_sensitivity ?? null,
          hasLookupHash: r.has_lookup_hash === true,
        }));
    },

    async findByLookupHash(hash) {
      const db = await getDbLocal();
      const rows = (await db.execute(sql`
        SELECT id, key_hash, workspace_id, COALESCE(scopes, '{}'::text[]) AS scopes,
               COALESCE(plan, 'free') AS plan,
               COALESCE(ip_allowlist, '{}'::text[]) AS ip_allowlist,
               deprecated_at, user_id, tenant_id, COALESCE(key_kind, 'workspace') AS key_kind, max_sensitivity
        FROM mnemo_api_keys
        WHERE lookup_hash = ${hash} AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1
      `)) as unknown as Array<{
        id: string;
        key_hash: string;
        workspace_id: string;
        scopes: string[];
        plan: string;
        ip_allowlist: string[];
        deprecated_at: Date | null;
        user_id: string | null;
        tenant_id: string | null;
        key_kind: string;
        max_sensitivity: string | null;
      }>;
      const r = rows[0];
      if (!r) return null;
      if (!isWorkspaceId(r.workspace_id)) {
        console.warn(
          `[mnemo] API key has non-UUID workspace_id="${r.workspace_id}" — key rejected`
        );
        return null;
      }
      return {
        id: r.id,
        keyHash: r.key_hash,
        workspaceId: r.workspace_id,
        scopes: r.scopes ?? [],
        plan: r.plan ?? "free",
        ipAllowlist: r.ip_allowlist ?? [],
        deprecatedAt: r.deprecated_at ?? null,
        userId: r.user_id,
        tenantId: r.tenant_id,
        keyKind: r.key_kind ?? "workspace",
        maxSensitivity: r.max_sensitivity ?? null,
      };
    },

    async setLookupHash(id, hash) {
      const db = await getDbLocal();
      await db.execute(sql`
        UPDATE mnemo_api_keys
        SET lookup_hash = ${hash}
        WHERE id = ${id} AND lookup_hash IS NULL
      `);
    },

    touch,

    async verifyWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
      if (!userId || !workspaceId) return false;
      try {
        const db = await getDbLocal();
        const rows = await db.transaction(async (tx) => {
          const memberCheck = await tx.execute(
            sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
          );
          if ((memberCheck as unknown as Array<{ m?: boolean }> | undefined)?.[0]?.m) {
            await tx.execute(sql`SET LOCAL ROLE app_user`);
            await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
          }
          await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
          await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
          await tx.execute(sql`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`);
          return (await tx.execute(sql`
            SELECT 1 FROM mnemo_workspace_member
            WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
            LIMIT 1
          `)) as unknown as Array<Record<string, unknown>>;
        });
        return rows.length > 0;
      } catch (err) {
        console.warn(
          `[mnemo] verifyWorkspaceMember failed for user="${userId}" workspace="${workspaceId}":`,
          err
        );
        return false;
      }
    },

    async getWorkspaceMemberRole(userId: string, workspaceId: string): Promise<string | null> {
      if (!userId || !workspaceId) return null;
      try {
        const db = await getDbLocal();
        const rows = await db.transaction(async (tx) => {
          const memberCheck = await tx.execute(
            sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
          );
          if ((memberCheck as unknown as Array<{ m?: boolean }> | undefined)?.[0]?.m) {
            await tx.execute(sql`SET LOCAL ROLE app_user`);
            await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
          }
          await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
          await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
          await tx.execute(sql`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`);
          return (await tx.execute(sql`
            SELECT role FROM mnemo_workspace_member
            WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
            LIMIT 1
          `)) as unknown as Array<{ role: string }>;
        });
        return rows[0]?.role ?? null;
      } catch (err) {
        console.warn(
          `[mnemo] getWorkspaceMemberRole failed for user="${userId}" workspace="${workspaceId}":`,
          err
        );
        return null;
      }
    },

    async close() {
      // Only drains the pools that were actually opened.
      await Promise.all(clientRefs.map((c) => c.end({ timeout: 5 })));
    },
  };
}

/**
 * Assert that the connecting DB role is NOT a superuser and does NOT have
 * `bypassrls` — either would silently skip all RLS policies, making the
 * per-workspace isolation model worthless.
 *
 * Call this at server boot before accepting traffic. The check opens a
 * single throwaway connection so it works independently of any live pool.
 *
 * Suppression: set MNEMO_ALLOW_UNSAFE_DB_ROLE=true for CI / local dev
 * where you intentionally connect as postgres/superuser.
 */
export async function assertSafeDbRole({ databaseUrl }: { databaseUrl: string }): Promise<void> {
  const postgresMod = (await import("postgres")) as unknown as {
    default: (
      url: string,
      opts?: Record<string, unknown>
    ) => {
      end: (opts?: { timeout?: number }) => Promise<void>;
    } & ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>);
  };
  const pg = postgresMod.default(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    connection: { search_path: "mnemosyne,public" },
  });
  try {
    const rows = (await pg`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `) as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
    const row = rows[0];
    if (row && (row.rolsuper || row.rolbypassrls)) {
      const flag = row.rolsuper ? "rolsuper" : "rolbypassrls";
      throw new Error(
        `[SECURITY] The database role has ${flag}=true — all RLS policies are bypassed. ` +
          `This means workspace isolation does not work. Fix the connection string to use a ` +
          `restricted role (e.g. mnemo_app_role), or set MNEMO_ALLOW_UNSAFE_DB_ROLE=true ` +
          `to suppress this check (dev/CI only — NEVER in production).`
      );
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}
