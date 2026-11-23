/** Shapes of POST /recall (with debug) and POST /recall/explain, validated at the edge. */

export const KINDS = ["fact", "decision", "episode", "entity", "strategy", "workflow", "skill"];
export const TOP_KS = [10, 20, 50, 100];
/** One explain call per query, at the route's cap of 50: it matches as many of the hits as it can. */
export const EXPLAIN_LIMIT = 50;

/** The `code` of a server error body, when it has one. */
export async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const j: unknown = await res.json();
    return rec(j) && str(j.code) ? j.code : undefined;
  } catch {
    return undefined;
  }
}

export interface Stage {
  name: string;
  candidatesIn: number | null;
  candidatesOut: number | null;
  ms: number;
}
export interface Hit {
  id: string;
  primitive: string;
  content: string;
  score: number;
  similarity?: number;
  status?: string;
  hitFreshness?: string;
  validFrom?: string;
}
export interface Recall {
  hits: Hit[];
  trace: Stage[];
  latencyMs: number | null;
  nothingRelevant: boolean;
  /** The cosine floor `nothingRelevant` was judged against; null when none applied. */
  relevanceFloor: number | null;
}
export interface Why {
  worth?: number;
  worthLowerBound?: number;
  injectionScore: number;
  provenance: string;
  contested: boolean;
  servedFromHotTier: boolean;
  relationCount: number;
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const count = (v: unknown): number | null => (num(v) ? v : null);

function parseHit(v: unknown): Hit | null {
  if (!rec(v) || !str(v.id) || !str(v.content) || !num(v.score)) return null;
  return {
    id: v.id,
    content: v.content,
    score: v.score,
    // POST /recall names the primitive `kind`; `primitive` is only a fallback.
    primitive: str(v.kind) ? v.kind : str(v.primitive) ? v.primitive : "fact",
    similarity: num(v.similarity) ? v.similarity : undefined,
    status: str(v.status) ? v.status : undefined,
    hitFreshness: str(v.hitFreshness) ? v.hitFreshness : undefined,
    validFrom: str(v.validFrom) ? v.validFrom : undefined,
  };
}

function parseStage(v: unknown): Stage | null {
  if (!rec(v) || !str(v.name) || !num(v.ms)) return null;
  return {
    name: v.name,
    ms: v.ms,
    candidatesIn: count(v.candidatesIn),
    candidatesOut: count(v.candidatesOut),
  };
}

/** null when the body is not a recall response; malformed hits and stages are dropped. */
export function parseRecall(json: unknown): Recall | null {
  if (!rec(json) || !Array.isArray(json.hits)) return null;
  const trace = rec(json.debug) && Array.isArray(json.debug.trace) ? json.debug.trace : [];
  return {
    hits: json.hits.map(parseHit).filter((h): h is Hit => h !== null),
    trace: trace.map(parseStage).filter((s): s is Stage => s !== null),
    latencyMs: rec(json.debug) ? count(json.debug.latencyMs) : null,
    nothingRelevant: json.nothingRelevant === true,
    relevanceFloor: rec(json.debug) ? count(json.debug.relevanceFloor) : null,
  };
}

/** Explanations by hit id; null when the body is not an explain response. */
export function parseExplain(json: unknown): Map<string, Why> | null {
  if (!rec(json) || !Array.isArray(json.hits)) return null;
  const out = new Map<string, Why>();
  for (const h of json.hits) {
    if (!rec(h) || !str(h.id) || !rec(h.explain)) continue;
    const e = h.explain;
    if (!num(e.injectionScore) || !str(e.provenance) || !num(e.relationCount)) continue;
    out.set(h.id, {
      worth: num(e.worth) ? e.worth : undefined,
      worthLowerBound: num(e.worthLowerBound) ? e.worthLowerBound : undefined,
      injectionScore: e.injectionScore,
      provenance: e.provenance,
      contested: e.contested === true,
      servedFromHotTier: e.servedFromHotTier === true,
      relationCount: e.relationCount,
    });
  }
  return out;
}

/** Bar fill 0..1: the raw cosine when measured, else the score relative to the best hit. */
export function strength(hit: Hit, best: number): number {
  const v = hit.similarity ?? (best > 0 ? hit.score / best : 0);
  return Math.max(0, Math.min(1, v));
}

/**
 * Below the floor: with nothing relevant, every hit is only a least-bad match; otherwise a hit
 * whose measured cosine is under the response's floor. Without a floor or a cosine, nothing is.
 */
export function belowFloor(hit: Hit, recall: Recall): boolean {
  if (recall.nothingRelevant) return true;
  return recall.relevanceFloor !== null && hit.similarity !== undefined
    ? hit.similarity < recall.relevanceFloor
    : false;
}

/** How much of a hit's text shows before "Show all". */
export const HIT_PREVIEW_CHARS = 280;
