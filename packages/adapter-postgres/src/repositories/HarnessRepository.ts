import { sql } from "drizzle-orm";
import {
  computeTerminalDigestV1,
  HARNESS_CLOSE_GRACE_MS,
  HARNESS_MAX_GENERATION,
  SENSITIVITY_ORDER,
  sha256Hex,
  validateHarnessEventSemantics,
  type HarnessEvent,
  type HarnessEventAck,
  type HarnessIngestionPort,
  type ManagedSessionProvenance,
} from "@mnemo-ai/types";
import type { DrizzleClient } from "./types.js";

type HarnessTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

interface SessionRow {
  id: string;
  source_generation: number;
  status: "active" | "collapse_pending" | "collapsed" | "archived";
  close_kind: "authoritative" | "provisional" | null;
  collapse_lease_owner: string | null;
  collapse_lease_expires_at: Date | null;
  sensitivity: "public" | "internal";
  origin_actor_id: string;
  origin_actor_type: string;
  origin_user_id: string | null;
  origin_sensitivity_ceiling: string;
  terminal_max_enqueue_sequence: number | null;
  terminal_message_set_digest: string | null;
  close_grace_deadline: Date | null;
}

type RawSessionRow = Omit<
  SessionRow,
  "terminal_max_enqueue_sequence" | "close_grace_deadline" | "collapse_lease_expires_at"
> & {
  terminal_max_enqueue_sequence: number | string | null;
  close_grace_deadline: Date | string | null;
  collapse_lease_expires_at: Date | string | null;
};

interface LedgerRow {
  id: string;
  event_id: string;
  source_host: string;
  source_client_instance_id: string;
  source_session_id: string;
  source_generation: number | null;
  enqueue_sequence: number | string;
  payload_hash: string;
  ledger_state: "retryable" | "accepted" | "rejected" | "cancelled";
  acknowledgement: HarnessEventAck | null;
  session_id: string | null;
  origin_actor_id: string;
  origin_actor_type: string;
  origin_user_id: string | null;
  origin_sensitivity_ceiling: string;
}

interface TurnRow {
  session_id: string;
  source_generation: number;
  source_message_id: string;
  role: "user" | "assistant";
  content_hash: string;
  retracted_at: Date | null;
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

function normalizeSessionRow(row: RawSessionRow): SessionRow {
  const closeGraceDeadline =
    row.close_grace_deadline === null
      ? null
      : row.close_grace_deadline instanceof Date
        ? row.close_grace_deadline
        : new Date(row.close_grace_deadline);
  if (closeGraceDeadline !== null && Number.isNaN(closeGraceDeadline.getTime())) {
    throw new Error("close_grace_deadline is not a valid timestamp");
  }
  const collapseLeaseExpiresAt =
    row.collapse_lease_expires_at === null
      ? null
      : row.collapse_lease_expires_at instanceof Date
        ? row.collapse_lease_expires_at
        : new Date(row.collapse_lease_expires_at);
  if (collapseLeaseExpiresAt !== null && Number.isNaN(collapseLeaseExpiresAt.getTime())) {
    throw new Error("collapse_lease_expires_at is not a valid timestamp");
  }
  if (row.terminal_max_enqueue_sequence === null) {
    return {
      ...row,
      terminal_max_enqueue_sequence: null,
      close_grace_deadline: closeGraceDeadline,
      collapse_lease_expires_at: collapseLeaseExpiresAt,
    };
  }
  const terminalMaxEnqueueSequence = Number(row.terminal_max_enqueue_sequence);
  if (!Number.isSafeInteger(terminalMaxEnqueueSequence)) {
    throw new Error("terminal_max_enqueue_sequence exceeds the JavaScript safe integer range");
  }
  return {
    ...row,
    terminal_max_enqueue_sequence: terminalMaxEnqueueSequence,
    close_grace_deadline: closeGraceDeadline,
    collapse_lease_expires_at: collapseLeaseExpiresAt,
  };
}

async function setWorkspaceContext(tx: HarnessTx, workspaceId: string): Promise<void> {
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

function reject(eventId: string, code: string, retryable: boolean): HarnessEventAck {
  return { eventId, status: "rejected", retryable, code };
}

function duplicate(acknowledgement: HarnessEventAck): HarnessEventAck {
  return { ...acknowledgement };
}

export class HarnessRepository implements HarnessIngestionPort {
  private readonly sourceQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly closeGraceMs = HARNESS_CLOSE_GRACE_MS
  ) {}

  private async serialSource<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sourceQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.sourceQueues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sourceQueues.get(key) === queued) this.sourceQueues.delete(key);
    }
  }

  async ingestHarnessEvent(
    input: Parameters<HarnessIngestionPort["ingestHarnessEvent"]>[0]
  ): Promise<HarnessEventAck> {
    const semanticError = validateHarnessEventSemantics(input.event, input.receivedAt);
    if (semanticError) return reject(input.event.eventId, semanticError, false);
    const provenance = { ...input.provenance };
    const receivedAtIso = input.receivedAt.toISOString();
    const sourceKey = JSON.stringify([
      input.workspaceId,
      input.event.host,
      input.event.clientInstanceId,
      input.event.hostSessionId,
    ]);

    return this.serialSource(sourceKey, () =>
      this.db.transaction(async (tx) => {
        await setWorkspaceContext(tx, input.workspaceId);
        const control = rows<{ ingestion_enabled: boolean }>(
          await tx.execute(sql`
          SELECT ingestion_enabled
          FROM mnemosyne.mnemo_harness_workspace_control
          WHERE workspace_id = ${input.workspaceId}
          FOR UPDATE
        `)
        )[0];
        if (!control?.ingestion_enabled) {
          return reject(input.event.eventId, "ingestion_disabled", true);
        }

        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey}, 0))`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.event.eventId}`}, 0))`
        );

        const existingLedger = rows<LedgerRow>(
          await tx.execute(sql`
          SELECT id, event_id, source_generation, enqueue_sequence, payload_hash,
                 ledger_state, acknowledgement, session_id, origin_actor_id,
                 origin_actor_type, origin_user_id, origin_sensitivity_ceiling
          FROM mnemosyne.mnemo_harness_ingestion_event
          WHERE workspace_id = ${input.workspaceId} AND event_id = ${input.event.eventId}
          FOR UPDATE
        `)
        )[0];
        if (existingLedger) {
          if (
            existingLedger.origin_actor_id !== provenance.actorId ||
            existingLedger.origin_actor_type !== provenance.actorType ||
            existingLedger.origin_user_id !== provenance.userId ||
            existingLedger.origin_sensitivity_ceiling !== provenance.sensitivityCeiling
          ) {
            return reject(input.event.eventId, "event_binding_mismatch", false);
          }
          if (existingLedger.payload_hash !== input.event.payloadHash) {
            return reject(input.event.eventId, "payload_hash_mismatch", false);
          }
          if (existingLedger.ledger_state !== "retryable") {
            return duplicate(existingLedger.acknowledgement!);
          }
        }

        const sequenceOwner = rows<{ event_id: string }>(
          await tx.execute(sql`
          SELECT event_id FROM mnemosyne.mnemo_harness_ingestion_event
          WHERE workspace_id = ${input.workspaceId}
            AND source_host = ${input.event.host}
            AND source_client_instance_id = ${input.event.clientInstanceId}
            AND source_session_id = ${input.event.hostSessionId}
            AND enqueue_sequence = ${input.event.enqueueSequence}
          FOR UPDATE
        `)
        )[0];
        if (sequenceOwner && sequenceOwner.event_id !== input.event.eventId) {
          return reject(input.event.eventId, "source_sequence_conflict", false);
        }

        const sessions = rows<RawSessionRow>(
          await tx.execute(sql`
          SELECT id, source_generation, status, close_kind, collapse_lease_owner,
                 collapse_lease_expires_at,
                 sensitivity, origin_actor_id, origin_actor_type, origin_user_id,
                 origin_sensitivity_ceiling, terminal_max_enqueue_sequence,
                 terminal_message_set_digest, close_grace_deadline
          FROM mnemosyne.mnemo_session
          WHERE workspace_id = ${input.workspaceId}
            AND source_host = ${input.event.host}
            AND source_client_instance_id = ${input.event.clientInstanceId}
            AND source_session_id = ${input.event.hostSessionId}
          ORDER BY source_generation
          FOR UPDATE
        `)
        ).map(normalizeSessionRow);
        const permanentConflict = async (code: string): Promise<HarnessEventAck> => {
          const acknowledgement = reject(input.event.eventId, code, false);
          if (existingLedger) {
            await tx.execute(sql`
            UPDATE mnemosyne.mnemo_harness_ingestion_event
            SET ledger_state = 'rejected', acknowledgement = ${JSON.stringify(acknowledgement)}::jsonb,
                retry_code = NULL, finalized_at = ${receivedAtIso}::timestamptz
            WHERE workspace_id = ${input.workspaceId} AND id = ${existingLedger.id}
              AND ledger_state = 'retryable'
          `);
          }
          return acknowledgement;
        };

        const knownTurn =
          input.event.type === "turn.append" || input.event.type === "sequence.loss"
            ? rows<TurnRow>(
                await tx.execute(sql`
                SELECT t.session_id, s.source_generation, t.source_message_id,
                       t.role, t.content_hash, t.retracted_at
                FROM mnemosyne.mnemo_session_turn t
                JOIN mnemosyne.mnemo_session s
                  ON s.workspace_id = t.ingestion_event_workspace_id
                 AND s.id = t.session_id
                WHERE s.workspace_id = ${input.workspaceId}
                  AND s.source_host = ${input.event.host}
                  AND s.source_client_instance_id = ${input.event.clientInstanceId}
                  AND s.source_session_id = ${input.event.hostSessionId}
                  AND t.source_message_id = ${
                    input.event.type === "turn.append"
                      ? input.event.hostMessageId
                      : input.event.lostHostMessageId
                  }
                LIMIT 1
                FOR UPDATE OF t
              `)
              )[0]
            : undefined;
        const supersededTurn =
          input.event.type === "turn.append" && input.event.supersedesSourceMessageId
            ? rows<TurnRow>(
                await tx.execute(sql`
                SELECT t.session_id, s.source_generation, t.source_message_id,
                       t.role, t.content_hash, t.retracted_at
                FROM mnemosyne.mnemo_session_turn t
                JOIN mnemosyne.mnemo_session s
                  ON s.workspace_id = t.ingestion_event_workspace_id AND s.id = t.session_id
                WHERE s.workspace_id = ${input.workspaceId}
                  AND s.source_host = ${input.event.host}
                  AND s.source_client_instance_id = ${input.event.clientInstanceId}
                  AND s.source_session_id = ${input.event.hostSessionId}
                  AND t.source_message_id = ${input.event.supersedesSourceMessageId}
                LIMIT 1 FOR UPDATE OF t
              `)
              )[0]
            : undefined;
        const knownLoss =
          input.event.type === "turn.append" || input.event.type === "sequence.loss"
            ? rows<{ id: string }>(
                await tx.execute(sql`
                SELECT l.id FROM mnemosyne.mnemo_harness_loss l
                JOIN mnemosyne.mnemo_session s
                  ON s.workspace_id = l.workspace_id AND s.id = l.session_id
                WHERE l.workspace_id = ${input.workspaceId}
                  AND s.source_host = ${input.event.host}
                  AND s.source_client_instance_id = ${input.event.clientInstanceId}
                  AND s.source_session_id = ${input.event.hostSessionId}
                  AND l.lost_source_message_id = ${
                    input.event.type === "turn.append"
                      ? input.event.hostMessageId
                      : input.event.lostHostMessageId
                  }
                LIMIT 1
              `)
              )[0]
            : undefined;
        if (input.event.type === "turn.append" && knownTurn?.role !== undefined) {
          if (knownTurn.role !== input.event.role) {
            return permanentConflict("source_message_identity_mismatch");
          }
          const expectedContentHash = input.event.chunk
            ? input.event.chunk.messageContentHash
            : input.event.contentHash;
          if (knownTurn.content_hash !== expectedContentHash) {
            return permanentConflict("content_hash_mismatch");
          }
        }
        if (input.event.type === "turn.append" && knownLoss) {
          return permanentConflict("loss_identity_conflict");
        }
        if (
          input.event.type === "turn.append" &&
          input.event.supersedesSourceMessageId &&
          (!supersededTurn ||
            supersededTurn.source_message_id === input.event.hostMessageId ||
            supersededTurn.retracted_at !== null ||
            supersededTurn.role !== input.event.role)
        ) {
          return permanentConflict("missing_superseded_source_message");
        }
        if (
          input.event.type === "sequence.loss" &&
          knownTurn &&
          (knownTurn.role !== input.event.lostRole ||
            knownTurn.content_hash !== input.event.lostContentHash)
        ) {
          return permanentConflict("loss_identity_mismatch");
        }
        if (
          input.event.type === "sequence.loss" &&
          (knownLoss || (knownTurn && input.event.lostEventType === "turn.append"))
        ) {
          return permanentConflict("loss_identity_conflict");
        }

        const sourceGeneration =
          input.event.type === "session.start" ? null : input.event.sourceGeneration;
        let ledger = existingLedger;
        if (!ledger) {
          ledger = rows<LedgerRow>(
            await tx.execute(sql`
            INSERT INTO mnemosyne.mnemo_harness_ingestion_event
              (workspace_id, event_id, source_host, source_client_instance_id,
               source_session_id, source_generation, enqueue_sequence, event_type,
               payload_hash, normalization_version, occurred_at, received_at,
               origin_actor_id, origin_actor_type, origin_user_id,
               origin_sensitivity_ceiling, ledger_state, acknowledgement)
            VALUES
              (${input.workspaceId}, ${input.event.eventId}, ${input.event.host},
               ${input.event.clientInstanceId}, ${input.event.hostSessionId},
               ${sourceGeneration}, ${input.event.enqueueSequence}, ${input.event.type},
                ${input.event.payloadHash}, ${input.event.normalizationVersion},
                 ${input.event.occurredAt}, ${receivedAtIso}, ${provenance.actorId},
                 ${provenance.actorType}, ${provenance.userId},
                 ${provenance.sensitivityCeiling}, 'retryable',
                ${JSON.stringify(reject(input.event.eventId, "pending", true))}::jsonb)
            RETURNING id, event_id, source_generation, enqueue_sequence, payload_hash,
                       ledger_state, acknowledgement, session_id, origin_actor_id,
                       origin_actor_type, origin_user_id, origin_sensitivity_ceiling
          `)
          )[0]!;
        }

        const storeAck = async (
          acknowledgement: HarnessEventAck,
          state: LedgerRow["ledger_state"] = acknowledgement.status === "accepted"
            ? "accepted"
            : "rejected",
          sessionId?: string
        ): Promise<HarnessEventAck> => {
          await tx.execute(sql`
          UPDATE mnemosyne.mnemo_harness_ingestion_event
          SET ledger_state = ${state},
              acknowledgement = ${JSON.stringify(acknowledgement)}::jsonb,
              session_id = COALESCE(${sessionId ?? null}, session_id),
              retry_code = ${acknowledgement.retryable ? (acknowledgement.code ?? null) : null},
              finalized_at = CASE
                WHEN ${state} = 'retryable' THEN NULL
                ELSE ${receivedAtIso}::timestamptz
              END
          WHERE workspace_id = ${input.workspaceId} AND id = ${ledger!.id}
        `);
          return acknowledgement;
        };

        const sequenceBlockCode = async (
          enqueueSequence = input.event.enqueueSequence,
          exemptEventId?: string
        ): Promise<"lower_sequence_pending" | "source_sequence_gap" | null> => {
          const sourceRows = rows<{
            event_id: string;
            enqueue_sequence: number | string;
            ledger_state: string;
          }>(
            await tx.execute(sql`
            SELECT event_id, enqueue_sequence, ledger_state
            FROM mnemosyne.mnemo_harness_ingestion_event
            WHERE workspace_id = ${input.workspaceId}
              AND source_host = ${input.event.host}
              AND source_client_instance_id = ${input.event.clientInstanceId}
              AND source_session_id = ${input.event.hostSessionId}
              AND event_id <> ${input.event.eventId}
            ORDER BY enqueue_sequence
          `)
          );
          let next = 1;
          for (const row of sourceRows) {
            const sequence = Number(row.enqueue_sequence);
            if (sequence < next) continue;
            if (sequence !== next) break;
            if (row.ledger_state === "retryable" && row.event_id !== exemptEventId) break;
            next += 1;
          }
          if (enqueueSequence === next) return null;
          const blocker = sourceRows.find(
            (row) =>
              Number(row.enqueue_sequence) === next &&
              row.ledger_state === "retryable" &&
              row.event_id !== exemptEventId
          );
          return blocker ? "lower_sequence_pending" : "source_sequence_gap";
        };

        const createSession = async (
          generation: number,
          predecessor: SessionRow | undefined,
          sensitivity: "public" | "internal",
          sessionProvenance: ManagedSessionProvenance = provenance
        ): Promise<SessionRow> => {
          const id = crypto.randomUUID();
          return normalizeSessionRow(
            rows<RawSessionRow>(
              await tx.execute(sql`
            INSERT INTO mnemosyne.mnemo_session
              (id, workspace_id, status, metadata, source_host, source_session_id,
               source_client_instance_id, source_generation, predecessor_session_id,
               last_activity_at, sensitivity, origin_actor_id, origin_actor_type,
               origin_user_id, origin_sensitivity_ceiling, capture_incomplete,
               capture_incomplete_reasons, traffic_origin)
            VALUES
              (${id}, ${input.workspaceId}, 'active',
               ${JSON.stringify(input.event.type === "session.start" ? (input.event.metadata ?? {}) : {})}::jsonb,
               ${input.event.host}, ${input.event.hostSessionId},
               ${input.event.clientInstanceId}, ${generation}, ${predecessor?.id ?? null},
                ${receivedAtIso}, ${sensitivity}, ${sessionProvenance.actorId},
                ${sessionProvenance.actorType}, ${sessionProvenance.userId},
                ${sessionProvenance.sensitivityCeiling},
               false, '[]'::jsonb, ${sessionProvenance.trafficOrigin ?? "unknown"})
             RETURNING id, source_generation, status, close_kind, collapse_lease_owner,
                       collapse_lease_expires_at,
                       sensitivity, origin_actor_id, origin_actor_type, origin_user_id,
                       origin_sensitivity_ceiling, terminal_max_enqueue_sequence,
                       terminal_message_set_digest, close_grace_deadline
          `)
            )[0]!
          );
        };

        const ensureSuccessor = async (previous: SessionRow): Promise<SessionRow | null> => {
          const existing = sessions.find(
            (candidate) => candidate.source_generation === previous.source_generation + 1
          );
          if (existing) return existing;
          if (previous.source_generation === HARNESS_MAX_GENERATION) return null;
          const created = await createSession(
            previous.source_generation + 1,
            previous,
            previous.sensitivity,
            {
              actorId: previous.origin_actor_id as ManagedSessionProvenance["actorId"],
              actorType: previous.origin_actor_type as ManagedSessionProvenance["actorType"],
              userId: previous.origin_user_id,
              sensitivityCeiling:
                previous.origin_sensitivity_ceiling as ManagedSessionProvenance["sensitivityCeiling"],
            }
          );
          sessions.push(created);
          return created;
        };

        const acceptsMutation = (candidate: SessionRow, enqueueSequence: number): boolean => {
          if (candidate.status === "active") return true;
          if (
            candidate.status !== "collapse_pending" ||
            candidate.collapse_lease_owner ||
            candidate.collapse_lease_expires_at
          ) {
            return false;
          }
          if (candidate.close_kind === "provisional") return true;
          return (
            candidate.close_kind === "authoritative" &&
            candidate.close_grace_deadline !== null &&
            input.receivedAt <= candidate.close_grace_deadline &&
            candidate.terminal_max_enqueue_sequence !== null &&
            enqueueSequence <= candidate.terminal_max_enqueue_sequence
          );
        };

        if (input.event.type === "session.start") {
          const sequenceCode = await sequenceBlockCode();
          if (sequenceCode) {
            return storeAck(reject(input.event.eventId, sequenceCode, true), "retryable");
          }
          const sensitivity = input.event.sensitivity ?? "internal";
          if (SENSITIVITY_ORDER[sensitivity] > SENSITIVITY_ORDER[provenance.sensitivityCeiling]) {
            return storeAck(reject(input.event.eventId, "sensitivity_ceiling_exceeded", false));
          }
          const latest = sessions.at(-1);
          if (
            latest &&
            (latest.sensitivity !== sensitivity ||
              latest.origin_actor_id !== provenance.actorId ||
              latest.origin_actor_type !== provenance.actorType ||
              latest.origin_user_id !== provenance.userId ||
              latest.origin_sensitivity_ceiling !== provenance.sensitivityCeiling)
          ) {
            return storeAck(reject(input.event.eventId, "session_binding_mismatch", false));
          }
          let session: SessionRow;
          if (!latest) {
            session = await createSession(0, undefined, sensitivity);
          } else if (
            input.event.requestedGeneration === latest.source_generation + 1 &&
            !acceptsMutation(latest, input.event.enqueueSequence)
          ) {
            const successor = await ensureSuccessor(latest);
            if (!successor) {
              return storeAck(reject(input.event.eventId, "generation_exhausted", false));
            }
            session = successor;
          } else {
            session = latest;
          }
          return storeAck(
            {
              eventId: input.event.eventId,
              status: "accepted",
              retryable: false,
              sessionId: session.id,
              effectiveGeneration: session.source_generation,
            },
            "accepted",
            session.id
          );
        }

        if (input.event.type === "event.cancel") {
          const target = rows<LedgerRow>(
            await tx.execute(sql`
              SELECT id, event_id, source_host, source_client_instance_id, source_session_id,
                     source_generation, enqueue_sequence, payload_hash, ledger_state,
                     acknowledgement, session_id, origin_actor_id, origin_actor_type,
                     origin_user_id, origin_sensitivity_ceiling
              FROM mnemosyne.mnemo_harness_ingestion_event
              WHERE workspace_id = ${input.workspaceId}
                AND event_id = ${input.event.targetEventId}
              FOR UPDATE
            `)
          )[0];
          if (!target) {
            return storeAck(
              reject(input.event.eventId, "cancel_target_not_retryable", true),
              "retryable"
            );
          }
          if (
            target.source_host !== input.event.host ||
            target.source_client_instance_id !== input.event.clientInstanceId ||
            target.source_session_id !== input.event.hostSessionId ||
            target.origin_actor_id !== provenance.actorId ||
            target.origin_actor_type !== provenance.actorType ||
            target.origin_user_id !== provenance.userId ||
            target.origin_sensitivity_ceiling !== provenance.sensitivityCeiling ||
            target.ledger_state !== "retryable" ||
            Number(target.enqueue_sequence) >= input.event.enqueueSequence
          ) {
            return storeAck(reject(input.event.eventId, "cancel_target_not_retryable", false));
          }
          const targetSequenceCode = await sequenceBlockCode(
            input.event.enqueueSequence,
            target.event_id
          );
          if (targetSequenceCode) {
            return storeAck(reject(input.event.eventId, targetSequenceCode, true), "retryable");
          }
          const targetAck = reject(target.event_id, "event_cancelled", false);
          await tx.execute(sql`
          DELETE FROM mnemosyne.mnemo_harness_message_chunk
          WHERE workspace_id = ${input.workspaceId} AND ingestion_event_id = ${target.id}
        `);
          await tx.execute(sql`
          UPDATE mnemosyne.mnemo_harness_ingestion_event
          SET ledger_state = 'cancelled', acknowledgement = ${JSON.stringify(targetAck)}::jsonb,
              retry_code = NULL, finalized_at = ${receivedAtIso}
          WHERE workspace_id = ${input.workspaceId} AND id = ${target.id}
        `);
          return storeAck({ eventId: input.event.eventId, status: "accepted", retryable: false });
        }

        const routedEvent = input.event as Exclude<
          HarnessEvent,
          { type: "session.start" } | { type: "event.cancel" }
        >;
        let session = sessions.find(
          (candidate) => candidate.source_generation === routedEvent.sourceGeneration
        );
        const latestBeforeRoute = sessions.at(-1);
        if (
          !session &&
          latestBeforeRoute &&
          routedEvent.sourceGeneration === latestBeforeRoute.source_generation + 1 &&
          !acceptsMutation(latestBeforeRoute, routedEvent.enqueueSequence) &&
          latestBeforeRoute.origin_actor_id === provenance.actorId &&
          latestBeforeRoute.origin_actor_type === provenance.actorType &&
          latestBeforeRoute.origin_user_id === provenance.userId &&
          latestBeforeRoute.origin_sensitivity_ceiling === provenance.sensitivityCeiling
        ) {
          session = (await ensureSuccessor(latestBeforeRoute)) ?? undefined;
        }
        if (!session) {
          return storeAck(reject(input.event.eventId, "missing_session_start", true), "retryable");
        }
        if (
          session.origin_actor_id !== provenance.actorId ||
          session.origin_actor_type !== provenance.actorType ||
          session.origin_user_id !== provenance.userId ||
          session.origin_sensitivity_ceiling !== provenance.sensitivityCeiling
        ) {
          return storeAck(reject(input.event.eventId, "session_binding_mismatch", false));
        }
        if (input.event.type !== "session.end") {
          const sequenceCode = await sequenceBlockCode();
          if (sequenceCode) {
            return storeAck(reject(input.event.eventId, sequenceCode, true), "retryable");
          }
        }

        if (input.event.type === "turn.append") {
          const erased = rows<{ id: string }>(
            await tx.execute(sql`
            SELECT id FROM mnemosyne.mnemo_harness_message_tombstone
            WHERE workspace_id = ${input.workspaceId}
              AND source_host = ${input.event.host}
              AND source_client_instance_id = ${input.event.clientInstanceId}
              AND source_session_id = ${input.event.hostSessionId}
              AND source_message_id = ${input.event.hostMessageId}
            LIMIT 1
          `)
          )[0];
          if (erased) return storeAck(reject(input.event.eventId, "transcript_erased", false));
          if (knownTurn) {
            return storeAck(
              {
                eventId: input.event.eventId,
                status: "accepted",
                retryable: false,
                sessionId: knownTurn.session_id,
                effectiveGeneration: knownTurn.source_generation,
              },
              "accepted",
              knownTurn.session_id
            );
          }
          const latest = sessions.at(-1)!;
          if (latest.source_generation > session.source_generation) session = latest;
          if (session.status !== "active") {
            if (session.status === "collapse_pending" && session.close_kind === "authoritative") {
              const coveredByGrace =
                !session.collapse_lease_owner &&
                !session.collapse_lease_expires_at &&
                session.close_grace_deadline !== null &&
                input.receivedAt <= session.close_grace_deadline &&
                session.terminal_max_enqueue_sequence !== null &&
                input.event.enqueueSequence <= session.terminal_max_enqueue_sequence;
              if (!coveredByGrace) {
                const successor = await ensureSuccessor(session);
                if (!successor) {
                  return storeAck(reject(input.event.eventId, "generation_exhausted", false));
                }
                session = successor;
              }
            } else if (
              session.status === "collapse_pending" &&
              session.close_kind === "provisional" &&
              !session.collapse_lease_owner &&
              !session.collapse_lease_expires_at
            ) {
              await tx.execute(sql`
              UPDATE mnemosyne.mnemo_session
              SET status = 'active', close_kind = NULL, close_requested_at = NULL,
                  close_grace_deadline = NULL, terminal_digest_version = NULL,
                  terminal_message_set_digest = NULL, terminal_max_enqueue_sequence = NULL
              WHERE workspace_id = ${input.workspaceId} AND id = ${session.id}
            `);
              session.status = "active";
            } else {
              const successor = await ensureSuccessor(session);
              if (!successor) {
                return storeAck(reject(input.event.eventId, "generation_exhausted", false));
              }
              session = successor;
            }
          }
          let finalContent = input.event.content;
          let finalContentHash = input.event.contentHash;

          if (input.event.chunk) {
            const chunk = input.event.chunk;
            // Fragments staged in an earlier generation (before routing moved to a
            // successor, e.g. after an inactivity claim) follow the message to the
            // generation that will materialize it; otherwise they are stranded.
            const sameMessage = sql`
              workspace_id = ${input.workspaceId}
              AND source_host = ${input.event.host}
              AND source_client_instance_id = ${input.event.clientInstanceId}
              AND source_session_id = ${input.event.hostSessionId}
              AND source_message_id = ${input.event.hostMessageId}`;
            const sameIdentity = sql`
              role = ${input.event.role}
              AND chunk_count = ${chunk.chunkCount}
              AND message_content_hash = ${chunk.messageContentHash}
              AND supersedes_source_message_id IS NOT DISTINCT FROM ${input.event.supersedesSourceMessageId ?? null}`;
            await tx.execute(sql`
              UPDATE mnemosyne.mnemo_harness_message_chunk
              SET session_id = ${session.id}, source_generation = ${session.source_generation}
              WHERE id IN (
                SELECT DISTINCT ON (chunk_index) id
                FROM mnemosyne.mnemo_harness_message_chunk
                WHERE ${sameMessage} AND ${sameIdentity}
                  AND source_generation <> ${session.source_generation}
                  AND chunk_index NOT IN (
                    SELECT chunk_index FROM mnemosyne.mnemo_harness_message_chunk
                    WHERE ${sameMessage} AND source_generation = ${session.source_generation}
                  )
                ORDER BY chunk_index, source_generation DESC
              )
            `);
            await tx.execute(sql`
              DELETE FROM mnemosyne.mnemo_harness_message_chunk
              WHERE ${sameMessage} AND ${sameIdentity}
                AND source_generation <> ${session.source_generation}
            `);
            const existingChunks = rows<{
              id: string;
              role: string;
              supersedes_source_message_id: string | null;
              chunk_index: number;
              chunk_count: number;
              chunk_content_hash: string;
              message_content_hash: string;
              content: string;
            }>(
              await tx.execute(sql`
                SELECT id, role, supersedes_source_message_id, chunk_index, chunk_count,
                       chunk_content_hash, message_content_hash, content
                FROM mnemosyne.mnemo_harness_message_chunk
                WHERE workspace_id = ${input.workspaceId}
                  AND source_host = ${input.event.host}
                  AND source_client_instance_id = ${input.event.clientInstanceId}
                  AND source_session_id = ${input.event.hostSessionId}
                  AND source_generation = ${session.source_generation}
                  AND source_message_id = ${input.event.hostMessageId}
                ORDER BY chunk_index ASC
                FOR UPDATE
              `)
            );

            for (const row of existingChunks) {
              if (
                row.role !== input.event.role ||
                row.chunk_count !== chunk.chunkCount ||
                row.message_content_hash !== chunk.messageContentHash ||
                (row.supersedes_source_message_id ?? undefined) !==
                  input.event.supersedesSourceMessageId
              ) {
                return storeAck(
                  reject(input.event.eventId, "source_message_identity_mismatch", false)
                );
              }
              if (
                row.chunk_index === chunk.chunkIndex &&
                row.chunk_content_hash !== input.event.contentHash
              ) {
                return storeAck(reject(input.event.eventId, "content_hash_mismatch", false));
              }
            }

            const alreadyHasChunk = existingChunks.some(
              (row) => row.chunk_index === chunk.chunkIndex
            );
            if (!alreadyHasChunk) {
              await tx.execute(sql`
                INSERT INTO mnemosyne.mnemo_harness_message_chunk
                  (workspace_id, session_id, ingestion_event_id, source_host,
                   source_client_instance_id, source_session_id, source_generation,
                   source_message_id, supersedes_source_message_id, role,
                   chunk_index, chunk_count, chunk_content_hash, message_content_hash,
                   content, created_at)
                VALUES
                  (${input.workspaceId}, ${session.id}, ${ledger.id}, ${input.event.host},
                   ${input.event.clientInstanceId}, ${input.event.hostSessionId},
                   ${session.source_generation}, ${input.event.hostMessageId},
                   ${input.event.supersedesSourceMessageId ?? null}, ${input.event.role},
                   ${chunk.chunkIndex}, ${chunk.chunkCount},
                   ${input.event.contentHash}, ${chunk.messageContentHash},
                   ${input.event.content}, ${receivedAtIso})
              `);
            }

            const allChunks = rows<{
              chunk_index: number;
              content: string;
            }>(
              await tx.execute(sql`
                SELECT chunk_index, content
                FROM mnemosyne.mnemo_harness_message_chunk
                WHERE workspace_id = ${input.workspaceId}
                  AND source_host = ${input.event.host}
                  AND source_client_instance_id = ${input.event.clientInstanceId}
                  AND source_session_id = ${input.event.hostSessionId}
                  AND source_generation = ${session.source_generation}
                  AND source_message_id = ${input.event.hostMessageId}
                ORDER BY chunk_index ASC
              `)
            );

            if (allChunks.length < chunk.chunkCount) {
              await tx.execute(sql`
                UPDATE mnemosyne.mnemo_session
                SET last_activity_at = GREATEST(COALESCE(last_activity_at, started_at), ${receivedAtIso})
                WHERE workspace_id = ${input.workspaceId} AND id = ${session.id}
              `);
              return storeAck(
                {
                  eventId: input.event.eventId,
                  status: "accepted",
                  retryable: false,
                  sessionId: session.id,
                  effectiveGeneration: session.source_generation,
                },
                "accepted",
                session.id
              );
            }

            const reassembled = allChunks.map((row) => row.content).join("");
            if (sha256Hex(reassembled) !== chunk.messageContentHash) {
              await tx.execute(sql`
                DELETE FROM mnemosyne.mnemo_harness_message_chunk
                WHERE workspace_id = ${input.workspaceId}
                  AND source_host = ${input.event.host}
                  AND source_client_instance_id = ${input.event.clientInstanceId}
                  AND source_session_id = ${input.event.hostSessionId}
                  AND source_generation = ${session.source_generation}
                  AND source_message_id = ${input.event.hostMessageId}
              `);
              return storeAck(reject(input.event.eventId, "content_hash_mismatch", false));
            }

            await tx.execute(sql`
              DELETE FROM mnemosyne.mnemo_harness_message_chunk
              WHERE workspace_id = ${input.workspaceId}
                AND source_host = ${input.event.host}
                AND source_client_instance_id = ${input.event.clientInstanceId}
                AND source_session_id = ${input.event.hostSessionId}
                AND source_generation = ${session.source_generation}
                AND source_message_id = ${input.event.hostMessageId}
            `);
            finalContent = reassembled;
            finalContentHash = chunk.messageContentHash;
          }

          if (supersededTurn) {
            const predecessorSession = sessions.find(
              (candidate) => candidate.source_generation === supersededTurn.source_generation
            )!;
            const predecessorWritable = acceptsMutation(
              predecessorSession,
              input.event.enqueueSequence
            );
            let predecessorId: string | null = predecessorSession.id;
            if (predecessorWritable) {
              const retracted = rows<{ source_message_id: string }>(
                await tx.execute(sql`
                UPDATE mnemosyne.mnemo_session_turn
                SET retracted_at = ${receivedAtIso}, retraction_reason = 'superseded'
                WHERE workspace_id = ${input.workspaceId}::uuid
                  AND session_id = ${supersededTurn.session_id}
                  AND source_message_id = ${supersededTurn.source_message_id}
                  AND retracted_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM mnemosyne.mnemo_session s
                    WHERE s.workspace_id = ${input.workspaceId}
                      AND s.id = ${supersededTurn.session_id}
                       AND (s.status = 'active' OR
                            (s.status = 'collapse_pending' AND s.collapse_lease_owner IS NULL AND
                             s.collapse_lease_expires_at IS NULL AND
                             (s.close_kind = 'provisional' OR
                              (s.close_kind = 'authoritative' AND
                               s.close_grace_deadline >= ${receivedAtIso}::timestamptz AND
                               s.terminal_max_enqueue_sequence >= ${input.event.enqueueSequence}))))
                  )
                RETURNING source_message_id
              `)
              )[0];
              if (!retracted) {
                return storeAck(
                  reject(input.event.eventId, "generation_changed", true),
                  "retryable"
                );
              }
              session = predecessorSession;
              predecessorId = null;
            }
            await tx.execute(sql`
            INSERT INTO mnemosyne.mnemo_harness_retraction
              (workspace_id, session_id, ingestion_event_id, source_message_id,
               predecessor_session_id, reason, created_at)
            VALUES (${input.workspaceId}, ${session.id}, ${ledger.id},
                    ${supersededTurn.source_message_id}, ${predecessorId}, 'superseded',
                    ${receivedAtIso})
          `);
          }
          const nextIndex = rows<{ next_index: number }>(
            await tx.execute(sql`
            SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_index
            FROM mnemosyne.mnemo_session_turn
            WHERE workspace_id = ${input.workspaceId}::uuid AND session_id = ${session.id}
          `)
          )[0]!.next_index;
          const tokenCount = Math.ceil(Buffer.byteLength(finalContent, "utf8") / 4);
          await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_session_turn
            (workspace_id, session_id, turn_index, role, content, token_count, created_at,
             source_message_id, supersedes_source_message_id, content_hash,
             ingestion_event_workspace_id, ingestion_event_id, turn_origin, turn_origin_evidence)
          VALUES
            (${input.workspaceId}::uuid, ${session.id}, ${nextIndex}, ${input.event.role},
              ${finalContent}, ${tokenCount}, ${receivedAtIso}, ${input.event.hostMessageId},
              ${input.event.supersedesSourceMessageId ?? null}, ${finalContentHash},
              ${input.workspaceId}, ${ledger.id}, ${input.event.turnOrigin ?? (input.event.role === "assistant" ? "assistant" : "unknown")},
              ${input.event.turnOriginEvidence ?? "unclassified"})
        `);
          await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET turn_count = turn_count + 1,
              token_count = token_count + ${tokenCount},
              last_activity_at = GREATEST(COALESCE(last_activity_at, started_at), ${receivedAtIso})
          WHERE workspace_id = ${input.workspaceId} AND id = ${session.id}
            AND (status = 'active' OR
                 (status = 'collapse_pending' AND collapse_lease_owner IS NULL AND
                  collapse_lease_expires_at IS NULL))
        `);
          return storeAck(
            {
              eventId: input.event.eventId,
              status: "accepted",
              retryable: false,
              sessionId: session.id,
              effectiveGeneration: session.source_generation,
            },
            "accepted",
            session.id
          );
        }

        if (input.event.type === "turn.retract") {
          const target = rows<TurnRow>(
            await tx.execute(sql`
            SELECT t.session_id, s.source_generation, t.source_message_id,
                   t.role, t.content_hash, t.retracted_at
            FROM mnemosyne.mnemo_session_turn t
            JOIN mnemosyne.mnemo_session s
              ON s.workspace_id = t.ingestion_event_workspace_id AND s.id = t.session_id
            WHERE s.workspace_id = ${input.workspaceId}
              AND s.source_host = ${input.event.host}
              AND s.source_client_instance_id = ${input.event.clientInstanceId}
              AND s.source_session_id = ${input.event.hostSessionId}
              AND t.source_message_id = ${input.event.hostMessageId}
            LIMIT 1 FOR UPDATE OF t
          `)
          )[0];
          if (!target) {
            return storeAck(
              reject(input.event.eventId, "missing_source_message", true),
              "retryable"
            );
          }
          const targetSession = sessions.find(
            (candidate) => candidate.source_generation === target.source_generation
          )!;
          let predecessorId: string | null = null;
          if (acceptsMutation(targetSession, input.event.enqueueSequence)) {
            await tx.execute(sql`
            UPDATE mnemosyne.mnemo_session_turn
            SET retracted_at = ${receivedAtIso}, retraction_reason = ${input.event.reason}
            WHERE workspace_id = ${input.workspaceId}::uuid
              AND session_id = ${target.session_id}
              AND source_message_id = ${input.event.hostMessageId}
              AND retracted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM mnemosyne.mnemo_session s
                WHERE s.workspace_id = ${input.workspaceId}
                  AND s.id = ${target.session_id}
                   AND (s.status = 'active' OR
                         (s.status = 'collapse_pending' AND s.collapse_lease_owner IS NULL AND
                          s.collapse_lease_expires_at IS NULL AND
                         (s.close_kind = 'provisional' OR
                          (s.close_kind = 'authoritative' AND
                           s.close_grace_deadline >= ${receivedAtIso}::timestamptz AND
                           s.terminal_max_enqueue_sequence >= ${input.event.enqueueSequence}))))
              )
          `);
            session = targetSession;
          } else {
            const latest = sessions.at(-1)!;
            const latestWritable = acceptsMutation(latest, input.event.enqueueSequence);
            if (latestWritable) {
              session = latest;
            } else {
              const successor = await ensureSuccessor(latest);
              if (!successor) {
                return storeAck(reject(input.event.eventId, "generation_exhausted", false));
              }
              session = successor;
            }
            predecessorId = targetSession.id;
          }
          await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_harness_retraction
            (workspace_id, session_id, ingestion_event_id, source_message_id,
             predecessor_session_id, reason, created_at)
          VALUES (${input.workspaceId}, ${session.id}, ${ledger.id},
                  ${input.event.hostMessageId}, ${predecessorId}, ${input.event.reason},
                  ${receivedAtIso})
        `);
          return storeAck(
            {
              eventId: input.event.eventId,
              status: "accepted",
              retryable: false,
              sessionId: session.id,
              effectiveGeneration: session.source_generation,
            },
            "accepted",
            session.id
          );
        }

        if (input.event.type === "sequence.loss") {
          const acceptsLoss =
            session.status === "active" ||
            (session.status === "collapse_pending" &&
              !session.collapse_lease_owner &&
              !session.collapse_lease_expires_at &&
              (session.close_kind !== "authoritative" ||
                (session.close_grace_deadline !== null &&
                  input.receivedAt <= session.close_grace_deadline &&
                  session.terminal_max_enqueue_sequence !== null &&
                  input.event.enqueueSequence <= session.terminal_max_enqueue_sequence)));
          if (!acceptsLoss) {
            return storeAck(reject(input.event.eventId, "generation_changed", true), "retryable");
          }
          const generationTurn =
            knownTurn?.source_generation === session.source_generation ? knownTurn : undefined;
          if (input.event.lostEventType === "turn.retract" && generationTurn) {
            const targetSession = sessions.find(
              (candidate) => candidate.source_generation === generationTurn.source_generation
            )!;
            if (
              targetSession.status === "active" ||
              (targetSession.status === "collapse_pending" &&
                !targetSession.collapse_lease_owner &&
                !targetSession.collapse_lease_expires_at)
            ) {
              await tx.execute(sql`
              UPDATE mnemosyne.mnemo_session_turn
              SET retracted_at = ${receivedAtIso}, retraction_reason = ${input.event.reason}
              WHERE workspace_id = ${input.workspaceId}::uuid
                AND session_id = ${generationTurn.session_id}
                AND source_message_id = ${input.event.lostHostMessageId}
                AND retracted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM mnemosyne.mnemo_session s
                  WHERE s.workspace_id = ${input.workspaceId}
                    AND s.id = ${generationTurn.session_id}
                    AND (s.status = 'active' OR
                          (s.status = 'collapse_pending' AND s.collapse_lease_owner IS NULL AND
                           s.collapse_lease_expires_at IS NULL))
                )
            `);
              session = targetSession;
            } else {
              const successor = await ensureSuccessor(sessions.at(-1)!);
              if (!successor) {
                return storeAck(reject(input.event.eventId, "generation_exhausted", false));
              }
              session = successor;
            }
          }
          await tx.execute(sql`
          INSERT INTO mnemosyne.mnemo_harness_loss
            (workspace_id, session_id, ingestion_event_id, source_generation,
             enqueue_sequence, lost_event_type, lost_source_message_id, lost_role,
             lost_content_hash, reason, created_at)
          VALUES (${input.workspaceId}, ${session.id}, ${ledger.id},
                  ${session.source_generation}, ${input.event.enqueueSequence},
                  ${input.event.lostEventType}, ${input.event.lostHostMessageId},
                  ${input.event.lostRole}, ${input.event.lostContentHash},
                  ${input.event.reason}, ${receivedAtIso})
        `);
          await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
          SET capture_incomplete = true,
              capture_incomplete_reasons = capture_incomplete_reasons || ${JSON.stringify([
                input.event.reason,
              ])}::jsonb
          WHERE workspace_id = ${input.workspaceId} AND id = ${session.id}
            AND (status = 'active' OR
                 (status = 'collapse_pending' AND collapse_lease_owner IS NULL AND
                  collapse_lease_expires_at IS NULL))
        `);
          return storeAck(
            {
              eventId: input.event.eventId,
              status: "accepted",
              retryable: false,
              sessionId: session.id,
              effectiveGeneration: session.source_generation,
            },
            "accepted",
            session.id
          );
        }

        const terminal = input.event;
        if (sessions.at(-1)!.source_generation !== terminal.sourceGeneration) {
          return storeAck(reject(terminal.eventId, "generation_changed", true), "retryable");
        }
        if (session.status === "collapse_pending" && session.close_kind === "authoritative") {
          if (
            session.terminal_message_set_digest === terminal.finalMessageSetDigest &&
            session.terminal_max_enqueue_sequence === terminal.maxEnqueueSequence
          ) {
            return storeAck(
              {
                eventId: terminal.eventId,
                status: "accepted",
                retryable: false,
                sessionId: session.id,
                effectiveGeneration: session.source_generation,
              },
              "accepted",
              session.id
            );
          }
          return storeAck(reject(terminal.eventId, "terminal_barrier_conflict", false));
        }
        if (
          session.status === "collapsed" ||
          session.status === "archived" ||
          (session.status === "collapse_pending" &&
            (session.collapse_lease_owner || session.collapse_lease_expires_at))
        ) {
          return storeAck(reject(terminal.eventId, "terminal_state_conflict", false));
        }
        const lower = rows<{ enqueue_sequence: number; ledger_state: string }>(
          await tx.execute(sql`
          SELECT enqueue_sequence, ledger_state
          FROM mnemosyne.mnemo_harness_ingestion_event
          WHERE workspace_id = ${input.workspaceId}
            AND source_host = ${terminal.host}
            AND source_client_instance_id = ${terminal.clientInstanceId}
            AND source_session_id = ${terminal.hostSessionId}
            AND enqueue_sequence BETWEEN 1 AND ${terminal.maxEnqueueSequence}
        `)
        );
        const pendingChunks = rows<{ id: string }>(
          await tx.execute(sql`
            SELECT id FROM mnemosyne.mnemo_harness_message_chunk
            WHERE workspace_id = ${input.workspaceId} AND session_id = ${session.id}
            LIMIT 1
          `)
        );
        const complete =
          pendingChunks.length === 0 &&
          lower.length === terminal.maxEnqueueSequence &&
          lower.every((row) => row.ledger_state !== "retryable");
        const terminalTurns = rows<TurnRow>(
          await tx.execute(sql`
          SELECT t.session_id, s.source_generation, t.source_message_id,
                 t.role, t.content_hash, t.retracted_at
          FROM mnemosyne.mnemo_session_turn t
          JOIN mnemosyne.mnemo_session s
            ON s.workspace_id = t.ingestion_event_workspace_id AND s.id = t.session_id
          WHERE t.workspace_id = ${input.workspaceId}::uuid
            AND t.session_id = ${session.id} AND t.retracted_at IS NULL
        `)
        );
        const lossRows = rows<{
          source_message_id: string;
          role: "user" | "assistant";
          content_hash: string;
        }>(
          await tx.execute(sql`
          SELECT lost_source_message_id AS source_message_id, lost_role AS role,
                 lost_content_hash AS content_hash
          FROM mnemosyne.mnemo_harness_loss
          WHERE workspace_id = ${input.workspaceId} AND session_id = ${session.id}
        `)
        );
        let digest: string;
        try {
          digest = computeTerminalDigestV1([
            ...terminalTurns.map((turn) => ({
              type: "M" as const,
              hostMessageId: turn.source_message_id,
              role: turn.role,
              contentHash: turn.content_hash,
            })),
            ...lossRows.map((loss) => ({
              type: "L" as const,
              hostMessageId: loss.source_message_id,
              role: loss.role,
              contentHash: loss.content_hash,
            })),
          ]);
        } catch {
          return storeAck(reject(terminal.eventId, "terminal_members_conflict", false));
        }
        if (!complete || digest !== terminal.finalMessageSetDigest) {
          return storeAck(
            reject(terminal.eventId, "incomplete_terminal_barrier", true),
            "retryable"
          );
        }
        const closed = rows<{ id: string }>(
          await tx.execute(sql`
          UPDATE mnemosyne.mnemo_session
        SET status = 'collapse_pending', close_kind = 'authoritative',
            close_requested_at = ${receivedAtIso},
            close_grace_deadline = ${new Date(input.receivedAt.getTime() + this.closeGraceMs).toISOString()},
            terminal_digest_version = 1,
            terminal_message_set_digest = ${terminal.finalMessageSetDigest},
            terminal_max_enqueue_sequence = ${terminal.maxEnqueueSequence}
          WHERE workspace_id = ${input.workspaceId} AND id = ${session.id}
            AND collapse_lease_owner IS NULL
            AND collapse_lease_expires_at IS NULL
            AND (status = 'active' OR
                 (status = 'collapse_pending' AND close_kind = 'provisional'))
          RETURNING id
        `)
        )[0];
        if (!closed) {
          return storeAck(reject(terminal.eventId, "terminal_state_conflict", false));
        }
        return storeAck(
          {
            eventId: terminal.eventId,
            status: "accepted",
            retryable: false,
            sessionId: session.id,
            effectiveGeneration: session.source_generation,
          },
          "accepted",
          session.id
        );
      })
    );
  }
}
