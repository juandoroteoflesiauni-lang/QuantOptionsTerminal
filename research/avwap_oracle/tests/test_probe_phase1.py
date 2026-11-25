"""Synthetic unit tests for avwap_oracle.probe_phase1 (zero real network requests)."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import httpx
import pytest

from avwap_oracle.probe_phase1 import (
    AuthorizedCredentials,
    FALLBACK_DELISTED_DATE,
    ProbeHttpClient,
    SecretSanitizer,
    _bar_to_rth_info,
    build_fmp_url,
    classify_field_value,
    classify_scale_ratio,
    extract_us_equity_universe,
    inspect_nyse_calendar,
    load_authorized_credentials,
    parse_retry_after_seconds,
    probe_massive_suite,
    safe_ratio,
    select_delisted_probe_date,
)


def _make_creds() -> AuthorizedCredentials:
    fmp = "FMP_SECRET_XYZ_123"
    m2 = "MASSIVE_SECRET_ABC_456"
    orats = "ORATS_SECRET_DEF_789"
    return AuthorizedCredentials(
        fmp_key=fmp,
        massive_key_2=m2,
        orats_api_key=orats,
        audit={"env_file_found": True, "fmp": {"selected_var_name": "FMP_API_KEY", "ambiguity_detected": False}},
        sanitizer=SecretSanitizer([fmp, m2, orats]),
    )


def test_secret_sanitization_urls_and_exceptions() -> None:
    creds = _make_creds()
    sanitizer = creds.sanitizer
    raw_url = "https://api.massive.com/v2/aggs/ticker/NVDA?adjusted=false&apikey=MASSIVE_SECRET_ABC_456"
    cleaned = sanitizer.sanitize_text(raw_url)
    assert "MASSIVE_SECRET_ABC_456" not in cleaned
    assert "<REDACTED>" in cleaned

    exc = httpx.ConnectError(f"Failed GET https://api.orats.io/datav2/hist/cores?token={creds.orats_api_key}")
    cleaned_exc = sanitizer.sanitize_exception(exc)
    assert creds.orats_api_key not in cleaned_exc
    assert "ConnectError" in cleaned_exc

    params = sanitizer.sanitize_params({"symbol": "AAPL", "apikey": creds.fmp_key, "token": "other"})
    assert params == {"symbol": "AAPL"}


def test_build_fmp_url_avoids_duplicate_stable() -> None:
    assert build_fmp_url("earnings") == "https://financialmodelingprep.com/stable/earnings"
    assert build_fmp_url("/stable/earnings") == "https://financialmodelingprep.com/stable/earnings"
    assert build_fmp_url("stable/splits") == "https://financialmodelingprep.com/stable/splits"


def test_http_200_ok_data_and_ok_empty() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/earnings"):
            return httpx.Response(200, json=[{"symbol": "AAPL", "date": "2026-10-30"}])
        return httpx.Response(200, json=[])

    creds = _make_creds()
    with ProbeHttpClient(creds, transport=httpx.MockTransport(handler)) as client:
        ok = client.get_json("fmp", "earnings", {"symbol": "AAPL"})
        empty = client.get_json("fmp", "splits", {"symbol": "AAPL"})

    assert ok.record["http_status"] == 200
    assert ok.record["result_status"] == "OK_DATA"
    assert ok.record["record_count"] == 1
    assert empty.record["http_status"] == 200
    assert empty.record["result_status"] == "OK_EMPTY"
    assert empty.record["record_count"] == 0


def test_http_200_application_level_errors() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        sym = request.url.params.get("symbol")
        if sym == "AUTH":
            return httpx.Response(200, json={"Error Message": "Invalid API KEY provided."})
        if sym == "PLAN":
            return httpx.Response(200, json={"Error Message": "Special Endpoint: Upgrade your subscription plan."})
        return httpx.Response(200, json={"status": "ERROR", "message": "Malformed query parameter"})

    creds = _make_creds()
    with ProbeHttpClient(creds, transport=httpx.MockTransport(handler)) as client:
        r_auth = client.get_json("fmp", "earnings", {"symbol": "AUTH"})
        r_plan = client.get_json("fmp", "earnings", {"symbol": "PLAN"})
        r_other = client.get_json("fmp", "earnings", {"symbol": "OTHER"})

    assert r_auth.record["result_status"] == "AUTH_ERROR"
    assert r_plan.record["result_status"] == "FORBIDDEN"
    assert r_other.record["result_status"] == "SCHEMA_MISMATCH"


def test_http_401_403_404_429_and_retry_after() -> None:
    sleeps: list[float] = []
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "401" in path:
            return httpx.Response(401, text=f"unauthorized {request.url.params.get('apikey')}")
        if "403" in path:
            return httpx.Response(403, text="forbidden")
        if "404" in path:
            return httpx.Response(404, text="not found")
        calls["n"] += 1
        return httpx.Response(429, headers={"Retry-After": "1.5"}, text="rate limited")

    creds = _make_creds()
    with ProbeHttpClient(
        creds,
        transport=httpx.MockTransport(handler),
        sleep_fn=sleeps.append,
        max_retries=2,
    ) as client:
        r401 = client.get_json("massive", "v2/aggs/401")
        r403 = client.get_json("massive", "v2/aggs/403")
        r404 = client.get_json("massive", "v2/aggs/404")
        r429 = client.get_json("massive", "v2/aggs/429")

    assert r401.record["result_status"] == "AUTH_ERROR"
    assert creds.massive_key_2 not in (r401.record["sanitized_error"] or "")
    assert r403.record["result_status"] == "FORBIDDEN"
    assert r404.record["result_status"] == "NOT_FOUND"
    assert r429.record["result_status"] == "RATE_LIMITED"
    assert calls["n"] == 3
    assert sleeps == [1.5, 1.5]
    assert parse_retry_after_seconds("2.5") == 2.5


def test_timeout_and_invalid_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "timeout" in request.url.path:
            raise httpx.ReadTimeout("read timed out", request=request)
        return httpx.Response(200, content=b"{bad json")

    creds = _make_creds()
    with ProbeHttpClient(
        creds,
        transport=httpx.MockTransport(handler),
        sleep_fn=lambda _: None,
        max_retries=1,
    ) as client:
        r_to = client.get_json("orats", "hist/timeout")
        r_bad = client.get_json("orats", "hist/badjson")

    assert r_to.record["result_status"] == "NETWORK_ERROR"
    assert "ReadTimeout" in (r_to.record["sanitized_error"] or "")
    assert r_bad.record["result_status"] == "SCHEMA_MISMATCH"


def test_host_allowlist_blocks_foreign_url() -> None:
    creds = _make_creds()
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["count"] += 1
        return httpx.Response(200, json=[])

    with ProbeHttpClient(creds, transport=httpx.MockTransport(handler)) as client:
        out = client.get_json("fmp", "https://evil.example.com/steal")

    assert out.record["result_status"] == "NETWORK_ERROR"
    assert called["count"] == 0


def test_field_classification_and_safe_ratio() -> None:
    row = {"a": None, "b": 0, "c": 12.5, "d": float("nan"), "e": ""}
    assert classify_field_value(row, "missing")[0] == "FIELD_MISSING"
    assert classify_field_value(row, "a")[0] == "FIELD_NULL"
    assert classify_field_value(row, "b")[0] == "FIELD_ZERO"
    assert classify_field_value(row, "c") == ("FIELD_VALID", 12.5)
    assert classify_field_value(row, "d")[0] == "FIELD_INVALID"
    assert classify_field_value(row, "e")[0] == "FIELD_INVALID"

    assert safe_ratio(100.0, 10.0) == 10.0
    assert safe_ratio(10.0, 0.0) is None
    assert safe_ratio(None, 5.0) is None
    assert safe_ratio(float("inf"), 5.0) is None


def test_utc_et_conversion_and_rth_bar_selection_with_missing_bar() -> None:
    # 2024-06-07 is EDT (UTC-4): 09:29 ET = 13:29 UTC (premarket), 15:58 ET = 19:58 UTC (RTH)
    pre_ms = int(dt.datetime(2024, 6, 7, 13, 29, tzinfo=dt.timezone.utc).timestamp() * 1000)
    rth_ms = int(dt.datetime(2024, 6, 7, 19, 58, tzinfo=dt.timezone.utc).timestamp() * 1000)
    # 2024-11-29 is EST (UTC-5) AND early close 13:00 ET: 13:00 ET = 18:00 UTC excluded, 12:59 ET = 17:59 UTC included
    early_ok_ms = int(dt.datetime(2024, 11, 29, 17, 59, tzinfo=dt.timezone.utc).timestamp() * 1000)
    early_closed_ms = int(dt.datetime(2024, 11, 29, 18, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    early = {"2024-11-29"}

    assert _bar_to_rth_info({"t": pre_ms, "o": 1, "c": 1, "v": 1}, early) is None
    rth_info = _bar_to_rth_info({"t": rth_ms, "o": 1200, "c": 1205, "v": 100, "vw": 1202.5}, early)
    assert rth_info is not None
    assert rth_info["hm_et"] == "15:58"
    assert rth_info["vw_state"] == "FIELD_VALID"
    assert _bar_to_rth_info({"t": early_ok_ms, "o": 1, "c": 1, "v": 1}, early) is not None
    assert _bar_to_rth_info({"t": early_closed_ms, "o": 1, "c": 1, "v": 1}, early) is None

    # Synthetic NVDA split probe where 15:59 ET is missing (uses 15:58 ET and explicitly flags missing 15:59)
    post_ms = int(dt.datetime(2024, 6, 10, 13, 30, tzinfo=dt.timezone.utc).timestamp() * 1000)

    def handler(request: httpx.Request) -> httpx.Response:
        if "2024-06-07/2024-06-10" in request.url.path:
            adj = request.url.params.get("adjusted") == "true"
            if not adj:
                bars = [
                    {"t": pre_ms, "o": 1190.0, "c": 1195.0, "v": 50, "vw": 1192.0},
                    {"t": rth_ms, "o": 1200.0, "c": 1210.0, "v": 100, "vw": 1205.0},
                    {"t": post_ms, "o": 120.0, "c": 121.0, "v": 1000, "vw": 120.5},
                ]
            else:
                bars = [
                    {"t": rth_ms, "o": 120.0, "c": 121.0, "v": 1000, "vw": 120.5},
                    {"t": post_ms, "o": 120.0, "c": 121.0, "v": 1000, "vw": 120.5},
                ]
            return httpx.Response(200, json={"status": "OK", "results": bars})
        return httpx.Response(200, json={"status": "OK", "results": []})

    creds = _make_creds()
    with ProbeHttpClient(creds, transport=httpx.MockTransport(handler)) as client:
        res = probe_massive_suite(client, {"early_close_dates": []})
    nvda = res["details"]["nvda_split_experiment"]
    assert nvda["unadjusted"]["pre_expected_15_59_found"] is False
    assert nvda["unadjusted"]["pre_bar"]["hm_et"] == "15:58"
    assert nvda["unadjusted"]["post_expected_09_30_found"] is True
    assert nvda["pre_split_same_bar_factors"]["price_factor_vw"] == pytest.approx(10.0)


def test_orats_scale_classification() -> None:
    assert classify_scale_ratio(5.5, 0.055) == (pytest.approx(100.0), "SCALE_100X")
    assert classify_scale_ratio(0.25, 25.0) == (pytest.approx(0.01), "SCALE_0_01X")
    assert classify_scale_ratio(120.88, 120.88) == (pytest.approx(1.0), "SAME_SCALE")
    assert classify_scale_ratio(10.0, 2.0) == (pytest.approx(5.0), "OTHER_RATIO")
    assert classify_scale_ratio(25.0, 0.30, comparable=False) == (None, "NOT_COMPARABLE")
    assert classify_scale_ratio(25.0, 0.0) == (None, "UNVERIFIED")


def test_delisted_date_derivation_and_fallback() -> None:
    closed = {"2022-05-30"}  # Memorial Day
    # 2022-06-29 - 30d = 2022-05-30 (holiday) -> 2022-05-29 (Sun) -> 2022-05-28 (Sat) -> 2022-05-27 (Fri)
    derived = select_delisted_probe_date("2022-06-29T00:00:00Z", closed)
    assert derived["date_provenance"] == "DERIVED_FROM_DELISTING"
    assert derived["target_date_raw"] == "2022-05-30"
    assert derived["queried_date"] == "2022-05-27"

    fallback = select_delisted_probe_date(None, closed)
    assert fallback["date_provenance"] == "FALLBACK_DEFAULT"
    assert fallback["queried_date"] == FALLBACK_DELISTED_DATE


def test_safe_json_serialization_and_env_ambiguity(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "FMP_API_KEY=PRIMARY_FMP\nFMP_KEY_CALENDARS=ALT_FMP\nMASSIVE_KEY_2=M2\nORATS_API_KEY=O1\n",
        encoding="utf-8",
    )
    creds = load_authorized_credentials(env_file)
    assert creds.fmp_key == "PRIMARY_FMP"
    assert creds.audit["fmp"]["ambiguity_detected"] is True
    assert creds.audit["fmp"]["candidate_var_names"] == ["FMP_API_KEY", "FMP_KEY_CALENDARS"]

    dirty = {"val": float("nan"), "inf": float("inf"), "msg": "url?apikey=PRIMARY_FMP"}
    clean = creds.sanitizer.sanitize_obj(dirty)
    dumped = json.dumps(clean, allow_nan=False)
    assert "PRIMARY_FMP" not in dumped
    assert '"val": null' in dumped
    assert '"inf": null' in dumped


def test_static_repo_inspection_helpers(tmp_path: Path) -> None:
    (tmp_path / "src" / "server").mkdir(parents=True)
    (tmp_path / "src" / "core").mkdir(parents=True)
    (tmp_path / "src" / "data").mkdir(parents=True)
    (tmp_path / "tools").mkdir(parents=True)
    (tmp_path / "fixtures").mkdir(parents=True)

    (tmp_path / "src" / "server" / "marketRuntime.ts").write_text(
        "export const US_EQUITY_UNIVERSE = [\n"
        "  { symbol: 'AAPL', name: 'Apple' },\n"
        "  makeGeneralUsEquityMeta('PLTR', 'Palantir', 'Tech', '#000'),\n"
        "] as const;\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "core" / "usHistorical.ts").write_text(
        "const CLOSED = new Set(['2024-01-01', '2025-01-09']);\n"
        "const EARLY = new Set(['2024-11-29']);\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "core" / "sessions.ts").write_text("", encoding="utf-8")
    (tmp_path / "src" / "data" / "alignment.ts").write_text("", encoding="utf-8")
    (tmp_path / "tools" / "generate_pieza0b_massive_rest_reference.py").write_text("", encoding="utf-8")
    (tmp_path / "fixtures" / "pieza0b_massive_rest_reference.json").write_text("{}", encoding="utf-8")

    uni = extract_us_equity_universe(tmp_path)
    assert uni["symbols"] == ["AAPL", "PLTR"]
    assert uni["observed_count"] == 2
    cal = inspect_nyse_calendar(tmp_path)
    assert cal["closed_dates"] == ["2024-01-01", "2025-01-09"]
    assert cal["early_close_dates"] == ["2024-11-29"]
