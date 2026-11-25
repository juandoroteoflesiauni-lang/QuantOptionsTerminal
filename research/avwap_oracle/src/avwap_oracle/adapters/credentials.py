"""Domain-segregated credentials, secret redaction, and shared async HTTP transport.

Non-negotiable segregation enforced by this module:
- Massive ``STOCKS_REST``: ordered ``MASSIVE_KEY_2 -> MASSIVE_KEY_3 -> MASSIVE_KEY_1``
  (NO fallback to ``MASSIVE_API_KEY``, ``MASSIVE_KEY``, ``MASSIVE_KEY_OPTIONS``,
  or ``MASSIVE_KEY_FUTURES``).
- Massive ``OPTIONS_REST``: exclusively ``MASSIVE_API_KEY``.
- ORATS historical/EOD: exclusively verified Slot #1 (``ORATS_API_KEY``) and
  Slot #2 (positional slot #2 from ``ORATS_API_KEYS`` identified BEFORE
  deduplication). Slot #3+ are excluded explicitly and NEVER promoted.
- FMP Enterprise: exclusively ``FMP_API_KEY``.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import email.utils
import math
import random
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Literal, Mapping
from zoneinfo import ZoneInfo

import httpx
from dotenv import dotenv_values

DomainName = Literal[
    "MASSIVE_STOCKS_REST",
    "MASSIVE_OPTIONS_REST",
    "ORATS_HISTORICAL",
    "FMP_ENTERPRISE",
]
ProviderName = Literal["massive", "orats", "fmp"]

UTC_TZ = ZoneInfo("UTC")

MASSIVE_BASE_URL = "https://api.massive.com"
ORATS_BASE_URL = "https://api.orats.io/datav2"
FMP_BASE_URL = "https://financialmodelingprep.com/stable"

MASSIVE_ALLOWED_HOSTS: frozenset[str] = frozenset({"api.massive.com", "api.polygon.io"})
ORATS_ALLOWED_HOSTS: frozenset[str] = frozenset({"api.orats.io"})
FMP_ALLOWED_HOSTS: frozenset[str] = frozenset({"financialmodelingprep.com"})

MASSIVE_STOCKS_ENV_CHAIN: tuple[str, ...] = ("MASSIVE_KEY_2", "MASSIVE_KEY_3", "MASSIVE_KEY_1")
MASSIVE_OPTIONS_ENV_CHAIN: tuple[str, ...] = ("MASSIVE_API_KEY",)
FMP_ENV_NAME = "FMP_API_KEY"

AUTH_QUERY_KEYS: frozenset[str] = frozenset(
    {
        "apikey",
        "api_key",
        "token",
        "key",
        "secret",
        "password",
        "x-amz-signature",
        "x-amz-security-token",
        "x-amz-credential",
        "signature",
        "key-pair-id",
    }
)
_SECRET_QUERY_RE = re.compile(
    r"(?i)([?&](?:apikey|api_key|token|key|secret|password|x-amz-signature|x-amz-security-token|x-amz-credential|signature|key-pair-id)=)([^&\s'\"}\]]+)"
)
_BEARER_RE = re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;'\"]+)")
_RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({429, 500, 502, 503, 504})

_OPTIONS_PREFIXES: tuple[str, ...] = (
    "/options/",
    "/v3/reference/options",
    "/v3/snapshot/options",
    "/v3/trades/o:",
    "/v3/quotes/o:",
    "/v2/aggs/ticker/o:",
    "/v1/open-close/o:",
)
_STOCKS_PREFIXES: tuple[str, ...] = (
    "/v2/aggs/",
    "/v2/snapshot/locale/us/markets/stocks",
    "/v1/open-close/",
    "/stocks/",
    "/fed/",
    "/v3/snapshot",
    "/v3/reference/",
    "/v2/reference/",
)


class AdapterError(RuntimeError):
    """Base error with centralized secret sanitization."""

    def __init__(self, message: str, *, sanitizer: SecretSanitizer | None = None) -> None:
        clean = sanitizer.sanitize_text(message) if sanitizer is not None else sanitize_text_generic(message)
        super().__init__(clean)


class CredentialPoolError(AdapterError):
    """Raised when an authorized domain credential pool is missing or invalid."""


class OratsPoolBlockedError(CredentialPoolError):
    """Raised when ORATS Slot #2 cannot be unambiguously identified without Slot #3 contamination."""


class DomainRoutingError(AdapterError):
    """Raised when an endpoint targets a forbidden host or wrong credential domain."""


class ProviderAuthorizationError(AdapterError):
    """Raised immediately on HTTP 401/403 or application-level auth errors (never retried)."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        sanitizer: SecretSanitizer | None = None,
    ) -> None:
        self.status_code = status_code
        super().__init__(message, sanitizer=sanitizer)


class PaginationLoopError(AdapterError):
    """Raised when ``next_url`` or cursor pagination repeats a previously requested URL."""


class BudgetExceededError(AdapterError):
    """Raised when a domain or provider request budget limit would be exceeded."""


class ProviderRetryExhaustedError(AdapterError):
    """Raised when retries or deadline are exhausted on transient failures."""

    def __init__(
        self,
        message: str,
        *,
        last_status: int | None = None,
        sanitizer: SecretSanitizer | None = None,
    ) -> None:
        self.last_status = last_status
        super().__init__(message, sanitizer=sanitizer)


class ConflictingDuplicateBarError(AdapterError):
    """Raised when two provider records share (ticker, ts_utc_s) with different values."""


def sanitize_text_generic(text: str) -> str:
    out = _SECRET_QUERY_RE.sub(r"\1<REDACTED>", text)
    out = _BEARER_RE.sub(r"\1<REDACTED>", out)
    return out


class SecretSanitizer:
    """Centralized secret redactor across exceptions, logs, URLs, and manifests."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        variants: list[str] = []
        seen: set[str] = set()
        for raw in secrets:
            if not raw:
                continue
            trimmed = raw.strip()
            for cand in (raw, trimmed, urllib.parse.quote(trimmed, safe="")):
                if cand and len(cand) >= 4 and cand not in seen:
                    seen.add(cand)
                    variants.append(cand)
        self._secrets: tuple[str, ...] = tuple(sorted(variants, key=len, reverse=True))

    def sanitize_text(self, text: str) -> str:
        out = str(text)
        for sec in self._secrets:
            if sec in out:
                out = out.replace(sec, "<REDACTED>")
        return sanitize_text_generic(out)

    def sanitize_url(self, url: str) -> str:
        parsed = urllib.parse.urlsplit(url)
        query_items = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        clean_items: list[tuple[str, str]] = []
        for k, v in query_items:
            if k.lower() in AUTH_QUERY_KEYS:
                continue
            clean_items.append((k, self.sanitize_text(v)))
        rebuilt = urllib.parse.urlunsplit(
            (
                parsed.scheme,
                parsed.netloc,
                parsed.path,
                urllib.parse.urlencode(clean_items),
                "",
            )
        )
        return self.sanitize_text(rebuilt)

    def sanitize_exception(self, exc: BaseException) -> str:
        return f"{type(exc).__name__}: {self.sanitize_text(str(exc))}"


def sanitize_url_for_logs(url: str, sanitizer: SecretSanitizer | None = None) -> str:
    if sanitizer is not None:
        return sanitizer.sanitize_url(url)
    return SecretSanitizer().sanitize_url(url)


def _clean_secret(val: str | None) -> str | None:
    if val is None:
        return None
    stripped = val.strip().strip('"').strip("'")
    return stripped if stripped else None


@dataclass(frozen=True)
class CredentialSlot:
    domain: DomainName
    provider: ProviderName
    slot_id: str
    env_name: str
    value: str = field(repr=False)
    order_index: int


@dataclass(frozen=True)
class OracleCredentials:
    """In-memory segregated credentials; never serialize secret values."""

    stocks_slots: tuple[CredentialSlot, ...]
    options_slots: tuple[CredentialSlot, ...]
    orats_slots: tuple[CredentialSlot, ...]
    fmp_slots: tuple[CredentialSlot, ...]
    orats_blocked_reason: str | None
    orats_excluded_slot_count: int
    sanitizer: SecretSanitizer
    audit_metadata: dict[str, Any]

    def slots_for_domain(self, domain: DomainName) -> tuple[CredentialSlot, ...]:
        if domain == "MASSIVE_STOCKS_REST":
            if not self.stocks_slots:
                raise CredentialPoolError(
                    "MASSIVE_STOCKS_REST pool is empty (expected MASSIVE_KEY_2/3/1).",
                    sanitizer=self.sanitizer,
                )
            return self.stocks_slots
        if domain == "MASSIVE_OPTIONS_REST":
            if not self.options_slots:
                raise CredentialPoolError(
                    "MASSIVE_OPTIONS_REST pool is empty (expected MASSIVE_API_KEY).",
                    sanitizer=self.sanitizer,
                )
            return self.options_slots
        if domain == "ORATS_HISTORICAL":
            if self.orats_blocked_reason is not None or not self.orats_slots:
                raise OratsPoolBlockedError(
                    self.orats_blocked_reason or "ORATS_HISTORICAL pool is empty.",
                    sanitizer=self.sanitizer,
                )
            return self.orats_slots
        if domain == "FMP_ENTERPRISE":
            if not self.fmp_slots:
                raise CredentialPoolError(
                    "FMP_ENTERPRISE pool is empty (expected FMP_API_KEY).",
                    sanitizer=self.sanitizer,
                )
            return self.fmp_slots
        raise DomainRoutingError(f"Unsupported credential domain: {domain}", sanitizer=self.sanitizer)

    @classmethod
    def from_mapping(cls, raw_values: Mapping[str, str | None]) -> OracleCredentials:
        all_secrets: list[str] = []
        for k, v in raw_values.items():
            if not any(k.startswith(pref) for pref in ("MASSIVE", "ORATS", "FMP", "POLYGON")):
                continue
            cleaned = _clean_secret(v)
            if cleaned is None:
                continue
            all_secrets.append(cleaned)
            if k == "ORATS_API_KEYS":
                for part in cleaned.split(","):
                    part_clean = part.strip()
                    if part_clean:
                        all_secrets.append(part_clean)

        stocks_slots: list[CredentialSlot] = []
        seen_stocks_vals: set[str] = set()
        for idx, env_name in enumerate(MASSIVE_STOCKS_ENV_CHAIN, start=1):
            val = _clean_secret(raw_values.get(env_name))
            if val is not None and val not in seen_stocks_vals:
                seen_stocks_vals.add(val)
                stocks_slots.append(
                    CredentialSlot(
                        domain="MASSIVE_STOCKS_REST",
                        provider="massive",
                        slot_id=f"STOCKS_{env_name}",
                        env_name=env_name,
                        value=val,
                        order_index=idx,
                    )
                )

        options_val = _clean_secret(raw_values.get("MASSIVE_API_KEY"))
        options_slots = (
            CredentialSlot(
                domain="MASSIVE_OPTIONS_REST",
                provider="massive",
                slot_id="OPTIONS_MASSIVE_API_KEY",
                env_name="MASSIVE_API_KEY",
                value=options_val,
                order_index=1,
            ),
        ) if options_val is not None else ()

        fmp_val = _clean_secret(raw_values.get(FMP_ENV_NAME))
        fmp_slots = (
            CredentialSlot(
                domain="FMP_ENTERPRISE",
                provider="fmp",
                slot_id="FMP_API_KEY",
                env_name=FMP_ENV_NAME,
                value=fmp_val,
                order_index=1,
            ),
        ) if fmp_val is not None else ()

        # Positional ORATS slot verification BEFORE any deduplication.
        orats_key_1 = _clean_secret(raw_values.get("ORATS_API_KEY"))
        orats_keys_raw = _clean_secret(raw_values.get("ORATS_API_KEYS"))
        orats_slots: list[CredentialSlot] = []
        orats_blocked_reason: str | None = None
        orats_excluded_count = 0

        if orats_key_1 is None:
            orats_blocked_reason = "ORATS_API_KEY (Slot #1) is missing."
        elif orats_keys_raw is None:
            orats_blocked_reason = (
                "ORATS_API_KEYS missing: positional Clave #2 cannot be verified unambiguously."
            )
        else:
            raw_positional = [part.strip() for part in orats_keys_raw.split(",")]
            # Count slot #3+ unconditionally as excluded regardless of slot #2 validity.
            orats_excluded_count = max(0, len([p for p in raw_positional[2:] if p]))
            if not raw_positional or not raw_positional[0]:
                orats_blocked_reason = "ORATS_API_KEYS Slot #1 is empty."
            elif raw_positional[0] != orats_key_1:
                orats_blocked_reason = (
                    "ORATS_API_KEYS positional Slot #1 does not match ORATS_API_KEY; pool blocked."
                )
            elif len(raw_positional) < 2 or not raw_positional[1]:
                orats_blocked_reason = (
                    "ORATS_API_KEYS positional Slot #2 is missing; refusing to promote Slot #3+."
                )
            elif raw_positional[1] == orats_key_1:
                orats_blocked_reason = (
                    "ORATS_API_KEYS positional Slot #2 duplicates Slot #1; refusing to promote Slot #3+."
                )
            else:
                orats_slots = [
                    CredentialSlot(
                        domain="ORATS_HISTORICAL",
                        provider="orats",
                        slot_id="ORATS_SLOT_1",
                        env_name="ORATS_API_KEY",
                        value=orats_key_1,
                        order_index=1,
                    ),
                    CredentialSlot(
                        domain="ORATS_HISTORICAL",
                        provider="orats",
                        slot_id="ORATS_SLOT_2",
                        env_name="ORATS_API_KEYS[1]",
                        value=raw_positional[1],
                        order_index=2,
                    ),
                ]

        sanitizer = SecretSanitizer(all_secrets)
        audit_meta = {
            "massive_stocks_slot_ids": [s.slot_id for s in stocks_slots],
            "massive_options_slot_ids": [s.slot_id for s in options_slots],
            "orats_slot_ids": [s.slot_id for s in orats_slots],
            "orats_blocked_reason": orats_blocked_reason,
            "orats_excluded_slot3_plus_count": orats_excluded_count,
            "fmp_slot_ids": [s.slot_id for s in fmp_slots],
        }
        return cls(
            stocks_slots=tuple(stocks_slots),
            options_slots=tuple(options_slots),
            orats_slots=tuple(orats_slots),
            fmp_slots=tuple(fmp_slots),
            orats_blocked_reason=orats_blocked_reason,
            orats_excluded_slot_count=orats_excluded_count,
            sanitizer=sanitizer,
            audit_metadata=audit_meta,
        )


def load_oracle_credentials(env_path: Path | None = None) -> OracleCredentials:
    """Load strictly segregated credentials from root ``.env`` without printing values."""
    if env_path is None:
        env_path = Path(__file__).resolve().parents[5] / ".env"
    if not env_path.is_file():
        return OracleCredentials.from_mapping({})
    raw_values = dotenv_values(env_path)
    return OracleCredentials.from_mapping(raw_values)


def classify_massive_endpoint_domain(
    url_or_path: str,
) -> Literal["MASSIVE_OPTIONS_REST", "MASSIVE_STOCKS_REST", "FUTURES_FORBIDDEN", "UNKNOWN"]:
    """Classify a Massive URL or path by financial domain, never trusting prefix alone."""
    parsed = urllib.parse.urlsplit(url_or_path.strip())
    path = parsed.path or "/"
    low = path.lower()
    if "/futures" in low:
        return "FUTURES_FORBIDDEN"
    if any(low.startswith(pref) for pref in _OPTIONS_PREFIXES) or "/options/" in low:
        return "MASSIVE_OPTIONS_REST"
    if any(low.startswith(pref) for pref in _STOCKS_PREFIXES):
        return "MASSIVE_STOCKS_REST"
    return "UNKNOWN"


def validate_request_target(
    url: str,
    domain: DomainName,
    *,
    sanitizer: SecretSanitizer | None = None,
) -> urllib.parse.SplitResult:
    """Validate HTTPS scheme, host allowlist, and financial-domain route."""
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme != "https":
        raise DomainRoutingError(f"Only HTTPS allowed for {domain}: got {parsed.scheme!r}", sanitizer=sanitizer)
    if parsed.username or parsed.password:
        raise DomainRoutingError(f"Embedded URL userinfo prohibited for {domain}", sanitizer=sanitizer)
    host = (parsed.hostname or "").lower()
    path = parsed.path or "/"

    if domain in ("MASSIVE_STOCKS_REST", "MASSIVE_OPTIONS_REST"):
        if host not in MASSIVE_ALLOWED_HOSTS:
            raise DomainRoutingError(f"Host {host!r} not in Massive allowlist", sanitizer=sanitizer)
        inferred = classify_massive_endpoint_domain(path)
        if inferred == "FUTURES_FORBIDDEN":
            raise DomainRoutingError(f"Futures paths forbidden in AVWAP oracle: {path}", sanitizer=sanitizer)
        if inferred != domain:
            raise DomainRoutingError(
                f"Massive domain mismatch: endpoint {path!r} classified as {inferred}, requested {domain}",
                sanitizer=sanitizer,
            )
        # Canonicalize legacy polygon host to api.massive.com
        if host == "api.polygon.io":
            netloc = "api.massive.com" if parsed.port is None else f"api.massive.com:{parsed.port}"
            parsed = parsed._replace(netloc=netloc)
        return parsed

    if domain == "ORATS_HISTORICAL":
        if host not in ORATS_ALLOWED_HOSTS:
            raise DomainRoutingError(f"Host {host!r} not in ORATS allowlist", sanitizer=sanitizer)
        if not path.lower().startswith("/datav2/"):
            raise DomainRoutingError(f"ORATS path must begin with /datav2/: {path}", sanitizer=sanitizer)
        return parsed

    if domain == "FMP_ENTERPRISE":
        if host not in FMP_ALLOWED_HOSTS:
            raise DomainRoutingError(f"Host {host!r} not in FMP allowlist", sanitizer=sanitizer)
        if not path.lower().startswith("/stable/"):
            raise DomainRoutingError(f"FMP path must begin with /stable/: {path}", sanitizer=sanitizer)
        return parsed

    raise DomainRoutingError(f"Unsupported domain: {domain}", sanitizer=sanitizer)


def parse_retry_after_header(value: str | None, *, now_epoch_s: float | None = None) -> float | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        secs = float(text)
        return secs if math.isfinite(secs) and secs >= 0.0 else None
    except ValueError:
        pass
    try:
        parsed_dt = email.utils.parsedate_to_datetime(text)
        if parsed_dt.tzinfo is None:
            parsed_dt = parsed_dt.replace(tzinfo=UTC_TZ)
        now_s = time.time() if now_epoch_s is None else now_epoch_s
        return max(0.0, parsed_dt.timestamp() - now_s)
    except Exception:
        return None


def domain_to_provider(domain: DomainName) -> ProviderName:
    if domain in ("MASSIVE_STOCKS_REST", "MASSIVE_OPTIONS_REST"):
        return "massive"
    if domain == "ORATS_HISTORICAL":
        return "orats"
    return "fmp"


@dataclass
class _ProviderAccumulator:
    requests: int = 0
    retries: int = 0
    failures: int = 0
    bytes_received: int = 0
    total_latency_s: float = 0.0
    errors_by_status: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderMetricsSnapshot:
    provider: ProviderName
    requests: int
    retries: int
    failures: int
    bytes_received: int
    total_latency_s: float
    errors_by_status: dict[str, int]


@dataclass(frozen=True)
class TransportResponse:
    status_code: int
    payload: Any
    url_sanitized: str
    bytes_received: int
    elapsed_s: float
    retries: int
    slot_id: str


class AsyncProviderTransport:
    """Shared async HTTP transport with domain isolation, retries, pacing, and redaction."""

    def __init__(
        self,
        credentials: OracleCredentials,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float = 30.0,
        max_attempts: int = 5,
        base_backoff_s: float = 0.75,
        max_backoff_s: float = 15.0,
        total_deadline_s: float = 60.0,
        concurrency_by_domain: Mapping[DomainName, int] | None = None,
        min_interval_by_domain: Mapping[DomainName, float] | None = None,
        budget_by_domain: Mapping[DomainName, int] | None = None,
        budget_by_provider: Mapping[ProviderName, int] | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic_fn: Callable[[], float] = time.monotonic,
        wall_time_fn: Callable[[], float] = time.time,
        jitter_fn: Callable[[], float] | None = None,
    ) -> None:
        self.credentials = credentials
        self.sanitizer = credentials.sanitizer
        self.max_attempts = max(1, int(max_attempts))
        self.base_backoff_s = float(base_backoff_s)
        self.max_backoff_s = float(max_backoff_s)
        self.total_deadline_s = float(total_deadline_s)
        self._sleep = sleep_fn
        self._monotonic = monotonic_fn
        self._wall_time = wall_time_fn
        self._jitter = jitter_fn if jitter_fn is not None else random.random

        default_conc: dict[DomainName, int] = {
            "MASSIVE_STOCKS_REST": 6,
            "MASSIVE_OPTIONS_REST": 3,
            "ORATS_HISTORICAL": 4,
            "FMP_ENTERPRISE": 4,
        }
        if concurrency_by_domain:
            default_conc.update(concurrency_by_domain)
        self._semaphores: dict[DomainName, asyncio.Semaphore] = {
            dom: asyncio.Semaphore(max(1, val)) for dom, val in default_conc.items()
        }

        default_intervals: dict[DomainName, float] = {
            "MASSIVE_STOCKS_REST": 0.02,
            "MASSIVE_OPTIONS_REST": 0.05,
            "ORATS_HISTORICAL": 0.10,
            "FMP_ENTERPRISE": 0.08,
        }
        if min_interval_by_domain:
            default_intervals.update(min_interval_by_domain)
        self._min_intervals = default_intervals
        self._budget_by_domain = dict(budget_by_domain or {})
        self._budget_by_provider = dict(budget_by_provider or {})

        self._rr_cursors: dict[DomainName, int] = {
            "MASSIVE_STOCKS_REST": 0,
            "MASSIVE_OPTIONS_REST": 0,
            "ORATS_HISTORICAL": 0,
            "FMP_ENTERPRISE": 0,
        }
        self._domain_cooldown_until: dict[DomainName, float] = {d: 0.0 for d in default_conc}
        self._last_slot_request_at: dict[str, float] = {}
        self._rate_locks: dict[DomainName, asyncio.Lock] = {d: asyncio.Lock() for d in default_conc}
        self._domain_req_counts: dict[DomainName, int] = {d: 0 for d in default_conc}
        self._metrics: dict[ProviderName, _ProviderAccumulator] = {
            "massive": _ProviderAccumulator(),
            "orats": _ProviderAccumulator(),
            "fmp": _ProviderAccumulator(),
        }
        self._closed = False
        self._client = httpx.AsyncClient(
            verify=True,
            follow_redirects=False,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            timeout=httpx.Timeout(timeout_s),
            transport=transport,
        )

    async def __aenter__(self) -> AsyncProviderTransport:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            await self._client.aclose()

    def get_metrics(self) -> dict[ProviderName, ProviderMetricsSnapshot]:
        return {
            prov: ProviderMetricsSnapshot(
                provider=prov,
                requests=acc.requests,
                retries=acc.retries,
                failures=acc.failures,
                bytes_received=acc.bytes_received,
                total_latency_s=acc.total_latency_s,
                errors_by_status=dict(acc.errors_by_status),
            )
            for prov, acc in self._metrics.items()
        }

    def domain_requests(self, domain: DomainName) -> int:
        return self._domain_req_counts[domain]

    def validate_next_url(
        self,
        next_url: str,
        domain: DomainName,
        seen_urls: set[str],
    ) -> str:
        """Validate ``next_url`` host/route, strip auth params, and detect loops."""
        raw = next_url.strip()
        if not raw:
            raise PaginationLoopError("Empty next_url encountered", sanitizer=self.sanitizer)
        base = {
            "MASSIVE_STOCKS_REST": MASSIVE_BASE_URL,
            "MASSIVE_OPTIONS_REST": MASSIVE_BASE_URL,
            "ORATS_HISTORICAL": ORATS_BASE_URL,
            "FMP_ENTERPRISE": FMP_BASE_URL,
        }[domain]
        joined = urllib.parse.urljoin(f"{base}/", raw)
        validated = validate_request_target(joined, domain, sanitizer=self.sanitizer)
        query_items = [
            (k, v)
            for k, v in urllib.parse.parse_qsl(validated.query, keep_blank_values=True)
            if k.lower() not in AUTH_QUERY_KEYS
        ]
        canonical = urllib.parse.urlunsplit(
            (validated.scheme, validated.netloc, validated.path, urllib.parse.urlencode(query_items), "")
        )
        if canonical in seen_urls:
            raise PaginationLoopError(
                f"Pagination loop detected on {self.sanitizer.sanitize_url(canonical)}",
                sanitizer=self.sanitizer,
            )
        seen_urls.add(canonical)
        return canonical

    def _next_slot(self, domain: DomainName) -> CredentialSlot:
        slots = self.credentials.slots_for_domain(domain)
        idx = self._rr_cursors[domain] % len(slots)
        self._rr_cursors[domain] += 1
        return slots[idx]

    def _inject_auth_url(
        self,
        parsed: urllib.parse.SplitResult,
        domain: DomainName,
        params: Mapping[str, Any] | None,
        slot: CredentialSlot,
    ) -> str:
        query_pairs = [
            (k, v)
            for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            if k.lower() not in AUTH_QUERY_KEYS
        ]
        if params:
            for k, v in params.items():
                if v is None or k.lower() in AUTH_QUERY_KEYS:
                    continue
                query_pairs.append((str(k), str(v)))
        if domain in ("MASSIVE_STOCKS_REST", "MASSIVE_OPTIONS_REST"):
            query_pairs.append(("apiKey", slot.value))
        elif domain == "ORATS_HISTORICAL":
            query_pairs.append(("token", slot.value))
        elif domain == "FMP_ENTERPRISE":
            query_pairs.append(("apikey", slot.value))
        return urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query_pairs), "")
        )

    def _compute_backoff(self, attempt: int, retry_after_s: float | None) -> float:
        if retry_after_s is not None:
            return min(self.max_backoff_s, max(0.0, retry_after_s))
        exp_delay = min(self.max_backoff_s, self.base_backoff_s * (2 ** max(0, attempt - 1)))
        jitter = 0.25 * exp_delay * float(self._jitter())
        return min(self.max_backoff_s, exp_delay + jitter)

    async def request_json(
        self,
        domain: DomainName,
        url_or_path: str,
        *,
        params: Mapping[str, Any] | None = None,
        allow_404: bool = False,
    ) -> TransportResponse:
        if self._closed:
            raise AdapterError("Transport is closed", sanitizer=self.sanitizer)

        base_map: dict[DomainName, str] = {
            "MASSIVE_STOCKS_REST": MASSIVE_BASE_URL,
            "MASSIVE_OPTIONS_REST": MASSIVE_BASE_URL,
            "ORATS_HISTORICAL": ORATS_BASE_URL,
            "FMP_ENTERPRISE": FMP_BASE_URL,
        }
        raw_url = url_or_path.strip()
        if not raw_url.startswith("http://") and not raw_url.startswith("https://"):
            rel = raw_url.lstrip("/")
            base = base_map[domain].rstrip("/")
            if domain == "ORATS_HISTORICAL" and rel.startswith("datav2/"):
                rel = rel[len("datav2/") :]
            elif domain == "FMP_ENTERPRISE" and rel.startswith("stable/"):
                rel = rel[len("stable/") :]
            raw_url = f"{base}/{rel}"

        validated = validate_request_target(raw_url, domain, sanitizer=self.sanitizer)
        sanitized_base_url = self.sanitizer.sanitize_url(
            urllib.parse.urlunsplit(
                (
                    validated.scheme,
                    validated.netloc,
                    validated.path,
                    urllib.parse.urlencode(
                        [(k, v) for k, v in (params or {}).items() if v is not None]
                    ) if not validated.query else validated.query,
                    "",
                )
            )
        )
        provider = domain_to_provider(domain)
        acc = self._metrics[provider]
        # Acquire slot upfront cleanly; NEVER hop across slots to evade 429 rate limit.
        chosen_slot = self._next_slot(domain)
        deadline_at = self._monotonic() + self.total_deadline_s

        sem = self._semaphores[domain]
        async with sem:
            retries_used = 0
            last_status: int | None = None
            last_error_msg = "Unknown failure"

            for attempt in range(1, self.max_attempts + 1):
                dom_cap = self._budget_by_domain.get(domain)
                if dom_cap is not None and self._domain_req_counts[domain] >= dom_cap:
                    raise BudgetExceededError(
                        f"Domain request budget exhausted for {domain} ({dom_cap})",
                        sanitizer=self.sanitizer,
                    )
                prov_cap = self._budget_by_provider.get(provider)
                if prov_cap is not None and acc.requests >= prov_cap:
                    raise BudgetExceededError(
                        f"Provider request budget exhausted for {provider} ({prov_cap})",
                        sanitizer=self.sanitizer,
                    )

                async with self._rate_locks[domain]:
                    now = self._monotonic()
                    cd_wait = max(0.0, self._domain_cooldown_until[domain] - now)
                    min_gap = self._min_intervals.get(domain, 0.0)
                    last_at = self._last_slot_request_at.get(chosen_slot.slot_id, -1e9)
                    gap_wait = max(0.0, (last_at + min_gap) - now)
                    wait_s = max(cd_wait, gap_wait)
                    if wait_s > 0.0:
                        if self._monotonic() + wait_s > deadline_at:
                            raise ProviderRetryExhaustedError(
                                f"Deadline exceeded waiting for cooldown/pacing on {sanitized_base_url}",
                                last_status=last_status,
                                sanitizer=self.sanitizer,
                            )
                        await self._sleep(wait_s)
                    self._last_slot_request_at[chosen_slot.slot_id] = self._monotonic()

                signed_url = self._inject_auth_url(validated, domain, params, chosen_slot)
                req_start = self._monotonic()
                acc.requests += 1
                self._domain_req_counts[domain] += 1

                try:
                    resp = await self._client.get(signed_url)
                    elapsed_s = max(0.0, self._monotonic() - req_start)
                    acc.total_latency_s += elapsed_s
                    raw_bytes = resp.content
                    acc.bytes_received += len(raw_bytes)
                except asyncio.CancelledError:
                    raise
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    elapsed_s = max(0.0, self._monotonic() - req_start)
                    acc.total_latency_s += elapsed_s
                    acc.errors_by_status["TRANSPORT"] = acc.errors_by_status.get("TRANSPORT", 0) + 1
                    last_error_msg = self.sanitizer.sanitize_exception(exc)
                    if attempt >= self.max_attempts:
                        acc.failures += 1
                        raise ProviderRetryExhaustedError(
                            f"Transient error exhausted on {sanitized_base_url}: {last_error_msg}",
                            last_status=last_status,
                            sanitizer=self.sanitizer,
                        ) from exc
                    delay_s = self._compute_backoff(attempt, None)
                    if self._monotonic() + delay_s > deadline_at:
                        acc.failures += 1
                        raise ProviderRetryExhaustedError(
                            f"Deadline exceeded after transport error on {sanitized_base_url}",
                            last_status=last_status,
                            sanitizer=self.sanitizer,
                        ) from exc
                    retries_used += 1
                    acc.retries += 1
                    await self._sleep(delay_s)
                    continue

                status = resp.status_code
                if status in (301, 302, 303, 307, 308):
                    if domain != "ORATS_HISTORICAL":
                        acc.failures += 1
                        acc.errors_by_status[str(status)] = acc.errors_by_status.get(str(status), 0) + 1
                        raise AdapterError(
                            f"Unexpected HTTP {status} redirect on {sanitized_base_url} (redirects forbidden for {domain})",
                            sanitizer=self.sanitizer,
                        )
                    loc_raw = (resp.headers.get("Location") or "").strip()
                    loc_parsed = urllib.parse.urlsplit(loc_raw)
                    loc_host = (loc_parsed.hostname or "").lower()
                    allowed_orats_cdn = (
                        loc_host in {"orats-data.s3.amazonaws.com", "orats-data-api.s3.amazonaws.com"}
                        or (loc_host.startswith("orats-data") and loc_host.endswith(".amazonaws.com"))
                        or loc_host.endswith(".cloudfront.net")
                    )
                    if loc_parsed.scheme != "https" or loc_parsed.username or loc_parsed.password or not allowed_orats_cdn:
                        acc.failures += 1
                        raise DomainRoutingError(
                            f"ORATS redirect target rejected: host={loc_host!r} scheme={loc_parsed.scheme!r}",
                            sanitizer=self.sanitizer,
                        )
                    try:
                        # Single-hop unauthenticated GET to pre-signed ORATS storage (do NOT append token=).
                        resp = await self._client.get(loc_raw)
                        elapsed_s += max(0.0, self._monotonic() - req_start)
                        raw_bytes = resp.content
                        acc.bytes_received += len(raw_bytes)
                        status = resp.status_code
                    except asyncio.CancelledError:
                        raise
                    except (httpx.TimeoutException, httpx.TransportError) as exc:
                        elapsed_s += max(0.0, self._monotonic() - req_start)
                        acc.errors_by_status["TRANSPORT"] = acc.errors_by_status.get("TRANSPORT", 0) + 1
                        last_error_msg = self.sanitizer.sanitize_exception(exc)
                        if attempt >= self.max_attempts:
                            acc.failures += 1
                            raise ProviderRetryExhaustedError(
                                f"ORATS redirect target error exhausted on {sanitized_base_url}: {last_error_msg}",
                                last_status=last_status,
                                sanitizer=self.sanitizer,
                            ) from exc
                        delay_s = self._compute_backoff(attempt, None)
                        if self._monotonic() + delay_s > deadline_at:
                            acc.failures += 1
                            raise ProviderRetryExhaustedError(
                                f"Deadline exceeded on ORATS redirect target {sanitized_base_url}",
                                last_status=last_status,
                                sanitizer=self.sanitizer,
                            ) from exc
                        retries_used += 1
                        acc.retries += 1
                        await self._sleep(delay_s)
                        continue
                    if 300 <= status < 400:
                        acc.failures += 1
                        raise AdapterError(
                            f"Nested HTTP {status} redirect rejected on ORATS storage target for {sanitized_base_url}",
                            sanitizer=self.sanitizer,
                        )

                if status in (401, 403):
                    acc.failures += 1
                    acc.errors_by_status[str(status)] = acc.errors_by_status.get(str(status), 0) + 1
                    raise ProviderAuthorizationError(
                        f"HTTP {status} authorization/entitlement error on {sanitized_base_url}",
                        status_code=status,
                        sanitizer=self.sanitizer,
                    )

                if status == 404 and allow_404:
                    return TransportResponse(
                        status_code=404,
                        payload=None,
                        url_sanitized=sanitized_base_url,
                        bytes_received=len(raw_bytes),
                        elapsed_s=elapsed_s,
                        retries=retries_used,
                        slot_id=chosen_slot.slot_id,
                    )

                if status in _RETRYABLE_STATUS_CODES:
                    last_status = status
                    acc.errors_by_status[str(status)] = acc.errors_by_status.get(str(status), 0) + 1
                    ra = parse_retry_after_header(
                        resp.headers.get("Retry-After"),
                        now_epoch_s=self._wall_time(),
                    )
                    delay_s = self._compute_backoff(attempt, ra)
                    if status == 429:
                        async with self._rate_locks[domain]:
                            self._domain_cooldown_until[domain] = max(
                                self._domain_cooldown_until[domain],
                                self._monotonic() + delay_s,
                            )
                    if attempt >= self.max_attempts or (self._monotonic() + delay_s > deadline_at):
                        acc.failures += 1
                        raise ProviderRetryExhaustedError(
                            f"HTTP {status} exhausted on {sanitized_base_url}",
                            last_status=status,
                            sanitizer=self.sanitizer,
                        )
                    retries_used += 1
                    acc.retries += 1
                    await self._sleep(delay_s)
                    continue

                if status >= 400:
                    acc.failures += 1
                    acc.errors_by_status[str(status)] = acc.errors_by_status.get(str(status), 0) + 1
                    body_preview = self.sanitizer.sanitize_text(resp.text[:250])
                    raise AdapterError(
                        f"HTTP {status} on {sanitized_base_url}: {body_preview}",
                        sanitizer=self.sanitizer,
                    )

                try:
                    payload = resp.json()
                except Exception as exc:
                    acc.failures += 1
                    acc.errors_by_status["JSON_DECODE"] = acc.errors_by_status.get("JSON_DECODE", 0) + 1
                    raise AdapterError(
                        f"Invalid JSON payload on {sanitized_base_url}",
                        sanitizer=self.sanitizer,
                    ) from exc

                # Check application-level errors embedded inside HTTP 200.
                if isinstance(payload, dict):
                    err_val = payload.get("Error Message") or payload.get("error") or payload.get("message")
                    st_val = payload.get("status")
                    has_list = any(isinstance(payload.get(k), list) for k in ("data", "results", "historical"))
                    if isinstance(st_val, str) and st_val.upper() not in {"OK", "SUCCESS", "DELAYED"}:
                        msg_low = str(err_val or st_val).lower()
                        if any(tok in msg_low for tok in ("unauthorized", "invalid api", "invalid key", "auth", "not authorized", "forbidden", "entitle", "plan")):
                            acc.failures += 1
                            raise ProviderAuthorizationError(
                                f"App-level HTTP 200 auth error on {sanitized_base_url}: {err_val or st_val}",
                                status_code=403,
                                sanitizer=self.sanitizer,
                            )
                    elif isinstance(err_val, str) and err_val.strip() and not has_list:
                        msg_low = err_val.lower()
                        if any(tok in msg_low for tok in ("invalid api key", "unauthorized", "invalid token", "not authorized", "upgrade", "restricted", "plan")):
                            acc.failures += 1
                            raise ProviderAuthorizationError(
                                f"App-level HTTP 200 auth error on {sanitized_base_url}: {err_val}",
                                status_code=403,
                                sanitizer=self.sanitizer,
                            )

                return TransportResponse(
                    status_code=status,
                    payload=payload,
                    url_sanitized=sanitized_base_url,
                    bytes_received=len(raw_bytes),
                    elapsed_s=elapsed_s,
                    retries=retries_used,
                    slot_id=chosen_slot.slot_id,
                )

            acc.failures += 1
            raise ProviderRetryExhaustedError(
                f"Retries exhausted on {sanitized_base_url}: {last_error_msg}",
                last_status=last_status,
                sanitizer=self.sanitizer,
            )
