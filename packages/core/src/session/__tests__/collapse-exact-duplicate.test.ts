/**
 * Q-1 (end-to-end verification of the eval fixes) — an extracted fact whose
 * statement is already live must not abort the collapse.
 *
 * `uniq_mnemo_fact_dedup` allows one live row per (scope, scopeRef, subject,
 * statement). The collapse wrote extracted facts with a bare `createFact`, so a
 * re-collapse that repeated a live statement word for word hit the index, and
 * because the whole persist is one transaction the request answered 500, wrote
 * nothing and left the session `active` (about 2 of 6 re-collapses with the
 * real model). `remember()` answers the same repeat with the existing row; the
 * collapse now does too, and links that row to its episode.
 *
 * The double enforces the index like Postgres (see collapse-fixture.ts); the
 * real transaction is proven in the server's collapse-exact-duplicate
 * integration test.
 */
import { describe, it, expect } from "vitest";
import { collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

const LIVE = "The orders-api rate limit is 500 requests per minute per API key.";
const NEW = "The orders-api retries a failed webhook 3 times.";

describe("Q-1 — an extracted statement that is already live", () => {
  it("reuses the live fact, links it to the episode and writes the rest", async () => {
    const h = makeHarness({
      replies: [reply({ facts: [{ content: LIVE }, { content: NEW }] })],
      seedFacts: [{ id: "live_1", statement: LIVE, scope: "global", subject: "general" }],
      atomic: true,
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(result.factsCreated).toBe(1);
    const live = h.activeFacts().filter((f) => f.statement === LIVE);
    expect(live.map((f) => f.id)).toEqual(["live_1"]);
    const created = h.activeFacts().find((f) => f.statement === NEW);
    expect(created).toBeDefined();
    expect(h.episodes).toHaveLength(1);
    expect(h.episodes[0]!.linkedFactIds).toEqual(expect.arrayContaining(["live_1", created!.id]));
    expect(h.session.status).toBe("collapsed");
  });

  it("final review I5: looks the duplicate up by owner and tier too (APP-009)", async () => {
    const h = makeHarness({
      replies: [reply({ facts: [{ content: LIVE }] })],
      atomic: true,
    });
    await collapseSession(input, h.ctx, auth);
    expect(h.storage.findLiveFactByStatement).toHaveBeenCalled();
    for (const [arg] of h.storage.findLiveFactByStatement.mock.calls as unknown[][]) {
      expect(arg).toMatchObject({ scopeOwner: "workspace:ws", sensitivity: "internal" });
    }
  });

  it("a writer that lands the statement between the check and the insert does not abort it", async () => {
    const h = makeHarness({
      replies: [reply({ facts: [{ content: LIVE }, { content: NEW }] })],
      atomic: true,
    });
    // A concurrent remember() commits the same statement after the collapse
    // looked for it: the INSERT is the first to see it, and fails on the index.
    const realCreate = h.storage.createFact.getMockImplementation()!;
    h.storage.createFact.mockImplementationOnce(async (fact: Record<string, unknown>) => {
      h.facts.set("winner", {
        id: "winner",
        statement: LIVE,
        status: "active",
        scope: "global",
        subject: "general",
      });
      return realCreate(fact);
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(
      h
        .activeFacts()
        .filter((f) => f.statement === LIVE)
        .map((f) => f.id)
    ).toEqual(["winner"]);
    expect(h.episodes[0]!.linkedFactIds).toEqual(expect.arrayContaining(["winner"]));
    expect(h.activeFacts().some((f) => f.statement === NEW)).toBe(true);
  });

  it("a keyed update whose new value is already live elsewhere reuses that row", async () => {
    const h = makeHarness({
      replies: [
        reply({ facts: [{ content: LIVE, topicKey: "orders-api-rate-limit" }, { content: NEW }] }),
      ],
      seedFacts: [
        {
          id: "keyed_300",
          statement: "The orders-api rate limit is 300 requests per minute per API key.",
          topicKey: "orders-api-rate-limit",
          scope: "global",
          subject: "general",
        },
        { id: "live_500", statement: LIVE, scope: "global", subject: "general" },
      ],
      atomic: true,
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(
      h
        .activeFacts()
        .filter((f) => f.statement === LIVE)
        .map((f) => f.id)
    ).toEqual(["live_500"]);
    expect(h.episodes[0]!.linkedFactIds).toEqual(expect.arrayContaining(["live_500"]));
    expect(h.activeFacts().some((f) => f.statement === NEW)).toBe(true);
  });

  it("any other write failure still rolls the whole collapse back", async () => {
    const h = makeHarness({
      replies: [reply({ facts: [{ content: LIVE }, { content: NEW }] })],
      atomic: true,
    });
    h.storage.createFact.mockRejectedValueOnce(new Error("injected: fact insert failed"));

    await expect(collapseSession(input, h.ctx, auth)).rejects.toThrow(/injected/);
    expect(h.activeFacts()).toHaveLength(0);
    expect(h.session.status).toBe("active");
  });
});
