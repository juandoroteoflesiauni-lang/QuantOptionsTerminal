"""Resumable, hash-verified Parquet ingestion pipeline for the AVWAP Research Oracle.

CLI examples (always run from ``research/avwap_oracle/``):
    UV_OFFLINE=1 uv run --locked python -m avwap_oracle.ingest_pilot --tickers SPY,NVDA,MELI,TWTR
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import hashlib
import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, Sequence

import polars as pl

from avwap_oracle.adapters.credentials import (
    AsyncProviderTransport,
    BudgetExceededError,
    OracleCredentials,
    ProviderAuthorizationError,
    SecretSanitizer,
    load_oracle_credentials,
)
from avwap_oracle.adapters.fmp_rest import (
    ECON_CALENDAR_SCHEMA,
    INDEX_CONSTITUENTS_SCHEMA,
    SEC_FILINGS_SCHEMA,
    FmpRestClient,
)
from avwap_oracle.adapters.massive_rest import (
    OI_DAILY_SCHEMA,
    QUARANTINE_1M_SCHEMA,
    RAW_1M_SCHEMA,
    UNUSUAL_DAILY_SUMMARY_SCHEMA,
    UNUSUAL_TRADES_SCHEMA,
    MassiveRestClient,
    reduce_raw_unusual_trades_to_summary,
    select_unusual_event_gated_dates,
)
from avwap_oracle.adapters.orats_rest import (
    ORATS_CORES_SCHEMA,
    ORATS_GEX_OPEX_SCHEMA,
    ORATS_SUMMARIES_SCHEMA,
    ORATS_WHAM_SCHEMA,
    OratsRestClient,
    generate_opex_sampling_dates,
    resolve_macro_wham_schedule,
)
from avwap_oracle.adapters.reconciler import (
    RECONCILED_DAILY_OI_SCHEMA,
    RECONCILED_DIVIDENDS_SCHEMA,
    RECONCILED_EARNINGS_SCHEMA,
    RECONCILED_SPLITS_SCHEMA,
    reconcile_corporate_actions,
    reconcile_daily_oi,
    reconcile_earnings_calendar_async,
)
from avwap_oracle.math_core.canonical_rth import build_canonical_rth_bars_with_audit
from avwap_oracle.math_core.nyse_calendar import ET_TZ
from avwap_oracle.universe import InstrumentSpec, PilotUniverse, load_pilot_universe

SCHEMA_VERSION = 1

PartitionStatus = Literal[
    "PENDING",
    "IN_PROGRESS",
    "COMPLETE",
    "PARTIAL",
    "EMPTY_VERIFIED",
    "UNSUPPORTED_COVERAGE",
    "FAILED_RETRYABLE",
    "FAILED_FATAL",
]

VALID_TERMINAL_SKIP_STATUSES: frozenset[str] = frozenset(
    {"COMPLETE", "EMPTY_VERIFIED", "UNSUPPORTED_COVERAGE"}
)

CANONICAL_TIMEFRAMES: tuple[str, ...] = ("1D", "65m", "15m", "5m")

CANONICAL_PARQUET_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "trade_date": pl.String,
    "bucket_id": pl.Int32,
    "ts_open_utc_s": pl.Int64,
    "o": pl.Float64,
    "h": pl.Float64,
    "l": pl.Float64,
    "c": pl.Float64,
    "W": pl.Float64,
    "mu": pl.Float64,
    "M2_within": pl.Float64,
    "bar_count": pl.Int32,
}

FLOAT_SNAPSHOT_SCHEMA: dict[str, pl.DataType] = {
    "ticker": pl.String,
    "provider": pl.String,
    "endpoint": pl.String,
    "free_float": pl.Float64,
    "free_float_percent": pl.Float64,
    "outstanding_shares": pl.Float64,
    "effective_date": pl.String,
    "ingested_at_utc_s": pl.Int64,
    "is_point_in_time": pl.Boolean,
    "availability_quality": pl.String,
}

ALL_DATASETS: tuple[str, ...] = (
    "global",
    "raw_1m",
    "canonical",
    "corp_actions",
    "sec_filings",
    "orats_cores",
    "orats_summaries",
    "orats_earnings",
    "orats_wham",
    "orats_gex_opex",
    "massive_unusual",
    "massive_oi",
    "float_snapshots",
    "earnings_reconciled",
)


def default_oracle_root() -> Path:
    return Path(__file__).resolve().parents[2]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


def verify_parquet_file(
    path: Path,
    expected_columns: Iterable[str],
    expected_row_count: int | None = None,
    expected_hash: str | None = None,
) -> tuple[bool, str]:
    if not path.is_file():
        return False, "FILE_MISSING"
    try:
        actual_hash = sha256_file(path)
        if expected_hash is not None and actual_hash != expected_hash:
            return False, "HASH_MISMATCH"
        df = pl.read_parquet(path)
    except Exception as exc:
        return False, f"PARQUET_CORRUPT:{type(exc).__name__}"
    missing_cols = [c for c in expected_columns if c not in df.columns]
    if missing_cols:
        return False, f"SCHEMA_MISSING_COLS:{','.join(missing_cols)}"
    if expected_row_count is not None and df.height != expected_row_count:
        return False, f"ROW_COUNT_MISMATCH:{df.height}!={expected_row_count}"
    return True, actual_hash


def write_parquet_atomic(df: pl.DataFrame, target_path: Path) -> tuple[int, str]:
    """Write Parquet to a temp file, verify readable + row count + hash, then ``os.replace``."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_name(f".{target_path.name}.tmp.{os.getpid()}")
    try:
        df.write_parquet(tmp_path)
        check_df = pl.read_parquet(tmp_path)
        if check_df.height != df.height:
            raise IOError(f"Written row count mismatch: {check_df.height} != {df.height}")
        digest = sha256_file(tmp_path)
        os.replace(tmp_path, target_path)
        return check_df.height, digest
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def write_json_atomic(payload: Mapping[str, Any], target_path: Path, sanitizer: SecretSanitizer) -> None:
    """Write sanitized, strictly NaN/Inf-free JSON atomically."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_name(f".{target_path.name}.tmp.{os.getpid()}")
    text = json.dumps(payload, indent=2, sort_keys=True, allow_nan=False)
    text = sanitizer.sanitize_text(text)
    try:
        tmp_path.write_text(text, encoding="utf-8")
        os.replace(tmp_path, target_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


class ManifestStore:
    """Atomic JSON manifest manager with per-partition locking and hash validation."""

    def __init__(self, manifest_path: Path, sanitizer: SecretSanitizer) -> None:
        self.path = manifest_path
        self.sanitizer = sanitizer
        self._lock = asyncio.Lock()
        self._partition_locks: dict[str, asyncio.Lock] = {}
        self._data: dict[str, Any] = self._load_initial()

    def _load_initial(self) -> dict[str, Any]:
        if self.path.is_file():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and "partitions" in loaded:
                    return loaded
            except Exception:
                pass
        return {
            "schema_version": SCHEMA_VERSION,
            "updated_at_utc_s": int(time.time()),
            "partitions": {},
            "provider_runs": [],
        }

    def partition_lock(self, key: str) -> asyncio.Lock:
        if key not in self._partition_locks:
            self._partition_locks[key] = asyncio.Lock()
        return self._partition_locks[key]

    def get_entry(self, key: str) -> dict[str, Any] | None:
        raw = self._data["partitions"].get(key)
        return dict(raw) if isinstance(raw, dict) else None

    def can_resume_skip(
        self,
        key: str,
        *,
        requested_start: str,
        requested_end: str,
        expected_columns: Iterable[str],
        file_path: Path | None,
        expected_source_hashes: Mapping[str, str] | None = None,
        force: bool = False,
    ) -> bool:
        if force:
            return False
        entry = self.get_entry(key)
        if entry is None:
            return False
        if entry.get("schema_version") != SCHEMA_VERSION:
            return False
        if entry.get("status") not in VALID_TERMINAL_SKIP_STATUSES:
            return False
        if entry.get("requested_start") != requested_start or entry.get("requested_end") != requested_end:
            return False
        if expected_source_hashes is not None:
            if entry.get("source_hashes") != dict(expected_source_hashes):
                return False
        if entry.get("status") == "COMPLETE":
            if file_path is None:
                return False
            exp_rows = entry.get("row_count")
            exp_hash = entry.get("content_hash")
            ok, _ = verify_parquet_file(file_path, expected_columns, exp_rows, exp_hash)
            return ok
        # For EMPTY_VERIFIED / UNSUPPORTED_COVERAGE, if file exists it must still be valid.
        if file_path is not None and file_path.is_file():
            exp_rows = entry.get("row_count", 0)
            exp_hash = entry.get("content_hash")
            ok, _ = verify_parquet_file(file_path, expected_columns, exp_rows, exp_hash)
            return ok
        return True

    async def set_entry(self, key: str, payload: Mapping[str, Any]) -> None:
        async with self._lock:
            clean_payload = {
                k: (self.sanitizer.sanitize_text(v) if isinstance(v, str) else v)
                for k, v in payload.items()
            }
            clean_payload["schema_version"] = SCHEMA_VERSION
            clean_payload["updated_at_utc_s"] = int(time.time())
            self._data["partitions"][key] = clean_payload
            self._save_atomic()

    async def record_run_summary(self, summary: Mapping[str, Any]) -> None:
        async with self._lock:
            self._data["provider_runs"].append(dict(summary))
            self._save_atomic()

    def snapshot_partitions(self) -> dict[str, dict[str, Any]]:
        return dict(self._data["partitions"])

    def _save_atomic(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data["updated_at_utc_s"] = int(time.time())
        tmp = self.path.with_name(f".{self.path.name}.tmp.{os.getpid()}")
        text = json.dumps(self._data, indent=2, sort_keys=True)
        # Safety invariant: reject secret leakage before saving manifest.
        text = self.sanitizer.sanitize_text(text)
        try:
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, self.path)
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass


def _effective_window(
    window_start: dt.date,
    window_end: dt.date,
    inst: InstrumentSpec,
) -> tuple[dt.date, dt.date, bool]:
    eff_end = min(window_end, inst.delisted_date) if inst.is_delisted and inst.delisted_date else window_end
    return window_start, eff_end, window_start <= eff_end


def _year_ranges(s_date: dt.date, e_date: dt.date) -> list[tuple[int, dt.date, dt.date]]:
    if s_date > e_date:
        return []
    out: list[tuple[int, dt.date, dt.date]] = []
    for y in range(s_date.year, e_date.year + 1):
        ys = max(s_date, dt.date(y, 1, 1))
        ye = min(e_date, dt.date(y, 12, 31))
        if ys <= ye:
            out.append((y, ys, ye))
    return out


def _entry_dict(
    *,
    provider: str,
    requested_start: str,
    requested_end: str,
    actual_start: str,
    actual_end: str,
    row_count: int,
    content_hash: str,
    status: PartitionStatus,
    last_completed_partition: str,
    requests: int = 0,
    retry_count: int = 0,
    error_summary: str = "",
    **extra: Any,
) -> dict[str, Any]:
    d: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "provider": provider,
        "requested_start": requested_start,
        "requested_end": requested_end,
        "actual_start": actual_start,
        "actual_end": actual_end,
        "row_count": int(row_count),
        "content_hash": content_hash,
        "status": status,
        "last_completed_partition": last_completed_partition,
        "requests": int(requests),
        "retry_count": int(retry_count),
        "error_summary": error_summary,
    }
    d.update(extra)
    return d


@dataclass(frozen=True)
class IngestionRunResult:
    tickers: tuple[str, ...]
    data_dir: Path
    manifest_path: Path
    report_path: Path
    provider_metrics: dict[str, Any]
    partitions: dict[str, dict[str, Any]]
    duration_s: float


async def run_ingestion(
    *,
    tickers: Sequence[str] | None = None,
    all_universe: bool = False,
    force: bool = False,
    datasets: Sequence[str] | None = None,
    start_date: dt.date | None = None,
    end_date: dt.date | None = None,
    include_post_opex_tickers: Sequence[str] = ("SPY",),
    event_gated: bool = True,
    max_pages_per_unusual_day: int = 15,
    max_total_unusual_pages: int = 600,
    data_dir: Path | None = None,
    report_path: Path | None = None,
    credentials: OracleCredentials | None = None,
    transport: AsyncProviderTransport | None = None,
    universe: PilotUniverse | None = None,
    max_requests_per_provider: int | None = None,
) -> IngestionRunResult:
    """Execute resumable, checkpointed ingestion for requested universe tickers."""
    t0 = time.monotonic()
    root = default_oracle_root()
    data_root = data_dir if data_dir is not None else (root / "data")
    if report_path is not None:
        rep_path = report_path
    elif all_universe:
        rep_path = root / "reports" / "ingest_full56_audit.md"
    else:
        rep_path = root / "reports" / "ingest_audit_report.md"
    uni = universe if universe is not None else load_pilot_universe()
    creds = credentials if credentials is not None else load_oracle_credentials()

    selected_datasets = set(datasets) if datasets else set(ALL_DATASETS)
    unknown_ds = selected_datasets - set(ALL_DATASETS)
    if unknown_ds:
        raise ValueError(f"Unknown dataset(s): {sorted(unknown_ds)}")

    if all_universe:
        target_specs = list(uni.instruments)
    elif tickers:
        by_sym = {i.ticker: i for i in uni.instruments}
        target_specs = []
        for t in tickers:
            sym = t.strip().upper()
            if sym not in by_sym:
                raise ValueError(f"Ticker {sym!r} is not in frozen pilot_universe.json")
            target_specs.append(by_sym[sym])
    else:
        target_specs = [uni.by_ticker(s) for s in ("SPY", "NVDA", "MELI", "TWTR")]

    post_opex_set = {s.strip().upper() for s in include_post_opex_tickers}
    core_w_start = start_date if start_date is not None else uni.windows.core.start
    core_w_end = end_date if end_date is not None else uni.windows.core.end
    opra_w_start = max(core_w_start, uni.windows.opra_flow.start)
    wham_w_start = max(core_w_start, uni.windows.macro_wham.start)

    manifest = ManifestStore(data_root / "manifests" / "ingest_state.json", creds.sanitizer)

    owns_transport = transport is None
    if transport is None:
        n_targets = max(1, len(target_specs))
        if max_requests_per_provider is not None:
            transport = AsyncProviderTransport(
                creds,
                budget_by_provider={
                    "massive": max_requests_per_provider,
                    "orats": max_requests_per_provider,
                    "fmp": max_requests_per_provider,
                },
            )
        else:
            transport = AsyncProviderTransport(
                creds,
                budget_by_domain={
                    "MASSIVE_STOCKS_REST": max(600, 120 * n_targets),
                    "MASSIVE_OPTIONS_REST": max(1500, 800 * n_targets),
                    "ORATS_HISTORICAL": max(1000, 100 * n_targets),
                    "FMP_ENTERPRISE": max(400, 50 * n_targets),
                },
            )

    massive = MassiveRestClient(transport)
    orats = OratsRestClient(transport)
    fmp = FmpRestClient(transport)

    try:
        # 1. Global datasets (downloaded once and reused)
        if "global" in selected_datasets:
            sp_path = data_root / "events" / "global" / "sp500_history.parquet"
            nq_path = data_root / "events" / "global" / "nasdaq_history.parquet"
            ec_path = data_root / "events" / "global" / "econ_calendar_us.parquet"
            sp_key = "global:sp500_history:all"
            nq_key = "global:nasdaq_history:all"
            ec_key = "global:econ_calendar_us:all"

            need_sp = not manifest.can_resume_skip(
                sp_key, requested_start=core_w_start.isoformat(), requested_end=core_w_end.isoformat(),
                expected_columns=INDEX_CONSTITUENTS_SCHEMA.keys(), file_path=sp_path, force=force,
            )
            need_nq = not manifest.can_resume_skip(
                nq_key, requested_start=core_w_start.isoformat(), requested_end=core_w_end.isoformat(),
                expected_columns=INDEX_CONSTITUENTS_SCHEMA.keys(), file_path=nq_path, force=force,
            )
            if need_sp or need_nq:
                sp_df, nq_df = await fmp.fetch_index_constituents_history()
                for g_key, g_path, g_df, lbl in (
                    (sp_key, sp_path, sp_df, "sp500_history"),
                    (nq_key, nq_path, nq_df, "nasdaq_history"),
                ):
                    async with manifest.partition_lock(g_key):
                        rc, digest = write_parquet_atomic(g_df, g_path)
                        act_s = str(g_df["effective_date"].min()) if rc > 0 else ""
                        act_e = str(g_df["effective_date"].max()) if rc > 0 else ""
                        await manifest.set_entry(
                            g_key,
                            _entry_dict(
                                provider="fmp",
                                requested_start=core_w_start.isoformat(),
                                requested_end=core_w_end.isoformat(),
                                actual_start=act_s,
                                actual_end=act_e,
                                row_count=rc,
                                content_hash=digest,
                                status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                last_completed_partition=lbl,
                                requests=1,
                            ),
                        )

            if not manifest.can_resume_skip(
                ec_key, requested_start=core_w_start.isoformat(), requested_end=core_w_end.isoformat(),
                expected_columns=ECON_CALENDAR_SCHEMA.keys(), file_path=ec_path, force=force,
            ):
                async with manifest.partition_lock(ec_key):
                    ec_df = await fmp.fetch_economic_calendar_us(core_w_start, core_w_end)
                    rc, digest = write_parquet_atomic(ec_df, ec_path)
                    act_s = str(ec_df["event_date"].min()) if rc > 0 else ""
                    act_e = str(ec_df["event_date"].max()) if rc > 0 else ""
                    await manifest.set_entry(
                        ec_key,
                        _entry_dict(
                            provider="fmp",
                            requested_start=core_w_start.isoformat(),
                            requested_end=core_w_end.isoformat(),
                            actual_start=act_s,
                            actual_end=act_e,
                            row_count=rc,
                            content_hash=digest,
                            status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                            last_completed_partition="econ_calendar_us",
                            requests=max(1, (core_w_end - core_w_start).days // 45 + 1),
                        ),
                    )

        float_records: list[dict[str, Any]] = []
        snap_path = data_root / "snapshots" / "float_snapshots.parquet"
        snap_global_entry = manifest.get_entry("global:float_snapshots:file")
        snap_ok_file, snap_file_hash = verify_parquet_file(
            snap_path,
            FLOAT_SNAPSHOT_SCHEMA.keys(),
            expected_row_count=snap_global_entry.get("row_count") if snap_global_entry else None,
            expected_hash=snap_global_entry.get("content_hash") if snap_global_entry else None,
        )
        existing_snaps = pl.read_parquet(snap_path) if snap_ok_file else pl.DataFrame(schema=FLOAT_SNAPSHOT_SCHEMA)

        # 2. Per-instrument concurrent pipeline + batched ORATS WHAM / GEX-OpEx + FAILED_RETRYABLE recovery
        ticker_sem = asyncio.Semaphore(4)
        pending_wham_by_window: dict[tuple[dt.date, dt.date], list[InstrumentSpec]] = {}
        pending_opex_jobs: list[tuple[InstrumentSpec, dt.date, dt.date, list[Any], str, dict[str, str], dict[str, Any], dict[str, float]]] = []
        failed_retryable_tickers: set[str] = set()

        async def _mark_retryable(
            p_key: str,
            *,
            provider: str,
            req_s: str,
            req_e: str,
            last_part: str,
            sym_err: str,
            exc: BaseException,
            extra_id: Mapping[str, Any],
        ) -> None:
            failed_retryable_tickers.add(sym_err)
            await manifest.set_entry(
                p_key,
                _entry_dict(
                    provider=provider,
                    requested_start=req_s,
                    requested_end=req_e,
                    actual_start="",
                    actual_end="",
                    row_count=0,
                    content_hash="",
                    status="FAILED_RETRYABLE",
                    last_completed_partition=last_part,
                    error_summary=creds.sanitizer.sanitize_exception(exc),
                    **extra_id,
                ),
            )

        async def _process_one_instrument(inst: InstrumentSpec) -> None:
            sym = inst.ticker
            eff_s, eff_e, non_empty_core = _effective_window(core_w_start, core_w_end, inst)
            extra_id = (
                {"composite_figi": inst.composite_figi, "cik": inst.cik, "delisted_date": inst.delisted_date.isoformat()}
                if inst.is_delisted and inst.delisted_date
                else {}
            )

            async with ticker_sem:
                # 2A. Raw Massive 1m partitioned by year
                raw_hashes: dict[str, str] = {}
                year_frames: list[pl.DataFrame] = []
                if "raw_1m" in selected_datasets:
                    if not non_empty_core:
                        p_key = f"{sym}:raw_1m:empty"
                        await manifest.set_entry(
                            p_key,
                            _entry_dict(
                                provider="massive", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                actual_start="", actual_end="", row_count=0, content_hash="", status="EMPTY_VERIFIED",
                                last_completed_partition="NONE", **extra_id,
                            ),
                        )
                    else:
                        for yr, ys, ye in _year_ranges(eff_s, eff_e):
                            p_path = data_root / "raw" / "massive_1m" / sym / f"{yr}.parquet"
                            q_path = data_root / "raw" / "massive_1m_quarantine" / sym / f"{yr}.parquet"
                            p_key = f"{sym}:raw_1m:{yr}"
                            if manifest.can_resume_skip(
                                p_key, requested_start=ys.isoformat(), requested_end=ye.isoformat(),
                                expected_columns=RAW_1M_SCHEMA.keys(), file_path=p_path, force=force,
                            ):
                                entry = manifest.get_entry(p_key)
                                if entry and entry.get("content_hash"):
                                    raw_hashes[str(yr)] = str(entry["content_hash"])
                                if p_path.is_file():
                                    year_frames.append(pl.read_parquet(p_path))
                                continue

                            async with manifest.partition_lock(p_key):
                                try:
                                    res = await massive.fetch_aggs_1m_raw(sym, ys, ye)
                                except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                    raise
                                except Exception as exc:
                                    await _mark_retryable(
                                        p_key, provider="massive", req_s=ys.isoformat(), req_e=ye.isoformat(),
                                        last_part=str(yr), sym_err=sym, exc=exc, extra_id=extra_id,
                                    )
                                    continue
                                df_yr = res.bars
                                if inst.is_delisted and inst.delisted_date and df_yr.height > 0:
                                    cutoff_next_et = dt.datetime(
                                        inst.delisted_date.year, inst.delisted_date.month, inst.delisted_date.day,
                                        20, 0, tzinfo=ET_TZ,
                                    )
                                    df_yr = df_yr.filter(pl.col("ts_utc_s") < int(cutoff_next_et.timestamp()))

                                rc, digest = write_parquet_atomic(df_yr, p_path)
                                if res.quarantine.height > 0:
                                    write_parquet_atomic(res.quarantine, q_path)
                                act_s = dt.datetime.fromtimestamp(int(df_yr["ts_utc_s"].min()), ET_TZ).date().isoformat() if rc > 0 else ""
                                act_e = dt.datetime.fromtimestamp(int(df_yr["ts_utc_s"].max()), ET_TZ).date().isoformat() if rc > 0 else ""
                                raw_hashes[str(yr)] = digest
                                if rc > 0:
                                    year_frames.append(df_yr)
                                await manifest.set_entry(
                                    p_key,
                                    _entry_dict(
                                        provider="massive",
                                        requested_start=ys.isoformat(),
                                        requested_end=ye.isoformat(),
                                        actual_start=act_s,
                                        actual_end=act_e,
                                        row_count=rc,
                                        content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition=str(yr),
                                        requests=res.pages,
                                        rows_received=res.rows_received,
                                        rows_quarantined=res.rows_quarantined,
                                        duplicates_exact=res.duplicates_exact,
                                        vw_outside_ohlc_count=res.vw_outside_ohlc_count,
                                        last_observed_session=act_e,
                                        **extra_id,
                                    ),
                                )
                else:
                    for yr, _, _ in _year_ranges(eff_s, eff_e):
                        p_path = data_root / "raw" / "massive_1m" / sym / f"{yr}.parquet"
                        entry = manifest.get_entry(f"{sym}:raw_1m:{yr}")
                        if entry and entry.get("content_hash"):
                            raw_hashes[str(yr)] = str(entry["content_hash"])
                        if p_path.is_file():
                            year_frames.append(pl.read_parquet(p_path))

                df_1m_all = (
                    pl.concat(year_frames, how="vertical").sort("ts_utc_s")
                    if year_frames
                    else pl.DataFrame(schema=RAW_1M_SCHEMA)
                )
                all_1m_for_math = df_1m_all.rename({"v": "volume"}) if df_1m_all.height > 0 else pl.DataFrame(
                    schema={**{k: v for k, v in RAW_1M_SCHEMA.items() if k != "v"}, "volume": pl.Float64}
                )

                # 2B. Canonical RTH rollups
                daily_spot_map: dict[str, float] = {}
                if "canonical" in selected_datasets:
                    for tf in CANONICAL_TIMEFRAMES:
                        c_path = data_root / "canonical" / f"rth_{tf}" / f"{sym}.parquet"
                        c_key = f"{sym}:canonical:rth_{tf}"
                        if manifest.can_resume_skip(
                            c_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                            expected_columns=CANONICAL_PARQUET_SCHEMA.keys(), file_path=c_path,
                            expected_source_hashes=raw_hashes, force=force,
                        ):
                            if tf == "1D" and c_path.is_file():
                                d_df = pl.read_parquet(c_path)
                                daily_spot_map = {str(r["trade_date"]): float(r["c"]) for r in d_df.select(["trade_date", "c"]).to_dicts()}
                            continue
                        async with manifest.partition_lock(c_key):
                            can_df, rep = build_canonical_rth_bars_with_audit(all_1m_for_math, tf)
                            rc, digest = write_parquet_atomic(can_df, c_path)
                            act_s = str(can_df["trade_date"].min()) if rc > 0 else ""
                            act_e = str(can_df["trade_date"].max()) if rc > 0 else ""
                            if tf == "1D" and rc > 0:
                                daily_spot_map = {str(r["trade_date"]): float(r["c"]) for r in can_df.select(["trade_date", "c"]).to_dicts()}
                            await manifest.set_entry(
                                c_key,
                                _entry_dict(
                                    provider="internal_math_core",
                                    requested_start=eff_s.isoformat(),
                                    requested_end=eff_e.isoformat(),
                                    actual_start=act_s,
                                    actual_end=act_e,
                                    row_count=rc,
                                    content_hash=digest,
                                    status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                    last_completed_partition=f"rth_{tf}",
                                    source_hashes=raw_hashes,
                                    accepted_rth_1m_rows=rep.accepted_rth_1m_rows,
                                    excluded_non_rth=rep.excluded_non_rth,
                                    excluded_non_positive_volume=rep.excluded_non_positive_volume,
                                    excluded_invalid_vw=rep.excluded_invalid_vw,
                                    excluded_invalid_ohlc=rep.excluded_invalid_ohlc,
                                    last_observed_session=act_e,
                                    **extra_id,
                                ),
                            )
                elif (data_root / "canonical" / "rth_1D" / f"{sym}.parquet").is_file():
                    d_df = pl.read_parquet(data_root / "canonical" / "rth_1D" / f"{sym}.parquet")
                    daily_spot_map = {str(r["trade_date"]): float(r["c"]) for r in d_df.select(["trade_date", "c"]).to_dicts()}

                # 2C. Corporate actions (Massive vs FMP reconciliation)
                if "corp_actions" in selected_datasets:
                    sp_path = data_root / "events" / "corporate_actions" / f"{sym}_splits.parquet"
                    dv_path = data_root / "events" / "corporate_actions" / f"{sym}_dividends.parquet"
                    sp_key = f"{sym}:corp_actions:splits"
                    dv_key = f"{sym}:corp_actions:dividends"
                    skip_sp = manifest.can_resume_skip(
                        sp_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=RECONCILED_SPLITS_SCHEMA.keys(), file_path=sp_path, force=force,
                    )
                    skip_dv = manifest.can_resume_skip(
                        dv_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=RECONCILED_DIVIDENDS_SCHEMA.keys(), file_path=dv_path, force=force,
                    )
                    if not (skip_sp and skip_dv):
                        try:
                            m_splits_df, f_splits_df, m_divs_df, f_divs_df = await asyncio.gather(
                                massive.fetch_splits(sym),
                                fmp.fetch_splits(sym),
                                massive.fetch_dividends(sym),
                                fmp.fetch_dividends(sym),
                            )
                            if inst.is_delisted and inst.delisted_date:
                                cut = inst.delisted_date.isoformat()
                                m_splits_df = m_splits_df.filter(pl.col("execution_date") <= cut)
                                f_splits_df = f_splits_df.filter(pl.col("execution_date") <= cut)
                                m_divs_df = m_divs_df.filter(pl.col("ex_dividend_date") <= cut)
                                f_divs_df = f_divs_df.filter(pl.col("ex_dividend_date") <= cut)
                            rec = reconcile_corporate_actions(m_splits_df, f_splits_df, m_divs_df, f_divs_df)

                            async with manifest.partition_lock(sp_key):
                                rc, digest = write_parquet_atomic(rec.splits, sp_path)
                                act_s = str(rec.splits["effective_date"].min()) if rc > 0 else ""
                                act_e = str(rec.splits["effective_date"].max()) if rc > 0 else ""
                                await manifest.set_entry(
                                    sp_key,
                                    _entry_dict(
                                        provider="massive+fmp", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition="splits", requests=2, conflict_count=rec.split_conflict_count, **extra_id,
                                    ),
                                )
                            async with manifest.partition_lock(dv_key):
                                rc, digest = write_parquet_atomic(rec.dividends, dv_path)
                                act_s = str(rec.dividends["ex_dividend_date"].min()) if rc > 0 else ""
                                act_e = str(rec.dividends["ex_dividend_date"].max()) if rc > 0 else ""
                                await manifest.set_entry(
                                    dv_key,
                                    _entry_dict(
                                        provider="massive+fmp", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition="dividends", requests=2, conflict_count=rec.dividend_conflict_count, **extra_id,
                                    ),
                                )
                        except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                            raise
                        except Exception as exc:
                            await _mark_retryable(
                                sp_key, provider="massive+fmp", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                last_part="splits", sym_err=sym, exc=exc, extra_id=extra_id,
                            )
                            await _mark_retryable(
                                dv_key, provider="massive+fmp", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                last_part="dividends", sym_err=sym, exc=exc, extra_id=extra_id,
                            )

                # 2D. SEC Filings
                if "sec_filings" in selected_datasets:
                    sec_path = data_root / "events" / "sec_filings" / f"{sym}.parquet"
                    sec_key = f"{sym}:sec_filings:all"
                    if not manifest.can_resume_skip(
                        sec_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=SEC_FILINGS_SCHEMA.keys(), file_path=sec_path, force=force,
                    ):
                        async with manifest.partition_lock(sec_key):
                            if not non_empty_core:
                                sec_df = pl.DataFrame(schema=SEC_FILINGS_SCHEMA)
                                rc, digest = write_parquet_atomic(sec_df, sec_path)
                                await manifest.set_entry(
                                    sec_key,
                                    _entry_dict(
                                        provider="fmp", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest, status="EMPTY_VERIFIED",
                                        last_completed_partition="sec_filings", **extra_id,
                                    ),
                                )
                            else:
                                try:
                                    sec_res = await fmp.fetch_sec_filings(sym, eff_s, eff_e)
                                    sec_df = sec_res.data
                                    if inst.is_delisted and inst.delisted_date and sec_df.height > 0:
                                        sec_df = sec_df.filter(pl.col("filing_date") <= inst.delisted_date.isoformat())
                                    rc, digest = write_parquet_atomic(sec_df, sec_path)
                                    act_s = str(sec_df["filing_date"].min()) if rc > 0 else ""
                                    act_e = str(sec_df["filing_date"].max()) if rc > 0 else ""
                                    await manifest.set_entry(
                                        sec_key,
                                        _entry_dict(
                                            provider="fmp", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                            actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                            status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                            last_completed_partition="sec_filings", requests=sec_res.pages,
                                            truncation_warning=sec_res.truncation_warning, **extra_id,
                                        ),
                                    )
                                except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                    raise
                                except Exception as exc:
                                    await _mark_retryable(
                                        sec_key, provider="fmp", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                        last_part="sec_filings", sym_err=sym, exc=exc, extra_id=extra_id,
                                    )

                # 2E. ORATS cores & summaries (single-ticker range calls) + defer WHAM & GEX/OpEx to multi-ticker batch stage
                if "orats_cores" in selected_datasets:
                    oc_path = data_root / "derivatives" / "orats_cores" / f"{sym}.parquet"
                    oc_key = f"{sym}:orats_cores:all"
                    if not manifest.can_resume_skip(
                        oc_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=ORATS_CORES_SCHEMA.keys(), file_path=oc_path, force=force,
                    ):
                        async with manifest.partition_lock(oc_key):
                            try:
                                oc_df = await orats.fetch_hist_cores(sym, eff_s, eff_e) if non_empty_core else pl.DataFrame(schema=ORATS_CORES_SCHEMA)
                                rc, digest = write_parquet_atomic(oc_df, oc_path)
                                act_s = str(oc_df["trade_date"].min()) if rc > 0 else ""
                                act_e = str(oc_df["trade_date"].max()) if rc > 0 else ""
                                await manifest.set_entry(
                                    oc_key,
                                    _entry_dict(
                                        provider="orats", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition="orats_cores", requests=1 if non_empty_core else 0, **extra_id,
                                    ),
                                )
                            except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                raise
                            except Exception as exc:
                                await _mark_retryable(
                                    oc_key, provider="orats", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                    last_part="orats_cores", sym_err=sym, exc=exc, extra_id=extra_id,
                                )

                if "orats_summaries" in selected_datasets:
                    os_path = data_root / "derivatives" / "orats_summaries" / f"{sym}.parquet"
                    os_key = f"{sym}:orats_summaries:all"
                    if not manifest.can_resume_skip(
                        os_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=ORATS_SUMMARIES_SCHEMA.keys(), file_path=os_path, force=force,
                    ):
                        async with manifest.partition_lock(os_key):
                            try:
                                os_df = await orats.fetch_hist_summaries(sym, eff_s, eff_e) if non_empty_core else pl.DataFrame(schema=ORATS_SUMMARIES_SCHEMA)
                                rc, digest = write_parquet_atomic(os_df, os_path)
                                act_s = str(os_df["trade_date"].min()) if rc > 0 else ""
                                act_e = str(os_df["trade_date"].max()) if rc > 0 else ""
                                await manifest.set_entry(
                                    os_key,
                                    _entry_dict(
                                        provider="orats", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition="orats_summaries", requests=1 if non_empty_core else 0, **extra_id,
                                    ),
                                )
                            except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                raise
                            except Exception as exc:
                                await _mark_retryable(
                                    os_key, provider="orats", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                    last_part="orats_summaries", sym_err=sym, exc=exc, extra_id=extra_id,
                                )

                if "orats_wham" in selected_datasets:
                    wh_s, wh_e, non_empty_wham = _effective_window(wham_w_start, core_w_end, inst)
                    wh_path = data_root / "derivatives" / "orats_wham" / f"{sym}.parquet"
                    wh_key = f"{sym}:orats_wham:all"
                    if not manifest.can_resume_skip(
                        wh_key, requested_start=wh_s.isoformat(), requested_end=wh_e.isoformat(),
                        expected_columns=ORATS_WHAM_SCHEMA.keys(), file_path=wh_path, force=force,
                    ):
                        if inst.asset_class.value != "US_ETF":
                            async with manifest.partition_lock(wh_key):
                                wh_df = pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
                                rc, digest = write_parquet_atomic(wh_df, wh_path)
                                await manifest.set_entry(
                                    wh_key,
                                    _entry_dict(
                                        provider="orats", requested_start=wh_s.isoformat(), requested_end=wh_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest,
                                        status="EMPTY_VERIFIED", last_completed_partition="NOT_APPLICABLE_NON_ETF",
                                        coverage_scope="NOT_APPLICABLE_NON_ETF", **extra_id,
                                    ),
                                )
                        elif not non_empty_wham:
                            async with manifest.partition_lock(wh_key):
                                wh_df = pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
                                rc, digest = write_parquet_atomic(wh_df, wh_path)
                                await manifest.set_entry(
                                    wh_key,
                                    _entry_dict(
                                        provider="orats", requested_start=wh_s.isoformat(), requested_end=wh_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest,
                                        status="EMPTY_VERIFIED", last_completed_partition="EMPTY_WINDOW",
                                        coverage_scope="EMPTY_WINDOW", **extra_id,
                                    ),
                                )
                        else:
                            pending_wham_by_window.setdefault((wh_s, wh_e), []).append(inst)

                if "orats_gex_opex" in selected_datasets:
                    gx_path = data_root / "derivatives" / "orats_gex_opex" / f"{sym}.parquet"
                    gx_key = f"{sym}:orats_gex_opex:all"
                    inc_post = sym in post_opex_set
                    samp_mode = "PRE_OPEX+POST_OPEX" if inc_post else "PRE_OPEX"
                    gex_src_hashes = {**raw_hashes, "sampling_mode": samp_mode}
                    if not manifest.can_resume_skip(
                        gx_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=ORATS_GEX_OPEX_SCHEMA.keys(), file_path=gx_path,
                        expected_source_hashes=gex_src_hashes, force=force,
                    ):
                        sched = generate_opex_sampling_dates(eff_s, eff_e, include_post_opex=inc_post) if non_empty_core else []
                        if not sched:
                            async with manifest.partition_lock(gx_key):
                                gx_df = pl.DataFrame(schema=ORATS_GEX_OPEX_SCHEMA)
                                rc, digest = write_parquet_atomic(gx_df, gx_path)
                                await manifest.set_entry(
                                    gx_key,
                                    _entry_dict(
                                        provider="orats", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest,
                                        status="EMPTY_VERIFIED", last_completed_partition="EMPTY_SCHEDULE",
                                        sampling_mode=samp_mode, source_hashes=gex_src_hashes, **extra_id,
                                    ),
                                )
                        else:
                            pending_opex_jobs.append(
                                (inst, eff_s, eff_e, sched, samp_mode, gex_src_hashes, extra_id, daily_spot_map)
                            )

                # 2F. Massive Options Flow & Historical OI (>= 2022-09-01)
                op_s, op_e, non_empty_opra = _effective_window(opra_w_start, core_w_end, inst)

                if "massive_oi" in selected_datasets:
                    oi_path = data_root / "derivatives" / "massive_oi" / f"{sym}.parquet"
                    oi_key = f"{sym}:massive_oi:all"
                    if not manifest.can_resume_skip(
                        oi_key, requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                        expected_columns=OI_DAILY_SCHEMA.keys(), file_path=oi_path, force=force,
                    ):
                        async with manifest.partition_lock(oi_key):
                            if not non_empty_opra:
                                oi_df = pl.DataFrame(schema=OI_DAILY_SCHEMA)
                                rc, digest = write_parquet_atomic(oi_df, oi_path)
                                await manifest.set_entry(
                                    oi_key,
                                    _entry_dict(
                                        provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest,
                                        status="EMPTY_VERIFIED", last_completed_partition="EMPTY_WINDOW", **extra_id,
                                    ),
                                )
                            else:
                                try:
                                    res_oi = await massive.fetch_options_oi_underlying(sym, op_s, op_e)
                                    rc, digest = write_parquet_atomic(res_oi.data, oi_path)
                                    act_s = str(res_oi.data["trade_date"].min()) if rc > 0 else ""
                                    act_e = str(res_oi.data["trade_date"].max()) if rc > 0 else ""
                                    await manifest.set_entry(
                                        oi_key,
                                        _entry_dict(
                                            provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                            actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                            status=res_oi.status,
                                            last_completed_partition=act_e or "NONE", requests=res_oi.pages,
                                            rows_received=res_oi.rows_received, error_summary=res_oi.note or "", **extra_id,
                                        ),
                                    )
                                except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                    raise
                                except Exception as exc:
                                    await _mark_retryable(
                                        oi_key, provider="massive", req_s=op_s.isoformat(), req_e=op_e.isoformat(),
                                        last_part="massive_oi", sym_err=sym, exc=exc, extra_id=extra_id,
                                    )

                oc_local_path = data_root / "derivatives" / "orats_cores" / f"{sym}.parquet"
                oi_local_path = data_root / "derivatives" / "massive_oi" / f"{sym}.parquet"
                rec_oi_path = data_root / "derivatives" / "reconciled_oi" / f"{sym}.parquet"
                rec_oi_df = pl.DataFrame(schema=RECONCILED_DAILY_OI_SCHEMA)
                if oc_local_path.is_file() or oi_local_path.is_file():
                    oc_df_loc = pl.read_parquet(oc_local_path) if oc_local_path.is_file() else pl.DataFrame(schema=ORATS_CORES_SCHEMA)
                    oi_df_loc = pl.read_parquet(oi_local_path) if oi_local_path.is_file() else pl.DataFrame(schema=OI_DAILY_SCHEMA)
                    rec_oi_df = reconcile_daily_oi(oc_df_loc, oi_df_loc)
                    write_parquet_atomic(rec_oi_df, rec_oi_path)

                if "massive_unusual" in selected_datasets:
                    mu_path = data_root / "derivatives" / "massive_unusual" / f"{sym}.parquet"
                    mu_cov_path = data_root / "manifests" / f"unusual_coverage_{sym}.json"
                    mu_key = f"{sym}:massive_unusual:all"
                    expected_mu_cols = (
                        UNUSUAL_DAILY_SUMMARY_SCHEMA.keys() if event_gated else UNUSUAL_TRADES_SCHEMA.keys()
                    )
                    if not manifest.can_resume_skip(
                        mu_key, requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                        expected_columns=expected_mu_cols, file_path=mu_path, force=force,
                    ):
                        async with manifest.partition_lock(mu_key):
                            if not non_empty_opra:
                                schema_empty = UNUSUAL_DAILY_SUMMARY_SCHEMA if event_gated else UNUSUAL_TRADES_SCHEMA
                                mu_df = pl.DataFrame(schema=schema_empty)
                                rc, digest = write_parquet_atomic(mu_df, mu_path)
                                await manifest.set_entry(
                                    mu_key,
                                    _entry_dict(
                                        provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                        actual_start="", actual_end="", row_count=rc, content_hash=digest,
                                        status="EMPTY_VERIFIED", last_completed_partition="EMPTY_WINDOW",
                                        coverage_scope="EMPTY_WINDOW", **extra_id,
                                    ),
                                )
                            elif event_gated:
                                oc_df_loc = pl.read_parquet(oc_local_path) if oc_local_path.is_file() else pl.DataFrame(schema=ORATS_CORES_SCHEMA)
                                cand_df = select_unusual_event_gated_dates(oc_df_loc, rec_oi_df, op_s, op_e)

                                existing_entry = manifest.get_entry(mu_key)
                                raw_complete_ok = False
                                if (
                                    not force
                                    and existing_entry is not None
                                    and existing_entry.get("status") == "COMPLETE"
                                    and mu_path.is_file()
                                ):
                                    raw_complete_ok, _ = verify_parquet_file(
                                        mu_path,
                                        UNUSUAL_TRADES_SCHEMA.keys(),
                                        expected_row_count=existing_entry.get("row_count"),
                                        expected_hash=existing_entry.get("content_hash"),
                                    )

                                if raw_complete_ok:
                                    raw_df_loc = pl.read_parquet(mu_path)
                                    sum_df = reduce_raw_unusual_trades_to_summary(sym, raw_df_loc, cand_df)
                                    target_tds = cand_df["trade_date"].to_list() if cand_df.height > 0 else []
                                    cov_u = {
                                        "ticker": sym,
                                        "candidate_dates": target_tds,
                                        "completed_dates": target_tds,
                                        "remaining_dates": [],
                                        "partial_dates": [],
                                        "errors": [],
                                        "requests_made": 0,
                                        "raw_rows_scanned": raw_df_loc.height,
                                        "coverage_scope": "EVENT_GATED_COMPLETE",
                                        "source_mode": "LOCAL_COMPLETE_RAW_REDUCED_ZERO_HTTP",
                                    }
                                    write_json_atomic(cov_u, mu_cov_path, creds.sanitizer)
                                    rc, digest = write_parquet_atomic(sum_df, mu_path)
                                    act_s = str(sum_df["trade_date"].min()) if rc > 0 else ""
                                    act_e = str(sum_df["trade_date"].max()) if rc > 0 else ""
                                    st_u: PartitionStatus = "COMPLETE" if rc > 0 or len(target_tds) == 0 else "EMPTY_VERIFIED"
                                    await manifest.set_entry(
                                        mu_key,
                                        _entry_dict(
                                            provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                            actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                            status=st_u, last_completed_partition=act_e or "NONE",
                                            requests=0, rows_received=raw_df_loc.height,
                                            coverage_scope="EVENT_GATED_COMPLETE", **extra_id,
                                        ),
                                    )
                                else:
                                    ex_sum_df = None
                                    if not force and mu_path.is_file():
                                        ok_sum, _ = verify_parquet_file(mu_path, UNUSUAL_DAILY_SUMMARY_SCHEMA.keys())
                                        if ok_sum:
                                            ex_sum_df = pl.read_parquet(mu_path)

                                    try:
                                        res_eg = await massive.fetch_options_unusual_event_gated(
                                            sym,
                                            cand_df,
                                            event_gated=True,
                                            max_pages_per_day=max_pages_per_unusual_day,
                                            max_total_pages=max_total_unusual_pages,
                                            existing_summary_df=ex_sum_df,
                                        )
                                        cov_u = dict(res_eg.coverage_manifest)
                                        write_json_atomic(cov_u, mu_cov_path, creds.sanitizer)
                                        rc, digest = write_parquet_atomic(res_eg.data, mu_path)
                                        act_s = str(res_eg.data["trade_date"].min()) if rc > 0 else ""
                                        act_e = str(res_eg.data["trade_date"].max()) if rc > 0 else ""
                                        await manifest.set_entry(
                                            mu_key,
                                            _entry_dict(
                                                provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                                actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                                status=res_eg.status, last_completed_partition=act_e or "NONE",
                                                requests=res_eg.requests_made, rows_received=res_eg.raw_rows_scanned,
                                                coverage_scope=res_eg.coverage_scope,
                                                candidate_date_count=len(cov_u.get("candidate_dates") or []),
                                                completed_date_count=len(cov_u.get("completed_dates") or []),
                                                remaining_date_count=len(cov_u.get("remaining_dates") or []),
                                                error_summary=res_eg.note or "", **extra_id,
                                            ),
                                        )
                                    except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                        raise
                                    except Exception as exc:
                                        await _mark_retryable(
                                            mu_key, provider="massive", req_s=op_s.isoformat(), req_e=op_e.isoformat(),
                                            last_part="massive_unusual", sym_err=sym, exc=exc, extra_id=extra_id,
                                        )
                            else:
                                try:
                                    res_un = await massive.fetch_options_unusual_trades(sym, op_s, op_e)
                                    rc, digest = write_parquet_atomic(res_un.data, mu_path)
                                    act_s = dt.datetime.fromtimestamp(int(res_un.data["ts_utc_s"].min()), ET_TZ).date().isoformat() if rc > 0 else ""
                                    act_e = dt.datetime.fromtimestamp(int(res_un.data["ts_utc_s"].max()), ET_TZ).date().isoformat() if rc > 0 else ""
                                    await manifest.set_entry(
                                        mu_key,
                                        _entry_dict(
                                            provider="massive", requested_start=op_s.isoformat(), requested_end=op_e.isoformat(),
                                            actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                            status=res_un.status,
                                            last_completed_partition=act_e or "NONE", requests=res_un.pages,
                                            rows_received=res_un.rows_received, error_summary=res_un.note or "", **extra_id,
                                        ),
                                    )
                                except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                    raise
                                except Exception as exc:
                                    await _mark_retryable(
                                        mu_key, provider="massive", req_s=op_s.isoformat(), req_e=op_e.isoformat(),
                                        last_part="massive_unusual", sym_err=sym, exc=exc, extra_id=extra_id,
                                    )

                # 2G. Float snapshot (Massive vX + FMP current snapshots)
                if "float_snapshots" in selected_datasets:
                    fl_key = f"{sym}:float_snapshots:latest"
                    fl_entry = manifest.get_entry(fl_key)
                    has_sym = existing_snaps.filter(pl.col("ticker") == sym).height > 0 if existing_snaps.height > 0 else False
                    snap_ok = snap_ok_file and (
                        (fl_entry is not None and fl_entry.get("status") == "EMPTY_VERIFIED")
                        or has_sym
                    )
                    if not (
                        not force
                        and snap_ok
                        and manifest.can_resume_skip(
                            fl_key, requested_start=eff_e.isoformat(), requested_end=eff_e.isoformat(),
                            expected_columns=FLOAT_SNAPSHOT_SCHEMA.keys(), file_path=None,
                        )
                    ):
                        try:
                            m_fl, f_fl = await asyncio.gather(
                                massive.fetch_float_snapshot(sym),
                                fmp.fetch_shares_float(sym),
                            )
                            recs = [r for r in (m_fl, f_fl) if r is not None]
                            float_records.extend(recs)
                            await manifest.set_entry(
                                fl_key,
                                _entry_dict(
                                    provider="massive+fmp", requested_start=eff_e.isoformat(), requested_end=eff_e.isoformat(),
                                    actual_start=eff_e.isoformat() if recs else "", actual_end=eff_e.isoformat() if recs else "",
                                    row_count=len(recs), content_hash="",
                                    status="COMPLETE" if recs else "EMPTY_VERIFIED",
                                    last_completed_partition="float_snapshots", requests=2, **extra_id,
                                ),
                            )
                        except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                            raise
                        except Exception as exc:
                            await _mark_retryable(
                                fl_key, provider="massive+fmp", req_s=eff_e.isoformat(), req_e=eff_e.isoformat(),
                                last_part="float_snapshots", sym_err=sym, exc=exc, extra_id=extra_id,
                            )

                # 2H. Earnings reconciled (ORATS primary + Massive ETH inference + FMP cross-check)
                if "earnings_reconciled" in selected_datasets:
                    er_path = data_root / "events" / "earnings_reconciled" / f"{sym}.parquet"
                    er_key = f"{sym}:earnings_reconciled:all"
                    if not manifest.can_resume_skip(
                        er_key, requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                        expected_columns=RECONCILED_EARNINGS_SCHEMA.keys(), file_path=er_path,
                        expected_source_hashes=raw_hashes, force=force,
                    ):
                        async with manifest.partition_lock(er_key):
                            try:
                                fmp_er, orats_er = await asyncio.gather(
                                    fmp.fetch_earnings(sym),
                                    orats.fetch_hist_earnings(sym),
                                )
                                if non_empty_core:
                                    fmp_er = fmp_er.filter((pl.col("earn_date") >= eff_s.isoformat()) & (pl.col("earn_date") <= eff_e.isoformat()))
                                    orats_er = orats_er.filter((pl.col("earn_date") >= eff_s.isoformat()) & (pl.col("earn_date") <= eff_e.isoformat()))
                                rec_er = await reconcile_earnings_calendar_async(
                                    fmp_er, orats_er, df_1m_all, open_close_fetcher=massive.fetch_open_close
                                )
                                rc, digest = write_parquet_atomic(rec_er, er_path)
                                act_s = str(rec_er["earn_date_canonical"].min()) if rc > 0 else ""
                                act_e = str(rec_er["earn_date_canonical"].max()) if rc > 0 else ""
                                await manifest.set_entry(
                                    er_key,
                                    _entry_dict(
                                        provider="orats+fmp+massive", requested_start=eff_s.isoformat(), requested_end=eff_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status="COMPLETE" if rc > 0 else "EMPTY_VERIFIED",
                                        last_completed_partition="earnings_reconciled", requests=2,
                                        source_hashes=raw_hashes, **extra_id,
                                    ),
                                )
                            except (ProviderAuthorizationError, BudgetExceededError, asyncio.CancelledError):
                                raise
                            except Exception as exc:
                                await _mark_retryable(
                                    er_key, provider="orats+fmp+massive", req_s=eff_s.isoformat(), req_e=eff_e.isoformat(),
                                    last_part="earnings_reconciled", sym_err=sym, exc=exc, extra_id=extra_id,
                                )

        async def _flush_orats_batches() -> None:
            # Batched WHAM for remaining US_ETFs (deduplicated to latest quoteDate)
            if pending_wham_by_window:
                ec_path = data_root / "events" / "global" / "econ_calendar_us.parquet"
                ec_df_local = pl.read_parquet(ec_path) if ec_path.is_file() else pl.DataFrame(schema=ECON_CALENDAR_SCHEMA)
                for (wh_s, wh_e), inst_list in sorted(pending_wham_by_window.items()):
                    macro_sched = resolve_macro_wham_schedule(ec_df_local, wh_s, wh_e)
                    if macro_sched.target_dates:
                        target_dates = list(macro_sched.target_dates)
                        etf_syms = [i.ticker for i in inst_list]
                        ex_dfs: dict[str, pl.DataFrame] = {}
                        ex_abs: dict[str, list[str]] = {}
                        for i_sp in inst_list:
                            s_etf = i_sp.ticker
                            wp = data_root / "derivatives" / "orats_wham" / f"{s_etf}.parquet"
                            cp = data_root / "manifests" / f"wham_coverage_{s_etf}.json"
                            ex_dfs[s_etf] = pl.read_parquet(wp) if (wp.is_file() and not force) else pl.DataFrame(schema=ORATS_WHAM_SCHEMA)
                            if cp.is_file() and not force:
                                try:
                                    ex_abs[s_etf] = list(json.loads(cp.read_text(encoding="utf-8")).get("verified_absent_dates") or [])
                                except Exception:
                                    ex_abs[s_etf] = []
                            else:
                                ex_abs[s_etf] = []
                        batch_res = await orats.fetch_hist_wham_macro_batch(
                            etf_syms,
                            target_dates,
                            asset_classes={s: "US_ETF" for s in etf_syms},
                            existing_df_by_ticker=ex_dfs,
                            existing_absent_by_ticker=ex_abs,
                            batch_size=10,
                        )
                        for i_sp in inst_list:
                            s_etf = i_sp.ticker
                            wp = data_root / "derivatives" / "orats_wham" / f"{s_etf}.parquet"
                            cp = data_root / "manifests" / f"wham_coverage_{s_etf}.json"
                            wk = f"{s_etf}:orats_wham:all"
                            wh_df_out = batch_res.by_ticker_data[s_etf]
                            cov_m = dict(batch_res.by_ticker_manifest[s_etf])
                            cov_m["macro_events_mapped"] = [
                                {
                                    "macro_event_type": ev.macro_event_type,
                                    "event_date": ev.event_date,
                                    "scheduled_ts_utc_s": ev.scheduled_ts_utc_s,
                                    "assigned_session_t": ev.assigned_session_t,
                                    "assigned_session_t_minus_1": ev.assigned_session_t_minus_1,
                                }
                                for ev in macro_sched.events
                            ]
                            write_json_atomic(cov_m, cp, creds.sanitizer)
                            rc, digest = write_parquet_atomic(wh_df_out, wp)
                            act_s = str(wh_df_out["trade_date"].min()) if rc > 0 else ""
                            act_e = str(wh_df_out["trade_date"].max()) if rc > 0 else ""
                            st_mapped: PartitionStatus = "COMPLETE" if cov_m["status"] == "COMPLETE" else "PARTIAL"
                            async with manifest.partition_lock(wk):
                                await manifest.set_entry(
                                    wk,
                                    _entry_dict(
                                        provider="orats",
                                        requested_start=wh_s.isoformat(),
                                        requested_end=wh_e.isoformat(),
                                        actual_start=act_s,
                                        actual_end=act_e,
                                        row_count=rc,
                                        content_hash=digest,
                                        status=st_mapped,
                                        last_completed_partition="orats_wham",
                                        requests=int(cov_m.get("requests_made", 0)),
                                        retry_count=int(cov_m.get("retries", 0)),
                                        coverage_scope=str(cov_m.get("coverage_scope", "MACRO_EVENT_DATES_PARTIAL")),
                                        target_date_count=len(target_dates),
                                        recovered_date_count=len(cov_m.get("recovered_dates") or []),
                                        verified_absent_count=len(cov_m.get("verified_absent_dates") or []),
                                        pending_date_count=len(cov_m.get("pending_dates") or []),
                                        sampling_mode="MACRO_EVENT_T_AND_T_MINUS_1_BATCH10",
                                        error_summary=";".join(cov_m.get("errors") or []),
                                    ),
                                )
                    else:
                        for i_sp in inst_list:
                            s_etf = i_sp.ticker
                            wp = data_root / "derivatives" / "orats_wham" / f"{s_etf}.parquet"
                            wk = f"{s_etf}:orats_wham:all"
                            inc_post_wh = s_etf in post_opex_set
                            wh_sched = generate_opex_sampling_dates(wh_s, wh_e, include_post_opex=inc_post_wh)
                            wh_res = await orats.fetch_hist_wham(
                                s_etf, wh_s, wh_e, asset_class=i_sp.asset_class.value, sample_dates=wh_sched
                            )
                            rc, digest = write_parquet_atomic(wh_res.data, wp)
                            act_s = str(wh_res.data["trade_date"].min()) if rc > 0 else ""
                            act_e = str(wh_res.data["trade_date"].max()) if rc > 0 else ""
                            st_fb: PartitionStatus = (
                                "PARTIAL" if wh_res.status == "PARTIAL"
                                else (
                                    "COMPLETE" if wh_res.status == "COMPLETE"
                                    else ("UNSUPPORTED_COVERAGE" if wh_res.status == "UNSUPPORTED_COVERAGE" else "EMPTY_VERIFIED")
                                )
                            )
                            async with manifest.partition_lock(wk):
                                await manifest.set_entry(
                                    wk,
                                    _entry_dict(
                                        provider="orats", requested_start=wh_s.isoformat(), requested_end=wh_e.isoformat(),
                                        actual_start=act_s, actual_end=act_e, row_count=rc, content_hash=digest,
                                        status=st_fb, last_completed_partition="orats_wham",
                                        requests=wh_res.requests_made,
                                        sampling_mode="PRE_OPEX+POST_OPEX_FALLBACK" if inc_post_wh else "PRE_OPEX_FALLBACK",
                                        error_summary=wh_res.note or "",
                                    ),
                                )
                pending_wham_by_window.clear()

            # Batched /datav2/hist/strikes OpEx GEX across all pending tickers (max 10 tickers/request)
            if pending_opex_jobs:
                scheds_map = {item[0].ticker: item[3] for item in pending_opex_jobs}
                spot_td_map: dict[tuple[str, str], float] = {}
                for item in pending_opex_jobs:
                    s_op = item[0].ticker
                    for td_k, sp_v in item[7].items():
                        spot_td_map[(s_op, td_k)] = sp_v
                batched_gex = await orats.fetch_opex_and_gex_summary_batched(
                    scheds_map,
                    spot_by_ticker_date=spot_td_map,
                    batch_size=10,
                )
                for inst_op, eff_s_op, eff_e_op, sched_op, samp_mode_op, gex_hashes_op, extra_op, _ in pending_opex_jobs:
                    s_op = inst_op.ticker
                    gx_path = data_root / "derivatives" / "orats_gex_opex" / f"{s_op}.parquet"
                    gx_key = f"{s_op}:orats_gex_opex:all"
                    gx_df = batched_gex.by_ticker_data[s_op]
                    rc, digest = write_parquet_atomic(gx_df, gx_path)
                    act_s = str(gx_df["trade_date"].min()) if rc > 0 else ""
                    act_e = str(gx_df["trade_date"].max()) if rc > 0 else ""
                    valid_rows = gx_df.filter(pl.col("coverage_status") == "COMPLETE").height if rc > 0 else 0
                    st_gx: PartitionStatus = (
                        "COMPLETE" if valid_rows == rc and rc > 0
                        else ("PARTIAL" if valid_rows > 0 else "UNSUPPORTED_COVERAGE")
                    )
                    async with manifest.partition_lock(gx_key):
                        await manifest.set_entry(
                            gx_key,
                            _entry_dict(
                                provider="orats",
                                requested_start=eff_s_op.isoformat(),
                                requested_end=eff_e_op.isoformat(),
                                actual_start=act_s,
                                actual_end=act_e,
                                row_count=rc,
                                content_hash=digest,
                                status=st_gx,
                                last_completed_partition=act_e,
                                requests=len(sched_op),
                                sampling_mode=samp_mode_op,
                                valid_strike_dates=valid_rows,
                                source_hashes=gex_hashes_op,
                                batch_requests_total=batched_gex.requests_made,
                                batch_fallbacks=batched_gex.fallbacks_triggered,
                                **extra_op,
                            ),
                        )
                pending_opex_jobs.clear()

        await asyncio.gather(*(_process_one_instrument(inst) for inst in target_specs))
        await _flush_orats_batches()

        # Automatic retry pass (up to 2 passes) for any FAILED_RETRYABLE partitions
        by_sym_map = {i.ticker: i for i in target_specs}
        for _retry_pass in range(2):
            if not failed_retryable_tickers:
                break
            retry_syms = sorted(failed_retryable_tickers)
            failed_retryable_tickers.clear()
            await asyncio.gather(*(_process_one_instrument(by_sym_map[s]) for s in retry_syms if s in by_sym_map))
            await _flush_orats_batches()

        # Persist combined float snapshots file atomically
        if "float_snapshots" in selected_datasets and (float_records or not snap_ok_file):
            new_snaps = pl.DataFrame(float_records, schema=FLOAT_SNAPSHOT_SCHEMA) if float_records else pl.DataFrame(schema=FLOAT_SNAPSHOT_SCHEMA)
            if existing_snaps.height > 0 and float_records:
                updated_tickers = {r["ticker"] for r in float_records}
                kept = existing_snaps.filter(~pl.col("ticker").is_in(list(updated_tickers)))
                combined_snaps = pl.concat([kept, new_snaps], how="vertical").sort(["ticker", "provider"])
            elif existing_snaps.height > 0:
                combined_snaps = existing_snaps
            else:
                combined_snaps = new_snaps
            rc_fl, digest_fl = write_parquet_atomic(combined_snaps, snap_path)
            await manifest.set_entry(
                "global:float_snapshots:file",
                _entry_dict(
                    provider="massive+fmp",
                    requested_start=core_w_end.isoformat(),
                    requested_end=core_w_end.isoformat(),
                    actual_start=core_w_end.isoformat(),
                    actual_end=core_w_end.isoformat(),
                    row_count=rc_fl,
                    content_hash=digest_fl,
                    status="COMPLETE" if rc_fl > 0 else "EMPTY_VERIFIED",
                    last_completed_partition="float_snapshots",
                ),
            )
            for sym_fl in {str(r["ticker"]) for r in float_records}:
                fl_key = f"{sym_fl}:float_snapshots:latest"
                prev = manifest.get_entry(fl_key)
                if prev is not None:
                    prev["content_hash"] = digest_fl
                    await manifest.set_entry(fl_key, prev)

        duration_s = max(0.0, time.monotonic() - t0)
        raw_metrics = transport.get_metrics()
        metrics_dict = {
            prov: {
                "requests": m.requests,
                "retries": m.retries,
                "failures": m.failures,
                "bytes_received": m.bytes_received,
                "total_latency_s": round(m.total_latency_s, 4),
                "errors_by_status": m.errors_by_status,
            }
            for prov, m in raw_metrics.items()
        }
        await manifest.record_run_summary(
            {
                "tickers": [s.ticker for s in target_specs],
                "duration_s": round(duration_s, 3),
                "provider_metrics": metrics_dict,
                "finished_at_utc_s": int(time.time()),
            }
        )
        partitions_snap = manifest.snapshot_partitions()
        generate_ingest_audit_report(
            report_path=rep_path,
            data_dir=data_root,
            universe=uni,
            target_specs=target_specs,
            partitions=partitions_snap,
            provider_metrics=metrics_dict,
            duration_s=duration_s,
        )
        return IngestionRunResult(
            tickers=tuple(s.ticker for s in target_specs),
            data_dir=data_root,
            manifest_path=manifest.path,
            report_path=rep_path,
            provider_metrics=metrics_dict,
            partitions=partitions_snap,
            duration_s=duration_s,
        )
    finally:
        if owns_transport:
            await transport.aclose()


def _dir_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(p.stat().st_size for p in path.rglob("*.parquet") if p.is_file())


def generate_ingest_audit_report(
    *,
    report_path: Path,
    data_dir: Path,
    universe: PilotUniverse,
    target_specs: Sequence[InstrumentSpec],
    partitions: Mapping[str, Mapping[str, Any]],
    provider_metrics: Mapping[str, Mapping[str, Any]],
    duration_s: float,
) -> Path:
    """Write ``reports/ingest_audit_report.md`` covering all §8 metrics & 56-ticker scaling."""
    tickers = [s.ticker for s in target_specs]
    total_bytes_disk = _dir_size_bytes(data_dir)
    parquet_files = sorted(p for p in data_dir.rglob("*.parquet") if p.is_file())

    # Collect per-ticker raw / canonical / event stats
    lines: list[str] = [
        "# AVWAP Institutional Research Oracle — Dataset & Canary Audit Report",
        "",
        f"- **Generated UTC:** `{dt.datetime.now(dt.timezone.utc).isoformat()}`",
        f"- **Tickers Audited:** `{', '.join(tickers)}`",
        f"- **Total Run Wall Time:** `{duration_s:.2f} s`",
        f"- **Parquet Artifacts Created:** `{len(parquet_files)}` files (`{total_bytes_disk / (1024 * 1024):.2f} MiB` on disk)",
        "",
        "## 1. Provider Request & Telemetry Breakdown (`MEDIDO EN CANARIO`)",
        "",
        "| Provider | Requests | Retries | Failures | Bytes Received | Cumulative Latency (s) | Errors by Status |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    total_reqs = 0
    for prov in ("massive", "orats", "fmp"):
        m = provider_metrics.get(prov, {})
        total_reqs += int(m.get("requests", 0))
        lines.append(
            f"| `{prov}` | {m.get('requests', 0)} | {m.get('retries', 0)} | "
            f"{m.get('failures', 0)} | {m.get('bytes_received', 0)} | "
            f"{m.get('total_latency_s', 0.0):.3f} | `{json.dumps(m.get('errors_by_status', {}))}` |"
        )

    lines.extend([
        "",
        "## 2. Raw 1m & Canonical RTH Coverage + VW/Form-T Integrity (`MEDIDO EN CANARIO`)",
        "",
        "- **Form T Separation Guarantee:** All canonical rollups (`rth_1D`, `rth_65m`, `rth_15m`, `rth_5m`) strictly exclude every 1m bar outside NYSE RTH bounds (`[09:30, 16:00)` ET or `[09:30, 13:00)` ET on `EARLY` dates). This guarantees zero out-of-session contamination (`MEDIDO EN CANARIO`). However, absence of out-of-condition Form T prints *inside* published 1m RTH bars cannot be proved from OHLCV+`vw` aggregates alone without tick condition codes (`NO EVALUADO`).",
        "",
        "| Ticker | Effective Window | 1m Accepted | Quarantined | `vw` Outside OHLC | RTH 1D Rows | RTH 5m Rows | Delisted / Last Session |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ])

    raw_bytes_per_ticker: dict[str, int] = {}
    for inst in target_specs:
        sym = inst.ticker
        eff_s, eff_e, _ = _effective_window(universe.windows.core.start, universe.windows.core.end, inst)
        acc_rows = 0
        quar_rows = 0
        vw_out = 0
        last_sess = ""
        for k, v in partitions.items():
            if k.startswith(f"{sym}:raw_1m:"):
                acc_rows += int(v.get("row_count", 0))
                quar_rows += int(v.get("rows_quarantined", 0))
                vw_out += int(v.get("vw_outside_ohlc_count", 0))
                le = str(v.get("last_observed_session") or "")
                if le > last_sess:
                    last_sess = le
        r1d = int(partitions.get(f"{sym}:canonical:rth_1D", {}).get("row_count", 0))
        r5m = int(partitions.get(f"{sym}:canonical:rth_5m", {}).get("row_count", 0))
        raw_dir = data_dir / "raw" / "massive_1m" / sym
        raw_bytes_per_ticker[sym] = _dir_size_bytes(raw_dir)
        del_note = f"{inst.delisted_date} / {last_sess or 'NONE'}" if inst.is_delisted else f"ACTIVE / {last_sess or 'NONE'}"
        lines.append(
            f"| `{sym}` | `{eff_s}..{eff_e}` | {acc_rows} | {quar_rows} | {vw_out} | {r1d} | {r5m} | `{del_note}` |"
        )

    lines.extend([
        "",
        "## 3. Corporate Actions, Earnings Timing & Options/ORATS Coverage (`MEDIDO EN CANARIO`)",
        "",
        "| Ticker | Splits / Conflicts | Divs / Conflicts | Earnings (BMO / AMC / DURING / UNK) | ORATS Cores | GEX/OpEx (Mode / Valid) | WHAM | Unusual / OI |",
        "| --- | --- | --- | --- | ---: | --- | --- | --- |",
    ])

    for inst in target_specs:
        sym = inst.ticker
        sp_p = data_dir / "events" / "corporate_actions" / f"{sym}_splits.parquet"
        dv_p = data_dir / "events" / "corporate_actions" / f"{sym}_dividends.parquet"
        er_p = data_dir / "events" / "earnings_reconciled" / f"{sym}.parquet"
        gx_p = data_dir / "derivatives" / "orats_gex_opex" / f"{sym}.parquet"

        sp_cnt = int(partitions.get(f"{sym}:corp_actions:splits", {}).get("row_count", 0))
        sp_conf = int(partitions.get(f"{sym}:corp_actions:splits", {}).get("conflict_count", 0))
        dv_cnt = int(partitions.get(f"{sym}:corp_actions:dividends", {}).get("row_count", 0))
        dv_conf = int(partitions.get(f"{sym}:corp_actions:dividends", {}).get("conflict_count", 0))

        timing_counts = {"BMO": 0, "AMC": 0, "DURING": 0, "UNKNOWN": 0}
        if er_p.is_file():
            er_df = pl.read_parquet(er_p)
            for t_val in er_df["earnings_timing"].to_list():
                timing_counts[str(t_val)] = timing_counts.get(str(t_val), 0) + 1

        cores_cnt = int(partitions.get(f"{sym}:orats_cores:all", {}).get("row_count", 0))
        gx_entry = partitions.get(f"{sym}:orats_gex_opex:all", {})
        gx_mode = str(gx_entry.get("sampling_mode") or "N/A")
        gx_valid = f"{gx_entry.get('valid_strike_dates', 0)}/{gx_entry.get('row_count', 0)}"
        wh_entry = partitions.get(f"{sym}:orats_wham:all", {})
        wh_str = f"{wh_entry.get('status', 'N/A')} ({wh_entry.get('row_count', 0)})"
        un_entry = partitions.get(f"{sym}:massive_unusual:all", {})
        oi_entry = partitions.get(f"{sym}:massive_oi:all", {})
        un_oi = f"{un_entry.get('status', 'N/A')}({un_entry.get('row_count', 0)}) / {oi_entry.get('status', 'N/A')}({oi_entry.get('row_count', 0)})"

        lines.append(
            f"| `{sym}` | {sp_cnt} / {sp_conf} | {dv_cnt} / {dv_conf} | "
            f"{timing_counts['BMO']}/{timing_counts['AMC']}/{timing_counts['DURING']}/{timing_counts['UNKNOWN']} | "
            f"{cores_cnt} | `{gx_mode}` ({gx_valid}) | `{wh_str}` | `{un_oi}` |"
        )

    # 4. Non-linear scaling projection for all 56 instruments
    core_days_full = max(1, (universe.windows.core.end - universe.windows.core.start).days)
    sum_ticker_years = 0.0
    etf_wham_count = 0
    for inst in universe.instruments:
        _, e_end, ok = _effective_window(universe.windows.core.start, universe.windows.core.end, inst)
        if ok:
            sum_ticker_years += max(0.0, (e_end - universe.windows.core.start).days / 365.25)
        if inst.asset_class.value == "US_ETF":
            etf_wham_count += 1

    # Estimate per-component requests rather than linear x14 extrapolation
    avg_raw_1m_reqs_per_year = max(1.0, (core_days_full / 45.0) / 5.85)  # ~8-9 chunks/yr at 45d
    est_massive_stocks_56 = int(round(sum_ticker_years * 8.5 + 56 * 4))  # ~1m chunks + splits/divs/float
    canary_unusual_reqs = sum(
        int(partitions.get(f"{t}:massive_unusual:all", {}).get("requests", 0))
        for t in ("SPY", "NVDA", "MELI")
    )
    active_opra_eqs = sum(
        1.0 if not i.is_delisted else max(0.0, ((i.delisted_date - universe.windows.opra_flow.start).days / 1545.0))
        for i in universe.instruments
        if not i.is_delisted or (i.delisted_date and i.delisted_date >= universe.windows.opra_flow.start)
    )
    est_oi_56 = int(round(active_opra_eqs * 1.0))  # 1 request/ticker via /options/v1/open-interest/underlying
    est_unusual_56_capped = int(round(active_opra_eqs * (canary_unusual_reqs / 3.0)))
    est_massive_options_56 = est_oi_56 + est_unusual_56_capped
    est_orats_pre_opex_56 = int(round(sum_ticker_years * 12.0 + 56 * 3 + 96))  # +~96 multi-ETF WHAM PRE/POST dates
    est_orats_wham_daily_etfs = 980  # 1 call per NYSE session with comma-joined 6 US_ETFs (2023..2026)
    est_orats_daily_full_56 = int(round(sum_ticker_years * 252.0 + 56 * 3 + est_orats_wham_daily_etfs))
    est_fmp_56 = int(round(56 * (4 + sum_ticker_years / 56.0 * 12.0) + 45))  # +1 global run reused

    avg_bytes_per_year_raw = (
        sum(raw_bytes_per_ticker.values())
        / max(
            1.0,
            sum(
                ((min(universe.windows.core.end, i.delisted_date) if i.is_delisted and i.delisted_date else universe.windows.core.end) - universe.windows.core.start).days / 365.25
                for i in target_specs
            ),
        )
    )
    est_disk_mib_56 = (avg_bytes_per_year_raw * sum_ticker_years * 1.45) / (1024 * 1024)

    lines.extend([
        "",
        "## 4. Point-in-Time Limitations & 56-Symbol Scaling Projection (`ESTIMADO`)",
        "",
        "- **Point-in-Time Caveats (`MEDIDO EN CANARIO`):** `float_snapshots` reflects current snapshots only (`is_point_in_time=False`), `fmp/earnings` carries `RETROSPECTIVE_NOT_PIT`, `ORATS hist/earnings` provides retrospective announcement timestamps, and `MASSIVE_ETH_INFERRED` enforces `available_at_utc_s >=` end of ETH evaluation window (`rth_open` for BMO, `ext_close` for AMC).",
        f"- **Non-Linear Window Accounting (`ESTIMADO`):** Across all 56 frozen instruments, adjusted for 11 delisted cutoffs (`sum_effective_years = {sum_ticker_years:.2f}` yrs vs naive `56 * 5.86 = 328.2` yrs), `US_ETF` WHAM restriction ({etf_wham_count}/56 tickers, batchable via comma-separated `ticker=SPY,QQQ,...` per date), global FMP tables downloaded once (3 tables), and OPRA `>= 2022-09-01` floor (`{active_opra_eqs:.2f}` active-equivalent tickers):",
        f"  - `Massive STOCKS_REST` (`1m raw + corp actions + float`): **~{est_massive_stocks_56:,} requests** (`ESTIMADO`).",
        f"  - `Massive OPTIONS_REST` (`open-interest/underlying` ~1 req/ticker = ~{est_oi_56:,} reqs + `unusual-trades` capped at canary 10-page guardrail = ~{est_unusual_56_capped:,} reqs → **~{est_massive_options_56:,} requests total**) (`ESTIMADO`; note Massive `/options/v1/unusual-trades` ignores `flags`/`min_premium`, returning 1-lot ISOs so uncapped SPY/NVDA would add hundreds of pages per ticker).",
        f"  - `ORATS HISTORICAL` (`cores` 1 req/ticker via 302 + `summaries` 1 req/ticker + `earnings` + sampled WHAM + `PRE_OPEX` strikes): **~{est_orats_pre_opex_56:,} requests** (`ESTIMADO`); switching GEX & ETF WHAM from monthly `PRE_OPEX` to `DAILY_FULL` across ~{int(sum_ticker_years * 252):,} ticker-sessions would cost **~{est_orats_daily_full_56:,} requests** (`ESTIMADO`, ~{est_orats_wham_daily_etfs} multi-ETF WHAM requests).",
        f"  - `FMP ENTERPRISE` (`earnings + SEC + splits/divs + float + reused globals`): **~{est_fmp_56:,} requests** (`ESTIMADO`).",
        f"  - **Projected Parquet Storage (56 symbols, raw + canonical + events + derivatives):** **~{est_disk_mib_56:.1f} MiB** (`ESTIMADO`).",
        f"  - **Estimated Wall Time (56 symbols, canary concurrency `{total_reqs} reqs / {duration_s:.1f}s` adjusted for non-linear pools):** **~{max(1.0, (est_massive_stocks_56 + est_massive_options_56 + est_orats_pre_opex_56 + est_fmp_56) / max(1.0, total_reqs / max(1.0, duration_s)) / 60.0):.1f} minutes** (`ESTIMADO` for `PRE_OPEX` GEX sampling).",
        "",
    ])

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Resumable Parquet ingestion pipeline for AVWAP Oracle")
    p.add_argument("--tickers", type=str, default="", help="Comma-separated ticker list (e.g. SPY,NVDA,MELI,TWTR)")
    p.add_argument("--all", action="store_true", dest="all_universe", help="Ingest all 56 pilot universe symbols")
    p.add_argument("--force", action="store_true", help="Force re-ingestion for requested tickers/datasets")
    p.add_argument("--datasets", type=str, default="", help="Optional comma-separated subset of datasets")
    p.add_argument("--start-date", type=str, default="", help="Override core start date YYYY-MM-DD")
    p.add_argument("--end-date", type=str, default="", help="Override core end date YYYY-MM-DD")
    p.add_argument("--include-post-opex-tickers", type=str, default="SPY", help="Comma-separated tickers for POST_OPEX GEX sample")
    p.add_argument("--max-requests-per-provider", type=int, default=None, help="Hard request cap per provider")
    p.add_argument("--data-dir", type=str, default="", help="Custom Parquet root dir (defaults to research/avwap_oracle/data)")
    p.add_argument("--report-path", type=str, default="", help="Custom audit report path")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] if args.tickers else None
    datasets = [d.strip() for d in args.datasets.split(",") if d.strip()] if args.datasets else None
    post_opex = [t.strip().upper() for t in args.include_post_opex_tickers.split(",") if t.strip()]
    s_dt = dt.date.fromisoformat(args.start_date) if args.start_date else None
    e_dt = dt.date.fromisoformat(args.end_date) if args.end_date else None
    d_dir = Path(args.data_dir) if args.data_dir else None
    r_path = Path(args.report_path) if args.report_path else None

    result = asyncio.run(
        run_ingestion(
            tickers=tickers,
            all_universe=bool(args.all_universe),
            force=bool(args.force),
            datasets=datasets,
            start_date=s_dt,
            end_date=e_dt,
            include_post_opex_tickers=post_opex,
            data_dir=d_dir,
            report_path=r_path,
            max_requests_per_provider=args.max_requests_per_provider,
        )
    )
    summary = {
        "tickers": list(result.tickers),
        "duration_s": round(result.duration_s, 3),
        "provider_metrics": result.provider_metrics,
        "manifest_path": str(result.manifest_path),
        "report_path": str(result.report_path),
        "partition_count": len(result.partitions),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
