import type { ArMarketFieldSource, ContractMultiplierSource, FieldObservationQuality } from './oiProvenance.js';

export type AmericanIvStatus = 'SOLVED_AMERICAN' | 'BELOW_INTRINSIC' | 'ABOVE_UPPER_BOUND' |
  'UNIDENTIFIABLE_AMERICAN_IV' | 'SOLVER_FAILURE' | 'INVALID_INPUT' | 'STALE_INPUT';
export type OptionPricingModelId = 'AMERICAN_BS2002' | 'AMERICAN_CRR_DISCRETE' | 'EUROPEAN_BSM_DIAGNOSTIC' | 'NONE';
export type MarginRiskStatus = 'VALID_MODEL_MARGIN' | 'ESTIMATED_WITH_ASSUMPTIONS' |
  'PARTIAL_COVERAGE_CONSERVATIVE' | 'INDETERMINATE_MARGIN';
export type MarginModelBasis = 'INTERNAL_CCP_BS02_MODEL';

export interface ObservedOptionQuote {
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly last: number | null;
  readonly referencePrice: number | null;
  readonly referenceBasis: 'MID' | 'LAST' | 'NONE';
  readonly source: ArMarketFieldSource;
  readonly timestamp: number | null;
  readonly currency: 'ARS' | 'USD';
}

interface ImpliedVolEvidence {
  readonly instrumentId: string;
  readonly observedQuote: ObservedOptionQuote;
  readonly source: ArMarketFieldSource;
  readonly timestamp: number | null;
  readonly units: {
    readonly currency: 'ARS' | 'USD';
    readonly contractMultiplier: number | null;
    readonly multiplierSource: ContractMultiplierSource;
    readonly exerciseStyle: 'AMERICAN';
    readonly timeBasis: 'ACT_365';
  };
  readonly bounds: {
    readonly intrinsic: number | null;
    readonly europeanFloor: number | null;
    readonly lower: number | null;
    readonly upper: number | null;
    readonly priceMinusLower: number | null;
  };
  readonly reasonCode: string;
}

export type ImpliedVolResolution = ImpliedVolEvidence & (
  | {
      readonly modelStatus: 'SOLVED_AMERICAN';
      readonly pricingModel: 'AMERICAN_BS2002' | 'AMERICAN_CRR_DISCRETE';
      readonly impliedVol: number;
      readonly repricingError: number;
      readonly inputQuality: 'OBSERVED';
      readonly riskStatus: 'VALID_MODEL_MARGIN';
    }
  | {
      readonly modelStatus: Exclude<AmericanIvStatus, 'SOLVED_AMERICAN'>;
      readonly pricingModel: 'NONE';
      readonly impliedVol: null;
      readonly repricingError: number | null;
      readonly inputQuality: FieldObservationQuality;
      readonly riskStatus: 'INDETERMINATE_MARGIN';
      readonly diagnosticProxy?: {
        readonly iv: number;
        readonly pricingModel: 'EUROPEAN_BSM_DIAGNOSTIC';
        readonly repricingAmericanPrice: number | null;
        readonly disclaimer: 'DIAGNOSTIC_ONLY_NOT_AMERICAN_IV';
      };
    }
);
