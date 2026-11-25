import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const reactRuntime = webRequire('react') as {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
};
const reactDomServer = webRequire('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};
import {
  assertNoSecretsInExportText,
  buildUsOptionsIntelligenceSnapshot,
  computeAtrTravelledPct,
  computeFlowUniverseTotals,
  computeIvRvRatio,
  computeMultiLegCreditMetrics,
  computeSkew25PutMinusCallPts,
  computeUnifiedContractMetrics,
  computeVrpVolDiffPts,
  filterSnapshotByMode,
  formatDualTimezoneTimestamp,
  validateSnapshotIntegrity,
} from '../src/core/options/usOptionsIntelligenceExport.js';
import { renderUsOptionsSnapshotMarkdown } from '../src/core/options/usOptionsSnapshotMarkdown.js';
import {
  DEFAULT_AVWAP_CONTEXT_POLICY,
  type InstitutionalAvwapAnchor,
  type UsOptionsAvwapContextExportPayload,
} from '../src/core/avwap/index.js';
import type {
  ExportUsOptionContractRowDto,
  ExportUsOptionsSnapshotRequest,
  ExportUsSnapshotInputDto,
  RawUsOptionsSnapshotInput,
  SnapshotExportResult,
} from '../src/core/options/usOptionsIntelligenceExportTypes.js';
import type { UsTerminalBarsResponseDto } from '../web/src/data/liveTypes.js';

interface TestCollectorDependencies {
  readonly getMarketSnapshot: () => {
    readonly usSnapshotsBySymbol: Record<string, ExportUsSnapshotInputDto | undefined>;
    readonly optionsCatalystsBySymbol: Record<string, NonNullable<ExportUsSnapshotInputDto['catalysts']>>;
    readonly optionsCatalystsStatusBySymbol: Record<string, string>;
    readonly usVolSurfaceBySymbol: Record<string, unknown>;
  };
  readonly getOptionsSlice: (symbolKey: string) => unknown;
  readonly getAtomicQuote: () => null;
  readonly getBarsEntry: (symbol: string, tf: '15m' | '1h') => { response: UsTerminalBarsResponseDto; cachedAtUtcSec: number } | null;
  readonly setBarsEntry: (symbol: string, tf: '15m' | '1h', res: UsTerminalBarsResponseDto, utcSec: number) => void;
  readonly fetchUsSnapshot: (...args: unknown[]) => Promise<ExportUsSnapshotInputDto | null>;
  readonly fetchUsOptionExpiry: (...args: unknown[]) => Promise<unknown>;
  readonly fetchTerminalBars: (...args: unknown[]) => Promise<UsTerminalBarsResponseDto | null>;
  readonly fetchOptionsCatalysts: (...args: unknown[]) => Promise<unknown>;
  readonly nowMs: () => number;
}

interface ReferenceFixture {
  readonly scalarsInput: {
    readonly spot: number;
    readonly atr14: number;
    readonly dayHigh: number;
    readonly dayLow: number;
    readonly ivAtmPct: number;
    readonly rv20Pct: number;
    readonly rv23Pct: number;
    readonly iv25PutPct: number;
    readonly iv25CallPct: number;
  };
  readonly scalarsExpected: {
    readonly atrTravelledPct: number;
    readonly ivRv20Ratio: number;
    readonly vrpVolDiffPts: number;
    readonly skew25PutMinusCallPts: number;
  };
  readonly contractsInput: readonly {
    readonly ticker: string;
    readonly contractType: 'call' | 'put';
    readonly strike: number;
    readonly bid: number | null;
    readonly ask: number | null;
    readonly lastPrice: number | null;
    readonly volume: number | null;
    readonly openInterest: number | null;
    readonly delta: number | null;
    readonly quoteQuality: string;
  }[];
  readonly contractsExpected: readonly {
    readonly ticker: string;
    readonly validBook: boolean;
    readonly bid: number | null;
    readonly ask: number | null;
    readonly mid: number | null;
    readonly spreadUsd: number | null;
    readonly spreadPct: number | null;
    readonly intrinsic: number;
    readonly timeValue: number | null;
    readonly distanceSpotPct: number;
    readonly moneynessClass: string;
    readonly openInterestKnown: boolean;
  }[];
  readonly creditCasesInput: readonly {
    readonly name: string;
    readonly multiplier: number;
    readonly legs: readonly {
      readonly contractType: 'call' | 'put';
      readonly side: 'BUY' | 'SELL';
      readonly strike: number;
      readonly quantity: number;
      readonly bid: number | null;
      readonly ask: number | null;
      readonly quoteQuality: string;
    }[];
  }[];
  readonly creditCasesExpected: readonly {
    readonly name: string;
    readonly validBboAllLegs: boolean;
    readonly midCreditPerShare: number | null;
    readonly conservativeCreditPerShare: number | null;
    readonly midCreditContractUsd: number | null;
    readonly conservativeCreditContractUsd: number | null;
    readonly widthPerShare: number | null;
    readonly widthContractUsd: number | null;
    readonly maxProfitContractUsd: number | null;
    readonly maxLossContractUsd: number | null;
    readonly riskRewardRatio: number | null;
    readonly breakevens: readonly number[];
  }[];
  readonly byStrikeUniverse: readonly {
    readonly strike: number;
    readonly callOi: number;
    readonly putOi: number;
    readonly callVolume: number;
    readonly putVolume: number;
    readonly netGex: number;
  }[];
  readonly flowTotalsExpected: {
    readonly totalCallVolume: number;
    readonly totalPutVolume: number;
    readonly totalLots: number;
    readonly totalCallOi: number;
    readonly totalPutOi: number;
    readonly putCallRatioVol: number;
    readonly putCallRatioOi: number;
    readonly maxPainStrike: number;
    readonly totalNetGex: number;
  };
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE: ReferenceFixture = JSON.parse(
  readFileSync(path.resolve(REPO_ROOT, 'fixtures/us_options_export_reference.json'), 'utf8'),
) as ReferenceFixture;

const BASE_UTC_SEC = 1_780_000_000; // RTH window friendly synthetic UTC sec
// 2026-06-15 14:30:00Z = 10:30 EDT (summer DST) & 11:30 ART
const SUMMER_RTH_UTC_SEC = Math.floor(Date.UTC(2026, 5, 15, 14, 30, 0) / 1_000);
// 2026-01-15 15:30:00Z = 10:30 EST (winter std) & 12:30 ART
const WINTER_RTH_UTC_SEC = Math.floor(Date.UTC(2026, 0, 15, 15, 30, 0) / 1_000);

function makeExpiryIso(asOfUtcSec: number, dteDays: number): string {
  const sec = asOfUtcSec + dteDays * 86_400;
  return new Date(sec * 1_000).toISOString().slice(0, 10);
}

function buildRichChainForExpiry(
  expDate: string,
  dteDays: number,
  asOfUtcSec: number,
  spot: number,
  strikeStart = 550,
  strikeEnd = 620,
  step = 2.5,
  multiplier = 100,
): ExportUsOptionContractRowDto[] {
  const rows: ExportUsOptionContractRowDto[] = [];
  const expUtcSec = Math.floor(Date.parse(`${expDate}T20:00:00Z`) / 1_000);
  for (let k = strikeStart; k <= strikeEnd + 1e-6; k += step) {
    const moneyness = (k - spot) / spot;
    const callDelta = Math.max(0.03, Math.min(0.95, 0.5 - moneyness * 4.5));
    const putDelta = Math.max(-0.95, Math.min(-0.03, -0.5 - moneyness * 4.5));
    const callMid = Math.max(0.15, Math.max(0, spot - k) + 3.2 * Math.exp(-80 * moneyness * moneyness));
    const putMid = Math.max(0.15, Math.max(0, k - spot) + 3.4 * Math.exp(-80 * moneyness * moneyness));
    const iv = 0.21 + 0.04 * (moneyness < 0 ? Math.abs(moneyness) * 3 : Math.abs(moneyness));

    rows.push({
      ticker: `O:SPY${expDate.replace(/-/g, '').slice(2)}C00${String(Math.round(k * 1000)).padStart(5, '0')}`,
      contractType: 'call',
      strike: k,
      expirationDate: expDate,
      expiryUtcSec: expUtcSec,
      bid: +(callMid - 0.05).toFixed(2),
      ask: +(callMid + 0.05).toFixed(2),
      mid: +callMid.toFixed(2),
      lastPrice: +callMid.toFixed(2),
      openInterest: k === 595 ? 12_000 : k === 585 ? 0 : 1_500,
      volume: Math.round(400 + dteDays * 10),
      ownIv: +iv.toFixed(4),
      providerIv: +iv.toFixed(4),
      ivSource: 'OWN',
      delta: +callDelta.toFixed(4),
      gamma: 0.021,
      thetaDaily: -0.095,
      vegaPer1Pct: 0.18,
      vanna: 0.004,
      charm: -0.002,
      contractRoot: 'SPY',
      underlyingType: 'ETF',
      exerciseStyle: 'AMERICAN',
      settlementType: 'PHYSICAL',
      valuationModel: 'AMERICAN_BS2002',
      ivQualityStatus: 'SOLVED_AMERICAN',
      quoteQuality: 'LIVE_VALID',
      quoteSource: 'TRADIER_LIVE',
      quoteTimestampUtcSec: asOfUtcSec - 15,
      sharesPerContract: multiplier,
    });

    rows.push({
      ticker: `O:SPY${expDate.replace(/-/g, '').slice(2)}P00${String(Math.round(k * 1000)).padStart(5, '0')}`,
      contractType: 'put',
      strike: k,
      expirationDate: expDate,
      expiryUtcSec: expUtcSec,
      bid: +(putMid - 0.05).toFixed(2),
      ask: +(putMid + 0.05).toFixed(2),
      mid: +putMid.toFixed(2),
      lastPrice: +putMid.toFixed(2),
      openInterest: k === 575 ? 14_000 : k === 605 ? null : 1_800,
      volume: Math.round(350 + dteDays * 8),
      ownIv: +(iv + 0.015).toFixed(4),
      providerIv: +(iv + 0.015).toFixed(4),
      ivSource: 'OWN',
      delta: +putDelta.toFixed(4),
      gamma: 0.021,
      thetaDaily: -0.091,
      vegaPer1Pct: 0.18,
      vanna: -0.003,
      charm: 0.002,
      contractRoot: 'SPY',
      underlyingType: 'ETF',
      exerciseStyle: 'AMERICAN',
      settlementType: 'PHYSICAL',
      valuationModel: 'AMERICAN_BS2002',
      ivQualityStatus: 'SOLVED_AMERICAN',
      quoteQuality: 'LIVE_VALID',
      quoteSource: 'TRADIER_LIVE',
      quoteTimestampUtcSec: asOfUtcSec - 15,
      sharesPerContract: multiplier,
    });
  }
  return rows;
}

function makeRichUsSnapshot(params: {
  readonly asOfUtcSec: number;
  readonly frontExp: string;
  readonly swingExp1: string;
  readonly swingExp2: string;
  readonly spot: number;
  readonly netGex: number;
  readonly zeroGammaSpot: number;
  readonly putWallStrike: number;
  readonly callWallStrike: number;
}): ExportUsSnapshotInputDto {
  const { asOfUtcSec, frontExp, swingExp1, swingExp2, spot, netGex, zeroGammaSpot, putWallStrike, callWallStrike } = params;
  const byStrike = [];
  for (let k = 540; k <= 630; k += 2.5) {
    byStrike.push({
      strike: k,
      callOi: k === callWallStrike ? 18_000 : 1_500,
      putOi: k === putWallStrike ? 22_000 : 1_200,
      callVolume: 450,
      putVolume: 380,
      callGex: k >= spot ? 1_250_000 : 250_000,
      putGex: k <= spot ? -1_100_000 : -150_000,
      netGex: k >= spot ? 1_100_000 : -850_000,
      vex: 120_000,
      cex: -45_000,
    });
  }
  const frontRows = buildRichChainForExpiry(frontExp, 1, asOfUtcSec, spot);
  return {
    status: 'OK',
    feedMode: 'LIVE',
    quoteMode: 'LIVE_NBBO',
    symbol: 'SPY',
    asOfUtcSec,
    marketContext: {
      unifiedQuotes: [
        {
          ticker: 'SPY',
          assetType: 'stock',
          price: spot,
          change: 2.35,
          changePct: 0.40,
          dayOpen: 583.20,
          previousClose: 583.05,
          dayLow: 582.30,
          dayHigh: 588.10,
          volumeM: 42.1,
          marketStatus: 'open',
          volume: 42_100_000,
          bid: 585.39,
          ask: 585.41,
          spreadPct: 0.0034,
          sessionPhase: 'RTH',
          quoteTimestampUtcSec: asOfUtcSec - 10,
        },
      ],
      vixLevel: 15.8,
      vixSlope: 1.1,
      vixRegime: 'CALM',
    },
    exposureSummary: {
      netGex,
      callGex: netGex >= 0 ? Math.abs(netGex) + 40_000_000 : 25_000_000,
      putGex: netGex >= 0 ? -40_000_000 : -(Math.abs(netGex) + 25_000_000),
      netDex: 125_000_000,
      netVex: 18_500_000,
      netCex: -9_200_000,
      charmPinStrike: 585,
      callWallStrike,
      putWallStrike,
      gammaFlipSpot: zeroGammaSpot,
      gammaFlipStatus: 'unique',
      trace: {
        evaluationSec: asOfUtcSec,
        valuationSpot: spot,
        valuationSpotSource: 'TRADIER_LIVE',
        headerSpot: spot,
        spotDivergenceBps: 0.5,
        quoteMode: 'LIVE_NBBO',
        coverage: 'complete',
        engineExpirationsCount: 3,
        engineExpirationDates: [frontExp, swingExp1, swingExp2],
        engineStrikeRange: { min: 540, max: 630 },
        engineStrikeCount: byStrike.length,
        byStrikeRange: { min: 540, max: 630 },
        byStrikeCount: byStrike.length,
        catalogExpirationsCount: 3,
        catalogExpirationDates: [frontExp, swingExp1, swingExp2],
        payloadContractCount: frontRows.length,
        payloadExpirationDates: [frontExp],
        quoteTimes: {
          knownCount: frontRows.length,
          unknownCount: 0,
          minUpdatedAtSec: asOfUtcSec - 20,
          maxUpdatedAtSec: asOfUtcSec - 10,
          newestAgeSec: 10,
          oldestAgeSec: 20,
          overlayQuoteCount: frontRows.length,
          eodReferenceCount: 0,
        },
        chainCoverage: {
          requestedDates: [frontExp, swingExp1, swingExp2],
          deliveredDates: [frontExp, swingExp1, swingExp2],
          missingDates: [],
          chainTruncated: false,
          chainErrors: false,
        },
      },
      expectedMove: {
        expiryUtcSec: asOfUtcSec + 86_400,
        formulaMove: 4.15,
        formulaMovePct: 0.71,
        straddleMove: 4.30,
        straddleMovePct: 0.73,
      },
      quality: {
        totalContracts: frontRows.length,
        usableContracts: frontRows.length,
        usableOpenInterest: 320_000,
      },
      byStrike,
    },
    volSurfaceSummary: {
      iv30d: 0.214,
      frontSlice: {
        expirySec: asOfUtcSec + 86_400,
        expirationDate: frontExp,
        timeToExpiryYears: 1 / 365,
        timeToExpiryDays: 1,
        forward: spot + 0.05,
        rate: 0.045,
        dividendYield: 0.012,
        ivAtm: 0.212,
        riskReversal25: 0.045,
        butterfly25: 0.008,
        isButterflyArbitrageFree: true,
        sliceQuality: 'LIVE_VALID',
      },
      slices: [
        {
          expirySec: asOfUtcSec + 86_400,
          expirationDate: frontExp,
          timeToExpiryYears: 1 / 365,
          timeToExpiryDays: 1,
          forward: spot + 0.05,
          rate: 0.045,
          dividendYield: 0.012,
          ivAtm: 0.212,
          riskReversal25: 0.045,
          butterfly25: 0.008,
          isButterflyArbitrageFree: true,
          sliceQuality: 'LIVE_VALID',
        },
        {
          expirySec: asOfUtcSec + 8 * 86_400,
          expirationDate: swingExp1,
          timeToExpiryYears: 8 / 365,
          timeToExpiryDays: 8,
          forward: spot + 0.4,
          rate: 0.045,
          dividendYield: 0.012,
          ivAtm: 0.218,
          riskReversal25: 0.052,
          butterfly25: 0.009,
          isButterflyArbitrageFree: true,
          sliceQuality: 'LIVE_VALID',
        },
        {
          expirySec: asOfUtcSec + 15 * 86_400,
          expirationDate: swingExp2,
          timeToExpiryYears: 15 / 365,
          timeToExpiryDays: 15,
          forward: spot + 0.7,
          rate: 0.045,
          dividendYield: 0.012,
          ivAtm: 0.224,
          riskReversal25: 0.056,
          butterfly25: 0.010,
          isButterflyArbitrageFree: true,
          sliceQuality: 'LIVE_VALID',
        },
      ],
      contracts: frontRows,
    },
    openingAuction: {
      balanceType: 'BALANCED',
      inventoryRisk: 'LOW',
      openingType: 'OPEN_DRIVE',
      openingDirection: 'UP',
      ibClassification: 'NORMAL_IB',
      pmh: 586.5,
      pml: 581.2,
      onPoc: 584.0,
      onVah: 585.8,
      onVal: 582.4,
      ibh: 587.1,
      ibl: 583.0,
      ibWidth: 4.1,
      atr14d: 7.25,
      gapPct: 0.12,
    },
    microstructure: {
      mtf: {
        regime1d: 'BULLISH_TREND',
        aligned4h: true,
        effectiveMacroRegime: 'ALCISTA',
        setupStatus: 'READY',
        close5m: spot,
        ema21_15m: 584.2,
        sma50_4h: 580.1,
        sma200_1d: 562.4,
        hma55: 584.9,
      },
      cvd: {
        deltaMode: 'CLV_BAR_APPROX',
        currentSessionDate: '2026-06-15',
        currentSessionCvd: 1_240_500,
      },
    },
    envelope: {
      snapshot: {
        directionalBias: 'BULLISH',
        confluenceScore: 42.5,
        keyLevels: [
          { name: 'PDH', source: 'REFERENCE', price: 586.9 },
          { name: 'PDL', source: 'REFERENCE', price: 580.4 },
          { name: 'PDC', source: 'REFERENCE', price: 583.05 },
        ],
      },
      metrics: {
        spot: { value: spot },
        realizedVol20d: { value: 18.0 },
        realizedVol60d: { value: 17.5 },
      },
    },
    usOptionsFeed: {
      source: 'TRADIER_MASSIVE_HYBRID',
      oiEffectiveDate: '2026-06-14 (Cierre OCC T-1)',
      refreshedAtUtcSec: asOfUtcSec - 10,
    },
    catalysts: {
      symbol: 'SPY',
      asOfUtcSec: asOfUtcSec - 30,
      available: true,
      nextEarnings: null,
      lastEarnings: null,
      macroEvents: [
        { kind: 'FOMC', label: 'FOMC Rate Decision', date: '2026-06-17', utcSec: asOfUtcSec + 2 * 86_400, impact: 'HIGH' },
      ],
      earningsSource: null,
      macroSource: 'FOMC_CALENDAR',
      reason: null,
    },
    optionsChain: {
      selectedExpirationDate: frontExp,
      availableExpirations: [
        { expirationDate: frontExp, daysToExpiry: 1, loaded: true, validCallCount: 28, validPutCount: 28, nearAtmLiquidity: 100, inDefaultWindow: true, hasCompleteAtmChain: true },
        { expirationDate: swingExp1, daysToExpiry: 8, loaded: true, validCallCount: 28, validPutCount: 28, nearAtmLiquidity: 100, inDefaultWindow: true, hasCompleteAtmChain: true },
        { expirationDate: swingExp2, daysToExpiry: 15, loaded: true, validCallCount: 28, validPutCount: 28, nearAtmLiquidity: 100, inDefaultWindow: true, hasCompleteAtmChain: true },
      ],
    },
    terminalEngines: {
      atr14d: 7.25,
      cvdSlopeSign: 1,
      volumeProfile: {
        status: 'OK',
        asOfUtcSec,
        windowBars: 252,
        poc: 581.5,
        vah: 589.0,
        val: 572.0,
        profileVwap: 580.2,
        totalVolume: 120_000,
        valueAreaCoverage: 0.7,
        bins: [],
        hvnBins: [{ price: 582.0, volume: 1_000, volumeShare: 0.1, volumePercentile: 92, classification: 'HVN' }],
        lvnBins: [{ price: 586.5, volume: 120, volumeShare: 0.01, volumePercentile: 8, classification: 'LVN' }],
      },
      nakedPocs: {
        status: 'OK',
        activeNakedPocs: [{ sessionDate: '2026-06-10', sessionPoc: 579.8 }],
      },
      fvgs: {
        status: 'OK',
        fvgs: [],
        activeFvgs: [
          {
            id: 'fvg-1',
            type: 'BULLISH_FVG',
            formedAtTime: asOfUtcSec - 172_800,
            gapLow: 582.5,
            gapHigh: 584.0,
            gapWidth: 1.5,
            consequentEncroachment: 583.25,
            rangeZScore: 1.45,
            fillPct: 0,
            isMitigated: false,
          },
        ],
      },
      orderBlocks: null,
      volOiAnomalies: null,
      flowAdjustedGex: null,
      wheelTracker: null,
      volCone: null,
      syntheticRates: null,
      conversionReversal: null,
      buyWrite: null,
      calendarRoll: null,
      relativeStrength: null,
      confluenceClusters: null,
      structureOptimizerBullish: null,
      structureOptimizerBearish: null,
      structureCostPercentile: null,
      orderFlow: {
        evaluatedPrints: 45,
        callBuyPremiumUsd: 3_200_000,
        callSellPremiumUsd: 1_100_000,
        callNetPremiumCvdUsd: 2_100_000,
        putBuyPremiumUsd: 900_000,
        putSellPremiumUsd: 1_800_000,
        putNetPremiumCvdUsd: -900_000,
        netDirectionalPremiumUsd: 1_200_000,
        netDeltaShares: 145_000,
        netVegaUsd: 42_000,
      },
      agresionTicks: {
        askPct: 58.2,
        bidPct: 31.4,
        neutralPct: 10.4,
        netBiasPct: 26.8,
        direction: 'COMPRADOR',
        label: 'COMPRADOR +26.8%',
        totalNotional: 8_400_000,
        classifiedContracts: 45,
        method: 'LEE_READY_BBO',
      },
      gexCharmPin: {
        gexCharmPinStrike: 585,
        peakPinStrike: 585,
        pinMagnetStrength: 0.84,
        eligibleContractsCount: 30,
      },
      qDistribution: {
        status: 'OK',
        meanQ: 585.45,
        stdDevQ: 4.35,
        skewnessQ: -0.48,
        excessKurtosisQ: 1.92,
      },
      pDistribution: {
        status: 'OK',
        usedBarsCount: 252,
        horizonSamplesCount: 251,
        meanLogReturn: 0.0005,
        stdDevLogReturn: 0.0085,
        skewness: -0.22,
        excessKurtosis: 3.1,
        overnightVarianceShare: 0.41,
        rthVarianceShare: 0.59,
        tailEventsCount: 4,
        tailFrequencyPct: 1.59,
      },
      pqDivergence: {
        status: 'OK',
        levels: [
          { label: 'Call Wall', price: callWallStrike, direction: 'ABOVE', probP: 0.24, probQ: 0.19, pqSpread: 0.05, pqRatio: 1.26, classification: 'POSITIVE_EV_LONG_CONVEXITY' },
        ],
      },
      volAnalyticsSuite: {
        status: 'OK',
        market: 'US',
        underlying: 'SPY',
        spot,
        rateContinuous: 0.045,
        rateTeaPct: 4.6,
        benchmarkLabel: 'SOFR (USD)',
        dividendYield: 0.012,
        activeExpiryCode: frontExp,
        hasDualAdr: false,
        nonDualMessage: null,
        rvWindows: {
          rv20: { minPct: 11, p25Pct: 14, medianPct: 17, p75Pct: 21, maxPct: 34, currentPct: 18.0, observations: 252 },
          rv60: { minPct: 12, p25Pct: 15, medianPct: 17.5, p75Pct: 20, maxPct: 30, currentPct: 17.5, observations: 252 },
          rv120: { minPct: 13, p25Pct: 15, medianPct: 18, p75Pct: 21, maxPct: 28, currentPct: 18.2, observations: 252 },
        },
        historicalConditional: {
          status: 'OK',
          latestRv20Pct: 18.0,
          latestRv23Pct: 17.4,
          latestRv60Pct: 17.5,
          vrpVsRv23Pts: 3.8,
          ivRank: 34.5,
          ivPercentile: 41.2,
          operativeRegime: { code: 'NEUTRAL_SELECTIVO', label: 'NEUTRAL / SELECTIVO', rationale: 'Rango medio' },
          buckets: [
            { id: 'NORMAL', label: 'Normal', rangeLabel: 'P40 – P60', minBoundPct: 16, maxBoundPct: 20, occurrences: 120, avgVolChange30dPts: -0.4, avgUnderlyingReturn30dPct: 1.2, pctVolDecreased: 54.0, isCurrent: true },
          ],
          seasonalityMonths: Array.from({ length: 12 }, (_, idx) => {
            const labels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
            return {
              monthIndex: idx,
              monthLabel: labels[idx] ?? 'N/D',
              tradingDays: 63,
              monthsSampled: 3,
              meanDailyReturnPct: 0.06,
              avgMonthlyReturnPct: 1.45,
              annualizedVolPct: 15.2,
              positiveMonthRatePct: 66.7,
            };
          }),
        },
        moneynessMatrixOtm: {
          status: 'OK',
          offsetsPct: [-10, -5, 0, 5, 10],
          rows: [],
          termRegime: 'CONTANGO',
          termSpreadPp: 1.2,
        },
        expiriesByCode: {
          [swingExp1]: {
            expiryCode: swingExp1,
            expirationDate: swingExp1,
            daysToExpiry: 8,
            smileOtmOnly: {
              atmIvPct: 21.8,
              iv25DeltaCallPct: 19.1,
              iv25DeltaPutPct: 24.5,
              riskReversal25DeltaPp: -5.4, // Intentionally inverted in volAnalyticsSuite — exporter MUST normalize to Put - Call = +5.4!
              callVsPutSkewPp: -5.4,
              compositeOtmPoints: [],
            },
            expectedCone: {
              horizonMove1SigmaPct: 3.22,
              upper1Sigma: spot * Math.exp(0.0322),
              lower1Sigma: spot * Math.exp(-0.0322),
              upper2Sigma: spot * Math.exp(0.0644),
              lower2Sigma: spot * Math.exp(-0.0644),
            },
            activeExpiryVrp: {
              status: 'OK',
              ivAtmActiveExpiryPct: 21.8,
              ivSource: 'INTERPOLATED_ATM',
              vrpActiveExpiryPts: 4.4,
              ivRankActiveExpiry: 48.0,
              ivPercentileActiveExpiry: 52.0,
              operativeRegime: { code: 'VENTA_PRIMA_CUBIERTA', label: 'VENTA DE PRIMA CUBIERTA', rationale: 'VRP > 5' },
            },
            ratiosAndStructures: {
              status: 'OK',
              structures: [
                {
                  id: 'BULL_CALL_5',
                  name: 'Bull Call Spread (5% ancho)',
                  legsLabel: '+1 C 585 / -1 C 615',
                  costPctOfMaxProfit: 42.1,
                  bs2002HistoricalPercentile: 38.0,
                  bs2002HistoricalMedianPct: 45.0,
                  bs2002HistoricalObs: 252,
                },
              ],
            },
          },
        },
      },
    },
    dataQuality: {
      ownSolvedIvContracts: 56,
      providerFallbackIvContracts: 0,
      parityExpiries: 3,
      chainContractsReceived: 56,
      chainContractsUsable: 56,
      warnings: [],
    },
  };
}

describe('US Options Intelligence Export Engine (Pieza EXPORT-1)', () => {
  it('1. Valida aritmética contra oráculo independiente Python Decimal (tolerancia <= 1e-9)', () => {
    const si = FIXTURE.scalarsInput;
    const se = FIXTURE.scalarsExpected;
    expect(Math.abs(computeAtrTravelledPct(si.dayHigh, si.dayLow, si.atr14) - se.atrTravelledPct)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(computeIvRvRatio(si.ivAtmPct, si.rv20Pct) - se.ivRv20Ratio)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(computeVrpVolDiffPts(si.ivAtmPct, si.rv23Pct) - se.vrpVolDiffPts)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(computeSkew25PutMinusCallPts(si.iv25PutPct, si.iv25CallPct) - se.skew25PutMinusCallPts)).toBeLessThanOrEqual(1e-9);

    FIXTURE.contractsInput.forEach((raw, idx) => {
      const exp = FIXTURE.contractsExpected[idx];
      expect(exp).toBeDefined();
      if (!exp) return;
      const actual = computeUnifiedContractMetrics({
        ticker: raw.ticker,
        contractType: raw.contractType,
        strike: raw.strike,
        spot: si.spot,
        bid: raw.bid,
        ask: raw.ask,
        lastPrice: raw.lastPrice,
        volume: raw.volume,
        openInterest: raw.openInterest,
        ivDecimal: 0.21,
        ivSource: 'OWN',
        delta: raw.delta,
        gamma: 0.02,
        thetaDaily: -0.05,
        vegaPer1Pct: 0.12,
        strikeGex: 100_000,
        sharesPerContract: 100,
        exerciseStyle: 'AMERICAN',
        settlementType: 'PHYSICAL',
        valuationModel: 'AMERICAN_BS2002',
        quoteQuality: raw.quoteQuality,
        quoteSource: 'TRADIER',
        quoteTimestampUtcSec: BASE_UTC_SEC,
      });

      expect(actual.validBook).toBe(exp.validBook);
      expect(actual.moneynessClass).toBe(exp.moneynessClass);
      expect(actual.openInterestKnown).toBe(exp.openInterestKnown);
      expect(Math.abs(actual.intrinsic - exp.intrinsic)).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(actual.distanceSpotPct - exp.distanceSpotPct)).toBeLessThanOrEqual(1e-9);

      if (exp.validBook) {
        expect(Math.abs(actual.mid - (exp.mid ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.spreadUsd - (exp.spreadUsd ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.spreadPct - (exp.spreadPct ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.timeValue - (exp.timeValue ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
      } else {
        // Never use last as bid/ask substitute; missing/crossed BBO degrades honestly to NaN
        expect(Number.isNaN(actual.mid)).toBe(true);
        expect(Number.isNaN(actual.spreadUsd)).toBe(true);
        expect(Number.isNaN(actual.spreadPct)).toBe(true);
        expect(Number.isNaN(actual.timeValue)).toBe(true);
      }
    });

    FIXTURE.creditCasesInput.forEach((cCase, idx) => {
      const exp = FIXTURE.creditCasesExpected[idx];
      expect(exp).toBeDefined();
      if (!exp) return;
      const actual = computeMultiLegCreditMetrics(cCase.legs, cCase.multiplier);
      expect(actual.validBboAllLegs).toBe(exp.validBboAllLegs);
      if (exp.validBboAllLegs) {
        expect(Math.abs(actual.midCreditPerShare - (exp.midCreditPerShare ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.conservativeCreditPerShare - (exp.conservativeCreditPerShare ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.midCreditContractUsd - (exp.midCreditContractUsd ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.conservativeCreditContractUsd - (exp.conservativeCreditContractUsd ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.maxProfitContractUsd - (exp.maxProfitContractUsd ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.maxLossContractUsd - (exp.maxLossContractUsd ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(actual.riskRewardRatio - (exp.riskRewardRatio ?? Number.NaN))).toBeLessThanOrEqual(1e-9);
        exp.breakevens.forEach((be, bIdx) => {
          expect(Math.abs((actual.breakevens[bIdx] ?? Number.NaN) - be)).toBeLessThanOrEqual(1e-9);
        });
      } else {
        expect(Number.isNaN(actual.conservativeCreditPerShare)).toBe(true);
      }
    });

    const totals = computeFlowUniverseTotals(FIXTURE.byStrikeUniverse);
    expect(Math.abs(totals.totalCallVolume - FIXTURE.flowTotalsExpected.totalCallVolume)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(totals.totalPutVolume - FIXTURE.flowTotalsExpected.totalPutVolume)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(totals.totalLots - FIXTURE.flowTotalsExpected.totalLots)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(totals.putCallRatioVol - FIXTURE.flowTotalsExpected.putCallRatioVol)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(totals.putCallRatioOi - FIXTURE.flowTotalsExpected.putCallRatioOi)).toBeLessThanOrEqual(1e-9);
    expect(totals.maxPainStrike).toBe(FIXTURE.flowTotalsExpected.maxPainStrike);
  });

  it('2. Distingue OI = 0 (render "0") vs OI = null/NaN (render "N/D") y mantiene signos negativos en delta de Puts', () => {
    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp1 = makeExpiryIso(asOf, 8);
    const swingExp2 = makeExpiryIso(asOf, 15);
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1,
      swingExp2,
      spot: 585.4,
      netGex: 120_000_000,
      zeroGammaSpot: 579.0,
      putWallStrike: 575,
      callWallStrike: 595,
    });

    const raw: RawUsOptionsSnapshotInput = {
      request: {
        ticker: 'SPY',
        expirations: [frontExp],
        mode: 'intraday',
        format: 'markdown',
        includeCharts: false,
      },
      capturedAtUtcSec: asOf,
      usSnapshot: snap,
      expiries: [
        {
          expirationDate: frontExp,
          daysToExpiry: 1,
          expiryUtcSec: asOf + 86_400,
          contracts: buildRichChainForExpiry(frontExp, 1, asOf, 585.4),
          exposureSummary: snap.exposureSummary ?? null,
          volAnalyticsExpiry: null,
          volSlice: snap.volSurfaceSummary?.slices?.[0] ?? null,
          sourceKind: 'SNAPSHOT_PRELOADED',
        },
      ],
      barsResponse: null,
      barsTimeframe: '15m',
      barsAsOfUtcSec: asOf - 30,
      usVolSurface: null,
      liveSpotQuote: null,
      additionalRequestsCount: 0,
    };

    const built = buildUsOptionsIntelligenceSnapshot(raw);
    const integrity = validateSnapshotIntegrity(built);
    expect(integrity.valid).toBe(true);
    const filtered = filterSnapshotByMode(built);

    // Intraday chain bounds: 0.45 <= |delta| <= 0.85, spreads disabled, flow <= 21 strikes
    const frontChain = filtered.chainsByExpiry[frontExp];
    const calls = frontChain?.calls.rows ?? [];
    const puts = frontChain?.puts.rows ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(puts.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(Math.abs(c.delta)).toBeGreaterThanOrEqual(0.45);
      expect(Math.abs(c.delta)).toBeLessThanOrEqual(0.85);
    }
    for (const p of puts) {
      expect(p.delta).toBeLessThan(0);
      expect(Math.abs(p.delta)).toBeGreaterThanOrEqual(0.45);
      expect(Math.abs(p.delta)).toBeLessThanOrEqual(0.85);
    }
    expect(filtered.spreadsByExpiry[frontExp]?.enabled).toBe(false);
    expect(filtered.flowByExpiry[frontExp]?.strikesWindow?.length ?? 0).toBeLessThanOrEqual(21);

    // OI === 0 at strike 585 Call must show as known 0; strike 605 Put is OI === null -> unknown
    const call585 = built.chainsByExpiry[frontExp]?.calls.find((c) => c.strike === 585);
    expect(call585?.openInterestKnown).toBe(true);
    expect(call585?.openInterest).toBe(0);
    const put605 = built.chainsByExpiry[frontExp]?.puts.find((p) => p.strike === 605);
    expect(put605?.openInterestKnown).toBe(false);
    expect(Number.isNaN(put605?.openInterest)).toBe(true);

    // Preserves full-universe GEX despite ±10 strike windowing
    expect(filtered.flowByExpiry[frontExp]?.netGex).toBe(built.flowByExpiry[frontExp]?.netGex);

    const mdOut = renderUsOptionsSnapshotMarkdown(filtered, integrity);
    expect(mdOut.markdown).toContain('# SNAPSHOT INSTITUCIONAL OPCIONES US — SPY');
    expect(mdOut.markdown).toContain('EMA20=N/D (no implementado)');
    expect(mdOut.markdown).toContain('IFVG: N/D (no implementado)');
    expect(mdOut.markdown).toContain('Liquidity Sweeps: N/D (no implementado)');
    expect(mdOut.markdown).not.toMatch(/\b(?:NaN|Infinity|undefined)\b/);
  });

  it('3. Respeta Swing (6-17 DTE), 2 vencimientos, Skew 25Δ Put-Call, nota Q/P front, regla Zero Gamma sin exclusión dura y filtro de ancho $2-$5', () => {
    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp1 = makeExpiryIso(asOf, 8);
    const swingExp2 = makeExpiryIso(asOf, 15);
    // spot = 585.4 < zeroGamma = 592.0, netGex = -45_000_000, spot > putWall = 575
    // -> CAUTION_SHORT_WINGS + spot < Zero Gamma warning MUST be reported, WITHOUT hard-excluding Bull Put / Iron Condor!
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1,
      swingExp2,
      spot: 585.4,
      netGex: -45_000_000,
      zeroGammaSpot: 592.0,
      putWallStrike: 575,
      callWallStrike: 595,
    });

    const contractsSwing1 = buildRichChainForExpiry(swingExp1, 8, asOf, 585.4, 560, 610, 2.5, 50);
    const contractsSwing2 = buildRichChainForExpiry(swingExp2, 15, asOf, 585.4, 560, 610, 2.5, 50);

    const raw: RawUsOptionsSnapshotInput = {
      request: {
        ticker: 'SPY',
        expirations: [swingExp1, swingExp2],
        mode: 'swing',
        format: 'markdown',
        includeCharts: false,
        swingChainFilter: 'DELTA_005_055',
      },
      capturedAtUtcSec: asOf,
      usSnapshot: snap,
      expiries: [
        {
          expirationDate: swingExp1,
          daysToExpiry: 8,
          expiryUtcSec: asOf + 8 * 86_400,
          contracts: contractsSwing1,
          exposureSummary: snap.exposureSummary ?? null,
          volAnalyticsExpiry: snap.terminalEngines?.volAnalyticsSuite?.expiriesByCode[swingExp1] ?? null,
          volSlice: snap.volSurfaceSummary?.slices?.[1] ?? null,
          sourceKind: 'EXPIRY_ENDPOINT',
        },
        {
          expirationDate: swingExp2,
          daysToExpiry: 15,
          expiryUtcSec: asOf + 15 * 86_400,
          contracts: contractsSwing2,
          exposureSummary: snap.exposureSummary ?? null,
          volAnalyticsExpiry: null,
          volSlice: snap.volSurfaceSummary?.slices?.[2] ?? null,
          sourceKind: 'EXPIRY_ENDPOINT',
        },
      ],
      barsResponse: null,
      barsTimeframe: '1h',
      barsAsOfUtcSec: asOf - 60,
      usVolSurface: null,
      liveSpotQuote: {
        price: 587.1, // +0.29% drift over valuationSpot=585.40 -> triggers SPOT_VALUATION_DRIFT warning while keeping valuationSpot anchored
        dayOpen: 583.2,
        previousClose: 583.05,
        dayLow: 582.3,
        dayHigh: 588.1,
        sessionPhase: 'RTH',
        quoteTimestampUtcSec: asOf - 75, // >60s -> triggers SPOT_STALE warning
      },
      additionalRequestsCount: 1,
    };

    const built = buildUsOptionsIntelligenceSnapshot(raw);
    expect(built.technical.valuationSpot).toBe(585.4);
    expect(built.technical.liveSpotAtCapture).toBe(587.1);

    // Normalized Skew 25Δ = IV_25P - IV_25C = 24.5 - 19.1 = +5.4 (NOT -5.4!)
    expect(built.volatility.byExpiry[swingExp1]?.skew25PutMinusCallPts).toBeCloseTo(5.4, 9);

    // Zero Gamma caution present, ShortPremiumBreaker NOT tripped (spot=585.4 > putWall=575 and dte=8 > 1)
    const spreadBlock = built.spreadsByExpiry[swingExp1];
    expect(spreadBlock).toBeDefined();
    if (!spreadBlock) throw new Error('spreadBlock missing');
    expect(spreadBlock.enabled).toBe(true);
    expect(spreadBlock.spotVsZeroGamma).toBe('BELOW_ZERO_GAMMA');
    expect(spreadBlock.dealerCreditSignal).toBe('CAUTION_SHORT_WINGS');
    expect(spreadBlock.zeroGammaOperationalNote).toContain('CAUTION_SHORT_WINGS');
    for (const c of spreadBlock.candidates) {
      expect(c.widthUsd).toBeGreaterThanOrEqual(2);
      expect(c.widthUsd).toBeLessThanOrEqual(5);
      expect(c.contractMultiplier).toBe(50);
    }

    const integrity = validateSnapshotIntegrity(built);
    expect(integrity.valid).toBe(true);
    expect(integrity.clockSkewWarnings.some((w) => w.includes('SPOT_STALE'))).toBe(true);
    expect(integrity.clockSkewWarnings.some((w) => w.includes('SPOT_VALUATION_DRIFT'))).toBe(true);

    const filtered = filterSnapshotByMode(built, { swingChainFilter: 'DELTA_005_055' });
    expect(filtered.expiryComparison).toHaveLength(2);
    expect(filtered.flowByExpiry[swingExp1]?.strikesWindow?.length ?? 0).toBeLessThanOrEqual(31);

    // Alternative Swing ±1.5σ filter behaves distinctly from Delta 0.05-0.55
    const filteredSigma = filterSnapshotByMode(built, { swingChainFilter: 'SIGMA_1_5' });
    expect(filteredSigma.swingChainFilter).toBe('SIGMA_1_5');

    const mdOut = renderUsOptionsSnapshotMarkdown(filtered, integrity);
    expect(mdOut.markdown).toContain('## 6. Comparación de vencimientos — Si corresponde');
    expect(mdOut.markdown).toContain('corresponden exclusivamente al vencimiento `front`');
    expect(mdOut.markdown).toContain('CAUTION_SHORT_WINGS');
    expect(mdOut.markdown).toContain('Comparación Q vs P = N/D');
    expect(mdOut.truncationApplied).toBe(false);
    expect(mdOut.byteLengthUtf8).toBe(new TextEncoder().encode(mdOut.markdown).byteLength);
  });

  it('4. Rechaza vencimiento incompatible sin ampliar rango DTE y bloquea secreto / cuenta privada', () => {
    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp = makeExpiryIso(asOf, 10);
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1: swingExp,
      swingExp2: makeExpiryIso(asOf, 15),
      spot: 585.4,
      netGex: 50_000_000,
      zeroGammaSpot: 575,
      putWallStrike: 570,
      callWallStrike: 595,
    });
    const built = buildUsOptionsIntelligenceSnapshot({
      request: { ticker: 'SPY', expirations: [swingExp], mode: 'intraday', format: 'markdown', includeCharts: false },
      capturedAtUtcSec: asOf,
      usSnapshot: snap,
      expiries: [{
        expirationDate: swingExp,
        daysToExpiry: 10,
        expiryUtcSec: asOf + 10 * 86_400,
        contracts: [],
        exposureSummary: snap.exposureSummary ?? null,
        volAnalyticsExpiry: null,
        volSlice: null,
        sourceKind: 'EXPIRY_ENDPOINT',
      }],
      barsResponse: null,
      barsTimeframe: null,
      barsAsOfUtcSec: null,
      usVolSurface: null,
      liveSpotQuote: null,
      additionalRequestsCount: 0,
    });

    const integrity = validateSnapshotIntegrity(built);
    expect(integrity.valid).toBe(false);
    expect(integrity.blockingErrors.some((e) => e.includes('incompatible con modo Intraday'))).toBe(true);

    expect(() => { assertNoSecretsInExportText('Bearer abcdef1234567890xyz'); }).toThrow();
    expect(() => { assertNoSecretsInExportText('POLYGON_API_KEY=supersecretvalue1234'); }).toThrow();
    expect(() => { assertNoSecretsInExportText('holding quant_core_positions_v1'); }).toThrow();
  });

  it('5. Formatea correctamente timestamps UTC con DST (EDT verano vs EST invierno) y ART', () => {
    const summer = formatDualTimezoneTimestamp(SUMMER_RTH_UTC_SEC);
    expect(summer.etFormatted).toContain('10:30:00 EDT');
    expect(summer.artFormatted).toContain('2026-06-15 11:30:00');
    expect(summer.isoUtc).toBe('2026-06-15T14:30:00Z');

    const winter = formatDualTimezoneTimestamp(WINTER_RTH_UTC_SEC);
    expect(winter.etFormatted).toContain('10:30:00 EST');
    expect(winter.artFormatted).toContain('2026-01-15 12:30:00');
    expect(winter.isoUtc).toBe('2026-01-15T15:30:00Z');
  });

  it('6. Colector: 0 requests en memoria caliente, deduplicación concurrente, cancelación AbortSignal, cache pasivo LRU y latencia <= 500 ms', async () => {
    const cacheSpec: string = '../web/src/data/usBarsMemoryCache.js';
    const collectorSpec: string = '../web/src/components/options/export/usOptionsSnapshotCollector.js';
    const {
      clearUsBarsMemoryCache,
      getUsBarsMemoryEntry,
      setUsBarsMemoryEntry,
    } = (await import(/* @vite-ignore */ cacheSpec)) as {
      clearUsBarsMemoryCache: () => void;
      getUsBarsMemoryEntry: TestCollectorDependencies['getBarsEntry'];
      setUsBarsMemoryEntry: TestCollectorDependencies['setBarsEntry'];
    };
    const {
      collectSnapshotData,
      exportUsOptionsSnapshot,
      getActiveExportJobsCount,
    } = (await import(/* @vite-ignore */ collectorSpec)) as {
      collectSnapshotData: (
        request: ExportUsOptionsSnapshotRequest,
        signal: AbortSignal,
        deps: TestCollectorDependencies,
      ) => Promise<RawUsOptionsSnapshotInput>;
      exportUsOptionsSnapshot: (
        request: ExportUsOptionsSnapshotRequest,
        signal: AbortSignal | undefined,
        deps: TestCollectorDependencies,
      ) => Promise<SnapshotExportResult>;
      getActiveExportJobsCount: () => number;
    };

    clearUsBarsMemoryCache();
    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp1 = makeExpiryIso(asOf, 8);
    const swingExp2 = makeExpiryIso(asOf, 15);
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1,
      swingExp2,
      spot: 585.4,
      netGex: 100_000_000,
      zeroGammaSpot: 575,
      putWallStrike: 570,
      callWallStrike: 595,
    });

    setUsBarsMemoryEntry('SPY', '1h', {
      status: 'OK',
      symbol: 'SPY',
      timeframe: '1h',
      barSeconds: 3600,
      rthOnly: true,
      asOfUtcSec: asOf - 30,
      visibleStartIndex: 0,
      bars: Array.from({ length: 210 }, (_, idx) => ({
        time: asOf - (210 - idx) * 3600,
        open: 580 + idx * 0.02,
        high: 581 + idx * 0.02,
        low: 579.5 + idx * 0.02,
        close: 580.5 + idx * 0.02,
        volume: 150_000,
      })),
      formingBar: null,
      overlays: {
        ema21: [],
        sma50: [],
        sma200: [],
        hma55: [],
        sessionVwap: [],
        sessionVwapSupported: false,
        avwap: [],
      },
      subPanes: {
        rsi14: [],
        sessionCvd: [],
        deltaMode: 'CLV',
      },
    }, asOf);

    const fetchUsSnapshot = vi.fn(() => Promise.resolve(snap));
    const fetchUsOptionExpiry = vi.fn(() => Promise.resolve(undefined));
    const fetchTerminalBars = vi.fn(() => Promise.resolve(null));
    const fetchOptionsCatalysts = vi.fn(() => Promise.resolve(undefined));

    const deps: TestCollectorDependencies = {
      getMarketSnapshot: () => ({
        usSnapshotsBySymbol: { SPY: snap },
        optionsCatalystsBySymbol: snap.catalysts ? { SPY: snap.catalysts } : {},
        optionsCatalystsStatusBySymbol: { SPY: 'OK' },
        usVolSurfaceBySymbol: {},
      }),
      getOptionsSlice: () => ({
        options: {
          asOfUtcSec: asOf,
          feedStatus: 'LIVE',
          underlying: 'SPY',
          market: 'US',
          spot: 585.4,
          rateTna: null,
          continuousRate: 0.045,
          dividendYield: 0.012,
          lotSize: 100,
          settlement: 'T+0',
          exerciseCutoffArt: '15:30 ART',
          realizedVol20d: 18,
          realizedVol60d: 17.5,
          histMedianIv: 21,
          vrpSpread: 3,
          historicalCloses: [],
          termStructure: [],
          expiries: [
            {
              expiryCode: swingExp1,
              expiryLabel: swingExp1,
              expirationDate: swingExp1,
              expiryUtcSec: asOf + 8 * 86_400,
              days: 8,
              ivAtm: 0.218,
              riskReversal25: 0.052,
              butterfly25: 0.009,
              butterflyArbitrageFree: true,
              strikes: [],
              calls: [],
              puts: [],
              loaded: true,
            },
          ],
          exposureSummary: null,
          costSchedule: { rvMarketFeeRate: 0.002, optionsFeeRate: 0.002, shortLoanFeeRate: 0, vatRate: 0, bondsVatExempt: true },
          providerErrors: [],
        },
        expiryGroups: [],
        loadingExpiries: {},
      }),
      getAtomicQuote: () => null,
      getBarsEntry: getUsBarsMemoryEntry,
      setBarsEntry: setUsBarsMemoryEntry,
      fetchUsSnapshot,
      fetchUsOptionExpiry,
      fetchTerminalBars,
      fetchOptionsCatalysts,
      nowMs: () => asOf * 1_000,
    };

    const req: ExportUsOptionsSnapshotRequest = {
      ticker: 'SPY',
      expirations: [swingExp1],
      mode: 'swing',
      format: 'markdown',
      includeCharts: false,
    };

    const res = await exportUsOptionsSnapshot(req, undefined, deps);
    expect(res.additionalRequestsCount).toBe(0);
    expect(fetchUsSnapshot).not.toHaveBeenCalled();
    expect(fetchUsOptionExpiry).not.toHaveBeenCalled();
    expect(fetchTerminalBars).not.toHaveBeenCalled();
    expect(fetchOptionsCatalysts).not.toHaveBeenCalled();
    expect(res.timingsMs.totalMs).toBeLessThanOrEqual(500);

    // Concurrent deduplication when a fetch is async
    let resolveSlowBars!: () => void;
    const slowFetchBars = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveSlowBars = () => { resolve(null); };
        }),
    );
    clearUsBarsMemoryCache();
    const slowDeps: TestCollectorDependencies = {
      ...deps,
      fetchTerminalBars: slowFetchBars,
    };
    const p1 = exportUsOptionsSnapshot({ ...req, mode: 'swing' }, undefined, slowDeps);
    const p2 = exportUsOptionsSnapshot({ ...req, mode: 'swing' }, undefined, slowDeps);
    expect(getActiveExportJobsCount()).toBe(1);
    expect(slowFetchBars).toHaveBeenCalledTimes(1);
    resolveSlowBars();
    await Promise.all([p1, p2]);
    expect(getActiveExportJobsCount()).toBe(0);

    // Pre-aborted AbortSignal rejects cleanly
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    await expect(collectSnapshotData(req, abortCtrl.signal, deps)).rejects.toThrow();
  });

  it('7. UI hygiene de ExportSnapshotModal: tabular-nums, font-mono-num, cero backdrop-blur ni animate-pulse/ping', async () => {
    const modalSpec: string = '../web/src/components/options/export/ExportSnapshotModal.tsx';
    const { default: ExportSnapshotModal } = (await import(/* @vite-ignore */ modalSpec)) as {
      default: unknown;
    };
    const html = reactDomServer.renderToStaticMarkup(
      reactRuntime.createElement(ExportSnapshotModal, {
        open: true,
        onClose: () => undefined,
        ticker: 'SPY',
        activeExpiryDate: '2026-06-23',
        availableExpirations: [
          { expirationDate: '2026-06-23', daysToExpiry: 8, isLoaded: true },
          { expirationDate: '2026-06-30', daysToExpiry: 15, isLoaded: false },
        ],
      }),
    );
    expect(html).toContain('data-qot-export-modal="SPY"');
    expect(html).toContain('tabular-nums');
    expect(html).toContain('font-mono-num');
    expect(html).not.toMatch(/backdrop-blur-|animate-pulse|animate-ping/);
  });

  it('8. Retrocompatibilidad Institutional AVWAP Context: cuando es undefined/null omite la sección sin alterar el snapshot', () => {
    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp1 = makeExpiryIso(asOf, 8);
    const swingExp2 = makeExpiryIso(asOf, 15);
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1,
      swingExp2,
      spot: 585.4,
      netGex: 120_000_000,
      zeroGammaSpot: 579,
      putWallStrike: 575,
      callWallStrike: 595,
    });

    const rawBase: RawUsOptionsSnapshotInput = {
      request: {
        ticker: 'SPY',
        expirations: [swingExp1],
        mode: 'swing',
        format: 'markdown',
        includeCharts: false,
      },
      capturedAtUtcSec: asOf,
      usSnapshot: snap,
      expiries: [
        {
          expirationDate: swingExp1,
          daysToExpiry: 8,
          expiryUtcSec: asOf + 8 * 86_400,
          contracts: buildRichChainForExpiry(swingExp1, 8, asOf, 585.4),
          exposureSummary: snap.exposureSummary ?? null,
          volAnalyticsExpiry: null,
          volSlice: snap.volSurfaceSummary?.slices?.[1] ?? null,
          sourceKind: 'SNAPSHOT_PRELOADED',
        },
      ],
      barsResponse: null,
      barsTimeframe: '1h',
      barsAsOfUtcSec: asOf - 30,
      usVolSurface: null,
      liveSpotQuote: null,
      additionalRequestsCount: 0,
    };

    const builtUndef = buildUsOptionsIntelligenceSnapshot(rawBase);
    expect(builtUndef.technical.institutionalAvwapContext).toBeUndefined();
    const mdUndef = renderUsOptionsSnapshotMarkdown(
      filterSnapshotByMode(builtUndef),
      validateSnapshotIntegrity(builtUndef),
    );
    expect(mdUndef.markdown).not.toContain('### Institutional AVWAP Context');
    expect(() => {
      assertNoSecretsInExportText(mdUndef.markdown);
    }).not.toThrow();

    const builtNull = buildUsOptionsIntelligenceSnapshot({
      ...rawBase,
      institutionalAvwapContext: null,
    });
    expect(builtNull.technical.institutionalAvwapContext).toBeUndefined();
    const mdNull = renderUsOptionsSnapshotMarkdown(
      filterSnapshotByMode(builtNull),
      validateSnapshotIntegrity(builtNull),
    );
    expect(mdNull.markdown).toBe(mdUndef.markdown);
  });

  it('9. Integración Institutional AVWAP Context: propaga payload activo y DTO de snapshot sin bloquear si viene null', async () => {
    const cacheSpec: string = '../web/src/data/usBarsMemoryCache.js';
    const collectorSpec: string = '../web/src/components/options/export/usOptionsSnapshotCollector.js';
    const {
      clearUsBarsMemoryCache,
      getUsBarsMemoryEntry,
      setUsBarsMemoryEntry,
    } = (await import(/* @vite-ignore */ cacheSpec)) as {
      clearUsBarsMemoryCache: () => void;
      getUsBarsMemoryEntry: TestCollectorDependencies['getBarsEntry'];
      setUsBarsMemoryEntry: TestCollectorDependencies['setBarsEntry'];
    };
    const { exportUsOptionsSnapshot } = (await import(/* @vite-ignore */ collectorSpec)) as {
      exportUsOptionsSnapshot: (
        request: ExportUsOptionsSnapshotRequest,
        signal: AbortSignal | undefined,
        deps: TestCollectorDependencies,
      ) => Promise<SnapshotExportResult>;
    };

    const asOf = SUMMER_RTH_UTC_SEC;
    const frontExp = makeExpiryIso(asOf, 1);
    const swingExp1 = makeExpiryIso(asOf, 8);
    const swingExp2 = makeExpiryIso(asOf, 15);
    const snap = makeRichUsSnapshot({
      asOfUtcSec: asOf,
      frontExp,
      swingExp1,
      swingExp2,
      spot: 585.4,
      netGex: -600_000,
      zeroGammaSpot: 586,
      putWallStrike: 575,
      callWallStrike: 595,
    });

    const anchor: InstitutionalAvwapAnchor = {
      anchorId: 'SPY:EARNINGS_BLOWOUT:1740000000',
      symbol: 'SPY',
      role: 'INSTITUTIONAL_CONTEXT_ONLY',
      family: 'EARNINGS_BLOWOUT',
      policyTier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'TIER_2_CONTEXT_ONLY',
      polarity: 'LONG',
      anchorTimeSec: asOf - 10 * 86_400,
      activatedTimeSec: asOf - 9 * 86_400,
      availableAtUtcSec: asOf - 9 * 86_400,
      lifecycleState: 'ACTIVE_PRIMARY',
      visibleOnChart: true,
      pinchPartnerId: null,
      moments: {
        count: 10,
        cumWeight: 1_000_000,
        mean: 582.35,
        m2: 18_500_000,
        varianceSource: 'PEBAY_EXACT_1M',
      },
      bands: {
        avwapMu: 582.35,
        welfordSd: 4.3,
        sigmaOratsPath: 0.24,
        expectedMove1d: 8.8,
        alpha: 0.45,
        sigmaHybrid: 6.1,
        bandSource: 'HYBRID_ORATS_WELFORD',
        upper1: 588.45,
        lower1: 576.25,
        upper2: 594.55,
        lower2: 570.15,
        upper2_5: 597.6,
        lower2_5: 567.1,
      },
      iass: {
        configVersion: 'test-v1',
        family: 'EARNINGS_BLOWOUT',
        polarity: 'LONG',
        dataCoverage: 1.0,
        prior: 50,
        componentCoverage: { M: 1, D: 1, F: 1, S: 1 },
        scoreRenormalized: 84.5,
        scoreConservative: 84.5,
        pillarScores: { M: 85, D: 80, F: 88, S: 85 },
        componentScores: {},
        tier: 'TIER_1',
        status: 'OK',
        degradationReasons: [],
        featureAsof: asOf,
      },
      confluence: {
        role: 'INSTITUTIONAL_CONTEXT_ONLY',
        bounceConfluenceScore: 31.2,
        breakoutConfluenceScore: 78.6,
        netGexNormalizedG: -0.54,
        g0DollarVolScale: 1_000_000,
        gammaRegime: 'NEGATIVE_GAMMA',
        volRegime: 'HIGH_VOL_TREND',
        meanReversionContextActive: false,
        alignedLevels: [],
        spatialKernels: {
          callWall: 595,
          putWall: 575,
          zeroGamma: 586,
          vpPoc: 583,
          vpVah: 590,
          vpVal: 578,
          vpHvnMax: 583,
          vpLvnMax: 580,
        },
        hazardFlags: ['SHORT_GAMMA_BOUNCE_HAZARD'],
        flags: ['SHORT_GAMMA_BOUNCE_HAZARD', 'NO_ORATS_COVERAGE'],
        bounceMultiplier: 0.5,
        breakoutMultiplier: 1.3,
      },
      distanceToSpotAtr: 0.42,
      degradationFlags: ['SHORT_GAMMA_BOUNCE_HAZARD', 'NO_ORATS_COVERAGE'],
    };

    const payload: UsOptionsAvwapContextExportPayload = {
      role: 'INSTITUTIONAL_CONTEXT_ONLY',
      policyVersion: DEFAULT_AVWAP_CONTEXT_POLICY.policyVersion,
      timeframe: '15m',
      activeAnchors: [anchor],
      opexResetMarkerDates: [],
      degradationFlags: ['SHORT_GAMMA_BOUNCE_HAZARD', 'NO_ORATS_COVERAGE'],
    };

    const rawWithPayload: RawUsOptionsSnapshotInput = {
      request: {
        ticker: 'SPY',
        expirations: [swingExp1],
        mode: 'swing',
        format: 'markdown',
        includeCharts: false,
      },
      capturedAtUtcSec: asOf,
      usSnapshot: snap,
      expiries: [
        {
          expirationDate: swingExp1,
          daysToExpiry: 8,
          expiryUtcSec: asOf + 8 * 86_400,
          contracts: buildRichChainForExpiry(swingExp1, 8, asOf, 585.4),
          exposureSummary: snap.exposureSummary ?? null,
          volAnalyticsExpiry: null,
          volSlice: snap.volSurfaceSummary?.slices?.[1] ?? null,
          sourceKind: 'SNAPSHOT_PRELOADED',
        },
      ],
      barsResponse: null,
      barsTimeframe: '15m',
      barsAsOfUtcSec: asOf - 30,
      usVolSurface: null,
      liveSpotQuote: null,
      additionalRequestsCount: 0,
      institutionalAvwapContext: payload,
    };

    const built = buildUsOptionsIntelligenceSnapshot(rawWithPayload);
    const integrity = validateSnapshotIntegrity(built);
    expect(integrity.valid).toBe(true);
    const md = renderUsOptionsSnapshotMarkdown(filterSnapshotByMode(built), integrity);
    expect(md.markdown).toContain('### Institutional AVWAP Context');
    expect(md.markdown).toContain('Context Only');
    expect(md.markdown).toContain('NEGATIVE_GAMMA');
    expect(md.markdown).toContain('HIGH_VOL_TREND');
    expect(md.markdown).toContain('SHORT_GAMMA_BOUNCE_HAZARD');
    expect(md.markdown).toContain('SPY:EARNINGS_BLOWOUT:1740000000');
    expect(md.markdown).toContain('Bounce `31.2` vs Breakout `78.6`');
    expect(md.markdown).toContain('Degradation Flags:');
    expect(md.markdown).toContain('NO_ORATS_COVERAGE');

    clearUsBarsMemoryCache();
    setUsBarsMemoryEntry('SPY', '1h', {
      status: 'OK',
      symbol: 'SPY',
      timeframe: '1h',
      barSeconds: 3600,
      rthOnly: true,
      asOfUtcSec: asOf - 30,
      visibleStartIndex: 0,
      bars: Array.from({ length: 60 }, (_, idx) => ({
        time: asOf - (60 - idx) * 3600,
        open: 580 + idx * 0.05,
        high: 581 + idx * 0.05,
        low: 579.5 + idx * 0.05,
        close: 580.5 + idx * 0.05,
        volume: 150_000,
      })),
      formingBar: null,
      overlays: {
        ema21: [],
        sma50: [],
        sma200: [],
        hma55: [],
        sessionVwap: [],
        sessionVwapSupported: false,
        avwap: [],
      },
      subPanes: {
        rsi14: [],
        sessionCvd: [],
        deltaMode: 'CLV',
      },
    }, asOf);

    const dtoSnap: ExportUsSnapshotInputDto = {
      ...snap,
      institutionalAvwapContext: {
        role: 'INSTITUTIONAL_CONTEXT_ONLY',
        bounceConfluenceScore: 68.4,
        breakoutConfluenceScore: 42.1,
        netGexNormalizedG: 0.45,
        g0DollarVolScale: 1_000_000,
        gammaRegime: 'POSITIVE_GAMMA',
        volRegime: 'MID_VOL',
        meanReversionContextActive: true,
        alignedLevels: [],
        spatialKernels: {
          callWall: 595,
          putWall: 575,
          zeroGamma: 585,
          vpPoc: 584,
          vpVah: 590,
          vpVal: 578,
          vpHvnMax: null,
          vpLvnMax: null,
        },
        hazardFlags: [],
        flags: ['ORATS_OI_FALLBACK_MASSIVE'],
        bounceMultiplier: 1.2,
        breakoutMultiplier: 0.9,
      },
    };
    const depsWithAvwap: TestCollectorDependencies = {
      getMarketSnapshot: () => ({
        usSnapshotsBySymbol: { SPY: dtoSnap },
        optionsCatalystsBySymbol: snap.catalysts ? { SPY: snap.catalysts } : {},
        optionsCatalystsStatusBySymbol: { SPY: 'OK' },
        usVolSurfaceBySymbol: {},
      }),
      getOptionsSlice: () => ({
        options: {
          asOfUtcSec: asOf,
          feedStatus: 'LIVE',
          underlying: 'SPY',
          market: 'US',
          spot: 585.4,
          rateTna: null,
          continuousRate: 0.045,
          dividendYield: 0.012,
          lotSize: 100,
          settlement: 'T+0',
          exerciseCutoffArt: '15:30 ART',
          realizedVol20d: 18,
          realizedVol60d: 17.5,
          histMedianIv: 21,
          vrpSpread: 3,
          historicalCloses: [],
          termStructure: [],
          expiries: [
            {
              expiryCode: swingExp1,
              expiryLabel: swingExp1,
              expirationDate: swingExp1,
              expiryUtcSec: asOf + 8 * 86_400,
              days: 8,
              ivAtm: 0.218,
              riskReversal25: 0.052,
              butterfly25: 0.009,
              butterflyArbitrageFree: true,
              strikes: [],
              calls: [],
              puts: [],
              loaded: true,
            },
          ],
          exposureSummary: null,
          costSchedule: { rvMarketFeeRate: 0, optionsFeeRate: 0, shortLoanFeeRate: 0, vatRate: 0, bondsVatExempt: true },
          providerErrors: [],
        },
        expiryGroups: [],
        loadingExpiries: {},
      }),
      getAtomicQuote: () => null,
      getBarsEntry: getUsBarsMemoryEntry,
      setBarsEntry: setUsBarsMemoryEntry,
      fetchUsSnapshot: () => Promise.resolve(snap),
      fetchUsOptionExpiry: () => Promise.resolve(undefined),
      fetchTerminalBars: () => Promise.resolve(null),
      fetchOptionsCatalysts: () => Promise.resolve(undefined),
      nowMs: () => asOf * 1_000,
    };

    const collected = await exportUsOptionsSnapshot(
      { ticker: 'SPY', expirations: [swingExp1], mode: 'swing', format: 'markdown', includeCharts: false },
      undefined,
      depsWithAvwap,
    );
    expect(collected.markdown).toContain('### Institutional AVWAP Context');
    expect(collected.markdown).toContain('POSITIVE_GAMMA');
    expect(collected.markdown).toContain('Bounce `68.4` vs Breakout `42.1`');
    expect(collected.markdown).toContain('ORATS_OI_FALLBACK_MASSIVE');

    const collectedNull = await exportUsOptionsSnapshot(
      { ticker: 'SPY', expirations: [swingExp1], mode: 'swing', format: 'markdown', includeCharts: false },
      undefined,
      {
        ...depsWithAvwap,
        getMarketSnapshot: () => ({
          usSnapshotsBySymbol: { SPY: { ...snap, institutionalAvwapContext: null } },
          optionsCatalystsBySymbol: snap.catalysts ? { SPY: snap.catalysts } : {},
          optionsCatalystsStatusBySymbol: { SPY: 'OK' },
          usVolSurfaceBySymbol: {},
        }),
      },
    );
    expect(collectedNull.integrity.valid).toBe(true);
    expect(collectedNull.markdown).not.toContain('### Institutional AVWAP Context');
  });
});
