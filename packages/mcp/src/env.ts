import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOCALE } from "@mnemo-ai/types";
import { mcpLocale, t } from "./i18n/index.js";

function projectWorkspaceId(start: string): string | undefined {
  let directory = start;
  for (;;) {
    const config = join(directory, ".mnemo.json");
    if (existsSync(config)) {
      try {
        const value: unknown = JSON.parse(readFileSync(config, "utf8"));
        if (
          value &&
          typeof value === "object" &&
          "workspaceId" in value &&
          typeof value.workspaceId === "string" &&
          value.workspaceId.trim()
        ) {
          return value.workspaceId.trim();
        }
      } catch {
        /* Ignore invalid project binding. */
      }
    }
    if (existsSync(join(directory, ".git"))) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** What every call may take, unless MNEMO_MCP_TIMEOUT_MS says otherwise. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** A session collapse runs an LLM pass: ~50 s measured on the default stack (APP-014). */
export const COLLAPSE_TIMEOUT_MS = 120_000;
export const TIMEOUT_BOUNDS_MS = { min: 1_000, max: 600_000 } as const;

/**
 * MNEMO_MCP_TIMEOUT_MS: whole milliseconds within TIMEOUT_BOUNDS_MS. Anything
 * else falls back to the default and is reported in `invalid` for the caller
 * to warn about once, at startup.
 */
export function mcpTimeoutMs(
  raw: string | undefined = process.env.MNEMO_MCP_TIMEOUT_MS
): { ms: number; invalid?: string } {
  const value = raw?.trim();
  if (!value) return { ms: DEFAULT_TIMEOUT_MS };
  const ms = Number(value);
  return Number.isInteger(ms) && ms >= TIMEOUT_BOUNDS_MS.min && ms <= TIMEOUT_BOUNDS_MS.max
    ? { ms }
    : { ms: DEFAULT_TIMEOUT_MS, invalid: value };
}

/** A collapse never gets less than COLLAPSE_TIMEOUT_MS, nor less than every other call. */
export const collapseTimeoutMs = (): number => Math.max(COLLAPSE_TIMEOUT_MS, mcpTimeoutMs().ms);

/**
 * Read required environment variables. Returns `null` (and prints help)
 * when any are missing so `index.ts` can exit cleanly from `main`.
 *
 * We deliberately do NOT use a dependency like dotenv here — MCP servers
 * inherit env from the client config (`"env": {...}` in claude_desktop_config.json),
 * which is the supported configuration surface. Importing dotenv would
 * silently shadow that and confuse users debugging connection issues.
 *
 * Lives in its own module (not index.ts) so it can be unit-tested without
 * importing index.ts's module-level `main().catch(...)` side effect (which
 * calls `process.exit`/starts a real stdio server on import).
 */
export function readEnv(): { url: string; key: string; workspaceId?: string } | null {
  const url = process.env.MNEMO_URL?.trim();
  const key = process.env.MNEMO_KEY?.trim();
  // M3 — optional: which workspace a uk_live_* user token should operate
  // against, sent as X-Workspace-Id on every request via
  // MnemosyneClientOptions.workspaceId. Set once at process start, same as
  // MNEMO_URL/MNEMO_KEY — there is deliberately no tool that changes this
  // mid-session (see memory_context's header comment for why).
  const workspaceId = process.env.MNEMO_WORKSPACE_ID?.trim() || projectWorkspaceId(process.cwd());
  if (!url || !key) {
    const locale = mcpLocale() ?? DEFAULT_LOCALE;
    process.stderr.write(
      [
        t(locale, "env.missing"),
        "",
        t(locale, "env.urlLine"),
        t(locale, "env.keyLine"),
        "",
        t(locale, "env.example"),
        "",
        "  {",
        '    "mcpServers": {',
        '      "mnemosyne": {',
        '        "command": "npx",',
        '        "args": ["-y", "@mnemo-ai/mcp"],',
        '        "env": {',
        '          "MNEMO_URL": "https://memory.acme.com",',
        '          "MNEMO_KEY": "mns_live_..."',
        "        }",
        "      }",
        "    }",
        "  }",
        "",
      ].join("\n")
    );
    return null;
  }
  return { url, key, ...(workspaceId ? { workspaceId } : {}) };
}
