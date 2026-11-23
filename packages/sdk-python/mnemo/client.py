"""
Mnemosyne Python SDK — sync and async HTTP clients.

Python 3.9-compatible: uses Union/Optional instead of X | Y syntax.
Both clients expose the same method surface; ``AsyncMnemosyneClient``
returns coroutines that must be awaited.

Example (sync)::

    from mnemo import MnemosyneClient

    client = MnemosyneClient(url="https://memory.example.com", api_key="mns_live_…")
    result = client.recall(query="user email preferences")
    for hit in result["hits"]:
        print(hit["content"])

Example (async)::

    from mnemo import AsyncMnemosyneClient

    client = AsyncMnemosyneClient(url="https://memory.example.com", api_key="mns_live_…")
    result = await client.recall(query="user email preferences")
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

import httpx

from .types import MnemosyneAPIError, MnemosyneNetworkError, MnemosyneResponseError, MnemosyneTimeoutError

_DEFAULT_TIMEOUT = 30.0
_SDK_USER_AGENT = "mnemosyne-sdk-python/0.1.0"


def _build_headers(api_key: str, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    headers: Dict[str, str] = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": _SDK_USER_AGENT,
        "Accept": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def _parse_error(response: httpx.Response) -> MnemosyneAPIError:
    status = response.status_code
    request_id: Optional[str] = response.headers.get("x-request-id")
    message = f"HTTP {status}"
    code: Optional[str] = None
    body: Any = None
    details: Any = None
    retryable: Optional[bool] = None
    retry_after_seconds: Optional[float] = None
    try:
        body = response.json()
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            err = body["error"]
            if isinstance(err.get("message"), str):
                message = err["message"]
            if isinstance(err.get("code"), str):
                code = err["code"]
            if isinstance(err.get("request_id"), str):
                request_id = err["request_id"]
            details = err.get("details") or ({"issues": err["issues"]} if isinstance(err.get("issues"), list) else None)
            if isinstance(err.get("retryable"), bool):
                retryable = err["retryable"]
            if isinstance(err.get("retryAfterSeconds"), (int, float)):
                retry_after_seconds = float(err["retryAfterSeconds"])
        if isinstance(body, dict) and isinstance(body.get("requestId"), str):
            request_id = body["requestId"]
    except Exception:
        text = response.text
        if text:
            message = text[:500]
    header_delay = _retry_after_seconds(response.headers.get("retry-after"))
    if header_delay is not None:
        retry_after_seconds = header_delay
    return MnemosyneAPIError(
        status=status,
        message=message,
        code=code,
        request_id=request_id,
        body=body,
        details=details,
        retryable=retryable,
        retry_after_seconds=retry_after_seconds,
    )


def _retry_after_seconds(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        from datetime import datetime, timezone
        from email.utils import parsedate_to_datetime
        try:
            return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def _read_only(method: str, path: str) -> bool:
    """Reads leave nothing uncertain after a failure; mutations do, keyed or not."""
    return method == "GET" or (method == "POST" and path == "/recall")


def _replay_safe(method: str, path: str, keyed: bool = False) -> bool:
    # A mutation carrying an Idempotency-Key is safe to replay: the server dedups it.
    return keyed or method == "GET" or (method == "POST" and path == "/recall")


class MnemosyneClient:
    """
    Synchronous Mnemosyne HTTP client.

    All methods return plain dicts/lists matching the server's JSON wire shape.
    Raises ``MnemosyneAPIError`` for non-2xx responses and
    ``MnemosyneNetworkError`` for transport failures.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        timeout: float = _DEFAULT_TIMEOUT,
        user_agent_suffix: Optional[str] = None,
        max_retries: int = 3,
        workspace_id: Optional[str] = None,
    ) -> None:
        if not url:
            raise ValueError("MnemosyneClient: `url` is required")
        if not api_key:
            raise ValueError("MnemosyneClient: `api_key` is required")
        self._base_url = url.rstrip("/")
        self._api_key = api_key
        self._user_agent_suffix = user_agent_suffix
        ua = _SDK_USER_AGENT
        if user_agent_suffix:
            ua = f"{ua} ({user_agent_suffix})"
        self._headers = _build_headers(api_key, {"User-Agent": ua})
        if workspace_id:
            self._headers["X-Workspace-Id"] = workspace_id
        self._timeout = timeout
        self._max_retries = max_retries
        self._http = httpx.Client(
            base_url=self._base_url,
            headers=self._headers,
            timeout=self._timeout,
        )

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()

    def for_workspace(self, workspace_id: str) -> "MnemosyneClient":
        return MnemosyneClient(self._base_url, self._api_key, self._timeout, self._user_agent_suffix, self._max_retries, workspace_id=workspace_id)

    def __enter__(self) -> "MnemosyneClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    # ── Internal ─────────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        import random
        import time

        extra_headers: Dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key
        # Strip None values from params.
        clean_params: Optional[Dict[str, Any]] = None
        if params:
            clean_params = {k: v for k, v in params.items() if v is not None}
            if not clean_params:
                clean_params = None

        _RETRYABLE = {429, 500, 502, 503, 504}
        last_err: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                # Full-jitter exponential backoff: 200ms, 400ms, 800ms base
                delay = last_err.retry_after_seconds if isinstance(last_err, MnemosyneAPIError) and last_err.retry_after_seconds is not None else (0.2 * (2 ** (attempt - 1))) * random.random()
                time.sleep(delay)
            try:
                response = self._http.request(
                    method,
                    path,
                    params=clean_params,
                    json=json,
                    headers=extra_headers or None,
                )
            except httpx.TimeoutException as exc:
                error = MnemosyneTimeoutError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            except httpx.ConnectError as exc:
                if _replay_safe(method, path, bool(idempotency_key)) and attempt < self._max_retries:
                    last_err = MnemosyneNetworkError(str(exc))
                    continue
                error = MnemosyneNetworkError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            except httpx.TransportError as exc:
                error = MnemosyneNetworkError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            if not response.is_success:
                err = _parse_error(response)
                err.outcome_unknown = not _read_only(method, path) and err.status >= 500
                if not _replay_safe(method, path, bool(idempotency_key)) or err.retryable is False or err.status not in _RETRYABLE or attempt >= self._max_retries:
                    raise err
                last_err = err
                continue
            if response.status_code == 204:
                return None
            try:
                return response.json()
            except ValueError as exc:
                bad = MnemosyneResponseError(f"malformed JSON in successful response: {exc}")
                bad.outcome_unknown = not _read_only(method, path)
                raise bad from exc
        # Should be unreachable; last_err is set when we exit the loop via continue
        if last_err:
            raise last_err
        raise RuntimeError("unreachable")

    # ── Recall ───────────────────────────────────────────────────────────────

    def recall(
        self,
        query: str,
        *,
        vector: Optional[List[float]] = None,
        top_k: Optional[int] = None,
        as_of: Optional[str] = None,
        vector_weight: Optional[float] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /recall — return top-K hits ranked by blended score.

        ``as_of`` (ISO 8601, not in the future) ranks what memory held at that
        instant, including facts superseded since.
        """
        body: Dict[str, Any] = {"query": query}
        if session_id is not None:
            body["sessionId"] = session_id
        if vector is not None:
            body["vector"] = vector
        if top_k is not None:
            body["topK"] = top_k
        if as_of is not None:
            body["asOf"] = as_of
        if vector_weight is not None:
            body["vectorWeight"] = vector_weight
        return self._request("POST", "/recall", json=body)

    # ── Facts ────────────────────────────────────────────────────────────────

    def create_fact(
        self,
        content: str,
        *,
        attribution: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /remember

        POST /facts was deleted server-side (flatten-legacy-dual-core D2 step
        2). This is a lossless body remap (/remember already accepts tags +
        attribution): {content, attribution, tags} -> {statement,
        attribution, tags}. The response's "statement" is also mirrored back
        onto "content" so an existing caller reading result["content"] keeps
        working, alongside the raw "statement"/"conflict" fields /remember
        returns — this method's name and signature stay the same, only the
        wire route changed.
        """
        body: Dict[str, Any] = {"statement": content}
        if session_id is not None:
            body["sessionId"] = session_id
        if attribution is not None:
            body["attribution"] = attribution
        if tags is not None:
            body["tags"] = tags
        result = self._request("POST", "/remember", json=body, idempotency_key=idempotency_key)
        if "statement" in result:
            result["content"] = result["statement"]
        return result

    def get_fact(self, fact_id: str) -> Dict[str, Any]:
        """GET /facts/:id"""
        return self._request("GET", f"/facts/{fact_id}")

    def list_facts(self, **params: Any) -> Dict[str, Any]:
        """GET /facts — keyset-paginated fact list."""
        return self._request("GET", "/facts", params=params)

    def patch_fact(self, fact_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /facts/:id"""
        return self._request("PATCH", f"/facts/{fact_id}", json=fields)

    def forget_fact(self, fact_id: str, idempotency_key: Optional[str] = None) -> None:
        """DELETE /facts/:id — soft-delete (bitemporal close)."""
        self._request("DELETE", f"/facts/{fact_id}", idempotency_key=idempotency_key)

    def restore_fact(self, fact_id: str) -> Dict[str, Any]:
        """POST /facts/:id/restore"""
        return self._request("POST", f"/facts/{fact_id}/restore")

    def pin_fact(self, fact_id: str, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /facts/:id/pin {pinned: true}"""
        return self._request(
            "POST", f"/facts/{fact_id}/pin",
            json={"pinned": True}, idempotency_key=idempotency_key,
        )

    def unpin_fact(self, fact_id: str, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /facts/:id/pin {pinned: false}"""
        return self._request(
            "POST", f"/facts/{fact_id}/pin",
            json={"pinned": False}, idempotency_key=idempotency_key,
        )

    def get_fact_citations(self, fact_id: str) -> Dict[str, Any]:
        """GET /facts/:id/citations"""
        return self._request("GET", f"/facts/{fact_id}/citations")

    # ── Timeline / Graph / Health / Export ───────────────────────────────────

    def timeline(
        self,
        *,
        limit: Optional[int] = None,
        since: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /timeline"""
        return self._request("GET", "/timeline", params={"limit": limit, "since": since})

    def graph(self, *, focus: Optional[str] = None) -> Dict[str, Any]:
        """GET /graph"""
        return self._request("GET", "/graph", params={"focus": focus})

    def health(self) -> Dict[str, Any]:
        """GET /health"""
        return self._request("GET", "/health")

    def export_workspace(self) -> Dict[str, Any]:
        """GET /export"""
        return self._request("GET", "/export")

    def audit(self, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """GET /audit"""
        return self._request("GET", "/audit", params={"limit": limit})

    # ── Entities ──────────────────────────────────────────────────────────────

    def list_entities(
        self,
        *,
        kind: Optional[str] = None,
        q: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /entities"""
        return self._request("GET", "/entities", params={"kind": kind, "q": q, "limit": limit})

    def get_entity(self, entity_id: str) -> Dict[str, Any]:
        """GET /entities/:id"""
        return self._request("GET", f"/entities/{entity_id}")

    def create_entity(
        self,
        name: str,
        kind: str,
        *,
        aliases: Optional[List[str]] = None,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /entities"""
        body: Dict[str, Any] = {"name": name, "kind": kind}
        if aliases is not None:
            body["aliases"] = aliases
        if description is not None:
            body["description"] = description
        if metadata is not None:
            body["metadata"] = metadata
        return self._request("POST", "/entities", json=body, idempotency_key=idempotency_key)

    def update_entity(self, entity_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /entities/:id"""
        return self._request("PATCH", f"/entities/{entity_id}", json=fields)

    def list_entity_facts(self, entity_id: str, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """GET /entities/:id/facts"""
        return self._request("GET", f"/entities/{entity_id}/facts", params={"limit": limit})

    # ── Episodes ──────────────────────────────────────────────────────────────

    def list_episodes(self, **params: Any) -> Dict[str, Any]:
        """GET /episodes"""
        return self._request("GET", "/episodes", params=params)

    def get_episode(self, episode_id: str) -> Dict[str, Any]:
        """GET /episodes/:id"""
        return self._request("GET", f"/episodes/{episode_id}")

    # ── Decisions ─────────────────────────────────────────────────────────────

    def list_decisions(
        self,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /decisions"""
        return self._request("GET", "/decisions", params={"status": status, "limit": limit})

    def get_decision(self, decision_id: str) -> Dict[str, Any]:
        """GET /decisions/:id"""
        return self._request("GET", f"/decisions/{decision_id}")

    def create_decision(self, **fields: Any) -> Dict[str, Any]:
        """POST /decisions"""
        return self._request("POST", "/decisions", json=fields)

    def supersede_decision(self, decision_id: str, superseded_by_id: str) -> Dict[str, Any]:
        """PATCH /decisions/:id {supersededById}"""
        return self._request(
            "PATCH", f"/decisions/{decision_id}",
            json={"supersededById": superseded_by_id},
        )

    # ── Relations ─────────────────────────────────────────────────────────────

    def list_relations(
        self,
        *,
        judgment_status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /relations"""
        return self._request(
            "GET", "/relations",
            params={"judgmentStatus": judgment_status, "limit": limit},
        )

    def create_relation(self, **fields: Any) -> Dict[str, Any]:
        """POST /relations"""
        return self._request("POST", "/relations", json=fields)

    def patch_relation(self, relation_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /relations/:id"""
        return self._request("PATCH", f"/relations/{relation_id}", json=fields)

    # ── Citations ─────────────────────────────────────────────────────────────

    def list_citations(self, **params: Any) -> Dict[str, Any]:
        """GET /citations"""
        return self._request("GET", "/citations", params=params)

    # ── Review queue ──────────────────────────────────────────────────────────

    def list_review(self, **params: Any) -> Dict[str, Any]:
        """GET /review"""
        return self._request("GET", "/review", params=params)

    def review_count(self) -> Dict[str, Any]:
        """GET /review/count"""
        return self._request("GET", "/review/count")

    def enqueue_review(self, **fields: Any) -> Dict[str, Any]:
        """POST /review/enqueue"""
        return self._request("POST", "/review/enqueue", json=fields)

    def resolve_review(self, review_id: str, resolution: str) -> Dict[str, Any]:
        """POST /review/:id/resolve"""
        return self._request(
            "POST", f"/review/{review_id}/resolve",
            json={"resolution": resolution},
        )

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def create_session(self, **fields: Any) -> Dict[str, Any]:
        """POST /session/start"""
        return self._request("POST", "/session/start", json=fields)

    def collapse_session(self, session_id: str, **fields: Any) -> Dict[str, Any]:
        """POST /session/:id/collapse"""
        return self._request("POST", f"/session/{session_id}/collapse", json=fields)

    def add_turn(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append a conversation turn to an active session (POST /session/:id/turn).

        Returns None — the server responds 204 No Content.
        A turn stores only role and content (APP-018): the server refuses extra
        fields with 400.
        """
        body: Dict[str, Any] = {"role": role, "content": content}
        self._request("POST", f"/session/{session_id}/turn", json=body)

    def pin_session_turn(
        self,
        session_id: str,
        turn_id: str,
        pinned: bool,
    ) -> None:
        """Pin or unpin a turn within an active session (POST /session/:id/pin).

        Returns None — the server responds 204 No Content.
        A turn stores only role and content (APP-018): the server refuses extra
        fields with 400.
        """
        self._request(
            "POST",
            f"/session/{session_id}/pin",
            json={"turnId": turn_id, "pinned": pinned},
        )

    # ── Consolidation ─────────────────────────────────────────────────────────

    def trigger_consolidation(
        self,
        *,
        mode: str = "fast",
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """POST /consolidation/trigger.

        Only mode="fast" with dry_run=False is currently supported. Manual
        deep mode and dry runs return API status 422.
        """
        return self._request(
            "POST", "/consolidation/trigger",
            json={"mode": mode, "dryRun": dry_run},
        )

    # ── Reminders ─────────────────────────────────────────────────────────────

    def create_reminder(
        self,
        content: str,
        condition: str,
        *,
        trigger_at: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /reminders"""
        body: Dict[str, Any] = {"content": content, "condition": condition}
        if trigger_at is not None:
            body["triggerAt"] = trigger_at
        return self._request("POST", "/reminders", json=body, idempotency_key=idempotency_key)

    def list_reminders(
        self,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /reminders"""
        return self._request("GET", "/reminders", params={"status": status, "limit": limit})

    def dismiss_reminder(self, reminder_id: str) -> None:
        """DELETE /reminders/:id"""
        self._request("DELETE", f"/reminders/{reminder_id}")

    # ── Tasks ─────────────────────────────────────────────────────────────────

    def list_tasks(self, **params: Any) -> Dict[str, Any]:
        """GET /tasks"""
        return self._request("GET", "/tasks", params=params)

    def create_task(self, **fields: Any) -> Dict[str, Any]:
        """POST /tasks"""
        return self._request("POST", "/tasks", json=fields)

    def get_task(self, task_id: str) -> Dict[str, Any]:
        """GET /tasks/:id"""
        return self._request("GET", f"/tasks/{task_id}")

    def patch_task(self, task_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /tasks/:id"""
        return self._request("PATCH", f"/tasks/{task_id}", json=fields)

    def archive_task(self, task_id: str) -> None:
        """DELETE /tasks/:id"""
        self._request("DELETE", f"/tasks/{task_id}")

    # ── Events ────────────────────────────────────────────────────────────────

    def list_events(self, **params: Any) -> Dict[str, Any]:
        """GET /events"""
        return self._request("GET", "/events", params=params)

    def create_event(self, **fields: Any) -> Dict[str, Any]:
        """POST /events"""
        return self._request("POST", "/events", json=fields)

    def get_event(self, event_id: str) -> Dict[str, Any]:
        """GET /events/:id"""
        return self._request("GET", f"/events/{event_id}")

    def archive_event(self, event_id: str) -> None:
        """DELETE /events/:id"""
        self._request("DELETE", f"/events/{event_id}")

    # ── Reasoning ─────────────────────────────────────────────────────────────

    def list_reasoning(self, **params: Any) -> Dict[str, Any]:
        """GET /reasoning"""
        return self._request("GET", "/reasoning", params=params)

    def create_reasoning(self, **fields: Any) -> Dict[str, Any]:
        """POST /reasoning"""
        return self._request("POST", "/reasoning", json=fields)

    def get_reasoning(self, reasoning_id: str) -> Dict[str, Any]:
        """GET /reasoning/:id"""
        return self._request("GET", f"/reasoning/{reasoning_id}")

    def patch_reasoning(self, reasoning_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /reasoning/:id"""
        return self._request("PATCH", f"/reasoning/{reasoning_id}", json=fields)

    def archive_reasoning(self, reasoning_id: str) -> None:
        """DELETE /reasoning/:id"""
        self._request("DELETE", f"/reasoning/{reasoning_id}")

    # ── Strategies ────────────────────────────────────────────────────────────

    def list_strategies(self, **params: Any) -> Dict[str, Any]:
        """GET /strategies"""
        return self._request("GET", "/strategies", params=params)

    def create_strategy(self, **fields: Any) -> Dict[str, Any]:
        """POST /strategies"""
        return self._request("POST", "/strategies", json=fields)

    def get_strategy(self, strategy_id: str) -> Dict[str, Any]:
        """GET /strategies/:id"""
        return self._request("GET", f"/strategies/{strategy_id}")

    def patch_strategy(self, strategy_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /strategies/:id"""
        return self._request("PATCH", f"/strategies/{strategy_id}", json=fields)

    def archive_strategy(self, strategy_id: str) -> None:
        """DELETE /strategies/:id"""
        self._request("DELETE", f"/strategies/{strategy_id}")

    # ── Hyperedges ────────────────────────────────────────────────────────────

    def list_hyperedges(self, **params: Any) -> Dict[str, Any]:
        """GET /hyperedges"""
        return self._request("GET", "/hyperedges", params=params)

    def create_hyperedge(
        self,
        member_ids: List[str],
        *,
        label: Optional[str] = None,
        description: Optional[str] = None,
        context_query: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /hyperedges"""
        body: Dict[str, Any] = {"memberIds": member_ids}
        if label is not None:
            body["label"] = label
        if description is not None:
            body["description"] = description
        if context_query is not None:
            body["contextQuery"] = context_query
        return self._request("POST", "/hyperedges", json=body, idempotency_key=idempotency_key)

    def get_hyperedge(self, hyperedge_id: str) -> Dict[str, Any]:
        """GET /hyperedges/:id"""
        return self._request("GET", f"/hyperedges/{hyperedge_id}")

    def patch_hyperedge(self, hyperedge_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /hyperedges/:id"""
        return self._request("PATCH", f"/hyperedges/{hyperedge_id}", json=fields)

    def archive_hyperedge(self, hyperedge_id: str) -> None:
        """DELETE /hyperedges/:id"""
        self._request("DELETE", f"/hyperedges/{hyperedge_id}")

    # ── Meta-cognition (§31) ──────────────────────────────────────────────────

    def get_self_model(
        self,
        *,
        aspect: Optional[str] = None,
        entity: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /metacognition"""
        return self._request("GET", "/metacognition", params={"aspect": aspect, "entity": entity})

    # ── Anticipation (§30) ────────────────────────────────────────────────────

    def get_anticipation_feed(
        self,
        *,
        recently_recalled_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /anticipation"""
        return self._request(
            "GET", "/anticipation",
            params={"recentlyRecalledId": recently_recalled_id, "limit": limit},
        )

    # ── Composition (§32) ─────────────────────────────────────────────────────

    def list_composition_rules(self, **params: Any) -> Dict[str, Any]:
        """GET /composition/rules"""
        return self._request("GET", "/composition/rules", params=params)

    def create_composition_rule(self, **fields: Any) -> Dict[str, Any]:
        """POST /composition/rules"""
        return self._request("POST", "/composition/rules", json=fields)

    def get_composition_rule(self, rule_id: str) -> Dict[str, Any]:
        """GET /composition/rules/:id"""
        return self._request("GET", f"/composition/rules/{rule_id}")

    def patch_composition_rule(self, rule_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /composition/rules/:id"""
        return self._request("PATCH", f"/composition/rules/{rule_id}", json=fields)

    def dry_run_composition(self, **fields: Any) -> Dict[str, Any]:
        """POST /composition/dry-run"""
        return self._request("POST", "/composition/dry-run", json=fields)

    # ── Self-editing (§13) ────────────────────────────────────────────────────

    def self_edit(
        self,
        action: str,
        target: str,
        reason: str,
        *,
        content: Optional[str] = None,
        agent_id: Optional[str] = None,
        session_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /self/edit"""
        body: Dict[str, Any] = {"action": action, "target": target, "reason": reason}
        if content is not None:
            body["content"] = content
        if agent_id is not None:
            body["agentId"] = agent_id
        if session_id is not None:
            body["sessionId"] = session_id
        return self._request("POST", "/self/edit", json=body, idempotency_key=idempotency_key)

    def self_reflect(self, *, agent_id: Optional[str] = None) -> Dict[str, Any]:
        """POST /self/reflect"""
        body: Dict[str, Any] = {}
        if agent_id is not None:
            body["agentId"] = agent_id
        return self._request("POST", "/self/reflect", json=body)

    def get_self_profile(self, *, agent_id: Optional[str] = None) -> Dict[str, Any]:
        """GET /self/profile"""
        return self._request("GET", "/self/profile", params={"agentId": agent_id})

    # ── Federation (§20) ──────────────────────────────────────────────────────

    def list_federation_peers(self) -> Dict[str, Any]:
        """GET /memory/federation/peers"""
        return self._request("GET", "/memory/federation/peers")

    def list_pending_federation_peers(self) -> Dict[str, Any]:
        """GET /memory/federation/peers/pending"""
        return self._request("GET", "/memory/federation/peers/pending")

    def approve_federation_peer(self, peer_id: str, new_cert_der: str, **fields: Any) -> None:
        """POST /memory/federation/peers/:id/approve"""
        self._request(
            "POST", f"/memory/federation/peers/{peer_id}/approve",
            json={"newCertDer": new_cert_der, **fields},
        )

    def approve_federation_peer_key(
        self, peer_id: str, new_cert_der: str, **fields: Any
    ) -> Dict[str, Any]:
        """POST /memory/federation/peers/:id/approve-key"""
        return self._request(
            "POST", f"/memory/federation/peers/{peer_id}/approve-key",
            json={"newCertDer": new_cert_der, **fields},
        )

    def delete_federation_peer(self, peer_id: str) -> Dict[str, Any]:
        """DELETE /memory/federation/peers/:id"""
        return self._request("DELETE", f"/memory/federation/peers/{peer_id}")

    def list_federation_items(
        self,
        *,
        since: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /memory/federation/items"""
        return self._request(
            "GET", "/memory/federation/items",
            params={"since": since, "limit": limit},
        )

    def trigger_federation_sync(self, peer_id: str) -> Dict[str, Any]:
        """POST /memory/federation/sync"""
        return self._request("POST", "/memory/federation/sync", json={"peerId": peer_id})

    def get_federation_sync_job(self, job_id: str) -> Dict[str, Any]:
        """GET /memory/federation/sync/:jobId"""
        return self._request("GET", f"/memory/federation/sync/{job_id}")

    def resolve_federation_conflict(self, **fields: Any) -> Dict[str, Any]:
        """POST /memory/federation/resolve"""
        return self._request("POST", "/memory/federation/resolve", json=fields)


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------


class AsyncMnemosyneClient:
    """
    Asynchronous Mnemosyne HTTP client.

    Identical method surface to ``MnemosyneClient`` but every method is a
    coroutine that must be awaited. Uses ``httpx.AsyncClient`` internally.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        timeout: float = _DEFAULT_TIMEOUT,
        user_agent_suffix: Optional[str] = None,
        max_retries: int = 3,
        workspace_id: Optional[str] = None,
    ) -> None:
        if not url:
            raise ValueError("AsyncMnemosyneClient: `url` is required")
        if not api_key:
            raise ValueError("AsyncMnemosyneClient: `api_key` is required")
        self._base_url = url.rstrip("/")
        self._api_key = api_key
        self._user_agent_suffix = user_agent_suffix
        ua = _SDK_USER_AGENT
        if user_agent_suffix:
            ua = f"{ua} ({user_agent_suffix})"
        self._headers = _build_headers(api_key, {"User-Agent": ua})
        if workspace_id:
            self._headers["X-Workspace-Id"] = workspace_id
        self._timeout = timeout
        self._max_retries = max_retries
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            headers=self._headers,
            timeout=self._timeout,
        )

    async def aclose(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._http.aclose()

    def for_workspace(self, workspace_id: str) -> "AsyncMnemosyneClient":
        return AsyncMnemosyneClient(self._base_url, self._api_key, self._timeout, self._user_agent_suffix, self._max_retries, workspace_id=workspace_id)

    async def __aenter__(self) -> "AsyncMnemosyneClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    # ── Internal ─────────────────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        import asyncio
        import random

        extra_headers: Dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key
        clean_params: Optional[Dict[str, Any]] = None
        if params:
            clean_params = {k: v for k, v in params.items() if v is not None}
            if not clean_params:
                clean_params = None

        _RETRYABLE = {429, 500, 502, 503, 504}
        last_err: Optional[Exception] = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                # Full-jitter exponential backoff: 200ms, 400ms, 800ms base
                delay = last_err.retry_after_seconds if isinstance(last_err, MnemosyneAPIError) and last_err.retry_after_seconds is not None else (0.2 * (2 ** (attempt - 1))) * random.random()
                await asyncio.sleep(delay)
            try:
                response = await self._http.request(
                    method,
                    path,
                    params=clean_params,
                    json=json,
                    headers=extra_headers or None,
                )
            except httpx.TimeoutException as exc:
                error = MnemosyneTimeoutError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            except httpx.ConnectError as exc:
                if _replay_safe(method, path, bool(idempotency_key)) and attempt < self._max_retries:
                    last_err = MnemosyneNetworkError(str(exc))
                    continue
                error = MnemosyneNetworkError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            except httpx.TransportError as exc:
                error = MnemosyneNetworkError(str(exc))
                error.outcome_unknown = not _read_only(method, path)
                raise error from exc
            if not response.is_success:
                err = _parse_error(response)
                err.outcome_unknown = not _read_only(method, path) and err.status >= 500
                if not _replay_safe(method, path, bool(idempotency_key)) or err.retryable is False or err.status not in _RETRYABLE or attempt >= self._max_retries:
                    raise err
                last_err = err
                continue
            if response.status_code == 204:
                return None
            try:
                return response.json()
            except ValueError as exc:
                bad = MnemosyneResponseError(f"malformed JSON in successful response: {exc}")
                bad.outcome_unknown = not _read_only(method, path)
                raise bad from exc
        if last_err:
            raise last_err
        raise RuntimeError("unreachable")

    # ── Recall ───────────────────────────────────────────────────────────────

    async def recall(
        self,
        query: str,
        *,
        vector: Optional[List[float]] = None,
        top_k: Optional[int] = None,
        as_of: Optional[str] = None,
        vector_weight: Optional[float] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /recall

        ``as_of`` (ISO 8601, not in the future) ranks what memory held at that
        instant, including facts superseded since.
        """
        body: Dict[str, Any] = {"query": query}
        if session_id is not None:
            body["sessionId"] = session_id
        if vector is not None:
            body["vector"] = vector
        if top_k is not None:
            body["topK"] = top_k
        if as_of is not None:
            body["asOf"] = as_of
        if vector_weight is not None:
            body["vectorWeight"] = vector_weight
        return await self._request("POST", "/recall", json=body)

    # ── Facts ────────────────────────────────────────────────────────────────

    async def create_fact(
        self,
        content: str,
        *,
        attribution: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /remember

        See the sync client's `create_fact` docstring — same lossless
        {content -> statement} body remap and {statement -> content}
        response mirror (flatten-legacy-dual-core D2 step 3).
        """
        body: Dict[str, Any] = {"statement": content}
        if session_id is not None:
            body["sessionId"] = session_id
        if attribution is not None:
            body["attribution"] = attribution
        if tags is not None:
            body["tags"] = tags
        result = await self._request(
            "POST", "/remember", json=body, idempotency_key=idempotency_key
        )
        if "statement" in result:
            result["content"] = result["statement"]
        return result

    async def get_fact(self, fact_id: str) -> Dict[str, Any]:
        """GET /facts/:id"""
        return await self._request("GET", f"/facts/{fact_id}")

    async def list_facts(self, **params: Any) -> Dict[str, Any]:
        """GET /facts"""
        return await self._request("GET", "/facts", params=params)

    async def patch_fact(self, fact_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /facts/:id"""
        return await self._request("PATCH", f"/facts/{fact_id}", json=fields)

    async def forget_fact(self, fact_id: str, idempotency_key: Optional[str] = None) -> None:
        """DELETE /facts/:id"""
        await self._request("DELETE", f"/facts/{fact_id}", idempotency_key=idempotency_key)

    async def restore_fact(self, fact_id: str) -> Dict[str, Any]:
        """POST /facts/:id/restore"""
        return await self._request("POST", f"/facts/{fact_id}/restore")

    async def pin_fact(self, fact_id: str) -> Dict[str, Any]:
        """POST /facts/:id/pin {pinned: true}"""
        return await self._request("POST", f"/facts/{fact_id}/pin", json={"pinned": True})

    async def unpin_fact(self, fact_id: str) -> Dict[str, Any]:
        """POST /facts/:id/pin {pinned: false}"""
        return await self._request("POST", f"/facts/{fact_id}/pin", json={"pinned": False})

    async def get_fact_citations(self, fact_id: str) -> Dict[str, Any]:
        """GET /facts/:id/citations"""
        return await self._request("GET", f"/facts/{fact_id}/citations")

    # ── Timeline / Graph / Health / Export ───────────────────────────────────

    async def timeline(
        self,
        *,
        limit: Optional[int] = None,
        since: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /timeline"""
        return await self._request("GET", "/timeline", params={"limit": limit, "since": since})

    async def graph(self, *, focus: Optional[str] = None) -> Dict[str, Any]:
        """GET /graph"""
        return await self._request("GET", "/graph", params={"focus": focus})

    async def health(self) -> Dict[str, Any]:
        """GET /health"""
        return await self._request("GET", "/health")

    async def export_workspace(self) -> Dict[str, Any]:
        """GET /export"""
        return await self._request("GET", "/export")

    async def audit(self, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """GET /audit"""
        return await self._request("GET", "/audit", params={"limit": limit})

    # ── Entities ──────────────────────────────────────────────────────────────

    async def list_entities(self, **params: Any) -> Dict[str, Any]:
        """GET /entities"""
        return await self._request("GET", "/entities", params=params)

    async def get_entity(self, entity_id: str) -> Dict[str, Any]:
        """GET /entities/:id"""
        return await self._request("GET", f"/entities/{entity_id}")

    async def create_entity(
        self, name: str, kind: str, **fields: Any
    ) -> Dict[str, Any]:
        """POST /entities"""
        return await self._request("POST", "/entities", json={"name": name, "kind": kind, **fields})

    async def update_entity(self, entity_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /entities/:id"""
        return await self._request("PATCH", f"/entities/{entity_id}", json=fields)

    async def list_entity_facts(self, entity_id: str, *, limit: Optional[int] = None) -> Dict[str, Any]:
        """GET /entities/:id/facts"""
        return await self._request("GET", f"/entities/{entity_id}/facts", params={"limit": limit})

    # ── Episodes ──────────────────────────────────────────────────────────────

    async def list_episodes(self, **params: Any) -> Dict[str, Any]:
        """GET /episodes"""
        return await self._request("GET", "/episodes", params=params)

    async def get_episode(self, episode_id: str) -> Dict[str, Any]:
        """GET /episodes/:id"""
        return await self._request("GET", f"/episodes/{episode_id}")

    # ── Decisions ─────────────────────────────────────────────────────────────

    async def list_decisions(self, **params: Any) -> Dict[str, Any]:
        """GET /decisions"""
        return await self._request("GET", "/decisions", params=params)

    async def get_decision(self, decision_id: str) -> Dict[str, Any]:
        """GET /decisions/:id"""
        return await self._request("GET", f"/decisions/{decision_id}")

    async def create_decision(self, **fields: Any) -> Dict[str, Any]:
        """POST /decisions"""
        return await self._request("POST", "/decisions", json=fields)

    async def supersede_decision(self, decision_id: str, superseded_by_id: str) -> Dict[str, Any]:
        """PATCH /decisions/:id"""
        return await self._request(
            "PATCH", f"/decisions/{decision_id}",
            json={"supersededById": superseded_by_id},
        )

    # ── Relations ─────────────────────────────────────────────────────────────

    async def list_relations(self, **params: Any) -> Dict[str, Any]:
        """GET /relations"""
        return await self._request("GET", "/relations", params=params)

    async def create_relation(self, **fields: Any) -> Dict[str, Any]:
        """POST /relations"""
        return await self._request("POST", "/relations", json=fields)

    async def patch_relation(self, relation_id: str, **fields: Any) -> Dict[str, Any]:
        """PATCH /relations/:id"""
        return await self._request("PATCH", f"/relations/{relation_id}", json=fields)

    # ── Citations ─────────────────────────────────────────────────────────────

    async def list_citations(self, **params: Any) -> Dict[str, Any]:
        """GET /citations"""
        return await self._request("GET", "/citations", params=params)

    # ── Session ───────────────────────────────────────────────────────────────

    async def create_session(self, **fields: Any) -> Dict[str, Any]:
        """POST /session/start"""
        return await self._request("POST", "/session/start", json=fields)

    async def collapse_session(self, session_id: str, **fields: Any) -> Dict[str, Any]:
        """POST /session/:id/collapse"""
        return await self._request("POST", f"/session/{session_id}/collapse", json=fields)

    async def add_turn(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append a conversation turn to an active session (POST /session/:id/turn).

        Returns None — the server responds 204 No Content.
        A turn stores only role and content (APP-018): the server refuses extra
        fields with 400.
        """
        body: Dict[str, Any] = {"role": role, "content": content}
        await self._request("POST", f"/session/{session_id}/turn", json=body)

    async def pin_session_turn(
        self,
        session_id: str,
        turn_id: str,
        pinned: bool,
    ) -> None:
        """Pin or unpin a turn within an active session (POST /session/:id/pin).

        Returns None — the server responds 204 No Content.
        A turn stores only role and content (APP-018): the server refuses extra
        fields with 400.
        """
        await self._request(
            "POST",
            f"/session/{session_id}/pin",
            json={"turnId": turn_id, "pinned": pinned},
        )

    # ── Consolidation ─────────────────────────────────────────────────────────

    async def trigger_consolidation(
        self,
        *,
        mode: str = "fast",
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """POST /consolidation/trigger.

        Only mode="fast" with dry_run=False is currently supported. Manual
        deep mode and dry runs return API status 422.
        """
        return await self._request(
            "POST", "/consolidation/trigger",
            json={"mode": mode, "dryRun": dry_run},
        )

    # ── Tasks ─────────────────────────────────────────────────────────────────

    async def list_tasks(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/tasks", params=params)

    async def create_task(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/tasks", json=fields)

    async def get_task(self, task_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/tasks/{task_id}")

    async def patch_task(self, task_id: str, **fields: Any) -> Dict[str, Any]:
        return await self._request("PATCH", f"/tasks/{task_id}", json=fields)

    async def archive_task(self, task_id: str) -> None:
        await self._request("DELETE", f"/tasks/{task_id}")

    # ── Events ────────────────────────────────────────────────────────────────

    async def list_events(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/events", params=params)

    async def create_event(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/events", json=fields)

    async def get_event(self, event_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/events/{event_id}")

    async def archive_event(self, event_id: str) -> None:
        await self._request("DELETE", f"/events/{event_id}")

    # ── Reasoning ─────────────────────────────────────────────────────────────

    async def list_reasoning(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/reasoning", params=params)

    async def create_reasoning(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/reasoning", json=fields)

    async def get_reasoning(self, reasoning_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/reasoning/{reasoning_id}")

    async def patch_reasoning(self, reasoning_id: str, **fields: Any) -> Dict[str, Any]:
        return await self._request("PATCH", f"/reasoning/{reasoning_id}", json=fields)

    async def archive_reasoning(self, reasoning_id: str) -> None:
        await self._request("DELETE", f"/reasoning/{reasoning_id}")

    # ── Strategies ────────────────────────────────────────────────────────────

    async def list_strategies(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/strategies", params=params)

    async def create_strategy(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/strategies", json=fields)

    async def get_strategy(self, strategy_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/strategies/{strategy_id}")

    async def patch_strategy(self, strategy_id: str, **fields: Any) -> Dict[str, Any]:
        return await self._request("PATCH", f"/strategies/{strategy_id}", json=fields)

    async def archive_strategy(self, strategy_id: str) -> None:
        await self._request("DELETE", f"/strategies/{strategy_id}")

    # ── Hyperedges ────────────────────────────────────────────────────────────

    async def list_hyperedges(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/hyperedges", params=params)

    async def create_hyperedge(self, member_ids: List[str], **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/hyperedges", json={"memberIds": member_ids, **fields})

    async def get_hyperedge(self, hyperedge_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/hyperedges/{hyperedge_id}")

    async def patch_hyperedge(self, hyperedge_id: str, **fields: Any) -> Dict[str, Any]:
        return await self._request("PATCH", f"/hyperedges/{hyperedge_id}", json=fields)

    async def archive_hyperedge(self, hyperedge_id: str) -> None:
        await self._request("DELETE", f"/hyperedges/{hyperedge_id}")

    # ── Meta-cognition ────────────────────────────────────────────────────────

    async def get_self_model(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/metacognition", params=params)

    # ── Anticipation ──────────────────────────────────────────────────────────

    async def get_anticipation_feed(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/anticipation", params=params)

    # ── Composition ───────────────────────────────────────────────────────────

    async def list_composition_rules(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/composition/rules", params=params)

    async def create_composition_rule(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/composition/rules", json=fields)

    async def get_composition_rule(self, rule_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/composition/rules/{rule_id}")

    async def patch_composition_rule(self, rule_id: str, **fields: Any) -> Dict[str, Any]:
        return await self._request("PATCH", f"/composition/rules/{rule_id}", json=fields)

    async def dry_run_composition(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/composition/dry-run", json=fields)

    # ── Self-editing ──────────────────────────────────────────────────────────

    async def self_edit(
        self, action: str, target: str, reason: str, **fields: Any
    ) -> Dict[str, Any]:
        return await self._request(
            "POST", "/self/edit",
            json={"action": action, "target": target, "reason": reason, **fields},
        )

    async def self_reflect(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/self/reflect", json=fields)

    async def get_self_profile(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/self/profile", params=params)

    # ── Federation ────────────────────────────────────────────────────────────

    async def list_federation_peers(self) -> Dict[str, Any]:
        return await self._request("GET", "/memory/federation/peers")

    async def list_pending_federation_peers(self) -> Dict[str, Any]:
        return await self._request("GET", "/memory/federation/peers/pending")

    async def approve_federation_peer(
        self, peer_id: str, new_cert_der: str, **fields: Any
    ) -> None:
        await self._request(
            "POST", f"/memory/federation/peers/{peer_id}/approve",
            json={"newCertDer": new_cert_der, **fields},
        )

    async def approve_federation_peer_key(
        self, peer_id: str, new_cert_der: str, **fields: Any
    ) -> Dict[str, Any]:
        return await self._request(
            "POST", f"/memory/federation/peers/{peer_id}/approve-key",
            json={"newCertDer": new_cert_der, **fields},
        )

    async def delete_federation_peer(self, peer_id: str) -> Dict[str, Any]:
        return await self._request("DELETE", f"/memory/federation/peers/{peer_id}")

    async def list_federation_items(self, **params: Any) -> Dict[str, Any]:
        return await self._request("GET", "/memory/federation/items", params=params)

    async def trigger_federation_sync(self, peer_id: str) -> Dict[str, Any]:
        return await self._request(
            "POST", "/memory/federation/sync", json={"peerId": peer_id}
        )

    async def get_federation_sync_job(self, job_id: str) -> Dict[str, Any]:
        return await self._request("GET", f"/memory/federation/sync/{job_id}")

    async def resolve_federation_conflict(self, **fields: Any) -> Dict[str, Any]:
        return await self._request("POST", "/memory/federation/resolve", json=fields)
