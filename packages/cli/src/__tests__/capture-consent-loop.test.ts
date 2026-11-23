/**
 * The off-switch, end to end.
 *
 * `disableHost` used to return `{disabled: true}` having disabled nothing, which
 * is the worst shape a rollback step can take: the operator is told capture
 * stopped, and it did not. Now that consent is a file, disabling is removing it,
 * and that is what these assert — through the real wiring, not a fake.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harnessLifecycleDeps } from "../commands.js";

// Imported lazily, exactly as `commands.ts` does. A static import here would
// make Vite resolve the harness's built entry at import-scan time, and the
// harness's own package test runs `pnpm pack`, whose prepack build wipes that
// dist — see the note in vitest.config.ts.
type Harness = typeof import("@mnemo-ai/harness");
const harness = async (): Promise<Harness> => import("@mnemo-ai/harness");

const roots: string[] = [];
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  // os.homedir() reads $HOME on POSIX, which is the only seam the CLI path has:
  // it calls into the harness without a `home` option, exactly as it does live.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-consent-loop-")));
  roots.push(home);
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONSENT = {
  host: "claude-code",
  mode: "user-only",
  hostVersion: "2.1.267",
  packageHash: "a".repeat(64),
} as const;

describe("mnemo harness disable actually turns capture off", () => {
  it("removes the marker a consented host had", async () => {
    await (await harness()).writeCaptureConsent(CONSENT);
    await expect((await harness()).readCaptureConsent("claude-code")).resolves.not.toBeNull();

    const deps = await harnessLifecycleDeps();
    await expect(deps.disableHost({ host: "claude-code" })).resolves.toMatchObject({
      disabled: true,
    });

    await expect((await harness()).readCaptureConsent("claude-code")).resolves.toBeNull();
  });

  it("reports success for an already-disabled host", async () => {
    const deps = await harnessLifecycleDeps();
    // Idempotent: the caller asked for capture to be off, and it is off.
    await expect(deps.disableHost({ host: "codex" })).resolves.toMatchObject({ disabled: true });
  });

  it("disables one host without touching another", async () => {
    await (await harness()).writeCaptureConsent(CONSENT);
    await (await harness()).writeCaptureConsent({ ...CONSENT, host: "codex", mode: "mcp-only" });

    const deps = await harnessLifecycleDeps();
    await deps.disableHost({ host: "claude-code" });

    await expect((await harness()).readCaptureConsent("claude-code")).resolves.toBeNull();
    await expect((await harness()).readCaptureConsent("codex")).resolves.toMatchObject({
      host: "codex",
    });
  });

  it("refuses a host name it does not know rather than reporting a disable", async () => {
    const deps = await harnessLifecycleDeps();
    // The name becomes a path component; an unknown one is never interpolated.
    await expect(deps.disableHost({ host: "../../etc/passwd" })).resolves.toMatchObject({
      disabled: false,
    });
  });

  it("leaves the queue deliverable, which the operator is told explicitly", async () => {
    await (await harness()).writeCaptureConsent(CONSENT);
    const deps = await harnessLifecycleDeps();
    const result = await deps.disableHost({ host: "claude-code" });
    // Disabling capture must not strand events already recorded.
    expect(result.ingestionStillAvailable).toBe(true);
    await (await harness()).clearCaptureConsent("claude-code");
  });
});

describe("the loop closes: an install turns capture on, a disable turns it off", () => {
  /** The real effects, minus the two things a test cannot have: a host binary
   *  on PATH and a reachable server. Everything that writes is genuine. */
  async function realishEffects(home: string, pluginDir: string) {
    const { captureEffects } = await import("../capture-effects.js");
    const base = captureEffects({ home, pluginDir, harness: await harness(), platform: "darwin" });
    return {
      ...base,
      readHostVersion: () => ({ version: "1.18.29" }),
      resolveMode: () => ({
        mode: "user-only" as const,
        reason: "unproven capabilities: transcript",
      }),
      bind: async () => ({ rebound: false }),
      confirm: async () => "yes" as const,
    };
  }

  it("writes a marker the runtime gate can read, and disable removes it", async () => {
    const home = process.env.HOME!;
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), "{}\n");
    const pluginDir = join(import.meta.dirname, "..", "..", "..", "plugin");

    const { installCaptureHosts } = await import("../capture-install.js");
    const outcomes = await installCaptureHosts(
      {
        hosts: ["opencode"],
        acceptDegraded: false,
        serverUrl: "https://memory.example.com",
        apiKey: "mns_live_fake",
        workspaceId: "workspace-a",
      },
      await realishEffects(home, pluginDir)
    );

    expect(outcomes[0]).toMatchObject({ artifact: "installed", mode: "user-only" });
    // This is the whole point: without the marker the artifacts are inert.
    await expect((await harness()).readCaptureConsent("opencode")).resolves.toMatchObject({
      host: "opencode",
      mode: "user-only",
    });

    const deps = await harnessLifecycleDeps();
    await deps.disableHost({ host: "opencode" });
    await expect((await harness()).readCaptureConsent("opencode")).resolves.toBeNull();
  });

  it("selects the managed writer for full capture and leaves degraded modes to the legacy writer", async () => {
    const home = process.env.HOME!;
    const pluginDir = join(import.meta.dirname, "..", "..", "..", "plugin");
    const fx = await realishEffects(home, pluginDir);

    await fx.writeConsent({ host: "claude-code", mode: "full", hostVersion: "2.1.0" });
    // _helpers.sh routes to harness-hook.sh only on this exact value.
    await expect((await harness()).readCaptureConsent("claude-code")).resolves.toMatchObject({
      host: "claude-code",
      mode: "full",
      writer: "managed",
    });

    await fx.writeConsent({ host: "claude-code", mode: "user-only", hostVersion: "2.1.0" });
    const degraded = await (await harness()).readCaptureConsent("claude-code");
    expect(degraded).toMatchObject({ mode: "user-only" });
    expect(degraded?.writer).toBeUndefined();
    await (await harness()).clearCaptureConsent("claude-code");
  });

  it("writes no marker for a host the user declined", async () => {
    const home = process.env.HOME!;
    const pluginDir = join(import.meta.dirname, "..", "..", "..", "plugin");
    const { installCaptureHosts } = await import("../capture-install.js");

    const outcomes = await installCaptureHosts(
      {
        hosts: ["codex"],
        acceptDegraded: false,
        serverUrl: "https://memory.example.com",
        apiKey: "mns_live_fake",
        workspaceId: "workspace-a",
      },
      {
        ...(await realishEffects(home, pluginDir)),
        resolveMode: () => ({ mode: "mcp-only" as const, reason: "hooks are off" }),
        confirm: async () => "no" as const,
      }
    );

    expect(outcomes[0]).toMatchObject({ consent: "declined", artifact: "skipped" });
    await expect((await harness()).readCaptureConsent("codex")).resolves.toBeNull();
  });
});
