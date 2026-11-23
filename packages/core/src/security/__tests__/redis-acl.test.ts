import { describe, it, expect } from "vitest";
import { workspaceAclRule, workspaceAclUsername } from "../redis-acl.js";

describe("redis ACL per workspace prefix (spec §5 Redis key isolation)", () => {
  it("derives a per-workspace username", () => {
    expect(workspaceAclUsername("ws-123")).toBe("ws_ws-123");
  });
  it("scopes the key pattern to the workspace prefix only", () => {
    const rule = workspaceAclRule("ws-123");
    expect(rule).toContain("~mnemo:ws-123:*");
    expect(rule).toContain("-@dangerous");
    expect(rule.some((t: string) => t.startsWith("~mnemo:other:"))).toBe(false);
  });
});
