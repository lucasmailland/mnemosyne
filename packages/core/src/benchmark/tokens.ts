/**
 * Plan 3.6 (APP-015) — what a turn of an agent session puts into context with
 * Mnemosyne, against pasting the whole memory into every request, against no
 * memory at all.
 *
 * Run: pnpm bench:tokens            (from the repo root; `pnpm build` first so
 *                                    the MCP server's real surface is measured)
 *      pnpm bench:tokens --out f.md  (also write the report)
 *
 * Method
 *  - Corpora: the two labelled corpora of the relevance gate (corpus.json, real
 *    bge-m3 vectors in vectors.json), run through the REAL recall facade, as
 *    recall-relevance.test.ts does. No model, no network, deterministic.
 *  - Mnemosyne, per turn: the hook's request (top 5, compact projection: each
 *    hit at most 300 characters; nothing when the response says
 *    nothingRelevant), plus the fixed surface every request carries: the MCP
 *    instructions and the core profile's tools/list, measured from the built
 *    server (scripts/measure-tool-surface.mjs).
 *  - Full dump, per turn: every live memory of the corpus.
 *  - No memory: nothing, and no answer.
 *  - "Answer in context": the share of answerable queries whose labelled memory
 *    is in what that approach put in context.
 *  - Characters are exact. Tokens are NOT estimated here: Claude's tokenizer is
 *    not available offline and a tiktoken-style count would read as measured
 *    while being wrong. The ratios hold whatever the characters-per-token rate.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkspace,
  memoryText,
  runAll,
  type BenchWorkspace,
  type CorpusName,
  type QueryOutcome,
} from "./relevance/harness.js";

const COMPACT_CHARS = 300;
const TOP_K = 5;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface Surface {
  instructionsChars: number;
  coreToolsBytes: number;
  fullToolsBytes: number;
}

function measureSurface(): Surface | null {
  try {
    const out = execFileSync(
      process.execPath,
      [join(REPO, "scripts/measure-tool-surface.mjs"), "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const b = JSON.parse(out).bytes;
    return {
      instructionsChars: b.instructionsChars,
      coreToolsBytes: b.coreBytes,
      fullToolsBytes: b.totalBytes,
    };
  } catch {
    return null; // MCP not built: reported, never guessed
  }
}

function served(ws: BenchWorkspace, o: QueryOutcome): { chars: number; labels: string[] } {
  if (o.response.nothingRelevant) return { chars: 0, labels: [] };
  const top = o.hits.slice(0, TOP_K);
  let chars = 0;
  const labels: string[] = [];
  for (const h of top) {
    const m = ws.memoryById.get(h.id);
    const text = m ? memoryText(m) : (h.content ?? "");
    chars += Math.min(text.length, COMPACT_CHARS);
    if (m) labels.push(m.key ?? m.label);
  }
  return { chars, labels };
}

interface Row {
  corpus: CorpusName;
  memories: number;
  queries: number;
  answerable: number;
  dumpChars: number;
  servedAvg: number;
  servedP95: number;
  mnemoAnswered: number;
}

async function runCorpus(name: CorpusName): Promise<Row> {
  const ws = await buildWorkspace(name);
  const live = ws.corpus.memories.filter((m) => m.state === "active");
  const dumpChars = live.reduce((n, m) => n + memoryText(m).length, 0);
  const outcomes = await runAll(ws, { limit: TOP_K });
  const sizes: number[] = [];
  let answerable = 0;
  let answered = 0;
  for (const o of outcomes) {
    const s = served(ws, o);
    sizes.push(s.chars);
    if (o.query.relevant.length === 0) continue;
    answerable++;
    if (s.labels.some((l) => o.query.relevant.includes(l))) answered++;
  }
  sizes.sort((a, b) => a - b);
  return {
    corpus: name,
    memories: live.length,
    queries: outcomes.length,
    answerable,
    dumpChars,
    servedAvg: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    servedP95: sizes[Math.min(sizes.length - 1, Math.ceil(0.95 * sizes.length) - 1)]!,
    mnemoAnswered: answered,
  };
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const n = (x: number) => x.toLocaleString("en-US");

async function main() {
  const surface = measureSurface();
  // The default profile serves all 37 tools; MNEMO_MCP_TOOLS=core serves 9.
  const fixedFull = surface ? surface.instructionsChars + surface.fullToolsBytes : null;
  const fixedCore = surface ? surface.instructionsChars + surface.coreToolsBytes : null;
  const rows = [await runCorpus("recall"), await runCorpus("agentsim")];

  const lines: string[] = [
    "| Corpus | Live memories | Full dump / turn | Mnemosyne served / turn (avg · p95) | Mnemosyne incl. fixed surface: 37 tools · core | Answer in context: dump · Mnemosyne · none |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of rows) {
    const withFixed =
      fixedFull === null || fixedCore === null
        ? "build MCP first"
        : `${n(r.servedAvg + fixedFull)} · ${n(r.servedAvg + fixedCore)}`;
    lines.push(
      `| ${r.corpus} | ${r.memories} | ${n(r.dumpChars)} | ${n(r.servedAvg)} · ${n(r.servedP95)} | ${withFixed} | 100% · ${pct(r.mnemoAnswered, r.answerable)} · 0% |`
    );
  }
  const notes = [
    "",
    "All sizes are characters per request.",
    surface
      ? `Fixed surface on every request: MCP instructions ${n(surface.instructionsChars)} + tools/list ${n(surface.fullToolsBytes)} with all 37 tools (default) = ${n(fixedFull!)}, or ${n(surface.coreToolsBytes)} with MNEMO_MCP_TOOLS=core = ${n(fixedCore!)}.`
      : "Fixed surface not measured: run `pnpm build` so the MCP server can be spawned.",
  ];
  if (fixedFull !== null && fixedCore !== null) {
    const r = rows[0]!;
    const perMemory = r.dumpChars / r.memories;
    const be = (fixed: number) => n(Math.ceil((fixed + r.servedAvg) / perMemory));
    notes.push(
      `Break-even: with memories averaging ${Math.round(perMemory)} characters (recall corpus), pasting everything costs less than Mnemosyne below about ${be(fixedFull)} memories with all 37 tools, or ${be(fixedCore)} with the core profile; above that the served context stays near ${n(r.servedAvg)} characters while the dump grows with every memory.`
    );
  }
  const report = lines.concat(notes).join("\n");
  console.log(report);
  const outIdx = process.argv.indexOf("--out");
  if (outIdx > 0 && process.argv[outIdx + 1])
    writeFileSync(process.argv[outIdx + 1]!, report + "\n");
}

void main();
