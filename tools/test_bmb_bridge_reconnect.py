#!/usr/bin/env python3
"""Unit test for the Pieza 33 BMB bridge reconnect signal (no network, no secrets)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

TOOL_DIR = Path(__file__).resolve().parent
MODULE_PATH = TOOL_DIR / "bmb_bridge.py"
spec = importlib.util.spec_from_file_location("bmb_bridge_under_test", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def make_state() -> Any:
    cfg = {
        "broker_id": 153,
        "dni": "test-dni",
        "username": "test-user",
        "password": "test-password",
        "account": "test-account",
        "host": "127.0.0.1",
        "port": 8788,
        "leaders": ("GGAL",),
        "secrets": ("test-dni", "test-user", "test-password", "test-account"),
    }
    return module.BmbBridgeState(cfg)


def test_request_reconnect_closes_session_and_sets_flag() -> None:
    state = make_state()
    disconnect_calls: list[str] = []

    class FakeOnline:
        def disconnect(self) -> None:
            disconnect_calls.append("disconnect")

    class FakeHomeBroker:
        online = FakeOnline()

    state._hb = FakeHomeBroker()
    state._connected = True
    state._status = "READY"

    state.request_reconnect()

    assert disconnect_calls == ["disconnect"]
    assert state._hb is None
    assert state._reconnect_requested is True
    assert state._connected is False
    assert state._status == "DISCONNECTED"


def test_connect_once_consumes_requested_flag() -> None:
    state = make_state()

    online = SimpleNamespace(
        connect=lambda: None,
        subscribe_securities=lambda *_args: None,
        subscribe_repos=lambda: None,
        subscribe_options=lambda: None,
        subscribe_order_book=lambda *_args: None,
    )

    def fake_home_broker(*_args: Any, **_kwargs: Any) -> Any:
        return SimpleNamespace(auth=SimpleNamespace(login=lambda **_kwargs: None), online=online)

    module.HomeBroker = fake_home_broker
    module.PYHOMEBROKER_AVAILABLE = True
    state._reconnect_requested = True

    state._connect_once()

    assert state._reconnect_requested is False
    assert state._connected is True
    assert state._status in {"READY", "CONNECTED_L2"}


def test_redacted_reconnect_error_never_contains_secrets() -> None:
    state = make_state()

    class FakeOnline:
        def disconnect(self) -> None:
            raise RuntimeError("close failed with test-password")

    class FakeHomeBroker:
        online = FakeOnline()

    state._hb = FakeHomeBroker()
    state.request_reconnect()
    assert "test-password" not in str(state._error)
    assert "[REDACTED]" in str(state._error)


if __name__ == "__main__":
    test_request_reconnect_closes_session_and_sets_flag()
    test_connect_once_consumes_requested_flag()
    test_redacted_reconnect_error_never_contains_secrets()
    print("tools/test_bmb_bridge_reconnect.py: 3 tests passed")
