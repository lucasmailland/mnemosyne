import { inArray, sql, type SQL } from "drizzle-orm";
import type {
  ManagedSessionLifecyclePort,
  ManagedSessionClaim,
  ManagedCollapseRetry,
  ManagedLifecycleQuiesceResult,
  SessionTurn,
} from "@mnemo-ai/types";
import * as schema from "../schema/index.js";
import { mapRowToSession } from "./mappers.js";
import type { SessionRepository } from "./SessionRepository.js";
import type { DrizzleClient } from "./types.js";

type ManagedSessionTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

function rows<T>(value: unknown): T[] {
  return value as T[];
}

/**
 * The driver hands jsonb back as raw text on some read paths and as a parsed
 * object on others; stringifying an already-serialised value would store a JSON
 * *string* where the column expects an object.
 */
function acknowledgementJson(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

async function setWorkspaceContext(tx: ManagedSessionTx, workspaceId: string): Promise<void> {
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

/** One turn about to be erased, with everything a tombstone needs. */
interface ErasableTurn {
  id: string;
  session_id: string;
  source_message_id: string | null;
  content_hash: string | null;
  source_host: string;
  source_client_instance_id: string | null;
  source_session_id: string | null;
  source_generation: number | null;
  event_id: string | null;
  payload_hash: string | null;
  acknowledgement: unknown;
}

/**
 * Tombstone, audit and delete, in the caller's transaction.
 *
 * Shared by retention and by forgetting an episode precisely so the two cannot
 * drift: whichever reason erases a transcript, it leaves the same content-free
 * record and the same audit entry, differing only in who asked and why.
 */
async function erasePurgedTurns(
  tx: ManagedSessionTx,
  workspaceId: string,
  candidates: ErasableTurn[],
  audit: { actorId: string; reason: string },
  staged = false
): Promise<number> {
  if (candidates.length === 0) return 0;

  for (const turn of candidates) {
    // A turn that carries full harness identity leaves a content-free record of
    // what was erased, so a replay months later can be recognised and answered
    // without the words coming back. ON CONFLICT keeps a repeated pass idempotent.
    if (
      turn.event_id &&
      turn.source_message_id &&
      turn.source_client_instance_id &&
      turn.source_session_id
    ) {
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_harness_message_tombstone
          (workspace_id, session_id, source_host, source_client_instance_id, source_session_id,
           source_generation, event_id, source_message_id, payload_hash, content_hash, acknowledgement)
        VALUES (${workspaceId}, ${turn.session_id}, ${turn.source_host},
                ${turn.source_client_instance_id}, ${turn.source_session_id},
                ${turn.source_generation ?? 0}, ${turn.event_id}, ${turn.source_message_id},
                ${turn.payload_hash ?? ""}, ${turn.content_hash ?? ""},
                ${acknowledgementJson(turn.acknowledgement)}::jsonb)
        ON CONFLICT DO NOTHING
      `);
    }
    await tx.execute(sql`
      INSERT INTO mnemosyne.mnemo_deletion_log
        (workspace_id, deleted_item_id, deleted_item_type, deletion_type, actor_id, reason)
      VALUES (${workspaceId}::uuid, ${turn.id}::uuid, ${staged ? "harness_message_chunk" : "session_turn"}, 'hard',
              ${audit.actorId}, ${audit.reason})
    `);
  }

  let deleted = 0;
  for (const turn of candidates) {
    // Deleted by id one at a time rather than through an interpolated id list:
    // the batch is already bounded, and no identifier reaches the statement as raw text.
    deleted += rows<{ id: string }>(
      await tx.execute(
        staged
          ? sql`
        DELETE FROM mnemosyne.mnemo_harness_message_chunk
        WHERE workspace_id = ${workspaceId} AND id = ${turn.id}::uuid
        RETURNING id
      `
          : sql`
        DELETE FROM mnemosyne.mnemo_session_turn
        WHERE workspace_id = ${workspaceId}::uuid AND id = ${turn.id}::uuid
        RETURNING id
      `
      )
    ).length;
  }
  return deleted;
}

async function eraseStagedChunks(
  tx: ManagedSessionTx,
  workspaceId: string,
  sessionFilter: SQL,
  limit: number,
  audit: { actorId: string; reason: string }
): Promise<number> {
  if (limit <= 0) return 0;
  const candidates = rows<ErasableTurn>(
    await tx.execute(sql`
    SELECT chunk.id::text AS id, chunk.session_id, chunk.source_message_id,
           chunk.message_content_hash AS content_hash, session.source_host,
           session.source_client_instance_id, session.source_session_id,
           session.source_generation, event.event_id, event.payload_hash, event.acknowledgement
    FROM mnemosyne.mnemo_harness_message_chunk AS chunk
    JOIN mnemosyne.mnemo_session AS session
      ON session.workspace_id = chunk.workspace_id AND session.id = chunk.session_id
    JOIN mnemosyne.mnemo_harness_ingestion_event AS event
      ON event.workspace_id = chunk.workspace_id AND event.id = chunk.ingestion_event_id
    WHERE chunk.workspace_id = ${workspaceId} AND session.source_host IS NOT NULL
      AND ${sessionFilter}
    ORDER BY chunk.id
    LIMIT ${limit}
    FOR UPDATE OF session, chunk SKIP LOCKED
  `)
  );
  return erasePurgedTurns(tx, workspaceId, candidates, audit, true);
}

export class ManagedSessionRepository implements ManagedSessionLifecyclePort {
  constructor(
    private readonly db: DrizzleClient,
    private readonly sessions: Pick<SessionRepository, "listManagedCollapseTurns">
  ) {}

  async listManagedCollapseTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return this.sessions.listManagedCollapseTurns(sessionId, workspaceId);
  }

  async claimManagedSessions(
    input: Parameters<ManagedSessionLifecyclePort["claimManagedSessions"]>[0]
  ): Promise<ManagedSessionClaim[]> {
    if (input.limit <= 0) return [];
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const control = rows<{ ingestion_enabled: boolean }>(
        await tx.execute(sql`
          SELECT ingestion_enabled
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
          FOR UPDATE
        `)
      )[0];
      if (!control?.ingestion_enabled) return [];
      // Transaction time predates any wait on the workspace fence.
      // Keep due predicates and deadlines on one post-lock database timestamp.
      const now = rows<{ now: string }>(
        await tx.execute(sql`SELECT clock_timestamp()::text AS now`)
      )[0]!.now;

      await tx.execute(sql`
        WITH inactive AS (
          SELECT id
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId}
            AND status = 'active'
            AND source_host IS NOT NULL
            AND COALESCE(last_activity_at, started_at) <= ${now}::timestamptz - ${input.inactivityMs} * interval '1 millisecond'
          ORDER BY COALESCE(last_activity_at, started_at), id
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE mnemosyne.mnemo_session AS session
        SET status = 'collapse_pending', close_kind = 'provisional',
            close_requested_at = ${now}::timestamptz,
            close_grace_deadline = ${now}::timestamptz + ${input.provisionalGraceMs} * interval '1 millisecond',
            collapse_next_attempt_at = ${now}::timestamptz
        FROM inactive
        WHERE session.id = inactive.id
          AND session.workspace_id = ${input.workspaceId}
          AND session.status = 'active'
          AND session.source_host IS NOT NULL
      `);

      const claimed = rows<{ id: string }>(
        await tx.execute(sql`
          WITH candidates AS (
            SELECT id
            FROM mnemosyne.mnemo_session
            WHERE workspace_id = ${input.workspaceId}
              AND status = 'collapse_pending'
              AND source_host IS NOT NULL
              AND close_grace_deadline <= ${now}::timestamptz
              AND (collapse_next_attempt_at IS NULL OR collapse_next_attempt_at <= ${now}::timestamptz)
              AND (collapse_lease_owner IS NULL OR collapse_lease_expires_at <= ${now}::timestamptz)
            ORDER BY COALESCE(collapse_next_attempt_at, close_grace_deadline), id
            FOR UPDATE SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE mnemosyne.mnemo_session AS session
          SET collapse_lease_owner = ${input.leaseOwner},
              collapse_lease_expires_at = ${now}::timestamptz + ${input.leaseMs} * interval '1 millisecond'
          FROM candidates
          WHERE session.id = candidates.id
            AND session.workspace_id = ${input.workspaceId}
            AND session.status = 'collapse_pending'
            AND (session.collapse_lease_owner IS NULL OR session.collapse_lease_expires_at <= ${now}::timestamptz)
          RETURNING session.id
        `)
      );
      if (claimed.length === 0) return [];

      const claimedIds = claimed.map((row) => row.id);
      const selected = await tx
        .select()
        .from(schema.sessionTable)
        .where(inArray(schema.sessionTable.id, claimedIds));
      const byId = new Map(selected.map((row) => [row.id, mapRowToSession(row)]));
      return claimedIds.map((id) => {
        const session = byId.get(id)!;
        return {
          session,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: session.collapseLeaseExpiresAt!,
        };
      });
    });
  }

  async markManagedCollapseRetry(
    input: Parameters<ManagedSessionLifecyclePort["markManagedCollapseRetry"]>[0]
  ): Promise<ManagedCollapseRetry | null> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // Lock first: even clock_timestamp() in a locking query's predicate can
      // be evaluated before waiting. Check lease validity in the next statement.
      await tx.execute(sql`
        SELECT id FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.sessionId}
        FOR UPDATE
      `);
      const result = rows<{ collapse_attempts: number; collapse_next_attempt_at: Date }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET collapse_attempts = LEAST(
                COALESCE(collapse_attempts, 0)::bigint + 1,
                2147483647::bigint
              )::integer,
              collapse_next_attempt_at = clock_timestamp() +
                LEAST(${input.maxRetryMs}::numeric,
                      ${input.baseRetryMs}::numeric * power(2::numeric, LEAST(COALESCE(collapse_attempts, 0), 30))) * interval '1 millisecond',
              collapse_lease_owner = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('managedCollapseLastError', ${input.error}::text)
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.sessionId}
            AND status = 'collapse_pending'
            AND collapse_lease_owner = ${input.leaseOwner}
            AND collapse_lease_expires_at > clock_timestamp()
          RETURNING collapse_attempts, collapse_next_attempt_at
        `)
      )[0];
      return result
        ? {
            attempts: result.collapse_attempts,
            nextAttemptAt:
              result.collapse_next_attempt_at instanceof Date
                ? result.collapse_next_attempt_at
                : new Date(result.collapse_next_attempt_at),
          }
        : null;
    });
  }

  async finalizeManagedArchive(
    input: Parameters<ManagedSessionLifecyclePort["finalizeManagedArchive"]>[0]
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      // Lock first: even clock_timestamp() in a locking query's predicate can
      // be evaluated before waiting. Check lease validity in the next statement.
      await tx.execute(sql`
        SELECT id FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${input.workspaceId} AND id = ${input.sessionId}
        FOR UPDATE
      `);
      const current = rows<{ source_generation: number }>(
        await tx.execute(sql`
          SELECT source_generation
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.sessionId}
            AND status = 'collapse_pending'
            AND collapse_lease_owner = ${input.leaseOwner}
            AND collapse_lease_expires_at > clock_timestamp()
          FOR UPDATE
        `)
      )[0];
      if (!current) return false;

      const existingOperation = rows<{ operation_id: string }>(
        await tx.execute(sql`
          SELECT operation_id
          FROM mnemosyne.mnemo_managed_collapse_operation
          WHERE workspace_id = ${input.workspaceId}
            AND session_id = ${input.sessionId}
            AND source_generation = ${current.source_generation}
          FOR UPDATE
        `)
      )[0];
      if (existingOperation && existingOperation.operation_id !== input.operationId) return false;

      const operation = rows<{ operation_id: string }>(
        await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_managed_collapse_operation
          (operation_id, workspace_id, session_id, source_generation, status,
           lease_owner, result, committed_at)
        VALUES
          (${input.operationId}, ${input.workspaceId}, ${input.sessionId},
           ${current.source_generation}, 'committed', ${input.leaseOwner},
           jsonb_build_object('status', 'archived', 'reason', ${input.reason}::text),
            transaction_timestamp())
        ON CONFLICT (operation_id) DO UPDATE
        SET status = 'committed', lease_owner = EXCLUDED.lease_owner,
            result = EXCLUDED.result, committed_at = transaction_timestamp()
        WHERE mnemo_managed_collapse_operation.workspace_id = EXCLUDED.workspace_id
          AND mnemo_managed_collapse_operation.session_id = EXCLUDED.session_id
          AND mnemo_managed_collapse_operation.source_generation = EXCLUDED.source_generation
        RETURNING operation_id
      `)
      );
      if (operation.length !== 1) return false;
      const updated = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET status = 'archived', archive_reason = ${input.reason},
              archived_at = transaction_timestamp(), collapse_operation_id = ${input.operationId},
              collapse_lease_owner = NULL, collapse_lease_expires_at = NULL,
              collapse_next_attempt_at = NULL
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.sessionId}
            AND status = 'collapse_pending'
            AND collapse_lease_owner = ${input.leaseOwner}
            AND collapse_lease_expires_at > clock_timestamp()
          RETURNING id
        `)
      );
      if (updated.length !== 1) throw new Error("Managed archive lease was lost");

      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_managed_collapse_effect
          (workspace_id, collapse_operation_id, effect_kind, target_kind, target_id, payload)
        VALUES
          (${input.workspaceId}, ${input.operationId}, 'lifecycle_event', 'session', ${input.sessionId},
           jsonb_build_object('event', 'session.archived', 'reason', ${input.reason}::text)),
          (${input.workspaceId}, ${input.operationId}, 'metrics', 'session', ${input.sessionId},
           jsonb_build_object('status', 'archived', 'reason', ${input.reason}::text)),
          (${input.workspaceId}, ${input.operationId}, 'redis_cleanup', 'session', ${input.sessionId},
            jsonb_build_object('sessionId', ${input.sessionId}::text))
        ON CONFLICT (collapse_operation_id, effect_kind, target_kind, target_id)
        DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                      next_attempt_at = NULL, completed_at = NULL, last_error = NULL
      `);
      return true;
    });
  }

  async releaseExpiredManagedLeases(
    input: Parameters<ManagedSessionLifecyclePort["releaseExpiredManagedLeases"]>[0]
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const released = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET collapse_lease_owner = NULL
          WHERE workspace_id = ${input.workspaceId}
            AND status = 'collapse_pending'
            AND collapse_lease_owner IS NOT NULL
            AND collapse_lease_expires_at <= transaction_timestamp()
          RETURNING id
        `)
      );
      return released.length;
    });
  }

  async retryLegacyManagedArchive(
    input: Parameters<ManagedSessionLifecyclePort["retryLegacyManagedArchive"]>[0]
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const control = rows<{ ingestion_enabled: boolean }>(
        await tx.execute(sql`
          SELECT ingestion_enabled
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
          FOR UPDATE
        `)
      )[0];
      if (!control?.ingestion_enabled) return false;
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_managed_collapse_operation AS operation
        SET status = 'prepared', result = NULL, committed_at = NULL
        FROM mnemosyne.mnemo_session AS session
        WHERE session.workspace_id = ${input.workspaceId}
          AND session.id = ${input.sessionId}
          AND session.status = 'archived'
          AND session.source_host IS NOT NULL
          AND session.archive_reason IN ('too_few_turns', 'low_recurrence_signal', 'no_pin')
          AND operation.workspace_id = session.workspace_id
          AND operation.session_id = session.id
          AND operation.operation_id = session.collapse_operation_id
      `);
      const retried = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET status = 'collapse_pending', close_kind = 'authoritative',
              close_requested_at = clock_timestamp(),
              close_grace_deadline = clock_timestamp(),
              collapse_next_attempt_at = clock_timestamp(),
              collapse_lease_owner = NULL, collapse_lease_expires_at = NULL,
              archive_reason = NULL, archived_at = NULL
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${input.sessionId}
            AND status = 'archived'
            AND source_host IS NOT NULL
            AND archive_reason IN ('too_few_turns', 'low_recurrence_signal', 'no_pin')
          RETURNING id
        `)
      );
      return retried.length === 1;
    });
  }

  async quiesceManagedLifecycle(
    input: Parameters<ManagedSessionLifecyclePort["quiesceManagedLifecycle"]>[0]
  ): Promise<ManagedLifecycleQuiesceResult> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const control = rows<{ ingestion_enabled: boolean }>(
        await tx.execute(sql`
          SELECT ingestion_enabled
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
          FOR UPDATE
        `)
      )[0];
      if (!control || control.ingestion_enabled) {
        const error = new Error(
          "Harness ingestion must be disabled before lifecycle quiesce"
        ) as Error & {
          code?: string;
        };
        error.code = "INGESTION_ENABLED";
        throw error;
      }
      // Transaction time predates any wait on the workspace fence.
      // Keep due predicates and deadlines on one post-lock database timestamp.
      const now = rows<{ now: string }>(
        await tx.execute(sql`SELECT clock_timestamp()::text AS now`)
      )[0]!.now;

      const reactivated = rows<{ id: string }>(
        await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET status = 'active', close_kind = NULL, close_requested_at = NULL,
              close_grace_deadline = NULL, collapse_next_attempt_at = NULL,
              collapse_lease_owner = NULL, collapse_lease_expires_at = NULL
          WHERE workspace_id = ${input.workspaceId}
            AND status = 'collapse_pending'
            AND source_host IS NOT NULL
            AND (
              collapse_lease_owner IS NULL
              OR collapse_lease_expires_at <= ${now}::timestamptz
            )
          RETURNING id
        `)
      );
      const counts = rows<{ pending_count: number | string; live_lease_count: number | string }>(
        await tx.execute(sql`
          SELECT COUNT(*)::int AS pending_count,
                 COUNT(*) FILTER (
                   WHERE collapse_lease_owner IS NOT NULL
                     AND collapse_lease_expires_at > ${now}::timestamptz
                 )::int AS live_lease_count
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId}
            AND source_host IS NOT NULL
            AND status = 'collapse_pending'
        `)
      )[0]!;
      return {
        pendingCount: Number(counts.pending_count),
        liveLeaseCount: Number(counts.live_lease_count),
        reactivatedCount: reactivated.length,
      };
    });
  }

  /**
   * Delete managed raw transcripts whose session went terminal before the cutoff.
   *
   * Everything happens in one transaction, so a tombstone can never exist without
   * its turn being gone, nor a turn vanish unaudited. The cutoff is strictly
   * exclusive and measured on the session's terminal time
   * (COALESCE(collapsed_at, archived_at)) rather than the turn's age: a long
   * conversation's first turn is not older data than its last, and retention is
   * owed from when the conversation ended.
   *
   * Legacy sessions have no source_host and are never touched — this window
   * governs host-captured transcripts only.
   */
  /**
   * One pass over managed sessions for the metrics scrape.
   *
   * Cross-workspace by design — this feeds instance-level gauges — so it reads
   * without a workspace GUC, like the other snapshot aggregates. Every grouping
   * is bucketed or enumerated in SQL so no identifier can reach a label.
   */
  /**
   * Erase the managed transcript behind an episode.
   *
   * Forgetting the knowledge a session produced must not leave the words that
   * produced it sitting in the database — otherwise "forgotten" means only that
   * the summary is gone while the raw conversation stays replayable.
   *
   * Retention-window independent by design: this is an explicit request, not a
   * schedule. It leaves exactly the tombstone and audit entry retention leaves,
   * attributed to the caller rather than to the retention system.
   */
  async forgetManagedTranscriptForEpisode(input: {
    workspaceId: string;
    episodeId: string;
    actorId: string;
  }): Promise<{ sessionId: string | null; turnsRemoved: number }> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);

      // The episode names its session through source_conversation_id, which is what
      // a managed collapse writes. Resolved here rather than in the route so no
      // caller has to know the linkage.
      const episode = rows<{ source_conversation_id: string | null }>(
        await tx.execute(sql`
          SELECT source_conversation_id
          FROM mnemosyne.mnemo_episode
          WHERE workspace_id = ${input.workspaceId} AND id = ${input.episodeId}
        `)
      )[0];
      const sessionId = episode?.source_conversation_id ?? null;
      if (!sessionId) return { sessionId: null, turnsRemoved: 0 };
      // Ingestion locks its session before staging, so erasure shares that fence.
      await tx.execute(sql`SELECT id FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${input.workspaceId} AND id = ${sessionId} FOR UPDATE`);

      const candidates = rows<ErasableTurn>(
        await tx.execute(sql`
          SELECT turn.id::text AS id, turn.session_id, turn.source_message_id, turn.content_hash,
                 session.source_host, session.source_client_instance_id, session.source_session_id,
                 session.source_generation,
                 event.event_id, event.payload_hash, event.acknowledgement
          FROM mnemosyne.mnemo_session_turn AS turn
          JOIN mnemosyne.mnemo_session AS session
            ON session.workspace_id = turn.workspace_id::text
           AND session.id = turn.session_id
          LEFT JOIN mnemosyne.mnemo_harness_ingestion_event AS event
            ON event.id = turn.ingestion_event_id
          WHERE turn.workspace_id = ${input.workspaceId}::uuid
            AND session.workspace_id = ${input.workspaceId}
            AND session.source_host IS NOT NULL
            AND turn.session_id = ${sessionId}
          ORDER BY turn.id
          FOR UPDATE OF turn
        `)
      );
      const turnsRemoved = await erasePurgedTurns(tx, input.workspaceId, candidates, {
        actorId: input.actorId,
        reason: "managed transcript forgotten with its episode",
      });
      const chunksRemoved = await eraseStagedChunks(
        tx,
        input.workspaceId,
        sql`session.id = ${sessionId}`,
        2147483647,
        {
          actorId: input.actorId,
          reason: "managed transcript forgotten with its episode",
        }
      );
      return { sessionId, turnsRemoved: turnsRemoved + chunksRemoved };
    });
  }

  /** Managed session metadata for a workspace export. Never includes content. */
  async exportManagedSessions(input: { workspaceId: string; limit: number }): Promise<
    Array<{
      sessionId: string;
      sourceHost: string;
      status: string;
      turnCount: number;
      startedAt: string | null;
      collapsedAt: string | null;
      archivedAt: string | null;
      archiveReason: string | null;
      captureIncomplete: boolean;
    }>
  > {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      return rows<{
        session_id: string;
        source_host: string;
        status: string;
        turn_count: number;
        started_at: string | null;
        collapsed_at: string | null;
        archived_at: string | null;
        archive_reason: string | null;
        capture_incomplete: boolean;
      }>(
        await tx.execute(sql`
          SELECT id AS session_id, source_host, status, COALESCE(turn_count, 0) AS turn_count,
                 started_at::text, collapsed_at::text, archived_at::text,
                 archive_reason, COALESCE(capture_incomplete, false) AS capture_incomplete
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId} AND source_host IS NOT NULL
          ORDER BY id
          LIMIT ${input.limit}
        `)
      ).map((row) => ({
        sessionId: row.session_id,
        sourceHost: row.source_host,
        status: row.status,
        turnCount: Number(row.turn_count),
        startedAt: row.started_at,
        collapsedAt: row.collapsed_at,
        archivedAt: row.archived_at,
        archiveReason: row.archive_reason,
        captureIncomplete: row.capture_incomplete,
      }));
    });
  }

  /**
   * Raw managed transcripts still held for this workspace.
   *
   * Only what actually survives: a turn retention already erased is simply not
   * there, so an export can never hand back a conversation the workspace has
   * been told was deleted.
   */
  async exportManagedTranscripts(input: { workspaceId: string; limit: number }): Promise<
    Array<{
      sessionId: string;
      turnIndex: number;
      role: string;
      content: string;
      sourceMessageId: string | null;
      createdAt: string | null;
    }>
  > {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      return rows<{
        session_id: string;
        turn_index: number;
        role: string;
        content: string;
        source_message_id: string | null;
        created_at: string | null;
      }>(
        await tx.execute(sql`
          SELECT turn.session_id, turn.turn_index, turn.role, turn.content,
                 turn.source_message_id, turn.created_at::text
          FROM mnemosyne.mnemo_session_turn AS turn
          JOIN mnemosyne.mnemo_session AS session
            ON session.workspace_id = turn.workspace_id::text
           AND session.id = turn.session_id
          WHERE turn.workspace_id = ${input.workspaceId}::uuid
            AND session.workspace_id = ${input.workspaceId}
            AND session.source_host IS NOT NULL
          ORDER BY turn.session_id, turn.turn_index
          LIMIT ${input.limit}
        `)
      ).map((row) => ({
        sessionId: row.session_id,
        turnIndex: Number(row.turn_index),
        role: row.role,
        content: row.content,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
      }));
    });
  }

  async managedLifecycleStats(): Promise<{
    active: number;
    pending: number;
    collapsed: number;
    archivedByReason: Array<{ reason: string; count: number }>;
    retryBuckets: Array<{ bucket: string; count: number }>;
    oldestPendingAgeSeconds: number | null;
    messageCountBuckets: Array<{ bucket: string; count: number }>;
    extraction: Array<{ result: string; count: number }>;
    incompleteCapture: number;
  }> {
    const totals = rows<{
      active: number;
      pending: number;
      collapsed: number;
      incomplete: number;
      oldest_pending_age: number | null;
    }>(
      await this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'collapse_pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'collapsed')::int AS collapsed,
          COUNT(*) FILTER (WHERE capture_incomplete)::int AS incomplete,
          EXTRACT(EPOCH FROM (
            clock_timestamp() - MIN(COALESCE(close_requested_at, last_activity_at, started_at))
              FILTER (WHERE status = 'collapse_pending')
          ))::int AS oldest_pending_age
        FROM mnemosyne.mnemo_session
        WHERE source_host IS NOT NULL
      `)
    )[0]!;

    const archivedByReason = rows<{ reason: string; count: number }>(
      await this.db.execute(sql`
        SELECT COALESCE(archive_reason, 'other') AS reason, COUNT(*)::int AS count
        FROM mnemosyne.mnemo_session
        WHERE source_host IS NOT NULL AND status = 'archived'
        GROUP BY 1
      `)
    );

    // Bucketed, not raw: attempt counts are unbounded, label values must not be.
    const retryBuckets = rows<{ bucket: string; count: number }>(
      await this.db.execute(sql`
        SELECT CASE
                 WHEN collapse_attempts = 0 THEN '0'
                 WHEN collapse_attempts = 1 THEN '1'
                 WHEN collapse_attempts <= 5 THEN '5'
                 WHEN collapse_attempts <= 20 THEN '20'
                 ELSE 'many'
               END AS bucket,
               COUNT(*)::int AS count
        FROM mnemosyne.mnemo_session
        WHERE source_host IS NOT NULL
        GROUP BY 1
      `)
    );

    const messageCountBuckets = rows<{ bucket: string; count: number }>(
      await this.db.execute(sql`
        SELECT CASE
                 WHEN turn_count <= 2 THEN '2'
                 WHEN turn_count <= 10 THEN '10'
                 WHEN turn_count <= 50 THEN '50'
                 WHEN turn_count <= 200 THEN '200'
                 ELSE 'inf'
               END AS bucket,
               COUNT(*)::int AS count
        FROM mnemosyne.mnemo_session
        WHERE source_host IS NOT NULL
        GROUP BY 1
      `)
    );

    // A terminal session that never attempted collapse is not a failed
    // extraction; it is excluded from the success rate rather than counted against it.
    const extraction = rows<{ result: string; count: number }>(
      await this.db.execute(sql`
        SELECT CASE
                 WHEN status = 'collapsed' THEN 'succeeded'
                 WHEN collapse_attempts > 0 THEN 'failed'
                 ELSE 'not_attempted'
               END AS result,
               COUNT(*)::int AS count
        FROM mnemosyne.mnemo_session
        WHERE source_host IS NOT NULL AND status IN ('collapsed', 'archived')
        GROUP BY 1
      `)
    );

    return {
      active: totals.active,
      pending: totals.pending,
      collapsed: totals.collapsed,
      archivedByReason,
      retryBuckets,
      oldestPendingAgeSeconds: totals.oldest_pending_age ?? null,
      messageCountBuckets,
      extraction,
      incompleteCapture: totals.incomplete,
    };
  }

  async purgeManagedTurns(
    input: Parameters<ManagedSessionLifecyclePort["purgeManagedTurns"]>[0]
  ): Promise<number> {
    if (input.limit <= 0) return 0;
    const terminalBefore = input.terminalBefore.toISOString();
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);

      const candidates = rows<{
        id: string;
        session_id: string;
        source_message_id: string | null;
        content_hash: string | null;
        source_host: string;
        source_client_instance_id: string | null;
        source_session_id: string | null;
        source_generation: number | null;
        event_id: string | null;
        payload_hash: string | null;
        acknowledgement: unknown;
      }>(
        await tx.execute(sql`
          SELECT turn.id::text AS id, turn.session_id, turn.source_message_id, turn.content_hash,
                 session.source_host, session.source_client_instance_id, session.source_session_id,
                 session.source_generation,
                 event.event_id, event.payload_hash, event.acknowledgement
          FROM mnemosyne.mnemo_session_turn AS turn
          JOIN mnemosyne.mnemo_session AS session
            ON session.workspace_id = turn.workspace_id::text
           AND session.id = turn.session_id
          LEFT JOIN mnemosyne.mnemo_harness_ingestion_event AS event
            ON event.id = turn.ingestion_event_id
          WHERE turn.workspace_id = ${input.workspaceId}::uuid
            AND session.workspace_id = ${input.workspaceId}
            AND session.source_host IS NOT NULL
            AND session.status IN ('collapsed', 'archived')
            AND COALESCE(session.collapsed_at, session.archived_at) < ${terminalBefore}::timestamptz
          ORDER BY turn.id
          LIMIT ${input.limit}
          FOR UPDATE OF turn SKIP LOCKED
        `)
      );
      const removed = await erasePurgedTurns(tx, input.workspaceId, candidates, {
        actorId: "system:managed-retention",
        reason: "managed transcript retention window elapsed",
      });
      return (
        removed +
        (await eraseStagedChunks(
          tx,
          input.workspaceId,
          sql`
        session.status IN ('collapsed', 'archived')
        AND COALESCE(session.collapsed_at, session.archived_at) < ${terminalBefore}::timestamptz
      `,
          input.limit - removed,
          {
            actorId: "system:managed-retention",
            reason: "managed transcript retention window elapsed",
          }
        ))
      );
    });
  }
}
