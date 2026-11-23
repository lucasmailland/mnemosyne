# @mnemo-ai/server

[English](README.md) · **Español**

> **Puntero para IA:** servidor HTTP con Hono que expone la API de Mnemosyne en el puerto 3939. Sin estado y escalable horizontalmente.
>
> **Depende de:** @mnemo-ai/core, @mnemo-ai/types, todos los adaptadores (inyectados), hono
>
> **Expone:** API HTTP en :3939, /healthz, /recall, /remember, /facts, /entities, etc.
>
> **Estado:** CASI ESTABLE — algunas rutas devuelven 501 cuando falta configurar un proveedor o adaptador necesario (p. ej., recall sin `vector` y sin un proveedor de LLM para generar embeddings del lado del servidor)
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/API.md](../../docs/architecture/API.es.md)

Servidor de API HTTP basado en Hono para [Mnemosyne](https://github.com/lucasmailland/mnemosyne), un sistema de memoria cognitiva multi-tenant para aplicaciones de IA.

Sin estado. Escalable horizontalmente. Un único esquema de autenticación con token bearer. Especificación OpenAPI 3.1 generada a partir de los mismos esquemas de Zod que el servidor usa para la validación en tiempo de ejecución.

## Instalación

```bash
pnpm add @mnemo-ai/server @mnemo-ai/core @mnemo-ai/llm-providers
```

`@mnemo-ai/core` y `@mnemo-ai/llm-providers` son **dependencias entre pares**: fíjalas tú mismo.

## Ejecución

```bash
# Required
export MNEMO_DATABASE_URL=postgres://user:pass@host:5432/mnemosyne

# Optional — needed only if you want POST /recall to embed queries server-side
export MNEMO_LLM_PROVIDER=openai     # openai | anthropic | google | cohere | mistral | voyage | local
export MNEMO_LLM_API_KEY=sk-...
export MNEMO_EMBED_MODEL=text-embedding-3-small  # default

# Optional infra
export PORT=3939                      # default
export MNEMO_GRPC_PORT=50051          # off by default; h2c listener for the bidirectional gRPC RPCs
export LOG_LEVEL=info                 # default info in prod, debug in dev
export OTEL_EXPORTER_OTLP_ENDPOINT=https://...   # enables tracing if @opentelemetry/sdk-node is installed
export MNEMO_REDIS_URL=redis://...    # When set, activates the Redis-backed ACT-R hot tier for recall. When unset, recall uses the cold cascade only.

mnemosyne-server
```

## Migraciones

Las tablas del servidor, incluidas las claves de API, las crea el flujo de migraciones de `@mnemo-ai/core`
(p. ej., `0063_server_api_keys.sql`, y `0064`–`0067` para el hash de búsqueda, el vencimiento, los permisos y el plan).
**No** hay un archivo de migración del servidor aparte. Aplica todas las migraciones con el migrador de core
(`mnemo-migrate`, que lee `DATABASE_URL`) antes de iniciar el servidor:

```bash
# Applies every @mnemo-ai/core migration, including the API-key tables.
DATABASE_URL="$MNEMO_DATABASE_URL" npx mnemo-migrate
```

## Endpoints

Todos los endpoints autenticados requieren `Authorization: Bearer mns_live_<key>`.

| Método | Ruta                  | Descripción                                                            |
| ------ | --------------------- | ---------------------------------------------------------------------- |
| POST   | `/recall`             | Recuperación combinada léxica + vectorial                              |
| POST   | `/remember`           | Crea un hecho                                                          |
| GET    | `/facts/:id`          | Obtiene un hecho                                                       |
| POST   | `/facts/:id/pin`      | Fija / desfija                                                         |
| DELETE | `/facts/:id`          | Borrado lógico (cierra el intervalo bitemporal)                        |
| GET    | `/timeline?since=...` | Eventos recientes del ciclo de vida de los hechos                      |
| GET    | `/health`             | Constantes vitales cognitivas del espacio de trabajo                   |
| GET    | `/openapi.json`       | Especificación OpenAPI 3.1                                             |
| GET    | `/docs`               | Documentación legible (Scalar)                                         |
| GET    | `/healthz`            | Sonda de vida (sin autenticación)                                      |
| GET    | `/readyz`             | Sonda de disponibilidad (sin autenticación, consulta la base de datos) |

### POST /recall

```jsonc
// request
{
  "query": "What did we decide about pricing tiers?",
  "vector": [0.01, -0.02, ...],   // optional; server embeds if absent
  "topK": 10,
  "vectorWeight": 0.5,             // 0 = lexical, 1 = vector
  "asOf": "2026-06-04T12:00:00Z"   // optional; bitemporal as-of
}

// response
{
  "hits": [{ "id": "fact_...", "content": "...", "score": 0.91, ... }],
  "debug": { "embedded": false, "latencyMs": 12 }
}
```

Si no se proporciona un `vector` **y** no hay un proveedor de LLM configurado, recall devuelve **501 Not Implemented** con un mensaje de error accionable.

## Flujo de autenticación

1. El operador emite una clave mediante tu pipeline de administración (CLI / dashboard / SQL). Formato de la clave: `mns_live_<32-char-cuid>`.
2. El servidor almacena **solo** `bcrypt(key)` en `mnemo_api_keys.key_hash`.
3. En cada solicitud, el middleware bearer:
   - Valida la forma del prefijo (falla rápido, sin el coste de bcrypt).
   - Consulta una caché LRU en proceso (TTL de 60 s) indexada por el token en texto plano.
   - Si no está, recorre los hashes activos y ejecuta `bcrypt.compare`.
   - Guarda en caché la correspondencia `{token -> workspace_id}`.

El TTL de 60 s es un límite deliberado a la latencia de revocación. Si lo aumentas, construye también la invalidación por pub/sub.

## Incrustar el servidor en tu propio árbol de Hono

```ts
import { createApp } from "@mnemo-ai/server";

const app = createApp({
  deps: { core, apiKeys, llm, embedModel: "text-embedding-3-small" },
  version: "0.1.0",
});

export default app; // works with serve, Vercel, Cloudflare Workers (Node compat), etc.
```

## Observabilidad

- **Logs**: pino, JSON en producción, opcionalmente con formato legible en desarrollo (`PINO_PRETTY=1`). Cada solicitud registra `{ method, path, status, latency_ms, request_id, workspace_id }`. Las cabeceras Authorization se ocultan por defecto.
- **Trazado**: opcional. Establece `OTEL_EXPORTER_OTLP_ENDPOINT` e instala `@opentelemetry/sdk-node` en tu imagen.
- **ID de solicitud**: se devuelve en `X-Request-Id`. Se respeta el de la cabecera entrante si quien llama lo estableció (buena ciudadanía en los pipelines de trazado).

## Docker

```bash
docker build -f docker/Dockerfile.server -t mnemosyne-server:0.1.0 .
docker run --rm -p 3939:3939 \
  -e MNEMO_DATABASE_URL=postgres://... \
  mnemosyne-server:0.1.0
```

Usuario sin privilegios de root, construcción en varias etapas, `HEALTHCHECK` contra `/healthz`. Para una pila local
completa (Postgres + migrate + server) usa `docker/docker-compose.yml`.

## Licencia

Apache-2.0 — consulta `LICENSE` en la raíz del monorepo.
