/**
 * Filters of both audits: the installation security audit (GET /instance/audit,
 * `auditApiQuery`) and the workspace audit feed (GET /audit, whose page builds its own
 * query with `auditPageQuery`, `dayStart` and `dayEnd`). The server reads a date-time without an offset as ITS
 * local time and a bare `to` date as the start of that day, so the pages send UTC
 * instants: `from` is the start of the picked day and `to` the last millisecond of it
 * (the end day is inclusive, so `from=X&to=X` is that whole day). A day that is
 * malformed or does not exist (02-31) is dropped, never sent or thrown on.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditFilters {
  action?: string | undefined;
  actor?: string | undefined;
  /** A day, YYYY-MM-DD (UTC). */
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  /** The audit page's own filters (actor kind, free text) and page size. */
  actorKind?: string | undefined;
  q?: string | undefined;
  limit?: string | undefined;
}

export const validDay = (value: string | undefined): value is string => {
  if (!value || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  // Round trip: a day that does not exist (02-31) would roll over silently.
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
};

/** The UTC instant a picked `from` day starts at, or undefined for a day that is not real. */
export const dayStart = (day: string | undefined): string | undefined =>
  validDay(day) ? `${day}T00:00:00.000Z` : undefined;

/** The last UTC millisecond of a picked `to` day (the end day is inclusive), or undefined. */
export const dayEnd = (day: string | undefined): string | undefined =>
  validDay(day) ? `${day}T23:59:59.999Z` : undefined;

/** The query string for GET /instance/audit (with the leading "?", or ""). */
export function auditApiQuery(filters: AuditFilters): string {
  const query = new URLSearchParams();
  if (filters.action) query.set("action", filters.action);
  if (filters.actor?.trim()) query.set("actor", filters.actor.trim());
  const from = dayStart(filters.from);
  const to = dayEnd(filters.to);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** The page's own query string (days stay days), for links between pages. */
export function auditPageQuery(filters: AuditFilters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `?${text}` : "";
}
