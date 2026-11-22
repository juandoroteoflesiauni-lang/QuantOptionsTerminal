"""Referencia analítica independiente de valoración continua ACT/365."""
import json
import math
from pathlib import Path


def bsm(spot, strike, t, vol, rate, yield_rate, side):
    sign = 1 if side == "call" else -1
    root = math.sqrt(t)
    m = math.log(spot / strike)
    drift = (rate - yield_rate + vol**2 / 2) / vol
    x = m / (vol * root) + drift * root
    y = x - vol * root
    density = math.exp(-x**2 / 2) / math.sqrt(2 * math.pi)
    nd1 = math.erfc(-sign * x / math.sqrt(2)) / 2
    nd2 = math.erfc(-sign * y / math.sqrt(2)) / 2
    stock = spot * math.exp(-yield_rate * t)
    bond = strike * math.exp(-rate * t)
    delta = sign * stock / spot * nd1
    vega = stock * root * density
    theta = -vega * vol / (2 * t) + sign * (yield_rate * stock * nd1 - rate * bond * nd2)
    return dict(
        price=sign * (stock * nd1 - bond * nd2),
        delta=delta, gamma=stock * density / (spot**2 * vol * root),
        theta=theta, thetaDaily=theta / 365, vega=vega, vegaPer1Pct=vega / 100,
        rho=sign * bond * t * nd2, vanna=-(stock / spot) * density * y / vol,
        charm=yield_rate * delta - stock / spot * density * (drift - m / (vol * t)) / (2 * root),
    )


now = 1760000000
cases = []
for strike, vol, rate, yield_rate in [(100, 0.20, 0, 0), (101, 0.25, 0.043, 0.012)]:
    for side in ("call", "put"):
        for remaining in (3600, 3154, 3153.7, 3153.6, 3153.5, 3153, 300, 61, 60, 59, 0, -1):
            expiry = now + remaining
            elapsed = expiry - now
            t = elapsed / (365 * 86400) if elapsed > 60 else None
            greeks = bsm(100, strike, t, vol, rate, yield_rate, side) if t is not None else None
            gex = greeks["gamma"] * 10 * 100 * 100**2 / 100 if greeks else None
            cases.append(dict(
                expiry=expiry, remaining=remaining, t=t, strike=strike, vol=vol,
                rate=rate, dividendYield=yield_rate, side=side, greeks=greeks, gex=gex,
            ))
path = Path(__file__).resolve().parents[1] / "fixtures/options_pieza_q2_reference.json"
path.write_bytes((json.dumps(dict(now=now, cases=cases), indent=2) + "\n").encode())
