#!/usr/bin/env python3
"""
tools/analyze_samples.py

Analisis OFFLINE de las muestras crudas guardadas en fixtures/samples
(solo acciones US: SPY_*.json; descarta BTC-USDT y el modo live). No toca la
red y nunca lee claves: los fixtures ya estan sanitizados.

Subcomandos:
  vw-excess  Magnitud del vw fuera de rango por temporalidad y escenario:
             exceso = max(low - vw, vw - high, 0) / vw; conteos > 0, > 0.1%,
             > 0.5%, > 2%; max, p50, p99; top-10 con hora ET.
  ohlc-check Violaciones open/close fuera de [low, high] (candidatas a
              invalidOhlc) y estadisticas de desviacion de vw, por temporalidad
              y escenario, deduplicadas por tf+t.
  warmup     Barras por dia por temporalidad (extendido y RTH) y dias de
             calendario para 500 visibles + 1000 de calentamiento, con factor
             de fin de semana (5/7) y feriados (~251 sesiones/365.25 dias).

Uso:
  python tools/analyze_samples.py vw-excess
  python tools/analyze_samples.py warmup
  python tools/analyze_samples.py warmup --visible 500 --warmup 1000
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

UTC = ZoneInfo("UTC")
NEW_YORK = ZoneInfo("America/New_York")

# Escenarios de captura con barras agregadas (el modo "live" usa "rounds").
SCENARIOS = ("day", "range", "max", "latest")

# Constantes del cargador (loader.ts, solo lectura) para comparar en warmup.
LOADER_BARS_PER_DAY_EXTENDED = {"1m": 960, "5m": 192, "15m": 64, "1h": 16, "4h": 4, "1D": 1}
LOADER_BARS_PER_DAY_RTH = {"1m": 390, "5m": 78, "15m": 26, "1h": 6, "4h": 1}

# Sesion extendida observada en Massive para SPY: 04:00-19:59 ET.
RTH_START_MIN = 9 * 60 + 30  # 09:30 ET
RTH_END_MIN = 16 * 60  # 16:00 ET exclusivo


def et_minutes(ms: int) -> int:
    """Minuto del dia ET de un t en ms."""
    dt = datetime.fromtimestamp(ms / 1000.0, tz=UTC).astimezone(NEW_YORK)
    return dt.hour * 60 + dt.minute


def et_str(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC).astimezone(NEW_YORK).strftime(
        "%Y-%m-%d %H:%M:%S ET"
    )


def et_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC).astimezone(NEW_YORK).date().isoformat()


def percentile(sorted_vals: list[float], p: float) -> float:
    """Percentil con interpolacion lineal (definicion estandar, explicita)."""
    n = len(sorted_vals)
    if n == 0:
        return float("nan")
    if n == 1:
        return sorted_vals[0]
    idx = p * (n - 1)
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def self_check() -> None:
    """Comprobaciones con valores calculados a mano (formula y percentil)."""
    # exceso = max(low - vw, vw - high, 0) / vw
    assert max(100.0 - 101.0, 101.0 - 102.0, 0.0) / 101.0 == 0.0  # vw dentro de [low, high]
    assert max(99.0 - 100.0, 100.0 - 101.0, 0.0) / 100.0 == 0.0  # vw dentro
    assert max(98.0 - 100.0, 100.0 - 99.0, 0.0) / 100.0 == 0.01  # low < vw-1 -> 1%
    assert max(100.0 - 100.0, 100.0 - 98.0, 0.0) / 100.0 == 0.02  # high < vw -> 2%
    vals = [float(x) for x in range(1, 6)]  # 1..5
    assert percentile(vals, 0.5) == 3.0
    assert percentile(vals, 0.0) == 1.0 and percentile(vals, 1.0) == 5.0
    assert percentile(vals, 0.99) == 4.96  # idx = 0.99*4 = 3.96 -> 4 + 0.96*(5-4)
    assert percentile([2.0, 4.0], 0.5) == 3.0  # idx = 0.5 -> interpolado
    assert et_minutes(1793975400000) == 9 * 60 + 30  # 2026-11-06 09:30 ET
    assert et_date(1793975400000) == "2026-11-06"
    # open/close dentro de [low, high]: sin violacion; fuera: causa exacta.
    assert ohlc_violation({"o": 100.0, "h": 101.0, "l": 99.0, "c": 100.5}) is None
    assert ohlc_violation({"o": 100.0, "h": 101.0, "l": 100.0, "c": 101.0}) is None  # bordes ok
    assert ohlc_violation({"o": 98.0, "h": 101.0, "l": 99.0, "c": 100.0}) == "open<low"
    assert ohlc_violation({"o": 102.0, "h": 101.0, "l": 99.0, "c": 100.0}) == "open>high"
    assert ohlc_violation({"o": 100.0, "h": 101.0, "l": 99.0, "c": 98.0}) == "close<low"
    assert ohlc_violation({"o": 100.0, "h": 101.0, "l": 99.0, "c": 102.0}) == "close>high"


def iter_sample_files(samples_dir: Path) -> list[Path]:
    files = sorted(samples_dir.glob("SPY_*.json"))
    return [p for p in files if "_live_" not in p.name]


def load_bars(samples_dir: Path) -> dict[str, dict[str, list[dict]]]:
    """{timeframe: {escenario: [barras crudas del proveedor]}}."""
    out: dict[str, dict[str, list[dict]]] = {}
    for path in iter_sample_files(samples_dir):
        data = json.loads(path.read_text(encoding="utf-8"))
        tf = data.get("timeframe") or path.stem.split("_")[1]
        for kind in SCENARIOS:
            scen = (data.get("scenarios") or {}).get(kind)
            if not scen or "error" in scen:
                continue
            bars: list[dict] = []
            for page in scen.get("pages") or []:
                body = page.get("body") or {}
                bars.extend(body.get("results") or [])
            if bars:
                out.setdefault(tf, {})[kind] = bars
    return out


def cmd_vw_excess(samples_dir: Path) -> int:
    bars_by_tf = load_bars(samples_dir)
    order = ["1m", "5m", "15m", "30m", "1h", "4h", "1D"]
    top_all: list[tuple[float, str, int, str]] = []  # (exceso, tf, t, escenario)
    seen: set[tuple[str, int]] = set()

    print("EXCESO DE vw FUERA DE RANGO: exceso = max(low - vw, vw - high, 0) / vw")
    print("Umbrales: >0, >0.1%, >0.5%, >2%   (sin red; muestras SPY_*.json)")
    print()
    for tf in order:
        if tf not in bars_by_tf:
            continue
        print(f"--- SPY {tf} ---")
        print(
            f"{'escenario':>9} {'barras':>7} {'con vw':>7} {'sin vw':>7} "
            f"{'>0':>7} {'>0.1%':>7} {'>0.5%':>7} {'>2%':>7} "
            f"{'vw<low':>7} {'vw>high':>8} "
            f"{'max':>10} {'p50':>10} {'p99':>10}"
        )
        for kind in SCENARIOS:
            bars = bars_by_tf[tf].get(kind)
            if not bars:
                continue
            excesses: list[float] = []
            no_vw = 0
            below_low = 0
            above_high = 0
            for r in bars:
                vw = r.get("vw")
                if vw is None or not isinstance(vw, (int, float)):
                    no_vw += 1
                    continue
                excess = max(r["l"] - vw, vw - r["h"], 0.0) / vw
                if r["l"] - vw > 0:
                    below_low += 1
                if vw - r["h"] > 0:
                    above_high += 1
                excesses.append(excess)
                key = (tf, r["t"])
                if key not in seen:
                    seen.add(key)
                    top_all.append((excess, tf, r["t"], kind))
            excesses.sort()
            n = len(excesses)
            gt = lambda thr: sum(1 for e in excesses if e > thr)  # noqa: E731
            if n:
                mx, p50, p99 = excesses[-1], percentile(excesses, 0.5), percentile(excesses, 0.99)
            else:
                mx = p50 = p99 = float("nan")
            print(
                f"{kind:>9} {len(bars):>7} {n:>7} {no_vw:>7} "
                f"{gt(0.0):>7} {gt(0.001):>7} {gt(0.005):>7} {gt(0.02):>7} "
                f"{below_low:>7} {above_high:>8} "
                f"{mx:>10.6f} {p50:>10.6f} {p99:>10.6f}"
            )
        print()

    top_all.sort(key=lambda x: (-x[0], x[1], x[2]))
    print("TOP 10 MAYOR EXCESO (sin duplicar por temporalidad+instante):")
    print(f"{'#':>2} {'exceso':>10} {'exceso%':>9} {'tf':>4} {'t (ms)':>14} {'hora ET':>21} escenario")
    for i, (excess, tf, t, kind) in enumerate(top_all[:10], 1):
        print(f"{i:>2} {excess:>10.6f} {excess * 100:>8.4f}% {tf:>4} {t:>14} {et_str(t):>21} {kind}")
    print()
    nan = sum(1 for e, *_ in top_all if math.isnan(e))
    print(f"barras candidatas al top (unicas por tf+t): {len(top_all)} (NaN: {nan})")
    return 0


def ohlc_violation(r: dict) -> str | None:
    """Descripcion de la violacion open/close fuera de [low, high], o None."""
    o, h, l, c = r["o"], r["h"], r["l"], r["c"]
    if o < l:
        return "open<low"
    if o > h:
        return "open>high"
    if c < l:
        return "close<low"
    if c > h:
        return "close>high"
    return None


def cmd_ohlc_check(samples_dir: Path) -> int:
    bars_by_tf = load_bars(samples_dir)
    order = ["1m", "5m", "15m", "30m", "1h", "4h", "1D"]
    bad_all: list[tuple[str, int, str, str]] = []  # (tf, t, escenario, causa)
    seen_bad: set[tuple[str, int]] = set()
    dev_seen: set[tuple[str, int]] = set()
    dev_max_all = 0.0
    dev_over2_all = 0

    print("VALIDACION OHLC: open y close deben estar dentro de [low, high]")
    print("DESVIACION vw: exceso = max(low - vw, vw - high, 0) / vw, en %")
    print("Umbrales desviacion: >2%   (sin red; muestras SPY_*.json)")
    print()
    for tf in order:
        if tf not in bars_by_tf:
            continue
        print(f"--- SPY {tf} ---")
        print(
            f"{'escenario':>9} {'barras':>7} {'violaciones':>11} "
            f"{'open<low':>9} {'open>high':>10} {'close<low':>10} {'close>high':>11} "
            f"{'desv.max%':>10} {'desv.>2%':>9}"
        )
        for kind in SCENARIOS:
            bars = bars_by_tf[tf].get(kind)
            if not bars:
                continue
            causes = {"open<low": 0, "open>high": 0, "close<low": 0, "close>high": 0}
            violations = 0
            dev_max = 0.0
            dev_over2 = 0
            for r in bars:
                cause = ohlc_violation(r)
                if cause is not None:
                    violations += 1
                    causes[cause] += 1
                    key = (tf, r["t"])
                    if key not in seen_bad:
                        seen_bad.add(key)
                        bad_all.append((tf, r["t"], kind, cause))
                vw = r.get("vw")
                if vw is None or not isinstance(vw, (int, float)) or vw <= 0:
                    continue
                dev_pct = max(r["l"] - vw, vw - r["h"], 0.0) / vw * 100.0
                if dev_pct > dev_max:
                    dev_max = dev_pct
                if dev_pct > 2.0:
                    dev_over2 += 1
                    key = (tf, r["t"])
                    if key not in dev_seen:
                        dev_seen.add(key)
                        dev_over2_all += 1
                if dev_pct > dev_max_all:
                    dev_max_all = dev_pct
            print(
                f"{kind:>9} {len(bars):>7} {violations:>11} "
                f"{causes['open<low']:>9} {causes['open>high']:>10} "
                f"{causes['close<low']:>10} {causes['close>high']:>11} "
                f"{dev_max:>10.4f} {dev_over2:>9}"
            )
        print()

    print("RESUMEN GLOBAL (unicas por tf+t):")
    print(f"  violaciones open/close: {len(bad_all)}")
    print(f"  barras con desviacion vw > 2%: {dev_over2_all}")
    print(f"  desviacion vw maxima: {dev_max_all:.4f}%")
    if bad_all:
        print()
        print("DETALLE DE VIOLACIONES:")
        print(f"{'tf':>4} {'t (ms)':>14} {'hora ET':>21} {'escenario':>9} causa")
        for tf, t, kind, cause in bad_all:
            print(f"{tf:>4} {t:>14} {et_str(t):>21} {kind:>9} {cause}")
    return 0


def day_counts(bars: list[dict]) -> tuple[int, int]:
    """Barras del dia completo (extendido) y dentro de RTH por minuto ET."""
    ext = len(bars)
    rth = sum(1 for r in bars if RTH_START_MIN <= et_minutes(r["t"]) < RTH_END_MIN)
    return ext, rth


def cmd_warmup(samples_dir: Path, visible: int, warmup: int) -> int:
    bars_by_tf = load_bars(samples_dir)
    order = ["1m", "5m", "15m", "30m", "1h", "4h", "1D"]
    needed = visible + warmup
    print(f"CALENTAMIENTO: objetivo {visible} visibles + {warmup} de calentamiento = {needed} barras")
    print("Factor calendario: 5 sesiones/7 dias (fin de semana) y ~251 sesiones/365.25 dias (feriados US)")
    print("  dias_calendario = ceil(dias_de_bolsa * 365.25 / 251), dias_de_bolsa = ceil(needed / barras_por_dia)")
    print()
    print(f"{'tf':>4} | {'day: ext':>8} {'RTH':>6} | {'range: dias':>11} {'mediana ext':>11} {'mediana RTH':>11} | "
          f"{'cal ext':>8} {'cal RTH':>8}")
    for tf in order:
        if tf not in bars_by_tf:
            continue
        ext_day = rth_day = None
        if "day" in bars_by_tf[tf]:
            day_bars = bars_by_tf[tf]["day"]
            # El recuento instantaneo solo es barras/dia si el escenario cubre
            # UNA fecha ET (en 1D devuelve N dias: se usa la mediana).
            if len({et_date(r["t"]) for r in day_bars}) == 1:
                ext_day, rth_day = day_counts(day_bars)
        per_date_ext: dict[str, int] = {}
        per_date_rth: dict[str, int] = {}
        seen_t: set[int] = set()
        for kind in ("range", "max"):
            for r in bars_by_tf[tf].get(kind) or []:
                if r["t"] in seen_t:  # range y max pueden solaparse (1D)
                    continue
                seen_t.add(r["t"])
                d = et_date(r["t"])
                per_date_ext[d] = per_date_ext.get(d, 0) + 1
                if RTH_START_MIN <= et_minutes(r["t"]) < RTH_END_MIN:
                    per_date_rth[d] = per_date_rth.get(d, 0) + 1
        # Las fechas del primer y ultimo dia de cada ventana pueden estar
        # parciales; la mediana usa solo dias completos observados (>= mediana
        # global para no sesgar a la baja). Se reporta tambien el maximo.
        def median_complete(per_date: dict[str, int]) -> tuple[int, int, int]:
            if not per_date:
                return 0, 0, 0
            counts = sorted(per_date.values())
            mx = counts[-1]
            complete = [c for c in counts if c >= mx * 0.9]  # dias completos: >=90% del maximo
            return percentile([float(c) for c in complete], 0.5), min(complete), mx

        med_ext, mn_ext, mx_ext = median_complete(per_date_ext)
        med_rth, mn_rth, mx_rth = median_complete(per_date_rth)

        def calendar(bpd: int | None) -> str:
            if not bpd or bpd <= 0:
                return "-"
            trading = math.ceil(needed / bpd)
            return str(math.ceil(trading * 365.25 / 251))

        cal_ext = calendar(ext_day if ext_day else (int(med_ext) or None))
        cal_rth = calendar(rth_day if rth_day else (int(med_rth) or None))
        ndates = len(per_date_ext)
        print(
            f"{tf:>4} | {ext_day if ext_day is not None else '-':>8} {rth_day if rth_day is not None else '-':>6} | "
            f"{ndates:>11} {med_ext:>11.1f} {med_rth:>11.1f} | {cal_ext:>8} {cal_rth:>8}"
        )
        if per_date_ext and tf != "1D":
            print(
                f"     dias ext min/max completos: {mn_ext}/{mx_ext} | RTH min/max: {mn_rth}/{mx_rth}"
            )
    print()
    print("Estimacion del cargador (loader.ts, solo lectura) para comparar:")
    print("  extendido:", json.dumps(LOADER_BARS_PER_DAY_EXTENDED, sort_keys=False))
    print("  RTH      :", json.dumps(LOADER_BARS_PER_DAY_RTH, sort_keys=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analisis offline de muestras Massive (SPY).")
    parser.add_argument("command", choices=("vw-excess", "ohlc-check", "warmup"))
    parser.add_argument("--dir", default="fixtures/samples", help="Directorio de muestras.")
    parser.add_argument("--visible", type=int, default=500, help="Barras visibles (SPEC: 500).")
    parser.add_argument("--warmup", type=int, default=1000, help="Barras de calentamiento (SPEC: 1000).")
    args = parser.parse_args(argv)
    self_check()
    samples_dir = Path(args.dir)
    if args.command == "vw-excess":
        return cmd_vw_excess(samples_dir)
    if args.command == "ohlc-check":
        return cmd_ohlc_check(samples_dir)
    return cmd_warmup(samples_dir, args.visible, args.warmup)


if __name__ == "__main__":
    sys.exit(main())
