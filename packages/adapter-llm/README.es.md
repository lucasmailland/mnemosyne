# @mnemo-ai/adapter-llm

[English](README.md) · **Español**

> **Puntero para IA:** conecta el puerto LLMAdapter con los llm-providers concretos. Gestiona el enrutamiento por tarea, la protección de presupuesto y la conmutación entre proveedores.
>
> **Depende de:** @mnemo-ai/types, @mnemo-ai/llm-providers
>
> **Expone:** LlmProviderAdapter
>
> **Estado:** STABLE
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [@mnemo-ai/llm-providers](../llm-providers/README.es.md)

Conecta los proveedores concretos de `@mnemo-ai/llm-providers` con el puerto hexagonal `LLMAdapter`.

## Resumen

En la arquitectura hexagonal de Mnemosyne, el dominio del núcleo depende solo de puertos abstractos:
nunca importa infraestructura concreta. `@mnemo-ai/adapter-llm` es la capa anticorrupción
que se sitúa entre ambos:

- **Capa de infraestructura** — `@mnemo-ai/llm-providers` contiene `CreatedProvider`, un objeto
  concreto que sabe llamar a OpenAI, Anthropic o cualquier otro vendor.
- **Puerto de dominio** — `@mnemo-ai/types` exporta `LLMAdapter`, la interfaz abstracta de la que
  depende el núcleo.
- **Este paquete** — ofrece `LlmProviderAdapter`, que envuelve cualquier `CreatedProvider` y hace
  que cumpla `LLMAdapter` sin filtrar detalles de infraestructura hacia dentro.

Esto significa que el núcleo se puede probar con un adaptador simulado, cambiar a otro vendor con
un cambio de configuración de una línea, y nunca se contamina con `openai`, `@anthropic-ai/sdk` ni
ninguna otra importación de SDK.

## Instalación

```bash
# pnpm (recommended)
pnpm add @mnemo-ai/adapter-llm @mnemo-ai/llm-providers

# npm
npm install @mnemo-ai/adapter-llm @mnemo-ai/llm-providers
```

`@mnemo-ai/llm-providers` es una dependencia entre pares (peer dependency): instálala junto a este paquete.

## Inicio rápido

```typescript
import { createProvider } from "@mnemo-ai/llm-providers";
import { createLlmAdapter } from "@mnemo-ai/adapter-llm";
import { z } from "zod";

// 1. Create a concrete provider (infrastructure layer)
const provider = createProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

// 2. Wrap it in an adapter (adapter layer)
const adapter = createLlmAdapter(provider, { model: "gpt-4o-mini" });

// 3. Use the adapter through the port (domain layer sees only LLMAdapter)
const output = await adapter.generate({
  system: "You are a concise assistant.",
  messages: [{ role: "user", content: "What is hexagonal architecture?" }],
});

console.log(output.content);
// → "Hexagonal architecture separates business logic from infrastructure..."

// 4. Parse structured output directly into a Zod schema
const FactSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  confidence: z.number().min(0).max(1),
});

const fact = await adapter.generateStructured(
  {
    system: "Extract a semantic triple from the user's statement as JSON.",
    messages: [
      { role: "user", content: "The Eiffel Tower is located in Paris." },
    ],
  },
  FactSchema
);

console.log(fact);
// → { subject: "Eiffel Tower", predicate: "located in", object: "Paris", confidence: 0.99 }
```

## Referencia de la API

### `LlmProviderAdapterOptions`

| Opción      | Tipo      | Obligatoria | Valor por defecto | Descripción                                                    |
|-------------|-----------|----------|-------------------|----------------------------------------------------------------|
| `model`     | `string`  | Sí       | —                 | Nombre del modelo que se reenvía al proveedor (p. ej., `"gpt-4o-mini"`).  |
| `id`        | `string`  | No       | `provider.name`   | Identificador lógico de esta instancia del adaptador. Útil al ejecutar varios adaptadores en paralelo. |

### `createLlmAdapter(provider, opts)`

Fábrica de conveniencia. Prefiérela a `new LlmProviderAdapter(...)` en los puntos de llamada.

```typescript
function createLlmAdapter(
  provider: CreatedProvider,
  opts: LlmProviderAdapterOptions
): LLMAdapter
```

**Parámetros**

| Nombre     | Tipo                        | Descripción                         |
|------------|-----------------------------|-------------------------------------|
| `provider` | `CreatedProvider`           | Cualquier proveedor creado por `@mnemo-ai/llm-providers`. |
| `opts`     | `LlmProviderAdapterOptions` | Configuración del adaptador (ver arriba).  |

**Devuelve** — `LLMAdapter` (el tipo de puerto abstracto de `@mnemo-ai/types`).

**Ejemplo**

```typescript
const adapter = createLlmAdapter(provider, {
  id: "primary-llm",
  model: "claude-3-5-haiku-20241022",
});

console.log(adapter.id);    // "primary-llm"
console.log(adapter.model); // "claude-3-5-haiku-20241022"
```

### `LlmProviderAdapter`

La clase que respalda a `createLlmAdapter`. Implementa `LLMAdapter` de `@mnemo-ai/types`.

#### `generate(input: LLMInput): Promise<LLMOutput>`

Llama a `provider.complete()` y convierte la respuesta a `LLMOutput`.

```typescript
interface LLMInput {
  system?: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

interface LLMOutput {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  finishReason: "stop" | "length" | "tool_use";
}
```

**Serialización de mensajes** — los `messages` se serializan como líneas `role: content` (con el
`system` opcional antepuesto). Esto produce la cadena de prompt plana que espera `CreatedProvider.complete`.

**Correspondencia del motivo de finalización**

| Valor del proveedor     | `LLMOutput.finishReason` |
|-------------------------|--------------------------|
| `"stop"`                | `"stop"`                 |
| `"length"` / `"max_tokens"` | `"length"`           |
| `"tool_use"` / `"tool_calls"` | `"tool_use"`       |
| cualquier otro          | `"stop"`                 |

**Lanza** — `Error` si `input.messages` está vacío.

#### `generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T>`

Llama a `provider.complete()` con `json: true` cuando el proveedor anuncia compatibilidad con `jsonMode`,
luego interpreta el resultado como JSON y ejecuta `schema.parse(parsed)`.

```typescript
interface SchemaLike<T> {
  parse(data: unknown): T;
}
```

Sirve cualquier esquema con un método `.parse()`: Zod, Valibot, Arktype o un validador hecho a mano.

```typescript
const result = await adapter.generateStructured(
  { messages: [{ role: "user", content: 'Return {"answer": 42}' }] },
  z.object({ answer: z.number() })
);
// result.answer === 42
```

**Lanza** — `Error` si `input.messages` está vacío, falla la interpretación del JSON o falla la validación del esquema.
Cada error incluye un extracto de diagnóstico del contenido sin procesar.

#### `healthCheck(): Promise<HealthStatus>`

Envía un `complete({ prompt: "ping", maxTokens: 1 })` mínimo al proveedor y mide la latencia
de ida y vuelta.

```typescript
interface HealthStatus {
  status: "ok" | "degraded";
  latencyMs: number;
  detail?: string;  // populated on "degraded"
}
```

```typescript
const health = await adapter.healthCheck();

if (health.status === "ok") {
  console.log(`LLM reachable in ${health.latencyMs}ms`);
} else {
  console.error(`LLM degraded: ${health.detail}`);
}
```

Devuelve `{ status: "degraded", latencyMs: 0 }` de inmediato si el proveedor subyacente no
expone un método `complete`.

## Arquitectura

Este paquete ocupa el anillo de **adaptadores** de la pila hexagonal:

```
┌─────────────────────────────────────────────────────────────────┐
│  @mnemo-ai/core  (domain)                                      │
│                                                                 │
│   depends on ──→  LLMAdapter port  (@mnemo-ai/types)           │
└────────────────────────┬────────────────────────────────────────┘
                         │  implemented by
┌────────────────────────▼────────────────────────────────────────┐
│  @mnemo-ai/adapter-llm  (adapter)                              │
│                                                                 │
│   LlmProviderAdapter  wraps ──→  CreatedProvider                │
└────────────────────────┬────────────────────────────────────────┘
                         │  provided by
┌────────────────────────▼────────────────────────────────────────┐
│  @mnemo-ai/llm-providers  (infrastructure)                     │
│                                                                 │
│   createProvider({ provider: "openai", ... })                   │
│   createProvider({ provider: "anthropic", ... })                │
└─────────────────────────────────────────────────────────────────┘
```

**Garantía de pureza hexagonal** — `@mnemo-ai/adapter-llm` no tiene ninguna importación de `drizzle-orm`,
`pg`, `redis`, `@neondatabase` ni de ninguna otra capa de persistencia. El núcleo sigue siendo totalmente portable
y se puede probar de forma aislada.

**Regla de dependencias** — las dependencias apuntan solo hacia dentro:

```
llm-providers  →  adapter-llm  →  types (port)
                                   ↑
                       core ───────┘
```

## Gestión de errores

| Escenario                                | Error lanzado                                                          |
|------------------------------------------|------------------------------------------------------------------------|
| `input.messages` está vacío              | `"LlmProviderAdapter(<id>): LLMInput.messages must contain at least one message."` |
| El proveedor no expone `complete`        | `"... does not support completions (complete is undefined)."`          |
| `generateStructured` recibe algo que no es JSON | `"... provider returned non-JSON content. Parse error: ... Raw content (first 200 chars): ..."` |
| Falla el análisis del esquema en `generateStructured` | `"... schema validation failed after JSON parse. <zod message>"`       |
| Error de red o del proveedor en `generate` | Se vuelve a lanzar desde el proveedor subyacente, sin envolverlo.    |

Todos los errores incluyen el `id` del adaptador en el mensaje para facilitar la depuración cuando hay varios adaptadores
conectados en la misma aplicación.

## Pruebas

El paquete incluye 20 pruebas unitarias que cubren:

- `generate()` — camino feliz, anteposición del mensaje de sistema, correspondencia del motivo de finalización, protección contra mensajes vacíos
- `generateStructured<T>()` — flag de modo JSON, errores de interpretación, errores de validación del esquema
- `healthCheck()` — camino correcto, degradado ante un error del proveedor, degradado cuando falta `complete`
- `createLlmAdapter()` — valor por defecto del id, sustitución del id

Ejecuta las pruebas:

```bash
# from the package root
pnpm test

# from the monorepo root
pnpm --filter @mnemo-ai/adapter-llm test

# watch mode
pnpm --filter @mnemo-ai/adapter-llm test:watch
```

## Licencia

Apache-2.0 — consulta [LICENSE](../../LICENSE).
