/**
 * @mnemo-ai/mcp — Standalone Model Context Protocol server.
 *
 * This module boots an `McpServer` over stdio and exposes the live
 * Mnemosyne memory tools as MCP tools.
 *
 * memory_episode_start and memory_episode_end delegate to
 * POST /session/start and POST /session/:id/collapse via
 * @mnemo-ai/client-ts. memory_session is the §24 unified session-control
 * tool (action: pin|scratch|collapse|discard) layered over the same surface.
 * memory_consolidate delegates to POST /consolidation/trigger
 * (activated in v1.1).
 *
 * Design rationale:
 * - Stdio transport is the lingua franca of MCP clients (Claude Desktop,
 *   Cursor, Continue all spawn the server as a child process and pipe
 *   JSON-RPC frames). It also means we never bind a port, so the user
 *   doesn't have to think about networking — `npx @mnemo-ai/mcp` Just
 *   Works inside their client config.
 * - This is a THIN ADAPTER. We do not re-implement memory logic. Each
 *   tool delegates to `@mnemo-ai/client-ts`, which in turn talks to the
 *   Mnemosyne HTTP server. That gives us one source of truth and lets
 *   the server enforce auth + RLS + audit centrally.
 * - We exit non-zero with a friendly stderr message when env vars are
 *   missing, because MCP clients surface stderr in their UI — a silent
 *   failure here is the worst possible UX.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { DEFAULT_LOCALE } from "@mnemo-ai/types";
import { mcpTimeoutMs, readEnv, TIMEOUT_BOUNDS_MS } from "./env.js";
import { mcpLocale, t } from "./i18n/index.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { mcpToolProfile, registerAllTools } from "./registry.js";
import { MCP_VERSION } from "./version.js";

/**
 * Verbose stdio logging, opt-in via MNEMO_MCP_DEBUG=1|true.
 *
 * We hook the transport rather than each tool handler: every JSON-RPC
 * frame (tools/call with full arguments, tools/list, results, errors)
 * flows through `send`/`onmessage` regardless of which tool fires, so
 * this is a single choke point instead of one edit per tool. MCP clients (Claude Code included) already capture our stderr
 * into their own per-server log files, so we don't need a separate log
 * destination — just write there.
 */
function installVerboseTransportLogging(transport: StdioServerTransport): void {
  const prefix = "[mnemosyne-mcp]";
  const originalSend = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, _options?: TransportSendOptions) => {
    process.stderr.write(`${prefix} → ${JSON.stringify(message)}\n`);
    return originalSend(message);
  };

  // `onmessage` is a plain callback property assigned by McpServer/Server
  // internals after `connect()`, not a subscribable event — so we
  // intercept the assignment itself via a property descriptor rather
  // than replacing a method.
  let handler: ((message: JSONRPCMessage) => void) | undefined;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => handler,
    set: (fn: (message: JSONRPCMessage) => void) => {
      handler = (message: JSONRPCMessage) => {
        process.stderr.write(`${prefix} ← ${JSON.stringify(message)}\n`);
        fn(message);
      };
    },
  });
}

function isVerboseEnabled(): boolean {
  const value = process.env.MNEMO_MCP_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function main(): Promise<void> {
  const env = readEnv();
  if (!env) {
    process.exit(1);
  }

  // The client is constructed once and shared across all tool handlers.
  // It owns the HTTP keep-alive pool, retry policy, and auth header
  // injection — none of which the MCP layer should know about.
  const locale = mcpLocale();
  const timeout = mcpTimeoutMs();
  if (timeout.invalid !== undefined) {
    process.stderr.write(
      `${t(locale ?? DEFAULT_LOCALE, "env.badTimeout", {
        value: timeout.invalid,
        min: TIMEOUT_BOUNDS_MS.min,
        max: TIMEOUT_BOUNDS_MS.max,
        ms: timeout.ms,
      })}\n`
    );
  }
  const client = new MnemosyneClient({
    url: env.url,
    apiKey: env.key,
    // Identify ourselves in the User-Agent so server-side logs can
    // distinguish MCP traffic from direct SDK calls.
    userAgent: `mnemosyne-mcp/${process.env.npm_package_version ?? MCP_VERSION}`,
    // APP-014: MNEMO_MCP_TIMEOUT_MS, else 15 s. Collapse calls get their own
    // longer budget (env.ts collapseTimeoutMs) through client.withTimeout().
    timeout: timeout.ms,
    // M3 — bind every request to a specific workspace (X-Workspace-Id) when
    // the operator set MNEMO_WORKSPACE_ID. Only meaningful with a
    // uk_live_* user token; a plain workspace key ignores it server-side.
    ...(env.workspaceId ? { workspaceId: env.workspaceId } : {}),
    // Sent as Accept-Language only when MNEMO_LOCALE is set.
    ...(locale ? { locale } : {}),
  });

  const server = new McpServer(
    {
      name: "mnemosyne",
      version: MCP_VERSION,
    },
    {
      // Tools only — no prompts or resources. Resources may come later for
      // exposing the review queue as a browsable list.
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    }
  );

  // MNEMO_MCP_TOOLS: full (default, all of them) | core (9 tools).
  const tools = mcpToolProfile();
  if (tools.invalid !== undefined) {
    process.stderr.write(
      `${t(locale ?? DEFAULT_LOCALE, "env.badToolProfile", { value: tools.invalid })}\n`
    );
  }
  registerAllTools(server, client, locale, tools.profile);

  const transport = new StdioServerTransport();
  if (isVerboseEnabled()) {
    installVerboseTransportLogging(transport);
    process.stderr.write(
      "[mnemosyne-mcp] verbose logging enabled (MNEMO_MCP_DEBUG=1) — every JSON-RPC frame will be written to stderr\n"
    );
  }
  await server.connect(transport);

  // The server runs until the client closes the stdio pipe. We don't
  // need to keep the event loop alive manually — the transport does.
  // We DO want to swallow SIGINT gracefully so the parent process can
  // terminate us without a stack trace cluttering the user's logs.
  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // Any uncaught error during startup is fatal. We write to stderr (NOT
  // stdout — stdout is the MCP framing channel and a stray message there
  // would corrupt the JSON-RPC stream).
  process.stderr.write(
    `[mnemosyne-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
