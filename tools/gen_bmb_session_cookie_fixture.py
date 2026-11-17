#!/usr/bin/env python3
"""Independent reference fixture for the BMB_SESSION_COOKIE trusted-device support.

This script deliberately re-states the cookie contract with explicit,
hand-authored expectations.  It does not import or inspect the bridge
implementation (tools/bmb_homebroker_bridge.py) nor any TypeScript code.  The
generated fixture is consumed by tools/test_bmb_bridge_reconnect.py.

Contract under test:
- `BMB_SESSION_COOKIE` parses as `k=v; k2=v2` pairs: `;` is the only separator,
  fragments without `=` or with empty name/value are ignored, whitespace around
  names/values is trimmed, and values may contain `=` (base64 padding).
- Pairs are injected into the exposed requests session cookie jars for BOTH
  trusted-device domains (`hb.bullmarketbrokers.com` and
  `.bullmarketbrokers.com`) with path `/`.
- A modern browser User-Agent (`BMB_BROWSER_USER_AGENT`) is configured on the
  exposed sessions and on the library's `user_agent` module globals.
- Cookie values are never logged or exposed (only counts/labels).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

TRUSTED_DEVICE_DOMAINS = ["hb.bullmarketbrokers.com", ".bullmarketbrokers.com"]
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def parse_reference(raw: str) -> list[list[str]]:
    """Reference parser: `;` separates pairs; `=` splits name/value once; empty
    fragments, missing `=`, or empty name/value are dropped; edges trimmed."""
    pairs: list[list[str]] = []
    for fragment in (raw or "").split(";"):
        if not fragment.strip() or "=" not in fragment:
            continue
        name, _, value = fragment.partition("=")
        name = name.strip()
        value = value.strip()
        if name and value:
            pairs.append([name, value])
    return pairs


def jar_expectation_reference(pairs: list[list[str]], domains: list[str]) -> list[list[str]]:
    """Reference derivation: every parsed pair must appear in the jar for every
    trusted-device domain with path `/`."""
    expectation: list[list[str]] = []
    for name, value in pairs:
        for domain in domains:
            expectation.append([name, value, domain, "/"])
    return expectation


# Hand-authored parse cases: (name, raw cookie header, expected pairs).
PARSE_CASES: list[tuple[str, str, list[list[str]]]] = [
    ("empty", "", []),
    ("whitespace_only", "   ", []),
    ("single_pair", "ASP.NET_SessionId=k1v2", [["ASP.NET_SessionId", "k1v2"]]),
    (
        "multiple_pairs_with_spaces",
        ".ASPXAUTH=AbCd/EfG==;  ASP.NET_SessionId=xyz123 ; .AspNet.Cookies=A1B2C3=",
        [
            [".ASPXAUTH", "AbCd/EfG=="],
            ["ASP.NET_SessionId", "xyz123"],
            [".AspNet.Cookies", "A1B2C3="],
        ],
    ),
    (
        "malformed_fragment_ignored",
        ".ASPXAUTH=token; not-a-cookie; k=v",
        [[".ASPXAUTH", "token"], ["k", "v"]],
    ),
    ("empty_value_dropped", "k=; k2=v2", [["k2", "v2"]]),
    ("empty_name_dropped", "=v; k2=v2", [["k2", "v2"]]),
    ("value_with_equals_padding", "token=abc==def", [["token", "abc==def"]]),
    ("no_equals_fragment_only", "broken-fragment", []),
]

# Cross-check pairs against jar expectations for every parse case with cookies.
JAR_CHECK_CASES: list[str] = [
    "single_pair",
    "multiple_pairs_with_spaces",
    "malformed_fragment_ignored",
    "empty_value_dropped",
    "empty_name_dropped",
    "value_with_equals_padding",
]


def main() -> None:
    fixture: dict[str, Any] = {
        "trustedDeviceDomains": TRUSTED_DEVICE_DOMAINS,
        "browserUserAgent": BROWSER_USER_AGENT,
    }

    parse_cases: list[dict[str, Any]] = []
    for name, raw, expected in PARSE_CASES:
        reference = parse_reference(raw)
        if reference != expected:
            raise SystemExit(
                f"fixture authoring error: case {name!r} expected {expected!r} "
                f"but reference produced {reference!r}"
            )
        case: dict[str, Any] = {"name": name, "raw": raw, "expectedPairs": expected}
        if name in JAR_CHECK_CASES:
            case["expectedJarEntries"] = jar_expectation_reference(expected, TRUSTED_DEVICE_DOMAINS)
        parse_cases.append(case)
    fixture["parseCases"] = parse_cases

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "bmb_session_cookie.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(fixture, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
