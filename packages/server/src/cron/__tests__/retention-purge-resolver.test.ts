/**
 * Unit tests for retentionPurgeHandler resolver integration.
 *
 * R1 — Resolver present: handler calls resolve(workspaceId) per workspace and
 *      uses returned windows (not deps.config / env vars).
 * R2 — Resolver absent: handler falls back to env-based config.
 * R3 — Partial override: different workspaces get distinct olderThanDays values.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retentionPurgeHandler, parseRetentionConfig } from "../retention-purge.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}
function makeTelemetry() {
  return { counter: vi.fn() };
}

/**
 * Build a minimal mock of RetentionConfigResolver.
 * resolveFn receives the workspaceId and returns an object with the 3 day windows.
 */
function makeResolver(
  resolveFn: (workspaceId: string) => {
    internalDays: number;
    confidentialDays: number;
    restrictedDays: number;
    source: "workspace" | "global" | "env";
  }
) {
  return {
    resolve: vi.fn(async (workspaceId: string) => resolveFn(workspaceId)),
    invalidate: vi.fn(),
  };
}

function makeDeps(
  opts: {
    workspaceIds?: string[];
    purgeResult?: (sensitivity: string) => {
      softClosed: number;
      eraseCandidateActorIds: string[];
      eraseCandidateUserIds: string[];
    };
  } = {}
) {
  const workspaceIds = opts.workspaceIds ?? ["ws-1"];
  const purgeResult =
    opts.purgeResult ??
    ((sensitivity: string) => ({
      softClosed: 1,
      eraseCandidateActorIds: sensitivity !== "internal" ? ["actor-1"] : [],
      eraseCandidateUserIds: sensitivity !== "internal" ? ["user-1"] : [],
    }));

  const purgeFacts = vi.fn(async (filter: { sensitivity: string }) =>
    purgeResult(filter.sensitivity)
  );
  const appendDeletionLog = vi.fn(async () => undefined);
  const destroyActorDek = vi.fn(async () => true);
  const destroyUserDeks = vi.fn(async () => 1);

  return {
    listWorkspaceIds: vi.fn(async () => workspaceIds),
    storage: { purgeFacts, appendDeletionLog, destroyActorDek, destroyUserDeks },
    logger: makeLogger(),
    telemetry: makeTelemetry(),
  };
}

// ─── R1: Resolver present ────────────────────────────────────────────────────

describe("retentionPurgeHandler — resolver present", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Remove env vars so we can be sure the resolver's return values are used
    delete process.env["MNEMO_RETENTION_DRY_RUN"];
    delete process.env["MNEMO_RETENTION_INTERNAL_DAYS"];
    delete process.env["MNEMO_RETENTION_CONFIDENTIAL_DAYS"];
    delete process.env["MNEMO_RETENTION_RESTRICTED_DAYS"];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("calls resolve(workspaceId) once per workspace", async () => {
    const resolver = makeResolver(() => ({
      internalDays: 100,
      confidentialDays: 50,
      restrictedDays: 25,
      source: "workspace" as const,
    }));
    const deps = {
      ...makeDeps({ workspaceIds: ["ws-1", "ws-2"] }),
      retentionConfigResolver:
        resolver as unknown as import("../retention-purge.js").RetentionPurgeDeps["retentionConfigResolver"],
    };

    await retentionPurgeHandler(deps);

    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenCalledWith("ws-1");
    expect(resolver.resolve).toHaveBeenCalledWith("ws-2");
  });

  it("uses resolver-returned windows in purgeFacts calls (not env defaults)", async () => {
    const resolver = makeResolver(() => ({
      internalDays: 100,
      confidentialDays: 50,
      restrictedDays: 25,
      source: "workspace" as const,
    }));
    const baseDeps = makeDeps({ workspaceIds: ["ws-1"] });
    const deps = {
      ...baseDeps,
      retentionConfigResolver:
        resolver as unknown as import("../retention-purge.js").RetentionPurgeDeps["retentionConfigResolver"],
    };

    await retentionPurgeHandler(deps);

    const calls = (baseDeps.storage.purgeFacts as ReturnType<typeof vi.fn>).mock.calls as [
      { sensitivity: string; olderThanDays: number },
    ][];
    const internalCall = calls.find(([f]) => f.sensitivity === "internal");
    const confidentialCall = calls.find(([f]) => f.sensitivity === "confidential");
    const restrictedCall = calls.find(([f]) => f.sensitivity === "restricted");

    expect(internalCall?.[0].olderThanDays).toBe(100);
    expect(confidentialCall?.[0].olderThanDays).toBe(50);
    expect(restrictedCall?.[0].olderThanDays).toBe(25);
  });
});

// ─── R2: Resolver absent ─────────────────────────────────────────────────────

describe("retentionPurgeHandler — resolver absent (env fallback)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env["MNEMO_RETENTION_DRY_RUN"];
    process.env["MNEMO_RETENTION_INTERNAL_DAYS"] = "200";
    process.env["MNEMO_RETENTION_CONFIDENTIAL_DAYS"] = "100";
    process.env["MNEMO_RETENTION_RESTRICTED_DAYS"] = "45";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("uses env-based config when no resolver is present", async () => {
    const deps = makeDeps({ workspaceIds: ["ws-1"] });
    // No retentionConfigResolver on deps

    await retentionPurgeHandler(deps);

    const calls = (deps.storage.purgeFacts as ReturnType<typeof vi.fn>).mock.calls as [
      { sensitivity: string; olderThanDays: number },
    ][];
    const internalCall = calls.find(([f]) => f.sensitivity === "internal");
    const confidentialCall = calls.find(([f]) => f.sensitivity === "confidential");
    const restrictedCall = calls.find(([f]) => f.sensitivity === "restricted");

    expect(internalCall?.[0].olderThanDays).toBe(200);
    expect(confidentialCall?.[0].olderThanDays).toBe(100);
    expect(restrictedCall?.[0].olderThanDays).toBe(45);
  });
});

// ─── R3: Partial override — different workspaces get distinct windows ─────────

describe("retentionPurgeHandler — partial per-workspace override", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env["MNEMO_RETENTION_DRY_RUN"];
    delete process.env["MNEMO_RETENTION_INTERNAL_DAYS"];
    delete process.env["MNEMO_RETENTION_CONFIDENTIAL_DAYS"];
    delete process.env["MNEMO_RETENTION_RESTRICTED_DAYS"];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("each workspace is purged with its own resolver-returned thresholds", async () => {
    const ws1Config = {
      internalDays: 30,
      confidentialDays: 15,
      restrictedDays: 7,
      source: "workspace" as const,
    };
    const ws2Config = {
      internalDays: 730,
      confidentialDays: 365,
      restrictedDays: 90,
      source: "env" as const,
    };

    const resolver = makeResolver((workspaceId: string) =>
      workspaceId === "ws-1" ? ws1Config : ws2Config
    );

    // Capture purgeFacts calls per workspace
    const purgeCalls: Array<{ workspaceId: string; sensitivity: string; olderThanDays: number }> =
      [];
    const purgeFacts = vi.fn(
      async (filter: { workspaceId: string; sensitivity: string; olderThanDays: number }) => {
        purgeCalls.push({
          workspaceId: filter.workspaceId,
          sensitivity: filter.sensitivity,
          olderThanDays: filter.olderThanDays,
        });
        return { softClosed: 0, eraseCandidateActorIds: [], eraseCandidateUserIds: [] };
      }
    );

    const deps = {
      listWorkspaceIds: vi.fn(async () => ["ws-1", "ws-2"]),
      storage: {
        purgeFacts,
        appendDeletionLog: vi.fn(),
        destroyActorDek: vi.fn(),
        destroyUserDeks: vi.fn(),
      },
      logger: makeLogger(),
      telemetry: makeTelemetry(),
      retentionConfigResolver:
        resolver as unknown as import("../retention-purge.js").RetentionPurgeDeps["retentionConfigResolver"],
    };

    await retentionPurgeHandler(deps);

    // ws-1 gets its own thresholds
    const ws1Internal = purgeCalls.find(
      (c) => c.workspaceId === "ws-1" && c.sensitivity === "internal"
    );
    const ws1Restricted = purgeCalls.find(
      (c) => c.workspaceId === "ws-1" && c.sensitivity === "restricted"
    );
    expect(ws1Internal?.olderThanDays).toBe(30);
    expect(ws1Restricted?.olderThanDays).toBe(7);

    // ws-2 gets its own thresholds
    const ws2Internal = purgeCalls.find(
      (c) => c.workspaceId === "ws-2" && c.sensitivity === "internal"
    );
    const ws2Restricted = purgeCalls.find(
      (c) => c.workspaceId === "ws-2" && c.sensitivity === "restricted"
    );
    expect(ws2Internal?.olderThanDays).toBe(730);
    expect(ws2Restricted?.olderThanDays).toBe(90);
  });

  it("dryRun flag comes from env (global), not from resolver", async () => {
    process.env["MNEMO_RETENTION_DRY_RUN"] = "true";

    const resolver = makeResolver(() => ({
      internalDays: 100,
      confidentialDays: 50,
      restrictedDays: 25,
      source: "workspace" as const,
    }));

    const purgeFacts = vi.fn(async () => ({
      softClosed: 0,
      eraseCandidateActorIds: [],
      eraseCandidateUserIds: [],
    }));
    const appendDeletionLog = vi.fn(async () => undefined);

    const deps = {
      listWorkspaceIds: vi.fn(async () => ["ws-1"]),
      storage: {
        purgeFacts,
        appendDeletionLog,
        destroyActorDek: vi.fn(),
        destroyUserDeks: vi.fn(),
      },
      logger: makeLogger(),
      telemetry: makeTelemetry(),
      retentionConfigResolver:
        resolver as unknown as import("../retention-purge.js").RetentionPurgeDeps["retentionConfigResolver"],
    };

    await retentionPurgeHandler(deps);

    // purgeFacts should receive dryRun:true (from env, not resolver)
    const calls = (purgeFacts as ReturnType<typeof vi.fn>).mock.calls as [{ dryRun?: boolean }][];
    for (const [filter] of calls) {
      expect(filter.dryRun).toBe(true);
    }

    // appendDeletionLog should NOT be called in dry-run
    expect(appendDeletionLog).not.toHaveBeenCalled();
  });
});

// ─── Guard: env fallback parity ───────────────────────────────────────────────

describe("retentionPurgeHandler — env fallback parity", () => {
  it("parseRetentionConfig still works as the baseline when no resolver", () => {
    const cfg = parseRetentionConfig({
      MNEMO_RETENTION_INTERNAL_DAYS: "365",
      MNEMO_RETENTION_CONFIDENTIAL_DAYS: "180",
      MNEMO_RETENTION_RESTRICTED_DAYS: "30",
    });
    expect(cfg.internalDays).toBe(365);
    expect(cfg.confidentialDays).toBe(180);
    expect(cfg.restrictedDays).toBe(30);
  });
});
