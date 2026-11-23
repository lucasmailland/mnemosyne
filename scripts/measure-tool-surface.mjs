#!/usr/bin/env node
/**
 * Measure what Mnemosyne's MCP tool surface costs a client's context window.
 *
 * Tool schemas render at **position 0** of an Anthropic API request — ahead of
 * `system` and ahead of `messages` — so every byte here is paid on every request,
 * before any task context, whether or not the tool is called. That makes the tool
 * surface a context-budget question, not only an API-design question. See
 * `docs/research/MEMORY_VALUE_MODEL.md` §3.4 for the analysis this script produced
 * and gap V5 for the open question it informs.
 *
 * What it measures: the exact `tools/list` payload an MCP client receives and
 * renders into the request's `tools` parameter. It spawns the BUILT server
 * (`packages/mcp/dist/index.js`) over stdio and speaks JSON-RPC to it — no HTTP
 * backend is contacted, because `tools/list` is served from the in-process registry
 * populated at boot. A placeholder `MNEMO_URL`/`MNEMO_KEY` is enough.
 *
 * Two tiers of output:
 *
 *   1. BYTES — always produced, exact, and the source of every ratio-independent
 *      finding (payload concentration, schema-vs-description split, core-vs-deferred).
 *   2. TOKENS — produced only when an Anthropic credential is available. Bytes are
 *      not tokens, and `tiktoken`-style estimators are wrong for Claude by a wide
 *      margin, so the token figure comes from `messages.count_tokens` or not at all.
 *      Without a credential the script reports the byte analysis and says what is
 *      missing rather than guessing.
 *
 * Usage:
 *   pnpm build                                    # dist/ must exist
 *   node scripts/measure-tool-surface.mjs         # bytes only
 *   ANTHROPIC_API_KEY=sk-... node scripts/measure-tool-surface.mjs   # bytes + tokens
 *   node scripts/measure-tool-surface.mjs --json --out surface.json
 *
 * Options:
 *   --server <path>  Path to the built MCP entrypoint (default: packages/mcp/dist/index.js)
 *   --model <id>     Model to count tokens against (default: claude-opus-5)
 *   --out <file>     Write the full JSON report to a file
 *   --json           Print JSON to stdout instead of the human-readable report
 *   --timeout <ms>   Handshake timeout (default: 20000)
 *
 * Exit codes: 0 on success, 1 on handshake failure or missing build.
 *
 * ---------------------------------------------------------------------------
 * DEFERRED, ON PURPOSE: the token count has never been run, and that is fine.
 * ---------------------------------------------------------------------------
 *
 * `MEMORY_VALUE_MODEL.md` §3.4 carries a token RANGE (~19-25K for the full
 * surface, ~4-5K for the core 6) derived from the byte figures at the ~3-4
 * chars/token typical of punctuation-dense JSON. It is labelled an estimate
 * wherever it appears, and the byte figures beside it are exact.
 *
 * That is enough for every argument the document actually makes: payload
 * concentration, the schema-vs-description split, and core-vs-deferred are all
 * ratio-independent — they hold at any conversion rate. The token number would
 * sharpen the framing, not change a conclusion.
 *
 * It stays deferred because running it needs an Anthropic API key, and the
 * people who work on this project mostly use a Claude subscription, which
 * exposes no API. Rather than make a research number depend on a credential
 * nobody has to hand, the estimate is accepted and marked as one.
 *
 * If you ever do have a key, this is the whole procedure — three
 * `messages.count_tokens` calls, no output tokens, negligible cost:
 *
 *     pnpm build
 *     ANTHROPIC_API_KEY=sk-... node scripts/measure-tool-surface.mjs
 *
 * then replace the range in `docs/research/MEMORY_VALUE_MODEL.md` §3.4 with the
 * measured figures and drop the "estimate" wording around them. Do NOT swap in
 * a tiktoken-style number instead: it would read as measured while being a
 * guess, which is worse than the honest range it replaced.
 */
import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * The `core` profile (MNEMO_MCP_TOOLS=core; full is the default): keep in step with
 * CORE_TOOL_NAMES in packages/mcp/src/registry.ts. The byte budget itself is a
 * test, packages/mcp/src/__tests__/tool-surface-budget.test.ts; this script adds
 * the per-tool breakdown and, with a credential, the token count.
 */
const CORE_TOOLS = [
  "memory_recall",
  "memory_fact",
  "memory_remember",
  "memory_decide",
  "memory_update",
  "memory_forget",
  "memory_search",
  "memory_status",
  "memory_context",
];

/** Below this, a tool description is likely under-specified (Anthropic tool-description guidance). */
const SHORT_DESCRIPTION_CHARS = 120;

function parseArgs(argv) {
  const opts = {
    server: join(REPO_ROOT, "packages/mcp/dist/index.js"),
    model: "claude-opus-5",
    out: null,
    json: false,
    timeout: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server") opts.server = resolve(argv[++i]);
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
  }
  return opts;
}

/**
 * Speak MCP over stdio to the built server and return its `tools/list` result.
 * Resolves with the raw tools array exactly as a client would receive it.
 */
export function fetchToolList(serverPath, timeoutMs = 20000) {
  return fetchSurface(serverPath, timeoutMs).then((s) => s.tools);
}

/** tools/list plus the instructions the server sends in `initialize`. */
export function fetchSurface(serverPath, timeoutMs = 20000) {
  let instructions = "";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // tools/list never reaches the backend; placeholders keep boot from failing.
        MNEMO_URL: process.env.MNEMO_URL ?? "http://localhost:3939",
        MNEMO_KEY: process.env.MNEMO_KEY ?? "mns_live_placeholder",
        // Measure every tool (full, the default, set explicitly so a parent shell
        // cannot narrow it); the core figures are the CORE_TOOLS subset.
        MNEMO_MCP_TOOLS: "full",
      },
    });

    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for tools/list`));
    }, timeoutMs);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(arg);
    };

    child.on("error", (err) => finish(reject, err));

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON stdout noise
        }
        if (msg.id === 1) {
          instructions = msg.result?.instructions ?? "";
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
          );
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
          );
        } else if (msg.id === 2) {
          if (msg.error)
            finish(reject, new Error(`tools/list failed: ${JSON.stringify(msg.error)}`));
          else finish(resolvePromise, { tools: msg.result?.tools ?? [], instructions });
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "measure-tool-surface", version: "1.0.0" },
        },
      }) + "\n"
    );
  });
}

/** Byte-level breakdown. Exact, and the basis for every ratio-independent finding. */
export function analyzeBytes(tools) {
  const perTool = tools
    .map((t) => ({
      name: t.name,
      bytes: JSON.stringify(t).length,
      descriptionBytes: (t.description ?? "").length,
      inputSchemaBytes: JSON.stringify(t.inputSchema ?? {}).length,
      outputSchemaBytes: JSON.stringify(t.outputSchema ?? null).length,
      hasOutputSchema: t.outputSchema != null,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const total = perTool.reduce((n, r) => n + r.bytes, 0);
  const sum = (k) => perTool.reduce((n, r) => n + r[k], 0);

  // How many of the largest tools account for half the payload.
  let acc = 0;
  let toolsForHalf = 0;
  for (const r of perTool) {
    acc += r.bytes;
    toolsForHalf++;
    if (acc >= total / 2) break;
  }

  const coreBytes = perTool
    .filter((r) => CORE_TOOLS.includes(r.name))
    .reduce((n, r) => n + r.bytes, 0);

  return {
    toolCount: perTool.length,
    totalBytes: total,
    descriptionBytes: sum("descriptionBytes"),
    inputSchemaBytes: sum("inputSchemaBytes"),
    outputSchemaBytes: sum("outputSchemaBytes"),
    toolsForHalfOfPayload: toolsForHalf,
    coreBytes,
    deferredBytes: total - coreBytes,
    toolsWithOutputSchema: perTool.filter((r) => r.hasOutputSchema).length,
    underDescribed: perTool
      .filter((r) => r.descriptionBytes < SHORT_DESCRIPTION_CHARS)
      .map((r) => ({ name: r.name, descriptionBytes: r.descriptionBytes })),
    perTool,
  };
}

/**
 * Authoritative token count via `messages.count_tokens`, counting the tools array
 * as it actually renders. Returns null when no credential is configured — never
 * estimates, because byte-ratio estimators are wrong for Claude's tokenizer.
 *
 * The baseline subtraction isolates the tools' own cost from the minimal message
 * that `count_tokens` requires alongside them.
 */
export async function countTokens(tools, model) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    return { error: "@anthropic-ai/sdk is not installed — run: pnpm add -w -D @anthropic-ai/sdk" };
  }

  const client = new Anthropic();
  const probe = [{ role: "user", content: "." }];
  const asApiTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? { type: "object", properties: {} },
  }));

  try {
    const [withTools, baseline] = await Promise.all([
      client.messages.countTokens({ model, messages: probe, tools: asApiTools }),
      client.messages.countTokens({ model, messages: probe }),
    ]);
    const coreSet = new Set(CORE_TOOLS);
    const coreOnly = await client.messages.countTokens({
      model,
      messages: probe,
      tools: asApiTools.filter((t) => coreSet.has(t.name)),
    });
    return {
      model,
      baselineTokens: baseline.input_tokens,
      allToolsTokens: withTools.input_tokens - baseline.input_tokens,
      coreToolsTokens: coreOnly.input_tokens - baseline.input_tokens,
    };
  } catch (err) {
    return { error: `count_tokens failed: ${err?.message ?? String(err)}` };
  }
}

function pct(part, whole) {
  return whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

function printReport(bytes, tokens) {
  const b = bytes;
  console.log(
    `MCP tool surface — ${b.toolCount} tools, ${b.totalBytes.toLocaleString()} bytes (compact JSON)\n`
  );
  console.log(
    `  inputSchema   ${String(b.inputSchemaBytes).padStart(7)} B   ${pct(b.inputSchemaBytes, b.totalBytes)}`
  );
  console.log(
    `  descriptions  ${String(b.descriptionBytes).padStart(7)} B   ${pct(b.descriptionBytes, b.totalBytes)}`
  );
  console.log(
    `  outputSchema  ${String(b.outputSchemaBytes).padStart(7)} B   ${pct(b.outputSchemaBytes, b.totalBytes)}`
  );
  console.log("");
  console.log(`  concentration        top ${b.toolsForHalfOfPayload} tools = 50% of the payload`);
  console.log(
    `  core ${CORE_TOOLS.length} (opt-in)        ${b.coreBytes} B (${pct(b.coreBytes, b.totalBytes)})`
  );
  console.log(
    `  remaining ${b.toolCount - CORE_TOOLS.length}          ${b.deferredBytes} B (${pct(b.deferredBytes, b.totalBytes)})`
  );
  console.log(`  declaring outputSchema  ${b.toolsWithOutputSchema}/${b.toolCount}`);
  console.log(
    `  under-described (<${SHORT_DESCRIPTION_CHARS} chars)  ${b.underDescribed.length}/${b.toolCount}`
  );
  console.log("");
  console.log("  Top 10 by size:");
  for (const r of b.perTool.slice(0, 10)) {
    console.log(
      `    ${r.name.padEnd(28)} ${String(r.bytes).padStart(6)} B   desc ${String(r.descriptionBytes).padStart(5)}  in ${String(r.inputSchemaBytes).padStart(6)}`
    );
  }
  console.log("");

  if (!tokens) {
    console.log("  TOKENS: not counted — no Anthropic credential found.");
    console.log("    Set ANTHROPIC_API_KEY (or run `ant auth login`) and re-run to get the");
    console.log("    authoritative count. Do NOT substitute a tiktoken-style estimate:");
    console.log("    it is wrong for Claude's tokenizer, materially so on punctuation-dense JSON.");
  } else if (tokens.error) {
    console.log(`  TOKENS: ${tokens.error}`);
  } else {
    console.log(`  TOKENS (${tokens.model}, via messages.count_tokens):`);
    console.log(`    all ${b.toolCount} tools   ${tokens.allToolsTokens.toLocaleString()} tokens`);
    console.log(
      `    core ${CORE_TOOLS.length} only    ${tokens.coreToolsTokens.toLocaleString()} tokens`
    );
    console.log(`    (paid at position 0 of every request, before system and messages)`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.server)) {
    console.error(`Built MCP server not found at ${opts.server}`);
    console.error("Run `pnpm build` first, or pass --server <path>.");
    process.exit(1);
  }

  let tools;
  let instructions = "";
  try {
    ({ tools, instructions } = await fetchSurface(opts.server, opts.timeout));
  } catch (err) {
    console.error(`Failed to read tools/list: ${err.message}`);
    process.exit(1);
  }

  const bytes = { ...analyzeBytes(tools), instructionsChars: instructions.length };
  const tokens = await countTokens(tools, opts.model);
  const report = { measuredAt: new Date().toISOString(), server: opts.server, bytes, tokens };

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(report, null, 2));
    console.error(`report written to ${opts.out}`);
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(bytes, tokens);
}

// Only run when invoked directly, so the exported helpers stay importable from tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
