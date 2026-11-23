import { HttpClient } from "./http.js";
import { MnemosyneAPIError } from "./errors.js";
import type {
  RequestObservation,
  Tenant,
  TenantMember,
  Workspace,
  WorkspaceListItem,
  WorkspaceListItemWithRole,
  WorkspaceMember,
  WorkspaceRole,
  CreateTenantInput,
  CreateTenantResponse,
  InviteTenantMemberInput,
  CreateUserInput,
  CreateUserResponse,
  CreateWorkspaceInput,
  InviteWorkspaceMemberInput,
  MeResponse,
  CreateUserTokenInput,
  CreateUserTokenResponse,
  UserTokenListItem,
  AdminStats,
  AnticipationFeedResponse,
  DoctorReport,
  RememberInput,
  RememberResponse,
  SuggestTopicKeyInput,
  SuggestTopicKeyResponse,
  CompareFactsInput,
  CompareFactsResponse,
  AppendTurnInput,
  ApprovePeerInput,
  CreatePeerInput,
  CreatePeerResponse,
  ApprovePeerKeyResponse,
  AuditInput,
  AuditResponse,
  CollapseSessionInput,
  CollapseSessionResponse,
  CompositionDryRunResponse,
  CompositionRule,
  CreateDecisionInput,
  CreateEntityInput,
  CreateEventInput,
  CreateFactInput,
  CreateFactResponse,
  CreateHyperedgeInput,
  CreateReasoningInput,
  CreateRelationInput,
  CreateSessionInput,
  CreateSessionResponse,
  CreateStrategyInput,
  CreateTaskInput,
  DeletePeerResponse,
  DerivedInference,
  EnqueueReviewInput,
  EnqueueReviewResponse,
  EntityFactsResponse,
  EntityWithCount,
  EpisodeTimelineResponse,
  EpisodeWithLinkedFacts,
  EventWire,
  ExportResponse,
  Fact,
  FactCitationsResponse,
  FederationClaim,
  FederationSyncJob,
  ForgetResponse,
  GraphInput,
  GraphResponse,
  GraphTraverseInput,
  TraverseHit,
  GraphPathInput,
  GraphPathResponse,
  HealthReadySnapshot,
  HealthSnapshot,
  HyperedgeWire,
  KeyListItem,
  CreateKeyInput,
  CreateKeyResponse,
  KeyDetailResponse,
  RotateKeyResponse,
  IssueScopedKeyInput,
  IssueScopedKeyResponse,
  RotateScopedKeyResponse,
  AgentPolicy,
  AgentPolicyInput,
  SkillWire,
  CreateSkillClientInput,
  SkillListResponse,
  ListCitationsInput,
  ListCitationsResponse,
  ListDecisionsInput,
  ListDecisionsResponse,
  ListEntitiesInput,
  ListEntitiesResponse,
  ListEntityFactsInput,
  ListEpisodesInput,
  ListEpisodesResponse,
  ListEventsParams,
  ListFederationItemsResponse,
  ListFactsInput,
  ListFactsResponse,
  ListHyperedgesParams,
  ListPeersResponse,
  ListPendingPeersResponse,
  ListReasoningParams,
  ListRelationsInput,
  ListRelationsResponse,
  ListReviewInput,
  ListReviewResponse,
  ListSessionsResponse,
  ListStrategiesParams,
  ListTasksParams,
  MemoryFact,
  MnemoDecision,
  MnemoEntity,
  MnemoRelation,
  MnemosyneClientOptions,
  PaginatedEventsResponse,
  PaginatedHyperedgesResponse,
  PaginatedReasoningResponse,
  PaginatedStrategiesResponse,
  PaginatedTasksResponse,
  PatchFactInput,
  PatchHyperedgeInput,
  PatchReasoningInput,
  ReasoningFeedbackInput,
  RecordReasoningInput,
  ResolveReasoningInput,
  ResolveReasoningResponse,
  PatchRelationInput,
  PatchStrategyInput,
  PatchTaskInput,
  PinResponse,
  PinSessionTurnInput,
  ReasoningWire,
  RecallInput,
  RecallResponse,
  ResolveFederationConflictBatchInput,
  ResolveFederationConflictPairInput,
  ResolveFederationConflictResponse,
  ResolveReviewInput,
  ResolveReviewResponse,
  RestoreFactResponse,
  ReviewCountResponse,
  SelfEditResponse,
  SelfModelAspect,
  SelfModelResponse,
  SessionWire,
  StrategyWire,
  SubscribeHandle,
  SubscribeOptions,
  SupersedeDecisionInput,
  TaskWire,
  TimelineInput,
  TimelineResponse,
  TriggerConsolidationInput,
  TriggerConsolidationResponse,
  TriggerFederationSyncInput,
  TriggerFederationSyncResponse,
  UpdateEntityInput,
  UpdateEventSensitivityInput,
  ListConflictsResponse,
  ResolveConflictInput,
  ResolveConflictResponse,
  PurgeFactResponse,
  EraseSubjectInput,
  EraseSubjectResponse,
  PurgeClosedFactsResponse,
  TraverseRelationsInput,
  TraverseRelationsResponse,
  LinkEntityUserInput,
} from "./types.js";

/**
 * Typed SDK for the Mnemosyne HTTP API.
 *
 * Designed as a drop-in alternative to importing `@mnemo-ai/core`
 * directly. Pick this when:
 *   - You want to talk to a centralized memory server from many apps
 *     (microservices, edge functions, CLI tools).
 *   - You can't (or don't want to) install the core package and its
 *     Drizzle / pg / pgvector graph in your runtime.
 *   - You need a stable wire contract that survives memory-engine
 *     internal refactors.
 *
 * Pick `@mnemo-ai/core` directly when:
 *   - You want sub-millisecond in-process recall.
 *   - You're already running a Postgres connection pool you'd rather
 *     reuse than proxy through HTTP.
 *
 * @example
 * ```ts
 * import { MnemosyneClient } from "@mnemo-ai/client-ts";
 *
 * const memory = new MnemosyneClient({
 *   url: "https://memory.example.com",
 *   apiKey: process.env.MNEMO_KEY!,
 * });
 *
 * const { hits } = await memory.recall({ query: "user email preferences" });
 * ```
 */
export class MnemosyneClient {
  private readonly http: HttpClient;

  constructor(options: MnemosyneClientOptions) {
    if (!options.url) throw new Error("MnemosyneClient: `url` is required");
    if (!options.apiKey) throw new Error("MnemosyneClient: `apiKey` is required");

    // Resolve fetch lazily to support environments where the global
    // is shimmed AFTER module load (Vitest's MSW setup does this).
    const fetchImpl =
      options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

    this.http = new HttpClient({
      baseUrl: options.url,
      apiKey: options.apiKey,
      fetchImpl,
      timeoutMs: options.timeout ?? 30_000,
      retry: options.retry ?? {},
      userAgent: options.userAgent
        ? `mnemosyne-client-ts/2.0.0-alpha.0 (${options.userAgent})`
        : "mnemosyne-client-ts/2.0.0-alpha.0",
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
    });
  }

  /**
   * Return a NEW MnemosyneClient bound to a different `X-Workspace-Id`,
   * without mutating this instance or its config. Use this instead of
   * constructing a second client from scratch when you already hold one
   * (e.g. inside an MCP server process, where the client is long-lived
   * and shared across concurrent tool calls — each call that needs a
   * non-home workspace should clone, not mutate, the shared instance).
   *
   * Only meaningful with a `uk_live_*` user token; a plain workspace key
   * gets a 403 Forbidden from the server, not a silent ignore (`auth.ts`'s
   * `isUserKind` check).
   */
  forWorkspace(workspaceId: string): MnemosyneClient {
    const clone = Object.create(MnemosyneClient.prototype) as MnemosyneClient;
    (clone as unknown as { http: HttpClient }).http = this.http.withWorkspace(workspaceId);
    return clone;
  }

  /**
   * Return a NEW MnemosyneClient that declares `observation` (request id,
   * caller, versions) as headers on every request. Like `forWorkspace()`, it
   * never mutates the shared instance, so concurrent callers (e.g. MCP tool
   * calls) cannot leak metadata into each other. The server records these as
   * declared, unverified fields; the actor always comes from the API key.
   */
  withObservation(observation: RequestObservation): MnemosyneClient {
    const clone = Object.create(MnemosyneClient.prototype) as MnemosyneClient;
    (clone as unknown as { http: HttpClient }).http = this.http.withObservation(observation);
    return clone;
  }

  /**
   * Return a NEW MnemosyneClient whose requests time out after `timeoutMs`,
   * for the one slow call (a session collapse runs an LLM pass) that should not
   * raise the budget of every other call. Never mutates the shared instance.
   */
  withTimeout(timeoutMs: number): MnemosyneClient {
    const clone = Object.create(MnemosyneClient.prototype) as MnemosyneClient;
    (clone as unknown as { http: HttpClient }).http = this.http.withTimeout(timeoutMs);
    return clone;
  }

  /**
   * Recall facts relevant to a query.
   *
   * The server returns top-K hits ranked by a blended score
   * (`(tanh(A(t)) × 0.4 + cosine × 0.6) × worth`). Don't compare scores
   * across queries — they're only meaningful within a response.
   *
   * NOTE: `pinned` is NOT a scoring signal on this path. `POST /recall`
   * resolves to `recallCold()`, whose `viewFact()` projection never copies
   * `fact.pinned` onto the PrimitiveView the score formula reads — a pinned
   * fact and an otherwise identical unpinned fact rank IDENTICALLY. (The
   * `pin_bonus` column in the legacy `packages/core/src/recall/search.ts` is
   * real but backs `deps.core.recall`, not this route.) Proof:
   * `packages/core/src/cognitive/__tests__/recall-cold-pin-priority.test.ts`.
   *
   * Trade-off: we accept an optional pre-embedded `embedding` so the
   * caller can BYO embedder. Most callers should omit it and let the
   * server handle embedding — that's what keeps recall behavior
   * consistent across consumer apps.
   */
  recall(input: RecallInput, signal?: AbortSignal): Promise<RecallResponse> {
    return this.http.request<RecallResponse>({
      method: "POST",
      path: "/recall",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * P72 — move a fact to another workspace (POST /facts/:id/relocate).
   *
   * There is no "change the workspace_id" operation, and there should not be:
   * it would rewrite history and leave a hole in the audit trail. This closes
   * the fact where it was misfiled and creates a successor in the right place,
   * linked by `supersedes`, in one transaction.
   *
   * Rejects with 409 for confidential/restricted facts: their ciphertext is
   * bound to the source workspace's DEK and cannot cross the boundary.
   */
  relocateFact(
    id: string,
    targetWorkspaceId: string,
    reason?: string,
    signal?: AbortSignal
  ): Promise<{ previousId: string; newId: string }> {
    return this.http.request<{ previousId: string; newId: string }>({
      method: "POST",
      path: `/facts/${encodeURIComponent(id)}/relocate`,
      body: { targetWorkspaceId, ...(reason ? { reason } : {}) },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Store a fact via the cognitive engine endpoint (POST /remember).
   * Supports scope/scopeRef for project-namespaced memory — use this instead
   * of createFact when you need to isolate facts by project or context.
   */
  remember(
    input: RememberInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<RememberResponse> {
    const body: Record<string, unknown> = {
      statement: input.statement,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.subtype ? { subtype: input.subtype } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.agentId ? { agentId: input.agentId, attribution: input.agentId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      ...(input.scopeOwner ? { scopeOwner: input.scopeOwner } : {}),
      ...(input.targetWorkspaceId ? { targetWorkspaceId: input.targetWorkspaceId } : {}),
      ...(input.vector ? { vector: input.vector } : {}),
      ...(input.topicKey ? { topicKey: input.topicKey } : {}),
    };
    return this.http.request<RememberResponse>({
      method: "POST",
      path: "/remember",
      body,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Derive a deterministic `topicKey` from a subject/body pair without
   * writing anything (POST /topic-key/suggest). Pure and idempotent —
   * feeding the returned `topicKey` back in as `subject` (no `body`)
   * returns it unchanged. Use before `remember()`/`decide()` to get a
   * stable idempotency key instead of hand-rolling one.
   */
  suggestTopicKey(
    input: SuggestTopicKeyInput,
    signal?: AbortSignal
  ): Promise<SuggestTopicKeyResponse> {
    return this.http.request<SuggestTopicKeyResponse>({
      method: "POST",
      path: "/topic-key/suggest",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Compare two facts by id (POST /facts/compare): field differences,
   * a same-subject judgment, and a suggested relation verb. Server-owned
   * relocation of what `memory_compare` used to compute locally
   * (docs/archive/openspec/decompose-recall-and-compare) — either id missing or above
   * the caller's sensitivity ceiling resolves to a 404 `MnemosyneAPIError`.
   */
  compareFacts(input: CompareFactsInput, signal?: AbortSignal): Promise<CompareFactsResponse> {
    return this.http.request<CompareFactsResponse>({
      method: "POST",
      path: "/facts/compare",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Persist a new fact.
   *
   * `POST /facts` was deleted (flatten-legacy-dual-core D2 step 2) — this
   * now calls `POST /remember` under the hood, a lossless body remap
   * (`/remember` already accepts `tags` + `attribution`):
   * `{ content, attribution, tags }` -> `{ statement: content, attribution, tags }`.
   * The response is remapped back (`statement` -> `content`) so this
   * method's name, input shape, and output shape stay the same — the wire
   * route is the breaking part, not this SDK surface. See
   * {@link CreateFactInput}/{@link CreateFactResponse}.
   */
  createFact(
    input: CreateFactInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<CreateFactResponse> {
    const body: Record<string, unknown> = {
      statement: input.content,
      ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    return this.http
      .request<RememberResponse>({
        method: "POST",
        path: "/remember",
        body,
        ...(signal ? { signal } : {}),
        ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
      })
      .then((res) => {
        const { statement, ...rest } = res;
        return { ...rest, content: statement } as unknown as CreateFactResponse;
      });
  }

  /**
   * Fetch one fact by id. Returns 404 → MnemosyneAPIError if not found.
   * `includeClosed` returns a closed fact instead of 404; `provenance` adds
   * `sessionId`, `supersededById`, `supersededAt` and `supersedesIds`.
   */
  getFact(
    id: string,
    signal?: AbortSignal,
    opts: { includeClosed?: boolean; provenance?: boolean } = {}
  ): Promise<Fact> {
    return this.http.request<Fact>({
      method: "GET",
      path: `/facts/${encodeURIComponent(id)}`,
      query: {
        includeClosed: opts.includeClosed === true ? "true" : undefined,
        provenance: opts.provenance === true ? "true" : undefined,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Pin a fact — protects it from automated prune/forget and gives it
   * a recall boost. Use for canonical, never-forget knowledge.
   *
   * The server models pin/unpin as a single route that takes a boolean
   * flag (POST /facts/:id/pin with `{ pinned }`) rather than two
   * verbs, so we send `{ pinned: true }`.
   */
  pinFact(id: string, signal?: AbortSignal, idempotencyKey?: string): Promise<PinResponse> {
    return this.http.request<PinResponse>({
      method: "POST",
      path: `/facts/${encodeURIComponent(id)}/pin`,
      body: { pinned: true },
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** Inverse of {@link pinFact} — same route, `{ pinned: false }`. */
  unpinFact(id: string, signal?: AbortSignal, idempotencyKey?: string): Promise<PinResponse> {
    return this.http.request<PinResponse>({
      method: "POST",
      path: `/facts/${encodeURIComponent(id)}/pin`,
      body: { pinned: false },
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Forget a fact. This is the server's bitemporal soft-delete:
   * DELETE /facts/:id sets `valid_to = now` rather than hard-deleting,
   * so the fact stays auditable/recoverable. Returns 204 No Content, so
   * this resolves to `void`.
   */
  forgetFact(
    id: string,
    signal?: AbortSignal,
    idempotencyKey?: string,
    reason?: string
  ): Promise<ForgetResponse> {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    return this.http.request<ForgetResponse>({
      method: "DELETE",
      path: `/facts/${encodeURIComponent(id)}${query}`,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * P18 — Soft-delete (archive) any cognitive primitive by kind and id.
   * Maps to `DELETE /forget/:kind/:id`.
   * Supports idempotency keys for every kind (§34.9) — for facts,
   * {@link forgetFact} remains the preferred backward-compat path.
   * A repeat on an already-forgotten row succeeds with `alreadyForgotten: true`.
   */
  forgetPrimitive(
    kind:
      | "fact"
      | "decision"
      | "episode"
      | "entity"
      | "strategy"
      | "workflow"
      | "skill"
      | "task"
      | "event"
      | "reasoning"
      | "hyperedge",
    id: string,
    signal?: AbortSignal,
    reason?: string,
    idempotencyKey?: string
  ): Promise<{ forgotten: boolean; alreadyForgotten?: boolean }> {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    return this.http.request<{ forgotten: boolean; alreadyForgotten?: boolean }>({
      method: "DELETE",
      path: `/forget/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${query}`,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Recent fact-lifecycle events for the workspace (created / pinned /
   * unpinned / closed / updated), newest-first. Useful for diff views
   * ("what did my AI learn this week?") and the Mnemosyne Studio
   * inspector. Paginate with `nextCursor` via the `since` param.
   */
  timeline(input: TimelineInput = {}, signal?: AbortSignal): Promise<TimelineResponse> {
    return this.http.request<TimelineResponse>({
      method: "GET",
      path: "/timeline",
      query: {
        limit: input.limit,
        since: input.since,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Liveness + readiness snapshot. Returns more than a binary "ok"
   * so operators can wire it into existing dashboards (db / embedder /
   * queue sub-components are surfaced individually when degraded).
   */
  health(signal?: AbortSignal): Promise<HealthSnapshot> {
    return this.http.request<HealthSnapshot>({
      method: "GET",
      path: "/health",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Readiness probe with real per-dependency (postgres/vector/cache)
   * status. Unauthenticated + instance-wide server-side, unlike `health()`
   * above which is workspace-scoped vitals. Maps to `GET /health/ready`.
   */
  healthReady(signal?: AbortSignal): Promise<HealthReadySnapshot> {
    return this.http.request<HealthReadySnapshot>({
      method: "GET",
      path: "/health/ready",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Generic request escape hatch for un-wrapped or dynamic routes.
   */
  request<T>(opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    signal?: AbortSignal;
  }): Promise<T> {
    return this.http.request<T>(opts);
  }

  /**
   * Introspect the current API key — returns workspace, user, tenant,
   * scopes, plan, workspace role, and effective (role-narrowed) scopes.
   * Maps to `GET /me`.
   */
  getMe(signal?: AbortSignal): Promise<MeResponse> {
    return this.http.request<MeResponse>({
      method: "GET",
      path: "/me",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List workspaces available in the current tenant.
   * Maps to `GET /tenants/:tenantId/workspaces`.
   * Returns empty array when the key has no tenant binding (there is
   * genuinely nothing to list) — this is the one case that stays a
   * silent `[]` rather than a thrown error, since "no tenant bound" is
   * a normal, expected key shape (a plain workspace key), not a failure.
   */
  async listWorkspacesForCurrentTenant(signal?: AbortSignal): Promise<WorkspaceListItem[]> {
    const me = await this.getMe(signal);
    const tenantId = me.tenantId;
    if (!tenantId) return [];
    const result = await this.http.request<{ workspaces: WorkspaceListItem[] }>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(tenantId)}/workspaces`,
      ...(signal ? { signal } : {}),
    });
    return result.workspaces ?? [];
  }

  /**
   * List workspaces the active user belongs to, with the caller's role
   * in each. Maps to `GET /workspaces/mine`.
   *
   * Throws `MnemosyneAPIError` on a real failure (403/500/etc) — this
   * used to silently swallow every error to `[]`, which is why the CLI
   * grew its own raw-fetch bypass instead of trusting this method (see
   * CLI-PARITY-1 follow-up, L1). A 404 ("no user associated with this
   * key") is the one genuinely-empty case and still resolves to `[]`.
   */
  async listMyWorkspaces(signal?: AbortSignal): Promise<WorkspaceListItemWithRole[]> {
    try {
      const result = await this.http.request<{ workspaces: WorkspaceListItemWithRole[] }>({
        method: "GET",
        path: "/workspaces/mine",
        ...(signal ? { signal } : {}),
      });
      return result.workspaces ?? [];
    } catch (err) {
      if (err instanceof MnemosyneAPIError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * List members of a workspace, with each member's role.
   * Maps to `GET /workspaces/:workspaceId/members`.
   *
   * Throws `MnemosyneAPIError` on a real failure — see {@link listMyWorkspaces}'s
   * doc for why this no longer swallows errors to `[]`.
   */
  listWorkspaceMembers(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceMember[]> {
    return this.http
      .request<{ members: WorkspaceMember[] }>({
        method: "GET",
        path: `/workspaces/${encodeURIComponent(workspaceId)}/members`,
        ...(signal ? { signal } : {}),
      })
      .then((result) => result.members ?? []);
  }

  /**
   * Get a single workspace by id. Membership required — the server
   * returns 404 (not 403) for a non-member, per the anti-probing
   * invariant (CLAUDE.md S6), so this throws `MnemosyneAPIError` with
   * status 404 in that case too, indistinguishable from "doesn't exist".
   * Maps to `GET /workspaces/:workspaceId`.
   */
  getWorkspaceById(workspaceId: string, signal?: AbortSignal): Promise<Workspace> {
    return this.http.request<Workspace>({
      method: "GET",
      path: `/workspaces/${encodeURIComponent(workspaceId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a workspace inside a tenant. Requires `memory:admin` (tenant
   * owner/admin, or a workspace-role-narrowed admin — see security.ts's
   * `WORKSPACE_ROLE_SCOPES`). Maps to `POST /tenants/:tenantId/workspaces`.
   */
  createWorkspace(
    tenantId: string,
    input: CreateWorkspaceInput,
    signal?: AbortSignal
  ): Promise<Workspace> {
    return this.http.request<Workspace>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/workspaces`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Add a user as a member of a workspace with a given role (default
   * `read`). The invited user must already belong to the workspace's
   * tenant (403 otherwise — this is same-tenant enforcement, distinct
   * from the anti-probing 404 elsewhere in this route family).
   * Maps to `POST /workspaces/:workspaceId/members`.
   */
  inviteWorkspaceMember(
    workspaceId: string,
    input: InviteWorkspaceMemberInput,
    signal?: AbortSignal
  ): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>({
      method: "POST",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/members`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Remove a user from a workspace. Requires workspace owner/admin.
   * Maps to `DELETE /workspaces/:workspaceId/members/:userId`.
   */
  removeWorkspaceMember(
    workspaceId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>({
      method: "DELETE",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Change a workspace member's role. Requires workspace owner/admin.
   * Maps to `PATCH /workspaces/:workspaceId/members/:userId`.
   */
  updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    signal?: AbortSignal
  ): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>({
      method: "PATCH",
      path: `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      body: { role },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List workspaces in a tenant by EXPLICIT id — for an operator managing a
   * tenant that isn't necessarily their own key's home tenant (e.g. the CLI's
   * `mnemo tenant workspaces <tenantId>`). Requires `admin:tenant` on that
   * tenant. See {@link listWorkspacesForCurrentTenant} for the "my own
   * tenant, derived from GET /me" convenience wrapper.
   * Maps to `GET /tenants/:tenantId/workspaces`.
   */
  listWorkspacesForTenant(tenantId: string, signal?: AbortSignal): Promise<WorkspaceListItem[]> {
    return this.http
      .request<{ workspaces: WorkspaceListItem[] }>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/workspaces`,
        ...(signal ? { signal } : {}),
      })
      .then((result) => result.workspaces ?? []);
  }

  // ── Tenants (C3) ──────────────────────────────────────────────────────────

  /**
   * Create a new tenant (an organization, typically). Requires
   * `admin:tenant`. Maps to `POST /tenants`.
   */
  createTenant(input: CreateTenantInput, signal?: AbortSignal): Promise<CreateTenantResponse> {
    return this.http.request<CreateTenantResponse>({
      method: "POST",
      path: "/tenants",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Get tenant info by id. Cross-tenant access (key bound to a
   * different tenant) throws `MnemosyneAPIError` (403).
   * Maps to `GET /tenants/:tenantId`.
   */
  getTenant(tenantId: string, signal?: AbortSignal): Promise<Tenant> {
    return this.http.request<Tenant>({
      method: "GET",
      path: `/tenants/${encodeURIComponent(tenantId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List members of a tenant, with each member's tenant-plane role.
   * Maps to `GET /tenants/:tenantId/members`.
   */
  listTenantMembers(tenantId: string, signal?: AbortSignal): Promise<TenantMember[]> {
    return this.http
      .request<{ members: TenantMember[] }>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/members`,
        ...(signal ? { signal } : {}),
      })
      .then((result) => result.members ?? []);
  }

  /**
   * Invite a user (by email) to a tenant. Requires the caller to be a
   * tenant owner/admin. Pass `createIfMissing: true` to auto-provision
   * an account (+ personal tenant + personal workspace) for an email
   * that has never used Mnemosyne, in the same call.
   * Maps to `POST /tenants/:tenantId/members`.
   */
  inviteTenantMember(
    tenantId: string,
    input: InviteTenantMemberInput,
    signal?: AbortSignal
  ): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/members`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Remove a user from a tenant. Requires the caller to be a tenant
   * owner/admin. Maps to `DELETE /tenants/:tenantId/members/:userId`.
   */
  removeTenantMember(
    tenantId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean }> {
    return this.http.request<{ ok: boolean }>({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a user (auto-creates their personal tenant + personal
   * workspace). Maps to `POST /users`. 400s if the email is already
   * registered.
   */
  createUser(input: CreateUserInput, signal?: AbortSignal): Promise<CreateUserResponse> {
    return this.http.request<CreateUserResponse>({
      method: "POST",
      path: "/users",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  // ── User tokens (C5) ──────────────────────────────────────────────────────
  //
  // Deliberately NOT exposed via MCP (see user-tokens.ts's file-header
  // comment) — minting a token returns a plaintext credential, and these
  // methods exist for CLI/operator use, not for an agent's tool surface.

  /**
   * Mint a `uk_live_*` user token for ANOTHER member of a tenant (not the
   * caller). Requires the caller to be a tenant owner/admin. The target
   * user must already be a member of `input.homeWorkspaceId`, and
   * `input.scopes` (if given) must be a subset of the CALLER's own
   * scopes — a tenant admin can never mint a token more powerful than
   * themselves. The plaintext key is returned ONCE, in this response only.
   * Maps to `POST /tenants/:tenantId/users/:userId/tokens`.
   */
  createUserToken(
    tenantId: string,
    userId: string,
    input: CreateUserTokenInput,
    signal?: AbortSignal
  ): Promise<CreateUserTokenResponse> {
    return this.http.request<CreateUserTokenResponse>({
      method: "POST",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/tokens`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List a tenant member's user tokens (secrets masked — never
   * retrievable after creation). Requires the caller to be a tenant
   * owner/admin. Maps to `GET /tenants/:tenantId/users/:userId/tokens`.
   */
  listUserTokens(
    tenantId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<UserTokenListItem[]> {
    return this.http
      .request<{ tokens: UserTokenListItem[] }>({
        method: "GET",
        path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/tokens`,
        ...(signal ? { signal } : {}),
      })
      .then((result) => result.tokens ?? []);
  }

  /**
   * Revoke a user token. Requires the caller to be a tenant owner/admin.
   * Maps to `DELETE /tenants/:tenantId/users/:userId/tokens/:keyId`.
   */
  revokeUserToken(
    tenantId: string,
    userId: string,
    keyId: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; revokedAt: string }> {
    return this.http.request<{ ok: boolean; revokedAt: string }>({
      method: "DELETE",
      path: `/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/tokens/${encodeURIComponent(keyId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Run the 6 server-side operational diagnostic checks (connectivity,
   * app_user_grants, schema_shadows, migration_version, embedding_backlog,
   * workspace_id_valid) and return a structured `DoctorReport`.
   *
   * The `memory_doctor` MCP tool calls this and appends 2 additional
   * client-side checks (env_config, mcp_tools) before returning the merged
   * report to the LLM caller.
   *
   * Maps to `GET /doctor`.
   */
  doctor(signal?: AbortSignal): Promise<DoctorReport> {
    return this.http.request<DoctorReport>({
      method: "GET",
      path: "/doctor",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Aggregate workspace statistics: fact counts (live / closed / pinned /
   * archived / zero-hits), decision count, conflict relations, embedding
   * coverage, recall hit rate, and last activity timestamps.
   *
   * Delegates to `GET /admin/stats` on the Mnemosyne server.
   * No parameters — all stats are scoped to the authenticated workspace
   * by RLS.
   */
  getStats(signal?: AbortSignal): Promise<AdminStats> {
    return this.http.request<AdminStats>({
      method: "GET",
      path: "/admin/stats",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Memory Graph snapshot. With no input, returns the workspace's full
   * canonical graph (entities + episodes + decisions, plus typed
   * relations between them). When `focus` is supplied (an entity id: a
   * UUID, or a legacy `ment_<slug>` seed id), returns only that entity and its 1-hop neighbourhood
   * — cheaper to compute and much cheaper to render.
   *
   * The server caches with `Cache-Control: private, max-age=30`, so
   * repeated calls within that window are short-circuited by any
   * standards-conformant fetch implementation.
   */
  graph(input: GraphInput = {}, signal?: AbortSignal): Promise<GraphResponse> {
    return this.http.request<GraphResponse>({
      method: "GET",
      path: "/graph",
      query: {
        focus: input.focus,
        ...(input.includeSemantic ? { includeSemantic: "true" } : {}),
        ...(input.asOf ? { asOf: input.asOf } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Multi-hop BFS traversal over `mnemo_relation` starting from a root entity.
   * Returns reachable nodes with their minimum hop distance and a relevance
   * score (decay^hop). Supports optional verb filtering and bitemporal as-of
   * reconstruction.
   *
   * Maps to `GET /graph/traverse`.
   */
  graphTraverse(input: GraphTraverseInput, signal?: AbortSignal): Promise<{ hits: TraverseHit[] }> {
    return this.http.request<{ hits: TraverseHit[] }>({
      method: "GET",
      path: "/graph/traverse",
      query: {
        root: input.root,
        ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
        ...(input.relations?.length ? { relations: input.relations.join(",") } : {}),
        ...(input.asOf ? { asOf: input.asOf } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Low-level BFS relation edge traversal from a root node over `mnemo_relation`.
   * Returns reachable nodes and raw edge objects.
   *
   * Maps to `POST /relations/traverse`.
   */
  relationsTraverse(
    input: TraverseRelationsInput,
    signal?: AbortSignal
  ): Promise<TraverseRelationsResponse> {
    return this.http.request<TraverseRelationsResponse>({
      method: "POST",
      path: "/relations/traverse",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Shortest path between two nodes over `mnemo_relation` via a recursive
   * CTE with cycle detection. Returns the node id chain from `from` to `to`
   * and the relation verbs traversed at each step. Returns an empty path
   * when the nodes are unreachable within `maxHops`.
   *
   * Maps to `GET /graph/path`.
   */
  graphPath(input: GraphPathInput, signal?: AbortSignal): Promise<GraphPathResponse> {
    return this.http.request<GraphPathResponse>({
      method: "GET",
      path: "/graph/path",
      query: {
        from: input.from,
        to: input.to,
        ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
        ...(input.asOf ? { asOf: input.asOf } : {}),
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List entities in the workspace (Mnemosyne v1.6 G2 entity browser).
   * Filters by `kind` (one of 6 enum values) and/or `q` (case-insensitive
   * substring across name + aliases). Server-cap on `limit` is 200.
   *
   * Sorted newest-mentioned first (most likely interesting for the
   * inspector header).
   */
  listEntities(input: ListEntitiesInput = {}, signal?: AbortSignal): Promise<ListEntitiesResponse> {
    return this.http.request<ListEntitiesResponse>({
      method: "GET",
      path: "/entities",
      query: {
        kind: input.kind,
        q: input.q,
        limit: input.limit,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Fetch a single entity by id plus its active-fact count. The count
   * powers the inspector header chip ("12 linked facts") without
   * forcing a second round-trip. Throws {@link MnemosyneAPIError} (404)
   * when the entity doesn't exist in this workspace.
   */
  getEntity(id: string, signal?: AbortSignal): Promise<EntityWithCount> {
    return this.http.request<EntityWithCount>({
      method: "GET",
      path: `/entities/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List the facts the extraction pipeline linked to a given entity
   * (via `mnemo_fact.entity_id`). Active facts only — forgotten/merged
   * stay hidden from the entity-detail view. Server-cap on `limit` is
   * 500. Throws 404 when the entity itself doesn't exist.
   */
  listEntityFacts(
    id: string,
    input: ListEntityFactsInput = {},
    signal?: AbortSignal
  ): Promise<EntityFactsResponse> {
    return this.http.request<EntityFactsResponse>({
      method: "GET",
      path: `/entities/${encodeURIComponent(id)}/facts`,
      query: { limit: input.limit },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List episodes in a date window (Mnemosyne v1.4 timeline). When
   * `from`/`to` are omitted the server defaults to the last 30 days —
   * the inspector rarely cares about older slices unless explicitly
   * requested. `topic` filters via the GIN-indexed `topics` array
   * (single-topic only by design). Server-cap on `limit` is 200.
   *
   * `includeSynthetic` defaults to false — extractor-synthesised
   * episodes are hidden from the inspector view but visible to operator
   * tools that opt in.
   */
  listEpisodes(input: ListEpisodesInput = {}, signal?: AbortSignal): Promise<ListEpisodesResponse> {
    return this.http.request<ListEpisodesResponse>({
      method: "GET",
      path: "/episodes",
      query: {
        from: input.from,
        to: input.to,
        topic: input.topic,
        limit: input.limit,
        includeSynthetic: input.includeSynthetic,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Fetch a single episode plus its linked facts. Linked facts that
   * have since been archived are silently filtered out (an episode
   * legitimately outlives some of its constituent facts). Throws 404
   * when the episode itself doesn't exist.
   */
  getEpisode(id: string, signal?: AbortSignal): Promise<EpisodeWithLinkedFacts> {
    return this.http.request<EpisodeWithLinkedFacts>({
      method: "GET",
      path: `/episodes/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Chronological timeline for one episode: its creation plus every fact
   * linked to it, in `occurredAt` order.
   *
   * Maps to `GET /episodes/:id/timeline`.
   */
  getEpisodeTimeline(id: string, signal?: AbortSignal): Promise<EpisodeTimelineResponse> {
    return this.http.request<EpisodeTimelineResponse>({
      method: "GET",
      path: `/episodes/${encodeURIComponent(id)}/timeline`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Manual entity create. The extraction pipeline auto-creates via
   * `findOrCreate`; this method exists so an operator can bootstrap
   * the entity table before any conversation has happened or
   * backfill an out-of-band mention.
   *
   * The server enforces a `(workspace_id, name, kind)` unique
   * constraint — a duplicate surfaces as a {@link MnemosyneAPIError}
   * with status 409.
   */
  createEntity(
    input: CreateEntityInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<MnemoEntity> {
    return this.http.request<MnemoEntity>({
      method: "POST",
      path: "/entities",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Patch an existing entity (rename / alias edits / kind change /
   * canonical merge). An empty patch (every key undefined) gets
   * 400; canonicalId targets that don't exist (or equal the row
   * being patched) get 400. 404 when the row itself doesn't exist.
   */
  updateEntity(id: string, input: UpdateEntityInput, signal?: AbortSignal): Promise<MnemoEntity> {
    return this.http.request<MnemoEntity>({
      method: "PATCH",
      path: `/entities/${encodeURIComponent(id)}`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Link a 'person' entity to a real platform account (`linkedUserId`).
   * Self-link (your own userId) is always allowed. Linking a DIFFERENT
   * user — or reassigning an entity already linked to someone else —
   * requires the caller to hold `memory:admin` AND an owner/admin role in
   * this workspace; reassignment closes the old link and creates a new
   * successor row linked via a `supersedes` relation rather than
   * overwriting it in place, so the prior link is preserved for audit.
   * 400 when the entity's `kind` isn't `'person'`. 404 when the entity
   * doesn't exist, the caller's sensitivity ceiling can't read it
   * (anti-probing — same response as nonexistent), or the target user
   * isn't a member of this workspace.
   */
  linkEntityUser(
    id: string,
    input: LinkEntityUserInput,
    signal?: AbortSignal
  ): Promise<MnemoEntity> {
    return this.http.request<MnemoEntity>({
      method: "POST",
      path: `/entities/${encodeURIComponent(id)}/link-user`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Unlink a 'person' entity from its linked platform account. Bitemporal:
   * closes the linked row and creates an unlinked successor (never blanks
   * `linkedUserId` in place), mirroring this API's `forget()` convention.
   * Same self-or-admin+role permission as {@link linkEntityUser}. 404 when
   * the entity doesn't exist or isn't currently linked.
   */
  unlinkEntityUser(id: string, signal?: AbortSignal): Promise<MnemoEntity> {
    return this.http.request<MnemoEntity>({
      method: "DELETE",
      path: `/entities/${encodeURIComponent(id)}/link-user`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List active-learning queue rows (Mnemosyne v1.3+). Defaults to
   * unresolved only — pass `all:true` to include resolved rows for
   * the full history. Editor-tier surface; the queue is an
   * operational concern.
   */
  listReview(input: ListReviewInput = {}, signal?: AbortSignal): Promise<ListReviewResponse> {
    return this.http.request<ListReviewResponse>({
      method: "GET",
      path: "/review",
      query: {
        reason: input.reason,
        all: input.all,
        limit: input.limit,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Cheap COUNT(*) of unresolved queue rows. Powers the inspector
   * header badge ("12 to review") — uses the partial index
   * `idx_mnemo_review_queue_workspace_unresolved` so it's
   * constant-time at queue depths the inspector cares about.
   */
  reviewCount(signal?: AbortSignal): Promise<ReviewCountResponse> {
    return this.http.request<ReviewCountResponse>({
      method: "GET",
      path: "/review/count",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Close a queue row. When `resolution='forgotten'` AND the row is
   * fact-sourced, the server atomically cascades the fact's status
   * to 'forgotten' in the same tx so the fact leaves the recall pool
   * without a follow-up round-trip. The response's `cascaded` field
   * confirms this happened.
   *
   * Throws 404 if the row doesn't exist; 409 if it was already
   * resolved (idempotent re-resolve is intentionally NOT silent so
   * the caller can decide whether to retry or surface a warning).
   */
  resolveReview(
    id: string,
    input: ResolveReviewInput,
    signal?: AbortSignal
  ): Promise<ResolveReviewResponse> {
    return this.http.request<ResolveReviewResponse>({
      method: "POST",
      path: `/review/${encodeURIComponent(id)}/resolve`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * "Undo log" feed — most recent fact-mutation events. Synthesised
   * from two sources: user-driven Forget (revertible via
   * {@link restoreFact}) and janitor-driven archive (not revertible).
   * Newest first. Powers the inspector's undo surface.
   */
  audit(input: AuditInput = {}, signal?: AbortSignal): Promise<AuditResponse> {
    return this.http.request<AuditResponse>({
      method: "GET",
      path: "/audit",
      query: { limit: input.limit },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Full workspace memory dump (admin-tier surface). Returns the four
   * mnemo_* tables (facts, decisions, relations, citations) in a
   * single buffered JSON payload. Embeddings are excluded.
   *
   * v1.3 caps at 100k rows per resource. Large workspaces should
   * wait for the v1.4 streaming endpoint rather than chunk by hand.
   */
  exportWorkspace(signal?: AbortSignal): Promise<ExportResponse> {
    return this.http.request<ExportResponse>({
      method: "GET",
      path: "/export",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Restore a forgotten fact — flips `status` back to 'active' so the
   * fact rejoins the recall pool. Companion to {@link forgetFact}.
   * Returns the minimal `{id, status}` pair; chain {@link getFact}
   * if you need the full body.
   *
   * 404 when the fact doesn't exist (or RLS hides it).
   */
  restoreFact(id: string, signal?: AbortSignal): Promise<RestoreFactResponse> {
    return this.http.request<RestoreFactResponse>({
      method: "POST",
      path: `/facts/${encodeURIComponent(id)}/restore`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List decisions in the workspace (Mnemosyne v1.5). Decisions are
   * durable, audited statements of "we are going to do X because Y"
   * — distinct from facts (transient observations). Newest first.
   */
  listDecisions(
    input: ListDecisionsInput = {},
    signal?: AbortSignal
  ): Promise<ListDecisionsResponse> {
    return this.http.request<ListDecisionsResponse>({
      method: "GET",
      path: "/decisions",
      query: { status: input.status, limit: input.limit },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Fetch a single decision by id. Throws 404 if it doesn't exist.
   *
   * Note: orchester's `/api/mnemo/decisions/[traceId]` route is the
   * Decision BOM (Bill-of-Materials) endpoint, which joins mnemo
   * decision data with orchester's audit_log table — this method
   * returns ONLY the mnemo decision row, not the BOM composition.
   *
   * `includeClosed` asks for a superseded or withdrawn decision the way
   * {@link getFact} asks for a closed fact.
   */
  getDecision(
    id: string,
    signal?: AbortSignal,
    opts: { includeClosed?: boolean } = {}
  ): Promise<MnemoDecision> {
    return this.http.request<MnemoDecision>({
      method: "GET",
      path: `/decisions/${encodeURIComponent(id)}`,
      query: { includeClosed: opts.includeClosed === true ? "true" : undefined },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Paginated fact list (rich projection — subject/statement/kind, not
   * the simplified content shape `/facts/:id` returns).
   *
   * Tramo 5 surface:
   *   - Filters: kind, scope, scopeRef, status, pinned, asOf (bitemporal).
   *   - Search: `q` runs `plainto_tsquery` on the lemmatized column with
   *     an ILIKE fallback for facts whose lemma column is null.
   *   - Sort: `sortBy` ∈ {created_at, updated_at, relevance, hit_count},
   *     `order` ∈ {asc, desc}. Tied rows are broken by id.
   *   - Pagination: pass back the previous response's `nextCursor` to
   *     keyset-paginate. Cursors are opaque — do not parse them.
   *
   * Response envelope `{ items, nextCursor, total }`. `total` is the
   * COUNT(*) for the filter set (sans cursor) so an inspector header
   * can render "X of Y" without a separate request.
   */
  listFacts(input: ListFactsInput = {}, signal?: AbortSignal): Promise<ListFactsResponse> {
    return this.http.request<ListFactsResponse>({
      method: "GET",
      path: "/facts",
      query: {
        kind: input.kind,
        scope: input.scope,
        scopeRef: input.scopeRef,
        status: input.status,
        pinned: input.pinned,
        q: input.q,
        sortBy: input.sortBy,
        order: input.order,
        cursor: input.cursor,
        asOf: input.asOf,
        limit: input.limit,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Patch a fact's editable columns (subject/statement/kind/pinned/
   * confidence/relevance/metadata). An empty patch (every field
   * undefined) returns 400; 404 when the row doesn't exist.
   *
   * Bitemporal note: PATCH does NOT close the interval — `validFrom`
   * stays put, `validTo` stays null. Use {@link forgetFact} to mark
   * the fact as no-longer-valid at a point in time.
   */
  patchFact(id: string, input: PatchFactInput, signal?: AbortSignal): Promise<MemoryFact> {
    return this.http.request<MemoryFact>({
      method: "PATCH",
      path: `/facts/${encodeURIComponent(id)}`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Source-message ids for a fact. Returns just the id list —
   * Mnemosyne doesn't own the message table that orchester joins
   * against, so hosts wanting `{role, content, timestamp}` per message
   * do that join on their side.
   */
  getFactCitations(id: string, signal?: AbortSignal): Promise<FactCitationsResponse> {
    return this.http.request<FactCitationsResponse>({
      method: "GET",
      path: `/facts/${encodeURIComponent(id)}/citations`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a decision (Mnemosyne v1.5). Topic-key upsert + normalized-
   * hash dedup happen server-side — re-creating a decision with the
   * same (workspace_id, topic_key) returns the existing row (201
   * status either way; the client cannot distinguish first-create
   * from upsert without comparing the returned id).
   */
  createDecision(
    input: CreateDecisionInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<MnemoDecision> {
    return this.http.request<MnemoDecision>({
      method: "POST",
      path: "/decisions",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Supersede a decision: marks `id` as status='superseded' and
   * points its supersededById at `input.supersededById`. Returns
   * the updated decision. Caller is responsible for the matching
   * `supersedes` relation row (via {@link createRelation}).
   */
  supersedeDecision(
    id: string,
    input: SupersedeDecisionInput,
    signal?: AbortSignal
  ): Promise<MnemoDecision> {
    return this.http.request<MnemoDecision>({
      method: "PATCH",
      path: `/decisions/${encodeURIComponent(id)}`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List relations in the workspace (Mnemosyne v1.0 — LOCKED 9-verb
   * vocabulary). Filter by `judgmentStatus`: typical inspector use is
   * `judgmentStatus: 'pending'` for the judge queue.
   */
  listRelations(
    input: ListRelationsInput = {},
    signal?: AbortSignal
  ): Promise<ListRelationsResponse> {
    return this.http.request<ListRelationsResponse>({
      method: "GET",
      path: "/relations",
      query: {
        judgmentStatus: input.judgmentStatus,
        sourceId: input.sourceId,
        targetId: input.targetId,
        ...(input.includeClosed !== undefined
          ? { includeClosed: String(input.includeClosed) }
          : {}),
        limit: input.limit,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a relation between two memory primitives. `relation` MUST
   * be one of the 9 LOCKED verbs; the server 400-rejects unknown verbs.
   *
   * Multi-actor disagreement is captured by creating a SECOND relation
   * row with the same source/target but a different markedBy* —
   * the server has no UNIQUE constraint preventing this (intentional,
   * see migration 0020).
   */
  createRelation(
    input: CreateRelationInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<MnemoRelation> {
    return this.http.request<MnemoRelation>({
      method: "POST",
      path: "/relations",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Retract a relation. Maps to `DELETE /relations/:id`.
   *
   * P111 — relations were creatable and removable through no surface at all,
   * which mattered because P74's dangling-write path could create them against
   * ids matching no row.
   *
   * This CLOSES the bitemporal interval; the row and its judgment provenance
   * survive, matching `forgetFact`'s semantics rather than a physical delete.
   * Throws 404 when the relation does not exist OR was already closed — neither
   * is a state this call changed.
   */
  closeRelation(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/relations/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Apply a judgment to a pending relation: replace the verb, flip
   * `judgmentStatus` to 'judged', stamp the marker. Returns the
   * updated row, or throws 404 when the relation does not exist.
   */
  patchRelation(
    id: string,
    input: PatchRelationInput,
    signal?: AbortSignal
  ): Promise<MnemoRelation> {
    return this.http.request<MnemoRelation>({
      method: "PATCH",
      path: `/relations/${encodeURIComponent(id)}`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List citations attached to memory primitives. Filter by
   * `memoryKind` (fact/decision/entity/episode) and/or `memoryId`
   * for a specific row's provenance trail. Newest first.
   */
  listCitations(
    input: ListCitationsInput = {},
    signal?: AbortSignal
  ): Promise<ListCitationsResponse> {
    return this.http.request<ListCitationsResponse>({
      method: "GET",
      path: "/citations",
      query: {
        memoryKind: input.memoryKind,
        memoryId: input.memoryId,
        limit: input.limit,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Manually enqueue a fact (or decision) for human review.
   * Idempotent via the server-side partial index: re-enqueuing an
   * open row returns the existing id with `inserted:false` instead
   * of creating a duplicate. Exactly one of `factId`/`decisionId`
   * MUST be supplied; the server 400-rejects both-or-neither, and answers
   * 404 when the fact or decision does not exist or is above the caller's
   * sensitivity ceiling.
   */
  enqueueReview(input: EnqueueReviewInput, signal?: AbortSignal): Promise<EnqueueReviewResponse> {
    return this.http.request<EnqueueReviewResponse>({
      method: "POST",
      path: "/review/enqueue",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a prospective memory reminder. The reminder will surface during
   * recall when its time condition (`triggerAt`) is met, when the query
   * embedding is semantically close to the reminder's condition, or both.
   *
   * Returns the created reminder with its assigned `id`.
   */
  createReminder(
    // REMIND-1: `condition` is optional — a reminder needs at least one of
    // `condition` (semantic, evaluated on every recall) or `triggerAt`
    // (temporal, swept every 30s).
    input: {
      content: string;
      condition?: string;
      triggerAt?: string;
      /** Write into a different workspace than the caller's own (requires a write/admin member). */
      targetWorkspaceId?: string;
    },
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<{
    id: string;
    content: string;
    condition: string | null;
    triggerAt: string | null;
    status: string;
    createdAt: string;
    workspaceId: string;
  }> {
    return this.http.request({
      method: "POST",
      path: "/reminders",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * List reminders for the workspace. Defaults to `status=pending`.
   *
   * @param status - 'pending' | 'triggered' | 'dismissed' | 'all' (default: 'pending')
   * @param limit  - Max rows to return (default: 50, max: 200)
   */
  listReminders(
    input: { status?: "pending" | "triggered" | "dismissed" | "all"; limit?: number } = {},
    signal?: AbortSignal
  ): Promise<{
    reminders: Array<{
      id: string;
      content: string;
      condition: string | null;
      triggerAt: string | null;
      status: string;
      createdAt: string;
    }>;
  }> {
    return this.http.request({
      method: "GET",
      path: "/reminders",
      query: { status: input.status, limit: input.limit },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Dismiss a reminder by id. Sets status to 'dismissed' (no row deleted).
   * Throws MnemosyneAPIError (404) when the reminder does not exist.
   */
  dismissReminder(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/reminders/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ─── Session lifecycle ───────────────────────────────────────────────────────

  /**
   * Start a new ephemeral session (episode). Use the returned `id` with
   * {@link collapseSession} when the conversation ends.
   *
   * Maps to `POST /session/start` on the Mnemosyne server.
   */
  createSession(
    input: CreateSessionInput = {},
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<CreateSessionResponse> {
    return this.http.request<CreateSessionResponse>({
      method: "POST",
      path: "/session/start",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Collapse an active session into durable knowledge units (facts,
   * decisions, strategies). The server returns 202 Accepted after the
   * collapse pipeline completes.
   *
   * Throws `MnemosyneAPIError` with status 404 when the session does not
   * exist or has already been collapsed.
   *
   * Maps to `POST /session/:id/collapse` on the Mnemosyne server.
   */
  collapseSession(
    id: string,
    input: CollapseSessionInput = {},
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<CollapseSessionResponse> {
    return this.http.request<CollapseSessionResponse>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/collapse`,
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Append a conversation turn to an active session's transcript.
   *
   * Both user and assistant turns should be recorded here so the collapse
   * pipeline can extract facts from the full conversation context.
   *
   * Maps to `POST /session/:id/turn`. Returns 204 No Content (void).
   */
  appendTurn(id: string, input: AppendTurnInput, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/turn`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Pin or unpin a specific turn within an active session.
   *
   * Pinned turns are given higher weight during the collapse extraction pass
   * and are more likely to become durable facts.
   *
   * Maps to `POST /session/:id/pin`. Returns 204 No Content (void).
   */
  pinSessionTurn(id: string, input: PinSessionTurnInput, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/pin`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Submit explicit user feedback (thumbs up/down rating) for a session.
   *
   * Maps to `POST /session/:id/feedback`. Returns 204 No Content (void).
   */
  sessionFeedback(id: string, rating: "up" | "down", signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/feedback`,
      body: { rating },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Fetch a single session by id (status, label, `lastRecallAt`).
   *
   * Maps to `GET /session/:id` on the Mnemosyne server.
   */
  getSession(id: string, signal?: AbortSignal): Promise<SessionWire> {
    return this.http.request<SessionWire>({
      method: "GET",
      path: `/session/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List every session in the workspace.
   *
   * Maps to `GET /session/list` on the Mnemosyne server.
   */
  listSessions(signal?: AbortSignal): Promise<ListSessionsResponse> {
    return this.http.request<ListSessionsResponse>({
      method: "GET",
      path: "/session/list",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Namespaced session helpers — convenience wrapper that satisfies the
   * spec's chaining example with zero client state.
   *
   * @example
   * ```ts
   * const { id } = await client.sessions.create();
   * await client.sessions.addTurn(id, { role: "user", content: "Hello!" });
   * await client.sessions.pinTurn(id, { turnIndex: 0, pinned: true }); // or { turnId: "<uuid>" }
   * await client.sessions.collapse(id);
   * ```
   */
  get sessions() {
    return {
      create: (input?: CreateSessionInput, signal?: AbortSignal, idempotencyKey?: string) =>
        this.createSession(input, signal, idempotencyKey),
      addTurn: (id: string, input: AppendTurnInput, signal?: AbortSignal) =>
        this.appendTurn(id, input, signal),
      pinTurn: (id: string, input: PinSessionTurnInput, signal?: AbortSignal) =>
        this.pinSessionTurn(id, input, signal),
      collapse: (
        id: string,
        input?: CollapseSessionInput,
        signal?: AbortSignal,
        idempotencyKey?: string
      ) => this.collapseSession(id, input, signal, idempotencyKey),
      feedback: (id: string, rating: "up" | "down", signal?: AbortSignal) =>
        this.sessionFeedback(id, rating, signal),
    };
  }

  /**
   * Write a scratch note (ephemeral working-memory entry) to an active session.
   *
   * The `scratch` object is stored under the session's working-memory context.
   * The `note` key conventionally carries the human-readable text; additional
   * arbitrary keys are passed through as metadata (e.g. `{ role, metadata }`).
   *
   * Maps to `POST /session/:id/scratch` (not `/turn` — they are different
   * endpoints: `/scratch` is ephemeral working-memory, `/turn` is transcript).
   * Returns 204 No Content, so this resolves to `void`.
   */
  updateSessionScratch(
    id: string,
    scratch: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/scratch`,
      body: { scratch },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Discard an active session without collapsing it into durable memory.
   *
   * Use when the conversation should be abandoned (e.g. user cancelled or
   * the context is irrelevant) rather than collapsed into knowledge units.
   * The server marks the session as discarded; no extraction pass is run.
   *
   * Maps to `POST /session/:id/discard`. Returns 204 No Content, so this
   * resolves to `void`.
   */
  discardSession(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/session/${encodeURIComponent(id)}/discard`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Trigger an on-demand consolidation pass for the workspace.
   *
   * The background scheduler already runs on its own interval. Use this
   * method when you want to force a consolidation immediately — e.g. after
   * a large batch of `remember` calls, or when the `memory_consolidate`
   * MCP tool is invoked.
   *
   * Only `mode: "fast"` (default) with `dryRun: false` is currently
   * supported and processes a bounded low-worth candidate set. Manual `mode: "deep"`
   * requests throw `MnemosyneAPIError` with status 422 and code
   * `deep_mode_not_supported`. Requests with `dryRun: true` throw status 422
   * with code `dry_run_not_supported`, without running consolidation.
   *
   * Throws `MnemosyneAPIError` with status 503 when required server-side
   * consolidation or storage services are unavailable.
   *
   * Maps to `POST /consolidation/trigger`.
   */
  triggerConsolidation(
    input: TriggerConsolidationInput = {},
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<TriggerConsolidationResponse> {
    return this.http.request<TriggerConsolidationResponse>({
      method: "POST",
      path: "/consolidation/trigger",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /** List tasks for the workspace. Maps to `GET /tasks`. */
  listTasks(params?: ListTasksParams, signal?: AbortSignal): Promise<PaginatedTasksResponse> {
    return this.http.request<PaginatedTasksResponse>({
      method: "GET",
      path: "/tasks",
      query: params ? { ...params } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new task. Maps to `POST /tasks`. */
  createTask(
    body: CreateTaskInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<TaskWire> {
    return this.http.request<TaskWire>({
      method: "POST",
      path: "/tasks",
      body,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** Get a single task by ID. Maps to `GET /tasks/:id`. */
  getTask(id: string, signal?: AbortSignal): Promise<TaskWire> {
    return this.http.request<TaskWire>({
      method: "GET",
      path: `/tasks/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Update fields on an existing task. Maps to `PATCH /tasks/:id`. */
  patchTask(id: string, body: PatchTaskInput, signal?: AbortSignal): Promise<TaskWire> {
    return this.http.request<TaskWire>({
      method: "PATCH",
      path: `/tasks/${encodeURIComponent(id)}`,
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Archive (soft-delete) a task. Maps to `DELETE /tasks/:id`. */
  archiveTask(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/tasks/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** List events for the workspace. Maps to `GET /events`. */
  listEvents(params?: ListEventsParams, signal?: AbortSignal): Promise<PaginatedEventsResponse> {
    return this.http.request<PaginatedEventsResponse>({
      method: "GET",
      path: "/events",
      query: params ? { ...params } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new event (immutable append). Maps to `POST /events`. */
  createEvent(
    body: CreateEventInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<EventWire> {
    return this.http.request<EventWire>({
      method: "POST",
      path: "/events",
      body,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** Get a single event by ID. Maps to `GET /events/:id`. */
  getEvent(id: string, signal?: AbortSignal): Promise<EventWire> {
    return this.http.request<EventWire>({
      method: "GET",
      path: `/events/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * EVENT-1: this is a NO-OP. `mnemo_event` has no status/valid_to column, so
   * `DELETE /events/:id` returns 204 without reading or writing the row —
   * kept only for API symmetry with the other primitives' DELETE routes.
   * Maps to `DELETE /events/:id`.
   */
  archiveEvent(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/events/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Append a human annotation to an immutable event. Maps to `POST /events/:id/annotations`. */
  annotateEvent(
    id: string,
    body: { author: string; content: string; at?: string },
    signal?: AbortSignal
  ): Promise<EventWire> {
    return this.http.request<EventWire>({
      method: "POST",
      path: `/events/${encodeURIComponent(id)}/annotations`,
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Raise an event's sensitivity tier (raise-only — cannot lower).
   * Throws `MnemosyneAPIError` with status 422 if `sensitivity` is below
   * the event's current tier, and with status 404 if the event does not
   * exist or is above the caller's sensitivity ceiling, or (code
   * `sensitivity_above_ceiling`) if `sensitivity` is above that ceiling: the
   * caller could not read the event afterwards, so nothing is changed.
   *
   * Maps to `PATCH /events/:id/sensitivity`.
   */
  updateEventSensitivity(
    id: string,
    input: UpdateEventSensitivityInput,
    signal?: AbortSignal
  ): Promise<EventWire> {
    return this.http.request<EventWire>({
      method: "PATCH",
      path: `/events/${encodeURIComponent(id)}/sensitivity`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  /** List workflows in the workspace. Maps to `GET /workflows`. */
  listWorkflows(
    params?: { status?: string; scopeRef?: string; offset?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<{ items: unknown[]; total: number; hasMore: boolean }> {
    return this.http.request({
      method: "GET",
      path: "/workflows",
      query: params ? { ...params } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new workflow. Maps to `POST /workflows`. */
  createWorkflow(
    body: {
      name: string;
      description?: string;
      steps: unknown[];
      scopeRef?: string;
      metadata?: Record<string, unknown>;
      /** Write into a different workspace than the caller's own (requires a write/admin member). */
      targetWorkspaceId?: string;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.http.request({
      method: "POST",
      path: "/workflows",
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Get a single workflow by ID. Maps to `GET /workflows/:id`. */
  getWorkflow(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.http.request({
      method: "GET",
      path: `/workflows/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Update a workflow's name, description, steps, status or metadata.
   * Maps to `PATCH /workflows/:id`.
   *
   * P111 — same gap as skills: `updateWorkflow` was implemented on every adapter
   * and reachable from nowhere. `status` is the real enum
   * (active | deprecated | draft), not the archived/active pair a reader might
   * assume. At least one field must be supplied.
   */
  updateWorkflow(
    id: string,
    input: {
      name?: string;
      description?: string;
      steps?: Array<{
        order: number;
        action: string;
        condition?: string;
        expectedDurationMs: number;
        tools?: string[];
      }>;
      status?: "active" | "deprecated" | "draft";
      metadata?: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<unknown> {
    return this.http.request({
      method: "PATCH",
      path: `/workflows/${encodeURIComponent(id)}`,
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Reasoning ─────────────────────────────────────────────────────────────

  /** List reasoning chains for the workspace. Maps to `GET /reasoning`. */
  listReasoning(
    params?: ListReasoningParams,
    signal?: AbortSignal
  ): Promise<PaginatedReasoningResponse> {
    return this.http.request<PaginatedReasoningResponse>({
      method: "GET",
      path: "/reasoning",
      query: params ? { ...params } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new reasoning chain. Maps to `POST /reasoning`. */
  createReasoning(body: CreateReasoningInput, signal?: AbortSignal): Promise<ReasoningWire> {
    return this.http.request<ReasoningWire>({
      method: "POST",
      path: "/reasoning",
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Get a single reasoning chain by ID. Maps to `GET /reasoning/:id`. */
  getReasoning(id: string, signal?: AbortSignal): Promise<ReasoningWire> {
    return this.http.request<ReasoningWire>({
      method: "GET",
      path: `/reasoning/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Update fields on an existing reasoning chain. Maps to `PATCH /reasoning/:id`. */
  patchReasoning(
    id: string,
    body: PatchReasoningInput,
    signal?: AbortSignal
  ): Promise<ReasoningWire> {
    return this.http.request<ReasoningWire>({
      method: "PATCH",
      path: `/reasoning/${encodeURIComponent(id)}`,
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Archive (soft-delete) a reasoning chain. Maps to `DELETE /reasoning/:id`. */
  archiveReasoning(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/reasoning/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Resolve a reasoning query against the CoT cache. Maps to `POST /reasoning/resolve`. */
  resolveReasoning(
    body: ResolveReasoningInput,
    signal?: AbortSignal
  ): Promise<ResolveReasoningResponse> {
    return this.http.request<ResolveReasoningResponse>({
      method: "POST",
      path: "/reasoning/resolve",
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Record a completed reasoning chain into the CoT cache. Maps to `POST /reasoning/record`. */
  recordReasoning(body: RecordReasoningInput, signal?: AbortSignal): Promise<ReasoningWire> {
    return this.http.request<ReasoningWire>({
      method: "POST",
      path: "/reasoning/record",
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Submit outcome feedback for a cached reasoning chain. Maps to `POST /reasoning/feedback`. */
  reasoningFeedback(body: ReasoningFeedbackInput, signal?: AbortSignal): Promise<ReasoningWire> {
    return this.http.request<ReasoningWire>({
      method: "POST",
      path: "/reasoning/feedback",
      body,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Strategies ────────────────────────────────────────────────────────────

  /** List strategies for the workspace. */
  listStrategies(
    params?: ListStrategiesParams,
    signal?: AbortSignal
  ): Promise<PaginatedStrategiesResponse> {
    return this.http.request<PaginatedStrategiesResponse>({
      method: "GET",
      path: "/strategies",
      query: { ...params },
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new strategy. */
  createStrategy(
    body: CreateStrategyInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<StrategyWire> {
    return this.http.request<StrategyWire>({
      method: "POST",
      path: "/strategies",
      body,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** Get a single strategy by ID. */
  getStrategy(id: string, signal?: AbortSignal): Promise<StrategyWire> {
    return this.http.request<StrategyWire>({
      method: "GET",
      path: `/strategies/${id}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Patch an existing strategy. */
  patchStrategy(id: string, body: PatchStrategyInput, signal?: AbortSignal): Promise<StrategyWire> {
    return this.http.request<StrategyWire>({
      method: "PATCH",
      path: `/strategies/${id}`,
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Archive a strategy (soft-delete). */
  archiveStrategy(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/strategies/${id}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * §24 Record the outcome of executing a strategy.
   * Triggers a Beta-Bernoulli recompute on the server:
   *   alpha = 2 + successCount, beta = 2 + failureCount, worth = alpha / (alpha + beta).
   * Not idempotent — each call increments successCount or failureCount.
   */
  rateStrategy(
    id: string,
    outcome: "success" | "failure",
    signal?: AbortSignal
  ): Promise<StrategyWire> {
    return this.http.request<StrategyWire>({
      method: "POST",
      path: `/strategies/${id}/rate`,
      body: { outcome },
      ...(signal ? { signal } : {}),
    });
  }

  // ── Hyperedges ─────────────────────────────────────────────────────────────

  /** List hyperedges for this workspace. */
  listHyperedges(
    params?: ListHyperedgesParams,
    signal?: AbortSignal
  ): Promise<PaginatedHyperedgesResponse> {
    return this.http.request<PaginatedHyperedgesResponse>({
      method: "GET",
      path: "/hyperedges",
      query: params ? { ...params } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /** Create a new hyperedge (n-ary relation with ≥3 members). */
  createHyperedge(
    body: CreateHyperedgeInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<HyperedgeWire> {
    return this.http.request<HyperedgeWire>({
      method: "POST",
      path: "/hyperedges",
      body,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /** Get a single hyperedge by ID. */
  getHyperedge(id: string, signal?: AbortSignal): Promise<HyperedgeWire> {
    return this.http.request<HyperedgeWire>({
      method: "GET",
      path: `/hyperedges/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /** Patch an existing hyperedge (label, description, contextQuery). */
  patchHyperedge(
    id: string,
    body: PatchHyperedgeInput,
    signal?: AbortSignal
  ): Promise<HyperedgeWire> {
    return this.http.request<HyperedgeWire>({
      method: "PATCH",
      path: `/hyperedges/${encodeURIComponent(id)}`,
      body,
      ...(signal ? { signal } : {}),
    });
  }

  /** Archive a hyperedge (soft-delete). */
  archiveHyperedge(id: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/hyperedges/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Meta-cognition (§31) ───────────────────────────────────────────────────

  /** Return the workspace SelfModel (§31 meta-cognition). */
  getSelfModel(
    opts?: { aspect?: SelfModelAspect; entity?: string; limit?: number },
    signal?: AbortSignal
  ): Promise<SelfModelResponse> {
    const query = new URLSearchParams();
    if (opts?.aspect) query.set("aspect", opts.aspect);
    if (opts?.entity) query.set("entity", opts.entity);
    if (opts?.limit !== undefined) query.set("limit", String(opts.limit));
    const qs = query.toString();
    return this.http.request<SelfModelResponse>({
      method: "GET",
      path: `/metacognition${qs ? `?${qs}` : ""}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Anticipation (§8) ─────────────────────────────────────────────────────

  /**
   * Return ranked anticipated memories (§8 Anticipation Engine).
   *
   * The `GET /anticipation` route honors four query params:
   *   - `recentlyRecalledId` — drives the sequential ("when I recall X I
   *     usually recall Y") branch. Without it, only periodicity counts.
   *   - `context` — free-text query context for conditional anticipation
   *     patterns (§30). Server caps length at 500 chars.
   *   - `lookAhead` — minutes to anticipate ahead (§30); shifts the
   *     periodic slot. Server default 30, range 0–10080 (one week).
   *   - `limit` — max items, server default 20, range 1–100.
   */
  async getAnticipationFeed(opts?: {
    recentlyRecalledId?: string;
    context?: string;
    lookAhead?: number;
    limit?: number;
  }): Promise<AnticipationFeedResponse> {
    const query = new URLSearchParams();
    if (opts?.recentlyRecalledId) query.set("recentlyRecalledId", opts.recentlyRecalledId);
    if (opts?.context) query.set("context", opts.context);
    if (opts?.lookAhead != null) query.set("lookAhead", String(opts.lookAhead));
    if (opts?.limit != null) query.set("limit", String(opts.limit));
    const qs = query.toString();
    return this.http.request<AnticipationFeedResponse>({
      method: "GET",
      path: `/anticipation${qs ? `?${qs}` : ""}`,
    });
  }

  // ── Composition (§32) ─────────────────────────────────────────────────────

  /**
   * Namespace getter for §32 Compositionality Engine admin routes.
   *
   * @example
   * ```ts
   * const page = await client.composition.listRules({ isActive: true });
   * const rule = await client.composition.createRule({ name: "My Rule", ... });
   * const dryRun = await client.composition.dryRun({ ruleId: "r-1", hits });
   * ```
   */
  get composition(): {
    listRules(opts?: {
      isActive?: boolean;
      offset?: number;
      limit?: number;
      signal?: AbortSignal;
    }): Promise<import("./types.js").ListCompositionRulesResponse>;
    createRule(
      input: {
        name: string;
        conditionDsl: unknown;
        actionDsl: unknown;
        description?: string;
        priority?: number;
        isActive?: boolean;
        source?: "manual" | "mined" | "imported";
        metadata?: Record<string, unknown>;
      },
      signal?: AbortSignal
    ): Promise<CompositionRule>;
    getRule(id: string, signal?: AbortSignal): Promise<CompositionRule>;
    /**
     * P111 — read the append-only inference log. `compositionality.ts` writes an
     * entry on every derivation and nothing could read them back, so "why does
     * this fact exist?" had no answer outside the database. Filter by
     * `derivedId` to trace one primitive's provenance, or by `ruleId` to see
     * what a rule has actually produced.
     */
    listInferences(opts?: {
      ruleId?: string;
      derivedId?: string;
      since?: string;
      offset?: number;
      limit?: number;
      signal?: AbortSignal;
    }): Promise<{
      items: Array<Record<string, unknown>>;
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    }>;
    patchRule(
      id: string,
      patch: {
        name?: string;
        description?: string;
        conditionDsl?: unknown;
        actionDsl?: unknown;
        priority?: number;
        isActive?: boolean;
        metadata?: Record<string, unknown>;
      },
      signal?: AbortSignal
    ): Promise<CompositionRule>;
    dryRun(
      input: {
        ruleId?: string;
        rule?: {
          name: string;
          conditionDsl: unknown;
          actionDsl: unknown;
          priority?: number;
        };
        hits: Array<{
          id: string;
          primitive: string;
          content: string;
          score: number;
          factKind?: string;
          worth?: number;
          tags?: string[];
        }>;
      },
      signal?: AbortSignal
    ): Promise<CompositionDryRunResponse>;
  } {
    const http = this.http;
    return {
      listRules(opts?) {
        const q = new URLSearchParams();
        if (opts?.isActive !== undefined) q.set("isActive", String(opts.isActive));
        if (opts?.offset != null) q.set("offset", String(opts.offset));
        if (opts?.limit != null) q.set("limit", String(opts.limit));
        const qs = q.toString();
        return http.request<import("./types.js").ListCompositionRulesResponse>({
          method: "GET",
          path: `/composition/rules${qs ? `?${qs}` : ""}`,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
      },
      listInferences(opts?) {
        const q = new URLSearchParams();
        if (opts?.ruleId !== undefined) q.set("ruleId", opts.ruleId);
        if (opts?.derivedId !== undefined) q.set("derivedId", opts.derivedId);
        if (opts?.since !== undefined) q.set("since", opts.since);
        if (opts?.offset != null) q.set("offset", String(opts.offset));
        if (opts?.limit != null) q.set("limit", String(opts.limit));
        const qs = q.toString();
        return http.request({
          method: "GET",
          path: `/composition/inferences${qs ? `?${qs}` : ""}`,
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
      },
      createRule(input, signal?) {
        return http.request<CompositionRule>({
          method: "POST",
          path: "/composition/rules",
          body: input,
          ...(signal ? { signal } : {}),
        });
      },
      getRule(id, signal?) {
        return http.request<CompositionRule>({
          method: "GET",
          path: `/composition/rules/${encodeURIComponent(id)}`,
          ...(signal ? { signal } : {}),
        });
      },
      patchRule(id, patch, signal?) {
        return http.request<CompositionRule>({
          method: "PATCH",
          path: `/composition/rules/${encodeURIComponent(id)}`,
          body: patch,
          ...(signal ? { signal } : {}),
        });
      },
      dryRun(input, signal?) {
        return http.request<CompositionDryRunResponse>({
          method: "POST",
          path: "/composition/dry-run",
          body: input,
          ...(signal ? { signal } : {}),
        });
      },
    };
  }

  // ── Wave M2: Self-Editing Memory (spec §13) ───────────────────────────────

  /**
   * Edit the agent's own memory using one of six live actions:
   * append | replace | strengthen | weaken | reflect | link.
   * `target` is polymorphic: fact_id | "profile" | "strategy:{id}".
   * `reason` is required policy and log context, but is not durably audited yet.
   * link: creates an n-ary hyperedge; target=anchor, content=comma-separated co-members (total ≥3).
   *
   * `action: "forget"` is `@deprecated` — the server gates it with a 422
   * (`self_edit_forget_unsupported`) since no approval flow exists to
   * resolve it. Use {@link forgetFact}/{@link forgetPrimitive} instead.
   */
  selfEdit(
    input: {
      action:
        | "append"
        | "replace"
        | "strengthen"
        | "weaken"
        /**
         * @deprecated Server-side gated (422 `self_edit_forget_unsupported`) as of
         * B4 — no approval flow exists to resolve it. Kept so the 422 response
         * stays typed/observable instead of a hard compile break. Use
         * `forgetFact`/`forgetPrimitive` (kind: "fact" | "strategy") instead.
         */
        | "forget"
        | "reflect"
        | "link";
      target: string;
      content?: string;
      reason: string;
      agentId?: string;
      sessionId?: string;
    },
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<SelfEditResponse> {
    return this.http.request<SelfEditResponse>({
      method: "POST",
      path: "/self/edit",
      body: input,
      ...(signal ? { signal } : {}),
      ...(idempotencyKey ? { extraHeaders: { "Idempotency-Key": idempotencyKey } } : {}),
    });
  }

  /**
   * Trigger the reflection cycle immediately for an agent.
   * Returns the episode_id of the synthetic reflection episode plus
   * the lists of strengthened / weakened strategy ids.
   */
  selfReflect(
    input?: { agentId?: string },
    signal?: AbortSignal
  ): Promise<{ episode_id: string; strengthened: string[]; weakened: string[] }> {
    return this.http.request<{ episode_id: string; strengthened: string[]; weakened: string[] }>({
      method: "POST",
      path: "/self/reflect",
      body: input ?? {},
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Retrieve the current agent profile (self-model).
   * Returns an empty profile (summary: "") when none exists yet.
   */
  getSelfProfile(
    agentId?: string,
    signal?: AbortSignal
  ): Promise<{
    workspaceId: string;
    agentId: string;
    summary: string;
    metadata: Record<string, unknown>;
    createdAt: string | null;
    updatedAt: string | null;
  }> {
    const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    return this.http.request({
      method: "GET",
      path: `/self/profile${qs}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Federation (§20) ──────────────────────────────────────────────────────

  /**
   * List all approved peers in the federation mesh.
   * Maps to `GET /memory/federation/peers`.
   */
  listFederationPeers(signal?: AbortSignal): Promise<ListPeersResponse> {
    return this.http.request<ListPeersResponse>({
      method: "GET",
      path: "/memory/federation/peers",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Provision a federation peer (the only way a peer is created).
   * Maps to `POST /memory/federation/peers`. Requires `federation:admin`;
   * answers 409 when the peerId already exists.
   */
  createFederationPeer(input: CreatePeerInput, signal?: AbortSignal): Promise<CreatePeerResponse> {
    return this.http.request<CreatePeerResponse>({
      method: "POST",
      path: "/memory/federation/peers",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List peers awaiting approval plus discovery state.
   * Maps to `GET /memory/federation/peers/pending`.
   */
  listPendingFederationPeers(signal?: AbortSignal): Promise<ListPendingPeersResponse> {
    return this.http.request<ListPendingPeersResponse>({
      method: "GET",
      path: "/memory/federation/peers/pending",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Approve a pending peer (certificate rotation).
   * Maps to `POST /memory/federation/peers/:id/approve`.
   */
  approveFederationPeer(id: string, input: ApprovePeerInput, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/memory/federation/peers/${encodeURIComponent(id)}/approve`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Approve a peer's public key specifically.
   * Maps to `POST /memory/federation/peers/:id/approve-key`.
   */
  approveFederationPeerKey(
    id: string,
    input: ApprovePeerInput,
    signal?: AbortSignal
  ): Promise<ApprovePeerKeyResponse> {
    return this.http.request<ApprovePeerKeyResponse>({
      method: "POST",
      path: `/memory/federation/peers/${encodeURIComponent(id)}/approve-key`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Remove a peer from the federation mesh.
   * Maps to `DELETE /memory/federation/peers/:id`.
   */
  deleteFederationPeer(id: string, signal?: AbortSignal): Promise<DeletePeerResponse> {
    return this.http.request<DeletePeerResponse>({
      method: "DELETE",
      path: `/memory/federation/peers/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Read this workspace's facts as a peer pulls them (needs an `mk_fed_` key
   * and the federation peer headers). Maps to `GET /memory/federation/items`.
   * `cursor` is the `nextCursor` of an earlier page; `knownCursor` is where the
   * caller's previous sync ended, and turns on tombstones for facts created by then.
   */
  listFederationItems(
    opts?: { since?: string; limit?: number; cursor?: string; knownCursor?: string },
    signal?: AbortSignal
  ): Promise<ListFederationItemsResponse> {
    return this.http.request<ListFederationItemsResponse>({
      method: "GET",
      path: "/memory/federation/items",
      query: {
        since: opts?.since,
        limit: opts?.limit,
        cursor: opts?.cursor,
        knownCursor: opts?.knownCursor,
      },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Trigger an immediate sync pull from a peer.
   * Maps to `POST /memory/federation/sync` (returns 202 Accepted).
   */
  triggerFederationSync(
    input: TriggerFederationSyncInput,
    signal?: AbortSignal
  ): Promise<TriggerFederationSyncResponse> {
    return this.http.request<TriggerFederationSyncResponse>({
      method: "POST",
      path: "/memory/federation/sync",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Get status of a federation sync job by its jobId.
   * Maps to `GET /memory/federation/sync/:jobId`.
   */
  getFederationSyncJob(jobId: string, signal?: AbortSignal): Promise<FederationSyncJob> {
    return this.http.request<FederationSyncJob>({
      method: "GET",
      path: `/memory/federation/sync/${encodeURIComponent(jobId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Resolve a conflict between federated claims. Accepts either a
   * two-item pair (`{ itemA, itemB }`) or a batch (`{ items: [...] }`).
   *
   * Maps to `POST /memory/federation/resolve`.
   */
  resolveFederationConflict(
    input: ResolveFederationConflictPairInput | ResolveFederationConflictBatchInput,
    signal?: AbortSignal
  ): Promise<ResolveFederationConflictResponse> {
    return this.http.request<ResolveFederationConflictResponse>({
      method: "POST",
      path: "/memory/federation/resolve",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  // ── P4-D: Conflict resolution (memory_judge) ──────────────────────────────

  /**
   * List unresolved conflict pairs in the workspace.
   *
   * Conflicts are `conflicts_with` relations between active facts that have
   * not yet been resolved. The list is sorted newest-first. Use
   * `resolveConflict` to apply a resolution action to each pair.
   *
   * @param limit - Max pairs to return. Default 5, max 20.
   * Maps to `GET /conflicts`.
   */
  judge(opts?: { limit?: number }, signal?: AbortSignal): Promise<ListConflictsResponse> {
    return this.http.request<ListConflictsResponse>({
      method: "GET",
      path: "/conflicts",
      query: opts?.limit != null ? { limit: opts.limit } : undefined,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Resolve a specific conflict pair by its `relationId`.
   *
   * Four resolution strategies:
   *   - `supersede_a`: forget factA, relation becomes `supersedes`.
   *   - `supersede_b`: forget factB, relation becomes `supersedes`.
   *   - `keep_both`: mark as `not_conflict` (both facts stay active).
   *   - `merge`: forget both, create a new merged fact, relation becomes `supersedes`.
   *     `mergedStatement` is required for this action.
   *
   * Maps to `POST /conflicts/:id/resolve`.
   */
  resolveConflict(
    relationId: string,
    input: ResolveConflictInput,
    signal?: AbortSignal
  ): Promise<ResolveConflictResponse> {
    return this.http.request<ResolveConflictResponse>({
      method: "POST",
      path: `/conflicts/${encodeURIComponent(relationId)}/resolve`,
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  // ── WebSocket subscriptions ────────────────────────────────────────────────

  /**
   * Subscribe to a Mnemosyne event channel via WebSocket.
   *
   * Opens a WebSocket to `/memory/ws?token=<apiKey>`, sends a subscribe
   * frame for `channel`, and calls `handler` for each matching event.
   *
   * Requires a `WebSocket` global (native in Node ≥ 22 and browsers; inject
   * via `opts.WebSocketImpl` for older environments):
   *
   * ```ts
   * import WebSocket from "ws"; // npm install ws
   * const handle = client.subscribe("facts.*", console.log, { WebSocketImpl: WebSocket });
   * ```
   *
   * Live server integration requires Wave Q WS wiring to be confirmed.
   * Tests are skipped until then.
   *
   * @param channel - Glob channel, e.g. `"facts.*"`, `"session.abc123"`.
   * @param handler - Called with each raw bus event payload (JSON).
   * @param opts    - Optional filter / disconnect / WebSocketImpl.
   */
  // UNSKIP after Wave Q server wiring is confirmed.
  subscribe(
    channel: string,
    handler: (event: Record<string, unknown>) => void,
    opts?: SubscribeOptions
  ): SubscribeHandle {
    const base = this.http["config"].baseUrl.replace(/^http/, "ws");
    const url = `${base}/memory/ws?token=${encodeURIComponent(this.http["config"].apiKey)}`;

    const WS = opts?.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (!WS) {
      throw new Error(
        "MnemosyneClient.subscribe: no WebSocket implementation available. " +
          "Pass `opts.WebSocketImpl` (e.g. from the `ws` npm package) or use Node ≥ 22."
      );
    }

    const ws = new WS(url);
    let _connected = false;

    ws.addEventListener("open", () => {
      _connected = true;
      ws.send(
        JSON.stringify({
          subscribe: {
            channel,
            ...(opts?.filter ? { filter: opts.filter } : {}),
          },
        })
      );
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        // Ignore protocol frames (subscribe ack, ping, etc.)
        if (
          data &&
          typeof data === "object" &&
          !("subscribe" in data) &&
          !("unsubscribe" in data)
        ) {
          handler(data as Record<string, unknown>);
        }
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      _connected = false;
      if (opts?.onDisconnect) {
        opts.onDisconnect(String(ev.reason ?? ev.code));
      }
    });

    return {
      close() {
        _connected = false;
        ws.close(1000, "client closed");
      },
      get connected() {
        return _connected;
      },
    };
  }

  // ── gRPC / ConnectRPC transport ────────────────────────────────────────────

  // ── Passive capture (P4-C) ────────────────────────────────────────────────

  /**
   * Passive capture — send subagent or pipeline output to Mnemosyne for
   * automatic fact extraction.
   *
   * The server extracts 0-3 durable facts from `content`. When an LLM is
   * configured server-side it uses guided extraction; otherwise regex
   * heuristics detect decision/bugfix/config patterns. Identical content
   * within the same workspace is deduplicated via content-hash.
   *
   * Designed for fire-and-forget use from Claude Code hooks:
   * ```ts
   * await client.capture({ content: agentStdout, source: "subagent-stop" });
   * ```
   *
   * Maps to `POST /capture`.
   */
  capture(
    opts: { content: string; source: string },
    signal?: AbortSignal
  ): Promise<{ extracted: number; skipped: number }> {
    return this.http.request<{ extracted: number; skipped: number }>({
      method: "POST",
      path: "/capture",
      body: opts,
      ...(signal ? { signal } : {}),
    });
  }

  // ── P5-C: Hard-delete / purge ─────────────────────────────────────────────

  /**
   * Hard-delete a single fact by ID (GDPR / test-workspace cleanup).
   *
   * Performs a physical DELETE on `mnemo_fact`. The row is permanently removed —
   * this bypasses the bitemporal model and cannot be undone. Use only in
   * test workspaces or when legally required.
   *
   * Requires `memory:hard_delete` scope on the API key. Returns 403 when the
   * key lacks that scope.
   *
   * Maps to `DELETE /facts/:id/hard`.
   */
  purgeFact(id: string, signal?: AbortSignal): Promise<PurgeFactResponse> {
    return this.http.request<PurgeFactResponse>({
      method: "DELETE",
      path: `/facts/${encodeURIComponent(id)}/hard`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * GDPR crypto-erasure: destroy every encryption key of a user (`userId`) or
   * the key of one actor (`actorId`) in the workspace, so their confidential
   * and restricted memory can never be decrypted again. Irreversible;
   * `confirm` must repeat the subject id.
   *
   * Requires `memory:hard_delete` scope on the API key.
   *
   * Maps to `POST /admin/erasure`.
   */
  eraseSubject(input: EraseSubjectInput, signal?: AbortSignal): Promise<EraseSubjectResponse> {
    return this.http.request<EraseSubjectResponse>({
      method: "POST",
      path: "/admin/erasure",
      body: input,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Bulk hard-delete all closed (forgotten) facts in the workspace.
   *
   * Deletes every fact whose `status = 'forgotten'` (i.e. facts that were
   * soft-deleted via `memory_forget`). Useful for reclaiming space in test
   * workspaces after a test run.
   *
   * Requires `memory:hard_delete` scope on the API key. Returns 403 when the
   * key lacks that scope.
   *
   * Maps to `DELETE /facts/purge`.
   */
  purgeClosedFacts(signal?: AbortSignal): Promise<PurgeClosedFactsResponse> {
    return this.http.request<PurgeClosedFactsResponse>({
      method: "DELETE",
      path: "/facts/purge",
      ...(signal ? { signal } : {}),
    });
  }

  // ── P7: Key management ────────────────────────────────────────────────────────

  /**
   * List API keys for the current workspace.
   * Requires `admin:keys` scope.
   */
  listKeys(
    options?: { expired?: boolean },
    signal?: AbortSignal
  ): Promise<{ keys: KeyListItem[] }> {
    const path = options?.expired ? "/admin/keys?expired=true" : "/admin/keys";
    return this.http.request<{ keys: KeyListItem[] }>({
      method: "GET",
      path,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a new API key for the current workspace.
   * Plaintext key is returned ONCE in the response.
   * Requires `admin:keys` scope.
   */
  createKey(input: CreateKeyInput, signal?: AbortSignal): Promise<CreateKeyResponse> {
    return this.http.request<CreateKeyResponse>({
      method: "POST",
      path: "/admin/keys",
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Get metadata for a single API key (secret is never returned).
   * Requires `admin:keys` scope.
   */
  getKey(keyId: string, signal?: AbortSignal): Promise<KeyDetailResponse> {
    return this.http.request<KeyDetailResponse>({
      method: "GET",
      path: `/admin/keys/${encodeURIComponent(keyId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Revoke an API key by ID.
   * Requires `admin:keys` scope.
   */
  revokeKey(keyId: string, signal?: AbortSignal): Promise<{ ok: boolean; revokedAt: string }> {
    return this.http.request<{ ok: boolean; revokedAt: string }>({
      method: "DELETE",
      path: `/admin/keys/${encodeURIComponent(keyId)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Rotate an API key by ID. Generates a new key with 7 days sunset grace for the old key.
   * Requires `admin:keys` scope.
   */
  rotateKey(
    keyId: string,
    input?: { reason?: string },
    signal?: AbortSignal
  ): Promise<RotateKeyResponse> {
    return this.http.request<RotateKeyResponse>({
      method: "POST",
      path: `/admin/keys/${encodeURIComponent(keyId)}/rotate`,
      ...(input ? { body: input as unknown as Record<string, unknown> } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Issue a scoped-scheme key (`mk_live_`, `mk_sess_` or `mk_admin_`), the kind
   * `MNEMO_SCOPED_AUTH=1` verifies. An `mk_admin_` key also returns its TOTP
   * secret, once. Requires `admin:keys`.
   */
  issueScopedKey(
    input: IssueScopedKeyInput,
    signal?: AbortSignal
  ): Promise<IssueScopedKeyResponse> {
    return this.http.request<IssueScopedKeyResponse>({
      method: "POST",
      path: "/admin/scoped-keys",
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  /** Rotate a scoped-scheme key by its id; the old key keeps 7 days. Requires `admin:keys`. */
  rotateScopedKey(
    id: string,
    input?: { reason?: string },
    signal?: AbortSignal
  ): Promise<RotateScopedKeyResponse> {
    return this.http.request<RotateScopedKeyResponse>({
      method: "POST",
      path: `/admin/scoped-keys/${encodeURIComponent(id)}/rotate`,
      ...(input ? { body: input as unknown as Record<string, unknown> } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Revoke a scoped-scheme key by its id, at once. Requires `admin:keys`. */
  revokeScopedKey(id: string, signal?: AbortSignal): Promise<{ ok: boolean; revokedAt: string }> {
    return this.http.request<{ ok: boolean; revokedAt: string }>({
      method: "DELETE",
      path: `/admin/scoped-keys/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  // ── §19 Agent RBAC policies ──────────────────────────────────────────────────

  /** List every agent policy of the workspace. Requires `memory:admin`. */
  listAgentPolicies(signal?: AbortSignal): Promise<{ policies: AgentPolicy[] }> {
    return this.http.request<{ policies: AgentPolicy[] }>({
      method: "GET",
      path: "/admin/agent-policies",
      ...(signal ? { signal } : {}),
    });
  }

  /** Read one agent's policy; 404 when it has none. Requires `memory:admin`. */
  getAgentPolicy(agentId: string, signal?: AbortSignal): Promise<AgentPolicy> {
    return this.http.request<AgentPolicy>({
      method: "GET",
      path: "/admin/agent-policy",
      query: { agentId },
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create or replace one agent's policy in the workspace. Requires
   * `memory:admin`; a key cannot change its own policy (403).
   */
  putAgentPolicy(input: AgentPolicyInput, signal?: AbortSignal): Promise<AgentPolicy> {
    return this.http.request<AgentPolicy>({
      method: "PUT",
      path: "/admin/agent-policy",
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  /** Delete one agent's policy; 404 when it has none. Requires `memory:admin`. */
  deleteAgentPolicy(agentId: string, signal?: AbortSignal): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: "/admin/agent-policy",
      query: { agentId },
      ...(signal ? { signal } : {}),
    });
  }

  // ── B6.11: Skill primitive ───────────────────────────────────────────────────

  /**
   * Create a new Skill (stored prompt template).
   * Maps to `POST /skills`.
   */
  createSkill(input: CreateSkillClientInput, signal?: AbortSignal): Promise<SkillWire> {
    return this.http.request<SkillWire>({
      method: "POST",
      path: "/skills",
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * List skills for the current workspace.
   * Maps to `GET /skills`.
   */
  listSkills(
    options?: { offset?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<SkillListResponse> {
    const params = new URLSearchParams();
    if (options?.offset !== undefined) params.set("offset", String(options.offset));
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.http.request<SkillListResponse>({
      method: "GET",
      path: query ? `/skills?${query}` : "/skills",
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Get a single skill by ID.
   * Maps to `GET /skills/:id`.
   */
  getSkill(id: string, signal?: AbortSignal): Promise<SkillWire> {
    return this.http.request<SkillWire>({
      method: "GET",
      path: `/skills/${encodeURIComponent(id)}`,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Update a skill's template, name, variables or metadata.
   * Maps to `PATCH /skills/:id`.
   *
   * P111 — skills were creatable and never editable: `updateSkill` existed on
   * every storage adapter with no route and no caller above it. At least one
   * field must be supplied; the server rejects an empty body rather than
   * issuing a no-op write.
   */
  updateSkill(
    id: string,
    input: {
      name?: string;
      promptTemplate?: string;
      variables?: string[];
      requiredContext?: string[];
      metadata?: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<SkillWire> {
    return this.http.request<SkillWire>({
      method: "PATCH",
      path: `/skills/${encodeURIComponent(id)}`,
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  // ── B6.12: Task delegation ───────────────────────────────────────────────────

  /**
   * Delegate a task to another agent, setting delegatedBy and delegatedAt provenance fields.
   * Maps to `POST /tasks/:id/delegate`.
   */
  delegateTask(id: string, input: { assignedTo: string }, signal?: AbortSignal): Promise<TaskWire> {
    return this.http.request<TaskWire>({
      method: "POST",
      path: `/tasks/${encodeURIComponent(id)}/delegate`,
      body: input as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Create a gRPC/ConnectRPC transport for typed streaming calls.
   *
   * **This is a stub.** The real implementation requires the optional peer
   * dependency `@connectrpc/connect`. Install it with:
   *
   * ```sh
   * npm install @connectrpc/connect @connectrpc/connect-web
   * ```
   *
   * Once installed, replace this stub by importing and returning
   * `createConnectTransport(...)` from `@connectrpc/connect-web`.
   *
   * @throws Error — always, until `@connectrpc/connect` is installed.
   */
  createGrpcTransport(): never {
    // Detect whether the optional dep is available at call time.
    // We do NOT static-import it (that would make it a hard dep).
    try {
      // Dynamic require so bundlers don't complain about missing module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@connectrpc/connect");
    } catch {
      throw new Error(
        "MnemosyneClient.createGrpcTransport: optional dependency " +
          "`@connectrpc/connect` is not installed.\n" +
          "Install it with: npm install @connectrpc/connect @connectrpc/connect-web\n" +
          "Then use createConnectTransport() from @connectrpc/connect-web directly."
      );
    }
    throw new Error("MnemosyneClient.createGrpcTransport: stub — install @connectrpc/connect.");
  }
}
