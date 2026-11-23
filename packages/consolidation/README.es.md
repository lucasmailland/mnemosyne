# @mnemo-ai/consolidation

[English](README.md) · **Español**

> **Puntero para IA:** servicio de consolidación de recuerdos en segundo plano: filtra por similitud los hechos repetidos y programa el procesamiento del ciclo de sueño.
>
> **Depende de:** @mnemo-ai/types, @mnemo-ai/core
>
> **Expone:** runConsolidationGate (real), startConsolidationScheduler (real)
>
> **Estado:** BETA — la lógica de la compuerta existe; el planificador en segundo plano se conecta al arrancar el servidor
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/CONSOLIDATION.md](../../docs/internals/CONSOLIDATION.md)

Subsistema de consolidación del ciclo de sueño de Mnemosyne v3. Promueve los recuerdos episódicos
al almacenamiento semántico de largo plazo fusionando pares de hechos candidatos que superan una
compuerta de varias condiciones, de forma análoga a la consolidación de la memoria durante el sueño de ondas lentas
en la neurociencia cognitiva.

---

## Qué hace

Durante la consolidación, la tarea revisa los hechos episódicos recientes del espacio de trabajo,
empareja los candidatos semánticamente similares y, por cada par que supera la
`ConsolidationGate`, llama a un LLM para producir un hecho semántico fusionado. El hecho
fusionado absorbe el valor de los dos originales y los reemplaza en el almacenamiento.

Esto reduce la redundancia (los recuerdos casi idénticos y duplicados se colapsan en uno),
mejora la precisión al recuperar (los hechos semánticos aparecen antes que el ruido episódico) y
controla el crecimiento del almacenamiento a lo largo del tiempo.

---

## Posición en la arquitectura

```
@mnemo-ai/consolidation  (ConsolidationGate, worker)
       ↓ reads via
@mnemo-ai/core  (StorageAdapter + VectorAdapter ports)
       ↓ calls for merging
@mnemo-ai/adapter-llm  (LLMAdapter port)
```

El worker de consolidación es infraestructura: se ejecuta de forma programada y llama a
los mismos puertos del núcleo que usa el servidor principal. No tiene su propia conexión
a la base de datos; recibe instancias de adaptadores inyectadas al arrancar.

---

## Estado de la implementación

| Componente                             | Estado    | Notas                                                                          |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `ConsolidationGate`                    | **Listo** | Las ~10 condiciones están implementadas por completo (grupo ≥ 3)               |
| `runConsolidationGate()`               | **Listo** | Exportada, con pruebas unitarias                                               |
| `ReplayValidator`                      | Listo     | Valida el resultado de la fusión antes de confirmarla                          |
| Runtime del worker de consolidación    | **Listo** | `startConsolidationScheduler()` programa los ciclos con adaptadores inyectados |
| Disparador de la API de administración | **Listo** | `POST /consolidation/trigger` está activo                                      |
| Conectado al servidor en vivo          | **Listo** | El planificador se inicia al arrancar el servidor                              |

---

## ConsolidationGate: condiciones

Un grupo de **≥ 3 hechos** puede fusionarse solo si se cumplen **todas las condiciones**. La compuerta es conservadora por diseño: los pares nunca se fusionan (sería demasiado agresivo).

| Condición                     | Umbral                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| **Tamaño del grupo**          | ≥ 3 miembros                                                        |
| **Sin hechos canónicos**      | Ningún miembro tiene `canonical: true` (exención de gobernanza §11) |
| **Techo de worth**            | Todos los miembros tienen `worth < 0.5`                             |
| **Sin recuperación reciente** | Ningún miembro se recuperó en los últimos 14 días                   |
| **Techo de confianza**        | Cota inferior de Wilson ≤ 0.7 para todos los miembros               |
| **Sin fijar**                 | Ningún miembro tiene `pinned: true`                                 |
| **Sin disputa**               | Ningún miembro está en disputa                                      |
| **Misma sensibilidad**        | Todos los miembros comparten el mismo nivel de `sensitivity`        |
| **Embeddings presentes**      | Todos los miembros tienen un `embedding` no nulo                    |

La compuerta termina en la **primera** condición que falla (`result.failedCondition`).

---

## Uso

```typescript
import { runConsolidationGate } from "@mnemo-ai/consolidation";

const result = runConsolidationGate({
  members: [factA, factB, factC], // cluster of >= 3 facts
});

if (result.passed) {
  // proceed to LLM merge
  console.log("min pairwise cosine:", result.minCosine);
} else {
  console.log("Gate failed:", result.failedCondition); // singular
}
```

---

## Programación de la consolidación

El servidor inicia el worker con `startConsolidationScheduler()` al arrancar. Usa
un intervalo fijo de 60 segundos e inspecciona como máximo 20 hechos candidatos por espacio de trabajo
en cada ciclo. Por ahora no hay configuración de cron en YAML, de tamaño de lote ni de simulación (dry-run).

La consolidación bajo demanda está disponible mediante la API de administración: `POST /consolidation/trigger`.
Solo se admite el modo manual `mode: "fast"` con `dryRun: false`. El modo manual `mode: "deep"`
devuelve HTTP 422 `deep_mode_not_supported`; `dryRun: true` devuelve HTTP 422
`dry_run_not_supported` antes de llamar al planificador o al almacenamiento.

---

## Resumen del algoritmo

1. Obtener hasta 20 hechos activos de cada espacio de trabajo y conservar los candidatos con worth <= 0.4
2. Formar grupos de al menos tres hechos usando sus embeddings almacenados y una similitud coseno >= 0.85
3. Ejecutar `ConsolidationGate` en cada grupo
4. Conservar como sobreviviente el hecho con más impactos (hit count)
5. Marcar los demás hechos como fusionados y aumentar el worth del sobreviviente
6. Ejecutar la validación de replay de forma asíncrona cuando haya un validador disponible
7. Restaurar los hechos absorbidos si la validación de replay marca la fusión

---

## Notas

- La consolidación está **limitada al espacio de trabajo**: los hechos de espacios de trabajo distintos
  nunca se fusionan.
- La API manual aún no tiene modo de vista previa; `dryRun: true` se rechaza con HTTP 422.
