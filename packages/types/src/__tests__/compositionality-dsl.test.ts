import { describe, it, expect } from "vitest";
import { parseConditionDsl, parseActionDsl } from "../compositionality.js";

describe("ConditionDsl", () => {
  it("parses a valid 2-clause condition", () => {
    const c = parseConditionDsl({
      all: [
        { op: "fact_kind", kind: "objective_fact", bind: "$a" },
        { op: "topic_key_in", topicKeys: ["auth"], bind: "$b" },
      ],
    });
    expect(c.all).toHaveLength(2);
  });
  it("rejects unknown op", () => {
    expect(() => parseConditionDsl({ all: [{ op: "fact_label", kind: "x" }] })).toThrow();
  });
  it("rejects empty all array", () => {
    expect(() => parseConditionDsl({ all: [] })).toThrow();
  });
});

describe("ActionDsl", () => {
  it("derive_fact action requires statementTemplate", () => {
    expect(() => parseActionDsl({ op: "derive_fact" })).toThrow();
  });
  it("parses a valid derive_fact action with defaults", () => {
    const a = parseActionDsl({ op: "derive_fact", statementTemplate: "X is Y" });
    expect(a.baseConfidence).toBe(0.7);
    expect(a.sensitivity).toBe("internal");
  });
});

describe("composition DSL — relation + fact_value ops (spec §32)", () => {
  it("parses a relation clause", () => {
    const c = parseConditionDsl({
      all: [{ op: "relation", from: "$a", to: "$b", verb: "related" }],
    });
    expect(c.all[0]).toMatchObject({ op: "relation", from: "$a", to: "$b", verb: "related" });
  });

  it("rejects a relation clause with an unknown verb", () => {
    expect(() =>
      parseConditionDsl({ all: [{ op: "relation", from: "$a", to: "$b", verb: "bogus" }] }),
    ).toThrow();
  });

  it("parses a fact_value clause with a compare cross-binding", () => {
    const c = parseConditionDsl({
      all: [
        { op: "fact_value", subject: "$a", predicate: "has_timeout", valueType: "duration" },
        { op: "fact_value", subject: "$b", predicate: "has_processing_time", valueType: "duration", compare: { lt: "$b" } },
      ],
    });
    expect(c.all).toHaveLength(2);
    expect(c.all[1]).toMatchObject({ op: "fact_value", compare: { lt: "$b" } });
  });

  it("parses a derive_warning action", () => {
    const a = parseActionDsl({ op: "derive_warning", statementTemplate: "⚠️ $a", baseConfidence: 0.8 });
    expect(a.op).toBe("derive_warning");
    expect(a.type).toBe("warning");
  });

  it("derive_fact defaults type to 'fact'", () => {
    const a = parseActionDsl({ op: "derive_fact", statementTemplate: "$a" });
    expect(a.type).toBe("fact");
  });
});
