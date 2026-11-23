/**
 * Type contracts for the Mnemosyne HTTP API.
 *
 * These shapes mirror the zod schemas that @mnemo-ai/server validates
 * incoming/outgoing payloads against. They are duplicated here (rather
 * than imported as a runtime dependency) so that:
 *   1. The client SDK has ZERO runtime dependencies — installing it
 *      doesn't pull in the entire server graph (Drizzle, pg, pgvector
 *      bindings, etc.).
 *   2. The client can be used in browsers, Cloudflare Workers, Bun,
 *      Deno, etc. — environments where the server package would refuse
 *      to install.
 *
 * If you bump a server schema, update the matching type here. We rely
 * on the API contract test (`packages/server/__tests__/contract.test.ts`)
 * to catch drift between the two copies.
 *
 * For type-only sharing of richer domain types (e.g. Attribution, Kind),
 * users can `import type` from @mnemo-ai/core — it's an optional peer.
 */

/**
 * Provenance bag attached to a fact. The server stores this as a free-form
 * record (recommended fields: source, actor, message_id, timestamp), so we
 * type it loosely rather than freezing a union that would drift from the
 * server's `z.record(z.unknown())`.
 */
export type Attribution = Record<string, unknown>;

/**
 * Per-request observation metadata sent as headers. Versions that are not
 * declared are omitted (the server records them as "unknown").
 */
export interface RequestObservation {
  /** Caller-chosen `X-Request-Id`; generated once per logical request when omitted. */
  requestId?: string;
  /** Declared writer/reader identity, sent as `X-Mnemo-Caller`. */
  caller?: string;
  /** SDK version, sent as `X-Mnemo-Client-Version`. */
  clientVersion?: string;
  /** Plugin version, sent as `X-Mnemo-Plugin-Version`. */
  pluginVersion?: string;
}

/** Sensitivity classification for a memory element. */
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

/**
 * The canonical fact shape returned by the API.
 *
 * Mirrors the server's `FactSchema` (packages/server/src/routes/facts.ts)
 * exactly: bitemporal facts are never hard-deleted — `validTo` is set to
 * the close time instead, so it's nullable.
 */
export interface Fact {
  id: string;
  workspaceId: string;
  content: string;
  attribution: Attribution;
  tags: string[];
  pinned: boolean;
  /** ISO 8601 string — JSON has no native Date. */
  validFrom: string;
  /** ISO 8601 string, or null while the fact is still open. */
  validTo: string | null;
  /** ISO 8601 string — JSON has no native Date. */
  createdAt: string;
  /**
   * Provenance fields, returned only by `GET /facts/{id}?provenance=true`.
   * `supersededById` is null for a closed fact with no successor or one above
   * the caller's sensitivity ceiling (`supersededAt` is then absent); both are
   * omitted for active facts. `sessionId` is null when there is none or the
   * source episode is above the ceiling.
   */
  sessionId?: string | null;
  supersededById?: string | null;
  supersededAt?: string | null;
  /** Ids of the facts this one superseded, newest first. */
  supersedesIds?: string[];
  /** How many times recall has served this fact. Optional: older servers omit it. */
  hitCount?: number;
}

/**
 * Input shape for `client.recall(...)`.
 *
 * Mirrors the server's `POST /recall` request schema EXACTLY (see
 * packages/server/src/routes/recall.ts → RecallRequestSchema). The wire
 * body is this object verbatim — field names must not drift or the
 * server rejects with a 400.
 */
export interface RecallInput {
  /** Free-text query — used for lexical match and (if no vector) embedding. */
  query: string;
  /**
   * Optional pre-embedded query vector. When supplied, the server skips
   * its own embedding pass and uses this directly — no LLM round-trip,
   * deterministic. Useful when the caller already has the vector cached.
   */
  vector?: number[];
  /** Max number of hits to return. Server default 10, clamps to 100. */
  topK?: number;
  /**
   * Point-in-time recall (ISO 8601, not in the future): rank what memory held
   * at that instant, including rows superseded since.
   */
  asOf?: string;
  /** Opt-in HyDE pre-step: one LLM call that writes a hypothetical answer to search with. Default false. */
  hyde?: boolean;
  /** Return each hit's relations and hyperedges. Default false. */
  includeGraph?: boolean;
  /** B5.1 Explicit search mode: "lexical" | "semantic" | "hybrid" | "auto". */
  mode?: "lexical" | "semantic" | "hybrid" | "auto";
  minSimilarity?: number;
  /**
   * Blend factor: 0 = pure lexical, 1 = pure vector. Server default 0.5. Deprecated in favor of mode.
   */
  vectorWeight?: number;
  /** Filter recall to facts with this scope. */
  scope?: "global" | "conversation" | "personal";
  /** Filter recall to facts with this scopeRef (e.g. 'mnemosyne', 'project:abc'). */
  scopeRef?: string;
  /**
   * Filter recall to facts whose stored actorId equals this value exactly —
   * the namespaced credential reference (e.g. "key:<id>") that wrote the
   * fact, NOT reliably a userId. There is no userId-based recall filter yet
   * (the server doesn't accept one — see RecallHit.userId for reading, not
   * filtering, the platform account on a hit).
   */
  actorId?: string;
  /**
   * autonomous-memory session-correlation id (the Mnemosyne session/episode
   * id, e.g. from {@link MnemosyneClient.createSession}). When supplied, the
   * server best-effort-stamps `metadata.lastRecallAt` on that session so a
   * later `getSession` call can confirm recall happened during it. A stale
   * or unknown id is silently ignored — never fails the recall itself.
   */
  sessionId?: string;
  /**
   * P67 — how much of each hit to return. `full` (default over HTTP) sends the
   * whole `content`; `compact` sends a 300-character preview plus
   * `truncated: true`, and you fetch the rest per-hit with `getFact(id)`.
   */
  projection?: "full" | "compact";
  /**
   * P67 — which primitive kinds to search. Omit for the default set. `task`,
   * `event` and `reasoning` are indexed but not returned by default.
   */
  kinds?: string[];
  /** When true the response's `debug.trace` lists the pipeline stages that ran. */
  debug?: boolean;
}

/**
 * One hit from a recall response. Mirrors the server's `RecallHitSchema`
 * (packages/server/src/routes/recall.ts) EXACTLY.
 *
 * `score` is the blended ranking score (higher = more relevant); it
 * combines vector similarity and lexical match per `vectorWeight`. Don't
 * compare scores across queries — they're only meaningful within a single
 * response. `lexicalScore` / `vectorScore` expose the two un-blended
 * components for debugging recall quality.
 */
export interface RecallHit {
  id: string;
  content: string;
  /**
   * P67 — present and true only when `projection: 'compact'` cut this hit's
   * `content` to a 300-character preview. Fetch the full text with
   * `getFact(id)`, and only for the hits you will actually use.
   */
  truncated?: boolean;
  score: number;
  /** Raw semantic cosine, when this fact was found by the vector arm. */
  similarity?: number;
  /** Un-blended lexical (BM25) component, when available. */
  lexicalScore?: number;
  /** Un-blended vector-similarity component, when available. */
  vectorScore?: number;
  /** Valid-time start (bitemporal). ISO 8601. */
  validFrom: string;
  /** Valid-time end, or null if still valid. ISO 8601. */
  validTo: string | null;
  attribution?: Attribution;
  tags?: string[];
  /**
   * The namespaced actor reference that stored this fact (e.g. "key:<id>")
   * — the credential, NOT reliably a userId. Use `userId` below for the
   * platform account, when present.
   */
  actorId?: string | null;
  /** The platform account (mnemo_user.id) that stored this fact, when one exists. */
  userId?: string | null;
  /**
   * topicKey-suggest-and-hit-freshness slice (c): staleness bucket of this
   * hit's `validFrom` (valid-time), computed at recall time — "current"
   * (<7d), "recent" (<30d), "aging" (<90d), "stale" (>=90d). NOT the same
   * concept as `memory_introspect`'s entity-level
   * `SelfModel.confidenceMap[].freshness` (a transaction-time aggregate).
   */
  hitFreshness?: "current" | "recent" | "aging" | "stale";
  /** Only with `includeGraph: true`: outgoing relations of this memory. */
  relations?: Array<{
    id: string;
    targetId: string;
    targetKind: string;
    verb: string;
    weight: number;
  }>;
  /** Only with `includeGraph: true`: groups this memory belongs to; co-members are ids, not hits. */
  hyperedges?: Array<{ id: string; coMembers: string[]; label?: string; worth?: number }>;
  /**
   * Only on an item pulled from a federation peer: the id this server registered
   * that peer under, and the fixed trust given to federated items.
   */
  federation?: { peer: string; trustScore: number };
}

/**
 * Wire response from `POST /recall`. Mirrors the server's
 * `RecallResponseSchema`.
 */
export interface RecallResponse {
  hits: RecallHit[];
  /** Present when the server had to embed the query (no `vector` supplied). */
  debug?: {
    embedded: boolean;
    latencyMs?: number;
    /**
     * Which ranking path actually produced these hits. `"fts"` means the
     * request fell back to full-text/`ts_rank` ranking (no embedder
     * configured); anything else means the HNSW vector cascade ran. This
     * field was always present on the wire (packages/server/src/routes/
     * recall.ts) but missing from this type — callers (e.g. the
     * `memory_search` MCP tool) that only trust the TypeScript surface
     * silently dropped it instead of surfacing it to the calling agent.
     * NOTE: this is NOT the same thing as the request's own `mode` field —
     * the server route does not currently forward `mode`/`vectorWeight`
     * from the request into the ranking pipeline (see MCP-1 in
     * docs/archive/openspec/tool-promise-remediation/spec.md), so `searchMode` here
     * will read `"auto"` even when the caller explicitly asked for
     * `mode: "semantic"` or `vectorWeight: 1`.
     */
    searchMode?: "vector" | "fts" | "lexical" | "semantic" | "hybrid" | "auto";
    /**
     * Per-stage trace, present only when the request set `debug: true`.
     * `ms` is the time since the previous stage in execution order; a tier
     * miss reports 0 candidates. Counts are null for every stage before
     * `eligibility` unless the caller's sensitivity ceiling admits every tier
     * (they would count memories the caller cannot read); `eligibility` then
     * reports only the candidates that passed it, in and out.
     */
    trace?: Array<{
      name: string;
      candidatesIn: number | null;
      candidatesOut: number | null;
      ms: number;
    }>;
  };
  /**
   * REMIND-1: reminders whose trigger fired on this recall call. Already
   * transitioned to status='triggered' server-side — surface them to the user
   * or they are effectively lost (re-readable via
   * `listReminders({ status: "triggered" })`).
   */
  reminders?: Array<{
    id: string;
    content: string;
    condition: string | null;
    triggeredBy: "time" | "semantic" | "both";
  }>;
}

/**
 * Input shape for `client.createFact(...)`.
 *
 * Matches the server's `CreateFactSchema` (POST /facts) exactly:
 * `{ content, attribution, tags }`. There is no statement/subject/kind/
 * confidence on the wire — friendlier names belong to higher layers
 * (e.g. the MCP `memory_remember` tool) which map onto these fields
 * before calling this method.
 */
export interface CreateFactInput {
  /** The fact content. Free-form text; keep it atomic — one claim per fact. */
  content: string;
  /** Provenance bag. Recommended fields: source, actor, message_id, timestamp. */
  attribution?: Attribution;
  /** Optional tags for filtering and rollups. Server defaults to []. */
  tags?: string[];
}

/**
 * Input shape for `client.remember(...)`.
 *
 * Calls POST /memory/remember — the cognitive engine endpoint that supports
 * scope/scopeRef for project-namespaced memory.
 */
export interface RememberInput {
  statement: string;
  subject?: string;
  kind?: string;
  /**
   * Type-specific subtype, used only when kind is 'fact', 'decision', or
   * 'entity'. See RememberInput.kind for the primitive taxonomy — this
   * field is the taxonomy *within* that primitive (for kind='fact':
   * {@link MemoryFactKind}). A value outside the kind's list is stored as
   * 'other' (a decision: 'decision') and reported in
   * {@link RememberResponse.warnings}; an empty value is a 400.
   */
  subtype?: string;
  confidence?: number;
  agentId?: string;
  conversationId?: string;
  sensitivity?: Sensitivity;
  tags?: string[];
  /**
   * The session this write happened during. Correlation only (no FK).
   * Passing it is what lets the episodic collapse back-fill `episodeId` — the
   * canonical origin link — for every fact written during the session, so a
   * caller that supplies only this still ends up with real origin context.
   */
  sessionId?: string;
  /**
   * Attach the fact to an episode that ALREADY exists (post-hoc correction,
   * backfill, import). The normal path is `sessionId` + collapse.
   * An id that names no episode is dropped with a server-side warning and the
   * fact is still written — never a rejected write.
   */
  episodeId?: string;
  /**
   * kind 'fact' only: when the fact became true in the world (valid time), as
   * an ISO 8601 instant. Omitted, the server uses the time of the write. A
   * future instant answers 400; other kinds ignore it.
   */
  validFrom?: string;
  metadata?: Record<string, unknown>;
  /** Scope of the fact — default 'global'. */
  scope?: "global" | "conversation" | "personal";
  /** Project/entity ref for scoped recall (e.g. 'mnemosyne', 'project:abc'). */
  scopeRef?: string;
  /** Ownership level: 'workspace:<id>' | 'user:<id>' | 'tenant:<id>'. Default: workspace. */
  scopeOwner?: string;
  /**
   * Write to a different workspace than the one in the API key.
   * The key's user must be a member (write/admin/owner) of the target workspace.
   * Use memory_context to discover available workspace IDs.
   */
  targetWorkspaceId?: string;
  /**
   * Host-side pre-computed embedding. When supplied, the server skips its own
   * LLM embed pass and stores this vector directly. Must match the workspace's
   * recall embedding model (default: text-embedding-3-small, 1536 dims).
   */
  vector?: number[];
  /**
   * Idempotency key: a second `remember()` call with the same `topicKey`
   * updates the existing active row in place (revision bumped) instead of
   * creating a duplicate. Works for `kind: "fact"` and `kind: "decision"`.
   */
  topicKey?: string;
}

/**
 * One of the 3 verdict actions the server's §33 deterministic conflict
 * resolver can produce for a contradicting fact.
 *
 * Structural copy of `ConflictVerdictAction` (`@mnemo-ai/types`) — `client-ts`
 * does not depend on `@mnemo-ai/types`, it talks to the server over HTTP.
 */
export type ConflictVerdictAction = "supersede" | "reject" | "review";

/**
 * Structural copy of `RememberConflictCandidate` (`@mnemo-ai/types`).
 */
export interface RememberConflictCandidate {
  /** The EXISTING contradicting fact's id — never the newly written fact. */
  id: string;
  subject: string;
  statement: string;
  action: ConflictVerdictAction;
  /**
   * The pending `conflicts_with` relation id. THIS is the judgmentId passed
   * to `memory_judge action="resolve"` / `POST /conflicts/:id/resolve`.
   * Present only for "reject" | "review". Absent for "supersede" (already
   * auto-resolved).
   */
  relationId?: string;
}

/**
 * Structural copy of `RememberConflict` (`@mnemo-ai/types`).
 */
export interface RememberConflict {
  /** true iff at least one emitted candidate has action !== "supersede". */
  judgmentRequired: boolean;
  candidates: RememberConflictCandidate[];
}

/** Response from POST /memory/remember. */
export interface RememberResponse {
  id: string;
  workspaceId: string;
  actorId?: string;
  /**
   * The text that was STORED, which is not always the text you sent.
   *
   * P121: PII is redacted before the row is written, so a statement carrying a
   * phone number comes back with `[REDACTED-phone]` in its place. This used to
   * echo the request instead, which meant a later recall returned different
   * text than the write appeared to confirm — and the original is kept
   * nowhere, so there was no way to reconcile the two.
   */
  statement: string;
  status: string;
  /**
   * P121: present ONLY when PII was redacted out of `statement`. Its presence
   * is the signal — there is no empty-array case, so check existence, not
   * length.
   */
  redactedCategories?: string[];
  /** Omitted entirely when no contradiction was detected (not null, not {}). */
  conflict?: RememberConflict;
  /**
   * Q-3: present ONLY when part of the request was stored differently from
   * how it was sent. The write itself succeeded.
   */
  warnings?: RememberWarning[];
  [key: string]: unknown;
}

/**
 * One entry of {@link RememberResponse.warnings}. `subtype_substituted`: the
 * `subtype` is not in its kind's list and was stored as `storedAs`.
 */
export interface RememberWarning {
  code: "subtype_substituted";
  field: "subtype";
  received: string;
  storedAs: string;
  message: string;
}

/**
 * Input shape for `client.suggestTopicKey(...)`.
 *
 * Matches the server's `POST /topic-key/suggest` body exactly: both fields
 * optional, mirroring the fact `subject`/`statement` or decision
 * `title`/`body` shapes. Pure derivation — no I/O, no LLM/embedding call.
 */
export interface SuggestTopicKeyInput {
  subject?: string;
  body?: string;
  /**
   * What the fact is about, not its current value (e.g. "deploy method").
   * When given, the key comes from subject + attribute and `body` is ignored,
   * so an updated value gets the same key and supersedes the old one.
   */
  attribute?: string;
}

/**
 * Response from `POST /topic-key/suggest`. `topicKey` is deterministic and
 * idempotent: feeding a previously-suggested `topicKey` back in as `subject`
 * (with no `body`) returns it unchanged.
 */
export interface SuggestTopicKeyResponse {
  topicKey: string;
  /** 1 or 2 entries — the levels `topicKey` was assembled from. */
  levels: string[];
  source:
    | "identity"
    | "subject+body"
    | "subject"
    | "body"
    | "fallback"
    | "subject+attribute"
    | "attribute";
}

/**
 * Input shape for `client.compareFacts(...)`.
 *
 * Matches the server's `POST /facts/compare` body exactly: both ids
 * required, mirroring `memory_compare`'s `factIdA`/`factIdB` input.
 */
export interface CompareFactsInput {
  factIdA: string;
  factIdB: string;
}

/**
 * The suggested relation verb `compareFacts` can return. Deliberately a
 * 4-value subset of the full `RelationVerb` union — see
 * `packages/server/src/facts/compare.ts`'s doc comment for the decision
 * tree (`related` is never suggested, docs/archive/openspec/complete-mcp-tools B6).
 */
export type SuggestableVerb = "supersedes" | "conflicts_with" | "compatible" | "scoped";

/**
 * Response from `POST /facts/compare`. Both facts are returned in full
 * (the same `Fact` shape `getFact` returns) alongside the structured diff.
 */
export interface CompareFactsResponse {
  factA: Fact;
  factB: Fact;
  differences: string[];
  suggestedVerb: SuggestableVerb;
  sameSubject: boolean;
}

/**
 * Response from `client.createFact(...)`.
 *
 * `POST /facts` was deleted (flatten-legacy-dual-core D2 step 2) —
 * `createFact` now calls `POST /remember` under the hood and remaps its
 * `V3Fact` response back onto this legacy `Fact`-shaped contract
 * (`statement` -> `content`) so existing callers don't break. Widened
 * (flatten-legacy-dual-core D2 / task 5.6) with the optional `conflict`
 * field `V3Fact` carries — surfacing write-time §33 contradiction verdicts
 * is a capability gain, not something the old `POST /facts` route ever
 * returned, so it's additive-only.
 */
export interface CreateFactResponse extends Fact {
  /**
   * Write-time §33 contradiction verdicts. Present only when the server
   * detected a contradicting fact. When `judgmentRequired` is true, resolve
   * each candidate via `POST /conflicts/:id/resolve` (its `relationId`).
   */
  conflict?: RememberConflict;
}

/**
 * Input shape for `client.timeline(...)`.
 *
 * Mirrors the server's `TimelineQuerySchema` (GET /timeline), which
 * only reads `since` + `limit`. The server does NOT support kind/status
 * filters on this route, so we don't advertise no-op params.
 */
export interface TimelineInput {
  /** Server defaults to 100, caps at 500. */
  limit?: number;
  /** ISO 8601 — returns events strictly after this instant. Defaults to 24h ago. */
  since?: string;
}

/**
 * One event from `client.timeline()`.
 *
 * Mirrors the server's `TimelineEventSchema`: a fact-lifecycle event
 * (created / pinned / unpinned / closed / updated), NOT a fact snapshot.
 */
export interface TimelineEvent {
  id: string;
  /** ISO 8601 string — when the event happened. */
  at: string;
  kind:
    | "created"
    | "pinned"
    | "unpinned"
    | "closed"
    | "updated"
    | "decision_created"
    | "decision_superseded"
    | "decision_withdrawn";
  /** Present on fact events, absent on decision events. */
  factId?: string;
  /** Present on decision events only. */
  decisionId?: string;
  actor?: string;
  summary?: string;
  /** The userId of the key owner who originally stored the underlying fact (P11 attribution). */
  actorId?: string | null;
}

/** Response from `GET /timeline`. */
export interface TimelineResponse {
  events: TimelineEvent[];
  /** Opaque cursor for the next page — may be a timestamp or an id, or null. */
  nextCursor: string | null;
}

/**
 * Snapshot from `GET /health`. Includes more than a binary "ok" so
 * that operators can wire it into existing dashboards without a
 * separate metrics endpoint.
 */
export interface HealthSnapshot {
  status: "ok" | "degraded" | "down";
  version: string;
  /** Server-side time at response generation. ISO 8601. */
  timestamp: string;
  /** Optional sub-component statuses (db, embedder, queue, …). */
  components?: Record<string, "ok" | "degraded" | "down">;
}

/**
 * Response from `GET /health/ready`. Unauthenticated, instance-wide (not
 * scoped to any single workspace) — this is the ACTUAL per-dependency
 * (postgres/vector/cache) probe; `HealthSnapshot` above does not describe
 * any real route's wire shape.
 */
export interface HealthReadySnapshot {
  status: "ready" | "not_ready";
  /** Present only when status is "ready". True if vector or cache is non-ok (postgres down always maps to not_ready). */
  degraded?: boolean;
  checks?: { postgres: string; vector: string; cache: string };
  /** Present only when status is "not_ready" (e.g. "postgres_unavailable"). */
  reason?: string;
}

/**
 * Response from `POST /facts/:id/pin`.
 *
 * The server returns the updated `Fact` (with the new `pinned` value),
 * not a minimal {id, pinned} pair — match it.
 */
export type PinResponse = Fact;

/**
 * Result of `client.forgetFact(...)`.
 *
 * Forget maps to the server's soft-delete: DELETE /facts/:id, which
 * returns 204 No Content (empty body). There is nothing to parse, so the
 * method resolves to `void`.
 */
export type ForgetResponse = void;

/** Retry configuration for transient failures. */
export interface RetryConfig {
  /** Number of attempts INCLUDING the original. Default 3. */
  attempts?: number;
  /** Initial backoff in ms (doubles each attempt + jitter). Default 200. */
  initialDelayMs?: number;
  /**
   * Optional override of which errors are retryable. Default: 5xx and
   * network errors retry; 4xx and timeouts do not.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Input shape for `client.graph(...)`.
 *
 * Mirrors the server's `GraphQuerySchema` (GET /graph). When `focus`
 * is supplied, the server filters the returned set to that entity plus
 * its 1-hop neighbours (and the edges between them). Without it, the
 * full canonical workspace graph comes back.
 */
export interface GraphInput {
  /**
   * Optional entity id to centre the graph on: a `mnemo_entity.id`, which is
   * a UUID (e.g. `d0522e17-bd87-4ced-bc38-2b9a499beea7`), or a legacy
   * `ment_<slug>` seed id. Anything else is rejected with 400 by the server.
   */
  focus?: string;
  /** Overlay precomputed semantic-neighbor edges onto the graph. */
  includeSemantic?: boolean;
  /**
   * ISO 8601 timestamp. When supplied, returns the graph as it stood at
   * that instant — nodes and relations are filtered bitemporally so only
   * those that existed at `asOf` are included.
   */
  asOf?: string;
}

/** Input for `graphTraverse` — multi-hop BFS from a root node. */
export interface GraphTraverseInput {
  /** Entity/node id to start BFS traversal from. */
  root: string;
  /** Maximum hops (default 3, capped server-side at 5). */
  maxHops?: number;
  /** Restrict to these relation verbs; omit for all. */
  relations?: string[];
  /**
   * ISO 8601 timestamp for bitemporal reconstruction — only edges live at
   * this instant are followed.
   */
  asOf?: string;
}

/** One hit from a multi-hop traversal. */
export interface TraverseHit {
  /** Node id. */
  id: string;
  /** Minimum hop count from the root. */
  hop: number;
  /** decay^hop relevance score (default decay = 0.6). */
  relevance: number;
}

/** Input for `graphPath` — shortest path between two nodes. */
export interface GraphPathInput {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Maximum hops to search (default 4, capped server-side at 6). */
  maxHops?: number;
  /** ISO 8601 timestamp for bitemporal reconstruction. */
  asOf?: string;
}

/** Response from `graphPath`. */
export interface GraphPathResponse {
  /** Node ids from `from` to `to` inclusive. Empty array if unreachable. */
  path: string[];
  /** The relation verb traversed for each consecutive pair on the path. */
  edges: Array<{ source: string; target: string; relation: string }>;
}

/** One node in the Memory Graph. Mirrors `GraphNodeSchema`. */
export interface GraphNode {
  id: string;
  kind: "entity" | "episode" | "decision";
  entityKind?: "person" | "organization" | "project" | "concept" | "place" | "other";
  label: string;
  description?: string | null;
  /** Total mentions across conversation history. Drives node radius in the UI. */
  mentionCount: number;
  /** Linked-fact count. Drives the aura intensity in the UI. */
  factCount: number;
  /**
   * Average `memory_strength` across this node's facts (Hebbian
   * potentiation). Higher = more salient.
   */
  avgMemoryStrength: number;
  createdAt: string;
}

/** One edge in the Memory Graph. Mirrors `GraphEdgeSchema`. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Relation verb: related / conflicts_with / derived_from / supersedes / part_of / member_of / scoped / compatible / not_conflict. */
  relation: string;
  confidence: number;
  /** Free-form provenance string. May be null for system-inferred edges. */
  provenance: string | null;
}

/** Response from `GET /graph`. Mirrors `GraphResponseSchema`. */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    entityCount: number;
    episodeCount: number;
    decisionCount: number;
    relationCount: number;
  };
}

/**
 * The 6 entity kinds enforced by `mnemo_entity.kind` (Mnemosyne v1.6 G2).
 * Mirrors the server's `EntityKindEnum`. Intentionally narrow — broader
 * taxonomies (employee / vendor / customer / …) belong on the host side.
 */
export type EntityKind = "person" | "organization" | "project" | "concept" | "place" | "other";

/**
 * Canonical entity row. Mirrors `EntitySchema` in
 * `packages/server/src/routes/entities.ts`. Timestamps are ISO 8601
 * strings — JSON has no native Date.
 */
export interface MnemoEntity {
  id: string;
  workspaceId: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  /** Self-reference for merge. NULL = this row is canonical. */
  canonicalId: string | null;
  description: string | null;
  /** Access sensitivity tier — bumped to at least 'internal' automatically once linkedUserId is set. */
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  metadata: Record<string, unknown>;
  /**
   * The platform account (mnemo_user.id) this entity is ABOUT, when kind is
   * 'person' and it's been linked via `linkEntityUser`/`unlinkEntityUser`.
   * Deliberately distinct from provenance ("who wrote this row") — this is
   * "who this row is about". Only ever settable through those two calls,
   * never through `createEntity`/`updateEntity`.
   */
  linkedUserId?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Total mentions across conversation history. */
  mentionCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for `client.listEntities(...)`. */
export interface ListEntitiesInput {
  /** Optional kind filter. */
  kind?: EntityKind;
  /** Case-insensitive substring search across name + aliases. */
  q?: string;
  /** Max rows. Server caps at 200. */
  limit?: number;
}

/** Response from `GET /entities`. */
export interface ListEntitiesResponse {
  items: MnemoEntity[];
}

/** Response from `GET /entities/:id` (entity + linked-fact count). */
export interface EntityWithCount {
  entity: MnemoEntity;
  linkedFactCount: number;
}

/**
 * Rich fact projection — what entity- and episode-detail views render.
 * Distinct from the simplified {@link Fact} exposed by `GET /facts/:id`:
 * the rich shape carries the full cognitive fields (subject/statement/
 * kind/confidence) the Inspector UI needs. Mirrors the server's
 * `MemoryFactSchema`.
 */
export interface MemoryFact {
  id: string;
  workspaceId: string;
  agentId: string | null;
  scope: "global" | "conversation";
  scopeRef: string | null;
  kind: MemoryFactKind;
  subject: string;
  statement: string;
  confidence: number;
  pinned: boolean;
  relevance: number;
  hitCount: number;
  /** ISO 8601 or null if this fact has never been recalled yet. */
  lastRecalledAt: string | null;
  sourceMessageIds: string[];
  attributedTo: "user" | "assistant" | "system" | null;
  linkedMemoryIds: string[];
  metadata: Record<string, unknown>;
  status: "active" | "merged" | "forgotten";
  mergedIntoId: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * v1.4 — cognitive classification. Optional because legacy rows
   * predate the column; downstream consumers treat absence as 'semantic'.
   */
  memoryType?: "semantic" | "episodic" | "procedural" | "working";
  /**
   * v1.4 — per-conversation actor isolation. NULL = workspace-shared.
   * Optional because legacy rows predate the column.
   */
  actorId?: string | null;
}

/** Response from `GET /entities/:id/facts`. */
export interface EntityFactsResponse {
  entity: MnemoEntity;
  facts: MemoryFact[];
}

/** Input shape for `client.listEntityFacts(...)`. */
export interface ListEntityFactsInput {
  /** Max facts. Server caps at 500. */
  limit?: number;
}

/**
 * Episode (Mnemosyne v1.4 timeline primitive). Mirrors `EpisodeSchema`.
 * `occurredAt` is the canonical timestamp for sorting/filtering;
 * `createdAt` is when the extractor (or operator) inserted the row.
 */
export interface MnemoEpisode {
  id: string;
  workspaceId: string;
  title: string;
  narrative: string;
  occurredAt: string;
  durationMinutes: number | null;
  participants: string[];
  topics: string[];
  linkedFactIds: string[];
  sourceConversationId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /**
   * v2 — true for episodes auto-created by the extraction pipeline
   * (one per message turn / document / day). Inspector UI defaults to
   * hiding these; recall scoring still uses them.
   */
  isSynthetic: boolean;
}

/** Input shape for `client.listEpisodes(...)`. */
export interface ListEpisodesInput {
  /** ISO 8601. Server defaults to now-30d when omitted. */
  from?: string;
  /** ISO 8601. Server defaults to now when omitted. */
  to?: string;
  /** Single-topic filter via the GIN-indexed `topics` array. */
  topic?: string;
  /** Max episodes. Server caps at 200. */
  limit?: number;
  /** Include extractor-synthesised episodes. Defaults to false. */
  includeSynthetic?: boolean;
}

/** Response from `GET /episodes`. */
export interface ListEpisodesResponse {
  items: MnemoEpisode[];
}

/** Response from `GET /episodes/:id` (episode + linked facts). */
export interface EpisodeWithLinkedFacts {
  episode: MnemoEpisode;
  linkedFacts: MemoryFact[];
}

/** One entry in the response from `GET /episodes/:id/timeline`. */
export interface EpisodeTimelineEvent {
  kind: "episode_created" | "fact_linked" | "episode_closed";
  occurredAt: string;
  detail: Record<string, unknown>;
}

/** Response from `GET /episodes/:id/timeline`. */
export interface EpisodeTimelineResponse {
  events: EpisodeTimelineEvent[];
}

/**
 * Input shape for `client.createEntity(...)`. Mirrors the server's
 * `CreateEntitySchema`. Aliases ≤ 50 × ≤ 200 chars; the server
 * 400-rejects anything outside.
 */
export interface CreateEntityInput {
  name: string;
  kind: EntityKind;
  aliases?: string[];
  description?: string | null;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

/**
 * Input shape for `client.updateEntity(...)`. An empty patch (every
 * key undefined) is rejected with 400 — bailing early beats issuing
 * a no-op UPDATE that bumps `updatedAt`.
 */
export interface UpdateEntityInput {
  name?: string;
  kind?: EntityKind;
  aliases?: string[];
  /**
   * canonicalId is the merge knob: set to another entity's id to
   * mark this row as a redirect, set to null to mark it canonical
   * itself. Must exist in the same workspace and must NOT equal
   * the row being patched.
   */
  canonicalId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

/** Input shape for `client.linkEntityUser(...)`. */
export interface LinkEntityUserInput {
  /** The platform account (mnemo_user.id) to link. Must be a member of this workspace. */
  userId: string;
}

/**
 * Why a row was queued for human review. Mirrors the server's
 * `ReviewReasonEnum` (and the SQL CHECK on `mnemo_review_queue.reason`).
 */
export type ReviewReason = "low_confidence" | "contradiction" | "manual";

/** How the reviewer closed a queue row. */
export type ReviewResolution = "kept" | "edited" | "forgotten" | "dismissed";

/**
 * One row from the active-learning queue. Mirrors the server's
 * `ReviewQueueRowSchema` exactly. Either `factId` or `decisionId` is
 * non-null (fact-sourced vs decision-sourced row).
 */
export interface ReviewQueueRow {
  id: string;
  workspaceId: string;
  factId: string | null;
  decisionId: string | null;
  reason: ReviewReason;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: ReviewResolution | null;
}

/** Input shape for `client.listReview(...)`. */
export interface ListReviewInput {
  /** Filter by reason. Omit for all reasons. */
  reason?: ReviewReason;
  /**
   * When true, include resolved rows in addition to open ones.
   * Defaults to false (queue only).
   */
  all?: boolean;
  /** Max rows. Server caps at 200. */
  limit?: number;
}

/** Response from `GET /review`. */
export interface ListReviewResponse {
  items: ReviewQueueRow[];
}

/** Response from `GET /review/count`. */
export interface ReviewCountResponse {
  count: number;
}

/** Input shape for `client.resolveReview(...)`. */
export interface ResolveReviewInput {
  resolution: ReviewResolution;
}

/**
 * Response from `POST /review/:id/resolve`. `cascaded:true` only
 * when the reviewer picked 'forgotten' AND the row was fact-sourced —
 * the server atomically flips the fact's status to 'forgotten' in the
 * same tx so the fact leaves the recall pool without a follow-up
 * round-trip.
 */
export interface ResolveReviewResponse {
  id: string;
  resolution: ReviewResolution;
  factId: string | null;
  cascaded: boolean;
}

/**
 * One entry in the inspector's "Undo log" feed. Mirrors the server's
 * `AuditEntrySchema`. Synthesised from two sources (user-forgotten
 * facts and janitor-archived facts); the discriminant is `actorKind`.
 */
export interface AuditEntry {
  /** Prefixed key: `forget_<factId>` (live row) or `archive_<archiveId>`. */
  id: string;
  factId: string;
  factStatement: string;
  factSubject: string;
  factKind: string;
  /** Currently always 'forgotten' — only action synthesised today. */
  action: "forgotten";
  /** 'user' = clicked Forget; 'system' = janitor merge/prune. */
  actorKind: "user" | "system";
  actorName: string | null;
  /** ISO 8601 — fact.updatedAt or archive.archivedAt. */
  timestamp: string;
  /** True iff `client.restoreFact()` can reverse this entry. */
  revertible: boolean;
}

/** Input shape for `client.audit(...)`. */
export interface AuditInput {
  /** Max entries. Server caps at 100. */
  limit?: number;
}

/**
 * Response from `GET /audit`. `available:true` is always set — when
 * the underlying query fails the server returns a 5xx, not a degraded
 * payload. The legacy orchester surface used `available:false` for the
 * graceful-degrade UI state; the helper layers that on after the call.
 */
export interface AuditResponse {
  items: AuditEntry[];
  total: number;
  available: true;
}

/**
 * Response from `GET /export`. `meta` describes the dump; the four
 * data arrays carry raw row objects (snake_case columns from the
 * underlying SELECTs). Embeddings are excluded.
 */
export interface ExportResponse {
  meta: {
    workspaceId: string;
    exportedAt: string;
    rowCapPerResource: number;
    embeddingsExcluded: true;
  };
  facts: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
}

/** Response from `POST /facts/:id/restore` — minimal {id, status}. */
export interface RestoreFactResponse {
  id: string;
  status: "active";
}

/** Decision kind — mirrors the SQL CHECK on `mnemo_decision.kind`. */
export type DecisionKind =
  | "decision"
  | "architecture"
  | "policy"
  | "process"
  | "bugfix"
  | "learning"
  | "discovery"
  | "config";

/** Decision lifecycle status. */
export type DecisionStatus = "active" | "superseded" | "withdrawn";

/**
 * Decision row (Mnemosyne v1.5 — decisions as first-class memory
 * primitives). Mirrors the server's `DecisionSchema`. Embedding
 * vectors are NOT exposed (heavy + the client never needs them).
 */
export interface MnemoDecision {
  id: string;
  workspaceId: string;
  agentId: string | null;
  conversationId: string | null;
  kind: DecisionKind;
  title: string;
  body: string;
  topicKey: string | null;
  revisionCount: number;
  normalizedHash: string;
  decidedByUserId: string | null;
  status: DecisionStatus;
  supersededById: string | null;
  metadata: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for `client.listDecisions(...)`. */
export interface ListDecisionsInput {
  status?: DecisionStatus;
  /** Max rows. Server caps at 500. */
  limit?: number;
}

/** Response from `GET /decisions`. */
export interface ListDecisionsResponse {
  items: MnemoDecision[];
}

/** Mirrors `mnemo_fact.kind` (SQL CHECK). */
export type MemoryFactKind =
  | "preference"
  | "trait"
  | "event"
  | "relationship"
  | "skill"
  | "concern"
  | "architecture"
  | "bugfix"
  | "config"
  | "discovery"
  | "policy"
  | "process"
  | "other";

/** Mirrors `mnemo_fact.scope`. */
export type MemoryFactScope = "global" | "conversation" | "personal";

/** Input shape for `client.listFacts(...)`. */
export interface ListFactsInput {
  kind?: MemoryFactKind;
  scope?: MemoryFactScope;
  scopeRef?: string;
  /**
   * `'active'` (default) returns only currently-active facts. `'merged'`
   * / `'forgotten'` filter to that single status; `'all'` exposes the
   * full bitemporal view.
   */
  status?: "active" | "forgotten" | "merged" | "all";
  pinned?: boolean;
  /**
   * Optional full-text query. Matches `text_lemmatized` via
   * `plainto_tsquery(mnemosyne.mnemo_fts, q)` server-side, with an ILIKE fallback
   * on `statement` for legacy rows whose lemma column is null.
   */
  q?: string;
  /** Defaults to `'updated_at'`. */
  sortBy?: "created_at" | "updated_at" | "relevance" | "hit_count";
  /** Defaults to `'desc'`. */
  order?: "asc" | "desc";
  /**
   * Opaque base64url cursor returned by the previous page in
   * `nextCursor`. Omit to start from the top.
   */
  cursor?: string;
  /**
   * ISO 8601 bitemporal snapshot. Returns facts whose
   * `[validFrom, validTo)` interval contained `asOf`. Future timestamps
   * are rejected (400).
   */
  asOf?: string;
  /** Max rows. Server caps at 500. */
  limit?: number;
}

/** Response from `GET /facts`. */
export interface ListFactsResponse {
  items: MemoryFact[];
  /** Non-null when more rows follow this page. */
  nextCursor: string | null;
  /** Cheap COUNT(*) of rows matching the filter set (without the cursor). */
  total: number;
}

/** Input shape for `client.patchFact(...)`. */
export interface PatchFactInput {
  subject?: string;
  statement?: string;
  kind?: MemoryFactKind;
  pinned?: boolean;
  confidence?: number;
  relevance?: number;
  metadata?: Record<string, unknown>;
}

/** Response from `GET /facts/:id/citations`. */
export interface FactCitationsResponse {
  factId: string;
  /** Raw `source_message_ids` list — hosts join against their own message table. */
  sourceMessageIds: string[];
}

/** Input shape for `client.createDecision(...)`. */
export interface CreateDecisionInput {
  kind: DecisionKind;
  title: string;
  body: string;
  topicKey?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  decidedByUserId?: string | null;
  /** Project/entity scope reference — mirrors mnemo_fact.scope_ref. */
  scopeRef?: string | null;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

/** Input shape for `client.supersedeDecision(...)`. */
export interface SupersedeDecisionInput {
  /** Id of the new decision that supersedes this one. */
  supersededById: string;
}

/** Locked vocabulary of 9 relation verbs. */
export type RelationVerb =
  | "related"
  | "compatible"
  | "scoped"
  | "conflicts_with"
  | "supersedes"
  | "not_conflict"
  | "derived_from"
  | "part_of"
  | "member_of";

/** Mirrors `mnemo_relation.judgment_status`. */
export type JudgmentStatus = "pending" | "judged" | "dismissed";

/** Memory primitive a relation can connect. */
export type RelationKind = "fact" | "decision" | "entity" | "episode";

/** Who marked a relation. */
export type MarkerKind = "user" | "agent" | "system" | "llm_judge";

/**
 * Relation row. Mirrors the server's `RelationSchema`. Provenance is
 * NULL by default (LLM-derived); `'heuristic'` is reserved for system-
 * synthesised edges.
 */
export interface MnemoRelation {
  id: string;
  workspaceId: string;
  sourceKind: RelationKind;
  sourceId: string;
  targetKind: RelationKind;
  targetId: string;
  relation: RelationVerb;
  judgmentStatus: JudgmentStatus;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  markedByUserId: string | null;
  markedByKind: MarkerKind;
  markedByModel: string | null;
  markedByPromptVersion: string | null;
  provenance: string | null;
  conversationId: string | null;
  supersededByRelationId: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input shape for `client.listRelations(...)`. */
export interface ListRelationsInput {
  judgmentStatus?: JudgmentStatus;
  /** Only relations whose source is this id (CLIENTS-8). */
  sourceId?: string;
  /** Only relations whose target is this id; with `sourceId`, both must match. */
  targetId?: string;
  /** Include relations closed by a delete (history). Default: current only. */
  includeClosed?: boolean;
  /** Max rows. Server caps at 500. */
  limit?: number;
}

/** Response from `GET /relations`. */
export interface ListRelationsResponse {
  items: MnemoRelation[];
}

/** Input shape for `client.createRelation(...)`. */
export interface CreateRelationInput {
  sourceKind: RelationKind;
  sourceId: string;
  targetKind: RelationKind;
  targetId: string;
  relation: RelationVerb;
  judgmentStatus?: JudgmentStatus;
  reason?: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  markedByKind: MarkerKind;
  markedByUserId?: string | null;
  markedByModel?: string;
  markedByPromptVersion?: string;
  conversationId?: string | null;
}

/** Input shape for `client.patchRelation(...)` (judgment application). */
export interface PatchRelationInput {
  relation: RelationVerb;
  reason?: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  markedByKind: MarkerKind;
  markedByUserId?: string | null;
  markedByModel?: string;
  markedByPromptVersion?: string;
}

export interface TraverseRelationsInput {
  rootId: string;
  rootKind: RelationKind;
  maxDepth?: number;
  verbs?: RelationVerb[];
}

export interface TraverseRelationsResponse {
  nodes: Array<{ id: string; kind: RelationKind }>;
  edges: MnemoRelation[];
}

/** Memory primitive a citation can attach to. */
export type CitationMemoryKind = "fact" | "decision" | "entity" | "episode";

/** Where the citation came from. */
export type CitationSourceKind =
  "message" | "document" | "tool_call" | "llm_extraction" | "user_edit" | "agent_save" | "imported";

/** Citation row. Mirrors the server's `CitationSchema`. */
export interface MnemoCitation {
  id: string;
  workspaceId: string;
  memoryKind: CitationMemoryKind;
  memoryId: string;
  sourceKind: CitationSourceKind;
  sourceId: string | null;
  extractorModel: string | null;
  extractorPromptVersion: string | null;
  judgeModel: string | null;
  judgeRelationId: string | null;
  evidenceExcerpt: string | null;
  createdAt: string;
}

/** Input shape for `client.listCitations(...)`. */
export interface ListCitationsInput {
  memoryKind?: CitationMemoryKind;
  memoryId?: string;
  /** Max rows. Server caps at 500. */
  limit?: number;
}

/** Response from `GET /citations`. */
export interface ListCitationsResponse {
  items: MnemoCitation[];
}

/**
 * Input shape for `client.enqueueReview(...)`. Exactly one of
 * `factId`/`decisionId` must be supplied — the server 400-rejects
 * both-or-neither.
 */
export interface EnqueueReviewInput {
  factId?: string;
  decisionId?: string;
  reason: ReviewReason;
}

/**
 * Response from `POST /review/enqueue`. `inserted:false` means the
 * row was already open — the helper returns the existing id rather
 * than creating a duplicate (idempotent via the partial index).
 */
export interface EnqueueReviewResponse {
  id: string;
  inserted: boolean;
}

// ─── Session lifecycle ─────────────────────────────────────────────────────────

/**
 * Input shape for `client.createSession(...)`.
 *
 * Mirrors the server's `POST /session/start` request body
 * (StartSessionRequest in packages/server/src/routes/index.ts).
 */
export type TrafficOrigin = "organic" | "installer_verify" | "evaluation" | "unknown";
export type TurnOrigin =
  "human" | "agent_message" | "task_notification" | "pasted_content" | "assistant" | "unknown";

export interface CreateSessionInput {
  trafficOrigin?: TrafficOrigin;
  sourceSessionId?: string;
  sourceClientInstanceId?: string;
  sourceGeneration?: number;
  predecessorSessionId?: string;
  /** Agent identifier. Omit to use the workspace default. */
  agentId?: string;
  /** Human-readable label for the session, e.g. "Meeting 2026-06-13". */
  label?: string;
  /** Arbitrary metadata attached to the session row. */
  metadata?: Record<string, unknown>;
}

/**
 * Response from `POST /session/start`.
 *
 * Mirrors the server's `V3Session` output shape.
 */
export interface CreateSessionResponse {
  trafficOrigin?: TrafficOrigin;
  sourceSessionId?: string | null;
  sourceClientInstanceId?: string | null;
  sourceGeneration?: number | null;
  predecessorSessionId?: string | null;
  id: string;
  agentId: string | null;
  status: string;
  createdAt: string;
  label: string | null;
}

/**
 * Input shape for `client.collapseSession(...)`.
 *
 * Mirrors the server's `POST /session/:id/collapse` request body.
 */
export interface CollapseSessionInput {
  /**
   * "auto" — let the pipeline decide collapse strategy based on turn
   * recurrence signal (default). "explicit" — force full LLM extraction
   * even when the recurrence signal is below the threshold.
   */
  strategy?: "auto" | "explicit";
  /** Natural-language hint to guide LLM extraction during collapse. */
  collapseHint?: string;
}

/**
 * Response from `POST /session/:id/collapse`.
 *
 * The server returns 202 Accepted — collapse runs synchronously but
 * the response shape signals that the work is complete when it arrives.
 */
export interface CollapseSessionResponse {
  /**
   * The request was PROCESSED. It does not mean knowledge was extracted —
   * read `status` for that. P115 exists because these two were conflated.
   */
  accepted: boolean;
  sessionId: string;
  /**
   * `collapse_pending` — an archived managed session was accepted for retry.
   * `completed` — the pipeline extracted knowledge. `skipped` — it did NOT,
   * and `skipReason` says why. `failed` — extraction errored.
   *
   * Optional only for wire-compatibility with a server older than P115;
   * every current server sends it. Treat a missing value as `completed`.
   */
  status?: "collapse_pending" | "skipped" | "completed" | "failed";
  /** Present when the collapse pipeline was skipped. */
  skipReason?: "too_few_turns" | "low_recurrence_signal" | "llm_unavailable" | "no_pin";
  /** True when an idempotent retry short-circuited already-completed phases (§RDD9). */
  resumed?: boolean;
}

/**
 * Response from `GET /session/:id` and each entry of
 * `GET /session/list`. Mirrors the server's `SessionOut` schema.
 */
export interface SessionWire {
  id: string;
  agentId: string | null;
  status: string;
  createdAt: string;
  label: string | null;
  /**
   * autonomous-memory Requirement 1/4: ISO timestamp of the most recent
   * `POST /recall` call that supplied this session's id as `sessionId`,
   * or `null` if none has.
   */
  lastRecallAt?: string | null;
}

/** Response from `GET /session/list`. */
export interface ListSessionsResponse {
  sessions: SessionWire[];
}

// ─── Session turns ───────────────────────────────────────────────────────────

/**
 * Input shape for `client.appendTurn(...)`.
 *
 * Maps to `POST /session/:id/turn`. Returns 204 No Content (void).
 */
export interface AppendTurnInput {
  sourceMessageId?: string;
  sourceGeneration?: number;
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  /** Conversation role — typically "user" or "assistant". */
  role: string;
  /** Text content of the turn. */
  content: string;
  // APP-018: no `metadata` or `turnId`: a turn row has no column for them and
  // the server answers 400 to either.
}

/**
 * Input shape for `client.pinSessionTurn(...)`.
 *
 * Maps to `POST /session/:id/pin`. Returns 204 No Content (void).
 */
export interface PinSessionTurnInput {
  /**
   * The ID of the turn to pin or unpin. Supply this OR `turnIndex`, never both
   * and never neither — the route rejects any other combination.
   */
  turnId?: string;
  /**
   * The turn's ordinal position in the session (0-based). The alternative
   * selector to `turnId`, for callers that have a position rather than an id.
   */
  turnIndex?: number;
  /** `true` to pin the turn; `false` to unpin. */
  pinned: boolean;
}

// ─── Consolidation ───────────────────────────────────────────────────────────

/**
 * Input for `client.triggerConsolidation(...)`.
 *
 * Maps to the body of `POST /consolidation/trigger`.
 */
export interface TriggerConsolidationInput {
  /**
   * `fast` (default): process a bounded low-worth candidate set.
   *
   * Manual `deep` requests currently return HTTP 422 with code
   * `deep_mode_not_supported`. The field remains public for compatibility.
   */
  mode?: "fast" | "deep";
  /**
   * Must currently be false. A true value returns HTTP 422 with code
   * `dry_run_not_supported` without running consolidation. The field remains
   * public for compatibility.
   */
  dryRun?: boolean;
}

/**
 * Response from `POST /consolidation/trigger`.
 */
export interface TriggerConsolidationResponse {
  accepted: boolean;
  workspaceId: string;
  mode: "fast";
  dryRun: false;
  /** Gate-passed pairs merged this tick. */
  mergedPairs: number;
  /** Gate-failed or ineligible pairs skipped. */
  skippedPairs: number;
  /** Total candidate facts fetched and inspected. */
  candidatesProcessed: number;
  /** Number of non-fatal per-fact errors encountered. */
  errors: number;
  /** Wall-clock time the server spent on the pass (milliseconds). */
  tookMs: number;
}

// ── Task wire shapes ─────────────────────────────────────────────────────────

export interface TaskWire {
  id: string;
  workspaceId: string;
  title: string;
  description?: string;
  status: "pending" | "in_progress" | "blocked" | "delegated" | "completed" | "cancelled";
  priority: "critical" | "high" | "medium" | "low";
  assignedTo: string;
  delegatedBy?: string;
  parentTaskId?: string;
  blockedBy: string[];
  subtaskIds: string[];
  relatedFacts: string[];
  relatedEntities: string[];
  sessionId?: string;
  outcome?: string;
  lessonsLearned?: string;
  delegatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface PaginatedTasksResponse {
  items: TaskWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Event wire shapes ────────────────────────────────────────────────────────

export interface EventAnnotationWire {
  author: string;
  content: string;
  at: string;
}

export interface EventWire {
  id: string;
  workspaceId: string;
  type: "system" | "external" | "user" | "agent" | "scheduled";
  name: string;
  description: string;
  occurredAt: string;
  durationS?: number;
  source: string;
  relatedEntities: string[];
  annotations: EventAnnotationWire[];
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  createdAt: string;
  metadata: Record<string, unknown>;
}

/** Input shape for `client.updateEventSensitivity(...)`. Raise-only — the server 422s a lowering attempt. */
export interface UpdateEventSensitivityInput {
  sensitivity: "public" | "internal" | "confidential" | "restricted";
}

export interface PaginatedEventsResponse {
  items: EventWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Reasoning wire shapes ────────────────────────────────────────────────────

export interface ChainStepWire {
  step: number;
  reasoning: string;
  conclusion?: string;
}

export interface ReasoningWire {
  id: string;
  workspaceId: string;
  agentId?: string;
  question: string;
  chain: ChainStepWire[];
  conclusion: string;
  successCount: number;
  failureCount: number;
  worth: number;
  topicKey?: string;
  status: "active" | "archived" | "pruned";
  lastUsedAt?: string;
  usageCount: number;
  validFrom?: string;
  validTo?: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface PaginatedReasoningResponse {
  items: ReasoningWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Task input types ─────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: "critical" | "high" | "medium" | "low";
  assignedTo: string;
  sessionId?: string;
  parentTaskId?: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

export interface PatchTaskInput {
  title?: string;
  description?: string;
  status?: "pending" | "in_progress" | "blocked" | "delegated" | "completed" | "cancelled";
  priority?: "critical" | "high" | "medium" | "low";
  assignedTo?: string;
  blockedBy?: string[];
  subtaskIds?: string[];
  outcome?: string;
  lessonsLearned?: string;
  startedAt?: string;
  completedAt?: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
}

// ── Event input types ────────────────────────────────────────────────────────

export interface CreateEventInput {
  type: "system" | "external" | "user" | "agent" | "scheduled";
  name: string;
  description: string;
  occurredAt: string;
  durationS?: number;
  source: string;
  relatedEntities?: string[];
  annotations?: { author: string; content: string; at: string }[];
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

// ── Reasoning input types ────────────────────────────────────────────────────

export interface CreateReasoningInput {
  question: string;
  chain: ChainStepWire[];
  conclusion: string;
  agentId?: string;
  topicKey?: string;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

export interface PatchReasoningInput {
  status?: "active" | "archived" | "pruned";
  chain?: ChainStepWire[];
  conclusion?: string;
  metadata?: Record<string, unknown>;
}

export interface ResolveReasoningInput {
  query: string;
  topicKey?: string;
}

export interface ResolveReasoningResponse {
  action: "hit" | "execute";
  reasoning_id?: string;
  cached_cot?: ChainStepWire[];
  conclusion?: string;
  suggested_model?: "haiku";
  similar_attempts?: Array<{ reasoning_id: string; cosine: number }>;
}

export interface RecordReasoningInput {
  agentId?: string;
  question: string;
  chain: ChainStepWire[];
  conclusion: string;
  topicKey?: string;
  outcome?: "success" | "fail";
  metadata?: Record<string, unknown>;
  /** Stored on a new chain; a near-duplicate upsert keeps the existing one's. */
  sensitivity?: Sensitivity;
}

export interface ReasoningFeedbackInput {
  reasoning_id: string;
  outcome: "success" | "fail";
}

// ── List query types ─────────────────────────────────────────────────────────

export interface ListTasksParams {
  status?: "pending" | "in_progress" | "blocked" | "delegated" | "completed" | "cancelled";
  assignedTo?: string;
  parentTaskId?: string;
  limit?: number;
  offset?: number;
}

export interface ListEventsParams {
  type?: "system" | "external" | "user" | "agent" | "scheduled";
  source?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

export interface ListReasoningParams {
  status?: "active" | "archived" | "pruned";
  topicKey?: string;
  limit?: number;
  offset?: number;
}

// ── Strategy wire shapes ─────────────────────────────────────────────────────

export interface StrategyWire {
  id: string;
  workspaceId: string;
  agentId?: string;
  trigger: string;
  action: string;
  context?: string;
  successCount: number;
  failureCount: number;
  worth: number;
  supersedesId?: string;
  status: "active" | "superseded" | "archived";
  embeddingStale: boolean;
  validFrom: string;
  validTo?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface PaginatedStrategiesResponse {
  items: StrategyWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface CreateStrategyInput {
  agentId?: string;
  trigger: string;
  action: string;
  context?: string;
  /** Project/entity scope reference — mirrors mnemo_fact.scope_ref. */
  scopeRef?: string;
  supersedesId?: string;
  validFrom?: string;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

export interface PatchStrategyInput {
  trigger?: string;
  action?: string;
  context?: string;
  status?: "active" | "superseded" | "archived";
  validTo?: string;
  metadata?: Record<string, unknown>;
}

export interface ListStrategiesParams {
  status?: "active" | "superseded" | "archived";
  /** When set, return records with scope_ref = X OR scope_ref IS NULL. */
  scopeRef?: string;
  validAt?: string;
  offset?: number;
  limit?: number;
}

// ── Hyperedge wire shapes ────────────────────────────────────────────────────

export interface HyperedgeWire {
  id: string;
  workspaceId: string;
  memberIds: string[];
  label?: string;
  description?: string;
  contextQuery?: string;
  activationCount: number;
  worth: number;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export interface PaginatedHyperedgesResponse {
  items: HyperedgeWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Hyperedge input types ────────────────────────────────────────────────────

export interface CreateHyperedgeInput {
  memberIds: string[];
  label?: string;
  description?: string;
  contextQuery?: string;
}

export interface PatchHyperedgeInput {
  label?: string;
  description?: string;
  contextQuery?: string;
}

export interface ListHyperedgesParams {
  memberId?: string;
  label?: string;
  limit?: number;
  offset?: number;
}

// ─── Federation ──────────────────────────────────────────────────────────────

/**
 * One remote Mnemosyne peer as `GET /memory/federation/peers` shows it. The
 * server never returns the peer's pull key or symmetric key, only whether they
 * are set.
 */
export interface PeerConfig {
  peerId: string;
  /** SHA-256 (hex) of the pinned DER certificate. */
  certFingerprint: string;
  /** Local voting weight, 0 to 1. */
  trustWeight: number;
  /** ISO 8601 — when the current pin was approved. */
  approvedAt: string;
  enabled: boolean;
  url?: string;
  /** The peer's Ed25519 public key, PEM. */
  signingPublicKey?: string;
  hasApiKey: boolean;
  hasSymmetricKey: boolean;
}

/** Response from `GET /memory/federation/peers`. */
export interface ListPeersResponse {
  peers: PeerConfig[];
}

/** Response from `GET /memory/federation/peers/pending`. */
export interface ListPendingPeersResponse {
  peers: PeerConfig[];
  discovery: {
    enabled: boolean;
    reason?: string;
  };
}

/** Body for `POST /memory/federation/peers`. Unknown fields are refused. */
export interface CreatePeerInput {
  /** Domain or UUID, e.g. `"acme.example"`. */
  peerId: string;
  /** The peer's pinned DER certificate (or SPKI key), base64. */
  pinnedCertDer: string;
  /** Local voting weight, 0 to 1. */
  trustWeight: number;
  /** Defaults to true. */
  enabled?: boolean;
  /** The peer's base URL (https), used to pull its items. */
  url?: string;
  /** API key this server sends when pulling from the peer. */
  apiKey?: string;
  /** The peer's Ed25519 public key, PEM. Goes with `symmetricKey`. */
  signingPublicKey?: string;
  /** Shared 32-byte key, base64. Goes with `signingPublicKey`. */
  symmetricKey?: string;
}

/** Response from `POST /memory/federation/peers` (201). */
export interface CreatePeerResponse {
  created: true;
  peerId: string;
  /** ISO 8601, server time. */
  approvedAt: string;
}

/** Body for `POST /memory/federation/peers/:id/approve` and `/approve-key`. */
export interface ApprovePeerInput {
  /** DER-encoded new certificate, base64. */
  newCertDer: string;
  /** ISO 8601. Defaults to server time if omitted. */
  issuedAt?: string;
}

/** Response from `POST /memory/federation/peers/:id/approve-key`. */
export interface ApprovePeerKeyResponse {
  approved: boolean;
  peerId: string;
  approvedAt: string;
}

/** Response from `DELETE /memory/federation/peers/:id`. */
export interface DeletePeerResponse {
  deleted: true;
  peerId: string;
}

/** One fact as `GET /memory/federation/items` serves it to a peer. */
export interface FederationItem {
  /** The fact's id on the serving server. */
  remoteId: string;
  /** The fact's revisionCount: every edit raises it. 0 on a hard-deleted fact's tombstone. */
  version: number;
  /** Host name of the request URL on the serving server. */
  peerDomain: string;
  /** Set on a tombstone (forgotten, merged or deleted fact): the day, ISO 8601 at UTC midnight. */
  deletedAt?: string;
  /** Empty on a tombstone. */
  payload: FederationItemPayload | Record<string, never>;
}

export interface FederationItemPayload {
  statement: string;
  kind: "objective_fact";
  attribution: "federation_received";
  sensitivity: string;
  /** ISO 8601 */
  validFrom: string;
  /** ISO 8601, or null while the fact is current. */
  validTo: string | null;
}

/** An item of the signed envelope: `payload` is sealed (AES-256-GCM). */
export interface SealedFederationItem extends Omit<FederationItem, "payload"> {
  sealed: { iv: string; tag: string; ct: string };
}

/**
 * Response from `GET /memory/federation/items`: plaintext, or a signed envelope
 * with sealed payloads when the serving server has app-layer crypto configured.
 * `nextCursor` resumes after the page (pass it as `cursor`); null when the page
 * read nothing.
 */
export type ListFederationItemsResponse =
  | { items: FederationItem[]; nextCursor: string | null }
  | {
      alg: "ed25519+aes-256-gcm";
      signature: string;
      items: SealedFederationItem[];
      nextCursor: string | null;
    };

/** Body for `POST /memory/federation/sync`. */
export interface TriggerFederationSyncInput {
  peerId: string;
}

/** Response from `POST /memory/federation/sync` (202 Accepted). */
export interface TriggerFederationSyncResponse {
  jobId: string;
  status: "pending";
}

/** One federation sync job record. */
export interface FederationSyncJob {
  jobId: string;
  peerId: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string | null;
  completedAt?: string | null;
  error?: string | null;
  itemsProcessed?: number;
}

/** One conflict claim for `POST /memory/federation/resolve`. */
export interface FederationClaim {
  id: string;
  content: string;
  version: number;
  attribution?: Record<string, unknown>;
  worth?: number;
}

/** Body for `POST /memory/federation/resolve` — two-item shorthand. */
export interface ResolveFederationConflictPairInput {
  itemA: FederationClaim;
  itemB: FederationClaim;
}

/** Body for `POST /memory/federation/resolve` — batch form. */
export interface ResolveFederationConflictBatchInput {
  items: FederationClaim[];
}

/** Response from `POST /memory/federation/resolve`. */
export interface ResolveFederationConflictResponse {
  /** Present when a clear winner was determined. */
  winner?: FederationClaim;
  /** Present when a clear loser was determined. */
  loser?: FederationClaim;
  /** When batch form resolves to a single outcome. */
  outcome?: FederationClaim;
  strategy: string;
  /** ISO 8601 */
  resolvedAt: string;
}

// ─── Anticipation feed typed return ──────────────────────────────────────────

/** One anticipated memory from the Anticipation Engine (§30). */
export interface AnticipatedMemory {
  factId: string;
  score: number;
  source: "sequential" | "periodic" | "conditional" | "co-occurrence" | "blended";
  confidence: number;
  /** Optional short explanation for why this memory was surfaced. */
  reason?: string;
}

/** Response from `GET /anticipation`. */
export interface AnticipationFeedResponse {
  items: AnticipatedMemory[];
  generatedAt: string;
}

// ─── Composition typed returns ────────────────────────────────────────────────

/** One composition rule in the workspace. */
export interface CompositionRule {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  conditionDsl: unknown;
  actionDsl: unknown;
  priority: number;
  isActive: boolean;
  source: "manual" | "mined" | "imported";
  executionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Paginated list of composition rules. */
export interface ListCompositionRulesResponse {
  items: CompositionRule[];
  total: number;
  offset: number;
  limit: number;
}

/** One derived inference from the dry-run endpoint. */
export interface DerivedInference {
  type: "fact" | "warning";
  statement: string;
  confidence: number;
  ruleId: string;
  ruleName: string;
  hop: number;
  premises: string[];
}

/** Response from `POST /composition/dry-run`. */
export interface CompositionDryRunResponse {
  fired: number;
  inferences: DerivedInference[];
  conflicts: Array<{
    winner: DerivedInference;
    dropped: DerivedInference[];
  }>;
}

// ─── selfEdit typed return ────────────────────────────────────────────────────

export type SelfEditAction =
  | "append"
  | "replace"
  | "strengthen"
  | "weaken"
  /**
   * @deprecated Server-side gated (422 `self_edit_forget_unsupported`) as of
   * B4 — no approval flow exists to resolve it. Kept in the type so the 422
   * response stays typed/observable for existing callers instead of a hard
   * compile break. Use `forgetFact`/`forgetPrimitive` (kind: "fact" | "strategy") instead.
   */
  | "forget"
  | "reflect"
  | "link";
export type SelfEditTargetKind = "fact" | "strategy" | "profile";

interface AppliedSelfEditBase {
  applied: true;
  target: string;
  targetKind: SelfEditTargetKind;
  countsAsEdit: boolean;
  countsAsDelete: boolean;
}

export interface AppliedFactReplaceResponse extends AppliedSelfEditBase {
  action: "replace";
  targetKind: "fact";
  replacementId: string;
}

export interface AppliedNonFactReplaceResponse extends AppliedSelfEditBase {
  action: "replace";
  targetKind: "strategy" | "profile";
  replacementId?: never;
}

export interface AppliedNonReplaceResponse extends AppliedSelfEditBase {
  action: Exclude<SelfEditAction, "replace" | "reflect">;
  replacementId?: never;
}

export interface SelfEditApprovalResponse {
  applied: false;
  action: SelfEditAction;
  target: string;
  targetKind: SelfEditTargetKind;
  approvalRequired: true;
  scope: "delete_fact" | "edit_entity";
  reason: string;
  replacementId?: never;
}

export interface SelfEditReflectionResponse {
  applied: true;
  action: "reflect";
  episode_id: string;
  strengthened: string[];
  weakened: string[];
  replacementId?: never;
}

/** Discriminated response from `POST /self/edit`. */
export type SelfEditResponse =
  | AppliedFactReplaceResponse
  | AppliedNonFactReplaceResponse
  | AppliedNonReplaceResponse
  | SelfEditApprovalResponse
  | SelfEditReflectionResponse;

// ─── WebSocket subscription ───────────────────────────────────────────────────

/**
 * Options for `client.subscribe(channel, handler, opts?)`.
 *
 * Internally the SDK opens a WebSocket to `ws[s]://…/memory/ws?token=<apiKey>`.
 * Requires the runtime to support `WebSocket` (Node ≥ 22 ships a native global;
 * older environments must polyfill with e.g. `ws`).
 */
export interface SubscribeOptions {
  /** Optional entity/agent/memoryType filter forwarded to the server. */
  filter?: {
    entityId?: string;
    agentId?: string;
    memoryType?: string;
  };
  /**
   * Called when the WS disconnects. Return `true` to attempt a reconnect
   * (the SDK will NOT reconnect automatically by default).
   */
  onDisconnect?: (reason: string) => boolean | undefined;
  /** Optional WebSocket constructor — inject for Node < 22 or testing. */
  WebSocketImpl?: typeof WebSocket;
}

/** Handle returned by `client.subscribe(...)`. */
export interface SubscribeHandle {
  /** Close the WebSocket subscription. */
  close(): void;
  /** True while the socket is open. */
  readonly connected: boolean;
}

// ─── §31 Meta-Cognition ───────────────────────────────────────────────────────

export type SelfModelAspect = "coverage" | "trends" | "gaps" | "strengths" | "all";

export interface SelfModelResponse {
  workspaceId: string;
  generatedAt: string;
  strongTopics: Array<{
    topicKey: string;
    memoryCount: number;
    avgWorth: number;
    evidenceVolume: number;
  }>;
  gaps: Array<{
    topicKey: string;
    gapScore: number;
    recallHits30d: number;
    avgWorth: number;
    memoryCount: number;
  }>;
  summary: {
    totalTopics: number;
    strongTopicsCount: number;
    gapsCount: number;
    avgWorthAcrossWorkspace: number;
  };
}

// ─── Doctor diagnostic report ────────────────────────────────────────────────

/**
 * Status for a single diagnostic check.
 * `"ok"` — check passed. `"warn"` — check returned a warning. `"error"` — check
 * failed. `"unknown"` — check could not determine its own result (e.g. permission
 * denied before the query ran).
 */
export type DoctorCheckStatus = "ok" | "warn" | "error" | "unknown";

/**
 * One diagnostic check result in a `DoctorReport`.
 */
export interface DoctorCheck {
  /** Stable machine-readable check identifier (e.g. "connectivity", "app_user_grants"). */
  name: string;
  /** Check outcome. */
  status: DoctorCheckStatus;
  /** Human-readable explanation of the outcome. */
  message: string;
  /** Optional numeric / structured detail (e.g. backlog count, migration filename). */
  detail?: Record<string, unknown>;
}

/**
 * Full operational diagnostic report returned by `GET /doctor` and the
 * `memory_doctor` MCP tool.
 *
 * `status` is the worst-of all checks: if any check is `"error"` the overall
 * status is `"error"`; if any is `"warn"` (and none are `"error"`) the overall
 * status is `"warn"`; otherwise `"ok"`.
 */
export interface DoctorReport {
  /** Worst-of status across all checks. */
  status: DoctorCheckStatus;
  /** Individual check results. */
  checks: DoctorCheck[];
  /** ISO 8601 timestamp of report generation. */
  timestamp: string;
}

// ─── P4-D: Conflict resolution (memory_judge) ────────────────────────────────

/**
 * Condensed fact summary inside a conflict pair.
 * Mirrors `ConflictFact` from `packages/server/src/routes/conflicts.ts`.
 */
export interface ConflictFact {
  id: string;
  subject: string;
  statement: string;
  worth: number;
  validFrom: string;
  validTo: string | null;
}

/**
 * One unresolved conflict pair — two facts linked by a `conflicts_with`
 * relation, surfaced for interactive LLM judgment.
 */
export interface ConflictPair {
  relationId: string;
  confidence: number | null;
  factA: ConflictFact;
  factB: ConflictFact;
}

/** Response from `GET /conflicts`. */
export interface ListConflictsResponse {
  pairs: ConflictPair[];
  /** Every unresolved pair the caller can see, `limit` aside. Optional: older servers omit it. */
  total?: number;
}

/** Input to `POST /conflicts/:id/resolve`. */
export interface ResolveConflictInput {
  /** How to resolve the conflict. */
  action: "supersede_a" | "supersede_b" | "keep_both" | "merge";
  /**
   * Required when `action='merge'`. The statement for the new merged fact
   * that replaces both conflicting facts.
   */
  mergedStatement?: string;
}

/** Response from `POST /conflicts/:id/resolve`. */
export interface ResolveConflictResponse {
  resolved: boolean;
  action: "supersede_a" | "supersede_b" | "keep_both" | "merge";
  relationId: string;
  /** ID of the newly created merged fact; null unless action='merge'. */
  mergedFactId: string | null;
}

// ─── P5-B: Workspace statistics (memory_stats) ───────────────────────────────

/**
 * Aggregate workspace statistics returned by `GET /admin/stats` and the
 * `memory_stats` MCP tool.
 *
 * Mirrors the `AdminStatsSchema` from `packages/server/src/routes/admin-stats.ts`.
 */
export interface AdminStats {
  workspaceId: string;
  /** ISO 8601 timestamp of when the stats snapshot was generated. */
  generatedAt: string;
  facts: {
    /** Active facts with an open validity interval (validTo IS NULL). */
    live: number;
    /** Facts whose validity was closed by a `forget()` call. */
    closed: number;
    /** Facts with `pinned = true`. */
    pinned: number;
    /**
     * Facts archived by the janitor, or null when no usable snapshot exists
     * (cold start / stale). make-primitives-recallable Requirement 5: this
     * count MUST NOT fall back to `0` when the snapshot is absent — check
     * `snapshot.available` to tell "zero" apart from "unavailable".
     */
    archived: number | null;
    /**
     * Active facts that have never been recalled (hit_count = 0), or null
     * when no usable snapshot exists. See `archived`'s doc comment.
     * Admin only (omitted for memory:read callers).
     */
    withZeroHits?: number | null;
    /**
     * Live fact counts per scopeRef. Only entries with a non-null scopeRef.
     * Admin only (omitted for memory:read callers).
     */
    byScopeRef?: Array<{ scopeRef: string; count: number }>;
  };
  decisions: {
    /**
     * Decisions with status = 'active', or null when no usable snapshot
     * exists. See `facts.archived`'s doc comment.
     */
    active: number | null;
  };
  relations: {
    /**
     * Relations with verb = 'conflicts_with', or null when no usable
     * snapshot exists. See `facts.archived`'s doc comment.
     */
    conflicts: number | null;
  };
  /** Admin only (omitted for memory:read callers). */
  embeddings?: {
    /** Facts with an up-to-date embedding vector. */
    indexed: number;
    /** Facts awaiting embedding. */
    pending: number;
  };
  /**
   * The `mnemo_health` snapshot backing the four nullable counts above.
   * make-primitives-recallable Requirement 5.
   * Admin only (omitted for memory:read callers).
   */
  snapshot?: {
    /** ISO 8601 timestamp the snapshot was computed at, or null if absent. */
    at: string | null;
    /** Snapshot age in seconds, or null if absent. */
    ageSeconds: number | null;
    /** False when no usable snapshot exists (cold start / stale read). */
    available: boolean;
  };
  recall: {
    /** 30-day recall hit rate (0–1), or null if no recall data yet. */
    hitRate30d: number | null;
    /** ISO 8601 timestamp of the last recall query, or null. */
    lastRecallAt: string | null;
    /**
     * Recall latency percentiles over the last 7 days, null with no samples.
     * One sample per served memory, not per request; recalls that served
     * nothing are not counted.
     */
    latencyP50Ms7d?: number | null;
    latencyP95Ms7d?: number | null;
  };
  /** Facts created per UTC day, last 14 days, oldest first, zero-filled. */
  writesPerDay14d?: Array<{ day: string; count: number }>;
  /** ISO 8601 timestamp of the last write to the workspace, or null. */
  lastWriteAt: string | null;
}

// ── P5-C: Hard-delete / purge ─────────────────────────────────────────────────

/**
 * Response from `DELETE /facts/:id/hard`.
 * Hard-deletes a single fact by ID (requires `memory:hard_delete` scope).
 */
export interface PurgeFactResponse {
  deleted: true;
}

/**
 * Response from `DELETE /facts/purge`.
 * Bulk-deletes all closed (forgotten) facts in the workspace.
 * Requires `memory:hard_delete` scope.
 */
export interface PurgeClosedFactsResponse {
  deleted: number;
}

/**
 * Body of `POST /admin/erasure` (GDPR crypto-erasure). Exactly one of
 * `userId`/`actorId`; `confirm` must repeat it.
 */
export interface EraseSubjectInput {
  userId?: string;
  actorId?: string;
  confirm: string;
}

/** Response from `POST /admin/erasure`. */
export interface EraseSubjectResponse {
  subject: { kind: "user" | "actor"; id: string };
  keysDestroyed: number;
}

// ── P7: Key management ────────────────────────────────────────────────────────

/** Metadata for an API key in the list response. */
export interface KeyListItem {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  plan: string;
  ipAllowlist: string[];
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  maxSensitivity?: string | null;
}

/** Input payload for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  scopes: string[];
  expiresIn?: string;
  ipAllowlist?: string[];
  plan?: "free" | "pro" | "enterprise";
  test?: boolean;
  maxSensitivity?: Sensitivity;
  /**
   * Issue an `mk_fed_` key: the bearer a federation peer pulls from this server
   * with. Scopes must be exactly `["memory:federation"]`.
   */
  federation?: boolean;
  /** workspace (default, single workspace) or user (multi-workspace user token). */
  keyKind?: "workspace" | "user" | "tenant" | "admin";
}

/** Response from API key creation — plaintext key is shown ONCE. */
export interface CreateKeyResponse {
  id: string;
  key: string;
  label: string;
  scopes: string[];
  plan: string;
  expiresAt: string | null;
  createdAt: string;
  maxSensitivity?: string | null;
}

/** Metadata for a single API key detail response. */
export interface KeyDetailResponse {
  id: string;
  label: string;
  scopes: string[];
  ipAllowlist: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  deprecatedAt: string | null;
  rotatedFromId: string | null;
  createdAt: string;
  maxSensitivity?: string | null;
}

/** Response from key rotation. */
export interface RotateKeyResponse {
  newKey: string;
  newKeyId: string;
  oldKeySunsetAt: string;
}

/**
 * Input for `issueScopedKey` (`POST /admin/scoped-keys`): a key of the scoped
 * scheme MNEMO_SCOPED_AUTH=1 verifies. `type` defaults to "live".
 */
export interface IssueScopedKeyInput {
  /** live: mk_live_ (90 days at most), sess: mk_sess_ (24 h), admin: mk_admin_ (24 h, TOTP). */
  type?: "live" | "sess" | "admin";
  scopes: string[];
  /** 30d, 8h, 60m. Defaults to the type's maximum. */
  expiresIn?: string;
  ipAllowlist?: string[];
  maxSensitivity?: Sensitivity;
}

/** Response of `issueScopedKey`: `key` and `mfaSecret` are shown once. */
export interface IssueScopedKeyResponse {
  /** Public id, `{prefix}{keyId}`: what rotate and revoke take. */
  id: string;
  key: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  maxSensitivity: string | null;
  /** mk_admin_ only: base32 TOTP secret; send codes in `x-mnemo-mfa`. */
  mfaSecret?: string;
  /** mk_admin_ only: the secret as an otpauth:// URI. */
  otpauthUri?: string;
}

/** Response of `rotateScopedKey`. The old key works until `oldKeySunsetAt`. */
export interface RotateScopedKeyResponse {
  newKey: string;
  newId: string;
  oldKeySunsetAt: string;
}

// ── §19 Agent RBAC policies ──────────────────────────────────────────────────

/**
 * The RBAC policy of one agent (its API key id), written whole by
 * `putAgentPolicy` (`PUT /admin/agent-policy`). Scopes are the §6 memory
 * scopes (`memory:read`, `memory:write`, ...); a limit of 0 means unlimited.
 */
export interface AgentPolicyInput {
  agentId: string;
  readScopes: string[];
  writeScopes: string[];
  selfEdit: { enabled: boolean; maxWorthDelta?: number };
  taskScopes: { canCreate: boolean; canDelegate: boolean; canDelegateTo: string[] };
  limits: {
    maxRecallsPerMinute: number;
    maxWritesPerMinute: number;
    maxSessionsConcurrent: number;
    maxSelfEditsPerSession: number;
  };
  requireApprovalFor: string[];
  federationAccess: "none" | "read" | "read_write";
  namespaces?: string[];
}

/** A stored agent policy: the input plus the workspace it belongs to. */
export interface AgentPolicy extends AgentPolicyInput {
  workspaceId: string;
}

// ── B6.11: Skill primitive ───────────────────────────────────────────────────

/** Wire representation of an agent Skill (stored prompt template). */
export interface SkillWire {
  id: string;
  workspaceId: string;
  name: string;
  promptTemplate: string;
  variables: string[];
  requiredContext: string[];
  qualityScore: number;
  usageCount: number;
  lastUsedAt?: string;
  embeddingModel?: string;
  embeddingStale: boolean;
  sensitivity: Sensitivity;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

/** Input payload for creating a skill. */
export interface CreateSkillClientInput {
  name: string;
  promptTemplate: string;
  variables?: string[];
  requiredContext?: string[];
  sensitivity?: Sensitivity;
  metadata?: Record<string, unknown>;
  /** Write into a different workspace than the caller's own (requires a write/admin member). */
  targetWorkspaceId?: string;
}

/** Paginated list response for skills. */
export interface SkillListResponse {
  items: SkillWire[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Constructor options for `MnemosyneClient`. */
export interface MnemosyneClientOptions {
  /** Base URL of the Mnemosyne HTTP server, e.g. `https://memory.example.com`. */
  url: string;
  /** API key minted in the Mnemosyne control plane. Scoped to a workspace. */
  apiKey: string;
  /** Optional fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Default 30_000. */
  timeout?: number;
  /** Retry policy. Default: 3 attempts, exponential backoff with jitter. */
  retry?: RetryConfig;
  /**
   * Optional User-Agent suffix. Useful for operators to distinguish
   * traffic from different consumer apps in their logs.
   */
  userAgent?: string;
  /**
   * Default `X-Workspace-Id` sent on every request — only meaningful
   * when `apiKey` is a `uk_live_*` user token (a plain workspace key
   * ignores it server-side; see auth.ts's multi-workspace resolution).
   * Prefer `MnemosyneClient.forWorkspace(id)` over setting this directly
   * when one process serves multiple concurrent callers, since a shared
   * client's `workspaceId` here applies to every call made through it.
   */
  workspaceId?: string;
  /**
   * Locale tag (e.g. `es-419`) sent as `Accept-Language` on every request so
   * the server can localize error messages. Passed through as-is; omit to
   * send no header.
   */
  locale?: string;
}

// ─── Multi-tenancy: tenant / workspace / user / user-token wire types ─────────
// Mirrors packages/server/src/routes/tenants.ts + user-tokens.ts's zod schemas.

/** Tenant-plane membership role — mnemo_tenant_member.role. */
export type TenantRole = "owner" | "admin" | "member";

/** Workspace-plane membership role — mnemo_workspace_member.role. */
export type WorkspaceRole = "owner" | "admin" | "write" | "read";

export interface Tenant {
  id: string;
  name: string;
  kind: string;
  plan: string;
  createdAt: string | null;
}

export interface TenantMember {
  userId: string;
  role: TenantRole;
  joinedAt: string | null;
}

export interface MnemosyneUser {
  id: string;
  email: string;
  displayName: string | null;
  personalTenantId: string;
  createdAt: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string | null;
  tenantId: string;
  visibility: string;
  createdAt: string | null;
}

export interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string | null;
  visibility: string;
  memberCount: number;
}

export interface WorkspaceListItemWithRole {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  visibility: string;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string | null;
}

export interface CreateTenantInput {
  name: string;
  kind?: "personal" | "organization";
  plan?: string;
  /**
   * Also create the tenant's first workspace, owned by the caller's user, and
   * return `ownerToken`: a token bound to the new tenant and workspace. The
   * caller's own key keeps acting in its old tenant, so without it nothing can
   * act in the new one. Needs a key bound to a user.
   */
  issueOwnerToken?: boolean;
  /** Name of the first workspace with `issueOwnerToken`. Defaults to the tenant name. */
  workspaceName?: string;
}

/** A token for the new tenant's owner, from `issueOwnerToken`. The plaintext `key` is shown once. */
export interface TenantOwnerToken {
  id: string;
  key: string;
  label: string;
  scopes: string[];
  userId: string;
  tenantId: string;
  workspaceId: string;
  maxSensitivity: string | null;
  createdAt: string;
}

/** Response from `POST /tenants`: the tenant, plus its first workspace and owner token with `issueOwnerToken`. */
export interface CreateTenantResponse extends Tenant {
  workspace?: Workspace;
  ownerToken?: TenantOwnerToken;
}

export interface InviteTenantMemberInput {
  email: string;
  role?: TenantRole;
  /**
   * When true, auto-provisions a user (+ personal tenant + personal
   * workspace, same as `createUser`) if no account exists for `email`
   * yet, then adds the tenant membership in the same call. Default
   * false preserves the original 404-on-unknown-email behavior.
   */
  createIfMissing?: boolean;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
}

export interface CreateUserResponse {
  user: MnemosyneUser;
  personalTenant: Tenant;
  personalWorkspace: Workspace;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  ownerUserId?: string;
  visibility?: "private" | "public";
}

export interface InviteWorkspaceMemberInput {
  userId: string;
  role?: WorkspaceRole;
}

/**
 * `GET /me` response. Widened over time as auth.ts grew workspace-role
 * narrowing (S4/S5) — every field beyond `workspaceId`/`scopes` is
 * optional so older servers' responses still parse.
 */
export interface MeResponse {
  workspaceId: string;
  workspaceName?: string | null;
  /**
   * The authenticating API key's own row id (mnemo_api_keys.id) — the
   * credential, NOT reliably a userId. Use `userId` below for the platform
   * account, when present. Renamed from `actorId` for accuracy (pre-1.0,
   * no alias — see CLAUDE.md "Provenance identity").
   */
  keyId: string;
  /** What kind of principal this key authenticates as. */
  actorType: "agent" | "user" | "system" | "federation";
  scopes: string[];
  plan: string;
  keyPrefix: string;
  expiresAt: string | null;
  ipAllowlist: string[];
  userId: string | null;
  personalWorkspaceId: string | null;
  personalFactsLive: number | null;
  tenantId: string | null;
  /**
   * Caller's membership role in the CURRENT workspace (owner/admin/write/
   * read), when resolvable. Null for keys with no user binding, or when
   * the user has no membership row for this workspace — narrowing then
   * degrades to the key's own static scopes (see `effectiveScopes`).
   */
  workspaceRole?: WorkspaceRole | null;
  /**
   * Same value as `scopes` — named explicitly so callers don't need to
   * know that `scopes` is already the workspace-role-narrowed set, not
   * the key's raw static scope list.
   */
  effectiveScopes?: string[];
}

export interface CreateUserTokenInput {
  label: string;
  /** Must be in the same tenant; the target user must already be a member. */
  homeWorkspaceId: string;
  /** Must be a subset of the CALLER's own scopes. Omit to inherit them. */
  scopes?: string[];
  /** TTL, e.g. "90d", "8h", "60m". */
  expiresIn?: string;
  ipAllowlist?: string[];
  maxSensitivity?: "public" | "internal" | "confidential" | "restricted";
  /** Use the `uk_test_` prefix instead of `uk_live_`. */
  test?: boolean;
}

export interface CreateUserTokenResponse {
  id: string;
  /** Full plaintext token — shown ONCE, never retrievable again. */
  key: string;
  label: string;
  scopes: string[];
  userId: string;
  tenantId: string;
  workspaceId: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface UserTokenListItem {
  id: string;
  label: string;
  scopes: string[];
  workspaceId: string;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
