import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const reactRuntime = webRequire('react') as {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
};
const reactDomServer = webRequire('react-dom/server') as {
  renderToStaticMarkup(element: unknown): string;
};

interface TestAnchorInput {
  readonly anchorId: string;
  readonly family: string;
  readonly polarity?: 'LONG' | 'SHORT' | 'NEUTRAL';
  readonly label?: string;
  readonly anchorDate?: string;
  readonly avwap: number | null;
  readonly distanceAtr: number | null;
  readonly zScorePath?: number | null;
  readonly lifecycleState:
    | 'CANDIDATE'
    | 'ACTIVE_PRIMARY'
    | 'ACTIVE_SECONDARY'
    | 'PINCH_PAIR'
    | 'DECAYING'
    | 'ARCHIVED';
  readonly pinchPartnerId?: string | null;
  readonly decayReasons?: readonly ('COHORT_DECAY' | 'CHOP_SATURATION' | 'FLAT_SLOPE')[];
  readonly cohortSurvival?: number | null;
  readonly floatIsNonPit?: boolean;
  readonly iass?: {
    readonly scoreConservative?: number | null;
    readonly dataCoverage?: number | null;
    readonly pillarScores?: {
      readonly M?: number | null;
      readonly D?: number | null;
      readonly F?: number | null;
      readonly S?: number | null;
    };
  };
  readonly bands?: {
    readonly upper1?: number | null;
    readonly lower1?: number | null;
    readonly upper2?: number | null;
    readonly lower2?: number | null;
    readonly upper2_5?: number | null;
    readonly lower2_5?: number | null;
  };
  readonly degradationFlags?: readonly string[];
}

interface TestContextInput {
  readonly role: 'INSTITUTIONAL_CONTEXT_ONLY';
  readonly bounceConfluenceScore: number | null;
  readonly breakoutConfluenceScore: number | null;
  readonly netGexNormalizedG: number | null;
  readonly g0DollarVolScale: number | null;
  readonly gammaRegime: 'POSITIVE_GAMMA' | 'NEGATIVE_GAMMA' | 'NEUTRAL' | 'UNKNOWN';
  readonly volRegime: 'LOW_VOL_CHOP' | 'MID_VOL' | 'HIGH_VOL_TREND' | 'UNKNOWN';
  readonly meanReversionContextActive: boolean;
  readonly alignedLevels: readonly {
    readonly levelType:
      | 'CALL_WALL'
      | 'PUT_WALL'
      | 'ZERO_GAMMA'
      | 'VP_POC'
      | 'VP_VAH'
      | 'VP_VAL'
      | 'VP_HVN'
      | 'VP_LVN';
    readonly price: number | null;
    readonly distanceAtr: number | null;
    readonly kernelWeight: number | null;
  }[];
  readonly spatialKernels: Readonly<Record<string, number | null>>;
  readonly hazardFlags: readonly string[];
  readonly flags: readonly string[];
  readonly bounceMultiplier: number | null;
  readonly breakoutMultiplier: number | null;
  readonly activeAnchors?: readonly TestAnchorInput[];
  readonly opexResetMarkerDates?: readonly string[];
}

interface ViewModelResult {
  readonly available: boolean;
  readonly role: 'INSTITUTIONAL_CONTEXT_ONLY';
  readonly timeframe: string;
  readonly effectiveMaxCurves: number;
  readonly shortGammaBounceHazard: boolean;
  readonly gammaBadge: {
    readonly kind: string;
    readonly tone: string;
    readonly shortLabel: string;
    readonly detail: string;
  };
  readonly volRegimeBadge: {
    readonly regime: string;
    readonly label: string;
  };
  readonly netGexNormalizedFormatted: string;
  readonly bounceScoreFormatted: string;
  readonly breakoutScoreFormatted: string;
  readonly dominantConfluence: 'BOUNCE' | 'BREAKOUT' | 'BALANCED';
  readonly visibleAnchors: readonly {
    readonly anchorId: string;
    readonly family: string;
    readonly avwapFormatted: string;
    readonly distanceAtrFormatted: string;
    readonly zScorePathFormatted: string;
    readonly iassConservativeFormatted: string;
    readonly cohortSurvivalPctFormatted: string;
    readonly lifecycleState: string;
    readonly style: {
      readonly opacity: number;
      readonly lineWidth: 1 | 2;
      readonly lineStyle: 'SOLID' | 'DASHED' | 'DOTTED';
      readonly badgeLabel: string;
    };
    readonly decayReasons: readonly { readonly code: string; readonly label: string }[];
  }[];
  readonly macroAxisRefs: readonly {
    readonly anchorId: string;
    readonly family: string;
    readonly shortLabel: 'YTD' | 'IPO';
    readonly absDistanceAtr: number;
    readonly representation: 'DISCRETE_AXIS_LABEL';
    readonly isFullCurve: false;
  }[];
  readonly opexCycleMarkers: readonly {
    readonly id: string;
    readonly markerKind: 'OPEX_CYCLE_MARKER';
    readonly isSupportResistance: false;
  }[];
  readonly pinchCorridor: {
    readonly anchorIds: readonly [string, string];
    readonly lowPrice: number;
    readonly highPrice: number;
  } | null;
  readonly focusedBands: {
    readonly focusedAnchorId: string | null;
    readonly visible: boolean;
    readonly hiddenReason: string | null;
    readonly levels: readonly {
      readonly key: string;
      readonly sigma: number;
      readonly label: string;
      readonly priceFormatted: string;
      readonly isCalibratedExtreme: boolean;
      readonly emphasis: string;
    }[];
  };
  readonly degradationBadges: readonly {
    readonly flag: string;
    readonly label: string;
    readonly isHazard: boolean;
  }[];
  readonly chartPriceLines: readonly {
    readonly id: string;
    readonly kind: 'ANCHOR_LEVEL' | 'MACRO_AXIS_REF' | 'FOCUSED_BAND';
    readonly price: number;
    readonly title: string;
    readonly lineVisible: boolean;
    readonly axisLabelVisible: boolean;
  }[];
}

interface ViewModelModule {
  buildInstitutionalAvwapContextViewModel(input: {
    readonly context: TestContextInput | null | undefined;
    readonly activeTimeframe: string;
    readonly anchors?: readonly TestAnchorInput[];
    readonly opexResetMarkerDates?: readonly string[];
    readonly preferences?: {
      readonly focusedAnchorId?: string | null;
      readonly showFocusedBands?: boolean;
      readonly showOpexResetMarker?: boolean;
      readonly showWeeklyBandsOverride?: boolean;
    };
  }): ViewModelResult;
  formatAvwapNumber(v: number | null | undefined, d?: number): string;
  formatAvwapSignedNumber(v: number | null | undefined, d?: number, suffix?: string): string;
  formatAvwapPercent(v: number | null | undefined, isFraction?: boolean, d?: number): string;
}

interface PanelModule {
  readonly InstitutionalAvwapContextPanel: unknown;
}

const VIEW_MODEL_SPEC: string = '../web/src/components/stock-detail/avwapContextViewModel.ts';
const PANEL_SPEC: string = '../web/src/components/stock-detail/InstitutionalAvwapContextPanel.tsx';

function makeAnchor(overrides: Partial<TestAnchorInput> & { readonly anchorId: string }): TestAnchorInput {
  return {
    family: 'EARNINGS_BLOWOUT',
    polarity: 'LONG',
    label: `Anchor ${overrides.anchorId}`,
    anchorDate: '2026-10-15',
    avwap: 150.25,
    distanceAtr: 0.6,
    zScorePath: 1.15,
    lifecycleState: 'ACTIVE_PRIMARY',
    pinchPartnerId: null,
    decayReasons: [],
    cohortSurvival: 0.64,
    floatIsNonPit: false,
    iass: {
      scoreConservative: 76,
      dataCoverage: 0.92,
      pillarScores: { M: 80, D: 78, F: 72, S: 74 },
    },
    bands: {
      upper1: 153.5,
      lower1: 147.0,
      upper2: 156.75,
      lower2: 143.75,
      upper2_5: 158.4,
      lower2_5: 142.1,
    },
    degradationFlags: [],
    ...overrides,
  };
}

function makeBaseContext(overrides: Partial<TestContextInput> = {}): TestContextInput {
  return {
    role: 'INSTITUTIONAL_CONTEXT_ONLY',
    bounceConfluenceScore: 72,
    breakoutConfluenceScore: 44,
    netGexNormalizedG: 0.48,
    g0DollarVolScale: 25_000_000,
    gammaRegime: 'POSITIVE_GAMMA',
    volRegime: 'MID_VOL',
    meanReversionContextActive: true,
    alignedLevels: [
      { levelType: 'PUT_WALL', price: 149.5, distanceAtr: 0.2, kernelWeight: 0.85 },
      { levelType: 'VP_POC', price: 150.1, distanceAtr: 0.05, kernelWeight: 0.99 },
    ],
    spatialKernels: {
      callWall: 0.2,
      putWall: 0.85,
      zeroGamma: 0.35,
      vpPoc: 0.99,
      vpVah: 0.5,
      vpVal: 0.4,
      vpHvnMax: 0.7,
      vpLvnMax: 0.1,
    },
    hazardFlags: [],
    flags: [],
    bounceMultiplier: 1.14,
    breakoutMultiplier: 0.88,
    ...overrides,
  };
}

describe('Phase 2C · Institutional AVWAP Context ViewModel & Panel (100% Offline)', () => {
  it('enforces hard visual budgets across 1W/1D (3 + 1 pinch), 1H/65m (4), and 5m/15m (3 + 1 macro < 1 ATR) plus top-down radius', async () => {
    const vmMod = (await import(/* @vite-ignore */ VIEW_MODEL_SPEC)) as ViewModelModule;

    // 1D without pinch: max 3 even when 5 candidates exist
    const nonPinchAnchors: TestAnchorInput[] = [
      makeAnchor({ anchorId: 'a1', family: 'EARNINGS_BLOWOUT', distanceAtr: 0.5, iass: { scoreConservative: 88 } }),
      makeAnchor({ anchorId: 'a2', family: 'CALENDAR_YTD', distanceAtr: -0.9, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 80 } }),
      makeAnchor({ anchorId: 'a3', family: 'VOLUME_CLIMAX', distanceAtr: 1.2, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 70 } }),
      makeAnchor({ anchorId: 'a4', family: 'BREAKAWAY_GAP', distanceAtr: 1.5, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 65 } }),
      makeAnchor({ anchorId: 'a_far', family: 'MACRO_SHOCK', distanceAtr: 3.2, lifecycleState: 'ACTIVE_PRIMARY', iass: { scoreConservative: 95 } }),
    ];

    const dailyNoPinch = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext(),
      activeTimeframe: '1D',
      anchors: nonPinchAnchors,
    });
    expect(dailyNoPinch.effectiveMaxCurves).toBe(3);
    expect(dailyNoPinch.visibleAnchors).toHaveLength(3);
    expect(dailyNoPinch.visibleAnchors.map((a) => a.anchorId)).toEqual(['a1', 'a2', 'a3']);

    // 1W & 1D with active PINCH_PAIR: expands budget to 4 and builds pinchCorridor
    const withPinch: TestAnchorInput[] = [
      makeAnchor({ anchorId: 'p1', family: 'EARNINGS_BLOWOUT', lifecycleState: 'PINCH_PAIR', pinchPartnerId: 'p2', avwap: 152.0, distanceAtr: 0.4, iass: { scoreConservative: 84 } }),
      makeAnchor({ anchorId: 'p2', family: 'CALENDAR_YTD', lifecycleState: 'PINCH_PAIR', pinchPartnerId: 'p1', avwap: 148.5, distanceAtr: -0.6, iass: { scoreConservative: 81 } }),
      ...nonPinchAnchors,
    ];
    for (const tf of ['1W', '1D'] as const) {
      const vm = vmMod.buildInstitutionalAvwapContextViewModel({
        context: makeBaseContext(),
        activeTimeframe: tf,
        anchors: withPinch,
      });
      expect(vm.effectiveMaxCurves).toBe(4);
      expect(vm.visibleAnchors).toHaveLength(4);
      expect(vm.pinchCorridor).not.toBeNull();
      expect(vm.pinchCorridor?.lowPrice).toBe(148.5);
      expect(vm.pinchCorridor?.highPrice).toBe(152.0);
    }

    // 1H / 65m: max 4 curves and top-down radius 2.5 ATR (so 2.8 ATR excluded)
    const swingPool: TestAnchorInput[] = [
      makeAnchor({ anchorId: 's1', family: 'SESSION_VWAP', distanceAtr: 0.3, iass: { scoreConservative: 90 } }),
      makeAnchor({ anchorId: 's2', family: 'EARNINGS_BLOWOUT', distanceAtr: 0.8, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 82 } }),
      makeAnchor({ anchorId: 's3', family: 'VOLUME_CLIMAX', distanceAtr: 1.1, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 78 } }),
      makeAnchor({ anchorId: 's4', family: 'BREAKAWAY_GAP', distanceAtr: 2.0, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 74 } }),
      makeAnchor({ anchorId: 's5', family: 'SWING_CAUSAL', distanceAtr: 2.3, lifecycleState: 'ACTIVE_SECONDARY', iass: { scoreConservative: 70 } }),
      makeAnchor({ anchorId: 's_out', family: 'MACRO_SHOCK', distanceAtr: 2.8, lifecycleState: 'ACTIVE_PRIMARY', iass: { scoreConservative: 99 } }),
    ];
    for (const tf of ['1H', '65m'] as const) {
      const vm = vmMod.buildInstitutionalAvwapContextViewModel({
        context: makeBaseContext(),
        activeTimeframe: tf,
        anchors: swingPool,
      });
      expect(vm.effectiveMaxCurves).toBe(4);
      expect(vm.visibleAnchors).toHaveLength(4);
      expect(vm.visibleAnchors.some((a) => a.anchorId === 's_out')).toBe(false);
    }

    // 5m & 15m: max 3 active curves, YTD & IPO NEVER enter visibleAnchors as full curves; max 1 macro ref if |dist| < 1.0 ATR
    const intradayPool: TestAnchorInput[] = [
      makeAnchor({ anchorId: 'ytd_near', family: 'CALENDAR_YTD', avwap: 150.0, distanceAtr: 0.65, iass: { scoreConservative: 95 } }),
      makeAnchor({ anchorId: 'ipo_near', family: 'IPO_DIRECT', avwap: 151.1, distanceAtr: -0.85, iass: { scoreConservative: 90 } }),
      ...swingPool,
    ];
    for (const tf of ['5m', '15m'] as const) {
      const vm = vmMod.buildInstitutionalAvwapContextViewModel({
        context: makeBaseContext(),
        activeTimeframe: tf,
        anchors: intradayPool,
      });
      expect(vm.effectiveMaxCurves).toBe(3);
      expect(vm.visibleAnchors).toHaveLength(3);
      expect(vm.visibleAnchors.some((a) => a.family === 'CALENDAR_YTD' || a.family === 'IPO_DIRECT')).toBe(false);
      expect(vm.macroAxisRefs).toHaveLength(1);
      expect(vm.macroAxisRefs[0]?.anchorId).toBe('ytd_near');
      expect(vm.macroAxisRefs[0]?.representation).toBe('DISCRETE_AXIS_LABEL');
      expect(vm.macroAxisRefs[0]?.isFullCurve).toBe(false);

      const macroChartLine = vm.chartPriceLines.find((l) => l.kind === 'MACRO_AXIS_REF');
      expect(macroChartLine).toBeDefined();
      expect(macroChartLine?.lineVisible).toBe(false);
      expect(macroChartLine?.axisLabelVisible).toBe(true);
    }

    // YTD at >= 1.0 ATR is excluded from macroAxisRefs on 5m
    const farMacro = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext(),
      activeTimeframe: '5m',
      anchors: [makeAnchor({ anchorId: 'ytd_far', family: 'CALENDAR_YTD', distanceAtr: 1.05 })],
    });
    expect(farMacro.macroAxisRefs).toHaveLength(0);
    expect(farMacro.visibleAnchors).toHaveLength(0);
  });

  it('blocks negative controls unconditionally and gates POST_OPEX to OPEX_CYCLE_MARKER only when toggled on', async () => {
    const vmMod = (await import(/* @vite-ignore */ VIEW_MODEL_SPEC)) as ViewModelModule;

    const mixedAnchors: TestAnchorInput[] = [
      makeAnchor({ anchorId: 'neg_inline', family: 'EARNINGS_INLINE', distanceAtr: 0.1, iass: { scoreConservative: 99 } }),
      makeAnchor({ anchorId: 'neg_norvol', family: 'SWING_NO_RVOL', distanceAtr: 0.2, iass: { scoreConservative: 98 } }),
      makeAnchor({ anchorId: 'neg_div', family: 'EX_DIVIDEND_REGULAR', distanceAtr: 0.3, iass: { scoreConservative: 97 } }),
      makeAnchor({ anchorId: 'opex_1', family: 'POST_OPEX', anchorDate: '2026-10-19', distanceAtr: 0.4, iass: { scoreConservative: 96 } }),
      makeAnchor({ anchorId: 'real_ern', family: 'EARNINGS_BLOWOUT', distanceAtr: 0.5, iass: { scoreConservative: 78 } }),
    ];

    const defaultVm = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext(),
      activeTimeframe: '1D',
      anchors: mixedAnchors,
      opexResetMarkerDates: ['2026-11-23'],
    });
    expect(defaultVm.visibleAnchors.map((a) => a.anchorId)).toEqual(['real_ern']);
    expect(defaultVm.opexCycleMarkers).toHaveLength(0);

    const withOpexMarker = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext(),
      activeTimeframe: '1D',
      anchors: mixedAnchors,
      opexResetMarkerDates: ['2026-11-23'],
      preferences: { showOpexResetMarker: true },
    });
    expect(withOpexMarker.visibleAnchors.map((a) => a.anchorId)).toEqual(['real_ern']);
    expect(withOpexMarker.opexCycleMarkers.length).toBeGreaterThanOrEqual(1);
    for (const marker of withOpexMarker.opexCycleMarkers) {
      expect(marker.markerKind).toBe('OPEX_CYCLE_MARKER');
      expect(marker.isSupportResistance).toBe(false);
    }
  });

  it('hides hybrid bands by default on 1W and shows focused ±1σ/±2σ/±2.5σ (~p95) on 1D/1H/5m', async () => {
    const vmMod = (await import(/* @vite-ignore */ VIEW_MODEL_SPEC)) as ViewModelModule;
    const anchor = makeAnchor({ anchorId: 'ern1', family: 'EARNINGS_BLOWOUT', distanceAtr: 0.4 });

    const weeklyDefault = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext(),
      activeTimeframe: '1W',
      anchors: [anchor],
      preferences: { focusedAnchorId: 'ern1', showFocusedBands: true },
    });
    expect(weeklyDefault.focusedBands.visible).toBe(false);
    expect(weeklyDefault.focusedBands.hiddenReason).toBe('WEEKLY_HIDDEN_BY_DEFAULT');
    expect(weeklyDefault.chartPriceLines.some((l) => l.kind === 'FOCUSED_BAND')).toBe(false);

    for (const tf of ['1D', '1H', '5m'] as const) {
      const focusedVm = vmMod.buildInstitutionalAvwapContextViewModel({
        context: makeBaseContext(),
        activeTimeframe: tf,
        anchors: [anchor],
        preferences: { focusedAnchorId: 'ern1', showFocusedBands: true },
      });
      expect(focusedVm.focusedBands.visible).toBe(true);
      expect(focusedVm.focusedBands.focusedAnchorId).toBe('ern1');
      const extremes = focusedVm.focusedBands.levels.filter((b) => b.sigma === 2.5);
      expect(extremes).toHaveLength(2);
      expect(extremes.every((b) => b.isCalibratedExtreme && b.emphasis === 'CALIBRATED_EXTREME_P95')).toBe(true);
      const bandLines = focusedVm.chartPriceLines.filter((l) => l.kind === 'FOCUSED_BAND');
      expect(bandLines.length).toBe(4);
    }
  });

  it('maps SHORT_GAMMA_BOUNCE_HAZARD, dominance, all degradationFlags, DECAYING styles, and safe NaN fallbacks', async () => {
    const vmMod = (await import(/* @vite-ignore */ VIEW_MODEL_SPEC)) as ViewModelModule;

    // Safe number formatting on null / undefined / NaN / Infinity
    expect(vmMod.formatAvwapNumber(null)).toBe('—');
    expect(vmMod.formatAvwapNumber(undefined)).toBe('—');
    expect(vmMod.formatAvwapNumber(Number.NaN)).toBe('—');
    expect(vmMod.formatAvwapNumber(Number.POSITIVE_INFINITY)).toBe('—');
    expect(vmMod.formatAvwapSignedNumber(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(vmMod.formatAvwapPercent(Number.NaN)).toBe('—');

    const decayingAnchor = makeAnchor({
      anchorId: 'dec1',
      family: 'VOLUME_CLIMAX',
      lifecycleState: 'DECAYING',
      decayReasons: ['COHORT_DECAY', 'CHOP_SATURATION', 'FLAT_SLOPE'],
      cohortSurvival: 0.18,
      floatIsNonPit: true,
      avwap: Number.NaN,
      distanceAtr: 0.9,
      zScorePath: Number.NaN,
      iass: { scoreConservative: null, dataCoverage: null },
    });

    const hazardVm = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext({
        bounceConfluenceScore: 31,
        breakoutConfluenceScore: 84,
        netGexNormalizedG: -0.62,
        gammaRegime: 'NEGATIVE_GAMMA',
        volRegime: 'HIGH_VOL_TREND',
        hazardFlags: ['SHORT_GAMMA_BOUNCE_HAZARD'],
        flags: [
          'NO_ORATS_COVERAGE',
          'ORATS_OI_FALLBACK_MASSIVE',
          'FLOAT_NON_PIT_SNAPSHOT',
          'MISSING_WHAM_COVERAGE',
          'CORP_ACTION_CONFLICT_QUARANTINED',
          'NO_NBBO_AGGRESSOR_SIDE',
          'NO_NOI_IMBALANCE_FEED',
        ],
      }),
      activeTimeframe: '1D',
      anchors: [decayingAnchor],
    });

    expect(hazardVm.shortGammaBounceHazard).toBe(true);
    expect(hazardVm.gammaBadge.kind).toBe('SHORT_GAMMA_BOUNCE_HAZARD');
    expect(hazardVm.gammaBadge.detail).toContain('Short Gamma: rebotes degradados');
    expect(hazardVm.volRegimeBadge.label).toBe('High Vol · Trend');
    expect(hazardVm.dominantConfluence).toBe('BREAKOUT');

    const flagLabels = new Map(hazardVm.degradationBadges.map((b) => [b.flag, b.label]));
    expect(flagLabels.get('NO_ORATS_COVERAGE')).toBe('Sin ORATS (cobertura parcial)');
    expect(flagLabels.get('ORATS_OI_FALLBACK_MASSIVE')).toBe('OI vía Massive fallback');
    expect(flagLabels.get('FLOAT_NON_PIT_SNAPSHOT')).toBe('Float snapshot actual');
    expect(flagLabels.get('MISSING_WHAM_COVERAGE')).toBe('Sin WHAM');
    expect(flagLabels.get('CORP_ACTION_CONFLICT_QUARANTINED')).toBe('Acción corp. en cuarentena');
    expect(flagLabels.get('NO_NBBO_AGGRESSOR_SIDE')).toBe('Sin lado agresor NBBO');
    expect(flagLabels.get('NO_NOI_IMBALANCE_FEED')).toBe('Sin feed NOI imbalance');

    const decView = hazardVm.visibleAnchors[0];
    expect(decView).toBeDefined();
    expect(decView?.style.opacity).toBeCloseTo(0.4, 9);
    expect(decView?.style.lineStyle).toBe('DOTTED');
    expect(decView?.decayReasons.map((r) => r.code)).toEqual([
      'COHORT_DECAY',
      'CHOP_SATURATION',
      'FLAT_SLOPE',
    ]);
    expect(decView?.avwapFormatted).toBe('—');
    expect(decView?.zScorePathFormatted).toBe('—');
    expect(decView?.iassConservativeFormatted).toBe('—');

    // Dominance BOUNCE check
    const bounceVm = vmMod.buildInstitutionalAvwapContextViewModel({
      context: makeBaseContext({
        bounceConfluenceScore: 81,
        breakoutConfluenceScore: 38,
        gammaRegime: 'POSITIVE_GAMMA',
        volRegime: 'LOW_VOL_CHOP',
      }),
      activeTimeframe: '1D',
    });
    expect(bounceVm.dominantConfluence).toBe('BOUNCE');
    expect(bounceVm.gammaBadge.kind).toBe('POSITIVE_GAMMA');
    expect(bounceVm.volRegimeBadge.label).toBe('Low Vol · Chop');
  });

  it('renders InstitutionalAvwapContextPanel cleanly via renderToStaticMarkup (full hazard+pinch+degraded context and null context)', async () => {
    const panelMod = (await import(/* @vite-ignore */ PANEL_SPEC)) as PanelModule;

    // Null context degrades to empty string cleanly
    const nullHtml = reactDomServer.renderToStaticMarkup(
      reactRuntime.createElement(panelMod.InstitutionalAvwapContextPanel, {
        context: null,
        activeTimeframe: '1D',
      }),
    );
    expect(nullHtml).toBe('');

    const fullHtml = reactDomServer.renderToStaticMarkup(
      reactRuntime.createElement(panelMod.InstitutionalAvwapContextPanel, {
        context: makeBaseContext({
          bounceConfluenceScore: 29,
          breakoutConfluenceScore: 86,
          netGexNormalizedG: -0.55,
          gammaRegime: 'NEGATIVE_GAMMA',
          volRegime: 'HIGH_VOL_TREND',
          hazardFlags: ['SHORT_GAMMA_BOUNCE_HAZARD'],
          flags: ['NO_ORATS_COVERAGE'],
        }),
        activeTimeframe: '1D',
        focusedAnchorId: 'p1',
        showFocusedBands: true,
        anchors: [
          makeAnchor({
            anchorId: 'p1',
            family: 'EARNINGS_BLOWOUT',
            lifecycleState: 'PINCH_PAIR',
            pinchPartnerId: 'p2',
            avwap: 152.1,
            distanceAtr: 0.45,
          }),
          makeAnchor({
            anchorId: 'p2',
            family: 'CALENDAR_YTD',
            lifecycleState: 'PINCH_PAIR',
            pinchPartnerId: 'p1',
            avwap: 148.6,
            distanceAtr: -0.55,
          }),
          makeAnchor({
            anchorId: 'd1',
            family: 'VOLUME_CLIMAX',
            lifecycleState: 'DECAYING',
            decayReasons: ['CHOP_SATURATION'],
            avwap: 145.0,
            distanceAtr: -1.2,
            floatIsNonPit: true,
          }),
        ],
      }),
    );

    expect(fullHtml).toContain('Institutional AVWAP');
    expect(fullHtml).toContain('Context Only');
    expect(fullHtml).toContain('SHORT_GAMMA_BOUNCE_HAZARD');
    expect(fullHtml).toContain('Short Gamma: rebotes degradados');
    expect(fullHtml).toContain('PINCH');
    expect(fullHtml).toContain('+2.5σ (~p95)');
    expect(fullHtml).toContain('Sin ORATS (cobertura parcial)');
    expect(fullHtml).toContain('Bounce / Absorption');
    expect(fullHtml).toContain('Breakout / Expansion');
    expect(fullHtml).toContain('non-PIT');
    expect(fullHtml).not.toContain('NaN');
    expect(fullHtml).not.toMatch(/\bLONG ENTRY\b|\bSHORT ENTRY\b/);
  });
});
