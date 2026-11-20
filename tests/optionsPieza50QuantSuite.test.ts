import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyVannaRegime,
  computeCharmPinStrike,
  computeDealerExposure,
  type ExposureContractInput,
  type StrikeExposure,
  type VannaRegime,
} from '../src/core/options/exposure.js';
import {
  computeActiveExpirySkewAndIvRegime,
  type SkewContractPointInput,
} from '../src/core/options/volMetrics.js';
import {
  buildWhatIfHeatmapAndAttribution,
  WHAT_IF_HEATMAP_IV_SHIFT_STEPS,
  WHAT_IF_HEATMAP_SIGMA_STEPS,
  type WhatIfOptionLeg,
} from '../src/core/options/whatIfPayoff.js';

interface VannaRegimeCase {
  readonly name: string;
  readonly netVex: number | 'NaN';
  readonly neutralEpsilon: number | null;
  readonly expected: VannaRegime;
}

interface CharmPinCase {
  readonly name: string;
  readonly spot: number;
  readonly rows: readonly { readonly strike: number; readonly netCharmExposure: number | 'NaN' }[];
  readonly expected: number | 'NaN';
}

interface RawExposureContract {
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly openInterest: number;
  readonly sharesPerContract: number;
  readonly iv: number | null;
}

interface DealerExposureCase {
  readonly name: string;
  readonly market: {
    readonly spot: number;
    readonly nowUtcSec: number;
    readonly rate: number;
    readonly dividendYield: number;
  };
  readonly contracts: readonly RawExposureContract[];
  readonly expected: {
    readonly callVannaExposure: number | 'NaN';
    readonly putVannaExposure: number | 'NaN';
    readonly netVannaExposure: number | 'NaN';
    readonly callCharmExposure: number | 'NaN';
    readonly putCharmExposure: number | 'NaN';
    readonly netCharmExposure: number | 'NaN';
    readonly vannaRegime: VannaRegime;
    readonly charmPinStrike: number | 'NaN';
    readonly byStrike: readonly {
      readonly strike: number;
      readonly callVannaExposure: number;
      readonly putVannaExposure: number;
      readonly netVannaExposure: number;
      readonly callCharmExposure: number;
      readonly putCharmExposure: number;
      readonly netCharmExposure: number;
    }[];
    readonly quality: {
      readonly usableContracts: number;
      readonly skippedContracts: number;
      readonly zeroOiContracts: number;
      readonly countsByReason: Readonly<Record<string, number>>;
    };
  };
}

interface SkewRegimeCase {
  readonly name: string;
  readonly input: {
    readonly spot: number;
    readonly timeToExpiryYears: number;
    readonly rate: number;
    readonly dividendYield: number;
    readonly contracts: readonly {
      readonly strike: number;
      readonly contractType: 'call' | 'put';
      readonly iv: number | null;
      readonly delta?: number | null;
    }[];
    readonly historicalIv1y?: readonly (number | null)[] | null;
    readonly currentIvOverride?: number | null;
    readonly minHistorySessions?: number;
  };
  readonly expected: {
    readonly iv25CallPct: number | null;
    readonly iv25PutPct: number | null;
    readonly ivAtmPct: number | null;
    readonly rr25Pts: number | null;
    readonly bf25Pts: number | null;
    readonly ivr: number | null;
    readonly ivp: number | null;
    readonly validHistorySessions: number;
  };
}

interface RawHeatmapLeg {
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly quantity: number;
  readonly iv: number;
  readonly timeToExpiry: number;
  readonly entryPrice: number;
}

interface HeatmapCase {
  readonly name: string;
  readonly input: {
    readonly referenceSpot: number;
    readonly legs: readonly RawHeatmapLeg[];
    readonly rate: number;
    readonly dividendYield: number;
    readonly elapsedDays: number;
    readonly horizonDte: number;
    readonly targetSpot?: number;
    readonly targetIvShiftPts?: number;
    readonly oneSigmaMoveAbs?: number;
    readonly selectedCell?: { readonly row: number; readonly col: number } | null;
  };
  readonly expected: {
    readonly isValid: boolean;
    readonly oneSigmaMoveAbs: number | 'NaN';
    readonly sigmaMultipliers: readonly number[];
    readonly spotGrid: readonly number[];
    readonly ivShiftGridPts: readonly number[];
    readonly cells: readonly (readonly {
      readonly rowIndex: number;
      readonly colIndex: number;
      readonly ivShiftPts: number;
      readonly sigmaMultiplier: number;
      readonly spot: number;
      readonly pnlUsd: number;
      readonly ivClampedLegs: number;
    }[])[];
    readonly minPnlUsd: number | 'NaN';
    readonly maxPnlUsd: number | 'NaN';
    readonly attribution: {
      readonly referenceSpot: number | 'NaN';
      readonly targetSpot: number | 'NaN';
      readonly deltaSpot: number | 'NaN';
      readonly deltaIvPts: number | 'NaN';
      readonly elapsedDays: number | 'NaN';
      readonly totalBsmPnl: number | 'NaN';
      readonly totalPositionPnl: number | 'NaN';
      readonly deltaPnl: number | 'NaN';
      readonly gammaPnl: number | 'NaN';
      readonly thetaPnl: number | 'NaN';
      readonly vegaPnl: number | 'NaN';
      readonly residualPnl: number | 'NaN';
    };
  };
}

interface Pieza50Fixture {
  readonly meta: { readonly generator: string; readonly tolerance: number };
  readonly vannaRegimeCases: readonly VannaRegimeCase[];
  readonly charmPinCases: readonly CharmPinCase[];
  readonly dealerExposureCases: readonly DealerExposureCase[];
  readonly skewRegimeCases: readonly SkewRegimeCase[];
  readonly heatmapCases: readonly HeatmapCase[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'options_pieza50_reference.json');
const fixture: Pieza50Fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Pieza50Fixture;
const TOL = fixture.meta.tolerance;

type JsonNumber = number | 'NaN';

function decodeJsonNumber(value: JsonNumber | null): number | null {
  if (value === null) return null;
  return value === 'NaN' ? Number.NaN : value;
}

function expectJsonNumber(actual: number, expected: JsonNumber): void {
  if (expected === 'NaN') {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(Number.isFinite(actual)).toBe(true);
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
  }
}

function expectNullableNumber(actual: number | null, expected: JsonNumber | null): void {
  if (expected === null) {
    expect(actual).toBeNull();
  } else if (expected === 'NaN') {
    expect(actual === null || Number.isNaN(actual)).toBe(true);
  } else {
    expect(actual).not.toBeNull();
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(TOL);
  }
}

function makeStrikeExposure(strike: number, netCharmExposure: number): StrikeExposure {
  return {
    strike,
    callOpenInterest: 0,
    putOpenInterest: 0,
    totalOpenInterest: 0,
    callVolume: 0,
    putVolume: 0,
    totalVolume: 0,
    callGex: 0,
    putGex: 0,
    netGex: 0,
    absGex: 0,
    callSpotGamma: 0,
    putSpotGamma: 0,
    netSpotGamma: 0,
    callDex: 0,
    putDex: 0,
    netDex: 0,
    callVannaExposure: 0,
    putVannaExposure: 0,
    netVannaExposure: 0,
    callCharmExposure: 0,
    putCharmExposure: 0,
    netCharmExposure,
  };
}

function hydrateExposureContracts(raws: readonly RawExposureContract[]): ExposureContractInput[] {
  return raws.map((raw) => {
    const out: ExposureContractInput = {
      contractType: raw.contractType,
      strike: raw.strike,
      expiryUtcSec: raw.expiryUtcSec,
      openInterest: raw.openInterest,
      sharesPerContract: raw.sharesPerContract,
      iv: raw.iv,
    };
    return out;
  });
}

function hydrateSkewContracts(
  raws: SkewRegimeCase['input']['contracts'],
): SkewContractPointInput[] {
  return raws.map((raw) => {
    const out: {
      strike: number;
      contractType: 'call' | 'put';
      iv: number | null;
      delta?: number | null;
    } = {
      strike: raw.strike,
      contractType: raw.contractType,
      iv: raw.iv,
    };
    if (raw.delta !== undefined) {
      out.delta = raw.delta;
    }
    return out;
  });
}

function hydrateHeatmapLegs(raws: readonly RawHeatmapLeg[]): WhatIfOptionLeg[] {
  return raws.map((raw) => ({
    contractType: raw.contractType,
    strike: raw.strike,
    quantity: raw.quantity,
    iv: raw.iv,
    timeToExpiry: raw.timeToExpiry,
    entryPrice: raw.entryPrice,
  }));
}

describe('Pieza 50 — VEX/CEX, Skew 25Δ + IVR/IVP y Heatmap 2D Spot × ΔIV (referencia Python <= 1e-9)', () => {
  describe('1. Vanna (VEX), Charm (CEX), régimen y Charm Pin de dealers', () => {
    it('clasifica los 3 regímenes de Vanna (incluye banda neutral, NaN y epsilon custom)', () => {
      for (const testCase of fixture.vannaRegimeCases) {
        const netVex = decodeJsonNumber(testCase.netVex);
        if (netVex === null) {
          throw new Error(`Missing netVex for ${testCase.name}`);
        }
        const actual =
          testCase.neutralEpsilon === null
            ? classifyVannaRegime(netVex)
            : classifyVannaRegime(netVex, testCase.neutralEpsilon);
        expect(actual, testCase.name).toBe(testCase.expected);
      }
    });

    it('resuelve Charm Pin con desempate por proximidad a spot y menor strike (sin mutar filas)', () => {
      for (const testCase of fixture.charmPinCases) {
        const rows = testCase.rows.map((row) => {
          const value = decodeJsonNumber(row.netCharmExposure);
          if (value === null) {
            throw new Error(`Missing netCharmExposure for ${testCase.name}`);
          }
          return makeStrikeExposure(row.strike, value);
        });
        const serializeRows = (): string =>
          JSON.stringify(
            rows.map((row) => [
              row.strike,
              Number.isFinite(row.netCharmExposure) ? row.netCharmExposure : 'NaN',
            ]),
          );
        const snapshot = serializeRows();
        const actual = computeCharmPinStrike(rows, testCase.spot);
        expectJsonNumber(actual, testCase.expected);
        expect(serializeRows(), `${testCase.name} no debe mutar las filas`).toBe(snapshot);
      }
    });

    it('valida netVannaExposure/netCharmExposure por strike y agregados contra referencia Python (q > 0, q = 0)', () => {
      for (const testCase of fixture.dealerExposureCases) {
        const contracts = hydrateExposureContracts(testCase.contracts);
        const snapshot = JSON.stringify(contracts);
        const exposure = computeDealerExposure(contracts, testCase.market);
        expect(JSON.stringify(contracts), `${testCase.name} no debe mutar contratos`).toBe(snapshot);

        expectJsonNumber(exposure.callVannaExposure, testCase.expected.callVannaExposure);
        expectJsonNumber(exposure.putVannaExposure, testCase.expected.putVannaExposure);
        expectJsonNumber(exposure.netVannaExposure, testCase.expected.netVannaExposure);
        expectJsonNumber(exposure.callCharmExposure, testCase.expected.callCharmExposure);
        expectJsonNumber(exposure.putCharmExposure, testCase.expected.putCharmExposure);
        expectJsonNumber(exposure.netCharmExposure, testCase.expected.netCharmExposure);
        expect(exposure.vannaRegime).toBe(testCase.expected.vannaRegime);
        expectJsonNumber(exposure.charmPinStrike, testCase.expected.charmPinStrike);

        expect(exposure.quality.usableContracts).toBe(testCase.expected.quality.usableContracts);
        expect(exposure.quality.skippedContracts).toBe(testCase.expected.quality.skippedContracts);
        expect(exposure.quality.zeroOiContracts).toBe(testCase.expected.quality.zeroOiContracts);
        for (const [reason, count] of Object.entries(testCase.expected.quality.countsByReason)) {
          expect(exposure.quality.countsByReason[reason as keyof typeof exposure.quality.countsByReason])
            .toBe(count);
        }

        expect(exposure.byStrike.length).toBe(testCase.expected.byStrike.length);
        for (const expectedRow of testCase.expected.byStrike) {
          const row = exposure.byStrike.find((s) => s.strike === expectedRow.strike);
          if (row === undefined) {
            throw new Error(`Falta strike ${String(expectedRow.strike)} en ${testCase.name}`);
          }
          expectJsonNumber(row.callVannaExposure, expectedRow.callVannaExposure);
          expectJsonNumber(row.putVannaExposure, expectedRow.putVannaExposure);
          expectJsonNumber(row.netVannaExposure, expectedRow.netVannaExposure);
          expectJsonNumber(row.callCharmExposure, expectedRow.callCharmExposure);
          expectJsonNumber(row.putCharmExposure, expectedRow.putCharmExposure);
          expectJsonNumber(row.netCharmExposure, expectedRow.netCharmExposure);
        }
      }
    });

    it('gate seguro: iv: null + contrato expirado + OI 0 no contaminan con NaN el agregado del strike', () => {
      const clean = fixture.dealerExposureCases.find((c) => c.name === 'multi_strike_q_positive');
      const mixed = fixture.dealerExposureCases.find((c) => c.name === 'invalid_gate_mixed_adds_zero');
      const onlyInvalid = fixture.dealerExposureCases.find((c) => c.name === 'only_invalid_degrades_to_nan');
      if (!clean || !mixed || !onlyInvalid) {
        throw new Error('Faltan casos de gate en el fixture');
      }

      const cleanExposure = computeDealerExposure(
        hydrateExposureContracts(clean.contracts),
        clean.market,
      );
      const mixedExposure = computeDealerExposure(
        hydrateExposureContracts(mixed.contracts),
        mixed.market,
      );

      expect(mixedExposure.quality.skippedContracts).toBe(2);
      expect(mixedExposure.byStrike.length).toBe(cleanExposure.byStrike.length);
      expect(
        Math.abs(mixedExposure.netVannaExposure - cleanExposure.netVannaExposure),
      ).toBeLessThanOrEqual(TOL);
      expect(
        Math.abs(mixedExposure.netCharmExposure - cleanExposure.netCharmExposure),
      ).toBeLessThanOrEqual(TOL);
      expect(Number.isNaN(mixedExposure.netVannaExposure)).toBe(false);
      expect(Number.isNaN(mixedExposure.netCharmExposure)).toBe(false);
      expect(mixedExposure.charmPinStrike).toBe(cleanExposure.charmPinStrike);

      const invalidExposure = computeDealerExposure(
        hydrateExposureContracts(onlyInvalid.contracts),
        onlyInvalid.market,
      );
      expect(Number.isNaN(invalidExposure.netVannaExposure)).toBe(true);
      expect(Number.isNaN(invalidExposure.netCharmExposure)).toBe(true);
      expect(Number.isNaN(invalidExposure.charmPinStrike)).toBe(true);
      expect(invalidExposure.vannaRegime).toBe('NEUTRAL');
      expect(invalidExposure.byStrike).toHaveLength(0);
    });
  });

  describe('2. Skew 25Δ (RR/BF) e IVR/IVP 1Y', () => {
    it('valida sonrisa sintética de 9 strikes, nulls intercalados, sin bracketing y deltas BSM calculados', () => {
      for (const testCase of fixture.skewRegimeCases) {
        const contracts = hydrateSkewContracts(testCase.input.contracts);
        const snapshot = JSON.stringify(testCase.input);
        const result = computeActiveExpirySkewAndIvRegime({
          spot: testCase.input.spot,
          timeToExpiryYears: testCase.input.timeToExpiryYears,
          rate: testCase.input.rate,
          dividendYield: testCase.input.dividendYield,
          contracts,
          historicalIv1y: testCase.input.historicalIv1y ?? null,
          currentIvOverride: testCase.input.currentIvOverride ?? null,
          ...(testCase.input.minHistorySessions !== undefined
            ? { minHistorySessions: testCase.input.minHistorySessions }
            : {}),
        });
        expect(JSON.stringify(testCase.input), `${testCase.name} no debe mutar el input`).toBe(snapshot);

        expectNullableNumber(result.iv25CallPct, testCase.expected.iv25CallPct);
        expectNullableNumber(result.iv25PutPct, testCase.expected.iv25PutPct);
        expectNullableNumber(result.ivAtmPct, testCase.expected.ivAtmPct);
        expectNullableNumber(result.rr25Pts, testCase.expected.rr25Pts);
        expectNullableNumber(result.bf25Pts, testCase.expected.bf25Pts);
        expectNullableNumber(result.ivr, testCase.expected.ivr);
        expectNullableNumber(result.ivp, testCase.expected.ivp);
        expect(result.validHistorySessions).toBe(testCase.expected.validHistorySessions);
      }
    });

    it('RR_25 = IV_25P − IV_25C y BF_25 = 0.5*(IV25P + IV25C) − IV_ATM en el caso base', () => {
      const testCase = fixture.skewRegimeCases.find((c) => c.name === 'smile_9_strikes_exact_deltas');
      if (!testCase) {
        throw new Error('Falta el caso base de sonrisa');
      }
      const result = computeActiveExpirySkewAndIvRegime({
        spot: testCase.input.spot,
        timeToExpiryYears: testCase.input.timeToExpiryYears,
        rate: testCase.input.rate,
        dividendYield: testCase.input.dividendYield,
        contracts: hydrateSkewContracts(testCase.input.contracts),
      });
      if (result.iv25PutPct === null || result.iv25CallPct === null || result.ivAtmPct === null) {
        throw new Error('El caso base debe ser interpolable');
      }
      expect(Math.abs((result.rr25Pts ?? Number.NaN) - (result.iv25PutPct - result.iv25CallPct)))
        .toBeLessThanOrEqual(TOL);
      expect(
        Math.abs(
          (result.bf25Pts ?? Number.NaN) -
            (0.5 * (result.iv25PutPct + result.iv25CallPct) - result.ivAtmPct),
        ),
      ).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.rr25Pts ?? Number.NaN)).toBeGreaterThan(0);
    });

    it('IVR/IVP degradan a null con historial insuficiente (< 20), serie constante o IV actual nula', () => {
      for (const name of [
        'history_len_19_below_min_degrades_null',
        'constant_series_ivr_null_ivp_full',
        'expired_expiry_degrades_all_null',
        'non_positive_spot_degrades_all_null',
      ]) {
        const testCase = fixture.skewRegimeCases.find((c) => c.name === name);
        if (!testCase) {
          throw new Error(`Falta el caso ${name}`);
        }
        const result = computeActiveExpirySkewAndIvRegime({
          spot: testCase.input.spot,
          timeToExpiryYears: testCase.input.timeToExpiryYears,
          rate: testCase.input.rate,
          dividendYield: testCase.input.dividendYield,
          contracts: hydrateSkewContracts(testCase.input.contracts),
          historicalIv1y: testCase.input.historicalIv1y ?? null,
          currentIvOverride: testCase.input.currentIvOverride ?? null,
        });
        expect(result.ivr, name).toBeNull();
        if (name !== 'constant_series_ivr_null_ivp_full') {
          expect(result.ivp, name).toBeNull();
        } else {
          // Serie constante 0.25 con IV actual 0.28: todas las sesiones cumplen `<` estricto ⇒ IVP = 100
          // y IVR = null por IV_max === IV_min (sin ocultar el null con clamping).
          expect(result.ivp).toBe(100);
        }
      }
    });
  });

  describe('3. Heatmap 2D 7×7 Spot × ΔIV y Atribución de Griegas (Taylor 2.º orden)', () => {
    it('valida las 49 celdas y la atribución completa contra referencia Python <= 1e-9', () => {
      for (const testCase of fixture.heatmapCases) {
        const legs = hydrateHeatmapLegs(testCase.input.legs);
        const snapshot = JSON.stringify(testCase.input);
        const input: Parameters<typeof buildWhatIfHeatmapAndAttribution>[0] = {
          referenceSpot: testCase.input.referenceSpot,
          legs,
          rate: testCase.input.rate,
          dividendYield: testCase.input.dividendYield,
          elapsedDays: testCase.input.elapsedDays,
          horizonDte: testCase.input.horizonDte,
          ...(testCase.input.targetSpot !== undefined ? { targetSpot: testCase.input.targetSpot } : {}),
          ...(testCase.input.targetIvShiftPts !== undefined
            ? { targetIvShiftPts: testCase.input.targetIvShiftPts }
            : {}),
          ...(testCase.input.oneSigmaMoveAbs !== undefined
            ? { oneSigmaMoveAbs: testCase.input.oneSigmaMoveAbs }
            : {}),
          ...(testCase.input.selectedCell !== undefined ? { selectedCell: testCase.input.selectedCell } : {}),
        };
        const result = buildWhatIfHeatmapAndAttribution(input);
        expect(JSON.stringify(testCase.input), `${testCase.name} no debe mutar el input`).toBe(snapshot);

        expect(result.isValid, testCase.name).toBe(testCase.expected.isValid);
        expectJsonNumber(result.oneSigmaMoveAbs, testCase.expected.oneSigmaMoveAbs);

        if (!testCase.expected.isValid) {
          expect(result.cells).toHaveLength(0);
          expect(result.spotGrid).toHaveLength(0);
          expect(result.ivShiftGridPts).toHaveLength(0);
          expect(Number.isNaN(result.minPnlUsd)).toBe(true);
          expect(Number.isNaN(result.maxPnlUsd)).toBe(true);
          expect(Number.isNaN(result.attribution.totalBsmPnl)).toBe(true);
          expect(Number.isNaN(result.attribution.residualPnl)).toBe(true);
          continue;
        }

        expect(result.sigmaMultipliers).toEqual(testCase.expected.sigmaMultipliers);
        expect(result.ivShiftGridPts).toEqual(testCase.expected.ivShiftGridPts);
        expect(result.spotGrid.length).toBe(testCase.expected.spotGrid.length);
        result.spotGrid.forEach((spotValue, idx) => {
          expectJsonNumber(spotValue, testCase.expected.spotGrid[idx] ?? 'NaN');
        });

        expect(result.cells.length).toBe(testCase.expected.cells.length);
        for (let row = 0; row < testCase.expected.cells.length; row += 1) {
          const expectedRow = testCase.expected.cells[row];
          const actualRow = result.cells[row];
          if (expectedRow === undefined || actualRow === undefined) {
            throw new Error(`Fila ${String(row)} ausente en ${testCase.name}`);
          }
          expect(actualRow.length).toBe(expectedRow.length);
          for (let col = 0; col < expectedRow.length; col += 1) {
            const expectedCell = expectedRow[col];
            const actualCell = actualRow[col];
            if (expectedCell === undefined || actualCell === undefined) {
              throw new Error(`Celda ${String(row)}/${String(col)} ausente en ${testCase.name}`);
            }
            expect(actualCell.rowIndex).toBe(expectedCell.rowIndex);
            expect(actualCell.colIndex).toBe(expectedCell.colIndex);
            expect(actualCell.ivShiftPts).toBe(expectedCell.ivShiftPts);
            expect(actualCell.sigmaMultiplier).toBe(expectedCell.sigmaMultiplier);
            expectJsonNumber(actualCell.spot, expectedCell.spot);
            expectJsonNumber(actualCell.pnlUsd, expectedCell.pnlUsd);
            expectJsonNumber(actualCell.ivClampedLegs, expectedCell.ivClampedLegs);
          }
        }

        expectJsonNumber(result.minPnlUsd, testCase.expected.minPnlUsd);
        expectJsonNumber(result.maxPnlUsd, testCase.expected.maxPnlUsd);

        const attribution = result.attribution;
        const expectedAttribution = testCase.expected.attribution;
        expectJsonNumber(attribution.referenceSpot, expectedAttribution.referenceSpot);
        expectJsonNumber(attribution.targetSpot, expectedAttribution.targetSpot);
        expectJsonNumber(attribution.deltaSpot, expectedAttribution.deltaSpot);
        expectJsonNumber(attribution.deltaIvPts, expectedAttribution.deltaIvPts);
        expectJsonNumber(attribution.elapsedDays, expectedAttribution.elapsedDays);
        expectJsonNumber(attribution.totalBsmPnl, expectedAttribution.totalBsmPnl);
        expectJsonNumber(attribution.totalPositionPnl, expectedAttribution.totalPositionPnl);
        expectJsonNumber(attribution.deltaPnl, expectedAttribution.deltaPnl);
        expectJsonNumber(attribution.gammaPnl, expectedAttribution.gammaPnl);
        expectJsonNumber(attribution.thetaPnl, expectedAttribution.thetaPnl);
        expectJsonNumber(attribution.vegaPnl, expectedAttribution.vegaPnl);
        expectJsonNumber(attribution.residualPnl, expectedAttribution.residualPnl);
      }
    });

    it('identidad de shock cero: ΔS = 0, ΔIV = 0 y T+0 ⇒ componentes y residuo exactamente 0', () => {
      const testCase = fixture.heatmapCases.find((c) => c.name === 'zero_shock_identity');
      if (!testCase) {
        throw new Error('Falta el caso de identidad de shock cero');
      }
      const result = buildWhatIfHeatmapAndAttribution({
        referenceSpot: testCase.input.referenceSpot,
        legs: hydrateHeatmapLegs(testCase.input.legs),
        rate: testCase.input.rate,
        dividendYield: testCase.input.dividendYield,
        elapsedDays: 0,
        horizonDte: testCase.input.horizonDte,
        targetSpot: testCase.input.referenceSpot,
        targetIvShiftPts: 0,
      });
      expect(result.isValid).toBe(true);
      expect(Math.abs(result.attribution.totalBsmPnl)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.attribution.deltaPnl)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.attribution.gammaPnl)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.attribution.thetaPnl)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.attribution.vegaPnl)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(result.attribution.residualPnl)).toBeLessThanOrEqual(TOL);
    });

    it('la celda seleccionada (selectedCell) fija el objetivo en spotGrid[col] e ivShiftGridPts[row]', () => {
      const testCase = fixture.heatmapCases.find((c) => c.name === 'selected_cell_row1_col5_target');
      if (!testCase || !testCase.input.selectedCell) {
        throw new Error('Falta el caso de celda seleccionada');
      }
      const result = buildWhatIfHeatmapAndAttribution({
        referenceSpot: testCase.input.referenceSpot,
        legs: hydrateHeatmapLegs(testCase.input.legs),
        rate: testCase.input.rate,
        dividendYield: testCase.input.dividendYield,
        elapsedDays: testCase.input.elapsedDays,
        horizonDte: testCase.input.horizonDte,
        selectedCell: testCase.input.selectedCell,
      });
      expect(result.isValid).toBe(true);
      expect(result.attribution.targetSpot).toBe(result.spotGrid[testCase.input.selectedCell.col]);
      expect(result.attribution.deltaIvPts).toBe(
        WHAT_IF_HEATMAP_IV_SHIFT_STEPS[testCase.input.selectedCell.row],
      );
      expect(result.attribution.targetSpot).toBe(
        testCase.input.referenceSpot +
          (WHAT_IF_HEATMAP_SIGMA_STEPS[testCase.input.selectedCell.col] ?? 0) *
            result.oneSigmaMoveAbs,
      );
    });
  });
});
