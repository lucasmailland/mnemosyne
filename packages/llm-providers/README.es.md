# @mnemo-ai/llm-providers

[English](README.md) · **Español**

> **Puntero para IA:** backends de LLM intercambiables (OpenAI, Anthropic, locales). El núcleo nunca los importa: siempre se inyectan mediante adapter-llm.
>
> **Depende de:** los SDK de los proveedores (openai, @anthropic-ai/sdk, etc.)
>
> **Expone:** OpenAIProvider, AnthropicProvider, createProvider
>
> **Estado:** STABLE
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [CLAUDE.md §Package dependency map](../../CLAUDE.md)

> Adaptadores de LLM intercambiables para [Mnemosyne](https://github.com/lucasmailland/mnemosyne). Embeddings y juicios con tu propio modelo: OpenAI, Anthropic, Google, Cohere, Mistral, Voyage, Ollama.

`@mnemo-ai/llm-providers` es la mitad «trae tu propio LLM» de Mnemosyne. La biblioteca del núcleo (`@mnemo-ai/core`) nunca importa directamente el SDK de un vendor: acepta una interfaz `LLMProvider`. Este paquete implementa esa interfaz para los principales proveedores e incluye un enrutador y una protección de presupuesto para que los espacios de trabajo puedan combinarlos a voluntad.

## Por qué

La memoria cognitiva tiene dos necesidades que pasan por un LLM:

1. **Embeddings** — convertir texto en un vector para almacenarlo y recuperarlo.
2. **Juicios** — extracción de hechos, resolución de conflictos, resúmenes, prefiltrado.

El proveedor óptimo para cada una rara vez es el mismo vendor. Con este paquete puedes:

- Usar **Voyage** para embeddings (la mejor calidad de recuperación de su clase)
- Usar **Anthropic** para juicios (el mejor razonamiento de su clase)
- Limitar el gasto diario con un **BudgetGuard**
- Recurrir a una única clave de OpenAI cuando solo quieres salir a producción

## Matriz de capacidades

| Provider  | Embed | Complete | Streaming | JSON mode | Local |
| --------- | :---: | :------: | :-------: | :-------: | :---: |
| OpenAI    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Anthropic |       |    ✓     |     ✓     |   (\*)    |       |
| Google    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Cohere    |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Mistral   |   ✓   |    ✓     |     ✓     |     ✓     |       |
| Voyage    |   ✓   |          |           |           |       |
| Ollama    |   ✓   |    ✓     |           |   (\*)    |   ✓   |

(\*) Se consigue mediante el prompt, sin modo nativo en la API. Quienes llaman deben validar la salida.

## Instalación

```bash
pnpm add @mnemo-ai/llm-providers
```

Cero dependencias entre pares. Incluye `zod` para validar las respuestas en tiempo de ejecución.
Usa `fetch` nativo: sin SDK de vendors y sin riesgo transitivo.

## Uso

### 1. Un solo proveedor (el caso simple)

```ts
import { OpenAIProvider } from "@mnemo-ai/llm-providers";

const llm = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Embed
const { vectors, costUSD } = await llm.embed({
  texts: ["user said the meeting is on tuesday"],
});

// Judge
const { text } = await llm.complete({
  prompt: "Extract facts from this transcript: ...",
  system: "You are a careful fact extractor.",
  json: true,
});
```

### 2. Enrutador: el mejor proveedor para cada tarea

```ts
import {
  LLMRouter,
  OpenAIProvider,
  VoyageProvider,
  AnthropicProvider,
} from "@mnemo-ai/llm-providers";

const router = new LLMRouter({
  default: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  perTask: {
    embed: new VoyageProvider({ apiKey: process.env.VOYAGE_API_KEY! }),
    judge: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    summary: new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      defaultCompleteModel: "claude-3-5-haiku-latest", // cheaper for summaries
    }),
  },
});

await router.embed({ texts: ["..."] }); // → Voyage
await router.complete({ prompt: "...", task: "judge" }); // → Claude Sonnet
await router.complete({ prompt: "...", task: "summary" }); // → Claude Haiku
await router.complete({ prompt: "..." }); // → OpenAI (default)
```

Pasa `router` directamente a `@mnemo-ai/core`: este ve un único `LLMProvider`.

### 3. Protección de presupuesto: tope diario estricto

```ts
import { BudgetGuard, OpenAIProvider } from "@mnemo-ai/llm-providers";

const guarded = new BudgetGuard({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  dailyUSDCap: 25.0,
  perRequestCap: 0.5,
  onSpend: (delta, total) => metrics.gauge("llm_spend_usd", total),
});

try {
  await guarded.embed({ texts: ["..."] });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    // surface to user, do NOT retry
  }
}

// Reset from a midnight cron / scheduled function
guarded.reset();
```

BudgetGuard también funciona dentro de un enrutador: envuelve cada proveedor por tarea
para mantener el presupuesto de juicios independiente del presupuesto de embeddings.

**En el servidor.** `@mnemo-ai/server` arma un BudgetGuard cuando defines
`MNEMO_LLM_DAILY_BUDGET_USD`: un tope en USD para las completions del proveedor
de `MNEMO_LLM_*`, que se reinicia a las 00:00 UTC, con el total del día en el
gauge `mnemo_llm_daily_spend_usd`. Al alcanzarlo, el colapso de sesiones, el
rerank, HyDE y la detección de conflictos degradan igual que cuando el LLM no
responde. Los embeddings no tienen tope, así que las escrituras siguen
funcionando. Un modelo que no está en la tabla de precios no se cuenta; el
servidor lo avisa al arrancar.

El servidor arma un `LLMRouter` cuando defines `MNEMO_LLM_JUDGE_*`,
`MNEMO_LLM_SUMMARY_*` o `MNEMO_LLM_PREFILTER_*` (`_PROVIDER`, `_MODEL`,
`_API_KEY`): cada completion del motor declara su tarea, y una tarea sin
variables propias usa `MNEMO_LLM_PROVIDER`. El tope diario cuenta lo que gasta
el proveedor de cada tarea. Consulta
[`docs/guides/LOCAL_DEV_SETUP.es.md`](../../docs/guides/LOCAL_DEV_SETUP.es.md).

### 4. Proveedor personalizado: trae el tuyo

```ts
import type { LLMProvider, EmbedRequest, EmbedResponse } from "@mnemo-ai/llm-providers";

class MyInternalProvider implements LLMProvider {
  readonly name = "internal-bedrock-proxy";
  readonly capabilities = {
    embed: true,
    complete: false,
    streaming: false,
    jsonMode: false,
  };

  async embed(input: EmbedRequest): Promise<EmbedResponse> {
    // Call your internal endpoint, return the standardized shape.
    return {
      vectors: await myInternalEmbed(input.texts),
      tokensUsed: 0,
      model: "internal-v1",
      provider: this.name,
    };
  }
}

// Drop it in anywhere a provider goes — including inside a router.
const router = new LLMRouter({
  default: new OpenAIProvider({ apiKey }),
  perTask: { embed: new MyInternalProvider() },
});
```

## Errores

| Error                         | Cuándo                                    | Qué hacer                         |
| ----------------------------- | ----------------------------------------- | --------------------------------- |
| `LLMProviderError`            | Fallo genérico del vendor                 | Regístralo y muéstralo al usuario |
| `RateLimitedError`            | HTTP 429: incluye `retryAfterMs`          | Espera y reintenta                |
| `ContextOverflowError`        | Entrada demasiado larga para el modelo    | Divide la entrada y reintenta     |
| `CapabilityNotSupportedError` | `embed()` en Anthropic, etc.              | Enruta a otro proveedor           |
| `BudgetExceededError`         | Se alcanzó el tope diario o por solicitud | Muéstralo: NO reintentes          |

## Configuración

Todos los proveedores aceptan el mismo `ProviderConfig`:

```ts
{
  apiKey?: string;            // required for hosted; ignored by Ollama
  baseURL?: string;           // override for Azure / proxy / local emulators
  defaultEmbedModel?: string;
  defaultCompleteModel?: string;
  timeoutMs?: number;         // default 60_000 (120_000 for Ollama)
}
```

## Precios

Una tabla estática en `src/pricing.ts` alimenta el campo `costUSD` de cada
respuesta. Las tarifas corresponden a **2026-Q2**. Para sustituirlas (tarifas
empresariales, despliegues privados), edita tu copia local o envuelve el
proveedor: los helpers de precios se exportan para que puedas reutilizarlos.

Los modelos que no están en la tabla devuelven `costUSD: undefined`. El
`unknownCostPolicy` por defecto de `BudgetGuard` es `"block"`, de modo que los
nombres de modelo mal configurados fallan de forma ruidosa en lugar de gastar de
más en silencio.

## Licencia

Apache-2.0
