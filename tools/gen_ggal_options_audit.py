"""Oráculos independientes para casos de auditoría. Solo biblioteca estándar."""
import json
import math
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


root = Path(__file__).resolve().parents[1]
strike, premium, shares = 100, 5, 100
fee = Decimal("0.00242") * premium * shares
# En S=0 la put vendida debe pagar todo el strike. La prima compensa esa pérdida.
loss = (strike - premium) * shares + fee
gammas = []
for remaining in (300, 3600):
    t = remaining / (365 * 86400)
    sigma_t = 0.2 * math.sqrt(t)
    # Call ATM, r=q=0. Segunda derivada analítica respecto del spot.
    gamma = math.exp(-0.5 * (sigma_t / 2) ** 2) / (math.sqrt(2 * math.pi) * strike * sigma_t)
    gammas.append(dict(seconds=remaining, gamma=gamma))

now = int(datetime(2026, 11, 17, 15, tzinfo=timezone.utc).timestamp())
ticks = [{"timeSec": now, "price": 50, "size": 3},
         {"timeSec": now - 60, "price": 40, "size": 8}]
current = sorted((t for t in ticks if t["timeSec"] // 60 == now // 60), key=lambda t: t["timeSec"])
anexo = [("DI", 100, 200), ("FE", 400, 800)]
fixture = {
    "put": {"strike": strike, "premium": premium, "qty": 1, "fee": float(fee), "loss": float(loss)},
    "atmGamma": gammas,
    "expiry": int(datetime(2026, 12, 18, 21, tzinfo=timezone.utc).timestamp()),
    "ticks": ticks, "currentClose": current[-1]["price"], "currentVolume": sum(t["size"] for t in current),
    "ars": 6000, "ratio": 10, "simultaneousCcl": 6000 * 10 / current[-1]["price"],
    "anexoText": "\n".join(f"GFGC6000{month} {covered} {uncovered} 0 0" for month, covered, uncovered in anexo),
    "decemberUncovered": sum(uncovered for month, _, uncovered in anexo if month == "DI"),
}
(root / "fixtures/ggal_options_audit.json").write_bytes(
    (json.dumps(fixture, indent=2) + "\n").encode("utf-8")
)
