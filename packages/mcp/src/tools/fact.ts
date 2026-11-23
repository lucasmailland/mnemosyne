import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { FACT_TOOL_KINDS, renderMemoryItem, type FactToolKind } from "./render-memory.js";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";

/**
 * `memory_fact` — fetch one fact in full, by id (or, with `kind`, any other
 * recallable record: the escalation every truncated recall hit points at).
 *
 * P67. This is the second half of compact recall, and it had to ship with it:
 * `memory_recall` can now return 300-character previews marked `truncated: true`
 * so an agent spends tokens only on what it will actually use — and until this
 * tool existed there was NO way to get the rest from MCP. Truncating without an
 * escalation path is not an optimisation, it is data loss with extra steps.
 *
 * There was no by-id read on the MCP surface at all before this:
 * "show me that one, completely" was not among the tools.
 */
/** Ids of decisions start with `mdec_` (or `dec_`); facts with `mfact_` (or `fact_`). */
function kindFromId(id: string): "fact" | "decision" | undefined {
  if (/^(mdec|dec)_/.test(id)) return "decision";
  if (/^(mfact|fact)_/.test(id)) return "fact";
  return undefined;
}

/**
 * APP-019a: recall returns closed facts (`asOf`, a superseded hit), and the
 * server answers 404 for one unless `includeClosed` is sent. Decisions are
 * asked for the same way.
 */
const getFact = (client: MnemosyneClient, id: string) =>
  client.getFact(id, undefined, { includeClosed: true });
const getDecision = (client: MnemosyneClient, id: string) =>
  client.getDecision(id, undefined, { includeClosed: true });

/**
 * APP-019b: compact recall truncates every kind, and the default `core` profile
 * serves none of the per-kind tools, so this tool opens any of them by id.
 */
type Kind = FactToolKind;
const OTHER_KINDS: Record<
  Exclude<Kind, "fact" | "decision">,
  (c: MnemosyneClient, id: string) => Promise<unknown>
> = {
  strategy: (c, id) => c.getStrategy(id),
  workflow: (c, id) => c.getWorkflow(id),
  skill: (c, id) => c.getSkill(id),
  episode: (c, id) => c.getEpisode(id),
  task: (c, id) => c.getTask(id),
  event: (c, id) => c.getEvent(id),
  reasoning: (c, id) => c.getReasoning(id),
  entity: (c, id) => c.getEntity(id),
};

/**
 * A closed record must not read as current knowledge. Only facts and decisions
 * use `status` for closure; a task's `completed` or a skill's lifecycle is not.
 */
function closedNote(item: unknown, kind: Kind | undefined, locale: Locale): string {
  const { status, validTo } = (item ?? {}) as { status?: unknown; validTo?: unknown };
  const statusClosed =
    (kind === undefined || kind === "fact" || kind === "decision") &&
    (status ?? "active") !== "active";
  const closed = (validTo !== undefined && validTo !== null) || statusClosed;
  return closed
    ? `\n${t(locale, "out.memory_fact.closed", { status: String(status ?? "closed"), validTo: String(validTo ?? "-") })}`
    : "";
}

/**
 * AGENTSIM-6: agents pass a decision id without `kind` and got a 404. An explicit
 * kind is honoured as given; otherwise the id prefix decides, and when it does not,
 * a fact 404 is retried on the decision endpoint before reporting not found.
 */
async function fetchByIdOrKind(
  client: MnemosyneClient,
  id: string,
  kind: Kind | undefined
): Promise<unknown> {
  if (kind === "decision") return getDecision(client, id);
  if (kind === "fact") return getFact(client, id);
  if (kind !== undefined) return OTHER_KINDS[kind](client, id);
  const inferred = kindFromId(id);
  if (inferred === "decision") return getDecision(client, id);
  try {
    return await getFact(client, id);
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (inferred === "fact" || status !== 404) throw err;
    try {
      return await getDecision(client, id);
    } catch {
      throw err;
    }
  }
}

export function registerFact(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_fact",
    {
      title: "Get a fact by id",
      inputSchema: {
        factId: z
          .string()
          .min(1, d("fields.memory_fact.factIdRequired"))
          .describe(d("fields.memory_fact.factId")),
        kind: z.enum(FACT_TOOL_KINDS).optional().describe(d("fields.memory_fact.kind")),
      },
    },
    async ({ factId, kind }) => {
      try {
        const fact = await fetchByIdOrKind(client, factId, kind);
        return {
          content: [
            {
              type: "text" as const,
              text: renderMemoryItem(fact, locale) + closedNote(fact, kind, locale),
            },
          ],
          structuredContent: fact as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_fact", err, locale);
      }
    }
  );
}
