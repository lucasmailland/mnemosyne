import { describe, expect, it } from "vitest";

import { formatDate, formatNumber, formatRelative, resolveLocale, translate } from "../core";
import type { MessageKey, Messages } from "../core";
import { errorMessage } from "../errors";
import { failureMessage } from "@/components/form-bits";
import { en } from "../messages/en";
import { es } from "../messages/es";

describe("resolveLocale", () => {
  it.each([
    [undefined, "es-AR,es;q=0.9,en;q=0.8", "es-419"],
    [undefined, "pt-BR,pt;q=0.9", "en-US"],
    [undefined, "*", "en-US"],
    [undefined, "en-GB", "en-US"],
    [undefined, "", "en-US"],
    ["es-419", "en-US", "es-419"],
    ["fr", "es", "es-419"],
    ["", null, "en-US"],
    [undefined, "en;q=0.5,es;q=0.9", "es-419"],
  ])("resolveLocale(%s, %s) is %s", (c, h, out) => expect(resolveLocale(c, h)).toBe(out));
});

describe("translate", () => {
  it("interpolates and leaves unknown variables visible", () => {
    const m = { a: { hi: "Hi, {name}." } } as unknown as Messages;
    expect(translate(m, "a.hi" as MessageKey, { name: "Lucas" })).toBe("Hi, Lucas.");
    expect(translate(m, "a.hi" as MessageKey, {})).toBe("Hi, {name}.");
  });
  it("picks plural branches and falls back to other", () => {
    const m = {
      a: { n: { one: "{count} memory", other: "{count} memories" } },
    } as unknown as Messages;
    expect(translate(m, "a.n" as MessageKey, { count: 1 }, "en-US")).toBe("1 memory");
    expect(translate(m, "a.n" as MessageKey, { count: 3 }, "en-US")).toBe("3 memories");
    expect(translate(m, "a.n" as MessageKey, {}, "en-US")).toBe("{count} memories");
  });
  it("a Spanish million selects `many` and falls back to other when the message has none", () => {
    const m = {
      a: { n: { one: "{count} recuerdo", other: "{count} recuerdos" } },
    } as unknown as Messages;
    expect(new Intl.PluralRules("es-419").select(1_000_000)).toBe("many");
    expect(translate(m, "a.n" as MessageKey, { count: 1_000_000 }, "es-419")).toBe(
      "1,000,000 recuerdos"
    );
  });
});

describe("formatting", () => {
  it("formats per locale", () => {
    expect(formatNumber("en-US", 12483.5)).toBe("12,483.5");
    expect(formatNumber("es-419", 12483.5)).toBe("12,483.5");
    expect(formatDate("es-419", new Date(Date.UTC(2026, 10, 14, 12)), "long")).toBe(
      "14 de noviembre de 2026"
    );
    expect(formatDate("en-US", "2026-11-14T12:00:00Z", "long")).toBe("November 14, 2026");
  });
  it("formats relative time", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    expect(formatRelative("en-US", new Date("2026-11-14T10:00:00Z"), now)).toBe("2 hours ago");
    expect(formatRelative("es-419", new Date("2026-11-13T12:00:00Z"), now)).toBe("ayer");
  });
  it("rounds up into the next unit at a boundary, never '60 minutes ago'", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const ago = (s: number) => formatRelative("en-US", new Date(now.getTime() - s * 1000), now);
    expect(ago(59.6)).toBe("1 minute ago");
    expect(ago(3599)).toBe("1 hour ago");
    expect(ago(3569)).toBe("59 minutes ago");
    expect(ago(86399)).toBe("yesterday");
    expect(ago(23 * 3600)).toBe("23 hours ago");
    expect(ago(29.6 * 86400)).toBe("last month");
    expect(ago(346 * 86400)).toBe("last year");
    expect(ago(30)).toBe("30 seconds ago");
  });
});

describe("errorMessage", () => {
  const t = (k: MessageKey) => translate(en as unknown as Messages, k);
  it("maps statuses and falls back to generic plus the status", () => {
    expect(errorMessage(t, { status: 401 })).toBe(en.errors.unauthorized);
    expect(errorMessage(t, { status: 503 })).toBe(en.errors.unavailable);
    expect(errorMessage(t, { code: "network" })).toBe(en.errors.network);
    expect(errorMessage(t, { status: 418 })).toBe(`${en.errors.generic} (418)`);
    expect(errorMessage(t, { code: "weird" })).toBe(`${en.errors.generic} (weird)`);
  });
  it.each([
    [403, en.errors.forbidden],
    [404, en.errors.notFound],
    [409, en.errors.conflict],
    [429, en.errors.rateLimited],
  ])("maps %s to its own message", (status, text) => {
    expect(errorMessage(t, { status })).toBe(text);
  });
  it("an empty code is no detail: the generic message alone", () => {
    expect(errorMessage(t, { code: "" })).toBe(en.errors.generic);
  });
});

describe("dictionaries", () => {
  it("es has the same keys as en", () => {
    const keys = (o: object, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "object" && !("one" in v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]
      );
    expect(keys(es)).toEqual(keys(en));
  });
});

describe("formatters with unparsable dates", () => {
  it("return an empty string instead of throwing", () => {
    expect(formatDate("en-US", "not a date", "long")).toBe("");
    expect(formatRelative("en-US", "not a date")).toBe("");
  });
});

describe("formatDate datetime", () => {
  it("adds 24-hour UTC time marked as UTC", () => {
    const en = formatDate("en-US", "2026-11-14T18:04:00Z", "datetime");
    const es = formatDate("es-419", "2026-11-14T18:04:00Z", "datetime");
    expect(en).toContain("18:04");
    expect(en).toContain("UTC");
    expect(es).toContain("18:04");
    expect(es).toContain("UTC");
    expect(formatDate("en-US", "nope", "datetime")).toBe("");
  });
});

describe("translate count grouping", () => {
  const m = { n: { one: "{count} item", other: "{count} items" } } as unknown as Messages;
  it("groups the count but still selects the plural by the raw number", () => {
    expect(translate(m, "n" as MessageKey, { count: 1234 }, "en-US")).toBe("1,234 items");
    expect(translate(m, "n" as MessageKey, { count: 1234 }, "es-419")).toBe(
      `${formatNumber("es-419", 1234)} items`
    );
    expect(translate(m, "n" as MessageKey, { count: 1 }, "en-US")).toBe("1 item");
  });
});

describe("untrusted input never reaches Object's own properties", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "Accept-Language %s resolves to en-US",
    (header) => expect(resolveLocale(undefined, header)).toBe("en-US")
  );
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(en, key, vars);
  it("an error code named like an Object property gets the generic message", () => {
    expect(errorMessage(t, { code: "constructor" })).toBe("Something went wrong. (constructor)");
    expect(errorMessage(t, { code: "__proto__" })).toBe("Something went wrong. (__proto__)");
  });
  it("a server code named like an Object property falls back to the HTTP status", async () => {
    const res = new Response(JSON.stringify({ error: "constructor" }), { status: 400 });
    expect(await failureMessage(t, res, {})).toBe("Something went wrong (HTTP 400).");
  });
  it("placeholders named like Object properties stay visible", () => {
    const m = { a: { x: "Hi {toString} {constructor}" } } as unknown as Messages;
    expect(translate(m, "a.x" as MessageKey, {})).toBe("Hi {toString} {constructor}");
  });
  it("a key path through Object's properties is not a message", () => {
    expect(translate(en, "browser.kind.constructor" as MessageKey)).toBe(
      "browser.kind.constructor"
    );
    expect(translate(en, "browser.kind.__proto__" as MessageKey)).toBe("browser.kind.__proto__");
  });
});
