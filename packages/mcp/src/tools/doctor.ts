import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import type { DoctorCheck } from "@mnemo-ai/client-ts";

import { MCP_TOOL_COUNT } from "../registry.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_doctor` — run 8 operational diagnostic checks and return a
 * structured DoctorReport.
 *
 * Checks 1–6 are server-side (fetched via `client.doctor()`):
 *   1. connectivity       — Postgres reachable via deps.core.ping()
 *   2. app_user_grants    — app_user has USAGE on the mnemosyne schema
 *   3. schema_shadows     — no table names clash across public / mnemosyne schemas
 *   4. migration_version  — latest applied migration filename
 *   5. embedding_backlog  — no live facts with missing or stale embeddings
 *   6. workspace_id_valid — authenticated workspace_id is a well-formed UUID
 *
 * Checks 7–8 are client-side (run inside the MCP process):
 *   7. env_config  — MNEMO_URL and MNEMO_KEY are set
 *   8. mcp_tools   — MCP server has exactly the active profile's tool count
 *      registered (MNEMO_MCP_TOOLS: core = 9, full = MCP_TOOL_COUNT).
 *      DOCTOR-1: measures a LIVE ToolRegistrationProbe populated by
 *      registerAllTools's counting wrapper (registry.ts), not a value that
 *      already equals MCP_TOOL_COUNT by construction. "error" when a
 *      registrar genuinely threw during boot (a real capability gap);
 *      "warn" for a bare count mismatch with no recorded failure.
 *
 * No input parameters required. No auto-remediation — report only.
 *
 * Known limitations (surfaced by an audit — see
 * docs/archive/openspec/tool-promise-remediation/tools/memory_doctor.md):
 *   - schema_shadows reports "warn" on EVERY healthy deploy, not just
 *     genuine accidental collisions. docker/Dockerfile.migrate runs both
 *     the legacy/public (`@mnemo-ai/core`) and v3/mnemosyne
 *     (`@mnemo-ai/adapter-postgres`) migration streams in every real
 *     deploy (the "dual-core hybrid"), and both streams create same-named
 *     tables (mnemo_fact, mnemo_entity, mnemo_relation, ...) in `public`
 *     and `mnemosyne` respectively. This check can never distinguish that
 *     expected overlap from a genuine accidental collision — treat "warn"
 *     here as normal, not actionable, unless shadowCount changes.
 *   - workspace_id_valid's "error" branch is unreachable through the real
 *     API: the API-key lookup (packages/core/src/api-key-lookup.ts) filters
 *     malformed workspace_ids out before auth even runs, and auth.ts's own
 *     isWorkspaceId() gate (same regex) rejects with 400 before any route
 *     handler executes. The check is correct and kept for defense in depth,
 *     but it will never observably fire in production.
 */
/**
 * A live, lazily-read measurement of what actually got registered on the
 * McpServer. MUST be read at tool-call time, never at registration time:
 * registerDoctorFromRegistry runs at TOOL_REGISTRARS index 26 of 34, so any
 * count captured eagerly would miss the last 7 registrars entirely.
 */
export interface ToolRegistrationProbe {
  count(): number;
  failures(): ReadonlyArray<{ registrar: string; error: string }>;
  /** MNEMO_MCP_TOOLS profile in force, and how many tools it registers. Default full. */
  profile?: "core" | "full";
  expected?: number;
}

function asProbe(source: number | ToolRegistrationProbe): ToolRegistrationProbe {
  // A bare number keeps doctor.test.ts's direct-injection comparison-logic tests working unchanged.
  return typeof source === "number" ? { count: () => source, failures: () => [] } : source;
}

export function registerDoctor(
  server: McpServer,
  client: MnemosyneClient,
  toolCount: number | ToolRegistrationProbe,
  locale: Locale = DEFAULT_LOCALE
): void {
  server.registerTool(
    "memory_doctor",
    {
      title: "Memory system doctor",
      inputSchema: {},
    },
    async () => {
      // ── Check 7: env_config ──────────────────────────────────────────────────
      const mnemoUrl = process.env.MNEMO_URL?.trim();
      const mnemoKey = process.env.MNEMO_KEY?.trim();

      let envMessage: string;
      let envStatus: DoctorCheck["status"];
      if (!mnemoUrl && !mnemoKey) {
        envStatus = "error";
        envMessage = t(locale, "out.memory_doctor.envBothMissing");
      } else if (!mnemoUrl) {
        envStatus = "error";
        envMessage = t(locale, "out.memory_doctor.envUrlMissing");
      } else if (!mnemoKey) {
        envStatus = "error";
        envMessage = t(locale, "out.memory_doctor.envKeyMissing");
      } else {
        envStatus = "ok";
        envMessage = t(locale, "out.memory_doctor.envOk");
      }

      const envCheck: DoctorCheck = {
        name: "env_config",
        status: envStatus,
        message: envMessage,
      };

      // ── Check 8: mcp_tools ───────────────────────────────────────────────────
      // Was `toolCount === MCP_TOOL_COUNT` where toolCount WAS MCP_TOOL_COUNT
      // through the one real call site — a tautology that could never fail.
      // Now an independent measurement, read lazily at call time via a probe
      // populated by registerAllTools's counting wrapper.
      const probe = asProbe(toolCount);
      const registeredCount = probe.count();
      const failedRegistrars = probe.failures();
      const profile = probe.profile ?? "full";
      const expected = probe.expected ?? MCP_TOOL_COUNT;
      const mcpCheck: DoctorCheck = {
        name: "mcp_tools",
        status:
          failedRegistrars.length > 0 ? "error" : registeredCount === expected ? "ok" : "warn",
        message:
          failedRegistrars.length > 0
            ? t(locale, "out.memory_doctor.toolsFailed", {
                registered: registeredCount,
                expected,
                profile,
                failed: failedRegistrars.length,
                names: failedRegistrars.map((f) => f.registrar).join(", "),
              })
            : t(locale, "out.memory_doctor.tools", {
                registered: registeredCount,
                expected,
                profile,
              }),
        detail: {
          profile,
          toolCount: registeredCount,
          expected,
          ...(failedRegistrars.length > 0 ? { failedRegistrars } : {}),
        },
      };

      // ── Fetch server-side checks (1–6) ───────────────────────────────────────
      let serverChecks: DoctorCheck[] = [];
      let serverReachable = true;

      try {
        const report = await client.doctor();
        serverChecks = report.checks;
      } catch (err) {
        const status =
          err && typeof err === "object" && "status" in err && typeof err.status === "number"
            ? err.status
            : undefined;
        serverReachable = status !== undefined;
        const message = err instanceof Error ? err.message : String(err);
        serverChecks = [
          {
            name: "server",
            status: "error",
            message:
              status === 401
                ? t(locale, "out.memory_doctor.http401", { message })
                : status === 403
                  ? t(locale, "out.memory_doctor.http403", { message })
                  : status !== undefined
                    ? t(locale, "out.memory_doctor.http", { status, message })
                    : t(locale, "out.memory_doctor.unreachable", { message }),
          },
        ];
      }

      // ── Merge all checks and compute overall status ──────────────────────────
      const allChecks: DoctorCheck[] = [...serverChecks, envCheck, mcpCheck];

      const worst = allChecks.some((c) => c.status === "error")
        ? "error"
        : allChecks.some((c) => c.status === "warn")
          ? "warn"
          : allChecks.some((c) => c.status === "unknown")
            ? "unknown"
            : "ok";

      const result = {
        status: worst,
        checks: allChecks,
        timestamp: new Date().toISOString(),
        _meta: {
          serverReachable,
          checkCount: allChecks.length,
        },
      };

      return {
        content: [
          {
            type: "text" as const,
            text: jsonText(result),
          },
        ],
        structuredContent: result as unknown as { [key: string]: unknown },
      };
    }
  );
}
