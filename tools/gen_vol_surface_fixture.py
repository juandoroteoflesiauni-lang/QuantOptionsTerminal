"""Independent reference generator for Pieza 5 (Volatility Surface & Smile Metrics).

Implements textbook mathematics from first principles using only Python stdlib:
- Fritsch-Carlson (1980) piecewise cubic Hermite interpolation (PCHIP) in total variance w(k)
- Analytical 1st & 2nd derivatives wrt log-forward moneyness k = ln(K / F)
- Durrleman butterfly risk-neutral density condition g(k) >= 0
- Total-variance calendar arbitrage condition w(k, T2) >= w(k, T1)
- Exact Black-Scholes-Merton delta via math.erf and independent bisection solver for 25-delta strikes
- Term structure variance interpolation, expected move fraction, spread, and annualized slope
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

SQRT_2 = math.sqrt(2.0)


def std_norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / SQRT_2))


def pchip_slopes_independent(xs: list[float], ys: list[float]) -> list[float]:
    n = len(xs)
    assert n >= 2 and len(ys) == n
    hs = [xs[i + 1] - xs[i] for i in range(n - 1)]
    ms = [(ys[i + 1] - ys[i]) / hs[i] for i in range(n - 1)]
    if n == 2:
        return [ms[0], ms[0]]

    def edge(h0: float, h1: float, m0: float, m1: float) -> float:
        if m0 == 0.0:
            return 0.0
        d = ((2.0 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
        if math.copysign(1.0, d) != math.copysign(1.0, m0) or d == 0.0:
            return 0.0
        if (m1 == 0.0 or math.copysign(1.0, m0) != math.copysign(1.0, m1)) and abs(d) > 3.0 * abs(m0):
            return 3.0 * m0
        return d

    slopes = [0.0] * n
    slopes[0] = edge(hs[0], hs[1], ms[0], ms[1])
    for i in range(1, n - 1):
        if ms[i - 1] == 0.0 or ms[i] == 0.0 or (ms[i - 1] * ms[i] <= 0.0):
            slopes[i] = 0.0
        else:
            w1 = 2.0 * hs[i] + hs[i - 1]
            w2 = hs[i] + 2.0 * hs[i - 1]
            slopes[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i])
    slopes[n - 1] = edge(hs[n - 2], hs[n - 3], ms[n - 2], ms[n - 3])
    return slopes


class IndependentPchipSlice:
    def __init__(
        self,
        time_to_expiry: float,
        forward: float,
        strikes: list[float],
        ivs: list[float],
        spot: float | None = None,
        rate: float | None = None,
        dividend_yield: float | None = None,
    ) -> None:
        assert len(strikes) == len(ivs) and len(strikes) >= 2
        pairs = sorted(zip(strikes, ivs), key=lambda p: p[0])
        self.T = time_to_expiry
        self.F = forward
        self.spot = spot
        self.rate = rate
        self.q = dividend_yield
        if self.q is None and spot is not None and rate is not None:
            self.q = rate - math.log(forward / spot) / time_to_expiry

        self.strikes = [p[0] for p in pairs]
        self.ivs = [p[1] for p in pairs]
        self.ks = [math.log(k / forward) for k in self.strikes]
        self.ws = [iv * iv * time_to_expiry for iv in self.ivs]
        self.slopes = pchip_slopes_independent(self.ks, self.ws)
        self.k_min = self.ks[0]
        self.k_max = self.ks[-1]

    def eval_derivs(self, k: float) -> tuple[float, float, float, float] | None:
        if k < self.k_min or k > self.k_max:
            return None
        idx = len(self.ks) - 2
        for i in range(len(self.ks) - 1):
            if self.ks[i] <= k <= self.ks[i + 1]:
                idx = i
                break
        h = self.ks[idx + 1] - self.ks[idx]
        t = (k - self.ks[idx]) / h
        y0, y1 = self.ws[idx], self.ws[idx + 1]
        d0, d1 = h * self.slopes[idx], h * self.slopes[idx + 1]

        # Direct Taylor expansion around t using cubic basis
        c0 = y0
        c1 = d0
        c2 = 3.0 * (y1 - y0) - 2.0 * d0 - d1
        c3 = 2.0 * (y0 - y1) + d0 + d1

        w = c0 + t * (c1 + t * (c2 + t * c3))
        dw_dt = c1 + t * (2.0 * c2 + 3.0 * t * c3)
        d2w_dt2 = 2.0 * c2 + 6.0 * t * c3

        dw_dk = dw_dt / h
        d2w_dk2 = d2w_dt2 / (h * h)
        iv = math.sqrt(w / self.T) if w > 0.0 else math.nan
        return (w, dw_dk, d2w_dk2, iv)

    def durrleman_density_at_k(self, k: float) -> float | None:
        res = self.eval_derivs(k)
        if res is None:
            return None
        w, dw, d2w, _ = res
        return (
            (1.0 - 0.5 * k * dw / w) ** 2
            - 0.25 * dw * dw * (1.0 / w + 0.25)
            + 0.5 * d2w
        )

    def min_durrleman_density(self, samples_per_segment: int = 16) -> tuple[float, float]:
        min_g = math.inf
        worst_k = math.nan
        for i in range(len(self.ks) - 1):
            h = self.ks[i + 1] - self.ks[i]
            for s in range(samples_per_segment + 1):
                t = s / samples_per_segment
                k = self.ks[i] + t * h
                y0, y1 = self.ws[i], self.ws[i + 1]
                d0, d1 = h * self.slopes[i], h * self.slopes[i + 1]
                c0, c1 = y0, d0
                c2 = 3.0 * (y1 - y0) - 2.0 * d0 - d1
                c3 = 2.0 * (y0 - y1) + d0 + d1
                w = c0 + t * (c1 + t * (c2 + t * c3))
                dw = (c1 + t * (2.0 * c2 + 3.0 * t * c3)) / h
                d2w = (2.0 * c2 + 6.0 * t * c3) / (h * h)
                g = (1.0 - 0.5 * k * dw / w) ** 2 - 0.25 * dw * dw * (1.0 / w + 0.25) + 0.5 * d2w
                if g < min_g:
                    min_g = g
                    worst_k = k
        return min_g, worst_k

    def delta_at_k(self, k: float, opt_type: str, convention: str = "spotBsm") -> float | None:
        res = self.eval_derivs(k)
        if res is None:
            return None
        _, _, _, iv = res
        vol_sqrt_t = iv * math.sqrt(self.T)
        d1 = (-k + 0.5 * vol_sqrt_t * vol_sqrt_t) / vol_sqrt_t
        if convention == "forward":
            mult = 1.0
        elif convention == "discountedForward":
            assert self.rate is not None
            mult = math.exp(-self.rate * self.T)
        else:
            assert self.q is not None
            mult = math.exp(-self.q * self.T)
        if opt_type == "call":
            return mult * std_norm_cdf(d1)
        return -mult * std_norm_cdf(-d1)

    def solve_delta_bisection(
        self, target_delta: float, opt_type: str, convention: str = "spotBsm"
    ) -> dict[str, float] | None:
        grid: list[float] = []
        for i in range(len(self.ks) - 1):
            step = (self.ks[i + 1] - self.ks[i]) / 4.0
            for s in range(4):
                grid.append(self.ks[i] + s * step)
        grid.append(self.ks[-1])

        def f(k: float) -> float:
            d = self.delta_at_k(k, opt_type, convention)
            assert d is not None
            return d - target_delta

        roots: list[float] = []
        for i in range(len(grid) - 1):
            a, b = grid[i], grid[i + 1]
            fa, fb = f(a), f(b)
            if abs(fa) <= 1e-13:
                roots.append(a)
            elif fa * fb < 0.0:
                lo, hi = a, b
                flo = fa
                for _ in range(120):
                    mid = 0.5 * (lo + hi)
                    fmid = f(mid)
                    if abs(fmid) <= 1e-14 or (hi - lo) <= 1e-14:
                        lo = hi = mid
                        break
                    if flo * fmid <= 0.0:
                        hi = mid
                    else:
                        lo = mid
                        flo = fmid
                roots.append(0.5 * (lo + hi))
        if abs(f(grid[-1])) <= 1e-13:
            roots.append(grid[-1])
        if not roots:
            return None
        best_k = min(roots, key=lambda x: abs(x))
        deriv = self.eval_derivs(best_k)
        assert deriv is not None
        return {
            "logMoneyness": best_k,
            "strike": self.F * math.exp(best_k),
            "iv": deriv[3],
        }


def svi_iv(k: float, t: float, a: float, b: float, rho: float, m: float, sigma: float) -> float:
    w = a + b * (rho * (k - m) + math.sqrt((k - m) ** 2 + sigma * sigma))
    return math.sqrt(w / t)


def make_dual_chain(
    T: float,
    spot: float,
    rate: float,
    div_yield: float,
    rel_strikes: list[float],
    svi_params: tuple[float, float, float, float, float],
) -> tuple[float, list[float], list[float], list[dict[str, Any]]]:
    forward = spot * math.exp((rate - div_yield) * T)
    a, b, rho, m, sig = svi_params
    strikes = [round(forward * r, 2) for r in rel_strikes]
    ivs: list[float] = []
    quotes: list[dict[str, Any]] = []
    for k_strike in strikes:
        k = math.log(k_strike / forward)
        iv = svi_iv(k, T, a, b, rho, m, sig)
        ivs.append(iv)
        # Provide both puts and calls; OTM selector chooses put below forward and call above forward
        quotes.append(
            {
                "strike": k_strike,
                "contractType": "put",
                "iv": iv if k <= 0.0 else iv + 0.004,
                "bid": 2.40,
                "ask": 2.50,
                "openInterest": 500,
            }
        )
        quotes.append(
            {
                "strike": k_strike,
                "contractType": "call",
                "iv": iv if k >= 0.0 else iv + 0.004,
                "bid": 2.40,
                "ask": 2.50,
                "openInterest": 500,
            }
        )
    return forward, strikes, ivs, quotes


def build_scenario_a() -> dict[str, Any]:
    spot = 580.0
    rate = 0.045
    q = 0.013
    rel_strikes = [0.84, 0.88, 0.92, 0.95, 0.975, 1.0, 1.025, 1.05, 1.09, 1.13]

    expiries = [
        (7.0 / 365.0, 1770000000 + 7 * 86400, (0.00050, 0.0110, -0.70, 0.005, 0.060)),
        (30.0 / 365.0, 1770000000 + 30 * 86400, (0.00200, 0.0320, -0.68, 0.010, 0.090)),
        (90.0 / 365.0, 1770000000 + 90 * 86400, (0.00680, 0.0780, -0.62, 0.015, 0.130)),
    ]

    slice_inputs = []
    py_slices: list[IndependentPchipSlice] = []
    slice_reports = []

    for T, exp_sec, params in expiries:
        fwd, strikes, ivs, quotes = make_dual_chain(T, spot, rate, q, rel_strikes, params)
        py_slice = IndependentPchipSlice(T, fwd, strikes, ivs, spot=spot, rate=rate, dividend_yield=q)
        py_slices.append(py_slice)

        min_g, worst_k = py_slice.min_durrleman_density(16)
        atm_deriv = py_slice.eval_derivs(0.0)
        assert atm_deriv is not None
        put25 = py_slice.solve_delta_bisection(-0.25, "put", "spotBsm")
        call25 = py_slice.solve_delta_bisection(0.25, "call", "spotBsm")
        assert put25 is not None and call25 is not None

        sample_queries = []
        for k_q in [-0.11, -0.04, 0.0, 0.04, 0.09]:
            d = py_slice.eval_derivs(k_q)
            assert d is not None
            sample_queries.append(
                {
                    "logMoneyness": k_q,
                    "strike": fwd * math.exp(k_q),
                    "totalVariance": d[0],
                    "dwDk": d[1],
                    "d2wDk2": d[2],
                    "iv": d[3],
                    "durrlemanDensity": py_slice.durrleman_density_at_k(k_q),
                }
            )

        slice_inputs.append(
            {
                "timeToExpiry": T,
                "expirySec": exp_sec,
                "forward": fwd,
                "spot": spot,
                "rate": rate,
                "dividendYield": q,
                "quotes": quotes,
            }
        )

        iv_atm = atm_deriv[3]
        slice_reports.append(
            {
                "timeToExpiry": T,
                "forward": fwd,
                "ivAtm": iv_atm,
                "expectedMovePct": iv_atm * math.sqrt(T),
                "delta25PutStrike": put25["strike"],
                "delta25PutIv": put25["iv"],
                "delta25CallStrike": call25["strike"],
                "delta25CallIv": call25["iv"],
                "riskReversal25": put25["iv"] - call25["iv"],
                "butterfly25": 0.5 * (put25["iv"] + call25["iv"]) - iv_atm,
                "minButterflyDensity": min_g,
                "worstLogMoneyness": worst_k,
                "sampleQueries": sample_queries,
            }
        )

    # Off-grid surface interpolation at T_mid = 18/365 and T_mid2 = 60/365
    t_mid1 = 18.0 / 365.0
    s0, s1 = py_slices[0], py_slices[1]
    alpha1 = (t_mid1 - s0.T) / (s1.T - s0.T)
    fwd_mid1 = math.exp((1.0 - alpha1) * math.log(s0.F) + alpha1 * math.log(s1.F))
    strike_mid1 = 565.0
    k_strike1 = math.log(strike_mid1 / fwd_mid1)
    w_k0_mid1 = (1.0 - alpha1) * s0.eval_derivs(-0.03)[0] + alpha1 * s1.eval_derivs(-0.03)[0]
    w_strike1 = (1.0 - alpha1) * s0.eval_derivs(k_strike1)[0] + alpha1 * s1.eval_derivs(k_strike1)[0]
    iv_strike1 = math.sqrt(w_strike1 / t_mid1)

    iv_atm_0 = slice_reports[0]["ivAtm"]
    iv_atm_1 = slice_reports[1]["ivAtm"]
    iv_atm_2 = slice_reports[2]["ivAtm"]
    w_atm_mid1 = (1.0 - alpha1) * (iv_atm_0**2 * s0.T) + alpha1 * (iv_atm_1**2 * s1.T)
    iv_atm_mid1 = math.sqrt(w_atm_mid1 / t_mid1)

    term_spread_0_2 = iv_atm_2 - iv_atm_0
    term_slope_0_2 = term_spread_0_2 / (py_slices[2].T - py_slices[0].T)
    term_spread_mid = iv_atm_2 - iv_atm_mid1
    term_slope_mid = term_spread_mid / (py_slices[2].T - t_mid1)

    return {
        "sliceInputs": slice_inputs,
        "sliceExpected": slice_reports,
        "surfaceInterpolation": {
            "tMid": t_mid1,
            "kFixed": -0.03,
            "totalVarianceAtKFixed": w_k0_mid1,
            "strikeQuery": strike_mid1,
            "ivAtStrike": iv_strike1,
            "ivAtmMid": iv_atm_mid1,
            "termSpread_7d_90d": term_spread_0_2,
            "termSlope_7d_90d": term_slope_0_2,
            "termSpread_18d_90d": term_spread_mid,
            "termSlope_18d_90d": term_slope_mid,
        },
    }


def build_scenario_b() -> dict[str, Any]:
    forward = 100.0
    T = 45.0 / 365.0
    quotes = [
        {"strike": -5.0, "contractType": "put", "iv": 0.25, "bid": 1.0, "ask": 1.1, "openInterest": 100},
        {"strike": 80.0, "contractType": "put", "iv": 0.25, "bid": 0.0, "ask": 0.2, "openInterest": 100},  # zero bid
        {"strike": 85.0, "contractType": "put", "iv": -0.25, "bid": 1.0, "ask": 1.1, "openInterest": 100},  # negative iv
        {"strike": 86.0, "contractType": "put", "iv": 0.28, "bid": 1.5, "ask": 1.2, "openInterest": 100},  # ask < bid
        {"strike": 88.0, "contractType": "put", "iv": 0.30, "bid": 1.0, "ask": 1.8, "openInterest": 100},  # spread = 0.8/1.4 = 0.571 > 0.35
        {"strike": 89.0, "contractType": "put", "iv": 0.29, "bid": 1.0, "ask": 1.1, "openInterest": 5},  # oi < 10
        # Valid strikes (OTM preference & duplicate quote averaging)
        {"strike": 90.0, "contractType": "put", "iv": 0.260, "bid": 2.00, "ask": 2.10, "openInterest": 200},
        {"strike": 90.0, "contractType": "call", "iv": 0.310, "bid": 11.80, "ask": 12.20, "openInterest": 150},  # ITM excluded by OTM
        {"strike": 95.0, "contractType": "put", "iv": 0.232, "bid": 3.00, "ask": 3.06, "openInterest": 300},
        {"strike": 95.0, "contractType": "put", "iv": 0.240, "bid": 3.00, "ask": 3.30, "openInterest": 100},  # duplicate wider spread
        {"strike": 100.0, "contractType": "put", "iv": 0.200, "bid": 4.00, "ask": 4.08, "openInterest": 500},
        {"strike": 100.0, "contractType": "call", "iv": 0.204, "bid": 4.00, "ask": 4.16, "openInterest": 450},  # ATM blend
        {"strike": 105.0, "contractType": "call", "iv": 0.188, "bid": 2.10, "ask": 2.16, "openInterest": 400},
        {"strike": 110.0, "contractType": "call", "iv": 0.192, "bid": 1.00, "ask": 1.05, "openInterest": 350},
    ]

    # Exact weighted variance average matching inverse (1e-4 + spreadRatio)
    w_95_a = 1.0 / (1e-4 + (0.06 / 3.03))
    w_95_b = 1.0 / (1e-4 + (0.30 / 3.15))
    iv_95 = math.sqrt((w_95_a * 0.232**2 + w_95_b * 0.240**2) / (w_95_a + w_95_b))

    w_100_p = 1.0 / (1e-4 + (0.08 / 4.04))
    w_100_c = 1.0 / (1e-4 + (0.16 / 4.08))
    iv_100 = math.sqrt((w_100_p * 0.200**2 + w_100_c * 0.204**2) / (w_100_p + w_100_c))

    strikes = [90.0, 95.0, 100.0, 105.0, 110.0]
    ivs = [0.260, iv_95, iv_100, 0.188, 0.192]
    py_slice = IndependentPchipSlice(T, forward, strikes, ivs)
    atm = py_slice.eval_derivs(0.0)
    assert atm is not None

    return {
        "sliceInput": {
            "timeToExpiry": T,
            "forward": forward,
            "quotes": quotes,
        },
        "filterOptions": {
            "minBid": 0.05,
            "maxSpreadRatio": 0.35,
            "minOpenInterest": 10,
            "minPoints": 4,
            "quoteSelection": "otm",
        },
        "expectedCounts": {
            "invalidStrike": 1,
            "invalidContractType": 0,
            "invalidIv": 1,
            "invalidBidAsk": 1,
            "belowMinBid": 1,
            "spreadTooWide": 1,
            "belowMinOpenInterest": 1,
            "nonOtmExcluded": 1,
        },
        "expectedStrikes": strikes,
        "expectedIvs": ivs,
        "expectedIvAtm": atm[3],
    }


def build_scenario_c() -> dict[str, Any]:
    T = 60.0 / 365.0
    spot = 250.0
    rate = 0.05
    div_yield = 0.02
    fwd = spot * math.exp((rate - div_yield) * T)
    rel_strikes = [0.80, 0.86, 0.92, 0.96, 1.00, 1.04, 1.08, 1.15, 1.22]
    _, strikes, ivs, quotes = make_dual_chain(
        T, spot, rate, div_yield, rel_strikes, (0.0055, 0.060, -0.55, 0.008, 0.11)
    )
    py_slice = IndependentPchipSlice(T, fwd, strikes, ivs, spot=spot, rate=rate, dividend_yield=div_yield)
    atm = py_slice.eval_derivs(0.0)
    assert atm is not None

    by_convention: dict[str, Any] = {}
    for conv in ["spotBsm", "forward", "discountedForward"]:
        p25 = py_slice.solve_delta_bisection(-0.25, "put", conv)
        c25 = py_slice.solve_delta_bisection(0.25, "call", conv)
        assert p25 is not None and c25 is not None
        by_convention[conv] = {
            "ivAtm": atm[3],
            "delta25PutStrike": p25["strike"],
            "delta25PutIv": p25["iv"],
            "delta25CallStrike": c25["strike"],
            "delta25CallIv": c25["iv"],
            "riskReversal25": p25["iv"] - c25["iv"],
            "butterfly25": 0.5 * (p25["iv"] + c25["iv"]) - atm[3],
        }

    return {
        "sliceInput": {
            "timeToExpiry": T,
            "forward": fwd,
            "spot": spot,
            "rate": rate,
            "quotes": quotes,
        },
        "expectedImpliedDividendYield": rate - math.log(fwd / spot) / T,
        "byConvention": by_convention,
    }


def build_scenario_d() -> dict[str, Any]:
    T = 30.0 / 365.0
    fwd = 100.0
    strikes = [82.0, 88.0, 94.0, 97.0, 100.0, 103.0, 107.0, 112.0]
    ivs = [0.27, 0.23, 0.20, 0.34, 0.18, 0.175, 0.178, 0.19]  # K=97 upward spike breaks butterfly
    quotes = [
        {
            "strike": k,
            "contractType": "put" if k < fwd else "call",
            "iv": iv,
            "bid": 2.0,
            "ask": 2.05,
            "openInterest": 200,
        }
        for k, iv in zip(strikes, ivs)
    ]
    py_slice = IndependentPchipSlice(T, fwd, strikes, ivs)
    min_g, worst_k = py_slice.min_durrleman_density(16)
    return {
        "sliceInput": {
            "timeToExpiry": T,
            "forward": fwd,
            "quotes": quotes,
        },
        "minDensity": min_g,
        "worstLogMoneyness": worst_k,
        "worstStrike": fwd * math.exp(worst_k),
        "isArbitrageFree": min_g >= -1e-9,
    }


def build_scenario_e() -> dict[str, Any]:
    # E1: Calendar arbitrage violation (far T2 has LOWER total variance at ATM & wings than near T1)
    t1 = 14.0 / 365.0
    t2 = 28.0 / 365.0
    fwd = 100.0
    strikes = [90.0, 95.0, 100.0, 105.0, 110.0]
    iv_near_high = [0.40, 0.37, 0.35, 0.36, 0.38]  # w1(0) = 0.35^2 * 14/365 = 0.0046986
    iv_far_low = [0.23, 0.21, 0.20, 0.21, 0.22]    # w2(0) = 0.20^2 * 28/365 = 0.0030685 < w1

    s1 = IndependentPchipSlice(t1, fwd, strikes, iv_near_high)
    s2 = IndependentPchipSlice(t2, fwd, strikes, iv_far_low)
    grid = []
    for i, k_val in enumerate(s1.ks):
        grid.append(k_val)
        if i + 1 < len(s1.ks):
            grid.append(0.5 * (k_val + s1.ks[i + 1]))
    min_diff_bad = min(
        s2.eval_derivs(k)[0] - s1.eval_derivs(k)[0] for k in grid
    )

    # E2: Valid backwardation (near IV 0.28 > far IV 0.22 -> slope < 0),
    # BUT w2(k) > w1(k) everywhere so NO calendar arbitrage!
    iv_near_backw = [0.32, 0.295, 0.28, 0.275, 0.285]
    iv_far_backw = [0.255, 0.235, 0.22, 0.216, 0.225]
    sb1 = IndependentPchipSlice(t1, fwd, strikes, iv_near_backw)
    sb2 = IndependentPchipSlice(t2, fwd, strikes, iv_far_backw)
    min_diff_ok = min(sb2.eval_derivs(k)[0] - sb1.eval_derivs(k)[0] for k in grid)

    def to_quotes(ivs: list[float]) -> list[dict[str, Any]]:
        return [
            {
                "strike": k,
                "contractType": "put" if k < fwd else "call",
                "iv": iv,
                "bid": 2.0,
                "ask": 2.04,
                "openInterest": 200,
            }
            for k, iv in zip(strikes, ivs)
        ]

    return {
        "calendarViolation": {
            "slices": [
                {"timeToExpiry": t1, "forward": fwd, "quotes": to_quotes(iv_near_high)},
                {"timeToExpiry": t2, "forward": fwd, "quotes": to_quotes(iv_far_low)},
            ],
            "expectedMinVarianceDiff": min_diff_bad,
        },
        "validBackwardation": {
            "slices": [
                {"timeToExpiry": t1, "forward": fwd, "quotes": to_quotes(iv_near_backw)},
                {"timeToExpiry": t2, "forward": fwd, "quotes": to_quotes(iv_far_backw)},
            ],
            "expectedMinVarianceDiff": min_diff_ok,
            "expectedTermSpread": 0.22 - 0.28,
            "expectedTermSlope": (0.22 - 0.28) / (t2 - t1),
        },
    }


def main() -> None:
    payload = {
        "generator": "tools/gen_vol_surface_fixture.py",
        "tolerance": 1e-9,
        "scenarioA_cleanTermSurface": build_scenario_a(),
        "scenarioB_quoteFiltering": build_scenario_b(),
        "scenarioC_deltaConventions": build_scenario_c(),
        "scenarioD_butterflySpike": build_scenario_d(),
        "scenarioE_calendarAndBackwardation": build_scenario_e(),
    }
    out_path = Path(__file__).resolve().parent.parent / "fixtures" / "vol_surface_reference.json"
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
