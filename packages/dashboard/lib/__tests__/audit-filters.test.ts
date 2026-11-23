import { describe, expect, it } from "vitest";
import { auditApiQuery, auditPageQuery, dayEnd, dayStart } from "../audit-filters";

describe("auditApiQuery", () => {
  it("sends UTC instants with Z and makes the picked end day inclusive", () => {
    const query = new URLSearchParams(auditApiQuery({ from: "2026-11-03", to: "2026-11-03" }));
    expect(query.get("from")).toBe("2026-11-03T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-11-03T23:59:59.999Z");
  });

  it("drops empty and malformed values, and trims the actor", () => {
    expect(auditApiQuery({ from: "yesterday", to: "2026-02-31", action: "", actor: "  " })).toBe(
      ""
    );
    const query = new URLSearchParams(auditApiQuery({ actor: " u1 ", action: "user_disabled" }));
    expect(query.get("actor")).toBe("u1");
    expect(query.get("action")).toBe("user_disabled");
  });

  it("passes the cursor through untouched", () => {
    expect(new URLSearchParams(auditApiQuery({ cursor: "abc_-" })).get("cursor")).toBe("abc_-");
  });
});

describe("dayStart and dayEnd", () => {
  it("bound a real day in UTC, inclusive at both ends, and drop anything else", () => {
    expect(dayStart("2026-11-03")).toBe("2026-11-03T00:00:00.000Z");
    expect(dayEnd("2026-11-03")).toBe("2026-11-03T23:59:59.999Z");
    for (const bad of [undefined, "", "nope", "2026-02-31"]) {
      expect(dayStart(bad)).toBeUndefined();
      expect(dayEnd(bad)).toBeUndefined();
    }
  });
});

describe("auditPageQuery", () => {
  it("keeps days as days and skips empty filters", () => {
    expect(auditPageQuery({ from: "2026-11-03", action: undefined, actor: "" })).toBe(
      "?from=2026-11-03"
    );
  });
});
