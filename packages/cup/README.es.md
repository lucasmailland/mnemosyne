# @mnemo-ai/cup

[English](README.md) · **Español**

> **Puntero para IA:** Cognitive Upgrade Protocol: migración determinista de datos de v2 a v3. Se ejecuta una sola vez durante las actualizaciones del sistema.
>
> **Depende de:** @mnemo-ai/types (`@mnemo-ai/core` es una dependencia entre pares, no una dependencia directa)
>
> **Expone:** `mapV2Memory`, `mapV2MemoryBatch` (biblioteca) · `mnemo-migrate` (CLI)
>
> **Estado:** BETA — mapeador determinista y ejecutor de ingesta por cursor de claves (keyset) en la CLI implementados; aún no probado a gran escala
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md)

Cognitive Upgrade Protocol (CUP) es un ETL **determinista** que migra los datos heredados
(v2) de Mnemosyne al esquema v3. CUP lee filas planas de `memories` de una
base de datos de origen, asigna cada fila a la primitiva cognitiva v3 correspondiente mediante un
`TypeMapper` puro basado en reglas (sin LLM) e inserta los resultados en la base de datos
v3 de destino con SQL directo y `ON CONFLICT DO NOTHING` para garantizar la idempotencia.

> **Nota:** CUP es un mapeador basado en reglas, **no** un clasificador con LLM (la
> reclasificación con LLM es opcional mediante `--llm`). Por defecto es rápido, gratuito y reproducible. La contrapartida es que el mapeo depende del campo
> `memory_type` de v2 y no de una reclasificación semántica.

---

## Por qué existe CUP

Las primeras implementaciones de Mnemosyne guardaban todo como filas planas de `memories` identificadas por
una cadena `memory_type`. El esquema v3 usa 10 primitivas cognitivas tipadas. CUP
asigna cada `memory_type` de v2 a su primitiva v3 y aplica la política de confianza
correcta al importar (`Beta(1,2) ≈ 0.33`), de modo que los hechos importados empiecen con la
incertidumbre adecuada.

| Aspecto          | Esquema v2                 | Esquema v3                             |
| ---------------- | -------------------------- | -------------------------------------- |
| Modelo de hechos | Filas planas de `memories` | 10 valores tipados de `PrimitiveKind`  |
| Sensibilidad     | No se registra             | Obligatoria en cada hecho              |
| Worth            | Contadores básicos         | Modelo de worth ACT-R (Beta-Bernoulli) |

---

## Estado de la implementación

| Componente                           | Estado      | Notas                                                                                                        |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `TypeMapper` (los 8 tipos de v2)     | ✅ Listo    | `mapV2Memory` / `mapV2MemoryBatch` en `src/TypeMapper.ts`                                                    |
| Ejecutor de la CLI (`mnemo-migrate`) | ✅ Listo    | `src/migrate.ts`; por lotes, con simulación (dry-run), idempotente                                           |
| Idempotencia                         | ✅ Listo    | `ON CONFLICT DO NOTHING` en cada inserción (sin tabla de seguimiento aparte)                                 |
| Ejecuciones reanudables              | ✅ Listo    | Cursor de claves (keyset) `(created_at, id)` guardado en `mnemo_migration_cursor`; se reanuda con `--run-id` |
| Reclasificación con LLM              | 🔸 Opcional | Desactivada por defecto (CUP es determinista); se activa con `--llm` y requiere `MNEMO_LLM_API_KEY`          |

---

## Cómo funciona

```
Source DB (v2)            CUP migrate.ts            Target DB (v3)
─────────────             ─────────────             ─────────────
public.memories  ──read──► mapV2MemoryBatch  ──write─► mnemosyne.mnemo_fact
  (keyset cursor           (rule-based, by                mnemosyne.mnemo_episode
   pagination)             memory_type)                  mnemosyne.mnemo_skill
                                                       (ON CONFLICT DO NOTHING)
```

### Paso a paso

1. **Leer**: obtiene un lote de la tabla de origen `public.memories` con un
   cursor de claves (keyset) sobre `(created_at, id)`.
2. **Mapear**: `mapV2MemoryBatch()` asigna de forma determinista cada fila a una primitiva v3
   (`fact`, `episode` o `skill`) según su `memory_type`.
3. **Escribir**: inserta en `mnemosyne.mnemo_fact` / `mnemo_episode` /
   `mnemo_skill` con SQL directo y `ON CONFLICT DO NOTHING`.
4. **Informar**: imprime un resumen de los registros procesados por primitiva.

---

## Uso de la CLI

```bash
# Required env
export DATABASE_URL=postgres://user:pass@host:5432/mnemosyne_v2      # source
export DATABASE_URL_V3=postgres://user:pass@host:5432/mnemosyne      # target

# Full migration for a workspace
mnemo-migrate --workspace <uuid>

# Tune batch size (default 100)
mnemo-migrate --workspace <uuid> --batch-size 50

# Dry run — map and count, do not write
mnemo-migrate --workspace <uuid> --dry-run
```

---

## Uso como biblioteca

```ts
import { mapV2MemoryBatch } from "@mnemo-ai/cup";

const mapped = mapV2MemoryBatch(v2Rows, workspaceId);
// mapped.facts / mapped.episodes / mapped.skills — write these yourself
```

---

## Seguridad: idempotencia

CUP puede volver a ejecutarse con seguridad. Cada inserción usa `ON CONFLICT DO NOTHING` sobre el
ID de la primitiva, de modo que:

- Las migraciones interrumpidas se reanudan sin crear duplicados.
- Ejecutar CUP dos veces produce el mismo resultado.
- La base de datos de origen solo se lee, nunca se modifica.
