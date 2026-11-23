/**
 * The rooms' server aggregates, validated at the edge: a payload of the wrong shape is null, so
 * the room says the figure could not load instead of drawing a made-up zero.
 */
type Rec = Record<string, unknown>;
export const rec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export interface Group {
  name: string;
  count: number;
}

/** `[{ <key>: string, count: number }]` → groups; rows of another shape are dropped. */
export function groups(v: unknown, key: string): Group[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((g) =>
    rec(g) && str(g[key]) && num(g.count) ? [{ name: g[key], count: g.count }] : []
  );
}

/** Every listed field is a finite number, or the whole payload is refused. */
function counts<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!rec(v)) return null;
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const n = v[k];
    if (!num(n)) return null;
    out[k] = n;
  }
  return out;
}

/** GET /facts/stats: live facts under the caller's ceiling. */
export interface FactStatsFull {
  live: number;
  pinned: number;
  neverRecalled: number;
  byKind: Group[];
  bySensitivity: Group[];
}

export function parseFactStatsFull(v: unknown): FactStatsFull | null {
  const c = counts(v, ["live", "pinned", "neverRecalled"] as const);
  if (!c || !rec(v)) return null;
  return {
    ...c,
    byKind: groups(v.byKind, "kind"),
    bySensitivity: groups(v.bySensitivity, "sensitivity"),
  };
}

/** GET /graph/stats: the graph the caller can read. */
export interface GraphStats {
  entities: number;
  decisions: number;
  episodes: number;
  relations: number;
  conflicts: number;
  isolated: number;
  entitiesByKind: Group[];
  relationsByType: Group[];
  hubs: Array<{ id: string; label: string; degree: number }>;
}

export function parseGraphStats(v: unknown): GraphStats | null {
  const c = counts(v, [
    "entities",
    "decisions",
    "episodes",
    "relations",
    "conflicts",
    "isolated",
  ] as const);
  if (!c || !rec(v)) return null;
  return {
    ...c,
    entitiesByKind: groups(v.entitiesByKind, "kind"),
    relationsByType: groups(v.relationsByType, "relation"),
    hubs: Array.isArray(v.hubs)
      ? v.hubs.flatMap((h) =>
          rec(h) && str(h.id) && str(h.label) && num(h.degree)
            ? [{ id: h.id, label: h.label, degree: h.degree }]
            : []
        )
      : [],
  };
}

/** GET /session/stats: sessions per day and the window's episodes. */
export interface SessionStats {
  days: Array<{ day: string; active: number; collapsed: number; archived: number }>;
  totals: {
    sessions: number;
    collapsed: number;
    avgTurns: number | null;
    episodes: number;
    factsPerEpisode: number | null;
  };
  topics: Group[];
}

const orNull = (v: unknown) => (num(v) ? v : null);

export function parseSessionStats(v: unknown): SessionStats | null {
  if (!rec(v) || !Array.isArray(v.days)) return null;
  const c = counts(v.totals, ["sessions", "collapsed", "episodes"] as const);
  if (!c || !rec(v.totals)) return null;
  const days: SessionStats["days"] = [];
  for (const d of v.days) {
    const n = counts(d, ["active", "collapsed", "archived"] as const);
    if (!n || !rec(d) || !str(d.day)) return null;
    days.push({ day: d.day, ...n });
  }
  return {
    days,
    totals: {
      ...c,
      avgTurns: orNull(v.totals.avgTurns),
      factsPerEpisode: orNull(v.totals.factsPerEpisode),
    },
    topics: groups(v.topics, "topic"),
  };
}
