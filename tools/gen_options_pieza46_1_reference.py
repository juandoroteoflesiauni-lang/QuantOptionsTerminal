#!/usr/bin/env python3
"""Referencia independiente Pieza 46.1 (0DTE, escala ORATS, griegas ITM, densidad BL).

Implementacion explicita en Python puro (math.erf, sin numpy/scipy y sin copiar la logica TS).
Genera fixtures/options_pieza46_1_reference.json.
"""
import json
import math
import os
from datetime import date, datetime, timedelta, timezone

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures", "options_pieza46_1_reference.json")


def ncdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def npdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm(side, s, k, t, r, q, sig):
    sq = math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sig * sig) * t) / (sig * sq)
    d2 = d1 - sig * sq
    eq, er = math.exp(-q * t), math.exp(-r * t)
    if side == "call":
        price = s * eq * ncdf(d1) - k * er * ncdf(d2)
        delta = eq * ncdf(d1)
        theta = -s * eq * npdf(d1) * sig / (2 * sq) - r * k * er * ncdf(d2) + q * s * eq * ncdf(d1)
    else:
        price = k * er * ncdf(-d2) - s * eq * ncdf(-d1)
        delta = -eq * ncdf(-d1)
        theta = -s * eq * npdf(d1) * sig / (2 * sq) + r * k * er * ncdf(-d2) - q * s * eq * ncdf(-d1)
    gamma = eq * npdf(d1) / (s * sig * sq)
    vega = s * eq * npdf(d1) * sq
    return price, delta, gamma, vega, theta


# ---- 1. escala ORATS ----
def orats_norm(v):
    if v is None or math.isnan(v) or v < 0:
        return None
    return v / 100.0 if v >= 5.0 else v


# ---- 2. griegas fallback ----
def intrinsic(side, s, k):
    return max(0.0, s - k) if side == "call" else max(0.0, k - s)


def unreliable(iv, ext):
    if iv is None or math.isnan(iv) or iv >= 9.99:
        return True
    return (not math.isnan(ext)) and ext <= 0.01


def fallback_greeks(c):
    side, s, k, t = c["side"], c["spot"], c["strike"], c["t"]
    iv = c["contractIv"]
    ivr = float("nan") if iv is None else iv
    ext = c["extrinsic"]
    un = unreliable(ivr, ext)
    if ext <= 0.01 and intrinsic(side, s, k) > 0:
        return {"iv": None, "delta": 1.0 if side == "call" else -1.0, "gamma": 0.0, "vega": 0.0,
                "theta": 0.0, "source": "DEEP_ITM_INTRINSIC"}
    vol = c["ivAtm"] if un else ivr
    _, d, g, v, th = bsm(side, s, k, t, c["rate"], c["q"], vol)
    return {"iv": None if un else ivr, "delta": d, "gamma": g, "vega": v, "theta": th,
            "source": "ATM_FALLBACK" if un else "CONTRACT_IV"}


# ---- 3. anualizacion ----
def annualize(ret, dte):
    if dte < 3:
        return None, "BLOCKED_SHORT_DTE"
    return (1.0 + ret) ** (365.0 / dte) - 1.0, "OK"


# ---- 4. ET ----
def nth_sunday(year, month, n):
    d = date(year, month, 1)
    first = (6 - d.weekday()) % 7
    return d + timedelta(days=first + 7 * (n - 1))


def et_local(ts_utc):
    y = ts_utc.year
    # DST: 2do domingo de marzo 02:00 local (07:00 UTC) a 1er domingo de nov 02:00 local (06:00 UTC)
    start = datetime.combine(nth_sunday(y, 3, 2), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=7)
    end = datetime.combine(nth_sunday(y, 11, 1), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=6)
    off = -4 if start <= ts_utc < end else -5
    return ts_utc + timedelta(hours=off)


def breaker(dte, spot, put_wall, net_gex):
    short_dte = dte <= 1
    sg = put_wall is not None and spot < put_wall and net_gex < 0
    return short_dte or sg


# ---- 5. sigma ----
def expected_move(spot, iv, t):
    return spot * iv * math.sqrt(max(t, 1.0 / (252 * 6.5)))


def nearest(strikes, target):
    best, bd = None, None
    for k in sorted(strikes):
        d = abs(k - target)
        if bd is None or d < bd - 1e-12:
            best, bd = k, d
    return best


# ---- 6. BL ----
def pchip_slopes(x, y):
    n = len(x)
    h = [x[i + 1] - x[i] for i in range(n - 1)]
    dl = [(y[i + 1] - y[i]) / h[i] for i in range(n - 1)]
    d = [0.0] * n
    for i in range(1, n - 1):
        if dl[i - 1] * dl[i] > 0:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            d[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i])

    def sgn(v):
        return (v > 0) - (v < 0)

    def end(h0, h1, d0, d1):
        v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
        if sgn(v) != sgn(d0):
            return 0.0
        if sgn(d0) != sgn(d1) and abs(v) > 3 * abs(d0):
            return 3 * d0
        return v

    d[0] = end(h[0], h[1], dl[0], dl[1])
    d[n - 1] = end(h[n - 2], h[n - 3], dl[n - 2], dl[n - 3])
    return d


def pchip(x, y, d, xv):
    i = 0
    while i < len(x) - 2 and xv > x[i + 1]:
        i += 1
    h = x[i + 1] - x[i]
    t = (xv - x[i]) / h
    return ((2 * t ** 3 - 3 * t ** 2 + 1) * y[i] + (t ** 3 - 2 * t ** 2 + t) * h * d[i]
            + (-2 * t ** 3 + 3 * t ** 2) * y[i + 1] + (t ** 3 - t ** 2) * h * d[i + 1])


def bl_density(c):
    s, r, q, t, dte, em = c["spot"], c["rate"], c["q"], c["t"], c["dte"], c["expectedMove"]
    max_sp = c.get("maxRelativeSpread", 0.5)
    frac = c.get("gridStepFraction", 0.05)
    clean = {}
    for n in c["nodes"]:
        iv, bid, ask = n["iv"], n["bid"], n.get("ask")
        if iv is None or iv <= 0 or iv >= 9.99 or n["strike"] <= 0 or bid <= 0:
            continue
        if ask is not None:
            if ask < bid or (ask - bid) / (0.5 * (bid + ask)) > max_sp:
                continue
        clean.setdefault(n["strike"], iv)
    ks_sorted = sorted(clean)
    f = s * math.exp((r - q) * t)
    ks = [math.log(k / f) for k in ks_sorted]
    ws = [clean[k] ** 2 * t for k in ks_sorted]
    d = pchip_slopes(ks, ws)
    k0, k1 = ks_sorted[0], ks_sorted[-1]
    step = max(em * frac, (k1 - k0) / 1999.0)
    count = int(math.floor((k1 - k0) / step + 1e-9)) + 1
    grid, calls = [], []
    for j in range(count):
        k = k0 + j * step
        w = max(1e-12, pchip(ks, ws, d, math.log(k / f)))
        calls.append(bsm("call", s, k, t, r, q, math.sqrt(w / t))[0])
        grid.append(k)
    g = math.exp(r * t)
    dens = [0.0] * count
    for j in range(1, count - 1):
        dens[j] = max(0.0, g * (calls[j - 1] - 2 * calls[j] + calls[j + 1]) / step ** 2)
    dens[0], dens[-1] = dens[1], dens[-2]
    if dte <= 1:
        old = dens[:]
        for j in range(1, count - 1):
            dens[j] = 0.25 * old[j - 1] + 0.5 * old[j] + 0.25 * old[j + 1]
    area = sum(0.5 * (dens[j] + dens[j + 1]) * step for j in range(count - 1))
    return {"usedNodes": len(ks_sorted), "step": step, "rawArea": area,
            "strikes": grid, "density": [v / area for v in dens]}


def breakevens(x, y):
    out = []
    for i in range(len(x)):
        if y[i] == 0:
            out.append(x[i])
        elif i + 1 < len(x) and y[i + 1] != 0 and y[i] * y[i + 1] < 0:
            out.append(x[i] + (0 - y[i]) * (x[i + 1] - x[i]) / (y[i + 1] - y[i]))
    return out


def hours_grid(start, step):
    top = math.floor(start / step + 1e-9) * step
    out = []
    if start - top > 1e-9:
        out.append(start)
    n = round(top / step)
    out.extend(i * step for i in range(n, -1, -1))
    return out


def main():
    fx = {}
    fx["oratsScale"] = [{"raw": v, "expected": orats_norm(v)} for v in [35.82, 0.3582, 4.99, 5.0, 120.0, 0.0]]

    gcases = [
        {"side": "put", "spot": 70.0, "strike": 80.0, "t": 0.08, "rate": 0.04, "q": 0.0,
         "contractIv": 9.99, "extrinsic": 0.0, "ivAtm": 0.42},
        {"side": "call", "spot": 100.0, "strike": 60.0, "t": 0.05, "rate": 0.04, "q": 0.01,
         "contractIv": None, "extrinsic": 0.005, "ivAtm": 0.30},
        {"side": "put", "spot": 100.0, "strike": 104.0, "t": 0.02, "rate": 0.04, "q": 0.0,
         "contractIv": 12.0, "extrinsic": 0.4, "ivAtm": 0.35},
        {"side": "call", "spot": 100.0, "strike": 105.0, "t": 0.1, "rate": 0.03, "q": 0.005,
         "contractIv": 0.28, "extrinsic": 1.9, "ivAtm": 0.30},
    ]
    fx["fallbackGreeks"] = [{"input": c, "expected": fallback_greeks(c)} for c in gcases]

    fx["annualize"] = []
    for ret, dte in [(0.01, 0), (0.01, 2), (0.01, 3), (0.02, 30), (0.005, 7)]:
        a, st = annualize(ret, dte)
        fx["annualize"].append({"periodReturn": ret, "dte": dte, "annualizedRate": a, "rateStatus": st})

    et = []
    for iso in ["2026-01-15T14:30:00Z", "2026-01-16T03:00:00Z", "2026-07-10T19:45:00Z",
                "2026-07-11T02:30:00Z", "2026-11-20T17:59:30Z", "2026-03-08T12:00:00Z"]:
        ts = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        loc = et_local(ts)
        today = loc.date()
        hrs = max(0.0, 16 - (loc.hour + loc.minute / 60 + loc.second / 3600))
        exps = [today + timedelta(days=n) for n in (0, 1, 7)]
        et.append({"utc": iso, "nowMs": int(ts.timestamp() * 1000), "todayEt": today.isoformat(),
                   "hoursToClose": hrs,
                   "dte": [{"expiry": e.isoformat(), "dte": (e - today).days} for e in exps]})
    fx["et"] = et

    bk = []
    for dte, spot, pw, gex in [(0, 100, 95, 1e6), (1, 100, None, 5), (5, 94, 95, -3e5), (5, 94, 95, 3e5),
                               (5, 100, 95, -3e5), (2, 94, 95, -1)]:
        bk.append({"dte": dte, "spot": spot, "putWall": pw, "netGex": gex,
                   "blocked": breaker(dte, spot, pw, gex)})
    fx["breaker"] = bk

    strikes = [float(k) for k in range(60, 141)]
    sg = []
    for spot, iv, t in [(100.0, 0.25, 30 / 365), (100.0, 0.40, 0.0), (250.0, 0.55, 1 / 365)]:
        em = expected_move(spot, iv, t)
        sg.append({"spot": spot, "ivAtm": iv, "t": t, "strikes": strikes, "expectedMove": em,
                   "minus2": nearest(strikes, spot - 2 * em), "minus1": nearest(strikes, spot - em),
                   "plus1": nearest(strikes, spot + em), "plus2": nearest(strikes, spot + 2 * em)})
    fx["sigmaStrikes"] = sg

    fx["ratioCards"] = [{"a": a, "b": b, "valid": (a > 0.005) or (b > 0.005)}
                        for a, b in [(0.0, 0.0), (0.005, 0.005), (0.006, 0.0), (0.0, 1.2)]]

    spot = 100.0
    nodes = []
    for k in range(80, 121, 2):
        iv = 0.30 + 0.0006 * (k - 100) ** 2 / 10.0 - 0.002 * (k - 100) / 10.0
        nodes.append({"strike": float(k), "iv": iv, "bid": 1.0 + abs(k - 100) * 0.01, "ask": 1.1 + abs(k - 100) * 0.01})
    dirty = nodes + [
        {"strike": 81.0, "iv": None, "bid": 1.0, "ask": 1.1},
        {"strike": 83.0, "iv": 9.99, "bid": 1.0, "ask": 1.1},
        {"strike": 85.0, "iv": 0.3, "bid": 0.0, "ask": 0.1},
        {"strike": 87.0, "iv": 0.3, "bid": 0.1, "ask": 2.0},
    ]
    bl = []
    for dte, t, nds in [(0, 1 / (365 * 24) * 4.0, dirty), (1, 1 / 365, dirty), (30, 30 / 365, dirty)]:
        c = {"spot": spot, "rate": 0.04, "q": 0.005, "t": t, "dte": dte,
             "expectedMove": expected_move(spot, 0.30, t), "nodes": nds}
        bl.append({"input": c, "expected": bl_density(c)})
    fx["blDensity"] = bl

    be_x = [90.0 + 0.5 * i for i in range(41)]
    be_y = [-2.0 + 0.2 * (v - 90.0) if v < 100 else 3.0 - 0.3 * (v - 100.0) for v in be_x]
    fx["breakevens"] = {"spots": be_x, "pnl": be_y, "expected": breakevens(be_x, be_y)}
    fx["hoursGrid"] = [{"start": s, "step": st, "expected": hours_grid(s, st)}
                       for s, st in [(5.5, 0.5), (3.3, 0.25), (0.0, 0.25)]]
    fx["hoursToYears"] = [{"h": h, "t": h / (365 * 24)} for h in (0.0, 0.25, 3.5, 6.5)]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(fx, fh, indent=1)
    print("written", OUT)


if __name__ == "__main__":
    main()
