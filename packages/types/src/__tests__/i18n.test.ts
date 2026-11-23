import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  MAX_MATCH_LENGTH,
  compileTemplates,
  matchTemplate,
  normalizeLocale,
  resolveLocale,
  translate,
} from "../i18n.js";

describe("normalizeLocale", () => {
  it.each([123, null, {}, [], true])("non-string %j -> undefined, never throws", (v) =>
    expect(normalizeLocale(v as unknown as string)).toBeUndefined()
  );

  it.each([
    ["es", "es-419"],
    ["es-AR", "es-419"],
    ["es-419", "es-419"],
    ["ES_mx", "es-419"],
    ["es_MX.UTF-8", "es-419"],
    ["es_AR@euro", "es-419"],
    ["en", "en-US"],
    ["en-GB", "en-US"],
    ["en_US.UTF-8", "en-US"],
    [" es ", "es-419"],
  ])("%s -> %s", (tag, want) => expect(normalizeLocale(tag)).toBe(want));

  it.each([
    "C",
    "POSIX",
    "",
    undefined,
    "pt-BR",
    "fr",
    "*",
    "constructor",
    "__proto__",
    "toString",
  ])("%s -> undefined", (tag) => expect(normalizeLocale(tag)).toBeUndefined());
});

describe("resolveLocale", () => {
  it("exposes the locales and the default", () => {
    expect(LOCALES).toEqual(["en-US", "es-419"]);
    expect(DEFAULT_LOCALE).toBe("en-US");
  });

  it("first candidate that normalizes wins; unusable ones are skipped", () => {
    expect(resolveLocale([undefined, "C", "es_AR.UTF-8", "en"])).toBe("es-419");
    expect(resolveLocale(["en", "es"])).toBe("en-US");
  });

  it("candidates beat Accept-Language", () => {
    expect(resolveLocale(["en"], "es")).toBe("en-US");
  });

  it("falls back to q-sorted Accept-Language, then en-US", () => {
    expect(resolveLocale([], "es-AR,es;q=0.9,en;q=0.8")).toBe("es-419");
    expect(resolveLocale([], "en;q=0.5,es;q=0.9")).toBe("es-419");
    expect(resolveLocale([], "pt-BR")).toBe("en-US");
    expect(resolveLocale([], "*")).toBe("en-US");
    expect(resolveLocale([])).toBe("en-US");
    expect(resolveLocale(["C", "POSIX"], "")).toBe("en-US");
  });

  it("ignores malformed or zero q values", () => {
    expect(resolveLocale([], "es;q=abc,en;q=0.5")).toBe("en-US");
    expect(resolveLocale([], "es;q=0,en")).toBe("en-US");
    expect(resolveLocale([], "es;q=,en;q=0.1")).toBe("en-US");
  });

  it("prototype keys never resolve", () => {
    expect(resolveLocale(["constructor", "__proto__"], "toString,constructor;q=0.9")).toBe("en-US");
  });
});

describe("translate", () => {
  const en = {
    a: { b: "Hello {name}", n: { one: "{count} item", other: "{count} items" } },
    missing: "Needs {x}",
    brace: "Literal {x} stays",
  } as const;
  const es = {
    a: { b: "Hola {name}", n: { one: "{count} elemento", other: "{count} elementos" } },
  } as const;

  it("walks dotted keys and interpolates", () => {
    expect(translate(en, "a.b", { name: "Ana" }, "en-US")).toBe("Hello Ana");
    expect(translate(es, "a.b", { name: "Ana" }, "es-419")).toBe("Hola Ana");
  });

  it("leaves unknown {name} visible", () => {
    expect(translate(en, "missing")).toBe("Needs {x}");
    expect(translate(en, "missing", { y: "1" })).toBe("Needs {x}");
  });

  it("selects one/other by vars.count in both locales", () => {
    expect(translate(en, "a.n", { count: 1 }, "en-US")).toBe("1 item");
    expect(translate(en, "a.n", { count: 3 }, "en-US")).toBe("3 items");
    expect(translate(es, "a.n", { count: 1 }, "es-419")).toBe("1 elemento");
    expect(translate(es, "a.n", { count: 0 }, "es-419")).toBe("0 elementos");
  });

  it("plural without a numeric count uses other", () => {
    expect(translate(en, "a.n", { count: "1" })).toBe("1 items");
  });

  it("unknown keys return the key; prototype keys never resolve", () => {
    expect(translate(en, "nope")).toBe("nope");
    expect(translate(en, "a")).toBe("a");
    expect(translate(en, "constructor")).toBe("constructor");
    expect(translate(en, "__proto__.x")).toBe("__proto__.x");
    expect(translate(en, "a.toString")).toBe("a.toString");
  });

  it("prototype var names are not substituted", () => {
    expect(translate({ k: "{constructor} {toString}" }, "k", {})).toBe("{constructor} {toString}");
  });

  it("is not re-interpolated from values", () => {
    expect(translate(en, "a.b", { name: "{name}" })).toBe("Hello {name}");
  });
});

describe("compileTemplates / matchTemplate", () => {
  const table = {
    "fact.notFound": "Fact {id} not found",
    "any.notFound": "{what} not found",
    "ws.mismatch": "Workspace {a} does not match {b}",
    "plain.dot": "Bad request. Try again (now).",
  };
  const compiled = compileTemplates(table);

  it("picks the most specific template, whatever the table order", () => {
    expect(matchTemplate(compiled, "Fact 42 not found")).toEqual({
      key: "fact.notFound",
      vars: { id: "42" },
    });
    expect(matchTemplate(compiled, "Entity 42 not found")).toEqual({
      key: "any.notFound",
      vars: { what: "Entity 42" },
    });
    const reversed = compileTemplates(Object.fromEntries(Object.entries(table).reverse()));
    expect(matchTemplate(reversed, "Fact 42 not found")?.key).toBe("fact.notFound");
  });

  it("captures several variables by name", () => {
    expect(matchTemplate(compiled, "Workspace w1 does not match w2")).toEqual({
      key: "ws.mismatch",
      vars: { a: "w1", b: "w2" },
    });
  });

  it("captures regex metacharacters and newlines verbatim", () => {
    const id = "a.b*c+(d)[e]|^$\\";
    expect(matchTemplate(compiled, `Fact ${id} not found`)?.vars).toEqual({ id });
    expect(matchTemplate(compiled, "Fact a\nb not found")?.vars).toEqual({ id: "a\nb" });
  });

  it("escapes literal template text", () => {
    expect(matchTemplate(compiled, "Bad request. Try again (now).")?.key).toBe("plain.dot");
    expect(matchTemplate(compiled, "BadXrequestX Try again XnowX")).toBeUndefined();
  });

  it("is anchored at both ends", () => {
    expect(matchTemplate(compiled, "x Fact 1 not found")?.key).toBe("any.notFound");
    expect(matchTemplate(compiled, "Fact 1 not found!")).toBeUndefined();
    expect(matchTemplate(compiled, "Bad request. Try again (now). ")).toBeUndefined();
  });

  it("requires a non-empty capture and returns undefined for no match", () => {
    expect(matchTemplate(compiled, "Fact  not found")?.key).toBe("any.notFound");
    expect(matchTemplate(compiled, " not found")).toBeUndefined();
    expect(matchTemplate(compiled, "something else")).toBeUndefined();
    expect(matchTemplate([], "x")).toBeUndefined();
  });

  it("never evaluates captured text and keeps prototype names as plain data", () => {
    const c = compileTemplates({ k: "Got {constructor}" });
    const m = matchTemplate(c, "Got ${process.exit()}");
    expect(m?.vars.constructor).toBe("${process.exit()}");
    expect(Object.getPrototypeOf(m?.vars)).toBeNull();
  });

  it("is linear: a 100 KB near-miss against a 4-placeholder template is fast", () => {
    const c = compileTemplates({ k: "{a} and {b} and {c} and {d} end" });
    const t = performance.now();
    expect(matchTemplate(c, " and ".repeat(20_000))).toBeUndefined();
    // within the cap too: no backtracking blowup
    expect(matchTemplate(c, " and ".repeat(MAX_MATCH_LENGTH / 5 - 1))).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(50);
  });

  it("never matches messages over the length cap", () => {
    const c = compileTemplates({ k: "Fact {id} not found" });
    const ok = "Fact " + "x".repeat(MAX_MATCH_LENGTH - 15) + " not found";
    expect(ok).toHaveLength(MAX_MATCH_LENGTH);
    expect(matchTemplate(c, ok)?.key).toBe("k");
    expect(matchTemplate(c, ok + "!")).toBeUndefined();
    expect(matchTemplate(c, "Fact " + "x".repeat(MAX_MATCH_LENGTH) + " not found")).toBeUndefined();
  });

  it("throws on duplicate or adjacent placeholders", () => {
    expect(() => compileTemplates({ k: "{a} and {a}" })).toThrow(/duplicate/);
    expect(() => compileTemplates({ k: "x {a}{b} y" })).toThrow(/adjacent/);
    expect(() => compileTemplates({ k: "{a}{b}" })).toThrow(/adjacent/);
  });

  it("ties on literal weight go to fewer placeholders; prefix and suffix cannot overlap", () => {
    const c = compileTemplates({ two: "{a}-{b}", one: "{a}x" });
    expect(c.map((e) => e.key)).toEqual(["one", "two"]);
    expect(matchTemplate(c, "q-x")?.key).toBe("one");
    const o = compileTemplates({ k: "ab{x}ba" });
    expect(matchTemplate(o, "aba")).toBeUndefined();
    expect(matchTemplate(o, "abXba")?.vars).toEqual({ x: "X" });
  });

  it("matches templates with no placeholders exactly", () => {
    const c = compileTemplates({ k: "Not found." });
    expect(matchTemplate(c, "Not found.")?.key).toBe("k");
    expect(matchTemplate(c, "Not found.x")).toBeUndefined();
  });
});
