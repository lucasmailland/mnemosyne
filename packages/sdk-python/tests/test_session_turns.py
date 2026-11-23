"""Tests for MnemosyneClient.add_turn / pin_session_turn (sync + async).

Uses respx to intercept httpx requests so no real server is needed.
"""
from __future__ import annotations

import pytest
import respx
import httpx

from mnemo import MnemosyneClient, AsyncMnemosyneClient

BASE_URL = "https://memory.test"
API_KEY = "test-key"


def make_sync_client() -> MnemosyneClient:
    return MnemosyneClient(url=BASE_URL, api_key=API_KEY)


def make_async_client() -> AsyncMnemosyneClient:
    return AsyncMnemosyneClient(url=BASE_URL, api_key=API_KEY)


# ---------------------------------------------------------------------------
# Sync client
# ---------------------------------------------------------------------------

class TestSyncAddTurn:
    @respx.mock
    def test_add_turn_basic(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        result = client.add_turn("ses_1", role="user", content="Hello!")
        assert result is None
        assert route.called

    @respx.mock
    def test_add_turn_sends_correct_body(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        client.add_turn("ses_1", role="assistant", content="Noted.")
        sent = route.calls.last.request
        import json
        body = json.loads(sent.content)
        assert body["role"] == "assistant"
        assert body["content"] == "Noted."
        assert "metadata" not in body

    @respx.mock
    def test_add_turn_omits_metadata_when_none(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        client.add_turn("ses_1", role="user", content="No metadata here.")
        sent = route.calls.last.request
        import json
        body = json.loads(sent.content)
        assert "metadata" not in body


class TestSyncPinSessionTurn:
    @respx.mock
    def test_pin_turn(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/pin").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        result = client.pin_session_turn("ses_1", turn_id="turn_abc", pinned=True)
        assert result is None
        assert route.called

    @respx.mock
    def test_pin_turn_sends_correct_body(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/pin").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        client.pin_session_turn("ses_1", turn_id="turn_xyz", pinned=False)
        sent = route.calls.last.request
        import json
        body = json.loads(sent.content)
        assert body == {"turnId": "turn_xyz", "pinned": False}

    @respx.mock
    def test_unpin_turn(self):
        route = respx.post(f"{BASE_URL}/session/ses_1/pin").mock(
            return_value=httpx.Response(204)
        )
        client = make_sync_client()
        client.pin_session_turn("ses_1", turn_id="turn_abc", pinned=False)
        import json
        body = json.loads(route.calls.last.request.content)
        assert body["pinned"] is False


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------

class TestAsyncAddTurn:
    @respx.mock
    @pytest.mark.asyncio
    async def test_add_turn_basic(self):
        route = respx.post(f"{BASE_URL}/session/ses_async/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_async_client()
        result = await client.add_turn("ses_async", role="user", content="Async hello!")
        assert result is None
        assert route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_add_turn_sends_only_role_and_content(self):
        route = respx.post(f"{BASE_URL}/session/ses_async/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_async_client()
        await client.add_turn(
            "ses_async",
            role="assistant",
            content="Remembered.",
        )
        import json
        body = json.loads(route.calls.last.request.content)
        assert body == {"role": "assistant", "content": "Remembered."}

    @respx.mock
    @pytest.mark.asyncio
    async def test_add_turn_no_metadata_when_none(self):
        route = respx.post(f"{BASE_URL}/session/ses_async/turn").mock(
            return_value=httpx.Response(204)
        )
        client = make_async_client()
        await client.add_turn("ses_async", role="user", content="no meta")
        import json
        body = json.loads(route.calls.last.request.content)
        assert "metadata" not in body


class TestAsyncPinSessionTurn:
    @respx.mock
    @pytest.mark.asyncio
    async def test_pin_turn(self):
        route = respx.post(f"{BASE_URL}/session/ses_async/pin").mock(
            return_value=httpx.Response(204)
        )
        client = make_async_client()
        result = await client.pin_session_turn("ses_async", turn_id="turn_1", pinned=True)
        assert result is None
        assert route.called

    @respx.mock
    @pytest.mark.asyncio
    async def test_pin_turn_sends_correct_body(self):
        route = respx.post(f"{BASE_URL}/session/ses_async/pin").mock(
            return_value=httpx.Response(204)
        )
        client = make_async_client()
        await client.pin_session_turn("ses_async", turn_id="turn_99", pinned=False)
        import json
        body = json.loads(route.calls.last.request.content)
        assert body == {"turnId": "turn_99", "pinned": False}
