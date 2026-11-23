/**
 * Decision events on GET /timeline: decision_created / decision_superseded /
 * decision_withdrawn merged with the two fact streams, paged by one cursor.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import { BadRequestError } from "../errors.js";
import { deriveTimelineEvents, type TimelineEvent } from "../routes/timeline.js";

const WS = "00000000-0000-0000-0000-0000000000d4";
const T0 = new Date("2026-03-01T10:00:00.000Z");
const SINCE = new Date("2026-03-01T00:00:00.000Z");

afterEach(() => vi.useRealTimers());

const at = (iso: string) => vi.setSystemTime(new Date(iso));

async function decision(storage: InMemoryStorageAdapter, title: string, sensitivity?: string) {
  return storage.createDecision({
    workspaceId: WS,
    kind: "architecture",
    title,
    body: `${title} body`,
    ...(sensitivity ? { sensitivity } : {}),
  } as never);
}

async function fact(storage: InMemoryStorageAdapter, n: number) {
  return storage.createFact({
    workspaceId: WS,
    statement: `fact ${n}`,
    subject: "workspace",
    kind: "other",
    scope: "global",
  } as never);
}

describe("timeline decision events", () => {
  it("emits created, superseded and withdrawn with decisionId and no factId", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T10:00:00.000Z");
    const a = await decision(storage, "a");
    const b = await decision(storage, "b");
    const c = await decision(storage, "c");
    at("2026-03-01T11:00:00.000Z");
    await storage.supersedeDecision({
      id: a.id,
      workspaceId: WS,
      supersededById: b.id,
    } as never);
    at("2026-03-01T12:00:00.000Z");
    await storage.archiveDecision(c.id, WS);

    const { events } = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since: SINCE,
      limit: 50,
    });
    const byKind = (k: string) => events.filter((e) => e.kind === k);
    expect(
      byKind("decision_created")
        .map((e) => e.decisionId)
        .sort()
    ).toEqual([a.id, b.id, c.id].sort());
    expect(byKind("decision_superseded")).toMatchObject([
      { decisionId: a.id, at: "2026-03-01T11:00:00.000Z" },
    ]);
    expect(byKind("decision_withdrawn")).toMatchObject([
      { decisionId: c.id, at: "2026-03-01T12:00:00.000Z" },
    ]);
    for (const e of events.filter((e) => e.kind.startsWith("decision_"))) {
      expect(e.factId).toBeUndefined();
      expect(e.summary).toBeTruthy();
    }
    // newest first overall
    const times = events.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  for (const limit of [1, 2, 3, 7]) {
    it(`limit ${limit}: facts and decisions sharing timestamps page with no gaps or duplicates`, async () => {
      vi.useFakeTimers();
      const storage = new InMemoryStorageAdapter();
      at("2026-03-01T10:00:00.000Z");
      const ds = [];
      for (let i = 0; i < 6; i++) {
        await fact(storage, i);
        ds.push(await decision(storage, `d${i}`));
      }
      at("2026-03-01T10:05:00.000Z");
      await storage.supersedeDecision({
        id: ds[0]!.id,
        workspaceId: WS,
        supersededById: ds[1]!.id,
      } as never);
      await storage.archiveDecision(ds[2]!.id, WS);
      await storage.archiveDecision(ds[3]!.id, WS);

      const whole = await deriveTimelineEvents(storage, {
        workspaceId: WS,
        since: SINCE,
        limit: 500,
      });
      expect(whole.nextCursor).toBeNull();
      expect(whole.events.length).toBeGreaterThanOrEqual(15);

      const walked: TimelineEvent[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 500; guard++) {
        const page = await deriveTimelineEvents(storage, {
          workspaceId: WS,
          since: SINCE,
          limit,
          ...(cursor ? { cursor } : {}),
        });
        walked.push(...page.events);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(walked.map((e) => e.id)).size).toBe(walked.length);
      expect(walked.map((e) => e.id)).toEqual(whole.events.map((e) => e.id));
    });
  }

  it("an old-format cursor without a decision position still decodes", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T10:00:00.000Z");
    await decision(storage, "x");
    const old = Buffer.from(
      JSON.stringify({ s: SINCE.toISOString(), u: null, c: null }),
      "utf8"
    ).toString("base64url");
    const page = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      limit: 10,
      cursor: old,
    });
    expect(page.events.map((e) => e.kind)).toEqual(["decision_created"]);
  });

  it("an unparseable decision position in the cursor is a 400, not a silent restart", async () => {
    const storage = new InMemoryStorageAdapter();
    const bad = Buffer.from(
      JSON.stringify({ s: SINCE.toISOString(), u: null, c: null, d: { c: "garbage|x", u: null } }),
      "utf8"
    ).toString("base64url");
    await expect(
      deriveTimelineEvents(storage, { workspaceId: WS, limit: 5, cursor: bad })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("a decision position without an id part is a 400 too", async () => {
    const storage = new InMemoryStorageAdapter();
    for (const u of ["2026-03-01T10:00:00.000Z|", "2026-03-01T10:00:00.000Z", 42]) {
      const bad = Buffer.from(
        JSON.stringify({ s: SINCE.toISOString(), u: null, c: null, d: { c: null, u } }),
        "utf8"
      ).toString("base64url");
      await expect(
        deriveTimelineEvents(storage, { workspaceId: WS, limit: 5, cursor: bad })
      ).rejects.toBeInstanceOf(BadRequestError);
    }
  });

  it("pages through active and closed decisions by keyset: no gaps, no duplicates, one read per stream per page", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    const ds = [];
    for (let i = 0; i < 12; i++) {
      at(`2026-03-01T10:${String(i).padStart(2, "0")}:00.000Z`);
      ds.push(await decision(storage, `d${i}`));
    }
    // Every decision is touched inside the window; only every third one closes,
    // so the closing stream's window is mostly active decisions it must skip.
    for (let i = 0; i < 12; i++) {
      at(`2026-03-01T11:${String(i).padStart(2, "0")}:00.000Z`);
      if (i % 3 === 0) await storage.archiveDecision(ds[i]!.id, WS);
      else await storage.updateDecision(ds[i]!.id, { workspaceId: WS, title: `d${i}'` } as never);
    }
    const whole = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since: SINCE,
      limit: 500,
    });
    expect(whole.events).toHaveLength(16);

    const reads = vi.spyOn(storage, "queryDecisions");
    const walked: TimelineEvent[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (let guard = 0; guard < 50; guard++) {
      reads.mockClear();
      const page = await deriveTimelineEvents(storage, {
        workspaceId: WS,
        since: SINCE,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      expect(reads.mock.calls.length).toBeLessThanOrEqual(2);
      walked.push(...page.events);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(walked.map((e) => e.id)).toEqual(whole.events.map((e) => e.id));
  });

  it("closing events are ordered by the instant they carry, even after a later edit", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T10:00:00.000Z");
    const x = await decision(storage, "x");
    const y = await decision(storage, "y");
    const z = await decision(storage, "z");
    at("2026-03-01T11:00:00.000Z");
    await storage.supersedeDecision({ id: x.id, workspaceId: WS, supersededById: z.id } as never);
    at("2026-03-01T12:00:00.000Z");
    await storage.archiveDecision(y.id, WS);
    at("2026-03-01T13:00:00.000Z");
    await storage.updateDecision(x.id, { workspaceId: WS, title: "x edited" } as never);

    const { events } = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since: SINCE,
      limit: 50,
    });
    const closing = events.filter((e) => e.kind !== "decision_created");
    expect(closing.map((e) => [e.decisionId, e.at])).toEqual([
      [y.id, "2026-03-01T12:00:00.000Z"],
      [x.id, "2026-03-01T11:00:00.000Z"],
    ]);
    const times = events.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("a decision above the sensitivity ceiling never appears", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T10:00:00.000Z");
    const ok = await decision(storage, "ok", "internal");
    await decision(storage, "secret", "restricted");
    const { events } = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since: SINCE,
      limit: 50,
      maxSensitivity: "internal",
    });
    expect(events.map((e) => e.decisionId)).toEqual([ok.id]);
  });

  it("since filters decisions too", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T08:00:00.000Z");
    await decision(storage, "old");
    at("2026-03-01T10:00:00.000Z");
    const fresh = await decision(storage, "fresh");
    const { events } = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since: new Date("2026-03-01T09:00:00.000Z"),
      limit: 50,
    });
    expect(events.map((e) => e.decisionId)).toEqual([fresh.id]);
    void T0;
  });
});

describe("queryDecisions filter additions (in-memory)", () => {
  it("statuses, maxSensitivity, keyset before, closedAt order and skipTotal", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T08:00:00.000Z");
    const a = await decision(storage, "a");
    const b = await decision(storage, "b", "restricted");
    const c = await decision(storage, "c");
    at("2026-03-01T09:00:00.000Z");
    await storage.archiveDecision(a.id, WS);
    at("2026-03-01T10:00:00.000Z");
    await storage.archiveDecision(b.id, WS);
    at("2026-03-01T11:00:00.000Z");
    await storage.updateDecision(a.id, { workspaceId: WS, title: "a2" } as never);
    const ids = async (f: object) =>
      (await storage.queryDecisions({ workspaceId: WS, ...f })).items.map((d) => d.id);

    // closedAt = validTo ?? updatedAt: a closed at 9:00 though edited at 11:00.
    expect(await ids({ orderBy: "closedAt" })).toEqual([b.id, a.id, c.id]);
    expect(
      await ids({ orderBy: "closedAt", closedSince: new Date("2026-03-01T09:00:00.000Z") })
    ).toEqual([b.id]);
    expect(await ids({ statuses: ["withdrawn"], orderBy: "closedAt" })).toEqual([b.id, a.id]);
    expect(await ids({ maxSensitivity: "internal", orderBy: "createdAt" })).toEqual(
      [a.id, c.id].sort().reverse()
    );
    const all = await ids({ orderBy: "createdAt" });
    expect(
      await ids({
        orderBy: "createdAt",
        before: { at: new Date("2026-03-01T08:00:00.000Z"), id: all[0]! },
      })
    ).toEqual(all.slice(1));
    const page = await storage.queryDecisions({
      workspaceId: WS,
      orderBy: "createdAt",
      limit: 2,
      skipTotal: true,
    });
    expect(page).toMatchObject({ total: 2, hasMore: true });
  });

  it("createdSince / closedSince / orderBy newest first", async () => {
    vi.useFakeTimers();
    const storage = new InMemoryStorageAdapter();
    at("2026-03-01T08:00:00.000Z");
    const a = await decision(storage, "a");
    at("2026-03-01T09:00:00.000Z");
    const b = await decision(storage, "b");
    at("2026-03-01T10:00:00.000Z");
    await storage.updateDecision(a.id, { workspaceId: WS, title: "a2" } as never);

    const byCreated = await storage.queryDecisions({ workspaceId: WS, orderBy: "createdAt" });
    expect(byCreated.items.map((d) => d.id)).toEqual([b.id, a.id]);
    const byClosed = await storage.queryDecisions({ workspaceId: WS, orderBy: "closedAt" });
    expect(byClosed.items.map((d) => d.id)).toEqual([a.id, b.id]);
    const cs = await storage.queryDecisions({
      workspaceId: WS,
      createdSince: new Date("2026-03-01T08:30:00.000Z"),
    });
    expect(cs.items.map((d) => d.id)).toEqual([b.id]);
    const us = await storage.queryDecisions({
      workspaceId: WS,
      closedSince: new Date("2026-03-01T09:30:00.000Z"),
    });
    expect(us.items.map((d) => d.id)).toEqual([a.id]);
  });
});
