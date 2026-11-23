# Spike B7 — Decision de Almacenamiento Multi-Modelo y Espacios Vectoriales (`pgvector`)

> **Estado**: Aprobado  
> **Fecha**: 2026-07-18  
> **Autores**: Antigravity AI & Mnemosyne Core Team  
> **Backlog Reference**: B7.1 (Spike PostgreSQL/pgvector) y B7.2 (Decisión de Storage Multi-Modelo)

---

## 1. Resumen Ejecutivo y Diagnóstico

### Estado Actual (Baseline B1-B6)
Mnemosyne utiliza actualmente una columna vectorial de dimensión fija `embedding public.vector(1536)` indexada con **HNSW** (`vector_cosine_ops`) en PostgreSQL mediante la extensión `pgvector` (`pgvector/pgvector:pg17`). Esta configuración asume el modelo por defecto `text-embedding-3-small` / `text-embedding-ada-002`.

### Problema
Para soportar modelos de embeddings alternativos y locales (OpenAI `3072`, Cohere/Voyage `1024`, Gemini `2048`, Llama-3/Qwen/bge-large `4096`), el runtime requiere soportar **múltiples dimensiones y espacios de representación vectorial (`spaceId`)** por workspace de forma aislada y sin degradación de rendimiento.

---

## 2. Evaluación de Alternativas de Almacenamiento (Spike B7.1)

Se evaluaron tres arquitecturas principales para PostgreSQL + `pgvector`:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Alternativas Evaluadas                              │
├──────────────────────────────────┬──────────────────────────────────────┤
│ Opción A: Tabla Única Incondicional│ `vector` sin dimensión fija          │
│ Opción B: Particionamiento por   │ Tablas separadas por dimensión      │
│           Dimensión              │ (`_1024`, `_1536`, `_2048`, `_4096`) │
│ Opción C: Tabla Genérica de      │ `mnemo_vector_space` +               │
│           Espacios (Híbrida)     │ Particiones por Space ID             │
└──────────────────────────────────┴──────────────────────────────────────┘
```

### Opción A — Tabla Única con Tipo `public.vector` (Sin dimensión fija)
* **Mecanismo**: Columna `embedding public.vector` sin especificar dimensión rígida en la definición DDL.
* **Ventajas**: Schema simple de tabla única.
* **Desventajas Críticas**: En `pgvector`, **un índice HNSW / IVFFlat requiere que todos los vectores indexados tengan la misma dimensión**. No es posible construir un índice HNSW único sobre una columna con dimensiones mixtas sin índices parciales explícitos (`WHERE vector_dims(embedding) = 1536`), lo que genera fragmentación masiva de índices y degrada el planner de consultas.

### Opción B — Particionamiento Estricto por Dimensión
* **Mecanismo**: Tablas dedicadas por dimensión física (`mnemo_embeddings_1024`, `mnemo_embeddings_1536`, `mnemo_embeddings_2048`, `mnemo_embeddings_4096`).
* **Ventajas**: Índice HNSW óptimo por dimensión con parámetros sintonizados (`m=16`, `ef_construction=64` para 1536; `m=24`, `ef_construction=128` para 4096).
* **Desventajas**: Requiere DDL adicional si se introduce una dimensión no estandarizada (ej. 768 o 3072).

### Opción C — Arquitectura Híbrida basada en `spaceId` y Particiones de Dimensión (Elegida)
* **Mecanismo**: Registro central de espacios vectoriales (`mnemo_vector_space`) vinculado a tablas de almacenamiento particionadas por dimensión estandarizada.
* **Ventajas**:
  - Aislamiento perfecto entre modelos.
  - HNSW nativo de alto rendimiento por dimensión.
  - Preservación estricta de Row Level Security (RLS) por `workspace_id`.
  - Migración yDual-Write transparentes con rollback sin pérdida de datos.

---

## 3. Decisión de Arquitectura Aprobada (B7.2)

### 3.1 Modelo de Datos y Registro de Espacios

#### 1. Registro de Espacios Vectoriales (`mnemo_vector_space`)
```sql
CREATE TABLE mnemosyne.mnemo_vector_space (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES mnemosyne.mnemo_workspace(id) ON DELETE CASCADE,
    space_key TEXT NOT NULL, -- Ej: 'default-openai-1536', 'voyage-3-1024', 'custom-qwen-4096'
    model_name TEXT NOT NULL, -- Ej: 'text-embedding-3-small', 'voyage-large-3'
    dimensions INTEGER NOT NULL CHECK (dimensions IN (512, 768, 1024, 1536, 2048, 3072, 4096)),
    distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric IN ('cosine', 'ip', 'l2')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_workspace_space_key UNIQUE (workspace_id, space_key)
);

ALTER TABLE mnemosyne.mnemo_vector_space ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_vector_space FORCE ROW LEVEL SECURITY;
```

#### 2. Tabla de Embeddings Multi-Modelo (`mnemo_fact_embeddings_v4`)
```sql
CREATE TABLE mnemosyne.mnemo_fact_embeddings_1536 (
    fact_id UUID NOT NULL REFERENCES mnemosyne.mnemo_fact(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL,
    space_id UUID NOT NULL REFERENCES mnemosyne.mnemo_vector_space(id) ON DELETE CASCADE,
    embedding public.vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (space_id, fact_id)
);

CREATE INDEX idx_fact_emb_1536_hnsw ON mnemosyne.mnemo_fact_embeddings_1536 
USING hnsw (embedding public.vector_cosine_ops) WITH (m=16, ef_construction=64);

ALTER TABLE mnemosyne.mnemo_fact_embeddings_1536 ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemosyne.mnemo_fact_embeddings_1536 FORCE ROW LEVEL SECURITY;
```

---

## 4. Estrategia de Migración, Dual-Read y Rollback (B4-B6)

### 4.1 Fases de Cutover Transparente
1. **Dual-Write Activo**: Al crear o actualizar un hecho (`memory_remember`), el servicio escribe tanto en la columna legacy `mnemo_fact.embedding` (1536) como en la nueva tabla del espacio activo (`mnemo_fact_embeddings_1536`).
2. **Dual-Read con Fallback**: Las consultas de recall (`memory_recall`) intentan primero resolver embeddings en el `spaceId` activo. Si el espacio está vacío o en proceso de backfill, recaen de forma segura sobre la columna legacy.
3. **Backfill Asíncrono en Background**: Un worker outbox procesa la re-vectorización de hechos existentes hacia el nuevo `spaceId`.
4. **Cutover y Depreciación Legacy**: Una vez completado el backfill y validada la tasa de aciertos (`hitRate30d`), el espacio se marca como autoritativo primario.

### 4.2 Garantía de Rollback
Si se detecta cualquier falla en el nuevo motor vectorial, el sistema puede conmutar instantáneamente la bandera de lectura del espacio al modo `legacy-only`, garantizando **cero pérdida de datos** y **cero tiempo de inactividad**.

---

## 5. Criterios de Aceptación y Siguientes Pasos

* ✅ **B7.1 & B7.2**: Spike y decisión de almacenamiento multi-modelo documentados y aprobados.
* 🔲 **Fase B4**: Implementar migraciones SQL DDL (`mnemo_vector_space` y tablas particionadas por dimensión).
* 🔲 **Fase B5**: Conectar el pipeline de recall híbrido con filtrado `spaceId` en `@mnemo-ai/core`.
