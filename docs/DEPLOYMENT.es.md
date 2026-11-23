# Despliegue: elige tu camino

[English](DEPLOYMENT.md) · **Español**

Este es el único punto de entrada de toda la documentación de despliegue.

## Tres directorios, tres roles

```
docker/          ← Reference stack: Dockerfiles + Compose for local dev and self-hosting
deploy/          ← Platform-specific configs (Railway, Fly.io, Render, etc.)
docs/deploy/     ← Runbooks: day-2 operations, monitoring, backup/restore
```

Cada directorio tiene un README que explica exactamente de qué es dueño y de qué NO. Usa la tabla siguiente para orientarte.

| Quiero…                                                   | Ir a                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Probar Mnemosyne en local**                             | [`docker/README.md`](../docker/README.es.md) — sección Quickstart          |
| **Desplegar en un VPS con Docker Compose**                | [`docker/README.md`](../docker/README.es.md) — sección Production          |
| **Ejecutar el servidor y el panel web en producción**     | [`docs/guides/PRODUCTION_DEPLOY.md`](guides/PRODUCTION_DEPLOY.es.md)       |
| **Desplegar en Railway**                                  | [`deploy/README.md`](../deploy/README.es.md) — sección Railway             |
| **Imágenes de Docker precompiladas (hoy no se publican)** | [`deploy/README.md`](../deploy/README.es.md) — sección Prebuilt images     |
| **Monitorear una instancia en ejecución**                 | [`docs/deploy/OPERATIONS.md`](deploy/OPERATIONS.es.md)                     |
| **Entender la arquitectura del servicio**                 | [`docs/deploy/SERVICES.md`](deploy/SERVICES.es.md)                         |
| **Ejecutar las migraciones de la base de datos**          | [`docker/README.md`](../docker/README.es.md) — sección Migrations          |
| **Añadir un destino de despliegue nuevo**                 | [`deploy/README.md`](../deploy/README.es.md) — sección Adding more targets |

## Qué se publica

La superficie de despliegue son dos imágenes de Docker:

| Imagen              | Se compila desde            | Propósito                                  |
| ------------------- | --------------------------- | ------------------------------------------ |
| `mnemosyne-server`  | `docker/Dockerfile.server`  | El servidor de la API HTTP                 |
| `mnemosyne-migrate` | `docker/Dockerfile.migrate` | Ejecutor de migraciones de una sola pasada |

Hoy no se publica ninguna imagen: GitHub Actions está desactivado en este repositorio, así que
el antiguo flujo `docker-publish.yml` no se ejecuta (consulta [RELEASING.md](RELEASING.es.md),
paso 7). Compílalas tú desde el commit que despliegas, en la raíz del repositorio:

```bash
docker build -f docker/Dockerfile.server -t mnemosyne-server .
docker build -f docker/Dockerfile.migrate -t mnemosyne-migrate .
# or every image the compose stack uses:
pnpm docker:build
```

El panel web tiene su propia imagen, que se compila desde `docker/Dockerfile.dashboard`;
consulta [PRODUCTION_DEPLOY.md](guides/PRODUCTION_DEPLOY.es.md).

### Puertos

El servidor escucha en `PORT`. La imagen usa `3000` por defecto. El archivo compose base
(`docker/docker-compose.yml`) define `PORT=3939` y publica `3939`; la capa de producción
(`docker/docker-compose.prod.yml`) ejecuta el servidor en `3000` y le publica el `PORT` del host
(por defecto `3000`).

La pila local publica todos los puertos solo en `127.0.0.1`: el servidor, Postgres, Redis y,
con `--profile local`, Ollama. `MNEMO_BIND=0.0.0.0` publica el servidor en la red; hazlo solo detrás de TLS y con la
capa de producción. `OLLAMA_PORT` mueve el puerto publicado de Ollama fuera de `11434` cuando ya
hay uno corriendo en el host (el servidor llega a Ollama por la red de compose en cualquier caso).

### Ajustes relevantes para la seguridad

| Variable                              | Valor por defecto     | Efecto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MNEMO_SETUP_TOKEN`                   | sin definir           | Registrar la primera clave de API (`POST /bootstrap`, la página de primer arranque del panel) requiere un token de instalación. Por defecto el servidor imprime uno en su log al arrancar, de un solo uso y válido 15 minutos. Define uno fijo (16 caracteres o más) solo para aprovisionamiento desatendido; los valores más cortos se ignoran.                                                                                                                                                                                           |
| `MNEMO_WEBHOOK_ALLOW_HTTP`            | desactivado           | Los webhooks se entregan solo por https. `true` permite http.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MNEMO_WEBHOOK_ALLOW_PRIVATE`         | desactivado           | Los webhooks nunca van a una dirección de loopback, privada, link-local, carrier-NAT, multicast o no especificada, escrita tal cual o alcanzada por DNS. Se comprueba al registrar y antes de cada entrega. `true` permite receptores internos.                                                                                                                                                                                                                                                                                            |
| `MNEMO_TRUSTED_PROXY_IP`              | sin definir           | Lista separada por comas de los proxies cuyo `X-Forwarded-For` se cree para la IP del cliente (listas de IP permitidas, limitador de inicio de sesión, registro de auditoría); el cliente es el salto más a la derecha que no es un proxy. Sin definir: cualquier par en una dirección loopback, privada o link-local cuenta como proxy, lo que es incorrecto detrás de un NAT que reescribe el origen (Kubernetes con `externalTrafficPolicy: Cluster`, Docker Desktop, Docker sin root); en producción el servidor lo avisa al arrancar. |
| `MNEMO_TRUSTED_PROXY_HEADER`          | sin definir           | Una cabecera de una sola dirección que tu proxy define y sobrescribe, como `cf-connecting-ip` detrás de Cloudflare o `x-real-ip`. Se lee solo de un proxy de confianza y solo si se nombra aquí: un proxy que no la define deja pasar la copia del propio cliente.                                                                                                                                                                                                                                                                         |
| `MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES` | `536870912` (512 MiB) | Tamaño máximo al que puede descomprimirse el cuerpo de `POST /import`. El cuerpo de la importación está limitado a 100 MiB; el de cualquier otra ruta, a 1 MiB.                                                                                                                                                                                                                                                                                                                                                                            |
| `MNEMO_EMBED_TIMEOUT_MS`              | `3000`                | Cuánto puede tardar un embedding antes de que la escritura se guarde sin vector y la recuperación pase a búsqueda de texto completo. El bloque de Ollama local de `docker/.env.example` usa `10000`.                                                                                                                                                                                                                                                                                                                                       |
| `MNEMO_SENSITIVITY_CEILING`           | `internal`            | Nivel más alto que cualquier clave de este servidor puede leer o escribir. Una clave solo puede bajarlo. Con el valor por defecto, los recuerdos `confidential` y `restricted` no se pueden usar.                                                                                                                                                                                                                                                                                                                                          |
| `MNEMO_MASTER_KEY`                    | sin definir           | 64 caracteres hexadecimales (`openssl rand -hex 32`). Hace falta para guardar recuerdos `confidential` y `restricted`, que se cifran; sin ella esa escritura se rechaza con 422 `encryption_not_configured` y nunca se guarda en texto plano. Obligatoria al arrancar con `NODE_ENV=production` o `MNEMO_REQUIRE_ENCRYPTION=true`.                                                                                                                                                                                                         |
| `MNEMO_KEY_PEPPER`                    | vacío                 | Clave secreta del HMAC que encuentra una API key con una sola búsqueda (`openssl rand -hex 32`); obligatoria en producción. Cada búsqueda guardada está calculada con el pepper vigente al escribirla: para cambiarlo, pon el valor anterior (vacío si no había) en `MNEMO_KEY_PEPPER_PREVIOUS` y mantenlo hasta que cada clave se haya usado una vez, porque cada una se recalcula en su siguiente uso. Cambiarlo sin eso deja fuera a todas las claves existentes.                                                                       |

## Dependencias mínimas

Todas las vías de despliegue requieren:

- **Postgres** con la extensión `pgvector` (o cualquier host compatible con Postgres que la tenga)
- La variable de entorno `DATABASE_URL`
- Una API de modelos a tu elección. No hay ninguna por defecto: define `MNEMO_LLM_PROVIDER`,
  `MNEMO_LLM_API_KEY` y `MNEMO_LLM_MODEL` para los completados, y `MNEMO_EMBED_PROVIDER` /
  `MNEMO_EMBED_API_KEY` / `MNEMO_EMBED_MODEL` / `MNEMO_EMBED_DIMENSIONS` cuando los embeddings vienen
  de otro proveedor (Anthropic no tiene). `docker/.env.example` tiene bloques listos para OpenAI,
  Gemini, Anthropic con Voyage y un Ollama local (opcional, con `--profile local`; no se elige ningún
  modelo de completados por ti, así que revisa la licencia del que elijas). Un Ollama local no
  necesita clave. Sin proveedor el servidor arranca igual y registra qué falta
  (`llm.no_completion_provider`, `embed.no_provider`). Sin un generador de embeddings, la
  recuperación cae a búsqueda de texto completo (`debug.searchMode: "fts"`), un `mode: "semantic"`
  explícito responde 503 `semantic_search_unavailable` y una escritura sin un `vector` precalculado
  responde 501. Para pruebas sin clave, `MNEMO_EMBED_STUB=true` genera embeddings con un hash, que no
  tienen significado.

La imagen de migración debe ejecutarse correctamente antes de que arranque el servidor.
La pila de Docker Compose de `docker/` gestiona este orden mediante `service_completed_successfully`.

## Esquemas y flujos de migración

El servidor ejecuta **dos flujos de migración de Postgres** en **dos esquemas**, pero
todas las rutas HTTP y las tareas en segundo plano las atiende exclusivamente el esquema `mnemosyne` de
v3 (la Fase 7 de flatten-legacy-dual-core eliminó el cliente heredado
`CoreLike`/`factory.ts`: ya no existe el entorno de ejecución híbrido de doble núcleo):

| Esquema     | Aprovisionado por                                                                          | Usado por                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `public`    | `packages/core/migrations/` (la CLI `mnemo-migrate` del núcleo)                            | Solo la tabla de autenticación heredada (`public.mnemo_api_keys`), conservada por compatibilidad con los despliegues previos a v3; ninguna ruta la lee |
| `mnemosyne` | `packages/adapter-postgres/migrations/baseline/` (la CLI de migración de adapter-postgres) | Todo: cada ruta HTTP, `DrizzleStorageAdapter`, los recordatorios, el colapso de sesiones y las tareas de consolidación en segundo plano                |

La imagen `mnemosyne-migrate` aplica **ambos** flujos en orden (primero el heredado,
luego v3), de modo que una sola ejecución aprovisiona todas las tablas que usa el entorno de ejecución. Ambos
flujos son idempotentes. Ejecutar el flujo heredado sigue siendo obligatorio: el arranque de la autenticación
(`api-key-lookup.ts`) y los roles base de RLS que crea siguen siendo
imprescindibles, pero sus tablas del esquema `public` ya no son una vía de datos activa.

### Actualizar un despliegue existente

Los despliegues antiguos solo tenían el esquema `public` (antes la imagen de migración ejecutaba
solo el flujo heredado), lo que dejaba rotas en ejecución las tareas en segundo plano de v3.
Para actualizar, basta con ejecutar la nueva imagen de migración contra la base de datos existente:

```bash
docker compose up migrate
# or:
docker run --rm \
  -e MNEMO_MIGRATION_DATABASE_URL=postgres://admin:password@postgres:5432/mnemo \
  mnemosyne-migrate
```

La URL de migración debe ser un endpoint directo de PostgreSQL o de pooler en modo sesión.
El pooling en modo transacción no se admite porque el bloqueo de migración pertenece a
una única sesión de backend de PostgreSQL. El entrypoint de Docker no recurre a la
`DATABASE_URL` de la aplicación; la inspección de la URL puede rechazar hosts de PgBouncer conocidos, pero
no puede demostrar el modo de pool de un proveedor arbitrario.

El flujo heredado se vuelve a aplicar sin efecto (todas las migraciones ya están registradas) y el
flujo v3 añade el esquema `mnemosyne`. **No se requiere ninguna migración de datos**: las
tablas de tareas en segundo plano de v3 empiezan vacías. (Migrar los datos de _hechos_ heredados de v2 a las
primitivas de v3 es un asunto aparte y opcional, que resuelve la CLI `mnemo-migrate` de `@mnemo-ai/cup`;
consulta [`packages/cup/README.md`](../packages/cup/README.es.md).)
