import { describe, it, expect, vi } from "vitest";
import type { PluginContext, PluginFact } from "../../index.js";

// The git-verifier test verifies the interface and no-op fallbacks.
// For commit reachability tests, we test the no-op path (no repoPath)
// and the "skips facts without sha" path without spawning real git.
// The integration path (valid/invalid commits) is a live-only test.
describe("git-verifier", () => {
  it("skips facts without commitSha", async () => {
    const { createGitVerifierPlugin } = await import("../git-verifier.js");
    const ctx = {
      workspaceId: "ws",
      config: { repoPath: "/fake/repo" },
      log: { info: vi.fn() },
    } as unknown as PluginContext;
    const p = createGitVerifierPlugin();
    const facts: PluginFact[] = [{ id: "f-3" }, { id: "f-4", metadata: { other: "data" } }];
    const results = await p.verify!(facts, ctx);
    expect(results).toHaveLength(0);
  });

  it("returns [] when no repoPath configured", async () => {
    const { createGitVerifierPlugin } = await import("../git-verifier.js");
    const p = createGitVerifierPlugin();
    const ctxNoRepo = {
      workspaceId: "ws",
      config: {},
      log: { info: vi.fn() },
    } as unknown as PluginContext;
    const results = await p.verify!([], ctxNoRepo);
    expect(results).toHaveLength(0);
  });

  it("marks a fact invalid when git cat-file fails (commit not in repo)", async () => {
    const { createGitVerifierPlugin } = await import("../git-verifier.js");
    const p = createGitVerifierPlugin();
    // Use the checkout this test runs in as repoPath, but with a SHA that won't exist
    const ctx = {
      workspaceId: "ws",
      config: { repoPath: process.cwd() },
      log: { info: vi.fn() },
    } as unknown as PluginContext;
    const facts: PluginFact[] = [
      { id: "f-2", metadata: { commitSha: "0000000000000000000000000000000000000000" } },
    ];
    const results = await p.verify!(facts, ctx);
    expect(results[0]).toMatchObject({ factId: "f-2", valid: false, reason: "commit not in repo" });
  });

  it("marks a fact valid when commit exists in repo", async () => {
    const { createGitVerifierPlugin } = await import("../git-verifier.js");
    const p = createGitVerifierPlugin();
    // Get a real commit SHA from the checkout this test runs in
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const repoPath = process.cwd();
    // No catch: outside a git checkout (or without git) this throws and the test
    // fails, instead of passing without having tested anything.
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repoPath });
    const realSha = stdout.trim();
    const ctx = {
      workspaceId: "ws",
      config: { repoPath },
      log: { info: vi.fn() },
    } as unknown as PluginContext;
    const facts: PluginFact[] = [{ id: "f-1", metadata: { commitSha: realSha } }];
    const results = await p.verify!(facts, ctx);
    expect(results[0]).toMatchObject({ factId: "f-1", valid: true });
  });
});
