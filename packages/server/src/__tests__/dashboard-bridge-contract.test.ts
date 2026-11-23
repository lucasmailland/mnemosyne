/// <reference types="node" />
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import type { ServerDeps } from "../deps.js";
import { routeInventory, type InventoryRoute } from "./contract-inventory.js";

/**
 * Dashboard ↔ server contract (AUD-001).
 *
 * The Health page asked the bridge for `/vitals`, a route that never existed (the bridge
 * mounts the vitals at `/health`), and nothing failed until a person opened the page. This
 * guard reads every request the dashboard source makes, server-side `apiGet(...)` and
 * browser `fetch(...)`, and checks each method + path against the route table of the real
 * `createApp()`. No list to keep by hand: a new call, or a route that moves, fails here.
 *
 * Extraction uses the TypeScript checker over the dashboard project, so a path built in a
 * wrapper (`api(path, method)` → `fetch(\`/dashboard/api/workspace${path}\`, { method })`),
 * a `const`, or `apiGet`'s own `fetch` is followed to every call site that feeds it. A call
 * whose method or path cannot be worked out statically is a failure too (fail closed).
 *
 * A part known only at runtime (an id) becomes `:p`, which matches a route parameter and
 * never a fixed route name, so `/${ENDPOINT[tab]}` cannot hide a wrong endpoint. Finite
 * choices are resolved to every value: a const object indexed at runtime, a conditional, a
 * local function's return values (so a query builder that answers "?…" or "" drops out as a
 * query string). A wrapper that is also passed around as a value, a spread that may carry
 * the method, and other ways to call the bridge (EventSource, sendBeacon, window.fetch, a
 * form posting to it) are reported instead of skipped.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DASHBOARD = join(REPO_ROOT, "packages", "dashboard");
/** Marks a part of a path that is only known at runtime (an id, a query string). */
const DYN = "\u0000";

interface ClientCall {
  where: string;
  method: string;
  path: string;
}

class Unbound {
  constructor(readonly fn: ts.SignatureDeclaration) {}
}

const isSource = (root: string, f: string) =>
  f.startsWith(root) &&
  !f.includes("/node_modules/") &&
  !f.includes("/__tests__/") &&
  !/\.test\.tsx?$/.test(f) &&
  !f.endsWith(".d.ts");

function extractClientCalls(root: string = DASHBOARD): {
  calls: ClientCall[];
  unresolved: string[];
} {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile).config as object;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter((sf) => isSource(root, sf.fileName));

  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const s = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  };
  const where = (node: ts.Node) => {
    const sf = node.getSourceFile();
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    return `${sf.fileName.slice(root.length + 1)}:${line}`;
  };

  const allCalls: ts.CallExpression[] = [];
  const allIdentifiers: ts.Identifier[] = [];
  const unresolved: string[] = [];
  const OTHER_TRANSPORT =
    /\b(?:window|globalThis|self)\.fetch\b|\bnew EventSource\b|\bsendBeacon\b|action=\{?["'`]\/dashboard\/(?:api|auth)/;
  for (const sf of files) {
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) allCalls.push(n);
      if (ts.isIdentifier(n)) allIdentifiers.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    sf.text.split("\n").forEach((line, i) => {
      if (OTHER_TRANSPORT.test(line))
        unresolved.push(
          `${sf.fileName.slice(root.length + 1)}:${i + 1}: calls the bridge without fetch`
        );
    });
  }

  /** Calls of a named function (`function run(...)` or `const call = (...) => ...`). */
  const callSitesCache = new Map<ts.SignatureDeclaration, ts.CallExpression[]>();
  const callSites = (fn: ts.SignatureDeclaration): ts.CallExpression[] => {
    const cached = callSitesCache.get(fn);
    if (cached) return cached;
    const name =
      ts.isFunctionDeclaration(fn) && fn.name
        ? fn.name
        : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
          ? fn.parent.name
          : undefined;
    const target = name && symbolOf(name);
    const sites = target
      ? allCalls.filter((c) => ts.isIdentifier(c.expression) && symbolOf(c.expression) === target)
      : [];
    callSitesCache.set(fn, sites);
    return sites;
  };

  /** References to a function other than calls by name (passed as a value, a method): its call sites are not all known. */
  const escapes = (fn: ts.SignatureDeclaration): number => {
    const name =
      ts.isFunctionDeclaration(fn) && fn.name
        ? fn.name
        : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)
          ? fn.parent.name
          : undefined;
    const target = name && symbolOf(name);
    if (!target) return 0;
    return allIdentifiers.filter((id) => {
      if (id === name || symbolOf(id) !== target) return false;
      const parent = id.parent;
      if (ts.isCallExpression(parent) && parent.expression === id) return false;
      return !(
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isTypeQueryNode(parent)
      );
    }).length;
  };

  /** The `return` expressions of a function body, nested functions excluded. */
  const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  };
  const constObject = (node: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    if (!ts.isIdentifier(node)) return undefined;
    const decl = symbolOf(node)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return undefined;
    let init: ts.Expression = decl.initializer;
    while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
    return ts.isObjectLiteralExpression(init) ? init : undefined;
  };
  const inProgress = new Set<ts.Node>();

  type Env = Map<ts.Symbol, ts.Expression | undefined>;

  /** Every string the expression can take; null when it is not known statically. */
  const values = (node: ts.Expression, env: Env, lenient = false): string[] | null => {
    const v = (n: ts.Expression) => values(n, env, lenient);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return v(node.expression);
    if (ts.isConditionalExpression(node)) {
      const a = v(node.whenTrue);
      const b = v(node.whenFalse);
      return a && b ? [...a, ...b] : null;
    }
    // A const object read by key: that key, or every value when the key is a runtime one.
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const obj = constObject(node.expression);
      if (!obj) return null;
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      const out: string[] = [];
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) return null;
        if (key !== undefined && prop.name.getText().replace(/^["']|["']$/g, "") !== key) continue;
        const pv = v(prop.initializer);
        if (!pv) return null;
        out.push(...pv);
      }
      return out.length > 0 ? out : null;
    }
    // A local function: every value its returns can take (a query builder answers "?…" or "").
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const decl = symbolOf(node.expression)?.valueDeclaration;
      const fn =
        decl && ts.isFunctionDeclaration(decl)
          ? decl
          : decl &&
              ts.isVariableDeclaration(decl) &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
            ? decl.initializer
            : undefined;
      if (!fn || inProgress.has(fn)) return null;
      const returns = returnsOf(fn);
      if (returns.length === 0) return null;
      inProgress.add(fn);
      try {
        const out: string[] = [];
        for (const r of returns) {
          // Inside the callee its parameters are runtime values, not wrapper arguments.
          const rv = values(r, env, true);
          if (!rv) return null;
          out.push(...rv);
        }
        return out;
      } finally {
        inProgress.delete(fn);
      }
    }
    const product = (parts: Array<string[] | null>) =>
      parts.reduce<string[]>((acc, p) => acc.flatMap((x) => (p ?? [DYN]).map((y) => x + y)), [""]);
    if (ts.isTemplateExpression(node)) {
      const parts: Array<string[] | null> = [[node.head.text]];
      for (const span of node.templateSpans) {
        parts.push(v(span.expression), [span.literal.text]);
      }
      return product(parts);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return product([v(node.left), v(node.right)]);
    if (ts.isIdentifier(node)) {
      const sym = symbolOf(node);
      if (!sym) return null;
      if (env.has(sym)) {
        const bound = env.get(sym);
        return bound ? values(bound, env) : null;
      }
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return v(decl.initializer);
      if (!lenient && decl && ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
        const fn = decl.parent;
        // A parameter of a function that is called by name: follow its call sites.
        if (callSites(fn).length > 0) throw new Unbound(fn);
      }
      return null;
    }
    return null;
  };

  const methods = (init: ts.Expression | undefined, env: Env): string[] | null => {
    let opts = init;
    while (opts && ts.isIdentifier(opts)) {
      const decl = symbolOf(opts)?.valueDeclaration;
      opts = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    }
    if (!opts || !ts.isObjectLiteralExpression(opts)) return init ? null : ["GET"];
    /** A spread that may set `method` (anything but object literals without one). */
    const mayCarryMethod = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isConditionalExpression(e))
        return mayCarryMethod(e.whenTrue) || mayCarryMethod(e.whenFalse);
      if (!ts.isObjectLiteralExpression(e)) return true;
      return e.properties.some(
        (p) => ts.isSpreadAssignment(p) || (p.name !== undefined && p.name.getText() === "method")
      );
    };
    let found: string[] | null = ["GET"];
    for (const p of opts.properties) {
      if (ts.isSpreadAssignment(p)) {
        if (mayCarryMethod(p.expression)) found = null;
      } else if (p.name && ts.isIdentifier(p.name) && p.name.text === "method") {
        if (ts.isPropertyAssignment(p)) found = values(p.initializer, env);
        else if (ts.isShorthandPropertyAssignment(p)) found = values(p.name, env);
        else found = null;
      }
    }
    return found;
  };

  const calls: ClientCall[] = [];

  const expand = (call: ts.CallExpression, env: Env, depth: number, origin = call): void => {
    let paths: string[] | null;
    let verbs: string[] | null;
    try {
      const [url, init] = call.arguments;
      paths = url ? values(url, env) : null;
      verbs = methods(init, env);
    } catch (e) {
      if (!(e instanceof Unbound) || depth > 6) throw e;
      if (escapes(e.fn) > 0)
        unresolved.push(
          `${where(e.fn)}: a request wrapper is also used as a value; its calls are not all known`
        );
      for (const site of callSites(e.fn)) {
        const next: Env = new Map(env);
        e.fn.parameters.forEach((p, i) => {
          const s = symbolOf(p.name);
          if (s) next.set(s, site.arguments[i]);
        });
        expand(call, next, depth + 1, site);
      }
      return;
    }
    const at = where(origin);
    if (!paths || !verbs) {
      unresolved.push(`${at}: ${paths ? "method" : "path"} not statically known`);
      return;
    }
    for (const raw of paths) {
      const start = raw.indexOf("/dashboard/");
      if (start === -1) {
        unresolved.push(`${at}: ${JSON.stringify(raw.replaceAll(DYN, "…"))} is not a bridge path`);
        continue;
      }
      const path = normalize(raw.slice(start));
      for (const m of verbs) calls.push({ where: at, method: m.toUpperCase(), path });
    }
  };

  for (const call of allCalls) {
    if (ts.isIdentifier(call.expression) && call.expression.text === "fetch")
      expand(call, new Map(), 0);
  }
  return { calls, unresolved };
}

/** Drop the query string; a segment with any runtime part becomes `:p` (a route parameter only). */
function normalize(raw: string): string {
  const noQuery = raw.split("?")[0]!;
  return noQuery
    .split("/")
    .map((seg) => (seg.includes(DYN) ? ":p" : seg))
    .join("/")
    .replace(/\/$/, "");
}

/**
 * Hono route path (`/facts/:id`, `/x/:id{re}`, `/y/*`) against a client path. A client `:p`
 * (runtime value) matches only a route parameter or `*`, never a fixed route name.
 */
function routeMatches(route: string, path: string): boolean {
  const r = route.split("/");
  const p = path.split("/");
  for (let i = 0; i < r.length; i++) {
    const seg = r[i]!;
    if (seg === "*") return true;
    if (i >= p.length) return seg.startsWith(":") && seg.endsWith("?");
    if (seg.startsWith(":")) continue;
    if (seg === p[i]) continue;
    return false;
  }
  return r.length === p.length;
}

/** The calls no mounted route serves (method + path). */
function missingCalls(calls: ClientCall[], routes: InventoryRoute[]): string[] {
  return calls
    .filter(
      (c) =>
        !routes.some(
          (r) =>
            (r.method === c.method || (c.method === "HEAD" && r.method === "GET")) &&
            routeMatches(r.path, c.path)
        )
    )
    .map((c) => `${c.where}: ${c.method} ${c.path}`);
}

/**
 * Known-bad requests the guard must catch: a wrong endpoint picked from a map at runtime
 * (the AUD-001 class), a runtime value where the route has a fixed name, an unknown tail
 * glued to a fixed segment, a wrapper passed around as a value, and a non-fetch request.
 * Plus good ones, so the fixture is not all failures.
 */
const BAD_FIXTURE: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "esnext",
      moduleResolution: "bundler",
      lib: ["es2022", "dom"],
      strict: true,
      noEmit: true,
    },
    include: ["**/*.ts"],
  }),
  "lib/api.ts": `export async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(\`http://server/dashboard/api\${path}\`);
  return res.json();
}
`,
  "pages.ts": `import { apiGet } from "./lib/api";
const ENDPOINT = { health: "health", vitals: "vitals" } as const;
export const byTab = (tab: keyof typeof ENDPOINT) => apiGet(\`/\${ENDPOINT[tab]}\`);
export const runtimeName = (name: string) => apiGet(\`/\${name}\`);
export const gluedTail = (x: string) => apiGet("/fact" + x.trim());
export const good = (id: string) => apiGet(\`/facts/\${encodeURIComponent(id)}\`);
export const handlers = [apiGet];
export const beacon = () => navigator.sendBeacon("/dashboard/api/x");
`,
};

describe("dashboard ↔ server contract", () => {
  let routes: InventoryRoute[];
  let extracted: ReturnType<typeof extractClientCalls>;

  beforeAll(() => {
    // Routes that only mount with a database or the dashboard secret: registration is
    // synchronous and never connects, handlers would (none run here).
    vi.stubEnv("MNEMO_DASHBOARD_SECRET", "dashboard-bridge-contract-secret-32b!");
    vi.stubEnv("DATABASE_URL", "postgres://contract-test.invalid/none");
    const deps = {
      metricsPgClient: {},
      apiKeys: { listActive: async () => [], touch: async () => {} },
      embedModel: "text-embedding-3-small",
      telemetry: {
        startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
        counter: () => {},
        histogram: () => {},
        gauge: () => {},
        shutdown: async () => {},
      },
    } as unknown as ServerDeps;
    routes = routeInventory(createApp({ deps, version: "0.0.0-test" }));
    extracted = extractClientCalls();
  }, 120_000);
  afterAll(() => vi.unstubAllEnvs());

  it("works out the method and path of every dashboard request", () => {
    expect(extracted.unresolved).toEqual([]);
    const seen = new Set(extracted.calls.map((c) => `${c.method} ${c.path}`));
    // The extractor follows wrappers, consts and apiGet's own fetch; prove it on known calls.
    for (const known of [
      "GET /dashboard/api/doctor",
      "GET /dashboard/auth/session",
      "POST /dashboard/auth/logout",
      "GET /dashboard/api/facts",
      "PATCH /dashboard/api/workspace/members/:p",
      "POST /dashboard/api/instance/users/:p/enable",
      "DELETE /dashboard/api/instance/workspaces/:p/members/:p",
      "POST /dashboard/api/admin/keys/:p/rotate",
      "GET /dashboard/api/entities",
    ])
      expect(seen, known).toContain(known);
    expect(extracted.calls.length).toBeGreaterThan(40);
  });

  it("every dashboard request hits a route the server mounts (method + path)", () => {
    expect(missingCalls(extracted.calls, routes)).toEqual([]);
  });

  it("catches known-bad requests: a wrong map entry, a runtime name, a glued unknown tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-contract-"));
    try {
      for (const [file, text] of Object.entries(BAD_FIXTURE)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      const fixture = extractClientCalls(dir);
      // A wrapper also passed as a value, and a request that is not a fetch: reported.
      expect(fixture.unresolved).toEqual([
        "pages.ts:8: calls the bridge without fetch",
        "lib/api.ts:1: a request wrapper is also used as a value; its calls are not all known",
      ]);
      expect(missingCalls(fixture.calls, routes).sort()).toEqual(
        [
          "pages.ts:3: GET /dashboard/api/vitals",
          "pages.ts:4: GET /dashboard/api/:p",
          "pages.ts:5: GET /dashboard/api/:p",
        ].sort()
      );
      expect(fixture.calls.map((c) => `${c.method} ${c.path}`)).toContain(
        "GET /dashboard/api/health"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
