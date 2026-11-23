import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import type { ToolRegistrationProbe } from "./tools/doctor.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { t, type MessageKey } from "./i18n/index.js";
import { compactToolList } from "./tool-surface.js";

import { registerAnticipate } from "./tools/anticipate.js";
import { registerCompare } from "./tools/compare.js";
import { registerCompose } from "./tools/compose.js";
import { registerConsolidate } from "./tools/consolidate.js";
import { registerContext } from "./tools/context.js";
import { registerDecide } from "./tools/decide.js";
import { registerDoctor } from "./tools/doctor.js";
import { registerEntity } from "./tools/entity.js";
import { registerEpisodeEnd } from "./tools/episode_end.js";
import { registerEpisodeStart } from "./tools/episode_start.js";
import { registerEvent } from "./tools/event.js";
import { registerForget } from "./tools/forget.js";
import { registerHyperedge } from "./tools/hyperedge.js";
import { registerIntrospect } from "./tools/introspect.js";
import { registerJudge } from "./tools/judge.js";
import { registerPin } from "./tools/pin.js";
import { registerPurge } from "./tools/purge.js";
import { registerReasoning } from "./tools/reasoning.js";
import { registerRecall } from "./tools/recall.js";
import { registerFact } from "./tools/fact.js";
import { registerRelate } from "./tools/relate.js";
import { registerRelocate } from "./tools/relocate.js";
import { registerRemember } from "./tools/remember.js";
import { registerRemindWhen } from "./tools/remind_when.js";
import { registerSearch } from "./tools/search.js";
import { registerSelfEdit } from "./tools/self_edit.js";
import { registerSession } from "./tools/session.js";
import { registerSkill } from "./tools/skill.js";
import { registerStats } from "./tools/stats.js";
import { registerStatus } from "./tools/status.js";
import { registerStrategy } from "./tools/strategy.js";
import { registerSuggestTopicKey } from "./tools/suggest_topic_key.js";
import { registerTask } from "./tools/task.js";
import { registerTimeline } from "./tools/timeline.js";
import { registerUpdate } from "./tools/update.js";
import { registerWorkflow } from "./tools/workflow.js";
import { registerWorkspace } from "./tools/workspace.js";

type RegisterTool = (
  server: McpServer,
  client: MnemosyneClient,
  probe: ToolRegistrationProbe,
  locale: Locale
) => void;

function registerDoctorFromRegistry(
  server: McpServer,
  client: MnemosyneClient,
  probe: ToolRegistrationProbe,
  locale: Locale
): void {
  registerDoctor(server, client, probe, locale); // LIVE probe, not MCP_TOOL_COUNT
}

const TOOL_REGISTRARS = [
  registerRecall,
  registerFact,
  registerRemember,
  registerPin,
  registerForget,
  registerRelocate,
  registerTimeline,
  registerSearch,
  registerRelate,
  registerDecide,
  registerEntity,
  registerStatus,
  registerRemindWhen,
  registerEpisodeStart,
  registerEpisodeEnd,
  registerSession,
  registerConsolidate,
  registerTask,
  registerEvent,
  registerReasoning,
  registerStrategy,
  registerSelfEdit,
  registerHyperedge,
  registerIntrospect,
  registerAnticipate,
  registerCompose,
  registerWorkflow,
  registerSkill,
  registerDoctorFromRegistry,
  registerUpdate,
  registerJudge,
  registerStats,
  registerCompare,
  registerPurge,
  registerContext,
  registerWorkspace,
  registerSuggestTopicKey,
] as const satisfies readonly RegisterTool[];

export const MCP_TOOL_COUNT = TOOL_REGISTRARS.length;

/**
 * MNEMO_MCP_TOOLS picks how much of the surface a client loads. `full` (the
 * default, owner decision 2026-11-22) serves every tool; `core` trims it to
 * what an agent needs on every task, for hosts that do not defer tools and
 * pay tools/list up front on every request.
 */
export type ToolProfile = "core" | "full";
export const DEFAULT_TOOL_PROFILE: ToolProfile = "full";
export const CORE_TOOL_NAMES: readonly string[] = [
  "memory_recall",
  "memory_fact",
  "memory_remember",
  "memory_decide",
  "memory_update",
  "memory_forget",
  "memory_search",
  "memory_status",
  "memory_context",
];
export const PROFILE_TOOL_COUNT: Record<ToolProfile, number> = {
  core: CORE_TOOL_NAMES.length,
  full: MCP_TOOL_COUNT,
};

/** Unset or blank → full; core|full in any case; anything else → core (fail closed), reported in `invalid`. */
export function mcpToolProfile(raw: string | undefined = process.env.MNEMO_MCP_TOOLS): {
  profile: ToolProfile;
  invalid?: string;
} {
  const value = raw?.trim().toLowerCase();
  if (!value) return { profile: DEFAULT_TOOL_PROFILE };
  if (value === "core" || value === "full") return { profile: value };
  return { profile: "core", invalid: raw!.trim() };
}

/**
 * What each tool does to the world, for clients that gate or auto-approve on it.
 * A multi-action tool carries its most dangerous action. Nothing here reaches
 * beyond the configured Mnemosyne server, so openWorldHint is false throughout.
 * recall and search are not read-only: they log the recall and fire reminders.
 */
type ToolHints = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
};
const READS: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADDS: ToolHints = { ...READS, readOnlyHint: false, idempotentHint: false };
const CHANGES: ToolHints = { ...ADDS, destructiveHint: true };

const TOOL_ANNOTATIONS: Record<string, ToolHints> = {
  memory_recall: ADDS,
  memory_fact: READS,
  memory_remember: ADDS,
  memory_pin: { ...ADDS, idempotentHint: true },
  memory_forget: { ...CHANGES, idempotentHint: true },
  memory_relocate: CHANGES,
  memory_timeline: READS,
  memory_search: ADDS,
  memory_relate: CHANGES, // retract
  memory_decide: ADDS,
  memory_entity: CHANGES, // update, unlink_user
  memory_status: READS,
  memory_remind_when: ADDS,
  memory_episode_start: ADDS,
  memory_episode_end: ADDS,
  memory_session: CHANGES, // discard
  memory_consolidate: CHANGES, // merges facts
  memory_task: CHANGES, // patch, archive
  memory_event: ADDS, // append-only: archive is a no-op, sensitivity only rises
  memory_reasoning: CHANGES, // patch, archive
  memory_strategy: CHANGES, // patch, archive
  memory_self_edit: CHANGES, // replace, weaken
  memory_hyperedge: CHANGES, // patch, archive
  memory_introspect: READS,
  memory_anticipate: READS,
  memory_compose: CHANGES, // patch
  memory_workflow: CHANGES, // update
  memory_skill: CHANGES, // update, forget
  memory_doctor: READS,
  memory_update: CHANGES,
  memory_judge: CHANGES, // resolve forgets the losing fact
  memory_stats: READS,
  memory_compare: READS,
  memory_purge: CHANGES,
  memory_context: READS,
  memory_workspace: CHANGES, // remove, set_role
  memory_suggest_topic_key: READS,
};

type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Wraps the SDK's tools/list handler so what clients receive is compacted
 * (tool-surface.ts). Only the advertised JSON changes; calls are still
 * validated by the zod schemas. The SDK installs that handler either when the
 * McpServer is built with the tools capability (index.ts) or on the first
 * registerTool, and exposes no getter for it, so it is read from the
 * protocol's handler map. If an SDK upgrade moves it, nothing breaks but the
 * compaction, and tool-surface-budget.test.ts fails.
 */
function compactListedTools(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })
    ._requestHandlers;
  const list = handlers?.get("tools/list");
  if (!list) return;
  server.server.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra) => compactToolList(await list(request, extra)) as ListToolsResult
  );
}

/**
 * `profile` defaults to full, like the stdio server (index.ts), which passes
 * mcpToolProfile(): full unless MNEMO_MCP_TOOLS=core.
 */
export function registerAllTools(
  server: McpServer,
  client: MnemosyneClient,
  locale: Locale = DEFAULT_LOCALE,
  profile: ToolProfile = "full"
): ToolRegistrationProbe {
  let registered = 0;
  const failures: Array<{ registrar: string; error: string }> = [];
  const probe: ToolRegistrationProbe = {
    count: () => registered,
    failures: () => failures,
    profile,
    expected: PROFILE_TOOL_COUNT[profile],
  };
  const inProfile = (name: unknown): boolean =>
    profile === "full" || (typeof name === "string" && CORE_TOOL_NAMES.includes(name));

  // Instance-scoped, restored in `finally` — nothing leaks to other servers/tests.
  const previous = Object.getOwnPropertyDescriptor(server, "registerTool");
  const inner = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const counting = (...args: unknown[]): unknown => {
    const [name, rawConfig, ...rest] = args;
    if (!inProfile(name)) return undefined; // no registrar reads the return value
    const config = rawConfig as Record<string, unknown>;
    const annotations = typeof name === "string" ? TOOL_ANNOTATIONS[name] : undefined;
    const key = `tools.${String(name)}` as MessageKey;
    const translated = typeof name === "string" ? t(locale, key) : key;
    const description = translated === key ? undefined : translated;
    const result = inner(
      name,
      {
        ...config,
        ...(annotations ? { annotations } : {}),
        ...(description ? { description } : {}),
      },
      ...rest
    );
    registered += 1; // only after success — a throw is not a registration
    return result;
  };
  Object.defineProperty(server, "registerTool", {
    value: counting,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  try {
    for (const register of TOOL_REGISTRARS) {
      try {
        register(server, client, probe, locale);
      } catch (err) {
        // Previously: any throw killed MCP boot before server.connect(), leaving
        // a dead server with no diagnostics. Degrade instead: keep going, surface
        // the failure through memory_doctor. stderr only — stdout is JSON-RPC.
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ registrar: register.name, error: message });
        process.stderr.write(
          `[mnemosyne-mcp] tool registrar ${register.name} failed: ${message}\n`
        );
      }
    }
  } finally {
    if (previous) Object.defineProperty(server, "registerTool", previous);
    else Reflect.deleteProperty(server, "registerTool");
  }
  compactListedTools(server);
  return probe;
}
