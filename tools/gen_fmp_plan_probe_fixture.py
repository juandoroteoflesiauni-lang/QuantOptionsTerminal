#!/usr/bin/env python3
"""Referencia independiente para el plan probe de FMP (Pieza 41.4)."""

import json
from pathlib import Path


def definition(alias, endpoint, plan, feature):
    return {
        "alias": alias,
        "endpoint": endpoint,
        "planTierRequired": plan,
        "planFeature": feature,
    }


def main() -> None:
    fixture = {
        "definitions": [
            definition("FMP_API_KEY", "/stable/profile?symbol=AAPL", "STARTER", "Company Profile Data"),
            definition(
                "FMP_KEY_13F",
                "/stable/institutional-ownership/dates?cik=0001067983",
                "ULTIMATE",
                "Form 13F Filings Dates",
            ),
            definition(
                "FMP_KEY_ANALYST",
                "/stable/analyst-estimates?symbol=AAPL&period=annual&page=0&limit=10",
                "ULTIMATE",
                "Financial Estimates",
            ),
            definition(
                "FMP_KEY_CALENDARS",
                "/stable/earnings-calendar?from=2026-11-17&to=2026-11-20",
                "STARTER",
                "Earnings Calendar",
            ),
            definition("FMP_KEY_ETF", "/stable/etf-list", "STARTER", "ETF Symbol Search"),
            definition(
                "FMP_KEY_FILINGS",
                "/stable/sec-filings-search/form-type?formType=8-K&from=2026-11-01&to=2026-11-17&page=0&limit=10",
                "STARTER",
                "SEC Filings By Form Type",
            ),
            definition(
                "FMP_KEY_MACRO",
                "/stable/economic-calendar?from=2026-11-17&to=2026-11-20",
                "STARTER",
                "Economic Data Releases Calendar",
            ),
            definition(
                "FMP_KEY_MARKET",
                "/stable/historical-chart/5min?symbol=AAPL",
                "STARTER",
                "5 Min Interval Stock Chart",
            ),
            definition("FMP_KEY_NEWS", "/stable/news/stock-latest?page=0&limit=20", "STARTER", "Stock News"),
            definition("FMP_KEY_PROFILES", "/stable/profile?symbol=AAPL", "STARTER", "Company Profile Data"),
            definition("FMP_KEY_QUOTES", "/stable/quote?symbol=AAPL", "ULTIMATE", "Stock Quote"),
            definition(
                "FMP_KEY_STATEMENTS",
                "/stable/income-statement?symbol=AAPL&limit=1",
                "STARTER",
                "Income Statement",
            ),
            definition(
                "FMP_KEY_TECHNICAL",
                "/stable/technical-indicators/sma?symbol=AAPL&periodLength=10&timeframe=1day",
                "STARTER",
                "Simple Moving Average",
            ),
            definition(
                "FMP_KEY_TRANSCRIPTS",
                "/stable/earning-call-transcript?symbol=AAPL&year=2020&quarter=3",
                "ULTIMATE",
                "Earnings Transcript",
            ),
        ],
        "classification": [
            {"httpStatus": 200, "rows": 1, "error": None, "access": "ALLOWED"},
            {"httpStatus": 401, "rows": None, "error": "HTTP_401", "access": "BLOCKED"},
            {"httpStatus": 402, "rows": None, "error": "HTTP_402", "access": "BLOCKED"},
            {"httpStatus": 403, "rows": None, "error": "HTTP_403", "access": "BLOCKED"},
            {"httpStatus": 500, "rows": None, "error": "HTTP_500", "access": "ERROR"},
            {"httpStatus": None, "rows": None, "error": "NETWORK_ERROR", "access": "ERROR"},
        ],
    }

    path = Path(__file__).resolve().parents[1] / "fixtures" / "fmp_plan_probe_reference.json"
    path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"fixture: {path}")


if __name__ == "__main__":
    main()
