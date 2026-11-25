"""Asynchronous FMP Enterprise (``/stable/``) adapters with anti-truncation & timezone rules.

Empirical contracts verified in Prompt #1:
- ``/stable/earnings?symbol={ticker}`` omits usable BMO/AMC timestamps (retrospective PIT caveat).
- ``/stable/sec-filings-search/symbol`` defaults to max 100 rows per call; ``acceptedDate`` omits
  explicit offset and requires explicit assumption ``SEC_EDGAR_ET`` (unless offset/Z is present).
- ``/stable/economic-calendar`` accepts windows (bounded <= 60 days); filter ``country == "US"``
  and classify ``FOMC | CPI | NFP | PCE``.
- ``/stable/historical-sp500-constituent`` & ``historical-nasdaq-constituent`` are global downloads.
- ``/stable/shares-float`` is a current/latest snapshot (NOT historical PIT).
"""

from __future__ import annotations

import datetime as dt
import math
import time
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl

from avwap_oracle.adapters.credentials import AsyncProviderTransport

ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")

TARGET_SEC_FORMS: frozenset[str] = frozenset({"424B5", "S-3", "S-3ASR", "8-K", "6-K"})

FMP_EARNINGS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "earn_date": pl.String,
    "eps_actual": pl.Float64,
    "eps_estimated": pl.Float64,
    "revenue_actual": pl.Float64,
    "revenue_estimated": pl.Float64,
    "last_updated": pl.String,
    "ingested_at_utc_s": pl.Int64,
    "availability_quality": pl.String,
}

SEC_FILINGS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "cik": pl.String,
    "form_type": pl.String,
    "filing_date": pl.String,
    "accepted_date_raw": pl.String,
    "accepted_ts_utc_s": pl.Int64,
    "accepted_tz_assumption": pl.String,
    "available_at_utc_s": pl.Int64,
    "availability_quality": pl.String,
    "link": pl.String,
    "truncation_warning": pl.Boolean,
}

INDEX_CONSTITUENTS_SCHEMA: dict[str, pl.DataType] = {
    "index_name": pl.String,
    "effective_date": pl.String,
    "date_added": pl.String,
    "symbol": pl.String,
    "added_ticker": pl.String,
    "added_security": pl.String,
    "removed_ticker": pl.String,
    "removed_security": pl.String,
    "change_type": pl.String,
    "reason": pl.String,
}

ECON_CALENDAR_SCHEMA: dict[str, pl.DataType] = {
    "event_date": pl.String,
    "scheduled_raw": pl.String,
    "scheduled_ts_utc_s": pl.Int64,
    "tz_assumption": pl.String,
    "country": pl.String,
    "currency": pl.String,
    "event": pl.String,
    "macro_event_type": pl.String,
    "impact": pl.String,
    "previous": pl.Float64,
    "estimate": pl.Float64,
    "actual": pl.Float64,
    "unit": pl.String,
    "availability_quality": pl.String,
}

FMP_SPLITS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "execution_date": pl.String,
    "split_from": pl.Float64,
    "split_to": pl.Float64,
    "split_type": pl.String,
}

FMP_DIVIDENDS_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "ex_dividend_date": pl.String,
    "cash_amount": pl.Float64,
    "adj_dividend": pl.Float64,
    "frequency": pl.String,
    "is_special_dividend": pl.Boolean,
    "declaration_date": pl.String,
    "record_date": pl.String,
    "payment_date": pl.String,
    "yield_val": pl.Float64,
}


def _num_or_nan(val: Any) -> float:
    if isinstance(val, bool) or val is None:
        return math.nan
    try:
        f = float(val)
    except (TypeError, ValueError):
        return math.nan
    return f if math.isfinite(f) else math.nan


def parse_sec_accepted_timestamp(raw_val: str) -> tuple[int, str]:
    """Parse SEC ``acceptedDate`` preserving explicit offsets or applying ``SEC_EDGAR_ET``."""
    text = raw_val.strip()
    if not text:
        return -1, "INVALID_EMPTY"
    iso_cand = text.replace(" ", "T")
    if iso_cand.endswith("Z"):
        iso_cand = iso_cand[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(iso_cand)
    except ValueError:
        try:
            d_only = dt.date.fromisoformat(text[:10])
            local_dt = dt.datetime(d_only.year, d_only.month, d_only.day, tzinfo=ET_TZ)
            return int(local_dt.timestamp()), "SEC_EDGAR_ET"
        except ValueError:
            return -1, "PARSE_ERROR"

    if parsed.tzinfo is not None:
        # Respect explicit timezone without double conversion.
        return int(parsed.astimezone(UTC_TZ).timestamp()), "EXPLICIT_OFFSET"
    local_dt = parsed.replace(tzinfo=ET_TZ)
    return int(local_dt.astimezone(UTC_TZ).timestamp()), "SEC_EDGAR_ET"


def parse_fmp_econ_timestamp(raw_val: str) -> tuple[int, str]:
    text = raw_val.strip()
    if not text:
        return -1, "INVALID_EMPTY"
    iso_cand = text.replace(" ", "T")
    if iso_cand.endswith("Z"):
        iso_cand = iso_cand[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(iso_cand)
    except ValueError:
        return -1, "PARSE_ERROR"
    if parsed.tzinfo is not None:
        return int(parsed.astimezone(UTC_TZ).timestamp()), "EXPLICIT_OFFSET"
    return int(parsed.replace(tzinfo=UTC_TZ).timestamp()), "FMP_UTC_ASSUMED"


def classify_us_macro_event(event_name: str) -> str:
    low = event_name.lower()
    if "fomc" in low or "fed interest rate" in low or "federal funds" in low:
        return "FOMC"
    if "core pce" in low or "pce price" in low or "personal consumption expenditures" in low:
        return "PCE"
    if "nonfarm" in low or "non-farm" in low or "non farm payroll" in low:
        return "NFP"
    if "cpi" in low or "consumer price index" in low:
        return "CPI"
    return "OTHER"


@dataclass(frozen=True)
class FmpSecFilingsResult:
    data: pl.DataFrame
    truncation_warning: bool
    pages: int


class FmpRestClient:
    """Async FMP Enterprise REST client on ``/stable/``."""

    def __init__(self, transport: AsyncProviderTransport) -> None:
        self._t = transport

    async def fetch_earnings(self, ticker: str) -> pl.DataFrame:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "FMP_ENTERPRISE",
            "/stable/earnings",
            params={"symbol": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, list):
            return pl.DataFrame(schema=FMP_EARNINGS_SCHEMA)
        ingested_s = int(time.time())
        rows: list[dict[str, Any]] = []
        for r in resp.payload:
            if not isinstance(r, dict):
                continue
            d_str = str(r.get("date") or "").strip()
            if not d_str:
                continue
            rows.append(
                {
                    "ticker": str(r.get("symbol") or sym).upper(),
                    "earn_date": d_str,
                    "eps_actual": _num_or_nan(r.get("epsActual")),
                    "eps_estimated": _num_or_nan(r.get("epsEstimated")),
                    "revenue_actual": _num_or_nan(r.get("revenueActual")),
                    "revenue_estimated": _num_or_nan(r.get("revenueEstimated")),
                    "last_updated": str(r.get("lastUpdated") or ""),
                    "ingested_at_utc_s": ingested_s,
                    "availability_quality": "RETROSPECTIVE_NOT_PIT",
                }
            )
        if not rows:
            return pl.DataFrame(schema=FMP_EARNINGS_SCHEMA)
        return pl.DataFrame(rows, schema=FMP_EARNINGS_SCHEMA).unique(subset=["ticker", "earn_date"]).sort("earn_date")

    async def _fetch_sec_window_recursive(
        self,
        sym: str,
        s_date: dt.date,
        e_date: dt.date,
        *,
        limit: int = 100,
        depth: int = 0,
    ) -> tuple[list[dict[str, Any]], bool, int]:
        """Fetch SEC filings avoiding silent 100-row truncation via pagination and date bisection."""
        all_raw: list[dict[str, Any]] = []
        seen_keys: set[tuple[str, str, str]] = set()
        pages = 0
        trunc_warn = False

        # Probe page=0 first; paginate if distinct new rows arrive, bisect if server repeats page 0 or ignores page.
        page = 0
        while page < 20:
            resp = await self._t.request_json(
                "FMP_ENTERPRISE",
                "/stable/sec-filings-search/symbol",
                params={"symbol": sym, "from": s_date.isoformat(), "to": e_date.isoformat(), "limit": limit, "page": page},
                allow_404=True,
            )
            pages += 1
            if resp.status_code == 404 or not isinstance(resp.payload, list):
                break
            batch = [r for r in resp.payload if isinstance(r, dict)]
            new_rows = []
            for r in batch:
                key = (
                    str(r.get("formType") or ""),
                    str(r.get("acceptedDate") or ""),
                    str(r.get("link") or r.get("finalLink") or ""),
                )
                if key not in seen_keys:
                    seen_keys.add(key)
                    new_rows.append(r)

            if page == 0 and len(batch) >= limit:
                # Check if page=1 actually yields additional distinct rows; if not, bisect dates instead.
                all_raw.extend(new_rows)
                resp1 = await self._t.request_json(
                    "FMP_ENTERPRISE",
                    "/stable/sec-filings-search/symbol",
                    params={"symbol": sym, "from": s_date.isoformat(), "to": e_date.isoformat(), "limit": limit, "page": 1},
                    allow_404=True,
                )
                pages += 1
                batch1 = [r for r in resp1.payload if isinstance(r, dict)] if isinstance(resp1.payload, list) else []
                distinct1 = [
                    r for r in batch1
                    if (
                        str(r.get("formType") or ""),
                        str(r.get("acceptedDate") or ""),
                        str(r.get("link") or r.get("finalLink") or ""),
                    ) not in seen_keys
                ]
                if distinct1:
                    for r in distinct1:
                        seen_keys.add(
                            (
                                str(r.get("formType") or ""),
                                str(r.get("acceptedDate") or ""),
                                str(r.get("link") or r.get("finalLink") or ""),
                            )
                        )
                    all_raw.extend(distinct1)
                    if len(batch1) < limit:
                        break
                    page = 2
                    continue
                # Pagination didn't advance cleanly -> subdivide window if > 1 day.
                if s_date < e_date and depth < 10:
                    mid = s_date + dt.timedelta(days=(e_date - s_date).days // 2)
                    left_rows, left_warn, left_pages = await self._fetch_sec_window_recursive(
                        sym, s_date, mid, limit=limit, depth=depth + 1
                    )
                    right_rows, right_warn, right_pages = await self._fetch_sec_window_recursive(
                        sym, mid + dt.timedelta(days=1), e_date, limit=limit, depth=depth + 1
                    )
                    return left_rows + right_rows, left_warn or right_warn, pages + left_pages + right_pages
                trunc_warn = True
                break

            all_raw.extend(new_rows)
            if len(batch) < limit or not new_rows:
                break
            page += 1

        return all_raw, trunc_warn, pages

    async def fetch_sec_filings(
        self,
        ticker: str,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        window_days: int = 180,
    ) -> FmpSecFilingsResult:
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        sym = ticker.strip().upper()
        if s_date > e_date:
            return FmpSecFilingsResult(pl.DataFrame(schema=SEC_FILINGS_SCHEMA), False, 0)

        collected: list[dict[str, Any]] = []
        any_trunc = False
        total_pages = 0
        cur = s_date
        step = dt.timedelta(days=max(1, window_days) - 1)
        while cur <= e_date:
            w_end = min(e_date, cur + step)
            raw_rows, w_trunc, w_pages = await self._fetch_sec_window_recursive(sym, cur, w_end)
            any_trunc = any_trunc or w_trunc
            total_pages += w_pages
            collected.extend(raw_rows)
            cur = w_end + dt.timedelta(days=1)

        out_rows: list[dict[str, Any]] = []
        for r in collected:
            form = str(r.get("formType") or "").strip().upper()
            if form not in TARGET_SEC_FORMS:
                continue
            acc_raw = str(r.get("acceptedDate") or "").strip()
            acc_ts, tz_assump = parse_sec_accepted_timestamp(acc_raw)
            out_rows.append(
                {
                    "ticker": str(r.get("symbol") or sym).upper(),
                    "cik": str(r.get("cik") or "").strip(),
                    "form_type": form,
                    "filing_date": str(r.get("filingDate") or "")[:10],
                    "accepted_date_raw": acc_raw,
                    "accepted_ts_utc_s": acc_ts,
                    "accepted_tz_assumption": tz_assump,
                    "available_at_utc_s": acc_ts,
                    "availability_quality": (
                        "OBSERVED_EXPLICIT_OFFSET"
                        if tz_assump == "EXPLICIT_OFFSET"
                        else "ASSUMED_SEC_EDGAR_ET"
                    ),
                    "link": str(r.get("finalLink") or r.get("link") or ""),
                    "truncation_warning": any_trunc,
                }
            )
        df = (
            pl.DataFrame(out_rows, schema=SEC_FILINGS_SCHEMA)
            .unique(subset=["ticker", "form_type", "accepted_date_raw", "link"])
            .sort(["accepted_ts_utc_s", "form_type"])
            if out_rows
            else pl.DataFrame(schema=SEC_FILINGS_SCHEMA)
        )
        return FmpSecFilingsResult(data=df, truncation_warning=any_trunc, pages=total_pages)

    async def fetch_index_constituents_history(self) -> tuple[pl.DataFrame, pl.DataFrame]:
        async def _load_one(endpoint: str, index_name: str) -> pl.DataFrame:
            resp = await self._t.request_json("FMP_ENTERPRISE", endpoint, allow_404=True)
            if resp.status_code == 404 or not isinstance(resp.payload, list):
                return pl.DataFrame(schema=INDEX_CONSTITUENTS_SCHEMA)
            rows: list[dict[str, Any]] = []
            for r in resp.payload:
                if not isinstance(r, dict):
                    continue
                rows.append(
                    {
                        "index_name": index_name,
                        "effective_date": str(r.get("date") or ""),
                        "date_added": str(r.get("dateAdded") or ""),
                        "symbol": str(r.get("symbol") or "").upper(),
                        "added_ticker": str(r.get("addedTicker") or "").upper(),
                        "added_security": str(r.get("addedSecurity") or ""),
                        "removed_ticker": str(r.get("removedTicker") or "").upper(),
                        "removed_security": str(r.get("removedSecurity") or ""),
                        "change_type": str(r.get("changeType") or ""),
                        "reason": str(r.get("reason") or ""),
                    }
                )
            return (
                pl.DataFrame(rows, schema=INDEX_CONSTITUENTS_SCHEMA).sort(["effective_date", "symbol"])
                if rows
                else pl.DataFrame(schema=INDEX_CONSTITUENTS_SCHEMA)
            )

        sp500_df = await _load_one("/stable/historical-sp500-constituent", "SP500")
        nasdaq_df = await _load_one("/stable/historical-nasdaq-constituent", "NASDAQ100")
        return sp500_df, nasdaq_df

    async def fetch_economic_calendar_us(
        self,
        start_date: dt.date | str,
        end_date: dt.date | str,
        *,
        chunk_days: int = 45,
    ) -> pl.DataFrame:
        if chunk_days > 60 or chunk_days < 1:
            raise ValueError(f"chunk_days must be in [1, 60], got {chunk_days}")
        s_date = dt.date.fromisoformat(start_date) if isinstance(start_date, str) else start_date
        e_date = dt.date.fromisoformat(end_date) if isinstance(end_date, str) else end_date
        if s_date > e_date:
            return pl.DataFrame(schema=ECON_CALENDAR_SCHEMA)

        rows: list[dict[str, Any]] = []
        cur = s_date
        step = dt.timedelta(days=chunk_days - 1)
        while cur <= e_date:
            c_end = min(e_date, cur + step)
            resp = await self._t.request_json(
                "FMP_ENTERPRISE",
                "/stable/economic-calendar",
                params={"from": cur.isoformat(), "to": c_end.isoformat()},
                allow_404=True,
            )
            if resp.status_code != 404 and isinstance(resp.payload, list):
                for r in resp.payload:
                    if not isinstance(r, dict):
                        continue
                    if str(r.get("country") or "").strip().upper() != "US":
                        continue
                    raw_dt = str(r.get("date") or "").strip()
                    ts_utc_s, tz_assump = parse_fmp_econ_timestamp(raw_dt)
                    ev_name = str(r.get("event") or "").strip()
                    rows.append(
                        {
                            "event_date": raw_dt[:10],
                            "scheduled_raw": raw_dt,
                            "scheduled_ts_utc_s": ts_utc_s,
                            "tz_assumption": tz_assump,
                            "country": "US",
                            "currency": str(r.get("currency") or "USD").upper(),
                            "event": ev_name,
                            "macro_event_type": classify_us_macro_event(ev_name),
                            "impact": str(r.get("impact") or ""),
                            "previous": _num_or_nan(r.get("previous")),
                            "estimate": _num_or_nan(r.get("estimate")),
                            "actual": _num_or_nan(r.get("actual")),
                            "unit": str(r.get("unit") or ""),
                            "availability_quality": "SCHEDULED_UTC_REVISIONS_UNVERIFIED",
                        }
                    )
            cur = c_end + dt.timedelta(days=1)

        if not rows:
            return pl.DataFrame(schema=ECON_CALENDAR_SCHEMA)
        return (
            pl.DataFrame(rows, schema=ECON_CALENDAR_SCHEMA)
            .unique(subset=["scheduled_raw", "event", "country"])
            .sort(["scheduled_ts_utc_s", "event"])
        )

    async def fetch_shares_float(self, ticker: str) -> dict[str, Any] | None:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "FMP_ENTERPRISE",
            "/stable/shares-float",
            params={"symbol": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, list) or not resp.payload:
            return None
        row = dict(resp.payload[0])
        return {
            "ticker": str(row.get("symbol") or sym).upper(),
            "provider": "fmp",
            "endpoint": "/stable/shares-float",
            "free_float": _num_or_nan(row.get("floatShares")),
            "free_float_percent": _num_or_nan(row.get("freeFloat")),
            "outstanding_shares": _num_or_nan(row.get("outstandingShares")),
            "effective_date": str(row.get("date") or ""),
            "ingested_at_utc_s": int(time.time()),
            "is_point_in_time": False,
            "availability_quality": "CURRENT_SNAPSHOT_ONLY",
        }

    async def fetch_splits(self, ticker: str) -> pl.DataFrame:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "FMP_ENTERPRISE",
            "/stable/splits",
            params={"symbol": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, list):
            return pl.DataFrame(schema=FMP_SPLITS_SCHEMA)
        rows: list[dict[str, Any]] = []
        for r in resp.payload:
            if not isinstance(r, dict):
                continue
            d_str = str(r.get("date") or "").strip()
            if not d_str:
                continue
            # FMP NVDA 10:1 -> numerator=10, denominator=1 => split_from=1, split_to=10.
            rows.append(
                {
                    "ticker": str(r.get("symbol") or sym).upper(),
                    "execution_date": d_str,
                    "split_from": _num_or_nan(r.get("denominator")),
                    "split_to": _num_or_nan(r.get("numerator")),
                    "split_type": str(r.get("splitType") or ""),
                }
            )
        if not rows:
            return pl.DataFrame(schema=FMP_SPLITS_SCHEMA)
        return pl.DataFrame(rows, schema=FMP_SPLITS_SCHEMA).unique(subset=["ticker", "execution_date"]).sort("execution_date")

    async def fetch_dividends(self, ticker: str) -> pl.DataFrame:
        sym = ticker.strip().upper()
        resp = await self._t.request_json(
            "FMP_ENTERPRISE",
            "/stable/dividends",
            params={"symbol": sym},
            allow_404=True,
        )
        if resp.status_code == 404 or not isinstance(resp.payload, list):
            return pl.DataFrame(schema=FMP_DIVIDENDS_SCHEMA)
        rows: list[dict[str, Any]] = []
        for r in resp.payload:
            if not isinstance(r, dict):
                continue
            d_str = str(r.get("date") or "").strip()
            if not d_str:
                continue
            freq_str = str(r.get("frequency") or "").strip()
            rows.append(
                {
                    "ticker": str(r.get("symbol") or sym).upper(),
                    "ex_dividend_date": d_str,
                    "cash_amount": _num_or_nan(r.get("dividend")),
                    "adj_dividend": _num_or_nan(r.get("adjDividend")),
                    "frequency": freq_str,
                    "is_special_dividend": freq_str == "Special",
                    "declaration_date": str(r.get("declarationDate") or ""),
                    "record_date": str(r.get("recordDate") or ""),
                    "payment_date": str(r.get("paymentDate") or ""),
                    "yield_val": _num_or_nan(r.get("yield")),
                }
            )
        if not rows:
            return pl.DataFrame(schema=FMP_DIVIDENDS_SCHEMA)
        return (
            pl.DataFrame(rows, schema=FMP_DIVIDENDS_SCHEMA)
            .unique(subset=["ticker", "ex_dividend_date", "cash_amount", "frequency"])
            .sort("ex_dividend_date")
        )
