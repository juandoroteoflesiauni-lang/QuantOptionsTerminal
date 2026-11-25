import type {
  InstitutionalAvwapConfluenceContextDto,
  TerminalTimeframe,
} from '../../data/liveTypes';

export type AvwapAlignedLevelType =
  InstitutionalAvwapConfluenceContextDto['alignedLevels'][number]['levelType'];
export type AvwapDegradationFlag = InstitutionalAvwapConfluenceContextDto['flags'][number];
export type AvwapGammaRegime = InstitutionalAvwapConfluenceContextDto['gammaRegime'];
export type AvwapVolRegime = InstitutionalAvwapConfluenceContextDto['volRegime'];

export type AvwapUiTimeframe = '1m' | '5m' | '15m' | '30m' | '65m' | '1H' | '4H' | '1D' | '1W';
export type AvwapAnyTimeframe = AvwapUiTimeframe | TerminalTimeframe;

export type AvwapUiAnchorFamily =
  | 'SESSION_VWAP'
  | 'CALENDAR_YTD'
  | 'EARNINGS_BLOWOUT'
  | 'IPO_DIRECT'
  | 'CALENDAR_QTD'
  | 'VOLUME_CLIMAX'
  | 'BREAKAWAY_GAP'
  | 'MACRO_SHOCK'
  | 'SECONDARY_OFFERING'
  | 'INDEX_REBAL'
  | 'OPTIONS_FLOW_SHOCK'
  | 'SWING_CAUSAL'
  | 'POST_OPEX'
  | 'EARNINGS_INLINE'
  | 'SWING_NO_RVOL'
  | 'EX_DIVIDEND_REGULAR';

export type AvwapUiLifecycleState =
  | 'CANDIDATE'
  | 'ACTIVE_PRIMARY'
  | 'ACTIVE_SECONDARY'
  | 'PINCH_PAIR'
  | 'DECAYING'
  | 'ARCHIVED';

export type AvwapDecayReason = 'COHORT_DECAY' | 'CHOP_SATURATION' | 'FLAT_SLOPE';
export type AvwapUiPolarity = 'LONG' | 'SHORT' | 'NEUTRAL';
export type AvwapVisualBudgetTier = 'WEEKLY_DAILY' | 'INTRADAY_MID' | 'INTRADAY_FAST';
export type AvwapDominantConfluence = 'BOUNCE' | 'BREAKOUT' | 'BALANCED';
export type AvwapLineStyleToken = 'SOLID' | 'DASHED' | 'DOTTED';

export interface InstitutionalAvwapBandsInput {
  readonly upper1?: number | null;
  readonly lower1?: number | null;
  readonly upper2?: number | null;
  readonly lower2?: number | null;
  readonly upper2_5?: number | null;
  readonly lower2_5?: number | null;
  readonly sigmaHybrid?: number | null;
  readonly bandSource?: 'HYBRID_ORATS_WELFORD' | 'WELFORD_ONLY_FALLBACK' | null;
}

export interface InstitutionalAvwapIassInput {
  readonly scoreConservative?: number | null;
  readonly dataCoverage?: number | null;
  readonly pillarScores?: Readonly<{
    readonly M?: number | null;
    readonly D?: number | null;
    readonly F?: number | null;
    readonly S?: number | null;
  }>;
  readonly tier?: string | null;
}

export interface InstitutionalAvwapAnchorInput {
  readonly anchorId: string;
  readonly family: AvwapUiAnchorFamily;
  readonly polarity?: AvwapUiPolarity;
  readonly label?: string | null;
  readonly anchorDate?: string | null;
  readonly anchorTimeSec?: number | null;
  readonly avwap: number | null;
  readonly distanceAtr: number | null;
  readonly zScorePath?: number | null;
  readonly lifecycleState: AvwapUiLifecycleState;
  readonly pinchPartnerId?: string | null;
  readonly decayReasons?: readonly AvwapDecayReason[];
  readonly cohortSurvival?: number | null;
  readonly floatIsNonPit?: boolean;
  readonly iass?: InstitutionalAvwapIassInput | null;
  readonly bands?: InstitutionalAvwapBandsInput | null;
  readonly degradationFlags?: readonly AvwapDegradationFlag[];
}

export interface InstitutionalAvwapContextInput extends InstitutionalAvwapConfluenceContextDto {
  readonly activeAnchors?: readonly InstitutionalAvwapAnchorInput[];
  readonly opexResetMarkerDates?: readonly string[];
  readonly degradationFlags?: readonly AvwapDegradationFlag[];
}

export interface AvwapUiPreferences {
  readonly focusedAnchorId?: string | null;
  readonly showFocusedBands?: boolean;
  readonly showOpexResetMarker?: boolean;
  readonly showWeeklyBandsOverride?: boolean;
}

export interface BuildAvwapContextViewModelInput {
  readonly context: InstitutionalAvwapContextInput | null | undefined;
  readonly activeTimeframe: AvwapAnyTimeframe;
  readonly anchors?: readonly InstitutionalAvwapAnchorInput[];
  readonly opexResetMarkerDates?: readonly string[];
  readonly preferences?: AvwapUiPreferences;
}

export interface AvwapVisualBudgetRule {
  readonly timeframe: AvwapUiTimeframe;
  readonly tier: AvwapVisualBudgetTier;
  readonly baseMaxCurves: number;
  readonly pinchMaxCurves: number;
  readonly maxMacroAxisRefs: number;
  readonly macroAxisMaxDistAtr: number;
  readonly topDownMaxDistAtr: number;
  readonly bandsHiddenByDefault: boolean;
}

export interface AvwapFsmSemanticStyle {
  readonly state: AvwapUiLifecycleState;
  readonly badgeLabel: 'PRIMARY' | 'SECONDARY' | 'PINCH' | 'DECAYING' | 'CANDIDATE' | 'ARCHIVED';
  readonly opacity: number;
  readonly lineWidth: 1 | 2;
  readonly lineStyle: AvwapLineStyleToken;
  readonly color: string;
  readonly rgbaColor: string;
  readonly emphasizeCorridor: boolean;
}

export interface AvwapDecayReasonBadge {
  readonly code: AvwapDecayReason;
  readonly label: string;
}

export interface AvwapHybridBandLevelView {
  readonly key: 'upper2_5' | 'upper2' | 'upper1' | 'lower1' | 'lower2' | 'lower2_5';
  readonly sigma: 1 | 2 | 2.5;
  readonly direction: 'UPPER' | 'LOWER';
  readonly label: string;
  readonly shortLabel: string;
  readonly price: number | null;
  readonly priceFormatted: string;
  readonly isCalibratedExtreme: boolean;
  readonly emphasis: 'CALIBRATED_EXTREME_P95' | 'STANDARD';
  readonly color: string;
  readonly lineStyle: AvwapLineStyleToken;
}

export interface AvwapAnchorViewItem {
  readonly anchorId: string;
  readonly family: AvwapUiAnchorFamily;
  readonly familyLabel: string;
  readonly shortTag: string;
  readonly polarity: AvwapUiPolarity;
  readonly label: string;
  readonly anchorDate: string | null;
  readonly avwap: number | null;
  readonly avwapFormatted: string;
  readonly distanceAtr: number | null;
  readonly absDistanceAtr: number | null;
  readonly distanceAtrFormatted: string;
  readonly zScorePath: number | null;
  readonly zScorePathFormatted: string;
  readonly lifecycleState: AvwapUiLifecycleState;
  readonly fsmBadgeLabel: AvwapFsmSemanticStyle['badgeLabel'];
  readonly pinchPartnerId: string | null;
  readonly isPinchMember: boolean;
  readonly isFocused: boolean;
  readonly style: AvwapFsmSemanticStyle;
  readonly decayReasons: readonly AvwapDecayReasonBadge[];
  readonly cohortSurvival: number | null;
  readonly cohortSurvivalPctFormatted: string;
  readonly floatIsNonPit: boolean;
  readonly floatNonPitNote: string | null;
  readonly iassScoreConservative: number | null;
  readonly iassConservativeFormatted: string;
  readonly iassDataCoverage: number | null;
  readonly iassCoveragePctFormatted: string;
  readonly iassPillarsFormatted: Readonly<{
    readonly M: string;
    readonly D: string;
    readonly F: string;
    readonly S: string;
  }>;
  readonly bandSource: 'HYBRID_ORATS_WELFORD' | 'WELFORD_ONLY_FALLBACK' | null;
  readonly bandsLevels: readonly AvwapHybridBandLevelView[];
}

export interface AvwapMacroAxisRefView {
  readonly anchorId: string;
  readonly family: 'CALENDAR_YTD' | 'IPO_DIRECT';
  readonly shortLabel: 'YTD' | 'IPO';
  readonly label: string;
  readonly avwap: number | null;
  readonly avwapFormatted: string;
  readonly distanceAtr: number;
  readonly absDistanceAtr: number;
  readonly distanceAtrFormatted: string;
  readonly representation: 'DISCRETE_AXIS_LABEL';
  readonly isFullCurve: false;
}

export interface AvwapOpexCycleMarkerView {
  readonly id: string;
  readonly markerKind: 'OPEX_CYCLE_MARKER';
  readonly isSupportResistance: false;
  readonly label: string;
  readonly dateLabel: string | null;
  readonly avwap: number | null;
  readonly avwapFormatted: string;
}

export interface AvwapPinchCorridorView {
  readonly anchorIds: readonly [string, string];
  readonly lowPrice: number;
  readonly highPrice: number;
  readonly lowFormatted: string;
  readonly highFormatted: string;
  readonly spreadAtr: number | null;
  readonly spreadAtrFormatted: string;
  readonly label: string;
}

export interface AvwapFocusedBandsView {
  readonly focusedAnchorId: string | null;
  readonly focusedAnchorLabel: string | null;
  readonly visible: boolean;
  readonly hiddenReason: 'WEEKLY_HIDDEN_BY_DEFAULT' | 'NO_FOCUSED_ANCHOR' | 'TOGGLED_OFF' | null;
  readonly calibratedExtremeNote: string;
  readonly levels: readonly AvwapHybridBandLevelView[];
}

export interface AvwapGammaBadgeView {
  readonly kind: 'SHORT_GAMMA_BOUNCE_HAZARD' | AvwapGammaRegime;
  readonly tone: 'danger' | 'positive' | 'warning' | 'neutral' | 'muted';
  readonly shortLabel: string;
  readonly detail: string;
}

export interface AvwapVolRegimeBadgeView {
  readonly regime: AvwapVolRegime;
  readonly label: string;
  readonly tone: 'neutral' | 'info' | 'warning' | 'muted';
}

export interface AvwapAlignedLevelChipView {
  readonly levelType: AvwapAlignedLevelType;
  readonly label: string;
  readonly price: number | null;
  readonly priceFormatted: string;
  readonly distanceAtr: number | null;
  readonly distanceAtrFormatted: string;
  readonly kernelWeight: number | null;
  readonly kernelWeightFormatted: string;
}

export interface AvwapDegradationBadgeView {
  readonly flag: AvwapDegradationFlag;
  readonly label: string;
  readonly isHazard: boolean;
}

export interface InstitutionalAvwapChartPriceLine {
  readonly id: string;
  readonly kind: 'ANCHOR_LEVEL' | 'MACRO_AXIS_REF' | 'FOCUSED_BAND';
  readonly price: number;
  readonly title: string;
  readonly color: string;
  readonly lineWidth: 1 | 2;
  readonly lineStyle: AvwapLineStyleToken;
  readonly lineVisible: boolean;
  readonly axisLabelVisible: boolean;
  readonly opacity: number;
}

export interface InstitutionalAvwapContextViewModel {
  readonly available: boolean;
  readonly role: 'INSTITUTIONAL_CONTEXT_ONLY';
  readonly timeframe: AvwapUiTimeframe;
  readonly budgetRule: AvwapVisualBudgetRule;
  readonly effectiveMaxCurves: number;
  readonly shortGammaBounceHazard: boolean;
  readonly gammaBadge: AvwapGammaBadgeView;
  readonly volRegimeBadge: AvwapVolRegimeBadgeView;
  readonly meanReversionContextActive: boolean;
  readonly netGexNormalizedG: number | null;
  readonly netGexNormalizedFormatted: string;
  readonly bounceScore: number | null;
  readonly bounceScoreFormatted: string;
  readonly bounceBarPct: number;
  readonly breakoutScore: number | null;
  readonly breakoutScoreFormatted: string;
  readonly breakoutBarPct: number;
  readonly dominantConfluence: AvwapDominantConfluence;
  readonly dominantConfluenceLabel: string;
  readonly alignedLevels: readonly AvwapAlignedLevelChipView[];
  readonly visibleAnchors: readonly AvwapAnchorViewItem[];
  readonly macroAxisRefs: readonly AvwapMacroAxisRefView[];
  readonly opexCycleMarkers: readonly AvwapOpexCycleMarkerView[];
  readonly pinchCorridor: AvwapPinchCorridorView | null;
  readonly focusedBands: AvwapFocusedBandsView;
  readonly degradationBadges: readonly AvwapDegradationBadgeView[];
  readonly chartPriceLines: readonly InstitutionalAvwapChartPriceLine[];
}

export const BLOCKED_NEGATIVE_CONTROL_FAMILIES: readonly AvwapUiAnchorFamily[] = Object.freeze([
  'EARNINGS_INLINE',
  'SWING_NO_RVOL',
  'EX_DIVIDEND_REGULAR',
]);

export const MACRO_AXIS_REF_FAMILIES: readonly ('CALENDAR_YTD' | 'IPO_DIRECT')[] = Object.freeze([
  'CALENDAR_YTD',
  'IPO_DIRECT',
]);

const ANCHOR_FAMILY_LABELS: Readonly<Record<AvwapUiAnchorFamily, Readonly<{ full: string; short: string }>>> = Object.freeze({
  SESSION_VWAP: { full: 'Sesión RTH', short: 'VWAP' },
  CALENDAR_YTD: { full: 'Año (YTD)', short: 'YTD' },
  EARNINGS_BLOWOUT: { full: 'Earnings Blowout', short: 'ERN+' },
  IPO_DIRECT: { full: 'IPO Directo', short: 'IPO' },
  CALENDAR_QTD: { full: 'Trimestre (QTD)', short: 'QTD' },
  VOLUME_CLIMAX: { full: 'Clímax Volumen', short: 'CLMX' },
  BREAKAWAY_GAP: { full: 'Breakaway Gap', short: 'GAP' },
  MACRO_SHOCK: { full: 'Shock Macro', short: 'MAC' },
  SECONDARY_OFFERING: { full: 'Secondary Offering', short: 'SEC' },
  INDEX_REBAL: { full: 'Rebalanceo Índice', short: 'REBAL' },
  OPTIONS_FLOW_SHOCK: { full: 'Options Flow Shock', short: 'FLOW' },
  SWING_CAUSAL: { full: 'Swing Causal', short: 'SWG' },
  POST_OPEX: { full: 'Post-OpEx', short: 'OPEX' },
  EARNINGS_INLINE: { full: 'Earnings Inline', short: 'ERN=' },
  SWING_NO_RVOL: { full: 'Swing sin RVOL', short: 'SWG0' },
  EX_DIVIDEND_REGULAR: { full: 'Ex-Dividendo Regular', short: 'DIV' },
});

const ALIGNED_LEVEL_LABELS: Readonly<Record<AvwapAlignedLevelType, string>> = Object.freeze({
  CALL_WALL: 'Call Wall',
  PUT_WALL: 'Put Wall',
  ZERO_GAMMA: 'Zero Gamma',
  VP_POC: 'POC',
  VP_VAH: 'VAH',
  VP_VAL: 'VAL',
  VP_HVN: 'HVN',
  VP_LVN: 'LVN',
});

export const DECAY_REASON_LABELS: Readonly<Record<AvwapDecayReason, string>> = Object.freeze({
  COHORT_DECAY: 'Decaimiento de cohorte',
  CHOP_SATURATION: 'Saturación lateral (chop)',
  FLAT_SLOPE: 'Pendiente plana',
});

export const DEGRADATION_FLAG_LABELS: Readonly<Record<AvwapDegradationFlag, string>> = Object.freeze({
  NO_ORATS_COVERAGE: 'Sin ORATS (cobertura parcial)',
  ORATS_OI_FALLBACK_MASSIVE: 'OI vía Massive fallback',
  FLOAT_NON_PIT_SNAPSHOT: 'Float snapshot actual',
  MISSING_WHAM_COVERAGE: 'Sin WHAM',
  CORP_ACTION_CONFLICT_QUARANTINED: 'Acción corp. en cuarentena',
  NO_NBBO_AGGRESSOR_SIDE: 'Sin lado agresor NBBO',
  NO_NOI_IMBALANCE_FEED: 'Sin feed NOI imbalance',
  SHORT_GAMMA_BOUNCE_HAZARD: 'Short Gamma: rebotes degradados, prima expansión/ruptura',
});

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatAvwapNumber(value: number | null | undefined, decimals = 2): string {
  if (!isFiniteNumber(value)) return '—';
  return value.toFixed(decimals);
}

export function formatAvwapSignedNumber(
  value: number | null | undefined,
  decimals = 2,
  suffix = '',
): string {
  if (!isFiniteNumber(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}${suffix}`;
}

export function formatAvwapPercent(
  value: number | null | undefined,
  isFraction = true,
  decimals = 1,
): string {
  if (!isFiniteNumber(value)) return '—';
  const pct = isFraction ? value * 100 : value;
  if (!Number.isFinite(pct)) return '—';
  return `${pct.toFixed(decimals)}%`;
}

export function formatAvwapScore(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return '—';
  const clamped = Math.max(0, Math.min(100, value));
  return clamped.toFixed(0);
}

export function normalizeAvwapTimeframe(tf: AvwapAnyTimeframe): AvwapUiTimeframe {
  if (tf === '1h') return '1H';
  if (tf === '4h') return '4H';
  return tf;
}

export function getVisualBudgetRule(tf: AvwapAnyTimeframe): AvwapVisualBudgetRule {
  const timeframe = normalizeAvwapTimeframe(tf);
  if (timeframe === '1W' || timeframe === '1D') {
    return {
      timeframe,
      tier: 'WEEKLY_DAILY',
      baseMaxCurves: 3,
      pinchMaxCurves: 4,
      maxMacroAxisRefs: 0,
      macroAxisMaxDistAtr: 1.0,
      topDownMaxDistAtr: 3.0,
      bandsHiddenByDefault: timeframe === '1W',
    };
  }
  if (timeframe === '4H' || timeframe === '1H' || timeframe === '65m' || timeframe === '30m') {
    return {
      timeframe,
      tier: 'INTRADAY_MID',
      baseMaxCurves: 4,
      pinchMaxCurves: 4,
      maxMacroAxisRefs: 0,
      macroAxisMaxDistAtr: 1.0,
      topDownMaxDistAtr: 2.5,
      bandsHiddenByDefault: false,
    };
  }
  return {
    timeframe,
    tier: 'INTRADAY_FAST',
    baseMaxCurves: 3,
    pinchMaxCurves: 3,
    maxMacroAxisRefs: 1,
    macroAxisMaxDistAtr: 1.0,
    topDownMaxDistAtr: 2.5,
    bandsHiddenByDefault: false,
  };
}

export function getFsmSemanticStyle(state: AvwapUiLifecycleState): AvwapFsmSemanticStyle {
  switch (state) {
    case 'ACTIVE_PRIMARY':
      return {
        state,
        badgeLabel: 'PRIMARY',
        opacity: 1.0,
        lineWidth: 2,
        lineStyle: 'SOLID',
        color: '#38BDF8',
        rgbaColor: 'rgba(56, 189, 248, 1.00)',
        emphasizeCorridor: false,
      };
    case 'ACTIVE_SECONDARY':
      return {
        state,
        badgeLabel: 'SECONDARY',
        opacity: 0.75,
        lineWidth: 1,
        lineStyle: 'SOLID',
        color: '#A78BFA',
        rgbaColor: 'rgba(167, 139, 250, 0.75)',
        emphasizeCorridor: false,
      };
    case 'PINCH_PAIR':
      return {
        state,
        badgeLabel: 'PINCH',
        opacity: 1.0,
        lineWidth: 2,
        lineStyle: 'SOLID',
        color: '#F59E0B',
        rgbaColor: 'rgba(245, 158, 11, 1.00)',
        emphasizeCorridor: true,
      };
    case 'DECAYING':
      return {
        state,
        badgeLabel: 'DECAYING',
        opacity: 0.4,
        lineWidth: 1,
        lineStyle: 'DOTTED',
        color: '#94A3B8',
        rgbaColor: 'rgba(148, 163, 184, 0.40)',
        emphasizeCorridor: false,
      };
    case 'CANDIDATE':
      return {
        state,
        badgeLabel: 'CANDIDATE',
        opacity: 0.4,
        lineWidth: 1,
        lineStyle: 'DOTTED',
        color: '#64748B',
        rgbaColor: 'rgba(100, 116, 139, 0.40)',
        emphasizeCorridor: false,
      };
    case 'ARCHIVED':
      return {
        state,
        badgeLabel: 'ARCHIVED',
        opacity: 0.25,
        lineWidth: 1,
        lineStyle: 'DOTTED',
        color: '#475569',
        rgbaColor: 'rgba(71, 85, 105, 0.25)',
        emphasizeCorridor: false,
      };
  }
}

export function mapDegradationFlag(flag: AvwapDegradationFlag): AvwapDegradationBadgeView {
  return {
    flag,
    label: DEGRADATION_FLAG_LABELS[flag],
    isHazard: flag === 'SHORT_GAMMA_BOUNCE_HAZARD',
  };
}

function statePriorityRank(state: AvwapUiLifecycleState): number {
  switch (state) {
    case 'PINCH_PAIR':
      return 0;
    case 'ACTIVE_PRIMARY':
      return 1;
    case 'ACTIVE_SECONDARY':
      return 2;
    case 'DECAYING':
      return 3;
    case 'CANDIDATE':
      return 4;
    case 'ARCHIVED':
      return 5;
  }
}

function compareAnchorCandidates(a: InstitutionalAvwapAnchorInput, b: InstitutionalAvwapAnchorInput): number {
  const rankDiff = statePriorityRank(a.lifecycleState) - statePriorityRank(b.lifecycleState);
  if (rankDiff !== 0) return rankDiff;

  const scoreA = isFiniteNumber(a.iass?.scoreConservative) ? a.iass.scoreConservative : -1;
  const scoreB = isFiniteNumber(b.iass?.scoreConservative) ? b.iass.scoreConservative : -1;
  if (scoreA !== scoreB) return scoreB - scoreA;

  const distA = isFiniteNumber(a.distanceAtr) ? Math.abs(a.distanceAtr) : Number.POSITIVE_INFINITY;
  const distB = isFiniteNumber(b.distanceAtr) ? Math.abs(b.distanceAtr) : Number.POSITIVE_INFINITY;
  if (distA !== distB) return distA - distB;

  return a.anchorId.localeCompare(b.anchorId);
}

function isMacroAxisFamily(family: AvwapUiAnchorFamily): family is 'CALENDAR_YTD' | 'IPO_DIRECT' {
  return family === 'CALENDAR_YTD' || family === 'IPO_DIRECT';
}

function buildHybridBandLevels(bands: InstitutionalAvwapBandsInput | null | undefined): readonly AvwapHybridBandLevelView[] {
  const specs: readonly {
    readonly key: AvwapHybridBandLevelView['key'];
    readonly sigma: 1 | 2 | 2.5;
    readonly direction: 'UPPER' | 'LOWER';
    readonly label: string;
    readonly shortLabel: string;
    readonly price: number | null | undefined;
  }[] = [
    { key: 'upper2_5', sigma: 2.5, direction: 'UPPER', label: '+2.5σ (~p95)', shortLabel: '+2.5σ', price: bands?.upper2_5 },
    { key: 'upper2', sigma: 2, direction: 'UPPER', label: '+2σ', shortLabel: '+2σ', price: bands?.upper2 },
    { key: 'upper1', sigma: 1, direction: 'UPPER', label: '+1σ', shortLabel: '+1σ', price: bands?.upper1 },
    { key: 'lower1', sigma: 1, direction: 'LOWER', label: '-1σ', shortLabel: '-1σ', price: bands?.lower1 },
    { key: 'lower2', sigma: 2, direction: 'LOWER', label: '-2σ', shortLabel: '-2σ', price: bands?.lower2 },
    { key: 'lower2_5', sigma: 2.5, direction: 'LOWER', label: '-2.5σ (~p95)', shortLabel: '-2.5σ', price: bands?.lower2_5 },
  ];

  return specs.map((spec) => {
    const isExtreme = spec.sigma === 2.5;
    const price = isFiniteNumber(spec.price) ? spec.price : null;
    return {
      key: spec.key,
      sigma: spec.sigma,
      direction: spec.direction,
      label: spec.label,
      shortLabel: spec.shortLabel,
      price,
      priceFormatted: formatAvwapNumber(price, 2),
      isCalibratedExtreme: isExtreme,
      emphasis: isExtreme ? 'CALIBRATED_EXTREME_P95' : 'STANDARD',
      color: isExtreme
        ? '#F59E0B'
        : spec.sigma === 2
          ? 'rgba(192, 132, 252, 0.72)'
          : 'rgba(148, 163, 184, 0.65)',
      lineStyle: isExtreme ? 'SOLID' : spec.sigma === 2 ? 'DASHED' : 'DOTTED',
    };
  });
}

function buildPinchPairs(
  sortedCandidates: readonly InstitutionalAvwapAnchorInput[],
): {
  readonly partnerById: ReadonlyMap<string, string>;
  readonly pairs: readonly (readonly [InstitutionalAvwapAnchorInput, InstitutionalAvwapAnchorInput])[];
} {
  const pinchPool = sortedCandidates.filter((a) => a.lifecycleState === 'PINCH_PAIR');
  const byId = new Map<string, InstitutionalAvwapAnchorInput>();
  for (const item of pinchPool) {
    byId.set(item.anchorId, item);
  }
  const paired = new Set<string>();
  const partnerById = new Map<string, string>();
  const pairs: [InstitutionalAvwapAnchorInput, InstitutionalAvwapAnchorInput][] = [];

  for (const item of pinchPool) {
    if (paired.has(item.anchorId)) continue;
    const targetId = item.pinchPartnerId ?? null;
    if (targetId !== null && targetId !== item.anchorId && !paired.has(targetId)) {
      const partner = byId.get(targetId);
      if (partner !== undefined) {
        paired.add(item.anchorId);
        paired.add(partner.anchorId);
        partnerById.set(item.anchorId, partner.anchorId);
        partnerById.set(partner.anchorId, item.anchorId);
        pairs.push([item, partner]);
      }
    }
  }

  const remaining = pinchPool.filter((item) => !paired.has(item.anchorId));
  for (let i = 0; i + 1 < remaining.length; i += 2) {
    const a = remaining[i];
    const b = remaining[i + 1];
    if (a !== undefined && b !== undefined) {
      paired.add(a.anchorId);
      paired.add(b.anchorId);
      partnerById.set(a.anchorId, b.anchorId);
      partnerById.set(b.anchorId, a.anchorId);
      pairs.push([a, b]);
    }
  }

  return { partnerById, pairs };
}

function buildGammaBadge(
  shortGammaBounceHazard: boolean,
  gammaRegime: AvwapGammaRegime,
): AvwapGammaBadgeView {
  if (shortGammaBounceHazard) {
    return {
      kind: 'SHORT_GAMMA_BOUNCE_HAZARD',
      tone: 'danger',
      shortLabel: 'SHORT GAMMA HAZARD',
      detail: 'Short Gamma: rebotes degradados, prima expansión/ruptura',
    };
  }
  switch (gammaRegime) {
    case 'POSITIVE_GAMMA':
      return {
        kind: 'POSITIVE_GAMMA',
        tone: 'positive',
        shortLabel: 'POSITIVE GAMMA',
        detail: 'Positive Gamma: amortiguación/absorción favorecida',
      };
    case 'NEGATIVE_GAMMA':
      return {
        kind: 'NEGATIVE_GAMMA',
        tone: 'warning',
        shortLabel: 'NEGATIVE GAMMA',
        detail: 'Negative Gamma: volatilidad expansiva',
      };
    case 'NEUTRAL':
      return {
        kind: 'NEUTRAL',
        tone: 'neutral',
        shortLabel: 'GAMMA NEUTRAL',
        detail: 'Gamma neutral',
      };
    case 'UNKNOWN':
      return {
        kind: 'UNKNOWN',
        tone: 'muted',
        shortLabel: 'GAMMA —',
        detail: 'Régimen gamma no disponible',
      };
  }
}

function buildVolRegimeBadge(volRegime: AvwapVolRegime): AvwapVolRegimeBadgeView {
  switch (volRegime) {
    case 'LOW_VOL_CHOP':
      return { regime: volRegime, label: 'Low Vol · Chop', tone: 'neutral' };
    case 'MID_VOL':
      return { regime: volRegime, label: 'Mid Vol', tone: 'info' };
    case 'HIGH_VOL_TREND':
      return { regime: volRegime, label: 'High Vol · Trend', tone: 'warning' };
    case 'UNKNOWN':
      return { regime: volRegime, label: 'Vol —', tone: 'muted' };
  }
}

function resolveDominantConfluence(
  bounce: number | null,
  breakout: number | null,
): { readonly mode: AvwapDominantConfluence; readonly label: string } {
  if (!isFiniteNumber(bounce) || !isFiniteNumber(breakout)) {
    return { mode: 'BALANCED', label: 'Equilibrado / sin sesgo' };
  }
  if (bounce - breakout >= 5) {
    return { mode: 'BOUNCE', label: 'Predomina Bounce / Absorción' };
  }
  if (breakout - bounce >= 5) {
    return { mode: 'BREAKOUT', label: 'Predomina Breakout / Expansión' };
  }
  return { mode: 'BALANCED', label: 'Confluencia equilibrada' };
}

export function buildInstitutionalAvwapContextViewModel(
  input: BuildAvwapContextViewModelInput,
): InstitutionalAvwapContextViewModel {
  const budgetRule = getVisualBudgetRule(input.activeTimeframe);
  const prefs = input.preferences ?? {};
  const ctx = input.context;

  if (ctx === null || ctx === undefined) {
    return {
      available: false,
      role: 'INSTITUTIONAL_CONTEXT_ONLY',
      timeframe: budgetRule.timeframe,
      budgetRule,
      effectiveMaxCurves: budgetRule.baseMaxCurves,
      shortGammaBounceHazard: false,
      gammaBadge: buildGammaBadge(false, 'UNKNOWN'),
      volRegimeBadge: buildVolRegimeBadge('UNKNOWN'),
      meanReversionContextActive: false,
      netGexNormalizedG: null,
      netGexNormalizedFormatted: '—',
      bounceScore: null,
      bounceScoreFormatted: '—',
      bounceBarPct: 0,
      breakoutScore: null,
      breakoutScoreFormatted: '—',
      breakoutBarPct: 0,
      dominantConfluence: 'BALANCED',
      dominantConfluenceLabel: 'Sin contexto disponible',
      alignedLevels: [],
      visibleAnchors: [],
      macroAxisRefs: [],
      opexCycleMarkers: [],
      pinchCorridor: null,
      focusedBands: {
        focusedAnchorId: null,
        focusedAnchorLabel: null,
        visible: false,
        hiddenReason: 'NO_FOCUSED_ANCHOR',
        calibratedExtremeNote: 'Extremo calibrado ±2.5σ (~p95 browniano)',
        levels: [],
      },
      degradationBadges: [],
      chartPriceLines: [],
    };
  }

  const rawAnchors = input.anchors ?? ctx.activeAnchors ?? [];
  const rawOpexDates = input.opexResetMarkerDates ?? ctx.opexResetMarkerDates ?? [];
  const blockedSet = new Set<AvwapUiAnchorFamily>(BLOCKED_NEGATIVE_CONTROL_FAMILIES);

  const postOpexAnchors: InstitutionalAvwapAnchorInput[] = [];
  const curvePool: InstitutionalAvwapAnchorInput[] = [];
  const macroPool: InstitutionalAvwapAnchorInput[] = [];

  for (const anchor of rawAnchors) {
    if (blockedSet.has(anchor.family)) {
      continue;
    }
    if (anchor.lifecycleState === 'ARCHIVED' || anchor.lifecycleState === 'CANDIDATE') {
      continue;
    }
    if (anchor.family === 'POST_OPEX') {
      postOpexAnchors.push(anchor);
      continue;
    }
    if (budgetRule.tier === 'INTRADAY_FAST' && isMacroAxisFamily(anchor.family)) {
      if (isFiniteNumber(anchor.distanceAtr) && Math.abs(anchor.distanceAtr) < budgetRule.macroAxisMaxDistAtr) {
        macroPool.push(anchor);
      }
      continue;
    }
    if (!isFiniteNumber(anchor.distanceAtr) || Math.abs(anchor.distanceAtr) > budgetRule.topDownMaxDistAtr) {
      continue;
    }
    curvePool.push(anchor);
  }

  const opexCycleMarkers: AvwapOpexCycleMarkerView[] = [];
  if (prefs.showOpexResetMarker === true) {
    const seenOpexKeys = new Set<string>();
    for (const anchor of postOpexAnchors) {
      const key = `${anchor.anchorId}:${anchor.anchorDate ?? ''}`;
      if (seenOpexKeys.has(key)) continue;
      seenOpexKeys.add(key);
      const avwap = isFiniteNumber(anchor.avwap) ? anchor.avwap : null;
      opexCycleMarkers.push({
        id: anchor.anchorId,
        markerKind: 'OPEX_CYCLE_MARKER',
        isSupportResistance: false,
        label: anchor.label ?? 'OpEx Reset Cycle',
        dateLabel: anchor.anchorDate ?? null,
        avwap,
        avwapFormatted: formatAvwapNumber(avwap, 2),
      });
    }
    for (const dateStr of rawOpexDates) {
      if (opexCycleMarkers.some((m) => m.dateLabel === dateStr)) continue;
      opexCycleMarkers.push({
        id: `opex-date:${dateStr}`,
        markerKind: 'OPEX_CYCLE_MARKER',
        isSupportResistance: false,
        label: 'OpEx Reset Cycle',
        dateLabel: dateStr,
        avwap: null,
        avwapFormatted: '—',
      });
    }
  }

  const macroAxisRefs: AvwapMacroAxisRefView[] = macroPool
    .slice()
    .sort((a, b) => {
      const distA = isFiniteNumber(a.distanceAtr) ? Math.abs(a.distanceAtr) : Number.POSITIVE_INFINITY;
      const distB = isFiniteNumber(b.distanceAtr) ? Math.abs(b.distanceAtr) : Number.POSITIVE_INFINITY;
      if (distA !== distB) return distA - distB;
      if (a.family !== b.family) return a.family === 'CALENDAR_YTD' ? -1 : 1;
      return a.anchorId.localeCompare(b.anchorId);
    })
    .slice(0, budgetRule.maxMacroAxisRefs)
    .map((anchor) => {
      const family: 'CALENDAR_YTD' | 'IPO_DIRECT' = anchor.family === 'IPO_DIRECT' ? 'IPO_DIRECT' : 'CALENDAR_YTD';
      const shortLabel: 'YTD' | 'IPO' = family === 'IPO_DIRECT' ? 'IPO' : 'YTD';
      const avwap = isFiniteNumber(anchor.avwap) ? anchor.avwap : null;
      const dist = isFiniteNumber(anchor.distanceAtr) ? anchor.distanceAtr : 0;
      return {
        anchorId: anchor.anchorId,
        family,
        shortLabel,
        label: anchor.label ?? ANCHOR_FAMILY_LABELS[family].full,
        avwap,
        avwapFormatted: formatAvwapNumber(avwap, 2),
        distanceAtr: dist,
        absDistanceAtr: Math.abs(dist),
        distanceAtrFormatted: formatAvwapSignedNumber(dist, 2, ' ATR'),
        representation: 'DISCRETE_AXIS_LABEL',
        isFullCurve: false,
      };
    });

  const sortedCurvePool = curvePool.slice().sort(compareAnchorCandidates);
  const { partnerById, pairs } = buildPinchPairs(sortedCurvePool);
  const hasActivePinchPair = pairs.length > 0;
  const effectiveMaxCurves =
    budgetRule.tier === 'WEEKLY_DAILY' && hasActivePinchPair
      ? budgetRule.pinchMaxCurves
      : budgetRule.baseMaxCurves;

  const selectedRaw: InstitutionalAvwapAnchorInput[] = [];
  const selectedIds = new Set<string>();
  const rawById = new Map<string, InstitutionalAvwapAnchorInput>();
  for (const item of sortedCurvePool) {
    rawById.set(item.anchorId, item);
  }

  for (const candidate of sortedCurvePool) {
    if (selectedRaw.length >= effectiveMaxCurves) break;
    if (selectedIds.has(candidate.anchorId)) continue;

    const partnerId = partnerById.get(candidate.anchorId);
    if (partnerId !== undefined && !selectedIds.has(partnerId)) {
      const partner = rawById.get(partnerId);
      if (partner !== undefined) {
        if (selectedRaw.length + 2 <= effectiveMaxCurves) {
          selectedRaw.push(candidate, partner);
          selectedIds.add(candidate.anchorId);
          selectedIds.add(partner.anchorId);
        }
        continue;
      }
    }

    selectedRaw.push(candidate);
    selectedIds.add(candidate.anchorId);
  }

  let focusedAnchorRaw: InstitutionalAvwapAnchorInput | null = null;
  if (prefs.focusedAnchorId !== undefined && prefs.focusedAnchorId !== null) {
    focusedAnchorRaw = selectedRaw.find((a) => a.anchorId === prefs.focusedAnchorId) ?? null;
  } else if (prefs.showFocusedBands === true && selectedRaw.length > 0) {
    focusedAnchorRaw =
      selectedRaw.find((a) => a.lifecycleState === 'ACTIVE_PRIMARY') ??
      selectedRaw.find((a) => a.lifecycleState === 'PINCH_PAIR') ??
      selectedRaw[0] ??
      null;
  }

  const visibleAnchors: AvwapAnchorViewItem[] = selectedRaw.map((anchor) => {
    const familyMeta = ANCHOR_FAMILY_LABELS[anchor.family];
    const style = getFsmSemanticStyle(anchor.lifecycleState);
    const avwap = isFiniteNumber(anchor.avwap) ? anchor.avwap : null;
    const distanceAtr = isFiniteNumber(anchor.distanceAtr) ? anchor.distanceAtr : null;
    const absDistanceAtr = distanceAtr !== null ? Math.abs(distanceAtr) : null;
    const zScorePath = isFiniteNumber(anchor.zScorePath) ? anchor.zScorePath : null;
    const cohortSurvival = isFiniteNumber(anchor.cohortSurvival) ? anchor.cohortSurvival : null;
    const floatIsNonPit = anchor.floatIsNonPit === true || (anchor.degradationFlags?.includes('FLOAT_NON_PIT_SNAPSHOT') ?? false);
    const scoreCons = isFiniteNumber(anchor.iass?.scoreConservative) ? anchor.iass.scoreConservative : null;
    const dataCov = isFiniteNumber(anchor.iass?.dataCoverage) ? anchor.iass.dataCoverage : null;
    const pillars = anchor.iass?.pillarScores;

    return {
      anchorId: anchor.anchorId,
      family: anchor.family,
      familyLabel: familyMeta.full,
      shortTag: familyMeta.short,
      polarity: anchor.polarity ?? 'NEUTRAL',
      label: anchor.label ?? familyMeta.full,
      anchorDate: anchor.anchorDate ?? null,
      avwap,
      avwapFormatted: formatAvwapNumber(avwap, 2),
      distanceAtr,
      absDistanceAtr,
      distanceAtrFormatted: formatAvwapSignedNumber(distanceAtr, 2, ' ATR'),
      zScorePath,
      zScorePathFormatted: formatAvwapSignedNumber(zScorePath, 2, 'σ'),
      lifecycleState: anchor.lifecycleState,
      fsmBadgeLabel: style.badgeLabel,
      pinchPartnerId: partnerById.get(anchor.anchorId) ?? anchor.pinchPartnerId ?? null,
      isPinchMember: anchor.lifecycleState === 'PINCH_PAIR' && partnerById.has(anchor.anchorId),
      isFocused: focusedAnchorRaw?.anchorId === anchor.anchorId,
      style,
      decayReasons: (anchor.decayReasons ?? []).map((code) => ({
        code,
        label: DECAY_REASON_LABELS[code],
      })),
      cohortSurvival,
      cohortSurvivalPctFormatted: formatAvwapPercent(cohortSurvival, true, 1),
      floatIsNonPit,
      floatNonPitNote: floatIsNonPit ? 'non-PIT' : null,
      iassScoreConservative: scoreCons,
      iassConservativeFormatted: formatAvwapScore(scoreCons),
      iassDataCoverage: dataCov,
      iassCoveragePctFormatted: formatAvwapPercent(dataCov, true, 0),
      iassPillarsFormatted: {
        M: formatAvwapScore(pillars?.M),
        D: formatAvwapScore(pillars?.D),
        F: formatAvwapScore(pillars?.F),
        S: formatAvwapScore(pillars?.S),
      },
      bandSource: anchor.bands?.bandSource ?? null,
      bandsLevels: buildHybridBandLevels(anchor.bands),
    };
  });

  let pinchCorridor: AvwapPinchCorridorView | null = null;
  const firstVisiblePair = pairs.find(
    ([a, b]) => selectedIds.has(a.anchorId) && selectedIds.has(b.anchorId),
  );
  if (firstVisiblePair !== undefined) {
    const [a, b] = firstVisiblePair;
    if (isFiniteNumber(a.avwap) && isFiniteNumber(b.avwap)) {
      const lowPrice = Math.min(a.avwap, b.avwap);
      const highPrice = Math.max(a.avwap, b.avwap);
      const spreadAtr =
        isFiniteNumber(a.distanceAtr) && isFiniteNumber(b.distanceAtr)
          ? Math.abs(a.distanceAtr - b.distanceAtr)
          : null;
      pinchCorridor = {
        anchorIds: [a.anchorId, b.anchorId],
        lowPrice,
        highPrice,
        lowFormatted: formatAvwapNumber(lowPrice, 2),
        highFormatted: formatAvwapNumber(highPrice, 2),
        spreadAtr,
        spreadAtrFormatted: spreadAtr !== null ? `${formatAvwapNumber(spreadAtr, 2)} ATR` : '—',
        label: `${ANCHOR_FAMILY_LABELS[a.family].short} ↔ ${ANCHOR_FAMILY_LABELS[b.family].short}`,
      };
    }
  }

  const focusedViewItem =
    focusedAnchorRaw !== null
      ? visibleAnchors.find((item) => item.anchorId === focusedAnchorRaw.anchorId) ?? null
      : null;

  let bandsVisible = false;
  let hiddenReason: AvwapFocusedBandsView['hiddenReason'] = null;
  if (focusedViewItem === null) {
    hiddenReason = 'NO_FOCUSED_ANCHOR';
  } else if (budgetRule.bandsHiddenByDefault) {
    bandsVisible = prefs.showWeeklyBandsOverride === true;
    hiddenReason = bandsVisible ? null : 'WEEKLY_HIDDEN_BY_DEFAULT';
  } else if (prefs.showFocusedBands === false) {
    bandsVisible = false;
    hiddenReason = 'TOGGLED_OFF';
  } else {
    bandsVisible = true;
  }

  const focusedBands: AvwapFocusedBandsView = {
    focusedAnchorId: focusedViewItem?.anchorId ?? null,
    focusedAnchorLabel: focusedViewItem?.label ?? null,
    visible: bandsVisible,
    hiddenReason,
    calibratedExtremeNote: 'Extremo calibrado ±2.5σ (~p95 browniano)',
    levels: focusedViewItem?.bandsLevels ?? [],
  };

  const netG = isFiniteNumber(ctx.netGexNormalizedG) ? ctx.netGexNormalizedG : null;
  const shortGammaBounceHazard =
    ctx.hazardFlags.includes('SHORT_GAMMA_BOUNCE_HAZARD') ||
    ctx.flags.includes('SHORT_GAMMA_BOUNCE_HAZARD') ||
    (ctx.degradationFlags?.includes('SHORT_GAMMA_BOUNCE_HAZARD') ?? false) ||
    (netG !== null && netG < -0.3);

  const bounceScore = isFiniteNumber(ctx.bounceConfluenceScore) ? ctx.bounceConfluenceScore : null;
  const breakoutScore = isFiniteNumber(ctx.breakoutConfluenceScore) ? ctx.breakoutConfluenceScore : null;
  const dominance = resolveDominantConfluence(bounceScore, breakoutScore);

  const alignedLevels: AvwapAlignedLevelChipView[] = ctx.alignedLevels.map((lvl) => {
    const price = isFiniteNumber(lvl.price) ? lvl.price : null;
    const distanceAtr = isFiniteNumber(lvl.distanceAtr) ? lvl.distanceAtr : null;
    const kernelWeight = isFiniteNumber(lvl.kernelWeight) ? lvl.kernelWeight : null;
    return {
      levelType: lvl.levelType,
      label: ALIGNED_LEVEL_LABELS[lvl.levelType],
      price,
      priceFormatted: formatAvwapNumber(price, 2),
      distanceAtr,
      distanceAtrFormatted: distanceAtr !== null ? `${formatAvwapNumber(distanceAtr, 2)} ATR` : '—',
      kernelWeight,
      kernelWeightFormatted: formatAvwapNumber(kernelWeight, 2),
    };
  });

  const combinedFlags = new Set<AvwapDegradationFlag>();
  for (const flag of ctx.flags) combinedFlags.add(flag);
  for (const flag of ctx.degradationFlags ?? []) combinedFlags.add(flag);
  for (const flag of ctx.hazardFlags) combinedFlags.add(flag);
  for (const anchor of selectedRaw) {
    for (const flag of anchor.degradationFlags ?? []) combinedFlags.add(flag);
  }
  if (shortGammaBounceHazard) {
    combinedFlags.add('SHORT_GAMMA_BOUNCE_HAZARD');
  }

  const degradationBadges = Array.from(combinedFlags)
    .sort()
    .map(mapDegradationFlag);

  const chartPriceLines: InstitutionalAvwapChartPriceLine[] = [];
  for (const item of visibleAnchors) {
    if (isFiniteNumber(item.avwap) && item.avwap > 0) {
      chartPriceLines.push({
        id: `anchor:${item.anchorId}`,
        kind: 'ANCHOR_LEVEL',
        price: item.avwap,
        title: `${item.shortTag} (${item.fsmBadgeLabel})`,
        color: item.style.rgbaColor,
        lineWidth: item.style.lineWidth,
        lineStyle: item.style.lineStyle,
        lineVisible: true,
        axisLabelVisible: true,
        opacity: item.style.opacity,
      });
    }
  }
  for (const macro of macroAxisRefs) {
    if (isFiniteNumber(macro.avwap) && macro.avwap > 0) {
      chartPriceLines.push({
        id: `macro:${macro.anchorId}`,
        kind: 'MACRO_AXIS_REF',
        price: macro.avwap,
        title: `${macro.shortLabel} (macro)`,
        color: '#94A3B8',
        lineWidth: 1,
        lineStyle: 'DOTTED',
        lineVisible: false,
        axisLabelVisible: true,
        opacity: 0.8,
      });
    }
  }
  if (focusedBands.visible) {
    for (const band of focusedBands.levels) {
      if ((band.sigma === 2 || band.sigma === 2.5) && isFiniteNumber(band.price) && band.price > 0) {
        chartPriceLines.push({
          id: `band:${focusedBands.focusedAnchorId ?? 'focus'}:${band.key}`,
          kind: 'FOCUSED_BAND',
          price: band.price,
          title: `${focusedViewItem?.shortTag ?? 'AVWAP'} ${band.label}`,
          color: band.color,
          lineWidth: 1,
          lineStyle: band.sigma === 2.5 ? 'DOTTED' : 'DASHED',
          lineVisible: true,
          axisLabelVisible: true,
          opacity: band.sigma === 2.5 ? 0.9 : 0.65,
        });
      }
    }
  }

  return {
    available: true,
    role: ctx.role,
    timeframe: budgetRule.timeframe,
    budgetRule,
    effectiveMaxCurves,
    shortGammaBounceHazard,
    gammaBadge: buildGammaBadge(shortGammaBounceHazard, ctx.gammaRegime),
    volRegimeBadge: buildVolRegimeBadge(ctx.volRegime),
    meanReversionContextActive: ctx.meanReversionContextActive,
    netGexNormalizedG: netG,
    netGexNormalizedFormatted: formatAvwapSignedNumber(netG, 2),
    bounceScore,
    bounceScoreFormatted: formatAvwapScore(bounceScore),
    bounceBarPct: bounceScore !== null ? Math.max(0, Math.min(100, bounceScore)) : 0,
    breakoutScore,
    breakoutScoreFormatted: formatAvwapScore(breakoutScore),
    breakoutBarPct: breakoutScore !== null ? Math.max(0, Math.min(100, breakoutScore)) : 0,
    dominantConfluence: dominance.mode,
    dominantConfluenceLabel: dominance.label,
    alignedLevels,
    visibleAnchors,
    macroAxisRefs,
    opexCycleMarkers,
    pinchCorridor,
    focusedBands,
    degradationBadges,
    chartPriceLines,
  };
}
