import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import type { Locale } from "@mnemo-ai/types";
import { registerAllTools } from "../registry.js";
import { en } from "../i18n/en.js";
import { es } from "../i18n/es.js";

type Result = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

/** Every tool's handler, registered in `locale` against `client`. */
function handlers(client: Record<string, unknown>, locale?: Locale): Map<string, Handler> {
  const server = new McpServer({ name: "i18n-outputs", version: "0.0.0" });
  const out = new Map<string, Handler>();
  const orig = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    (name: string, config: unknown, cb: unknown) => {
      out.set(name, cb as Handler);
      return orig(name, config as Parameters<typeof orig>[1], cb as Parameters<typeof orig>[2]);
    }
  );
  registerAllTools(server, client as unknown as MnemosyneClient, locale);
  return out;
}

async function text(tool: string, args: Record<string, unknown>, locale?: Locale, client = {}) {
  const r = await handlers(client, locale).get(tool)!(args);
  return r;
}

function leaves(node: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") out.set(path, node);
  else
    for (const [k, v] of Object.entries(node as object))
      for (const [p, s] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, s);
  return out;
}

const SPANISH = / (el|la|los|las|que|del|para|por|con|una|se) |[áéíóúñ¿¡]/i;
const VOS =
  /(?<!\p{L})(vos|tenés|podés|usá|elegí|pasá|revisá|mirá|fijate|sos|querés|hacé|tomá|ponés|dale|quitalo|pedile|iniciá|necesitás)(?!\p{L})/iu;
const TOKEN = /[a-z]+_[a-z_]+|[a-z]+[A-Z]\w*|\d{2,}|`[^`]+`|'[\w/|-]+'|\{\w+\}/g;
const WS = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.restoreAllMocks());

describe("tool output dictionary", () => {
  const enOut = leaves(en.out);
  const esOut = leaves(es.out);

  it("en and es have the same keys", () => {
    expect([...esOut.keys()]).toEqual([...enOut.keys()]);
  });

  it("en is English, es is tú Spanish that differs from it", () => {
    for (const [k, s] of enOut) {
      expect(` ${s} `, k).not.toMatch(SPANISH);
      expect(esOut.get(k), k).not.toMatch(VOS);
    }
    expect([...esOut.values()].filter((s, i) => s === [...enOut.values()][i])).toEqual([]);
  });

  it("es keeps every placeholder, identifier and quoted value", () => {
    for (const [k, s] of enOut)
      for (const tok of s.match(TOKEN) ?? []) expect(esOut.get(k), `${k}: ${tok}`).toContain(tok);
  });

  it("the voseo guard has teeth", () => {
    expect("Quitalo o usá action='create'.").toMatch(VOS);
    expect("Si necesitás escribir, iniciá una sesión").toMatch(VOS);
  });
});

describe("no tool hard-codes text for the agent", () => {
  const dir = fileURLToPath(new URL("../tools/", import.meta.url));
  const code = (f: string) =>
    readFileSync(dir + f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s", (f) => {
    const src = code(f);
    expect(src).not.toMatch(/[áéíóúñ¿¡]/);
    expect(src).not.toMatch(/errorOut\(\s*["'`]/);
    expect(src).not.toMatch(/\btext:\s*["'`]/);
    expect(src).not.toMatch(/throw new Error\(\s*["'`]/);
    expect(src).not.toMatch(/(Message|message):\s*["'][A-Z]/);
  });
});

describe("tool outputs follow MNEMO_LOCALE", () => {
  const wsArgs = { action: "list", targetWorkspaceId: WS };
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    [
      "memory_skill",
      wsArgs,
      "targetWorkspaceId only applies to action='create'.",
      "targetWorkspaceId solo se aplica con action='create'.",
    ],
    [
      "memory_workflow",
      wsArgs,
      "targetWorkspaceId only applies to action='create'.",
      "targetWorkspaceId solo se aplica con action='create'.",
    ],
    [
      "memory_remind_when",
      wsArgs,
      "targetWorkspaceId only applies to action='create'.",
      "targetWorkspaceId solo se aplica con action='create'.",
    ],
    [
      "memory_strategy",
      { op: "list", targetWorkspaceId: WS },
      "targetWorkspaceId only applies to op='create'/'store'.",
      "targetWorkspaceId solo se aplica con op='create'/'store'.",
    ],
    [
      "memory_task",
      { action: "get" },
      "get requires `id`.",
      "get requires `id`.".replace("requires", "requiere"),
    ],
    [
      "memory_session",
      { action: "collapse" },
      "collapse requires `sessionId`.",
      "collapse requiere `sessionId`.",
    ],
    [
      "memory_forget",
      {},
      "memory_forget failed: primitiveId (or factId for facts) is required.",
      "memory_forget falló: primitiveId (o factId para hechos) es obligatorio.",
    ],
  ];

  it.each(cases)("%s", async (tool, args, english, spanish) => {
    const enR = await text(tool, args);
    const esR = await text(tool, args, "es-419");
    expect(enR.isError).toBe(true);
    expect(enR.content[0]!.text).toBe(english);
    expect(esR.content[0]!.text).toBe(spanish);
  });

  it("memory_context notes are English by default and tú Spanish in es-419", async () => {
    const client = {
      getMe: async () => ({ workspaceId: WS, workspaceRole: "read" }),
      getStats: async () => null,
      listMyWorkspaces: async () => [],
      listWorkspacesForCurrentTenant: async () => [],
    };
    const enR = await text("memory_context", {}, undefined, client);
    const esR = await text("memory_context", {}, "es-419", client);
    expect(enR.structuredContent?._note).toBe(en.out.memory_context.note);
    expect(enR.structuredContent?._roleNote).toBe(en.out.memory_context.roleNote);
    expect(esR.structuredContent?._note).toBe(es.out.memory_context.note);
    expect(esR.structuredContent?._roleNote).toBe(es.out.memory_context.roleNote);
  });

  it("a server error keeps its codes and says 'failed' in the locale", async () => {
    const boom = Object.assign(new Error("nope"), { status: 404, code: "not_found" });
    const client = { getSkill: async () => Promise.reject(boom) };
    const enR = await text("memory_skill", { action: "get", id: "s1" }, undefined, client);
    const esR = await text("memory_skill", { action: "get", id: "s1" }, "es-419", client);
    expect(enR.content[0]!.text).toBe(
      "memory_skill failed: nope (status=404, code=not_found, retryable=false)"
    );
    expect(esR.content[0]!.text).toBe(
      "memory_skill falló: nope (status=404, code=not_found, retryable=false)"
    );
  });

  it("recall's untrusted-data banner follows the locale", async () => {
    const client = { recall: async () => ({ hits: [] }) };
    const enR = await text("memory_recall", { query: "q" }, undefined, client);
    const esR = await text("memory_recall", { query: "q" }, "es-419", client);
    expect(enR.content[0]!.text).toBe(en.out.untrusted);
    expect(esR.content[0]!.text).toBe(es.out.untrusted);
  });
});
