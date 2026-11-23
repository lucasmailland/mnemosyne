# @mnemo-ai/types

[English](README.md) · **Español**

> Los tipos de dominio e interfaces compartidos de [Mnemosyne](https://github.com/lucasmailland/mnemosyne), memoria cognitiva para agentes de IA. Casi sin código en tiempo de ejecución (un pequeño ayudante de idioma); el CLI, el servidor MCP y el cliente lo instalan por ti.
>
> [Repositorio](https://github.com/lucasmailland/mnemosyne) · [Modelo de datos](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/DATA_MODEL.md) · [Estado](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Interfaces de TypeScript, enums y tipos de dominio compartidos por toda la arquitectura hexagonal de
Mnemosyne. Este paquete es la única fuente de verdad de cada contrato de puerto y de cada primitiva
de dominio que usan los adaptadores, el núcleo y el servidor.

**Tipos y contratos, sin infraestructura, con un pequeño ayudante de idioma.**
Importa desde aquí cuando necesites tipos; nunca desde un paquete de adaptador.

---

## Rol en la arquitectura

En la arquitectura hexagonal (puertos y adaptadores) de Mnemosyne, `@mnemo-ai/types`
define los **puertos**: las interfaces abstractas de las que depende el dominio central.
Los adaptadores concretos (postgres, redis, vector, etc.) implementan estas interfaces.
Nada en `@mnemo-ai/types` contiene código ejecutable; es una frontera de tipos pura.

```
@mnemo-ai/types  (ports / contracts)
       ↑
@mnemo-ai/core   (domain logic — depends on ports, never on adapters)
       ↑
@mnemo-ai/adapter-*  (concrete implementations of each port)
```

---

## Instalación

```bash
pnpm add @mnemo-ai/types
# or
npm install @mnemo-ai/types
```

Sin dependencias entre pares (peer). Sin requisitos en tiempo de ejecución.

---

## Interfaces de puertos

Cada puerto representa una frontera hexagonal entre el núcleo y la infraestructura.

| Puerto           | Descripción                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `StorageAdapter` | Persiste y consulta sesiones, turnos, hechos y entidades en almacenamiento relacional        |
| `VectorAdapter`  | Inserta y busca embeddings densos por vecino más cercano (pgvector o similar)                |
| `CacheAdapter`   | Caché clave/valor de nivel caliente y operaciones sobre conjuntos ordenados (Redis / Valkey) |
| `LLMAdapter`     | Envía prompts y recibe respuestas de cualquier backend de LLM                                |
| `EmbedAdapter`   | Genera embeddings vectoriales densos a partir de texto                                       |
| `QueueAdapter`   | Publica tareas en una cola de trabajo duradera (consolidación, tareas de recuperación)       |
| `OutboxAdapter`  | Outbox transaccional para entregar de forma fiable los eventos de dominio                    |
| `AuthAdapter`    | Valida las claves de API y resuelve la identidad del espacio de trabajo y del tenant         |

---

## Tipos de dominio

### Sesión y turno

| Tipo                 | Descripción                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| `MnemoSession`       | Una conversación o ventana de contexto individual registrada por el sistema |
| `SessionTurn`        | Un turno (par de mensajes) dentro de una sesión                             |
| `CreateSessionInput` | Forma de la entrada para abrir una sesión nueva                             |

### Hechos y recuperación

| Tipo               | Descripción                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `UpdateFactInput`  | Forma de la mutación para actualizar un hecho existente                        |
| `RememberRequest`  | Carga de entrada para guardar un recuerdo nuevo                                |
| `RememberResponse` | Confirmación con los IDs asignados y las entidades extraídas                   |
| `RecallQuery`      | Parámetros de búsqueda para recuperar recuerdos                                |
| `RecallHit`        | Un resultado puntuado devuelto por la recuperación                             |
| `PrimitiveKind`    | Enum de los 10 tipos cognitivos de hecho (hecho, decisión, episodio, etc.)     |
| `WorthDelta`       | Objeto de valor que representa un cambio en la puntuación de worth de un hecho |

### E/S del LLM

| Tipo         | Descripción                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| `LLMInput`   | Prompt y parámetros enviados a un adaptador de LLM                            |
| `LLMOutput`  | Respuesta de completado con el recuento de tokens y el motivo de finalización |
| `LLMMessage` | Un mensaje individual de rol/contenido en un hilo de chat                     |

### Sistema y autenticación

| Tipo           | Descripción                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `HealthStatus` | Informe de estado del sistema emitido por los endpoints `/health`      |
| `SchemaLike`   | Forma genérica de los objetos de esquema compatibles con Zod           |
| `AuthContext`  | Identidad del espacio de trabajo resuelta tras validar la clave de API |

---

## Ejemplo de uso

```typescript
import type {
  StorageAdapter,
  VectorAdapter,
  MnemoSession,
  RecallQuery,
  RecallHit,
  PrimitiveKind,
} from "@mnemo-ai/types";

// Implement a custom storage adapter
class MyStorageAdapter implements StorageAdapter {
  async createSession(input: CreateSessionInput): Promise<MnemoSession> {
    // ...
  }
  // implement remaining methods...
}

// Use domain types for recall
const query: RecallQuery = {
  workspaceId: "ws_abc123",
  text: "What did we decide about the auth system?",
  kinds: [PrimitiveKind.Decision],
  limit: 10,
};
```

---

## Cuándo usar este paquete

- **Crear un adaptador propio**: implementa la interfaz del puerto correspondiente
- **Escribir lógica del dominio central**: depende solo de los tipos de puerto, nunca de adaptadores
- **Extender el servidor**: usa los tipos de dominio para las formas de petición y respuesta
- **Escribir pruebas**: simula (mock) cualquier interfaz de puerto sin importar infraestructura

Si te encuentras importando desde `@mnemo-ai/adapter-*` en código de dominio,
es una violación de la arquitectura. Depende de `@mnemo-ai/types` en su lugar.

---

## Notas

- Las interfaces de puerto son **estables**. Los cambios incompatibles en cualquier interfaz requieren un
  incremento mayor de semver y una nota de migración en CHANGELOG.md.
- Los 10 valores de `PrimitiveKind` son la taxonomía cognitiva que guía
  la consolidación, el ranking de la recuperación y la atribución en la federación.
- Este paquete publica compilaciones duales CommonJS + ESM con declaraciones `.d.ts` completas.

Consulta [`docs/architecture/DATA_MODEL.md`](https://github.com/lucasmailland/mnemosyne/blob/main/docs/architecture/DATA_MODEL.md) para la referencia completa de los tipos de primitiva.
