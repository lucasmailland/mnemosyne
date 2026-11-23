/**
 * p50-audit-log-emitters — PR1 foundation.
 *
 * `emitAudit()` is the swallow-and-log wrapper every mechanical-batch route
 * emitter (PR2-6) will call instead of `deps.storage.appendAuditEntry(...)`
 * directly. Contract (design D1):
 *   - no-op when `deps.storage` is absent (server can boot without adapter-postgres)
 *   - awaits the write (ordering + testability — not a hot path)
 *   - swallows + logs a rejection; the caller's mutating request must not fail
 *     just because the audit write failed
 */
import { describe, it, expect, vi } from "vitest";
import type { AuditLogEntry } from "@mnemo-ai/types";
import type { ServerDeps } from "../deps.js";
import { emitAudit } from "../audit-emit.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000099";

function baseEntry(): Omit<AuditLogEntry, "id" | "createdAt"> {
  return {
    workspaceId: WORKSPACE_ID,
    actorType: "user",
    actorId: "key:test-key-id",
    action: "key_create",
    resourceKind: "api_key",
    resourceId: "key-123",
    isTerminal: false,
    detail: { label: "test key" },
  };
}

describe("emitAudit", () => {
  it("is a no-op when deps.storage is absent", async () => {
    const deps = {} as ServerDeps;

    await expect(emitAudit(deps, baseEntry())).resolves.toBeUndefined();
  });

  it("awaits appendAuditEntry with the exact entry when storage is present", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const deps = { storage: { appendAuditEntry } } as unknown as ServerDeps;
    const entry = baseEntry();

    await emitAudit(deps, entry);

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    expect(appendAuditEntry).toHaveBeenCalledWith(entry);
  });

  it("swallows a synchronously throwing or missing appendAuditEntry", async () => {
    const appendAuditEntry = vi.fn(() => {
      throw new Error("sync boom");
    });
    const throwing = { storage: { appendAuditEntry } } as unknown as ServerDeps;
    await expect(emitAudit(throwing, baseEntry())).resolves.toBeUndefined();
    const partial = { storage: {} } as unknown as ServerDeps;
    await expect(emitAudit(partial, baseEntry())).resolves.toBeUndefined();
  });

  it("swallows a rejecting appendAuditEntry; caller is unaffected", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("merkle lock timeout"));
    const deps = { storage: { appendAuditEntry } } as unknown as ServerDeps;

    // The promise returned by emitAudit must itself resolve (not reject) —
    // otherwise every caller would need its own try/catch, defeating the
    // point of the helper.
    await expect(emitAudit(deps, baseEntry())).resolves.toBeUndefined();
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("accepts a bare { storage } object — no full ServerDeps required (p52)", async () => {
    // emitAudit's declared param type is Pick<ServerDeps, "storage">, not
    // ServerDeps, so a caller with only a storage handle (e.g. auth.ts's
    // authenticateScoped(), which has no access to the rest of ServerDeps)
    // can call it without constructing/casting a full deps object.
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const narrowDeps: Pick<ServerDeps, "storage"> = {
      storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
    };

    await emitAudit(narrowDeps, baseEntry());

    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("logs the swallowed failure instead of silently dropping it", async () => {
    const { logger } = await import("../logging.js");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("merkle lock timeout"));
    const deps = { storage: { appendAuditEntry } } as unknown as ServerDeps;

    await emitAudit(deps, baseEntry());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, message] = warnSpy.mock.calls[0]!;
    expect(message).toBe("audit_emit.failed");
    expect(meta).toMatchObject({ action: "key_create", workspaceId: WORKSPACE_ID });

    warnSpy.mockRestore();
  });
});
