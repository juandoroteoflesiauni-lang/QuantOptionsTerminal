"""Global offline enforcement for pytest.

Blocks all real outbound TCP sockets (except Windows ``asyncio``'s internal
loopback ``socketpair()`` wake-up pipe) and all non-mocked ``httpx`` transports
so that ``pytest`` runs 100% deterministically offline even when ``UV_OFFLINE=1``
is set. Only ``httpx.MockTransport`` is permitted for HTTP calls during tests.
"""

from __future__ import annotations

import contextvars
import socket
from typing import Any

import httpx
import pytest

_IN_SOCKETPAIR: contextvars.ContextVar[bool] = contextvars.ContextVar("_IN_SOCKETPAIR", default=False)


@pytest.fixture(autouse=True)
def _block_live_network(monkeypatch: pytest.MonkeyPatch) -> None:
    orig_connect = socket.socket.connect
    orig_connect_ex = socket.socket.connect_ex
    orig_socketpair = socket.socketpair

    def _safe_socketpair(*args: Any, **kwargs: Any) -> Any:
        token = _IN_SOCKETPAIR.set(True)
        try:
            return orig_socketpair(*args, **kwargs)
        finally:
            _IN_SOCKETPAIR.reset(token)

    def _deny_create_connection(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError(
            "Real outbound socket connections are strictly prohibited during pytest offline suite."
        )

    def _guarded_connect(self: socket.socket, address: Any) -> Any:
        if _IN_SOCKETPAIR.get():
            return orig_connect(self, address)
        raise AssertionError(
            f"Real outbound socket connect blocked during pytest: {address!r}"
        )

    def _guarded_connect_ex(self: socket.socket, address: Any) -> Any:
        if _IN_SOCKETPAIR.get():
            return orig_connect_ex(self, address)
        raise AssertionError(
            f"Real outbound socket connect_ex blocked during pytest: {address!r}"
        )

    def _deny_http_transport(self: Any, request: httpx.Request) -> httpx.Response:
        raise AssertionError(
            f"Real httpx.HTTPTransport call blocked during pytest: {request.method} {request.url.path}"
        )

    async def _deny_async_http_transport(self: Any, request: httpx.Request) -> httpx.Response:
        raise AssertionError(
            f"Real httpx.AsyncHTTPTransport call blocked during pytest: {request.method} {request.url.path}"
        )

    monkeypatch.setattr(socket, "socketpair", _safe_socketpair)
    monkeypatch.setattr(socket, "create_connection", _deny_create_connection)
    monkeypatch.setattr(socket.socket, "connect", _guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _guarded_connect_ex)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _deny_http_transport)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _deny_async_http_transport)
