import { normCdf } from '../options/math.js';
import type {
  AvwapPolarity,
  IassBreakdown,
  IassConfig,
  IassFeatures,
} from './types.js';

export interface FamilyPriorRegistryEntry {
  readonly prior: number;
  readonly specStatus: string;
  readonly note: string;
}

export const FAMILY_PRIOR_REGISTRY: Readonly<Record<string, FamilyPriorRegistryEntry>> = Object.freeze({
  IPO_DIRECT: { prior: 0.9, specStatus: 'APPROVED_SPEC', note: 'Direct listing / IPO primary day' },
  INDEX_REBAL: { prior: 0.8, specStatus: 'APPROVED_SPEC', note: 'Verified index constituent addition/removal' },
  SECONDARY_OFFERING: {
    prior: 0.75,
    specStatus: 'APPROVED_SPEC',
    note: 'Confirmed executed offering (never bare S-3 shelf)',
  },
  EARNINGS_BLOWOUT: {
    prior: 0.7,
    specStatus: 'APPROVED_SPEC',
    note: 'Confirmed earnings move >= 1.25x ex-ante implied',
  },
  EARNINGS_INLINE: {
    prior: 0.7,
    specStatus: 'APPROVED_SPEC',
    note: 'Negative control: earnings move < 0.75x ex-ante implied',
  },
  POST_OPEX: {
    prior: 0.65,
    specStatus: 'APPROVED_SPEC',
    note: 'First session post OpEx with expiring_gex_share >= 0.25',
  },
  CALENDAR_YTD: { prior: 0.65, specStatus: 'APPROVED_SPEC', note: 'First RTH session of calendar year' },
  CALENDAR_QTD: { prior: 0.65, specStatus: 'APPROVED_SPEC', note: 'First RTH session of calendar quarter' },
  MACRO_EVENT: { prior: 0.6, specStatus: 'APPROVED_SPEC', note: 'US Tier-1 macro release' },
  MACRO_SHOCK: {
    prior: 0.6,
    specStatus: 'APPROVED_MAPPED_FROM_MACRO_EVENT',
    note: 'US_ETF >= 2023 macro surprise/WHAM shock',
  },
  CALENDAR_MTD: { prior: 0.4, specStatus: 'APPROVED_SPEC', note: 'First RTH session of calendar month' },
  CALENDAR_WTD: { prior: 0.4, specStatus: 'APPROVED_SPEC', note: 'First RTH session of calendar week' },
  STRUCTURAL: { prior: 0.25, specStatus: 'APPROVED_SPEC', note: 'Generic technical structural anchor' },
  VOLUME_CLIMAX: {
    prior: 0.25,
    specStatus: 'APPROVED_MAPPED_FROM_STRUCTURAL',
    note: 'Causal OHLCV range >= 1.8*ATR + extreme close',
  },
  BREAKAWAY_GAP: {
    prior: 0.25,
    specStatus: 'APPROVED_MAPPED_FROM_STRUCTURAL',
    note: 'Causal session gap >= 1.8*ATR + extreme close',
  },
  SWING_CAUSAL: {
    prior: 0.25,
    specStatus: 'APPROVED_MAPPED_FROM_STRUCTURAL',
    note: 'Causal swing ATR 2.0, k_min=2, anchor_rvol_z >= 1.5',
  },
  SWING_NO_RVOL: {
    prior: 0.25,
    specStatus: 'APPROVED_SPEC',
    note: 'Negative control: swing without RVOL confirmation',
  },
  OPTIONS_FLOW_SHOCK: {
    prior: 0.35,
    specStatus: 'APPROVED_SPEC',
    note: 'Unusual OPRA OI/Vol shock; sealed neutral prior',
  },
  EX_DIVIDEND_REGULAR: {
    prior: 0.15,
    specStatus: 'APPROVED_SPEC',
    note: 'Negative control: recurring dividend < 1.5% prev close',
  },
});

export const DEFAULT_IASS_CONFIG: IassConfig = Object.freeze({
  configVersion: 'iass_v2_sealed_2026_11_25',
  weightM: 0.3,
  weightD: 0.3,
  weightF: 0.2,
  weightS: 0.2,
  degradationPrior: 35.0,
  tier1Min: 70.0,
  tier2Min: 45.0,
  floatTurnoverScale: 0.03,
  dMoveLogisticK: 2.5,
  dShockScale: 2.0,
  sGapScale: 1.5,
  sDispScale: 2.0,
  mSubweights: Object.freeze({ M_rvol: 0.5, M_float: 0.3, M_auction: 0.2 }),
  dSubweights: Object.freeze({ D_move: 0.45, D_shock: 0.25, D_iv: 0.2, D_term: 0.1 }),
  sSubweights: Object.freeze({ S_gap: 0.5, S_disp: 0.5 }),
  surpriseFloor: 0.05,
  surpriseTanhScale: 0.5,
  surpriseBlendWeight: 0.2,
});

function validateSubweights(
  groupName: string,
  weights: Readonly<Record<string, number>>,
): void {
  let sum = 0;
  for (const [k, v] of Object.entries(weights)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`${groupName}[${k}] must be finite >= 0, got ${String(v)}`);
    }
    sum += v;
  }
  if (Math.abs(sum - 1.0) > 1e-9) {
    throw new RangeError(`${groupName} must sum to 1.0, got ${String(sum)}`);
  }
}

export function validateIassConfig(config: IassConfig): void {
  const total = config.weightM + config.weightD + config.weightF + config.weightS;
  if (Math.abs(total - 1.0) > 1e-9) {
    throw new RangeError(`Base pillar weights must sum to 1.0 within 1e-9, got ${String(total)}`);
  }
  if (config.tier2Min >= config.tier1Min) {
    throw new RangeError('tier2Min must be strictly less than tier1Min');
  }
  validateSubweights('mSubweights', config.mSubweights);
  validateSubweights('dSubweights', config.dSubweights);
  validateSubweights('sSubweights', config.sSubweights);
}

function isValidFiniteNumber(x: number | null | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp(val: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, val));
}

function renormalizedPillar(
  subValues: Readonly<Record<string, number | null>>,
  subWeights: Readonly<Record<string, number>>,
): readonly [number | null, number] {
  let num = 0;
  let den = 0;
  let totalPossible = 0;
  for (const [name, val] of Object.entries(subValues)) {
    const w = subWeights[name] ?? 0;
    totalPossible += w;
    if (isValidFiniteNumber(val) && w > 0) {
      num += w * val;
      den += w;
    }
  }
  if (den <= 0) {
    return [null, 0];
  }
  const cov = totalPossible > 0 ? Math.min(1, den / totalPossible) : 1;
  return [clamp(num / den, 0, 1), cov];
}

export function classifyIassTier(
  scoreConservative: number,
  dataCoverage: number,
  config: IassConfig = DEFAULT_IASS_CONFIG,
): IassBreakdown['tier'] {
  if (dataCoverage <= 0 || !Number.isFinite(scoreConservative)) {
    return 'INSUFFICIENT_DATA';
  }
  if (scoreConservative >= config.tier1Min) {
    return 'TIER_1';
  }
  if (scoreConservative >= config.tier2Min) {
    return 'TIER_2';
  }
  return 'NOISE';
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}

/**
 * Deterministic Institutional Anchor Significance Score (IASS) engine.
 * Pure 1:1 port of `research/avwap_oracle/src/avwap_oracle/scoring/iass.py`.
 */
export function computeIass(
  features: IassFeatures,
  config: IassConfig = DEFAULT_IASS_CONFIG,
): IassBreakdown {
  validateIassConfig(config);

  const polarity: AvwapPolarity = features.polarity ?? 'LONG';
  const oratsOpraCovered = features.oratsOpraCovered ?? true;
  const floatIsPit = features.floatIsPit ?? false;
  const allowNonPitFloatSensitivity = features.allowNonPitFloatSensitivity ?? false;
  const catalystDataAvailable = features.catalystDataAvailable ?? true;
  const surpriseIsPitVerified = features.surpriseIsPitVerified ?? false;
  const atrValid = features.atrValid ?? true;

  const reasons: string[] = [];

  // Pillar M: Participation & Liquidity
  const mRvol: number | null = isValidFiniteNumber(features.rvolZ)
    ? normCdf(features.rvolZ)
    : null;

  let mFloat: number | null = null;
  if (isValidFiniteNumber(features.floatTurnoverPct) && features.floatTurnoverPct >= 0) {
    const floatPitOk =
      floatIsPit &&
      (features.floatAsofUtcSec === undefined ||
        features.floatAsofUtcSec === null ||
        features.floatAsofUtcSec <= features.featureAsof);
    if (floatPitOk) {
      mFloat = 1 - Math.exp(-features.floatTurnoverPct / config.floatTurnoverScale);
    } else if (allowNonPitFloatSensitivity) {
      reasons.push('FLOAT_NON_PIT_SNAPSHOT', 'FLOAT_NON_PIT_SENSITIVITY_ENABLED');
      mFloat = 1 - Math.exp(-features.floatTurnoverPct / config.floatTurnoverScale);
    } else {
      reasons.push('FLOAT_NON_PIT_SNAPSHOT');
    }
  }

  const mAuction: number | null = isValidFiniteNumber(features.auctionRatioZ)
    ? normCdf(features.auctionRatioZ)
    : null;

  const [pM, covM] = renormalizedPillar(
    { M_rvol: mRvol, M_float: mFloat, M_auction: mAuction },
    config.mSubweights,
  );

  // Pillar D: Derivatives Repricing
  let dMove: number | null = null;
  let dShock: number | null = null;
  let dIv: number | null = null;
  let dTerm: number | null = null;
  let pD: number | null = null;
  let covD = 0;

  if (!oratsOpraCovered) {
    reasons.push('MISSING_ORATS_OPRA_COVERAGE');
  } else {
    if (features.oiSource === 'MASSIVE_FALLBACK') {
      reasons.push('ORATS_OI_FALLBACK_MASSIVE');
    }

    if (
      isValidFiniteNumber(features.realizedReturn) &&
      isValidFiniteNumber(features.impliedMoveDec) &&
      features.impliedMoveDec > 0
    ) {
      const impAvail = features.impliedMoveAvailableAtUtcSec;
      const retStart = features.realizedReturnStartTsUtcSec;
      if (impAvail !== undefined && impAvail !== null && retStart !== undefined && retStart !== null && impAvail > retStart) {
        reasons.push('IMPLIED_MOVE_NOT_EX_ANTE_EXCLUDED');
      } else if (impAvail !== undefined && impAvail !== null && impAvail > features.featureAsof) {
        reasons.push('IMPLIED_MOVE_FUTURE_EXCLUDED');
      } else {
        const ratio = Math.abs(features.realizedReturn) / features.impliedMoveDec;
        const exponent = Math.max(-60, Math.min(60, -config.dMoveLogisticK * (ratio - 1)));
        dMove = 1 / (1 + Math.exp(exponent));
      }
    }

    if (isValidFiniteNumber(features.oiGexShock)) {
      dShock = 1 - Math.exp(-Math.max(0, features.oiGexShock) / config.dShockScale);
    }

    if (isValidFiniteNumber(features.ivChangeZ)) {
      dIv = normCdf(features.ivChangeZ);
    }

    if (isValidFiniteNumber(features.termTransitionScore)) {
      if (features.termTransitionScore >= 0 && features.termTransitionScore <= 1) {
        dTerm = features.termTransitionScore;
      } else {
        reasons.push('INVALID_D_TERM_OUT_OF_UNIT_RANGE');
      }
    }

    const dVals: Record<string, number | null> = {
      D_move: dMove,
      D_shock: dShock,
      D_iv: dIv,
    };
    const dWeights: Record<string, number> = {
      D_move: config.dSubweights.D_move,
      D_shock: config.dSubweights.D_shock,
      D_iv: config.dSubweights.D_iv,
    };
    if (dTerm !== null) {
      dVals['D_term'] = dTerm;
      dWeights['D_term'] = config.dSubweights.D_term;
    }
    [pD, covD] = renormalizedPillar(dVals, dWeights);
    if (pD === null) {
      reasons.push('PILLAR_D_NO_VALID_SUBCOMPONENTS');
    }
  }

  // Pillar F: Catalyst & Mandate
  let fPrior: number | null = null;
  let fSurprise: number | null = null;
  let pF: number | null = null;
  let covF = 0;

  if (!catalystDataAvailable) {
    reasons.push('CATALYST_DATA_UNAVAILABLE');
  } else {
    const famKey = features.family.trim().toUpperCase();
    const regEntry = FAMILY_PRIOR_REGISTRY[famKey];
    if (regEntry !== undefined) {
      fPrior = regEntry.prior;
      if (regEntry.specStatus.includes('PENDING_DOC')) {
        reasons.push(`PRIOR_PENDING_DOC_SPEC:${famKey}`);
      }
    } else {
      reasons.push(`UNREGISTERED_FAMILY_PRIOR:${famKey}`);
      fPrior = null;
    }

    if (fPrior !== null) {
      pF = fPrior;
      covF = 1;
      if (isValidFiniteNumber(features.actualValue) && isValidFiniteNumber(features.estimatedValue)) {
        const pitOk =
          surpriseIsPitVerified &&
          (features.surpriseAvailableAtUtcSec === undefined ||
            features.surpriseAvailableAtUtcSec === null ||
            features.surpriseAvailableAtUtcSec <= features.featureAsof);
        if (pitOk) {
          const denom = Math.max(Math.abs(features.estimatedValue), config.surpriseFloor);
          const rawSurp = Math.abs(features.actualValue - features.estimatedValue) / denom;
          fSurprise = Math.tanh(rawSurp / config.surpriseTanhScale);
          const wS = config.surpriseBlendWeight;
          pF = (1 - wS) * fPrior + wS * fSurprise;
        } else {
          reasons.push('SURPRISE_EXCLUDED_NON_PIT');
        }
      }
    }
  }

  // Pillar S: Structural Displacement
  let sGap: number | null = null;
  let sDisp: number | null = null;
  let pS: number | null = null;
  let covS = 0;

  const atrCausalOk =
    atrValid &&
    (features.atrAvailableAtUtcSec === undefined ||
      features.atrAvailableAtUtcSec === null ||
      features.atrAvailableAtUtcSec <= features.featureAsof);
  if (!atrCausalOk) {
    reasons.push('ATR_UNAVAILABLE_OR_NON_CAUSAL');
  } else {
    if (isValidFiniteNumber(features.gapAtr)) {
      sGap = Math.tanh(Math.abs(features.gapAtr) / config.sGapScale);
    }
    if (isValidFiniteNumber(features.closeDispAtr)) {
      sDisp = Math.tanh(Math.abs(features.closeDispAtr) / config.sDispScale);
    }
    [pS, covS] = renormalizedPillar({ S_gap: sGap, S_disp: sDisp }, config.sSubweights);
  }

  const componentScores: Readonly<Record<string, number | null>> = {
    M_rvol: mRvol,
    M_float: mFloat,
    M_auction: mAuction,
    D_move: dMove,
    D_shock: dShock,
    D_iv: dIv,
    D_term: dTerm,
    F_prior: fPrior,
    F_surprise: fSurprise,
    S_gap: sGap,
    S_disp: sDisp,
  };
  const pillarScores = { M: pM, D: pD, F: pF, S: pS };
  const componentCoverage = { M: covM, D: covD, F: covF, S: covS };

  const weightedPairs: readonly [number, number | null][] = [
    [config.weightM, pM],
    [config.weightD, pD],
    [config.weightF, pF],
    [config.weightS, pS],
  ];

  let rawCoverage = 0;
  let weightedSum = 0;
  for (const [w, val] of weightedPairs) {
    if (isValidFiniteNumber(val)) {
      rawCoverage += w;
      weightedSum += w * val;
    }
  }
  const dataCoverage = clamp(rawCoverage, 0, 1);

  if (dataCoverage <= 0) {
    return {
      configVersion: config.configVersion,
      family: features.family,
      polarity,
      dataCoverage: 0,
      prior: config.degradationPrior,
      componentCoverage,
      scoreRenormalized: null,
      scoreConservative: config.degradationPrior,
      pillarScores,
      componentScores,
      tier: 'INSUFFICIENT_DATA',
      status: 'INSUFFICIENT_DATA',
      degradationReasons: uniqueStrings([...reasons, 'ZERO_DATA_COVERAGE']),
      featureAsof: features.featureAsof,
    };
  }

  const scoreRenormalized = clamp((100 * weightedSum) / dataCoverage, 0, 100);
  const scoreConservative = clamp(
    dataCoverage * scoreRenormalized + (1 - dataCoverage) * config.degradationPrior,
    0,
    100,
  );
  const tier = classifyIassTier(scoreConservative, dataCoverage, config);
  const status: IassBreakdown['status'] = dataCoverage >= 1 - 1e-12 ? 'OK' : 'PARTIAL_COVERAGE';

  return {
    configVersion: config.configVersion,
    family: features.family,
    polarity,
    dataCoverage,
    prior: config.degradationPrior,
    componentCoverage,
    scoreRenormalized,
    scoreConservative,
    pillarScores,
    componentScores,
    tier,
    status,
    degradationReasons: uniqueStrings(reasons),
    featureAsof: features.featureAsof,
  };
}
