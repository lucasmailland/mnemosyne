"""
Tests for MnemosyneClient (sync) and AsyncMnemosyneClient (async).

Uses respx to mock the httpx transport layer — this tests the SDK's
REAL request construction (URL, method, headers, body) without
touching a live server.

Python 3.9-compatible: from __future__ import annotations, Union, Optional.
"""
from __future__ import annotations

import json
from typing import Any, Dict

import httpx
import pytest
import respx

from mnemo import AsyncMnemosyneClient, MnemosyneClient
from mnemo.types import MnemosyneAPIError, MnemosyneNetworkError

BASE_URL = "https://memory.test"
API_KEY = "mns_test_abc123"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _client() -> MnemosyneClient:
    return MnemosyneClient(url=BASE_URL, api_key=API_KEY)


def _async_client() -> AsyncMnemosyneClient:
    return AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY)


def _auth_header() -> str:
    return f"Bearer {API_KEY}"


# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------

class TestClientConstruction:
    def test_missing_url_raises(self) -> None:
        with pytest.raises(ValueError, match="url"):
            MnemosyneClient(url="", api_key="k")

    def test_missing_api_key_raises(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            MnemosyneClient(url=BASE_URL, api_key="")

    def test_async_missing_url_raises(self) -> None:
        with pytest.raises(ValueError, match="url"):
            AsyncMnemosyneClient(url="", api_key="k")

    def test_async_missing_api_key_raises(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            AsyncMnemosyneClient(url=BASE_URL, api_key="")

    def test_context_manager_sync(self) -> None:
        with MnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            assert c is not None

    async def test_context_manager_async(self) -> None:
        async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            assert c is not None


# ---------------------------------------------------------------------------
# Recall
# ---------------------------------------------------------------------------

class TestRecall:
    @respx.mock
    def test_recall_sends_correct_body(self) -> None:
        route = respx.post(f"{BASE_URL}/recall").mock(
            return_value=httpx.Response(
                200,
                json={"hits": [{"id": "f1", "content": "hello", "score": 0.9}], "debug": {}},
            )
        )
        c = _client()
        result = c.recall("hello world", top_k=5)
        assert result["hits"][0]["id"] == "f1"
        assert route.called
        sent = json.loads(route.calls[0].request.content)
        assert sent["query"] == "hello world"
        assert sent["topK"] == 5

    @respx.mock
    def test_recall_sends_auth_header(self) -> None:
        route = respx.post(f"{BASE_URL}/recall").mock(
            return_value=httpx.Response(200, json={"hits": [], "debug": {}})
        )
        _client().recall("q")
        assert route.calls[0].request.headers["authorization"] == _auth_header()

    @respx.mock
    async def test_async_recall(self) -> None:
        respx.post(f"{BASE_URL}/recall").mock(
            return_value=httpx.Response(200, json={"hits": [], "debug": {}})
        )
        async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            result = await c.recall("q")
        assert result["hits"] == []


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    @respx.mock
    def test_4xx_raises_api_error(self) -> None:
        respx.post(f"{BASE_URL}/recall").mock(
            return_value=httpx.Response(
                401,
                json={"error": {"message": "unauthorized", "code": "ERR_AUTH"}},
            )
        )
        with pytest.raises(MnemosyneAPIError) as exc_info:
            _client().recall("q")
        err = exc_info.value
        assert err.status == 401
        assert err.code == "ERR_AUTH"
        assert "unauthorized" in err.message

    @respx.mock
    def test_5xx_raises_api_error(self) -> None:
        respx.post(f"{BASE_URL}/recall").mock(
            return_value=httpx.Response(500, text="internal error")
        )
        with pytest.raises(MnemosyneAPIError) as exc_info:
            _client().recall("q")
        assert exc_info.value.status == 500

    @respx.mock
    def test_network_error_raises_network_error(self) -> None:
        respx.post(f"{BASE_URL}/recall").mock(
            side_effect=httpx.ConnectError("timeout")
        )
        with pytest.raises(MnemosyneNetworkError):
            _client().recall("q")

    @respx.mock
    def test_204_returns_none(self) -> None:
        respx.delete(f"{BASE_URL}/reminders/r1").mock(
            return_value=httpx.Response(204)
        )
        result = _client().dismiss_reminder("r1")
        assert result is None


# ---------------------------------------------------------------------------
# Facts
# ---------------------------------------------------------------------------

class TestFacts:
    @respx.mock
    def test_workspace_and_session_are_sent_on_remember(self) -> None:
        route = respx.post(f"{BASE_URL}/remember").mock(return_value=httpx.Response(201, json={"id": "f1", "statement": "hello"}))
        MnemosyneClient(url=BASE_URL, api_key=API_KEY, workspace_id="ws-2").create_fact("hello", session_id="s-1")
        assert route.calls[0].request.headers["x-workspace-id"] == "ws-2"
        assert json.loads(route.calls[0].request.content)["sessionId"] == "s-1"

    @respx.mock
    def test_create_fact(self) -> None:
        route = respx.post(f"{BASE_URL}/remember").mock(
            return_value=httpx.Response(201, json={"id": "fact_1", "statement": "hello"})
        )
        result = _client().create_fact("hello", tags=["greeting"])
        assert result["id"] == "fact_1"
        assert result["content"] == "hello"
        body = json.loads(route.calls[0].request.content)
        assert body["statement"] == "hello"
        assert body["tags"] == ["greeting"]

    @respx.mock
    def test_get_fact(self) -> None:
        respx.get(f"{BASE_URL}/facts/f1").mock(
            return_value=httpx.Response(200, json={"id": "f1", "content": "x"})
        )
        assert _client().get_fact("f1")["id"] == "f1"

    @respx.mock
    def test_forget_fact_sends_delete(self) -> None:
        route = respx.delete(f"{BASE_URL}/facts/f1").mock(
            return_value=httpx.Response(204)
        )
        _client().forget_fact("f1")
        assert route.called

    @respx.mock
    def test_pin_fact_sends_pinned_true(self) -> None:
        route = respx.post(f"{BASE_URL}/facts/f1/pin").mock(
            return_value=httpx.Response(200, json={"id": "f1", "pinned": True})
        )
        _client().pin_fact("f1")
        body = json.loads(route.calls[0].request.content)
        assert body["pinned"] is True

    @respx.mock
    def test_unpin_fact_sends_pinned_false(self) -> None:
        route = respx.post(f"{BASE_URL}/facts/f1/pin").mock(
            return_value=httpx.Response(200, json={"id": "f1", "pinned": False})
        )
        _client().unpin_fact("f1")
        body = json.loads(route.calls[0].request.content)
        assert body["pinned"] is False

    @respx.mock
    def test_restore_fact(self) -> None:
        respx.post(f"{BASE_URL}/facts/f1/restore").mock(
            return_value=httpx.Response(200, json={"id": "f1"})
        )
        assert _client().restore_fact("f1")["id"] == "f1"

    @respx.mock
    def test_patch_fact(self) -> None:
        route = respx.patch(f"{BASE_URL}/facts/f1").mock(
            return_value=httpx.Response(200, json={"id": "f1", "content": "updated"})
        )
        result = _client().patch_fact("f1", content="updated")
        assert result["content"] == "updated"
        body = json.loads(route.calls[0].request.content)
        assert body["content"] == "updated"

    @respx.mock
    def test_idempotency_key_sent_as_header(self) -> None:
        route = respx.post(f"{BASE_URL}/remember").mock(
            return_value=httpx.Response(201, json={"id": "f1"})
        )
        _client().create_fact("x", idempotency_key="idem-123")
        assert route.calls[0].request.headers["idempotency-key"] == "idem-123"


# ---------------------------------------------------------------------------
# Timeline / Graph / Health
# ---------------------------------------------------------------------------

class TestBasicEndpoints:
    @respx.mock
    def test_timeline(self) -> None:
        route = respx.get(f"{BASE_URL}/timeline").mock(
            return_value=httpx.Response(200, json={"items": [], "nextCursor": None})
        )
        _client().timeline(limit=10, since="2026-01-01T00:00:00Z")
        assert "limit=10" in str(route.calls[0].request.url)

    @respx.mock
    def test_health(self) -> None:
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )
        assert _client().health()["status"] == "ok"

    @respx.mock
    def test_graph(self) -> None:
        respx.get(f"{BASE_URL}/graph").mock(
            return_value=httpx.Response(200, json={"nodes": [], "edges": []})
        )
        result = _client().graph()
        assert "nodes" in result


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------

class TestEntities:
    @respx.mock
    def test_create_entity(self) -> None:
        route = respx.post(f"{BASE_URL}/entities").mock(
            return_value=httpx.Response(201, json={"id": "e1", "name": "Acme", "kind": "org"})
        )
        result = _client().create_entity("Acme", "org")
        assert result["id"] == "e1"
        body = json.loads(route.calls[0].request.content)
        assert body["name"] == "Acme"
        assert body["kind"] == "org"

    @respx.mock
    def test_list_entities(self) -> None:
        route = respx.get(f"{BASE_URL}/entities").mock(
            return_value=httpx.Response(200, json={"items": [], "total": 0})
        )
        _client().list_entities(kind="person", limit=5)
        assert "kind=person" in str(route.calls[0].request.url)
        assert "limit=5" in str(route.calls[0].request.url)

    @respx.mock
    def test_none_params_stripped(self) -> None:
        route = respx.get(f"{BASE_URL}/entities").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        _client().list_entities(kind=None, limit=None)
        # No query string should be appended for None values.
        assert "kind" not in str(route.calls[0].request.url)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

class TestTasks:
    @respx.mock
    def test_list_tasks_with_status_filter(self) -> None:
        route = respx.get(f"{BASE_URL}/tasks").mock(
            return_value=httpx.Response(
                200, json={"items": [], "total": 0, "offset": 0, "limit": 50, "hasMore": False}
            )
        )
        _client().list_tasks(status="pending")
        assert "status=pending" in str(route.calls[0].request.url)

    @respx.mock
    def test_create_task(self) -> None:
        route = respx.post(f"{BASE_URL}/tasks").mock(
            return_value=httpx.Response(201, json={"id": "t1"})
        )
        _client().create_task(title="Ship SDK", assignedTo="agent-1")
        body = json.loads(route.calls[0].request.content)
        assert body["title"] == "Ship SDK"

    @respx.mock
    def test_archive_task_sends_delete(self) -> None:
        route = respx.delete(f"{BASE_URL}/tasks/t1").mock(
            return_value=httpx.Response(204)
        )
        _client().archive_task("t1")
        assert route.called


# ---------------------------------------------------------------------------
# Hyperedges
# ---------------------------------------------------------------------------

class TestHyperedges:
    @respx.mock
    def test_create_hyperedge(self) -> None:
        route = respx.post(f"{BASE_URL}/hyperedges").mock(
            return_value=httpx.Response(201, json={"id": "h1"})
        )
        _client().create_hyperedge(["f1", "f2", "f3"], label="cluster")
        body = json.loads(route.calls[0].request.content)
        assert body["memberIds"] == ["f1", "f2", "f3"]
        assert body["label"] == "cluster"


# ---------------------------------------------------------------------------
# Anticipation
# ---------------------------------------------------------------------------

class TestAnticipation:
    @respx.mock
    def test_get_anticipation_feed(self) -> None:
        respx.get(f"{BASE_URL}/anticipation").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [
                        {"factId": "f1", "score": 0.9, "source": "sequential", "confidence": 0.8}
                    ],
                    "generatedAt": "2026-06-17T00:00:00Z",
                },
            )
        )
        result = _client().get_anticipation_feed(limit=5)
        assert result["items"][0]["factId"] == "f1"
        assert result["items"][0]["source"] == "sequential"


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------

class TestComposition:
    @respx.mock
    def test_list_composition_rules(self) -> None:
        respx.get(f"{BASE_URL}/composition/rules").mock(
            return_value=httpx.Response(200, json={"rules": [], "total": 0})
        )
        result = _client().list_composition_rules()
        assert "rules" in result

    @respx.mock
    def test_dry_run_composition(self) -> None:
        route = respx.post(f"{BASE_URL}/composition/dry-run").mock(
            return_value=httpx.Response(
                200,
                json={"inferences": [{"id": "inf-1", "content": "derived", "confidence": 0.7}]},
            )
        )
        result = _client().dry_run_composition(factIds=["f1", "f2"])
        assert result["inferences"][0]["id"] == "inf-1"
        body = json.loads(route.calls[0].request.content)
        assert body["factIds"] == ["f1", "f2"]


# ---------------------------------------------------------------------------
# Self-edit
# ---------------------------------------------------------------------------

class TestSelfEdit:
    @respx.mock
    def test_self_edit_post_body(self) -> None:
        route = respx.post(f"{BASE_URL}/self/edit").mock(
            return_value=httpx.Response(
                200,
                json={
                    "action": "strengthen",
                    "target": "f1",
                    "applied": True,
                    "appliedAt": "2026-06-17T00:00:00Z",
                },
            )
        )
        result = _client().self_edit("strengthen", "f1", "boost confidence")
        assert result["applied"] is True
        body = json.loads(route.calls[0].request.content)
        assert body["action"] == "strengthen"
        assert body["target"] == "f1"
        assert body["reason"] == "boost confidence"

    @respx.mock
    def test_self_reflect(self) -> None:
        respx.post(f"{BASE_URL}/self/reflect").mock(
            return_value=httpx.Response(200, json={"summary": "all good"})
        )
        result = _client().self_reflect()
        assert result["summary"] == "all good"


# ---------------------------------------------------------------------------
# Federation
# ---------------------------------------------------------------------------

class TestFederation:
    @respx.mock
    def test_list_federation_peers(self) -> None:
        respx.get(f"{BASE_URL}/memory/federation/peers").mock(
            return_value=httpx.Response(200, json={"peers": []})
        )
        assert _client().list_federation_peers()["peers"] == []

    @respx.mock
    def test_list_pending_federation_peers(self) -> None:
        respx.get(f"{BASE_URL}/memory/federation/peers/pending").mock(
            return_value=httpx.Response(
                200, json={"peers": [], "discovery": {"enabled": True, "reason": "auto"}}
            )
        )
        result = _client().list_pending_federation_peers()
        assert result["discovery"]["enabled"] is True

    @respx.mock
    def test_approve_federation_peer_sends_post(self) -> None:
        route = respx.post(f"{BASE_URL}/memory/federation/peers/p1/approve").mock(
            return_value=httpx.Response(204)
        )
        _client().approve_federation_peer("p1", "cert-der-abc")
        body = json.loads(route.calls[0].request.content)
        assert body["newCertDer"] == "cert-der-abc"

    @respx.mock
    def test_approve_federation_peer_key(self) -> None:
        respx.post(f"{BASE_URL}/memory/federation/peers/p1/approve-key").mock(
            return_value=httpx.Response(
                200, json={"approved": True, "peerId": "p1", "approvedAt": "2026-06-17T00:00:00Z"}
            )
        )
        result = _client().approve_federation_peer_key("p1", "cert-der-xyz")
        assert result["approved"] is True
        assert result["peerId"] == "p1"

    @respx.mock
    def test_delete_federation_peer(self) -> None:
        respx.delete(f"{BASE_URL}/memory/federation/peers/p1").mock(
            return_value=httpx.Response(200, json={"deleted": True, "peerId": "p1"})
        )
        result = _client().delete_federation_peer("p1")
        assert result["deleted"] is True

    @respx.mock
    def test_list_federation_items_with_since(self) -> None:
        route = respx.get(f"{BASE_URL}/memory/federation/items").mock(
            return_value=httpx.Response(200, json={"items": [], "nextCursor": None})
        )
        _client().list_federation_items(since="2026-01-01T00:00:00Z", limit=20)
        assert "since=" in str(route.calls[0].request.url)
        assert "limit=20" in str(route.calls[0].request.url)

    @respx.mock
    def test_trigger_federation_sync(self) -> None:
        route = respx.post(f"{BASE_URL}/memory/federation/sync").mock(
            return_value=httpx.Response(202, json={"jobId": "job-1", "status": "pending"})
        )
        result = _client().trigger_federation_sync("peer-1")
        assert result["jobId"] == "job-1"
        body = json.loads(route.calls[0].request.content)
        assert body["peerId"] == "peer-1"

    @respx.mock
    def test_get_federation_sync_job(self) -> None:
        respx.get(f"{BASE_URL}/memory/federation/sync/job-1").mock(
            return_value=httpx.Response(
                200,
                json={"jobId": "job-1", "status": "done", "peerId": "p1", "createdAt": "…"},
            )
        )
        result = _client().get_federation_sync_job("job-1")
        assert result["status"] == "done"

    @respx.mock
    def test_resolve_federation_conflict(self) -> None:
        route = respx.post(f"{BASE_URL}/memory/federation/resolve").mock(
            return_value=httpx.Response(
                200,
                json={
                    "winner": {"id": "f1", "content": "a", "version": 2, "worth": 0.9},
                    "strategy": "trust_anchor",
                    "resolvedAt": "2026-06-17T00:00:00Z",
                },
            )
        )
        result = _client().resolve_federation_conflict(
            itemA={"id": "f1", "content": "a", "version": 2},
            itemB={"id": "f1", "content": "b", "version": 1},
        )
        assert result["strategy"] == "trust_anchor"
        body = json.loads(route.calls[0].request.content)
        assert "itemA" in body


# ---------------------------------------------------------------------------
# Async variants — spot-check a few to confirm async _request works
# ---------------------------------------------------------------------------

class TestAsync:
    @respx.mock
    async def test_async_create_fact(self) -> None:
        route = respx.post(f"{BASE_URL}/remember").mock(
            return_value=httpx.Response(201, json={"id": "f1", "statement": "hello"})
        )
        async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            result = await c.create_fact("hello")
        assert result["id"] == "f1"
        assert result["content"] == "hello"
        assert route.calls[0].request.headers["authorization"] == _auth_header()

    @respx.mock
    async def test_async_list_federation_peers(self) -> None:
        respx.get(f"{BASE_URL}/memory/federation/peers").mock(
            return_value=httpx.Response(200, json={"peers": [{"id": "p1"}]})
        )
        async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            result = await c.list_federation_peers()
        assert result["peers"][0]["id"] == "p1"

    @respx.mock
    async def test_async_trigger_federation_sync(self) -> None:
        route = respx.post(f"{BASE_URL}/memory/federation/sync").mock(
            return_value=httpx.Response(202, json={"jobId": "j2", "status": "pending"})
        )
        async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
            result = await c.trigger_federation_sync("p2")
        assert result["jobId"] == "j2"
        body = json.loads(route.calls[0].request.content)
        assert body["peerId"] == "p2"

    @respx.mock
    async def test_async_4xx_raises_api_error(self) -> None:
        respx.get(f"{BASE_URL}/facts/missing").mock(
            return_value=httpx.Response(
                404, json={"error": {"message": "not found", "code": "ERR_NOT_FOUND"}}
            )
        )
        with pytest.raises(MnemosyneAPIError) as exc_info:
            async with AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY) as c:
                await c.get_fact("missing")
        assert exc_info.value.status == 404
        assert exc_info.value.code == "ERR_NOT_FOUND"
