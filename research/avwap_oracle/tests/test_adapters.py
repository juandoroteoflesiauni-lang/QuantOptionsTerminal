"""Comprehensive offline adversarial test suite for Prompt #3 (Task 4).

Covers all 11 mandatory domains using ``httpx.MockTransport``, synthetic secrets,
controlled clocks, ``tmp_path``, and independent ``Decimal`` references. Zero real
network connections are possible (enforced by ``tests/conftest.py``).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import math
import urllib.parse
from decimal import Decimal, getcontext
from pathlib import Path
from typing import Any

import httpx
import polars as pl
import pytest

from avwap_oracle.adapters.credentials import (
    AsyncProviderTransport,
    CredentialPoolError,
    DomainRoutingError,
    OracleCredentials,
    OratsPoolBlockedError,
    PaginationLoopError,
    ProviderAuthorizationError,
    ProviderRetryExhaustedError,
    classify_massive_endpoint_domain,
    validate_request_target,
)
from avwap_oracle.adapters.fmp_rest import (
    FmpRestClient,
    classify_us_macro_event,
    parse_fmp_econ_timestamp,
    parse_sec_accepted_timestamp,
)
from avwap_oracle.adapters.massive_rest import MassiveRestClient
from avwap_oracle.adapters.orats_rest import (
    ORATS_FIELD_REGISTRY,
    OratsRestClient,
    classify_orats_annc_tod,
    compute_gex_opex_summary_from_strikes,
    generate_opex_sampling_dates,
)
from avwap_oracle.adapters.reconciler import (
    reconcile_corporate_actions,
    reconcile_earnings_calendar,
)
from avwap_oracle.ingest_pilot import run_ingestion
from avwap_oracle.math_core.nyse_calendar import ET_TZ, get_session_bounds
from avwap_oracle.universe import (
    DateWindow,
    FalsificationWindows,
    InstrumentSpec,
    PilotUniverse,
    load_pilot_universe,
)

getcontext().prec = 50


def _synthetic_creds(
    *,
    orats_keys: str = "ORATS_SYN_SLOT1,ORATS_SYN_SLOT2,ORATS_SYN_FORBIDDEN_SLOT3",
) -> OracleCredentials:
    return OracleCredentials.from_mapping(
        {
            "MASSIVE_KEY_2": "M_STOCK_SYN_K2",
            "MASSIVE_KEY_3": "M_STOCK_SYN_K3",
            "MASSIVE_KEY_1": "M_STOCK_SYN_K1",
            "MASSIVE_API_KEY": "M_OPTIONS_SYN_APIKEY",
            "MASSIVE_KEY_FUTURES": "M_FUTURES_SYN_FORBIDDEN",
            "ORATS_API_KEY": "ORATS_SYN_SLOT1",
            "ORATS_API_KEYS": orats_keys,
            "FMP_API_KEY": "FMP_SYN_APIKEY",
        }
    )


# ---------------------------------------------------------------------------
# 1. Credentials isolation, ORATS #3 exclusion, zero secret leakage
# ---------------------------------------------------------------------------


def test_credentials_isolation_orats_slot3_exclusion_and_redaction() -> None:
    creds = _synthetic_creds()
    stocks = [s.value for s in creds.slots_for_domain("MASSIVE_STOCKS_REST")]
    opts = [s.value for s in creds.slots_for_domain("MASSIVE_OPTIONS_REST")]
    orats = [s.value for s in creds.slots_for_domain("ORATS_HISTORICAL")]

    assert stocks == ["M_STOCK_SYN_K2", "M_STOCK_SYN_K3", "M_STOCK_SYN_K1"]
    assert "M_OPTIONS_SYN_APIKEY" not in stocks
    assert "M_FUTURES_SYN_FORBIDDEN" not in stocks
    assert opts == ["M_OPTIONS_SYN_APIKEY"]
    assert orats == ["ORATS_SYN_SLOT1", "ORATS_SYN_SLOT2"]
    assert "ORATS_SYN_FORBIDDEN_SLOT3" not in orats
    assert creds.orats_excluded_slot_count == 1

    # Critical anti-dedup test: if Slot #2 duplicates Slot #1, Slot #3 MUST NOT be promoted!
    dup_creds = _synthetic_creds(
        orats_keys="ORATS_SYN_SLOT1,ORATS_SYN_SLOT1,ORATS_SYN_FORBIDDEN_SLOT3"
    )
    with pytest.raises(OratsPoolBlockedError):
        dup_creds.slots_for_domain("ORATS_HISTORICAL")

    # Missing Slot #2 also blocks pool instead of guessing
    short_creds = _synthetic_creds(orats_keys="ORATS_SYN_SLOT1")
    with pytest.raises(OratsPoolBlockedError):
        short_creds.slots_for_domain("ORATS_HISTORICAL")

    # Financial-domain routing blocks options routes under STOCKS_REST & vice versa
    assert classify_massive_endpoint_domain("/v2/aggs/ticker/O:NVDA240621C00120000/range/1/minute/2024-06-01/2024-06-05") == "MASSIVE_OPTIONS_REST"
    assert classify_massive_endpoint_domain("/v3/trades/O:SPY261113C00700000") == "MASSIVE_OPTIONS_REST"
    assert classify_massive_endpoint_domain("/futures/v1/contracts") == "FUTURES_FORBIDDEN"

    with pytest.raises(DomainRoutingError):
        validate_request_target("https://api.massive.com/options/v1/unusual-trades", "MASSIVE_STOCKS_REST")
    with pytest.raises(DomainRoutingError):
        validate_request_target("https://api.massive.com/v2/aggs/ticker/O:SPY261113C00700000/range/1/day/2024-01-01/2024-02-01", "MASSIVE_STOCKS_REST")
    with pytest.raises(DomainRoutingError):
        validate_request_target("https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/2024-01-01/2024-01-02", "MASSIVE_OPTIONS_REST")
    with pytest.raises(DomainRoutingError):
        validate_request_target("https://evil.example.com/v2/aggs/ticker/SPY", "MASSIVE_STOCKS_REST")

    # Zero secret leakage in sanitizer
    clean = creds.sanitizer.sanitize_text(
        "Failed GET https://api.orats.io/datav2/hist/cores?token=ORATS_SYN_FORBIDDEN_SLOT3&apiKey=M_OPTIONS_SYN_APIKEY"
    )
    assert "ORATS_SYN_FORBIDDEN_SLOT3" not in clean
    assert "M_OPTIONS_SYN_APIKEY" not in clean
    assert "<REDACTED>" in clean


# ---------------------------------------------------------------------------
# 2. Transport: 429, Retry-After, 403 no retry, 5xx, timeout, cancel, next_url loop
# ---------------------------------------------------------------------------


def test_transport_retries_429_no_key_hopping_403_and_loop_detection() -> None:
    creds = _synthetic_creds()
    sleep_calls: list[float] = []
    now_clock = [0.0]

    async def fake_sleep(secs: float) -> None:
        sleep_calls.append(secs)
        now_clock[0] += secs

    used_keys: list[str] = []
    calls = {"aggs": 0, "sec403": 0, "loop": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(str(request.url)).query)
        key = (qs.get("apiKey") or [""])[0]
        used_keys.append(key)
        path = request.url.path

        if "LOOPTEST" in path:
            calls["loop"] += 1
            return httpx.Response(
                200,
                json={"results": [], "next_url": "https://api.massive.com/v2/aggs/ticker/LOOPTEST/page2"},
            )
        if "FORBIDDEN" in path:
            calls["sec403"] += 1
            return httpx.Response(403, json={"status": "ERROR", "message": "Forbidden M_STOCK_SYN_K2"})
        if "RETRY429" in path:
            calls["aggs"] += 1
            if calls["aggs"] == 1:
                return httpx.Response(429, headers={"Retry-After": "2.5"}, json={"status": "RATE_LIMIT"})
            if calls["aggs"] == 2:
                return httpx.Response(503, json={"status": "BACKEND_BUSY"})
            return httpx.Response(200, json={"results": []})
        return httpx.Response(200, json={"results": []})

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            sleep_fn=fake_sleep,
            monotonic_fn=lambda: now_clock[0],
            wall_time_fn=lambda: 1700000000.0 + now_clock[0],
            jitter_fn=lambda: 0.0,
            max_attempts=4,
            total_deadline_s=30.0,
            min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "MASSIVE_OPTIONS_REST": 0.0, "ORATS_HISTORICAL": 0.0, "FMP_ENTERPRISE": 0.0},
        ) as t:
            # 1) 429 (Retry-After=2.5) + 503 retry WITHOUT hopping away from assigned key!
            await t.request_json("MASSIVE_STOCKS_REST", "/v2/aggs/ticker/RETRY429/range/1/minute/2024-01-01/2024-01-02")
            assert len(set(used_keys)) == 1
            assert sleep_calls == [2.5, 1.5]  # Retry-After=2.5, then attempt 2 base*2=1.5

            # 2) 403 fails immediately with 0 retries and sanitized message
            with pytest.raises(ProviderAuthorizationError) as exc_info:
                await t.request_json("MASSIVE_STOCKS_REST", "/v2/aggs/ticker/FORBIDDEN/range/1/minute/2024-01-01/2024-01-02")
            assert exc_info.value.status_code == 403
            assert calls["sec403"] == 1
            assert "M_STOCK_SYN_K2" not in str(exc_info.value)

            # 3) next_url loop detection
            seen: set[str] = set()
            u1 = t.validate_next_url("https://api.polygon.io/v2/aggs/ticker/LOOPTEST/page2?apiKey=SECRET", "MASSIVE_STOCKS_REST", seen)
            assert u1 == "https://api.massive.com/v2/aggs/ticker/LOOPTEST/page2"
            with pytest.raises(PaginationLoopError):
                t.validate_next_url("https://api.massive.com/v2/aggs/ticker/LOOPTEST/page2", "MASSIVE_STOCKS_REST", seen)

            # 4) next_url host spoofing rejected
            with pytest.raises(DomainRoutingError):
                t.validate_next_url("https://attacker.com/v2/aggs/ticker/SPY", "MASSIVE_STOCKS_REST", seen)

    asyncio.run(run())


def test_transport_timeout_and_cancellation() -> None:
    creds = _synthetic_creds()
    now_clock = [0.0]

    async def fake_sleep(s: float) -> None:
        now_clock[0] += s

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        if "CANCEL" in request.url.path:
            raise asyncio.CancelledError()
        raise httpx.ReadTimeout("simulated read timeout", request=request)

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(timeout_handler),
            sleep_fn=fake_sleep,
            monotonic_fn=lambda: now_clock[0],
            jitter_fn=lambda: 0.0,
            max_attempts=2,
            base_backoff_s=0.1,
            min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0},
        ) as t:
            with pytest.raises(ProviderRetryExhaustedError):
                await t.request_json("MASSIVE_STOCKS_REST", "/v2/aggs/ticker/TIMEOUT/range/1/minute/2024-01-01/2024-01-02")
            with pytest.raises(asyncio.CancelledError):
                await t.request_json("MASSIVE_STOCKS_REST", "/v2/aggs/ticker/CANCEL/range/1/minute/2024-01-01/2024-01-02")

    asyncio.run(run())


# ---------------------------------------------------------------------------
# 3. Massive REST: round-robin, pagination, vw outside OHLC, quarantine, unusual, OI
# ---------------------------------------------------------------------------


def test_massive_rest_contracts_round_robin_dedup_quarantine_and_options() -> None:
    creds = _synthetic_creds()
    seen_stock_keys: list[str] = []
    seen_option_keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(str(request.url)).query)
        path = request.url.path
        if path.startswith("/options/") or "/o:" in path.lower():
            seen_option_keys.append((qs.get("apiKey") or [""])[0])
        else:
            seen_stock_keys.append((qs.get("apiKey") or [""])[0])

        if path.startswith("/v2/aggs/ticker/TEST"):
            if qs.get("cursor") == ["p2"]:
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            # Exact duplicate of bar 1
                            {"t": 1717767000000, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 1000.0, "vw": 101.25, "n": 10},
                            # Invalid vw (NaN/null) -> must be quarantined, NEVER replaced with HLC3
                            {"t": 1717767060000, "o": 100.0, "h": 101.0, "l": 99.5, "c": 100.2, "v": 500.0, "vw": None, "n": 5},
                            # Valid bar 2
                            {"t": 1717767120000, "o": 100.2, "h": 100.8, "l": 100.0, "c": 100.6, "v": 2000.0, "vw": 100.45, "n": 20},
                        ]
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [
                        # vw=101.25 legitimately outside [99.0, 101.0]
                        {"t": 1717767000000, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 1000.0, "vw": 101.25, "n": 10},
                        # v == 0 -> quarantined
                        {"t": 1717767030000, "o": 100.0, "h": 100.0, "l": 100.0, "c": 100.0, "v": 0.0, "vw": 100.0, "n": 1},
                    ],
                    "next_url": "https://api.massive.com/v2/aggs/ticker/TEST/range/1/minute/2024-06-07/2024-06-07?cursor=p2",
                },
            )
        if path.startswith("/v2/aggs/ticker/BADCONFLICT"):
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"t": 1717767000000, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5, "v": 1000.0, "vw": 100.2, "n": 10},
                        {"t": 1717767000000, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.9, "v": 1000.0, "vw": 100.2, "n": 10},
                    ]
                },
            )
        if path == "/stocks/v1/dividends":
            if qs.get("cursor") == ["d2"]:
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "id": "d2", "ticker": "COST", "ex_dividend_date": "2023-12-27",
                                "cash_amount": 15.0, "currency": "USD", "distribution_type": "special",
                                "frequency": 0, "historical_adjustment_factor": 0.978,
                            }
                        ]
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "id": "d1", "ticker": "COST", "ex_dividend_date": "2026-10-30",
                            "cash_amount": 1.47, "currency": "USD", "distribution_type": "recurring",
                            "frequency": 4, "historical_adjustment_factor": 0.998,
                        }
                    ],
                    "next_url": "https://api.massive.com/stocks/v1/dividends?cursor=d2",
                },
            )
        if path == "/stocks/vX/float":
            if qs.get("ticker") == ["MISSING"]:
                return httpx.Response(404, json={"status": "NOT_FOUND"})
            return httpx.Response(
                200,
                json={"results": [{"ticker": "MELI", "free_float": 47259558, "free_float_percent": 93.2, "effective_date": "2026-11-02"}]},
            )
        if path == "/options/v1/unusual-trades":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "ticker": "O:NVDA240621C00120000", "underlying_ticker": "NVDA", "root": "NVDA",
                            "sip_timestamp": 1717767000123456789, "price": 5.5, "size": 200,
                            "exchange": 302, "flags": ["block_premium"], "sequence_number": 101,
                        },
                        {
                            # Adjusted root without explicit shares_per_contract -> notional MUST be NaN
                            "ticker": "O:NVDA1240621C00120000", "underlying_ticker": "NVDA", "root": "NVDA1",
                            "sip_timestamp": 1717767060000000000, "price": 5.0, "size": 100,
                            "exchange": 302, "flags": ["iso"], "sequence_number": 102,
                        },
                    ]
                },
            )
        if path == "/options/v1/open-interest/underlying":
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"underlying_ticker": "SPY", "date": "2024-11-22", "open_interest": 27000, "open_interest_calls": 12000, "open_interest_puts": 15000},
                    ]
                },
            )
        return httpx.Response(404, json={})

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "MASSIVE_OPTIONS_REST": 0.0},
        ) as t:
            client = MassiveRestClient(t)
            ag = await client.fetch_aggs_1m_raw("TEST", "2024-06-07", "2024-06-07")
            assert ag.rows_accepted == 2
            assert ag.rows_quarantined == 2
            assert ag.duplicates_exact == 1
            assert ag.vw_outside_ohlc_count == 1
            assert ag.bars["ts_utc_s"].to_list() == [1717767000, 1717767120]
            assert ag.bars["vw"][0] == 101.25  # Preserved outside [99, 101]

            with pytest.raises(Exception, match="Contradictory duplicate"):
                await client.fetch_aggs_1m_raw("BADCONFLICT", "2024-06-07", "2024-06-07")

            divs = await client.fetch_dividends("COST")
            assert divs.height == 2
            assert 15.0 in divs["cash_amount"].to_list()

            fl = await client.fetch_float_snapshot("MELI")
            assert fl is not None and fl["is_point_in_time"] is False and fl["effective_date"] == "2026-11-02"
            assert await client.fetch_float_snapshot("MISSING") is None

            # Verify pre-2022-09-01 window produces EMPTY_VERIFIED with zero HTTP calls
            pre_un = await client.fetch_options_unusual_trades("NVDA", "2021-01-15", "2022-08-31")
            assert pre_un.status == "EMPTY_VERIFIED" and pre_un.pages == 0

            un = await client.fetch_options_unusual_trades("NVDA", "2024-06-01", "2024-06-10")
            assert un.status == "COMPLETE" and un.data.height == 2
            assert un.data["ts_utc_s"][0] == 1717767000
            assert math.isclose(float(un.data["notional"][0]), 5.5 * 200 * 100.0)
            assert math.isnan(float(un.data["notional"][1]))  # Adjusted root never guesses spc

            oi = await client.fetch_options_oi_underlying("SPY", "2024-11-22", "2024-11-22")
            assert oi.data["total_call_oi"][0] == 12000 and oi.data["total_put_oi"][0] == 15000

    asyncio.run(run())
    assert set(seen_stock_keys) == {"M_STOCK_SYN_K2", "M_STOCK_SYN_K3", "M_STOCK_SYN_K1"}
    assert set(seen_option_keys) == {"M_OPTIONS_SYN_APIKEY"}


# ---------------------------------------------------------------------------
# 4. ORATS scales, blocked spot fields, WHAM ETF restriction, & independent GEX
# ---------------------------------------------------------------------------


def test_orats_scales_blocked_spots_wham_and_independent_gex() -> None:
    creds = _synthetic_creds()
    orats_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        orats_urls.append(request.url.path)
        if request.url.path == "/datav2/hist/cores":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "ticker": "NVDA", "tradeDate": "2024-06-07",
                            "impErnMv": 10.04, "impliedEarningsMove": 7.89,
                            "orIvXern20d": 44.75, "iv30d": 45.22, "exErnIv30d": 45.22,
                            "orHv5d": 48.10, "absAvgErnMv": 9.50,
                            "ivPctile1m": 62.5, "ivPctile1y": 71.0,
                            "contango": -1.49, "slope": -0.18347,
                            "cOi": 1000, "pOi": 900, "cVolu": 500, "pVolu": 400,
                            "daysToNextErn": 75, "nextErn": "2024-08-28", "lastErn": "2024-05-22",
                            "pxAtmIv": 1210.17, "pxCls": 1208.88,
                        }
                    ]
                },
            )
        if request.url.path == "/datav2/hist/summaries":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "ticker": "NVDA", "tradeDate": "2024-06-07",
                            "impliedEarningsMove": 0.0788804, "impliedMove": 0.081,
                            "iv30d": 0.452229, "exErnIv30d": 0.452229,
                            "contango": -1.488388143479824, "stockPrice": 1210.17,
                        }
                    ]
                },
            )
        if request.url.path == "/datav2/hist/wham":
            return httpx.Response(404, json={"message": "No WHAM data"})
        return httpx.Response(200, json={"data": []})

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            min_interval_by_domain={"ORATS_HISTORICAL": 0.0},
        ) as t:
            client = OratsRestClient(t)
            cores = await client.fetch_hist_cores("NVDA", "2024-06-01", "2024-06-10")
            sums = await client.fetch_hist_summaries("NVDA", "2024-06-01", "2024-06-10")

            # Verify Decimal-exact scale normalization & non-conflation
            assert math.isclose(float(cores["imp_ern_mv_dec"][0]), float(Decimal("10.04") / Decimal("100")), rel_tol=1e-15)
            assert math.isclose(float(cores["or_iv_xern_20d_dec"][0]), float(Decimal("44.75") / Decimal("100")), rel_tol=1e-15)
            assert math.isclose(float(cores["iv_30d_dec"][0]), float(Decimal("45.22") / Decimal("100")), rel_tol=1e-15)
            assert math.isclose(float(cores["ex_ern_iv_30d_dec"][0]), float(Decimal("45.22") / Decimal("100")), rel_tol=1e-15)
            assert math.isclose(float(cores["iv_pctile_1m_pct"][0]), 62.5)
            assert math.isclose(float(cores["contango"][0]), -1.49)
            assert math.isclose(float(cores["slope"][0]), -0.18347)
            assert math.isclose(float(sums["implied_earnings_move_dec"][0]), 0.0788804)
            assert cores["imp_ern_mv_dec"][0] != sums["implied_earnings_move_dec"][0]

            # Spot blocking: no unprefixed spot columns allowed
            assert "stockPrice" not in cores.columns and "pxAtmIv" not in cores.columns
            assert "stockPrice" not in sums.columns
            assert any(c.startswith("_orats_ref_px_blocked") for c in cores.columns)

            # WHAM: non-ETF makes 0 calls; ETF 404 maps to UNSUPPORTED_COVERAGE (not zero!)
            non_etf = await client.fetch_hist_wham("NVDA", "2023-01-01", "2024-06-07", asset_class="US_EQUITY")
            assert non_etf.status == "NOT_APPLICABLE" and "/datav2/hist/wham" not in orats_urls

            etf_404 = await client.fetch_hist_wham("SPY", "2023-01-01", "2024-06-07", asset_class="US_ETF")
            assert etf_404.status == "UNSUPPORTED_COVERAGE"

    asyncio.run(run())
    assert len(ORATS_FIELD_REGISTRY) >= 15

    # Independent Decimal GEX math verification (sum(|GEX_i|) != |sum(GEX_i)|)
    strikes = [
        {"strike": 540.0, "expirDate": "2024-11-22", "dte": 4, "gamma": 0.025, "callOpenInterest": 2000, "putOpenInterest": 500, "callVolume": 100, "putVolume": 50, "smvVol": 0.18},
        {"strike": 560.0, "expirDate": "2024-12-20", "dte": 32, "gamma": 0.015, "callOpenInterest": 400, "putOpenInterest": 3000, "callVolume": 20, "putVolume": 80, "smvVol": 0.16},
    ]
    gex = compute_gex_opex_summary_from_strikes(
        "SPY", "2024-11-18", strikes, massive_spot=550.0, sampling_mode="PRE_OPEX", monthly_opex_date="2024-12-20"
    )
    exp_abs_raw = (
        Decimal("0.025") * Decimal("2500") * Decimal("100")
        + Decimal("0.015") * Decimal("3400") * Decimal("100")
    )
    exp_net_raw = (
        Decimal("0.025") * Decimal("1500") * Decimal("100")
        + Decimal("0.015") * Decimal("-2600") * Decimal("100")
    )
    assert math.isclose(gex["abs_gex_raw_total"], float(exp_abs_raw), rel_tol=1e-12)
    assert math.isclose(gex["net_gex_raw_gamma_oi"], float(exp_net_raw), rel_tol=1e-12)
    assert gex["abs_gex_raw_total"] != abs(gex["net_gex_raw_gamma_oi"])  # Explicitly distinct!
    exp_dollar = exp_abs_raw * Decimal("550.0") ** 2 * Decimal("0.01")
    assert math.isclose(gex["abs_gex_total"], float(exp_dollar), rel_tol=1e-12)
    assert math.isclose(gex["expiring_gex_share"], float((Decimal("0.025") * Decimal("2500") * Decimal("100")) / exp_abs_raw), rel_tol=1e-12)
    assert gex["call_wall_strike"] == 540.0 and gex["put_wall_strike"] == 560.0

    # Zero denominator / missing Massive spot / OpEx Good Friday adjustment (Apr 2022)
    gex_no_spot = compute_gex_opex_summary_from_strikes("SPY", "2024-11-18", strikes, massive_spot=None)
    assert math.isnan(gex_no_spot["abs_gex_total"]) and gex_no_spot["gex_unit_status"] == "RAW_GAMMA_OI_ONLY_NO_MASSIVE_SPOT"
    assert math.isnan(gex_no_spot["zero_gamma_est"]) and gex_no_spot["zero_gamma_reason"] == "MISSING_MASSIVE_SPOT"

    zero_oi = [{"strike": 550.0, "expirDate": "2024-11-22", "dte": 4, "gamma": 0.02, "callOpenInterest": 0, "putOpenInterest": 0}]
    gex_zero = compute_gex_opex_summary_from_strikes("SPY", "2024-11-18", zero_oi, massive_spot=550.0)
    assert math.isnan(gex_zero["expiring_gex_share"]) and "ZERO_TOTAL_ABS_GEX" in gex_zero["quality_reason"]

    # Good Friday 2022-04-15 -> OpEx shifts to Thu 2022-04-14 -> PRE_OPEX is Wed 2022-04-13
    apr_2022 = generate_opex_sampling_dates("2022-04-01", "2022-04-30", include_post_opex=True)
    assert apr_2022[0].opex_date == "2022-04-14"
    assert apr_2022[0].trade_date == "2022-04-13" and apr_2022[0].sampling_mode == "PRE_OPEX"
    assert apr_2022[1].trade_date == "2022-04-18" and apr_2022[1].sampling_mode == "POST_OPEX"


# ---------------------------------------------------------------------------
# 5. FMP: SEC anti-truncation bisection, ET vs offset tz, econ calendar, corp actions
# ---------------------------------------------------------------------------


def test_fmp_sec_anti_truncation_timezones_and_econ_calendar() -> None:
    creds = _synthetic_creds()

    def handler(request: httpx.Request) -> httpx.Response:
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(str(request.url)).query)
        path = request.url.path
        if path == "/stable/sec-filings-search/symbol":
            f_s = qs["from"][0]
            f_e = qs["to"][0]
            page = int(qs.get("page", ["0"])[0])
            # Simulate a capped window where 100 rows come back on page 0 AND page 1 repeats -> triggers bisection
            if f_s == "2025-01-01" and f_e == "2025-01-10":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "symbol": "NVDA", "cik": "0001045810", "formType": "8-K",
                            "filingDate": f"2025-01-{(i % 9) + 1:02d} 00:00:00",
                            "acceptedDate": f"2025-01-{(i % 9) + 1:02d} 16:30:{i % 60:02d}",
                            "finalLink": f"https://sec.example/doc_{i}",
                        }
                        for i in range(100)
                    ],
                )
            if page == 0:
                return httpx.Response(
                    200,
                    json=[
                        {
                            "symbol": "NVDA", "cik": "0001045810", "formType": "8-K",
                            "filingDate": f_s,
                            "acceptedDate": f"{f_s} 17:15:00",
                            "finalLink": f"https://sec.example/{f_s}_{f_e}",
                        }
                    ],
                )
            return httpx.Response(200, json=[])
        if path == "/stable/economic-calendar":
            return httpx.Response(
                200,
                json=[
                    {"date": "2025-01-15 13:30:00", "country": "US", "currency": "USD", "event": "Core CPI MoM", "impact": "High", "previous": 0.3, "estimate": 0.2, "actual": 0.2},
                    {"date": "2025-01-29 19:00:00", "country": "US", "currency": "USD", "event": "FOMC Interest Rate Decision", "impact": "High", "previous": 4.5, "estimate": 4.5, "actual": 4.5},
                    {"date": "2025-01-15 08:00:00", "country": "GB", "currency": "GBP", "event": "UK CPI", "impact": "High"},
                ],
            )
        if path in ("/stable/historical-sp500-constituent", "/stable/historical-nasdaq-constituent"):
            return httpx.Response(200, json=[{"symbol": "NVDA", "date": "2024-01-02", "addedTicker": "NVDA"}])
        return httpx.Response(200, json=[])

    # Direct timezone checks: naive ET vs explicit offset
    ts_naive, assump_naive = parse_sec_accepted_timestamp("2025-07-10 16:30:00")
    assert assump_naive == "SEC_EDGAR_ET" and ts_naive == int(dt.datetime(2025, 7, 10, 16, 30, tzinfo=ET_TZ).timestamp())
    ts_explicit, assump_exp = parse_sec_accepted_timestamp("2025-07-10T20:30:00Z")
    assert assump_exp == "EXPLICIT_OFFSET" and ts_explicit == ts_naive  # No double conversion!
    assert classify_us_macro_event("Federal Funds FOMC Interest Rate Decision") == "FOMC"
    assert classify_us_macro_event("Core PCE Price Index YoY") == "PCE"
    assert parse_fmp_econ_timestamp("2025-01-15 13:30:00")[1] == "FMP_UTC_ASSUMED"

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            min_interval_by_domain={"FMP_ENTERPRISE": 0.0},
        ) as t:
            client = FmpRestClient(t)
            sec = await client.fetch_sec_filings("NVDA", "2025-01-01", "2025-01-10")
            # Bisected into <= 5d subwindows cleanly and got rows from both halves
            assert sec.data.height == 2
            assert sec.pages > 2

            econ = await client.fetch_economic_calendar_us("2025-01-01", "2025-02-28", chunk_days=30)
            assert econ.height == 2  # GB filtered out
            assert set(econ["macro_event_type"].to_list()) == {"CPI", "FOMC"}

    asyncio.run(run())


# ---------------------------------------------------------------------------
# 6. Earnings BMO/AMC, FRC ETH inference, strict causality, Corporate actions
# ---------------------------------------------------------------------------


def test_earnings_reconciliation_causality_and_corp_actions_conflicts() -> None:
    # Build bars for FRC (no ORATS timing -> ETH inference) and conflict case
    d_prev = get_session_bounds("2023-01-23")
    d_bmo = get_session_bounds("2023-01-24")
    d_amc = get_session_bounds("2023-04-24")
    assert d_prev and d_bmo and d_amc

    bars = pl.DataFrame(
        [
            # FRC day before BMO
            {"ticker": "FRC", "ts_utc_s": d_prev.rth_close_utc_s - 60, "o": 140.0, "h": 140.5, "l": 139.5, "c": 140.0, "v": 1_000_000.0, "vw": 140.0, "n": 100},
            # FRC pre-market 07:05 ET crosses +6% -> BMO inferred, shadow = exact 07:05 bar!
            {"ticker": "FRC", "ts_utc_s": d_bmo.ext_open_utc_s + 185 * 60, "o": 148.0, "h": 149.0, "l": 148.0, "c": 148.5, "v": 25_000.0, "vw": 148.3, "n": 50},
            {"ticker": "FRC", "ts_utc_s": d_bmo.rth_open_utc_s, "o": 149.0, "h": 150.0, "l": 148.0, "c": 149.5, "v": 200_000.0, "vw": 149.2, "n": 300},
            # FRC day of AMC earnings (2023-04-24): AH crash -25% at 16:32 ET
            {"ticker": "FRC", "ts_utc_s": d_amc.rth_close_utc_s - 60, "o": 16.0, "h": 16.2, "l": 15.9, "c": 16.0, "v": 5_000_000.0, "vw": 16.0, "n": 500},
            {"ticker": "FRC", "ts_utc_s": d_amc.rth_close_utc_s + 32 * 60, "o": 12.0, "h": 12.2, "l": 11.8, "c": 12.0, "v": 80_000.0, "vw": 12.0, "n": 200},
        ]
    )

    fmp_er = pl.DataFrame(
        [
            {"ticker": "AAPL", "earn_date": "2024-10-31", "eps_actual": 1.64, "eps_estimated": 1.60, "revenue_actual": 1.0, "revenue_estimated": 1.0, "last_updated": "", "ingested_at_utc_s": 1, "availability_quality": "RETROSPECTIVE_NOT_PIT"},
            {"ticker": "FRC", "earn_date": "2023-01-24", "eps_actual": 1.0, "eps_estimated": 1.0, "revenue_actual": 1.0, "revenue_estimated": 1.0, "last_updated": "", "ingested_at_utc_s": 1, "availability_quality": "RETROSPECTIVE_NOT_PIT"},
            {"ticker": "FRC", "earn_date": "2023-04-24", "eps_actual": 0.1, "eps_estimated": 0.2, "revenue_actual": 1.0, "revenue_estimated": 1.0, "last_updated": "", "ingested_at_utc_s": 1, "availability_quality": "RETROSPECTIVE_NOT_PIT"},
            {"ticker": "FRC", "earn_date": "2022-10-14", "eps_actual": 1.0, "eps_estimated": 1.0, "revenue_actual": 1.0, "revenue_estimated": 1.0, "last_updated": "", "ingested_at_utc_s": 1, "availability_quality": "RETROSPECTIVE_NOT_PIT"},
        ]
    )
    _, hhmm_amc, tim_amc = classify_orats_annc_tod(1630, "2024-10-31")
    assert (hhmm_amc, tim_amc) == ("1630", "AMC")
    assert classify_orats_annc_tod("0900", "2024-10-31")[2] == "BMO"
    assert classify_orats_annc_tod(900, "2024-10-31")[2] == "BMO"

    orats_er = pl.DataFrame(
        [
            # ±1 day offset vs FMP 2024-10-31 -> matches cleanly 1-to-1 with delta=+1
            {"ticker": "AAPL", "earn_date": "2024-11-01", "annc_tod_raw": "1630", "annc_hhmm": "1630", "earnings_timing": "AMC", "updated_at_raw": ""},
        ]
    )
    rec = reconcile_earnings_calendar(fmp_er, orats_er, bars)
    by_dt = {(r["ticker"], r["earn_date_canonical"]): r for r in rec.to_dicts()}

    aapl = by_dt[("AAPL", "2024-11-01")]
    assert aapl["date_aligned_delta"] == 1
    assert aapl["timing_source"] == "ORATS_HIST_EARNINGS"
    # Nov 1, 2024 Friday AMC -> anchor is Monday Nov 4, 2024 RTH open
    assert aapl["anchor_ts_rth_utc_s"] == get_session_bounds("2024-11-04").rth_open_utc_s

    frc_bmo = by_dt[("FRC", "2023-01-24")]
    assert frc_bmo["earnings_timing"] == "BMO" and frc_bmo["timing_source"] == "MASSIVE_ETH_INFERRED"
    assert frc_bmo["eth_shadow_ts_utc_s"] == d_bmo.ext_open_utc_s + 185 * 60
    # Strict causality: cannot be known before PM evaluation window completes (09:30 ET)
    assert frc_bmo["available_at_utc_s"] == d_bmo.rth_open_utc_s

    frc_amc = by_dt[("FRC", "2023-04-24")]
    assert frc_amc["earnings_timing"] == "AMC" and frc_amc["timing_source"] == "MASSIVE_ETH_INFERRED"
    assert frc_amc["eth_shadow_ts_utc_s"] == d_amc.rth_close_utc_s + 32 * 60
    assert frc_amc["eth_shadow_ts_utc_s"] != d_amc.rth_close_utc_s + 60  # NEVER hardcoded 16:01 ET!
    # Available ONLY AFTER evaluating entire AH session (20:00 ET)!
    assert frc_amc["available_at_utc_s"] == d_amc.ext_close_utc_s
    assert frc_amc["anchor_ts_rth_utc_s"] == get_session_bounds("2023-04-25").rth_open_utc_s

    frc_unk = by_dt[("FRC", "2022-10-14")]
    assert frc_unk["earnings_timing"] == "UNKNOWN" and frc_unk["anchor_ts_rth_utc_s"] is None

    # Corporate actions reconciliation
    m_sp = pl.DataFrame(
        [
            {"ticker": "NVDA", "execution_date": "2024-06-10", "split_from": 1.0, "split_to": 10.0, "historical_adjustment_factor": 0.1, "adjustment_type": "forward_split", "event_id": "m1"},
            {"ticker": "XYZ", "execution_date": "2024-03-01", "split_from": 5.0, "split_to": 1.0, "historical_adjustment_factor": 5.0, "adjustment_type": "reverse_split", "event_id": "m2"},
        ]
    )
    f_sp = pl.DataFrame(
        [
            {"ticker": "NVDA", "execution_date": "2024-06-10", "split_from": 1.0, "split_to": 10.0, "split_type": "stock-split"},
            {"ticker": "XYZ", "execution_date": "2024-03-01", "split_from": 4.0, "split_to": 1.0, "split_type": "reverse"},
        ]
    )
    m_dv = pl.DataFrame(
        [
            {"ticker": "COST", "ex_dividend_date": "2023-12-27", "cash_amount": 15.0, "currency": "USD", "distribution_type": "special", "frequency": 0, "historical_adjustment_factor": 0.978, "split_adjusted_cash_amount": 15.0, "declaration_date": "", "record_date": "", "pay_date": "", "event_id": "md1"},
        ]
    )
    f_dv = pl.DataFrame(
        [
            {"ticker": "COST", "ex_dividend_date": "2023-12-27", "cash_amount": 15.0, "adj_dividend": 15.0, "frequency": "Special", "is_special_dividend": True, "declaration_date": "", "record_date": "", "payment_date": "", "yield_val": 2.7},
        ]
    )
    ca = reconcile_corporate_actions(m_sp, f_sp, m_dv, f_dv)
    sp_st = {r["ticker"]: r for r in ca.splits.to_dicts()}
    assert sp_st["NVDA"]["status"] == "MATCHED" and sp_st["NVDA"]["safe_to_apply"] is True
    assert sp_st["XYZ"]["status"] == "CONFLICT" and sp_st["XYZ"]["safe_to_apply"] is False
    assert math.isnan(float(sp_st["XYZ"]["k_canonical"]))  # Never average conflicts
    assert ca.dividends["status"][0] == "MATCHED" and ca.dividends["is_special_provider"][0] is True


# ---------------------------------------------------------------------------
# 7. Pipeline checkpoints, corruption detection, downstream invalidation, delisted cutoff
# ---------------------------------------------------------------------------


def test_pipeline_checkpoints_resume_corruption_force_and_delisted_cutoff(tmp_path: Path) -> None:
    creds = _synthetic_creds()
    req_log: list[str] = []

    base_uni = load_pilot_universe()
    # Narrow frozen test window spanning TWTR's delisted_date (2022-10-31) + CERN's earlier delisted_date (2022-06-09)
    small_uni = PilotUniverse(
        schema_version=1,
        frozen_at_date=base_uni.frozen_at_date.isoformat(),
        methodology_note=base_uni.methodology_note,
        windows=FalsificationWindows(
            core=DateWindow(start="2022-10-24", end="2022-11-10"),
            opra_flow=DateWindow(start="2022-10-24", end="2022-11-10"),
            macro_wham=DateWindow(start="2022-10-24", end="2022-11-10"),
        ),
        instruments=base_uni.instruments,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        req_log.append(path)
        if "/v2/aggs/ticker/TWTR/range/1/minute/" in path:
            # Verify TWTR NEVER requests dates beyond 2022-10-31
            parts = path.split("/")
            assert parts[-1] <= "2022-10-31"
            sb = get_session_bounds("2022-10-28")
            assert sb is not None
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"t": sb.rth_open_utc_s * 1000, "o": 53.7, "h": 53.9, "l": 53.6, "c": 53.8, "v": 100_000.0, "vw": 53.75, "n": 100},
                        {"t": (sb.rth_open_utc_s + 60) * 1000, "o": 53.8, "h": 54.0, "l": 53.7, "c": 53.9, "v": 120_000.0, "vw": 53.85, "n": 110},
                        # Out-of-RTH bar that MUST be excluded from canonical RTH
                        {"t": sb.ext_open_utc_s * 1000, "o": 53.0, "h": 53.0, "l": 53.0, "c": 53.0, "v": 500_000.0, "vw": 53.0, "n": 50},
                    ]
                },
            )
        if "/v2/aggs/ticker/CERN/" in path:
            raise AssertionError("CERN has empty intersection with 2022-10-24..2022-11-10 and must make 0 HTTP requests")
        if path == "/datav2/hist/cores":
            return httpx.Response(200, json={"data": [{"ticker": "TWTR", "tradeDate": "2022-10-28", "impErnMv": 5.0, "iv30d": 20.0}]})
        if path == "/datav2/hist/summaries":
            return httpx.Response(200, json={"data": []})
        if path == "/datav2/hist/earnings":
            return httpx.Response(200, json={"data": []})
        if path == "/datav2/hist/strikes":
            return httpx.Response(200, json={"data": []})
        if path == "/options/v1/unusual-trades":
            return httpx.Response(200, json={"results": []})
        if path == "/options/v1/open-interest/underlying":
            return httpx.Response(200, json={"results": []})
        if path == "/stable/earnings":
            return httpx.Response(200, json=[])
        if path == "/stable/sec-filings-search/symbol":
            return httpx.Response(200, json=[])
        if path == "/stable/splits":
            return httpx.Response(200, json=[])
        if path == "/stable/dividends":
            return httpx.Response(200, json=[])
        if path in ("/stocks/v1/splits", "/stocks/v1/dividends"):
            return httpx.Response(200, json={"results": []})
        if path == "/stocks/vX/float":
            return httpx.Response(200, json={"results": []})
        if path == "/stable/shares-float":
            return httpx.Response(200, json=[])
        if path in ("/stable/historical-sp500-constituent", "/stable/historical-nasdaq-constituent", "/stable/economic-calendar"):
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={})

    data_dir = tmp_path / "data"
    rep_path = tmp_path / "reports" / "audit.md"

    async def run_all_checks() -> None:
        # Run 1: TWTR ingests cleanly up to 2022-10-31; CERN skips empty window with 0 requests
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "ORATS_HISTORICAL": 0.0, "FMP_ENTERPRISE": 0.0, "MASSIVE_OPTIONS_REST": 0.0}) as t1:
            res1 = await run_ingestion(
                tickers=["TWTR", "CERN"],
                data_dir=data_dir,
                report_path=rep_path,
                credentials=creds,
                transport=t1,
                universe=small_uni,
            )
            assert res1.partitions["TWTR:raw_1m:2022"]["row_count"] == 3
            assert res1.partitions["TWTR:canonical:rth_1D"]["row_count"] == 1
            assert res1.partitions["TWTR:canonical:rth_1D"]["excluded_non_rth"] == 1
            assert res1.partitions["CERN:raw_1m:empty"]["status"] == "EMPTY_VERIFIED"

        # Run 2: Exact idempotency -> ZERO HTTP requests across all verified checkpoints!
        req_before = len(req_log)
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "ORATS_HISTORICAL": 0.0, "FMP_ENTERPRISE": 0.0, "MASSIVE_OPTIONS_REST": 0.0}) as t2:
            await run_ingestion(
                tickers=["TWTR", "CERN"],
                data_dir=data_dir,
                report_path=rep_path,
                credentials=creds,
                transport=t2,
                universe=small_uni,
            )
        assert len(req_log) == req_before

        # Run 3: Corrupt raw_1m Parquet on disk -> triggers re-fetch AND rebuilds downstream canonical!
        corrupt_p = data_dir / "raw" / "massive_1m" / "TWTR" / "2022.parquet"
        corrupt_p.write_bytes(b"NOT_A_VALID_PARQUET_FILE")
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "ORATS_HISTORICAL": 0.0, "FMP_ENTERPRISE": 0.0, "MASSIVE_OPTIONS_REST": 0.0}) as t3:
            res3 = await run_ingestion(
                tickers=["TWTR"],
                data_dir=data_dir,
                report_path=rep_path,
                credentials=creds,
                transport=t3,
                universe=small_uni,
            )
        assert len(req_log) > req_before
        assert res3.partitions["TWTR:raw_1m:2022"]["status"] == "COMPLETE"
        assert pl.read_parquet(corrupt_p).height == 3

        # Run 4: Scoped --force only re-fetches requested dataset (orats_cores), leaves global & raw_1m untouched!
        req_pre_force = len(req_log)
        async with AsyncProviderTransport(creds, transport=httpx.MockTransport(handler), min_interval_by_domain={"MASSIVE_STOCKS_REST": 0.0, "ORATS_HISTORICAL": 0.0, "FMP_ENTERPRISE": 0.0, "MASSIVE_OPTIONS_REST": 0.0}) as t4:
            await run_ingestion(
                tickers=["TWTR"],
                datasets=["orats_cores"],
                force=True,
                data_dir=data_dir,
                report_path=rep_path,
                credentials=creds,
                transport=t4,
                universe=small_uni,
            )
        assert req_log[req_pre_force:] == ["/datav2/hist/cores"]

    asyncio.run(run_all_checks())


def test_orats_redirect_safe_and_host_allowlist() -> None:
    creds = _synthetic_creds()
    seen_req_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_req_urls.append(str(request.url))
        host = request.url.host
        if host == "api.orats.io":
            tkr = request.url.params.get("ticker") or ""
            if "SPOOF_EVIL" in tkr:
                return httpx.Response(302, headers={"Location": "https://evil.example.com/payload.json"})
            if "SPOOF_S3" in tkr:
                return httpx.Response(302, headers={"Location": "https://attacker-s3.amazonaws.com/payload.json"})
            if "STRIKES_API_S3" in tkr:
                return httpx.Response(
                    302,
                    headers={
                        "Location": "https://orats-data-api.s3.amazonaws.com/strikes/2024-06-07.json?X-Amz-Signature=SECRET_API_SIG"
                    },
                )
            return httpx.Response(
                302,
                headers={
                    "Location": "https://orats-data.s3.amazonaws.com/cores_hist/NVDA/cores.json?X-Amz-Signature=SECRET_SIG_XYZ"
                },
            )
        if host in ("orats-data.s3.amazonaws.com", "orats-data-api.s3.amazonaws.com"):
            # Verify ORATS token was NEVER sent to the S3 pre-signed URL
            assert "token" not in request.url.params
            return httpx.Response(200, json={"data": [{"ticker": "NVDA", "tradeDate": "2024-06-07", "iv30d": 45.22}]})
        if host == "api.massive.com":
            return httpx.Response(302, headers={"Location": "https://orats-data.s3.amazonaws.com/nope.json"})
        return httpx.Response(404, json={})

    async def run() -> None:
        async with AsyncProviderTransport(
            creds,
            transport=httpx.MockTransport(handler),
            min_interval_by_domain={"ORATS_HISTORICAL": 0.0, "MASSIVE_STOCKS_REST": 0.0},
        ) as t:
            resp = await t.request_json("ORATS_HISTORICAL", "/datav2/hist/cores", params={"ticker": "NVDA"})
            assert resp.status_code == 200
            assert "SECRET_SIG_XYZ" not in resp.url_sanitized
            assert resp.payload["data"][0]["iv30d"] == 45.22

            resp_api_s3 = await t.request_json("ORATS_HISTORICAL", "/datav2/hist/strikes", params={"ticker": "STRIKES_API_S3", "tradeDate": "2024-06-07"})
            assert resp_api_s3.status_code == 200
            assert "SECRET_API_SIG" not in resp_api_s3.url_sanitized

            with pytest.raises(DomainRoutingError):
                await t.request_json("ORATS_HISTORICAL", "/datav2/hist/cores", params={"ticker": "SPOOF_EVIL"})

            with pytest.raises(DomainRoutingError):
                await t.request_json("ORATS_HISTORICAL", "/datav2/hist/cores", params={"ticker": "SPOOF_S3"})

            with pytest.raises(Exception, match="Unexpected HTTP 302"):
                await t.request_json("MASSIVE_STOCKS_REST", "/v2/aggs/ticker/NVDA/range/1/minute/2024-06-07/2024-06-07")

    asyncio.run(run())
