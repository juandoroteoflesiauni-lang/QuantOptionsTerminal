import type {
  AvwapAnchorFamily,
  AvwapContextPolicy,
  AvwapFamilyPolicyRule,
  MultiTimeframeAvwapConfig,
} from './types.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== null && typeof prop === 'object') {
        deepFreeze(prop);
      }
    }
  }
  return value;
}

/**
 * Empirically sealed Phase 2 Institutional Context & Confluence Policy matching
 * `research/avwap_oracle/spec/avwap_context_policy.json` verbatim.
 */
export const DEFAULT_AVWAP_CONTEXT_POLICY: AvwapContextPolicy = deepFreeze({
  policyVersion: 'avwap_context_policy_v1_2026_11_25',
  sourceOracleConfigVersion: 'oracle_axis5_v2_sealed_2026_11_25',
  sourceStudy: 'Prompt #6 56-Symbol Statistical Falsification Oracle (B=2000, seed=42)',
  mode: 'INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY',
  autonomousTier1EntrySignalsEnabled: false,
  earningsImpliedMoveContract:
    'orats_summaries.impliedEarningsMove primary (cores_implied_earnings_move_dec identical-field fallback); NEVER fuse impErnMv.',
  coreContext: [
    {
      family: 'SESSION_VWAP',
      tier: 'CORE_CONTEXT',
      empiricalGateStatus: 'CORE_INTRADAY_BENCHMARK',
      enabledByDefault: true,
      minIassConservative: null,
      pinchEligible: true,
      notes:
        'Intraday RTH 09:30 ET institutional anchor with hybrid/Welford bands (+-1sigma, +-2sigma, +-2.5sigma).',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'CALENDAR_YTD',
      tier: 'CORE_CONTEXT',
      empiricalGateStatus: 'TIER_2_CONTEXT_ONLY',
      enabledByDefault: true,
      minIassConservative: null,
      pinchEligible: true,
      notes:
        'Only family with 8/8 positive Walk-Forward OOS folds and H=3 z=+2.518 (p_raw=0.0085), H=5 p_raw=0.0380.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'EARNINGS_BLOWOUT',
      tier: 'CORE_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE_AUTONOMOUS_CONTEXT_CORE',
      enabledByDefault: true,
      minIassConservative: null,
      pinchEligible: true,
      notes:
        '|r_ern| / impliedEarningsMove >= 1.25 via orats_summaries.impliedEarningsMove (never impErnMv); +0.255 ATR / +39 bps spread vs EARNINGS_INLINE.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'IPO_DIRECT',
      tier: 'CORE_CONTEXT',
      empiricalGateStatus: 'ACCOUNTING_IDENTITY_AGE_LT_2Y',
      enabledByDefault: true,
      minIassConservative: null,
      pinchEligible: true,
      notes: 'Structural cost-basis identity anchor active when instrument listing age < 2 years.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
  ],
  eventAndStructuralContext: [
    {
      family: 'CALENDAR_QTD',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes:
        'Quarter-to-date institutional cost basis; visible when IASS_conservative >= 55 or in PINCH_PAIR.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'VOLUME_CLIMAX',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes: 'Causal climax capitulation anchor; visible when IASS_conservative >= 55 or in PINCH_PAIR.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'BREAKAWAY_GAP',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes: 'Causal breakaway gap anchor; visible when IASS_conservative >= 55 or in PINCH_PAIR.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'MACRO_SHOCK',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes:
        'Restricted to US_ETFs with live ORATS WHAM coverage (SPY/QQQ/IWM); emit MISSING_WHAM_COVERAGE on DIA/XLK/XLF.',
      whamSupportedEtfs: ['SPY', 'QQQ', 'IWM'],
      whamUnsupportedEtfs: ['DIA', 'XLK', 'XLF'],
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'SECONDARY_OFFERING',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'INSUFFICIENT_SAMPLE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes: 'Confirmed executed offering anchored strictly on SEC acceptedDate ET (never bare S-3/S-3ASR shelf).',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'INDEX_REBAL',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'INSUFFICIENT_SAMPLE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes: 'Verified S&P500 / Nasdaq constituent inclusion/exclusion anchor.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'OPTIONS_FLOW_SHOCK',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes:
        'Tagged NO_NBBO_AGGRESSOR_SIDE (net_directional_premium=null in OPRA feed); context/confluence only.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
    {
      family: 'SWING_CAUSAL',
      tier: 'EVENT_AND_STRUCTURAL_CONTEXT',
      empiricalGateStatus: 'REJECT_NO_EDGE',
      enabledByDefault: true,
      minIassConservative: 55.0,
      pinchEligible: true,
      notes: 'Strict rvol_z >= 1.5 causal pivot used primarily to form PINCH_PAIR corridors and IASS >= 55 structure.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: false,
    },
  ],
  demotedOrDisabledByDefault: [
    {
      family: 'POST_OPEX',
      tier: 'DEMOTED_OR_DISABLED_BY_DEFAULT',
      empiricalGateStatus: 'REJECT_NO_EDGE_REFUTED',
      enabledByDefault: false,
      minIassConservative: null,
      pinchEligible: false,
      notes:
        'Refuted as standalone S/R level in Prompt #6 (z_lift=-3.271, p_raw=0.9995, n=3485); optional OpEx cycle reset marker only.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: false,
      showOpexResetMarker: false,
      blockedNegativeControl: false,
    },
    {
      family: 'EARNINGS_INLINE',
      tier: 'DEMOTED_OR_DISABLED_BY_DEFAULT',
      empiricalGateStatus: 'NEGATIVE_CONTROL_PASS_PRUNED',
      enabledByDefault: false,
      minIassConservative: null,
      pinchEligible: false,
      notes: 'Confirmed negative control (obs_aer=-0.1151, q_BH=0.9995); blocked/pruned in production UI.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: true,
    },
    {
      family: 'SWING_NO_RVOL',
      tier: 'DEMOTED_OR_DISABLED_BY_DEFAULT',
      empiricalGateStatus: 'NEGATIVE_CONTROL_PASS_PRUNED',
      enabledByDefault: false,
      minIassConservative: null,
      pinchEligible: false,
      notes: 'Confirmed negative control (obs_aer=-0.0461, q_BH=0.9995); blocked/pruned in production UI.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: true,
    },
    {
      family: 'EX_DIVIDEND_REGULAR',
      tier: 'DEMOTED_OR_DISABLED_BY_DEFAULT',
      empiricalGateStatus: 'NEGATIVE_CONTROL_PASS_PRUNED',
      enabledByDefault: false,
      minIassConservative: null,
      pinchEligible: false,
      notes: 'Confirmed negative control (obs_aer=-0.2275, q_BH=0.9995); blocked/pruned in production UI.',
      whamSupportedEtfs: null,
      whamUnsupportedEtfs: null,
      enabledAsSrDefault: null,
      showOpexResetMarker: null,
      blockedNegativeControl: true,
    },
  ],
  visualBudget: {
    weeklyDailyBase: 3,
    weeklyDailyPinchBonus: 1,
    intradayMidBase: 4,
    intradayFastBase: 3,
    intradayFastMacroRefBonus: 1,
    intradayMacroRefMaxDistAtr: 1.0,
    topDownBoundDailyAtr: 3.0,
    topDownBoundIntradayAtr: 2.5,
  },
  regimeModifiers: {
    kernelSigmaAtr: 0.35,
    gexScaleDollarVolFrac: 0.01,
    shortGammaHazardGThreshold: -0.3,
    shortGammaHazardFlag: 'SHORT_GAMMA_BOUNCE_HAZARD',
    positiveGammaWallOrVpMaxDistAtr: 0.25,
    spyIvLowChopMax: 0.15,
    spyIvMidMax: 0.25,
    negativeGammaEvidence:
      'Prompt #6 (56 tickers): Win 2:1 drops from 35.1% (POSITIVE_GAMMA) to 26.7% (NEGATIVE_GAMMA), net_20bps=-65.4 bps',
    highVolEvidence:
      'Prompt #6 (56 tickers): SPY iv30d > 0.25 reaches Mean AER=+0.7922, Win 2:1=36.5%, net_20bps=+59.5 bps',
  },
  mandatoryDegradationFlags: [
    'FLOAT_NON_PIT_SNAPSHOT',
    'NO_ORATS_COVERAGE',
    'ORATS_OI_FALLBACK_MASSIVE',
    'MISSING_WHAM_COVERAGE',
    'NO_NBBO_AGGRESSOR_SIDE',
    'NO_NOI_IMBALANCE_FEED',
    'CORP_ACTION_CONFLICT_QUARANTINED',
  ],
} as const satisfies AvwapContextPolicy);

export const DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG: MultiTimeframeAvwapConfig = deepFreeze({
  mode: DEFAULT_AVWAP_CONTEXT_POLICY.mode,
  policyVersion: DEFAULT_AVWAP_CONTEXT_POLICY.policyVersion,
  visualBudgetByTimeframe: {
    '1W': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.weeklyDailyBase,
    '1D': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.weeklyDailyBase,
    '4H': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayMidBase,
    '1H': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayMidBase,
    '65m': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayMidBase,
    '30m': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayMidBase,
    '15m': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayFastBase,
    '5m': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayFastBase,
    '1m': DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.intradayFastBase,
  },
  topDownMaxDistanceAtr: {
    daily: DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.topDownBoundDailyAtr,
    intraday: DEFAULT_AVWAP_CONTEXT_POLICY.visualBudget.topDownBoundIntradayAtr,
  },
  pinchPairAllowsExtraSlot: true,
  postOpexShowResetMarkerDefault: false,
  blockedNegativeControls: ['EARNINGS_INLINE', 'SWING_NO_RVOL', 'EX_DIVIDEND_REGULAR'],
  liveMergeThrottleMs: 50,
} as const satisfies MultiTimeframeAvwapConfig);

/** Lookup policy metadata for any anchor family under the sealed Phase 2 policy. */
export function getAvwapFamilyPolicyRule(
  family: AvwapAnchorFamily,
  policy: AvwapContextPolicy = DEFAULT_AVWAP_CONTEXT_POLICY,
): AvwapFamilyPolicyRule | undefined {
  for (const group of [
    policy.coreContext,
    policy.eventAndStructuralContext,
    policy.demotedOrDisabledByDefault,
  ]) {
    const match = group.find((rule) => rule.family === family);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}
