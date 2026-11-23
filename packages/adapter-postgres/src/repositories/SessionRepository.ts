import { eq, and, sql, desc, isNull } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { instrumentedQuery, mapRowToSession } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type { SessionStats, Sensitivity } from "@mnemo-ai/types";
import { tallySessionStats, tiersAtOrBelow } from "@mnemo-ai/types";
import type { MnemoSession, SessionTurn, CreateSessionInput } from "@mnemo-ai/types";

type SessionTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

export async function setWorkspaceContext(tx: SessionTx, workspaceId: string): Promise<void> {
  const memberCheck = await tx.execute(
    sql`SELECT pg_has_role(current_user, 'app_user', 'member') AS m`
  );
  if ((memberCheck as unknown as Array<{ m?: boolean }> | undefined)?.[0]?.m) {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SET LOCAL search_path TO mnemosyne, public`);
  } else {
    const roleRows = await tx.execute(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    const role = (
      roleRows as unknown as
        | Array<{
            rolsuper?: boolean;
            rolbypassrls?: boolean;
          }>
        | undefined
    )?.[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("[SECURITY] Unsafe database role cannot enforce workspace RLS");
    }
  }
  await tx.execute(sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`);
  await tx.execute(sql`SELECT set_config('mnemosyne.workspace_id', ${workspaceId}, true)`);
}

export class SessionRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  /**
   * SessionPort.getSessionStats: sessions started per UTC day by status, and the
   * window's episodes (non-synthetic, under the ceiling) with their readable
   * linked facts and topics. Two grouped reads in one workspace-scoped transaction.
   */
  async getSessionStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<SessionStats> {
    const { workspaceId: ws, days } = input;
    const since = sql`(((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp AT TIME ZONE 'UTC')`;
    const tiers = input.maxSensitivity
      ? sql.join(
          tiersAtOrBelow(input.maxSensitivity).map((t) => sql`${t}`),
          sql`, `
        )
      : null;
    const visible = (alias: string) =>
      tiers ? sql` AND ${sql.raw(alias)}.sensitivity IN (${tiers})` : sql``;
    const { sessions, episodes } = await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, ws);
      const sessions = (await tx.execute(sql`
        SELECT to_char((started_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, status,
               count(*)::int AS n,
               count(*) FILTER (WHERE collapsed_at IS NOT NULL)::int AS collapsed,
               coalesce(sum(turn_count), 0)::int AS turns
        FROM mnemosyne.mnemo_session
        WHERE workspace_id = ${ws} AND started_at >= ${since}
        GROUP BY 1, 2
      `)) as unknown as Array<{
        day: string;
        status: string;
        n: number;
        collapsed: number;
        turns: number;
      }>;
      const episodes = (await tx.execute(sql`
        SELECT ep.topics,
               (SELECT count(*)::int
                FROM unnest(ep.linked_fact_ids) AS linked(fact_id)
                JOIN mnemosyne.mnemo_fact f
                  ON f.id = linked.fact_id AND f.workspace_id = ep.workspace_id${visible("f")}
               ) AS facts
        FROM mnemosyne.mnemo_episode ep
        WHERE ep.workspace_id = ${ws} AND NOT ep.is_synthetic
          AND ep.occurred_at >= ${since}${visible("ep")}
      `)) as unknown as Array<{ topics: string[]; facts: number }>;
      return { sessions: Array.from(sessions), episodes: Array.from(episodes) };
    });
    return tallySessionStats(
      days,
      sessions.map((r) => ({
        ...r,
        n: Number(r.n),
        collapsed: Number(r.collapsed),
        turns: Number(r.turns),
      })),
      episodes.map((e) => ({ topics: e.topics ?? [], facts: Number(e.facts) }))
    );
  }

  async createSession(input: CreateSessionInput): Promise<MnemoSession> {
    const id = crypto.randomUUID();

    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);

      const fail = (code: string): never => {
        throw Object.assign(new Error(code), { code });
      };
      let predecessor: schema.SelectSession | undefined;
      if (input.sourceSessionId) {
        // Serialise creation/replay even before a root row exists.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          jsonb_build_array(${input.workspaceId}::text, 'legacy-session', ${input.sourceClientInstanceId ?? ""}::text, ${input.sourceSessionId}::text)::text, 0))`);
      }
      if (input.predecessorSessionId) {
        const parents = await tx
          .select()
          .from(schema.sessionTable)
          .where(
            and(
              eq(schema.sessionTable.id, input.predecessorSessionId),
              eq(schema.sessionTable.workspaceId, input.workspaceId)
            )
          )
          .for("update");
        predecessor = parents[0];
        if (!predecessor) fail("NOT_FOUND");
        const meta = predecessor!.metadata as Record<string, unknown>;
        if (
          predecessor!.sourceHost ||
          predecessor!.sourceSessionId !== input.sourceSessionId ||
          predecessor!.sourceClientInstanceId !== input.sourceClientInstanceId ||
          meta.actorId !== input.actorId ||
          (predecessor!.sourceGeneration ?? 0) + 1 !== input.sourceGeneration
        )
          fail("SESSION_BINDING_MISMATCH");
        if (predecessor!.status !== "collapsed" && predecessor!.status !== "archived")
          fail("SESSION_ACTIVE");
      }
      if (
        input.sourceSessionId &&
        input.sourceClientInstanceId &&
        input.sourceGeneration !== undefined
      ) {
        const matches = await tx
          .select()
          .from(schema.sessionTable)
          .where(
            and(
              eq(schema.sessionTable.workspaceId, input.workspaceId),
              isNull(schema.sessionTable.sourceHost),
              eq(schema.sessionTable.sourceSessionId, input.sourceSessionId),
              eq(schema.sessionTable.sourceClientInstanceId, input.sourceClientInstanceId),
              eq(schema.sessionTable.sourceGeneration, input.sourceGeneration)
            )
          );
        if (matches[0]) {
          if (
            (matches[0].metadata as Record<string, unknown>).actorId !== input.actorId ||
            (matches[0].predecessorSessionId ?? undefined) !== input.predecessorSessionId
          )
            fail("SESSION_BINDING_MISMATCH");
          return mapRowToSession(matches[0]);
        }
      }

      // §14 A/B stamping: sample active vs candidate prompt version (50/50).
      // The nested transaction is a savepoint so a best-effort lookup failure
      // does not abort the scoped outer transaction that creates the session.
      let activePromptVersionId: string | null = null;
      if (input.agentId) {
        try {
          const pvRows = await tx.transaction((promptTx) =>
            promptTx.execute<{ id: string; is_active: boolean }>(sql`
              SELECT id, is_active
              FROM mnemosyne.mnemo_prompt_version
              WHERE workspace_id = ${input.workspaceId}
                AND agent_id     = ${input.agentId}
                AND status IN ('active', 'candidate')
              ORDER BY version DESC
              LIMIT 2
            `)
          );
          const active = (pvRows as { id: string; is_active: boolean }[]).find((r) => r.is_active);
          const candidate = (pvRows as { id: string; is_active: boolean }[]).find(
            (r) => !r.is_active
          );
          if (active && candidate) {
            activePromptVersionId = Math.random() < 0.5 ? active.id : candidate.id;
          } else if (active) {
            activePromptVersionId = active.id;
          }
        } catch {
          // A/B stamping is best-effort — session creation must not fail
        }
      }

      const rows = await tx
        .insert(schema.sessionTable)
        .values({
          id,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          trafficOrigin: predecessor?.trafficOrigin ?? input.trafficOrigin ?? "unknown",
          sourceSessionId: input.sourceSessionId,
          sourceClientInstanceId: input.sourceClientInstanceId,
          sourceGeneration: input.sourceGeneration,
          predecessorSessionId: input.predecessorSessionId,
          continuityRootId: predecessor?.continuityRootId ?? predecessor?.id ?? id,
          // p45 Slice B: user_id MUST hold the real platform user id, never the
          // namespaced credential ActorRef. actorId/actorType are provenance,
          // not the session's subject, so they live only in metadata.
          userId: input.userId ?? null,
          status: "active",
          activePromptVersionId: activePromptVersionId ?? undefined,
          label: input.label ?? null,
          metadata: {
            ...((input.metadata ?? {}) as Record<string, unknown>),
            // System keys spread LAST so a caller-supplied metadata field can
            // never overwrite the real actor provenance.
            actorId: input.actorId,
            actorType: input.actorType,
          },
        })
        .returning();

      return mapRowToSession(rows[0]!);
    });
  }

  async appendTurn(
    sessionId: string,
    turn: Omit<SessionTurn, "id" | "createdAt">
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, turn.workspaceId);
      const roots = await tx
        .select({ root: schema.sessionTable.continuityRootId })
        .from(schema.sessionTable)
        .where(
          and(
            eq(schema.sessionTable.id, sessionId),
            eq(schema.sessionTable.workspaceId, turn.workspaceId)
          )
        );
      const rootId = roots[0]?.root ?? sessionId;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array(${turn.workspaceId}::text, 'legacy-turn', ${rootId}::text)::text, 0))`);
      const parentRows = await tx
        .select({
          id: schema.sessionTable.id,
          status: schema.sessionTable.status,
          sourceHost: schema.sessionTable.sourceHost,
          closeKind: schema.sessionTable.closeKind,
          collapseLeaseOwner: schema.sessionTable.collapseLeaseOwner,
          collapseLeaseExpiresAt: schema.sessionTable.collapseLeaseExpiresAt,
        })
        .from(schema.sessionTable)
        .where(
          and(
            eq(schema.sessionTable.id, sessionId),
            eq(schema.sessionTable.workspaceId, turn.workspaceId)
          )
        )
        .limit(1)
        .for("update");
      const parent = parentRows[0];
      if (!parent) {
        const error = new Error(`Session ${sessionId} not found.`) as Error & { code?: string };
        error.code = "NOT_FOUND";
        throw error;
      }
      if (turn.sourceMessageId) {
        const duplicate = await tx
          .select()
          .from(schema.sessionTurnTable)
          .where(
            and(
              eq(schema.sessionTurnTable.workspaceId, turn.workspaceId),
              eq(schema.sessionTurnTable.continuityRootId, rootId),
              eq(schema.sessionTurnTable.sourceMessageId, turn.sourceMessageId)
            )
          );
        if (duplicate[0]) {
          if (duplicate[0].role !== turn.role || duplicate[0].content !== turn.content)
            throw Object.assign(new Error("Message identity reused"), {
              code: "SOURCE_MESSAGE_CONFLICT",
            });
          return duplicate[0].turnIndex;
        }
      }
      if (parent.status === "collapsed" || parent.status === "archived") {
        const error = new Error(`Session ${sessionId} is terminal.`) as Error & { code?: string };
        error.code = "SESSION_TERMINAL";
        throw error;
      }
      if (parent.status === "collapse_pending") {
        if (
          parent.sourceHost !== null &&
          parent.closeKind === "provisional" &&
          parent.collapseLeaseOwner === null &&
          parent.collapseLeaseExpiresAt === null
        ) {
          await tx.execute(sql`
            UPDATE mnemosyne.mnemo_session
            SET status = 'active', close_kind = NULL, close_requested_at = NULL,
                close_grace_deadline = NULL, collapse_next_attempt_at = NULL
            WHERE id = ${sessionId} AND workspace_id = ${turn.workspaceId}
              AND status = 'collapse_pending' AND close_kind = 'provisional'
              AND collapse_lease_owner IS NULL AND collapse_lease_expires_at IS NULL
          `);
        } else {
          const error = new Error(`Session ${sessionId} is closed for writes.`) as Error & {
            code?: string;
          };
          error.code = "SESSION_CLOSED";
          throw error;
        }
      }

      const nextTurnRows = await tx
        .select({
          turnIndex: sql<number>`COALESCE(MAX(${schema.sessionTurnTable.turnIndex}), -1) + 1`,
        })
        .from(schema.sessionTurnTable)
        .where(
          and(
            eq(schema.sessionTurnTable.sessionId, sessionId),
            eq(schema.sessionTurnTable.workspaceId, turn.workspaceId)
          )
        );
      const turnIndex = Number(nextTurnRows[0]!.turnIndex);

      await tx.insert(schema.sessionTurnTable).values({
        workspaceId: turn.workspaceId,
        sessionId,
        turnIndex,
        role: turn.role,
        content: turn.content,
        continuityRootId: rootId,
        turnOrigin: turn.turnOrigin ?? (turn.role === "assistant" ? "assistant" : "unknown"),
        turnOriginEvidence: turn.turnOriginEvidence ?? "unclassified",
        tokenCount: turn.tokenCount,
        pinned: turn.pinned,
        hint: turn.hint,
        sourceMessageId: turn.sourceMessageId,
        supersedesSourceMessageId: turn.supersedesSourceMessageId,
        contentHash: turn.contentHash,
        retractedAt: turn.retractedAt,
        retractionReason: turn.retractionReason,
        ingestionEventId: turn.ingestionEventId,
      });

      // P116: keep the denormalised counters on mnemo_session in step with the
      // rows. Inserting the turn and leaving these at 0 is not cosmetic — the
      // auto-collapse sweep predicate is
      //   `started_at <= NOW() - INTERVAL '5 minutes'
      //      OR turn_count >= 5 OR token_count >= 1024`   (server/src/index.ts)
      // so two of its three triggers could never fire, and
      // shouldCollapseUnderPolicy decided `max_turns`/`max_tokens` against
      // permanent zeros. Measured before the fix: sessions with 3 and 4 real
      // rows in mnemo_session_turn, both reporting turn_count = 0.
      //
      // It stayed invisible because the in-memory adapter DERIVES turnCount by
      // counting turns on read (types/src/testing/in-memory/sessions.ts), so
      // every unit test agreed with a Postgres adapter that disagreed with the
      // database. The regression test for this therefore has to run against the
      // real adapter — see session-turn-counters.integration.test.ts.
      //
      // Same transaction as the INSERT: a counter that can drift from its rows
      // is worse than no counter, because it reads as authoritative.
      await tx
        .update(schema.sessionTable)
        .set({
          turnCount: sql`${schema.sessionTable.turnCount} + 1`,
          tokenCount: sql`${schema.sessionTable.tokenCount} + ${turn.tokenCount ?? 0}`,
          lastActivityAt: sql`transaction_timestamp()`,
        })
        .where(
          and(
            eq(schema.sessionTable.id, sessionId),
            eq(schema.sessionTable.workspaceId, turn.workspaceId)
          )
        );
      return turnIndex;
    });
  }

  async listTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      const rows = await tx
        .select()
        .from(schema.sessionTurnTable)
        .where(
          and(
            eq(schema.sessionTurnTable.sessionId, sessionId),
            eq(schema.sessionTurnTable.workspaceId, workspaceId)
          )
        )
        .orderBy(schema.sessionTurnTable.turnIndex);

      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        turnIndex: row.turnIndex,
        role: row.role as SessionTurn["role"],
        content: row.content,
        turnOrigin: row.turnOrigin as SessionTurn["turnOrigin"],
        turnOriginEvidence: row.turnOriginEvidence,
        tokenCount: row.tokenCount ?? undefined,
        pinned: row.pinned,
        hint: row.hint ?? undefined,
        sourceMessageId: row.sourceMessageId ?? undefined,
        supersedesSourceMessageId: row.supersedesSourceMessageId ?? undefined,
        contentHash: row.contentHash ?? undefined,
        retractedAt: row.retractedAt ?? undefined,
        retractionReason: row.retractionReason ?? undefined,
        ingestionEventId: row.ingestionEventId ?? undefined,
        createdAt: row.createdAt,
      }));
    });
  }

  async listManagedCollapseTurns(sessionId: string, workspaceId: string): Promise<SessionTurn[]> {
    const turns = await this.listTurns(sessionId, workspaceId);
    return turns.filter(
      (turn) =>
        turn.retractedAt === undefined && (turn.role === "user" || turn.role === "assistant")
    );
  }

  async closeSession(id: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      const now = new Date();
      const existing = await tx
        .select()
        .from(schema.sessionTable)
        .where(
          and(eq(schema.sessionTable.id, id), eq(schema.sessionTable.workspaceId, workspaceId))
        )
        .limit(1);

      if (!existing[0] || existing[0].sourceHost !== null) return;

      const meta = (existing[0].metadata ?? {}) as Record<string, unknown>;
      await tx
        .update(schema.sessionTable)
        .set({
          status: "collapsed",
          collapsedAt: now,
          metadata: { ...meta, closedAt: now.toISOString() },
        })
        .where(
          and(
            eq(schema.sessionTable.id, id),
            eq(schema.sessionTable.workspaceId, workspaceId),
            isNull(schema.sessionTable.sourceHost)
          )
        );
    });
  }

  /**
   * LIFECYCLE-7/8 — the ordinary collapse's single transaction. See
   * `SessionPort.commitSessionCollapse`.
   *
   * The row lock is what makes the collapse single-winner: a second collapse of
   * the same session waits here, then finds `collapsed` and writes nothing. Every
   * repository `apply` reaches through `scoped(tx)` opens its own nested
   * transaction, i.e. a SAVEPOINT inside this one, so all of it commits with the
   * status change or rolls back with a throw.
   */
  async commitSessionCollapse<T, S>(
    input: {
      workspaceId: string;
      sessionId: string;
      expectedTurnCount?: number;
      terminalStatus?: "collapsed" | "archived";
      archiveReason?: string;
      topicLocks?: { facts: string[]; decisions: string[] };
    },
    scoped: (tx: SessionTx) => S,
    apply: (storage: S) => Promise<T>
  ): Promise<{ committed: true; value: T } | { committed: false; status: string | null }> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const locked = await tx
        .select({
          status: schema.sessionTable.status,
          turnCount: schema.sessionTable.turnCount,
          sourceHost: schema.sessionTable.sourceHost,
          metadata: schema.sessionTable.metadata,
        })
        .from(schema.sessionTable)
        .where(
          and(
            eq(schema.sessionTable.id, input.sessionId),
            eq(schema.sessionTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1)
        .for("update");
      const row = locked[0];
      if (!row || row.sourceHost !== null || row.status === "collapsed") {
        return { committed: false as const, status: row?.status ?? null };
      }

      if (input.expectedTurnCount !== undefined && row.turnCount !== input.expectedTurnCount) {
        throw Object.assign(
          new Error("Session changed during collapse; retry the current snapshot"),
          { code: "SESSION_SNAPSHOT_CHANGED" }
        );
      }

      // Review round: every topic this collapse will create or merge, locked
      // here in one sorted order. Inside `apply` each merge takes its own
      // transaction-held lock as it goes; two collapses meeting the same
      // topics as [A, B] and [B, A] each held one and waited for the other,
      // and Postgres aborted one whole collapse with a deadlock. The fact
      // lock is FactRepository.mergeFactByTopicKey's own (same expression, so
      // re-taking it there is re-entrant); decisions get the same treatment
      // in their own namespace, over the normalised key their index uses.
      const factKeys = [...new Set(input.topicLocks?.facts ?? [])].sort();
      const decisionKeys = [
        ...new Set((input.topicLocks?.decisions ?? []).map((k) => k.trim().toLowerCase())),
      ].sort();
      for (const key of factKeys) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(jsonb_build_array(${input.workspaceId}::text, ${key}::text)::text, 0)
          )
        `);
      }
      for (const key of decisionKeys) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              jsonb_build_array(${input.workspaceId}::text, 'decision'::text, ${key}::text)::text,
              0
            )
          )
        `);
      }

      const value = await apply(scoped(tx));

      const now = new Date();
      const archived = input.terminalStatus === "archived";
      const { collapseLastError: _resolved, ...meta } = (row.metadata ?? {}) as Record<
        string,
        unknown
      >;
      await tx
        .update(schema.sessionTable)
        .set(
          archived
            ? {
                status: "archived",
                metadata: {
                  ...meta,
                  archivedAt: now.toISOString(),
                  ...(input.archiveReason ? { archiveReason: input.archiveReason } : {}),
                },
              }
            : {
                status: "collapsed",
                collapsedAt: now,
                metadata: { ...meta, closedAt: now.toISOString() },
              }
        )
        .where(
          and(
            eq(schema.sessionTable.id, input.sessionId),
            eq(schema.sessionTable.workspaceId, input.workspaceId),
            isNull(schema.sessionTable.sourceHost)
          )
        );
      return { committed: true as const, value };
    });
  }

  async recordCollapseFailure(id: string, workspaceId: string, error: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_session
        SET collapse_attempts = LEAST(COALESCE(collapse_attempts, 0)::bigint + 1, 2147483647::bigint)::integer,
            -- 5 min doubling, capped at 24 h: with the sweep's attempt limit this
            -- spans about a day, so a provider outage recovers on its own.
            collapse_next_attempt_at = clock_timestamp() +
              LEAST(1440::numeric, 5::numeric * power(2::numeric, LEAST(COALESCE(collapse_attempts, 0), 30))) * interval '1 minute',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('collapseLastError', ${error}::text)
        WHERE id = ${id} AND workspace_id = ${workspaceId}
          AND status = 'active' AND source_host IS NULL
      `);
    });
  }

  /**
   * §7 discard — archive WITHOUT collapse. Sets status='archived' and stamps
   * metadata.archivedAt; never writes context_snapshot (no knowledge extracted).
   */
  async archiveSession(id: string, workspaceId: string, reason?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      const now = new Date();
      const existing = await tx
        .select()
        .from(schema.sessionTable)
        .where(
          and(eq(schema.sessionTable.id, id), eq(schema.sessionTable.workspaceId, workspaceId))
        )
        .limit(1);

      if (!existing[0] || existing[0].sourceHost !== null) return;

      const meta = (existing[0].metadata ?? {}) as Record<string, unknown>;
      await tx
        .update(schema.sessionTable)
        .set({
          status: "archived",
          metadata: {
            ...meta,
            archivedAt: now.toISOString(),
            ...(reason ? { archiveReason: reason } : {}),
          },
        })
        .where(
          and(
            eq(schema.sessionTable.id, id),
            eq(schema.sessionTable.workspaceId, workspaceId),
            isNull(schema.sessionTable.sourceHost)
          )
        );
    });
  }

  async getSession(id: string, workspaceId: string): Promise<MnemoSession | null> {
    return instrumentedQuery("admin", async () => {
      return this.db.transaction(async (tx) => {
        await setWorkspaceContext(tx, workspaceId);
        const rows = await tx
          .select()
          .from(schema.sessionTable)
          .where(
            and(eq(schema.sessionTable.id, id), eq(schema.sessionTable.workspaceId, workspaceId))
          )
          .limit(1);

        return rows[0] ? mapRowToSession(rows[0]) : null;
      });
    });
  }

  /**
   * ADP-3: listSessions was declared as an optional StorageAdapter port
   * method but never implemented here. GET /session/list feature-detects
   * it and silently returns [] when absent, so the route existed (closing
   * B2) but always came back empty against the real Postgres adapter.
   */
  async listSessions(workspaceId: string, limit = 50, offset = 0): Promise<MnemoSession[]> {
    return instrumentedQuery("admin", async () => {
      return this.db.transaction(async (tx) => {
        await setWorkspaceContext(tx, workspaceId);
        const rows = await tx
          .select()
          .from(schema.sessionTable)
          .where(eq(schema.sessionTable.workspaceId, workspaceId))
          .orderBy(desc(schema.sessionTable.startedAt))
          .limit(limit)
          .offset(offset);

        return rows.map(mapRowToSession);
      });
    });
  }

  async pinSessionTurn(input: {
    sessionId: string;
    workspaceId: string;
    turnId?: string;
    turnIndex?: number;
    pinned: boolean;
  }): Promise<boolean> {
    const { sessionId, workspaceId, turnId, turnIndex, pinned } = input;
    // `!== undefined`, not truthiness: turn 0 is the first turn of every
    // session, and a `??`/`||` selector would silently fall through to the id
    // branch for it.
    const selector =
      turnId !== undefined
        ? eq(schema.sessionTurnTable.id, turnId)
        : turnIndex !== undefined
          ? eq(schema.sessionTurnTable.turnIndex, turnIndex)
          : undefined;
    if (selector === undefined) return false;

    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      const parentRows = await tx
        .select({
          status: schema.sessionTable.status,
          sourceHost: schema.sessionTable.sourceHost,
          closeKind: schema.sessionTable.closeKind,
          collapseLeaseOwner: schema.sessionTable.collapseLeaseOwner,
          collapseLeaseExpiresAt: schema.sessionTable.collapseLeaseExpiresAt,
        })
        .from(schema.sessionTable)
        .where(
          and(
            eq(schema.sessionTable.id, sessionId),
            eq(schema.sessionTable.workspaceId, workspaceId)
          )
        )
        .limit(1)
        .for("update");
      const parent = parentRows[0];
      if (!parent) return false;
      if (
        parent.sourceHost !== null &&
        !(
          parent.status === "active" ||
          (parent.status === "collapse_pending" &&
            parent.closeKind === "provisional" &&
            parent.collapseLeaseOwner === null &&
            parent.collapseLeaseExpiresAt === null)
        )
      ) {
        const error = new Error(`Session ${sessionId} is closed for writes.`) as Error & {
          code?: string;
        };
        error.code = "SESSION_CLOSED";
        throw error;
      }
      const rows = await tx
        .update(schema.sessionTurnTable)
        .set({ pinned })
        .where(
          and(
            selector,
            eq(schema.sessionTurnTable.sessionId, sessionId),
            eq(schema.sessionTurnTable.workspaceId, workspaceId)
          )
        )
        .returning({ id: schema.sessionTurnTable.id });
      return rows.length > 0;
    });
  }

  /**
   * flatten-legacy-dual-core Slice 3c pt.1 (PR10) — overwrite `mnemo_session.scratch`.
   * Returns false (no rows matched) when the session doesn't exist in this
   * workspace, so the route can map that to 404 — mirrors legacy
   * `CoreLike.replaceSessionScratch`'s boolean-found contract exactly.
   */
  async replaceSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const updated = await tx
        .update(schema.sessionTable)
        .set({ scratch: input.scratch, lastActivityAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(schema.sessionTable.id, input.sessionId),
            eq(schema.sessionTable.workspaceId, input.workspaceId),
            eq(schema.sessionTable.status, "active")
          )
        )
        .returning({ id: schema.sessionTable.id });
      return updated.length > 0;
    });
  }

  /**
   * flatten-legacy-dual-core Phase 7 — read-side twin of {@link replaceSessionScratch}.
   * Replaces the legacy `CoreLike.getSessionScratch` raw-SQL read (`factory.ts`) with
   * the same `mnemo_session.scratch` column read through the v3 RLS-scoped path.
   * Returns null when the session doesn't exist in this workspace.
   */
  async getSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<Record<string, unknown> | null> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, input.workspaceId);
      const rows = await tx
        .select({ scratch: schema.sessionTable.scratch })
        .from(schema.sessionTable)
        .where(
          and(
            eq(schema.sessionTable.id, input.sessionId),
            eq(schema.sessionTable.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!rows[0]) return null;
      return (rows[0].scratch as Record<string, unknown> | null) ?? {};
    });
  }

  /**
   * C5: persist the collapse summary (context_snapshot + fact_count) produced by
   * the collapse pipeline.  Without this, collapse.ts:577 silently drops the
   * summary because the Drizzle adapter lacked the method.
   */
  async updateSessionSummary(args: {
    sessionId: string;
    workspaceId: string;
    summary: Record<string, unknown>;
    factCount: number;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, args.workspaceId);
      await tx
        .update(schema.sessionTable)
        .set({ contextSnapshot: args.summary, factCount: args.factCount })
        .where(
          and(
            eq(schema.sessionTable.id, args.sessionId),
            eq(schema.sessionTable.workspaceId, args.workspaceId)
          )
        );
    });
  }

  /**
   * autonomous-memory Requirement 1/4 — merge-stamp `metadata.lastRecallAt`
   * on a session. Uses jsonb `||` merge (not a full column overwrite) so
   * this never clobbers other metadata keys a caller may have set. No-op
   * (no error, no row) when the session doesn't exist in this workspace —
   * a stale correlation id from a hook must never fail the recall call.
   */
  async recordSessionRecall(sessionId: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      await tx.execute(
        sql`UPDATE mnemosyne.mnemo_session
            SET metadata = metadata || jsonb_build_object('lastRecallAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`
      );
    });
  }

  /**
   * Writes `outcome_rating`, the column three consumers read and nobody wrote.
   * The values are constrained by `mnemo_session_outcome_rating_check` — the
   * port's union type is the same set, so an invalid value cannot reach here.
   */
  async recordSessionOutcome(
    sessionId: string,
    workspaceId: string,
    rating: "success" | "failure" | "neutral"
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);
      const rows = (await tx.execute(
        sql`UPDATE mnemosyne.mnemo_session
            SET outcome_rating = ${rating}
            WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
            RETURNING id`
      )) as unknown as Array<{ id: string }>;
      return rows.length > 0;
    });
  }
}
