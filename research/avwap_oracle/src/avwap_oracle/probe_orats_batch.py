"""Read-only 2-request live ORATS multi-ticker batching micro-probe (Prompt #5 Task 3).

Strict rules:
- Uses ONLY verified ORATS Slot #1 (ORATS_API_KEY).
- Executes AT MOST 2 logical ORATS endpoint requests (or 1 clarifying WHAM request with ``--only-wham``):
  1) GET /datav2/hist/strikes?ticker=SPY,NVDA,MELI&tradeDate=2024-06-20
  2) GET /datav2/hist/wham?ticker=SPY,QQQ,IWM&tradeDate=2024-06-12
- Never modifies existing Parquet files, manifests, or config.
- Sanitizes all URLs/exceptions before writing or printing anything.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
from typing import Any, Sequence

import httpx
import polars as pl

from avwap_oracle.adapters.credentials import (
    ORATS_BASE_URL,
    SecretSanitizer,
    load_oracle_credentials,
)
from avwap_oracle.adapters.orats_rest import compute_gex_opex_summary_from_strikes


def _rel_diff(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return None
    if b == 0.0:
        return abs(a - b)
    return abs(a - b) / abs(b)


def _abs_diff(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or not (math.isfinite(a) and math.isfinite(b)):
        return None
    return abs(a - b)


def _norm_nan(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def run_orats_batch_micro_probe(
    root: Path | None = None,
    *,
    only_wham: bool = False,
    transport: httpx.BaseTransport | None = None,
    orats_token_override: str | None = None,
) -> dict[str, Any]:
    lab_root = root if root is not None else Path(__file__).resolve().parents[2]
    data_root = lab_root / "data"
    out_path = lab_root / "reports" / "probe_orats_batch_results.json"

    if orats_token_override is not None:
        token_val = orats_token_override
        slot_id = "TEST_OVERRIDE"
        san = SecretSanitizer([orats_token_override])
    else:
        creds = load_oracle_credentials()
        orats_slots = creds.slots_for_domain("ORATS_HISTORICAL")
        slot1 = next((s for s in orats_slots if s.env_name == "ORATS_API_KEY"), orats_slots[0])
        token_val = slot1.value
        slot_id = slot1.slot_id
        san = creds.sanitizer

    strikes_date = "2024-06-20"
    strikes_tickers = ["SPY", "NVDA", "MELI"]
    wham_date = "2024-06-12"
    wham_tickers = ["SPY", "QQQ", "IWM"]

    local_wham_spy_row = (
        pl.read_parquet(data_root / "derivatives/orats_wham/SPY.parquet")
        .filter(pl.col("trade_date") == wham_date)
        .row(0, named=True)
    )
    local_wham_spy_payload = json.loads(str(local_wham_spy_row["payload_json"]))

    results: dict[str, Any] = {
        "executed_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "credential_slot_used": slot_id,
        "requests_count": 0,
        "only_wham": only_wham,
    }

    client_kwargs: dict[str, Any] = {"follow_redirects": True, "timeout": 30.0}
    if transport is not None:
        client_kwargs["transport"] = transport
    else:
        client_kwargs["verify"] = True

    with httpx.Client(**client_kwargs) as client:
        if only_wham:
            if not out_path.is_file():
                raise FileNotFoundError(f"Cannot run --only-wham without prior results at {out_path}")
            prev_payload = json.loads(out_path.read_text(encoding="utf-8"))
            results["hist_strikes"] = prev_payload["hist_strikes"]
            prior_reqs = int(prev_payload.get("requests_count", 2))
        else:
            prior_reqs = 0
            local_gex: dict[str, dict[str, Any]] = {}
            for sym in strikes_tickers:
                gpath = data_root / f"derivatives/orats_gex_opex/{sym}.parquet"
                row = pl.read_parquet(gpath).filter(pl.col("trade_date") == strikes_date).row(0, named=True)
                local_gex[sym] = row

            # REQUEST 1: GET /datav2/hist/strikes?ticker=SPY,NVDA,MELI&tradeDate=2024-06-20
            r1 = client.get(
                f"{ORATS_BASE_URL}/hist/strikes",
                params={"token": token_val, "ticker": ",".join(strikes_tickers), "tradeDate": strikes_date},
            )
            results["requests_count"] += 1
            hist1 = [{"status_code": h.status_code, "url": san.sanitize_url(str(h.url))} for h in r1.history]
            redirected_302_1 = any(h.status_code == 302 for h in r1.history)
            payload1 = (
                r1.json()
                if "json" in (r1.headers.get("content-type") or "").lower() or r1.text.lstrip().startswith("{")
                else {}
            )
            data1 = payload1.get("data") or [] if isinstance(payload1, dict) else []

            rows_by_t1: dict[str, list[dict[str, Any]]] = {}
            for row in data1:
                if isinstance(row, dict):
                    tk = str(row.get("ticker") or "").strip().upper()
                    rows_by_t1.setdefault(tk, []).append(row)

            gex_comparison: dict[str, Any] = {}
            all_gex_match = True
            for sym in strikes_tickers:
                sym_rows = rows_by_t1.get(sym, [])
                loc = local_gex[sym]
                spot = float(loc["massive_spot"])
                batch_summary = compute_gex_opex_summary_from_strikes(
                    sym,
                    strikes_date,
                    sym_rows,
                    massive_spot=spot,
                    sampling_mode=str(loc["sampling_mode"]),
                    is_quad_witching=bool(loc["is_quad_witching"]),
                    monthly_opex_date=str(loc["monthly_opex_expir_date"]),
                )
                fields_cmp: dict[str, Any] = {}
                for fld in ("abs_gex_total", "call_wall_strike", "put_wall_strike", "zero_gamma_est"):
                    bv = _norm_nan(batch_summary.get(fld))
                    lv = _norm_nan(loc.get(fld))
                    adiff = _abs_diff(bv, lv)
                    rdiff = _rel_diff(bv, lv)
                    if bv is None and lv is None:
                        exact = str(batch_summary.get("zero_gamma_reason")) == str(loc.get("zero_gamma_reason"))
                    elif bv is None or lv is None:
                        exact = False
                    else:
                        exact = (rdiff is not None and rdiff <= 1e-12) or (adiff is not None and adiff <= 1e-9)
                    if not exact:
                        all_gex_match = False
                    fields_cmp[fld] = {
                        "batch_value": bv,
                        "parquet_value": lv,
                        "abs_diff": adiff,
                        "rel_diff": rdiff,
                        "exact_match": exact,
                    }
                gex_comparison[sym] = {
                    "batch_row_count": len(sym_rows),
                    "parquet_strike_rows_processed": int(loc["strike_rows_processed"]),
                    "fields": fields_cmp,
                }

            strikes_supported = (
                r1.status_code == 200
                and set(strikes_tickers).issubset(set(rows_by_t1.keys()))
                and all_gex_match
            )
            results["hist_strikes"] = {
                "request_url": san.sanitize_url(str(r1.history[0].url if r1.history else r1.url)),
                "initial_http_status": r1.history[0].status_code if r1.history else r1.status_code,
                "final_http_status": r1.status_code,
                "redirect_302_detected": redirected_302_1,
                "redirect_history": hist1,
                "truncated_flag": payload1.get("truncated") if isinstance(payload1, dict) else None,
                "total_rows": len(data1),
                "unique_tickers_returned": sorted(rows_by_t1.keys()),
                "row_counts_by_ticker": {k: len(v) for k, v in sorted(rows_by_t1.items())},
                "gex_parity_comparison": gex_comparison,
                "verdict": "SUPPORTED" if strikes_supported else "UNSUPPORTED",
            }

        # REQUEST 2: GET /datav2/hist/wham?ticker=SPY,QQQ,IWM&tradeDate=2024-06-12
        r2 = client.get(
            f"{ORATS_BASE_URL}/hist/wham",
            params={"token": token_val, "ticker": ",".join(wham_tickers), "tradeDate": wham_date},
        )
        results["requests_count"] += 1
        results["total_prompt5_requests"] = (prior_reqs + 1) if only_wham else results["requests_count"]
        hist2 = [{"status_code": h.status_code, "url": san.sanitize_url(str(h.url))} for h in r2.history]
        redirected_302_2 = any(h.status_code == 302 for h in r2.history)
        payload2 = (
            r2.json()
            if "json" in (r2.headers.get("content-type") or "").lower() or r2.text.lstrip().startswith("{")
            else {}
        )
        data2 = payload2.get("data") or [] if isinstance(payload2, dict) else []

        rows_by_t2: dict[str, list[dict[str, Any]]] = {}
        matching_rows_by_t2: dict[str, list[dict[str, Any]]] = {}
        trade_dates_by_t2: dict[str, list[str]] = {}
        quote_dates_by_t2: dict[str, list[str]] = {}
        for row in data2:
            if isinstance(row, dict):
                tk = str(row.get("ticker") or "").strip().upper()
                rows_by_t2.setdefault(tk, []).append(row)
                td_val = str(row.get("tradeDate") or row.get("date") or "").strip()[:10]
                qd_val = str(row.get("quoteDate") or "").strip()
                if td_val:
                    trade_dates_by_t2.setdefault(tk, [])
                    if td_val not in trade_dates_by_t2[tk]:
                        trade_dates_by_t2[tk].append(td_val)
                if qd_val:
                    quote_dates_by_t2.setdefault(tk, [])
                    if qd_val not in quote_dates_by_t2[tk]:
                        quote_dates_by_t2[tk].append(qd_val)
                if td_val == wham_date:
                    matching_rows_by_t2.setdefault(tk, []).append(row)

        spy_all_rows = rows_by_t2.get("SPY", [])
        spy_match_rows = matching_rows_by_t2.get("SPY", [])
        spy_exact_single = len(spy_match_rows) == 1 and spy_match_rows[0] == local_wham_spy_payload
        spy_any_exact = any(r == local_wham_spy_payload for r in spy_match_rows)

        spy_diff_keys: list[str] = []
        ref_row = spy_match_rows[-1] if spy_match_rows else (spy_all_rows[-1] if spy_all_rows else None)
        if ref_row is not None and ref_row != local_wham_spy_payload:
            all_k = sorted(set(ref_row.keys()) | set(local_wham_spy_payload.keys()))
            spy_diff_keys = [k for k in all_k if ref_row.get(k) != local_wham_spy_payload.get(k)]

        all_tickers_have_date = all(len(matching_rows_by_t2.get(tk, [])) >= 1 for tk in wham_tickers)
        if r2.status_code != 200:
            wham_verdict_reason = f"HTTP_{r2.status_code}"
        elif not set(wham_tickers).issubset(set(rows_by_t2.keys())):
            wham_verdict_reason = "MISSING_TICKERS_IN_BATCH"
        elif not all_tickers_have_date:
            wham_verdict_reason = "TRADEDATE_NOT_MATCHED_IN_BATCH"
        elif not spy_any_exact:
            wham_verdict_reason = "SPY_PAYLOAD_MISMATCH_WITH_PARQUET"
        elif len(spy_all_rows) > 1 and len(spy_match_rows) == 1:
            wham_verdict_reason = "SUPPORTED_WITH_CLIENT_TRADEDATE_FILTER_EXTRA_ROWS_RETURNED"
        elif len(spy_match_rows) > 1:
            wham_verdict_reason = "SUPPORTED_WITH_MULTIPLE_QUOTEDATES_MATCHING_PARQUET"
        else:
            wham_verdict_reason = "OK_EXACT_1_TO_1"

        wham_supported = (
            r2.status_code == 200
            and set(wham_tickers).issubset(set(rows_by_t2.keys()))
            and all_tickers_have_date
            and spy_any_exact
        )
        results["hist_wham"] = {
            "request_url": san.sanitize_url(str(r2.history[0].url if r2.history else r2.url)),
            "initial_http_status": r2.history[0].status_code if r2.history else r2.status_code,
            "final_http_status": r2.status_code,
            "redirect_302_detected": redirected_302_2,
            "redirect_history": hist2,
            "total_rows": len(data2),
            "unique_tickers_returned": sorted(rows_by_t2.keys()),
            "row_counts_by_ticker": {k: len(v) for k, v in sorted(rows_by_t2.items())},
            "matching_date_row_counts_by_ticker": {k: len(matching_rows_by_t2.get(k, [])) for k in sorted(wham_tickers)},
            "trade_dates_by_ticker": {k: sorted(v) for k, v in sorted(trade_dates_by_t2.items())},
            "quote_dates_by_ticker": {k: sorted(v) for k, v in sorted(quote_dates_by_t2.items())},
            "spy_exact_1_to_1_single_row_with_parquet": spy_exact_single,
            "spy_exact_1_to_1_match_with_parquet": spy_any_exact,
            "spy_diff_keys": spy_diff_keys,
            "verdict_reason": wham_verdict_reason,
            "verdict": "SUPPORTED" if wham_supported else "UNSUPPORTED",
        }

    sanitized_text = san.sanitize_text(json.dumps(results, indent=2, sort_keys=True, allow_nan=False))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(sanitized_text, encoding="utf-8")
    return json.loads(sanitized_text)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Read-only 2-request ORATS multi-ticker batching micro-probe")
    p.add_argument("--only-wham", action="store_true", help="Reuse cached hist_strikes parity and probe only /hist/wham (1 request)")
    args = p.parse_args(argv)
    print(json.dumps(run_orats_batch_micro_probe(only_wham=bool(args.only_wham)), indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
