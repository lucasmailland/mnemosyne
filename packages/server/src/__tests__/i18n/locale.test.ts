import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { compileTemplates, matchTemplate } from "@mnemo-ai/types";
import { en, FOREIGN } from "../../i18n/error-templates.en.js";
import { es } from "../../i18n/error-templates.es.js";
import { localeMiddleware } from "../../i18n/locale.js";
import { authed, buildApp, reqId } from "./_app.js";

let app: Hono;
beforeAll(async () => {
  app = await buildApp();
});

const asEs = { "accept-language": "es-419" };
const get = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...reqId, ...authed, ...headers } });
type Env = { error: { message: string; [k: string]: unknown } };

describe("Spanish error bodies under Accept-Language: es-419", () => {
  it.each([
    ["bad", "Solicitud incorrecta"],
    ["unauthorized", "No autorizado"],
    ["forbidden", "Prohibido"],
    ["notfound", "No encontrado"],
    ["conflict", "Conflicto"],
    ["ratelimited", "Demasiadas solicitudes"],
    ["unprocessable", "Entidad no procesable"],
    ["unavailable", "Servicio no disponible"],
    ["internal", "Error interno del servidor"],
    ["notimpl", "No implementado"],
    ["storage", "La entidad e-1 ya está cerrada"],
    [
      "breaker",
      "Una dependencia no está disponible temporalmente. Vuelve a intentarlo más tarde; la solicitud no se intentó.",
    ],
  ])("%s: the message is Spanish, everything else is identical", async (name, spanish) => {
    const english = (await (await get(`/__t/${name}`)).json()) as Env;
    const body = (await (await get(`/__t/${name}`, asEs)).json()) as Env;
    expect(body.error.message).toBe(spanish);
    expect({ ...body.error, message: "" }).toEqual({ ...english.error, message: "" });
  });

  it("an unmatched message stays English", async () => {
    const body = (await (await get("/__t/custom", asEs)).json()) as Env;
    expect(body.error.message).toBe("A message nobody translated");
  });

  it("zod: top message translated, issues untouched", async () => {
    const res = await get("/conflicts/x/resolve", asEs, { method: "POST", body: "{}" });
    const body = (await res.json()) as Env & { error: { details: { issues: unknown[] } } };
    expect(res.status).toBe(400);
    expect(body.error.message).toBe(
      'action: Opción no válida: se esperaba una de "supersede_a"|"supersede_b"|"keep_both"|"merge"'
    );
    expect(body.error.details.issues).toEqual([
      {
        path: "action",
        message: 'Invalid option: expected one of "supersede_a"|"supersede_b"|"keep_both"|"merge"',
        code: "invalid_value",
      },
    ]);
  });

  it("zod: a missing field, a too-short and a too-long value, a bad format — all Spanish", async () => {
    const remember = (body: unknown) =>
      get(
        "/remember",
        { ...asEs, "content-type": "application/json" },
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
    const message = async (res: Response) => ((await res.json()) as Env).error.message;
    expect(await message(await remember({}))).toBe("statement: Obligatorio");
    expect(await message(await remember({ statement: "" }))).toBe(
      "statement: Demasiado corto: se esperaban >=1 caracteres"
    );
    expect(await message(await get("/conflicts?limit=50", asEs))).toBe(
      "limit: Valor demasiado grande: se esperaba <=20"
    );
    expect(await message(await remember({ statement: "x", targetWorkspaceId: "not-a-guid" }))).toBe(
      "targetWorkspaceId: GUID no válido"
    );
  });

  it("the 413 body limit", async () => {
    const res = await get(
      "/conflicts/x/resolve",
      { ...asEs, "content-length": "2097152" },
      { method: "POST", body: "{}" }
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Env).error.message).toBe(
      "El cuerpo de la solicitud supera el límite de 1 MB"
    );
  });

  it("the 401 from the bearer middleware (no credentials)", async () => {
    const res = await app.request("/facts", { headers: { ...reqId, ...asEs } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Env).error.message).toBe("Falta el token de portador");
  });

  it("the flat dashboard-auth body: message translated, error key untouched", async () => {
    const res = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...asEs },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_json",
      message: "El cuerpo de la solicitud debe ser JSON válido",
    });
  });
});

describe("locale choice", () => {
  const msg = async (headers: Record<string, string>) =>
    ((await (await get("/__t/notfound", headers)).json()) as Env).error.message;

  it("the mnemo_locale cookie wins over Accept-Language", async () => {
    expect(await msg({ cookie: "mnemo_locale=es-419", "accept-language": "en-US" })).toBe(
      "No encontrado"
    );
    const back = await get("/__t/notfound", {
      cookie: "mnemo_locale=en-US",
      "accept-language": "es-419",
    });
    expect(((await back.json()) as Env).error.message).toBe("Not found");
    expect(back.headers.get("Content-Language")).toBe("en-US");
  });

  it("an unknown cookie value falls back to Accept-Language", async () => {
    expect(await msg({ cookie: "mnemo_locale=klingon", ...asEs })).toBe("No encontrado");
  });

  it("no choice is English", async () => {
    expect(await msg({})).toBe("Not found");
  });
});

describe("headers and pass-through", () => {
  it("sets Content-Language and Vary on every 4xx/5xx JSON response, English too", async () => {
    for (const [headers, lang] of [
      [{}, "en-US"],
      [asEs, "es-419"],
    ] as const) {
      const res = await get("/__t/notfound", headers);
      expect(res.headers.get("Content-Language")).toBe(lang);
      expect(res.headers.get("Vary")).toBe("Accept-Language, Cookie");
      expect(res.headers.get("x-request-id")).toBe("req-i18n-1");
    }
  });

  it("Content-Language names the language the message is in: es-419 only when translated", async () => {
    const translated = await get("/__t/notfound", asEs);
    expect(translated.headers.get("Content-Language")).toBe("es-419");
    // asked for Spanish, but no template matched: the body is English, so is the header
    const unmatched = await get("/__t/custom", asEs);
    expect(((await unmatched.json()) as Env).error.message).toBe("A message nobody translated");
    expect(unmatched.headers.get("Content-Language")).toBe("en-US");
    expect(unmatched.headers.get("Vary")).toBe("Accept-Language, Cookie");
  });

  it("a body over 64 KiB passes through untranslated, headers still set", async () => {
    const h = new Hono();
    h.use("*", localeMiddleware);
    const body = JSON.stringify({ error: { message: "Not found", pad: "x".repeat(64 * 1024) } });
    h.get(
      "/big",
      () =>
        new Response(body, {
          status: 404,
          headers: { "content-type": "application/json", "content-length": String(body.length) },
        })
    );
    const res = await h.request("/big", { headers: asEs });
    expect(await res.text()).toBe(body);
    expect(res.headers.get("Content-Language")).toBe("en-US");
    expect(res.headers.get("Vary")).toBe("Accept-Language, Cookie");
  });

  it("appends to an existing Vary without clobbering it or repeating", async () => {
    const h = new Hono();
    h.use("*", localeMiddleware);
    h.get("/v", (c) => {
      c.header("Vary", "Origin, cookie");
      return c.json({ error: { message: "Not found" } }, 404);
    });
    const res = await h.request("/v");
    expect(res.headers.get("Vary")).toBe("Origin, cookie, Accept-Language");
  });

  it("English bodies are passed through byte for byte", async () => {
    expect(await (await get("/__t/bad")).text()).toBe(
      '{"error":{"type":"invalid_request_error","code":"bad_request","message":"Bad request","param":"x","details":{"field":"x"},"request_id":"req-i18n-1","retryable":false}}'
    );
  });

  it("a non-JSON 4xx/5xx and a 2xx JSON pass through untouched", async () => {
    const text = await get("/__t/text", asEs);
    expect(await text.text()).toBe("plain failure");
    expect(text.headers.get("Content-Language")).toBeNull();
    const ok = await get("/__t/okjson", asEs);
    expect(await ok.json()).toEqual({ error: { message: "Not found" } });
    expect(ok.headers.get("Content-Language")).toBeNull();
  });

  it("an unparseable JSON error body passes through untouched", async () => {
    const h = new Hono();
    h.use("*", localeMiddleware);
    h.get(
      "/bad",
      () =>
        new Response("{not json", { status: 500, headers: { "content-type": "application/json" } })
    );
    const res = await h.request("/bad", { headers: asEs });
    expect(await res.text()).toBe("{not json");
    expect(res.headers.get("Content-Language")).toBeNull();
  });

  it("only application/json and +json bodies are rewritten", async () => {
    const h = new Hono();
    h.use("*", localeMiddleware);
    const body = '{"error":{"message":"Not found"}}';
    for (const [path, type, translated] of [
      ["/a", "application/json; charset=utf-8", true],
      ["/b", "application/problem+json", true],
      ["/c", "application/x-ndjson", false],
      ["/d", "text/json-seq", false],
    ] as const)
      h.get(path, () => new Response(body, { status: 404, headers: { "content-type": type } }));
    for (const [path, , translated] of [
      ["/a", "", true],
      ["/b", "", true],
      ["/c", "", false],
      ["/d", "", false],
    ] as const) {
      const res = await h.request(path, { headers: asEs });
      expect(((await res.json()) as Env).error.message === "No encontrado", path).toBe(translated);
    }
  });

  it("HEAD is left alone", async () => {
    const res = await app.request("/__t/notfound", {
      method: "HEAD",
      headers: { ...authed, ...asEs },
    });
    expect(res.headers.get("Content-Language")).toBeNull();
  });
});

describe("the Spanish rebuild keeps the response's headers", () => {
  it("Set-Cookie twice, Retry-After, WWW-Authenticate, status and statusText survive", async () => {
    const h = new Hono();
    h.use("*", localeMiddleware);
    h.get("/h", (c) => {
      const headers = new Headers({
        "content-type": "application/json",
        "retry-after": "30",
        "www-authenticate": 'Bearer realm="mnemo"',
      });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/; Secure");
      return new Response('{"error":{"message":"Not found","code":"x"}}', {
        status: 429,
        statusText: "Slow Down",
        headers,
      });
    });
    const res = await h.request("/h", { headers: asEs });
    expect(res.status).toBe(429);
    expect(res.statusText).toBe("Slow Down");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"]);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="mnemo"');
    expect(res.headers.get("content-language")).toBe("es-419");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { message: "No encontrado", code: "x" } });
    const len = res.headers.get("content-length");
    if (len !== null) expect(Number(len)).toBe(new TextEncoder().encode(text).length);
  });
});

describe("malformed locale input falls back to en-US without throwing", () => {
  it.each([
    ["a bare token cookie", { cookie: "mnemo_locale" }],
    ["an empty cookie value", { cookie: "mnemo_locale=" }],
    ["garbage cookies", { cookie: ";;; =x; mnemo_locale=%E0%A4%A; ===" }],
    ["a q that is not a number", { "accept-language": "es;q=abc" }],
    ["a wildcard", { "accept-language": "*" }],
    ["an empty Accept-Language", { "accept-language": "" }],
    ["only separators", { "accept-language": ",;,;q=" }],
  ])("%s", async (_name, headers) => {
    const res = await get("/__t/notfound", headers);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Language")).toBe("en-US");
    expect(((await res.json()) as Env).error.message).toBe("Not found");
  });
});

describe("the tables", () => {
  const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("es has the keys of en, and only placeholders en captures", () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    // A translation may leave a captured value out (zod's English type name in
    // zod_required), never use one the English does not capture.
    for (const k of Object.keys(en) as (keyof typeof en)[])
      for (const name of names(es[k])) expect(names(en[k]), k).toContain(name);
  });

  it("no Spanish message carries one of zod's English type names", () => {
    for (const [k, text] of Object.entries(es))
      if (k.startsWith("zod_"))
        expect(text, k).not.toMatch(/\b(string|number|array|boolean|object|undefined|expected)\b/);
  });

  it("every English template is matched by itself first", () => {
    const compiled = compileTemplates(en);
    for (const [k, text] of Object.entries(en)) {
      const probe = text.replace(/\{(\w+)\}/g, "VALUE");
      expect(matchTemplate(compiled, probe)?.key, k).toBe(k);
    }
  });

  it("foreign keys exist", () => {
    for (const k of FOREIGN) expect(en).toHaveProperty(k);
  });

  it("the Spanish table has no vos forms", () => {
    const vos =
      /(?<!\p{L})(usá|tenés|podés|hacé|elegí|querés|sabés|poné|decí|vení|usás|hacés|sos|vos)(?!\p{L})/iu;
    for (const [k, text] of Object.entries(es)) expect(text, k).not.toMatch(vos);
    // teeth: accented voseo forms are caught (a `\b` boundary missed them)
    expect("Usá la opción").toMatch(vos);
    expect("Elegí uno").toMatch(vos);
  });
});
