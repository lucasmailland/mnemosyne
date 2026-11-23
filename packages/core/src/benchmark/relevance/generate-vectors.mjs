#!/usr/bin/env node
// BENCH-1 — regenerates vectors.json, the frozen embeddings the recall
// relevance benchmark runs on. CI never runs this: the benchmark reads the
// committed vectors, so it needs no model and no network.
//
// Run it only when corpus.json changes:
//
//   OLLAMA_URL=http://127.0.0.1:11435 node packages/core/src/benchmark/relevance/generate-vectors.mjs
//
// Every text the recall pipeline embeds is listed: fact statements, decision
// projections (`title body`, PRIMITIVE_TEXT_PROJECTION.decision) and query
// texts. Vectors are stored int8-quantised with one scale per vector (base64url,
// so no "/" can spell a path the API-path guard rejects), which
// keeps the file small and moves cosines by about 1e-3 — the benchmark's
// ceiling is computed from the same quantised vectors, so the comparison stays
// exact.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.EMBED_MODEL ?? "bge-m3";
const URL = `${process.env.OLLAMA_URL ?? "http://127.0.0.1:11435"}/api/embed`;

const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8"));

/** The text the write path embeds for a memory. Mirrors PRIMITIVE_TEXT_PROJECTION. */
export function memoryText(m) {
  if (m.kind === "decision") return [m.title ?? m.text, m.body].filter((s) => s).join(" ");
  return m.text;
}

const texts = new Set();
for (const name of ["recall", "agentsim"]) {
  for (const m of corpus[name].memories) texts.add(memoryText(m));
  for (const q of corpus[name].queries) texts.add(q.text);
}
const list = [...texts];

async function embed(batch) {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: batch }),
  });
  if (!res.ok) throw new Error(`embed failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).embeddings;
}

const vectors = {};
let dimensions = 0;
for (let i = 0; i < list.length; i += 32) {
  const batch = list.slice(i, i + 32);
  const out = await embed(batch);
  out.forEach((vec, j) => {
    dimensions = vec.length;
    const max = Math.max(...vec.map((x) => Math.abs(x)));
    const scale = max / 127;
    const q = Int8Array.from(vec, (x) => Math.round(x / scale));
    vectors[batch[j]] = { s: scale, q: Buffer.from(q.buffer).toString("base64url") };
  });
}

writeFileSync(
  join(here, "vectors.json"),
  JSON.stringify({
    model: MODEL,
    dimensions,
    quantization: "int8, one scale per vector, base64url",
    vectors,
  }) + "\n"
);
console.log(`wrote ${list.length} vectors (${MODEL}, ${dimensions} dims)`);
