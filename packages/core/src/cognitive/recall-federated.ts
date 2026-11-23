/**
 * Federated items as one more recall source.
 *
 * A federation sync stores what it pulls in `mnemo_federated_item`, apart from
 * the workspace's own memory, and for a long time nothing read it. This adds
 * those items to the page AFTER the hot → pointer → cold cascade answered, so no
 * tier, cache, recall log or worth update ever sees them: they are not local
 * memory and never become it by being recalled.
 *
 * They have no embedding, so only a lexical match finds them, and they are
 * trust-capped (provenance `federation_received`, trust 20, the lowest anchor).
 * Hence the page order: after the local hits when recall judged those relevant,
 * before them when it judged nothing relevant (a lexical match of the question
 * beats the least-bad local filler).
 *
 * Only when the query asks (`includeFederated`, set by POST /recall, which
 * marks them). Skipped when it could not honour the request: strict `semantic`
 * mode (it promises vectors only), a page past the first, a `kinds` list
 * without `fact`, a provenance filter without `federation_received`, or any
 * filter on fields a federated item does not have (scope, owner, actor, ...).
 */
import type {
  AuthContext,
  RecallHit,
  RecallQuery,
  RecallResponse,
  Sensitivity,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { heldAt, recallFilterForAuth } from "./recall-cold.js";
import { scoreInjection, DEFAULT_INJECTION_THRESHOLD } from "../security/injection.js";
import { hitFreshness } from "./freshness.js";

/** Filter fields a federated item can satisfy; any other set field skips the source. */
const FEDERATION_FILTERS = new Set(["kinds", "sensitivity", "provenance"]);

function parseDate(value: string | null): Date | null | undefined {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function withFederatedHits(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  resp: RecallResponse
): Promise<RecallResponse> {
  const limit = resp.query.limit;
  const filter = query.filter ?? {};
  const terms = query.text.split(/\s+/).filter((t) => t.length > 0);
  if (
    !query.includeFederated ||
    !ctx.storage.federatedRecallCandidates ||
    limit <= 0 ||
    terms.length === 0 ||
    (query.offset ?? 0) > 0 ||
    query.mode === "semantic" ||
    Object.entries(filter).some(([key, v]) => v !== undefined && !FEDERATION_FILTERS.has(key)) ||
    (filter.kinds && !filter.kinds.includes("fact")) ||
    (filter.provenance && !filter.provenance.includes("federation_received"))
  ) {
    return resp;
  }

  const sensitivity = recallFilterForAuth(filter, auth).sensitivity as Sensitivity[];
  const rows = await ctx.storage
    .federatedRecallCandidates({ workspaceId: query.workspaceId, terms, limit, sensitivity })
    .catch((err: unknown) => {
      ctx.logger.warn("recall.federated_failed", {
        workspaceId: query.workspaceId,
        error: {
          type: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return [];
    });

  const at = query.asOf ?? new Date();
  const nowMs = Date.now();
  const federated: RecallHit[] = [];
  for (const row of rows) {
    const validFrom = parseDate(row.validFrom);
    const validTo = parseDate(row.validTo);
    // A peer that sent an unreadable validity window gets no say about when.
    // ponytail: filtered after the SQL limit, so an asOf page can come up short.
    if (!validFrom || validTo === undefined || !heldAt({ validFrom, validTo }, at)) continue;
    const injection = scoreInjection(
      row.statement,
      ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
    );
    federated.push({
      id: row.id,
      primitive: "fact",
      content: row.statement,
      score: injection.flagged ? row.lexicalRank * (1 - injection.score) : row.lexicalRank,
      sensitivity: row.sensitivity,
      injectionScore: injection.score,
      provenance: "federation_received",
      origin: `federation:${row.peerDomain}`,
      contested: false,
      status: "active",
      validFrom,
      validTo,
      tags: [],
      relations: [],
      hitFreshness: hitFreshness(validFrom, nowMs),
    });
  }
  if (federated.length === 0) return resp;

  const hits = (
    resp.nothingRelevant === true ? [...federated, ...resp.hits] : [...resp.hits, ...federated]
  ).slice(0, limit);
  return { ...resp, hits, total: resp.total + federated.length, nothingRelevant: false };
}
