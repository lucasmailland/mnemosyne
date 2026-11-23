import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { z } from "zod";
import type { Locale } from "@mnemo-ai/types";
import { registerAllTools } from "../registry.js";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";

type Fields = Record<string, z.ZodType>;

/** Registers every tool in `locale` and captures each tool's input-schema fields. */
function capture(locale?: Locale): Map<string, Fields> {
  const server = new McpServer({ name: "i18n-fields", version: "0.0.0" });
  const out = new Map<string, Fields>();
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: unknown) => {
      out.set(name, (config as { inputSchema?: Fields }).inputSchema ?? {});
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerAllTools(server, {} as MnemosyneClient, locale);
  return out;
}

function described(locale?: Locale): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [tool, fields] of capture(locale)) {
    const m = new Map<string, string>();
    for (const [field, schema] of Object.entries(fields))
      if (schema.description !== undefined) m.set(field, schema.description);
    out.set(tool, m);
  }
  return out;
}

const SPANISH_EN_LEAK =
  / (el|la|los|las|que|de los|del|para|por|con|una|se) |[áéíóúñ¿¡]|\b(usá|podés|tenés|querés|obtené|pasá|omitilo)\b/i;
const VOS =
  /(?<!\p{L})(vos|tenés|podés|usá|elegí|pasá|revisá|mirá|fijate|sos|querés|hacé|tomá|ponés|dale|obtené|omitilo|filtrá|pedís|pegá|sacalo|pasalo|usalo|enviás|combiná|trabajás|intentás|necesitás|mandá|dejá|recordá|incluí|guardá)(?!\p{L})/iu;
// ids, camelCase names, numbers and protocol acronyms must survive translation.
const TOKEN =
  /[a-z]+_[a-z_]+|[a-z]+[A-Z]\w*|\d{2,}|\b(?:HTTP|ISO|UUID|FTS|LLM|DSL|GET|POST|PATCH|AND)\b/g;

afterEach(() => vi.restoreAllMocks());

describe("MCP field descriptions (every tool)", () => {
  const base = described();
  const spanish = described("es-419");

  it("covers every tool with descriptions", () => {
    expect(base.size).toBe(37);
    let total = 0;
    for (const fields of base.values()) total += fields.size;
    expect(total).toBeGreaterThanOrEqual(190);
  });

  it("en and es describe exactly the same fields, all non-empty", () => {
    for (const [tool, fields] of base) {
      const es419 = spanish.get(tool)!;
      expect([...es419.keys()], tool).toEqual([...fields.keys()]);
      for (const [field, text] of fields) {
        expect(text.trim(), `${tool}.${field} en`).not.toBe("");
        expect(es419.get(field)!.trim(), `${tool}.${field} es`).not.toBe("");
      }
    }
  });

  it("en has no Spanish", () => {
    for (const [tool, fields] of base)
      for (const [field, text] of fields)
        expect(` ${text} `, `${tool}.${field}`).not.toMatch(SPANISH_EN_LEAK);
  });

  it("es differs from en and has no voseo", () => {
    for (const [tool, fields] of base)
      for (const [field, text] of fields) {
        const es419 = spanish.get(tool)!.get(field)!;
        expect(es419, `${tool}.${field}`).not.toBe(text);
        expect(es419, `${tool}.${field}`).not.toMatch(VOS);
      }
    expect(JSON.stringify(es.fields)).not.toMatch(VOS);
  });

  it("es keeps every code-like token and number of the English text", () => {
    for (const [tool, fields] of base)
      for (const [field, text] of fields)
        for (const tok of text.match(TOKEN) ?? [])
          expect(spanish.get(tool)!.get(field)!, `${tool}.${field}: ${tok}`).toContain(tok);
  });

  it("disclosure needles survive in both languages", () => {
    const needles: Record<string, string[]> = {
      "memory_consolidate.mode": ["deep", "422"],
      "memory_consolidate.dryRun": ["dryRun", "422"],
      "memory_event.action": ["NO-OP", "archived:false", "immutable:true", "422"],
      "memory_recall.projection": ["compact", "full", "truncated: true", "memory_fact"],
      "memory_recall.sessionId": ["lastRecallAt", "memory_session"],
      "memory_remember.scope": ["mns_live_", "scope personal requires a user-bound key"],
      "memory_remember.sessionId": ["memory_episode_start", "memory_episode_end"],
      "memory_decide.topicKey": ["Auth-Strategy", "auth-strategy", "topicKey"],
      "memory_judge.resolution": ["supersede_a", "supersede_b", "keep_both", "mergedStatement"],
      "memory_relate.action": ["supersedes", "derived_from"],
      "memory_session.sessionId": ["turn", "pin_turn", "collapse", "feedback"],
      "memory_skill.targetWorkspaceId": ["memory_context", "action='create'", "write/admin"],
      "memory_strategy.targetWorkspaceId": ["memory_context", "op='create'/'store'", "write/admin"],
      "memory_task.targetWorkspaceId": ["memory_context", "action='create'", "write/admin"],
      "memory_workflow.targetWorkspaceId": ["memory_context", "action='create'", "write/admin"],
      "memory_workspace.action": ["set_role", "current", "describe"],
      "memory_workspace.tenantId": ["GET /me"],
      "memory_update.sessionId": ["memory_session/episode_start", "5"],
      "memory_self_edit.sessionId": ["memory_session/episode_start", "5"],
      "memory_suggest_topic_key.attribute": ["subject + attribute", "deploy method"],
    };
    for (const [path, list] of Object.entries(needles)) {
      const [tool, field] = path.split(".") as [string, string];
      for (const [label, dict] of [
        ["en", base],
        ["es", spanish],
      ] as const)
        for (const n of list) expect(dict.get(tool)!.get(field), `${label} ${path}`).toContain(n);
    }
  });

  it("tool names and parameter names do not change with the locale", () => {
    const a = capture();
    const b = capture("es-419");
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [tool, fields] of a)
      expect(Object.keys(b.get(tool)!), tool).toEqual(Object.keys(fields));
  });
});

describe("MCP validation messages by locale", () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["memory_recall", { query: "" }, "query must not be empty", "query no puede estar vacío"],
    ["memory_pin", { factId: "" }, "factId is required", "factId es obligatorio"],
    [
      "memory_decide",
      { title: "", body: "x", kind: "decision" },
      "title must not be empty",
      "title no puede estar vacío",
    ],
    [
      "memory_remember",
      { statement: "" },
      "statement must be between 1 and 1000 characters",
      "statement debe tener entre 1 y 1000 caracteres",
    ],
    [
      "memory_remind_when",
      { action: "create", content: "" },
      "content must not be empty",
      "content no puede estar vacío",
    ],
    ["memory_search", { query: "" }, "query must not be empty", "query no puede estar vacío"],
    [
      "memory_update",
      { factId: "", statement: "x" },
      "factId is required",
      "factId es obligatorio",
    ],
  ];
  it.each(cases)("%s", (tool, input, enMsg, esMsg) => {
    for (const [locale, want] of [
      [undefined, enMsg],
      ["es-419" as Locale, esMsg],
    ] as const) {
      const fields = capture(locale).get(tool)!;
      const r = z.object(fields).safeParse(input);
      expect(r.success).toBe(false);
      expect(
        r.error!.issues.map((i) => i.message),
        `${tool} ${locale}`
      ).toContain(want);
    }
  });
});

describe("tool registrars carry no description of their own", () => {
  it("the registry supplies every tool description (no dead vos text in src/tools)", () => {
    const dir = fileURLToPath(new URL("../tools/", import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")))
      expect(readFileSync(dir + f, "utf8"), f).not.toMatch(/^ {6}description:/m);
  });
});
