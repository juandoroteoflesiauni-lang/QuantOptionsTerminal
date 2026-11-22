"""Referencia por enumeración de precios en centavos con aritmética decimal."""
import json
from decimal import Decimal
from pathlib import Path


cases = {
    "put vendida": [("Venta", "Put", 100, 1, 5)],
    "put comprada": [("Compra", "Put", 100, 1, 5)],
    "mariposa con centro fuera de la grilla": [
        ("Compra", "Call", 210, 1, 6),
        ("Venta", "Call", 220.13, 2, 3),
        ("Compra", "Call", 230.26, 1, 1),
    ],
    "call lejana comprada": [("Compra", "Call", 400, 1, 2)],
    "call lejana vendida": [("Venta", "Call", 400, 1, 2)],
    "call cubierta": [("Compra", "Subyacente", 0, 100, 100), ("Venta", "Call", 110, 1, 3)],
    "spread de puts": [("Venta", "Put", 100, 2, 5), ("Compra", "Put", 90, 2, 2)],
    "una acción corta": [("Venta", "Subyacente", 0, 1, 1)],
}

reference = []
for name, legs in cases.items():
    positions = []
    for side, kind, strike, quantity, premium in legs:
        nominal = quantity if kind == "Subyacente" else 100 * quantity
        fee_rate = Decimal("0.000968" if kind == "Subyacente" else "0.00242")
        positions.append((kind, Decimal(str(strike)), nominal if side == "Compra" else -nominal,
                          Decimal(str(premium)), fee_rate))

    def payoff(spot):
        total = Decimal(0)
        for kind, strike, shares, premium, fee_rate in positions:
            cashflow = spot if kind == "Subyacente" else max(0, spot - strike if kind == "Call" else strike - spot)
            total += (cashflow - premium) * shares - abs(premium * shares) * fee_rate
        return total

    end = int(max(row[1] for row in positions) * 100) + 100
    values = [payoff(Decimal(cents) / 100) for cents in range(end + 1)]
    next_value = payoff(Decimal(end + 100) / 100)
    unlimited_gain = next_value > values[-1]
    unlimited_loss = next_value < values[-1]
    reference.append({
        "name": name,
        "spot": 1 if name == "una acción corta" else 100,
        "legs": [dict(side=side, type=kind, strike=strike, qty=qty, premium=premium)
                 for side, kind, strike, qty, premium in legs],
        "maxGain": None if unlimited_gain else float(max(values)),
        "maxLoss": None if unlimited_loss else float(max(0, -min(values))),
        "unlimitedGain": unlimited_gain,
        "unlimitedLoss": unlimited_loss,
    })

path = Path(__file__).resolve().parents[1] / "fixtures/builder_expiry_reference.json"
path.write_bytes((json.dumps(reference, indent=2, ensure_ascii=False) + "\n").encode("utf8"))
