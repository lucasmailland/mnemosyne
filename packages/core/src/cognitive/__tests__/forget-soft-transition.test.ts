/**
 * WP-5 — soft forget writes side effects only for a real transition.
 *
 * PRIM-3: `DELETE /forget/fact/:id` on an already-forgotten fact used to die
 * on the archive's primary key (500). The archive now reports `false` when it
 * closed nothing; `forget()` stays idempotent for the caller but must not
 * enqueue a second `vector_delete` or audit a delete that did not happen.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import { forget } from "../forget.js";

const WS = "ws-forget-transition";
const auth: AuthContext = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: null,
  scopes: ["memory:delete"],
} as AuthContext;

function makeCtx(archiveResult: boolean | undefined) {
  const storage = {
    getRecallPrimitives: vi.fn().mockResolvedValue([{ id: "f1", kind: "fact", value: {} }]),
    archiveFact: vi.fn().mockResolvedValue(archiveResult),
    appendOutbox: vi.fn().mockResolvedValue(undefined),
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };
  return {
    storage,
    ctx: {
      storage,
      telemetry: { startSpan: () => ({ end: vi.fn() }) },
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
  };
}

describe("soft forget — side effects follow the archive transition", () => {
  it("writes outbox and audit when the archive closed the fact", async () => {
    const { ctx, storage } = makeCtx(true);
    await forget(ctx, "f1", "fact", "soft", auth);
    expect(storage.appendOutbox).toHaveBeenCalled();
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", resourceId: "f1" })
    );
  });

  it("keeps the legacy behaviour for adapters that return void", async () => {
    const { ctx, storage } = makeCtx(undefined);
    await forget(ctx, "f1", "fact", "soft", auth);
    expect(storage.appendAuditEntry).toHaveBeenCalled();
  });

  it("resolves without side effects when the fact was already closed", async () => {
    const { ctx, storage } = makeCtx(false);
    await expect(forget(ctx, "f1", "fact", "soft", auth)).resolves.toBeUndefined();
    expect(storage.archiveFact).toHaveBeenCalledWith("f1", WS);
    expect(storage.appendOutbox).not.toHaveBeenCalled();
    expect(storage.appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("PRIM-10 — events cannot be forgotten", () => {
  it("refuses with EVENT_IMMUTABLE after the existence check, writing nothing", async () => {
    const { ctx, storage } = makeCtx(true);
    const archiveEvent = vi.fn().mockResolvedValue(undefined);
    (storage as Record<string, unknown>).archiveEvent = archiveEvent;
    storage.getRecallPrimitives.mockResolvedValue([{ id: "e1", kind: "event", value: {} }]);

    await expect(forget(ctx, "e1", "event", "soft", auth)).rejects.toMatchObject({
      code: "EVENT_IMMUTABLE",
    });
    expect(archiveEvent).not.toHaveBeenCalled();
    expect(storage.appendOutbox).not.toHaveBeenCalled();
    expect(storage.appendAuditEntry).not.toHaveBeenCalled();
  });

  it("still answers NOT_FOUND for an event that does not exist", async () => {
    const { ctx, storage } = makeCtx(true);
    storage.getRecallPrimitives.mockResolvedValue([]);
    await expect(forget(ctx, "missing", "event", "soft", auth)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
