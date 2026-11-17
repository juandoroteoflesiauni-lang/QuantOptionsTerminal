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

try:
    import requests as _requests_module
except ImportError:  # pragma: no cover - pyhomebroker ships requests
    _requests_module = None

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


SESSION_COOKIE_FIXTURE_PATH = TOOL_DIR.parent / "fixtures" / "bmb_session_cookie.json"


def load_session_cookie_fixture() -> dict[str, Any]:
    return json.loads(SESSION_COOKIE_FIXTURE_PATH.read_text(encoding="utf-8"))


def make_state() -> Any:
    cfg = {
        "broker_id": 153,
        "dni": "20123456789",
        "username": "test-user",
        "password": "test-password",
        "account": "test-account",
        "session_cookie": "fake_session_cookie=a1b2c3d4",
        "host": "127.0.0.1",
        "port": 8788,
        "leaders": ("GGAL",),
        "secrets": (
            "20123456789",
            "test-user",
            "test-password",
            "test-account",
            "fake_session_cookie=a1b2c3d4",
        ),
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


class FakeAuthClient:
    """Fake `hb.auth` con semántica mínima de la librería (offline)."""

    def __init__(self) -> None:
        self.is_user_logged_in = False
        self.cookies: dict[str, str] = {}
        self.login_calls = 0
        self.login_error: Exception | None = None

    def login(self, **_kwargs: Any) -> None:
        self.login_calls += 1
        if self.login_error is not None:
            self.is_user_logged_in = False
            raise self.login_error
        self.is_user_logged_in = True


class FakeOnlineClient:
    """Fake `hb.online` con semántica mínima de la librería (offline)."""

    def __init__(self, connect_error: Exception | None = None, connected: bool = True) -> None:
        self.connect_error = connect_error
        self._connected = False
        self.connected_after_connect = connected
        self.connect_calls = 0
        self.subscriptions: list[tuple[Any, ...]] = []

    def connect(self) -> None:
        self.connect_calls += 1
        if self.connect_error is not None:
            # El rechazo del stream con cookie agota ese único intento;
            # los connects posteriores (post-login) ya no fallan por esto.
            error = self.connect_error
            self.connect_error = None
            raise error
        self._connected = self.connected_after_connect

    def is_connected(self) -> bool:
        return self._connected

    def subscribe_securities(self, *args: Any) -> None:
        self.subscriptions.append(("securities", *args))

    def subscribe_repos(self) -> None:
        self.subscriptions.append(("repos",))

    def subscribe_options(self) -> None:
        self.subscriptions.append(("options",))

    def subscribe_order_book(self, *args: Any) -> None:
        self.subscriptions.append(("orderbook", *args))


def make_cookie_fake_hb(
    connect_error: Exception | None = None,
    connected: bool = True,
) -> tuple[Any, FakeAuthClient, FakeOnlineClient]:
    auth = FakeAuthClient()
    online = FakeOnlineClient(connect_error=connect_error, connected=connected)

    def fake_home_broker(*_args: Any, **_kwargs: Any) -> Any:
        return SimpleNamespace(auth=auth, online=online)

    module.HomeBroker = fake_home_broker
    module.PYHOMEBROKER_AVAILABLE = True
    return SimpleNamespace(auth=auth, online=online), auth, online


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


def test_session_cookie_parsing_matches_reference_fixture() -> None:
    fixture = load_session_cookie_fixture()
    for case in fixture["parseCases"]:
        actual = base.parse_bmb_session_cookie(case["raw"])
        expected = tuple(tuple(pair) for pair in case["expectedPairs"])
        assert actual == expected, f"case {case['name']}: {actual} != {expected}"


def test_session_cookie_injection_sets_domains_and_user_agent() -> None:
    fixture = load_session_cookie_fixture()
    assert _requests_module is not None, "requests es dependencia de pyhomebroker"
    for case in fixture["parseCases"]:
        if "expectedJarEntries" not in case:
            continue
        jar = _requests_module.cookies.RequestsCookieJar()
        session = SimpleNamespace(cookies=jar, headers={})
        entries = base.inject_bmb_session_cookies(session, case["raw"])
        assert entries == len(case["expectedJarEntries"]), f"case {case['name']}"
        for name, value, domain, path in case["expectedJarEntries"]:
            match = any(
                cookie.name == name
                and cookie.value == value
                and cookie.domain == domain
                and cookie.path == path
                for cookie in jar
            )
            assert match, f"case {case['name']}: missing {name}@{domain}"
        assert base.configure_bmb_browser_session(session) is True
        assert session.headers["User-Agent"] == fixture["browserUserAgent"]


def test_trusted_device_domains_cover_both_bull_market_families() -> None:
    fixture = load_session_cookie_fixture()
    domains = list(fixture["trustedDeviceDomains"])
    # Ambas familias de dominio: plataforma homebroker y portal de inversiones.
    assert any(d.endswith("bullmarketbrokers.com") for d in domains)
    assert any(d.endswith("bullmarket.com.ar") for d in domains)
    # Host específico y dominio padre (con punto) para cada familia.
    assert "hb.bullmarketbrokers.com" in domains
    assert ".bullmarketbrokers.com" in domains
    assert "inversiones.bullmarket.com.ar" in domains
    assert ".bullmarket.com.ar" in domains


def test_implementation_domains_match_reference_fixture() -> None:
    fixture = load_session_cookie_fixture()
    assert tuple(base.BMB_TRUSTED_DEVICE_DOMAINS) == tuple(fixture["trustedDeviceDomains"])


def test_injection_applies_cookie_to_every_trusted_domain() -> None:
    fixture = load_session_cookie_fixture()
    assert _requests_module is not None
    jar = _requests_module.cookies.RequestsCookieJar()
    session = SimpleNamespace(cookies=jar, headers={})
    raw = "fake_session_cookie=a1b2c3d4"
    entries = base.inject_bmb_session_cookies(session, raw)
    # Un par → una entrada por cada dominio de confianza (host + padre, x2 familias).
    assert entries == len(fixture["trustedDeviceDomains"])
    for domain in fixture["trustedDeviceDomains"]:
        match = any(
            cookie.name == "fake_session_cookie"
            and cookie.value == "a1b2c3d4"
            and cookie.domain == domain
            and cookie.path == "/"
            for cookie in jar
        )
        assert match, f"cookie ausente para el dominio {domain}"


def test_read_bmb_env_loads_session_cookie_and_redacts_it() -> None:
    env = {
        "BMB_BROKER_ID": "153",
        "BMB_DNI": " 12.345.678 ",
        "BMB_USER": "sample-user",
        "BMB_PASSWORD": "sample-password",
        "BMB_SESSION_COOKIE": "  fake_session_cookie=a1b2c3d4; ASP.NET_SessionId=xyz  ",
        "BMB_ACCOUNT": "sample-account",
    }
    cfg = base.read_bmb_env(env)
    assert cfg["session_cookie"] == "fake_session_cookie=a1b2c3d4; ASP.NET_SessionId=xyz"
    assert cfg["session_cookie"] in cfg["secrets"]
    # El valor crudo (con bordes con espacios) también queda en la redacción.
    assert env["BMB_SESSION_COOKIE"] in cfg["secrets"]
    absent = base.read_bmb_env({"BMB_BROKER_ID": "153"})
    assert absent["session_cookie"] == ""


def test_apply_trusted_device_context_loads_auth_cookies_and_ua_labels_only() -> None:
    fixture = load_session_cookie_fixture()
    raw = "fake_session_cookie=a1b2c3d4; ASP.NET_SessionId=xyz123"
    auth = FakeAuthClient()
    online = FakeOnlineClient()
    context = base.apply_bmb_trusted_device_context(auth, online, raw)
    expected_pairs = base.parse_bmb_session_cookie(raw)
    assert context["authCookiesLoaded"] == len(expected_pairs)
    assert auth.cookies == dict(expected_pairs)
    # Solo etiquetas/conteos: ningún valor de cookie en el contexto.
    serialized = json.dumps(context)
    for _name, value in expected_pairs:
        assert value not in serialized
    # UA moderno aplicado a los globals de módulos de la librería (si instalada).
    if context["uaModulesUpdated"]:
        for module_name in context["uaModulesUpdated"]:
            assert sys.modules[module_name].user_agent == fixture["browserUserAgent"]


def test_online_cookie_reuse_success_skips_login() -> None:
    state = make_state()
    hb, auth, online = make_cookie_fake_hb(connected=True)
    state._connect_once()
    assert online.connect_calls == 1
    assert auth.login_calls == 0, "con cookie activa no debe ejecutar login"
    assert auth.is_user_logged_in is True
    assert auth.cookies == dict(base.parse_bmb_session_cookie(state._cfg["session_cookie"]))
    assert state._connected is True
    assert state._status in {"READY", "CONNECTED_L2"}
    assert len(online.subscriptions) > 0


def test_online_cookie_reuse_falls_back_to_login_when_server_requires_login() -> None:
    state = make_state()
    hb, auth, online = make_cookie_fake_hb(
        connect_error=RuntimeError("login required: session expired"),
        connected=False,
    )
    state._connect_once()
    assert online.connect_calls == 2, "1 intento con cookie + 1 connect post-login"
    assert auth.login_calls == 1, "ante 'requiere login' cae a hb.auth.login"
    assert auth.is_user_logged_in is True
    # Las cookies de dispositivo de confianza permanecen cargadas en la sesión.
    assert auth.cookies == dict(base.parse_bmb_session_cookie(state._cfg["session_cookie"]))
    assert state._connected is True
    assert state._status in {"READY", "CONNECTED_L2"}


def test_online_cookie_reuse_falls_back_when_stream_not_open() -> None:
    state = make_state()
    hb, auth, online = make_cookie_fake_hb(connected=False)
    state._connect_once()
    assert online.connect_calls == 2, "retry de connect tras el login"
    assert auth.login_calls == 1
    assert state._connected is True
    assert state._status in {"READY", "CONNECTED_L2"}


def test_cookie_stream_error_is_redacted_and_never_leaks_cookie() -> None:
    state = make_state()
    cookie = state._cfg["session_cookie"]
    hb, auth, online = make_cookie_fake_hb(connected=False)
    online.connect_error = RuntimeError(f"HTTP 401 rejected cookie {cookie}")

    ready = state._connect_online_with_session_cookie(hb)

    assert ready is False
    assert auth.is_user_logged_in is False, "flag honesto restaurado ante fallo"
    assert cookie not in str(state._error)
    assert "[REDACTED]" in str(state._error)


def test_health_and_snapshot_never_contain_session_cookie() -> None:
    state = make_state()
    cookie = state._cfg["session_cookie"]
    # Adversarial: un error crudo se cuela al estado; las salidas de salud
    # deben redactarlo de todos modos.
    state._error = f"stream rejected cookie {cookie}"
    state._status = "READY"
    state._connected = True
    payload = json.dumps(state.get_health()) + json.dumps(state.get_snapshot())
    assert cookie not in payload


def test_bridge_without_session_cookie_goes_straight_to_login() -> None:
    state = make_state()
    state._cfg["session_cookie"] = ""
    hb, auth, online = make_cookie_fake_hb(connected=True)
    state._connect_once()
    assert online.connect_calls == 1, "sin cookie: connect normal post-login"
    assert auth.login_calls == 1
    assert state._connected is True
    assert state._status in {"READY", "CONNECTED_L2"}


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"tools/test_bmb_bridge_reconnect.py: {len(tests)} tests passed")
