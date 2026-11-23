import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
/**
 * AB6.3 — CLI command registry (spec §35 lines 4288–4291).
 *
 * Separated from index.ts so tests can import without spawning a process.
 * The bin entry point (index.ts) imports COMMANDS and dispatches via main().
 *
 * New subcommands: login, sessions, tasks, events, health, export, import.
 * Zero extra deps — uses the same apiFetch + table printer from index.ts.
 */

import { createInterface } from "node:readline";

import { parseInstallArgs } from "./install-args.js";
import { registerCodexMcpServer } from "./codex-config.js";
import { atomicReplace, ConfigNotJsonError, writeSecretJsonConfig } from "./atomic-file.js";
import { getLocale, t } from "./i18n/index.js";
import { isYes, yesNoSuffix } from "./i18n/yes-no.js";
import { captureEffects, liveGateFor, writeRuntimeLocator } from "./capture-effects.js";
import { captureFailed, installCaptureHosts, renderCaptureSummary } from "./capture-install.js";
import { PLUGIN_ID, readInstalledPluginEntry } from "./claude-plugin-registry.js";
import { createRequire } from "node:module";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve, join, basename, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { MnemosyneClient, MnemosyneAPIError } from "@mnemo-ai/client-ts";
import type { AgentPolicyInput, CreateKeyInput } from "@mnemo-ai/client-ts";
import { generateCompletion, COMPLETION_SHELLS } from "./completion.js";
import { runHarnessCommand, type HarnessCommandDeps } from "./harness-commands.js";
import { runHarnessLifecycle, type LifecycleDeps } from "./harness-uninstall.js";
import { statusLine, type UiMode } from "./ui-mode.js";
import { EXIT, exitCodeForError, exitCodeForStatus } from "./exit-codes.js";

// Re-exported for callers that already import it from here.
export { readInstalledPluginEntry };

// ── Version ──────────────────────────────────────────────────────────────────

function _readVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const CLI_VERSION: string = _readVersion();

// ── Config shape (shared with index.ts) ─────────────────────────────────────

export interface Config {
  url?: string;
  apiKey?: string;
  /** Sole `UiMode` owner is `ui-mode.ts` (D7) — this file imports the type. */
  uiMode?: UiMode;
  /** L3 — resolved once per invocation; see `setGlobalWorkspaceId`. */
  workspaceId?: string;
  /** Preferred language, `en-US` or `es-419` (`mnemo config set locale`). */
  locale?: string;
  /**
   * Budget in milliseconds for the auto-recall the UserPromptSubmit hook runs
   * (`get_recall_timeout` in packages/plugin/scripts/_helpers.sh). Read by the
   * hook, never by the CLI itself — the CLI only writes and validates it.
   * Absent means the hook's own default (1.5s), which is what a local stack
   * wants; a remote server with a real embedding provider usually needs more.
   */
  recallTimeoutMs?: number;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

// L3 — set once per CLI invocation (by index.ts's requireConfig(), after
// resolving --workspace flag > MNEMO_WORKSPACE_ID env > .mnemo.json) so
// every createClient(...) call below automatically sends X-Workspace-Id,
// without threading a new parameter through this file's ~48 call sites.
// Safe as module-level state ONLY because one CLI process runs exactly one
// command and exits — no concurrent-request risk like the MCP server's
// long-lived shared client, which correctly uses forWorkspace() (an
// immutable per-call clone) instead of mutable state for the same reason.
let globalWorkspaceId: string | undefined;

export function setGlobalWorkspaceId(id: string | undefined): void {
  globalWorkspaceId = id;
}

export function createClient(url: string, apiKey: string): MnemosyneClient {
  return new MnemosyneClient({
    url,
    apiKey,
    userAgent: "mnemo-cli/0.1.0",
    locale: getLocale(),
    ...(globalWorkspaceId ? { workspaceId: globalWorkspaceId } : {}),
  });
}

// Formats and exits the way every CLI command has always reported API
// failures — kept as a single spot so typed MnemosyneClient calls (via
// callApi below) and the raw apiFetch escape hatch stay consistent.
function reportApiErrorAndExit(err: unknown): never {
  if (err instanceof MnemosyneAPIError) {
    console.error(t("api.error", { status: err.status, message: err.message }));
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(t("api.errorMessage", { message }));
  }
  process.exit(exitCodeForError(err));
}

// Awaits a typed MnemosyneClient call, reporting failures with the same
// format apiFetch has always used. Use this for any route that has a named
// method on MnemosyneClient — see docs/archive/BACKLOG.md P34.
async function callApi<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err: unknown) {
    reportApiErrorAndExit(err);
  }
}

// Generic escape hatch for the handful of routes with no typed method on
// MnemosyneClient yet (e.g. /sessions list, /admin/embedding-migrations —
// see docs/archive/BACKLOG.md P34). Prefer callApi(client.namedMethod(...)) whenever
// a typed method exists.
async function apiFetch(
  url: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const client = createClient(url, apiKey);
  const method = (options.method?.toUpperCase() ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE";
  let body: unknown = undefined;
  if (options.body && typeof options.body === "string") {
    try {
      body = JSON.parse(options.body);
    } catch {
      body = options.body;
    }
  } else if (options.body) {
    body = options.body;
  }
  return callApi(client.request({ method, path, body }));
}

// ── Generic list printer ─────────────────────────────────────────────────────

function printList(label: string, items: unknown[], empty?: string): void {
  if (!items.length) {
    console.log(empty ?? `No ${label} found.`);
    return;
  }
  console.log(JSON.stringify({ [label]: items }, null, 2));
}

// ── Command implementations ──────────────────────────────────────────────────

async function cmdSessions(_args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const result = await callApi(createClient(url, apiKey).listSessions());
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.sessions.listing"),
    pending: true,
  });
  printList("sessions", result.sessions, t("memory.empty.sessions"));
}

/** Extends the list-only `sessions` command with `show <id>`. */
async function cmdSessionsExtended(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.sessions.showUsage"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getSession(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("memory.sessions.fetching"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No subcommand, or "list": fall back to the original list-only behavior.
  return cmdSessions(subCmd === "list" ? rest : args, config);
}

async function cmdTasks(_args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const result = await callApi(createClient(url, apiKey).listTasks());
  statusLine({ mode: config.uiMode, kind: "read", action: t("tasks.listingTasks"), pending: true });
  printList("tasks", result.items, t("empty.tasks"));
}

async function cmdEvents(_args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const result = await callApi(createClient(url, apiKey).listEvents());
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("events.listingEvents"),
    pending: true,
  });
  printList("events", result.items, t("memory.empty.events"));
}

async function cmdHealth(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  // Two endpoints: /health/ready (infra probe) + /health (app-level detail)
  const ready = await client.healthReady().catch(() => ({ status: "unavailable" }));
  const detail = await client.health().catch(() => null);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ readiness: ready, detail }, null, 2));
    return;
  }
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("health.checkingHealth"),
    pending: true,
  });
  console.log(t("health.readiness"), JSON.stringify(ready, null, 2));
  if (detail) {
    console.log(t("health.detail"), JSON.stringify(detail, null, 2));
  }
}

async function cmdExport(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };

  // /export/jsonl is approval-gated (dual control, Wave X2.4): the first
  // call with no approvalRequestId returns 202 + a pending request id that
  // a DIFFERENT identity must approve via POST /approvals/:id/resolve
  // (self-approval is rejected server-side) before a retry with
  // --approval-request-id can complete the actual download. Discovered as a
  // real gap during flatten-version-docs' B4.3 CLI coverage fill-in — this
  // flag is what closes it, not a workaround for a bug.
  const flagIdx = args.indexOf("--approval-request-id");
  const approvalRequestId = flagIdx >= 0 ? args[flagIdx + 1] : undefined;

  const qs = approvalRequestId ? `?${new URLSearchParams({ approvalRequestId }).toString()}` : "";

  // Fetch from the V §29 export endpoint. The server sets
  // Content-Encoding: gzip, but Node's fetch() decompresses that
  // transparently — response.arrayBuffer() below already yields the plain
  // JSONL text, not raw gzip bytes. No gunzip step needed on the consumer
  // side: mnemo export --approval-request-id <id> > backup.jsonl
  const response = await fetch(`${url}/export/jsonl${qs}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Accept-Language": getLocale() },
  });

  if (response.status === 202) {
    const pending = (await response.json()) as {
      approvalRequestId?: string;
      message?: string;
      expiresAt?: string;
    };
    console.error(
      t("export.approvalRequired", {
        id: pending.approvalRequestId ?? t("common.missingFromResponse"),
        expires: pending.expiresAt ? t("export.expires", { expiresAt: pending.expiresAt }) : "",
        url,
        rawId: String(pending.approvalRequestId),
      })
    );
    // Deliberately 2, shared with usage errors: a pending approval has always
    // exited 2 and scripts may match on it. Documented in the README.
    process.exit(2);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(
      t("export.error", { status: response.status, statusText: response.statusText, text })
    );
    process.exit(exitCodeForStatus(response.status));
  }
  const buf = await response.arrayBuffer();
  process.stdout.write(Buffer.from(buf));
}

async function cmdImport(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };

  // Extract --from and --conflict-resolution flags
  const fromIdx = args.indexOf("--from");
  const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
  const crIdx = args.indexOf("--conflict-resolution");
  const conflictResolution = crIdx >= 0 ? args[crIdx + 1] : undefined;

  // Build the non-flag file path arg (first arg that isn't a flag name or flag value)
  const flagValues = new Set<string | undefined>([from, conflictResolution]);
  const filePath = args.find((a) => !a.startsWith("--") && !flagValues.has(a));

  if (!filePath) {
    console.error(t("import.usageMnemoImportFile"));
    process.exit(EXIT.USAGE);
  }
  const { readFileSync } = await import("node:fs");
  let body: ArrayBuffer;
  try {
    const buf = readFileSync(filePath);
    // Slice to detach from the underlying SharedArrayBuffer, giving a plain ArrayBuffer.
    body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (err) {
    console.error(
      t("import.readError", { message: err instanceof Error ? err.message : String(err) })
    );
    process.exit(1);
  }

  // Build query string for vendor and conflict-resolution
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (conflictResolution) qs.set("conflictResolution", conflictResolution);
  const importUrl = `${url}/import${qs.toString() ? `?${qs.toString()}` : ""}`;

  const response = await fetch(importUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Accept-Language": getLocale(),
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(t("import.error", { status: response.status }), JSON.stringify(result, null, 2));
    process.exit(exitCodeForStatus(response.status));
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdReset(args: string[], config: Config): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error(t("reset.errorWorkspaceResetIs"));
    process.exit(1);
  }
  const confirmIdx = args.indexOf("--confirm");
  if (confirmIdx < 0) {
    console.error(t("reset.errorResetRequiresExplicit"));
    console.error(t("reset.exampleMnemoResetWorkspace"));
    process.exit(EXIT.USAGE);
  }
  const wsIdx = args.indexOf("--workspace");
  const workspaceId = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
  if (!workspaceId) {
    console.error(t("reset.usageMnemoResetWorkspace"));
    process.exit(EXIT.USAGE);
  }
  const { url, apiKey } = config as { url: string; apiKey: string };
  // Admin/ops-only route, no client-ts wrapper by design (docs/archive/BACKLOG.md P35).
  await apiFetch(url, apiKey, `/admin/embedding-migrations`, {
    method: "POST",
    body: JSON.stringify({ workspaceId, targetModel: "reset", dryRun: true }),
  });
  statusLine({
    mode: config.uiMode,
    kind: "destructive",
    action: t("reset.safeResetCheckCompleted", { workspaceId }),
  });
}

async function cmdLogin(args: string[], config: Config): Promise<void> {
  let urlArg: string | undefined;
  let keyArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url" || a === "-u") {
      urlArg = args[++i];
    } else if (a === "--key" || a === "-k" || a === "--api-key") {
      keyArg = args[++i];
    }
  }

  let finalUrl: string;
  let finalKey: string;

  if (urlArg || keyArg) {
    finalUrl = urlArg?.trim() || "http://localhost:3939";
    finalKey = keyArg?.trim() || "";
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
    const urlInput = await ask(t("login.serverUrlHttpLocalhost"));
    const keyInput = await ask(t("login.apiKeyMskOr"));
    rl.close();
    finalUrl = urlInput.trim() || "http://localhost:3939";
    finalKey = keyInput.trim();
  }

  if (!finalKey) {
    console.error(t("login.errorApiKeyIs"));
    process.exit(EXIT.USAGE);
  }

  const { writeFileSync, mkdirSync, chmodSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const configDir = join(homedir(), ".mnemo");
  writeMnemoConfigFile(configDir, { url: finalUrl, apiKey: finalKey });
  // PR8 — main() dispatches login with `{ uiMode: loadConfig().uiMode }`
  // (index.ts), read BEFORE this function writes the new config file. When
  // no config file exists yet (first-ever login), loadConfig() resolves that
  // to "delight" via resolveUiMode's default-when-absent behavior — no crash,
  // no read of a file that doesn't exist yet.
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("login.loggedInConfigSaved"),
  });
}

// ── mnemo init --docker helpers ───────────────────────────────────────────────

/** Find docker compose binary. Returns descriptor or null if not found. */
export function findDockerBinary(): { bin: string; isV2: boolean } | null {
  const v2 = spawnSync("docker", ["compose", "version"], { stdio: "pipe" });
  if (v2.status === 0) return { bin: "docker", isV2: true };
  const v1 = spawnSync("docker-compose", ["version"], { stdio: "pipe" });
  if (v1.status === 0) return { bin: "docker-compose", isV2: false };
  return null;
}

/** Find docker/docker-compose.yml relative to CLI binary, fallback to cwd. */
export function findDockerComposePath(): string | null {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dir, "../../docker/docker-compose.yml"),
    resolve(__dir, "../../../docker/docker-compose.yml"),
    resolve(process.cwd(), "docker/docker-compose.yml"),
  ];
  return candidates.find(existsSync) ?? null;
}

/** Check if a port is free on localhost. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      s.close();
      resolve(true);
    });
    s.listen(port, "127.0.0.1");
  });
}

/** Write docker/.env file alongside the compose file. */
export function writeDockerEnv(composePath: string, vars: Record<string, string>): void {
  const envPath = resolve(dirname(composePath), ".env");
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n");
  // CLI-1: this file carries MNEMO_LLM_API_KEY and other secrets in plaintext —
  // restrict to owner read/write so other local users on a shared machine can't
  // read it off the default umask permissions.
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* ignore */
  }
}

/** Poll until service is healthy or timeout. Returns true if healthy. */
export async function waitForHealthy(
  bin: string,
  isV2: boolean,
  composePath: string,
  service: string,
  timeoutMs = 90000
): Promise<boolean> {
  const args = isV2
    ? ["compose", "-f", composePath, "ps", "--format", "json", service]
    : ["-f", composePath, "ps", "--format", "json", service];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(bin, args, { stdio: "pipe" });
    if (result.status === 0) {
      const raw = result.stdout.toString().trim();
      try {
        // Handle both JSON array (newer compose) and NDJSON (older compose)
        const parsed = raw.startsWith("[")
          ? (JSON.parse(raw) as Array<{ Health?: string; State?: string }>)
          : raw
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l) as { Health?: string; State?: string });
        if (parsed.some((r) => r.Health === "healthy" || r.State === "running")) {
          return true;
        }
      } catch {
        /* ignore parse errors, keep polling */
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// ── Workspace mapping helpers (P3-B) ─────────────────────────────────────────

/** Detect project name from git remote, then git root, then cwd basename. */
export async function detectProjectName(cwd: string): Promise<string> {
  const remote = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { stdio: "pipe" });
  if (remote.status === 0) {
    const url = remote.stdout.toString().trim();
    return url.replace(/\.git$/, "").replace(/.*[/:]/, "");
  }
  const root = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { stdio: "pipe" });
  if (root.status === 0) return basename(root.stdout.toString().trim());
  return basename(cwd);
}

/** Write/update workspace entry in ~/.mnemo/workspaces.json */
export function writeWorkspaceMapping(url: string, workspaceId: string, projectName: string): void {
  const wsFile = join(homedir(), ".mnemo", "workspaces.json");
  let data: Record<string, { workspaceId: string; url: string }> = {};
  try {
    data = JSON.parse(readFileSync(wsFile, "utf8"));
  } catch {
    /* file missing is ok */
  }
  data[projectName] = { workspaceId, url };
  // Also write "default" if no default exists yet
  if (!data["default"]) data["default"] = { workspaceId, url };
  mkdirSync(dirname(wsFile), { recursive: true });
  writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
}

/** Upsert the top-level personalWorkspaceId field in ~/.mnemo/workspaces.json (P10). */
export function writePersonalWorkspaceId(personalWorkspaceId: string): void {
  const wsFile = join(homedir(), ".mnemo", "workspaces.json");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(wsFile, "utf8"));
  } catch {
    /* file missing is ok */
  }
  data["personalWorkspaceId"] = personalWorkspaceId;
  mkdirSync(dirname(wsFile), { recursive: true });
  writeFileSync(wsFile, JSON.stringify(data, null, 2) + "\n");
}

// ── mnemo init helpers ────────────────────────────────────────────────────────

function resolveMcpPath(): string {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const local = resolve(__dir, "../../mcp/dist/index.js");
  return existsSync(local) ? local : "npx -y @mnemo-ai/mcp";
}

/** `command` + `args` for an MCP client entry: a local build runs under node, the published package under npx. */
export function mcpLaunch(mcpPath: string): { command: string; args: string[] } {
  if (!mcpPath.startsWith("npx")) return { command: "node", args: [mcpPath] };
  const [command, ...args] = mcpPath.split(" ");
  return { command: command!, args };
}

/**
 * APP-012 — register the MCP server with Claude Code, replacing any previous
 * registration. `claude mcp add` on a name that exists exits 1 and keeps the OLD
 * entry (and its old key), so the old one has to be removed — but removing it
 * BEFORE a successful add left a user whose add then failed with no
 * registration at all. So the new entry is staged first under
 * `mnemosyne-new`: if that add fails, nothing the user had was touched; once
 * it holds, the old `mnemosyne` is swapped for the new one and the staging
 * entry dropped. If the final add fails anyway, the staged entry stays — the
 * user keeps a working server under that name and the reason says so.
 *
 * The key travels on claude's argv: `-e` only takes KEY=value, and `add-json`
 * takes the JSON on argv too — there is no stdin or env-reference form. It is
 * visible to `ps` for the life of that one short process.
 *
 * Success is the final add's exit 0, nothing less. The reason returned on
 * failure is claude's own output with the key masked.
 */
export function registerClaudeMcpServer(input: {
  url: string;
  key: string;
  mcpPath: string;
}): { ok: true } | { ok: false; reason: string } {
  const { url, key, mcpPath } = input;
  const run = (argv: string[]) => spawnSync("claude", argv, { stdio: "pipe", encoding: "utf8" });
  const remove = (name: string) => run(["mcp", "remove", name, "--scope", "user"]);
  const { command, args } = mcpLaunch(mcpPath);
  const add = (name: string) =>
    run([
      "mcp",
      "add",
      name,
      "--scope",
      "user",
      "-e",
      `MNEMO_URL=${url}`,
      "-e",
      `MNEMO_KEY=${key}`,
      "--",
      command,
      ...args,
    ]);
  const failure = (r: ReturnType<typeof run>): string => {
    const detail = r.error
      ? r.error.message
      : `${r.stderr ?? ""}${r.stdout ?? ""}`.trim() || `exit ${r.status ?? r.signal}`;
    return key ? detail.split(key).join("***") : detail;
  };
  const ok = (r: ReturnType<typeof run>) => !r.error && r.status === 0;

  const STAGED = "mnemosyne-new";
  remove(STAGED); // a leftover from an earlier interrupted run would block the add
  const staged = add(STAGED);
  if (!ok(staged)) return { ok: false, reason: failure(staged) };
  remove("mnemosyne");
  const final = add("mnemosyne");
  if (!ok(final)) {
    return {
      ok: false,
      reason: t("install.claudeMcpStagedKept", { name: STAGED, reason: failure(final) }),
    };
  }
  remove(STAGED);
  return { ok: true };
}

export function getClaudeDesktopConfigPath(): string | null {
  const p = platform();
  if (p === "darwin")
    return join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
  if (p === "linux") return join(homedir(), ".config/Claude/claude_desktop_config.json");
  return null; // Windows not supported in v1
}

/** @internal Exported for testing only */
export async function fetchAndPrintSetupBanner(serverPort: number): Promise<void> {
  try {
    const setupRes = await fetch(`http://localhost:${serverPort}/setup/token`);
    if (setupRes.ok) {
      const setupData = (await setupRes.json()) as {
        token: string;
        setupUrl?: string;
        expiresAt?: string;
      };
      const setupUrl =
        setupData.setupUrl ?? `http://localhost:${serverPort}/setup?token=${setupData.token}`;
      // The box grows to its widest line (a real setup URL with a UUID token
      // runs past 56 columns), never below the original 56.
      const lines = [
        t("setup.banner.title"),
        t("setup.banner.open"),
        setupUrl,
        t("setup.banner.expires"),
      ];
      const inner = Math.max(56, ...lines.map((l) => l.length));
      console.log(`\n  ╔${"═".repeat(inner + 2)}╗`);
      for (const line of lines) console.log(`  ║  ${line.padEnd(inner)}║`);
      console.log(`  ╚${"═".repeat(inner + 2)}╝\n`);
    }
  } catch {
    /* old server or network issue — skip silently */
  }
}

function printManualMcpSnippet(url: string, key: string, mcpPath: string): void {
  console.log(t("printManualMcpSnippet.addThisToYour"));
  console.log(
    JSON.stringify(
      {
        mnemosyne: {
          ...mcpLaunch(mcpPath),
          env: { MNEMO_URL: url, MNEMO_KEY: key },
          type: "stdio",
        },
      },
      null,
      2
    )
  );
}

async function cmdInitDocker(config: Config): Promise<void> {
  console.log(t("initDocker.mnemosyneDockerBootstrap"));

  // Step 1: Docker daemon + binary check
  const daemonCheck = spawnSync("docker", ["info"], { stdio: "pipe" });
  if (daemonCheck.status !== 0) {
    console.error(t("initDocker.dockerDaemonIsNot"));
    console.error(t("initDocker.installHttpsDocsDocker"));
    process.exit(1);
  }
  const docker = findDockerBinary();
  if (!docker) {
    console.error(t("initDocker.dockerComposeNotFound"));
    process.exit(1);
  }
  const composeBin = docker.bin;
  const composeArgs = (args: string[]): string[] => (docker.isV2 ? ["compose", ...args] : args);

  // Step 2: Find compose file
  const composePath = findDockerComposePath();
  if (!composePath) {
    console.error(t("initDocker.dockerDockerComposeYml"));
    console.error(t("initDocker.mnemoInitDockerRequires"));
    console.error(t("initDocker.forCloudSetupMnemo"));
    process.exit(1);
  }
  console.log(t("initDocker.foundComposeFile", { composePath }));

  // Step 3: Port conflict detection
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  let redisPort = 6379;
  let postgresPort = 5432;
  let serverPort = 3939;

  try {
    if (!(await isPortFree(6379))) {
      const ans = (await ask(t("initDocker.portRedisIsIn"))).trim();
      redisPort = parseInt(ans, 10) || 6380;
    }
    if (!(await isPortFree(5432))) {
      const ans = (await ask(t("initDocker.portPostgresIsIn"))).trim();
      postgresPort = parseInt(ans, 10) || 5433;
    }
    if (!(await isPortFree(3939))) {
      const ans = (await ask(t("initDocker.portServerIsIn"))).trim();
      serverPort = parseInt(ans, 10) || 3940;
    }

    // Step 4: LLM API key (optional)
    const llmKey = (await ask(t("initDocker.mnemoLlmApiKey"))).trim();
    if (!llmKey) {
      console.warn(t("initDocker.warningNoLlmKey"));
    }

    // Step 5: Write docker/.env
    writeDockerEnv(composePath, {
      PORT: String(serverPort),
      REDIS_PORT: String(redisPort),
      POSTGRES_PORT: String(postgresPort),
      MNEMO_LLM_API_KEY: llmKey,
      LOG_LEVEL: "info",
      MNEMO_REDIS_URL: `redis://redis:${redisPort}`,
    });
    console.log(t("initDocker.writtenDockerEnv"));
  } finally {
    rl.close();
  }

  // Step 6: Start infra
  console.log(t("initDocker.startingPostgresAndRedis"));
  const up = spawnSync(
    composeBin,
    [...composeArgs(["-f", composePath, "up", "-d", "postgres", "redis"])],
    { stdio: "inherit" }
  );
  if (up.status !== 0) {
    console.error(t("initDocker.failedToStartInfra"));
    process.exit(1);
  }

  // Step 6b: Wait for infra to be healthy before running migrations
  process.stdout.write(t("initDocker.waitingForPostgresAnd"));
  const infraReady = await waitForHealthy(composeBin, docker.isV2, composePath, "postgres");
  if (!infraReady) {
    console.log(t("initDocker.x"));
    console.error(t("initDocker.postgresDidNotBecome"));
    console.error(t("initDocker.checkPostgresLogs", { composePath }));
    process.exit(1);
  }
  console.log(t("initDocker.ready"));

  // Step 7: Run migrations
  console.log(t("initDocker.runningMigrations"));
  const migrate = spawnSync(
    composeBin,
    [...composeArgs(["-f", composePath, "run", "--rm", "migrate"])],
    { stdio: "inherit" }
  );
  if (migrate.status !== 0) {
    console.error(t("initDocker.migrationsFailed"));
    process.exit(1);
  }

  // Step 8: Start server
  console.log(t("initDocker.startingServer"));
  const serverUp = spawnSync(
    composeBin,
    [...composeArgs(["-f", composePath, "up", "-d", "server"])],
    { stdio: "inherit" }
  );
  if (serverUp.status !== 0) {
    console.error(t("initDocker.failedToStartServer"));
    process.exit(1);
  }

  // Step 9: Wait for healthy
  process.stdout.write(t("initDocker.waitingForServerTo"));
  const healthy = await waitForHealthy(composeBin, docker.isV2, composePath, "server");
  if (!healthy) {
    console.log(t("initDocker.x"));
    console.error(t("initDocker.serverDidNotBecome"));
    console.error(t("initDocker.checkServerLogs", { composePath }));
    process.exit(1);
  }
  console.log(t("initDocker.healthy"));

  // Step 9b: Check for setup wizard token (non-blocking)
  await fetchAndPrintSetupBanner(serverPort);

  // Step 10: Generate workspace + API key
  const workspaceId = randomUUID();
  const keyResult = spawnSync(
    composeBin,
    [
      ...composeArgs([
        "-f",
        composePath,
        "exec",
        "-T",
        "server",
        "node",
        "scripts/create-api-key.cjs",
        "--workspace",
        workspaceId,
      ]),
    ],
    { stdio: "pipe" }
  );

  const key = keyResult.stdout?.toString().trim() ?? "";
  if (!key.startsWith("mns_live_")) {
    console.error(t("initDocker.keyGenerationFailedOutput"), key || "(empty)");
    console.error(t("initDocker.stderr"), keyResult.stderr?.toString().trim());
    process.exit(1);
  }
  console.log(t("initDocker.apiKeyGenerated"));

  // Step 11: Write config
  const serverUrl = `http://localhost:${serverPort}`;
  const configDir = join(homedir(), ".mnemo");
  writeMnemoConfigFile(configDir, { url: serverUrl, apiKey: key });
  console.log(t("initDocker.configWrittenToMnemo"));

  // Step 12: MCP config (reuse v1 helpers)
  const mcpPath = resolveMcpPath();
  const claudeMcp = registerClaudeMcpServer({ url: serverUrl, key, mcpPath });
  if (claudeMcp.ok) {
    console.log(t("initDocker.mcpServerRegisteredIn"));
  } else {
    console.warn(t("install.claudeMcpAddFailed", { reason: claudeMcp.reason }));
    console.warn(t("init.addTheMcpServer"));
  }

  // Step 12b: Claude Desktop patching
  const desktopPath = getClaudeDesktopConfigPath();
  if (desktopPath) {
    try {
      writeSecretJsonConfig(desktopPath, (config) => {
        if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
        (config.mcpServers as Record<string, unknown>).mnemosyne = {
          ...mcpLaunch(mcpPath),
          env: { MNEMO_URL: serverUrl, MNEMO_KEY: key },
          type: "stdio",
        };
      });
      console.log(t("initDocker.claudeDesktopConfigUpdated", { desktopPath }));
    } catch (err) {
      if (err instanceof ConfigNotJsonError) {
        console.warn(t("initDocker.warningContainsInvalidJson", { desktopPath }));
        console.warn(t("initDocker.fixTheFileManually"));
      } else {
        console.warn(t("init.couldNotWrite", { desktopPath, message: (err as Error).message }));
      }
      printManualMcpSnippet(serverUrl, key, mcpPath);
    }
  } else {
    console.warn(t("initDocker.windowsNotSupportedYet"));
    printManualMcpSnippet(serverUrl, key, mcpPath);
  }

  // Step 12c: Pull nomic-embed-text via Ollama for zero-cost local embeddings
  const ollamaHealthy = await waitForHealthy(
    composeBin,
    docker.isV2,
    composePath,
    "ollama",
    30_000
  );
  if (ollamaHealthy) {
    process.stdout.write(t("initDocker.pullingNomicEmbedText"));
    let pulled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const pull = spawnSync(
        composeBin,
        [
          ...composeArgs([
            "-f",
            composePath,
            "exec",
            "-T",
            "ollama",
            "ollama",
            "pull",
            "nomic-embed-text",
          ]),
        ],
        { stdio: "pipe", timeout: 120_000 }
      );
      if (pull.status === 0) {
        pulled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    console.log(pulled ? t("initDocker.pullDone") : t("initDocker.pullSkipped"));
  } else {
    console.warn(t("initDocker.ollamaNotHealthySkipping"));
    console.warn(t("initDocker.toPullManuallyDocker"));
  }

  // Step 13: Summary
  console.log(t("initDocker.mnemosyneInitializedSuccessfully"));
  console.log(t("initDocker.server", { serverUrl }));
  console.log(t("initDocker.apiKey", { key }));
  console.log(t("initDocker.copyTheKeyNow"));
  console.log(t("initDocker.restartClaudeCodeTo"));

  // Workspace mapping — in --docker mode, workspaceId is known (we generated it)
  const projectName = await detectProjectName(process.cwd());
  writeWorkspaceMapping(serverUrl, workspaceId, projectName);
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("initDocker.workspaceMappingSavedFor"),
    detail: projectName,
  });
  if (config.uiMode !== "quiet") {
    console.log(t("initDocker.mnemoWorkspacesJsonUpdated"));
  }
}

/**
 * Resolve the workspace identity for an API key by calling GET /me, with a
 * cascade to GET /admin/stats for admin-scoped keys that lack `memory:read`.
 * Both routes are bare (the server mounts its v1 router at root — no /v1
 * prefix), and this call is silent-fail: `workspaceId` stays `'unknown'`
 * when neither endpoint is reachable or returns a workspaceId.
 */
export async function resolveWorkspaceIdentity(
  url: string,
  key: string
): Promise<{ workspaceId: string; personalWorkspaceId: string | null }> {
  let workspaceId = "unknown";
  let personalWorkspaceId: string | null = null;
  try {
    const meRes = await fetch(`${url}/me`, {
      headers: { Authorization: `Bearer ${key}`, "Accept-Language": getLocale() },
      signal: AbortSignal.timeout(5000),
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        workspaceId?: string;
        personalWorkspaceId?: string | null;
      };
      if (me.workspaceId) workspaceId = me.workspaceId;
      if (me.personalWorkspaceId) personalWorkspaceId = me.personalWorkspaceId;
    } else {
      throw new Error(`/me returned ${meRes.status}`);
    }
  } catch {
    try {
      const statsRes = await fetch(`${url}/admin/stats`, {
        headers: { Authorization: `Bearer ${key}`, "Accept-Language": getLocale() },
        signal: AbortSignal.timeout(5000),
      });
      if (statsRes.ok) {
        const stats = (await statsRes.json()) as { workspaceId?: string };
        if (stats.workspaceId) workspaceId = stats.workspaceId;
      }
    } catch {
      // both endpoints failed — workspaceId stays 'unknown'
    }
  }
  return { workspaceId, personalWorkspaceId };
}

async function cmdInit(args: string[], config: Config): Promise<void> {
  if (args.includes("--docker")) return cmdInitDocker(config);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  try {
    // Step 1: URL
    const url = (await ask(t("init.serverUrlHttpLocalhost"))).trim() || "http://localhost:3939";

    // Step 2: API key — accept all key formats including new mk_* and uk_* keys
    const KEY_PATTERN =
      /^(mns_(live|test)|mk_(live|test|sess|fed|admin)|uk_(live|test))_[a-z0-9]{20,64}$/i;
    let key = "";
    while (!KEY_PATTERN.test(key)) {
      key = (await ask(t("init.apiKeyMnsLive"))).trim();
      if (!KEY_PATTERN.test(key)) {
        console.error(t("init.invalidFormatExpectedMns"));
      }
    }

    // Step 3: Verify connectivity
    process.stdout.write(t("init.checkingServerConnectivity"));
    try {
      const res = await fetch(`${url}/health/live`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(t("init.ok"));
    } catch (err) {
      console.log(t("init.failed"));
      console.error(t("init.cannotReach", { url, message: (err as Error).message }));
      console.error(t("init.startTheServerFirst"));
      process.exit(1);
    }

    const { workspaceId, personalWorkspaceId: earlyPersonalWorkspaceId } =
      await resolveWorkspaceIdentity(url, key);

    // Step 3.5: Optional user registration
    // Creates a user profile + personal tenant on the server.
    // Skipped for setups that don't use the multi-tenant model.
    let userId: string | null = null;
    let tenantId: string | null = null;
    const registerUser = await ask(t("init.registerAUserProfile", { yn: yesNoSuffix(false) }));
    if (isYes(registerUser, false)) {
      const email = (await ask(t("init.email"))).trim();
      if (email) {
        try {
          process.stdout.write(t("init.creatingUser"));
          const res = await fetch(`${url}/users`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
              "Accept-Language": getLocale(),
            },
            body: JSON.stringify({ email }),
            signal: AbortSignal.timeout(8000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              id?: string;
              personalTenantId?: string;
              email?: string;
            };
            userId = data.id ?? null;
            tenantId = data.personalTenantId ?? null;
            console.log(t("init.okEmail", { email: data.email ?? email }));
            if (userId) console.log(t("init.userId", { userId }));
            if (tenantId) console.log(t("init.tenantId", { tenantId }));
          } else if (res.status === 409) {
            // User already exists — fetch their info
            const meRes = await fetch(`${url}/me`, {
              headers: { Authorization: `Bearer ${key}`, "Accept-Language": getLocale() },
              signal: AbortSignal.timeout(5000),
            });
            if (meRes.ok) {
              const me = (await meRes.json()) as { userId?: string; tenantId?: string };
              userId = me.userId ?? null;
              tenantId = me.tenantId ?? null;
            }
            console.log(t("init.userAlreadyExists"));
          } else {
            const body = await res.text();
            console.log(t("init.skippedStatus", { status: res.status, body: body.slice(0, 80) }));
          }
        } catch (err) {
          console.log(t("init.skippedError", { message: (err as Error).message }));
        }
      }
    }

    // Step 4: Write ~/.mnemo/config.json
    const configDir = join(homedir(), ".mnemo");
    const configData: Record<string, string> = { url, apiKey: key };
    if (userId) configData.userId = userId;
    if (tenantId) configData.tenantId = tenantId;
    writeMnemoConfigFile(configDir, configData);
    console.log(t("init.configWrittenToMnemo"));

    const mcpPath = resolveMcpPath();

    // Step 5: Claude Code CLI
    const configureClaude = await ask(t("init.configureClaudeCodeCli", { yn: yesNoSuffix(true) }));
    let claudeCodeConfigured = false;
    if (isYes(configureClaude, true)) {
      const claudeMcp = registerClaudeMcpServer({ url, key, mcpPath });
      if (claudeMcp.ok) {
        console.log(t("init.mcpServerRegisteredIn"));
        claudeCodeConfigured = true;
      } else {
        console.warn(t("install.claudeMcpAddFailed", { reason: claudeMcp.reason }));
        console.warn(t("init.addTheMcpServer"));
      }
    }

    // Step 6: Claude Desktop
    const configureDesktop = await ask(
      t("init.configureClaudeDesktopY", { yn: yesNoSuffix(true) })
    );
    let desktopConfigured = false;
    if (isYes(configureDesktop, true)) {
      const desktopPath = getClaudeDesktopConfigPath();
      if (!desktopPath) {
        console.warn(t("init.windowsNotSupportedYet"));
        printManualMcpSnippet(url, key, mcpPath);
      } else {
        try {
          // A malformed file is refused (ConfigNotJsonError), never replaced.
          writeSecretJsonConfig(desktopPath, (config) => {
            if (!config.mcpServers || typeof config.mcpServers !== "object") {
              config.mcpServers = {};
            }
            (config.mcpServers as Record<string, unknown>).mnemosyne = {
              ...mcpLaunch(mcpPath),
              env: { MNEMO_URL: url, MNEMO_KEY: key },
              type: "stdio",
            };
          });
          console.log(t("init.claudeDesktopConfigUpdated", { desktopPath }));
          desktopConfigured = true;
        } catch (err) {
          if (err instanceof ConfigNotJsonError) {
            console.warn(t("init.warningContainsInvalidJson", { desktopPath }));
            console.warn(t("init.fixTheFileManually"));
          } else {
            console.warn(t("init.couldNotWrite", { desktopPath, message: (err as Error).message }));
          }
          printManualMcpSnippet(url, key, mcpPath);
        }
      }
    }

    // Step 7: Summary
    console.log(t("init.mnemosyneInitializedSuccessfully"));
    console.log(t("init.configMnemoConfigJson"));
    console.log(t("init.server", { url }));
    if (userId) console.log(t("init.userId2", { userId }));
    if (tenantId) console.log(t("init.tenantId2", { tenantId }));
    console.log(
      t("init.summaryClaudeCode", {
        state: claudeCodeConfigured ? t("common.configured") : t("common.skipped"),
      })
    );
    console.log(
      t("init.summaryClaudeDesktop", {
        state: desktopConfigured ? t("common.configured") : t("common.skipped"),
      })
    );
    if (claudeCodeConfigured || desktopConfigured) {
      console.log(t("init.restartClaudeCodeClaude"));
    }

    // Workspace mapping
    const saveMapping = await ask(t("init.saveWorkspaceMappingY", { yn: yesNoSuffix(true) }));
    if (isYes(saveMapping, true)) {
      const projectName = await detectProjectName(process.cwd());
      // workspaceId and personalWorkspaceId are resolved earlier via the /me
      // cascade (falls back to /admin/stats, then 'unknown'). No additional
      // HTTP call is needed here.
      writeWorkspaceMapping(url, workspaceId, projectName);
      statusLine({
        mode: config.uiMode,
        kind: "write",
        action: t("init.workspaceMappingSavedFor"),
        detail: projectName,
      });
      if (workspaceId === "unknown") {
        console.log(t("init.runMemoryDoctorAfter"));
      }

      // Write personal workspace ID resolved earlier from /me (P10)
      if (earlyPersonalWorkspaceId) {
        writePersonalWorkspaceId(earlyPersonalWorkspaceId);
        statusLine({
          mode: config.uiMode,
          kind: "write",
          action: t("init.personalWorkspaceIdSaved"),
          detail: earlyPersonalWorkspaceId,
        });
      }
    }
  } finally {
    rl.close();
  }
}

export async function cmdLink(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const cwd = process.cwd();
  const configPath = join(cwd, ".mnemo.json");
  const force = args.includes("--force");

  if (existsSync(configPath) && !force) {
    const existing = JSON.parse(readFileSync(configPath, "utf-8")) as {
      workspaceId?: string;
      label?: string;
    };
    console.error(
      t("link.alreadyExists", {
        configPath,
        workspaceId: existing.workspaceId ?? t("common.unknownWord"),
        label: existing.label ? t("link.labelSuffix", { label: existing.label }) : "",
      })
    );
    process.exit(1);
  }

  // Deliberately a plain getMe() call, not the resolveWorkspaceIdentity()
  // helper (added alongside cmdInit — it cascades to /admin/stats for
  // admin-scoped keys lacking memory:read). This matches the existing
  // cmdInfo/whoami convention (also plain /me, no cascade) — so a key that
  // lacks memory:read will hard-fail `mnemo link`, same as `mnemo whoami` would.
  let me: { workspaceId?: string };
  try {
    me = (await createClient(url, apiKey).getMe()) as { workspaceId?: string };
  } catch (err: unknown) {
    if (err instanceof MnemosyneAPIError) {
      console.error(t("link.error", { status: err.status, message: err.message }));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(t("link.errorMessage", { message }));
    }
    process.exit(1);
  }
  if (!me.workspaceId) {
    console.error(t("link.errorCouldNotResolve"));
    process.exit(1);
  }

  const labelIdx = args.indexOf("--label");
  const labelValue = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
  const label = labelValue !== undefined && !labelValue.startsWith("--") ? labelValue : undefined;

  const written: { workspaceId: string; label?: string } = { workspaceId: me.workspaceId };
  if (label) written.label = label;

  writeFileSync(configPath, JSON.stringify(written, null, 2) + "\n", "utf-8");
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("link.linkedToWorkspace", { cwd, workspaceId: me.workspaceId }),
    id: label,
  });
  if (config.uiMode !== "quiet") {
    console.log(t("link.written", { configPath }));
  }
}

// ── Recall table printer ─────────────────────────────────────────────────────

export function printRecallTable(
  hits: Array<{ id: string; score: number; statement: string }>
): void {
  const ID_W = 38;
  const SCORE_W = 8;
  const STMT_W = 80;
  const line = `${"─".repeat(ID_W + 2)}┼${"─".repeat(SCORE_W + 2)}┼${"─".repeat(STMT_W + 2)}`;
  console.log(
    `${t("memory.table.id").padEnd(ID_W)} │ ${t("memory.table.score").padEnd(SCORE_W)} │ ${t("memory.table.statement")}`
  );
  console.log(line);
  for (const row of hits) {
    const id = row.id.padEnd(ID_W);
    const score = row.score.toFixed(4).padEnd(SCORE_W);
    const stmt =
      row.statement.length > STMT_W ? row.statement.slice(0, STMT_W - 1) + "…" : row.statement;
    console.log(`${id} │ ${score} │ ${stmt}`);
  }
}

// ── Core CRUD commands ────────────────────────────────────────────────────────

async function cmdRecall(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };

  // Flags: --json, --limit N (or -n N)
  const jsonIdx = args.indexOf("--json");
  const isJson = jsonIdx !== -1;
  if (isJson) args.splice(jsonIdx, 1);

  let limit = 10;
  for (const flag of ["--limit", "-n"]) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      const n = Number(args[idx + 1]);
      if (!Number.isFinite(n) || n < 1) {
        console.error(t("memory.limitInvalid", { flag }));
        process.exit(EXIT.USAGE);
      }
      limit = n;
      args.splice(idx, 2);
    }
  }

  const query = args.join(" ").trim();
  if (!query) {
    console.error(t("memory.recall.usage"));
    process.exit(EXIT.USAGE);
  }

  const result = await callApi(
    createClient(url, apiKey).recall({ query, topK: limit, vectorWeight: 0.7 })
  );

  const rawHits = result.hits;
  // Map content → statement for printRecallTable (canonical /recall returns content)
  const hits = rawHits.map((h) => ({ id: h.id, score: h.score, statement: h.content }));
  if (isJson) {
    console.log(JSON.stringify({ hits }, null, 2));
    return;
  }
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.recall.action", { query }),
    pending: true,
  });
  if (hits.length === 0) {
    console.log(t("memory.noResults"));
    return;
  }
  printRecallTable(hits);
}

async function cmdRemember(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  let json = false;
  let sessionId: string | undefined;
  const words: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!literal && arg === "--") {
      literal = true;
      continue;
    }
    if (!literal && arg === "--json") {
      json = true;
      continue;
    }
    if (!literal && arg === "--session-id") {
      sessionId = args[++i];
      if (!sessionId) {
        console.error(t("memory.remember.sessionIdRequired"));
        process.exit(EXIT.USAGE);
      }
      continue;
    }
    if (!literal && arg.startsWith("-")) {
      console.error(t("memory.remember.unknownFlag", { arg }));
      process.exit(EXIT.USAGE);
    }
    words.push(arg);
  }
  const text = words.join(" ").trim();
  if (!text) {
    console.error(t("memory.remember.usage"));
    process.exit(EXIT.USAGE);
  }
  const result = await callApi(
    createClient(url, apiKey).remember({ statement: text, ...(sessionId ? { sessionId } : {}) })
  );
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  const preview = text.length > 50 ? `${text.slice(0, 50)}…` : text;
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("memory.remember.saved"),
    detail: preview,
    id: result.id,
  });
}

async function cmdForget(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const id = args[0];
  if (!id) {
    console.error(t("memory.forget.usage"));
    process.exit(EXIT.USAGE);
  }
  await callApi(createClient(url, apiKey).forgetFact(id));
  statusLine({
    mode: config.uiMode,
    kind: "destructive",
    action: t("memory.forget.done"),
    detail: id,
  });
}

// ── Fact list/search/show helpers ────────────────────────────────────────────

interface FactSummary {
  id: string;
  subject?: string;
  statement: string;
  kind?: string;
  confidence?: number;
}

function printFactLine(fact: FactSummary): void {
  const subject = fact.subject ? `${fact.subject}: ` : "";
  const kind = fact.kind ?? "fact";
  const conf = fact.confidence != null ? fact.confidence.toFixed(2) : "—";
  console.log(`[${fact.id}] ${subject}${fact.statement} (${kind}, ${conf})`);
}

async function cmdList(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };

  // Parse --limit N flag
  let limit = 20;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1) {
    const n = Number(args[limitIdx + 1]);
    if (!Number.isFinite(n) || n < 1) {
      console.error(t("memory.limitInvalid", { flag: "--limit" }));
      process.exit(EXIT.USAGE);
    }
    limit = n;
  }

  const result = await callApi(
    createClient(url, apiKey).listFacts({ limit, sortBy: "created_at", order: "desc" })
  );
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.facts.listing"),
    pending: true,
  });

  const items = result.items;
  if (!items.length) {
    console.log(t("memory.empty.facts"));
    return;
  }
  for (const fact of items) {
    printFactLine(fact);
  }
}

async function cmdSearch(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };

  const query = args.join(" ").trim();
  if (!query) {
    console.error(t("memory.search.usage"));
    process.exit(EXIT.USAGE);
  }

  // Uses the recall pipeline (POST /recall) which includes FTS fallback
  const result = await callApi(
    createClient(url, apiKey).recall({ query, topK: 10, vectorWeight: 0.7 })
  );
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.search.action", { query }),
    pending: true,
  });

  if (!result.hits.length) {
    console.log(t("memory.noResults"));
    return;
  }
  for (const hit of result.hits) {
    printFactLine({ id: hit.id, statement: hit.content });
  }
}

async function cmdShow(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const id = args[0];
  if (!id) {
    console.error(t("memory.show.usage"));
    process.exit(EXIT.USAGE);
  }

  const result = await callApi(createClient(url, apiKey).getFact(id));
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.show.fetching"),
    detail: id,
    pending: true,
  });
  console.log(JSON.stringify(result, null, 2));
}

// ── Workspace commands ────────────────────────────────────────────────────────

async function cmdWorkspaceList(_args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  // L1: was a raw apiFetch("/workspaces/mine") escape hatch specifically
  // because client.listMyWorkspaces() used to swallow fetch errors to `[]`
  // internally — fixed (C4), so the typed method is now safe to trust here:
  // a real API failure surfaces via callApi's `Error: <status> ...` + exit
  // 1, not a misleading "No workspaces found."
  const workspaces = await callApi(createClient(url, apiKey).listMyWorkspaces());
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("workspaceList.listingWorkspaces"),
    pending: true,
  });
  if (!workspaces.length) {
    console.log(t("workspaceList.noWorkspacesFound"));
    return;
  }
  const ID_W = 38;
  const NAME_W = 30;
  const ROLE_W = 8;
  const line = `${"─".repeat(ID_W + 2)}┼${"─".repeat(NAME_W + 2)}┼${"─".repeat(ROLE_W + 2)}┼${"─".repeat(10 + 2)}`;
  console.log(
    `${t("workspaceTable.id").padEnd(ID_W)} │ ${t("workspaceTable.name").padEnd(NAME_W)} │ ${t("workspaceTable.role").padEnd(ROLE_W)} │ ${t("workspaceTable.visibility")}`
  );
  console.log(line);
  for (const ws of workspaces) {
    const id = ws.workspaceId.padEnd(ID_W);
    const name = (
      ws.workspaceName.length > NAME_W
        ? ws.workspaceName.slice(0, NAME_W - 1) + "…"
        : ws.workspaceName
    ).padEnd(NAME_W);
    const role = ws.role.padEnd(ROLE_W);
    console.log(`${id} │ ${name} │ ${role} │ ${ws.visibility}`);
  }
}

async function cmdWorkspaceShow(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const workspaceId = args[0];
  if (!workspaceId) {
    console.error(t("workspaceShow.usageMnemoWorkspaceShow"));
    process.exit(EXIT.USAGE);
  }
  const ws = await callApi(createClient(url, apiKey).getWorkspaceById(workspaceId));
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("workspaceShow.fetchingWorkspace"),
    detail: workspaceId,
    pending: true,
  });
  console.log(t("workspaceShow.id", { id: ws.id }));
  console.log(t("workspaceShow.name", { name: ws.name }));
  console.log(t("workspaceShow.slug", { slug: ws.slug ?? t("common.none") }));
  console.log(t("workspaceShow.tenant", { tenantId: ws.tenantId }));
  console.log(t("workspaceShow.visibility", { visibility: ws.visibility }));
  console.log(t("workspaceShow.created", { createdAt: ws.createdAt ?? t("common.unknown") }));
}

async function cmdWorkspaceMembers(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const workspaceId = args[0];
  if (!workspaceId) {
    console.error(t("workspaceMembers.usageMnemoWorkspaceMembers"));
    process.exit(EXIT.USAGE);
  }
  // L1: same fix as cmdWorkspaceList above — client.listWorkspaceMembers()
  // no longer swallows errors to `[]` (C4), so this is safe to trust directly.
  const members = await callApi(createClient(url, apiKey).listWorkspaceMembers(workspaceId));
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("workspaceMembers.listingWorkspaceMembers"),
    detail: workspaceId,
    pending: true,
  });
  if (!members.length) {
    console.log(t("workspaceMembers.noMembersFound"));
    return;
  }
  const ID_W = 38;
  const ROLE_W = 8;
  const line = `${"─".repeat(ID_W + 2)}┼${"─".repeat(ROLE_W + 2)}┼${"─".repeat(24 + 2)}`;
  console.log(
    `${t("workspaceTable.userId").padEnd(ID_W)} │ ${t("workspaceTable.role").padEnd(ROLE_W)} │ ${t("workspaceTable.joinedAt")}`
  );
  console.log(line);
  for (const m of members) {
    const id = m.userId.padEnd(ID_W);
    const role = m.role.padEnd(ROLE_W);
    const joined = m.joinedAt ?? "—";
    console.log(`${id} │ ${role} │ ${joined}`);
  }
}

async function cmdWorkspaceCreate(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const name = getFlag(args, "--name");
  if (!name) {
    console.error(t("workspaceCreate.usageMnemoWorkspaceCreate"));
    process.exit(EXIT.USAGE);
  }
  const client = createClient(url, apiKey);
  let tenantId = getFlag(args, "--tenant");
  if (!tenantId) {
    const me = await callApi(client.getMe());
    if (!me.tenantId) {
      console.error(t("workspaceCreate.errorTenantWasNot"));
      process.exit(1);
    }
    tenantId = me.tenantId;
  }
  const slug = getFlag(args, "--slug");
  const visibility = getFlag(args, "--visibility") as "private" | "public" | undefined;
  const ownerUserId = getFlag(args, "--owner");
  const ws = await callApi(
    client.createWorkspace(tenantId, {
      name,
      ...(slug ? { slug } : {}),
      ...(visibility ? { visibility } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("workspaceCreate.workspaceCreated"),
    detail: t("workspaceCreate.tenant", { id: ws.id, name: ws.name, tenantId: ws.tenantId }),
  });
}

async function cmdWorkspaceInvite(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const workspaceId = args[0];
  const userId = args[1];
  if (!workspaceId || !userId) {
    console.error(t("workspaceInvite.usageMnemoWorkspaceInvite"));
    process.exit(EXIT.USAGE);
  }
  const role = getFlag(args, "--role") as "owner" | "admin" | "write" | "read" | undefined;
  await callApi(
    createClient(url, apiKey).inviteWorkspaceMember(workspaceId, {
      userId,
      ...(role ? { role } : {}),
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "admin",
    action: t("workspaceInvite.added", {
      userId,
      workspaceId,
      asRole: role ? t("workspaceInvite.asRole", { role }) : "",
    }),
  });
}

async function cmdWorkspaceSetRole(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const workspaceId = args[0];
  const userId = args[1];
  const role = args[2] as "owner" | "admin" | "write" | "read" | undefined;
  if (!workspaceId || !userId || !role) {
    console.error(t("workspaceSetRole.usageMnemoWorkspaceSet"));
    process.exit(EXIT.USAGE);
  }
  await callApi(createClient(url, apiKey).updateWorkspaceMemberRole(workspaceId, userId, role));
  statusLine({
    mode: config.uiMode,
    kind: "admin",
    action: t("workspaceSetRole.sRoleInWorkspace", { userId, workspaceId, role }),
  });
}

async function cmdWorkspaceRemove(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const workspaceId = args[0];
  const userId = args[1];
  if (!workspaceId || !userId) {
    console.error(t("workspaceRemove.usageMnemoWorkspaceRemove"));
    process.exit(EXIT.USAGE);
  }
  await callApi(createClient(url, apiKey).removeWorkspaceMember(workspaceId, userId));
  statusLine({
    mode: config.uiMode,
    kind: "destructive",
    action: t("workspaceRemove.removedFromWorkspace", { userId, workspaceId }),
  });
}

// ── Primitive-parity commands (CLI-PARITY-1) ─────────────────────────────────
//
// Added to close the gap between the CLI and the MCP/HTTP surface: only
// fact CRUD had a CLI command before this; the other 9 cognitive primitives
// and relations were CLI-inaccessible. Each command below is a thin wrapper
// over the same @mnemo-ai/client-ts methods the MCP tools and HTTP routes
// already use — no new server behavior, just a new client surface.

/** Extract a `--flag value` pair from an args array. Mirrors the inline
 * `rest.find((_, i) => rest[i - 1] === "--x")` pattern already used by
 * `keys create` above, factored out since ~15 new commands need it. */
function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function getNumberFlag(args: string[], name: string): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(t("memory.flagMustBeNumber", { name }));
    process.exit(EXIT.USAGE);
  }
  return n;
}

function getListFlag(args: string[], name: string): string[] | undefined {
  const raw = getFlag(args, name);
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

async function cmdDecide(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const kind = getFlag(rest, "--kind");
    const title = getFlag(rest, "--title");
    const body = getFlag(rest, "--body");
    if (!kind || !title || !body) {
      console.error(t("memory.decide.createUsage"));
      console.error(t("decide.kindDecisionArchitecturePolicy"));
      process.exit(EXIT.USAGE);
    }
    const topicKey = getFlag(rest, "--topic-key");
    const scopeRef = getFlag(rest, "--scope-ref");
    const result = await callApi(
      client.createDecision({
        kind: kind as
          | "decision"
          | "architecture"
          | "policy"
          | "process"
          | "bugfix"
          | "learning"
          | "discovery"
          | "config",
        title,
        body,
        ...(topicKey ? { topicKey } : {}),
        ...(scopeRef ? { scopeRef } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.decide.recorded"),
      detail: title,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const status = getFlag(rest, "--status") as "active" | "superseded" | "withdrawn" | undefined;
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listDecisions({ status, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("memory.decide.listing"),
      pending: true,
    });
    printList("decisions", result.items, t("memory.empty.decisions"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.decide.showUsage"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getDecision(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("memory.decide.fetching"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "supersede") {
    const id = rest[0];
    const supersededById = getFlag(rest, "--by");
    if (!id || !supersededById) {
      console.error(t("memory.decide.supersedeUsage"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.supersedeDecision(id, { supersededById }));
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.decide.superseded", { id: supersededById }),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("memory.decide.unknownSub", { sub: String(subCmd) }));
  process.exit(EXIT.USAGE);
}

async function cmdEntity(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const name = getFlag(rest, "--name");
    const kind = getFlag(rest, "--kind");
    if (!name || !kind) {
      console.error(t("memory.entity.createUsage"));
      console.error(t("entity.kindPersonOrganizationProject"));
      process.exit(EXIT.USAGE);
    }
    const aliases = getListFlag(rest, "--aliases");
    const description = getFlag(rest, "--description");
    const result = await callApi(
      client.createEntity({
        name,
        kind: kind as "person" | "organization" | "project" | "concept" | "place" | "other",
        ...(aliases ? { aliases } : {}),
        ...(description ? { description } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.entity.created"),
      detail: name,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const kind = getFlag(rest, "--kind") as
      "person" | "organization" | "project" | "concept" | "place" | "other" | undefined;
    const q = getFlag(rest, "--q");
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listEntities({ kind, q, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("memory.entity.listing"),
      pending: true,
    });
    printList("entities", result.items, t("memory.empty.entities"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.entity.showUsage"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getEntity(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("memory.entity.fetching"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "update") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.entity.updateUsage"));
      process.exit(EXIT.USAGE);
    }
    const name = getFlag(rest, "--name");
    const kind = getFlag(rest, "--kind") as
      "person" | "organization" | "project" | "concept" | "place" | "other" | undefined;
    const aliases = getListFlag(rest, "--aliases");
    const canonicalIdRaw = getFlag(rest, "--canonical-id");
    const canonicalId = canonicalIdRaw === "null" ? null : canonicalIdRaw;
    const result = await callApi(
      client.updateEntity(id, {
        ...(name ? { name } : {}),
        ...(kind ? { kind } : {}),
        ...(aliases ? { aliases } : {}),
        ...(canonicalIdRaw !== undefined ? { canonicalId } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.entity.updated"),
      detail: name ?? id,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "facts") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.entity.factsUsage"));
      process.exit(EXIT.USAGE);
    }
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listEntityFacts(id, { limit }));
    printList("facts", result.facts, t("memory.empty.facts"));
    return;
  }

  if (subCmd === "link-user") {
    const id = rest[0];
    const userId = rest[1];
    if (!id || !userId) {
      console.error(t("memory.entity.linkUserUsage"));
      console.error(t("memory.entity.linkUserNote"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.linkEntityUser(id, { userId }));
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.entity.linked"),
      detail: userId,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "unlink-user") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.entity.unlinkUsage"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.unlinkEntityUser(id));
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("memory.entity.unlinked"),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("memory.entity.unknownSub", { sub: String(subCmd) }));
  process.exit(EXIT.USAGE);
}

const RELATION_VERBS = [
  "related",
  "compatible",
  "scoped",
  "conflicts_with",
  "supersedes",
  "not_conflict",
  "derived_from",
  "part_of",
  "member_of",
] as const;

async function cmdRelate(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "list") {
    const judgmentStatus = getFlag(rest, "--judgment-status") as
      "pending" | "judged" | "dismissed" | undefined;
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listRelations({ judgmentStatus, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("relate.listingRelations"),
      pending: true,
    });
    printList("relations", result.items, t("empty.relations"));
    return;
  }

  if (subCmd === "history") {
    const [sourceKind, sourceId] = rest;
    if (!sourceKind || !sourceId) {
      console.error(t("relate.usageMnemoRelateHistory"));
      console.error(t("relate.sourcekindFactDecisionEntity"));
      console.error(t("relate.walksTheSupersedesDerived"));
      process.exit(EXIT.USAGE);
    }
    const maxDepth = getNumberFlag(rest, "--max-depth");
    const result = await callApi(
      client.relationsTraverse({
        rootId: sourceId,
        rootKind: sourceKind as "fact" | "decision" | "entity" | "episode",
        maxDepth: maxDepth ?? 5,
        verbs: ["supersedes", "derived_from"],
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("relate.walkingRelationHistory"),
      detail: `${sourceKind}:${sourceId}`,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Default (no subcommand or "create"): positional create form.
  const createArgs = subCmd === "create" ? rest : args;
  const [sourceKind, sourceId, verb, targetKind, targetId] = createArgs;
  if (!sourceKind || !sourceId || !verb || !targetKind || !targetId) {
    console.error(t("relate.usageMnemoRelateSourcekind"));
    console.error(t("relate.sourcekindTargetkindFactDecision"));
    console.error(t("relate.verbHint", { verbs: RELATION_VERBS.join("|") }));
    console.error(t("relate.mnemoRelateListJudgment"));
    console.error(t("relate.mnemoRelateHistorySourcekind"));
    process.exit(EXIT.USAGE);
  }
  if (!(RELATION_VERBS as readonly string[]).includes(verb)) {
    console.error(t("relate.unknownVerb", { verb, verbs: RELATION_VERBS.join(", ") }));
    process.exit(EXIT.USAGE);
  }
  const reason = getFlag(createArgs, "--reason");
  const confidence = getNumberFlag(createArgs, "--confidence");
  const markedByKind = (getFlag(createArgs, "--marked-by-kind") ?? "agent") as
    "user" | "agent" | "system" | "llm_judge";
  const result = await callApi(
    client.createRelation({
      sourceKind: sourceKind as "fact" | "decision" | "entity" | "episode",
      sourceId,
      targetKind: targetKind as "fact" | "decision" | "entity" | "episode",
      targetId,
      relation: verb as (typeof RELATION_VERBS)[number],
      markedByKind,
      ...(reason ? { reason } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("relate.relationCreated"),
    detail: `${verb}: ${sourceKind}:${sourceId} → ${targetKind}:${targetId}`,
    id: result.id,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdStrategy(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const trigger = getFlag(rest, "--trigger");
    const action = getFlag(rest, "--action");
    if (!trigger || !action) {
      console.error(t("strategy.usageMnemoStrategyCreate"));
      process.exit(EXIT.USAGE);
    }
    const context = getFlag(rest, "--context");
    const scopeRef = getFlag(rest, "--scope-ref");
    const result = await callApi(
      client.createStrategy({
        trigger,
        action,
        ...(context ? { context } : {}),
        ...(scopeRef ? { scopeRef } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("strategy.strategyCreated"),
      detail: trigger,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const status = getFlag(rest, "--status") as "active" | "superseded" | "archived" | undefined;
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listStrategies({ status, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("strategy.listingStrategies"),
      pending: true,
    });
    printList("strategies", result.items, t("empty.strategies"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("strategy.usageMnemoStrategyShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getStrategy(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("strategy.fetchingStrategy"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "update") {
    const id = rest[0];
    if (!id) {
      console.error(t("strategy.usageMnemoStrategyUpdate"));
      process.exit(EXIT.USAGE);
    }
    const trigger = getFlag(rest, "--trigger");
    const action = getFlag(rest, "--action");
    const context = getFlag(rest, "--context");
    const status = getFlag(rest, "--status") as "active" | "superseded" | "archived" | undefined;
    const result = await callApi(
      client.patchStrategy(id, {
        ...(trigger ? { trigger } : {}),
        ...(action ? { action } : {}),
        ...(context ? { context } : {}),
        ...(status ? { status } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("strategy.strategyUpdated"),
      detail: trigger ?? action,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "archive") {
    const id = rest[0];
    if (!id) {
      console.error(t("strategy.usageMnemoStrategyArchive"));
      process.exit(EXIT.USAGE);
    }
    await callApi(client.archiveStrategy(id));
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("strategy.archived"),
      detail: id,
    });
    return;
  }

  if (subCmd === "rate") {
    const id = rest[0];
    const outcome = rest[1];
    if (!id || (outcome !== "success" && outcome !== "failure")) {
      console.error(t("strategy.usageMnemoStrategyRate"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.rateStrategy(id, outcome));
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("strategy.strategyRated", { outcome }),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("strategy.unknownStrategySubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

async function cmdWorkflow(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const name = getFlag(rest, "--name");
    const stepsRaw = getFlag(rest, "--steps");
    if (!name || !stepsRaw) {
      console.error(t("workflow.usageMnemoWorkflowCreate"));
      console.error(t("workflow.stepsAJsonArray"));
      console.error(t("workflow.actionExpecteddurationmsConditionTools"));
      process.exit(EXIT.USAGE);
    }
    let rawSteps: unknown[];
    try {
      rawSteps = JSON.parse(stepsRaw);
      if (!Array.isArray(rawSteps)) throw new Error("not an array");
    } catch {
      console.error(t("workflow.errorStepsMustBe"));
      process.exit(EXIT.USAGE);
    }
    // The server's WorkflowStep requires {order, action, expectedDurationMs}
    // (condition/tools optional) — a flat string array (what this command
    // used to send verbatim) fails the server's schema with a 400. Accept
    // plain strings as shorthand for {action}, and fill in order/
    // expectedDurationMs so either input shape reaches the server valid.
    const steps = rawSteps.map((s, i) => {
      if (typeof s === "string") {
        return { order: i, action: s, expectedDurationMs: 0 };
      }
      if (s && typeof s === "object" && !Array.isArray(s)) {
        const obj = s as Record<string, unknown>;
        if (typeof obj.action !== "string" || obj.action.length === 0) {
          console.error(t("workflow.errorStepMustHave", { i }));
          process.exit(EXIT.USAGE);
        }
        return {
          order: typeof obj.order === "number" ? obj.order : i,
          action: obj.action,
          expectedDurationMs:
            typeof obj.expectedDurationMs === "number" ? obj.expectedDurationMs : 0,
          ...(typeof obj.condition === "string" ? { condition: obj.condition } : {}),
          ...(Array.isArray(obj.tools) ? { tools: obj.tools as string[] } : {}),
        };
      }
      console.error(t("workflow.errorStepMustBe", { i }));
      process.exit(EXIT.USAGE);
    });
    const description = getFlag(rest, "--description");
    const scopeRef = getFlag(rest, "--scope-ref");
    const result = await callApi(
      client.createWorkflow({
        name,
        steps,
        ...(description ? { description } : {}),
        ...(scopeRef ? { scopeRef } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("workflow.workflowCreated"),
      detail: name,
      id: (result as { id?: string }).id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const status = getFlag(rest, "--status");
    const scopeRef = getFlag(rest, "--scope-ref");
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listWorkflows({ status, scopeRef, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("workflow.listingWorkflows"),
      pending: true,
    });
    printList("workflows", result.items, t("empty.workflows"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("workflow.usageMnemoWorkflowShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getWorkflow(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("workflow.fetchingWorkflow"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("workflow.unknownWorkflowSubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

async function cmdSkill(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const name = getFlag(rest, "--name");
    const promptTemplate = getFlag(rest, "--prompt");
    if (!name || !promptTemplate) {
      console.error(t("skill.usageMnemoSkillCreate"));
      process.exit(EXIT.USAGE);
    }
    const variables = getListFlag(rest, "--variables");
    const requiredContext = getListFlag(rest, "--required-context");
    const sensitivity = getFlag(rest, "--sensitivity") as
      "public" | "internal" | "confidential" | "restricted" | undefined;
    const result = await callApi(
      client.createSkill({
        name,
        promptTemplate,
        ...(variables ? { variables } : {}),
        ...(requiredContext ? { requiredContext } : {}),
        ...(sensitivity ? { sensitivity } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("skill.skillCreated"),
      detail: name,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listSkills({ limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("skill.listingSkills"),
      pending: true,
    });
    printList("skills", result.items, t("empty.skills"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("skill.usageMnemoSkillShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getSkill(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("skill.fetchingSkill"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("skill.unknownSkillSubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

async function cmdReasoning(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  function parseChain(raw: string | undefined): Array<{
    step: number;
    reasoning: string;
    conclusion?: string;
  }> {
    if (!raw) {
      console.error(t("reasoning.errorChainIsRequired"));
      process.exit(EXIT.USAGE);
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed;
    } catch {
      console.error(t("reasoning.errorChainMustBe"));
      process.exit(EXIT.USAGE);
    }
  }

  if (subCmd === "create") {
    const question = getFlag(rest, "--question");
    const conclusion = getFlag(rest, "--conclusion");
    if (!question || !conclusion) {
      console.error(t("reasoning.usageMnemoReasoningCreate"));
      console.error(t("reasoning.chainItemShapeStep"));
      process.exit(EXIT.USAGE);
    }
    const chain = parseChain(getFlag(rest, "--chain"));
    const topicKey = getFlag(rest, "--topic-key");
    const result = await callApi(
      client.createReasoning({ question, chain, conclusion, ...(topicKey ? { topicKey } : {}) })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("reasoning.reasoningRecorded"),
      detail: question,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listReasoning({ limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("reasoning.listingReasoning"),
      pending: true,
    });
    printList("reasoning", result.items, t("empty.reasoning"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("reasoning.usageMnemoReasoningShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getReasoning(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("reasoning.fetchingReasoning"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "archive") {
    const id = rest[0];
    if (!id) {
      console.error(t("reasoning.usageMnemoReasoningArchive"));
      process.exit(EXIT.USAGE);
    }
    await callApi(client.archiveReasoning(id));
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("reasoning.archived"),
      detail: id,
    });
    return;
  }

  if (subCmd === "resolve") {
    const query = rest.join(" ").trim();
    if (!query) {
      console.error(t("reasoning.usageMnemoReasoningResolve"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.resolveReasoning({ query }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("reasoning.resolvingReasoning"),
      detail: query,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "record") {
    const question = getFlag(rest, "--question");
    const conclusion = getFlag(rest, "--conclusion");
    if (!question || !conclusion) {
      console.error(t("reasoning.usageMnemoReasoningRecord"));
      console.error(t("reasoning.chainItemShapeStep"));
      process.exit(EXIT.USAGE);
    }
    const chain = parseChain(getFlag(rest, "--chain"));
    const outcome = getFlag(rest, "--outcome") as "success" | "fail" | undefined;
    const result = await callApi(
      client.recordReasoning({ question, chain, conclusion, ...(outcome ? { outcome } : {}) })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("reasoning.reasoningLogged"),
      detail: question,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "feedback") {
    const id = rest[0];
    const outcome = rest[1];
    if (!id || (outcome !== "success" && outcome !== "fail")) {
      console.error(t("reasoning.usageMnemoReasoningFeedback"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.reasoningFeedback({ reasoning_id: id, outcome }));
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("reasoning.reasoningFeedbackRecorded", { outcome }),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("reasoning.unknownReasoningSubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

async function cmdHyperedge(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const memberIds = getListFlag(rest, "--members");
    if (!memberIds || memberIds.length < 3) {
      console.error(t("hyperedge.usageMnemoHyperedgeCreate"));
      console.error(t("hyperedge.requiresAtLeastMember"));
      process.exit(EXIT.USAGE);
    }
    const label = getFlag(rest, "--label");
    const description = getFlag(rest, "--description");
    const contextQuery = getFlag(rest, "--context-query");
    const result = await callApi(
      client.createHyperedge({
        memberIds,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(contextQuery ? { contextQuery } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("hyperedge.hyperedgeCreated"),
      detail: label ?? memberIds.join(","),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const memberId = getFlag(rest, "--member-id");
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listHyperedges({ memberId, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("hyperedge.listingHyperedges"),
      pending: true,
    });
    printList("hyperedges", result.items, t("empty.hyperedges"));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("hyperedge.usageMnemoHyperedgeShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getHyperedge(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("hyperedge.fetchingHyperedge"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "update") {
    const id = rest[0];
    if (!id) {
      console.error(t("hyperedge.usageMnemoHyperedgeUpdate"));
      process.exit(EXIT.USAGE);
    }
    const label = getFlag(rest, "--label");
    const description = getFlag(rest, "--description");
    const contextQuery = getFlag(rest, "--context-query");
    const result = await callApi(
      client.patchHyperedge(id, {
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(contextQuery ? { contextQuery } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("hyperedge.hyperedgeUpdated"),
      detail: label,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "archive") {
    const id = rest[0];
    if (!id) {
      console.error(t("hyperedge.usageMnemoHyperedgeArchive"));
      process.exit(EXIT.USAGE);
    }
    await callApi(client.archiveHyperedge(id));
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("hyperedge.archived"),
      detail: id,
    });
    return;
  }

  console.error(t("hyperedge.unknownHyperedgeSubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

/** Extends the existing list-only `events` command with create/show/archive. */
async function cmdEventsExtended(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const type = getFlag(rest, "--type");
    const name = getFlag(rest, "--name");
    const description = getFlag(rest, "--description");
    const source = getFlag(rest, "--source");
    if (!type || !name || !description || !source) {
      console.error(t("eventsExtended.usageMnemoEventsCreate"));
      console.error(t("eventsExtended.typeSystemExternalUser"));
      process.exit(EXIT.USAGE);
    }
    const occurredAt = getFlag(rest, "--occurred-at") ?? new Date().toISOString();
    const result = await callApi(
      client.createEvent({
        type: type as "system" | "external" | "user" | "agent" | "scheduled",
        name,
        description,
        source,
        occurredAt,
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("eventsExtended.eventRecorded"),
      detail: name,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("eventsExtended.usageMnemoEventsShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getEvent(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("eventsExtended.fetchingEvent"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "archive") {
    const id = rest[0];
    if (!id) {
      console.error(t("eventsExtended.usageMnemoEventsArchive"));
      process.exit(EXIT.USAGE);
    }
    await callApi(client.archiveEvent(id));
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("eventsExtended.archived"),
      detail: id,
    });
    return;
  }

  if (subCmd === "sensitivity") {
    const id = rest[0];
    const sensitivity = rest[1] as
      "public" | "internal" | "confidential" | "restricted" | undefined;
    const validTiers = ["public", "internal", "confidential", "restricted"];
    if (!id || !sensitivity || !validTiers.includes(sensitivity)) {
      console.error(t("eventsExtended.sensitivityUsage", { tiers: validTiers.join("|") }));
      console.error(t("eventsExtended.raiseOnlyTheServer"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.updateEventSensitivity(id, { sensitivity }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No subcommand, or "list": fall back to the original list-only behavior.
  return cmdEvents(subCmd === "list" ? rest : args, config);
}

/** Extends the existing list-only `tasks` command with create/update/delegate. */
async function cmdTasksExtended(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const title = getFlag(rest, "--title");
    const assignedTo = getFlag(rest, "--assigned-to");
    if (!title || !assignedTo) {
      console.error(t("tasksExtended.usageMnemoTasksCreate"));
      process.exit(EXIT.USAGE);
    }
    const description = getFlag(rest, "--description");
    const priority = getFlag(rest, "--priority") as
      "critical" | "high" | "medium" | "low" | undefined;
    const dueAt = getFlag(rest, "--due-at");
    const result = await callApi(
      client.createTask({
        title,
        assignedTo,
        ...(description ? { description } : {}),
        ...(priority ? { priority } : {}),
        ...(dueAt ? { dueAt } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("tasksExtended.taskCreated"),
      detail: title,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error(t("tasksExtended.usageMnemoTasksShow"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.getTask(id));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("tasksExtended.fetchingTask"),
      detail: id,
      pending: true,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "update") {
    const id = rest[0];
    if (!id) {
      console.error(t("tasksExtended.usageMnemoTasksUpdate"));
      process.exit(EXIT.USAGE);
    }
    const status = getFlag(rest, "--status") as
      "pending" | "in_progress" | "blocked" | "delegated" | "completed" | "cancelled" | undefined;
    const outcome = getFlag(rest, "--outcome");
    const lessonsLearned = getFlag(rest, "--lessons-learned");
    const result = await callApi(
      client.patchTask(id, {
        ...(status ? { status } : {}),
        ...(outcome ? { outcome } : {}),
        ...(lessonsLearned ? { lessonsLearned } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("tasksExtended.taskUpdated"),
      detail: status ?? outcome,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "delegate") {
    const id = rest[0];
    const assignedTo = getFlag(rest, "--to");
    if (!id || !assignedTo) {
      console.error(t("tasksExtended.usageMnemoTasksDelegate"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(client.delegateTask(id, { assignedTo }));
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("tasksExtended.taskDelegatedTo", { assignedTo }),
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No subcommand, or "list": fall back to the original list-only behavior.
  return cmdTasks(subCmd === "list" ? rest : args, config);
}

async function cmdEpisode(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "start") {
    const label = getFlag(rest, "--label");
    const agentId = getFlag(rest, "--agent-id");
    const result = await callApi(
      client.createSession({ ...(label ? { label } : {}), ...(agentId ? { agentId } : {}) })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("memory.episode.started"),
      detail: label,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "collapse") {
    const id = rest[0];
    if (!id) {
      console.error(t("memory.episode.collapseUsage"));
      process.exit(EXIT.USAGE);
    }
    const collapseHint = getFlag(rest, "--hint");
    const strategy = getFlag(rest, "--strategy") as "auto" | "explicit" | undefined;
    const result = await callApi(
      client.collapseSession(id, {
        ...(collapseHint ? { collapseHint } : {}),
        ...(strategy ? { strategy } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action:
        result.status === "skipped"
          ? result.skipReason
            ? t("memory.episode.skippedWithReason", { reason: result.skipReason })
            : t("memory.episode.skipped")
          : result.status === "failed"
            ? t("memory.episode.collapseFailed")
            : result.status === "collapse_pending"
              ? t("memory.episode.collapsePending")
              : t("memory.episode.collapsed"),
      id: result.sessionId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error(t("memory.episode.unknownSub", { sub: String(subCmd) }));
  process.exit(EXIT.USAGE);
}

async function cmdPin(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const id = args[0];
  if (!id) {
    console.error(t("memory.pin.usage"));
    process.exit(EXIT.USAGE);
  }
  const result = await callApi(createClient(url, apiKey).pinFact(id));
  statusLine({ mode: config.uiMode, kind: "write", action: t("memory.pin.done"), id: result.id });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUnpin(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const id = args[0];
  if (!id) {
    console.error(t("memory.pin.unpinUsage"));
    process.exit(EXIT.USAGE);
  }
  const result = await callApi(createClient(url, apiKey).unpinFact(id));
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("memory.pin.unpinDone"),
    id: result.id,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdTimeline(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const limit = getNumberFlag(args, "--limit");
  const since = getFlag(args, "--since");
  const result = await callApi(
    createClient(url, apiKey).timeline({
      ...(limit !== undefined ? { limit } : {}),
      ...(since ? { since } : {}),
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("memory.timeline.loading"),
    pending: true,
  });
  printList("events", result.events, t("memory.empty.events"));
}

async function cmdJudge(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "resolve") {
    const relationId = rest[0];
    const action = rest[1];
    const validActions = ["supersede_a", "supersede_b", "keep_both", "merge"] as const;
    if (!relationId || !(validActions as readonly string[]).includes(action ?? "")) {
      console.error(t("judge.resolveUsage", { actions: validActions.join("|") }));
      console.error(t("judge.mergedStatementIsRequired"));
      process.exit(EXIT.USAGE);
    }
    const mergedStatement = getFlag(rest, "--merged-statement");
    if (action === "merge" && !mergedStatement?.trim()) {
      console.error(t("judge.usageMnemoJudgeResolve"));
      console.error(t("judge.mergeRequiresMergedStatement"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(
      client.resolveConflict(relationId, {
        action: action as (typeof validActions)[number],
        ...(mergedStatement ? { mergedStatement } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("judge.conflictResolved", { action: result.action }),
      id: result.relationId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No subcommand, or "list": show pending conflict pairs.
  const listArgs = subCmd === "list" ? rest : args;
  const limit = getNumberFlag(listArgs, "--limit");
  const result = await callApi(client.judge(limit !== undefined ? { limit } : undefined));
  statusLine({
    mode: config.uiMode,
    kind: "read",
    action: t("judge.listingConflicts"),
    pending: true,
  });
  printList("pairs", result.pairs, t("empty.pairs"));
}

async function cmdPurge(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);

  if (!args.includes("--confirm")) {
    console.error(t("purge.errorPurgeIsA"));
    console.error(t("purge.usageMnemoPurgeFactid"));
    console.error(t("purge.mnemoPurgeAllClosed"));
    process.exit(EXIT.USAGE);
  }

  if (args.includes("--all-closed")) {
    const result = await callApi(client.purgeClosedFacts());
    statusLine({
      mode: config.uiMode,
      kind: "destructive",
      action: t("purge.purgedClosedFactS", { deleted: result.deleted }),
    });
    return;
  }

  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(t("purge.usageMnemoPurgeFactid"));
    console.error(t("purge.mnemoPurgeAllClosed"));
    process.exit(EXIT.USAGE);
  }
  await callApi(client.purgeFact(id));
  statusLine({ mode: config.uiMode, kind: "destructive", action: t("purge.purged"), detail: id });
}

async function cmdErase(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const userId = getFlag(args, "--user");
  const actorId = getFlag(args, "--actor");
  const confirm = getFlag(args, "--confirm");
  if ((userId === undefined) === (actorId === undefined) || confirm === undefined) {
    console.error(t("erase.usage"));
    console.error(t("erase.usageActor"));
    process.exit(EXIT.USAGE);
  }
  const result = await callApi(
    createClient(url, apiKey).eraseSubject({
      ...(userId !== undefined ? { userId } : { actorId: actorId! }),
      confirm,
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "destructive",
    action: t("erase.erased", { keys: result.keysDestroyed }),
    detail: result.subject.id,
  });
}

async function cmdConsolidate(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const mode = getFlag(args, "--mode") as "fast" | "deep" | undefined;
  const dryRun = args.includes("--dry-run");
  const result = await callApi(
    createClient(url, apiKey).triggerConsolidation({
      ...(mode ? { mode } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    })
  );
  statusLine({
    mode: config.uiMode,
    kind: "write",
    action: t("consolidate.consolidationTriggered"),
    detail: result.mode,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRemind(args: string[], config: Config): Promise<void> {
  const { url, apiKey } = config as { url: string; apiKey: string };
  const client = createClient(url, apiKey);
  const [subCmd, ...rest] = args;

  if (subCmd === "create") {
    const content = getFlag(rest, "--content");
    if (!content) {
      console.error(t("remind.usageMnemoRemindCreate"));
      console.error(t("remind.atLeastOneOf"));
      process.exit(EXIT.USAGE);
    }
    const condition = getFlag(rest, "--condition");
    const triggerAt = getFlag(rest, "--trigger-at");
    if (!condition && !triggerAt) {
      console.error(t("remind.errorAtLeastOne"));
      process.exit(EXIT.USAGE);
    }
    const result = await callApi(
      client.createReminder({
        content,
        ...(condition ? { condition } : {}),
        ...(triggerAt ? { triggerAt } : {}),
      })
    );
    statusLine({
      mode: config.uiMode,
      kind: "write",
      action: t("remind.reminderCreated"),
      detail: content,
      id: result.id,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subCmd === "list" || !subCmd) {
    const status = getFlag(rest, "--status") as
      "pending" | "triggered" | "dismissed" | "all" | undefined;
    const limit = getNumberFlag(rest, "--limit");
    const result = await callApi(client.listReminders({ status, limit }));
    statusLine({
      mode: config.uiMode,
      kind: "read",
      action: t("remind.listingReminders"),
      pending: true,
    });
    printList("reminders", result.reminders, t("empty.reminders"));
    return;
  }

  if (subCmd === "dismiss") {
    const id = rest[0];
    if (!id) {
      console.error(t("remind.usageMnemoRemindDismiss"));
      process.exit(EXIT.USAGE);
    }
    await callApi(client.dismissReminder(id));
    statusLine({ mode: config.uiMode, kind: "write", action: t("remind.dismissed"), detail: id });
    return;
  }

  console.error(t("remind.unknownRemindSubcommandUse", { subCmd }));
  process.exit(EXIT.USAGE);
}

// ── Command type ─────────────────────────────────────────────────────────────

export type CommandFn = (args: string[], config: Config) => Promise<void> | void;

// ── mnemo install ────────────────────────────────────────────────────────────

/**
 * Shape returned by `detectInstalledAgents()` for a single agent entry.
 * Named/exported so `claudeCodePreflight` can be typed against it without
 * duplicating an inline structural type.
 */
export interface DetectedAgent {
  configDir: string;
  detected: boolean;
  binary?: string;
}

/**
 * Detect which AI coding agents are installed on this machine.
 * Returns a map of agent name → config path / binary path.
 */
function detectInstalledAgents(): Record<string, DetectedAgent> {
  const home = homedir();
  const agents: Record<string, DetectedAgent> = {
    "claude-code": {
      configDir: join(home, ".claude"),
      detected: existsSync(join(home, ".claude")),
      binary: spawnSync("which", ["claude"], { stdio: "pipe" }).status === 0 ? "claude" : undefined,
    },
    cursor: {
      configDir: join(home, ".cursor"),
      detected: existsSync(join(home, ".cursor")),
    },
    opencode: {
      configDir: join(home, ".config", "opencode"),
      detected: existsSync(join(home, ".config", "opencode")),
      binary:
        spawnSync("which", ["opencode"], { stdio: "pipe" }).status === 0 ? "opencode" : undefined,
    },
    codex: {
      configDir: join(home, ".codex"),
      detected: existsSync(join(home, ".codex")),
      binary: spawnSync("which", ["codex"], { stdio: "pipe" }).status === 0 ? "codex" : undefined,
    },
    "gemini-cli": {
      configDir: join(home, ".gemini"),
      detected: existsSync(join(home, ".gemini")),
      binary: spawnSync("which", ["gemini"], { stdio: "pipe" }).status === 0 ? "gemini" : undefined,
    },
    windsurf: {
      configDir: join(home, ".codeium", "windsurf"),
      detected: existsSync(join(home, ".codeium", "windsurf")),
    },
  };
  return agents;
}

/**
 * Get the absolute path to the plugin directory in the monorepo or installed package.
 */
function resolvePluginDir(): string | null {
  const __dir = dirname(fileURLToPath(import.meta.url));
  // Monorepo: packages/cli/dist → root/packages/plugin
  // NPM installed package: node_modules/@mnemo-ai/cli/dist → node_modules/@mnemo-ai/cli/plugin
  const candidates = [
    resolve(__dir, "../plugin"),
    resolve(__dir, "../../plugin"),
    resolve(__dir, "../../../packages/plugin"),
    resolve(process.cwd(), "packages/plugin"),
  ];
  return candidates.find((p) => existsSync(join(p, ".claude-plugin", "plugin.json"))) ?? null;
}

/**
 * Copies the Claude Code plugin payload (.claude-plugin, hooks, scripts,
 * skills) from the source `plugin/` dir into the per-agent plugin cache.
 *
 * Re-asserts 0o755 on every `scripts/*.sh` after copying. npm publish
 * strips the executable bit from any file not declared in package.json's
 * `bin` field (verified 2026-07-27: the published @mnemo-ai/cli tarball
 * ships plugin/scripts/*.sh at 0644 despite git tracking them 0755), so
 * `pluginDir` may already be missing +x by the time this runs — a plain
 * `cp -r` preserves whatever mode the source has, bit-stripped or not.
 * hooks.json also invokes scripts via `bash "..."` now so the bit isn't
 * load-bearing, but this keeps direct-by-path invocation safe too.
 */
export function copyClaudeCodePluginFiles(pluginDir: string, pluginTarget: string): void {
  mkdirSync(pluginTarget, { recursive: true });
  for (const entry of [".claude-plugin", "hooks", "scripts", "skills"]) {
    const src = join(pluginDir, entry);
    const dst = join(pluginTarget, entry);
    if (existsSync(src)) {
      spawnSync("cp", ["-r", src, dst], { stdio: "pipe" });
    }
  }
  // Hooks may run with a PATH that does not contain the npm bin directory.
  writeRuntimeLocator(pluginTarget);
  const scriptsTarget = join(pluginTarget, "scripts");
  if (existsSync(scriptsTarget)) {
    for (const f of readdirSync(scriptsTarget)) {
      if (f.endsWith(".sh")) chmodSync(join(scriptsTarget, f), 0o755);
    }
  }
}

// ── Native Claude Code plugin install (marketplace-backed) ──────────────────
//
// Replaces the prior hand-forged installed_plugins.json/settings.json
// mechanism for the default (non-`--local`) `mnemo install` path with real
// `claude plugin marketplace`/`claude plugin` shell-outs. Everything here is
// pure or runner-injected so it can be unit-tested without spawning a real
// `claude` process or mutating a real ~/.claude — see
// packages/cli/src/__tests__/claude-code-plugin-install.test.ts.
//
// See docs/architecture design "cli-install-native-marketplace" (SDD) for the
// full rationale: only the final `plugin install` exit code plus a
// read-back of installed_plugins.json are fatal; steps 1-3 are best-effort.

/** Result of a single `claude <argv>` invocation. */
export interface ClaudeResult {
  status: number | null;
  output: string;
  errorCode?: string;
}

/**
 * Injectable runner seam — production code uses `runClaudeCli`, tests pass a
 * recorder. Deliberately NOT `vi.mock("node:child_process")`: a repo-wide
 * grep found zero precedent for that pattern in this codebase, and existing
 * CLI tests already exercise exported helpers against temp dirs instead.
 */
export type ClaudeRunner = (argv: string[], timeoutMs: number) => ClaudeResult;

/** One planned step of the default install command sequence. */
export interface ClaudeStep {
  argv: string[];
  timeoutMs: number;
}

const MARKETPLACE_REPO = "lucasmailland/mnemosyne";
const MARKETPLACE_NAME = "mnemosyne";

/**
 * Pure — returns the exact, order-significant argv sequence for the default
 * (non-`--local`) install path. No side effects, no subprocess calls, so this
 * is directly unit-testable without a runner.
 */
export function planClaudeCodePluginCommands(): [ClaudeStep, ClaudeStep, ClaudeStep, ClaudeStep] {
  return [
    { argv: ["plugin", "marketplace", "add", MARKETPLACE_REPO], timeoutMs: 120_000 },
    { argv: ["plugin", "marketplace", "update", MARKETPLACE_NAME], timeoutMs: 120_000 },
    { argv: ["plugin", "uninstall", PLUGIN_ID], timeoutMs: 30_000 },
    { argv: ["plugin", "install", PLUGIN_ID], timeoutMs: 120_000 },
  ];
}

/**
 * Production `ClaudeRunner`. Pinned to `cwd: homedir()` so `mnemo install`
 * running from *inside* the mnemosyne repo (a common case) can never resolve
 * `lucasmailland/mnemosyne` repo-relative or pick up a project-local
 * `.claude/settings.json` — matches `claude mcp add --scope user`'s
 * user-scoped intent. No `shell` — argv is passed as an array, and the
 * marketplace slug / plugin id are module constants, never interpolated from
 * user input or config.
 */
export const runClaudeCli: ClaudeRunner = (argv, timeoutMs) => {
  const r = spawnSync("claude", argv, {
    cwd: homedir(),
    stdio: "pipe",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const errorCode = r.error ? ((r.error as NodeJS.ErrnoException).code ?? "UNKNOWN") : undefined;
  return { status: r.status, output, errorCode };
};

export type ClaudeFailureCause = "auth" | "network" | "git-missing" | "unknown";

/**
 * Pure classification of a failed `claude plugin ...` invocation's combined
 * stdout+stderr into a *possible*-cause line — never a certain one, since
 * `claude`'s exit codes/messages for these subcommands are undocumented.
 * String matching here only ever selects message *wording*; it never drives
 * control flow (see design decision "single fatal gate + state read-back").
 */
export function classifyClaudeCliFailure(
  out: string,
  code?: string
): { cause: ClaudeFailureCause; hint: string } {
  const lower = out.toLowerCase();

  if (
    lower.includes("authentication failed") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("repository not found") ||
    lower.includes("could not read from remote") ||
    lower.includes("403") ||
    lower.includes("404")
  ) {
    return {
      cause: "auth",
      hint: t("install.hintAuth", { repo: MARKETPLACE_REPO }),
    };
  }

  if (
    lower.includes("could not resolve host") ||
    lower.includes("network is unreachable") ||
    lower.includes("dns") ||
    code === "ETIMEDOUT"
  ) {
    return {
      cause: "network",
      hint: t("install.hintNetwork"),
    };
  }

  if (
    lower.includes("git: command not found") ||
    (lower.includes("enoent") && lower.includes("git"))
  ) {
    return {
      cause: "git-missing",
      hint: t("install.hintGitMissing"),
    };
  }

  return {
    cause: "unknown",
    hint: t("install.hintUnknown"),
  };
}

/**
 * `claude` binary precondition gate — reuses the `agent.binary` value
 * already computed by `detectInstalledAgents()`'s `which claude` probe.
 * Applies to BOTH install modes (default and `--local`), since `--local`
 * still needs the `claude` CLI for `claude mcp add`. Never throws; mirrors
 * the existing per-agent try/catch skip pattern used by every other branch
 * in `cmdInstall`'s switch.
 */
export function claudeCodePreflight(agent: DetectedAgent): { ok: boolean; message?: string } {
  if (agent.binary) return { ok: true };
  return {
    ok: false,
    message: t("install.preflightNoClaude"),
  };
}

/** Verbatim manual fallback + `--local` pointer, appended to every fatal message. */
function claudePluginFatalFooter(): string {
  return t("install.fatalFooter", { repo: MARKETPLACE_REPO, pluginId: PLUGIN_ID });
}

/**
 * Runs the default (non-`--local`) install sequence: `marketplace add` →
 * `marketplace update` → `plugin uninstall` → `plugin install`, all via the
 * injected `run` (defaults to the real `runClaudeCli`). Steps 1-3 are
 * best-effort — their exit codes never fail the branch, only `plugin
 * install`'s exit code plus a read-back of `installed_plugins.json` do.
 */
export function installClaudeCodePluginNative(o: { configDir: string; run?: ClaudeRunner }): {
  ok: boolean;
  installPath?: string;
  failure?: string;
} {
  const run = o.run ?? runClaudeCli;
  const [addStep, updateStep, uninstallStep, installStep] = planClaudeCodePluginCommands();
  const addResult = run(addStep.argv, addStep.timeoutMs);
  run(updateStep.argv, updateStep.timeoutMs);
  run(uninstallStep.argv, uninstallStep.timeoutMs);
  const installResult = run(installStep.argv, installStep.timeoutMs);

  if (installResult.status !== 0 || installResult.errorCode) {
    const combinedOutput = `${addResult.output}\n${installResult.output}`.trim();
    const { hint } = classifyClaudeCliFailure(combinedOutput, installResult.errorCode);
    const failure = [
      `    ${hint}`,
      combinedOutput ? t("install.failureDetails", { output: combinedOutput }) : undefined,
      claudePluginFatalFooter(),
    ]
      .filter(Boolean)
      .join("\n");
    return { ok: false, failure };
  }

  const entry = readInstalledPluginEntry(o.configDir);
  if (!entry || !entry.gitCommitSha) {
    const failure = [t("install.noPluginEntry"), claudePluginFatalFooter()].join("\n");
    return { ok: false, failure };
  }

  return { ok: true, installPath: entry.installPath };
}

/**
 * `--local` install path: reuses `resolvePluginDir()` + working-tree
 * `copyClaudeCodePluginFiles()`, plus the hand-forged
 * `installed_plugins.json`/`settings.json` writes that used to live in the
 * default path (moved here VERBATIM — this is now their only home). Makes
 * ZERO `claude plugin marketplace`/`claude plugin install`/`uninstall`
 * calls, satisfying mutual exclusivity with the default path.
 */
export function installClaudeCodePluginLocal(o: { pluginDir: string; configDir: string }): {
  ok: boolean;
  pluginTarget: string;
  pluginVersion: string;
} {
  const manifest = JSON.parse(
    readFileSync(join(o.pluginDir, ".claude-plugin", "plugin.json"), "utf8")
  ) as { version: string };
  const pluginVersion = manifest.version;
  const pluginTarget = join(
    o.configDir,
    "plugins",
    "cache",
    "mnemosyne",
    "mnemosyne",
    pluginVersion
  );

  console.warn(t("install.localInstalling", { pluginDir: o.pluginDir }));

  copyClaudeCodePluginFiles(o.pluginDir, pluginTarget);

  // Register in installed_plugins.json — kept ONLY here (removed from the
  // default path) because a working-tree install has no git-hosted
  // gitCommitSha to read back.
  const pluginsJsonPath = join(o.configDir, "plugins", "installed_plugins.json");
  let pluginsData: Record<string, unknown> = { version: 2, plugins: {} };
  try {
    pluginsData = JSON.parse(readFileSync(pluginsJsonPath, "utf8"));
  } catch {
    /* new file */
  }
  const plugins = (pluginsData.plugins ?? {}) as Record<string, unknown[]>;
  plugins["mnemosyne@mnemosyne"] = [
    {
      scope: "user",
      installPath: pluginTarget,
      version: pluginVersion,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    },
  ];
  mkdirSync(dirname(pluginsJsonPath), { recursive: true });
  writeFileSync(pluginsJsonPath, JSON.stringify({ ...pluginsData, plugins }, null, 2));

  // Registering in installed_plugins.json alone does NOT activate the
  // plugin — Claude Code only runs a plugin's hooks/skills for entries
  // present in settings.json's top-level "enabledPlugins" map.
  const settingsPath = join(o.configDir, "settings.json");
  let settingsData: Record<string, unknown> = {};
  try {
    settingsData = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    /* new file */
  }
  const enabledPlugins = (settingsData.enabledPlugins ?? {}) as Record<string, boolean>;
  enabledPlugins["mnemosyne@mnemosyne"] = true;
  settingsData.enabledPlugins = enabledPlugins;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));

  console.warn(t("install.localDone"));

  return { ok: true, pluginTarget, pluginVersion };
}

/**
 * Writes `content` to `path`, UNLESS `path` is a symlink — in which case it
 * warns and skips. `writeFileSync` follows symlinks and writes through to
 * the target, which is destructive when a user manages their agent config
 * files (AGENTS.md, GEMINI.md, …) via a symlinked dotfiles repo: a blind
 * write silently clobbers whatever the symlink points at, with no relation
 * to the file the user thinks they're editing.
 *
 * Verified 2026-07-20: this exact pattern overwrote a real dotfiles-managed
 * ~/.dots/ai-harness/global/AGENTS.md (300+ lines of the user's own agent
 * persona/protocol config) via the ~/.gemini/GEMINI.md symlink, during a
 * `mnemo install` run. Recovered via `git checkout` only because that repo
 * happened to be git-tracked — it would have been permanent data loss
 * otherwise.
 */
function safeWriteFile(path: string, content: string, secretMode?: number): boolean {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    console.warn(t("install.symlinkSkipped", { path }));
    return false;
  }
  // A file holding a credential is replaced atomically with a forced mode;
  // `writeFileSync` would keep an existing 0644 and use the umask for a new one.
  if (secretMode !== undefined) atomicReplace(path, content, { mode: secretMode });
  else writeFileSync(path, content);
  return true;
}

/**
 * ADP-5/autonomous-memory Requirement 6 — check the just-installed Claude Code
 * hook scripts before reporting "installed and enabled" (npm publish once
 * stripped the executable bit and the install still printed success).
 *
 * Offline and side-effect free: no hook is EXECUTED. Running them used to be
 * the check, but every run set MNEMO_INSTALL_VERIFY=1, which made `_helpers.sh`
 * exit 0 at its first line — so a hook was "verified" without one line after
 * its `source` being parsed (APP-037a). What this proves instead:
 *   - every `.sh` parses (`bash -n`), libraries included;
 *   - every hook (not `_`-prefixed library) has its executable bit;
 *   - `jq` and `curl`, which every hook calls, are on PATH. Without them the
 *     hooks run and silently do nothing, which is the failure worth naming.
 * It does not prove a server answers; `verifyMcpHandshake` covers that.
 */
export function verifyClaudeCodeHooks(
  pluginTarget: string,
  searchPath: string = process.env.PATH ?? ""
): {
  ok: boolean;
  failures: string[];
} {
  const scriptsDir = join(pluginTarget, "scripts");
  const failures: string[] = [];

  if (!existsSync(scriptsDir)) {
    return { ok: false, failures: [t("install.verify.noScriptsDir", { scriptsDir })] };
  }

  for (const tool of ["jq", "curl"]) {
    const found = searchPath
      .split(delimiter)
      .filter(Boolean)
      .some((dir) => {
        try {
          accessSync(join(dir, tool), fsConstants.X_OK);
          return statSync(join(dir, tool)).isFile();
        } catch {
          return false;
        }
      });
    if (!found) failures.push(t("install.verify.toolMissing", { tool }));
  }

  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith(".sh")) continue;
    const scriptPath = join(scriptsDir, file);

    // `_`-prefixed files (_helpers.sh, _hook-output.sh) are libraries the hooks
    // `source`; git does not track them executable, so only their syntax counts.
    if (!file.startsWith("_")) {
      try {
        const mode = statSync(scriptPath).mode;
        if ((mode & 0o111) === 0) {
          failures.push(
            t("install.verify.notExecutable", { file, mode: (mode & 0o777).toString(8) })
          );
        }
      } catch (err) {
        failures.push(
          t("install.verify.cannotStat", {
            file,
            message: err instanceof Error ? err.message : String(err),
          })
        );
        continue;
      }
    }

    const syntax = spawnSync("bash", ["-n", scriptPath], {
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (syntax.error) {
      failures.push(t("install.verify.failedToExecute", { file, message: syntax.error.message }));
    } else if (syntax.status !== 0) {
      const stderr = syntax.stderr?.toString().trim().slice(0, 200) ?? "";
      failures.push(
        t("install.verify.syntaxError", {
          file,
          detail: stderr ? t("install.verify.exitedDetail", { stderr }) : "",
        })
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/**
 * ADP-5/autonomous-memory Requirement 6 — lightweight MCP handshake check.
 * Spawns the real MCP entrypoint, sends a JSON-RPC `initialize` request over
 * stdin, and confirms the response includes a non-empty `instructions`
 * field (the same field `MCP_INSTRUCTIONS` populates in `packages/mcp/src/index.ts`).
 * Catches, e.g., a misconfigured MNEMO_URL/MNEMO_KEY at install time instead
 * of at first real use. Best-effort — a failure here is a warning, not an
 * install-blocking failure, since a slow/unavailable npx fetch shouldn't
 * fail an otherwise-successful install.
 */
export async function verifyMcpHandshake(
  mcpPath: string,
  url: string,
  key: string,
  timeoutMs = 5000
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolvePromise) => {
    const isNpx = mcpPath.startsWith("npx");
    const cmd = isNpx ? "npx" : "node";
    const args = isNpx ? mcpPath.split(" ").slice(1) : [mcpPath];

    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, MNEMO_URL: url, MNEMO_KEY: key },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        ok: false,
        message: t("install.handshake.spawnFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      });
      return;
    }

    let settled = false;
    let stdoutBuf = "";
    const finish = (result: { ok: boolean; message?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolvePromise(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, message: t("install.handshake.timeout") }),
      timeoutMs
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      for (const line of stdoutBuf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { instructions?: string } };
          if (msg.id === 1 && msg.result) {
            const instructions = msg.result.instructions;
            if (typeof instructions === "string" && instructions.trim().length > 0) {
              finish({ ok: true });
            } else {
              finish({
                ok: false,
                message: t("install.handshake.noInstructions"),
              });
            }
            return;
          }
        } catch {
          // Not a complete JSON line yet, or unrelated stdout — keep buffering.
        }
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, message: t("install.handshake.processError", { message: err.message }) });
    });

    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mnemo-install-verify", version: "1.0" },
      },
    };
    child.stdin?.write(JSON.stringify(initRequest) + "\n");
  });
}

/**
 * Install Mnemosyne MCP and plugin into all detected AI coding agents.
 *
 * For each detected agent:
 * - Claude Code: claude mcp add, then the native `claude plugin
 *   marketplace`/`claude plugin` command sequence (default), or a
 *   working-tree copy install under `--local`
 * - Cursor: copy .cursor-plugin/ into ~/.cursor/
 * - OpenCode: write MCP config to ~/.config/opencode/
 * - Gemini CLI: copy GEMINI.md + manifest to ~/.gemini/extensions/mnemosyne/
 * - Codex: copy .codex-plugin/ to ~/.codex/
 *
 * `--local` (Claude Code only): installs the plugin from the local
 * working-tree `packages/plugin/` instead of via the native marketplace,
 * for testing uncommitted plugin changes. Development install only — see
 * `installClaudeCodePluginLocal`'s warning text.
 */
/**
 * The workspace id for this API key, straight from the server.
 *
 * Best-effort and deliberately NOT via callApi(): that helper exits the process
 * on failure, and a `/me` that is down must not abort an install whose agent
 * configuration already succeeded. Returns null rather than a placeholder —
 * writing an invented id is what produced "✅ Workspace mapping saved" over a
 * workspace that did not exist.
 */
async function resolveWorkspaceId(url: string, key: string): Promise<string | null> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/me`, {
      headers: { authorization: `Bearer ${key}`, "Accept-Language": getLocale() },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const me = (await res.json()) as { workspaceId?: unknown };
      if (typeof me.workspaceId === "string" && me.workspaceId.length > 0) return me.workspaceId;
    }
  } catch {
    /* unreachable / timed out — the caller reports it */
  }
  return null;
}

export async function cmdInstall(args: string[], config: Config): Promise<void> {
  const url = config.url ?? process.env["MNEMO_URL"] ?? "http://localhost:3939";
  const key = config.apiKey ?? process.env["MNEMO_KEY"] ?? "";

  if (!key) {
    console.error(t("install.noApiKeyFound"));
    process.exit(EXIT.AUTH);
  }

  // Reject anything that is not a flag we know. Silence here is what let
  // `mnemo install --help` run a full install: the flag meant nothing to this
  // function, so it installed anyway. An unknown flag on a command that writes
  // to config files outside the repo has to stop, not be dropped — the user
  // asked for something the command cannot do, and doing something else
  // instead is worse than refusing.
  //
  // Positional arguments are rejected too: install takes none, and a stray one
  // is far likelier to be a typo'd flag than intent.
  // A membership filter cannot tell a flag's VALUE from a stray positional, and
  // `--capture` takes one. The table with arities lives in install-args.ts.
  const parsed = parseInstallArgs(args);
  if (!parsed.ok) {
    console.error(t("install.error", { error: parsed.error }));
    process.exit(EXIT.USAGE);
  }

  // --local installs the Claude Code plugin from the local working-tree
  // packages/plugin/ instead of via the native marketplace/install commands.
  // Mutually exclusive with the default remote sequence (spec: Mutual
  // Exclusivity of Install Modes) — only the claude-code branch reads this.
  const localMode = parsed.args.local;
  let hadFailures = false;

  const mcpPath = resolveMcpPath();
  const pluginDir = resolvePluginDir();
  const agents = detectInstalledAgents();
  const installed = Object.entries(agents).filter(([, a]) => a.detected);

  if (installed.length === 0) {
    console.log(t("install.noAiCodingAgents"));
    console.log(t("install.supportedClaudeCodeCursor"));
    return;
  }

  console.log(t("install.detectedAgents", { agents: installed.map(([n]) => n).join(", ") }));

  for (const [agentName, agent] of installed) {
    console.log(t("install.installingFor", { agentName }));

    try {
      switch (agentName) {
        case "claude-code": {
          // 0. claude binary precondition gate — applies to BOTH the
          // default and --local paths (--local still needs `claude mcp add`
          // below). Never throws; skips this agent like any other
          // try/catch-guarded branch.
          const preflight = claudeCodePreflight(agent);
          if (!preflight.ok) {
            console.warn(`  ${preflight.message}`);
            break;
          }

          // 1. Register MCP via CLI
          const claudeMcp = registerClaudeMcpServer({ url, key, mcpPath });
          if (!claudeMcp.ok) {
            console.error(t("install.claudeMcpAddFailed", { reason: claudeMcp.reason }));
            hadFailures = true;
            break;
          }
          console.log(t("install.mcpRegisteredViaClaude"));

          // Requirement 6 (autonomous-memory) — best-effort MCP handshake
          // check. Confirms the just-registered server actually responds
          // and its initialize response carries a non-empty `instructions`
          // field, catching a misconfigured MNEMO_URL/MNEMO_KEY at install
          // time. Warning-only: a slow/unavailable npx fetch shouldn't fail
          // an otherwise-successful install.
          const handshake = await verifyMcpHandshake(mcpPath, url, key);
          if (handshake.ok) {
            console.log(t("install.mcpHandshakeVerifiedInitialize"));
          } else {
            console.warn(
              t("install.handshakeFailed", {
                message: handshake.message ?? t("common.unknownError"),
              })
            );
            console.warn(t("install.theServerWasRegistered"));
          }

          // 2. Install/refresh the plugin — --local uses the working-tree
          // copy path; the default path shells out to the native
          // marketplace/install commands. Mutually exclusive: exactly one
          // of these two branches runs per invocation.
          if (localMode) {
            if (!pluginDir) {
              console.warn(t("install.localDirMissing"));
              break;
            }

            const local = installClaudeCodePluginLocal({ pluginDir, configDir: agent.configDir });
            const verification = verifyClaudeCodeHooks(local.pluginTarget);
            if (verification.ok) {
              console.log(t("install.pluginHooksInstalledLocal"));
            } else {
              console.error(t("install.pluginHooksWereInstalled"));
              for (const failure of verification.failures) {
                console.error(`      ${failure}`);
              }
              hadFailures = true;
            }
          } else {
            const native = installClaudeCodePluginNative({ configDir: agent.configDir });
            if (!native.ok) {
              console.error(t("install.pluginInstallFailed"));
              console.error(native.failure);
              hadFailures = true;
              break;
            }
            console.log(t("install.pluginRegisteredViaClaude"));

            // Requirement 6 (autonomous-memory) — do not report success until
            // the installed hooks parse, are executable, and find jq and curl
            // ("hooks reported installed, were silently non-executable" is
            // the bug class). See verifyClaudeCodeHooks's doc comment.
            writeRuntimeLocator(native.installPath as string);
            const verification = verifyClaudeCodeHooks(native.installPath as string);
            if (verification.ok) {
              console.log(t("install.pluginHooksInstalledEnabled"));
            } else {
              console.error(t("install.pluginHooksWereInstalled"));
              for (const failure of verification.failures) {
                console.error(`      ${failure}`);
              }
              console.error(t("install.hooksWereCopiedAnd"));
              hadFailures = true;
            }
          }
          break;
        }

        case "cursor": {
          // Write MCP config to Cursor's MCP settings
          // Holds the key: atomic, 0600, and a malformed file is refused
          // (the per-agent catch reports it) instead of replaced.
          const cursorMcpPath = join(agent.configDir, "mcp.json");
          const mcpArgs2 = mcpPath.startsWith("npx") ? mcpPath.split(" ") : ["node", mcpPath];
          writeSecretJsonConfig(cursorMcpPath, (cursorMcp) => {
            const servers = (cursorMcp.mcpServers ?? {}) as Record<string, unknown>;
            servers.mnemosyne = {
              command: mcpArgs2[0],
              args: mcpArgs2.slice(1),
              env: { MNEMO_URL: url, MNEMO_KEY: key },
            };
            cursorMcp.mcpServers = servers;
          });
          console.log(t("install.mcpConfiguredInCursor"));

          // P73 — hooks. Cursor stopped being the degraded host a while ago:
          // `sessionStart` accepts `additional_context` (a real push channel,
          // no rules file) and `sessionEnd` is a genuine close signal, which is
          // MORE than Claude Code gives us — `Stop` fires once per turn, which
          // is exactly what made P70's episode die after the first exchange.
          // Shipping only mcp.json here was giving the largest install base in
          // the list our worst integration.
          //
          // The manifest is a template: commands are rewritten to ABSOLUTE
          // paths rather than left as `${MNEMO_PLUGIN_ROOT}`, because Cursor
          // does not document variable expansion in hook commands and a hook
          // whose command does not resolve fails the same way claude-mem's
          // OpenCode plugin did — silently, forever, with nothing in a log.
          if (pluginDir && existsSync(join(pluginDir, "hooks", "cursor-hooks.json"))) {
            const cursorHooksPath = join(agent.configDir, "hooks.json");
            const template = readFileSync(join(pluginDir, "hooks", "cursor-hooks.json"), "utf8");
            const rendered = JSON.parse(template.replaceAll("${MNEMO_PLUGIN_ROOT}", pluginDir)) as {
              hooks: Record<string, unknown>;
            };

            // Merge, never clobber: `~/.cursor/hooks.json` is user-global and
            // may already carry another tool's hooks. Cursor runs every layer
            // rather than overriding, so dropping someone else's entries here
            // would silently disable their tooling.
            let existing: Record<string, unknown> = {};
            try {
              existing = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
            } catch {
              /* new file */
            }
            const mergedHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
            for (const [event, entries] of Object.entries(rendered.hooks)) {
              const ours = entries as Array<{ command: string }>;
              const theirs = (mergedHooks[event] ?? []) as Array<{ command: string }>;
              // Idempotent: re-running install must not stack duplicate
              // invocations of the same script on one event.
              const kept = theirs.filter((h) => !String(h.command).includes("cursor-session-"));
              mergedHooks[event] = [...kept, ...ours];
            }
            existing.hooks = mergedHooks;
            existing.version = existing.version ?? 1;

            mkdirSync(agent.configDir, { recursive: true });
            if (safeWriteFile(cursorHooksPath, JSON.stringify(existing, null, 2))) {
              console.log(t("install.hooksInstalledInCursor"));
            }
          }

          // Copy AGENTS.md if plugin dir available
          if (pluginDir && existsSync(join(pluginDir, "AGENTS.md"))) {
            const agentsMd = join(agent.configDir, "AGENTS.md");
            // An AGENTS.md that is not ours is the user's own instructions: keep it.
            if (existsSync(agentsMd) && !/mnemosyne/i.test(readFileSync(agentsMd, "utf8"))) {
              console.warn(t("install.existingFileKept", { path: agentsMd }));
            } else if (
              safeWriteFile(agentsMd, readFileSync(join(pluginDir, "AGENTS.md"), "utf8"))
            ) {
              console.log(t("install.agentsMdInstalled"));
            }
          }
          break;
        }

        case "opencode": {
          // Write MCP server to opencode config.
          //
          // OpenCode's schema is NOT the same as Claude Code's/Cursor's:
          //   - top-level key is "mcp", not "mcpServers"
          //   - each entry combines binary + args into ONE "command" array
          //     (not separate command/args fields)
          //   - env vars go under "environment", not "env"
          //   - each entry needs "enabled: true"
          // A stray "mcpServers" key makes OpenCode's config loader reject
          // the ENTIRE file ("Configuration is invalid at ...opencode.json")
          // — verified 2026-07-20 against opencode 1.18.0. Auto-migrate any
          // config written by the previous (buggy) version of this command.
          //
          // Holds the key: atomic, 0600, and a malformed file is refused
          // (the per-agent catch reports it) instead of replaced.
          const opencodeConfig = join(agent.configDir, "opencode.json");
          const mcpArgs3 = mcpPath.startsWith("npx") ? mcpPath.split(" ") : ["node", mcpPath];
          writeSecretJsonConfig(opencodeConfig, (ocConfig) => {
            if ("mcpServers" in ocConfig) {
              const legacy = ocConfig.mcpServers as Record<
                string,
                { command: string; args?: string[]; env?: Record<string, string> }
              >;
              delete ocConfig.mcpServers;
              const migrated = (ocConfig.mcp ?? {}) as Record<string, unknown>;
              for (const [name, cfg] of Object.entries(legacy)) {
                migrated[name] = {
                  type: "local",
                  command: [cfg.command, ...(cfg.args ?? [])],
                  environment: cfg.env ?? {},
                  enabled: true,
                };
              }
              ocConfig.mcp = migrated;
            }

            const mcp = (ocConfig.mcp ?? {}) as Record<string, unknown>;
            mcp.mnemosyne = {
              type: "local",
              command: mcpArgs3,
              environment: { MNEMO_URL: url, MNEMO_KEY: key },
              enabled: true,
            };
            ocConfig.mcp = mcp;
          });
          console.log(t("install.mcpConfiguredInConfig"));
          break;
        }

        case "gemini-cli": {
          // Copy GEMINI.md and gemini-extension.json.
          // ~/.gemini/GEMINI.md is commonly a symlink into a dotfiles repo
          // (confirmed in the wild) — see safeWriteFile doc comment for why
          // this must never be a blind writeFileSync.
          if (pluginDir) {
            // P73: both files went to ~/.gemini/. Gemini CLI discovers
            // extensions in ~/.gemini/extensions/<name>/, so the manifest sat
            // somewhere nothing reads and the extension was never loaded — the
            // same silent no-op as the Codex case. The manifest also declared
            // no `mcpServers` at all, so even in the right place it registered
            // nothing; that is fixed in gemini-extension.json.
            const geminiExtDir = join(agent.configDir, "extensions", "mnemosyne");
            mkdirSync(geminiExtDir, { recursive: true });
            let anyWritten = false;
            for (const f of ["GEMINI.md", "gemini-extension.json"]) {
              const src = join(pluginDir, f);
              if (existsSync(src)) {
                const content = readFileSync(src, "utf8")
                  .replace(/\$\{MNEMO_URL\}/g, url)
                  .replace(/\$\{MNEMO_KEY\}/g, key);
                const wrote = safeWriteFile(
                  join(geminiExtDir, f),
                  content,
                  // The manifest carries the key once substituted.
                  content.includes(key) ? 0o600 : undefined
                );
                anyWritten = anyWritten || wrote;
              }
            }
            if (anyWritten) console.log(t("install.geminiMdGeminiExtension"));
          } else {
            console.warn(t("install.pluginDirNotFound"));
          }
          break;
        }

        case "codex": {
          // P73: this wrote ~/.codex/config.json with an `mcpServers` object.
          // Codex reads ~/.codex/config.TOML with `[mcp_servers.<id>]` tables —
          // wrong file AND wrong format, so the registration was a silent no-op:
          // the command printed a green tick and Codex never saw the server.
          //
          // APP-011: the block was then appended after deleting the previous one
          // with a regex that stopped at the `[` of `args = [...]`, so the second
          // install left a dangling array line and an unparseable file — and
          // printed the tick below. `registerCodexMcpServer` parses, edits only
          // the mnemosyne tables, verifies the result, and replaces atomically.
          const codexConfig = join(agent.configDir, "config.toml");
          mkdirSync(agent.configDir, { recursive: true });
          const registered = registerCodexMcpServer({
            configPath: codexConfig,
            server: { ...mcpLaunch(mcpPath), url, key },
          });
          if (registered.status === "failed") {
            // The file is exactly as we found it. Say so, and keep going: the
            // other hosts do not depend on this one.
            console.error(
              t("install.codexConfigNotUpdated", { path: codexConfig, reason: registered.reason })
            );
            hadFailures = true;
            break;
          }
          if (registered.repaired) console.log(t("install.codexConfigRepaired"));
          console.log(t("install.mcpConfiguredInCodex"));
          break;
        }

        case "windsurf": {
          // P73: windsurf was DETECTED (there is a detection entry for it) and
          // had no case here, so it fell through to `default:` and printed
          // "Manual config required" — while the run still ended with
          // "installed for all detected agents", because `hadFailures` was only
          // ever set by the claude-code branch. Failing and reporting success is
          // the actual bug; the missing case is just the cause.
          //
          // Holds the key: atomic, 0600, and a malformed file is refused
          // (the per-agent catch reports it) instead of replaced.
          const wsConfig = join(agent.configDir, "mcp_config.json");
          const mcpArgsWs = mcpPath.startsWith("npx") ? mcpPath.split(" ") : ["node", mcpPath];
          writeSecretJsonConfig(wsConfig, (wConfig) => {
            const mcpServersWs = (wConfig.mcpServers ?? {}) as Record<string, unknown>;
            mcpServersWs.mnemosyne = {
              command: mcpArgsWs[0],
              args: mcpArgsWs.slice(1),
              env: { MNEMO_URL: url, MNEMO_KEY: key },
            };
            wConfig.mcpServers = mcpServersWs;
          });
          console.log(t("install.mcpConfiguredInCodeium"));
          break;
        }

        default:
          // P73: reaching `default:` means we detected a host and did NOT
          // configure it. That is a failure, and it used to end the run with
          // "installed for all detected agents" anyway — `hadFailures` was set
          // only by the claude-code branch. A silent partial install is worse
          // than a loud one: the user has no reason to check.
          hadFailures = true;
          console.log(t("install.manualConfigRequiredSee"));
      }
    } catch (err) {
      // Same reason: an exception here left the summary claiming success.
      hadFailures = true;
      console.warn(t("install.agentFailed", { agentName, message: (err as Error).message }));
    }
  }

  // Resolved once, before both consumers: the workspaces.json mapping below and
  // the capture binding after it. Asking the server twice for the same answer
  // is two chances to get two different ones.
  const installWorkspaceId = await resolveWorkspaceId(url, key);

  // Also update workspaces.json
  //
  // This used to write the literal string "unknown" as the workspaceId and then
  // print "✅ Workspace mapping saved" — a false green. The server has always
  // known the answer: GET /me returns the workspaceId for the very key this
  // installer already holds. It was never asked.
  //
  // What that broke: get_workspace_id() (packages/plugin/scripts/_helpers.sh)
  // reads this file to decide which workspace a project belongs to. With
  // "unknown" the hooks carried an id that does not exist, and the installer
  // had already reported success — so nothing pointed at the cause.
  try {
    const projectName = await detectProjectName(process.cwd());
    const wsFile = join(homedir(), ".mnemo", "workspaces.json");
    let wsData: Record<string, { workspaceId: string; url: string }> = {};
    try {
      wsData = JSON.parse(readFileSync(wsFile, "utf8"));
    } catch {
      /* new */
    }

    const resolvedWorkspaceId = installWorkspaceId;

    if (resolvedWorkspaceId === null) {
      // No invented value, and no success message. A missing mapping is
      // recoverable — the hooks fall back to `default` and say so. A lying one
      // is not, because nothing looks wrong.
      console.warn(t("install.workspaceUnresolved", { url }));
    } else {
      // Written unconditionally, not behind `if (!wsData[projectName])`. That
      // guard meant an entry already poisoned with "unknown" stayed poisoned
      // forever: reinstalling — the obvious thing to try — could never fix it.
      wsData[projectName] = { workspaceId: resolvedWorkspaceId, url };
      const existingDefault = wsData["default"];
      if (!existingDefault || existingDefault.workspaceId === "unknown") {
        wsData["default"] = { workspaceId: resolvedWorkspaceId, url };
      }
      mkdirSync(dirname(wsFile), { recursive: true });
      writeFileSync(wsFile, JSON.stringify(wsData, null, 2) + "\n");
      console.log(t("install.workspaceMappingSavedFor", { projectName, resolvedWorkspaceId }));
    }
  } catch {
    /* non-fatal */
  }

  // Capture, if and only if it was asked for. A separate phase rather than a
  // case in the detected-agents loop above: the requested set is not the
  // detected set, so a host named in --capture but not detected still has to be
  // REPORTED, and that loop would never reach it. Keeping it out also keeps the
  // MCP registration path unperturbed by construction rather than by review.
  let captureHadFailures = false;
  if (parsed.args.capture.length > 0) {
    const harness = await import("@mnemo-ai/harness");
    const outcomes = await installCaptureHosts(
      {
        hosts: parsed.args.capture,
        acceptDegraded: parsed.args.acceptDegraded,
        serverUrl: url,
        apiKey: key,
        workspaceId: installWorkspaceId,
      },
      captureEffects({ home: homedir(), pluginDir, harness })
    );
    captureHadFailures = captureFailed(outcomes);
    for (const line of renderCaptureSummary(outcomes)) console.log(line);
    if (captureHadFailures) {
      // Assigned, not `process.exit(1)`: stdout still flushes, this function
      // still returns, and a test can assert on it. Kept separate from
      // `hadFailures` so a run that never asked for capture keeps its exit
      // behaviour exactly as it was.
      process.exitCode = 1;
    }
  }

  if (hadFailures) {
    console.log(t("install.mnemosyneInstallCompletedWith"));
  } else {
    console.log(t("install.mnemosyneInstalledForAll"));
  }
  console.log(t("install.restartYourAiAgents"));
  if (captureHadFailures) {
    // The line above is about MCP, which may well have succeeded — but it is a
    // green tick, and leaving it as the last thing printed after a capture
    // failure is the exact shape of reporting this change exists to remove.
    console.log(t("install.captureWasNotFully"));
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Bind the harness command surface to the real local queue.
 *
 * Imported lazily so a CLI invocation that never touches the harness does not pay
 * for loading it — and, more importantly, so an install whose optional native
 * locking dependency is missing still runs every other command.
 */
async function readHookStdin(): Promise<string> {
  if (process.stdin.isTTY || process.stdin.destroyed || process.stdin.readableEnded) return "";
  return new Promise<string>((resolveStdin) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
      resolveStdin(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    };
    const onEnd = () => finish();
    const timer = setTimeout(finish, 200);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
  });
}

export async function harnessDeps(cfg: Config = {}): Promise<HarnessCommandDeps> {
  const harness = await import("@mnemo-ai/harness");
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async confirm(prompt: string) {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) =>
          rl.question(`${prompt} ${yesNoSuffix(false)} `, resolve)
        );
        return isYes(answer, false);
      } finally {
        rl.close();
      }
    },
    // Per host, the mode capture is really at and why (APP-034d): the same
    // inputs captureHook re-checks on every event, plus the qualification record.
    diagnose: () => {
      const artifactRoot = resolvePluginDir() ?? undefined;
      const home = process.env.HOME ?? homedir();
      return harness.diagnoseHarness({
        captureHosts: {
          qualification(host) {
            const version = harness.readHostVersion(host);
            if ("error" in version) return { mode: "mcp-only", reason: version.error };
            return harness.resolveHostCaptureMode({
              host,
              hostVersion: version.version,
              artifactRoot,
            });
          },
          liveGate: (host) => liveGateFor(host, { home, platform: process.platform }),
          artifactHash(host) {
            if (artifactRoot === undefined) return null;
            const hash = harness.computeCaptureArtifactHash({ host, artifactRoot });
            return "hash" in hash ? hash.hash : null;
          },
          env: process.env,
        },
      }) as never;
    },
    async listQueue() {
      return harness.listHarnessQueue();
    },
    async releaseRetry() {
      return harness.releaseHarnessRetry({
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
    },
    async discardQueue({ reason }) {
      return harness.discardHarnessQueue({ reason });
    },
    async probe() {
      return harness.probeHarnessServer({
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
    },
    async captureHook(argv: string[]) {
      const host = argv[0];
      const event = argv[1];
      const knownHosts = new Set(["opencode", "claude-code", "codex"]);
      if (!host || !knownHosts.has(host) || !event) {
        return { durable: false, reason: "invalid_hook_arguments" };
      }
      const rawPayload = await readHookStdin();
      const captureHost = host as "opencode" | "claude-code" | "codex";
      // Consent is re-checked against the artifacts running now and the live
      // host gate, so an upgrade cannot keep capturing at a level it never proved.
      const result = await harness.captureHostHook({
        host: captureHost,
        event,
        rawPayload,
        artifactRoot: resolvePluginDir() ?? undefined,
        liveGateMode: liveGateFor(captureHost, {
          home: process.env.HOME ?? homedir(),
          platform: process.platform,
        }).mode,
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
      return { durable: result.durable, ...(result.reason ? { reason: result.reason } : {}) };
    },
  };
}

/**
 * Rollback wiring. Each step reports honestly rather than optimistically: the
 * whole point of the sequence is that an operator can trust "done" to mean done.
 */
export async function harnessLifecycleDeps(cfg: Config = {}): Promise<LifecycleDeps> {
  const harness = await import("@mnemo-ai/harness");
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async confirm(prompt: string) {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) =>
          rl.question(`${prompt} ${yesNoSuffix(false)} `, resolve)
        );
        return isYes(answer, false);
      } finally {
        rl.close();
      }
    },
    async disableHost({ host }) {
      const known = ["opencode", "claude-code", "codex"] as const;
      if (!(known as readonly string[]).includes(host)) {
        return { disabled: false, ingestionStillAvailable: true };
      }
      try {
        await harness.clearCaptureConsent(host as (typeof known)[number]);
      } catch {
        return { disabled: false, ingestionStillAvailable: true };
      }
      return { disabled: true, ingestionStillAvailable: true };
    },
    async drainQueue() {
      return harness.drainHarnessQueue({
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
    },
    async quiesceWorkspace() {
      return harness.quiesceHarnessWorkspace({
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
    },
    async removeArtifacts({ host }) {
      return harness.removeHostHarnessArtifacts({ host });
    },
    async readState({ host }) {
      return harness.readHarnessLifecycleState({
        host,
        serverUrl: cfg.url,
        apiKey: cfg.apiKey,
        workspaceId: cfg.workspaceId,
      });
    },
    async discardQueue({ reason, host }) {
      return harness.discardHarnessQueue({ reason, host });
    },
  };
}

export const COMMANDS: Record<string, CommandFn | undefined> = {
  // Core CRUD (full implementations — no longer stubs)
  recall: cmdRecall,
  remember: cmdRemember,
  forget: cmdForget,

  // Placeholders for commands handled inside index.ts main()
  status: async (_args, _config) => {
    /* alias for health, handled in index.ts */
  },
  config: async (_args, _config) => {
    /* subcommands handled in index.ts */
  },
  help: async (_args, _config) => {
    /* handled in index.ts */
  },

  // Version
  version: (_args, _config) => {
    console.log(`mnemo ${CLI_VERSION}`);
  },

  // AB6.3 subcommands
  sessions: cmdSessionsExtended,
  tasks: cmdTasksExtended,
  events: cmdEventsExtended,
  health: cmdHealth,
  export: cmdExport,
  import: cmdImport,
  login: cmdLogin,
  init: cmdInit,
  install: cmdInstall,
  reset: cmdReset,
  link: cmdLink,

  // P5-A: list / search / show
  list: cmdList,
  search: cmdSearch,
  show: cmdShow,

  // CLI-PARITY-1: primitive + relation + operational-tool commands
  decide: cmdDecide,
  entity: cmdEntity,
  relate: cmdRelate,
  strategy: cmdStrategy,
  workflow: cmdWorkflow,
  skill: cmdSkill,
  reasoning: cmdReasoning,
  hyperedge: cmdHyperedge,
  episode: cmdEpisode,
  pin: cmdPin,
  unpin: cmdUnpin,
  timeline: cmdTimeline,
  judge: cmdJudge,
  purge: cmdPurge,
  erase: cmdErase,
  consolidate: cmdConsolidate,
  remind: cmdRemind,

  // Shell completion
  completion: async (args: string[], _config: Config): Promise<void> => {
    const shell = args[0];
    if (!shell) {
      console.error(t("completion.usage", { shells: COMPLETION_SHELLS.join(", ") }));
      process.exit(EXIT.USAGE);
    }
    try {
      process.stdout.write(generateCompletion(shell));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },

  async info(_args: string[], cfg: Config) {
    const { url, apiKey } = cfg as { url: string; apiKey: string };

    const BOLD = "\x1b[1m";
    const DIM = "\x1b[2m";
    const GREEN = "\x1b[32m";
    const CYAN = "\x1b[36m";
    const RESET = "\x1b[0m";
    const sep = `${DIM}${"─".repeat(48)}${RESET}`;

    const client = createClient(url, apiKey);

    // Fetch identity + health + stats + workspaces in parallel. Each is
    // best-effort — this is a decorative status dashboard, not a command
    // whose sole job is one of these fields, so a partial failure degrades
    // gracefully instead of hard-exiting the whole command.
    const [me, health, stats, workspaces] = await Promise.all([
      client.getMe().catch(() => null),
      client.healthReady().catch(() => ({ status: "unavailable" })),
      client.getStats().catch(() => null),
      client.listWorkspacesForCurrentTenant().catch(() => [] as Array<Record<string, unknown>>),
    ]);

    statusLine({
      mode: cfg.uiMode,
      kind: "read",
      action: t("info.fetchingSessionInfo"),
      pending: true,
    });
    console.log(t("info.mnemosyneSessionInfo", { BOLD, RESET }));
    console.log(sep);

    // Connection
    const serverStatus = health.status;
    const statusColor = serverStatus === "ready" ? GREEN : "\x1b[31m";
    console.log(
      t("info.server", { BOLD, RESET, url, statusColor, status: serverStatus.toUpperCase() })
    );

    if (me) {
      console.log(sep);
      // Workspace
      console.log(
        t("info.workspace", {
          BOLD,
          RESET,
          CYAN,
          workspaceId: String(me["workspaceId"] ?? t("common.unknownWord")),
        })
      );
      // Key — always print separately from User/Tenant below. keyId is the
      // credential's own row id (never conflate it with userId — see
      // CLAUDE.md "Provenance identity"); actorType says what kind of
      // principal this key authenticates as (agent/user/system/federation).
      if (me["keyId"]) console.log(t("info.key", { BOLD, RESET, keyId: String(me["keyId"]) }));
      if (me["actorType"])
        console.log(t("info.actorType", { BOLD, RESET, actorType: String(me["actorType"]) }));
      // User (if key has user binding)
      if (me["userId"]) console.log(t("info.user", { BOLD, RESET, userId: String(me["userId"]) }));
      // Tenant (if key has tenant binding)
      if (me["tenantId"])
        console.log(t("info.tenant", { BOLD, RESET, tenantId: String(me["tenantId"]) }));
      console.log(t("info.plan", { BOLD, RESET, plan: String(me["plan"] ?? "free") }));
      console.log(
        t("info.scopes", {
          BOLD,
          RESET,
          scopes: (Array.isArray(me["scopes"]) ? (me["scopes"] as string[]) : []).join(", "),
        })
      );
      if (me["expiresAt"])
        console.log(t("info.expires", { BOLD, RESET, expiresAt: String(me["expiresAt"]) }));
    }

    if (stats) {
      console.log(sep);
      console.log(
        t("info.factsLivePinnedClosed", {
          BOLD,
          RESET,
          live: stats.facts.live,
          pinned: stats.facts.pinned,
          closed: stats.facts.closed,
        })
      );
      if (stats.recall.lastRecallAt)
        console.log(t("info.lastRecall", { BOLD, RESET, lastRecallAt: stats.recall.lastRecallAt }));
      if (stats.recall.hitRate30d != null)
        console.log(
          t("info.hitRate", {
            BOLD,
            RESET,
            rate: (stats.recall.hitRate30d * 100).toFixed(1),
          })
        );
    }

    if (workspaces.length > 0) {
      console.log(sep);
      console.log(t("info.availableWorkspaces", { BOLD, RESET, length: workspaces.length }));
      for (const ws of workspaces) {
        const active = ws["id"] === me?.["workspaceId"] ? t("info.active", { GREEN, RESET }) : "";
        console.log(
          `  ${String(ws["name"] ?? ws["id"])}  ${DIM}${String(ws["id"])}${RESET}${active}`
        );
      }
    }

    console.log(sep + "\n");
  },

  // Backwards-compatible alias
  async whoami(_args: string[], cfg: Config) {
    return COMMANDS.info!(_args, cfg);
  },

  async harness(args: string[], cfg: Config) {
    // The rollback commands are a separate module with their own ordering rules;
    // dispatched here so `mnemo harness` stays one surface for the operator.
    const LIFECYCLE = new Set(["disable", "drain", "quiesce", "uninstall"]);
    const code = LIFECYCLE.has(args[0] ?? "")
      ? await runHarnessLifecycle(args, await harnessLifecycleDeps(cfg))
      : await runHarnessCommand(args, await harnessDeps(cfg));
    if (code !== 0) process.exitCode = code;
  },

  async doctor(args: string[], cfg: Config) {
    const { url, apiKey } = cfg as { url: string; apiKey: string };
    const data = await callApi(createClient(url, apiKey).doctor());

    if (args.includes("--json")) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    statusLine({
      mode: cfg.uiMode,
      kind: "read",
      action: t("doctor.runningDiagnostics"),
      pending: true,
    });

    const statusColors: Record<string, string> = {
      ok: "\x1b[32m",
      warn: "\x1b[33m",
      error: "\x1b[31m",
      unknown: "\x1b[90m",
    };
    const RESET = "\x1b[0m";
    const color = (s: string) => `${statusColors[s.toLowerCase()] ?? ""}${s.toUpperCase()}${RESET}`;

    console.log(t("doctor.overall", { status: color(data.status) }));
    for (const check of data.checks ?? []) {
      const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
      console.log(`  ${icon} ${check.name.padEnd(30)} ${color(check.status)}`);
      if (check.message && check.status !== "ok") console.log(`      ${check.message}`);
      if (check.detail && check.status !== "ok")
        console.log(`      ${JSON.stringify(check.detail)}`);
    }
    console.log();
  },

  async workspace(args: string[], cfg: Config) {
    const [subCmd, ...rest] = args;

    if (subCmd === "list" || !subCmd) {
      return cmdWorkspaceList(rest, cfg);
    }

    if (subCmd === "show") {
      return cmdWorkspaceShow(rest, cfg);
    }

    if (subCmd === "members") {
      return cmdWorkspaceMembers(rest, cfg);
    }

    if (subCmd === "create") {
      return cmdWorkspaceCreate(rest, cfg);
    }

    if (subCmd === "invite") {
      return cmdWorkspaceInvite(rest, cfg);
    }

    if (subCmd === "set-role") {
      return cmdWorkspaceSetRole(rest, cfg);
    }

    if (subCmd === "remove") {
      return cmdWorkspaceRemove(rest, cfg);
    }

    console.error(t("workspace.unknownWorkspaceSubcommandUse", { subCmd }));
    process.exit(EXIT.USAGE);
  },

  // ── L2: tenant / user / token commands (multi-tenancy closure plan) ────────

  async tenant(args: string[], cfg: Config) {
    const [subCmd, ...rest] = args;
    const { url, apiKey } = cfg as { url: string; apiKey: string };
    const client = createClient(url, apiKey);

    if (subCmd === "create") {
      const name = getFlag(rest, "--name");
      if (!name) {
        console.error(t("tenant.usageMnemoTenantCreate"));
        process.exit(EXIT.USAGE);
      }
      const kind = getFlag(rest, "--kind") as "personal" | "organization" | undefined;
      const plan = getFlag(rest, "--plan");
      const issueOwnerToken = rest.includes("--owner-token");
      const workspaceName = getFlag(rest, "--workspace-name");
      const tenant = await callApi(
        client.createTenant({
          name,
          ...(kind ? { kind } : {}),
          ...(plan ? { plan } : {}),
          ...(issueOwnerToken ? { issueOwnerToken } : {}),
          ...(issueOwnerToken && workspaceName ? { workspaceName } : {}),
        })
      );
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("tenant.tenantCreated"),
        detail: `${tenant.id} (${tenant.name}, ${tenant.kind})`,
      });
      // The key that made the tenant keeps acting in its own tenant (the server
      // refuses it here), so without an owner token nothing can manage this one.
      if (tenant.ownerToken) {
        console.log(t("tenant.ownerToken", { key: tenant.ownerToken.key }));
        console.error(
          t("tenant.ownerTokenWhere", {
            tenantId: tenant.ownerToken.tenantId,
            workspaceId: tenant.ownerToken.workspaceId,
          })
        );
      } else {
        console.error(t("tenant.noOwnerToken"));
      }
      return;
    }

    if (subCmd === "show") {
      const tenantId = rest[0];
      if (!tenantId) {
        console.error(t("tenant.usageMnemoTenantShow"));
        process.exit(EXIT.USAGE);
      }
      const tenant = await callApi(client.getTenant(tenantId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("tenant.fetchingTenant"),
        detail: tenantId,
        pending: true,
      });
      console.log(t("tenant.idLine", { id: tenant.id }));
      console.log(t("tenant.nameLine", { name: tenant.name }));
      console.log(t("tenant.kindLine", { kind: tenant.kind }));
      console.log(t("tenant.planLine", { plan: tenant.plan }));
      console.log(t("tenant.created", { createdAt: tenant.createdAt ?? t("common.unknown") }));
      return;
    }

    if (subCmd === "members") {
      const tenantId = rest[0];
      if (!tenantId) {
        console.error(t("tenant.usageMnemoTenantMembers"));
        process.exit(EXIT.USAGE);
      }
      const members = await callApi(client.listTenantMembers(tenantId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("tenant.listingTenantMembers"),
        detail: tenantId,
        pending: true,
      });
      if (!members.length) {
        console.log(t("tenant.noMembersFound"));
        return;
      }
      const ID_W = 38;
      const ROLE_W = 8;
      console.log(
        `${t("workspaceTable.userId").padEnd(ID_W)} │ ${t("workspaceTable.role").padEnd(ROLE_W)} │ ${t("workspaceTable.joinedAt")}`
      );
      console.log(`${"─".repeat(ID_W + 2)}┼${"─".repeat(ROLE_W + 2)}┼${"─".repeat(26)}`);
      for (const m of members) {
        console.log(`${m.userId.padEnd(ID_W)} │ ${m.role.padEnd(ROLE_W)} │ ${m.joinedAt ?? "—"}`);
      }
      return;
    }

    if (subCmd === "invite") {
      const tenantId = rest[0];
      const email = rest[1];
      if (!tenantId || !email) {
        console.error(t("tenant.usageMnemoTenantInvite"));
        process.exit(EXIT.USAGE);
      }
      const role = getFlag(rest, "--role") as "owner" | "admin" | "member" | undefined;
      const createIfMissing = rest.includes("--create-if-missing");
      await callApi(
        client.inviteTenantMember(tenantId, {
          email,
          ...(role ? { role } : {}),
          ...(createIfMissing ? { createIfMissing } : {}),
        })
      );
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("tenant.invited", {
          email,
          tenantId,
          asRole: role ? t("tenant.asRole", { role }) : "",
        }),
      });
      return;
    }

    if (subCmd === "remove") {
      const tenantId = rest[0];
      const userId = rest[1];
      if (!tenantId || !userId) {
        console.error(t("tenant.usageMnemoTenantRemove"));
        process.exit(EXIT.USAGE);
      }
      await callApi(client.removeTenantMember(tenantId, userId));
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("tenant.removedFromTenant", { userId, tenantId }),
      });
      return;
    }

    if (subCmd === "workspaces") {
      const tenantId = rest[0];
      if (!tenantId) {
        console.error(t("tenant.usageMnemoTenantWorkspaces"));
        process.exit(EXIT.USAGE);
      }
      const workspaces = await callApi(client.listWorkspacesForTenant(tenantId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("tenant.listingTenantWorkspaces"),
        detail: tenantId,
        pending: true,
      });
      if (!workspaces.length) {
        console.log(t("tenant.noWorkspacesFound"));
        return;
      }
      for (const ws of workspaces) {
        console.log(
          t("tenant.members", {
            id: ws.id,
            name: ws.name,
            visibility: ws.visibility,
            memberCount: ws.memberCount,
          })
        );
      }
      return;
    }

    console.error(t("tenant.unknownTenantSubcommandUse", { subCmd: String(subCmd) }));
    process.exit(EXIT.USAGE);
  },

  async user(args: string[], cfg: Config) {
    const [subCmd, ...rest] = args;
    const { url, apiKey } = cfg as { url: string; apiKey: string };

    if (subCmd === "create") {
      const email = getFlag(rest, "--email");
      if (!email) {
        console.error(t("user.usageMnemoUserCreate"));
        process.exit(EXIT.USAGE);
      }
      const displayName = getFlag(rest, "--display-name");
      const result = await callApi(
        createClient(url, apiKey).createUser({ email, ...(displayName ? { displayName } : {}) })
      );
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("user.userCreated"),
        detail: `${result.user.id} (${result.user.email})`,
      });
      console.log(t("user.personalTenantLine", { id: result.personalTenant.id }));
      console.log(t("user.personalWorkspaceLine", { id: result.personalWorkspace.id }));
      return;
    }

    console.error(t("user.unknownUserSubcommandUse", { subCmd: String(subCmd) }));
    process.exit(EXIT.USAGE);
  },

  async token(args: string[], cfg: Config) {
    const [subCmd, ...rest] = args;
    const { url, apiKey } = cfg as { url: string; apiKey: string };
    const client = createClient(url, apiKey);

    if (subCmd === "issue") {
      const tenantId = rest[0];
      const userId = rest[1];
      if (!tenantId || !userId) {
        console.error(t("token.usageMnemoTokenIssue"));
        process.exit(EXIT.USAGE);
      }
      const label = getFlag(rest, "--label");
      const homeWorkspaceId = getFlag(rest, "--workspace");
      if (!label || !homeWorkspaceId) {
        console.error(t("token.errorLabelAndWorkspace"));
        process.exit(EXIT.USAGE);
      }
      const scopesArg = getFlag(rest, "--scopes");
      const expiresIn = getFlag(rest, "--expires");
      const isTest = rest.includes("--test");
      const result = await callApi(
        client.createUserToken(tenantId, userId, {
          label,
          homeWorkspaceId,
          ...(scopesArg ? { scopes: scopesArg.split(",").map((s) => s.trim()) } : {}),
          ...(expiresIn ? { expiresIn } : {}),
          ...(isTest ? { test: true } : {}),
        })
      );
      console.log(t("token.mTokenMintedCopy"));
      console.log(t("token.tokenLine", { key: result.key }));
      console.log(t("token.idLine", { id: result.id }));
      console.log(t("token.userLine", { userId: result.userId }));
      console.log(t("token.workspaceLine", { workspaceId: result.workspaceId }));
      console.log(t("token.scopes", { scopes: result.scopes.join(", ") }));
      console.log(t("token.expires", { expires: result.expiresAt ?? t("common.never") }));
      return;
    }

    if (subCmd === "list") {
      const tenantId = rest[0];
      const userId = rest[1];
      if (!tenantId || !userId) {
        console.error(t("token.usageMnemoTokenList"));
        process.exit(EXIT.USAGE);
      }
      const tokens = await callApi(client.listUserTokens(tenantId, userId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("token.listingTokens"),
        detail: `${tenantId}/${userId}`,
        pending: true,
      });
      if (!tokens.length) {
        console.log(t("token.noTokensFound"));
        return;
      }
      for (const tok of tokens) {
        const status = tok.revokedAt
          ? `\x1b[31m${t("common.revokedUpper")}\x1b[0m`
          : `\x1b[32m${t("common.activeUpper")}\x1b[0m`;
        console.log(
          t("token.row", {
            id: tok.id,
            status,
            label: tok.label,
            scopes: tok.scopes.join(","),
            workspaceId: tok.workspaceId,
            expires: tok.expiresAt ?? t("common.never"),
          })
        );
      }
      return;
    }

    if (subCmd === "revoke") {
      const tenantId = rest[0];
      const userId = rest[1];
      const keyId = rest[2];
      if (!tenantId || !userId || !keyId) {
        console.error(t("token.usageMnemoTokenRevoke"));
        process.exit(EXIT.USAGE);
      }
      const result = await callApi(client.revokeUserToken(tenantId, userId, keyId));
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("token.tokenRevokedAt", { keyId, revokedAt: result.revokedAt }),
      });
      return;
    }

    console.error(t("token.unknownTokenSubcommandUse", { subCmd: String(subCmd) }));
    process.exit(EXIT.USAGE);
  },

  async keys(args: string[], cfg: Config) {
    const [subCmd, ...rest] = args;
    const { url, apiKey } = cfg as { url: string; apiKey: string };

    if (subCmd === "list" || !subCmd) {
      const onlyExpired = rest.includes("--expired");
      const data = await callApi(createClient(url, apiKey).listKeys({ expired: onlyExpired }));
      statusLine({ mode: cfg.uiMode, kind: "read", action: t("keys.listingKeys"), pending: true });
      if (data.keys.length === 0) {
        console.log(t("keys.noKeysFound"));
        return;
      }
      for (const k of data.keys) {
        const status = k.revokedAt
          ? `\x1b[31m${t("common.revokedUpper")}\x1b[0m`
          : `\x1b[32m${t("common.activeUpper")}\x1b[0m`;
        const expiry = k.expiresAt ? k.expiresAt.slice(0, 10) : "—";
        const ceiling = k.maxSensitivity ? t("keys.ceiling", { value: k.maxSensitivity }) : "";
        console.log(
          t("keys.row", {
            id: k.id,
            status,
            label: k.label || k.prefix,
            scopes: k.scopes.join(","),
            created: k.createdAt.slice(0, 10),
            expiry,
            ceiling,
          })
        );
      }
      return;
    }

    if (subCmd === "create") {
      const label = rest.find((_, i) => rest[i - 1] === "--label") ?? "unnamed";
      const scopesArg = rest.find((_, i) => rest[i - 1] === "--scopes") ?? "memory:read";
      const scopes = scopesArg.split(",").map((s) => s.trim());
      const expiresIn = rest.find((_, i) => rest[i - 1] === "--expires");
      const ipArg = rest.find((_, i) => rest[i - 1] === "--ip-allowlist");
      const isTest = rest.includes("--test");
      const isUserToken = rest.includes("--user-token");
      const plan = (rest.find((_, i) => rest[i - 1] === "--plan") ?? "free") as
        "free" | "pro" | "enterprise";
      const maxSensitivityArg = rest.find((_, i) => rest[i - 1] === "--max-sensitivity");

      // Client-side validation: reject unrecognised sensitivity values before any server request.
      const VALID_SENSITIVITY = ["public", "internal", "confidential", "restricted"] as const;
      if (
        maxSensitivityArg &&
        !(VALID_SENSITIVITY as readonly string[]).includes(maxSensitivityArg)
      ) {
        console.error(
          t("keys.invalidSensitivity", {
            valid: VALID_SENSITIVITY.join(", "),
            got: maxSensitivityArg,
          })
        );
        process.exit(EXIT.USAGE);
      }

      const body: CreateKeyInput = { label, scopes, plan, test: isTest };
      if (isUserToken) body.keyKind = "user";
      if (expiresIn) body.expiresIn = expiresIn;
      if (ipArg) body.ipAllowlist = ipArg.split(",").map((s) => s.trim());
      if (maxSensitivityArg)
        body.maxSensitivity = maxSensitivityArg as
          "public" | "internal" | "confidential" | "restricted";

      const data = await callApi(createClient(url, apiKey).createKey(body));

      console.log(t("keys.mKeyCreatedCopy"));
      console.log(t("keys.createKey", { key: data.key }));
      console.log(t("keys.createId", { id: data.id }));
      console.log(t("keys.createLabel", { label: data.label }));
      console.log(t("keys.createScopes", { scopes: data.scopes.join(", ") }));
      console.log(t("keys.createPlan", { plan: data.plan }));
      console.log(t("keys.createExpires", { expires: data.expiresAt ?? t("common.never") }));
      console.log(
        t("keys.createMaxSensitivity", { value: data.maxSensitivity ?? t("common.noneWord") })
      );
      return;
    }

    if (subCmd === "revoke") {
      const keyId = rest[0];
      if (!keyId) {
        console.error(t("keys.usageMnemoKeysRevoke"));
        process.exit(EXIT.USAGE);
      }
      const data = await callApi(createClient(url, apiKey).revokeKey(keyId));
      statusLine({
        mode: cfg.uiMode,
        kind: "admin",
        action: t("keys.keyRevokedAt", { keyId, revokedAt: data.revokedAt }),
      });
      return;
    }

    if (subCmd === "show") {
      const keyId = rest[0];
      if (!keyId) {
        console.error(t("keys.usageMnemoKeysShow"));
        process.exit(EXIT.USAGE);
      }
      const data = await callApi(createClient(url, apiKey).getKey(keyId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("keys.fetchingKey"),
        detail: keyId,
        pending: true,
      });
      console.log(t("keys.showId", { id: data.id }));
      console.log(t("keys.showLabel", { label: data.label || t("common.none") }));
      console.log(t("keys.showScopes", { scopes: data.scopes.join(", ") }));
      console.log(
        t("keys.showIpAllowlist", {
          value: data.ipAllowlist.length ? data.ipAllowlist.join(", ") : t("keys.unrestricted"),
        })
      );
      console.log(t("keys.showExpires", { expires: data.expiresAt ?? t("common.never") }));
      console.log(t("keys.showLastUsed", { lastUsed: data.lastUsedAt ?? t("common.never") }));
      console.log(t("keys.showMaxSensitivity", { value: data.maxSensitivity ?? t("common.none") }));
      if (data.revokedAt) {
        console.log(t("keys.showRevoked", { revokedAt: data.revokedAt }));
      }
      if (data.deprecatedAt) {
        console.log(t("keys.showDeprecated", { deprecatedAt: data.deprecatedAt }));
      }
      if (data.rotatedFromId) {
        console.log(t("keys.showRotatedFrom", { rotatedFromId: data.rotatedFromId }));
      }
      console.log(t("keys.showCreated", { createdAt: data.createdAt }));
      return;
    }

    if (subCmd === "rotate") {
      const keyId = rest[0];
      if (!keyId) {
        console.error(t("keys.usageMnemoKeysRotate"));
        process.exit(EXIT.USAGE);
      }
      const reason = rest[1] ?? "manual rotation";
      const data = await callApi(createClient(url, apiKey).rotateKey(keyId, { reason }));

      const border = "═".repeat(60);
      console.log(`\n╔${border}╗`);
      console.log(`║  ${t("keys.rotateWarning").padEnd(58)}║`);
      console.log(`╚${border}╝\n`);
      console.log(t("keys.newKey", { newKey: data.newKey }));
      console.log(t("keys.newKeyId", { newKeyId: data.newKeyId }));
      console.log(t("keys.oldKeyValidUntil", { oldKeySunsetAt: data.oldKeySunsetAt }));
      console.log(t("keys.theOldKeyWill"));
      console.log(t("keys.updateYourConfigurationWith"));
      return;
    }

    // Scoped-scheme keys (POST/DELETE /admin/scoped-keys), the ones MNEMO_SCOPED_AUTH=1 verifies.
    if (subCmd === "scoped") {
      const [action, ...args] = rest;
      const flag = (name: string) => args.find((_, i) => args[i - 1] === name);
      const client = createClient(url, apiKey);

      if (action === "create") {
        const type = flag("--type") ?? "live";
        if (type !== "live" && type !== "sess" && type !== "admin") {
          console.error(t("keys.usageScoped"));
          process.exit(EXIT.USAGE);
        }
        const scopes = (flag("--scopes") ?? "memory:read").split(",").map((s) => s.trim());
        const expiresIn = flag("--expires");
        const ipArg = flag("--ip-allowlist");
        const maxSensitivity = flag("--max-sensitivity");
        const data = await callApi(
          client.issueScopedKey({
            type,
            scopes,
            ...(expiresIn ? { expiresIn } : {}),
            ...(ipArg ? { ipAllowlist: ipArg.split(",").map((s) => s.trim()) } : {}),
            ...(maxSensitivity
              ? {
                  maxSensitivity: maxSensitivity as
                    "public" | "internal" | "confidential" | "restricted",
                }
              : {}),
          })
        );
        console.log(t("keys.mKeyCreatedCopy"));
        console.log(t("keys.createKey", { key: data.key }));
        console.log(t("keys.createId", { id: data.id }));
        console.log(t("keys.createScopes", { scopes: data.scopes.join(", ") }));
        console.log(t("keys.createExpires", { expires: data.expiresAt }));
        if (data.mfaSecret) {
          console.log(t("keys.scopedMfaSecret", { secret: data.mfaSecret }));
          console.log(t("keys.scopedOtpauth", { uri: data.otpauthUri ?? "" }));
        }
        return;
      }

      if (action === "rotate" && args[0]) {
        const data = await callApi(
          client.rotateScopedKey(args[0], { reason: args[1] ?? "manual rotation" })
        );
        console.log(`\n${t("keys.rotateWarning")}\n`);
        console.log(t("keys.newKey", { newKey: data.newKey }));
        console.log(t("keys.newKeyId", { newKeyId: data.newId }));
        console.log(t("keys.oldKeyValidUntil", { oldKeySunsetAt: data.oldKeySunsetAt }));
        console.log(t("keys.theOldKeyWill"));
        return;
      }

      if (action === "revoke" && args[0]) {
        const data = await callApi(client.revokeScopedKey(args[0]));
        statusLine({
          mode: cfg.uiMode,
          kind: "admin",
          action: t("keys.keyRevokedAt", { keyId: args[0], revokedAt: data.revokedAt }),
        });
        return;
      }

      console.error(t("keys.usageScoped"));
      process.exit(EXIT.USAGE);
    }

    console.error(t("keys.unknownKeysSubcommandUse", { subCmd }));
    process.exit(EXIT.USAGE);
  },

  // §19 agent RBAC policies (GET/PUT/DELETE /admin/agent-policy, GET /admin/agent-policies).
  async policy(args: string[], cfg: Config) {
    const [subCmd, agentId, ...rest] = args;
    const { url, apiKey } = cfg as { url: string; apiKey: string };
    const client = createClient(url, apiKey);

    if (subCmd === "list" || !subCmd) {
      const data = await callApi(client.listAgentPolicies());
      statusLine({ mode: cfg.uiMode, kind: "read", action: t("policy.listing"), pending: true });
      printList("policies", data.policies, t("policy.noPolicies"));
      return;
    }

    if (subCmd === "get") {
      if (!agentId) {
        console.error(t("policy.usageGet"));
        process.exit(EXIT.USAGE);
      }
      const data = await callApi(client.getAgentPolicy(agentId));
      statusLine({
        mode: cfg.uiMode,
        kind: "read",
        action: t("policy.fetching"),
        detail: agentId,
        pending: true,
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (subCmd === "set") {
      const file = rest.find((_, i) => rest[i - 1] === "--file");
      if (!agentId || !file) {
        console.error(t("policy.usageSet"));
        process.exit(EXIT.USAGE);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(t("policy.badFile", { file, message }));
        process.exit(EXIT.USAGE);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(t("policy.badFile", { file, message: typeof parsed }));
        process.exit(EXIT.USAGE);
      }
      // The server validates the shape strictly; the agent id comes from the argument.
      const data = await callApi(
        client.putAgentPolicy({ ...(parsed as AgentPolicyInput), agentId })
      );
      statusLine({ mode: cfg.uiMode, kind: "admin", action: t("policy.saved", { agentId }) });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (subCmd === "delete") {
      if (!agentId) {
        console.error(t("policy.usageDelete"));
        process.exit(EXIT.USAGE);
      }
      await callApi(client.deleteAgentPolicy(agentId));
      statusLine({ mode: cfg.uiMode, kind: "admin", action: t("policy.deleted", { agentId }) });
      return;
    }

    console.error(t("policy.unknownSubcommand", { subCmd }));
    process.exit(EXIT.USAGE);
  },
};

// ── Help text ────────────────────────────────────────────────────────────────

export function getCmdHelp(): string {
  return t("help.text", { version: CLI_VERSION });
}

/**
 * ~/.mnemo/config.json holds the API key: the directory is 0700 and the file
 * 0600 whatever the umask (re-audit 2: `mnemo init` used to write it 0644).
 */
export function writeMnemoConfigFile(configDir: string, data: Record<string, unknown>): void {
  const { mkdirSync: mk, chmodSync: ch, writeFileSync: wr } = nodeFs;
  mk(configDir, { recursive: true, mode: 0o700 });
  ch(configDir, 0o700);
  const file = nodePath.join(configDir, "config.json");
  wr(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  ch(file, 0o600);
}
