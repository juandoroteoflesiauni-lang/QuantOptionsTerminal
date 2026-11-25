"""Frozen 56-symbol stratified pilot universe schema and Pydantic loader.

Note on survivorship bias:
    Freezing this pilot universe prevents retrospective cherry-picking during
    research evaluation, but it does NOT eliminate survivorship bias because
    instruments were curated retrospectively rather than reconstructed from a
    point-in-time master of all tradable US equities. Furthermore, for
    delisted tickers, ``delisted_date`` records the provider delisting date and
    must not be equated automatically with the last tradable session.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EXPECTED_STRATUM_COUNTS: dict[str, int] = {
    "US_ETF": 6,
    "MEGA_CAP": 12,
    "MID_HIGH_BETA_CATALYST": 15,
    "US_ADR": 12,
    "DELISTED": 11,
}
EXPECTED_TOTAL_INSTRUMENTS = 56

_TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,10}$")
_FIGI_RE = re.compile(r"^BBG[A-Z0-9]{9}$")
_CIK_RE = re.compile(r"^\d{10}$")


class AssetClass(StrEnum):
    US_ETF = "US_ETF"
    US_EQUITY = "US_EQUITY"
    US_ADR = "US_ADR"
    DELISTED = "DELISTED"


class Stratum(StrEnum):
    US_ETF = "US_ETF"
    MEGA_CAP = "MEGA_CAP"
    MID_HIGH_BETA_CATALYST = "MID_HIGH_BETA_CATALYST"
    US_ADR = "US_ADR"
    DELISTED = "DELISTED"


_STRATUM_TO_ASSET_CLASS: dict[Stratum, AssetClass] = {
    Stratum.US_ETF: AssetClass.US_ETF,
    Stratum.MEGA_CAP: AssetClass.US_EQUITY,
    Stratum.MID_HIGH_BETA_CATALYST: AssetClass.US_EQUITY,
    Stratum.US_ADR: AssetClass.US_ADR,
    Stratum.DELISTED: AssetClass.DELISTED,
}


class DateWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: dt.date
    end: dt.date

    @field_validator("start", "end", mode="before")
    @classmethod
    def _require_iso_date_str(cls, v: Any) -> dt.date:
        if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError(f"Expected ISO date string YYYY-MM-DD, got {v!r}")
        return dt.date.fromisoformat(v)

    @model_validator(mode="after")
    def _check_order(self) -> DateWindow:
        if self.start >= self.end:
            raise ValueError(f"Window start ({self.start}) must precede end ({self.end})")
        return self


class FalsificationWindows(BaseModel):
    model_config = ConfigDict(extra="forbid")

    core: DateWindow
    opra_flow: DateWindow
    macro_wham: DateWindow

    @model_validator(mode="after")
    def _check_chronology(self) -> FalsificationWindows:
        if not (self.core.start <= self.opra_flow.start <= self.macro_wham.start):
            raise ValueError("Expected core.start <= opra_flow.start <= macro_wham.start")
        if not (self.core.end == self.opra_flow.end == self.macro_wham.end):
            raise ValueError("All frozen falsification windows must share the same cutoff end date")
        return self


class InstrumentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ticker: str
    asset_class: AssetClass
    stratum: Stratum
    in_repo_universe: bool
    is_delisted: bool = False
    delisted_date: dt.date | None = None
    composite_figi: str | None = None
    cik: str | None = None

    @field_validator("ticker")
    @classmethod
    def _validate_ticker(cls, v: str) -> str:
        if not _TICKER_RE.fullmatch(v):
            raise ValueError(f"Invalid ticker format: {v!r}")
        return v

    @field_validator("delisted_date", mode="before")
    @classmethod
    def _validate_delisted_date(cls, v: Any) -> dt.date | None:
        if v is None:
            return None
        if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError(f"delisted_date must be YYYY-MM-DD string, got {v!r}")
        return dt.date.fromisoformat(v)

    @field_validator("composite_figi")
    @classmethod
    def _validate_figi(cls, v: str | None) -> str | None:
        if v is not None and not _FIGI_RE.fullmatch(v):
            raise ValueError(f"Invalid composite_figi format: {v!r}")
        return v

    @field_validator("cik", mode="before")
    @classmethod
    def _validate_cik_leading_zeros(cls, v: Any) -> str | None:
        if v is None:
            return None
        if not isinstance(v, str) or not _CIK_RE.fullmatch(v):
            raise ValueError(f"CIK must be a 10-character zero-padded string, got {v!r}")
        return v

    @model_validator(mode="after")
    def _validate_stratum_contract(self) -> InstrumentSpec:
        expected_ac = _STRATUM_TO_ASSET_CLASS[self.stratum]
        if self.asset_class != expected_ac:
            raise ValueError(
                f"{self.ticker}: asset_class={self.asset_class} incompatible with stratum={self.stratum}"
            )
        if self.stratum == Stratum.DELISTED:
            if not self.is_delisted or self.in_repo_universe:
                raise ValueError(f"{self.ticker}: DELISTED requires is_delisted=True and in_repo_universe=False")
            if self.delisted_date is None or self.composite_figi is None or self.cik is None:
                raise ValueError(f"{self.ticker}: DELISTED requires delisted_date, composite_figi, and cik")
        else:
            if self.is_delisted:
                raise ValueError(f"{self.ticker}: active stratum cannot have is_delisted=True")
            if self.delisted_date is not None:
                raise ValueError(f"{self.ticker}: active instrument cannot declare delisted_date")
            if self.stratum == Stratum.US_ADR:
                expected_repo = self.ticker != "BABA"
                if self.in_repo_universe != expected_repo:
                    raise ValueError(
                        f"{self.ticker}: US_ADR in_repo_universe must be {expected_repo}"
                    )
            elif not self.in_repo_universe:
                raise ValueError(f"{self.ticker}: active non-ADR pilot symbol must have in_repo_universe=True")
        return self


class PilotUniverse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(ge=1)
    frozen_at_date: dt.date
    methodology_note: str = Field(min_length=20)
    windows: FalsificationWindows
    instruments: list[InstrumentSpec]

    @field_validator("frozen_at_date", mode="before")
    @classmethod
    def _validate_frozen_date(cls, v: Any) -> dt.date:
        if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError(f"frozen_at_date must be YYYY-MM-DD string, got {v!r}")
        return dt.date.fromisoformat(v)

    @model_validator(mode="after")
    def _validate_universe_invariants(self) -> PilotUniverse:
        if len(self.instruments) != EXPECTED_TOTAL_INSTRUMENTS:
            raise ValueError(
                f"Expected exactly {EXPECTED_TOTAL_INSTRUMENTS} instruments, got {len(self.instruments)}"
            )
        seen_tickers: set[str] = set()
        seen_figis: set[str] = set()
        seen_ciks: set[str] = set()
        stratum_counts: dict[str, int] = {k: 0 for k in EXPECTED_STRATUM_COUNTS}

        for inst in self.instruments:
            if inst.ticker in seen_tickers:
                raise ValueError(f"Duplicate ticker in pilot universe: {inst.ticker}")
            seen_tickers.add(inst.ticker)
            if inst.composite_figi is not None:
                if inst.composite_figi in seen_figis:
                    raise ValueError(f"Duplicate composite_figi in pilot universe: {inst.composite_figi}")
                seen_figis.add(inst.composite_figi)
            if inst.cik is not None:
                if inst.cik in seen_ciks:
                    raise ValueError(f"Duplicate cik in pilot universe: {inst.cik}")
                seen_ciks.add(inst.cik)
            stratum_counts[inst.stratum.value] += 1

        if stratum_counts != EXPECTED_STRATUM_COUNTS:
            raise ValueError(
                f"Invalid stratum counts {stratum_counts}; expected {EXPECTED_STRATUM_COUNTS}"
            )
        return self

    def by_ticker(self) -> dict[str, InstrumentSpec]:
        return {inst.ticker: inst for inst in self.instruments}

    def tickers(self) -> list[str]:
        return [inst.ticker for inst in self.instruments]


def default_pilot_universe_path() -> Path:
    return Path(__file__).resolve().parents[2] / "config" / "pilot_universe.json"


def load_pilot_universe(path: Path | None = None) -> PilotUniverse:
    """Load and strictly validate the frozen 56-symbol pilot universe."""
    target = path or default_pilot_universe_path()
    raw = json.loads(target.read_text(encoding="utf-8"))
    return PilotUniverse.model_validate(raw)
