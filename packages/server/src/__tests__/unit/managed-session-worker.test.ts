import { describe, expect, it, vi } from "vitest";
import type { AuthContext, ManagedCollapsePlan, MnemoSession, SessionTurn } from "@mnemo-ai/types";
import {
  runManagedSessionWorker,
  emitCollapseAttemptAudit,
  drainManagedCollapseEffects,
  createManagedEffectExecutor,
  createManagedWorkspaceRotation,
} from "../../managed-session-worker.js";
const session: MnemoSession = {
  id: "s",
  workspaceId: "ws",
  status: "collapse_pending",
  turnCount: 2,
  tokenCount: 10,
  openedAt: new Date("2026-09-01"),
  metadata: {},
  sourceHost: "codex",
  sourceGeneration: 0,
  collapseOperationId: "op",
  originActorId: "key:captured",
  originActorType: "agent",
  originUserId: "user-1",
  originSensitivityCeiling: "internal",
  sensitivity: "internal",
  collapseAttempts: 999,
};
const turns: SessionTurn[] = ["user", "assistant"].map((role, i) => ({
  id: `t${i}`,
  sessionId: "s",
  workspaceId: "ws",
  role: role as "user" | "assistant",
  content: "Visible",
  sourceMessageId: `m${i}`,
  turnIndex: i,
  createdAt: session.openedAt,
}));
const archive = {
  operationId: "op",
  workspaceId: "ws",
  sessionId: "s",
  generation: 0,
  status: "archive",
  reason: "empty_session",
  sourceMessageIds: [],
  sensitivity: "internal",
  provenance: {
    actorId: "key:captured",
    actorType: "agent",
    userId: "user-1",
    sensitivityCeiling: "internal",
  },
  postCommitEffects: [],
} as ManagedCollapsePlan;
function fixture() {
  const storage = {
    claimManagedSessions: vi.fn(async () => [
      { session, leaseOwner: "worker", leaseExpiresAt: new Date("2026-09-02") },
    ]),
    listManagedCollapseTurns: vi.fn(async () => turns),
    heartbeatManagedCollapseLease: vi.fn(async () => true),
    markManagedCollapseRetry: vi.fn(async () => ({
      attempts: 1000,
      nextAttemptAt: new Date("2026-09-02"),
    })),
    commitManagedCollapse: vi.fn(async () => ({
      status: "archived",
      sessionId: "s",
      operationId: "op",
      reason: "empty_session",
    })),
  };
  const prepare = vi.fn(async (_input: unknown, _auth: AuthContext) => archive);
  return {
    storage,
    prepare,
    options: {
      workspaceId: "ws",
      leaseOwner: "worker",
      leaseMs: 30_000,
      inactivityMs: 1_800_000,
      provisionalGraceMs: 5000,
      limit: 5,
    },
  };
}
describe("leased managed worker", () => {
  it("claims before preparation, preserves immutable enqueue auth and commits archive atomically", async () => {
    const { storage, prepare, options } = fixture();
    const order: string[] = [];
    storage.claimManagedSessions.mockImplementationOnce(async () => {
      order.push("claim");
      return [{ session, leaseOwner: "worker", leaseExpiresAt: new Date("2026-09-02") }];
    });
    prepare.mockImplementationOnce(async (_input, auth) => {
      order.push("prepare");
      expect(auth).toMatchObject({
        actorId: "key:captured",
        actorType: "agent",
        userId: "user-1",
        maxSensitivity: "internal",
      });
      return archive;
    });
    const result = await runManagedSessionWorker(options, { storage: storage as never, prepare });
    expect(order).toEqual(["claim", "prepare"]);
    expect(result).toMatchObject({ archived: 1, collapsed: 0, retryable: 0 });
    expect(storage.commitManagedCollapse).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op",
        generation: 0,
        leaseOwner: "worker",
        plan: archive,
      })
    );
  });
  it("never terminates on LLM failure regardless of attempt count", async () => {
    const { storage, prepare, options } = fixture();
    prepare.mockResolvedValueOnce({
      status: "retryable",
      reason: "llm_unavailable",
      operationId: "op",
      workspaceId: "ws",
      sessionId: "s",
      generation: 0,
      sourceMessageIds: [],
    });
    expect(
      await runManagedSessionWorker(options, { storage: storage as never, prepare })
    ).toMatchObject({ retryable: 1, archived: 0, collapsed: 0 });
    expect(storage.markManagedCollapseRetry).toHaveBeenCalledWith(
      expect.objectContaining({ error: "llm_unavailable", baseRetryMs: 1000, maxRetryMs: 300_000 })
    );
    expect(storage.commitManagedCollapse).not.toHaveBeenCalled();
  });
  it("a reclaimed lease prevents commit and every retry mutation by the stale owner", async () => {
    const { storage, prepare, options } = fixture();
    storage.heartbeatManagedCollapseLease.mockResolvedValue(false);
    const result = await runManagedSessionWorker(options, { storage: storage as never, prepare });
    expect(result.stale).toBe(1);
    expect(storage.commitManagedCollapse).not.toHaveBeenCalled();
    expect(storage.markManagedCollapseRetry).not.toHaveBeenCalled();
  });
  it("heartbeats long preparation and isolates storage errors without leaking content", async () => {
    vi.useFakeTimers();
    try {
      const { storage, prepare, options } = fixture();
      prepare.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 21_000));
        throw new Error("PRIVATE-TRANSCRIPT");
      });
      const pending = runManagedSessionWorker(options, { storage: storage as never, prepare });
      await vi.advanceTimersByTimeAsync(22_000);
      expect(await pending).toMatchObject({ retryable: 1 });
      expect(storage.heartbeatManagedCollapseLease.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(storage.markManagedCollapseRetry.mock.calls)).not.toContain(
        "PRIVATE-TRANSCRIPT"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("durable managed effects", () => {
  it("requires a stable idempotency key and never marks an unsuccessful external effect complete", async () => {
    const effect = {
      id: "effect-1",
      operationId: "op",
      workspaceId: "ws",
      effectKind: "session_buffer_cleanup",
      targetKind: "session",
      targetId: "s",
      payload: {},
      leaseOwner: "worker",
    };
    const storage = {
      claimManagedCollapseEffects: vi.fn(async () => [effect]),
      completeManagedCollapseEffect: vi.fn(async () => true),
      retryManagedCollapseEffect: vi.fn(async () => true),
    };
    const execute = vi.fn(async (_effect, _options) => {
      throw new Error("unavailable");
    });
    expect(
      await drainManagedCollapseEffects(
        { workspaceId: "ws", leaseOwner: "worker", limit: 5, leaseMs: 30_000 },
        { storage: storage as never, execute }
      )
    ).toMatchObject({ retryable: 1, completed: 0 });
    expect(execute).toHaveBeenCalledWith(effect, { idempotencyKey: "effect-1" });
    expect(storage.completeManagedCollapseEffect).not.toHaveBeenCalled();
    expect(storage.retryManagedCollapseEffect).toHaveBeenCalledOnce();
  });
});

it("fences a real first claim whose operation ID has not been persisted yet", async () => {
  const { storage, prepare, options } = fixture();
  storage.claimManagedSessions.mockResolvedValueOnce([
    {
      session: { ...session, collapseOperationId: null },
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-09-02"),
    },
  ]);
  prepare.mockResolvedValueOnce({ ...archive, operationId: "managed:ws:s:0" });
  await runManagedSessionWorker(options, { storage: storage as never, prepare });
  expect(storage.heartbeatManagedCollapseLease).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "managed:ws:s:0" })
  );
  expect(storage.commitManagedCollapse).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: "managed:ws:s:0" })
  );
});

describe("production effect executor", () => {
  it("does not acknowledge failed Redis cleanup and uses the durable promotion key", async () => {
    const cache = {
      delete: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
      zrem: vi.fn(),
      applyManagedHotPromotion: vi.fn(async () => {}),
    };
    const execute = createManagedEffectExecutor({
      context: { cache, config: { maxHotTierSize: 100 } } as never,
      storage: {} as never,
    });
    const effect = {
      id: "effect",
      workspaceId: "ws",
      operationId: "op",
      leaseOwner: "worker",
      effectKind: "session_buffer_cleanup",
      targetKind: "session",
      targetId: "s",
      payload: {},
    } as const;
    await expect(execute(effect, { idempotencyKey: "effect" })).rejects.toThrow();
    await execute(
      { ...effect, effectKind: "hot_tier_promotion", targetKind: "fact", targetId: "f" },
      { idempotencyKey: "effect" }
    );
    expect(cache.applyManagedHotPromotion).toHaveBeenCalledWith({
      workspaceId: "ws",
      factId: "f",
      effectId: "effect",
      maxSize: 100,
    });
  });
  it("enqueues webhook delivery inside the atomic effect callback", async () => {
    const append = vi.fn(async () => ({ id: "outbox" }));
    const scoped = {
      listWebhookEndpoints: async () => [
        {
          id: "webhook",
          isActive: true,
          events: ["session.archived"],
          url: "https://receiver.test",
          secretHash: "secret",
        },
      ],
    };
    const runManagedCollapseEffect = vi.fn(async (_input, apply) => {
      await apply({ storage: scoped, outbox: { append } });
      return true;
    });
    const execute = createManagedEffectExecutor({
      context: {} as never,
      storage: { runManagedCollapseEffect } as never,
    });
    const effect = {
      id: "effect",
      workspaceId: "ws",
      operationId: "op",
      leaseOwner: "worker",
      effectKind: "webhook_delivery",
      targetKind: "session",
      targetId: "s",
      payload: { status: "archived", reason: "empty_session" },
    } as const;
    expect(await execute(effect, { idempotencyKey: "effect" })).toBe("atomic");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "webhook_fire",
        payload: expect.objectContaining({
          eventType: "session.archived",
          payload: expect.objectContaining({ eventId: "effect" }),
        }),
      })
    );
  });
  it("final review I2: never writes the webhook secret into the outbox (APP-030)", async () => {
    const append = vi.fn(async () => ({ id: "outbox" }));
    const decrypt = vi.fn(() => "plaintext-signing-secret");
    const scoped = {
      listWebhookEndpoints: async () => [
        {
          id: "webhook",
          isActive: true,
          events: ["*"],
          url: "https://receiver.test",
          secretHash: "ciphertext",
        },
      ],
    };
    const runManagedCollapseEffect = vi.fn(async (_input, apply) => {
      await apply({ storage: scoped, outbox: { append } });
      return true;
    });
    const execute = createManagedEffectExecutor({
      context: {} as never,
      storage: { runManagedCollapseEffect } as never,
      webhookSecretCipher: { decrypt } as never,
    } as never);
    await execute(
      {
        id: "effect",
        workspaceId: "ws",
        operationId: "op",
        leaseOwner: "worker",
        effectKind: "webhook_delivery",
        targetKind: "session",
        targetId: "s",
        payload: { status: "archived", reason: "empty_session" },
      } as const,
      { idempotencyKey: "effect" }
    );
    const row = JSON.stringify((append.mock.calls as unknown[][])[0]![0]);
    expect(row).not.toContain("plaintext-signing-secret");
    expect(row).not.toContain("ciphertext");
    expect(decrypt).not.toHaveBeenCalled();
  });
  it("emits an archive event with a stable ID and never labels it collapsed", async () => {
    const emit = vi.fn();
    const record = vi.fn(async () => {});
    const onTerminal = vi.fn();
    const execute = createManagedEffectExecutor({
      context: {} as never,
      storage: {} as never,
      bus: { emit } as never,
      replay: { record } as never,
      onTerminal,
    });
    const effect = {
      id: "stable",
      workspaceId: "ws",
      operationId: "op",
      leaseOwner: "worker",
      effectKind: "bus_delivery",
      targetKind: "session",
      targetId: "s",
      payload: { status: "archived", reason: "empty_session" },
    } as const;
    await execute(effect, { idempotencyKey: "stable" });
    await execute(effect, { idempotencyKey: "stable" });
    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ id: "stable", type: "session.archived" }),
      expect.objectContaining({ id: "stable", type: "session.archived" }),
    ]);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });
});

describe("workspace rotation", () => {
  function rotationFixture(workspaceIds: string[], sliceSize = 2) {
    const seen: string[] = [];
    const drained: string[] = [];
    const rotate = createManagedWorkspaceRotation({
      listWorkspaceIds: async () => workspaceIds,
      runWorkspace: async (workspaceId: string) => {
        seen.push(workspaceId);
      },
      drainWorkspace: async (workspaceId: string) => {
        drained.push(workspaceId);
      },
      sliceSize,
    });
    return { rotate, seen, drained };
  }

  it("advances through every workspace across ticks instead of starving the tail", async () => {
    const { rotate, seen, drained } = rotationFixture(["a", "b", "c", "d", "e"]);
    await rotate();
    await rotate();
    await rotate();
    // Bounded per tick, and the cursor wraps only after the last workspace is served.
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(drained).toEqual(seen);
  });

  it("wraps back to the first workspace after the list is exhausted", async () => {
    const { rotate, seen } = rotationFixture(["a", "b", "c"], 2);
    await rotate();
    await rotate();
    await rotate();
    expect(seen).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("keeps serving later workspaces when one fails", async () => {
    const seen: string[] = [];
    const rotate = createManagedWorkspaceRotation({
      listWorkspaceIds: async () => ["a", "b", "c"],
      runWorkspace: async (workspaceId: string) => {
        seen.push(workspaceId);
        if (workspaceId === "a") throw new Error("workspace a is unavailable");
      },
      drainWorkspace: async () => {},
      sliceSize: 10,
    });
    await expect(rotate()).resolves.toBeUndefined();
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("does no work when there are no workspaces", async () => {
    const { rotate, seen } = rotationFixture([]);
    await rotate();
    expect(seen).toEqual([]);
  });
});

describe("collapse attempt audit", () => {
  const run = async (setup: (f: ReturnType<typeof fixture>) => void = () => {}) => {
    const f = fixture();
    setup(f);
    const audit = vi.fn();
    await runManagedSessionWorker(f.options, {
      storage: f.storage as never,
      prepare: f.prepare,
      audit,
    });
    return { f, audit, d: () => audit.mock.calls[0]![0].detail };
  };
  it("audits archive once as skipped with null unknown metrics", async () => {
    const { audit, d } = await run();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(d()).toMatchObject({ operation: "op", attempt: 1000, status: "skipped" });
    expect(d()).toMatchObject({ skipReason: "empty_session", episodeId: null, tokens: null });
  });
  it("audits collapse with episode id separate from operation id", async () => {
    const c = { status: "collapsed", episodeId: "ep-1" } as never;
    const { d } = await run((f) => f.storage.commitManagedCollapse.mockResolvedValueOnce(c));
    expect(d()).toMatchObject({ status: "completed", operation: "op", episodeId: "ep-1" });
  });
  it("audits retry, expired lease and commit failure as failed without moving the fence", async () => {
    const retry = await run((f) =>
      f.prepare.mockResolvedValueOnce({ status: "retryable", reason: "llm_unavailable" } as never)
    );
    expect(retry.d()).toMatchObject({ status: "failed", error: "llm_unavailable" });
    const lost = await run((f) => f.storage.heartbeatManagedCollapseLease.mockResolvedValue(false));
    expect(lost.d()).toMatchObject({ status: "failed", error: "lease_lost" });
    expect(lost.f.storage.commitManagedCollapse).not.toHaveBeenCalled();
    expect(lost.f.storage.markManagedCollapseRetry).not.toHaveBeenCalled();
    const boom = await run((f) =>
      f.storage.commitManagedCollapse.mockRejectedValueOnce(new Error("x"))
    );
    expect(boom.d()).toMatchObject({ status: "failed", error: "commit_unavailable" });
  });
  it("legacy sweep emits through an injected sink that cannot break the caller", async () => {
    const sink = vi.fn().mockRejectedValue(new Error("down"));
    const base = { workspaceId: "ws", sessionId: "s", operationId: "o", attempt: 2, reason: "r" };
    await emitCollapseAttemptAudit(sink, {
      ...base,
      outcome: "failed",
      error: "llm",
      startedAt: 1,
    });
    expect(sink.mock.calls[0]![0].detail).toMatchObject({ attempt: 2, error: "llm", tokens: null });
  });
});
