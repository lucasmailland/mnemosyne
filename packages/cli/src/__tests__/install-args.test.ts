/**
 * Requirement 1 is a table of argv shapes, so this is that table.
 *
 * The property under test is not "it parses" — it is that every ambiguity is an
 * ERROR. A flag that turns on recording of the user's conversations is the last
 * place to be charitable about what someone probably meant.
 */
import { describe, expect, it } from "vitest";

import { parseInstallArgs } from "../install-args.js";

const ok = (argv: string[]) => {
  const result = parseInstallArgs(argv);
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result.args;
};

const err = (argv: string[]) => {
  const result = parseInstallArgs(argv);
  if (result.ok) throw new Error(`expected failure, got: ${JSON.stringify(result.args)}`);
  return result.error;
};

describe("capture is opt-in, and absent by default", () => {
  it("parses an empty argv as no capture at all", () => {
    expect(ok([])).toEqual({ local: false, acceptDegraded: false, capture: [] });
  });

  it("leaves capture empty for a plain --local install", () => {
    expect(ok(["--local"])).toEqual({ local: true, acceptDegraded: false, capture: [] });
  });
});

describe("the host list", () => {
  it("accepts all three hosts", () => {
    expect(ok(["--capture", "opencode,claude-code,codex"]).capture).toEqual([
      "opencode",
      "claude-code",
      "codex",
    ]);
  });

  it("treats --capture=a,b and --capture a,b as the same request", () => {
    expect(ok(["--capture=opencode,codex"]).capture).toEqual(
      ok(["--capture", "opencode,codex"]).capture
    );
  });

  it("de-duplicates while preserving first-occurrence order", () => {
    // This order is also the order the install summary reports in.
    expect(ok(["--capture", "codex,opencode,codex"]).capture).toEqual(["codex", "opencode"]);
  });

  it("combines with the other flags", () => {
    expect(ok(["--local", "--capture", "opencode", "--accept-degraded"])).toEqual({
      local: true,
      acceptDegraded: true,
      capture: ["opencode"],
    });
  });

  it("tolerates surrounding whitespace in a list element", () => {
    expect(ok(["--capture", "opencode, codex"]).capture).toEqual(["opencode", "codex"]);
  });
});

describe("every ambiguity is an error, never a guess", () => {
  it("names the offending host rather than skipping it", () => {
    const message = err(["--capture", "opencode,vscode"]);
    expect(message).toContain("vscode");
    expect(message).toContain("opencode, claude-code, codex");
  });

  it("rejects an empty element instead of silently dropping it", () => {
    expect(err(["--capture", "opencode,,codex"])).toMatch(/empty host name/);
    expect(err(["--capture", "opencode,"])).toMatch(/empty host name/);
  });

  it("rejects --capture with no value", () => {
    expect(err(["--capture"])).toMatch(/requires a comma-separated host list/);
  });

  it("does not swallow the following flag as a value", () => {
    // `--capture --local` would otherwise install capture for a host named
    // "--local", or for nothing at all, depending on where it failed.
    expect(err(["--capture", "--local"])).toMatch(/requires a comma-separated host list/);
  });

  it("rejects a repeated --capture rather than taking the last one", () => {
    expect(err(["--capture", "opencode", "--capture", "codex"])).toMatch(/only be given once/);
  });

  it("rejects --accept-degraded on its own", () => {
    // The user believes capture is being installed. It is not.
    expect(err(["--accept-degraded"])).toMatch(/only means something with --capture/);
  });

  it("rejects a value attached to a switch", () => {
    expect(err(["--local=true"])).toMatch(/does not take a value/);
  });

  it("rejects an unknown flag with the existing message shape", () => {
    const message = err(["--wat"]);
    expect(message).toContain("Unknown option for 'install': --wat.");
    expect(message).toContain("Valid options: --local, --accept-degraded, --capture.");
    expect(message).toContain("Run 'mnemo --help' for usage.");
  });

  it("pluralises and lists every unknown token", () => {
    expect(err(["--wat", "stray"])).toContain("Unknown options for 'install': --wat, stray.");
  });

  it("rejects a stray positional even alongside valid flags", () => {
    // Install takes no positionals; a stray one is likelier a typo'd flag.
    expect(err(["--capture", "opencode", "claude-code"])).toContain("claude-code");
  });
});
