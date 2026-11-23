import { pgSchema } from "drizzle-orm/pg-core";

/**
 * All v3 tables live in the `mnemosyne` PostgreSQL schema, not `public`.
 *
 * This gives us clean namespace separation from v2 (whose tables are all
 * in `public.*`), so v2 and v3 can coexist on the same PostgreSQL cluster
 * without name collisions during the incremental migration.
 *
 * GUC alignment: v3 RLS policies use `mnemosyne.workspace_id`
 *                v2 RLS policies use `app.workspace_id`
 * The GUC names match the schema names intentionally.
 */
export const mnemoSchema = pgSchema("mnemosyne");
