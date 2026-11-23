# Dashboard deploy notes

**English** · [Español](DASHBOARD_DEPLOY.es.md)

## Dashboard redesign — server changes (phase 2)

Everything below is additive: no field is renamed, removed or retyped. Default responses are unchanged except `GET /timeline`, which now also lists decision events.

- **No migrations.** No new tables, columns or runtime dependencies. Deploy the server, then the dashboard.
- **`GET /admin/stats` is readable with `memory:read`.** Callers without `memory:admin` get a trimmed body: `facts.withZeroHits`, `facts.byScopeRef`, `embeddings`, `snapshot` and `recall.precision*` are omitted (not `null`, not a 403). Admin callers get the full body.
- **New stats fields:** `recall.latencyP50Ms7d` / `recall.latencyP95Ms7d` (null with no samples) and `writesPerDay14d` (14 zero-filled UTC days, oldest first, counting `mnemo_fact.created_at`). The latency percentiles are per served memory, not per request (the recall log has one row per memory served), and recalls that served nothing are not counted.
- **Recall:** optional request flag `debug: true` adds `debug.trace`, a list of `{ name, candidatesIn, candidatesOut, ms }` stages. `ms` is the time since the previous stage in execution order, only the answering level's trace is returned under multi-level recall, and a tier miss reports 0 candidates. Stages before `eligibility` report `null` counts unless the caller's effective ceiling admits every sensitivity tier (`memory:admin` and `MNEMO_SENSITIVITY_CEILING=restricted`); for everyone else `eligibility` reports only what passed the ceiling. Without the flag no trace and no timing work.
- **Fact detail:** `GET /facts/{id}` accepts `includeClosed=true` (closed facts stop returning 404) and `provenance=true`, which adds `sessionId`, `supersededById`, `supersededAt` and `supersedesIds`. A successor or source episode above the caller's sensitivity ceiling reads as `null` (`supersededById`, `sessionId`), exactly like none; superseded facts above it are left out of `supersedesIds`.
- **Timeline:** new event kinds `decision_created`, `decision_superseded`, `decision_withdrawn` with an optional `decisionId` (`factId` is absent on those events). Old cursors keep working.
- **Dashboard bridge:** the session-cookie bridge now also mounts the conflicts routes (list and resolve) and recall explain, hot and unified, with the same scope rules and CSRF protection as the other bridge mutations.

Paths in this document are bare, without any version prefix, like every route in the API reference.
