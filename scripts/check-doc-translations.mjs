#!/usr/bin/env node
// Drift guard for the English/Spanish doc pairs (spec P3-7). Structural only:
// it catches missing siblings, switch lines, code blocks, headings, table rows,
// broken links and vos forms, not wording drift. No dependencies.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// English paths relative to the repo root. Each translation task appends its own.
export const IN_SCOPE = [
  "docs/architecture/API.md",
  "docs/architecture/API_PATHS.md",
  "docs/guides/MCP_TOOLS.md",
  "docs/integration/SDK_INTEGRATION.md",
  "docs/deploy/SERVICES.md",
  "docs/guides/MCP_GUIDE.md",
  "docs/deploy/OPERATIONS.md",
  "docs/guides/ACCOUNTS.md",
  "docs/guides/INMEMORY_ADAPTER_ARCHITECTURE.md",
  "docs/guides/MIGRATION_SAFETY.md",
  "docker/README.md",
  "docs/guides/LOCAL_DEV_SETUP.md",
  "docs/guides/HARNESS.md",
  "docs/guides/ADD_A_STORAGE_ADAPTER.md",
  "docs/guides/DEBUG_RLS_ISOLATION.md",
  "docs/guides/ADD_AN_LLM_PROVIDER.md",
  "docs/guides/ADD_A_PRIMITIVE.md",
  "packages/adapter-llm/README.md",
  "packages/core/README.md",
  "packages/sdk-python/README.md",
  "packages/plugin/README.md",
  "packages/sdk-go/README.md",
  "packages/llm-providers/README.md",
  "packages/plugins/README.md",
  "packages/server/README.md",
  "packages/client-ts/README.md",
  "packages/adapter-vector/README.md",
  "packages/consolidation/README.md",
  "packages/adapter-postgres/README.md",
  "packages/types/README.md",
  "packages/mock-server/README.md",
  "packages/federation/README.md",
  "packages/adapter-redis/README.md",
  "packages/cup/README.md",
  "packages/harness/README.md",
  "deploy/README.md",
  "examples/graph-viewer/README.md",
  "docs/DEPLOYMENT.md",
  "docs/RELEASING.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "README.md",
  "packages/mcp/README.md",
  "packages/cli/README.md",
  "docs/guides/CLI.md",
  "docs/api/errors.md",
  "docs/api/STABILITY.md",
  "packages/dashboard/README.md",
  "docs/guides/DASHBOARD_DEPLOY.md",
  "docs/guides/PRODUCTION_DEPLOY.md",
];

// \b is ASCII-only in JS: it never matches after an accented final letter, so use Unicode letter lookarounds.
const VOS =
  /(?<!\p{L})(usá|tenés|podés|hacé|elegí|querés|sabés|poné|decí|vení|tené|fijate|mirá|andá|sos|escribís|recordás|recordame|corregí|tratá|probá|agregá|decime|contame|avisame|fijá|seguí|pedí)(?!\p{L})/iu;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Splits a file into prose lines (outside fences) and the ordered fenced blocks.
function parse(text) {
  const prose = [];
  const blocks = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      if (new RegExp(`^ {0,3}\\${open.ch}{${open.len},}\\s*$`).test(line)) {
        blocks.push(open.lines.join("\n"));
        open = null;
      } else open.lines.push(line);
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) open = { ch: m[1][0], len: m[1].length, lines: [line] };
    else prose.push(line);
  }
  if (open) blocks.push(open.lines.join("\n")); // unclosed fence runs to EOF
  return { prose, blocks };
}

const headingCounts = (prose) => {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const l of prose) {
    const m = /^ {0,3}(#{1,6})(\s|$)/.exec(l);
    if (m) c[m[1].length]++;
  }
  return c.slice(1);
};
const noInlineCode = (s) => s.replace(/`[^`]*`/g, "");

// GitHub-style heading anchors of a file's prose (duplicates get -1, -2…), plus explicit <a name|id>.
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
function anchors(prose) {
  const out = new Set();
  const seen = new Map();
  for (const l of prose) {
    const m = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(l);
    if (!m) continue;
    const base = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of prose.join("\n").matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

export function checkPair(enPath, esPath) {
  const fails = [];
  const fail = (path, rule, detail) => fails.push({ path, rule, detail });
  if (!existsSync(esPath)) {
    fail(esPath, "sibling", "Spanish file is missing");
    return fails;
  }
  const en = parse(readFileSync(enPath, "utf8"));
  const es = parse(readFileSync(esPath, "utf8"));

  const switchLine = (p, want, path) => {
    const h1 = p.prose.findIndex((l) => /^ {0,3}#(\s|$)/.test(l));
    if (h1 < 0 || p.prose[h1 + 1] !== "" || p.prose[h1 + 2] !== want)
      fail(path, "switch-line", `expected "${want}" two lines under the first H1`);
  };
  switchLine(en, `**English** · [Español](${basename(esPath)})`, enPath);
  switchLine(es, `[English](${basename(enPath)}) · **Español**`, esPath);

  if (en.blocks.length !== es.blocks.length)
    fail(
      esPath,
      "code-blocks",
      `${en.blocks.length} English blocks vs ${es.blocks.length} Spanish`
    );
  else
    en.blocks.forEach((b, i) => {
      if (b !== es.blocks[i]) fail(esPath, "code-blocks", `block ${i + 1} differs from English`);
    });

  const he = headingCounts(en.prose);
  const hs = headingCounts(es.prose);
  he.forEach((n, i) => {
    if (n !== hs[i]) fail(esPath, "headings", `H${i + 1}: ${n} in English, ${hs[i]} in Spanish`);
  });

  const rows = (p) => p.prose.filter((l) => l.startsWith("|")).length;
  if (rows(en) !== rows(es))
    fail(esPath, "table-rows", `${rows(en)} in English, ${rows(es)} in Spanish`);

  for (const [p, path] of [
    [en, enPath],
    [es, esPath],
  ])
    for (const m of noInlineCode(p.prose.join("\n")).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1].split("#")[0];
      if (!target && !anchors(p.prose).has(decodeURIComponent(m[1].slice(1))))
        fail(path, "links", `broken anchor ${m[1]}`);
      if (!target || SCHEME.test(m[1])) continue;
      if (!existsSync(resolve(dirname(path), decodeURI(target))))
        fail(path, "links", `broken link ${m[1]}`);
    }

  noInlineCode(es.prose.join("\n"))
    .split("\n")
    .forEach((l, i) => {
      const m = VOS.exec(l);
      if (m) fail(esPath, "vos", `"${m[1]}" in prose line ${i + 1}`);
    });
  return fails;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fails = IN_SCOPE.flatMap((p) => {
    const en = join(ROOT, p);
    return checkPair(en, en.replace(/\.md$/, ".es.md"));
  });
  for (const f of fails) console.log(`${f.path}: ${f.rule}: ${f.detail}`);
  console.log(`${IN_SCOPE.length} documents checked`);
  process.exit(fails.length ? 1 : 0);
}
