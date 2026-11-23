/**
 * Localizes error messages at one choke point (P2-6). A root middleware picks
 * the caller's locale (mnemo_locale cookie, then Accept-Language, then en-US)
 * and, after the route ran, rewrites `error.message` (nested) or `message`
 * (flat) of a 4xx/5xx JSON response through the template table. Throw sites
 * keep their English text; an unmatched message stays English.
 */
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  compileTemplates,
  matchTemplate,
  resolveLocale,
  translate,
  type Locale,
} from "@mnemo-ai/types";
import { en } from "./error-templates.en.js";
import { es } from "./error-templates.es.js";

export const LOCALE_COOKIE = "mnemo_locale";
/** Bigger bodies are not error envelopes worth parsing; they pass through (headers still set). */
const MAX_TRANSLATE_BYTES = 64 * 1024;
export const compiledTemplates = compileTemplates(en);

/** `message` in `locale`; the same string when no template matches. */
export function localizeMessage(message: string, locale: Locale): string {
  if (locale === "en-US") return message;
  const hit = matchTemplate(compiledTemplates, message);
  return hit ? translate(es, hit.key, hit.vars, locale) : message;
}

/** `application/json` or a `+json` suffix; not ndjson or other `json`-containing types. */
function isJson(contentType: string | null): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function addVary(headers: Headers): void {
  const have = (headers.get("Vary") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  for (const v of ["Accept-Language", "Cookie"])
    if (!have.some((h) => h.toLowerCase() === v.toLowerCase())) have.push(v);
  headers.set("Vary", have.join(", "));
}

/** The body with a translated message, or undefined when it has none to translate. */
function localizedBody(body: unknown, locale: Locale): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const e = b.error;
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { message?: unknown }).message === "string"
  ) {
    const inner = e as { message: string };
    const message = localizeMessage(inner.message, locale);
    return message === inner.message ? undefined : { ...b, error: { ...inner, message } };
  }
  if (typeof e === "string" && typeof b.message === "string") {
    const message = localizeMessage(b.message, locale);
    return message === b.message ? undefined : { ...b, message };
  }
  return undefined;
}

export const localeMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (res.status < 400 || c.req.method === "HEAD") return;
  if (!isJson(res.headers.get("content-type"))) return;

  const locale = resolveLocale([getCookie(c, LOCALE_COOKIE)], c.req.header("accept-language"));
  let body: unknown;
  const length = Number(res.headers.get("content-length"));
  if (locale !== "en-US" && !(length > MAX_TRANSLATE_BYTES)) {
    try {
      body = localizedBody(await res.clone().json(), locale);
    } catch {
      return; // not parseable: pass it through untouched
    }
  }
  // Original bytes unless a message was translated; only the headers change.
  // Hono's setter copies the old headers onto the new Response, so the header
  // edits go after the assignment.
  c.res = new Response(body === undefined ? res.body : JSON.stringify(body), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  if (body !== undefined) c.res.headers.delete("content-length");
  // The language the message is actually in: Spanish only when it was translated.
  c.res.headers.set("Content-Language", body === undefined ? "en-US" : locale);
  addVary(c.res.headers);
};
