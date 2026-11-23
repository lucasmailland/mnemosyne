/**
 * B4.1 — HTTP route coverage fill-in: events, episodes, and the §35 memory
 * events REST catch-up surface (design.md "B4. Coverage fill-in", spec.md
 * Requirement 13).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("events routes (B4.1)", () => {
  it("POST /events, GET /events, GET /events/:id", async () => {
    const created = await json(
      await surface.http("POST", "/events", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "system",
          name: "B4.1 event",
          description: "A B4.1 coverage-fill-in event.",
          occurredAt: new Date().toISOString(), // determinism-ok: throwaway fixture value, not asserted
          source: "b4.1-test",
          // Starts below the key's `internal` ceiling so a raise is possible.
          sensitivity: "public",
        }),
      })
    );
    expect(created.id).toBeTruthy();

    const listRes = await surface.http("GET", "/events");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((e: any) => e.id === created.id)).toBe(true);

    const getRes = await surface.http("GET", `/events/${created.id}`);
    expect(getRes.status).toBe(200);
    const got = await json(getRes);
    expect(got.id).toBe(created.id);

    const annotateRes = await surface.http("POST", `/events/${created.id}/annotations`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "b4.1", content: "annotated" }),
    });
    expect(annotateRes.status).toBe(200);
    const annotated = await json(annotateRes);
    expect(annotated.annotations.length).toBe(1);

    // PRIM-10 (WP-5): events are immutable — DELETE is refused with 409 and
    // touches nothing (it used to answer a no-op 204).
    const refused = await surface.http("DELETE", `/events/${created.id}`);
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe("event_immutable");

    const sensRes = await surface.http("PATCH", `/events/${created.id}/sensitivity`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensitivity: "internal" }),
    });
    expect(sensRes.status).toBe(200);
    const sensBody = await json(sensRes);
    expect(sensBody.sensitivity).toBe("internal");

    const lowerRes = await surface.http("PATCH", `/events/${created.id}/sensitivity`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensitivity: "public" }),
    });
    expect(lowerRes.status).toBe(422);

    // PRIM-14: `confidential` is above this key's default `internal` ceiling,
    // so the event could never be read again by its writer: refused with 404
    // `sensitivity_above_ceiling` and left unchanged.
    const aboveRes = await surface.http("PATCH", `/events/${created.id}/sensitivity`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sensitivity: "confidential" }),
    });
    expect(aboveRes.status).toBe(404);
    expect((await json(aboveRes)).error.code).toBe("sensitivity_above_ceiling");
    const after = await surface.http("GET", `/events/${created.id}`);
    expect(after.status).toBe(200);
    expect((await json(after)).sensitivity).toBe("internal");
  });
});

describe("episodes routes (B4.1)", () => {
  it("POST /episodes, GET /episodes, GET /episodes/:id, GET /episodes/:id/timeline", async () => {
    const created = await json(
      await surface.http("POST", "/episodes", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "B4.1 episode",
          narrative: "A B4.1 coverage-fill-in episode narrative.",
        }),
      })
    );
    expect(created.id).toBeTruthy();

    // B4.1 discovery, fixed this session (EpisodeRepository.createEpisode):
    // used to be a plain crypto.randomUUID(), which GET /episodes/:id's own
    // param schema (EPISODE_ID_PATTERN = /^mepi_[a-z0-9_]{1,64}$/) could
    // never accept — a created episode could not be fetched back by id. Now
    // matches the extraction pipeline's own mepi_-prefixed convention
    // (packages/core/src/episode/store.ts).
    expect(created.id).toMatch(/^mepi_[a-z0-9_]{1,64}$/);

    const listRes = await surface.http("GET", "/episodes?includeSynthetic=true");
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(list.items.some((e: any) => e.id === created.id)).toBe(true);

    const getRes = await surface.http("GET", `/episodes/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await json(getRes);
    expect(fetched.episode.id).toBe(created.id);
    expect(fetched.episode.title).toBe("B4.1 episode");

    const timelineRes = await surface.http("GET", `/episodes/${created.id}/timeline`);
    expect(timelineRes.status).toBe(200);
  });
});

describe("GET /memory/events — §35 REST catch-up (B4.1)", () => {
  it("204 when no replay buffer is wired (harness has no Redis)", async () => {
    const res = await surface.http("GET", "/memory/events?since=evt_x_0_0");
    expect(res.status).toBe(204);
  });
});
