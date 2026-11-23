# Cómo añadir un nuevo proveedor de LLM

[English](ADD_AN_LLM_PROVIDER.md) · **Español**

> **Estado: guía implementada — verificada el 2026-06-13**
> Verificada contra: `packages/types/src/ports.ts`, `packages/llm-providers/src/`, `packages/adapter-llm/src/index.ts`, `packages/server/src/index.ts`, `packages/server/src/deps.ts`

---

## 0. Cuándo añadir un proveedor nuevo y cuándo usar uno existente

**Añade un proveedor nuevo cuando:**
- Necesites un vendor que no esté en la lista actual (`openai`, `anthropic`, `google`, `cohere`, `mistral`, `voyage`, `ollama`).
- Quieras apuntar a un servidor de inferencia autoalojado con un protocolo de red distinto (no compatible con OpenAI).
- Necesites un servicio solo de embeddings (como Voyage, pero de otro vendor).

**NO añadas un proveedor nuevo cuando:**
- Solo necesites un modelo distinto de un vendor existente: pasa `MNEMO_EMBED_MODEL` o indica `model` en `EmbedRequest`/`CompleteRequest`.
- Necesites pasar por Azure OpenAI o AWS Bedrock (compatibles con OpenAI): pasa `baseURL` a `OpenAIProvider`; el cuerpo de la solicitud es idéntico.
- Quieras limitar el gasto: usa `BudgetGuard` (reexportado desde `@mnemo-ai/llm-providers`) para envolver cualquier proveedor existente.
- Quieras combinar dos proveedores existentes (p. ej., Voyage para embeddings + Anthropic para completions): usa `LLMRouter` en lugar de escribir una clase nueva.

---

## 1. Entiende las dos capas de interfaz

Hay dos interfaces distintas en juego. Léelas ambas antes de escribir código.

### 1a. `LLMProvider` — el contrato interno del proveedor

**Archivo:** `packages/llm-providers/src/types.ts`

```typescript
export interface LLMProvider {
  readonly name: string;
  readonly capabilities: LLMCapabilities;
  embed?(input: EmbedRequest): Promise<EmbedResponse>;
  complete?(input: CompleteRequest): Promise<CompleteResponse>;
}
```

Tanto `embed` como `complete` son **opcionales**. Un proveedor declara lo que puede hacer mediante los flags de `capabilities` (`embed: boolean`, `complete: boolean`, `streaming: boolean`, `jsonMode: boolean`). `LLMRouter` los comprueba antes de enrutar.

- Implementa **solo `embed`** si tu vendor es solo de embeddings (como Voyage AI).
- Implementa **solo `complete`** si tu vendor es solo de completions (como Anthropic, que no tiene una API nativa de embeddings a 2026-Q2).
- Implementa **ambos** si tu vendor admite los dos (como OpenAI, Google, Cohere, Mistral, Ollama).

### 1b. `LLMAdapter` — el puerto hexagonal que usa `@mnemo-ai/core`

**Archivo:** `packages/types/src/ports.ts`

```typescript
export interface LLMAdapter {
  readonly id: string;
  readonly model: string;
  generate(input: LLMInput): Promise<LLMOutput>;
  generateStructured<T>(input: LLMInput, schema: SchemaLike<T>): Promise<T>;
  healthCheck(): Promise<HealthStatus>;
}
```

**No implementas `LLMAdapter` directamente.** La clase `LlmProviderAdapter` de `packages/adapter-llm/src/index.ts` ya convierte cualquier `CreatedProvider` (la forma que devuelve `createProvider()`) en un `LLMAdapter`. Solo implementas `LLMProvider`.

Del mismo modo, el servidor también consume una interfaz más reducida, `LLMProviderLike` (definida en `packages/server/src/deps.ts`), que solo exige `embed(text, model)`. La fábrica `createProvider()` de `packages/llm-providers/src/factory.ts` adapta cualquier `LLMProvider` a este contrato automáticamente.

---

## 2. Lista de verificación ordenada

### Paso 1 — Crea el archivo del proveedor
- [ ] Crea `packages/llm-providers/src/<vendorname>/index.ts`
- [ ] Implementa `LLMProvider` usando `fetch` directamente mediante el helper compartido `httpJson` (consulta el §3 para el esqueleto)
- [ ] Declara flags de `capabilities` precisos

### Paso 2 — Añade las tarifas de precios (si es alojado o de pago por uso)
- [ ] Añade una entrada de tarifa a la tabla `PRICING` en `packages/llm-providers/src/pricing.ts`

### Paso 3 — Registra el proveedor en la fábrica
- [ ] Añade una rama `case "<vendorname>":` en `packages/llm-providers/src/factory.ts`
- [ ] Añade `"<vendorname>"` al tipo unión `ProviderName` en el mismo archivo

### Paso 4 — Exporta desde el índice del paquete
- [ ] Añade `export { <VendorName>Provider } from "./<vendorname>/index.js";` a `packages/llm-providers/src/index.ts`

### Paso 5 — Conecta el servidor (si quieres la detección automática al arrancar)
- [ ] No hace falta cambiar `packages/server/src/index.ts`: ya llama a `createProvider({ provider: process.env.MNEMO_LLM_PROVIDER, apiKey: process.env.MNEMO_LLM_API_KEY })`. El `switch` de la fábrica (Paso 3) es la única conexión necesaria.

### Paso 6 — Escribe las pruebas
- [ ] Crea `packages/llm-providers/src/__tests__/<vendorname>.test.ts` con una suite de pruebas con HTTP simulado (consulta el §5)

### Paso 7 — Verifica que desaparezcan los errores 501
- [ ] Establece las variables de entorno y ejecuta la prueba de humo de integración (consulta el §6)

---

## 3. Archivo por archivo: qué añadir

### 3a. `packages/llm-providers/src/<vendorname>/index.ts`

[Esqueleto completo con `LLMProvider`, `httpJson`, validación con zod, `estimateEmbedCost`/`estimateCompleteCost`: mismo patrón que `OpenAIProvider`. Para solo embeddings, sigue `VoyageProvider`; para solo completions, sigue `AnthropicProvider`.]

### 3b. `packages/llm-providers/src/pricing.ts`

Añade un bloque de tarifas y añade la clave al mapa exportado `PRICING`.

### 3c. `packages/llm-providers/src/factory.ts`

Dos cambios: añade a la unión `ProviderName`; añade la rama `case "<vendorname>":` del switch; actualiza el mensaje de error por defecto; añade la importación.

### 3d. `packages/llm-providers/src/index.ts`

Añade una línea de exportación junto a los proveedores existentes.

---

## 4. Cómo llega la conexión hasta el servidor

No hace falta cambiar `packages/server/src/index.ts` ni `packages/server/src/deps.ts`. `bootFromEnv()` ya llama a `createProvider({ provider: MNEMO_LLM_PROVIDER, apiKey: MNEMO_LLM_API_KEY })`. El `switch` de la fábrica que añadiste en el Paso 3 es el único punto de conexión.

---

## 5. Cómo probarlo

Estrategia de pruebas unitarias: simula `fetch` con `vi.stubGlobal` y prueba las rutas de éxito y la clasificación de errores (`RateLimitedError`, `ContextOverflowError`). Ejecútalas con:

```bash
pnpm --filter @mnemo-ai/llm-providers test
```

---

## 6. Verifica que desaparezcan los errores 501

Establece `MNEMO_LLM_PROVIDER=<vendorname>` y `MNEMO_LLM_API_KEY=<key>`. Un arranque correcto registra `llm.provider_ready`. Después:

```bash
mnemo recall "test query"
```

Antes: `error: 501 not_implemented — no embed adapter: set MNEMO_LLM_PROVIDER and MNEMO_LLM_API_KEY`
Después: tabla de resultados (o tabla vacía si el espacio de trabajo no tiene hechos).

---

## 7. Nota de seguridad

`MNEMO_LLM_API_KEY` nunca debe aparecer en variables de entorno `NEXT_PUBLIC_*`, nunca debe registrarse en logs ni confirmarse en el control de versiones. Solo se lee en `packages/server/src/index.ts` durante el arranque y nunca llega al cliente ni a la CLI.

---

## 8. Qué NO hacer

- No importes de `@mnemo-ai/core` dentro de un proveedor.
- No implementes `LLMAdapter` directamente: implementa `LLMProvider` y deja que `LlmProviderAdapter` lo envuelva.
- No esquives `httpJson()`: se encarga del timeout y de la clasificación tipada de errores.
- No devuelvas `costUSD: 0` para proveedores de pago por uso: usa `estimateEmbedCost`/`estimateCompleteCost`, que devuelve `undefined` para modelos desconocidos.

---

**Ruta del archivo escrito:** `docs/guides/ADD_AN_LLM_PROVIDER.md`
