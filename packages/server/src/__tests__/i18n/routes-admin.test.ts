/**
 * One localized body per administration route file. Most of these routes need
 * a database, a tenant or a user session to answer, so each case replays the
 * body the route builds (same status, code/type/param/details) behind the real
 * locale middleware, and checks that the English literal is still in the route
 * source: if a route's text changes, this fails before the table silently
 * stops matching. dashboard-auth also goes through the real app.
 */
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { localeMiddleware } from "../../i18n/locale.js";
import { buildApp, reqId } from "./_app.js";

const SRC = new URL("../../", import.meta.url);
const asEs = { "accept-language": "es-419" };

type Body = Record<string, unknown>;
const flat = (error: string, message: string): Body => ({ error, message });
const nested = (code: string, message: string): Body => ({
  error: { type: "invalid_request_error", code, message, param: "p", details: { d: 1 } },
});
const messageOf = (b: Body) =>
  (typeof b.error === "object" ? (b.error as Body).message : b.message) as string;

async function ask(body: Body, status: number, headers: Record<string, string>) {
  const app = new Hono();
  app.use("*", localeMiddleware);
  app.get("/r", (c) => c.json(body, status as 400));
  const res = await app.request("/r", { headers });
  return (await res.json()) as Body;
}

// [route file, english literal as it appears in the source, shape, status, spanish]
const CASES: [string, string, "flat" | "nested", number, string][] = [
  ["routes/tenants.ts", "Tenant not found", "flat", 404, "No se encontró el tenant"],
  [
    "routes/tenants.ts",
    "Workspace owner or admin role required",
    "nested",
    403,
    "Se requiere el rol de propietario o administrador del espacio de trabajo",
  ],
  ["routes/instance.ts", "Invalid password.", "flat", 401, "Contraseña incorrecta."],
  [
    "routes/bootstrap.ts",
    "Setup token is invalid or has expired.",
    "flat",
    403,
    "El token de configuración no es válido o expiró.",
  ],
  [
    "routes/dashboard-auth.ts",
    "Invalid email or password.",
    "flat",
    401,
    "Correo electrónico o contraseña incorrectos.",
  ],
  [
    "routes/dashboard-links.ts",
    "This link is invalid or has expired.",
    "flat",
    404,
    "Este enlace no es válido o expiró.",
  ],
  [
    "routes/dashboard-api.ts",
    "Authentication service unavailable",
    "flat",
    503,
    "Servicio de autenticación no disponible",
  ],
  [
    "routes/my-workspaces.ts",
    "Sign in with your email and password.",
    "flat",
    403,
    "Inicia sesión con tu correo electrónico y tu contraseña.",
  ],
  [
    "routes/workspace-members.ts",
    "Invitations are turned off for this installation.",
    "flat",
    403,
    "Las invitaciones están desactivadas en esta instalación.",
  ],
  [
    "workspace-target.ts",
    "User is not a write member of the target workspace",
    "flat",
    403,
    "El usuario no es miembro con permiso de escritura del espacio de trabajo de destino",
  ],
  [
    "routes/keys.ts",
    "Key is already revoked and cannot be rotated",
    "flat",
    409,
    "La clave de API ya está revocada y no se puede rotar",
  ],
  [
    "routes/user-tokens.ts",
    "Target user is not a member of this tenant",
    "flat",
    404,
    "El usuario de destino no es miembro de este tenant",
  ],
  [
    "routes/federation.ts",
    "workspace not in JWT scope",
    "nested",
    403,
    "el espacio de trabajo no está dentro del alcance del JWT",
  ],
  [
    "routes/approvals.ts",
    "status must be approved|denied",
    "nested",
    400,
    "status debe ser approved|denied",
  ],
  [
    "routes/consolidation.ts",
    "Storage adapter is not wired into ServerDeps.",
    "nested",
    503,
    "El adaptador de almacenamiento no está conectado a ServerDeps. Instala @mnemo-ai/adapter-postgres y reinicia el servidor.",
  ],
];

describe("administration routes: Spanish message, everything else unchanged", () => {
  it.each(CASES)("%s: %s", async (file, literal, shape, status, spanish) => {
    expect(readFileSync(new URL(file, SRC), "utf8")).toContain(literal);
    // the full text, joined as the route joins it
    const english = fullText[`${file}|${literal}`] ?? literal;
    const make = shape === "flat" ? flat("some_code", english) : nested("some_code", english);
    const es = await ask(make, status, asEs);
    expect(messageOf(es)).toBe(spanish);
    const en = await ask(make, status, {});
    expect(messageOf(en)).toBe(english);
    const strip = (b: Body) =>
      JSON.stringify(
        typeof b.error === "object"
          ? { error: { ...(b.error as Body), message: 0 } }
          : { ...b, message: 0 }
      );
    expect(strip(es)).toBe(strip(en));
  });
});

const fullText: Record<string, string> = {
  "routes/consolidation.ts|Storage adapter is not wired into ServerDeps.":
    "Storage adapter is not wired into ServerDeps. Install @mnemo-ai/adapter-postgres and restart the server.",
};

describe("templates with captured values", () => {
  it.each([
    ["Unknown scope(s): a:b, c:d", "Permisos desconocidos: a:b, c:d"],
    [
      "Cannot grant scopes the caller doesn't have: admin:x",
      "No se pueden conceder permisos que el solicitante no tiene: admin:x",
    ],
    [
      "Cannot grant a sensitivity ceiling above the caller's own (internal)",
      "No se puede conceder un nivel máximo de sensibilidad superior al del solicitante (internal)",
    ],
    ["Peer 'p-1' not found", "No se encontró el nodo par 'p-1'"],
    ["Sync job 'j-9' not found", "No se encontró la tarea de sincronización 'j-9'"],
    ["approval already approved", "la aprobación ya tiene el estado approved"],
  ])("%s", async (english, spanish) => {
    expect(messageOf(await ask(nested("c", english), 400, asEs))).toBe(spanish);
  });
});

describe("through the real app", () => {
  it("dashboard-auth: the 503 flat body", async () => {
    const app = await buildApp();
    const res = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: {
        ...reqId,
        "content-type": "application/json",
        origin: "http://localhost",
        ...asEs,
      },
      body: JSON.stringify({ email: "a@b.co", password: "x" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "auth_unavailable",
      message: "Servicio de autenticación no disponible",
    });
  });
});
