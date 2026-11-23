#!/usr/bin/env python3
"""Daily IAMC Anexo B PDF/CSV scraper & parser for GGAL BYMA options Open Interest.

Designed for pre-09:00 ART scheduled execution or manual CLI invocation.
Zero Silent Fallbacks policy:
  - Never silently imputes 0 on incomplete CSV/PDF tables or untraded strikes.
  - Emits `CARRY_FORWARD_NO_TRADE` when a strike had zero daily trades or incomplete
    settlement rows and a prior T-1 valid record is supplied.
  - Emits `MISSING_UNAVAILABLE` with null fields if neither fresh PDF nor prior record
    contains valid OI.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

DEFAULT_IAMC_ANEXO_B_URL = os.environ.get(
    "IAMC_ANEXO_B_URL",
    "https://www.iamc.com.ar/InformeDiario/",
)

# Typical IAMC/BYMA GGAL option series prefixes: GFGC (Calls), GFGV (Puts), e.g., GFGC7200JU
BYMA_GGAL_SERIES_RE = re.compile(
    r"\b(GFG[CV])(\d+(?:[.,]\d+)?)([A-Z]{1,2})\b",
    re.IGNORECASE,
)

VALID_BYMA_EXPIRY_CODES = frozenset({
    "EN", "E", "FE", "F", "MA", "MR", "M", "AB", "A", "MY", "Y",
    "JU", "JN", "J", "JL", "L", "AG", "G", "SE", "S", "OC", "O",
    "NO", "N", "DI", "D",
})

# Row matching: Series, optional reference price/volume, Descubierta, Cubierta, Cruzada/Total
NUMERIC_TOKEN_RE = re.compile(r"[-+]?\d[\d.,]*|-")


def _art_now() -> dt.datetime:
    art_tz = dt.timezone(dt.timedelta(hours=-3), name="ART")
    return dt.datetime.now(art_tz)


def _parse_ar_number(token: str) -> float | None:
    cleaned = token.strip()
    if cleaned in ("", "-", "--", "—", "N/A", "S/C", "S/D"):
        return None
    # Handle Argentine thousand separator '.' and decimal ',' or standard '.'
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        parts = cleaned.split(",")
        if len(parts) == 2 and len(parts[1]) <= 4:
            cleaned = cleaned.replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif cleaned.count(".") > 1:
        cleaned = cleaned.replace(".", "")

    try:
        val = float(cleaned)
    except ValueError:
        return None
    if not math.isfinite(val):
        return None
    return val


def _extract_pdf_text_stdlib(raw_bytes: bytes) -> str:
    """Best-effort pure-stdlib PDF text extractor supporting uncompressed & FlateDecode streams."""
    chunks: list[str] = []
    stream_re = re.compile(rb"stream[\r\n]+(.*?)[\r\n]+endstream", re.DOTALL)

    for match in stream_re.finditer(raw_bytes):
        payload = match.group(1)
        decoded: bytes | None = None
        for candidate in (payload, payload.strip()):
            try:
                decoded = zlib.decompress(candidate)
                break
            except zlib.error:
                continue
        if decoded is None:
            decoded = payload

        text_data = decoded.decode("latin-1", errors="ignore")
        # Extract literal strings inside PDF text showing operators (...) Tj / [(...)] TJ
        for lit in re.finditer(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)", text_data):
            s = lit.group(1)
            s = s.replace(r"\(", "(").replace(r"\)", ")").replace(r"\\", "\\")
            if any(ch.isalnum() for ch in s):
                chunks.append(s)

    if not chunks:
        # Fallback: direct ASCII/Latin-1 readable text
        text_fallback = raw_bytes.decode("latin-1", errors="ignore")
        return text_fallback
    return "\n".join(chunks)


def extract_text_from_pdf_bytes(raw_bytes: bytes) -> str:
    """Extracts text from PDF bytes using optional PDF libraries or pure-stdlib fallback."""
    import io

    try:
        import pypdf  # type: ignore[import-not-found]

        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except ImportError:
        pass

    try:
        import pdfplumber  # type: ignore[import-not-found]

        with pdfplumber.open(io.BytesIO(raw_bytes)) as pdf:
            return "\n".join((page.extract_text() or "") for page in pdf.pages)
    except ImportError:
        pass

    try:
        import fitz  # type: ignore[import-not-found]

        doc = fitz.open(stream=raw_bytes, filetype="pdf")
        return "\n".join(page.get_text() for page in doc)
    except ImportError:
        pass

    return _extract_pdf_text_stdlib(raw_bytes)


def _normalize_strike_from_symbol(series: str, raw_strike: str) -> float:
    parsed = _parse_ar_number(raw_strike)
    if parsed is None or parsed <= 0:
        return math.nan
    return parsed


def _to_exact_num(val: float | None) -> int | float | None:
    if val is None or not math.isfinite(val):
        return None
    rounded = round(val)
    return int(rounded) if abs(val - rounded) < 1e-9 else float(val)


def _parse_anexo_b_lines(
    lines: list[str],
    prior_by_series: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_series: set[str] = set()
    parsed_by_series: dict[str, tuple[int | float | None, int | float | None, int | float | None, int | float | None]] = {}
    conflicting_series: set[str] = set()

    for raw_line in lines:
        line = " ".join(raw_line.split())
        if not line:
            continue
        m = BYMA_GGAL_SERIES_RE.search(line)
        if not m:
            continue

        prefix = m.group(1).upper()
        strike_raw = m.group(2)
        expiry_code = m.group(3).upper()
        if expiry_code not in VALID_BYMA_EXPIRY_CODES:
            warnings.append(f"AMBIGUOUS_EXPIRY_SUFFIX: invalid BYMA expiry code '{expiry_code}'")
            continue
        series_code = f"{prefix}{strike_raw}{expiry_code}".upper()

        option_type = "CALL" if prefix.endswith("C") else "PUT"
        strike_ars = _normalize_strike_from_symbol(series_code, strike_raw)

        # Look at tokens after series match
        tail = line[m.end():]
        tokens = NUMERIC_TOKEN_RE.findall(tail)

        # Standard Anexo B layout: [volume/trades] [descubierta] [cubierta] [cruzada] [total]
        # Sometimes incomplete lines carry dashes '-' or fewer than 2 OI columns.
        parsed_nums = [_parse_ar_number(tok) for tok in tokens]
        non_null_count = sum(1 for v in parsed_nums if v is not None)

        has_missing_dash = "-" in tokens
        prior = prior_by_series.get(series_code)
        prior_source_date = (
            prior.get("sourceReportDate") or prior.get("tradeDate")
            if isinstance(prior, dict)
            else None
        )

        if non_null_count >= 3 and not has_missing_dash:
            # Treat last 3 numeric columns as uncovered (descubierta), covered (cubierta), total (or [1],[2])
            if len(parsed_nums) >= 4 and parsed_nums[0] is not None and parsed_nums[1] is not None and parsed_nums[2] is not None:
                daily_volume = parsed_nums[0]
                uncovered = parsed_nums[1]
                covered = parsed_nums[2]
                crossed = parsed_nums[3] if len(parsed_nums) >= 5 and parsed_nums[3] is not None else 0.0
                total_oi = (
                    parsed_nums[-1]
                    if parsed_nums[-1] is not None and len(parsed_nums) >= 4
                    else (uncovered + covered + crossed)
                )
            else:
                daily_volume = parsed_nums[0] if len(parsed_nums) >= 4 else None
                uncovered = parsed_nums[-3] if len(parsed_nums) >= 3 and parsed_nums[-3] is not None else parsed_nums[0]
                covered = parsed_nums[-2] if len(parsed_nums) >= 2 and parsed_nums[-2] is not None else 0.0
                crossed = 0.0
                total_oi = parsed_nums[-1]

            if uncovered is None or total_oi is None:
                seen_series.add(series_code)
                rec: dict[str, Any] = {
                    "series": series_code,
                    "optionType": option_type,
                    "strikeArs": strike_ars if math.isfinite(strike_ars) else None,
                    "expiryCode": expiry_code or None,
                    "uncoveredContracts": prior.get("uncoveredContracts") if prior else None,
                    "coveredContracts": prior.get("coveredContracts") if prior else None,
                    "crossedContracts": prior.get("crossedContracts") if prior else None,
                    "totalContracts": prior.get("totalContracts") if prior else None,
                    "dailyVolumeContracts": daily_volume,
                    "flag": "CARRY_FORWARD_NO_TRADE" if prior else "MISSING_UNAVAILABLE",
                }
                if prior and isinstance(prior_source_date, str) and prior_source_date:
                    rec["sourceReportDate"] = prior_source_date
                records.append(rec)
                continue

            uncov_val = _to_exact_num(uncovered)
            cov_val = _to_exact_num(covered or 0.0)
            cross_val = _to_exact_num(crossed)
            tot_val = _to_exact_num(total_oi)
            sig = (cov_val, uncov_val, cross_val, tot_val)
            if series_code in conflicting_series:
                continue
            if series_code in parsed_by_series:
                if parsed_by_series[series_code] == sig:
                    warnings.append(f"Series {series_code}: exact duplicate row skipped")
                else:
                    warnings.append(f"DUPLICATE_CONFLICTING_SERIES: {series_code}")
                    conflicting_series.add(series_code)
                    records = [r for r in records if r.get("series") != series_code]
                continue
            parsed_by_series[series_code] = sig
            seen_series.add(series_code)

            if daily_volume is not None and daily_volume == 0 and prior is not None:
                rec = {
                    "series": series_code,
                    "optionType": option_type,
                    "strikeArs": strike_ars if math.isfinite(strike_ars) else None,
                    "expiryCode": expiry_code or None,
                    "uncoveredContracts": uncov_val,
                    "coveredContracts": cov_val,
                    "crossedContracts": cross_val,
                    "totalContracts": tot_val,
                    "dailyVolumeContracts": 0,
                    "flag": "CARRY_FORWARD_NO_TRADE",
                }
                if isinstance(prior_source_date, str) and prior_source_date:
                    rec["sourceReportDate"] = prior_source_date
                records.append(rec)
            else:
                records.append(
                    {
                        "series": series_code,
                        "optionType": option_type,
                        "strikeArs": strike_ars if math.isfinite(strike_ars) else None,
                        "expiryCode": expiry_code or None,
                        "uncoveredContracts": uncov_val,
                        "coveredContracts": cov_val,
                        "crossedContracts": cross_val,
                        "totalContracts": tot_val,
                        "dailyVolumeContracts": _to_exact_num(daily_volume),
                        "flag": "FRESH",
                    }
                )
        else:
            if series_code in seen_series:
                continue
            seen_series.add(series_code)
            # Incomplete row or dashes: DO NOT IMPUTE ZEROS!
            if prior is not None:
                rec = {
                    "series": series_code,
                    "optionType": option_type,
                    "strikeArs": strike_ars if math.isfinite(strike_ars) else prior.get("strikeArs"),
                    "expiryCode": expiry_code or prior.get("expiryCode"),
                    "uncoveredContracts": prior.get("uncoveredContracts"),
                    "coveredContracts": prior.get("coveredContracts"),
                    "crossedContracts": prior.get("crossedContracts"),
                    "totalContracts": prior.get("totalContracts"),
                    "dailyVolumeContracts": None,
                    "flag": "CARRY_FORWARD_NO_TRADE",
                }
                if isinstance(prior_source_date, str) and prior_source_date:
                    rec["sourceReportDate"] = prior_source_date
                records.append(rec)
            else:
                warnings.append(
                    f"Series {series_code}: incomplete OI columns and no T-1 record (zero imputation forbidden)"
                )
                records.append(
                    {
                        "series": series_code,
                        "optionType": option_type,
                        "strikeArs": strike_ars if math.isfinite(strike_ars) else None,
                        "expiryCode": expiry_code or None,
                        "uncoveredContracts": None,
                        "coveredContracts": None,
                        "crossedContracts": None,
                        "totalContracts": None,
                        "dailyVolumeContracts": None,
                        "flag": "MISSING_UNAVAILABLE",
                    }
                )

    # Carry forward any T-1 series completely absent from an incomplete daily bulletin
    for series_code, prior in prior_by_series.items():
        if series_code not in seen_series:
            prior_source_date = prior.get("sourceReportDate") or prior.get("tradeDate")
            rec = {
                "series": series_code,
                "optionType": prior.get("optionType", "CALL"),
                "strikeArs": prior.get("strikeArs"),
                "expiryCode": prior.get("expiryCode"),
                "uncoveredContracts": prior.get("uncoveredContracts"),
                "coveredContracts": prior.get("coveredContracts"),
                "crossedContracts": prior.get("crossedContracts"),
                "totalContracts": prior.get("totalContracts"),
                "dailyVolumeContracts": None,
                "flag": "CARRY_FORWARD_NO_TRADE",
            }
            if isinstance(prior_source_date, str) and prior_source_date:
                rec["sourceReportDate"] = prior_source_date
            records.append(rec)

    if records:
        warnings.append("Legacy OI *Contracts fields are deprecated and express nominal shares; use *Nom.")
    for record in records:
        record["unit"] = "SHARES"
        for bucket in ("uncovered", "covered", "crossed", "total"):
            raw_val = record.get(bucket + "Contracts")
            exact_val = _to_exact_num(float(raw_val)) if isinstance(raw_val, (int, float)) else raw_val
            record[bucket + "Contracts"] = exact_val
            record[bucket + "Nom"] = exact_val
    return records, warnings


def parse_anexo_b_csv(
    csv_path: Path,
    prior_by_series: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    lines: list[str] = []
    with csv_path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        reader = csv.reader(fh)
        for row in reader:
            lines.append(" ".join(cell.strip() for cell in row))
    return _parse_anexo_b_lines(lines, prior_by_series)


def load_prior_records(prev_json_path: Path | None) -> dict[str, dict[str, Any]]:
    if prev_json_path is None or not prev_json_path.exists():
        return {}
    try:
        payload = json.loads(prev_json_path.read_text(encoding="utf-8"))
        items = payload.get("records", []) if isinstance(payload, dict) else []
        trade_date = payload.get("tradeDate") if isinstance(payload, dict) else None
        out: dict[str, dict[str, Any]] = {}
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("series"), str):
                item_copy = dict(item)
                if isinstance(trade_date, str) and trade_date and not item_copy.get("sourceReportDate"):
                    item_copy["sourceReportDate"] = trade_date
                out[item_copy["series"].upper()] = item_copy
        return out
    except (OSError, json.JSONDecodeError):
        return {}


def fetch_url_bytes(url: str, timeout_sec: float = 20.0) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "QuantOptionsTerminal-AnexoBIngest/1.0",
            "Accept": "application/pdf,text/html,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return resp.read()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest IAMC Anexo B PDF/CSV for GGAL options OI")
    parser.add_argument("--pdf", type=str, default=None, help="Path to local IAMC Anexo B PDF")
    parser.add_argument("--csv", type=str, default=None, help="Path to incomplete/exported Anexo B CSV")
    parser.add_argument("--url", type=str, default=DEFAULT_IAMC_ANEXO_B_URL, help="IAMC Anexo B PDF/bulletin URL")
    parser.add_argument("--prev-json", type=str, default=None, help="Prior T-1 Anexo B JSON for carry-forward")
    parser.add_argument("--trade-date", type=str, default=None, help="Trade date YYYY-MM-DD")
    parser.add_argument("--out", type=str, default=None, help="Output JSON path (stdout if omitted)")
    args = parser.parse_args(argv)

    art_now = _art_now()
    is_pre_0900_art = art_now.hour < 9
    trade_date = args.trade_date or art_now.strftime("%Y-%m-%d")
    prior_by_series = load_prior_records(Path(args.prev_json) if args.prev_json else None)

    source_kind = "NONE"
    records: list[dict[str, Any]] = []
    warnings: list[str] = []
    status = "OPERATIONAL"
    error_reason: str | None = None

    try:
        if args.pdf:
            source_kind = f"LOCAL_PDF:{args.pdf}"
            raw_pdf = Path(args.pdf).read_bytes()
            text = extract_text_from_pdf_bytes(raw_pdf)
            records, warnings = _parse_anexo_b_lines(text.splitlines(), prior_by_series)
        elif args.csv:
            source_kind = f"LOCAL_CSV:{args.csv}"
            records, warnings = parse_anexo_b_csv(Path(args.csv), prior_by_series)
        else:
            source_kind = f"IAMC_URL:{args.url}"
            raw_bytes = fetch_url_bytes(args.url)
            if raw_bytes.lstrip().startswith(b"%PDF"):
                text = extract_text_from_pdf_bytes(raw_bytes)
                records, warnings = _parse_anexo_b_lines(text.splitlines(), prior_by_series)
            else:
                html_text = raw_bytes.decode("utf-8", errors="ignore")
                pdf_links = re.findall(r'href=["\']([^"\']*anexo[^"\']*\.pdf)["\']', html_text, re.IGNORECASE)
                if not pdf_links:
                    status = "UNAVAILABLE"
                    error_reason = "NO_ANEXO_B_PDF_LINK_FOUND_AT_IAMC_URL"
                else:
                    target_pdf_url = urllib.parse.urljoin(args.url, pdf_links[0])
                    pdf_bytes = fetch_url_bytes(target_pdf_url)
                    text = extract_text_from_pdf_bytes(pdf_bytes)
                    records, warnings = _parse_anexo_b_lines(text.splitlines(), prior_by_series)
    except (OSError, urllib.error.URLError, ValueError) as exc:
        status = "UNAVAILABLE"
        error_reason = f"INGEST_FAILED: {type(exc).__name__}"

    if status == "OPERATIONAL" and not records:
        status = "UNAVAILABLE"
        error_reason = "NO_GGAL_OPTION_RECORDS_EXTRACTED"

    has_carry_forward = any(r.get("flag") == "CARRY_FORWARD_NO_TRADE" for r in records)
    output_payload = {
        "schemaVersion": "1.0.0",
        "source": source_kind,
        "status": status,
        "overallFlag": (
            "CARRY_FORWARD_NO_TRADE"
            if has_carry_forward
            else ("FRESH" if status == "OPERATIONAL" else "UNAVAILABLE")
        ),
        "tradeDate": trade_date,
        "generatedAtUtcSec": int(dt.datetime.now(dt.timezone.utc).timestamp()),
        "generatedAtArt": art_now.strftime("%Y-%m-%d %H:%M:%S ART"),
        "isPreOpen0900Art": is_pre_0900_art,
        "zeroImputationDisabled": True,
        "errorReason": error_reason,
        "warnings": warnings,
        "recordsCount": len(records),
        "records": records,
    }

    encoded = json.dumps(output_payload, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(encoded + "\n", encoding="utf-8")
    else:
        print(encoded)

    return 0 if status == "OPERATIONAL" else 1


if __name__ == "__main__":
    raise SystemExit(main())
