import httpx
from mnemo import MnemosyneClient
from mnemo.types import MnemosyneAPIError, MnemosyneTimeoutError
import pytest


def test_retries_on_503_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", headers=client._headers, transport=transport)
    out = client._request("GET", "/health")
    assert out == {"ok": True}
    assert calls["n"] == 3


def test_does_not_retry_on_400():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": {"message": "bad"}})

    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", headers=client._headers, transport=httpx.MockTransport(handler))
    try:
        client._request("GET", "/health")
        assert False, "should have raised"
    except Exception:
        pass
    assert calls["n"] == 1


def test_unkeyed_patch_is_not_replayed():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, json={"error": {"message": "failed"}})

    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneAPIError) as caught:
        client.patch_fact("f-1", statement="changed")
    assert calls["n"] == 1
    assert caught.value.outcome_unknown is True


def test_canonical_error_details_are_exposed():
    client = MnemosyneClient(url="http://test", api_key="k")
    response = httpx.Response(400, json={"error": {"code": "validation_error", "message": "bad", "request_id": "r-1", "retryable": False, "details": {"issues": [{"path": "query"}]}}})
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(lambda _: response))
    with pytest.raises(MnemosyneAPIError) as caught:
        client.recall("q")
    assert caught.value.request_id == "r-1"
    assert caught.value.details["issues"][0]["path"] == "query"
    assert caught.value.retryable is False


def test_workspace_and_session_are_sent_on_remember():
    seen = {}
    def handler(request: httpx.Request) -> httpx.Response:
        seen["workspace"] = request.headers.get("x-workspace-id")
        seen["body"] = request.content
        return httpx.Response(201, json={"id": "f1", "statement": "hello"})
    client = MnemosyneClient(url="http://test", api_key="k", workspace_id="ws-2")
    client._http = httpx.Client(base_url="http://test", headers=client._headers, transport=httpx.MockTransport(handler))
    client.create_fact("hello", session_id="s-1")
    assert seen["workspace"] == "ws-2"
    assert b'"sessionId":"s-1"' in seen["body"]


def test_recall_sends_session_id():
    seen = {}
    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content
        return httpx.Response(200, json={"hits": []})
    client = MnemosyneClient(url="http://test", api_key="k")
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    client.recall("q", session_id="s-1")
    assert b'"sessionId":"s-1"' in seen["body"]


def test_safe_get_retries_a_connection_error():
    calls = {"n": 0}
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("refused")
        return httpx.Response(200, json={"ok": True})
    client = MnemosyneClient(url="http://test", api_key="k", max_retries=1)
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    assert client._request("GET", "/health") == {"ok": True}
    assert calls["n"] == 2


def test_retryable_false_prevents_replay():
    calls = {"n": 0}
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"message": "unavailable", "retryable": False}})
    client = MnemosyneClient(url="http://test", api_key="k")
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneAPIError):
        client._request("GET", "/health")
    assert calls["n"] == 1


def test_workspace_binding_preserves_user_agent_suffix():
    original = MnemosyneClient(url="http://test", api_key="k", user_agent_suffix="agent")
    bound = original.for_workspace("ws-2")
    assert bound._headers["User-Agent"] == original._headers["User-Agent"]


def test_timeout_is_typed_and_terminal():
    calls = {"n": 0}
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ReadTimeout("slow")
    client = MnemosyneClient(url="http://test", api_key="k")
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneTimeoutError):
        client._request("GET", "/health")
    assert calls["n"] == 1


def test_keyed_mutation_is_replayed_on_503():
    calls = {"n": 0}
    keys = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        keys.append(request.headers.get("Idempotency-Key"))
        if calls["n"] < 3:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        return httpx.Response(204)

    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    client.forget_fact("f-1", idempotency_key="key-1")
    assert calls["n"] == 3
    assert keys == ["key-1"] * 3


def test_keyed_mutation_timeout_is_outcome_unknown():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("committed then stalled", request=request)

    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneTimeoutError) as caught:
        client.forget_fact("f-1", idempotency_key="key-1")
    assert caught.value.outcome_unknown is True


def test_malformed_success_body_on_mutation_is_typed_and_not_replayed():
    from mnemo.types import MnemosyneResponseError

    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, content=b'{"id": "f-', headers={"content-type": "application/json"})

    client = MnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.Client(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneResponseError) as caught:
        client._request("POST", "/remember", json={"statement": "x"})
    assert calls["n"] == 1
    assert caught.value.outcome_unknown is True
    with pytest.raises(MnemosyneResponseError) as read:
        client._request("GET", "/health")
    assert read.value.outcome_unknown is False


async def test_async_malformed_success_body_is_typed():
    from mnemo import AsyncMnemosyneClient
    from mnemo.types import MnemosyneResponseError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"{oops", headers={"content-type": "application/json"})

    client = AsyncMnemosyneClient(url="http://test", api_key="k", max_retries=3)
    client._http = httpx.AsyncClient(base_url="http://test", transport=httpx.MockTransport(handler))
    with pytest.raises(MnemosyneResponseError) as caught:
        await client._request("POST", "/remember", json={"statement": "x"})
    assert caught.value.outcome_unknown is True
