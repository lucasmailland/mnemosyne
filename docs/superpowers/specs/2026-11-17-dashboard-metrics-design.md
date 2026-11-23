# Dashboard metrics — design (2026-11-17)

## Intent

Every room of the dashboard shows the numbers behind what it lists: how much, how fast, how it
is changing, what needs attention. The owner wants the dashboard to read as an analytics tool,
not a list viewer, with every figure connected to real server data — no placeholder, no figure
computed from a capped page and presented as a total.

## Goals

- Each room opens with a metrics band (stat tiles with trend) and one or two charts that
  explain the room's data; lists stay below.
- Every number comes from a server aggregate or from a complete fetch. When a figure is computed
  from a capped page, the UI says "of the N shown".
- One chart kit, in the brand: SVG, no chart library, Didot never on numbers (Inter semibold),
  electric blue first, the engraving hatch as the texture channel.

## Non-goals

- New memory features (create, edit, forget). This project is read-side analytics only.
- Real-time streaming. Data refreshes on navigation and on a manual "refresh".

## Anti-goals (a failure even if it works)

- A chart with no tooltip or no table view.
- Two y-axes, rainbow palettes, a number on every point.
- A metric whose definition the reader can't find (every tile has a one-line "what this counts").
- A figure that changes meaning with the workspace size (caps, silent windows).

## Chart kit (`packages/dashboard/components/charts/`)

| Piece          | Use                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StatTile`     | label · value (Inter semibold, compact) · optional delta vs the previous period · optional 14-point sparkline · one-line definition in a tooltip |
| `Sparkline`    | single series inside a tile                                                                                                                      |
| `TimeSeries`   | columns (counts per day) or area (rates, latency) with a date axis, crosshair + tooltip, today marked, hidden table                              |
| `BarList`      | ranked horizontal bars (top-N) with the value at the tip, each row a link                                                                        |
| `SegmentedBar` | one whole split into parts (kinds, sensitivity, roles) with legend and shares                                                                    |
| `Meter`        | a ratio against a target (hit rate, embeddings indexed, quota used)                                                                              |
| `ChartCard`    | title, period, definition, "view as table" toggle, empty and error states                                                                        |

Rules (from the dataviz method): bars ≤ 24 px with 4 px rounded data-end, 2 px lines, 2 px
surface gaps, hairline solid grid, legend for ≥ 2 series, text in text tokens, hover and
keyboard focus give the same readout, every chart has a table view.

Palette (validated with the dataviz validator, all checks pass, CVD-safe):

| Slot | Light (on `#fffefc`) | Dark (on `#131234`) |
| ---- | -------------------- | ------------------- |
| 1    | `#1a18f0` electric   | `#7b79f5`           |
| 2    | `#d95f1e`            | `#e06a2c`           |
| 3    | `#1a9e6e`            | `#22a874`           |
| 4    | `#b98900`            | `#c08a00`           |
| 5    | `#c2417a`            | `#dc5f93`           |

Ordinal data (sensitivity public → restricted) uses one electric ramp. Status colors stay the
existing green/yellow/red tokens and always carry a label.

## Metrics by room

S = exists on the server and the bridge · M = exists on the server, needs a bridge mount ·
N = new server aggregate.

| Room                          | Band (tiles)                                                                                                                      | Charts                                                                                                                | Sources                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Home                          | memories live (+14d sparkline), recall hit rate 30d, latency p50/p95 7d, never recalled share, open conflicts, embeddings indexed | writes per day 14d; recalls per day 30d; memory by kind; plan usage (recall/write vs limit)                           | S `/admin/stats`; M `/usage`, `/health/cognitive`; N `/recall/metrics`, `/facts/stats` |
| Explorer                      | facts / decisions / entities totals, pinned, never recalled                                                                       | facts by kind and by sensitivity (segmented); top recalled (bar list); entities by kind; created per week             | S `/facts?sortBy=hit_count`, `/entities`, `/decisions`; N `/facts/stats`               |
| Recall                        | queries 30d, hit rate, p50/p95, zero-hit share                                                                                    | latency per day (area), queries per day (columns), top recalled facts; per query: score distribution and hits by kind | S `/recall/explain`; N `/recall/metrics`                                               |
| Sessions                      | sessions 30d, collapse rate, avg turns, facts per session                                                                         | sessions per day by status; outcome mix; top topics                                                                   | S `/episodes`; M `/session/list`; N `/sessions/stats`                                  |
| Graph                         | entities, relations, conflicts, isolated nodes                                                                                    | relations by type; top hubs by degree; confidence distribution                                                        | S `/graph`, `/conflicts`; N `/graph/stats`                                             |
| Config                        | mode, graduation progress (sessions/facts/entities vs thresholds), retention windows                                              | facts by sensitivity against retention; embedding coverage                                                            | S `/workspace-mode`, `/admin/config/retention`, `/admin/stats`                         |
| My workspaces                 | workspaces, owned vs limit                                                                                                        | per workspace: live memories and last write                                                                           | S `/my-workspaces`; N enrich with `factsLive`, `lastWriteAt`, `memberCount`            |
| Members                       | members by role, pending invitations, expiring invitations                                                                        | joined over time; last activity per member                                                                            | S `/workspace/members`; N last activity from the audit log                             |
| Keys                          | active keys, idle 30d, expiring 30d, in sunset                                                                                    | keys by scope set and by ceiling; last use timeline                                                                   | S `/admin/keys`                                                                        |
| Health                        | checks ok/warn/fail, embeddings indexed, snapshot age, uptime                                                                     | health over 30 days (hit rate, zero-hit share, failed jobs); uptime history                                           | S `/doctor`, `/health`; M `/health/history`; N `/health/snapshots`                     |
| Audit                         | entries in range, by actor kind                                                                                                   | entries per day by action                                                                                             | N `/audit/stats`                                                                       |
| Account                       | role, scopes, personal memories                                                                                                   | own activity per day                                                                                                  | S `/me`; N own audit activity                                                          |
| Installation › Users          | users, active 7d/30d, disabled, never signed in                                                                                   | sign-ups per week; last sign-in recency                                                                               | S `/instance/users`                                                                    |
| Installation › Workspaces     | workspaces, personal vs team, by visibility                                                                                       | members per workspace; dormant workspaces                                                                             | S `/instance/workspaces`; N facts/last write per workspace                             |
| Installation › Security audit | events in range, failed sign-ins 7d                                                                                               | events per day by action                                                                                              | N `/instance/audit/stats`                                                              |

## Server work

1. Bridge mounts (GET only, workspace-scoped, same guards as their `/v1` routes): `/usage`,
   `/health/cognitive`, `/health/history`, `/metacognition`, `/session/list`. Fix `/cost` (500 on
   the demo) before it is used anywhere.
2. New aggregates, each one SQL GROUP BY over an existing table, bounded windows, the sensitivity
   ceiling applied where rows are counted, OpenAPI + en/es docs + a Postgres integration test:
   `/recall/metrics?days=`, `/facts/stats`, `/sessions/stats`, `/graph/stats`, `/audit/stats`,
   `/health/snapshots?days=`, `/instance/audit/stats`, and the enrich of `/my-workspaces` and
   `/instance/workspaces`.
3. The bridge contract test already pins every dashboard call to a mounted route.

## Order

Chart kit + Home first (shown live and approved), then one room at a time in the order of the
sidebar. Each room: server aggregate (if any) → bridge → room UI → unit + e2e (a11y, layout
gates at the five widths, en/es, light/dark) → shown live.

## Left to the builder

Exact tile wording per room (in the dictionaries, en + es-419 with "tú"), chart sizing per
breakpoint, and the empty-state copy for workspaces with no data yet.
