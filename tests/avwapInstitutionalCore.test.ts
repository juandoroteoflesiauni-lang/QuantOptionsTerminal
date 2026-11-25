import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVWAP_CONTEXT_POLICY,
  DEFAULT_IASS_CONFIG,
  DEFAULT_LIFECYCLE_CONFIG,
  DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG,
  applySpecialDividendO1,
  applySplitO1,
  atrGaussianKernel,
  combineMomentStates,
  commitClosedMinuteO1,
  computeConfluenceContext,
  computeHybridBands,
  computeIass,
  computeInstitutionalVannaCharm,
  createLiveBarAccumulator,
  createRollingChopTracker,
  createSlopeRingBuffer,
  estimateParkinsonM2Within,
  evaluateChopSaturation,
  evaluateFlatSlope,
  getAvwapFamilyPolicyRule,
  getNormalizedSlopeO1,
  hasAdjustmentRevisionChanged,
  ingestLiveTickO1,
  normalizeNetGex,
  projectAnchorLiveO1,
  pushSlopeRingBufferO1,
  rollupBarsToMoments,
  runLifecycleFsm,
  stepRollingChopO1,
  type AnchorSeriesInput,
  type AvwapAnchorFamily,
  type AvwapLifecycleState,
  type Bar,
} from '../src/core/avwap/index.js';
import { normCdf } from '../src/core/options/math.js';
import { usHistoricalSession } from '../src/core/usHistorical.js';
import {
  createInitialWelfordState,
  getWelfordOutput,
  type WelfordState,
} from '../src/core/welford.js';

interface FixtureMomentSummary {
  readonly W: number;
  readonly mu: number;
  readonly M2: number;
  readonly std_dev: number;
  readonly buckets?: number;
}

interface FixtureSplitAdjustedTf {
  readonly accepted_1m_rows: number;
  readonly buckets_count: number;
  readonly final_avwap_mu: number;
  readonly final_avwap_sd: number;
  readonly final_cum_M2: number;
  readonly final_cum_W: number;
}

interface FixtureEarningsCase {
  readonly anchor_id: string;
  readonly family: AvwapAnchorFamily;
  readonly polarity: 'LONG' | 'SHORT' | 'NEUTRAL';
  readonly react_date: string;
  readonly anchor_idx: number;
  readonly activated_idx: number;
  readonly data_coverage: number;
  readonly is_negative_control: boolean;
  readonly score_renormalized: number;
  readonly score_conservative: number;
  readonly tier: 'TIER_1' | 'TIER_2' | 'NOISE' | 'INSUFFICIENT_DATA';
  readonly component_scores: Readonly<Record<string, number | null>>;
  readonly pillar_scores: Readonly<Record<string, number | null>>;
  readonly degradation_reasons: readonly string[];
}

interface FixtureHybridBandRow {
  readonly elapsed_trading_days: number;
  readonly trade_date: string;
  readonly W: number;
  readonly avwap_mu: number;
  readonly welford_sd: number;
  readonly or_iv_xern_20d_dec: number | null;
  readonly alpha: number;
  readonly sigma_orats_path: number | null;
  readonly sigma_hybrid: number;
  readonly upper_1: number;
  readonly lower_1: number;
  readonly upper_2: number;
  readonly lower_2: number;
  readonly upper_2_5: number;
  readonly lower_2_5: number;
  readonly band_source: 'HYBRID_ORATS_WELFORD' | 'WELFORD_ONLY_FALLBACK';
}

interface FixtureConfluenceScenario {
  readonly bounce_confluence: number;
  readonly breakout_confluence: number;
  readonly net_gex_normalized_g: number;
  readonly g0_dollar_vol_scale: number;
  readonly gamma_regime: 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA' | 'NEUTRAL' | 'UNKNOWN';
  readonly vol_regime: 'LOW_VOL_CHOP' | 'MID_VOL' | 'HIGH_VOL_TREND' | 'UNKNOWN';
  readonly mean_reversion_context_active: boolean;
  readonly hazard_flags: readonly string[];
  readonly degradation_flags: readonly string[];
  readonly spatial_kernels: Readonly<Record<string, number>>;
}

interface FixtureBsmGreeks {
  readonly contract_type: 'call' | 'put';
  readonly spot: number;
  readonly strike: number;
  readonly dte_days: number;
  readonly time_to_expiry_years: number;
  readonly smv_vol: number;
  readonly risk_free: number;
  readonly residual_rate: number;
  readonly dividend_yield_q: number;
  readonly d1: number;
  readonly d2: number;
  readonly price: number;
  readonly delta: number;
  readonly gamma: number;
  readonly vega: number;
  readonly vanna: number;
  readonly charm: number;
  readonly charm_daily: number;
}

interface FixtureFsmTransition {
  readonly anchor_id: string;
  readonly previous_state: AvwapLifecycleState;
  readonly next_state: AvwapLifecycleState;
  readonly transition_reason: string;
  readonly effective_ts: number;
  readonly score_at_transition: number;
}

interface FixtureFsmSequence {
  readonly bar_count: number;
  readonly transitions: readonly FixtureFsmTransition[];
  readonly final_states: Readonly<Record<string, AvwapLifecycleState>>;
}

interface Phase2GoldenFixtures {
  readonly schema_version: string;
  readonly generated_offline: boolean;
  readonly source_policy_version: string;
  readonly case1_nvda_split_and_earnings: {
    readonly split_window_2024_06_05_to_12: {
      readonly split_event: {
        readonly split_from: number;
        readonly split_to: number;
        readonly k_factor: number;
      };
      readonly o1_split_step_proof_1d: {
        readonly pre_split_cum_2024_06_07: FixtureMomentSummary;
        readonly post_split_o1_2024_06_10_open: FixtureMomentSummary;
      };
      readonly daily_moments_by_tf: Readonly<
        Record<string, Readonly<Record<string, FixtureMomentSummary>>>
      >;
      readonly cumulative_split_adjusted_by_tf: Readonly<Record<string, FixtureSplitAdjustedTf>>;
      readonly cross_tf_parity_max_mu_bps: number;
      readonly cross_tf_parity_max_sd_bps: number;
    };
    readonly earnings_comparison: {
      readonly blowout_2024_02_21_amc: FixtureEarningsCase;
      readonly inline_2024_11_20_amc: FixtureEarningsCase;
    };
  };
  readonly case2_spy_ytd_wham_oi_gex_bsm: {
    readonly calendar_ytd_2024_hybrid_bands: readonly FixtureHybridBandRow[];
    readonly confluence_scenarios: {
      readonly controlled_parity_pair_pos: FixtureConfluenceScenario;
      readonly controlled_parity_pair_neg: FixtureConfluenceScenario;
      readonly real_positive_gamma_2026_10_15: FixtureConfluenceScenario;
      readonly real_negative_gamma_2026_11_19: FixtureConfluenceScenario;
    };
    readonly bsm_second_order_greeks: {
      readonly call_720: FixtureBsmGreeks;
      readonly put_720: FixtureBsmGreeks;
    };
  };
  readonly case3_meli_adr_bayesian_degradation: {
    readonly with_orats: {
      readonly family: AvwapAnchorFamily;
      readonly data_coverage: number;
      readonly score_renormalized: number;
      readonly score_conservative: number;
      readonly tier: 'TIER_1' | 'TIER_2' | 'NOISE' | 'INSUFFICIENT_DATA';
      readonly pillar_scores: Readonly<Record<string, number>>;
    };
    readonly without_orats_simulated_degradation: {
      readonly data_coverage: number;
      readonly score_renormalized: number;
      readonly score_conservative: number;
      readonly expected_bayesian_shrinkage: number;
      readonly prior: number;
      readonly degradation_flag: string;
      readonly degradation_reasons: readonly string[];
    };
  };
  readonly case4_cost_special_vs_regular_dividend: {
    readonly special_dividend_2023_12_27: {
      readonly cash_amount: number;
      readonly prev_close: number;
      readonly d_factor: number;
      readonly applied: boolean;
      readonly pre_state: FixtureMomentSummary;
      readonly post_state: FixtureMomentSummary;
    };
    readonly regular_dividend_2026_05_01: {
      readonly cash_amount: number;
      readonly prev_close: number;
      readonly applied: boolean;
      readonly pre_state: FixtureMomentSummary;
      readonly post_state: FixtureMomentSummary;
    };
  };
  readonly case5_fsm_pinch_breakout_resurrection: {
    readonly pinch_breakout_cohort_decay_15bars: FixtureFsmSequence;
    readonly chop_saturation_archival_15bars: FixtureFsmSequence;
    readonly flat_decay_breakout_resurrection_25bars: FixtureFsmSequence;
  };
}

interface PolicyJsonDocument {
  readonly policy_version: string;
  readonly source_oracle_config_version: string;
  readonly mode: string;
  readonly autonomous_tier1_entry_signals_enabled: boolean;
  readonly core_context: readonly { readonly family: string; readonly enabled_by_default: boolean }[];
  readonly event_and_structural_context: readonly {
    readonly family: string;
    readonly min_iass_conservative: number | null;
  }[];
  readonly demoted_or_disabled_by_default: readonly {
    readonly family: string;
    readonly enabled_by_default: boolean;
    readonly blocked_negative_control: boolean;
    readonly show_opex_reset_marker_default: boolean | null;
  }[];
  readonly mandatory_degradation_flags: readonly string[];
}

function readJsonFile(relativePathFromRoot: string): unknown {
  const fullPath = path.resolve(process.cwd(), relativePathFromRoot);
  return JSON.parse(readFileSync(fullPath, 'utf-8'));
}

const GOLDEN = readJsonFile(
  'research/avwap_oracle/spec/golden_fixtures/avwap_phase2_golden_fixtures.json',
) as Phase2GoldenFixtures;
const POLICY_JSON = readJsonFile(
  'research/avwap_oracle/spec/avwap_context_policy.json',
) as PolicyJsonDocument;

function invertNormCdf(p: number): number {
  let lo = -12;
  let hi = 12;
  for (let i = 0; i < 80; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (normCdf(mid) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

function momentFromFixture(summary: FixtureMomentSummary, count = 1): WelfordState {
  return {
    count,
    cumWeight: summary.W,
    mean: summary.mu,
    m2: summary.M2,
  };
}

function getNyseOpenTimestamps(startIsoDate: string, count: number): number[] {
  const [yStr, mStr, dStr] = startIsoDate.split('-');
  let cursorMs = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr), 17, 0, 0);
  const out: number[] = [];
  while (out.length < count) {
    const session = usHistoricalSession(Math.floor(cursorMs / 1000));
    if (session !== null) {
      out.push(session.open);
    }
    cursorMs += 86_400_000;
  }
  return out;
}

describe('Phase 2A AVWAP Institutional Core — Golden Fixture 1:1 Parity & Dual O(1) Engine', () => {
  it('matches sealed avwap_context_policy.json verbatim', () => {
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.policyVersion).toBe(POLICY_JSON.policy_version);
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.sourceOracleConfigVersion).toBe(
      POLICY_JSON.source_oracle_config_version,
    );
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.mode).toBe('INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY');
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.autonomousTier1EntrySignalsEnabled).toBe(false);
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.mandatoryDegradationFlags).toEqual(
      POLICY_JSON.mandatory_degradation_flags,
    );
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.coreContext.map((r) => r.family)).toEqual(
      POLICY_JSON.core_context.map((r) => r.family),
    );
    expect(DEFAULT_AVWAP_CONTEXT_POLICY.eventAndStructuralContext.map((r) => r.family)).toEqual(
      POLICY_JSON.event_and_structural_context.map((r) => r.family),
    );

    const postOpex = getAvwapFamilyPolicyRule('POST_OPEX');
    expect(postOpex?.enabledByDefault).toBe(false);
    expect(postOpex?.enabledAsSrDefault).toBe(false);
    expect(postOpex?.showOpexResetMarker).toBe(false);

    for (const negFam of ['EARNINGS_INLINE', 'SWING_NO_RVOL', 'EX_DIVIDEND_REGULAR'] as const) {
      const rule = getAvwapFamilyPolicyRule(negFam);
      expect(rule?.blockedNegativeControl).toBe(true);
      expect(rule?.enabledByDefault).toBe(false);
    }

    const whamRule = getAvwapFamilyPolicyRule('MACRO_SHOCK');
    expect(whamRule?.whamSupportedEtfs).toEqual(['SPY', 'QQQ', 'IWM']);
    expect(whamRule?.whamUnsupportedEtfs).toEqual(['DIA', 'XLK', 'XLF']);
    expect(DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.visualBudgetByTimeframe['1D']).toBe(3);
    expect(DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.visualBudgetByTimeframe['1H']).toBe(4);
    expect(DEFAULT_MULTI_TIMEFRAME_AVWAP_CONFIG.visualBudgetByTimeframe['15m']).toBe(3);
  });

  it('Case 1 (NVDA): achieves < 1e-10 bps split-adjusted rollup parity and < 1e-9 IASS parity', () => {
    const splitCase = GOLDEN.case1_nvda_split_and_earnings.split_window_2024_06_05_to_12;
    const preDays = ['2024-06-05', '2024-06-06', '2024-06-07'];
    const postDays = ['2024-06-10', '2024-06-11', '2024-06-12'];

    const tfs = ['1m', '5m', '65m', '1D'] as const;
    const finalMuByTf: Record<string, number> = {};
    const finalSdByTf: Record<string, number> = {};

    for (const tf of tfs) {
      const tfDaily = splitCase.daily_moments_by_tf[tf];
      expect(tfDaily).toBeDefined();
      const preCombined = combineMomentStates(
        preDays.map((d) => {
          const m = tfDaily?.[d];
          expect(m).toBeDefined();
          return momentFromFixture(m as FixtureMomentSummary, m?.buckets ?? 1);
        }),
      );
      const splitApplied = applySplitO1(
        preCombined,
        splitCase.split_event.split_from,
        splitCase.split_event.split_to,
      );

      if (tf === '1D') {
        const preProof = splitCase.o1_split_step_proof_1d.pre_split_cum_2024_06_07;
        const postProof = splitCase.o1_split_step_proof_1d.post_split_o1_2024_06_10_open;
        expect(preCombined.cumWeight).toBeCloseTo(preProof.W, 9);
        expect(preCombined.mean).toBeCloseTo(preProof.mu, 11);
        expect(preCombined.m2).toBeCloseTo(preProof.M2, 4);
        expect(splitApplied.cumWeight).toBeCloseTo(postProof.W, 9);
        expect(splitApplied.mean).toBeCloseTo(postProof.mu, 11);
        expect(getWelfordOutput(splitApplied).stdDev).toBeCloseTo(postProof.std_dev, 11);
      }

      const finalState = combineMomentStates([
        splitApplied,
        ...postDays.map((d) => {
          const m = tfDaily?.[d];
          expect(m).toBeDefined();
          return momentFromFixture(m as FixtureMomentSummary, m?.buckets ?? 1);
        }),
      ]);
      const finalOut = getWelfordOutput(finalState);
      const expectedTf = splitCase.cumulative_split_adjusted_by_tf[tf];
      expect(expectedTf).toBeDefined();

      const muErrBps =
        (Math.abs(finalOut.vwap - (expectedTf?.final_avwap_mu ?? 0)) /
          (expectedTf?.final_avwap_mu ?? 1)) *
        1e4;
      const sdErrBps =
        (Math.abs(finalOut.stdDev - (expectedTf?.final_avwap_sd ?? 0)) /
          (expectedTf?.final_avwap_sd ?? 1)) *
        1e4;
      const sdBoundBps = tf === '5m' ? 2e-10 : 1e-10;
      expect(muErrBps).toBeLessThan(1e-10);
      expect(sdErrBps).toBeLessThan(sdBoundBps);
      expect(finalState.cumWeight).toBe(expectedTf?.final_cum_W);
      expect(
        Math.abs(finalState.m2 - (expectedTf?.final_cum_M2 ?? 0)) / (expectedTf?.final_cum_M2 ?? 1),
      ).toBeLessThan(1e-11);

      finalMuByTf[tf] = finalOut.vwap;
      finalSdByTf[tf] = finalOut.stdDev;
    }

    const refMu = finalMuByTf['1m'] ?? 1;
    const refSd = finalSdByTf['1m'] ?? 1;
    for (const tf of tfs) {
      expect((Math.abs((finalMuByTf[tf] ?? 0) - refMu) / refMu) * 1e4).toBeLessThan(1e-10);
      expect((Math.abs((finalSdByTf[tf] ?? 0) - refSd) / refSd) * 1e4).toBeLessThan(2e-10);
    }

    // Verify rollupBarsToMoments across 1m -> 5m -> 65m -> 1D synthetic bars + valid out-of-range vw
    const bars1m: Bar[] = [];
    for (let i = 0; i < 390; i += 1) {
      bars1m.push({
        time: 1717594200 + i * 60,
        open: 1200 + i * 0.01,
        high: 1201 + i * 0.01,
        low: 1199 + i * 0.01,
        close: 1200.5 + i * 0.01,
        volume: 10_000 + (i % 7) * 500,
        vw: i === 5 ? 1195.25 : 1200.2 + i * 0.01, // bar 5 intentionally has valid vw outside [low, high]
      });
    }
    const rolled1m = rollupBarsToMoments(bars1m);
    const rolled5mChunks: WelfordState[] = [];
    for (let i = 0; i < 390; i += 5) {
      rolled5mChunks.push(rollupBarsToMoments(bars1m.slice(i, i + 5)));
    }
    const rolled65mChunks: WelfordState[] = [];
    for (let i = 0; i < 390; i += 65) {
      rolled65mChunks.push(rollupBarsToMoments(bars1m.slice(i, i + 65)));
    }
    const merged5m = combineMomentStates(rolled5mChunks);
    const merged65m = combineMomentStates(rolled65mChunks);
    expect(Math.abs(merged5m.mean - rolled1m.mean) / rolled1m.mean).toBeLessThan(1e-13);
    expect(Math.abs(merged65m.mean - rolled1m.mean) / rolled1m.mean).toBeLessThan(1e-13);
    expect(
      Math.abs(getWelfordOutput(merged65m).stdDev - getWelfordOutput(rolled1m).stdDev) /
        getWelfordOutput(rolled1m).stdDev,
    ).toBeLessThan(1e-12);

    // Parkinson fallback sanity & NaN safety
    expect(estimateParkinsonM2Within(100_000, 120, 122, 118)).toBeCloseTo(
      (100_000 * 120 * 120 * Math.pow(Math.log(122 / 118), 2)) / (24 * Math.LN2),
      10,
    );
    expect(Number.isNaN(estimateParkinsonM2Within(100_000, Number.NaN, 122, 118))).toBe(true);

    // IASS EARNINGS_BLOWOUT vs EARNINGS_INLINE parity
    for (const earnCase of [
      GOLDEN.case1_nvda_split_and_earnings.earnings_comparison.blowout_2024_02_21_amc,
      GOLDEN.case1_nvda_split_and_earnings.earnings_comparison.inline_2024_11_20_amc,
    ]) {
      const comps = earnCase.component_scores;
      const dMove = comps['D_move'] ?? 0.5;
      const dShock = comps['D_shock'] ?? 0;
      const dIv = comps['D_iv'] ?? 0.5;
      const mRvol = comps['M_rvol'] ?? 0.5;
      const sGap = comps['S_gap'] ?? 0;
      const sDisp = comps['S_disp'] ?? 0;

      const ratio = 1 - Math.log(1 / dMove - 1) / DEFAULT_IASS_CONFIG.dMoveLogisticK;
      const oiGexShock = -DEFAULT_IASS_CONFIG.dShockScale * Math.log(1 - dShock);
      const rvolZ = invertNormCdf(mRvol);
      const ivChangeZ = invertNormCdf(dIv);
      const gapAtr = DEFAULT_IASS_CONFIG.sGapScale * Math.atanh(sGap);
      const closeDispAtr = DEFAULT_IASS_CONFIG.sDispScale * Math.atanh(sDisp);

      const res = computeIass({
        family: earnCase.family,
        polarity: earnCase.polarity,
        featureAsof: 1708635600,
        oratsOpraCovered: true,
        rvolZ,
        realizedReturn: ratio * 0.1,
        impliedMoveDec: 0.1,
        oiGexShock,
        ivChangeZ,
        catalystDataAvailable: true,
        gapAtr,
        closeDispAtr,
        atrValid: true,
      });

      expect(res.tier).toBe(earnCase.tier);
      expect(res.dataCoverage).toBeCloseTo(earnCase.data_coverage, 12);
      expect(res.scoreConservative).toBeCloseTo(earnCase.score_conservative, 10);
      expect(res.scoreRenormalized ?? Number.NaN).toBeCloseTo(earnCase.score_renormalized, 10);
      expect(res.pillarScores.M ?? Number.NaN).toBeCloseTo(earnCase.pillar_scores['M'] ?? 0, 10);
      expect(res.pillarScores.D ?? Number.NaN).toBeCloseTo(earnCase.pillar_scores['D'] ?? 0, 10);
      expect(res.pillarScores.F ?? Number.NaN).toBeCloseTo(earnCase.pillar_scores['F'] ?? 0, 10);
      expect(res.pillarScores.S ?? Number.NaN).toBeCloseTo(earnCase.pillar_scores['S'] ?? 0, 10);
      expect(res.degradationReasons).toEqual(earnCase.degradation_reasons);
    }
  });

  it('Case 2 (SPY): verifies hybrid bands, confluence SHORT_GAMMA_BOUNCE_HAZARD, and BSM Vanna/Charm parity', () => {
    const spyCase = GOLDEN.case2_spy_ytd_wham_oi_gex_bsm;

    for (const row of spyCase.calendar_ytd_2024_hybrid_bands) {
      const bands = computeHybridBands({
        avwapMu: row.avwap_mu,
        welfordSd: row.welford_sd,
        orIvXern20dDec: row.or_iv_xern_20d_dec,
        elapsedTradingDays: row.elapsed_trading_days,
        tau0: 2.0,
      });
      expect(bands.bandSource).toBe(row.band_source);
      expect(bands.alpha).toBeCloseTo(row.alpha, 12);
      expect(bands.sigmaOratsPath).toBeCloseTo(row.sigma_orats_path ?? 0, 11);
      expect(bands.sigmaHybrid).toBeCloseTo(row.sigma_hybrid, 11);
      expect(bands.upper1).toBeCloseTo(row.upper_1, 11);
      expect(bands.lower1).toBeCloseTo(row.lower_1, 11);
      expect(bands.upper2).toBeCloseTo(row.upper_2, 11);
      expect(bands.lower2).toBeCloseTo(row.lower_2, 11);
      expect(bands.upper2_5).toBeCloseTo(row.upper_2_5, 11);
      expect(bands.lower2_5).toBeCloseTo(row.lower_2_5, 11);
      if (row.or_iv_xern_20d_dec !== null) {
        expect(bands.expectedMove1d).toBeCloseTo(
          row.avwap_mu * (row.or_iv_xern_20d_dec / Math.sqrt(252)),
          11,
        );
      }
    }

    const fallbackBands = computeHybridBands({
      avwapMu: 470,
      welfordSd: 2.25,
      orIvXern20dDec: null,
      elapsedTradingDays: 3,
    });
    expect(fallbackBands.bandSource).toBe('WELFORD_ONLY_FALLBACK');
    expect(fallbackBands.sigmaHybrid).toBe(2.25);
    expect(Number.isNaN(fallbackBands.sigmaOratsPath)).toBe(true);
    expect(Number.isNaN(fallbackBands.expectedMove1d)).toBe(true);

    // Confluence parity (POSITIVE_GAMMA vs NEGATIVE_GAMMA controlled pair)
    const scenarios = [
      {
        netGex: 3_500_000,
        expected: spyCase.confluence_scenarios.controlled_parity_pair_pos,
      },
      {
        netGex: -3_500_000,
        expected: spyCase.confluence_scenarios.controlled_parity_pair_neg,
      },
    ] as const;

    for (const sc of scenarios) {
      const conf = computeConfluenceContext({
        avwapPrice: 718.0,
        spotPrice: 715.81,
        atr14: 7.5,
        polarity: 'LONG',
        netGex: sc.netGex,
        dollarVol20d: 700_000_000,
        callWall: 720.0,
        putWall: 710.0,
        zeroGamma: 717.5,
        vpPoc: 717.8,
        vpVah: 719.5,
        vpVal: 714.0,
        vpHvns: [718.0],
        vpLvns: [717.5],
        cvdAbsorptionScore: 0.75,
        cvdDirectionalAlignment: 0.7,
        bucketRvolZ: 1.8,
        contango: 0.45,
        spyIv30dDec: 0.22,
      });

      expect(conf.role).toBe('INSTITUTIONAL_CONTEXT_ONLY');
      expect(conf.bounceConfluenceScore).toBeCloseTo(sc.expected.bounce_confluence, 11);
      expect(conf.breakoutConfluenceScore).toBeCloseTo(sc.expected.breakout_confluence, 11);
      expect(conf.netGexNormalizedG).toBeCloseTo(sc.expected.net_gex_normalized_g, 12);
      expect(conf.g0DollarVolScale).toBeCloseTo(sc.expected.g0_dollar_vol_scale, 9);
      expect(conf.gammaRegime).toBe(sc.expected.gamma_regime);
      expect(conf.volRegime).toBe(sc.expected.vol_regime);
      expect(conf.meanReversionContextActive).toBe(sc.expected.mean_reversion_context_active);
      expect(conf.hazardFlags).toEqual(sc.expected.hazard_flags);
      expect(conf.flags).toEqual(sc.expected.degradation_flags);
      expect(conf.spatialKernels.callWall).toBeCloseTo(sc.expected.spatial_kernels['call_wall'] ?? 0, 12);
      expect(conf.spatialKernels.putWall).toBeCloseTo(sc.expected.spatial_kernels['put_wall'] ?? 0, 12);
      expect(conf.spatialKernels.zeroGamma).toBeCloseTo(sc.expected.spatial_kernels['zero_gamma'] ?? 0, 12);
      expect(conf.spatialKernels.vpPoc).toBeCloseTo(sc.expected.spatial_kernels['vp_poc'] ?? 0, 12);
      expect(conf.spatialKernels.vpVah).toBeCloseTo(sc.expected.spatial_kernels['vp_vah'] ?? 0, 12);
      expect(conf.spatialKernels.vpVal).toBeCloseTo(sc.expected.spatial_kernels['vp_val'] ?? 0, 12);
      expect(conf.spatialKernels.vpHvnMax).toBeCloseTo(sc.expected.spatial_kernels['vp_hvn_max'] ?? 0, 12);
      expect(conf.spatialKernels.vpLvnMax).toBeCloseTo(sc.expected.spatial_kernels['vp_lvn_max'] ?? 0, 12);
      expect(conf.alignedLevels[0]?.levelType).toBe('VP_HVN');
      expect(conf.alignedLevels[0]?.kernelWeight).toBeCloseTo(1.0, 12);
    }

    // Kernel + G0 scale guard checks
    expect(atrGaussianKernel(718.0, 720.0, 7.5)).toBeCloseTo(
      spyCase.confluence_scenarios.controlled_parity_pair_pos.spatial_kernels['call_wall'] ?? 0,
      12,
    );
    expect(Number.isNaN(atrGaussianKernel(Number.NaN, 720.0, 7.5))).toBe(true);
    expect(normalizeNetGex(null, 700_000_000).g0).toBe(7_000_000);
    expect(Number.isNaN(normalizeNetGex(null, 700_000_000).g)).toBe(true);

    // Analytical BSM Vanna & Charm parity via src/core/options/blackScholes.ts
    for (const greekCase of [
      spyCase.bsm_second_order_greeks.call_720,
      spyCase.bsm_second_order_greeks.put_720,
    ]) {
      const res = computeInstitutionalVannaCharm({
        spot: greekCase.spot,
        strike: greekCase.strike,
        dteDays: greekCase.dte_days,
        smvVol: greekCase.smv_vol,
        riskFree: greekCase.risk_free,
        residualRate: greekCase.residual_rate,
        contractType: greekCase.contract_type,
      });

      const assertRel = (actual: number, expected: number): void => {
        const rel = Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected));
        expect(rel).toBeLessThan(1e-9);
      };
      assertRel(res.price, greekCase.price);
      assertRel(res.delta, greekCase.delta);
      assertRel(res.gamma, greekCase.gamma);
      assertRel(res.vega, greekCase.vega);
      assertRel(res.vanna, greekCase.vanna);
      assertRel(res.charm, greekCase.charm);
      assertRel(res.charmDaily, greekCase.charm_daily);
    }
  });

  it('Case 3 (MELI ADR): matches Bayesian shrinkage with vs. without ORATS coverage (< 1e-9)', () => {
    const meli = GOLDEN.case3_meli_adr_bayesian_degradation;
    const pWith = meli.with_orats.pillar_scores;

    // Derive exact continuous raw inputs reproducing the real MELI with_orats pillars
    const rvolZ = invertNormCdf(pWith['M'] ?? 0.5);
    const gapAtr = DEFAULT_IASS_CONFIG.sGapScale * Math.atanh(pWith['S'] ?? 0);
    // Single-component pillar D inversion via D_move logistic (gives exact pillar D without needing raw oi_gex_shock)
    const pD = pWith['D'] ?? 0.5;
    const ratioD = 1 - Math.log(1 / pD - 1) / DEFAULT_IASS_CONFIG.dMoveLogisticK;

    const withOrats = computeIass({
      family: meli.with_orats.family,
      polarity: 'LONG',
      featureAsof: 1722628800,
      oratsOpraCovered: true,
      rvolZ,
      realizedReturn: ratioD * 0.1,
      impliedMoveDec: 0.1,
      gapAtr,
      atrValid: true,
    });

    expect(withOrats.dataCoverage).toBeCloseTo(meli.with_orats.data_coverage, 12);
    expect(withOrats.scoreRenormalized ?? Number.NaN).toBeCloseTo(
      meli.with_orats.score_renormalized,
      10,
    );
    expect(withOrats.scoreConservative).toBeCloseTo(meli.with_orats.score_conservative, 10);
    expect(withOrats.tier).toBe(meli.with_orats.tier);

    const withoutOrats = computeIass({
      family: meli.with_orats.family,
      polarity: 'LONG',
      featureAsof: 1722628800,
      oratsOpraCovered: false,
      rvolZ,
      realizedReturn: ratioD * 0.1,
      impliedMoveDec: 0.1,
      gapAtr,
      atrValid: true,
    });

    const expectedNo = meli.without_orats_simulated_degradation;
    expect(withoutOrats.dataCoverage).toBeCloseTo(expectedNo.data_coverage, 12);
    expect(withoutOrats.prior).toBe(expectedNo.prior);
    expect(withoutOrats.scoreRenormalized ?? Number.NaN).toBeCloseTo(
      expectedNo.score_renormalized,
      10,
    );
    expect(withoutOrats.scoreConservative).toBeCloseTo(expectedNo.score_conservative, 10);
    expect(withoutOrats.degradationReasons).toEqual(expectedNo.degradation_reasons);
  });

  it('Case 4 (COST): applies $15 special dividend O(1) and leaves $1.47 regular dividend untouched', () => {
    const costSpec = GOLDEN.case4_cost_special_vs_regular_dividend.special_dividend_2023_12_27;
    const preSpec = momentFromFixture(costSpec.pre_state, 6);
    const resSpec = applySpecialDividendO1(preSpec, costSpec.cash_amount, costSpec.prev_close, 0.015);

    expect(resSpec.applied).toBe(costSpec.applied);
    expect(resSpec.factor).toBeCloseTo(costSpec.d_factor, 12);
    expect(resSpec.state.cumWeight).toBeCloseTo(costSpec.post_state.W, 9);
    expect(resSpec.state.mean).toBeCloseTo(costSpec.post_state.mu, 11);
    expect(resSpec.state.m2).toBeCloseTo(costSpec.post_state.M2, 6);
    expect(getWelfordOutput(resSpec.state).stdDev).toBeCloseTo(costSpec.post_state.std_dev, 11);
    expect(preSpec.mean).toBe(costSpec.pre_state.mu); // input unchanged

    const costReg = GOLDEN.case4_cost_special_vs_regular_dividend.regular_dividend_2026_05_01;
    const preReg = momentFromFixture(costReg.pre_state, 5);
    const resReg = applySpecialDividendO1(preReg, costReg.cash_amount, costReg.prev_close, 0.015);
    expect(resReg.applied).toBe(costReg.applied);
    expect(resReg.factor).toBe(1);
    expect(resReg.state.mean).toBe(costReg.post_state.mu);
    expect(resReg.state.m2).toBe(costReg.post_state.M2);
  });

  it('Case 5 (FSM & PINCH_PAIR): matches state-by-state and transition-by-transition across all 3 sequences', () => {
    const ts25 = getNyseOpenTimestamps('2024-01-02', 25);
    const tsFirst = ts25[0] ?? 0;

    // Sequence A: 15 bars PINCH_PAIR, PINCH_BREAKOUT (> 0.35 ATR), COHORT_DECAY, ARCHIVED
    const n15 = 15;
    const closesA = [
      100.2, 100.2, 100.2, 100.2, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85, 100.85,
      100.85, 100.85, 100.85,
    ];
    const anchorsA: AnchorSeriesInput[] = [
      {
        anchorId: 'fsm_long',
        family: 'EARNINGS_BLOWOUT',
        polarity: 'LONG',
        anchorIdx: 0,
        activatedIdx: 0,
        anchorTs: tsFirst,
        availableAtUtcSec: tsFirst,
        scoreOriginal: 78.0,
        avwapSeries: new Array<number>(n15).fill(100.0),
      },
      {
        anchorId: 'fsm_short',
        family: 'BREAKAWAY_GAP',
        polarity: 'SHORT',
        anchorIdx: 0,
        activatedIdx: 0,
        anchorTs: tsFirst,
        availableAtUtcSec: tsFirst,
        scoreOriginal: 62.0,
        avwapSeries: [101.0, 100.8, 100.6, 100.4, 100.4, ...new Array<number>(10).fill(100.4)],
      },
      {
        anchorId: 'fsm_cohort',
        family: 'VOLUME_CLIMAX',
        polarity: 'LONG',
        anchorIdx: 0,
        activatedIdx: 0,
        anchorTs: tsFirst,
        availableAtUtcSec: tsFirst,
        scoreOriginal: 74.0,
        avwapSeries: new Array<number>(n15).fill(93.0),
        freeFloatAtAnchor: 1000.0,
        floatIsPit: true,
      },
    ];
    const simA = runLifecycleFsm({
      timeframe: '1D',
      barTsUtcSec: ts25.slice(0, n15),
      highs: closesA.map((c) => c + 0.3),
      lows: closesA.map((c) => c - 0.3),
      closes: closesA,
      volumes: new Array<number>(n15).fill(850.0),
      atr14: new Array<number>(n15).fill(1.0),
      anchors: anchorsA,
      config: DEFAULT_LIFECYCLE_CONFIG,
    });

    // Sequence B: 15 bars CHOP_SATURATION -> ARCHIVED_DECAY_TIMEOUT
    const closesB = [
      100.5, 99.5, 100.5, 99.5, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3,
      100.3, 100.3,
    ];
    const simB = runLifecycleFsm({
      timeframe: '1D',
      barTsUtcSec: ts25.slice(0, n15),
      highs: closesB.map((c) => c + 0.1),
      lows: closesB.map((c) => c - 0.1),
      closes: closesB,
      volumes: new Array<number>(n15).fill(1_000_000),
      atr14: new Array<number>(n15).fill(1.0),
      anchors: [
        {
          anchorId: 'fsm_chop',
          family: 'BREAKAWAY_GAP',
          polarity: 'LONG',
          anchorIdx: 0,
          activatedIdx: 0,
          anchorTs: tsFirst,
          availableAtUtcSec: tsFirst,
          scoreOriginal: 72.0,
          avwapSeries: new Array<number>(n15).fill(100.0),
        },
      ],
      config: DEFAULT_LIFECYCLE_CONFIG,
    });

    // Sequence C: 25 bars FLAT_SLOPE -> BREAKOUT_RESURRECTION
    const n25 = 25;
    const closesC = [
      ...new Array<number>(15).fill(100.1),
      101.5,
      102.0,
      102.5,
      ...new Array<number>(7).fill(102.5),
    ];
    const avRes = [
      ...new Array<number>(15).fill(100.0),
      100.25,
      100.6,
      101.0,
      101.2,
      ...new Array<number>(6).fill(101.2),
    ];
    const simC = runLifecycleFsm({
      timeframe: '1D',
      barTsUtcSec: ts25.slice(0, n25),
      highs: closesC.map((c) => c + 0.1),
      lows: closesC.map((c) => c - 0.1),
      closes: closesC,
      volumes: new Array<number>(n25).fill(1_000_000),
      atr14: new Array<number>(n25).fill(1.0),
      anchors: [
        {
          anchorId: 'fsm_res',
          family: 'BREAKAWAY_GAP',
          polarity: 'LONG',
          anchorIdx: 0,
          activatedIdx: 0,
          anchorTs: tsFirst,
          availableAtUtcSec: tsFirst,
          scoreOriginal: 72.0,
          avwapSeries: avRes,
        },
      ],
      config: DEFAULT_LIFECYCLE_CONFIG,
    });

    const pairs = [
      { sim: simA, fix: GOLDEN.case5_fsm_pinch_breakout_resurrection.pinch_breakout_cohort_decay_15bars },
      { sim: simB, fix: GOLDEN.case5_fsm_pinch_breakout_resurrection.chop_saturation_archival_15bars },
      { sim: simC, fix: GOLDEN.case5_fsm_pinch_breakout_resurrection.flat_decay_breakout_resurrection_25bars },
    ] as const;

    for (const { sim, fix } of pairs) {
      expect(sim.transitions.length).toBe(fix.transitions.length);
      for (let i = 0; i < fix.transitions.length; i += 1) {
        const actualTr = sim.transitions[i];
        const expectedTr = fix.transitions[i];
        expect(actualTr?.anchorId).toBe(expectedTr?.anchor_id);
        expect(actualTr?.previousState).toBe(expectedTr?.previous_state);
        expect(actualTr?.nextState).toBe(expectedTr?.next_state);
        expect(actualTr?.transitionReason).toBe(expectedTr?.transition_reason);
        expect(actualTr?.effectiveTs).toBe(expectedTr?.effective_ts);
        expect(actualTr?.scoreAtTransition).toBeCloseTo(expectedTr?.score_at_transition ?? 0, 9);
      }

      const actualFinals: Record<string, AvwapLifecycleState> = {};
      for (const [k, snap] of Object.entries(sim.finalSnapshots)) {
        actualFinals[k] = snap.state;
      }
      expect(actualFinals).toEqual(fix.final_states);
    }
  });

  it('Dual O(1) Live Engine: immutability, < 1e-12 parity vs batch over 20 anchors, and < 1 ms latency', () => {
    const anchorCount = 20;
    const baseMinuteSec = 1704205800; // 2024-01-02 09:30 ET

    // Build 120 historical 1m bars and freeze committed states for 20 staggered anchors
    const histBars: Bar[] = [];
    for (let i = 0; i < 120; i += 1) {
      const px = 472.0 + Math.sin(i * 0.13) * 1.1 + i * 0.004;
      histBars.push({
        time: baseMinuteSec + i * 60,
        open: px - 0.1,
        high: px + 0.25,
        low: px - 0.25,
        close: px + 0.05,
        volume: 10_000 + i * 17,
        vw: px,
      });
    }

    const anchorStarts = Array.from({ length: anchorCount }, (_, idx) => idx * 4);
    const committedStates = anchorStarts.map((startIdx) =>
      Object.freeze(rollupBarsToMoments(histBars.slice(startIdx))),
    );
    const committedSnapshots = committedStates.map((st) => ({ ...st }));

    // Simulate live minute 120 ticks arriving sequentially
    const liveBucketSec = baseMinuteSec + 120 * 60;
    let liveAcc = createLiveBarAccumulator(liveBucketSec, {
      symbol: 'SPY',
      adjSig: 'rev-1',
      source: 'TRADIER_WS',
    });

    const ticks: readonly { readonly price: number; readonly size: number; readonly dt: number }[] = [
      { price: 472.85, size: 1200, dt: 2 },
      { price: 472.92, size: 800, dt: 5 },
      { price: Number.NaN, size: 100, dt: 6 }, // discarded
      { price: 472.75, size: 0, dt: 7 }, // discarded
      { price: 473.04, size: 2500, dt: 14 },
      { price: 472.98, size: 1500, dt: 29 },
    ];

    for (const tk of ticks) {
      liveAcc = ingestLiveTickO1(liveAcc, tk.price, tk.size, liveBucketSec + tk.dt);
    }

    // Batch ground-truth over historical bars + valid raw ticks
    const tickBars: Bar[] = ticks
      .filter((t) => Number.isFinite(t.price) && t.size > 0)
      .map((t) => ({
        time: liveBucketSec + t.dt,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: t.size,
        vw: t.price,
      }));

    for (let idx = 0; idx < anchorCount; idx += 1) {
      const startIdx = anchorStarts[idx] ?? 0;
      const committed = committedStates[idx] ?? createInitialWelfordState();
      const proj = projectAnchorLiveO1(committed, liveAcc);
      const batch = getWelfordOutput(
        rollupBarsToMoments([...histBars.slice(startIdx), ...tickBars]),
      );

      expect(Math.abs(proj.avwap - batch.vwap) / batch.vwap).toBeLessThan(1e-12);
      expect(Math.abs(proj.stdDev - batch.stdDev) / batch.stdDev).toBeLessThan(1e-12);
      expect(proj.cumWeight).toBe(batch.cumVolume);
      // Verify committedState remained completely immutable
      expect(committed).toEqual(committedSnapshots[idx]);
    }

    // Verify commitClosedMinuteO1 reconciles closed bar to < 1e-12 against batch
    const closedLiveState = liveAcc.welford;
    const nextCommitted = commitClosedMinuteO1(
      committedStates[0] ?? createInitialWelfordState(),
      closedLiveState,
    );
    const batchAfterClose = getWelfordOutput(rollupBarsToMoments([...histBars, ...tickBars]));
    expect(
      Math.abs(getWelfordOutput(nextCommitted).vwap - batchAfterClose.vwap) / batchAfterClose.vwap,
    ).toBeLessThan(1e-12);

    // Latency benchmark across 20 simultaneous anchors (< 1 ms per frame)
    for (let w = 0; w < 200; w += 1) {
      liveAcc = ingestLiveTickO1(liveAcc, 473.0 + (w % 5) * 0.01, 50, liveBucketSec + 30);
      for (const committed of committedStates) {
        projectAnchorLiveO1(committed, liveAcc);
      }
    }
    const frames = 200;
    const t0 = performance.now();
    for (let f = 0; f < frames; f += 1) {
      liveAcc = ingestLiveTickO1(liveAcc, 473.05 + (f % 3) * 0.02, 100, liveBucketSec + 35);
      for (const committed of committedStates) {
        projectAnchorLiveO1(committed, liveAcc);
      }
    }
    const avgFrameMs = (performance.now() - t0) / frames;
    expect(avgFrameMs).toBeLessThan(1.0);

    // O(1) slope ring buffer parity vs evaluateFlatSlope
    const ts15 = getNyseOpenTimestamps('2024-01-02', 15);
    const avSeries = [100, 100.1, 100.2, 100.35, 100.5, 100.6, 100.8, 100.9, 101.0, 101.15];
    const atrSeries = new Array<number>(avSeries.length).fill(1.25);
    const flatRef = evaluateFlatSlope({
      closes: avSeries,
      avwap: avSeries,
      atr14: atrSeries,
      timeframe: '1D', // h = 5
    });
    let ring = createSlopeRingBuffer(5);
    for (let i = 0; i < avSeries.length; i += 1) {
      ring = pushSlopeRingBufferO1(ring, avSeries[i] ?? Number.NaN);
      const slopeO1 = getNormalizedSlopeO1(ring, atrSeries[i] ?? Number.NaN);
      const expectedSlope = flatRef.sNorm[i] ?? Number.NaN;
      if (Number.isNaN(expectedSlope)) {
        expect(Number.isNaN(slopeO1)).toBe(true);
      } else {
        expect(Math.abs(slopeO1 - expectedSlope)).toBeLessThan(1e-12);
      }
    }

    // O(1) rolling chop counter parity vs evaluateChopSaturation
    const chopCloses = [100.5, 99.5, 100.5, 99.5, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3, 100.3];
    const chopAv = new Array<number>(chopCloses.length).fill(100.0);
    const chopAtr = new Array<number>(chopCloses.length).fill(1.0);
    const chopRef = evaluateChopSaturation({
      highs: chopCloses.map((c) => c + 0.1),
      lows: chopCloses.map((c) => c - 0.1),
      closes: chopCloses,
      avwap: chopAv,
      atr14: chopAtr,
    });
    let chopTracker = createRollingChopTracker();
    for (let i = 0; i < chopCloses.length; i += 1) {
      const stepped = stepRollingChopO1(chopTracker, {
        high: (chopCloses[i] ?? 100) + 0.1,
        low: (chopCloses[i] ?? 100) - 0.1,
        close: chopCloses[i] ?? 100,
        avwap: chopAv[i] ?? 100,
        atr14: chopAtr[i] ?? 1,
      });
      chopTracker = stepped.tracker;
      expect(stepped.chopCrossCount12).toBe(chopRef.chopCounts[i]);
    }
    expect(ts15.length).toBe(15);
    expect(hasAdjustmentRevisionChanged('rev-1', 'rev-1')).toBe(false);
    expect(hasAdjustmentRevisionChanged('rev-1', 'rev-2')).toBe(true);
  });
});
