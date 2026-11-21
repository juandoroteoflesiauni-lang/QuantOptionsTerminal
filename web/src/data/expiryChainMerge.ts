/**
 * Pieza 50.2: fusión pura de la respuesta on-demand `GET /api/options/expiry` sobre el
 * estado de opciones US ya hidratado. Sin red, sin DOM ni mutación de argumentos:
 * reemplaza el stub del vencimiento con su cadena real (`loaded: true`), recalcula la
 * estructura temporal y los segmentos Forward IV, y registra exposición/motores por
 * vencimiento sin reiniciar el resto de la terminal.
 */

import type {
  ArOptionContractDto,
  ArOptionsQuantEnginesDto,
  ArOptionsResponse,
  ForwardIvSegmentDto,
  UsOptionContractRowDto,
  UsOptionExpiryChainResponseDto,
  UsSnapshotResponseDto,
  UsVolAnalyticsSuiteRef,
} from './liveTypes.js';
import { computeForwardIvTermStructure } from '../../../src/core/options/volSurface.js';
import { etExpiryUtcSecFromDate, formatDteLabel } from '../../../src/core/options/zeroDteFixes.js';

/** Convierte una fila serializada OPRA del servidor en el contrato del motor de la web. */
export function mapSerializedContractRowToArContract(
  clean: string,
  spot: number | null,
  r: UsOptionContractRowDto,
  daysToExpiry: number,
): ArOptionContractDto {
  const iv = r.ownIv ?? r.providerIv ?? null;
  const intrinsic =
    spot !== null && spot > 0
      ? r.contractType === 'call'
        ? Math.max(0, spot - r.strike)
        : Math.max(0, r.strike - spot)
      : 0;
  const mark = r.mid ?? r.lastPrice ?? null;
  return {
    symbol: r.ticker,
    underlying: clean,
    contractType: r.contractType,
    strike: r.strike,
    expiryCode: r.expirationDate,
    expirationDate: r.expirationDate,
    expiryUtcSec: r.expiryUtcSec,
    daysToExpiry,
    bid: r.bid,
    ask: r.ask,
    last: r.lastPrice,
    mark,
    volume: r.volume,
    openInterest: r.openInterest,
    iv,
    delta: r.delta,
    gamma: r.gamma,
    thetaDaily: r.thetaDaily,
    vegaPer1Pct: r.vegaPer1Pct,
    rho: null,
    vanna: r.vanna,
    charm: r.charm,
    intrinsic,
    extrinsic: mark !== null ? Math.max(0, mark - intrinsic) : null,
    previousClose: r.previousClose ?? null,
    changePct: r.changePct ?? null,
    source: 'DATA912' as const,
  };
}

/** Mapea la exposición de dealers del snapshot a la forma que consume la UI de opciones. */
export function mapUsExposureToArExposureSummary(
  exposure: NonNullable<UsSnapshotResponseDto['exposureSummary']>,
): NonNullable<ArOptionsResponse['exposureSummary']> {
  return {
    netGex: exposure.netGex,
    netDex: exposure.netDex,
    netVex: exposure.netVex ?? null,
    netCex: exposure.netCex ?? null,
    vannaRegime: exposure.vannaRegime ?? 'NEUTRAL',
    charmPinStrike: exposure.charmPinStrike ?? null,
    callWallStrike: exposure.callWallStrike,
    putWallStrike: exposure.putWallStrike,
    gammaFlipSpot: exposure.gammaFlipSpot,
    gammaFlipStatus: exposure.gammaFlipStatus,
    expectedMoveAbs:
      exposure.expectedMove?.straddleMove ?? exposure.expectedMove?.formulaMove ?? null,
    expectedMovePct:
      exposure.expectedMove?.straddleMovePct ?? exposure.expectedMove?.formulaMovePct ?? null,
    ...(exposure.quality
      ? {
          quality: {
            usableContracts: exposure.quality.usableContracts,
            usableOpenInterest: exposure.quality.usableOpenInterest,
          },
        }
      : {}),
    ...(exposure.byStrike
      ? {
          byStrike: exposure.byStrike.map((s) => ({
            strike: s.strike,
            callOi: s.callOi,
            putOi: s.putOi,
            callVolume: s.callVolume ?? null,
            putVolume: s.putVolume ?? null,
            callGex: s.callGex,
            putGex: s.putGex,
            netGex: s.netGex,
            vex: s.vex ?? s.netVannaExposure ?? null,
            cex: s.cex ?? s.netCharmExposure ?? null,
          })),
        }
      : {}),
  };
}

/**
 * Fusiona la respuesta puntual de UN vencimiento sobre el `ArOptionsResponse` ya
 * hidratado sin perder los vencimientos previos ni reiniciar el estado de la terminal.
 */
export function mergeUsExpiryChainIntoOptions(
  previous: ArOptionsResponse | undefined,
  response: UsOptionExpiryChainResponseDto,
): ArOptionsResponse {
  const base: ArOptionsResponse =
    previous ??
    {
      asOfUtcSec: response.asOfUtcSec,
      feedStatus: response.feedMode,
      underlying: response.symbol,
      market: 'US',
      spot: response.spot,
      rateTna: null,
      continuousRate: response.slice?.rate ?? null,
      dividendYield: response.slice?.dividendYield ?? 0,
      lotSize: 100,
      settlement: 'T+0',
      exerciseCutoffArt: '15:30 ART',
      realizedVol20d: null,
      realizedVol60d: null,
      histMedianIv: null,
      vrpSpread: null,
      historicalCloses: [],
      termStructure: [],
      expiries: [],
      exposureSummary: null,
      costSchedule: {
        rvMarketFeeRate: 0.002,
        optionsFeeRate: 0.002,
        shortLoanFeeRate: 0,
        vatRate: 0,
        bondsVatExempt: true,
      },
      providerErrors: [],
    };

  const expirationDate = response.expirationDate;
  const expiryUtcSec = response.contracts[0]?.expiryUtcSec ?? etExpiryUtcSecFromDate(expirationDate);
  const days = Number.isFinite(response.daysToExpiry) ? response.daysToExpiry : 0;
  const calls: ArOptionContractDto[] = [];
  const puts: ArOptionContractDto[] = [];
  const strikeSet = new Set<number>();
  for (const row of response.contracts) {
    strikeSet.add(row.strike);
    const mapped = mapSerializedContractRowToArContract(response.symbol, response.spot, row, days);
    if (row.contractType === 'call') calls.push(mapped);
    else puts.push(mapped);
  }
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);

  const expiryEntry: ArOptionsResponse['expiries'][number] = {
    expiryCode: expirationDate,
    expiryLabel: `${expirationDate} (${formatDteLabel(days)})`,
    expirationDate,
    expiryUtcSec: Number.isFinite(expiryUtcSec) ? expiryUtcSec : response.asOfUtcSec,
    days,
    ivAtm: response.slice?.ivAtm ?? null,
    riskReversal25: response.slice?.riskReversal25 ?? null,
    butterfly25: response.slice?.butterfly25 ?? null,
    butterflyArbitrageFree: response.slice?.isButterflyArbitrageFree ?? false,
    strikes: [...strikeSet].sort((a, b) => a - b),
    calls,
    puts,
    loaded: true,
  };

  const expiriesByCode = new Map<string, ArOptionsResponse['expiries'][number]>();
  for (const expiry of base.expiries) {
    expiriesByCode.set(expiry.expiryCode, expiry);
  }
  expiriesByCode.set(expirationDate, expiryEntry);

  const termByCode = new Map<string, ArOptionsResponse['termStructure'][number]>();
  for (const point of base.termStructure) {
    termByCode.set(point.expiryCode, point);
  }
  const atmIv = response.slice?.ivAtm ?? null;
  if (atmIv !== null && Number.isFinite(atmIv) && atmIv > 0) {
    termByCode.set(expirationDate, {
      days,
      label: expirationDate,
      expiryCode: expirationDate,
      atm: atmIv,
    });
  } else {
    termByCode.delete(expirationDate);
  }
  const termStructure = [...termByCode.values()].sort((a, b) => a.days - b.days);

  // Forward IV recomputado sobre la estructura temporal fusionada (orden por DTE).
  const forwardIvSegments: readonly ForwardIvSegmentDto[] = computeForwardIvTermStructure(
    termStructure.map((point) => ({
      expiryCode: point.expiryCode,
      expirySec: expiriesByCode.get(point.expiryCode)?.expiryUtcSec ?? response.asOfUtcSec,
      dte: point.days,
      timeToExpiry: point.days / 365,
      atmIv: point.atm,
    })),
  ).map((seg): ForwardIvSegmentDto => ({
    nearExpiryCode: seg.nearExpiryCode,
    farExpiryCode: seg.farExpiryCode,
    nearExpirySec: seg.nearExpirySec,
    farExpirySec: seg.farExpirySec,
    nearDte: seg.nearDte,
    farDte: seg.farDte,
    nearTimeToExpiry: seg.nearTimeToExpiry,
    farTimeToExpiry: seg.farTimeToExpiry,
    nearIv: Number.isFinite(seg.nearIv) ? seg.nearIv : null,
    farIv: Number.isFinite(seg.farIv) ? seg.farIv : null,
    forwardVariance: Number.isFinite(seg.forwardVariance) ? seg.forwardVariance : null,
    forwardIv: Number.isFinite(seg.forwardIv) ? seg.forwardIv : null,
    calendarArbFlag: seg.calendarArbFlag,
    status: seg.status,
  }));

  const exposureSummaryByExpiry = {
    ...(base.exposureSummaryByExpiry ?? {}),
    ...(response.exposureSummary !== null
      ? { [expirationDate]: mapUsExposureToArExposureSummary(response.exposureSummary) }
      : {}),
  };
  const quantEnginesByExpiry = {
    ...(base.quantEnginesByExpiry ?? {}),
    ...(base.quantEngines !== null && base.quantEngines !== undefined
      ? {
          [expirationDate]: {
            ...base.quantEngines,
            syntheticRates: response.syntheticRates,
          } satisfies ArOptionsQuantEnginesDto,
        }
      : {}),
  };

  return {
    ...base,
    asOfUtcSec: response.asOfUtcSec,
    feedStatus: response.feedMode,
    spot: response.spot ?? base.spot,
    expiries: [...expiriesByCode.values()].sort((a, b) => a.days - b.days),
    termStructure,
    forwardIvSegments,
    exposureSummaryByExpiry,
    quantEnginesByExpiry,
  };
}

/**
 * Aplica la respuesta puntual sobre el snapshot US cacheado: marca la fecha
 * `loaded: true` en `availableExpirations` y fusiona la suite de volatilidad del
 * vencimiento en `terminalEngines.volAnalyticsSuite.expiriesByCode`.
 */
export function applyUsExpiryChainToSnapshot(
  snap: UsSnapshotResponseDto,
  response: UsOptionExpiryChainResponseDto,
): UsSnapshotResponseDto {
  const availableExpirations = (snap.optionsChain?.availableExpirations ?? []).map((candidate) =>
    candidate.expirationDate === response.expirationDate
      ? {
          ...candidate,
          loaded: true,
          daysToExpiry: response.expiryMeta.daysToExpiry,
          validCallCount: response.expiryMeta.validCallCount,
          validPutCount: response.expiryMeta.validPutCount,
          nearAtmLiquidity: response.expiryMeta.nearAtmLiquidity,
          inDefaultWindow: response.expiryMeta.inDefaultWindow,
          hasCompleteAtmChain: response.expiryMeta.hasCompleteAtmChain,
        }
      : candidate,
  );
  const engines = snap.terminalEngines as
    | (NonNullable<UsSnapshotResponseDto['terminalEngines']> & {
        readonly volAnalyticsSuite?: UsVolAnalyticsSuiteRef | null;
      })
    | null
    | undefined;
  const suite = engines?.volAnalyticsSuite ?? null;
  const updatedSuite =
    suite !== null && response.volAnalyticsExpiry !== null
      ? {
          ...suite,
          expiriesByCode: {
            ...suite.expiriesByCode,
            [response.expirationDate]: response.volAnalyticsExpiry,
          },
        }
      : suite;
  const withOptionsChain: UsSnapshotResponseDto = snap.optionsChain
    ? { ...snap, optionsChain: { ...snap.optionsChain, availableExpirations } }
    : snap;
  if (engines === undefined || engines === null) {
    return withOptionsChain;
  }
  return {
    ...withOptionsChain,
    terminalEngines: { ...engines, volAnalyticsSuite: updatedSuite },
  };
}
