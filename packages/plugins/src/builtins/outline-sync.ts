import type { MnemoPlugin, PluginContext, SyncResult } from "../index.js";

interface OutlineDocument {
  id: string;
  title: string;
  text?: string;
  updatedAt?: string;
}

interface OutlineListResponse {
  data?: OutlineDocument[];
  pagination?: { offset?: number; total?: number };
}

export function createOutlineSyncPlugin(): MnemoPlugin {
  return {
    id: "outline-sync", name: "Outline Sync", version: "1.0.0",
    description: "Sync Outline KB documents to the facts namespace.",
    syncInterval: 3_600_000, // 1 hour
    sync: async (ctx: PluginContext): Promise<SyncResult> => {
      const apiUrl = ctx.config.outlineApiUrl;
      if (!apiUrl) { ctx.log?.info?.("outline-sync: no outlineApiUrl configured, skipping"); return { itemsSynced: 0 }; }

      const cursor = await ctx.state.get<string>("cursor");
      const res = await fetch(`${apiUrl}/documents.list`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${ctx.config.apiToken ?? ""}` },
        body: JSON.stringify({ offset: cursor ? parseInt(cursor, 10) : 0, limit: 50 }),
      });

      const data = await res.json() as OutlineListResponse;
      const docs = data.data ?? [];

      for (const doc of docs) {
        await ctx.createFact({
          content: doc.text ?? doc.title,
          subject: doc.title,
          tags: ["kb", "outline"],
          metadata: { namespace: "kb", outlineId: doc.id, updatedAt: doc.updatedAt },
        });
      }

      const nextOffset = (cursor ? parseInt(cursor, 10) : 0) + docs.length;
      return { itemsSynced: docs.length, cursor: String(nextOffset) };
    },
  };
}
