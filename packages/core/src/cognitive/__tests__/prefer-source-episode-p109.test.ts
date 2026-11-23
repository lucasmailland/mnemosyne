import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { preferSourceEpisode } from "../recall-cold.js";
import type { AuthContext, RecallHit } from "@mnemo-ai/types";

// P109 — proof that the episode-context enrichment was inert, and is not any more.
//
// `preferSourceEpisode` implements spec §17 "prefer source episode": for each
// fact hit carrying an `episodeId`, look up the episode and inject it above the
// bare fact so the richer context surfaces first. It has been fully implemented
// for a long time, and it read `mnemo_fact.episode_id` — a column no production
// code ever wrote. Every call hit `if (!fact?.episodeId) continue;` and returned
// the hits untouched.
//
// The first test below is the "before" state and the second is the "after";
// only the link written by linkSessionFactsToEpisode separates them.

const WS = "11111111-1111-4111-8111-111111111111";

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "agent-p109",
  actorType: "agent",
  scopes: ["memory:read"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter) {
  return {
    storage,
    telemetry: {
      startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }),
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  } as never;
}

function hitFor(id: string, content: string, score: number): RecallHit {
  return {
    id,
    primitive: "fact",
    content,
    score,
    sensitivity: "internal",
    injectionScore: 0,
    provenance: {} as never,
    origin: "local",
    contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null,
  } as RecallHit;
}

async function seed(storage: InMemoryStorageAdapter) {
  const fact = await storage.createFact({
    workspaceId: WS,
    statement: "we moved off Postgres",
    subject: "workspace",
    kind: "other",
    scope: "global",
    sessionId: "s-1",
  } as never);

  const episode = await storage.createEpisode({
    workspaceId: WS,
    title: "Architecture migration review",
    narrative: "Goal: pick the storage engine for the new ingest path",
    occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    linkedFactIds: [fact.id],
    topics: ["architecture", "storage"],
    sourceConversationId: "s-1",
  } as never);

  return { fact, episode };
}

describe("preferSourceEpisode — episode context reaches recall (P109)", () => {
  it("returns hits untouched while no fact carries an episodeId (the old state)", async () => {
    const storage = new InMemoryStorageAdapter();
    const { fact } = await seed(storage);

    const hits = [hitFor(fact.id, "we moved off Postgres", 0.9)];
    const out = await preferSourceEpisode(makeCtx(storage), WS, hits, auth);

    // The episode exists and names this fact in linkedFactIds — but the link is
    // only on the episode's side, so the enrichment cannot see it.
    expect(out).toHaveLength(1);
    expect(out[0]!.primitive).toBe("fact");
  });

  it("injects the source episode once the fact carries the link", async () => {
    const storage = new InMemoryStorageAdapter();
    const { fact, episode } = await seed(storage);

    const linked = await storage.linkSessionFactsToEpisode(WS, "s-1", episode.id);
    expect(linked).toBe(1);

    const hits = [hitFor(fact.id, "we moved off Postgres", 0.9)];
    const out = await preferSourceEpisode(makeCtx(storage), WS, hits, auth);

    const injected = out.find((h) => h.primitive === "episode");
    expect(injected).toBeDefined();
    expect(injected!.id).toBe(episode.id);

    // §17 prefers, it does not replace: the fact must survive, ranked below.
    const factHit = out.find((h) => h.id === fact.id);
    expect(factHit).toBeDefined();
    expect(factHit!.score).toBeLessThan(injected!.score);
  });

  it("does not lift a weak fact and its episode above a stronger hit", async () => {
    // A structural floor of 0.5 turned a fact at cosine 0.14 into the second
    // result of an unrelated query, right behind its own episode at 0.5.
    const storage = new InMemoryStorageAdapter();
    const { fact, episode } = await seed(storage);
    await storage.linkSessionFactsToEpisode(WS, "s-1", episode.id);

    const hits = [
      hitFor(fact.id, "we moved off Postgres", 0.05),
      hitFor("strong", "the answer the query asked for", 0.3),
    ];
    const out = await preferSourceEpisode(makeCtx(storage), WS, hits, auth);
    const score = (id: string) => out.find((h) => h.id === id)!.score;

    expect(score(episode.id)).toBeLessThanOrEqual(0.05);
    expect(score(fact.id)).toBeLessThan(score(episode.id));
    expect(score(episode.id)).toBeLessThan(score("strong"));
  });
});
