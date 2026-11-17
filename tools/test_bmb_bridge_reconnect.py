#!/usr/bin/env python3
"""Unit test for the Pieza 33 BMB bridge reconnect signal (no network, no secrets).

Covers:
- reconnect signal semantics (Pieza 33);
- login-failure classification into `STANDBY_2FA` vs `ERROR`, against the
  independent reference fixture `fixtures/bmb_2fa_standby.json`;
- `BMB_DNI` digit cleaning and the `BMB_USER` alias (synthetic values only);
- the reconnect loop stopping after a single attempt on `STANDBY_2FA`.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))
MODULE_PATH = TOOL_DIR / "bmb_bridge.py"
spec = importlib.util.spec_from_file_location("bmb_bridge_under_test", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

# bmb_bridge imports the base bridge as a normal module; reuse that same object
# so the pure helpers match the ones the state under test actually uses.
base = sys.modules["bmb_homebroker_bridge"]

FIXTURE_PATH = TOOL_DIR.parent / "fixtures" / "bmb_2fa_standby.json"


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def make_state() -> Any:
    cfg = {
        "broker_id": 153,
        "dni": "20123456789",
        "username": "test-user",
        "password": "test-password",
        "account": "test-account",
        "host": "127.0.0.1",
        "port": 8788,
        "leaders": ("GGAL",),
        "secrets": ("20123456789", "test-user", "test-password", "test-account"),
    }
    return module.BmbBridgeState(cfg)


def fake_online() -> Any:
    return SimpleNamespace(
        connect=lambda: None,
        subscribe_securities=lambda *_args: None,
        subscribe_repos=lambda: None,
        subscribe_options=lambda: None,
        subscribe_order_book=lambda *_args: None,
    )


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

    def fake_home_broker(*_args: Any, **_kwargs: Any) -> Any:
        return SimpleNamespace(auth=SimpleNamespace(login=lambda **_kwargs: None), online=fake_online())

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


def test_classification_matches_reference_fixture() -> None:
    fixture = load_fixture()
    for case in fixture["classification"]:
        actual = base.classify_bmb_login_failure(
            case["message"],
            case["responseUrl"],
            500,
            case["dni"],
            case["username"],
        )
        assert actual == case["expected"], f"case {case['name']}: {actual} != {case['expected']}"


def test_dni_cleaning_matches_reference_fixture() -> None:
    fixture = load_fixture()
    for case in fixture["dniCleaning"]:
        assert base.clean_bmb_dni(case["raw"]) == case["expected"], f"case {case['name']}"


def test_marker_negatives_match_reference_fixture() -> None:
    fixture = load_fixture()
    for case in fixture["markerNegatives"]:
        actual = base.bmb_text_indicates_two_factor(case["message"], case["responseUrl"])
        assert actual is case["expected"], f"case {case['name']}: {actual} != {case['expected']}"


def test_read_bmb_env_cleans_dni_and_reads_user_alias() -> None:
    env = {
        "BMB_BROKER_ID": "153",
        "BMB_DNI": " 12.345.678 ",
        "BMB_USER": "sample-user",
        "BMB_PASSWORD": "sample-password",
        "BMB_ACCOUNT": "sample-account",
    }
    cfg = base.read_bmb_env(env)
    assert cfg["dni"] == "12345678"
    assert cfg["username"] == "sample-user"
    assert cfg["password"] == "sample-password"
    assert cfg["broker_id"] == 153
    # El DNI crudo (con separadores) también queda cubierto por la redacción
    # (redact_secrets lo recorta antes de reemplazar).
    assert " 12.345.678 " in cfg["secrets"]
    assert "12345678" in cfg["secrets"]


def test_login_failure_with_valid_format_is_standby_2fa_with_fixed_message() -> None:
    state = make_state()
    fixture = load_fixture()
    exc = RuntimeError("Session cannot be created. Check the entered information and try again.")
    status, safe_error = state._classify_login_failure(exc)
    assert status == "STANDBY_2FA"
    assert safe_error == fixture["standby2faMessage"]
    for secret in state._cfg["secrets"]:
        assert secret not in safe_error


def test_login_exception_with_twofactor_response_url_is_standby_and_never_leaks_url() -> None:
    state = make_state()
    fixture = load_fixture()
    exc = RuntimeError("Session cannot be created. Check the entered information and try again.")
    exc.response = SimpleNamespace(
        url="https://homebroker.invalid/Login/TwoFactor?step=verify",
        status_code=500,
    )
    status, safe_error = state._classify_login_failure(exc)
    assert status == "STANDBY_2FA"
    assert safe_error == fixture["standby2faMessage"]
    assert "TwoFactor" not in safe_error
    assert "homebroker.invalid" not in safe_error


def test_login_failure_with_invalid_format_is_redacted_error() -> None:
    state = make_state()
    state._cfg["dni"] = ""
    exc = RuntimeError("Session cannot be created. Check the entered information and try again.")
    status, safe_error = state._classify_login_failure(exc)
    assert status == "ERROR"
    assert "[REDACTED]" not in safe_error or safe_error.startswith("BMB login error:")
    for secret in state._cfg["secrets"]:
        assert secret not in safe_error


def test_start_stops_retry_loop_on_standby_2fa() -> None:
    state = make_state()
    fixture = load_fixture()
    attempts = {"login": 0}

    def fake_home_broker(*_args: Any, **_kwargs: Any) -> Any:
        def login(**_kwargs: Any) -> None:
            attempts["login"] += 1
            raise RuntimeError("Session cannot be created. Check the entered information and try again.")

        return SimpleNamespace(auth=SimpleNamespace(login=login), online=fake_online())

    module.HomeBroker = fake_home_broker
    module.PYHOMEBROKER_AVAILABLE = True

    state.start()

    assert attempts["login"] == 1, "no debe reintentar login en bucle ante STANDBY_2FA"
    assert state._status == "STANDBY_2FA"
    assert state._error == fixture["standby2faMessage"]
    assert state._connected is False


def test_get_health_reports_standby_2fa_as_not_ok() -> None:
    state = make_state()
    state._status = "STANDBY_2FA"
    health = state.get_health()
    assert health["status"] == "STANDBY_2FA"
    assert health["ok"] is False
    assert health["connected"] is False


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"tools/test_bmb_bridge_reconnect.py: {len(tests)} tests passed")
