import { t } from "./i18n/index.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProjectConfig {
  workspaceId: string;
  label?: string;
}

export interface ProjectConfigResult {
  path: string;
  config: ProjectConfig;
}

/**
 * Walk up from `startDir` looking for `.mnemo.json`, stopping at the first
 * `.git` entry (file or directory — worktrees use a file) so a config
 * committed in one repo can never leak into a sibling repo that lacks its
 * own. Malformed JSON or a missing `workspaceId` is treated as absent, with
 * a warning to stderr — never a thrown error.
 */
export function findProjectConfig(startDir: string): ProjectConfigResult | null {
  let dir = startDir;

  for (;;) {
    const configPath = join(dir, ".mnemo.json");
    if (existsSync(configPath)) {
      let parsed: unknown;
      let parseError = false;

      try {
        parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        console.error(t("cli.warningCouldNotParse", { configPath }));
        parseError = true;
      }

      if (!parseError) {
        // JSON parsed successfully, check if it's a valid config object
        if (typeof parsed === "object" && parsed !== null) {
          const config = parsed as Partial<ProjectConfig>;
          if (typeof config.workspaceId === "string" && config.workspaceId.length > 0) {
            // Valid config found
            return {
              path: configPath,
              config: {
                workspaceId: config.workspaceId,
                ...(typeof config.label === "string" ? { label: config.label } : {}),
              },
            };
          }
        }
        // JSON was valid but not a proper config object or missing workspaceId
        console.error(t("cli.warningIsMissingA", { configPath }));
      }
      // Fall through to .git boundary check and parent climb (both error cases)
    }

    if (existsSync(join(dir, ".git"))) {
      // Repo root reached with no .mnemo.json here — stop. Do not climb
      // into a parent directory that may belong to an unrelated repo.
      return null;
    }

    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}
