import type { MnemoPlugin, PluginContext } from "../index.js";

interface ClaudeMemoryEntry {
  content?: string;
  text?: string;
  subject?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Import a Claude conversation memory JSON array as facts. */
export async function importClaudeMemory(ctx: PluginContext, json: string): Promise<number> {
  let entries: ClaudeMemoryEntry[];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array of memory entries");
    }
    entries = parsed as ClaudeMemoryEntry[];
  } catch (err) {
    throw new Error(`claude-import: malformed JSON — ${err instanceof Error ? err.message : String(err)}`);
  }

  let count = 0;
  for (const entry of entries) {
    const content = entry.content ?? entry.text;
    if (!content) continue;
    await ctx.createFact({
      content,
      subject: entry.subject,
      tags: [...(entry.tags ?? []), "claude-import"],
      metadata: { ...entry.metadata, importedFrom: "claude" },
    });
    count++;
  }
  return count;
}

export function createClaudeImportPlugin(): MnemoPlugin {
  return {
    id: "claude-import", name: "Claude Import", version: "1.0.0",
    description: "Import Claude conversation JSON to memory facts.",
  };
}
