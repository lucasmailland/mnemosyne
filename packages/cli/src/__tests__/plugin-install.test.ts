/**
 * Regression test for the `mnemo install` executable-bit bug.
 *
 * npm publish strips the executable bit from any file not declared in
 * package.json's `bin` field, so the published @mnemo-ai/cli tarball can
 * ship plugin/scripts/*.sh at 0644 even though the source repo tracks them
 * at 0755. copyClaudeCodePluginFiles must re-assert +x on every installed
 * scripts/*.sh regardless of what mode the source copy arrived in —
 * `existsSync` checks alone would not have caught this class of bug.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyClaudeCodePluginFiles } from "../commands.js";

function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

describe("copyClaudeCodePluginFiles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeFakePluginDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mnemo-plugin-src-"));
    dirs.push(dir);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    for (const f of ["session-start.sh", "user-prompt-submit.sh"]) {
      const p = join(dir, "scripts", f);
      writeFileSync(p, "#!/bin/bash\necho hi\n");
      // Simulate the real-world failure mode: npm strips +x from files not
      // declared in `bin` (verified against the published tarball, see
      // copyClaudeCodePluginFiles's doc comment) — source arrives at 0644.
      chmodSync(p, 0o644);
    }
    writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    return dir;
  }

  it("installs scripts as executable even when the source lost +x (npm publish stripping)", () => {
    const src = makeFakePluginDir();
    const target = mkdtempSync(join(tmpdir(), "mnemo-plugin-dst-"));
    dirs.push(target);

    copyClaudeCodePluginFiles(src, target);

    expect(isExecutable(join(target, "scripts", "session-start.sh"))).toBe(true);
    expect(isExecutable(join(target, "scripts", "user-prompt-submit.sh"))).toBe(true);
  });

  it("still installs scripts as executable when the source already had +x", () => {
    const src = makeFakePluginDir();
    chmodSync(join(src, "scripts", "session-start.sh"), 0o755);
    const target = mkdtempSync(join(tmpdir(), "mnemo-plugin-dst-"));
    dirs.push(target);

    copyClaudeCodePluginFiles(src, target);

    expect(isExecutable(join(target, "scripts", "session-start.sh"))).toBe(true);
  });

  it("copies hooks and .claude-plugin alongside scripts", () => {
    const src = makeFakePluginDir();
    const target = mkdtempSync(join(tmpdir(), "mnemo-plugin-dst-"));
    dirs.push(target);

    copyClaudeCodePluginFiles(src, target);

    expect(() => statSync(join(target, "hooks", "hooks.json"))).not.toThrow();
    expect(() => statSync(join(target, ".claude-plugin", "plugin.json"))).not.toThrow();
  });
});
