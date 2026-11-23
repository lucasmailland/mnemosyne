# Guía de seguridad de migraciones

[English](MIGRATION_SAFETY.md) · **Español**

Esta guía explica cómo escribir migraciones de base de datos seguras para Mnemosyne y cómo usar el linter de seguridad de migraciones.

## Resumen

Mnemosyne exige migraciones de esquema sin tiempo de inactividad mediante comprobaciones de seguridad automáticas. Toda migración debe pasar el linter de seguridad de migraciones antes de fusionarse. El linter detecta patrones de DDL inseguros que pueden causar caídas en producción.

## Inicio rápido

### Ejecutar el linter

```bash
# Lint all committed baseline migrations
pnpm lint:migrations

# Lint specific migration files
node scripts/lint-migrations.mjs path/to/migration.sql

# Lint in per-file mode (for committed sets, skips cross-file blast-radius check)
node scripts/lint-migrations.mjs --per-file packages/adapter-postgres/migrations/baseline/*.sql
```

### Cumplimiento en CI

El linter se ejecuta automáticamente en CI en cada PR que toca migraciones:

- **Comprobaciones por archivo** en TODAS las migraciones ya confirmadas (5 reglas de seguridad)
- **Comprobaciones completas** en las migraciones recién añadidas (5 reglas de seguridad + límite de radio de impacto)

Consulta `.github/workflows/schema-safety.yml` para ver la configuración de CI.

### Prueba unitaria

El conjunto de migraciones ya confirmadas también se prueba mediante `migration-safety-real.test.ts`:

```bash
pnpm --filter @mnemo-ai/adapter-postgres test migration-safety-real
```

## Reglas de seguridad

El linter aplica 5 reglas de seguridad principales más 1 regla derivada:

### 1. `no_table_locks_over_5s`

**Infracción:** `ADD COLUMN NOT NULL` sin `DEFAULT`, o `ADD CONSTRAINT` (FK/CHECK) sin `NOT VALID`.

**Por qué es inseguro:** ambas operaciones recorren la tabla completa y mantienen un `AccessExclusiveLock`, que bloquea todas las lecturas y escrituras.

**Patrón seguro:**

```sql
-- ✅ Correct: ADD COLUMN with DEFAULT
ALTER TABLE mnemo_fact
  ADD COLUMN new_col TEXT NOT NULL DEFAULT 'placeholder';

-- ✅ Correct: ADD CONSTRAINT with NOT VALID, then VALIDATE later
ALTER TABLE mnemo_fact
  ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id)
    REFERENCES mnemo_workspace(id) NOT VALID;

-- In a subsequent migration (after backfill if needed):
ALTER TABLE mnemo_fact VALIDATE CONSTRAINT fk_workspace;
```

**Excepción:** las tablas nuevas creadas en la misma migración pueden usar `ADD CONSTRAINT` sin `NOT VALID` (las tablas están vacías y la validación es instantánea). Usa el marcador `-- migrate:allow-table-locks reason=<text>` para los archivos de línea base.

### 2. `no_column_drops_without_flag`

**Infracción:** `DROP COLUMN` sin un marcador de reconocimiento explícito.

**Por qué es inseguro:** eliminar columnas es irreversible y puede romper el código de la aplicación en ejecución que todavía hace referencia a la columna.

**Patrón seguro:**

```sql
-- migrate:allow-drop reason=column no longer used after deploy X

ALTER TABLE mnemo_fact
  DROP COLUMN deprecated_field;
```

**Buena práctica:** usa una eliminación en 3 fases:

1. Migración 1: haz que la columna admita nulos (si no lo hace ya) y quita la restricción NOT NULL
2. Despliegue: elimina todas las referencias de la aplicación a la columna
3. Migración 2: añade el marcador `allow-drop` y elimina la columna

### 3. `no_type_changes_in_place`

**Infracción:** `ALTER COLUMN ... TYPE`

**Por qué es inseguro:** los cambios de tipo reescriben la tabla completa y mantienen un `AccessExclusiveLock` mientras dura la operación.

**Patrón seguro (aditivo en 5 fases):**

```sql
-- Phase 1: Add new column (nullable, no NOT NULL)
ALTER TABLE mnemo_fact ADD COLUMN status_new TEXT;

-- Phase 2: Backfill via batched UPDATE (done outside the migration, or via a background job)

-- Phase 3: Make the new column NOT NULL with DEFAULT (in a new migration, after backfill)
ALTER TABLE mnemo_fact ALTER COLUMN status_new SET DEFAULT 'active';
ALTER TABLE mnemo_fact ALTER COLUMN status_new SET NOT NULL;

-- Phase 4: Deploy application code to use status_new

-- Phase 5: Drop old column (in a new migration, with allow-drop marker)
-- migrate:allow-drop reason=status_new fully adopted
ALTER TABLE mnemo_fact DROP COLUMN status;
```

**Marcador de excepción:** usa `-- migrate:allow-type-change reason=<text>` en los casos en que el patrón de 5 fases no es práctico; por ejemplo, quitar una restricción de dimensión fija de una columna `vector`/`halfvec` para que acepte varias dimensiones de embeddings (consulta `0009_unconstrained_halfvec.sql`). Úsalo solo cuando se haya comprobado que el `ALTER COLUMN ... TYPE` en el lugar es seguro (por ejemplo, un cambio que amplía o quita restricciones, sin riesgo de reescribir datos).

### 4. `index_creation_concurrent`

**Infracción:** `CREATE INDEX` sin `CONCURRENTLY` en una tabla preexistente.

**Por qué es inseguro:** un `CREATE INDEX` simple toma un `ShareLock` sobre la tabla, que bloquea todas las escrituras.

**Patrón seguro:**

```sql
-- migrate:no-transaction

SET search_path TO mnemosyne;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_workspace_valid
  ON mnemo_fact (workspace_id, valid_from)
  WHERE valid_to IS NULL;
```

**Excepción:** los índices sobre tablas creadas en la misma migración (tablas nuevas y vacías) pueden usar un `CREATE INDEX` simple sin `CONCURRENTLY`. El linter permite este patrón automáticamente.

**Marcador de excepción:** usa `-- migrate:allow-non-concurrent-index reason=<text>` en los casos en que necesitas un índice simple en una tabla nueva, pero quieres dejar la excepción explícita.

### 5. `max_10_tables_per_deploy`

**Infracción:** un conjunto de migraciones (todos los archivos de un mismo despliegue) toca más de 10 tablas distintas.

**Por qué es inseguro:** control del radio de impacto: limitar el número de tablas por despliegue reduce el alcance de una posible reversión compleja.

**Patrón seguro:** divide las migraciones grandes en varios PR o despliegues, cada uno con ≤10 tablas.

**Nota:** esta comprobación solo se ejecuta en el modo por defecto (`lintMigrationSet`), no en el modo `--per-file`. La línea base completa ya confirmada abarca legítimamente más de 50 tablas.

### 6. `concurrently_requires_no_transaction` (derivada)

**Infracción:** usar `CONCURRENTLY` sin el marcador `-- migrate:no-transaction`.

**Por qué es inseguro:** las operaciones `CONCURRENTLY` no pueden ejecutarse dentro de un bloque de transacción. El ejecutor de migraciones envuelve cada migración en una transacción por defecto.

**Patrón seguro:**

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY ...
```

## Marcadores de seguridad

Los marcadores son comentarios especiales al inicio de un archivo de migración que activan comportamientos específicos:

### `-- migrate:no-transaction`

Ejecuta la migración fuera de una transacción. **Obligatorio** para las operaciones `CONCURRENTLY`.

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY ...
```

### `-- migrate:allow-drop reason=<text>`

Reconoce explícitamente una operación `DROP COLUMN`. La parte `reason=<text>` es obligatoria y debe explicar por qué la eliminación es segura.

```sql
-- migrate:allow-drop reason=column removed in deploy 2024-06-15, no app references

ALTER TABLE mnemo_fact DROP COLUMN deprecated_field;
```

### `-- migrate:allow-non-concurrent-index reason=<text>`

Permite un `CREATE INDEX` simple (no CONCURRENT) en una tabla preexistente. Úsalo solo cuando sea necesario (por ejemplo, si se sabe que la tabla está vacía o si la migración debe ser transaccional).

```sql
-- migrate:allow-non-concurrent-index reason=table is empty in production

CREATE INDEX idx_new ON mnemo_new_table (col);
```

### `-- migrate:allow-table-locks reason=<text>`

Permite `ADD COLUMN NOT NULL` sin `DEFAULT` o `ADD CONSTRAINT` sin `NOT VALID`. Úsalo solo para archivos de línea base o de compactación en los que todas las tablas se crean desde cero en el mismo archivo.

```sql
-- migrate:allow-table-locks reason=baseline file, all tables created here

CREATE TABLE mnemo_fact (...);
ALTER TABLE mnemo_fact ADD CONSTRAINT pk_fact PRIMARY KEY (id);
```

### `-- migrate:allow-type-change reason=<text>`

Reconoce explícitamente una operación `ALTER COLUMN ... TYPE` en lugar del patrón aditivo de 5 fases. La parte `reason=<text>` es obligatoria y debe explicar por qué el cambio de tipo en el lugar es seguro.

```sql
-- migrate:allow-type-change reason=unconstrain_halfvec_columns_for_multi_dimension_support

ALTER TABLE mnemo_fact ALTER COLUMN embedding TYPE halfvec;
```

## Patrones comunes

### Añadir una columna NOT NULL

```sql
-- Phase 1: Add nullable column with DEFAULT
ALTER TABLE mnemo_fact
  ADD COLUMN new_col TEXT DEFAULT 'placeholder';

-- Phase 2: Backfill NULLs (if any) via batched UPDATE outside the migration

-- Phase 3: Make NOT NULL (in a new migration, after backfill)
ALTER TABLE mnemo_fact ALTER COLUMN new_col SET NOT NULL;
```

### Añadir una clave foránea

```sql
-- Phase 1: Add the column (nullable)
ALTER TABLE mnemo_fact
  ADD COLUMN workspace_id UUID;

-- Phase 2: Backfill the column via batched UPDATE

-- Phase 3: Add constraint with NOT VALID (in a new migration)
ALTER TABLE mnemo_fact
  ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id)
    REFERENCES mnemo_workspace(id) NOT VALID;

-- Phase 4: VALIDATE later (in a new migration or after confirming backfill)
ALTER TABLE mnemo_fact VALIDATE CONSTRAINT fk_workspace;

-- Phase 5: Make NOT NULL (in a new migration)
ALTER TABLE mnemo_fact ALTER COLUMN workspace_id SET NOT NULL;
```

### Crear un índice

Para migraciones incrementales (no de línea base):

```sql
-- migrate:no-transaction

SET search_path TO mnemosyne;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_workspace
  ON mnemo_fact (workspace_id);
```

Para tablas nuevas creadas en la misma migración:

```sql
CREATE TABLE mnemo_new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  -- ...
);

-- Plain index is safe: table is brand-new and empty
CREATE INDEX idx_new_table_workspace ON mnemo_new_table (workspace_id);
```

## Migraciones de línea base frente a migraciones incrementales

### Migraciones de línea base

Las migraciones de línea base (por ejemplo, `0001_v3_complete_baseline.sql`) son instantáneas del esquema completo para instalaciones nuevas. Estas migraciones:

- Crean todas las tablas desde cero (salida de pg_dump + limpieza manual)
- Pueden usar `CREATE INDEX` simple y `ADD CONSTRAINT` sin `NOT VALID` (todas las tablas son nuevas y están vacías)
- Aun así deben evitar `DROP COLUMN` y `ALTER COLUMN TYPE`

El conjunto de pruebas del linter filtra las infracciones de `index_creation_concurrent` y `no_table_locks_over_5s` para los archivos de línea base, porque esos patrones son seguros cuando todas las tablas se crean en el mismo archivo.

### Migraciones incrementales

Las migraciones incrementales (por ejemplo, `0008_session_active_prompt_version_index.sql`) modifican tablas de producción existentes. Estas migraciones:

- **Deben** usar `CONCURRENTLY` para crear índices
- **Deben** usar `NOT VALID` para añadir restricciones
- **Deben** usar el patrón aditivo de 5 fases para los cambios de tipo
- **Deben** añadir marcadores para `DROP COLUMN`

## CI y desarrollo local

### Hook de pre-commit

Puedes añadir un hook de pre-commit para pasar el linter a las migraciones antes de confirmar:

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Lint staged migration files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep 'migrations/.*\.sql$' || true)

if [ -n "$STAGED" ]; then
  echo "Linting staged migrations..."
  echo "$STAGED" | xargs node scripts/lint-migrations.mjs
  if [ $? -ne 0 ]; then
    echo "Migration safety check failed. Fix violations before committing."
    exit 1
  fi
fi
```

### Pruebas locales

Antes de hacer push:

1. Ejecuta el linter localmente:

   ```bash
   pnpm lint:migrations
   ```

2. Ejecuta la prueba unitaria:

   ```bash
   pnpm --filter @mnemo-ai/adapter-postgres test migration-safety-real
   ```

3. Prueba la migración contra una base de datos de sombra:
   ```bash
   # Start a test Postgres instance
   pnpm docker:up

   # Apply migrations
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemo_test \
     node packages/adapter-postgres/dist/migrate.js
   ```

## Solución de problemas

### «CREATE INDEX without CONCURRENTLY» en una tabla nueva

Si creas un índice sobre una tabla que se creó en la misma migración, el linter debería detectarlo automáticamente y omitir la advertencia. Si no lo hace:

1. Comprueba que el nombre de la tabla coincide exactamente (sin distinguir mayúsculas y sin prefijo de esquema)
2. Asegúrate de que la sentencia `CREATE TABLE` esté en el mismo archivo
3. Si el linter sigue quejándose, añade `-- migrate:allow-non-concurrent-index reason=new table created in this file`

### «ADD CONSTRAINT without NOT VALID» en un archivo de línea base

Los archivos de línea base crean legítimamente restricciones sobre tablas nuevas. Añade el marcador:

```sql
-- migrate:allow-table-locks reason=baseline file, all tables fresh
```

### Falso positivo de «max_10_tables_per_deploy»

Esta comprobación solo se ejecuta en el modo por defecto, no en el modo `--per-file`. El CI usa `--per-file` para el conjunto de línea base ya confirmado, así que no debería dispararse. Si añades muchas migraciones nuevas en un mismo PR:

- Divide el PR en varios despliegues, cada uno con ≤10 tablas
- O, si de verdad hace falta (por ejemplo, un cambio de esquema coordinado), coméntalo con el equipo

## Referencias

- **Especificación**: `docs/research/MEMORY_MODEL.md` §35 "Zero-Downtime Schema Migrations" (líneas 4027–4033)
- **Implementación**: `packages/adapter-postgres/src/migration-safety.ts`
- **Flujo de trabajo de CI**: `.github/workflows/schema-safety.yml`
- **Conjunto de pruebas**: `packages/adapter-postgres/src/__tests__/migration-safety-real.test.ts`
- **Script**: `scripts/lint-migrations.mjs`

## Ejemplos del código base

### Corregido: migración 0008 (índice de versión activa del prompt de la sesión)

**Antes (inseguro):**

```sql
CREATE INDEX IF NOT EXISTS idx_mnemo_session_active_prompt_version
  ON mnemo_session (workspace_id, active_prompt_version_id)
  WHERE active_prompt_version_id IS NOT NULL;
```

**Después (seguro):**

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_session_active_prompt_version
  ON mnemo_session (workspace_id, active_prompt_version_id)
  WHERE active_prompt_version_id IS NOT NULL;
```

**Por qué:** la tabla `mnemo_session` ya existe en producción. Crear un índice simple tomaría un `ShareLock` y bloquearía todas las escrituras. `CONCURRENTLY` permite escrituras concurrentes, y `no-transaction` es necesario para que `CONCURRENTLY` funcione.
