#!/usr/bin/env node
/**
 * Offline OpenAPI spec dumper.
 *
 * Generates the full OpenAPI 3.1 document WITHOUT a running server, Postgres,
 * Redis, or an LLM key. This is what the marketing/docs site bundles as its
 * Swagger snapshot (`mnemosyne-web/public/openapi-snapshot.json`), and what any
 * codegen/contract tooling can consume.
 *
 * How it works: `createApp({ deps, version })` registers every `.openapi()`
 * route on the root-mounted OpenAPIHono synchronously at construction time —
 * the route definitions populate the OpenAPI registry regardless of whether
 * `deps` actually work. So we hand it a stub `deps` and then ask the app for
 * its own generated spec via `GET /openapi.json`.
 *
 * The three stub tricks:
 *   1. A recursive, primitive-safe Proxy satisfies every `deps.X` / `deps.X.Y`
 *      / `await deps.X()` access (and coerces to "" so access-policy middleware
 *      that string-concatenates a dep doesn't throw).
 *   2. A real-ish `apiKeys` adapter: `findByLookupHash` returns a row whose
 *      `keyHash` is a genuine bcrypt hash of our throwaway token, so the auth
 *      middleware's `bcrypt.compare` succeeds and the request reaches the route.
 *   3. Full `memory:*` scopes so the scope-guard passes; and we omit the deps
 *      that only add request-time middleware (rate-limit / idempotency) or that
 *      would force the scoped-auth path.
 *
 * NOTE: routes registered with plain Hono (`app.post(...)`) instead of
 * `app.openapi(createRoute(...))` are intentionally NOT in the document — e.g.
 * `self.ts` and `federation.ts` at time of writing. That is faithful to what a
 * live `/openapi.json` returns.
 *
 * Usage:
 *   pnpm --filter @mnemo-ai/server build   # produces dist/app.js
 *   node scripts/dump-openapi.mjs [outPath]  # default: ./openapi-snapshot.json
 *
 * Or via the package script:  pnpm --filter @mnemo-ai/server openapi:dump
 */
import { createApp } from "../dist/app.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";

const here = fileURLToPath(new URL(".", import.meta.url));
const distApp = new URL("../dist/app.js", import.meta.url);
if (!existsSync(fileURLToPath(distApp))) {
  process.stderr.write(
    "dist/app.js not found — run `pnpm --filter @mnemo-ai/server build` first.\n"
  );
  process.exit(2);
}

const OUT = process.argv[2] || `${here}../openapi-snapshot.json`;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

// A throwaway, format-valid token (mns_(live|test)|mk_...)_[a-z0-9]{20,64}.
const TOKEN = "mns_live_openapidumpstubaaaaaaaa";
const TOKEN_HASH = bcrypt.hashSync(TOKEN, 10);

// Recursive, primitive-safe truthy stub.
const stub = new Proxy(function () {}, {
  get: (_t, p) => {
    if (p === "then") return undefined; // not thenable -> await resolves to the stub
    if (p === Symbol.toPrimitive) return () => "";
    if (p === "toString" || p === "valueOf") return () => "";
    if (p === Symbol.iterator) return function* () {};
    return stub;
  },
  apply: () => stub,
  construct: () => stub,
});

const apiKeys = {
  listActive: async () => [],
  findByLookupHash: async () => ({
    id: "openapi-dump",
    keyHash: TOKEN_HASH,
    workspaceId: "00000000-0000-4000-8000-000000000000",
    scopes: [
      "memory:read",
      "memory:write",
      "memory:delete",
      "memory:admin",
      "memory:subscribe",
      "memory:export",
      "memory:federation",
      "memory:governance",
      "memory:session",
      "memory:task",
      "memory:event",
      "memory:reasoning",
      "memory:procedural",
      "memory:self_edit",
    ],
    plan: "free",
    ipAllowlist: [],
    deprecatedAt: null,
  }),
  touch: () => {},
};

// Deps that only gate request-time middleware (or force scoped auth) are omitted
// so the openapi.json request runs clean; they add no routes to the document.
const OMIT = new Set(["rateLimitBackend", "idempotencyStore", "scopedAuthAdapter"]);

const deps = new Proxy(
  {},
  {
    get: (_t, p) => {
      if (p === "apiKeys") return apiKeys;
      if (typeof p === "string" && OMIT.has(p)) return undefined;
      return stub;
    },
    has: (_t, p) => !(typeof p === "string" && OMIT.has(p)),
  }
);

const app = createApp({ deps, version: VERSION });
const res = await app.request("/openapi.json", {
  headers: { authorization: `Bearer ${TOKEN}` },
});

if (res.status !== 200) {
  process.stderr.write(`Failed: HTTP ${res.status}\n${await res.text()}\n`);
  process.exit(1);
}

const doc = await res.json();
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
process.stderr.write(
  `Wrote ${OUT} — openapi=${doc.openapi} version=${doc.info?.version} ` +
    `paths=${Object.keys(doc.paths || {}).length} schemas=${Object.keys(doc.components?.schemas || {}).length}\n`
);
