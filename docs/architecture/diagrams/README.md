# Diagramas de arquitectura de Mnemosyne

Diagramas HTML interactivos generados con [Archify](https://github.com/tt-a1i/archify) a
partir de un análisis del código en `main` (2026-09-11). Cada HTML es autocontenido: se abre
directo en el navegador y trae tema claro/oscuro, pan/zoom, búsqueda, foco por nodo, vistas
guiadas y exportación a PNG/SVG.

**Fuente de verdad:** los JSON en [`src/`](src/). El HTML es un artefacto derivado; no lo
edites a mano.

| # | Diagrama | Tipo | Qué responde |
|---|---|---|---|
| 01 | [Arquitectura del sistema](01-system-architecture.html) | architecture | Qué procesos existen, cómo entran los agentes (MCP, hooks, SDKs) y qué infraestructura usa el núcleo hexagonal |
| 02 | [Camino de escritura](02-write-path.html) | sequence | Qué pasa, en orden, desde `memory_remember` hasta que el vector queda indexado, y qué es atómico |
| 03 | [Cascada de recall](03-recall-cascade.html) | workflow | Cómo `POST /recall` recorre token budget → hot → pointer → cold, y cuándo degrada a FTS |
| 04 | [Seguridad de una request](04-request-security.html) | workflow | Identidad, scopes por rol, RBAC/aprobaciones, RLS, techo de sensitivity y cifrado |
| 05 | [Harness de captura](05-harness-capture.html) | dataflow | El pipeline de captura de sesiones del host **tal como está hoy en `main`**, incluida la brecha |
| 06 | [Ciclo de vida de una sesión](06-session-lifecycle.html) | lifecycle | Estados `active` → `collapse_pending` → `collapsed`/`archived`, gates y recuperación |
| 07 | [Ciclo de vida de un fact](07-fact-lifecycle.html) | lifecycle | Consolidación con replay, rollback, olvido bitemporal y borrado físico |

## Código de referencia por diagrama

| # | Archivos clave |
|---|---|
| 01 | `packages/server/src/index.ts` (`bootFromEnv`), `packages/server/src/app.ts`, `packages/core/src/cognitive/index.ts` |
| 02 | `packages/server/src/routes/remember.ts`, `packages/core/src/cognitive/remember.ts`, `packages/adapter-postgres/src/repositories/FactRepository.ts`, `packages/adapter-postgres/src/OutboxWorker.ts` |
| 03 | `packages/server/src/routes/recall.ts`, `packages/core/src/cognitive/index.ts` (`recallWithCaches`), `recall-hot.ts`, `recall-pointer.ts`, `recall-cold.ts` |
| 04 | `packages/server/src/auth.ts`, `packages/server/src/middleware/rbac-policy.ts`, `packages/core/src/tx.ts`, `packages/server/src/rbac.ts`, `packages/server/src/encryption/KeyRingAdapter.ts` |
| 05 | `packages/harness/src/{outbox,delivery,consent}.ts`, `packages/plugin/scripts/harness-hook.sh`, `packages/server/src/routes/harness.ts`, `packages/adapter-postgres/src/repositories/HarnessRepository.ts` |
| 06 | `packages/core/src/session/collapse.ts`, `packages/core/src/session/managed-collapse.ts`, `packages/server/src/routes/session.ts`, `packages/server/src/managed-session-worker.ts` |
| 07 | `packages/consolidation/src/{scheduler,ConsolidationGate,ReplayValidator}.ts`, `packages/core/src/cognitive/forget.ts`, `packages/adapter-postgres/src/repositories/FactRepository.ts` |

## Desfase docs ↔ código detectado durante el análisis

Estas diferencias salieron de leer el código con evidencia `archivo:línea`. Los diagramas
siguen al código; la documentación indicada está desactualizada o describe algo que no pasa.

- **Recallable kinds.** `CLAUDE.md` dice que solo `fact` y `decision` son recuperables;
  `packages/types/src/indexing.ts` indexa 9 kinds y devuelve 6 por defecto
  (fact, decision, strategy, workflow, skill, episode).
- **Rutas del core.** `ARCHITECTURE.md` y `ARCHITECTURE_OVERVIEW.md` citan
  `packages/core/src/v3/`; hoy es `packages/core/src/cognitive/`. No existe prefijo `/v1`
  en el cable (`app.ts` monta el router en `/`).
- **Puerto.** El `3000` de `Dockerfile.server`, `fly.toml` y `docker-compose.prod.yml` es
  intencional (OPS-5, el server lee `PORT`). El drift real es el quickstart de `README.md`,
  que manda a `:3000` cuando la pila de `docker/docker-compose.yml` escucha en `3939`.
- **Recall.** `asOf` se acepta pero `recallCold` no lo lee (regresión de `e7840026`, B6.4
  figura como hecho); `contested` siempre es `false` (no hay filtro CaMeL real); el schema
  declara `lexicalScore`/`vectorScore`/`attribution` pero nunca se envían; el route etiqueta
  pointer y L3 como `"cold"`. Que `injectionScore`/`provenance`/`origin` no viajen en el hit
  es **intencional** (allowlist del contrato v1).
- **Outbox.** El comentario de `OutboxWorker.ts` dice `maxRetries` 3; el código usa 5.
- **Collapse.** El header de `collapse.ts` habla de 8 pasos y surprise threshold 0.3; el
  código tiene más pasos y el default de la factory es 0.15. Un throw inesperado cierra la
  sesión, al revés de lo que dice el comentario.
- **Harness.** En `main`, `captureHook` (`packages/cli/src/commands.ts`) devuelve
  `host_adapters_not_installed` y `flushOutbox` no tiene caller fuera de tests: los hooks
  de Claude Code/Codex no encolan y nada envía el outbox al servidor. El lado servidor sí
  está completo.
- **Transcripts.** `forget` de un episodio borra el transcript solo en sesiones managed
  (`source_host` no nulo); los turnos de sesiones manuales no se borran.

## Regenerar

Editá el JSON en `src/`, validá y entregá con Archify (Node 20+):

```bash
ARCHIFY=~/.claude/skills/archify
node $ARCHIFY/bin/archify.mjs validate <tipo> src/<nombre>.<tipo>.json --quality showcase --json
node $ARCHIFY/bin/archify.mjs deliver  <tipo> src/<nombre>.<tipo>.json <nombre>.html --quality showcase --json
node $ARCHIFY/bin/archify.mjs visual-check <nombre>.html --json
```

`<tipo>` es el sufijo del JSON: `architecture`, `sequence`, `workflow`, `dataflow` o
`lifecycle`. Un `deliver` que pasa confirma los 9 checks del artefacto; `visual-check`
comprueba en Chrome real que el visor entre en 1440×900, 1600×1000 y 1920×1080 sin scroll.
Deja capturas y recibos `*.visual-check.*` al lado del HTML; están en `.gitignore`.

**Límite práctico del visor:** solo adapta el ancho de lectura al alto de la pantalla cuando
la relación ancho/alto del viewBox es ≥ 1.55. Con tres tarjetas de dos ítems cortos, en la
práctica hace falta ≥ ~1.65 para entrar en 1440×900. Si agregás contenido, compactá el
espaciado o las tarjetas antes que achicar texto.
