/**
 * Pieza 50.2: fusión pura de la respuesta on-demand `GET /api/options/expiry` sobre el
 * estado de opciones US ya hidratado. Sin red, sin DOM ni mutación de argumentos:
 * reemplaza el stub del vencimiento con su cadena real (`loaded: true`), recalcula la
 * estructura temporal y los segmentos Forward IV, y registra exposición/motores por
 * vencimiento sin reiniciar el resto de la terminal.
 */

import type {
  ArOptionContractDto,
  ArOptionExpiryDto,
  ArOptionsQuantEnginesDto,
  ArOptionsResponse,
  FeedStatus,
  ForwardIvSegmentDto,
  UsOptionContractRowDto,
  UsOptionExpiryChainResponseDto,
  UsSnapshotResponseDto,
  UsVolAnalyticsSuiteRef,
} from './liveTypes.js';
import { computeForwardIvTermStructure } from '../../../src/core/options/volSurface.js';
import {
  calendarDteEt,
  etExpiryUtcSecFromDate,
  formatDteLabel,
} from '../../../src/core/options/zeroDteFixes.js';

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
export function mapUsSnapshotToArOptions(clean: string, snap: UsSnapshotResponseDto): ArOptionsResponse {
  const quote = snap.marketContext?.unifiedQuotes?.find((q) => q.ticker.toUpperCase() === clean);
  const snapMetrics = snap.envelope?.snapshot?.metrics;
  const spot = snapMetrics?.spot ?? snap.envelope?.metrics?.spot?.value ?? quote?.price ?? null;
  const frontSlice = snap.volSurfaceSummary?.frontSlice ?? snap.volSurfaceSummary?.slices?.[0] ?? null;
  const rateDec = frontSlice?.rate ?? snap.marketContext?.treasury?.rate30d ?? null;
  const rateTna = rateDec !== null && Number.isFinite(rateDec) ? (Math.exp(rateDec) - 1) * 100 : null;
  const rv20 = snapMetrics?.realizedVolAnnualized ?? snap.envelope?.metrics?.realizedVol20d?.value ?? null;
  const rv60 = snapMetrics?.rvCenteredAnnualized ?? snap.envelope?.metrics?.realizedVol60d?.value ?? null;
  const iv30 = snap.volSurfaceSummary?.iv30d ?? snapMetrics?.iv30d ?? frontSlice?.ivAtm ?? null;

  type UsContractList = NonNullable<NonNullable<UsSnapshotResponseDto['volSurfaceSummary']>['contracts']>[number];
  const contractsByExp = new Map<string, UsContractList[]>();
  const sliceMap = new Map((snap.volSurfaceSummary?.slices ?? []).map((s) => [s.expirationDate, s]));
  for (const row of snap.volSurfaceSummary?.contracts ?? []) {
    const arr = contractsByExp.get(row.expirationDate) ?? [];
    arr.push(row);
    contractsByExp.set(row.expirationDate, arr);
  }

  const expiries = Array.from(contractsByExp.entries())
    .map(([expDate, rows]) => {
      const slice = sliceMap.get(expDate);
      const firstRow = rows[0];
      const expSec = slice?.expirySec ?? firstRow?.expiryUtcSec ?? snap.asOfUtcSec;
      // Pieza 46.1: DTE calendario real en America/New_York (expiry == hoy ET -> 0, etiqueta 0DTE).
      const dteEt = calendarDteEt(expDate, snap.asOfUtcSec * 1000);
      const days = Number.isFinite(dteEt)
        ? dteEt
        : (slice?.timeToExpiryDays ?? Math.max(1, Math.round((expSec - snap.asOfUtcSec) / 86_400)));
      const strikeSet = new Set<number>();
      const calls: ArOptionsResponse['expiries'][number]['calls'][number][] = [];
      const puts: ArOptionsResponse['expiries'][number]['puts'][number][] = [];
      const rowDaysToExpiry = Number.isFinite(dteEt) ? dteEt : Math.max(1, Math.round(days));
      for (const r of rows) {
        strikeSet.add(r.strike);
        const mapped = mapSerializedContractRowToArContract(clean, spot, r, rowDaysToExpiry);
        if (r.contractType === 'call') calls.push(mapped);
        else puts.push(mapped);
      }
      calls.sort((a, b) => a.strike - b.strike);
      puts.sort((a, b) => a.strike - b.strike);
      const strikes = Array.from(strikeSet).sort((a, b) => a - b);

      let resolvedIvAtmDec =
        slice?.ivAtm !== null && slice?.ivAtm !== undefined && Number.isFinite(slice.ivAtm) && slice.ivAtm > 0
          ? slice.ivAtm
          : null;
      if (resolvedIvAtmDec === null && spot !== null && Number.isFinite(spot) && spot > 0) {
        const nearOtmIvs = [...calls, ...puts]
          .filter(
            (c) =>
              c.iv !== null &&
              Number.isFinite(c.iv) &&
              c.iv > 0 &&
              c.iv < 9.99 &&
              (c.contractType === 'call' ? c.strike >= spot - 1e-6 : c.strike <= spot + 1e-6),
          )
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          .slice(0, 2)
          .map((c) => c.iv as number);
        if (nearOtmIvs.length > 0) {
          resolvedIvAtmDec = nearOtmIvs.reduce((acc, v) => acc + v, 0) / nearOtmIvs.length;
        }
      }

      const resolvedDays = Number.isFinite(dteEt) ? dteEt : Math.max(0, Math.round(days));
      return {
        expiryCode: expDate,
        expiryLabel: `${expDate} (${formatDteLabel(resolvedDays)})`,
        expirationDate: expDate,
        expiryUtcSec: expSec,
        days: resolvedDays,
        ivAtm: resolvedIvAtmDec,
        riskReversal25: slice?.riskReversal25 ?? null,
        butterfly25: slice?.butterfly25 ?? null,
        butterflyArbitrageFree: slice?.isButterflyArbitrageFree ?? true,
        strikes,
        calls,
        puts,
        loaded: true,
      };
    })
    .sort((a, b) => a.days - b.days);

  // Pieza 50.1: incluir fechas de `availableExpirations` aún no hidratadas en profundidad
  // (stub sin contratos) para que el selector las muestre y dispare la carga on-demand.
  const hydratedExpiryCodes = new Set(expiries.map((e) => e.expiryCode));
  for (const candidate of snap.optionsChain?.availableExpirations ?? []) {
    if (hydratedExpiryCodes.has(candidate.expirationDate)) continue;
    const dteCandidate = calendarDteEt(candidate.expirationDate, snap.asOfUtcSec * 1_000);
    const days = Number.isFinite(dteCandidate) ? dteCandidate : candidate.daysToExpiry;
    const expiryUtcSec = etExpiryUtcSecFromDate(candidate.expirationDate);
    expiries.push({
      expiryCode: candidate.expirationDate,
      expiryLabel: `${candidate.expirationDate} (${formatDteLabel(days)})`,
      expirationDate: candidate.expirationDate,
      expiryUtcSec: Number.isFinite(expiryUtcSec) ? expiryUtcSec : snap.asOfUtcSec,
      days,
      ivAtm: null,
      riskReversal25: null,
      butterfly25: null,
      butterflyArbitrageFree: false,
      strikes: [],
      calls: [],
      puts: [],
      loaded: false,
    });
    hydratedExpiryCodes.add(candidate.expirationDate);
  }
  expiries.sort((a, b) => a.days - b.days);

  const termStructure = (
    (snap.volSurfaceSummary?.slices ?? []).some((s) => s.ivAtm !== null && s.ivAtm > 0)
      ? (snap.volSurfaceSummary?.slices ?? [])
          .filter((s) => s.ivAtm !== null && s.ivAtm > 0)
          .map((s) => {
            const sDteEt = calendarDteEt(s.expirationDate, snap.asOfUtcSec * 1_000);
            return {
              days: Number.isFinite(sDteEt) ? sDteEt : Math.max(0, Math.round(s.timeToExpiryDays)),
              label: s.expirationDate,
              expiryCode: s.expirationDate,
              atm: s.ivAtm as number,
            };
          })
      : expiries
          .filter((e) => e.ivAtm !== null && Number.isFinite(e.ivAtm) && e.ivAtm > 0)
          .map((e) => ({
            days: e.days,
            label: e.expirationDate,
            expiryCode: e.expiryCode,
            atm: e.ivAtm as number,
          }))
  );

  const te = snap.terminalEngines ?? null;
  const quantEngines: ArOptionsResponse['quantEngines'] = te
    ? {
        orderFlowArs: te.orderFlow,
        netDirectionalPremiumUsdCcl: te.orderFlow?.netDirectionalPremiumUsd ?? null,
        callNetPremiumCvdUsdCcl: te.orderFlow?.callNetPremiumCvdUsd ?? null,
        putNetPremiumCvdUsdCcl: te.orderFlow?.putNetPremiumCvdUsd ?? null,
        volOiAnomalies: te.volOiAnomalies,
        flowAdjustedGex: te.flowAdjustedGex,
        gexCharmPin: te.gexCharmPin,
        qDistribution: te.qDistribution,
        pDistribution: te.pDistribution,
        pqDivergence: te.pqDivergence,
        volCone: te.volCone,
        syntheticRates: te.syntheticRates,
        conversionReversal: te.conversionReversal,
        buyWrite: te.buyWrite,
        calendarRoll: te.calendarRoll,
        structureOptimizerBullish: te.structureOptimizerBullish,
        structureOptimizerBearish: te.structureOptimizerBearish,
        structureCostPercentile: te.structureCostPercentile,
        confluenceClusters: te.confluenceClusters,
      }
    : null;

  const feedStatus: FeedStatus =
    snap.feedMode ?? (snap.status === 'OK' ? 'LIVE' : 'PARTIAL');

  return {
    asOfUtcSec: snap.asOfUtcSec,
    feedStatus,
    underlying: clean,
    market: 'US',
    spot,
    rateTna,
    continuousRate: rateDec,
    dividendYield:
      frontSlice !== null &&
      frontSlice.timeToExpiryDays >= 3 &&
      frontSlice.dividendYield !== null &&
      Number.isFinite(frontSlice.dividendYield) &&
      frontSlice.dividendYield >= 0 &&
      frontSlice.dividendYield <= 0.25
        ? frontSlice.dividendYield
        : snap.marketContext?.treasury?.dividendYieldFront !== null &&
            snap.marketContext?.treasury?.dividendYieldFront !== undefined &&
            Number.isFinite(snap.marketContext.treasury.dividendYieldFront) &&
            snap.marketContext.treasury.dividendYieldFront >= 0 &&
            snap.marketContext.treasury.dividendYieldFront <= 0.25
          ? snap.marketContext.treasury.dividendYieldFront
          : 0,
    lotSize: 100,
    settlement: 'T+0',
    exerciseCutoffArt: '15:30 ART',
    realizedVol20d: rv20,
    realizedVol60d: rv60,
    histMedianIv: iv30,
    vrpSpread: iv30 !== null && rv20 !== null ? iv30 - rv20 : null,
    historicalCloses: [],
    termStructure,
    expiries,
    exposureSummary: snap.exposureSummary
      ? mapUsExposureToArExposureSummary(snap.exposureSummary)
      : null,
    costSchedule: {
      rvMarketFeeRate: 0.002,
      optionsFeeRate: 0.002,
      shortLoanFeeRate: 0,
      vatRate: 0,
      bondsVatExempt: true,
    },
    primaryLiquidExpiryCode: snap.optionsChain?.selectedExpirationDate ?? null,
    ...(snap.volSurfaceSummary?.forwardIvSegments
      ? { forwardIvSegments: snap.volSurfaceSummary.forwardIvSegments }
      : {}),
    quantEngines,
    providerErrors: [],
  };
}

/** Entrada del selector de vencimientos (100 % del catálogo del subyacente seleccionado). */
export interface ExpirySelectorEntry {
  readonly id: string;
  readonly expiryDate: string;
  readonly daysToExpiry: number;
  /** IV ATM en puntos porcentuales (22.5 = 22.5 %); `NaN` si no es calculable (UI `—`). */
  readonly atmIvPct: number;
  /** `true` si la cadena del vencimiento está cargada (filas reales o `loaded: true`). */
  readonly isLoaded: boolean;
}

/**
 * Pieza 50.2.1: construye las filas del selector de vencimientos EXCLUSIVAMENTE desde el
 * estado del subyacente seleccionado (`optionsByUnderlying[key].expiries`). El array
 * global `GGAL_OPTION_EXPIRIES` es compartido AR/US y cualquier otro subyacente puede
 * pisarlo (p. ej. GGAL BYMA al reconectar), recortando el catálogo de SPY a sus 2
 * vencimientos: el selector jamás debe leerlo.
 */
export function buildExpirySelectorEntries(
  expiries: readonly ArOptionExpiryDto[],
): readonly ExpirySelectorEntry[] {
  return [...expiries]
    .map((expiry) => ({
      id: expiry.expiryCode,
      expiryDate: expiry.expirationDate,
      daysToExpiry: expiry.days,
      atmIvPct:
        expiry.ivAtm !== null && expiry.ivAtm !== undefined && Number.isFinite(expiry.ivAtm)
          ? expiry.ivAtm * 100
          : Number.NaN,
      isLoaded: expiry.loaded === true || expiry.calls.length > 0 || expiry.puts.length > 0,
    }))
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}
