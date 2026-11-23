import type { ProjectConfigResult } from "./project-config.js";

export interface WorkspaceIdSources {
  /** From a leading `--workspace <id>` (see extractGlobalFlags). */
  flag?: string;
  /** From `process.env.MNEMO_WORKSPACE_ID`. */
  env?: string;
  /** From `.mnemo.json` (see `findProjectConfig`). */
  project?: ProjectConfigResult | null;
}

/**
 * L3 — resolve which workspace this CLI invocation should send as
 * `X-Workspace-Id` (only meaningful with a `uk_live_*` user token; a plain
 * workspace key ignores it server-side). Precedence, most to least specific:
 * `--workspace` flag > `MNEMO_WORKSPACE_ID` env > `.mnemo.json`'s
 * `workspaceId` field. Mirrors the MCP server's own precedence
 * (env-only there, since it has no per-invocation flag or repo-local file).
 */
export function resolveWorkspaceId(sources: WorkspaceIdSources): string | undefined {
  if (sources.flag) return sources.flag;
  if (sources.env) return sources.env;
  return sources.project?.config.workspaceId;
}

/**
 * Extract the leading global flags `--workspace <id>` and `--locale <tag>`, in
 * any order, up to the subcommand name. Deliberately ONLY recognized when they
 * precede the subcommand name (`mnemo --workspace <id> <command> ...`) — several
 * subcommands already define their OWN `--workspace <id>` flag with an unrelated
 * meaning (`reset --workspace <id>` targets a workspace for a destructive admin
 * action; `token issue ... --workspace <id>` sets a NEW token's home workspace).
 * After the subcommand a `--workspace` (or `--locale`) is left in argv untouched.
 */
export function extractGlobalFlags(argv: readonly string[]): {
  argv: string[];
  workspace?: string;
  locale?: string;
} {
  const out: { argv: string[]; workspace?: string; locale?: string } = { argv: [...argv] };
  for (;;) {
    const [flag, value] = out.argv;
    if (value === undefined) break;
    if (flag === "--workspace") out.workspace = value;
    else if (flag === "--locale") out.locale = value;
    else break;
    out.argv = out.argv.slice(2);
  }
  return out;
}
