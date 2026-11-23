import { sql } from "drizzle-orm";
import type {
  ManagedEffectClaim,
  ManagedSessionWorkerPort,
  OutboxAdapter,
  StorageAdapter,
} from "@mnemo-ai/types";
import type { DrizzleClient } from "./types.js";

type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

function rows<T>(value: unknown): T[] {
  return value as T[];
}

/**
 * Same non-bypass role + workspace GUCs every managed transaction installs.
 * Duplicated deliberately from ManagedSessionRepository rather than exported:
 * a shared mutable helper here would be a single point where RLS could be
 * relaxed for every caller at once.
 */
async function setWorkspaceContext(tx: Tx, workspaceId: string): Promise<void> {
  const membership = rows<{ m: boolean }>(
    await tx.execute(sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`)
  )[0];
  if (membership?.m) {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
  } else {
    const role = rows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      await tx.execute(
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      )
    )[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("[SECURITY] Unsafe database role cannot enforce workspace RLS");
    }
  }
  await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
  await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
}

/**
 * mnemo_managed_collapse_effect has no lease_owner column, so a claim stamps the
 * owner inside the payload under this key. It is stripped from every value handed
 * back to a caller, so an effect consumer never sees queue bookkeeping as data.
 */
const LEASE_KEY = "__managedLeaseOwner";

function stripLeaseOwner(payload: Record<string, unknown>): Record<string, unknown> {
  const { [LEASE_KEY]: _owner, ...rest } = payload;
  return rest;
}

interface EffectRow {
  id: string;
  workspace_id: string;
  collapse_operation_id: string;
  effect_kind: string;
  target_kind: string;
  target_id: string;
  payload: Record<string, unknown>;
}

export class ManagedWorkerRepository implements ManagedSessionWorkerPort {
  constructor(
    private readonly db: DrizzleClient,
    private readonly scoped: (tx: Tx) => StorageAdapter
  ) {}

  async isHarnessIngestionEnabled(input: { workspaceId: string }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const control = rows<{ ingestion_enabled: boolean }>(
        await tx.execute(sql`
          SELECT ingestion_enabled
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
        `)
      )[0];
      // No control row means the workspace was never fenced: open by default.
      return control === undefined ? true : control.ingestion_enabled;
    });
  }

  async disableHarnessIngestion(input: {
    workspaceId: string;
  }): Promise<{ ingestionEnabled: false; fenceEpoch: number }> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // FOR UPDATE first: this call must not return until every ingestion
      // transaction already holding the control row has committed or rolled
      // back. Reading without the lock would report a fence that in-flight
      // writers have not yet observed.
      const locked = rows<{ ingestion_enabled: boolean; fence_epoch: string }>(
        await tx.execute(sql`
          SELECT ingestion_enabled, fence_epoch::text AS fence_epoch
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
          FOR UPDATE
        `)
      )[0];

      // Idempotent: a second disable returns the epoch the first one minted
      // rather than advancing the fence again, so a retried rollback is safe.
      if (locked && !locked.ingestion_enabled) {
        return { ingestionEnabled: false as const, fenceEpoch: Number(locked.fence_epoch) };
      }

      const updated = rows<{ fence_epoch: string }>(
        await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_harness_workspace_control (workspace_id, ingestion_enabled, fence_epoch, updated_at)
          VALUES (${input.workspaceId}, false, 1, now())
          ON CONFLICT (workspace_id) DO UPDATE
            SET ingestion_enabled = false,
                fence_epoch = mnemosyne.mnemo_harness_workspace_control.fence_epoch + 1,
                updated_at = now()
          RETURNING fence_epoch::text AS fence_epoch
        `)
      )[0]!;
      return { ingestionEnabled: false as const, fenceEpoch: Number(updated.fence_epoch) };
    });
  }

  async heartbeatManagedCollapseLease(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) return false;
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // Lock the session first, then re-read expiry. Checking before the lock
      // would let a heartbeat that waited behind a reclaiming transaction
      // extend a lease it no longer holds.
      const session = rows<{ expired: boolean; lease_owner: string | null }>(
        await tx.execute(sql`
          SELECT collapse_lease_expires_at IS NULL
                 OR collapse_lease_expires_at <= clock_timestamp() AS expired,
                 collapse_lease_owner AS lease_owner
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.sessionId}
            AND status = 'collapse_pending'
            AND COALESCE(collapse_operation_id, 'managed:' || workspace_id || ':' || id || ':' || COALESCE(source_generation, -1)) = ${input.operationId}
          FOR UPDATE
        `)
      )[0];
      if (!session || session.expired || session.lease_owner !== input.leaseOwner) return false;

      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_session
        SET collapse_lease_expires_at = clock_timestamp() + make_interval(secs => ${input.leaseMs} / 1000.0)
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.sessionId}
      `);
      return true;
    });
  }

  async claimManagedCollapseEffects(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    leaseMs: number;
  }): Promise<ManagedEffectClaim[]> {
    const limit = Math.min(100, Math.max(1, input.limit));
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // SKIP LOCKED so concurrent drains take disjoint work. next_attempt_at in
      // the past is how both a fresh effect and an expired claim become due, so
      // recovery needs no separate sweep.
      const claimed = rows<EffectRow>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_managed_collapse_effect AS e
          SET status = 'processing',
              next_attempt_at = clock_timestamp() + make_interval(secs => ${input.leaseMs} / 1000.0),
              payload = e.payload || jsonb_build_object(${LEASE_KEY}::text, ${input.leaseOwner}::text)
          WHERE e.id IN (
            SELECT id FROM mnemosyne.mnemo_managed_collapse_effect
            WHERE workspace_id = ${input.workspaceId}
              AND status IN ('pending', 'processing')
              AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          RETURNING e.id::text AS id, e.workspace_id, e.collapse_operation_id,
                    e.effect_kind, e.target_kind, e.target_id, e.payload
        `)
      );
      return claimed.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        operationId: row.collapse_operation_id,
        leaseOwner: input.leaseOwner,
        effectKind: row.effect_kind as ManagedEffectClaim["effectKind"],
        targetKind: row.target_kind as ManagedEffectClaim["targetKind"],
        targetId: row.target_id,
        payload: stripLeaseOwner(row.payload),
      }));
    });
  }

  async completeManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      return completeUnderLock(tx, input);
    });
  }

  async retryManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const base = Math.max(1, input.baseRetryMs);
      const max = Math.max(base, input.maxRetryMs);
      const updated = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_managed_collapse_effect
          SET status = 'pending',
              -- Saturating, and widened first: attempts is a 32-bit column, so
              -- attempts + 1 overflows before LEAST can clamp it once an effect
              -- has actually reached the ceiling.
              attempts = LEAST(attempts::bigint + 1, 2147483647::bigint)::integer,
              last_error = ${input.error},
              next_attempt_at = clock_timestamp() + make_interval(secs => LEAST(
                ${max}::numeric,
                ${base}::numeric * power(2::numeric, LEAST(attempts, 30))
              ) / 1000.0),
              payload = payload - ${LEASE_KEY}::text
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.id}::uuid
            AND status = 'processing'
            AND payload->>${LEASE_KEY}::text = ${input.leaseOwner}
            AND next_attempt_at > clock_timestamp()
          RETURNING id::text AS id
        `)
      );
      return updated.length > 0;
    });
  }

  async runManagedCollapseEffect(
    input: { workspaceId: string; id: string; leaseOwner: string },
    apply: (ports: { storage: StorageAdapter; outbox: OutboxAdapter }) => Promise<void>
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // Claim ownership inside this transaction before running the callback, so a
      // rollback takes the completion with it and a stale owner never applies.
      const owned = rows<{ id: string }>(
        await tx.execute(sql`
          SELECT id::text AS id
          FROM mnemosyne.mnemo_managed_collapse_effect
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.id}::uuid
            AND status = 'processing'
            AND payload->>${LEASE_KEY}::text = ${input.leaseOwner}
            AND next_attempt_at > clock_timestamp()
          FOR UPDATE
        `)
      );
      if (owned.length === 0) return false;

      const storage = this.scoped(tx);
      // The effect's writes and its completion share this transaction: a throw
      // rolls both back together, and a success can never leave a completed row
      // without its side effect (or the reverse).
      await apply({
        storage,
        outbox: {
          append: (entry) => storage.appendOutbox(entry),
        } as OutboxAdapter,
      });

      return completeUnderLock(tx, input);
    });
  }
}

/** Shared by the standalone completion and the atomic one — same CAS, same clears. */
async function completeUnderLock(
  tx: Tx,
  input: { workspaceId: string; id: string; leaseOwner: string }
): Promise<boolean> {
  const updated = rows<{ id: string }>(
    await tx.execute(sql`
      UPDATE mnemosyne.mnemo_managed_collapse_effect
      SET status = 'completed',
          completed_at = clock_timestamp(),
          next_attempt_at = NULL,
          last_error = NULL,
          payload = payload - ${LEASE_KEY}::text
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.id}::uuid
        AND status = 'processing'
        AND payload->>${LEASE_KEY}::text = ${input.leaseOwner}
        -- Owning the claim is not enough: once the lease has expired another
        -- worker may already have recovered this effect, so the old owner must
        -- not be able to mark it done.
        AND next_attempt_at > clock_timestamp()
      RETURNING id::text AS id
    `)
  );
  return updated.length > 0;
}
