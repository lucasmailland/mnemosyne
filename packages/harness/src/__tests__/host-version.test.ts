/**
 * A qualification record is matched on string equality of `hostVersion`. These
 * tests pin the normalisation, because a drift between writer and reader does not
 * throw — it silently stops matching, and every host falls to `mcp-only`.
 */
import { describe, expect, it } from "vitest";

import {
  readHostVersion,
  type HostVersionSpawn,
  type HostVersionSpawnResult,
} from "../host-version.js";

/** A spawn that records what it was asked and answers with a canned result. */
function fakeSpawn(result: HostVersionSpawnResult, calls: unknown[][] = []): HostVersionSpawn {
  return (...args: unknown[]) => {
    calls.push(args);
    return { stdout: "", status: 0, signal: null, ...result };
  };
}

describe("per-host normalisation matches what the qualifier records", () => {
  it.each([
    ["opencode", "0.5.12\n", "0.5.12"],
    // Claude Code prints `2.0.1 (Claude Code)`; only the first token is recorded.
    ["claude-code", "2.0.1 (Claude Code)\n", "2.0.1"],
    // Codex prints `codex-cli 0.153.4`, and the whole string is the version.
    ["codex", "codex-cli 0.153.4\n", "codex-cli 0.153.4"],
  ] as const)("%s: %j normalises to %j", (host, stdout, expected) => {
    const result = readHostVersion(host, { spawn: fakeSpawn({ stdout }), env: {} });
    expect(result).toEqual({ version: expected });
  });

  it("asks the binary for --version without a shell, and with a timeout", () => {
    const calls: unknown[][] = [];
    readHostVersion("codex", { spawn: fakeSpawn({ stdout: "codex-cli 1.0" }, calls), env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("codex");
    expect(calls[0]?.[1]).toEqual(["--version"]);
    expect(calls[0]?.[2]).toMatchObject({ shell: false, timeout: 5000 });
  });
});

describe("every reachable failure is an answer, not an exception", () => {
  it("a non-zero exit is an error, never an empty version", () => {
    const result = readHostVersion("codex", { spawn: fakeSpawn({ status: 127 }), env: {} });
    expect(result).toEqual({ error: expect.stringContaining("exited 127") });
  });

  it("a timeout kill is an error", () => {
    const result = readHostVersion("codex", {
      spawn: fakeSpawn({ signal: "SIGTERM", status: null }),
      env: {},
    });
    expect(result).toEqual({ error: expect.stringContaining("SIGTERM") });
  });

  it("an absent binary is an error", () => {
    const result = readHostVersion("opencode", {
      spawn: fakeSpawn({ error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
      env: {},
    });
    expect(result).toEqual({ error: expect.stringContaining("ENOENT") });
  });

  it("a binary that prints nothing is an error, not an empty match key", () => {
    const result = readHostVersion("codex", { spawn: fakeSpawn({ stdout: "  \n" }), env: {} });
    expect(result).toEqual({ error: expect.stringContaining("printed nothing") });
  });
});

describe("$OPENCODE_VERSION is an override, and only OpenCode has one", () => {
  it("takes precedence over the spawn, and does not spawn at all", () => {
    const calls: unknown[][] = [];
    const result = readHostVersion("opencode", {
      spawn: fakeSpawn({ stdout: "9.9.9" }, calls),
      env: { OPENCODE_VERSION: "0.5.12" },
    });
    expect(result).toEqual({ version: "0.5.12" });
    expect(calls).toHaveLength(0);
  });

  it("an empty override falls through to the spawn rather than matching on nothing", () => {
    const result = readHostVersion("opencode", {
      spawn: fakeSpawn({ stdout: "0.5.12" }),
      env: { OPENCODE_VERSION: "   " },
    });
    expect(result).toEqual({ version: "0.5.12" });
  });

  it("the other hosts ignore it", () => {
    const result = readHostVersion("codex", {
      spawn: fakeSpawn({ stdout: "codex-cli 0.153.4" }),
      env: { OPENCODE_VERSION: "0.5.12" },
    });
    expect(result).toEqual({ version: "codex-cli 0.153.4" });
  });
});
