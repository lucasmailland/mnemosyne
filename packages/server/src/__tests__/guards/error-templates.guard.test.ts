import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compileTemplates, matchTemplate } from "@mnemo-ai/types";
import { en, FOREIGN } from "../../i18n/error-templates.en.js";

/**
 * Drift guard for the error-message table (P2-7).
 *
 * The server localizes error bodies by matching the English message back to a
 * key (i18n/locale.ts). That only works while every English message the server
 * can emit has an entry and every entry still matches some message. This guard
 * walks src/**\/*.ts with the TypeScript compiler API and collects:
 *   - the message argument of `new X(...)` for every error class of errors.ts
 *     (HttpError and its subclasses) and the default of their `message` parameter;
 *   - every `message` property of an object literal that is the value of an
 *     `error` property, or that sits next to an `error` property (flat shape).
 * Each is resolved to a template (`${expr}` becomes a placeholder); anything it
 * cannot resolve is "dynamic" and must be on ALLOWLIST.
 *
 * It fails when a literal has no entry, when an entry (not FOREIGN) matches no
 * literal, when two entries match the same message, or when an allowlist entry
 * no longer points at a dynamic site.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Variable pass-through sites (message not a literal), keyed `file#function#<expression text>`
 * (so an unrelated insertion above never churns a key), with the reason.
 * Helpers that merely forward a message (like sendUnauthorized) belong in MESSAGE_CALLS
 * below, so their callers' literals are scanned; they never go on this list.
 */
const ALLOWLIST: Record<string, string> = {
  // The post-filter and the error handler carry a message produced elsewhere.
  "i18n/locale.ts#localizedBody#message":
    "the post-filter itself: it rewrites a body's existing message",
  "errors.ts#toErrorBody#err.message":
    "serializes err.message of an error whose literal is scanned at its throw site",
  // Storage and core text: foreign entries (store_*), matched by the table, not scanned here.
  "errors.ts#mapDomainError#err.message":
    "err.message of a StorageConflict/NotFound/ValidationError (store_* foreign entries)",
  "routes/_storage-errors.ts#withStorageErrors#err.message":
    "err.message of a storage error (store_* foreign entries)",
  // Messages built by a scanned producer and passed through a variable.
  'app.ts#createApp#decision.reason ?? "API key scope insufficient"':
    "decision.reason from scopeGuard.ts (reason literals scanned); the ?? fallback is a literal",
  'routes/dashboard-api.ts#mountDashboardApi#decision.reason ?? "Session scope insufficient"':
    "decision.reason from scopeGuard.ts; the ?? fallback is a literal",
  'auth.ts#authenticateScoped#result.reason ?? "Forbidden"':
    "result.reason from an AuthAdapter; the ?? fallbacks are literals",
  'auth.ts#authenticateScoped#result.reason ?? "Invalid API key"':
    "result.reason from an AuthAdapter; the ?? fallbacks are literals",
  "auth.ts#authenticateScoped#decision.message":
    "decision.message from auth-evaluate.ts (message literals scanned)",
  "auth.ts#createAuthMiddleware#decision.message":
    "decision.message from auth-evaluate.ts (message literals scanned)",
  "errorCodes.ts#mnemoDegraded#message ?? MNEMO_CODES[code]":
    "the caller's message, else MNEMO_CODES[code] (registry values scanned)",
  "middleware/auth.ts#sendUnauthorized#reason":
    "its callers pass the message; sendUnauthorized(c, code, message) literals are scanned",
  "middleware/auth.ts#createV3AuthMiddleware#result.reason":
    "result.reason of an AuthAdapter, passed to sendUnauthorized",
  "middleware/rbac-policy.ts#createRbacMiddleware#decision.reason":
    "decision.reason from rbac.ts evaluateAccess (literals scanned where it throws)",
  "routes/bootstrap.ts#mountBootstrap#policy":
    "passwordPolicyError() in dashboard-password.ts (return literals scanned)",
  "routes/dashboard-auth.ts#mountDashboardAuth#result":
    "passwordPolicyError() in dashboard-password.ts (return literals scanned)",
  "routes/dashboard-links.ts#mountDashboardLinks#policy":
    "passwordPolicyError() in dashboard-password.ts (return literals scanned)",
  "routes/keys.ts#mountKeys#result.message":
    "result.message of the key helpers in keys.ts (their literals are scanned)",
  // Text owned by another module, left in English.
  "routes/federation.ts#gateFederationRequest#authResult.reason":
    "authResult.reason: terse diagnostics of federation/authenticateFederationRequest.ts, kept in English",
  "routes/facts.ts#mountFacts#(err as Error).message":
    "SENSITIVITY_BLOCKED err.message from core, left in English",
  "routes/facts.ts#mountFacts#err.message":
    "FactRevisionConflictError message from core, left in English",
  "routes/forget.ts#mountForget#(err as Error).message":
    "EVENT_IMMUTABLE err.message from core, left in English",
  "routes/remember.ts#mountRemember#err.message":
    "err.message/details of a core conflict, left in English",
  "routes/review.ts#mountReview#e.message":
    "message of a core parse failure ('exactly one'), left in English",
  "routes/tasks.ts#mountTasks#err.message":
    "IllegalTaskTransitionError message from core, left in English",
  "routes/self.ts#mountSelf#error.message":
    "SelfEditContentRequiredError message from core, left in English",
  'routes/self.ts#mountSelf#session.sessionless && limit.startsWith("maxEditsPerSession") ? `${limit} This request had no session (no sessionId, or one that names no session of ` + "this workspace), so it drew from this credential\'s sessionless budget; pass the " + "sessionId from POST /session/start for a per-session budget." : limit':
    "the per-agent policy limit (reason from the evaluator) with an optional appended note; left in English",
  "routes/break-glass.ts#mountBreakGlass#msg":
    "the approval store's own err.message, left in English",
  "routes/harness.ts#unavailable#code":
    "the code doubles as the message (HttpError(503, code, code))",
  "routes/harness.ts#parseBatch#error.message":
    "HarnessPayloadLimitError message from the harness package, left in English",
};

/**
 * Files that build a message in a property other than `message` before another
 * file throws it (a decision object's `reason`, say): those properties are scanned too.
 */
const PRODUCER_PROPS: Record<string, string[]> = {
  "middleware/scopeGuard.ts": ["reason"],
  "auth-evaluate.ts": ["message"],
};

/** Functions whose string returns are messages, for a caller that passes them through. */
const MESSAGE_RETURNS: Record<string, string[]> = {
  "dashboard-password.ts": ["passwordPolicyError"],
};

/** Calls whose argument (by index) is a message: `sendUnauthorized(c, code, message)`. */
const MESSAGE_CALLS: Record<string, number> = { sendUnauthorized: 2 };

/** The operational registry: every value of this object literal is a message. */
const REGISTRY = { file: "errorCodes.ts", name: "MNEMO_CODES" };

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === "gen")
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.includes(".test."))
      out.push(full);
  }
  return out;
}

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

/**
 * HttpError and every class that extends it, in any src file (followed by class
 * name), with the index of its `message` constructor parameter. A subclass with
 * no constructor of its own inherits its parent's index; one whose constructor
 * has no `message` parameter (it builds the text in `super(...)`) is scanned there.
 */
function errorClasses(): { index: Map<string, number>; superIndex: Map<string, number> } {
  const parent = new Map<string, string>();
  const own = new Map<string, number | undefined>(); // undefined: no constructor of its own
  const hasCtor = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const sf = parse(file);
    const walk = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const base = node.heritageClauses
          ?.flatMap((h) => h.types)
          .map((t) => t.expression.getText(sf))[0];
        if (base) parent.set(name, base);
        const ctor = node.members.find(ts.isConstructorDeclaration);
        if (ctor) {
          hasCtor.add(name);
          const i = ctor.parameters.findIndex((p) => p.name.getText(sf) === "message");
          if (i >= 0) own.set(name, i);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  const toHttp = (name: string): boolean => {
    for (let cur: string | undefined = name; cur; cur = parent.get(cur))
      if (cur === "HttpError") return true;
    return false;
  };
  const index = new Map<string, number>();
  const superIndex = new Map<string, number>(); // classes whose super(...) carries the message
  for (const name of parent.keys()) {
    if (!toHttp(name)) continue;
    // message index of the nearest class (self first) with a `message` parameter
    let cur: string | undefined = name;
    while (cur && cur !== "HttpError" && !own.has(cur) && !hasCtor.has(cur)) cur = parent.get(cur);
    if (cur && own.has(cur)) index.set(name, own.get(cur)!);
    if (hasCtor.has(name)) {
      // super(...) of this class: message index of its base (HttpError takes it third)
      let b = parent.get(name);
      while (b && b !== "HttpError" && !own.has(b)) b = parent.get(b);
      superIndex.set(name, b === "HttpError" || !b ? 2 : own.get(b)!);
    }
  }
  index.set("HttpError", own.get("HttpError") ?? 2);
  return { index, superIndex };
}

type Resolved = string[] | "dynamic";

function resolve(node: ts.Expression): Resolved {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
    return resolve(node.expression);
  if (ts.isTemplateExpression(node))
    return [node.head.text + node.templateSpans.map((s) => `{p}${s.literal.text}`).join("")];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolve(node.left);
    const r = resolve(node.right);
    if (l === "dynamic" || r === "dynamic") return "dynamic";
    return l.flatMap((a) => r.map((b) => a + b));
  }
  if (ts.isConditionalExpression(node)) {
    const a = resolve(node.whenTrue);
    const b = resolve(node.whenFalse);
    return a === "dynamic" || b === "dynamic" ? "dynamic" : [...a, ...b];
  }
  return "dynamic";
}

interface Site {
  file: string; // relative to src
  line: number;
  fn: string;
  /** The message expression's source text, whitespace-collapsed: part of the allowlist key. */
  expr: string;
  resolved: Resolved;
}

function enclosingFunction(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    )
      return n.parent.name.text;
  }
  return "<module>";
}

function collect(): Site[] {
  const { index: classes, superIndex } = errorClasses();
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const sf = parse(file);
    const rel = relative(SRC, file);
    const push = (node: ts.Node, expr: ts.Expression, resolved: Resolved) =>
      sites.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1,
        fn: enclosingFunction(node),
        expr: expr.getText(sf).replace(/\s+/g, " "),
        resolved,
      });
    const add = (node: ts.Node, expr: ts.Expression) => {
      push(node, expr, resolve(expr));
      // `x ?? "literal"`: x is a pass-through (allowlisted), the literal is a message too.
      let e = expr;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (
        ts.isBinaryExpression(e) &&
        (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        const fallback = resolve(e.right);
        if (fallback !== "dynamic") push(node, e.right, fallback);
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const i = classes.get(node.expression.text);
        const arg = i === undefined ? undefined : node.arguments?.[i];
        if (arg) add(node, arg);
      }
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        node.expression.kind !== ts.SyntaxKind.NullKeyword &&
        MESSAGE_RETURNS[rel]?.includes(enclosingFunction(node))
      )
        add(node, node.expression);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const i = MESSAGE_CALLS[node.expression.text];
        const arg = i === undefined ? undefined : node.arguments[i];
        if (arg) add(node, arg);
      }
      if (
        rel === REGISTRY.file &&
        ts.isVariableDeclaration(node) &&
        node.name.getText(sf) === REGISTRY.name &&
        node.initializer
      ) {
        let init: ts.Expression = node.initializer;
        if (ts.isAsExpression(init)) init = init.expression;
        if (ts.isObjectLiteralExpression(init))
          for (const p of init.properties) if (ts.isPropertyAssignment(p)) add(node, p.initializer);
      }
      // a subclass that builds its text in super(...); a bare `message` parameter is passed through
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        let cls: ts.Node | undefined = node.parent;
        while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
        const i =
          cls && ts.isClassDeclaration(cls) && cls.name ? superIndex.get(cls.name.text) : undefined;
        const arg = i === undefined ? undefined : node.arguments[i];
        if (arg && !(ts.isIdentifier(arg) && arg.text === "message")) add(node, arg);
      }
      // the class defaults: constructor(message = "Bad request", ...)
      if (
        rel === "errors.ts" &&
        ts.isParameter(node) &&
        node.name.getText(sf) === "message" &&
        node.initializer
      )
        add(node, node.initializer);
      if (ts.isObjectLiteralExpression(node)) {
        const props = node.properties;
        const prop = (name: string) =>
          props.find(
            (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              p.name.getText(sf) === name
          );
        const messageOf = (o: ts.ObjectLiteralExpression) =>
          o.properties.find(
            (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              p.name.getText(sf) === "message"
          );
        const addMessage = (m: ts.PropertyAssignment | ts.ShorthandPropertyAssignment) =>
          ts.isPropertyAssignment(m) && m.initializer.getText(sf).startsWith("z.")
            ? undefined // a zod schema ({ error: z.string(), message: z.string() }), not a body
            : ts.isPropertyAssignment(m)
              ? add(node, m.initializer)
              : sites.push({
                  file: rel,
                  line: sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1,
                  fn: enclosingFunction(node),
                  expr: m.getText(sf).replace(/\s+/g, " "),
                  resolved: "dynamic",
                });
        for (const name of PRODUCER_PROPS[rel] ?? []) {
          const m = prop(name);
          if (m && ts.isPropertyAssignment(m)) add(node, m.initializer);
        }
        const error = prop("error");
        if (error) {
          if (ts.isPropertyAssignment(error) && ts.isObjectLiteralExpression(error.initializer)) {
            const m = messageOf(error.initializer);
            if (m) addMessage(m);
          } else {
            const m = messageOf(node); // flat { error, message }
            if (m) addMessage(m);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

const norm = (s: string) => s.replace(/\{\w+\}/g, "{}");
const sample = (s: string) => s.replace(/\{\w*\}/g, "x");

const SITES = collect();
const EN_VALUES = new Map<string, string[]>(); // normalized -> keys
for (const [k, v] of Object.entries(en))
  EN_VALUES.set(norm(v), [...(EN_VALUES.get(norm(v)) ?? []), k]);
const where = (s: Site) => `${s.file}:${s.line}`;

const keyOf = (s: Site) => `${s.file}#${s.fn}#${s.expr}`;
const allowed = (s: Site): string | undefined => ALLOWLIST[keyOf(s)];

describe("error templates drift guard", () => {
  it("finds the sites it is meant to scan", () => {
    expect(SITES.length).toBeGreaterThan(100);
    const { index, superIndex } = errorClasses();
    expect(index.get("HttpError")).toBe(2);
    expect(index.get("NotFoundError")).toBe(0);
    expect(index.get("RbacError")).toBe(0); // defined outside errors.ts
    expect(superIndex.get("WrongRegionError")).toBe(2); // message built in super(...)
  });

  it("every message literal has a table entry", () => {
    // A template that is only placeholders ("{p}: {p}", zod's own text) has no English of ours to translate.
    const bare = (t: string) => norm(t).replace(/\{\}|[\s:]/g, "") === "";
    const missing = SITES.flatMap((s) =>
      s.resolved === "dynamic"
        ? []
        : s.resolved
            .filter((t) => !bare(t) && !EN_VALUES.has(norm(t)))
            .map((t) => `${where(s)}  ${t}`)
    );
    expect(missing).toEqual([]);
  });

  it("every dynamic site is on the allowlist", () => {
    const loose = SITES.filter((s) => s.resolved === "dynamic" && !allowed(s)).map(
      (s) => `${where(s)}  ${keyOf(s)}`
    );
    expect(loose).toEqual([]);
  });

  it("each allowlist key covers a pinned number of dynamic sites", () => {
    // A key is file#function#expression, so a second pass-through of the same expression in the same
    // function would share it silently; pinning the count makes that a visible snapshot change.
    const counts = Object.fromEntries(
      Object.keys(ALLOWLIST)
        .sort()
        .map((key) => [
          key,
          SITES.filter((s) => s.resolved === "dynamic" && keyOf(s) === key).length,
        ])
    );
    expect(counts).toMatchSnapshot();
  });

  it("every allowlist entry still points at a dynamic site", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (key) => !SITES.some((s) => s.resolved === "dynamic" && key === keyOf(s))
    );
    expect(stale).toEqual([]);
  });

  it("every table entry (not foreign) is produced by a literal", () => {
    const produced = new Set<string>();
    for (const s of SITES)
      if (s.resolved !== "dynamic") for (const t of s.resolved) produced.add(norm(t));
    const orphans = Object.entries(en)
      .filter(([k]) => !FOREIGN.has(k as keyof typeof en))
      .filter(([, v]) => !produced.has(norm(v)))
      .map(([k]) => k);
    expect(orphans).toEqual([]);
  });

  it("no message is matched by two entries", () => {
    // Templates are tried most specific first (longest literal text). A clash is
    // two entries with the same text, two matches of equal specificity, or a
    // message that resolves to an entry other than its own.
    const weight = (t: string) => t.replace(/\{\w+\}/g, "").length;
    const own = new Map<string, string>(); // normalized -> key
    const clashes: string[] = [];
    for (const [text, keys] of EN_VALUES) {
      if (keys.length > 1) clashes.push(`same text: ${keys.join(", ")}`);
      own.set(text, keys[0]!);
    }
    const compiled = compileTemplates(en);
    const messages = new Set<string>([
      ...Object.values(en),
      ...SITES.flatMap((s) => (s.resolved === "dynamic" ? [] : s.resolved)),
    ]);
    for (const template of messages) {
      const message = sample(template);
      const hits = Object.entries(en)
        .filter(([k, v]) => matchTemplate(compileTemplates({ [k]: v }), message) !== undefined)
        .sort((a, b) => weight(b[1]) - weight(a[1]));
      if (hits.length > 1 && weight(hits[0]![1]) === weight(hits[1]![1]))
        clashes.push(`"${message}": ${hits.map(([k]) => k).join(", ")} match equally`);
      const winner = matchTemplate(compiled, message)?.key;
      const mine = own.get(norm(template));
      if (mine !== undefined && winner !== mine)
        clashes.push(`"${message}": belongs to ${mine}, resolves to ${winner}`);
    }
    expect(clashes).toEqual([]);
  });
});
