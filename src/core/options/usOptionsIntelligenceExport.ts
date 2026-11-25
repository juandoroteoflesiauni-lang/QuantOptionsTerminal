/**
 * Pieza EXPORT-1: núcleo cuantitativo puro de US Options Intelligence Export Engine.
 *
 * Garantías AGENTS.md / SPEC.md:
 * - Funciones 100 % puras: cero red, cero DOM/React, cero E/S, cero mutación de argumentos.
 * - Timestamps en segundos UTC enteros; formateo humano dual en America/New_York (DST)
 *   y America/Argentina/Buenos_Aires sin offsets fijos.
 * - Política Zero Silent Fallbacks: todo valor no calculable es `NaN` interno.
 *   `OI === 0` se distingue estrictamente de `OI === null/NaN`.
 *   Nunca sustituye Bid/Ask con `last`.
 */

import { calculateAnchoredVwap } from '../avwap.js';
import { calculateEma } from '../ema.js';
import { computeSessionVwap } from '../sessionVwap.js';
import {
  MAX_TIME_SECONDS,
  getMarketParts,
  getUsEquitySessionPhase,
} from '../sessions.js';
import {
  rankCreditStructures,
  type CreditOptionQuoteInput,
  type CreditStructureCandidate,
} from '../terminal/structureOptimizer.js';
import { evaluateCatalystWindow } from './catalysts.js';
import {
  classifyDealerGammaRegimeFromSummary,
  computeMaxPainStrike,
  type DealerExposureUnits,
} from './exposure.js';
import {
  MIN_EXPECTED_MOVE_T_YEARS,
  buildHardenedBlDensity,
  calendarDteEt,
  expectedMoveSigma,
  evaluateShortPremiumBreaker,
  extrinsicValue,
  intrinsicValue,
} from './zeroDteFixes.js';
import { computeActiveExpiryVrpAndRegime } from './volAnalyticsSuite.js';
import { computeActiveExpirySkewAndIvRegime } from './volMetrics.js';
import {
  US_OPTIONS_EXPORT_SCHEMA_VERSION,
  type BlockQualityStatus,
  type CreditLegCalcInput,
  type DualTimezoneTimestamp,
  type ExportAvwapReference,
  type ExportExpiryComparisonRow,
  type ExportExpiryVolatilityBlock,
  type ExportFilteredChainSide,
  type ExportFlowSummaryBlock,
  type ExportFvgZone,
  type ExportSpreadCandidateRow,
  type ExportSpreadsBlock,
  type ExportStrikeFlowRow,
  type ExportTermStructurePoint,
  type ExportUsSnapshotInputDto,
  type FilteredUsOptionsSnapshotV1,
  type MultiLegCreditCalcResult,
  type RawUsOptionsSnapshotInput,
  type RealMoneynessClass,
  type SnapshotBlockProvenance,
  type SnapshotIntegrityReport,
  type SnapshotMode,
  type SwingChainFilterMode,
  type UnifiedContractCalcInput,
  type UnifiedContractCalcResult,
  type UsOptionsIntelligenceSnapshotV1,
  type UsSessionRegime,
  type UsVolAnalyticsExpiryRef,
} from './usOptionsIntelligenceExportTypes.js';
import type { Bar } from '../types.js';

const NY_TZ = 'America/New_York';
const AR_TZ = 'America/Argentina/Buenos_Aires';
const ATM_REL_MONEYNESS_THRESHOLD = 0.0025;
const RTH_SPOT_STALE_SEC = 60;
const RTH_SPOT_OPTIONS_SKEW_SEC = 120;
const SPOT_DRIFT_WARN_PCT = 0.25;
const INTRADAY_DELTA_MIN = 0.45;
const INTRADAY_DELTA_MAX = 0.85;
const SWING_DELTA_MIN = 0.05;
const SWING_DELTA_MAX = 0.55;
const INTRADAY_FLOW_HALF_WINDOW = 10;
const SWING_FLOW_HALF_WINDOW = 15;
const SWING_MIN_WIDTH_USD = 2;
const SWING_MAX_WIDTH_USD = 5;
const SWING_MAX_SPREAD_CANDIDATES = 10;
const MAX_TERM_STRUCTURE_ROWS = 6;
const MAX_ACTIVE_FVGS = 3;
const MAX_NAKED_POCS = 3;

const nyDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

const arDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: AR_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const SECRET_PATTERNS: readonly { readonly name: string; readonly regex: RegExp }[] = [
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: 'secret_key_prefix', regex: /\b(?:sk_live|sk_test|pk_live|pk_test|AKIA)[A-Za-z0-9_-]{10,}/ },
  { name: 'env_assignment', regex: /\b(?:POLYGON|MASSIVE|TRADIER|FMP|ALPACA|ORATS|DATA912|API|SECRET|TOKEN|PASSWORD)_[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9._\-/+=]{8,}/i },
  { name: 'local_positions_key', regex: /quant_core_positions_v1/i },
  { name: 'query_secret', regex: /[?&](?:apiKey|api_key|token|secret)=[A-Za-z0-9._-]{8,}/i },
];

function isFiniteNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPositiveFinite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function firstPositiveFinite(...values: readonly (number | null | undefined)[]): number {
  for (const v of values) {
    if (isPositiveFinite(v)) return v;
  }
  return Number.NaN;
}

function firstFinite(...values: readonly (number | null | undefined)[]): number {
  for (const v of values) {
    if (isFiniteNum(v)) return v;
  }
  return Number.NaN;
}

function isNonNegativeFinite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function toFiniteOrNaN(v: number | null | undefined): number {
  return isFiniteNum(v) ? v : Number.NaN;
}

function fnv1aHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function formatZonedParts(formatter: Intl.DateTimeFormat, utcSec: number, fallbackSuffix: string): string {
  const parts = formatter.formatToParts(new Date(utcSec * 1_000));
  const map = new Map<string, string>();
  for (const p of parts) {
    map.set(p.type, p.value);
  }
  const yyyy = map.get('year') ?? '0000';
  const mm = map.get('month') ?? '00';
  const dd = map.get('day') ?? '00';
  const hh = map.get('hour') ?? '00';
  const min = map.get('minute') ?? '00';
  const ss = map.get('second') ?? '00';
  const tzName = map.get('timeZoneName') ?? fallbackSuffix;
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} ${tzName}`;
}

/**
 * Convierte segundos UTC enteros en representación ISO-8601 + ET (con DST) + ART.
 */
export function formatDualTimezoneTimestamp(utcSec: number): DualTimezoneTimestamp {
  if (!Number.isFinite(utcSec) || Math.abs(utcSec) > MAX_TIME_SECONDS || utcSec <= 0) {
    throw new Error(`Invalid UTC seconds timestamp: ${String(utcSec)}`);
  }
  const sec = Math.floor(utcSec);
  const etParts = getMarketParts(sec, 'EQUITY');
  const isoUtc = `${new Date(sec * 1_000).toISOString().slice(0, 19)}Z`;
  return {
    utcSec: sec,
    isoUtc,
    etFormatted: formatZonedParts(nyDateTimeFormatter, sec, 'ET'),
    artFormatted: formatZonedParts(arDateTimeFormatter, sec, 'ART'),
    etDateKey: etParts.dateKey,
  };
}

function optionalDualTimestamp(utcSec: number | null | undefined): DualTimezoneTimestamp | null {
  if (!isPositiveFinite(utcSec) || Math.abs(utcSec) > MAX_TIME_SECONDS) {
    return null;
  }
  return formatDualTimezoneTimestamp(utcSec);
}

/**
 * Impide fuga accidental de tokens, variables .env o posiciones privadas en el export.
 */
export function assertNoSecretsInExportText(text: string): void {
  for (const pat of SECRET_PATTERNS) {
    if (pat.regex.test(text)) {
      throw new Error(`Export blocked: secret or private account pattern detected (${pat.name})`);
    }
  }
}

export function computeDistancePct(level: number, spot: number): number {
  if (!isFiniteNum(level) || !isPositiveFinite(spot)) {
    return Number.NaN;
  }
  return ((level - spot) / spot) * 100;
}

/**
 * Porcentaje del ATR(14) recorrido en la rueda: `100 * (dayHigh - dayLow) / atr14`.
 */
export function computeAtrTravelledPct(dayHigh: number, dayLow: number, atr14: number): number {
  if (
    !isPositiveFinite(dayHigh) ||
    !isPositiveFinite(dayLow) ||
    dayHigh < dayLow ||
    !isPositiveFinite(atr14)
  ) {
    return Number.NaN;
  }
  return ((dayHigh - dayLow) / atr14) * 100;
}

export function computeIvRvRatio(ivAtmPct: number, rv20Pct: number): number {
  if (!isPositiveFinite(ivAtmPct) || !isPositiveFinite(rv20Pct)) {
    return Number.NaN;
  }
  return ivAtmPct / rv20Pct;
}

/**
 * VRP institucional del repositorio: diferencia de volatilidades en puntos (`IV_ATM - RV_ref`).
 */
export function computeVrpVolDiffPts(ivAtmPct: number, rvRefPct: number): number {
  if (!isPositiveFinite(ivAtmPct) || !isPositiveFinite(rvRefPct)) {
    return Number.NaN;
  }
  return ivAtmPct - rvRefPct;
}

/**
 * Convención institucional unificada de Skew 25Δ: `IV_25P - IV_25C` (pts de volatilidad).
 */
export function computeSkew25PutMinusCallPts(iv25PutPct: number, iv25CallPct: number): number {
  if (!isPositiveFinite(iv25PutPct) || !isPositiveFinite(iv25CallPct)) {
    return Number.NaN;
  }
  return iv25PutPct - iv25CallPct;
}

export function classifyRealMoneyness(
  contractType: 'call' | 'put',
  strike: number,
  spot: number,
): RealMoneynessClass {
  if (!isPositiveFinite(strike) || !isPositiveFinite(spot)) {
    return 'UNKNOWN';
  }
  if (Math.abs(strike - spot) / spot <= ATM_REL_MONEYNESS_THRESHOLD) {
    return 'ATM';
  }
  if (contractType === 'call') {
    return strike < spot ? 'ITM' : 'OTM';
  }
  return strike > spot ? 'ITM' : 'OTM';
}

function isBilateralBookAcceptable(
  bid: number | null | undefined,
  ask: number | null | undefined,
  quoteQuality: string | null | undefined,
): { readonly valid: boolean; readonly reason: string | null } {
  if (
    quoteQuality === 'INVALID_BBO' ||
    quoteQuality === 'MISSING_BBO' ||
    quoteQuality === 'STALE_QUOTE' ||
    quoteQuality === 'NOT_EVALUATED' ||
    quoteQuality === 'EOD_CLOSE_REF'
  ) {
    return { valid: false, reason: quoteQuality };
  }
  if (!isPositiveFinite(bid) || !isPositiveFinite(ask)) {
    return { valid: false, reason: 'MISSING_OR_NONPOSITIVE_BBO' };
  }
  if (ask < bid) {
    return { valid: false, reason: 'CROSSED_BBO' };
  }
  return { valid: true, reason: null };
}

/**
 * Calcula métricas unificadas de un contrato de opción con libro estricto (nunca sustituye por `last`).
 */
export function computeUnifiedContractMetrics(
  input: UnifiedContractCalcInput,
): UnifiedContractCalcResult {
  const book = isBilateralBookAcceptable(input.bid, input.ask, input.quoteQuality);
  const validBid = book.valid ? (input.bid as number) : Number.NaN;
  const validAsk = book.valid ? (input.ask as number) : Number.NaN;
  const mid = book.valid ? 0.5 * (validBid + validAsk) : Number.NaN;
  const spreadUsd = book.valid ? validAsk - validBid : Number.NaN;
  const spreadPct =
    book.valid && isPositiveFinite(mid) ? (spreadUsd / mid) * 100 : Number.NaN;

  const intrinsic =
    isPositiveFinite(input.spot) && isPositiveFinite(input.strike)
      ? intrinsicValue(input.contractType, input.spot, input.strike)
      : Number.NaN;
  const timeValue =
    book.valid &&
    isPositiveFinite(mid) &&
    isPositiveFinite(input.spot) &&
    isPositiveFinite(input.strike)
      ? extrinsicValue(input.contractType, input.spot, input.strike, mid)
      : Number.NaN;

  const ivPct = isPositiveFinite(input.ivDecimal) ? input.ivDecimal * 100 : Number.NaN;
  const volumeKnown = isNonNegativeFinite(input.volume);
  const openInterestKnown = isNonNegativeFinite(input.openInterest);
  const sharesPerContractKnown = isPositiveFinite(input.sharesPerContract);

  return {
    ticker: input.ticker,
    contractType: input.contractType,
    strike: input.strike,
    validBook: book.valid,
    bookInvalidReason: book.reason,
    bid: validBid,
    ask: validAsk,
    mid,
    spreadUsd,
    spreadPct,
    delta: toFiniteOrNaN(input.delta),
    gamma: toFiniteOrNaN(input.gamma),
    thetaDaily: toFiniteOrNaN(input.thetaDaily),
    vegaPer1Pct: toFiniteOrNaN(input.vegaPer1Pct),
    ivPct,
    ivSource: input.ivSource,
    intrinsic,
    timeValue,
    volume: volumeKnown ? toFiniteOrNaN(input.volume) : Number.NaN,
    volumeKnown,
    openInterest: openInterestKnown ? toFiniteOrNaN(input.openInterest) : Number.NaN,
    openInterestKnown,
    gex: toFiniteOrNaN(input.strikeGex),
    distanceSpotPct: computeDistancePct(input.strike, input.spot),
    moneynessClass: classifyRealMoneyness(input.contractType, input.strike, input.spot),
    sharesPerContract: sharesPerContractKnown ? toFiniteOrNaN(input.sharesPerContract) : Number.NaN,
    sharesPerContractKnown,
    exerciseStyle: input.exerciseStyle ?? 'UNKNOWN',
    settlementType: input.settlementType ?? 'UNKNOWN',
    valuationModel: input.valuationModel ?? 'NONE',
    quoteQuality: input.quoteQuality ?? 'UNKNOWN',
    quoteSource: input.quoteSource ?? null,
    quoteTimestampUtcSec: isPositiveFinite(input.quoteTimestampUtcSec)
      ? Math.floor(input.quoteTimestampUtcSec)
      : null,
  };
}

/**
 * Calcula Crédito Mid vs Crédito Conservador multi-pierna considerando cantidades y multiplicador.
 * Si cualquier pierna carece de libro bilateral válido no cruzado -> todo el resultado de crédito cae a NaN.
 */
export function computeMultiLegCreditMetrics(
  legs: readonly CreditLegCalcInput[],
  contractMultiplier = 100,
): MultiLegCreditCalcResult {
  const nanResult = (reason: string): MultiLegCreditCalcResult => ({
    validBboAllLegs: false,
    invalidReason: reason,
    midCreditPerShare: Number.NaN,
    conservativeCreditPerShare: Number.NaN,
    midCreditContractUsd: Number.NaN,
    conservativeCreditContractUsd: Number.NaN,
    widthPerShare: Number.NaN,
    widthContractUsd: Number.NaN,
    maxProfitPerShare: Number.NaN,
    maxLossPerShare: Number.NaN,
    maxProfitContractUsd: Number.NaN,
    maxLossContractUsd: Number.NaN,
    riskRewardRatio: Number.NaN,
    breakevens: [],
  });

  if (legs.length < 2 || !isPositiveFinite(contractMultiplier)) {
    return nanResult('INVALID_LEGS_OR_MULTIPLIER');
  }

  let midCredit = 0;
  let conservativeCredit = 0;
  const puts: CreditLegCalcInput[] = [];
  const calls: CreditLegCalcInput[] = [];

  for (const leg of legs) {
    if (!isPositiveFinite(leg.strike) || !isPositiveFinite(leg.quantity)) {
      return nanResult('INVALID_LEG_STRIKE_OR_QTY');
    }
    const book = isBilateralBookAcceptable(leg.bid, leg.ask, leg.quoteQuality);
    if (!book.valid) {
      return nanResult(`LEG_${leg.contractType.toUpperCase()}_${String(leg.strike)}_${book.reason ?? 'INVALID_BBO'}`);
    }
    const bid = leg.bid as number;
    const ask = leg.ask as number;
    const mid = 0.5 * (bid + ask);
    const sign = leg.side === 'SELL' ? 1 : -1;
    midCredit += sign * leg.quantity * mid;
    conservativeCredit += sign * leg.quantity * (leg.side === 'SELL' ? bid : ask);
    if (leg.contractType === 'put') puts.push(leg);
    else calls.push(leg);
  }

  let putWidth = 0;
  if (puts.length === 2) {
    const sellP = puts.find((l) => l.side === 'SELL');
    const buyP = puts.find((l) => l.side === 'BUY');
    if (sellP !== undefined && buyP !== undefined && sellP.strike > buyP.strike) {
      putWidth = sellP.strike - buyP.strike;
    }
  }
  let callWidth = 0;
  if (calls.length === 2) {
    const sellC = calls.find((l) => l.side === 'SELL');
    const buyC = calls.find((l) => l.side === 'BUY');
    if (sellC !== undefined && buyC !== undefined && buyC.strike > sellC.strike) {
      callWidth = buyC.strike - sellC.strike;
    }
  }

  const widthPerShare = Math.max(putWidth, callWidth);
  if (!isPositiveFinite(widthPerShare)) {
    return nanResult('UNRESOLVED_SPREAD_WIDTH');
  }

  const maxProfitPerShare = conservativeCredit;
  const maxLossPerShare = widthPerShare - conservativeCredit;
  const riskRewardRatio =
    isPositiveFinite(maxProfitPerShare) && isNonNegativeFinite(maxLossPerShare)
      ? maxLossPerShare / maxProfitPerShare
      : Number.NaN;

  const breakevens: number[] = [];
  if (puts.length === 2 && isFiniteNum(conservativeCredit)) {
    const sellP = puts.find((l) => l.side === 'SELL');
    if (sellP !== undefined) breakevens.push(sellP.strike - conservativeCredit);
  }
  if (calls.length === 2 && isFiniteNum(conservativeCredit)) {
    const sellC = calls.find((l) => l.side === 'SELL');
    if (sellC !== undefined) breakevens.push(sellC.strike + conservativeCredit);
  }
  breakevens.sort((a, b) => a - b);

  return {
    validBboAllLegs: true,
    invalidReason: null,
    midCreditPerShare: midCredit,
    conservativeCreditPerShare: conservativeCredit,
    midCreditContractUsd: midCredit * contractMultiplier,
    conservativeCreditContractUsd: conservativeCredit * contractMultiplier,
    widthPerShare,
    widthContractUsd: widthPerShare * contractMultiplier,
    maxProfitPerShare,
    maxLossPerShare,
    maxProfitContractUsd: maxProfitPerShare * contractMultiplier,
    maxLossContractUsd: maxLossPerShare * contractMultiplier,
    riskRewardRatio,
    breakevens,
  };
}

export interface FlowUniverseTotals {
  readonly totalCallOi: number;
  readonly totalPutOi: number;
  readonly totalCallVolume: number;
  readonly totalPutVolume: number;
  readonly totalLots: number;
  readonly putCallRatioVol: number;
  readonly putCallRatioOi: number;
  readonly maxPainStrike: number;
}

/**
 * Calcula totales globales o por vencimiento sobre el universo completo de strikes ANTES de recortar filas.
 */
export function computeFlowUniverseTotals(
  byStrike: readonly {
    readonly strike: number;
    readonly callOi: number | null;
    readonly putOi: number | null;
    readonly callVolume?: number | null;
    readonly putVolume?: number | null;
  }[],
): FlowUniverseTotals {
  let totalCallOi = 0;
  let totalPutOi = 0;
  let hasCallOi = false;
  let hasPutOi = false;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  let hasCallVol = false;
  let hasPutVol = false;

  const maxPainInputs: { strike: number; contractType: 'call' | 'put'; openInterest: number }[] = [];

  for (const row of byStrike) {
    if (!isPositiveFinite(row.strike)) continue;
    if (isNonNegativeFinite(row.callOi)) {
      totalCallOi += row.callOi;
      hasCallOi = true;
      maxPainInputs.push({ strike: row.strike, contractType: 'call', openInterest: row.callOi });
    }
    if (isNonNegativeFinite(row.putOi)) {
      totalPutOi += row.putOi;
      hasPutOi = true;
      maxPainInputs.push({ strike: row.strike, contractType: 'put', openInterest: row.putOi });
    }
    if (isNonNegativeFinite(row.callVolume)) {
      totalCallVolume += row.callVolume;
      hasCallVol = true;
    }
    if (isNonNegativeFinite(row.putVolume)) {
      totalPutVolume += row.putVolume;
      hasPutVol = true;
    }
  }

  const totalLots =
    hasCallVol || hasPutVol
      ? (hasCallVol ? totalCallVolume : 0) + (hasPutVol ? totalPutVolume : 0)
      : Number.NaN;
  const putCallRatioVol =
    hasCallVol && hasPutVol && totalCallVolume > 0 ? totalPutVolume / totalCallVolume : Number.NaN;
  const putCallRatioOi =
    hasCallOi && hasPutOi && totalCallOi > 0 ? totalPutOi / totalCallOi : Number.NaN;
  const maxPainStrike = computeMaxPainStrike(maxPainInputs);

  return {
    totalCallOi: hasCallOi ? totalCallOi : Number.NaN,
    totalPutOi: hasPutOi ? totalPutOi : Number.NaN,
    totalCallVolume: hasCallVol ? totalCallVolume : Number.NaN,
    totalPutVolume: hasPutVol ? totalPutVolume : Number.NaN,
    totalLots,
    putCallRatioVol,
    putCallRatioOi,
    maxPainStrike,
  };
}

function mapSessionRegime(
  phase: string | null | undefined,
  capturedAtUtcSec: number,
): UsSessionRegime {
  if (phase === 'PRE_MARKET') return 'PRE';
  if (phase === 'RTH') return 'RTH';
  if (phase === 'AFTER_HOURS') return 'POST';
  if (phase === 'CLOSED') return 'CLOSED';
  const inferred = getUsEquitySessionPhase(capturedAtUtcSec);
  if (inferred === 'PRE_MARKET') return 'PRE';
  if (inferred === 'RTH') return 'RTH';
  if (inferred === 'AFTER_HOURS') return 'POST';
  return 'CLOSED';
}

function resolveMedianNumber(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid] ?? null;
  const a = clean[mid - 1];
  const b = clean[mid];
  return a !== undefined && b !== undefined ? Math.floor(0.5 * (a + b)) : null;
}

function isVolAnalyticsExpiryRef(value: unknown): value is UsVolAnalyticsExpiryRef {
  return value !== null && value !== undefined && typeof value === 'object';
}

function buildFlowBlock(params: {
  readonly scope: 'GLOBAL' | 'EXPIRY';
  readonly expirationDate: string | null;
  readonly spot: number;
  readonly summary: ExportUsSnapshotInputDto['exposureSummary'];
  readonly terminalEngines: ExportUsSnapshotInputDto['terminalEngines'];
  readonly fallbackContracts?: readonly UnifiedContractCalcResult[];
}): ExportFlowSummaryBlock {
  const { scope, expirationDate, spot, summary, terminalEngines, fallbackContracts } = params;
  const rawByStrike = summary?.byStrike ?? [];
  const mergedByStrike: {
    readonly strike: number;
    readonly callOi: number | null;
    readonly putOi: number | null;
    readonly callVolume: number | null;
    readonly putVolume: number | null;
    readonly callGex: number | null;
    readonly putGex: number | null;
    readonly netGex: number | null;
    readonly vex: number | null;
    readonly cex: number | null;
  }[] = rawByStrike.map((s) => ({
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
  }));

  if (mergedByStrike.length === 0 && fallbackContracts && fallbackContracts.length > 0) {
    const byK = new Map<
      number,
      { callOi: number | null; putOi: number | null; callVolume: number | null; putVolume: number | null }
    >();
    for (const c of fallbackContracts) {
      const slot = byK.get(c.strike) ?? { callOi: null, putOi: null, callVolume: null, putVolume: null };
      if (c.contractType === 'call') {
        if (c.openInterestKnown) slot.callOi = (slot.callOi ?? 0) + c.openInterest;
        if (c.volumeKnown) slot.callVolume = (slot.callVolume ?? 0) + c.volume;
      } else {
        if (c.openInterestKnown) slot.putOi = (slot.putOi ?? 0) + c.openInterest;
        if (c.volumeKnown) slot.putVolume = (slot.putVolume ?? 0) + c.volume;
      }
      byK.set(c.strike, slot);
    }
    for (const [strike, slot] of [...byK.entries()].sort((a, b) => a[0] - b[0])) {
      mergedByStrike.push({
        strike,
        callOi: slot.callOi,
        putOi: slot.putOi,
        callVolume: slot.callVolume,
        putVolume: slot.putVolume,
        callGex: null,
        putGex: null,
        netGex: null,
        vex: null,
        cex: null,
      });
    }
  }

  const totals = computeFlowUniverseTotals(mergedByStrike);
  const netGex = toFiniteOrNaN(summary?.netGex);
  let callGex = toFiniteOrNaN(summary?.callGex);
  let putGex = toFiniteOrNaN(summary?.putGex);
  if (!Number.isFinite(callGex) || !Number.isFinite(putGex)) {
    let sumC = 0;
    let sumP = 0;
    let hasC = false;
    let hasP = false;
    for (const row of mergedByStrike) {
      if (isFiniteNum(row.callGex)) {
        sumC += row.callGex;
        hasC = true;
      }
      if (isFiniteNum(row.putGex)) {
        sumP += row.putGex;
        hasP = true;
      }
    }
    if (!Number.isFinite(callGex) && hasC) callGex = sumC;
    if (!Number.isFinite(putGex) && hasP) putGex = sumP;
  }

  const callWallStrike = toFiniteOrNaN(summary?.callWallStrike);
  const putWallStrike = toFiniteOrNaN(summary?.putWallStrike);
  const zeroGammaSpot = toFiniteOrNaN(summary?.gammaFlipSpot);
  const charmPinStrike = toFiniteOrNaN(summary?.charmPinStrike);
  const gexCharmPinStrike =
    scope === 'GLOBAL'
      ? toFiniteOrNaN(terminalEngines?.gexCharmPin?.gexCharmPinStrike)
      : Number.NaN;
  const usableContracts = summary?.quality?.usableContracts ?? 0;
  const totalContracts = summary?.quality?.totalContracts ?? usableContracts;
  const usableOpenInterest = summary?.quality?.usableOpenInterest ?? 0;

  const regimeReport = classifyDealerGammaRegimeFromSummary({
    spot,
    netGex,
    callGex,
    putGex,
    callWallStrike,
    putWallStrike,
    gammaFlipSpot: zeroGammaSpot,
    gammaFlipStatus:
      summary?.gammaFlipStatus === 'unique' ||
      summary?.gammaFlipStatus === 'no_crossing' ||
      summary?.gammaFlipStatus === 'multiple_crossings' ||
      summary?.gammaFlipStatus === 'indeterminate'
        ? summary.gammaFlipStatus
        : 'indeterminate',
    usableContracts,
    usableOpenInterest,
  });

  const sortedStrikes = mergedByStrike.slice().sort((a, b) => a.strike - b.strike);
  let atmStrike = Number.NaN;
  if (isPositiveFinite(spot) && sortedStrikes.length > 0) {
    let bestDist = Number.POSITIVE_INFINITY;
    for (const row of sortedStrikes) {
      const dist = Math.abs(row.strike - spot);
      if (dist < bestDist) {
        bestDist = dist;
        atmStrike = row.strike;
      }
    }
  }

  const allStrikes: ExportStrikeFlowRow[] = sortedStrikes.map((row) => {
    const tags: string[] = [];
    if (Number.isFinite(atmStrike) && Math.abs(row.strike - atmStrike) <= 1e-6) tags.push('ATM');
    if (Number.isFinite(callWallStrike) && Math.abs(row.strike - callWallStrike) <= 1e-6) tags.push('CALL_WALL');
    if (Number.isFinite(putWallStrike) && Math.abs(row.strike - putWallStrike) <= 1e-6) tags.push('PUT_WALL');
    if (Number.isFinite(totals.maxPainStrike) && Math.abs(row.strike - totals.maxPainStrike) <= 1e-6) tags.push('MAX_PAIN');
    if (Number.isFinite(charmPinStrike) && Math.abs(row.strike - charmPinStrike) <= 1e-6) tags.push('CHARM_PIN');
    if (Number.isFinite(gexCharmPinStrike) && Math.abs(row.strike - gexCharmPinStrike) <= 1e-6) tags.push('GEX_PIN');
    const callOiKnown = isNonNegativeFinite(row.callOi);
    const putOiKnown = isNonNegativeFinite(row.putOi);
    const callVolKnown = isNonNegativeFinite(row.callVolume);
    const putVolKnown = isNonNegativeFinite(row.putVolume);
    return {
      strike: row.strike,
      tags,
      callOi: callOiKnown ? row.callOi : Number.NaN,
      callOiKnown,
      putOi: putOiKnown ? row.putOi : Number.NaN,
      putOiKnown,
      callVolume: callVolKnown ? row.callVolume : Number.NaN,
      callVolKnown,
      putVolume: putVolKnown ? row.putVolume : Number.NaN,
      putVolKnown,
      callGex: toFiniteOrNaN(row.callGex),
      putGex: toFiniteOrNaN(row.putGex),
      netGex: toFiniteOrNaN(row.netGex),
      vex: toFiniteOrNaN(row.vex),
      cex: toFiniteOrNaN(row.cex),
    };
  });

  const orderFlow = terminalEngines?.orderFlow ?? null;
  const agresion = terminalEngines?.agresionTicks ?? orderFlow?.agresionTicks ?? null;

  return {
    scope,
    expirationDate,
    regime: regimeReport.regime,
    regimeLabel: regimeReport.headline,
    creditStrategySignal: regimeReport.creditStrategySignal,
    spotVsZeroGamma: regimeReport.spotVsZeroGamma,
    distanceToZeroGammaPct: regimeReport.distanceToZeroGammaPct,
    netGex,
    callGex,
    putGex,
    netVex: toFiniteOrNaN(summary?.netVex),
    netCex: toFiniteOrNaN(summary?.netCex),
    callWallStrike,
    putWallStrike,
    zeroGammaSpot,
    zeroGammaStatus: summary?.gammaFlipStatus ?? 'indeterminate',
    maxPainStrike: totals.maxPainStrike,
    charmPinStrike,
    gexCharmPinStrike,
    putCallRatioVol: totals.putCallRatioVol,
    putCallRatioOi: totals.putCallRatioOi,
    totalCallVolume: totals.totalCallVolume,
    totalPutVolume: totals.totalPutVolume,
    totalLots: totals.totalLots,
    totalCallOi: totals.totalCallOi,
    totalPutOi: totals.totalPutOi,
    netDirectionalPremiumUsd: toFiniteOrNaN(orderFlow?.netDirectionalPremiumUsd),
    aggressionDirection: agresion?.direction ?? 'NO_DATA',
    aggressionNetBiasPct: toFiniteOrNaN(agresion?.netBiasPct),
    aggressionMethod: agresion?.method ?? null,
    deltaFlowShares: toFiniteOrNaN(orderFlow?.netDeltaShares),
    isFlowSnapshotApprox: true,
    usableContracts,
    totalContracts,
    usableOpenInterest,
    coverage: summary?.trace?.coverage ?? (usableContracts > 0 ? 'partial' : 'unknown'),
    engineExpirationDates: summary?.trace?.engineExpirationDates ?? [],
    allStrikes,
  };
}

function findKeyLevelPrice(
  keyLevels: readonly { readonly name: string; readonly price: number | null }[] | undefined,
  name: string,
): number {
  const hit = keyLevels?.find((k) => k.name === name);
  return toFiniteOrNaN(hit?.price);
}

/**
 * Construye el DTO canónico congelado `UsOptionsIntelligenceSnapshotV1` desde datos ya recolectados.
 */
export function buildUsOptionsIntelligenceSnapshot(
  input: RawUsOptionsSnapshotInput,
): UsOptionsIntelligenceSnapshotV1 {
  const { request, capturedAtUtcSec, usSnapshot, expiries, barsResponse, barsTimeframe, barsAsOfUtcSec, usVolSurface, liveSpotQuote, additionalRequestsCount } = input;
  const ticker = request.ticker.trim().toUpperCase();
  if (ticker === '' || ticker.startsWith('AR:')) {
    throw new Error(`Invalid US ticker for export: ${request.ticker}`);
  }
  const capturedAt = formatDualTimezoneTimestamp(capturedAtUtcSec);

  const unifiedQuote =
    usSnapshot.marketContext?.unifiedQuotes?.find(
      (q) => q.ticker.trim().toUpperCase() === ticker,
    ) ?? null;

  const valuationSpot = firstPositiveFinite(
    usSnapshot.exposureSummary?.trace?.valuationSpot,
    usSnapshot.envelope?.snapshot?.metrics?.spot,
    unifiedQuote?.price,
    liveSpotQuote?.price,
  );

  const liveSpotAtCapture = firstPositiveFinite(liveSpotQuote?.price, valuationSpot);
  const spotDriftPct =
    isPositiveFinite(valuationSpot) && isPositiveFinite(liveSpotAtCapture)
      ? ((liveSpotAtCapture - valuationSpot) / valuationSpot) * 100
      : Number.NaN;

  const dayOpen = firstPositiveFinite(liveSpotQuote?.dayOpen, unifiedQuote?.dayOpen);
  const previousClose = firstPositiveFinite(
    liveSpotQuote?.previousClose,
    unifiedQuote?.previousClose,
    findKeyLevelPrice(usSnapshot.envelope?.snapshot?.keyLevels, 'PDC'),
  );
  const dayHigh = firstPositiveFinite(liveSpotQuote?.dayHigh, unifiedQuote?.dayHigh);
  const dayLow = firstPositiveFinite(liveSpotQuote?.dayLow, unifiedQuote?.dayLow);
  const sessionRangeUsd =
    isPositiveFinite(dayHigh) && isPositiveFinite(dayLow) && dayHigh >= dayLow
      ? dayHigh - dayLow
      : Number.NaN;

  const rawChangeAbs = firstFinite(unifiedQuote?.change);
  const changeAbs = Number.isFinite(rawChangeAbs)
    ? rawChangeAbs
    : isPositiveFinite(liveSpotAtCapture) && isPositiveFinite(previousClose)
      ? liveSpotAtCapture - previousClose
      : Number.NaN;
  const rawChangePct = firstFinite(unifiedQuote?.changePct);
  const changePct = Number.isFinite(rawChangePct)
    ? rawChangePct
    : isFiniteNum(changeAbs) && isPositiveFinite(previousClose)
      ? (changeAbs / previousClose) * 100
      : Number.NaN;

  const atr14d = firstPositiveFinite(
    usSnapshot.terminalEngines?.atr14d,
    usSnapshot.openingAuction?.atr14d,
  );
  const atrTravelledPct = computeAtrTravelledPct(dayHigh, dayLow, atr14d);

  const rawSpotBid = liveSpotQuote?.bid ?? unifiedQuote?.bid ?? null;
  const rawSpotAsk = liveSpotQuote?.ask ?? unifiedQuote?.ask ?? null;
  const spotBookOk = isPositiveFinite(rawSpotBid) && isPositiveFinite(rawSpotAsk) && rawSpotAsk >= rawSpotBid;
  const spotBid = spotBookOk ? rawSpotBid : Number.NaN;
  const spotAsk = spotBookOk ? rawSpotAsk : Number.NaN;
  const spotSpreadPct =
    spotBookOk && spotBid + spotAsk > 0
      ? ((spotAsk - spotBid) / (0.5 * (spotBid + spotAsk))) * 100
      : Number.NaN;

  const emas: {
    readonly period: 9 | 21 | 50 | 200;
    readonly timeframe: string;
    readonly value: number;
    readonly distanceSpotPct: number;
  }[] = [];
  const tfLabel = barsTimeframe ?? 'N/D';
  const cleanBars: Bar[] = (barsResponse?.bars ?? [])
    .filter(
      (b) =>
        Number.isFinite(b.time) &&
        isPositiveFinite(b.open) &&
        isPositiveFinite(b.high) &&
        isPositiveFinite(b.low) &&
        isPositiveFinite(b.close) &&
        isNonNegativeFinite(b.volume),
    )
    .map((b) => ({
      time: Math.floor(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      ...(isPositiveFinite(b.vw) ? { vw: b.vw } : {}),
    }));

  const snapshotEma21 = usSnapshot.microstructure?.mtf?.ema21_15m;
  if (cleanBars.length > 0 && barsTimeframe !== null) {
    const closes = cleanBars.map((b) => b.close);
    for (const period of [9, 21, 50, 200] as const) {
      const series = calculateEma(closes, period);
      const lastVal = series.length > 0 ? series[series.length - 1] : Number.NaN;
      emas.push({
        period,
        timeframe: tfLabel,
        value: toFiniteOrNaN(lastVal),
        distanceSpotPct: computeDistancePct(toFiniteOrNaN(lastVal), valuationSpot),
      });
    }
  } else if (isPositiveFinite(snapshotEma21)) {
    emas.push({
      period: 21,
      timeframe: '15m (snapshot)',
      value: snapshotEma21,
      distanceSpotPct: computeDistancePct(snapshotEma21, valuationSpot),
    });
  }

  const smas: {
    readonly period: 50 | 200;
    readonly timeframe: string;
    readonly value: number;
    readonly distanceSpotPct: number;
  }[] = [];
  const sma50Val = usSnapshot.microstructure?.mtf?.sma50_4h;
  if (isPositiveFinite(sma50Val)) {
    smas.push({ period: 50, timeframe: '4H', value: sma50Val, distanceSpotPct: computeDistancePct(sma50Val, valuationSpot) });
  }
  const sma200Val = usSnapshot.microstructure?.mtf?.sma200_1d;
  if (isPositiveFinite(sma200Val)) {
    smas.push({ period: 200, timeframe: '1D', value: sma200Val, distanceSpotPct: computeDistancePct(sma200Val, valuationSpot) });
  }

  // Session VWAP
  let sessionVwapVal = Number.NaN;
  const sessionVwapSupported = barsResponse?.overlays.sessionVwapSupported ?? false;
  if (cleanBars.length > 0 && barsResponse !== null && sessionVwapSupported) {
    const svOverlay = barsResponse.overlays.sessionVwap;
    const fromOverlay = svOverlay.length === cleanBars.length ? svOverlay[svOverlay.length - 1] : null;
    if (isPositiveFinite(fromOverlay)) {
      sessionVwapVal = fromOverlay;
    } else {
      const computed = computeSessionVwap(cleanBars, {
        market: 'EQUITY',
        barSeconds: barsResponse.barSeconds || (barsTimeframe === '1h' ? 3600 : 900),
      });
      sessionVwapVal = toFiniteOrNaN(computed.points[computed.points.length - 1]?.vwap);
    }
  }

  // AVWAP Inicio de Mes
  let avwapMonthStart: ExportAvwapReference | null = null;
  const lastCleanBar = cleanBars[cleanBars.length - 1];
  if (lastCleanBar !== undefined) {
    const lastEt = getMarketParts(lastCleanBar.time, 'EQUITY');
    const anchorIdx = cleanBars.findIndex((b) => {
      const p = getMarketParts(b.time, 'EQUITY');
      return p.year === lastEt.year && p.month === lastEt.month;
    });
    if (anchorIdx >= 0) {
      const hasPriorBar = anchorIdx > 0;
      const pts = calculateAnchoredVwap(cleanBars, anchorIdx);
      const lastAvwap = pts.length > 0 ? pts[pts.length - 1]?.vwap : Number.NaN;
      const anchorTime = cleanBars[anchorIdx]?.time;
      const anchorDate = anchorTime ? getMarketParts(anchorTime, 'EQUITY').dateKey : null;
      avwapMonthStart = {
        label: 'AVWAP Inicio Mes',
        kind: 'MONTH_START',
        anchorDate,
        value: toFiniteOrNaN(lastAvwap),
        distanceSpotPct: computeDistancePct(toFiniteOrNaN(lastAvwap), valuationSpot),
        coverage: hasPriorBar ? 'complete' : 'partial',
      };
    }
  }

  const autoAvwaps: ExportAvwapReference[] = (barsResponse?.autoAvwapAnchors ?? []).map((a) => ({
    label:
      a.role === 'SUPPORT'
        ? 'SUP'
        : a.role === 'RESISTANCE'
          ? 'RES'
          : `EVT${a.eventLabel ? ` (${a.eventLabel})` : ''}`,
    kind: a.role,
    anchorDate: isPositiveFinite(a.anchorTimeSec)
      ? getMarketParts(Math.floor(a.anchorTimeSec), 'EQUITY').dateKey
      : null,
    value: toFiniteOrNaN(a.currentAvwap),
    distanceSpotPct: computeDistancePct(toFiniteOrNaN(a.currentAvwap), valuationSpot),
    coverage: '1D_380R',
  }));

  const vp = usSnapshot.terminalEngines?.volumeProfile ?? null;
  const vpPoc = toFiniteOrNaN(vp?.poc);
  const vpVah = toFiniteOrNaN(vp?.vah);
  const vpVal = toFiniteOrNaN(vp?.val);
  const sortNearestPrices = (bins: readonly { readonly price: number | null }[] | undefined): number[] =>
    (bins ?? [])
      .map((b) => b.price)
      .filter((p): p is number => isPositiveFinite(p))
      .sort((a, b) => Math.abs(a - valuationSpot) - Math.abs(b - valuationSpot))
      .slice(0, 3);

  const nakedPocs = (usSnapshot.terminalEngines?.nakedPocs?.activeNakedPocs ?? [])
    .filter((np) => isPositiveFinite(np.sessionPoc))
    .slice()
    .sort((a, b) => Math.abs((a.sessionPoc ?? 0) - valuationSpot) - Math.abs((b.sessionPoc ?? 0) - valuationSpot))
    .slice(0, MAX_NAKED_POCS)
    .map((np) => ({
      sessionDate: np.sessionDate,
      price: np.sessionPoc as number,
      distanceSpotPct: computeDistancePct(np.sessionPoc as number, valuationSpot),
    }));

  const activeFvgs: ExportFvgZone[] = (usSnapshot.terminalEngines?.fvgs?.activeFvgs ?? [])
    .filter((f) => isPositiveFinite(f.gapLow) && isPositiveFinite(f.gapHigh) && isPositiveFinite(f.consequentEncroachment))
    .slice()
    .sort(
      (a, b) =>
        Math.abs((a.consequentEncroachment ?? 0) - valuationSpot) -
        Math.abs((b.consequentEncroachment ?? 0) - valuationSpot),
    )
    .slice(0, MAX_ACTIVE_FVGS)
    .map((f) => ({
      type: f.type === 'BULLISH_FVG' ? 'BULLISH_FVG' : 'BEARISH_FVG',
      gapLow: f.gapLow as number,
      gapHigh: f.gapHigh as number,
      consequentEncroachment: f.consequentEncroachment as number,
      distanceSpotPct: computeDistancePct(f.consequentEncroachment as number, valuationSpot),
    }));

  const oa = usSnapshot.openingAuction ?? null;
  const keyLevelsRaw = usSnapshot.envelope?.snapshot?.keyLevels;
  const cvdVal = toFiniteOrNaN(usSnapshot.microstructure?.cvd?.currentSessionCvd);
  const cvdSlope = toFiniteOrNaN(usSnapshot.terminalEngines?.cvdSlopeSign);
  const cvdBias =
    Number.isFinite(cvdSlope) && cvdSlope > 0
      ? 'BULLISH'
      : Number.isFinite(cvdSlope) && cvdSlope < 0
        ? 'BEARISH'
        : Number.isFinite(cvdVal) && cvdVal > 0
          ? 'BULLISH'
          : Number.isFinite(cvdVal) && cvdVal < 0
            ? 'BEARISH'
            : 'NEUTRAL';

  // Expiries + Chain + Flow + Spreads + Volatility
  const suite = usSnapshot.terminalEngines?.volAnalyticsSuite ?? null;
  const rv20Pct = toFiniteOrNaN(
    suite?.rvWindows?.rv20?.currentPct ??
      suite?.historicalConditional?.latestRv20Pct ??
      usSnapshot.envelope?.metrics?.realizedVol20d?.value ??
      usSnapshot.envelope?.snapshot?.metrics?.realizedVolAnnualized,
  );
  const rv60Pct = toFiniteOrNaN(
    suite?.rvWindows?.rv60?.currentPct ??
      suite?.historicalConditional?.latestRv60Pct ??
      usSnapshot.envelope?.metrics?.realizedVol60d?.value ??
      usSnapshot.envelope?.snapshot?.metrics?.rvCenteredAnnualized,
  );
  const rv120Pct = toFiniteOrNaN(suite?.rvWindows?.rv120?.currentPct);
  const rv23RefPct = toFiniteOrNaN(suite?.historicalConditional?.latestRv23Pct);
  const volSummaryIv30d = usSnapshot.volSurfaceSummary?.iv30d;
  const iv30dPct = isPositiveFinite(volSummaryIv30d)
    ? volSummaryIv30d * 100
    : toFiniteOrNaN(usSnapshot.envelope?.snapshot?.metrics?.iv30d);

  const oratsIvRank =
    usVolSurface?.ivRank && usVolSurface.ivRank.status !== 'UNAVAILABLE'
      ? usVolSurface.ivRank.row
      : null;
  const oratsTradeDate =
    usVolSurface?.surface && usVolSurface.surface.status !== 'UNAVAILABLE'
      ? (usVolSurface.surface.tradeDate ?? oratsIvRank?.tradeDate ?? null)
      : (oratsIvRank?.tradeDate ?? null);

  // Determine front expiry in suite/surface for strict Q vs P horizon guard
  const frontSliceExp = usSnapshot.volSurfaceSummary?.frontSlice ?? usSnapshot.volSurfaceSummary?.slices?.[0] ?? null;
  const frontExpiryDate = frontSliceExp?.expirationDate ?? null;
  const frontDte = frontExpiryDate !== null
    ? calendarDteEt(frontExpiryDate, capturedAtUtcSec * 1_000)
    : Number.NaN;

  const currentEtMonthIdx = getMarketParts(capturedAtUtcSec, 'EQUITY').month - 1;
  const rawSeasonality = suite?.historicalConditional?.seasonalityMonths?.[currentEtMonthIdx] ?? null;
  const currentMonthSeasonality =
    rawSeasonality !== null
      ? {
          monthLabel: rawSeasonality.monthLabel,
          monthsSampled: rawSeasonality.monthsSampled,
          avgMonthlyReturnPct: toFiniteOrNaN(rawSeasonality.avgMonthlyReturnPct),
          annualizedVolPct: toFiniteOrNaN(rawSeasonality.annualizedVolPct),
          positiveMonthRatePct: toFiniteOrNaN(rawSeasonality.positiveMonthRatePct),
        }
      : null;

  const rawQuintile = suite?.historicalConditional?.buckets?.find((b) => b.isCurrent) ?? null;
  const currentQuintile =
    rawQuintile !== null
      ? {
          label: rawQuintile.label,
          rangeLabel: rawQuintile.rangeLabel,
          occurrences: rawQuintile.occurrences,
          avgVolChange30dPts: toFiniteOrNaN(rawQuintile.avgVolChange30dPts),
          avgUnderlyingReturn30dPct: toFiniteOrNaN(rawQuintile.avgUnderlyingReturn30dPct),
          pctVolDecreased: toFiniteOrNaN(rawQuintile.pctVolDecreased),
        }
      : null;

  const chainsByExpiry: Record<string, {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly calls: readonly UnifiedContractCalcResult[];
    readonly puts: readonly UnifiedContractCalcResult[];
  }> = {};
  const flowByExpiry: Record<string, ExportFlowSummaryBlock> = {};
  const volByExpiry: Record<string, ExportExpiryVolatilityBlock> = {};
  const spreadsByExpiry: Record<string, ExportSpreadsBlock> = {};
  const metadataByExpiry: Record<string, {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly expiryUtcSec: number;
    readonly sourceKind: 'EXPIRY_ENDPOINT' | 'SNAPSHOT_PRELOADED';
  }> = {};

  const allQuoteTimes: number[] = [];
  const expDatesSelected = request.expirations.slice(0, 2);

  for (const expBundle of expiries) {
    const expDate = expBundle.expirationDate;
    if (!expDatesSelected.includes(expDate)) continue;
    const dteEt = calendarDteEt(expDate, capturedAtUtcSec * 1_000);
    const dte = Number.isFinite(dteEt) ? dteEt : expBundle.daysToExpiry;
    metadataByExpiry[expDate] = {
      expirationDate: expDate,
      daysToExpiry: dte,
      expiryUtcSec: expBundle.expiryUtcSec,
      sourceKind: expBundle.sourceKind,
    };

    const gexByStrike = new Map<number, { callGex: number | null; putGex: number | null }>();
    for (const s of expBundle.exposureSummary?.byStrike ?? []) {
      gexByStrike.set(s.strike, { callGex: s.callGex, putGex: s.putGex });
    }

    const calls: UnifiedContractCalcResult[] = [];
    const puts: UnifiedContractCalcResult[] = [];
    for (const row of expBundle.contracts) {
      if (isPositiveFinite(row.quoteTimestampUtcSec)) {
        allQuoteTimes.push(Math.floor(row.quoteTimestampUtcSec));
      }
      const strikeGexSlot = gexByStrike.get(row.strike);
      const calc = computeUnifiedContractMetrics({
        ticker: row.ticker,
        contractType: row.contractType,
        strike: row.strike,
        spot: valuationSpot,
        bid: row.bid,
        ask: row.ask,
        lastPrice: row.lastPrice,
        volume: row.volume,
        openInterest: row.openInterest,
        ivDecimal: row.ownIv ?? row.providerIv ?? null,
        ivSource: row.ivSource,
        delta: row.delta,
        gamma: row.gamma,
        thetaDaily: row.thetaDaily,
        vegaPer1Pct: row.vegaPer1Pct,
        strikeGex: row.contractType === 'call' ? (strikeGexSlot?.callGex ?? null) : (strikeGexSlot?.putGex ?? null),
        sharesPerContract: row.sharesPerContract ?? null,
        exerciseStyle: row.exerciseStyle ?? null,
        settlementType: row.settlementType ?? null,
        valuationModel: row.valuationModel ?? null,
        quoteQuality: row.quoteQuality ?? null,
        quoteSource: row.quoteSource ?? null,
        quoteTimestampUtcSec: row.quoteTimestampUtcSec ?? null,
      });
      if (row.contractType === 'call') calls.push(calc);
      else puts.push(calc);
    }
    calls.sort((a, b) => a.strike - b.strike);
    puts.sort((a, b) => a.strike - b.strike);
    chainsByExpiry[expDate] = { expirationDate: expDate, daysToExpiry: dte, calls, puts };

    const expFlow = buildFlowBlock({
      scope: 'EXPIRY',
      expirationDate: expDate,
      spot: valuationSpot,
      summary: expBundle.exposureSummary ?? usSnapshot.exposureSummary ?? null,
      terminalEngines: usSnapshot.terminalEngines ?? null,
      fallbackContracts: [...calls, ...puts],
    });
    flowByExpiry[expDate] = expFlow;

    // Volatility block for this expiry
    const rawSuiteExp = suite?.expiriesByCode[expDate];
    const expSuite =
      expBundle.volAnalyticsExpiry ??
      (isVolAnalyticsExpiryRef(rawSuiteExp) ? rawSuiteExp : null);
    const slice = expBundle.volSlice ?? usSnapshot.volSurfaceSummary?.slices?.find((s) => s.expirationDate === expDate) ?? null;
    const expRate = firstFinite(slice?.rate, suite?.rateContinuous, 0.04);
    const expDiv = firstFinite(slice?.dividendYield, suite?.dividendYield, 0);

    const smileAtmPct = toFiniteOrNaN(expSuite?.smileOtmOnly?.atmIvPct);
    const sliceAtmPct = isPositiveFinite(slice?.ivAtm) ? slice.ivAtm * 100 : Number.NaN;
    const ivAtmPct = Number.isFinite(smileAtmPct) ? smileAtmPct : sliceAtmPct;
    const ivAtmSource = expSuite?.activeExpiryVrp?.ivSource ?? (Number.isFinite(ivAtmPct) ? 'SLICE_ATM' : 'NO_DATA');

    // Canonical Skew 25Δ: ALWAYS IV_25P - IV_25C!
    let iv25PutPct = toFiniteOrNaN(expSuite?.smileOtmOnly?.iv25DeltaPutPct);
    let iv25CallPct = toFiniteOrNaN(expSuite?.smileOtmOnly?.iv25DeltaCallPct);
    if ((!Number.isFinite(iv25PutPct) || !Number.isFinite(iv25CallPct)) && slice !== null) {
      const sPut = isPositiveFinite(slice.delta25PutIv) ? slice.delta25PutIv * 100 : Number.NaN;
      const sCall = isPositiveFinite(slice.delta25CallIv) ? slice.delta25CallIv * 100 : Number.NaN;
      if (Number.isFinite(sPut) && Number.isFinite(sCall)) {
        iv25PutPct = sPut;
        iv25CallPct = sCall;
      }
    }

    let computedSkewRegime: ReturnType<typeof computeActiveExpirySkewAndIvRegime> | null = null;
    if ((!Number.isFinite(iv25PutPct) || !Number.isFinite(iv25CallPct) || !oratsIvRank) && isPositiveFinite(valuationSpot)) {
      const tExpY = Math.max(MIN_EXPECTED_MOVE_T_YEARS, dte / 365);
      const histRvDecSeries = (suite?.historicalConditional?.historySeries ?? [])
        .map((pt) => (isPositiveFinite(pt.rvPct) ? pt.rvPct / 100 : null))
        .filter((v): v is number => v !== null);
      computedSkewRegime = computeActiveExpirySkewAndIvRegime({
        spot: valuationSpot,
        timeToExpiryYears: tExpY,
        rate: Number.isFinite(expRate) ? expRate : 0,
        dividendYield: Number.isFinite(expDiv) ? expDiv : 0,
        historicalIv1y: histRvDecSeries,
        currentIvOverride: Number.isFinite(ivAtmPct) ? ivAtmPct / 100 : null,
        contracts: [...calls, ...puts].map((c) => ({
          strike: c.strike,
          contractType: c.contractType,
          iv: Number.isFinite(c.ivPct) ? c.ivPct / 100 : null,
          delta: Number.isFinite(c.delta) ? c.delta : null,
        })),
      });
      if (!Number.isFinite(iv25PutPct) && computedSkewRegime.iv25PutPct !== null) {
        iv25PutPct = computedSkewRegime.iv25PutPct;
      }
      if (!Number.isFinite(iv25CallPct) && computedSkewRegime.iv25CallPct !== null) {
        iv25CallPct = computedSkewRegime.iv25CallPct;
      }
    }

    const skew25PutMinusCallPts = computeSkew25PutMinusCallPts(iv25PutPct, iv25CallPct);
    const rvRefPct = Number.isFinite(rv23RefPct) ? rv23RefPct : rv20Pct;
    const rvRefLabel = Number.isFinite(rv23RefPct) ? 'RV23d' : 'RV20d';
    const rawVrpActive = expSuite?.activeExpiryVrp?.vrpActiveExpiryPts;
    const vrpPts = isFiniteNum(rawVrpActive)
      ? rawVrpActive
      : computeVrpVolDiffPts(ivAtmPct, rvRefPct);

    const oratsIvr = oratsIvRank?.ivRank1y;
    const suiteIvr = expSuite?.activeExpiryVrp?.ivRankActiveExpiry;
    const ivRank = firstFinite(oratsIvr, suiteIvr, computedSkewRegime?.ivr);
    const ivRankSource = isFiniteNum(oratsIvr)
      ? `ORATS 1Y (${oratsTradeDate ?? 'fecha N/D'})`
      : Number.isFinite(ivRank)
        ? 'Proxy RV 1Y'
        : 'N/D';

    const oratsIvp = oratsIvRank?.ivPct1y;
    const suiteIvp = expSuite?.activeExpiryVrp?.ivPercentileActiveExpiry;
    const ivPercentile = firstFinite(oratsIvp, suiteIvp, computedSkewRegime?.ivp);
    const ivPercentileSource = isFiniteNum(oratsIvp)
      ? `ORATS 1Y (${oratsTradeDate ?? 'fecha N/D'})`
      : Number.isFinite(ivPercentile)
        ? 'Proxy RV 1Y'
        : 'N/D';

    // Expected Move ±1σ / ±2σ
    const tYears = dte > 0 ? dte / 365 : MIN_EXPECTED_MOVE_T_YEARS;
    const cone = expSuite?.expectedCone ?? null;
    const coneMove1Sigma = cone?.horizonMove1SigmaPct;
    const em1SigmaPct = isPositiveFinite(coneMove1Sigma)
      ? coneMove1Sigma
      : Number.isFinite(ivAtmPct)
        ? (ivAtmPct / 100) * Math.sqrt(tYears) * 100
        : Number.NaN;
    const em1SigmaUsd =
      isPositiveFinite(valuationSpot) && isPositiveFinite(ivAtmPct)
        ? expectedMoveSigma(valuationSpot, ivAtmPct / 100, tYears)
        : Number.NaN;
    const upper1Sigma = isPositiveFinite(cone?.upper1Sigma)
      ? cone.upper1Sigma
      : isPositiveFinite(valuationSpot) && Number.isFinite(em1SigmaPct)
        ? valuationSpot * Math.exp(em1SigmaPct / 100)
        : Number.NaN;
    const lower1Sigma = isPositiveFinite(cone?.lower1Sigma)
      ? cone.lower1Sigma
      : isPositiveFinite(valuationSpot) && Number.isFinite(em1SigmaPct)
        ? valuationSpot * Math.exp(-em1SigmaPct / 100)
        : Number.NaN;
    const upper2Sigma = isPositiveFinite(cone?.upper2Sigma)
      ? cone.upper2Sigma
      : isPositiveFinite(valuationSpot) && Number.isFinite(em1SigmaPct)
        ? valuationSpot * Math.exp((2 * em1SigmaPct) / 100)
        : Number.NaN;
    const lower2Sigma = isPositiveFinite(cone?.lower2Sigma)
      ? cone.lower2Sigma
      : isPositiveFinite(valuationSpot) && Number.isFinite(em1SigmaPct)
        ? valuationSpot * Math.exp((-2 * em1SigmaPct) / 100)
        : Number.NaN;
    const em2SigmaPct = Number.isFinite(em1SigmaPct) ? em1SigmaPct * 2 : Number.NaN;
    const em2SigmaUsd = Number.isFinite(em1SigmaUsd) ? em1SigmaUsd * 2 : Number.NaN;
    const emStraddleUsd = toFiniteOrNaN(expBundle.exposureSummary?.expectedMove?.straddleMove);

    // Q vs P with strict horizon comparison & explicit Swing front-expiry note
    const qDist = usSnapshot.terminalEngines?.qDistribution ?? null;
    const pDist = usSnapshot.terminalEngines?.pDistribution ?? null;
    const pqDiv = usSnapshot.terminalEngines?.pqDivergence ?? null;
    const pHorizonDays = Math.max(1, Number.isFinite(frontDte) ? frontDte : 1);
    const comparableHorizon =
      qDist?.status === 'OK' &&
      pDist?.status === 'OK' &&
      frontExpiryDate !== null &&
      expDate === frontExpiryDate &&
      Number.isFinite(dte) &&
      Math.max(1, dte) === pHorizonDays;
    const note =
      expDate !== frontExpiryDate && request.mode === 'swing'
        ? `Las densidades neutral al riesgo (Q) y empírica (P) corresponden al vencimiento front (${frontExpiryDate ?? 'N/D'}, ${Number.isFinite(frontDte) ? `${String(frontDte)} DTE` : 'N/D'}); no son equivalentes al horizonte Swing ${expDate} (${String(dte)} DTE) y la comparación directa Q vs P queda bloqueada (N/D). La densidad Q no constituye una predicción empírica directa.`
        : comparableHorizon
          ? `Densidades Q (Breeden-Litzenberger PCHIP) y P (histórica H=${String(pHorizonDays)}d) alineadas al vencimiento front (${expDate}). La densidad Q es medida neutral al riesgo bajo no-arbitraje, no una predicción empírica directa.`
          : `Horizonte P (${String(pHorizonDays)}d) y vencimiento ${expDate} (${String(dte)} DTE) no equivalentes; comparación Q vs P no aplicable. La densidad Q corresponde al vencimiento front (${frontExpiryDate ?? 'N/D'}) y no constituye predicción empírica directa.`;

    volByExpiry[expDate] = {
      expirationDate: expDate,
      daysToExpiry: dte,
      ivAtmPct,
      ivAtmSource,
      ivRv20Ratio: computeIvRvRatio(ivAtmPct, rv20Pct),
      vrpPts,
      vrpDefinition: 'IV_MINUS_RV_VOL_PTS',
      vrpRvRefLabel: rvRefLabel,
      ivRank,
      ivRankSource,
      ivPercentile,
      ivPercentileSource,
      iv25PutPct,
      iv25CallPct,
      skew25PutMinusCallPts,
      em1SigmaUsd,
      em1SigmaPct,
      upper1Sigma,
      lower1Sigma,
      em2SigmaUsd,
      em2SigmaPct,
      upper2Sigma,
      lower2Sigma,
      emStraddleUsd,
      emMethodology: `Lognormal S*IV_ATM*sqrt(T) y bandas S*exp(±k*σ*√T) con T=${dte > 0 ? `${String(dte)}/365` : 'minIntraday'}`,
      relativeStructureCosts: (expSuite?.ratiosAndStructures?.structures ?? []).map((st) => ({
        id: st.id,
        name: st.name,
        legsLabel: st.legsLabel,
        costPctOfMaxProfit: toFiniteOrNaN(st.costPctOfMaxProfit),
        historicalPercentile: toFiniteOrNaN(st.bs2002HistoricalPercentile),
        historicalMedianPct: toFiniteOrNaN(st.bs2002HistoricalMedianPct),
        obs: st.bs2002HistoricalObs ?? 0,
      })),
      qAndP: {
        frontExpiryDate,
        frontDte,
        correspondsToFrontOnly: true,
        comparableHorizon,
        note,
        qMean: toFiniteOrNaN(qDist?.meanQ),
        qStdDev: toFiniteOrNaN(qDist?.stdDevQ),
        qSkewness: toFiniteOrNaN(qDist?.skewnessQ),
        qExcessKurtosis: toFiniteOrNaN(qDist?.excessKurtosisQ),
        pHorizonDays,
        pSamples: pDist?.horizonSamplesCount ?? 0,
        pTailFreqPct: toFiniteOrNaN(pDist?.tailFrequencyPct),
        pOvernightSharePct: isFiniteNum(pDist?.overnightVarianceShare)
          ? pDist.overnightVarianceShare * 100
          : Number.NaN,
        comparisons: comparableHorizon
          ? (pqDiv?.levels ?? []).map((lv) => ({
              label: lv.label,
              price: toFiniteOrNaN(lv.price),
              direction: lv.direction,
              probQ: toFiniteOrNaN(lv.probQ),
              probP: toFiniteOrNaN(lv.probP),
              pqSpread: toFiniteOrNaN(lv.pqSpread),
              classification: lv.classification,
            }))
          : [],
      },
    };

    // Spreads block (evaluated strictly in Swing mode, disabled in Intraday)
    if (request.mode === 'intraday') {
      spreadsByExpiry[expDate] = {
        expirationDate: expDate,
        daysToExpiry: dte,
        enabled: false,
        disabledReason: 'Modo Intraday (0DTE / 1DTE): estrategias multi-pierna desactivadas por política operativa.',
        shortPremiumBreakerStatus: 'NO_SHORT_PREMIUM_RISK',
        shortPremiumBreakerReason: '0DTE / 1DTE circuit breaker activo.',
        dealerCreditSignal: expFlow.creditStrategySignal,
        spotVsZeroGamma: expFlow.spotVsZeroGamma,
        zeroGammaOperationalNote: null,
        widthFilterUsd: { min: SWING_MIN_WIDTH_USD, max: SWING_MAX_WIDTH_USD },
        evaluatedCount: 0,
        excludedCount: 0,
        candidates: [],
      };
    } else {
      const ivDecForVrp = Number.isFinite(ivAtmPct) ? ivAtmPct / 100 : null;
      const vrpEval = computeActiveExpiryVrpAndRegime({
        expiryCode: expDate,
        daysToExpiry: dte,
        ivAtmActiveExpiryPct: Number.isFinite(ivAtmPct) ? ivAtmPct : null,
        rvReferencePct: Number.isFinite(rvRefPct) ? rvRefPct : null,
        rvReferenceLabel: rvRefLabel,
        spot: valuationSpot,
        putWallStrike: Number.isFinite(expFlow.putWallStrike) ? expFlow.putWallStrike : null,
        netGex: Number.isFinite(expFlow.netGex) ? expFlow.netGex : null,
      });
      const breaker = evaluateShortPremiumBreaker({
        dte,
        spot: valuationSpot,
        putWall: Number.isFinite(expFlow.putWallStrike) ? expFlow.putWallStrike : null,
        netGex: Number.isFinite(expFlow.netGex) ? expFlow.netGex : Number.NaN,
      });
      const zeroGammaOperationalNote =
        expFlow.spotVsZeroGamma === 'BELOW_ZERO_GAMMA' ||
        expFlow.creditStrategySignal === 'CAUTION_SHORT_WINGS'
          ? `AVISO OPERATIVO (${expFlow.creditStrategySignal}): spot (${Number.isFinite(valuationSpot) ? valuationSpot.toFixed(2) : 'N/D'}) por debajo de Zero Gamma (${Number.isFinite(expFlow.zeroGammaSpot) ? expFlow.zeroGammaSpot.toFixed(2) : 'N/D'}, dist ${Number.isFinite(expFlow.distanceToZeroGammaPct) ? expFlow.distanceToZeroGammaPct.toFixed(2) : 'N/D'}%). El motor vigente no prohíbe Bull Put / Iron Condor solo por estar debajo de Zero Gamma (solo bloquea si spot < Put Wall con Net GEX < 0 o DTE <= 1), por lo que se reportan los candidatos con cautela explícita de régimen Short Gamma.`
          : null;

      // Build BL density + run rankCreditStructures identically to OptionsModule
      const densityInputs: { strike: number; iv: number | null; bid: number; ask?: number }[] = [];
      const rowMap = new Map<number, { call?: UnifiedContractCalcResult; put?: UnifiedContractCalcResult }>();
      for (const c of calls) {
        const s = rowMap.get(c.strike) ?? {};
        s.call = c;
        rowMap.set(c.strike, s);
      }
      for (const p of puts) {
        const s = rowMap.get(p.strike) ?? {};
        s.put = p;
        rowMap.set(p.strike, s);
      }
      for (const [k, pair] of [...rowMap.entries()].sort((a, b) => a[0] - b[0])) {
        const side = k >= valuationSpot ? pair.call : pair.put;
        if (side !== undefined && side.validBook) {
          densityInputs.push({
            strike: k,
            iv: Number.isFinite(side.ivPct) ? side.ivPct / 100 : null,
            bid: side.bid,
            ask: side.ask,
          });
        }
      }
      const densityRes =
        densityInputs.length >= 5 && isPositiveFinite(valuationSpot) && isPositiveFinite(ivDecForVrp)
          ? buildHardenedBlDensity({
              spot: valuationSpot,
              rate: Number.isFinite(expRate) ? expRate : 0,
              dividendYield: Number.isFinite(expDiv) ? expDiv : 0,
              timeToExpiry: tYears,
              dte,
              expectedMove: em1SigmaUsd,
              nodes: densityInputs,
            })
          : null;

      const creditQuotes: CreditOptionQuoteInput[] = [];
      for (const c of [...calls, ...puts]) {
        if (!c.validBook) continue;
        creditQuotes.push({
          strike: c.strike,
          contractType: c.contractType,
          bid: c.bid,
          ask: c.ask,
          ...(Number.isFinite(c.ivPct) && c.ivPct > 0 ? { iv: c.ivPct / 100 } : {}),
          ...(Number.isFinite(c.delta) ? { delta: c.delta } : {}),
          ...(Number.isFinite(c.gamma) ? { gamma: c.gamma } : {}),
          ...(Number.isFinite(c.thetaDaily) ? { thetaDaily: c.thetaDaily } : {}),
          ...(Number.isFinite(c.vegaPer1Pct) ? { vegaPer1Pct: c.vegaPer1Pct } : {}),
        });
      }

      const multSample =
        calls.find((c) => c.sharesPerContractKnown)?.sharesPerContract ??
        puts.find((p) => p.sharesPerContractKnown)?.sharesPerContract ??
        100;

      const ranking = rankCreditStructures({
        spot: valuationSpot,
        daysToExpiry: dte,
        rate: Number.isFinite(expRate) ? expRate : 0,
        dividendYield: Number.isFinite(expDiv) ? expDiv : 0,
        atmIv: ivDecForVrp ?? Number.NaN,
        lotSize: multSample,
        contracts: creditQuotes,
        densityNodes: densityRes?.status === 'OK' ? densityRes.nodes : [],
        operativeRegimeCode: vrpEval.operativeRegime.code,
      });

      const allRanked = ranking.allCandidates;
      const inWidth: ExportSpreadCandidateRow[] = [];
      let excludedCount = 0;
      for (const cand of allRanked) {
        if (cand.widthPerShare < SWING_MIN_WIDTH_USD - 1e-9 || cand.widthPerShare > SWING_MAX_WIDTH_USD + 1e-9) {
          excludedCount += 1;
          continue;
        }
        inWidth.push(mapRankedSpreadCandidate(cand, expDate, multSample, valuationSpot, em1SigmaUsd, zeroGammaOperationalNote !== null));
      }

      spreadsByExpiry[expDate] = {
        expirationDate: expDate,
        daysToExpiry: dte,
        enabled: !breaker.blocked,
        disabledReason: breaker.blocked ? (breaker.message ?? vrpEval.operativeRegime.rationale) : null,
        shortPremiumBreakerStatus: breaker.status,
        shortPremiumBreakerReason: breaker.message,
        dealerCreditSignal: expFlow.creditStrategySignal,
        spotVsZeroGamma: expFlow.spotVsZeroGamma,
        zeroGammaOperationalNote,
        widthFilterUsd: { min: SWING_MIN_WIDTH_USD, max: SWING_MAX_WIDTH_USD },
        evaluatedCount: allRanked.length,
        excludedCount,
        candidates: breaker.blocked ? [] : inWidth.slice(0, SWING_MAX_SPREAD_CANDIDATES),
      };
    }
  }

  // Term structure up to 6 already-available slices (0 extra fetches)
  const termMap = new Map<string, ExportTermStructurePoint>();
  for (const sl of usSnapshot.volSurfaceSummary?.slices ?? []) {
    const dte = calendarDteEt(sl.expirationDate, capturedAtUtcSec * 1_000);
    const effDte = Number.isFinite(dte) ? dte : sl.timeToExpiryDays;
    const ivAtmPct = isPositiveFinite(sl.ivAtm) ? sl.ivAtm * 100 : Number.NaN;
    const t = effDte > 0 ? effDte / 365 : MIN_EXPECTED_MOVE_T_YEARS;
    const emUsd =
      isPositiveFinite(valuationSpot) && isPositiveFinite(sl.ivAtm)
        ? expectedMoveSigma(valuationSpot, sl.ivAtm, t)
        : Number.NaN;
    const emPct =
      isPositiveFinite(valuationSpot) && Number.isFinite(emUsd)
        ? (emUsd / valuationSpot) * 100
        : Number.NaN;
    const sPut = isPositiveFinite(sl.delta25PutIv) ? sl.delta25PutIv * 100 : Number.NaN;
    const sCall = isPositiveFinite(sl.delta25CallIv) ? sl.delta25CallIv * 100 : Number.NaN;
    const skew = computeSkew25PutMinusCallPts(sPut, sCall);
    termMap.set(sl.expirationDate, {
      expirationDate: sl.expirationDate,
      daysToExpiry: effDte,
      ivAtmPct,
      em1SigmaUsd: emUsd,
      em1SigmaPct: emPct,
      skew25Pts: Number.isFinite(skew)
        ? skew
        : isFiniteNum(sl.riskReversal25)
          ? sl.riskReversal25 * 100
          : Number.NaN,
      quality: sl.sliceQuality ?? 'NOT_EVALUATED',
    });
  }
  for (const expV of Object.values(volByExpiry)) {
    if (!termMap.has(expV.expirationDate)) {
      termMap.set(expV.expirationDate, {
        expirationDate: expV.expirationDate,
        daysToExpiry: expV.daysToExpiry,
        ivAtmPct: expV.ivAtmPct,
        em1SigmaUsd: expV.em1SigmaUsd,
        em1SigmaPct: expV.em1SigmaPct,
        skew25Pts: expV.skew25PutMinusCallPts,
        quality: metadataByExpiry[expV.expirationDate]?.sourceKind === 'EXPIRY_ENDPOINT' ? 'EXPIRY_HYDRATED' : 'SNAPSHOT',
      });
    }
  }
  const termStructureTop6 = [...termMap.values()]
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
    .slice(0, MAX_TERM_STRUCTURE_ROWS);

  const flowGlobal = buildFlowBlock({
    scope: 'GLOBAL',
    expirationDate: null,
    spot: valuationSpot,
    summary: usSnapshot.exposureSummary ?? null,
    terminalEngines: usSnapshot.terminalEngines ?? null,
  });

  // Catalyst window against primary selected expiry
  const primaryMeta = metadataByExpiry[expDatesSelected[0] ?? ''];
  const catalystWindow = evaluateCatalystWindow({
    asOfUtcSec: capturedAtUtcSec,
    activeExpiryUtcSec: primaryMeta?.expiryUtcSec ?? null,
    nextEarnings: usSnapshot.catalysts?.nextEarnings ?? null,
    lastEarnings: usSnapshot.catalysts?.lastEarnings ?? null,
    macroEvents: usSnapshot.catalysts?.macroEvents ?? [],
  });

  const traceMinQ = usSnapshot.exposureSummary?.trace?.quoteTimes?.minUpdatedAtSec;
  const traceMaxQ = usSnapshot.exposureSummary?.trace?.quoteTimes?.maxUpdatedAtSec;
  const minQuoteSec = isPositiveFinite(traceMinQ)
    ? Math.floor(traceMinQ)
    : allQuoteTimes.length > 0
      ? Math.min(...allQuoteTimes)
      : null;
  const maxQuoteSec = isPositiveFinite(traceMaxQ)
    ? Math.floor(traceMaxQ)
    : allQuoteTimes.length > 0
      ? Math.max(...allQuoteTimes)
      : null;
  const medianQuoteSec = resolveMedianNumber(allQuoteTimes) ?? maxQuoteSec;

  const liveQuoteTs = liveSpotQuote?.quoteTimestampUtcSec;
  const liveAsOfTs = liveSpotQuote?.asOfUtcSec;
  const unifiedQuoteTs = unifiedQuote?.quoteTimestampUtcSec;
  const spotQuoteSec = isPositiveFinite(liveQuoteTs)
    ? Math.floor(liveQuoteTs)
    : isPositiveFinite(liveAsOfTs)
      ? Math.floor(liveAsOfTs)
      : isPositiveFinite(unifiedQuoteTs)
        ? Math.floor(unifiedQuoteTs)
        : usSnapshot.asOfUtcSec;

  const snapshotId = `usopt-${ticker}-${request.mode}-${String(capturedAt.utcSec)}-${fnv1aHash8(
    `${ticker}|${request.mode}|${expDatesSelected.join(',')}|${String(valuationSpot)}`,
  )}`;

  return {
    schemaVersion: US_OPTIONS_EXPORT_SCHEMA_VERSION,
    snapshotId,
    meta: {
      ticker,
      currency: 'USD',
      mode: request.mode,
      selectedExpirations: expDatesSelected,
      capturedAt,
      sessionRegime: mapSessionRegime(unifiedQuote?.sessionPhase ?? liveSpotQuote?.sessionPhase, capturedAtUtcSec),
      globalQuality:
        usSnapshot.feedMode === 'EOD_CIERRE' || usSnapshot.quoteMode === 'EOD_CLOSE_REF'
          ? 'EOD_REFERENCE'
          : usSnapshot.status === 'OK'
            ? 'OK'
            : 'PARTIAL',
      catalystWindow,
      warnings: [...(usSnapshot.dataQuality?.warnings ?? [])],
      additionalRequestsCount,
    },
    timestamps: {
      spotAsOf: optionalDualTimestamp(spotQuoteSec),
      optionsQuoteMin: optionalDualTimestamp(minQuoteSec),
      optionsQuoteMax: optionalDualTimestamp(maxQuoteSec),
      optionsQuoteMedian: optionalDualTimestamp(medianQuoteSec),
      oiEffectiveDate:
        usSnapshot.usOptionsFeed?.oiEffectiveDate ?? 'Cierre T-1 (OI diario OCC)',
      volSurfaceAsOf: optionalDualTimestamp(usVolSurface?.asOfUtcSec ?? usSnapshot.asOfUtcSec),
      oratsTradeDate,
      barsAsOf: optionalDualTimestamp(barsAsOfUtcSec ?? barsResponse?.asOfUtcSec),
      catalystsAsOf: optionalDualTimestamp(usSnapshot.catalysts?.asOfUtcSec),
      clockSkewWarnings: [],
    },
    technical: {
      valuationSpot,
      liveSpotAtCapture,
      spotDriftPct,
      changeAbs,
      changePct,
      dayOpen,
      previousClose,
      dayHigh,
      dayLow,
      sessionRangeUsd,
      atr14d,
      atrTravelledPct,
      atrTravelledFormula: '100 * (dayHigh - dayLow) / ATR14_1D',
      spotBid,
      spotAsk,
      spotSpreadPct,
      barsTimeframe,
      emas,
      ema20Available: false,
      smas,
      sessionVwap: {
        timeframe: barsTimeframe ?? 'N/D',
        value: sessionVwapVal,
        distanceSpotPct: computeDistancePct(sessionVwapVal, valuationSpot),
        supported: sessionVwapSupported,
      },
      avwapMonthStart,
      autoAvwaps,
      mtfStructure: {
        regime1d: usSnapshot.microstructure?.mtf?.regime1d ?? null,
        aligned4h: usSnapshot.microstructure?.mtf?.aligned4h ?? null,
        effectiveMacroRegime: usSnapshot.microstructure?.mtf?.effectiveMacroRegime ?? null,
        setupStatus: usSnapshot.microstructure?.mtf?.setupStatus ?? null,
        directionalBias: usSnapshot.envelope?.snapshot?.directionalBias ?? null,
        confluenceScore: toFiniteOrNaN(usSnapshot.envelope?.snapshot?.confluenceScore),
      },
      volumeProfile1y: {
        poc: vpPoc,
        vah: vpVah,
        val: vpVal,
        hvnPrices: sortNearestPrices(vp?.hvnBins),
        lvnPrices: sortNearestPrices(vp?.lvnBins),
        lookbackDays: vp?.windowBars ?? 252,
        methodology: 'AMT Volume Profile sobre 252 ruedas diarias cerradas (HLC3/bins discretos, VA 70%)',
      },
      overnightProfile: {
        onPoc: toFiniteOrNaN(oa?.onPoc),
        onVah: toFiniteOrNaN(oa?.onVah),
        onVal: toFiniteOrNaN(oa?.onVal),
      },
      nakedPocs,
      keyLevels: {
        pdh: findKeyLevelPrice(keyLevelsRaw, 'PDH'),
        pdl: findKeyLevelPrice(keyLevelsRaw, 'PDL'),
        pmh: firstPositiveFinite(oa?.pmh, findKeyLevelPrice(keyLevelsRaw, 'PMH')),
        pml: firstPositiveFinite(oa?.pml, findKeyLevelPrice(keyLevelsRaw, 'PML')),
        ibh: firstPositiveFinite(oa?.ibh, findKeyLevelPrice(keyLevelsRaw, 'IBH')),
        ibl: firstPositiveFinite(oa?.ibl, findKeyLevelPrice(keyLevelsRaw, 'IBL')),
        ibWidth: toFiniteOrNaN(oa?.ibWidth),
        ibClassification: oa?.ibClassification ?? 'N/D',
      },
      activeFvgs,
      ifvgAvailable: false,
      liquiditySweepsAvailable: false,
      cvdApprox: {
        value: cvdVal,
        bias: cvdBias,
        slopeSign: cvdSlope,
        isApproximation: true,
        label: 'CVD aprox. (CLV sobre barras OHLCV — no cinta real de órdenes)',
      },
    },
    flowGlobal,
    flowByExpiry,
    volatility: {
      rv20Pct,
      rv60Pct,
      rv120Pct,
      rv23RefPct,
      iv30dPct,
      termRegime: suite?.moneynessMatrixOtm?.termRegime ?? 'NO_DATA',
      termSpreadPp: toFiniteOrNaN(suite?.moneynessMatrixOtm?.termSpreadPp),
      termStructureTop6,
      currentQuintile,
      currentMonthSeasonality,
      byExpiry: volByExpiry,
    },
    chainsByExpiry,
    spreadsByExpiry,
    metadataByExpiry,
  };
}

function mapRankedSpreadCandidate(
  cand: CreditStructureCandidate,
  expirationDate: string,
  contractMultiplier: number,
  spot: number,
  em1SigmaUsd: number,
  hasZeroGammaCaution: boolean,
): ExportSpreadCandidateRow {
  let midCredit = 0;
  let allBboOk = true;
  for (const leg of cand.legs) {
    if (!isPositiveFinite(leg.bid) || !isPositiveFinite(leg.ask) || leg.ask < leg.bid) {
      allBboOk = false;
      break;
    }
    const legMid = 0.5 * (leg.bid + leg.ask);
    midCredit += (leg.side === 'SELL' ? 1 : -1) * leg.quantity * legMid;
  }

  const conservativePerShare = cand.netCreditPerShare;
  const maxProfitPerShare = cand.maxProfitPerShare;
  const maxLossPerShare = cand.maxLossPerShare;
  const riskRewardRatio =
    isPositiveFinite(maxProfitPerShare) && isNonNegativeFinite(maxLossPerShare)
      ? maxLossPerShare / maxProfitPerShare
      : Number.NaN;

  const nearestBe = cand.breakevens.slice().sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
  const distBeVsEmSigma =
    isPositiveFinite(nearestBe) && isPositiveFinite(spot) && isPositiveFinite(em1SigmaUsd)
      ? Math.abs(nearestBe - spot) / em1SigmaUsd
      : Number.NaN;
  const pItmPct = isFiniteNum(cand.pop) ? (1 - cand.pop) * 100 : Number.NaN;

  const legsSummary = cand.legs
    .map((l) => `${l.side === 'SELL' ? '-1' : '+1'} ${l.contractType === 'call' ? 'C' : 'P'} ${String(l.strike)}`)
    .join(' / ');

  const warnings: string[] = ['L1 BBO no garantiza ejecución conjunta ni profundidad'];
  if (hasZeroGammaCaution && (cand.kind === 'BULL_PUT_SPREAD' || cand.kind === 'IRON_CONDOR')) {
    warnings.push('CAUTION_SHORT_WINGS: spot bajo Zero Gamma / Short Gamma');
  }

  return {
    id: cand.id,
    strategy:
      cand.kind === 'BULL_PUT_SPREAD'
        ? 'Bull Put Spread'
        : cand.kind === 'BEAR_CALL_SPREAD'
          ? 'Bear Call Spread'
          : 'Iron Condor',
    kind: cand.kind,
    expirationDate,
    legsSummary,
    widthUsd: cand.widthPerShare,
    contractMultiplier,
    midCreditPerShare: allBboOk ? midCredit : Number.NaN,
    conservativeCreditPerShare: allBboOk ? conservativePerShare : Number.NaN,
    midCreditContractUsd: allBboOk ? midCredit * contractMultiplier : Number.NaN,
    conservativeCreditContractUsd: allBboOk ? conservativePerShare * contractMultiplier : Number.NaN,
    maxProfitPerShare,
    maxLossPerShare,
    maxProfitContractUsd: maxProfitPerShare * contractMultiplier,
    maxLossContractUsd: maxLossPerShare * contractMultiplier,
    breakevens: cand.breakevens,
    pItmPct,
    popPct: isFiniteNum(cand.pop) ? cand.pop * 100 : Number.NaN,
    popSource: cand.popSource,
    riskRewardRatio,
    distBeVsEmSigma,
    bidAskPctOfMid: cand.bidAskPctOfMid,
    liquiditySemaphore: cand.liquiditySemaphore,
    warnings,
  };
}

/**
 * Valida reglas DTE por modo, consistencia temporal entre fuentes y procedencia por bloque.
 */
export function validateSnapshotIntegrity(
  snapshot: UsOptionsIntelligenceSnapshotV1,
): SnapshotIntegrityReport {
  const blockingErrors: string[] = [];
  const warnings = [...snapshot.meta.warnings];
  const clockSkewWarnings: string[] = [];
  const { mode, selectedExpirations, capturedAt, sessionRegime } = snapshot.meta;

  if (selectedExpirations.length < 1 || selectedExpirations.length > 2) {
    blockingErrors.push(`Cantidad de vencimientos inválida (${String(selectedExpirations.length)}): se requieren 1 o 2.`);
  }

  for (const expDate of selectedExpirations) {
    const meta = snapshot.metadataByExpiry[expDate];
    if (meta === undefined) {
      blockingErrors.push(`Falta cadena cargada para vencimiento ${expDate}.`);
      continue;
    }
    if (mode === 'intraday' && (meta.daysToExpiry < 0 || meta.daysToExpiry > 1)) {
      blockingErrors.push(
        `Vencimiento ${expDate} (${String(meta.daysToExpiry)} DTE) incompatible con modo Intraday (0–1 DTE). No se amplía el rango DTE automáticamente.`,
      );
    }
    if (mode === 'swing' && (meta.daysToExpiry < 6 || meta.daysToExpiry > 17)) {
      blockingErrors.push(
        `Vencimiento ${expDate} (${String(meta.daysToExpiry)} DTE) incompatible con modo Swing (6–17 DTE). No se amplía el rango DTE automáticamente.`,
      );
    }
  }

  const spotSec = snapshot.timestamps.spotAsOf?.utcSec ?? null;
  const medOptSec = snapshot.timestamps.optionsQuoteMedian?.utcSec ?? null;
  if (sessionRegime === 'RTH' && spotSec !== null && capturedAt.utcSec - spotSec > RTH_SPOT_STALE_SEC) {
    clockSkewWarnings.push(`SPOT_STALE: spot desfasado ${String(capturedAt.utcSec - spotSec)}s respecto a captura en RTH.`);
  }
  if (sessionRegime === 'RTH' && spotSec !== null && medOptSec !== null && Math.abs(spotSec - medOptSec) > RTH_SPOT_OPTIONS_SKEW_SEC) {
    clockSkewWarnings.push(`SPOT_OPTIONS_SKEW: desfase temporal de ${String(Math.abs(spotSec - medOptSec))}s entre spot y quotes OPRA.`);
  }
  if (Number.isFinite(snapshot.technical.spotDriftPct) && Math.abs(snapshot.technical.spotDriftPct) > SPOT_DRIFT_WARN_PCT) {
    clockSkewWarnings.push(
      `SPOT_VALUATION_DRIFT: spot live (${snapshot.technical.liveSpotAtCapture.toFixed(2)}) difiere ${snapshot.technical.spotDriftPct.toFixed(2)}% de valuationSpot (${snapshot.technical.valuationSpot.toFixed(2)}).`,
    );
  }
  if (
    snapshot.timestamps.oratsTradeDate !== null &&
    snapshot.timestamps.oratsTradeDate !== capturedAt.etDateKey
  ) {
    clockSkewWarnings.push(
      `ORATS_PRIOR_SESSION_DATE: datos IVR/IVP ORATS del ${snapshot.timestamps.oratsTradeDate} (sesión previa respecto a ${capturedAt.etDateKey} ET).`,
    );
  }
  if (snapshot.meta.globalQuality === 'EOD_REFERENCE' || sessionRegime !== 'RTH') {
    clockSkewWarnings.push(
      `EOD_OR_EXTENDED_SESSION: sesión ${sessionRegime}; libros BBO OPRA pueden estar cerrados o en referencia EOD.`,
    );
  }

  const provenanceTable: SnapshotBlockProvenance[] = [
    {
      block: 'Spot y Quote US',
      source: 'Tradier / FMP / Massive UnifiedQuote',
      asOf: snapshot.timestamps.spotAsOf?.etFormatted ?? 'N/D',
      status: snapshot.meta.globalQuality,
      coverage: Number.isFinite(snapshot.technical.spotBid) ? 'NBBO bilateral válido' : 'Solo spot / cierre',
    },
    {
      block: 'Técnico y VP 1Y',
      source: `Massive / FMP /api/bars (${snapshot.technical.barsTimeframe ?? 'sin barras'}) + snapshot 1D`,
      asOf: snapshot.timestamps.barsAsOf?.etFormatted ?? snapshot.meta.capturedAt.etFormatted,
      status: snapshot.technical.barsTimeframe !== null ? 'OK' : 'PARTIAL',
      coverage: `EMA 9/21/50/200 (${snapshot.technical.barsTimeframe ?? 'parcial'}), VP ${String(snapshot.technical.volumeProfile1y.lookbackDays)}R`,
    },
    {
      block: 'Flujo y Exposición Dealers',
      source: 'Motor Exposure US (OPRA + OI OCC T-1)',
      asOf: snapshot.timestamps.optionsQuoteMedian?.etFormatted ?? snapshot.meta.capturedAt.etFormatted,
      status: snapshot.flowGlobal.usableContracts > 0 ? snapshot.meta.globalQuality : 'UNAVAILABLE',
      coverage: `${String(snapshot.flowGlobal.usableContracts)}/${String(snapshot.flowGlobal.totalContracts)} contratos (${snapshot.flowGlobal.coverage})`,
    },
    {
      block: 'Volatilidad, IVR/IVP y Q/P',
      source: `${snapshot.timestamps.oratsTradeDate !== null ? 'ORATS 1Y + ' : 'Proxy RV 1Y + '}VolAnalyticsSuite`,
      asOf: snapshot.timestamps.volSurfaceAsOf?.etFormatted ?? snapshot.meta.capturedAt.etFormatted,
      status: Object.keys(snapshot.volatility.byExpiry).length > 0 ? 'OK' : 'PARTIAL',
      coverage: `${String(snapshot.volatility.termStructureTop6.length)} slices en curva temporal`,
    },
    {
      block: 'Catalizadores',
      source: 'Earnings + Calendario FOMC/CPI',
      asOf: snapshot.timestamps.catalystsAsOf?.etFormatted ?? 'N/D',
      status: snapshot.meta.catalystWindow.status === 'NO_DATA' ? 'UNAVAILABLE' : 'OK',
      coverage: snapshot.meta.catalystWindow.badgeLabel,
    },
  ];

  const globalQuality: BlockQualityStatus =
    blockingErrors.length > 0
      ? 'UNAVAILABLE'
      : snapshot.meta.globalQuality === 'EOD_REFERENCE'
        ? 'EOD_REFERENCE'
        : clockSkewWarnings.length > 0 || snapshot.technical.barsTimeframe === null
          ? 'PARTIAL'
          : 'OK';

  return {
    valid: blockingErrors.length === 0,
    globalQuality,
    blockingErrors,
    warnings,
    clockSkewWarnings,
    provenanceTable,
    gexMethodology: `GEX (${'USD_PER_1PCT_SPOT_MOVE' satisfies DealerExposureUnits['dollarGex']}), VEX (${'USD_DELTA_PER_1PCT_IV_MOVE' satisfies DealerExposureUnits['vannaExposure']}), CEX (${'USD_DELTA_PER_DAY' satisfies DealerExposureUnits['charmExposure']}). Supuesto teórico de dealers (calls +1, puts -1 sobre OI OCC cerrado T-1); NO representa inventarios reales observados de dealers. Flujo y agresión OPRA estimados desde snapshot (lastTrade + BBO), no cinta tick-a-tick.`,
    volatilityMethodology: 'VRP definido exclusivamente como diferencia de volatilidades en puntos porcentuales (IV_ATM - RV_ref; ref RV23d/RV20d), no diferencia de varianzas. Skew 25Δ estandarizado a IV_25P - IV_25C. Expected Move lognormal S*exp(±k*σ*√T). Densidad Q (Breeden-Litzenberger PCHIP) y P (histórica) refieren al vencimiento front y no son predicción directa.',
    unavailableFields: [
      'EMA 20 (no implementado — se proveen EMA 9/21/50/200)',
      'IFVG / Inverse FVG (no implementado — se proveen FVGs estándar)',
      'Liquidity Sweeps confirmados (no implementado)',
      'Opening Range 5m/15m/30m separado (se reporta Initial Balance 09:30–10:30 ET)',
    ],
    limitations: [
      `OI efectivo correspondiente a ${snapshot.timestamps.oiEffectiveDate}.`,
      'CVD aproximado vía CLV sobre barras OHLCV (no delta real de órdenes agresoras).',
      'Curva temporal limitada a vencimientos ya presentes en memoria (0 descargas masivas).',
      'Spreads multi-pierna muestran crédito teórico Mid vs Conservador L1; no garantizan ejecución conjunta.',
    ],
  };
}

export interface FilterSnapshotModeOptions {
  readonly swingChainFilter?: SwingChainFilterMode;
}

function filterChainSide(params: {
  readonly contracts: readonly UnifiedContractCalcResult[];
  readonly mode: SnapshotMode;
  readonly swingFilter: SwingChainFilterMode;
  readonly spot: number;
  readonly em1SigmaUsd: number;
}): ExportFilteredChainSide {
  const { contracts, mode, swingFilter, spot, em1SigmaUsd } = params;
  const excludedByReason: Record<string, number> = {};
  const addExcl = (reason: string): void => {
    excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  };
  const rows: UnifiedContractCalcResult[] = [];

  for (const c of contracts) {
    if (!c.validBook) {
      addExcl(c.bookInvalidReason ?? 'INVALID_BOOK');
      continue;
    }
    if (mode === 'intraday') {
      if (!Number.isFinite(c.delta)) {
        addExcl('MISSING_DELTA');
        continue;
      }
      const absD = Math.abs(c.delta);
      if (absD < INTRADAY_DELTA_MIN || absD > INTRADAY_DELTA_MAX) {
        addExcl('OUTSIDE_INTRADAY_DELTA_045_085');
        continue;
      }
      rows.push(c);
      continue;
    }

    if (swingFilter === 'DELTA_005_055') {
      if (!Number.isFinite(c.delta)) {
        addExcl('MISSING_DELTA');
        continue;
      }
      const absD = Math.abs(c.delta);
      if (absD < SWING_DELTA_MIN || absD > SWING_DELTA_MAX) {
        addExcl('OUTSIDE_SWING_DELTA_005_055');
        continue;
      }
      rows.push(c);
    } else {
      const kMult = swingFilter === 'SIGMA_1_5' ? 1.5 : 2.0;
      if (!isPositiveFinite(spot) || !isPositiveFinite(em1SigmaUsd)) {
        addExcl('MISSING_EM_FOR_SIGMA_FILTER');
        continue;
      }
      if (Math.abs(c.strike - spot) > kMult * em1SigmaUsd) {
        addExcl(`OUTSIDE_SIGMA_${kMult.toFixed(1)}`);
        continue;
      }
      rows.push(c);
    }
  }

  return {
    totalAvailable: contracts.length,
    included: rows.length,
    excludedByReason,
    rows,
  };
}

function sliceFlowWindow(
  flow: ExportFlowSummaryBlock,
  spot: number,
  halfWindow: number,
): ExportFlowSummaryBlock {
  const all = flow.allStrikes;
  if (all.length === 0) {
    return {
      ...flow,
      strikesWindow: [],
      windowStats: {
        atmStrike: Number.NaN,
        totalAvailable: 0,
        included: 0,
        excluded: 0,
        outOfWindowStructuralLevels: [],
      },
    };
  }
  let atmIdx = Math.floor(all.length / 2);
  if (isPositiveFinite(spot)) {
    let bestDist = Number.POSITIVE_INFINITY;
    all.forEach((r, idx) => {
      const dist = Math.abs(r.strike - spot);
      if (dist < bestDist) {
        bestDist = dist;
        atmIdx = idx;
      }
    });
  }
  const lo = Math.max(0, atmIdx - halfWindow);
  const hi = Math.min(all.length - 1, atmIdx + halfWindow);
  const strikesWindow = all.slice(lo, hi + 1);
  const minK = strikesWindow[0]?.strike ?? Number.NaN;
  const maxK = strikesWindow[strikesWindow.length - 1]?.strike ?? Number.NaN;
  const outLevels: string[] = [];
  const checkOut = (name: string, val: number): void => {
    if (Number.isFinite(val) && Number.isFinite(minK) && Number.isFinite(maxK) && (val < minK || val > maxK)) {
      outLevels.push(`${name} (${val.toFixed(2)})`);
    }
  };
  checkOut('Call Wall', flow.callWallStrike);
  checkOut('Put Wall', flow.putWallStrike);
  checkOut('Zero Gamma', flow.zeroGammaSpot);
  checkOut('Max Pain', flow.maxPainStrike);
  checkOut('Charm Pin', flow.charmPinStrike);

  return {
    ...flow,
    strikesWindow,
    windowStats: {
      atmStrike: all[atmIdx]?.strike ?? Number.NaN,
      totalAvailable: all.length,
      included: strikesWindow.length,
      excluded: all.length - strikesWindow.length,
      outOfWindowStructuralLevels: outLevels,
    },
  };
}

/**
 * Aplica los filtros deterministas de modo Intraday/Swing sin modificar jamás totales globales ni del vencimiento.
 */
export function filterSnapshotByMode(
  snapshot: UsOptionsIntelligenceSnapshotV1,
  options: FilterSnapshotModeOptions = {},
): FilteredUsOptionsSnapshotV1 {
  const mode = snapshot.meta.mode;
  const swingFilter: SwingChainFilterMode | null =
    mode === 'swing' ? (options.swingChainFilter ?? 'DELTA_005_055') : null;
  const flowHalfWindow = mode === 'intraday' ? INTRADAY_FLOW_HALF_WINDOW : SWING_FLOW_HALF_WINDOW;

  const flowByExpiry: Record<string, ExportFlowSummaryBlock> = {};
  const chainsByExpiry: Record<string, {
    readonly expirationDate: string;
    readonly daysToExpiry: number;
    readonly calls: ExportFilteredChainSide;
    readonly puts: ExportFilteredChainSide;
  }> = {};
  const excludedRowsSummary: string[] = [];

  for (const expDate of snapshot.meta.selectedExpirations) {
    const rawFlow = snapshot.flowByExpiry[expDate];
    if (rawFlow !== undefined) {
      const sliced = sliceFlowWindow(rawFlow, snapshot.technical.valuationSpot, flowHalfWindow);
      flowByExpiry[expDate] = sliced;
      if (sliced.windowStats) {
        excludedRowsSummary.push(
          `Flujo ${expDate}: ${String(sliced.windowStats.included)}/${String(sliced.windowStats.totalAvailable)} strikes incluidos (±${String(flowHalfWindow)} alrededor de ATM ${Number.isFinite(sliced.windowStats.atmStrike) ? sliced.windowStats.atmStrike.toFixed(2) : 'N/D'}; excluidos ${String(sliced.windowStats.excluded)} — totales globales intactos).`,
        );
      }
    }

    const rawChain = snapshot.chainsByExpiry[expDate];
    const expVol = snapshot.volatility.byExpiry[expDate];
    if (rawChain !== undefined) {
      const callsFiltered = filterChainSide({
        contracts: rawChain.calls,
        mode,
        swingFilter: swingFilter ?? 'DELTA_005_055',
        spot: snapshot.technical.valuationSpot,
        em1SigmaUsd: expVol?.em1SigmaUsd ?? Number.NaN,
      });
      const putsFiltered = filterChainSide({
        contracts: rawChain.puts,
        mode,
        swingFilter: swingFilter ?? 'DELTA_005_055',
        spot: snapshot.technical.valuationSpot,
        em1SigmaUsd: expVol?.em1SigmaUsd ?? Number.NaN,
      });
      chainsByExpiry[expDate] = {
        expirationDate: expDate,
        daysToExpiry: rawChain.daysToExpiry,
        calls: callsFiltered,
        puts: putsFiltered,
      };
      excludedRowsSummary.push(
        `Cadena ${expDate}: Calls ${String(callsFiltered.included)}/${String(callsFiltered.totalAvailable)}, Puts ${String(putsFiltered.included)}/${String(putsFiltered.totalAvailable)} (${Object.entries(callsFiltered.excludedByReason).map(([k, v]) => `C:${k}=${String(v)}`).concat(Object.entries(putsFiltered.excludedByReason).map(([k, v]) => `P:${k}=${String(v)}`)).join(', ') || 'sin exclusiones'}).`,
      );
    }
  }

  // Expiry comparison when 2 dates are selected
  const expiryComparison: ExportExpiryComparisonRow[] = [];
  if (snapshot.meta.selectedExpirations.length === 2) {
    for (const expDate of snapshot.meta.selectedExpirations) {
      const vol = snapshot.volatility.byExpiry[expDate];
      const fl = flowByExpiry[expDate];
      const sp = snapshot.spreadsByExpiry[expDate];
      const rawCh = snapshot.chainsByExpiry[expDate];
      const allContracts = [...(rawCh?.calls ?? []), ...(rawCh?.puts ?? [])];
      const atmContract = allContracts
        .filter((c) => Number.isFinite(c.thetaDaily))
        .sort(
          (a, b) =>
            Math.abs(a.strike - snapshot.technical.valuationSpot) -
            Math.abs(b.strike - snapshot.technical.valuationSpot),
        )[0];
      const bestCand = sp?.candidates[0] ?? null;
      expiryComparison.push({
        expirationDate: expDate,
        daysToExpiry: vol?.daysToExpiry ?? fl?.allStrikes.length ?? 0,
        ivAtmPct: vol?.ivAtmPct ?? Number.NaN,
        em1SigmaUsd: vol?.em1SigmaUsd ?? Number.NaN,
        em1SigmaPct: vol?.em1SigmaPct ?? Number.NaN,
        skew25Pts: vol?.skew25PutMinusCallPts ?? Number.NaN,
        netGex: fl?.netGex ?? Number.NaN,
        maxPainStrike: fl?.maxPainStrike ?? Number.NaN,
        atmThetaDaily: atmContract?.thetaDaily ?? Number.NaN,
        validSpreadCandidates: sp?.candidates.length ?? 0,
        bestSpreadSummary: bestCand ? `${bestCand.strategy} (${bestCand.legsSummary})` : null,
        bestConservativeCreditUsd: bestCand?.conservativeCreditContractUsd ?? Number.NaN,
        bestRiskUsd: bestCand?.maxLossContractUsd ?? Number.NaN,
        bestMultiplier: bestCand?.contractMultiplier ?? Number.NaN,
        bestWidthUsd: bestCand?.widthUsd ?? Number.NaN,
      });
    }
  }

  return {
    snapshot,
    mode,
    swingChainFilter: swingFilter,
    flowByExpiry,
    chainsByExpiry,
    spreadsByExpiry: snapshot.spreadsByExpiry,
    expiryComparison,
    excludedRowsSummary,
  };
}
