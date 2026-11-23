export const OPTION_PREFIX_TO_UNDERLYING: Readonly<Record<string, string>> = {
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

export const MONTH_CODES: Readonly<Record<string, { readonly month: number; readonly label: string; readonly code: string }>> = {
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

export interface CanonicalOptionIdentity {
  readonly market: 'BYMA_AR';
  readonly underlying: string;
  readonly nativeSeries: string | null;
  readonly side: 'call' | 'put';
  readonly contractualExpiry: string;
  readonly expiryCode: string;
  readonly strike: number;
  readonly strikeTicks1e4: number;
  readonly reportDate: string;
}

export function buildCanonicalOptionKey(identity: CanonicalOptionIdentity): string {
  const { market, underlying, contractualExpiry, side, strikeTicks1e4, reportDate } = identity;
  return [market, underlying, contractualExpiry, side, strikeTicks1e4, reportDate].join('|');
}

export function isIsoContractDate(value: string): boolean {
  const time = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value;
}

export function resolveBymaContractualExpiry(input: {
  readonly reportDate: string;
  readonly expiryCode?: string;
  readonly contractualExpiry?: string;
  readonly knownExpiries?: readonly { readonly expiryCode: string; readonly expirationDate: string }[];
  readonly arHolidays?: readonly string[];
}): { readonly contractualExpiry: string; readonly expiryCode: string } | {
  readonly code: 'MISSING_EXPIRY_CONTEXT' | 'EXPIRY_DATE_MISMATCH' | 'AMBIGUOUS_EXPIRY_YEAR' | 'AMBIGUOUS_EXPIRY_SUFFIX';
} {
  const { reportDate, contractualExpiry } = input;
  const rawCode = input.expiryCode?.trim().toUpperCase();
  const month = rawCode ? MONTH_CODES[rawCode] : undefined;
  if (rawCode && month === undefined) return { code: 'AMBIGUOUS_EXPIRY_SUFFIX' };
  if (contractualExpiry !== undefined) {
    const expiryMonth = Number(contractualExpiry.slice(5, 7));
    if (!isIsoContractDate(contractualExpiry) || (month !== undefined && month.month !== expiryMonth)) {
      return { code: 'EXPIRY_DATE_MISMATCH' };
    }
    const canonical = month ?? Object.values(MONTH_CODES).find((entry) => entry.month === expiryMonth);
    if (canonical === undefined) return { code: 'EXPIRY_DATE_MISMATCH' };
    return { contractualExpiry, expiryCode: canonical.code };
  }
  if (month === undefined) return { code: 'MISSING_EXPIRY_CONTEXT' };
  const matching = [...new Set(input.knownExpiries?.filter((expiry) =>
    MONTH_CODES[expiry.expiryCode.toUpperCase()]?.code === month.code &&
    isIsoContractDate(expiry.expirationDate) && expiry.expirationDate >= reportDate
  ).map((expiry) => expiry.expirationDate))];
  if (matching.length > 1) return { code: 'AMBIGUOUS_EXPIRY_YEAR' };
  if (matching[0] !== undefined) return { contractualExpiry: matching[0], expiryCode: month.code };

  const year = Number(reportDate.slice(0, 4));
  const holidays = new Set(input.arHolidays);
  const calendarExpiry = (expiryYear: number): string => {
    const first = new Date(Date.UTC(expiryYear, month.month - 1, 1));
    const day = 15 + (5 - first.getUTCDay() + 7) % 7;
    const expiry = new Date(Date.UTC(expiryYear, month.month - 1, day));
    while (expiry.getUTCDay() === 0 || expiry.getUTCDay() === 6 ||
           holidays.has(expiry.toISOString().slice(0, 10))) {
      expiry.setUTCDate(expiry.getUTCDate() - 1);
    }
    return expiry.toISOString().slice(0, 10);
  };
  const currentYearExpiry = calendarExpiry(year);
  return {
    contractualExpiry: currentYearExpiry < reportDate ? calendarExpiry(year + 1) : currentYearExpiry,
    expiryCode: month.code,
  };
}

export function selectAnexoBPartition<T>(record: {
  readonly asOfDate: string;
  readonly byExpiry: Readonly<Record<string, T>>;
  readonly byExpiryCode: Readonly<Record<string, readonly string[]>>;
} | null, query: {
  readonly contractualExpiry?: string;
  readonly expiryCode?: string;
  readonly reportDate?: string;
}): { readonly status: 'MATCHED'; readonly partition: T } | {
  readonly status: 'NO_STORE' | 'REPORT_DATE_MISMATCH' | 'EXPIRY_NOT_FOUND' | 'AMBIGUOUS_EXPIRY_CODE';
  readonly partition: null;
  readonly availableExpiries: readonly string[];
} {
  const availableExpiries = Object.keys(record?.byExpiry ?? {});
  if (record === null) return { status: 'NO_STORE', partition: null, availableExpiries };
  if (query.reportDate !== undefined && query.reportDate !== record.asOfDate) {
    return { status: 'REPORT_DATE_MISMATCH', partition: null, availableExpiries };
  }
  const rawCode = query.expiryCode?.trim().toUpperCase();
  const code = rawCode ? MONTH_CODES[rawCode]?.code : undefined;
  const dates = code === undefined ? [] : record.byExpiryCode[code] ?? [];
  if (query.contractualExpiry === undefined && dates.length > 1) {
    return { status: 'AMBIGUOUS_EXPIRY_CODE', partition: null, availableExpiries };
  }
  const expiry = query.contractualExpiry ?? dates[0];
  const partition = expiry !== undefined && availableExpiries.includes(expiry)
    ? record.byExpiry[expiry]
    : undefined;
  if (partition === undefined || (rawCode && !dates.includes(expiry ?? ''))) {
    return { status: 'EXPIRY_NOT_FOUND', partition: null, availableExpiries };
  }
  return { status: 'MATCHED', partition };
}
