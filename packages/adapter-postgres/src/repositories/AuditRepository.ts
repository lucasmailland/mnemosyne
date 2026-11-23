import { eq, and, isNull, isNotNull, lt, inArray, sql, count } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { mapRowToOutbox } from "./mappers.js";
import type { DrizzleClient, DekUnwrapper } from "./types.js";
import type { EncryptionTx } from "./EncryptionRepository.js";
import { computeAuditMerkleHash, bufferToHex, auditHashFields } from "../merkle.js";
import { encryptJson, decryptJson } from "../encryption/fact-cryptor.js";
import { resolveAuditActorType } from "@mnemo-ai/types";
import type { OutboxEntry, AuditLogEntry, AuditActivity } from "@mnemo-ai/types";
import { tallyAuditActivity } from "@mnemo-ai/types";

export class AuditRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient,
    /** Reads the actor's wrapped DEK on the caller's transaction (CHAOS-1). */
    private readonly getActorDek: (
      tx: EncryptionTx,
      workspaceId: string,
      actorId: string
    ) => Promise<string | null>,
    private readonly dekUnwrapper?: DekUnwrapper
  ) {}

  // ─── Audit (append-only) ────────────────────────────────────────────────────

  async appendAuditEntry(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Set workspace GUC for RLS policies
      await tx.execute(sql`SELECT mnemo_set_workspace(${entry.workspaceId}::uuid)`);

      // C2: serialize all audit appends for this workspace so two concurrent
      // writers cannot read the same prev and fork the chain. Advisory lock is
      // released automatically at tx end.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${entry.workspaceId}::text, 0))`
      );

      // §5: stamp the committed timestamp in app code so the chain can commit to
      // it AND the persisted created_at is byte-identical to what was hashed.
      const committedAt = new Date();

      // ── Merkle chain ──────────────────────────────────────────────────────────
      // The DB constraint (0001_baseline.sql audit_merkle_integrity) requires:
      //   is_terminal = false → merkle_hash IS NOT NULL
      //   is_terminal = true  → merkle_hash IS NULL (GDPR erasure record)
      // We compute the hash here inside the transaction so the chain is
      // serialised per workspace via pg_advisory_xact_lock above.
      let merkleHash: Buffer | null = null;
      // C2: app-generated UUID committed into the Merkle chain (the DB PK is a
      // BIGINT IDENTITY, unknown pre-INSERT; entryUid is known before hashing).
      const entryUid = crypto.randomUUID();
      if (!entry.isTerminal) {
        // Fetch the most recent hash for this workspace. The advisory lock above
        // already serialises concurrent appends — only one transaction can be
        // past pg_advisory_xact_lock for this workspace at a time, and a plain
        // READ COMMITTED statement always sees every previously-committed row,
        // so this read needs no locking clause of its own for correctness. NOT
        // `FOR UPDATE`: that requires UPDATE privilege on the table in Postgres
        // (regardless of the query never issuing an UPDATE), which S3's
        // append-only invariant deliberately revokes from `mnemo_app_role`
        // (`GRANT SELECT,INSERT` only, `0001_v3_complete_baseline.sql`) — a
        // `FOR UPDATE` read here made every soft-forget through
        // `deps.cognitive.forget()` 500 under the real production role, for
        // every primitive kind, not just skills.
        const prevRows = await tx.execute<{ merkle_hash: Buffer | null }>(
          sql`SELECT merkle_hash
               FROM mnemosyne.mnemo_audit_log
               WHERE workspace_id = ${entry.workspaceId}::uuid
                 AND is_terminal = false
               ORDER BY created_at DESC, id DESC
               LIMIT 1`
        );
        const prevHashHex = bufferToHex(prevRows[0]?.merkle_hash);

        // §5 — commit to ONLY the spec fields (entryId, action, resourceKind,
        // resourceId, occurredAt). metadata/userAgent are excluded so GDPR
        // crypto-erasure of the detail blob does not break chain verification.
        // auditHashFields is shared with verifyAuditChain so committed bytes and
        // recomputed bytes are byte-identical.
        merkleHash = computeAuditMerkleHash(
          auditHashFields({
            entryId: entryUid,
            action: entry.action,
            resourceKind: entry.resourceKind,
            resourceId: entry.resourceId ?? null,
            occurredAt: committedAt,
          }),
          prevHashHex
        );
      }
      // ─────────────────────────────────────────────────────────────────────────

      // RDD-6: stamp the per-actor DEK id so entries can be flagged as
      // key_destroyed after GDPR crypto-erasure (DEK id convention: 'dek-' + workspaceId + '-' + actorId).
      const actorDekId = entry.actorId ? `dek-${entry.workspaceId}-${entry.actorId}` : undefined;

      // C3: encrypt audit detail with the actor's DEK so GDPR crypto-erasure
      // (DEK destruction) renders the detail unreadable without breaking the chain.
      // CHAOS-1: read the DEK on THIS transaction. A second transaction would
      // need a second pool connection while we hold the advisory lock, and with
      // the pool full of appends queued on that lock it never gets one.
      let detailToStore: unknown = entry.detail ?? null;
      if (entry.actorId && entry.detail && this.dekUnwrapper) {
        const wrapped = await this.getActorDek(tx, entry.workspaceId, entry.actorId);
        if (wrapped) {
          const dek = this.dekUnwrapper(entry.workspaceId, entry.actorId, wrapped);
          detailToStore = encryptJson(
            dek,
            `dek-${entry.workspaceId}-${entry.actorId}`,
            entry.detail
          );
        }
      }

      await tx.insert(schema.auditLogTable).values({
        workspaceId: entry.workspaceId,
        // §6 Audit Trail: persist the real origin (agent/user/system/federation)
        // threaded from the auth context; never collapse everything to 'user'.
        actorType: resolveAuditActorType(entry),
        actorId: entry.actorId ?? "system",
        action: entry.action,
        resource: entry.resourceKind,
        resourceId: entry.resourceId,
        metadata: detailToStore as Record<string, unknown> | undefined,
        userAgent: entry.userAgent,
        isTerminal: entry.isTerminal,
        merkleHash: merkleHash ?? undefined,
        actorDekId,
        createdAt: committedAt,
        entryUid,
      });
    });
  }

  /**
   * AuditPort.getAuditActivity: the actors' entries per (UTC day, action) over the
   * window, and each actor's latest entry ever. Two grouped reads, workspace-scoped.
   */
  async getAuditActivity(input: {
    workspaceId: string;
    days: number;
    actorIds: string[];
  }): Promise<AuditActivity> {
    const { workspaceId: ws, days } = input;
    if (input.actorIds.length === 0) return tallyAuditActivity(days, [], {});
    // One text[] parameter, whatever the number of actors.
    const ids = `{${input.actorIds.map((id) => `"${id.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
    const since = sql`(((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp AT TIME ZONE 'UTC')`;
    const { groups, last } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      const groups = (await tx.execute(sql`
        SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, action,
               count(*)::int AS n
        FROM mnemosyne.mnemo_audit_log
        WHERE workspace_id = ${ws}::uuid AND actor_id = ANY(${ids}::text[])
          AND created_at >= ${since}
        GROUP BY 1, 2
      `)) as unknown as Array<{ day: string; action: string; n: number }>;
      const last = (await tx.execute(sql`
        SELECT actor_id, max(created_at) AS at
        FROM mnemosyne.mnemo_audit_log
        WHERE workspace_id = ${ws}::uuid AND actor_id = ANY(${ids}::text[])
        GROUP BY actor_id
      `)) as unknown as Array<{ actor_id: string; at: Date | string }>;
      return { groups: Array.from(groups), last: Array.from(last) };
    });
    return tallyAuditActivity(
      days,
      groups.map((g) => ({ ...g, n: Number(g.n) })),
      Object.fromEntries(last.map((r) => [r.actor_id, new Date(r.at).toISOString()]))
    );
  }

  async listAuditLog(
    workspaceId: string,
    limit: number
  ): Promise<import("@mnemo-ai/types").AuditLogEntry[]> {
    // C3 read-side: LEFT JOIN mnemo_actor_dek to detect destroyed DEKs.
    // When dek_status = 'destroyed', return { encrypted: true, key_destroyed: true }
    // as the detail instead of attempting decryption.
    // For live DEKs with encrypted blobs, attempt decryptJson; fall back to raw parsed JSON.
    //
    // Subquery: grab the last `limit` rows by id DESC, then re-order ASC for chain verification.
    type AuditRow = {
      id: number;
      workspace_id: string;
      actor_id: string | null;
      action: string;
      resource: string;
      resource_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
      merkle_hash: Buffer | null;
      entry_uid: string | null;
      is_terminal: boolean;
      actor_dek_id: string | null;
      dek_status: string | null;
      encrypted_key: string | null;
    };
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx.execute<AuditRow>(sql`
        SELECT a.id, a.workspace_id, a.actor_id, a.action, a.resource, a.resource_id,
               a.ip_address, a.user_agent, a.metadata, a.created_at, a.merkle_hash,
               a.entry_uid, a.is_terminal, a.actor_dek_id,
               d.status AS dek_status, d.encrypted_key
        FROM (
          SELECT * FROM mnemosyne.mnemo_audit_log
          WHERE workspace_id = ${workspaceId}::uuid
          ORDER BY id DESC
          LIMIT ${limit}
        ) a
        LEFT JOIN mnemosyne.mnemo_actor_dek d
          -- mnemo_actor_dek.workspace_id is text, the audit log's is uuid.
          ON d.workspace_id = a.workspace_id::text
          AND d.id::text = a.actor_dek_id
        ORDER BY a.id ASC
      `);
    });
    return rows.map((r) => {
      // C3: compute detail with crypto-erasure awareness
      let detail: Record<string, unknown> | undefined;
      if (r.dek_status === "destroyed") {
        detail = { encrypted: true, key_destroyed: true };
      } else if (r.metadata !== null) {
        const rawMetadata = r.metadata as unknown;
        const metaStr = typeof rawMetadata === "string" ? rawMetadata : JSON.stringify(rawMetadata);
        if (metaStr.startsWith("enc:v1:") && r.encrypted_key && this.dekUnwrapper && r.actor_id) {
          try {
            const dek = this.dekUnwrapper(r.workspace_id, r.actor_id, r.encrypted_key);
            detail = decryptJson(dek, metaStr) as Record<string, unknown>;
          } catch (err) {
            console.warn(
              `[audit] audit.detail_decrypt_failed workspaceId=${r.workspace_id} ` +
                `auditId=${r.id} actorId=${r.actor_id} — possible tamper: ${String(err)}`
            );
            detail = r.metadata as Record<string, unknown>;
          }
        } else {
          detail = r.metadata as Record<string, unknown>;
        }
      }
      return {
        id: String(r.id),
        workspaceId: r.workspace_id,
        actorId: r.actor_id ?? undefined,
        action: r.action as import("@mnemo-ai/types").AuditAction,
        resourceKind: r.resource,
        resourceId: r.resource_id ?? undefined,
        ipAddress: r.ip_address ?? undefined,
        userAgent: r.user_agent ?? undefined,
        detail,
        isTerminal: r.is_terminal,
        merkleHash: r.merkle_hash ? new Uint8Array(r.merkle_hash) : undefined,
        // AUDIT-MERKLE: one of the fields the chain commits to.
        ...(r.entry_uid ? { entryUid: r.entry_uid } : {}),
        createdAt: new Date(r.created_at),
      };
    });
  }

  // ─── Outbox ─────────────────────────────────────────────────────────────────

  async appendOutbox(entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): Promise<void> {
    await this.db.insert(schema.outboxTable).values({
      workspaceId: entry.workspaceId,
      eventType: entry.eventType,
      payload: entry.payload,
    });
  }

  async claimOutbox(limit: number): Promise<OutboxEntry[]> {
    return this.db.transaction(async (tx) => {
      // ADP-2: a worker that crashes after claiming (setting claimed_at) but
      // before markOutboxProcessed/markOutboxFailed runs leaves that row
      // claimed_at != null forever — invisible to every future claim, and
      // never reaches the dead-letter reaper (which only fires on processed/
      // failed rows). Reclaim entries whose claim is older than the lease
      // timeout, same as a fresh unclaimed row. Configurable via
      // OUTBOX_CLAIM_TIMEOUT_MS (default 5 minutes) for ops tuning.
      const timeoutMs = parseInt(process.env["OUTBOX_CLAIM_TIMEOUT_MS"] ?? "300000", 10);
      // SELECT FOR UPDATE SKIP LOCKED — concurrency-safe claim
      const rows = await tx.execute<schema.SelectOutbox>(
        sql`
          SELECT * FROM mnemo_outbox
          WHERE processed_at IS NULL
            AND (claimed_at IS NULL OR claimed_at < NOW() - (${timeoutMs} || ' milliseconds')::interval)
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `
      );

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const now = new Date();

      await tx
        .update(schema.outboxTable)
        .set({ claimedAt: now })
        .where(inArray(schema.outboxTable.id, ids));

      return rows.map(mapRowToOutbox);
    });
  }

  async markOutboxProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(schema.outboxTable)
      .set({ processedAt: new Date() })
      .where(inArray(schema.outboxTable.id, ids));
  }

  async markOutboxFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(schema.outboxTable)
      .set({
        lastError: error,
        attempts: sql`attempts + 1`,
        claimedAt: null,
        // Exponential backoff: 10s, 30s, 2m, 10m, 30m (indexed by current attempts before increment)
        nextAttemptAt: sql`CASE
          WHEN attempts = 0 THEN NOW() + INTERVAL '10 seconds'
          WHEN attempts = 1 THEN NOW() + INTERVAL '30 seconds'
          WHEN attempts = 2 THEN NOW() + INTERVAL '2 minutes'
          WHEN attempts = 3 THEN NOW() + INTERVAL '10 minutes'
          ELSE NOW() + INTERVAL '30 minutes'
        END`,
      })
      .where(eq(schema.outboxTable.id, id));
  }

  async reapDeadLetters(maxAttempts: number): Promise<number> {
    // ADP-6: without a claimed_at check, this raced a worker actively
    // retrying an entry that happens to already be at maxAttempts — the
    // reaper could dead-letter it mid-flight, then the worker's own
    // markOutboxProcessed/markOutboxFailed write lands after and silently
    // clobbers (or is clobbered by) the reaper's write, leaving last_error
    // wrong about what actually happened. Same timeout-based staleness
    // check as claimOutbox's own lease-timeout fix (ADP-2): a FRESH claim
    // means a worker is genuinely still processing it right now — skip. A
    // STALE claim means that worker is presumed crashed — reap it, or it
    // would otherwise be stuck claimed forever (claimOutbox itself won't
    // reclaim an already-maxed-out entry; it would just get reaped right
    // back out).
    const timeoutMs = parseInt(process.env["OUTBOX_CLAIM_TIMEOUT_MS"] ?? "300000", 10);
    const rows = await this.db
      .update(schema.outboxTable)
      .set({
        processedAt: new Date(),
        lastError: `dead_letter: exceeded ${maxAttempts} attempts`,
      })
      .where(
        and(
          isNull(schema.outboxTable.processedAt),
          sql`attempts >= ${maxAttempts}`,
          sql`(claimed_at IS NULL OR claimed_at < NOW() - (${timeoutMs} || ' milliseconds')::interval)`
        )
      )
      .returning({ id: schema.outboxTable.id });
    return rows.length;
  }

  async purgeOutbox(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .delete(schema.outboxTable)
      .where(
        and(
          isNotNull(schema.outboxTable.processedAt),
          lt(schema.outboxTable.processedAt, cutoff),
          // P74/P111 — never delete a discarded write that has not been
          // recovered yet.
          //
          // Until P74, a write whose prediction error fell below the surprise
          // threshold was diverted into a `staging_evaluation` queue job
          // instead of being written. The content still exists ONLY here, in
          // `mnemo_outbox`, and `scripts/backfill-p74-staged-writes.mjs`
          // replays it through POST /remember, stamping `p74BackfilledAt`.
          //
          // These rows LOOK purgeable and are not: the worker claimed them,
          // destructured `{job, data, opts}` out of a flat payload, got `{}`,
          // and stamped `processed_at` anyway. So `processed_at IS NOT NULL`
          // is true for every one of them, and on the dev instance all 201 are
          // already past any sane retention — a plain purge deletes the lot.
          //
          // The alternative was an operational rule ("wire the purge only
          // after running the backfill"), which is what kept this method
          // caller-less for months. A rule that lives in a document protects
          // nothing; this predicate cannot be forgotten, and it costs nothing
          // once the rows are stamped or gone.
          sql`NOT (
            ${schema.outboxTable.eventType} = 'queue_job'
            AND ${schema.outboxTable.payload}->>'job' = 'staging_evaluation'
            AND NOT (${schema.outboxTable.payload} ? 'p74BackfilledAt')
          )`
        )
      )
      .returning({ id: schema.outboxTable.id });
    return rows.length;
  }

  async countPendingOutbox(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(schema.outboxTable)
      .where(isNull(schema.outboxTable.processedAt));
    return rows[0]?.n ?? 0;
  }

  /**
   * Appends a row to mnemo_deletion_log (INSERT-only for app role).
   * No GUC needed — deletion_log has NO RLS (cross-workspace resurrection guard).
   */
  async appendDeletionLog(input: {
    workspaceId: string;
    deletedItemId: string;
    deletedItemType: string;
    deletionType: "soft" | "hard" | "gdpr_erasure" | "federation_tombstone" | "retention_purge";
    actorId: string;
    reason?: string;
    itemCreatedAt?: Date;
  }): Promise<void> {
    await this.db.insert(schema.deletionLogTable).values({
      workspaceId: input.workspaceId,
      deletedItemId: input.deletedItemId,
      deletedItemType: input.deletedItemType,
      deletionType: input.deletionType,
      actorId: input.actorId,
      reason: input.reason ?? null,
      itemCreatedAt: input.itemCreatedAt ?? null,
    });
  }
}
