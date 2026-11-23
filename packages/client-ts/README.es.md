# @mnemo-ai/client-ts

[English](README.md) · **Español**

> El cliente TypeScript con tipos para la API HTTP de [Mnemosyne](https://github.com/lucasmailland/mnemosyne), memoria cognitiva para agentes de IA. Sin dependencias en tiempo de ejecución más allá de `fetch`.
>
> [Repositorio](https://github.com/lucasmailland/mnemosyne) · [Referencia de la API](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/API.es.md) · [Estado](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Cero dependencias en tiempo de ejecución. Funciona en Node 20+, Bun, Deno, Cloudflare Workers y navegadores modernos. Habla con un servidor de Mnemosyne por HTTP, así que tu aplicación nunca incrusta el motor ni toca la base de datos.

> **Necesita un servidor de Mnemosyne en marcha y una clave de API.** El [inicio rápido](https://github.com/lucasmailland/mnemosyne/blob/main/README.es.md#inicio-rápido) levanta uno con Docker en unos minutos.

## Instalación

```bash
pnpm add @mnemo-ai/client-ts
# or
npm i @mnemo-ai/client-ts
```

## Empieza en 30 segundos

```ts
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const memory = new MnemosyneClient({
  url: "https://memory.example.com",
  apiKey: process.env.MNEMO_KEY!,
});

const { hits } = await memory.recall({ query: "user email preferences" });
console.log(hits);
```

## Ejemplos

### 1. Recuperación básica

```ts
const result = await memory.recall({
  query: "Acme's preferred communication language",
  topK: 5,
});

for (const hit of result.hits) {
  console.log(`${hit.score.toFixed(2)} — ${hit.content}`);
}
```

### 2. Recuperación con un vector ya calculado

Útil cuando ya tienes el vector de la consulta en una caché de embeddings compartida, o quieres usar un modelo de embeddings no predeterminado. El servidor omite su propia pasada de embedding cuando pasas `vector`.

```ts
import OpenAI from "openai";

const openai = new OpenAI();
const { data } = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: "billing escalation policy",
});

const result = await memory.recall({
  query: "billing escalation policy",
  vector: data[0].embedding,
  topK: 10,
});
```

### 3. Crear un hecho

`createFact` es idempotente mediante un hash del contenido en el servidor: volver a enviar el mismo contenido no lo duplica. La respuesta es el `Fact` creado (incluido su `id` asignado).

```ts
const result = await memory.createFact({
  content: "Acme prefers communication in Spanish.",
  attribution: { source: "user_stated" },
  tags: ["client:acme"],
});

console.log("stored fact:", result.id);
```

### 4. Recuperación con viaje en el tiempo mediante `asOf`

Pregunta qué sabía la memoria en un instante pasado: útil para reproducir decisiones históricas del agente y para las pistas de auditoría.

```ts
const snapshot = await memory.recall({
  query: "team escalation owner",
  asOf: "2026-01-15T00:00:00Z",
  topK: 3,
});
// `snapshot.hits` reflects facts as they existed on Jan 15, 2026.
```

### 5. Gestión de errores

El SDK lanza una jerarquía de errores tipada. Ramifica según la clase, no según el mensaje, para una lógica de reintento y de experiencia de usuario resistente.

```ts
import {
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";

try {
  await memory.recall({ query: "anything" });
} catch (err) {
  if (err instanceof MnemosyneTimeoutError) {
    // Server is alive but slow — degrade gracefully.
  } else if (err instanceof MnemosyneAPIError && err.status === 401) {
    // Rotate API key.
  } else if (err instanceof MnemosyneNetworkError) {
    // DNS / TLS / connection refused. Retry or fail open.
  } else if (err instanceof MnemosyneAPIError) {
    console.error(`Mnemosyne ${err.status} [${err.code}] ${err.requestId}`);
    throw err;
  }
}
```

## Configuración

```ts
new MnemosyneClient({
  url: "https://memory.example.com",
  apiKey: process.env.MNEMO_KEY!,

  // Inject a custom fetch (defaults to global fetch). Useful in tests
  // or when wrapping for tracing.
  fetch: undici.fetch,

  // Per-request timeout in milliseconds. Default 30_000.
  timeout: 10_000,

  // Retry policy for transient failures (5xx + network errors).
  // Default: 3 attempts, exponential backoff with full jitter (200ms,
  // 400ms, 800ms). 4xx errors and timeouts are NOT retried by default.
  retry: {
    attempts: 5,
    initialDelayMs: 100,
    shouldRetry: (err, attempt) => attempt < 5,
  },

  // Optional User-Agent suffix to distinguish traffic in server logs.
  userAgent: "my-app/1.2.3",

  // Optional locale tag (e.g. "es-419"), sent as Accept-Language on every
  // request so the server localizes error messages. Omit to send no header.
  locale: "es-419",
});
```

## API

| Método                                                   | HTTP                                             | Descripción                                                                   |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `recall(input)`                                          | `POST /recall`                                   | Los K hechos más relevantes                                                   |
| `createFact(input)`                                      | `POST /remember`                                 | Persiste un hecho nuevo (idempotente)                                         |
| `getFact(id)`                                            | `GET /facts/:id`                                 | Obtiene un hecho                                                              |
| `pinFact(id)` / `unpinFact(id)`                          | `POST /facts/:id/pin` (`{ pinned: true/false }`) | Protege de la poda automática; no cambia el orden de la recuperación          |
| `forgetFact(id)`                                         | `DELETE /facts/:id`                              | Borrado lógico (cierre bitemporal)                                            |
| `timeline(input)`                                        | `GET /timeline`                                  | Actividad reciente de los hechos                                              |
| `health()`                                               | `GET /health`                                    | Vida + disponibilidad por componente                                          |
| `listAgentPolicies()`                                    | `GET /admin/agent-policies`                      | Todas las políticas RBAC de agente del espacio de trabajo (`memory:admin`)    |
| `getAgentPolicy(agentId)` / `deleteAgentPolicy(agentId)` | `GET` / `DELETE /admin/agent-policy?agentId=`    | Lee o borra la política de un agente                                          |
| `putAgentPolicy(input)`                                  | `PUT /admin/agent-policy`                        | Crea o reemplaza la política de un agente; una clave no puede cambiar la suya |

## Cuándo usar esto y cuándo `@mnemo-ai/core`

| Elige `@mnemo-ai/client-ts` si…                                           | Elige `@mnemo-ai/core` directamente si…                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Hablas con un servidor de memoria compartido desde muchas aplicaciones    | Quieres recuperación en proceso con latencia de submilisegundos           |
| Tu entorno de ejecución no puede alojar Postgres / pgvector / Drizzle     | Ya tienes un pool de Postgres y quieres reutilizarlo                      |
| Necesitas un contrato de red estable frente a refactorizaciones del motor | Quieres todas las interioridades enganchables (extracción, consolidación) |

## Licencia

Apache-2.0 © Lucas Mailland
