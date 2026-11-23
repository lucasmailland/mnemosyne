import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig } from "../project-config.js";

describe("findProjectConfig", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds .mnemo.json at cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-1", label: "test" }));

    const result = findProjectConfig(dir);

    expect(result?.config).toEqual({ workspaceId: "ws-1", label: "test" });
    expect(result?.path).toBe(join(dir, ".mnemo.json"));
  });

  it("finds .mnemo.json by walking up from a nested subdirectory", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-1" }));
    const nested = join(dir, "packages", "cli", "src");
    mkdirSync(nested, { recursive: true });

    const result = findProjectConfig(nested);

    expect(result?.config.workspaceId).toBe("ws-1");
  });

  it("stops at a .git directory boundary and does not climb into the parent", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    // Parent has a .mnemo.json...
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "parent-ws" }));
    // ...but the sibling repo below it has its own .git and no .mnemo.json of its own.
    const siblingRepo = join(dir, "sibling-repo");
    mkdirSync(join(siblingRepo, ".git"), { recursive: true });

    const result = findProjectConfig(siblingRepo);

    expect(result).toBeNull();
  });

  it("stops at a .git FILE boundary (worktree case), not just a .git directory", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "parent-ws" }));
    const worktree = join(dir, "worktree-repo");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /some/main/repo/.git/worktrees/worktree-repo\n");

    const result = findProjectConfig(worktree);

    expect(result).toBeNull();
  });

  it("returns null and warns to stderr on malformed JSON, without throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), "{ not valid json");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    try {
      result = findProjectConfig(dir);
    } finally {
      console.error = originalError;
    }

    expect(result).toBeNull();
    expect(errors.join("\n")).toContain("could not parse");
  });

  it("returns null and warns when workspaceId is missing or not a string", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ label: "no workspaceId here" }));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    try {
      result = findProjectConfig(dir);
    } finally {
      console.error = originalError;
    }

    expect(result).toBeNull();
    expect(errors.join("\n")).toContain("workspaceId");
  });

  it("returns null when no .mnemo.json and no .git exist anywhere up to the fs root", () => {
    // A temp dir with no .git and no .mnemo.json, and no ancestor of it has
    // one either in the fast path we care about: walking up from a fresh
    // tmpdir should hit the real filesystem root eventually returning null,
    // NOT throw or loop forever. We just assert it terminates and returns
    // null for the immediate case (no .git in the tmp dir itself).
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));

    const result = findProjectConfig(dir);

    expect(result).toBeNull();
  });

  it("continues walk past malformed .mnemo.json to find a valid ancestor config", () => {
    // Grandparent has valid config
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-ancestor" }));
    // Child has malformed .mnemo.json
    const child = join(dir, "sub", "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".mnemo.json"), "{ not valid json");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    try {
      result = findProjectConfig(child);
    } finally {
      console.error = originalError;
    }

    // Should find grandparent's config, not return null
    expect(result?.config.workspaceId).toBe("ws-ancestor");
    expect(errors.join("\n")).toContain("could not parse");
  });

  it("continues walk past .mnemo.json with invalid workspaceId to find a valid ancestor config", () => {
    // Grandparent has valid config
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-ancestor" }));
    // Child has invalid .mnemo.json (missing workspaceId)
    const child = join(dir, "sub", "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".mnemo.json"), JSON.stringify({ label: "no workspaceId" }));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    try {
      result = findProjectConfig(child);
    } finally {
      console.error = originalError;
    }

    // Should find grandparent's config, not return null
    expect(result?.config.workspaceId).toBe("ws-ancestor");
    expect(errors.join("\n")).toContain("workspaceId");
  });

  it("does not throw when .mnemo.json contains valid JSON that is not an object (e.g., null)", () => {
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), "null");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    let threwError = false;
    try {
      result = findProjectConfig(dir);
    } catch {
      threwError = true;
    } finally {
      console.error = originalError;
    }

    expect(threwError).toBe(false);
    expect(result).toBeNull();
  });

  it("continues walk past .mnemo.json with non-object JSON to find a valid ancestor config", () => {
    // Grandparent has valid config
    dir = mkdtempSync(join(tmpdir(), "mnemo-proj-"));
    writeFileSync(join(dir, ".mnemo.json"), JSON.stringify({ workspaceId: "ws-ancestor" }));
    // Child has .mnemo.json with null (valid JSON, but not an object)
    const child = join(dir, "sub", "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, ".mnemo.json"), "null");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(String(args[0]));

    let result;
    try {
      result = findProjectConfig(child);
    } finally {
      console.error = originalError;
    }

    // Should find grandparent's config, not return null
    expect(result?.config.workspaceId).toBe("ws-ancestor");
  });
});
