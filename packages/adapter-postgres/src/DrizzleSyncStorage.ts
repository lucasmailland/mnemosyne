/**
 * DrizzleSyncStorage — Postgres-backed implementation of the SyncStorage
 * interface (packages/federation/src/SyncEngine.ts).
 *
 * Replaces InMemorySyncStorage which loses all sync state on server restart.
 * Uses the three tables introduced in migration 0011_sync_storage.sql:
 *   • mnemo_federated_item  — findByRemoteId / upsertFederatedItem / archiveLocalItem
 *   • mnemo_sync_tombstone  — isInDeletionLog / insertDeletionLog (append-only)
 *   • mnemo_sync_cursor     — available for extension (not required by SyncStorage)
 *
 * IMPORTANT: This file must NOT import from @mnemo-ai/federation.
 * Doing so would create a circular dependency:
 *   adapter-postgres → federation → (types that might back-reference adapter-postgres)
 * TypeScript structural typing handles the interface satisfaction at the call site.
 *
 * RLS: the policies on mnemo_federated_item and mnemo_sync_tombstone read the
 * app.current_workspace_id GUC, and mnemo_sync_supersession reads
 * mnemosyne.workspace_id. Every method runs in its own transaction that sets
 * both (mnemosyne.mnemo_set_workspace, which rejects a non-uuid id, and
 * set_config(..., true)) and, like DrizzleSyncJobStore, downgrades to
 * app_user when the connection may, so a superuser connection (tests) obeys the
 * same policies as the production role (NOSUPERUSER NOBYPASSRLS). Without the
 * GUC that role got "unrecognized configuration parameter" on every call.
 *
 * Security invariants preserved:
 *   • attribution is always "federation_received" — enforced by CHECK constraint
 *     in the DB and by the upsertFederatedItem method signature.
 *   • Tombstone table is append-only — no UPDATE/DELETE granted to mnemo_app_role.
 *   • All tables have RLS + FORCE RLS (workspace_id scoped).
 */

import { eq, and, sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

// ─── Locally-mirrored types (mirrors SyncEngine.ts without importing it) ─────
// These must stay in sync with packages/federation/src/SyncEngine.ts manually.

interface LocalItemRef {
  localId: string;
  remoteId: string;
  version: number;
  workspaceId: string;
  peerDomain: string;
}

interface UpsertFederatedItemOpts {
  workspaceId: string;
  remoteId: string;
  peerDomain: string;
  version: number;
  attribution: "federation_received";
  payload: Record<string, unknown>;
}

interface InsertDeletionLogOpts {
  workspaceId: string;
  remoteId: string;
  peerDomain: string;
  reason: "federation_tombstone";
  deletedAt: string;
}

interface MarkSupersededOpts {
  workspaceId: string;
  supersededLocalId: string;
  remoteId: string;
  peerDomain: string;
}

type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

// ─── DrizzleSyncStorage ───────────────────────────────────────────────────────

export class DrizzleSyncStorage {
  constructor(private readonly db: DrizzleClient) {}

  /** fn in a transaction scoped to workspaceId for the sync tables' RLS. */
  private run<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const member = (await tx.execute(
        sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
      )) as unknown as Array<{ m?: boolean }>;
      if (member[0]?.m) await tx.execute(sql`SET LOCAL ROLE app_user`);
      // mnemo_set_workspace casts to uuid, so a malformed workspace id fails
      // here, closed, before any GUC is set; it sets mnemosyne.workspace_id.
      await tx.execute(sql`SELECT mnemosyne.mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`);
      return fn(tx);
    });
  }

  // ── findByRemoteId ──────────────────────────────────────────────────────────
  // Returns the LocalItemRef for a federated item, or null if not found or archived.

  async findByRemoteId(remoteId: string, workspaceId: string): Promise<LocalItemRef | null> {
    const rows = await this.run(workspaceId, (tx) =>
      tx
        .select({
          localId: schema.federatedItemTable.localId,
          remoteId: schema.federatedItemTable.remoteId,
          version: schema.federatedItemTable.version,
          workspaceId: schema.federatedItemTable.workspaceId,
          peerDomain: schema.federatedItemTable.peerDomain,
          archived: schema.federatedItemTable.archived,
        })
        .from(schema.federatedItemTable)
        .where(
          and(
            eq(schema.federatedItemTable.remoteId, remoteId),
            eq(schema.federatedItemTable.workspaceId, workspaceId)
          )
        )
        .limit(1)
    );

    const row = rows[0];
    if (!row || row.archived) return null;

    return {
      localId: row.localId,
      remoteId: row.remoteId,
      // bigint columns come back as number (mode: 'number' set in schema)
      version: Number(row.version),
      workspaceId: row.workspaceId,
      peerDomain: row.peerDomain,
    };
  }

  // ── isInDeletionLog ─────────────────────────────────────────────────────────
  // Checks if the remoteId appears in the tombstone/deletion log for this workspace.

  async isInDeletionLog(remoteId: string, workspaceId: string): Promise<boolean> {
    // remoteId is stored as UUID in item_id column.
    // Guard against non-UUID values to avoid a Postgres cast error.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(remoteId)) return false;

    const rows = await this.run(workspaceId, (tx) =>
      tx
        .select({ itemId: schema.syncTombstoneTable.itemId })
        .from(schema.syncTombstoneTable)
        .where(
          and(
            eq(schema.syncTombstoneTable.itemId, remoteId),
            eq(schema.syncTombstoneTable.workspaceId, workspaceId)
          )
        )
        .limit(1)
    );

    return rows.length > 0;
  }

  // ── upsertFederatedItem ─────────────────────────────────────────────────────
  // Insert or update a federated item. Returns the stable local UUID.
  // On conflict (remote_id, workspace_id), updates version/payload/peer_domain/updated_at.

  async upsertFederatedItem(opts: UpsertFederatedItemOpts): Promise<{ localId: string }> {
    const { workspaceId, remoteId, peerDomain, version, attribution, payload } = opts;

    const rows = await this.run(workspaceId, (tx) =>
      tx
        .insert(schema.federatedItemTable)
        .values({
          workspaceId,
          remoteId,
          peerDomain,
          version,
          attribution,
          payload,
          archived: false,
        })
        .onConflictDoUpdate({
          target: [schema.federatedItemTable.remoteId, schema.federatedItemTable.workspaceId],
          set: {
            peerDomain,
            version,
            attribution,
            payload,
            archived: false,
            updatedAt: new Date(),
          },
        })
        .returning({ localId: schema.federatedItemTable.localId })
    );

    const localId = rows[0]?.localId;
    if (!localId) {
      throw new Error(
        `DrizzleSyncStorage.upsertFederatedItem: no localId returned for remoteId=${remoteId}`
      );
    }

    return { localId };
  }

  // ── archiveLocalItem ────────────────────────────────────────────────────────
  // Soft-deletes a federated item by setting archived=true.
  // Workspace guard is enforced by RLS at the DB level and by the WHERE clause.

  async archiveLocalItem(localId: string, workspaceId: string): Promise<void> {
    await this.run(workspaceId, (tx) =>
      tx
        .update(schema.federatedItemTable)
        .set({ archived: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.federatedItemTable.localId, localId),
            eq(schema.federatedItemTable.workspaceId, workspaceId)
          )
        )
    );
  }

  // ── markSuperseded ──────────────────────────────────────────────────────────
  // §20 merge strategy: retain the prior local item (archive it) and record the
  // supersession chain link so the subsequent upsert allocates a fresh localId.
  //
  // Two writes in order:
  //   1. Archive the prior local item — this drops it from the findByRemoteId
  //      live index, allowing the subsequent upsert to allocate a FRESH localId.
  //   2. Append a row to mnemo_sync_supersession recording (remoteId,
  //      supersededLocalId, peerDomain). Chain is append-only (INSERT only).
  //
  // Both writes are workspace-scoped by the mnemosyne.workspace_id GUC that RLS
  // enforces — the same pattern as every other method in this file.  No superuser
  // bypass, no row_security = off.

  async markSuperseded(opts: MarkSupersededOpts): Promise<void> {
    const { workspaceId, supersededLocalId, remoteId, peerDomain } = opts;

    await this.run(workspaceId, async (tx) => {
      // 1. Archive the prior local item so findByRemoteId no longer returns it
      //    and the subsequent upsert allocates a fresh localId.
      await tx
        .update(schema.federatedItemTable)
        .set({ archived: true, updatedAt: new Date() })
        .where(
          and(
            eq(schema.federatedItemTable.localId, supersededLocalId),
            eq(schema.federatedItemTable.workspaceId, workspaceId)
          )
        );

      // 2. Record the supersession chain link (append-only).
      await tx
        .insert(schema.syncSupersessionTable)
        .values({
          workspaceId,
          remoteId,
          supersededLocalId,
          peerDomain,
        })
        .onConflictDoNothing();
    });
  }

  // ── insertDeletionLog ───────────────────────────────────────────────────────
  // Appends an entry to the append-only tombstone log.
  // remoteId is treated as a UUID (item_id column type).
  // On conflict (same item_id + workspace_id), silently skips — idempotent.

  async insertDeletionLog(opts: InsertDeletionLogOpts): Promise<void> {
    const { workspaceId, remoteId, peerDomain, reason, deletedAt } = opts;

    await this.run(workspaceId, (tx) =>
      tx
        .insert(schema.syncTombstoneTable)
        .values({
          itemId: remoteId,
          workspaceId,
          deletedAt: new Date(deletedAt),
          version: 0,
          peerDomain,
          reason,
        })
        .onConflictDoNothing()
    );
  }
}
