# Depuración de problemas de aislamiento RLS

[English](DEBUG_RLS_ISOLATION.md) · **Español**

## 1. Cómo funciona RLS en Mnemosyne

Toda consulta con permisos de espacio de trabajo pasa por `withWorkspace()` en
`packages/adapter-postgres/src/RlsMiddleware.ts`:

```typescript
export async function withWorkspace(db, workspaceId, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
    return fn(tx);
  });
}
```

`mnemo_set_workspace()` llama a `set_config('mnemosyne.workspace_id', wid, true)`: el tercer argumento `true` hace que sea **local a la transacción**, de modo que el GUC se restablece en COMMIT/ROLLBACK y no puede filtrarse a otras conexiones.

Toda tabla `mnemo_*` (excepto `mnemo_outbox` y `mnemo_deletion_log`) tiene ambas cosas:

```sql
ALTER TABLE mnemo_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY mnemo_fact_ws ON mnemo_fact
  USING (workspace_id::uuid = current_setting('mnemosyne.workspace_id', true)::uuid);
```

`FORCE RLS` es crítico: se aplica incluso al propietario de la tabla. `ENABLE RLS` por sí solo no basta (el propietario lo esquiva).

La aplicación se conecta como `mnemo_v3_app_role` (hereda de `mnemo_app_role`), que tiene SELECT/INSERT/UPDATE/DELETE sobre todas las tablas con permisos de espacio de trabajo pero **no** es el propietario de las tablas.

---

## 2. Síntomas comunes

| Síntoma | Causa más probable |
|---|---|
| El espacio de trabajo A ve los datos del espacio de trabajo B | Falta `FORCE RLS`; o no se llamó a `withWorkspace` |
| Todas las consultas devuelven vacío | El GUC no está establecido; rol equivocado; se llamó a `withWorkspace` con un UUID incorrecto |
| 403 / "permission denied for table" | Al rol de la aplicación no se le concedieron permisos; conexión con el usuario equivocado |
| 404 en un registro que acabas de crear | `workspaceId` incorrecto en la llamada get; RLS lo está filtrando |
| El worker del outbox procesa entre espacios de trabajo | Es lo esperado: `mnemo_outbox` no tiene RLS a propósito |

---

## 3. Lista de verificación de depuración

**Paso 1 — Verifica que el GUC esté establecido dentro de una transacción:**

```sql
BEGIN;
SELECT mnemo_set_workspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);
SHOW mnemosyne.workspace_id;   -- must print the UUID, not empty string
SELECT * FROM mnemosyne.mnemo_fact LIMIT 5;
ROLLBACK;
```

Si `SHOW` imprime una cadena vacía, no se llamó a `mnemo_set_workspace` o el nombre del parámetro GUC es incorrecto.

**Paso 2 — Confirma que FORCE RLS esté activado:**

```sql
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname = 'mnemosyne'
  AND tablename LIKE 'mnemo_%'
ORDER BY tablename;
```

Cada fila del resultado debe tener `rowsecurity = true` Y `forcerowsecurity = true` (excepto `mnemo_outbox` y `mnemo_deletion_log`).

**Paso 3 — Comprueba que existan las políticas:**

```sql
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'mnemosyne'
ORDER BY tablename;
```

Cada tabla con permisos de espacio de trabajo debe tener exactamente una política cuyo `qual` contenga `current_setting('mnemosyne.workspace_id', true)`.

**Paso 4 — Comprueba el rol actual:**

```sql
SELECT current_user, session_user;
-- Expected: current_user = mnemo_v3_app_role (or mnemo_app_role)
-- If current_user = postgres / rds_superuser, RLS is bypassed for the owner
```

**Paso 5 — Sonda de aislamiento entre espacios de trabajo:**

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

## 4. Causas raíz comunes y soluciones

### Falta FORCE RLS

**Síntoma**: el propietario de la tabla (p. ej., el usuario de migraciones) puede leer todos los espacios de trabajo.

**Solución**: ejecuta lo siguiente sobre cada tabla afectada:

```sql
ALTER TABLE mnemosyne.mnemo_fact FORCE ROW LEVEL SECURITY;
```

Revisa `0001_baseline.sql`: si se añadió una tabla nueva sin `ENABLE` ni `FORCE`, añade ambos y crea una nueva migración numerada en `migrations/v3/`.

### No se llamó a `withWorkspace` (ruta de SQL directo)

**Síntoma**: una ruta nueva o una tarea en segundo plano usa `db.*` directamente en lugar de pasar por `withWorkspace`.

**Solución**: envuelve cualquier consulta con permisos de espacio de trabajo:

```typescript
// Wrong
const rows = await db.select().from(schema.factTable).where(eq(schema.factTable.workspaceId, wid));

// Correct
const rows = await withWorkspace(db, wid, (tx) =>
  tx.select().from(schema.factTable)
);
// RLS enforces the workspace filter — no .where() needed, but it's fine to add one for indexed performance
```

### El rol de la aplicación no está bien configurado

**Síntoma**: `permission denied for table mnemo_fact`.

**Solución**: verifica los permisos concedidos y la pertenencia al rol:

```sql
\du mnemo_app_role      -- check it exists
\du mnemo_v3_app_role   -- check it inherits mnemo_app_role
\dp mnemosyne.mnemo_fact -- check SELECT, INSERT, UPDATE, DELETE granted
```

Si falta el rol, vuelve a ejecutar `migrations/v3/0002_rls_policies.sql`. Si faltan los permisos de una tabla nueva, añádelos en una nueva migración.

### GUC sin establecer o con nombre incorrecto

**Síntoma**: `current_setting('mnemosyne.workspace_id', true)` devuelve `NULL`, que se convierte en un UUID nulo, y la política `workspace_id::uuid = NULL` siempre es falsa: se filtran todas las filas.

**Solución**: confirma que el nombre de la función coincide exactamente con el nombre del GUC usado en las políticas. Ambos deben ser `mnemosyne.workspace_id` (con el prefijo del esquema). Comprueba:

```sql
SELECT current_setting('mnemosyne.workspace_id', true);
-- Returns empty string '' if GUC was never set in this transaction
-- Returns the UUID if mnemo_set_workspace was called
```

### Pooler de conexiones en modo de sesión

**Síntoma**: fugas intermitentes entre espacios de trabajo: el espacio de trabajo A ve de vez en cuando los datos del espacio de trabajo B.

**Causa raíz**: PgBouncer o pgcat en **modo de sesión** mantienen vivo el GUC entre solicitudes lógicas. El siguiente cliente hereda el `mnemosyne.workspace_id` del cliente anterior.

**Solución**: cambia el pooler a **modo de transacción**. El GUC se establece con `set_config(true)`, que lo limita a la transacción, pero solo el pooling en modo de transacción devuelve realmente la conexión al pool en el COMMIT.

---

## 5. Pruebas del aislamiento RLS

Añade esta prueba a la suite de integración de tu adaptador:

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

Para una sonda entre espacios de trabajo más dirigida en tu propia prueba:

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

Esta prueba pasa con `InMemoryStorageAdapter` (aislamiento a nivel de aplicación) y con `DrizzleStorageAdapter` ejecutándose contra una instancia de Postgres con RLS aplicado. Si falla en la ruta de Postgres, sigue la lista de verificación del §3.
