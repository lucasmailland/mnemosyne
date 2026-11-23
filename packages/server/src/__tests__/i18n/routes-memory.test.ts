/**
 * One localized body per memory route family. Like routes-admin.test.ts, most
 * of these routes need storage and a key to answer, so each case replays the
 * body the route builds (same status, code, param, details) behind the real
 * locale middleware and checks that the English text is still in the route
 * source: if a route's text changes, this fails before the table silently
 * stops matching (the drift guard checks the same against the whole table).
 * audit has no message of its own; it goes through the real app.
 */
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { localeMiddleware } from "../../i18n/locale.js";
import { buildApp, reqId } from "./_app.js";

const SRC = new URL("../../", import.meta.url);
const asEs = { "accept-language": "es-419" };

type Body = Record<string, unknown>;
const nested = (code: string, message: string, status: number, param?: string): Body => ({
  error: {
    type: status === 404 ? "not_found_error" : "invalid_request_error",
    code,
    message,
    ...(param ? { param } : {}),
    details: { d: 1 },
    retryable: false,
  },
});
const messageOf = (b: Body) => (b.error as Body).message as string;

async function ask(body: Body, status: number, headers: Record<string, string>) {
  const app = new Hono();
  app.use("*", localeMiddleware);
  app.get("/r", (c) => c.json(body, status as 400));
  return (await (await app.request("/r", { headers })).json()) as Body;
}

// [family, route file, source fragment, concrete english message, status, code, spanish]
const CASES: [string, string, string, string, number, string, string][] = [
  [
    "facts",
    "routes/facts.ts",
    "No active fact ${id} in this workspace.",
    "No active fact f-1 in this workspace.",
    404,
    "not_found",
    "No hay ningún hecho activo f-1 en este espacio de trabajo.",
  ],
  [
    "decisions",
    "routes/decisions.ts",
    "Decision ${id} not found",
    "Decision d-1 not found",
    404,
    "not_found",
    "No se encontró la decisión d-1",
  ],
  [
    "entities",
    "routes/entities.ts",
    "No fields to update",
    "No fields to update",
    400,
    "bad_request",
    "No hay campos para actualizar",
  ],
  [
    "episodes",
    "routes/episodes.ts",
    "Episode ${id} not found",
    "Episode ep-1 not found",
    404,
    "not_found",
    "No se encontró el episodio ep-1",
  ],
  [
    "recall",
    "routes/recall.ts",
    "No personal workspace found for this user.",
    "No personal workspace found for this user. Register a user profile first.",
    404,
    "not_found",
    "No se encontró un espacio de trabajo personal para este usuario. Registra primero un perfil de usuario.",
  ],
  [
    "remember",
    "routes/remember.ts",
    "statement must contain non-whitespace text.",
    "statement must contain non-whitespace text.",
    400,
    "bad_request",
    "statement debe contener texto que no sea solo espacios en blanco.",
  ],
  [
    "forget",
    "routes/forget.ts",
    "${kind} ${id} not found",
    "episode ep-1 not found",
    404,
    "not_found",
    "No se encontró el elemento ep-1 (tipo: episode)",
  ],
  [
    "session",
    "routes/session.ts",
    "Session ${id} is closed for writes.",
    "Session s-1 is closed for writes.",
    409,
    "conflict",
    "La sesión s-1 está cerrada para escritura.",
  ],
  [
    "tasks",
    "routes/tasks.ts",
    "Task ${id} not found",
    "Task t-1 not found",
    404,
    "not_found",
    "No se encontró la tarea t-1",
  ],
  [
    "events",
    "routes/events.ts",
    "Events are immutable and cannot be deleted",
    "Events are immutable and cannot be deleted; forget the facts derived from them instead.",
    409,
    "event_immutable",
    "Los eventos son inmutables y no se pueden eliminar; olvida en su lugar los hechos derivados de ellos.",
  ],
  [
    "graph",
    "routes/graph.ts",
    "storage adapter not available",
    "storage adapter not available",
    400,
    "bad_request",
    "el adaptador de almacenamiento no está disponible",
  ],
  [
    "relations",
    "routes/relations.ts",
    "is not in the locked vocabulary",
    'Verb "likes" is not in the locked vocabulary. Allowed verbs: a, b.',
    400,
    "bad_request",
    'El verbo "likes" no está en el vocabulario cerrado. Verbos permitidos: a, b.',
  ],
  [
    "timeline",
    "routes/timeline.ts",
    "cursor is not a valid timeline cursor",
    "cursor is not a valid timeline cursor",
    400,
    "bad_request",
    "cursor no es un cursor de línea de tiempo válido",
  ],
  [
    "conflicts",
    "routes/conflicts.ts",
    "is not a conflicts_with relation (got: ${rel.verb})",
    "Relation r-1 is not a conflicts_with relation (got: supports)",
    400,
    "bad_request",
    "La relación r-1 no es una relación conflicts_with (se obtuvo: supports)",
  ],
];

describe("memory routes: Spanish message, everything else unchanged", () => {
  it.each(CASES)("%s", async (_family, file, fragment, english, status, code, spanish) => {
    expect(readFileSync(new URL(file, SRC), "utf8")).toContain(fragment);
    const body = nested(code, english, status, "p");
    const es = await ask(body, status, asEs);
    expect(messageOf(es)).toBe(spanish);
    expect(messageOf(await ask(body, status, {}))).toBe(english);
    expect({ ...(es.error as Body), message: 0 }).toEqual({ ...(body.error as Body), message: 0 });
  });
});

describe("audit: through the real app", () => {
  it("answers in Spanish without credentials", async () => {
    const app = await buildApp();
    const res = await app.request("/audit", { headers: { ...reqId, ...asEs } });
    expect(res.status).toBe(401);
    expect(messageOf((await res.json()) as Body)).toBe("Falta el token de portador");
    expect(res.headers.get("content-language")).toBe("es-419");
  });
});
