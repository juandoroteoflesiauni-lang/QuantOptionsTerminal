import { impliedDividendYieldFromForward } from './forward.js';
import type { OptionContractType } from './types.js';

const DEFAULT_MAX_SPREAD_RATIO = 0.35;
const DEFAULT_MAX_IV = 20;
const DEFAULT_MIN_POINTS = 4;
const DEFAULT_BUTTERFLY_SAMPLES = 16;
const DEFAULT_ARBITRAGE_TOLERANCE = 1e-9;
const ATM_REL_TOLERANCE = 1e-9;
const SPREAD_WEIGHT_EPS = 1e-4;
const TIME_MATCH_TOLERANCE = 1e-12;

export type VolQuoteSelectionMode = 'otm' | 'otmStrict' | 'spreadWeightedMean';

export type VolQuoteDiscardReason =
  | 'invalidStrike'
  | 'invalidContractType'
  | 'invalidIv'
  | 'invalidBidAsk'
  | 'belowMinBid'
  | 'spreadTooWide'
  | 'belowMinOpenInterest'
  | 'nonOtmExcluded';

export type VolSliceRejectionReason =
  | 'invalid_slice_params'
  | 'invalid_filter_options'
  | 'insufficient_points';

export interface VolQuoteInput {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly iv: number;
  readonly bid: number;
  readonly ask: number;
  readonly mid?: number;
  readonly openInterest: number;
}

export type TriValuedCheckStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface VolSurfaceFilterOptions {
  readonly minBid?: number;
  readonly requirePositiveBid?: boolean;
  /** Solo modo EOD referencial: acepta `mid > 0` observado sin BBO bilateral (`bid/ask` quedan `NaN`). */
  readonly allowReferenceMidWithoutBbo?: boolean;
  readonly maxSpreadRatio?: number;
  readonly minOpenInterest?: number;
  readonly maxIv?: number;
  readonly minPoints?: number;
  readonly quoteSelection?: VolQuoteSelectionMode;
  readonly forward?: number;
}

export interface NormalizedVolSurfaceFilterOptions {
  readonly minBid: number;
  readonly requirePositiveBid: boolean;
  readonly allowReferenceMidWithoutBbo: boolean;
  readonly maxSpreadRatio: number;
  readonly minOpenInterest: number;
  readonly maxIv: number;
  readonly minPoints: number;
  readonly quoteSelection: VolQuoteSelectionMode;
  readonly forward: number;
}

export interface FilteredVolQuote {
  readonly strike: number;
  readonly contractType: OptionContractType;
  readonly iv: number;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly spreadRatio: number;
  readonly openInterest: number;
}

export interface DiscardedVolQuote {
  readonly index: number;
  readonly strike: number;
  readonly contractType: string;
  readonly reason: VolQuoteDiscardReason;
}

export type VolQuoteDiscardCounts = Readonly<Record<VolQuoteDiscardReason, number>>;

export interface VolQuoteFilterResult {
  readonly validOptions: boolean;
  readonly accepted: readonly FilteredVolQuote[];
  readonly aggregated: readonly FilteredVolQuote[];
  readonly discarded: readonly DiscardedVolQuote[];
  readonly countsByReason: VolQuoteDiscardCounts;
}

export interface VolSliceInput {
  readonly timeToExpiry: number;
  readonly expirySec?: number;
  readonly forward: number;
  readonly spot?: number;
  readonly rate?: number;
  readonly dividendYield?: number;
  readonly quotes: readonly VolQuoteInput[];
}

export interface VolSliceNode {
  readonly k: number;
  readonly strike: number;
  readonly totalVariance: number;
  readonly iv: number;
  readonly slope: number;
  readonly spreadRatio: number;
  readonly openInterest: number;
}

export interface VolSliceBuildReport {
  readonly isValid: boolean;
  readonly rejectionReason: VolSliceRejectionReason | null;
  readonly inputQuotesCount: number;
  readonly acceptedQuotesCount: number;
  readonly strikeNodesCount: number;
  readonly minPointsRequired: number;
  readonly discardedCounts: VolQuoteDiscardCounts;
}

export interface VolSlice {
  readonly isValid: boolean;
  readonly timeToExpiry: number;
  readonly expirySec: number;
  readonly forward: number;
  readonly spot: number;
  readonly rate: number;
  readonly dividendYield: number;
  readonly kMin: number;
  readonly kMax: number;
  readonly nodes: readonly VolSliceNode[];
  readonly report: VolSliceBuildReport;
}

export interface SliceDerivatives {
  readonly totalVariance: number;
  readonly dwDk: number;
  readonly d2wDk2: number;
  readonly iv: number;
}

export interface ButterflyArbitrageOptions {
  readonly samplesPerSegment?: number;
  readonly tolerance?: number;
}

export interface ButterflyViolation {
  readonly k: number;
  readonly strike: number;
  readonly density: number;
  readonly totalVariance: number;
  readonly dwDk: number;
  readonly d2wDk2: number;
}

export interface ButterflyArbitrageReport {
  readonly status: TriValuedCheckStatus;
  readonly isArbitrageFree: boolean;
  readonly checkedPointsCount: number;
  readonly minDensity: number;
  readonly worstLogMoneyness: number;
  readonly worstStrike: number;
  readonly violations: readonly ButterflyViolation[];
}

export interface CalendarArbitrageOptions {
  readonly tolerance?: number;
  readonly overlapMidpoints?: boolean;
}

export interface CalendarViolation {
  readonly nearTimeToExpiry: number;
  readonly farTimeToExpiry: number;
  readonly k: number;
  readonly nearTotalVariance: number;
  readonly farTotalVariance: number;
  readonly varianceDiff: number;
}

export interface CalendarArbitrageReport {
  readonly status: TriValuedCheckStatus;
  readonly isArbitrageFree: boolean;
  readonly checkedComparisons: number;
  readonly minVarianceDiff: number;
  readonly violations: readonly CalendarViolation[];
}

export interface BuildVolSurfaceOptions {
  readonly filter?: VolSurfaceFilterOptions;
  readonly butterfly?: ButterflyArbitrageOptions;
  readonly calendar?: CalendarArbitrageOptions;
}

export interface VolSurface {
  readonly slices: readonly VolSlice[];
  readonly validSlicesCount: number;
  readonly invalidSlicesCount: number;
  readonly butterflyReports: readonly ButterflyArbitrageReport[];
  readonly butterflyCheckStatus: TriValuedCheckStatus;
  readonly calendarCheckStatus: TriValuedCheckStatus;
  readonly arbitrageCheckStatus: TriValuedCheckStatus;
  readonly butterflyArbitrageFree: boolean;
  readonly calendarArbitrageFree: boolean;
  readonly isArbitrageFree: boolean;
  readonly calendarCheck: CalendarArbitrageReport;
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function createEmptyDiscardCounts(): Record<VolQuoteDiscardReason, number> {
  return {
    invalidStrike: 0,
    invalidContractType: 0,
    invalidIv: 0,
    invalidBidAsk: 0,
    belowMinBid: 0,
    spreadTooWide: 0,
    belowMinOpenInterest: 0,
    nonOtmExcluded: 0,
  };
}

function normalizeFilterOptions(
  options?: VolSurfaceFilterOptions,
): NormalizedVolSurfaceFilterOptions | null {
  const minBid = options?.minBid ?? 0;
  const requirePositiveBid = options?.requirePositiveBid ?? true;
  const allowReferenceMidWithoutBbo = options?.allowReferenceMidWithoutBbo === true;
  const maxSpreadRatio = options?.maxSpreadRatio ?? DEFAULT_MAX_SPREAD_RATIO;
  const minOpenInterest = options?.minOpenInterest ?? 0;
  const maxIv = options?.maxIv ?? DEFAULT_MAX_IV;
  const minPoints = options?.minPoints ?? DEFAULT_MIN_POINTS;
  const quoteSelection = options?.quoteSelection ?? 'otm';
  const forward = options?.forward ?? Number.NaN;

  if (
    !isFiniteNonNegative(minBid) ||
    !isFiniteNonNegative(maxSpreadRatio) ||
    !isFiniteNonNegative(minOpenInterest) ||
    !isFinitePositive(maxIv) ||
    !Number.isInteger(minPoints) ||
    minPoints < 2
  ) {
    return null;
  }

  const rawSelection: string = quoteSelection;
  if (
    rawSelection !== 'otm' &&
    rawSelection !== 'otmStrict' &&
    rawSelection !== 'spreadWeightedMean'
  ) {
    return null;
  }

  if (options?.forward !== undefined && !isFinitePositive(forward)) {
    return null;
  }

  return {
    minBid,
    requirePositiveBid,
    allowReferenceMidWithoutBbo,
    maxSpreadRatio,
    minOpenInterest,
    maxIv,
    minPoints,
    quoteSelection,
    forward,
  };
}

interface IndexedQuote {
  readonly index: number;
  readonly quote: FilteredVolQuote;
}

function aggregateStrikeQuotes(
  items: readonly IndexedQuote[],
  preferredType?: OptionContractType,
): FilteredVolQuote {
  let weightSum = 0;
  let varianceWeightedSum = 0;
  let spreadWeightedSum = 0;
  let spreadWeightSum = 0;
  let bidWeightedSum = 0;
  let askWeightedSum = 0;
  let bboWeightSum = 0;
  let midWeightedSum = 0;
  let oiSum = 0;
  let chosenType: OptionContractType = preferredType ?? 'call';
  let bestWeight = -1;

  for (const item of items) {
    const q = item.quote;
    const hasValidSpread = Number.isFinite(q.spreadRatio) && q.spreadRatio >= 0;
    const w = hasValidSpread ? 1 / (SPREAD_WEIGHT_EPS + q.spreadRatio) : 1;
    weightSum += w;
    varianceWeightedSum += w * q.iv * q.iv;
    midWeightedSum += w * q.mid;
    if (hasValidSpread && isFiniteNonNegative(q.bid) && isFinitePositive(q.ask)) {
      spreadWeightSum += w;
      spreadWeightedSum += w * q.spreadRatio;
      bboWeightSum += w;
      bidWeightedSum += w * q.bid;
      askWeightedSum += w * q.ask;
    }
    oiSum += q.openInterest;
    if (preferredType === undefined && w > bestWeight) {
      bestWeight = w;
      chosenType = q.contractType;
    }
  }

  const first = items[0];
  const strike = first !== undefined ? first.quote.strike : Number.NaN;
  const aggregatedIv = Math.sqrt(varianceWeightedSum / weightSum);
  const hasAllBbo = bboWeightSum > 0 && bboWeightSum === weightSum;
  const aggregatedBid = hasAllBbo ? bidWeightedSum / bboWeightSum : Number.NaN;
  const aggregatedAsk = hasAllBbo ? askWeightedSum / bboWeightSum : Number.NaN;
  const aggregatedMid = hasAllBbo
    ? 0.5 * (aggregatedBid + aggregatedAsk)
    : midWeightedSum / weightSum;
  const aggregatedSpread =
    spreadWeightSum > 0 && spreadWeightSum === weightSum
      ? spreadWeightedSum / spreadWeightSum
      : Number.NaN;

  return {
    strike,
    contractType: chosenType,
    iv: aggregatedIv,
    bid: aggregatedBid,
    ask: aggregatedAsk,
    mid: aggregatedMid,
    spreadRatio: aggregatedSpread,
    openInterest: oiSum,
  };
}

/**
 * Validates and filters option quote records purely in TypeScript and merges
 * duplicate quotes at identical strikes into variance-weighted strike nodes.
 */
export function filterVolQuotes(
  quotes: readonly VolQuoteInput[],
  options?: VolSurfaceFilterOptions,
): VolQuoteFilterResult {
  const counts = createEmptyDiscardCounts();
  const normalized = normalizeFilterOptions(options);
  if (normalized === null || !isRuntimeArray(quotes)) {
    return {
      validOptions: normalized !== null,
      accepted: [],
      aggregated: [],
      discarded: [],
      countsByReason: counts,
    };
  }

  const qualityPassed: IndexedQuote[] = [];
  const discarded: DiscardedVolQuote[] = [];

  for (let i = 0; i < quotes.length; i += 1) {
    const raw = quotes[i];
    if (raw === undefined) {
      continue;
    }

    const contractStr: string = raw.contractType;
    if (contractStr !== 'call' && contractStr !== 'put') {
      counts.invalidContractType += 1;
      discarded.push({
        index: i,
        strike: raw.strike,
        contractType: contractStr,
        reason: 'invalidContractType',
      });
      continue;
    }

    if (!isFinitePositive(raw.strike)) {
      counts.invalidStrike += 1;
      discarded.push({
        index: i,
        strike: raw.strike,
        contractType: contractStr,
        reason: 'invalidStrike',
      });
      continue;
    }

    if (!isFinitePositive(raw.iv) || raw.iv > normalized.maxIv) {
      counts.invalidIv += 1;
      discarded.push({
        index: i,
        strike: raw.strike,
        contractType: contractStr,
        reason: 'invalidIv',
      });
      continue;
    }

    const hasPositiveBid = isFinitePositive(raw.bid);
    const hasPositiveAsk = isFinitePositive(raw.ask);
    const crossed = hasPositiveBid && hasPositiveAsk && raw.ask < raw.bid;

    let effectiveBid = raw.bid;
    let effectiveAsk = raw.ask;
    let mid: number;
    let spreadRatio: number;

    if (
      normalized.allowReferenceMidWithoutBbo &&
      !crossed &&
      !(Number.isFinite(raw.bid) && raw.bid < 0) &&
      !(Number.isFinite(raw.ask) && raw.ask < 0) &&
      (!hasPositiveBid || !hasPositiveAsk)
    ) {
      if (hasPositiveBid && !hasPositiveAsk) {
        counts.invalidBidAsk += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'invalidBidAsk',
        });
        continue;
      }
      const refMid = raw.mid ?? Number.NaN;
      if (!isFinitePositive(refMid)) {
        counts.invalidBidAsk += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'invalidBidAsk',
        });
        continue;
      }
      effectiveBid = Number.NaN;
      effectiveAsk = Number.NaN;
      mid = refMid;
      spreadRatio = Number.NaN;
    } else {
      if (!isFiniteNonNegative(raw.bid) || !hasPositiveAsk || crossed) {
        counts.invalidBidAsk += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'invalidBidAsk',
        });
        continue;
      }

      mid = raw.mid ?? 0.5 * (raw.bid + raw.ask);
      if (!isFinitePositive(mid)) {
        counts.invalidBidAsk += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'invalidBidAsk',
        });
        continue;
      }

      if ((normalized.requirePositiveBid && raw.bid <= 0) || raw.bid < normalized.minBid) {
        counts.belowMinBid += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'belowMinBid',
        });
        continue;
      }

      spreadRatio = (raw.ask - raw.bid) / mid;
      if (!Number.isFinite(spreadRatio) || spreadRatio > normalized.maxSpreadRatio) {
        counts.spreadTooWide += 1;
        discarded.push({
          index: i,
          strike: raw.strike,
          contractType: contractStr,
          reason: 'spreadTooWide',
        });
        continue;
      }
    }

    if (!isFiniteNonNegative(raw.openInterest) || raw.openInterest < normalized.minOpenInterest) {
      counts.belowMinOpenInterest += 1;
      discarded.push({
        index: i,
        strike: raw.strike,
        contractType: contractStr,
        reason: 'belowMinOpenInterest',
      });
      continue;
    }

    qualityPassed.push({
      index: i,
      quote: {
        strike: raw.strike,
        contractType: contractStr,
        iv: raw.iv,
        bid: effectiveBid,
        ask: effectiveAsk,
        mid,
        spreadRatio,
        openInterest: raw.openInterest,
      },
    });
  }

  const byStrike = new Map<number, IndexedQuote[]>();
  for (const entry of qualityPassed) {
    const existing = byStrike.get(entry.quote.strike);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      byStrike.set(entry.quote.strike, [entry]);
    }
  }

  const sortedStrikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  const accepted: FilteredVolQuote[] = [];
  const aggregated: FilteredVolQuote[] = [];

  for (const strike of sortedStrikes) {
    const group = byStrike.get(strike);
    if (group === undefined || group.length === 0) {
      continue;
    }

    if (
      !Number.isFinite(normalized.forward) ||
      normalized.quoteSelection === 'spreadWeightedMean'
    ) {
      for (const item of group) {
        accepted.push(item.quote);
      }
      aggregated.push(aggregateStrikeQuotes(group));
      continue;
    }

    const relDiff = Math.abs(strike - normalized.forward) / normalized.forward;
    if (relDiff <= ATM_REL_TOLERANCE) {
      for (const item of group) {
        accepted.push(item.quote);
      }
      aggregated.push(aggregateStrikeQuotes(group));
      continue;
    }

    const otmType: OptionContractType = strike < normalized.forward ? 'put' : 'call';
    const otmItems: IndexedQuote[] = [];
    const itmItems: IndexedQuote[] = [];

    for (const item of group) {
      if (item.quote.contractType === otmType) {
        otmItems.push(item);
      } else {
        itmItems.push(item);
      }
    }

    if (otmItems.length > 0) {
      for (const item of itmItems) {
        counts.nonOtmExcluded += 1;
        discarded.push({
          index: item.index,
          strike: item.quote.strike,
          contractType: item.quote.contractType,
          reason: 'nonOtmExcluded',
        });
      }
      for (const item of otmItems) {
        accepted.push(item.quote);
      }
      aggregated.push(aggregateStrikeQuotes(otmItems, otmType));
    } else if (normalized.quoteSelection === 'otmStrict') {
      for (const item of itmItems) {
        counts.nonOtmExcluded += 1;
        discarded.push({
          index: item.index,
          strike: item.quote.strike,
          contractType: item.quote.contractType,
          reason: 'nonOtmExcluded',
        });
      }
    } else {
      for (const item of itmItems) {
        accepted.push(item.quote);
      }
      aggregated.push(aggregateStrikeQuotes(itmItems));
    }
  }

  return {
    validOptions: true,
    accepted,
    aggregated,
    discarded,
    countsByReason: counts,
  };
}

function computePchipEndpointSlope(h0: number, h1: number, m0: number, m1: number): number {
  if (m0 === 0) {
    return 0;
  }
  let slope = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (Math.sign(slope) !== Math.sign(m0)) {
    slope = 0;
  } else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(slope) > Math.abs(3 * m0)) {
    slope = 3 * m0;
  }
  return slope;
}

/**
 * Computes Fritsch-Carlson (1980) shape-preserving PCHIP node derivatives,
 * preserving local monotonicity without spline overshoot.
 */
function computePchipSlopes(ks: readonly number[], ws: readonly number[]): number[] {
  const n = ks.length;
  if (n < 2) {
    return [];
  }

  const h: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const kNext = ks[i + 1];
    const kCurr = ks[i];
    const wNext = ws[i + 1];
    const wCurr = ws[i];
    if (
      kNext === undefined ||
      kCurr === undefined ||
      wNext === undefined ||
      wCurr === undefined
    ) {
      return [];
    }
    const step = kNext - kCurr;
    h.push(step);
    m.push((wNext - wCurr) / step);
  }

  if (n === 2) {
    const m0 = m[0] ?? 0;
    return [m0, m0];
  }

  const slopes = new Array<number>(n).fill(0);
  const h0 = h[0] ?? 0;
  const h1 = h[1] ?? 0;
  const m0 = m[0] ?? 0;
  const m1 = m[1] ?? 0;
  slopes[0] = computePchipEndpointSlope(h0, h1, m0, m1);

  for (let i = 1; i < n - 1; i += 1) {
    const mPrev = m[i - 1] ?? 0;
    const mCurr = m[i] ?? 0;
    if (mPrev === 0 || mCurr === 0 || Math.sign(mPrev) !== Math.sign(mCurr)) {
      slopes[i] = 0;
    } else {
      const hPrev = h[i - 1] ?? 0;
      const hCurr = h[i] ?? 0;
      const w1 = 2 * hCurr + hPrev;
      const w2 = hCurr + 2 * hPrev;
      slopes[i] = (w1 + w2) / (w1 / mPrev + w2 / mCurr);
    }
  }

  const hLast = h[n - 2] ?? 0;
  const hPrevLast = h[n - 3] ?? 0;
  const mLast = m[n - 2] ?? 0;
  const mPrevLast = m[n - 3] ?? 0;
  slopes[n - 1] = computePchipEndpointSlope(hLast, hPrevLast, mLast, mPrevLast);

  return slopes;
}

function resolveSliceDividendYield(input: VolSliceInput): number {
  if (input.dividendYield !== undefined) {
    return Number.isFinite(input.dividendYield) ? input.dividendYield : Number.NaN;
  }
  if (
    input.spot !== undefined &&
    input.rate !== undefined &&
    isFinitePositive(input.spot) &&
    Number.isFinite(input.rate)
  ) {
    return impliedDividendYieldFromForward(
      input.spot,
      input.forward,
      input.timeToExpiry,
      input.rate,
    );
  }
  return Number.NaN;
}

function buildInvalidSlice(
  input: VolSliceInput,
  reason: VolSliceRejectionReason,
  acceptedQuotesCount: number,
  strikeNodesCount: number,
  minPointsRequired: number,
  discardedCounts: VolQuoteDiscardCounts,
): VolSlice {
  const inputQuotesCount = isRuntimeArray(input.quotes) ? input.quotes.length : 0;
  return {
    isValid: false,
    timeToExpiry: Number.isFinite(input.timeToExpiry) ? input.timeToExpiry : Number.NaN,
    expirySec:
      input.expirySec !== undefined && Number.isFinite(input.expirySec)
        ? input.expirySec
        : Number.NaN,
    forward: Number.isFinite(input.forward) ? input.forward : Number.NaN,
    spot: input.spot !== undefined && Number.isFinite(input.spot) ? input.spot : Number.NaN,
    rate: input.rate !== undefined && Number.isFinite(input.rate) ? input.rate : Number.NaN,
    dividendYield:
      input.dividendYield !== undefined && Number.isFinite(input.dividendYield)
        ? input.dividendYield
        : Number.NaN,
    kMin: Number.NaN,
    kMax: Number.NaN,
    nodes: [],
    report: {
      isValid: false,
      rejectionReason: reason,
      inputQuotesCount,
      acceptedQuotesCount,
      strikeNodesCount,
      minPointsRequired,
      discardedCounts,
    },
  };
}

/**
 * Constructs a single-expiry total-variance PCHIP smile slice in log-forward
 * moneyness k = ln(K / F). Returns an invalid slice (producing NaN on queries)
 * when inputs fail validation or fewer than minPoints valid strikes remain.
 */
export function buildVolSlice(
  input: VolSliceInput,
  options?: VolSurfaceFilterOptions,
): VolSlice {
  const minPointsFallback =
    options?.minPoints !== undefined &&
    Number.isInteger(options.minPoints) &&
    options.minPoints >= 2
      ? options.minPoints
      : DEFAULT_MIN_POINTS;

  const emptyCounts = createEmptyDiscardCounts();
  if (!isFinitePositive(input.timeToExpiry) || !isFinitePositive(input.forward)) {
    return buildInvalidSlice(
      input,
      'invalid_slice_params',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }
  if (input.expirySec !== undefined && !Number.isFinite(input.expirySec)) {
    return buildInvalidSlice(
      input,
      'invalid_slice_params',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }
  if (input.spot !== undefined && !isFinitePositive(input.spot)) {
    return buildInvalidSlice(
      input,
      'invalid_slice_params',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }
  if (input.rate !== undefined && !Number.isFinite(input.rate)) {
    return buildInvalidSlice(
      input,
      'invalid_slice_params',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }
  if (input.dividendYield !== undefined && !Number.isFinite(input.dividendYield)) {
    return buildInvalidSlice(
      input,
      'invalid_slice_params',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }

  const filterOpts: VolSurfaceFilterOptions = {
    ...options,
    forward: options?.forward ?? input.forward,
  };
  const normalizedOpts = normalizeFilterOptions(filterOpts);
  if (normalizedOpts === null) {
    return buildInvalidSlice(
      input,
      'invalid_filter_options',
      0,
      0,
      minPointsFallback,
      emptyCounts,
    );
  }

  const filtered = filterVolQuotes(input.quotes, filterOpts);
  if (filtered.aggregated.length < normalizedOpts.minPoints) {
    return buildInvalidSlice(
      input,
      'insufficient_points',
      filtered.accepted.length,
      filtered.aggregated.length,
      normalizedOpts.minPoints,
      filtered.countsByReason,
    );
  }

  const ks: number[] = [];
  const ws: number[] = [];
  for (const quote of filtered.aggregated) {
    const k = Math.log(quote.strike / input.forward);
    const w = quote.iv * quote.iv * input.timeToExpiry;
    if (!Number.isFinite(k) || !isFinitePositive(w)) {
      return buildInvalidSlice(
        input,
        'invalid_slice_params',
        filtered.accepted.length,
        filtered.aggregated.length,
        normalizedOpts.minPoints,
        filtered.countsByReason,
      );
    }
    ks.push(k);
    ws.push(w);
  }

  for (let i = 1; i < ks.length; i += 1) {
    const kCurr = ks[i];
    const kPrev = ks[i - 1];
    if (kCurr === undefined || kPrev === undefined || kCurr <= kPrev) {
      return buildInvalidSlice(
        input,
        'insufficient_points',
        filtered.accepted.length,
        filtered.aggregated.length,
        normalizedOpts.minPoints,
        filtered.countsByReason,
      );
    }
  }

  const slopes = computePchipSlopes(ks, ws);
  const nodes: VolSliceNode[] = [];
  for (let i = 0; i < filtered.aggregated.length; i += 1) {
    const quote = filtered.aggregated[i];
    const k = ks[i];
    const w = ws[i];
    const slope = slopes[i];
    if (quote === undefined || k === undefined || w === undefined || slope === undefined) {
      return buildInvalidSlice(
        input,
        'invalid_slice_params',
        filtered.accepted.length,
        filtered.aggregated.length,
        normalizedOpts.minPoints,
        filtered.countsByReason,
      );
    }
    nodes.push({
      k,
      strike: quote.strike,
      totalVariance: w,
      iv: quote.iv,
      slope,
      spreadRatio: quote.spreadRatio,
      openInterest: quote.openInterest,
    });
  }

  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  if (firstNode === undefined || lastNode === undefined) {
    return buildInvalidSlice(
      input,
      'insufficient_points',
      filtered.accepted.length,
      nodes.length,
      normalizedOpts.minPoints,
      filtered.countsByReason,
    );
  }

  return {
    isValid: true,
    timeToExpiry: input.timeToExpiry,
    expirySec:
      input.expirySec !== undefined && Number.isFinite(input.expirySec)
        ? input.expirySec
        : Number.NaN,
    forward: input.forward,
    spot: input.spot !== undefined ? input.spot : Number.NaN,
    rate: input.rate !== undefined ? input.rate : Number.NaN,
    dividendYield: resolveSliceDividendYield(input),
    kMin: firstNode.k,
    kMax: lastNode.k,
    nodes,
    report: {
      isValid: true,
      rejectionReason: null,
      inputQuotesCount: input.quotes.length,
      acceptedQuotesCount: filtered.accepted.length,
      strikeNodesCount: nodes.length,
      minPointsRequired: normalizedOpts.minPoints,
      discardedCounts: filtered.countsByReason,
    },
  };
}

function findSegmentIndex(
  nodes: readonly VolSliceNode[],
  k: number,
  side: 'right' | 'left',
): number {
  const n = nodes.length;
  if (n < 2) {
    return -1;
  }

  const first = nodes[0];
  const last = nodes[n - 1];
  if (first === undefined || last === undefined) {
    return -1;
  }
  if (k <= first.k) {
    return 0;
  }
  if (k >= last.k) {
    return n - 2;
  }

  let lo = 0;
  let hi = n - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const left = nodes[mid];
    const right = nodes[mid + 1];
    if (left === undefined || right === undefined) {
      return -1;
    }
    if (k < left.k) {
      hi = mid - 1;
    } else if (k > right.k) {
      lo = mid + 1;
    } else {
      if (k === left.k && side === 'left' && mid > 0) {
        return mid - 1;
      }
      if (k === right.k && side === 'right' && mid + 1 < n - 1) {
        return mid + 1;
      }
      return mid;
    }
  }
  return Math.max(0, Math.min(n - 2, lo));
}

function evaluateSegmentDerivatives(
  left: VolSliceNode,
  right: VolSliceNode,
  t: number,
  timeToExpiry: number,
): SliceDerivatives {
  const h = right.k - left.k;
  const oneMinusT = 1 - t;
  const t2 = t * t;
  const t3 = t2 * t;

  const h00 = (1 + 2 * t) * oneMinusT * oneMinusT;
  const h10 = t * oneMinusT * oneMinusT;
  const h01 = t2 * (3 - 2 * t);
  const h11 = t3 - t2;

  const totalVariance =
    left.totalVariance * h00 +
    h * left.slope * h10 +
    right.totalVariance * h01 +
    h * right.slope * h11;

  const dh00 = 6 * (t2 - t);
  const dh10 = 3 * t2 - 4 * t + 1;
  const dh01 = -6 * (t2 - t);
  const dh11 = 3 * t2 - 2 * t;

  const dwDk =
    (left.totalVariance * dh00 +
      h * left.slope * dh10 +
      right.totalVariance * dh01 +
      h * right.slope * dh11) /
    h;

  const d2h00 = 12 * t - 6;
  const d2h10 = 6 * t - 4;
  const d2h01 = -12 * t + 6;
  const d2h11 = 6 * t - 2;

  const d2wDk2 =
    (left.totalVariance * d2h00 +
      h * left.slope * d2h10 +
      right.totalVariance * d2h01 +
      h * right.slope * d2h11) /
    (h * h);

  const iv =
    isFinitePositive(totalVariance) && isFinitePositive(timeToExpiry)
      ? Math.sqrt(totalVariance / timeToExpiry)
      : Number.NaN;

  return {
    totalVariance,
    dwDk,
    d2wDk2,
    iv,
  };
}

function invalidDerivatives(): SliceDerivatives {
  return {
    totalVariance: Number.NaN,
    dwDk: Number.NaN,
    d2wDk2: Number.NaN,
    iv: Number.NaN,
  };
}

/**
 * Evaluates total variance w(k), first derivative dw/dk, second derivative
 * d2w/dk2, and implied volatility at log-moneyness k. Returns NaN outside
 * the slice range [kMin, kMax] without extrapolating flat wings.
 */
export function evaluateSliceDerivatives(
  slice: VolSlice,
  logMoneyness: number,
  side: 'right' | 'left' = 'right',
): SliceDerivatives {
  if (
    !slice.isValid ||
    !Number.isFinite(logMoneyness) ||
    logMoneyness < slice.kMin ||
    logMoneyness > slice.kMax ||
    slice.nodes.length < 2
  ) {
    return invalidDerivatives();
  }

  const segIdx = findSegmentIndex(slice.nodes, logMoneyness, side);
  if (segIdx < 0) {
    return invalidDerivatives();
  }

  const left = slice.nodes[segIdx];
  const right = slice.nodes[segIdx + 1];
  if (left === undefined || right === undefined) {
    return invalidDerivatives();
  }

  const h = right.k - left.k;
  if (!isFinitePositive(h)) {
    return invalidDerivatives();
  }

  const t = (logMoneyness - left.k) / h;
  return evaluateSegmentDerivatives(left, right, t, slice.timeToExpiry);
}

/**
 * Evaluates total variance w(k) on the PCHIP slice inside [kMin, kMax].
 * Returns NaN outside the observed strike support.
 */
export function evaluateSliceTotalVariance(slice: VolSlice, logMoneyness: number): number {
  return evaluateSliceDerivatives(slice, logMoneyness, 'right').totalVariance;
}

/**
 * Evaluates implied volatility sqrt(w(k) / T) on the PCHIP slice inside [kMin, kMax].
 * Returns NaN outside the observed strike support.
 */
export function evaluateSliceIv(slice: VolSlice, logMoneyness: number): number {
  return evaluateSliceDerivatives(slice, logMoneyness, 'right').iv;
}

/**
 * Evaluates implied volatility at an explicit option strike inside the slice support.
 * Returns NaN for non-positive strikes or strikes outside [kMin, kMax].
 */
export function evaluateSliceIvAtStrike(slice: VolSlice, strike: number): number {
  if (!slice.isValid || !isFinitePositive(strike) || !isFinitePositive(slice.forward)) {
    return Number.NaN;
  }
  const k = Math.log(strike / slice.forward);
  return evaluateSliceIv(slice, k);
}

/**
 * Evaluates Durrleman butterfly risk-neutral probability density numerator g(k):
 * g(k) >= 0 implies non-negative call butterfly spreads on the slice.
 */
export function computeDurrlemanDensity(
  logMoneyness: number,
  totalVariance: number,
  dwDk: number,
  d2wDk2: number,
): number {
  if (
    !Number.isFinite(logMoneyness) ||
    !Number.isFinite(totalVariance) ||
    !Number.isFinite(dwDk) ||
    !Number.isFinite(d2wDk2)
  ) {
    return Number.NaN;
  }
  if (totalVariance <= 0) {
    return totalVariance < 0 ? totalVariance : -1;
  }
  const term = 1 - (logMoneyness * dwDk) / (2 * totalVariance);
  return term * term - 0.25 * dwDk * dwDk * (1 / totalVariance + 0.25) + 0.5 * d2wDk2;
}

/**
 * Validates static butterfly arbitrage across all PCHIP segments (including both
 * left and right limits at every knot) via Durrleman's density g(k) >= -tolerance.
 */
export function validateSliceButterflyArbitrage(
  slice: VolSlice,
  options?: ButterflyArbitrageOptions,
): ButterflyArbitrageReport {
  const samples = options?.samplesPerSegment ?? DEFAULT_BUTTERFLY_SAMPLES;
  const tolerance = options?.tolerance ?? DEFAULT_ARBITRAGE_TOLERANCE;

  if (!slice.isValid || slice.nodes.length < 2) {
    return {
      status: 'NOT_EVALUATED',
      isArbitrageFree: false,
      checkedPointsCount: 0,
      minDensity: Number.NaN,
      worstLogMoneyness: Number.NaN,
      worstStrike: Number.NaN,
      violations: [],
    };
  }

  if (
    !Number.isInteger(samples) ||
    samples < 1 ||
    !isFiniteNonNegative(tolerance)
  ) {
    return {
      status: 'FAIL',
      isArbitrageFree: false,
      checkedPointsCount: 0,
      minDensity: Number.NaN,
      worstLogMoneyness: Number.NaN,
      worstStrike: Number.NaN,
      violations: [],
    };
  }

  let checkedPointsCount = 0;
  let minDensity = Number.POSITIVE_INFINITY;
  let worstK = Number.NaN;
  const violations: ButterflyViolation[] = [];

  for (let i = 0; i < slice.nodes.length - 1; i += 1) {
    const left = slice.nodes[i];
    const right = slice.nodes[i + 1];
    if (left === undefined || right === undefined) {
      continue;
    }

    const h = right.k - left.k;
    for (let s = 0; s <= samples; s += 1) {
      const t = s / samples;
      const k = left.k + t * h;
      const deriv = evaluateSegmentDerivatives(left, right, t, slice.timeToExpiry);
      const density = computeDurrlemanDensity(
        k,
        deriv.totalVariance,
        deriv.dwDk,
        deriv.d2wDk2,
      );
      checkedPointsCount += 1;

      if (!Number.isFinite(density) || density < minDensity) {
        minDensity = density;
        worstK = k;
      }
      if (!Number.isFinite(density) || density < -tolerance) {
        violations.push({
          k,
          strike: slice.forward * Math.exp(k),
          density,
          totalVariance: deriv.totalVariance,
          dwDk: deriv.dwDk,
          d2wDk2: deriv.d2wDk2,
        });
      }
    }
  }

  const status: TriValuedCheckStatus =
    checkedPointsCount === 0
      ? 'NOT_EVALUATED'
      : violations.length === 0
        ? 'PASS'
        : 'FAIL';

  return {
    status,
    isArbitrageFree: status === 'PASS',
    checkedPointsCount,
    minDensity,
    worstLogMoneyness: worstK,
    worstStrike: Number.isFinite(worstK) ? slice.forward * Math.exp(worstK) : Number.NaN,
    violations,
  };
}

function buildOverlapGrid(
  near: VolSlice,
  far: VolSlice,
  includeMidpoints: boolean,
): number[] {
  const kStart = Math.max(near.kMin, far.kMin);
  const kEnd = Math.min(near.kMax, far.kMax);
  if (kStart > kEnd) {
    return [];
  }

  const rawPoints: number[] = [kStart, kEnd];
  for (const node of near.nodes) {
    if (node.k >= kStart && node.k <= kEnd) {
      rawPoints.push(node.k);
    }
  }
  for (const node of far.nodes) {
    if (node.k >= kStart && node.k <= kEnd) {
      rawPoints.push(node.k);
    }
  }

  rawPoints.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const pt of rawPoints) {
    const prev = deduped[deduped.length - 1];
    if (prev === undefined || pt - prev > 1e-12) {
      deduped.push(pt);
    }
  }

  if (!includeMidpoints || deduped.length < 2) {
    return deduped;
  }

  const withMidpoints: number[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    const pt = deduped[i];
    if (pt === undefined) {
      continue;
    }
    withMidpoints.push(pt);
    const nextPt = deduped[i + 1];
    if (nextPt !== undefined) {
      withMidpoints.push(0.5 * (pt + nextPt));
    }
  }
  return withMidpoints;
}

/**
 * Validates calendar spread absence across sorted valid slices: total variance
 * w(k, T) must be non-decreasing with T at fixed log-forward moneyness k.
 */
export function validateSurfaceCalendarArbitrage(
  slices: readonly VolSlice[],
  options?: CalendarArbitrageOptions,
): CalendarArbitrageReport {
  const tolerance = options?.tolerance ?? DEFAULT_ARBITRAGE_TOLERANCE;
  const overlapMidpoints = options?.overlapMidpoints ?? true;

  if (!isFiniteNonNegative(tolerance)) {
    return {
      status: 'FAIL',
      isArbitrageFree: false,
      checkedComparisons: 0,
      minVarianceDiff: Number.NaN,
      violations: [],
    };
  }

  const validSlices = slices
    .filter((s) => s.isValid)
    .slice()
    .sort((a, b) => a.timeToExpiry - b.timeToExpiry);

  if (validSlices.length < 2) {
    return {
      status: 'NOT_EVALUATED',
      isArbitrageFree: false,
      checkedComparisons: 0,
      minVarianceDiff: Number.NaN,
      violations: [],
    };
  }

  let checkedComparisons = 0;
  let minVarianceDiff = Number.POSITIVE_INFINITY;
  const violations: CalendarViolation[] = [];

  for (let i = 0; i < validSlices.length - 1; i += 1) {
    const near = validSlices[i];
    const far = validSlices[i + 1];
    if (near === undefined || far === undefined) {
      continue;
    }

    const grid = buildOverlapGrid(near, far, overlapMidpoints);
    for (const k of grid) {
      const wNear = evaluateSliceTotalVariance(near, k);
      const wFar = evaluateSliceTotalVariance(far, k);
      const diff = wFar - wNear;
      checkedComparisons += 1;

      if (!Number.isFinite(diff) || diff < minVarianceDiff) {
        minVarianceDiff = diff;
      }
      if (!Number.isFinite(diff) || diff < -tolerance) {
        violations.push({
          nearTimeToExpiry: near.timeToExpiry,
          farTimeToExpiry: far.timeToExpiry,
          k,
          nearTotalVariance: wNear,
          farTotalVariance: wFar,
          varianceDiff: diff,
        });
      }
    }
  }

  const status: TriValuedCheckStatus =
    checkedComparisons === 0
      ? 'NOT_EVALUATED'
      : violations.length === 0
        ? 'PASS'
        : 'FAIL';

  return {
    status,
    isArbitrageFree: status === 'PASS',
    checkedComparisons,
    minVarianceDiff: checkedComparisons > 0 ? minVarianceDiff : Number.NaN,
    violations,
  };
}

/**
 * Builds a pure multi-expiry implied volatility surface sorted by expiry,
 * checking both per-slice Durrleman butterfly arbitrage and cross-expiry calendar
 * total-variance monotonicity.
 */
export function buildVolSurface(
  inputs: readonly VolSliceInput[],
  options?: BuildVolSurfaceOptions,
): VolSurface {
  const built = inputs.map((sliceInput) => buildVolSlice(sliceInput, options?.filter));
  const sorted = built.slice().sort((a, b) => {
    const taValid = Number.isFinite(a.timeToExpiry);
    const tbValid = Number.isFinite(b.timeToExpiry);
    if (!taValid && !tbValid) {
      return 0;
    }
    if (!taValid) {
      return 1;
    }
    if (!tbValid) {
      return -1;
    }
    return a.timeToExpiry - b.timeToExpiry;
  });

  let validSlicesCount = 0;
  let invalidSlicesCount = 0;
  const butterflyReports: ButterflyArbitrageReport[] = [];
  let hasButterflyFail = false;
  let hasButterflyNotEvaluated = false;

  for (const slice of sorted) {
    const bfReport = validateSliceButterflyArbitrage(slice, options?.butterfly);
    butterflyReports.push(bfReport);
    if (slice.isValid) {
      validSlicesCount += 1;
      if (bfReport.status === 'FAIL') {
        hasButterflyFail = true;
      } else if (bfReport.status === 'NOT_EVALUATED') {
        hasButterflyNotEvaluated = true;
      }
    } else {
      invalidSlicesCount += 1;
    }
  }

  const butterflyCheckStatus: TriValuedCheckStatus =
    validSlicesCount === 0
      ? 'NOT_EVALUATED'
      : hasButterflyFail
        ? 'FAIL'
        : hasButterflyNotEvaluated
          ? 'NOT_EVALUATED'
          : 'PASS';

  const calendarCheck = validateSurfaceCalendarArbitrage(sorted, options?.calendar);
  const calendarCheckStatus = calendarCheck.status;
  const arbitrageCheckStatus: TriValuedCheckStatus =
    butterflyCheckStatus === 'FAIL' || calendarCheckStatus === 'FAIL'
      ? 'FAIL'
      : validSlicesCount >= 2 &&
          invalidSlicesCount === 0 &&
          butterflyCheckStatus === 'PASS' &&
          calendarCheckStatus === 'PASS'
        ? 'PASS'
        : 'NOT_EVALUATED';

  return {
    slices: sorted,
    validSlicesCount,
    invalidSlicesCount,
    butterflyReports,
    butterflyCheckStatus,
    calendarCheckStatus,
    arbitrageCheckStatus,
    butterflyArbitrageFree: butterflyCheckStatus === 'PASS' && invalidSlicesCount === 0,
    calendarArbitrageFree: calendarCheckStatus === 'PASS',
    isArbitrageFree: arbitrageCheckStatus === 'PASS',
    calendarCheck,
  };
}

/**
 * Interpolates total variance w(T, k) linearly in time between adjacent sorted
 * slices. Returns NaN when T lies outside [minT, maxT], k falls outside either
 * bracketing slice's [kMin, kMax], or any bracketing slice is invalid.
 */
export function interpolateSurfaceTotalVariance(
  surface: VolSurface,
  timeToExpiry: number,
  logMoneyness: number,
): number {
  if (
    !isFinitePositive(timeToExpiry) ||
    !Number.isFinite(logMoneyness) ||
    surface.slices.length === 0
  ) {
    return Number.NaN;
  }

  const ordered = surface.slices;
  for (const slice of ordered) {
    if (!Number.isFinite(slice.timeToExpiry)) {
      continue;
    }
    if (Math.abs(slice.timeToExpiry - timeToExpiry) <= TIME_MATCH_TOLERANCE) {
      return slice.isValid ? evaluateSliceTotalVariance(slice, logMoneyness) : Number.NaN;
    }
  }

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const near = ordered[i];
    const far = ordered[i + 1];
    if (
      near === undefined ||
      far === undefined ||
      !Number.isFinite(near.timeToExpiry) ||
      !Number.isFinite(far.timeToExpiry)
    ) {
      continue;
    }
    if (near.timeToExpiry < timeToExpiry && timeToExpiry < far.timeToExpiry) {
      if (!near.isValid || !far.isValid) {
        return Number.NaN;
      }
      const wNear = evaluateSliceTotalVariance(near, logMoneyness);
      const wFar = evaluateSliceTotalVariance(far, logMoneyness);
      if (!Number.isFinite(wNear) || !Number.isFinite(wFar)) {
        return Number.NaN;
      }
      const alpha =
        (timeToExpiry - near.timeToExpiry) / (far.timeToExpiry - near.timeToExpiry);
      return (1 - alpha) * wNear + alpha * wFar;
    }
  }

  return Number.NaN;
}

/**
 * Evaluates implied volatility on the volatility surface at target (T, strike)
 * by interpolating forward log-linearly between adjacent valid slices (when
 * forward metadata is positive) and linearizing total variance in T.
 */
export function evaluateSurfaceIvAtStrike(
  surface: VolSurface,
  timeToExpiry: number,
  strike: number,
): number {
  if (!isFinitePositive(timeToExpiry) || !isFinitePositive(strike) || surface.slices.length === 0) {
    return Number.NaN;
  }

  const ordered = surface.slices;
  for (const slice of ordered) {
    if (!Number.isFinite(slice.timeToExpiry)) {
      continue;
    }
    if (Math.abs(slice.timeToExpiry - timeToExpiry) <= TIME_MATCH_TOLERANCE) {
      return slice.isValid ? evaluateSliceIvAtStrike(slice, strike) : Number.NaN;
    }
  }

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const near = ordered[i];
    const far = ordered[i + 1];
    if (
      near === undefined ||
      far === undefined ||
      !Number.isFinite(near.timeToExpiry) ||
      !Number.isFinite(far.timeToExpiry)
    ) {
      continue;
    }
    if (near.timeToExpiry < timeToExpiry && timeToExpiry < far.timeToExpiry) {
      if (
        !near.isValid ||
        !far.isValid ||
        !isFinitePositive(near.forward) ||
        !isFinitePositive(far.forward)
      ) {
        return Number.NaN;
      }
      const alpha =
        (timeToExpiry - near.timeToExpiry) / (far.timeToExpiry - near.timeToExpiry);
      const logForward =
        (1 - alpha) * Math.log(near.forward) + alpha * Math.log(far.forward);
      const forwardAtT = Math.exp(logForward);
      if (!isFinitePositive(forwardAtT)) {
        return Number.NaN;
      }
      const k = Math.log(strike / forwardAtT);
      const wNear = evaluateSliceTotalVariance(near, k);
      const wFar = evaluateSliceTotalVariance(far, k);
      if (!Number.isFinite(wNear) || !Number.isFinite(wFar)) {
        return Number.NaN;
      }
      const w = (1 - alpha) * wNear + alpha * wFar;
      return isFinitePositive(w) ? Math.sqrt(w / timeToExpiry) : Number.NaN;
    }
  }

  return Number.NaN;
}

export * from './catalysts.js';

export type ForwardIvStatus = 'OK' | 'CALENDAR_ARB' | 'INVALID';

export interface ForwardIvPairInput {
  readonly nearExpiryCode?: string;
  readonly farExpiryCode?: string;
  readonly nearExpirySec?: number;
  readonly farExpirySec?: number;
  readonly nearDte?: number;
  readonly farDte?: number;
  readonly nearTimeToExpiry: number;
  readonly farTimeToExpiry: number;
  readonly nearIv: number;
  readonly farIv: number;
}

export interface ForwardIvTermPointInput {
  readonly expiryCode?: string;
  readonly expirySec?: number;
  readonly dte?: number;
  readonly timeToExpiry: number;
  readonly atmIv?: number;
  readonly iv?: number;
}

export interface ForwardIvSegmentResult {
  readonly nearExpiryCode: string | null;
  readonly farExpiryCode: string | null;
  readonly nearExpirySec: number | null;
  readonly farExpirySec: number | null;
  readonly nearDte: number | null;
  readonly farDte: number | null;
  readonly nearTimeToExpiry: number;
  readonly farTimeToExpiry: number;
  readonly nearIv: number;
  readonly farIv: number;
  readonly forwardVariance: number;
  readonly forwardIv: number | null;
  readonly calendarArbFlag: boolean;
  readonly status: ForwardIvStatus;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalFinite(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/**
 * Calcula la volatilidad forward implicita entre dos vencimientos consecutivos
 * `(T1, IV1)` y `(T2, IV2)` usando varianza total:
 *   `forwardVar = (IV2^2 * T2 - IV1^2 * T1) / (T2 - T1)`
 *
 * Degradacion honesta:
 * - Si los inputs no son validos (`T1 <= 0`, `T2 <= T1`, IV no positiva/finita):
 *   `forwardIv: null, forwardVariance: NaN, calendarArbFlag: false, status: 'INVALID'`.
 * - Si hay inversion calendario (`forwardVar <= 0`):
 *   `forwardIv: null, calendarArbFlag: true, status: 'CALENDAR_ARB'` sin fabricar ceros ni NaN en `forwardIv`.
 */
export function computeForwardIvPair(input: ForwardIvPairInput): ForwardIvSegmentResult {
  const nearT = input.nearTimeToExpiry;
  const farT = input.farTimeToExpiry;
  const nearIv = input.nearIv;
  const farIv = input.farIv;

  const base = {
    nearExpiryCode: normalizeOptionalString(input.nearExpiryCode),
    farExpiryCode: normalizeOptionalString(input.farExpiryCode),
    nearExpirySec: normalizeOptionalFinite(input.nearExpirySec),
    farExpirySec: normalizeOptionalFinite(input.farExpirySec),
    nearDte: normalizeOptionalFinite(input.nearDte),
    farDte: normalizeOptionalFinite(input.farDte),
    nearTimeToExpiry: nearT,
    farTimeToExpiry: farT,
    nearIv,
    farIv,
  };

  if (
    !isFinitePositive(nearT)
    || !isFinitePositive(farT)
    || farT <= nearT
    || !isFinitePositive(nearIv)
    || !isFinitePositive(farIv)
  ) {
    return {
      ...base,
      forwardVariance: Number.NaN,
      forwardIv: null,
      calendarArbFlag: false,
      status: 'INVALID',
    };
  }

  const nearTotalVar = nearIv * nearIv * nearT;
  const farTotalVar = farIv * farIv * farT;
  const forwardVariance = (farTotalVar - nearTotalVar) / (farT - nearT);

  if (!Number.isFinite(forwardVariance)) {
    return {
      ...base,
      forwardVariance: Number.NaN,
      forwardIv: null,
      calendarArbFlag: false,
      status: 'INVALID',
    };
  }

  if (forwardVariance <= 0) {
    return {
      ...base,
      forwardVariance,
      forwardIv: null,
      calendarArbFlag: true,
      status: 'CALENDAR_ARB',
    };
  }

  return {
    ...base,
    forwardVariance,
    forwardIv: Math.sqrt(forwardVariance),
    calendarArbFlag: false,
    status: 'OK',
  };
}

/**
 * Construye la secuencia de segmentos de Forward IV entre pares consecutivos
 * de una estructura temporal ordenada por `timeToExpiry` ascendente.
 */
export function computeForwardIvTermStructure(
  points: readonly ForwardIvTermPointInput[],
): ForwardIvSegmentResult[] {
  const valid = points
    .map((point) => {
      const iv = point.atmIv !== undefined ? point.atmIv : point.iv !== undefined ? point.iv : Number.NaN;
      return { point, iv };
    })
    .filter(({ point, iv }) => isFinitePositive(point.timeToExpiry) && isFinitePositive(iv))
    .sort((a, b) => a.point.timeToExpiry - b.point.timeToExpiry);

  const segments: ForwardIvSegmentResult[] = [];
  for (let i = 0; i < valid.length - 1; i += 1) {
    const nearEntry = valid[i];
    const farEntry = valid[i + 1];
    if (!nearEntry || !farEntry) continue;
    if (farEntry.point.timeToExpiry <= nearEntry.point.timeToExpiry) continue;
    segments.push(
      computeForwardIvPair({
        ...(nearEntry.point.expiryCode !== undefined ? { nearExpiryCode: nearEntry.point.expiryCode } : {}),
        ...(farEntry.point.expiryCode !== undefined ? { farExpiryCode: farEntry.point.expiryCode } : {}),
        ...(nearEntry.point.expirySec !== undefined ? { nearExpirySec: nearEntry.point.expirySec } : {}),
        ...(farEntry.point.expirySec !== undefined ? { farExpirySec: farEntry.point.expirySec } : {}),
        ...(nearEntry.point.dte !== undefined ? { nearDte: nearEntry.point.dte } : {}),
        ...(farEntry.point.dte !== undefined ? { farDte: farEntry.point.dte } : {}),
        nearTimeToExpiry: nearEntry.point.timeToExpiry,
        farTimeToExpiry: farEntry.point.timeToExpiry,
        nearIv: nearEntry.iv,
        farIv: farEntry.iv,
      }),
    );
  }
  return segments;
}
