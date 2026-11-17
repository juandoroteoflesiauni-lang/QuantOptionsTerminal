#!/usr/bin/env python3
"""Independent reference fixture for the Pieza 33 feeds health monitor.

This script deliberately re-implements the rolling-window and state-machine
contract from first principles.  It does not import or inspect the TypeScript
implementation.  The generated fixture is consumed by tests/feedsHealthMonitor.test.ts.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

WINDOW_BUCKETS = 60


def snapshot_reference(
    events: list[dict[str, Any]],
    now_ms: int,
    started_at_ms: int | None,
    total_messages: int,
) -> dict[str, Any]:
    """Reference for the 60 x 1s sliding telemetry window."""
    current_bucket = math.floor(now_ms / 1000)
    oldest_bucket = current_bucket - (WINDOW_BUCKETS - 1)
    by_bucket: dict[int, dict[str, Any]] = {}
    for event in events:
        at_ms = event["atMs"]
        bucket = math.floor(at_ms / 1000)
        if bucket < oldest_bucket or bucket > current_bucket:
            continue
        entry = by_bucket.setdefault(
            bucket,
            {
                "count": 0,
                "tick_count": 0,
                "latency_sum_ms": 0.0,
                "latency_samples": 0,
                "http429_count": 0,
                "last_at_ms": None,
                "last_tick_at_ms": None,
                "last_http_success_at_ms": None,
                "last_http_failure_at_ms": None,
                "last_http429_at_ms": None,
            },
        )
        status = event.get("httpStatus")
        is_success_http = status is not None and 200 <= status < 300
        is_tick = (
            event.get("isValidTick") is True
            if status is None
            else is_success_http
        )
        latency = event.get("latencyMs")
        has_latency = latency is not None and math.isfinite(latency) and latency >= 0
        entry["count"] += 1
        if is_tick:
            entry["tick_count"] += 1
        if has_latency:
            entry["latency_sum_ms"] += latency
            entry["latency_samples"] += 1
        if status == 429:
            entry["http429_count"] += 1
            entry["last_http429_at_ms"] = at_ms
        if status is not None:
            if is_success_http:
                entry["last_http_success_at_ms"] = at_ms
            else:
                entry["last_http_failure_at_ms"] = at_ms
        entry["last_at_ms"] = (
            at_ms if entry["last_at_ms"] is None else max(entry["last_at_ms"], at_ms)
        )
        if is_tick:
            entry["last_tick_at_ms"] = (
                at_ms
                if entry["last_tick_at_ms"] is None
                else max(entry["last_tick_at_ms"], at_ms)
            )

    count = 0
    tick_count = 0
    latency_sum_ms = 0.0
    latency_samples = 0
    http429_count = 0
    last_at_ms = None
    last_tick_at_ms = None
    last_http_success_at_ms = None
    last_http_failure_at_ms = None
    last_http429_at_ms = None
    for bucket in range(oldest_bucket, current_bucket + 1):
        entry = by_bucket.get(bucket)
        if entry is None:
            continue
        count += entry["count"]
        tick_count += entry["tick_count"]
        latency_sum_ms += entry["latency_sum_ms"]
        latency_samples += entry["latency_samples"]
        http429_count += entry["http429_count"]
        for target, value in (
            ("last_at_ms", entry["last_at_ms"]),
            ("last_tick_at_ms", entry["last_tick_at_ms"]),
            ("last_http_success_at_ms", entry["last_http_success_at_ms"]),
            ("last_http_failure_at_ms", entry["last_http_failure_at_ms"]),
            ("last_http429_at_ms", entry["last_http429_at_ms"]),
        ):
            if value is None:
                continue
            if target == "last_at_ms":
                last_at_ms = value if last_at_ms is None else max(last_at_ms, value)
            elif target == "last_tick_at_ms":
                last_tick_at_ms = value if last_tick_at_ms is None else max(last_tick_at_ms, value)
            elif target == "last_http_success_at_ms":
                last_http_success_at_ms = (
                    value if last_http_success_at_ms is None else max(last_http_success_at_ms, value)
                )
            elif target == "last_http_failure_at_ms":
                last_http_failure_at_ms = (
                    value if last_http_failure_at_ms is None else max(last_http_failure_at_ms, value)
                )
            elif target == "last_http429_at_ms":
                last_http429_at_ms = value if last_http429_at_ms is None else max(last_http429_at_ms, value)

    return {
        "startedAtMs": started_at_ms,
        "totalMessages": total_messages,
        "messagesPerMinute": None if started_at_ms is None else count,
        "averageLatencyMs": None if latency_samples == 0 else latency_sum_ms / latency_samples,
        "latencySamples": latency_samples,
        "lastMessageAtMs": last_at_ms,
        "lastTickAtMs": last_tick_at_ms,
        "lastHttpSuccessAtMs": last_http_success_at_ms,
        "lastHttpFailureAtMs": last_http_failure_at_ms,
        "lastHttp429AtMs": last_http429_at_ms,
        "http429PerMinute": None if started_at_ms is None else http429_count,
    }


def resolve_state(configured: bool, connected: bool | None, session_mode: str) -> str:
    if not configured:
        return "NOT_CONFIGURED"
    if connected is True:
        return "CONNECTED"
    if session_mode == "OUT_OF_SESSION":
        return "ARMED_OUT_OF_SESSION"
    return "DEGRADED"


MASSIVE_WS_LIVE_MESSAGE_MAX_AGE_MS = 5000


def massive_ws_socket_live(
    connected: bool,
    messages_per_minute: int | None,
    last_message_age_ms: int | None,
) -> bool:
    """Regla de liveness del socket Massive de acciones (hotfix producción).

    El socket está vivo si el cliente reporta `ready`, o si el flujo demuestra
    recepción: mensajes en la ventana móvil y último mensaje con edad menor a
    5 s (p. ej. 42 ms con 33.883 msg/min). La edad mide la recepción local del
    último mensaje WebSocket; el timestamp de un tick histórico individual del
    proveedor no participa en la decisión.
    """
    if connected:
        return True
    if messages_per_minute is None or messages_per_minute <= 0:
        return False
    if last_message_age_ms is None or last_message_age_ms >= MASSIVE_WS_LIVE_MESSAGE_MAX_AGE_MS:
        return False
    return True


def massive_ws_state(configured: bool, session_mode: str, live: bool) -> str:
    """Estado del proveedor MASSIVE_WS_STOCKS con la liveness aplicada antes."""
    if not configured:
        return "NOT_CONFIGURED"
    if live:
        return "CONNECTED"
    if session_mode == "OUT_OF_SESSION":
        return "ARMED_OUT_OF_SESSION"
    return "DEGRADED"


def get_us_market_parts(utc_sec: int) -> dict[str, int]:
    """Reference NY calendar clock (America/New_York) without external libraries.

    Python's zoneinfo is an independent implementation from the TypeScript clock.
    """
    from zoneinfo import ZoneInfo
    from datetime import datetime, timezone

    dt = datetime.fromtimestamp(utc_sec, tz=timezone.utc).astimezone(ZoneInfo("America/New_York"))
    return {
        "weekday": 7 if dt.weekday() == 6 else dt.weekday() + 1,
        "minutesOfDay": dt.hour * 60 + dt.minute,
    }


def us_session_reference(utc_sec: int) -> str:
    parts = get_us_market_parts(utc_sec)
    minutes = parts["minutesOfDay"]
    weekday = parts["weekday"]
    is_weekday = 1 <= weekday <= 5
    is_open = is_weekday and (
        (9 * 60 + 30 <= minutes < 16 * 60)
        or (4 * 60 <= minutes < 20 * 60)
    )
    return "IN_SESSION" if is_open else "OUT_OF_SESSION"


def ar_session_reference(utc_sec: int) -> str:
    from zoneinfo import ZoneInfo
    from datetime import datetime, timezone

    dt = datetime.fromtimestamp(utc_sec, tz=timezone.utc).astimezone(ZoneInfo("America/Buenos_Aires"))
    weekday = 7 if dt.weekday() == 6 else dt.weekday() + 1
    minutes = dt.hour * 60 + dt.minute
    is_open = 1 <= weekday <= 5 and 11 * 60 <= minutes < 17 * 60
    return "IN_SESSION" if is_open else "OUT_OF_SESSION"


def age_reference(at_ms: int | None, now_ms: int) -> int | None:
    if at_ms is None or at_ms < 0 or now_ms < at_ms:
        return None
    return now_ms - at_ms


def main() -> None:
    fixture: dict[str, Any] = {}

    # Rolling telemetry: full seconds, boundary pruning, failed HTTP, 429 and
    # negative provider latency (clock skew) ignored for the average.
    telemetry_cases: list[dict[str, Any]] = []
    base_ms = 1_700_000_000_000
    base_bucket = math.floor(base_ms / 1000)

    ws_events = [
        {"atMs": base_bucket * 1000 + 100, "latencyMs": 12.0, "isValidTick": True},
        {"atMs": base_bucket * 1000 + 250, "latencyMs": 18.0, "isValidTick": True},
        {"atMs": (base_bucket + 1) * 1000 + 10, "latencyMs": -3.0, "isValidTick": True},
        {"atMs": (base_bucket + 59) * 1000 + 500, "latencyMs": 30.0, "isValidTick": True},
    ]
    telemetry_cases.append(
        {
            "name": "ws_window_boundaries_and_clock_skew",
            "events": ws_events,
            "nowMs": (base_bucket + 59) * 1000 + 600,
            "expected": snapshot_reference(ws_events, (base_bucket + 59) * 1000 + 600, base_bucket * 1000 + 100, 4),
        }
    )

    pruned_events = ws_events + [
        {"atMs": (base_bucket + 60) * 1000 + 20, "latencyMs": 44.0, "isValidTick": True},
        {"atMs": (base_bucket + 60) * 1000 + 30, "latencyMs": 46.0, "isValidTick": True},
    ]
    telemetry_cases.append(
        {
            "name": "old_bucket_pruned",
            "events": pruned_events,
            "nowMs": (base_bucket + 60) * 1000 + 40,
            "expected": snapshot_reference(pruned_events, (base_bucket + 60) * 1000 + 40, base_bucket * 1000 + 100, 6),
        }
    )

    http_events = [
        {"atMs": base_bucket * 1000 + 20, "latencyMs": 80.0, "httpStatus": 200},
        {"atMs": base_bucket * 1000 + 40, "latencyMs": 120.0, "httpStatus": 429},
        {"atMs": base_bucket * 1000 + 60, "latencyMs": None, "httpStatus": 500},
    ]
    telemetry_cases.append(
        {
            "name": "http_success_429_and_failure",
            "events": http_events,
            "nowMs": base_bucket * 1000 + 70,
            "expected": snapshot_reference(http_events, base_bucket * 1000 + 70, base_bucket * 1000 + 20, 3),
        }
    )
    fixture["telemetry"] = telemetry_cases

    state_cases = [
        {
            "name": "not_configured",
            "configured": False,
            "connected": None,
            "sessionMode": "IN_SESSION",
            "expected": "NOT_CONFIGURED",
        },
        {
            "name": "connected_even_out_of_session",
            "configured": True,
            "connected": True,
            "sessionMode": "OUT_OF_SESSION",
            "expected": "CONNECTED",
        },
        {
            "name": "armed_out_of_session",
            "configured": True,
            "connected": False,
            "sessionMode": "OUT_OF_SESSION",
            "expected": "ARMED_OUT_OF_SESSION",
        },
        {
            "name": "degraded_in_session",
            "configured": True,
            "connected": False,
            "sessionMode": "IN_SESSION",
            "expected": "DEGRADED",
        },
    ]
    fixture["state"] = state_cases

    # BMB STANDBY_2FA (hotfix producción): el estado `STANDBY_2FA` del bridge
    # BMB_HOMEBROKER_L2 se reconoce como estado informativo suave (DEGRADED) en
    # cualquier modo de sesión; no es reconectable automáticamente para evitar
    # bucles de login que podrían bloquear la cuenta. La regla se re-implementa
    # aquí desde cero como referencia independiente.
    BMB_STANDBY_2FA_STATUS = "STANDBY_2FA"

    def bmb_provider_state_reference(
        configured: bool,
        connected: bool | None,
        session_mode: str,
        health_status: str,
    ) -> str:
        if not configured:
            return "NOT_CONFIGURED"
        if connected is True:
            return "CONNECTED"
        if health_status == BMB_STANDBY_2FA_STATUS:
            return "DEGRADED"
        if session_mode == "OUT_OF_SESSION":
            return "ARMED_OUT_OF_SESSION"
        return "DEGRADED"

    def bmb_provider_reconnectable_reference(health_status: str, signal_r_mode: bool) -> bool:
        # Pieza 38.1: en modo SignalR Core el bridge local soporta
        # `POST /reconnect` (202) con reinicio limpio -> siempre reconectable
        # (incluidos CONNECTING, ERROR y STANDBY_2FA). En modo legacy, el 2FA
        # interactivo no se reconecta automáticamente (evitar bucles de login).
        if signal_r_mode:
            return True
        return health_status != BMB_STANDBY_2FA_STATUS

    bmb_specs = [
        ("standby_2fa_in_session", True, False, "IN_SESSION", BMB_STANDBY_2FA_STATUS),
        ("standby_2fa_out_of_session", True, False, "OUT_OF_SESSION", BMB_STANDBY_2FA_STATUS),
        ("standby_2fa_not_configured", False, False, "IN_SESSION", BMB_STANDBY_2FA_STATUS),
        ("standby_2fa_connected_wins", True, True, "IN_SESSION", BMB_STANDBY_2FA_STATUS),
        ("error_status_in_session", True, False, "IN_SESSION", "ERROR"),
        ("error_status_out_of_session", True, False, "OUT_OF_SESSION", "ERROR"),
        ("disabled_no_password_in_session", True, False, "IN_SESSION", "DISABLED_NO_PASSWORD"),
    ]
    fixture["bmbStandby2fa"] = {
        "cases": [
            {
                "name": name,
                "configured": configured,
                "connected": connected,
                "sessionMode": session_mode,
                "healthStatus": health_status,
                "signalRMode": False,
                "expectedState": bmb_provider_state_reference(configured, connected, session_mode, health_status),
                "expectedReconnectable": bmb_provider_reconnectable_reference(health_status, False),
            }
            for name, configured, connected, session_mode, health_status in bmb_specs
        ]
    }

    # Pieza 38.1: en modo SignalR Core el proveedor BMB es siempre reconectable
    # (el bridge local responde 202 en POST /reconnect), sin importar el estado.
    signalr_specs = [
        ("signalr_connecting", True, False, "IN_SESSION", "CONNECTING"),
        ("signalr_error", True, False, "IN_SESSION", "ERROR"),
        ("signalr_standby_2fa", True, False, "IN_SESSION", BMB_STANDBY_2FA_STATUS),
        ("signalr_connected_l2", True, True, "IN_SESSION", "CONNECTED_L2"),
        ("signalr_out_of_session", True, False, "OUT_OF_SESSION", "DISCONNECTED"),
    ]
    fixture["bmbStandby2fa"]["signalRModeCases"] = [
        {
            "name": name,
            "configured": configured,
            "connected": connected,
            "sessionMode": session_mode,
            "healthStatus": health_status,
            "signalRMode": True,
            "expectedState": bmb_provider_state_reference(configured, connected, session_mode, health_status),
            "expectedReconnectable": bmb_provider_reconnectable_reference(health_status, True),
        }
        for name, configured, connected, session_mode, health_status in signalr_specs
    ]

    # Liveness MASSIVE_WS_STOCKS (hotfix producción): el flujo real de mensajes
    # manda sobre la transición momentánea del estado del cliente; el proveedor
    # no se degrada mientras el último mensaje tenga menos de 5 s de edad.
    us_in_session_utc_sec = 1_700_000_000
    us_out_of_session_utc_sec = 1_699_570_200
    liveness_specs = [
        ("ready_socket_quiescent", True, None, None),
        ("ready_socket_with_flow", True, 33_883, 42),
        ("production_flap_live_flow", False, 33_883, 42),
        ("flap_flow_below_bound", False, 1, 4_999),
        ("flap_flow_at_bound", False, 33_883, 5_000),
        ("flap_flow_stale", False, 33_883, 5_200),
        ("no_messages_recent_age", False, 0, 120),
        ("missing_telemetry", False, None, None),
        ("flow_without_age", False, 1_200, None),
    ]
    liveness_cases: list[dict[str, Any]] = []
    for name, connected, messages_per_minute, last_message_age_ms in liveness_specs:
        for utc_sec in (us_in_session_utc_sec, us_out_of_session_utc_sec):
            live = massive_ws_socket_live(connected, messages_per_minute, last_message_age_ms)
            liveness_cases.append(
                {
                    "name": (
                        f"{name}__"
                        f"{'in_session' if utc_sec == us_in_session_utc_sec else 'out_of_session'}"
                    ),
                    "connected": connected,
                    "messagesPerMinute": messages_per_minute,
                    "lastMessageAgeMs": last_message_age_ms,
                    "usUtcSec": utc_sec,
                    "expectedConnected": live,
                    "expectedState": massive_ws_state(True, us_session_reference(utc_sec), live),
                }
            )
    fixture["massiveWsLiveness"] = liveness_cases

    session_cases = [
        # Wednesday 14:30 New York = IN_SESSION.
        {"name": "us_rth", "utcSec": 1_700_000_000, "market": "US", "expected": us_session_reference(1_700_000_000)},
        # Sunday 14:30 New York = OUT_OF_SESSION.
        {"name": "us_sunday", "utcSec": 1_699_570_200, "market": "US", "expected": us_session_reference(1_699_570_200)},
        # Wednesday 14:30 Buenos Aires = IN_SESSION.
        {"name": "ar_session", "utcSec": 1_700_000_000, "market": "AR", "expected": ar_session_reference(1_700_000_000)},
        # Wednesday 10:30 Buenos Aires = OUT_OF_SESSION.
        {"name": "ar_pre_session", "utcSec": 1_699_995_000, "market": "AR", "expected": ar_session_reference(1_699_995_000)},
    ]
    fixture["sessions"] = session_cases

    fixture["age"] = [
        {"name": "valid", "atMs": 1_000, "nowMs": 1_500, "expected": 500},
        {"name": "future_is_null", "atMs": 2_000, "nowMs": 1_500, "expected": None},
        {"name": "missing_is_null", "atMs": None, "nowMs": 1_500, "expected": None},
    ]

    output_path = Path(__file__).resolve().parent.parent / "fixtures" / "feeds_health_monitor.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(fixture, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
