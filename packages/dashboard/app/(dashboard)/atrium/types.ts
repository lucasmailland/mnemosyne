/**
 * What Home reads from the dashboard API, validated at the edge like the other rooms: a value
 * of the wrong shape is dropped (an event, a pair, a day of the series) or, for the stats
 * themselves, the whole payload is refused. Only the fields Home draws are kept; admin-only
 * ones are absent for members.
 */
export interface AdminStats {
  facts: { live: number; closed: number };
  relations: { conflicts: number | null };
  embeddings?: { indexed: number; pending: number };
  snapshot?: { at: string | null };
  recall: {
    latencyP50Ms7d: number | null;
    latencyP95Ms7d: number | null;
    /** Admin only. Values are null unless the report is measured (enough data, read ran). */
    precisionAtK?: Array<{ k: number; precision: number | null; sampleSize: number }>;
  };
  /** Admin only: the context economy of the last 7 days (APP-015). Null fields: not measured. */
  context?: ContextEconomy;
  /** 14 UTC days, oldest first, zero-filled. */
  writesPerDay14d?: Array<{ day: string; count: number }>;
}

export interface ContextEconomy {
  recalls7d: number | null;
  servedCharsAvg7d: number | null;
  servedCharsP95_7d: number | null;
  liveFacts: number | null;
  liveFactChars: number | null;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  factId?: string;
  decisionId?: string;
  actor?: string;
  summary?: string;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  nextCursor: string | null;
}

export interface ConflictFact {
  id: string;
  statement: string;
  validFrom: string;
}

export interface ConflictPair {
  relationId: string;
  confidence: number | null;
  factA: ConflictFact;
  factB: ConflictFact;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const date = (v: unknown): v is string => str(v) && !Number.isNaN(new Date(v).getTime());
const opt = (v: unknown) => (str(v) ? v : undefined);
const orNull = (v: unknown) => (num(v) ? v : null);
const share = (v: unknown) => (num(v) && v >= 0 && v <= 1 ? v : null);

/** null when the payload is not workspace stats (Home then says the stats could not load). */
export function parseStats(v: unknown): AdminStats | null {
  if (!rec(v) || !rec(v.facts) || !num(v.facts.live) || !num(v.facts.closed)) return null;
  const recall = rec(v.recall) ? v.recall : {};
  const e = v.embeddings;
  const s = v.snapshot;
  const c = v.context;
  // A report that could not run, or ran on too little data, has no figure to show.
  const measured = recall.precisionUnavailable !== true && recall.precisionInsufficientData !== true;
  const precisionAtK = Array.isArray(recall.precisionAtK)
    ? recall.precisionAtK
        .filter((p): p is Rec => rec(p) && num(p.k) && num(p.sampleSize))
        .map((p) => ({
          k: p.k as number,
          precision: measured ? share(p.precision) : null,
          sampleSize: p.sampleSize as number,
        }))
    : undefined;
  return {
    facts: { live: v.facts.live, closed: v.facts.closed },
    relations: { conflicts: rec(v.relations) ? orNull(v.relations.conflicts) : null },
    ...(rec(e) && num(e.indexed) && num(e.pending)
      ? { embeddings: { indexed: e.indexed, pending: e.pending } }
      : {}),
    ...(rec(s) ? { snapshot: { at: date(s.at) ? s.at : null } } : {}),
    recall: {
      latencyP50Ms7d: orNull(recall.latencyP50Ms7d),
      latencyP95Ms7d: orNull(recall.latencyP95Ms7d),
      ...(precisionAtK ? { precisionAtK } : {}),
    },
    ...(rec(c)
      ? {
          context: {
            recalls7d: orNull(c.recalls7d),
            servedCharsAvg7d: orNull(c.servedCharsAvg7d),
            servedCharsP95_7d: orNull(c.servedCharsP95_7d),
            liveFacts: orNull(c.liveFacts),
            liveFactChars: orNull(c.liveFactChars),
          },
        }
      : {}),
    ...(Array.isArray(v.writesPerDay14d)
      ? {
          writesPerDay14d: v.writesPerDay14d.filter(
            (d): d is { day: string; count: number } => rec(d) && str(d.day) && num(d.count)
          ),
        }
      : {}),
  };
}

/** Events with an id, a kind and a readable date; null when the payload is not a timeline. */
export function parseTimeline(v: unknown): TimelineResponse | null {
  if (!rec(v) || !Array.isArray(v.events)) return null;
  const events: TimelineEvent[] = [];
  for (const e of v.events) {
    if (!rec(e) || !str(e.id) || !str(e.kind) || !date(e.at)) continue;
    events.push({
      id: e.id,
      at: e.at,
      kind: e.kind,
      factId: opt(e.factId),
      decisionId: opt(e.decisionId),
      actor: opt(e.actor),
      summary: opt(e.summary),
    });
  }
  return { events, nextCursor: str(v.nextCursor) ? v.nextCursor : null };
}

function parseFact(v: unknown): ConflictFact | null {
  return rec(v) && str(v.id) && str(v.statement) && date(v.validFrom)
    ? { id: v.id, statement: v.statement, validFrom: v.validFrom }
    : null;
}

/** GET /conflicts' `total` (every pair the caller can see); null when absent. */
export function parseConflictTotal(v: unknown): number | null {
  return rec(v) ? orNull(v.total) : null;
}

/** Pairs whose two facts can be drawn; null when the payload is not a conflicts list. */
export function parseConflicts(v: unknown): ConflictPair[] | null {
  if (!rec(v) || !Array.isArray(v.pairs)) return null;
  const pairs: ConflictPair[] = [];
  for (const p of v.pairs) {
    if (!rec(p) || !str(p.relationId)) continue;
    const factA = parseFact(p.factA);
    const factB = parseFact(p.factB);
    if (factA && factB)
      pairs.push({ relationId: p.relationId, confidence: orNull(p.confidence), factA, factB });
  }
  return pairs;
}

export interface RecallWindow {
  queries: number;
  zeroHitShare: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** GET /recall/metrics: per UTC day, oldest first, ending today, and the window's totals. */
export interface RecallMetrics {
  days: Array<RecallWindow & { day: string }>;
  totals: RecallWindow;
}

function parseWindow(v: unknown): RecallWindow | null {
  return rec(v) && num(v.queries)
    ? {
        queries: v.queries,
        zeroHitShare: share(v.zeroHitShare),
        p50Ms: orNull(v.p50Ms),
        p95Ms: orNull(v.p95Ms),
      }
    : null;
}

/** null when the payload is not recall metrics (an older server answers 404). */
export function parseRecallMetrics(v: unknown): RecallMetrics | null {
  if (!rec(v) || !Array.isArray(v.days)) return null;
  const totals = parseWindow(v.totals);
  if (!totals) return null;
  const days: RecallMetrics["days"] = [];
  for (const d of v.days) {
    const w = parseWindow(d);
    if (!w || !rec(d) || !str(d.day)) return null;
    days.push({ day: d.day, ...w });
  }
  return { days, totals };
}

/** GET /facts/stats: live facts under the caller's ceiling. */
export interface FactStats {
  live: number;
  pinned: number;
  neverRecalled: number;
  byKind: Array<{ kind: string; count: number }>;
}

export function parseFactStats(v: unknown): FactStats | null {
  if (!rec(v) || !num(v.live) || !num(v.pinned) || !num(v.neverRecalled)) return null;
  const byKind = Array.isArray(v.byKind)
    ? v.byKind.filter(
        (k): k is { kind: string; count: number } => rec(k) && str(k.kind) && num(k.count)
      )
    : [];
  return { live: v.live, pinned: v.pinned, neverRecalled: v.neverRecalled, byKind };
}

/**
 * Facts whose last change was a recall's bump (APP-052): a recall sets `last_recalled_at` and,
 * through the row trigger, `updated_at` in the same statement, so the two instants are equal.
 * From GET /facts sorted by updated_at; an id maps to that instant.
 */
export function recallBumps(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!rec(v) || !Array.isArray(v.items)) return out;
  for (const f of v.items) {
    if (!rec(f) || !str(f.id) || !date(f.updatedAt) || !date(f.lastRecalledAt)) continue;
    const at = new Date(f.updatedAt).getTime();
    if (at === new Date(f.lastRecalledAt).getTime()) out.set(f.id, at);
  }
  return out;
}

/** An "updated" event that is only a recall's bump becomes "recalled"; the rest stand. */
export function relabelRecalls(events: TimelineEvent[], bumps: Map<string, number>): TimelineEvent[] {
  return events.map((e) =>
    e.kind === "updated" && e.factId && bumps.get(e.factId) === new Date(e.at).getTime()
      ? { ...e, kind: "recalled" }
      : e
  );
}
