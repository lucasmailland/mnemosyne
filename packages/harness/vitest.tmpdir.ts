import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The TMPDIR test workers get, so test homes can live under os.tmpdir().
 *
 * turbo's strict env mode drops TMPDIR, tmpdir() then falls back to /tmp, and the
 * harness refuses a HOME under a world-writable directory. That is why test homes
 * used to be made under the developer's real $HOME, where they piled up (APP-053).
 * The private per-user temp dir is still there when the variable is not: ask for it.
 * Shared with the CLI's vitest config.
 */
export function privateTmpdir(): string {
  if (process.env.TMPDIR) return process.env.TMPDIR;
  if (process.platform === "darwin")
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ""}`;
  return existsSync(runtimeDir) ? runtimeDir : tmpdir();
}
