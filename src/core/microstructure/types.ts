/**
 * Tipos puros para microestructura de apertura, perfil de volumen overnight,
 * taxonomía de subasta e Initial Balance (`04:00 – 10:30 ET`, Pieza 9).
 *
 * Convenciones estrictas (AGENTS.md / SPEC.md):
 *  - Todos los timestamps (`time`, `asOfUtcSec`) están expresados en **segundos UTC enteros**.
 *  - Los valores numéricos no calculables se representan explícitamente con `Number.NaN`
 *    (prohibidos los respaldos numéricos silenciosos).
 */

import type { Bar } from '../types.js';

/** Barra estándar del proyecto con delta de flujo opcional si fue provisto en origen. */
export interface MicrostructureBar extends Bar {
  /** Delta neto de volumen (`buyVolume - sellVolume`) opcional; si falta se estima vía CLV. */
  readonly delta?: number;
}

export type BalanceType = 'IN_BALANCE' | 'OUT_OF_BALANCE' | 'INSUFFICIENT_DATA';

export type InventoryRiskType =
  | 'LONG_LIQUIDATION_RISK'
  | 'SHORT_COVERING_RISK'
  | 'NEUTRAL';

export type OpeningType =
  | 'PENDING_OPEN'
  | 'OPEN_DRIVE'
  | 'OPEN_TEST_DRIVE'
  | 'OPEN_REJECTION_REVERSE'
  | 'OPEN_AUCTION';

export type OpeningDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export type InitialBalanceClassification =
  | 'PENDING_IB'
  | 'NARROW_IB_EXPANSION_ALERT'
  | 'NORMAL_IB'
  | 'WIDE_IB_CONSOLIDATION_BIAS'
  | 'INSUFFICIENT_DATA';

export interface OvernightVolumeBin {
  /** Precio discreto centro del bin (`k * tickSize`). */
  readonly price: number;
  readonly volume: number;
}

export interface OvernightVolumeProfileOptions {
  /** Tamaño discreto del bin de precio (`> 0`, ej. `0.01` o `0.05`). */
  readonly tickSize: number;
  /** Fracción objetivo de volumen para Value Area en `(0, 1]` (por defecto `0.70`). */
  readonly valueAreaPct?: number;
}

export interface OvernightVolumeProfileResult {
  readonly pmh: number;
  readonly pml: number;
  readonly onPoc: number;
  readonly onVah: number;
  readonly onVal: number;
  readonly preMarketVwap: number;
  readonly totalVolume: number;
  readonly valueAreaVolume: number;
  readonly valueAreaCoverage: number;
  readonly bins: readonly OvernightVolumeBin[];
}

export interface Macro0830SpikeOptions {
  /** Múltiplo mínimo de rango vs mediana previa a 08:30 ET (por defecto `3.0`). */
  readonly rangeMultiplier?: number;
  /** Múltiplo mínimo de volumen vs mediana previa a 08:30 ET (por defecto `5.0`). */
  readonly volumeMultiplier?: number;
}

export interface Macro0830SpikeResult {
  readonly detected: boolean;
  readonly high: number;
  readonly low: number;
  readonly medianPreMarketRange: number;
  readonly medianPreMarketVolume: number;
}

export interface OpeningAuctionOptions {
  /** Instante de evaluación sin look-ahead en segundos UTC enteros (`barClose <= asOfUtcSec`). */
  readonly asOfUtcSec: number;
  /** Duración de cada barra en segundos enteros que dividen `1800` (`60, 120, 180, 300, 600, 900, 1800`). */
  readonly barSeconds: number;
  /** Fecha de sesión ET explícita (`YYYY-MM-DD`); por defecto se toma la fecha ET de `asOfUtcSec`. */
  readonly sessionDate?: string;
  /** Cierre RTH de la sesión anterior (`C_{t-1}`). */
  readonly prevRthClose?: number;
  /** Máximo RTH de la sesión anterior (`H_{t-1}`). */
  readonly prevRthHigh?: number;
  /** Mínimo RTH de la sesión anterior (`L_{t-1}`). */
  readonly prevRthLow?: number;
  /** ATR diario de 14 periodos (`> 0`). */
  readonly atr14d?: number;
  /** Volumen histórico esperado de RTH para `[09:30 ET, asOfUtcSec]` (`> 0`). */
  readonly expectedWindowVolume?: number;
  /** Tamaño de bin para perfil overnight (por defecto `0.05`). */
  readonly tickSize?: number;
  /** Porcentaje de área de valor overnight en `(0, 1]` (por defecto `0.70`). */
  readonly valueAreaPct?: number;
  /** Múltiplo de rango para nodo macro `08:30 ET` (por defecto `3.0`). */
  readonly macroRangeMultiplier?: number;
  /** Múltiplo de volumen para nodo macro `08:30 ET` (por defecto `5.0`). */
  readonly macroVolumeMultiplier?: number;
  /** Umbral de inventario desequilibrado sobre `prevRthClose` (por defecto `0.85`). */
  readonly inventoryImbalanceThreshold?: number;
  /** Tolerancia de retroceso contra `open0930` en múltiplos de ATR para `OPEN_DRIVE` (por defecto `0.05`). */
  readonly openCrossToleranceAtr?: number;
  /** RVOL mínimo exigido para `OPEN_DRIVE` (por defecto `2.5`). */
  readonly openDriveMinRvol?: number;
  /** Proximidad máxima a frontera clave para `OPEN_TEST_DRIVE` en múltiplos de ATR (por defecto `0.25`). */
  readonly boundaryProximityAtr?: number;
  /** Ventana inicial desde `09:30 ET` en minutos para detectar sweep de `OPEN_TEST_DRIVE` (por defecto `15`). */
  readonly testDriveSweepWindowMinutes?: number;
  /** Tolerancia de toque a `pmh`/`pml` para `OPEN_REJECTION_REVERSE` en múltiplos de ATR (por defecto `0.08`). */
  readonly rejectionTouchAtr?: number;
  /** Cruces mínimos sobre `open0930` característicos de `OPEN_AUCTION` (por defecto `2`). */
  readonly openAuctionMinCrosses?: number;
}

export interface OpeningAuctionResult {
  readonly sessionDate: string;
  readonly asOfUtcSec: number;
  readonly preMarketBarCount: number;
  readonly rthBarCount: number;
  readonly excludedFutureBarCount: number;

  // Los 4 niveles pre-9:30 ET + referencias
  readonly pmh: number;
  readonly pml: number;
  readonly onPoc: number;
  readonly onVah: number;
  readonly onVal: number;
  readonly preMarketVwap: number;
  readonly overnightVolumeProfile: OvernightVolumeProfileResult;
  readonly referencePrice: number;
  readonly open0930: number;
  readonly currentClose: number;
  readonly sessionVwap: number;
  readonly trueGap: number;
  readonly trueGapAtr: number;

  // Nodo macro-noticias 08:30 ET
  readonly macro0830Detected: boolean;
  readonly macro0830High: number;
  readonly macro0830Low: number;
  readonly medianPreMarketRange: number;
  readonly medianPreMarketVolume: number;

  // Posicionamiento e inventario overnight
  readonly balanceType: BalanceType;
  readonly rthCumVolume: number;
  readonly openingRvol: number;
  readonly lowImmediateReversalProb: boolean;
  readonly pctVolumeAbovePrevClose: number;
  readonly pctVolumeBelowPrevClose: number;
  readonly cumulativeRthDelta: number;
  readonly inventoryRisk: InventoryRiskType;
  readonly statisticalTargets: readonly number[];

  // Taxonomía de apertura (09:30 - 10:30 ET)
  readonly openingType: OpeningType;
  readonly openingDirection: OpeningDirection;
  readonly openCrossCount: number;
  readonly vwapCrossCount: number;

  // Initial Balance (09:30 - 10:30 ET)
  readonly ibh: number;
  readonly ibl: number;
  readonly ibWidth: number;
  readonly ibWidthAtr: number;
  readonly ibClassification: InitialBalanceClassification;
}
