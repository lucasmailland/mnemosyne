/**
 * P124 — the fence tolerance, and its limits.
 *
 * Found against a real container: a four-turn session collapsed to a 503 with
 * `Unexpected token '\`', "\`\`\`json\n{\n"... is not valid JSON`. The model had
 * answered correctly and wrapped its JSON in a markdown fence, which is what
 * most small models do by default. Four sites parsed LLM output raw, and one
 * of them — recall's rerank — swallows the throw and degrades silently, so
 * three backticks could quietly unrerank every recall.
 *
 * Half of these tests are about what the helper must NOT do. Being clever with
 * prose is how a parser starts returning the wrong object confidently: a model
 * that explains itself and then shows an example would have the EXAMPLE
 * parsed as the answer, and nothing downstream could tell.
 */
import { describe, it, expect } from "vitest";

import { parseJsonReply, stripCodeFence } from "../parse-json-reply.js";

describe("P124 — a fenced JSON reply parses", () => {
  it("handles the exact shape that broke the collapse", () => {
    const raw = '```json\n{"facts": [], "decisions": []}\n```';
    expect(parseJsonReply(raw, "t")).toEqual({ facts: [], decisions: [] });
  });

  it("handles a fence with no language tag", () => {
    expect(parseJsonReply("```\n[1, 2, 3]\n```", "t")).toEqual([1, 2, 3]);
  });

  it("handles other language tags a model might pick", () => {
    expect(parseJsonReply('```JSON\n{"a":1}\n```', "t")).toEqual({ a: 1 });
    expect(parseJsonReply('```javascript\n{"a":1}\n```', "t")).toEqual({ a: 1 });
  });

  it("handles leading and trailing whitespace around the fence", () => {
    expect(parseJsonReply('\n\n  ```json\n{"a":1}\n```  \n', "t")).toEqual({ a: 1 });
  });

  it("still parses a plain, unfenced reply", () => {
    // The regression that would matter most: every model that was already
    // working must keep working.
    expect(parseJsonReply('{"a":1}', "t")).toEqual({ a: 1 });
    expect(parseJsonReply("  [1,2]  ", "t")).toEqual([1, 2]);
  });

  it("preserves backticks INSIDE the JSON", () => {
    // A summary quoting code is not a fence. Stripping greedily would corrupt
    // the payload rather than fail, which is worse.
    const raw = '```json\n{"note": "use ```bash to run it"}\n```';
    expect(parseJsonReply<{ note: string }>(raw, "t").note).toBe("use ```bash to run it");
  });
});

describe("a fenced answer followed by an explanation", () => {
  it("parses the leading block and ignores the prose after it", () => {
    // Verbatim shape from Claude Haiku 4.5 on Bedrock, collapse.groups.
    const raw =
      "```json\n[]\n```\n\nThe provided facts appear to be fragments of a conversation " +
      "in Spanish about diagrams, but they don't form coherent n-ary relations.";
    expect(parseJsonReply(raw, "t")).toEqual([]);
  });

  it("parses a multi-line object followed by prose", () => {
    const raw = '```json\n{\n  "goal": "deploy",\n  "outcome": "done"\n}\n```\nNotes: none.';
    expect(parseJsonReply(raw, "t")).toEqual({ goal: "deploy", outcome: "done" });
  });

  it("keeps backticks inside a string when prose follows", () => {
    const raw = '```json\n{"note": "use ```bash to run it"}\n```\nThat is all.';
    expect(parseJsonReply<{ note: string }>(raw, "t").note).toBe("use ```bash to run it");
  });

  it("still throws when the leading block is not valid JSON", () => {
    expect(() => parseJsonReply('```json\n{"a": \n```\nsorry', "t")).toThrow(/not valid JSON/);
  });

  it("does not take a fenced example that comes after prose", () => {
    expect(() => parseJsonReply('Here is an example:\n```json\n{"a":1}\n```', "t")).toThrow();
  });
});

describe("P124 — what it refuses to guess", () => {
  it("does NOT dig JSON out of surrounding prose", () => {
    // Deliberate. The alternative is a parser that sometimes returns an
    // example object as if it were the answer, with no way to notice.
    expect(() => parseJsonReply('Sure! Here is the JSON: {"a":1}', "t")).toThrow();
  });

  it("throws on genuinely broken JSON rather than returning a partial object", () => {
    expect(() => parseJsonReply('```json\n{"a": \n```', "t")).toThrow();
  });

  it("names the SITE in the error, because a log line has to say which parse failed", () => {
    expect(() => parseJsonReply("not json", "collapse.summary")).toThrow(/collapse\.summary/);
  });

  it("includes what actually arrived, bounded", () => {
    // The original failures said `Unexpected token` and nothing about the
    // payload — enough to guess a fence, not enough to diagnose anything else.
    expect(() => parseJsonReply("total garbage from the model", "t")).toThrow(/total garbage/);

    const long = "x".repeat(500);
    try {
      parseJsonReply(long, "t");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("…");
      expect(msg.length).toBeLessThan(400);
    }
  });
});

describe("stripCodeFence", () => {
  it("returns the inner content, trimmed", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves an unfenced string alone apart from trimming", () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("does not strip a fence that only opens", () => {
    // A truncated reply is broken input, not a fenced one. Treating it as
    // fenced would hand a half-object to JSON.parse and blame the payload.
    expect(stripCodeFence('```json\n{"a":1}')).toBe('```json\n{"a":1}');
  });
});
