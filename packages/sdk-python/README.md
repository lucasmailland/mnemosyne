# mnemo-ai-sdk (Python)

**English** · [Español](README.es.md)

> **AI pointer:** Sync and async Python HTTP client for the Mnemosyne cognitive memory API. Both clients (`MnemosyneClient` / `AsyncMnemosyneClient`) speak the same JSON wire format as `@mnemo-ai/server` over plain HTTPS.
>
> **Depends on:** httpx >=0.27
>
> **Exposes:** `MnemosyneClient`, `AsyncMnemosyneClient`, error classes
>
> **Status:** ALPHA — version 0.1.0
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.md](../client-ts/README.md)

Python SDK for the Mnemosyne v3 cognitive memory server. Two clients share the same method surface: `MnemosyneClient` (synchronous, backed by `httpx.Client`) and `AsyncMnemosyneClient` (async, backed by `httpx.AsyncClient`). Requires Python ≥ 3.9.

## Install

The package is named `mnemo-ai-sdk` and is **not published to PyPI yet** (`mnemosyne-sdk` on PyPI
belongs to an unrelated project: do not install it). Install it from the repository, or from a
checkout with `pip install ./packages/sdk-python`:

```bash
# Not on PyPI yet: install from the repository
pip install "git+https://github.com/lucasmailland/mnemosyne.git#subdirectory=packages/sdk-python"
```

**Development / editable install:**

```bash
# with uv
uv pip install -e ".[dev]"

# with pip
pip install -e ".[dev]"
```

The `dev` extra pulls in `pytest`, `pytest-asyncio`, and `respx` for running the test suite.

## 30-second start

```python
from mnemo import MnemosyneClient

client = MnemosyneClient(
    url="https://memory.example.com",
    api_key="mns_live_...",
)

result = client.recall(query="user email preferences")
for hit in result["hits"]:
    print(hit["score"], hit["content"])
```

Async variant (identical method names — just `await`):

```python
import asyncio
from mnemo import AsyncMnemosyneClient

async def main() -> None:
    async with AsyncMnemosyneClient(
        url="https://memory.example.com",
        api_key="mns_live_...",
    ) as client:
        result = await client.recall(query="user email preferences")
        for hit in result["hits"]:
            print(hit["score"], hit["content"])

asyncio.run(main())
```

## Configuration

Both classes share the same constructor signature:

```python
MnemosyneClient(
    url: str,               # Required. Server base URL (trailing slash stripped).
    api_key: str,           # Required. Bearer token sent as Authorization header.
    timeout: float = 30.0,  # Per-request timeout in seconds.
    user_agent_suffix: str | None = None,  # Appended to User-Agent header.
    max_retries: int = 3,   # Extra attempts on 429/500/502/503/504.
)
```

`AsyncMnemosyneClient` takes the same parameters. Retry backoff is full-jitter exponential (base delays 200 ms / 400 ms / 800 ms). 4xx errors (except 429) are never retried.

**Context-manager usage** closes the underlying connection pool:

```python
# Sync
with MnemosyneClient(url=..., api_key=...) as client:
    client.health()

# Async
async with AsyncMnemosyneClient(url=..., api_key=...) as client:
    await client.health()
```

Or call `client.close()` / `await client.aclose()` explicitly.

## API

All methods return plain `dict` values matching the server's JSON wire shape. Methods that return `None` correspond to `204 No Content` responses.

### Recall

| Method                                                                      | HTTP           | Description              |
| --------------------------------------------------------------------------- | -------------- | ------------------------ |
| `recall(query, *, vector=None, top_k=None, as_of=None, vector_weight=None)` | `POST /recall` | Top-K blended-score hits |

### Facts

| Method                                                                       | HTTP                       | Description                         |
| ---------------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| `create_fact(content, *, attribution=None, tags=None, idempotency_key=None)` | `POST /remember`           | Persist a fact (idempotent via key) |
| `get_fact(fact_id)`                                                          | `GET /facts/:id`           | Fetch one fact                      |
| `list_facts(**params)`                                                       | `GET /facts`               | Keyset-paginated list               |
| `patch_fact(fact_id, **fields)`                                              | `PATCH /facts/:id`         | Partial update                      |
| `forget_fact(fact_id, idempotency_key=None)`                                 | `DELETE /facts/:id`        | Soft-delete (bitemporal close)      |
| `restore_fact(fact_id)`                                                      | `POST /facts/:id/restore`  | Un-delete                           |
| `pin_fact(fact_id, idempotency_key=None)`                                    | `POST /facts/:id/pin`      | Pin (boost + protect from prune)    |
| `unpin_fact(fact_id, idempotency_key=None)`                                  | `POST /facts/:id/pin`      | Unpin                               |
| `get_fact_citations(fact_id)`                                                | `GET /facts/:id/citations` | Fetch citations for a fact          |

### Timeline / Graph / Health / Export

| Method                                | HTTP            |
| ------------------------------------- | --------------- |
| `timeline(*, limit=None, since=None)` | `GET /timeline` |
| `graph(*, focus=None)`                | `GET /graph`    |
| `health()`                            | `GET /health`   |
| `export_workspace()`                  | `GET /export`   |
| `audit(*, limit=None)`                | `GET /audit`    |

### Entities

`list_entities(*, kind=None, q=None, limit=None)` · `get_entity(id)` · `create_entity(name, kind, *, aliases=None, description=None, metadata=None, idempotency_key=None)` · `update_entity(id, **fields)` · `list_entity_facts(id, *, limit=None)`

### Sessions

`create_session(**fields)` · `collapse_session(session_id, **fields)` · `add_turn(session_id, role, content, *, metadata=None) → None` · `pin_session_turn(session_id, turn_id, pinned) → None`

### Tasks / Events / Reasoning / Strategies

Each group follows the pattern `list_X(**params)` · `create_X(**fields)` · `get_X(id)` · `patch_X(id, **fields)` · `archive_X(id) → None`.

### Additional surfaces

`list_episodes` · `get_episode` · `list_decisions` · `get_decision` · `create_decision` · `supersede_decision` · `list_relations` · `create_relation` · `patch_relation` · `list_citations` · `list_review` · `review_count` · `enqueue_review` · `resolve_review` · `create_reminder` · `list_reminders` · `dismiss_reminder` · `list_hyperedges` · `create_hyperedge` · `get_hyperedge` · `patch_hyperedge` · `archive_hyperedge` · `trigger_consolidation` · `get_self_model` · `get_anticipation_feed` · `list_composition_rules` · `create_composition_rule` · `get_composition_rule` · `patch_composition_rule` · `dry_run_composition` · `self_edit` · `self_reflect` · `get_self_profile` · `list_federation_peers` · `list_pending_federation_peers` · `approve_federation_peer` · `delete_federation_peer` · `list_federation_items` · `trigger_federation_sync` · `get_federation_sync_job` · `resolve_federation_conflict`

## Error handling

Import error classes from the top-level `mnemo` package and branch on the class — not the message string.

```python
from mnemo import MnemosyneClient, MnemosyneAPIError, MnemosyneNetworkError

client = MnemosyneClient(url="https://memory.example.com", api_key="mns_live_...")

try:
    result = client.recall(query="billing policy")
except MnemosyneAPIError as err:
    # err.status   — HTTP status code (int)
    # err.message  — human-readable message
    # err.code     — machine-readable error code string (may be None)
    # err.request_id — x-request-id from the response (may be None)
    if err.status == 401:
        print("Rotate API key")
    else:
        raise
except MnemosyneNetworkError as err:
    # DNS / TLS / connection refused — httpx.TransportError wrapped
    print(f"Network failure: {err}")
```

Both `MnemosyneAPIError` and `MnemosyneNetworkError` inherit from `MnemosyneError` (the base class), so you can catch all SDK errors with a single `except MnemosyneError`.

## Idempotency

Mutating methods that accept `idempotency_key` forward it as the `Idempotency-Key` HTTP header. Generate one key before the first attempt and reuse it across retries:

```python
import uuid

key = str(uuid.uuid4())
fact = client.create_fact(
    "Acme prefers communication in Spanish.",
    idempotency_key=key,
)
```

## Running tests

```bash
pytest
```

Tests use `respx` to mock the httpx transport — no live server required.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
