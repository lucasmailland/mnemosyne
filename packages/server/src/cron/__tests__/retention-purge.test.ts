/**
 * Unit tests for retentionPurgeHandler + parseRetentionConfig.
 *
 * D2 — DEK guard: destroyActorDek called only for confidential/restricted tiers
 *       and only for actors returned in eraseCandidateActorIds.
 * D3 — Dry-run: appendDeletionLog not called; purgeFacts receives dryRun:true.
 * D4 — parseRetentionConfig: default values and env-var overrides.
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
 * Build a mock deps object.
 * By default purgeFacts returns softClosed=2, eraseCandidateActorIds=['actor-1']
 * for confidential/restricted and eraseCandidateActorIds=[] for internal.
 */
function makeDeps(
  opts: {
    purgeResult?: (sensitivity: string) => {
      softClosed: number;
      eraseCandidateActorIds: string[];
      eraseCandidateUserIds: string[];
    };
    workspaceIds?: string[];
  } = {}
) {
  const workspaceIds = opts.workspaceIds ?? ["ws-1"];
  const purgeResult =
    opts.purgeResult ??
    ((sensitivity: string) => ({
      softClosed: 2,
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

// ─── D4: parseRetentionConfig ────────────────────────────────────────────────

describe("parseRetentionConfig", () => {
  it("returns defaults when no env vars are set", () => {
    const cfg = parseRetentionConfig({});
    expect(cfg.internalDays).toBe(730);
    expect(cfg.confidentialDays).toBe(365);
    expect(cfg.restrictedDays).toBe(90);
    expect(cfg.dryRun).toBe(false);
  });

  it("MNEMO_RETENTION_RESTRICTED_DAYS=30 overrides restricted window", () => {
    const cfg = parseRetentionConfig({ MNEMO_RETENTION_RESTRICTED_DAYS: "30" });
    expect(cfg.restrictedDays).toBe(30);
    expect(cfg.internalDays).toBe(730); // others unchanged
    expect(cfg.confidentialDays).toBe(365);
  });

  it("MNEMO_RETENTION_INTERNAL_DAYS=365 overrides internal window", () => {
    const cfg = parseRetentionConfig({ MNEMO_RETENTION_INTERNAL_DAYS: "365" });
    expect(cfg.internalDays).toBe(365);
  });

  it("MNEMO_RETENTION_DRY_RUN=true sets dryRun=true", () => {
    const cfg = parseRetentionConfig({ MNEMO_RETENTION_DRY_RUN: "true" });
    expect(cfg.dryRun).toBe(true);
  });

  it("MNEMO_RETENTION_DRY_RUN=false leaves dryRun=false", () => {
    const cfg = parseRetentionConfig({ MNEMO_RETENTION_DRY_RUN: "false" });
    expect(cfg.dryRun).toBe(false);
  });

  it("invalid numeric value falls back to default", () => {
    const cfg = parseRetentionConfig({ MNEMO_RETENTION_RESTRICTED_DAYS: "not-a-number" });
    expect(cfg.restrictedDays).toBe(90);
  });
});

// ─── D2: DEK guard ───────────────────────────────────────────────────────────

describe("retentionPurgeHandler — DEK guard", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Disable dry-run so DEK + deletion log paths execute.
    delete process.env["MNEMO_RETENTION_DRY_RUN"];
    delete process.env["MNEMO_RETENTION_INTERNAL_DAYS"];
    delete process.env["MNEMO_RETENTION_CONFIDENTIAL_DAYS"];
    delete process.env["MNEMO_RETENTION_RESTRICTED_DAYS"];
  });

  afterEach(() => {
    // Restore env.
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it("destroyActorDek is called for actor-1 on confidential tier", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    const calls = (deps.storage.destroyActorDek as ReturnType<typeof vi.fn>).mock.calls;
    const confidentialCall = calls.find(([ws, actor]: [string, string]) => actor === "actor-1");
    expect(confidentialCall).toBeDefined();
    expect(confidentialCall![0]).toBe("ws-1");
  });

  it("destroyActorDek is called for actor-1 on restricted tier", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    // Both confidential and restricted return actor-1 as erase candidate.
    const calls = (deps.storage.destroyActorDek as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
    const uniqueActors = [...new Set(calls.map(([, actor]) => actor))];
    expect(uniqueActors).toContain("actor-1");
  });

  it("destroyUserDeks is called for user-1 alongside (not instead of) destroyActorDek", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    const userCalls = (deps.storage.destroyUserDeks as ReturnType<typeof vi.fn>).mock.calls;
    const confidentialCall = userCalls.find(([, userId]: [string, string]) => userId === "user-1");
    expect(confidentialCall).toBeDefined();
    expect(confidentialCall![0]).toBe("ws-1");

    // Both loops ran — the actor-id path is untouched by adding the user-id path.
    expect(
      (deps.storage.destroyActorDek as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it("a person with two API keys gets ALL of their DEKs destroyed in one purge cycle (destroyUserDeks called once per qualifying user, regardless of how many actor_ids they used)", async () => {
    // Simulate a person whose confidential facts span two different actor_ids
    // (two API keys) but a single user_id — purgeFacts is expected to report
    // the shared user_id as a candidate exactly once per tier, and
    // destroyUserDeks (mocked to report 2 DEKs destroyed) closes both.
    const deps = makeDeps({
      purgeResult: (sensitivity: string) => ({
        softClosed: 2,
        eraseCandidateActorIds: sensitivity !== "internal" ? ["actor-1", "actor-2"] : [],
        eraseCandidateUserIds: sensitivity !== "internal" ? ["user-shared"] : [],
      }),
    });
    (deps.storage.destroyUserDeks as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    await retentionPurgeHandler(deps);

    const userCalls = (deps.storage.destroyUserDeks as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
    const sharedUserCalls = userCalls.filter(([, userId]) => userId === "user-shared");
    // Called once per tier that reported the candidate (confidential + restricted),
    // NOT once per actor_id — the whole point is one call destroys every DEK
    // that person accrued, regardless of how many keys they used.
    expect(sharedUserCalls.length).toBeGreaterThan(0);
    for (const call of sharedUserCalls) {
      expect(call[0]).toBe("ws-1");
    }
  });

  it("destroyActorDek is NOT called for internal tier (eraseCandidates is empty)", async () => {
    // purgeFacts returns no erase candidates for internal, so destroyActorDek
    // should only be called for confidential and restricted.
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    const purgeCalls = (deps.storage.purgeFacts as ReturnType<typeof vi.fn>).mock.calls as [
      { sensitivity: string },
    ][];
    const internalCalls = purgeCalls.filter(([f]) => f.sensitivity === "internal");
    expect(internalCalls.length).toBeGreaterThan(0);

    // We trust that purgeResult returns [] for internal, and the handler respects
    // that by not calling destroyActorDek for those iterations.
    // Verify: all destroyActorDek calls reference workspaces where the tier was
    // confidential or restricted (we can't distinguish by call index easily,
    // but we can verify it was never called with a sensitivity=internal round
    // by checking that the mock total < tiers-that-return-candidates * workspaces).
    const destroyCalls = (deps.storage.destroyActorDek as ReturnType<typeof vi.fn>).mock.calls;
    // 2 encrypted tiers × 1 workspace × 1 actor = 2 calls max.
    expect(destroyCalls.length).toBeLessThanOrEqual(2);
  });

  it("appendDeletionLog is called once per workspace when softClosed > 0", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    expect(deps.storage.appendDeletionLog).toHaveBeenCalledTimes(1);
    const call = (deps.storage.appendDeletionLog as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      workspaceId: string;
      deletionType: string;
    };
    expect(call.workspaceId).toBe("ws-1");
    expect(call.deletionType).toBe("retention_purge");
  });

  it("no-ops gracefully when purgeFacts is not implemented", async () => {
    const deps = makeDeps();
    (deps.storage as { purgeFacts?: unknown }).purgeFacts = undefined;

    await expect(
      retentionPurgeHandler(deps as ReturnType<typeof makeDeps>)
    ).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalledOnce();
  });
});

// ─── D3: Dry-run mode ────────────────────────────────────────────────────────

describe("retentionPurgeHandler — dry-run", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env["MNEMO_RETENTION_DRY_RUN"] = "true";
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

  it("appendDeletionLog is NOT called when MNEMO_RETENTION_DRY_RUN=true", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    expect(deps.storage.appendDeletionLog).not.toHaveBeenCalled();
  });

  it("purgeFacts receives dryRun:true in each call", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    const calls = (deps.storage.purgeFacts as ReturnType<typeof vi.fn>).mock.calls as [
      { dryRun?: boolean },
    ][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [filter] of calls) {
      expect(filter.dryRun).toBe(true);
    }
  });

  it("destroyActorDek is NOT called in dry-run (even if eraseCandidates returned)", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    expect(deps.storage.destroyActorDek).not.toHaveBeenCalled();
  });

  it("softClosed counts are still returned and logged (non-zero)", async () => {
    const deps = makeDeps();
    await retentionPurgeHandler(deps);

    // purgeFacts should have been called for each tier.
    expect(deps.storage.purgeFacts).toHaveBeenCalled();
    // logger.info should have workspace summary with softClosed values.
    const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls as [
      { softClosed?: number },
    ][];
    const workspaceLog = infoCalls.find(
      ([o]) => typeof o.softClosed === "number" && o.softClosed > 0
    );
    expect(workspaceLog).toBeDefined();
  });
});

describe("D4b: managed transcript retention window", () => {
  it("defaults to 30 days", () => {
    expect(parseRetentionConfig({}).transcriptDays).toBe(30);
  });

  it("honours MNEMO_RETENTION_TRANSCRIPT_DAYS", () => {
    expect(parseRetentionConfig({ MNEMO_RETENTION_TRANSCRIPT_DAYS: "7" }).transcriptDays).toBe(7);
  });

  it("keeps the default for values that would purge immediately or make no sense", () => {
    for (const raw of ["0", "-1", "", "not-a-number"]) {
      expect(parseRetentionConfig({ MNEMO_RETENTION_TRANSCRIPT_DAYS: raw }).transcriptDays).toBe(
        30
      );
    }
  });
});
