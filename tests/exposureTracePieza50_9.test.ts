/**
 * Pieza 50.9 (Bloque A) — trazabilidad de exposición US/AR.
 *
 * Referencia independiente: `tools/gen_exposure_trace_pieza50_9.py`
 * (`fixtures/exposure_trace_pieza50_9_reference.json`). Cubre tiempos mixtos,
 * faltantes/inválidos/futuros, referencias EOD excluidas del rango, overlay
 * parcial, cobertura completa/parcial/desconocida y metadatos de rangos.
 * Además verifica la representación: DTO legacy sin traza = cobertura
 * desconocida, Zero-Gamma solo con `unique`, estados de cruce y que un tick
 * live no dependa de los niveles.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExposureTraceMetadata,
  resolveArOiProvenance,
  resolveExposureCoverage,
  summarizeChainCoverage,
  summarizeQuoteTimes,
  type ChainDateReport,
  type ExposureCoverageEvidence,
  type QuoteTimeEntry,
} from '../src/core/exposureTrace.js';
import { overlayTradierChainOnCanonicalContracts } from '../src/server/tradierAdapter.js';
import type {
  OptionDaySummary,
  OptionGreeks,
  OptionLastQuote,
  OptionLastTrade,
  OptionSnapshotContract,
} from '../src/data/optionsTypes.js';

interface QuoteCase {
  readonly name: string;
  readonly entries: readonly QuoteTimeEntry[];
  readonly asOfUtcSec: number;
  readonly expected: ReturnType<typeof summarizeQuoteTimes>;
}

interface CoverageCase {
  readonly name: string;
  readonly evidence: ExposureCoverageEvidence;
  readonly expected: string;
}

interface MetadataCase {
  readonly name: string;
  readonly input: Parameters<typeof buildExposureTraceMetadata>[0];
  readonly expected: ReturnType<typeof buildExposureTraceMetadata>;
}

interface Fixture {
  readonly quoteCases: readonly QuoteCase[];
  readonly coverageCases: readonly CoverageCase[];
  readonly metadataCases: readonly MetadataCase[];
  readonly chainCoverageCases: readonly {
    readonly name: string;
    readonly reports: readonly ChainDateReport[];
    readonly requestedDates: readonly string[];
    readonly expected: ReturnType<typeof summarizeChainCoverage>;
  }[];
  readonly arOiCases: readonly {
    readonly name: string;
    readonly inputs: readonly { readonly oiFromReported: boolean }[];
    readonly expected: ReturnType<typeof resolveArOiProvenance>;
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures', 'exposure_trace_pieza50_9_reference.json'), 'utf-8'),
) as Fixture;

describe('Pieza 50.9 Bloque A — resumen de tiempos de cotización', () => {
  it('coincide con la referencia en extremos, recuentos y edades', () => {
    for (const item of fixture.quoteCases) {
      const actual = summarizeQuoteTimes(item.entries, item.asOfUtcSec);
      expect(actual, item.name).toEqual(item.expected);
    }
  });

  it('excluye faltantes, inválidos, futuros y referencias EOD del rango verifiable', () => {
    const eod = fixture.quoteCases.find((c) => c.name === 'eod_referencia');
    expect(eod?.expected.minUpdatedAtSec).toBe(1_699_999_980);
    expect(eod?.expected.maxUpdatedAtSec).toBe(1_699_999_980);
    expect(eod?.expected.eodReferenceCount).toBe(1);
    expect(eod?.expected.minUpdatedAtSec).not.toBe(1_699_999_990);
    const boundary = fixture.quoteCases.find((c) => c.name === 'borde_evaluacion');
    expect(boundary?.expected.knownCount).toBe(1);
    expect(boundary?.expected.newestAgeSec).toBe(0);
    const future = fixture.quoteCases.find((c) => c.name === 'futuro');
    expect(future?.expected.knownCount).toBe(0);
    expect(future?.expected.maxUpdatedAtSec).toBeNull();
    const invalid = fixture.quoteCases.find((c) => c.name === 'invalido');
    expect(invalid?.expected.unknownCount).toBe(3);
  });

  it('registra la procedencia del overlay sin acreditar tiempos ajenos', () => {
    const partial = fixture.quoteCases.find((c) => c.name === 'overlay_parcial');
    expect(partial?.expected.overlayQuoteCount).toBe(1);
    expect(partial?.expected.knownCount).toBe(2);
  });
});

describe('Pieza 50.9 Bloque A — cobertura y metadatos', () => {
  it('coincide con la referencia en el estado de cobertura', () => {
    for (const item of fixture.coverageCases) {
      expect(resolveExposureCoverage(item.evidence), item.name).toBe(item.expected);
    }
  });

  it('ensambla rangos, recuentos y nulos igual que la referencia', () => {
    for (const item of fixture.metadataCases) {
      expect(buildExposureTraceMetadata(item.input), item.name).toEqual(item.expected);
    }
  });

  it('una respuesta legacy sin traza queda en cobertura desconocida y sin tiempos', () => {
    expect(resolveExposureCoverage({ evidenced: false, engineInputs: 0, skippedContracts: 0, chainTruncated: false })).toBe('unknown');
    expect(summarizeQuoteTimes([], 1_700_000_000)).toEqual({
      knownCount: 0,
      unknownCount: 0,
      minUpdatedAtSec: null,
      maxUpdatedAtSec: null,
      newestAgeSec: null,
      oldestAgeSec: null,
      overlayQuoteCount: 0,
      eodReferenceCount: 0,
    });
  });

  it('corte por maxPages, error o fecha sin resultado impiden la cobertura completa', () => {
    for (const item of fixture.chainCoverageCases) {
      expect(summarizeChainCoverage(item.reports, item.requestedDates), item.name).toEqual(
        item.expected,
      );
    }
    const partialEvidence: ExposureCoverageEvidence = {
      evidenced: true,
      engineInputs: 10,
      skippedContracts: 0,
      chainTruncated: false,
      chainErrors: true,
    };
    expect(resolveExposureCoverage(partialEvidence)).toBe('partial');
    expect(
      resolveExposureCoverage({ ...partialEvidence, chainErrors: false, missingDatesCount: 2 }),
    ).toBe('partial');
    expect(
      resolveExposureCoverage({ ...partialEvidence, chainErrors: false, missingDatesCount: 0 }),
    ).toBe('complete');
  });

  it('el OI AR distingue directo, proxy de volumen y desconocido', () => {
    for (const item of fixture.arOiCases) {
      expect(resolveArOiProvenance(item.inputs), item.name).toEqual(item.expected);
    }
    expect(resolveArOiProvenance([]).oiProxy).toBeNull();
    expect(resolveArOiProvenance([{ oiFromReported: false }]).oiProxy).toBe(true);
    expect(resolveArOiProvenance([{ oiFromReported: true }]).oiProxy).toBe(false);
  });

  it('la fusión real registra la sustitución de puntas aunque precio y hora coincidan', () => {
    const nowSec = 1_700_000_000;
    const massive = makeContract({ bid: 8.0, ask: 8.2, updatedAt: nowSec, nowSec });
    const identical = makeTradierMatch({
      bid: 8.0,
      ask: 8.2,
      asOfUtcSec: nowSec,
    });
    const fused = overlayTradierChainOnCanonicalContracts([massive], [identical], { nowSec });
    expect(fused.quoteSubstitutedTickers.has(massive.ticker)).toBe(true);
    const substitutedTrace = summarizeQuoteTimes(
      fused.contracts.map((c) => ({
        updatedAtSec: fused.quoteSubstitutedTickers.has(c.ticker) ? null : c.lastQuote.updatedAt,
        fromOverlay: fused.quoteSubstitutedTickers.has(c.ticker),
      })),
      nowSec,
    );
    expect(substitutedTrace.knownCount).toBe(0);
    expect(substitutedTrace.unknownCount).toBe(1);
    expect(substitutedTrace.overlayQuoteCount).toBe(1);

    // Massive intacto (sin match): su hora se conserva y es verificable.
    const unmatched = makeTradierMatch({ strike: 999, occSymbol: 'QQQ260331C00999000' });
    const intact = overlayTradierChainOnCanonicalContracts([massive], [unmatched], { nowSec });
    expect(intact.quoteSubstitutedTickers.size).toBe(0);
    const intactTrace = summarizeQuoteTimes(
      intact.contracts.map((c) => ({ updatedAtSec: c.lastQuote.updatedAt })),
      nowSec,
    );
    expect(intactTrace.knownCount).toBe(1);
    expect(intactTrace.maxUpdatedAtSec).toBe(nowSec);

    // Sin overlay y con hora NaN: desconocido (no se convierte en 0 ni en fresco).
    const nanMassive = makeContract({ bid: 8.0, ask: 8.2, updatedAt: Number.NaN, nowSec });
    const nanTrace = summarizeQuoteTimes(
      [nanMassive].map((c) => ({ updatedAtSec: c.lastQuote.updatedAt })),
      nowSec,
    );
    expect(nanTrace.knownCount).toBe(0);
    expect(nanTrace.unknownCount).toBe(1);
    expect(nanTrace.minUpdatedAtSec).toBeNull();
  });
});

describe('Pieza 50.9 Bloque A — representación en Stock Detail', () => {
  it('solo un cruce único dibuja Zero-Gamma y se distinguen los cuatro estados', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    expect(src.split("exposure?.gammaFlipStatus === 'unique'").length - 1).toBe(2);
    expect(src).toContain("status === 'multiple_crossings'");
    expect(src).toContain("status === 'no_crossing'");
    expect(src).toContain("status === 'indeterminate'");
    expect(src).toContain('REST elige el más cercano');
    expect(src).toContain('calls +1 · puts −1 (modelo teórico)');
    // La traza muestra cobertura desconocida cuando no hay metadatos.
    expect(src).toContain("trace?.coverage ?? 'unknown'");
    expect(src).toContain('cobertura desconocida');
  });

  it('el tick live no participa de los niveles ni del spot de valuación', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    // La traza/niveles solo dependen de exposiciones REST, no del precio live.
    expect(src).toContain('}, [arOptions?.exposureSummary, isArMarket, usSnap?.exposureSummary]);');
    expect(src).not.toContain('exposureTraceInfo = useMemo(() => {\n    const liveQuote');
    expect(src).toContain('const exposure = isArMarket ? arOptions?.exposureSummary : usSnap?.exposureSummary;');
  });

  it('muestra alcance y candidatos múltiples, sin frescura ni ceros fabricados', () => {
    const src = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    // Alcance de fechas/strikes del motor y payload.
    expect(src).toContain('venc. motor');
    expect(src).toContain('trace?.engineExpirationDates');
    // Valores de los candidatos Zero-γ cuando hay cruces múltiples.
    expect(src).toContain("candidates.map((value) => value.toFixed(2)).join(', ')");
    expect(src).toContain('REST elige el más cercano');
    // Sin traza: «—», nunca 0 fabricado.
    expect(src).toContain("'— (sin traza)'");
    expect(src).toContain("'— (sin hora verificable)'");
    expect(src).not.toContain("quoteTimes?.unknownCount ?? 0");
    // El modo no se anuncia como frescura.
    expect(src).toContain("' · modo EOD'");
    expect(src).toContain("' · modo NBBO'");
    expect(src).not.toContain('NBBO live');
  });

  it('la serialización usa la evidencia real de cadena y la sustitución efectiva', () => {
    const server = readFileSync(
      new URL('../src/server/marketRuntime.ts', import.meta.url),
      'utf-8',
    );
    expect(server).toContain('summarizeChainCoverage(chainDateReports, chainRequestedDates)');
    expect(server).toContain('tradierOverlay.quoteSubstitutedTickers.has(c.ticker)');
    expect(server).toContain('chainRes.report.stoppedReason');
    expect(server).not.toContain("w.includes('options chain error')");
    const tradier = readFileSync(
      new URL('../src/server/tradierAdapter.ts', import.meta.url),
      'utf-8',
    );
    expect(tradier).toContain('summary.quoteSubstitutedTickers.add(contract.ticker)');
    const ar = readFileSync(
      new URL('../src/server/argentinaMarketLoader.ts', import.meta.url),
      'utf-8',
    );
    expect(ar).toContain('resolveArOiProvenance(arOiProvenance)');
    expect(ar).toContain("'OVERVIEW'");
    expect(ar).toContain("'HISTORICAL_CLOSE'");
  });
});

function makeContract(input: {
  readonly bid: number;
  readonly ask: number;
  readonly updatedAt: number;
  readonly nowSec: number;
}): OptionSnapshotContract {
  const mid = (input.bid + input.ask) / 2;
  const day: OptionDaySummary = {
    open: mid,
    high: input.ask,
    low: input.bid,
    close: mid,
    volume: 500,
    vwap: mid,
    previousClose: mid,
    change: 0,
    changePercent: 0,
    updatedAt: input.nowSec,
  };
  const quote: OptionLastQuote = {
    bid: input.bid,
    ask: input.ask,
    midpoint: mid,
    bidSize: 10,
    askSize: 10,
    bidExchange: null,
    askExchange: null,
    updatedAt: input.updatedAt,
    timeframe: null,
  };
  const trade: OptionLastTrade = {
    price: mid,
    size: 10,
    exchange: null,
    conditions: [],
    sipTimestamp: input.nowSec * 1_000_000_000,
    timeframe: null,
  };
  const greeks: OptionGreeks = { delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.1 };
  return {
    ticker: 'O:QQQ260331C00660000',
    contractType: 'call',
    exerciseStyle: 'american',
    expirationDate: '2025-03-31',
    expirationTime: input.nowSec + 30 * 86_400,
    strikePrice: 660,
    sharesPerContract: 100,
    breakEvenPrice: Number.NaN,
    impliedVolatility: 0.22,
    openInterest: 5000,
    greeks,
    greeksMissing: false,
    day,
    lastQuote: quote,
    lastTrade: trade,
    underlyingAsset: null,
    additionalUnderlyings: [],
    isBinary: false,
    isAdjusted: false,
    isNonStandard: false,
  };
}

function makeTradierMatch(overrides: {
  readonly strike?: number;
  readonly occSymbol?: string;
  readonly bid?: number;
  readonly ask?: number;
  readonly asOfUtcSec?: number;
}): {
  readonly occSymbol: string;
  readonly underlying: string;
  readonly contractType: 'call';
  readonly strike: number;
  readonly expirationDate: string;
  readonly expirationTime: number;
  readonly bid: number;
  readonly bidSize: number;
  readonly ask: number;
  readonly askSize: number;
  readonly volume: number;
  readonly openInterest: number;
  readonly last: number;
  readonly close: number;
  readonly greeks: {
    readonly delta: number;
    readonly gamma: number;
    readonly theta: number;
    readonly vega: number;
    readonly rho: number;
    readonly phi: number;
    readonly bidIv: number;
    readonly midIv: number;
    readonly askIv: number;
    readonly smvVol: number;
    readonly updatedAtUtcSec: number;
  };
  readonly asOfUtcSec: number;
  readonly provider: 'TRADIER';
  readonly sharesPerContract: 100;
} {
  return {
    occSymbol: overrides.occSymbol ?? 'QQQ260331C00660000',
    underlying: 'QQQ',
    contractType: 'call',
    strike: overrides.strike ?? 660,
    expirationDate: '2025-03-31',
    expirationTime: 1_700_000_000 + 30 * 86_400,
    bid: overrides.bid ?? 8.01,
    bidSize: 10,
    ask: overrides.ask ?? 8.21,
    askSize: 12,
    volume: 900,
    openInterest: 6000,
    last: 8.1,
    close: 8.1,
    greeks: { delta: 0.55, gamma: 0.01, theta: -0.03, vega: 0.12, rho: 0, phi: 0, bidIv: 0.2, midIv: 0.2, askIv: 0.21, smvVol: 0.2, updatedAtUtcSec: 1_700_000_000 },
    asOfUtcSec: overrides.asOfUtcSec ?? 1_700_000_000,
    provider: 'TRADIER',
    sharesPerContract: 100,
  };
}
