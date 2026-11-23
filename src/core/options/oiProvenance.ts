export type ArMarketFieldSource = 'DATA912' | 'BMB_HOMEBROKER_BRIDGE' | 'OPEN_BYMA' |
  'PRIMARY_ROFEX' | 'IOL' | 'IAMC_ANEXO_B' | 'NONE';
type NonIamcSource = Exclude<ArMarketFieldSource, 'NONE' | 'IAMC_ANEXO_B'>;
export type ContractMultiplierSource = 'EXCHANGE_CONTRACT_SPEC' | 'BYMA_STANDARD_TABLE' | 'UNVERIFIED';
type VerifiedMultiplier = {
  readonly contractMultiplier: number;
  readonly multiplierSource: Exclude<ContractMultiplierSource, 'UNVERIFIED'>;
};
export type DealerSignBasis = 'THEORETICAL_DEALER_PROXY';
export type FieldObservationQuality = 'OBSERVED' | 'STALE' | 'MISSING' | 'INVALID';
export interface ScalarFieldProvenance {
  readonly value: number | null;
  readonly source: ArMarketFieldSource;
  readonly asOfUtcSec: number | null;
  readonly quality: FieldObservationQuality;
}

export interface OiSourceConflictRecord {
  readonly winnerSource: ArMarketFieldSource;
  readonly winnerValue: number;
  readonly alternateSource: ArMarketFieldSource;
  readonly alternateValue: number;
  readonly unit: 'SHARES' | 'CONTRACTS';
  readonly resolutionPolicy: 'PRECEDENCE_APPLIED' | 'REJECTED_AMBIGUOUS';
}

type Observed = { readonly quality: 'OBSERVED'; readonly nominalShares: number; readonly asOfUtcSec: number | null };
export type OiFieldProvenance =
  | (Observed & {
      readonly status: 'IAMC_ANEXO_B';
      readonly source: 'IAMC_ANEXO_B';
      readonly unit: 'SHARES';
      readonly appliedMultiplier: 1;
      readonly reportDate: string;
      readonly contractualExpiry: string;
      readonly conflict?: OiSourceConflictRecord;
    })
  | (Observed & VerifiedMultiplier & {
      readonly status: 'DIRECT_CONTRACT_OI';
      readonly source: NonIamcSource;
      readonly unit: 'CONTRACTS';
      readonly contracts: number;
      readonly conflict?: OiSourceConflictRecord;
    })
  | (Observed & VerifiedMultiplier & {
      readonly status: 'EXPLICIT_PROXY';
      readonly source: NonIamcSource;
      readonly unit: 'CONTRACTS';
      readonly proxyMethod: 'VOLUME_OPT_IN';
      readonly estimatedContracts: number;
    })
  | {
      readonly status: 'MISSING_OI';
      readonly source: 'NONE';
      readonly asOfUtcSec: null;
      readonly quality: 'MISSING';
      readonly reason: 'FIELD_ABSENT_IN_FEED' | 'L1_OVERLAY_NO_OI' | 'ANEXO_B_NOT_LOADED' | 'ANEXO_B_EXPIRY_NOT_FOUND';
    }
  | {
      readonly status: 'INVALID_OI';
      readonly source: ArMarketFieldSource;
      readonly asOfUtcSec: number | null;
      readonly quality: 'INVALID';
      readonly reason: 'NEGATIVE_OI' | 'NON_FINITE_OI' | 'UNVERIFIED_MULTIPLIER' | 'SOURCE_CONFLICT' | 'NON_INTEGER_OI';
      readonly rawValue: number | string | null;
      readonly conflict?: OiSourceConflictRecord;
    };
export type OiProvenanceStatus = OiFieldProvenance['status'];
export type OiQualityTier = 'IAMC_ANEXO_B_EXACT' | 'DIRECT_CONTRACT_OI_EXACT' |
  'PARTIAL_DIRECT_OI' | 'EXPLICIT_PROXY_OPT_IN' | 'MISSING_OI' | 'INVALID_OI';
export type GexComputationStatus = 'VALID_CONTRACT_OI' | 'VALID_IAMC_ANEXO_B' |
  'PARTIAL_COVERAGE' | 'ESTIMATED_PROXY_OPT_IN' | 'UNAVAILABLE_MISSING_OI' | 'INVALID_DATA_OR_MODEL';

type QuoteFields = 'volume' | 'bid' | 'ask' | 'bidSize' | 'askSize' | 'lastTrade';
export type OptionFieldProvenanceMap = Readonly<Record<QuoteFields, ScalarFieldProvenance>> & {
  readonly openInterest: OiFieldProvenance;
};

export function resolveContractMultiplier(
  contractMultiplier: number,
  multiplierSource: ContractMultiplierSource,
): VerifiedMultiplier | null {
  return multiplierSource !== 'UNVERIFIED' && Number.isSafeInteger(contractMultiplier) && contractMultiplier > 0
    ? { contractMultiplier, multiplierSource }
    : null;
}

export function missingOi(reason: Extract<OiFieldProvenance, { status: 'MISSING_OI' }>['reason']): OiFieldProvenance {
  return { status: 'MISSING_OI', source: 'NONE', asOfUtcSec: null, quality: 'MISSING', reason };
}

export function classifyRawOiValue(
  rawValue: unknown,
  source: NonIamcSource,
  asOfUtcSec: number | null,
  multiplier: VerifiedMultiplier | null,
): OiFieldProvenance {
  if (rawValue == null) return missingOi('FIELD_ABSENT_IN_FEED');
  const contracts = typeof rawValue === 'number' || (typeof rawValue === 'string' && rawValue.trim() !== '')
    ? Number(rawValue)
    : Number.NaN;
  const reason = !Number.isFinite(contracts) ? 'NON_FINITE_OI'
    : contracts < 0 ? 'NEGATIVE_OI'
    : !Number.isSafeInteger(contracts) ? 'NON_INTEGER_OI'
    : multiplier === null ? 'UNVERIFIED_MULTIPLIER'
    : !Number.isSafeInteger(contracts * multiplier.contractMultiplier) ? 'NON_INTEGER_OI'
    : null;
  if (reason !== null || multiplier === null) {
    return {
      status: 'INVALID_OI', source, asOfUtcSec, quality: 'INVALID', reason: reason ?? 'UNVERIFIED_MULTIPLIER',
      rawValue: typeof rawValue === 'string' || (typeof rawValue === 'number' && Number.isFinite(rawValue))
        ? rawValue : null,
    };
  }
  return {
    status: 'DIRECT_CONTRACT_OI', source, asOfUtcSec, quality: 'OBSERVED', unit: 'CONTRACTS',
    contracts, ...multiplier, nominalShares: contracts * multiplier.contractMultiplier,
  };
}

export function mergeOptionFieldProvenance(
  openInterest: OiFieldProvenance,
  values: Partial<Record<QuoteFields, number | null>>,
  source: ArMarketFieldSource,
  asOfUtcSec: number | null,
  previous?: OptionFieldProvenanceMap,
): OptionFieldProvenanceMap {
  const observe = (key: QuoteFields): ScalarFieldProvenance => {
    const value = values[key];
    if (value == null) return previous?.[key] ?? { value: null, source: 'NONE', asOfUtcSec: null, quality: 'MISSING' };
    return Number.isFinite(value)
      ? { value, source, asOfUtcSec, quality: 'OBSERVED' }
      : { value: null, source, asOfUtcSec, quality: 'INVALID' };
  };
  return {
    openInterest, volume: observe('volume'), bid: observe('bid'), ask: observe('ask'),
    bidSize: observe('bidSize'), askSize: observe('askSize'), lastTrade: observe('lastTrade'),
  };
}

export function explicitVolumeOi(
  observation: ScalarFieldProvenance | undefined,
  multiplier: VerifiedMultiplier | null,
): Extract<OiFieldProvenance, { status: 'EXPLICIT_PROXY' }> | null {
  if (observation?.quality !== 'OBSERVED' || observation.source === 'NONE' ||
      observation.source === 'IAMC_ANEXO_B' || observation.value === null || multiplier === null) return null;
  const estimatedContracts = observation.value;
  const nominalShares = estimatedContracts * multiplier.contractMultiplier;
  if (!Number.isSafeInteger(estimatedContracts) || estimatedContracts < 0 || !Number.isSafeInteger(nominalShares)) return null;
  return {
    ...multiplier, nominalShares, estimatedContracts, status: 'EXPLICIT_PROXY', proxyMethod: 'VOLUME_OPT_IN',
    unit: 'CONTRACTS', quality: 'OBSERVED', source: observation.source, asOfUtcSec: observation.asOfUtcSec,
  };
}

type DirectOi = Extract<OiFieldProvenance, { status: 'IAMC_ANEXO_B' | 'DIRECT_CONTRACT_OI' }>;
const OI_SOURCE_RANK: Readonly<Record<DirectOi['source'], number>> = {
  IAMC_ANEXO_B: 4, PRIMARY_ROFEX: 3, BMB_HOMEBROKER_BRIDGE: 2, DATA912: 1, OPEN_BYMA: 1, IOL: 1,
};

export function resolveOiSourcePrecedence(first: DirectOi, second: DirectOi): OiFieldProvenance {
  const rank = OI_SOURCE_RANK[first.source] - OI_SOURCE_RANK[second.source];
  const [winner, alternate] = rank < 0 ? [second, first] : [first, second];
  if (winner.nominalShares === alternate.nominalShares) return winner;
  const conflict: OiSourceConflictRecord = {
    winnerSource: winner.source, winnerValue: winner.nominalShares,
    alternateSource: alternate.source, alternateValue: alternate.nominalShares,
    unit: 'SHARES', resolutionPolicy: rank === 0 ? 'REJECTED_AMBIGUOUS' : 'PRECEDENCE_APPLIED',
  };
  if (rank !== 0) return { ...winner, conflict };
  return {
    status: 'INVALID_OI', source: winner.source, quality: 'INVALID', reason: 'SOURCE_CONFLICT',
    asOfUtcSec: winner.asOfUtcSec, rawValue: winner.nominalShares, conflict,
  };
}

export function resolveArExposureOiQuality(
  entries: readonly { readonly oi: OiFieldProvenance; readonly used: boolean }[],
) {
  let directContractOiInputs = 0;
  let iamcOiInputs = 0;
  let proxyOiInputs = 0;
  let missingOiInputs = 0;
  let invalidOiInputs = 0;
  let observedZeroOiInputs = 0;
  let usedDirect = 0;
  let observedIamcCount = 0;
  let observedDirectContractCount = 0;
  const oiConflicts: OiSourceConflictRecord[] = [];
  for (const { oi, used } of entries) {
    const conflict = 'conflict' in oi ? oi.conflict : undefined;
    if (conflict !== undefined) oiConflicts.push(conflict);
    if (oi.status === 'MISSING_OI') missingOiInputs += 1;
    if (oi.status === 'INVALID_OI') invalidOiInputs += 1;
    if (oi.status === 'EXPLICIT_PROXY' && used) proxyOiInputs += 1;
    if (oi.status === 'IAMC_ANEXO_B' || oi.status === 'DIRECT_CONTRACT_OI') {
      if (oi.status === 'IAMC_ANEXO_B') observedIamcCount += 1;
      else observedDirectContractCount += 1;
      if (oi.nominalShares === 0) observedZeroOiInputs += 1;
      if (used) {
        if (oi.status === 'IAMC_ANEXO_B') iamcOiInputs += 1;
        else directContractOiInputs += 1;
        usedDirect += 1;
      }
    }
  }
  const oiCoverageRatio = entries.length > 0 ? usedDirect / entries.length : 0;
  const isPartial = usedDirect > 0 && usedDirect < entries.length;
  let gexStatus: GexComputationStatus;
  let oiQuality: OiQualityTier;
  if (proxyOiInputs > 0) {
    gexStatus = invalidOiInputs > 0 ? 'INVALID_DATA_OR_MODEL' : 'ESTIMATED_PROXY_OPT_IN';
    oiQuality = invalidOiInputs > 0 ? 'INVALID_OI' : 'EXPLICIT_PROXY_OPT_IN';
  } else if (isPartial) {
    gexStatus = 'PARTIAL_COVERAGE';
    oiQuality = invalidOiInputs > 0 ? 'INVALID_OI' : 'PARTIAL_DIRECT_OI';
  } else if (usedDirect === entries.length && entries.length > 0) {
    if (iamcOiInputs > 0) {
      gexStatus = 'VALID_IAMC_ANEXO_B';
      oiQuality = 'IAMC_ANEXO_B_EXACT';
    } else {
      gexStatus = 'VALID_CONTRACT_OI';
      oiQuality = 'DIRECT_CONTRACT_OI_EXACT';
    }
  } else if (invalidOiInputs > 0) {
    gexStatus = 'INVALID_DATA_OR_MODEL';
    oiQuality = 'INVALID_OI';
  } else if (entries.length > 0 && (observedIamcCount > 0 || observedDirectContractCount > 0)) {
    gexStatus = 'INVALID_DATA_OR_MODEL';
    oiQuality =
      observedIamcCount === entries.length
        ? 'IAMC_ANEXO_B_EXACT'
        : observedDirectContractCount === entries.length
          ? 'DIRECT_CONTRACT_OI_EXACT'
          : 'PARTIAL_DIRECT_OI';
  } else {
    gexStatus = 'UNAVAILABLE_MISSING_OI';
    oiQuality = 'MISSING_OI';
  }
  return {
    gexStatus, oiQuality, oiCoverageRatio, isPartial, missingOiInputs, invalidOiInputs,
    observedZeroOiInputs, iamcOiInputs, directContractOiInputs, oiConflicts,
  };
}
