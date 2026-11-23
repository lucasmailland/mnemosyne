# Cómo añadir una nueva primitiva cognitiva

[English](ADD_A_PRIMITIVE.md) · **Español**

> **Estado: guía implementada — verificada el 2026-06-13**

---

## 0. Decisión: nueva primitiva o reutilizar una existente

Antes de escribir código, responde estas preguntas:

| Pregunta | Si la respuesta es SÍ → |
|---|---|
| ¿Es conocimiento sobre el comportamiento de un usuario o agente? | Usa `MnemoFact` |
| ¿Es una decisión de arquitectura o de política con su justificación? | Usa `MnemoDecision` |
| ¿Es un registro narrativo acotado de una sesión o reunión? | Usa `MnemoEpisode` |
| ¿Es una persona, organización, proyecto o concepto del mundo real con nombre propio? | Usa `MnemoEntity` |
| ¿Es una heurística disparador→acción que el agente aplica de forma recurrente? | Usa `MnemoStrategy` |
| ¿Es una plantilla reutilizable de un proceso de varios pasos ordenados? | Usa `MnemoWorkflow` |
| ¿Es una plantilla de prompt almacenada para una tarea repetible? | Usa `MnemoSkill` |
| ¿Es un elemento de trabajo con seguimiento, con ciclo de vida y cadena de delegación? | Usa `MnemoTask` |
| ¿Es un registro de auditoría inmutable de algo que ocurrió? | Usa `MnemoEvent` |
| ¿Es una cadena de razonamiento en caché (pregunta + pasos + conclusión)? | Usa `MnemoReasoning` |

**Añade una nueva primitiva solo cuando tu concepto no se pueda expresar como una variante de `kind` de alguna de las 10 anteriores.** Por ejemplo, añadir un `kind: "concern"` a `MnemoFact` (que ya existe) siempre cuesta menos que una tabla nueva.

Decisiones sobre la clase de decaimiento (afectan a la columna `memory_type` y a la elegibilidad para el nivel caliente):

| Clase de decaimiento | Adecuada para |
|---|---|
| `semantic` (lento) | Conocimiento duradero: reglas, políticas, plantillas |
| `episodic` (medio) | Instantáneas temporales: sesiones, perfiles de entidad |
| `working` (rápido) | Elementos de acción perecederos que decaen sin actividad |
| `immutable` | Registros de auditoría de solo añadir (sin `updatedAt`, sin decaimiento) |

---

## Resumen de la lista de verificación

Hay que modificar 6 archivos, en este orden:

- [ ] `packages/types/src/primitives.ts` — interfaz de TypeScript + actualización de la unión
- [ ] `packages/types/src/ports.ts` — tipos de entrada y de filtro + grupo de métodos de `StorageAdapter`
- [ ] `packages/types/src/testing/InMemoryStorageAdapter.ts` — implementación en memoria
- [ ] `packages/adapter-postgres/migrations/v3/00<NN>_add_foo.sql` — nueva migración SQL numerada
- [ ] `packages/core/src/v3/remember.ts` + `forget.ts` + `recall-cold.ts` — casos de despacho
- [ ] `packages/server/src/routes/<primitive>.ts` + registro en `index.ts`

Opcional:

- [ ] `packages/mcp/src/tools/<primitive>.ts` + registro en `packages/mcp/src/index.ts`

---

La guía está escrita en `docs/guides/ADD_A_PRIMITIVE.md`. Cada ruta de archivo, nombre de método, nombre de interfaz, patrón de SQL y trampa se obtuvo leyendo los archivos fuente reales antes de escribir una sola línea.
