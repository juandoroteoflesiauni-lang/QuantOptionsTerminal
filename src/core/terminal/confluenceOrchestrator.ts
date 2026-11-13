/**
 * Orquestador puro de Confluencia Multi-Capa (Bloques A + B + C) y Extracción
 * de Niveles Clave para Chart (Pieza 12).
 *
 * Integra de forma determinista y sin mutar entradas:
 *  - Pilar 1 (`mtf`): Estructura Multi-Timeframe en Cascada (`1D -> 4H -> 15m -> 5m`).
 *  - Pilar 2 (`optionsPositioning`): Posicionamiento de Opciones (`netDex`, `netGex`,
 *    `GammaFlip`, `CallWall`, `PutWall`) y Skew 25Δ (`riskReversal25 = IV_25P - IV_25C`).
 *  - Pilar 3 (`openingAuction`): Taxonomía de Apertura e Inventario Pre-Market (`04:00–10:30 ET`).
 *  - Pilar 4 (`cvdAbsorption`): Cumulative Volume Delta de sesión y Absorción Pasiva.
 *  - Pilar 5 (`divergences`): Divergencias causales confirmadas de RSI(14) y SMT.
 *  - Pilar 6 (`breadthMacro`): Amplitud de Mercado (`A/D Line` slope + divergencia)
 *    modulada por `positionSizeMultiplier` del régimen macro `VIX`/`CBOE SKEW`.
 *
 * Garantías de diseño:
 *  - Funciones puras, cero red, cero E/S, cero mutación de argumentos.
 *  - Cero fallbacks silenciosos: pilares o métricas ausentes permanecen `Number.NaN`
 *    con estado explícito `'NO_DATA'`.
 */

import type {
  MacroVolatilityRegimeResult,
  MarketBreadthResult,
} from '../microstructure/breadthMacro.js';
import type { CvdAbsorptionResult } from '../microstructure/cvdAbsorption.js';
import type {
  RsiDivergenceResult,
  SmtDivergenceResult,
} from '../microstructure/divergences.js';
import type { MtfStructureResult } from '../microstructure/mtfStructure.js';
import type { OpeningAuctionResult } from '../microstructure/types.js';
import type { DealerExposureResult } from '../options/exposure.js';
import type { VolSliceMetrics } from '../options/volMetrics.js';
import { MAX_TIME_SECONDS } from '../sessions.js';
import { computeVrpSpread } from './realizedVol.js';
import type {
  DirectionalBias,
  GammaRegime,
  KeyLevelName,
  KeyLevelSource,
  PillarAssessment,
  PillarId,
  PillarWeights,
  TerminalAuxiliaryMetrics,
  TerminalConfluenceInputs,
  TerminalConfluenceSnapshot,
  TerminalKeyLevel,
} from './types.js';

export const DEFAULT_AD_SLOPE_WINDOW = 5;

export const DEFAULT_PILLAR_WEIGHTS: PillarWeights = {
  mtf: 1,
  optionsPositioning: 1,
  openingAuction: 1,
  cvdAbsorption: 1,
  divergences: 1,
  breadthMacro: 1,
};

export const PILLAR_IDS: readonly PillarId[] = [
  'mtf',
  'optionsPositioning',
  'openingAuction',
  'cvdAbsorption',
  'divergences',
  'breadthMacro',
];

const PILLAR_LABELS: Readonly<Record<PillarId, string>> = {
  mtf: 'Estructura MTF en Cascada',
  optionsPositioning: 'Posicionamiento de Opciones y Gamma',
  openingAuction: 'Subasta de Apertura e Inventario',
  cvdAbsorption: 'Flujo CVD y Absorción Pasiva',
  divergences: 'Divergencias RSI(14) y SMT',
  breadthMacro: 'Amplitud A/D y Régimen Macro VIX/SKEW',
};

const KEY_LEVEL_ORDER: readonly KeyLevelName[] = [
  'CallWall',
  'PutWall',
  'GammaFlip',
  'PMH',
  'PML',
  'ON_POC',
  'ON_VAH',
  'ON_VAL',
  'IBH',
  'IBL',
  'PDH',
  'PDL',
  'PDC',
  'SMA200_1D',
  'SMA50_4H',
  'EMA21_15M',
  'HMA55_5M',
];

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.max(-1, Math.min(1, value));
}

function signOf(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

function assertValidUtcSeconds(time: number, label: string): void {
  if (!Number.isFinite(time) || !Number.isInteger(time) || Math.abs(time) > MAX_TIME_SECONDS) {
    throw new Error(`${label} must be finite integer UTC seconds (got ${String(time)})`);
  }
}

function assertPositiveInteger(value: number, label: string, minValue: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minValue) {
    throw new Error(
      `${label} must be a finite integer >= ${String(minValue)} (got ${String(value)})`,
    );
  }
  return value;
}

function resolvePillarWeights(overrides: Partial<PillarWeights> | undefined): PillarWeights {
  const weights: Record<PillarId, number> = {
    mtf: DEFAULT_PILLAR_WEIGHTS.mtf,
    optionsPositioning: DEFAULT_PILLAR_WEIGHTS.optionsPositioning,
    openingAuction: DEFAULT_PILLAR_WEIGHTS.openingAuction,
    cvdAbsorption: DEFAULT_PILLAR_WEIGHTS.cvdAbsorption,
    divergences: DEFAULT_PILLAR_WEIGHTS.divergences,
    breadthMacro: DEFAULT_PILLAR_WEIGHTS.breadthMacro,
  };
  if (overrides === undefined) {
    return weights;
  }
  for (const id of PILLAR_IDS) {
    const candidate = overrides[id];
    if (candidate !== undefined) {
      if (!Number.isFinite(candidate) || candidate < 0) {
        throw new Error(
          `options.weights.${id} must be a finite number >= 0 (got ${String(candidate)})`,
        );
      }
      weights[id] = candidate;
    }
  }
  return weights;
}

function buildPillar(
  id: PillarId,
  weight: number,
  score: number,
  summaryCode: string,
): PillarAssessment {
  const valid = Number.isFinite(score);
  return {
    id,
    label: PILLAR_LABELS[id],
    status: valid ? 'OK' : 'NO_DATA',
    score: valid ? score : Number.NaN,
    weight,
    weightedContribution: valid ? score * weight : Number.NaN,
    summaryCode,
  };
}

function classifyGammaRegime(exposure: DealerExposureResult | null | undefined): GammaRegime {
  if (exposure === null || exposure === undefined) {
    return 'NO_DATA';
  }
  const { spot, gammaFlipSpot, netGex } = exposure;
  if (
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(gammaFlipSpot) ||
    gammaFlipSpot <= 0 ||
    !Number.isFinite(netGex)
  ) {
    return 'NO_DATA';
  }
  if (spot > gammaFlipSpot && netGex > 0) {
    return 'POSITIVE_GAMMA';
  }
  if (spot < gammaFlipSpot && netGex < 0) {
    return 'NEGATIVE_GAMMA';
  }
  return 'TRANSITION_ZONE';
}

function assessMtfPillar(
  mtf: MtfStructureResult | null | undefined,
  weight: number,
): PillarAssessment {
  if (mtf === null || mtf === undefined || mtf.effectiveMacroRegime === 'INSUFFICIENT_DATA') {
    return buildPillar('mtf', weight, Number.NaN, 'NO_DATA');
  }

  let baseScore: number;
  if (mtf.effectiveMacroRegime === 'BULLISH_REGIME') {
    baseScore = 1;
  } else if (mtf.effectiveMacroRegime === 'BEARISH_REGIME') {
    baseScore = -1;
  } else {
    baseScore = 0;
  }

  if (mtf.executionTriggerActive && mtf.effectiveMacroRegime === 'BULLISH_REGIME') {
    return buildPillar('mtf', weight, clampScore(baseScore + 0.25), 'BULLISH_REGIME_TRIGGERED');
  }
  if (mtf.executionTriggerActive && mtf.effectiveMacroRegime === 'BEARISH_REGIME') {
    return buildPillar('mtf', weight, clampScore(baseScore - 0.25), 'BEARISH_REGIME_TRIGGERED');
  }
  return buildPillar('mtf', weight, baseScore, mtf.effectiveMacroRegime);
}

function assessOptionsPillar(
  exposure: DealerExposureResult | null | undefined,
  volMetrics: VolSliceMetrics | null | undefined,
  gammaRegime: GammaRegime,
  weight: number,
): PillarAssessment {
  const dexSignal =
    exposure !== null && exposure !== undefined && Number.isFinite(exposure.netDex)
      ? signOf(exposure.netDex)
      : Number.NaN;

  // Convención Pieza 5: riskReversal25 = put25Iv - call25Iv -> puts caras (> 0) implican sesgo defensivo/bajista.
  const rrSignal =
    volMetrics !== null && volMetrics !== undefined && Number.isFinite(volMetrics.riskReversal25)
      ? signOf(-volMetrics.riskReversal25)
      : Number.NaN;

  let score = Number.NaN;
  let summaryCode = 'NO_DATA';

  if (Number.isFinite(dexSignal) && Number.isFinite(rrSignal)) {
    score = clampScore(0.5 * dexSignal + 0.5 * rrSignal);
    summaryCode = gammaRegime !== 'NO_DATA' ? gammaRegime : 'DEX_AND_SKEW_25D';
  } else if (Number.isFinite(dexSignal)) {
    score = dexSignal;
    summaryCode = gammaRegime !== 'NO_DATA' ? `${gammaRegime}_DEX_ONLY` : 'DEX_ONLY';
  } else if (Number.isFinite(rrSignal)) {
    score = rrSignal;
    summaryCode = gammaRegime !== 'NO_DATA' ? `${gammaRegime}_SKEW_ONLY` : 'SKEW_25D_ONLY';
  }

  return buildPillar('optionsPositioning', weight, score, summaryCode);
}

function assessOpeningAuctionPillar(
  openingAuction: OpeningAuctionResult | null | undefined,
  weight: number,
): PillarAssessment {
  if (openingAuction === null || openingAuction === undefined) {
    return buildPillar('openingAuction', weight, Number.NaN, 'NO_DATA');
  }
  if (
    openingAuction.openingType === 'PENDING_OPEN' ||
    openingAuction.rthBarCount <= 0 ||
    !Number.isFinite(openingAuction.currentClose)
  ) {
    return buildPillar('openingAuction', weight, Number.NaN, 'PENDING_OPEN');
  }

  const dirSign =
    openingAuction.openingDirection === 'BULLISH'
      ? 1
      : openingAuction.openingDirection === 'BEARISH'
        ? -1
        : 0;

  let typeConviction: number;
  switch (openingAuction.openingType) {
    case 'OPEN_DRIVE':
      typeConviction = 1.0;
      break;
    case 'OPEN_TEST_DRIVE':
      typeConviction = 0.75;
      break;
    case 'OPEN_REJECTION_REVERSE':
      typeConviction = 0.5;
      break;
    case 'OPEN_AUCTION':
      typeConviction = 0.0;
      break;
  }

  const openingBase = typeConviction * dirSign;

  let inventorySignal = 0;
  if (openingAuction.inventoryRisk === 'SHORT_COVERING_RISK') {
    inventorySignal = 1;
  } else if (openingAuction.inventoryRisk === 'LONG_LIQUIDATION_RISK') {
    inventorySignal = -1;
  }

  const score = clampScore(0.6 * openingBase + 0.4 * inventorySignal);
  const summaryCode =
    openingAuction.inventoryRisk === 'NEUTRAL'
      ? `${openingAuction.openingType}_${openingAuction.openingDirection}`
      : `${openingAuction.openingType}_${openingAuction.openingDirection}_${openingAuction.inventoryRisk}`;

  return buildPillar('openingAuction', weight, score, summaryCode);
}

function assessCvdPillar(
  cvdAbsorption: CvdAbsorptionResult | null | undefined,
  weight: number,
): PillarAssessment {
  if (
    cvdAbsorption === null ||
    cvdAbsorption === undefined ||
    cvdAbsorption.closedInSessionCount <= 0 ||
    !Number.isFinite(cvdAbsorption.currentSessionCvd)
  ) {
    return buildPillar('cvdAbsorption', weight, Number.NaN, 'NO_DATA');
  }

  const cvdSign = signOf(cvdAbsorption.currentSessionCvd);
  const sessionEvents =
    cvdAbsorption.currentSessionDate !== null
      ? cvdAbsorption.absorptionEvents.filter(
          (ev) => ev.sessionDate === cvdAbsorption.currentSessionDate,
        )
      : cvdAbsorption.absorptionEvents;

  const latestEvent =
    sessionEvents.length > 0 ? sessionEvents[sessionEvents.length - 1] : undefined;

  if (latestEvent !== undefined) {
    const absSign = latestEvent.absorbingSide === 'BUY_ABSORPTION' ? 1 : -1;
    const score = clampScore(0.5 * cvdSign + 0.5 * absSign);
    return buildPillar('cvdAbsorption', weight, score, latestEvent.absorbingSide);
  }

  const summaryCode =
    cvdSign > 0 ? 'CVD_POSITIVE' : cvdSign < 0 ? 'CVD_NEGATIVE' : 'CVD_FLAT';
  return buildPillar('cvdAbsorption', weight, cvdSign, summaryCode);
}

function scoreRsiDivergenceType(type: 'RSI_REGULAR_BULLISH' | 'RSI_REGULAR_BEARISH' | 'RSI_HIDDEN_BULLISH' | 'RSI_HIDDEN_BEARISH'): number {
  if (type === 'RSI_REGULAR_BULLISH' || type === 'RSI_HIDDEN_BULLISH') {
    return 0.75;
  }
  return -0.75;
}

function assessDivergencesPillar(
  rsiDivergences: RsiDivergenceResult | null | undefined,
  smtDivergences: SmtDivergenceResult | null | undefined,
  weight: number,
): PillarAssessment {
  const rsiOk = rsiDivergences !== null && rsiDivergences !== undefined && rsiDivergences.status === 'OK';
  const smtOk = smtDivergences !== null && smtDivergences !== undefined && smtDivergences.status === 'OK';

  if (!rsiOk && !smtOk) {
    return buildPillar('divergences', weight, Number.NaN, 'NO_DATA');
  }

  const smtLatest = smtOk ? smtDivergences.latestDivergence : null;
  const rsiLatest = rsiOk ? rsiDivergences.latestDivergence : null;

  if (smtLatest === null && rsiLatest === null) {
    return buildPillar('divergences', weight, 0, 'NONE');
  }

  if (
    smtLatest !== null &&
    (rsiLatest === null || smtLatest.confirmedAtCloseUtcSec >= rsiLatest.confirmedAtCloseUtcSec)
  ) {
    const smtScore = smtLatest.type === 'SMT_BULLISH' ? 1.0 : -1.0;
    return buildPillar('divergences', weight, smtScore, smtLatest.type);
  }

  if (rsiLatest !== null) {
    return buildPillar(
      'divergences',
      weight,
      scoreRsiDivergenceType(rsiLatest.type),
      rsiLatest.type,
    );
  }

  return buildPillar('divergences', weight, 0, 'NONE');
}

function computeFiniteOlsSlope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) {
    return Number.NaN;
  }
  let sumY = 0;
  for (const y of values) {
    if (!Number.isFinite(y)) {
      return Number.NaN;
    }
    sumY += y;
  }
  const meanX = (n - 1) / 2;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const y = values[i];
    if (y === undefined) {
      return Number.NaN;
    }
    const dx = i - meanX;
    sxx += dx * dx;
    sxy += dx * (y - meanY);
  }
  return sxx > 0 ? sxy / sxx : Number.NaN;
}

function computeBreadthAdLineSlope(
  breadth: MarketBreadthResult | null | undefined,
  adSlopeWindow: number,
): number {
  if (
    breadth === null ||
    breadth === undefined ||
    breadth.closedBarCount <= 0 ||
    breadth.series.length < 2
  ) {
    return Number.NaN;
  }
  const count = Math.min(adSlopeWindow, breadth.series.length);
  const startIdx = breadth.series.length - count;
  const trailingValues: number[] = [];
  for (let i = startIdx; i < breadth.series.length; i += 1) {
    const pt = breadth.series[i];
    if (pt === undefined || !Number.isFinite(pt.adLine)) {
      return Number.NaN;
    }
    trailingValues.push(pt.adLine);
  }
  return computeFiniteOlsSlope(trailingValues);
}

function assessBreadthMacroPillar(
  breadth: MarketBreadthResult | null | undefined,
  macroVol: MacroVolatilityRegimeResult | null | undefined,
  adLineSlope: number,
  weight: number,
): PillarAssessment {
  if (breadth === null || breadth === undefined || breadth.closedBarCount <= 0) {
    return buildPillar('breadthMacro', weight, Number.NaN, 'NO_DATA');
  }

  const slopeSignal = Number.isFinite(adLineSlope)
    ? signOf(adLineSlope)
    : breadth.series.length === 1 && Number.isFinite(breadth.latestAdNet)
      ? signOf(breadth.latestAdNet)
      : Number.NaN;

  let divSignal = Number.NaN;
  if (breadth.divergenceStatus === 'BULLISH_BREADTH_DIVERGENCE') {
    divSignal = 1;
  } else if (breadth.divergenceStatus === 'BEARISH_BREADTH_DIVERGENCE') {
    divSignal = -1;
  } else if (breadth.divergenceStatus === 'NONE') {
    divSignal = 0;
  }

  let rawBreadthScore = Number.NaN;
  if (Number.isFinite(slopeSignal) && Number.isFinite(divSignal)) {
    rawBreadthScore = 0.5 * slopeSignal + 0.5 * divSignal;
  } else if (Number.isFinite(slopeSignal)) {
    rawBreadthScore = slopeSignal;
  } else if (Number.isFinite(divSignal)) {
    rawBreadthScore = divSignal;
  }

  if (!Number.isFinite(rawBreadthScore)) {
    return buildPillar('breadthMacro', weight, Number.NaN, 'NO_DATA');
  }

  const macroValid =
    macroVol !== null &&
    macroVol !== undefined &&
    macroVol.vixRegime !== 'INSUFFICIENT_DATA' &&
    Number.isFinite(macroVol.positionSizeMultiplier) &&
    macroVol.positionSizeMultiplier > 0;

  if (macroValid) {
    const modulated = clampScore(rawBreadthScore * macroVol.positionSizeMultiplier);
    const summaryCode = macroVol.tailRiskAlert
      ? `${macroVol.vixRegime}_TAIL_ALERT`
      : macroVol.vixRegime;
    return buildPillar('breadthMacro', weight, modulated, summaryCode);
  }

  return buildPillar('breadthMacro', weight, clampScore(rawBreadthScore), 'BREADTH_ONLY_MACRO_NO_DATA');
}

function classifyDirectionalBias(scorePct: number): DirectionalBias {
  if (!Number.isFinite(scorePct)) {
    return 'NO_DATA';
  }
  if (scorePct >= 50) {
    return 'STRONG_BULLISH';
  }
  if (scorePct >= 15) {
    return 'BULLISH';
  }
  if (scorePct > -15) {
    return 'NEUTRAL';
  }
  if (scorePct > -50) {
    return 'BEARISH';
  }
  return 'STRONG_BEARISH';
}

function extractSortedKeyLevels(inputs: TerminalConfluenceInputs): readonly TerminalKeyLevel[] {
  const candidates: TerminalKeyLevel[] = [];
  const pushIfValid = (
    name: KeyLevelName,
    source: KeyLevelSource,
    price: number | undefined,
  ): void => {
    if (price !== undefined && Number.isFinite(price) && price > 0) {
      candidates.push({ name, source, price });
    }
  };

  if (inputs.exposure !== null && inputs.exposure !== undefined) {
    pushIfValid('CallWall', 'OPTIONS', inputs.exposure.callWallStrike);
    pushIfValid('PutWall', 'OPTIONS', inputs.exposure.putWallStrike);
    pushIfValid('GammaFlip', 'OPTIONS', inputs.exposure.gammaFlipSpot);
  }

  if (inputs.openingAuction !== null && inputs.openingAuction !== undefined) {
    pushIfValid('PMH', 'OPENING_AUCTION', inputs.openingAuction.pmh);
    pushIfValid('PML', 'OPENING_AUCTION', inputs.openingAuction.pml);
    pushIfValid('ON_POC', 'OPENING_AUCTION', inputs.openingAuction.onPoc);
    pushIfValid('ON_VAH', 'OPENING_AUCTION', inputs.openingAuction.onVah);
    pushIfValid('ON_VAL', 'OPENING_AUCTION', inputs.openingAuction.onVal);
    pushIfValid('IBH', 'OPENING_AUCTION', inputs.openingAuction.ibh);
    pushIfValid('IBL', 'OPENING_AUCTION', inputs.openingAuction.ibl);
  }

  if (inputs.referenceLevels !== null && inputs.referenceLevels !== undefined) {
    pushIfValid('PDH', 'REFERENCE', inputs.referenceLevels.pdh);
    pushIfValid('PDL', 'REFERENCE', inputs.referenceLevels.pdl);
    pushIfValid('PDC', 'REFERENCE', inputs.referenceLevels.pdc);
  }

  if (inputs.mtf !== null && inputs.mtf !== undefined) {
    pushIfValid('SMA200_1D', 'MTF', inputs.mtf.sma200_1d);
    pushIfValid('SMA50_4H', 'MTF', inputs.mtf.sma50_4h);
    pushIfValid('EMA21_15M', 'MTF', inputs.mtf.ema21_15m);
    pushIfValid('HMA55_5M', 'MTF', inputs.mtf.hma55);
  }

  return candidates.sort((a, b) => {
    if (a.price !== b.price) {
      return a.price - b.price;
    }
    return KEY_LEVEL_ORDER.indexOf(a.name) - KEY_LEVEL_ORDER.indexOf(b.name);
  });
}

function resolveSnapshotAsOfUtcSec(inputs: TerminalConfluenceInputs): number | null {
  if (inputs.options?.asOfUtcSec !== undefined) {
    assertValidUtcSeconds(inputs.options.asOfUtcSec, 'options.asOfUtcSec');
    return inputs.options.asOfUtcSec;
  }

  const timestamps = [
    inputs.mtf?.asOfUtcSec,
    inputs.exposure?.nowUtcSec,
    inputs.openingAuction?.asOfUtcSec,
    inputs.cvdAbsorption?.asOfUtcSec,
    inputs.rsiDivergences?.asOfUtcSec,
    inputs.smtDivergences?.asOfUtcSec,
    inputs.breadth?.asOfUtcSec,
    inputs.macroVol?.asOfUtcSec,
    inputs.realizedVol?.asOfUtcSec,
  ];

  let latest: number | null = null;
  for (const ts of timestamps) {
    if (ts !== undefined && Number.isFinite(ts) && Number.isInteger(ts)) {
      if (latest === null || ts > latest) {
        latest = ts;
      }
    }
  }
  return latest;
}

function resolveHeadlineSpot(inputs: TerminalConfluenceInputs): number {
  const candidates = [
    inputs.exposure?.spot,
    inputs.openingAuction?.currentClose,
    inputs.openingAuction?.referencePrice,
    inputs.mtf?.close5m,
    inputs.mtf?.close15m,
    inputs.mtf?.close1d,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return Number.NaN;
}

/**
 * Orquesta de forma pura e inmutable las salidas de los Bloques A, B y C junto con
 * la volatilidad realizada intradía `RV` / `VRP`, entregando el puntaje de confluencia
 * en `[-100, +100]`, el sesgo direccional, los 6 pilares y los niveles clave ordenados.
 */
export function evaluateTerminalConfluence(
  inputs: TerminalConfluenceInputs,
): TerminalConfluenceSnapshot {
  const weights = resolvePillarWeights(inputs.options?.weights);
  const adSlopeWindow =
    inputs.options?.adSlopeWindow === undefined
      ? DEFAULT_AD_SLOPE_WINDOW
      : assertPositiveInteger(inputs.options.adSlopeWindow, 'options.adSlopeWindow', 2);

  const asOfUtcSec = resolveSnapshotAsOfUtcSec(inputs);
  const gammaRegime = classifyGammaRegime(inputs.exposure);
  const adLineSlope = computeBreadthAdLineSlope(inputs.breadth, adSlopeWindow);

  const p1 = assessMtfPillar(inputs.mtf, weights.mtf);
  const p2 = assessOptionsPillar(
    inputs.exposure,
    inputs.volMetrics,
    gammaRegime,
    weights.optionsPositioning,
  );
  const p3 = assessOpeningAuctionPillar(inputs.openingAuction, weights.openingAuction);
  const p4 = assessCvdPillar(inputs.cvdAbsorption, weights.cvdAbsorption);
  const p5 = assessDivergencesPillar(
    inputs.rsiDivergences,
    inputs.smtDivergences,
    weights.divergences,
  );
  const p6 = assessBreadthMacroPillar(
    inputs.breadth,
    inputs.macroVol,
    adLineSlope,
    weights.breadthMacro,
  );

  const pillars: readonly PillarAssessment[] = [p1, p2, p3, p4, p5, p6];
  const pillarMap: Record<PillarId, PillarAssessment> = {
    mtf: p1,
    optionsPositioning: p2,
    openingAuction: p3,
    cvdAbsorption: p4,
    divergences: p5,
    breadthMacro: p6,
  };

  let activePillarsCount = 0;
  let totalActiveWeight = 0;
  let weightedSum = 0;

  for (const pillar of pillars) {
    if (pillar.status === 'OK') {
      activePillarsCount += 1;
      totalActiveWeight += pillar.weight;
      weightedSum += pillar.weightedContribution;
    }
  }

  let confluenceScore = Number.NaN;
  if (activePillarsCount > 0 && totalActiveWeight > 0) {
    const rawPct = (weightedSum / totalActiveWeight) * 100;
    confluenceScore = Math.max(-100, Math.min(100, rawPct));
  }

  const status = activePillarsCount === 0 ? 'NO_DATA' : 'OK';
  const directionalBias = classifyDirectionalBias(confluenceScore);
  const keyLevels = extractSortedKeyLevels(inputs);

  const iv30d =
    inputs.options?.iv30dOverride !== undefined
      ? inputs.options.iv30dOverride
      : inputs.volMetrics !== null && inputs.volMetrics !== undefined
        ? inputs.volMetrics.ivAtm
        : Number.NaN;

  const realizedVolAnnualized =
    inputs.realizedVol !== null && inputs.realizedVol !== undefined
      ? inputs.realizedVol.realizedVolAnnualized
      : Number.NaN;
  const rvCenteredAnnualized =
    inputs.realizedVol !== null && inputs.realizedVol !== undefined
      ? inputs.realizedVol.rvCenteredAnnualized
      : Number.NaN;
  const vrpSpread = computeVrpSpread(iv30d, realizedVolAnnualized);

  const metrics: TerminalAuxiliaryMetrics = {
    spot: resolveHeadlineSpot(inputs),
    netDollarGex: inputs.exposure?.netGex ?? Number.NaN,
    netDex: inputs.exposure?.netDex ?? Number.NaN,
    gammaFlipSpot: inputs.exposure?.gammaFlipSpot ?? Number.NaN,
    callWallStrike: inputs.exposure?.callWallStrike ?? Number.NaN,
    putWallStrike: inputs.exposure?.putWallStrike ?? Number.NaN,
    expectedMove: inputs.exposure?.expectedMove.formulaMove ?? Number.NaN,
    expectedMovePct: inputs.exposure?.expectedMove.formulaMovePct ?? Number.NaN,
    iv30d,
    riskReversal25: inputs.volMetrics?.riskReversal25 ?? Number.NaN,
    butterfly25: inputs.volMetrics?.butterfly25 ?? Number.NaN,
    realizedVolAnnualized,
    rvCenteredAnnualized,
    vrpSpread,
    vixLevel: inputs.macroVol?.vixLevel ?? Number.NaN,
    vixSlope: inputs.macroVol?.vixSlope ?? Number.NaN,
    cboeSkewLevel: inputs.macroVol?.cboeSkewLevel ?? Number.NaN,
    vixRegime: inputs.macroVol?.vixRegime ?? 'NO_DATA',
    tailRiskAlert:
      inputs.macroVol !== null &&
      inputs.macroVol !== undefined &&
      inputs.macroVol.vixRegime !== 'INSUFFICIENT_DATA'
        ? inputs.macroVol.tailRiskAlert
        : null,
    positionSizeMultiplier: inputs.macroVol?.positionSizeMultiplier ?? Number.NaN,
    adLineSlope,
    latestAdLine: inputs.breadth?.latestAdLine ?? Number.NaN,
    currentSessionCvd: inputs.cvdAbsorption?.currentSessionCvd ?? Number.NaN,
    latestRsi: inputs.rsiDivergences?.latestRsi ?? Number.NaN,
  };

  return {
    status,
    asOfUtcSec,
    activePillarsCount,
    totalPillarsCount: PILLAR_IDS.length,
    totalActiveWeight,
    confluenceScore,
    directionalBias,
    gammaRegime,
    pillars,
    pillarMap,
    keyLevels,
    metrics,
  };
}
