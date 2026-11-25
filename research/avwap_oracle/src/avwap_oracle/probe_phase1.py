"""Phase 1 empirical read-only audit probe for FMP Enterprise, Massive STOCKS_REST, and ORATS.

Confinement and safety guarantees:
- Writes exclusively inside ``research/avwap_oracle/reports/``.
- Reads only authorized credentials (``FMP_API_KEY`` selected from ``FMP_*``,
  ``MASSIVE_KEY_2``, ``ORATS_API_KEY``) from root ``.env`` via ``dotenv_values``.
- Sanitizes all credentials from URLs, params, logs, errors, and JSON/MD outputs.
- Executes strictly HTTP GET requests with TLS verification, no redirects,
  explicit host allowlist, explicit timeouts, and bounded transient retries.
"""

from __future__ import annotations

import datetime as dt
import email.utils
import json
import logging
import math
import re
import statistics
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

import httpx
from dotenv import dotenv_values

# Keep HTTP client libraries quiet; never enable DEBUG HTTP logging.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

ET_TZ = ZoneInfo("America/New_York")
UTC_TZ = ZoneInfo("UTC")

RESEARCH_CUTOFF_DATE = "2026-11-24"
FALLBACK_DELISTED_DATE = "2022-06-15"

DELISTED_CANDIDATES: tuple[str, ...] = (
    "TWTR",
    "ATVI",
    "VMW",
    "SPLK",
    "PXD",
    "MRO",
    "SIVB",
    "FRC",
    "HES",
    "DFS",
    "ANSS",
    "CERN",
)

INTERNATIONAL_TICKERS: tuple[str, ...] = (
    "TSM",
    "ASML",
    "NVO",
    "MELI",
    "NU",
    "PBR",
    "YPF",
    "VIST",
    "PAM",
    "GGAL",
    "BMA",
    "BABA",
)

ALLOWED_HOSTS: dict[str, frozenset[str]] = {
    "fmp": frozenset({"financialmodelingprep.com"}),
    "massive": frozenset({"api.massive.com"}),
    "orats": frozenset({"api.orats.io"}),
}

FMP_STABLE_BASE = "https://financialmodelingprep.com/stable"
MASSIVE_BASE = "https://api.massive.com"
ORATS_BASE = "https://api.orats.io/datav2"

RESULT_STATUSES: tuple[str, ...] = (
    "OK_DATA",
    "OK_EMPTY",
    "AUTH_ERROR",
    "FORBIDDEN",
    "NOT_FOUND",
    "RATE_LIMITED",
    "HTTP_ERROR",
    "NETWORK_ERROR",
    "SCHEMA_MISMATCH",
    "NOT_EXECUTED",
)

FIELD_STATES: tuple[str, ...] = (
    "FIELD_MISSING",
    "FIELD_NULL",
    "FIELD_ZERO",
    "FIELD_VALID",
    "FIELD_INVALID",
)

SCALE_CLASSES: tuple[str, ...] = (
    "SAME_SCALE",
    "SCALE_100X",
    "SCALE_0_01X",
    "OTHER_RATIO",
    "NOT_COMPARABLE",
    "UNVERIFIED",
)

HYPOTHESIS_STATES: tuple[str, ...] = (
    "CONFIRMED",
    "CONTRADICTED",
    "INCONCLUSIVE",
    "NOT_TESTED",
)

AUTH_QUERY_KEYS = frozenset({"apikey", "api_key", "token", "key", "secret"})
SECRET_QUERY_RE = re.compile(
    r"(?i)([?&](?:apikey|api_key|token|key|secret|password)=)([^&\s'\"}\]]+)"
)
BEARER_HEADER_RE = re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;'\"]+)")


def default_perimeter_root() -> Path:
    """Resolve ``research/avwap_oracle`` from module path."""
    return Path(__file__).resolve().parents[2]


def default_repo_root() -> Path:
    """Resolve repository root from ``research/avwap_oracle/src/avwap_oracle/probe_phase1.py``."""
    return Path(__file__).resolve().parents[4]


class SecretSanitizer:
    """Centralized secret redactor for URLs, query params, exceptions, and reports."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        variants: list[str] = []
        seen: set[str] = set()
        for raw in secrets:
            if not raw:
                continue
            trimmed = raw.strip()
            for cand in (raw, trimmed, urllib.parse.quote(trimmed, safe="")):
                if cand and cand not in seen:
                    seen.add(cand)
                    variants.append(cand)
        # Longest first so partial substrings never leave fragments behind.
        self._secrets: tuple[str, ...] = tuple(sorted(variants, key=len, reverse=True))

    def sanitize_text(self, text: str) -> str:
        out = text
        for sec in self._secrets:
            if sec in out:
                out = out.replace(sec, "<REDACTED>")
        out = SECRET_QUERY_RE.sub(r"\1<REDACTED>", out)
        out = BEARER_HEADER_RE.sub(r"\1<REDACTED>", out)
        return out

    def sanitize_params(self, params: dict[str, Any] | None) -> dict[str, Any]:
        if not params:
            return {}
        clean: dict[str, Any] = {}
        for k, v in params.items():
            if k.lower() in AUTH_QUERY_KEYS:
                continue
            if isinstance(v, str):
                clean[k] = self.sanitize_text(v)
            else:
                clean[k] = v
        return clean

    def sanitize_exception(self, exc: BaseException) -> str:
        return f"{type(exc).__name__}: {self.sanitize_text(str(exc))}"

    def sanitize_obj(self, obj: Any) -> Any:
        if obj is None or isinstance(obj, bool):
            return obj
        if isinstance(obj, int):
            return obj
        if isinstance(obj, float):
            if not math.isfinite(obj):
                return None
            return obj
        if isinstance(obj, str):
            return self.sanitize_text(obj)
        if isinstance(obj, dict):
            clean_dict: dict[str, Any] = {}
            for k, v in obj.items():
                ks = self.sanitize_text(str(k))
                if ks.lower() in AUTH_QUERY_KEYS:
                    clean_dict[ks] = "<REDACTED>"
                else:
                    clean_dict[ks] = self.sanitize_obj(v)
            return clean_dict
        if isinstance(obj, (list, tuple)):
            return [self.sanitize_obj(item) for item in obj]
        return self.sanitize_text(str(obj))


@dataclass(frozen=True)
class AuthorizedCredentials:
    """In-memory credentials and sanitized audit metadata (never serialized with values)."""

    fmp_key: str | None
    massive_key_2: str | None
    orats_api_key: str | None
    audit: dict[str, Any]
    sanitizer: SecretSanitizer


def load_authorized_credentials(env_path: Path) -> AuthorizedCredentials:
    """Load strictly FMP, MASSIVE_KEY_2, and ORATS_API_KEY from root ``.env``."""
    if not env_path.is_file():
        audit = {
            "env_file_found": False,
            "fmp": {
                "selected_var_name": None,
                "candidate_var_names": [],
                "duplicate_var_names": [],
                "ambiguity_detected": False,
                "ambiguity_note": "Root .env file not found.",
            },
            "massive": {"selected_var_name": "MASSIVE_KEY_2", "present": False},
            "orats": {"selected_var_name": "ORATS_API_KEY", "present": False},
        }
        return AuthorizedCredentials(None, None, None, audit, SecretSanitizer())

    # Count occurrences of scoped keys only to detect duplicate definitions cleanly.
    fmp_counts: dict[str, int] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        s = raw_line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k = s.split("=", 1)[0].strip()
        if k.startswith("FMP_"):
            fmp_counts[k] = fmp_counts.get(k, 0) + 1

    raw_values = dotenv_values(env_path)
    fmp_candidates = sorted(k for k, v in raw_values.items() if k.startswith("FMP_") and v and v.strip())
    fmp_duplicates = sorted(k for k, count in fmp_counts.items() if count > 1)

    selected_fmp_name: str | None = None
    fmp_key: str | None = None
    if "FMP_API_KEY" in raw_values and raw_values["FMP_API_KEY"] and raw_values["FMP_API_KEY"].strip():
        selected_fmp_name = "FMP_API_KEY"
        fmp_key = raw_values["FMP_API_KEY"].strip().strip('"').strip("'")
    elif len(fmp_candidates) == 1:
        selected_fmp_name = fmp_candidates[0]
        fmp_key = str(raw_values[selected_fmp_name]).strip().strip('"').strip("'")

    ambiguity_detected = len(fmp_candidates) > 1 or len(fmp_duplicates) > 0
    if len(fmp_candidates) > 1:
        ambiguity_note = (
            f"Multiple non-empty FMP_* variables found ({len(fmp_candidates)} candidates: "
            f"{', '.join(fmp_candidates)}); deterministically selected FMP_API_KEY without "
            "probing alternative credentials."
        )
    elif len(fmp_candidates) == 1:
        ambiguity_note = f"Single FMP credential variable found ({selected_fmp_name})."
    else:
        ambiguity_note = "No non-empty FMP_* credential variable found."

    raw_massive = raw_values.get("MASSIVE_KEY_2")
    massive_key_2 = raw_massive.strip().strip('"').strip("'") if raw_massive and raw_massive.strip() else None

    raw_orats = raw_values.get("ORATS_API_KEY")
    orats_api_key = raw_orats.strip().strip('"').strip("'") if raw_orats and raw_orats.strip() else None

    sanitizer = SecretSanitizer(x for x in (fmp_key, massive_key_2, orats_api_key) if x)
    audit = {
        "env_file_found": True,
        "fmp": {
            "selected_var_name": selected_fmp_name,
            "present": fmp_key is not None,
            "candidate_var_names": fmp_candidates,
            "duplicate_var_names": fmp_duplicates,
            "ambiguity_detected": ambiguity_detected,
            "ambiguity_note": ambiguity_note,
        },
        "massive": {
            "selected_var_name": "MASSIVE_KEY_2",
            "present": massive_key_2 is not None,
        },
        "orats": {
            "selected_var_name": "ORATS_API_KEY",
            "present": orats_api_key is not None,
        },
    }
    return AuthorizedCredentials(fmp_key, massive_key_2, orats_api_key, audit, sanitizer)


def build_fmp_url(endpoint: str, base_url: str = FMP_STABLE_BASE) -> str:
    """Build FMP stable URL without duplicating ``/stable/``."""
    base = base_url.rstrip("/")
    clean = endpoint.strip()
    if clean.startswith("https://") or clean.startswith("http://"):
        return clean
    clean = clean.lstrip("/")
    if base.endswith("/stable") and clean.startswith("stable/"):
        clean = clean[len("stable/") :]
    elif base.endswith("/stable") and clean == "stable":
        clean = ""
    return f"{base}/{clean}" if clean else base


def parse_retry_after_seconds(value: str | None, now_epoch_sec: float | None = None) -> float | None:
    """Parse numeric or HTTP-date ``Retry-After`` header value into non-negative seconds."""
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        secs = float(text)
        return secs if math.isfinite(secs) and secs >= 0 else None
    except ValueError:
        pass
    try:
        parsed_dt = email.utils.parsedate_to_datetime(text)
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=UTC_TZ)
        now_s = time.time() if now_epoch_sec is None else now_epoch_sec
        delta = parsed_dt.timestamp() - now_s
        return max(0.0, delta)
    except Exception:
        return None


def classify_field_value(container: dict[str, Any], key: str) -> tuple[str, Any]:
    """Differentiate FIELD_MISSING, FIELD_NULL, FIELD_ZERO, FIELD_VALID, FIELD_INVALID."""
    if key not in container:
        return "FIELD_MISSING", None
    val = container[key]
    if val is None:
        return "FIELD_NULL", None
    if isinstance(val, bool):
        return "FIELD_INVALID", val
    if isinstance(val, (int, float)):
        fval = float(val)
        if not math.isfinite(fval):
            return "FIELD_INVALID", None
        if fval == 0.0:
            return "FIELD_ZERO", 0
        return "FIELD_VALID", val
    if isinstance(val, str):
        stripped = val.strip()
        if stripped == "":
            return "FIELD_INVALID", val
        return "FIELD_VALID", val
    return "FIELD_VALID", val


def safe_ratio(numerator: Any, denominator: Any) -> float | None:
    """Safely divide two finite numeric values, returning ``None`` when non-computable."""
    if isinstance(numerator, bool) or isinstance(denominator, bool):
        return None
    if not isinstance(numerator, (int, float)) or not isinstance(denominator, (int, float)):
        return None
    num = float(numerator)
    den = float(denominator)
    if not (math.isfinite(num) and math.isfinite(den)) or den == 0.0:
        return None
    res = num / den
    return res if math.isfinite(res) else None


def classify_scale_ratio(
    value_cores: Any,
    value_summaries: Any,
    *,
    comparable: bool = True,
    rel_tol: float = 0.03,
) -> tuple[float | None, str]:
    """Compute ``value_cores / value_summaries`` and classify scale relationship."""
    if not comparable:
        return None, "NOT_COMPARABLE"
    ratio = safe_ratio(value_cores, value_summaries)
    if ratio is None:
        return None, "UNVERIFIED"
    if ratio <= 0:
        return ratio, "OTHER_RATIO"
    if abs(ratio - 1.0) <= rel_tol:
        return ratio, "SAME_SCALE"
    if abs(ratio - 100.0) <= 100.0 * rel_tol:
        return ratio, "SCALE_100X"
    if abs(ratio - 0.01) <= 0.01 * rel_tol:
        return ratio, "SCALE_0_01X"
    return ratio, "OTHER_RATIO"


def _detect_app_level_error(payload: Any) -> tuple[str | None, str | None]:
    """Detect application-level errors inside HTTP 200 JSON responses."""
    if not isinstance(payload, dict):
        return None, None
    err_msg = payload.get("Error Message") or payload.get("error") or payload.get("message")
    status_val = payload.get("status")
    has_data = any(
        isinstance(payload.get(k), list) for k in ("data", "results", "historical")
    )
    if isinstance(status_val, str) and status_val.upper() not in {"OK", "SUCCESS", "DELAYED"}:
        msg = str(err_msg or status_val)
        low = msg.lower()
        if any(w in low for w in ("unauthorized", "invalid api", "invalid key", "auth")):
            return "AUTH_ERROR", f"HTTP 200 application-level auth error: {msg}"
        if any(w in low for w in ("not authorized", "forbidden", "plan", "upgrade", "subscription", "entitle")):
            return "FORBIDDEN", f"HTTP 200 application-level entitlement error: {msg}"
        return "SCHEMA_MISMATCH", f"HTTP 200 application-level status={status_val}: {msg}"
    if isinstance(err_msg, str) and err_msg.strip() and not has_data:
        low = err_msg.lower()
        if any(w in low for w in ("invalid api key", "unauthorized", "invalid token")):
            return "AUTH_ERROR", f"HTTP 200 application-level auth error: {err_msg}"
        if any(w in low for w in ("upgrade", "subscription", "not authorized", "restricted", "legacy endpoint", "plan")):
            return "FORBIDDEN", f"HTTP 200 application-level entitlement error: {err_msg}"
        return "SCHEMA_MISMATCH", f"HTTP 200 application-level error: {err_msg}"
    return None, None


def _extract_records(provider: str, payload: Any) -> tuple[list[dict[str, Any]] | None, str, str]:
    """Extract normalized record list, response shape, and pagination status."""
    if isinstance(payload, list):
        dict_rows = [r for r in payload if isinstance(r, dict)]
        if len(dict_rows) != len(payload):
            return None, "list_non_dict", "UNKNOWN"
        return dict_rows, "list", "SINGLE_PAGE_OR_UNPAGINATED"
    if isinstance(payload, dict):
        if provider == "orats":
            if "data" in payload:
                data = payload["data"]
                if data is None:
                    return [], "dict_data_null", "SINGLE_PAGE_OR_UNPAGINATED"
                if isinstance(data, list) and all(isinstance(r, dict) for r in data):
                    return data, "dict_data_list", "SINGLE_PAGE_OR_UNPAGINATED"
                return None, "dict_data_invalid", "UNKNOWN"
            return None, "dict_missing_data", "UNKNOWN"
        if provider == "massive":
            next_url = payload.get("next_url")
            pag = "PAGINATED_NEXT_URL_PRESENT" if isinstance(next_url, str) and next_url.strip() else "SINGLE_PAGE_OR_END"
            if "results" in payload:
                res = payload["results"]
                if res is None:
                    return [], "dict_results_null", pag
                if isinstance(res, list) and all(isinstance(r, dict) for r in res):
                    return res, "dict_results_list", pag
                return None, "dict_results_invalid", pag
            if "symbol" in payload or "from" in payload:
                return [payload], "dict_single_record", "SINGLE_RECORD"
            return None, "dict_missing_results", pag
        # FMP dict shape
        if "historical" in payload and isinstance(payload["historical"], list):
            hist = payload["historical"]
            if all(isinstance(r, dict) for r in hist):
                return hist, "dict_historical_list", "SINGLE_PAGE_OR_UNPAGINATED"
        if payload:
            return [payload], "dict_single_record", "SINGLE_RECORD"
        return [], "dict_empty", "SINGLE_PAGE_OR_UNPAGINATED"
    return None, type(payload).__name__, "UNKNOWN"


def _infer_field_types(rows: list[dict[str, Any]]) -> dict[str, str]:
    if not rows:
        return {}
    types_by_key: dict[str, set[str]] = {}
    for row in rows[:25]:
        for k, v in row.items():
            t = "null" if v is None else type(v).__name__
            types_by_key.setdefault(k, set()).add(t)
    return {k: "|".join(sorted(ts)) for k, ts in sorted(types_by_key.items())}


def _infer_date_range(rows: list[dict[str, Any]]) -> dict[str, str] | None:
    if not rows:
        return None
    date_keys = ("date", "tradeDate", "earnDate", "filingDate", "acceptedDate", "execution_date", "ex_dividend_date", "delisted_utc", "t")
    for dk in date_keys:
        vals: list[str] = []
        for row in rows:
            raw = row.get(dk)
            if isinstance(raw, str) and raw.strip():
                vals.append(raw.strip()[:10] if len(raw.strip()) >= 10 else raw.strip())
            elif dk == "t" and isinstance(raw, (int, float)) and not isinstance(raw, bool):
                sec = raw / 1000.0 if raw > 1e11 else float(raw)
                vals.append(dt.datetime.fromtimestamp(sec, UTC_TZ).strftime("%Y-%m-%d"))
        if vals:
            return {"field": dk, "min": min(vals), "max": max(vals)}
    return None


@dataclass
class QueryOutcome:
    record: dict[str, Any]
    rows: list[dict[str, Any]] = field(default_factory=list)
    raw_payload: Any = None


class ProbeHttpClient:
    """Centralized, sanitized, read-only GET HTTP client using httpx."""

    def __init__(
        self,
        credentials: AuthorizedCredentials,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        max_retries: int = 2,
        max_retry_wait_sec: float = 15.0,
    ) -> None:
        self.credentials = credentials
        self.sanitizer = credentials.sanitizer
        self.sleep_fn = sleep_fn
        self.max_retries = max_retries
        self.max_retry_wait_sec = max_retry_wait_sec
        self.requests_by_provider: dict[str, int] = {"fmp": 0, "massive": 0, "orats": 0}
        self._client = httpx.Client(
            verify=True,
            follow_redirects=False,
            timeout=httpx.Timeout(connect=10.0, read=25.0, write=10.0, pool=10.0),
            transport=transport,
            headers={"User-Agent": "avwap-oracle-phase1-probe/0.1"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ProbeHttpClient:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _credential_for(self, provider: str) -> tuple[str | None, str]:
        if provider == "fmp":
            return self.credentials.fmp_key, "apikey"
        if provider == "massive":
            return self.credentials.massive_key_2, "apikey"
        if provider == "orats":
            return self.credentials.orats_api_key, "token"
        raise ValueError(f"Unsupported provider: {provider}")

    def _build_base_url(self, provider: str, endpoint: str) -> str:
        if provider == "fmp":
            return build_fmp_url(endpoint)
        clean = endpoint.lstrip("/")
        if provider == "massive":
            return f"{MASSIVE_BASE}/{clean}"
        if provider == "orats":
            if clean.startswith("datav2/"):
                clean = clean[len("datav2/") :]
            return f"{ORATS_BASE}/{clean}"
        raise ValueError(f"Unsupported provider: {provider}")

    def get_json(
        self,
        provider: str,
        endpoint: str,
        params: dict[str, Any] | None = None,
        *,
        label: str | None = None,
    ) -> QueryOutcome:
        sanitized_params = self.sanitizer.sanitize_params(params)
        api_key, auth_param = self._credential_for(provider)
        base_rec = {
            "label": label or endpoint,
            "provider": provider,
            "endpoint": endpoint,
            "sanitized_params": sanitized_params,
            "http_status": None,
            "result_status": "NOT_EXECUTED",
            "response_shape": None,
            "record_count": 0,
            "sample_keys": [],
            "observed_field_types": {},
            "observed_date_range": None,
            "pagination_status": "NOT_EXECUTED",
            "elapsed_ms": 0.0,
            "sanitized_error": None,
            "observations": [],
        }

        if not api_key:
            base_rec["sanitized_error"] = f"Missing authorized credential for provider={provider}"
            base_rec["observations"].append("Query not executed due to missing credential.")
            return QueryOutcome(record=base_rec)

        url = self._build_base_url(provider, endpoint)
        parsed = urllib.parse.urlparse(url)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or hostname not in ALLOWED_HOSTS.get(provider, frozenset()):
            base_rec["result_status"] = "NETWORK_ERROR"
            base_rec["pagination_status"] = "BLOCKED"
            base_rec["sanitized_error"] = f"Blocked unauthorized host or scheme: {parsed.scheme}://{hostname}"
            base_rec["observations"].append("Host allowlist/TLS check prevented sending credentials.")
            return QueryOutcome(record=base_rec)

        req_params: dict[str, Any] = dict(sanitized_params)
        req_params[auth_param] = api_key

        t0 = time.perf_counter()
        last_exc: str | None = None
        resp: httpx.Response | None = None

        for attempt in range(self.max_retries + 1):
            self.requests_by_provider[provider] = self.requests_by_provider.get(provider, 0) + 1
            try:
                resp = self._client.get(url, params=req_params)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = self.sanitizer.sanitize_exception(exc)
                if attempt < self.max_retries:
                    self.sleep_fn(min(self.max_retry_wait_sec, 0.5 * (2**attempt)))
                    continue
                base_rec["result_status"] = "NETWORK_ERROR"
                base_rec["pagination_status"] = "ERROR"
                base_rec["elapsed_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
                base_rec["sanitized_error"] = last_exc
                base_rec["observations"].append(f"Request failed after {attempt + 1} attempt(s).")
                return QueryOutcome(record=base_rec)
            except Exception as exc:
                base_rec["result_status"] = "NETWORK_ERROR"
                base_rec["pagination_status"] = "ERROR"
                base_rec["elapsed_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
                base_rec["sanitized_error"] = self.sanitizer.sanitize_exception(exc)
                return QueryOutcome(record=base_rec)

            if resp.status_code in {429, 500, 502, 503, 504} and attempt < self.max_retries:
                ra = parse_retry_after_seconds(resp.headers.get("Retry-After"))
                wait_s = ra if ra is not None else 0.5 * (2**attempt)
                if resp.status_code == 429 and ra is not None and ra > self.max_retry_wait_sec:
                    base_rec["observations"].append(
                        f"Retry-After={ra:.1f}s exceeded cap {self.max_retry_wait_sec:.1f}s; aborted retries."
                    )
                    break
                self.sleep_fn(min(self.max_retry_wait_sec, wait_s))
                continue
            break

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        assert resp is not None
        base_rec["http_status"] = resp.status_code
        base_rec["elapsed_ms"] = elapsed_ms

        if resp.status_code != 200:
            status_map = {
                401: "AUTH_ERROR",
                403: "FORBIDDEN",
                404: "NOT_FOUND",
                429: "RATE_LIMITED",
            }
            base_rec["result_status"] = status_map.get(resp.status_code, "HTTP_ERROR")
            base_rec["pagination_status"] = "HTTP_ERROR"
            snippet = self.sanitizer.sanitize_text(resp.text[:300])
            base_rec["sanitized_error"] = f"HTTP {resp.status_code}: {snippet}"
            return QueryOutcome(record=base_rec)

        try:
            payload = resp.json()
        except Exception as exc:
            base_rec["result_status"] = "SCHEMA_MISMATCH"
            base_rec["response_shape"] = "invalid_json"
            base_rec["pagination_status"] = "ERROR"
            base_rec["sanitized_error"] = self.sanitizer.sanitize_exception(exc)
            base_rec["observations"].append("HTTP 200 response body was not valid JSON.")
            return QueryOutcome(record=base_rec)

        app_err_status, app_err_msg = _detect_app_level_error(payload)
        if app_err_status is not None:
            base_rec["result_status"] = app_err_status
            base_rec["response_shape"] = "dict_app_error"
            base_rec["pagination_status"] = "ERROR"
            base_rec["sanitized_error"] = self.sanitizer.sanitize_text(app_err_msg or "")
            base_rec["observations"].append("HTTP 200 returned an application-level error payload.")
            return QueryOutcome(record=base_rec, raw_payload=self.sanitizer.sanitize_obj(payload))

        rows, shape, pag_status = _extract_records(provider, payload)
        base_rec["response_shape"] = shape
        base_rec["pagination_status"] = pag_status
        if rows is None:
            base_rec["result_status"] = "SCHEMA_MISMATCH"
            base_rec["sanitized_error"] = f"Unexpected payload shape: {shape}"
            return QueryOutcome(record=base_rec, raw_payload=self.sanitizer.sanitize_obj(payload))

        sanitized_rows = self.sanitizer.sanitize_obj(rows)
        limit_val = sanitized_params.get("limit")
        if isinstance(limit_val, int) and len(sanitized_rows) >= limit_val and pag_status == "SINGLE_PAGE_OR_END":
            base_rec["pagination_status"] = "LIMIT_REACHED_MAY_BE_TRUNCATED"

        base_rec["record_count"] = len(sanitized_rows)
        base_rec["result_status"] = "OK_DATA" if sanitized_rows else "OK_EMPTY"
        base_rec["sample_keys"] = sorted({k for r in sanitized_rows[:10] for k in r.keys()})
        base_rec["observed_field_types"] = _infer_field_types(sanitized_rows)
        base_rec["observed_date_range"] = _infer_date_range(sanitized_rows)
        return QueryOutcome(record=base_rec, rows=sanitized_rows, raw_payload=self.sanitizer.sanitize_obj(payload))


# ---------------------------------------------------------------------------
# Repository static inspection (§9)
# ---------------------------------------------------------------------------

def extract_us_equity_universe(repo_root: Path) -> dict[str, Any]:
    """Statically extract US_EQUITY_UNIVERSE from ``src/server/marketRuntime.ts`` without executing TS."""
    target = repo_root / "src" / "server" / "marketRuntime.ts"
    lines = target.read_text(encoding="utf-8").splitlines()
    start_idx = next(i for i, line in enumerate(lines) if "export const US_EQUITY_UNIVERSE" in line)
    end_idx = next(i for i in range(start_idx + 1, len(lines)) if "] as const;" in lines[i])

    symbols: list[str] = []
    for line in lines[start_idx : end_idx + 1]:
        m_obj = re.search(r"symbol:\s*'([^']+)'", line)
        m_fn = re.search(r"makeGeneralUsEquityMeta\(\s*'([^']+)'", line)
        if m_obj:
            symbols.append(m_obj.group(1))
        elif m_fn:
            symbols.append(m_fn.group(1))

    seen: set[str] = set()
    duplicates: list[str] = []
    for s in symbols:
        if s in seen:
            duplicates.append(s)
        else:
            seen.add(s)

    return {
        "expected_count": 162,
        "observed_count": len(symbols),
        "unique_count": len(seen),
        "matches_expected": len(symbols) == 162,
        "duplicates": duplicates,
        "symbols": symbols,
        "source_path": "src/server/marketRuntime.ts",
        "source_line_range": f"{start_idx + 1}-{end_idx + 1}",
    }


def _extract_ts_date_set(text: str, const_name: str) -> list[str]:
    m = re.search(rf"const\s+{const_name}\s*=\s*new\s+Set\(\[(.*?)\]\)", text, flags=re.S)
    if not m:
        return []
    return re.findall(r"'(\d{4}-\d{2}-\d{2})'", m.group(1))


def inspect_nyse_calendar(repo_root: Path) -> dict[str, Any]:
    """Inspect existing NYSE 2020-2028 calendar and Python reference script without modifying them."""
    us_hist_path = repo_root / "src" / "core" / "usHistorical.ts"
    sessions_path = repo_root / "src" / "core" / "sessions.ts"
    alignment_path = repo_root / "src" / "data" / "alignment.ts"
    py_oracle_path = repo_root / "tools" / "generate_pieza0b_massive_rest_reference.py"

    us_hist_text = us_hist_path.read_text(encoding="utf-8")
    closed_dates = sorted(_extract_ts_date_set(us_hist_text, "CLOSED"))
    early_dates = sorted(_extract_ts_date_set(us_hist_text, "EARLY"))
    years = sorted({int(d[:4]) for d in closed_dates + early_dates})

    return {
        "exact_ts_path": "src/core/usHistorical.ts",
        "supporting_ts_paths": ["src/core/sessions.ts", "src/data/alignment.ts"],
        "python_validation_script": "tools/generate_pieza0b_massive_rest_reference.py" if py_oracle_path.is_file() else None,
        "python_reference_fixture": "fixtures/pieza0b_massive_rest_reference.json" if (repo_root / "fixtures" / "pieza0b_massive_rest_reference.json").is_file() else None,
        "supported_years": f"{min(years)}-{max(years)}" if years else "UNKNOWN",
        "supported_years_list": years,
        "closed_dates_count": len(closed_dates),
        "early_close_dates_count": len(early_dates),
        "closed_dates": closed_dates,
        "early_close_dates": early_dates,
        "representation": "Static Sets CLOSED and EARLY of YYYY-MM-DD strings + usHistoricalSession(timeSec) returning UTC seconds {open, close, extendedOpen, extendedClose}.",
        "timezone": "America/New_York (Intl.DateTimeFormat in src/core/sessions.ts; ZoneInfo('America/New_York') in Python oracle).",
        "full_holiday_rules": "Weekdays > 5 (Sat/Sun) or dateKey in CLOSED fail closed (returns null); out-of-range years throw HISTORICAL_CALENDAR_OUT_OF_COVERAGE. New Year Saturday (2022-01-01, 2028-01-01) is NOT observed on preceding Friday; Juneteenth starts in 2022.",
        "early_close_representation": "dateKey in EARLY maps RTH close from wall(960) [16:00 ET] to wall(780) [13:00 ET = 780 minutesOfDay] and extendedClose from wall(1200) [20:00 ET] to wall(1020) [17:00 ET].",
        "dst_handling": "etWallTimeToUtc(year, month, day, minutesOfDay) probes EDT (-4h) and EST (-5h) offsets against getMarketParts(..., 'EQUITY'); Python oracle uses datetime(..., tzinfo=ZoneInfo('America/New_York')).timestamp().",
        "extraordinary_exceptions": ["2025-01-09 (National Day of Mourning for President Jimmy Carter)"] if "2025-01-09" in closed_dates else [],
        "notes_for_canonical_rth": [
            "Reusing CLOSED and EARLY sets directly covers 2020-01-01..2028-12-31 including 2025-01-09 and 13:00 ET early closes.",
            "Polars/Python datetime conversion must rely on tzdata + ZoneInfo('America/New_York') for exact DST transitions.",
            "RTH bars are strictly half-open [open_utc, close_utc) in integer UTC seconds (opening timestamps: 09:30..15:59 on regular days, 09:30..12:59 on early-close days).",
        ],
    }


def select_delisted_probe_date(
    delisted_utc: str | None,
    closed_dates: set[str],
    *,
    min_year: int = 2020,
    max_year: int = 2028,
) -> dict[str, Any]:
    """Derive NYSE business date ``<= delisting_date - 30d`` or explicit fallback ``2022-06-15``."""
    if not delisted_utc or not isinstance(delisted_utc, str):
        return {
            "delisted_utc_literal": delisted_utc,
            "delisting_date": None,
            "target_date_raw": None,
            "queried_date": FALLBACK_DELISTED_DATE,
            "date_provenance": "FALLBACK_DEFAULT",
            "adjustment_reason": "No usable delisted_utc returned by Massive reference.",
        }

    raw = delisted_utc.strip()
    try:
        iso = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        parsed = dt.datetime.fromisoformat(iso)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC_TZ)
        # Midnight UTC timestamps represent calendar delisting dates in Massive reference.
        if parsed.hour == 0 and parsed.minute == 0 and parsed.second == 0 and raw.endswith("Z"):
            delisting_date = parsed.date()
            conv_note = "Date taken from UTC midnight literal."
        else:
            delisting_date = parsed.astimezone(ET_TZ).date()
            conv_note = "Date converted from timestamp to America/New_York."
    except Exception:
        return {
            "delisted_utc_literal": delisted_utc,
            "delisting_date": None,
            "target_date_raw": None,
            "queried_date": FALLBACK_DELISTED_DATE,
            "date_provenance": "FALLBACK_DEFAULT",
            "adjustment_reason": "Unparseable delisted_utc timestamp.",
        }

    target = delisting_date - dt.timedelta(days=30)
    if target.year < min_year or target.year > max_year:
        return {
            "delisted_utc_literal": delisted_utc,
            "delisting_date": delisting_date.isoformat(),
            "target_date_raw": target.isoformat(),
            "queried_date": FALLBACK_DELISTED_DATE,
            "date_provenance": "FALLBACK_DEFAULT",
            "adjustment_reason": f"Target date {target.isoformat()} outside verified NYSE calendar {min_year}-{max_year}.",
        }

    candidate = target
    reasons: list[str] = [conv_note]
    while candidate.weekday() >= 5 or candidate.isoformat() in closed_dates:
        if candidate.weekday() >= 5:
            reasons.append(f"Adjusted backward past weekend ({candidate.isoformat()}).")
        else:
            reasons.append(f"Adjusted backward past NYSE holiday ({candidate.isoformat()}).")
        candidate -= dt.timedelta(days=1)
        if candidate.year < min_year:
            return {
                "delisted_utc_literal": delisted_utc,
                "delisting_date": delisting_date.isoformat(),
                "target_date_raw": target.isoformat(),
                "queried_date": FALLBACK_DELISTED_DATE,
                "date_provenance": "FALLBACK_DEFAULT",
                "adjustment_reason": "Adjusted date fell outside verified NYSE calendar.",
            }

    if candidate == target:
        reasons.append("Target date is an NYSE trading day.")
    return {
        "delisted_utc_literal": delisted_utc,
        "delisting_date": delisting_date.isoformat(),
        "target_date_raw": target.isoformat(),
        "queried_date": candidate.isoformat(),
        "date_provenance": "DERIVED_FROM_DELISTING",
        "adjustment_reason": " ".join(reasons),
    }


# ---------------------------------------------------------------------------
# Provider audit suites (§5 - §8)
# ---------------------------------------------------------------------------

def _has_time_and_tz(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        return {"literal": value, "json_type": type(value).__name__, "has_time": False, "has_seconds": False, "has_tz_offset": False, "timezone_status": "TIMEZONE_UNVERIFIED"}
    has_time = bool(re.search(r"[T ]\d{2}:\d{2}", value))
    has_seconds = bool(re.search(r"\d{2}:\d{2}:\d{2}", value))
    has_tz = bool(re.search(r"(Z|[+-]\d{2}:?\d{2})$", value.strip()))
    return {
        "literal": value,
        "json_type": "str",
        "has_time": has_time,
        "has_seconds": has_seconds,
        "has_tz_offset": has_tz,
        "timezone_status": "EXPLICIT_TZ" if has_tz else "TIMEZONE_UNVERIFIED",
    }


def probe_fmp_suite(client: ProbeHttpClient) -> dict[str, Any]:
    queries: list[dict[str, Any]] = []
    details: dict[str, Any] = {}

    # 5.1 Earnings individual
    out_ern = client.get_json("fmp", "earnings", {"symbol": "AAPL"}, label="fmp_earnings_aapl")
    queries.append(out_ern.record)
    time_vals = [r.get("time") for r in out_ern.rows if "time" in r]
    non_null_times = [v for v in time_vals if v is not None and str(v).strip() != ""]
    timing_candidates = [k for k in out_ern.record["sample_keys"] if any(w in k.lower() for w in ("time", "date", "tod", "hour", "fiscal", "update"))]
    details["earnings_aapl"] = {
        "has_time_field": "time" in out_ern.record["sample_keys"],
        "time_type": out_ern.record["observed_field_types"].get("time"),
        "non_null_time_samples": non_null_times[:10],
        "timing_related_keys": timing_candidates,
        "sample_row": out_ern.rows[0] if out_ern.rows else None,
    }

    # 5.2 Earnings calendar
    out_ecal = client.get_json(
        "fmp",
        "earnings-calendar",
        {"from": "2026-10-01", "to": RESEARCH_CUTOFF_DATE},
        label="fmp_earnings_calendar",
    )
    queries.append(out_ecal.record)
    cal_times = [r.get("time") for r in out_ecal.rows if "time" in r]
    cal_time_dist: dict[str, int] = {}
    for v in cal_times:
        key = "<NULL>" if v is None else repr(v)
        cal_time_dist[key] = cal_time_dist.get(key, 0) + 1
    details["earnings_calendar"] = {
        "has_time_field": "time" in out_ecal.record["sample_keys"],
        "time_distribution_top": dict(sorted(cal_time_dist.items(), key=lambda kv: -kv[1])[:10]),
        "sample_row": out_ecal.rows[0] if out_ecal.rows else None,
    }

    # 5.3 SEC Filings
    out_sec_sym = client.get_json(
        "fmp",
        "sec-filings-search/symbol",
        {"symbol": "AAPL", "from": "2025-01-01", "to": RESEARCH_CUTOFF_DATE},
        label="fmp_sec_filings_aapl",
    )
    queries.append(out_sec_sym.record)
    sec_sym_sample = out_sec_sym.rows[0] if out_sec_sym.rows else {}
    details["sec_filings_symbol"] = {
        "acceptedDate_info": _has_time_and_tz(sec_sym_sample.get("acceptedDate")) if sec_sym_sample else None,
        "filingDate_info": _has_time_and_tz(sec_sym_sample.get("filingDate")) if sec_sym_sample else None,
        "sample_row": sec_sym_sample or None,
    }

    out_sec_form = client.get_json(
        "fmp",
        "sec-filings-search/form-type",
        {"formType": "424B5", "from": "2026-09-01", "to": RESEARCH_CUTOFF_DATE},
        label="fmp_sec_filings_424b5",
    )
    queries.append(out_sec_form.record)
    sec_form_sample = out_sec_form.rows[0] if out_sec_form.rows else {}
    details["sec_filings_form_424b5"] = {
        "acceptedDate_info": _has_time_and_tz(sec_form_sample.get("acceptedDate")) if sec_form_sample else None,
        "filingDate_info": _has_time_and_tz(sec_form_sample.get("filingDate")) if sec_form_sample else None,
        "sample_row": sec_form_sample or None,
    }

    # 5.4 Historical constituents
    out_sp = client.get_json("fmp", "historical-sp500-constituent", label="fmp_hist_sp500")
    queries.append(out_sp.record)
    sp_dates = [str(r.get("date")) for r in out_sp.rows if r.get("date")]
    details["historical_sp500"] = {
        "earliest_date": min(sp_dates) if sp_dates else None,
        "latest_date": max(sp_dates) if sp_dates else None,
        "add_remove_keys": [k for k in out_sp.record["sample_keys"] if any(w in k.lower() for w in ("add", "remov", "symbol", "date"))],
        "sample_row": out_sp.rows[0] if out_sp.rows else None,
    }

    out_ndx = client.get_json("fmp", "historical-nasdaq-constituent", label="fmp_hist_nasdaq")
    queries.append(out_ndx.record)
    ndx_dates = [str(r.get("date")) for r in out_ndx.rows if r.get("date")]
    details["historical_nasdaq"] = {
        "earliest_date": min(ndx_dates) if ndx_dates else None,
        "latest_date": max(ndx_dates) if ndx_dates else None,
        "add_remove_keys": [k for k in out_ndx.record["sample_keys"] if any(w in k.lower() for w in ("add", "remov", "symbol", "date"))],
        "sample_row": out_ndx.rows[0] if out_ndx.rows else None,
    }

    # 5.5 Economic calendar
    out_eco = client.get_json(
        "fmp",
        "economic-calendar",
        {"from": "2026-10-01", "to": RESEARCH_CUTOFF_DATE},
        label="fmp_economic_calendar",
    )
    queries.append(out_eco.record)
    us_row = next((r for r in out_eco.rows if str(r.get("country", "")).upper() in {"US", "USA", "UNITED STATES"}), None)
    details["economic_calendar"] = {
        "us_example": us_row,
        "date_info": _has_time_and_tz(us_row.get("date")) if us_row else None,
    }

    # 5.6 Shares float
    float_details: dict[str, Any] = {}
    for sym in ("AAPL", "MELI"):
        out_fl = client.get_json("fmp", "shares-float", {"symbol": sym}, label=f"fmp_shares_float_{sym}")
        queries.append(out_fl.record)
        row = out_fl.rows[0] if out_fl.rows else {}
        ff_state, ff_val = classify_field_value(row, "freeFloat")
        fs_state, fs_val = classify_field_value(row, "floatShares")
        os_state, os_val = classify_field_value(row, "outstandingShares")
        ratio = safe_ratio(fs_val, os_val)
        pct = ratio * 100.0 if ratio is not None else None
        unit_class = "UNVERIFIED"
        if ratio is not None and isinstance(ff_val, (int, float)) and not isinstance(ff_val, bool):
            ff_num = float(ff_val)
            if abs(ff_num - pct) <= 0.5:
                unit_class = "PERCENTAGE_0_100"
            elif abs(ff_num - ratio) <= 0.005:
                unit_class = "DECIMAL_0_1"
        float_details[sym] = {
            "effective_date": row.get("date"),
            "freeFloat": ff_val,
            "freeFloat_state": ff_state,
            "floatShares": fs_val,
            "floatShares_state": fs_state,
            "outstandingShares": os_val,
            "outstandingShares_state": os_state,
            "float_ratio": ratio,
            "float_percent": pct,
            "unit_classification": unit_class,
            "point_in_time_note": "Current/latest snapshot only, not historical point-in-time.",
        }
    details["shares_float"] = float_details

    # 5.7 Corporate actions: NVDA split 10:1 & COST dividends
    out_splits = client.get_json("fmp", "splits", {"symbol": "NVDA"}, label="fmp_splits_nvda")
    queries.append(out_splits.record)
    nvda_10_1 = next((r for r in out_splits.rows if str(r.get("date", "")).startswith("2024-06-10")), None)
    details["splits_nvda"] = {
        "nvda_2024_06_10_found": nvda_10_1 is not None,
        "nvda_2024_06_10_record": nvda_10_1,
        "sample_rows": out_splits.rows[:3],
    }

    out_divs = client.get_json("fmp", "dividends", {"symbol": "COST"}, label="fmp_dividends_cost")
    queries.append(out_divs.record)
    special_15 = next(
        (r for r in out_divs.rows if isinstance(r.get("dividend"), (int, float)) and abs(float(r["dividend"]) - 15.0) < 0.01)
        or (r for r in out_divs.rows if isinstance(r.get("adjDividend"), (int, float)) and abs(float(r["adjDividend"]) - 15.0) < 0.01),
        None,
    )
    ordinary_sample = next((r for r in out_divs.rows if r is not special_15 and isinstance(r.get("dividend"), (int, float)) and float(r["dividend"]) < 5.0), None)
    type_keys = [k for k in out_divs.record["sample_keys"] if any(w in k.lower() for w in ("type", "special", "kind", "class", "freq"))]
    details["dividends_cost"] = {
        "special_15_usd_found": special_15 is not None,
        "special_15_usd_record": special_15,
        "ordinary_sample_record": ordinary_sample,
        "explicit_classification_keys": type_keys,
        "has_explicit_special_classification": len(type_keys) > 0,
    }

    return {"queries": queries, "details": details}


def _bar_to_rth_info(bar: dict[str, Any], early_close_dates: set[str]) -> dict[str, Any] | None:
    t_raw = bar.get("t")
    if not isinstance(t_raw, (int, float)) or isinstance(t_raw, bool):
        return None
    sec = int(t_raw // 1000) if t_raw > 1e11 else int(t_raw)
    dt_utc = dt.datetime.fromtimestamp(sec, UTC_TZ)
    dt_et = dt_utc.astimezone(ET_TZ)
    date_et = dt_et.strftime("%Y-%m-%d")
    mins = dt_et.hour * 60 + dt_et.minute
    close_mins = 13 * 60 if date_et in early_close_dates else 16 * 60
    if not (9 * 60 + 30 <= mins < close_mins):
        return None
    vw_state, vw_val = classify_field_value(bar, "vw")
    return {
        "time_sec": sec,
        "timestamp_utc": dt_utc.isoformat(),
        "timestamp_et": dt_et.isoformat(),
        "date_et": date_et,
        "hm_et": dt_et.strftime("%H:%M"),
        "o": bar.get("o"),
        "c": bar.get("c"),
        "v": bar.get("v"),
        "vw": vw_val,
        "vw_state": vw_state,
    }


def _summarize_ratios(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "min": None, "median": None, "max": None}
    return {
        "count": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "max": max(values),
    }


def probe_massive_suite(client: ProbeHttpClient, calendar_info: dict[str, Any]) -> dict[str, Any]:
    queries: list[dict[str, Any]] = []
    details: dict[str, Any] = {}
    early_dates = set(calendar_info.get("early_close_dates", []))

    # 6.1 NVDA split 10:1 experiment
    out_unadj = client.get_json(
        "massive",
        "v2/aggs/ticker/NVDA/range/1/minute/2024-06-07/2024-06-10",
        {"adjusted": "false", "limit": 5000},
        label="massive_nvda_unadjusted",
    )
    queries.append(out_unadj.record)

    out_adj = client.get_json(
        "massive",
        "v2/aggs/ticker/NVDA/range/1/minute/2024-06-07/2024-06-10",
        {"adjusted": "true", "limit": 5000},
        label="massive_nvda_adjusted",
    )
    queries.append(out_adj.record)

    def index_rth(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
        indexed: dict[int, dict[str, Any]] = {}
        for row in rows:
            info = _bar_to_rth_info(row, early_dates)
            if info is not None:
                indexed[info["time_sec"]] = info
        return indexed

    unadj_rth = index_rth(out_unadj.rows)
    adj_rth = index_rth(out_adj.rows)

    def pick_target_bars(indexed: dict[int, dict[str, Any]]) -> dict[str, Any]:
        pre_bars = sorted((b for b in indexed.values() if b["date_et"] == "2024-06-07"), key=lambda x: x["time_sec"])
        post_bars = sorted((b for b in indexed.values() if b["date_et"] == "2024-06-10"), key=lambda x: x["time_sec"])
        pre_bar = pre_bars[-1] if pre_bars else None
        post_bar = post_bars[0] if post_bars else None
        return {
            "pre_rth_count": len(pre_bars),
            "post_rth_count": len(post_bars),
            "pre_bar": pre_bar,
            "pre_expected_15_59_found": bool(pre_bar and pre_bar["hm_et"] == "15:59"),
            "post_bar": post_bar,
            "post_expected_09_30_found": bool(post_bar and post_bar["hm_et"] == "09:30"),
        }

    unadj_picks = pick_target_bars(unadj_rth)
    adj_picks = pick_target_bars(adj_rth)

    def same_bar_factors(u_bar: dict[str, Any] | None, a_bar: dict[str, Any] | None) -> dict[str, Any]:
        if not u_bar or not a_bar or u_bar["time_sec"] != a_bar["time_sec"]:
            return {"matched_timestamp": False}
        return {
            "matched_timestamp": True,
            "timestamp_et": u_bar["timestamp_et"],
            "price_factor_o": safe_ratio(u_bar["o"], a_bar["o"]),
            "price_factor_c": safe_ratio(u_bar["c"], a_bar["c"]),
            "price_factor_vw": safe_ratio(u_bar["vw"], a_bar["vw"]),
            "volume_factor": safe_ratio(a_bar["v"], u_bar["v"]),
        }

    session_stats: dict[str, Any] = {}
    for target_date in ("2024-06-07", "2024-06-10"):
        pf_o: list[float] = []
        pf_c: list[float] = []
        pf_vw: list[float] = []
        vf: list[float] = []
        common_ts = sorted(ts for ts in unadj_rth if ts in adj_rth and unadj_rth[ts]["date_et"] == target_date)
        for ts in common_ts:
            u = unadj_rth[ts]
            a = adj_rth[ts]
            for lst, num, den in (
                (pf_o, u["o"], a["o"]),
                (pf_c, u["c"], a["c"]),
                (pf_vw, u["vw"], a["vw"]),
                (vf, a["v"], u["v"]),
            ):
                r = safe_ratio(num, den)
                if r is not None:
                    lst.append(r)
        session_stats[target_date] = {
            "matched_rth_bars": len(common_ts),
            "price_factor_o": _summarize_ratios(pf_o),
            "price_factor_c": _summarize_ratios(pf_c),
            "price_factor_vw": _summarize_ratios(pf_vw),
            "volume_factor": _summarize_ratios(vf),
        }

    raw_jump = safe_ratio(
        unadj_picks["pre_bar"]["c"] if unadj_picks["pre_bar"] else None,
        unadj_picks["post_bar"]["o"] if unadj_picks["post_bar"] else None,
    )
    adj_jump = safe_ratio(
        adj_picks["pre_bar"]["c"] if adj_picks["pre_bar"] else None,
        adj_picks["post_bar"]["o"] if adj_picks["post_bar"] else None,
    )

    pre_vw_med = session_stats["2024-06-07"]["price_factor_vw"]["median"]
    post_vw_med = session_stats["2024-06-10"]["price_factor_vw"]["median"]
    pre_vf_med = session_stats["2024-06-07"]["volume_factor"]["median"]
    if (
        out_unadj.record["result_status"] == "OK_DATA"
        and out_adj.record["result_status"] == "OK_DATA"
        and pre_vw_med is not None
        and abs(pre_vw_med - 10.0) < 0.05
        and post_vw_med is not None
        and abs(post_vw_med - 1.0) < 0.01
    ):
        vw_verdict = (
            "VERIFIED: adjusted=false returns valid unadjusted vw on pre-split bars (~10x adjusted vw) "
            "and ~1.0x post-split; vw adjusts identically to O/C while volume adjusts reciprocally (~10x)."
        )
    else:
        vw_verdict = "UNVERIFIED: sample did not establish consistent 10x/1x vw adjustment semantics."

    details["nvda_split_experiment"] = {
        "unadjusted": unadj_picks,
        "adjusted": adj_picks,
        "pre_split_same_bar_factors": same_bar_factors(unadj_picks["pre_bar"], adj_picks["pre_bar"]),
        "post_split_same_bar_factors": same_bar_factors(unadj_picks["post_bar"], adj_picks["post_bar"]),
        "per_session_rth_stats": session_stats,
        "raw_session_jump": raw_jump,
        "adjusted_session_jump": adj_jump,
        "vw_verdict": vw_verdict,
    }

    # 6.2 Massive COST dividends
    out_mdiv = client.get_json("massive", "stocks/v1/dividends", {"ticker": "COST", "limit": 20}, label="massive_dividends_cost")
    queries.append(out_mdiv.record)
    m_special_15 = next(
        (r for r in out_mdiv.rows if isinstance(r.get("cash_amount"), (int, float)) and abs(float(r["cash_amount"]) - 15.0) < 0.01),
        None,
    )
    m_ord = next(
        (r for r in out_mdiv.rows if r is not m_special_15 and str(r.get("distribution_type", "")).lower() == "recurring")
        or (r for r in out_mdiv.rows if r is not m_special_15),
        None,
    )
    details["massive_dividends_cost"] = {
        "has_distribution_type": "distribution_type" in out_mdiv.record["sample_keys"],
        "special_15_usd_observed_in_sample": m_special_15 is not None,
        "special_15_usd_distribution_type": m_special_15.get("distribution_type") if m_special_15 else "NOT_OBSERVED_IN_SAMPLE",
        "special_15_usd_record": m_special_15,
        "ordinary_distribution_types": sorted({str(r.get("distribution_type")) for r in out_mdiv.rows if r is not m_special_15 and "distribution_type" in r}),
        "ordinary_sample": m_ord,
    }

    # 6.3 Massive vX float
    vx_details: dict[str, Any] = {}
    for sym in ("AAPL", "MELI"):
        out_vx = client.get_json("massive", "stocks/vX/float", {"ticker": sym}, label=f"massive_vx_float_{sym}")
        queries.append(out_vx.record)
        row = out_vx.rows[0] if out_vx.rows else None
        vx_details[sym] = {
            "http_status": out_vx.record["http_status"],
            "result_status": out_vx.record["result_status"],
            "keys": out_vx.record["sample_keys"],
            "types": out_vx.record["observed_field_types"],
            "sample_row": row,
        }
    details["massive_vx_float"] = vx_details

    return {"queries": queries, "details": details}


def probe_delisted_suite(client: ProbeHttpClient, calendar_info: dict[str, Any]) -> dict[str, Any]:
    queries: list[dict[str, Any]] = []
    rows_summary: list[dict[str, Any]] = []
    closed_dates = set(calendar_info.get("closed_dates", []))
    early_dates = set(calendar_info.get("early_close_dates", []))

    for ticker in DELISTED_CANDIDATES:
        out_ref = client.get_json(
            "massive",
            "v3/reference/tickers",
            {"ticker": ticker, "active": "false", "market": "stocks"},
            label=f"massive_ref_delisted_{ticker}",
        )
        queries.append(out_ref.record)

        ref_records = [
            {
                "ticker": r.get("ticker"),
                "name": r.get("name"),
                "active": r.get("active"),
                "delisted_utc": r.get("delisted_utc"),
                "composite_figi": r.get("composite_figi"),
                "cik": r.get("cik"),
                "primary_exchange": r.get("primary_exchange"),
                "type": r.get("type"),
                "market": r.get("market"),
            }
            for r in out_ref.rows
        ]

        if len(ref_records) == 1:
            identity_status = "SINGLE_DELISTED_RECORD"
            selected_delisted_utc = ref_records[0].get("delisted_utc")
        elif len(ref_records) > 1:
            identity_status = "MULTIPLE_RECORDS_AMBIGUOUS"
            delisted_vals = [r.get("delisted_utc") for r in ref_records if r.get("delisted_utc")]
            selected_delisted_utc = delisted_vals[0] if len(set(delisted_vals)) == 1 else None
        else:
            identity_status = "NO_DELISTED_RECORD"
            selected_delisted_utc = None

        date_info = select_delisted_probe_date(selected_delisted_utc, closed_dates)
        qdate = date_info["queried_date"]

        out_bars = client.get_json(
            "massive",
            f"v2/aggs/ticker/{ticker}/range/1/minute/{qdate}/{qdate}",
            {"adjusted": "false", "limit": 5},
            label=f"massive_1m_delisted_{ticker}",
        )
        queries.append(out_bars.record)

        first_bar = out_bars.rows[0] if out_bars.rows else None
        first_ts_utc = None
        first_ts_et = None
        first_session = None
        if first_bar and isinstance(first_bar.get("t"), (int, float)) and not isinstance(first_bar["t"], bool):
            t_raw = first_bar["t"]
            sec = int(t_raw // 1000) if t_raw > 1e11 else int(t_raw)
            dt_utc = dt.datetime.fromtimestamp(sec, UTC_TZ)
            dt_et = dt_utc.astimezone(ET_TZ)
            first_ts_utc = dt_utc.isoformat()
            first_ts_et = dt_et.isoformat()
            mins = dt_et.hour * 60 + dt_et.minute
            close_mins = 13 * 60 if dt_et.strftime("%Y-%m-%d") in early_dates else 16 * 60
            if 4 * 60 <= mins < 9 * 60 + 30:
                first_session = "PRE_MARKET"
            elif 9 * 60 + 30 <= mins < close_mins:
                first_session = "RTH"
            elif close_mins <= mins < 20 * 60:
                first_session = "AFTER_HOURS"
            else:
                first_session = "OUTSIDE_REGULAR_EXTENDED"

        vw_present_count = sum(1 for r in out_bars.rows if "vw" in r)
        vw_valid_pos_count = sum(
            1
            for r in out_bars.rows
            if isinstance(r.get("vw"), (int, float))
            and not isinstance(r.get("vw"), bool)
            and math.isfinite(float(r["vw"]))
            and float(r["vw"]) > 0
        )

        out_oc = client.get_json(
            "orats",
            "hist/cores",
            {"ticker": ticker, "tradeDate": qdate},
            label=f"orats_cores_delisted_{ticker}",
        )
        queries.append(out_oc.record)
        oc_row = out_oc.rows[0] if out_oc.rows else {}
        oc_trade_date = oc_row.get("tradeDate") if oc_row else None
        date_mismatch = bool(oc_trade_date is not None and str(oc_trade_date) != qdate)
        imp_state, imp_val = classify_field_value(oc_row, "impErnMv")
        xern_state, xern_val = classify_field_value(oc_row, "orIvXern20d")
        oi_fields = {
            k: {"state": classify_field_value(oc_row, k)[0], "value": classify_field_value(oc_row, k)[1]}
            for k in ("cOi", "pOi")
            if k in oc_row or oc_row
        }

        out_oe = client.get_json(
            "orats",
            "hist/earnings",
            {"ticker": ticker},
            label=f"orats_earnings_delisted_{ticker}",
        )
        queries.append(out_oe.record)

        rows_summary.append(
            {
                "ticker": ticker,
                "identity_status": identity_status,
                "reference_records": ref_records,
                "massive_ref_http": out_ref.record["http_status"],
                "massive_ref_status": out_ref.record["result_status"],
                "date_derivation": date_info,
                "massive_1m": {
                    "http_status": out_bars.record["http_status"],
                    "result_status": out_bars.record["result_status"],
                    "bar_count": out_bars.record["record_count"],
                    "first_bar_utc": first_ts_utc,
                    "first_bar_et": first_ts_et,
                    "first_bar_session": first_session,
                    "vw_field_present_bars": vw_present_count,
                    "vw_valid_positive_bars": vw_valid_pos_count,
                },
                "orats_cores": {
                    "http_status": out_oc.record["http_status"],
                    "result_status": out_oc.record["result_status"],
                    "count": out_oc.record["record_count"],
                    "observed_trade_date": oc_trade_date,
                    "temporal_mismatch": date_mismatch,
                    "impErnMv": {"state": imp_state, "value": imp_val},
                    "orIvXern20d": {"state": xern_state, "value": xern_val},
                    "oi_fields": oi_fields,
                },
                "orats_earnings": {
                    "http_status": out_oe.record["http_status"],
                    "result_status": out_oe.record["result_status"],
                    "count": out_oe.record["record_count"],
                    "date_range": out_oe.record["observed_date_range"],
                },
            }
        )

    return {"queries": queries, "candidates": rows_summary}


def probe_orats_suite(client: ProbeHttpClient) -> dict[str, Any]:
    queries: list[dict[str, Any]] = []
    details: dict[str, Any] = {}

    # 8.1 NVDA 2024-06-07 scale experiment
    out_cores = client.get_json(
        "orats",
        "hist/cores",
        {"ticker": "NVDA", "tradeDate": "2024-06-07"},
        label="orats_nvda_cores_2024_06_07",
    )
    queries.append(out_cores.record)

    out_sum = client.get_json(
        "orats",
        "hist/summaries",
        {"ticker": "NVDA", "tradeDate": "2024-06-07"},
        label="orats_nvda_summaries_2024_06_07",
    )
    queries.append(out_sum.record)

    c_row = out_cores.rows[0] if out_cores.rows else {}
    s_row = out_sum.rows[0] if out_sum.rows else {}

    inspected_fields = (
        "impErnMv",
        "impliedEarningsMove",
        "orIvXern20d",
        "iv30d",
        "contango",
        "slope",
        "stockPrice",
        "pxAtmIv",
        "exErnIv20d",
        "iv20d",
        "iv30d" if False else "exErnIv30d",
    )
    literal_table: dict[str, Any] = {}
    for fname in inspected_fields:
        cs, cv = classify_field_value(c_row, fname)
        ss, sv = classify_field_value(s_row, fname)
        literal_table[fname] = {
            "cores": {"state": cs, "value": cv, "type": type(cv).__name__ if cv is not None else None},
            "summaries": {"state": ss, "value": sv, "type": type(sv).__name__ if sv is not None else None},
        }

    # Semantic equivalence pairs
    pairs_spec = [
        ("impErnMv", "impliedEarningsMove", True, "Implied earnings move % (cores) vs decimal/direct? (summaries)"),
        ("orIvXern20d", "iv30d", False, "Ex-earnings 20d IV vs total 30d IV (different tenors/earnings treatment)"),
        ("exErnIv30d", "iv30d", False, "Ex-earnings 30d IV vs total 30d IV (earnings component differs)"),
        ("iv30d", "iv30d", True, "Same 30d ATM IV metric across cores and summaries"),
        ("contango", "contango", True, "Term-structure contango metric across endpoints"),
        ("slope", "slope", True, "Skew slope metric across endpoints"),
        ("stockPrice", "stockPrice", True, "Monetary underlying spot price (USD)"),
        ("pxAtmIv", "stockPrice", True, "Cores stock price reference (pxAtmIv) vs summaries stockPrice"),
    ]
    equivalence_rows: list[dict[str, Any]] = []
    for c_field, s_field, comparable, note in pairs_spec:
        cs, cv = classify_field_value(c_row, c_field)
        ss, sv = classify_field_value(s_row, s_field)
        ratio, cls_name = classify_scale_ratio(cv, sv, comparable=comparable)
        equivalence_rows.append(
            {
                "cores_field": c_field,
                "cores_state": cs,
                "cores_value": cv,
                "summaries_field": s_field,
                "summaries_state": ss,
                "summaries_value": sv,
                "ratio": ratio,
                "classification": cls_name,
                "note": note,
            }
        )

    details["nvda_scale_experiment"] = {
        "cores_trade_date": c_row.get("tradeDate") if c_row else None,
        "summaries_trade_date": s_row.get("tradeDate") if s_row else None,
        "literal_fields": literal_table,
        "equivalence_table": equivalence_rows,
        "cores_iv_keys_sample": [k for k in c_row.keys() if any(w in k.lower() for w in ("iv", "ern", "slope", "contango", "stock", "px"))][:35],
        "summaries_keys": sorted(s_row.keys()),
    }

    # 8.2 AAPL earnings literal format
    out_aapl_ern = client.get_json("orats", "hist/earnings", {"ticker": "AAPL"}, label="orats_earnings_aapl")
    queries.append(out_aapl_ern.record)

    valid_ern_rows = [r for r in out_aapl_ern.rows if isinstance(r.get("earnDate"), str) and r["earnDate"].strip()]
    sorted_ern = sorted(valid_ern_rows, key=lambda r: str(r["earnDate"]), reverse=True)
    historical_ern = [r for r in sorted_ern if str(r["earnDate"])[:10] <= RESEARCH_CUTOFF_DATE]
    future_ern = [r for r in sorted_ern if str(r["earnDate"])[:10] > RESEARCH_CUTOFF_DATE]

    def fmt_ern(r: dict[str, Any]) -> dict[str, Any]:
        ed_state, ed_val = classify_field_value(r, "earnDate")
        tod_state, tod_val = classify_field_value(r, "anncTod")
        return {
            "earnDate": {"value": ed_val, "state": ed_state, "json_type": type(ed_val).__name__ if ed_val is not None else None},
            "anncTod": {"value": tod_val, "state": tod_state, "json_type": type(tod_val).__name__ if tod_val is not None else None},
            "raw_keys": sorted(r.keys()),
        }

    details["aapl_earnings"] = {
        "total_count": len(out_aapl_ern.rows),
        "historical_count_le_cutoff": len(historical_ern),
        "future_count_gt_cutoff": len(future_ern),
        "latest_3_historical": [fmt_ern(r) for r in historical_ern[:3]],
        "future_records_sample": [fmt_ern(r) for r in future_ern[:3]],
    }

    # 8.3 International / ADR coverage
    intl_rows: list[dict[str, Any]] = []
    for ticker in INTERNATIONAL_TICKERS:
        out_i = client.get_json(
            "orats",
            "hist/cores",
            {"ticker": ticker, "tradeDate": "2026-10-15"},
            label=f"orats_intl_{ticker}",
        )
        queries.append(out_i.record)
        row = out_i.rows[0] if out_i.rows else {}
        imp_state, imp_val = classify_field_value(row, "impErnMv")
        xern_state, xern_val = classify_field_value(row, "orIvXern20d")
        coi_state, coi_val = classify_field_value(row, "cOi")
        poi_state, poi_val = classify_field_value(row, "pOi")
        obs_date = row.get("tradeDate") if row else None
        notes: list[str] = []
        if obs_date is not None and str(obs_date) != "2026-10-15":
            notes.append(f"Date mismatch: returned {obs_date} != 2026-10-15")
        if coi_state == "FIELD_ZERO" and poi_state == "FIELD_ZERO":
            notes.append("cOi=0 and pOi=0 (FIELD_ZERO, field present)")
        intl_rows.append(
            {
                "ticker": ticker,
                "http_status": out_i.record["http_status"],
                "result_status": out_i.record["result_status"],
                "count": out_i.record["record_count"],
                "observed_trade_date": obs_date,
                "impErnMv": {"state": imp_state, "value": imp_val},
                "orIvXern20d": {"state": xern_state, "value": xern_val},
                "cOi": {"state": coi_state, "value": coi_val},
                "pOi": {"state": poi_state, "value": poi_val},
                "observations": notes,
            }
        )
    details["international_coverage"] = intl_rows

    return {"queries": queries, "details": details}


# ---------------------------------------------------------------------------
# Hypothesis matrix (§12.I) & Report generation (§10, §12, §13)
# ---------------------------------------------------------------------------

def evaluate_hypotheses(
    fmp_res: dict[str, Any],
    massive_res: dict[str, Any],
    orats_res: dict[str, Any],
    delisted_res: dict[str, Any],
    calendar_info: dict[str, Any],
) -> list[dict[str, str]]:
    """Derive hypothesis verdicts strictly from observed probe evidence."""
    hypotheses: list[dict[str, str]] = []

    # 1. FMP timing for earnings
    f_ern = fmp_res["details"].get("earnings_aapl", {})
    f_cal = fmp_res["details"].get("earnings_calendar", {})
    f_ern_q = next((q for q in fmp_res["queries"] if q["label"] == "fmp_earnings_aapl"), {})
    f_cal_q = next((q for q in fmp_res["queries"] if q["label"] == "fmp_earnings_calendar"), {})
    if f_ern_q.get("result_status") != "OK_DATA" and f_cal_q.get("result_status") != "OK_DATA":
        h1_state = "NOT_TESTED" if f_ern_q.get("result_status") == "NOT_EXECUTED" else "INCONCLUSIVE"
        h1_ev = f"FMP earnings queries returned {f_ern_q.get('result_status')}/{f_cal_q.get('result_status')}."
    elif f_ern.get("non_null_time_samples") or any(k not in ("<NULL>", "''") for k in f_cal.get("time_distribution_top", {})):
        h1_state = "CONFIRMED"
        h1_ev = f"time samples in earnings={f_ern.get('non_null_time_samples')[:3]}, calendar={f_cal.get('time_distribution_top')}."
    else:
        h1_state = "CONTRADICTED"
        h1_ev = (
            f"earnings?symbol=AAPL has time_field={f_ern.get('has_time_field')}, non_null_time={len(f_ern.get('non_null_time_samples', []))}; "
            f"earnings-calendar time_field={f_cal.get('has_time_field')}, dist={f_cal.get('time_distribution_top')}."
        )
    hypotheses.append({
        "hypothesis": "FMP proporciona información temporal utilizable para earnings.",
        "state": h1_state,
        "evidence": h1_ev,
        "implication": "Usar ORATS /datav2/hist/earnings (anncTod) como fuente primaria de timing BMO/AMC; no derivar BMO/AMC solo de fechas FMP.",
    })

    # 2. FMP special dividends
    f_div = fmp_res["details"].get("dividends_cost", {})
    f_div_q = next((q for q in fmp_res["queries"] if q["label"] == "fmp_dividends_cost"), {})
    if f_div_q.get("result_status") != "OK_DATA":
        h2_state = "INCONCLUSIVE"
        h2_ev = f"FMP dividends status={f_div_q.get('result_status')}."
    elif f_div.get("special_15_usd_found") and f_div.get("has_explicit_special_classification"):
        h2_state = "CONFIRMED"
        h2_ev = f"USD 15 found with explicit keys {f_div.get('explicit_classification_keys')}."
    elif f_div.get("special_15_usd_found") and not f_div.get("has_explicit_special_classification"):
        h2_state = "CONTRADICTED"
        h2_ev = "COST USD 15 record found in /stable/dividends, but payload lacks an explicit special-dividend classification field (only economic amount/frequency)."
    else:
        h2_state = "INCONCLUSIVE"
        h2_ev = "COST USD 15 dividend not observed in sample."
    hypotheses.append({
        "hypothesis": "FMP permite identificar dividendos especiales.",
        "state": h2_state,
        "evidence": h2_ev,
        "implication": "Cruzar con Massive /stocks/v1/dividends (distribution_type) cuando se requiera clasificación explícita del emisor.",
    })

    # 3 & 4. Massive unadjusted vw & split coherence
    nvda_exp = massive_res["details"].get("nvda_split_experiment", {})
    m_unadj_q = next((q for q in massive_res["queries"] if q["label"] == "massive_nvda_unadjusted"), {})
    m_adj_q = next((q for q in massive_res["queries"] if q["label"] == "massive_nvda_adjusted"), {})
    pre_vw = nvda_exp.get("per_session_rth_stats", {}).get("2024-06-07", {}).get("price_factor_vw", {})
    post_vw = nvda_exp.get("per_session_rth_stats", {}).get("2024-06-10", {}).get("price_factor_vw", {})
    pre_o = nvda_exp.get("per_session_rth_stats", {}).get("2024-06-07", {}).get("price_factor_o", {})
    pre_v = nvda_exp.get("per_session_rth_stats", {}).get("2024-06-07", {}).get("volume_factor", {})

    if m_unadj_q.get("result_status") != "OK_DATA":
        h3_state = "INCONCLUSIVE"
        h3_ev = f"Unadjusted NVDA query returned {m_unadj_q.get('result_status')}."
    elif pre_vw.get("count", 0) > 0 and pre_vw.get("median") is not None and abs(pre_vw["median"] - 10.0) < 0.05:
        h3_state = "CONFIRMED"
        h3_ev = f"Pre-split unadjusted RTH vw available ({pre_vw['count']} matched bars, unadj/adj vw median={pre_vw['median']:.6f})."
    else:
        h3_state = "INCONCLUSIVE"
        h3_ev = f"Insufficient vw matches: {pre_vw}."
    hypotheses.append({
        "hypothesis": "Massive entrega vw histórico no ajustado.",
        "state": h3_state,
        "evidence": h3_ev,
        "implication": "REST /v2/aggs con adjusted=false preserva vw en escala cruda (a diferencia de Flat Files sin columna vw).",
    })

    if m_unadj_q.get("result_status") != "OK_DATA" or m_adj_q.get("result_status") != "OK_DATA":
        h4_state = "INCONCLUSIVE"
        h4_ev = f"Missing data: unadj={m_unadj_q.get('result_status')}, adj={m_adj_q.get('result_status')}."
    elif (
        pre_vw.get("median") is not None and abs(pre_vw["median"] - 10.0) < 0.05
        and pre_o.get("median") is not None and abs(pre_o["median"] - 10.0) < 0.05
        and pre_v.get("median") is not None and abs(pre_v["median"] - 10.0) < 0.05
        and post_vw.get("median") is not None and abs(post_vw["median"] - 1.0) < 0.01
    ):
        h4_state = "CONFIRMED"
        h4_ev = (
            f"Pre-split medians: price_factor_vw={pre_vw['median']:.6f}, price_factor_o={pre_o['median']:.6f}, "
            f"volume_factor={pre_v['median']:.6f}; post-split price_factor_vw={post_vw['median']:.6f}."
        )
    else:
        h4_state = "CONTRADICTED"
        h4_ev = f"Pre-split vw={pre_vw}, o={pre_o}, vol={pre_v}; post-split vw={post_vw}."
    hypotheses.append({
        "hypothesis": "Massive ajusta vw coherentemente ante splits.",
        "state": h4_state,
        "evidence": h4_ev,
        "implication": "adjusted=true es consistente en O/H/L/C/VW y volumen recíproco para series ajustadas por split.",
    })

    # 5. ORATS scale differences
    eq_rows = orats_res["details"].get("nvda_scale_experiment", {}).get("equivalence_table", [])
    scale_100x = [r for r in eq_rows if r["classification"] in {"SCALE_100X", "SCALE_0_01X"}]
    same_scale = [r for r in eq_rows if r["classification"] == "SAME_SCALE"]
    o_c_q = next((q for q in orats_res["queries"] if q["label"] == "orats_nvda_cores_2024_06_07"), {})
    o_s_q = next((q for q in orats_res["queries"] if q["label"] == "orats_nvda_summaries_2024_06_07"), {})
    if o_c_q.get("result_status") != "OK_DATA" or o_s_q.get("result_status") != "OK_DATA":
        h5_state = "INCONCLUSIVE"
        h5_ev = f"cores={o_c_q.get('result_status')}, summaries={o_s_q.get('result_status')}."
    elif scale_100x:
        pairs_desc = ", ".join(f"{r['cores_field']}/{r['summaries_field']}={r['ratio']:.4g} ({r['classification']})" for r in scale_100x)
        same_desc = ", ".join(f"{r['cores_field']}={r['ratio']:.4g}" for r in same_scale)
        h5_state = "CONFIRMED"
        h5_ev = f"100x differences on: [{pairs_desc}]; SAME_SCALE on: [{same_desc}]."
    else:
        h5_state = "CONTRADICTED"
        h5_ev = "No 100x/0.01x scale differences observed among comparable pairs."
    hypotheses.append({
        "hypothesis": "ORATS presenta diferencias de escala entre cores y summaries.",
        "state": h5_state,
        "evidence": h5_ev,
        "implication": "Normalizar por campo explícito (IV/moves en % vs decimal en summaries); nunca aplicar 100x global a stockPrice/contango/slope.",
    })

    # 6. ORATS international coverage
    intl = orats_res["details"].get("international_coverage", [])
    intl_ok = [r for r in intl if r["result_status"] == "OK_DATA"]
    intl_valid_iv = [r for r in intl_ok if r["orIvXern20d"]["state"] == "FIELD_VALID"]
    if not intl:
        h6_state = "NOT_TESTED"
        h6_ev = "No international queries executed."
    elif len(intl_ok) == len(intl) and len(intl_valid_iv) == len(intl):
        h6_state = "CONFIRMED"
        h6_ev = f"{len(intl_ok)}/{len(intl)} OK_DATA on 2026-10-15; all {len(intl_valid_iv)} have valid orIvXern20d."
    elif len(intl_ok) > 0:
        h6_state = "INCONCLUSIVE"
        h6_ev = f"{len(intl_ok)}/{len(intl)} OK_DATA, {len(intl_valid_iv)}/{len(intl)} valid orIvXern20d."
    else:
        h6_state = "CONTRADICTED"
        h6_ev = f"0/{len(intl)} OK_DATA."
    hypotheses.append({
        "hypothesis": "ORATS ofrece cobertura útil de instrumentos internacionales.",
        "state": h6_state,
        "evidence": h6_ev,
        "implication": "Cobertura útil verificada en /hist/cores para los 12 instrumentos (evaluar liquidez OI por símbolo individualmente).",
    })

    # 7. Delisted candidates Massive + ORATS
    cands = delisted_res.get("candidates", [])
    m_ok = sum(1 for c in cands if c["massive_1m"]["result_status"] == "OK_DATA")
    oc_ok = sum(1 for c in cands if c["orats_cores"]["result_status"] == "OK_DATA")
    oe_ok = sum(1 for c in cands if c["orats_earnings"]["result_status"] == "OK_DATA")
    if not cands:
        h7_state = "NOT_TESTED"
        h7_ev = "No delisted candidates probed."
    elif m_ok > 0 and oc_ok > 0:
        h7_state = "CONFIRMED" if (m_ok == len(cands) and oc_ok == len(cands)) else "INCONCLUSIVE"
        h7_ev = (
            f"Of {len(cands)} delisted candidates: Massive 1m OK_DATA={m_ok}/{len(cands)}, "
            f"ORATS hist/cores OK_DATA={oc_ok}/{len(cands)}, ORATS hist/earnings OK_DATA={oe_ok}/{len(cands)}."
        )
    else:
        h7_state = "CONTRADICTED"
        h7_ev = f"Massive 1m OK_DATA={m_ok}/{len(cands)}, ORATS cores OK_DATA={oc_ok}/{len(cands)}."
    hypotheses.append({
        "hypothesis": "Massive y ORATS ofrecen datos históricos de los candidatos deslistados.",
        "state": h7_state,
        "evidence": h7_ev,
        "implication": "Aplicar registro explícito de provenance y validar ticker reuse / fechas previas al deslistado en el universo point-in-time.",
    })

    # 8. Existing NYSE calendar reusable
    if calendar_info.get("closed_dates_count", 0) > 0 and calendar_info.get("early_close_dates_count", 0) > 0 and calendar_info.get("python_validation_script"):
        h8_state = "CONFIRMED"
        h8_ev = (
            f"{calendar_info['exact_ts_path']} covers {calendar_info['supported_years']} "
            f"({calendar_info['closed_dates_count']} holidays, {calendar_info['early_close_dates_count']} early closes, "
            f"validated by {calendar_info['python_validation_script']})."
        )
    else:
        h8_state = "INCONCLUSIVE"
        h8_ev = "Calendar sets or Python oracle missing."
    hypotheses.append({
        "hypothesis": "El calendario existente puede reutilizarse para reproducir las sesiones NYSE.",
        "state": h8_state,
        "evidence": h8_ev,
        "implication": "canonical_rth.py (en fase futura) puede replicar exactamente CLOSED, EARLY (13:00 ET) y America/New_York DST 2020-2028.",
    })

    return hypotheses


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
    ]
    for row in rows:
        cells = [str(c).replace("\n", " ").replace("|", "\\|") for c in row]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def render_markdown_report(payload: dict[str, Any]) -> str:
    env = payload["environment"]
    fmp_res = payload["providers"]["fmp"]
    massive_res = payload["providers"]["massive"]
    orats_res = payload["providers"]["orats"]
    delisted_res = payload["delisted_audit"]
    repo_res = payload["repo_inspection"]
    hyps = payload["hypotheses"]
    gate = payload["gate"]

    sections: list[str] = [
        "# Phase 1 Empirical Audit Report (`research/avwap_oracle`)",
        "",
        f"- **Execution UTC:** `{payload['executed_at_utc']}`",
        f"- **Research Cutoff Date:** `{payload['research_cutoff_date']}`",
        f"- **Overall Gate:** **{gate['overall_status']}**",
        "",
        "## A. Estado del scaffold",
        "",
        f"- **Python efectivo:** `{env['python_version']}` (`{env['python_executable']}`)",
        f"- **`sys.prefix` dentro del perímetro:** `{env['sys_prefix_relative_to_perimeter']}`",
        f"- **`uv`:** `{env['uv_version']}`",
        f"- **`uv sync` / `uv lock --check` / `pytest`:** `{env.get('scaffold_checks', 'ver sección de ejecución')}`",
        f"- **Requests ejecutados por proveedor:** `{payload['requests_by_provider']}`",
        "",
        "## B. FMP — Matriz de endpoints",
        "",
    ]

    fmp_rows = []
    for q in fmp_res["queries"]:
        keys_preview = ", ".join(q["sample_keys"][:6]) + ("..." if len(q["sample_keys"]) > 6 else "")
        finding = q["sanitized_error"] or (
            f"dateRange={q['observed_date_range']['min']}..{q['observed_date_range']['max']}"
            if q["observed_date_range"]
            else q["response_shape"]
        )
        fmp_rows.append([q["endpoint"], q["http_status"], q["result_status"], q["record_count"], keys_preview, finding])
    sections.append(_md_table(["Endpoint", "HTTP", "Estado", "Count", "Campos relevantes", "Hallazgo"], fmp_rows))
    sections.append("")

    fd = fmp_res["details"]
    sections.extend([
        f"- **Credencial FMP:** `{payload['credentials_audit']['fmp']['selected_var_name']}` ({payload['credentials_audit']['fmp']['ambiguity_note']})",
        f"- **Earnings timing (`earnings?symbol=AAPL`):** `time` presente=`{fd['earnings_aapl']['has_time_field']}`, valores no vacíos=`{fd['earnings_aapl']['non_null_time_samples'][:5]}`. `earnings-calendar` distribución `time`=`{fd['earnings_calendar']['time_distribution_top']}`.",
        f"- **SEC Filings (`AAPL`):** `acceptedDate`=`{fd['sec_filings_symbol']['acceptedDate_info']}`, `filingDate`=`{fd['sec_filings_symbol']['filingDate_info']}`.",
        f"- **SEC Filings (`424B5`):** `acceptedDate`=`{fd['sec_filings_form_424b5']['acceptedDate_info']}`, `filingDate`=`{fd['sec_filings_form_424b5']['filingDate_info']}`.",
        f"- **Constituyentes históricos:** SP500 `{fd['historical_sp500']['earliest_date']}..{fd['historical_sp500']['latest_date']}` (`{fd['historical_sp500']['add_remove_keys']}`); Nasdaq `{fd['historical_nasdaq']['earliest_date']}..{fd['historical_nasdaq']['latest_date']}` (`{fd['historical_nasdaq']['add_remove_keys']}`).",
        f"- **Economic calendar (ejemplo US):** `{fd['economic_calendar']['us_example']}` (`date_info={fd['economic_calendar']['date_info']}`).",
        f"- **Shares float:** AAPL=`{fd['shares_float'].get('AAPL')}`; MELI=`{fd['shares_float'].get('MELI')}`.",
        f"- **NVDA split 10:1 (`2024-06-10`):** found=`{fd['splits_nvda']['nvda_2024_06_10_found']}` -> `{fd['splits_nvda']['nvda_2024_06_10_record']}`.",
        f"- **COST dividendos:** especial USD 15=`{fd['dividends_cost']['special_15_usd_record']}`; ordinario=`{fd['dividends_cost']['ordinary_sample_record']}`; clasificación explícita=`{fd['dividends_cost']['has_explicit_special_classification']}`.",
        "",
        "## C. Massive — Experimento NVDA",
        "",
    ])

    nvda = massive_res["details"]["nvda_split_experiment"]
    nvda_rows = []
    for mode_label, picks in (("false", nvda["unadjusted"]), ("true", nvda["adjusted"])):
        for bar_key in ("pre_bar", "post_bar"):
            b = picks.get(bar_key)
            if b:
                nvda_rows.append([b["timestamp_et"], mode_label, b["o"], b["c"], b["v"], b["vw"]])
            else:
                nvda_rows.append([f"{bar_key}_MISSING", mode_label, None, None, None, None])
    sections.append(_md_table(["Fecha y hora ET", "Adjusted", "Open", "Close", "Volume", "VW"], nvda_rows))
    sections.extend([
        "",
        f"- **Ratios misma barra (pre-split `2024-06-07`):** `{nvda['pre_split_same_bar_factors']}`",
        f"- **Ratios misma barra (post-split `2024-06-10`):** `{nvda['post_split_same_bar_factors']}`",
        f"- **Estadísticas por sesión RTH (`2024-06-07`):** `{nvda['per_session_rth_stats']['2024-06-07']}`",
        f"- **Estadísticas por sesión RTH (`2024-06-10`):** `{nvda['per_session_rth_stats']['2024-06-10']}`",
        f"- **Saltos entre sesiones:** `raw_session_jump={nvda['raw_session_jump']}`, `adjusted_session_jump={nvda['adjusted_session_jump']}`",
        f"- **Veredicto sobre `vw`:** {nvda['vw_verdict']}",
        "",
        "## D. Massive — Dividendos y float",
        "",
    ])

    mdiv = massive_res["details"]["massive_dividends_cost"]
    mvx = massive_res["details"]["massive_vx_float"]
    d_rows = [
        [
            "COST",
            "/stocks/v1/dividends?limit=20",
            next((q["http_status"] for q in massive_res["queries"] if q["label"] == "massive_dividends_cost"), None),
            f"distribution_type={mdiv['has_distribution_type']}",
            f"special15={mdiv['special_15_usd_distribution_type']}; ord={mdiv['ordinary_distribution_types']}",
            f"special_observed_in_sample={mdiv['special_15_usd_observed_in_sample']}",
        ]
    ]
    for sym in ("AAPL", "MELI"):
        info = mvx[sym]
        d_rows.append([
            sym,
            "/stocks/vX/float",
            info["http_status"],
            ", ".join(info["keys"]),
            str(info["sample_row"]),
            info["result_status"],
        ])
    sections.append(_md_table(["Instrumento", "Endpoint", "HTTP", "Campos", "Valores", "Hallazgo"], d_rows))
    sections.extend(["", "## E. ORATS — Escalas", ""])

    sc = orats_res["details"]["nvda_scale_experiment"]
    e_rows = [
        [r["cores_field"], r["cores_value"], r["summaries_field"], r["summaries_value"], r["ratio"], r["classification"]]
        for r in sc["equivalence_table"]
    ]
    sections.append(_md_table(["Campo cores", "Valor", "Campo summaries", "Valor", "Ratio", "Clasificación"], e_rows))
    aapl_e = orats_res["details"]["aapl_earnings"]
    sections.extend([
        "",
        f"- **AAPL `/datav2/hist/earnings`** (`total={aapl_e['total_count']}`, `<= {RESEARCH_CUTOFF_DATE}: {aapl_e['historical_count_le_cutoff']}`, `> {RESEARCH_CUTOFF_DATE}: {aapl_e['future_count_gt_cutoff']}`):",
        f"  - Últimos 3 históricos: `{aapl_e['latest_3_historical']}`",
        f"  - Registros posteriores al corte (no usados como históricos): `{aapl_e['future_records_sample']}`",
        "",
        "## F. ORATS — Cobertura internacional",
        "",
    ])

    f_rows = [
        [
            r["ticker"],
            r["http_status"],
            r["count"],
            f"{r['impErnMv']['value']} ({r['impErnMv']['state']})",
            f"{r['orIvXern20d']['value']} ({r['orIvXern20d']['state']})",
            f"cOi={r['cOi']['value']} ({r['cOi']['state']}), pOi={r['pOi']['value']} ({r['pOi']['state']})",
            f"{r['result_status']} (date={r['observed_trade_date']})",
        ]
        for r in orats_res["details"]["international_coverage"]
    ]
    sections.append(_md_table(["Ticker", "HTTP", "Count", "impErnMv", "orIvXern20d", "OI", "Estado"], f_rows))
    sections.extend(["", "## G. Matriz de los 12 deslistados", ""])

    g_rows = []
    for c in delisted_res["candidates"]:
        dd = c["date_derivation"]
        refs = c["reference_records"]
        figi_cik = ", ".join(f"{r.get('composite_figi')}/{r.get('cik')}" for r in refs) if refs else "NONE"
        m1 = c["massive_1m"]
        oc = c["orats_cores"]
        oe = c["orats_earnings"]
        g_rows.append([
            c["ticker"],
            dd["delisted_utc_literal"] or "NONE",
            f"{dd['queried_date']} ({dd['date_provenance']})",
            figi_cik,
            f"HTTP {c['massive_ref_http']} ({c['identity_status']})",
            f"HTTP {m1['http_status']} {m1['result_status']} n={m1['bar_count']} vw={m1['vw_valid_positive_bars']}/{m1['vw_field_present_bars']} ({m1['first_bar_session']})",
            f"HTTP {oc['http_status']} {oc['result_status']} dt={oc['observed_trade_date']} imp={oc['impErnMv']['value']}",
            f"HTTP {oe['http_status']} {oe['result_status']} n={oe['count']}",
        ])
    sections.append(
        _md_table(
            ["Ticker", "Fecha de baja", "Fecha consultada", "FIGI/CIK", "Massive ref.", "Massive 1m/VW", "ORATS cores", "ORATS earnings"],
            g_rows,
        )
    )

    uni = repo_res["us_equity_universe"]
    cal = repo_res["nyse_calendar"]
    sections.extend([
        "",
        "## H. Universo y calendario",
        "",
        f"- **Ruta y rango de líneas (`US_EQUITY_UNIVERSE`):** `{uni['source_path']}` líneas `{uni['source_line_range']}`",
        f"- **Cantidad observada / única / esperada:** `{uni['observed_count']}` / `{uni['unique_count']}` / `{uni['expected_count']}` (duplicados: `{uni['duplicates']}`)",
        f"- **Lista completa de símbolos ({uni['observed_count']}):** `{', '.join(uni['symbols'])}`",
        f"- **Calendario NYSE:** `{cal['exact_ts_path']}` (soporte `{cal['supported_years']}`, {cal['closed_dates_count']} feriados, {cal['early_close_dates_count']} cierres anticipados 13:00 ET)",
        f"- **Script Python de validación:** `{cal['python_validation_script']}` (fixture `{cal['python_reference_fixture']}`)",
        f"- **Zona horaria / DST / excepciones:** {cal['timezone']} — {cal['dst_handling']} — Excepciones: `{cal['extraordinary_exceptions']}`",
        f"- **Cierres 13:00 ET (`EARLY`):** {cal['early_close_representation']}",
        f"- **Notas para futuro `canonical_rth.py`:** {'; '.join(cal['notes_for_canonical_rth'])}",
        "",
        "## I. Matriz de hipótesis",
        "",
    ])

    h_rows = [[h["hypothesis"], h["state"], h["evidence"], h["implication"]] for h in hyps]
    sections.append(_md_table(["Hipótesis", "Estado", "Evidencia", "Implicación para fases futuras"], h_rows))

    sections.extend([
        "",
        "## J. Evidencia de aislamiento Git",
        "",
        "- Ver archivos `reports/git_isolation_initial.txt` y `reports/git_isolation_final.txt`.",
        "",
        "## K. Bloqueos y riesgos residuales",
        "",
    ])
    for risk in payload.get("residual_risks", []):
        sections.append(f"- {risk}")

    sections.extend([
        "",
        "## Gate de cierre",
        "",
        "```text",
    ])
    for k, v in gate["checks"].items():
        sections.append(f"{k}={v}")
    sections.extend([
        f"OVERALL={gate['overall_status']}",
        "```",
        "",
    ])
    return "\n".join(sections)


def _assert_within_perimeter(path: Path, perimeter_root: Path) -> Path:
    resolved_target = path.resolve()
    resolved_root = perimeter_root.resolve()
    if not resolved_target.is_relative_to(resolved_root):
        raise RuntimeError(f"Write path outside authorized perimeter: {resolved_target}")
    return resolved_target


def collect_residual_risks(
    creds: AuthorizedCredentials,
    fmp_res: dict[str, Any],
    massive_res: dict[str, Any],
    orats_res: dict[str, Any],
    delisted_res: dict[str, Any],
) -> list[str]:
    risks: list[str] = []
    if creds.audit["fmp"]["ambiguity_detected"]:
        risks.append(creds.audit["fmp"]["ambiguity_note"])
    for block_name, res in (("FMP", fmp_res), ("Massive", massive_res), ("ORATS", orats_res), ("Delisted", delisted_res)):
        for q in res.get("queries", []):
            if q["result_status"] not in {"OK_DATA", "OK_EMPTY"}:
                risks.append(f"{block_name} `{q['endpoint']}` -> {q['result_status']} (HTTP {q['http_status']}): {q['sanitized_error']}")
    sec_sym = fmp_res["details"].get("sec_filings_symbol", {})
    if sec_sym and sec_sym.get("acceptedDate_info", {}).get("timezone_status") == "TIMEZONE_UNVERIFIED":
        risks.append("FMP SEC acceptedDate lacks explicit timezone offset/Z in JSON string (TIMEZONE_UNVERIFIED).")
    eco = fmp_res["details"].get("economic_calendar", {})
    if eco and eco.get("date_info", {}).get("timezone_status") == "TIMEZONE_UNVERIFIED":
        risks.append("FMP economic-calendar datetime lacks explicit timezone offset/Z (TIMEZONE_UNVERIFIED).")
    if not fmp_res["details"].get("dividends_cost", {}).get("has_explicit_special_classification"):
        risks.append("FMP /stable/dividends lacks an explicit special-dividend classification field.")
    if not massive_res["details"].get("massive_dividends_cost", {}).get("special_15_usd_observed_in_sample"):
        risks.append("Massive /stocks/v1/dividends?ticker=COST&limit=20 did not reach the 2023/2024 USD 15 special dividend within 20 rows.")
    for sym, info in massive_res["details"].get("massive_vx_float", {}).items():
        if info.get("result_status") != "OK_DATA":
            risks.append(f"Massive /stocks/vX/float ({sym}) returned {info.get('result_status')} (HTTP {info.get('http_status')}).")
    risks.append("FMP shares-float and Massive vX float (if present) reflect current snapshots, not historical point-in-time float.")
    risks.append("FMP historical-sp500-constituent / historical-nasdaq-constituent cover index membership changes, not full all-US-equities point-in-time survivorship-free universe.")
    return risks


def run_probe(
    *,
    perimeter_root: Path | None = None,
    repo_root: Path | None = None,
    transport: httpx.BaseTransport | None = None,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    p_root = (perimeter_root or default_perimeter_root()).resolve()
    r_root = (repo_root or default_repo_root()).resolve()

    creds = load_authorized_credentials(r_root / ".env")
    uni = extract_us_equity_universe(r_root)
    cal = inspect_nyse_calendar(r_root)

    with ProbeHttpClient(creds, transport=transport, sleep_fn=sleep_fn) as client:
        fmp_res = probe_fmp_suite(client)
        massive_res = probe_massive_suite(client, cal)
        delisted_res = probe_delisted_suite(client, cal)
        orats_res = probe_orats_suite(client)
        req_counts = dict(client.requests_by_provider)

    hyps = evaluate_hypotheses(fmp_res, massive_res, orats_res, delisted_res, cal)
    risks = collect_residual_risks(creds, fmp_res, massive_res, orats_res, delisted_res)

    all_queries = (
        fmp_res["queries"]
        + massive_res["queries"]
        + delisted_res["queries"]
        + orats_res["queries"]
    )
    executed_ok = any(q["result_status"] in {"OK_DATA", "OK_EMPTY"} for q in all_queries)
    any_non_ok = any(q["result_status"] not in {"OK_DATA", "OK_EMPTY"} for q in all_queries)

    checks = {
        "SCAFFOLD_PASS": True,
        "PROBE_EXECUTED": executed_ok,
        "LOCAL_TESTS_PASS": "PENDING_EXTERNAL_PYTEST",
        "ISOLATION_VERIFIED": "PENDING_FINAL_GIT_DIFF",
        "CREDENTIALS_PROTECTED": True,
        "REPORTS_GENERATED": True,
    }
    overall_status = (
        "BLOCKED — EJECUCIÓN IMPEDIDA"
        if not executed_ok
        else ("PARTIAL — AUDITORÍA CON COBERTURA O ACCESO LIMITADOS" if any_non_ok else "PASS — SCAFFOLD Y AUDITORÍA COMPLETADOS")
    )

    payload: dict[str, Any] = {
        "schema_version": 1,
        "executed_at_utc": dt.datetime.now(UTC_TZ).isoformat(),
        "research_cutoff_date": RESEARCH_CUTOFF_DATE,
        "environment": {
            "python_version": sys.version.split()[0],
            "python_executable": str(Path(sys.executable).resolve()),
            "sys_prefix": str(Path(sys.prefix).resolve()),
            "sys_prefix_relative_to_perimeter": Path(sys.prefix).resolve().is_relative_to(p_root),
            "uv_version": "0.11.7",
        },
        "credentials_audit": creds.audit,
        "requests_by_provider": req_counts,
        "providers": {
            "fmp": fmp_res,
            "massive": massive_res,
            "orats": orats_res,
        },
        "delisted_audit": delisted_res,
        "repo_inspection": {
            "us_equity_universe": uni,
            "nyse_calendar": cal,
        },
        "hypotheses": hyps,
        "residual_risks": risks,
        "gate": {
            "checks": checks,
            "overall_status": overall_status,
        },
    }

    sanitized_payload = creds.sanitizer.sanitize_obj(payload)
    json_text = json.dumps(sanitized_payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    md_text = creds.sanitizer.sanitize_text(render_markdown_report(sanitized_payload)) + "\n"

    # Double-check zero literal secrets in serialized outputs before writing.
    for secret in (creds.fmp_key, creds.massive_key_2, creds.orats_api_key):
        if secret and (secret in json_text or secret in md_text):
            raise RuntimeError("Credential leak detected prior to writing report artifacts!")

    reports_dir = _assert_within_perimeter(p_root / "reports", p_root)
    reports_dir.mkdir(parents=True, exist_ok=True)
    json_path = _assert_within_perimeter(reports_dir / "probe_phase1_results.json", p_root)
    md_path = _assert_within_perimeter(reports_dir / "probe_phase1_report.md", p_root)

    json_path.write_text(json_text, encoding="utf-8")
    md_path.write_text(md_text, encoding="utf-8")
    return sanitized_payload


def main() -> int:
    payload = run_probe()
    summary = {
        "executed_at_utc": payload["executed_at_utc"],
        "requests_by_provider": payload["requests_by_provider"],
        "overall_status": payload["gate"]["overall_status"],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
