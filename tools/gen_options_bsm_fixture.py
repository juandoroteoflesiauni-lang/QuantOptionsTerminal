"""Independent Python reference fixture generator for Pieza 2 (BSM, Black-76, Greeks, IV).

Deliberately avoids copying TypeScript analytical Greek formulas or Newton solver logic:
- Evaluates high-precision option prices via 60-digit Decimal arithmetic (`erfc_dec` from
  series + backward-recurrence continued fraction cross-checked against `math.erfc`).
- Computes all 1st- and 2nd-order Greeks (`delta`, `gamma`, `theta`, `vega`, `rho`,
  `vanna`, `charm`) purely via high-order central finite differences on the scalar price
  function in 60-digit precision (zero truncation/roundoff pollution).
- Solves implied volatility purely via 140-step safeguarded bisection in Python Decimal.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 60

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = ROOT / "fixtures" / "options_bsm_reference.json"

SECONDS_PER_YEAR_365 = 365 * 86_400
MAX_TIME_SECONDS = 1e11


def _compute_pi_dec() -> Decimal:
    # Gauss-Legendre AGM in 60-digit precision (7 iterations -> >100 digits accurate)
    a = Decimal(1)
    b = Decimal(1) / Decimal(2).sqrt()
    t = Decimal(1) / Decimal(4)
    p = Decimal(1)
    for _ in range(7):
        an = (a + b) / 2
        b = (a * b).sqrt()
        t -= p * (a - an) ** 2
        a = an
        p *= 2
    return (a + b) ** 2 / (4 * t)


PI_DEC = _compute_pi_dec()
SQRT_PI_DEC = PI_DEC.sqrt()
SQRT_2_DEC = Decimal(2).sqrt()


def erfc_dec(x: Decimal) -> Decimal:
    """High-precision complementary error function in 60-digit Decimal arithmetic."""
    if x < 0:
        return Decimal(2) - erfc_dec(-x)
    if x > 40:
        return Decimal(0)
    if x <= Decimal("2.5"):
        z2 = x * x
        term = x
        total = term
        k = 1
        tol = Decimal(10) ** -62
        while abs(term) > tol:
            term *= (2 * z2) / (2 * k + 1)
            total += term
            k += 1
        erf_x = (Decimal(2) / SQRT_PI_DEC) * (-z2).exp() * total
        return Decimal(1) - erf_x
    # Convergent continued fraction via backward recurrence for x > 2.5
    b = Decimal(0)
    for k in range(220, 0, -1):
        b = (Decimal(k) / 2) / (x + b)
    return ((-x * x).exp() / SQRT_PI_DEC) / (x + b)


def norm_cdf_dec(x: Decimal) -> Decimal:
    return Decimal("0.5") * erfc_dec(-x / SQRT_2_DEC)


def price_generalized_dec(
    underlier: Decimal,
    strike: Decimal,
    t_years: Decimal,
    rate: Decimal,
    carry_rate: Decimal,
    sigma: Decimal,
    contract_type: str,
) -> Decimal:
    """Pure pricing formula ONLY (no analytical Greeks)."""
    sqrt_t = t_years.sqrt()
    vol_sqrt_t = sigma * sqrt_t
    d1 = (
        (underlier / strike).ln()
        + (rate - carry_rate + Decimal("0.5") * sigma * sigma) * t_years
    ) / vol_sqrt_t
    d2 = d1 - vol_sqrt_t
    disc_u = underlier * (-carry_rate * t_years).exp()
    disc_k = strike * (-rate * t_years).exp()
    if contract_type == "call":
        return disc_u * norm_cdf_dec(d1) - disc_k * norm_cdf_dec(d2)
    return disc_k * norm_cdf_dec(-d2) - disc_u * norm_cdf_dec(-d1)


def _fourth_order_d1(fn, x: Decimal, h: Decimal) -> Decimal:
    return (-fn(x + 2 * h) + 8 * fn(x + h) - 8 * fn(x - h) + fn(x - 2 * h)) / (12 * h)


def _fourth_order_d2(fn, x: Decimal, h: Decimal) -> Decimal:
    return (
        -fn(x + 2 * h) + 16 * fn(x + h) - 30 * fn(x) + 16 * fn(x - h) - fn(x - 2 * h)
    ) / (12 * h * h)


def _mixed_d2(fn, x: Decimal, hx: Decimal, y: Decimal, hy: Decimal) -> Decimal:
    return (
        fn(x + hx, y + hy)
        - fn(x + hx, y - hy)
        - fn(x - hx, y + hy)
        + fn(x - hx, y - hy)
    ) / (4 * hx * hy)


def compute_reference_greeks(
    underlier_f: float,
    strike_f: float,
    t_f: float,
    rate_f: float,
    carry_f: float,
    sigma_f: float,
    contract_type: str,
    model: str,
) -> dict[str, float | str]:
    u = Decimal(repr(underlier_f))
    k = Decimal(repr(strike_f))
    t = Decimal(repr(t_f))
    r = Decimal(repr(rate_f))
    q = Decimal(repr(carry_f))
    s = Decimal(repr(sigma_f))

    price = price_generalized_dec(u, k, t, r, q, s, contract_type)

    # Characteristic scale step sizes (~1e-10 relative; truncation O(1e-40), roundoff O(1e-30))
    eps_rel = Decimal("1e-10")
    hu = u * eps_rel
    hs = s * eps_rel
    ht = t * eps_rel
    hr = max(abs(r), Decimal("0.01")) * eps_rel

    delta = _fourth_order_d1(
        lambda x: price_generalized_dec(x, k, t, r, q, s, contract_type), u, hu
    )
    gamma = _fourth_order_d2(
        lambda x: price_generalized_dec(x, k, t, r, q, s, contract_type), u, hu
    )
    vega = _fourth_order_d1(
        lambda v: price_generalized_dec(u, k, t, r, q, v, contract_type), s, hs
    )
    # Theta = -dV/dT (= +dV/dt_calendar)
    theta = -_fourth_order_d1(
        lambda tau: price_generalized_dec(u, k, tau, r, q, s, contract_type), t, ht
    )

    if model == "black76":
        # In Black-76, futures price F does not depend on r; both discount and carry equal r
        rho = _fourth_order_d1(
            lambda rv: price_generalized_dec(u, k, t, rv, rv, s, contract_type), r, hr
        )
    else:
        rho = _fourth_order_d1(
            lambda rv: price_generalized_dec(u, k, t, rv, q, s, contract_type), r, hr
        )

    # Second-order mixed derivatives directly from scalar price:
    vanna = _mixed_d2(
        lambda x, v: price_generalized_dec(x, k, t, r, q, v, contract_type),
        u,
        hu,
        s,
        hs,
    )
    # Charm = -dDelta/dT = -d^2V/(dU dT)
    charm = -_mixed_d2(
        lambda x, tau: price_generalized_dec(x, k, tau, r, q, s, contract_type),
        u,
        hu,
        t,
        ht,
    )

    return {
        "price": float(price),
        "delta": float(delta),
        "gamma": float(gamma),
        "theta": float(theta),
        "thetaDaily": float(theta / Decimal(365)),
        "vega": float(vega),
        "vegaPer1Pct": float(vega / Decimal(100)),
        "rho": float(rho),
        "vanna": float(vanna),
        "charm": float(charm),
    }


def arbitrage_bounds(
    underlier_f: float,
    strike_f: float,
    t_f: float,
    rate_f: float,
    carry_f: float,
    contract_type: str,
) -> tuple[float, float]:
    u = Decimal(repr(underlier_f))
    k = Decimal(repr(strike_f))
    t = Decimal(repr(t_f))
    r = Decimal(repr(rate_f))
    q = Decimal(repr(carry_f))
    disc_u = u * (-q * t).exp()
    disc_k = k * (-r * t).exp()
    if contract_type == "call":
        return float(max(Decimal(0), disc_u - disc_k)), float(disc_u)
    return float(max(Decimal(0), disc_k - disc_u)), float(disc_k)


def bisect_iv_dec(
    underlier_f: float,
    strike_f: float,
    t_f: float,
    rate_f: float,
    carry_f: float,
    contract_type: str,
    target_price_f: float,
    lo_f: float = 1e-9,
    hi_f: float = 100.0,
) -> float | None:
    lo_b, hi_b = arbitrage_bounds(underlier_f, strike_f, t_f, rate_f, carry_f, contract_type)
    if target_price_f <= lo_b or target_price_f >= hi_b:
        return None

    u = Decimal(repr(underlier_f))
    k = Decimal(repr(strike_f))
    t = Decimal(repr(t_f))
    r = Decimal(repr(rate_f))
    q = Decimal(repr(carry_f))
    target = Decimal(repr(target_price_f))

    disc_u = u * (-q * t).exp()
    disc_k = k * (-r * t).exp()
    lower = max(Decimal(0), disc_u - disc_k) if contract_type == "call" else max(Decimal(0), disc_k - disc_u)
    upper = disc_u if contract_type == "call" else disc_k
    if target <= lower or target >= upper:
        return None

    lo = Decimal(repr(lo_f))
    hi = Decimal(repr(hi_f))
    p_lo = price_generalized_dec(u, k, t, r, q, lo, contract_type)
    p_hi = price_generalized_dec(u, k, t, r, q, hi, contract_type)
    if p_lo > target or p_hi < target:
        return None

    for _ in range(150):
        mid = (lo + hi) / Decimal(2)
        p_mid = price_generalized_dec(u, k, t, r, q, mid, contract_type)
        if p_mid < target:
            lo = mid
        else:
            hi = mid
        if hi - lo <= Decimal("1e-22") * max(Decimal(1), mid):
            break

    return float((lo + hi) / Decimal(2))


def main() -> None:
    # Sanity self-check: erfc_dec vs C math.erfc
    for probe in [-25.0, -6.0, -2.5, -1.0, -0.4, 0.0, 0.4, 1.0, 2.5, 6.0, 25.0]:
        rel = abs(float(erfc_dec(Decimal(repr(probe)))) - math.erfc(probe)) / max(
            math.erfc(probe), 1e-300
        )
        assert rel < 1e-14, f"erfc self-check failed at {probe}: rel={rel}"

    erfc_inputs = [
        -27.0,
        -25.0,
        -10.0,
        -4.5,
        -4.0,
        -3.5,
        -1.0,
        -0.46875,
        -0.46,
        -0.1,
        0.0,
        0.1,
        0.46,
        0.46875,
        1.0,
        3.5,
        4.0,
        4.5,
        10.0,
        20.0,
        25.0,
        27.0,
    ]
    erfc_cases = [
        {
            "x": x,
            "erfc": math.erfc(x),
            "normCdf": 0.5 * math.erfc(-x / math.sqrt(2.0)),
            "normPdf": math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi),
        }
        for x in erfc_inputs
    ]

    time_to_expiry_cases = [
        {
            "label": "exact_1y_act365",
            "nowUtcSec": 1700000000,
            "expiryUtcSec": 1700000000 + SECONDS_PER_YEAR_365,
            "expected": 1.0,
        },
        {
            "label": "15_minutes_before_close",
            "nowUtcSec": 1763066700,
            "expiryUtcSec": 1763067600,
            "expected": 900 / SECONDS_PER_YEAR_365,
        },
        {
            "label": "at_expiry_zero",
            "nowUtcSec": 1763067600,
            "expiryUtcSec": 1763067600,
            "expected": 0.0,
        },
        {
            "label": "expired_negative_nan",
            "nowUtcSec": 1763067601,
            "expiryUtcSec": 1763067600,
            "expected": "NaN",
        },
        {
            "label": "reject_milliseconds_now",
            "nowUtcSec": 1763066700000,
            "expiryUtcSec": 1763067600,
            "expected": "NaN",
        },
        {
            "label": "reject_milliseconds_expiry",
            "nowUtcSec": 1763066700,
            "expiryUtcSec": 1763067600000,
            "expected": "NaN",
        },
        {
            "label": "custom_basis_252d",
            "nowUtcSec": 1700000000,
            "expiryUtcSec": 1700000000 + 21 * 86_400,
            "secondsPerYear": 252 * 86_400,
            "expected": 21 / 252,
        },
        {
            "label": "invalid_basis_zero",
            "nowUtcSec": 1700000000,
            "expiryUtcSec": 1700086400,
            "secondsPerYear": 0,
            "expected": "NaN",
        },
    ]

    expiry_payoff_cases = [
        {"underlier": 5850.0, "strike": 5800.0, "contractType": "call", "expected": 50.0},
        {"underlier": 5750.0, "strike": 5800.0, "contractType": "call", "expected": 0.0},
        {"underlier": 5750.0, "strike": 5800.0, "contractType": "put", "expected": 50.0},
        {"underlier": 5850.0, "strike": 5800.0, "contractType": "put", "expected": 0.0},
        {"underlier": 0.0, "strike": 100.0, "contractType": "call", "expected": "NaN"},
        {"underlier": 100.0, "strike": -5.0, "contractType": "put", "expected": "NaN"},
    ]

    bsm_specs = [
        ("atm_benchmark_call", 100.0, 100.0, 1.0, 0.05, 0.02, 0.20, "call"),
        ("atm_benchmark_put", 100.0, 100.0, 1.0, 0.05, 0.02, 0.20, "put"),
        ("spxw_0dte_itm_call", 5850.0, 5750.0, 3600 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.22, "call"),
        ("spxw_0dte_mod_itm_call", 5850.0, 5810.0, 3600 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.22, "call"),
        ("spxw_0dte_itm_put", 5750.0, 5850.0, 3600 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.22, "put"),
        ("short_t_3min_near_atm_call", 5850.0, 5855.0, 180 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.18, "call"),
        ("short_t_3min_near_atm_put", 5850.0, 5845.0, 180 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.18, "put"),
        ("extreme_otm_call", 100.0, 165.0, 0.5, 0.05, 0.03, 0.35, "call"),
        ("extreme_otm_put", 100.0, 55.0, 0.5, 0.05, 0.03, 0.35, "put"),
        ("high_div_yield_call", 450.0, 440.0, 0.25, 0.03, 0.08, 0.40, "call"),
        ("high_div_yield_put", 450.0, 440.0, 0.25, 0.03, 0.08, 0.40, "put"),
        ("negative_rate_call", 100.0, 105.0, 0.75, -0.01, 0.0, 0.25, "call"),
        ("leap_2_5y_put", 200.0, 220.0, 2.5, 0.045, 0.01, 0.28, "put"),
        ("deep_wing_near_zero_greeks", 5850.0, 5000.0, 300 / SECONDS_PER_YEAR_365, 0.045, 0.013, 0.15, "call"),
    ]

    bsm_cases = []
    for label, s, k, t, r, q, sig, ctype in bsm_specs:
        expected = compute_reference_greeks(s, k, t, r, q, sig, ctype, "bsm")
        lo_b, hi_b = arbitrage_bounds(s, k, t, r, q, ctype)
        iv_rt = bisect_iv_dec(s, k, t, r, q, ctype, float(expected["price"]))
        bsm_cases.append(
            {
                "label": label,
                "input": {
                    "spot": s,
                    "strike": k,
                    "timeToExpiry": t,
                    "rate": r,
                    "dividendYield": q,
                    "volatility": sig,
                    "contractType": ctype,
                },
                "bounds": {"lower": lo_b, "upper": hi_b},
                "expected": expected,
                "impliedVolRoundTrip": iv_rt if iv_rt is not None else "NaN",
            }
        )

    black76_specs = [
        ("vix_atm_call", 18.5, 18.5, 21 / 365, 0.045, 0.85, "call"),
        ("vix_atm_put", 18.5, 18.5, 21 / 365, 0.045, 0.85, "put"),
        ("vix_otm_spike_call", 18.5, 35.0, 30 / 365, 0.045, 1.15, "call"),
        ("vix_deep_itm_call", 24.0, 12.0, 14 / 365, 0.045, 0.90, "call"),
        ("vix_deep_itm_put", 12.0, 24.0, 14 / 365, 0.045, 0.90, "put"),
        ("futures_zero_rate_put", 5800.0, 5700.0, 0.25, 0.0, 0.16, "put"),
    ]

    black76_cases = []
    for label, f, k, t, r, sig, ctype in black76_specs:
        expected = compute_reference_greeks(f, k, t, r, r, sig, ctype, "black76")
        lo_b, hi_b = arbitrage_bounds(f, k, t, r, r, ctype)
        iv_rt = bisect_iv_dec(f, k, t, r, r, ctype, float(expected["price"]))
        black76_cases.append(
            {
                "label": label,
                "input": {
                    "forward": f,
                    "strike": k,
                    "timeToExpiry": t,
                    "rate": r,
                    "volatility": sig,
                    "contractType": ctype,
                },
                "bounds": {"lower": lo_b, "upper": hi_b},
                "expected": expected,
                "impliedVolRoundTrip": iv_rt if iv_rt is not None else "NaN",
            }
        )

    degenerate_cases = [
        {
            "label": "zero_vol",
            "model": "bsm",
            "input": {"spot": 100, "strike": 100, "timeToExpiry": 0.5, "rate": 0.05, "dividendYield": 0.0, "volatility": 0.0, "contractType": "call"},
        },
        {
            "label": "negative_vol",
            "model": "black76",
            "input": {"forward": 20, "strike": 20, "timeToExpiry": 0.1, "rate": 0.04, "volatility": -0.3, "contractType": "put"},
        },
        {
            "label": "zero_time",
            "model": "bsm",
            "input": {"spot": 100, "strike": 100, "timeToExpiry": 0.0, "rate": 0.05, "dividendYield": 0.0, "volatility": 0.2, "contractType": "call"},
        },
        {
            "label": "negative_time",
            "model": "bsm",
            "input": {"spot": 100, "strike": 100, "timeToExpiry": -0.01, "rate": 0.05, "dividendYield": 0.0, "volatility": 0.2, "contractType": "put"},
        },
        {
            "label": "non_positive_spot",
            "model": "bsm",
            "input": {"spot": 0, "strike": 100, "timeToExpiry": 0.5, "rate": 0.05, "dividendYield": 0.0, "volatility": 0.2, "contractType": "call"},
        },
        {
            "label": "non_positive_strike",
            "model": "black76",
            "input": {"forward": 20, "strike": -1, "timeToExpiry": 0.5, "rate": 0.05, "volatility": 0.2, "contractType": "call"},
        },
        {
            "label": "nan_rate",
            "model": "bsm",
            "input": {"spot": 100, "strike": 100, "timeToExpiry": 0.5, "rate": "NaN", "dividendYield": 0.0, "volatility": 0.2, "contractType": "call"},
        },
    ]

    # Independent IV cases including market quotes, very high/low vol, and arbitrage rejections
    iv_market_specs = [
        ("bsm_low_vol_0_005", "bsm", 100.0, 100.0, 0.25, 0.04, 0.01, "call", float(price_generalized_dec(Decimal("100"), Decimal("100"), Decimal("0.25"), Decimal("0.04"), Decimal("0.01"), Decimal("0.005"), "call"))),
        ("bsm_high_vol_3_5", "bsm", 100.0, 120.0, 0.5, 0.05, 0.0, "put", float(price_generalized_dec(Decimal("100"), Decimal("120"), Decimal("0.5"), Decimal("0.05"), Decimal("0"), Decimal("3.5"), "put"))),
        ("bsm_spx_0dte_market_quote", "bsm", 5850.0, 5860.0, 1800 / SECONDS_PER_YEAR_365, 0.045, 0.013, "call", 12.75),
        ("black76_vix_market_quote", "black76", 19.2, 25.0, 28 / 365, 0.045, 0.045, "call", 1.85),
    ]

    iv_cases = []
    for label, model, u, k, t, r, q, ctype, px in iv_market_specs:
        expected_iv = bisect_iv_dec(u, k, t, r, q, ctype, px)
        if model == "bsm":
            inp = {"spot": u, "strike": k, "timeToExpiry": t, "rate": r, "dividendYield": q, "contractType": ctype, "price": px}
        else:
            inp = {"forward": u, "strike": k, "timeToExpiry": t, "rate": r, "contractType": ctype, "price": px}
        iv_cases.append(
            {
                "label": label,
                "model": model,
                "input": inp,
                "expectedIv": expected_iv if expected_iv is not None else "NaN",
            }
        )

    # Arbitrage violations & edge rejections -> must return NaN
    call_lo, call_hi = arbitrage_bounds(100.0, 90.0, 1.0, 0.05, 0.02, "call")
    f_put_lo, f_put_hi = arbitrage_bounds(18.0, 25.0, 0.5, 0.05, 0.05, "put")
    iv_rejection_cases = [
        {
            "label": "bsm_below_intrinsic",
            "model": "bsm",
            "input": {"spot": 100.0, "strike": 90.0, "timeToExpiry": 1.0, "rate": 0.05, "dividendYield": 0.02, "contractType": "call", "price": call_lo - 0.05},
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_exact_intrinsic_lower",
            "model": "bsm",
            "input": {"spot": 100.0, "strike": 90.0, "timeToExpiry": 1.0, "rate": 0.05, "dividendYield": 0.02, "contractType": "call", "price": call_lo},
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_exact_discounted_upper",
            "model": "bsm",
            "input": {"spot": 100.0, "strike": 90.0, "timeToExpiry": 1.0, "rate": 0.05, "dividendYield": 0.02, "contractType": "call", "price": call_hi},
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_above_discounted_upper",
            "model": "bsm",
            "input": {"spot": 100.0, "strike": 90.0, "timeToExpiry": 1.0, "rate": 0.05, "dividendYield": 0.02, "contractType": "call", "price": call_hi + 0.01},
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_zero_price_otm",
            "model": "bsm",
            "input": {"spot": 100.0, "strike": 110.0, "timeToExpiry": 1.0, "rate": 0.05, "dividendYield": 0.02, "contractType": "call", "price": 0.0},
            "expectedIv": "NaN",
        },
        {
            "label": "black76_below_lower_bound",
            "model": "black76",
            "input": {"forward": 18.0, "strike": 25.0, "timeToExpiry": 0.5, "rate": 0.05, "contractType": "put", "price": f_put_lo - 0.1},
            "expectedIv": "NaN",
        },
        {
            "label": "black76_above_upper_bound",
            "model": "black76",
            "input": {"forward": 18.0, "strike": 25.0, "timeToExpiry": 0.5, "rate": 0.05, "contractType": "put", "price": f_put_hi + 0.1},
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_outside_narrow_bracket_returns_nan",
            "model": "bsm",
            "input": {
                "spot": 100.0,
                "strike": 100.0,
                "timeToExpiry": 1.0,
                "rate": 0.05,
                "dividendYield": 0.02,
                "contractType": "call",
                "price": float(price_generalized_dec(Decimal("100"), Decimal("100"), Decimal("1"), Decimal("0.05"), Decimal("0.02"), Decimal("0.20"), "call")),
                "options": {"minVolatility": 0.30, "maxVolatility": 1.0},
            },
            "expectedIv": "NaN",
        },
        {
            "label": "bsm_flat_vega_high_min_vega_threshold",
            "model": "bsm",
            "input": {
                "spot": 100.0,
                "strike": 250.0,
                "timeToExpiry": 1 / 365,
                "rate": 0.05,
                "dividendYield": 0.0,
                "contractType": "call",
                "price": float(price_generalized_dec(Decimal("100"), Decimal("250"), Decimal(1) / Decimal(365), Decimal("0.05"), Decimal("0"), Decimal("2.0"), "call")),
                "options": {"minVega": 1.0},
            },
            "expectedIv": "NaN",
        },
    ]

    fixture = {
        "meta": {
            "generator": "tools/gen_options_bsm_fixture.py",
            "precisionDigits": 60,
            "notes": "Independent 60-digit Decimal erfc + 4th-order finite-difference Greeks + 150-step bisection IV.",
        },
        "erfcCases": erfc_cases,
        "timeToExpiryCases": time_to_expiry_cases,
        "expiryPayoffCases": expiry_payoff_cases,
        "bsmCases": bsm_cases,
        "black76Cases": black76_cases,
        "degenerateGreeksCases": degenerate_cases,
        "ivCases": iv_cases + iv_rejection_cases,
    }

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {FIXTURE_PATH} with {len(bsm_cases)} BSM, {len(black76_cases)} Black-76, {len(iv_cases) + len(iv_rejection_cases)} IV cases.")


if __name__ == "__main__":
    main()
