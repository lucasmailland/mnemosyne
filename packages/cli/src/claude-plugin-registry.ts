/**
 * Where Claude Code says the Mnemosyne plugin is installed.
 *
 * Both install modes register `mnemosyne@mnemosyne` in Claude Code's own
 * `plugins/installed_plugins.json`: `claude plugin install` writes it, and
 * `--local` writes the same entry for its copy. That entry's `installPath` is the
 * payload Claude Code loads, so it is the only place a check of "is the plugin
 * installed" can look without guessing a cache layout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_ID = "mnemosyne@mnemosyne";

/**
 * Reads back `installed_plugins.json` after `claude plugin install` to
 * confirm a real `mnemosyne@mnemosyne` entry with a non-empty `gitCommitSha`
 * exists — the state-based fatal check that blocks a fabricated success even
 * when `claude` itself exits 0. Returns `null` on any missing/malformed
 * file, missing entry, or missing `installPath`.
 */
export function readInstalledPluginEntry(
  configDir: string
): { installPath: string; gitCommitSha?: string } | null {
  const pluginsJsonPath = join(configDir, "plugins", "installed_plugins.json");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(pluginsJsonPath, "utf8"));
  } catch {
    return null;
  }

  const plugins = (data.plugins ?? {}) as Record<string, unknown>;
  const entries = plugins[PLUGIN_ID];
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const entry = entries[entries.length - 1] as Record<string, unknown>;
  const installPath = entry.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) return null;

  const gitCommitSha = typeof entry.gitCommitSha === "string" ? entry.gitCommitSha : undefined;
  return { installPath, gitCommitSha };
}
