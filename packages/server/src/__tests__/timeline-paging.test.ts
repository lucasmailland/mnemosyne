/**
 * PRIM-19 (V-10) — GET /timeline answered `nextCursor: null` on every page, so a
 * workspace with more events than `limit` could only be read from the newest.
 * It now pages newest-first with an opaque base64url cursor like GET /facts.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import { BadRequestError } from "../errors.js";
import { deriveTimelineEvents, type TimelineEvent } from "../routes/timeline.js";

const WS = "00000000-0000-0000-0000-0000000000f9";

async function seed(storage: InMemoryStorageAdapter, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = await storage.createFact({
      workspaceId: WS,
      statement: `timeline paging fact ${i}`,
      subject: "workspace",
      kind: "other",
      scope: "global",
    } as never);
    ids.push(f.id);
    // a fact in every lifecycle: pinned, edited, forgotten, untouched.
    if (i % 4 === 1) await storage.updateFact(f.id, WS, { pinned: true });
    if (i % 4 === 2) await storage.updateFact(f.id, WS, { statement: `edited ${i}` } as never);
    if (i % 4 === 3) await storage.forgetFact?.(f.id, WS);
  }
  return ids;
}

async function walk(storage: InMemoryStorageAdapter, since: Date, limit: number) {
  const pages: TimelineEvent[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.events.length).toBeLessThanOrEqual(limit);
    pages.push(page.events);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("timeline never ended");
}

describe("deriveTimelineEvents — cursor paging", () => {
  for (const limit of [1, 2, 3, 7, 10]) {
    it(`limit ${limit}: walking every page loses and duplicates nothing, in the same order as one big page`, async () => {
      const storage = new InMemoryStorageAdapter();
      await seed(storage, 23);
      const since = new Date(Date.now() - 3_600_000); // determinism-ok: relative window start; the test asserts paging, not the timestamp

      const whole = await deriveTimelineEvents(storage, { workspaceId: WS, since, limit: 500 });
      expect(whole.nextCursor).toBeNull();
      expect(whole.events.length).toBeGreaterThanOrEqual(23);

      const pages = await walk(storage, since, limit);
      const walked = pages.flat();
      expect(new Set(walked.map((e) => e.id)).size).toBe(walked.length);
      expect(walked.map((e) => e.id)).toEqual(whole.events.map((e) => e.id));
      // every page but the last is full: a short page never hides a next one.
      for (const p of pages.slice(0, -1)) expect(p).toHaveLength(limit);
    });
  }

  it("a page that exactly exhausts the events has no next cursor", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, 6);
    const since = new Date(Date.now() - 3_600_000); // determinism-ok: relative window start; the test asserts paging, not the timestamp
    const whole = await deriveTimelineEvents(storage, { workspaceId: WS, since, limit: 500 });
    const exact = await deriveTimelineEvents(storage, {
      workspaceId: WS,
      since,
      limit: whole.events.length,
    });
    expect(exact.nextCursor).toBeNull();
    expect(exact.events).toHaveLength(whole.events.length);
  });

  it("an invalid cursor is a 400, not a silent first page", async () => {
    const storage = new InMemoryStorageAdapter();
    await expect(
      deriveTimelineEvents(storage, { workspaceId: WS, limit: 5, cursor: "not-a-cursor" })
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("deriveTimelineEvents — read ceiling", () => {
  it("omits facts above the ceiling entirely and still pages without loss", async () => {
    const storage = new InMemoryStorageAdapter();
    const visible: string[] = [];
    for (let i = 0; i < 9; i++) {
      const tier = i % 3 === 0 ? "restricted" : i % 3 === 1 ? "confidential" : "internal";
      const f = await storage.createFact({
        workspaceId: WS,
        statement: `SECRET-${i} ${tier}`,
        subject: "workspace",
        kind: "other",
        scope: "global",
        sensitivity: tier,
      } as never);
      await storage.updateFact(f.id, WS, { pinned: true });
      if (tier === "internal") visible.push(f.id);
    }
    const since = new Date(Date.now() - 3_600_000); // determinism-ok: relative window start; the test asserts paging, not the timestamp
    const walked: TimelineEvent[] = [];
    let cursor: string | undefined;
    for (let g = 0; g < 50; g++) {
      const p = await deriveTimelineEvents(storage, {
        workspaceId: WS,
        since,
        limit: 2,
        maxSensitivity: "internal",
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...p.events);
      if (!p.nextCursor) break;
      expect(p.events).toHaveLength(2);
      cursor = p.nextCursor;
    }
    expect(JSON.stringify(walked)).not.toContain("restricted");
    expect(JSON.stringify(walked)).not.toContain("confidential");
    expect(new Set(walked.map((e) => e.factId))).toEqual(new Set(visible));
    expect(new Set(walked.map((e) => e.id)).size).toBe(walked.length);
  });
});
