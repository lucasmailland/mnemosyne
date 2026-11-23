/**
 * LIFECYCLE-9 — 18.5% of collapses failed on invalid JSON with a 4B model.
 *
 * Four of the five bad replies contained `"confidence": 0",` — copied from the
 * prompt's own template, which said `"confidence": 0.0-1.0`: not JSON. The
 * pipeline then took the parsed value on faith (a type assertion, no runtime
 * check) and gave up on the first failure, so a session the model would have
 * extracted on a second try sat `active` until the sweep's attempts ran out.
 *
 * Pinned here: the prompt's example is valid JSON, a malformed or mis-shaped
 * reply gets exactly ONE corrective retry, a second failure writes nothing,
 * and the fence tolerance P160 added still holds.
 */
import { describe, it, expect } from "vitest";
import { buildCollapsePrompt, collapseSession, validateCollapseSummary } from "../collapse.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

const input = { sessionId: "s1", workspaceId: "ws", reason: "explicit" as const };

const GOOD = reply({
  facts: [{ content: "orders-api runs on Node 20", confidence: 0.9 }],
  decisions: [{ title: "Use Node 20", body: "LTS", kind: "decision" }],
  strategies: [{ trigger: "a deploy fails", action: "roll back first" }],
});

/** What qwen3-4b actually sent back, modulo content. */
const BROKEN = `{"goal": "x", "outcome": "resolved", "facts": [{"content": "a", "confidence": 0", "topicKey": "k"}], "decisions": [], "strategies": []}`;

describe("LIFECYCLE-9 — the extraction prompt", () => {
  const prompt = buildCollapsePrompt([
    {
      id: "t0",
      workspaceId: "ws",
      sessionId: "s1",
      turnIndex: 0,
      role: "user",
      content: "hola",
      createdAt: new Date(0),
    },
  ]);

  it("no longer shows a non-JSON range as a value", () => {
    expect(prompt).not.toContain("0.0-1.0");
  });

  it("shows an example that is itself valid JSON", () => {
    const start = prompt.indexOf("{\n");
    const end = prompt.indexOf("\n}", start);
    expect(start).toBeGreaterThan(-1);
    const example = prompt.slice(start, end + 2);
    expect(() => JSON.parse(example)).not.toThrow();
  });
});

describe("LIFECYCLE-9 — invalid replies", () => {
  it("recovers with one corrective retry after a malformed reply", async () => {
    const h = makeHarness({ replies: [BROKEN, GOOD] });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(result.factsCreated).toBe(1);
    // Both calls are paid for, so both are counted.
    expect(result.llmTokensUsed).toBe(40);
    const retryPrompt = (
      h.generate.mock.calls[1] as unknown as [{ messages: Array<{ content: string }> }]
    )[0].messages[0]!.content;
    expect(retryPrompt).toMatch(/could not be used/i);
  });

  it("gives up after the retry and writes nothing", async () => {
    const h = makeHarness({ replies: [BROKEN, BROKEN, GOOD] });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("failed");
    expect(result.skipReason).toBe("llm_unavailable");
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.storage.createFact).not.toHaveBeenCalled();
    expect(h.storage.createDecision).not.toHaveBeenCalled();
    expect(h.storage.closeSession).not.toHaveBeenCalled();
  });

  it("treats a reply of the wrong shape like a malformed one", async () => {
    const h = makeHarness({
      replies: [
        { goal: "x", outcome: "resolved", facts: "none", decisions: [], strategies: [] },
        GOOD,
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(h.generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a reply truncated at the output budget", async () => {
    const h = makeHarness({ replies: [GOOD] });
    h.generate.mockResolvedValueOnce({
      content: '{"facts": [',
      tokensUsed: { input: 10, output: 10 },
      model: "fake",
      finishReason: "length" as unknown as "stop",
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("failed");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it("still accepts a fenced reply without a retry (P160)", async () => {
    const h = makeHarness({ replies: ["```json\n" + JSON.stringify(GOOD) + "\n```\nDone."] });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});

describe("Review round — schema-invalid items are not silently lost", () => {
  it("retries a reply whose items use the wrong field name", async () => {
    const h = makeHarness({
      replies: [
        { goal: "x", outcome: "resolved", facts: [{ statement: "important knowledge" }] },
        GOOD,
      ],
    });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(result.factsCreated).toBe(1);
  });

  it("leaves the session retryable when the retry is still schema-invalid", async () => {
    const bad = { goal: "x", outcome: "resolved", facts: [{ statement: "important knowledge" }] };
    const h = makeHarness({ replies: [bad, bad], atomic: true });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("failed");
    expect(result.skipReason).toBe("llm_unavailable");
    expect(h.storage.createFact).not.toHaveBeenCalled();
    expect(h.storage.commitSessionCollapse).not.toHaveBeenCalled();
    expect(h.session.status).toBe("active");
  });

  it("an explicitly empty list is a valid answer, not a schema error", async () => {
    const h = makeHarness({ replies: [reply({ facts: [], decisions: [], strategies: [] })] });

    const result = await collapseSession(input, h.ctx, auth);

    expect(result.status).toBe("completed");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});

describe("validateCollapseSummary", () => {
  it("drops malformed items and keeps the rest", () => {
    const out = validateCollapseSummary({
      outcome: "resolved",
      facts: [{ content: "" }, "plain string", { content: "kept", confidence: 7 }, null],
      decisions: [{ title: "t" }, { title: "t", body: "b", kind: 3 }],
      strategies: [{ trigger: "x" }, { trigger: "x", action: "y" }],
    });

    expect(out.facts).toEqual([{ content: "kept", confidence: 1 }]);
    expect(out.decisions).toEqual([{ title: "t", body: "b" }]);
    expect(out.strategies).toEqual([{ trigger: "x", action: "y" }]);
  });

  it("defaults missing lists to empty", () => {
    const out = validateCollapseSummary({ outcome: "partial" });
    expect(out.facts).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.strategies).toEqual([]);
  });

  it("rejects a non-object reply and a list that is not a list", () => {
    expect(() => validateCollapseSummary([])).toThrow(/invalid_extraction/);
    expect(() => validateCollapseSummary("text")).toThrow(/invalid_extraction/);
    expect(() => validateCollapseSummary({ facts: {} })).toThrow(/invalid_extraction/);
  });
});
