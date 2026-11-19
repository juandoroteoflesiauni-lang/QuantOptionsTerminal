#!/usr/bin/env python3
"""
Referencia INDEPENDIENTE para Pieza 41.4.

No copia la lógica TypeScript:
- Evalúa la ventana de frescura FMP según modo de lote y actividad más reciente.
- Evalúa la tabla explícita de conmutación bidireccional Live <-> Sandbox de Tradier ante HTTP 401/403.
- Todos los tokens son sentinelas sintéticos, nunca credenciales reales.
"""

import json
from pathlib import Path


DEFAULT_FMP_STALE_MS = 10_000
CHUNKED_FMP_STALE_MS = 45_000

PROD_REST = "https://api.tradier.com/v1"
PROD_WS = "wss://ws.tradier.com/v1/markets/events"
SANDBOX_REST = "https://sandbox.tradier.com/v1"
SANDBOX_WS = "wss://sandbox.tradier.com/v1/markets/events"


def fmp_threshold(batch_mode, override_ms=None):
    if override_ms is not None and override_ms > 0:
        return override_ms
    if batch_mode in ("v3-batch", "stable-single-pool"):
        return CHUNKED_FMP_STALE_MS
    return DEFAULT_FMP_STALE_MS


def fmp_is_connected(case):
    if not case["configured"]:
        return False
    if case["activeSymbols"] <= 0:
        return False
    now_ms = case["nowMs"]
    stamps = [
        ts
        for ts in (case["lastTickAtMs"], case["lastHttpSuccessAtMs"], case["lastSuccessAtMs"])
        if ts is not None and 0 <= ts <= now_ms
    ]
    if not stamps:
        return False
    latest_ms = max(stamps)
    threshold_ms = fmp_threshold(case.get("batchMode"), case.get("staleThresholdMs"))
    if now_ms - latest_ms > threshold_ms:
        return False
    err = case.get("lastError")
    if err is not None and err.strip() != "":
        return False
    fail_ms = case.get("lastHttpFailureAtMs")
    if fail_ms is not None and fail_ms > latest_ms:
        return False
    return True


def tradier_retry_target(api_env, http_status, token_is_generic, sandbox_fallback_allowed):
    if api_env == "sandbox":
        return "prod" if http_status == 401 else None
    if not sandbox_fallback_allowed:
        return None
    if http_status == 401:
        return "sandbox"
    if http_status == 403 and token_is_generic:
        return "sandbox"
    return None


def main() -> None:
    us_in_session_ms = 1_795_104_000_000  # 2026-11-19 16:00:00 UTC (jueves en rueda US)

    fmp_threshold_cases = [
        {"batchMode": "stable-batch", "overrideMs": None, "expectedMs": 10_000},
        {"batchMode": "v3-batch", "overrideMs": None, "expectedMs": 45_000},
        {"batchMode": "stable-single-pool", "overrideMs": None, "expectedMs": 45_000},
        {"batchMode": None, "overrideMs": None, "expectedMs": 10_000},
        {"batchMode": "stable-batch", "overrideMs": 30_000, "expectedMs": 30_000},
    ]

    fmp_health_cases = [
        {
            "name": "172 activos stable-single-pool con ciclo 15s",
            "configured": True,
            "activeSymbols": 172,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 15_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 15_000,
            "lastTickAtMs": us_in_session_ms - 15_000,
            "lastHttpFailureAtMs": None,
            "batchMode": "stable-single-pool",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "172 activos stable-single-pool con ciclo 20s",
            "configured": True,
            "activeSymbols": 172,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 20_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 20_000,
            "lastTickAtMs": us_in_session_ms - 20_000,
            "lastHttpFailureAtMs": None,
            "batchMode": "stable-single-pool",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "172 activos v3-batch en borde exacto 45s",
            "configured": True,
            "activeSymbols": 172,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 45_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 45_000,
            "lastTickAtMs": us_in_session_ms - 45_000,
            "lastHttpFailureAtMs": None,
            "batchMode": "v3-batch",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "172 activos stable-single-pool vencido > 45s",
            "configured": True,
            "activeSymbols": 172,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 45_001,
            "lastHttpSuccessAtMs": us_in_session_ms - 45_001,
            "lastTickAtMs": us_in_session_ms - 45_001,
            "lastHttpFailureAtMs": None,
            "batchMode": "stable-single-pool",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "0 activos dentro de ventana",
            "configured": True,
            "activeSymbols": 0,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 5_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 5_000,
            "lastTickAtMs": us_in_session_ms - 5_000,
            "lastHttpFailureAtMs": None,
            "batchMode": "stable-single-pool",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "172 activos con error fatal",
            "configured": True,
            "activeSymbols": 172,
            "lastError": "FMP batch quote HTTP 500",
            "lastSuccessAtMs": us_in_session_ms - 5_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 5_000,
            "lastTickAtMs": us_in_session_ms - 5_000,
            "lastHttpFailureAtMs": None,
            "batchMode": "stable-single-pool",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
        {
            "name": "172 activos con fallo HTTP posterior al ultimo tick",
            "configured": True,
            "activeSymbols": 172,
            "lastError": None,
            "lastSuccessAtMs": us_in_session_ms - 10_000,
            "lastHttpSuccessAtMs": us_in_session_ms - 10_000,
            "lastTickAtMs": us_in_session_ms - 10_000,
            "lastHttpFailureAtMs": us_in_session_ms - 5_000,
            "batchMode": "v3-batch",
            "staleThresholdMs": None,
            "nowMs": us_in_session_ms,
        },
    ]

    for item in fmp_health_cases:
        connected = fmp_is_connected(item)
        item["expectedConnected"] = connected
        item["expectedState"] = "CONNECTED" if connected else "DEGRADED"

    tradier_cases = [
        {
            "name": "SANDBOX 401 con TRADIER_USE_SANDBOX=true conmuta a LIVE",
            "env": {"TRADIER_TOKEN": "synthetic-live-token", "TRADIER_USE_SANDBOX": "true"},
            "httpStatus": 401,
            "expectedRetryApiEnv": "prod",
            "expectedRestBaseUrl": PROD_REST,
            "expectedWsBaseUrl": PROD_WS,
            "expectedTelemetry": "LIVE · api.tradier.com/v1",
        },
        {
            "name": "LIVE 401 con token dedicado conmuta a SANDBOX",
            "env": {"TRADIER_LIVE_TOKEN": "synthetic-sandbox-token"},
            "httpStatus": 401,
            "expectedRetryApiEnv": "sandbox",
            "expectedRestBaseUrl": SANDBOX_REST,
            "expectedWsBaseUrl": SANDBOX_WS,
            "expectedTelemetry": "SANDBOX · sandbox.tradier.com/v1",
        },
        {
            "name": "LIVE 401 con TRADIER_USE_SANDBOX=false no conmuta",
            "env": {"TRADIER_TOKEN": "synthetic-live-token", "TRADIER_USE_SANDBOX": "false"},
            "httpStatus": 401,
            "expectedRetryApiEnv": None,
            "expectedRestBaseUrl": None,
            "expectedWsBaseUrl": None,
            "expectedTelemetry": "LIVE · api.tradier.com/v1",
        },
        {
            "name": "SANDBOX 500 no conmuta",
            "env": {"TRADIER_SANDBOX_TOKEN": "synthetic-sandbox-token"},
            "httpStatus": 500,
            "expectedRetryApiEnv": None,
            "expectedRestBaseUrl": None,
            "expectedWsBaseUrl": None,
            "expectedTelemetry": "SANDBOX · sandbox.tradier.com/v1",
        },
    ]

    for tc in tradier_cases:
        env = tc["env"]
        token_is_generic = "TRADIER_TOKEN" in env or "TRADIER_API_TOKEN" in env
        sandbox_fallback_allowed = env.get("TRADIER_USE_SANDBOX", "").lower() != "false"
        initial_env = (
            "sandbox"
            if ("TRADIER_SANDBOX_TOKEN" in env or env.get("TRADIER_USE_SANDBOX", "").lower() == "true")
            else "prod"
        )
        assert tradier_retry_target(initial_env, tc["httpStatus"], token_is_generic, sandbox_fallback_allowed) == tc["expectedRetryApiEnv"]

    out = {
        "version": 1,
        "fmpStaleThresholds": fmp_threshold_cases,
        "fmpHealthCases": fmp_health_cases,
        "tradierRetryCases": tradier_cases,
    }
    target = Path(__file__).resolve().parent.parent / "fixtures" / "fmp_tradier_health_reference.json"
    target.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {target}")


if __name__ == "__main__":
    main()
