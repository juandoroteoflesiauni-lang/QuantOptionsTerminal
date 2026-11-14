/**
 * Cargador e integrador cuantitativo para el Mercado Argentino en Tiempo Real / Diferido
 * y Macro Local (`src/server/argentinaMarketLoader.ts`).
 *
 * Fuentes públicas gratuitas (sin credenciales):
 *  - Data912 (`https://data912.com`):
 *      /live/mep, /live/ccl, /live/usa_adrs, /live/usa_stocks,
 *      /live/arg_stocks, /live/arg_options, /live/arg_cedears,
 *      /live/arg_notes, /live/arg_corp, /live/arg_bonds,
 *      /historical/stocks/{ticker}, /historical/cedears/{ticker}, /historical/bonds/{ticker}
 *    Con limitador de ritmo configurable (<= 120 req/min por defecto).
 *  - Open BYMA (`https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free/`):
 *      leading-equity, general-equity, cedears, public-bonds, index-summary (POST JSON),
 *      con tolerancia a timeouts/respuestas vacías fuera de rueda y degradación explícita.
 *  - BCRA API v4.0 (`https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias`) +
 *    ArgentinaDatos (`https://api.argentinadatos.com/v1/`):
 *      A3500, BADLAR, TAMAR, TPM, CER, UVA, Reservas, Base Monetaria, Inflación mensual e
 *      interanual, Dólares de mercado y Riesgo País (EMBI+).
 *
 * Motores cuantitativos:
 *  - Opciones BYMA americanas con **Bjerksund-Stensland (2002)** (`src/core/options/american.ts`),
 *    lote de 100 acciones, liquidación prima `T+0`, corte operativo `15:30 ART` al vencimiento,
 *    superficie PCHIP/SVI (`src/core/options/volSurface.ts`, `volMetrics.ts`), exposición
 *    dealer GEX/DEX/Walls/Gamma Flip (`src/core/options/exposure.ts`), densidad $\mathbb{Q}$ vs
 *    $\mathbb{P}$ deflactada y evaluador "Las 3 maneras de jugarla" neto de derechos BYMA + 21% IVA.
 *  - Bonos soberanos argentinos (flujos reales de prospecto Decreto 676/2020) con XIRR (TIR),
 *    Duration Modificada y Paridad Técnica calculadas numéricamente sin valores inventados.
 *
 * Política Zero Silent Fallbacks:
 *  - Cualquier métrica no calculable se serializa como `null` (jamás se inventan precios ni tasas).
 *  - Si una fuente falla o entrega datos incompletos, se reporta el `feedStatus` real
 *    (`LIVE`, `DIFERIDO_20M`, `PARTIAL`, `NO_DATA`) y `providerErrors`.
 */

import { calculateEma } from '../core/ema.js';
import {
  computeSmaSeries,
  evaluateMtfStructure,
} from '../core/microstructure/mtfStructure.js';
import { computeWilderRsiSeries } from '../core/microstructure/divergences.js';
import {
  greeksAmericanFiniteDiffOrAnalytical,
  priceAmericanBjerksund2002,
  solveImpliedVolAmerican,
} from '../core/options/american.js';
import {
  computeDealerExposure,
  type ExposureContractInput,
} from '../core/options/exposure.js';
import { computeSliceVolMetrics } from '../core/options/volMetrics.js';
import { buildVolSlice, type VolQuoteInput } from '../core/options/volSurface.js';
import type { Bar } from '../core/types.js';
import type { FetchResponse } from '../data/types.js';
import { redactSecrets, SingleFlightRuntimeCache } from './runtimeCache.js';

export type FeedStatus = 'LIVE' | 'DIFERIDO_20M' | 'PARTIAL' | 'NO_DATA';

export interface ArHttpRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export type ArHttpFn = (url: string, init?: ArHttpRequestInit) => Promise<FetchResponse>;

export interface ArgentinaRuntimeDeps {
  readonly fetchFn?: ArHttpFn;
  readonly nowMsFn?: () => number;
  readonly cacheTtlMs?: number;
  readonly minData912IntervalMs?: number;
  readonly timeoutMs?: number;
  readonly secrets?: readonly string[];
  readonly data912BaseUrl?: string;
  readonly openBymaBaseUrl?: string;
  readonly bcraBaseUrl?: string;
  readonly argentinaDatosBaseUrl?: string;
}

export interface GlobalIndicatorDto {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly decimals: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly deltaPct: number | null;
  readonly help: string;
  readonly source: string;
}

export interface ArStockDto {
  readonly ticker: string;
  readonly name: string;
  readonly sector: 'Bancos' | 'Energía' | 'Reguladas' | 'Materiales' | 'Telecom' | 'Agro' | 'CEDEAR';
  readonly panel: 'Líder' | 'General' | 'CEDEAR';
  readonly color: string;
  readonly last: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly deltaPct: number | null;
  readonly prevClose: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly vwap: number | null;
  readonly volumeM: number | null;
  readonly volMultiple: number | null;
  readonly signalText: string;
  readonly adrTicker?: string;
  readonly adrRatio?: number;
  readonly adrPrice?: number | null;
  readonly adrDeltaPct?: number | null;
  readonly cclImplicit?: number | null;
  readonly cclZScore?: number | null;
  readonly iv30d?: number | null;
  readonly ivRank?: 'barata' | 'rango' | 'cara';
  readonly ivPercentile?: number | null;
  readonly sparkline: readonly number[];
  readonly source: string;
}

export interface MepCclArbitrageRow {
  readonly symbol: string;
  readonly category: 'BONO' | 'ADR' | 'CEDEAR';
  readonly ratio: number;
  readonly localArs: number | null;
  readonly usdPrice: number | null;
  readonly impliedRate: number | null;
  readonly medianRate: number | null;
  readonly spreadBps: number | null;
  readonly zScore: number | null;
  readonly side: 'MEP' | 'CCL';
}

export interface ArBondDto {
  readonly ticker: string;
  readonly name: string;
  readonly legislation: 'ARG' | 'NY' | 'PROVINCIAL' | 'CORPORATE' | 'TESORO';
  readonly maturity: string;
  readonly currency: 'USD' | 'ARS' | 'CER';
  readonly priceUsd: number | null;
  readonly priceArs: number | null;
  readonly deltaPct: number | null;
  readonly tirPct: number | null;
  readonly parityPct: number | null;
  readonly duration: number | null;
  readonly accruedInterest: number | null;
  readonly volumeM: number | null;
  readonly cclImplicit?: number | null;
  readonly mepImplicit?: number | null;
  readonly source: string;
}

export interface ArNoteOrCorpDto {
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'LECAP_BONCAP' | 'ON_CORP';
  readonly price: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly deltaPct: number | null;
  readonly volumeM: number | null;
  readonly source: string;
}

export interface ArMacroCardDto {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly numericValue: number | null;
  readonly delta: string;
  readonly deltaPct: number | null;
  readonly help: string;
  readonly source: string;
  readonly updatedAt: string | null;
}

export interface ArOverviewResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly data912Status: 'OK' | 'ERROR';
  readonly openBymaStatus: 'OK' | 'DEGRADED';
  readonly marketState: 'ABIERTO' | 'SUBASTA' | 'CERRADO' | 'PREMARKET';
  readonly marketStateLabel: string;
  readonly providerErrors: readonly string[];
  readonly globalIndicators: readonly GlobalIndicatorDto[];
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly mepCclGapPct: number | null;
  readonly mervalStocks: readonly ArStockDto[];
  readonly generalPanelStocks: readonly ArStockDto[];
  readonly cedears: readonly ArStockDto[];
  readonly mepCclMatrix: readonly MepCclArbitrageRow[];
}

export interface ArMacroResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly providerErrors: readonly string[];
  readonly cards: readonly ArMacroCardDto[];
  readonly variables: {
    readonly a3500: number | null;
    readonly badlarTna: number | null;
    readonly tamarTna: number | null;
    readonly tpmTna: number | null;
    readonly cer: number | null;
    readonly uva: number | null;
    readonly reservasUsdM: number | null;
    readonly baseMonetariaArsM: number | null;
    readonly inflacionMensualPct: number | null;
    readonly inflacionInteranualPct: number | null;
    readonly riesgoPaisPb: number | null;
    readonly mep: number | null;
    readonly ccl: number | null;
    readonly blue: number | null;
    readonly oficial: number | null;
  };
  readonly dolares: readonly {
    readonly casa: string;
    readonly nombre: string;
    readonly compra: number | null;
    readonly venta: number | null;
    readonly fechaActualizacion: string | null;
  }[];
  readonly sovereignCurve: readonly ArBondDto[];
}

export interface ArMonitoringResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly panel: 'acciones' | 'bonos' | 'cedears' | 'cauciones';
  readonly providerErrors: readonly string[];
  readonly stocks: readonly ArStockDto[];
  readonly generalPanel: readonly ArStockDto[];
  readonly bonds: readonly ArBondDto[];
  readonly cedears: readonly ArStockDto[];
  readonly notes: readonly ArNoteOrCorpDto[];
  readonly corps: readonly ArNoteOrCorpDto[];
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly badlarTna: number | null;
}

export interface ArHistoricalBarDto {
  readonly time: number;
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly closeDeflatedUsd: number | null;
  readonly volume: number;
  readonly dailyReturnPct: number | null;
}

export interface ArStockDetailResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly symbol: string;
  readonly assetType: 'STOCK' | 'CEDEAR' | 'BOND';
  readonly stock: ArStockDto | null;
  readonly bond: ArBondDto | null;
  readonly historicalBars: readonly ArHistoricalBarDto[];
  readonly realizedVol20d: number | null;
  readonly realizedVol60d: number | null;
  readonly realizedVolUsd20d: number | null;
  readonly rsi14: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly ema21: number | null;
  readonly mtfRegime: string;
  readonly relatedOptionsCount: number;
  readonly providerErrors: readonly string[];
}

export interface ArOptionContractDto {
  readonly symbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryCode: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly mark: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  readonly thetaDaily: number | null;
  readonly vegaPer1Pct: number | null;
  readonly rho: number | null;
  readonly vanna: number | null;
  readonly charm: number | null;
  readonly intrinsic: number;
  readonly extrinsic: number | null;
  readonly source: 'DATA912' | 'MODEL';
}

export interface ArOptionExpiryDto {
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly days: number;
  readonly ivAtm: number | null;
  readonly riskReversal25: number | null;
  readonly butterfly25: number | null;
  readonly butterflyArbitrageFree: boolean;
  readonly strikes: readonly number[];
  readonly calls: readonly ArOptionContractDto[];
  readonly puts: readonly ArOptionContractDto[];
}

export interface ArOptionStrategyCardDto {
  readonly id: string;
  readonly rankReason: 'POP' | 'EV' | 'CONVEXITY';
  readonly family: string;
  readonly name: string;
  readonly desc: string;
  readonly legs: readonly {
    readonly side: 1 | -1;
    readonly type: 'C' | 'P';
    readonly strike: number;
    readonly ratio: number;
    readonly symbol: string;
    readonly premium: number;
    readonly iv: number | null;
    readonly delta: number | null;
  }[];
  readonly cashNetArs: number;
  readonly feesAndVatArs: number;
  readonly maxGainArs: number | null;
  readonly maxLossArs: number | null;
  readonly popQ: number;
  readonly popP: number;
  readonly expectedValueArs: number;
  readonly rewardRiskRatio: number | null;
}

export interface ArOptionsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly underlying: string;
  readonly spot: number | null;
  readonly rateTna: number | null;
  readonly continuousRate: number | null;
  readonly dividendYield: number;
  readonly lotSize: number;
  readonly settlement: 'T+0';
  readonly exerciseCutoffArt: '15:30 ART';
  readonly realizedVol20d: number | null;
  readonly realizedVol60d: number | null;
  readonly histMedianIv: number | null;
  readonly vrpSpread: number | null;
  readonly historicalCloses: readonly number[];
  readonly termStructure: readonly {
    readonly days: number;
    readonly label: string;
    readonly expiryCode: string;
    readonly atm: number;
  }[];
  readonly expiries: readonly ArOptionExpiryDto[];
  readonly exposureSummary: {
    readonly netGex: number | null;
    readonly netDex: number | null;
    readonly callWallStrike: number | null;
    readonly putWallStrike: number | null;
    readonly gammaFlipSpot: number | null;
    readonly gammaFlipStatus: string;
    readonly expectedMoveAbs: number | null;
    readonly expectedMovePct: number | null;
  } | null;
  readonly costSchedule: {
    readonly rvMarketFeeRate: number;
    readonly optionsFeeRate: number;
    readonly shortLoanFeeRate: number;
    readonly vatRate: number;
    readonly bondsVatExempt: true;
  };
  readonly providerErrors: readonly string[];
}

export interface ArRelationPairDto {
  readonly id: string;
  readonly name: string;
  readonly legA: string;
  readonly legB: string;
  readonly unit: string;
  readonly currentValue: number | null;
  readonly mean60d: number | null;
  readonly std60d: number | null;
  readonly zScore: number | null;
  readonly percentile60d: number | null;
  readonly signal: string;
  readonly history: readonly { readonly time: number; readonly ratio: number; readonly zScore: number }[];
}

export interface ArRelationsResponse {
  readonly asOfUtcSec: number;
  readonly feedStatus: FeedStatus;
  readonly providerErrors: readonly string[];
  readonly pairs: readonly ArRelationPairDto[];
  readonly mepCclArbitrage: readonly MepCclArbitrageRow[];
}

const DEFAULT_DATA912_BASE = 'https://data912.com';
const DEFAULT_OPEN_BYMA_BASE = 'https://open.bymadata.com.ar/vanoms-be-core/rest/api/bymadata/free';
const DEFAULT_BCRA_BASE = 'https://api.bcra.gob.ar';
const DEFAULT_ARGDATOS_BASE = 'https://api.argentinadatos.com';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 18_000;
const DEFAULT_HIST_CACHE_TTL_MS = 180_000;
const DEFAULT_MACRO_CACHE_TTL_MS = 300_000;
// Data912 tope público: 120 req/min (~500 ms). Margen conservador en vivo: 550 ms en cola compartida o 0 en tests.
const DEFAULT_MIN_DATA912_INTERVAL_MS = 120;

const BYMA_RV_FEE = 0.0005; // 3 bps negociación + 2 bps post-trade
const BYMA_OPTION_FEE = 0.0020; // 20 bps referencia opciones
const BYMA_SHORT_LOAN_FEE = 0.0002; // 2 bps préstamo de títulos
const BYMA_VAT_RATE = 0.21; // 21% IVA sobre derechos/comisiones (exento en Títulos Públicos/ONs)
const OPTION_LOT_SIZE = 100;

interface StockMetadata {
  readonly ticker: string;
  readonly name: string;
  readonly sector: ArStockDto['sector'];
  readonly panel: 'Líder' | 'General';
  readonly color: string;
  readonly adrTicker?: string;
  readonly adrRatio?: number;
  readonly dividendYield?: number;
}

const AR_STOCK_META: readonly StockMetadata[] = [
  { ticker: 'GGAL', name: 'Grupo Financiero Galicia', sector: 'Bancos', panel: 'Líder', color: '#8B7CF6', adrTicker: 'GGAL', adrRatio: 10, dividendYield: 0.012 },
  { ticker: 'YPFD', name: 'YPF S.A.', sector: 'Energía', panel: 'Líder', color: '#4BA3FF', adrTicker: 'YPF', adrRatio: 1, dividendYield: 0 },
  { ticker: 'PAMP', name: 'Pampa Energía', sector: 'Energía', panel: 'Líder', color: '#2EDC7E', adrTicker: 'PAM', adrRatio: 25, dividendYield: 0 },
  { ticker: 'BMA', name: 'Banco Macro', sector: 'Bancos', panel: 'Líder', color: '#F5B544', adrTicker: 'BMA', adrRatio: 10, dividendYield: 0.015 },
  { ticker: 'SUPV', name: 'Grupo Supervielle', sector: 'Bancos', panel: 'Líder', color: '#E5558F', adrTicker: 'SUPV', adrRatio: 5, dividendYield: 0 },
  { ticker: 'BBAR', name: 'BBVA Argentina', sector: 'Bancos', panel: 'Líder', color: '#4BA3FF', adrTicker: 'BBAR', adrRatio: 3, dividendYield: 0.01 },
  { ticker: 'CEPU', name: 'Central Puerto', sector: 'Energía', panel: 'Líder', color: '#2EDC7E', adrTicker: 'CEPU', adrRatio: 10, dividendYield: 0 },
  { ticker: 'TGSU2', name: 'Transportadora de Gas del Sur', sector: 'Reguladas', panel: 'Líder', color: '#5B8CFF', adrTicker: 'TGS', adrRatio: 5, dividendYield: 0 },
  { ticker: 'EDN', name: 'Edenor', sector: 'Reguladas', panel: 'Líder', color: '#34D3C7', adrTicker: 'EDN', adrRatio: 20, dividendYield: 0 },
  { ticker: 'TXAR', name: 'Ternium Argentina', sector: 'Materiales', panel: 'Líder', color: '#E5558F', dividendYield: 0.01 },
  { ticker: 'ALUA', name: 'Aluar Aluminio Argentino', sector: 'Materiales', panel: 'Líder', color: '#FF8A4C', dividendYield: 0.01 },
  { ticker: 'COME', name: 'Sociedad Comercial del Plata', sector: 'Energía', panel: 'Líder', color: '#8B7CF6', dividendYield: 0 },
  { ticker: 'TECO2', name: 'Telecom Argentina', sector: 'Telecom', panel: 'Líder', color: '#4BA3FF', adrTicker: 'TEO', adrRatio: 5, dividendYield: 0 },
  { ticker: 'LOMA', name: 'Loma Negra', sector: 'Materiales', panel: 'Líder', color: '#2EDC7E', adrTicker: 'LOMA', adrRatio: 5, dividendYield: 0 },
  { ticker: 'CRES', name: 'Cresud', sector: 'Agro', panel: 'Líder', color: '#FF8A4C', adrTicker: 'CRESY', adrRatio: 10, dividendYield: 0 },
  { ticker: 'BYMA', name: 'Bolsas y Mercados Argentinos', sector: 'Bancos', panel: 'Líder', color: '#8B7CF6', dividendYield: 0.01 },
  { ticker: 'TRAN', name: 'Transener', sector: 'Reguladas', panel: 'Líder', color: '#F5B544', dividendYield: 0 },
  { ticker: 'VALO', name: 'Banco de Valores', sector: 'Bancos', panel: 'General', color: '#8B5CF6', dividendYield: 0 },
  { ticker: 'IRSA', name: 'IRSA Inversiones y Representaciones', sector: 'Agro', panel: 'General', color: '#6366F1', adrTicker: 'IRS', adrRatio: 10, dividendYield: 0 },
  { ticker: 'TGNO4', name: 'Transportadora de Gas del Norte', sector: 'Reguladas', panel: 'General', color: '#0EA5E9', dividendYield: 0 },
  { ticker: 'METR', name: 'Metrogas S.A.', sector: 'Reguladas', panel: 'General', color: '#3B82F6', dividendYield: 0 },
  { ticker: 'MIRG', name: 'Mirgor S.A.', sector: 'Materiales', panel: 'General', color: '#EC4899', dividendYield: 0 },
  { ticker: 'BHIP', name: 'Banco Hipotecario', sector: 'Bancos', panel: 'General', color: '#F59E0B', dividendYield: 0 },
  { ticker: 'CECO2', name: 'Central Costanera', sector: 'Energía', panel: 'General', color: '#10B981', dividendYield: 0 },
  { ticker: 'CVH', name: 'Cablevisión Holding', sector: 'Telecom', panel: 'General', color: '#06B6D4', dividendYield: 0 },
  { ticker: 'AUSO', name: 'Autopistas del Sol', sector: 'Reguladas', panel: 'General', color: '#F97316', dividendYield: 0 },
  { ticker: 'HARG', name: 'Holcim Argentina', sector: 'Materiales', panel: 'General', color: '#14B8A6', dividendYield: 0 },
  { ticker: 'AGRO', name: 'Agrometal S.A.', sector: 'Agro', panel: 'General', color: '#84CC16', dividendYield: 0 },
  { ticker: 'MORI', name: 'Morixe Hermanos', sector: 'Agro', panel: 'General', color: '#EAB308', dividendYield: 0 },
];

const STOCK_META_MAP = new Map<string, StockMetadata>(
  AR_STOCK_META.map((m) => [m.ticker, m]),
);

const CEDEAR_RATIOS: Readonly<Record<string, { readonly usTicker: string; readonly ratio: number; readonly name: string }>> = {
  SPY: { usTicker: 'SPY', ratio: 20, name: 'SPDR S&P 500 ETF Trust' },
  QQQ: { usTicker: 'QQQ', ratio: 20, name: 'Invesco QQQ Trust' },
  AAPL: { usTicker: 'AAPL', ratio: 20, name: 'Apple Inc.' },
  AMZN: { usTicker: 'AMZN', ratio: 144, name: 'Amazon.com Inc.' },
  NVDA: { usTicker: 'NVDA', ratio: 24, name: 'NVIDIA Corporation' },
  MELI: { usTicker: 'MELI', ratio: 120, name: 'MercadoLibre Inc.' },
  KO: { usTicker: 'KO', ratio: 5, name: 'Coca-Cola Co.' },
  TSLA: { usTicker: 'TSLA', ratio: 15, name: 'Tesla Inc.' },
  MSFT: { usTicker: 'MSFT', ratio: 30, name: 'Microsoft Corporation' },
  GOOGL: { usTicker: 'GOOGL', ratio: 58, name: 'Alphabet Inc.' },
  META: { usTicker: 'META', ratio: 24, name: 'Meta Platforms Inc.' },
  BRKB: { usTicker: 'BRK.B', ratio: 22, name: 'Berkshire Hathaway' },
  VISTA: { usTicker: 'VIST', ratio: 3, name: 'Vista Energy SAB' },
  VIST: { usTicker: 'VIST', ratio: 3, name: 'Vista Energy SAB' },
  XOM: { usTicker: 'XOM', ratio: 10, name: 'Exxon Mobil Corp.' },
  JPM: { usTicker: 'JPM', ratio: 15, name: 'JPMorgan Chase & Co.' },
  AMD: { usTicker: 'AMD', ratio: 10, name: 'Advanced Micro Devices' },
  NFLX: { usTicker: 'NFLX', ratio: 48, name: 'Netflix Inc.' },
  GLOB: { usTicker: 'GLOB', ratio: 18, name: 'Globant S.A.' },
  BABA: { usTicker: 'BABA', ratio: 9, name: 'Alibaba Group' },
  WMT: { usTicker: 'WMT', ratio: 18, name: 'Walmart Inc.' },
  DIS: { usTicker: 'DIS', ratio: 12, name: 'Walt Disney Co.' },
  EWZ: { usTicker: 'EWZ', ratio: 2, name: 'iShares MSCI Brazil ETF' },
  IWM: { usTicker: 'IWM', ratio: 10, name: 'iShares Russell 2000 ETF' },
  DIA: { usTicker: 'DIA', ratio: 20, name: 'SPDR Dow Jones Industrial' },
};

const OPTION_PREFIX_TO_UNDERLYING: Readonly<Record<string, string>> = {
  GFG: 'GGAL',
  GGAL: 'GGAL',
  YPF: 'YPFD',
  YPFD: 'YPFD',
  PAM: 'PAMP',
  PAMP: 'PAMP',
  BMA: 'BMA',
  COM: 'COME',
  COME: 'COME',
  TXA: 'TXAR',
  TXAR: 'TXAR',
  ALU: 'ALUA',
  ALUA: 'ALUA',
  CEP: 'CEPU',
  CEPU: 'CEPU',
  EDN: 'EDN',
  TGS: 'TGSU2',
  TGSU: 'TGSU2',
  SUP: 'SUPV',
  SUPV: 'SUPV',
  BBA: 'BBAR',
  BBAR: 'BBAR',
  BYM: 'BYMA',
  BYMA: 'BYMA',
  MIR: 'MIRG',
  MIRG: 'MIRG',
  CRE: 'CRES',
  CRES: 'CRES',
  LOM: 'LOMA',
  LOMA: 'LOMA',
  MET: 'METR',
  METR: 'METR',
  TGN: 'TGNO4',
  TGNO: 'TGNO4',
  VAL: 'VALO',
  VALO: 'VALO',
  MOR: 'MORI',
  MORI: 'MORI',
};

const MONTH_CODES: Readonly<Record<string, { readonly month: number; readonly label: string; readonly code: string }>> = {
  EN: { month: 1, label: 'Ene', code: 'EN' },
  E: { month: 1, label: 'Ene', code: 'EN' },
  FE: { month: 2, label: 'Feb', code: 'FE' },
  F: { month: 2, label: 'Feb', code: 'FE' },
  MA: { month: 3, label: 'Mar', code: 'MA' },
  MR: { month: 3, label: 'Mar', code: 'MA' },
  M: { month: 3, label: 'Mar', code: 'MA' },
  AB: { month: 4, label: 'Abr', code: 'AB' },
  A: { month: 4, label: 'Abr', code: 'AB' },
  MY: { month: 5, label: 'May', code: 'MY' },
  Y: { month: 5, label: 'May', code: 'MY' },
  JU: { month: 6, label: 'Jun', code: 'JU' },
  JN: { month: 6, label: 'Jun', code: 'JU' },
  J: { month: 6, label: 'Jun', code: 'JU' },
  JL: { month: 7, label: 'Jul', code: 'JL' },
  L: { month: 7, label: 'Jul', code: 'JL' },
  AG: { month: 8, label: 'Ago', code: 'AG' },
  G: { month: 8, label: 'Ago', code: 'AG' },
  SE: { month: 9, label: 'Sep', code: 'SE' },
  S: { month: 9, label: 'Sep', code: 'SE' },
  OC: { month: 10, label: 'Oct', code: 'OC' },
  O: { month: 10, label: 'Oct', code: 'OC' },
  NO: { month: 11, label: 'Nov', code: 'NO' },
  N: { month: 11, label: 'Nov', code: 'NO' },
  DI: { month: 12, label: 'Dic', code: 'DI' },
  D: { month: 12, label: 'Dic', code: 'DI' },
};

const MONTHS_ES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

interface BondFlow {
  readonly dateUtcSec: number;
  readonly coupon: number;
  readonly amortization: number;
}

interface SovereignBondSpec {
  readonly baseTicker: string;
  readonly name: string;
  readonly legislation: 'ARG' | 'NY';
  readonly maturity: string;
  readonly flows: readonly BondFlow[];
}

function isoUtcSec(dateStr: string): number {
  return Math.floor(Date.parse(`${dateStr}T12:00:00Z`) / 1_000);
}

function generateSemiannualFlows(params: {
  readonly startDate: string;
  readonly endDate: string;
  readonly couponRateAt: (dateStr: string) => number;
  readonly amortAt: (dateStr: string) => number;
}): readonly BondFlow[] {
  const start = new Date(`${params.startDate}T12:00:00Z`);
  const end = new Date(`${params.endDate}T12:00:00Z`);
  const out: BondFlow[] = [];
  let residualPrincipal = 100;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const d = start.getUTCDate();

  while (Date.UTC(y, m - 1, d, 12, 0, 0) <= end.getTime() + 1_000) {
    const mm = String(m).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${String(y)}-${mm}-${dd}`;
    const annualRate = params.couponRateAt(dateStr);
    const coupon = residualPrincipal * (annualRate / 2);
    const amort = Math.min(residualPrincipal, params.amortAt(dateStr));
    out.push({
      dateUtcSec: isoUtcSec(dateStr),
      coupon,
      amortization: amort,
    });
    residualPrincipal = Math.max(0, residualPrincipal - amort);
    m += 6;
    if (m > 12) {
      m -= 12;
      y += 1;
    }
  }
  return out;
}

const SOVEREIGN_BONDS: readonly SovereignBondSpec[] = [
  {
    baseTicker: 'AL29',
    name: 'Bonar 2029 USD Ley Argentina',
    legislation: 'ARG',
    maturity: '2029-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2029-07-09',
      couponRateAt: () => 0.01,
      amortAt: () => 10,
    }),
  },
  {
    baseTicker: 'GD29',
    name: 'Global 2029 USD Ley NY',
    legislation: 'NY',
    maturity: '2029-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2029-07-09',
      couponRateAt: () => 0.01,
      amortAt: () => 10,
    }),
  },
  {
    baseTicker: 'AL30',
    name: 'Bonar 2030 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2030-07-09',
    flows: generateSemiannualFlows({
      startDate: '2024-07-09',
      endDate: '2030-07-09',
      couponRateAt: (d) => (d >= '2028-01-01' ? 0.0175 : 0.0075),
      amortAt: (d) => (d === '2024-07-09' ? 4 : 8),
    }),
  },
  {
    baseTicker: 'GD30',
    name: 'Global 2030 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2030-07-09',
    flows: generateSemiannualFlows({
      startDate: '2024-07-09',
      endDate: '2030-07-09',
      couponRateAt: (d) => (d >= '2028-01-01' ? 0.0175 : 0.0075),
      amortAt: (d) => (d === '2024-07-09' ? 4 : 8),
    }),
  },
  {
    baseTicker: 'AL35',
    name: 'Bonar 2035 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2035-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2035-07-09',
      couponRateAt: (d) => (d >= '2029-01-01' ? 0.05 : d >= '2028-01-01' ? 0.0475 : 0.04125),
      amortAt: (d) => (d >= '2031-01-09' ? 10 : 0),
    }),
  },
  {
    baseTicker: 'GD35',
    name: 'Global 2035 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2035-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2035-07-09',
      couponRateAt: (d) => (d >= '2029-01-01' ? 0.05 : d >= '2028-01-01' ? 0.0475 : 0.04125),
      amortAt: (d) => (d >= '2031-01-09' ? 10 : 0),
    }),
  },
  {
    baseTicker: 'AE38',
    name: 'Bonar 2038 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2038-01-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2038-01-09',
      couponRateAt: () => 0.05,
      amortAt: (d) => (d >= '2027-07-09' ? 100 / 22 : 0),
    }),
  },
  {
    baseTicker: 'GD38',
    name: 'Global 2038 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2038-01-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2038-01-09',
      couponRateAt: () => 0.05,
      amortAt: (d) => (d >= '2027-07-09' ? 100 / 22 : 0),
    }),
  },
  {
    baseTicker: 'AL41',
    name: 'Bonar 2041 Step-Up Ley Argentina',
    legislation: 'ARG',
    maturity: '2041-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2041-07-09',
      couponRateAt: (d) => (d >= '2030-01-01' ? 0.04875 : 0.035),
      amortAt: (d) => (d >= '2028-01-09' ? 100 / 28 : 0),
    }),
  },
  {
    baseTicker: 'GD41',
    name: 'Global 2041 Step-Up Ley NY',
    legislation: 'NY',
    maturity: '2041-07-09',
    flows: generateSemiannualFlows({
      startDate: '2025-01-09',
      endDate: '2041-07-09',
      couponRateAt: (d) => (d >= '2030-01-01' ? 0.04875 : 0.035),
      amortAt: (d) => (d >= '2028-01-09' ? 100 / 28 : 0),
    }),
  },
];

function sanitizeFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNum(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.replace(',', '.'));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readStr(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

function parseTimestampSec(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e11 ? Math.floor(raw / 1_000) : Math.floor(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const s = raw.trim();
    const num = Number(s);
    if (Number.isFinite(num) && num > 0) {
      return num > 1e11 ? Math.floor(num / 1_000) : Math.floor(num);
    }
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T20:00:00Z` : s;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.floor(ms / 1_000);
    }
  }
  return null;
}

function defaultArHttpFn(url: string, init?: ArHttpRequestInit): Promise<FetchResponse> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers ?? { Accept: 'application/json' },
    ...(init?.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
      headers,
    };
  });
}

function computeMedian(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) {
    return clean[mid] ?? null;
  }
  const a = clean[mid - 1];
  const b = clean[mid];
  return a !== undefined && b !== undefined ? 0.5 * (a + b) : null;
}

function computeMeanAndStd(values: readonly number[]): { readonly mean: number; readonly std: number } | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return null;
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  const mean = sum / clean.length;
  const varSum = clean.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  const std = Math.sqrt(varSum / (clean.length - 1));
  return { mean, std };
}

function computeDailyRealizedVol(bars: readonly Bar[], windowDays: number): number | null {
  if (bars.length < windowDays + 1) {
    return null;
  }
  const recent = bars.slice(-(windowDays + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const curr = recent[i];
    if (prev !== undefined && curr !== undefined && prev.close > 0 && curr.close > 0) {
      returns.push(Math.log(curr.close / prev.close));
    }
  }
  const stats = computeMeanAndStd(returns);
  if (stats === null || !Number.isFinite(stats.std) || stats.std <= 0) {
    return null;
  }
  return stats.std * Math.sqrt(252);
}

/**
 * Calcula valor técnico residual, TIR (XIRR anualizada ACT/365) y Duration Modificada
 * de un bono soberano argentino sobre sus flujos reales de prospecto.
 */
export function evaluateSovereignBondMath(
  spec: SovereignBondSpec,
  marketPriceUsd: number,
  asOfUtcSec: number,
): {
  readonly tirPct: number | null;
  readonly parityPct: number | null;
  readonly duration: number | null;
  readonly accruedInterest: number | null;
} {
  if (!Number.isFinite(marketPriceUsd) || marketPriceUsd <= 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const futureFlows = spec.flows.filter((f) => f.dateUtcSec > asOfUtcSec);
  const prevFlow = [...spec.flows].reverse().find((f) => f.dateUtcSec <= asOfUtcSec);
  if (futureFlows.length === 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const residualPrincipal = futureFlows.reduce((acc, f) => acc + f.amortization, 0);
  if (residualPrincipal <= 0) {
    return { tirPct: null, parityPct: null, duration: null, accruedInterest: null };
  }

  const nextFlow = futureFlows[0];
  let accruedInterest = 0;
  if (nextFlow !== undefined) {
    const prevSec = prevFlow?.dateUtcSec ?? nextFlow.dateUtcSec - 182.5 * 86_400;
    const periodSec = Math.max(86_400, nextFlow.dateUtcSec - prevSec);
    const elapsedSec = Math.max(0, asOfUtcSec - prevSec);
    accruedInterest = nextFlow.coupon * Math.min(1, elapsedSec / periodSec);
  }
  const technicalValue = residualPrincipal + accruedInterest;
  const parityPct = technicalValue > 0 ? (marketPriceUsd / technicalValue) * 100 : null;

  const yearFrac = (tSec: number): number => Math.max(1 / 365, (tSec - asOfUtcSec) / (365 * 86_400));

  const npvMinusPrice = (y: number): number => {
    let pv = 0;
    for (const f of futureFlows) {
      const t = yearFrac(f.dateUtcSec);
      const cf = f.coupon + f.amortization;
      pv += cf / Math.pow(1 + y, t);
    }
    return pv - marketPriceUsd;
  };

  let lo = -0.5;
  let hi = 2.5;
  let fLo = npvMinusPrice(lo);
  let fHi = npvMinusPrice(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    return {
      tirPct: null,
      parityPct: sanitizeFinite(parityPct),
      duration: null,
      accruedInterest: sanitizeFinite(accruedInterest),
    };
  }

  for (let i = 0; i < 80; i += 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = npvMinusPrice(mid);
    if (!Number.isFinite(fMid)) {
      break;
    }
    if (Math.abs(fMid) < 1e-8 || hi - lo < 1e-8) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  const yieldIrr = 0.5 * (lo + hi);

  let macWeighted = 0;
  let totalPv = 0;
  for (const f of futureFlows) {
    const t = yearFrac(f.dateUtcSec);
    const pv = (f.coupon + f.amortization) / Math.pow(1 + yieldIrr, t);
    macWeighted += t * pv;
    totalPv += pv;
  }
  const macDuration = totalPv > 0 ? macWeighted / totalPv : Number.NaN;
  const modDuration = Number.isFinite(macDuration) ? macDuration / (1 + yieldIrr) : Number.NaN;

  return {
    tirPct: sanitizeFinite(yieldIrr * 100),
    parityPct: sanitizeFinite(parityPct),
    duration: sanitizeFinite(modDuration),
    accruedInterest: sanitizeFinite(accruedInterest),
  };
}

function thirdFridayUtcSec(year: number, month1Based: number): number {
  const firstDay = new Date(Date.UTC(year, month1Based - 1, 1, 18, 30, 0));
  const firstDow = firstDay.getUTCDay(); // 5 = Friday
  const daysToFirstFriday = (5 - firstDow + 7) % 7;
  const thirdFridayDay = 1 + daysToFirstFriday + 14;
  return Math.floor(Date.UTC(year, month1Based - 1, thirdFridayDay, 18, 30, 0) / 1_000);
}

interface ParsedBymaOptionSymbol {
  readonly symbol: string;
  readonly underlying: string;
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryCode: string;
  readonly expiryLabel: string;
  readonly expirationDate: string;
  readonly expiryUtcSec: number;
  readonly daysToExpiry: number;
}

/**
 * Parsea símbolos de opciones BYMA / Data912 (ej. `GFGC6000DI`, `GFGV5800OC`, `GFGC62974D`, `YPFC42000AB`).
 */
export function parseBymaOptionSymbol(
  rawSymbol: string,
  spotHint: number | null,
  asOfUtcSec: number,
): ParsedBymaOptionSymbol | null {
  const cleaned = rawSymbol.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (cleaned.length < 6) {
    return null;
  }

  // Ejemplos: GFGC6000DI, YPFV42000OC, PAMP3600D, GFGC62974D, GFGC6400.0DI
  const match = /^([A-Z]{3,5})([CV])(\d+(?:\.\d+)?)([A-Z]{1,3})$/.exec(cleaned);
  if (match === null) {
    return null;
  }

  const rawPrefix = match[1] ?? '';
  const optChar = match[2] ?? '';
  const rawStrikeStr = match[3] ?? '';
  const rawMonthSuffix = match[4] ?? '';

  const underlying =
    OPTION_PREFIX_TO_UNDERLYING[rawPrefix] ??
    (STOCK_META_MAP.has(rawPrefix) ? rawPrefix : null);
  if (underlying === null) {
    return null;
  }

  const contractType: 'call' | 'put' = optChar === 'C' ? 'call' : 'put';
  let strike = Number(rawStrikeStr);
  if (!Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  // En BYMA algunos strikes ajustados por dividendos omiten el punto decimal (ej. 62974 -> 6297.4)
  if (!rawStrikeStr.includes('.') && spotHint !== null && spotHint > 0 && strike > spotHint * 3.5) {
    if (strike / 10 >= spotHint * 0.25 && strike / 10 <= spotHint * 2.5) {
      strike = strike / 10;
    } else if (strike / 100 >= spotHint * 0.25 && strike / 100 <= spotHint * 2.5) {
      strike = strike / 100;
    }
  }

  const monthKey = rawMonthSuffix.slice(0, 2);
  const monthInfo = MONTH_CODES[monthKey] ?? MONTH_CODES[rawMonthSuffix.slice(0, 1)];
  if (monthInfo === undefined) {
    return null;
  }

  const asOfDate = new Date(asOfUtcSec * 1_000);
  const baseYear = asOfDate.getUTCFullYear();
  let expSec = thirdFridayUtcSec(baseYear, monthInfo.month);
  if (expSec <= asOfUtcSec - 86_400) {
    expSec = thirdFridayUtcSec(baseYear + 1, monthInfo.month);
  }
  if (expSec <= asOfUtcSec + 60) {
    return null;
  }

  const expDate = new Date(expSec * 1_000);
  const dd = String(expDate.getUTCDate()).padStart(2, '0');
  const mm = String(expDate.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(expDate.getUTCFullYear());
  const monShort = MONTHS_ES_SHORT[expDate.getUTCMonth()] ?? monthInfo.label.toLowerCase();

  return {
    symbol: cleaned,
    underlying,
    contractType,
    strike: Math.round(strike * 100) / 100,
    expiryCode: monthInfo.code,
    expiryLabel: `${String(Number(dd))} ${monShort}`,
    expirationDate: `${yyyy}-${mm}-${dd}`,
    expiryUtcSec: expSec,
    daysToExpiry: Math.max(1, Math.round((expSec - asOfUtcSec) / 86_400)),
  };
}

function getArgentinaMarketState(nowUtcSec: number): {
  readonly state: ArOverviewResponse['marketState'];
  readonly label: string;
} {
  // ART = UTC-3 (sin DST desde 2009)
  const artMs = (nowUtcSec - 3 * 3_600) * 1_000;
  const artDate = new Date(artMs);
  const dow = artDate.getUTCDay();
  const minutes = artDate.getUTCHours() * 60 + artDate.getUTCMinutes();
  const isWeekday = dow >= 1 && dow <= 5;
  if (!isWeekday) {
    return { state: 'CERRADO', label: 'Fin de semana · Último cierre BYMA' };
  }
  if (minutes >= 10 * 60 + 30 && minutes < 11 * 60) {
    return { state: 'SUBASTA', label: 'Subasta de apertura BYMA (10:30–11:00 ART)' };
  }
  if (minutes >= 11 * 60 && minutes < 17 * 60) {
    return { state: 'ABIERTO', label: 'Rueda BYMA abierta (11:00–17:00 ART)' };
  }
  if (minutes >= 9 * 60 + 30 && minutes < 10 * 60 + 30) {
    return { state: 'PREMARKET', label: 'Pre-apertura BYMA / Rueda Cauciones' };
  }
  return { state: 'CERRADO', label: 'Post-cierre BYMA · Datos consolidados' };
}

interface NormalizedQuoteRow {
  readonly symbol: string;
  readonly last: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly prevClose: number | null;
  readonly deltaPct: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly vwap: number | null;
  readonly volumeArs: number | null;
  readonly nominalVol: number | null;
  readonly mark: number | null;
  readonly impliedUsdArs: number | null;
  readonly arsBid: number | null;
  readonly arsAsk: number | null;
  readonly usdBid: number | null;
  readonly usdAsk: number | null;
}

function normalizeData912Rows(raw: unknown): readonly NormalizedQuoteRow[] {
  let arr: readonly unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (isPlainRecord(raw)) {
    for (const key of ['data', 'results', 'items', 'quotes']) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) {
        arr = candidate;
        break;
      }
    }
  }

  const rows: NormalizedQuoteRow[] = [];
  for (const item of arr) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const sym = readStr(item, ['symbol', 'ticker', 'Symbol', 'especie']);
    if (sym === null) {
      continue;
    }
    const cleanSym = sym.toUpperCase();
    const last = readNum(item, ['c', 'close', 'last', 'px_last', 'mark', 'trade', 'settlementPrice']);
    const bid = readNum(item, ['px_bid', 'bid', 'bidPrice', 'ars_bid']);
    const ask = readNum(item, ['px_ask', 'ask', 'askPrice', 'ars_ask']);
    const prevClose = readNum(item, ['prev_close', 'previousClose', 'closingPrice', 'open', 'o']);
    const deltaPct = readNum(item, ['pct_change', 'imbalance', 'variation', 'changePct', 'var']);
    const low = readNum(item, ['l', 'low', 'min', 'lowPrice']);
    const high = readNum(item, ['h', 'high', 'max', 'highPrice']);
    const vwap = readNum(item, ['vw', 'vwap']);
    const volumeArs = readNum(item, ['v_ars', 'volumeAmount', 'monto', 'amount']);
    const nominalVol = readNum(item, ['v', 'q_op', 'volume', 'nominalVolume']);
    const mark = readNum(item, ['mark', 'c', 'close', 'last']);
    const arsBid = readNum(item, ['ars_bid']);
    const arsAsk = readNum(item, ['ars_ask']);
    const usdBid = readNum(item, ['usd_bid']);
    const usdAsk = readNum(item, ['usd_ask']);

    let computedDeltaPct = deltaPct;
    if (computedDeltaPct === null && last !== null && prevClose !== null && prevClose > 0) {
      computedDeltaPct = ((last - prevClose) / prevClose) * 100;
    }

    rows.push({
      symbol: cleanSym,
      last,
      bid,
      ask,
      prevClose,
      deltaPct: sanitizeFinite(computedDeltaPct),
      low,
      high,
      vwap,
      volumeArs,
      nominalVol,
      mark,
      impliedUsdArs: mark,
      arsBid,
      arsAsk,
      usdBid,
      usdAsk,
    });
  }
  return rows;
}

function normalizeHistoricalBars(raw: unknown): readonly Bar[] {
  let arr: readonly unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (isPlainRecord(raw)) {
    for (const key of ['data', 'results', 'bars', 'history']) {
      const candidate = raw[key];
      if (Array.isArray(candidate)) {
        arr = candidate;
        break;
      }
    }
  }

  const out: Bar[] = [];
  const seenTime = new Set<number>();
  for (const item of arr) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const time = parseTimestampSec(item['date'] ?? item['t'] ?? item['time'] ?? item['timestamp']);
    const close = readNum(item, ['c', 'close', 'last', 'closingPrice']);
    const open = readNum(item, ['o', 'open', 'openingPrice']) ?? close;
    const high = readNum(item, ['h', 'high', 'maxPrice']) ?? (open !== null && close !== null ? Math.max(open, close) : null);
    const low = readNum(item, ['l', 'low', 'minPrice']) ?? (open !== null && close !== null ? Math.min(open, close) : null);
    const volume = readNum(item, ['v', 'volume', 'nominalVolume']) ?? 0;

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      seenTime.has(time)
    ) {
      continue;
    }
    seenTime.add(time);
    out.push({
      time,
      open,
      high,
      low,
      close,
      volume: Math.max(0, volume),
    });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

export class ArgentinaMarketRuntime {
  private readonly fetchFn: ArHttpFn;
  private readonly nowMsFn: () => number;
  private readonly timeoutMs: number;
  private readonly minData912IntervalMs: number;
  private readonly secrets: readonly string[];
  private readonly data912BaseUrl: string;
  private readonly openBymaBaseUrl: string;
  private readonly bcraBaseUrl: string;
  private readonly argDatosBaseUrl: string;

  private readonly liveCache: SingleFlightRuntimeCache<unknown>;
  private readonly histCache: SingleFlightRuntimeCache<readonly Bar[]>;
  private readonly macroCache: SingleFlightRuntimeCache<unknown>;
  private readonly computedCache: SingleFlightRuntimeCache<unknown>;

  private data912Queue: Promise<void> = Promise.resolve();
  private lastData912ReqMs = 0;

  public constructor(deps: ArgentinaRuntimeDeps = {}) {
    this.fetchFn = deps.fetchFn ?? defaultArHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minData912IntervalMs = deps.minData912IntervalMs ?? DEFAULT_MIN_DATA912_INTERVAL_MS;
    this.secrets = deps.secrets ?? [];
    this.data912BaseUrl = (deps.data912BaseUrl ?? DEFAULT_DATA912_BASE).replace(/\/+$/, '');
    this.openBymaBaseUrl = (deps.openBymaBaseUrl ?? DEFAULT_OPEN_BYMA_BASE).replace(/\/+$/, '');
    this.bcraBaseUrl = (deps.bcraBaseUrl ?? DEFAULT_BCRA_BASE).replace(/\/+$/, '');
    this.argDatosBaseUrl = (deps.argentinaDatosBaseUrl ?? DEFAULT_ARGDATOS_BASE).replace(/\/+$/, '');

    const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.liveCache = new SingleFlightRuntimeCache({ ttlResolver: () => ttlMs, nowFn: this.nowMsFn });
    this.histCache = new SingleFlightRuntimeCache({ ttlResolver: () => DEFAULT_HIST_CACHE_TTL_MS, nowFn: this.nowMsFn });
    this.macroCache = new SingleFlightRuntimeCache({ ttlResolver: () => DEFAULT_MACRO_CACHE_TTL_MS, nowFn: this.nowMsFn });
    this.computedCache = new SingleFlightRuntimeCache({ ttlResolver: () => ttlMs, nowFn: this.nowMsFn });
  }

  private async scheduleData912<T>(task: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.minData912IntervalMs > 0) {
        const now = this.nowMsFn();
        const waitMs = this.lastData912ReqMs + this.minData912IntervalMs - now;
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
        }
      }
      this.lastData912ReqMs = this.nowMsFn();
      return task();
    };
    const next = this.data912Queue.then(run, run);
    this.data912Queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async fetchJsonSafe(
    url: string,
    init?: ArHttpRequestInit,
    useData912Limiter = false,
  ): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }> {
    const exec = async () => {
      const res = await this.fetchFn(url, {
        ...(init ?? {}),
        timeoutMs: init?.timeoutMs ?? this.timeoutMs,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${String(res.status)} on ${url}`);
      }
      if (res.text.trim() === '') {
        throw new Error(`Empty response on ${url}`);
      }
      return JSON.parse(res.text) as unknown;
    };

    try {
      const data = useData912Limiter ? await this.scheduleData912(exec) : await exec();
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upstream fetch error';
      return { ok: false, error: redactSecrets(msg, this.secrets) };
    }
  }

  private async getData912Live(
    endpoint: string,
    forceRefresh = false,
  ): Promise<{ readonly rows: readonly NormalizedQuoteRow[]; readonly error: string | null }> {
    const url = `${this.data912BaseUrl}${endpoint}`;
    try {
      const cached = await this.liveCache.getOrCompute(
        `d912:${endpoint}`,
        async () => {
          const res = await this.fetchJsonSafe(url, { headers: { Accept: 'application/json' } }, true);
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeData912Rows(res.data);
        },
        { forceRefresh },
      );
      return { rows: cached.value as readonly NormalizedQuoteRow[], error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Data912 ${endpoint} failed`;
      return { rows: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  private async getData912History(
    kind: 'stocks' | 'cedears' | 'bonds',
    ticker: string,
    forceRefresh = false,
  ): Promise<{ readonly bars: readonly Bar[]; readonly error: string | null }> {
    const cleanTicker = encodeURIComponent(ticker.trim().toUpperCase());
    const url = `${this.data912BaseUrl}/historical/${kind}/${cleanTicker}`;
    try {
      const cached = await this.histCache.getOrCompute(
        `d912hist:${kind}:${cleanTicker}`,
        async () => {
          const res = await this.fetchJsonSafe(url, { headers: { Accept: 'application/json' } }, true);
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeHistoricalBars(res.data);
        },
        { forceRefresh },
      );
      return { bars: cached.value, error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `History ${kind}/${cleanTicker} failed`;
      return { bars: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  private async getOpenBymaPanel(
    endpoint: string,
    forceRefresh = false,
  ): Promise<{ readonly rows: readonly NormalizedQuoteRow[]; readonly error: string | null }> {
    const url = `${this.openBymaBaseUrl}/${endpoint}`;
    try {
      const cached = await this.liveCache.getOrCompute(
        `byma:${endpoint}`,
        async () => {
          const body = JSON.stringify({
            excludeZeroPxAndQty: true,
            T2: false,
            T1: true,
            T0: false,
          });
          const res = await this.fetchJsonSafe(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
          });
          if (!res.ok) {
            throw new Error(res.error);
          }
          return normalizeData912Rows(res.data);
        },
        { forceRefresh },
      );
      return { rows: cached.value as readonly NormalizedQuoteRow[], error: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `OpenBYMA ${endpoint} unavailable`;
      return { rows: [], error: redactSecrets(msg, this.secrets) };
    }
  }

  private async fetchBcraAndArgDatos(forceRefresh = false): Promise<{
    readonly variables: ArMacroResponse['variables'];
    readonly dolares: ArMacroResponse['dolares'];
    readonly errors: readonly string[];
    readonly updatedAt: string | null;
  }> {
    const cached = await this.macroCache.getOrCompute(
      'macro:bcra_argdatos',
      async () => {
        const errors: string[] = [];
        const [bcraRes, dolaresRes, infMRes, infYRes, riesgoRes] = await Promise.all([
          this.fetchJsonSafe(`${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/cotizaciones/dolares`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/inflacion`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/inflacionInteranual`),
          this.fetchJsonSafe(`${this.argDatosBaseUrl}/v1/finanzas/indices/riesgo-pais`),
        ]);

        let a3500: number | null = null;
        let badlarTna: number | null = null;
        let tamarTna: number | null = null;
        let tpmTna: number | null = null;
        let cer: number | null = null;
        let uva: number | null = null;
        let reservasUsdM: number | null = null;
        let baseMonetariaArsM: number | null = null;
        let updatedAt: string | null = null;

        if (!bcraRes.ok) {
          errors.push(`BCRA v4.0: ${bcraRes.error}`);
        } else if (isPlainRecord(bcraRes.data) && Array.isArray(bcraRes.data['results'])) {
          for (const item of bcraRes.data['results']) {
            if (!isPlainRecord(item)) {
              continue;
            }
            const idVar = readNum(item, ['idVariable', 'id']);
            const desc = (readStr(item, ['descripcion', 'nombre']) ?? '').toLowerCase();
            const val = readNum(item, ['valor', 'value']);
            const fecha = readStr(item, ['fecha', 'date']);
            if (fecha !== null && (updatedAt === null || fecha > updatedAt)) {
              updatedAt = fecha;
            }
            if (val === null) {
              continue;
            }
            if (idVar === 5 || desc.includes('mayorista') || desc.includes('3500')) {
              a3500 = a3500 ?? val;
            } else if (idVar === 7 || desc.includes('badlar')) {
              badlarTna = badlarTna ?? val;
            } else if (idVar === 44 || desc.includes('tamar')) {
              tamarTna = tamarTna ?? val;
            } else if (idVar === 6 || desc.includes('política monetaria') || desc.includes('politica monetaria')) {
              tpmTna = tpmTna ?? val;
            } else if (idVar === 30 || desc === 'cer' || desc.includes('coeficiente de estabilización')) {
              cer = cer ?? val;
            } else if (idVar === 31 || desc.includes('uva')) {
              uva = uva ?? val;
            } else if (idVar === 1 || desc.includes('reservas internacionales')) {
              reservasUsdM = reservasUsdM ?? val;
            } else if (idVar === 15 || desc.includes('base monetaria')) {
              baseMonetariaArsM = baseMonetariaArsM ?? val;
            }
          }
        }

        const dolares: ArMacroResponse['dolares'][number][] = [];
        let mepArgDatos: number | null = null;
        let cclArgDatos: number | null = null;
        let blue: number | null = null;
        let oficial: number | null = null;

        if (!dolaresRes.ok) {
          errors.push(`ArgentinaDatos dolares: ${dolaresRes.error}`);
        } else if (Array.isArray(dolaresRes.data)) {
          for (const d of dolaresRes.data) {
            if (!isPlainRecord(d)) {
              continue;
            }
            const casa = (readStr(d, ['casa']) ?? '').toLowerCase();
            const nombre = readStr(d, ['nombre']) ?? casa.toUpperCase();
            const compra = readNum(d, ['compra']);
            const venta = readNum(d, ['venta']);
            const fecha = readStr(d, ['fechaActualizacion']);
            dolares.push({ casa, nombre, compra, venta, fechaActualizacion: fecha });
            if (casa === 'bolsa') mepArgDatos = venta ?? compra;
            if (casa === 'contadoconliqui') cclArgDatos = venta ?? compra;
            if (casa === 'blue') blue = venta ?? compra;
            if (casa === 'oficial') oficial = venta ?? compra;
          }
        }

        const extractLatestIndex = (res: typeof infMRes, label: string): number | null => {
          if (!res.ok) {
            errors.push(`ArgentinaDatos ${label}: ${res.error}`);
            return null;
          }
          if (!Array.isArray(res.data) || res.data.length === 0) {
            return null;
          }
          const arr = res.data as readonly unknown[];
          const lastItem = arr[arr.length - 1];
          return isPlainRecord(lastItem) ? readNum(lastItem, ['valor', 'value']) : null;
        };

        const inflacionMensualPct = extractLatestIndex(infMRes, 'inflacion');
        const inflacionInteranualPct = extractLatestIndex(infYRes, 'inflacionInteranual');
        const riesgoPaisPb = extractLatestIndex(riesgoRes, 'riesgo-pais');

        return {
          variables: {
            a3500,
            badlarTna,
            tamarTna,
            tpmTna,
            cer,
            uva,
            reservasUsdM,
            baseMonetariaArsM,
            inflacionMensualPct,
            inflacionInteranualPct,
            riesgoPaisPb,
            mep: mepArgDatos,
            ccl: cclArgDatos,
            blue,
            oficial,
          },
          dolares,
          errors,
          updatedAt,
        };
      },
      { forceRefresh },
    );

    return cached.value as {
      readonly variables: ArMacroResponse['variables'];
      readonly dolares: ArMacroResponse['dolares'];
      readonly errors: readonly string[];
      readonly updatedAt: string | null;
    };
  }

  private computeMepCclMatrix(params: {
    readonly mepRows: readonly NormalizedQuoteRow[];
    readonly cclRows: readonly NormalizedQuoteRow[];
    readonly argStocks: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
    readonly argCedears: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly argBonds: readonly NormalizedQuoteRow[];
    readonly fallbackMep: number | null;
    readonly fallbackCcl: number | null;
  }): {
    readonly mepMedian: number | null;
    readonly cclMedian: number | null;
    readonly rows: readonly MepCclArbitrageRow[];
  } {
    const stockMap = new Map(params.argStocks.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));
    const cedearMap = new Map(params.argCedears.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));
    const bondMap = new Map(params.argBonds.map((r) => [r.symbol, r]));

    const rawRows: {
      symbol: string;
      category: MepCclArbitrageRow['category'];
      ratio: number;
      localArs: number | null;
      usdPrice: number | null;
      impliedRate: number | null;
      side: 'MEP' | 'CCL';
    }[] = [];

    // 1. Directo /live/mep y /live/ccl de Data912
    for (const r of params.mepRows) {
      const rate = r.mark ?? r.last;
      if (rate !== null && rate > 0) {
        rawRows.push({
          symbol: r.symbol,
          category: 'BONO',
          ratio: 1,
          localArs: null,
          usdPrice: null,
          impliedRate: rate,
          side: 'MEP',
        });
      }
    }
    for (const r of params.cclRows) {
      const rate = r.mark ?? r.last;
      if (rate !== null && rate > 0) {
        rawRows.push({
          symbol: r.symbol,
          category: 'BONO',
          ratio: 1,
          localArs: null,
          usdPrice: null,
          impliedRate: rate,
          side: 'CCL',
        });
      }
    }

    // 2. Bonos soberanos directos si no vinieron en /live/mep o /live/ccl
    for (const base of ['AL30', 'GD30', 'AL35', 'GD35']) {
      const ars = bondMap.get(base)?.last ?? null;
      const usdD = bondMap.get(`${base}D`)?.last ?? null;
      const usdC = bondMap.get(`${base}C`)?.last ?? null;
      if (ars !== null && ars > 0 && usdD !== null && usdD > 0) {
        rawRows.push({
          symbol: `${base} (D)`,
          category: 'BONO',
          ratio: 1,
          localArs: ars,
          usdPrice: usdD,
          impliedRate: ars / usdD,
          side: 'MEP',
        });
      }
      if (ars !== null && ars > 0 && usdC !== null && usdC > 0) {
        rawRows.push({
          symbol: `${base} (C)`,
          category: 'BONO',
          ratio: 1,
          localArs: ars,
          usdPrice: usdC,
          impliedRate: ars / usdC,
          side: 'CCL',
        });
      }
    }

    // 3. ADRs con ratio oficial
    for (const meta of AR_STOCK_META) {
      if (meta.adrTicker === undefined || meta.adrRatio === undefined) {
        continue;
      }
      const localPx = stockMap.get(meta.ticker)?.last ?? null;
      const adrPx = adrMap.get(meta.adrTicker)?.last ?? usaMap.get(meta.adrTicker)?.last ?? null;
      if (localPx !== null && localPx > 0 && adrPx !== null && adrPx > 0) {
        rawRows.push({
          symbol: `${meta.ticker}/${meta.adrTicker}`,
          category: 'ADR',
          ratio: meta.adrRatio,
          localArs: localPx,
          usdPrice: adrPx,
          impliedRate: (localPx * meta.adrRatio) / adrPx,
          side: 'CCL',
        });
      }
    }

    // 4. CEDEARs líquidos con ratio oficial Comafi
    for (const [cedSym, info] of Object.entries(CEDEAR_RATIOS)) {
      const cedPx = cedearMap.get(cedSym)?.last ?? null;
      const usPx = usaMap.get(info.usTicker)?.last ?? adrMap.get(info.usTicker)?.last ?? null;
      if (cedPx !== null && cedPx > 0 && usPx !== null && usPx > 0) {
        rawRows.push({
          symbol: cedSym,
          category: 'CEDEAR',
          ratio: info.ratio,
          localArs: cedPx,
          usdPrice: usPx,
          impliedRate: (cedPx * info.ratio) / usPx,
          side: 'CCL',
        });
      }
    }

    const mepRates = rawRows.filter((r) => r.side === 'MEP' && r.impliedRate !== null).map((r) => r.impliedRate as number);
    const cclRates = rawRows.filter((r) => r.side === 'CCL' && r.impliedRate !== null).map((r) => r.impliedRate as number);

    const mepMedian = computeMedian(mepRates) ?? params.fallbackMep;
    const cclMedian = computeMedian(cclRates) ?? params.fallbackCcl;
    const cclStats = computeMeanAndStd(cclRates);
    const mepStats = computeMeanAndStd(mepRates);

    const rows: MepCclArbitrageRow[] = rawRows.map((r) => {
      const med = r.side === 'MEP' ? mepMedian : cclMedian;
      const st = r.side === 'MEP' ? mepStats : cclStats;
      const spreadBps =
        med !== null && med > 0 && r.impliedRate !== null
          ? ((r.impliedRate - med) / med) * 10_000
          : null;
      const zScore =
        st !== null && st.std > 1e-6 && r.impliedRate !== null
          ? (r.impliedRate - st.mean) / st.std
          : null;
      return {
        symbol: r.symbol,
        category: r.category,
        ratio: r.ratio,
        localArs: sanitizeFinite(r.localArs),
        usdPrice: sanitizeFinite(r.usdPrice),
        impliedRate: sanitizeFinite(r.impliedRate),
        medianRate: sanitizeFinite(med),
        spreadBps: sanitizeFinite(spreadBps),
        zScore: sanitizeFinite(zScore),
        side: r.side,
      };
    });

    return { mepMedian, cclMedian, rows };
  }

  private buildStockDtos(params: {
    readonly argStocks: readonly NormalizedQuoteRow[];
    readonly bymaRows: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly cclMedian: number | null;
    readonly useBymaFallback: boolean;
  }): readonly ArStockDto[] {
    const d912Map = new Map(params.argStocks.map((r) => [r.symbol, r]));
    const bymaMap = new Map(params.bymaRows.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));

    return AR_STOCK_META.map((meta) => {
      const byma = bymaMap.get(meta.ticker);
      const d912 = d912Map.get(meta.ticker);
      const primary = byma ?? d912;
      const source = byma !== undefined ? 'OPEN_BYMA' : d912 !== undefined ? 'DATA912' : 'NONE';

      const last = primary?.last ?? d912?.last ?? null;
      const prevClose = primary?.prevClose ?? d912?.prevClose ?? null;
      const deltaPct = primary?.deltaPct ?? d912?.deltaPct ?? null;
      const low = primary?.low ?? d912?.low ?? null;
      const high = primary?.high ?? d912?.high ?? null;
      const vwap = primary?.vwap ?? d912?.vwap ?? null;
      const volumeArs = primary?.volumeArs ?? d912?.volumeArs ?? null;
      const volumeM = volumeArs !== null ? volumeArs / 1_000_000 : null;

      let adrPrice: number | null = null;
      let adrDeltaPct: number | null = null;
      let cclImplicit: number | null = null;
      if (meta.adrTicker !== undefined) {
        const adrRow = adrMap.get(meta.adrTicker) ?? usaMap.get(meta.adrTicker);
        adrPrice = adrRow?.last ?? null;
        adrDeltaPct = adrRow?.deltaPct ?? null;
        if (last !== null && last > 0 && adrPrice !== null && adrPrice > 0 && meta.adrRatio !== undefined) {
          cclImplicit = (last * meta.adrRatio) / adrPrice;
        }
      }

      const signalText =
        deltaPct === null
          ? 'Sin datos de cotización'
          : deltaPct >= 2.0
            ? 'Impulso alcista sobre cierre previo'
            : deltaPct <= -2.0
              ? 'Presión vendedora intradiaria'
              : Math.abs(deltaPct) < 0.35
                ? 'Lateralización de rango estrecho'
                : deltaPct > 0
                  ? 'Sesgo comprador moderado'
                  : 'Retroceso moderado';

      return {
        ticker: meta.ticker,
        name: meta.name,
        sector: meta.sector,
        panel: meta.panel,
        color: meta.color,
        last: sanitizeFinite(last),
        bid: sanitizeFinite(primary?.bid ?? d912?.bid),
        ask: sanitizeFinite(primary?.ask ?? d912?.ask),
        deltaPct: sanitizeFinite(deltaPct),
        prevClose: sanitizeFinite(prevClose),
        low: sanitizeFinite(low),
        high: sanitizeFinite(high),
        vwap: sanitizeFinite(vwap),
        volumeM: sanitizeFinite(volumeM),
        volMultiple: null,
        signalText: params.useBymaFallback && byma === undefined && d912 !== undefined ? `${signalText} (Data912)` : signalText,
        ...(meta.adrTicker !== undefined ? { adrTicker: `${meta.adrTicker} US`, adrRatio: meta.adrRatio } : {}),
        adrPrice: sanitizeFinite(adrPrice),
        adrDeltaPct: sanitizeFinite(adrDeltaPct),
        cclImplicit: sanitizeFinite(cclImplicit),
        cclZScore:
          cclImplicit !== null && params.cclMedian !== null && params.cclMedian > 0
            ? sanitizeFinite(((cclImplicit - params.cclMedian) / params.cclMedian) * 100)
            : null,
        sparkline: [prevClose, low, high, last].filter((v): v is number => v !== null && Number.isFinite(v)),
        source,
      };
    });
  }

  private buildCedearDtos(params: {
    readonly argCedears: readonly NormalizedQuoteRow[];
    readonly usaStocks: readonly NormalizedQuoteRow[];
    readonly usaAdrs: readonly NormalizedQuoteRow[];
  }): readonly ArStockDto[] {
    const cedearMap = new Map(params.argCedears.map((r) => [r.symbol, r]));
    const usaMap = new Map(params.usaStocks.map((r) => [r.symbol, r]));
    const adrMap = new Map(params.usaAdrs.map((r) => [r.symbol, r]));

    return Object.entries(CEDEAR_RATIOS).map(([ticker, info]) => {
      const row = cedearMap.get(ticker);
      const usRow = usaMap.get(info.usTicker) ?? adrMap.get(info.usTicker);
      const last = row?.last ?? null;
      const usLast = usRow?.last ?? null;
      const cclImplicit =
        last !== null && last > 0 && usLast !== null && usLast > 0
          ? (last * info.ratio) / usLast
          : null;

      return {
        ticker,
        name: info.name,
        sector: 'CEDEAR',
        panel: 'CEDEAR',
        color: '#38BDF8',
        last: sanitizeFinite(last),
        bid: sanitizeFinite(row?.bid),
        ask: sanitizeFinite(row?.ask),
        deltaPct: sanitizeFinite(row?.deltaPct),
        prevClose: sanitizeFinite(row?.prevClose),
        low: sanitizeFinite(row?.low),
        high: sanitizeFinite(row?.high),
        vwap: sanitizeFinite(row?.vwap),
        volumeM: row?.volumeArs !== null && row?.volumeArs !== undefined ? sanitizeFinite(row.volumeArs / 1_000_000) : null,
        volMultiple: null,
        signalText: cclImplicit !== null ? `Ratio ${String(info.ratio)}:1 · Subyacente ${info.usTicker}` : 'Sin datos',
        adrTicker: `${info.usTicker} US`,
        adrRatio: info.ratio,
        adrPrice: sanitizeFinite(usLast),
        adrDeltaPct: sanitizeFinite(usRow?.deltaPct),
        cclImplicit: sanitizeFinite(cclImplicit),
        sparkline: [row?.prevClose ?? null, row?.low ?? null, row?.high ?? null, last].filter(
          (v): v is number => v !== null && Number.isFinite(v),
        ),
        source: row !== undefined ? 'DATA912' : 'NONE',
      };
    });
  }

  private buildSovereignBonds(
    argBonds: readonly NormalizedQuoteRow[],
    mepMedian: number | null,
    cclMedian: number | null,
    asOfUtcSec: number,
  ): readonly ArBondDto[] {
    const bondMap = new Map(argBonds.map((r) => [r.symbol, r]));
    return SOVEREIGN_BONDS.map((spec) => {
      const rowArs = bondMap.get(spec.baseTicker);
      const rowD = bondMap.get(`${spec.baseTicker}D`);
      const rowC = bondMap.get(`${spec.baseTicker}C`);

      const priceArs = rowArs?.last ?? null;
      let priceUsd = rowD?.last ?? rowC?.last ?? null;
      if (priceUsd === null && priceArs !== null && mepMedian !== null && mepMedian > 0) {
        // Data912 arg_bonds puede cotizar bonos en ARS por cada 100 VN o por 1 VN: los soberanos locales operan base 100 VN (~$60.000-$100.000 ARS)
        priceUsd = priceArs / mepMedian;
      }

      const math =
        priceUsd !== null && priceUsd > 0
          ? evaluateSovereignBondMath(spec, priceUsd, asOfUtcSec)
          : { tirPct: null, parityPct: null, duration: null, accruedInterest: null };

      const mepImplicit =
        priceArs !== null && priceArs > 0 && rowD?.last !== null && rowD?.last !== undefined && rowD.last > 0
          ? priceArs / rowD.last
          : null;
      const cclImplicit =
        priceArs !== null && priceArs > 0 && rowC?.last !== null && rowC?.last !== undefined && rowC.last > 0
          ? priceArs / rowC.last
          : null;

      return {
        ticker: spec.baseTicker,
        name: spec.name,
        legislation: spec.legislation,
        maturity: spec.maturity,
        currency: 'USD',
        priceUsd: sanitizeFinite(priceUsd),
        priceArs: sanitizeFinite(priceArs),
        deltaPct: sanitizeFinite(rowD?.deltaPct ?? rowArs?.deltaPct),
        tirPct: math.tirPct,
        parityPct: math.parityPct,
        duration: math.duration,
        accruedInterest: math.accruedInterest,
        volumeM:
          rowArs?.volumeArs !== null && rowArs?.volumeArs !== undefined
            ? sanitizeFinite(rowArs.volumeArs / 1_000_000)
            : null,
        mepImplicit: sanitizeFinite(mepImplicit),
        cclImplicit: sanitizeFinite(cclImplicit),
        source: rowD !== undefined || rowArs !== undefined ? 'DATA912' : 'NONE',
      };
    });
  }

  public async getOverview(forceRefresh = false): Promise<ArOverviewResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:overview',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const [
          mepRes,
          cclRes,
          stocksRes,
          adrsRes,
          cedearsRes,
          usaStocksRes,
          bondsRes,
          bymaBlueRes,
          bymaGeneralRes,
          macroData,
        ] = await Promise.all([
          this.getData912Live('/live/mep', forceRefresh),
          this.getData912Live('/live/ccl', forceRefresh),
          this.getData912Live('/live/arg_stocks', forceRefresh),
          this.getData912Live('/live/usa_adrs', forceRefresh),
          this.getData912Live('/live/arg_cedears', forceRefresh),
          this.getData912Live('/live/usa_stocks', forceRefresh),
          this.getData912Live('/live/arg_bonds', forceRefresh),
          this.getOpenBymaPanel('leading-equity', forceRefresh),
          this.getOpenBymaPanel('general-equity', forceRefresh),
          this.fetchBcraAndArgDatos(forceRefresh),
        ]);

        const providerErrors: string[] = [
          ...macroData.errors,
          ...[
            mepRes.error,
            cclRes.error,
            stocksRes.error,
            adrsRes.error,
            cedearsRes.error,
            usaStocksRes.error,
            bondsRes.error,
            bymaBlueRes.error,
            bymaGeneralRes.error,
          ].filter((e): e is string => e !== null),
        ];

        const matrix = this.computeMepCclMatrix({
          mepRows: mepRes.rows,
          cclRows: cclRes.rows,
          argStocks: stocksRes.rows,
          usaAdrs: adrsRes.rows,
          argCedears: cedearsRes.rows,
          usaStocks: usaStocksRes.rows,
          argBonds: bondsRes.rows,
          fallbackMep: macroData.variables.mep,
          fallbackCcl: macroData.variables.ccl,
        });

        const bymaMerged = [...bymaBlueRes.rows, ...bymaGeneralRes.rows];
        const useBymaFallback = bymaMerged.length === 0;
        const allStocks = this.buildStockDtos({
          argStocks: stocksRes.rows,
          bymaRows: bymaMerged,
          usaAdrs: adrsRes.rows,
          usaStocks: usaStocksRes.rows,
          cclMedian: matrix.cclMedian,
          useBymaFallback,
        });

        const mervalStocks = allStocks.filter((s) => s.panel === 'Líder');
        const generalPanelStocks = allStocks.filter((s) => s.panel === 'General');
        const cedears = this.buildCedearDtos({
          argCedears: cedearsRes.rows,
          usaStocks: usaStocksRes.rows,
          usaAdrs: adrsRes.rows,
        });

        const usaMap = new Map(usaStocksRes.rows.map((u) => [u.symbol, u]));
        const spyUs = usaMap.get('SPY');
        const mepCclGapPct =
          matrix.mepMedian !== null && matrix.cclMedian !== null && matrix.mepMedian > 0
            ? ((matrix.cclMedian - matrix.mepMedian) / matrix.mepMedian) * 100
            : null;

        const globalIndicators: GlobalIndicatorDto[] = [
          {
            id: 'mep',
            label: 'Dólar MEP',
            value: sanitizeFinite(matrix.mepMedian),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Paridad implícita AL30 / GD30 liquidación MEP (Data912 + ArgentinaDatos).',
            source: mepRes.rows.length > 0 ? 'DATA912' : 'ARGENTINADATOS',
          },
          {
            id: 'ccl',
            label: 'Dólar CCL',
            value: sanitizeFinite(matrix.cclMedian),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Contado con Liquidación mediana sobre canasta de ADRs, Bonos y CEDEARs.',
            source: cclRes.rows.length > 0 ? 'DATA912' : 'ADR_ARBITRAGE',
          },
          {
            id: 'embi',
            label: 'Riesgo País',
            value: sanitizeFinite(macroData.variables.riesgoPaisPb),
            decimals: 0,
            suffix: ' pb',
            deltaPct: null,
            help: 'Sobretasa EMBI+ Argentina sobre Treasuries EE.UU. (ArgentinaDatos).',
            source: 'ARGENTINADATOS',
          },
          {
            id: 'badlar',
            label: 'BADLAR TNA',
            value: sanitizeFinite(macroData.variables.badlarTna),
            decimals: 2,
            suffix: ' %',
            deltaPct: null,
            help: 'Tasa BADLAR Bancos Privados en % TNA (API Oficial BCRA v4.0 id=7).',
            source: 'BCRA_V4',
          },
          {
            id: 'a3500',
            label: 'Dólar A3500',
            value: sanitizeFinite(macroData.variables.a3500),
            decimals: 2,
            prefix: '$ ',
            deltaPct: null,
            help: 'Tipo de Cambio Mayorista Com. A3500 (API Oficial BCRA v4.0 id=5).',
            source: 'BCRA_V4',
          },
          {
            id: 'spy',
            label: 'SPY US',
            value: sanitizeFinite(spyUs?.last),
            decimals: 2,
            prefix: '$ ',
            deltaPct: sanitizeFinite(spyUs?.deltaPct),
            help: 'ETF S&P 500 referencia EE.UU. vía Data912.',
            source: 'DATA912',
          },
        ];

        const data912Ok = stocksRes.rows.length > 0 || bondsRes.rows.length > 0 || cedearsRes.rows.length > 0;
        const openBymaOk = bymaMerged.length > 0;
        const feedStatus: FeedStatus = !data912Ok && !openBymaOk
          ? 'NO_DATA'
          : openBymaOk && data912Ok
            ? 'LIVE'
            : data912Ok
              ? 'DIFERIDO_20M'
              : 'PARTIAL';

        const mktState = getArgentinaMarketState(nowSec);

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          data912Status: data912Ok ? 'OK' : 'ERROR',
          openBymaStatus: openBymaOk ? 'OK' : 'DEGRADED',
          marketState: mktState.state,
          marketStateLabel: mktState.label,
          providerErrors,
          globalIndicators,
          mepMedian: sanitizeFinite(matrix.mepMedian),
          cclMedian: sanitizeFinite(matrix.cclMedian),
          mepCclGapPct: sanitizeFinite(mepCclGapPct),
          mervalStocks,
          generalPanelStocks,
          cedears,
          mepCclMatrix: matrix.rows,
        };
      },
      { forceRefresh },
    );

    return cached.value as ArOverviewResponse;
  }

  public async getMacro(forceRefresh = false): Promise<ArMacroResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:macro',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const [macroData, overview, bondsRes] = await Promise.all([
          this.fetchBcraAndArgDatos(forceRefresh),
          this.getOverview(forceRefresh),
          this.getData912Live('/live/arg_bonds', forceRefresh),
        ]);

        const vars = {
          ...macroData.variables,
          mep: overview.mepMedian ?? macroData.variables.mep,
          ccl: overview.cclMedian ?? macroData.variables.ccl,
        };

        const brechaPct =
          vars.ccl !== null && vars.a3500 !== null && vars.a3500 > 0
            ? ((vars.ccl - vars.a3500) / vars.a3500) * 100
            : null;
        const badlarTem =
          vars.badlarTna !== null
            ? (Math.pow(1 + vars.badlarTna / 100 / 12, 1) - 1) * 100
            : null;

        const fmtVal = (v: number | null, dec = 2, prefix = '', suffix = ''): string => {
          if (v === null || !Number.isFinite(v)) {
            return '—';
          }
          const formatted = Math.abs(v).toFixed(dec).replace('.', ',');
          return `${prefix}${v < 0 ? '-' : ''}${formatted}${suffix}`;
        };

        const cards: ArMacroCardDto[] = [
          {
            id: 'a3500',
            label: 'Dólar Mayorista A3500',
            value: fmtVal(vars.a3500, 2, '$ '),
            numericValue: vars.a3500,
            delta: brechaPct !== null ? `Brecha CCL ${fmtVal(brechaPct, 1, '', '%')}` : 'BCRA v4.0 id=5',
            deltaPct: brechaPct,
            help: 'Tipo de cambio de referencia Comunicación A3500 (BCRA v4.0).',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'badlar',
            label: 'BADLAR Bancos Privados',
            value: fmtVal(vars.badlarTna, 2, '', '% TNA'),
            numericValue: vars.badlarTna,
            delta: badlarTem !== null ? `TEM ${fmtVal(badlarTem, 2, '', '%')}` : 'BCRA v4.0 id=7',
            deltaPct: badlarTem,
            help: 'Tasa de interés promedio por depósitos a plazo >$1M en bancos privados.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'tamar',
            label: 'TAMAR Bancos Privados',
            value: fmtVal(vars.tamarTna, 2, '', '% TNA'),
            numericValue: vars.tamarTna,
            delta: 'BCRA v4.0',
            deltaPct: null,
            help: 'Tasa mayorista de referencia (BCRA v4.0).',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'inf_m',
            label: 'Inflación Mensual (IPC)',
            value: fmtVal(vars.inflacionMensualPct, 1, '', '%'),
            numericValue: vars.inflacionMensualPct,
            delta: vars.inflacionInteranualPct !== null ? `YoY ${fmtVal(vars.inflacionInteranualPct, 1, '', '%')}` : 'INDEC',
            deltaPct: vars.inflacionInteranualPct,
            help: 'Variación mensual e interanual del IPC Nacional (ArgentinaDatos / INDEC).',
            source: 'ARGENTINADATOS',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'reservas',
            label: 'Reservas Internacionales',
            value: fmtVal(vars.reservasUsdM, 0, 'USD ', ' M'),
            numericValue: vars.reservasUsdM,
            delta: vars.baseMonetariaArsM !== null ? `BM $${Math.round(vars.baseMonetariaArsM).toLocaleString('es-AR')} M` : 'BCRA v4.0',
            deltaPct: null,
            help: 'Stock de reservas internacionales brutas del BCRA en millones de USD.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'cer_uva',
            label: 'CER / UVA',
            value: fmtVal(vars.cer, 2),
            numericValue: vars.cer,
            delta: vars.uva !== null ? `UVA ${fmtVal(vars.uva, 2)}` : 'BCRA v4.0',
            deltaPct: null,
            help: 'Coeficiente de Estabilización de Referencia y Unidad de Valor Adquisitivo.',
            source: 'BCRA_V4',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'riesgo_pais',
            label: 'Riesgo País (EMBI+)',
            value: fmtVal(vars.riesgoPaisPb, 0, '', ' pb'),
            numericValue: vars.riesgoPaisPb,
            delta: 'Spread soberano',
            deltaPct: null,
            help: 'Diferencial de tasa de bonos soberanos argentinos frente al Tesoro de EE.UU.',
            source: 'ARGENTINADATOS',
            updatedAt: macroData.updatedAt,
          },
          {
            id: 'mep_ccl',
            label: 'CCL / MEP Implícito',
            value: fmtVal(vars.ccl, 2, '$ '),
            numericValue: vars.ccl,
            delta: vars.mep !== null ? `MEP $${fmtVal(vars.mep, 2)}` : 'Arbitraje vivo',
            deltaPct: overview.mepCclGapPct,
            help: 'Mediana en vivo de Contado con Liquidación y Dólar Bolsa.',
            source: 'DATA912',
            updatedAt: macroData.updatedAt,
          },
        ];

        const sovereignCurve = this.buildSovereignBonds(bondsRes.rows, vars.mep, vars.ccl, nowSec);
        const providerErrors = [...macroData.errors, ...overview.providerErrors];
        const hasAnyMacro = cards.some((c) => c.numericValue !== null);
        const feedStatus: FeedStatus = !hasAnyMacro ? 'NO_DATA' : providerErrors.length > 0 ? 'PARTIAL' : 'LIVE';

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          providerErrors,
          cards,
          variables: vars,
          dolares: macroData.dolares,
          sovereignCurve,
        };
      },
      { forceRefresh },
    );

    return cached.value as ArMacroResponse;
  }

  public async getMonitoring(
    panel: ArMonitoringResponse['panel'] = 'acciones',
    forceRefresh = false,
  ): Promise<ArMonitoringResponse> {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const [overview, bondsRes, notesRes, corpRes, macroData] = await Promise.all([
      this.getOverview(forceRefresh),
      this.getData912Live('/live/arg_bonds', forceRefresh),
      this.getData912Live('/live/arg_notes', forceRefresh),
      this.getData912Live('/live/arg_corp', forceRefresh),
      this.fetchBcraAndArgDatos(forceRefresh),
    ]);

    const bonds = this.buildSovereignBonds(bondsRes.rows, overview.mepMedian, overview.cclMedian, nowSec);
    const mapNoteOrCorp = (rows: readonly NormalizedQuoteRow[], kind: ArNoteOrCorpDto['kind']): readonly ArNoteOrCorpDto[] =>
      rows.slice(0, 60).map((r) => ({
        ticker: r.symbol,
        name: kind === 'LECAP_BONCAP' ? `Letra/Bono ${r.symbol}` : `ON ${r.symbol}`,
        kind,
        price: sanitizeFinite(r.last),
        bid: sanitizeFinite(r.bid),
        ask: sanitizeFinite(r.ask),
        deltaPct: sanitizeFinite(r.deltaPct),
        volumeM: r.volumeArs !== null ? sanitizeFinite(r.volumeArs / 1_000_000) : null,
        source: 'DATA912',
      }));

    const notes = mapNoteOrCorp(notesRes.rows, 'LECAP_BONCAP');
    const corps = mapNoteOrCorp(corpRes.rows, 'ON_CORP');
    const providerErrors = [
      ...overview.providerErrors,
      ...[bondsRes.error, notesRes.error, corpRes.error].filter((e): e is string => e !== null),
    ];

    return {
      asOfUtcSec: nowSec,
      feedStatus: overview.feedStatus,
      panel,
      providerErrors,
      stocks: overview.mervalStocks,
      generalPanel: overview.generalPanelStocks,
      bonds,
      cedears: overview.cedears,
      notes,
      corps,
      mepMedian: overview.mepMedian,
      cclMedian: overview.cclMedian,
      badlarTna: macroData.variables.badlarTna,
    };
  }

  public async getStockDetail(rawSymbol: string, forceRefresh = false): Promise<ArStockDetailResponse> {
    const symbol = rawSymbol.trim().toUpperCase();
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const isBond = SOVEREIGN_BONDS.some((b) => b.baseTicker === symbol || `${b.baseTicker}D` === symbol || `${b.baseTicker}C` === symbol);
    const isCedear = symbol in CEDEAR_RATIOS && !STOCK_META_MAP.has(symbol);
    const kind: 'stocks' | 'cedears' | 'bonds' = isBond ? 'bonds' : isCedear ? 'cedears' : 'stocks';

    const [histRes, overview, optionsRes, bondsLive] = await Promise.all([
      this.getData912History(kind, symbol, forceRefresh),
      this.getOverview(forceRefresh),
      this.getData912Live('/live/arg_options', forceRefresh),
      isBond ? this.getData912Live('/live/arg_bonds', forceRefresh) : Promise.resolve({ rows: [] as readonly NormalizedQuoteRow[], error: null }),
    ]);

    const stock =
      overview.mervalStocks.find((s) => s.ticker === symbol) ??
      overview.generalPanelStocks.find((s) => s.ticker === symbol) ??
      overview.cedears.find((s) => s.ticker === symbol) ??
      null;

    const bond = isBond
      ? this.buildSovereignBonds(bondsLive.rows, overview.mepMedian, overview.cclMedian, nowSec).find((b) =>
          symbol.startsWith(b.ticker),
        ) ?? null
      : null;

    const bars = histRes.bars;
    const closes = bars.map((b) => b.close);
    const rsiSeries = closes.length >= 15 ? computeWilderRsiSeries(closes, 14) : [];
    const sma50Series = closes.length >= 50 ? computeSmaSeries(closes, 50) : [];
    const sma200Series = closes.length >= 200 ? computeSmaSeries(closes, 200) : [];
    const ema21Series = closes.length >= 21 ? calculateEma(closes, 21) : [];

    const rv20 = computeDailyRealizedVol(bars, 20);
    const rv60 = computeDailyRealizedVol(bars, 60);
    const cclDiv = overview.cclMedian ?? overview.mepMedian ?? null;
    const deflatedBars: readonly Bar[] =
      cclDiv !== null && cclDiv > 0
        ? bars.map((b) => ({
            ...b,
            open: b.open / cclDiv,
            high: b.high / cclDiv,
            low: b.low / cclDiv,
            close: b.close / cclDiv,
          }))
        : [];
    const rvUsd20 = computeDailyRealizedVol(deflatedBars, 20);

    const mtf = bars.length > 0
      ? evaluateMtfStructure({ bars1d: bars, bars4h: [], bars15m: [], bars5m: [] }, { asOfUtcSec: nowSec })
      : null;

    const relatedOptionsCount = optionsRes.rows.filter((o) => {
      const parsed = parseBymaOptionSymbol(o.symbol, stock?.last ?? null, nowSec);
      return parsed !== null && parsed.underlying === symbol;
    }).length;

    const historicalBars: ArHistoricalBarDto[] = bars.map((b, idx) => {
      const prev = bars[idx - 1];
      const ret = prev !== undefined && prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : null;
      const d = new Date(b.time * 1_000);
      return {
        time: b.time,
        date: d.toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        closeDeflatedUsd: cclDiv !== null && cclDiv > 0 ? sanitizeFinite(b.close / cclDiv) : null,
        volume: b.volume,
        dailyReturnPct: sanitizeFinite(ret),
      };
    });

    const providerErrors = [
      ...overview.providerErrors,
      ...(histRes.error !== null ? [histRes.error] : []),
      ...(optionsRes.error !== null ? [optionsRes.error] : []),
    ];

    const feedStatus: FeedStatus = stock === null && bond === null && bars.length === 0 ? 'NO_DATA' : overview.feedStatus;

    return {
      asOfUtcSec: nowSec,
      feedStatus,
      symbol,
      assetType: isBond ? 'BOND' : isCedear ? 'CEDEAR' : 'STOCK',
      stock,
      bond,
      historicalBars,
      realizedVol20d: sanitizeFinite(rv20),
      realizedVol60d: sanitizeFinite(rv60),
      realizedVolUsd20d: sanitizeFinite(rvUsd20),
      rsi14: sanitizeFinite(rsiSeries[rsiSeries.length - 1]),
      sma50: sanitizeFinite(sma50Series[sma50Series.length - 1]),
      sma200: sanitizeFinite(sma200Series[sma200Series.length - 1]),
      ema21: sanitizeFinite(ema21Series[ema21Series.length - 1]),
      mtfRegime: mtf?.regime1d ?? 'NO_DATA',
      relatedOptionsCount,
      providerErrors,
    };
  }

  public async getOptionsChain(rawUnderlying = 'GGAL', forceRefresh = false): Promise<ArOptionsResponse> {
    const underlying = rawUnderlying.trim().toUpperCase();
    const cacheKey = `ar:options:${underlying}`;
    const cached = await this.computedCache.getOrCompute(
      cacheKey,
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const [optionsRes, overview, macroData, histRes] = await Promise.all([
          this.getData912Live('/live/arg_options', forceRefresh),
          this.getOverview(forceRefresh),
          this.fetchBcraAndArgDatos(forceRefresh),
          this.getData912History('stocks', underlying, forceRefresh),
        ]);

        const stock =
          overview.mervalStocks.find((s) => s.ticker === underlying) ??
          overview.generalPanelStocks.find((s) => s.ticker === underlying) ??
          null;
        const bars = histRes.bars;
        const spot = stock?.last ?? (bars.length > 0 ? bars[bars.length - 1]?.close ?? null : null);
        const dividendYield = STOCK_META_MAP.get(underlying)?.dividendYield ?? 0;

        // Tasa libre de riesgo desde BCRA BADLAR/TAMAR; sin fallback inventado si falta BCRA
        const rateTnaPct = macroData.variables.badlarTna ?? macroData.variables.tamarTna ?? macroData.variables.tpmTna ?? null;
        const continuousRate =
          rateTnaPct !== null && rateTnaPct > 0 ? Math.log(1 + rateTnaPct / 100) : null;

        const rv20 = computeDailyRealizedVol(bars, 20);
        const rv60 = computeDailyRealizedVol(bars, 60);
        const historicalCloses = bars.slice(-90).map((b) => b.close);

        const parsedContracts: {
          readonly parsed: ParsedBymaOptionSymbol;
          readonly row: NormalizedQuoteRow;
        }[] = [];
        for (const row of optionsRes.rows) {
          const parsed = parseBymaOptionSymbol(row.symbol, spot, nowSec);
          if (parsed !== null && parsed.underlying === underlying) {
            parsedContracts.push({ parsed, row });
          }
        }

        const providerErrors = [
          ...overview.providerErrors,
          ...macroData.errors,
          ...[optionsRes.error, histRes.error].filter((e): e is string => e !== null),
        ];

        const byExpiry = new Map<string, typeof parsedContracts>();
        for (const item of parsedContracts) {
          const key = item.parsed.expirationDate;
          const bucket = byExpiry.get(key);
          if (bucket !== undefined) {
            bucket.push(item);
          } else {
            byExpiry.set(key, [item]);
          }
        }

        const sortedExpKeys = [...byExpiry.keys()].sort();
        const expiries: ArOptionExpiryDto[] = [];
        const allExposureInputs: ExposureContractInput[] = [];
        const evalRate = continuousRate ?? Number.NaN;

        for (const expKey of sortedExpKeys) {
          const bucket = byExpiry.get(expKey);
          if (bucket === undefined || bucket.length === 0) {
            continue;
          }
          const sample = bucket[0]?.parsed;
          if (sample === undefined) {
            continue;
          }
          const tExp = Math.max(1 / 365, (sample.expiryUtcSec - nowSec) / (365 * 86_400));
          const calls: ArOptionContractDto[] = [];
          const puts: ArOptionContractDto[] = [];
          const volQuotes: VolQuoteInput[] = [];
          const strikeSet = new Set<number>();

          for (const { parsed, row } of bucket) {
            strikeSet.add(parsed.strike);
            const bid = row.bid;
            const ask = row.ask;
            const last = row.last;
            const mid =
              bid !== null && ask !== null && bid > 0 && ask >= bid
                ? 0.5 * (bid + ask)
                : last !== null && last > 0
                  ? last
                  : ask !== null && ask > 0 && bid !== null && bid > 0
                    ? 0.5 * (bid + ask)
                    : null;

            const intrinsic =
              spot !== null
                ? parsed.contractType === 'call'
                  ? Math.max(0, spot - parsed.strike)
                  : Math.max(0, parsed.strike - spot)
                : 0;

            let iv = Number.NaN;
            if (spot !== null && spot > 0 && mid !== null && mid > 0 && Number.isFinite(evalRate)) {
              iv = solveImpliedVolAmerican({
                spot,
                strike: parsed.strike,
                timeToExpiry: tExp,
                rate: evalRate,
                dividendYield,
                contractType: parsed.contractType,
                marketPrice: mid,
              });
            }

            const greeks =
              spot !== null && spot > 0 && Number.isFinite(iv) && iv > 0 && Number.isFinite(evalRate)
                ? greeksAmericanFiniteDiffOrAnalytical({
                    spot,
                    strike: parsed.strike,
                    timeToExpiry: tExp,
                    rate: evalRate,
                    dividendYield,
                    volatility: iv,
                    contractType: parsed.contractType,
                  })
                : null;

            if (Number.isFinite(iv) && iv > 0 && mid !== null && mid > 0) {
              const effBid = bid !== null && bid > 0 ? bid : mid * 0.98;
              const effAsk = ask !== null && ask >= effBid ? ask : mid * 1.02;
              volQuotes.push({
                strike: parsed.strike,
                contractType: parsed.contractType,
                iv,
                bid: effBid,
                ask: effAsk,
                mid,
                openInterest: Math.max(1, Math.round(row.nominalVol ?? 1)),
              });
            }

            const forward =
              spot !== null && Number.isFinite(evalRate)
                ? spot * Math.exp((evalRate - dividendYield) * tExp)
                : Number.NaN;

            if (
              spot !== null &&
              spot > 0 &&
              Number.isFinite(evalRate) &&
              Number.isFinite(forward) &&
              (Number.isFinite(iv) || (mid !== null && mid > 0))
            ) {
              allExposureInputs.push({
                contractType: parsed.contractType,
                strike: parsed.strike,
                expiryUtcSec: parsed.expiryUtcSec,
                openInterest: Math.max(1, Math.round(row.nominalVol ?? 1)),
                ...(row.nominalVol !== null ? { volume: row.nominalVol } : {}),
                sharesPerContract: OPTION_LOT_SIZE,
                spot,
                forward,
                rate: evalRate,
                dividendYield,
                ...(Number.isFinite(iv) && iv > 0 ? { iv } : {}),
                ...(mid !== null && mid > 0 ? { midPrice: mid } : {}),
                ...(bid !== null && bid >= 0 ? { bid } : {}),
                ...(ask !== null && ask > 0 ? { ask } : {}),
              });
            }

            const dto: ArOptionContractDto = {
              symbol: parsed.symbol,
              underlying: parsed.underlying,
              contractType: parsed.contractType,
              strike: parsed.strike,
              expiryCode: parsed.expiryCode,
              expirationDate: parsed.expirationDate,
              expiryUtcSec: parsed.expiryUtcSec,
              daysToExpiry: parsed.daysToExpiry,
              bid: sanitizeFinite(bid),
              ask: sanitizeFinite(ask),
              last: sanitizeFinite(last),
              mark: sanitizeFinite(mid),
              volume: sanitizeFinite(row.nominalVol),
              openInterest: sanitizeFinite(row.nominalVol),
              iv: sanitizeFinite(iv),
              delta: sanitizeFinite(greeks?.delta),
              gamma: sanitizeFinite(greeks?.gamma),
              thetaDaily: sanitizeFinite(greeks?.thetaDaily),
              vegaPer1Pct: sanitizeFinite(greeks?.vegaPer1Pct),
              rho: sanitizeFinite(greeks?.rho),
              vanna: sanitizeFinite(greeks?.vanna),
              charm: sanitizeFinite(greeks?.charm),
              intrinsic: Math.round(intrinsic * 100) / 100,
              extrinsic: mid !== null ? sanitizeFinite(Math.max(0, mid - intrinsic)) : null,
              source: 'DATA912',
            };

            if (parsed.contractType === 'call') {
              calls.push(dto);
            } else {
              puts.push(dto);
            }
          }

          calls.sort((a, b) => a.strike - b.strike);
          puts.sort((a, b) => a.strike - b.strike);

          let ivAtm = Number.NaN;
          let riskReversal25 = Number.NaN;
          let butterfly25 = Number.NaN;
          let butterflyArbitrageFree = true;

          if (spot !== null && spot > 0 && Number.isFinite(evalRate) && volQuotes.length >= 4) {
            const forward = spot * Math.exp((evalRate - dividendYield) * tExp);
            const slice = buildVolSlice(
              {
                timeToExpiry: tExp,
                expirySec: sample.expiryUtcSec,
                forward,
                spot,
                rate: evalRate,
                dividendYield,
                quotes: volQuotes,
              },
              {
                requirePositiveBid: false,
                maxSpreadRatio: 0.9,
                minOpenInterest: 1,
                minPoints: 4,
                quoteSelection: 'otm',
              },
            );
            if (slice.isValid) {
              const metrics = computeSliceVolMetrics(slice, {
                spot,
                rate: evalRate,
                dividendYield,
                deltaConvention: 'spotBsm',
              });
              ivAtm = metrics.ivAtm;
              riskReversal25 = metrics.riskReversal25;
              butterfly25 = metrics.butterfly25;
              butterflyArbitrageFree = metrics.isButterflyArbitrageFree;
            } else {
              // Mediana de IV de strikes cercanos al ATM (+/- 10%) si hay <4 nodos OTM válidos
              const nearAtmIvs = volQuotes
                .filter((q) => Math.abs(q.strike - spot) / spot <= 0.1)
                .map((q) => q.iv);
              ivAtm = computeMedian(nearAtmIvs) ?? Number.NaN;
            }
          } else if (volQuotes.length > 0 && spot !== null && spot > 0) {
            const nearAtmIvs = volQuotes
              .filter((q) => Math.abs(q.strike - spot) / spot <= 0.12)
              .map((q) => q.iv);
            ivAtm = computeMedian(nearAtmIvs) ?? computeMedian(volQuotes.map((q) => q.iv)) ?? Number.NaN;
          }

          expiries.push({
            expiryCode: sample.expiryCode,
            expiryLabel: sample.expiryLabel,
            expirationDate: sample.expirationDate,
            expiryUtcSec: sample.expiryUtcSec,
            days: sample.daysToExpiry,
            ivAtm: sanitizeFinite(ivAtm),
            riskReversal25: sanitizeFinite(riskReversal25),
            butterfly25: sanitizeFinite(butterfly25),
            butterflyArbitrageFree,
            strikes: [...strikeSet].sort((a, b) => a - b),
            calls,
            puts,
          });
        }

        let exposureSummary: ArOptionsResponse['exposureSummary'] = null;
        if (spot !== null && spot > 0 && Number.isFinite(evalRate) && allExposureInputs.length > 0) {
          const frontExp = expiries[0];
          const expResult = computeDealerExposure(
            allExposureInputs,
            {
              spot,
              nowUtcSec: nowSec,
              rate: evalRate,
              dividendYield,
              forward:
                frontExp !== undefined
                  ? spot * Math.exp((evalRate - dividendYield) * (frontExp.days / 365))
                  : spot,
            },
            {
              model: 'american',
              wallCriterion: 'gex',
              wallScope: 'all',
              gammaFlipHalfWidth: 0.2,
              gammaFlipGridSteps: 80,
              gammaFlipMultiRootPolicy: 'nearestSpot',
              ivResolutionMode: 'ivThenMidPrice',
              ...(frontExp !== undefined ? { expectedMoveExpirySec: frontExp.expiryUtcSec } : {}),
              ...(frontExp?.ivAtm !== null && frontExp?.ivAtm !== undefined
                ? { expectedMoveIvAtmOverride: frontExp.ivAtm }
                : {}),
            },
          );

          exposureSummary = {
            netGex: sanitizeFinite(expResult.netGex),
            netDex: sanitizeFinite(expResult.netDex),
            callWallStrike: sanitizeFinite(expResult.callWallStrike),
            putWallStrike: sanitizeFinite(expResult.putWallStrike),
            gammaFlipSpot: sanitizeFinite(expResult.gammaFlipSpot),
            gammaFlipStatus: expResult.gammaFlipStatus,
            expectedMoveAbs: sanitizeFinite(expResult.expectedMove.formulaMove),
            expectedMovePct: sanitizeFinite(expResult.expectedMove.formulaMovePct),
          };
        }

        const termStructure = expiries
          .filter((e): e is ArOptionExpiryDto & { readonly ivAtm: number } => e.ivAtm !== null)
          .map((e) => ({
            days: e.days,
            label: e.expiryCode,
            expiryCode: e.expiryCode,
            atm: e.ivAtm,
          }));

        const frontIvAtm = termStructure[0]?.atm ?? null;
        const vrpSpread = frontIvAtm !== null && rv20 !== null ? frontIvAtm - rv20 : null;
        const feedStatus: FeedStatus =
          spot === null && expiries.length === 0
            ? 'NO_DATA'
            : expiries.length === 0 || rateTnaPct === null
              ? 'PARTIAL'
              : overview.feedStatus;

        return {
          asOfUtcSec: nowSec,
          feedStatus,
          underlying,
          spot: sanitizeFinite(spot),
          rateTna: sanitizeFinite(rateTnaPct),
          continuousRate: sanitizeFinite(continuousRate),
          dividendYield,
          lotSize: OPTION_LOT_SIZE,
          settlement: 'T+0' as const,
          exerciseCutoffArt: '15:30 ART' as const,
          realizedVol20d: sanitizeFinite(rv20),
          realizedVol60d: sanitizeFinite(rv60),
          histMedianIv: sanitizeFinite(rv60 !== null ? rv60 * 1.12 : null),
          vrpSpread: sanitizeFinite(vrpSpread),
          historicalCloses,
          termStructure,
          expiries,
          exposureSummary,
          costSchedule: {
            rvMarketFeeRate: BYMA_RV_FEE,
            optionsFeeRate: BYMA_OPTION_FEE,
            shortLoanFeeRate: BYMA_SHORT_LOAN_FEE,
            vatRate: BYMA_VAT_RATE,
            bondsVatExempt: true as const,
          },
          providerErrors,
        };
      },
      { forceRefresh },
    );

    return cached.value as ArOptionsResponse;
  }

  public async getRelations(forceRefresh = false): Promise<ArRelationsResponse> {
    const cached = await this.computedCache.getOrCompute(
      'ar:relations',
      async () => {
        const nowSec = Math.floor(this.nowMsFn() / 1_000);
        const [overview, gd30H, al30H, ggalH, bmaH, ypfdH, vistaH] = await Promise.all([
          this.getOverview(forceRefresh),
          this.getData912History('bonds', 'GD30D', forceRefresh),
          this.getData912History('bonds', 'AL30D', forceRefresh),
          this.getData912History('stocks', 'GGAL', forceRefresh),
          this.getData912History('stocks', 'BMA', forceRefresh),
          this.getData912History('stocks', 'YPFD', forceRefresh),
          this.getData912History('cedears', 'VISTA', forceRefresh),
        ]);

        const buildPair = (
          id: string,
          name: string,
          legA: string,
          legB: string,
          unit: string,
          barsA: readonly Bar[],
          barsB: readonly Bar[],
          mode: 'DIFF' | 'RATIO',
        ): ArRelationPairDto => {
          const mapB = new Map<string, number>();
          for (const b of barsB) {
            mapB.set(new Date(b.time * 1_000).toISOString().slice(0, 10), b.close);
          }

          const paired: { time: number; val: number }[] = [];
          for (const a of barsA) {
            const key = new Date(a.time * 1_000).toISOString().slice(0, 10);
            const bClose = mapB.get(key);
            if (bClose === undefined || bClose <= 0 || a.close <= 0) {
              continue;
            }
            const val = mode === 'DIFF' ? a.close - bClose : a.close / bClose;
            if (Number.isFinite(val)) {
              paired.push({ time: a.time, val });
            }
          }

          const recent60 = paired.slice(-60);
          const vals60 = recent60.map((p) => p.val);
          const stats = computeMeanAndStd(vals60);
          const latest = recent60[recent60.length - 1]?.val ?? null;
          const zScore =
            latest !== null && stats !== null && stats.std > 1e-8
              ? (latest - stats.mean) / stats.std
              : null;

          const belowCount =
            latest !== null ? vals60.filter((v) => v <= latest).length : 0;
          const percentile60d =
            vals60.length > 0 && latest !== null ? (belowCount / vals60.length) * 100 : null;

          const history = recent60.map((p) => ({
            time: p.time,
            ratio: p.val,
            zScore:
              stats !== null && stats.std > 1e-8 ? (p.val - stats.mean) / stats.std : 0,
          }));

          const signal =
            zScore === null
              ? 'Sin historial suficiente'
              : zScore >= 2.0
                ? `${legA} muy caro relativo a ${legB} (+${zScore.toFixed(1)}σ)`
                : zScore <= -2.0
                  ? `${legA} barato relativo a ${legB} (${zScore.toFixed(1)}σ)`
                  : 'Dentro de rango histórico 60 ruedas';

          return {
            id,
            name,
            legA,
            legB,
            unit,
            currentValue: sanitizeFinite(latest),
            mean60d: sanitizeFinite(stats?.mean),
            std60d: sanitizeFinite(stats?.std),
            zScore: sanitizeFinite(zScore),
            percentile60d: sanitizeFinite(percentile60d),
            signal,
            history,
          };
        };

        const pairs: ArRelationPairDto[] = [
          buildPair('gd30-al30', 'Spread Legislación GD30D - AL30D', 'GD30D', 'AL30D', 'USD', gd30H.bars, al30H.bars, 'DIFF'),
          buildPair('ggal-bma', 'Ratio Bancos GGAL / BMA', 'GGAL', 'BMA', 'x', ggalH.bars, bmaH.bars, 'RATIO'),
          buildPair('ypfd-vista', 'Ratio Energía YPFD / VISTA', 'YPFD', 'VISTA', 'x', ypfdH.bars, vistaH.bars, 'RATIO'),
        ];

        const providerErrors = [
          ...overview.providerErrors,
          ...[gd30H.error, al30H.error, ggalH.error, bmaH.error, ypfdH.error, vistaH.error].filter(
            (e): e is string => e !== null,
          ),
        ];

        return {
          asOfUtcSec: nowSec,
          feedStatus: pairs.some((p) => p.currentValue !== null) ? overview.feedStatus : 'PARTIAL',
          providerErrors,
          pairs,
          mepCclArbitrage: overview.mepCclMatrix,
        };
      },
      { forceRefresh },
    );

    return cached.value as ArRelationsResponse;
  }

  /** Helper puro exportado para pruebas de pricing americano BYMA en T+0 con derechos e IVA. */
  public static evaluateBymaOptionCostAndFair(params: {
    readonly spot: number;
    readonly strike: number;
    readonly daysToExpiry: number;
    readonly rateContinuous: number;
    readonly dividendYield: number;
    readonly volatility: number;
    readonly contractType: 'call' | 'put';
  }): {
    readonly fairPrice: number;
    readonly commissionWithVatArsPerLot: number;
  } {
    const tExp = Math.max(1 / 365, params.daysToExpiry / 365);
    const fairPrice = priceAmericanBjerksund2002({
      spot: params.spot,
      strike: params.strike,
      timeToExpiry: tExp,
      rate: params.rateContinuous,
      dividendYield: params.dividendYield,
      volatility: params.volatility,
      contractType: params.contractType,
    });
    const notional = Number.isFinite(fairPrice) ? fairPrice * OPTION_LOT_SIZE : 0;
    const commissionWithVatArsPerLot = notional * BYMA_OPTION_FEE * (1 + BYMA_VAT_RATE);
    return {
      fairPrice,
      commissionWithVatArsPerLot,
    };
  }
}
