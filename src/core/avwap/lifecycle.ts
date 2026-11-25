import { sessionKey } from '../sessions.js';
import type {
  AvwapLifecycleState,
  AvwapPolarity,
  AvwapTimeframe,
} from './types.js';

export const VISUAL_BUDGET_BY_TIMEFRAME: Readonly<Record<AvwapTimeframe, number>> = Object.freeze({
  '1W': 3,
  '1D': 3,
  '4H': 4,
  '1H': 4,
  '65m': 4,
  '30m': 4,
  '15m': 3,
  '5m': 3,
  '1m': 3,
});

export const FLAT_SLOPE_H_BY_TIMEFRAME: Readonly<
  Record<AvwapTimeframe, Readonly<{ horizonH: number; status: 'APPROVED_SPEC' }>>
> = Object.freeze({
  '1W': { horizonH: 5, status: 'APPROVED_SPEC' },
  '1D': { horizonH: 5, status: 'APPROVED_SPEC' },
  '4H': { horizonH: 10, status: 'APPROVED_SPEC' },
  '1H': { horizonH: 10, status: 'APPROVED_SPEC' },
  '65m': { horizonH: 9, status: 'APPROVED_SPEC' },
  '30m': { horizonH: 10, status: 'APPROVED_SPEC' },
  '15m': { horizonH: 10, status: 'APPROVED_SPEC' },
  '5m': { horizonH: 10, status: 'APPROVED_SPEC' },
  '1m': { horizonH: 10, status: 'APPROVED_SPEC' },
});

export interface LifecycleConfig {
  readonly configVersion: string;
  readonly cohortSurvivalMin: number;
  readonly cohortStepCap: number;
  readonly cohortExemptFamilies1w: readonly string[];
  readonly chopNeutralBandAtr: number;
  readonly chopRollingWindow: number;
  readonly chopRequiredCrosses: number;
  readonly chopExcursionAtr: number;
  readonly chopConfirmationWindow: number;
  readonly flatSlopeAbsMax: number;
  readonly flatSlopeConsecutiveBars: number;
  readonly flatSlopeMeanDistAtrMax: number;
  readonly dedupMeanDistAtrMax: number;
  readonly dedupPearsonMin: number;
  readonly dedupMinOverlapBars: number;
  readonly confluenceBonusPerMerge: number;
  readonly confluenceBonusMax: number;
  readonly pinchMaxDistAtr: number;
  readonly pinchConfirmBars: number;
  readonly pinchBreakoutAtr: number;
  readonly pinchDissolveDistAtr: number;
  readonly pinchOutsideDissolveBars: number;
  readonly pinchConsumesTwoVisualSlots: boolean;
  readonly tier1PromoteScore: number;
  readonly tier1DemoteScore: number;
  readonly tier2MinScore: number;
  readonly hysteresisDwellBars: number;
  readonly resurrectionExcursionAtr: number;
  readonly resurrectionChopMax: number;
  readonly resurrectionAbsSlopeMin: number;
  readonly archivalDwellSessions1d: number;
  readonly archivalDwellSessionsIntraday: number;
  readonly archivalFarDistAtr: number;
  readonly archivalFarCohortMax: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = Object.freeze({
  configVersion: 'lifecycle_v2_sealed_2026_11_25',
  cohortSurvivalMin: 0.2,
  cohortStepCap: 0.99,
  cohortExemptFamilies1w: Object.freeze(['CALENDAR_YTD', 'CALENDAR_QTD', 'IPO_DIRECT']),
  chopNeutralBandAtr: 0.2,
  chopRollingWindow: 12,
  chopRequiredCrosses: 3,
  chopExcursionAtr: 1.0,
  chopConfirmationWindow: 3,
  flatSlopeAbsMax: 0.05,
  flatSlopeConsecutiveBars: 10,
  flatSlopeMeanDistAtrMax: 0.5,
  dedupMeanDistAtrMax: 0.25,
  dedupPearsonMin: 0.98,
  dedupMinOverlapBars: 20,
  confluenceBonusPerMerge: 4.0,
  confluenceBonusMax: 8.0,
  pinchMaxDistAtr: 1.25,
  pinchConfirmBars: 3,
  pinchBreakoutAtr: 0.35,
  pinchDissolveDistAtr: 1.75,
  pinchOutsideDissolveBars: 2,
  pinchConsumesTwoVisualSlots: true,
  tier1PromoteScore: 72.0,
  tier1DemoteScore: 68.0,
  tier2MinScore: 45.0,
  hysteresisDwellBars: 2,
  resurrectionExcursionAtr: 1.0,
  resurrectionChopMax: 2,
  resurrectionAbsSlopeMin: 0.08,
  archivalDwellSessions1d: 5,
  archivalDwellSessionsIntraday: 2,
  archivalFarDistAtr: 6.0,
  archivalFarCohortMax: 0.3,
});

export interface CohortSurvivalInput {
  readonly volumes: readonly number[];
  readonly anchorIdx: number;
  readonly freeFloat: number | null;
  readonly family: string;
  readonly timeframe: string;
  readonly floatIsPit: boolean;
  readonly allowNonPitSensitivity?: boolean;
  readonly splitFactorKSeries?: readonly number[];
  readonly config?: LifecycleConfig;
}

export interface CohortSurvivalResult {
  readonly sCohort: readonly number[];
  readonly cumulativeTurnover: readonly number[];
  readonly triggered: boolean;
  readonly triggerBarIdx: number | null;
  readonly exemptApplied: boolean;
  readonly disabledReason: string | null;
}

export interface ChopCrossEvent {
  readonly crossDetectedAt: number;
  readonly crossConfirmedAt: number | null;
  readonly originSide: -1 | 1;
  readonly targetSide: -1 | 1;
  readonly status: 'PENDING' | 'DISCARDED_EXCURSION' | 'CONFIRMED';
  readonly discardedAt: number | null;
}

export interface ChopEvaluationInput {
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly avwap: readonly number[];
  readonly atr14: readonly number[];
  readonly startIdx?: number;
  readonly config?: LifecycleConfig;
}

export interface ChopEvaluationResult {
  readonly chopCounts: readonly number[];
  readonly events: readonly ChopCrossEvent[];
  readonly triggered: boolean;
  readonly triggerBarIdx: number | null;
}

export interface FlatSlopeInput {
  readonly closes: readonly number[];
  readonly avwap: readonly number[];
  readonly atr14: readonly number[];
  readonly timeframe: string;
  readonly startIdx?: number;
  readonly slopeHorizonH?: number;
  readonly config?: LifecycleConfig;
}

export interface FlatSlopeResult {
  readonly sNorm: readonly number[];
  readonly distAtr: readonly number[];
  readonly triggered: boolean;
  readonly triggerBarIdx: number | null;
  readonly horizonH: number;
  readonly horizonStatus: string;
  readonly nonEvaluableBars: number;
  readonly flatActiveByBar: readonly boolean[];
}

export interface SpatialMergeRecord {
  readonly keeperAnchorId: string;
  readonly absorbedAnchorId: string;
  readonly mergedAtUtcSec: number;
  readonly mergedBarIdx: number;
  readonly overlapBars: number;
  readonly meanDistAtr: number;
  readonly pearsonR: number;
  readonly confluenceBonusApplied: number;
  readonly mergeReason: string;
}

export interface FsmTransitionRecord {
  readonly anchorId: string;
  readonly previousState: AvwapLifecycleState;
  readonly nextState: AvwapLifecycleState;
  readonly transitionReason: string;
  readonly effectiveTs: number;
  readonly availableAtUtcSec: number;
  readonly scoreAtTransition: number;
}

export interface AnchorSeriesInput {
  readonly anchorId: string;
  readonly family: string;
  readonly polarity: AvwapPolarity;
  readonly anchorIdx: number;
  readonly activatedIdx: number;
  readonly anchorTs: number;
  readonly availableAtUtcSec: number;
  readonly scoreOriginal: number;
  readonly avwapSeries: readonly number[];
  readonly freeFloatAtAnchor?: number | null;
  readonly floatIsPit?: boolean;
  readonly allowNonPitFloatSensitivity?: boolean;
}

export interface AnchorLifecycleSnapshot {
  readonly anchorId: string;
  readonly state: AvwapLifecycleState;
  readonly visible: boolean;
  readonly hiddenReason: string | null;
  readonly scoreOriginal: number;
  readonly confluenceBonus: number;
  readonly scoreWithConfluence: number;
  readonly mergedAnchorIds: readonly string[];
  readonly pinchPartnerId: string | null;
  readonly decayReasons: readonly string[];
  readonly cohortSurvival: number;
  readonly chopCount: number;
  readonly sNorm: number;
}

export interface LifecycleSimulationInput {
  readonly timeframe: string;
  readonly barTsUtcSec: readonly number[];
  readonly highs: readonly number[];
  readonly lows: readonly number[];
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  readonly atr14: readonly number[];
  readonly anchors: readonly AnchorSeriesInput[];
  readonly rvolZ?: readonly number[];
  readonly splitFactorKSeries?: readonly number[];
  readonly slopeHorizonH?: number;
  readonly config?: LifecycleConfig;
}

export interface LifecycleSimulationResult {
  readonly timeframe: string;
  readonly visualBudget: number;
  readonly transitions: readonly FsmTransitionRecord[];
  readonly merges: readonly SpatialMergeRecord[];
  readonly finalSnapshots: Readonly<Record<string, AnchorLifecycleSnapshot>>;
  readonly snapshotsByBar: readonly Readonly<Record<string, AnchorLifecycleSnapshot>>[];
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function getVisualBudget(timeframe: string): number {
  if (Object.prototype.hasOwnProperty.call(VISUAL_BUDGET_BY_TIMEFRAME, timeframe)) {
    return VISUAL_BUDGET_BY_TIMEFRAME[timeframe as AvwapTimeframe];
  }
  throw new RangeError(`Unsupported timeframe for visual budget: ${timeframe}`);
}

function getSlopeHorizon(
  timeframe: string,
  override?: number,
): readonly [number, string] {
  if (override !== undefined) {
    return [override, 'EXPLICIT_OVERRIDE'];
  }
  if (Object.prototype.hasOwnProperty.call(FLAT_SLOPE_H_BY_TIMEFRAME, timeframe)) {
    const entry = FLAT_SLOPE_H_BY_TIMEFRAME[timeframe as AvwapTimeframe];
    return [entry.horizonH, entry.status];
  }
  return [10, 'APPROVED_SPEC'];
}

/**
 * Grinblatt-Han discrete cohort survival strictly on bars AFTER `anchorIdx`.
 */
export function computeCohortSurvivalSeries(
  input: CohortSurvivalInput,
): CohortSurvivalResult {
  const cfg = input.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const allowNonPit = input.allowNonPitSensitivity ?? false;
  const n = input.volumes.length;
  const famUpper = input.family.trim().toUpperCase();
  const isExempt =
    (cfg.cohortExemptFamilies1w.includes(famUpper) && input.timeframe === '1W') ||
    (famUpper === 'CALENDAR_YTD' && input.timeframe === '1D');

  if (input.freeFloat === null || !Number.isFinite(input.freeFloat) || input.freeFloat <= 0) {
    return {
      sCohort: new Array<number>(n).fill(Number.NaN),
      cumulativeTurnover: new Array<number>(n).fill(Number.NaN),
      triggered: false,
      triggerBarIdx: null,
      exemptApplied: isExempt,
      disabledReason: 'FREE_FLOAT_MISSING_OR_INVALID',
    };
  }

  if (!input.floatIsPit && !allowNonPit) {
    return {
      sCohort: new Array<number>(n).fill(Number.NaN),
      cumulativeTurnover: new Array<number>(n).fill(Number.NaN),
      triggered: false,
      triggerBarIdx: null,
      exemptApplied: isExempt,
      disabledReason: 'FLOAT_NON_PIT_EXCLUDED_CAUSAL_PATH',
    };
  }

  let effFloat = input.freeFloat;
  let logSurv = 0;
  let cumTurn = 0;
  const sOut: number[] = [];
  const turnOut: number[] = [];
  let trigIdx: number | null = null;

  for (let idx = 0; idx < n; idx += 1) {
    if (input.splitFactorKSeries !== undefined && idx > input.anchorIdx) {
      const kVal = input.splitFactorKSeries[idx] ?? Number.NaN;
      if (Number.isFinite(kVal) && kVal > 0 && kVal !== 1) {
        effFloat /= kVal;
      }
    }

    if (idx < input.anchorIdx) {
      sOut.push(Number.NaN);
      turnOut.push(Number.NaN);
      continue;
    }
    if (idx === input.anchorIdx) {
      sOut.push(1);
      turnOut.push(0);
      continue;
    }

    const rawVol = input.volumes[idx] ?? Number.NaN;
    const vol = Number.isFinite(rawVol) && rawVol >= 0 ? rawVol : 0;
    const ratio = vol / effFloat;
    cumTurn += ratio;
    const capped = Math.min(cfg.cohortStepCap, ratio);
    logSurv += Math.log1p(-capped);
    const surv = Math.exp(logSurv);
    sOut.push(surv);
    turnOut.push(cumTurn);
    if (!isExempt && trigIdx === null && surv < cfg.cohortSurvivalMin) {
      trigIdx = idx;
    }
  }

  const disabledReason =
    !input.floatIsPit && allowNonPit ? 'FLOAT_NON_PIT_SENSITIVITY_ACTIVE' : null;
  return {
    sCohort: sOut,
    cumulativeTurnover: turnOut,
    triggered: trigIdx !== null,
    triggerBarIdx: trigIdx,
    exemptApplied: isExempt,
    disabledReason,
  };
}

/**
 * Strictly causal Chop Saturation detector (crosses confirmed after 3 bars without 1.0 ATR excursion).
 */
export function evaluateChopSaturation(
  input: ChopEvaluationInput,
): ChopEvaluationResult {
  const cfg = input.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const startIdx = input.startIdx ?? 0;
  const n = input.closes.length;
  let lastOutsideSide: -1 | 1 | null = null;
  interface PendingCross {
    readonly detectedAt: number;
    readonly originSide: -1 | 1;
    readonly targetSide: -1 | 1;
  }
  let pending: PendingCross[] = [];
  const confirmedEvents: ChopCrossEvent[] = [];
  const chopCounts = new Array<number>(n).fill(0);
  let trigIdx: number | null = null;

  for (let t = 0; t < n; t += 1) {
    if (t < startIdx) {
      continue;
    }
    const c = input.closes[t] ?? Number.NaN;
    const h = input.highs[t] ?? Number.NaN;
    const l = input.lows[t] ?? Number.NaN;
    const av = input.avwap[t] ?? Number.NaN;
    const atr = input.atr14[t] ?? Number.NaN;
    if (
      !Number.isFinite(c) ||
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(av) ||
      !Number.isFinite(atr) ||
      atr <= 0
    ) {
      continue;
    }

    const upper = av + cfg.chopNeutralBandAtr * atr;
    const lower = av - cfg.chopNeutralBandAtr * atr;

    const stillPending: PendingCross[] = [];
    const maxExc = Math.max(Math.abs(h - av), Math.abs(l - av)) / atr;
    for (const p of pending) {
      if (maxExc >= cfg.chopExcursionAtr) {
        confirmedEvents.push({
          crossDetectedAt: p.detectedAt,
          crossConfirmedAt: null,
          originSide: p.originSide,
          targetSide: p.targetSide,
          status: 'DISCARDED_EXCURSION',
          discardedAt: t,
        });
        continue;
      }
      if (t - p.detectedAt >= cfg.chopConfirmationWindow) {
        confirmedEvents.push({
          crossDetectedAt: p.detectedAt,
          crossConfirmedAt: t,
          originSide: p.originSide,
          targetSide: p.targetSide,
          status: 'CONFIRMED',
          discardedAt: null,
        });
        continue;
      }
      stillPending.push(p);
    }
    pending = stillPending;

    const curSide: -1 | 1 | null = c > upper ? 1 : c < lower ? -1 : null;
    if (curSide !== null) {
      if (lastOutsideSide !== null && curSide !== lastOutsideSide) {
        pending.push({
          detectedAt: t,
          originSide: lastOutsideSide,
          targetSide: curSide,
        });
      }
      lastOutsideSide = curSide;
    }

    const winLo = t - (cfg.chopRollingWindow - 1);
    let cnt = 0;
    for (const ev of confirmedEvents) {
      if (
        ev.status === 'CONFIRMED' &&
        ev.crossConfirmedAt !== null &&
        winLo <= ev.crossConfirmedAt &&
        ev.crossConfirmedAt <= t
      ) {
        cnt += 1;
      }
    }
    chopCounts[t] = cnt;
    if (trigIdx === null && cnt >= cfg.chopRequiredCrosses) {
      trigIdx = t;
    }
  }

  for (const p of pending) {
    confirmedEvents.push({
      crossDetectedAt: p.detectedAt,
      crossConfirmedAt: null,
      originSide: p.originSide,
      targetSide: p.targetSide,
      status: 'PENDING',
      discardedAt: null,
    });
  }

  confirmedEvents.sort(
    (a, b) => a.crossDetectedAt - b.crossDetectedAt || a.targetSide - b.targetSide,
  );

  return {
    chopCounts,
    events: confirmedEvents,
    triggered: trigIdx !== null,
    triggerBarIdx: trigIdx,
  };
}

/**
 * Evaluates normalized AVWAP slope and proximity over 10 consecutive valid bars.
 */
export function evaluateFlatSlope(input: FlatSlopeInput): FlatSlopeResult {
  const cfg = input.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const startIdx = input.startIdx ?? 0;
  const [h, hStatus] = getSlopeHorizon(input.timeframe, input.slopeHorizonH);
  if (!Number.isInteger(h) || h < 1) {
    throw new RangeError(`slopeHorizonH must be integer >= 1, got ${String(h)}`);
  }

  const n = input.closes.length;
  const sNormOut = new Array<number>(n).fill(Number.NaN);
  const distOut = new Array<number>(n).fill(Number.NaN);
  const flatActiveOut = new Array<boolean>(n).fill(false);
  let trigIdx: number | null = null;
  let nonEval = 0;

  for (let t = 0; t < n; t += 1) {
    if (t < startIdx) {
      continue;
    }
    const c = input.closes[t] ?? Number.NaN;
    const avT = input.avwap[t] ?? Number.NaN;
    const atrT = input.atr14[t] ?? Number.NaN;
    if (!Number.isFinite(c) || !Number.isFinite(avT) || !Number.isFinite(atrT) || atrT <= 0) {
      nonEval += 1;
      continue;
    }

    distOut[t] = Math.abs(c - avT) / atrT;
    if (t - h < startIdx) {
      continue;
    }
    const avPrev = input.avwap[t - h] ?? Number.NaN;
    if (!Number.isFinite(avPrev)) {
      nonEval += 1;
      continue;
    }

    const sn = (avT - avPrev) / (h * atrT);
    sNormOut[t] = sn;

    const consec = cfg.flatSlopeConsecutiveBars;
    if (t - (consec - 1) >= startIdx) {
      let validWindow = true;
      let distSum = 0;
      for (let u = t - consec + 1; u <= t; u += 1) {
        const snU = sNormOut[u] ?? Number.NaN;
        const distU = distOut[u] ?? Number.NaN;
        if (
          !Number.isFinite(snU) ||
          Math.abs(snU) >= cfg.flatSlopeAbsMax ||
          !Number.isFinite(distU)
        ) {
          validWindow = false;
          break;
        }
        distSum += distU;
      }
      if (validWindow) {
        const meanD = distSum / consec;
        if (meanD < cfg.flatSlopeMeanDistAtrMax) {
          flatActiveOut[t] = true;
          if (trigIdx === null) {
            trigIdx = t;
          }
        }
      }
    }
  }

  return {
    sNorm: sNormOut,
    distAtr: distOut,
    triggered: trigIdx !== null,
    triggerBarIdx: trigIdx,
    horizonH: h,
    horizonStatus: hStatus,
    nonEvaluableBars: nonEval,
    flatActiveByBar: flatActiveOut,
  };
}

interface MutableAnchorSimState {
  readonly spec: AnchorSeriesInput;
  activated: boolean;
  state: AvwapLifecycleState;
  readonly mergedIds: string[];
  readonly mergedIdSet: Set<string>;
  bonus: number;
  pinchPartner: string | null;
  pinchOutsideStreak: number;
  decayReasons: string[];
  decayPrimaryReason: string | null;
  decayingBars: number;
  decayingSessionDates: Set<string>;
  promoteStreak: number;
  demoteStreak: number;
  resurrectStreak: number;
  chopLastCount: number;
}

interface PairDistAcc {
  lastT: number;
  mOv: number;
  distSum: number;
}

function computeCausalOverlapPearson(
  avA: readonly number[],
  avB: readonly number[],
  atr: readonly number[],
  startOv: number,
  t: number,
): number {
  const xs: number[] = [];
  const ys: number[] = [];
  let sumX = 0;
  let sumY = 0;
  for (let u = startOv; u <= t; u += 1) {
    const va = avA[u] ?? Number.NaN;
    const vb = avB[u] ?? Number.NaN;
    const at = atr[u] ?? Number.NaN;
    if (Number.isFinite(va) && Number.isFinite(vb) && Number.isFinite(at) && at > 0) {
      xs.push(va);
      ys.push(vb);
      sumX += va;
      sumY += vb;
    }
  }
  const m = xs.length;
  if (m < 2) {
    return Number.NaN;
  }
  const meanX = sumX / m;
  const meanY = sumY / m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let idx = 0; idx < m; idx += 1) {
    const dx = (xs[idx] ?? 0) - meanX;
    const dy = (ys[idx] ?? 0) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (denom <= 0 || !Number.isFinite(denom)) {
    return Number.NaN;
  }
  return sxy / denom;
}

/**
 * Simulates the complete causal multi-anchor lifecycle FSM over canonical bars.
 * Pure 1:1 port of `research/avwap_oracle/src/avwap_oracle/scoring/lifecycle.py`.
 */
export function runLifecycleFsm(
  input: LifecycleSimulationInput,
): LifecycleSimulationResult {
  const cfg = input.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const budget = getVisualBudget(input.timeframe);
  const nBars = input.barTsUtcSec.length;
  if (
    input.highs.length !== nBars ||
    input.lows.length !== nBars ||
    input.closes.length !== nBars ||
    input.volumes.length !== nBars ||
    input.atr14.length !== nBars
  ) {
    throw new RangeError('All bar arrays must have identical length');
  }
  for (const a of input.anchors) {
    if (a.avwapSeries.length !== nBars) {
      throw new RangeError(
        `Anchor ${a.anchorId} avwapSeries length (${String(a.avwapSeries.length)}) != ${String(nBars)}`,
      );
    }
  }

  const hSlope =
    input.slopeHorizonH ??
    (Object.prototype.hasOwnProperty.call(FLAT_SLOPE_H_BY_TIMEFRAME, input.timeframe)
      ? FLAT_SLOPE_H_BY_TIMEFRAME[input.timeframe as AvwapTimeframe].horizonH
      : 10);

  const cohortById = new Map<string, CohortSurvivalResult>();
  const chopById = new Map<string, ChopEvaluationResult>();
  const flatById = new Map<string, FlatSlopeResult>();

  for (const a of input.anchors) {
    const cohortInput: CohortSurvivalInput = {
      volumes: input.volumes,
      anchorIdx: a.anchorIdx,
      freeFloat: a.freeFloatAtAnchor ?? null,
      family: a.family,
      timeframe: input.timeframe,
      floatIsPit: a.floatIsPit ?? false,
      allowNonPitSensitivity: a.allowNonPitFloatSensitivity ?? false,
      config: cfg,
      ...(input.splitFactorKSeries !== undefined
        ? { splitFactorKSeries: input.splitFactorKSeries }
        : {}),
    };
    cohortById.set(a.anchorId, computeCohortSurvivalSeries(cohortInput));
    chopById.set(
      a.anchorId,
      evaluateChopSaturation({
        highs: input.highs,
        lows: input.lows,
        closes: input.closes,
        avwap: a.avwapSeries,
        atr14: input.atr14,
        startIdx: a.anchorIdx,
        config: cfg,
      }),
    );
    flatById.set(
      a.anchorId,
      evaluateFlatSlope({
        closes: input.closes,
        avwap: a.avwapSeries,
        atr14: input.atr14,
        timeframe: input.timeframe,
        startIdx: a.anchorIdx,
        slopeHorizonH: hSlope,
        config: cfg,
      }),
    );
  }

  const sortedAnchors = [...input.anchors].sort(
    (a, b) => a.anchorTs - b.anchorTs || compareLex(a.anchorId, b.anchorId),
  );
  const sortedIds = sortedAnchors.map((a) => a.anchorId);

  const simState = new Map<string, MutableAnchorSimState>();
  for (const a of sortedAnchors) {
    simState.set(a.anchorId, {
      spec: a,
      activated: false,
      state: 'CANDIDATE',
      mergedIds: [],
      mergedIdSet: new Set<string>(),
      bonus: 0,
      pinchPartner: null,
      pinchOutsideStreak: 0,
      decayReasons: [],
      decayPrimaryReason: null,
      decayingBars: 0,
      decayingSessionDates: new Set<string>(),
      promoteStreak: 0,
      demoteStreak: 0,
      resurrectStreak: 0,
      chopLastCount: 0,
    });
  }

  const sessLimit =
    input.timeframe === '1D' ? cfg.archivalDwellSessions1d : cfg.archivalDwellSessionsIntraday;
  const pairDistAcc = new Map<string, PairDistAcc>();
  const transitions: FsmTransitionRecord[] = [];
  const merges: SpatialMergeRecord[] = [];
  const snapshotsByBar: Record<string, AnchorLifecycleSnapshot>[] = [];

  const effectiveScore = (st: MutableAnchorSimState): number =>
    Math.min(100, st.spec.scoreOriginal + st.bonus);

  const transition = (
    st: MutableAnchorSimState,
    nextState: AvwapLifecycleState,
    reason: string,
    tsBar: number,
  ): void => {
    const prev = st.state;
    if (prev === nextState) {
      return;
    }
    transitions.push({
      anchorId: st.spec.anchorId,
      previousState: prev,
      nextState,
      transitionReason: reason,
      effectiveTs: tsBar,
      availableAtUtcSec: Math.max(tsBar, st.spec.availableAtUtcSec),
      scoreAtTransition: effectiveScore(st),
    });
    st.state = nextState;
    st.promoteStreak = 0;
    st.demoteStreak = 0;
    st.resurrectStreak = 0;
    if (nextState === 'DECAYING') {
      st.decayingBars = 0;
      st.decayingSessionDates = new Set<string>();
    } else if (nextState === 'ACTIVE_PRIMARY' || nextState === 'ACTIVE_SECONDARY') {
      st.decayPrimaryReason = null;
      st.decayReasons = [];
    }
  };

  for (let t = 0; t < nBars; t += 1) {
    const tsBar = input.barTsUtcSec[t] ?? 0;
    const barEtDate = sessionKey(tsBar, 'EQUITY');
    const cT = input.closes[t] ?? Number.NaN;
    const atrT = input.atr14[t] ?? Number.NaN;

    // 1. Activation of anchors whose causal activatedIdx == t
    for (const aid of sortedIds) {
      const st = simState.get(aid);
      if (st === undefined) continue;
      if (!st.activated && t >= st.spec.activatedIdx) {
        st.activated = true;
        const effSc = effectiveScore(st);
        if (effSc >= 70.0) {
          transition(st, 'ACTIVE_PRIMARY', 'ACTIVATION_TIER_1', tsBar);
        } else if (effSc >= cfg.tier2MinScore) {
          transition(st, 'ACTIVE_SECONDARY', 'ACTIVATION_TIER_2', tsBar);
        }
      }
    }

    // 2. Check decay triggers & resurrections for activated non-ARCHIVED anchors
    for (const aid of sortedIds) {
      const st = simState.get(aid);
      if (st === undefined || !st.activated || st.state === 'ARCHIVED') {
        continue;
      }

      const cohortR = cohortById.get(aid);
      const chopR = chopById.get(aid);
      const flatR = flatById.get(aid);
      if (cohortR === undefined || chopR === undefined || flatR === undefined) {
        continue;
      }

      const chopCountT = chopR.chopCounts[t] ?? 0;
      const cohHit =
        cohortR.triggered && cohortR.triggerBarIdx !== null && t >= cohortR.triggerBarIdx;
      let chopHit = chopCountT >= cfg.chopRequiredCrosses && chopCountT > st.chopLastCount;
      st.chopLastCount = chopCountT;
      if (
        chopCountT >= cfg.chopRequiredCrosses &&
        (st.state === 'ACTIVE_PRIMARY' ||
          st.state === 'ACTIVE_SECONDARY' ||
          st.state === 'PINCH_PAIR')
      ) {
        chopHit = true;
      }
      const flatHit = flatR.flatActiveByBar[t] ?? false;

      const simReasons: string[] = [];
      if (cohHit) simReasons.push('COHORT_DECAY');
      if (chopHit) simReasons.push('CHOP_SATURATION');
      if (flatHit) simReasons.push('FLAT_SLOPE');

      if (
        st.state === 'ACTIVE_PRIMARY' ||
        st.state === 'ACTIVE_SECONDARY' ||
        st.state === 'PINCH_PAIR'
      ) {
        if (simReasons.length > 0) {
          const partnerId = st.pinchPartner;
          if (partnerId !== null) {
            const pst = simState.get(partnerId);
            if (pst !== undefined) {
              pst.pinchPartner = null;
              if (pst.state === 'PINCH_PAIR') {
                const pNext: AvwapLifecycleState =
                  effectiveScore(pst) >= 70.0 ? 'ACTIVE_PRIMARY' : 'ACTIVE_SECONDARY';
                transition(pst, pNext, 'PINCH_PARTNER_DECAYED', tsBar);
              }
            }
            st.pinchPartner = null;
          }

          const primaryR = simReasons[0] ?? 'COHORT_DECAY';
          st.decayPrimaryReason = primaryR;
          st.decayReasons = simReasons;
          transition(st, 'DECAYING', primaryR, tsBar);
          st.decayingSessionDates.add(barEtDate);
        } else if (st.state === 'ACTIVE_PRIMARY' || st.state === 'ACTIVE_SECONDARY') {
          const effSc = effectiveScore(st);
          if (st.state === 'ACTIVE_SECONDARY') {
            if (effSc >= cfg.tier1PromoteScore) {
              st.promoteStreak += 1;
              if (st.promoteStreak >= cfg.hysteresisDwellBars) {
                transition(st, 'ACTIVE_PRIMARY', 'SCORE_HYSTERESIS_PROMOTION', tsBar);
              }
            } else {
              st.promoteStreak = 0;
            }
          } else {
            if (effSc < cfg.tier1DemoteScore) {
              st.demoteStreak += 1;
              if (st.demoteStreak >= cfg.hysteresisDwellBars) {
                transition(st, 'ACTIVE_SECONDARY', 'SCORE_HYSTERESIS_DEMOTION', tsBar);
              }
            } else {
              st.demoteStreak = 0;
            }
          }
        }
      } else if (st.state === 'DECAYING') {
        st.decayingBars += 1;
        st.decayingSessionDates.add(barEtDate);
        const isCohort = st.decayPrimaryReason === 'COHORT_DECAY';
        const avT = st.spec.avwapSeries[t] ?? Number.NaN;
        const cohST = cohortR.sCohort[t] ?? Number.NaN;
        const snT = flatR.sNorm[t] ?? Number.NaN;

        if (
          input.timeframe === '1D' &&
          Number.isFinite(avT) &&
          Number.isFinite(cT) &&
          Number.isFinite(atrT) &&
          atrT > 0 &&
          Math.abs(cT - avT) / atrT > cfg.archivalFarDistAtr &&
          Number.isFinite(cohST) &&
          cohST < cfg.archivalFarCohortMax
        ) {
          transition(st, 'ARCHIVED', 'ARCHIVED_FAR_DIST_LOW_COHORT', tsBar);
          continue;
        }

        const canResurrect =
          !isCohort &&
          simReasons.length === 0 &&
          chopCountT < cfg.resurrectionChopMax &&
          Number.isFinite(avT) &&
          Number.isFinite(cT) &&
          Number.isFinite(atrT) &&
          atrT > 0 &&
          Math.abs(cT - avT) / atrT >= cfg.resurrectionExcursionAtr &&
          Number.isFinite(snT) &&
          Math.abs(snT) >= cfg.resurrectionAbsSlopeMin;

        if (canResurrect) {
          st.resurrectStreak += 1;
          if (st.resurrectStreak >= cfg.hysteresisDwellBars) {
            transition(st, 'ACTIVE_SECONDARY', 'BREAKOUT_RESURRECTION', tsBar);
            continue;
          }
        } else {
          st.resurrectStreak = 0;
        }

        if (st.decayingSessionDates.size >= sessLimit) {
          const archReason = isCohort ? 'ARCHIVED_COHORT_DECAY' : 'ARCHIVED_DECAY_TIMEOUT';
          transition(st, 'ARCHIVED', archReason, tsBar);
        }
      }
    }

    // 3. PINCH_PAIR maintenance, breakout & passive dissolution BEFORE spatial dedup
    const checkedPairs = new Set<string>();
    for (const aid of sortedIds) {
      const st = simState.get(aid);
      if (st === undefined || st.state !== 'PINCH_PAIR' || st.pinchPartner === null) {
        continue;
      }
      const pid = st.pinchPartner;
      const pairKey = aid < pid ? `${aid}\0${pid}` : `${pid}\0${aid}`;
      if (checkedPairs.has(pairKey)) {
        continue;
      }
      checkedPairs.add(pairKey);

      const pst = simState.get(pid);
      if (pst === undefined) {
        continue;
      }
      const va = st.spec.avwapSeries[t] ?? Number.NaN;
      const vb = pst.spec.avwapSeries[t] ?? Number.NaN;
      if (
        !Number.isFinite(va) ||
        !Number.isFinite(vb) ||
        !Number.isFinite(atrT) ||
        atrT <= 0 ||
        !Number.isFinite(cT)
      ) {
        continue;
      }

      const distAtr = Math.abs(va - vb) / atrT;
      const loC = Math.min(va, vb);
      const hiC = Math.max(va, vb);
      const bullBo = cT > hiC + cfg.pinchBreakoutAtr * atrT;
      const bearBo = cT < loC - cfg.pinchBreakoutAtr * atrT;

      if (bullBo || bearBo) {
        st.pinchPartner = null;
        pst.pinchPartner = null;
        const winPol: AvwapPolarity = bullBo ? 'LONG' : 'SHORT';
        const winner = st.spec.polarity === winPol ? st : pst;
        const loser = winner === st ? pst : st;
        transition(winner, 'ACTIVE_PRIMARY', 'PINCH_BREAKOUT', tsBar);
        if (effectiveScore(loser) >= 70.0) {
          transition(loser, 'ACTIVE_SECONDARY', 'PINCH_BREAKOUT_OPPOSITE', tsBar);
        } else {
          loser.decayPrimaryReason = 'PINCH_BREAKOUT_OPPOSITE';
          loser.decayReasons = ['PINCH_BREAKOUT_OPPOSITE'];
          transition(loser, 'DECAYING', 'PINCH_BREAKOUT_OPPOSITE', tsBar);
          loser.decayingSessionDates.add(barEtDate);
        }
        continue;
      }

      const inside = loC <= cT && cT <= hiC;
      if (inside) {
        st.pinchOutsideStreak = 0;
        pst.pinchOutsideStreak = 0;
      } else {
        st.pinchOutsideStreak += 1;
        pst.pinchOutsideStreak += 1;
      }

      if (
        distAtr > cfg.pinchDissolveDistAtr ||
        st.pinchOutsideStreak >= cfg.pinchOutsideDissolveBars
      ) {
        st.pinchPartner = null;
        pst.pinchPartner = null;
        for (const leg of [st, pst]) {
          const nxt: AvwapLifecycleState =
            effectiveScore(leg) >= 70.0 ? 'ACTIVE_PRIMARY' : 'ACTIVE_SECONDARY';
          transition(leg, nxt, 'PINCH_CORRIDOR_DISSOLVED', tsBar);
        }
      }
    }

    // Detect new PINCH_PAIR formation among unpaired active anchors of opposite polarity
    const unpaired = sortedIds.filter((aid) => {
      const st = simState.get(aid);
      return (
        st !== undefined &&
        (st.state === 'ACTIVE_PRIMARY' || st.state === 'ACTIVE_SECONDARY') &&
        st.pinchPartner === null &&
        (st.spec.polarity === 'LONG' || st.spec.polarity === 'SHORT')
      );
    });

    interface PinchCandidate {
      readonly negPairScore: number;
      readonly id1: string;
      readonly id2: string;
    }
    const candPairs: PinchCandidate[] = [];
    const kReq = cfg.pinchConfirmBars;

    for (let i = 0; i < unpaired.length; i += 1) {
      const id1 = unpaired[i];
      if (id1 === undefined) continue;
      const a1 = simState.get(id1);
      if (a1 === undefined) continue;
      for (let j = i + 1; j < unpaired.length; j += 1) {
        const id2 = unpaired[j];
        if (id2 === undefined) continue;
        const a2 = simState.get(id2);
        if (a2 === undefined || a1.spec.polarity === a2.spec.polarity) {
          continue;
        }
        if (t < Math.max(a1.spec.activatedIdx, a2.spec.activatedIdx) + (kReq - 1)) {
          continue;
        }

        const distsW: number[] = [];
        let validW = true;
        for (let u = t - kReq + 1; u <= t; u += 1) {
          const va = a1.spec.avwapSeries[u] ?? Number.NaN;
          const vb = a2.spec.avwapSeries[u] ?? Number.NaN;
          const atU = input.atr14[u] ?? Number.NaN;
          const cU = input.closes[u] ?? Number.NaN;
          if (
            !Number.isFinite(va) ||
            !Number.isFinite(vb) ||
            !Number.isFinite(atU) ||
            atU <= 0 ||
            !Number.isFinite(cU)
          ) {
            validW = false;
            break;
          }
          if (!(Math.min(va, vb) <= cU && cU <= Math.max(va, vb))) {
            validW = false;
            break;
          }
          distsW.push(Math.abs(va - vb) / atU);
        }
        if (!validW || distsW.length === 0) {
          continue;
        }
        const lastDist = distsW[distsW.length - 1] ?? Number.NaN;
        let strictlyConverging = lastDist <= cfg.pinchMaxDistAtr;
        for (let idx = 0; idx < distsW.length - 1; idx += 1) {
          if ((distsW[idx + 1] ?? Number.NaN) >= (distsW[idx] ?? Number.NaN)) {
            strictlyConverging = false;
            break;
          }
        }
        if (strictlyConverging) {
          candPairs.push({
            negPairScore: -(effectiveScore(a1) + effectiveScore(a2)),
            id1: a1.spec.anchorId,
            id2: a2.spec.anchorId,
          });
        }
      }
    }

    candPairs.sort(
      (a, b) =>
        a.negPairScore - b.negPairScore ||
        compareLex(a.id1, b.id1) ||
        compareLex(a.id2, b.id2),
    );
    const pairedNow = new Set<string>();
    for (const pair of candPairs) {
      if (pairedNow.has(pair.id1) || pairedNow.has(pair.id2)) {
        continue;
      }
      const s1 = simState.get(pair.id1);
      const s2 = simState.get(pair.id2);
      if (s1 === undefined || s2 === undefined || s1.pinchPartner !== null || s2.pinchPartner !== null) {
        continue;
      }
      s1.pinchPartner = pair.id2;
      s2.pinchPartner = pair.id1;
      s1.pinchOutsideStreak = 0;
      s2.pinchOutsideStreak = 0;
      pairedNow.add(pair.id1);
      pairedNow.add(pair.id2);
      transition(s1, 'PINCH_PAIR', `PINCH_FORMED_WITH:${pair.id2}`, tsBar);
      transition(s2, 'PINCH_PAIR', `PINCH_FORMED_WITH:${pair.id1}`, tsBar);
    }

    // 4. Spatial Deduplication (same polarity, never touches PINCH_PAIRs)
    const dedupCands = sortedIds.filter((aid) => {
      const st = simState.get(aid);
      return (
        st !== undefined &&
        (st.state === 'ACTIVE_PRIMARY' || st.state === 'ACTIVE_SECONDARY') &&
        st.pinchPartner === null &&
        (st.spec.polarity === 'LONG' || st.spec.polarity === 'SHORT')
      );
    });
    dedupCands.sort((a, b) => {
      const sa = simState.get(a);
      const sb = simState.get(b);
      if (sa === undefined || sb === undefined) return 0;
      return (
        sb.spec.scoreOriginal - sa.spec.scoreOriginal ||
        sa.spec.anchorTs - sb.spec.anchorTs ||
        compareLex(a, b)
      );
    });

    const absorbedNow = new Set<string>();
    for (let i = 0; i < dedupCands.length; i += 1) {
      const keepId = dedupCands[i];
      if (keepId === undefined || absorbedNow.has(keepId)) continue;
      const keepSt = simState.get(keepId);
      if (keepSt === undefined || keepSt.state === 'ARCHIVED') continue;

      for (let j = i + 1; j < dedupCands.length; j += 1) {
        const otherId = dedupCands[j];
        if (otherId === undefined || absorbedNow.has(otherId)) continue;
        const otherSt = simState.get(otherId);
        if (
          otherSt === undefined ||
          otherSt.state === 'ARCHIVED' ||
          keepSt.spec.polarity !== otherSt.spec.polarity
        ) {
          continue;
        }

        const startOv = Math.max(keepSt.spec.anchorIdx, otherSt.spec.anchorIdx);
        const pk = `${keepId}\0${otherId}`;
        let acc = pairDistAcc.get(pk);
        if (acc === undefined) {
          let mOvInit = 0;
          let distSumInit = 0;
          for (let uu = startOv; uu <= t; uu += 1) {
            const va = keepSt.spec.avwapSeries[uu] ?? Number.NaN;
            const vb = otherSt.spec.avwapSeries[uu] ?? Number.NaN;
            const at = input.atr14[uu] ?? Number.NaN;
            if (Number.isFinite(va) && Number.isFinite(vb) && Number.isFinite(at) && at > 0) {
              mOvInit += 1;
              distSumInit += Math.abs(va - vb) / at;
            }
          }
          acc = { lastT: t, mOv: mOvInit, distSum: distSumInit };
          pairDistAcc.set(pk, acc);
        } else {
          for (let uu = acc.lastT + 1; uu <= t; uu += 1) {
            const va = keepSt.spec.avwapSeries[uu] ?? Number.NaN;
            const vb = otherSt.spec.avwapSeries[uu] ?? Number.NaN;
            const at = input.atr14[uu] ?? Number.NaN;
            if (Number.isFinite(va) && Number.isFinite(vb) && Number.isFinite(at) && at > 0) {
              acc.mOv += 1;
              acc.distSum += Math.abs(va - vb) / at;
            }
          }
          acc.lastT = t;
        }

        const mOv = acc.mOv;
        const meanD = mOv >= 2 ? acc.distSum / mOv : Number.NaN;
        let pearsonR = Number.NaN;
        if (
          mOv >= cfg.dedupMinOverlapBars &&
          Number.isFinite(meanD) &&
          meanD < cfg.dedupMeanDistAtrMax
        ) {
          pearsonR = computeCausalOverlapPearson(
            keepSt.spec.avwapSeries,
            otherSt.spec.avwapSeries,
            input.atr14,
            startOv,
            t,
          );
        }

        if (
          mOv >= cfg.dedupMinOverlapBars &&
          Number.isFinite(meanD) &&
          meanD < cfg.dedupMeanDistAtrMax &&
          Number.isFinite(pearsonR) &&
          pearsonR > cfg.dedupPearsonMin
        ) {
          absorbedNow.add(otherId);
          let bonusDelta = 0;
          if (!keepSt.mergedIdSet.has(otherId)) {
            keepSt.mergedIdSet.add(otherId);
            keepSt.mergedIds.push(otherId);
            const newBonus = Math.min(
              cfg.confluenceBonusMax,
              keepSt.mergedIdSet.size * cfg.confluenceBonusPerMerge,
            );
            bonusDelta = Math.max(0, newBonus - keepSt.bonus);
            keepSt.bonus = newBonus;
          }
          merges.push({
            keeperAnchorId: keepId,
            absorbedAnchorId: otherId,
            mergedAtUtcSec: tsBar,
            mergedBarIdx: t,
            overlapBars: mOv,
            meanDistAtr: meanD,
            pearsonR,
            confluenceBonusApplied: bonusDelta,
            mergeReason: 'SPATIAL_CONFLUENCE_ABSORBED',
          });
          transition(otherSt, 'ARCHIVED', `SPATIAL_CONFLUENCE_ABSORBED_BY:${keepId}`, tsBar);
          if (keepSt.state === 'ACTIVE_SECONDARY' && effectiveScore(keepSt) >= 70.0) {
            transition(keepSt, 'ACTIVE_PRIMARY', 'CONFLUENCE_BONUS_PROMOTION', tsBar);
          }
        }
      }
    }

    // 5. Enforce Hard Visual Budget at bar t WITHOUT mutating FSM state
    const visibleIds = new Set<string>();
    const hiddenReasonById = new Map<string, string>();
    let slotsUsed = 0;

    const seenP = new Set<string>();
    const pinchUnits: { readonly negTopSc: number; readonly u1: string; readonly u2: string }[] = [];
    for (const aid of sortedIds) {
      const st = simState.get(aid);
      if (st !== undefined && st.state === 'PINCH_PAIR' && st.pinchPartner !== null && !seenP.has(aid)) {
        const pid = st.pinchPartner;
        const pst = simState.get(pid);
        if (pst === undefined) continue;
        seenP.add(aid);
        seenP.add(pid);
        const topSc = Math.max(effectiveScore(st), effectiveScore(pst));
        const u1 = aid < pid ? aid : pid;
        const u2 = aid < pid ? pid : aid;
        pinchUnits.push({ negTopSc: -topSc, u1, u2 });
      }
    }
    pinchUnits.sort(
      (a, b) => a.negTopSc - b.negTopSc || compareLex(a.u1, b.u1) || compareLex(a.u2, b.u2),
    );
    const unitCost = cfg.pinchConsumesTwoVisualSlots ? 2 : 1;
    for (const unit of pinchUnits) {
      if (slotsUsed + unitCost <= budget) {
        visibleIds.add(unit.u1);
        visibleIds.add(unit.u2);
        slotsUsed += unitCost;
      } else {
        hiddenReasonById.set(unit.u1, 'VISUAL_BUDGET_EXCEEDED_PINCH_SLOTS');
        hiddenReasonById.set(unit.u2, 'VISUAL_BUDGET_EXCEEDED_PINCH_SLOTS');
      }
    }

    const singles = sortedIds.filter((aid) => {
      const st = simState.get(aid);
      return st !== undefined && (st.state === 'ACTIVE_PRIMARY' || st.state === 'ACTIVE_SECONDARY');
    });
    singles.sort((a, b) => {
      const sa = simState.get(a);
      const sb = simState.get(b);
      if (sa === undefined || sb === undefined) return 0;
      const tierA = sa.state === 'ACTIVE_PRIMARY' ? 0 : 1;
      const tierB = sb.state === 'ACTIVE_PRIMARY' ? 0 : 1;
      return (
        tierA - tierB ||
        effectiveScore(sb) - effectiveScore(sa) ||
        sa.spec.anchorTs - sb.spec.anchorTs ||
        compareLex(a, b)
      );
    });
    for (const aid of singles) {
      if (slotsUsed < budget) {
        visibleIds.add(aid);
        slotsUsed += 1;
      } else {
        hiddenReasonById.set(aid, 'VISUAL_BUDGET_EXCEEDED');
      }
    }

    const barSnap: Record<string, AnchorLifecycleSnapshot> = {};
    for (const aid of sortedIds) {
      const st = simState.get(aid);
      const cohortR = cohortById.get(aid);
      const chopR = chopById.get(aid);
      const flatR = flatById.get(aid);
      if (st === undefined || cohortR === undefined || chopR === undefined || flatR === undefined) {
        continue;
      }
      const vis = visibleIds.has(aid);
      barSnap[aid] = {
        anchorId: aid,
        state: st.state,
        visible: vis,
        hiddenReason: vis ? null : (hiddenReasonById.get(aid) ?? null),
        scoreOriginal: st.spec.scoreOriginal,
        confluenceBonus: st.bonus,
        scoreWithConfluence: effectiveScore(st),
        mergedAnchorIds: [...st.mergedIds],
        pinchPartnerId: st.pinchPartner,
        decayReasons: [...st.decayReasons],
        cohortSurvival: cohortR.sCohort[t] ?? Number.NaN,
        chopCount: chopR.chopCounts[t] ?? 0,
        sNorm: flatR.sNorm[t] ?? Number.NaN,
      };
    }
    snapshotsByBar.push(barSnap);
  }

  const finalSnapshots = snapshotsByBar[snapshotsByBar.length - 1] ?? {};
  return {
    timeframe: input.timeframe,
    visualBudget: budget,
    transitions,
    merges,
    finalSnapshots,
    snapshotsByBar,
  };
}
