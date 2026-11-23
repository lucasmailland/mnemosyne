import type { Sql, TransactionSql } from "postgres";

/**
 * Sentinel workspace_id used for global (cross-workspace) config rows.
 * Any workspace context can read this row due to the RLS OR condition in
 * mnemo_workspace_config policy.
 */
export const GLOBAL_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Every key one LLM configuration is made of. They are written, deleted and
 * read as one unit (`replaceGroup` / `getMany`): written one by one, a
 * rotation could pair a new API key with the old endpoint, and a DELETE that
 * missed `base_url` let the next PUT send its key to the old proxy. Retention
 * windows share the table under their own keys and are never touched here.
 */
export const LLM_CONFIG_KEYS = [
  "llm_provider",
  "llm_api_key",
  "llm_credentials",
  "llm_model",
  "embed_model",
  "temperature",
  "max_tokens",
  "embed_dimensions",
  "embed_batch_size",
  "base_url",
] as const;

/**
 * Port interface for reading/writing workspace-level or global LLM config.
 * Values are stored as base64-encoded encrypted blobs produced by KeyRingAdapter.
 *
 * This interface is intentionally server-package-internal — it is NOT promoted
 * to @mnemo-ai/types in this version (see design doc §Store location).
 */
export interface WorkspaceConfigStore {
  /** Returns the encrypted blob for the given key, or null if absent. */
  get(workspaceId: string, key: string): Promise<string | null>;
  /** Upserts the encrypted blob for the given key. */
  set(workspaceId: string, key: string, valueEnc: string, updatedBy?: string): Promise<void>;
  /** Removes the config row. No-op when absent. */
  delete(workspaceId: string, key: string): Promise<void>;
  /**
   * Reads several keys in ONE statement, so they come from one snapshot.
   * Absent keys are left out of the map.
   */
  getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, string>>;
  /**
   * Replaces a group of keys as one unit: in one transaction, every key of
   * `group` missing from `values` is deleted and the rest are upserted. Replaces
   * of the same workspace are serialized. Empty `values` deletes the group.
   */
  replaceGroup(
    workspaceId: string,
    group: readonly string[],
    values: Readonly<Record<string, string>>,
    updatedBy?: string,
  ): Promise<void>;
}

/**
 * `WorkspaceConfigStore` backed by `mnemosyne.mnemo_workspace_config`.
 * Uses raw postgres.js tagged-template queries (NOT drizzle-orm) to avoid
 * pulling in the ORM as a dependency in this code path.
 *
 * The security boundary is the API key / scope check in the route layer, but
 * the table is FORCE RLS: its policy (that workspace or the global sentinel)
 * casts the `mnemosyne.workspace_id` GUC to uuid. On a bare pooled connection
 * the GUC is unset, so writes violate the policy, or it is '' left by an
 * earlier transaction, so every statement throws `invalid input syntax for
 * type uuid` (LIFECYCLE-2). Each statement therefore runs in its own short
 * transaction with the GUC set LOCAL to the row's workspace, which also keeps
 * it from leaking to the next user of the connection.
 *
 * `value_enc` is `bytea`, while the blobs are base64 text: they are written
 * and read back through UTF-8 so `get` returns the string `set` was given.
 */
export class PgWorkspaceConfigStore implements WorkspaceConfigStore {
  constructor(private readonly sql: Sql) {}

  private inWorkspace<T>(workspaceId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`
        SELECT set_config('app.workspace_id', ${workspaceId}, true),
               set_config('mnemosyne.workspace_id', ${workspaceId}, true)
      `;
      return fn(tx);
    }) as Promise<T>;
  }

  async get(workspaceId: string, key: string): Promise<string | null> {
    const rows = await this.inWorkspace(workspaceId, (tx) => tx<Array<{ value_enc: string }>>`
      SELECT convert_from(value_enc, 'UTF8') AS value_enc
      FROM mnemosyne.mnemo_workspace_config
      WHERE workspace_id = ${workspaceId}::uuid
        AND key = ${key}
    `);
    return rows[0]?.value_enc ?? null;
  }

  async set(workspaceId: string, key: string, valueEnc: string, updatedBy?: string): Promise<void> {
    await this.inWorkspace(workspaceId, (tx) => tx`
      INSERT INTO mnemosyne.mnemo_workspace_config
             (workspace_id, key, value_enc, updated_at, updated_by)
      VALUES (${workspaceId}::uuid, ${key}, convert_to(${valueEnc}, 'UTF8'), now(), ${updatedBy ?? null})
      ON CONFLICT (workspace_id, key) DO UPDATE
        SET value_enc  = EXCLUDED.value_enc,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
    `);
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    await this.inWorkspace(workspaceId, (tx) => tx`
      DELETE FROM mnemosyne.mnemo_workspace_config
      WHERE workspace_id = ${workspaceId}::uuid
        AND key = ${key}
    `);
  }

  async getMany(workspaceId: string, keys: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.inWorkspace(workspaceId, (tx) => tx<Array<{ key: string; value_enc: string }>>`
      SELECT key, convert_from(value_enc, 'UTF8') AS value_enc
      FROM mnemosyne.mnemo_workspace_config
      WHERE workspace_id = ${workspaceId}::uuid
        AND key = ANY(${[...keys]}::text[])
    `);
    return new Map(rows.map((r) => [r.key, r.value_enc]));
  }

  async replaceGroup(
    workspaceId: string,
    group: readonly string[],
    values: Readonly<Record<string, string>>,
    updatedBy?: string,
  ): Promise<void> {
    const keep = Object.keys(values);
    const stray = keep.filter((k) => !group.includes(k));
    if (stray.length > 0) {
      throw new Error(`replaceGroup: keys outside the group: ${stray.join(", ")}`);
    }
    await this.inWorkspace(workspaceId, async (tx) => {
      // Serialize replaces of this workspace. Two concurrent ones would
      // otherwise interleave: each DELETE misses the rows the other has not
      // committed yet, and a key only one of them sets survives next to the
      // other's values.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mnemo_workspace_config:${workspaceId}`}, 0))`;
      await tx`
        DELETE FROM mnemosyne.mnemo_workspace_config
        WHERE workspace_id = ${workspaceId}::uuid
          AND key = ANY(${[...group]}::text[])
          AND NOT (key = ANY(${keep}::text[]))
      `;
      for (const [key, valueEnc] of Object.entries(values)) {
        await tx`
          INSERT INTO mnemosyne.mnemo_workspace_config
                 (workspace_id, key, value_enc, updated_at, updated_by)
          VALUES (${workspaceId}::uuid, ${key}, convert_to(${valueEnc}, 'UTF8'), now(), ${updatedBy ?? null})
          ON CONFLICT (workspace_id, key) DO UPDATE
            SET value_enc  = EXCLUDED.value_enc,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by
        `;
      }
    });
  }
}
