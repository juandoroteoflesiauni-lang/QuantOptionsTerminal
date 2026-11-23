"""Independent Decimal, BS02 and CRR reference for AR IV integrity and Motor 6."""
import json
from decimal import Decimal, getcontext
from pathlib import Path

from gen_ggal_motor6_fixture import build_fixture, eval_ccp_grid
from gen_options_american_fixture import bs02_american_py, bsm_price_py, crr_discrete_py

getcontext().prec = 50
D = Decimal
YEAR = 31_536_000
DAY = 86_400


def make_case(name, side, strike, price, status, reason, seconds=60 * DAY, **extra):
    spot = D(5005)
    strike = D(strike)
    mark = D(str(price))
    rate = D("0.35")
    signed = D(1) if side == "call" else D(-1)
    t = D(seconds) / YEAR
    intrinsic = max(D(0), signed * (spot - strike))
    eu = max(D(0), signed * (spot - strike * (-rate * t).exp()))
    lower = max(intrinsic, eu)
    return {
        "name": name, "contractType": side, "spot": float(spot), "strike": float(strike),
        "rate": float(rate), "seconds": seconds, "last": float(mark), "status": status, "reason": reason,
        "bounds": {"intrinsic": float(intrinsic), "europeanFloor": float(eu), "lower": float(lower),
                   "upper": float(spot if side == "call" else strike), "priceMinusLower": float(mark - lower)},
        **extra,
    }


def european_proxy():
    args = (5005, 6000, 60 / 365, .35, 0.)
    lo, hi = 0.000001, 9.99
    for _ in range(140):
        mid = (lo + hi) / 2
        if bsm_price_py(*args, mid, "put") < 973.5:
            lo = mid
        else:
            hi = mid
    iv = (lo + hi) / 2
    return {"iv": iv, "repricingAmericanPrice": bs02_american_py(*args, iv, "put")}


def round_trip(side, strike, sigma, seconds, spot=5005):
    args = (spot, strike, seconds / YEAR, .35, 0., sigma, side)
    premium = bs02_american_py(*args)
    return {
        "contractType": side, "spot": spot, "strike": strike, "seconds": seconds,
        "last": premium, "iv": sigma, "crr1000": crr_discrete_py(*args, 1000),
    }


def margin_reference():
    fixture = build_fixture()["marginCases"]
    uncovered = fixture["uncovered_short_otm_gt5"]
    cross = fixture["cross_collateral_strategy"]
    scenario = uncovered["input"]
    spot = D(str(scenario["spot24hArs"]))
    spread_cap = D(7200 - 6800) * 100 * 10
    short = {"strikeArs": 7200, "contractType": "put", "side": "SELL",
             "ivDecimal": .48, "optionPriceArs": 420, "ticker": "GFGV7200JU", "lots": 10}
    long = {**short, "strikeArs": 6800, "side": "BUY", "ticker": "GFGV6800JU"}
    args = (scenario["asOfUtcSec"], scenario["expiryDateKey"], scenario["spot24hArs"],
            scenario["rateCurveArs"], scenario["dividendsArs"])
    pair_loss = D(str(eval_ccp_grid(*args, [short, long])[0]))
    residual_loss = D(str(eval_ccp_grid(*args, [short])[0]))
    floor = spot * 100 * 10 * D(".025")
    return {
        "uncovered": {"margin": uncovered["output"]["baseRequiredMarginArs"], "floor": float(spot * 20 * 100 / 100)},
        "creditSplit": {"cap": float(spread_cap),
                        "margin": float(min(max(pair_loss, floor), spread_cap) + max(residual_loss, floor))},
        "cross": {"offset": 0, "margin": cross["output"]["baseRequiredMarginArs"]},
        "fees": {"stockMultiplierTen": float(D(8000) * 20 * 10 * D(".000605"))},
        "intrinsicOnly": float((spot - 7400) * 20 * 100),
    }


def main():
    cases = [
        make_case("put below intrinsic", "put", 6000, 973.5, "BELOW_INTRINSIC", "BELOW_IMMEDIATE_INTRINSIC"),
        make_case("call below intrinsic", "call", 4000, 1000, "BELOW_INTRINSIC", "BELOW_IMMEDIATE_INTRINSIC"),
        make_case("call below discounted floor", "call", 4000, 1050, "BELOW_INTRINSIC", "BELOW_DISCOUNTED_PARITY_FLOOR"),
        make_case("call above cap", "call", 4000, 5010, "ABOVE_UPPER_BOUND", "EXCEEDS_AMERICAN_UPPER_BOUND"),
        make_case("put above cap", "put", 6000, 6005, "ABOVE_UPPER_BOUND", "EXCEEDS_AMERICAN_UPPER_BOUND"),
        make_case("exercise boundary", "put", 6000, 995, "UNIDENTIFIABLE_AMERICAN_IV", "AT_LOWER_BOUND_ZERO_VEGA"),
        make_case("upper boundary", "call", 4000, 5005, "UNIDENTIFIABLE_AMERICAN_IV", "AT_UPPER_BOUND_INFINITE_VOL"),
        make_case("volatility outside bracket", "call", 5005, 5000, "UNIDENTIFIABLE_AMERICAN_IV", "ABOVE_MAX_VOL_DOMAIN"),
        make_case("forced nonconvergence", "put", 5000, 503, "SOLVER_FAILURE", "NON_CONVERGENCE", maxIterations=2),
    ]
    for seconds in (60, 30, 0, -10):
        alive = seconds > 0
        cases.append(make_case(f"remaining {seconds} s", "call", 5005, 10,
                               "UNIDENTIFIABLE_AMERICAN_IV" if alive else "INVALID_INPUT",
                               "NEAR_EXPIRY_DEGENERATE" if alive else "EXPIRED_OR_NON_POSITIVE_TIME", seconds))
    payload = {"ivCases": cases, "europeanProxy": european_proxy(), "roundTrips": [
        round_trip("put", 5000, .52, 60 * DAY), round_trip("call", 6400, .48, 35 * DAY, 6400),
        round_trip("call", 5005, .48, 61),
    ], "margin": margin_reference()}
    out = Path(__file__).resolve().parents[1] / "fixtures" / "ggal_pieza_a3_a4_reference.json"
    out.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
