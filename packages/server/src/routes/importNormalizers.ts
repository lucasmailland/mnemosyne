import { JSONL_FORMAT_VERSION } from "./export.js";

export type ImportVendor = "mem0" | "zep" | "claude";
export type ConflictResolution = "skip" | "overwrite" | "newest";

type Line = Record<string, unknown>;

function header(workspaceId: string): Line {
  return {
    _type: "header",
    version: JSONL_FORMAT_VERSION,
    workspaceId,
    exportedAt: new Date().toISOString(),
    embeddingsExcluded: true,
    importedFrom: "external",
  };
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Convert a foreign memory export (array of vendor records) into the canonical
 * mnemo JSONL line array: header line first, then one entity line per record.
 * Pure — no I/O. Throws on an unknown vendor.
 */
export function normalizeImport(vendor: ImportVendor, records: unknown[], workspaceId: string): Line[] {
  // Validate vendor upfront so an empty records array still throws for unknown vendors.
  if (vendor !== "mem0" && vendor !== "zep" && vendor !== "claude") {
    throw new Error(`unknown import vendor: ${String(vendor)}`);
  }

  const lines: Line[] = [header(workspaceId)];
  for (const raw of records) {
    const r = (raw ?? {}) as Record<string, unknown>;
    switch (vendor) {
      case "mem0": {
        const statement = asString(r["memory"] ?? r["text"]);
        if (!statement) continue;
        lines.push({
          _type: "fact",
          statement,
          subject: asString(r["user_id"] ?? r["agent_id"], "general"),
          kind: "other",
          confidence: 1 / 3,
          metadata: { ...((r["metadata"] as Record<string, unknown>) ?? {}), importedFrom: "mem0", sourceId: r["id"] },
        });
        break;
      }
      case "zep": {
        const narrative = asString(r["content"] ?? r["message"]);
        if (!narrative) continue;
        lines.push({
          _type: "episode",
          title: asString(r["role"], "Imported message"),
          narrative,
          occurredAt: asString(r["created_at"]) || new Date().toISOString(),
          metadata: { importedFrom: "zep", sourceId: r["uuid"] ?? r["id"] },
        });
        break;
      }
      case "claude": {
        const statement = asString(r["text"] ?? r["content"] ?? r["memory"]);
        if (!statement) continue;
        lines.push({
          _type: "fact",
          statement,
          subject: "general",
          kind: "other",
          confidence: 1 / 3,
          metadata: { importedFrom: "claude", sourceId: r["id"] },
        });
        break;
      }
    }
  }
  return lines;
}
