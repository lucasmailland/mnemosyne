/**
 * L3 — --workspace flag / MNEMO_WORKSPACE_ID env / .mnemo.json precedence.
 */
import { describe, expect, it } from "vitest";
import { extractGlobalFlags, resolveWorkspaceId } from "../workspace-flag.js";

describe("resolveWorkspaceId precedence: flag > env > .mnemo.json", () => {
  const project = { path: "/repo/.mnemo.json", config: { workspaceId: "ws-from-project" } };

  it("flag wins over everything", () => {
    expect(resolveWorkspaceId({ flag: "ws-from-flag", env: "ws-from-env", project })).toBe(
      "ws-from-flag"
    );
  });

  it("env wins when flag is absent", () => {
    expect(resolveWorkspaceId({ env: "ws-from-env", project })).toBe("ws-from-env");
  });

  it("falls back to .mnemo.json when neither flag nor env is set", () => {
    expect(resolveWorkspaceId({ project })).toBe("ws-from-project");
  });

  it("returns undefined when nothing is set", () => {
    expect(resolveWorkspaceId({})).toBeUndefined();
    expect(resolveWorkspaceId({ project: null })).toBeUndefined();
  });
});

describe("extractGlobalFlags", () => {
  it("extracts leading --workspace and --locale in any order", () => {
    expect(extractGlobalFlags(["--locale", "es", "--workspace", "w", "recall", "q"])).toEqual({
      argv: ["recall", "q"],
      workspace: "w",
      locale: "es",
    });
    expect(extractGlobalFlags(["--workspace", "w", "--locale", "es", "recall"]).argv).toEqual([
      "recall",
    ]);
  });

  it("leaves them alone after the subcommand or without a value", () => {
    expect(extractGlobalFlags(["recall", "--locale", "es", "q"]).argv).toEqual([
      "recall",
      "--locale",
      "es",
      "q",
    ]);
    expect(extractGlobalFlags(["--locale"]).argv).toEqual(["--locale"]);
  });
});
