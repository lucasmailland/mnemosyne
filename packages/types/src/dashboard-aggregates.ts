import type {
  AuditActivity,
  AuditFeedStats,
  HealthSnapshot,
  HealthSnapshotDay,
  SessionStats,
} from "./ports.js";

/** `days` UTC day keys (`YYYY-MM-DD`) ending today, oldest first. */
export function utcDayKeys(days: number, now = Date.now()): string[] {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)
  );
}

/**
 * Shared by the Postgres repository and the in-memory twin, so the two never drift:
 * session rows grouped by (start day, status), and the window's episodes with their
 * readable linked-fact count, become {@link SessionStats}.
 */
export function tallySessionStats(
  days: number,
  sessions: Array<{ day: string; status: string; n: number; collapsed: number; turns: number }>,
  episodes: Array<{ topics: string[]; facts: number }>
): SessionStats {
  const byDay = new Map(
    utcDayKeys(days).map((day) => [day, { day, active: 0, collapsed: 0, archived: 0 }])
  );
  let n = 0;
  let collapsed = 0;
  let turns = 0;
  for (const r of sessions) {
    n += r.n;
    collapsed += r.collapsed;
    turns += r.turns;
    const d = byDay.get(r.day);
    if (d && (r.status === "active" || r.status === "collapsed" || r.status === "archived"))
      d[r.status] += r.n;
  }
  const topics = new Map<string, number>();
  for (const e of episodes)
    for (const t of new Set(e.topics)) topics.set(t, (topics.get(t) ?? 0) + 1);
  const facts = episodes.reduce((sum, e) => sum + e.facts, 0);
  return {
    days: [...byDay.values()],
    totals: {
      sessions: n,
      collapsed,
      avgTurns: n > 0 ? turns / n : null,
      episodes: episodes.length,
      factsPerEpisode: episodes.length > 0 ? facts / episodes.length : null,
    },
    topics: [...topics]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count })),
  };
}

/** Shared by the Postgres repository and the twin: (day, action) groups → {@link AuditActivity}. */
export function tallyAuditActivity(
  days: number,
  groups: Array<{ day: string; action: string; n: number }>,
  lastAt: Record<string, string>
): AuditActivity {
  const perDay = new Map(utcDayKeys(days).map((day) => [day, 0]));
  const byAction = new Map<string, number>();
  for (const g of groups) {
    if (perDay.has(g.day)) perDay.set(g.day, perDay.get(g.day)! + g.n);
    byAction.set(g.action, (byAction.get(g.action) ?? 0) + g.n);
  }
  return {
    days: [...perDay].map(([day, count]) => ({ day, count })),
    byAction: [...byAction]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([action, count]) => ({ action, count })),
    lastAt,
  };
}

/** Shared by the repository and the twin: each day's latest snapshot → {@link HealthSnapshotDay}. */
export function tallyHealthSnapshots(
  days: number,
  latestByDay: Map<
    string,
    Pick<
      HealthSnapshot,
      | "factCountActive"
      | "factCountEmbedded"
      | "factCountUnembedded"
      | "factsWithZeroHits"
      | "recallHitRate30d"
      | "extractionJobsFailed7d"
    >
  >
): HealthSnapshotDay[] {
  return utcDayKeys(days).map((day) => {
    const s = latestByDay.get(day);
    if (!s)
      return {
        day,
        recallHitRate30d: null,
        zeroHitShare: null,
        embeddedShare: null,
        failedJobs7d: null,
      };
    const indexable = s.factCountEmbedded + s.factCountUnembedded;
    return {
      day,
      recallHitRate30d: s.recallHitRate30d,
      zeroHitShare: s.factCountActive > 0 ? s.factsWithZeroHits / s.factCountActive : null,
      embeddedShare: indexable > 0 ? s.factCountEmbedded / indexable : null,
      failedJobs7d: s.extractionJobsFailed7d,
    };
  });
}

/** Shared by the repository and the twin: (day, actor kind) groups → {@link AuditFeedStats}. */
export function tallyAuditFeedStats(
  days: number,
  groups: Array<{ day: string; actorKind: "user" | "system"; n: number }>
): AuditFeedStats {
  const byDay = new Map(utcDayKeys(days).map((day) => [day, { day, user: 0, system: 0 }]));
  const totals = { user: 0, system: 0 };
  for (const g of groups) {
    const d = byDay.get(g.day);
    if (!d) continue;
    d[g.actorKind] += g.n;
    totals[g.actorKind] += g.n;
  }
  return { days: [...byDay.values()], totals };
}
