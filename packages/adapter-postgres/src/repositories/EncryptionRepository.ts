import { dbNow } from "./_clock.js";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { DrizzleClient, DekUnwrapper, DekProvisioner } from "./types.js";

/** An open transaction on the write pool, as handed out by `db.transaction`. */
export type EncryptionTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

export class EncryptionRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient,
    private readonly dekUnwrapper?: DekUnwrapper,
    private readonly dekProvisioner?: DekProvisioner
  ) {}

  /**
   * Returns the base64-encoded wrapped DEK for an active actor, or null if
   * the DEK has been destroyed or never provisioned.
   *
   * Wave T3: wrapped in a workspace-scoped transaction so RLS on mnemo_actor_dek
   * is enforced correctly under FORCE ROW LEVEL SECURITY.
   */
  async getActorDek(workspaceId: string, actorId: string): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return this.getActorDekInTx(tx, workspaceId, actorId);
    });
  }

  /**
   * Same read as {@link getActorDek}, on a transaction the caller already
   * holds. The caller must have set the workspace GUC on `tx` (RLS on
   * mnemo_actor_dek reads it).
   *
   * CHAOS-1: the audit append reads the DEK while it holds the per-workspace
   * advisory lock. Opening a second transaction there took a second pool
   * connection; with every connection held by appends queued on that lock,
   * the holder waited forever and the whole pool wedged.
   */
  async getActorDekInTx(
    tx: EncryptionTx,
    workspaceId: string,
    actorId: string
  ): Promise<string | null> {
    const rows = await tx
      .select()
      .from(schema.actorDekTable)
      .where(
        and(
          eq(schema.actorDekTable.workspaceId, workspaceId),
          eq(schema.actorDekTable.actorId, actorId),
          eq(schema.actorDekTable.status, "active")
        )
      )
      .limit(1);
    // Slice 1 pt.2 (flatten-legacy-dual-core): mnemo_actor_dek.encrypted_key
    // is physically bytea — base64-encode the driver's Uint8Array/Buffer to
    // match this method's documented base64-string contract.
    const raw = rows[0]?.encryptedKey;
    return raw instanceof Uint8Array ? Buffer.from(raw).toString("base64") : (raw ?? null);
  }

  /**
   * Crypto-erases an actor's DEK by nulling the key material and marking it
   * 'destroyed'.  Returns true if a live DEK was found and destroyed.
   *
   * GDPR Article 17: no rows are deleted — the audit trail is preserved.
   *
   * Wave T3: wrapped in a workspace-scoped transaction so RLS on mnemo_actor_dek
   * fires and the update cannot cross workspace boundaries.
   */
  async destroyActorDek(workspaceId: string, actorId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .update(schema.actorDekTable)
        .set({ status: "destroyed", encryptedKey: null, destroyedAt: dbNow() })
        .where(
          and(
            eq(schema.actorDekTable.workspaceId, workspaceId),
            eq(schema.actorDekTable.actorId, actorId),
            eq(schema.actorDekTable.status, "active")
          )
        )
        .returning({ id: schema.actorDekTable.id });
      return rows.length > 0;
    });
  }

  /**
   * Crypto-erases EVERY DEK belonging to a platform user (mnemo_user.id),
   * across every actor_id/API key they've used. Returns the number of DEKs
   * destroyed (0, 1, or more).
   *
   * Why this exists alongside destroyActorDek: a person holding two API keys
   * gets two separate actor-keyed DEKs (mnemo_actor_dek is keyed on
   * (workspace_id, actor_id)). destroyActorDek only ever destroys ONE of
   * them — the exact bug that made GDPR erasure per-credential instead of
   * per-person. This bulk-updates every row sharing that user_id in one
   * transaction, which is safe: an API key's user_id binding is fixed for
   * the key's whole lifetime (see KeyRingAdapter.ts's header comment for the
   * full reasoning), so no actor-keyed DEK can straddle two different
   * people's data.
   *
   * Does NOT touch wrap/unwrap crypto — the AAD stays "<workspaceId>|<actorId>"
   * exactly as before; only the destroyed/status bookkeeping changes.
   *
   * GDPR Article 17: no rows are deleted — the audit trail is preserved.
   *
   * Wave T3-style RLS scoping: wrapped in a workspace-scoped transaction so
   * RLS on mnemo_actor_dek fires and the update cannot cross workspace
   * boundaries, matching destroyActorDek.
   */
  async destroyUserDeks(workspaceId: string, userId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .update(schema.actorDekTable)
        .set({ status: "destroyed", encryptedKey: null, destroyedAt: dbNow() })
        .where(
          and(
            eq(schema.actorDekTable.workspaceId, workspaceId),
            eq(schema.actorDekTable.userId, userId),
            eq(schema.actorDekTable.status, "active")
          )
        )
        .returning({ id: schema.actorDekTable.id });
      return rows.length;
    });
  }

  // ─── Wave X — GDPR hard delete ───────────────────────────────────────────

  /**
   * Physical row deletion for GDPR Article 17 "right to erasure".
   * Only mnemo_fact is supported; other primitives use crypto-erasure via DEK.
   * Must be called only after scope check ("memory:hard_delete").
   * GUC-guarded transaction.
   */
  async hardDeleteFact(
    id: string,
    workspaceId: string,
    audit?: { actorId: string; reason?: string }
  ): Promise<{ createdAt: Date } | false> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const deleted = await tx
        .delete(schema.factTable)
        .where(
          and(
            eq(schema.factTable.id, id),
            eq(schema.factTable.workspaceId, workspaceId),
            // B6.35: never hard-delete a fact mid-consolidation — a rollback
            // needs the row, and a false deletion-log entry must not be appended
            // for an operation that was later erased.
            sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
          )
        )
        .returning({ id: schema.factTable.id, createdAt: schema.factTable.createdAt });

      // P114: drop the derived content fingerprint with the row it describes.
      // mnemo_fact_hash keeps SHA-256(statement|subject|kind) plus seen_count and
      // timestamps; leaving it behind means an Article 17 erasure erases the
      // statement and preserves a confirmable fingerprint of it. Same
      // transaction, and gated on the DELETE having actually matched — the
      // consolidation guard above can make this a no-op, and wiping the hash for
      // a fact that is still there would break the P85.3 dedup lookup.
      //
      // The deletion-log entry for this path is appended by the caller
      // (cognitive/forget.ts hard mode), which is where the actor is known.
      if (deleted.length === 0) return false;
      await tx
        .delete(schema.factHashTable)
        .where(
          and(
            eq(schema.factHashTable.workspaceId, workspaceId),
            eq(schema.factHashTable.factId, id)
          )
        );

      // PRIM-13: close every open edge to or from the deleted row. Closed, not
      // deleted — relations are bitemporal, and the closing time is the record
      // of when the edge stopped being true.
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_relation
        SET valid_to = now()
        WHERE workspace_id = ${workspaceId}
          AND valid_to IS NULL
          AND (source_id = ${id} OR target_id = ${id})
      `);

      // SEC-4: DELETE /facts/:id/hard used to leave no trace at all. With an
      // actor, the deletion-log row and the index cleanup commit with the
      // DELETE or not at all — the same rule purgeForgottenFacts follows (P114).
      if (audit) {
        await tx.insert(schema.deletionLogTable).values({
          workspaceId,
          deletedItemId: id,
          deletedItemType: "fact",
          deletionType: "hard",
          actorId: audit.actorId,
          reason: audit.reason ?? null,
          // 0068: federation serves this deletion as a tombstone to peers that
          // may hold the fact, which takes its creation time.
          itemCreatedAt: deleted[0]!.createdAt,
        });
        await tx.insert(schema.outboxTable).values([
          { workspaceId, eventType: "vector_delete", payload: { id, kind: "fact" } },
          {
            workspaceId,
            eventType: "cache_bust",
            payload: { pattern: `mnemo:${workspaceId}:hot:*` },
          },
        ]);
      }
      // A caller writing its own deletion-log row (forget's GDPR path) takes the
      // creation time from here: the row is gone, nothing else can read it.
      return { createdAt: deleted[0]!.createdAt };
    });
  }
}
