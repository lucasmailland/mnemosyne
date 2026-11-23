import { describe, it, expect } from "vitest";
import { WorkingMemory } from "../session/working-memory.js";

// flatten-legacy-dual-core Phase 7: previously constructed via the legacy
// `CoreLike.{workSet,workGet,rateLimitIncr,bloomAdd,bloomCheck,workCheckpoint}`
// passthroughs (`factory.ts`'s `createCore()`, deleted this Phase). Those were
// thin forwarding calls onto a `WorkingMemory` instance — same class
// `@mnemo-ai/server`'s `index.ts` constructs directly (`new WorkingMemory(...)`).
// Rewritten to construct `WorkingMemory` directly (`cache: null` — the same
// in-process fallback path the legacy factory core used when no Redis cache
// adapter was configured), zero behavior change.
describe("WorkingMemory in-process fallback", () => {
  const wm = () => new WorkingMemory(null);

  it("workSet then workGet round-trips through the in-process fallback", async () => {
    const core = wm();
    await core.workSet("ws1", "agent1", "currentFile", { path: "/a/b.ts" }, 120);
    const got = await core.workGet<{ path: string }>("ws1", "agent1", "currentFile");
    expect(got).toEqual({ path: "/a/b.ts" });
  });

  it("rateLimitIncr increments within the window", async () => {
    const core = wm();
    expect(await core.rateLimitIncr("ws1", "agent1", "recall", 60)).toBe(1);
    expect(await core.rateLimitIncr("ws1", "agent1", "recall", 60)).toBe(2);
  });

  it("bloomAdd then bloomCheck reports membership", async () => {
    const core = wm();
    await core.bloomAdd("ws1", "agent1", "seen", "doc-42");
    expect(await core.bloomCheck("ws1", "agent1", "seen", "doc-42")).toBe(true);
    expect(await core.bloomCheck("ws1", "agent1", "seen", "never")).toBe(false);
  });

  it("workCheckpoint stores snapshots with max TTL", async () => {
    const core = wm();
    const snapshot = { step: 3, results: [1, 2, 3] };
    await core.workCheckpoint("ws1", "agent1", "progress", snapshot);
    const got = await core.workGet<typeof snapshot>("ws1", "agent1", "ckpt:progress");
    expect(got).toEqual(snapshot);
  });
});
