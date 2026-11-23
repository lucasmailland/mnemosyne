# ADR — esquema de rutas de la API (reconciliación del §4)

[English](API_PATHS.md) · **Español**

**Fecha:** 2026-06-18 · **Estado:** REEMPLAZADO (consulta el aviso de abajo) · **Reemplaza:** la lista aspiracional
de rutas `Base: /v1/memory` de `MEMORY_IMPROVEMENT.md` §4 (previa a la implementación).

> **⚠️ REEMPLAZADO el 2026-07-31.** Todo lo que aparece debajo de este aviso describe la
> división `/v1/*` frente a `/v1/memory/*` tal como estaba el 2026-06-18. El commit `6fa7820f`
> ("refactor: remove all v1/v2/v3 version labels from codebase", 2026-06-25)
> eliminó por completo el prefijo de ruta `/v1` de todas las rutas HTTP: el router `v1`
> ahora se monta en la raíz de la aplicación (`app.route("/", v1)` en
> `packages/server/src/app.ts`), no bajo `/v1`. El proxy de reescritura de prefijo
> `app.all("/v1/memory/*")` «publicado» del anexo tampoco existe ya (se eliminó
> incluso antes, en el commit `6149dc00`, por ser contraproducente):
> hoy no existe ningún alias `/v1/memory/*` ↔ `/v1/*` de ningún tipo. Las únicas
> rutas que realmente conservan un segmento `/memory/` son la federación
> (`/memory/federation/*`) y el endpoint de recuperación de eventos perdidos por WS
> (`/memory/events`); `remember`/`recall`/`search`/CRUD de entidades son todas rutas
> simples en la raíz (`/remember`, `/recall`, `/facts`, `/decisions`, …). El
> problema de la «ruta por id ambigua» que describe este ADR ya no aplica: no existe ninguna
> ruta genérica `/memory/{id}` en el código actual.
>
> **Fuente de verdad actual:** `docs/architecture/API.md` (la nota al inicio del archivo
> contiene la declaración autoritativa y mantenida activamente sobre el prefijo de ruta).
> Este archivo se conserva como registro histórico de la decisión del 2026-06-18 y
> de su justificación: no trates nada de lo que sigue como una descripción de la API
> en producción.

## Contexto

El §4 de la especificación maestra lista todos los endpoints bajo `Base: /v1/memory` (p. ej.,
`/v1/memory/facts`, `/v1/memory/decisions`, …). La API implementada diverge:

- **Las operaciones centrales de memoria SÍ están bajo `/v1/memory/*`**: `remember`, `recall`,
  `search`, obtener/actualizar/borrar por id (`/v1/memory/{id}`), `events` y toda la
  superficie `/v1/memory/federation/*`.
- **El CRUD de entidades y la administración están bajo `/v1/*`**: `/v1/facts`, `/v1/decisions`,
  `/v1/tasks`, `/v1/events`, `/v1/entities`, `/v1/relations`, `/v1/episodes`,
  `/v1/reasoning`, `/v1/composition`, `/v1/approvals`, `/v1/usage`, …

La CLI, los tres SDK (`client-ts`, `sdk-go`, `sdk-python`) y los agentes existentes
están programados contra este esquema y se ejecutan sobre él en CI.

## Por qué un alias general `/v1/memory/*` no es seguro

La superficie implementada incluye una **ruta genérica por id `/v1/memory/{id}`**
(obtener/actualizar/borrar un elemento de memoria por id). Eso hace ambigua cualquier
ruta `/v1/memory/<x>` de un solo segmento: `GET /v1/memory/facts` coincide con la ruta con parámetro
con `id = "facts"` y se despacha al manejador por id, no a un manejador de «listar hechos».
Un segundo montaje de los routers de entidades bajo `/v1/memory` choca por tanto con
esta ruta (verificado: ese montaje devuelve el manejador por id / 500 para
`/v1/memory/facts`). Resolverlo de forma limpia exigiría **renombrar la ruta genérica
a `/v1/memory/items/{id}`**, un cambio incompatible para todos los clientes que ya
llaman a `/v1/memory/{id}`.

## Decisión

1. **Mantener el esquema actual, sólido**: `/v1/memory/*` para las operaciones principales
   de memoria + por id + federación; `/v1/*` para el CRUD de entidades y la administración. No es ambiguo,
   ya está publicado y es lo que usan todos los clientes propios.
2. **Reconciliar la especificación con la realidad** (este ADR) en lugar de romper una API que funciona para
   ajustarla a un documento previo a la implementación. Romper contratos de clientes por conformidad documental,
   sin beneficio para el usuario, es lo opuesto a lo profesional.
3. **Aplazar una reubicación uniforme** a una futura **versión mayor**: si se quiere una uniformidad completa
   `/v1/memory/<entity>`, se publica dentro de una versión mayor con la ruta
   genérica renombrada a `/v1/memory/items/{id}`, los routers de entidades montados
   bajo `/v1/memory`, `/v1/*` mantenido como alias con encabezados `Deprecation`/`Sunset` durante una
   ventana de transición, y el documento OpenAPI + los SDK + la CLI regenerados. Sin día de corte.

## Consecuencias

- Los clientes OpenAPI codificados según la especificación que apuntan a `/v1/memory/<entity>` para el CRUD de entidades deben
  usar `/v1/<entity>` hasta la (opcional) reubicación en una versión mayor. Esto está documentado aquí
  y en el OpenAPI servido en `/v1/openapi.json` (la fuente de verdad para los clientes).
- El elemento «100 %» del §4 se considera **reconciliado**: la base `/v1/memory` exigida
  se respeta para la superficie principal de memoria; el prefijo del CRUD de entidades es una divergencia
  registrada y justificada, no una brecha silenciosa.

---

## Anexo — proxy de reescritura de prefijo `/v1/memory/*` (publicado)

**Estado: implementado** (`packages/server/src/app.ts`, línea 386)

Está activo un **proxy de reescritura de prefijo** para `app.all("/v1/memory/*")`. Elimina el
prefijo `/v1/memory` y vuelve a despachar la solicitud dentro de la misma aplicación Hono como
`/v1<sub-path>`. No es un segundo montaje de router (que chocaría con la
ruta genérica `/v1/memory/{id}`), sino una reescritura de ruta que llama a `app.fetch()` con
la URL reescrita, sorteando la colisión por completo.

Efecto: `POST /v1/memory/facts` llega de forma transparente al mismo manejador que
`POST /v1/facts`. Por tanto, todas las operaciones de CRUD de entidades son accesibles con cualquiera de los dos
prefijos. El prefijo canónico sigue siendo `/v1/<entity>` (usado por los SDK, la CLI y
la especificación OpenAPI); `/v1/memory/<entity>` es un alias de conveniencia para
clientes conformes con la especificación.
