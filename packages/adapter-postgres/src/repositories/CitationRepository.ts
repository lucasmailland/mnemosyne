import { eq, and, desc, sql } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { mapRowToCitation } from "./mappers.js";
import type { DrizzleClient } from "./types.js";
import type { MnemoCitation, CitationFilter } from "@mnemo-ai/types";

export class CitationRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly readDb: DrizzleClient
  ) {}

  async listCitations(filter: CitationFilter): Promise<MnemoCitation[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    // flatten-legacy-dual-core PR9h (design.md D6.5) — additive offset
    // pagination, only consumed by the pure-core `exportWorkspace`
    // projection walking past the 500/call clamp above. `routes/citations.ts`
    // never sets this (its own public `limit` param is already <=500), so
    // `offset` defaults to 0 there — zero behavior change for that route.
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT mnemo_set_workspace(${filter.workspaceId}::uuid)`);

      const conditions = [eq(schema.citationTable.workspaceId, filter.workspaceId)];
      if (filter.memoryKind) {
        conditions.push(eq(schema.citationTable.memoryKind, filter.memoryKind));
      }
      if (filter.memoryId) {
        conditions.push(eq(schema.citationTable.memoryId, filter.memoryId));
      }

      const rows = await tx
        .select()
        .from(schema.citationTable)
        .where(and(...conditions))
        .orderBy(desc(schema.citationTable.createdAt))
        .limit(limit)
        .offset(offset);

      return rows.map(mapRowToCitation);
    });
  }
}
