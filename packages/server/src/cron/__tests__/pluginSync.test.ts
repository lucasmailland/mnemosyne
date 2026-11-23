import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pluginSyncJobs,
  pluginSyncHandler,
  pluginVerifyHandler,
  PLUGIN_SYNC_MIN_MS,
  type PluginLoaderLike,
} from "../pluginSync.js";
import { startCronRegistry } from "../registry.js";

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

function loader(over: Partial<PluginLoaderLike> = {}): PluginLoaderLike {
  return {
    runSync: vi.fn().mockResolvedValue(undefined),
    runVerify: vi.fn().mockResolvedValue([]),
    syncPlugins: vi.fn().mockReturnValue([]),
    verifyPlugins: vi.fn().mockReturnValue([]),
    ...over,
  };
}

const WS = "00000000-0000-0000-0000-0000000000a1";
const bpc = vi.fn((opts: { workspaceId: string }) => ({ workspaceId: opts.workspaceId }));

afterEach(() => {
  delete process.env["MNEMO_PLUGIN_SYNC_INTERVAL_MS"];
});

describe("pluginSyncJobs", () => {
  it("schedules one job per syncing plugin on its own syncInterval, floored, with the env default", () => {
    process.env["MNEMO_PLUGIN_SYNC_INTERVAL_MS"] = "900000";
    const jobs = pluginSyncJobs({
      logger: makeLogger(),
      pluginLoader: loader({
        syncPlugins: () => [
          { id: "fast", syncInterval: 300_000, workspaceId: WS },
          { id: "plain" },
          { id: "tiny", syncInterval: 5 },
        ],
      }),
    });
    expect(jobs.map((j) => [j.key, j.schedule])).toEqual([
      ["mnemo.plugin.sync:fast", { kind: "interval", ms: 300_000 }],
      ["mnemo.plugin.sync:plain", { kind: "interval", ms: 900_000 }],
      ["mnemo.plugin.sync:tiny", { kind: "interval", ms: PLUGIN_SYNC_MIN_MS }],
    ]);
  });

  it("no loader, no jobs", () => {
    expect(pluginSyncJobs({ logger: makeLogger() })).toEqual([]);
  });

  it("MNEMO_CRON_DISABLE=mnemo.plugin.sync turns off every per-plugin job", () => {
    const logger = makeLogger();
    const handle = startCronRegistry(
      pluginSyncJobs({ logger, pluginLoader: loader({ syncPlugins: () => [{ id: "a" }] }) }),
      {
        logger,
        telemetry: { counter() {}, histogram() {} } as never,
        disabled: new Set(["mnemo.plugin.sync"]),
      }
    );
    handle.stop();
    expect(logger.info).toHaveBeenCalledWith({ cron: "mnemo.plugin.sync:a" }, "cron.disabled");
  });
});

describe("pluginSyncHandler", () => {
  it("syncs only that plugin, in the workspace from its config", async () => {
    const pluginLoader = loader();
    await pluginSyncHandler(
      { logger: makeLogger(), pluginLoader, buildPluginContext: bpc },
      "fast",
      WS
    );
    expect(pluginLoader.runSync).toHaveBeenCalledWith({ workspaceId: WS }, "fast");
  });

  it("skips with a warning when the plugin has no workspace configured", async () => {
    const logger = makeLogger();
    const pluginLoader = loader();
    await pluginSyncHandler({ logger, pluginLoader, buildPluginContext: bpc }, "plain", undefined);
    expect(pluginLoader.runSync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { plugin: "plain" },
      expect.stringContaining("WORKSPACE_ID")
    );
  });
});

describe("pluginVerifyHandler", () => {
  type Row = {
    id: string;
    statement: string;
    metadata: Record<string, unknown>;
    sensitivity: "public" | "internal" | "confidential" | "restricted";
  };
  const storage = (byWs: Record<string, Row[]>) => ({
    queryDriftCandidates: vi.fn(async (ws: string) => byWs[ws] ?? []),
    enqueueReviewItem: vi.fn().mockResolvedValue(undefined),
  });
  const OTHER = "00000000-0000-0000-0000-0000000000b2";

  it("verifies only the plugin's own workspace, up to its ceiling, with only id, content and metadata", async () => {
    const st = storage({
      [WS]: [
        {
          id: "f1",
          statement: "uses commit abc",
          metadata: { commitSha: "abc" },
          sensitivity: "internal",
        },
        {
          id: "f2",
          statement: "uses commit def",
          metadata: { commitSha: "def" },
          sensitivity: "public",
        },
        { id: "f3", statement: "secret infra", metadata: {}, sensitivity: "restricted" },
      ],
      [OTHER]: [{ id: "o1", statement: "other ws", metadata: {}, sensitivity: "public" }],
    });
    const runVerify = vi.fn().mockResolvedValue([
      { factId: "f1", valid: true },
      { factId: "f2", valid: false, reason: "commit not in repo" },
      { factId: "o1", valid: false },
    ]);
    const flagged = await pluginVerifyHandler({
      logger: makeLogger(),
      storage: st,
      buildPluginContext: bpc,
      pluginLoader: loader({
        runVerify,
        verifyPlugins: () => [{ id: "git-verifier", workspaceId: WS, maxSensitivity: "internal" }],
      }),
    });
    expect(st.queryDriftCandidates).toHaveBeenCalledTimes(1);
    expect(st.queryDriftCandidates).toHaveBeenCalledWith(WS);
    expect(runVerify).toHaveBeenCalledTimes(1);
    const [facts, ctx, pluginId] = runVerify.mock.calls[0]!;
    expect(facts).toEqual([
      { id: "f1", content: "uses commit abc", metadata: { commitSha: "abc" } },
      { id: "f2", content: "uses commit def", metadata: { commitSha: "def" } },
    ]);
    expect(ctx).toEqual({ workspaceId: WS });
    expect(pluginId).toBe("git-verifier");
    expect(flagged).toBe(1);
    expect(st.enqueueReviewItem).toHaveBeenCalledTimes(1);
    expect(st.enqueueReviewItem).toHaveBeenCalledWith({
      workspaceId: WS,
      primitiveId: "f2",
      primitiveKind: "fact",
      reason: "plugin_verification_failed",
      detail: { plugin: "git-verifier", reason: "commit not in repo" },
    });
  });

  it("skips a verifying plugin with no workspace configured, with a warning", async () => {
    const logger = makeLogger();
    const st = storage({});
    const runVerify = vi.fn();
    await pluginVerifyHandler({
      logger,
      storage: st,
      buildPluginContext: bpc,
      pluginLoader: loader({
        runVerify,
        verifyPlugins: () => [{ id: "git-verifier", maxSensitivity: "internal" }],
      }),
    });
    expect(st.queryDriftCandidates).not.toHaveBeenCalled();
    expect(runVerify).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { plugin: "git-verifier" },
      expect.stringContaining("WORKSPACE_ID")
    );
  });
});
