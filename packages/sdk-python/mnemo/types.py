"""
Type definitions for the Mnemosyne HTTP API.

These are plain TypedDicts / dataclasses mirroring the server's wire shapes.
Python 3.9-compatible: uses Union[X, Y], Optional[X], and
``from __future__ import annotations`` for forward references.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Union


class MnemosyneError(Exception):
    """Base class for all Mnemosyne SDK errors."""

    outcome_unknown = False


class MnemosyneAPIError(MnemosyneError):
    """Raised when the server returns a non-2xx response."""

    def __init__(
        self,
        status: int,
        message: str,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        body: Any = None,
        details: Any = None,
        retryable: Optional[bool] = None,
        retry_after_seconds: Optional[float] = None,
    ) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.code = code
        self.request_id = request_id
        self.body = body
        self.details = details
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


class MnemosyneNetworkError(MnemosyneError):
    """Raised when a network-level error prevents the request."""


class MnemosyneResponseError(MnemosyneError):
    """Raised when a successful response body cannot be decoded.

    For a mutation the write may already have committed: check ``outcome_unknown``.
    """


class MnemosyneTimeoutError(MnemosyneNetworkError):
    """Raised when a request exceeds its configured timeout."""
