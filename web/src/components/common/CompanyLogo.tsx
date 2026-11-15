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
  VALO: 'grupofinancierovalores.com.ar',
  COME: 'scp.com.ar',
  TECO2: 'telecom.com.ar',
  BHIP: 'hipotecario.com.ar',
  CECO2: 'enel.com',
  AUSO: 'ausol.com.ar',
  HARG: 'holcim.com.ar',
  SAMI: 'sa-sanmiguel.com',
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

// ─── SVG Renderers Nivel 1: 26 Emisoras Argentinas (Panel Líder + General) ────

const ggalSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#FF6B00" />
    <path
      d="M16.6 8.3a5.8 5.8 0 1 0 0 7.4"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M11.8 12h6.3m-2.3-2.3L18.1 12l-2.3 2.3"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ypfSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0055A5" />
    <rect x="4" y="8.2" width="16" height="2.2" rx="1.1" fill="#38BDF8" />
    <rect x="4" y="11" width="16" height="2.2" rx="1.1" fill="#FFFFFF" />
    <rect x="4" y="13.8" width="16" height="2.2" rx="1.1" fill="#38BDF8" />
    <path
      d="M8.5 6.3L12 10.6l3.5-4.3h-2.1L12 8.2l-1.4-1.9H8.5Z"
      fill="#FFFFFF"
    />
  </svg>
);

const pampSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#007A3D" />
    <path d="M12 24A12 12 0 0 1 12 0c-3.8 4-3.8 10 0 14 2.5 2.7 2.5 6.8 0 10Z" fill="#00529B" />
    <path d="M13 5.2L8.4 12.6h3.4l-.8 6.2 4.6-7.4h-3.4l.8-6.2Z" fill="#FFFFFF" />
  </svg>
);

const bmaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#002B5C" />
    <path
      d="M5.2 10.4a8.2 8.2 0 0 1 13.6 0"
      fill="none"
      stroke="#F59E0B"
      strokeWidth="2.3"
      strokeLinecap="round"
    />
    <path
      d="M7.4 17v-5.6l4.6 3.7 4.6-3.7V17"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const bbarSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#004481" />
    <path d="M6.2 16.5L9.9 7.5h2.2l-3.7 9H6.2Z" fill="#FFFFFF" />
    <path d="M11 16.5l3.7-9h2.2l-3.7 9H11Z" fill="#38BDF8" />
    <path d="M13.5 7.5h2.1l2.4 5.5-2.1 3.5-2.4-9Z" fill="#FFFFFF" opacity="0.92" />
  </svg>
);

const supvSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#D71920" />
    <path
      d="M16.2 7.4H9.9c-1.5 0-2.6.9-2.6 2.2 0 1.3 1 2 2.7 2.4l3.9.7c1 .2 1.6.6 1.6 1.2 0 .8-.8 1.3-2 1.3H7.4l-.8 2.2h7.6c2.2 0 3.7-1.2 3.7-3.1 0-1.6-1.1-2.6-3.3-3l-3.7-.6c-.8-.1-1.3-.4-1.3-.9s.5-.8 1.3-.8h4.8l.5-1.6Z"
      fill="#FFFFFF"
    />
  </svg>
);

const cepuSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#00529B" />
    <circle cx="12" cy="12" r="7.5" fill="none" stroke="#FACC15" strokeWidth="1.6" strokeDasharray="4 2.2" />
    <path d="M13.2 5.4L8.2 12.8h3.7l-.9 5.8 5-7.4h-3.7l.9-5.8Z" fill="#FACC15" />
  </svg>
);

const txarSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#E35205" />
    <path d="M12 0a12 12 0 0 1 12 12v1.5L13 24h-2L24 11V12" fill="#991B1B" opacity="0.55" />
    <path d="M6.2 7.2h11.6v2.6h-4.5V17.6h-2.6V9.8H6.2V7.2Z" fill="#FFFFFF" />
  </svg>
);

const aluaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1D4ED8" />
    <path d="M12 5.2L17.8 17h-2.8l-1.1-2.5H10L8.9 17H6.2L12 5.2Zm0 4.2l-1.2 2.9h2.4L12 9.4Z" fill="#FFFFFF" />
    <rect x="6.5" y="18.1" width="11" height="1.5" rx="0.75" fill="#93C5FD" />
  </svg>
);

const bymaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0284C7" />
    <rect x="5.8" y="13.2" width="2.7" height="4.8" rx="0.7" fill="#BAE6FD" />
    <rect x="10.6" y="9.8" width="2.7" height="8.2" rx="0.7" fill="#E0F2FE" />
    <rect x="15.4" y="6.2" width="2.7" height="11.8" rx="0.7" fill="#FFFFFF" />
  </svg>
);

const tranSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#DC2626" />
    <path d="M0 12h24v12H0z" fill="#1E40AF" opacity="0.88" />
    <path
      d="M12 4.8l4.2 13.4M12 4.8L7.8 18.2M6.8 9.2h10.4M8.2 13h7.6"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const tgsu2Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1E40AF" />
    <path
      d="M5 10.5c2.3-2.5 4.7-2.5 7 0s4.7 2.5 7 0"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2.1"
      strokeLinecap="round"
    />
    <path
      d="M5 14.5c2.3-2.5 4.7-2.5 7 0s4.7 2.5 7 0"
      fill="none"
      stroke="#F97316"
      strokeWidth="2.1"
      strokeLinecap="round"
    />
  </svg>
);

const tgno4Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#059669" />
    <path d="M12 4.8l5.4 7.2L12 19.2 6.6 12 12 4.8Z" fill="#FFFFFF" />
    <path d="M12 8.2l2.8 3.8L12 15.8 9.2 12 12 8.2Z" fill="#1E40AF" />
  </svg>
);

const ednSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0EA5E9" />
    <circle cx="12" cy="12" r="7" fill="none" stroke="#10B981" strokeWidth="2.2" />
    <path d="M13 6.8l-3.6 5.2h2.7L11 17.2l3.8-5.4H12l1-5Z" fill="#FFFFFF" />
  </svg>
);

const metrSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#EA580C" />
    <path d="M12 4.8c2.8 3 4.6 5.7 4.6 8.2a4.6 4.6 0 1 1-9.2 0c0-2.5 1.8-5.2 4.6-8.2Z" fill="#FFFFFF" />
    <path d="M12 10.6c1.2 1.3 2 2.5 2 3.6a2 2 0 1 1-4 0c0-1.1.8-2.3 2-3.6Z" fill="#1E3A8A" />
  </svg>
);

const lomaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#B91C1C" />
    <path d="M4.8 17L9.6 7.6l2.9 4.8 2.4-3.2L19.2 17H4.8Z" fill="#FFFFFF" />
    <path d="M12.5 12.4L14.9 9.2 19.2 17h-5.4l-1.3-4.6Z" fill="#CBD5E1" />
  </svg>
);

const cresSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#15803D" />
    <path
      d="M12 5.4v12.8M12 9c-2.3 0-3.7-1.2-3.7-2.8 1.9 0 3.3 1 3.7 2.8Zm0 0c2.3 0 3.7-1.2 3.7-2.8-1.9 0-3.3 1-3.7 2.8Zm0 3.9c-2.6 0-4.1-1.3-4.1-3 2.1 0 3.6 1 4.1 3Zm0 0c2.6 0 4.1-1.3 4.1-3-2.1 0-3.6 1-4.1 3Z"
      fill="#FFFFFF"
      stroke="#FFFFFF"
      strokeWidth="1"
      strokeLinecap="round"
    />
    <path d="M6.2 18.2a9 9 0 0 1 11.6 0" fill="none" stroke="#BBF7D0" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const irsaSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1D4ED8" />
    <rect x="5.8" y="9.5" width="3.4" height="8.5" rx="0.5" fill="#93C5FD" />
    <path d="M10.3 6.6l3.8-1.3V18h-3.8V6.6Z" fill="#FFFFFF" />
    <rect x="15" y="10.8" width="3.2" height="7.2" rx="0.5" fill="#BFDBFE" />
  </svg>
);

const mirgSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#2563EB" />
    <rect x="7.4" y="7.4" width="9.2" height="9.2" rx="1.8" fill="none" stroke="#FFFFFF" strokeWidth="1.8" />
    <rect x="10.2" y="10.2" width="3.6" height="3.6" rx="0.6" fill="#FFFFFF" />
    <path d="M12 4.8v2.6M12 16.6v2.6M4.8 12h2.6M16.6 12h2.6" stroke="#93C5FD" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const cvhSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#F97316" />
    <circle cx="8.8" cy="15.2" r="2.1" fill="#FFFFFF" />
    <path
      d="M8.8 11a4.2 4.2 0 0 1 4.2 4.2M8.8 7.2a8 8 0 0 1 8 8"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

const valoSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#1E3A8A" />
    <path d="M6.3 7.4h3l2.7 7.6 2.7-7.6h3L13.3 18h-2.6L6.3 7.4Z" fill="#FFFFFF" />
    <rect x="8" y="18.6" width="8" height="1.3" rx="0.65" fill="#60A5FA" />
  </svg>
);

const comeSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#991B1B" />
    <circle cx="12" cy="12" r="5.3" fill="none" stroke="#CBD5E1" strokeWidth="2.1" />
    <circle cx="12" cy="12" r="2.1" fill="#FFFFFF" />
    <path d="M12 4.6v2.1M12 17.3v2.1M4.6 12h2.1M17.3 12h2.1" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const hargSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0D9488" />
    <path d="M7 6.8h2.8v4.2h4.4V6.8H17v10.4h-2.8v-4H9.8v4H7V6.8Z" fill="#FFFFFF" />
    <rect x="6.5" y="18.2" width="11" height="1.4" rx="0.7" fill="#1E3A8A" />
  </svg>
);

const samiSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#65A30D" />
    <circle cx="12" cy="12.8" r="5.4" fill="#FFFFFF" />
    <circle cx="12" cy="12.8" r="3.6" fill="#BEF264" />
    <path d="M12 7.4c.5-2.1 2-3.2 4-3.3-.2 2-1.4 3.3-4 3.3Z" fill="#FEF08A" />
  </svg>
);

const agroSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#16A34A" />
    <circle cx="12" cy="12" r="4.6" fill="none" stroke="#FFFFFF" strokeWidth="2.1" />
    <circle cx="12" cy="12" r="1.6" fill="#BBF7D0" />
    <path d="M12 5.2v2.2M12 16.6v2.2M5.2 12h2.2M16.6 12h2.2M7.2 7.2l1.6 1.6M15.2 15.2l1.6 1.6" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const moliSvg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#DC2626" />
    <circle cx="12" cy="12" r="3.2" fill="#FACC15" />
    <path
      d="M12 4.8v2.6M12 16.6v2.6M4.8 12h2.6M16.6 12h2.6M7 7l1.9 1.9M15.1 15.1L17 17M17 7l-1.9 1.9M8.9 15.1L7 17"
      stroke="#FFFFFF"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const teco2Svg: SvgRenderer = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="12" fill="#0284C7" />
    <path d="M6 8h12v2.4h-4.7V18h-2.6v-7.6H6V8Z" fill="#FFFFFF" />
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
  HARG: hargSvg,
  SAMI: samiSvg,
  AGRO: agroSvg,
  MOLI: moliSvg,
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
