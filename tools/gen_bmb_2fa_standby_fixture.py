#!/usr/bin/env python3
"""Independent reference fixture for BMB login 2FA classification (STANDBY_2FA).

This script deliberately re-states the classification contract from the task
specification with explicit, hand-authored expectations.  It does not import or
inspect the bridge implementation (tools/bmb_homebroker_bridge.py) nor any
TypeScript code.  The generated fixture is consumed by
tools/test_bmb_bridge_reconnect.py (Python bridge) and by
tests/feedsHealthMonitor.test.ts (TS monitor mapping).

Contract under test:
- `BMB_DNI` is reduced to digits only (dots/spaces/other separators removed).
- A pyhomebroker login failure is classified by inspecting ONLY the exception
  message and the requests response URL/status (never printed, never stored raw):
  * two-step verification markers (TwoFactor, VerifyCode, OTP, 2FA, tolerating
    case and separator/space variants) -> `STANDBY_2FA`;
  * otherwise, if the DNI (already cleaned: non-empty digits) and the username
    (non-empty) passed format validation -> `STANDBY_2FA` (interactive SMS/App
    2FA is the expected cause; retry loops must stop to avoid locking the
    account);
  * otherwise -> `ERROR` (redacted generic message).
- The STANDBY_2FA informative message is the fixed literal
  "BMB requiere 2FA interactivo (SMS/App); usando IOL_REST_V2 + Primary DLR como fuente activa".
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

BMB_STANDBY_2FA_STATUS = "STANDBY_2FA"
BMB_STANDBY_2FA_MESSAGE = (
    "BMB requiere 2FA interactivo (SMS/App); usando IOL_REST_V2 + Primary DLR como fuente activa"
)


def clean_dni_reference(raw: str) -> str:
    """Reference: every non-digit character is removed (dots, spaces, dashes)."""
    return re.sub(r"\D", "", raw or "")


def compact_reference(text: str) -> str:
    """Reference normalization: remove separators/spaces, lowercase."""
    return re.sub(r"[\s_\-/.]", "", text).lower()


def indicates_two_factor_reference(message: str, url: str) -> bool:
    compact = compact_reference(f"{message} {url}")
    for marker in ("twofactor", "verifycode", "verifyotp", "otp", "2fa"):
        if marker in compact:
            return True
    return False


def format_valid_reference(dni: str, username: str) -> bool:
    return bool(dni) and bool(username) and dni.isdigit()


def classify_reference(message: str, url: str, dni: str, username: str) -> str:
    if indicates_two_factor_reference(message, url):
        return BMB_STANDBY_2FA_STATUS
    if format_valid_reference(dni, username):
        return BMB_STANDBY_2FA_STATUS
    return "ERROR"


# Hand-authored classification cases: (name, message, url, dni, username, expected).
# `expected` values are written literally; the reference below cross-checks them
# so an authoring error in this table fails loudly instead of shipping.
CLASSIFICATION_CASES: list[tuple[str, str, str, str, str, str]] = [
    (
        "redirect_url_twofactor",
        "Session cannot be created. Check the entered information and try again.",
        "https://bullmarket brokers.invalid/Login/TwoFactor?step=verify",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "redirect_url_verifycode",
        "HTTP 500 on POST",
        "https://homebroker.invalid/VerifyCode",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "message_otp_marker",
        "Se requiere código OTP para continuar",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "message_2fa_marker",
        "Account requires 2FA confirmation",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "message_two_factor_with_spaces_and_dashes",
        "Two-Factor verification pending",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "marker_case_insensitive",
        "TWOFACTOR challenge",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "generic_login_failure_after_valid_format",
        "Session cannot be created. Check the entered information and try again.",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "http_500_after_valid_format",
        "500 Server Error",
        "https://homebroker.invalid/Login/IngresarModal",
        "12345678",
        "trader_user",
        "STANDBY_2FA",
    ),
    (
        "missing_dni_is_error",
        "Session cannot be created. Check the entered information and try again.",
        "https://homebroker.invalid/Login/Ingresar",
        "",
        "trader_user",
        "ERROR",
    ),
    (
        "non_digit_dni_is_error",
        "Session cannot be created. Check the entered information and try again.",
        "https://homebroker.invalid/Login/Ingresar",
        "abc",
        "trader_user",
        "ERROR",
    ),
    (
        "missing_username_is_error",
        "Session cannot be created. Check the entered information and try again.",
        "https://homebroker.invalid/Login/Ingresar",
        "12345678",
        "",
        "ERROR",
    ),
    (
        "no_markers_invalid_format_error",
        "connection refused",
        "https://homebroker.invalid/Login/Ingresar",
        "",
        "",
        "ERROR",
    ),
]

DNI_CLEANING_CASES: list[tuple[str, str, str]] = [
    ("dots", "12.345.678", "12345678"),
    ("spaces", " 12 345 678 ", "12345678"),
    ("dots_and_spaces", " 12. 345. 678 ", "12345678"),
    ("already_clean", "12345678", "12345678"),
    ("empty", "", ""),
    ("only_separators", " . - . ", ""),
]

MARKER_NEGATIVE_CASES: list[tuple[str, str, str]] = [
    ("plain_session_exception", "Session cannot be created. Check the entered information and try again.", "https://homebroker.invalid/Login/Ingresar"),
    ("http_status_only", "500 Server Error: Internal Server Error", "https://homebroker.invalid/Login/Ingresar"),
    ("unrelated_words_no_markers", "connection reset by peer", "https://homebroker.invalid/Login/Ingresar"),
]


def main() -> None:
    fixture: dict[str, Any] = {}

    fixture["standby2faMessage"] = BMB_STANDBY_2FA_MESSAGE

    classification_cases: list[dict[str, Any]] = []
    for name, message, url, dni, username, expected in CLASSIFICATION_CASES:
        reference = classify_reference(message, url, dni, username)
        if reference != expected:
            raise SystemExit(
                f"fixture authoring error: case {name!r} expected {expected!r} "
                f"but reference produced {reference!r}"
            )
        classification_cases.append(
            {
                "name": name,
                "message": message,
                "responseUrl": url,
                "dni": dni,
                "username": username,
                "expected": expected,
            }
        )
    fixture["classification"] = classification_cases

    dni_cases: list[dict[str, Any]] = []
    for name, raw, expected in DNI_CLEANING_CASES:
        reference = clean_dni_reference(raw)
        if reference != expected:
            raise SystemExit(
                f"fixture authoring error: dni case {name!r} expected {expected!r} "
                f"but reference produced {reference!r}"
            )
        dni_cases.append({"name": name, "raw": raw, "expected": expected})
    fixture["dniCleaning"] = dni_cases

    marker_negatives: list[dict[str, Any]] = []
    for name, message, url in MARKER_NEGATIVE_CASES:
        marker_negatives.append(
            {
                "name": name,
                "message": message,
                "responseUrl": url,
                "expected": indicates_two_factor_reference(message, url),
            }
        )
    fixture["markerNegatives"] = marker_negatives

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "bmb_2fa_standby.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(fixture, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
