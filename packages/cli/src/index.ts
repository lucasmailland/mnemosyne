#!/usr/bin/env node
/* @mnemo-ai/cli — see https://github.com/lucasmailland/mnemosyne */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { COMMANDS, getCmdHelp, setGlobalWorkspaceId, type Config } from "./commands.js";
import { findProjectConfig } from "./project-config.js";
import { resolveUiMode, statusLine } from "./ui-mode.js";
import { EXIT, exitCodeForError } from "./exit-codes.js";
import { extractGlobalFlags, resolveWorkspaceId } from "./workspace-flag.js";
import { LOCALES, normalizeLocale, resolveLocale } from "@mnemo-ai/types";
import { getLocale, setLocale, t } from "./i18n/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
//
// `Config` is the single source of truth, defined in commands.ts (D7) — the
// duplicate `interface Config` this file used to declare is why `uiMode`
// never reached commands: only this file's `loadConfig()` set it, but that
// copy dropped the field entirely.

// L3 — set by main() from a leading `--workspace <id>` flag before
// requireConfig() runs (argv parsing happens in main(), config resolution
// in requireConfig() — this bridges the two without threading an extra
// parameter through every dispatch call-site).
let globalWorkspaceIdFlag: string | undefined;

const CONFIG_DIR = join(homedir(), ".mnemo");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function readConfigFile(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return {};
  }
}

function writeConfigFile(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* ignore */
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* ignore */
  }
}

function loadConfig(): Config {
  const file = readConfigFile();
  return {
    url: process.env.MNEMO_URL ?? file.url,
    apiKey: process.env.MNEMO_KEY ?? file.apiKey,
    uiMode: resolveUiMode(file.uiMode),
    ...(typeof file.locale === "string" ? { locale: file.locale } : {}),
  };
}

async function requireConfig(): Promise<Config & { url: string; apiKey: string }> {
  const config = loadConfig();
  if (!config.url || !config.apiKey) {
    console.error(t("config.noServer"));
    process.exit(EXIT.AUTH);
  }
  // L3 — precedence: --workspace flag > MNEMO_WORKSPACE_ID env > .mnemo.json.
  const workspaceId = resolveWorkspaceId({
    flag: globalWorkspaceIdFlag,
    env: process.env.MNEMO_WORKSPACE_ID?.trim() || undefined,
    project: findProjectConfig(process.cwd()),
  });
  setGlobalWorkspaceId(workspaceId);
  await checkProjectWorkspaceMismatch(config.url!, config.apiKey!);
  return {
    ...config,
    url: config.url!,
    apiKey: config.apiKey!,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

// Strips ASCII control characters (including ANSI escape sequences) so
// values sourced from a committed .mnemo.json (or an API response) can't
// corrupt terminal output when interpolated into a console.error() message.
function sanitizeForTerminal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, "");
}

async function checkProjectWorkspaceMismatch(url: string, apiKey: string): Promise<void> {
  const project = findProjectConfig(process.cwd());
  if (!project) return;

  try {
    const client = new MnemosyneClient({ url, apiKey, timeout: 5000, locale: getLocale() });
    const me = (await client.getMe()) as { workspaceId?: string };
    if (me?.workspaceId && me.workspaceId !== project.config.workspaceId) {
      const expected = sanitizeForTerminal(project.config.label ?? project.config.workspaceId);
      const actual = sanitizeForTerminal(me.workspaceId);
      console.error(t("main.workspaceMismatch", { expected, actual }));
    }
  } catch {
    // network failure, timeout, bad JSON — skip silently
  }
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function colorStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "ok" || s === "healthy") return `${GREEN}${status}${RESET}`;
  if (s === "degraded") return `${YELLOW}${status}${RESET}`;
  return `${RED}${status}${RESET}`;
}

// ---------------------------------------------------------------------------
// Commands (remaining — recall/remember/forget delegated to commands.ts)
// ---------------------------------------------------------------------------

async function cmdStatus(args: string[]): Promise<void> {
  const config = await requireConfig();
  const { url, apiKey } = config;
  const client = new MnemosyneClient({ url, apiKey });
  const result = (await client.health()) as unknown as Record<string, unknown>;

  // --json: the raw health document, no banner and no ANSI colour.
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("main.checkingStatus"),
    pending: true,
  });

  // Pretty-print with colored status values
  const formatted = JSON.stringify(result, null, 2).replace(
    /"(ok|healthy|degraded|down|error|unhealthy)"/gi,
    (_match, val: string) => `"${colorStatus(val)}"`
  );
  console.log(formatted);
}

function cmdConfigSet(args: string[]): void {
  const [key, value] = args;
  if (!key || !value) {
    console.error(t("config.setUsage"));
    process.exit(EXIT.USAGE);
  }
  if (
    key !== "url" &&
    key !== "apiKey" &&
    key !== "uiMode" &&
    key !== "recallTimeoutMs" &&
    key !== "locale"
  ) {
    console.error(t("config.setUnknownKey", { key }));
    process.exit(EXIT.USAGE);
  }
  if (key === "uiMode" && value !== "delight" && value !== "verbose" && value !== "quiet") {
    console.error(t("config.invalidUiMode", { value }));
    process.exit(EXIT.USAGE);
  }
  // Stored as the canonical tag (`es` and `es_MX` both save `es-419`).
  const locale = key === "locale" ? normalizeLocale(value) : undefined;
  if (key === "locale" && !locale) {
    console.error(t("config.invalidLocale", { value, valid: LOCALES.join(", ") }));
    process.exit(EXIT.USAGE);
  }
  // `recallTimeoutMs` bounds the auto-recall in the UserPromptSubmit hook
  // (get_recall_timeout in packages/plugin/scripts/_helpers.sh). It is
  // validated and stored as a NUMBER, not a string, for two reasons:
  //
  //   - the hook's guard is a regex over jq's output, and a quoted "3000"
  //     would pass it — so a bad value fails silently at recall time, in a
  //     hook, which is the worst place to discover a typo. Reject it here.
  //   - without the cast the same key ends up typed differently depending on
  //     whether the CLI or a hand edit wrote it.
  //
  // Zero is invalid on purpose: `curl --max-time 0` means "no limit", the
  // opposite of what someone writing 0 intends.
  let parsedValue: string | number = locale ?? value;
  if (key === "recallTimeoutMs") {
    if (!/^[0-9]+$/.test(value) || Number(value) <= 0) {
      console.error(t("config.invalidRecallTimeout", { value }));
      process.exit(EXIT.USAGE);
    }
    parsedValue = Number(value);
  }
  const config = readConfigFile();
  // PR8 — read the uiMode in effect BEFORE this write, matching every other
  // command's convention of using config.uiMode as it stood when the command
  // started (not a value the command's own write just changed).
  const uiMode = resolveUiMode(config.uiMode);
  config[key as "url" | "apiKey" | "uiMode" | "recallTimeoutMs" | "locale"] = parsedValue as any;
  writeConfigFile(config);
  statusLine({ mode: uiMode, kind: "write", action: t("config.setDone", { key, value }) });
}

function cmdConfigGet(args: string[]): void {
  const config = loadConfig();
  // `config get` mirrors url/apiKey's "(not set)" convention: report what's
  // stored in the file, not loadConfig()'s resolved runtime default.
  const file = readConfigFile();
  const key = args[0];

  function maskApiKey(v: string | undefined): string | undefined {
    if (!v) return v;
    return v.length <= 4 ? "****" : `${"*".repeat(v.length - 4)}${v.slice(-4)}`;
  }

  if (key) {
    if (key !== "url" && key !== "apiKey" && key !== "uiMode" && key !== "locale") {
      console.error(t("config.getUnknownKey", { key }));
      process.exit(EXIT.USAGE);
    }
    const val =
      key === "apiKey"
        ? maskApiKey(config.apiKey)
        : key === "uiMode"
          ? file.uiMode
          : key === "locale"
            ? (normalizeLocale(file.locale) ?? "(not set)")
            : config.url;
    console.log(val ?? "(not set)");
  } else {
    console.log(
      JSON.stringify(
        {
          url: config.url ?? "(not set)",
          apiKey: maskApiKey(config.apiKey) ?? "(not set)",
          uiMode: file.uiMode ?? "(not set)",
          ...(normalizeLocale(file.locale) ? { locale: normalizeLocale(file.locale) } : {}),
        },
        null,
        2
      )
    );
  }
}

function cmdHelp(): void {
  console.log(getCmdHelp());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // L3 — global --workspace <id> and --locale <tag> flags, which must precede
  // the subcommand name (mnemo --locale es-419 <command> ...) — see
  // workspace-flag.ts for why. After the subcommand they are NOT extracted:
  // `mnemo recall --locale es x` hands `--locale es` to recall exactly as
  // `--workspace` is handed over today (it does not switch the language).
  const {
    argv,
    workspace: workspaceFlag,
    locale: localeFlag,
  } = extractGlobalFlags(process.argv.slice(2));
  globalWorkspaceIdFlag = workspaceFlag;

  // Locale, once, before anything prints: leading --locale > MNEMO_LOCALE >
  // config `locale` > the first set of LC_ALL / LC_MESSAGES / LANG (POSIX: the
  // first non-empty one decides, so LC_ALL=C beats LANG=es_MX) > en-US.
  const posix = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(Boolean);
  const configLocale: unknown = readConfigFile().locale;
  const chain = [
    process.env.MNEMO_LOCALE,
    typeof configLocale === "string" ? configLocale : undefined,
    posix,
  ];
  if (localeFlag !== undefined && !normalizeLocale(localeFlag)) {
    setLocale(resolveLocale(chain)); // report the usage error in the language we would have used
    console.error(t("main.invalidLocaleFlag", { value: localeFlag, valid: LOCALES.join(", ") }));
    process.exit(EXIT.USAGE);
  }
  setLocale(resolveLocale([localeFlag, ...chain]));

  // Global --version / -v flag
  if (argv[0] === "--version" || argv[0] === "-v") {
    await COMMANDS.version!([], {});
    return;
  }

  // Global --help / -h — print help and run NOTHING.
  //
  // This guard is why: `mnemo install --help` used to run the full install.
  // The flag was recognised nowhere, so it fell through to the dispatch and
  // cmdInstall ignored it (`args.includes("--local")` is all it inspects),
  // writing to ~/.cursor/mcp.json, ~/.codex/config.toml and
  // ~/.config/opencode/opencode.json for someone who only wanted to read which
  // flags the command takes. `mnemo recall --help` likewise reached the server.
  //
  // `--help` is the universal way to ask BEFORE acting. A CLI that acts when
  // asked turns reading the docs into a side effect — and install is precisely
  // the command whose effects land outside the repo.
  //
  // Matched anywhere in argv, not just at position 0, because `mnemo <cmd>
  // --help` is the form people actually type. The cost is that a literal
  // "--help" can no longer be passed as free text to `remember`/`recall`; that
  // trade is the same one git, docker and npm make.
  if (argv.includes("--help") || argv.includes("-h")) {
    cmdHelp();
    return;
  }

  const [cmd, ...rest] = argv;

  switch (cmd) {
    // Delegate to commands.ts (full implementations, support --json / --limit)
    case "recall":
    case "remember":
    case "forget":
    case "version": {
      const fn = COMMANDS[cmd];
      if (fn) await fn(rest, cmd === "version" ? {} : await requireConfig());
      break;
    }

    case "status":
      await cmdStatus(rest);
      break;

    case "config": {
      const [subCmd, ...subArgs] = rest;
      if (subCmd === "set") {
        cmdConfigSet(subArgs);
      } else if (subCmd === "get") {
        cmdConfigGet(subArgs);
      } else {
        console.error(t("config.unknownSubcommand", { sub: subCmd ?? "" }));
        process.exit(EXIT.USAGE);
      }
      break;
    }

    case "sessions":
    case "tasks":
    case "events":
    case "health":
    case "export":
    case "import":
    case "login":
    case "init":
    case "install":
    case "completion": {
      const fn = COMMANDS[cmd];
      if (fn) {
        // install uses config if available (reads url + key), but doesn't require it.
        // completion MUST always stay `{}` — it is out of scope for uiMode and
        // must never gain a status line (piped into `source`, byte-clean stdout).
        const cfg =
          cmd === "login" || cmd === "init"
            ? { uiMode: loadConfig().uiMode }
            : cmd === "completion"
              ? {}
              : cmd === "install"
                ? await (async () => {
                    try {
                      return await requireConfig();
                    } catch {
                      return { uiMode: loadConfig().uiMode };
                    }
                  })()
                : await requireConfig();
        await fn(rest, cfg);
      }
      break;
    }

    case "list":
    case "search":
    case "show":
    case "info":
    case "whoami":
    case "doctor":
    case "keys":
    case "policy":
    case "workspace":
    case "tenant":
    case "user":
    case "token":
    case "reset":
    case "link":
    case "decide":
    case "entity":
    case "relate":
    case "strategy":
    case "workflow":
    case "skill":
    case "reasoning":
    case "hyperedge":
    case "episode":
    case "pin":
    case "unpin":
    case "timeline":
    case "judge":
    case "purge":
    case "erase":
    case "consolidate":
    case "remind": {
      const fn = COMMANDS[cmd];
      if (fn) await fn(rest, await requireConfig());
      break;
    }

    case "legacy-hook": {
      const config = loadConfig();
      if (!config.url || !config.apiKey) break;
      const { captureLegacyHook } = await import("@mnemo-ai/harness");
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const workspaceId = resolveWorkspaceId({
        flag: globalWorkspaceIdFlag,
        env: process.env.MNEMO_WORKSPACE_ID?.trim() || undefined,
        project: findProjectConfig(payload.cwd ?? process.cwd()),
      });
      const result = await captureLegacyHook(rest[0] ?? "", payload, {
        url: config.url,
        apiKey: config.apiKey,
        workspaceId,
      });
      // Technical status only. Hooks redirect this channel away from the host.
      console.log(JSON.stringify(result));
      break;
    }

    case "harness": {
      // No requireConfig(): the plugin's hooks run `mnemo harness hook …`, and the
      // harness keeps its own binding under ~/.mnemo/harness. A missing server
      // config must not turn every capture into a failed hook.
      const fn = COMMANDS[cmd];
      const config = loadConfig();
      const workspaceId = resolveWorkspaceId({
        flag: globalWorkspaceIdFlag,
        env: process.env.MNEMO_WORKSPACE_ID?.trim() || undefined,
        project: findProjectConfig(process.cwd()),
      });
      if (fn) await fn(rest, { ...config, ...(workspaceId ? { workspaceId } : {}) });
      break;
    }

    case "help":
    case undefined:
      cmdHelp();
      break;

    default:
      console.error(t("main.unknownCommand", { cmd }));
      process.exit(EXIT.USAGE);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realCurrent = realpathSync(currentFilePath);
    return realArgv === realCurrent;
  } catch {
    return process.argv[1] === currentFilePath;
  }
}

// Only run when executed directly (as the `mnemo` bin), not when imported
// for testing — otherwise every import of this module would trigger a real
// CLI invocation using the importing process's argv.
if (isMainModule()) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(t("cli.error", { message }));
    process.exit(exitCodeForError(err));
  });
}
