// Utilidades de formato numérico es-AR
export function fmtNum(val: number, decimals = 2): string {
  const fixed = Math.abs(val).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = val < 0 ? '-' : '';
  return decimals > 0 ? `${sign}${withDots},${decPart}` : `${sign}${withDots}`;
}

export function fmtPct(val: number, decimals = 2, plusSign = true): string {
  const sign = val > 0 && plusSign ? '+' : val < 0 ? '−' : '';
  const fixed = Math.abs(val).toFixed(decimals).replace('.', ',');
  return `${sign}${fixed} %`;
}

export function fmtPctTable(val: number, decimals = 2): string {
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  const fixed = Math.abs(val).toFixed(decimals).replace('.', ',');
  return `${sign}${fixed}%`;
}

export function fmtMoneyCompact(valInMillions: number): string {
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
  { id: 'mep', label: 'Dólar MEP', value: 1142.50, decimals: 2, prefix: '$ ', deltaPct: -0.64, help: 'Paridad implícita AL30 / AL30D liquidación T+1.' },
  { id: 'ccl', label: 'Dólar CCL', value: 1168.80, decimals: 2, prefix: '$ ', deltaPct: -0.42, help: 'Contado con Liquidación implícito en canasta de ADRs y GD30C.' },
  { id: 'embi', label: 'Riesgo País', value: 742, decimals: 0, suffix: ' pb', deltaPct: -2.35, help: 'Sobretasa de bonos soberanos argentinos frente al Treasury de EE.UU. (EMBI+ JPM).' },
  { id: 'caucion', label: 'Caución 1d', value: 33.50, decimals: 2, suffix: ' %', deltaPct: 0.45, help: 'Tasa Nominal Anual (TNA) promedio ponderada en BYMA a 1 día hábil.' },
  { id: 'sp500', label: 'S&P 500', value: 5984.20, decimals: 2, deltaPct: 0.78, help: 'Índice S&P 500 contado en tiempo real (CME / NYSE).' },
  { id: 'vix', label: 'VIX', value: 13.85, decimals: 2, deltaPct: -4.15, help: 'Índice CBOE de volatilidad implícita a 30 días del S&P 500.' },
];

export interface StockRow {
  ticker: string;
  name: string;
  sector: 'Bancos' | 'Energía' | 'Reguladas' | 'Materiales' | 'Telecom' | 'Agro';
  panel?: 'Líder' | 'General';
  color: string;
  last: number;
  deltaPct: number;
  prevClose: number;
  low: number;
  high: number;
  vwap: number;
  volumeM: number; // millones ARS
  volMultiple: number; // ej. 2.4x lo habitual
  signalText: string;
  adrTicker?: string;
  adrPrice?: number;
  adrDeltaPct?: number;
  cclImplicit?: number;
  iv30d?: number;
  ivRank?: 'barata' | 'rango' | 'cara';
  ivPercentile?: number;
  sparkline: number[];
}

export const AR_STOCKS: StockRow[] = [
  {
    ticker: 'GGAL',
    name: 'Grupo Financiero Galicia',
    sector: 'Bancos',
    color: '#8B7CF6',
    last: 6480.0,
    deltaPct: 4.18,
    prevClose: 6220.0,
    low: 6210.0,
    high: 6520.0,
    vwap: 6412.5,
    volumeM: 18420,
    volMultiple: 2.4,
    signalText: 'Subió con volumen firme',
    adrTicker: 'GGAL US',
    adrPrice: 55.45,
    adrDeltaPct: 4.62,
    cclImplicit: 1168.6,
    iv30d: 51.4,
    ivRank: 'barata',
    ivPercentile: 22,
    sparkline: [6190, 6230, 6280, 6265, 6340, 6390, 6435, 6410, 6465, 6480],
  },
  {
    ticker: 'YPFD',
    name: 'YPF S.A.',
    sector: 'Energía',
    color: '#4BA3FF',
    last: 42850.0,
    deltaPct: 3.12,
    prevClose: 41553.0,
    low: 41400.0,
    high: 43100.0,
    vwap: 42510.0,
    volumeM: 15940,
    volMultiple: 1.9,
    signalText: 'Ruptura de máximo semanal',
    adrTicker: 'YPF US',
    adrPrice: 36.65,
    adrDeltaPct: 3.55,
    cclImplicit: 1169.2,
    iv30d: 46.8,
    ivRank: 'rango',
    ivPercentile: 48,
    sparkline: [41500, 41700, 41950, 42100, 42050, 42400, 42650, 42700, 42850],
  },
  {
    ticker: 'PAMP',
    name: 'Pampa Energía',
    sector: 'Energía',
    color: '#2EDC7E',
    last: 3690.0,
    deltaPct: 2.35,
    prevClose: 3605.0,
    low: 3590.0,
    high: 3715.0,
    vwap: 3668.0,
    volumeM: 8240,
    volMultiple: 1.5,
    signalText: 'Compra sostenida sobre VWAP',
    adrTicker: 'PAM US',
    adrPrice: 78.90,
    adrDeltaPct: 2.80,
    cclImplicit: 1169.2,
    iv30d: 44.2,
    ivRank: 'barata',
    ivPercentile: 29,
    sparkline: [3600, 3615, 3640, 3630, 3655, 3670, 3685, 3690],
  },
  {
    ticker: 'BMA',
    name: 'Banco Macro',
    sector: 'Bancos',
    color: '#F5B544',
    last: 9840.0,
    deltaPct: 3.68,
    prevClose: 9490.0,
    low: 9480.0,
    high: 9910.0,
    vwap: 9765.0,
    volumeM: 7190,
    volMultiple: 2.1,
    signalText: 'Fuerte entrada en la última hora',
    adrTicker: 'BMA US',
    adrPrice: 84.15,
    adrDeltaPct: 4.10,
    cclImplicit: 1169.3,
    iv30d: 53.0,
    ivRank: 'rango',
    ivPercentile: 54,
    sparkline: [9490, 9540, 9610, 9680, 9720, 9790, 9840],
  },
  {
    ticker: 'VISTA',
    name: 'Vista Energy CEDEAR',
    sector: 'Energía',
    color: '#34D3C7',
    last: 21450.0,
    deltaPct: 1.85,
    prevClose: 21060.0,
    low: 20980.0,
    high: 21580.0,
    vwap: 21340.0,
    volumeM: 6410,
    volMultiple: 1.4,
    signalText: 'Tendencia alcista intacta',
    adrTicker: 'VIST US',
    adrPrice: 55.05,
    adrDeltaPct: 2.25,
    cclImplicit: 1168.9,
    iv30d: 41.5,
    ivRank: 'barata',
    ivPercentile: 19,
    sparkline: [21050, 21120, 21200, 21180, 21310, 21390, 21450],
  },
  {
    ticker: 'TXAR',
    name: 'Ternium Argentina',
    sector: 'Materiales',
    color: '#E5558F',
    last: 912.0,
    deltaPct: -1.40,
    prevClose: 925.0,
    low: 906.0,
    high: 928.0,
    vwap: 915.5,
    volumeM: 2890,
    volMultiple: 0.8,
    signalText: 'Debilidad en siderúrgicas',
    iv30d: 39.2,
    ivRank: 'cara',
    ivPercentile: 78,
    sparkline: [925, 924, 920, 918, 915, 914, 912],
  },
  {
    ticker: 'ALUA',
    name: 'Aluar Aluminio Argentino',
    sector: 'Materiales',
    color: '#FF8A4C',
    last: 886.0,
    deltaPct: -0.89,
    prevClose: 894.0,
    low: 881.0,
    high: 897.0,
    vwap: 889.0,
    volumeM: 2140,
    volMultiple: 0.7,
    signalText: 'Arbitraje defensivo pausado',
    iv30d: 37.8,
    ivRank: 'rango',
    ivPercentile: 61,
    sparkline: [894, 892, 890, 891, 888, 887, 886],
  },
  {
    ticker: 'TGSU2',
    name: 'Transportadora de Gas del Sur',
    sector: 'Reguladas',
    color: '#5B8CFF',
    last: 6790.0,
    deltaPct: 2.72,
    prevClose: 6610.0,
    low: 6600.0,
    high: 6830.0,
    vwap: 6740.0,
    volumeM: 4920,
    volMultiple: 1.6,
    signalText: 'Demanda institucional constante',
    adrTicker: 'TGS US',
    adrPrice: 29.05,
    adrDeltaPct: 3.15,
    cclImplicit: 1168.6,
    iv30d: 45.1,
    ivRank: 'rango',
    ivPercentile: 44,
    sparkline: [6610, 6650, 6690, 6710, 6745, 6770, 6790],
  },
  {
    ticker: 'CEPU',
    name: 'Central Puerto',
    sector: 'Energía',
    color: '#2EDC7E',
    last: 1585.0,
    deltaPct: 1.93,
    prevClose: 1555.0,
    low: 1550.0,
    high: 1598.0,
    vwap: 1576.0,
    volumeM: 3810,
    volMultiple: 1.3,
    signalText: 'Subió con volumen medio',
    adrTicker: 'CEPU US',
    adrPrice: 13.56,
    adrDeltaPct: 2.34,
    cclImplicit: 1168.8,
    iv30d: 43.4,
    ivRank: 'barata',
    ivPercentile: 31,
    sparkline: [1555, 1560, 1568, 1572, 1579, 1585],
  },
  {
    ticker: 'COME',
    name: 'Sociedad Comercial del Plata',
    sector: 'Energía',
    color: '#8B7CF6',
    last: 274.5,
    deltaPct: 0.55,
    prevClose: 273.0,
    low: 269.0,
    high: 278.5,
    vwap: 274.1,
    volumeM: 4120,
    volMultiple: 1.8,
    signalText: 'Alta rotación en lotes ATM',
    iv30d: 58.6,
    ivRank: 'cara',
    ivPercentile: 82,
    sparkline: [273, 271, 274, 276, 275, 274.5],
  },
  {
    ticker: 'BBAR',
    name: 'BBVA Argentina',
    sector: 'Bancos',
    color: '#4BA3FF',
    last: 6920.0,
    deltaPct: 3.44,
    prevClose: 6690.0,
    low: 6680.0,
    high: 6965.0,
    vwap: 6875.0,
    volumeM: 4680,
    volMultiple: 1.7,
    signalText: 'Acompaña rally bancario',
    adrTicker: 'BBAR US',
    adrPrice: 17.76,
    adrDeltaPct: 3.85,
    cclImplicit: 1168.9,
    sparkline: [6690, 6730, 6790, 6840, 6890, 6920],
  },
  {
    ticker: 'SUPV',
    name: 'Grupo Supervielle',
    sector: 'Bancos',
    color: '#E5558F',
    last: 2890.0,
    deltaPct: 4.52,
    prevClose: 2765.0,
    low: 2755.0,
    high: 2915.0,
    vwap: 2858.0,
    volumeM: 3540,
    volMultiple: 2.3,
    signalText: 'Mayor beta alcista del sector',
    adrTicker: 'SUPV US',
    adrPrice: 12.36,
    adrDeltaPct: 4.95,
    cclImplicit: 1169.1,
    sparkline: [2765, 2790, 2825, 2850, 2875, 2890],
  },
  {
    ticker: 'EDN',
    name: 'Edenor',
    sector: 'Reguladas',
    color: '#34D3C7',
    last: 2410.0,
    deltaPct: 1.47,
    prevClose: 2375.0,
    low: 2360.0,
    high: 2435.0,
    vwap: 2402.0,
    volumeM: 2290,
    volMultiple: 1.1,
    signalText: 'Consolidando sobre soporte',
    adrTicker: 'EDN US',
    adrPrice: 41.24,
    adrDeltaPct: 1.88,
    cclImplicit: 1168.7,
    sparkline: [2375, 2380, 2395, 2405, 2410],
  },
  {
    ticker: 'TRAN',
    name: 'Transener',
    sector: 'Reguladas',
    color: '#F5B544',
    last: 2630.0,
    deltaPct: -0.38,
    prevClose: 2640.0,
    low: 2605.0,
    high: 2660.0,
    vwap: 2628.0,
    volumeM: 1480,
    volMultiple: 0.9,
    signalText: 'Lateral sin presión vendedora',
    sparkline: [2640, 2635, 2638, 2632, 2630],
  },
  {
    ticker: 'BYMA',
    name: 'Bolsas y Mercados Argentinos',
    sector: 'Bancos',
    color: '#8B7CF6',
    last: 438.0,
    deltaPct: 2.10,
    prevClose: 429.0,
    low: 428.0,
    high: 441.0,
    vwap: 436.2,
    volumeM: 1980,
    volMultiple: 1.4,
    signalText: 'Flujo positivo sostenido',
    sparkline: [429, 431, 434, 436, 438],
  },
  {
    ticker: 'TECO2',
    name: 'Telecom Argentina',
    sector: 'Telecom',
    color: '#4BA3FF',
    last: 2945.0,
    deltaPct: -0.67,
    prevClose: 2965.0,
    low: 2920.0,
    high: 2980.0,
    vwap: 2948.0,
    volumeM: 1620,
    volMultiple: 0.8,
    signalText: 'Toma de ganancias leve',
    adrTicker: 'TEO US',
    adrPrice: 12.60,
    adrDeltaPct: -0.24,
    cclImplicit: 1168.6,
    sparkline: [2965, 2960, 2952, 2948, 2945],
  },
  {
    ticker: 'LOMA',
    name: 'Loma Negra',
    sector: 'Materiales',
    color: '#2EDC7E',
    last: 2780.0,
    deltaPct: 1.09,
    prevClose: 2750.0,
    low: 2740.0,
    high: 2805.0,
    vwap: 2776.0,
    volumeM: 1840,
    volMultiple: 1.2,
    signalText: 'Rebote técnico en media 20d',
    adrTicker: 'LOMA US',
    adrPrice: 11.89,
    adrDeltaPct: 1.50,
    cclImplicit: 1169.0,
    sparkline: [2750, 2758, 2765, 2772, 2780],
  },
  {
    ticker: 'CRES',
    name: 'Cresud',
    sector: 'Agro',
    color: '#FF8A4C',
    last: 1490.0,
    deltaPct: 0.68,
    prevClose: 1480.0,
    low: 1472.0,
    high: 1505.0,
    vwap: 1489.0,
    volumeM: 1350,
    volMultiple: 1.0,
    signalText: 'Volumen dentro de su promedio',
    adrTicker: 'CRESY US',
    adrPrice: 12.75,
    adrDeltaPct: 1.11,
    cclImplicit: 1168.6,
    sparkline: [1480, 1482, 1486, 1488, 1490],
  },
];

export const AR_GENERAL_PANEL_STOCKS: StockRow[] = [
  {
    ticker: 'TGNO4',
    name: 'Transportadora de Gas del Norte',
    sector: 'Reguladas',
    panel: 'General',
    color: '#0EA5E9',
    last: 3420.0,
    deltaPct: 2.85,
    prevClose: 3325.0,
    low: 3310.0,
    high: 3450.0,
    vwap: 3398.0,
    volumeM: 1420,
    volMultiple: 1.5,
    signalText: 'Demanda firme en gasíferas',
    sparkline: [3325, 3340, 3365, 3390, 3410, 3420],
  },
  {
    ticker: 'METR',
    name: 'Metrogas S.A.',
    sector: 'Reguladas',
    panel: 'General',
    color: '#3B82F6',
    last: 2180.0,
    deltaPct: 3.32,
    prevClose: 2110.0,
    low: 2105.0,
    high: 2195.0,
    vwap: 2162.0,
    volumeM: 1180,
    volMultiple: 1.7,
    signalText: 'Acompaña suba de distribuidoras',
    sparkline: [2110, 2125, 2145, 2160, 2180],
  },
  {
    ticker: 'IRSA',
    name: 'IRSA Inversiones y Representaciones',
    sector: 'Agro',
    panel: 'General',
    color: '#6366F1',
    last: 1845.0,
    deltaPct: 1.65,
    prevClose: 1815.0,
    low: 1805.0,
    high: 1860.0,
    vwap: 1838.0,
    volumeM: 1540,
    volMultiple: 1.3,
    signalText: 'Flujo positivo en Real Estate',
    adrTicker: 'IRS US',
    adrPrice: 15.80,
    adrDeltaPct: 2.05,
    cclImplicit: 1167.7,
    sparkline: [1815, 1820, 1832, 1840, 1845],
  },
  {
    ticker: 'VALO',
    name: 'Banco de Valores',
    sector: 'Bancos',
    panel: 'General',
    color: '#8B5CF6',
    last: 392.5,
    deltaPct: 1.16,
    prevClose: 388.0,
    low: 386.0,
    high: 395.0,
    vwap: 391.0,
    volumeM: 890,
    volMultiple: 1.1,
    signalText: 'Estable sobre soporte corto',
    sparkline: [388, 389, 390, 391, 392.5],
  },
  {
    ticker: 'MIRG',
    name: 'Mirgor S.A.',
    sector: 'Materiales',
    panel: 'General',
    color: '#EC4899',
    last: 24600.0,
    deltaPct: -1.12,
    prevClose: 24880.0,
    low: 24500.0,
    high: 24950.0,
    vwap: 24690.0,
    volumeM: 940,
    volMultiple: 0.8,
    signalText: 'Retroceso con bajo volumen',
    sparkline: [24880, 24800, 24720, 24650, 24600],
  },
  {
    ticker: 'BHIP',
    name: 'Banco Hipotecario',
    sector: 'Bancos',
    panel: 'General',
    color: '#F59E0B',
    last: 514.0,
    deltaPct: 2.39,
    prevClose: 502.0,
    low: 500.0,
    high: 518.0,
    vwap: 511.5,
    volumeM: 1120,
    volMultiple: 1.4,
    signalText: 'Expansión de crédito hipotecario',
    sparkline: [502, 505, 509, 512, 514],
  },
  {
    ticker: 'CECO2',
    name: 'Central Costanera',
    sector: 'Energía',
    panel: 'General',
    color: '#10B981',
    last: 468.0,
    deltaPct: 0.0,
    prevClose: 468.0,
    low: 462.0,
    high: 472.0,
    vwap: 467.8,
    volumeM: 520,
    volMultiple: 0.9,
    signalText: 'Sin cambios al cierre parcial',
    sparkline: [468, 467, 469, 468, 468],
  },
  {
    ticker: 'CVH',
    name: 'Cablevisión Holding',
    sector: 'Telecom',
    panel: 'General',
    color: '#06B6D4',
    last: 6850.0,
    deltaPct: -0.58,
    prevClose: 6890.0,
    low: 6810.0,
    high: 6910.0,
    vwap: 6860.0,
    volumeM: 610,
    volMultiple: 0.8,
    signalText: 'Arbitraje neutro contra TECO2',
    sparkline: [6890, 6880, 6865, 6855, 6850],
  },
  {
    ticker: 'AUSO',
    name: 'Autopistas del Sol',
    sector: 'Reguladas',
    panel: 'General',
    color: '#F97316',
    last: 3190.0,
    deltaPct: 1.27,
    prevClose: 3150.0,
    low: 3140.0,
    high: 3210.0,
    vwap: 3182.0,
    volumeM: 580,
    volMultiple: 1.0,
    signalText: 'Actualización tarifaria descontada',
    sparkline: [3150, 3160, 3175, 3185, 3190],
  },
  {
    ticker: 'HARG',
    name: 'Holcim Argentina',
    sector: 'Materiales',
    panel: 'General',
    color: '#14B8A6',
    last: 1920.0,
    deltaPct: 0.79,
    prevClose: 1905.0,
    low: 1895.0,
    high: 1930.0,
    vwap: 1916.0,
    volumeM: 490,
    volMultiple: 0.9,
    signalText: 'Piso en despacho de cemento',
    sparkline: [1905, 1910, 1914, 1918, 1920],
  },
  {
    ticker: 'AGRO',
    name: 'Agrometal S.A.',
    sector: 'Agro',
    panel: 'General',
    color: '#84CC16',
    last: 74.5,
    deltaPct: -1.32,
    prevClose: 75.5,
    low: 74.0,
    high: 75.8,
    vwap: 74.7,
    volumeM: 410,
    volMultiple: 0.7,
    signalText: 'Selectividad en maquinaria',
    sparkline: [75.5, 75.2, 74.9, 74.6, 74.5],
  },
  {
    ticker: 'MORI',
    name: 'Morixe Hermanos',
    sector: 'Agro',
    panel: 'General',
    color: '#EAB308',
    last: 286.0,
    deltaPct: 1.78,
    prevClose: 281.0,
    low: 280.0,
    high: 288.0,
    vwap: 285.0,
    volumeM: 530,
    volMultiple: 1.2,
    signalText: 'Rebote técnico corto',
    sparkline: [281, 282, 284, 285, 286],
  },
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
  tirDeltaPb: number; // variación en puntos básicos
  parity: number; // %
  modDuration: number; // años
  volumeM: number;
  volMultiple: number;
  signal: string;
}

export const BONDS_DATA: BondRow[] = [
  {
    ticker: 'AL29',
    name: 'Bonar 2029 1%',
    tranche: 'Tramo corto (2026–2030)',
    law: 'Ley AR',
    currency: 'USD MEP',
    price: 76.45,
    deltaPct: 1.32,
    tir: 11.84,
    tirDeltaPb: -42,
    parity: 78.10,
    modDuration: 1.92,
    volumeM: 9420,
    volMultiple: 1.8,
    signal: 'Compresión de spread corto',
  },
  {
    ticker: 'AL30',
    name: 'Bonar 2030 Step-Up',
    tranche: 'Tramo corto (2026–2030)',
    law: 'Ley AR',
    currency: 'USD MEP',
    price: 71.80,
    deltaPct: 1.56,
    tir: 12.42,
    tirDeltaPb: -48,
    parity: 74.60,
    modDuration: 2.38,
    volumeM: 48650,
    volMultiple: 2.5,
    signal: 'Subió con volumen récord',
  },
  {
    ticker: 'GD30',
    name: 'Global 2030 Step-Up',
    tranche: 'Tramo corto (2026–2030)',
    law: 'Ley NY',
    currency: 'USD CCL',
    price: 74.15,
    deltaPct: 1.44,
    tir: 11.65,
    tirDeltaPb: -44,
    parity: 77.05,
    modDuration: 2.42,
    volumeM: 31200,
    volMultiple: 2.1,
    signal: 'Spread legislación en mínimos (77 pb)',
  },
  {
    ticker: 'AL35',
    name: 'Bonar 2035 4,125%',
    tranche: 'Tramo largo (2035–2046)',
    law: 'Ley AR',
    currency: 'USD MEP',
    price: 65.20,
    deltaPct: 2.04,
    tir: 11.18,
    tirDeltaPb: -38,
    parity: 66.40,
    modDuration: 5.45,
    volumeM: 14300,
    volMultiple: 1.9,
    signal: 'Fuerte demanda por duration',
  },
  {
    ticker: 'GD35',
    name: 'Global 2035 4,125%',
    tranche: 'Tramo largo (2035–2046)',
    law: 'Ley NY',
    currency: 'USD CCL',
    price: 66.85,
    deltaPct: 1.98,
    tir: 10.89,
    tirDeltaPb: -36,
    parity: 68.10,
    modDuration: 5.52,
    volumeM: 22890,
    volMultiple: 2.2,
    signal: 'Favorito de carteras offshore',
  },
  {
    ticker: 'GD38',
    name: 'Global 2038 5,00%',
    tranche: 'Tramo largo (2035–2046)',
    law: 'Ley NY',
    currency: 'USD CCL',
    price: 70.40,
    deltaPct: 1.72,
    tir: 11.02,
    tirDeltaPb: -31,
    parity: 71.25,
    modDuration: 4.88,
    volumeM: 11400,
    volMultiple: 1.5,
    signal: 'Flujo comprador por cupón corriente',
  },
  {
    ticker: 'GD41',
    name: 'Global 2041 4,875%',
    tranche: 'Tramo largo (2035–2046)',
    law: 'Ley NY',
    currency: 'USD CCL',
    price: 63.90,
    deltaPct: 1.85,
    tir: 10.95,
    tirDeltaPb: -33,
    parity: 64.80,
    modDuration: 6.12,
    volumeM: 7650,
    volMultiple: 1.4,
    signal: 'Aplanamiento de curva larga',
  },
  {
    ticker: 'S30J6',
    name: 'LECAP Vto. 30-Jun',
    tranche: 'LECAC / Letras Tasa Fija',
    law: 'Ley AR',
    currency: 'ARS',
    price: 134.25,
    deltaPct: 0.28,
    tir: 29.80, // TEM anualizada / TIR efectiva
    tirDeltaPb: -14,
    parity: 96.40,
    modDuration: 0.14,
    volumeM: 39100,
    volMultiple: 1.7,
    signal: 'TEM 2,21 % · rolleo de liquidez',
  },
  {
    ticker: 'S15G6',
    name: 'LECAP Vto. 15-Ago',
    tranche: 'LECAC / Letras Tasa Fija',
    law: 'Ley AR',
    currency: 'ARS',
    price: 141.80,
    deltaPct: 0.34,
    tir: 29.15,
    tirDeltaPb: -18,
    parity: 93.10,
    modDuration: 0.27,
    volumeM: 28400,
    volMultiple: 1.6,
    signal: 'TEM 2,16 % · tramo medio pedido',
  },
  {
    ticker: 'TZX26',
    name: 'BONCER Cero Jun-2026',
    tranche: 'CER / Ajustables por inflación',
    law: 'Ley AR',
    currency: 'ARS',
    price: 248.50,
    deltaPct: -0.45,
    tir: 7.45, // CER + 7.45%
    tirDeltaPb: 22,
    parity: 91.80,
    modDuration: 0.62,
    volumeM: 16200,
    volMultiple: 1.3,
    signal: 'CER + 7,45 % · inflación breakeven 1,8 % m/m',
  },
];

export interface OptionChainRow {
  strike: number;
  distancePct: number;
  inOneSigma: boolean;
  // Call side
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
  // Put side
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

export const GGAL_OPTION_EXPIRIES: OptionExpiryGroup[] = [
  {
    id: 'JUN26',
    label: 'Junio 2026 (Opex 19-Jun)',
    expiryDate: '19/06/2026',
    daysToExpiry: 38,
    callSharePct: 74,
    putSharePct: 26,
    totalVolumeM: 6840,
    atmIV: 51.4,
    syntheticRateTNA: 34.8,
    oneSigmaLow: 5830,
    oneSigmaHigh: 7130,
    rows: [
      {
        strike: 5600,
        distancePct: -13.58,
        inOneSigma: false,
        callTicker: 'GFGC5600JU',
        callBid: 1035.0,
        callAsk: 1055.0,
        callLast: 1048.0,
        callDeltaPct: 18.4,
        callIV: 55.2,
        callDelta: 0.84,
        callGamma: 0.00028,
        callTheta: -5.42,
        callVega: 4.12,
        callTimeValue: 168.0,
        callTimeValuePct: 2.59,
        callValRank: 'rango',
        callVolumeLots: 1420,
        callOpenInterest: 8900,
        putTicker: 'GFGV5600JU',
        putBid: 42.0,
        putAsk: 45.5,
        putLast: 44.0,
        putDeltaPct: -32.1,
        putIV: 56.8,
        putDelta: -0.15,
        putGamma: 0.00027,
        putTheta: -3.18,
        putVega: 3.95,
        putTimeValue: 44.0,
        putTimeValuePct: 0.68,
        putValRank: 'cara',
        putVolumeLots: 980,
        putOpenInterest: 6420,
      },
      {
        strike: 5900,
        distancePct: -8.95,
        inOneSigma: true,
        callTicker: 'GFGC5900JU',
        callBid: 790.0,
        callAsk: 805.0,
        callLast: 798.0,
        callDeltaPct: 22.8,
        callIV: 53.1,
        callDelta: 0.74,
        callGamma: 0.00036,
        callTheta: -6.35,
        callVega: 5.45,
        callTimeValue: 218.0,
        callTimeValuePct: 3.36,
        callValRank: 'barata',
        callVolumeLots: 3890,
        callOpenInterest: 14200,
        putTicker: 'GFGV5900JU',
        putBid: 88.0,
        putAsk: 92.0,
        putLast: 90.5,
        putDeltaPct: -28.4,
        putIV: 54.0,
        putDelta: -0.25,
        putGamma: 0.00035,
        putTheta: -4.20,
        putVega: 5.38,
        putTimeValue: 90.5,
        putTimeValuePct: 1.40,
        putValRank: 'rango',
        putVolumeLots: 2640,
        putOpenInterest: 11300,
      },
      {
        strike: 6200,
        distancePct: -4.32,
        inOneSigma: true,
        callTicker: 'GFGC6200JU',
        callBid: 568.0,
        callAsk: 576.0,
        callLast: 574.0,
        callDeltaPct: 26.5,
        callIV: 51.8,
        callDelta: 0.63,
        callGamma: 0.00043,
        callTheta: -7.12,
        callVega: 6.48,
        callTimeValue: 294.0,
        callTimeValuePct: 4.54,
        callValRank: 'barata',
        callVolumeLots: 9450,
        callOpenInterest: 28400,
        putTicker: 'GFGV6200JU',
        putBid: 164.0,
        putAsk: 170.0,
        putLast: 167.0,
        putDeltaPct: -24.2,
        putIV: 52.4,
        putDelta: -0.37,
        putGamma: 0.00042,
        putTheta: -5.14,
        putVega: 6.40,
        putTimeValue: 167.0,
        putTimeValuePct: 2.58,
        putValRank: 'barata',
        putVolumeLots: 5120,
        putOpenInterest: 19800,
      },
      {
        strike: 6500,
        distancePct: 0.31,
        inOneSigma: true,
        callTicker: 'GFGC6500JU',
        callBid: 392.0,
        callAsk: 398.0,
        callLast: 396.0,
        callDeltaPct: 31.2,
        callIV: 51.2,
        callDelta: 0.51,
        callGamma: 0.00047,
        callTheta: -7.65,
        callVega: 6.92,
        callTimeValue: 396.0,
        callTimeValuePct: 6.11,
        callValRank: 'barata',
        callVolumeLots: 18640,
        callOpenInterest: 42900,
        putTicker: 'GFGV6500JU',
        putBid: 278.0,
        putAsk: 285.0,
        putLast: 282.0,
        putDeltaPct: -19.8,
        putIV: 51.6,
        putDelta: -0.49,
        putGamma: 0.00047,
        putTheta: -5.88,
        putVega: 6.90,
        putTimeValue: 262.0,
        putTimeValuePct: 4.04,
        putValRank: 'rango',
        putVolumeLots: 6840,
        putOpenInterest: 24100,
      },
      {
        strike: 6800,
        distancePct: 4.94,
        inOneSigma: true,
        callTicker: 'GFGC6800JU',
        callBid: 256.0,
        callAsk: 261.0,
        callLast: 259.0,
        callDeltaPct: 34.8,
        callIV: 51.9,
        callDelta: 0.39,
        callGamma: 0.00044,
        callTheta: -7.28,
        callVega: 6.55,
        callTimeValue: 259.0,
        callTimeValuePct: 4.00,
        callValRank: 'rango',
        callVolumeLots: 15920,
        callOpenInterest: 38700,
        putTicker: 'GFGV6800JU',
        putBid: 438.0,
        putAsk: 450.0,
        putLast: 444.0,
        putDeltaPct: -15.4,
        putIV: 52.5,
        putDelta: -0.61,
        putGamma: 0.00043,
        putTheta: -5.42,
        putVega: 6.48,
        putTimeValue: 124.0,
        putTimeValuePct: 1.91,
        putValRank: 'rango',
        putVolumeLots: 2190,
        putOpenInterest: 9400,
      },
      {
        strike: 7100,
        distancePct: 9.57,
        inOneSigma: true,
        callTicker: 'GFGC7100JU',
        callBid: 158.0,
        callAsk: 162.5,
        callLast: 161.0,
        callDeltaPct: 38.4,
        callIV: 53.4,
        callDelta: 0.28,
        callGamma: 0.00038,
        callTheta: -6.45,
        callVega: 5.62,
        callTimeValue: 161.0,
        callTimeValuePct: 2.48,
        callValRank: 'rango',
        callVolumeLots: 11280,
        callOpenInterest: 31500,
        putTicker: 'GFGV7100JU',
        putBid: 642.0,
        putAsk: 660.0,
        putLast: 650.0,
        putDeltaPct: -11.9,
        putIV: 54.1,
        putDelta: -0.72,
        putGamma: 0.00037,
        putTheta: -4.60,
        putVega: 5.55,
        putTimeValue: 30.0,
        putTimeValuePct: 0.46,
        putValRank: 'cara',
        putVolumeLots: 640,
        putOpenInterest: 3200,
      },
      {
        strike: 7400,
        distancePct: 14.20,
        inOneSigma: false,
        callTicker: 'GFGC7400JU',
        callBid: 92.0,
        callAsk: 95.5,
        callLast: 94.0,
        callDeltaPct: 41.2,
        callIV: 55.6,
        callDelta: 0.19,
        callGamma: 0.00030,
        callTheta: -5.32,
        callVega: 4.48,
        callTimeValue: 94.0,
        callTimeValuePct: 1.45,
        callValRank: 'cara',
        callVolumeLots: 7840,
        callOpenInterest: 24600,
        putTicker: 'GFGV7400JU',
        putBid: 880.0,
        putAsk: 905.0,
        putLast: 892.0,
        putDeltaPct: -8.5,
        putIV: 56.2,
        putDelta: -0.81,
        putGamma: 0.00029,
        putTheta: -3.75,
        putVega: 4.40,
        putTimeValue: -28.0,
        putTimeValuePct: -0.43,
        putValRank: 'rango',
        putVolumeLots: 210,
        putOpenInterest: 1150,
      },
    ],
  },
  {
    id: 'AGO26',
    label: 'Agosto 2026 (Opex 21-Ago)',
    expiryDate: '21/08/2026',
    daysToExpiry: 101,
    callSharePct: 81,
    putSharePct: 19,
    totalVolumeM: 1920,
    atmIV: 53.8,
    syntheticRateTNA: 33.9,
    oneSigmaLow: 5410,
    oneSigmaHigh: 7550,
    rows: [
      {
        strike: 6200,
        distancePct: -4.32,
        inOneSigma: true,
        callTicker: 'GFGC6200AG',
        callBid: 920.0,
        callAsk: 945.0,
        callLast: 935.0,
        callDeltaPct: 19.4,
        callIV: 53.5,
        callDelta: 0.66,
        callGamma: 0.00026,
        callTheta: -4.85,
        callVega: 10.20,
        callTimeValue: 655.0,
        callTimeValuePct: 10.11,
        callValRank: 'barata',
        callVolumeLots: 1840,
        callOpenInterest: 6200,
        putTicker: 'GFGV6200AG',
        putBid: 295.0,
        putAsk: 312.0,
        putLast: 304.0,
        putDeltaPct: -14.8,
        putIV: 54.2,
        putDelta: -0.34,
        putGamma: 0.00026,
        putTheta: -3.20,
        putVega: 10.10,
        putTimeValue: 304.0,
        putTimeValuePct: 4.69,
        putValRank: 'rango',
        putVolumeLots: 620,
        putOpenInterest: 2900,
      },
      {
        strike: 6500,
        distancePct: 0.31,
        inOneSigma: true,
        callTicker: 'GFGC6500AG',
        callBid: 745.0,
        callAsk: 765.0,
        callLast: 758.0,
        callDeltaPct: 22.1,
        callIV: 53.8,
        callDelta: 0.57,
        callGamma: 0.00028,
        callTheta: -5.12,
        callVega: 11.15,
        callTimeValue: 758.0,
        callTimeValuePct: 11.70,
        callValRank: 'rango',
        callVolumeLots: 3420,
        callOpenInterest: 11400,
        putTicker: 'GFGV6500AG',
        putBid: 418.0,
        putAsk: 435.0,
        putLast: 426.0,
        putDeltaPct: -12.6,
        putIV: 54.4,
        putDelta: -0.43,
        putGamma: 0.00028,
        putTheta: -3.55,
        putVega: 11.05,
        putTimeValue: 406.0,
        putTimeValuePct: 6.27,
        putValRank: 'rango',
        putVolumeLots: 890,
        putOpenInterest: 4100,
      },
      {
        strike: 7100,
        distancePct: 9.57,
        inOneSigma: true,
        callTicker: 'GFGC7100AG',
        callBid: 465.0,
        callAsk: 482.0,
        callLast: 475.0,
        callDeltaPct: 26.8,
        callIV: 55.1,
        callDelta: 0.41,
        callGamma: 0.00027,
        callTheta: -4.90,
        callVega: 10.60,
        callTimeValue: 475.0,
        callTimeValuePct: 7.33,
        callValRank: 'rango',
        callVolumeLots: 2690,
        callOpenInterest: 8700,
        putTicker: 'GFGV7100AG',
        putBid: 750.0,
        putAsk: 778.0,
        putLast: 764.0,
        putDeltaPct: -9.4,
        putIV: 55.8,
        putDelta: -0.59,
        putGamma: 0.00026,
        putTheta: -3.10,
        putVega: 10.45,
        putTimeValue: 144.0,
        putTimeValuePct: 2.22,
        putValRank: 'cara',
        putVolumeLots: 310,
        putOpenInterest: 1450,
      },
    ],
  },
];

export interface OptionStrategyCard {
  id: string;
  name: string;
  bias: 'Alcista' | 'Bajista' | 'Neutral / Rango' | 'Volatilidad';
  legs: string[];
  netCost: number; // positivo = débito, negativo = crédito
  maxProfit: string;
  maxLoss: string;
  breakeven: string;
  probProfitPct: number;
  returnOnRiskPct: number;
  rationale: string;
  payoffPoints: { spot: number; pnl: number }[];
}

export const SUGGESTED_STRATEGIES: OptionStrategyCard[] = [
  {
    id: 'bull-call-6500-6800',
    name: 'Bull Call Spread 6500 / 6800',
    bias: 'Alcista',
    legs: ['Compra 1× GFGC6500JU @ $ 396', 'Venta 1× GFGC6800JU @ $ 259'],
    netCost: 137.0,
    maxProfit: '$ 163,00 (+119 %)',
    maxLoss: '−$ 137,00',
    breakeven: '$ 6.637,00 (+2,4 %)',
    probProfitPct: 47.5,
    returnOnRiskPct: 119.0,
    rationale: 'Aprovecha VI de la 6500 en percentil 22 y financia el valor tiempo vendiendo la 6800 cerca de +1σ.',
    payoffPoints: [
      { spot: 5900, pnl: -137 },
      { spot: 6200, pnl: -137 },
      { spot: 6500, pnl: -137 },
      { spot: 6637, pnl: 0 },
      { spot: 6800, pnl: 163 },
      { spot: 7100, pnl: 163 },
      { spot: 7400, pnl: 163 },
    ],
  },
  {
    id: 'short-strangle-5900-7100',
    name: 'Cuna Vendida Cubierta 5900 / 7100 (±1σ)',
    bias: 'Neutral / Rango',
    legs: ['Venta 1× GFGV5900JU @ $ 90,5', 'Venta 1× GFGC7100JU @ $ 161,0'],
    netCost: -251.5,
    maxProfit: '$ 251,50 (crédito)',
    maxLoss: 'Ilimitada fuera de rango',
    breakeven: '$ 5.648,5 / $ 7.351,5',
    probProfitPct: 68.4,
    returnOnRiskPct: 24.8,
    rationale: 'Captura theta de −$ 10,65 diarios en los extremos de ±1σ donde las colas cotizan con skew positivo.',
    payoffPoints: [
      { spot: 5400, pnl: -248.5 },
      { spot: 5648, pnl: 0 },
      { spot: 5900, pnl: 251.5 },
      { spot: 6500, pnl: 251.5 },
      { spot: 7100, pnl: 251.5 },
      { spot: 7351, pnl: 0 },
      { spot: 7600, pnl: -248.5 },
    ],
  },
  {
    id: 'tasa-sintetica-6500',
    name: 'Lanzamiento Cubierto / Tasa ATM 6500',
    bias: 'Alcista',
    legs: ['Compra 100× GGAL @ $ 6.480', 'Venta 1× GFGC6500JU @ $ 396'],
    netCost: 6084.0,
    maxProfit: '$ 416,00 (+6,84 % directo · 65,7 % TNA)',
    maxLoss: 'Cobertura hasta $ 6.084 (−6,1 %)',
    breakeven: '$ 6.084,00',
    probProfitPct: 64.2,
    returnOnRiskPct: 6.84,
    rationale: 'Rinde +32,2 puntos porcentuales de TNA por encima de la caución a 38 días con 6,1 % de colchón a la baja.',
    payoffPoints: [
      { spot: 5800, pnl: -284 },
      { spot: 6084, pnl: 0 },
      { spot: 6500, pnl: 416 },
      { spot: 6800, pnl: 416 },
      { spot: 7100, pnl: 416 },
      { spot: 7400, pnl: 416 },
    ],
  },
  {
    id: 'iron-condor-5900-6200-6800-7100',
    name: 'Iron Condor 5900/6200 · 6800/7100',
    bias: 'Neutral / Rango',
    legs: [' +GFGV5900 / −GFGV6200', ' −GFGC6800 / +GFGC7100'],
    netCost: -174.5,
    maxProfit: '$ 174,50 (+139 % s/garantía)',
    maxLoss: '−$ 125,50 (riesgo acotado)',
    breakeven: '$ 6.025,5 / $ 6.974,5',
    probProfitPct: 58.1,
    returnOnRiskPct: 139.0,
    rationale: 'Riesgo máximo limitado a $ 125,50 por lote con ganancia máxima si GGAL cierra entre $ 6.200 y $ 6.800.',
    payoffPoints: [
      { spot: 5800, pnl: -125.5 },
      { spot: 5900, pnl: -125.5 },
      { spot: 6025, pnl: 0 },
      { spot: 6200, pnl: 174.5 },
      { spot: 6800, pnl: 174.5 },
      { spot: 6974, pnl: 0 },
      { spot: 7100, pnl: -125.5 },
      { spot: 7300, pnl: -125.5 },
    ],
  },
];

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
    value: '8,4 %',
    deltaLabel: '−1,2 pp vs. sem. ant.',
    isPositiveGood: false,
    deltaPositive: false,
    context: 'Mínimo de los últimos 5 años · promedio 12m: 24,6 %',
    sparkline: [22.4, 19.8, 16.5, 14.2, 12.0, 10.8, 9.6, 8.9, 8.4],
    unit: '%',
    formulaHelp: '(CCL implícito / Dólar Mayorista Com. A3500 − 1) × 100.',
  },
  {
    id: 'itcrm',
    theme: 'Dólar y Brecha',
    title: 'Tipo de Cambio Real Multilateral (ITCRM)',
    value: '84,6',
    deltaLabel: '+0,8 pt en el mes',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Base 17-Dic-2015 = 100 · depreciación del real mejora margen',
    sparkline: [91.2, 89.4, 87.1, 85.8, 84.0, 83.8, 84.2, 84.6],
    unit: 'índice',
    formulaHelp: 'Índice BCRA que mide el poder adquisitivo del peso frente a la canasta de socios comerciales.',
  },
  {
    id: 'canje-ccl-mep',
    theme: 'Dólar y Brecha',
    title: 'Canje CCL / MEP (Cable)',
    value: '2,30 %',
    deltaLabel: '+0,18 pp hoy',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'En su banda histórica normal (1,8 % a 3,2 %)',
    sparkline: [1.9, 2.1, 2.4, 2.2, 2.0, 2.12, 2.30],
    unit: '%',
    formulaHelp: '(Dólar CCL / Dólar MEP − 1) × 100. Costo de girar divisas de MEP a NY.',
  },
  {
    id: 'ipc-rem',
    theme: 'Actividad e Inflación',
    title: 'Inflación Mensual (IPC Nacional)',
    value: '2,1 %',
    deltaLabel: '−0,3 pp vs. mes previo',
    isPositiveGood: false,
    deltaPositive: false,
    context: 'Nucleo en 1,9 % m/m · Break-even LECAP vs. CER en 1,8 % m/m',
    sparkline: [4.2, 3.8, 3.4, 2.9, 2.7, 2.4, 2.1],
    unit: '% m/m',
    formulaHelp: 'Variación mensual del Índice de Precios al Consumidor (INDEC) y sendero implícito en curvas.',
  },
  {
    id: 'emae',
    theme: 'Actividad e Inflación',
    title: 'Actividad Económica (EMAE desest.)',
    value: '+4,8 % i.a.',
    deltaLabel: '+0,6 % mensual s/e',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Traccionado por Energía (+14,2 %), Agro y Crédito privado',
    sparkline: [-1.8, -0.4, 1.2, 2.4, 3.1, 4.0, 4.8],
    unit: '% i.a.',
    formulaHelp: 'Estimador Mensual de Actividad Económica (INDEC), serie sin estacionalidad.',
  },
  {
    id: 'superavit-fiscal',
    theme: 'Cuentas Públicas y Monetarias',
    title: 'Resultado Primario Acumulado',
    value: '+1,6 % PIB',
    deltaLabel: '+0,2 pp sobre meta',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Superávit financiero +0,5 % PIB · 14 meses consecutivos',
    sparkline: [0.4, 0.7, 0.9, 1.1, 1.3, 1.5, 1.6],
    unit: '% PIB',
    formulaHelp: 'Ingresos totales menos gastos primarios del Sector Público Nacional No Financiero (MECON).',
  },
  {
    id: 'reservas-bcra',
    theme: 'Sector Externo y Afuera',
    title: 'Reservas Brutas BCRA',
    value: 'US$ 31.840 M',
    deltaLabel: '+US$ 145 M rueda hoy',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Compras netas MULC mes: +US$ 1.120 M · liquidación agro alta',
    sparkline: [28400, 29100, 29850, 30400, 31100, 31520, 31840],
    unit: 'USD M',
    formulaHelp: 'Stock de reservas internacionales brutas informadas por el BCRA al cierre del MULC.',
  },
  {
    id: 'soja-brent',
    theme: 'Sector Externo y Afuera',
    title: 'Términos de Intercambio (Soja CBOT / Brent)',
    value: 'US$ 384 / t',
    deltaLabel: '+1,4 % en Chicago',
    isPositiveGood: true,
    deltaPositive: true,
    context: 'Brent en US$ 74,20 (+0,8 %) · Real brasileño 5,48 / USD',
    sparkline: [368, 372, 370, 375, 379, 381, 384],
    unit: 'USD/t',
    formulaHelp: 'Contrato futuro de primera posición de Soja en Chicago (CBOT).',
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

export const US_MARKET_DATA: USStockItem[] = [
  // Mega Caps / Tech
  { ticker: 'NVDA', name: 'NVIDIA Corporation', sector: 'Mega Caps / Tech', color: '#10B981', price: 142.80, deltaPct: 2.95, low: 138.90, high: 143.50, volMultiple: 1.9, cedearRatio: '24:1', cedearRatioNum: 24, cedearArsPrice: 6954, cclImplicit: 1168.7, iv30d: 44.2, signal: 'Liderazgo de semiconductores' },
  { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Mega Caps / Tech', color: '#64748B', price: 234.50, deltaPct: 0.45, low: 232.80, high: 235.40, volMultiple: 0.9, cedearRatio: '20:1', cedearRatioNum: 20, cedearArsPrice: 13704, cclImplicit: 1168.8, iv30d: 19.8, signal: 'Rango estrecho sobre VWAP' },
  { ticker: 'MSFT', name: 'Microsoft Corporation', sector: 'Mega Caps / Tech', color: '#0EA5E9', price: 446.20, deltaPct: 0.92, low: 442.00, high: 447.80, volMultiple: 1.1, cedearRatio: '30:1', cedearRatioNum: 30, cedearArsPrice: 17384, cclImplicit: 1168.8, iv30d: 21.5, signal: 'Acumulación institucional' },
  { ticker: 'AMZN', name: 'Amazon.com Inc.', sector: 'Mega Caps / Tech', color: '#F59E0B', price: 214.80, deltaPct: 1.38, low: 211.90, high: 215.60, volMultiple: 1.3, cedearRatio: '144:1', cedearRatioNum: 144, cedearArsPrice: 1744, cclImplicit: 1169.1, iv30d: 25.1, signal: 'Breakout alcista confirmado' },
  { ticker: 'GOOGL', name: 'Alphabet Inc. Class A', sector: 'Mega Caps / Tech', color: '#3B82F6', price: 184.60, deltaPct: 1.12, low: 182.10, high: 185.40, volMultiple: 1.2, cedearRatio: '58:1', cedearRatioNum: 58, cedearArsPrice: 3720, cclImplicit: 1168.8, iv30d: 24.4, signal: 'Flujo comprador en Cloud & AI' },
  { ticker: 'META', name: 'Meta Platforms Inc.', sector: 'Mega Caps / Tech', color: '#2563EB', price: 592.40, deltaPct: 1.84, low: 584.00, high: 595.10, volMultiple: 1.5, cedearRatio: '24:1', cedearRatioNum: 24, cedearArsPrice: 28850, cclImplicit: 1168.8, iv30d: 28.9, signal: 'Impulso sobre media de 20 ruedas' },
  { ticker: 'TSLA', name: 'Tesla Inc.', sector: 'Mega Caps / Tech', color: '#EF4444', price: 342.10, deltaPct: -1.65, low: 338.20, high: 349.80, volMultiple: 2.1, cedearRatio: '15:1', cedearRatioNum: 15, cedearArsPrice: 26658, cclImplicit: 1168.9, iv30d: 56.4, signal: 'Toma de ganancias tras rally' },
  { ticker: 'AMD', name: 'Advanced Micro Devices', sector: 'Mega Caps / Tech', color: '#14B8A6', price: 138.90, deltaPct: 2.15, low: 135.40, high: 139.80, volMultiple: 1.6, cedearRatio: '10:1', cedearRatioNum: 10, cedearArsPrice: 16236, cclImplicit: 1168.9, iv30d: 42.8, signal: 'Rebote técnico desde soporte' },
  { ticker: 'AVGO', name: 'Broadcom Inc.', sector: 'Mega Caps / Tech', color: '#DC2626', price: 176.40, deltaPct: 2.48, low: 172.10, high: 177.20, volMultiple: 1.7, cedearRatio: '39:1', cedearRatioNum: 39, cedearArsPrice: 5288, cclImplicit: 1169.0, iv30d: 36.2, signal: 'Tracción en redes de IA' },
  { ticker: 'NFLX', name: 'Netflix Inc.', sector: 'Mega Caps / Tech', color: '#E11D48', price: 842.50, deltaPct: 0.85, low: 835.00, high: 846.00, volMultiple: 1.0, cedearRatio: '48:1', cedearRatioNum: 48, cedearArsPrice: 20514, cclImplicit: 1168.7, iv30d: 27.5, signal: 'Máximo histórico sostenido' },
  { ticker: 'ORCL', name: 'Oracle Corporation', sector: 'Mega Caps / Tech', color: '#F97316', price: 188.20, deltaPct: 1.42, low: 185.40, high: 189.10, volMultiple: 1.3, cedearRatio: '3:1', cedearRatioNum: 3, cedearArsPrice: 73320, cclImplicit: 1168.8, iv30d: 26.8, signal: 'Expansión de infraestructura OCI' },
  { ticker: 'CRM', name: 'Salesforce Inc.', sector: 'Mega Caps / Tech', color: '#0284C7', price: 334.00, deltaPct: 0.64, low: 331.20, high: 336.10, volMultiple: 0.9, cedearRatio: '18:1', cedearRatioNum: 18, cedearArsPrice: 21688, cclImplicit: 1168.8, iv30d: 24.9, signal: 'Consolidación alcista' },

  // Finanzas
  { ticker: 'JPM', name: 'JPMorgan Chase & Co.', sector: 'Finanzas', color: '#1D4ED8', price: 244.80, deltaPct: 1.24, low: 241.50, high: 245.60, volMultiple: 1.3, cedearRatio: '15:1', cedearRatioNum: 15, cedearArsPrice: 19075, cclImplicit: 1168.8, iv30d: 18.4, signal: 'Curva Treasury favorece margen' },
  { ticker: 'BAC', name: 'Bank of America Corp.', sector: 'Finanzas', color: '#2563EB', price: 46.20, deltaPct: 1.48, low: 45.40, high: 46.50, volMultiple: 1.4, cedearRatio: '4:1', cedearRatioNum: 4, cedearArsPrice: 13499, cclImplicit: 1168.7, iv30d: 20.1, signal: 'Flujo institucional en banca' },
  { ticker: 'GS', name: 'Goldman Sachs Group', sector: 'Finanzas', color: '#3B82F6', price: 589.00, deltaPct: 1.62, low: 580.00, high: 591.50, volMultiple: 1.5, cedearRatio: '13:1', cedearRatioNum: 13, cedearArsPrice: 52955, cclImplicit: 1168.8, iv30d: 21.8, signal: 'Reactivación de M&A y trading' },
  { ticker: 'V', name: 'Visa Inc.', sector: 'Finanzas', color: '#4F46E5', price: 311.40, deltaPct: 0.52, low: 309.50, high: 312.20, volMultiple: 0.9, cedearRatio: '18:1', cedearRatioNum: 18, cedearArsPrice: 20220, cclImplicit: 1168.8, iv30d: 16.2, signal: 'Volumen transaccional estable' },
  { ticker: 'MA', name: 'Mastercard Incorporated', sector: 'Finanzas', color: '#EA580C', price: 524.60, deltaPct: 0.68, low: 521.00, high: 526.20, volMultiple: 1.0, cedearRatio: '33:1', cedearRatioNum: 33, cedearArsPrice: 18580, cclImplicit: 1168.8, iv30d: 16.8, signal: 'Defensivo de calidad' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway B', sector: 'Finanzas', color: '#475569', price: 468.90, deltaPct: 0.41, low: 466.20, high: 470.00, volMultiple: 0.8, cedearRatio: '22:1', cedearRatioNum: 22, cedearArsPrice: 24912, cclImplicit: 1168.8, iv30d: 14.5, signal: 'Récord de liquidez en T-Bills' },

  // Consumo
  { ticker: 'MELI', name: 'MercadoLibre Inc.', sector: 'Consumo', color: '#EAB308', price: 2115.00, deltaPct: 2.40, low: 2068.00, high: 2128.00, volMultiple: 1.7, cedearRatio: '120:1', cedearRatioNum: 120, cedearArsPrice: 20599, cclImplicit: 1168.7, iv30d: 34.6, signal: 'Expansión de crédito en AR y BR' },
  { ticker: 'WMT', name: 'Walmart Inc.', sector: 'Consumo', color: '#0284C7', price: 85.40, deltaPct: 0.94, low: 84.50, high: 85.80, volMultiple: 1.1, cedearRatio: '18:1', cedearRatioNum: 18, cedearArsPrice: 5545, cclImplicit: 1168.7, iv30d: 15.9, signal: 'Ganancia de market share retail' },
  { ticker: 'COST', name: 'Costco Wholesale Corp.', sector: 'Consumo', color: '#E11D48', price: 932.00, deltaPct: 0.76, low: 924.00, high: 935.50, volMultiple: 1.0, cedearRatio: '48:1', cedearRatioNum: 48, cedearArsPrice: 22694, cclImplicit: 1168.8, iv30d: 18.2, signal: 'Tendencia primaria intacta' },
  { ticker: 'KO', name: 'The Coca-Cola Company', sector: 'Consumo', color: '#DC2626', price: 64.20, deltaPct: -0.35, low: 63.90, high: 64.60, volMultiple: 0.8, cedearRatio: '5:1', cedearRatioNum: 5, cedearArsPrice: 15007, cclImplicit: 1168.8, iv30d: 13.4, signal: 'Rotación desde defensivas' },
  { ticker: 'MCD', name: 'McDonald’s Corporation', sector: 'Consumo', color: '#F59E0B', price: 296.40, deltaPct: 0.31, low: 294.80, high: 297.50, volMultiple: 0.9, cedearRatio: '24:1', cedearRatioNum: 24, cedearArsPrice: 14434, cclImplicit: 1168.7, iv30d: 15.6, signal: 'Soporte técnico en US$ 295' },
  { ticker: 'NKE', name: 'NIKE Inc.', sector: 'Consumo', color: '#64748B', price: 76.80, deltaPct: -1.18, low: 76.10, high: 77.90, volMultiple: 1.2, cedearRatio: '12:1', cedearRatioNum: 12, cedearArsPrice: 7480, cclImplicit: 1168.8, iv30d: 26.4, signal: 'Debilidad relativa en consumo discr.' },

  // Energía
  { ticker: 'XOM', name: 'Exxon Mobil Corporation', sector: 'Energía', color: '#EF4444', price: 119.80, deltaPct: 0.82, low: 118.40, high: 120.40, volMultiple: 1.1, cedearRatio: '10:1', cedearRatioNum: 10, cedearArsPrice: 14002, cclImplicit: 1168.8, iv30d: 20.8, signal: 'Firmeza con Brent en US$ 74' },
  { ticker: 'CVX', name: 'Chevron Corporation', sector: 'Energía', color: '#0284C7', price: 158.40, deltaPct: 0.65, low: 156.90, high: 159.10, volMultiple: 1.0, cedearRatio: '16:1', cedearRatioNum: 16, cedearArsPrice: 11571, cclImplicit: 1168.8, iv30d: 19.6, signal: 'Recompra de acciones activa' },
  { ticker: 'VIST', name: 'Vista Energy S.A.B.', sector: 'Energía', color: '#14B8A6', price: 55.05, deltaPct: 2.25, low: 53.80, high: 55.40, volMultiple: 1.6, cedearRatio: '3:1', cedearRatioNum: 3, cedearArsPrice: 21450, cclImplicit: 1168.9, iv30d: 41.5, signal: 'Crecimiento de producción Vaca Muerta' },
  { ticker: 'SLB', name: 'Schlumberger Limited', sector: 'Energía', color: '#3B82F6', price: 43.90, deltaPct: -0.45, low: 43.50, high: 44.40, volMultiple: 0.9, cedearRatio: '3:1', cedearRatioNum: 3, cedearArsPrice: 17103, cclImplicit: 1168.8, iv30d: 25.4, signal: 'Lateral en piso de valuación' },

  // Salud
  { ticker: 'LLY', name: 'Eli Lilly and Company', sector: 'Salud', color: '#E11D48', price: 818.00, deltaPct: 1.54, low: 806.00, high: 822.00, volMultiple: 1.4, cedearRatio: '56:1', cedearRatioNum: 56, cedearArsPrice: 17073, cclImplicit: 1168.8, iv30d: 29.2, signal: 'Demanda global GLP-1 sostenida' },
  { ticker: 'UNH', name: 'UnitedHealth Group', sector: 'Salud', color: '#2563EB', price: 594.20, deltaPct: 0.48, low: 590.00, high: 597.00, volMultiple: 0.9, cedearRatio: '33:1', cedearRatioNum: 33, cedearArsPrice: 21045, cclImplicit: 1168.8, iv30d: 21.0, signal: 'Cobertura defensiva institucional' },
  { ticker: 'JNJ', name: 'Johnson & Johnson', sector: 'Salud', color: '#DC2626', price: 156.80, deltaPct: -0.22, low: 155.90, high: 157.40, volMultiple: 0.8, cedearRatio: '15:1', cedearRatioNum: 15, cedearArsPrice: 12218, cclImplicit: 1168.8, iv30d: 14.2, signal: 'Baja beta y dividendo estable' },
  { ticker: 'ABBV', name: 'AbbVie Inc.', sector: 'Salud', color: '#4F46E5', price: 174.50, deltaPct: 0.88, low: 172.80, high: 175.20, volMultiple: 1.1, cedearRatio: '10:1', cedearRatioNum: 10, cedearArsPrice: 20396, cclImplicit: 1168.8, iv30d: 22.4, signal: 'Recuperación post-ajuste' },

  // Industrial
  { ticker: 'CAT', name: 'Caterpillar Inc.', sector: 'Industrial', color: '#EAB308', price: 392.40, deltaPct: 1.35, low: 387.00, high: 394.50, volMultiple: 1.2, cedearRatio: '20:1', cedearRatioNum: 20, cedearArsPrice: 22932, cclImplicit: 1168.8, iv30d: 23.8, signal: 'Tracción en infraestructura EE.UU.' },
  { ticker: 'GE', name: 'GE Aerospace', sector: 'Industrial', color: '#0284C7', price: 182.60, deltaPct: 1.72, low: 179.40, high: 183.50, volMultiple: 1.3, cedearRatio: '8:1', cedearRatioNum: 8, cedearArsPrice: 26678, cclImplicit: 1168.8, iv30d: 25.6, signal: 'Fuerte cartera de pedidos aeroespacial' },
  { ticker: 'BA', name: 'The Boeing Company', sector: 'Industrial', color: '#1D4ED8', price: 151.20, deltaPct: -1.42, low: 149.80, high: 154.00, volMultiple: 1.5, cedearRatio: '6:1', cedearRatioNum: 6, cedearArsPrice: 29454, cclImplicit: 1168.8, iv30d: 33.4, signal: 'Presión vendedora en resistencias' },
  { ticker: 'DE', name: 'Deere & Company', sector: 'Industrial', color: '#16A34A', price: 412.00, deltaPct: 0.91, low: 408.00, high: 414.20, volMultiple: 1.0, cedearRatio: '40:1', cedearRatioNum: 40, cedearArsPrice: 12038, cclImplicit: 1168.7, iv30d: 21.9, signal: 'Piso cíclico en maquinaria agrícola' },

  // Índices / ETF
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', sector: 'Índices / ETF', color: '#10B981', price: 598.42, deltaPct: 0.78, low: 594.10, high: 599.20, volMultiple: 1.2, cedearRatio: '20:1', cedearRatioNum: 20, cedearArsPrice: 34970, cclImplicit: 1168.7, iv30d: 13.8, signal: 'Máximo histórico intradiario' },
  { ticker: 'QQQ', name: 'Invesco QQQ Nasdaq 100', sector: 'Índices / ETF', color: '#8B5CF6', price: 518.90, deltaPct: 1.14, low: 513.40, high: 520.10, volMultiple: 1.4, cedearRatio: '20:1', cedearRatioNum: 20, cedearArsPrice: 30325, cclImplicit: 1168.8, iv30d: 17.4, signal: 'Liderazgo de semiconductores' },
  { ticker: 'IWM', name: 'iShares Russell 2000 ETF', sector: 'Índices / ETF', color: '#F59E0B', price: 224.15, deltaPct: 0.62, low: 222.10, high: 225.00, volMultiple: 1.3, cedearRatio: '10:1', cedearRatioNum: 10, cedearArsPrice: 26198, cclImplicit: 1168.8, iv30d: 21.2, signal: 'Rotación hacia Small Caps' },
  { ticker: 'EWZ', name: 'iShares MSCI Brazil ETF', sector: 'Índices / ETF', color: '#22C55E', price: 28.45, deltaPct: 1.68, low: 27.95, high: 28.60, volMultiple: 1.5, cedearRatio: '2:1', cedearRatioNum: 2, cedearArsPrice: 16626, cclImplicit: 1168.8, iv30d: 26.8, signal: 'Compresión de prima de riesgo' },
  { ticker: 'XLE', name: 'Energy Select Sector SPDR', sector: 'Índices / ETF', color: '#EA580C', price: 93.40, deltaPct: 0.62, low: 92.50, high: 93.85, volMultiple: 1.0, cedearRatio: '2:1', cedearRatioNum: 2, cedearArsPrice: 54580, cclImplicit: 1168.7, iv30d: 20.4, signal: 'Rebote desde soporte 50d' },
  { ticker: 'XLF', name: 'Financial Select Sector SPDR', sector: 'Índices / ETF', color: '#3B82F6', price: 49.85, deltaPct: 1.05, low: 49.30, high: 50.05, volMultiple: 1.3, cedearRatio: '2:1', cedearRatioNum: 2, cedearArsPrice: 29132, cclImplicit: 1168.8, iv30d: 16.9, signal: 'Curva Treasury favorece bancos' },
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

export const ROFEX_FUTURES: FutureContractRow[] = [
  { contract: 'DLR/MAY26', maturity: '29/05/2026', days: 17, price: 1084.5, deltaPct: -0.18, implicitDevalPct: 1.38, tnaImplicit: 29.6, teaImplicit: 34.4, openInterestM: 845, volumeM: 312, lecapRefTicker: 'S29Y6', lecapTna: 30.8, syntheticUsdRatePct: 1.15 },
  { contract: 'DLR/JUN26', maturity: '30/06/2026', days: 49, price: 1108.0, deltaPct: -0.24, implicitDevalPct: 3.58, tnaImplicit: 26.7, teaImplicit: 30.3, openInterestM: 690, volumeM: 215, lecapRefTicker: 'S30J6', lecapTna: 29.8, syntheticUsdRatePct: 2.95 },
  { contract: 'DLR/JUL26', maturity: '31/07/2026', days: 80, price: 1131.5, deltaPct: -0.31, implicitDevalPct: 5.77, tnaImplicit: 26.3, teaImplicit: 29.6, openInterestM: 420, volumeM: 128, lecapRefTicker: 'S31L6', lecapTna: 29.5, syntheticUsdRatePct: 3.02 },
  { contract: 'DLR/AGO26', maturity: '31/08/2026', days: 111, price: 1156.0, deltaPct: -0.29, implicitDevalPct: 8.06, tnaImplicit: 26.5, teaImplicit: 29.7, openInterestM: 310, volumeM: 94, lecapRefTicker: 'S15G6', lecapTna: 29.2, syntheticUsdRatePct: 2.52 },
  { contract: 'DLR/SEP26', maturity: '30/09/2026', days: 141, price: 1180.0, deltaPct: -0.35, implicitDevalPct: 10.30, tnaImplicit: 26.7, teaImplicit: 29.7, openInterestM: 195, volumeM: 52, lecapRefTicker: 'S30S6', lecapTna: 29.0, syntheticUsdRatePct: 2.15 },
  { contract: 'DLR/OCT26', maturity: '30/10/2026', days: 171, price: 1205.5, deltaPct: -0.40, implicitDevalPct: 12.69, tnaImplicit: 27.1, teaImplicit: 30.0, openInterestM: 140, volumeM: 38, lecapRefTicker: 'S30O6', lecapTna: 28.9, syntheticUsdRatePct: 1.68 },
  { contract: 'DLR/DIC26', maturity: '30/12/2026', days: 232, price: 1258.0, deltaPct: -0.45, implicitDevalPct: 17.60, tnaImplicit: 27.7, teaImplicit: 30.3, openInterestM: 280, volumeM: 76, lecapRefTicker: 'T15D6', lecapTna: 29.1, syntheticUsdRatePct: 1.28 },
];

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

export const CAUCIONES_DATA: CaucionRow[] = [
  { termDays: 1, currency: 'ARS', tnaWeighted: 33.50, teaEffective: 39.85, minTna: 31.80, maxTna: 34.90, bidTna: 33.40, askTna: 33.60, volumeM: 284500, shareOfTotalPct: 68.4 },
  { termDays: 3, currency: 'ARS', tnaWeighted: 33.80, teaEffective: 40.25, minTna: 32.50, maxTna: 34.60, bidTna: 33.65, askTna: 33.90, volumeM: 42100, shareOfTotalPct: 10.1 },
  { termDays: 7, currency: 'ARS', tnaWeighted: 34.10, teaEffective: 40.62, minTna: 33.20, maxTna: 35.00, bidTna: 33.95, askTna: 34.25, volumeM: 58900, shareOfTotalPct: 14.2 },
  { termDays: 14, currency: 'ARS', tnaWeighted: 34.45, teaEffective: 40.98, minTna: 33.80, maxTna: 35.20, bidTna: 34.30, askTna: 34.60, volumeM: 18400, shareOfTotalPct: 4.4 },
  { termDays: 30, currency: 'ARS', tnaWeighted: 34.90, teaEffective: 41.38, minTna: 34.20, maxTna: 35.80, bidTna: 34.70, askTna: 35.10, volumeM: 12100, shareOfTotalPct: 2.9 },
];

export interface RatioArbitragePair {
  id: string;
  pairTitle: string;
  category: 'Legislación Bonos' | 'Bancos Relativo' | 'Energía Relativo' | 'Índices en USD';
  currentRatio: number;
  unit: string;
  mean90d: number;
  stdDev90d: number;
  zScore: number;
  percentile90d: number;
  signal: string;
  recommendation: string;
  history: number[];
}

export const RATIO_PAIRS: RatioArbitragePair[] = [
  {
    id: 'gd30-al30',
    pairTitle: 'Spread Legislación GD30D / AL30D',
    category: 'Legislación Bonos',
    currentRatio: 3.27,
    unit: '%',
    mean90d: 4.85,
    stdDev90d: 0.92,
    zScore: -1.72,
    percentile90d: 7,
    signal: 'En piso de −1,7σ (Ley NY barata)',
    recommendation: 'Arbitrar vendiendo AL30D y comprando GD30D pagando solo 3,27 % por protección Ley NY.',
    history: [6.2, 5.8, 5.4, 5.1, 4.7, 4.3, 3.9, 3.6, 3.27],
  },
  {
    id: 'ggal-bma',
    pairTitle: 'Ratio GGAL / BMA (Local ARS)',
    category: 'Bancos Relativo',
    currentRatio: 0.658,
    unit: '×',
    mean90d: 0.632,
    stdDev90d: 0.014,
    zScore: 1.86,
    percentile90d: 94,
    signal: 'En techo de +1,9σ (GGAL extendida)',
    recommendation: 'Rotación táctica hacia BMA o lanzamiento de calls cubiertos en GGAL sobre +1,5σ del ratio.',
    history: [0.615, 0.622, 0.628, 0.635, 0.641, 0.649, 0.654, 0.658],
  },
  {
    id: 'ypfd-pamp',
    pairTitle: 'Ratio YPFD / PAMP',
    category: 'Energía Relativo',
    currentRatio: 11.61,
    unit: '×',
    mean90d: 11.54,
    stdDev90d: 0.38,
    zScore: 0.18,
    percentile90d: 56,
    signal: 'En equilibrio (+0,2σ de su mediana)',
    recommendation: 'Sin desarbitraje estadístico relevante; mantener ponderación neutral entre oil & gas y utilities.',
    history: [11.2, 11.4, 11.7, 11.5, 11.3, 11.55, 11.61],
  },
  {
    id: 'merval-ccl',
    pairTitle: 'S&P Merval en USD CCL',
    category: 'Índices en USD',
    currentRatio: 1948,
    unit: 'USD',
    mean90d: 1765,
    stdDev90d: 110,
    zScore: 1.66,
    percentile90d: 91,
    signal: 'Superando resistencia de 2018 en USD',
    recommendation: 'Acompañar tendencia con stops dinámicos o protección vía puts OTM baratos (VI en piso).',
    history: [1590, 1640, 1710, 1780, 1825, 1890, 1920, 1948],
  },
];

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

export const INITIAL_POSITIONS: PortfolioPosition[] = [
  {
    id: 'pos-1',
    ticker: 'GGAL',
    instrumentType: 'Acción',
    qty: 5000,
    avgPrice: 5890.0,
    lastPrice: 6480.0,
    marketValueArs: 32400000,
    pnlDayArs: 1300000,
    pnlDayPct: 4.18,
    pnlTotalArs: 2950000,
    pnlTotalPct: 10.02,
    deltaEqArs: 32400000,
    thetaDayArs: 0,
  },
  {
    id: 'pos-2',
    ticker: 'GFGC6800JU',
    instrumentType: 'Opción Call',
    qty: -50, // 50 lotes lanzados = 5000 acciones
    avgPrice: 295.0,
    lastPrice: 259.0,
    marketValueArs: -1295000,
    pnlDayArs: -195000,
    pnlDayPct: -17.7,
    pnlTotalArs: 180000,
    pnlTotalPct: 12.20,
    deltaEqArs: -12636000,
    thetaDayArs: 36400,
  },
  {
    id: 'pos-3',
    ticker: 'AL30',
    instrumentType: 'Bono Soberano',
    qty: 35000,
    avgPrice: 774.0, // $ 77.400 cada 100 VN -> $774 unitario
    lastPrice: 820.3,
    marketValueArs: 28710500,
    pnlDayArs: 441000,
    pnlDayPct: 1.56,
    pnlTotalArs: 1620500,
    pnlTotalPct: 5.98,
    deltaEqArs: 0,
    thetaDayArs: 9800,
  },
  {
    id: 'pos-4',
    ticker: 'S30J6',
    instrumentType: 'LECAP',
    qty: 150000,
    avgPrice: 129.8,
    lastPrice: 134.25,
    marketValueArs: 20137500,
    pnlDayArs: 56200,
    pnlDayPct: 0.28,
    pnlTotalArs: 667500,
    pnlTotalPct: 3.43,
    deltaEqArs: 0,
    thetaDayArs: 18400,
  },
  {
    id: 'pos-5',
    ticker: 'GFGV5900JU',
    instrumentType: 'Opción Put',
    qty: -30,
    avgPrice: 118.0,
    lastPrice: 90.5,
    marketValueArs: -271500,
    pnlDayArs: 84000,
    pnlDayPct: 23.6,
    pnlTotalArs: 82500,
    pnlTotalPct: 23.31,
    deltaEqArs: 4860000,
    thetaDayArs: 12600,
  },
];

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

export const INITIAL_ALERTS: AlertItem[] = [
  {
    id: 'al-1',
    ticker: 'GGAL',
    condition: 'Volatilidad Implícita ATM 30d <',
    target: '52,0 % (Percentil 25)',
    currentValue: '51,4 %',
    status: 'Disparada',
    triggeredAt: 'Hace 6 min · 14:42',
    priority: 'Alta',
  },
  {
    id: 'al-2',
    ticker: 'GD30 / AL30',
    condition: 'Spread por legislación <',
    target: '3,50 %',
    currentValue: '3,27 %',
    status: 'Disparada',
    triggeredAt: 'Hace 24 min · 14:24',
    priority: 'Alta',
  },
  {
    id: 'al-3',
    ticker: 'GFGC6500JU',
    condition: 'Volumen relativo intradiario >',
    target: '2,0× promedio 20 ruedas',
    currentValue: '2,4× ($ 738 M)',
    status: 'Disparada',
    triggeredAt: 'Hace 41 min · 14:07',
    priority: 'Media',
  },
  {
    id: 'al-4',
    ticker: 'Dólar CCL',
    condition: 'Cruza hacia abajo de',
    target: '$ 1.150,00',
    currentValue: '$ 1.168,80',
    status: 'Activa',
    priority: 'Media',
  },
  {
    id: 'al-5',
    ticker: 'Caución 1d',
    condition: 'TNA supera umbral de arbitraje',
    target: '36,00 % TNA',
    currentValue: '33,50 % TNA',
    status: 'Activa',
    priority: 'Info',
  },
];
