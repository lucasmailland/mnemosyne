# Mnemosyne API Stability & Deprecation Policy

**English** · [Español](STABILITY.es.md)

**Effective from:** v1.0.0

---

## Stability Tiers

Every public API surface is assigned a stability tier:

| Tier             | Symbol | Meaning                                                                              |
| ---------------- | ------ | ------------------------------------------------------------------------------------ |
| **Stable**       | ✅     | No breaking changes without a major version bump (semver MAJOR).                     |
| **Beta**         | 🔶     | May have minor breaking changes in minor releases; deprecated with 2-release notice. |
| **Experimental** | 🔸     | May change in any release; no deprecation notice required.                           |

All surfaces listed without a tier annotation are **Stable** as of v1.0.0.

---

## What Is Covered

The following surfaces are subject to this policy:

- **HTTP REST API** — all routes (request shape, response shape, HTTP status codes, auth header names). No `/v1` path prefix on the wire — see `docs/architecture/API.md`'s top-of-file note.
- **MCP tool schemas** — tool names, input parameters, output shapes
- **TypeScript SDK** (`@mnemo-ai/client-ts`) — all exported functions and types
- **Python SDK** (`mnemo-ai-sdk`) — all public methods and exceptions
- **Go SDK** (`github.com/lucasmailland/mnemosyne/packages/sdk-go`) — all exported functions and types
- **CLI commands** (`mnemo`) — command names, flags, and output formats for every shipped command
- **gRPC/ConnectRPC** — `MnemosyneService` proto + generated stubs (method names, message types)
- **Event bus** — `MnemoBusEventType` values and envelope shape
- **Plugin API** — `MnemoPlugin` hook signatures and `PluginContext` methods

The following are **NOT** covered:

- Internal implementation details (adapters, factory internals, migration internals)
- `docs/` — documentation is always updated without a version bump
- Environment variable names (may be renamed with 1-release notice)
- The language and wording of human-readable text: error `message` values, CLI output and MCP tool descriptions may be reworded or translated in any release. Branch on `code`/`type`, not on message text
- Database schema internals (use the SDK/HTTP API; never query Mnemosyne's PG tables directly)

---

## Versioning

Mnemosyne follows [Semantic Versioning 2.0](https://semver.org/):

| Change type                         | Version impact |
| ----------------------------------- | -------------- |
| Bug fix, non-breaking improvement   | PATCH (1.0.x)  |
| New non-breaking capability         | MINOR (1.x.0)  |
| Breaking change to a Stable surface | MAJOR (x.0.0)  |

**Tags are owned by release-please.** Never tag manually. Push to `main`; release-please cuts the release when a `release: true` label is applied to the release PR.

---

## Deprecation Process

1. **Announce**: The deprecating release includes a `deprecation` note in the CHANGELOG and a warning log at runtime (for SDK methods) or a `Deprecation` response header (for HTTP routes).
2. **Grace period**: At least **2 minor releases** (e.g. v1.1.0 and v1.2.0) before removal.
3. **Remove**: The next MAJOR release after the grace period removes the surface.
4. **Exception**: Security vulnerabilities may be removed immediately in a PATCH release without notice.

---

## Breaking Change Definition

A **breaking change** is any change that requires callers to update their code:

- Removing a route, method, parameter, or field that was previously present
- Changing a parameter from optional to required
- Narrowing an accepted input type (e.g. `string | number` → `string`)
- Widening a returned field's type in a way that breaks type narrowing
- Changing HTTP status codes for success responses
- Renaming an MCP tool, CLI command, or gRPC RPC
- Removing a previously exported type or constant

The following are **NOT** breaking changes:

- Adding new optional fields to response objects
- Adding new optional parameters with defaults
- Adding new routes, tools, methods, or commands
- Adding new enum values to response fields (callers should handle unknown values)
- Performance changes, latency improvements, or log message changes
- Bug fixes that change behavior from incorrect to correct

---

## Experimental Surfaces (v1.0)

The following surfaces ship in v1.0 but are marked **Experimental** (may change in 1.x):

- `POST /procedural/optimize` and related procedural memory endpoints (§14)
- `POST /composition/dry-run` — inference dry-run (§32)
- `GET /metacognition` trends sub-field (§31)
- gRPC streaming RPCs: `ingestBatch`, `importMemory`, `session`, `federationSync`
- Plugin API hooks: `onSync`, `onFederationEvent`, `verify` (added in v1.0; stabilizing in v1.1)

---

## Security Policy

Security vulnerabilities are patched in PATCH releases and backported to the current MINOR branch. No advance notice is required for security patches. Report vulnerabilities through a private GitHub security advisory; see [SECURITY.md](../../SECURITY.md).

---

## Contact

For questions about API stability or to request a deprecation exemption, open a GitHub issue with the `api-stability` label.
