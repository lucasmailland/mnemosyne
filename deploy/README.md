# Deploying `@mnemo-ai/server`

**English** · [Español](README.es.md)

> **Scope:** Platform-specific deployment configs (Fly.io, Railway, images).
> Does NOT own the Dockerfiles — those live in [`docker/`](../docker/README.md).
> Does NOT own operational runbooks — those live in [`docs/deploy/`](../docs/deploy/OPERATIONS.md).
> Entry point: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

| Target                       | Config                                | Status                                                                      |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| **Docker Compose self-host** | [`docker/`](../docker/README.md)      | Tested: the reference path                                                  |
| **Fly.io**                   | [`fly.toml`](../fly.toml) (repo root) | Migration and health steps verified with the same image; not run on Fly     |
| **Railway**                  | [`railway.json`](./railway.json)      | Migration and health steps verified with the same image; not run on Railway |

## What every target shares

- **One image**, `docker/Dockerfile.server`. It sets `NODE_ENV=production`, listens on `PORT`
  (3000 by default) and starts with `node /app/dist/index.js`.
- **Migrations from that same image:** `node /app/scripts/run-migrations.mjs` applies the v2 and
  v3 streams and then creates the `mnemo_app` login role. It is the entrypoint of the separate
  migrate image too. Run it before each new version starts: Fly runs it as `release_command`,
  Railway as `preDeployCommand`, Compose as the `migrate` service.
- **Health:** `/health/live` (liveness, no dependencies) and `/health/ready` (readiness: no auth,
  `200` while Postgres answers, `503` when it does not). `/health/deep` needs a bearer token, so a
  platform check cannot use it.
- **Metrics:** `/metrics/prometheus` (alias `/metrics`) on the same port. In production it answers
  `404` until `MNEMO_METRICS_TOKEN` is set, and then only to `Authorization: Bearer <token>`.

### Settings

| Variable                       | Required          | What it is                                                                                                                 |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_MIGRATION_DATABASE_URL` | Yes               | Superuser URL straight to Postgres, used only by the migrations (never a transaction pooler such as pgBouncer).            |
| `MNEMO_APP_DB_PASSWORD`        | Yes               | Password the migrations give the `mnemo_app` role.                                                                         |
| `DATABASE_URL`                 | Yes               | The server's URL, as `mnemo_app`: `postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@<host>:5432/<db>`. A superuser is refused. |
| `MNEMO_MASTER_KEY`             | Yes               | Encrypts confidential rows. `openssl rand -hex 32`; the server does not boot without it in production.                     |
| `MNEMO_KEY_PEPPER`             | Yes               | Blinds stored API tokens. `openssl rand -hex 32`; the server does not boot without it in production.                       |
| `MNEMO_REDIS_URL`              | Yes               | Redis for rate limits, idempotency and the hot tier; production requires it.                                               |
| `MNEMO_LLM_API_KEY`            | Yes, in practice  | Model and embedding provider key; without it `POST /recall` without a vector answers `501`.                                |
| `MNEMO_DASHBOARD_SECRET`       | For the dashboard | Signs the dashboard session cookie (at least 32 bytes). Unset, dashboard sign-in is off.                                   |
| `MNEMO_METRICS_TOKEN`          | For metrics       | Bearer token for `/metrics*`. Unset, they answer `404` in production.                                                      |

The full list is in [`docker/.env.example`](../docker/.env.example) and
[`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.md).

---

## 1. Docker Compose self-host (tested)

```bash
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne/docker
cp .env.example .env       # fill in MNEMO_LLM_API_KEY
docker compose up -d
```

Compose stands up Postgres, runs the migrations and boots the server. For production use the
overlay described in [`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.md);
[`../docker/README.md`](../docker/README.md) is the full ops guide.

---

## 2. Fly.io

[`fly.toml`](../fly.toml) builds `docker/Dockerfile.server` from the repository root. Bring a
Postgres with the `vector` extension available (Fly Postgres or a managed one) and a Redis, then
set the secrets from the table above (the header of `fly.toml` lists the commands) and deploy:

```bash
fly launch --no-deploy --copy-config   # or: fly apps create mnemosyne
fly secrets set MNEMO_MIGRATION_DATABASE_URL=... MNEMO_APP_DB_PASSWORD=... DATABASE_URL=...
fly secrets set MNEMO_MASTER_KEY=... MNEMO_KEY_PEPPER=... MNEMO_REDIS_URL=... MNEMO_LLM_API_KEY=...
fly deploy
```

Each deploy runs `release_command` (the migrations) in a temporary machine before any machine is
updated; if it fails, the deploy stops. The checks hit `/health/live` and `/health/ready`. There
is no `[metrics]` section: Fly's metrics agent cannot send the bearer token, so scrape
`/metrics/prometheus` from your own Prometheus.

`.github/workflows/deploy-canary.yml` (a graduated canary on Fly) is kept, but it only runs if
GitHub Actions is turned back on for the repository; today it is off.

---

## 3. Railway

[`railway.json`](./railway.json) builds the same image, runs the migrations as
`preDeployCommand`, starts `node /app/dist/index.js` and checks `/health/ready`.

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

The Postgres plugin's own `DATABASE_URL` is a superuser: give it to the migrations only, and point
the server's `DATABASE_URL` at the `mnemo_app` role they create.

---

## Images

`docker-publish.yml` used to push images to GHCR on every push to `main`; with GitHub Actions off
it does not run, so build the images yourself from the commit you release
(see [`docs/RELEASING.md`](../docs/RELEASING.md)).
