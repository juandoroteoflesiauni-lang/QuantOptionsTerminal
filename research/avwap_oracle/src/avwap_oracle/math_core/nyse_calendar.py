"""Canonical NYSE 2020-2028 calendar and Polars session/bucket classifier.

Replicates the exact CLOSED (87) and EARLY (17) holiday/early-close sets
published in ``src/core/usHistorical.ts`` using ``ZoneInfo("America/New_York")``
and ``Int64`` integer UTC seconds.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Literal
from zoneinfo import ZoneInfo

import polars as pl

ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")

MIN_SUPPORTED_YEAR = 2020
MAX_SUPPORTED_YEAR = 2028
MAX_UTC_SECONDS = 10**11

CLOSED: frozenset[str] = frozenset(
    {
        "2020-01-01", "2020-01-20", "2020-02-17", "2020-04-10", "2020-05-25",
        "2020-07-03", "2020-09-07", "2020-11-26", "2020-12-25",
        "2021-01-01", "2021-01-18", "2021-02-15", "2021-04-02", "2021-05-31",
        "2021-07-05", "2021-09-06", "2021-11-25", "2021-12-24",
        "2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20",
        "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26",
        "2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29",
        "2023-06-19", "2023-07-04", "2023-09-04", "2023-11-23", "2023-12-25",
        "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
        "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
        "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18",
        "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27",
        "2025-12-25",
        "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
        "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
        "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
        "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
        "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
        "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
    }
)

EARLY: frozenset[str] = frozenset(
    {
        "2020-11-27", "2020-12-24", "2021-11-26", "2022-11-25", "2023-07-03",
        "2023-11-24", "2024-07-03", "2024-11-29", "2024-12-24", "2025-07-03",
        "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24", "2027-11-26",
        "2028-07-03", "2028-11-24",
    }
)

SupportedTimeframe = Literal["1m", "5m", "15m", "30m", "65m", "4H", "1D"]

TIMEFRAME_MINUTES: dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "65m": 65,
    "4H": 240,
    "1D": 390,
}

EXPECTED_BUCKETS: dict[str, tuple[int, int]] = {
    "1m": (390, 210),
    "5m": (78, 42),
    "15m": (26, 14),
    "30m": (13, 7),
    "65m": (6, 4),
    "4H": (2, 1),
    "1D": (1, 1),
}

SessionPhase = Literal["PRE_MARKET", "RTH", "AFTER_HOURS", "CLOSED"]


class CalendarOutOfCoverageError(ValueError):
    """Raised when a date or timestamp falls outside the verified 2020-2028 NYSE calendar."""


@dataclass(frozen=True)
class NyseSessionBounds:
    trade_date: str
    is_early_close: bool
    rth_open_utc_s: int
    rth_close_utc_s: int
    ext_open_utc_s: int
    ext_close_utc_s: int
    rth_minutes: int


def _validate_utc_seconds(ts_utc_s: int) -> int:
    if isinstance(ts_utc_s, bool) or not isinstance(ts_utc_s, int):
        raise ValueError(f"Timestamp must be an integer in UTC seconds, got {ts_utc_s!r}")
    if ts_utc_s <= 0 or ts_utc_s > MAX_UTC_SECONDS:
        raise ValueError(
            f"Timestamp {ts_utc_s} out of valid UTC seconds range (0, {MAX_UTC_SECONDS}]; "
            "millisecond timestamps are prohibited."
        )
    return ts_utc_s


def _et_wall_to_utc_s(d: dt.date, minutes_of_day: int) -> int:
    """Convert ET wall time (minutes since midnight) to integer UTC seconds."""
    if d.year < MIN_SUPPORTED_YEAR or d.year > MAX_SUPPORTED_YEAR:
        raise CalendarOutOfCoverageError(
            f"HISTORICAL_CALENDAR_OUT_OF_COVERAGE: {d.isoformat()} outside {MIN_SUPPORTED_YEAR}-{MAX_SUPPORTED_YEAR}"
        )
    hour, minute = divmod(minutes_of_day, 60)
    local_dt = dt.datetime(d.year, d.month, d.day, hour, minute, tzinfo=ET_TZ)
    return int(local_dt.timestamp())


def get_session_bounds(trade_date: dt.date | str) -> NyseSessionBounds | None:
    """Return exact UTC session bounds for ``trade_date``, or ``None`` if closed."""
    d = dt.date.fromisoformat(trade_date) if isinstance(trade_date, str) else trade_date
    if d.year < MIN_SUPPORTED_YEAR or d.year > MAX_SUPPORTED_YEAR:
        raise CalendarOutOfCoverageError(
            f"HISTORICAL_CALENDAR_OUT_OF_COVERAGE: {d.isoformat()} outside {MIN_SUPPORTED_YEAR}-{MAX_SUPPORTED_YEAR}"
        )
    date_key = d.isoformat()
    if d.weekday() >= 5 or date_key in CLOSED:
        return None
    is_early = date_key in EARLY
    rth_close_min = 780 if is_early else 960
    ext_close_min = 1020 if is_early else 1200
    return NyseSessionBounds(
        trade_date=date_key,
        is_early_close=is_early,
        rth_open_utc_s=_et_wall_to_utc_s(d, 570),
        rth_close_utc_s=_et_wall_to_utc_s(d, rth_close_min),
        ext_open_utc_s=_et_wall_to_utc_s(d, 240),
        ext_close_utc_s=_et_wall_to_utc_s(d, ext_close_min),
        rth_minutes=rth_close_min - 570,
    )


def _build_session_lookup() -> tuple[dict[str, NyseSessionBounds], pl.DataFrame]:
    bounds_by_date: dict[str, NyseSessionBounds] = {}
    rows: list[dict[str, Any]] = []
    cur = dt.date(MIN_SUPPORTED_YEAR, 1, 1)
    end = dt.date(MAX_SUPPORTED_YEAR, 12, 31)
    while cur <= end:
        sb = get_session_bounds(cur)
        if sb is not None:
            bounds_by_date[sb.trade_date] = sb
            rows.append(
                {
                    "trade_date": sb.trade_date,
                    "is_early_close": sb.is_early_close,
                    "rth_open_utc_s": sb.rth_open_utc_s,
                    "rth_close_utc_s": sb.rth_close_utc_s,
                    "ext_open_utc_s": sb.ext_open_utc_s,
                    "ext_close_utc_s": sb.ext_close_utc_s,
                    "rth_minutes": sb.rth_minutes,
                }
            )
        cur += dt.timedelta(days=1)

    df = pl.DataFrame(
        rows,
        schema={
            "trade_date": pl.String,
            "is_early_close": pl.Boolean,
            "rth_open_utc_s": pl.Int64,
            "rth_close_utc_s": pl.Int64,
            "ext_open_utc_s": pl.Int64,
            "ext_close_utc_s": pl.Int64,
            "rth_minutes": pl.Int32,
        },
    )
    return bounds_by_date, df


_SESSIONS_BY_DATE, _SESSION_TABLE = _build_session_lookup()


def session_bounds_for_timestamp(ts_utc_s: int) -> tuple[str, NyseSessionBounds | None]:
    """Return ``(et_date_key, NyseSessionBounds | None)`` for a UTC-second timestamp."""
    sec = _validate_utc_seconds(ts_utc_s)
    dt_et = dt.datetime.fromtimestamp(sec, UTC_TZ).astimezone(ET_TZ)
    if dt_et.year < MIN_SUPPORTED_YEAR or dt_et.year > MAX_SUPPORTED_YEAR:
        raise CalendarOutOfCoverageError(
            f"HISTORICAL_CALENDAR_OUT_OF_COVERAGE: {dt_et.date().isoformat()} outside {MIN_SUPPORTED_YEAR}-{MAX_SUPPORTED_YEAR}"
        )
    date_key = dt_et.date().isoformat()
    return date_key, _SESSIONS_BY_DATE.get(date_key)


def classify_timestamp_session(ts_utc_s: int) -> SessionPhase:
    """Classify a 1m bar opening timestamp into PRE_MARKET, RTH, AFTER_HOURS, or CLOSED."""
    sec = _validate_utc_seconds(ts_utc_s)
    _, sb = session_bounds_for_timestamp(sec)
    if sb is None:
        return "CLOSED"
    if sb.ext_open_utc_s <= sec < sb.rth_open_utc_s:
        return "PRE_MARKET"
    if sb.rth_open_utc_s <= sec < sb.rth_close_utc_s:
        return "RTH"
    if sb.rth_close_utc_s <= sec < sb.ext_close_utc_s:
        return "AFTER_HOURS"
    return "CLOSED"


def validate_timeframe(timeframe: str) -> int:
    if timeframe not in TIMEFRAME_MINUTES:
        raise ValueError(
            f"Unsupported timeframe {timeframe!r}; expected one of {tuple(TIMEFRAME_MINUTES.keys())}"
        )
    return TIMEFRAME_MINUTES[timeframe]


def bucket_id_for_minute(minute_of_rth: int, timeframe: str) -> int:
    """Compute session-anchored RTH bucket index from ``minute_of_rth``."""
    tf_min = validate_timeframe(timeframe)
    if minute_of_rth < 0:
        raise ValueError(f"minute_of_rth must be >= 0, got {minute_of_rth}")
    if timeframe == "1D":
        return 0
    return minute_of_rth // tf_min


def classify_1m_bars_polars(
    df: pl.DataFrame,
    *,
    ts_col: str = "ts_utc_s",
    timeframe: str = "1m",
) -> pl.DataFrame:
    """Vectorized Polars session and RTH bucket classifier for 1m bars.

    Assigns ``trade_date``, ``is_rth``, ``is_early_close``, ``minute_of_rth``
    (``Int32``, ``null`` outside RTH), ``bucket_id`` (``Int32``, ``null`` outside
    RTH), ``bucket_open_utc_s`` (``Int64``, ``null`` outside RTH),
    ``rth_open_utc_s``, ``rth_close_utc_s``, and ``session_phase``.
    """
    tf_min = validate_timeframe(timeframe)
    if ts_col not in df.columns:
        raise ValueError(f"Missing timestamp column {ts_col!r}")

    if df.height == 0:
        return df.with_columns(
            pl.lit(None, dtype=pl.String).alias("trade_date"),
            pl.lit(None, dtype=pl.Boolean).alias("is_rth"),
            pl.lit(None, dtype=pl.Boolean).alias("is_early_close"),
            pl.lit(None, dtype=pl.Int32).alias("minute_of_rth"),
            pl.lit(None, dtype=pl.Int32).alias("bucket_id"),
            pl.lit(None, dtype=pl.Int64).alias("bucket_open_utc_s"),
            pl.lit(None, dtype=pl.Int64).alias("rth_open_utc_s"),
            pl.lit(None, dtype=pl.Int64).alias("rth_close_utc_s"),
            pl.lit(None, dtype=pl.String).alias("session_phase"),
        )

    ts_dtype = df.schema[ts_col]
    if ts_dtype not in (pl.Int64, pl.Int32, pl.UInt64, pl.UInt32):
        raise ValueError(f"Timestamp column {ts_col!r} must be integer UTC seconds, got {ts_dtype}")

    ts_stats = df.select(
        pl.col(ts_col).null_count().alias("nulls"),
        pl.col(ts_col).min().alias("min_ts"),
        pl.col(ts_col).max().alias("max_ts"),
    ).row(0, named=True)
    if ts_stats["nulls"] > 0:
        raise ValueError(f"Timestamp column {ts_col!r} contains null values")
    min_ts = int(ts_stats["min_ts"])
    max_ts = int(ts_stats["max_ts"])
    _validate_utc_seconds(min_ts)
    _validate_utc_seconds(max_ts)

    min_year = dt.datetime.fromtimestamp(min_ts, UTC_TZ).astimezone(ET_TZ).year
    max_year = dt.datetime.fromtimestamp(max_ts, UTC_TZ).astimezone(ET_TZ).year
    if min_year < MIN_SUPPORTED_YEAR or max_year > MAX_SUPPORTED_YEAR:
        raise CalendarOutOfCoverageError(
            f"HISTORICAL_CALENDAR_OUT_OF_COVERAGE: years [{min_year}, {max_year}] outside {MIN_SUPPORTED_YEAR}-{MAX_SUPPORTED_YEAR}"
        )

    out = df.with_columns(
        pl.from_epoch(pl.col(ts_col).cast(pl.Int64), time_unit="s")
        .dt.replace_time_zone("UTC")
        .dt.convert_time_zone("America/New_York")
        .dt.strftime("%Y-%m-%d")
        .alias("trade_date")
    ).join(_SESSION_TABLE, on="trade_date", how="left")

    is_rth_expr = (
        pl.col("rth_open_utc_s").is_not_null()
        & (pl.col(ts_col) >= pl.col("rth_open_utc_s"))
        & (pl.col(ts_col) < pl.col("rth_close_utc_s"))
    )
    minute_expr = (
        pl.when(is_rth_expr)
        .then(((pl.col(ts_col).cast(pl.Int64) - pl.col("rth_open_utc_s")) // 60).cast(pl.Int32))
        .otherwise(pl.lit(None, dtype=pl.Int32))
    )
    bucket_expr = (
        pl.when(is_rth_expr)
        .then(
            pl.lit(0, dtype=pl.Int32)
            if timeframe == "1D"
            else (minute_expr // tf_min).cast(pl.Int32)
        )
        .otherwise(pl.lit(None, dtype=pl.Int32))
    )
    bucket_open_expr = (
        pl.when(is_rth_expr)
        .then(
            pl.col("rth_open_utc_s")
            if timeframe == "1D"
            else (pl.col("rth_open_utc_s") + bucket_expr.cast(pl.Int64) * (tf_min * 60))
        )
        .otherwise(pl.lit(None, dtype=pl.Int64))
    )
    phase_expr = (
        pl.when(pl.col("rth_open_utc_s").is_null())
        .then(pl.lit("CLOSED"))
        .when((pl.col(ts_col) >= pl.col("ext_open_utc_s")) & (pl.col(ts_col) < pl.col("rth_open_utc_s")))
        .then(pl.lit("PRE_MARKET"))
        .when(is_rth_expr)
        .then(pl.lit("RTH"))
        .when((pl.col(ts_col) >= pl.col("rth_close_utc_s")) & (pl.col(ts_col) < pl.col("ext_close_utc_s")))
        .then(pl.lit("AFTER_HOURS"))
        .otherwise(pl.lit("CLOSED"))
    )

    return (
        out.with_columns(
            is_rth_expr.alias("is_rth"),
            pl.col("is_early_close").fill_null(False).alias("is_early_close"),
            minute_expr.alias("minute_of_rth"),
            bucket_expr.alias("bucket_id"),
            bucket_open_expr.alias("bucket_open_utc_s"),
            phase_expr.alias("session_phase"),
        )
        .drop(["ext_open_utc_s", "ext_close_utc_s", "rth_minutes"])
    )
