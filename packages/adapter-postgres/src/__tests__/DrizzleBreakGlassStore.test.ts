import { describe, it, expect, vi } from "vitest";
import { DrizzleBreakGlassStore } from "../DrizzleBreakGlassStore.js";
import type { DrizzleClient } from "../DrizzleStorageAdapter.js";

const WS = "22222222-2222-2222-2222-222222222222";

/**
 * Stringify a drizzle `sql\`...\`` template object by reading its queryChunks
 * (which are an interleaving of raw string parts and parameter wrappers). We
 * only need the literal text to identify which statement the adapter is
 * issuing (SELECT vs UPDATE vs INSERT), so concatenating the string chunks is
 * sufficient. This avoids reaching into private postgres-js internals while
 * still exercising the real adapter logic.
 */
function sqlAsText(q: unknown): string {
  const chunks =
    (q as { queryChunks?: Array<{ value?: unknown[] }> }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown[] }).value;
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0] as string;
      return "";
    })
    .join(" ");
}

function fakeDb(getRow: Record<string, unknown> | null): DrizzleClient {
  const tx = {
    execute: vi.fn(async (q: unknown) => {
      const text = sqlAsText(q);
      if (text.includes("SELECT") && text.includes("mnemo_break_glass_request")) {
        return { rows: getRow ? [getRow] : [] };
      }
      return { rows: [] };
    }),
  };
  return {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DrizzleClient;
}

describe("DrizzleBreakGlassStore.approve — two-person rule", () => {
  it("throws when approver equals the requester (self-approval)", async () => {
    const row = {
      id: "bg-1", workspace_id: WS, requested_by: "admin-A", reason: "x",
      requested_scopes: ["memory:export"], status: "pending",
      approved_by: null, approved_at: null, used_at: null,
      expires_at: new Date("2099-01-01T00:00:00Z").toISOString(),
      created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
    };
    const store = new DrizzleBreakGlassStore(fakeDb(row));
    await expect(store.approve(WS, "bg-1", "admin-A")).rejects.toThrow(/self-approve/i);
  });

  it("does not throw when approver differs from the requester", async () => {
    const row = {
      id: "bg-1", workspace_id: WS, requested_by: "admin-A", reason: "x",
      requested_scopes: ["memory:export"], status: "pending",
      approved_by: null, approved_at: null, used_at: null,
      expires_at: new Date("2099-01-01T00:00:00Z").toISOString(),
      created_at: new Date("2026-01-01T00:00:00Z").toISOString(),
    };
    const store = new DrizzleBreakGlassStore(fakeDb(row));
    await expect(store.approve(WS, "bg-1", "admin-B")).resolves.toBeUndefined();
  });
});
