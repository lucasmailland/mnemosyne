# Despliegue de `@mnemo-ai/server`

[English](README.md) · **Español**

> **Alcance:** configuraciones de despliegue específicas de cada plataforma (Fly.io, Railway, imágenes).
> NO es dueño de los Dockerfiles: esos viven en [`docker/`](../docker/README.es.md).
> NO es dueño de los manuales operativos: esos viven en [`docs/deploy/`](../docs/deploy/OPERATIONS.es.md).
> Punto de entrada: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.es.md).

| Destino                        | Configuración                             | Estado                                                                        |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| **Docker Compose autoalojado** | [`docker/`](../docker/README.es.md)       | Probado: es la vía de referencia                                              |
| **Fly.io**                     | [`fly.toml`](../fly.toml) (raíz del repo) | Migraciones y salud verificadas con la misma imagen; no se ejecutó en Fly     |
| **Railway**                    | [`railway.json`](./railway.json)          | Migraciones y salud verificadas con la misma imagen; no se ejecutó en Railway |

## Lo que comparten todos los destinos

- **Una sola imagen**, `docker/Dockerfile.server`. Define `NODE_ENV=production`, escucha en `PORT`
  (3000 por defecto) y arranca con `node /app/dist/index.js`.
- **Migraciones desde esa misma imagen:** `node /app/scripts/run-migrations.mjs` aplica los flujos
  v2 y v3 y después crea el rol de inicio de sesión `mnemo_app`. También es el punto de entrada de
  la imagen de migración aparte. Ejecútalo antes de que arranque cada versión nueva: Fly lo ejecuta
  como `release_command`, Railway como `preDeployCommand` y Compose como el servicio `migrate`.
- **Salud:** `/health/live` (vida, sin dependencias) y `/health/ready` (disponibilidad: sin
  autenticación, `200` mientras Postgres responde, `503` cuando no). `/health/deep` pide un token
  bearer, así que una comprobación de la plataforma no puede usarlo.
- **Métricas:** `/metrics/prometheus` (alias `/metrics`) en el mismo puerto. En producción
  responden `404` hasta que se define `MNEMO_METRICS_TOKEN`, y desde ahí solo a
  `Authorization: Bearer <token>`.

### Ajustes

| Variable                       | Obligatoria        | Qué es                                                                                                                              |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_MIGRATION_DATABASE_URL` | Sí                 | URL del superusuario directa a Postgres, solo para las migraciones (nunca un pooler de transacciones como pgBouncer).               |
| `MNEMO_APP_DB_PASSWORD`        | Sí                 | Contraseña que las migraciones le dan al rol `mnemo_app`.                                                                           |
| `DATABASE_URL`                 | Sí                 | La URL del servidor, como `mnemo_app`: `postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@<host>:5432/<db>`. Un superusuario se rechaza. |
| `MNEMO_MASTER_KEY`             | Sí                 | Cifra las filas confidenciales. `openssl rand -hex 32`; en producción el servidor no arranca sin ella.                              |
| `MNEMO_KEY_PEPPER`             | Sí                 | Protege los tokens de API guardados. `openssl rand -hex 32`; en producción el servidor no arranca sin ella.                         |
| `MNEMO_REDIS_URL`              | Sí                 | Redis para límites de tasa, idempotencia y el nivel caliente; producción lo exige.                                                  |
| `MNEMO_LLM_API_KEY`            | Sí, en la práctica | Clave del proveedor de modelos y embeddings; sin ella `POST /recall` sin vector responde `501`.                                     |
| `MNEMO_DASHBOARD_SECRET`       | Para el panel      | Firma la cookie de sesión del panel (al menos 32 bytes). Sin ella, el inicio de sesión del panel queda desactivado.                 |
| `MNEMO_METRICS_TOKEN`          | Para las métricas  | Token bearer de `/metrics*`. Sin él, en producción responden `404`.                                                                 |

La lista completa está en [`docker/.env.example`](../docker/.env.example) y en
[`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.es.md).

---

## 1. Docker Compose autoalojado (probado)

```bash
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne/docker
cp .env.example .env       # fill in MNEMO_LLM_API_KEY
docker compose up -d
```

Compose levanta Postgres, ejecuta las migraciones y arranca el servidor. Para producción usa la
capa descrita en [`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.es.md);
[`../docker/README.md`](../docker/README.es.md) es la guía de operación completa.

---

## 2. Fly.io

[`fly.toml`](../fly.toml) construye `docker/Dockerfile.server` desde la raíz del repositorio. Ten
a mano un Postgres con la extensión `vector` disponible (Fly Postgres o uno gestionado) y un Redis,
define los secretos de la tabla de arriba (la cabecera de `fly.toml` lista los comandos) y
despliega:

```bash
fly launch --no-deploy --copy-config   # or: fly apps create mnemosyne
fly secrets set MNEMO_MIGRATION_DATABASE_URL=... MNEMO_APP_DB_PASSWORD=... DATABASE_URL=...
fly secrets set MNEMO_MASTER_KEY=... MNEMO_KEY_PEPPER=... MNEMO_REDIS_URL=... MNEMO_LLM_API_KEY=...
fly deploy
```

Cada despliegue ejecuta `release_command` (las migraciones) en una máquina temporal antes de
actualizar ninguna máquina; si falla, el despliegue se detiene. Las comprobaciones consultan
`/health/live` y `/health/ready`. No hay sección `[metrics]`: el agente de métricas de Fly no
puede enviar el token bearer, así que lee `/metrics/prometheus` desde un Prometheus propio.

`.github/workflows/deploy-canary.yml` (un canary gradual en Fly) se conserva, pero solo se ejecuta
si se vuelve a activar GitHub Actions en el repositorio; hoy está desactivado.

---

## 3. Railway

[`railway.json`](./railway.json) construye la misma imagen, ejecuta las migraciones como
`preDeployCommand`, arranca `node /app/dist/index.js` y comprueba `/health/ready`.

```bash
npm i -g @railway/cli
railway login
railway init                       # creates a new project
railway add --plugin postgresql    # Postgres; its DATABASE_URL is the superuser's
railway variables --set 'MNEMO_MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  --set MNEMO_APP_DB_PASSWORD=... --set DATABASE_URL=postgres://mnemo_app:...@... \
  --set MNEMO_MASTER_KEY=... --set MNEMO_KEY_PEPPER=... --set MNEMO_REDIS_URL=... \
  --set MNEMO_LLM_API_KEY=...
railway up                         # builds Dockerfile.server + deploys
railway domain                     # prints your public URL
```

El `DATABASE_URL` propio del plugin de Postgres es de un superusuario: dáselo solo a las
migraciones y apunta el `DATABASE_URL` del servidor al rol `mnemo_app` que ellas crean.

---

## Imágenes

`docker-publish.yml` publicaba imágenes en GHCR con cada push a `main`; con GitHub Actions
desactivado no se ejecuta, así que construye las imágenes tú mismo desde el commit que publicas
(consulta [`docs/RELEASING.md`](../docs/RELEASING.es.md)).
