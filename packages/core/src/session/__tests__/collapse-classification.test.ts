/**
 * LIFECYCLE-5 — what the collapse never asked for, it never stored.
 *
 * Measured over 27 real-pipeline collapses: 100% of facts `kind=other`
 * (hardcoded), episode `topics` always `[]` (the summary field feeding it,
 * `relevantEntities`, was read but never requested), narratives reduced to
 * "Goal/Outcome" (same for `discoveries`), and `policy.extractFacts` declared
 * but never read. On the production stack 279/296 facts were `other`.
 *
 * Scope stays `global` on purpose: a fact's scope is `global | conversation`,
 * and conversation scope would hide session knowledge from workspace recall.
 * The session carries no narrower trusted context, and personal ownership is
 * not inferred from prose.
 */
import { describe, it, expect } from "vitest";
import { PRIMITIVE_SUBTYPES, type SessionTurn } from "@mnemo-ai/types";
import { buildCollapsePrompt, collapseSession } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

describe("LIFECYCLE-5 — fact kind", () => {
  it("asks the model for every fact kind the schema accepts", () => {
    const prompt = buildCollapsePrompt([
      { id: "t", turnIndex: 0, role: "user", content: "x" } as unknown as SessionTurn,
    ]);
    const factRule = prompt.split("\n- fact kind:")[1]!.split("\n- decision kind:")[0]!;
    // The six agent kinds of migration 0048 were never offered, and the prompt
    // sent "a technical fact about a system" to `other`: 312 of 326 extracted
    // facts on the Acme stack landed there.
    for (const kind of PRIMITIVE_SUBTYPES.fact) {
      expect(factRule, `fact kind rule should offer ${kind}`).toMatch(new RegExp(`\\b${kind}\\b`));
    }
    expect(factRule).not.toMatch(/technical fact about a system/);
    expect(prompt).toMatch(/relevantEntities/);
  });

  it("persists a valid kind and falls back to other for an invented one", async () => {
    const h = makeHarness({
      replies: [
        reply({
          facts: [
            { content: "Pablo wants answers in Spanish", kind: "preference" },
            { content: "ledger-api deploys on Tuesdays", kind: "deployment" },
            { content: "the cache TTL is 15 minutes" },
          ],
        }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    const byStatement = Object.fromEntries(h.activeFacts().map((f) => [f.statement, f]));
    expect(byStatement["Pablo wants answers in Spanish"]!.kind).toBe("preference");
    expect(byStatement["ledger-api deploys on Tuesdays"]!.kind).toBe("other");
    expect(byStatement["the cache TTL is 15 minutes"]!.kind).toBe("other");
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown fact kind"),
      expect.objectContaining({ received: "deployment" })
    );
    // Scope is not the model's to choose.
    expect(h.activeFacts().every((f) => f.scope === "global")).toBe(true);
  });
});

describe("LIFECYCLE-5 — policy and summary fields", () => {
  it("honours extractFacts:false", async () => {
    const h = makeHarness({
      replies: [
        reply({
          facts: [{ content: "would have been a fact" }],
          decisions: [{ title: "kept", body: "decisions still extracted", kind: "decision" }],
        }),
      ],
    });

    const result = await collapseSession(
      { ...input, policy: { extractFacts: false } },
      h.ctx,
      auth
    );

    expect(result.factsCreated).toBe(0);
    expect(h.storage.createFact).not.toHaveBeenCalled();
    expect(result.decisionsCreated).toBe(1);
  });

  it("feeds relevantEntities to the episode topics and discoveries to its narrative", async () => {
    const h = makeHarness({
      replies: [
        reply({
          relevantEntities: ["orders-api", "Redis"],
          discoveries: ["the limiter raced on INCR + EXPIRE"],
          nextSteps: ["move the limiter to a Lua script"],
          decisions: [{ title: "Use a Lua script", body: "atomic", kind: "bugfix" }],
        }),
      ],
    });

    await collapseSession(input, h.ctx, auth);

    expect(h.episodes[0]!.topics).toEqual(["orders-api", "Redis"]);
    expect(h.episodes[0]!.narrative).toContain("INCR + EXPIRE");
    const summary = (
      h.storage.updateSessionSummary.mock.calls[0]![0] as { summary: Record<string, unknown> }
    ).summary;
    expect(summary.nextSteps).toEqual(["move the limiter to a Lua script"]);
    // keyDecisions is derived from what was extracted, not asked for twice.
    expect(summary.keyDecisions).toEqual(["Use a Lua script"]);
  });
});
