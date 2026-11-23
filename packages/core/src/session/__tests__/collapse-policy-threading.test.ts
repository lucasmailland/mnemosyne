import { describe, it, expect } from "vitest";
import { resolveCollapseReason, type CollapsePolicy } from "../collapse.js";

describe("CollapsePolicy threading (C6)", () => {
  it("resolveCollapseReason honours a per-agent maxTurns from policy", () => {
    const policy: CollapsePolicy = { maxTurns: 5, maxTokens: 999_999, inactivityTimeout: 999_999 };
    const reason = resolveCollapseReason(
      { turnCount: 5, tokenCount: 10, ageSeconds: 1 },
      { maxTurns: policy.maxTurns!, maxTokens: policy.maxTokens!, inactivityTimeout: policy.inactivityTimeout! },
    );
    expect(reason).toBe("max_turns");
  });

  it("a policy with a low maxTokens triggers max_tokens before defaults would", () => {
    const reason = resolveCollapseReason(
      { turnCount: 1, tokenCount: 100, ageSeconds: 1 },
      { maxTurns: 9999, maxTokens: 50, inactivityTimeout: 9999 },
    );
    expect(reason).toBe("max_tokens");
  });
});

describe("CollapsePolicy mode default (F2)", () => {
  it("the only valid mode values are auto|explicit|hybrid (never 'standard')", () => {
    const valid: Array<CollapsePolicy["mode"]> = ["auto", "explicit", "hybrid", undefined];
    // Type-level guard: assigning "standard" to mode must be impossible.
    // @ts-expect-error "standard" is not a member of the mode union
    const bad: CollapsePolicy = { mode: "standard" };
    expect(bad).toBeDefined(); // runtime no-op; the @ts-expect-error is the assertion
    expect(valid).toContain("auto");
  });
});
