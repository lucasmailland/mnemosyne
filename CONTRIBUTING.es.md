# Contribuir a Mnemosyne

[English](CONTRIBUTING.md) · **Español**

Gracias por tu interés. Este archivo es el camino más rápido hacia un entorno de desarrollo funcional y un PR en verde.

## Requisitos previos

- Node.js 22.18+
- pnpm 9+
- Docker (para la pila local de Postgres + pgvector)

## Preparación

```bash
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne
pnpm install
pnpm docker:up                   # builds images on first run, starts the local stack (see below)
pnpm build
pnpm test
```

`pnpm docker:up` ejecuta `docker compose` con `docker/docker-compose.yml` y el
`docker-compose.override.yml` local. En la primera ejecución compila las imágenes del servidor y
de las migraciones (las siguientes las reutilizan; `pnpm docker:build` las vuelve a compilar).
Levanta Postgres + pgvector, Redis, el ejecutor de migraciones de una sola pasada, el servidor en el
puerto 3939, con todos los puertos publicados solo en `127.0.0.1`. La API del modelo sale de
`docker/.env` (copia `docker/.env.example` y descomenta un bloque); Ollama local es opcional con
`--profile local` (ver `docker/README.es.md`).

### Pruebas de integración

`pnpm test:integration` levanta sus propios contenedores de Postgres con Testcontainers. Con
OrbStack, Colima o Docker sin root, apúntalo primero al socket de tu entorno, por ejemplo:

```bash
export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

## Estructura del repositorio

El monorepositorio usa espacios de trabajo de pnpm + Turborepo en muchos paquetes; los principales son:

| Paquete                      | Rol                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@mnemo-ai/types`            | Interfaces de puertos y tipos de dominio. Cero dependencias en tiempo de ejecución.                                             |
| `@mnemo-ai/core`             | Lógica de negocio pura. Sin E/S. Con adaptadores inyectados.                                                                    |
| `@mnemo-ai/adapter-postgres` | StorageAdapter con DrizzleORM + Postgres.                                                                                       |
| `@mnemo-ai/adapter-redis`    | CacheAdapter con Redis.                                                                                                         |
| `@mnemo-ai/adapter-vector`   | VectorAdapter con pgvector.                                                                                                     |
| `@mnemo-ai/adapter-llm`      | Puente del LLMAdapter (delega en llm-providers).                                                                                |
| `@mnemo-ai/llm-providers`    | Backends de LLM intercambiables (OpenAI, Anthropic, …).                                                                         |
| `@mnemo-ai/server`           | Servidor HTTP con Hono que envuelve el núcleo. Sin estado; escalable horizontalmente.                                           |
| `@mnemo-ai/mcp`              | Servidor MCP independiente (stdio). Habla con la API HTTP.                                                                      |
| `@mnemo-ai/client-ts`        | SDK de cliente tipado en TypeScript para la API HTTP.                                                                           |
| `@mnemo-ai/cli`              | CLI de operaciones (`recall`, `remember`, `status`, `forget`, `config`).                                                        |
| `@mnemo-ai/consolidation`    | Servicio de consolidación de recuerdos en segundo plano.                                                                        |
| `@mnemo-ai/cup`              | CUP — migración de datos v2→v3 (basada en reglas; la reclasificación con LLM es opcional).                                      |
| `@mnemo-ai/federation`       | Federación entre instancias (descubrimiento de pares y votación).                                                               |
| `@mnemo-ai/plugins`          | Infraestructura del cargador de plugins.                                                                                        |
| `@mnemo-ai/harness`          | Harness local de transcripciones: captura de sesiones para Claude Code, Codex y OpenCode (opcional).                            |
| `@mnemo-ai/dashboard`        | Panel web (Next.js): observabilidad, configuración y recuperación interactiva.                                                  |
| `@mnemo-ai/mock-server`      | Servidor simulado sin conexión con datos fijos deterministas en memoria (sin base de datos).                                    |
| `packages/plugin`            | Plugin de host para agentes de programación con IA (Claude Code, Codex, Cursor, OpenCode, Gemini): hooks, skill y conexión MCP. |
| `packages/sdk-go`            | SDK de cliente en Go para la API HTTP.                                                                                          |
| `packages/sdk-python`        | SDK de cliente en Python para la API HTTP (`mnemo-ai-sdk`, todavía no está en PyPI).                                            |

Consulta [`CLAUDE.md`](./CLAUDE.md) para la arquitectura completa y la guía de programación con LLM.

## Flujo de trabajo

1. Crea una rama desde `main`: `git checkout -b feat/your-thing`
2. Haz los cambios. Las pruebas viven junto al código fuente como `*.test.ts`.
3. `pnpm test && pnpm lint && pnpm typecheck` — deben pasar antes de abrir un PR.
4. Usa **Conventional Commits** en tus mensajes de commit (`feat:`, `fix:`, `docs:`, `chore:`, y `feat!:` o un pie `BREAKING CHANGE:` para un cambio incompatible). Quien corta la versión los lee para elegir el incremento.
5. Firma cada commit con `git commit -s`. La línea `Signed-off-by:` certifica el
   [Developer Certificate of Origin](https://developercertificate.org/): escribiste el cambio o
   tienes derecho a enviarlo bajo la licencia del proyecto. Es la declaración de licencia de las
   contribuciones del proyecto; no se fusiona un pull request con commits sin firmar.
6. Abre un PR.

**No** ejecutes `changeset add`: Changesets se eliminó.

## Versiones

Las versiones son manuales. GitHub Actions está apagado en este repositorio, así que nada de
`.github/workflows/` se ejecuta, tampoco release-please. Los pasos, el orden de publicación y
las reglas de versionado están en [`docs/RELEASING.md`](docs/RELEASING.md).

## Principios de diseño

- **El núcleo no tiene E/S.** Todo es una interfaz de adaptador. Esto es lo que nos permite cambiar Drizzle por `pg` sin procesar, OpenAI por Anthropic, etc.
- **Bitemporal por defecto.** `valid_time` (cuándo es cierto el hecho en el mundo) y `transaction_time` (cuándo lo supimos) son elementos de primera clase.
- **RLS + FORCE.** Aislamiento multi-tenant en la capa de SQL. El rol de la aplicación nunca lo esquiva.
- **Sin fallos silenciosos.** Cada capacidad de un adaptador se controla con un indicador de función; las capacidades ausentes aparecen como errores tipados, nunca como resultados vacíos.

## Estilo de código

Prettier (sin ESLint: `pnpm lint` ejecuta chequeos basados en el typecheck y chequeos propios). Ejecuta `pnpm format` antes de hacer commit.
