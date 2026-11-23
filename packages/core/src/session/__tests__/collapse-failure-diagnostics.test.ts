/**
 * LIFECYCLE-14 — the error a failed collapse records on the session (and that
 * `GET /session/:id` now returns) is the cause, not a driver dump.
 *
 * A Drizzle query error's message is the full statement plus its parameters —
 * extracted statements included — with the actual reason ("injected strategy
 * failure", "unique violation", …) only in `.cause`.
 */
import { describe, it, expect } from "vitest";
import { createCore } from "../../cognitive/index.js";
import { auth, makeHarness, reply } from "./collapse-fixture.js";

describe("collapse failure diagnostics", () => {
  it("records the innermost cause, bounded", async () => {
    const h = makeHarness({
      replies: [reply({ strategies: [{ trigger: "t", action: "a" }] })],
    });
    h.storage.createStrategy.mockRejectedValueOnce(
      Object.assign(
        new Error('Failed query: insert into "mnemosyne"."mnemo_strategy" … params: secret text'),
        { cause: new Error("injected strategy failure") }
      )
    );
    const { config: _config, ...deps } = h.ctx as unknown as Record<string, unknown>;
    const core = createCore(deps as never);

    await expect(
      core.collapseSession({ sessionId: "s1", workspaceId: "ws", strategy: "explicit" }, auth)
    ).rejects.toThrow();

    expect(h.storage.recordCollapseFailure).toHaveBeenCalledWith(
      "s1",
      "ws",
      "injected strategy failure"
    );
  });
  it("does not charge a late-append snapshot conflict to the model failure budget", async () => {
    const h = makeHarness({
      replies: [reply({ facts: [{ content: "a durable finding" }] })],
      atomic: true,
    });
    h.storage.commitSessionCollapse!.mockRejectedValueOnce(
      Object.assign(new Error("snapshot changed"), { code: "SESSION_SNAPSHOT_CHANGED" })
    );
    const { config: _config, ...deps } = h.ctx as unknown as Record<string, unknown>;
    const core = createCore(deps as never);
    await expect(
      core.collapseSession({ sessionId: "s1", workspaceId: "ws", strategy: "explicit" }, auth)
    ).rejects.toMatchObject({ code: "SESSION_SNAPSHOT_CHANGED" });
    expect(h.storage.recordCollapseFailure).not.toHaveBeenCalled();
  });
});
