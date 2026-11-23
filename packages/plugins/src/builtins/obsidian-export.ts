import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MnemoPlugin, PluginContext, PluginRecallHit } from "../index.js";

/** Export a single recall hit to an Obsidian-compatible markdown file. */
function hitToMarkdown(hit: PluginRecallHit): string {
  const lines: string[] = [
    `---`,
    `id: ${hit.id}`,
    `score: ${hit.score}`,
    `---`,
    ``,
    hit.content,
  ];
  return lines.join("\n");
}

/** Export all recalled facts for the current workspace to Obsidian markdown files. */
export async function exportVault(ctx: PluginContext, dir: string): Promise<void> {
  if (!dir) throw new Error("obsidian-export: dir required");
  await mkdir(dir, { recursive: true });
  const hits = await ctx.recall("*");
  for (const hit of hits) {
    const filename = `${hit.id}.md`;
    await writeFile(join(dir, filename), hitToMarkdown(hit), "utf8");
  }
}

export function createObsidianExportPlugin(): MnemoPlugin {
  return {
    id: "obsidian-export", name: "Obsidian Export", version: "1.0.0",
    description: "Export memory facts to Obsidian-compatible markdown files.",
    verify: async (facts, ctx): Promise<Array<{ factId: string; valid: boolean; reason?: string }>> => {
      const dir = ctx.config.vaultDir;
      if (!dir) {
        ctx.log?.info?.("obsidian-export: no vaultDir configured, skipping verify");
        return [];
      }
      // On verify, export all facts to vault
      const results = [];
      for (const fact of facts) {
        try {
          const content = (fact.content as string | undefined) ?? String(fact.id);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, `${fact.id}.md`), `---\nid: ${fact.id}\n---\n\n${content}`, "utf8");
          results.push({ factId: fact.id, valid: true });
        } catch (err) {
          results.push({ factId: fact.id, valid: false, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return results;
    },
  };
}
