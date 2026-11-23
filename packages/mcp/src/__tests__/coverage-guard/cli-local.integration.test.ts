/**
 * B4.3 — CLI command coverage fill-in: local-only commands (design.md "B4.
 * Coverage fill-in", spec.md Requirement 13). Exercises `mnemo config`,
 * `help`, `status`, `version`, `completion` via `surface.cli(args)` — the
 * real built `mnemo` binary as a subprocess. `config`, `help`, `version`,
 * and `completion` never call the live server at all (B1.3's
 * `command-routes.snapshot.json` records an empty route array for each) —
 * exercising them means asserting on real stdout/side effects, not an HTTP
 * response shape.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLiveSurface, type LiveSurface } from "../harness/live-surface.js";

let surface: LiveSurface;

beforeAll(async () => {
  surface = await startLiveSurface();
}, 120_000);

afterAll(async () => {
  await surface.close();
});

describe("mnemo config (B4.3)", () => {
  it("get — reads real url/apiKey resolved from MNEMO_URL/MNEMO_KEY, masked", async () => {
    const result = await surface.cli(["config", "get"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { url: string; apiKey: string };
    expect(body.url).toBe(surface.baseUrl);
    // maskApiKey() keeps only the last 4 chars; the harness's plaintext key
    // ends in "0001".
    expect(body.apiKey).toContain("0001");
    expect(body.apiKey).not.toContain(surface.apiKey);
  });

  it("set — writes ~/.mnemo/config.json for real, isolated to a throwaway HOME so the actual host config is never touched", async () => {
    // Real host-mutation problem (same class B1.3 permanently skipped for
    // login/init/install/link): cmdConfigSet() writes unconditionally to
    // join(homedir(), ".mnemo", "config.json"). Overriding HOME to a fresh
    // temp dir here lets this be exercised for real (a genuine write,
    // verified by reading the file back) without mutating whatever machine
    // runs this suite.
    const isolatedHome = mkdtempSync(join(tmpdir(), "mnemo-b4.3-config-home-"));

    const setUrl = await surface.cli(["config", "set", "url", "http://b4.3-cli-config.example"], {
      HOME: isolatedHome,
    });
    expect(setUrl.code).toBe(0);
    expect(setUrl.stderr).toContain("Set url = http://b4.3-cli-config.example");

    const setKey = await surface.cli(["config", "set", "apiKey", "mns_live_b4dot3clitestkey0001"], {
      HOME: isolatedHome,
    });
    expect(setKey.code).toBe(0);

    const configPath = join(isolatedHome, ".mnemo", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf-8")) as {
      url: string;
      apiKey: string;
    };
    expect(written.url).toBe("http://b4.3-cli-config.example");
    expect(written.apiKey).toBe("mns_live_b4dot3clitestkey0001");
  });

  it("set — rejects an unknown config key", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "mnemo-b4.3-config-home-bad-"));
    const result = await surface.cli(["config", "set", "notAKey", "value"], {
      HOME: isolatedHome,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown config key");
  });
});

describe("mnemo help (B4.3)", () => {
  it("prints the real command reference — no server call", async () => {
    const result = await surface.cli(["help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mnemo — Mnemosyne CLI");
    expect(result.stdout).toContain("recall");
    expect(result.stdout).toContain("remember");
  });

  it("running with no arguments also prints help", async () => {
    const result = await surface.cli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });
});

describe("mnemo version (B4.3)", () => {
  it("prints the real installed CLI version — no server call", async () => {
    const result = await surface.cli(["version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^mnemo \S+/);
  });

  it("--version is a global alias", async () => {
    const result = await surface.cli(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^mnemo \S+/);
  });
});

describe("mnemo status (B4.3)", () => {
  it("prints real cognitive vitals (alias for GET /health)", async () => {
    const result = await surface.cli(["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // GET /health returns the cognitive-vitals snapshot (workspaceId,
    // computedAt, worthConvergenceRate, ...) — NOT a generic {status: "ok"}
    // envelope (that's GET /health/ready instead). cmdStatus() colorizes any
    // ok/healthy/degraded/... string values with real ANSI codes.
    // eslint-disable-next-line no-control-regex
    const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const body = JSON.parse(plain) as Record<string, unknown>;
    expect(body.workspaceId).toBe(surface.workspaceId);
  });
});

describe("mnemo completion (B4.3)", () => {
  it("generates a real bash completion script — no server call", async () => {
    const result = await surface.cli(["completion", "bash"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("mnemo");
    expect(result.stdout.length).toBeGreaterThan(50);
  });

  it("rejects an unsupported shell", async () => {
    const result = await surface.cli(["completion", "notashell"]);
    expect(result.code).not.toBe(0);
  });
});
