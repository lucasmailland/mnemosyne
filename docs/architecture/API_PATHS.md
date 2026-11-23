# ADR — API Path Scheme (§4 reconciliation)

**English** · [Español](API_PATHS.es.md)

**Date:** 2026-06-18 · **Status:** SUPERSEDED (see notice below) · **Supersedes:** the aspirational
`Base: /v1/memory` path list in `MEMORY_IMPROVEMENT.md` §4 (pre-implementation).

> **⚠️ SUPERSEDED 2026-07-31.** Everything below this notice describes the
> `/v1/*` vs `/v1/memory/*` split as it stood on 2026-06-18. Commit `6fa7820f`
> ("refactor: remove all v1/v2/v3 version labels from codebase", 2026-06-25)
> stripped the `/v1` path prefix from every HTTP route entirely — the `v1`
> router now mounts at the app root (`app.route("/", v1)` in
> `packages/server/src/app.ts`), not under `/v1`. The Addendum's "shipped"
> `app.all("/v1/memory/*")` prefix-rewrite proxy no longer exists either (it
> was removed even earlier, in commit `6149dc00`, for being backwards) —
> there is no `/v1/memory/*` ↔ `/v1/*` alias of any kind today. The only
> routes that genuinely keep a `/memory/` segment are federation
> (`/memory/federation/*`) and the WS replay catch-up endpoint
> (`/memory/events`) — `remember`/`recall`/`search`/entity-CRUD are all bare
> root paths (`/remember`, `/recall`, `/facts`, `/decisions`, …). The
> "ambiguous by-id route" problem this ADR describes is moot: no generic
> `/memory/{id}` route exists in the current codebase.
>
> **Current source of truth:** `docs/architecture/API.md` (its top-of-file
> note has the authoritative, actively-maintained path-prefix statement).
> This file is kept as the historical record of the 2026-06-18 decision and
> its stated rationale — do not treat anything below as describing the live
> API.

## Context

§4 of the master spec lists every endpoint under `Base: /v1/memory` (e.g.
`/v1/memory/facts`, `/v1/memory/decisions`, …). The implemented API diverges:

- **Core memory operations ARE under `/v1/memory/*`** — `remember`, `recall`,
  `search`, get/update/delete by id (`/v1/memory/{id}`), `events`, and the whole
  `/v1/memory/federation/*` surface.
- **Entity CRUD + admin are under `/v1/*`** — `/v1/facts`, `/v1/decisions`,
  `/v1/tasks`, `/v1/events`, `/v1/entities`, `/v1/relations`, `/v1/episodes`,
  `/v1/reasoning`, `/v1/composition`, `/v1/approvals`, `/v1/usage`, …

The CLI, the three SDKs (`client-ts`, `sdk-go`, `sdk-python`), and existing agents
are all coded to this scheme and run against it in CI.

## Why a blanket `/v1/memory/*` alias is unsafe

The implemented surface includes a **generic by-id route `/v1/memory/{id}`**
(get/update/delete a memory item by id). That makes any single-segment
`/v1/memory/<x>` ambiguous: `GET /v1/memory/facts` matches the param route with
`id = "facts"` and dispatches to the by-id handler, not a "list facts" handler.
A second mount of the entity routers under `/v1/memory` therefore collides with
this route (verified: such a mount returns the by-id handler / 500 for
`/v1/memory/facts`). Resolving it cleanly would require **renaming the generic
route to `/v1/memory/items/{id}`** — a breaking change for every client already
calling `/v1/memory/{id}`.

## Decision

1. **Keep the current, sound scheme** — `/v1/memory/*` for the primary memory
   operations + by-id + federation; `/v1/*` for entity CRUD/admin. It is
   unambiguous, already shipped, and what all first-party clients use.
2. **Reconcile the spec to reality** (this ADR) rather than break a working API to
   match a pre-implementation doc. Breaking client contracts for doc-conformance,
   with no user benefit, is the opposite of professional.
3. **Defer a uniform re-base** to a future **major version**: if full
   `/v1/memory/<entity>` uniformity is wanted, it ships behind a major with the
   generic route renamed to `/v1/memory/items/{id}`, the entity routers mounted
   under `/v1/memory`, `/v1/*` kept as a `Deprecation`/`Sunset`-headed alias for a
   transition window, and the OpenAPI doc + SDKs + CLI regenerated. No flag-day.

## Consequences

- Spec-coded OpenAPI clients targeting `/v1/memory/<entity>` for entity CRUD must
  use `/v1/<entity>` until the (optional) major re-base. This is documented here
  and in the OpenAPI served at `/v1/openapi.json` (the source of truth for clients).
- The §4 "100%" item is considered **reconciled**: the mandated `/v1/memory` base
  is honored for the primary memory surface; the entity-CRUD prefix is a recorded,
  rationalized divergence, not a silent gap.

---

## Addendum — `/v1/memory/*` prefix-rewrite proxy (shipped)

**Status: implemented** (`packages/server/src/app.ts`, line 386)

A **prefix-rewrite proxy** for `app.all("/v1/memory/*")` is live. It strips the
`/v1/memory` prefix and re-dispatches the request into the same Hono app as
`/v1<sub-path>`. This is not a second router mount (which would collide with the
generic `/v1/memory/{id}` route), but a path-rewrite that calls `app.fetch()` with
the rewritten URL, bypassing the collision entirely.

Effect: `POST /v1/memory/facts` transparently reaches the same handler as
`POST /v1/facts`. All entity-CRUD operations are therefore reachable via either
prefix. The canonical prefix remains `/v1/<entity>` (used by SDKs, CLI, and
OpenAPI spec); `/v1/memory/<entity>` is a convenience alias for spec-conformant
clients.
