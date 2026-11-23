import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { redactPII } from "@mnemo-ai/core";
import type { AuthContext, Sensitivity } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { logger } from "../logging.js";
import { canReadSensitivity, resolveCeiling } from "../rbac.js";
import { resolveProvenance } from "../provenance.js";

/**
 * POST /capture
 *
 * Passive capture endpoint for automatic fact extraction from subagent output.
 * Called by the SubagentStop Claude Code hook when a subagent finishes.
 *
 * Extracts 0-3 durable facts from the provided content:
 * - When an LLM adapter is available: uses LLM-guided extraction.
 * - Fallback: regex heuristics for decision/bugfix/config patterns.
 *
 * Deduplicates via content-hash so repeated ingestion of the same output
 * does not produce duplicate facts.
 *
 * Returns { extracted, skipped } — skipped = dedup hits.
 */

const CaptureRequestSchema = z
  .object({
    content: z.string().min(1).max(100_000).openapi({
      description: "The text content to extract facts from (e.g. subagent stdout).",
    }),
    source: z.string().min(1).max(200).openapi({
      description: "Origin tag, e.g. 'subagent-stop', 'user-prompt-submit'.",
    }),
    parentSessionId: z.string().min(1).max(200).optional().openapi({
      description: "Optional parent session; must exist in the caller's workspace and ceiling.",
    }),
    scopeRef: z.string().min(1).max(200).optional(),
    agentId: z.string().min(1).max(200).optional(),
    sourceMessageId: z.string().min(1).max(200).optional(),
    trafficOrigin: z.string().min(1).max(64).optional(),
  })
  .openapi("CaptureRequest");

const CaptureResponseSchema = z
  .object({
    extracted: z.number().int().openapi({ description: "Number of new facts saved." }),
    skipped: z.number().int().openapi({ description: "Number of facts skipped due to dedup." }),
  })
  .openapi("CaptureResponse");

// ─── LLM-guided extraction ────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract 0-3 durable facts from this text. Each fact should be:
- One concise sentence in present tense
- Something worth remembering across sessions (decision, bug fix, config, discovery)
- NOT ephemeral (no "user asked X", no "I responded Y")

DO capture:
- Decisions made ("We switched to X because Y", "The team chose to use X")
- Bugs found or fixed ("The crash was caused by X", "Fixed the race condition in Y")
- Config or env values discovered ("The service runs on port X", "Environment variable X controls Y")
- Patterns or conventions established ("The project uses X pattern for Y")
- Important discoveries or gotchas ("Turns out X does not support Y", "Learned that X requires Z")

DO NOT capture:
- Tool call outputs or raw JSON/data blobs
- File contents or code listings
- Statements like "I will do X" or "Let me check X" (intent, not fact)
- Conversational filler ("Sure!", "OK, let me...", "Great question")
- Step-by-step instructions being followed in the moment

Return JSON array: [{"statement": "...", "kind": "decision|bugfix|config|discovery|architecture|preference|other"}]
If nothing worth extracting, return [].

Text:
`;

interface ExtractedFact {
  statement: string;
  kind: "decision" | "bugfix" | "config" | "discovery" | "architecture" | "preference" | "other";
  /** Confidence score in [0, 1]. Existing heuristic patterns default to 0.5;
   *  speculative regex-only patterns (URL, shell, error, port, version) use 0.3. */
  confidence?: number;
}

async function extractWithLlm(
  content: string,
  llmAdapter: NonNullable<ServerDeps["llmAdapter"]>
): Promise<ExtractedFact[]> {
  const truncated = content.length > 8000 ? content.slice(0, 8000) + "…" : content;
  const prompt = EXTRACTION_PROMPT + truncated;

  let raw: string;
  try {
    const out = await llmAdapter.generate({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 512,
      temperature: 0,
      task: "summary",
    });
    raw = out.content.trim();
  } catch (err) {
    // Bounded diagnostics only: the error message may echo transcript text.
    logger.warn(
      { reason: "generate_failed", errorName: err instanceof Error ? err.name : "unknown" },
      "capture.llm_generate_failed — falling back to heuristics"
    );
    return [];
  }

  // Strip markdown code fences if present
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    const validKinds = new Set([
      "decision",
      "bugfix",
      "config",
      "discovery",
      "architecture",
      "preference",
      "other",
    ]);
    return parsed
      .slice(0, 3)
      .filter(
        (item): item is ExtractedFact =>
          item &&
          typeof item === "object" &&
          typeof item.statement === "string" &&
          item.statement.length > 0 &&
          typeof item.kind === "string" &&
          validKinds.has(item.kind)
      );
  } catch {
    // Never log the raw model output (may echo secrets or transcript text).
    logger.debug(
      { reason: "json_parse_failed", outputChars: raw.length },
      "capture.llm_json_parse_failed"
    );
    return [];
  }
}

// ─── Regex heuristic extraction ───────────────────────────────────────────────

/**
 * Noise filter: returns true for lines that are unlikely to contain durable
 * facts. We skip tool outputs, raw data blobs, and conversational filler so
 * the real signal patterns (below) get cleaner input.
 *
 * Exported for unit testing.
 */
export function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  // Skip lines that look like JSON/code (start with {, [, }, <, or >>/>>> redirection).
  // A single > is allowed — it can be a shell prompt (e.g. "> docker run ...").
  if (/^\s*[{[\]}<]/.test(trimmed) || /^\s*>>/.test(trimmed)) return true;
  // Skip very short conversational filler
  if (/^(ok|sure|great|yes|no|done|thanks|okay)[!.,]?\s*$/i.test(trimmed)) return true;
  // Skip "I will / Let me / I'm going to" intent statements
  if (/\b(i will|let me|i'm going to|i'll|i am going to|i can)\b/i.test(trimmed)) return true;
  return false;
}

/** Exported for unit testing. */
export function extractWithHeuristics(content: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  // Track raw line content already claimed by the primary pass to prevent the
  // speculative pass from producing a duplicate entry for the same input.
  const claimedLines = new Set<string>();

  // ── Primary pass: split on sentence boundaries AND newlines ─────────────
  // Dots are included so complex sentences break cleanly.
  const sentences = content
    .split(/[.\n!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && s.length < 300)
    .filter((s) => !isNoiseLine(s));

  for (const line of sentences) {
    if (facts.length >= 3) break;

    const lower = line.toLowerCase();

    // Skip lines that look like shell prompts — they are handled by the speculative pass.
    // A "$" or ">" at the start indicates a shell command, not a prose sentence.
    if (/^[$>]\s+\S/.test(line)) {
      continue;
    }

    // Decisions — chose / switched / going with / using X instead of Y
    if (
      /\b(decided\s+to|chose|selected|going\s+with|switched\s+to|migrated\s+to|using\s+\w+\s+instead)\b/.test(
        lower
      )
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "decision" });
      claimedLines.add(line);
    }
    // Bug fixes — fixed / resolved / root cause / caused by / error was
    else if (
      /\b(fixed|resolved|bug|error\s+was|root\s+cause|caused\s+by|issue\s+was|the\s+problem)\b/.test(
        lower
      )
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "bugfix" });
      claimedLines.add(line);
    }
    // Config / env — must also contain an assignment-like pattern to avoid false positives.
    // Exclude bare PORT=N assignments (handled by the speculative port/service pattern).
    else if (
      /\b(config|env|environment|setting|variable|port|url|key|secret)\b/.test(lower) &&
      /[:=]/.test(line) &&
      !/\bPORT\s*=\s*\d{2,5}\b/.test(line)
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "config" });
      claimedLines.add(line);
    }
    // Discoveries / learnings
    else if (
      /\b(learned|discovered|found\s+out|turns\s+out|realized|noticed|gotcha|caveat|important\s+to\s+note)\b/.test(
        lower
      )
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "discovery" });
      claimedLines.add(line);
    }
    // Architecture patterns / conventions
    else if (
      /\b(architecture|pattern|convention|approach|design|structure)\b/.test(lower) &&
      /\b(uses?|follows?|requires?|established|adopted)\b/.test(lower)
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "architecture" });
      claimedLines.add(line);
    }
    // User / team preferences — must name a person/team to avoid generic advice
    else if (
      /\b(prefer|prefers|always|never|should|must\s+not|avoid)\b/.test(lower) &&
      /\b(user|pablo|team|project)\b/.test(lower)
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "preference" });
      claimedLines.add(line);
    }
  }

  // ── Speculative pass: newline-only split (preserves dots for URLs/versions) ─
  // All speculative patterns use confidence 0.3.
  // Lines already matched by the primary pass are skipped to avoid duplicates.
  const rawLines = content
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && s.length < 300)
    .filter((s) => !isNoiseLine(s));

  for (const line of rawLines) {
    if (facts.length >= 3) break;

    // Skip lines whose content (or any containing fragment) was already claimed
    // by the primary pass. A sentence fragment from the primary pass may be a
    // prefix of the full raw line, so we test both exact-match and containment.
    const alreadyClaimed = [...claimedLines].some(
      (claimed) => line.includes(claimed) || claimed.includes(line)
    );
    if (alreadyClaimed) continue;

    // Error type: well-known exception names followed by a colon
    // (Checked first because it may also contain URLs — error takes priority)
    if (
      /\b(TypeError|ReferenceError|SyntaxError|ENOENT|ECONNREFUSED|ETIMEDOUT|Exception):\s/.test(
        line
      )
    ) {
      const match = (
        line.match(
          /\b(TypeError|ReferenceError|SyntaxError|ENOENT|ECONNREFUSED|ETIMEDOUT|Exception):[^\n]{0,100}/
        ) as RegExpMatchArray
      )[0];
      facts.push({
        statement: `Error encountered: ${match.slice(0, 180)}`,
        kind: "discovery",
        confidence: 0.3,
      });
    }
    // URL reference
    else if (/https?:\/\/[^\s]{10,}/.test(line)) {
      const urlMatch = (line.match(/https?:\/\/[^\s]{10,}/) as RegExpMatchArray)[0];
      facts.push({
        statement: `URL referenced: ${urlMatch.slice(0, 180)}`,
        kind: "discovery",
        confidence: 0.3,
      });
    }
    // Shell command: starts with $ or > prompt character, or contains a
    // well-known tool+subcommand pair (e.g. "npm install", "git commit").
    else if (
      /^[$>]\s+\S/.test(line) ||
      /\b(npm\s+install|npm\s+run|pip\s+install|docker\s+run|docker\s+build|git\s+commit|git\s+push|git\s+clone|kubectl\s+apply|kubectl\s+get|yarn\s+add|brew\s+install)\b/.test(
        line
      )
    ) {
      facts.push({ statement: line.slice(0, 200), kind: "config", confidence: 0.3 });
    }
    // Port / service declaration
    // Matches "running on port N", "listening on port N", "PORT=N", or "PORT = N"
    else if (
      /\b(?:running\s+on|listening\s+on)\s+(?:port\s+)?\d{2,5}\b/i.test(line) ||
      /\bPORT\s*=\s*\d{2,5}\b/.test(line)
    ) {
      const portMatch = line.match(/\d{2,5}/) as RegExpMatchArray;
      facts.push({ statement: `Service on port ${portMatch[0]}`, kind: "config", confidence: 0.3 });
    }
    // Version declaration: semver-like token (e.g. 1.2.3, v4.2.0, @pkg@3.0.0)
    else if (/@?v?\d+\.\d+\.\d+/.test(line)) {
      const verMatch = (line.match(/@?v?\d+\.\d+\.\d+/) as RegExpMatchArray)[0];
      facts.push({ statement: `Version referenced: ${verMatch}`, kind: "config", confidence: 0.3 });
    }
  }

  return facts;
}

// ─── Content-hash dedup ───────────────────────────────────────────────────────

function contentHash(statement: string, workspaceId: string): string {
  return createHash("sha256")
    .update(`${workspaceId}:${statement.toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 16);
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountCapture(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/capture",
      tags: ["capture"],
      summary: "Passive capture: extract and store facts from subagent output.",
      request: {
        body: {
          content: { "application/json": { schema: CaptureRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Extraction complete.",
          content: { "application/json": { schema: CaptureResponseSchema } },
        },
        400: { description: "Invalid request body." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);

      // ── Parent correlation (SS05) ──────────────────────────────────────────
      // A supplied parent must exist in this workspace and sit under the
      // caller's ceiling. Missing, foreign and above-ceiling share one 404
      // body so the response never discloses that the session exists.
      // The validated parent's tier is carried onto every extracted fact:
      // remember() does not inherit it from sessionId and would otherwise
      // default to "internal", downgrading confidential/restricted content.
      let parentSensitivity: Sensitivity | undefined;
      if (body.parentSessionId !== undefined) {
        const parent = deps.storage
          ? await deps.storage.getSession(body.parentSessionId, workspaceId)
          : null;
        if (!parent || !canReadSensitivity(resolveCeiling(c), parent.sensitivity ?? undefined)) {
          throw new NotFoundError(`Session ${body.parentSessionId} not found.`);
        }
        parentSensitivity = parent.sensitivity ?? undefined;

        // ── Parent-result dedup (SS08) ──────────────────────────────────────
        // A subagent result already present in the validated parent (same
        // sourceMessageId and matching content) is not extracted again. Only
        // this workspace's parent is read; retracted turns are eligible.
        if (body.sourceMessageId !== undefined && deps.storage) {
          const turns = await deps.storage.listTurns(body.parentSessionId as string, workspaceId);
          const digest = createHash("sha256").update(body.content).digest("hex");
          const replayed = turns.some(
            (turn) =>
              turn.retractedAt === undefined &&
              turn.sourceMessageId === body.sourceMessageId &&
              (turn.content === body.content || turn.contentHash === digest)
          );
          if (replayed) {
            return c.json({ extracted: 0, skipped: 0 }, 200);
          }
        }
      }

      // Truncate very long content early — we only need enough for extraction.
      // Redact before any LLM/heuristic use; redact first so a secret cannot be
      // split by the truncation boundary.
      const redacted = redactPII(body.content);
      const content = redacted.length > 50_000 ? redacted.slice(0, 50_000) : redacted;

      // ── Extract facts ──────────────────────────────────────────────────────
      // Resolve workspace-specific LLM adapter (DB config → global → env boot).
      let effectiveLlmAdapter = deps.llmAdapter;
      if (deps.llmConfigResolver) {
        const { buildWorkspaceLlmAdapter } = await import("../config/WorkspaceLlmAdapter.js");
        effectiveLlmAdapter =
          (await buildWorkspaceLlmAdapter(workspaceId, deps.llmConfigResolver, deps.llmAdapter)) ??
          undefined;
      }

      let candidates: ExtractedFact[];
      if (effectiveLlmAdapter) {
        candidates = await extractWithLlm(content, effectiveLlmAdapter);
        // If LLM returned nothing, try heuristics as a safety net.
        if (candidates.length === 0) {
          candidates = extractWithHeuristics(content);
        }
      } else {
        candidates = extractWithHeuristics(content);
      }

      if (candidates.length === 0) {
        return c.json({ extracted: 0, skipped: 0 }, 200);
      }

      // ── Dedup and save ────────────────────────────────────────────────────
      let extracted = 0;
      let skipped = 0;

      // Build a set of hashes for candidates to detect in-batch duplication.
      const seenHashes = new Set<string>();

      for (const candidate of candidates) {
        const hash = contentHash(candidate.statement, workspaceId);

        // In-batch dedup (same content submitted twice in one call).
        if (seenHashes.has(hash)) {
          skipped++;
          continue;
        }
        seenHashes.add(hash);

        try {
          // Store via the canonical v3 write path (deps.cognitive.remember —
          // flatten-legacy-dual-core PR12, was the legacy core's createFact).
          // Same content/tags; the free-form attribution bag (source/captureKind/
          // contentHash/capturedAt) moves into `metadata` — remember()'s own
          // `attribution`/`provenance` concept is a fixed enum
          // (user_stated|inferred|...), not a free-form bag, so it is left
          // unset (defaults to "user_stated").
          const auth: AuthContext = {
            workspaceId,
            actorId: provenance.actorId,
            actorType: provenance.actorType,
            userId: provenance.userId,
            scopes: ["memory:write"],
          };
          await deps.cognitive.remember(
            {
              workspaceId,
              kind: "fact",
              content: candidate.statement,
              // SS06: parent session + project scope correlate the fact; agent and
              // source identity ride in metadata only. The authenticated actor is
              // always `auth.actorId` (from the key), never the body's agentId.
              // No episode/session is opened or closed here.
              sessionId: body.parentSessionId,
              scopeRef: body.scopeRef,
              ...(parentSensitivity ? { sensitivity: parentSensitivity } : {}),
              metadata: {
                source: body.source,
                captureKind: candidate.kind,
                contentHash: hash,
                capturedAt: new Date().toISOString(),
                agentId: body.agentId,
                sourceMessageId: body.sourceMessageId,
                trafficOrigin: body.trafficOrigin,
              },
              tags: ["passive-capture", candidate.kind],
            },
            auth
          );
          extracted++;
          logger.debug(
            { workspaceId, source: body.source, kind: candidate.kind },
            "capture.fact_saved"
          );
        } catch (err: unknown) {
          // Duplicate key error from the database (fact hash collision) = skip.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("conflict")) {
            skipped++;
          } else {
            // Re-throw unexpected errors so callers get a 500 with context.
            throw err;
          }
        }
      }

      logger.info(
        { workspaceId, source: body.source, extracted, skipped, total: candidates.length },
        "capture.complete"
      );

      return c.json({ extracted, skipped }, 200);
    }
  );
}
