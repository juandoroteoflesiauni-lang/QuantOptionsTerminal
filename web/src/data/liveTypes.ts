export type FeedStatus = 'LIVE' | 'DIFERIDO_20M' | 'PARTIAL' | 'NO_DATA';

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

export interface UsUnifiedQuoteDto {
  readonly ticker: string;
  readonly assetType: 'stock' | 'index';
  readonly price: number | null;
  readonly change: number | null;
  readonly changePct: number | null;
  readonly previousClose: number | null;
  readonly marketStatus: string | null;
  readonly volume: number | null;
}

export interface UsSnapshotResponseDto {
  readonly status: 'OK' | 'PARTIAL';
  readonly symbol: string;
  readonly asOfUtcSec: number;
  readonly marketContext?: {
    readonly unifiedQuotes?: readonly UsUnifiedQuoteDto[];
    readonly treasury?: {
      readonly yield2Y?: number | null;
      readonly yield10Y?: number | null;
    };
    readonly vixLevel?: number | null;
  };
  readonly volSurfaceSummary?: {
    readonly iv30d?: number | null;
  } | null;
  readonly envelope?: {
    readonly metrics?: {
      readonly spot?: { readonly value: number | null };
    };
  };
}
