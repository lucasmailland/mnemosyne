/**
 * Unit tests for GDPR hard-delete path in forget.ts (Wave X2.5).
 *
 * Tests verify:
 *   - Hard mode requires memory:hard_delete scope (not memory:delete)
 *   - memory:delete scope is insufficient for hard delete
 *   - GDPR sequence: hardDeleteFact → appendDeletionLog → destroyActorDek
 *   - DEK destruction is FATAL: throws on missing impl, exception, or false return
 *   - Outbox (vector_delete + cache_bust) and terminal audit entry are written
 *   - Soft mode: still works with memory:delete, does NOT call hardDeleteFact
 */

import { describe, it, expect, vi } from "vitest";
import { forget } from "../forget.js";
import type { AuthContext } from "@mnemo-ai/types";

const WS = "ws-gdpr-test";
const ACTOR = "agent-gdpr";

// ── Minimal fake context ───────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}) {
  const appendOutbox = vi.fn().mockResolvedValue(undefined);
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const archiveFact = vi.fn().mockResolvedValue(undefined);
  const hardDeleteFact = vi
    .fn()
    .mockResolvedValue({ createdAt: new Date("2026-11-01T09:00:00.000Z") });
  const appendDeletionLog = vi.fn().mockResolvedValue(undefined);
  const destroyActorDek = vi.fn().mockResolvedValue(true);
  const destroyUserDeks = vi.fn().mockResolvedValue(1);
  const archiveDecision = vi.fn().mockResolvedValue(undefined);

  return {
    ctx: {
      storage: {
        appendOutbox,
        appendAuditEntry,
        archiveFact,
        hardDeleteFact,
        appendDeletionLog,
        destroyActorDek,
        destroyUserDeks,
        archiveDecision,
        archiveEpisode: vi.fn().mockResolvedValue(undefined),
        archiveEntity: vi.fn().mockResolvedValue(undefined),
        archiveStrategy: vi.fn().mockResolvedValue(undefined),
        archiveWorkflow: vi.fn().mockResolvedValue(undefined),
        archiveSkill: vi.fn().mockResolvedValue(undefined),
        archiveTask: vi.fn().mockResolvedValue(undefined),
        archiveEvent: vi.fn().mockResolvedValue(undefined),
        archiveReasoning: vi.fn().mockResolvedValue(undefined),
        archiveHyperedge: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      },
      telemetry: { startSpan: () => ({ end: vi.fn() }) },
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    mocks: {
      appendOutbox,
      appendAuditEntry,
      archiveFact,
      hardDeleteFact,
      appendDeletionLog,
      destroyActorDek,
      destroyUserDeks,
      archiveDecision,
    },
  };
}

function auth(scopes: string[], userId?: string): AuthContext {
  return {
    workspaceId: WS,
    actorId: ACTOR,
    actorType: "agent",
    scopes: scopes as never,
    ...(userId !== undefined ? { userId } : {}),
  };
}

// ── Scope gate ─────────────────────────────────────────────────────────────────

describe("forget — hard mode scope gate", () => {
  it("throws FORBIDDEN when caller has no scopes at all", async () => {
    const { ctx } = makeCtx();
    await expect(forget(ctx, "fact-1", "fact", "hard", auth([]))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN when caller has only memory:delete (soft scope)", async () => {
    const { ctx } = makeCtx();
    await expect(
      forget(ctx, "fact-1", "fact", "hard", auth(["memory:delete"]))
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("throws FORBIDDEN when caller has memory:write but not memory:hard_delete", async () => {
    const { ctx } = makeCtx();
    await expect(
      forget(ctx, "fact-1", "fact", "hard", auth(["memory:write", "memory:delete"]))
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

// ── GDPR sequence ─────────────────────────────────────────────────────────────

describe("forget — GDPR hard delete sequence", () => {
  it("calls hardDeleteFact for fact kind", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.hardDeleteFact).toHaveBeenCalledWith("fact-42", WS);
  });

  it("calls appendDeletionLog with gdpr_erasure type", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.appendDeletionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        deletedItemId: "fact-42",
        deletedItemType: "fact",
        deletionType: "gdpr_erasure",
        actorId: ACTOR,
        // 0068: federation serves the erasure as a tombstone only with it.
        itemCreatedAt: new Date("2026-11-01T09:00:00.000Z"),
      })
    );
  });

  it("calls destroyActorDek to crypto-erase actor's DEK", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.destroyActorDek).toHaveBeenCalledWith(WS, ACTOR);
  });

  it("enqueues vector_delete and cache_bust outbox events", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    const calls = mocks.appendOutbox.mock.calls.map(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType
    );
    expect(calls).toContain("vector_delete");
    expect(calls).toContain("cache_bust");
  });

  it("appends terminal audit entry with action=hard_delete", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "hard_delete",
        isTerminal: true,
        resourceId: "fact-42",
        // §6: the agent origin from the auth context must be threaded through,
        // not collapsed to 'user'.
        actorType: "agent",
      })
    );
  });

  it("does NOT call archiveFact for fact kind (physical delete, not soft archive)", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.archiveFact).not.toHaveBeenCalled();
  });

  it("calls archiveDecision (not hardDeleteFact) for decision kind", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "decision-7", "decision", "hard", auth(["memory:hard_delete"]));
    expect(mocks.hardDeleteFact).not.toHaveBeenCalled();
    expect(mocks.archiveDecision).toHaveBeenCalledWith("decision-7", WS);
  });
});

// ── Person-scoped DEK destruction ────────────────────────────────────────────
//
// When a real platform user is bound to the calling key, self-erasure must
// destroy EVERY DEK that person has accrued across every actor_id/key
// they've used — not just this one credential's. Before this, a person
// holding two API keys who called GDPR hard-delete only ever got ONE of
// their two DEKs destroyed, silently leaving the other recoverable.

describe("forget — person-scoped erasure (destroyUserDeks) when a real user is bound", () => {
  const USER_ID = "user-multi-key-42";

  it("calls destroyUserDeks(workspaceId, userId) instead of destroyActorDek when auth.userId is present", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID));
    expect(mocks.destroyUserDeks).toHaveBeenCalledWith(WS, USER_ID);
    expect(mocks.destroyActorDek).not.toHaveBeenCalled();
  });

  it("completes normally when destroyUserDeks destroys multiple DEKs (multi-key person)", async () => {
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: vi.fn().mockResolvedValue(2),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).resolves.toBeUndefined();
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_FAILED and aborts when destroyUserDeks throws", async () => {
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: vi.fn().mockRejectedValue(new Error("KMS unavailable")),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_FAILED" });
    // erasure_initiated was already recorded before the fatal DEK failure...
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    // ...but the terminal audit entry must NOT have been written
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_NOOP and aborts when destroyUserDeks returns 0 AND the legacy actor-keyed fallback also finds nothing", async () => {
    // makeCtx's returned `mocks.destroyActorDek` is the pre-override default —
    // capture the override itself to assert on the mock actually wired in.
    const destroyActorDekOverride = vi.fn().mockResolvedValue(false);
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: vi.fn().mockResolvedValue(0),
      destroyActorDek: destroyActorDekOverride,
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_NOOP" });
    expect(destroyActorDekOverride).toHaveBeenCalledWith(WS, ACTOR);
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    // Terminal audit entry must NOT have been written
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  // SEC regression: migration 0024 stamps user_id only on NEWLY provisioned
  // DEKs (no backfill of existing rows — see that migration's comments). A
  // person whose only DEK predates the migration has user_id=null on it, so
  // destroyUserDeks legitimately finds zero rows; without falling back to
  // the actor-keyed path, GDPR erasure would hard-fail for exactly the
  // legacy-DEK case the migration promises is still covered.
  it("falls back to destroyActorDek and succeeds when destroyUserDeks finds nothing but a legacy actor-keyed DEK exists", async () => {
    const destroyUserDeksOverride = vi.fn().mockResolvedValue(0);
    const destroyActorDekOverride = vi.fn().mockResolvedValue(true);
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: destroyUserDeksOverride,
      destroyActorDek: destroyActorDekOverride,
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).resolves.toBeUndefined();
    expect(destroyUserDeksOverride).toHaveBeenCalledWith(WS, USER_ID);
    expect(destroyActorDekOverride).toHaveBeenCalledWith(WS, ACTOR);
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_FAILED (not NOOP) when the legacy fallback itself throws", async () => {
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: vi.fn().mockResolvedValue(0),
      destroyActorDek: vi.fn().mockRejectedValue(new Error("KMS unavailable")),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_FAILED" });
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_UNSUPPORTED and aborts when destroyUserDeks is absent on adapter", async () => {
    const { ctx, mocks } = makeCtx({
      destroyUserDeks: undefined,
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"], USER_ID))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_UNSUPPORTED" });
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("falls back to destroyActorDek exactly as before when auth.userId is absent (service/agent-only key)", async () => {
    const { ctx, mocks } = makeCtx();
    // No userId passed to auth() — this is the existing, unchanged path.
    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));
    expect(mocks.destroyActorDek).toHaveBeenCalledWith(WS, ACTOR);
    expect(mocks.destroyUserDeks).not.toHaveBeenCalled();
  });
});

// ── DEK destruction is FATAL (SEC-3) ─────────────────────────────────────────
//
// Spec SECURITY.md §8: crypto-erasure is the erasure. Any failure in step 3
// must abort the sequence before the terminal audit entry is written.
//
// NOTE (P50 erasure_initiated): a non-terminal `erasure_initiated` entry is
// now recorded at the very top of the hard-delete branch, before step 1
// (hardDeleteFact) and therefore before DEK destruction too. So in every
// fatal-DEK-failure scenario below, appendAuditEntry IS called exactly once
// (erasure_initiated) even though the sequence aborts — only the TERMINAL
// hard_delete entry must never be written on a fatal path.

describe("forget — DEK destruction is fatal (SEC-3)", () => {
  it("throws DEK_DESTROY_FAILED and aborts when destroyActorDek throws", async () => {
    const { ctx, mocks } = makeCtx({
      destroyActorDek: vi.fn().mockRejectedValue(new Error("KMS unavailable")),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_FAILED" });
    // erasure_initiated was already recorded before the fatal DEK failure...
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    // ...but the terminal audit entry must NOT have been written
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_NOOP and aborts when destroyActorDek returns false", async () => {
    const { ctx, mocks } = makeCtx({
      destroyActorDek: vi.fn().mockResolvedValue(false),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_NOOP" });
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    // Terminal audit entry must NOT have been written
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("throws DEK_DESTROY_UNSUPPORTED and aborts when destroyActorDek is absent on adapter", async () => {
    const { ctx, mocks } = makeCtx({
      destroyActorDek: undefined,
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]))
    ).rejects.toMatchObject({ code: "DEK_DESTROY_UNSUPPORTED" });
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "erasure_initiated", isTerminal: false })
    );
    // Terminal audit entry must NOT have been written
    expect(mocks.appendAuditEntry).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });

  it("completes normally when destroyActorDek returns true", async () => {
    const { ctx, mocks } = makeCtx({
      destroyActorDek: vi.fn().mockResolvedValue(true),
    });
    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]))
    ).resolves.toBeUndefined();
    // Terminal audit entry must have been written
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "hard_delete", isTerminal: true })
    );
  });
});

// ── erasure_initiated (P50 audit-log-emitters, D4) ───────────────────────────
//
// A non-terminal `erasure_initiated` entry must be recorded at the TOP of the
// hard-delete branch — after the memory:hard_delete scope check, but BEFORE
// step 1 (hardDeleteFact) and therefore before DEK destruction too. The point
// of an "initiated" record is that it survives a crash mid-erasure; recording
// it unguarded (no try/catch swallow) means a failed audit write aborts
// erasure while it is still reversible, rather than letting destructive steps
// proceed with no forensic trail.

describe("forget — erasure_initiated (non-terminal, precedes destructive steps)", () => {
  it("appends erasure_initiated with isTerminal:false, gdprErasure detail, before hardDeleteFact/DEK destroy", async () => {
    const order: string[] = [];
    const appendAuditEntry = vi.fn().mockImplementation(async (entry: { action: string }) => {
      order.push(`audit:${entry.action}`);
    });
    const hardDeleteFact = vi.fn().mockImplementation(async () => {
      order.push("hardDeleteFact");
    });
    const destroyActorDek = vi.fn().mockImplementation(async () => {
      order.push("destroyActorDek");
      return true;
    });
    const { ctx } = makeCtx({ appendAuditEntry, hardDeleteFact, destroyActorDek });

    await forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]));

    // Call order: erasure_initiated -> hardDeleteFact -> destroyActorDek -> hard_delete
    expect(order).toEqual([
      "audit:erasure_initiated",
      "hardDeleteFact",
      "destroyActorDek",
      "audit:hard_delete",
    ]);
    expect(appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorType: "agent",
        actorId: ACTOR,
        action: "erasure_initiated",
        resourceKind: "fact",
        resourceId: "fact-42",
        isTerminal: false,
        detail: expect.objectContaining({ gdprErasure: true }),
      })
    );
  });

  it("does NOT call hardDeleteFact or destroyActorDek when appendAuditEntry(erasure_initiated) rejects", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("audit store unavailable"));
    const { ctx, mocks } = makeCtx({ appendAuditEntry });

    await expect(
      forget(ctx, "fact-42", "fact", "hard", auth(["memory:hard_delete"]))
    ).rejects.toThrow("audit store unavailable");

    // Unguarded await: a failed erasure_initiated write must abort BEFORE any
    // destructive step, keeping erasure reversible.
    expect(mocks.hardDeleteFact).not.toHaveBeenCalled();
    expect(mocks.destroyActorDek).not.toHaveBeenCalled();
    expect(mocks.appendDeletionLog).not.toHaveBeenCalled();
  });
});

// ── Soft mode ──────────────────────────────────────────────────────────────────

describe("forget — soft mode", () => {
  it("does NOT require memory:hard_delete scope", async () => {
    const { ctx } = makeCtx();
    // memory:delete is sufficient for soft
    await expect(
      forget(ctx, "fact-1", "fact", "soft", auth(["memory:delete"]))
    ).resolves.toBeUndefined();
  });

  it("calls archiveFact (soft close) for soft mode", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-1", "fact", "soft", auth(["memory:delete"]));
    expect(mocks.archiveFact).toHaveBeenCalledWith("fact-1", WS);
  });

  it("does NOT call hardDeleteFact or appendDeletionLog in soft mode", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-1", "fact", "soft", auth(["memory:delete"]));
    expect(mocks.hardDeleteFact).not.toHaveBeenCalled();
    expect(mocks.appendDeletionLog).not.toHaveBeenCalled();
  });

  it("appends non-terminal audit entry with action=delete", async () => {
    const { ctx, mocks } = makeCtx();
    await forget(ctx, "fact-1", "fact", "soft", auth(["memory:delete"]));
    expect(mocks.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        isTerminal: false,
        actorType: "agent",
      })
    );
  });
});
