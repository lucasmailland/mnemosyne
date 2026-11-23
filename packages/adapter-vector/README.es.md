# @mnemo-ai/adapter-vector

[English](README.md) · **Español**

> **Puntero para IA:** implementa el puerto VectorAdapter mediante un índice HNSW de pgvector. Gestiona el almacenamiento de embeddings y la búsqueda por similitud.
>
> **Depende de:** @mnemo-ai/types, postgres
>
> **Expone:** PgVectorAdapter
>
> **Estado:** STABLE
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

Adaptador de pgvector que implementa el puerto `VectorAdapter` de `@mnemo-ai/types`.
Ofrece búsqueda de vecinos más cercanos sobre vectores densos para recuperar por significado, y guarda
los embeddings en la extensión `pgvector` de PostgreSQL, junto a los datos relacionales
que gestiona `@mnemo-ai/adapter-postgres`.

---

## Posición en la arquitectura

```
@mnemo-ai/core  (VectorAdapter port)
       ↑
@mnemo-ai/adapter-vector  (PgVectorAdapter)
       ↓
PostgreSQL + pgvector extension
       (same Postgres instance as adapter-postgres)
```

Este adaptador comparte la misma conexión a Postgres que `@mnemo-ai/adapter-postgres`.
No hay una base de datos vectorial aparte: pgvector se ejecuta como extensión en la misma
instancia, lo que mantiene pequeña la huella operativa y evita tener que
sincronizar dos almacenes de datos distintos.

---

## Estado de la implementación

| Componente                           | Estado | Notas                                                                                   |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| Interfaz `VectorAdapter`             | Listo  | Definida en `@mnemo-ai/types`                                                           |
| Clase `PgVectorAdapter`              | Listo  | Coseno `halfvec(1536)` sobre pgvector                                                   |
| Upsert / búsqueda / borrado / masivo | Listo  | Implementado; cubierto por pruebas unitarias                                            |
| Índice HNSW + consulta               | Listo  | `m=16`, `ef_construction=64`                                                            |
| Conectado al servidor en vivo        | Listo  | Se inyecta en el núcleo v3 al arrancar el servidor (`packages/server/src/index.ts:249`) |

---

## Parámetros del índice HNSW

El índice vectorial está ajustado para los embeddings `text-embedding-3-small` de OpenAI y los de
Voyage AI, que producen vectores de 1536 dimensiones almacenados como `halfvec`
para reducir a la mitad el almacenamiento sin una pérdida de precisión relevante.

```sql
CREATE INDEX mnemo_fact_embedding_idx
  ON mnemo_fact
  USING hnsw (embedding halfvec_ip_ops)
  WITH (m = 16, ef_construction = 64);
```

| Parámetro         | Valor                    | Justificación                                                       |
| ----------------- | ------------------------ | ------------------------------------------------------------------- |
| `m`               | 16                       | Equilibrio entre conectividad del grafo y tamaño del índice         |
| `ef_construction` | 64                       | Calidad de recuperación al construir frente a velocidad de indexado |
| Tipo              | `halfvec(1536)`          | Flotante de media precisión, reduce el almacenamiento a la mitad    |
| Distancia         | Producto interno (`<#>`) | Coincide con las convenciones de embeddings normalizados            |

Para cargas de trabajo que necesitan mayor cobertura, aumenta `ef_search` al consultar, sin
reconstruir el índice: `SET hnsw.ef_search = 200;`

### Bases de datos compartidas: en producción se requiere pgvector >= 0.8

El índice HNSW es global, mientras que cada búsqueda se filtra por espacio de trabajo (RLS más
un predicado explícito), propietario y tipo **después** de que el índice devolvió sus
`ef_search` candidatos. En una base de datos compartida por muchos espacios de trabajo, un espacio
de trabajo cuyos vectores no son los más cercanos a la consulta podría obtener menos de `topK` resultados,
o ninguno.

Por eso, en cada búsqueda el adaptador ejecuta, dentro de la transacción de la consulta,
`SET LOCAL hnsw.iterative_scan = strict_order` y
`SET LOCAL hnsw.max_scan_tuples = 20000` (opción `maxScanTuples`). `strict_order`
mantiene exacto el orden; `relaxed_order` no es más rápido aquí y puede reordenar filas.
El escaneo se detiene en `max_scan_tuples`, así que un espacio de trabajo muy disperso en una base
de datos enorme aún puede devolver menos resultados de los esperados: sube `maxScanTuples` para ese caso.

Los escaneos iterativos necesitan **pgvector >= 0.8** (`SELECT extversion FROM pg_extension
WHERE extname = 'vector'`). El adaptador detecta la versión una sola vez (llama a `init()`
al arrancar para registrarla pronto). En versiones anteriores registra una advertencia y recurre a
`ef_search = 1000` en cada búsqueda, lo que solo atenúa el problema. En producción usa
pgvector >= 0.8. `iterativeScan: false` fuerza ese recurso.

---

## Interfaz del puerto

```typescript
interface VectorAdapter {
  search(input: VectorSearchInput): Promise<VectorSearchHit[]>;
  upsert(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByFilter(filter: VectorFilter): Promise<number>;
  healthCheck(): Promise<HealthStatus>;
}
```

---

## Instalación

```bash
pnpm add @mnemo-ai/adapter-vector
```

Dependencia entre pares (peer): `postgres` (postgres.js)
Requiere: PostgreSQL >= 15 con la extensión `pgvector` habilitada

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Inicio rápido (una vez conectado)

```typescript
import { PgVectorAdapter } from "@mnemo-ai/adapter-vector";

const vector = new PgVectorAdapter({
  connectionString: process.env.DATABASE_URL!,
  efSearch: 100, // optional — HNSW ef_search parameter
});

// Upsert an embedding
await vector.upsert("fact_abc123", new Float32Array(embeddingArray));

// Semantic search
const hits = await vector.search({
  vector: new Float32Array(queryEmbedding),
  workspaceId: "ws_abc123",
  limit: 10,
});
```

---

## Notas

- Este adaptador **no** genera embeddings: eso es responsabilidad de `EmbedAdapter`.
  Llama primero a `EmbedAdapter.embed()` y luego pasa el vector resultante
  a `VectorAdapter.upsert()`.
- Los vectores se guardan por hecho. Al eliminar un hecho, la eliminación de su embedding se propaga
  mediante el método `deleteByFilter` (no mediante una clave foránea de la base de datos).
- El índice HNSW de pgvector no admite indexación parcial por espacio de trabajo; el
  filtro `workspaceId` se aplica como predicado posterior al escaneo.
