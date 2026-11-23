# Mnemosyne — guía de integración

[English](SDK_INTEGRATION.md) · **Español**

Cómo un programa habla con un servidor de Mnemosyne: qué transportes existen, qué paquetes
de cliente se publican y cómo se comporta cada uno, según el código. El contrato de los
endpoints está en [docs/architecture/API.md](../architecture/API.md).

---

## Tabla de contenidos

1. [Panorama de los métodos de integración](#1-panorama-de-los-métodos-de-integración)
2. [Modo embebido — `@mnemo-ai/core`](#2-modo-embebido--mnemo-aicore)
3. [Cliente de la API REST — `@mnemo-ai/client-ts` y SDK](#3-cliente-de-la-api-rest--mnemo-aiclient-ts-y-sdk)
4. [Integración MCP — agentes de IA](#4-integración-mcp--agentes-de-ia)
5. [Integración gRPC — servicio a servicio](#5-integración-grpc--servicio-a-servicio)
6. [Integración WebSocket — suscripciones en tiempo real](#6-integración-websocket--suscripciones-en-tiempo-real)
7. [Integración CLI — el binario `mnemo`](#7-integración-cli--el-binario-mnemo)
8. [Integraciones con frameworks de agentes](#8-integraciones-con-frameworks-de-agentes)
9. [Configuración de proveedores](#9-configuración-de-proveedores)
10. [Resiliencia del lado del cliente](#10-resiliencia-del-lado-del-cliente)
11. [Árbol de decisión para consumir eventos](#11-árbol-de-decisión-para-consumir-eventos)
12. [Composición de varios transportes](#12-composición-de-varios-transportes)
13. [Protocolo de memoria (prompt de sistema del agente)](#13-protocolo-de-memoria-prompt-de-sistema-del-agente)

---

## 1. Panorama de los métodos de integración

Todo pasa por un solo proceso de servidor: REST, ConnectRPC y el WebSocket comparten su
puerto (`PORT`, 3939 por defecto). MCP es un proceso stdio aparte que llama a la API REST.

### Tabla comparativa

| Método        | Paquete                                              | Caso de uso                                            | Autenticación                              | Streaming                       |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ | ------------------------------- |
| **REST**      | `@mnemo-ai/client-ts` / `mnemo-ai-sdk` (Python) / Go | Apps web, backends, scripts, CI                        | `Authorization: Bearer <clave>`            | No                              |
| **MCP stdio** | `@mnemo-ai/mcp`                                      | Agentes de IA (Claude Desktop, Cursor, Windsurf, …)    | `MNEMO_KEY` en la config del cliente MCP   | No                              |
| **gRPC**      | ConnectRPC en `@mnemo-ai/server`                     | Servicios que quieren protobuf o streaming de servidor | Encabezado `authorization: Bearer <clave>` | Streaming de servidor y cliente |
| **WebSocket** | `GET /memory/ws` en `@mnemo-ai/server`               | Paneles y feeds en vivo                                | Parámetro de consulta `?token=<clave>`     | Push                            |
| **CLI**       | `@mnemo-ai/cli` (`mnemo`)                            | Uso en la terminal, scripts, administración            | `MNEMO_KEY` o `~/.mnemo/config.json`       | No                              |

### Árbol de decisión: ¿qué integración debo usar?

```
Are you an AI agent with tool use?
├── Yes → MCP (@mnemo-ai/mcp over stdio, pointed at a running server)
│
└── No
    ├── Do you need real-time push (live UI, graph viewer)?
    │   └── Yes → WebSocket (GET /memory/ws)
    │
    ├── Do you want protobuf or a server stream from a service?
    │   └── Yes → ConnectRPC (section 5; bidirectional needs MNEMO_GRPC_PORT)
    │
    ├── Are you scripting or administering from a shell?
    │   └── Yes → CLI (mnemo)
    │
    └── Everything else → REST (TypeScript, Python or Go client)
```

---

## 2. Modo embebido — `@mnemo-ai/core`

No hay un modo embebido con soporte para aplicaciones. `@mnemo-ai/core` y los adaptadores
(`@mnemo-ai/adapter-postgres`, `-redis`, `-vector`, `-llm`) son paquetes privados del
workspace y no se publican en npm; corren dentro del servidor.

Dentro del monorepo, `createCore(deps, config)` (exportado desde `@mnemo-ai/core/cognitive`)
arma el motor con puertos inyectados: `storage`, `vector`, `embed`, `outbox`, `logger` y
`telemetry` son obligatorios; `cache`, `llm`, `queue` y `auth`, opcionales. No recibe una
URL de base de datos, no abre conexiones y no corre migraciones. El servidor hace este
cableado en `packages/server/src/index.ts`; los detalles están en
[packages/core/README.es.md](../../packages/core/README.es.md).

---

## 3. Cliente de la API REST — `@mnemo-ai/client-ts` y SDK

Los tres clientes envían `Authorization: Bearer <clave>` y llaman a las rutas en la raíz del
servidor (sin prefijo `/v1`).

### SDK de TypeScript

#### Instalación e inicialización

```bash
bun add @mnemo-ai/client-ts
```

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({
  url: "http://localhost:3939", // Self-hosted default (note: "url" not "baseUrl")
  apiKey: "mk_live_abc123",
});
```

Otras opciones: `timeout` (ms, 30 000 por defecto), `retry` (`{ attempts, initialDelayMs, shouldRetry }`),
`userAgent`, `workspaceId` (para un token de usuario `uk_live_`), `locale` (se envía como
`Accept-Language`) y `fetch`.

#### Operaciones principales

```typescript
// Recall — returns { hits: RecallHit[] }
const { hits } = await mnemo.recall({
  query: "What do we know about Redis caching?",
  topK: 5,
});
for (const h of hits) console.log(`[${h.score.toFixed(3)}] ${h.content}`);

// Remember / create a fact
const fact = await mnemo.createFact({
  content: "PostgreSQL is the primary datastore",
});

// Forget a fact
await mnemo.forgetFact("fact_xyz");

// Export workspace
const exported = await mnemo.exportWorkspace();
```

`exportWorkspace()` devuelve un único objeto JSON: `meta` más arreglos como `facts` y
`decisions`, sin embeddings.

#### Idempotencia

```typescript
// Idempotency: pass a stable key as the 3rd argument to avoid duplicate writes on retry
const fact = await mnemo.createFact(
  { content: "Redis 8.0 is deployed" },
  undefined, // AbortSignal (optional)
  crypto.randomUUID() // idempotency key
);
```

#### Manejo de errores

```typescript
import {
  MnemosyneError,
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";

try {
  await mnemo.createFact({ content: "Redis is optional" });
} catch (error) {
  if (error instanceof MnemosyneAPIError) {
    console.error(`API error ${error.status}: ${error.message}`);
  } else if (error instanceof MnemosyneNetworkError) {
    console.error(`Network error: ${error.message}`);
  } else if (error instanceof MnemosyneTimeoutError) {
    console.error(`Request timed out`);
  } else if (error instanceof MnemosyneError) {
    console.error(`Mnemosyne error: ${error.message}`);
  }
}
```

`health()` llama a `GET /health` y `healthReady()` a `GET /health/ready`; el cliente no hace
comprobaciones de salud en segundo plano ni emite eventos.

### SDK de Python

```bash
# Not on PyPI yet: install from the repository
pip install "git+https://github.com/lucasmailland/mnemosyne.git#subdirectory=packages/sdk-python"
```

```python
from mnemo import MnemosyneClient, AsyncMnemosyneClient
from mnemo import MnemosyneAPIError, MnemosyneNetworkError
import asyncio

# Sync client
client = MnemosyneClient(
    url="http://localhost:3939",
    api_key="mk_live_abc123",
    timeout=30.0,
    max_retries=3,
)

# Recall — returns a plain dict; hits are at result["hits"]
result = client.recall(
    query="What do we know about Redis caching?",
    top_k=5,
)
for hit in result["hits"]:
    print(f"[{hit['score']:.3f}] {hit['content']}")

# Create a fact (flat method, not client.facts.create)
fact = client.create_fact("PostgreSQL is the primary datastore")

# Forget a fact
client.forget_fact("fact_xyz")


# Async client
async def main():
    async_client = AsyncMnemosyneClient(
        url="http://localhost:3939",
        api_key="mk_live_abc123",
    )
    try:
        result = await async_client.recall(query="Redis caching")
        for hit in result["hits"]:
            print(f"[{hit['score']:.3f}] {hit['content']}")
    except MnemosyneAPIError as e:
        print(f"API error {e.status}: {e.message}")
    except MnemosyneNetworkError as e:
        print(f"Network error: {e}")

asyncio.run(main())
```

### SDK de Go

`packages/sdk-go` (módulo `github.com/lucasmailland/mnemosyne/packages/sdk-go`) es un cliente
REST construido sobre `net/http`.

```go
import "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"

// NewClient returns (*Client, error) — no functional options
client, err := mnemo.NewClient("http://localhost:3939", "mk_live_abc123")
if err != nil {
    log.Fatal(err)
}

ctx := context.Background()

// Recall — response.Hits is []map[string]interface{}
response, err := client.Recall(ctx, mnemo.RecallInput{
    Query: "deploy process",
    TopK:  5,
})
if err != nil {
    var apiErr *mnemo.APIError
    if errors.As(err, &apiErr) {
        log.Printf("API error %d: %s", apiErr.Status, apiErr.Message)
    }
    return err
}
for _, hit := range response.Hits {
    fmt.Printf("[%.3f] %v\n", hit["score"], hit["content"])
}

// Create a fact (flat method on *Client)
fact, err := client.CreateFact(ctx, mnemo.FactInput{
    Content: "PostgreSQL is the primary datastore",
})
if err != nil {
    return err
}
_ = fact

// Forget a fact
if err := client.ForgetFact(ctx, "fact_xyz"); err != nil {
    return err
}
```

---

## 4. Integración MCP — agentes de IA

`@mnemo-ai/mcp` es un proceso aparte: un servidor MCP sobre stdio que reenvía cada llamada a
una herramienta a un servidor de Mnemosyne en marcha mediante `@mnemo-ai/client-ts`. El
servidor de Mnemosyne no sirve MCP por sí mismo, y MCP no tiene transporte HTTP. Lee
`MNEMO_URL` y `MNEMO_KEY` (las dos obligatorias), y además las opcionales
`MNEMO_WORKSPACE_ID` y `MNEMO_LOCALE`.

### 4a. Configuración del cliente

#### Claude Desktop

Edita `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "mk_live_abc123"
      }
    }
  }
}
```

#### Cursor, Windsurf, Continue y otros clientes

El mismo bloque: `command: "npx"`, `args: ["-y", "@mnemo-ai/mcp"]`, y `MNEMO_URL` y
`MNEMO_KEY` en `env`. Cursor lo lee de `~/.cursor/mcp.json` o de `.cursor/mcp.json`;
Windsurf, de `~/.codeium/windsurf/mcp_config.json`. `mnemo install`, en la CLI, instala el
servidor MCP en cada agente de programación con IA que detecta.

#### Lo que ve el agente

Las 37 herramientas por defecto, entre ellas `memory_recall`, `memory_remember`,
`memory_forget`, `memory_pin`, `memory_decide`, `memory_entity`, `memory_relate`,
`memory_episode_start` y `memory_episode_end` (`MNEMO_MCP_TOOLS=core` reduce la lista a las 9
más usadas). La lista, los esquemas y el alcance que necesita cada una están en
[packages/mcp/README.es.md](../../packages/mcp/README.es.md) y en
[docs/guides/MCP_TOOLS.es.md](../guides/MCP_TOOLS.es.md). En su handshake de inicialización,
el proceso MCP también envía el protocolo de memoria como `instructions` (sección 13).

### 4b. Proveedores

El proceso MCP no llama a ningún LLM ni calcula embeddings: la extracción, los embeddings y
la consolidación corren en el servidor de Mnemosyne con los proveedores configurados allí
(sección 9).

---

## 5. Integración gRPC — servicio a servicio

**Transporte**: ConnectRPC, servido por `@mnemo-ai/server` bajo
`/mnemosyne.v1.MnemosyneService/` en el mismo puerto que REST. El servicio está definido en
`packages/server/proto/mnemosyne.proto`.

El listener principal es `node:http` en `PORT`: HTTP/1.1, sin TLS. Con `MNEMO_GRPC_PORT`
definida, el servidor escucha además en ese puerto con HTTP/2 en claro (h2c) y sirve solo este
servicio ([SERVICES.es.md](../deploy/SERVICES.es.md) §1):

| Protocolo                                         | Unaria | Streaming de servidor | Streaming de cliente | Bidireccional |
| ------------------------------------------------- | :----: | :-------------------: | :------------------: | :-----------: |
| Connect o gRPC-Web en `PORT`                      |   Sí   |          Sí           |          Sí          | No (HTTP 505) |
| gRPC en `PORT`                                    |   No   |          No           |          No          |      No       |
| Cualquiera de los tres en h2c (`MNEMO_GRPC_PORT`) |   Sí   |          Sí           |          Sí          |      Sí       |

Por eso `Session` y `FederationSync`, las dos RPC bidireccionales, necesitan
`MNEMO_GRPC_PORT`; sin ella no se pueden llamar por la red. Las claves `mk_*` del esquema con alcance se rechazan; las claves por defecto
funcionan. El repositorio no publica un cliente generado: genéralo a partir del `.proto`
(los stubs de TypeScript del propio servidor están en `packages/server/src/gen/`). El proto
no define `go_package` ni se publican stubs de Go; desde Go, usa el cliente REST de la
sección 3.

`FederationSync` responde `Unimplemented` a cualquier clave, sea cual sea el transporte: la
federación es solo de extracción, y una extracción empieza con `POST /memory/federation/sync`
([FEDERATION.md](../architecture/FEDERATION.md) §14).

### Configuración de la conexión (TypeScript)

```typescript
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
// Generated from packages/server/proto/mnemosyne.proto (protoc-gen-es)
import { MnemosyneService } from "./gen/mnemosyne_pb.js";

const client = createClient(
  MnemosyneService,
  createConnectTransport({ baseUrl: "http://localhost:3939", httpVersion: "1.1" })
);
const headers = { authorization: "Bearer mns_live_..." };

// Unary
const { results } = await client.recall({ query: "deploy process", limit: 5 }, { headers });
for (const item of results) console.log(`[${item.worth.toFixed(2)}] ${item.content}`);

const remembered = await client.remember(
  { content: "PostgreSQL is the primary datastore", type: "fact", topicKey: "infra/datastore" },
  { headers }
);
if (remembered.conflictDetected) console.warn(`conflict on ${remembered.id}`);

// Server streaming
for await (const event of client.watchMemory({ channels: ["facts.*"] }, { headers })) {
  console.log(event.channel, event.type);
}

// Client streaming
async function* items() {
  yield { content: "Larkspur Robotics ships on Fridays", type: "fact" };
}
const summary = await client.ingestBatch(items(), { headers });
console.log(`accepted=${summary.accepted} rejected=${summary.rejected}`);
```

Para una RPC bidireccional, apunta un transporte HTTP/2 a `MNEMO_GRPC_PORT` (aquí 50051):

```typescript
import { createGrpcTransport } from "@connectrpc/connect-node";

const h2 = createClient(
  MnemosyneService,
  createGrpcTransport({ baseUrl: "http://localhost:50051" })
);
async function* frames() {
  yield { payload: { case: "controlFrame" as const, value: 'start {"agentId":"acme-agent"}' } };
  yield { payload: { case: "userTurn" as const, value: "Larkspur Robotics ships on Fridays" } };
}
for await (const reply of h2.session(frames(), { headers })) console.log(reply.payload);
// started:<session id>, then ack:<turn length>
```

`createConnectTransport({ httpVersion: "1.1" })` es el transporte que usa la prueba del
propio servidor (`packages/server/src/__tests__/unit/grpc-read-max-bytes.test.ts`); el de
HTTP/2 está en `packages/server/src/__tests__/integration/grpc-h2c.integration.test.ts`. Cada
mensaje tiene un tope de 1 MiB. El alcance que necesita cada RPC está en
[SECURITY.md](../architecture/SECURITY.md) §3.

---

## 6. Integración WebSocket — suscripciones en tiempo real

**Endpoint**: `ws://host/memory/ws`

Úsalo para paneles y feeds en vivo. Solo empuja eventos: las peticiones van por REST.

### Conexión

La autenticación va en el parámetro de consulta `?token=`: el servidor la verifica al hacer el upgrade y cierra con el código 1008 si falta o no es válida. No hay autenticación por encabezado para los upgrades de WebSocket.

```typescript
// Token must be in the query string
const ws = new WebSocket("ws://localhost:3939/memory/ws?token=mk_live_abc123");
```

### Suscribirse a canales

El protocolo del servidor usa un frame `{ subscribe: { channel, filter? } }` por canal (no una única acción con varios canales). Envía un frame por cada canal que quieras:

```typescript
ws.onopen = () => {
  // Subscribe to each channel with a separate frame
  ws.send(JSON.stringify({ subscribe: { channel: "facts.*" } }));
  ws.send(JSON.stringify({ subscribe: { channel: "tasks.*" } }));
  // Optional filter narrows events within the channel
  ws.send(
    JSON.stringify({
      subscribe: {
        channel: "facts.*",
        filter: { agentId: "agent_coder_01" }, // Only events from this agent
      },
    })
  );
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data: MnemoBusEvent — { id, channel, type, payload, timestamp, traceId }
  switch (data.type) {
    case "fact.created":
      updateFactList(data.payload);
      break;
    case "task.transitioned":
      updateTaskBoard(data.payload);
      break;
  }
};
```

Los campos del filtro son `entityId`, `agentId` y `memoryType`. El socket solo entrega
eventos del workspace del token.

### Ejemplo de panel en React

```typescript
import { useEffect, useRef, useState } from "react";

function useMnemosyneStream(channels: string[]) {
  const wsRef = useRef<WebSocket | null>(null);
  const [events, setEvents] = useState<MnemoEvent[]>([]);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    let retryDelay = 1000;

    function connect() {
      const ws = new WebSocket(
        `ws://localhost:3939/memory/ws?token=${process.env.NEXT_PUBLIC_MNEMO_KEY}`
      );

      ws.onopen = () => {
        retryDelay = 1000; // Reset on success

        if (lastEventIdRef.current) {
          // Reconnect with catch-up — server replays missed events
          ws.send(JSON.stringify({
            resubscribe: { channels, lastEventId: lastEventIdRef.current },
          }));
        } else {
          // Initial connect — subscribe per channel
          for (const channel of channels) {
            ws.send(JSON.stringify({ subscribe: { channel } }));
          }
        }
      };

      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === "ws.gap") {
          // Missed events — re-sync via REST
          syncMissedEvents(data.oldestAvailable);
        } else {
          lastEventIdRef.current = data.id;
          setEvents((prev) => [...prev.slice(-99), data]); // Keep last 100
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000); // Exponential backoff, max 30s
      };

      wsRef.current = ws;
    }

    connect();
    return () => wsRef.current?.close();
  }, [channels]);

  return events;
}

// Usage
function MemoryFeed() {
  const events = useMnemosyneStream(["facts.*", "tasks.*"]);
  return (
    <ul>
      {events.map((e) => (
        <li key={e.id}>{e.type}: {JSON.stringify(e.payload)}</li>
      ))}
    </ul>
  );
}
```

### Reproducción de eventos al reconectar

Al reconectar, pasa el último `event.id` recibido para recuperar los eventos perdidos. Funcionan los canales exactos, los comodines (`tasks.*`, `*`) y los alias de dominio, y un evento que coincide con varios de tus canales llega una sola vez. El servidor guarda los últimos 200 eventos de cada workspace, durante una hora como máximo, en Redis; sin `MNEMO_REDIS_URL` no guarda nada y cada resuscripción responde con un hueco:

```typescript
ws.send(
  JSON.stringify({
    resubscribe: {
      channels: ["facts.*"],
      lastEventId: "evt_ws12_1717500000000_0042",
    },
  })
);

// The server then sends the missed events as ordinary event frames, oldest first,
// OR, when lastEventId is no longer buffered, one frame per channel:
// { type: "ws.gap", channel: "facts.*", oldestAvailable: "...", message: "..." }
// and you resync over REST.
```

La contraparte REST es `GET /memory/events?since=<eventId>&channel=<canal>`.

---

## 7. Integración CLI — el binario `mnemo`

```bash
npm install -g @mnemo-ai/cli
```

El binario `mnemo` solo usa HTTP: habla con un servidor en marcha. Lee primero `MNEMO_URL` y
`MNEMO_KEY`, y después `~/.mnemo/config.json` (lo escriben `mnemo login` o `mnemo config set`):

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mk_live_abc123
mnemo recall "what's our deploy process?"
mnemo recall --json "deploy" | jq '.hits[].content'
```

Todos los comandos, opciones y formatos de salida están en
[docs/guides/CLI.es.md](../guides/CLI.es.md).

---

## 8. Integraciones con frameworks de agentes

No hay paquetes adaptadores para frameworks de agentes (LangChain, el Vercel AI SDK, CrewAI,
AutoGen). Conéctate por MCP si el framework admite herramientas MCP, o llama al cliente REST
alrededor de las llamadas a tu modelo:

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({ url: "http://localhost:3939", apiKey: "mk_live_abc123" });

// Pattern: recall before each LLM call, remember after
async function agentStep(userMessage: string): Promise<string> {
  // 1. Recall relevant context — recall() returns { hits: RecallHit[] }
  const { hits } = await mnemo.recall({ query: userMessage, topK: 5 });
  const context = hits.map((h) => h.content).join("\n");

  // 2. Call the LLM with context injected
  const response = await llm.generate({
    system: `Context from memory:\n${context}`,
    messages: [{ role: "user", content: userMessage }],
  });

  // 3. Remember important information from the interaction
  if (response.decisionsFound) {
    await mnemo.createFact({ content: response.decisionsFound });
  }

  return response.content;
}
```

---

## 9. Configuración de proveedores

La configuración del LLM y de los embeddings la tiene el servidor, no el cliente.

**Entorno** (se lee al arrancar): `MNEMO_LLM_PROVIDER`, `MNEMO_LLM_MODEL`, `MNEMO_LLM_API_KEY`,
`MNEMO_LLM_BASE_URL`; `MNEMO_EMBED_PROVIDER`, `MNEMO_EMBED_MODEL`, `MNEMO_EMBED_API_KEY`,
`MNEMO_EMBED_BASE_URL`; y ajustes por tarea como `MNEMO_LLM_JUDGE_PROVIDER` o
`MNEMO_LLM_SUMMARY_PROVIDER`. La lista completa está en
[docs/deploy/SERVICES.es.md](../deploy/SERVICES.es.md).

**En tiempo de ejecución**: `PUT /admin/config/llm` define la configuración de toda la
instancia y `PUT /config/llm` la de un workspace; un `GET` sobre cualquiera de las dos la
devuelve con la clave enmascarada. Escribir la de la instancia necesita `admin:workspace`; la
del workspace, `memory:admin`. Guardar una clave de API necesita `MNEMO_MASTER_KEY` (501 sin
ella).

```bash
curl -X PUT http://localhost:3939/config/llm \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "provider": "ollama", "embedModel": "nomic-embed-text", "llmModel": "llama3.1" }'
```

### Proveedores admitidos

`packages/llm-providers/src/factory.ts` acepta:

| Proveedor   | Notas                                                            |
| ----------- | ---------------------------------------------------------------- |
| `openai`    | También cualquier endpoint compatible con OpenAI vía la URL base |
| `anthropic` | Sin embeddings                                                   |
| `google`    | Alias `gemini`                                                   |
| `cohere`    |                                                                  |
| `mistral`   |                                                                  |
| `voyage`    |                                                                  |
| `ollama`    | Local, sin clave de API                                          |
| `bedrock`   | Clave de API o credenciales IAM                                  |
| `nvidia`    | Endpoint NIM compatible con OpenAI                               |

---

## 10. Resiliencia del lado del cliente

Lo que hacen los tres clientes REST (`packages/client-ts/src/http.ts`,
`packages/sdk-python/mnemo/client.py`, `packages/sdk-go/mnemo/client.go`):

- **Reintentos**: TypeScript hace hasta 3 intentos en total (`retry.attempts`); Python y Go
  reintentan hasta 3 veces después del primer intento (`max_retries`, `maxRetries`). La
  espera es un backoff exponencial con jitter completo desde una base de 200 ms, o el
  `Retry-After` del servidor cuando lo envía. Se reintentan: errores de conexión, 429 y 5xx
  (TypeScript), o 429, 500, 502, 503 y 504 (Python y Go). Los timeouts y los demás 4xx no se
  reintentan.
- **Reintento seguro**: solo se reintentan las lecturas (`GET` y `POST /recall`) y las
  escrituras que llevan `Idempotency-Key`. Una escritura que falló con resultado incierto se
  marca `outcomeUnknown` en lugar de reenviarse.
- **Timeout**: 30 s por petición por defecto.

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

const mnemo = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: process.env.MNEMO_KEY!,
  timeout: 10_000,
  retry: { attempts: 5, initialDelayMs: 500 },
});
```

Ningún cliente tiene circuit breaker, agrupación de peticiones, cola de escrituras sin
conexión ni comprobaciones de salud en segundo plano.

---

## 11. Árbol de decisión para consumir eventos

```
Need real-time updates?
│
├── No
│   └── REST polling
│       Use: GET /memory/events?since=<eventId> (the WebSocket replay buffer; needs Redis)
│       or list the resources you care about on an interval
│
└── Yes — What kind of update?
    │
    ├── Push to an external system (Slack, GitHub, PagerDuty, your webhook)
    │   └── Webhooks (POST /webhooks to register an endpoint)
    │       HMAC-SHA256 signed. Retries after 5 m, 30 m, 2 h and 24 h,
    │       then dead letter after the 5th failed attempt.
    │
    ├── Live UI or dashboard
    │   └── WebSocket (ws://host/memory/ws)
    │       Per-channel subscriptions, catch-up from the last 200 events / 1 hour.
    │
    └── Internal service that processes events
        └── gRPC server streaming (WatchMemory, WatchTasks, StreamHealth)
            Over Connect or gRPC-Web on HTTP/1.1 (section 5).
```

---

## 12. Composición de varios transportes

Una aplicación puede usar varios transportes a la vez contra el mismo servidor y workspace;
todos leen y escriben en la misma base de datos Postgres.

- **La misma clave sirve en REST, ConnectRPC, el WebSocket y MCP**, salvo las claves `mk_*`
  del esquema con alcance, que gRPC rechaza.
- **Los límites de tasa y las claves de idempotencia son solo de HTTP.** El limitador de
  peticiones (con Redis) y el almacén de idempotencia no se aplican a las llamadas
  ConnectRPC ([SECURITY.md](../architecture/SECURITY.md) §4.4).
- **El cambio de workspace** (`X-Workspace-Id` con un token de usuario `uk_live_`) es solo de
  HTTP.

### Aislamiento de workspaces en apps multi-tenant

Cada clave de workspace llega a un solo workspace. Usa claves distintas para tenants
distintos:

```typescript
import { MnemosyneClient } from "@mnemo-ai/client-ts";

// Tenant A's agent
const mnemoA = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: "mk_live_tenant_a_xxx",
});

// Tenant B's agent
const mnemoB = new MnemosyneClient({
  url: "http://localhost:3939",
  apiKey: "mk_live_tenant_b_yyy",
});

// mnemoA.recall() and mnemoB.recall() are completely isolated — no data leakage
```

Del lado del servidor, la seguridad a nivel de fila de PostgreSQL impone el límite del
workspace siempre que el servidor se conecte con un rol sin `BYPASSRLS`
([SECURITY.md](../architecture/SECURITY.md) §4).

---

## 13. Protocolo de memoria (prompt de sistema del agente)

El texto que le explica a un agente cómo usar las herramientas de memoria está en tres
lugares que se mantienen alineados a mano (`packages/mcp/src/instructions.ts` explica por qué):

| Copia                                                    | Quién la recibe                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `MCP_INSTRUCTIONS` en `packages/mcp/src/instructions.ts` | Cualquier cliente MCP, como `instructions` en el handshake de inicialización |
| `packages/plugin/skills/memory/SKILL.md`                 | Claude Code y los demás hosts del plugin                                     |
| Los scripts de hooks en `packages/plugin/scripts/`       | Los inyectan los hooks del plugin                                            |

Una integración REST no recibe ninguna: pon tus propias instrucciones en el prompt de sistema
del agente.

`@mnemo-ai/core` también exporta `MEMORY_PROTOCOL_V2` (etiqueta de versión
`MEMORY_PROTOCOL_VERSION`, hoy `v1.4.0`) y `MEMORY_RECALL_GUIDANCE`
(`packages/core/src/protocol/v1.ts`). Ninguna herramienta MCP, ruta ni tarea los lee, y la
columna `protocol_version` de un fact guardado no se toma de esta etiqueta.
