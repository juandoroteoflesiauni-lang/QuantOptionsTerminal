/**
 * Suite Vitest 100 % offline para Pieza P1 A5 + A6:
 *   - A5: Resolución determinista de strikes BYMA sin heurísticas por spot + cuarentena fail-closed.
 *   - A6: Integridad L1 del ADR GGAL (book vs trade vs EOD), prohibición de BBO sintético y bloqueo
 *         de ejecutabilidad cross-venue preservando paridad indicativa y dual-chart.
 *
 * Paridad verificada contra el oráculo Python Decimal (`fixtures/ggal_pieza_a5_a6_reference.json`)
 * con igualdad exacta en identidades/estados/reglas y tolerancia <= 1e-9 en magnitudes numéricas.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import reference from '../fixtures/ggal_pieza_a5_a6_reference.json' with { type: 'json' };
import { resolveBymaContractualExpiry } from '../src/core/ggal/anexoBIdentity.js';
import { normalizeAdrMarketData } from '../src/core/ggal/adrQuoteIntegrity.js';
import { resolveBymaOptionContract, type BymaContractMetadataSource } from '../src/core/ggal/bymaContractResolver.js';
import {
  classifyAndValidateMarginStructure,
  evaluateBymaClearingMargin,
} from '../src/core/ggal/marginRiskExecution.js';
import { evaluateParityGap } from '../src/core/ggal/parityGap.js';
import { priceBsm } from '../src/core/options/blackScholes.js';
import type { FetchFn } from '../src/data/types.js';
import {
  ArgentinaMarketRuntime,
  parseBymaOptionSymbol,
  type ArHttpFn,
} from '../src/server/argentinaMarketLoader.js';
import { FMP_STABLE_BASE_URL } from '../src/server/fmpClient.js';
import {
  AnexoBInputError,
  GgalSpecialistRuntime,
  parseAnexoBIamcInput,
  type GgalMarginRiskResponse,
  type GgalParityGapResponse,
  type GgalSpecialistOverviewResponse,
  type GgalStrategySelectorResponse,
} from '../src/server/ggalSpecialistRuntime.js';
import { createHttpWsServer, type HttpWsServerHandle } from '../src/server/httpWsServer.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import type { TradierConfig } from '../src/server/tradierAdapter.js';

vi.mock('../src/server/envBootstrap.js', () => ({}));

const JSON_FORBIDDEN_TOKEN = /(?<=[:,[])\s*(?:NaN|-?Infinity|undefined)\b/;
const handles: HttpWsServerHandle[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) {
      await h.stop().catch(() => {});
    }
  }
});

function expectWithinTol(actual: number | null | undefined, expected: number | null | undefined, label: string): void {
  if (expected === null || expected === undefined) {
    if (actual === null || actual === undefined) {
      return;
    }
    expect(Number.isFinite(actual), `${label} should not be finite`).toBe(false);
    return;
  }
  expect(actual, `${label} should be finite`).not.toBeNull();
  expect(actual, `${label} should be defined`).not.toBeUndefined();
  const num = actual as number;
  expect(Number.isFinite(num), `${label} must be finite`).toBe(true);
  const absExp = Math.abs(expected);
  const tol = absExp >= 1 ? absExp * 1e-9 : 1e-9;
  expect(Math.abs(num - expected), `${label} diff exceeded 1e-9`).toBeLessThanOrEqual(tol);
}

function buildDailyBars(count: number, endUtcSec: number, startClose: number, drift: number) {
  const endDayMs = Math.floor(endUtcSec / 86_400) * 86_400_000;
  return Array.from({ length: count }, (_, idx) => {
    const revIdx = count - 1 - idx;
    const d = new Date(endDayMs - (revIdx + 1) * 86_400_000);
    const close = Number((startClose + idx * drift + Math.sin(idx * 0.2) * (startClose * 0.012)).toFixed(4));
    return {
      date: d.toISOString().slice(0, 10),
      o: Number((close * 0.996).toFixed(4)),
      h: Number((close * 1.008).toFixed(4)),
      l: Number((close * 0.992).toFixed(4)),
      c: close,
      v: 950_000 + idx * 1_200,
    };
  });
}

function buildCerHistory(endUtcSec: number, count: number) {
  const endDayMs = Math.floor(endUtcSec / 86_400) * 86_400_000;
  return Array.from({ length: count }, (_, idx) => {
    const revIdx = count - 1 - idx;
    const d = new Date(endDayMs - (revIdx + 1) * 86_400_000);
    return {
      fecha: d.toISOString().slice(0, 10),
      valor: Number((540 * Math.exp(0.00085 * idx)).toFixed(4)),
    };
  });
}

describe('Pieza P1 A5 — Integridad contractual BYMA y resolución determinista de strike', () => {
  it('A5-1: mantiene invarianza absoluta al precio spot para símbolos ambiguos sin metadata', () => {
    const { rawSymbol, reportDate, spotValues, expected } = reference.a5SpotInvariance;
    const results = spotValues.map((spot) => {
      const legacy = parseBymaOptionSymbol(rawSymbol, spot, reference.meta.asOfUtcSec);
      const resolved = resolveBymaOptionContract({ rawSymbol, reportDate });
      return { legacy, resolved };
    });

    for (const item of results) {
      expect(item.legacy).toBeNull();
      expect(item.resolved.strike).toBeNull();
      expect(item.resolved.strikeTicks1e4).toBeNull();
      expect(item.resolved.canonicalContractId).toBeNull();
      expect(item.resolved.strikeResolutionStatus).toBe(expected.strikeResolutionStatus);
      expect(item.resolved.strikeSource).toBe(expected.strikeSource);
      expect(item.resolved.normalizationEvidence.scaleFactorApplied).toBeNull();
      expect(item.resolved.normalizationEvidence.exclusionReason).toBe(expected.exclusionReason);
    }

    // Igualdad idéntica en los 4 spots (incluyendo null, 100, 6000, 18000)
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]?.resolved).toEqual(results[0]?.resolved);
    }
  });

  it('A5-2: resuelve series canónicas enteras/decimales y envía ambiguas a cuarentena', () => {
    const reportDate = reference.meta.reportDate;
    for (const testCase of reference.a5SeriesCases) {
      const resolved = resolveBymaOptionContract({ rawSymbol: testCase.rawSymbol, reportDate });
      expect(resolved.strikeResolutionStatus, testCase.rawSymbol).toBe(testCase.expected.strikeResolutionStatus);
      expect(resolved.strikeSource, testCase.rawSymbol).toBe(testCase.expected.strikeSource);
      expect(resolved.canonicalContractId, testCase.rawSymbol).toBe(testCase.expected.canonicalContractId);
      expect(resolved.strikeTicks1e4, testCase.rawSymbol).toBe(testCase.expected.strikeTicks1e4);
      expectWithinTol(resolved.strike, testCase.expected.strike, `${testCase.rawSymbol}.strike`);
      expect(resolved.normalizationEvidence.scaleFactorApplied, testCase.rawSymbol).toBe(
        testCase.expected.scaleFactorApplied,
      );
      expect(resolved.normalizationEvidence.exclusionReason, testCase.rawSymbol).toBe(
        testCase.expected.exclusionReason,
      );

      // parseBymaOptionSymbol nunca varía entre spots extremos
      const pLow = parseBymaOptionSymbol(testCase.rawSymbol, 100, reference.meta.asOfUtcSec);
      const pHigh = parseBymaOptionSymbol(testCase.rawSymbol, 18_000, reference.meta.asOfUtcSec);
      expect(pLow, `${testCase.rawSymbol} invariance`).toEqual(pHigh);
    }
  });

  it('A5-3 & A5-4: acepta metadata autoritativa multi-fuente e impone fail-closed ante conflictos', () => {
    const reportDate = reference.meta.reportDate;

    for (const metaCase of reference.a5ExplicitMetadata) {
      for (const spot of metaCase.spots) {
        const legacy = parseBymaOptionSymbol(
          metaCase.rawSymbol,
          spot,
          reference.meta.asOfUtcSec,
          false,
          [],
          metaCase.metadata.map((m) => ({
            source: m.source as BymaContractMetadataSource,
            nativeSymbol: m.nativeSymbol,
            strike: m.strike,
          })),
        );
        const resolved = resolveBymaOptionContract({
          rawSymbol: metaCase.rawSymbol,
          reportDate,
          metadataRecords: metaCase.metadata.map((m) => ({
            source: m.source as BymaContractMetadataSource,
            nativeSymbol: m.nativeSymbol,
            strike: m.strike,
          })),
        });
        expectWithinTol(resolved.strike, metaCase.expected.strike, `${metaCase.name}@${String(spot)}`);
        expectWithinTol(legacy?.strike ?? null, metaCase.expected.strike, `${metaCase.name}.legacy@${String(spot)}`);
        expect(resolved.strikeResolutionStatus).toBe(metaCase.expected.strikeResolutionStatus);
        expect(resolved.strikeSource).toBe(metaCase.expected.strikeSource);
        expect(resolved.canonicalContractId).toBe(metaCase.expected.canonicalContractId);
        expect(resolved.normalizationEvidence.scaleFactorApplied).toBe(metaCase.expected.scaleFactorApplied);
      }
    }

    for (const confCase of reference.a5Conflicts) {
      const resolved = resolveBymaOptionContract({
        rawSymbol: confCase.rawSymbol,
        reportDate,
        metadataRecords: confCase.metadata.map((m) => ({
          source: m.source as BymaContractMetadataSource,
          nativeSymbol: m.nativeSymbol,
          strike: m.strike,
        })),
      });
      expect(resolved.strike).toBeNull();
      expect(resolved.strikeResolutionStatus).toBe('CONFLICTING_METADATA');
      expect(resolved.normalizationEvidence.conflicts.length).toBe(confCase.expected.conflictsCount);
      expect(parseBymaOptionSymbol(confCase.rawSymbol, confCase.spot, reference.meta.asOfUtcSec, false, [], confCase.metadata.map((m) => ({
        source: m.source as BymaContractMetadataSource,
        nativeSymbol: m.nativeSymbol,
        strike: m.strike,
      })))).toBeNull();
    }
  });

  it('A5-5: rechaza sufijos ambiguos/año ambiguo y alinea feriados entre Anexo B, AR options y resolver', () => {
    const reportDate = reference.meta.reportDate;
    for (const bad of reference.a5ExpiryCases.ambiguousSuffixSymbols) {
      const resolved = resolveBymaOptionContract({ rawSymbol: bad.rawSymbol, reportDate });
      expect(resolved.strikeResolutionStatus).toBe('INVALID_SYMBOL');
      expect(resolved.normalizationEvidence.expiryResolutionError).toBe('AMBIGUOUS_EXPIRY_SUFFIX');
    }

    const twoYears = resolveBymaOptionContract({
      rawSymbol: 'GFGC6000DI',
      reportDate,
      knownExpiries: [
        { expiryCode: 'DI', expirationDate: '2026-12-18' },
        { expiryCode: 'DI', expirationDate: '2027-12-17' },
      ],
    });
    expect(twoYears.strikeResolutionStatus).toBe('INVALID_SYMBOL');
    expect(twoYears.normalizationEvidence.expiryResolutionError).toBe('AMBIGUOUS_EXPIRY_YEAR');

    const holidayExp = resolveBymaContractualExpiry({
      reportDate,
      expiryCode: 'DI',
      arHolidays: ['2026-12-18'],
    });
    const resolvedHoliday = resolveBymaOptionContract({
      rawSymbol: 'GFGC6000DI',
      reportDate,
      arHolidays: ['2026-12-18'],
    });
    const parsedHoliday = parseBymaOptionSymbol(
      'GFGC6000DI',
      6400,
      reference.meta.asOfUtcSec,
      false,
      ['2026-12-18'],
    );
    expect('contractualExpiry' in holidayExp ? holidayExp.contractualExpiry : null).toBe(
      reference.a5ExpiryCases.holidayShift.contractualExpiry,
    );
    expect(resolvedHoliday.contractualExpiry).toBe(reference.a5ExpiryCases.holidayShift.contractualExpiry);
    expect(parsedHoliday?.expirationDate).toBe(reference.a5ExpiryCases.holidayShift.contractualExpiry);
  });

  it('A5-6: envía GFGC62974D a unresolvedContracts, bloquea cálculos y desbloquea tras Anexo B explícito', async () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 10, 16, 15, 30, 0) / 1_000);
    const nowMs = asOfUtcSec * 1_000;
    const diExpSec = Math.floor(Date.UTC(2026, 11, 18, 18, 30, 0) / 1_000);
    const tDi = (diExpSec - asOfUtcSec) / (365 * 86_400);

    const arByDate = buildDailyBars(85, asOfUtcSec, 5950, 5.2);
    const adrByDate = buildDailyBars(85, asOfUtcSec, 49.0, 0.04);
    const al30ByDate = buildDailyBars(85, asOfUtcSec, 75_500, 48);
    const al30cByDate = buildDailyBars(85, asOfUtcSec, 63.0, 0.032);
    const cerSeries = buildCerHistory(asOfUtcSec, 85);

    const argOptionsRows = [
      ...[6000, 6400, 6800, 7200].map((k) => {
        const px = Number(priceBsm({ spot: 6400, strike: k, timeToExpiry: tDi, rate: 0.295, dividendYield: 0, volatility: 0.54, contractType: 'call' }).toFixed(2));
        return { symbol: `GFGC${String(k)}DI`, c: px, px_bid: px * 0.985, px_ask: px * 1.015, v: 5000, v_ars: 5000 * px, open_interest: 4000 };
      }),
      { symbol: 'GFGC62974D', c: 412, px_bid: 405, px_ask: 420, v: 1800, v_ars: 741_600, open_interest: 900 },
    ];

    const jsonRes = (payload: unknown) =>
      Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });

    const fetchFn: ArHttpFn = (url) => {
      const u = new URL(url);
      if (u.hostname.includes('data912')) {
        if (u.pathname === '/live/arg_options') return jsonRes(argOptionsRows);
        if (u.pathname === '/live/arg_stocks') {
          return jsonRes([{ symbol: 'GGAL', c: 6400, px_bid: 6396, px_ask: 6404, prev_close: 6340, v: 500_000 }]);
        }
        if (u.pathname === '/live/arg_bonds') {
          return jsonRes([
            { symbol: 'AL30', c: 77_000, px_bid: 76_950, px_ask: 77_050, v: 1_000_000 },
            { symbol: 'AL30C', c: 64.0, px_bid: 63.9, px_ask: 64.1, v: 800_000 },
          ]);
        }
        if (u.pathname === '/live/arg_notes') return jsonRes([{ symbol: 'S31O6', c: 125.5, tna: 34.2 }]);
        if (u.pathname === '/live/cauciones') return jsonRes([{ symbol: 'PESOS 1D', days: 1, tna: 32.8, c: 32.8 }]);
        if (u.pathname === '/historical/bonds/AL30') return jsonRes(al30ByDate);
        if (u.pathname === '/historical/bonds/AL30C') return jsonRes(al30cByDate);
        if (u.pathname.startsWith('/historical/')) return jsonRes(arByDate);
      }
      if (u.hostname.includes('bcra.gob.ar')) {
        if (u.pathname === '/estadisticas/v4.0/Monetarias/30') return jsonRes({ results: cerSeries });
        return jsonRes({ results: [{ idVariable: 7, descripcion: 'BADLAR TNA', valor: 34.5, fecha: '2026-11-16' }] });
      }
      if (u.hostname.includes('argentinadatos')) {
        return jsonRes([{ fecha: '2026-10-31', valor: 2.3 }]);
      }
      return jsonRes([]);
    };

    const usFetch: FetchFn = (url) => {
      const p = new URL(url).pathname;
      if (p.startsWith('/v2/aggs/ticker/')) {
        return jsonRes({
          status: 'OK',
          results: adrByDate.map((r) => ({
            t: Date.parse(`${r.date}T04:00:00Z`),
            o: r.o,
            h: r.h,
            l: r.l,
            c: r.c,
            v: r.v,
            vw: r.c,
          })),
        });
      }
      return jsonRes({ status: 'OK', results: [] });
    };

    const runtime = new MarketRuntime({ apiKey: 'test-key', enableWs: false, fetchFn: usFetch, nowMsFn: () => nowMs });
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn,
      nowMsFn: () => nowMs,
      minData912IntervalMs: 0,
      usRuntime: runtime,
    });
    const specialist = new GgalSpecialistRuntime({ runtime, arRuntime, fetchFn, nowMsFn: () => nowMs, env: {} });

    // 1. Verificar parseAnexoBIamcInput rechaza rawText ambiguo sin strike y rechaza mismatch,
    //    pero acepta { nativeSeries: 'GFGC62974D', strikeArs: 6297.4 }.
    expect(() =>
      parseAnexoBIamcInput({ asOfDate: '2026-11-16', rawText: 'GFGC62974D 100 200 0 0' }, asOfUtcSec),
    ).toThrowError(AnexoBInputError);
    try {
      parseAnexoBIamcInput({ asOfDate: '2026-11-16', rawText: 'GFGC62974D 100 200 0 0' }, asOfUtcSec);
    } catch (err) {
      expect((err as AnexoBInputError).rejectedRows[0]?.code).toBe('AMBIGUOUS_SCALE_UNRESOLVED');
    }

    const mismatchAnexo = parseAnexoBIamcInput(
      {
        asOfDate: '2026-11-16',
        rawText: 'GFGC6000DI 100 200 0 0',
        rows: [
          {
            strikeArs: 7500,
            nativeSeries: 'GFGC62974D',
            callOi: { coveredNom: 100, uncoveredNom: 200, oppositeNom: 0, crossedNom: 0 },
            putOi: { coveredNom: 0, uncoveredNom: 0, oppositeNom: 0, crossedNom: 0 },
          },
        ],
      },
      asOfUtcSec,
    );
    expect(mismatchAnexo.diagnostics.rejectedRows[0]?.code).toBe('STRIKE_MISMATCH');

    // 2. Sin metadata para GFGC62974D: ingestar solo strikes canónicos -> GFGC62974D queda en cuarentena
    specialist.ingestAnexoB({
      asOfDate: '2026-11-16',
      rawText: ['GFGC6000DI 100 200 0 0', 'GFGC6400DI 120 300 0 0', 'GFGC6800DI 80 180 0 0'].join('\n'),
    });

    const chainBefore = await arRuntime.getOptionsChain('GGAL', true);
    const diBefore = chainBefore.expiries.find((e) => e.expiryCode === 'DI');
    expect(diBefore?.calls.some((c) => c.symbol === 'GFGC62974D')).toBe(false);
    expect(chainBefore.unresolvedContracts?.map((u) => u.symbol)).toEqual(['GFGC62974D']);
    expect(chainBefore.unresolvedContracts?.[0]).toMatchObject({
      symbol: 'GFGC62974D',
      strike: null,
      strikeResolutionStatus: 'AMBIGUOUS_SCALE_UNRESOLVED',
      bid: 405,
      ask: 420,
      last: 412,
      volume: 1800,
    });
    expect(chainBefore.strikeQuality?.ambiguousUnresolvedCount).toBe(1);
    expect(chainBefore.exposureSummary?.trace?.strikeQuality?.ambiguousUnresolvedCount).toBe(1);

    const pinningBefore = await specialist.getStructurePinning(false);
    expect(pinningBefore.result?.strikeProfile.some((r) => r.strikeArs === 62974)).toBe(false);

    // classifyAndValidateMarginStructure y evaluateBymaClearingMargin rechazan fail-closed patas ambiguas
    const badMarginInput = {
      asOfUtcSec,
      expiryDateKey: '2026-12-18',
      expiry1530UtcSec: diExpSec,
      spot24hArs: 6400,
      rateCurveArs: [{ days: 30, continuousRateAnnual: 0.295 }],
      strategyKind: 'UNCOVERED_SHORT' as const,
      positionBasis: 'DECLARED_POSITION' as const,
      collateralAssets: [{ id: 'CASH', kind: 'CASH_ARS' as const, marketValueArs: 5_000_000, explicitAforo: 1 }],
      legs: [
        {
          ticker: 'GFGC62974D',
          underlying: 'GGAL',
          contractType: 'call' as const,
          side: 'SELL' as const,
          lots: 10,
          strikeArs: 6297.4,
          expiryDateKey: '2026-12-18',
          expiryUtcSec: diExpSec,
          optionPriceArs: 412,
          ivDecimal: 0.54,
          ivStatus: 'SOLVED_AMERICAN' as const,
          strikeResolutionStatus: 'AMBIGUOUS_SCALE_UNRESOLVED' as const,
        },
      ],
    };
    const badStructure = classifyAndValidateMarginStructure(badMarginInput);
    expect(badStructure.invalid[0]?.reason).toBe('AMBIGUOUS_STRIKE_SCALE');
    expect(badStructure.applicable.UNCOVERED_SHORT).toBe(false);
    const badMargin = evaluateBymaClearingMargin(badMarginInput);
    expect(badMargin.riskStatus).toBe('INDETERMINATE_MARGIN');

    // 3. Al ingestar Anexo B con strike explícito 6297.4 para GFGC62974D -> se resuelve con EXPLICIT_METADATA
    specialist.ingestAnexoB({
      asOfDate: '2026-11-16',
      rows: [
        {
          strikeArs: 6297.4,
          nativeSeries: 'GFGC62974D',
          callOi: { coveredNom: 100, uncoveredNom: 500, oppositeNom: 0, crossedNom: 0 },
          putOi: { coveredNom: 0, uncoveredNom: 0, oppositeNom: 0, crossedNom: 0 },
        },
        {
          strikeArs: 6400,
          nativeSeries: 'GFGC6400DI',
          callOi: { coveredNom: 120, uncoveredNom: 300, oppositeNom: 0, crossedNom: 0 },
          putOi: { coveredNom: 0, uncoveredNom: 0, oppositeNom: 0, crossedNom: 0 },
        },
      ],
    });
    const chainAfter = await arRuntime.getOptionsChain('GGAL', true);
    const resolvedContract = chainAfter.expiries
      .find((e) => e.expiryCode === 'DI')
      ?.calls.find((c) => c.symbol === 'GFGC62974D');
    expect(resolvedContract).toBeDefined();
    expectWithinTol(resolvedContract?.strike, 6297.4, 'unlocked GFGC62974D strike');
    expect(resolvedContract?.strikeResolutionStatus).toBe('EXPLICIT_METADATA');
    expect(resolvedContract?.strikeSource).toBe('IAMC_ANEXO_B');
    expect(chainAfter.strikeQuality?.ambiguousUnresolvedCount).toBe(0);
    expect(chainAfter.unresolvedContracts ?? []).toHaveLength(0);
  });
});

describe('Pieza P1 A6 — Integridad L1 del ADR GGAL, separación indicativa/ejecutable y bloqueo cross-venue', () => {
  it('A6-1, A6-3, A6-4 & A6-5: iguala exactamente al oráculo Python Decimal en todos los estados L1', () => {
    for (const [name, item] of Object.entries(reference.a6QuoteCases)) {
      const inp = item.input;
      const exp = item.expected;
      const actual = normalizeAdrMarketData({
        symbol: inp.symbol,
        asOfUtcSec: inp.asOfUtcSec,
        isEodMode: inp.isEodMode,
        maxQuoteAgeSec: inp.maxQuoteAgeSec,
        l1Candidate: inp.l1Candidate,
        tradeCandidate: inp.tradeCandidate,
        referenceCandidate: inp.referenceCandidate,
      });

      expect(actual.quoteMode, name).toBe(exp.quoteMode);
      expect(actual.l1Book.isBilateralExecutable, name).toBe(exp.isBilateralExecutable);
      expect(actual.l1Book.invalidReason, name).toBe(exp.invalidReason);
      expect(actual.indicativePriceBasis, name).toBe(exp.indicativePriceBasis);
      expectWithinTol(actual.trade.lastPrice, exp.tradeLastPrice, `${name}.tradeLastPrice`);
      expectWithinTol(actual.l1Book.bid, exp.bid, `${name}.bid`);
      expectWithinTol(actual.l1Book.ask, exp.ask, `${name}.ask`);
      expectWithinTol(actual.l1Book.mid, exp.mid, `${name}.mid`);
      expectWithinTol(actual.l1Book.spreadUsd, exp.spreadUsd, `${name}.spreadUsd`);
      expectWithinTol(actual.l1Book.spreadRel, exp.spreadRel, `${name}.spreadRel`);
      expectWithinTol(actual.indicativePriceUsd, exp.indicativePriceUsd, `${name}.indicativePriceUsd`);
    }
  });

  it('A6-2, A6-3 & A6-5: separa paridad indicativa vs ejecutable contra oráculo Python Decimal (<= 1e-9)', () => {
    const shared = reference.a6ParityCases.sharedInputs;
    const bonds = shared.bonds.map((b) => ({
      ticker: b.ticker,
      ars24h: { bid: Number(b.arsBid), ask: Number(b.arsAsk) },
      usdC24h: { bid: Number(b.usdBid), ask: Number(b.usdAsk) },
    }));

    const evalScenario = (caseName: 'A6_1_FMP_LAST_ONLY' | 'A6_3_LIVE_BID_ASK' | 'A6_5_EOD_CLOSE_REF', isEodMode: boolean) => {
      const qCase = reference.a6QuoteCases[caseName].input;
      const adrData = normalizeAdrMarketData({
        symbol: qCase.symbol,
        asOfUtcSec: qCase.asOfUtcSec,
        isEodMode,
        maxQuoteAgeSec: qCase.maxQuoteAgeSec,
        l1Candidate: qCase.l1Candidate,
        tradeCandidate: qCase.tradeCandidate,
        referenceCandidate: qCase.referenceCandidate,
      });
      return evaluateParityGap({
        asOfUtcSec: shared.asOfUtcSec,
        data912TimestampSec: shared.asOfUtcSec,
        massiveTimestampSec: shared.asOfUtcSec,
        marketMode: isEodMode ? 'EOD_CIERRE' : 'LIVE',
        byma24h: { bid: shared.bymaBid, ask: shared.bymaAsk, last: shared.bymaLast },
        adr: { bid: adrData.l1Book.bid, ask: adrData.l1Book.ask, ...(Number.isFinite(adrData.trade.lastPrice) ? { last: adrData.trade.lastPrice } : {}) },
        adrMarketData: adrData,
        sofrRateAnnual: shared.sofrRateAnnual,
        caucionArsRateTna: 0.32,
        sovereignBonds: bonds,
        spreadHistory: shared.spreadHistory,
      });
    };

    const checks = [
      ['LAST_ONLY', evalScenario('A6_1_FMP_LAST_ONLY', false), reference.a6ParityCases.A6_2_LAST_ONLY_INDICATIVE],
      ['LIVE_BID_ASK', evalScenario('A6_3_LIVE_BID_ASK', false), reference.a6ParityCases.A6_3_LIVE_BID_ASK_EXECUTABLE],
      ['EOD_CLOSE_REF', evalScenario('A6_5_EOD_CLOSE_REF', true), reference.a6ParityCases.A6_5_EOD_CLOSE_REF],
    ] as const;

    for (const [label, actual, expected] of checks) {
      expect(actual.spot.adrQuoteMode, label).toBe(expected.adrQuoteMode);
      expect(actual.signal, label).toBe(expected.signal);
      expect(actual.parityEvaluation, label).toEqual(expected.parityEvaluation);
      expectWithinTol(actual.spot.adrMidUsd, expected.adrMidUsd, `${label}.adrMidUsd`);
      expectWithinTol(actual.spot.adrBidUsd, expected.adrBidUsd, `${label}.adrBidUsd`);
      expectWithinTol(actual.spot.adrAskUsd, expected.adrAskUsd, `${label}.adrAskUsd`);
      expectWithinTol(actual.spot.adrLastUsd, expected.adrLastUsd, `${label}.adrLastUsd`);
      expectWithinTol(actual.spot.adrSpreadUsd, expected.adrSpreadUsd, `${label}.adrSpreadUsd`);
      expectWithinTol(actual.spot.adrIndicativeUsd, expected.adrIndicativeUsd, `${label}.adrIndicativeUsd`);
      expectWithinTol(actual.ccl.cclGgal24h, expected.cclGgal24h, `${label}.cclGgal24h`);
      expectWithinTol(actual.ccl.cclSovereignBenchmark, expected.cclSovereignBenchmark, `${label}.cclSovereignBenchmark`);
      expectWithinTol(actual.ccl.spreadLogBps, expected.spreadLogBps, `${label}.spreadLogBps`);
      expectWithinTol(actual.ccl.ouMeanBps, expected.ouMeanBps, `${label}.ouMeanBps`);
      expectWithinTol(actual.ccl.ouEqSigmaBps, expected.ouEqSigmaBps, `${label}.ouEqSigmaBps`);
      expectWithinTol(actual.ccl.zScore, expected.zScore, `${label}.zScore`);
      expectWithinTol(actual.spot.fairAdrUsd, expected.fairAdrUsd, `${label}.fairAdrUsd`);
      expectWithinTol(actual.ccl.netEdgeAfterCostsBps, expected.netEdgeAfterCostsBps, `${label}.netEdgeAfterCostsBps`);
    }
  });

  it('A6-6: bajo Tradier 401 + FMP last=50 sin BBO, todos los endpoints HTTP operan 200 sin NaN y bloquean ejecución ADR/cross-venue', async () => {
    const asOfUtcSec = Math.floor(Date.UTC(2026, 9, 15, 15, 30, 0) / 1_000);
    const nowMs = asOfUtcSec * 1_000;
    const frontExpSec = Math.floor(Date.UTC(2026, 10, 20, 18, 30, 0) / 1_000);
    const backExpSec = Math.floor(Date.UTC(2026, 11, 18, 18, 30, 0) / 1_000);
    const tFront = (frontExpSec - asOfUtcSec) / (365 * 86_400);
    const tBack = (backExpSec - asOfUtcSec) / (365 * 86_400);

    // BYMA GGAL = 6800 ARS vs ADR = 50 USD -> z-score alto (>3)
    const arByDate = buildDailyBars(85, asOfUtcSec, 6_000, 5.2);
    const adrByDate = buildDailyBars(85, asOfUtcSec, 48.0, 0.024);
    const al30ByDate = buildDailyBars(85, asOfUtcSec, 75_500, 48);
    const al30cByDate = buildDailyBars(85, asOfUtcSec, 59.0, 0.036);
    const cerSeries = buildCerHistory(asOfUtcSec, 85);

    const argOptionsRows: Record<string, unknown>[] = [];
    for (const [code, tExp] of [
      ['NO', tFront],
      ['DI', tBack],
    ] as const) {
      for (const strike of [5800, 6200, 6600, 6800, 7000, 7400]) {
        for (const ct of ['call', 'put'] as const) {
          const px = Number(Math.max(15, priceBsm({ spot: 6800, strike, timeToExpiry: tExp, rate: 0.295, dividendYield: 0, volatility: 0.56, contractType: ct })).toFixed(2));
          argOptionsRows.push({
            symbol: `GFG${ct === 'call' ? 'C' : 'V'}${String(strike)}${code}`,
            c: px,
            px_bid: Number((px * 0.985).toFixed(2)),
            px_ask: Number((px * 1.015).toFixed(2)),
            v: 120_000,
            v_ars: 120_000 * px,
            open_interest: 120_000,
          });
        }
      }
    }

    const opraSpecs: { expDate: string; expCompact: string; tExp: number; strike: number; ct: 'call' | 'put' }[] = [];
    for (const [expDate, expCompact, tExp] of [
      ['2026-11-20', '261120', tFront],
      ['2026-12-18', '261218', tBack],
    ] as const) {
      for (const strike of [46, 48, 50, 52, 54, 56]) {
        for (const ct of ['call', 'put'] as const) {
          opraSpecs.push({ expDate, expCompact, tExp, strike, ct });
        }
      }
    }

    const jsonRes = (payload: unknown, status = 200) =>
      Promise.resolve({ ok: status >= 200 && status < 300, status, text: JSON.stringify(payload), headers: {} });

    const arFetch: ArHttpFn = (url) => {
      const u = new URL(url);
      if (u.hostname.includes('data912')) {
        if (u.pathname === '/live/arg_stocks') {
          return jsonRes([{ symbol: 'GGAL', c: 6800, px_bid: 6798, px_ask: 6802, prev_close: 6700, v: 900_000 }]);
        }
        if (u.pathname === '/live/arg_bonds') {
          return jsonRes([
            { symbol: 'AL30', c: 77_000, px_bid: 76_950, px_ask: 77_050, v: 8_000_000 },
            { symbol: 'AL30C', c: 59.2, px_bid: 59.15, px_ask: 59.25, v: 5_000_000 },
            { symbol: 'GD30', c: 82_200, px_bid: 82_120, px_ask: 82_280, v: 6_000_000 },
            { symbol: 'GD30C', c: 63.2, px_bid: 63.15, px_ask: 63.25, v: 4_000_000 },
          ]);
        }
        if (u.pathname === '/live/arg_notes') return jsonRes([{ symbol: 'S31O6', c: 125.5, tna: 34.2 }]);
        if (u.pathname === '/live/cauciones') return jsonRes([{ symbol: 'PESOS 1D', days: 1, tna: 32.8, c: 32.8 }]);
        if (u.pathname === '/live/arg_options') return jsonRes(argOptionsRows);
        if (u.pathname === '/historical/bonds/AL30') return jsonRes(al30ByDate);
        if (u.pathname === '/historical/bonds/AL30C') return jsonRes(al30cByDate);
        if (u.pathname === '/historical/bonds/GD30') return jsonRes(al30ByDate);
        if (u.pathname === '/historical/bonds/GD30C') return jsonRes(al30cByDate);
        if (u.pathname.startsWith('/historical/')) return jsonRes(arByDate);
      }
      if (u.hostname.includes('bcra.gob.ar')) {
        if (u.pathname === '/estadisticas/v4.0/Monetarias/30') return jsonRes({ results: cerSeries });
        return jsonRes({ results: [{ idVariable: 7, descripcion: 'BADLAR TNA', valor: 34.5, fecha: '2026-10-15' }] });
      }
      if (u.hostname.includes('argentinadatos')) return jsonRes([{ fecha: '2026-09-30', valor: 2.3 }]);
      if (u.hostname.includes('newyorkfed')) return jsonRes({ refRates: [{ percentRate: 4.3, effectiveDate: '2026-10-15' }] });
      return jsonRes([]);
    };

    const usFetch: FetchFn = (url) => {
      if (url.includes('financialmodelingprep.com')) {
        return jsonRes([
          {
            symbol: 'GGAL',
            name: 'Grupo Financiero Galicia',
            exchange: 'NASDAQ',
            price: 50.0,
            previousClose: 49.5,
            volume: 1_100_000,
            timestamp: asOfUtcSec,
          },
        ]);
      }
      const p = new URL(url).pathname;
      if (p.startsWith('/v2/aggs/ticker/')) {
        const segs = p.split('/');
        const ticker = decodeURIComponent(segs[4] ?? 'GGAL');
        if (segs[7] === 'day' && ticker === 'GGAL') {
          return jsonRes({
            status: 'OK',
            ticker,
            resultsCount: adrByDate.length,
            results: adrByDate.map((r) => ({
              t: Date.parse(`${r.date}T04:00:00Z`),
              o: r.o,
              h: r.h,
              l: r.l,
              c: r.c,
              v: r.v,
              vw: r.c,
            })),
          });
        }
        return jsonRes({
          status: 'OK',
          ticker,
          results: Array.from({ length: 60 }, (_, idx) => ({
            t: (asOfUtcSec - (60 - idx) * 300) * 1_000,
            o: 50,
            h: 50.2,
            l: 49.8,
            c: 50,
            v: 20_000,
            vw: 50,
          })),
        });
      }
      if (p === '/v3/snapshot') {
        return jsonRes({
          status: 'OK',
          results: [
            {
              ticker: 'GGAL',
              type: 'stocks',
              market_status: 'open',
              session: { price: 50.0, close: 50.0, previous_close: 49.5, volume: 1_100_000 },
              last_trade: { price: 50.0, size: 100, sip_timestamp: String(asOfUtcSec * 1_000_000_000) },
              // Sin last_quote L1
            },
          ],
        });
      }
      if (p.startsWith('/v3/snapshot/options/')) {
        return jsonRes({
          status: 'OK',
          results: opraSpecs.map((item) => {
            const fair = Math.max(0.25, priceBsm({ spot: 50, strike: item.strike, timeToExpiry: item.tExp, rate: 0.043, dividendYield: 0, volatility: 0.44, contractType: item.ct }));
            return {
              details: {
                ticker: `O:GGAL${item.expCompact}${item.ct === 'call' ? 'C' : 'P'}${String(item.strike * 1000).padStart(8, '0')}`,
                contract_type: item.ct,
                strike_price: item.strike,
                expiration_date: item.expDate,
                shares_per_contract: 100,
                exercise_style: 'american',
              },
              underlying_asset: { ticker: 'GGAL', price: 50 },
              implied_volatility: 0.44,
              open_interest: 1200,
              last_quote: { bid: Number((fair * 0.96).toFixed(2)), ask: Number((fair * 1.04).toFixed(2)), midpoint: fair },
              last_trade: { price: fair, sip_timestamp: asOfUtcSec * 1_000_000_000 },
              day: { close: fair, volume: 250 },
            };
          }),
        });
      }
      if (p === '/fed/v1/treasury-yields') {
        return jsonRes({ status: 'OK', results: [{ date: '2026-10-15', yield_1_month: 4.3, yield_30_year: 4.3 }] });
      }
      if (p === '/fed/v1/funding-conditions') {
        return jsonRes({ status: 'OK', results: [{ date: '2026-10-15', effective_fed_funds_rate: 4.3, sofr: 4.3 }] });
      }
      return jsonRes({ status: 'OK', results: [] });
    };

    const tradierConfig: TradierConfig = {
      accessToken: 'stub-token',
      tokenEnvName: 'TRADIER_API_TOKEN',
      apiEnv: 'sandbox',
      restBaseUrl: 'https://sandbox.tradier.com/v1',
      wsBaseUrl: 'wss://sandbox.tradier.com/v1/markets/events',
      configured: true,
      tokenIsGeneric: false,
      sandboxFallbackAllowed: true,
    };

    const runtime = new MarketRuntime({
      apiKey: 'massive-stub',
      enableWs: false,
      fetchFn: usFetch,
      nowMsFn: () => nowMs,
      fmpConfig: {
        configured: true,
        apiKey: 'fmp-stub',
        quotesApiKey: 'fmp-stub',
        marketApiKey: null,
        etfApiKey: null,
        macroApiKey: null,
        baseUrl: FMP_STABLE_BASE_URL,
      },
      tradierConfig,
      tradierHttpFn: () => Promise.resolve({ ok: false, status: 401, text: 'Unauthorized' }),
    });
    const arRuntime = new ArgentinaMarketRuntime({
      fetchFn: arFetch,
      nowMsFn: () => nowMs,
      minData912IntervalMs: 0,
      usRuntime: runtime,
    });
    const ggalRuntime = new GgalSpecialistRuntime({
      runtime,
      arRuntime,
      fetchFn: arFetch,
      nowMsFn: () => nowMs,
      env: {},
    });
    const server = createHttpWsServer({ runtime, arRuntime, ggalRuntime, port: 0 });
    handles.push(server);
    const addr = await server.start();
    const baseUrl = `http://${addr.host}:${String(addr.port)}`;

    // 1. Parity & Gap: LAST_ONLY sin 50/50 sintético ni STALE_DATA_LOCK; señal bloqueada NEUTRAL
    const parityRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/parity-gap`);
    expect(parityRes.status).toBe(200);
    const parityRaw = await parityRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(parityRaw)).toBe(false);
    const parity = JSON.parse(parityRaw) as GgalParityGapResponse;
    expect(parity.telemetry.executionPriceBasis).toBe('LAST_ONLY');
    expect(parity.telemetry.feedStatus).not.toBe('STALE_DATA_LOCK');
    expect(parity.result.signal).toBe('NEUTRAL');
    expect(parity.result.spot.adrMidUsd).toBeNull();
    expect(parity.result.spot.adrBidUsd).toBeNull();
    expect(parity.result.spot.adrAskUsd).toBeNull();
    expectWithinTol(parity.result.spot.adrLastUsd, 50.0, 'http.adrLastUsd');
    expectWithinTol(parity.result.spot.adrIndicativeUsd, 50.0, 'http.adrIndicativeUsd');
    expect(parity.result.spot.adrQuoteMode).toBe('LAST_ONLY');
    expect(parity.result.ccl.netEdgeAfterCostsBps).toBeNull();
    expect(parity.result.parityEvaluation.executableStatus).toBe('INDICATIVE_ONLY_NO_ADR_BBO');
    expect(parity.result.parityEvaluation.actionableSignalAllowed).toBe(false);

    // 2. Dual Chart: OPERATIONAL aun sin L1 BBO (refresh=1 evita warmup diferido)
    const dualChartRes = await fetch(
      `${baseUrl}/api/ar/ggal-specialist/dual-chart?coordMode=ARS_BYMA&timeframe=1D&refresh=1`,
    );
    expect(dualChartRes.status).toBe(200);
    const dualChartRaw = await dualChartRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(dualChartRaw)).toBe(false);
    const dualChart = JSON.parse(dualChartRaw) as {
      readonly dualChart: { readonly status: string; readonly bars?: readonly unknown[] };
    };
    expect(dualChart.dualChart.status).toBe('OPERATIONAL');
    expect((dualChart.dualChart.bars ?? []).length).toBeGreaterThan(20);

    // 3. Overview, Vol Triangle & Dual Density: 200 OK sin NaN ni adrMidUsd fabricado
    const [ovRes, volRes, dualRes] = await Promise.all([
      fetch(`${baseUrl}/api/ar/ggal-specialist/overview`),
      fetch(`${baseUrl}/api/ar/ggal-specialist/vol-triangle`),
      fetch(`${baseUrl}/api/ar/ggal-specialist/dual-density`),
    ]);
    expect(ovRes.status).toBe(200);
    expect(volRes.status).toBe(200);
    expect(dualRes.status).toBe(200);
    const ovRaw = await ovRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(ovRaw)).toBe(false);
    const ov = JSON.parse(ovRaw) as GgalSpecialistOverviewResponse;
    expect(ov.spot.adrMidUsd).toBeNull();
    expect(ov.spot.adrQuoteMode).toBe('LAST_ONLY');
    expectWithinTol(ov.spot.adrIndicativeUsd, 50.0, 'overview.adrIndicativeUsd');

    // 4. Motor 5: Strategy Selector preserva BYMA_ARS pero bloquea cross-venue OPRA
    const stratRes = await fetch(`${baseUrl}/api/ar/ggal-specialist/strategy-selector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enforceThresholds: false, maxCandidates: 15 }),
    });
    expect(stratRes.status).toBe(200);
    const stratRaw = await stratRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(stratRaw)).toBe(false);
    const strat = JSON.parse(stratRaw) as GgalStrategySelectorResponse & {
      readonly result: {
        readonly adrQuoteMode?: string;
        readonly crossVenueExecutable?: boolean;
        readonly crossVenueBlockedReason?: string | null;
      } | null;
    };
    expect(strat.telemetry.executionPriceBasis).toBe('LAST_ONLY');
    expect(strat.result?.adrQuoteMode).toBe('LAST_ONLY');
    expect(strat.result?.crossVenueExecutable).toBe(false);
    expect(strat.result?.crossVenueBlockedReason).toBe('ADR_NO_BILATERAL_L1_BBO');
    expect(strat.result?.rankedStrategies.some((s) => s.venue === 'BYMA_ARS')).toBe(true);
    for (const s of strat.result?.rankedStrategies ?? []) {
      expect(s.usdAlternativeComparison.opraEquivalentSharpe).toBeNull();
      expect(s.usdAlternativeComparison.bymaAdvantageBps).toBeNull();
    }

    // 5. Motor 6: Diagnóstico L1 ADR sin spread inventado + Tail Stress indicativo operativo
    const marginRes = await fetch(
      `${baseUrl}/api/ar/ggal-specialist/margin-risk?strategyKind=VERTICAL_CREDIT_SPREAD&desiredLots=10`,
    );
    expect(marginRes.status).toBe(200);
    const marginRaw = await marginRes.text();
    expect(JSON_FORBIDDEN_TOKEN.test(marginRaw)).toBe(false);
    const margin = JSON.parse(marginRaw) as GgalMarginRiskResponse & {
      readonly executionBookDiagnostics: {
        readonly adrBookQuality?: string;
        readonly adrBidUsd?: number | null;
        readonly adrAskUsd?: number | null;
        readonly adrSpreadUsd?: number | null;
        readonly adrExecutableL1?: boolean;
        readonly crossVenueExecutionAllowed?: boolean;
      };
      readonly tailStress: { readonly status: string; readonly spotAdrPriceBasis?: string } | null;
    };
    expect(margin.executionBookDiagnostics.adrBookQuality).toBe('LAST_ONLY');
    expect(margin.executionBookDiagnostics.adrBidUsd).toBeNull();
    expect(margin.executionBookDiagnostics.adrAskUsd).toBeNull();
    expect(margin.executionBookDiagnostics.adrSpreadUsd).toBeNull();
    expect(margin.executionBookDiagnostics.adrExecutableL1).toBe(false);
    expect(margin.executionBookDiagnostics.crossVenueExecutionAllowed).toBe(false);
    expect(margin.tailStress?.status).toBe('OK');
    expect(margin.tailStress?.spotAdrPriceBasis).toBe('LAST_TRADE');
  });
});
