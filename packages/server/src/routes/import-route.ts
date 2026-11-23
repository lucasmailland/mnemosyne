import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { applyIngestSafety, piiMetadata } from "@mnemo-ai/core";
import { SENSITIVITY_ORDER, type MnemoFact, type Sensitivity } from "@mnemo-ai/types";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { HttpError, ForbiddenError, BadRequestError, ServiceUnavailableError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { canReadSensitivity, resolveCeiling } from "../rbac.js";
import { JSONL_FORMAT_VERSION } from "./export.js";
import {
  normalizeImport,
  type ImportVendor,
  type ConflictResolution,
} from "./importNormalizers.js";

/**
 * POST /import — Wave V §29 JSONL import
 *
 * Accepts a gzip-compressed JSONL file (same format as GET /export/jsonl).
 * The first line must be a valid mnemo-export-v1 header.
 *
 * Imports the following entity types (round-trips a GET /export/jsonl file):
 *   fact, decision, episode, entity, strategy, workflow, skill, reminder, task, event, reasoning, hyperedge, relation
 *
 * The remaining two exported types are skipped EXPLICITLY (counted under
 * `skippedByReason`, never silently):
 *   - citation        — no storage write path (no createCitation port)
 *   - webhook_endpoint — its secret is redacted on export, so it cannot be
 *                        re-imported as a working endpoint
 *
 * Every import is idempotent: re-importing the same file is a no-op for rows
 * that already exist (honoring the ?conflictResolution=skip|overwrite|newest
 * query param). Events are immutable and are create-if-absent only.
 *
 * SEC-2: import is a write path for the same rows remember() writes, so every
 * memory-bearing text field runs remember()'s ingest gate first. A line whose
 * text fails the poisoning gate is skipped as "poisoning-rejected" (nothing is
 * written for it); PII is redacted before storage and recorded in
 * `metadata.pii`. PRIM-15: facts keep their sensitivity, pinned flag, topic
 * key and lifecycle (a forgotten fact comes back closed), and carry the
 * importer's provenance unless a memory:admin restore preserves the file's.
 *
 * Scope required: memory:write (same as remember).
 * The import is scoped to the authenticated workspace — cross-workspace
 * imports are rejected even if the file contains a different workspaceId.
 *
 * Returns a summary of rows processed per entity type.
 */

const ImportResponseSchema = z
  .object({
    imported: z.record(z.string(), z.number().int()),
    /** Total number of lines skipped (sum of skippedByReason values). */
    skipped: z.number().int(),
    /** Per-type, per-reason skip breakdown so no skip is silent. */
    skippedByReason: z.record(z.string(), z.record(z.string(), z.number().int())),
    errors: z.number().int(),
    workspaceId: z.string(),
    sourceWorkspaceId: z.string(),
    totalLines: z.number().int(),
  })
  .openapi("ImportResponse");

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: ["import"],
  summary:
    "Import workspace memory from a gzip JSONL file (produced by GET /export/jsonl). Requires memory:write scope.",
  request: {
    body: {
      content: {
        "application/octet-stream": { schema: z.string() },
        "application/x-ndjson": { schema: z.string() },
      },
      description: "Gzip-compressed JSONL export file.",
      required: true,
    },
  },
  responses: {
    200: {
      description: "Import summary.",
      content: { "application/json": { schema: ImportResponseSchema } },
    },
    400: { description: "Invalid file format." },
    401: { description: "Unauthorized." },
    403: { description: "Insufficient scope." },
    413: { description: "Request body exceeds the 100 MiB import size limit." },
    415: { description: "Unsupported media type — send gzip JSONL." },
  },
});

const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MiB

/** What an import may inflate to; MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES, default 512 MiB. */
export function maxDecompressedBytes(): number {
  const raw = Number(process.env["MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES"]);
  return Number.isInteger(raw) && raw > 0 ? raw : 512 * 1024 * 1024;
}

const SENSITIVITIES: ReadonlySet<string> = new Set(Object.keys(SENSITIVITY_ORDER));
const FACT_STATUSES: ReadonlySet<string> = new Set(["active", "merged", "forgotten"]);
/** What the column encryption writes for confidential/restricted text (fact-cryptor.ts). */
const ENCRYPTED_PREFIX = "enc:v1:";

/** Skips the current line under an explicit reason instead of counting an error. */
/** Line types whose rows carry a sensitivity tier (and so the read ceiling). */
const SENSITIVITY_BEARING = new Set([
  "fact",
  "episode",
  "skill",
  "task",
  "event",
  "reasoning",
  "decision",
  "entity",
  "strategy",
  "workflow",
]);

class ImportLineSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * SEC-2: keys whose string values are identifiers, enums, timestamps or keys
 * rather than memory text. They bypass the gate so redaction can never rewrite
 * an id or a topic key. Every other string, at any depth — workflow steps,
 * reasoning chains, entity names and aliases, fact subjects — goes through
 * remember()'s gate. `metadata`/`evidence` are opaque caller bags carried as-is.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "workspaceId",
  "agentId",
  "actorId",
  "userId",
  "actorType",
  "sessionId",
  "conversationId",
  "decidedByUserId",
  "delegatedBy",
  "assignedTo",
  "parentTaskId",
  "canonicalId",
  "episodeId",
  "entityId",
  "scopeRef",
  "scopeOwner",
  "topicKey",
  "kind",
  "type",
  "status",
  "priority",
  "sensitivity",
  "scope",
  "attribution",
  "relation",
  "verb",
  "source_kind",
  "target_kind",
  "sourceKind",
  "targetKind",
  "sourceType",
  "targetType",
  "source_id",
  "target_id",
  "sourceId",
  "targetId",
  "memberIds",
  "relatedFacts",
  "relatedEntities",
  "blockedBy",
  "subtaskIds",
  "embeddingModel",
  "validFrom",
  "validTo",
  "createdAt",
  "updatedAt",
  "occurredAt",
  "triggerAt",
  "dueAt",
  "startedAt",
  "completedAt",
]);
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["metadata", "evidence"]);

/**
 * V-7: the import identity of a fact line that carries no `id` (a hand-written
 * or vendor file). Without one, re-importing the line created another row each
 * time — a closed one on every import, since the topicKey fallback only matches
 * a live fact. It covers what makes the line the same memory over the same
 * interval, as written in the file, so a forgotten copy and a live copy of one
 * statement stay two rows. Stored as `metadata.importedId`, where a line with an
 * id keeps that id; the prefix keeps the two apart.
 */
function factLineIdentity(data: Record<string, unknown>): string {
  const fields = [
    "statement",
    "subject",
    "kind",
    "scope",
    "scopeRef",
    "topicKey",
    "status",
    "validFrom",
    "validTo",
  ].map((k) => (data[k] === undefined || data[k] === null ? null : String(data[k])));
  return `content:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

/** @throws PoisoningRejectedError when any gated string fails the poisoning gate. */
function gateImportValue(value: unknown, key: string, pii: Set<string>): unknown {
  if (typeof value === "string") {
    if (STRUCTURAL_KEYS.has(key)) return value;
    const safe = applyIngestSafety(value);
    for (const cat of safe.piiCategories) pii.add(cat);
    return safe.content;
  }
  if (Array.isArray(value)) return value.map((v) => gateImportValue(v, key, pii));
  if (value !== null && typeof value === "object") {
    if (OPAQUE_KEYS.has(key)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, gateImportValue(v, k, pii)])
    );
  }
  return value;
}

export function mountImport(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(importRoute, async (c) => {
    const { workspaceId, scopes } = getAuthCtx(c);

    if (!scopes?.includes("memory:write")) {
      throw new ForbiddenError("Insufficient scope", { required: "memory:write" });
    }

    // actor_id is a security boundary (ownership checks, RLS actor isolation) — an
    // uploaded file must never be allowed to forge it to match another principal's
    // identity. Only memory:admin (trusted restore/migration flows) may carry the
    // file's actorId through; everyone else gets provenance-unknown (undefined),
    // never a caller-supplied value.
    const canPreserveActorId = scopes.includes("memory:admin");
    // A row above the caller's ceiling does not exist for this import: a line
    // naming it is imported as a new row, exactly as for an id that names
    // nothing, and is never overwritten, skipped or counted against it.
    const ceiling = resolveCeiling(c);
    const visible = <T extends { sensitivity?: string }>(row: T | null | undefined) =>
      row && canReadSensitivity(ceiling, row.sensitivity) ? row : null;
    // PRIM-15: everyone else's rows carry the importer's own provenance, not
    // none — a confidential fact cannot even be encrypted without an actor.
    const provenance = resolveProvenance(c);

    if (!deps.storage) {
      throw new ServiceUnavailableError("Storage adapter not available");
    }
    // Local non-null binding so TS keeps the narrowed type inside closures below.
    const storage = deps.storage;

    // Read raw body
    const rawBody = await c.req.arrayBuffer();
    if (rawBody.byteLength > MAX_IMPORT_BYTES) {
      throw new HttpError(413, "payload_too_large", "Payload too large", {
        maxBytes: MAX_IMPORT_BYTES,
      });
    }

    // Decompress
    let jsonlText: string;
    try {
      // APP-028: inflate with a ceiling. Without one a few hundred KB of gzip
      // became hundreds of MB on the event loop, for every tenant at once.
      const decompressed = gunzipSync(Buffer.from(rawBody), {
        maxOutputLength: maxDecompressedBytes(),
      });
      jsonlText = decompressed.toString("utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new HttpError(413, "payload_too_large", "Payload too large", {
          maxDecompressedBytes: maxDecompressedBytes(),
        });
      }
      // Try treating as plain text (not gzipped): JSONL, or a vendor's JSON
      // array, which may be pretty-printed and so has no parseable first line.
      try {
        jsonlText = Buffer.from(rawBody).toString("utf8");
        if (!c.req.query("from")) JSON.parse(jsonlText.split("\n")[0] ?? "");
      } catch {
        throw new BadRequestError("Could not decompress or parse body as JSONL", {
          code: "invalid_format",
        });
      }
    }

    const fromVendor = c.req.query("from") as ImportVendor | undefined;
    const conflictResolution =
      (c.req.query("conflictResolution") as ConflictResolution | undefined) ?? "skip";
    let lines: string[];
    if (fromVendor) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonlText);
      } catch {
        throw new BadRequestError("--from imports expect a JSON array", { code: "invalid_format" });
      }
      if (!Array.isArray(parsed)) {
        throw new BadRequestError("--from imports expect a JSON array", { code: "invalid_format" });
      }
      lines = normalizeImport(fromVendor, parsed, workspaceId).map((l) => JSON.stringify(l));
    } else {
      lines = jsonlText.split("\n").filter((l) => l.trim().length > 0);
    }
    if (lines.length === 0) {
      throw new BadRequestError("No non-empty lines found in import body", { code: "empty_file" });
    }

    // Validate header
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(lines[0]!) as Record<string, unknown>;
    } catch {
      throw new BadRequestError("First line must be valid JSON", { code: "invalid_header" });
    }

    if (header["version"] !== JSONL_FORMAT_VERSION) {
      throw new BadRequestError("Unsupported export version", { code: "version_mismatch" });
    }

    const sourceWorkspaceId = (header["workspaceId"] as string | undefined) ?? workspaceId;

    // Process entity lines
    const imported: Record<string, number> = {};
    // Per-type, per-reason skip breakdown so every skip is explicit (F13).
    const skippedByReason: Record<string, Record<string, number>> = {};
    let errors = 0;

    /**
     * Record one skipped line under (type, reason). Reasons used:
     *  - "no-type"          : line had no _type discriminator
     *  - "header"           : the header line (expected, not an entity)
     *  - "unknown-type"     : _type not recognised
     *  - "duplicate"        : an entity with this id already exists and conflictResolution=skip
     *  - "conflict"         : an entity with this id exists and cannot be overwritten (immutable)
     *  - "immutable-exists" : event/citation already present (events are append-only)
     *  - "secret-redacted"  : webhook_endpoint secret was redacted on export — cannot re-import
     *  - "no-import-path"   : type has no storage write path (citation)
     *  - "invalid-members"  : hyperedge had < 3 members
     *  - "poisoning-rejected": a text field failed remember()'s poisoning gate (SEC-2)
     *  - "invalid-field"    : a sensitivity, fact status or fact validity range that is not valid
     *  - "encrypted-at-source": a fact statement exported as ciphertext (its DEK is not in the file)
     *  - "topic-key-exists" : (skip mode) an active fact already holds the line's topicKey
     *  - "not-newer"        : (newest mode) the existing fact is as new as the line or newer
     *  - "sensitivity-conflict": overwriting would put more sensitive text in a less sensitive row
     *  - "above-ceiling"    : the line's sensitivity is above the caller's read ceiling
     *  - "closed-exists"    : (overwrite/newest) the matching fact is closed; closed history
     *                         is never rewritten or reopened by an import
     */
    const skip = (type: string, reason: string): void => {
      const byReason = (skippedByReason[type] ??= {});
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    };

    for (const line of lines.slice(1)) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        errors++;
        continue;
      }

      const type = record["_type"] as string | undefined;
      if (!type) {
        skip("unknown", "no-type");
        continue;
      }

      // Strip the discriminator. `data` is replaced by its gated copy before
      // any field is read for a write (SEC-2, below).
      const { _type: _discarded, ...raw } = record;
      let data: Record<string, unknown> = raw;
      // Helper for safe extraction
      const str = (k: string, def = "") => (data[k] as string | undefined) ?? def;
      const num = (k: string, def: number) => (data[k] as number | undefined) ?? def;
      const bool = (k: string, def: boolean) => (data[k] as boolean | undefined) ?? def;
      const meta = (k: string) => (data[k] as Record<string, unknown> | undefined) ?? {};
      const date = (k: string): Date | undefined =>
        data[k] ? new Date(data[k] as string) : undefined;
      const strArr = (k: string): string[] =>
        Array.isArray(data[k]) ? (data[k] as unknown[]).map((v) => String(v)) : [];
      // PII categories the gate redacted anywhere in this line; `withPii`
      // stamps them on the row's metadata.
      const piiFound = new Set<string>();
      const withPii = (metadata: Record<string, unknown>): Record<string, unknown> =>
        piiFound.size > 0
          ? { ...metadata, pii: piiMetadata([...piiFound] as Parameters<typeof piiMetadata>[0]) }
          : metadata;
      const sensitivityField = (): Sensitivity | undefined => {
        const v = data["sensitivity"];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "string" || !SENSITIVITIES.has(v))
          throw new ImportLineSkip("invalid-field");
        return v as Sensitivity;
      };
      /** A line must never write more sensitive text into a less sensitive row. */
      const raisesTier = (sensitivity: Sensitivity | undefined, existing: Sensitivity) =>
        SENSITIVITY_ORDER[sensitivity ?? "internal"] > SENSITIVITY_ORDER[existing];

      try {
        // A confidential/restricted fact statement is exported as stored —
        // ciphertext under a DEK the file does not carry. There is nothing to
        // restore, and storing it as text would only be garbage.
        // Likewise a fact exported while its key was gone (`redacted`): its
        // text is a placeholder, not something to store.
        if (
          type === "fact" &&
          ((typeof raw["statement"] === "string" &&
            raw["statement"].startsWith(ENCRYPTED_PREFIX)) ||
            raw["redacted"] !== undefined)
        ) {
          skip("fact", "encrypted-at-source");
          continue;
        }
        // SEC-2: the whole line goes through remember()'s gate before anything
        // is written — every free-text string at any depth (workflow steps,
        // reasoning chains, entity names and aliases, fact subjects…). A
        // poisoned field throws and the line is skipped as "poisoning-rejected".
        data = gateImportValue(raw, "", piiFound) as Record<string, unknown>;
        // PRIM-15: every sensitivity-bearing primitive keeps its tier.
        const sensitivity = sensitivityField();
        // V-5 / PRIM-14, as on every create route: a line above the caller's
        // read ceiling is not stored (the caller could never read it back) and
        // is matched against nothing. Decided from the line alone, so the skip
        // says nothing about what the workspace holds.
        if (SENSITIVITY_BEARING.has(type) && !canReadSensitivity(ceiling, sensitivity)) {
          throw new ImportLineSkip("above-ceiling");
        }

        switch (type) {
          case "fact": {
            const existingId = str("id");
            const statusIn = data["status"];
            if (
              statusIn !== undefined &&
              (typeof statusIn !== "string" || !FACT_STATUSES.has(statusIn))
            ) {
              throw new ImportLineSkip("invalid-field");
            }
            const status = statusIn as MnemoFact["status"] | undefined;
            const topicKey = str("topicKey") || undefined;
            // A closed status with no end date is closed now, never left open.
            // validFrom must not land after validTo (the row's validity range
            // rejects it), so a closed row with no start starts when it ended.
            const validTo =
              date("validTo") ?? (status && status !== "active" ? new Date() : undefined);
            const validFrom =
              date("validFrom") ??
              (validTo && validTo.getTime() <= Date.now() ? validTo : undefined);
            if (validFrom && validTo && validTo.getTime() < validFrom.getTime()) {
              throw new ImportLineSkip("invalid-field");
            }

            // Identity, resolved in EVERY conflictResolution mode (PRIM-15):
            // the same id in this workspace (a re-import into the source
            // workspace), or a row an earlier import stamped with
            // `metadata.importedId` — searched over the WHOLE workspace, open or
            // closed; the old scan read only the first 20 rows, and ran only for
            // `skip`, so every overwrite/newest re-import added a copy. A line
            // with no id is identified by its content (V-7). Failing that, the
            // live fact holding the line's topicKey is the same memory under its
            // idempotency key (one live fact per key).
            const importKey = existingId || factLineIdentity(data);
            let targetIs = "duplicate";
            let target: MnemoFact | null =
              visible(existingId ? await storage.getFact(existingId, workspaceId) : null) ??
              visible(
                storage.findFactByImportedId
                  ? await storage.findFactByImportedId(workspaceId, importKey)
                  : ((await storage.queryFacts({ workspaceId })).items.find(
                      (f) =>
                        (f.metadata as { importedId?: string } | undefined)?.importedId ===
                        importKey
                    ) ?? null)
              );
            if (!target && topicKey && (status ?? "active") === "active") {
              const live = await storage.queryFacts({
                workspaceId,
                topicKey,
                status: "active",
                maxSensitivity: ceiling,
                limit: 1,
              });
              target = live.items[0] ?? null;
              targetIs = "topic-key-exists";
            }

            if (target) {
              if (conflictResolution === "skip") {
                skip("fact", targetIs);
                break;
              }
              // V-7: a closed row is history. updateFact refuses new text on it
              // (and reopening could take a topicKey a live fact now holds), so
              // the line is skipped — it used to be counted as imported while
              // nothing changed.
              if (target.validTo || target.status !== "active") {
                skip("fact", "closed-exists");
                break;
              }
              if (conflictResolution === "newest") {
                const fileUpdatedAt = date("updatedAt") ?? date("createdAt");
                if (!fileUpdatedAt || fileUpdatedAt.getTime() <= target.updatedAt.getTime()) {
                  skip("fact", "not-newer");
                  break;
                }
              }
              // updateFact cannot change a row's tier; writing more sensitive
              // text into a less sensitive row would be the downgrade PRIM-15 is.
              if (raisesTier(sensitivity, target.sensitivity)) {
                skip("fact", "sensitivity-conflict");
                break;
              }
              const targetMeta = (target.metadata ?? {}) as Record<string, unknown>;
              const updated = await storage.updateFact(target.id, workspaceId, {
                statement: str("statement"),
                subject: str("subject", target.subject),
                kind: (str("kind") || target.kind) as MnemoFact["kind"],
                confidence: num("confidence", target.confidence),
                ...(typeof data["pinned"] === "boolean" ? { pinned: data["pinned"] } : {}),
                ...(status ? { status, validTo: status === "active" ? null : validTo } : {}),
                metadata: {
                  ...targetMeta,
                  ...withPii(meta("metadata")),
                  // Keep the identity findable by the next import.
                  importedId: existingId
                    ? existingId !== target.id
                      ? existingId
                      : targetMeta["importedId"]
                    : (targetMeta["importedId"] ?? importKey),
                },
              });
              // The adapter refused the update (a row mid-consolidation): an
              // explicit skip, not a count of something that did not happen.
              if (!updated) {
                skip("fact", "conflict");
                break;
              }
              imported["fact"] = (imported["fact"] ?? 0) + 1;
              break;
            }

            const fileActorId = canPreserveActorId ? str("actorId") : "";
            await storage.createFact({
              workspaceId,
              agentId: str("agentId") || undefined,
              ...(fileActorId
                ? { actorId: fileActorId }
                : {
                    actorId: provenance.actorId,
                    userId: provenance.userId,
                    actorType: provenance.actorType,
                  }),
              scope: (str("scope") || "global") as "global" | "conversation",
              scopeRef: str("scopeRef") || undefined,
              statement: str("statement"),
              subject: str("subject", "general"),
              kind: (str("kind") || "other") as MnemoFact["kind"],
              confidence: num("confidence", 1 / 3),
              ...(sensitivity ? { sensitivity } : {}),
              ...(topicKey ? { topicKey } : {}),
              ...(typeof data["pinned"] === "boolean" ? { pinned: data["pinned"] } : {}),
              ...(status ? { status } : {}),
              ...(Array.isArray(data["tags"]) ? { tags: strArr("tags") } : {}),
              validFrom,
              validTo,
              metadata: { ...withPii(meta("metadata")), importedId: importKey },
            });
            imported["fact"] = (imported["fact"] ?? 0) + 1;
            break;
          }
          case "episode": {
            await storage.createEpisode({
              workspaceId,
              agentId: str("agentId") || undefined,
              title: str("title", "Imported episode"),
              narrative: str("narrative"),
              occurredAt: date("occurredAt") ?? new Date(),
              isSynthetic: bool("isSynthetic", false),
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["episode"] = (imported["episode"] ?? 0) + 1;
            break;
          }
          case "skill": {
            await storage.createSkill({
              workspaceId,
              name: str("name", "Imported skill"),
              promptTemplate: str("promptTemplate"),
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["skill"] = (imported["skill"] ?? 0) + 1;
            break;
          }
          case "reminder": {
            await storage.createReminder({
              id: str("id") || crypto.randomUUID(),
              workspaceId,
              content: str("content"),
              condition: str("condition"),
              triggerAt: date("triggerAt"),
            });
            imported["reminder"] = (imported["reminder"] ?? 0) + 1;
            break;
          }
          case "task": {
            // Idempotent: createTask cannot preserve the import id (it generates a new
            // UUID). To survive a round-trip we (a) try the get-by-id check (works on
            // real Postgres where the id IS preserved via JSONB metadata column lookups
            // in some adapters), and (b) ALWAYS fall back to scanning queryTasks for
            // any row whose metadata.importedId matches. The matched row, if any, is
            // updated in place or skipped per conflictResolution.
            const existingId = str("id");
            const findExisting = async () => {
              if (existingId) {
                const direct = visible(await storage.getTask(existingId, workspaceId));
                if (direct) return direct;
                const all = await storage.queryTasks({ workspaceId });
                return (
                  visible(
                    all.items.find(
                      (t) =>
                        (t.metadata as { importedId?: string } | undefined)?.importedId ===
                        existingId
                    )
                  ) ?? undefined
                );
              }
              return undefined;
            };
            const existing = await findExisting();
            if (existing && conflictResolution === "skip") {
              skip("task", "duplicate");
              break;
            }
            const metadata = { ...withPii(meta("metadata")), importedId: existingId || undefined };
            if (existing) {
              if (raisesTier(sensitivity, existing.sensitivity)) {
                skip("task", "sensitivity-conflict");
                break;
              }
              // overwrite/newest: update mutable fields in place (createTask cannot reuse the id).
              await storage.updateTask(existing.id, {
                workspaceId,
                title: str("title", existing.title),
                description: str("description") || existing.description,
                status: (str("status") || existing.status) as typeof existing.status,
                priority: (str("priority") || existing.priority) as typeof existing.priority,
                assignedTo: str("assignedTo", existing.assignedTo),
                metadata,
              });
              imported["task"] = (imported["task"] ?? 0) + 1;
              break;
            }
            await storage.createTask({
              workspaceId,
              title: str("title", "Imported task"),
              description: str("description") || undefined,
              priority: (str("priority") || "medium") as "critical" | "high" | "medium" | "low",
              assignedTo: str("assignedTo", "imported"),
              sessionId: str("sessionId") || undefined,
              parentTaskId: str("parentTaskId") || undefined,
              dueAt: date("dueAt"),
              delegatedBy: str("delegatedBy") || undefined,
              relatedFacts: strArr("relatedFacts"),
              relatedEntities: strArr("relatedEntities"),
              ...(sensitivity ? { sensitivity } : {}),
              metadata,
            });
            imported["task"] = (imported["task"] ?? 0) + 1;
            break;
          }
          case "event": {
            // Events are immutable (append-only, no updatedAt). Create-if-absent only;
            // a present id is a conflict regardless of conflictResolution. See task case
            // for the get-by-id + metadata.importedId scan rationale.
            const existingId = str("id");
            if (existingId) {
              const direct = visible(await storage.getEvent(existingId, workspaceId));
              if (direct) {
                skip("event", "immutable-exists");
                break;
              }
              const all = await storage.queryEvents({ workspaceId });
              const byImportedId = visible(
                all.items.find(
                  (e) =>
                    (e.metadata as { importedId?: string } | undefined)?.importedId === existingId
                )
              );
              if (byImportedId) {
                skip("event", "immutable-exists");
                break;
              }
            }
            await storage.createEvent({
              workspaceId,
              type: (str("type") || "system") as
                "system" | "external" | "user" | "agent" | "scheduled",
              name: str("name", "Imported event"),
              description: str("description"),
              occurredAt: date("occurredAt") ?? new Date(),
              durationS: num("durationS", 0) || undefined,
              source: str("source", "import"),
              relatedEntities: strArr("relatedEntities"),
              ...(sensitivity ? { sensitivity } : {}),
              metadata: { ...withPii(meta("metadata")), importedId: existingId || undefined },
            });
            imported["event"] = (imported["event"] ?? 0) + 1;
            break;
          }
          case "reasoning": {
            const existingId = str("id");
            const findExisting = async () => {
              if (existingId) {
                const direct = visible(await storage.getReasoning(existingId, workspaceId));
                if (direct) return direct;
                const all = await storage.queryReasoning({ workspaceId });
                return (
                  visible(
                    all.items.find(
                      (r) =>
                        (r.metadata as { importedId?: string } | undefined)?.importedId ===
                        existingId
                    )
                  ) ?? undefined
                );
              }
              return undefined;
            };
            const existing = await findExisting();
            if (existing && conflictResolution === "skip") {
              skip("reasoning", "duplicate");
              break;
            }
            const metadata = { ...withPii(meta("metadata")), importedId: existingId || undefined };
            if (existing) {
              if (raisesTier(sensitivity, existing.sensitivity)) {
                skip("reasoning", "sensitivity-conflict");
                break;
              }
              await storage.updateReasoning(existing.id, {
                workspaceId: existing.workspaceId,
                conclusion: str("conclusion", existing.conclusion),
                chain: (Array.isArray(data["chain"])
                  ? data["chain"]
                  : existing.chain) as typeof existing.chain,
                metadata,
              });
              imported["reasoning"] = (imported["reasoning"] ?? 0) + 1;
              break;
            }
            await storage.createReasoning({
              workspaceId,
              agentId: str("agentId") || undefined,
              question: str("question", "Imported reasoning"),
              chain: (Array.isArray(data["chain"]) ? data["chain"] : []) as Parameters<
                typeof storage.createReasoning
              >[0]["chain"],
              conclusion: str("conclusion"),
              topicKey: str("topicKey") || undefined,
              ...(sensitivity ? { sensitivity } : {}),
              metadata,
            });
            imported["reasoning"] = (imported["reasoning"] ?? 0) + 1;
            break;
          }
          case "hyperedge": {
            // MnemoHyperedge has no `metadata` field, so we cannot stash importedId.
            // Idempotency on InMemory is best-effort: dedup by (memberIds set, label).
            // On real Postgres the get-by-id check below succeeds because ids ARE preserved.
            const memberIds = strArr("memberIds");
            if (memberIds.length < 3) {
              skip("hyperedge", "invalid-members");
              break;
            }
            const existingId = str("id");
            const label = str("label");
            const findExisting = async () => {
              if (existingId) {
                const direct = await storage.getHyperedge(existingId, workspaceId);
                if (direct) return direct;
              }
              // Fall back: same memberIds set + same label = same hyperedge.
              const all = await storage.queryHyperedges({ workspaceId });
              const sortedKey = [...memberIds].sort().join(",");
              return all.items.find(
                (h) => [...h.memberIds].sort().join(",") === sortedKey && (h.label ?? "") === label
              );
            };
            const existing = await findExisting();
            if (existing && conflictResolution === "skip") {
              skip("hyperedge", "duplicate");
              break;
            }
            if (existing) {
              // PRIM-12: the workspace sets the RLS GUC before the first read;
              // without it the row is invisible under FORCE RLS.
              await storage.updateHyperedge(existing.id, {
                workspaceId,
                label: str("label") || existing.label,
                description: str("description") || existing.description,
                contextQuery: str("contextQuery") || existing.contextQuery,
              });
              imported["hyperedge"] = (imported["hyperedge"] ?? 0) + 1;
              break;
            }
            await storage.createHyperedge({
              workspaceId,
              memberIds,
              label: str("label") || undefined,
              description: str("description") || undefined,
              contextQuery: str("contextQuery") || undefined,
            });
            imported["hyperedge"] = (imported["hyperedge"] ?? 0) + 1;
            break;
          }
          case "decision": {
            await storage.createDecision({
              workspaceId,
              agentId: str("agentId") || undefined,
              conversationId: str("conversationId") || undefined,
              kind: (str("kind") || "decision") as
                | "decision"
                | "architecture"
                | "policy"
                | "process"
                | "bugfix"
                | "learning"
                | "discovery"
                | "config",
              title: str("title", "Imported decision"),
              body: str("body"),
              topicKey: str("topicKey") || undefined,
              decidedByUserId: str("decidedByUserId") || undefined,
              confidence: num("confidence", 1),
              validFrom: date("validFrom"),
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["decision"] = (imported["decision"] ?? 0) + 1;
            break;
          }
          case "entity": {
            await storage.createEntity({
              workspaceId,
              name: str("name", "Imported entity"),
              kind: (str("kind") || "other") as
                "person" | "organization" | "project" | "concept" | "place" | "other",
              aliases: strArr("aliases"),
              canonicalId: str("canonicalId") || undefined,
              description: str("description") || undefined,
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["entity"] = (imported["entity"] ?? 0) + 1;
            break;
          }
          case "strategy": {
            await storage.createStrategy({
              workspaceId,
              agentId: str("agentId") || undefined,
              trigger: str("trigger", "imported"),
              action: str("action", "imported"),
              context: str("context") || undefined,
              relatedFacts: strArr("relatedFacts"),
              validFrom: date("validFrom"),
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["strategy"] = (imported["strategy"] ?? 0) + 1;
            break;
          }
          case "workflow": {
            const steps = Array.isArray(data["steps"]) ? data["steps"] : [];
            await storage.createWorkflow({
              workspaceId,
              name: str("name", "Imported workflow"),
              description: str("description") || undefined,
              steps: steps as Parameters<typeof storage.createWorkflow>[0]["steps"],
              ...(sensitivity ? { sensitivity } : {}),
              metadata: withPii(meta("metadata")),
            });
            imported["workflow"] = (imported["workflow"] ?? 0) + 1;
            break;
          }
          case "relation": {
            // Exporter emits legacy mnemo_relation rows (snake_case). Map to the
            // CreateRelationInput port. Accept both legacy and camelCase field names.
            const sourceId = str("source_id") || str("sourceId");
            const targetId = str("target_id") || str("targetId");
            const verbRaw = str("relation") || str("verb");
            const KNOWN_VERBS = [
              "related",
              "compatible",
              "scoped",
              "conflicts_with",
              "supersedes",
              "not_conflict",
              "derived_from",
              "part_of",
              "member_of",
            ] as const;
            type Verb = (typeof KNOWN_VERBS)[number];
            const verb: Verb = (KNOWN_VERBS as readonly string[]).includes(verbRaw)
              ? (verbRaw as Verb)
              : "related";
            if (!sourceId || !targetId) {
              skip("relation", "duplicate");
              break;
            }
            // Idempotency: a relation between the same endpoints+verb already present → honor flag.
            const existing = await storage.getRelations({
              workspaceId,
              sourceId,
              targetId,
              verb,
              openOnly: false,
            });
            if (existing.length > 0 && conflictResolution === "skip") {
              skip("relation", "duplicate");
              break;
            }
            await storage.createRelation({
              workspaceId,
              sourceId,
              // Import payloads are untrusted/arbitrary; an invalid kind is
              // rejected by the physical `mnemo_relation_source_kind_check`/
              // `..._target_kind_check` CHECK constraints at insert time
              // rather than validated here (fail loud, not silently coerced).
              sourceType: (str("source_kind") || str("sourceType") || "fact") as
                "fact" | "decision" | "entity" | "episode",
              targetId,
              targetType: (str("target_kind") || str("targetType") || "fact") as
                "fact" | "decision" | "entity" | "episode",
              verb,
              weight: num("confidence", num("weight", 1)),
              evidence: meta("metadata"),
            });
            imported["relation"] = (imported["relation"] ?? 0) + 1;
            break;
          }
          case "citation": {
            // No createCitation port exists on StorageAdapter — citations cannot be
            // written. Make the skip explicit (not silent). See WP9 openRisks.
            skip("citation", "no-import-path");
            break;
          }
          case "webhook_endpoint": {
            // The exporter redacts the secret (secretHash: "[REDACTED]"). Re-importing
            // would create a cryptographically-broken endpoint. Skip explicitly.
            skip("webhook_endpoint", "secret-redacted");
            break;
          }
          case "header": {
            // A stray header line among the entity lines — expected, not an entity.
            skip("header", "header");
            break;
          }
          default:
            skip(type, "unknown-type");
        }
      } catch (err) {
        // A policy refusal is not a database error: report it under its reason.
        if (err instanceof ImportLineSkip) skip(type, err.reason);
        else if ((err as { code?: unknown } | null)?.code === "poisoning_rejected")
          skip(type, "poisoning-rejected");
        else errors++;
      }
    }

    // Total skipped = sum of every (type, reason) bucket. Keeps the legacy
    // `skipped` scalar populated while exposing the full breakdown.
    const skipped = Object.values(skippedByReason).reduce(
      (acc, byReason) => acc + Object.values(byReason).reduce((a, n) => a + n, 0),
      0
    );

    return c.json(
      {
        imported,
        skipped,
        skippedByReason,
        errors,
        workspaceId,
        sourceWorkspaceId,
        totalLines: lines.length,
      },
      200
    );
  });
}
