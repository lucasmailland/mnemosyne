import { closeAt, dbNow } from "./_clock.js";
import {
  eq,
  and,
  gte,
  lte,
  or,
  gt,
  count,
  isNull,
  isNotNull,
  inArray,
  sql,
  desc,
  asc,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import * as schema from "../schema/index.js";
import { instrumentedQuery, mapRowToFact } from "./mappers.js";
import type { DrizzleClient, DekUnwrapper, DekProvisioner } from "./types.js";
import {
  decryptEncryptedField,
  encryptEncryptedField,
  encryptPiiColumns,
} from "../encryption/fact-cryptor.js";
import { resolveActorDek } from "../encryption/dek-resolver.js";
import { organicRecallLogRow } from "../recall-log-sql.js";
import type {
  MnemoFact,
  CreateFactInput,
  UpdateFactInput,
  MergeFactByTopicKeyInput,
  ReplaceFactInput,
  ReplaceFactResult,
  FindLiveFactByStatementInput,
  FactFilter,
  FactPageFilter,
  FactPage,
  FindContradictingFactsInput,
  ContradictingFact,
  PaginatedResult,
  PurgeFactsFilter,
  PurgeFactsResult,
  Sensitivity,
  WorkspaceVitals,
  AuditFeedFilter,
  AuditFeedEntry,
  AuditFeedStats,
  ResolveConflictInput,
  ResolveConflictResult,
  LookupQueryCacheInput,
  InsertQueryCacheInput,
} from "@mnemo-ai/types";

/** `Date | string | null` → ISO string, or null. Postgres drivers return
 * timestamptz columns as either shape depending on config. */
function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
import {
  SENSITIVITY_ORDER,
  tiersAtOrBelow,
  tallyAuditFeedStats,
  assertSupportedEmbedDimension,
  FactRevisionConflictError,
} from "@mnemo-ai/types";
import { factStatementHash, scopeRefValues } from "@mnemo-ai/types";
import { ftsMatchesEither, ftsRankCdEither, ftsTermLexemes } from "./_fts-config.js";
import { recallContentTerms } from "./RecallRepository.js";
import { sameWidthAsQuery } from "./_embedding-width.js";
import { DEFAULT_CONTRADICTION_MIN_SIMILARITY, isSpecificFactSubject } from "@mnemo-ai/types";

/**
 * P130 — the row shape both contradiction arms return. Extracted so the
 * semantic and lexical queries cannot drift into mapping the same columns two
 * different ways.
 */
interface ContradictionRow {
  id: string;
  actor_id: string | null;
  subject: string;
  statement: string;
  confidence: string | number | null;
  attribution: string;
  worth: string | number | null;
  valid_from: string | Date;
  similarity?: string | number | null;
}

/** The adapter opens `statement`/`subject` with the row actor's DEK, then drops `actorId`. */
type ContradictionCandidate = ContradictingFact & { actorId: string | null };

function toContradictingFact(r: ContradictionRow, cosine = false): ContradictionCandidate {
  // On the semantic arm `similarity` is the cosine for vector-matched rows and
  // 0 for the lexical fallback rows (whose cosine is unknown, never 0: a
  // vector match clears the floor). On the no-embedding arm it is an FTS rank.
  const similarity = Number(r.similarity ?? 0);
  return {
    id: r.id,
    actorId: r.actor_id,
    subject: r.subject,
    statement: r.statement,
    confidence: typeof r.confidence === "number" ? r.confidence : Number(r.confidence ?? 0.7),
    // `worth` is a GENERATED NUMERIC column — pg returns it as a string.
    worth: typeof r.worth === "number" ? r.worth : Number(r.worth ?? 0.5),
    attribution: r.attribution as ContradictingFact["attribution"],
    validFrom: r.valid_from instanceof Date ? r.valid_from : new Date(r.valid_from),
    ...(cosine && similarity > 0 ? { similarity } : {}),
  };
}

type FactTx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

async function setWorkspaceContext(tx: FactTx, workspaceId: string): Promise<void> {
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

/**
 * RECALL-7 — the relaxed full-text predicate for a question that matched
 * nothing strictly: rows matching at least two of its content terms (stopwords
 * dropped, terms that stem to an already-counted lexeme in either language
 * skipped). Mirrors the `relaxedOnEmpty` arm of `RecallRepository.ftsCandidates`.
 * `null` when the question has fewer than three content terms — then there is
 * nothing to relax and the strict predicate stands.
 */
async function relaxedFtsPredicate(tx: FactTx, q: string): Promise<SQL | null> {
  const normalizedTerms = recallContentTerms([q]);
  if (normalizedTerms.length < 3) return null;
  const lexemesSql = ftsTermLexemes(sql`term`);
  const lexemes = (await tx.execute(sql`
    SELECT term, ${lexemesSql.en} AS en, ${lexemesSql.es} AS es
    FROM (VALUES ${sql.join(
      normalizedTerms.map((term) => sql`(${term})`),
      sql`, `
    )}) AS terms(term)
  `)) as unknown as Array<{ term: string; en: string; es: string }>;
  const seenEn = new Set<string>();
  const seenEs = new Set<string>();
  const contentTerms = lexemes.flatMap(({ term, en, es }) => {
    if (!en && !es) return [];
    if ((en && seenEn.has(en)) || (es && seenEs.has(es))) return [];
    if (en) seenEn.add(en);
    if (es) seenEs.add(es);
    return [term];
  });
  if (contentTerms.length < 3) return null;
  const en = sql`${schema.factTable.textLemmatized}`;
  const es = sql`${schema.factTable.textLemmatizedEs}`;
  const matches = contentTerms.map((term) => ftsMatchesEither(en, es, term));
  const matched = sql.join(
    matches.map((match) => sql`CASE WHEN ${match} THEN 1 ELSE 0 END`),
    sql` + `
  );
  return sql`(${or(...matches)!} AND (${matched}) >= 2)`;
}

/** The `v` of a timestamp cursor, as `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` renders it. */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * APP-073: no MNEMO_MASTER_KEY, so no DEK can be unwrapped. Coded like the
 * no-DEK-yet refusal (encryption/dek-resolver.ts) so the HTTP layer answers 422
 * with the reason instead of 500.
 */
function noMasterKey(detail: string): Error {
  return Object.assign(new Error(`C1 fail-closed: ${detail} — is MNEMO_MASTER_KEY set?`), {
    code: "encryption_not_configured" as const,
  });
}

export class FactRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient,
    private readonly dekUnwrapper?: DekUnwrapper,
    private readonly dekProvisioner?: DekProvisioner
  ) {}

  async createFact(input: CreateFactInput): Promise<MnemoFact> {
    // ── P117: refuse an unsupported vector width AT WRITE TIME ────────────────
    // Before the transaction, before anything is persisted, before the outbox
    // entry that would replay the same bad vector into the index.
    //
    // `mnemo_fact.embedding` is an unconstrained `halfvec` on purpose — the
    // schema supports several widths — but "several" is not "any": only the
    // widths with a table and an index behind them
    // (SUPPORTED_EMBED_DIMENSIONS). Nothing enforced that, so a 768-dim vector
    // was accepted here and only rejected three operations later, by
    // archiveFact copying the row into a narrower column. The fact could be
    // created and never forgotten, and the error named neither the fact nor the
    // setting that caused it.
    //
    // This is the last line of defence, not the first: boot rejects a bad
    // MNEMO_EMBED_DIMENSIONS and the embed adapter rejects a model that
    // disagrees with it. This one also covers vectors that never went through
    // either — a caller-supplied embedding, a federation sync, a backfill
    // script — which is exactly the class the other two cannot see.
    if (input.embedding && input.embedding.length > 0) {
      assertSupportedEmbedDimension(input.embedding.length, "createFact");
    }

    return instrumentedQuery("write", () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

        // C1/C9: PII column encryption, FAIL-CLOSED for confidential/restricted.
        const sensitivity = input.sensitivity ?? "internal";
        const { statement, subject } = await this.sealForWrite(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          userId: input.userId,
          sensitivity,
          statement: input.statement,
          subject: input.subject,
        });

        const id = crypto.randomUUID();
        const rows = await tx
          .insert(schema.factTable)
          .values({
            id,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            actorId: input.actorId,
            userId: input.userId,
            actorType: input.actorType,
            scope: input.scope,
            scopeRef: input.scopeRef,
            // Default to workspace-level ownership when not explicitly set.
            scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
            statement,
            subject,
            kind: input.kind,
            confidence: input.confidence ?? 0.7,
            relevance: input.relevance ?? 1.0,
            attribution: input.attribution ?? input.attributedTo ?? "inferred",
            attributedTo: input.attributedTo,
            sourceMessageIds: input.sourceMessageIds ?? [],
            sessionId: input.sessionId,
            extractionSource: input.extractionSource,
            topicKey: input.topicKey,
            entityId: input.entityId,
            episodeId: input.episodeId,
            sensitivity: input.sensitivity ?? "internal",
            embeddingModel: input.embeddingModel ?? null,
            validFrom: input.validFrom,
            validTo: input.validTo,
            // PRIM-15: restore paths only; undefined keeps the column defaults.
            status: input.status,
            pinned: input.pinned,
            // B6.35: only the consolidation repository may attach the pending
            // marker — strip any caller-supplied forgery at creation time.
            metadata: (() => {
              const { __mnemoConsolidationPending: _pending, ...safe } = (input.metadata ??
                {}) as Record<string, unknown>;
              return safe;
            })(),
          })
          .returning();

        // Outbox: signal the vector-embedding worker (CRIT-05). Prefer the
        // authoritative vector-form payload when the caller supplied a precomputed
        // embedding — the worker re-applies that exact vector instead of embedding
        // the statement itself, which would clobber a host-supplied vector (the API
        // contract is "server skips its own embed pass when a vector is supplied").
        // Without an embedding, fall back to the text-form payload the worker embeds.
        //
        // `indexLsh` rides on this same entry when the caller has no embedding of
        // its own (managed collapse): the worker embeds, upserts the vector, then
        // persists the LSH bands, and only then acknowledges — so a band failure
        // retries the whole job instead of leaving a vector without a signature.
        // mnemo_outbox is INSERT-only for mnemo_app_role, so both annotations are
        // written here with the row and never patched afterwards.
        const revision = input.vectorJob?.revision ?? 1;
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new Error("createFact: vectorJob.revision must be a positive integer");
        const vectorJobAnnotations = {
          revision,
          ...(input.vectorJob?.indexLsh === true ? { indexLsh: true } : {}),
          ...(input.vectorJob?.operationId !== undefined
            ? { operationId: input.vectorJob.operationId }
            : {}),
        };
        // CHAOS-5 — with no vector, the text-form job carries `statement`,
        // which for confidential+ tiers is ciphertext by now: embedding it
        // yields a meaningless vector and ships ciphertext to the provider.
        // Such a row stays unembedded (it sits above the default read ceiling
        // anyway), exactly as supersedeActiveFact already treats its successors.
        const hasVector = Boolean(input.embedding && input.embedding.length > 0);
        if (!hasVector && SENSITIVITY_ORDER[sensitivity] >= SENSITIVITY_ORDER.confidential) {
          return mapRowToFact(rows[0]!);
        }
        await tx.insert(schema.outboxTable).values({
          workspaceId: input.workspaceId,
          eventType: "vector_upsert",
          payload:
            input.embedding && input.embedding.length > 0
              ? {
                  id,
                  kind: "fact",
                  vector: input.embedding,
                  model: input.embeddingModel ?? "text-embedding-3-small",
                  dimensions: input.embedding.length,
                  ...vectorJobAnnotations,
                }
              : {
                  id,
                  kind: "fact",
                  text: statement,
                  model: input.embeddingModel ?? "text-embedding-3-small",
                  ...vectorJobAnnotations,
                },
        });

        return mapRowToFact(rows[0]!);
      })
    );
  }

  /**
   * C1/C9 — the columns a new row stores: encrypted under the writing actor's
   * DEK for confidential/restricted, as given otherwise. FAIL-CLOSED: never
   * stores plaintext at those tiers. Provisions the actor's DEK (and persists
   * its wrapped form) if none exists yet.
   */
  private async sealForWrite(
    tx: FactTx,
    input: {
      workspaceId: string;
      actorId?: string | undefined;
      userId?: string | null | undefined;
      sensitivity: Sensitivity;
      statement: string;
      subject: string;
    }
  ): Promise<{ statement: string; subject: string }> {
    let { statement, subject } = input;
    const { sensitivity } = input;
    if (SENSITIVITY_ORDER[sensitivity] >= SENSITIVITY_ORDER.confidential) {
      if (!input.actorId) {
        throw new Error(
          `C1 fail-closed: ${sensitivity} fact requires an actorId to derive its DEK; refusing to store plaintext.`
        );
      }
      const dekRows = await tx
        .select({ encryptedKey: schema.actorDekTable.encryptedKey })
        .from(schema.actorDekTable)
        .where(
          and(
            eq(schema.actorDekTable.workspaceId, input.workspaceId),
            eq(schema.actorDekTable.actorId, input.actorId),
            eq(schema.actorDekTable.status, "active")
          )
        )
        .limit(1);
      // Slice 1 pt.2 (flatten-legacy-dual-core): mnemo_actor_dek.encrypted_key
      // is physically bytea (schema/infrastructure.ts fix) — the driver
      // returns a Buffer/Uint8Array, base64-encode it to the wrapped-key
      // string shape resolveActorDek expects, same normalization already
      // applied at this repository's replaceFact/updateFact DEK reads below.
      const rawExistingWrapped = dekRows[0]?.encryptedKey;
      const existingWrapped =
        rawExistingWrapped instanceof Uint8Array
          ? Buffer.from(rawExistingWrapped).toString("base64")
          : (rawExistingWrapped ?? null);

      let provisionedDek: Buffer | null = null;
      if (!existingWrapped && this.dekProvisioner) {
        const { dek, wrapped } = this.dekProvisioner(input.workspaceId, input.actorId);
        // user_id is stamped at provisioning time only (never re-derived later) —
        // an actor's user_id binding is fixed for the credential's whole lifetime,
        // so the DEK's owning person (if any) is known once and for good here.
        // NULL for service/agent/system-authored DEKs — correct, not a gap: there
        // is no person to hold erasure rights over that data. See destroyUserDeks.
        await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_actor_dek (id, workspace_id, actor_id, user_id, encrypted_key, status)
        VALUES (${`dek-${input.workspaceId}-${input.actorId}`}, ${input.workspaceId}, ${input.actorId},
                ${input.userId ?? null}, decode(${wrapped}, 'base64'), 'active')
        ON CONFLICT (workspace_id, actor_id) DO NOTHING
      `);
        provisionedDek = dek;
      }

      const { dek } = resolveActorDek({
        sensitivity,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        existingWrapped,
        unwrap: (w) => {
          if (!this.dekUnwrapper) throw noMasterKey("a DEK exists but no unwrapper is configured");
          return this.dekUnwrapper(input.workspaceId, input.actorId!, w);
        },
        provision: () => provisionedDek,
      });

      if (dek) {
        const dekId = `dek-${input.workspaceId}-${input.actorId}`;
        const encrypted = encryptPiiColumns(dek, dekId, { statement, subject, sensitivity });
        statement = encrypted.statement;
        subject = encrypted.subject;
      }
    }
    return { statement, subject };
  }

  /**
   * The unwrapped DEK of the actor that wrote an existing confidential+ row —
   * the key every later rewrite of that row must use, since reads decrypt
   * with the row's `actor_id`. FAIL-CLOSED when it cannot be had.
   */
  private async rowActorDek(
    tx: FactTx,
    workspaceId: string,
    actorId: string | null,
    what: string
  ): Promise<Buffer> {
    if (!this.dekUnwrapper) throw noMasterKey(`${what} requires its actor DEK`);
    if (!actorId) throw new Error(`C1 fail-closed: ${what} requires its actor DEK`);
    const dekRows = await tx
      .select({ encryptedKey: schema.actorDekTable.encryptedKey })
      .from(schema.actorDekTable)
      .where(
        and(
          eq(schema.actorDekTable.workspaceId, workspaceId),
          eq(schema.actorDekTable.actorId, actorId),
          eq(schema.actorDekTable.status, "active")
        )
      )
      .limit(1);
    const wrappedValue = dekRows[0]?.encryptedKey as unknown;
    const wrapped =
      wrappedValue instanceof Uint8Array
        ? Buffer.from(wrappedValue).toString("base64")
        : typeof wrappedValue === "string"
          ? wrappedValue
          : null;
    if (!wrapped) throw new Error("C1 fail-closed: source actor DEK is missing");
    return this.dekUnwrapper(workspaceId, actorId, wrapped);
  }

  /**
   * CHAOS-7 — the live row `uniq_mnemo_fact_dedup` would collide with. Same
   * expression as the index (`COALESCE(scope_ref, '')`, `md5(statement)`), so
   * it finds exactly the row that won a concurrent identical insert.
   */
  async findLiveFactByStatement(input: FindLiveFactByStatementInput): Promise<MnemoFact | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.factTable)
        .where(
          and(
            eq(schema.factTable.workspaceId, input.workspaceId),
            eq(schema.factTable.scope, input.scope),
            sql`COALESCE(${schema.factTable.scopeRef}, '') = ${input.scopeRef ?? ""}`,
            eq(schema.factTable.subject, input.subject),
            sql`md5(${schema.factTable.statement}) = md5(${input.statement})`,
            // APP-009: owner and tier are part of the fact's identity when the caller names them.
            ...(input.scopeOwner !== undefined
              ? [
                  sql`COALESCE(${schema.factTable.scopeOwner}, ${`workspace:${input.workspaceId}`}) = ${input.scopeOwner}`,
                ]
              : []),
            ...(input.sensitivity !== undefined
              ? [eq(schema.factTable.sensitivity, input.sensitivity)]
              : []),
            eq(schema.factTable.status, "active"),
            isNull(schema.factTable.validTo)
          )
        )
        .limit(1);
      return rows[0] ? mapRowToFact(rows[0]) : null;
    });
  }

  /**
   * PRIM-15 — the fact an earlier POST /import created from export row
   * `importedId`, in any status. RLS-scoped like every fact read.
   */
  async findFactByImportedId(workspaceId: string, importedId: string): Promise<MnemoFact | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.factTable)
        .where(
          and(
            eq(schema.factTable.workspaceId, workspaceId),
            sql`${schema.factTable.metadata}->>'importedId' = ${importedId}`
          )
        )
        .limit(1);
      return rows[0] ? mapRowToFact(rows[0]) : null;
    });
  }

  async getFact(id: string, workspaceId: string): Promise<MnemoFact | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select()
        .from(schema.factTable)
        .where(and(eq(schema.factTable.id, id), eq(schema.factTable.workspaceId, workspaceId)))
        .limit(1);
      return rows[0] ? mapRowToFact(rows[0]) : null;
    });
  }

  async updateFact(
    id: string,
    workspaceId: string,
    input: UpdateFactInput
  ): Promise<MnemoFact | null> {
    return this.db.transaction(async (tx) => {
      await setWorkspaceContext(tx, workspaceId);

      // CHAOS-8 — locked, not merely read. Every update derives
      // `revisionCount + 1` (and `append` derives its text) from this row; read
      // without a lock, five concurrent PATCHes on revision 1 all wrote
      // revision 2 and four of them vanished without a trace.
      const existing = await tx
        .select()
        .from(schema.factTable)
        .where(and(eq(schema.factTable.id, id), eq(schema.factTable.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!existing[0]) return null;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing[0].revisionCount
      ) {
        throw new FactRevisionConflictError(id, input.expectedRevision, existing[0].revisionCount);
      }

      const updates: Partial<schema.InsertFact> = {};
      if (input.subject !== undefined) updates.subject = input.subject;
      if (input.kind !== undefined) updates.kind = input.kind;
      if (input.statement !== undefined) updates.statement = input.statement;
      if (input.confidence !== undefined) updates.confidence = input.confidence;
      if (input.relevance !== undefined) updates.relevance = input.relevance;
      if (input.status !== undefined) updates.status = input.status;
      if (input.pinned !== undefined) updates.pinned = input.pinned;
      if (input.validTo !== undefined)
        updates.validTo = (
          input.validTo ? closeAt(input.validTo, schema.factTable.validFrom) : null
        ) as Date | null;
      if (input.metadata !== undefined) {
        // B6.35: a caller may never forge the pending-consolidation marker via a
        // metadata update. Strip it, then atomically reattach the genuine current
        // value from the DB row so a legitimate marker is preserved.
        const { __mnemoConsolidationPending: _pending, ...safe } = input.metadata as Record<
          string,
          unknown
        >;
        const currentMarker = (existing[0].metadata as Record<string, unknown> | null)
          ?.__mnemoConsolidationPending;
        updates.metadata =
          currentMarker !== undefined
            ? { ...safe, __mnemoConsolidationPending: currentMarker }
            : safe;
      }
      updates.updatedAt = new Date();
      updates.revisionCount = existing[0].revisionCount + 1;

      // C1 — a confidential+ row's new text goes in under the DEK of the actor
      // that wrote the row (reads open it with `actor_id`), never as plaintext;
      // and the change and fingerprint checks below compare plaintext with
      // plaintext, not with the stored ciphertext.
      let priorStatement = existing[0].statement;
      let priorSubject = existing[0].subject;
      if (
        SENSITIVITY_ORDER[existing[0].sensitivity as Sensitivity] >=
          SENSITIVITY_ORDER.confidential &&
        (input.statement !== undefined || input.subject !== undefined)
      ) {
        const dek = await this.rowActorDek(
          tx,
          workspaceId,
          existing[0].actorId,
          `${existing[0].sensitivity} fact update`
        );
        const dekId = `dek-${workspaceId}-${existing[0].actorId}`;
        priorStatement = decryptEncryptedField(dek, priorStatement);
        priorSubject = decryptEncryptedField(dek, priorSubject);
        if (input.statement !== undefined)
          updates.statement = encryptEncryptedField(dek, dekId, input.statement);
        if (input.subject !== undefined)
          updates.subject = encryptEncryptedField(dek, dekId, input.subject);
      }

      // P111 — the text changed, so the stored vector now describes something
      // that is no longer there.
      //
      // This is the gap `embedding_stale` exists for, and it had no writer.
      // `markEmbeddingsStale` marks in bulk by MODEL, which turns out to be
      // redundant: both readers (`listStaleEmbeddings`,
      // `hasActiveEmbeddingMigration`) already OR `embedding_model != current`,
      // so a model swap is picked up with or without the flag. What neither
      // catches is THIS — an in-place edit under the SAME model. The row keeps
      // its `embedding_model`, the daily migration never looks at it, and the
      // fact is ranked by the meaning of its previous text forever.
      //
      // Live path, not hypothetical: `memory_self_edit(action:"append")` does
      // `updateFact({ statement: existing + "\n" + content })` and nothing
      // re-embeds afterwards (`self-edit.ts` enqueues no vector_upsert).
      //
      // Set here rather than at the call sites because it is a property of the
      // WRITE, not of any one caller: it lands in the same UPDATE, so the row
      // can never be committed with new text and an unflagged old vector, and
      // it covers callers that do not exist yet.
      const statementChanged = input.statement !== undefined && input.statement !== priorStatement;
      // PRIM-4 — a restore reopens a closed fact whose vector the forget's
      // `vector_delete` cleared (or is about to). Same treatment as new text.
      const reopened =
        (input.validTo === null && existing[0].validTo != null) ||
        (input.status === "active" && existing[0].status !== "active");
      if (statementChanged || reopened) {
        updates.embeddingStale = true;
      }

      // The UPDATE below re-states these guards; checking them here first, on
      // the locked row, is what lets the history row be written only for an
      // update that will happen.
      const prior = existing[0];
      if (input.statement !== undefined && (prior.status !== "active" || prior.validTo != null)) {
        return null;
      }
      if (
        input.pinned !== undefined &&
        Object.prototype.hasOwnProperty.call(
          (prior.metadata ?? {}) as Record<string, unknown>,
          "__mnemoConsolidationPending"
        )
      ) {
        return null;
      }

      // CHAOS-8 — the revision this update replaces, kept (migration 0044).
      // API.md §2.3 promised "the original is preserved"; an in-place UPDATE
      // preserved nothing. Copied from the row itself so timestamps keep their
      // microseconds and stored values stay as stored (ciphertext included).
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_fact_revision (
          fact_id, revision, workspace_id, statement, subject, kind, confidence,
          relevance, pinned, status, sensitivity, metadata, valid_from, valid_to,
          revision_updated_at
        )
        SELECT id, revision_count, workspace_id, statement, subject, kind, confidence,
          relevance, pinned, status, sensitivity, metadata, valid_from, valid_to, updated_at
        FROM mnemosyne.mnemo_fact
        WHERE id = ${id} AND workspace_id = ${workspaceId}
      `);

      const rows = await tx
        .update(schema.factTable)
        .set(updates)
        .where(
          and(
            eq(schema.factTable.id, id),
            eq(schema.factTable.workspaceId, workspaceId),
            ...(input.statement !== undefined
              ? [eq(schema.factTable.status, "active"), isNull(schema.factTable.validTo)]
              : []),
            // B6.35: `pinned` is a consolidation-gate eligibility input — a pinned
            // flip on a pending row is refused (row won't match, returns null).
            ...(input.pinned !== undefined
              ? [
                  sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`,
                ]
              : [])
          )
        )
        .returning();

      // P126 — the dedupe fingerprint is derived from the statement, so an
      // in-place edit leaves it pointing at text this row no longer has.
      //
      // The consequence is not a stale index, it is a LOST WRITE. `remember()`
      // consults `mnemo_fact_hash` before inserting (P85.3/P109): a later write
      // of the ORIGINAL text matches the orphaned fingerprint, gets handed this
      // fact's id, and stores nothing. The caller receives 201 with a real id
      // whose row says something else — `memory_fact` resolves it, `memory_forget`
      // closes it, and everything reads as coherent until someone compares the
      // text. Same family as P74, and harder to see, because P74 at least
      // returned an id that matched no row at all.
      //
      // Deleted rather than recomputed: the fingerprint reappears by itself on
      // the next write of that text, and an ABSENT one costs a possible
      // duplicate while a LYING one costs a write. `seenCount` goes with it,
      // which is correct — it counts how often that TEXT was said, and the text
      // is what just stopped existing.
      //
      // Sibling of the `embedding_stale` line above: same edit, other derived
      // artifact. `text_lemmatized` needs nothing here — it is
      // GENERATED ALWAYS … STORED, so Postgres recomputes it in this very
      // UPDATE.
      if (statementChanged && rows[0]) {
        const previousHash = factStatementHash(priorStatement, priorSubject);
        await tx
          .delete(schema.factHashTable)
          .where(
            and(
              eq(schema.factHashTable.workspaceId, workspaceId),
              eq(schema.factHashTable.statementHash, previousHash)
            )
          );
      }

      const updated = rows[0];
      if (!updated) return null;

      // PRIM-4 — new text, or a restored fact, needs a vector. `embedding_stale`
      // (above) only hid the old one: nothing re-embedded until the daily
      // migration cron, and a restored row (stale = false, model stamp intact,
      // vector NULL) never matched even that. A revision-tagged text-form job,
      // in this transaction, so the row and its job commit together. Skipped
      // for confidential+ rows like supersedeActiveFact does: their column holds
      // ciphertext, which must neither be embedded nor leave the database.
      //
      // Review round — the job is fenced on the revision it was queued for, and
      // EVERY update bumps the revision. A pin or a confidence change landing
      // before the worker made the pending job a no-op, and the fact stayed
      // without a current vector. So any update of a row whose vector is still
      // pending (stale, or none yet — a restore, an edit, a deferred first
      // embedding) re-queues it for the new revision. `indexLsh` keeps the LSH
      // bands in step with the text the vector is computed from.
      const vectorPending = prior.embeddingStale || prior.embedding == null;
      if (
        (statementChanged || reopened || vectorPending) &&
        updated.status === "active" &&
        updated.validTo == null &&
        SENSITIVITY_ORDER[updated.sensitivity as Sensitivity] < SENSITIVITY_ORDER.confidential
      ) {
        await tx.insert(schema.outboxTable).values([
          {
            workspaceId,
            eventType: "vector_upsert",
            payload: {
              id,
              kind: "fact",
              text: updated.statement,
              revision: updated.revisionCount,
              indexLsh: true,
            },
          },
          ...(statementChanged || reopened
            ? [
                {
                  workspaceId,
                  eventType: "cache_bust" as const,
                  payload: { pattern: `mnemo:${workspaceId}:*` },
                },
              ]
            : []),
        ]);
      }

      return mapRowToFact(updated);
    });
  }

  async mergeFactByTopicKey(input: MergeFactByTopicKeyInput): Promise<MnemoFact | null> {
    return instrumentedQuery("write", () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);

        // Lock before the lookup: a concurrent merge retires the row we would
        // wait on, so SELECT FOR UPDATE can return no row under READ COMMITTED.
        // A separate lock statement gives the lookup a fresh snapshot of its successor.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(jsonb_build_array(${input.workspaceId}::text, ${input.topicKey}::text)::text, 0)
          )
        `);

        // P76: the full row, not three columns. A topic-key merge is now a
        // bitemporal supersede, and a successor has to inherit every column of
        // its predecessor — scope, pinned, worth, provenance, episode link.
        //
        // The pending-consolidation guard moves into this SELECT (B6.35): it
        // used to sit in the UPDATE's WHERE, and with no UPDATE left it would
        // have quietly disappeared and let a merge supersede a row that a
        // consolidation rollback still needs.
        const sourceRows = await tx
          .select()
          .from(schema.factTable)
          .where(
            and(
              eq(schema.factTable.workspaceId, input.workspaceId),
              eq(schema.factTable.topicKey, input.topicKey),
              eq(schema.factTable.status, "active"),
              isNull(schema.factTable.validTo),
              sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
            )
          )
          .limit(1)
          .for("update");
        const source = sourceRows[0];
        if (!source) return null;

        let storedStatement = input.statement;
        let hashSubject = source.subject;
        if (
          SENSITIVITY_ORDER[source.sensitivity as Sensitivity] >= SENSITIVITY_ORDER.confidential
        ) {
          const dek = await this.rowActorDek(
            tx,
            input.workspaceId,
            source.actorId,
            `${source.sensitivity} topic-key update`
          );
          // The content hash is over plaintext (remember() computes it before
          // the write), so the subject it pairs with must be plaintext too.
          hashSubject = decryptEncryptedField(dek, source.subject);
          storedStatement = encryptEncryptedField(
            dek,
            `dek-${input.workspaceId}-${source.actorId}`,
            input.statement
          );
        }

        // Metadata and tags merge in TS now, not in SQL. The old version built
        // the union with jsonb_set + jsonb_agg(DISTINCT ...) against the row it
        // was overwriting; a successor INSERT needs the merged value up front.
        // Same semantics: incoming keys win, tag lists union and de-duplicate.
        const incoming = (input.metadata ?? {}) as Record<string, unknown>;
        const { tags: incomingTags, ...incomingRest } = incoming;
        const sourceMeta = (source.metadata ?? {}) as Record<string, unknown>;
        const {
          __mnemoConsolidationPending: _pending,
          tags: sourceTags,
          ...sourceRest
        } = sourceMeta;
        const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
        const mergedTags = [
          ...new Set([...asArray(sourceTags), ...asArray(incomingTags), ...(input.tags ?? [])]),
        ];
        const metadata: Record<string, unknown> = {
          ...sourceRest,
          ...incomingRest,
          tags: mergedTags,
        };

        const result = await this.supersedeActiveFact(tx, source, {
          workspaceId: input.workspaceId,
          statement: input.statement,
          storedStatement,
          hashSubject,
          metadata,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.extractionSource !== undefined
            ? { extractionSource: input.extractionSource }
            : {}),
          ...(input.embedding && input.embedding.length > 0
            ? { embedding: input.embedding, embeddingModel: input.embeddingModel }
            : {}),
        });
        return result ? result.replacement : null;
      })
    );
  }

  /**
   * P76 — the one bitemporal supersede, shared by `replaceFact` and
   * `mergeFactByTopicKey`.
   *
   * Closes `source` (status `forgotten`, `valid_to = now`), inserts a successor
   * carrying a new id and `revisionCount + 1`, links the two with a
   * `supersedes` relation, and does the derived-state work that has to travel
   * with them: re-point the content hash, drop the stale LSH bands, bust the
   * query cache, and enqueue `vector_delete` for the old row plus
   * `vector_upsert` for the new one.
   *
   * Extracted rather than copied. `mergeFactByTopicKey` used to do a plain
   * in-place UPDATE of `statement` — no interval close, no successor, no
   * `supersedes`, and an audit entry that said `create`. That is overwrite-
   * without-history: the exact behaviour this project criticises in Engram, in
   * the one place we also did it, on `topicKey`, which the SKILL.md recommends
   * as THE idempotent update path. So it hit the facts that get corrected most.
   *
   * Duplicating ~150 lines to fix it would have left two bitemporal
   * implementations to keep in step, which is how the defects this session has
   * been closing get made.
   */
  private async supersedeActiveFact(
    tx: FactTx,
    source: typeof schema.factTable.$inferSelect,
    opts: {
      workspaceId: string;
      /** Plaintext — used for the content hash and the outbox text payload. */
      statement: string;
      /** What actually goes in the column: encrypted for confidential+ tiers. */
      storedStatement: string;
      /** Plaintext subject the hash is computed over. */
      hashSubject: string;
      agentId?: string | undefined;
      /** Successor metadata. Omitted → inherit the source's, minus the pending marker. */
      metadata?: Record<string, unknown>;
      /**
       * The session the new statement came from. Given → the successor takes
       * it and drops the inherited episode link (a new session's collapse
       * fills it). Omitted → session and episode are inherited.
       */
      sessionId?: string;
      /** Omitted → inherited. */
      extractionSource?: string;
      /** Plaintext-derived vector for a confidential+ successor (see below). */
      embedding?: number[];
      embeddingModel?: string | undefined;
    }
  ): Promise<ReplaceFactResult | null> {
    // A transaction that waited on a lock can start before the source row's
    // valid_from (the source may be a successor committed while we waited), so
    // transaction_timestamp() alone would close it with valid_to < valid_from.
    // Read as text to keep microsecond precision a JS Date would drop.
    const [clock] = await tx.execute<{ ts: string }>(sql`
      SELECT GREATEST(transaction_timestamp(), valid_from)::text AS ts
      FROM mnemosyne.mnemo_fact
      WHERE id = ${source.id} AND workspace_id = ${opts.workspaceId}
    `);
    const now = clock ? sql<Date>`${clock.ts}::timestamptz` : sql<Date>`transaction_timestamp()`;
    const closedRows = await tx
      .update(schema.factTable)
      .set({ status: "forgotten", validTo: now, updatedAt: now })
      .where(
        and(
          eq(schema.factTable.id, source.id),
          eq(schema.factTable.workspaceId, opts.workspaceId),
          eq(schema.factTable.status, "active"),
          isNull(schema.factTable.validTo),
          // B6.35, restated here on purpose. Both callers already exclude
          // pending rows in their SELECT ... FOR UPDATE, so this is redundant
          // today — and it is the redundancy that matters: this is now a SHARED
          // entry point, and "every future caller remembers to filter" is
          // exactly the assumption that keeps failing. Self-guarding costs one
          // predicate on a row already locked.
          sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
        )
      )
      .returning();
    if (!closedRows[0]) return null;

    const replacementId = crypto.randomUUID();
    const replacementRows = await tx
      .insert(schema.factTable)
      .values({
        id: replacementId,
        workspaceId: source.workspaceId,
        agentId: opts.agentId ?? source.agentId,
        actorId: source.actorId,
        userId: source.userId,
        actorType: source.actorType,
        scope: source.scope,
        scopeRef: source.scopeRef,
        scopeOwner: source.scopeOwner,
        statement: opts.storedStatement,
        subject: source.subject,
        kind: source.kind,
        confidence: source.confidence,
        relevance: source.relevance,
        hitCount: source.hitCount,
        lastRecalledAt: source.lastRecalledAt,
        worthSuccess: source.worthSuccess,
        worthFailure: source.worthFailure,
        worthAlpha: source.worthAlpha,
        worthBeta: source.worthBeta,
        memoryType: source.memoryType,
        memoryStrength: source.memoryStrength,
        memoryStability: source.memoryStability,
        lastStrengthUpdate: source.lastStrengthUpdate,
        attribution: source.attribution,
        attributedTo: source.attributedTo,
        sourceMessageIds: source.sourceMessageIds,
        sessionId: opts.sessionId ?? source.sessionId,
        extractionSource: opts.extractionSource ?? source.extractionSource,
        topicKey: source.topicKey,
        revisionCount: source.revisionCount + 1,
        protocolVersion: source.protocolVersion,
        entityId: source.entityId,
        episodeId: opts.sessionId !== undefined ? null : source.episodeId,
        status: "active",
        pinned: source.pinned,
        canonical: source.canonical,
        sensitivity: source.sensitivity,
        validFrom: now,
        validTo: null,
        embedding: null,
        embeddingModel: null,
        embeddingStale: true,
        createdAt: now,
        updatedAt: now,
        // B6.35: a successor is a fresh fact — never inherit a pending marker.
        metadata:
          opts.metadata ??
          (() => {
            const { __mnemoConsolidationPending: _pending, ...safe } = (source.metadata ??
              {}) as Record<string, unknown>;
            return safe;
          })(),
      })
      .returning();
    const replacementRow = replacementRows[0];
    if (!replacementRow) throw new Error("replaceFact: successor INSERT returned no row");

    await tx.insert(schema.relationTable).values({
      id: crypto.randomUUID(),
      workspaceId: opts.workspaceId,
      sourceKind: "fact",
      sourceId: replacementId,
      targetKind: "fact",
      targetId: source.id,
      relation: "supersedes",
      hebbianWeight: 1,
      validFrom: now,
      createdAt: now,
      updatedAt: now,
    });

    const statementHash = factStatementHash(opts.statement, opts.hashSubject);
    await tx
      .insert(schema.factHashTable)
      .values({
        workspaceId: opts.workspaceId,
        statementHash,
        factId: replacementId,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.factHashTable.workspaceId, schema.factHashTable.statementHash],
        set: {
          factId: replacementId,
          lastSeenAt: now,
          seenCount: sql`${schema.factHashTable.seenCount} + 1`,
        },
      });

    await tx
      .delete(schema.factLshTable)
      .where(
        and(
          eq(schema.factLshTable.workspaceId, opts.workspaceId),
          eq(schema.factLshTable.factId, source.id)
        )
      );
    await tx.execute(sql`
      DELETE FROM mnemosyne.mnemo_query_cache
      WHERE workspace_id = ${opts.workspaceId}
    `);

    const outboxValues: schema.InsertOutbox[] = [
      {
        workspaceId: opts.workspaceId,
        eventType: "vector_delete",
        payload: { id: source.id, kind: "fact" },
      },
      {
        workspaceId: opts.workspaceId,
        eventType: "cache_bust",
        payload: { pattern: `mnemo:${opts.workspaceId}:*` },
      },
    ];
    if (SENSITIVITY_ORDER[source.sensitivity as Sensitivity] < SENSITIVITY_ORDER.confidential) {
      outboxValues.push({
        workspaceId: opts.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id: replacementId,
          kind: "fact",
          text: opts.statement,
          revision: replacementRow.revisionCount,
        },
      });
    } else if (opts.embedding) {
      // Confidential+: the text-form job would embed ciphertext (and ship it
      // to the provider), so only a vector the caller computed from the
      // plaintext keeps the successor in semantic recall.
      assertSupportedEmbedDimension(opts.embedding.length, "supersedeActiveFact");
      outboxValues.push({
        workspaceId: opts.workspaceId,
        eventType: "vector_upsert",
        payload: {
          id: replacementId,
          kind: "fact",
          vector: opts.embedding,
          model: opts.embeddingModel ?? "text-embedding-3-small",
          dimensions: opts.embedding.length,
          revision: replacementRow.revisionCount,
        },
      });
    }
    await tx.insert(schema.outboxTable).values(outboxValues);
    return {
      previous: mapRowToFact(closedRows[0]),
      replacement: mapRowToFact(replacementRow),
    };
  }

  async replaceFact(input: ReplaceFactInput): Promise<ReplaceFactResult | null> {
    return instrumentedQuery("write", () =>
      this.db.transaction(async (tx) => {
        await setWorkspaceContext(tx, input.workspaceId);
        if (input.actorIsolationId) {
          await tx.execute(sql`SELECT set_config('app.actor_id', ${input.actorIsolationId}, true)`);
          await tx.execute(sql`SELECT set_config('app.enforce_actor_isolation', 'true', true)`);
        }
        if (input.userIsolationId) {
          await tx.execute(
            sql`SELECT set_config('mnemosyne.actor_user_id', ${input.userIsolationId}, true)`
          );
          await tx.execute(sql`SELECT set_config('app.enforce_user_isolation', 'true', true)`);
        }

        const now = sql<Date>`transaction_timestamp()`;
        const sourceRows = await tx
          .select()
          .from(schema.factTable)
          .where(
            and(
              eq(schema.factTable.id, input.id),
              eq(schema.factTable.workspaceId, input.workspaceId),
              eq(schema.factTable.status, "active"),
              isNull(schema.factTable.validTo),
              lte(schema.factTable.validFrom, now),
              // B6.35: never replace a fact mid-consolidation.
              sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
            )
          )
          .limit(1)
          .for("update");
        const source = sourceRows[0];
        if (!source) return null;

        let storedStatement = input.statement;
        let hashSubject = source.subject;
        if (
          SENSITIVITY_ORDER[source.sensitivity as Sensitivity] >= SENSITIVITY_ORDER.confidential
        ) {
          const dek = await this.rowActorDek(
            tx,
            input.workspaceId,
            source.actorId,
            `${source.sensitivity} fact replacement`
          );
          hashSubject = decryptEncryptedField(dek, source.subject);
          storedStatement = encryptEncryptedField(
            dek,
            `dek-${input.workspaceId}-${source.actorId}`,
            input.statement
          );
        }

        return this.supersedeActiveFact(tx, source, {
          workspaceId: input.workspaceId,
          statement: input.statement,
          storedStatement,
          hashSubject,
          agentId: input.agentId,
        });
      })
    );
  }

  /**
   * P109 — populate `episode_id` for every fact of a session that does not
   * already have one. See the port declaration for why this is keyed on
   * session_id (idx_fact_session) rather than an id list.
   *
   * `episode_id IS NULL` in the predicate is what makes a re-collapse
   * idempotent and stops a fact from being re-pointed at a later episode.
   */
  async linkSessionFactsToEpisode(
    workspaceId: string,
    sessionId: string,
    episodeId: string
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const rows = (await tx.execute(sql`
        UPDATE mnemosyne.mnemo_fact
        SET episode_id = ${episodeId}
        WHERE workspace_id = ${workspaceId}
          AND session_id = ${sessionId}
          AND episode_id IS NULL
        RETURNING id
      `)) as unknown as Array<{ id: string }>;

      return rows.length;
    });
  }

  /**
   * Close a fact (`status = 'forgotten'`, `valid_to = now`) and snapshot it into
   * `mnemo_fact_archive`, in one transaction.
   *
   * PRIM-3 / CHAOS-8 — returns whether THIS call closed the fact. The row is
   * read `FOR UPDATE`, so concurrent archives of the same fact serialize: the
   * first closes it, the rest find it closed and return `false` without writing
   * a second snapshot or a second `vector_delete`. The archive insert used to be
   * unconditional against `PRIMARY KEY (id)`, so a second archive — five racing
   * DELETEs, or a forget after a restore — died on `mnemo_fact_archive_pkey`
   * and left a restored fact that could never be forgotten again.
   *
   * The archive keeps the LATEST forgotten snapshot (upsert on `id`): a fact
   * forgotten, restored and forgotten again has one archive row, describing the
   * last close. Earlier closes stay visible in the audit log and the timeline.
   */
  async archiveFact(id: string, workspaceId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      const existing = await tx
        .select()
        .from(schema.factTable)
        .where(and(eq(schema.factTable.id, id), eq(schema.factTable.workspaceId, workspaceId)))
        .limit(1)
        .for("update");
      if (!existing[0]) return false;

      const row = existing[0];
      // Already closed (a repeat, or the loser of a race): nothing to do.
      if (row.validTo != null || row.status === "forgotten") return false;
      // B6.35: never archive a fact mid-consolidation.
      if (
        Object.prototype.hasOwnProperty.call(
          (row.metadata ?? {}) as Record<string, unknown>,
          "__mnemoConsolidationPending"
        )
      )
        return false;

      // Mark original as forgotten — first, so the archive copy carries the
      // close instant the database stamped.
      const [closed] = await tx
        .update(schema.factTable)
        .set({ status: "forgotten", validTo: dbNow(), updatedAt: dbNow() })
        .where(and(eq(schema.factTable.id, id), eq(schema.factTable.workspaceId, workspaceId)))
        .returning({ at: schema.factTable.validTo });
      const now = closed!.at!;

      // Copy to archive
      const snapshot = {
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        actorId: row.actorId,
        userId: row.userId,
        actorType: row.actorType,
        scope: row.scope,
        scopeRef: row.scopeRef,
        scopeOwner: row.scopeOwner,
        statement: row.statement,
        subject: row.subject,
        kind: row.kind,
        // mnemo_fact.confidence/relevance are `real` (number); the archive
        // table's are `numeric` (string) — see facts.ts's Slice 1 comments.
        confidence: row.confidence.toString(),
        relevance: row.relevance.toString(),
        hitCount: row.hitCount,
        lastRecalledAt: row.lastRecalledAt,
        worthSuccess: row.worthSuccess,
        worthFailure: row.worthFailure,
        worthAlpha: row.worthAlpha,
        worthBeta: row.worthBeta,
        memoryType: row.memoryType,
        memoryStrength: row.memoryStrength,
        memoryStability: row.memoryStability,
        lastStrengthUpdate: row.lastStrengthUpdate,
        attribution: row.attribution,
        attributedTo: row.attributedTo,
        sourceMessageIds: row.sourceMessageIds,
        sessionId: row.sessionId,
        extractionSource: row.extractionSource,
        topicKey: row.topicKey,
        revisionCount: row.revisionCount,
        protocolVersion: row.protocolVersion,
        entityId: row.entityId,
        episodeId: row.episodeId,
        status: "forgotten",
        pinned: row.pinned,
        sensitivity: row.sensitivity,
        mergedIntoId: row.mergedIntoId,
        validFrom: row.validFrom,
        validTo: now,
        embedding: row.embedding,
        embeddingModel: row.embeddingModel,
        embeddingStale: row.embeddingStale,
        embeddingVersion: row.embeddingVersion,
        linkedMemoryIds: row.linkedMemoryIds,
        createdAt: row.createdAt,
        updatedAt: now,
        metadata: row.metadata as Record<string, unknown>,
        archivedAt: now,
        archiveReason: "forgotten",
      } satisfies Omit<typeof schema.factArchiveTable.$inferInsert, "id">;
      await tx
        .insert(schema.factArchiveTable)
        .values({ id: row.id, ...snapshot })
        .onConflictDoUpdate({ target: schema.factArchiveTable.id, set: snapshot });

      // Outbox: bust cache/remove vector
      await tx.insert(schema.outboxTable).values({
        workspaceId,
        eventType: "vector_delete",
        payload: { id, kind: "fact" },
      });
      return true;
    });
  }

  /**
   * Atomic conflict resolution (flatten-legacy-dual-core, Slice 3c, B5).
   *
   * Ported 1:1 from the legacy `CoreLike`'s 4-branch switch in
   * `routes/conflicts.ts` (`closeFact`/`createFact`/`patchRelation`/
   * `createRelation`, mapping to `core/src/factory.ts`'s `closeFact` +
   * `core/src/graph/relation.ts`'s `createRelation`/`judgeRelation`) — but
   * the legacy version called those 4 independently-transactional methods up
   * to 6 times per resolution, so a mid-sequence failure left partial state
   * (the B5 bug). This method performs the exact same writes inside ONE
   * `db.transaction`, mirroring the cross-entity pattern `replaceFact` above
   * already uses (fact update/insert + relation insert, one transaction).
   *
   * `closeFact` deliberately matches legacy `factory.ts:741`'s plain
   * `UPDATE ... SET valid_to=now(), status='forgotten'` — no archive-table
   * copy, no outbox event (legacy never emitted one here either); `merge`'s
   * new fact deliberately matches legacy `factory.ts:687`'s
   * `saveFactWithAutoResolve` defaults (`scope: "global"`, `kind: "other"`,
   * `subject: "workspace"`, `metadata` = the caller's `attribution` bag) —
   * MINUS the §33 auto-resolve contradiction pass, which is new-capability
   * territory orthogonal to B5's atomicity requirement and is not invoked by
   * this narrow, disclosed port.
   */
  async resolveConflict(input: ResolveConflictInput): Promise<ResolveConflictResult> {
    return instrumentedQuery("write", () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
        const now = dbNow();

        const closeFact = async (id: string) => {
          // B6.35: mirrors legacy `factory.ts:741`'s closeFact — never close a
          // fact mid-consolidation (`__mnemoConsolidationPending` marker).
          await tx
            .update(schema.factTable)
            .set({ status: "forgotten", validTo: now, updatedAt: now })
            .where(
              and(
                eq(schema.factTable.id, id),
                eq(schema.factTable.workspaceId, input.workspaceId),
                isNull(schema.factTable.validTo),
                sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
              )
            );
        };

        const judgeNotConflict = async (reason: string) => {
          await tx
            .update(schema.relationTable)
            .set({
              relation: "not_conflict",
              judgmentStatus: "judged",
              markedByKind: "llm_judge",
              reason,
            })
            .where(
              and(
                eq(schema.relationTable.id, input.relationId),
                eq(schema.relationTable.workspaceId, input.workspaceId)
              )
            );
        };

        const insertSupersedes = async (
          sourceKind: string,
          sourceId: string,
          targetKind: string,
          targetId: string,
          reason: string
        ) => {
          await tx.insert(schema.relationTable).values({
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            sourceKind,
            sourceId,
            targetKind,
            targetId,
            relation: "supersedes",
            judgmentStatus: "judged",
            markedByKind: "llm_judge",
            reason,
            actorId: input.actorId,
            userId: input.userId ?? null,
            actorType: input.actorType,
            validFrom: now,
            createdAt: now,
            updatedAt: now,
          });
        };

        let mergedFactId: string | null = null;

        switch (input.action) {
          case "supersede_a": {
            // FactA (source) is wrong; factB (target) wins.
            await closeFact(input.sourceId);
            await judgeNotConflict("Resolved via memory_judge: supersede_a");
            await insertSupersedes(
              input.targetKind,
              input.targetId,
              input.sourceKind,
              input.sourceId,
              "Resolved via memory_judge: supersede_a (factB supersedes factA)"
            );
            break;
          }
          case "supersede_b": {
            // FactB (target) is wrong; factA (source) wins.
            await closeFact(input.targetId);
            await judgeNotConflict("Resolved via memory_judge: supersede_b");
            await insertSupersedes(
              input.sourceKind,
              input.sourceId,
              input.targetKind,
              input.targetId,
              "Resolved via memory_judge: supersede_b (factA supersedes factB)"
            );
            break;
          }
          case "keep_both": {
            await judgeNotConflict("Resolved via memory_judge: keep_both");
            break;
          }
          case "merge": {
            // The merged text restates both facts, so it takes the more
            // sensitive tier of the two and, at confidential+, is sealed under
            // the resolving actor's DEK like any other write (C1). It used to
            // land as `internal` plaintext whatever the sources were.
            const tiers = await tx
              .select({ sensitivity: schema.factTable.sensitivity })
              .from(schema.factTable)
              .where(
                and(
                  eq(schema.factTable.workspaceId, input.workspaceId),
                  inArray(schema.factTable.id, [input.sourceId, input.targetId])
                )
              );
            const sensitivity = tiers.reduce<Sensitivity>(
              (top, r) =>
                SENSITIVITY_ORDER[r.sensitivity as Sensitivity] > SENSITIVITY_ORDER[top]
                  ? (r.sensitivity as Sensitivity)
                  : top,
              "internal"
            );
            const sealed = await this.sealForWrite(tx, {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              userId: input.userId,
              sensitivity,
              statement: input.mergedStatement!,
              subject: "workspace",
            });
            await closeFact(input.sourceId);
            await closeFact(input.targetId);

            const id = crypto.randomUUID();
            // B6.35: mirrors createFact's marker-strip discipline — the merged
            // fact is always a fresh row with no consolidation history, so no
            // caller may forge the pending marker onto it either.
            const mergedMetadata = (() => {
              const { __mnemoConsolidationPending: _pending, ...safe } = {
                mergedFrom: [input.sourceId, input.targetId],
                mergedBy: "llm_judge",
              } as Record<string, unknown>;
              return safe;
            })();
            const rows = await tx
              .insert(schema.factTable)
              .values({
                id,
                workspaceId: input.workspaceId,
                actorId: input.actorId,
                userId: input.userId,
                actorType: input.actorType,
                scope: "global",
                scopeOwner: `workspace:${input.workspaceId}`,
                statement: sealed.statement,
                subject: sealed.subject,
                kind: "other",
                sensitivity,
                metadata: mergedMetadata,
              })
              .returning({ id: schema.factTable.id });
            const created = rows[0];
            if (!created) throw new Error("resolveConflict: merged fact INSERT returned no row");
            mergedFactId = created.id;

            await judgeNotConflict(`Resolved via memory_judge: merge → ${mergedFactId}`);
            await insertSupersedes(
              "fact",
              mergedFactId,
              input.sourceKind,
              input.sourceId,
              `Resolved via memory_judge: merge → ${mergedFactId} (supersedes factA)`
            );
            await insertSupersedes(
              "fact",
              mergedFactId,
              input.targetKind,
              input.targetId,
              `Resolved via memory_judge: merge → ${mergedFactId} (supersedes factB)`
            );
            break;
          }
        }

        return { mergedFactId };
      })
    );
  }

  /**
   * Workspace vitals aggregate — ported 1:1 from the legacy `CoreLike.vitals()`
   * raw-SQL query (packages/core/src/factory.ts) so `GET /health`'s response
   * shape is byte-identical after the flatten-legacy-dual-core port (design.md
   * D3 Tier A parity test pins the contract before this method existed).
   */
  async getVitals(workspaceId: string): Promise<WorkspaceVitals> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = (await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE valid_to IS NULL AND status = 'active')  AS facts_live,
          COUNT(*) FILTER (WHERE valid_to IS NOT NULL OR status = 'forgotten') AS facts_closed,
          COUNT(*) FILTER (WHERE pinned = true)                            AS pinned_count,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL)                    AS embedded,
          COUNT(*) FILTER (WHERE embedding IS NULL AND status = 'active')  AS pending,
          MAX(last_recalled_at)                                            AS last_recall_at,
          MAX(updated_at)                                                  AS last_write_at
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
      `)) as unknown as Array<{
        facts_live: string | number;
        facts_closed: string | number;
        pinned_count: string | number;
        embedded: string | number;
        pending: string | number;
        last_recall_at: Date | string | null;
        last_write_at: Date | string | null;
      }>;
      const r = rows[0] ?? {
        facts_live: 0,
        facts_closed: 0,
        pinned_count: 0,
        embedded: 0,
        pending: 0,
        last_recall_at: null,
        last_write_at: null,
      };
      const scopeRows = (await tx.execute(sql`
        SELECT scope_ref, COUNT(*) AS cnt
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
          AND valid_to IS NULL
          AND status = 'active'
          AND scope_ref IS NOT NULL
        GROUP BY scope_ref
        ORDER BY cnt DESC
      `)) as unknown as Array<{ scope_ref: string; cnt: string | number }>;

      return {
        workspaceId,
        factsLive: Number(r.facts_live),
        factsClosed: Number(r.facts_closed),
        pinnedCount: Number(r.pinned_count),
        lastRecallAt: toIsoOrNull(r.last_recall_at),
        lastWriteAt: toIsoOrNull(r.last_write_at),
        embeddings: {
          indexed: Number(r.embedded),
          pending: Number(r.pending),
        },
        factsByScopeRef: scopeRows.map((row) => ({
          scopeRef: row.scope_ref,
          count: Number(row.cnt),
        })),
      };
    });
  }

  /** Facts created per UTC day: `days` entries ending today, zero-filled, oldest first. */
  async getWritesPerDay(
    workspaceId: string,
    days: number
  ): Promise<Array<{ day: string; count: number }>> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = (await tx.execute(sql`
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.cnt, 0) AS cnt
        FROM generate_series(
          (now() AT TIME ZONE 'UTC')::date - (${days}::int - 1),
          (now() AT TIME ZONE 'UTC')::date,
          interval '1 day'
        ) AS d(day)
        LEFT JOIN (
          SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS cnt
          FROM mnemosyne.mnemo_fact
          WHERE workspace_id = ${workspaceId}
            AND created_at >= ((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp
              AT TIME ZONE 'UTC'
          GROUP BY 1
        ) c ON c.day = d.day::date
        ORDER BY d.day
      `)) as unknown as Array<{ day: string; cnt: string | number }>;
      return rows.map((r) => ({ day: r.day, count: Number(r.cnt) }));
    });
  }

  /**
   * Undo-log feed — ported 1:1 from the legacy `CoreLike.audit()` raw-SQL
   * UNION ALL query (packages/core/src/factory.ts) so `GET /audit`'s response
   * shape is byte-identical after the port. The two sources never overlap —
   * an archived fact is no longer in mnemo_fact — so UNION ALL is safe and
   * dedupe-free.
   */
  /**
   * WorkspacePort.getAuditFeedStats: the same two sources as getAuditFeed (user
   * forgets, system archives) counted per UTC day over the window, under the ceiling.
   */
  async getAuditFeedStats(input: {
    workspaceId: string;
    days: number;
    maxSensitivity?: Sensitivity;
  }): Promise<AuditFeedStats> {
    const { workspaceId: ws, days } = input;
    const since = sql`(((now() AT TIME ZONE 'UTC')::date - (${days}::int - 1))::timestamp AT TIME ZONE 'UTC')`;
    const visible = (alias: string) =>
      input.maxSensitivity
        ? sql` AND ${sql.raw(alias)}.sensitivity IN (${sql.join(
            tiersAtOrBelow(input.maxSensitivity).map((t) => sql`${t}`),
            sql`, `
          )})`
        : sql``;
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${ws}::uuid)`);
      return (await tx.execute(sql`
        SELECT to_char((at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, actor_kind, count(*)::int AS n
        FROM (
          SELECT f.updated_at AS at, 'user'::text AS actor_kind
          FROM mnemosyne.mnemo_fact f
          WHERE f.workspace_id = ${ws} AND f.status = 'forgotten' AND f.updated_at >= ${since}${visible("f")}
          UNION ALL
          SELECT a.archived_at, 'system'::text
          FROM mnemosyne.mnemo_fact_archive a
          WHERE a.workspace_id = ${ws} AND a.archived_at >= ${since}${visible("a")}
        ) feed
        GROUP BY 1, 2
      `)) as unknown as Array<{ day: string; actor_kind: "user" | "system"; n: number }>;
    });
    return tallyAuditFeedStats(
      days,
      Array.from(rows).map((r) => ({ day: r.day, actorKind: r.actor_kind, n: Number(r.n) }))
    );
  }

  async getAuditFeed(filter: AuditFeedFilter): Promise<AuditFeedEntry[]> {
    const limit = Math.min(Math.max(filter.limit, 1), 100);
    const outer: ReturnType<typeof sql>[] = [sql`TRUE`];
    if (filter.actorKind) outer.push(sql`merged.actor_kind = ${filter.actorKind}`);
    if (filter.from) outer.push(sql`merged.timestamp >= ${filter.from}::timestamptz`);
    if (filter.to) outer.push(sql`merged.timestamp <= ${filter.to}::timestamptz`);
    if (filter.q && filter.q.trim().length > 0) {
      const like = "%" + filter.q + "%";
      outer.push(sql`(merged.fact_statement ILIKE ${like} OR merged.fact_subject ILIKE ${like})`);
    }
    if (filter.maxSensitivity) {
      const tiers = sql.join(
        tiersAtOrBelow(filter.maxSensitivity).map((t) => sql`${t}`),
        sql`, `
      );
      outer.push(sql`merged.sensitivity IN (${tiers})`);
    }
    const outerWhere = sql.join(outer, sql` AND `);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const rows = (await tx.execute(sql`
        SELECT * FROM (
          SELECT
            'forget_' || f.id          AS id,
            f.id                        AS fact_id,
            f.statement                 AS fact_statement,
            f.subject                   AS fact_subject,
            f.kind                      AS fact_kind,
            'forgotten'::text           AS action,
            'user'::text                AS actor_kind,
            NULL::text                  AS actor_name,
            f.updated_at                AS timestamp,
            true                        AS revertible,
            f.sensitivity               AS sensitivity
          FROM mnemosyne.mnemo_fact f
          WHERE f.workspace_id = ${filter.workspaceId}
            AND f.status = 'forgotten'
          UNION ALL
          SELECT
            'archive_' || a.id          AS id,
            a.id                        AS fact_id,
            a.statement                 AS fact_statement,
            a.subject                   AS fact_subject,
            a.kind                      AS fact_kind,
            'forgotten'::text           AS action,
            'system'::text              AS actor_kind,
            NULL::text                  AS actor_name,
            a.archived_at               AS timestamp,
            false                       AS revertible,
            a.sensitivity               AS sensitivity
          FROM mnemosyne.mnemo_fact_archive a
          WHERE a.workspace_id = ${filter.workspaceId}
        ) merged
        WHERE ${outerWhere}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `)) as unknown as Array<{
        id: string;
        fact_id: string;
        fact_statement: string;
        fact_subject: string;
        fact_kind: string;
        action: "forgotten";
        actor_kind: "user" | "system";
        actor_name: string | null;
        timestamp: Date | string;
        revertible: boolean;
      }>;
      return rows.map((r) => ({
        id: r.id,
        factId: r.fact_id,
        factStatement: r.fact_statement,
        factSubject: r.fact_subject,
        factKind: r.fact_kind,
        action: r.action,
        actorKind: r.actor_kind,
        actorName: r.actor_name,
        timestamp: toIsoOrNull(r.timestamp) ?? new Date(0).toISOString(),
        revertible: r.revertible,
      }));
    });
  }

  async queryFacts(filter: FactFilter): Promise<PaginatedResult<MnemoFact>> {
    const { workspaceId, offset = 0, limit = 20 } = filter;

    return instrumentedQuery("recall", () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

        const conditions = [eq(schema.factTable.workspaceId, workspaceId)];
        if (filter.status) conditions.push(eq(schema.factTable.status, filter.status));
        if (filter.kind) conditions.push(eq(schema.factTable.kind, filter.kind));
        if (filter.scope) conditions.push(eq(schema.factTable.scope, filter.scope));
        if (filter.entityId) conditions.push(eq(schema.factTable.entityId, filter.entityId));
        if (filter.sessionId) conditions.push(eq(schema.factTable.sessionId, filter.sessionId));
        if (filter.topicKey) conditions.push(eq(schema.factTable.topicKey, filter.topicKey));
        if (filter.minConfidence !== undefined) {
          conditions.push(gte(schema.factTable.confidence, filter.minConfidence));
        }
        if (filter.validAt) {
          conditions.push(lte(schema.factTable.validFrom, filter.validAt));
          conditions.push(
            // Typed operators, not raw sql — see querySkills (SKILL-1, 4bc311d).
            or(isNull(schema.factTable.validTo), gt(schema.factTable.validTo, filter.validAt))!
          );
        }
        // complete-mcp-tools B3 — additive: transaction-time lower bound for
        // callers surfacing genuine creation events (GET /timeline).
        if (filter.createdSince) {
          conditions.push(gte(schema.factTable.createdAt, filter.createdSince));
        }
        if (filter.maxSensitivity) {
          conditions.push(
            inArray(schema.factTable.sensitivity, tiersAtOrBelow(filter.maxSensitivity))
          );
        }

        const whereClause = and(...conditions);

        // complete-mcp-tools B3 — `created_at DESC` ordering only kicks in
        // when `createdSince` is set (the caller wants newest-first
        // creation events); existing callers keep the unordered default.
        const [rows, countRows] = await Promise.all([
          filter.createdSince
            ? tx
                .select()
                .from(schema.factTable)
                .where(whereClause)
                .orderBy(desc(schema.factTable.createdAt))
                .limit(limit)
                .offset(offset)
            : tx.select().from(schema.factTable).where(whereClause).limit(limit).offset(offset),
          tx.select({ total: count() }).from(schema.factTable).where(whereClause),
        ]);

        const total = Number(countRows[0]?.total ?? 0);
        return {
          items: rows.map(mapRowToFact),
          total,
          offset,
          limit,
          hasMore: offset + rows.length < total,
        };
      })
    );
  }

  // ─── flatten-legacy-dual-core PR9b (D6.3) — keyset fact list + hard purge ──

  /**
   * Keyset-paginated fact list backing `GET /facts`. Ported 1:1 from legacy
   * `CoreLike.listFacts` (packages/core/src/factory.ts) onto typed Drizzle
   * columns — same whitelist-by-TypeScript `sortBy` → column mapping, same
   * `(sortColumn, id)` tuple keyset comparison, same opaque base64url
   * `{v, id}` cursor wire format, same `total` snapshot taken BEFORE the
   * cursor predicate is appended (so it reflects the filter set, not the
   * current page). Additive — see {@link FactPageFilter}'s doc comment for
   * why this does not replace {@link queryFacts}.
   */
  async queryFactsPage(filter: FactPageFilter): Promise<FactPage> {
    const limit = Math.min(Math.max(filter.limit, 1), 500);
    const status = filter.status ?? "active";
    const sortBy = filter.sortBy ?? "updated_at";
    const order = filter.order ?? "desc";
    const isDesc = order === "desc";
    const isTimestampSort = sortBy === "created_at" || sortBy === "updated_at";

    // Whitelist enforced by TypeScript — `sortBy`'s type already restricts
    // this to the four valid keys; the lookup table maps straight to typed
    // Drizzle columns (never a user-controlled raw column name).
    const sortColumn = {
      created_at: schema.factTable.createdAt,
      updated_at: schema.factTable.updatedAt,
      relevance: schema.factTable.relevance,
      hit_count: schema.factTable.hitCount,
    }[sortBy];
    const sortRowKey = {
      created_at: "createdAt",
      updated_at: "updatedAt",
      relevance: "relevance",
      hit_count: "hitCount",
    }[sortBy] as keyof schema.SelectFact;

    // Decode the opaque base64url cursor produced by a previous call.
    // Malformed cursors are silently dropped — caller gets the first page.
    let cursor: { v: string | number; id: string } | null = null;
    if (filter.cursor) {
      try {
        const json = Buffer.from(filter.cursor, "base64url").toString("utf8");
        const obj = JSON.parse(json) as Partial<{ v: string | number; id: string }>;
        // The value goes into SQL as a timestamp or a number: only the exact
        // shape this method renders, so a forged cursor starts from the top
        // instead of failing the cast (a 500).
        const validV = isTimestampSort
          ? typeof obj.v === "string" && CURSOR_INSTANT.test(obj.v)
          : typeof obj.v === "number" && Number.isFinite(obj.v);
        if (validV && typeof obj.id === "string") {
          cursor = { v: obj.v!, id: obj.id };
        }
      } catch {
        // ignore — caller gets the first page.
      }
    }

    return instrumentedQuery("recall", () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);

        const conds = [eq(schema.factTable.workspaceId, filter.workspaceId)];
        if (status !== "all") conds.push(eq(schema.factTable.status, status));
        if (filter.kind) conds.push(eq(schema.factTable.kind, filter.kind));
        if (filter.scope) conds.push(eq(schema.factTable.scope, filter.scope));
        const scopeRefs = scopeRefValues(filter);
        if (scopeRefs) conds.push(inArray(schema.factTable.scopeRef, scopeRefs));
        if (filter.pinned !== undefined) conds.push(eq(schema.factTable.pinned, filter.pinned));
        if (filter.sensitivity) conds.push(eq(schema.factTable.sensitivity, filter.sensitivity));
        // PRIM-8 — the caller's ceiling belongs in the query, not after it: a
        // route-side filter on the returned page left short pages and a
        // `total` that counted (and so disclosed) rows above the ceiling.
        if (filter.maxSensitivity) {
          conds.push(inArray(schema.factTable.sensitivity, tiersAtOrBelow(filter.maxSensitivity)));
        }
        // PRIM-16 — "current" is an open validity interval, not just a status.
        if (filter.currentOnly) conds.push(isNull(schema.factTable.validTo));
        if (filter.asOf) {
          conds.push(lte(schema.factTable.validFrom, filter.asOf));
          conds.push(
            or(isNull(schema.factTable.validTo), gt(schema.factTable.validTo, filter.asOf))!
          );
        }
        if (filter.updatedSince) {
          conds.push(gt(schema.factTable.updatedAt, filter.updatedSince));
        }
        if (filter.createdSince) {
          conds.push(gte(schema.factTable.createdAt, filter.createdSince));
        }
        if (filter.q && filter.q.trim().length > 0) {
          // FTS on the lemmatized column when populated; ILIKE fallback for
          // rows whose lemmatization never ran — same predicate as legacy
          // listFacts / findContradictingFacts above.
          const strict = sql`(
            (${schema.factTable.textLemmatized} IS NOT NULL
              AND ${ftsMatchesEither(sql`${schema.factTable.textLemmatized}`, sql`${schema.factTable.textLemmatizedEs}`, filter.q)})
            OR ${schema.factTable.statement} ILIKE ${"%" + filter.q + "%"}
          )`;
          // RECALL-7 — `plainto_tsquery` ANDs every term, so a question
          // ("which postgres version does payments run") matched nothing that
          // its keywords would. Only when the strict match is EMPTY for the
          // whole filter set, fall back to the same relaxed rule recall's
          // lexical arm uses: at least two of the question's content terms.
          // Decided on the filter set (never the cursor), so every page of a
          // walk takes the same branch.
          const [strictCount] = await tx
            .select({ total: count() })
            .from(schema.factTable)
            .where(and(...conds, strict)!);
          const relaxed =
            Number(strictCount?.total ?? 0) === 0 ? await relaxedFtsPredicate(tx, filter.q) : null;
          conds.push(relaxed ?? strict);
        }

        // Snapshot the filter-only conditions before appending the cursor —
        // `total` must not depend on cursor position.
        const filterConds = [...conds];
        if (cursor) {
          // PRIM-8: bound as text and cast in SQL, so no driver ever round-trips
          // the value through a millisecond JS Date on the way in.
          const cursorValue = isTimestampSort ? String(cursor.v) : Number(cursor.v);
          if (isDesc) {
            conds.push(
              isTimestampSort
                ? sql`(${sortColumn}, ${schema.factTable.id}) < (${cursorValue}::text::timestamptz, ${cursor.id})`
                : sql`(${sortColumn}, ${schema.factTable.id}) < (${cursorValue}::double precision, ${cursor.id})`
            );
          } else {
            conds.push(
              isTimestampSort
                ? sql`(${sortColumn}, ${schema.factTable.id}) > (${cursorValue}::text::timestamptz, ${cursor.id})`
                : sql`(${sortColumn}, ${schema.factTable.id}) > (${cursorValue}::double precision, ${cursor.id})`
            );
          }
        }

        const whereClause = and(...conds)!;
        const countWhereClause = and(...filterConds)!;
        const dir = isDesc ? desc : asc;

        // PRIM-8 — the cursor value of a timestamp sort, rendered by Postgres
        // with all six fractional digits. It used to come from a JS Date
        // (`toISOString()`, milliseconds), so rows sharing a millisecond were
        // skipped (desc) or repeated (asc): 4 of 32 lost on the default sort.
        const sortKey = isTimestampSort
          ? sql<string>`to_char(${sortColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          : sql<string>`NULL`;

        // LIMIT+1 lookahead — decides `hasMore` without a second round-trip.
        const [rows, countRows] = await Promise.all([
          tx
            .select({ ...getTableColumns(schema.factTable), sortKey })
            .from(schema.factTable)
            .where(whereClause)
            .orderBy(dir(sortColumn), dir(schema.factTable.id))
            .limit(limit + 1),
          tx.select({ total: count() }).from(schema.factTable).where(countWhereClause),
        ]);
        const total = Number(countRows[0]?.total ?? 0);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(({ sortKey: _sortKey, ...row }) => mapRowToFact(row));

        // PRIM-19 — a cursor that resumes strictly after row `r`, so a caller
        // merging this page with another stream can stop at any item.
        const cursorAfter = (r: (typeof page)[number]): string => {
          const rawValue = r[sortRowKey];
          const v = isTimestampSort ? r.sortKey : Number(rawValue as number);
          return Buffer.from(JSON.stringify({ v, id: r.id }), "utf8").toString("base64url");
        };
        const itemCursors = page.map(cursorAfter);
        const nextCursor = hasMore ? itemCursors[itemCursors.length - 1]! : null;

        return { items, nextCursor, total, itemCursors };
      })
    );
  }

  /**
   * Hard DELETE of every `status = 'forgotten'` row in the workspace,
   * backing `DELETE /facts/purge`. Ported 1:1 from legacy
   * `CoreLike.purgeClosedFacts` (factory.ts) — same
   * `__mnemoConsolidationPending` skip guard `hardDeleteFact` above already
   * uses (never physically delete a row mid-consolidation: a rollback needs
   * it, and a false deletion-log entry must not be appended for an
   * operation later erased).
   */
  /**
   * P72 — relocate a fact to another workspace, bitemporally, atomically.
   *
   * Reuses `supersedeActiveFact`? No — deliberately not. That helper writes the
   * successor into the SAME workspace as its source, which is the one thing
   * this operation must not do. What is shared is the shape: close, successor,
   * `supersedes`.
   *
   * The GUC is switched mid-transaction, which is safe precisely because
   * `mnemo_set_workspace` uses `set_config(..., true)`: the setting is
   * transaction-local, so the transaction adopts each workspace's RLS context
   * in turn and both halves still commit or roll back together. Without that,
   * this would have to be two calls and could half-happen — leaving a fact
   * closed in the wrong place and never recreated in the right one.
   */
  async relocateFact(input: {
    id: string;
    fromWorkspaceId: string;
    toWorkspaceId: string;
    actorId: string;
    reason?: string;
  }): Promise<{ previousId: string; newId: string } | null> {
    if (input.fromWorkspaceId === input.toWorkspaceId) return null;
    return instrumentedQuery("write", () =>
      this.db.transaction(async (tx) => {
        const now = sql<Date>`transaction_timestamp()`;

        await tx.execute(sql`SELECT mnemo_set_workspace(${input.fromWorkspaceId}::uuid)`);
        const sourceRows = await tx
          .select()
          .from(schema.factTable)
          .where(
            and(
              eq(schema.factTable.id, input.id),
              eq(schema.factTable.workspaceId, input.fromWorkspaceId),
              eq(schema.factTable.status, "active"),
              isNull(schema.factTable.validTo),
              // B6.35: never move a row a consolidation rollback still needs.
              sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
            )
          )
          .limit(1)
          .for("update");
        const source = sourceRows[0];
        if (!source) return null;

        // Confidential+ rows carry an actor-scoped DEK whose ciphertext is
        // meaningless in another workspace. Refusing is the only safe answer:
        // re-encrypting here would need the destination's key material, which
        // this path has no business holding.
        if (
          SENSITIVITY_ORDER[source.sensitivity as Sensitivity] >= SENSITIVITY_ORDER.confidential
        ) {
          throw Object.assign(
            new Error(
              `relocateFact: refusing to move a ${source.sensitivity} fact across workspaces — its ciphertext is bound to the source workspace's DEK`
            ),
            { code: "SENSITIVITY_BLOCKED" }
          );
        }

        await tx
          .update(schema.factTable)
          .set({ status: "forgotten", validTo: now, updatedAt: now })
          .where(
            and(
              eq(schema.factTable.id, input.id),
              eq(schema.factTable.workspaceId, input.fromWorkspaceId)
            )
          );
        // The move is auditable in the workspace it LEFT — that is where someone
        // notices the fact is gone and asks why.
        await tx.insert(schema.deletionLogTable).values({
          workspaceId: input.fromWorkspaceId,
          deletedItemId: input.id,
          deletedItemType: "fact",
          deletionType: "soft",
          actorId: input.actorId,
          reason: input.reason ?? `relocated to workspace ${input.toWorkspaceId}`,
        });

        // ── destination ────────────────────────────────────────────────────
        await tx.execute(sql`SELECT mnemo_set_workspace(${input.toWorkspaceId}::uuid)`);
        const newId = crypto.randomUUID();
        const { __mnemoConsolidationPending: _pending, ...safeMeta } = (source.metadata ??
          {}) as Record<string, unknown>;
        const successorRows = await tx
          .insert(schema.factTable)
          .values({
            id: newId,
            workspaceId: input.toWorkspaceId,
            agentId: source.agentId,
            actorId: source.actorId,
            userId: source.userId,
            actorType: source.actorType,
            scope: source.scope,
            scopeRef: source.scopeRef,
            // scopeOwner names the OLD workspace; rewriting it is the point of
            // the move. Leaving it would route the fact back to where it was
            // wrong.
            scopeOwner: `workspace:${input.toWorkspaceId}`,
            statement: source.statement,
            subject: source.subject,
            kind: source.kind,
            confidence: source.confidence,
            relevance: source.relevance,
            attribution: source.attribution,
            attributedTo: source.attributedTo,
            sourceMessageIds: source.sourceMessageIds,
            sessionId: source.sessionId,
            extractionSource: source.extractionSource,
            topicKey: source.topicKey,
            revisionCount: source.revisionCount + 1,
            protocolVersion: source.protocolVersion,
            // episodeId is NOT carried: mnemo_fact.episode_id has an FK, and the
            // episode lives in the source workspace. Keeping it would either
            // violate the FK or point across the boundary RLS exists to enforce.
            status: "active",
            pinned: source.pinned,
            sensitivity: source.sensitivity,
            validFrom: now,
            validTo: null,
            embedding: null,
            embeddingModel: null,
            embeddingStale: true,
            createdAt: now,
            updatedAt: now,
            metadata: {
              ...safeMeta,
              relocatedFrom: { workspaceId: input.fromWorkspaceId, factId: input.id },
            },
          })
          .returning();
        if (!successorRows[0]) throw new Error("relocateFact: successor INSERT returned no row");

        // The relation lives in the DESTINATION: it has to live in exactly one
        // workspace (RLS scopes relations too), and the destination is where
        // "where did this come from?" gets asked.
        await tx.insert(schema.relationTable).values({
          id: crypto.randomUUID(),
          workspaceId: input.toWorkspaceId,
          sourceKind: "fact",
          sourceId: newId,
          targetKind: "fact",
          targetId: input.id,
          relation: "supersedes",
          hebbianWeight: 1,
          validFrom: now,
          createdAt: now,
          updatedAt: now,
        });

        // New workspace, new text to index: the successor has no vector yet.
        await tx.insert(schema.outboxTable).values({
          workspaceId: input.toWorkspaceId,
          eventType: "vector_upsert",
          payload: { id: newId, kind: "fact", text: source.statement },
        });

        return { previousId: input.id, newId };
      })
    );
  }

  /**
   * Facts deleted outright, for the federation tombstone stream (see the port).
   * The app role cannot read mnemo_deletion_log; mnemo_deleted_facts (0068)
   * returns the rows of the workspace the GUC names, and none without it.
   */
  async queryDeletedFactsPage(filter: {
    workspaceId: string;
    cursor?: string;
    deletedSince?: Date;
    limit: number;
  }): Promise<{ id: string; deletedAt: Date; createdAt: Date | null; cursor: string }[]> {
    const limit = Math.min(Math.max(filter.limit, 1), 500);
    let after: { v: string; id: string } | null = null;
    if (filter.cursor) {
      try {
        const obj = JSON.parse(Buffer.from(filter.cursor, "base64url").toString("utf8")) as {
          v?: unknown;
          id?: unknown;
        };
        if (typeof obj.v === "string" && CURSOR_INSTANT.test(obj.v) && typeof obj.id === "string")
          after = { v: obj.v, id: obj.id };
      } catch {
        // malformed: from the start, like queryFactsPage
      }
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);
      const rows = await tx.execute<{
        id: string;
        deleted_at: Date | string;
        item_created_at: Date | string | null;
        sort_key: string;
      }>(sql`
        SELECT * FROM mnemosyne.mnemo_deleted_facts(
          ${after?.v ?? null}::text::timestamptz, ${after?.id ?? null}::text,
          ${filter.deletedSince?.toISOString() ?? null}::timestamptz, ${limit}::int)
      `);
      return [...rows].map((r) => ({
        id: r.id,
        deletedAt: new Date(r.deleted_at),
        createdAt: r.item_created_at === null ? null : new Date(r.item_created_at),
        cursor: Buffer.from(JSON.stringify({ v: r.sort_key, id: r.id }), "utf8").toString(
          "base64url"
        ),
      }));
    });
  }

  /** 0070 — what GET /memory/federation/items served `peerId` (see the port). */
  async federationServeMark(workspaceId: string, peerId: string): Promise<Date | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx
        .select({ servedUntil: schema.federationServeMarkTable.servedUntil })
        .from(schema.federationServeMarkTable)
        .where(
          and(
            eq(schema.federationServeMarkTable.workspaceId, workspaceId),
            eq(schema.federationServeMarkTable.peerId, peerId)
          )
        );
      return rows[0]?.servedUntil ?? null;
    });
  }

  async raiseFederationServeMark(
    workspaceId: string,
    peerId: string,
    servedUntil: Date
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .insert(schema.federationServeMarkTable)
        .values({ workspaceId, peerId, servedUntil })
        .onConflictDoUpdate({
          target: [
            schema.federationServeMarkTable.workspaceId,
            schema.federationServeMarkTable.peerId,
          ],
          set: {
            servedUntil: sql`GREATEST(${schema.federationServeMarkTable.servedUntil}, excluded.served_until)`,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  async purgeForgottenFacts(workspaceId: string, actorId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const deleted = await tx
        .delete(schema.factTable)
        .where(
          and(
            eq(schema.factTable.workspaceId, workspaceId),
            eq(schema.factTable.status, "forgotten"),
            sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
          )
        )
        .returning({ id: schema.factTable.id, createdAt: schema.factTable.createdAt });

      if (deleted.length === 0) return 0;
      const ids = deleted.map((d) => d.id);

      // ── P114 ────────────────────────────────────────────────────────────────
      // This was the only one of the three physical-delete paths that left no
      // trace at all. `forget(mode:'hard')` and the retention cron both append
      // to mnemo_deletion_log; this one — the single path that deletes MANY rows
      // at once — appended nothing, and the table has an append-only trigger and
      // a REVOKE (S4) precisely so that what gets written cannot be altered.
      // A tamper-proof ledger the most destructive operation skips is decoration.
      //
      // Both writes go in THIS transaction, with the DELETE: a purge that
      // succeeds while its audit entry fails would be exactly the untraceable
      // deletion the log exists to prevent.
      //
      // Dropping the mnemo_fact_hash rows is the second half. Nothing cleaned
      // them up, in any path, so a purged fact left behind the SHA-256 of its
      // statement plus seen_count and timestamps — a fingerprint that outlived
      // the erasure. It is not reversible, but it is confirmable: anyone who
      // guesses the statement can verify it existed and how often it was
      // written. mnemo_fact_hash is a DERIVED INDEX, not a record; the record is
      // mnemo_deletion_log, which is built to be immutable. A derived index must
      // not outlive its source. (This is P114 task 3, decided rather than left
      // hanging: the repetition history does NOT survive an erasure.)
      //
      // The dangling rows are also how this was found — a workspace showing 7
      // fact_hash rows against 1 fact.
      await tx
        .delete(schema.factHashTable)
        .where(
          and(
            eq(schema.factHashTable.workspaceId, workspaceId),
            inArray(schema.factHashTable.factId, ids)
          )
        );

      await tx.insert(schema.deletionLogTable).values(
        deleted.map((d) => ({
          workspaceId,
          deletedItemId: d.id,
          deletedItemType: "fact",
          deletionType: "hard",
          actorId,
          reason: "bulk purge of forgotten facts (DELETE /facts/purge)",
          // 0068: federation serves this deletion as a tombstone (see the log).
          itemCreatedAt: d.createdAt,
        }))
      );

      // PRIM-13: no open edge may outlive the row it points at (same rule as
      // EncryptionRepository.hardDeleteFact).
      await tx
        .update(schema.relationTable)
        .set({ validTo: sql`now()` })
        .where(
          and(
            eq(schema.relationTable.workspaceId, workspaceId),
            isNull(schema.relationTable.validTo),
            or(
              inArray(schema.relationTable.sourceId, ids),
              inArray(schema.relationTable.targetId, ids)
            )
          )
        );

      return deleted.length;
    });
  }

  async findContradictingFacts(
    workspaceId: string,
    input: FindContradictingFactsInput
  ): Promise<ContradictionCandidate[]> {
    const limit = input.limit ?? 5;
    // Above the caller's ceiling a fact is not a candidate (in SQL, before LIMIT).
    const withinCeiling = input.maxSensitivity
      ? sql`AND sensitivity IN (${sql.join(
          tiersAtOrBelow(input.maxSensitivity).map((t) => sql`${t}`),
          sql`, `
        )})`
      : sql``;
    // Nor is a fact outside the write's own context (scope, scope_ref, owner).
    const ctx = input.writeContext;
    const sameContext = ctx
      ? sql`AND scope = ${ctx.scope}
            AND scope_ref IS NOT DISTINCT FROM ${ctx.scopeRef ?? null}
            AND COALESCE(scope_owner, 'workspace:' || workspace_id::text) = ${ctx.scopeOwner}`
      : sql``;
    // PRIM-5 — the subject clause only fires for a subject that names
    // something. `general` is what every write without a subject gets, so on
    // the lexical fallback it matched every vectorless `general` row: one
    // restored fact with a NULL embedding turned every later default-subject
    // write into a conflict against it. The text predicate stays.
    const subjectMatches = isSpecificFactSubject(input.subject)
      ? sql`subject = ${input.subject}`
      : sql`FALSE`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      // P130 — SEMANTIC ARM. When the caller supplies the incoming statement's
      // embedding, candidates come from cosine similarity and `subject` is
      // demoted to a tie-breaker.
      //
      // The lexical arm below cannot find contradictions and never could:
      // plainto_tsquery ANDs every term, so a candidate has to contain every
      // word of the incoming statement — including the one that differs, which
      // is the whole point of a contradiction. That left `subject = $1` as the
      // only clause producing candidates, which is why conflicts were reported
      // between pairs as unrelated as "Verificacion de P117: soft delete" and
      // "The team uses PostgreSQL with pgvector".
      //
      // An earlier attempt removed the subject clause and required lexical
      // overlap instead. It was reverted: false positives went to zero AND so
      // did true positives — a detector switched off in silence, strictly worse
      // than a noisy one.
      // EACH FACT IS JUDGED BY THE BEST SIGNAL IT HAS. A row with a usable
      // vector is judged by cosine; a row without one keeps the old lexical
      // predicate, because for that row there is nothing better and dropping it
      // would trade a noisy candidate for a silent blind spot — the same trade
      // that got the previous attempt reverted, just narrower.
      //
      // In practice this is a ~99.5% reduction, not a rewrite: 373 of 375 facts
      // in the live workspace carry a vector, so subject-match survives only for
      // the handful that cannot be compared any other way.
      //
      // A width mismatch counts as "no usable vector" (P117/P118): comparing
      // across widths is an error, not a low score.
      if (input.embedding && input.embedding.length > 0) {
        const literal = `[${input.embedding.join(",")}]`;
        const minSim = input.minSimilarity ?? DEFAULT_CONTRADICTION_MIN_SIMILARITY;

        // Written out inline rather than composed from `usableVector`/`cosine`
        // fragments. The P118 guard verifies that every template region
        // containing `<=>` also constrains the width, one region at a time — an
        // extracted `sql\`… <=> …\`` fragment is its own region with nothing
        // proving the width, so it fires, correctly: nothing would stop a later
        // caller from interpolating that fragment without the guard. Keeping
        // the whole predicate in one region is what makes it checkable.
        const rows = (await tx.execute(sql`
          SELECT
            id,
            actor_id,
            subject,
            statement,
            confidence,
            attribution,
            worth,
            valid_from,
            CASE
              WHEN embedding IS NOT NULL AND ${sameWidthAsQuery("embedding", input.embedding)}
                THEN (1 - (embedding <=> ${literal}::halfvec))::float8
              ELSE 0
            END AS similarity
          FROM mnemosyne.mnemo_fact
          WHERE workspace_id = ${workspaceId}
            AND status = 'active'
            ${input.excludeId ? sql`AND id != ${input.excludeId}` : sql``}
            ${withinCeiling}
            ${sameContext}
            AND (
              (
                embedding IS NOT NULL AND ${sameWidthAsQuery("embedding", input.embedding)}
                AND (1 - (embedding <=> ${literal}::halfvec)) >= ${minSim}
                -- A zero vector has no direction: its cosine is NaN, which
                -- Postgres orders above every number and lets pass ">= floor".
                -- Left in, one such row is the top candidate for every write.
                AND (embedding <=> ${literal}::halfvec) <> 'NaN'::float8
              )
              OR (
                NOT (embedding IS NOT NULL AND ${sameWidthAsQuery("embedding", input.embedding)})
                AND (
                  ${subjectMatches}
                  OR ${ftsMatchesEither(sql.raw("text_lemmatized"), sql.raw("text_lemmatized_es"), input.statement)}
                )
              )
            )
          ORDER BY
            similarity DESC,
            (subject = ${input.subject}) DESC
          LIMIT ${limit}
        `)) as unknown as ContradictionRow[];
        return rows.map((r) => toContradictingFact(r, true));
      }

      // NO EMBEDDING SUPPLIED AT ALL — unchanged lexical path, for callers with
      // no embed provider. Kept rather than returning nothing: same-subject
      // candidates are noisy but they are not zero, and silently finding
      // nothing is the failure mode this whole item is about.
      const rows = (await tx.execute(sql`
        SELECT
          id,
          actor_id,
          subject,
          statement,
          confidence,
          attribution,
          worth,
          valid_from,
          CASE
            WHEN text_lemmatized IS NOT NULL
              THEN ${ftsRankCdEither(sql.raw("text_lemmatized"), sql.raw("text_lemmatized_es"), input.statement)}
            ELSE 0
          END AS similarity
        FROM mnemosyne.mnemo_fact
        WHERE workspace_id = ${workspaceId}
          AND status = 'active'
          ${input.excludeId ? sql`AND id != ${input.excludeId}` : sql``}
          ${withinCeiling}
          ${sameContext}
          AND (
            ${subjectMatches}
            OR ${ftsMatchesEither(sql.raw("text_lemmatized"), sql.raw("text_lemmatized_es"), input.statement)}
          )
        ORDER BY
          (subject = ${input.subject}) DESC,
          similarity DESC
        LIMIT ${limit}
      `)) as unknown as ContradictionRow[];

      return rows.map((r) => toContradictingFact(r));
    });
  }

  // ─── §11 Governance ─────────────────────────────────────────────────────────

  async setCanonical(id: string, workspaceId: string, canonical: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx
        .update(schema.factTable)
        .set({ canonical })
        .where(
          and(
            eq(schema.factTable.id, id),
            eq(schema.factTable.workspaceId, workspaceId),
            // B6.35: `canonical` is a consolidation-gate eligibility input — never
            // flip it on a fact mid-consolidation.
            sql`NOT (COALESCE(${schema.factTable.metadata}, '{}'::jsonb) ? '__mnemoConsolidationPending')`
          )
        );
    });
  }

  async getRecalledFactIds(workspaceId: string, sessionId: string): Promise<string[]> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      return tx
        .selectDistinct({ factId: schema.recallLogTable.factId })
        .from(schema.recallLogTable)
        .where(
          and(
            eq(schema.recallLogTable.workspaceId, workspaceId),
            eq(schema.recallLogTable.sessionId, sessionId),
            // Non-fact recall hits (0058) have no fact_id: never a provenance terminal.
            isNotNull(schema.recallLogTable.factId),
            // Synthetic/test recalls are telemetry only: never session feedback
            // nor governance terminals.
            organicRecallLogRow
          )
        );
    });
    return rows.flatMap((r) => (typeof r.factId === "string" ? [r.factId] : []));
  }

  async getProvenanceCredit(
    workspaceId: string,
    terminalIds: string[],
    lambda: number,
    maxHops: number
  ): Promise<Array<{ factId: string; credit: number }>> {
    terminalIds = terminalIds.filter((id: unknown): id is string => typeof id === "string");
    if (terminalIds.length === 0) return [];
    const cap = Math.min(maxHops, 5); // defensive: never exceed spec bound (line 1037)
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // Edges point successor -> predecessor via derived_from / part_of.
      // Start at terminals (depth 0, credit 1), walk to predecessors decaying by lambda.
      // Keep the MAX credit per predecessor (shortest path wins).
      const safeIds = terminalIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      const rows = await tx.execute(sql`
        WITH RECURSIVE trace(fact_id, credit, depth, path) AS (
          SELECT t.id, 1.0::double precision, 0, ARRAY[t.id]
            FROM unnest(${sql.raw(`ARRAY[${safeIds}]`)}::text[]) AS t(id)
          UNION ALL
          SELECT r.target_id,
                 trace.credit * ${lambda}::double precision,
                 trace.depth + 1,
                 trace.path || r.target_id
            FROM trace
            JOIN mnemo_relation r
              ON r.source_id = trace.fact_id
             AND r.workspace_id = ${workspaceId}
              AND r.relation IN ('derived_from','part_of')
           WHERE trace.depth < ${cap}
             AND NOT (r.target_id = ANY(trace.path))
        )
        SELECT fact_id, MAX(credit) AS credit
          FROM trace
         WHERE depth > 0
         GROUP BY fact_id
      `);
      const out =
        (rows as unknown as { rows?: Array<{ fact_id: string; credit: number }> }).rows ??
        (rows as unknown as Array<{ fact_id: string; credit: number }>);
      return out.map((r) => ({ factId: r.fact_id, credit: Number(r.credit) }));
    });
  }

  // ─── §9 L3 — Query cache (cosine >= threshold) ──────────────────────────────

  // P59 (docs/archive/openspec/p59-query-cache-l3-fix): rewritten against the real
  // post-0009-migration schema — query_embedding (halfvec, dimensionless)/
  // result_memory_ids/result_memory_kinds (text[])/scope/scope_ref/agent_id/
  // top_k. There is no HNSW index on this column (0009 dropped it, 0010
  // deliberately did not restore it — "query_cache intentionally stays
  // unindexed: cold-path or low-volume lookups"), so the lookup is written
  // as a bounded seq scan: idx_mnemo_qc_ws (workspace_id, last_used_at DESC)
  // narrows the candidate set to at most 200 fresh, topK-matched,
  // workspace-shared rows (design.md D12) before any distance is computed.
  async lookupQueryCache(
    input: LookupQueryCacheInput
  ): Promise<{ resultIds: string[]; resultKinds: string[] } | null> {
    const { workspaceId, embedding, threshold, topK, maxAgeMs } = input;
    const literal = `[${Array.from(embedding).join(",")}]`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = await tx.execute<{
        result_memory_ids: string[];
        result_memory_kinds: string[];
        cosine: string | number;
      }>(sql`
        WITH fresh AS (
          SELECT query_embedding, result_memory_ids, result_memory_kinds
            FROM mnemosyne.mnemo_query_cache
           WHERE workspace_id = ${workspaceId}
             -- D6: age-only filter — correct only because writes are
             -- insert-only (last_used_at === created_at at write time). If a
             -- future change adds touch-on-hit, this predicate must move to
             -- created_at in the same commit, or a repeatedly-hit entry
             -- would refresh itself forever and become unboundedly stale.
             AND last_used_at > now() - make_interval(secs => ${maxAgeMs / 1000})
             AND top_k = ${topK}
             -- D9: workspace-shared rows only, fail-closed against any
             -- future agent-/scope-owned writer.
             AND scope = 'global' AND scope_ref IS NULL AND agent_id IS NULL
             -- D4: query_embedding is dimensionless since 0009 — guard the
             -- distance operator against a workspace using a different
             -- embedding-model dimension (would otherwise raise "different
             -- halfvec dimensions N and M" at the ORDER BY below).
             AND public.vector_dims(query_embedding) = ${embedding.length}
           ORDER BY last_used_at DESC
           LIMIT 200
        )
        SELECT result_memory_ids, result_memory_kinds,
               (1 - (query_embedding <=> ${literal}::halfvec))::float8 AS cosine
          FROM fresh
         ORDER BY query_embedding <=> ${literal}::halfvec
         LIMIT 1
      `);
      const raw =
        (
          rows as unknown as {
            rows?: Array<{
              result_memory_ids: string[];
              result_memory_kinds: string[];
              cosine: string | number;
            }>;
          }
        ).rows ??
        (rows as unknown as Array<{
          result_memory_ids: string[];
          result_memory_kinds: string[];
          cosine: string | number;
        }>);
      const r = raw[0];
      if (!r || Number(r.cosine) < threshold) return null;
      return {
        resultIds: r.result_memory_ids as string[],
        resultKinds: r.result_memory_kinds as string[],
      };
    });
  }

  /**
   * P68 — eviction pass for the L3 cache, closing the storage debt P59's
   * Option A took on knowingly.
   *
   * Anchored on `created_at`. Today that equals `last_used_at` (writes are
   * insert-only), but P59 design.md D6 flags that a future touch-on-hit would
   * let a hot entry refresh itself forever; pruning on creation time means
   * eviction survives that change.
   */
  async pruneQueryCache(workspaceId: string, olderThanMs: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      const rows = (await tx.execute(sql`
        DELETE FROM mnemosyne.mnemo_query_cache
        WHERE workspace_id = ${workspaceId}
          AND created_at < now() - make_interval(secs => ${olderThanMs / 1000})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return Array.from(rows).length;
    });
  }

  // P59: renamed from upsertQueryCache — there is no unique key to conflict
  // on physically, so this is a plain insert-only append (design.md D11).
  async insertQueryCache(input: InsertQueryCacheInput): Promise<void> {
    const { workspaceId, embedding, resultIds, resultKinds, topK } = input;
    // A NOT NULL empty-array row is pure garbage growth; a length mismatch
    // would corrupt hydrateCachedHits' index-paired resultIds/resultKinds
    // walk on read. Skip the write entirely rather than insert bad data.
    if (resultIds.length === 0 || resultIds.length !== resultKinds.length) return;
    const literal = `[${Array.from(embedding).join(",")}]`;
    // D7: the `id` column is `text` with no default; `gen_random_uuid()`
    // returns `uuid`, which Postgres will not implicitly assign to `text`.
    // Generated in TypeScript, matching this file's existing convention
    // (see the other crypto.randomUUID() call sites above).
    const id = crypto.randomUUID();
    // P59 real-Postgres proof (packages/adapter-postgres/src/__tests__/
    // query-cache-l3.integration.test.ts) caught a bug the InMemoryStorageAdapter
    // ripple tests could not: drizzle-orm's `sql` template tag does NOT bind a
    // plain JS array as a single text[] parameter — interpolating
    // `${resultIds}::text[]` directly explodes the array into a parenthesized,
    // comma-separated list of individually-bound scalars (`(p1, p2)::text[]`),
    // which Postgres then rejects ("malformed array literal" for one element,
    // "cannot cast type record to text[]" for two or more). The fix, matching
    // this codebase's existing convention for binding string-array literals
    // (RecallRepository.ts:859, EpisodeRepository.ts:358-362), is to build an
    // explicit `ARRAY[$1, $2, ...]` constructor out of individually-parameterized
    // elements via `sql.join`.
    const resultIdsArray = sql`ARRAY[${sql.join(
      resultIds.map((v) => sql`${v}`),
      sql`, `
    )}]::text[]`;
    const resultKindsArray = sql`ARRAY[${sql.join(
      resultKinds.map((v) => sql`${v}`),
      sql`, `
    )}]::text[]`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_query_cache
               (id, workspace_id, query_embedding, result_memory_ids, result_memory_kinds,
                scope, scope_ref, agent_id, top_k, hit_count, last_used_at, created_at)
        VALUES (${id}, ${workspaceId}, ${literal}::halfvec,
                ${resultIdsArray}, ${resultKindsArray},
                'global', NULL, NULL, ${topK}, 1, now(), now())
      `);
    });
  }

  // ─── §9 L3 — Embedding LRU (exact text-hash) ────────────────────────────────

  async getCachedEmbedding(
    workspaceId: string,
    textHash: string,
    model?: string
  ): Promise<Float32Array | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
      // The `model` guard is what makes a hit safe to use: the row is keyed by
      // text hash alone, so without it a workspace that changed embedding model
      // gets back a vector from the previous model's space — a different width,
      // which kills the downstream cosine query outright (see the port doc).
      const rows = await tx.execute<{ embedding: string }>(sql`
        UPDATE mnemosyne.mnemo_embedding_cache
           SET hit_count = hit_count + 1, last_used_at = now()
         WHERE workspace_id = ${workspaceId}
           AND text_hash = ${textHash}
           ${model === undefined ? sql`` : sql`AND model = ${model}`}
        RETURNING embedding::text
      `);
      const raw =
        (rows as unknown as { rows?: Array<{ embedding: string }> }).rows ??
        (rows as unknown as Array<{ embedding: string }>);
      const r = raw[0];
      if (!r) return null;
      // Parse halfvec literal "[n1,n2,...]" to Float32Array
      const nums = r.embedding
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(Number);
      return new Float32Array(nums);
    });
  }

  async putCachedEmbedding(input: {
    workspaceId: string;
    textHash: string;
    embedding: Float32Array;
    model: string;
  }): Promise<void> {
    const literal = `[${Array.from(input.embedding).join(",")}]`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${input.workspaceId}::uuid)`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_embedding_cache
               (id, workspace_id, text_hash, embedding, model, hit_count, last_used_at, created_at)
        VALUES (gen_random_uuid(), ${input.workspaceId}, ${input.textHash}, ${literal}::halfvec,
                ${input.model}, 1, now(), now())
        ON CONFLICT (workspace_id, text_hash) DO UPDATE
          SET hit_count    = mnemo_embedding_cache.hit_count + 1,
              last_used_at = now(),
              -- Adopt the incoming vector when the model changed. Bumping the
              -- counter alone would strand the row: a model-aware read never
              -- matches it again, and this INSERT is only reached after such a
              -- miss, so nothing would ever overwrite it either.
              embedding    = EXCLUDED.embedding,
              model        = EXCLUDED.model
      `);
    });
  }

  // ─── SOC2 CF3 — Retention purge ─────────────────────────────────────────────

  /**
   * Soft-close facts past the retention window for one sensitivity tier in one
   * workspace. Runs inside a single transaction with the workspace GUC set.
   *
   * Design decision D2: UPDATE mirrors archiveFact (status='forgotten', validTo=now()).
   * Paginated at `limit` (default 500) to bound transaction length.
   * dryRun=true counts rows without mutating.
   *
   * DEK guard (D3): eraseCandidateActorIds spans BOTH confidential AND restricted
   * in a single query — a DEK is actor-scoped, not tier-scoped.
   */
  async purgeFactsBySensitivity(filter: PurgeFactsFilter): Promise<PurgeFactsResult> {
    const limit = filter.limit ?? 500;
    const { workspaceId, sensitivity, olderThanDays, dryRun = false } = filter;
    const intervalLiteral = `${olderThanDays} days`;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);

      if (dryRun) {
        // Count only — no mutations. LIMIT is applied in the subquery so the
        // aggregate reflects min(eligible, limit) rather than the full table count.
        const countResult = await tx.execute<{ n: string }>(sql`
          SELECT COUNT(*) AS n
            FROM (
              SELECT 1
                FROM mnemosyne.mnemo_fact
               WHERE workspace_id = ${workspaceId}
                 AND sensitivity   = ${sensitivity}
                 AND created_at    < now() - ${intervalLiteral}::interval
                 AND valid_to IS NULL
                 AND status <> 'hard_deleted'
                 AND NOT (COALESCE(metadata, '{}'::jsonb) ? '__mnemoConsolidationPending')
               LIMIT ${limit}
            ) sub
        `);
        const raw =
          (countResult as unknown as { rows?: Array<{ n: string }> }).rows ??
          (countResult as unknown as Array<{ n: string }>);
        const softClosed = Number(raw[0]?.n ?? 0);
        return { softClosed, eraseCandidateActorIds: [], eraseCandidateUserIds: [] };
      }

      // Bulk soft-close: UPDATE inside subquery with LIMIT, RETURNING actor_id + user_id.
      const updateResult = await tx.execute<{
        actor_id: string | null;
        user_id: string | null;
      }>(sql`
        UPDATE mnemosyne.mnemo_fact
           SET status     = 'forgotten',
               valid_to   = now(),
               updated_at = now()
         WHERE id IN (
           SELECT id
             FROM mnemosyne.mnemo_fact
            WHERE workspace_id = ${workspaceId}
              AND sensitivity   = ${sensitivity}
              AND created_at    < now() - ${intervalLiteral}::interval
              AND valid_to IS NULL
              AND status <> 'hard_deleted'
              AND NOT (COALESCE(metadata, '{}'::jsonb) ? '__mnemoConsolidationPending')
            LIMIT ${limit}
         )
        RETURNING actor_id, user_id
      `);
      const updatedRows =
        (
          updateResult as unknown as {
            rows?: Array<{ actor_id: string | null; user_id: string | null }>;
          }
        ).rows ??
        (updateResult as unknown as Array<{ actor_id: string | null; user_id: string | null }>);

      const softClosed = updatedRows.length;

      // Compute erase candidates only for encrypted tiers (confidential / restricted).
      // For 'internal' the DEK guard count is skipped — internal facts are plaintext.
      if (SENSITIVITY_ORDER[sensitivity] <= SENSITIVITY_ORDER.internal || softClosed === 0) {
        return { softClosed, eraseCandidateActorIds: [], eraseCandidateUserIds: [] };
      }

      // Collect distinct actor_ids from the rows we just soft-closed.
      const affectedActorIds = [
        ...new Set(updatedRows.map((r) => r.actor_id).filter((id): id is string => id != null)),
      ];
      // Collect distinct user_ids too — a person's confidential/restricted facts
      // may span MULTIPLE actor_ids (different keys), so their DEK-safety gate
      // must be checked at the user_id grain, not per-actor-id.
      const affectedUserIds = [
        ...new Set(updatedRows.map((r) => r.user_id).filter((id): id is string => id != null)),
      ];
      if (affectedActorIds.length === 0 && affectedUserIds.length === 0) {
        return { softClosed, eraseCandidateActorIds: [], eraseCandidateUserIds: [] };
      }

      // For each affected actor, check whether any confidential OR restricted facts
      // remain active (valid_to IS NULL) in this workspace. The DEK is actor-scoped
      // so both encrypted tiers must be exhausted before it's safe to erase.
      let eraseCandidateActorIds: string[] = [];
      if (affectedActorIds.length > 0) {
        const safeLiteralIds = affectedActorIds
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",");

        const remainingResult = await tx.execute<{ actor_id: string; remaining: string }>(sql`
          SELECT actor_id, COUNT(*) AS remaining
            FROM mnemosyne.mnemo_fact
           WHERE workspace_id = ${workspaceId}
             AND actor_id     = ANY(${sql.raw(`ARRAY[${safeLiteralIds}]`)}::text[])
             AND sensitivity  IN ('confidential', 'restricted')
             AND valid_to IS NULL
           GROUP BY actor_id
        `);
        const remainingRows =
          (remainingResult as unknown as { rows?: Array<{ actor_id: string; remaining: string }> })
            .rows ?? (remainingResult as unknown as Array<{ actor_id: string; remaining: string }>);

        const actorsWithRemaining = new Set(remainingRows.map((r) => r.actor_id));
        eraseCandidateActorIds = affectedActorIds.filter((id) => !actorsWithRemaining.has(id));
      }

      // Same DEK-safety gate, at the user_id grain: a person is only an erase
      // candidate once ALL of their confidential/restricted facts — across every
      // actor_id/key they've used — have closed. Groups across actor_ids by
      // construction (the query filters on user_id, not actor_id).
      let eraseCandidateUserIds: string[] = [];
      if (affectedUserIds.length > 0) {
        const safeLiteralUserIds = affectedUserIds
          .map((id) => `'${id.replace(/'/g, "''")}'`)
          .join(",");

        const remainingUserResult = await tx.execute<{ user_id: string; remaining: string }>(sql`
          SELECT user_id, COUNT(*) AS remaining
            FROM mnemosyne.mnemo_fact
           WHERE workspace_id = ${workspaceId}
             AND user_id      = ANY(${sql.raw(`ARRAY[${safeLiteralUserIds}]`)}::text[])
             AND sensitivity  IN ('confidential', 'restricted')
             AND valid_to IS NULL
           GROUP BY user_id
        `);
        const remainingUserRows =
          (
            remainingUserResult as unknown as {
              rows?: Array<{ user_id: string; remaining: string }>;
            }
          ).rows ??
          (remainingUserResult as unknown as Array<{ user_id: string; remaining: string }>);

        const usersWithRemaining = new Set(remainingUserRows.map((r) => r.user_id));
        eraseCandidateUserIds = affectedUserIds.filter((id) => !usersWithRemaining.has(id));
      }

      return { softClosed, eraseCandidateActorIds, eraseCandidateUserIds };
    });
  }
}
