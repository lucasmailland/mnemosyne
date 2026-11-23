# mnemo-ai-sdk (Python)

[English](README.md) · **Español**

> **Puntero para IA:** cliente HTTP de Python, síncrono y asíncrono, para la API de memoria cognitiva de Mnemosyne. Ambos clientes (`MnemosyneClient` / `AsyncMnemosyneClient`) hablan el mismo formato JSON que `@mnemo-ai/server` sobre HTTPS simple.
>
> **Depende de:** httpx >=0.27
>
> **Expone:** `MnemosyneClient`, `AsyncMnemosyneClient`, clases de error
>
> **Estado:** ALPHA — versión 3.0.0a0
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.md](../client-ts/README.es.md)

SDK de Python para el servidor de memoria cognitiva Mnemosyne v3. Dos clientes comparten la misma superficie de métodos: `MnemosyneClient` (síncrono, basado en `httpx.Client`) y `AsyncMnemosyneClient` (asíncrono, basado en `httpx.AsyncClient`). Requiere Python ≥ 3.9.

## Instalación

El paquete se llama `mnemo-ai-sdk` y **todavía no está publicado en PyPI** (`mnemosyne-sdk` en
PyPI es de otro proyecto: no lo instales). Instálalo desde el repositorio, o desde una copia local
con `pip install ./packages/sdk-python`:

```bash
# Not on PyPI yet: install from the repository
pip install "git+https://github.com/lucasmailland/mnemosyne.git#subdirectory=packages/sdk-python"
```

**Desarrollo / instalación editable:**

```bash
# with uv
uv pip install -e ".[dev]"

# with pip
pip install -e ".[dev]"
```

El extra `dev` instala `pytest`, `pytest-asyncio` y `respx` para ejecutar la suite de pruebas.

## Empieza en 30 segundos

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

Variante asíncrona (mismos nombres de método; solo añade `await`):

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

## Configuración

Ambas clases comparten la misma firma de constructor:

```python
MnemosyneClient(
    url: str,               # Required. Server base URL (trailing slash stripped).
    api_key: str,           # Required. Bearer token sent as Authorization header.
    timeout: float = 30.0,  # Per-request timeout in seconds.
    user_agent_suffix: str | None = None,  # Appended to User-Agent header.
    max_retries: int = 3,   # Extra attempts on 429/500/502/503/504.
)
```

`AsyncMnemosyneClient` recibe los mismos parámetros. La espera entre reintentos es exponencial con variación completa (retardos base de 200 ms / 400 ms / 800 ms). Los errores 4xx (salvo 429) nunca se reintentan.

**El uso como gestor de contexto** cierra el pool de conexiones subyacente:

```python
# Sync
with MnemosyneClient(url=..., api_key=...) as client:
    client.health()

# Async
async with AsyncMnemosyneClient(url=..., api_key=...) as client:
    await client.health()
```

O llama explícitamente a `client.close()` / `await client.aclose()`.

## API

Todos los métodos devuelven valores `dict` simples que coinciden con la forma JSON del servidor. Los métodos que devuelven `None` corresponden a respuestas `204 No Content`.

### Recuperación (Recall)

| Método                                                                      | HTTP           | Descripción                                       |
| --------------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| `recall(query, *, vector=None, top_k=None, as_of=None, vector_weight=None)` | `POST /recall` | Los K mejores resultados por puntuación combinada |

### Hechos

| Método                                                                       | HTTP                       | Descripción                                       |
| ---------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------- |
| `create_fact(content, *, attribution=None, tags=None, idempotency_key=None)` | `POST /remember`           | Persiste un hecho (idempotente mediante la clave) |
| `get_fact(fact_id)`                                                          | `GET /facts/:id`           | Obtiene un hecho                                  |
| `list_facts(**params)`                                                       | `GET /facts`               | Lista paginada por keyset                         |
| `patch_fact(fact_id, **fields)`                                              | `PATCH /facts/:id`         | Actualización parcial                             |
| `forget_fact(fact_id, idempotency_key=None)`                                 | `DELETE /facts/:id`        | Borrado lógico (cierre bitemporal)                |
| `restore_fact(fact_id)`                                                      | `POST /facts/:id/restore`  | Deshace el borrado                                |
| `pin_fact(fact_id, idempotency_key=None)`                                    | `POST /facts/:id/pin`      | Fija (da más peso y protege de la poda)           |
| `unpin_fact(fact_id, idempotency_key=None)`                                  | `POST /facts/:id/pin`      | Desfija                                           |
| `get_fact_citations(fact_id)`                                                | `GET /facts/:id/citations` | Obtiene las citas de un hecho                     |

### Línea de tiempo / Grafo / Salud / Exportación

| Método                                | HTTP            |
| ------------------------------------- | --------------- |
| `timeline(*, limit=None, since=None)` | `GET /timeline` |
| `graph(*, focus=None)`                | `GET /graph`    |
| `health()`                            | `GET /health`   |
| `export_workspace()`                  | `GET /export`   |
| `audit(*, limit=None)`                | `GET /audit`    |

### Entidades

`list_entities(*, kind=None, q=None, limit=None)` · `get_entity(id)` · `create_entity(name, kind, *, aliases=None, description=None, metadata=None, idempotency_key=None)` · `update_entity(id, **fields)` · `list_entity_facts(id, *, limit=None)`

### Sesiones

`create_session(**fields)` · `collapse_session(session_id, **fields)` · `add_turn(session_id, role, content, *, metadata=None) → None` · `pin_session_turn(session_id, turn_id, pinned) → None`

### Tareas / Eventos / Razonamiento / Estrategias

Cada grupo sigue el patrón `list_X(**params)` · `create_X(**fields)` · `get_X(id)` · `patch_X(id, **fields)` · `archive_X(id) → None`.

### Superficies adicionales

`list_episodes` · `get_episode` · `list_decisions` · `get_decision` · `create_decision` · `supersede_decision` · `list_relations` · `create_relation` · `patch_relation` · `list_citations` · `list_review` · `review_count` · `enqueue_review` · `resolve_review` · `create_reminder` · `list_reminders` · `dismiss_reminder` · `list_hyperedges` · `create_hyperedge` · `get_hyperedge` · `patch_hyperedge` · `archive_hyperedge` · `trigger_consolidation` · `get_self_model` · `get_anticipation_feed` · `list_composition_rules` · `create_composition_rule` · `get_composition_rule` · `patch_composition_rule` · `dry_run_composition` · `self_edit` · `self_reflect` · `get_self_profile` · `list_federation_peers` · `list_pending_federation_peers` · `approve_federation_peer` · `delete_federation_peer` · `list_federation_items` · `trigger_federation_sync` · `get_federation_sync_job` · `resolve_federation_conflict`

## Gestión de errores

Importa las clases de error desde el paquete de nivel superior `mnemo` y ramifica según la clase, no según el texto del mensaje.

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

Tanto `MnemosyneAPIError` como `MnemosyneNetworkError` heredan de `MnemosyneError` (la clase base), así que puedes capturar todos los errores del SDK con un único `except MnemosyneError`.

## Idempotencia

Los métodos de escritura que aceptan `idempotency_key` la reenvían como la cabecera HTTP `Idempotency-Key`. Genera una clave antes del primer intento y reutilízala en los reintentos:

```python
import uuid

key = str(uuid.uuid4())
fact = client.create_fact(
    "Acme prefers communication in Spanish.",
    idempotency_key=key,
)
```

## Ejecutar las pruebas

```bash
pytest
```

Las pruebas usan `respx` para simular el transporte de httpx: no hace falta un servidor real.

## Licencia

Apache-2.0 — consulta [LICENSE](../../LICENSE).
