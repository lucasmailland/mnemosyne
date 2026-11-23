import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { encodeDelta } from "@mnemo-ai/types";

describe("delta-encoded episodes (spec §16)", () => {
  it("computes real depth across a 3-level chain", async () => {
    const s = new InMemoryStorageAdapter();
    const ws = "11111111-1111-1111-1111-111111111111";
    const root = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "ROOT", occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const child = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "", deltaContent: "DELTA1", parentEpisodeId: root.id, occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const grand = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "", deltaContent: "DELTA2", parentEpisodeId: child.id, occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);

    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
    expect(grand.depth).toBe(2);
  });

  it("legacy header-less deltaContent reconstructs by literal apply (back-compat)", async () => {
    // Rows written before WP5 store the full narrative in deltaContent; applyDelta
    // treats a header-less string as literal, so the leaf == its own deltaContent.
    const s = new InMemoryStorageAdapter();
    const ws = "11111111-1111-1111-1111-111111111111";
    const root = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "ROOT", occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const child = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "", deltaContent: "DELTA1", parentEpisodeId: root.id, occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const grand = await s.createEpisode({ workspaceId: ws, title: "T", narrative: "", deltaContent: "DELTA2", parentEpisodeId: child.id, occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const full = await s.reconstructEpisode(grand.id, ws);
    expect(full.narrative).toBe("DELTA2");
  });

  it("reconstructs a 3-level residual chain to the exact leaf narrative", async () => {
    const s = new InMemoryStorageAdapter();
    const ws = "11111111-1111-1111-1111-111111111111";

    const ROOT = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
    const CHILD = ["alpha", "beta", "GAMMA-2", "delta", "epsilon"].join("\n");
    const GRAND = ["alpha", "beta", "GAMMA-2", "delta", "EPSILON-3"].join("\n");

    const root = await s.createEpisode({ workspaceId: ws, title: "T", narrative: ROOT, occurredAt: new Date() /* determinism-ok: throwaway fixture date, not asserted */ } as any);
    const child = await s.createEpisode({
      workspaceId: ws, title: "T", narrative: "",
      deltaContent: encodeDelta(ROOT, CHILD), parentEpisodeId: root.id, occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    } as any);
    const grand = await s.createEpisode({
      workspaceId: ws, title: "T", narrative: "",
      deltaContent: encodeDelta(CHILD, GRAND), parentEpisodeId: child.id, occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    } as any);

    expect((await s.reconstructEpisode(child.id, ws)).narrative).toBe(CHILD);
    expect((await s.reconstructEpisode(grand.id, ws)).narrative).toBe(GRAND);
  });
});
