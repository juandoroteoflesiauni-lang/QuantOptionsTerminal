import React, { useState } from 'react';

export type CompanyLogoSize = 'xs' | 'sm' | 'md' | 'lg';

export interface CompanyLogoProps {
  ticker: string;
  name?: string | null;
  size?: CompanyLogoSize;
  className?: string;
}

interface SizeToken {
  readonly boxClass: string;
  readonly textClass: string;
  readonly imgPadClass: string;
}

const SIZE_TOKENS: Readonly<Record<CompanyLogoSize, SizeToken>> = {
  xs: { boxClass: 'w-4 h-4', textClass: 'text-[7px]', imgPadClass: 'p-[1.5px]' },
  sm: { boxClass: 'w-5 h-5', textClass: 'text-[8px]', imgPadClass: 'p-[2px]' },
  md: { boxClass: 'w-[26px] h-[26px]', textClass: 'text-[9.5px]', imgPadClass: 'p-[2.5px]' },
  lg: { boxClass: 'w-[34px] h-[34px]', textClass: 'text-[11.5px]', imgPadClass: 'p-[3.5px]' },
};

/** Caché en memoria de URLs de favicon que fallaron (evita reintentos y parpadeos). */
const FAILED_FAVICON_URLS = new Set<string>();

const SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  BRKB: 'BRK.B',
  VISTA: 'VIST',
  GOOG: 'GOOGL',
  'I:SPX': 'SPY',
  SPX: 'SPY',
  'I:VIX': 'VIX',
  'DÓLAR MEP': 'MEP',
  'DOLAR MEP': 'MEP',
  'DÓLAR CCL': 'CCL',
  'DOLAR CCL': 'CCL',
  'RIESGO PAÍS': 'EMBI',
  'RIESGO PAIS': 'EMBI',
  TGS: 'TGSU2',
  TEO: 'TECO2',
  CRESY: 'CRES',
  IRS: 'IRSA',
};

const BYMA_OPTION_PREFIX_TO_UNDERLYING: Readonly<Record<string, string>> = {
  GFG: 'GGAL',
  YPF: 'YPFD',
  PAM: 'PAMP',
  BMA: 'BMA',
  SUP: 'SUPV',
  BBR: 'BBAR',
  CEP: 'CEPU',
  EDN: 'EDN',
  TGS: 'TGSU2',
  ALU: 'ALUA',
  TXA: 'TXAR',
  COM: 'COME',
  LOM: 'LOMA',
  BYM: 'BYMA',
  VAL: 'VALO',
  TEC: 'TECO2',
};

/**
 * Normaliza un símbolo arbitrario (BYMA, NYSE, índice, opción o par macro) al ticker canónico
 * utilizado en el mapa de SVGs y dominios.
 */
export function normalizeLogoTicker(rawTicker: string): string {
  const upper = rawTicker.trim().toUpperCase();
  if (!upper) return '';

  const withoutPrefix = upper.startsWith('I:') ? upper.slice(2) : upper;
  const withoutSuffix = withoutPrefix.endsWith('.BA')
    ? withoutPrefix.slice(0, -3)
    : withoutPrefix;

  const directAlias = SYMBOL_ALIASES[upper] ?? SYMBOL_ALIASES[withoutSuffix];
  if (directAlias !== undefined) {
    return directAlias;
  }

  // Opciones BYMA (ej. GFGC5000AB / YPFV42000D) -> mapear a su subyacente
  const optMatch = /^([A-Z]{3})[CV]\d/.exec(withoutSuffix);
  if (optMatch !== null) {
    const mapped = BYMA_OPTION_PREFIX_TO_UNDERLYING[optMatch[1] ?? ''];
    if (mapped !== undefined) {
      return mapped;
    }
  }

  return withoutSuffix;
}

/**
 * Nivel 2: Diccionario de dominios corporativos oficiales para resolución HD vía favicon
 * cubriendo acciones/ETFs US (~75 tickers), CEDEARs, ADRs y Panel General argentino.
 */
export const TICKER_DOMAIN_MAP: Readonly<Record<string, string>> = {
  // EE.UU. Mega Caps / Tech / Semis / Software
  AAPL: 'apple.com',
  MSFT: 'microsoft.com',
  NVDA: 'nvidia.com',
  AMZN: 'amazon.com',
  GOOGL: 'abc.xyz',
  META: 'meta.com',
  TSLA: 'tesla.com',
  ORCL: 'oracle.com',
  CRM: 'salesforce.com',
  NFLX: 'netflix.com',
  AVGO: 'broadcom.com',
  AMD: 'amd.com',
  TSM: 'tsmc.com',
  INTC: 'intel.com',
  QCOM: 'qualcomm.com',
  MU: 'micron.com',
  GLOB: 'globant.com',
  BABA: 'alibaba.com',
  MELI: 'mercadolibre.com',

  // EE.UU. Finanzas
  JPM: 'jpmorganchase.com',
  BAC: 'bankofamerica.com',
  WFC: 'wellsfargo.com',
  GS: 'goldmansachs.com',
  MS: 'morganstanley.com',
  C: 'citigroup.com',
  V: 'visa.com',
  MA: 'mastercard.com',
  'BRK.B': 'berkshirehathaway.com',
  BLK: 'blackrock.com',
  NU: 'nubank.com.br',

  // EE.UU. Consumo
  WMT: 'walmart.com',
  COST: 'costco.com',
  KO: 'coca-cola.com',
  PEP: 'pepsico.com',
  MCD: 'mcdonalds.com',
  NKE: 'nike.com',
  HD: 'homedepot.com',
  DIS: 'thewaltdisneycompany.com',
  PG: 'pg.com',

  // EE.UU. Energía
  XOM: 'exxonmobil.com',
  CVX: 'chevron.com',
  SLB: 'slb.com',
  COP: 'conocophillips.com',
  OXY: 'oxy.com',
  PBR: 'petrobras.com.br',
  YPF: 'ypf.com',
  VIST: 'vistaenergy.com',
  PAM: 'pampaenergia.com',

  // EE.UU. Salud
  LLY: 'lilly.com',
  UNH: 'unitedhealthgroup.com',
  JNJ: 'jnj.com',
  PFE: 'pfizer.com',
  ABBV: 'abbvie.com',
  MRK: 'merck.com',

  // EE.UU. Industrial
  CAT: 'caterpillar.com',
  BA: 'boeing.com',
  GE: 'ge.com',
  HON: 'honeywell.com',
  UPS: 'ups.com',
  DE: 'deere.com',
  LMT: 'lockheedmartin.com',

  // Índices / ETFs
  SPY: 'ssga.com',
  QQQ: 'invesco.com',
  DIA: 'ssga.com',
  XLF: 'ssga.com',
  XLE: 'ssga.com',
  XLK: 'ssga.com',
  XLV: 'ssga.com',
  XLI: 'ssga.com',
  GLD: 'spdrgoldshares.com',
  IWM: 'ishares.com',
  SLV: 'ishares.com',
  EWZ: 'ishares.com',
  HYG: 'ishares.com',
  LQD: 'ishares.com',
  TLT: 'ishares.com',
  EEM: 'ishares.com',

  // Argentina Panel Líder y General
  GGAL: 'galicia.ar',
  YPFD: 'ypf.com',
  PAMP: 'pampaenergia.com',
  BMA: 'macro.com.ar',
  BBAR: 'bbva.com.ar',
  SUPV: 'supervielle.com.ar',
  CEPU: 'centralpuerto.com',
  TXAR: 'ternium.com',
  ALUA: 'aluar.com.ar',
  BYMA: 'byma.com.ar',
  TRAN: 'transener.com.ar',
  TGSU2: 'tgs.com.ar',
  TGNO4: 'tgn.com.ar',
  EDN: 'edenor.com',
  METR: 'metrogas.com.ar',
  LOMA: 'lomanegra.com',
  CRES: 'cresud.com.ar',
  IRSA: 'irsa.com.ar',
  MIRG: 'mirgor.com',
  CVH: 'cablevisionholding.com',
  VALO: 'valo.ar',
  COME: 'scp.com.ar',
  TECO2: 'telecom.com.ar',
  BHIP: 'hipotecario.com.ar',
  CECO2: 'enel.com',
  AUSO: 'ausol.com.ar',
  HARG: 'holcim.com.ar',
  AGRO: 'agrometal.com',
  MORI: 'morixe.com.ar',
  BPAT: 'bancopatagonia.com.ar',
  CGPA2: 'camuzzigas.com.ar',
  DGCU2: 'ecogas.com.ar',
  SEMI: 'semino.com.ar',
  MOLI: 'molinos.com.ar',
  LEDE: 'ledesma.com.ar',
  GCLA: 'clarin.com',
  BOLT: 'boldt.com.ar',
  INVJ: 'juramento.com.ar',
  OEST: 'grupooeste.com.ar',
};

type SvgRenderer = () => React.ReactNode;

const ggalSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2A120A" />
    <path
      d="M16.8 8.3A5.8 5.8 0 1 0 17.5 14.2H12.4v-2.4h7.3c.1.5.1.9.1 1.4A7.9 7.9 0 1 1 12 4.1c2.5 0 4.6 1.1 6.1 2.8l-1.3 1.4Z"
      fill="#FF6B2C"
    />
    <circle cx="15.5" cy="9.4" r="1.4" fill="#FFB288" />
  </svg>
);

const ypfSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B2240" />
    <path d="M5 10.2h14v2.1H5z" fill="#38BDF8" />
    <path d="M5 13.8h14v2.1H5z" fill="#FFFFFF" />
    <path d="M7.5 6.8h9l-1.3 2H8.8z" fill="#0EA5E9" />
    <path d="M8.8 17.2h6.4l-1-1.5h-4.4z" fill="#38BDF8" />
  </svg>
);

const pampSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D281E" />
    <path d="M12 4.5l4.8 8.2H7.2L12 4.5Z" fill="#2EDC7E" />
    <path d="M12 19.5c-3.1 0-5.4-2.1-5.4-4.7 0-1.3.7-2.6 1.8-3.5l3.6 6.2 3.6-6.2c1.1.9 1.8 2.2 1.8 3.5 0 2.6-2.3 4.7-5.4 4.7Z" fill="#7CFFB2" />
  </svg>
);

const bmaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D1E3B" />
    <path d="M12 4.4l6.8 4.4v6.4L12 19.6l-6.8-4.4V8.8L12 4.4Z" fill="#1D4ED8" stroke="#F5B544" strokeWidth="1.4" />
    <path d="M8.5 14.8V9.2l3.5 3.1 3.5-3.1v5.6" fill="none" stroke="#FFFFFF" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const bbarSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#072146" />
    <path d="M6.5 16.5L10.2 7.5h2.4l-3.7 9H6.5Zm5.5 0l3.7-9h2.4l-3.7 9H12Z" fill="#2DCCCD" />
    <path d="M10.2 7.5h2.4l1.5 3.5h-2.4l-1.5-3.5Z" fill="#FFFFFF" />
  </svg>
);

const supvSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#320E19" />
    <path d="M16.5 7.4H9.4c-1.5 0-2.6 1-2.6 2.3 0 1.4 1.1 2.2 2.9 2.5l4.1.7c1 .2 1.6.6 1.6 1.2 0 .8-.8 1.3-2 1.3H6.8l-.8 2.2h8c2.2 0 3.8-1.2 3.8-3.1 0-1.7-1.1-2.7-3.4-3.1l-3.9-.6c-.8-.1-1.3-.4-1.3-.9s.5-.8 1.4-.8h5.3l.6-1.7Z" fill="#FF385C" />
  </svg>
);

const cepuSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0A2524" />
    <path d="M13.3 4.2L7 13h4.5l-1 6.8L17 11h-4.5l.8-6.8Z" fill="#2EDC7E" />
    <circle cx="12" cy="12" r="8.2" fill="none" stroke="#34D3C7" strokeWidth="1.2" strokeDasharray="3 2" />
  </svg>
);

const txarSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#311014" />
    <path d="M5.5 7.2h13v2.6h-5.1V18h-2.8V9.8H5.5V7.2Z" fill="#FF5468" />
    <path d="M15.8 12.2L19 18h-2.5l-1.8-3.4 1.1-2.4Z" fill="#F97316" />
  </svg>
);

const aluaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#18202C" />
    <path d="M12 5.2L18 17.5h-2.9l-1.2-2.6H10l-1.2 2.6H6L12 5.2Zm0 4.4l-1.2 3.1h2.4L12 9.6Z" fill="#E2E8F0" />
    <path d="M6.5 18.6h11v1.4h-11z" fill="#FF8A4C" />
  </svg>
);

const bymaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1D173A" />
    <rect x="6" y="13" width="2.5" height="5" rx="0.8" fill="#60A5FA" />
    <rect x="10.8" y="9.5" width="2.5" height="8.5" rx="0.8" fill="#8B7CF6" />
    <rect x="15.5" y="6" width="2.5" height="12" rx="0.8" fill="#2EDC7E" />
  </svg>
);

const tranSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2B1F0A" />
    <path d="M12 4.5l4.8 14h-2.5l-1-3.1h-2.6l-1 3.1H7.2L12 4.5Zm0 5.4l-.8 3.1h1.6L12 9.9Z" fill="#F5B544" />
    <path d="M6.5 9.2h11M7.8 12.6h8.4" stroke="#FCD34D" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const tgsu2Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B1F3A" />
    <path d="M4.8 10.5c2.4-2.8 5-2.8 7.2 0s4.8 2.8 7.2 0" fill="none" stroke="#38BDF8" strokeWidth="2.1" strokeLinecap="round" />
    <path d="M4.8 14.6c2.4-2.8 5-2.8 7.2 0s4.8 2.8 7.2 0" fill="none" stroke="#60A5FA" strokeWidth="2.1" strokeLinecap="round" />
  </svg>
);

const tgno4Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B2436" />
    <path d="M12 5.2l5 6.8-5 6.8-5-6.8 5-6.8Z" fill="#0EA5E9" />
    <path d="M12 8.2l2.6 3.8-2.6 3.8-2.6-3.8L12 8.2Z" fill="#E0F2FE" />
  </svg>
);

const ednSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#08282A" />
    <circle cx="12" cy="12" r="7" fill="none" stroke="#34D3C7" strokeWidth="2" />
    <path d="M13 7l-3.6 5.2h2.7L11 17l3.8-5.3h-2.8L13 7Z" fill="#5EEAD4" />
  </svg>
);

const metrSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B1F38" />
    <path d="M12 4.5c2.7 3 4.5 5.8 4.5 8.2A4.5 4.5 0 0 1 7.5 12.7c0-2.4 1.8-5.2 4.5-8.2Z" fill="#3B82F6" />
    <path d="M12 10.5c1.3 1.4 2.1 2.7 2.1 3.8a2.1 2.1 0 1 1-4.2 0c0-1.1.8-2.4 2.1-3.8Z" fill="#93C5FD" />
  </svg>
);

const lomaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D251C" />
    <path d="M4.8 17L9.6 7.5l3.1 5 2.4-3.3L19.2 17H4.8Z" fill="#2EDC7E" />
    <path d="M9.6 7.5l1.6 2.6-1.9 3.2-1.4-2.1 1.7-3.7Z" fill="#A7F3D0" />
  </svg>
);

const cresSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2C1A0B" />
    <path d="M12 5v14M12 8.5c-2.5 0-4-1.3-4-3 2 0 3.6 1 4 3Zm0 0c2.5 0 4-1.3 4-3-2 0-3.6 1-4 3Zm0 4c-2.8 0-4.4-1.4-4.4-3.2 2.2 0 3.8 1.1 4.4 3.2Zm0 0c2.8 0 4.4-1.4 4.4-3.2-2.2 0-3.8 1.1-4.4 3.2Z" fill="#FF8A4C" stroke="#FBBF24" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const irsaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#181A3B" />
    <rect x="6" y="9" width="3.5" height="9" rx="0.6" fill="#818CF8" />
    <rect x="10.3" y="5.5" width="3.8" height="12.5" rx="0.6" fill="#C7D2FE" />
    <rect x="14.9" y="10.8" width="3.1" height="7.2" rx="0.6" fill="#6366F1" />
  </svg>
);

const mirgSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2F1126" />
    <rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="none" stroke="#EC4899" strokeWidth="1.8" />
    <rect x="10.2" y="10.2" width="3.6" height="3.6" rx="0.6" fill="#F9A8D4" />
    <path d="M12 5v2.5M12 16.5V19M5 12h2.5M16.5 12H19" stroke="#EC4899" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const cvhSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#082430" />
    <circle cx="9.2" cy="14.8" r="2.1" fill="#06B6D4" />
    <path d="M9.2 10.6a4.2 4.2 0 0 1 4.2 4.2M9.2 6.9a7.9 7.9 0 0 1 7.9 7.9" fill="none" stroke="#22D3EE" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const valoSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#20143D" />
    <path d="M6.4 7.5h3l2.6 7.5 2.6-7.5h3L13.3 18h-2.6L6.4 7.5Z" fill="#A78BFA" />
  </svg>
);

const comeSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1F1538" />
    <circle cx="12" cy="12" r="5.5" fill="none" stroke="#8B7CF6" strokeWidth="2.1" />
    <circle cx="12" cy="12" r="2.2" fill="#C4B5FD" />
    <path d="M12 4.5v2.2M12 17.3v2.2M4.5 12h2.2M17.3 12h2.2" stroke="#8B7CF6" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const teco2Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#092136" />
    <path d="M6 8h12v2.4h-4.7V18h-2.6v-7.6H6V8Z" fill="#38BDF8" />
    <circle cx="16.8" cy="15.8" r="2" fill="#A855F7" />
  </svg>
);

const aaplSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#151822" />
    <path
      d="M14.9 12.4c0-1.6 1.3-2.5 1.4-2.5-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6c-1.1 0-2.2.7-2.8 1.7-1.2 2-.3 5 .8 6.6.6.8 1.2 1.7 2.1 1.7.8 0 1.2-.5 2.2-.5s1.3.5 2.2.5c.9 0 1.5-.8 2.1-1.6.7-1 .9-1.9.9-2-.1 0-1.8-.7-1.8-2.6Z"
      fill="#F3F4F6"
    />
    <path d="M13.5 7.5c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1.1-.4.5-.8 1.3-.7 2.1.8.1 1.6-.4 2-1Z" fill="#F3F4F6" />
  </svg>
);

const msftSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#121722" />
    <rect x="6" y="6" width="5.4" height="5.4" rx="0.6" fill="#F25022" />
    <rect x="12.6" y="6" width="5.4" height="5.4" rx="0.6" fill="#7FBA00" />
    <rect x="6" y="12.6" width="5.4" height="5.4" rx="0.6" fill="#00A4EF" />
    <rect x="12.6" y="12.6" width="5.4" height="5.4" rx="0.6" fill="#FFB900" />
  </svg>
);

const nvdaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#11240A" />
    <path
      d="M5.5 12.2c2.1-3.3 5-5 8.5-4.7 2.6.2 4.3 1.8 4.8 4.2-1.4 2.4-3.7 3.8-6.4 3.8-1.9 0-3.4-.8-4.2-2.2 1.1 1.9 3 2.9 5.3 2.7 2.2-.2 3.8-1.4 4.8-3.4-.9 2.9-3.5 4.8-6.9 4.8-3.2 0-5.1-2-5.9-5.2Z"
      fill="#76B900"
    />
    <circle cx="12.4" cy="11.6" r="2.1" fill="#A3E635" />
  </svg>
);

const amznSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1C1914" />
    <path d="M9 12.5c0-1.9 1.3-3.1 3.1-3.1 1.7 0 2.9 1 2.9 2.9v2.2h-1.8v-.8c-.5.6-1.2.9-2.1.9-1.3 0-2.1-.8-2.1-2.1Zm4-.2v-.4c0-1-.6-1.5-1.5-1.5s-1.5.6-1.5 1.5.5 1.4 1.4 1.4c1 0 1.6-.4 1.6-1Z" fill="#FFFFFF" />
    <path d="M6.4 15.8c3.3 2 7.5 2.1 11.1.2" fill="none" stroke="#FF9900" strokeWidth="1.9" strokeLinecap="round" />
    <path d="M16.2 14.9l1.8.8-.8 1.8" fill="none" stroke="#FF9900" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const googlSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#141824" />
    <path d="M12 6.2c1.6 0 2.8.6 3.7 1.4l1.9-1.9A8.2 8.2 0 0 0 4.8 8.3l2.4 1.9A5.4 5.4 0 0 1 12 6.2Z" fill="#EA4335" />
    <path d="M19.8 12.2c0-.6-.1-1.1-.2-1.6H12v3h4.4a3.8 3.8 0 0 1-1.6 2.5l2.5 1.9c1.5-1.4 2.5-3.4 2.5-5.8Z" fill="#4285F4" />
    <path d="M7.2 13.8a5.4 5.4 0 0 1 0-3.6L4.8 8.3a8.2 8.2 0 0 0 0 7.4l2.4-1.9Z" fill="#FBBC05" />
    <path d="M12 20c2.2 0 4.1-.7 5.5-2l-2.5-1.9a5.2 5.2 0 0 1-7.8-2.3l-2.4 1.9A8.2 8.2 0 0 0 12 20Z" fill="#34A853" />
  </svg>
);

const metaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B1B36" />
    <path
      d="M5.2 14.3c0-2.6 1.5-5 3.3-5 1.4 0 2.4 1.2 3.5 2.9 1.1-1.7 2.1-2.9 3.5-2.9 1.8 0 3.3 2.4 3.3 5 0 1.9-1 3.1-2.5 3.1-1.3 0-2.4-.9-4.3-3.6-1.9 2.7-3 3.6-4.3 3.6-1.5 0-2.5-1.2-2.5-3.1Z"
      fill="none"
      stroke="#38BDF8"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const tslaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2A0C10" />
    <path d="M5.5 8.1c4.2-1 8.8-1 13 0l-.8 1.5c-1.5-.3-3-.5-4.4-.5L12 18.8l-1.3-9.7c-1.4 0-2.9.2-4.4.5l-.8-1.5Z" fill="#E82127" />
    <path d="M5.8 6.7c4.1-1 8.3-1 12.4 0" fill="none" stroke="#F87171" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const spySvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D261D" />
    <path d="M5.5 15.5l4.2-4.2 3.1 2.7 5.7-6" fill="none" stroke="#2EDC7E" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15.4 8h3.1v3.1" fill="none" stroke="#2EDC7E" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const qqqSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1C153A" />
    <circle cx="11.5" cy="11.5" r="5.3" fill="none" stroke="#8B7CF6" strokeWidth="2.3" />
    <path d="M14.5 14.5l3.5 3.5" stroke="#C4B5FD" strokeWidth="2.3" strokeLinecap="round" />
  </svg>
);

const iwmSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2A1E0A" />
    <rect x="6" y="13" width="2.8" height="5" rx="0.8" fill="#F59E0B" />
    <rect x="10.6" y="9" width="2.8" height="9" rx="0.8" fill="#FBBF24" />
    <rect x="15.2" y="6.5" width="2.8" height="11.5" rx="0.8" fill="#FDE68A" />
  </svg>
);

const diaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0E2038" />
    <path d="M12 5l6.8 7-6.8 7-6.8-7L12 5Z" fill="none" stroke="#60A5FA" strokeWidth="2" />
    <path d="M12 8.5l3.5 3.5-3.5 3.5-3.5-3.5L12 8.5Z" fill="#93C5FD" />
  </svg>
);

const jpmSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0F2138" />
    <path d="M9 5.5h6l3.5 3.5v6L15 18.5H9L5.5 15V9L9 5.5Z" fill="none" stroke="#60A5FA" strokeWidth="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.6" fill="#3B82F6" />
  </svg>
);

const bacSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1D1220" />
    <path d="M5.2 9.5l5.4-2.2 2.2 1.2-5.4 2.2-2.2-1.2Z" fill="#60A5FA" />
    <path d="M8.5 12l5.4-2.2 2.2 1.2-5.4 2.2L8.5 12Z" fill="#E31837" />
    <path d="M11.6 14.5l5.4-2.2 2.2 1.2-5.4 2.2-2.2-1.2Z" fill="#E31837" />
  </svg>
);

const gsSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#122136" />
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="#7399C6" />
    <text x="12" y="14.5" textAnchor="middle" fill="#08080D" fontSize="8" fontWeight="800" fontFamily="monospace">
      GS
    </text>
  </svg>
);

const visaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#111A3D" />
    <path d="M5.5 8h3.1l2.8 8.3L14.3 8h2.9l-4.2 10.2h-3L5.5 8Z" fill="#FFFFFF" />
    <path d="M5.5 8h2.6l.9 2.2L5.5 8Z" fill="#F7B600" />
  </svg>
);

const maSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#18121B" />
    <circle cx="9.6" cy="12" r="4.8" fill="#EB001B" />
    <circle cx="14.4" cy="12" r="4.8" fill="#F79E1B" opacity="0.88" />
  </svg>
);

const amdSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#171429" />
    <path d="M6.5 6.5h11v11l-3.4-3.4V9.9H9.9L6.5 6.5Zm0 5.1v5.9h5.9l-2.6-2.6H9.1v-.7L6.5 11.6Z" fill="#FFFFFF" />
  </svg>
);

const avgoSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2B0B14" />
    <circle cx="12" cy="12" r="7" fill="none" stroke="#CC092F" strokeWidth="2.2" />
    <path d="M6.5 12h2.2l1.4-3.5 2.4 7 1.7-5 1.1 1.5h2.2" fill="none" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const nflxSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1B0A0D" />
    <path d="M8 18V6h2.6l3.4 8.2V6h2.4v12h-2.5L10.4 9.7V18H8Z" fill="#E50914" />
  </svg>
);

const meliSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2A2408" />
    <ellipse cx="12" cy="12" rx="7.2" ry="5.2" fill="#FFE600" />
    <path d="M7.6 12c1.4-1.5 3-1.5 4.4 0s3 1.5 4.4 0" fill="none" stroke="#2D3277" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const vistSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B2620" />
    <path d="M6.2 7.5h2.9l2.9 7.8 2.9-7.8h2.9L13.3 18h-2.6L6.2 7.5Z" fill="#2EDC7E" />
    <path d="M5.5 16.5c4.3-1.5 8.7-1.5 13 0" fill="none" stroke="#38BDF8" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const gldSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2B220B" />
    <path d="M7.2 8.2h9.6l1.8 7.6H5.4l1.8-7.6Z" fill="#F5B544" />
    <path d="M8.6 10.2h6.8l.9 3.6H7.7l.9-3.6Z" fill="#FDE68A" />
  </svg>
);

const slvSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#18202B" />
    <path d="M12 5l6 3.5v7L12 19l-6-3.5v-7L12 5Z" fill="#94A3B8" />
    <path d="M12 5v14M6 8.5l6 3.5 6-3.5" fill="none" stroke="#E2E8F0" strokeWidth="1.4" />
  </svg>
);

const ewzSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0A2918" />
    <path d="M12 6l7.2 6-7.2 6-7.2-6L12 6Z" fill="#FACC15" />
    <circle cx="12" cy="12" r="2.7" fill="#1D4ED8" />
  </svg>
);

const vixSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#281C0C" />
    <path d="M4.8 8.5c2.2 6.8 5.2 8 7.2 8s5-1.2 7.2-8" fill="none" stroke="#F5B544" strokeWidth="2.1" strokeLinecap="round" />
    <circle cx="12" cy="16.2" r="1.4" fill="#FDE68A" />
  </svg>
);

const fxUsdSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D251C" />
    <path d="M12 5.2v13.6M15.2 8.4c0-1.1-1.3-1.8-3.2-1.8s-3 .7-3 1.9c0 2.5 6.4 1.6 6.4 4.7 0 1.3-1.4 2.1-3.4 2.1s-3.3-.7-3.4-1.9" fill="none" stroke="#2EDC7E" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const embiSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#29141C" />
    <path d="M5.5 16l3.5-4 3 2.5 5.5-6.5" fill="none" stroke="#FF5468" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="17.5" cy="8" r="1.6" fill="#FF8A9B" />
  </svg>
);

const brkbSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2A1221" />
    <path d="M7.5 6.5h5.2c1.9 0 3.2 1 3.2 2.6 0 1.1-.6 1.9-1.6 2.3 1.3.4 2 1.3 2 2.6 0 1.8-1.4 3-3.5 3H7.5V6.5Zm2.3 4.3h2.4c.9 0 1.4-.5 1.4-1.2s-.5-1.2-1.4-1.2H9.8v2.4Zm0 4.8h2.6c1 0 1.6-.5 1.6-1.3s-.6-1.3-1.6-1.3H9.8v2.6Z" fill="#FDE68A" />
  </svg>
);

const copSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2F0F16" />
    <path d="M12.2 4.8c2.6 3.1 4.3 5.8 4.3 8.5a4.5 4.5 0 1 1-9 0c0-2.1 1.1-4.3 3.1-6.5.4 1.5 1 2.4 1.8 2.8-.3-1.7-.3-3.3-.2-4.8Z" fill="#EF4444" />
    <circle cx="12" cy="14.2" r="1.6" fill="#FCA5A5" />
  </svg>
);

const bpatSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0B2240" />
    <path d="M6.5 15.8c2.2-5 5.2-7.8 9.8-8.8L17.5 9c-3.5 1-5.8 3.2-7.5 6.8H6.5Z" fill="#38BDF8" />
    <circle cx="15.8" cy="14.2" r="2.2" fill="#F43F5E" />
  </svg>
);

const oestSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0E261E" />
    <path d="M6.2 17.2L9.8 6.8h4.4l3.6 10.4" fill="none" stroke="#34D399" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 7.5v9.2" stroke="#FBBF24" strokeWidth="1.6" strokeDasharray="2 2" strokeLinecap="round" />
  </svg>
);

/**
 * Nivel 1: SVGs vectoriales curados locales (carga instantánea, 0 red) para líderes AR y US/ETFs.
 */
const VECTOR_LOGO_REGISTRY: Readonly<Record<string, SvgRenderer>> = {
  // Líderes Argentina
  GGAL: ggalSvg,
  YPFD: ypfSvg,
  YPF: ypfSvg,
  PAMP: pampSvg,
  PAM: pampSvg,
  BMA: bmaSvg,
  BBAR: bbarSvg,
  SUPV: supvSvg,
  CEPU: cepuSvg,
  TXAR: txarSvg,
  ALUA: aluaSvg,
  BYMA: bymaSvg,
  TRAN: tranSvg,
  TGSU2: tgsu2Svg,
  TGNO4: tgno4Svg,
  EDN: ednSvg,
  METR: metrSvg,
  LOMA: lomaSvg,
  CRES: cresSvg,
  IRSA: irsaSvg,
  MIRG: mirgSvg,
  CVH: cvhSvg,
  VALO: valoSvg,
  COME: comeSvg,
  TECO2: teco2Svg,

  // Líderes EE.UU., ADRs y ETFs
  AAPL: aaplSvg,
  MSFT: msftSvg,
  NVDA: nvdaSvg,
  AMZN: amznSvg,
  GOOGL: googlSvg,
  META: metaSvg,
  TSLA: tslaSvg,
  SPY: spySvg,
  QQQ: qqqSvg,
  IWM: iwmSvg,
  DIA: diaSvg,
  JPM: jpmSvg,
  BAC: bacSvg,
  GS: gsSvg,
  V: visaSvg,
  MA: maSvg,
  AMD: amdSvg,
  AVGO: avgoSvg,
  NFLX: nflxSvg,
  MELI: meliSvg,
  VIST: vistSvg,
  GLD: gldSvg,
  SLV: slvSvg,
  EWZ: ewzSvg,
  'BRK.B': brkbSvg,
  COP: copSvg,
  BPAT: bpatSvg,
  OEST: oestSvg,

  // Índices / Macro TopBar & Relaciones
  VIX: vixSvg,
  MEP: fxUsdSvg,
  CCL: fxUsdSvg,
  EMBI: embiSvg,
};

interface DeterministicPalette {
  readonly bgHex: string;
  readonly borderHex: string;
  readonly textHex: string;
}

const MONOGRAM_PALETTES: readonly DeterministicPalette[] = [
  { bgHex: '#1D1838', borderHex: '#4C3D8F', textHex: '#C4B5FD' },
  { bgHex: '#102438', borderHex: '#255B8C', textHex: '#7DD3FC' },
  { bgHex: '#0E281E', borderHex: '#1F6347', textHex: '#6EE7B7' },
  { bgHex: '#2C200E', borderHex: '#6E4C1B', textHex: '#FCD34D' },
  { bgHex: '#2D1520', borderHex: '#6E2B48', textHex: '#FDA4AF' },
  { bgHex: '#142238', borderHex: '#2D528A', textHex: '#93C5FD' },
  { bgHex: '#122929', borderHex: '#246666', textHex: '#5EEAD4' },
  { bgHex: '#251736', borderHex: '#5A3286', textHex: '#D8B4FE' },
];

function getDeterministicPalette(symbol: string): DeterministicPalette {
  let hash = 2166136261;
  for (let i = 0; i < symbol.length; i += 1) {
    hash ^= symbol.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = Math.abs(hash) % MONOGRAM_PALETTES.length;
  return MONOGRAM_PALETTES[idx] ?? MONOGRAM_PALETTES[0]!;
}

const MACRO_MONOGRAM_OVERRIDES: Readonly<Record<string, string>> = {
  'BANCOS AR': 'BNC',
  'ENERGÍA AR': 'ENE',
  'ENERGIA AR': 'ENE',
  'REGULADAS AR': 'REG',
  'PANEL LÍDER': 'MRV',
  'PANEL LIDER': 'MRV',
};

function formatMonogramChars(rawTicker: string, normalizedTicker: string): string {
  const upperRaw = rawTicker.trim().toUpperCase();
  const macroAbbr = MACRO_MONOGRAM_OVERRIDES[upperRaw];
  if (macroAbbr !== undefined) {
    return macroAbbr;
  }
  const compact = normalizedTicker.replace(/[^A-Z0-9]/g, '');
  if (compact.length === 0) {
    return '?';
  }
  if (compact.length <= 3) {
    return compact;
  }
  return compact.slice(0, 3);
}

/**
 * Logo corporativo/ticker unificado en cascada de 3 niveles (Cero Imágenes Rotas):
 * 1) SVG vectorial local curado -> 2) Favicon HD por dominio -> 3) Monograma determinista.
 */
export const CompanyLogo: React.FC<CompanyLogoProps> = ({
  ticker,
  name,
  size = 'sm',
  className = '',
}) => {
  const normalized = normalizeLogoTicker(ticker);
  const token = SIZE_TOKENS[size];
  const baseBoxClass = `rounded-full bg-[#151520] border border-[#262636] overflow-hidden shrink-0 flex items-center justify-center select-none ${token.boxClass}`;
  const altLabel = name ? `${ticker} (${name})` : ticker;

  // Nivel 1: SVG Vectorial Local Curado
  const vectorRenderer = VECTOR_LOGO_REGISTRY[normalized];
  if (vectorRenderer !== undefined) {
    return (
      <span
        className={`${baseBoxClass} ${className}`}
        title={altLabel}
        aria-label={altLabel}
      >
        {vectorRenderer()}
      </span>
    );
  }

  // Nivel 2: Favicon HD por Dominio Corporativo
  const domain = TICKER_DOMAIN_MAP[normalized];
  const faviconUrl =
    domain !== undefined
      ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
      : null;

  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const canTryFavicon =
    faviconUrl !== null && !FAILED_FAVICON_URLS.has(faviconUrl) && failedUrl !== faviconUrl;

  if (canTryFavicon && faviconUrl !== null) {
    return (
      <span className={`${baseBoxClass} ${className}`} title={altLabel}>
        <img
          src={faviconUrl}
          alt={ticker}
          loading="lazy"
          decoding="async"
          className={`w-full h-full object-contain ${token.imgPadClass}`}
          onLoad={(ev) => {
            if (ev.currentTarget.naturalWidth === 0) {
              FAILED_FAVICON_URLS.add(faviconUrl);
              setFailedUrl(faviconUrl);
            }
          }}
          onError={() => {
            FAILED_FAVICON_URLS.add(faviconUrl);
            setFailedUrl(faviconUrl);
          }}
        />
      </span>
    );
  }

  // Nivel 3: Monograma Determinista (1-3 caracteres)
  const monoChars = formatMonogramChars(ticker, normalized);
  const palette = getDeterministicPalette(normalized || ticker);

  return (
    <span
      className={`${baseBoxClass} font-mono-num font-bold tracking-tight leading-none ${token.textClass} ${className}`}
      style={{
        backgroundColor: palette.bgHex,
        borderColor: palette.borderHex,
        color: palette.textHex,
      }}
      title={altLabel}
      aria-label={altLabel}
    >
      {monoChars}
    </span>
  );
};

export default CompanyLogo;
