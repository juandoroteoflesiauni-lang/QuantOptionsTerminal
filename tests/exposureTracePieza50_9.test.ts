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
  type ExposureCoverageEvidence,
  type QuoteTimeEntry,
} from '../src/core/exposureTrace.js';
import { overlayTradierChainOnCanonicalContracts } from '../src/server/tradierAdapter.js';
import {
  MarketRuntime,
  type TerminalSnapshotResponse,
} from '../src/server/marketRuntime.js';
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
    readonly reports: readonly {
      readonly dateKey: string | null;
      readonly kind: 'DATE' | 'DTE_RANGE';
      readonly stoppedReason: string | null;
      readonly providerError: boolean;
      readonly contractCount: number;
    }[];
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

  it('corte por maxPages, malformed, error, fecha sin resultado o falta de informes impiden completar', () => {
    for (const item of fixture.chainCoverageCases) {
      expect(summarizeChainCoverage(item.reports, item.requestedDates), item.name).toEqual(
        item.expected,
      );
    }
    const malformed = fixture.chainCoverageCases.find((c) => c.name === 'malformed_sin_provider_error');
    expect(malformed?.expected.malformedResponse).toBe(true);
    expect(malformed?.expected.chainErrors).toBe(false);
    expect(
      resolveExposureCoverage({
        evidenced: true,
        engineInputs: 10,
        skippedContracts: 0,
        chainTruncated: false,
        malformedResponse: true,
        loadEvidenced: true,
      }),
    ).toBe('partial');
    const rangeLoad = fixture.chainCoverageCases.find((c) => c.name === 'rango_dte_sin_fechas');
    expect(rangeLoad?.expected.rangeLoadCount).toBe(1);
    expect(rangeLoad?.expected.requestedDates).toEqual([]);
    expect(rangeLoad?.expected.missingDates).toEqual([]);
    const noReports = fixture.chainCoverageCases.find((c) => c.name === 'sin_informes');
    expect(noReports?.expected.missingDates).toEqual(['2025-01-17']);
    expect(
      resolveExposureCoverage({
        evidenced: true,
        engineInputs: 10,
        skippedContracts: 0,
        chainTruncated: false,
        loadEvidenced: false,
      }),
    ).toBe('unknown');
    const partialEvidence: ExposureCoverageEvidence = {
      evidenced: true,
      engineInputs: 10,
      skippedContracts: 0,
      chainTruncated: false,
      chainErrors: true,
      loadEvidenced: true,
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
    // Las ramas GGAL y de respaldo sin loadDates también capturan su informe.
    expect(server.split("kind: 'DTE_RANGE'").length - 1).toBe(2);
    expect(server).toContain('loadEvidenced: chainDateReports.length > 0');
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

  it('computeSnapshot REST expone la cobertura de las ramas GGAL y de respaldo inyectadas', async () => {
    const maxPages = await runSnapshotWithChainReport({
      symbol: 'GGAL',
      stoppedReason: 'maxPages',
      providerError: null,
    });
    expect(maxPages.exposureSummary, 'GGAL maxPages').not.toBeNull();
    expect(maxPages.exposureSummary?.trace?.coverage).toBe('partial');
    expect(maxPages.exposureSummary?.trace?.chainCoverage?.rangeLoadCount).toBe(1);
    expect(maxPages.exposureSummary?.trace?.chainCoverage?.requestedDates).toEqual([]);

    const malformed = await runSnapshotWithChainReport({
      symbol: 'GGAL',
      stoppedReason: 'malformedResponse',
      providerError: null,
    });
    expect(malformed.exposureSummary?.trace?.coverage).toBe('partial');
    expect(malformed.exposureSummary?.trace?.chainCoverage?.malformedResponse).toBe(true);
    expect(malformed.exposureSummary?.trace?.chainCoverage?.chainErrors).toBe(false);

    const clean = await runSnapshotWithChainReport({
      symbol: 'GGAL',
      stoppedReason: 'noMorePages',
      providerError: null,
    });
    expect(clean.exposureSummary?.trace?.coverage).toBe('complete');
    expect(clean.exposureSummary?.trace?.chainCoverage?.rangeLoadCount).toBe(1);

    // Rama de respaldo sin loadDates (símbolo no-GGAL con catálogo vacío).
    const fallback = await runSnapshotWithChainReport({
      symbol: 'AMD',
      stoppedReason: 'maxPages',
      providerError: null,
    });
    expect(fallback.exposureSummary?.trace?.coverage).toBe('partial');
    expect(fallback.exposureSummary?.trace?.chainCoverage?.rangeLoadCount).toBe(1);
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

async function runSnapshotWithChainReport(input: {
  readonly symbol: string;
  readonly stoppedReason: string;
  readonly providerError: { readonly message: string } | null;
}): Promise<TerminalSnapshotResponse> {
  type Deps = NonNullable<ConstructorParameters<typeof MarketRuntime>[0]>;
  const nowMs = Date.UTC(2026, 6, 15, 14, 30, 0); // miércoles 10:30 ET (RTH)
  const nowSec = Math.floor(nowMs / 1_000);
  const expirationDate = '2026-08-07';
  const expirationTime = Date.UTC(2026, 7, 7, 20, 0, 0) / 1_000;
  const chain: OptionSnapshotContract[] = [
    makeChainContract(input.symbol, 'call', 62, expirationDate, expirationTime),
    makeChainContract(input.symbol, 'put', 62, expirationDate, expirationTime),
  ];
  const dailyBars = Array.from({ length: 30 }, (_, index) => ({
    time: nowSec - (29 - index) * 86_400,
    open: 60 + index * 0.1,
    high: 60.5 + index * 0.1,
    low: 59.5 + index * 0.1,
    close: 60 + index * 0.1,
    volume: 10_000,
  }));
  const intradayBars = Array.from({ length: 40 }, (_, index) => ({
    time: nowSec - (39 - index) * 300,
    open: 62,
    high: 62.2,
    low: 61.8,
    close: 62,
    volume: 500,
  }));
  const treasuryObs = {
    date: '2026-07-14',
    dateTime: nowSec - 86_400,
    yield1Month: 0.05,
    yield3Month: 0.05,
    yield6Month: 0.05,
    yield1Year: 0.05,
    yield2Year: 0.05,
    yield3Year: 0.05,
    yield5Year: 0.05,
    yield7Year: 0.05,
    yield10Year: 0.05,
    yield20Year: 0.05,
    yield30Year: 0.05,
    finiteTenors: 11,
  };
  const runtime = new MarketRuntime({
    apiKey: 'pieza509-chain-key',
    enableWs: false,
    nowMsFn: () => nowMs,
    loadBarsFn: ((req: { readonly timeframe?: string }) =>
      Promise.resolve({
        bars: req.timeframe === '1D' ? dailyBars : intradayBars,
        visibleStart: 0,
        report: { provider: 'massive', fetchedPages: 1, barsCount: 30, providerError: null },
      })) as unknown as NonNullable<Deps['loadBarsFn']>,
    loadUnifiedSnapshotFn: (() =>
      Promise.resolve({
        stocks: [
          {
            ticker: input.symbol,
            marketStatus: 'open',
            session: {
              open: 61,
              high: 63,
              low: 60,
              close: 62,
              previousClose: 61,
              change: 1,
              changePercent: 1.6,
              volume: 1_000_000,
              vwap: 62,
            },
            lastQuote: { bid: 61.9, ask: 62.1, midpoint: 62, bidSize: 100, askSize: 100 },
            lastTrade: { price: 62, size: 100, timeSec: nowSec },
          },
        ],
        indices: [],
        options: [],
        other: [],
        tickerErrors: [],
        report: { providerError: null },
      })) as unknown as NonNullable<Deps['loadUnifiedSnapshotFn']>,
    loadOptionChainFn: ((req: { readonly minDte?: number }) =>
      Promise.resolve({
        contracts: req.minDte !== undefined ? chain : [],
        underlying: null,
        report: {
          provider: 'massive',
          fetchedPages: 1,
          providerError: input.providerError,
          stoppedReason: input.stoppedReason,
        },
      })) as unknown as NonNullable<Deps['loadOptionChainFn']>,
    loadOptionContractsFn: (() =>
      Promise.resolve({
        // GGAL conserva su índice legacy; el resto queda sin catálogo para forzar
        // la rama de respaldo sin loadDates.
        contracts: input.symbol === 'GGAL' ? chain : [],
        report: { providerError: null, stoppedReason: 'noMorePages' },
      })) as unknown as NonNullable<Deps['loadOptionContractsFn']>,
    loadTreasuryYieldsFn: (() =>
      Promise.resolve({
        observations: [treasuryObs],
        report: { providerError: null },
      })) as unknown as NonNullable<Deps['loadTreasuryYieldsFn']>,
    loadFundingConditionsFn: (() =>
      Promise.resolve({ observations: [], report: { providerError: null } })) as unknown as NonNullable<
      Deps['loadFundingConditionsFn']
    >,
    loadDividendsFn: (() =>
      Promise.resolve({ dividends: [], report: { providerError: null } })) as unknown as NonNullable<
      Deps['loadDividendsFn']
    >,
  });
  return runtime.getSnapshot(input.symbol);
}

function makeChainContract(
  symbol: string,
  contractType: 'call' | 'put',
  strike: number,
  expirationDate: string,
  expirationTime: number,
): OptionSnapshotContract {
  const mid = contractType === 'call' ? 1.8 : 1.7;
  const day: OptionDaySummary = {
    open: mid,
    high: mid + 0.1,
    low: mid - 0.1,
    close: mid,
    volume: 800,
    vwap: mid,
    previousClose: mid,
    change: 0,
    changePercent: 0,
    updatedAt: 1_784_000_000,
  };
  const quote: OptionLastQuote = {
    bid: mid - 0.05,
    ask: mid + 0.05,
    midpoint: mid,
    bidSize: 50,
    askSize: 60,
    bidExchange: null,
    askExchange: null,
    updatedAt: 1_784_000_000,
    timeframe: null,
  };
  const trade: OptionLastTrade = {
    price: mid,
    size: 5,
    exchange: null,
    conditions: [],
    sipTimestamp: 1_784_000_000 * 1_000_000_000,
    timeframe: null,
  };
  const greeks: OptionGreeks = { delta: 0.52, gamma: 0.02, theta: -0.03, vega: 0.09 };
  return {
    ticker: `O:${symbol}260807${contractType === 'call' ? 'C' : 'P'}00062000`,
    contractType,
    exerciseStyle: 'american',
    expirationDate,
    expirationTime,
    strikePrice: strike,
    sharesPerContract: 100,
    breakEvenPrice: Number.NaN,
    impliedVolatility: 0.35,
    openInterest: 2_000,
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
