/**
 * Multi-level recall — Gap 4.
 *
 * When a request has userId and/or tenantId, runs recall in parallel across:
 *   1. The current workspace (weight 1.0)
 *   2. The user's personal workspace (weight 0.8)  — only when userId is set
 *   3. The tenant's shared workspace(s) (weight 0.6) — only when tenantId is set
 *
 * Merges hits by score×weight, deduplicates by id (workspace hit wins ties).
 * Falls back gracefully to workspace-only recall if DB lookup fails.
 *
 * The personal_workspace_id is stored on mnemo_user.personal_tenant_id.
 * For tenant-level facts we search the workspace where scope_owner = "tenant:<id>".
 * In practice, tenant facts live in the workspace owned by the tenant (the one
 * created when the tenant was set up) — we find it via mnemo_workspace.tenant_id.
 */

import type postgres from "postgres";
import type { MnemoCore } from "../deps.js";
import type { RecallQuery, RecallResponse, RecallHit } from "@mnemo-ai/types";

interface MultiLevelCtx {
  sql: postgres.Sql;
  cognitive: MnemoCore;
  auth: import("@mnemo-ai/types").AuthContext;
  /** Measured serving metadata of each child recall, keyed by its workspace. */
  onRecallMeta?: (
    workspaceId: string,
    meta: import("@mnemo-ai/core/cognitive").RecallServeMeta
  ) => void;
}

/** Fetch the workspace_id of a user's personal workspace. */
export async function getUserPersonalWorkspaceId(
  sql: postgres.Sql,
  userId: string
): Promise<string | null> {
  try {
    return (await sql.begin(async (tx) => {
      // Set actor GUC so RLS on mnemo_user and mnemo_workspace applies correctly.
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`;
      type Row = { personal_tenant_id: string };
      const rows = await tx<Row[]>`
        SELECT personal_tenant_id FROM mnemosyne.mnemo_user WHERE id = ${userId} LIMIT 1
      `;
      if (!rows[0]) return null;
      type WsRow = { id: string };
      const ws = await tx<WsRow[]>`
        SELECT id FROM mnemosyne.mnemo_workspace
        WHERE tenant_id = ${rows[0].personal_tenant_id}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      return ws[0]?.id ?? null;
    })) as string | null;
  } catch {
    return null;
  }
}

/** Fetch the primary workspace_id for a tenant (oldest workspace = canonical). */
async function getTenantWorkspaceId(sql: postgres.Sql, tenantId: string): Promise<string | null> {
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${tenantId}, true)`;
      type Row = { id: string };
      const rows = await tx<Row[]>`
        SELECT id FROM mnemosyne.mnemo_workspace
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      return rows[0]?.id ?? null;
    })) as string | null;
  } catch {
    return null;
  }
}

/** Wire-level source label added to merged hits (not part of RecallHit core type). */
export type MultiLevelSource = "workspace" | "personal" | "tenant";

/**
 * B1 — narrows `multiLevelRecall` to a single level instead of the default
 * workspace+personal+tenant blend. `only: "personal"` skips the workspace and
 * tenant promises entirely and runs recall against the caller's personal
 * workspace only, at weight 1.0 (the default 0.8 exists only to rank personal
 * results *below* workspace results in a blend — irrelevant when personal is
 * the only level).
 */
export type MultiLevelOptions = { only?: "personal" };

/** RecallHit extended with a wire-only source label. */
export type MultiLevelHit = RecallHit & { _source?: MultiLevelSource; _workspaceId?: string };

/**
 * Merge and deduplicate hits from multiple recall results, applying per-level weight.
 *
 * Each level may specify an `exactScopeOwner` to filter hits before merging.
 * A hit passes the filter when:
 *   - `exactScopeOwner` is not set (workspace level — no filtering), OR
 *   - `hit.scopeOwner` is absent/undefined (legacy fact without scope_owner —
 *     pass through), unless the level is `strictOwner` (personal-only recall,
 *     where an unlabelled row is nobody's personal memory — RECALL-6), OR
 *   - `hit.scopeOwner === exactScopeOwner` (exact ownership match).
 *
 * This prevents facts belonging to a different workspace from leaking through
 * when they happen to be physically stored in a shared personal/tenant workspace.
 */
function passesOwner(hit: RecallHit, exactScopeOwner?: string, strictOwner = false): boolean {
  if (!exactScopeOwner) return true;
  if (hit.scopeOwner === exactScopeOwner) return true;
  return !strictOwner && hit.scopeOwner === undefined;
}

/**
 * WP-3 review: whether one level contributes something relevant, judged on the
 * hits that survive its ownership filter. A level's own `nothingRelevant` was
 * computed over every row its workspace holds; once rows owned by someone else
 * are dropped, a relevant workspace-owned fact in the personal workspace must
 * not make the surviving unrelated hits look relevant.
 */
function levelRelevant(
  result: RecallResponse,
  exactScopeOwner?: string,
  strictOwner = false
): boolean {
  const eligible = result.hits.filter((hit) => passesOwner(hit, exactScopeOwner, strictOwner));
  if (eligible.length === 0 || result.nothingRelevant === true) return false;
  if (!exactScopeOwner) return true;
  const floor = result.debug?.relevanceFloor;
  const measured = eligible.filter((hit) => hit.similarity !== undefined);
  // No floor, or no cosine to judge (lexical, hot tier): non-empty is all the
  // level can vouch for — the same rule core applies.
  if (floor === undefined || measured.length === 0) return true;
  return measured.some((hit) => hit.similarity! >= floor);
}

function mergeHits(
  levels: Array<{
    hits: RecallHit[];
    weight: number;
    exactScopeOwner?: string;
    strictOwner?: boolean;
    source: MultiLevelSource;
  }>,
  limit: number
): MultiLevelHit[] {
  const seen = new Map<string, MultiLevelHit>();

  for (const { hits, weight, exactScopeOwner, strictOwner, source } of levels) {
    for (const hit of hits) {
      // Filter by scopeOwner when the level declares an expected owner.
      // Legacy hits (scopeOwner absent) pass through on the blended levels to
      // avoid breaking deployments that predate the scope_owner column.
      if (!passesOwner(hit, exactScopeOwner, strictOwner)) continue;
      if (seen.has(hit.id)) continue; // workspace hit wins — already inserted
      seen.set(hit.id, { ...hit, score: hit.score * weight, _source: source });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Run recall across up to 3 levels and merge results.
 *
 * @param baseQuery  The workspace-level query (already has workspaceId set)
 * @param userId     From getAuthCtx(c).userId — may be null for legacy keys
 * @param tenantId   From getAuthCtx(c).tenantId — may be null for legacy keys
 * @param ctx        DB + cognitive engine handles
 * @param options    B1 — `{ only: "personal" }` restricts to the personal level only
 */
export async function multiLevelRecall(
  baseQuery: RecallQuery,
  userId: string | null | undefined,
  tenantId: string | null | undefined,
  ctx: MultiLevelCtx,
  options?: MultiLevelOptions
): Promise<RecallResponse> {
  const { sql, cognitive, auth } = ctx;
  const limit = baseQuery.limit ?? 10;
  // Children defer only the observation (the route records one per workspace)
  // and still reinforce in their own workspace; each hit is tagged with its
  // storage workspace (server-only; never on the wire).
  const recallChild = (q: RecallQuery, a: typeof auth) =>
    cognitive
      .recall(q, a, {
        deferObservation: true,
        onRecallMeta: (meta) => ctx.onRecallMeta?.(q.workspaceId, meta),
      })
      .then((r) => ({
        ...r,
        hits: r.hits.map((h): MultiLevelHit => ({ ...h, _workspaceId: q.workspaceId })),
      }));

  // B1: personal-only mode — skip the workspace/tenant promises entirely and
  // run recall against just the personal workspace, merged at weight 1.0.
  // Defensive by design: returns an empty result (never throws) when there is
  // no userId or no resolvable personal workspace — the route layer is
  // responsible for turning those same conditions into the 400 error-parity
  // response documented at routes/recall.ts (mirroring routes/remember.ts).
  if (options?.only === "personal") {
    const emptyResult: RecallResponse = {
      hits: [],
      total: 0,
      query: { text: baseQuery.text, limit, offset: baseQuery.offset ?? 0 },
      latencyMs: 0,
      fromHotTier: false,
    };
    if (!userId) return emptyResult;

    const personalWsId = await getUserPersonalWorkspaceId(sql, userId).catch(() => null);
    if (!personalWsId) return emptyResult;

    // RECALL-6: the ownership filter goes INTO the query, so core applies it
    // before ranking and pagination. Filtering only here, after core had
    // already cut the page, let workspace memories fill it whenever the
    // personal workspace is the active one — and the personal fact never came.
    const owner = `user:${userId}`;
    const personalResult = await recallChild(
      {
        ...baseQuery,
        workspaceId: personalWsId,
        filter: { ...(baseQuery.filter ?? {}), scopeOwner: owner },
      },
      { ...auth, workspaceId: personalWsId }
    );
    const mergedHits = mergeHits(
      [
        {
          hits: personalResult.hits,
          weight: 1.0,
          exactScopeOwner: owner,
          strictOwner: true,
          source: "personal",
        },
      ],
      limit
    );
    const personalRelevant = levelRelevant(personalResult, owner, true);
    return {
      ...personalResult,
      hits: mergedHits,
      total: mergedHits.length,
      nothingRelevant: mergedHits.length === 0 || !personalRelevant,
    };
  }

  // Always run workspace recall
  const workspaceRecallPromise = recallChild(baseQuery, auth);

  // Conditionally run user + tenant recall in parallel
  const userWsPromise = userId
    ? getUserPersonalWorkspaceId(sql, userId)
        .then((wsId) =>
          wsId && wsId !== baseQuery.workspaceId
            ? recallChild({ ...baseQuery, workspaceId: wsId }, { ...auth, workspaceId: wsId })
            : null
        )
        .catch(() => null)
    : Promise.resolve(null);

  const tenantWsPromise = tenantId
    ? getTenantWorkspaceId(sql, tenantId)
        .then((wsId) =>
          wsId && wsId !== baseQuery.workspaceId
            ? recallChild({ ...baseQuery, workspaceId: wsId }, { ...auth, workspaceId: wsId })
            : null
        )
        .catch(() => null)
    : Promise.resolve(null);

  const [workspaceResult, userResult, tenantResult] = await Promise.all([
    workspaceRecallPromise,
    userWsPromise,
    tenantWsPromise,
  ]);

  // If no extra levels found anything, return workspace result with workspace source labels
  if (!userResult && !tenantResult) {
    return {
      ...workspaceResult,
      hits: workspaceResult.hits.map((h) => ({ ...h, _source: "workspace" as MultiLevelSource })),
    };
  }

  // Workspace level: no exactScopeOwner filter — all hits are valid for this workspace.
  // User level: filter to facts owned by this user (personal preferences/facts).
  // Tenant level: filter to facts owned by this tenant (company-wide facts).
  const levels: Array<{
    hits: RecallHit[];
    weight: number;
    exactScopeOwner?: string;
    source: MultiLevelSource;
  }> = [{ hits: workspaceResult.hits, weight: 1.0, source: "workspace" }];
  if (userResult)
    levels.push({
      hits: userResult.hits,
      weight: 0.8,
      exactScopeOwner: `user:${userId}`,
      source: "personal",
    });
  if (tenantResult)
    levels.push({
      hits: tenantResult.hits,
      weight: 0.6,
      exactScopeOwner: `tenant:${tenantId}`,
      source: "tenant",
    });

  const mergedHits = mergeHits(levels, limit);

  return {
    ...workspaceResult,
    hits: mergedHits,
    total: mergedHits.length,
    // Something is relevant if any level found something relevant among the
    // hits its ownership filter keeps.
    nothingRelevant:
      mergedHits.length === 0 ||
      !(
        levelRelevant(workspaceResult) ||
        (userResult !== null && levelRelevant(userResult, `user:${userId}`)) ||
        (tenantResult !== null && levelRelevant(tenantResult, `tenant:${tenantId}`))
      ),
  };
}
