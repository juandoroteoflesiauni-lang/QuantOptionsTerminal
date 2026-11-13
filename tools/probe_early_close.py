#!/usr/bin/env python3
"""
tools/probe_early_close.py

Sonda independiente (SOLO LECTURA) para un dia habil con cierre anticipado.

Entrada: muestras crudas del capturador (escenario day):
  fixtures/samples/SPY_1m_<dia>.json
  fixtures/samples/SPY_1D_<dia>.json

Metodo: implementacion explicita en Python, escrita desde los requisitos
del SPEC (sin importar el TypeScript). Convierte milisegundos a segundos
SOLO aqui. No modifica archivos ni el core.

Que responde, todo con los DATOS (no con memoria ni calendario):
  0. Verifica desde los datos el minuto de cierre regular (la ultima barra
     de volumen de escala de sesion antes de un tramo persistente de
     volumen bajo dentro de 09:30-16:00 ET).
  1. Barras 13:00-15:59 ET: existen, cuantas, volumen y participacion.
  2. Inicio/fin del after-hours ese dia (premarket y post-cierre).
  3. Huecos intradia del mismo dia ET (diff > 60 s entre consecutivas).
  4. Diaria oficial vs suma de 1m por fases.
  5. Caso numerico de contaminacion de sessionVwap (precio TRADE_VWAP:
     vw si finito>0, si no (h+l+c)/3) y rastreos rthOnly/detectGaps.

Uso:
  python tools/probe_early_close.py 2025-11-28 [--out fixtures/samples]
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
SECONDS_PER_MINUTE = 60
RTH_START_MINUTE = 9 * 60 + 30  # 09:30 ET
RTH_END_MINUTE = 16 * 60        # 16:00 ET
EARLY_WINDOW_START = 13 * 60    # 13:00 ET
DAY_END_MINUTE = 20 * 60        # 20:00 ET
PREMARKET_START_MINUTE = 4 * 60  # 04:00 ET


def say(message: str) -> None:
    print(message)


def et_minute(ts_seconds: float) -> int:
    """Minuto del dia ET de un instante en segundos UTC."""
    dt = datetime.fromtimestamp(ts_seconds, tz=timezone.utc).astimezone(ET)
    return dt.hour * 60 + dt.minute


def et_clock(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def et_date_str(ts_seconds: float) -> str:
    return datetime.fromtimestamp(ts_seconds, tz=timezone.utc).astimezone(ET).date().isoformat()


def load_one_m_rows(path: Path, day_iso: str) -> list[dict[str, float | None]]:
    """Lee las filas 1m del escenario day y las convierte a segundos UTC."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    scenario = payload.get("scenarios", {}).get("day")
    if not isinstance(scenario, dict):
        raise SystemExit(f"ERROR: {path} no tiene scenarios.day")
    rows: list[dict[str, float | None]] = []
    for page in scenario.get("pages", []):
        body = page.get("body") or {}
        results = body.get("results")
        if not isinstance(results, list):
            continue
        for row in results:
            t_ms = row.get("t")
            if not isinstance(t_ms, (int, float)):
                continue
            if t_ms % 1_000 != 0:
                raise SystemExit(f"ERROR: t no es multiple de 1000 ms: {t_ms!r}")
            rows.append(
                {
                    "time": t_ms // 1_000,
                    "open": _num(row.get("o")),
                    "high": _num(row.get("h")),
                    "low": _num(row.get("l")),
                    "close": _num(row.get("c")),
                    "volume": _num(row.get("v")),
                    "vw": _num(row.get("vw")),
                    "trades": _num(row.get("n")),
                }
            )
    rows.sort(key=lambda r: r["time"])
    off_day = [r for r in rows if et_date_str(r["time"]) != day_iso]
    if off_day:
        say(f"AVISO: {len(off_day)} filas 1m fuera del dia {day_iso} (se ignoran)")
        rows = [r for r in rows if et_date_str(r["time"]) == day_iso]
    return rows


def load_daily_row(path: Path, day_iso: str) -> dict[str, float | None] | None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    scenario = payload.get("scenarios", {}).get("day")
    if not isinstance(scenario, dict):
        raise SystemExit(f"ERROR: {path} no tiene scenarios.day")
    for page in scenario.get("pages", []):
        body = page.get("body") or {}
        for row in body.get("results") or []:
            t_ms = row.get("t")
            if not isinstance(t_ms, (int, float)):
                continue
            # Barras diarias Massive: t es el inicio del dia en ms UTC; la
            # fecha ET de ese inicio debe coincidir con el dia pedido.
            if et_date_str(t_ms / 1_000) == day_iso:
                return {
                    "open": _num(row.get("o")),
                    "high": _num(row.get("h")),
                    "low": _num(row.get("l")),
                    "close": _num(row.get("c")),
                    "volume": _num(row.get("v")),
                    "vw": _num(row.get("vw")),
                    "trades": _num(row.get("n")),
                }
    return None


def _num(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def bar_price(bar: dict[str, float | None]) -> float | None:
    """TRADE_VWAP: vw si es finito y > 0; si no, (h+l+c)/3 (SPEC punto 4)."""
    vw = bar.get("vw")
    if vw is not None and math.isfinite(vw) and vw > 0:
        return vw
    high, low, close = bar.get("high"), bar.get("low"), bar.get("close")
    if None in (high, low, close):
        return None
    return (high + low + close) / 3.0


def detect_regular_close_minute(bars: list[dict[str, float | None]]) -> tuple[int, float, float]:
    """Minuto de cierre regular DETECTADO desde los datos.

    Escala de sesion = mediana del volumen de la primera hora regular
    (09:30-10:29). El cierre detectado es el ultimo minuto c de
    [10:00, 15:59] con barra y volumen >= 0.3 x escala, tal que el minimo
    de volumen de los 10 minutos siguientes CON barra queda por debajo de
    0.05 x escala (tramo persistente de volumen bajo). Devuelve
    (minuto_cierre_detectado = c + 1, volumen de c, umbral).
    """
    regular = [b for b in bars if RTH_START_MINUTE <= et_minute(b["time"]) < RTH_END_MINUTE]
    first_hour = [
        b["volume"]
        for b in regular
        if b["volume"] is not None
        and RTH_START_MINUTE <= et_minute(b["time"]) < RTH_START_MINUTE + 60
        and b["volume"] > 0
    ]
    if not first_hour:
        raise SystemExit("ERROR: sin barras con volumen en 09:30-10:29")
    session_scale = float(statistics.median(first_hour))
    low_threshold = 0.05 * session_scale

    by_minute: dict[int, float] = {}
    for b in regular:
        if b["volume"] is None:
            continue
        by_minute[et_minute(b["time"])] = b["volume"]

    candidates = sorted(
        m for m, v in by_minute.items() if 10 * 60 <= m < RTH_END_MINUTE and v >= 0.3 * session_scale
    )
    detected = None
    detected_volume = 0.0
    for c in reversed(candidates):
        window_end = min(c + 11, RTH_END_MINUTE)
        following = [v for m, v in by_minute.items() if c < m < window_end]
        if not following:
            # Sin barras en el resto de la ventana regular: silencio total
            # tras c. Vale tanto para un dia normal (c=15:59) como para un
            # cierre anticipado sin barras 13:00-15:59 (c=12:59).
            detected = c
            detected_volume = by_minute[c]
            break
        if min(following) < low_threshold:
            detected = c
            detected_volume = by_minute[c]
            break
    if detected is None:
        raise SystemExit("ERROR: no se detecto un corte de volumen persistente en [10:00,16:00)")
    return detected + 1, detected_volume, session_scale


def minute_profile(
    bars: list[dict[str, float | None]], start: int, end: int
) -> list[tuple[int, float | None]]:
    """Perfil (minuto, volumen) para minutos con barra en [start, end)."""
    profile = [
        (et_minute(b["time"]), b["volume"]) for b in bars if start <= et_minute(b["time"]) < end
    ]
    return sorted(profile)


def find_gaps(bars: list[dict[str, float | None]]) -> list[tuple[int, int, int]]:
    """Huecos del mismo dia ET entre barras consecutivas: (inicio_falta, fin_exclusivo, faltantes).

    Igual que la regla del cargador: pares consecutivos, mismo dia ET,
    diff > 60 s; faltantes = floor((diff - 1) / 60).
    """
    gaps: list[tuple[int, int, int]] = []
    for prev, curr in zip(bars, bars[1:]):
        prev_minute = et_minute(prev["time"])
        curr_minute = et_minute(curr["time"])
        diff = curr["time"] - prev["time"]
        if diff <= SECONDS_PER_MINUTE:
            continue
        if curr_minute <= prev_minute:
            # Cruce de medianoche ET no deberia ocurrir dentro de un dia.
            continue
        missing = int((diff - 1) // SECONDS_PER_MINUTE)
        gaps.append((prev_minute + 1, curr_minute, missing))
    return gaps


def phase_of(minute: int, close_minute: int) -> str:
    if minute < RTH_START_MINUTE:
        return "premarket"
    if minute < close_minute:
        return "sesion"
    if minute < RTH_END_MINUTE:
        return "post-cierre(13-16)"
    return "post-16:00"


def aggregate(bars: list[dict[str, float | None]]) -> dict[str, float | None]:
    if not bars:
        return {"bars": 0, "volume": 0.0, "open": None, "high": None, "low": None, "close": None}
    prices = [(b["open"], b["high"], b["low"], b["close"]) for b in bars]
    opens = [p[0] for p in prices if p[0] is not None]
    highs = [p[1] for p in prices if p[1] is not None]
    lows = [p[2] for p in prices if p[2] is not None]
    closes = [p[3] for p in prices if p[3] is not None]
    volumes = [b["volume"] for b in bars if b["volume"] is not None]
    return {
        "bars": len(bars),
        "volume": float(sum(volumes)) if volumes else 0.0,
        "open": opens[0] if opens else None,
        "high": max(highs) if highs else None,
        "low": min(lows) if lows else None,
        "close": closes[-1] if closes else None,
    }


def session_vwap(bars: list[dict[str, float | None]]) -> tuple[float, float]:
    """Acumulacion Welford-equivalente por suma ponderada: (cumV, vwap)."""
    cum_volume = 0.0
    cum_weighted = 0.0
    for bar in bars:
        volume = bar.get("volume")
        price = bar_price(bar)
        if volume is None or price is None or not math.isfinite(volume) or volume <= 0:
            continue
        cum_volume += volume
        cum_weighted += price * volume
    if cum_volume == 0.0:
        return 0.0, math.nan
    return cum_volume, cum_weighted / cum_volume


def _neighboring_dailies(
    path: Path, day_iso: str
) -> list[tuple[str, float]]:
    """Filas diarias vecinas (misma respuesta 1D) como contexto de volumen."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    scenario = payload.get("scenarios", {}).get("day")
    if not isinstance(scenario, dict):
        return []
    rows: list[tuple[str, float]] = []
    for page in scenario.get("pages", []):
        body = page.get("body") or {}
        for row in body.get("results") or []:
            t_ms = row.get("t")
            v = _num(row.get("v"))
            if isinstance(t_ms, (int, float)) and v is not None:
                rows.append((et_date_str(t_ms / 1_000), v))
    rows.sort()
    try:
        index = [d for d, _ in rows].index(day_iso)
    except ValueError:
        return []
    return rows[max(0, index - 4) : index + 2]


def main() -> int:
    args = sys.argv[1:]
    if not args:
        say("uso: python tools/probe_early_close.py <YYYY-MM-DD> [--out DIR]")
        return 2
    day_iso = args[0]
    out_dir = Path(args[args.index("--out") + 1]) if "--out" in args else Path("fixtures/samples")
    day = date.fromisoformat(day_iso)
    if day.weekday() >= 5:
        say(f"AVISO: {day_iso} es fin de semana en ET")

    one_m_path = out_dir / f"SPY_1m_{day_iso}.json"
    daily_path = out_dir / f"SPY_1D_{day_iso}.json"
    bars = load_one_m_rows(one_m_path, day_iso)
    daily = load_daily_row(daily_path, day_iso)

    say(f"== SPY {day_iso}: {len(bars)} barras 1m (escenario day) ==")
    if bars:
        first_m = et_minute(bars[0]["time"])
        last_m = et_minute(bars[-1]["time"])
        say(
            f"primera barra {et_clock(first_m)} ET, ultima barra {et_clock(last_m)} ET"
        )
    zero_volume = sum(1 for b in bars if b["volume"] == 0.0)
    no_vw = sum(1 for b in bars if b["vw"] is None)
    say(f"barras con v=0: {zero_volume}; barras sin vw: {no_vw}")

    close_minute, close_volume, session_scale = detect_regular_close_minute(bars)
    say("")
    say("-- Verificacion del cierre regular desde los datos --")
    say(
        f"escala de sesion (mediana v 09:30-10:29): {session_scale:,.0f}"
    )
    say(
        f"ultima barra con v >= 0.3xescala en [10:00,16:00): {et_clock(close_minute - 1)} "
        f"(v={close_volume:,.0f}); los 10 minutos siguientes quedan < 0.05xescala"
    )
    profile_start = max(RTH_START_MINUTE, close_minute - 15)
    profile_end = min(RTH_END_MINUTE, close_minute + 15)
    say(f"perfil de volumen {et_clock(profile_start)}-{et_clock(profile_end - 1)} ET:")
    for minute, volume in minute_profile(bars, profile_start, profile_end):
        say(f"  {et_clock(minute)}  v={volume if volume is not None else 'NaN':>12}")
    say(f"CIERRE REGULAR DETECTADO: {et_clock(close_minute)} ET")

    say("")
    say("-- (1) Barras 13:00-15:59 ET --")
    early = [b for b in bars if EARLY_WINDOW_START <= et_minute(b["time"]) < RTH_END_MINUTE]
    day_volume = sum(b["volume"] or 0.0 for b in bars)
    early_volume = sum(b["volume"] or 0.0 for b in early)
    say(
        f"presentes: {len(early)} de {RTH_END_MINUTE - EARLY_WINDOW_START} minutos; "
        f"volumen total {early_volume:,.0f}"
    )
    if day_volume > 0:
        say(f"participacion en el volumen del dia: {100 * early_volume / day_volume:.2f}%")
    for bar in early[:40]:
        minute = et_minute(bar["time"])
        say(
            f"  {et_clock(minute)} o={bar['open']} h={bar['high']} l={bar['low']} "
            f"c={bar['close']} v={bar['volume']} vw={bar['vw']}"
        )
    if len(early) > 40:
        say(f"  ... y {len(early) - 40} barras mas (listado truncado a 40)")

    say("")
    say("-- (2) After-hours ese dia --")
    pre = [b for b in bars if et_minute(b["time"]) < RTH_START_MINUTE]
    post_early = [b for b in bars if close_minute <= et_minute(b["time"]) < RTH_END_MINUTE]
    post_16 = [b for b in bars if RTH_END_MINUTE <= et_minute(b["time"]) < DAY_END_MINUTE]
    if pre:
        say(
            f"premarket: primera {et_clock(et_minute(pre[0]['time']))}, "
            f"ultima {et_clock(et_minute(pre[-1]['time']))}, {len(pre)} barras"
        )
    else:
        say("premarket: sin barras")
    if post_early or post_16:
        first_post = (post_early or post_16)[0]
        last_post = (post_16 or post_early)[-1]
        say(
            f"post-cierre: primera {et_clock(et_minute(first_post['time']))}, "
            f"ultima {et_clock(et_minute(last_post['time']))}"
        )
        say(
            f"  tramo entre el cierre y las 16:00 "
            f"({et_clock(close_minute)}-15:59): {len(post_early)} barras; "
            f"tramo 16:00-19:59: {len(post_16)} barras"
        )
    else:
        say("post-cierre: sin barras")

    say("")
    say("-- (3) Huecos intradia (mismo dia ET, diff > 60 s) --")
    gaps = find_gaps(bars)
    slots = DAY_END_MINUTE - PREMARKET_START_MINUTE
    missing_by_phase: dict[str, int] = {
        "premarket": 0,
        "sesion": 0,
        "post-cierre(13-16)": 0,
        "post-16:00": 0,
    }
    covered = {et_minute(b["time"]) for b in bars}
    for minute in range(PREMARKET_START_MINUTE, DAY_END_MINUTE):
        if minute not in covered:
            missing_by_phase[phase_of(minute, close_minute)] += 1
    say(f"slots del dia {et_clock(PREMARKET_START_MINUTE)}-19:59: {slots}; con barra: {len(covered)}")
    for phase, missing in missing_by_phase.items():
        say(f"  minutos sin barra en {phase}: {missing}")
    say(f"pares consecutivos con hueco: {len(gaps)}")
    in_session_gaps = [g for g in gaps if g[0] >= RTH_START_MINUTE and g[1] <= RTH_END_MINUTE]
    say(f"huecos dentro de 09:30-16:00 (los que detectGaps reportaria): {len(in_session_gaps)}")
    for start, end, missing in in_session_gaps:
        say(f"  {et_clock(start)} -> {et_clock(end)} ({missing} min sin barra)")

    say("")
    say("-- (4) Diaria oficial vs suma 1m por fases --")
    if daily is None:
        say(f"la respuesta 1D NO contiene la fila del {day_iso}")
        daily = None
    else:
        say(
            f"diaria oficial: o={daily['open']} h={daily['high']} l={daily['low']} "
            f"c={daily['close']} v={daily['volume']} n={daily['trades']}"
        )
    phases: dict[str, list[dict[str, float | None]]] = {
        "premarket": [],
        "sesion": [],
        "post-cierre(13-16)": [],
        "post-16:00": [],
    }
    for bar in bars:
        phases[phase_of(et_minute(bar["time"]), close_minute)].append(bar)
    one_m_total = 0.0
    one_m_trades = 0.0
    for name, phase_bars in phases.items():
        agg = aggregate(phase_bars)
        one_m_total += agg["volume"]
        phase_trades = sum(b["trades"] or 0.0 for b in phase_bars)
        one_m_trades += phase_trades
        say(
            f"  {name}: {agg['bars']} barras, v={agg['volume']:,.0f}, n={phase_trades:,.0f}, "
            f"o={agg['open']}, h={agg['high']}, l={agg['low']}, c={agg['close']}"
        )
    if daily is not None and daily["volume"] is not None:
        say(f"suma 1m total: v={one_m_total:,.0f}, n={one_m_trades:,.0f}")
        say(f"diaria: v={daily['volume']:,.0f}, n={daily['trades']}")
        delta_v = one_m_total - daily["volume"]
        say(f"delta v (suma 1m - diaria): {delta_v:,.0f} ({100 * delta_v / daily['volume']:+.4f}%)")
        if daily["trades"] is not None:
            delta_n = one_m_trades - daily["trades"]
            say(f"delta n (suma 1m - diaria): {delta_n:,.0f}")
        sesion_v = phases["sesion"]
        sesion_sum = sum(b["volume"] or 0.0 for b in sesion_v)
        say(f"diaria v - suma 1m sesion: {daily['volume'] - sesion_sum:,.0f}")
        say(f"diaria v - suma 1m total:  {daily['volume'] - one_m_total:,.0f}")
        biggest = sorted(
            bars, key=lambda b: b["volume"] or 0.0, reverse=True
        )[:10]
        say("10 mayores barras 1m del dia (minuto ET, v, n):")
        for bar in biggest:
            say(
                f"  {et_clock(et_minute(bar['time']))} v={bar['volume']:,.0f} "
                f"n={bar['trades'] if bar['trades'] is not None else 'NaN'}"
            )
        vecinos = _neighboring_dailies(daily_path, day_iso)
        if vecinos:
            say("contexto 1D (dias vecinos, fecha ET, v):")
            for d_iso, v_row in vecinos:
                say(f"  {d_iso}  v={v_row:,.0f}")

    say("")
    say("-- Caso numerico de contaminacion sessionVwap --")
    true_bars = [b for b in bars if RTH_START_MINUTE <= et_minute(b["time"]) < close_minute]
    cont_bars = [b for b in bars if RTH_START_MINUTE <= et_minute(b["time"]) < RTH_END_MINUTE]
    cum_true, vwap_true = session_vwap(true_bars)
    cum_cont, vwap_cont = session_vwap(cont_bars)
    say(
        f"sesion verdadera {et_clock(RTH_START_MINUTE)}-"
        f"{et_clock(close_minute - 1)}: cumV={cum_true:,.0f}, vwap={vwap_true:.6f}"
    )
    say(
        "con isRth incondicional (09:30-16:00): "
        f"cumV={cum_cont:,.0f}, vwap={vwap_cont:.6f}"
    )
    if not math.isnan(vwap_true) and not math.isnan(vwap_cont):
        delta_vwap = vwap_cont - vwap_true
        delta_pct = 100 * delta_vwap / vwap_true if vwap_true else math.nan
        say(
            f"delta vwap: {delta_vwap:+.6f} ({delta_pct:+.4f}%); "
            f"volumen inflado: {cum_cont - cum_true:,.0f}"
            f" ({100 * (cum_cont - cum_true) / cum_true if cum_true else math.nan:+.4f}%)"
        )
    extra = cont_bars[len(true_bars):] if len(cont_bars) > len(true_bars) else []
    say(f"barras que el core contaria como RTH y no son de sesion: {len(extra)}")
    # Variante: sesion continua SIN el remate (hasta close-1) vs core (con remate).
    sin_remate = [b for b in bars if RTH_START_MINUTE <= et_minute(b["time"]) < close_minute - 1]
    cum_sr, vwap_sr = session_vwap(sin_remate)
    if not math.isnan(vwap_sr) and not math.isnan(vwap_cont):
        say(
            f"variante sin la barra del remate ({et_clock(close_minute - 1)} excluida): "
            f"cumV={cum_sr:,.0f}, vwap={vwap_sr:.6f}; "
            f"delta del core vs sin remate: {vwap_cont - vwap_sr:+.6f} "
            f"({100 * (vwap_cont - vwap_sr) / vwap_sr if vwap_sr else math.nan:+.4f}%)"
        )

    say("")
    say("-- Rastreo rthOnly y detectGaps --")
    say(
        f"rthOnly: {len(cont_bars)} barras candidatas RTH (de las cuales "
        f"{len(extra)} son 13:00-15:59)"
    )
    say(
        "detectGaps: los huecos listados arriba dentro de 09:30-16:00 son del "
        "mismo dia ET y SI se reportarian (no se salta el par por cambio de fecha)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
