import { describe, it, expect } from "vitest";
import { InMemoryBreakGlassStore } from "../testing/InMemoryBreakGlassStore.js";

const WS = "11111111-1111-1111-1111-111111111111";

function future(_ms = 15 * 60_000): Date {
  return new Date("2099-01-01T00:00:00Z");
}

describe("InMemoryBreakGlassStore", () => {
  it("request() creates a pending request", async () => {
    const s = new InMemoryBreakGlassStore();
    const r = await s.request({
      workspaceId: WS,
      requestedBy: "admin-A",
      reason: "incident-123 tenant data export",
      requestedScopes: ["memory:export"],
      expiresAt: future(),
    });
    expect(r.status).toBe("pending");
    expect(r.requestedBy).toBe("admin-A");
    expect(r.approvedBy).toBeUndefined();
  });

  it("approve() by a DIFFERENT admin marks it approved", async () => {
    const s = new InMemoryBreakGlassStore();
    const r = await s.request({
      workspaceId: WS, requestedBy: "admin-A", reason: "x",
      requestedScopes: ["memory:export"], expiresAt: future(),
    });
    await s.approve(WS, r.id, "admin-B");
    const got = await s.get(WS, r.id);
    expect(got?.status).toBe("approved");
    expect(got?.approvedBy).toBe("admin-B");
    expect(got?.approvedAt).toBeInstanceOf(Date);
  });

  it("approve() by the SAME admin (self-approval) throws", async () => {
    const s = new InMemoryBreakGlassStore();
    const r = await s.request({
      workspaceId: WS, requestedBy: "admin-A", reason: "x",
      requestedScopes: ["memory:export"], expiresAt: future(),
    });
    await expect(s.approve(WS, r.id, "admin-A")).rejects.toThrow(/self-approve/i);
    const got = await s.get(WS, r.id);
    expect(got?.status).toBe("pending");
  });

  it("getActiveApproved() returns an approved, unexpired, unused grant; null otherwise", async () => {
    const s = new InMemoryBreakGlassStore();
    expect(await s.getActiveApproved(WS, "admin-A")).toBeNull();
    const r = await s.request({
      workspaceId: WS, requestedBy: "admin-A", reason: "x",
      requestedScopes: ["memory:export"], expiresAt: future(),
    });
    expect(await s.getActiveApproved(WS, "admin-A")).toBeNull(); // pending, not approved
    await s.approve(WS, r.id, "admin-B");
    const active = await s.getActiveApproved(WS, "admin-A");
    expect(active?.id).toBe(r.id);
  });

  it("getActiveApproved() returns null for an expired approved grant", async () => {
    const s = new InMemoryBreakGlassStore();
    const r = await s.request({
      workspaceId: WS, requestedBy: "admin-A", reason: "x",
      requestedScopes: ["memory:export"], expiresAt: new Date("2025-12-01T00:00:00Z"),
    });
    await s.approve(WS, r.id, "admin-B");
    expect(await s.getActiveApproved(WS, "admin-A")).toBeNull();
  });

  it("markUsed() consumes the grant (single-use)", async () => {
    const s = new InMemoryBreakGlassStore();
    const r = await s.request({
      workspaceId: WS, requestedBy: "admin-A", reason: "x",
      requestedScopes: ["memory:export"], expiresAt: future(),
    });
    await s.approve(WS, r.id, "admin-B");
    await s.markUsed(WS, r.id);
    expect(await s.getActiveApproved(WS, "admin-A")).toBeNull();
    const got = await s.get(WS, r.id);
    expect(got?.status).toBe("used");
    expect(got?.usedAt).toBeInstanceOf(Date);
  });
});
