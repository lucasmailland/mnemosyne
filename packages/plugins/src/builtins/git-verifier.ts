import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MnemoPlugin, PluginFact, VerificationResult } from "../index.js";

// execFile (arg-array form) — NOT exec — so user/fact data never reaches a shell.
const run = promisify(execFile);

export function createGitVerifierPlugin(): MnemoPlugin {
  return {
    id: "git-verifier",
    name: "Git Verifier",
    version: "1.0.0",
    description: "Flag facts whose referenced commit is gone for review (daily cron).",
    verify: async (facts: PluginFact[], ctx): Promise<VerificationResult[]> => {
      const repo = ctx.config.repoPath;
      if (!repo) {
        ctx.log?.info?.("git-verifier: no repoPath, skipping");
        return [];
      }
      const out: VerificationResult[] = [];
      for (const f of facts) {
        const sha = (f.metadata as { commitSha?: string } | undefined)?.commitSha;
        if (!sha) continue;
        try {
          await run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo });
          out.push({ factId: f.id, valid: true });
        } catch {
          out.push({ factId: f.id, valid: false, reason: "commit not in repo" });
        }
      }
      return out;
    },
  };
}
