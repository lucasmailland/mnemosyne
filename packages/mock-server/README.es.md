# @mnemo-ai/mock-server

[English](README.md) · **Español**

> **Puntero para IA:** simulación (mock) determinista y sin conexión de un subconjunto de la API HTTP de Mnemosyne. Se ejecuta en memoria sin necesitar base de datos ni Redis; está pensada para el desarrollo local y las pruebas de CI que necesitan un servidor HTTP real sin infraestructura.
>
> **Depende de:** hono
>
> **Expone:** `createMockApp` (exportación ESM) · `mnemo-mock` (binario de CLI)
>
> **Estado:** ALPHA — versión 3.0.0-alpha.0
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.es.md](../client-ts/README.es.md)

`@mnemo-ai/mock-server` es un servidor HTTP ligero en memoria que simula un subconjunto de la API de Mnemosyne. Incluye tres hechos semilla deterministas y acepta cualquier token Bearer sin validarlo. No requiere Postgres, Redis ni variables de entorno.

**Rutas simuladas (exactamente lo que implementa `app.ts`):**

| Ruta                | Método | Comportamiento                                                                    |
| ------------------- | ------ | --------------------------------------------------------------------------------- |
| `POST /recall`      | POST   | Devuelve hasta 5 hechos en memoria como `{ hits, total }`                         |
| `POST /remember`    | POST   | Añade un hecho al almacén en memoria y devuelve `{ id, status: "created" }` (201) |
| `GET /health`       | GET    | Devuelve `{ status: "ok", version: "3.0.0-mock", tiers: { hot, cold, vector } }`  |
| `GET /health/ready` | GET    | Devuelve `{ status: "ok" }`                                                       |
| `GET /usage`        | GET    | Devuelve contadores de cuota fijos                                                |
| `GET /sessions`     | GET    | Devuelve `{ items: [], total: 0 }`                                                |
| `GET /tasks`        | GET    | Devuelve `{ items: [], total: 0 }`                                                |
| `GET /events`       | GET    | Devuelve `{ items: [], total: 0 }`                                                |
| `GET /export`       | GET    | Devuelve los hechos en memoria como NDJSON (`application/x-ndjson`)               |
| Todo lo demás       | any    | Error JSON 404                                                                    |

Este es un **subconjunto** de la API completa del servidor. Rutas como `/facts`, `/timeline` y todos los endpoints de escritura autenticados distintos de `remember` no están implementados. Si los necesitas, ejecuta `@mnemo-ai/server` en local.

## Ejecutar el servidor simulado

### Con npx (sin instalar)

```bash
npx @mnemo-ai/mock-server
# → mnemo-mock server running on http://127.0.0.1:3999
```

### Indicar un puerto

```bash
npx @mnemo-ai/mock-server --port=4000
```

El puerto predeterminado es **3999**. Pasa `--port=0` para enlazar un puerto libre al azar (útil en pruebas).

### Con pnpm (desde el repositorio)

```bash
pnpm --filter @mnemo-ai/mock-server start
# or after building:
node packages/mock-server/dist/index.js --port=3999
```

## Usar `createMockApp` en pruebas

Importa directamente la fábrica de la app para controlar el puerto desde el código y cerrar el servidor cuando termine la prueba:

```ts
import { createMockApp } from "@mnemo-ai/mock-server";
import type { Server } from "node:http";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app, port } = await createMockApp(0); // 0 = random free port
  server = app.server as Server;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

it("recalls facts", async () => {
  const res = await fetch(`${baseUrl}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer any_key" },
    body: JSON.stringify({ query: "TypeScript" }),
  });
  const body = await res.json();
  expect(body.hits.length).toBeGreaterThan(0);
});
```

`createMockApp(port?: number)` devuelve `Promise<{ app: { server: Server }, port: number }>`. El campo `port` refleja el puerto realmente enlazado, que difiere del argumento cuando pasas `0`.

## Autenticación

El servidor simulado acepta **cualquier** token Bearer. No se valida ninguna clave de API. Es intencional: la simulación es solo para el desarrollo local y las pruebas automatizadas.

## Datos semilla

El servidor arranca con tres hechos deterministas en memoria:

```
mock-fact-0001  TypeScript generics enable type-safe reuse.         (score: 0.91)
mock-fact-0002  Hexagonal architecture separates ports from adapters. (score: 0.87)
mock-fact-0003  Mnemosyne uses pgvector HNSW for semantic search.     (score: 0.82)
```

`POST /remember` añade hechos nuevos al almacén en memoria mientras dure el proceso. El almacén se reinicia al reiniciar.

## Ejecutar las pruebas

```bash
pnpm --filter @mnemo-ai/mock-server test
```

## Requisitos

Node.js >= 20.0.0

## Licencia

Apache-2.0 — consulta [LICENSE](../../LICENSE).
