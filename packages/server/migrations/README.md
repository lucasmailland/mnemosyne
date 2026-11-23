# Server migrations

**There are no server-owned SQL migrations.**

The HTTP server's only schema dependency — the `mnemo_api_keys` table — now
lives in the **core** migration stream at:

    packages/core/migrations/0063_server_api_keys.sql

## Why it moved

The bundled `mnemo-migrate` CLI ships in `@mnemo-ai/core` and discovers a
single migrations directory (core's own). The Docker `migrate` service
deploys only `@mnemo-ai/core`. A migration parked here, under
`packages/server/`, would never be shipped into the migrate image and never
run — so the server's auth table would be missing on first boot and every
authenticated request would 500 on a missing relation.

Keeping every migration in one ordered, core-owned stream means a single
`mnemo-migrate` run provisions the full schema, server included. See the
header of `0063_server_api_keys.sql` for the full rationale.
