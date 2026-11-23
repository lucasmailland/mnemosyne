import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type FactPageFilter,
  type MnemoDecision,
  type MnemoFact,
  type Sensitivity,
  type StorageAdapter,
  isoDateTimeInput,
} from "@mnemo-ai/types";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { resolveCeiling } from "../rbac.js";
import { BadRequestError, ServiceUnavailableError } from "../errors.js";

/**
 * GET /timeline?since=ISO_TIMESTAMP&limit=N
 *
 * Returns the workspace's recent fact-lifecycle events (created, pinned,
 * unpinned, closed). Useful for incremental sync clients and the Studio
 * inspector.
 *
 * flatten-legacy-dual-core (this PR, task 6.6): fully ported off the legacy
 * core client's `timeline()` method (`factory.ts:810-854`) — the last
 * remaining route on `legacy-core-usage.test.ts`'s allowlist.
 * `deriveTimelineEvents()` below reproduces the SAME two-stream merge
 * `complete-mcp-tools`'s B3 fix introduced, but sources BOTH streams from
 * `deps.storage` instead of one from the legacy core client:
 *   - `queryFactsPage({status:'all', sortBy:'updated_at', order:'desc',
 *     updatedSince})` reproduces legacy `timeline()`'s `updated_at`/`pinned`/
 *     `valid_to`/`status` → kind derivation rule EXACTLY (factory.ts:837-842):
 *     `status === 'forgotten' || validTo !== null ? 'closed' : pinned ?
 *     'pinned' : 'updated'`. `status: 'all'` is required — legacy's raw SQL
 *     had no status predicate, so closed/forgotten facts must stay visible.
 *   - `queryFacts({createdSince})` (complete-mcp-tools B3, unchanged) still
 *     supplies the real `"created"` event legacy could never produce.
 * Same B3 dedup rule: a fact whose derived `"updated"/"pinned"/"closed"`
 * event `at` equals its own `createdAt` is the phantom (never modified since
 * creation) and is dropped in favor of the real `"created"` event.
 *
 * Disclosed, narrow behavior difference from legacy `timeline()`: legacy's
 * raw SQL used `updated_at >= since` (inclusive). `queryFactsPage.updatedSince`
 * is a pre-existing, additive `StorageAdapter` filter (PR9b, D6.3) shared by
 * `GET /facts` and `federation.ts`, modeled 1:1 on legacy `listFacts`'s own
 * `updated_at > since` (EXCLUSIVE) — a different legacy method with a
 * different boundary convention than `timeline()`. Reusing the shared filter
 * (rather than forking a one-off exclusive/inclusive variant) means a fact
 * updated at the EXACT `since` instant is included by legacy `timeline()`
 * but excluded here — a millisecond-boundary edge case, same class of
 * disclosed difference PR15 already accepted for `federation.ts`.
 *
 * `deps.storage` is required (not optional) now that this route no longer
 * has a legacy fallback — converges to 503 `ServiceUnavailableError` when
 * absent, matching every other fully-ported route in this codebase
 * (`session.ts`, `admin.ts`, `keys.ts`, `capture.ts`).
 */

const TimelineEventSchema = z
  .object({
    id: z.string(),
    at: z.iso.datetime(),
    kind: z.enum([
      "created",
      "pinned",
      "unpinned",
      "closed",
      "updated",
      "decision_created",
      "decision_superseded",
      "decision_withdrawn",
    ]),
    /** Present on every fact event; absent on decision events. */
    factId: z.string().optional(),
    /** Present on decision events only. */
    decisionId: z.string().optional(),
    actor: z.string().optional(),
    actorId: z.string().nullable().optional(),
    summary: z.string().optional(),
  })
  .openapi("TimelineEvent");

const TimelineQuerySchema = z.object({
  since: isoDateTimeInput()
    .optional()
    .openapi({
      param: { name: "since", in: "query" },
      description: "ISO timestamp. Returns events strictly after this time. Defaults to 24h ago.",
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .openapi({ param: { name: "limit", in: "query" } }),
  cursor: z
    .string()
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description:
        "Opaque cursor from a prior page's `nextCursor`. It carries the window start, so `since` is only read on the first page. Omit for the newest events.",
    }),
});

const TimelineResponseSchema = z
  .object({
    events: z.array(TimelineEventSchema),
    /** Opaque cursor for the next (older) page; null on the last page. Pass it back as `cursor`. */
    nextCursor: z.string().nullable(),
  })
  .openapi("TimelineResponse");

const TimelineCountsQuerySchema = z.object({
  since: isoDateTimeInput()
    .optional()
    .openapi({
      param: { name: "since", in: "query" },
      description: "ISO timestamp, as GET /timeline's `since`. Defaults to 24h ago.",
    }),
});

const TimelineCountsResponseSchema = z
  .object({
    since: z.iso.datetime(),
    counts: z.object({
      decision_created: z.number().int().nonnegative(),
      decision_superseded: z.number().int().nonnegative(),
      decision_withdrawn: z.number().int().nonnegative(),
    }),
  })
  .openapi("TimelineCounts");

export interface TimelineEvent {
  id: string;
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
  /** Present on every fact event, absent on decision events. */
  factId?: string;
  /** Present on decision events only. */
  decisionId?: string;
  actorId: string | null;
  summary: string;
}

export interface TimelineDeriveResult {
  events: TimelineEvent[];
  nextCursor: string | null;
}

/**
 * Pure v3 derivation of `GET /timeline`'s event stream — see the file
 * header for the full design rationale. Exported so the Tier B differential
 * integration test (design.md D3, tasks.md 6.2) can call it directly
 * against a real `StorageAdapter`, alongside the untouched legacy
 * `core.timeline()`, before `CoreLike` is deleted in Phase 7.
 */
export async function deriveTimelineEvents(
  storage: StorageAdapter,
  args: {
    workspaceId: string;
    since?: Date;
    limit: number;
    cursor?: string;
    /** Read ceiling: facts above it are left out of the stream (and so of every page). */
    maxSensitivity?: Sensitivity;
  }
): Promise<TimelineDeriveResult> {
  // PRIM-19 — the cursor carries the window start, so a default window
  // ("24h ago") does not slide between pages and drop the oldest events.
  const resume = args.cursor ? decodeCursor(args.cursor) : null;
  const resolvedSince = resume?.since ?? args.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = args.limit;

  const updated = new FactStream(
    storage,
    {
      workspaceId: args.workspaceId,
      status: "all",
      ...(args.maxSensitivity ? { maxSensitivity: args.maxSensitivity } : {}),
      sortBy: "updated_at",
      order: "desc",
      updatedSince: resolvedSince,
    },
    resume?.u ?? undefined,
    limit
  );
  const created = new FactStream(
    storage,
    {
      workspaceId: args.workspaceId,
      status: "all",
      ...(args.maxSensitivity ? { maxSensitivity: args.maxSensitivity } : {}),
      sortBy: "created_at",
      order: "desc",
      createdSince: resolvedSince,
    },
    resume?.c ?? undefined,
    limit
  );

  const decisionBase = {
    workspaceId: args.workspaceId,
    since: resolvedSince,
    ceiling: args.maxSensitivity,
    pageSize: limit,
  };
  const decCreated = new DecisionStream(storage, {
    ...decisionBase,
    by: "created",
    start: resume?.d.c ?? null,
  });
  const decClosed = new DecisionStream(storage, {
    ...decisionBase,
    by: "closed",
    start: resume?.d.u ?? null,
  });

  // N-way merge of streams that are each already newest-first. Only the heads
  // are compared, so an item is never taken ahead of one that precedes it in
  // its own stream, which is what makes "the cursor of the last item taken
  // from each stream" a safe place to resume from. Equal instants take the
  // streams in the order listed (updates first). `build` returns null for a
  // head that is consumed but yields no event (the phantom below).
  type Head = { t: number; take: () => void; build: () => TimelineEvent | null };
  const nextEvent = async (): Promise<TimelineEvent | null> => {
    for (;;) {
      const u = await updated.peek();
      const c = await created.peek();
      const du = await decClosed.peek();
      const dc = await decCreated.peek();
      const heads: Array<Head | null> = [
        u && {
          t: u.updatedAt.getTime(),
          take: () => updated.take(),
          // Dedupe: an "updated"/"pinned"/"closed" event whose instant is the
          // fact's own creation means the fact was never modified since it was
          // created. That is the phantom B3 retired; the real "created" event
          // stands in for it.
          build: () => {
            if (u.updatedAt.getTime() === u.createdAt.getTime()) return null;
            const kind: TimelineEvent["kind"] =
              u.status === "forgotten" || (u.validTo ?? null) !== null
                ? "closed"
                : u.pinned
                  ? "pinned"
                  : "updated";
            // APP-052: a recall bumps hit_count/last_recalled_at and the row's
            // trigger stamps updated_at at that same instant; that is the
            // recall, not an edit. Only a plain "updated" is dropped: a pinned
            // or closed row still surfaces its state. Known limit: the trigger
            // overwrote the instant of that pin/close, so the event carries the
            // recall's time, and an edit made before a later recall is lost (one
            // updated_at holds only the latest stamp).
            if (
              kind === "updated" &&
              u.lastRecalledAt &&
              u.updatedAt.getTime() === u.lastRecalledAt.getTime()
            ) {
              return null;
            }
            return {
              id: u.id,
              at: u.updatedAt.toISOString(),
              kind,
              factId: u.id,
              actorId: u.actorId ?? null,
              summary: u.statement.slice(0, 200),
            };
          },
        },
        c && {
          t: c.createdAt.getTime(),
          take: () => created.take(),
          build: () => ({
            id: `${c.id}:created`,
            at: c.createdAt.toISOString(),
            kind: "created",
            factId: c.id,
            actorId: c.actorId ?? null,
            summary: c.statement.slice(0, 200),
          }),
        },
        du && {
          t: decisionClosedAt(du).getTime(),
          take: () => decClosed.take(),
          build: () => {
            const kind = du.status === "superseded" ? "decision_superseded" : "decision_withdrawn";
            return decisionEvent(du, kind, decisionClosedAt(du));
          },
        },
        dc && {
          t: dc.createdAt.getTime(),
          take: () => decCreated.take(),
          build: () => decisionEvent(dc, "decision_created", dc.createdAt),
        },
      ];
      let best: Head | null = null;
      for (const h of heads) if (h && (!best || h.t > best.t)) best = h;
      if (!best) return null;
      best.take();
      const event = best.build();
      if (event) return event;
    }
  };

  const events: TimelineEvent[] = [];
  const snapshot = () => ({
    u: updated.position(),
    c: created.position(),
    d: { c: decCreated.position(), u: decClosed.position() },
  });
  let position = snapshot();
  while (events.length < limit) {
    const e = await nextEvent();
    if (!e) return { events, nextCursor: null };
    events.push(e);
    position = snapshot();
  }
  // Full page: is there anything after it? Looking ahead keeps a page that
  // ends exactly on the last event from advertising an empty next page. The
  // cursor stays on the last event returned, so the look-ahead is not consumed.
  const more = await nextEvent();
  return {
    events,
    nextCursor: more ? encodeCursor({ since: resolvedSince, ...position }) : null,
  };
}

interface TimelineCursor {
  since: Date;
  /** Resume point of the update stream; null = from its start. */
  u: string | null;
  /** Resume point of the creation stream; null = from its start. */
  c: string | null;
  /** Resume points of the two decision streams ("<iso>|<id>"); null = from their start. */
  d: { c: string | null; u: string | null };
}

function encodeCursor(c: TimelineCursor): string {
  return Buffer.from(
    JSON.stringify({ s: c.since.toISOString(), u: c.u, c: c.c, d: c.d }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(raw: string): TimelineCursor {
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      s?: unknown;
      u?: unknown;
      c?: unknown;
      d?: unknown;
    };
    const since = typeof obj.s === "string" ? new Date(obj.s) : null;
    const okStream = (v: unknown): v is string | null => v === null || typeof v === "string";
    // `d` is absent on cursors minted before decision events existed: those
    // start the decision streams from the top.
    const d = (obj.d ?? { c: null, u: null }) as { c?: unknown; u?: unknown };
    if (
      since &&
      !Number.isNaN(since.getTime()) &&
      okStream(obj.u) &&
      okStream(obj.c) &&
      typeof d === "object" &&
      d !== null &&
      (d.c == null || decisionKeyset(d.c)) &&
      (d.u == null || decisionKeyset(d.u))
    ) {
      return {
        since,
        u: obj.u,
        c: obj.c,
        d: { c: (d.c ?? null) as string | null, u: (d.u ?? null) as string | null },
      };
    }
  } catch {
    // fall through
  }
  throw new BadRequestError("cursor is not a valid timeline cursor", undefined, "cursor");
}

/**
 * One newest-first stream of facts read through `queryFactsPage`, buffered a
 * page at a time. `position()` is the keyset cursor that resumes right after
 * the last fact taken, null while nothing was taken.
 */
class FactStream {
  private buffer: MnemoFact[] = [];
  private cursors: string[] = [];
  private index = 0;
  private next: string | null;
  private started = false;
  private taken: string | null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly filter: Omit<FactPageFilter, "limit" | "cursor">,
    start: string | undefined,
    private readonly pageSize: number
  ) {
    this.next = start ?? null;
    this.taken = start ?? null;
  }

  private async fill(): Promise<void> {
    if (this.index < this.buffer.length) return;
    if (this.started && this.next === null) return;
    this.started = true;
    const page = await this.storage.queryFactsPage({
      ...this.filter,
      limit: this.pageSize,
      ...(this.next ? { cursor: this.next } : {}),
    });
    this.buffer = page.items;
    this.cursors = page.itemCursors ?? [];
    this.index = 0;
    this.next = page.nextCursor;
  }

  async peek(): Promise<MnemoFact | null> {
    await this.fill();
    return this.buffer[this.index] ?? null;
  }

  take(): void {
    this.taken = this.cursors[this.index] ?? this.taken;
    this.index++;
  }

  position(): string | null {
    return this.taken;
  }
}

/** A decision position "<iso>|<id>" as a keyset, or null when it is not one. */
function decisionKeyset(v: unknown): { at: Date; id: string } | null {
  if (typeof v !== "string") return null;
  const bar = v.indexOf("|");
  if (bar < 1) return null;
  const at = new Date(v.slice(0, bar));
  const id = v.slice(bar + 1);
  return Number.isNaN(at.getTime()) || id === "" ? null : { at, id };
}

function decisionClosedAt(d: MnemoDecision): Date {
  return d.validTo ?? d.updatedAt;
}

function decisionEvent(
  d: MnemoDecision,
  kind: "decision_created" | "decision_superseded" | "decision_withdrawn",
  at: Date
): TimelineEvent {
  return {
    id: `${d.id}:${kind}`,
    at: at.toISOString(),
    kind,
    decisionId: d.id,
    actorId: d.actorId ?? null,
    summary: d.title.slice(0, 200),
  };
}

/**
 * One newest-first stream of decisions, read by keyset `(instant, id)` one
 * page of `pageSize + 1` at a time (a timeline page takes at most that many:
 * its events plus the look-ahead), resuming from the position
 * `"<iso>|<id>"`. Window, status, ceiling and position all filter in the
 * query. "created" yields every decision by `createdAt`; "closed" yields
 * superseded and withdrawn ones by `validTo ?? updatedAt`, the instant their
 * event carries.
 */
class DecisionStream {
  private buffer: MnemoDecision[] = [];
  private index = 0;
  private exhausted = false;
  private taken: string | null;
  private before: { at: Date; id: string } | null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly o: {
      workspaceId: string;
      since: Date;
      by: "created" | "closed";
      ceiling: Sensitivity | undefined;
      pageSize: number;
      start: string | null;
    }
  ) {
    this.taken = o.start;
    this.before = decisionKeyset(o.start);
  }

  private at(d: MnemoDecision): Date {
    return this.o.by === "created" ? d.createdAt : decisionClosedAt(d);
  }

  private async fill(): Promise<void> {
    if (this.index < this.buffer.length || this.exhausted) return;
    const limit = this.o.pageSize + 1;
    const { items } = await this.storage.queryDecisions({
      workspaceId: this.o.workspaceId,
      ...(this.o.by === "created"
        ? { orderBy: "createdAt", createdSince: this.o.since }
        : {
            orderBy: "closedAt",
            closedSince: this.o.since,
            statuses: ["superseded", "withdrawn"],
          }),
      ...(this.o.ceiling ? { maxSensitivity: this.o.ceiling } : {}),
      ...(this.before ? { before: this.before } : {}),
      limit,
      skipTotal: true,
    });
    this.buffer = items;
    this.index = 0;
    this.exhausted = items.length < limit;
    const last = items.at(-1);
    if (last) this.before = { at: this.at(last), id: last.id };
  }

  async peek(): Promise<MnemoDecision | null> {
    await this.fill();
    return this.buffer[this.index] ?? null;
  }

  take(): void {
    const d = this.buffer[this.index]!;
    this.taken = `${this.at(d).toISOString()}|${d.id}`;
    this.index++;
  }

  position(): string | null {
    return this.taken;
  }
}

export function mountTimeline(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/timeline",
      tags: ["timeline"],
      summary: "Recent fact-lifecycle events.",
      request: { query: TimelineQuerySchema },
      responses: {
        200: {
          description: "Events newest-first.",
          content: { "application/json": { schema: TimelineResponseSchema } },
        },
        400: { description: "Invalid query (e.g. a malformed cursor)." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { since, limit, cursor } = c.req.valid("query");
      const workspaceId = c.get("workspaceId");
      const sinceDate = since ? new Date(since) : undefined;

      if (!deps.storage) {
        throw new ServiceUnavailableError("Storage adapter not available");
      }

      const result = await deriveTimelineEvents(deps.storage, {
        workspaceId,
        since: sinceDate,
        limit,
        maxSensitivity: resolveCeiling(c),
        ...(cursor ? { cursor } : {}),
      });

      return c.json(result, 200);
    }
  );

  // GET /timeline/counts — how many decision events GET /timeline would list
  // since an instant, without paging through them (the dashboard's Home used
  // to read up to 500 events to count the superseded ones). Decision kinds
  // only: each is one COUNT. A fact event's kind is derived per row (and
  // de-duplicated against its creation), so those are not counted here.
  app.openapi(
    createRoute({
      method: "get",
      path: "/timeline/counts",
      tags: ["timeline"],
      summary: "Count the decision events since an instant.",
      request: { query: TimelineCountsQuerySchema },
      responses: {
        200: {
          description: "Decision event counts, within the caller's read ceiling.",
          content: { "application/json": { schema: TimelineCountsResponseSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const { since } = c.req.valid("query");
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      const storage = deps.storage;
      const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const base = {
        workspaceId: c.get("workspaceId"),
        maxSensitivity: resolveCeiling(c),
        limit: 1,
      };
      // The same filters the decision streams of GET /timeline use.
      const [created, superseded, withdrawn] = await Promise.all([
        storage.queryDecisions({ ...base, createdSince: sinceDate }),
        storage.queryDecisions({ ...base, closedSince: sinceDate, statuses: ["superseded"] }),
        storage.queryDecisions({ ...base, closedSince: sinceDate, statuses: ["withdrawn"] }),
      ]);
      return c.json(
        {
          since: sinceDate.toISOString(),
          counts: {
            decision_created: created.total,
            decision_superseded: superseded.total,
            decision_withdrawn: withdrawn.total,
          },
        },
        200
      );
    }
  );
}
