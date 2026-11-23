/**
 * Identidad contractual OPRA y resolución determinista del estilo de ejercicio (Pieza P1 Q3).
 *
 * Separa explícitamente las dimensiones contractuales ortogonales:
 *  - `underlyingType`: clase del subyacente (`EQUITY | ETF | INDEX | ADR | UNKNOWN`)
 *  - `exerciseStyle`: estilo de ejercicio (`AMERICAN | EUROPEAN | UNKNOWN`)
 *  - `settlementType`: liquidación contractual (`CASH | PHYSICAL | UNKNOWN`)
 *  - `exerciseStyleSource`: procedencia verificable de la resolución
 *  - `contractRoot`: raíz contractual OPRA normalizada
 *  - `optionSymbol`: símbolo normalizado del contrato
 *
 * Funciones 100 % puras: sin red, sin E/S, sin interfaz y sin mutación de argumentos.
 */

export type UsUnderlyingAssetClass = 'EQUITY' | 'ETF' | 'INDEX' | 'ADR' | 'UNKNOWN';
export type ContractualExerciseStyle = 'AMERICAN' | 'EUROPEAN' | 'UNKNOWN';
export type ContractualSettlementType = 'CASH' | 'PHYSICAL' | 'UNKNOWN';

export type ExerciseStyleResolutionSource =
  | 'CONTRACT_EXPLICIT'
  | 'OPRA_ROOT_TABLE'
  | 'STANDARD_EQUITY_ETF_DEFAULT'
  | 'CONFLICT_CONTRACT_OVERRIDES_TABLE'
  | 'UNRESOLVED_INDEX_UNKNOWN'
  | 'UNRESOLVED_CONTRACT_UNKNOWN';

export type ExerciseStyleConflictCode =
  | 'NONE'
  | 'EXPLICIT_CONFLICTS_WITH_CANONICAL_ROOT'
  | 'UNSUPPORTED_BERMUDAN_STYLE';

export interface CanonicalOpraRootSpec {
  readonly contractRoot: string;
  readonly underlyingSymbol: string;
  readonly underlyingType: UsUnderlyingAssetClass;
  readonly exerciseStyle: 'AMERICAN' | 'EUROPEAN';
  readonly settlementType: 'CASH' | 'PHYSICAL';
  readonly expirationSettlementStyle: 'AM' | 'PM' | 'PM_ALL_SESSIONS';
  readonly standardMultiplier: number;
  readonly exchangeSpecSource: string;
}

export interface ResolveUsOptionContractIdentityInput {
  readonly optionSymbol?: string | null;
  readonly underlyingSymbol?: string | null;
  readonly isIndexHint?: boolean;
  readonly explicitExerciseStyle?: string | null;
  readonly explicitUnderlyingType?: string | null;
  readonly isBinary?: boolean;
  readonly isAdjusted?: boolean;
  readonly isNonStandard?: boolean;
}

export interface ResolvedUsOptionContractIdentity {
  readonly optionSymbol: string;
  readonly contractRoot: string;
  readonly underlyingSymbol: string;
  readonly underlyingType: UsUnderlyingAssetClass;
  readonly exerciseStyle: ContractualExerciseStyle;
  readonly settlementType: ContractualSettlementType;
  readonly exerciseStyleSource: ExerciseStyleResolutionSource;
  readonly conflictCode: ExerciseStyleConflictCode;
  readonly conflictDetail: string | null;
  readonly canonicalRootSpec: CanonicalOpraRootSpec | null;
}

/**
 * Tabla canónica OPRA respaldada por especificaciones contractuales CBOE / Nasdaq PHLX.
 * Nota crítica Q3: `OEX` (S&P 100 estándar) es `AMERICAN`, mientras que `XEO`
 * (S&P 100 European-Style) es `EUROPEAN`; ambos liquidan `CASH`.
 */
export const CANONICAL_OPRA_ROOT_SPECS: Readonly<Record<string, CanonicalOpraRootSpec>> =
  Object.freeze({
    OEX: {
      contractRoot: 'OEX',
      underlyingSymbol: 'OEX',
      underlyingType: 'INDEX',
      exerciseStyle: 'AMERICAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE S&P 100 Index Options (American-style, cash-settled)',
    },
    XEO: {
      contractRoot: 'XEO',
      underlyingSymbol: 'OEX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE S&P 100 European-Style Index Options (European-style, cash-settled)',
    },
    SPX: {
      contractRoot: 'SPX',
      underlyingSymbol: 'SPX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE S&P 500 Index Options (AM-settled, European-style)',
    },
    SPXW: {
      contractRoot: 'SPXW',
      underlyingSymbol: 'SPX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE S&P 500 Weeklys / EOM Index Options (PM-settled, European-style)',
    },
    XSP: {
      contractRoot: 'XSP',
      underlyingSymbol: 'XSP',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Mini-SPX Index Options (European-style, cash-settled)',
    },
    NDX: {
      contractRoot: 'NDX',
      underlyingSymbol: 'NDX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'Nasdaq-100 Index Options (AM-settled, European-style)',
    },
    NDXP: {
      contractRoot: 'NDXP',
      underlyingSymbol: 'NDX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'Nasdaq-100 PM-Settled Index Options (European-style)',
    },
    RUT: {
      contractRoot: 'RUT',
      underlyingSymbol: 'RUT',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Russell 2000 Index Options (AM-settled, European-style)',
    },
    RUTW: {
      contractRoot: 'RUTW',
      underlyingSymbol: 'RUT',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Russell 2000 Weeklys Index Options (PM-settled, European-style)',
    },
    VIX: {
      contractRoot: 'VIX',
      underlyingSymbol: 'VIX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Volatility Index Options (AM-settled, European-style)',
    },
    VIXW: {
      contractRoot: 'VIXW',
      underlyingSymbol: 'VIX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Volatility Index Weeklys Options (AM-settled, European-style)',
    },
    DJX: {
      contractRoot: 'DJX',
      underlyingSymbol: 'DJX',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'AM',
      standardMultiplier: 100,
      exchangeSpecSource: 'CBOE Dow Jones Industrial Average Index Options (European-style)',
    },
    XND: {
      contractRoot: 'XND',
      underlyingSymbol: 'XND',
      underlyingType: 'INDEX',
      exerciseStyle: 'EUROPEAN',
      settlementType: 'CASH',
      expirationSettlementStyle: 'PM',
      standardMultiplier: 100,
      exchangeSpecSource: 'Nasdaq-100 Micro Index Options (European-style, cash-settled)',
    },
  });

const KNOWN_INDEX_SYMBOL_ROOTS: ReadonlySet<string> = new Set([
  'SPX',
  'SPXW',
  'XSP',
  'NDX',
  'NDXP',
  'RUT',
  'RUTW',
  'VIX',
  'VIXW',
  'OEX',
  'XEO',
  'DJX',
  'XND',
  'SKEW',
  'VVIX',
  'OVX',
  'DXY',
]);

const KNOWN_US_ETF_ROOTS: ReadonlySet<string> = new Set([
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'TLT',
  'HYG',
  'LQD',
  'XLF',
  'XLE',
  'XLK',
  'XLV',
  'XLY',
  'GLD',
  'SLV',
  'EWZ',
  'SMH',
  'IBIT',
]);

const KNOWN_US_ADR_ROOTS: ReadonlySet<string> = new Set([
  'GGAL',
  'YPF',
  'VIST',
  'BMA',
  'PAM',
  'MELI',
  'GLOB',
]);

const OCC_ROOT_PATTERN = /^([A-Z0-9./-]{1,6})\d{6}[CP]\d{8}$/;
const STANDARD_ALPHA_ROOT_PATTERN = /^[A-Z]{1,5}$/;
const INDEX_PREFIX_PATTERN = /^I:/i;

function normalizeCleanSymbol(raw: string | null | undefined): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim().toUpperCase();
}

function stripPrefixes(symbol: string): string {
  return symbol.replace(/^O:/i, '').replace(/^I:/i, '');
}

/**
 * Extrae la raíz contractual OPRA normalizada a partir del identificador OCC
 * (`O:OEX260619P00100000` -> `OEX`, `O:SPXW260619P05800000` -> `SPXW`).
 * Si el identificador no sigue el formato OCC, utiliza `fallbackUnderlying` sin `I:`.
 */
export function extractOpraContractRoot(
  optionSymbol: string | null | undefined,
  fallbackUnderlying?: string | null,
): string {
  const cleanOption = stripPrefixes(normalizeCleanSymbol(optionSymbol));
  if (cleanOption !== '') {
    const occMatch = OCC_ROOT_PATTERN.exec(cleanOption);
    if (occMatch !== null && occMatch[1] !== undefined) {
      return occMatch[1];
    }
  }
  const cleanFallback = stripPrefixes(normalizeCleanSymbol(fallbackUnderlying));
  if (cleanFallback !== '') {
    return cleanFallback;
  }
  return cleanOption;
}

function resolveUnderlyingClass(params: {
  readonly cleanUnderlying: string;
  readonly contractRoot: string;
  readonly isIndexHint: boolean;
  readonly explicitUnderlyingType: string;
  readonly canonicalSpec: CanonicalOpraRootSpec | null;
  readonly isBinary: boolean;
}): UsUnderlyingAssetClass {
  if (params.canonicalSpec !== null) {
    return params.canonicalSpec.underlyingType;
  }
  const explicitType = params.explicitUnderlyingType;
  if (explicitType === 'INDEX') {
    return 'INDEX';
  }
  if (explicitType === 'KPI') {
    return 'UNKNOWN';
  }
  if (
    params.isIndexHint ||
    INDEX_PREFIX_PATTERN.test(params.cleanUnderlying) ||
    KNOWN_INDEX_SYMBOL_ROOTS.has(stripPrefixes(params.cleanUnderlying)) ||
    KNOWN_INDEX_SYMBOL_ROOTS.has(params.contractRoot)
  ) {
    return 'INDEX';
  }
  if (params.isBinary) {
    return 'UNKNOWN';
  }
  if (explicitType === 'ETF' || KNOWN_US_ETF_ROOTS.has(params.contractRoot)) {
    return 'ETF';
  }
  if (explicitType === 'ADR' || KNOWN_US_ADR_ROOTS.has(params.contractRoot)) {
    return 'ADR';
  }
  if (
    explicitType === 'EQUITY' ||
    explicitType === 'STOCK' ||
    explicitType === 'STOCKS' ||
    STANDARD_ALPHA_ROOT_PATTERN.test(params.contractRoot)
  ) {
    return 'EQUITY';
  }
  return 'UNKNOWN';
}

function normalizeExplicitExerciseStyle(
  raw: string | null | undefined,
): 'AMERICAN' | 'EUROPEAN' | 'BERMUDAN' | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized === 'AMERICAN') return 'AMERICAN';
  if (normalized === 'EUROPEAN') return 'EUROPEAN';
  if (normalized === 'BERMUDAN') return 'BERMUDAN';
  return null;
}

/**
 * Resuelve la identidad contractual de una opción US aplicando la jerarquía
 * determinista estricta Q3:
 *  - Nivel 1: Estilo explícito del contrato (`CONTRACT_EXPLICIT`, o
 *    `CONFLICT_CONTRACT_OVERRIDES_TABLE` si contradice la tabla canónica OPRA).
 *  - Nivel 2: Tabla contractual canónica por raíz OPRA (`OPRA_ROOT_TABLE`).
 *  - Nivel 3: Default limitado a equities/ETFs/ADRs estándar (`STANDARD_EQUITY_ETF_DEFAULT`).
 *  - Nivel 4: Bloqueo fail-closed (`UNKNOWN`) para índices desconocidos o contratos
 *    no identificables.
 */
export function resolveUsOptionContractIdentity(
  input: ResolveUsOptionContractIdentityInput,
): ResolvedUsOptionContractIdentity {
  const cleanOptionSymbol = normalizeCleanSymbol(input.optionSymbol);
  const cleanUnderlyingInput = normalizeCleanSymbol(input.underlyingSymbol);
  const contractRoot = extractOpraContractRoot(cleanOptionSymbol, cleanUnderlyingInput);
  const canonicalSpec = CANONICAL_OPRA_ROOT_SPECS[contractRoot] ?? null;

  const isBinary = input.isBinary === true;
  const isNonStandard = input.isNonStandard === true;
  const isAdjusted = input.isAdjusted === true;
  const explicitTypeUpper =
    typeof input.explicitUnderlyingType === 'string'
      ? input.explicitUnderlyingType.trim().toUpperCase()
      : '';

  const underlyingSymbol =
    canonicalSpec?.underlyingSymbol ??
    (stripPrefixes(cleanUnderlyingInput) || contractRoot || cleanOptionSymbol);

  const underlyingType = resolveUnderlyingClass({
    cleanUnderlying: cleanUnderlyingInput,
    contractRoot,
    isIndexHint: input.isIndexHint === true,
    explicitUnderlyingType: explicitTypeUpper,
    canonicalSpec,
    isBinary,
  });

  const explicitStyle = normalizeExplicitExerciseStyle(input.explicitExerciseStyle);

  // Nivel 1 — Estilo explícito del contrato
  if (explicitStyle === 'BERMUDAN') {
    return {
      optionSymbol: cleanOptionSymbol || underlyingSymbol,
      contractRoot,
      underlyingSymbol,
      underlyingType,
      exerciseStyle: 'UNKNOWN',
      settlementType: canonicalSpec?.settlementType ?? 'UNKNOWN',
      exerciseStyleSource: 'UNRESOLVED_CONTRACT_UNKNOWN',
      conflictCode: 'UNSUPPORTED_BERMUDAN_STYLE',
      conflictDetail: `Unsupported BERMUDAN exercise style on contract "${cleanOptionSymbol || contractRoot}"`,
      canonicalRootSpec: canonicalSpec,
    };
  }

  if (explicitStyle === 'AMERICAN' || explicitStyle === 'EUROPEAN') {
    const settlementType: ContractualSettlementType =
      canonicalSpec?.settlementType ??
      (underlyingType === 'EQUITY' || underlyingType === 'ETF' || underlyingType === 'ADR'
        ? 'PHYSICAL'
        : 'UNKNOWN');

    if (canonicalSpec !== null && canonicalSpec.exerciseStyle !== explicitStyle) {
      return {
        optionSymbol: cleanOptionSymbol || underlyingSymbol,
        contractRoot,
        underlyingSymbol,
        underlyingType,
        exerciseStyle: explicitStyle,
        settlementType,
        exerciseStyleSource: 'CONFLICT_CONTRACT_OVERRIDES_TABLE',
        conflictCode: 'EXPLICIT_CONFLICTS_WITH_CANONICAL_ROOT',
        conflictDetail: `Explicit contract exerciseStyle "${explicitStyle}" conflicts with canonical OPRA root "${contractRoot}" ("${canonicalSpec.exerciseStyle}")`,
        canonicalRootSpec: canonicalSpec,
      };
    }

    return {
      optionSymbol: cleanOptionSymbol || underlyingSymbol,
      contractRoot,
      underlyingSymbol,
      underlyingType,
      exerciseStyle: explicitStyle,
      settlementType,
      exerciseStyleSource: 'CONTRACT_EXPLICIT',
      conflictCode: 'NONE',
      conflictDetail: null,
      canonicalRootSpec: canonicalSpec,
    };
  }

  // Nivel 2 — Tabla contractual por raíz OPRA
  if (canonicalSpec !== null) {
    return {
      optionSymbol: cleanOptionSymbol || underlyingSymbol,
      contractRoot,
      underlyingSymbol: canonicalSpec.underlyingSymbol,
      underlyingType: canonicalSpec.underlyingType,
      exerciseStyle: canonicalSpec.exerciseStyle,
      settlementType: canonicalSpec.settlementType,
      exerciseStyleSource: 'OPRA_ROOT_TABLE',
      conflictCode: 'NONE',
      conflictDetail: null,
      canonicalRootSpec: canonicalSpec,
    };
  }

  // Nivel 3 — Default limitado exclusivamente a equity/ETF/ADR estándar
  const eligibleStandardEquityEtf =
    (underlyingType === 'EQUITY' || underlyingType === 'ETF' || underlyingType === 'ADR') &&
    !isBinary &&
    !isNonStandard &&
    !isAdjusted &&
    STANDARD_ALPHA_ROOT_PATTERN.test(contractRoot);

  if (eligibleStandardEquityEtf) {
    return {
      optionSymbol: cleanOptionSymbol || underlyingSymbol,
      contractRoot,
      underlyingSymbol,
      underlyingType,
      exerciseStyle: 'AMERICAN',
      settlementType: 'PHYSICAL',
      exerciseStyleSource: 'STANDARD_EQUITY_ETF_DEFAULT',
      conflictCode: 'NONE',
      conflictDetail: null,
      canonicalRootSpec: null,
    };
  }

  // Nivel 4 — Contratos no identificables (fail-closed, sin default silencioso)
  return {
    optionSymbol: cleanOptionSymbol || underlyingSymbol,
    contractRoot,
    underlyingSymbol,
    underlyingType,
    exerciseStyle: 'UNKNOWN',
    settlementType: 'UNKNOWN',
    exerciseStyleSource:
      underlyingType === 'INDEX' ? 'UNRESOLVED_INDEX_UNKNOWN' : 'UNRESOLVED_CONTRACT_UNKNOWN',
    conflictCode: 'NONE',
    conflictDetail: null,
    canonicalRootSpec: null,
  };
}
