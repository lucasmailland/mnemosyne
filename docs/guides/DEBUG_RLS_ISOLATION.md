# Debugging RLS Isolation Issues

**English** · [Español](DEBUG_RLS_ISOLATION.es.md)

## 1. How RLS Works in Mnemosyne

Every workspace-scoped query goes through `withWorkspace()` in
`packages/adapter-postgres/src/RlsMiddleware.ts`:

```typescript
export async function withWorkspace(db, workspaceId, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
    return fn(tx);
  });
}
```

`mnemo_set_workspace()` calls `set_config('mnemosyne.workspace_id', wid, true)` — the third argument `true` makes it **transaction-local**, so the GUC resets at COMMIT/ROLLBACK and cannot bleed to other connections.

Every `mnemo_*` table (except `mnemo_outbox` and `mnemo_deletion_log`) has both:

```sql
ALTER TABLE mnemo_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_fact_ws ON mnemo_fact
  USING (workspace_id::uuid = current_setting('mnemosyne.workspace_id', true)::uuid);
```

`FORCE RLS` is critical — it applies even to the table owner. `ENABLE RLS` alone is insufficient (the owner bypasses it).

The application connects as `mnemo_v3_app_role` (inherits `mnemo_app_role`), which has SELECT/INSERT/UPDATE/DELETE on all workspace-scoped tables but is **not** the table owner.

---

## 2. Common Symptoms

| Symptom | Most Likely Cause |
|---|---|
| Workspace A sees workspace B's data | `FORCE RLS` missing; or `withWorkspace` not called |
| All queries return empty | GUC not set; wrong role; `withWorkspace` called with wrong UUID |
| 403 / "permission denied for table" | App role not granted; connecting as wrong user |
| 404 on a record you just created | Wrong `workspaceId` in the get call; RLS filtering it out |
| Outbox worker processes cross-workspace | Expected — `mnemo_outbox` intentionally has no RLS |

---

## 3. Debug Checklist

**Step 1 — Verify the GUC is set inside a transaction:**

```sql
BEGIN;
SELECT mnemo_set_workspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);
SHOW mnemosyne.workspace_id;   -- must print the UUID, not empty string
SELECT * FROM mnemosyne.mnemo_fact LIMIT 5;
ROLLBACK;
```

If `SHOW` prints an empty string, `mnemo_set_workspace` was not called or the GUC parameter name is wrong.

**Step 2 — Confirm FORCE RLS is on:**

```sql
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname = 'mnemosyne'
  AND tablename LIKE 'mnemo_%'
ORDER BY tablename;
```

Every row in the result must have `rowsecurity = true` AND `forcerowsecurity = true` (except `mnemo_outbox` and `mnemo_deletion_log`).

**Step 3 — Check policies exist:**

```sql
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'mnemosyne'
ORDER BY tablename;
```

Each workspace-scoped table must have exactly one policy whose `qual` contains `current_setting('mnemosyne.workspace_id', true)`.

**Step 4 — Check current role:**

```sql
SELECT current_user, session_user;
-- Expected: current_user = mnemo_v3_app_role (or mnemo_app_role)
-- If current_user = postgres / rds_superuser, RLS is bypassed for the owner
```

**Step 5 — Cross-workspace isolation probe:**

```sql
BEGIN;
SELECT mnemo_set_workspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);

-- Insert a fact as workspace A
INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, statement, subject, kind, scope, confidence, sensitivity)
VALUES ('test-rls-fact', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'secret', 'test', 'other', 'global', 0.9, 'internal');

ROLLBACK;

BEGIN;
SELECT mnemo_set_workspace('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid);

-- Workspace B must not see workspace A's fact
SELECT id FROM mnemosyne.mnemo_fact WHERE id = 'test-rls-fact';
-- Expected: 0 rows

ROLLBACK;
```

---

## 4. Common Root Causes and Fixes

### Missing FORCE RLS

**Symptom**: Table owner (e.g. the migration user) can read all workspaces.

**Fix**: Run against each affected table:

```sql
ALTER TABLE mnemosyne.mnemo_fact FORCE ROW LEVEL SECURITY;
```

Check `0001_baseline.sql` — if a new table was added without both `ENABLE` and `FORCE`, add both and create a new numbered migration under `migrations/v3/`.

### `withWorkspace` not called (raw SQL path)

**Symptom**: A new route or background job uses `db.*` directly instead of going through `withWorkspace`.

**Fix**: Wrap any workspace-scoped query:

```typescript
// Wrong
const rows = await db.select().from(schema.factTable).where(eq(schema.factTable.workspaceId, wid));

// Correct
const rows = await withWorkspace(db, wid, (tx) =>
  tx.select().from(schema.factTable)
);
// RLS enforces the workspace filter — no .where() needed, but it's fine to add one for indexed performance
```

### App role not set up correctly

**Symptom**: `permission denied for table mnemo_fact`.

**Fix**: Verify grants and role membership:

```sql
\du mnemo_app_role      -- check it exists
\du mnemo_v3_app_role   -- check it inherits mnemo_app_role
\dp mnemosyne.mnemo_fact -- check SELECT, INSERT, UPDATE, DELETE granted
```

If the role is missing, re-run `migrations/v3/0002_rls_policies.sql`. If the grants are missing for a new table, add them to a new migration.

### GUC not set / wrong name

**Symptom**: `current_setting('mnemosyne.workspace_id', true)` returns `NULL`, which casts to a NULL UUID, and the policy `workspace_id::uuid = NULL` is always false — all rows filtered out.

**Fix**: Confirm the function name exactly matches the GUC name used in policies. Both must be `mnemosyne.workspace_id` (with the schema prefix). Check:

```sql
SELECT current_setting('mnemosyne.workspace_id', true);
-- Returns empty string '' if GUC was never set in this transaction
-- Returns the UUID if mnemo_set_workspace was called
```

### Connection pooler in session mode

**Symptom**: Intermittent cross-workspace leaks — workspace A occasionally sees workspace B's data.

**Root cause**: PgBouncer or pgcat in **session mode** keeps the GUC alive between logical requests. The next client inherits the previous client's `mnemosyne.workspace_id`.

**Fix**: Switch the pooler to **transaction mode**. The GUC is set with `set_config(true)` which scopes it to the transaction, but only transaction-mode pooling actually returns the connection to the pool at COMMIT.

---

## 5. Testing RLS Isolation

Add this test to your adapter's integration suite:

```typescript
import { runStorageAdapterContractTests } from "@mnemo-ai/types/testing";

// The contract suite already includes an RLS test:
//   "RLS: workspace A cannot read workspace B facts"
// Run it against the real DrizzleStorageAdapter to catch DB-level gaps:

runStorageAdapterContractTests(async () => {
  const { db } = createDrizzleClient(process.env.TEST_DATABASE_URL!);
  return new DrizzleStorageAdapter(db);
});
```

For a more targeted cross-workspace probe in your own test:

```typescript
it("RLS: cross-workspace getFact returns null", async () => {
  const factB = await adapter.createFact({
    workspaceId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    scope: "global",
    statement: "workspace B secret",
    subject: "secret",
    kind: "other",
  });

  // Workspace A must not see workspace B's fact
  const leak = await adapter.getFact(factB.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  expect(leak).toBeNull();
});
```

This test passes for `InMemoryStorageAdapter` (application-level isolation) and for `DrizzleStorageAdapter` running against a Postgres instance with RLS applied. If it fails on the Postgres path, work through the checklist in §3.
