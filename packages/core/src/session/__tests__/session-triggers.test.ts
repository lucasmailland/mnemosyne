import { describe, it, expect } from "vitest";
import { resolveCollapseReason } from "../collapse.js";

describe("resolveCollapseReason (spec §7 triggers)", () => {
  const policy = { maxTurns: 50, maxTokens: 8192, inactivityTimeout: 1800 };

  it("max_turns when turnCount >= maxTurns", () => {
    expect(resolveCollapseReason({ turnCount: 50, tokenCount: 10, ageSeconds: 0 }, policy)).toBe("max_turns");
  });
  it("max_tokens when tokenCount >= maxTokens (and turns under limit)", () => {
    expect(resolveCollapseReason({ turnCount: 3, tokenCount: 8192, ageSeconds: 0 }, policy)).toBe("max_tokens");
  });
  it("inactivity when age exceeds inactivityTimeout", () => {
    expect(resolveCollapseReason({ turnCount: 3, tokenCount: 10, ageSeconds: 1801 }, policy)).toBe("inactivity");
  });
  it("null when no trigger fires", () => {
    expect(resolveCollapseReason({ turnCount: 3, tokenCount: 10, ageSeconds: 10 }, policy)).toBeNull();
  });
  it("turn limit takes precedence over token limit", () => {
    expect(resolveCollapseReason({ turnCount: 50, tokenCount: 8192, ageSeconds: 0 }, policy)).toBe("max_turns");
  });
});
