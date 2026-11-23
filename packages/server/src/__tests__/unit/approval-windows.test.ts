/**
 * Final review I6: after APP-007 made expiry real, an approval request died
 * 15 minutes after it was raised — the human's decision and the requester's
 * retry both had to fit in that window. A pending request now waits 24 h for
 * a decision, and an approval can be used for 1 h from the moment it is
 * granted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import { APPROVAL_PENDING_TTL_MS, APPROVAL_USE_TTL_MS } from "@mnemo-ai/types";

const WS = "11111111-1111-4111-8111-111111111111";
const by = { requestedBy: "user-a", method: "DELETE", path: "/facts/f1" };

afterEach(() => vi.useRealTimers());

describe("approval windows", () => {
  it("are a day to decide and an hour to use", () => {
    expect(APPROVAL_PENDING_TTL_MS).toBe(24 * 60 * 60_000);
    expect(APPROVAL_USE_TTL_MS).toBe(60 * 60_000);
  });

  it("an approval given 30 minutes later is usable for an hour from then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    const store = new InMemoryApprovalStore();
    const ar = await store.create({
      workspaceId: WS,
      requestedBy: by.requestedBy,
      trigger: "delete_fact",
      resource: "facts",
      payload: { method: by.method, path: by.path },
      expiresAt: new Date(Date.now() + APPROVAL_PENDING_TTL_MS), // determinism-ok: Date is faked in this test
    });
    vi.setSystemTime(new Date("2026-11-22T10:30:00Z"));
    expect(await store.resolve(WS, ar.id, "approved", "user-b")).toBe(true);
    expect((await store.get(WS, ar.id))!.expiresAt.toISOString()).toBe("2026-11-22T11:30:00.000Z");
    vi.setSystemTime(new Date("2026-11-22T11:31:00Z"));
    expect(await store.consume(WS, ar.id, by)).toBe(false);
  });
});
