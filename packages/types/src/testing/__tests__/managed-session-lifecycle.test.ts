import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeTerminalDigestV1,
  sha256Hex,
  type HarnessEvent,
} from "../../index.js";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function startEvent(source: string): HarnessEvent {
  const event = {
    eventId: `${source}-start`,
    host: "opencode" as const,
    clientInstanceId: "test-client",
    hostSessionId: source,
    enqueueSequence: 1,
    occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    normalizationVersion: 1 as const,
    type: "session.start" as const,
  };
  return { ...event, payloadHash: sha256Hex(canonicalJson(event)) };
}

async function createManagedSession(
  adapter: InMemoryStorageAdapter,
  source: string,
  receivedAt = new Date() // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
): Promise<string> {
  const result = await adapter.ingestHarnessEvent({
    workspaceId: WORKSPACE_ID,
    provenance: {
      actorId: "key:test",
      actorType: "api_key",
      userId: null,
      sensitivityCeiling: "internal",
    },
    event: startEvent(source),
    receivedAt,
  });
  return result.sessionId!;
}

describe("in-memory managed session lifecycle", () => {
  it("does not retry a recoverable archive after workspace quiesce", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "quiesced-archive");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 0,
      leaseMs: 30_000,
    });
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "worker",
        operationId: "quiesced-archive-operation",
        reason: "no_pin",
      })
    ).toBe(true);
    const state = (adapter as unknown as { state: { harnessControls: Map<string, boolean> } })
      .state;
    state.harnessControls.set(WORKSPACE_ID, false);
    expect(await adapter.quiesceManagedLifecycle({ workspaceId: WORKSPACE_ID })).toEqual({
      pendingCount: 0,
      liveLeaseCount: 0,
      reactivatedCount: 0,
    });
    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WORKSPACE_ID, sessionId })).toBe(
      false
    );
    expect((await adapter.getSession(sessionId, WORKSPACE_ID))?.status).toBe("archived");
  });

  it("creates ordinary sessions as active and accepts scratch immediately", async () => {
    const adapter = new InMemoryStorageAdapter();
    const session = await adapter.createSession({ workspaceId: WORKSPACE_ID });

    expect(session.status).toBe("active");
    expect(
      await adapter.replaceSessionScratch({
        workspaceId: WORKSPACE_ID,
        sessionId: session.id,
        scratch: { note: "fresh" },
      })
    ).toBe(true);
  });

  it("lists and pins managed harness turns through the shared session port", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "managed-turn-parity");
    await adapter.seedHarnessManagedTurn(WORKSPACE_ID, {
      generation: 0,
      sourceMessageId: "managed-message",
      role: "user",
      content: "managed content",
      contentHash: sha256Hex("managed content"),
    });

    const [turn] = await adapter.listTurns(sessionId, WORKSPACE_ID);
    expect(turn).toMatchObject({ sourceMessageId: "managed-message", pinned: false });
    expect(
      await adapter.pinSessionTurn({
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        pinned: true,
      })
    ).toBe(true);
    expect(await adapter.listTurns(sessionId, WORKSPACE_ID)).toEqual([
      expect.objectContaining({ sourceMessageId: "managed-message", pinned: true }),
    ]);
  });

  it("allows pinning only while a managed session is active or provisional and unleased", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "managed-pin-fence");
    await adapter.seedHarnessManagedTurn(WORKSPACE_ID, {
      generation: 0,
      sourceMessageId: "managed-pin",
      role: "user",
      content: "pin me",
      contentHash: sha256Hex("pin me"),
    });
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "provisional",
      leased: false,
    });
    expect(
      await adapter.pinSessionTurn({
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        pinned: true,
      })
    ).toBe(true);

    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      leased: false,
    });
    await expect(
      adapter.pinSessionTurn({
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        pinned: false,
      })
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  it("exposes managed provenance and live lease state through session reads", async () => {
    const adapter = new InMemoryStorageAdapter();
    const receivedAt = new Date(Date.now() - 1_000); // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    const sessionId = await createManagedSession(adapter, "managed-read-model", receivedAt);
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "reader-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });

    const session = await adapter.getSession(sessionId, WORKSPACE_ID);
    expect(session).toMatchObject({
      sourceHost: "opencode",
      status: "collapse_pending",
      collapseLeaseOwner: "reader-worker",
      openedAt: expect.any(Date),
    });
    expect(session!.openedAt.getTime()).toBeGreaterThan(receivedAt.getTime());
    expect(await adapter.listSessions(WORKSPACE_ID)).toContainEqual(
      expect.objectContaining({
        id: sessionId,
        sourceHost: "opencode",
        collapseLeaseOwner: "reader-worker",
      })
    );
  });

  it("keeps provisional reopen state synchronized with lifecycle claims", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "provisional-sync");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      leased: false,
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
    });

    await adapter.appendTurn(sessionId, {
      workspaceId: WORKSPACE_ID,
      sessionId,
      turnIndex: 0,
      role: "user",
      content: "resume",
    });

    expect(
      await adapter.claimManagedSessions({
        workspaceId: WORKSPACE_ID,
        leaseOwner: "worker",
        limit: 1,
        inactivityMs: 60_000,
        provisionalGraceMs: 1_000,
        leaseMs: 30_000,
      })
    ).toEqual([]);
    expect((await adapter.getSession(sessionId, WORKSPACE_ID))?.status).toBe("active");
  });

  it("allocates unique indexes across direct and harness appends after provisional reopen", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = "mixed-turn-indexes";
    const sessionId = await createManagedSession(adapter, source);
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "provisional",
      leased: false,
    });
    expect(
      await adapter.appendTurn(sessionId, {
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        role: "user",
        content: "direct append",
      })
    ).toBe(0);
    const content = "harness append";
    const event = {
      eventId: `${source}-append`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 2,
      occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "mixed-harness-message",
      role: "assistant" as const,
      content,
      contentHash: sha256Hex(content),
    };
    await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...event, payloadHash: sha256Hex(canonicalJson(event)) },
      receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    });

    expect(
      (await adapter.listTurns(sessionId, WORKSPACE_ID)).map((turn) => turn.turnIndex)
    ).toEqual([0, 1]);
  });

  it("allocates a direct append after an existing harness turn", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "harness-then-direct-index");
    await adapter.seedHarnessManagedTurn(WORKSPACE_ID, {
      generation: 0,
      sourceMessageId: "first-harness-message",
      role: "user",
      content: "harness first",
      contentHash: sha256Hex("harness first"),
    });

    expect(
      await adapter.appendTurn(sessionId, {
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        role: "assistant",
        content: "direct second",
      })
    ).toBe(1);
    expect(
      (await adapter.listTurns(sessionId, WORKSPACE_ID)).map((turn) => turn.turnIndex)
    ).toEqual([0, 1]);
  });

  it("does not reopen a provisional generation after a failed leased attempt", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = "leased-fence";
    const sessionId = await createManagedSession(adapter, source);
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      leased: true,
      closeKind: "provisional",
      closeGraceDeadline: new Date(0),
    });
    await adapter.markManagedCollapseRetry({
      workspaceId: WORKSPACE_ID,
      sessionId,
      leaseOwner: "contract-worker",
      error: "retry",
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });

    await expect(
      adapter.appendTurn(sessionId, {
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        role: "user",
        content: "must use successor",
      })
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    await expect(
      adapter.pinSessionTurn({
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnIndex: 0,
        pinned: true,
      })
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });

    const content = "continue through ingestion";
    const event = {
      eventId: `${source}-append`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 2,
      occurredAt: new Date().toISOString(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "after-lease",
      role: "user" as const,
      content,
      contentHash: sha256Hex(content),
    };
    const resumed = await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...event, payloadHash: sha256Hex(canonicalJson(event)) },
      receivedAt: new Date(), // determinism-ok: ingestion timestamp is the caller's wall clock; the assertion never depends on its value
    });
    expect(resumed.effectiveGeneration).toBe(1);
  });

  it("rejects retry and archive finalization after the worker lease expires", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "expired-owner");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "stale-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: -1_000,
    });

    expect(
      await adapter.markManagedCollapseRetry({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "stale-worker",
        error: "too late",
        baseRetryMs: 100,
        maxRetryMs: 1_000,
      })
    ).toBeNull();
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "stale-worker",
        operationId: `archive:${sessionId}`,
        reason: "empty_session",
      })
    ).toBe(false);
  });

  it("saturates collapse attempts at the PostgreSQL integer maximum", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "attempt-saturation");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "boundary-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    const state = (
      adapter as unknown as {
        state: { harnessSessions: Map<string, { id: string; collapseAttempts: number }> };
      }
    ).state;
    const managed = [...state.harnessSessions.values()].find(
      (session) => session.id === sessionId
    )!;
    managed.collapseAttempts = 2_147_483_647;

    const retry = await adapter.markManagedCollapseRetry({
      workspaceId: WORKSPACE_ID,
      sessionId,
      leaseOwner: "boundary-worker",
      error: "boundary",
      baseRetryMs: 100,
      maxRetryMs: 1_000,
    });

    expect(retry?.attempts).toBe(2_147_483_647);
  });

  it("claims due sessions by next-attempt time and then id", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionIds = await Promise.all(
      ["due-late", "due-early-a", "due-early-b"].map((source) =>
        createManagedSession(adapter, source)
      )
    );
    const state = (
      adapter as unknown as {
        state: {
          sessions: Map<string, { status: string }>;
          harnessSessions: Map<
            string,
            {
              id: string;
              status: string;
              closeKind: string | null;
              closeGraceDeadline: Date | null;
              collapseNextAttemptAt: Date | null;
              leaseOwner: string | null;
              leaseExpiresAt: Date | null;
            }
          >;
        };
      }
    ).state;
    const byId = new Map(
      [...state.harnessSessions.values()].map((session) => [session.id, session])
    );
    const early = new Date(Date.now() - 2_000); // determinism-ok: wall-clock value the assertion does not depend on
    const late = new Date(Date.now() - 1_000); // determinism-ok: wall-clock value the assertion does not depend on
    for (const id of sessionIds) {
      const session = byId.get(id)!;
      session.status = "collapse_pending";
      session.closeKind = "authoritative";
      session.closeGraceDeadline = new Date(0);
      session.collapseNextAttemptAt = id === sessionIds[0] ? late : early;
      session.leaseOwner = null;
      session.leaseExpiresAt = null;
      state.sessions.get(id)!.status = "collapse_pending";
    }
    const expected = sessionIds.slice(1).sort();

    const claims = await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "ordered-worker",
      limit: 2,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });

    expect(claims.map((claim) => claim.session.id)).toEqual(expected);
  });

  it("rejects cross-session archive operation reuse", async () => {
    const adapter = new InMemoryStorageAdapter();
    const firstSessionId = await createManagedSession(adapter, "operation-owner");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "first-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    const operationId = "archive:shared-operation";
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId: firstSessionId,
        leaseOwner: "first-worker",
        operationId,
        reason: "empty_session",
      })
    ).toBe(true);

    const secondSessionId = await createManagedSession(adapter, "operation-collision");
    const state = (
      adapter as unknown as {
        state: {
          sessions: Map<string, { status: string }>;
          harnessSessions: Map<
            string,
            {
              id: string;
              status: string;
              closeKind: string | null;
              leaseOwner: string | null;
              leaseExpiresAt: Date | null;
            }
          >;
        };
      }
    ).state;
    const second = [...state.harnessSessions.values()].find(
      (session) => session.id === secondSessionId
    )!;
    second.status = "collapse_pending";
    second.closeKind = "authoritative";
    second.leaseOwner = "second-worker";
    second.leaseExpiresAt = new Date(Date.now() + 30_000); // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    state.sessions.get(secondSessionId)!.status = "collapse_pending";

    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId: secondSessionId,
        leaseOwner: "second-worker",
        operationId,
        reason: "empty_session",
      })
    ).toBe(false);
    expect((await adapter.getSession(secondSessionId, WORKSPACE_ID))?.status).toBe(
      "collapse_pending"
    );
  });

  it("requeues exactly three archive effects when a recoverable operation is retried", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "effect-requeue");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "first-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    const operationId = `archive:${sessionId}`;
    await adapter.finalizeManagedArchive({
      workspaceId: WORKSPACE_ID,
      sessionId,
      leaseOwner: "first-worker",
      operationId,
      reason: "no_pin",
    });
    const state = (
      adapter as unknown as {
        state: {
          managedCollapseEffects: Array<{
            operationId: string;
            status: string;
            attempts: number;
            nextAttemptAt: Date | null;
            completedAt: Date | null;
            lastError: string | null;
          }>;
        };
      }
    ).state;
    for (const effect of state.managedCollapseEffects) {
      effect.status = "completed";
      effect.attempts = 2;
      effect.nextAttemptAt = new Date(); // determinism-ok: retry deadline is relative to now by design; the assertion is on the interval, not the instant
      effect.completedAt = new Date(); // determinism-ok: wall-clock value the assertion does not depend on
      effect.lastError = "old failure";
    }

    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WORKSPACE_ID, sessionId })).toBe(
      true
    );
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "retry-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "retry-worker",
        operationId: `replacement:${sessionId}`,
        reason: "no_pin",
      })
    ).toBe(false);
    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "retry-worker",
        operationId,
        reason: "no_pin",
      })
    ).toBe(true);

    expect(state.managedCollapseEffects).toHaveLength(3);
    expect(state.managedCollapseEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          status: "pending",
          attempts: 0,
          nextAttemptAt: null,
          completedAt: null,
          lastError: null,
        }),
      ])
    );
  });

  it("clears stale lease state when recovering a managed archive", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "recovery-lease-reset");
    const state = (
      adapter as unknown as {
        state: {
          sessions: Map<string, { status: string }>;
          harnessSessions: Map<
            string,
            {
              id: string;
              status: string;
              archiveReason: string | null;
              leased: boolean;
              leaseOwner: string | null;
              leaseExpiresAt: Date | null;
            }
          >;
        };
      }
    ).state;
    const managed = [...state.harnessSessions.values()].find(
      (session) => session.id === sessionId
    )!;
    managed.status = "archived";
    managed.archiveReason = "no_pin";
    managed.leased = true;
    managed.leaseOwner = "stale-worker";
    managed.leaseExpiresAt = new Date(Date.now() + 60_000); // determinism-ok: lease deadline is relative to database time by design; the test asserts expiry, not a fixed instant
    state.sessions.get(sessionId)!.status = "archived";

    expect(await adapter.retryLegacyManagedArchive({ workspaceId: WORKSPACE_ID, sessionId })).toBe(
      true
    );
    expect(managed).toMatchObject({ leased: false, leaseOwner: null, leaseExpiresAt: null });
  });

  it("clears next-attempt state on archive and records retry errors", async () => {
    const adapter = new InMemoryStorageAdapter();
    const sessionId = await createManagedSession(adapter, "retry-archive-parity");
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapse_pending",
      closeKind: "authoritative",
      closeGraceDeadline: new Date(0),
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "retry-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });
    await adapter.markManagedCollapseRetry({
      workspaceId: WORKSPACE_ID,
      sessionId,
      leaseOwner: "retry-worker",
      error: "provider unavailable",
      baseRetryMs: 0,
      maxRetryMs: 0,
    });
    expect((await adapter.getSession(sessionId, WORKSPACE_ID))?.metadata).toMatchObject({
      managedCollapseLastError: "provider unavailable",
    });
    await adapter.claimManagedSessions({
      workspaceId: WORKSPACE_ID,
      leaseOwner: "archive-worker",
      limit: 1,
      inactivityMs: 60_000,
      provisionalGraceMs: 1_000,
      leaseMs: 30_000,
    });

    expect(
      await adapter.finalizeManagedArchive({
        workspaceId: WORKSPACE_ID,
        sessionId,
        leaseOwner: "archive-worker",
        operationId: `archive:${sessionId}`,
        reason: "no_pin",
      })
    ).toBe(true);
    expect((await adapter.getSession(sessionId, WORKSPACE_ID))?.collapseNextAttemptAt).toBeNull();
  });

  it("projects complete managed turn and terminal metadata", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = "projection-parity";
    const sessionId = await createManagedSession(adapter, source);
    const receivedAt = new Date("2026-09-09T12:00:00.000Z");
    const content = "complete projection";
    const contentHash = sha256Hex(content);
    const append = {
      eventId: `${source}-append`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 2,
      occurredAt: receivedAt.toISOString(),
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "projected-message",
      role: "user" as const,
      content,
      contentHash,
    };
    await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...append, payloadHash: sha256Hex(canonicalJson(append)) },
      receivedAt,
    });
    const digest = computeTerminalDigestV1([
      { type: "M", hostMessageId: "projected-message", role: "user", contentHash },
    ]);
    const end = {
      eventId: `${source}-end`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 3,
      occurredAt: receivedAt.toISOString(),
      normalizationVersion: 1 as const,
      type: "session.end" as const,
      sourceGeneration: 0,
      reason: "host_end" as const,
      finalMessageSetDigest: digest,
      maxEnqueueSequence: 2,
    };
    await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...end, payloadHash: sha256Hex(canonicalJson(end)) },
      receivedAt,
    });

    expect(await adapter.listTurns(sessionId, WORKSPACE_ID)).toEqual([
      expect.objectContaining({
        sourceMessageId: "projected-message",
        tokenCount: Math.ceil(Buffer.byteLength(content, "utf8") / 4),
        ingestionEventId: expect.any(String),
        createdAt: receivedAt,
      }),
    ]);
    expect(await adapter.getSession(sessionId, WORKSPACE_ID)).toMatchObject({
      terminalDigestVersion: 1,
      terminalMessageSetDigest: digest,
      terminalMaxEnqueueSequence: 2,
    });
  });

  it("projects the actual managed turn retraction time and reason", async () => {
    const adapter = new InMemoryStorageAdapter();
    const source = "retraction-projection";
    const sessionId = await createManagedSession(adapter, source);
    const content = "remove me";
    const append = {
      eventId: `${source}-append`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 2,
      occurredAt: "2026-09-09T12:00:00.000Z",
      normalizationVersion: 1 as const,
      type: "turn.append" as const,
      sourceGeneration: 0,
      hostMessageId: "retracted-message",
      role: "user" as const,
      content,
      contentHash: sha256Hex(content),
    };
    await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...append, payloadHash: sha256Hex(canonicalJson(append)) },
      receivedAt: new Date(append.occurredAt),
    });
    const retractedAt = new Date("2026-09-09T12:01:00.000Z");
    const retract = {
      eventId: `${source}-retract`,
      host: "opencode" as const,
      clientInstanceId: "test-client",
      hostSessionId: source,
      enqueueSequence: 3,
      occurredAt: retractedAt.toISOString(),
      normalizationVersion: 1 as const,
      type: "turn.retract" as const,
      sourceGeneration: 0,
      hostMessageId: "retracted-message",
      reason: "branch_removed" as const,
    };
    await adapter.ingestHarnessEvent({
      workspaceId: WORKSPACE_ID,
      provenance: {
        actorId: "key:test",
        actorType: "api_key",
        userId: null,
        sensitivityCeiling: "internal",
      },
      event: { ...retract, payloadHash: sha256Hex(canonicalJson(retract)) },
      receivedAt: retractedAt,
    });

    expect(await adapter.listTurns(sessionId, WORKSPACE_ID)).toEqual([
      expect.objectContaining({
        sourceMessageId: "retracted-message",
        retractedAt,
        retractionReason: "branch_removed",
      }),
    ]);
  });

  it("purges turns from collapsed managed sessions", async () => {
    const adapter = new InMemoryStorageAdapter();
    await createManagedSession(adapter, "collapsed-retention");
    await adapter.seedHarnessManagedTurn(WORKSPACE_ID, {
      generation: 0,
      sourceMessageId: "message-1",
      role: "user",
      content: "old turn",
      contentHash: sha256Hex("old turn"),
    });
    await adapter.setHarnessSessionLifecycle(WORKSPACE_ID, {
      generation: 0,
      status: "collapsed",
    });

    expect(
      await adapter.purgeManagedTurns({
        workspaceId: WORKSPACE_ID,
        terminalBefore: new Date(Date.now() + 1_000), // determinism-ok: wall-clock value the assertion does not depend on
        limit: 10,
      })
    ).toBe(1);
  });
});
