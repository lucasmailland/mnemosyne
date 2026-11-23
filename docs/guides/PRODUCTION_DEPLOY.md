# Production deploy: server and dashboard

**English** · [Español](PRODUCTION_DEPLOY.es.md)

How to run the API server and the web dashboard together in production with the Docker
Compose overlay `docker/docker-compose.prod.yml`. Other targets (Railway, prebuilt
images, day-2 operations) start at [DEPLOYMENT.md](../DEPLOYMENT.md). The server-side
changes the current dashboard relies on are listed in [DASHBOARD_DEPLOY.md](DASHBOARD_DEPLOY.md).

## What runs

| Service     | Built from                    | Listens on                       | Role                               |
| ----------- | ----------------------------- | -------------------------------- | ---------------------------------- |
| `migrate`   | `docker/Dockerfile.migrate`   | nothing (runs once and exits)    | Applies the database migrations    |
| `server`    | `docker/Dockerfile.server`    | `3000` in the production overlay | The HTTP API (one replica or more) |
| `dashboard` | `docker/Dockerfile.dashboard` | `3000`, under `/dashboard`       | The Next.js web dashboard          |

Next to them run `pgbouncer` (pools the server's connections to Postgres, in transaction mode),
`redis-master` (the server's Redis) with `redis-replica-1` and `redis-replica-2`, and
`otel-collector`, plus the base file's `postgres` and `redis` (and `ollama` only with
`--profile local`). The overlay publishes
Postgres, Redis, pgBouncer, Ollama and the collector on `127.0.0.1` only.

The overlay needs Docker Compose 2.24 or later: it replaces the base file's server port with
`!override`, which older versions reject.

All three images build on `node:22-alpine` (Node 22). The npm packages still run on Node 20
or later; only the build and the images moved to 22. The server image does not contain the
dashboard, and only the server and migrate images are published to GHCR: build the dashboard
image from this repository.

## Before you build the dashboard

- **Google Fonts at build time.** The build downloads Inter, JetBrains Mono and GFS Didot
  once from `fonts.googleapis.com` and `fonts.gstatic.com` and bundles them. The running
  container never calls Google. A builder without access to those hosts fails the build.
- **`MNEMO_SERVER_URL` is a build arg and a runtime variable.** The dashboard forwards
  `/dashboard/auth/*`, `/dashboard/api/*` and `/dashboard/bootstrap*` to the server, and
  those rewrites are written into the image at build time. Server-rendered pages read the
  same variable at run time. Set both to the same address; the overlay uses
  `http://server:3000` for both. Set only at run time, the rewrites keep the build default,
  `http://mnemosyne-server:3939` (`docker/Dockerfile.dashboard`), and sign-in fails without a
  clear error unless something answers on that name. Build one image per server address.

## Settings the overlay requires

Compose stops before it starts anything, naming the variable, while one of these is unset:

| Variable                       | What it is                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | The Postgres superuser's password. There is no default in production.                                                         |
| `MNEMO_MIGRATION_DATABASE_URL` | The superuser's URL straight to Postgres, for migrations: `postgres://mnemo:<POSTGRES_PASSWORD>@postgres:5432/mnemo`.         |
| `MNEMO_APP_DB_PASSWORD`        | The app role's password. `migrate` creates the role (`mnemo_app`), and pgBouncer signs in to Postgres with it.                |
| `DATABASE_URL_PROD`            | The server's URL, through pgBouncer: `postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@pgbouncer:5435/mnemo`.                     |
| `MNEMO_MASTER_KEY`             | Encrypts confidential and restricted rows. 64 hex characters (`openssl rand -hex 32`); the server refuses to boot without it. |
| `MNEMO_KEY_PEPPER`             | Blinds stored API tokens. 64 hex characters (`openssl rand -hex 32`); the server refuses to boot without it.                  |
| `REDIS_PASSWORD`               | The password every Redis node asks for; the server's default URL carries it. URL-safe: `openssl rand -hex 32`.                |
| `MNEMO_DASHBOARD_SECRET`       | See the next section.                                                                                                         |

`MNEMO_LLM_API_KEY` and the model settings are in [`docker/README.md`](../../docker/README.md).

**Metrics.** `GET /metrics` and `GET /metrics/prometheus` serve Prometheus metrics. With
`NODE_ENV=production`, which the overlay sets, both answer `404` until you set
`MNEMO_METRICS_TOKEN` (`openssl rand -hex 32`); then a scrape must send
`Authorization: Bearer <token>`, and any other request gets `401`. The edge proxy should still
not route `/metrics*` from the internet: scrape from inside the network.

**Redis.** The server connects to one Redis URL, `MNEMO_REDIS_URL_PROD` (by default
`redis://:<REDIS_PASSWORD>@redis-master:6379/0`; a URL of your own must carry the password too), for the hot tier, rate limits and idempotency. Its client does
not follow Redis Sentinel, so the overlay runs no Sentinel: an automatic failover would leave
the server writing to a demoted, read-only node. The replicas follow the master; to fail over by
hand, promote one (`REPLICAOF NO ONE`) and point `MNEMO_REDIS_URL_PROD` at it. A managed Redis
that keeps one address across failovers works the same way.

**pgBouncer.** It cannot carry the server's startup parameters (`search_path` and the
`MNEMO_PG_*_TIMEOUT_MS` limits) to pooled sessions, so it drops them, and the session takes the
same values from the app role: `migrate` sets them with `ALTER ROLE … IN DATABASE`. To change
them, set `MNEMO_PG_STATEMENT_TIMEOUT_MS`, `MNEMO_PG_LOCK_TIMEOUT_MS` or
`MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` (milliseconds; 60000, 15000 and 60000 by default) in
`docker/.env`: the overlay passes them to both `migrate` and the server, and the new values apply
from the next `migrate` run.

## Server settings the dashboard needs

| Variable                          | Required                | What it does                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_DASHBOARD_SECRET`          | Yes                     | Signs the session cookie. At least 32 bytes (`openssl rand -hex 32`); a shorter value stops the server from booting. Unset, the server boots with dashboard sign-in disabled and logs it once at info level. The overlay refuses to start without it. |
| `MNEMO_PUBLIC_BASE_URL`           | Recommended             | The public HTTPS origin of the dashboard, used in the links shown in Members and in invitations. A value saved in Installation > Settings wins over it.                                                                                               |
| `MNEMO_DASHBOARD_INSECURE_COOKIE` | Never set in production | Development only: sends the cookie without `Secure` so sign-in works over plain HTTP. With `NODE_ENV=production` the server refuses to start if it is `true` (so does `MNEMO_ALLOW_UNSAFE_DB_ROLE`).                                                  |

The server's own settings (`DATABASE_URL_PROD`, `MNEMO_MIGRATION_DATABASE_URL`,
`MNEMO_APP_DB_PASSWORD`, `MNEMO_LLM_API_KEY` and the rest) are described in
[`docker/README.md`](../../docker/README.md) and `docker/.env.example`.

## HTTPS and the edge proxy

The session cookie, `mnemo_dash_token`, is `HttpOnly`, `Secure`, `SameSite=Lax` and
`Path=/dashboard`, and a session lasts 8 hours. Browsers only store a `Secure` cookie
received over HTTPS: over plain HTTP the sign-in answers success and the next page sends
you back to the sign-in form. Terminate TLS at an edge proxy in front of both containers.

Serve both containers from **one public origin** and route by path:

- `/dashboard` and `/dashboard/*` go to the dashboard container (port 3000; the overlay
  publishes it on `127.0.0.1:3300` only, `MNEMO_DASHBOARD_PORT`, so the proxy runs on the same
  host and is the only way in). That includes
  `/dashboard/auth/*`, `/dashboard/api/*` and `/dashboard/bootstrap*`, which the dashboard
  forwards to the server itself.
- Everything else goes to the server (host port `PORT`, 3939 in `docker/.env.example`, mapped to
  the container's 3000).

The server also answers `GET /dashboard` with its built-in operator page; with this routing
the web dashboard takes that path. One origin is required, not just convenient: the
dashboard's API refuses writes the browser marks as coming from another site with
`403 invalid_origin`, and the cookie is only sent on `/dashboard` paths.

Error responses from the server carry `Content-Language` and `Vary: Accept-Language, Cookie`.
If a CDN caches API responses, keep `Vary` in its cache key.

## Order

1. **Migrations.** `migrate` runs before the server, and Compose waits for it to exit
   successfully. The dashboard has no migrations or tables of its own.
2. **Server, then dashboard.** The overlay starts the dashboard once the server is healthy.
   On an upgrade, deploy the server first: the dashboard calls routes and fields that older
   servers lack, and with an older server those pages show empty states instead of data.

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The base and production files fix the Compose project name (`mnemosyne`), the container names
and the volume names (`mnemosyne-pgdata`, `mnemosyne-ollama-data`) the local development stack
uses, so on a host that also runs the development stack this command takes it over and reuses its
data: deploy on a host without it (or rename the volumes first), and never run `down -v` on a host
whose data matters, because it deletes those volumes.

The server runs one replica by default. Plain `docker compose` publishes every replica on
the host, and a host port serves only one of them, so for more replicas give `PORT` a range
with one port per replica and point the edge proxy at all of them:

```bash
MNEMO_SERVER_REPLICAS=3 PORT=3939-3941 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Under Docker Swarm (`docker stack deploy`), the ingress publishes a single `PORT` for every
replica, so `MNEMO_SERVER_REPLICAS` alone is enough.

## Check it

```bash
curl -fsS https://mnemo.example.com/health/ready
curl -sI https://mnemo.example.com/dashboard/login    # 200
```

`/health/ready` answers `{"status":"ready", … "checks":{"postgres":"ok", … "cache":"ok", …}}`:
`postgres` is the path through pgBouncer, and `cache` is Redis.

After a sign-in, the response sets `mnemo_dash_token` with `Secure` and `Path=/dashboard`.
On a new, empty installation, open `/dashboard/setup` to create the first superadmin; see
[ACCOUNTS.md](ACCOUNTS.md).

## When something is wrong

| Symptom                                                           | Cause                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sign-in answers success, then the sign-in form comes back         | The site is served over plain HTTP, so the browser drops the `Secure` cookie. |
| Sign-in fails with a 404 or a connection error                    | The dashboard image was built with the wrong `MNEMO_SERVER_URL`. Rebuild it.  |
| Nobody can sign in; the server log says `dashboard auth disabled` | `MNEMO_DASHBOARD_SECRET` is not set on the server.                            |
| The server does not start and names `MNEMO_DASHBOARD_SECRET`      | The secret is shorter than 32 bytes.                                          |
| Saving anything answers `403 invalid_origin`                      | The dashboard and the server are served from different origins.               |
| The dashboard image build fails while fetching fonts              | The builder cannot reach `fonts.googleapis.com` or `fonts.gstatic.com`.       |
| Compose stops with `required variable … is missing a value`       | One of the settings the overlay requires is unset.                            |
| `/health/ready` answers `postgres_unavailable`                    | `DATABASE_URL_PROD` or `MNEMO_APP_DB_PASSWORD` does not match the app role.   |
