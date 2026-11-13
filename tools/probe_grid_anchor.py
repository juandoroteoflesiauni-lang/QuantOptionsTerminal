"""Sonda del ancla de rejilla de Massive /v2/aggs (red real, solo lectura).

Herramienta pedida por el dueño (2026-11-12) para resolver el caso 6 de la
sección d de docs/math_engine_review.md: ¿a qué se ancla la rejilla de
sellos de los agregados intradía?

Diseño del experimento (discriminante):
  - from FIJO y alineado: 2026-11-11 04:00:00 ET (= 09:00:00Z, EST), arranque
    del horario extendido. Alineado a :00 ET y, para 5m/15m/30m, también a la
    rejilla de la época UTC.
  - to FIJO en un segundo arbitrario NO alineado: 2026-11-11 13:34:56 ET
    (= 18:34:56Z). El minuto 34 (34 mod 5/15/30 = 4) y la hora 18Z
    (18 mod 4 = 2 h) caen fuera de cualquier rejilla de 5m/15m/30m/4h.
  - 4 timeframes (5m, 15m, 30m, 4h) x 2 órdenes (asc, desc) = 8 peticiones,
    espaciadas 13,001 s (plan gratuito: 5 peticiones/minuto).
  - Para cada respuesta se reporta el desfase de la primera y la última
    cubeta respecto de la rejilla UTC (t mod timespan) y de la rejilla ET
    (segundos del día ET mod timespan), y contra qué ancla cuadra.

Fases esperadas en ms:
  ancla=from:    5m/15m/30m -> 0 (UTC y ET); 4h -> UTC 3,600,000 (1 h) / ET 0
  ancla=to:      5m/15m/30m -> 240,000 (4 min); 4h -> UTC 7,200,000 (2 h) / ET 3,600,000 (1 h)
  ancla=época:   5m/15m/30m -> 0 (indistinguible de from); 4h -> UTC 0 / ET 10,800,000 (3 h)

La clave se lee de MASSIVE_API_KEY (o los alias de tools/capture_samples.py)
y NUNCA se imprime: las URLs se muestran con el parámetro apiKey oculto.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
REPO = Path(__file__).resolve().parents[1]
BASE_URL = "https://api.polygon.io"
THROTTLE_SECONDS = 13.001
SYMBOL = "SPY"

# 2026-11-11 es miércoles (EST, UTC-5): sesión completa cerrada el día previo.
FROM_UTC = datetime(2026, 11, 11, 9, 0, 0, tzinfo=timezone.utc)  # 04:00:00 ET
TO_UTC = datetime(2026, 11, 11, 18, 34, 56, tzinfo=timezone.utc)  # 13:34:56 ET

# (etiqueta, multiplicador, timespan, timespan_ms)
TIMEFRAMES = [
    ("5m", 5, "minute", 300_000),
    ("15m", 15, "minute", 900_000),
    ("30m", 30, "minute", 1_800_000),
    ("4h", 4, "hour", 14_400_000),
]

KEY_ENV_NAMES = (
    "MASSIVE_API_KEY",
    "MASSIVE_KEY_OPTIONS",
    "MASSIVE_OPTIONS",
    "MASSIVE_KEY",
)

MINUTE_UNIT_MS = 60_000
HOUR_UNIT_MS = 3_600_000


def load_api_key() -> str:
    for name in KEY_ENV_NAMES:
        value = os.environ.get(name)
        if value:
            return value.strip()
    env_file = REPO / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            if key.strip() in KEY_ENV_NAMES and value.strip():
                return value.strip()
    return ""


def sanitized_url(path: str, params: dict[str, str]) -> str:
    visible = {k: v for k, v in params.items() if k != "apiKey"}
    return f"{BASE_URL}{path}?{urllib.parse.urlencode(visible)}"


def fetch(url: str) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "quant-options-terminal-grid-probe/1"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def et_of_day_ms(t_ms: int) -> int:
    """Milisegundos transcurridos desde la medianoche ET."""
    parts = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(NY)
    return (
        ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000
        + t_ms % 1000
    )


def et_label(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(
        NY
    ).strftime("%Y-%m-%d %H:%M:%S")


def floor_to_unit(t_ms: int, unit_ms: int) -> int:
    return t_ms // unit_ms * unit_ms


def expected_phases() -> str:
    lines = []
    for label, _, _, ts_ms in TIMEFRAMES:
        unit = MINUTE_UNIT_MS if ts_ms < HOUR_UNIT_MS else HOUR_UNIT_MS
        from_utc = FROM_MS % ts_ms
        from_et = et_of_day_ms(FROM_MS) % ts_ms
        to_utc = floor_to_unit(TO_MS, unit) % ts_ms
        to_et = floor_to_unit(et_of_day_ms(TO_MS), unit) % ts_ms
        epoch_utc = 0
        epoch_et = (et_of_day_ms(0) % ts_ms) if ts_ms < HOUR_UNIT_MS else 10_800_000
        lines.append(
            f"  {label:>3}: ancla=from -> UTC {from_utc:>9,} / ET {from_et:>9,}"
            f" | ancla=to -> UTC {to_utc:>9,} / ET {to_et:>9,}"
            f" | época -> UTC {epoch_utc:>9,} / ET {epoch_et:>9,}"
        )
    return "\n".join(lines)


def classify(label: str, ts_ms: int, stamps: list[int]) -> str:
    """Clasifica el ancla por los desfases de las cubetas de UNA respuesta."""
    phases = {(t % ts_ms, et_of_day_ms(t) % ts_ms) for t in stamps}
    unit = MINUTE_UNIT_MS if ts_ms < HOUR_UNIT_MS else HOUR_UNIT_MS
    candidates = {
        "from": (FROM_MS % ts_ms, et_of_day_ms(FROM_MS) % ts_ms),
        "to": (floor_to_unit(TO_MS, unit) % ts_ms, floor_to_unit(et_of_day_ms(TO_MS), unit) % ts_ms),
    }
    if ts_ms >= HOUR_UNIT_MS:
        candidates["época"] = (0, 10_800_000)
    matches = [name for name, phase in candidates.items() if phases == {phase}]
    if not matches:
        return f"otro {sorted(phases)}"
    return "+".join(matches)


def analyze(label: str, mult: int, ts_name: str, ts_ms: int, sort: str, body: dict) -> None:
    rows = body.get("results") or []
    stamps = sorted(int(row["t"]) for row in rows)
    phases = [(t % ts_ms, et_of_day_ms(t) % ts_ms) for t in stamps]
    first, last = (stamps[0], stamps[-1]) if stamps else (None, None)
    diffs = {b - a for a, b in zip(stamps, stamps[1:])}
    multiples = all(d % ts_ms == 0 for d in diffs)
    in_range = all(FROM_MS <= t <= TO_MS for t in stamps)
    spacing = (
        f"multiplos del timespan ({'si' if multiples else 'NO'}); "
        f"min={min(diffs) // 1000}s max={max(diffs) // 1000}s" if diffs else "n/a"
    )
    print(
        f"  {label:>3} {sort:>4}: http=ok filas={len(stamps):3d} "
        f"primera={et_label(first) if first else '—'} "
        f"ultima={et_label(last) if last else '—'} "
        f"fase1(UTC,ET)=({phases[0][0]:,},{phases[0][1]:,}) " if stamps else "",
        end="",
    )
    if stamps:
        print(
            f"faseN(UTC,ET)=({phases[-1][0]:,},{phases[-1][1]:,}) "
            f"rango_dentro=[{'si' if in_range else 'NO'}] separacion={spacing} "
            f"ancla={classify(label, ts_ms, stamps)}"
        )
    else:
        print()


FROM_MS = int(FROM_UTC.timestamp() * 1000)
TO_MS = int(TO_UTC.timestamp() * 1000)


def main() -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: clave no encontrada (MASSIVE_API_KEY o alias)")
        return 1

    from_label = f"{FROM_UTC.strftime('%Y-%m-%dT%H:%M:%SZ')} (04:00 ET, alineado)"
    to_label = f"{TO_UTC.strftime('%Y-%m-%dT%H:%M:%SZ')} (13:34:56 ET, segundo arbitrario)"
    print("=== Sonda del ancla de rejilla (Massive /v2/aggs) ===")
    print(f"from = {from_label}")
    print(f"to   = {to_label}")
    print(f"peticiones = {len(TIMEFRAMES) * 2} (asc/desc), {THROTTLE_SECONDS}s entre peticiones")
    print(f"fases esperadas (ms):\n{expected_phases()}")

    index = 0
    for label, mult, ts_name, ts_ms in TIMEFRAMES:
        for sort in ("asc", "desc"):
            if index > 0:
                time.sleep(THROTTLE_SECONDS)
            index += 1
            path = f"/v2/aggs/ticker/{SYMBOL}/range/{mult}/{ts_name}/{FROM_MS}/{TO_MS}"
            params = {
                "adjusted": "true",
                "sort": sort,
                "limit": "1000",
                "apiKey": api_key,
            }
            shown = sanitized_url(path, params)
            print(f"[{index}/8] {shown}")
            try:
                status, body = fetch(f"{BASE_URL}{path}?{urllib.parse.urlencode(params)}")
            except urllib.error.HTTPError as error:
                print(f"  {label} {sort}: HTTP {error.code}")
                continue
            except Exception as error:  # noqa: BLE001 - herramienta de diagnostico
                print(f"  {label} {sort}: ERROR {type(error).__name__}")
                continue
            if status != 200 or body.get("status") != "OK":
                print(
                    f"  {label} {sort}: http={status} status={body.get('status')} "
                    f"resultsCount={body.get('resultsCount')}"
                )
                continue
            analyze(label, mult, ts_name, ts_ms, sort, body)

    print("=== Fin de la sonda ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
