import {
  DEFAULT_AVWAP_CONTEXT_POLICY,
  DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG,
  applySpecialDividendO1,
  applySplitO1,
  combineMomentStates,
  computeCohortSurvivalSeries,
  computeConfluenceContext,
  computeHybridBands,
  computeIass,
  createLiveBarAccumulator,
  fromWelfordState,
  getAvwapFamilyPolicyRule,
  hasAdjustmentRevisionChanged,
  ingestLiveTickO1,
  projectAnchorLiveO1,
  commitClosedMinuteO1,
  rollupBarsToMoments,
  type AvwapAnchorFamily,
  type AvwapConfluenceContext,
  type AvwapDegradationFlag,
  type AvwapEmpiricalGateStatus,
  type AvwapLifecycleState,
  type AvwapPolicyTier,
  type AvwapTimeframe,
  type Bar,
  type IassBreakdown,
  type InstitutionalAvwapAnchor,
  type LiveAnchorProjection,
  type LiveBarAccumulator,
  type UsOptionsAvwapContextExportPayload,
  type WelfordState,
} from '../../core/avwap/index.js';
import { getUsEquitySessionPhase, sessionKey } from '../../core/sessions.js';
import { getWelfordOutput } from '../../core/welford.js';
import type { TradierStreamTick } from '../tradierAdapter.js';
import type { UsHistoricalService } from '../usHistoricalService.js';
import type {
  InstitutionalCatalystProvider,
  NormalizedOratsStrikeOiRow,
  SymbolCatalystBundle,
} from './catalystProvider.js';

export interface SymbolMarketContextSnapshot {
  readonly asOfUtcSec: number;
  readonly spot: number;
  readonly atr14: number;
  readonly dollarVol20d: number;
  readonly netGex: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly zeroGamma: number | null;
  readonly vpPoc: number | null;
  readonly vpVah: number | null;
  readonly vpVal: number | null;
  readonly vpHvns: readonly number[];
  readonly vpLvns: readonly number[];
  readonly cvdAbsorptionScore: number | null;
  readonly cvdDirectionalAlignment: number | null;
  readonly bucketRvolZ: number | null;
  readonly contango: number | null;
  readonly spyIv30dDec: number | null;
  readonly bars1d?: readonly Bar[];
}

export interface CommittedInstitutionalAnchorState {
  readonly anchorId: string;
  readonly family: AvwapAnchorFamily;
  readonly policyTier: AvwapPolicyTier;
  readonly empiricalGateStatus: AvwapEmpiricalGateStatus;
  readonly polarity: 'LONG' | 'SHORT' | 'NEUTRAL';
  readonly anchorTimeSec: number;
  readonly activatedTimeSec: number;
  readonly availableAtUtcSec: number;
  readonly lifecycleState: AvwapLifecycleState;
  readonly committedState: WelfordState;
  readonly iass: IassBreakdown;
  readonly elapsedTradingDays: number;
  readonly pinchPartnerId: string | null;
}

export interface SymbolAvwapDiagnostics {
  readonly symbol: string;
  readonly dirty: boolean;
  readonly lastAdjustmentRevision: string | null;
  readonly committedAnchors: readonly CommittedInstitutionalAnchorState[];
  readonly liveAccumulator: LiveBarAccumulator | null;
  readonly latestProjections: Readonly<Record<string, LiveAnchorProjection>>;
  readonly projectionEmitCount: number;
  readonly minuteRolloverCommits: number;
  readonly degradationFlags: readonly AvwapDegradationFlag[];
}

interface MutableSymbolAvwapRuntimeState {
  readonly symbol: string;
  committedAnchors: CommittedInstitutionalAnchorState[];
  liveAcc: LiveBarAccumulator | null;
  lastAdjustmentRevision: string | null;
  dirty: boolean;
  lastProjectionEmitMs: number;
  projectionEmitCount: number;
  minuteRolloverCommits: number;
  latestProjections: Map<string, LiveAnchorProjection>;
  marketContext: SymbolMarketContextSnapshot | null;
  catalystBundle: SymbolCatalystBundle | null;
  refreshInFlight: Promise<void> | null;
  degradationFlags: AvwapDegradationFlag[];
  enableEthEarningsShadow: boolean;
}

export interface InstitutionalAvwapRuntimeDeps {
  readonly historicalService: Pick<UsHistoricalService, 'load' | 'adjustmentRevision'> | null;
  readonly catalystProvider: InstitutionalCatalystProvider | null;
  readonly loadDailyBarsFn?: ((symbol: string, nowUtcSec: number) => Promise<readonly Bar[]>) | null;
  readonly nowMsFn?: () => number;
  readonly projectionThrottleMs?: number;
  readonly enableEthEarningsShadow?: boolean;
}

export interface OratsStrikesGexFallbackSummary {
  readonly netGex: number | null;
  readonly callWallStrike: number | null;
  readonly putWallStrike: number | null;
  readonly zeroGamma: number | null;
}

const GEX_CONTRACT_MULTIPLIER = 100;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/**
 * Pure ORATS `/live/strikes` GEX/wall/zero-gamma summary strictly anchored on canonical Massive/Tradier spot.
 * Never uses ORATS `stockPrice`/`spotPrice`.
 */
export function computeOratsStrikesGexSummary(
  strikes: readonly NormalizedOratsStrikeOiRow[],
  realSpot: number,
): OratsStrikesGexFallbackSummary {
  if (strikes.length === 0 || !Number.isFinite(realSpot) || realSpot <= 0) {
    return {
      netGex: null,
      callWallStrike: null,
      putWallStrike: null,
      zeroGamma: null,
    };
  }

  let netGexRaw = 0;
  let validRows = 0;
  const callWallByStrike = new Map<number, number>();
  const putWallByStrike = new Map<number, number>();
  const repriceInputs: {
    readonly strike: number;
    readonly tYears: number;
    readonly ivDec: number;
    readonly oiDiff: number;
  }[] = [];

  for (const row of strikes) {
    if (
      !Number.isFinite(row.strike) ||
      row.strike <= 0 ||
      !Number.isFinite(row.gamma) ||
      row.gamma < 0
    ) {
      continue;
    }
    const cOi = Number.isFinite(row.callOpenInterest) && row.callOpenInterest > 0 ? row.callOpenInterest : 0;
    const pOi = Number.isFinite(row.putOpenInterest) && row.putOpenInterest > 0 ? row.putOpenInterest : 0;
    if (cOi === 0 && pOi === 0) {
      continue;
    }

    validRows += 1;
    const gCall = Math.abs(row.gamma) * cOi * GEX_CONTRACT_MULTIPLIER;
    const gPut = Math.abs(row.gamma) * pOi * GEX_CONTRACT_MULTIPLIER;
    netGexRaw += row.gamma * (cOi - pOi) * GEX_CONTRACT_MULTIPLIER;

    if (cOi > 0) {
      callWallByStrike.set(row.strike, (callWallByStrike.get(row.strike) ?? 0) + gCall);
    }
    if (pOi > 0) {
      putWallByStrike.set(row.strike, (putWallByStrike.get(row.strike) ?? 0) + gPut);
    }

    if (
      Number.isFinite(row.dte) &&
      row.dte > 0 &&
      Number.isFinite(row.smvVolDec) &&
      row.smvVolDec > 0 &&
      cOi !== pOi
    ) {
      const tYears = row.dte / 365;
      if (row.smvVolDec * Math.sqrt(tYears) > 1e-8) {
        repriceInputs.push({
          strike: row.strike,
          tYears,
          ivDec: row.smvVolDec,
          oiDiff: (cOi - pOi) * GEX_CONTRACT_MULTIPLIER,
        });
      }
    }
  }

  if (validRows === 0) {
    return {
      netGex: null,
      callWallStrike: null,
      putWallStrike: null,
      zeroGamma: null,
    };
  }

  let callWallStrike: number | null = null;
  let bestCallWall = 0;
  for (const [k, val] of callWallByStrike.entries()) {
    if (val > bestCallWall || (val === bestCallWall && callWallStrike !== null && k < callWallStrike)) {
      bestCallWall = val;
      callWallStrike = k;
    }
  }

  let putWallStrike: number | null = null;
  let bestPutWall = 0;
  for (const [k, val] of putWallByStrike.entries()) {
    if (val > bestPutWall || (val === bestPutWall && putWallStrike !== null && k > putWallStrike)) {
      bestPutWall = val;
      putWallStrike = k;
    }
  }

  const netGex = netGexRaw * (realSpot * realSpot) * 0.01;
  let zeroGamma: number | null = null;
  if (repriceInputs.length > 0) {
    const netGexAtSpot = (s: number): number => {
      let acc = 0;
      for (const item of repriceInputs) {
        const volSqrtT = item.ivDec * Math.sqrt(item.tYears);
        const drift = (0.04 + 0.5 * item.ivDec * item.ivDec) * item.tYears;
        const d1 = (Math.log(s / item.strike) + drift) / volSqrtT;
        const gammaBs = (INV_SQRT_2PI * Math.exp(-0.5 * d1 * d1)) / (s * volSqrtT);
        acc += gammaBs * item.oiDiff;
      }
      return acc;
    };

    const gridSteps = 60;
    const minS = 0.7 * realSpot;
    const maxS = 1.3 * realSpot;
    const step = (maxS - minS) / gridSteps;
    let prevS = minS;
    let prevVal = netGexAtSpot(prevS);
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = 1; i <= gridSteps; i += 1) {
      const curS = minS + i * step;
      const curVal = netGexAtSpot(curS);
      let candidate: number | null = null;
      if (prevVal === 0) {
        candidate = prevS;
      } else if ((prevVal < 0 && curVal > 0) || (prevVal > 0 && curVal < 0)) {
        const frac = Math.abs(prevVal) / (Math.abs(prevVal) + Math.abs(curVal));
        candidate = prevS + frac * (curS - prevS);
      } else if (curVal === 0) {
        candidate = curS;
      }
      if (candidate !== null && Number.isFinite(candidate)) {
        const dist = Math.abs(candidate - realSpot);
        if (dist < bestDist) {
          bestDist = dist;
          zeroGamma = candidate;
        }
      }
      prevS = curS;
      prevVal = curVal;
    }
  }

  return {
    netGex: Number.isFinite(netGex) ? netGex : null,
    callWallStrike,
    putWallStrike,
    zeroGamma,
  };
}

function isTopDownWithinBound(
  distanceAtr: number,
  timeframe: AvwapTimeframe,
): boolean {
  if (!Number.isFinite(distanceAtr)) {
    return false;
  }
  const maxAtr =
    timeframe === '1D' || timeframe === '1W'
      ? DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.topDownMaxDistanceAtr.daily
      : DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.topDownMaxDistanceAtr.intraday;
  return distanceAtr <= maxAtr;
}

function isBlockedNegativeControl(family: AvwapAnchorFamily): boolean {
  return (
    DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.blockedNegativeControls as readonly string[]
  ).includes(family);
}

function aggregateSubdailyBarsToDaily(bars: readonly Bar[]): Bar[] {
  const byDay = new Map<string, Bar & { pvSum: number }>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.time) || !Number.isFinite(bar.close) || bar.close <= 0) {
      continue;
    }
    const dayKey = sessionKey(bar.time, 'EQUITY');
    const px = bar.vw !== undefined && Number.isFinite(bar.vw) && bar.vw > 0
      ? bar.vw
      : (bar.high + bar.low + bar.close) / 3;
    const vol = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    const prev = byDay.get(dayKey);
    if (prev === undefined) {
      byDay.set(dayKey, {
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: vol,
        pvSum: px * vol,
      });
    } else {
      const nextVol = prev.volume + vol;
      const nextPv = prev.pvSum + px * vol;
      byDay.set(dayKey, {
        time: prev.time,
        open: prev.open,
        high: Math.max(prev.high, bar.high),
        low: Math.min(prev.low, bar.low),
        close: bar.close,
        volume: nextVol,
        pvSum: nextPv,
      });
    }
  }
  return [...byDay.values()]
    .map((entry) => ({
      time: entry.time,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
      volume: entry.volume,
      ...(entry.volume > 0 ? { vw: entry.pvSum / entry.volume } : {}),
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Dual O(1) Institutional AVWAP Runtime wired strictly to `TradierStreamTick` + `UsHistoricalService`.
 * Never touches Massive WebSockets and fails open if catalyst providers are offline/degraded.
 */
export class InstitutionalAvwapRuntime {
  private readonly historicalService: Pick<UsHistoricalService, 'load' | 'adjustmentRevision'> | null;
  private readonly catalystProvider: InstitutionalCatalystProvider | null;
  private readonly loadDailyBarsFn: ((symbol: string, nowUtcSec: number) => Promise<readonly Bar[]>) | null;
  private readonly nowMsFn: () => number;
  private readonly projectionThrottleMs: number;
  private readonly enableEthEarningsShadow: boolean;
  private readonly states = new Map<string, MutableSymbolAvwapRuntimeState>();

  public constructor(deps: InstitutionalAvwapRuntimeDeps) {
    this.historicalService = deps.historicalService;
    this.catalystProvider = deps.catalystProvider;
    this.loadDailyBarsFn = deps.loadDailyBarsFn ?? null;
    this.nowMsFn = deps.nowMsFn ?? ((): number => Date.now());
    this.projectionThrottleMs = deps.projectionThrottleMs ?? DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.liveMergeThrottleMs;
    this.enableEthEarningsShadow = deps.enableEthEarningsShadow ?? false;
  }

  private getOrCreateState(rawSymbol: string): MutableSymbolAvwapRuntimeState {
    const symbol = rawSymbol.trim().toUpperCase();
    let st = this.states.get(symbol);
    if (st === undefined) {
      st = {
        symbol,
        committedAnchors: [],
        liveAcc: null,
        lastAdjustmentRevision: null,
        dirty: true,
        lastProjectionEmitMs: 0,
        projectionEmitCount: 0,
        minuteRolloverCommits: 0,
        latestProjections: new Map(),
        marketContext: null,
        catalystBundle: null,
        refreshInFlight: null,
        degradationFlags: [],
        enableEthEarningsShadow: this.enableEthEarningsShadow,
      };
      this.states.set(symbol, st);
    }
    return st;
  }

  private currentRevisionString(symbol: string): string | null {
    if (this.historicalService === null) {
      return null;
    }
    try {
      return String(this.historicalService.adjustmentRevision(symbol));
    } catch {
      return null;
    }
  }

  /**
   * Checks `UsHistoricalService.adjustmentRevision(symbol)`. On change, marks the symbol dirty
   * and clears stale provisional accumulators immediately.
   */
  public checkAdjustmentRevision(rawSymbol: string): boolean {
    const st = this.getOrCreateState(rawSymbol);
    const currentRev = this.currentRevisionString(st.symbol);
    if (hasAdjustmentRevisionChanged(st.lastAdjustmentRevision, currentRev)) {
      st.dirty = true;
      st.liveAcc = null;
      st.latestProjections.clear();
      return true;
    }
    return false;
  }

  private buildAnchorsFromBars(params: {
    readonly symbol: string;
    readonly bars1d: readonly Bar[];
    readonly bundle: SymbolCatalystBundle | null;
    readonly oratsCovered: boolean;
    readonly extraFamilies?: readonly AvwapAnchorFamily[];
  }): CommittedInstitutionalAnchorState[] {
    const { symbol, bars1d, bundle, oratsCovered } = params;
    const validBars = bars1d
      .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close) && b.close > 0 && b.volume >= 0)
      .slice()
      .sort((a, b) => a.time - b.time);
    if (validBars.length === 0) {
      return [];
    }

    const lastBar = validBars[validBars.length - 1];
    if (lastBar === undefined) {
      return [];
    }
    const currentEtDate = sessionKey(lastBar.time, 'EQUITY');
    const currentYear = currentEtDate.slice(0, 4);

    // Filter verified non-quarantined corporate actions applicable chronologically
    const safeSplits = (bundle?.corporateActions.splits ?? []).filter((s) => s.safeToApply);
    const safeSpecialDivs = (bundle?.corporateActions.dividends ?? []).filter(
      (d) => d.safeToApply && d.isSpecialCandidate,
    );

    const accumulateAdjustedFromIdx = (startIdx: number): WelfordState => {
      let state = Object.freeze({ count: 0, cumWeight: 0, mean: 0, m2: 0 }) as WelfordState;
      const startDate = sessionKey(validBars[startIdx]?.time ?? 0, 'EQUITY');
      const appliedSplitDates = new Set<string>();
      const appliedDivDates = new Set<string>();

      for (let i = startIdx; i < validBars.length; i += 1) {
        const bar = validBars[i];
        if (bar === undefined) continue;
        const barDate = sessionKey(bar.time, 'EQUITY');
        if (barDate > startDate) {
          for (const sp of safeSplits) {
            if (!appliedSplitDates.has(sp.effectiveDate) && barDate >= sp.effectiveDate) {
              appliedSplitDates.add(sp.effectiveDate);
              state = applySplitO1(state, sp.splitFrom, sp.splitTo);
            }
          }
          for (const dv of safeSpecialDivs) {
            if (!appliedDivDates.has(dv.exDate) && barDate >= dv.exDate) {
              appliedDivDates.add(dv.exDate);
              const prevBar = validBars[i - 1];
              const refClose = dv.prevClose ?? (prevBar !== undefined ? prevBar.close : Number.NaN);
              if (Number.isFinite(refClose) && refClose > 0 && dv.cashAmount < refClose) {
                state = applySpecialDividendO1(state, dv.cashAmount, refClose, 0.015).state;
              }
            }
          }
        }
        const barMom = rollupBarsToMoments([bar]);
        state = combineMomentStates([state, barMom]);
      }
      return Object.freeze(state);
    };

    const out: CommittedInstitutionalAnchorState[] = [];
    const tryAddAnchor = (
      family: AvwapAnchorFamily,
      anchorIdx: number,
      polarity: 'LONG' | 'SHORT' | 'NEUTRAL',
      overrideImpliedMoveDec: number | null = null,
      overrideRealizedRet: number | null = null,
    ): void => {
      if (isBlockedNegativeControl(family)) {
        return;
      }
      const rule = getAvwapFamilyPolicyRule(family, DEFAULT_AVWAP_CONTEXT_POLICY);
      if (rule === undefined || !rule.enabledByDefault) {
        return;
      }
      const startBar = validBars[anchorIdx];
      if (startBar === undefined) {
        return;
      }
      const prevBar = anchorIdx > 0 ? validBars[anchorIdx - 1] : undefined;
      const gapAtr =
        prevBar !== undefined && Number.isFinite(prevBar.close) && prevBar.close > 0
          ? Math.abs(startBar.open - prevBar.close) / Math.max(0.01, startBar.high - startBar.low)
          : 0.25;
      const iass = computeIass({
        family,
        polarity,
        featureAsof: startBar.time,
        oratsOpraCovered: oratsCovered,
        rvolZ: 1.5,
        realizedReturn: overrideRealizedRet,
        impliedMoveDec: overrideImpliedMoveDec,
        gapAtr,
        closeDispAtr: 0.75,
        atrValid: true,
      });

      if (rule.minIassConservative !== null && iass.scoreConservative < rule.minIassConservative) {
        return;
      }

      const committed = accumulateAdjustedFromIdx(anchorIdx);
      const anchorDate = sessionKey(startBar.time, 'EQUITY');
      if (
        family !== 'CALENDAR_YTD' &&
        bundle?.nonPitFloatShares !== undefined &&
        bundle.nonPitFloatShares !== null &&
        Number.isFinite(bundle.nonPitFloatShares) &&
        bundle.nonPitFloatShares > 0
      ) {
        computeCohortSurvivalSeries({
          volumes: validBars.map((b) => b.volume),
          anchorIdx,
          freeFloat: bundle.nonPitFloatShares,
          family,
          timeframe: '1D',
          floatIsPit: false,
          allowNonPitSensitivity: false,
        });
      }
      out.push({
        anchorId: `${symbol}:${family}:${anchorDate}:${String(anchorIdx)}`,
        family,
        policyTier: rule.tier,
        empiricalGateStatus: rule.empiricalGateStatus,
        polarity,
        anchorTimeSec: startBar.time,
        activatedTimeSec: startBar.time,
        availableAtUtcSec: startBar.time,
        lifecycleState: iass.scoreConservative >= 70 ? 'ACTIVE_PRIMARY' : 'ACTIVE_SECONDARY',
        committedState: committed,
        iass,
        elapsedTradingDays: Math.max(0, validBars.length - 1 - anchorIdx),
        pinchPartnerId: null,
      });
    };

    // 1. CALENDAR_YTD core context anchor
    const ytdIdx = validBars.findIndex((b) => sessionKey(b.time, 'EQUITY').startsWith(currentYear));
    if (ytdIdx >= 0) {
      tryAddAnchor('CALENDAR_YTD', ytdIdx, 'NEUTRAL');
    }

    // 2. Latest EARNINGS_BLOWOUT from reconciled catalyst bundle (isolated impliedEarningsMove)
    if (bundle !== null) {
      const dateToIdx = new Map<string, number>();
      for (let i = 0; i < validBars.length; i += 1) {
        const b = validBars[i];
        if (b !== undefined) {
          dateToIdx.set(sessionKey(b.time, 'EQUITY'), i);
        }
      }
      const blowouts = bundle.earnings
        .filter((e) => e.classification === 'EARNINGS_BLOWOUT')
        .sort((a, b) => {
          const da = a.reactDate ?? a.reportDate;
          const db = b.reactDate ?? b.reportDate;
          return da < db ? 1 : da > db ? -1 : 0;
        });
      const latestBlowout = blowouts[0];
      if (latestBlowout !== undefined) {
        const anchorDateKey = latestBlowout.reactDate ?? latestBlowout.reportDate;
        const idx = dateToIdx.get(anchorDateKey);
        if (idx !== undefined) {
          const ret = latestBlowout.realizedReturn ?? 0;
          tryAddAnchor(
            'EARNINGS_BLOWOUT',
            idx,
            ret >= 0 ? 'LONG' : 'SHORT',
            latestBlowout.impliedEarningsMoveDec,
            latestBlowout.realizedReturn,
          );
        }
      }
    }

    // 3. SESSION_VWAP intraday fallback anchor (last bar seed when no higher-priority anchors exist yet)
    tryAddAnchor('SESSION_VWAP', validBars.length - 1, 'NEUTRAL');

    // Explicitly evaluate POST_OPEX only through policy (disabled by default)
    for (const fam of params.extraFamilies ?? []) {
      tryAddAnchor(fam, validBars.length - 1, 'NEUTRAL');
    }

    return out;
  }

  /**
   * Hydrates/rebuilds committed anchor states from canonical bars and catalyst metadata.
   */
  public async hydrateSymbol(
    rawSymbol: string,
    options?: {
      readonly bars1d?: readonly Bar[];
      readonly ethBars1m?: readonly Bar[];
      readonly extraFamilies?: readonly AvwapAnchorFamily[];
      readonly forceRefresh?: boolean;
    },
  ): Promise<SymbolAvwapDiagnostics> {
    const st = this.getOrCreateState(rawSymbol);
    let bars1d: readonly Bar[] = options?.bars1d ?? st.marketContext?.bars1d ?? [];
    const nowSec = Math.floor(this.nowMsFn() / 1_000);

    if (bars1d.length === 0 && this.loadDailyBarsFn !== null) {
      try {
        bars1d = await this.loadDailyBarsFn(st.symbol, nowSec);
      } catch {
        // Fall through to historicalService
      }
    }

    if (bars1d.length === 0 && this.historicalService !== null) {
      try {
        const res = await this.historicalService.load({
          symbol: st.symbol,
          timeframe: '1h',
          now: nowSec,
          rthOnly: true,
        });
        bars1d = aggregateSubdailyBarsToDaily(res.rows.map((r) => r.bar));
      } catch {
        // Fail-open when historical load fails
      }
    }

    const sortedBars1d = bars1d
      .filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close) && b.close > 0)
      .slice()
      .sort((a, b) => a.time - b.time);

    const tradingDates: string[] = [];
    const closeByDate = new Map<string, number>();
    const realizedReturnByDate = new Map<string, number>();
    const prevCloseByDate = new Map<string, number>();
    for (let i = 0; i < sortedBars1d.length; i += 1) {
      const cur = sortedBars1d[i];
      if (cur === undefined) continue;
      const dKey = sessionKey(cur.time, 'EQUITY');
      if (!closeByDate.has(dKey)) {
        tradingDates.push(dKey);
      }
      closeByDate.set(dKey, cur.close);
      if (i > 0) {
        const prev = sortedBars1d[i - 1];
        if (prev !== undefined && prev.close > 0) {
          prevCloseByDate.set(dKey, prev.close);
          realizedReturnByDate.set(dKey, (cur.close - prev.close) / prev.close);
        }
      }
    }
    const latestTradingDate = tradingDates[tradingDates.length - 1];

    let bundle: SymbolCatalystBundle | null = st.catalystBundle;
    if (this.catalystProvider !== null && (bundle === null || options?.forceRefresh === true || st.dirty)) {
      try {
        bundle = await this.catalystProvider.fetchSymbolCatalystBundle(st.symbol, {
          ...(options?.ethBars1m !== undefined ? { ethBars1m: options.ethBars1m } : {}),
          realizedReturnByDate,
          prevCloseByDate,
          closeByDate,
          tradingDates,
          ...(latestTradingDate !== undefined ? { latestTradingDate } : {}),
        });
      } catch {
        // Fail-open: keep null/previous bundle
      }
    }

    st.catalystBundle = bundle;
    const oratsCovered = bundle?.oratsCovered ?? false;
    const flagSet = new Set<AvwapDegradationFlag>(bundle?.degradationFlags ?? ['NO_ORATS_COVERAGE', 'NO_NOI_IMBALANCE_FEED']);
    if (!oratsCovered) {
      flagSet.add('NO_ORATS_COVERAGE');
    }

    st.committedAnchors = this.buildAnchorsFromBars({
      symbol: st.symbol,
      bars1d,
      bundle,
      oratsCovered,
      ...(options?.extraFamilies !== undefined ? { extraFamilies: options.extraFamilies } : {}),
    });
    st.degradationFlags = [...flagSet].sort();
    st.lastAdjustmentRevision = this.currentRevisionString(st.symbol);
    st.dirty = false;

    return this.getSymbolDiagnostics(st.symbol);
  }

  /**
   * Synchronously injects already-computed GEX, Volume Profile, CVD, ATR14, and closed daily bars
   * from `marketRuntime.ts` without blocking the HTTP response.
   */
  public updateMarketContext(
    rawSymbol: string,
    context: SymbolMarketContextSnapshot,
  ): void {
    const st = this.getOrCreateState(rawSymbol);
    st.marketContext = context;
    this.checkAdjustmentRevision(st.symbol);

    if (st.committedAnchors.length === 0 && context.bars1d !== undefined && context.bars1d.length > 0) {
      const oratsCovered = st.catalystBundle?.oratsCovered ?? false;
      st.committedAnchors = this.buildAnchorsFromBars({
        symbol: st.symbol,
        bars1d: context.bars1d,
        bundle: st.catalystBundle,
        oratsCovered,
      });
      if (st.degradationFlags.length === 0) {
        st.degradationFlags = [...(st.catalystBundle?.degradationFlags ?? ['NO_NOI_IMBALANCE_FEED'])];
      }
      st.lastAdjustmentRevision = this.currentRevisionString(st.symbol);
      st.dirty = false;
    }
  }

  /**
   * Fire-and-forget background catalyst refresh so snapshot calls never stall on REST I/O.
   */
  public scheduleBackgroundRefresh(rawSymbol: string): void {
    const st = this.getOrCreateState(rawSymbol);
    if (this.catalystProvider === null) {
      return;
    }
    const staleBundle =
      st.catalystBundle === null ||
      this.nowMsFn() - st.catalystBundle.fetchedAtMs >= 90_000 ||
      st.dirty;
    if (!staleBundle || st.refreshInFlight !== null) {
      return;
    }

    const job = this.hydrateSymbol(st.symbol, {
      ...(st.marketContext?.bars1d !== undefined ? { bars1d: st.marketContext.bars1d } : {}),
      forceRefresh: true,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (st.refreshInFlight === job) {
          st.refreshInFlight = null;
        }
      });

    st.refreshInFlight = job;
  }

  /**
   * Strictly consumes `TradierStreamTick` in O(1) without mutating committed anchor states.
   */
  public ingestTradierTick(tick: TradierStreamTick): boolean {
    if (tick.event !== 'trade' && tick.event !== 'timesale') {
      return false;
    }
    if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.size) || tick.size <= 0) {
      return false;
    }
    if (!Number.isSafeInteger(tick.asOfUtcSec) || tick.asOfUtcSec <= 0) {
      return false;
    }

    const symbol = tick.symbol.trim().toUpperCase();
    if (symbol === '') {
      return false;
    }
    const st = this.getOrCreateState(symbol);

    const phase = tick.sessionPhase ?? getUsEquitySessionPhase(tick.asOfUtcSec);
    const hasActiveEarnings = st.committedAnchors.some((a) => a.family === 'EARNINGS_BLOWOUT');
    const allowEthShadow = st.enableEthEarningsShadow && hasActiveEarnings && (phase === 'PRE_MARKET' || phase === 'AFTER_HOURS');
    if (phase !== 'RTH' && !allowEthShadow) {
      return false;
    }

    this.checkAdjustmentRevision(symbol);

    const minuteBucketUtcSec = Math.floor(tick.asOfUtcSec / 60) * 60;
    let rolledOver = false;

    if (st.liveAcc === null) {
      st.liveAcc = createLiveBarAccumulator(minuteBucketUtcSec, {
        symbol,
        ...(st.lastAdjustmentRevision !== null ? { adjSig: st.lastAdjustmentRevision } : {}),
        source: 'TRADIER_WS',
      });
    } else if (minuteBucketUtcSec > st.liveAcc.minuteBucketUtcSec) {
      const closedWelford = st.liveAcc.welford;
      if (closedWelford.cumWeight > 0) {
        st.committedAnchors = st.committedAnchors.map((anchor) => ({
          ...anchor,
          committedState: Object.freeze(commitClosedMinuteO1(anchor.committedState, closedWelford)),
        }));
        st.minuteRolloverCommits += 1;
      }
      st.liveAcc = createLiveBarAccumulator(minuteBucketUtcSec, {
        symbol,
        ...(st.lastAdjustmentRevision !== null ? { adjSig: st.lastAdjustmentRevision } : {}),
        source: 'TRADIER_WS',
      });
      rolledOver = true;
    } else if (minuteBucketUtcSec < st.liveAcc.minuteBucketUtcSec) {
      return false;
    }

    st.liveAcc = ingestLiveTickO1(st.liveAcc, tick.price, tick.size, tick.asOfUtcSec);

    const nowMs = this.nowMsFn();
    const throttleElapsed =
      st.lastProjectionEmitMs === 0 || nowMs - st.lastProjectionEmitMs >= this.projectionThrottleMs;

    if (rolledOver || throttleElapsed) {
      const nextProjections = new Map<string, LiveAnchorProjection>();
      for (const anchor of st.committedAnchors) {
        if (anchor.lifecycleState === 'ARCHIVED') {
          continue;
        }
        nextProjections.set(anchor.anchorId, projectAnchorLiveO1(anchor.committedState, st.liveAcc));
      }
      st.latestProjections = nextProjections;
      st.lastProjectionEmitMs = nowMs;
      st.projectionEmitCount += 1;
      return true;
    }

    return false;
  }

  private resolvePrimaryAnchorPrice(
    st: MutableSymbolAvwapRuntimeState,
    spot: number,
    atr14: number,
    timeframe: AvwapTimeframe,
  ): { readonly anchor: CommittedInstitutionalAnchorState | null; readonly avwapPrice: number } {
    const budget = DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.visualBudgetByTimeframe[timeframe];
    const eligible = st.committedAnchors
      .map((anchor) => {
        const proj = st.latestProjections.get(anchor.anchorId);
        const avwap =
          proj !== undefined && Number.isFinite(proj.avwap)
            ? proj.avwap
            : getWelfordOutput(anchor.committedState).vwap;
        const distAtr =
          Number.isFinite(avwap) && Number.isFinite(spot) && Number.isFinite(atr14) && atr14 > 0
            ? Math.abs(spot - avwap) / atr14
            : Number.POSITIVE_INFINITY;
        return { anchor, avwap, distAtr };
      })
      .filter((item) => Number.isFinite(item.avwap) && item.avwap > 0 && isTopDownWithinBound(item.distAtr, timeframe))
      .sort((a, b) => b.anchor.iass.scoreConservative - a.anchor.iass.scoreConservative);

    const budgeted = eligible.slice(0, budget);
    const chosen = budgeted[0] ?? eligible[0];
    if (chosen !== undefined) {
      return { anchor: chosen.anchor, avwapPrice: chosen.avwap };
    }
    return { anchor: null, avwapPrice: Number.isFinite(spot) && spot > 0 ? spot : Number.NaN };
  }

  private resolveEffectiveGexFields(
    st: MutableSymbolAvwapRuntimeState,
    ctx: SymbolMarketContextSnapshot,
  ): OratsStrikesGexFallbackSummary {
    const needsFallback =
      ctx.netGex === null ||
      !Number.isFinite(ctx.netGex) ||
      ctx.callWallStrike === null ||
      ctx.putWallStrike === null ||
      ctx.zeroGamma === null;
    if (!needsFallback || st.catalystBundle === null || st.catalystBundle.strikes.length === 0) {
      return {
        netGex: ctx.netGex,
        callWallStrike: ctx.callWallStrike,
        putWallStrike: ctx.putWallStrike,
        zeroGamma: ctx.zeroGamma,
      };
    }
    const strikesGex = computeOratsStrikesGexSummary(st.catalystBundle.strikes, ctx.spot);
    return {
      netGex:
        ctx.netGex !== null && Number.isFinite(ctx.netGex)
          ? ctx.netGex
          : strikesGex.netGex,
      callWallStrike: ctx.callWallStrike ?? strikesGex.callWallStrike,
      putWallStrike: ctx.putWallStrike ?? strikesGex.putWallStrike,
      zeroGamma: ctx.zeroGamma ?? strikesGex.zeroGamma,
    };
  }

  /**
   * Returns synchronous confluence context ready for `UsSnapshotResponseDto` (never throws or awaits I/O).
   */
  public getSnapshotContext(
    rawSymbol: string,
    timeframe: AvwapTimeframe = '1D',
  ): AvwapConfluenceContext | null {
    const symbol = rawSymbol.trim().toUpperCase();
    const st = this.states.get(symbol);
    if (st === undefined || st.marketContext === null) {
      return null;
    }
    const ctx = st.marketContext;
    if (!Number.isFinite(ctx.spot) || ctx.spot <= 0 || !Number.isFinite(ctx.atr14) || ctx.atr14 <= 0) {
      return null;
    }
    const { anchor, avwapPrice } = this.resolvePrimaryAnchorPrice(st, ctx.spot, ctx.atr14, timeframe);
    if (!Number.isFinite(avwapPrice) || avwapPrice <= 0) {
      return null;
    }
    const gexFields = this.resolveEffectiveGexFields(st, ctx);

    return computeConfluenceContext({
      avwapPrice,
      spotPrice: ctx.spot,
      atr14: ctx.atr14,
      polarity: anchor?.polarity ?? 'NEUTRAL',
      netGex: gexFields.netGex,
      dollarVol20d: ctx.dollarVol20d,
      callWall: gexFields.callWallStrike,
      putWall: gexFields.putWallStrike,
      zeroGamma: gexFields.zeroGamma,
      vpPoc: ctx.vpPoc,
      vpVah: ctx.vpVah,
      vpVal: ctx.vpVal,
      vpHvns: ctx.vpHvns,
      vpLvns: ctx.vpLvns,
      cvdAbsorptionScore: ctx.cvdAbsorptionScore,
      cvdDirectionalAlignment: ctx.cvdDirectionalAlignment,
      bucketRvolZ: ctx.bucketRvolZ,
      contango: ctx.contango ?? st.catalystBundle?.summary?.contango ?? null,
      spyIv30dDec: ctx.spyIv30dDec,
      extraDegradationFlags: st.degradationFlags,
    });
  }

  /**
   * Builds compact `UsOptionsAvwapContextExportPayload` strictly following `DEFAULT_AVWAP_CONTEXT_POLICY`.
   */
  public getOptionsExportPayload(
    rawSymbol: string,
    timeframe: AvwapTimeframe = '1D',
  ): UsOptionsAvwapContextExportPayload | null {
    const symbol = rawSymbol.trim().toUpperCase();
    const st = this.states.get(symbol);
    if (st === undefined || st.marketContext === null || st.committedAnchors.length === 0) {
      return null;
    }
    const ctx = st.marketContext;
    const budget = DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.visualBudgetByTimeframe[timeframe];
    const orIvXern = st.catalystBundle?.cores?.orIvXern20dDec ?? null;
    const cleanOrIv = orIvXern !== null && Number.isFinite(orIvXern) ? orIvXern : null;

    const sorted = st.committedAnchors
      .slice()
      .filter((a) => !isBlockedNegativeControl(a.family) && getAvwapFamilyPolicyRule(a.family)?.enabledByDefault === true)
      .sort((a, b) => b.iass.scoreConservative - a.iass.scoreConservative);

    const anchors: InstitutionalAvwapAnchor[] = [];
    const mergedFlags = new Set<AvwapDegradationFlag>(st.degradationFlags);
    const gexFields = this.resolveEffectiveGexFields(st, ctx);

    for (let idx = 0; idx < sorted.length; idx += 1) {
      const a = sorted[idx];
      if (a === undefined) continue;
      const proj = st.latestProjections.get(a.anchorId);
      const effectiveState = proj !== undefined ? proj.state : a.committedState;
      const out = getWelfordOutput(effectiveState);
      if (!Number.isFinite(out.vwap) || out.vwap <= 0) {
        continue;
      }

      const distAtr =
        Number.isFinite(ctx.spot) && Number.isFinite(ctx.atr14) && ctx.atr14 > 0
          ? Math.abs(ctx.spot - out.vwap) / ctx.atr14
          : Number.NaN;
      const visible = idx < budget && (Number.isNaN(distAtr) || isTopDownWithinBound(distAtr, timeframe));

      const bands = computeHybridBands({
        avwapMu: out.vwap,
        welfordSd: Number.isFinite(out.stdDev) ? out.stdDev : 0,
        orIvXern20dDec: cleanOrIv,
        elapsedTradingDays: a.elapsedTradingDays,
        tau0: 2.0,
      });

      const confluence = computeConfluenceContext({
        avwapPrice: out.vwap,
        spotPrice: ctx.spot,
        atr14: ctx.atr14,
        polarity: a.polarity,
        netGex: gexFields.netGex,
        dollarVol20d: ctx.dollarVol20d,
        callWall: gexFields.callWallStrike,
        putWall: gexFields.putWallStrike,
        zeroGamma: gexFields.zeroGamma,
        vpPoc: ctx.vpPoc,
        vpVah: ctx.vpVah,
        vpVal: ctx.vpVal,
        vpHvns: ctx.vpHvns,
        vpLvns: ctx.vpLvns,
        cvdAbsorptionScore: ctx.cvdAbsorptionScore,
        cvdDirectionalAlignment: ctx.cvdDirectionalAlignment,
        bucketRvolZ: ctx.bucketRvolZ,
        contango: ctx.contango ?? st.catalystBundle?.summary?.contango ?? null,
        spyIv30dDec: ctx.spyIv30dDec,
        sigmaHybrid: bands.sigmaHybrid,
        extraDegradationFlags: st.degradationFlags,
      });
      for (const fl of confluence.flags) {
        mergedFlags.add(fl);
      }

      anchors.push({
        anchorId: a.anchorId,
        symbol,
        role: 'INSTITUTIONAL_CONTEXT_ONLY',
        family: a.family,
        policyTier: a.policyTier,
        empiricalGateStatus: a.empiricalGateStatus,
        polarity: a.polarity,
        anchorTimeSec: a.anchorTimeSec,
        activatedTimeSec: a.activatedTimeSec,
        availableAtUtcSec: a.availableAtUtcSec,
        lifecycleState: a.lifecycleState,
        visibleOnChart: visible,
        pinchPartnerId: a.pinchPartnerId,
        moments: fromWelfordState(effectiveState, 'PEBAY_EXACT_1M'),
        bands,
        iass: a.iass,
        confluence,
        distanceToSpotAtr: distAtr,
        degradationFlags: confluence.flags,
      });
    }

    return {
      role: 'INSTITUTIONAL_CONTEXT_ONLY',
      policyVersion: DEFAULT_AVWAP_CONTEXT_POLICY.policyVersion,
      timeframe,
      activeAnchors: anchors,
      opexResetMarkerDates: [], // POST_OPEX reset marker disabled by default in policy
      degradationFlags: [...mergedFlags].sort(),
    };
  }

  public getSymbolDiagnostics(rawSymbol: string): SymbolAvwapDiagnostics {
    const st = this.getOrCreateState(rawSymbol);
    const projRecord: Record<string, LiveAnchorProjection> = {};
    for (const [k, v] of st.latestProjections.entries()) {
      projRecord[k] = v;
    }
    return {
      symbol: st.symbol,
      dirty: st.dirty,
      lastAdjustmentRevision: st.lastAdjustmentRevision,
      committedAnchors: st.committedAnchors,
      liveAccumulator: st.liveAcc,
      latestProjections: projRecord,
      projectionEmitCount: st.projectionEmitCount,
      minuteRolloverCommits: st.minuteRolloverCommits,
      degradationFlags: st.degradationFlags,
    };
  }
}
