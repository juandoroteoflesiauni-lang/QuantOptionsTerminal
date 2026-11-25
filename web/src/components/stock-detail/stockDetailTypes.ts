/**
 * Tipos compartidos de UI para la vista Stock Detail unificada (`/acciones/:ticker`).
 */

import type {
  FreshOrderBlockRecordDto,
  OrderBook5LevelsDto,
  PrimaryDlrContractDto,
  QuantitativeFvgRecordDto,
  RelativeStrengthAndCatalystsDto,
  SpatialConfluenceDto,
  TerminalTimeframe,
} from '../../data/liveTypes';
import type { AvwapAnchorMode, MinimalOhlcvBar } from './stockDetailMath';

export type HighlightLevelId =
  | 'POC'
  | 'VAH'
  | 'VAL'
  | 'CALL_WALL'
  | 'PUT_WALL'
  | 'ZERO_GAMMA'
  | 'ATR14'
  | null;

export type LowerPaneMode = 'CVD' | 'RS' | 'VOLATILITY';

export interface OverlayVisibilityState {
  readonly emas: boolean;
  readonly sessionVwap: boolean;
  readonly avwap: boolean;
  readonly volumeProfile: boolean;
  readonly nakedPocs: boolean;
  readonly fvgFob: boolean;
  readonly optionWalls: boolean;
}

export interface ChartKeyLevels {
  readonly poc: number | null;
  readonly vah: number | null;
  readonly val: number | null;
  /** Pieza 50.4: ventana efectiva del Volume Profile (`windowBars` o `closedBarCount`), o `null`. */
  readonly volumeProfileWindowBars?: number | null;
  readonly callWall: number | null;
  readonly putWall: number | null;
  readonly zeroGamma: number | null;
  readonly atr14: number | null;
  readonly nakedPocs: readonly { readonly sessionDate: string; readonly price: number }[];
  readonly fvgs: readonly QuantitativeFvgRecordDto[];
  readonly orderBlocks: readonly FreshOrderBlockRecordDto[];
}

export interface GexStrikeProfileItem {
  readonly strike: number;
  readonly callOi: number | null;
  readonly putOi: number | null;
  readonly callGex: number | null;
  readonly putGex: number | null;
  readonly netGex: number | null;
}

export interface ExpectedMoveOverlayInfo {
  readonly expiryCode: string | null;
  readonly daysToExpiry: number | null;
  readonly ivAtmDecimal: number | null;
  readonly oneSigmaAbs: number | null;
  readonly oneSigmaPct: number | null;
  readonly upper1Sigma: number | null;
  readonly lower1Sigma: number | null;
}

export interface ChartCoordinateMapper {
  readonly containerHeight: number;
  readonly plotHeight: number;
  readonly priceToY: (price: number) => number | null;
  readonly yToPrice: (y: number) => number | null;
  readonly timeToX: (timeSec: number) => number | null;
}

export interface StockContextBannerInfo {
  readonly market: 'AR' | 'US';
  readonly ticker: string;
  readonly name: string;
  readonly marketLabel: string;
  readonly currencySymbol: 'ARS' | 'USD';
  readonly spot: number | null;
  readonly prevClose: number | null;
  readonly changePct: number | null;
  readonly dayLow: number | null;
  readonly dayHigh: number | null;
  readonly volumeCompact: string;
  readonly volRelative: number | null;
  readonly feedStatus: string;
  readonly intradayProvenanceNote: string | null;
  // Bloque contextual AR con ADR
  readonly arHasAdr: boolean;
  readonly adrUsTicker: string | null;
  readonly adrUsdPrice: number | null;
  readonly adrRatio: number | null;
  readonly impliedCcl: number | null;
  readonly theoreticalArsPrice: number | null;
  readonly arbitrageGapPct: number | null;
  // Bloque contextual Bono/Local AR sin ADR
  readonly arAssetType: 'STOCK' | 'CEDEAR' | 'BOND' | 'US_STOCK';
  readonly bondTirPct: number | null;
  readonly bondParityPct: number | null;
  readonly marketCclMedian: number | null;
  // Bloque contextual US
  readonly nbboBid: number | null;
  readonly nbboAsk: number | null;
  readonly nbboBidSize: number | null;
  readonly nbboAskSize: number | null;
  readonly nbboSpreadPct: number | null;
  readonly cedearTicker: string | null;
  readonly cedearRatio: number | null;
  readonly cedearArsPrice: number | null;
  readonly cedearCclMismatchPct: number | null;
}

export interface StockChartSeriesBundle {
  readonly monthStartCanonicalAvwap?: import('../../../../src/core/avwapCanonicalMonth.js').CanonicalMonthDto | null;
  readonly bars: readonly MinimalOhlcvBar[];
  readonly ema9: readonly (number | null)[];
  readonly ema21: readonly (number | null)[];
  readonly ema50: readonly (number | null)[];
  readonly ema200: readonly (number | null)[];
  readonly sessionVwap: readonly (number | null)[];
  readonly avwapMode: AvwapAnchorMode;
  readonly avwapSeries: readonly (number | null)[];
  readonly avwapAnchorAvailable: boolean;
  readonly benchmarkBars1d: readonly MinimalOhlcvBar[];
  readonly ivAtmPct: number | null;
  readonly rv30Pct: number | null;
  readonly vrpPct: number | null;
  readonly barsAvailable: boolean;
  readonly intradayUnavailableReason: string | null;
  readonly lastClosedEma?: {
    readonly 9: number | null;
    readonly 21: number | null;
    readonly 50: number | null;
    readonly 200: number | null;
  };
}

export interface StockExecutionDeckData {
  readonly market: 'AR' | 'US';
  readonly ticker: string;
  readonly spot: number | null;
  readonly atr14: number | null;
  readonly orderBook24h: OrderBook5LevelsDto | null;
  readonly orderBookCi: OrderBook5LevelsDto | null;
  readonly rofexFrontContract: PrimaryDlrContractDto | null;
  readonly confluenceClusters: SpatialConfluenceDto | null;
  readonly relativeStrength: RelativeStrengthAndCatalystsDto | null;
  readonly mtfSummary: {
    readonly regime: string;
    readonly setupStatus: string;
    readonly close5m: number | null;
    readonly ema21_15m: number | null;
    readonly sma50_4h: number | null;
    readonly sma200_1d: number | null;
  } | null;
  readonly nextExpiry: {
    readonly expiryCode: string;
    readonly expirationDate: string;
    readonly daysToExpiry: number | null;
  } | null;
  readonly marketCclMedian: number | null;
  readonly currencySymbol: 'ARS' | 'USD';
}

export type StockTimeframeState = TerminalTimeframe;
