"""Offline ingestor and optional explicit split adjuster for Massive Flat Files (.csv / .csv.gz).

Key verified rules (docs/massive_plan_reference.md & AGENTS.md):
  - Massive Stock Flat Files (`us_stocks_sip/day_aggs_v1`, `minute_aggs_v1`) come
    UNADJUSTED for splits and DO NOT contain a `vw` column.
  - `window_start` is Unix nanoseconds -> converted explicitly to integer UTC
    seconds (`window_start // 1_000_000_000`).
  - Missing `vw` is ALWAYS reported as explicit `None` (`vwPresent=False`);
    never synthesized silently with HLC3.
  - Unadjusted Flat File bars MUST carry `adjusted=False` metadata so they are
    never silently mixed with split-adjusted REST bars from `src/data/loader.ts`.
  - When `--adjusted` is passed explicitly on stocks, adjusts bars strictly prior
    to `execution_date` using `/stocks/v1/splits` (`historical_adjustment_factor`,
    price *= factor, volume /= factor). Options Flat Files refuse `--adjusted`.
  - Optional S3 download (`https://files.massive.com`, bucket `flatfiles`) tracks
    `ETag` and `LastModified` in a local cache manifest to avoid redundant fetches
    while detecting upstream file replacements.
  - Never prints or writes S3 credentials or Massive API keys to stdout/files.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol
from zoneinfo import ZoneInfo

ET_TZ = ZoneInfo("America/New_York")
MAX_TIME_SECONDS = 10**11
NANOSECONDS_MIN = 10**15
NANOSECONDS_MAX = MAX_TIME_SECONDS * 10**9

DEFAULT_S3_ENDPOINT = "https://files.massive.com"
DEFAULT_S3_BUCKET = "flatfiles"
DEFAULT_REST_BASE_URL = "https://api.massive.com"

DISCARD_CAUSES = (
    "malformedRow",
    "invalidTime",
    "nonFinite",
    "invalidPrice",
    "highBelowLow",
    "invalidOhlc",
    "invalidVolume",
    "duplicate",
)


class S3ClientLike(Protocol):
    """Minimal protocol matching boto3 S3 client methods used by S3FlatFileCache."""

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]: ...
    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]: ...


def load_env_file(env_path: Path) -> dict[str, str]:
    """Reads KEY=VALUE pairs from a .env file without modifying process env globally."""
    if not env_path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_val = line.split("=", 1)
        key = key.strip()
        val = raw_val.strip()
        if len(val) >= 2 and ((val[0] == '"' and val[-1] == '"') or (val[0] == "'" and val[-1] == "'")):
            val = val[1:-1]
        if key:
            values[key] = val
    return values


def collect_secrets(*candidates: str | None) -> list[str]:
    """Builds deduplicated non-empty secrets list (including URL-encoded variants) for redaction."""
    unique: list[str] = []
    seen: set[str] = set()
    for raw in candidates:
        if not raw:
            continue
        for variant in (raw, raw.strip(), urllib.parse.quote(raw, safe="")):
            if variant and variant not in seen:
                seen.add(variant)
                unique.append(variant)
    return unique


def redact_secrets(text: str, secrets: Iterable[str]) -> str:
    """Replaces all sensitive credentials in any message or report with <redacted>."""
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, "<redacted>")
    return out


def parse_window_start_ns(raw: Any) -> int | None:
    """Converts Unix nanosecond `window_start` to integer UTC seconds; rejects ms/s or invalid."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        if not math.isfinite(float(raw)) or float(raw) != math.trunc(float(raw)):
            return None
        ns = int(raw)
    elif isinstance(raw, str):
        stripped = raw.strip()
        if not stripped.isdigit():
            return None
        ns = int(stripped)
    else:
        return None

    if ns < NANOSECONDS_MIN or ns > NANOSECONDS_MAX:
        return None
    sec = ns // 1_000_000_000
    if sec <= 0 or sec > MAX_TIME_SECONDS:
        return None
    return sec


def _open_csv_text(path: Path):
    if path.suffix.lower() == ".gz":
        return gzip.open(path, mode="rt", encoding="utf-8", newline="")
    return path.open(mode="rt", encoding="utf-8", newline="")


def _normalize_etag(raw_etag: Any) -> str:
    if not isinstance(raw_etag, str):
        return ""
    return raw_etag.strip().strip('"')


def _normalize_last_modified(raw_lm: Any) -> str:
    if isinstance(raw_lm, datetime):
        dt = raw_lm if raw_lm.tzinfo is not None else raw_lm.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    if isinstance(raw_lm, str):
        return raw_lm.strip()
    return ""


class S3FlatFileCache:
    """Downloads Massive S3 Flat Files with ETag + LastModified cache validation."""

    def __init__(
        self,
        cache_dir: Path,
        *,
        bucket: str = DEFAULT_S3_BUCKET,
        s3_client: S3ClientLike | None = None,
        secrets: Iterable[str] = (),
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.bucket = bucket
        self.s3_client = s3_client
        self.secrets = list(secrets)
        self.manifest_path = self.cache_dir / "flatfiles_etag_manifest.json"

    def _read_manifest(self) -> dict[str, dict[str, Any]]:
        if not self.manifest_path.is_file():
            return {}
        try:
            data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def _write_manifest(self, manifest: dict[str, dict[str, Any]]) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        payload = redact_secrets(json.dumps(manifest, indent=2, sort_keys=True) + "\n", self.secrets)
        fd, tmp_name = tempfile.mkstemp(dir=str(self.cache_dir), prefix=".manifest_", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp_name, self.manifest_path)
        finally:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)

    def sync_key(self, s3_key: str) -> tuple[Path, dict[str, Any]]:
        """Ensures local copy matches remote ETag and LastModified, downloading only if changed."""
        if self.s3_client is None:
            raise RuntimeError("S3 client is required for S3 Flat File sync")
        clean_key = s3_key.lstrip("/")
        if not clean_key or ".." in Path(clean_key).parts:
            raise ValueError(f"Unsafe S3 key: {s3_key}")

        local_path = self.cache_dir / self.bucket / clean_key
        local_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            head = self.s3_client.head_object(Bucket=self.bucket, Key=clean_key)
        except Exception as exc:
            raise RuntimeError(redact_secrets(f"Failed S3 head_object for {clean_key}: {exc}", self.secrets)) from None

        remote_etag = _normalize_etag(head.get("ETag"))
        remote_lm = _normalize_last_modified(head.get("LastModified"))
        cache_id = f"{self.bucket}/{clean_key}"

        manifest = self._read_manifest()
        prev = manifest.get(cache_id)

        if (
            isinstance(prev, dict)
            and local_path.is_file()
            and remote_etag
            and prev.get("etag") == remote_etag
            and prev.get("lastModified") == remote_lm
        ):
            return local_path, {
                "cacheHit": True,
                "etag": remote_etag,
                "lastModified": remote_lm,
                "replacedPreviousVersion": False,
                "localPath": str(local_path),
            }

        replaced = isinstance(prev, dict) and (
            prev.get("etag") != remote_etag or prev.get("lastModified") != remote_lm
        )

        try:
            obj = self.s3_client.get_object(Bucket=self.bucket, Key=clean_key)
            body = obj["Body"].read()
            actual_etag = _normalize_etag(obj.get("ETag")) or remote_etag
            actual_lm = _normalize_last_modified(obj.get("LastModified")) or remote_lm
        except Exception as exc:
            raise RuntimeError(redact_secrets(f"Failed S3 get_object for {clean_key}: {exc}", self.secrets)) from None

        fd, tmp_name = tempfile.mkstemp(dir=str(local_path.parent), prefix=".dl_", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(body)
            os.replace(tmp_name, local_path)
        finally:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)

        manifest[cache_id] = {
            "etag": actual_etag,
            "lastModified": actual_lm,
            "sizeBytes": len(body),
            "localPath": str(local_path),
            "syncedAtUtc": datetime.now(timezone.utc).isoformat(),
        }
        self._write_manifest(manifest)

        return local_path, {
            "cacheHit": False,
            "etag": actual_etag,
            "lastModified": actual_lm,
            "replacedPreviousVersion": replaced,
            "localPath": str(local_path),
        }


def build_s3_client_from_env(env: dict[str, str], endpoint_url: str = DEFAULT_S3_ENDPOINT) -> tuple[Any, list[str]]:
    """Creates a boto3 S3v4 client reading credentials purely in-memory from env dict."""
    import boto3
    from botocore.config import Config

    access_key = (
        env.get("MASSIVE_S3_ACCESS_KEY")
        or os.environ.get("MASSIVE_S3_ACCESS_KEY")
        or env.get("AWS_ACCESS_KEY_ID")
        or os.environ.get("AWS_ACCESS_KEY_ID")
    )
    secret_key = (
        env.get("MASSIVE_S3_SECRET_KEY")
        or os.environ.get("MASSIVE_S3_SECRET_KEY")
        or env.get("AWS_SECRET_ACCESS_KEY")
        or os.environ.get("AWS_SECRET_ACCESS_KEY")
    )
    secrets = collect_secrets(access_key, secret_key)
    if not access_key or not secret_key:
        raise RuntimeError(
            "Missing S3 credentials (expected MASSIVE_S3_ACCESS_KEY and MASSIVE_S3_SECRET_KEY)."
        )

    client = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
    )
    return client, secrets


def parse_splits_payload(raw_payload: Any, target_ticker: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Parses `/stocks/v1/splits` JSON payload into per-ticker split events sorted by execution_date."""
    if isinstance(raw_payload, dict):
        if isinstance(raw_payload.get("status"), str) and raw_payload["status"].upper() != "OK":
            raise RuntimeError(f"Splits payload error: {raw_payload.get('error') or raw_payload.get('message') or raw_payload['status']}")
        rows = raw_payload.get("results", [])
    elif isinstance(raw_payload, list):
        rows = raw_payload
    else:
        raise ValueError("Splits payload must be a JSON object with results[] or list")

    by_ticker: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        tkr = str(row.get("ticker", "")).strip()
        exec_date = str(row.get("execution_date", "")).strip()
        if not tkr or len(exec_date) != 10:
            continue
        if target_ticker is not None and tkr != target_ticker:
            continue

        hist_factor_raw = row.get("historical_adjustment_factor")
        hist_factor: float | None = None
        if isinstance(hist_factor_raw, (int, float)) and math.isfinite(float(hist_factor_raw)) and float(hist_factor_raw) > 0:
            hist_factor = float(hist_factor_raw)

        split_from_raw = row.get("split_from")
        split_to_raw = row.get("split_to")
        ratio: float | None = None
        if (
            isinstance(split_from_raw, (int, float))
            and isinstance(split_to_raw, (int, float))
            and math.isfinite(float(split_from_raw))
            and math.isfinite(float(split_to_raw))
            and float(split_from_raw) > 0
            and float(split_to_raw) > 0
        ):
            ratio = float(split_from_raw) / float(split_to_raw)

        if hist_factor is None and ratio is None:
            raise ValueError(f"Split record for {tkr} on {exec_date} lacks valid factor and split_from/split_to")

        by_ticker.setdefault(tkr, []).append(
            {
                "ticker": tkr,
                "executionDate": exec_date,
                "historicalAdjustmentFactor": hist_factor,
                "singleEventRatio": ratio,
            }
        )

    for splits in by_ticker.values():
        splits.sort(key=lambda s: s["executionDate"])
    return by_ticker


def compute_cumulative_split_factor(bar_date_et: str, sorted_splits: list[dict[str, Any]]) -> float:
    """Computes split multiplier applied to unadjusted prices before execution_date.

    Matches Massive `/stocks/v1/splits`:
      - Find the earliest split record with `executionDate > bar_date_et`.
      - If `historicalAdjustmentFactor` is provided, return it directly (already cumulative).
      - Otherwise multiply all `singleEventRatio` (`split_from / split_to`) for `executionDate > bar_date_et`.
      - Returns 1.0 when no split occurred strictly after `bar_date_et`.
    """
    future_splits = [s for s in sorted_splits if s["executionDate"] > bar_date_et]
    if not future_splits:
        return 1.0

    earliest = future_splits[0]
    if earliest["historicalAdjustmentFactor"] is not None:
        return float(earliest["historicalAdjustmentFactor"])

    factor = 1.0
    for s in future_splits:
        assert s["singleEventRatio"] is not None
        factor *= float(s["singleEventRatio"])
    return factor


def fetch_splits_from_massive(
    api_key: str,
    *,
    ticker: str | None = None,
    base_url: str = DEFAULT_REST_BASE_URL,
    secrets: Iterable[str] = (),
) -> dict[str, list[dict[str, Any]]]:
    """Fetches paginated split events from `GET /stocks/v1/splits` with credential redaction."""
    secret_list = collect_secrets(api_key, *secrets)
    params: dict[str, str] = {"limit": "1000", "sort": "execution_date.asc"}
    if ticker:
        params["ticker"] = ticker
    url: str | None = f"{base_url.rstrip('/')}/stocks/v1/splits?{urllib.parse.urlencode(params)}"
    all_rows: list[Any] = []
    pages = 0

    while url is not None and pages < 50:
        pages += 1
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.netloc not in {urllib.parse.urlparse(base_url).netloc, "api.massive.com", "api.polygon.io"}:
            raise RuntimeError(redact_secrets(f"Refusing untrusted next_url origin: {url}", secret_list))

        qs = dict(urllib.parse.parse_qsl(parsed.query))
        qs["apiKey"] = api_key
        authed_url = urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(qs)))

        try:
            with urllib.request.urlopen(authed_url, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError(redact_secrets(f"Failed fetching splits: {exc}", secret_list)) from None

        if not isinstance(payload, dict):
            raise RuntimeError("Malformed /stocks/v1/splits JSON response")
        results = payload.get("results") or []
        if not isinstance(results, list):
            raise RuntimeError("Malformed results array in /stocks/v1/splits response")
        all_rows.extend(results)
        next_raw = payload.get("next_url")
        url = next_raw if isinstance(next_raw, str) and next_raw.strip() else None

    return parse_splits_payload({"status": "OK", "results": all_rows}, target_ticker=ticker)


def _parse_pos_float(raw: Any) -> float | None:
    if isinstance(raw, bool):
        return None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(val):
        return None
    return val


def ingest_flat_file_paths(
    paths: list[Path],
    *,
    asset_class: str = "stocks",
    ticker_filter: str | None = None,
    adjusted: bool = False,
    splits_by_ticker: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Reads and normalizes one or more Massive Flat File CSV/CSV.gz archives cleanly."""
    if asset_class not in {"stocks", "options"}:
        raise ValueError(f"Unsupported asset_class: {asset_class}")
    if adjusted and asset_class != "stocks":
        raise ValueError("Cannot apply stock split adjustment (--adjusted) to options flat files")
    if adjusted and splits_by_ticker is None:
        raise ValueError("Split adjustment requested (--adjusted) without splits_by_ticker data")

    counts = {cause: 0 for cause in DISCARD_CAUSES}
    seen_keys: set[tuple[str, int]] = set()
    rows_out: list[dict[str, Any]] = []
    received = 0
    vw_column_present = False
    splits_applied_bars = 0

    for path in paths:
        with _open_csv_text(path) as handle:
            reader = csv.DictReader(handle)
            fieldnames = [f.strip() for f in (reader.fieldnames or [])]
            required = {"ticker", "volume", "open", "close", "high", "low", "window_start"}
            missing = required - set(fieldnames)
            if missing:
                raise ValueError(f"Flat file {path} missing required columns: {sorted(missing)}")

            has_vw = "vw" in fieldnames or "vwap" in fieldnames
            if has_vw:
                vw_column_present = True

            for raw_row in reader:
                received += 1
                row_ticker = (raw_row.get("ticker") or "").strip()
                if not row_ticker:
                    counts["malformedRow"] += 1
                    continue
                if ticker_filter is not None and row_ticker != ticker_filter:
                    continue

                time_sec = parse_window_start_ns(raw_row.get("window_start"))
                if time_sec is None:
                    counts["invalidTime"] += 1
                    continue

                o = _parse_pos_float(raw_row.get("open"))
                h = _parse_pos_float(raw_row.get("high"))
                l = _parse_pos_float(raw_row.get("low"))
                c = _parse_pos_float(raw_row.get("close"))
                v = _parse_pos_float(raw_row.get("volume"))

                if o is None or h is None or l is None or c is None or v is None:
                    counts["nonFinite"] += 1
                    continue
                if o <= 0 or h <= 0 or l <= 0 or c <= 0:
                    counts["invalidPrice"] += 1
                    continue
                if h < l:
                    counts["highBelowLow"] += 1
                    continue
                if o < l or o > h or c < l or c > h:
                    counts["invalidOhlc"] += 1
                    continue
                if v < 0:
                    counts["invalidVolume"] += 1
                    continue

                vw_val: float | None = None
                if has_vw:
                    raw_vw = raw_row.get("vw") if "vw" in raw_row else raw_row.get("vwap")
                    if raw_vw is not None and str(raw_vw).strip() != "":
                        parsed_vw = _parse_pos_float(raw_vw)
                        if parsed_vw is None:
                            counts["nonFinite"] += 1
                            continue
                        if parsed_vw > 0:
                            vw_val = parsed_vw

                key = (row_ticker, time_sec)
                if key in seen_keys:
                    counts["duplicate"] += 1
                    continue
                seen_keys.add(key)

                tx_raw = raw_row.get("transactions")
                tx_count: int | None = None
                if tx_raw is not None and str(tx_raw).strip() != "":
                    if not str(tx_raw).strip().isdigit():
                        counts["malformedRow"] += 1
                        continue
                    tx_count = int(str(tx_raw).strip())

                factor = 1.0
                if adjusted and splits_by_ticker is not None:
                    ticker_splits = splits_by_ticker.get(row_ticker, [])
                    if ticker_splits:
                        dt_et = datetime.fromtimestamp(time_sec, tz=timezone.utc).astimezone(ET_TZ)
                        bar_date_et = dt_et.strftime("%Y-%m-%d")
                        factor = compute_cumulative_split_factor(bar_date_et, ticker_splits)
                        if factor != 1.0:
                            o *= factor
                            h *= factor
                            l *= factor
                            c *= factor
                            v /= factor
                            if vw_val is not None:
                                vw_val *= factor
                            splits_applied_bars += 1

                rows_out.append(
                    {
                        "ticker": row_ticker,
                        "time": time_sec,
                        "open": o,
                        "high": h,
                        "low": l,
                        "close": c,
                        "volume": v,
                        "vw": vw_val,
                        "transactions": tx_count,
                        "splitFactorApplied": factor,
                    }
                )

    reordered = False
    for idx in range(1, len(rows_out)):
        prev = rows_out[idx - 1]
        curr = rows_out[idx]
        if (curr["ticker"], curr["time"]) < (prev["ticker"], prev["time"]):
            reordered = True
            break
    if reordered:
        rows_out.sort(key=lambda r: (r["ticker"], r["time"]))

    return {
        "schemaVersion": 1,
        "provider": "massive",
        "source": "flat_files",
        "assetClass": asset_class,
        "adjusted": adjusted,
        "adjustmentWarning": (
            "ADJUSTED_VIA_STOCKS_V1_SPLITS"
            if adjusted
            else "UNADJUSTED_FLAT_FILE_DO_NOT_MIX_WITH_ADJUSTED_REST_BARS"
        ),
        "vwPresent": vw_column_present,
        "vwSynthesized": False,
        "timeUnit": "utc_seconds",
        "received": received,
        "accepted": len(rows_out),
        "discarded": sum(counts.values()),
        "discardCounts": counts,
        "splitsAppliedBars": splits_applied_bars,
        "reordered": reordered,
        "bars": rows_out,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline Massive Flat Files (.csv / .csv.gz) ingestor and explicit split adjuster."
    )
    parser.add_argument("--asset-class", choices=("stocks", "options"), default="stocks")
    parser.add_argument("--input", action="append", default=[], help="Local .csv or .csv.gz path (repeatable)")
    parser.add_argument("--s3-key", action="append", default=[], help="Massive S3 flatfiles key to sync via ETag cache")
    parser.add_argument("--s3-endpoint", default=DEFAULT_S3_ENDPOINT)
    parser.add_argument("--s3-bucket", default=DEFAULT_S3_BUCKET)
    parser.add_argument("--cache-dir", default=".cache/massive_flatfiles")
    parser.add_argument("--ticker", default=None, help="Optional exact ticker filter (e.g. NVDA)")
    parser.add_argument("--adjusted", action="store_true", help="Explicitly adjust stock bars using splits")
    parser.add_argument("--splits-file", default=None, help="Local JSON file with /stocks/v1/splits payload")
    parser.add_argument("--fetch-splits", action="store_true", help="Fetch splits from /stocks/v1/splits via REST")
    parser.add_argument("--env-file", default=".env", help="Optional .env path read only at runtime")
    parser.add_argument("--output", default=None, help="Optional JSON output file path")
    args = parser.parse_args(argv)

    env_values = load_env_file(Path(args.env_file))
    secrets = collect_secrets(
        env_values.get("MASSIVE_S3_ACCESS_KEY"),
        env_values.get("MASSIVE_S3_SECRET_KEY"),
        env_values.get("MASSIVE_API_KEY"),
        os.environ.get("MASSIVE_S3_ACCESS_KEY"),
        os.environ.get("MASSIVE_S3_SECRET_KEY"),
        os.environ.get("MASSIVE_API_KEY"),
    )

    try:
        local_paths = [Path(p) for p in args.input]
        sync_reports: list[dict[str, Any]] = []

        if args.s3_key:
            s3_client, s3_secrets = build_s3_client_from_env(env_values, endpoint_url=args.s3_endpoint)
            secrets = collect_secrets(*secrets, *s3_secrets)
            cache = S3FlatFileCache(Path(args.cache_dir), bucket=args.s3_bucket, s3_client=s3_client, secrets=secrets)
            for s3_key in args.s3_key:
                synced_path, sync_meta = cache.sync_key(s3_key)
                local_paths.append(synced_path)
                sync_reports.append(sync_meta)

        if not local_paths:
            raise ValueError("Provide at least one --input or --s3-key")

        splits_by_ticker: dict[str, list[dict[str, Any]]] | None = None
        if args.adjusted:
            if args.asset_class != "stocks":
                raise ValueError("--adjusted is only valid for stocks flat files")
            if args.splits_file:
                raw_splits = json.loads(Path(args.splits_file).read_text(encoding="utf-8"))
                splits_by_ticker = parse_splits_payload(raw_splits, target_ticker=args.ticker)
            elif args.fetch_splits:
                api_key = env_values.get("MASSIVE_API_KEY") or os.environ.get("MASSIVE_API_KEY")
                if not api_key:
                    raise RuntimeError("Missing MASSIVE_API_KEY for --fetch-splits")
                splits_by_ticker = fetch_splits_from_massive(api_key, ticker=args.ticker, secrets=secrets)
            else:
                raise ValueError("--adjusted requires either --splits-file or --fetch-splits")

        result = ingest_flat_file_paths(
            local_paths,
            asset_class=args.asset_class,
            ticker_filter=args.ticker,
            adjusted=bool(args.adjusted),
            splits_by_ticker=splits_by_ticker,
        )
        if sync_reports:
            result["s3Sync"] = sync_reports

        serialized = redact_secrets(json.dumps(result, indent=2) + "\n", secrets)
        if args.output:
            Path(args.output).write_text(serialized, encoding="utf-8")
            summary = {
                "accepted": result["accepted"],
                "discarded": result["discarded"],
                "adjusted": result["adjusted"],
                "vwPresent": result["vwPresent"],
                "splitsAppliedBars": result["splitsAppliedBars"],
                "output": str(args.output),
            }
            print(redact_secrets(json.dumps(summary), secrets))
        else:
            print(serialized)
        return 0
    except Exception as exc:
        print(redact_secrets(f"Error: {exc}", secrets))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
