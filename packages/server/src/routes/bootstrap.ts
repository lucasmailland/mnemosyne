/**
 * One-time bootstrap endpoint for self-hosted deployments.
 *
 * Exposes unauthenticated routes on the root app (not /v1, so the auth
 * middleware never runs against them):
 *
 *   GET  /bootstrap/status      → { bootstrapped: boolean }
 *   POST /bootstrap             → registers the first API key; 403 if already done
 *   GET  /setup/token           → { token, expiresAt } to a loopback caller, 404 otherwise
 *   GET  /setup                 → HTML wizard (unbootstrapped) or complete page (bootstrapped)
 *   POST /setup/validate-llm    → { valid: boolean, error?: string }
 *   POST /setup/complete        → { ok: true, workspaceId, apiKey, envSnippet }
 *
 * Security model: the setup endpoints are wide-open until the first key is
 * stored. For Docker self-hosted scenarios this is acceptable because mnemosyne
 * is on a private internal network. After the first POST succeeds, all setup
 * routes return 404 or 403.
 */

import type { Hono } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcrypt";
import { formatActorRef } from "@mnemo-ai/types";

import { BCRYPT_COST } from "../auth.js";
import { logger } from "../logging.js";
import { emitAudit } from "../audit-emit.js";
import type { ServerDeps } from "../deps.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { normalizeEmail, passwordPolicyError } from "../dashboard-password.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const API_KEY_PATTERN = /^(mns_(live|test)|mk_(live|test|sess|fed|admin))_[a-z0-9]{20,64}$/i;

const ALL_SCOPES = [
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:admin",
  "memory:export",
  "memory:governance",
  "memory:task",
  "memory:event",
  "memory:session",
  "memory:reasoning",
  "memory:procedural",
  "memory:self_edit",
  "memory:subscribe",
  "memory:federation",
  "memory:hard_delete",
  // APP-040: with memory:admin, makes the first key an admin in the dashboard
  // (manage keys) instead of a contributor.
  "admin:keys",
];

/** The scopes of the installation's first key. Exported for the test. */
export const FIRST_KEY_SCOPES: readonly string[] = ALL_SCOPES;

/** 15 minutes in milliseconds */
const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;

/** In-memory token store. Key = token UUID, value = expiry timestamp. */
const setupTokens = new Map<string, { expiresAt: number }>();

/**
 * Generate a new single-use setup token with a 15-minute TTL.
 * Stores it in the in-memory map and returns the token string.
 */
export function generateSetupToken(): string {
  const token = randomUUID();
  setupTokens.set(token, { expiresAt: Date.now() + SETUP_TOKEN_TTL_MS });
  return token;
}

/**
 * Validate a setup token: check existence + expiry, then delete it (single-use).
 * Returns true if the token was valid; false otherwise.
 */
export function validateSetupToken(token: string): boolean {
  const entry = setupTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    setupTokens.delete(token);
    return false;
  }
  setupTokens.delete(token);
  return true;
}

/**
 * Peek at a setup token without consuming it (for GET /setup/token).
 * Returns the entry if valid, undefined otherwise.
 */
function peekSetupToken(): { token: string; expiresAt: number } | undefined {
  for (const [token, entry] of setupTokens.entries()) {
    if (Date.now() <= entry.expiresAt) {
      return { token, expiresAt: entry.expiresAt };
    }
    // Expired — clean up
    setupTokens.delete(token);
  }
  return undefined;
}

/**
 * A setup token the operator chose, for provisioning that cannot read the log
 * (an installer, a compose file, the e2e stack). Unlike the generated one it
 * does not expire: the first key closes bootstrap for good either way. Ignored
 * when shorter than 16 characters, so an empty or placeholder value opens nothing.
 */
function operatorSetupToken(): string | undefined {
  const value = process.env["MNEMO_SETUP_TOKEN"];
  return value !== undefined && value.length >= 16 ? value : undefined;
}

/** True when the token exists and has not expired. Does not consume it. */
export function isLiveSetupToken(token: string): boolean {
  const fixed = operatorSetupToken();
  if (fixed !== undefined) {
    const a = Buffer.from(token);
    const b = Buffer.from(fixed);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  const entry = setupTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    setupTokens.delete(token);
    return false;
  }
  return true;
}

/**
 * Whether the request was made on this machine's own loopback interface and
 * was not relayed by a proxy. Only such a caller is given the setup token over
 * HTTP: `docker compose exec server …` or a shell on the host of a bare
 * install. A request published through Docker arrives from the bridge address,
 * and one relayed by a reverse proxy on the same host carries a forwarding
 * header, so neither qualifies. An unknown peer address does not qualify.
 */
function isLoopbackCaller(c: {
  env: unknown;
  req: { header(name: string): string | undefined };
}): boolean {
  for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip"]) {
    if (c.req.header(h) !== undefined) return false;
  }
  // Final review I1: a web page the operator has open is also a loopback
  // caller. A fetch from it carries Origin and a Sec-Fetch-Site other than
  // "none", and a DNS-rebinding page arrives with its own Host. A shell
  // (curl) sends neither header, and a URL typed in the address bar sends
  // Sec-Fetch-Site: none.
  if (c.req.header("origin") !== undefined) return false;
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "none") return false;
  const host = (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return false;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const remote = incoming?.socket?.remoteAddress?.replace(/^::ffff:/, "");
  return remote === "127.0.0.1" || remote === "::1";
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

/** Final review I1: the token comes from the query string; never raw HTML. */
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function setupHtml(token: string, portArg: string | number = ""): string {
  const port = portArg === "" ? "3939" : String(portArg);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnemosyne Setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  /* ── Marca Mnemosyne — mnemosyne-branding/reports/tokens.css ──
     Light por defecto (Paper/Deep/Electric), dark por prefers-color-scheme.
     En dark el accent pasa a --electric-soft: el electric puro no contrasta
     sobre Deep. Es la rampa del brandbook, no un color nuevo. */
  :root {
    --electric: #1a18f0; --electric-strong: #1210b0; --electric-soft: #9a98fa;
    --ivory: #f5ecde; --deep: #0b0a2e; --paper: #fcfbf8;
    --font-display: "GFS Didot", Didot, "Bodoni MT", "Playfair Display", Georgia, serif;
    --font-text: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --bg: var(--paper); --surface: #fffefc; --surface-alt: var(--ivory);
    --text: var(--deep); --text-muted: #4a4866;
    --accent: var(--electric); --accent-hover: var(--electric-strong);
    --knockout: var(--paper);
    --border: #e2dccd; --ok: #0f7a52; --err: #b3261e;
    --shadow: 0 1px 2px rgba(11,10,46,.06), 0 8px 24px rgba(11,10,46,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--deep); --surface: #131234; --surface-alt: #1a1940;
      --text: var(--ivory); --text-muted: #a9a4bd;
      --accent: var(--electric-soft); --accent-hover: #b8b6fc;
      --knockout: var(--deep);
      --border: #2a2856; --ok: #34d399; --err: #f87171;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    }
  }
  body { font-family: var(--font-text); background: var(--bg); color: var(--text); margin: 0; padding: 2rem; color-scheme: light dark; }
  .card { max-width: 520px; margin: 3rem auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2.5rem; box-shadow: var(--shadow); }
  /* Wordmark: Didot + tracking 0.14em. El tracking es identidad (README §brand). */
  h1 { font-family: var(--font-display); letter-spacing: 0.14em; font-size: 1.5rem; font-weight: 400; margin: 0 0 0.5rem; color: var(--accent); }
  .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 2rem; }
  label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.3rem; }
  input, select { width: 100%; padding: 0.6rem 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.9rem; font-family: inherit; margin-bottom: 1.2rem; outline: none; }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .row { display: flex; gap: 0.7rem; align-items: flex-end; }
  .row input { margin-bottom: 0; }
  button { padding: 0.6rem 1.1rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; font-family: inherit; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn-test { background: var(--surface-alt); color: var(--text); }
  .btn-test:hover { background: var(--border); }
  .btn-submit { width: 100%; background: var(--accent); color: var(--knockout); padding: 0.75rem; font-size: 1rem; margin-top: 0.5rem; border-radius: 8px; }
  .btn-submit:hover { background: var(--accent-hover); }
  .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { font-size: 0.78rem; color: var(--text-muted); margin-top: -0.9rem; margin-bottom: 1.2rem; line-height: 1.5; }
  .hint code { font-family: var(--font-mono); font-size: 0.92em; background: var(--surface-alt); border: 1px solid var(--border); border-radius: 4px; padding: 0.05em 0.32em; }
  #test-status { font-size: 0.82rem; margin-left: 0.5rem; }
  .ok { color: var(--ok); }
  .err { color: var(--err); }
  #result { margin-top: 1.5rem; }
  pre { background: var(--surface-alt); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; font-size: 0.82rem; font-family: var(--font-mono); white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <h1>Mnemosyne Setup</h1>
  <p class="subtitle">First-run configuration. This page is only available until a workspace is created.</p>
  <form id="setup-form">
    <label for="ws-name">Workspace name</label>
    <input type="text" id="ws-name" name="workspaceName" placeholder="My Mnemosyne" required>
    <label for="token">Setup token</label>
    <input type="text" id="token" name="token" value="${escapeAttr(token)}" required autocomplete="off">
    <p class="hint">Expires 15 minutes after the server started. Already filled in if you
      opened the link from the server log. Otherwise get it with
      <code>docker logs &lt;container&gt; | grep setup_required</code>, or
      <code>docker compose exec server wget -qO- http://localhost:${port}/setup/token</code> from the machine that runs it. If it expired, restart the server to mint a new one.</p>
    <label for="provider">LLM provider</label>
    <select id="provider" name="llmProvider">
      <option value="openai">OpenAI</option>
      <option value="anthropic">Anthropic</option>
      <option value="local">Local (Ollama — no key needed)</option>
    </select>
    <label for="api-key">LLM API key</label>
    <div class="row">
      <input type="password" id="api-key" name="llmApiKey" placeholder="sk-...">
      <button type="button" class="btn-test" id="test-btn">Test</button>
      <span id="test-status"></span>
    </div>
    <button type="submit" class="btn-submit" id="submit-btn">Create workspace</button>
  </form>
  <div id="result"></div>
</div>
<script>
  document.getElementById('provider').addEventListener('change', function() {
    const isLocal = this.value === 'local';
    document.getElementById('api-key').disabled = isLocal;
    document.getElementById('test-btn').disabled = isLocal;
  });
  document.getElementById('test-btn').addEventListener('click', async function() {
    const provider = document.getElementById('provider').value;
    const apiKey = document.getElementById('api-key').value;
    const status = document.getElementById('test-status');
    status.textContent = 'Testing…';
    status.className = '';
    try {
      const r = await fetch('/setup/validate-llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await r.json();
      if (data.valid) {
        status.textContent = '✓ Valid';
        status.className = 'ok';
      } else {
        status.textContent = '✗ ' + (data.error ?? 'Invalid key');
        status.className = 'err';
      }
    } catch (e) {
      status.textContent = '✗ Network error';
      status.className = 'err';
    }
  });
  document.getElementById('setup-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    const payload = {
      token: document.getElementById('token').value,
      workspaceName: document.getElementById('ws-name').value,
      llmProvider: document.getElementById('provider').value,
      llmApiKey: document.getElementById('api-key').value,
    };
    try {
      const r = await fetch('/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      const result = document.getElementById('result');
      if (r.ok && data.ok) {
        result.innerHTML = '<h2 class="ok" style="font-family:var(--font-display);letter-spacing:0.14em;font-weight:400">Setup complete!</h2>' +
          '<p>Your API key (copy now — shown once only):</p>' +
          '<pre>' + data.apiKey + '</pre>' +
          '<p>Add to your MCP config:<br><pre>' + data.envSnippet + '</pre></p>';
        document.getElementById('setup-form').style.display = 'none';
      } else {
        result.innerHTML = '<p class="err">Error: ' + (data.error ?? r.status) + '</p>';
        btn.disabled = false;
        btn.textContent = 'Create workspace';
      }
    } catch (err) {
      document.getElementById('result').innerHTML = '<p class="err">Network error</p>';
      btn.disabled = false;
      btn.textContent = 'Create workspace';
    }
  });
</script>
</body>
</html>`;
}

function setupCompleteHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mnemosyne — Setup Complete</title>
<style>
  :root {
    --electric: #1a18f0; --electric-soft: #9a98fa; --ivory: #f5ecde;
    --deep: #0b0a2e; --paper: #fcfbf8;
    --font-display: "GFS Didot", Didot, "Bodoni MT", Georgia, serif;
    --font-text: Inter, system-ui, -apple-system, sans-serif;
    --bg: var(--paper); --surface: #fffefc; --text: var(--deep);
    --text-muted: #4a4866; --accent: var(--electric); --border: #e2dccd;
    --shadow: 0 1px 2px rgba(11,10,46,.06), 0 8px 24px rgba(11,10,46,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: var(--deep); --surface: #131234; --text: var(--ivory);
      --text-muted: #a9a4bd; --accent: var(--electric-soft); --border: #2a2856;
      --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.3);
    }
  }
  body { font-family: var(--font-text); background: var(--bg); color: var(--text); margin: 0; padding: 2rem; color-scheme: light dark; }
  .card { max-width: 520px; margin: 3rem auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2.5rem; text-align: center; box-shadow: var(--shadow); }
  h1 { font-family: var(--font-display); letter-spacing: 0.14em; font-weight: 400; color: var(--accent); font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: var(--text-muted); }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>Setup complete</h1>
  <p>Mnemosyne is already configured and running.</p>
  <p><a href="https://github.com/lucasmailland/mnemosyne#readme" target="_blank" rel="noopener">View documentation →</a></p>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// LLM validation helper
// ---------------------------------------------------------------------------

async function validateLlmKey(
  provider: string,
  apiKey: string
): Promise<{ valid: boolean; error?: string }> {
  if (provider === "local") {
    return { valid: true };
  }

  const timeout = AbortSignal.timeout(5000);

  try {
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: ["test"] }),
        signal: timeout,
      });
      if (res.ok) return { valid: true };
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as Record<string, unknown>;
        const nested = body["error"] as Record<string, unknown> | undefined;
        if (typeof nested?.["message"] === "string") errMsg = nested["message"];
      } catch {
        /* ignore parse error */
      }
      return { valid: false, error: errMsg };
    }

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: timeout,
      });
      if (res.ok) return { valid: true };
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body["error"] === "object" && body["error"] !== null) {
          const nested = body["error"] as Record<string, unknown>;
          if (typeof nested["message"] === "string") errMsg = nested["message"];
        }
      } catch {
        /* ignore */
      }
      return { valid: false, error: errMsg };
    }

    return { valid: false, error: `Unknown provider: ${provider}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

export function mountBootstrap(app: Hono, deps?: Pick<ServerDeps, "storage">): void {
  const databaseUrl = process.env["DATABASE_URL"] ?? process.env["MNEMO_DATABASE_URL"];

  if (!databaseUrl) {
    logger.warn("mountBootstrap: DATABASE_URL not set — bootstrap endpoints disabled");
    return;
  }

  // APP-029: one small pool for every bootstrap route, opened on first use
  // and kept, instead of a connection opened and closed per request (these
  // routes take unauthenticated traffic).
  let pool: Promise<BootstrapSql> | null = null;
  function openDb(): Promise<BootstrapSql> {
    pool ??= createPool();
    return pool;
  }
  async function createPool(): Promise<BootstrapSql> {
    const mod = (await import("postgres")) as unknown as {
      default: (url: string, opts?: Record<string, unknown>) => BootstrapSql;
    };
    return mod.default(databaseUrl!, {
      max: 2,
      idle_timeout: 5,
      connect_timeout: 10,
      connection: { search_path: "mnemosyne,public" },
    });
  }

  // GET /bootstrap/status — always accessible, no auth needed.
  app.get("/bootstrap/status", async (c) => {
    const sql = await openDb();
    try {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      return c.json({ bootstrapped: count > 0 });
    } catch (err) {
      logger.error({ err }, "bootstrap.status: DB error");
      return c.json({ error: "db_unavailable", message: "Could not reach the database" }, 503);
    }
  });

  // POST /bootstrap — registers the first API key and workspace. Locked once used.
  app.post("/bootstrap", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
    }

    const b = body as Record<string, unknown>;

    if (typeof b["apiKey"] !== "string" || !API_KEY_PATTERN.test(b["apiKey"])) {
      return c.json(
        {
          error: "invalid_api_key",
          message:
            "apiKey must match mns_(live|test)_<20+alphanum> or mk_(live|test|...)_<20+alphanum>",
        },
        400
      );
    }
    if (typeof b["workspaceId"] !== "string" || !UUID_PATTERN.test(b["workspaceId"])) {
      return c.json(
        {
          error: "invalid_workspace",
          message: "workspaceId must be a valid UUID",
        },
        400
      );
    }

    const apiKey = b["apiKey"] as string;
    const workspaceId = b["workspaceId"] as string;
    const label =
      typeof b["label"] === "string" && b["label"].length > 0 ? b["label"] : "bootstrap";

    // APP-004: the first key is registered only with the setup token from the
    // server log. Read here, checked after the "already bootstrapped" answer so
    // that one stays a 403; consumed only once the key is written.
    const headerToken = c.req.header("x-setup-token");
    const submittedToken =
      typeof headerToken === "string" && headerToken.length > 0
        ? headerToken
        : typeof b["setupToken"] === "string"
          ? b["setupToken"]
          : "";
    const tokenOk = submittedToken.length > 0 && isLiveSetupToken(submittedToken);

    // The first superadmin: both fields or neither.
    const rawEmail = b["adminEmail"];
    const rawPassword = b["adminPassword"];
    const hasEmail = rawEmail !== undefined && rawEmail !== null;
    const hasPassword = rawPassword !== undefined && rawPassword !== null;
    let adminEmail: string | undefined;
    let adminHash: string | undefined;
    if (hasEmail !== hasPassword) {
      return c.json(
        {
          error: "invalid_admin",
          message: "adminEmail and adminPassword must be provided together",
        },
        400
      );
    }
    if (hasEmail && hasPassword) {
      if (
        typeof rawEmail !== "string" ||
        typeof rawPassword !== "string" ||
        !rawEmail.includes("@") ||
        rawEmail.length > 254
      ) {
        return c.json(
          { error: "invalid_admin", message: "adminEmail must be a valid email address" },
          400
        );
      }
      adminEmail = normalizeEmail(rawEmail);
      const policy = passwordPolicyError(rawPassword, adminEmail);
      if (policy) return c.json({ error: "invalid_admin", message: policy }, 400);
      // Outside any transaction (PR #241): bcrypt must not hold a connection.
      // Not at all without the token: an anonymous caller gets no free bcrypt.
      if (tokenOk) adminHash = await bcrypt.hash(rawPassword, BCRYPT_COST);
    }

    const sql = await openDb();
    try {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      if (count > 0) {
        return c.json(
          {
            error: "already_bootstrapped",
            message: "Mnemosyne already has API keys. Use the admin API to create additional keys.",
          },
          403
        );
      }
      if (!tokenOk) {
        return c.json(
          {
            error: "setup_token_required",
            message:
              "Registering the first API key needs the setup token printed in the server log at startup. Send it as setupToken in the body or in the X-Setup-Token header.",
          },
          401
        );
      }

      const keyHash = await bcrypt.hash(apiKey, BCRYPT_COST);
      const keyId = `bootstrap_${workspaceId.replace(/-/g, "").slice(0, 12)}`;
      const tenantId = randomUUID();
      const workspaceName = label !== "bootstrap" ? label : "default";

      let adminUserId: string | undefined;
      let lostRace = false;
      await sql.begin(async (tx) => {
        // Two first requests at once: one at a time, and the second one finds a key.
        await tx`SELECT pg_advisory_xact_lock(hashtext('mnemosyne.bootstrap'))`;
        const again = await tx`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
        if (((again[0] as { count: number } | undefined)?.count ?? 0) > 0) {
          lostRace = true;
          return;
        }
        await tx`SELECT set_config('mnemosyne.tenant_id', ${tenantId}, true)`;
        await tx`SELECT set_config('mnemosyne.user_id', ${"bootstrap"}, true)`;
        // §35: the workspaces below get this instance's region (migration 0062).
        await tx`SELECT set_config('mnemosyne.region', ${process.env.MNEMO_REGION ?? ""}, true)`;

        await tx`
          INSERT INTO mnemo_tenant (id, name, kind, plan)
          VALUES (${tenantId}, 'default', 'personal', 'free')
          ON CONFLICT (id) DO NOTHING
        `;

        await tx`
          INSERT INTO mnemo_workspace (id, name, tenant_id, visibility)
          VALUES (${workspaceId}, ${workspaceName}, ${tenantId}, 'private')
          ON CONFLICT (id) DO NOTHING
        `;

        await tx`
          INSERT INTO mnemo_api_keys (id, workspace_id, key_hash, name, scopes)
          VALUES (
            ${keyId},
            ${workspaceId},
            ${keyHash},
            ${label},
            ${tx.array(ALL_SCOPES)}
          )
        `;

        if (adminEmail && adminHash) {
          // Same shape as the admin script: the user and its personal tenant
          // from the provisioning helper, then owner on the bootstrap workspace.
          const [user] = await tx`
            SELECT user_id FROM mnemosyne.mnemo_provision_user(${adminEmail}, ${adminEmail}, ${"Personal"})
          `;
          const userId = (user as { user_id: string }).user_id;
          adminUserId = userId;
          await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${tenantId}, true)`;
          await tx`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, 'owner')`;
          await tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
          // The credential policy admits only the user's own row.
          await tx`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true)`;
          await tx`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${userId}, ${adminHash})`;
          await tx`SELECT mnemosyne.mnemo_instance_bootstrap_admin(${userId})`;
        }
      });

      if (lostRace) {
        return c.json(
          {
            error: "already_bootstrapped",
            message: "Mnemosyne already has API keys. Use the admin API to create additional keys.",
          },
          403
        );
      }
      // Spent only now: a failed write above leaves the token usable.
      setupTokens.delete(submittedToken);

      // After the commit, as for every route audit (audit-emit.ts). No email,
      // password or key in the entries: the resource id names the account.
      if (adminUserId && deps) {
        for (const action of ["user_created", "superadmin_granted"] as const) {
          await emitAudit(deps, {
            workspaceId: GLOBAL_SENTINEL_ID,
            actorType: "system",
            actorId: formatActorRef("system", "bootstrap"),
            action,
            resourceKind: "user",
            resourceId: adminUserId,
            isTerminal: false,
          });
        }
      }

      const adminCreated = adminEmail !== undefined;
      logger.info({ workspaceId, keyId, label, adminCreated }, "mnemosyne bootstrap complete");
      return c.json({ ok: true, workspaceId, keyId, adminCreated }, 201);
    } catch (err) {
      logger.error({ err }, "bootstrap.post: DB error");
      return c.json({ error: "db_error", message: "Failed to register API key" }, 500);
    }
  });

  // GET /setup/token — returns the active setup token (if unbootstrapped + token alive).
  app.get("/setup/token", async (c) => {
    // APP-004: the token is a secret from the server log. Over HTTP it goes only
    // to this machine's own loopback; to anyone else the route does not exist.
    if (!isLoopbackCaller(c)) return c.json({ error: "not_found" }, 404);
    // Check if already bootstrapped
    const sql = await openDb();
    let bootstrapped = false;
    try {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      bootstrapped = count > 0;
    } catch (err) {
      logger.error({ err }, "setup.token: DB error");
      return c.json({ error: "db_unavailable" }, 503);
    }

    if (bootstrapped) {
      return c.json({ error: "not_found" }, 404);
    }

    const entry = peekSetupToken();
    if (!entry) {
      return c.json({ error: "not_found" }, 404);
    }

    const port = process.env["PORT"] ?? "3939";
    const setupUrl = `http://localhost:${port}/setup?token=${entry.token}`;
    return c.json({
      token: entry.token,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      setupUrl,
    });
  });

  // GET /setup — HTML wizard (unbootstrapped) or complete page (bootstrapped).
  app.get("/setup", async (c) => {
    const sql = await openDb();
    let bootstrapped = false;
    try {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      bootstrapped = count > 0;
    } catch (err) {
      logger.error({ err }, "setup.get: DB error");
      return c.html(setupCompleteHtml()); // fail safe to complete page
    }

    if (bootstrapped) {
      return c.html(setupCompleteHtml());
    }

    // Pre-fill token from query param or active token
    const queryToken = c.req.query("token") ?? "";
    // Pre-filled from the live token only for a caller on loopback (APP-004).
    const token = queryToken || (isLoopbackCaller(c) ? (peekSetupToken()?.token ?? "") : "");
    return c.html(setupHtml(token, process.env["PORT"] ?? "3939"));
  });

  // POST /setup/validate-llm — test LLM credentials without persisting anything.
  app.post("/setup/validate-llm", async (c) => {
    // Locked when bootstrapped
    const sql = await openDb();
    let bootstrapped = false;
    try {
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      bootstrapped = count > 0;
    } catch (err) {
      logger.error({ err }, "setup.validate-llm: DB error");
      return c.json({ error: "db_unavailable" }, 503);
    }

    if (bootstrapped) {
      return c.json({ error: "not_found" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const b = body as Record<string, unknown>;
    const provider = typeof b["provider"] === "string" ? b["provider"] : "";
    const apiKey = typeof b["apiKey"] === "string" ? b["apiKey"] : "";

    const result = await validateLlmKey(provider, apiKey);
    return c.json(result);
  });

  // POST /setup/complete — provision workspace + API key and destroy token.
  app.post("/setup/complete", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const b = body as Record<string, unknown>;
    const submittedToken = typeof b["token"] === "string" ? b["token"] : "";
    const workspaceName =
      typeof b["workspaceName"] === "string" && b["workspaceName"].trim().length > 0
        ? b["workspaceName"].trim()
        : "My Mnemosyne";

    const sql = await openDb();
    try {
      // Check bootstrapped state first (403 on double-submit)
      const rows = await sql`SELECT COUNT(*)::int AS count FROM mnemo_api_keys`;
      const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
      if (count > 0) {
        return c.json(
          { error: "already_bootstrapped", message: "Setup has already been completed." },
          403
        );
      }

      // Validate token
      if (!validateSetupToken(submittedToken)) {
        return c.json(
          { error: "invalid_token", message: "Setup token is invalid or has expired." },
          403
        );
      }

      // Generate workspace credentials
      const workspaceId = randomUUID();
      const tenantId = randomUUID();
      const rawApiKey = `mns_live_${randomUUID().replace(/-/g, "")}`;
      const keyHash = await bcrypt.hash(rawApiKey, BCRYPT_COST);
      const keyId = `setup_${workspaceId.replace(/-/g, "").slice(0, 12)}`;

      await sql.begin(async (tx) => {
        await tx`SELECT set_config('mnemosyne.tenant_id', ${tenantId}, true)`;
        await tx`SELECT set_config('mnemosyne.user_id', ${"setup"}, true)`;
        // §35: the workspace below gets this instance's region (migration 0062).
        await tx`SELECT set_config('mnemosyne.region', ${process.env.MNEMO_REGION ?? ""}, true)`;

        await tx`
          INSERT INTO mnemo_tenant (id, name, kind, plan)
          VALUES (${tenantId}, 'default', 'personal', 'free')
          ON CONFLICT (id) DO NOTHING
        `;

        await tx`
          INSERT INTO mnemo_workspace (id, name, tenant_id, visibility)
          VALUES (${workspaceId}, ${workspaceName}, ${tenantId}, 'private')
          ON CONFLICT (id) DO NOTHING
        `;

        await tx`
          INSERT INTO mnemo_api_keys (id, workspace_id, key_hash, name, scopes)
          VALUES (
            ${keyId},
            ${workspaceId},
            ${keyHash},
            ${"setup"},
            ${tx.array(ALL_SCOPES)}
          )
        `;
      });

      const port = process.env["PORT"] ?? "3939";
      const envSnippet = `MNEMO_URL=http://localhost:${port}\nMNEMO_KEY=${rawApiKey}`;

      logger.info({ workspaceId, keyId }, "mnemosyne setup wizard complete");
      return c.json({ ok: true, workspaceId, apiKey: rawApiKey, envSnippet }, 201);
    } catch (err) {
      logger.error({ err }, "setup.complete: DB error");
      return c.json({ error: "db_error", message: "Failed to create workspace" }, 500);
    }
  });
}

// Minimal type surface for the postgres client used in this file only.
interface BootstrapSql {
  <T = Record<string, unknown>>(template: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  array(values: unknown[]): unknown;
  begin<T>(fn: (tx: BootstrapSql) => Promise<T>): Promise<T>;
  end(opts?: { timeout?: number }): Promise<void>;
}
