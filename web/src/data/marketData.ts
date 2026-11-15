import type {
  ArBondDto,
  ArMacroResponse,
  ArMonitoringResponse,
  ArNoteOrCorpDto,
  ArOptionContractDto,
  ArOptionsResponse,
  ArOverviewResponse,
  ArRelationsResponse,
  ArStockDto,
  UsSnapshotResponseDto,
} from './liveTypes';

const toNumOrNaN = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;

// Utilidades de formato numérico es-AR (Zero Silent Fallbacks: NaN/null -> "—")
export function fmtNum(val: number | null | undefined, decimals = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const fixed = Math.abs(val).toFixed(decimals);
  const parts = fixed.split('.');
  const intPart = parts[0] ?? '0';
  const decPart = parts[1] ?? '';
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = val < 0 ? '-' : '';
  return decimals > 0 ? `${sign}${withDots},${decPart}` : `${sign}${withDots}`;
}

export function fmtPct(val: number | null | undefined, decimals = 2, plusSign = true): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const sign = val > 0 && plusSign ? '+' : val < 0 ? '−' : '';
  const fixed = Math.abs(val).toFixed(decimals).replace('.', ',');
  return `${sign}${fixed} %`;
}

export function fmtPctTable(val: number | null | undefined, decimals = 2): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  const fixed = Math.abs(val).toFixed(decimals).replace('.', ',');
  return `${sign}${fixed}%`;
}

export function fmtMoneyCompact(valInMillions: number | null | undefined): string {
  if (valInMillions === null || valInMillions === undefined || !Number.isFinite(valInMillions)) return '—';
  if (valInMillions >= 1000) {
    return `$ ${(valInMillions / 1000).toFixed(2).replace('.', ',')} mil M`;
  }
  return `$ ${Math.round(valInMillions).toLocaleString('es-AR')} M`;
}

export interface GlobalTickerIndicator {
  id: string;
  label: string;
  value: number;
  decimals: number;
  prefix?: string;
  suffix?: string;
  deltaPct: number;
  help: string;
}

export const GLOBAL_INDICATORS: GlobalTickerIndicator[] = [
  { id: 'mep', label: 'Dólar MEP', value: Number.NaN, decimals: 2, prefix: '$ ', deltaPct: Number.NaN, help: 'Paridad implícita AL30 / AL30D calculada en vivo.' },
  { id: 'ccl', label: 'Dólar CCL', value: Number.NaN, decimals: 2, prefix: '$ ', deltaPct: Number.NaN, help: 'Contado con Liquidación implícito mediano de ADRs, CEDEARs y bonos C.' },
  { id: 'embi', label: 'Riesgo País', value: Number.NaN, decimals: 0, suffix: ' pb', deltaPct: Number.NaN, help: 'Sobretasa de bonos soberanos argentinos (ArgentinaDatos / Ámbito).' },
  { id: 'caucion', label: 'BADLAR TNA', value: Number.NaN, decimals: 2, suffix: ' %', deltaPct: Number.NaN, help: 'Tasa Nominal Anual de referencia BCRA.' },
  { id: 'sp500', label: 'SPY (NYSE)', value: Number.NaN, decimals: 2, prefix: '$ ', deltaPct: Number.NaN, help: 'ETF S&P 500 en tiempo real vía Massive.' },
  { id: 'vix', label: 'VIX', value: Number.NaN, decimals: 2, deltaPct: Number.NaN, help: 'Índice CBOE de volatilidad implícita a 30 días del S&P 500.' },
];

export interface StockRow {
  ticker: string;
  name: string;
  sector: 'Bancos' | 'Energía' | 'Reguladas' | 'Materiales' | 'Telecom' | 'Agro';
  panel?: 'Líder' | 'General';
  color: string;
  last: number;
  bid?: number;
  ask?: number;
  deltaPct: number;
  prevClose: number;
  low: number;
  high: number;
  vwap: number;
  volumeM: number; // millones ARS
  volMultiple: number;
  signalText: string;
  adrTicker?: string;
  adrRatio?: number;
  adrPrice?: number;
  adrDeltaPct?: number;
  cclImplicit?: number;
  iv30d?: number;
  ivRank?: 'barata' | 'rango' | 'cara';
  ivPercentile?: number;
  sparkline: number[];
}

const makeSkeletonStock = (
  ticker: string,
  name: string,
  sector: StockRow['sector'],
  panel: 'Líder' | 'General',
  color: string,
  adrTicker?: string,
  adrRatio?: number
): StockRow => ({
  ticker,
  name,
  sector,
  panel,
  color,
  last: Number.NaN,
  bid: Number.NaN,
  ask: Number.NaN,
  deltaPct: Number.NaN,
  prevClose: Number.NaN,
  low: Number.NaN,
  high: Number.NaN,
  vwap: Number.NaN,
  volumeM: Number.NaN,
  volMultiple: Number.NaN,
  signalText: '—',
  ...(adrTicker !== undefined ? { adrTicker } : {}),
  ...(adrRatio !== undefined ? { adrRatio } : {}),
  adrPrice: Number.NaN,
  adrDeltaPct: Number.NaN,
  cclImplicit: Number.NaN,
  iv30d: Number.NaN,
  ivRank: 'rango',
  sparkline: [],
});

export const AR_STOCKS: StockRow[] = [
  makeSkeletonStock('GGAL', 'Grupo Financiero Galicia', 'Bancos', 'Líder', '#8B7CF6', 'GGAL', 10),
  makeSkeletonStock('YPFD', 'YPF S.A.', 'Energía', 'Líder', '#4BA3FF', 'YPF', 1),
  makeSkeletonStock('PAMP', 'Pampa Energía', 'Energía', 'Líder', '#2EDC7E', 'PAM', 25),
  makeSkeletonStock('BMA', 'Banco Macro', 'Bancos', 'Líder', '#F5B544', 'BMA', 10),
  makeSkeletonStock('SUPV', 'Grupo Supervielle', 'Bancos', 'Líder', '#E5558F', 'SUPV', 5),
  makeSkeletonStock('BBAR', 'BBVA Argentina', 'Bancos', 'Líder', '#4BA3FF', 'BBAR', 3),
  makeSkeletonStock('CEPU', 'Central Puerto', 'Energía', 'Líder', '#2EDC7E', 'CEPU', 10),
  makeSkeletonStock('TGSU2', 'Transportadora de Gas del Sur', 'Reguladas', 'Líder', '#5B8CFF', 'TGS', 5),
  makeSkeletonStock('EDN', 'Edenor', 'Reguladas', 'Líder', '#34D3C7', 'EDN', 20),
  makeSkeletonStock('TXAR', 'Ternium Argentina', 'Materiales', 'Líder', '#E5558F'),
  makeSkeletonStock('ALUA', 'Aluar Aluminio', 'Materiales', 'Líder', '#8B7CF6'),
  makeSkeletonStock('LOMA', 'Loma Negra', 'Materiales', 'Líder', '#F5B544', 'LOMA', 5),
  makeSkeletonStock('MIRG', 'Mirgor S.A.', 'Materiales', 'Líder', '#5B8CFF'),
  makeSkeletonStock('CRES', 'Cresud S.A.', 'Agro', 'Líder', '#2EDC7E', 'CRESY', 10),
  makeSkeletonStock('TRAN', 'Transener S.A.', 'Reguladas', 'Líder', '#34D3C7'),
  makeSkeletonStock('METR', 'MetroGAS S.A.', 'Reguladas', 'Líder', '#4BA3FF'),
  makeSkeletonStock('TGNO4', 'Transportadora Gas del Norte', 'Reguladas', 'Líder', '#8B7CF6'),
  makeSkeletonStock('TECO2', 'Telecom Argentina', 'Telecom', 'Líder', '#4BA3FF', 'TEO', 5),
  makeSkeletonStock('COME', 'Sociedad Comercial del Plata', 'Materiales', 'Líder', '#E5558F'),
  makeSkeletonStock('BYMA', 'Bolsas y Mercados Argentinos', 'Bancos', 'Líder', '#5B8CFF'),
  makeSkeletonStock('VALO', 'Banco de Valores', 'Bancos', 'Líder', '#2EDC7E'),
];

export const AR_GENERAL_PANEL_STOCKS: StockRow[] = [
  makeSkeletonStock('BPAT', 'Banco Patagonia', 'Bancos', 'General', '#4BA3FF'),
  makeSkeletonStock('CGPA2', 'Camuzzi Gas Pampeana', 'Reguladas', 'General', '#34D3C7'),
  makeSkeletonStock('DGCU2', 'Distribuidora de Gas Cuyana', 'Reguladas', 'General', '#5B8CFF'),
  makeSkeletonStock('AUSO', 'Autopistas del Sol', 'Reguladas', 'General', '#F5B544'),
  makeSkeletonStock('BHIP', 'Banco Hipotecario', 'Bancos', 'General', '#E5558F'),
  makeSkeletonStock('SEMI', 'Molinos Juan Semino', 'Agro', 'General', '#2EDC7E'),
  makeSkeletonStock('MOLI', 'Molinos Río de la Plata', 'Agro', 'General', '#8B7CF6'),
  makeSkeletonStock('LEDE', 'Ledesma S.A.', 'Agro', 'General', '#34D3C7'),
  makeSkeletonStock('GCLA', 'Grupo Clarín', 'Telecom', 'General', '#5B8CFF'),
  makeSkeletonStock('BOLT', 'Boldt S.A.', 'Telecom', 'General', '#4BA3FF'),
  makeSkeletonStock('INVJ', 'Inversora Juramento', 'Agro', 'General', '#F5B544'),
  makeSkeletonStock('OEST', 'Grupo Concesionario del Oeste', 'Reguladas', 'General', '#2EDC7E'),
];

export interface BondRow {
  ticker: string;
  name: string;
  tranche: 'Tramo corto (2026–2030)' | 'Tramo largo (2035–2046)' | 'LECAC / Letras Tasa Fija' | 'CER / Ajustables por inflación';
  law: 'Ley AR' | 'Ley NY';
  currency: 'ARS' | 'USD MEP' | 'USD CCL';
  price: number;
  deltaPct: number;
  tir: number; // % anual
  tirDeltaPb: number;
  parity: number; // %
  modDuration: number; // años
  volumeM: number;
  volMultiple: number;
  signal: string;
}

const makeSkeletonBond = (
  ticker: string,
  name: string,
  tranche: BondRow['tranche'],
  law: BondRow['law'],
  currency: BondRow['currency']
): BondRow => ({
  ticker,
  name,
  tranche,
  law,
  currency,
  price: Number.NaN,
  deltaPct: Number.NaN,
  tir: Number.NaN,
  tirDeltaPb: Number.NaN,
  parity: Number.NaN,
  modDuration: Number.NaN,
  volumeM: Number.NaN,
  volMultiple: Number.NaN,
  signal: '—',
});

export const BONDS_DATA: BondRow[] = [
  makeSkeletonBond('AL29', 'Bonar 2029 Step-Up', 'Tramo corto (2026–2030)', 'Ley AR', 'USD MEP'),
  makeSkeletonBond('AL30', 'Bonar 2030 Step-Up', 'Tramo corto (2026–2030)', 'Ley AR', 'USD MEP'),
  makeSkeletonBond('GD30', 'Global 2030 Step-Up', 'Tramo corto (2026–2030)', 'Ley NY', 'USD MEP'),
  makeSkeletonBond('AL35', 'Bonar 2035 Step-Up', 'Tramo largo (2035–2046)', 'Ley AR', 'USD MEP'),
  makeSkeletonBond('GD35', 'Global 2035 Step-Up', 'Tramo largo (2035–2046)', 'Ley NY', 'USD MEP'),
  makeSkeletonBond('AE38', 'Bonar 2038 Step-Up', 'Tramo largo (2035–2046)', 'Ley AR', 'USD MEP'),
  makeSkeletonBond('GD38', 'Global 2038 Step-Up', 'Tramo largo (2035–2046)', 'Ley NY', 'USD MEP'),
  makeSkeletonBond('AL41', 'Bonar 2041 Step-Up', 'Tramo largo (2035–2046)', 'Ley AR', 'USD MEP'),
  makeSkeletonBond('GD41', 'Global 2041 Step-Up', 'Tramo largo (2035–2046)', 'Ley NY', 'USD MEP'),
];

export interface OptionChainRow {
  strike: number;
  distancePct: number;
  inOneSigma: boolean;
  callTicker: string;
  callBid: number;
  callAsk: number;
  callLast: number;
  callDeltaPct: number;
  callIV: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  callTimeValue: number;
  callTimeValuePct: number;
  callValRank: 'barata' | 'rango' | 'cara';
  callVolumeLots: number;
  callOpenInterest: number;
  putTicker: string;
  putBid: number;
  putAsk: number;
  putLast: number;
  putDeltaPct: number;
  putIV: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
  putTimeValue: number;
  putTimeValuePct: number;
  putValRank: 'barata' | 'rango' | 'cara';
  putVolumeLots: number;
  putOpenInterest: number;
}

export interface OptionExpiryGroup {
  id: string;
  label: string;
  expiryDate: string;
  daysToExpiry: number;
  callSharePct: number;
  putSharePct: number;
  totalVolumeM: number;
  atmIV: number;
  syntheticRateTNA: number;
  oneSigmaLow: number;
  oneSigmaHigh: number;
  rows: OptionChainRow[];
}

export const GGAL_OPTION_EXPIRIES: OptionExpiryGroup[] = [];

export interface OptionStrategyCard {
  id: string;
  name: string;
  bias: 'Alcista' | 'Bajista' | 'Neutral / Rango' | 'Volatilidad';
  legs: string[];
  netCost: number;
  maxProfit: string;
  maxLoss: string;
  breakeven: string;
  probProfitPct: number;
  returnOnRiskPct: number;
  rationale: string;
  payoffPoints: { spot: number; pnl: number }[];
}

export const SUGGESTED_STRATEGIES: OptionStrategyCard[] = [];

export interface MacroCardItem {
  id: string;
  theme: 'Dólar y Brecha' | 'Actividad e Inflación' | 'Cuentas Públicas y Monetarias' | 'Sector Externo y Afuera';
  title: string;
  value: string;
  deltaLabel: string;
  isPositiveGood: boolean;
  deltaPositive: boolean;
  context: string;
  sparkline: number[];
  unit: string;
  formulaHelp: string;
}

export const MACRO_CARDS: MacroCardItem[] = [
  {
    id: 'brecha-ccl',
    theme: 'Dólar y Brecha',
    title: 'Brecha CCL vs. Mayorista A3500',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: false,
    deltaPositive: false,
    context: 'Calculado sobre CCL mediano y BCRA Com. A3500.',
    sparkline: [],
    unit: '%',
    formulaHelp: '(CCL implícito / Dólar Mayorista Com. A3500 − 1) × 100.',
  },
  {
    id: 'canje-ccl-mep',
    theme: 'Dólar y Brecha',
    title: 'Canje CCL / MEP (Cable)',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: true,
    deltaPositive: false,
    context: 'Diferencial entre Dólar CCL y Dólar MEP.',
    sparkline: [],
    unit: '%',
    formulaHelp: '(CCL / MEP − 1) × 100.',
  },
  {
    id: 'inflacion-mensual',
    theme: 'Actividad e Inflación',
    title: 'Inflación Mensual (IPC)',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: false,
    deltaPositive: false,
    context: 'Fuente: ArgentinaDatos / INDEC.',
    sparkline: [],
    unit: '%',
    formulaHelp: 'Variación mensual del IPC Nivel General.',
  },
  {
    id: 'tasa-badlar',
    theme: 'Cuentas Públicas y Monetarias',
    title: 'Tasa BADLAR Privada (TNA)',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: true,
    deltaPositive: false,
    context: 'Fuente: BCRA Estadísticas Monetarias v4.0.',
    sparkline: [],
    unit: '%',
    formulaHelp: 'Tasa de interés promedio plazos fijos >$1M bancos privados.',
  },
  {
    id: 'reservas-bcra',
    theme: 'Sector Externo y Afuera',
    title: 'Reservas Internacionales BCRA',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Stock bruto en millones de USD (BCRA v4.0).',
    sparkline: [],
    unit: 'US$ M',
    formulaHelp: 'Reservas Internacionales brutas informadas por el BCRA.',
  },
  {
    id: 'riesgo-pais',
    theme: 'Sector Externo y Afuera',
    title: 'Riesgo País (EMBI+ Argentina)',
    value: '—',
    deltaLabel: '—',
    isPositiveGood: false,
    deltaPositive: true,
    context: 'Fuente: ArgentinaDatos.',
    sparkline: [],
    unit: 'pb',
    formulaHelp: 'Sobretasa promedio soberanos argentinos sobre US Treasuries.',
  },
];

export interface USStockItem {
  ticker: string;
  name: string;
  sector:
    | 'Mega Caps / Tech'
    | 'Finanzas'
    | 'Consumo'
    | 'Energía'
    | 'Salud'
    | 'Industrial'
    | 'Índices / ETF';
  color: string;
  price: number;
  deltaPct: number;
  low: number;
  high: number;
  volMultiple: number;
  cedearRatio: string;
  cedearRatioNum: number;
  cedearArsPrice: number;
  cclImplicit: number;
  iv30d: number;
  signal: string;
}

const makeSkeletonUsStock = (
  ticker: string,
  name: string,
  sector: USStockItem['sector'],
  color: string,
  cedearRatioNum: number
): USStockItem => ({
  ticker,
  name,
  sector,
  color,
  price: Number.NaN,
  deltaPct: Number.NaN,
  low: Number.NaN,
  high: Number.NaN,
  volMultiple: Number.NaN,
  cedearRatio: `${cedearRatioNum}:1`,
  cedearRatioNum,
  cedearArsPrice: Number.NaN,
  cclImplicit: Number.NaN,
  iv30d: Number.NaN,
  signal: '—',
});

export const US_MARKET_DATA: USStockItem[] = [
  makeSkeletonUsStock('NVDA', 'NVIDIA Corporation', 'Mega Caps / Tech', '#10B981', 24),
  makeSkeletonUsStock('AAPL', 'Apple Inc.', 'Mega Caps / Tech', '#64748B', 20),
  makeSkeletonUsStock('MSFT', 'Microsoft Corporation', 'Mega Caps / Tech', '#0EA5E9', 30),
  makeSkeletonUsStock('AMZN', 'Amazon.com Inc.', 'Mega Caps / Tech', '#F59E0B', 144),
  makeSkeletonUsStock('GOOGL', 'Alphabet Inc. Class A', 'Mega Caps / Tech', '#3B82F6', 58),
  makeSkeletonUsStock('META', 'Meta Platforms Inc.', 'Mega Caps / Tech', '#2563EB', 24),
  makeSkeletonUsStock('TSLA', 'Tesla Inc.', 'Mega Caps / Tech', '#EF4444', 15),
  makeSkeletonUsStock('AMD', 'Advanced Micro Devices', 'Mega Caps / Tech', '#14B8A6', 10),
  makeSkeletonUsStock('JPM', 'JPMorgan Chase & Co.', 'Finanzas', '#1D4ED8', 15),
  makeSkeletonUsStock('BAC', 'Bank of America Corp.', 'Finanzas', '#2563EB', 4),
  makeSkeletonUsStock('BRK.B', 'Berkshire Hathaway', 'Finanzas', '#6366F1', 22),
  makeSkeletonUsStock('MELI', 'MercadoLibre Inc.', 'Consumo', '#FACC15', 120),
  makeSkeletonUsStock('KO', 'Coca-Cola Co.', 'Consumo', '#EF4444', 5),
  makeSkeletonUsStock('WMT', 'Walmart Inc.', 'Consumo', '#2563EB', 18),
  makeSkeletonUsStock('XOM', 'Exxon Mobil Corp.', 'Energía', '#DC2626', 10),
  makeSkeletonUsStock('SLB', 'SLB (Schlumberger)', 'Energía', '#0284C7', 3),
  makeSkeletonUsStock('SPY', 'SPDR S&P 500 ETF', 'Índices / ETF', '#8B7CF6', 20),
  makeSkeletonUsStock('QQQ', 'Invesco QQQ Trust', 'Índices / ETF', '#06B6D4', 20),
  makeSkeletonUsStock('IWM', 'iShares Russell 2000', 'Índices / ETF', '#F59E0B', 10),
  makeSkeletonUsStock('EWZ', 'iShares MSCI Brazil', 'Índices / ETF', '#10B981', 2),
  makeSkeletonUsStock('XLE', 'Energy Select Sector SPDR', 'Índices / ETF', '#EA580C', 2),
  makeSkeletonUsStock('XLF', 'Financial Select Sector SPDR', 'Índices / ETF', '#3B82F6', 2),
];

export interface FutureContractRow {
  contract: string;
  maturity: string;
  days: number;
  price: number;
  deltaPct: number;
  implicitDevalPct: number;
  tnaImplicit: number;
  teaImplicit: number;
  openInterestM: number;
  volumeM: number;
  lecapRefTicker: string;
  lecapTna: number;
  syntheticUsdRatePct: number;
}

export const ROFEX_FUTURES: FutureContractRow[] = [];

export interface CaucionRow {
  termDays: number;
  currency: 'ARS' | 'USD';
  tnaWeighted: number;
  teaEffective: number;
  minTna: number;
  maxTna: number;
  bidTna: number;
  askTna: number;
  volumeM: number;
  shareOfTotalPct: number;
}

export const CAUCIONES_DATA: CaucionRow[] = [];

export interface RatioArbitragePair {
  id: string;
  pairTitle: string;
  legA: string;
  legB: string;
  category:
    | 'Rotación Sectorial'
    | 'Liquidez y Crédito'
    | 'Legislación Bonos'
    | 'Bancos Relativo'
    | 'Energía Relativo'
    | 'Índices en USD';
  categoryLabel: string;
  categoryGroup: 'ROTACION_SECTORIAL' | 'LIQUIDEZ_CREDITO';
  source: 'MASSIVE_1D' | 'DATA912' | 'MIXED_USD_CCL';
  currentRatio: number;
  unit: string;
  mean90d: number;
  stdDev90d: number;
  zScore: number;
  percentile90d: number;
  halfLifeDays: number;
  capitalFlowDeltaPct: number;
  opportunityBadge: 'EXTREMO COMPRA' | 'EXTREMO VENTA' | 'DESVÍO MODERADO' | 'EN EQUILIBRIO' | null;
  observationCount: number;
  sparkline: number[];
  signal: string;
  recommendation: string;
  history: number[];
}

export interface RelationsSummaryState {
  extremeTwoSigmaCount: number;
  moderateDeviationCount: number;
  topCapitalFlowPairId: string | null;
  topCapitalFlowSector: string | null;
  topCapitalFlowDeltaPct: number;
}

export const RATIO_PAIRS: RatioArbitragePair[] = [];

export const RELATION_SUMMARY: RelationsSummaryState = {
  extremeTwoSigmaCount: 0,
  moderateDeviationCount: 0,
  topCapitalFlowPairId: null,
  topCapitalFlowSector: null,
  topCapitalFlowDeltaPct: Number.NaN,
};

export interface PortfolioPosition {
  id: string;
  ticker: string;
  instrumentType: 'Acción' | 'Opción Call' | 'Opción Put' | 'Bono Soberano' | 'LECAP';
  qty: number;
  avgPrice: number;
  lastPrice: number;
  marketValueArs: number;
  pnlDayArs: number;
  pnlDayPct: number;
  pnlTotalArs: number;
  pnlTotalPct: number;
  deltaEqArs: number;
  thetaDayArs: number;
}

export const INITIAL_POSITIONS: PortfolioPosition[] = [];

export interface AlertItem {
  id: string;
  ticker: string;
  condition: string;
  target: string;
  currentValue: string;
  status: 'Disparada' | 'Activa' | 'Pausada';
  triggeredAt?: string;
  priority: 'Alta' | 'Media' | 'Info';
}

export const INITIAL_ALERTS: AlertItem[] = [];

/* ============================================================================
   HIDRATADORES EN VIVO DESDE ENDPOINTS REALES (/api/ar/* y /api/snapshot)
   ============================================================================ */
function mapArSector(sector: ArStockDto['sector']): StockRow['sector'] {
  if (sector === 'CEDEAR') return 'Materiales';
  return sector;
}

function dtoToStockRow(dto: ArStockDto): StockRow {
  return {
    ticker: dto.ticker,
    name: dto.name,
    sector: mapArSector(dto.sector),
    panel: dto.panel === 'General' ? 'General' : 'Líder',
    color: dto.color || '#8B7CF6',
    last: toNumOrNaN(dto.last),
    bid: toNumOrNaN(dto.bid),
    ask: toNumOrNaN(dto.ask),
    deltaPct: toNumOrNaN(dto.deltaPct),
    prevClose: toNumOrNaN(dto.prevClose),
    low: toNumOrNaN(dto.low),
    high: toNumOrNaN(dto.high),
    vwap: toNumOrNaN(dto.vwap),
    volumeM: toNumOrNaN(dto.volumeM),
    volMultiple: toNumOrNaN(dto.volMultiple),
    signalText: dto.signalText || '—',
    ...(dto.adrTicker !== undefined ? { adrTicker: dto.adrTicker } : {}),
    ...(dto.adrRatio !== undefined ? { adrRatio: dto.adrRatio } : {}),
    adrPrice: toNumOrNaN(dto.adrPrice),
    adrDeltaPct: toNumOrNaN(dto.adrDeltaPct),
    cclImplicit: toNumOrNaN(dto.cclImplicit),
    iv30d: toNumOrNaN(dto.iv30d),
    ...(dto.ivRank !== undefined ? { ivRank: dto.ivRank } : {}),
    ...(dto.ivPercentile !== null && dto.ivPercentile !== undefined ? { ivPercentile: dto.ivPercentile } : {}),
    sparkline: Array.isArray(dto.sparkline) ? dto.sparkline.filter((v) => Number.isFinite(v)) : [],
  };
}

function mapBondDtoToRow(b: ArBondDto): BondRow {
  const yearMatch = b.ticker.match(/\d{2}$/);
  const yr = yearMatch ? Number(yearMatch[0]) : 35;
  const tranche: BondRow['tranche'] =
    b.currency === 'CER'
      ? 'CER / Ajustables por inflación'
      : b.currency === 'ARS'
      ? 'LECAC / Letras Tasa Fija'
      : yr <= 30
      ? 'Tramo corto (2026–2030)'
      : 'Tramo largo (2035–2046)';

  return {
    ticker: b.ticker,
    name: b.name,
    tranche,
    law: b.legislation === 'NY' ? 'Ley NY' : 'Ley AR',
    currency: b.currency === 'ARS' ? 'ARS' : b.ticker.endsWith('C') ? 'USD CCL' : 'USD MEP',
    price: toNumOrNaN(b.currency === 'ARS' ? b.priceArs : (b.priceUsd ?? b.priceArs)),
    deltaPct: toNumOrNaN(b.deltaPct),
    tir: toNumOrNaN(b.tirPct),
    tirDeltaPb: Number.NaN,
    parity: toNumOrNaN(b.parityPct),
    modDuration: toNumOrNaN(b.duration),
    volumeM: toNumOrNaN(b.volumeM),
    volMultiple: Number.NaN,
    signal: b.source || '—',
  };
}

function mapNoteDtoToBondRow(n: ArNoteOrCorpDto): BondRow {
  return {
    ticker: n.ticker,
    name: n.name,
    tranche: 'LECAC / Letras Tasa Fija',
    law: 'Ley AR',
    currency: 'ARS',
    price: toNumOrNaN(n.price),
    deltaPct: toNumOrNaN(n.deltaPct),
    tir: Number.NaN,
    tirDeltaPb: Number.NaN,
    parity: Number.NaN,
    modDuration: Number.NaN,
    volumeM: toNumOrNaN(n.volumeM),
    volMultiple: Number.NaN,
    signal: n.source || 'DATA912',
  };
}

export function hydrateFromArOverview(overview: ArOverviewResponse): void {
  if (overview.globalIndicators.length > 0) {
    for (const gi of overview.globalIndicators) {
      const target = GLOBAL_INDICATORS.find((item) => item.id === gi.id);
      if (target) {
        target.label = gi.label;
        target.value = toNumOrNaN(gi.value);
        target.deltaPct = toNumOrNaN(gi.deltaPct);
        target.decimals = gi.decimals;
        if (gi.prefix !== undefined) target.prefix = gi.prefix;
        if (gi.suffix !== undefined) target.suffix = gi.suffix;
        target.help = gi.help;
      } else {
        GLOBAL_INDICATORS.push({
          id: gi.id,
          label: gi.label,
          value: toNumOrNaN(gi.value),
          decimals: gi.decimals,
          ...(gi.prefix !== undefined ? { prefix: gi.prefix } : {}),
          ...(gi.suffix !== undefined ? { suffix: gi.suffix } : {}),
          deltaPct: toNumOrNaN(gi.deltaPct),
          help: gi.help,
        });
      }
    }
  }

  if (overview.mervalStocks.length > 0) {
    const mapped = overview.mervalStocks.map(dtoToStockRow);
    AR_STOCKS.splice(0, AR_STOCKS.length, ...mapped);
  }
  if (overview.generalPanelStocks.length > 0) {
    const mappedGen = overview.generalPanelStocks.map(dtoToStockRow);
    AR_GENERAL_PANEL_STOCKS.splice(0, AR_GENERAL_PANEL_STOCKS.length, ...mappedGen);
  }

  for (const ced of overview.cedears) {
    const existing = US_MARKET_DATA.find(
      (u) =>
        u.ticker === ced.ticker ||
        u.ticker.replace('.', '') === ced.ticker ||
        (ced.adrTicker !== undefined && u.ticker === ced.adrTicker.replace(' US', '')),
    );
    if (existing) {
      if (ced.last !== null && Number.isFinite(ced.last)) {
        existing.cedearArsPrice = ced.last;
      }
      if (
        !Number.isFinite(existing.price) &&
        ced.adrPrice !== null &&
        ced.adrPrice !== undefined &&
        Number.isFinite(ced.adrPrice)
      ) {
        existing.price = ced.adrPrice;
      }
      const nextDelta =
        ced.adrDeltaPct !== null && ced.adrDeltaPct !== undefined && Number.isFinite(ced.adrDeltaPct)
          ? ced.adrDeltaPct
          : ced.deltaPct;
      if (nextDelta !== null && Number.isFinite(nextDelta) && !Number.isFinite(existing.deltaPct)) {
        existing.deltaPct = nextDelta;
      }
      if (
        Number.isFinite(existing.price) &&
        existing.price > 0 &&
        Number.isFinite(existing.cedearArsPrice) &&
        existing.cedearArsPrice > 0 &&
        existing.cedearRatioNum > 0
      ) {
        existing.cclImplicit = Number(
          ((existing.cedearArsPrice * existing.cedearRatioNum) / existing.price).toFixed(2),
        );
      } else if (
        ced.cclImplicit !== null &&
        ced.cclImplicit !== undefined &&
        Number.isFinite(ced.cclImplicit)
      ) {
        existing.cclImplicit = ced.cclImplicit;
      }
      if (ced.signalText && existing.signal === '—') {
        existing.signal = ced.signalText;
      }
    }
  }
}

export function hydrateFromArMacro(macro: ArMacroResponse): void {
  if (macro.cards.length > 0) {
    const mappedCards: MacroCardItem[] = macro.cards.map((c) => {
      const id = c.id.toLowerCase();
      const theme: MacroCardItem['theme'] =
        id.includes('brecha') || id.includes('canje') || id.includes('mep') || id.includes('ccl') || id.includes('a3500') || id.includes('blue')
          ? 'Dólar y Brecha'
          : id.includes('inflacion') || id.includes('ipc') || id.includes('cer') || id.includes('uva')
          ? 'Actividad e Inflación'
          : id.includes('reservas') || id.includes('riesgo')
          ? 'Sector Externo y Afuera'
          : 'Cuentas Públicas y Monetarias';

      return {
        id: c.id,
        theme,
        title: c.label,
        value: c.value || '—',
        deltaLabel: c.delta || (c.updatedAt ? `Act: ${c.updatedAt.slice(0, 10)}` : '—'),
        isPositiveGood: !id.includes('inflacion') && !id.includes('riesgo') && !id.includes('brecha'),
        deltaPositive: c.deltaPct !== null ? c.deltaPct >= 0 : true,
        context: `${c.source}${c.updatedAt ? ` · ${c.updatedAt.slice(0, 10)}` : ''}`,
        sparkline: [],
        unit: '',
        formulaHelp: c.help,
      };
    });
    MACRO_CARDS.splice(0, MACRO_CARDS.length, ...mappedCards);
  }

  const badlar = GLOBAL_INDICATORS.find((g) => g.id === 'caucion');
  if (badlar && macro.variables.badlarTna !== null && Number.isFinite(macro.variables.badlarTna)) {
    badlar.label = 'BADLAR TNA';
    badlar.value = macro.variables.badlarTna;
  }
  const embi = GLOBAL_INDICATORS.find((g) => g.id === 'embi');
  if (embi && macro.variables.riesgoPaisPb !== null && Number.isFinite(macro.variables.riesgoPaisPb)) {
    embi.value = macro.variables.riesgoPaisPb;
  }

  if (macro.sovereignCurve.length > 0) {
    const existingNotes = BONDS_DATA.filter((b) => b.tranche === 'LECAC / Letras Tasa Fija');
    BONDS_DATA.splice(
      0,
      BONDS_DATA.length,
      ...macro.sovereignCurve.map(mapBondDtoToRow),
      ...existingNotes,
    );
  }
}

export function hydrateFromArMonitoring(mon: ArMonitoringResponse): void {
  if (mon.stocks.length > 0) {
    AR_STOCKS.splice(0, AR_STOCKS.length, ...mon.stocks.map(dtoToStockRow));
  }
  if (mon.generalPanel.length > 0) {
    AR_GENERAL_PANEL_STOCKS.splice(0, AR_GENERAL_PANEL_STOCKS.length, ...mon.generalPanel.map(dtoToStockRow));
  }
  const combinedBonds: BondRow[] = [
    ...mon.bonds.map(mapBondDtoToRow),
    ...mon.notes.slice(0, 20).map(mapNoteDtoToBondRow),
  ];
  if (combinedBonds.length > 0) {
    BONDS_DATA.splice(0, BONDS_DATA.length, ...combinedBonds);
  }
}

export function hydrateFromArOptions(res: ArOptionsResponse): void {
  const spot = res.spot !== null && Number.isFinite(res.spot) ? res.spot : Number.NaN;
  const groups: OptionExpiryGroup[] = res.expiries.map((exp) => {
    const callByStrike = new Map<number, ArOptionContractDto>();
    const putByStrike = new Map<number, ArOptionContractDto>();
    for (const c of exp.calls) callByStrike.set(c.strike, c);
    for (const p of exp.puts) putByStrike.set(p.strike, p);

    const atmIvDec = exp.ivAtm !== null && Number.isFinite(exp.ivAtm) ? exp.ivAtm : Number.NaN;
    const sigmaBandAbs =
      Number.isFinite(spot) && Number.isFinite(atmIvDec)
        ? spot * atmIvDec * Math.sqrt(Math.max(exp.days, 1) / 365)
        : Number.NaN;
    const oneSigmaLow = Number.isFinite(sigmaBandAbs) ? Math.round(spot - sigmaBandAbs) : Number.NaN;
    const oneSigmaHigh = Number.isFinite(sigmaBandAbs) ? Math.round(spot + sigmaBandAbs) : Number.NaN;

    let callVolTotal = 0;
    let putVolTotal = 0;
    let totalNotionalArs = 0;

    const rows: OptionChainRow[] = exp.strikes.map((strike) => {
      const c = callByStrike.get(strike);
      const p = putByStrike.get(strike);
      const cLast = toNumOrNaN(c?.last ?? c?.mark);
      const pLast = toNumOrNaN(p?.last ?? p?.mark);
      const cVol = toNumOrNaN(c?.volume);
      const pVol = toNumOrNaN(p?.volume);
      if (Number.isFinite(cVol)) {
        callVolTotal += cVol;
        if (Number.isFinite(cLast)) totalNotionalArs += cVol * res.lotSize * cLast;
      }
      if (Number.isFinite(pVol)) {
        putVolTotal += pVol;
        if (Number.isFinite(pLast)) totalNotionalArs += pVol * res.lotSize * pLast;
      }

      const cIvPct = c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) ? c.iv * 100 : Number.NaN;
      const pIvPct = p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) ? p.iv * 100 : Number.NaN;
      const cRank: 'barata' | 'rango' | 'cara' =
        Number.isFinite(cIvPct) && Number.isFinite(atmIvDec)
          ? cIvPct < atmIvDec * 100 - 3
            ? 'barata'
            : cIvPct > atmIvDec * 100 + 3
            ? 'cara'
            : 'rango'
          : 'rango';
      const pRank: 'barata' | 'rango' | 'cara' =
        Number.isFinite(pIvPct) && Number.isFinite(atmIvDec)
          ? pIvPct < atmIvDec * 100 - 3
            ? 'barata'
            : pIvPct > atmIvDec * 100 + 3
            ? 'cara'
            : 'rango'
          : 'rango';

      const distancePct = Number.isFinite(spot) && spot > 0 ? ((strike - spot) / spot) * 100 : Number.NaN;
      const inOneSigma =
        Number.isFinite(oneSigmaLow) && Number.isFinite(oneSigmaHigh)
          ? strike >= oneSigmaLow && strike <= oneSigmaHigh
          : false;

      const cExtrinsic = toNumOrNaN(c?.extrinsic);
      const pExtrinsic = toNumOrNaN(p?.extrinsic);

      return {
        strike,
        distancePct,
        inOneSigma,
        callTicker: c?.symbol ?? `${res.underlying.slice(0, 3)}C${strike}${exp.expiryCode}`,
        callBid: toNumOrNaN(c?.bid),
        callAsk: toNumOrNaN(c?.ask),
        callLast: cLast,
        callDeltaPct: Number.NaN,
        callIV: cIvPct,
        callDelta: toNumOrNaN(c?.delta),
        callGamma: toNumOrNaN(c?.gamma),
        callTheta: toNumOrNaN(c?.thetaDaily),
        callVega: toNumOrNaN(c?.vegaPer1Pct),
        callTimeValue: cExtrinsic,
        callTimeValuePct:
          Number.isFinite(cExtrinsic) && Number.isFinite(spot) && spot > 0 ? (cExtrinsic / spot) * 100 : Number.NaN,
        callValRank: cRank,
        callVolumeLots: cVol,
        callOpenInterest: toNumOrNaN(c?.openInterest),
        putTicker: p?.symbol ?? `${res.underlying.slice(0, 3)}V${strike}${exp.expiryCode}`,
        putBid: toNumOrNaN(p?.bid),
        putAsk: toNumOrNaN(p?.ask),
        putLast: pLast,
        putDeltaPct: Number.NaN,
        putIV: pIvPct,
        putDelta: toNumOrNaN(p?.delta),
        putGamma: toNumOrNaN(p?.gamma),
        putTheta: toNumOrNaN(p?.thetaDaily),
        putVega: toNumOrNaN(p?.vegaPer1Pct),
        putTimeValue: pExtrinsic,
        putTimeValuePct:
          Number.isFinite(pExtrinsic) && Number.isFinite(spot) && spot > 0 ? (pExtrinsic / spot) * 100 : Number.NaN,
        putValRank: pRank,
        putVolumeLots: pVol,
        putOpenInterest: toNumOrNaN(p?.openInterest),
      };
    });

    const totalLots = callVolTotal + putVolTotal;
    const callSharePct = totalLots > 0 ? Math.round((callVolTotal / totalLots) * 100) : 50;
    const putSharePct = totalLots > 0 ? 100 - callSharePct : 50;

    return {
      id: exp.expiryCode,
      label: exp.expiryLabel,
      expiryDate: exp.expirationDate,
      daysToExpiry: exp.days,
      callSharePct,
      putSharePct,
      totalVolumeM: totalNotionalArs > 0 ? totalNotionalArs / 1_000_000 : Number.NaN,
      atmIV: Number.isFinite(atmIvDec) ? atmIvDec * 100 : Number.NaN,
      syntheticRateTNA: toNumOrNaN(res.rateTna),
      oneSigmaLow,
      oneSigmaHigh,
      rows,
    };
  });

  GGAL_OPTION_EXPIRIES.splice(0, GGAL_OPTION_EXPIRIES.length, ...groups);
}

export function hydrateFromArRelations(rel: ArRelationsResponse): void {
  const sourcePairs =
    rel.relationPairs && rel.relationPairs.length > 0
      ? rel.relationPairs
      : rel.extendedPairs && rel.extendedPairs.length > 0
      ? rel.extendedPairs
      : rel.pairs;

  const mapped: RatioArbitragePair[] = sourcePairs.map((p) => {
    const lower = p.id.toLowerCase();
    const isLiquidity =
      p.categoryGroup === 'LIQUIDEZ_CREDITO' ||
      lower.includes('gd30') ||
      lower.includes('gd35') ||
      lower.includes('al30') ||
      lower.includes('hyg') ||
      lower.includes('lqd') ||
      lower.includes('gld') ||
      lower.includes('ccl') ||
      lower.includes('mep');

    const categoryGroup: 'ROTACION_SECTORIAL' | 'LIQUIDEZ_CREDITO' = isLiquidity
      ? 'LIQUIDEZ_CREDITO'
      : 'ROTACION_SECTORIAL';

    const categoryLabel =
      p.category && p.category.trim() !== ''
        ? p.category
        : lower === 'qqq-spy' || lower === 'spy-qqq'
        ? 'ROTACIÓN US · TECH'
        : lower.includes('gd30') || lower.includes('gd35') || lower.includes('al30')
        ? 'LEGISLACIÓN & SOBERANOS'
        : lower.includes('ccl') || lower.includes('mep')
        ? 'CANJE & LIQUIDEZ FX'
        : lower.includes('hyg') || lower.includes('lqd') || lower.includes('gld')
        ? 'LIQUIDEZ & CRÉDITO US'
        : lower.includes('ypf') || lower.includes('pamp')
        ? 'ROTACIÓN ENERGÍA'
        : 'ROTACIÓN SECTORIAL';

    const category: RatioArbitragePair['category'] =
      categoryGroup === 'LIQUIDEZ_CREDITO'
        ? lower.includes('gd30') || lower.includes('al30')
          ? 'Legislación Bonos'
          : 'Liquidez y Crédito'
        : lower.includes('ypf') || lower.includes('pamp')
        ? 'Energía Relativo'
        : lower.includes('bma') || lower.includes('supv') || lower.includes('ewz')
        ? 'Bancos Relativo'
        : 'Rotación Sectorial';

    const cur = toNumOrNaN(p.currentValue);
    const z = toNumOrNaN(p.zScore);
    const badge =
      p.opportunityBadge !== undefined
        ? p.opportunityBadge
        : Number.isFinite(z)
        ? z <= -2.0
          ? 'EXTREMO COMPRA'
          : z >= 2.0
          ? 'EXTREMO VENTA'
          : Math.abs(z) >= 1.5
          ? 'DESVÍO MODERADO'
          : 'EN EQUILIBRIO'
        : null;

    const spark =
      p.sparkline && p.sparkline.length > 0
        ? p.sparkline.filter((v) => Number.isFinite(v))
        : p.history
            .map((h) => h.ratio)
            .filter((v) => Number.isFinite(v))
            .slice(-30);

    const recommendation = Number.isFinite(z)
      ? Math.abs(z) >= 1.5
        ? `Desvío estadístico de ${fmtNum(z, 2)}σ (${p.signal}) respecto a su media de 60 ruedas.`
        : `Relación en equilibrio (${p.signal}) alrededor de ${fmtNum(p.mean60d, 2)} ${p.unit}.`
      : p.signal;

    return {
      id: p.id,
      pairTitle: p.name,
      legA: p.legA,
      legB: p.legB,
      category,
      categoryLabel,
      categoryGroup,
      source: p.source ?? 'DATA912',
      currentRatio: cur,
      unit: p.unit,
      mean90d: toNumOrNaN(p.mean60d),
      stdDev90d: toNumOrNaN(p.std60d),
      zScore: z,
      percentile90d: toNumOrNaN(p.percentile60d),
      halfLifeDays: toNumOrNaN(p.halfLifeDays),
      capitalFlowDeltaPct: toNumOrNaN(p.capitalFlowDeltaPct),
      opportunityBadge: badge,
      observationCount: p.observationCount ?? p.history.length,
      sparkline: spark,
      signal: p.signal,
      recommendation,
      history: p.history.map((h) => h.ratio).filter((v) => Number.isFinite(v)),
    };
  });

  RATIO_PAIRS.splice(0, RATIO_PAIRS.length, ...mapped);

  if (rel.relationSummary) {
    RELATION_SUMMARY.extremeTwoSigmaCount = rel.relationSummary.extremeTwoSigmaCount;
    RELATION_SUMMARY.moderateDeviationCount = rel.relationSummary.moderateDeviationCount;
    RELATION_SUMMARY.topCapitalFlowPairId = rel.relationSummary.topCapitalFlowPairId;
    RELATION_SUMMARY.topCapitalFlowSector = rel.relationSummary.topCapitalFlowSector;
    RELATION_SUMMARY.topCapitalFlowDeltaPct = toNumOrNaN(rel.relationSummary.topCapitalFlowDeltaPct);
  } else {
    RELATION_SUMMARY.extremeTwoSigmaCount = mapped.filter(
      (m) => Number.isFinite(m.zScore) && Math.abs(m.zScore) >= 2.0,
    ).length;
    RELATION_SUMMARY.moderateDeviationCount = mapped.filter(
      (m) => Number.isFinite(m.zScore) && Math.abs(m.zScore) >= 1.5 && Math.abs(m.zScore) < 2.0,
    ).length;
    let best: RatioArbitragePair | null = null;
    for (const m of mapped) {
      if (!Number.isFinite(m.capitalFlowDeltaPct)) continue;
      if (best === null || Math.abs(m.capitalFlowDeltaPct) > Math.abs(best.capitalFlowDeltaPct)) {
        best = m;
      }
    }
    RELATION_SUMMARY.topCapitalFlowPairId = best?.id ?? null;
    RELATION_SUMMARY.topCapitalFlowSector =
      best !== null
        ? best.capitalFlowDeltaPct >= 0
          ? `${best.legA} · ${best.categoryLabel}`
          : `${best.legB} · ${best.categoryLabel}`
        : null;
    RELATION_SUMMARY.topCapitalFlowDeltaPct = best !== null ? best.capitalFlowDeltaPct : Number.NaN;
  }
}

export function hydrateFromUsSnapshot(snap: UsSnapshotResponseDto): void {
  const snapMetrics = snap.envelope?.snapshot?.metrics;
  const spot = snapMetrics?.spot ?? snap.envelope?.metrics?.spot?.value ?? null;
  const iv30 =
    snap.volSurfaceSummary?.iv30d ??
    snapMetrics?.iv30d ??
    snap.volSurfaceSummary?.frontSlice?.ivAtm ??
    null;
  const target = US_MARKET_DATA.find((u) => u.ticker === snap.symbol.toUpperCase());
  if (target) {
    if (spot !== null && Number.isFinite(spot)) {
      target.price = spot;
      if (Number.isFinite(target.cedearArsPrice) && spot > 0 && target.cedearRatioNum > 0) {
        target.cclImplicit = (target.cedearArsPrice * target.cedearRatioNum) / spot;
      }
    }
    if (iv30 !== null && Number.isFinite(iv30)) target.iv30d = iv30 * 100;
  }
  if (snap.symbol.toUpperCase() === 'SPY' && spot !== null && Number.isFinite(spot)) {
    const sp = GLOBAL_INDICATORS.find((g) => g.id === 'sp500');
    if (sp) sp.value = spot;
  }
  const vixCtx = snap.marketContext?.vixLevel ?? null;
  if (vixCtx !== null && Number.isFinite(vixCtx)) {
    const vx = GLOBAL_INDICATORS.find((g) => g.id === 'vix');
    if (vx) vx.value = vixCtx;
  }

  for (const q of snap.marketContext?.unifiedQuotes ?? []) {
    const cleanTicker = q.ticker.replace(/^I:/, '');
    if (cleanTicker === 'SPY') {
      const sp = GLOBAL_INDICATORS.find((g) => g.id === 'sp500');
      if (sp) {
        sp.label = 'SPY (NYSE)';
        sp.prefix = '$ ';
        if (q.price !== null && Number.isFinite(q.price)) sp.value = q.price;
        if (q.changePct !== null && Number.isFinite(q.changePct)) sp.deltaPct = q.changePct;
      }
    }
    if (cleanTicker === 'VIX') {
      const vx = GLOBAL_INDICATORS.find((g) => g.id === 'vix');
      if (vx) {
        if (q.price !== null && Number.isFinite(q.price)) vx.value = q.price;
        if (q.changePct !== null && Number.isFinite(q.changePct)) vx.deltaPct = q.changePct;
      }
    }
    const row = US_MARKET_DATA.find((u) => u.ticker === cleanTicker);
    if (row) {
      if (q.price !== null && Number.isFinite(q.price)) row.price = q.price;
      if (q.changePct !== null && Number.isFinite(q.changePct)) row.deltaPct = q.changePct;
      if (Number.isFinite(row.price) && row.price > 0 && Number.isFinite(row.cedearArsPrice)) {
        row.cclImplicit = (row.cedearArsPrice * row.cedearRatioNum) / row.price;
      }
    }
  }
}
