/**
 * Orquestador Backend — Sub-Sector "GGAL Specialist" (Pieza 21).
 *
 * Integra de forma 100 % aditiva los 5 motores puros de `src/core/ggal/*` (Pieza 20):
 *  1) Motor 1 (`parityGap.ts`): Paridad Dual GGAL BYMA vs. ADR, CCL vs. AL30/GD30, calibración
 *     causal OU AR(1), régimen de sesión EST/EDT y predictor pre-apertura.
 *  2) Motor 2 (`volTriangle.ts`): Triángulo de volatilidad BS02 ARS vs. OPRA USD, Modos A/B de IV
 *     del CCL y correlación ADR-CCL, Skew comparado `z` y anomalías RelVal / overwriting.
 *  3) Motor 3 (`dualDensity.ts`): Densidad física t-Student P_{USD/CER} vs. densidad riesgo-neutral
 *     SVI/Breeden-Litzenberger Q_BYMA y Q_OPRA, KL y señales de dislocación de colas 10 %.
 *  4) Motor 4 (`structurePinning.ts`): Estructura Anexo B IAMC en acciones nominales, Signed GEX/Vanna/Charm,
 *     Zero-Gamma Brent, flujo Lee-Ready ADR + snapshots 20s BYMA y Pinning 15:30 ART.
 *  5) Motor 5 (`strategySelector.ts`): Selector de estrategias netas de aranceles BYMA + 21 % IVA y tasas US
 *     comparado contra equivalente OPRA USD al mismo moneyness estandarizado `z`.
 *
 * Incluye:
 *  - `GgalChainRecorder`: grabador intradiario cada 20s en rueda de snapshots BYMA (`BymaSnapshotFlowPoint`).
 *  - Almacén + parser en memoria de Anexo B IAMC (JSON estructurado o texto pegado PDF/CSV/TSV).
 *  - Soporte 24/7 en modo explícito `EOD_CIERRE` con los últimos cierres reales cuando los mercados
 *    están cerrados (fines de semana, feriados o fuera de rueda).
 *  - Política Zero Silent Fallbacks + redacción estricta de secretos `.env`.
 */

import { evaluateDualProbabilityDensity, type DualProbabilityOutput, type HistoricalDualObservation, type OptionSliceIvNode } from '../core/ggal/dualDensity.js';
import {
  evaluateParityGap,
  type CausalSpreadObservation,
  type LocalOptionPreOpenInput,
  type ParityGapInput,
  type ParityGapOutput,
  type PreOpenMacroPredictorInput,
  type SessionRegime,
  type SovereignBondCclQuote,
} from '../core/ggal/parityGap.js';
import {
  evaluateStrategySelector,
  type BymaStrategyOptionQuote,
  type OpraStrategyOptionQuote,
  type StrategyFamily,
  type StrategySelectorInput,
  type StrategySelectorOutput,
} from '../core/ggal/strategySelector.js';
import {
  DEFAULT_ANEXO_B_WEIGHTS,
  evaluateStructureAndPinning,
  type AnexoBOiBuckets,
  type AnexoBStrikeChainInput,
  type BymaSnapshotFlowPoint,
  type StructurePinningOutput,
} from '../core/ggal/structurePinning.js';
import {
  BYMA_FEE_SCHEDULE,
  DEFAULT_US_FEE_SCHEDULE,
  computeExpiration1530ArtUtcSec,
  formatIsoUtcFromSec,
  getBuenosAiresParts,
  GGAL_ADR_RATIO,
  type BidAskQuote,
  type BymaFeeSchedule,
  type ContinuousRateCurvePoint,
  type DstMode,
  type UsFeeSchedule,
} from '../core/ggal/types.js';
import {
  computeBymaOptionEvalParams,
  evaluateCrossCurrencyVolTriangle,
  type BymaOptionQuoteInput,
  type CrossCurrencyVolOutput,
  type OpraMaturitySliceInput,
  type OpraSliceQuoteInput,
} from '../core/ggal/volTriangle.js';
import {
  ArgentinaMarketRuntime,
  type ArHttpFn,
  type ArHttpRequestInit,
  type ArMacroResponse,
  type ArMonitoringResponse,
  type ArOptionExpiryDto,
  type ArOptionsResponse,
  type ArOverviewResponse,
  type ArStockDetailResponse,
} from './argentinaMarketLoader.js';
import {
  MarketRuntime,
  RuntimeNoDataError,
  sanitizeFinite,
  type JsonSafeValue,
  type TerminalBarsResponse,
  type TerminalSnapshotResponse,
} from './marketRuntime.js';
import { redactSecrets } from './runtimeCache.js';

export type GgalBadgeMode =
  | 'LIVE'
  | 'EOD_CIERRE'
  | 'DIFERIDO_20M'
  | 'STALE_DATA_LOCK'
  | 'T-1 ANEXO B'
  | 'NO_DATA';

export type ExecutionPriceBasis = 'LIVE_BID_ASK' | 'EOD_CLOSE_REFERENCE' | 'NONE';

export interface GgalSpecialistRuntimeDeps {
  readonly runtime: MarketRuntime;
  readonly arRuntime: ArgentinaMarketRuntime;
  readonly fetchFn?: ArHttpFn;
  readonly nowMsFn?: () => number;
  readonly data912BaseUrl?: string;
  readonly bcraBaseUrl?: string;
  readonly cacheTtlMs?: number;
  readonly recorderIntervalMs?: number;
  readonly maxRecorderSnapshots?: number;
  readonly maxData912StalenessSec?: number;
  readonly maxMassiveStalenessSec?: number;
  readonly maxSyncSkewSec?: number;
  readonly arHolidays?: readonly string[];
  readonly usHolidays?: readonly string[];
  readonly secrets?: readonly string[];
}

export interface GgalTelemetryHeaderDto {
  readonly asOfUtcSec: number;
  readonly timestampUtc: string;
  readonly sessionRegime: SessionRegime;
  readonly dstMode: DstMode;
  readonly marketMode: 'LIVE' | 'EOD_CIERRE';
  readonly feedStatus: GgalBadgeMode;
  readonly feedBadges: readonly GgalBadgeMode[];
  readonly executionPriceBasis: ExecutionPriceBasis;
  readonly data912TimestampSec: number | null;
  readonly massiveTimestampSec: number | null;
  readonly data912AgeSec: number | null;
  readonly massiveAgeSec: number | null;
  readonly anexoBStatus: 'T-1 ANEXO B' | 'NO_DATA';
  readonly anexoBAsOfDate: string | null;
  readonly anexoBLagTradingDays: number | null;
  readonly recorder: GgalRecorderStatusDto;
  readonly providerErrors: readonly string[];
  readonly sourceDiagnostics?: readonly string[];
}

export interface GgalRecorderSnapshotEntry {
  readonly asOfUtcSec: number;
  readonly marketMode: 'LIVE' | 'EOD_CIERRE';
  readonly sessionRegime: SessionRegime;
  readonly spotByma24hArs: number | null;
  readonly spotAdrUsd: number | null;
  readonly cclGgal24h: number | null;
  readonly optionsContractsCount: number;
}

export interface GgalRecorderStatusDto {
  readonly running: boolean;
  readonly intervalMs: number;
  readonly snapshotsCount: number;
  readonly flowPointsCount: number;
  readonly lastRecordedAtUtcSec: number | null;
}

export interface GgalHistoricalSpreadPointDto {
  readonly time: number;
  readonly date: string;
  readonly cclGgal24h: number | null;
  readonly cclSovereign: number | null;
  readonly spreadLogBps: number | null;
}

export interface GgalSovereignBondLegDto {
  readonly ticker: string;
  readonly arsBid: number | null;
  readonly arsAsk: number | null;
  readonly arsMid: number | null;
  readonly usdCBid: number | null;
  readonly usdCAsk: number | null;
  readonly usdCMid: number | null;
  readonly cclImplied: number | null;
  readonly nominalVolumeArs: number | null;
}

export interface GgalParityGapResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly result: JsonSafeValue<ParityGapOutput>;
  readonly sovereignBonds: readonly GgalSovereignBondLegDto[];
  readonly historicalSpreads: readonly GgalHistoricalSpreadPointDto[];
  readonly rateInputs: {
    readonly sofrPct: number | null;
    readonly sofrSource: string | null;
    readonly caucion1dTnaPct: number | null;
    readonly caucionSource: string | null;
  };
}

export interface GgalSmileComparisonPointDto {
  readonly strikeArs: number;
  readonly standardizedMoneynessZ: number | null;
  readonly bymaCallMidIvPct: number | null;
  readonly bymaPutMidIvPct: number | null;
  readonly theoreticalBymaIvPct: number | null;
  readonly relValVolSpreadPct: number | null;
  readonly sideBias: 'CHEAP_BYMA' | 'RICH_BYMA' | 'FAIR' | null;
  readonly arbFlag: string | null;
  readonly openInterestNom: number | null;
}

export interface GgalVolTriangleResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly frontDteCalendar: number | null;
  readonly opraMatchedExpiryDate: string | null;
  readonly result: JsonSafeValue<CrossCurrencyVolOutput> | null;
  readonly smileComparison: readonly GgalSmileComparisonPointDto[];
  readonly returnObservationsUsed: number;
  readonly impliedCclVolWingsPct?: number | null;
  readonly impliedCclMinFloorPct?: number | null;
  readonly atmCompressionPts?: number | null;
}

export interface GgalDualDensityResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly dteCalendar: number | null;
  readonly cerSource: string | null;
  readonly expectedCerGrowthOverHorizonPct: number | null;
  readonly historicalObsUsed: number;
  readonly cerSeriesCount: number;
  readonly result: JsonSafeValue<DualProbabilityOutput> | null;
}

export interface AnexoBIngestStrikeRowInput {
  readonly strikeArs: number;
  readonly callOi: AnexoBOiBuckets;
  readonly putOi: AnexoBOiBuckets;
}

export interface AnexoBIngestRequest {
  readonly asOfDate?: string;
  readonly expiryCode?: string;
  readonly sourceLabel?: string;
  readonly rawText?: string;
  readonly rows?: readonly AnexoBIngestStrikeRowInput[];
}

export interface AnexoBStoredRecord {
  readonly asOfDate: string;
  readonly expiryCode: string | null;
  readonly sourceLabel: string;
  readonly ingestedAtUtcSec: number;
  readonly rows: readonly AnexoBIngestStrikeRowInput[];
  readonly totals: {
    readonly strikesCount: number;
    readonly callCoveredNom: number;
    readonly callUncoveredNom: number;
    readonly callOppositeNom: number;
    readonly callCrossedNom: number;
    readonly putCoveredNom: number;
    readonly putUncoveredNom: number;
    readonly putOppositeNom: number;
    readonly putCrossedNom: number;
  };
}

export interface GgalData912OiFallbackItemDto {
  readonly strikeArs: number;
  readonly callTotalOiNom: number | null;
  readonly putTotalOiNom: number | null;
  readonly callIvPct: number | null;
  readonly putIvPct: number | null;
}

export interface GgalStructurePinningResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly anexoBSummary: AnexoBStoredRecord['totals'] | null;
  readonly result: JsonSafeValue<StructurePinningOutput> | null;
  readonly proxyResult?: JsonSafeValue<StructurePinningOutput> | null;
  readonly proxySource?: 'PROXY DATA912 (SIN ANEXO B)' | null;
  readonly flowBasis?: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT';
  readonly data912TotalOiFallback: readonly GgalData912OiFallbackItemDto[];
  readonly notice: string | null;
}

export interface GgalStrategySelectorRequest {
  readonly familyFilter?: StrategyFamily | 'ALL';
  readonly minEvToCostMultiple?: number;
  readonly minBymaOiNominals?: number;
  readonly minOpraOiContracts?: number;
  readonly enforceThresholds?: boolean;
  readonly maxCandidates?: number;
  readonly bymaFeeSchedule?: Partial<BymaFeeSchedule>;
  readonly usFeeSchedule?: Partial<UsFeeSchedule>;
}

export interface GgalStrategySelectorResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly frontExpiryCode: string | null;
  readonly frontExpiryDate: string | null;
  readonly backExpiryCode: string | null;
  readonly backExpiryDate: string | null;
  readonly feeScheduleUsed: JsonSafeValue<BymaFeeSchedule>;
  readonly physicalNodesCount: number;
  readonly result: JsonSafeValue<StrategySelectorOutput> | null;
}

export interface GgalSpecialistOverviewResponse {
  readonly telemetry: GgalTelemetryHeaderDto;
  readonly spot: {
    readonly byma24hArs: number | null;
    readonly bymaCiArs: number | null;
    readonly adrMidUsd: number | null;
    readonly fairBymaOpenArs: number | null;
    readonly fairAdrUsd: number | null;
    readonly gapPctVsPrevClose: number | null;
    readonly cclGgal24h: number | null;
    readonly cclSovereignBenchmark: number | null;
    readonly parityZScore: number | null;
    readonly paritySignal: string | null;
  };
  readonly volatility: {
    readonly bymaAtmIvPct: number | null;
    readonly opraAdrAtmIvPct: number | null;
    readonly impliedCclVolPct: number | null;
    readonly boundaryRegime: string | null;
    readonly anomaliesCount: number;
  };
  readonly density: {
    readonly status: 'OK' | 'NO_DATA';
    readonly studentTCopulaDof: number | null;
    readonly klBymaPvsQ: number | null;
    readonly tailSignal: string | null;
  };
  readonly structure: {
    readonly regime: string;
    readonly zeroGammaLevelArs: number | null;
    readonly callWallArs: number | null;
    readonly putWallArs: number | null;
    readonly peakPinStrikeArs: number | null;
    readonly bymaNetSignedArs: number | null;
    readonly adrNetSignedUsd: number | null;
  };
  readonly topStrategies: JsonSafeValue<StrategySelectorOutput['rankedStrategies']>;
}

export interface GgalAnexoBIngestResponse {
  readonly ok: true;
  readonly record: Omit<AnexoBStoredRecord, 'rows'> & { readonly previewRows: readonly AnexoBIngestStrikeRowInput[] };
}

interface Data912RawRow {
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly prevClose: number | null;
  readonly nominalVol: number | null;
  readonly volumeArs: number | null;
  readonly days: number | null;
  readonly tna: number | null;
  readonly rawDate: string | null;
}

interface HistoricalPriceSeriesPoint {
  readonly date: string;
  readonly time: number;
  readonly close: number;
}

interface CerObservation {
  readonly date: string;
  readonly value: number;
}

interface CachedEntry<T> {
  readonly fetchedAtMs: number;
  readonly value: T;
}

interface MarketBundle {
  readonly asOfUtcSec: number;
  readonly overview: ArOverviewResponse;
  readonly macro: ArMacroResponse;
  readonly monitoring: ArMonitoringResponse;
  readonly ggalDetail: ArStockDetailResponse;
  readonly ggalOptions: ArOptionsResponse;
  readonly usSnapshot: TerminalSnapshotResponse | null;
  readonly usBars: TerminalBarsResponse | null;
  readonly usDailyCloseBars: readonly { readonly time: number; readonly close: number }[];
  readonly liveStocks: readonly Data912RawRow[];
  readonly liveBonds: readonly Data912RawRow[];
  readonly liveNotes: readonly Data912RawRow[];
  readonly liveCauciones: readonly Data912RawRow[];
  readonly al30History: readonly HistoricalPriceSeriesPoint[];
  readonly al30cHistory: readonly HistoricalPriceSeriesPoint[];
  readonly gd30History: readonly HistoricalPriceSeriesPoint[];
  readonly gd30cHistory: readonly HistoricalPriceSeriesPoint[];
  readonly cerHistory: readonly CerObservation[];
  readonly cerVarId: number;
  readonly errors: readonly string[];
}

const DEFAULT_DATA912_BASE_URL = 'https://data912.com';
const DEFAULT_BCRA_BASE_URL = 'https://api.bcra.gob.ar';
const DEFAULT_HTTP_TIMEOUT_MS = 9_000;
const DEFAULT_CACHE_TTL_MS = 12_000;
const HISTORY_CACHE_TTL_MS = 120_000;
const DEFAULT_RECORDER_INTERVAL_MS = 20_000;
const DEFAULT_MAX_RECORDER_SNAPSHOTS = 500;
const DEFAULT_STALENESS_SEC = 20;

const ZERO_BUCKETS: AnexoBOiBuckets = {
  coveredNom: 0,
  uncoveredNom: 0,
  oppositeNom: 0,
  crossedNom: 0,
};

function defaultHttpFn(url: string, init?: ArHttpRequestInit) {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
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

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function toJsonSafe<T>(value: T): JsonSafeValue<T> {
  if (typeof value === 'number') {
    return (Number.isFinite(value) ? value : null) as JsonSafeValue<T>;
  }
  if (value === undefined) {
    return null as JsonSafeValue<T>;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value as JsonSafeValue<T>;
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => toJsonSafe(item)) as unknown as JsonSafeValue<T>;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) {
        continue;
      }
      out[k] = toJsonSafe(v);
    }
    return out as JsonSafeValue<T>;
  }
  return null as JsonSafeValue<T>;
}

function readNum(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const raw = rec[k];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw.trim().replace(',', '.'));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function readStr(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const raw = rec[k];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return raw.trim();
    }
  }
  return null;
}

function parseUtcDateKey(raw: string | null | undefined): { readonly date: string; readonly time: number } | null {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return null;
  }
  const s = raw.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (isoMatch !== null) {
    const [, yr, mo, dy] = isoMatch;
    const y = Number(yr);
    const m = Number(mo);
    const d = Number(dy);
    if (
      yr !== undefined &&
      mo !== undefined &&
      dy !== undefined &&
      Number.isInteger(y) &&
      Number.isInteger(m) &&
      Number.isInteger(d)
    ) {
      const ms = Date.UTC(y, m - 1, d, 20, 0, 0);
      if (Number.isFinite(ms)) {
        return {
          date: `${yr}-${mo}-${dy}`,
          time: Math.floor(ms / 1_000),
        };
      }
    }
  }
  const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmyMatch !== null) {
    const d = dmyMatch[1];
    const m = dmyMatch[2];
    const y = dmyMatch[3];
    if (d !== undefined && m !== undefined && y !== undefined) {
      const ms = Date.UTC(Number(y), Number(m) - 1, Number(d), 20, 0, 0);
      if (Number.isFinite(ms)) {
        return {
          date: `${y}-${m}-${d}`,
          time: Math.floor(ms / 1_000),
        };
      }
    }
  }
  const numeric = Number(s);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    const sec = numeric > 1e12 ? Math.floor(numeric / 1_000) : Math.floor(numeric);
    const parts = getBuenosAiresParts(sec);
    return { date: parts.dateKey, time: sec };
  }
  return null;
}

function parseLocalizedNumber(token: string): number {
  const cleaned = token.trim().replace(/\s+/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') {
    return Number.NaN;
  }
  // Spanish/IAMC thousands format: e.g. "125.400" or "1.250.000,50" or "125,400"
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    const normalized = cleaned.replace(/\./g, '').replace(',', '.');
    return Number(normalized);
  }
  if (/^-?\d+,\d+$/.test(cleaned)) {
    return Number(cleaned.replace(',', '.'));
  }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) {
    return Number(cleaned.replace(/,/g, ''));
  }
  return Number(cleaned);
}

/**
 * Parsea la matriz T-1 del Anexo B de IAMC desde filas JSON o texto pegado (PDF/CSV/TSV).
 * Admite:
 *  - Series individuales tipo `GFGC6500DI 120.000 45.000 18.000 5.000` (Cubierta/Descubierta/Opuesta/Cruzada)
 *  - Filas por strike `6500  120000 45000 18000 5000  20000 15000 5000 0` (Strike + 4 Call + 4 Put)
 *  - Filas `CALL 6500 120000 45000 18000 5000` / `PUT 6500 ...`
 */
export function parseAnexoBIamcInput(
  body: AnexoBIngestRequest,
  nowUtcSec: number,
): AnexoBStoredRecord {
  const defaultDate = getBuenosAiresParts(nowUtcSec).dateKey;
  let asOfDate =
    body.asOfDate !== undefined && body.asOfDate.trim() !== ''
      ? (parseUtcDateKey(body.asOfDate)?.date ?? body.asOfDate.trim())
      : null;

  const byStrike = new Map<
    number,
    { callOi: AnexoBOiBuckets; putOi: AnexoBOiBuckets }
  >();

  const mergeBuckets = (
    prev: AnexoBOiBuckets,
    next: AnexoBOiBuckets,
  ): AnexoBOiBuckets => ({
    coveredNom: prev.coveredNom + next.coveredNom,
    uncoveredNom: prev.uncoveredNom + next.uncoveredNom,
    oppositeNom: prev.oppositeNom + next.oppositeNom,
    crossedNom: prev.crossedNom + next.crossedNom,
  });

  const validateBuckets = (b: AnexoBOiBuckets, ctx: string): void => {
    const nums = [b.coveredNom, b.uncoveredNom, b.oppositeNom, b.crossedNom];
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new RuntimeNoDataError(
        'INVALID_PARAMETER',
        `Anexo B OI buckets invalid for ${ctx}: negative or non-finite values`,
        [],
        400,
      );
    }
  };

  if (body.rows !== undefined) {
    if (!Array.isArray(body.rows)) {
      throw new RuntimeNoDataError('INVALID_PARAMETER', 'Anexo B rows must be an array', [], 400);
    }
    const structuredRows: readonly AnexoBIngestStrikeRowInput[] = body.rows;
    for (let i = 0; i < structuredRows.length; i += 1) {
      const row = structuredRows[i];
      if (row === undefined || !Number.isFinite(row.strikeArs) || row.strikeArs <= 0) {
        throw new RuntimeNoDataError(
          'INVALID_PARAMETER',
          `Anexo B row[${String(i)}] has invalid strikeArs`,
          [],
          400,
        );
      }
      const callOi: AnexoBOiBuckets = row.callOi;
      const putOi: AnexoBOiBuckets = row.putOi;
      validateBuckets(callOi, `strike ${String(row.strikeArs)} callOi`);
      validateBuckets(putOi, `strike ${String(row.strikeArs)} putOi`);
      const existing = byStrike.get(row.strikeArs) ?? {
        callOi: ZERO_BUCKETS,
        putOi: ZERO_BUCKETS,
      };
      byStrike.set(row.strikeArs, {
        callOi: mergeBuckets(existing.callOi, callOi),
        putOi: mergeBuckets(existing.putOi, putOi),
      });
    }
  }

  if (typeof body.rawText === 'string' && body.rawText.trim() !== '') {
    const lines = body.rawText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }
      if (asOfDate === null) {
        const headerDateMatch = /(?:fecha|al|date)?[:\s]*(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i.exec(line);
        if (headerDateMatch?.[1] !== undefined) {
          const parsedHeader = parseUtcDateKey(headerDateMatch[1]);
          if (parsedHeader !== null) {
            asOfDate = parsedHeader.date;
          }
        }
      }

      // Tokenize by delimiter (; | tab comma-with-whitespace) or whitespace
      const rawCols = /[;\t|]/.test(line)
        ? line.split(/[;\t|]+/).map((c) => c.trim()).filter((c) => c !== '')
        : line.includes(',') && !/\d,\d{1,2}(?:$|\s)/.test(line)
          ? line.split(',').map((c) => c.trim()).filter((c) => c !== '')
          : line.split(/\s+/).map((c) => c.trim()).filter((c) => c !== '');

      if (rawCols.length < 5) {
        continue;
      }

      const firstUpper = (rawCols[0] ?? '').toUpperCase();
      // Pattern 1: BYMA ticker e.g. GFGC6500DI or GFGV6000DI + 4 buckets (+ optional total)
      const tickerMatch = /^GFG([CV])(\d+(?:[.,]\d+)?)[A-Z]{0,4}$/.exec(firstUpper);
      if (tickerMatch !== null) {
        const sideChar = tickerMatch[1];
        const strikeVal = parseLocalizedNumber(tickerMatch[2] ?? '');
        const b1 = parseLocalizedNumber(rawCols[1] ?? '');
        const b2 = parseLocalizedNumber(rawCols[2] ?? '');
        const b3 = parseLocalizedNumber(rawCols[3] ?? '');
        const b4 = parseLocalizedNumber(rawCols[4] ?? '');
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          [b1, b2, b3, b4].every((v) => Number.isFinite(v) && v >= 0)
        ) {
          const buckets: AnexoBOiBuckets = {
            coveredNom: b1,
            uncoveredNom: b2,
            oppositeNom: b3,
            crossedNom: b4,
          };
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(
            strikeVal,
            sideChar === 'C'
              ? { callOi: mergeBuckets(existing.callOi, buckets), putOi: existing.putOi }
              : { callOi: existing.callOi, putOi: mergeBuckets(existing.putOi, buckets) },
          );
          continue;
        }
      }

      // Pattern 2: Explicit side word "CALL" / "PUT" + strike + 4 buckets
      if ((firstUpper === 'CALL' || firstUpper === 'C' || firstUpper === 'PUT' || firstUpper === 'P' || firstUpper === 'V') && rawCols.length >= 6) {
        const strikeVal = parseLocalizedNumber(rawCols[1] ?? '');
        const b1 = parseLocalizedNumber(rawCols[2] ?? '');
        const b2 = parseLocalizedNumber(rawCols[3] ?? '');
        const b3 = parseLocalizedNumber(rawCols[4] ?? '');
        const b4 = parseLocalizedNumber(rawCols[5] ?? '');
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          [b1, b2, b3, b4].every((v) => Number.isFinite(v) && v >= 0)
        ) {
          const buckets: AnexoBOiBuckets = {
            coveredNom: b1,
            uncoveredNom: b2,
            oppositeNom: b3,
            crossedNom: b4,
          };
          const isCall = firstUpper === 'CALL' || firstUpper === 'C';
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(
            strikeVal,
            isCall
              ? { callOi: mergeBuckets(existing.callOi, buckets), putOi: existing.putOi }
              : { callOi: existing.callOi, putOi: mergeBuckets(existing.putOi, buckets) },
          );
          continue;
        }
      }

      // Pattern 3: Numeric strike row with 8 numeric columns (strike + call 4 + put 4)
      if (rawCols.length >= 9) {
        const nums = rawCols.slice(0, 9).map(parseLocalizedNumber);
        const strikeVal = nums[0] ?? Number.NaN;
        if (
          Number.isFinite(strikeVal) &&
          strikeVal > 0 &&
          nums.slice(1).every((n) => Number.isFinite(n) && n >= 0)
        ) {
          const callOi: AnexoBOiBuckets = {
            coveredNom: nums[1] ?? 0,
            uncoveredNom: nums[2] ?? 0,
            oppositeNom: nums[3] ?? 0,
            crossedNom: nums[4] ?? 0,
          };
          const putOi: AnexoBOiBuckets = {
            coveredNom: nums[5] ?? 0,
            uncoveredNom: nums[6] ?? 0,
            oppositeNom: nums[7] ?? 0,
            crossedNom: nums[8] ?? 0,
          };
          const existing = byStrike.get(strikeVal) ?? { callOi: ZERO_BUCKETS, putOi: ZERO_BUCKETS };
          byStrike.set(strikeVal, {
            callOi: mergeBuckets(existing.callOi, callOi),
            putOi: mergeBuckets(existing.putOi, putOi),
          });
        }
      }
    }
  }

  if (byStrike.size === 0) {
    throw new RuntimeNoDataError(
      'INVALID_PARAMETER',
      'Anexo B IAMC payload contains no parseable strike/OI rows. Provide structured `rows` or valid IAMC `rawText`.',
      [],
      400,
    );
  }

  const sortedRows: AnexoBIngestStrikeRowInput[] = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strikeArs, oi]) => ({
      strikeArs,
      callOi: oi.callOi,
      putOi: oi.putOi,
    }));

  const totals = sortedRows.reduce(
    (acc, r) => ({
      strikesCount: acc.strikesCount + 1,
      callCoveredNom: acc.callCoveredNom + r.callOi.coveredNom,
      callUncoveredNom: acc.callUncoveredNom + r.callOi.uncoveredNom,
      callOppositeNom: acc.callOppositeNom + r.callOi.oppositeNom,
      callCrossedNom: acc.callCrossedNom + r.callOi.crossedNom,
      putCoveredNom: acc.putCoveredNom + r.putOi.coveredNom,
      putUncoveredNom: acc.putUncoveredNom + r.putOi.uncoveredNom,
      putOppositeNom: acc.putOppositeNom + r.putOi.oppositeNom,
      putCrossedNom: acc.putCrossedNom + r.putOi.crossedNom,
    }),
    {
      strikesCount: 0,
      callCoveredNom: 0,
      callUncoveredNom: 0,
      callOppositeNom: 0,
      callCrossedNom: 0,
      putCoveredNom: 0,
      putUncoveredNom: 0,
      putOppositeNom: 0,
      putCrossedNom: 0,
    },
  );

  return {
    asOfDate: asOfDate ?? defaultDate,
    expiryCode: body.expiryCode?.trim() || null,
    sourceLabel: body.sourceLabel?.trim() || 'IAMC_ANEXO_B',
    ingestedAtUtcSec: nowUtcSec,
    rows: sortedRows,
    totals,
  };
}

function selectLiquidFrontAndBackExpiries(
  options: ArOptionsResponse,
): { readonly front: ArOptionExpiryDto | null; readonly back: ArOptionExpiryDto | null } {
  const withData = options.expiries.filter((exp) => exp.days >= 1 && (exp.calls.length > 0 || exp.puts.length > 0));
  if (withData.length === 0) {
    return { front: null, back: null };
  }

  const scoreExpiry = (exp: ArOptionExpiryDto): number => {
    const all = [...exp.calls, ...exp.puts];
    let quoted = 0;
    let totalOi = 0;
    let totalVol = 0;
    for (const c of all) {
      if ((c.bid !== null && c.bid > 0) || (c.ask !== null && c.ask > 0) || (c.last !== null && c.last > 0)) {
        quoted += 1;
      }
      totalOi += c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0;
      totalVol += c.volume !== null && Number.isFinite(c.volume) ? Math.max(0, c.volume) : 0;
    }
    return quoted * 1_000 + totalVol * 2 + totalOi * 0.05;
  };

  let front: ArOptionExpiryDto | null = null;
  if (options.primaryLiquidExpiryCode !== undefined && options.primaryLiquidExpiryCode !== null) {
    front = withData.find((e) => e.expiryCode === options.primaryLiquidExpiryCode) ?? null;
  }
  if (front === null) {
    // Preferir vencimiento >= 7d si existe con buena liquidez; si no, mayor score
    const min7d = withData.filter((e) => e.days >= 7);
    const pool = min7d.length > 0 ? min7d : withData;
    front = [...pool].sort((a, b) => scoreExpiry(b) - scoreExpiry(a))[0] ?? withData[0] ?? null;
  }

  let back: ArOptionExpiryDto | null = null;
  if (front !== null) {
    const later = withData.filter((e) => e.expiryUtcSec > front.expiryUtcSec);
    if (later.length > 0) {
      back = [...later].sort((a, b) => a.expiryUtcSec - b.expiryUtcSec)[0] ?? null;
    }
  }

  return { front, back };
}

function makeBidAskQuote(
  bid: number | null | undefined,
  ask: number | null | undefined,
  last: number | null | undefined,
  allowEodReference: boolean,
): { readonly quote: BidAskQuote; readonly basis: ExecutionPriceBasis } {
  if (
    bid !== null &&
    bid !== undefined &&
    ask !== null &&
    ask !== undefined &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask >= bid
  ) {
    return {
      quote: {
        bid,
        ask,
        ...(last !== null && last !== undefined && Number.isFinite(last) && last > 0 ? { last } : {}),
      },
      basis: 'LIVE_BID_ASK',
    };
  }
  if (allowEodReference && last !== null && last !== undefined && Number.isFinite(last) && last > 0) {
    return {
      quote: { bid: last, ask: last, last },
      basis: 'EOD_CLOSE_REFERENCE',
    };
  }
  return {
    quote: { bid: Number.NaN, ask: Number.NaN },
    basis: 'NONE',
  };
}

function buildArsRateCurveAndBenchmarks(
  macro: ArMacroResponse,
  options: ArOptionsResponse,
  liveCauciones: readonly Data912RawRow[],
  liveNotes: readonly Data912RawRow[],
  monitoring: ArMonitoringResponse,
): {
  readonly rateCurveArs: ContinuousRateCurvePoint[];
  readonly caucion1dTnaPct: number;
  readonly caucionSource: string | null;
  readonly lecapMatchedTnaPct: number;
} {
  // 1) Caucion 1d real si Data912 publica tasas de caución
  let caucion1dTnaPct = Number.NaN;
  let caucionSource: string | null = null;

  const pesoCauciones = liveCauciones
    .filter((r) => (r.symbol.includes('PESO') || !r.symbol.includes('USD')) && r.tna !== null && r.tna > 0)
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));

  if (pesoCauciones[0]?.tna !== null && pesoCauciones[0]?.tna !== undefined) {
    caucion1dTnaPct = pesoCauciones[0].tna;
    caucionSource = `Data912 Caución (${String(pesoCauciones[0].days ?? 1)}d)`;
  } else if (macro.variables.tamarTna !== null && Number.isFinite(macro.variables.tamarTna) && macro.variables.tamarTna > 0) {
    caucion1dTnaPct = macro.variables.tamarTna;
    caucionSource = 'BCRA TAMAR TNA';
  } else if (macro.variables.badlarTna !== null && Number.isFinite(macro.variables.badlarTna) && macro.variables.badlarTna > 0) {
    caucion1dTnaPct = macro.variables.badlarTna;
    caucionSource = 'BCRA BADLAR TNA';
  } else if (options.rateTna !== null && Number.isFinite(options.rateTna) && options.rateTna > 0) {
    caucion1dTnaPct = options.rateTna;
    caucionSource = 'BYMA Tasa Opciones';
  }

  // 2) Lecap / tasa emparejada
  const noteWithTna = liveNotes.find((n) => n.tna !== null && n.tna > 0);
  let lecapMatchedTnaPct = Number.NaN;
  if (noteWithTna?.tna !== null && noteWithTna?.tna !== undefined) {
    lecapMatchedTnaPct = noteWithTna.tna;
  } else if (macro.variables.plazoFijoTna !== null && Number.isFinite(macro.variables.plazoFijoTna) && macro.variables.plazoFijoTna > 0) {
    lecapMatchedTnaPct = macro.variables.plazoFijoTna;
  } else if (Number.isFinite(caucion1dTnaPct) && caucion1dTnaPct > 0) {
    lecapMatchedTnaPct = caucion1dTnaPct;
  } else if (monitoring.badlarTna !== null && Number.isFinite(monitoring.badlarTna) && monitoring.badlarTna > 0) {
    lecapMatchedTnaPct = monitoring.badlarTna;
  }

  const curve: ContinuousRateCurvePoint[] = [];
  const tnaToCont = (tnaPct: number, days: number): number => {
    const r = tnaPct / 100;
    const t = Math.max(1, days) / 365;
    const gross = 1 + r * t;
    return gross > 0 ? Math.log(gross) / t : Number.NaN;
  };

  if (Number.isFinite(caucion1dTnaPct) && caucion1dTnaPct > 0) {
    const c1 = tnaToCont(caucion1dTnaPct, 1);
    if (Number.isFinite(c1)) {
      curve.push({ days: 1, continuousRateAnnual: c1 });
    }
  }
  if (macro.variables.badlarTna !== null && Number.isFinite(macro.variables.badlarTna) && macro.variables.badlarTna > 0) {
    const c30 = tnaToCont(macro.variables.badlarTna, 30);
    if (Number.isFinite(c30)) {
      curve.push({ days: 30, continuousRateAnnual: c30 });
    }
  }
  if (Number.isFinite(lecapMatchedTnaPct) && lecapMatchedTnaPct > 0) {
    const c60 = tnaToCont(lecapMatchedTnaPct, 60);
    if (Number.isFinite(c60)) {
      curve.push({ days: 60, continuousRateAnnual: c60 });
    }
  }
  if (curve.length === 0 && options.continuousRate !== null && Number.isFinite(options.continuousRate) && options.continuousRate > 0) {
    curve.push({ days: 30, continuousRateAnnual: options.continuousRate });
  }
  curve.sort((a, b) => a.days - b.days);

  return {
    rateCurveArs: curve,
    caucion1dTnaPct,
    caucionSource,
    lecapMatchedTnaPct,
  };
}

export class GgalSpecialistRuntime {
  private readonly runtime: MarketRuntime;
  private readonly arRuntime: ArgentinaMarketRuntime;
  private readonly fetchFn: ArHttpFn;
  private readonly nowMsFn: () => number;
  private readonly data912BaseUrl: string;
  private readonly bcraBaseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly recorderIntervalMs: number;
  private readonly maxRecorderSnapshots: number;
  private readonly maxData912StalenessSec: number;
  private readonly maxMassiveStalenessSec: number;
  private readonly maxSyncSkewSec: number;
  private readonly arHolidays: readonly string[];
  private readonly usHolidays: readonly string[];
  private readonly secrets: readonly string[];

  private bundleCache: CachedEntry<MarketBundle> | null = null;
  private bundleInFlight: Promise<MarketBundle> | null = null;
  private resolvedCerVarId: number | null = null;
  private historyCache: CachedEntry<{
    readonly al30History: readonly HistoricalPriceSeriesPoint[];
    readonly al30cHistory: readonly HistoricalPriceSeriesPoint[];
    readonly gd30History: readonly HistoricalPriceSeriesPoint[];
    readonly gd30cHistory: readonly HistoricalPriceSeriesPoint[];
    readonly cerHistory: readonly CerObservation[];
    readonly cerVarId: number;
  }> | null = null;
  private historyInFlight: Promise<
    NonNullable<GgalSpecialistRuntime['historyCache']>['value']
  > | null = null;

  private anexoBStore: AnexoBStoredRecord | null = null;
  private readonly recorderSnapshots: GgalRecorderSnapshotEntry[] = [];
  private readonly bymaFlowSnapshots: BymaSnapshotFlowPoint[] = [];
  private recorderTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(deps: GgalSpecialistRuntimeDeps) {
    this.runtime = deps.runtime;
    this.arRuntime = deps.arRuntime;
    this.fetchFn = deps.fetchFn ?? defaultHttpFn;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
    this.data912BaseUrl = (deps.data912BaseUrl ?? DEFAULT_DATA912_BASE_URL).replace(/\/+$/, '');
    this.bcraBaseUrl = (deps.bcraBaseUrl ?? DEFAULT_BCRA_BASE_URL).replace(/\/+$/, '');
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.recorderIntervalMs = deps.recorderIntervalMs ?? DEFAULT_RECORDER_INTERVAL_MS;
    this.maxRecorderSnapshots = deps.maxRecorderSnapshots ?? DEFAULT_MAX_RECORDER_SNAPSHOTS;
    this.maxData912StalenessSec = deps.maxData912StalenessSec ?? DEFAULT_STALENESS_SEC;
    this.maxMassiveStalenessSec = deps.maxMassiveStalenessSec ?? DEFAULT_STALENESS_SEC;
    this.maxSyncSkewSec = deps.maxSyncSkewSec ?? DEFAULT_STALENESS_SEC;
    this.arHolidays = deps.arHolidays ?? [];
    this.usHolidays = deps.usHolidays ?? [];
    this.secrets = deps.secrets ?? [];
  }

  public startRecorder(): void {
    if (this.recorderTimer !== null) {
      return;
    }
    this.recorderTimer = setInterval(() => {
      void this.recordSnapshotNow().catch(() => {
        // Silencioso en timer de fondo; errores quedan en recorder sin tumbar el proceso.
      });
    }, this.recorderIntervalMs);
    this.recorderTimer.unref();
  }

  public stop(): void {
    if (this.recorderTimer !== null) {
      clearInterval(this.recorderTimer);
      this.recorderTimer = null;
    }
  }

  public getRecorderStatus(): GgalRecorderStatusDto {
    const last = this.recorderSnapshots[this.recorderSnapshots.length - 1];
    return {
      running: this.recorderTimer !== null,
      intervalMs: this.recorderIntervalMs,
      snapshotsCount: this.recorderSnapshots.length,
      flowPointsCount: this.bymaFlowSnapshots.length,
      lastRecordedAtUtcSec: last?.asOfUtcSec ?? null,
    };
  }

  public getAnexoBState(): AnexoBStoredRecord | null {
    return this.anexoBStore;
  }

  public ingestAnexoB(body: AnexoBIngestRequest): GgalAnexoBIngestResponse {
    const nowUtcSec = Math.floor(this.nowMsFn() / 1_000);
    const parsed = parseAnexoBIamcInput(body, nowUtcSec);
    this.anexoBStore = parsed;
    return {
      ok: true,
      record: {
        asOfDate: parsed.asOfDate,
        expiryCode: parsed.expiryCode,
        sourceLabel: parsed.sourceLabel,
        ingestedAtUtcSec: parsed.ingestedAtUtcSec,
        totals: parsed.totals,
        previewRows: parsed.rows.slice(0, 25),
      },
    };
  }

  public async recordSnapshotNow(): Promise<GgalRecorderSnapshotEntry> {
    const bundle = await this.loadMarketBundle(true);
    const entry = this.appendRecorderObservation(bundle);
    return entry;
  }

  private appendRecorderObservation(bundle: MarketBundle): GgalRecorderSnapshotEntry {
    const asOfUtcSec = bundle.asOfUtcSec;
    const parity = this.computeParityGapCore(bundle);
    const session = {
      sessionRegime: parity.output.sessionRegime,
      marketMode: parity.marketMode,
    };

    const ggalRow = bundle.liveStocks.find((r) => r.symbol === 'GGAL');
    const ggalOverview = bundle.overview.mervalStocks.find((s) => s.ticker === 'GGAL');
    const bid = ggalRow?.bid ?? ggalOverview?.bid ?? ggalOverview?.last ?? null;
    const ask = ggalRow?.ask ?? ggalOverview?.ask ?? ggalOverview?.last ?? null;
    const last = ggalRow?.last ?? ggalOverview?.last ?? null;
    const cumVol = ggalRow?.nominalVol ?? null;

    if (
      bid !== null &&
      ask !== null &&
      last !== null &&
      cumVol !== null &&
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      Number.isFinite(last) &&
      Number.isFinite(cumVol) &&
      bid > 0 &&
      ask >= bid &&
      last > 0 &&
      cumVol >= 0
    ) {
      const prevFlow = this.bymaFlowSnapshots[this.bymaFlowSnapshots.length - 1];
      if (prevFlow === undefined || asOfUtcSec > prevFlow.time) {
        this.bymaFlowSnapshots.push({
          time: asOfUtcSec,
          bid,
          ask,
          last,
          cumVolumeShares: cumVol,
        });
        if (this.bymaFlowSnapshots.length > this.maxRecorderSnapshots) {
          this.bymaFlowSnapshots.shift();
        }
      }
    }

    const totalOpts = bundle.ggalOptions.expiries.reduce(
      (acc, e) => acc + e.calls.length + e.puts.length,
      0,
    );
    const entry: GgalRecorderSnapshotEntry = {
      asOfUtcSec,
      marketMode: session.marketMode,
      sessionRegime: session.sessionRegime,
      spotByma24hArs: sanitizeFinite(parity.output.spot.byma24hArs),
      spotAdrUsd: sanitizeFinite(parity.output.spot.adrMidUsd),
      cclGgal24h: sanitizeFinite(parity.output.ccl.cclGgal24h),
      optionsContractsCount: totalOpts,
    };

    const lastEntry = this.recorderSnapshots[this.recorderSnapshots.length - 1];
    if (lastEntry === undefined || asOfUtcSec > lastEntry.asOfUtcSec) {
      this.recorderSnapshots.push(entry);
      if (this.recorderSnapshots.length > this.maxRecorderSnapshots) {
        this.recorderSnapshots.shift();
      }
    }

    return entry;
  }

  private async fetchJsonSafe(url: string): Promise<{ readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly error: string }> {
    try {
      const res = await this.fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: DEFAULT_HTTP_TIMEOUT_MS });
      if (!res.ok) {
        return { ok: false, error: redactSecrets(`HTTP ${String(res.status)} en ${url}`, this.secrets) };
      }
      const parsed: unknown = JSON.parse(res.text);
      return { ok: true, data: parsed };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactSecrets(`${url}: ${msg}`, this.secrets) };
    }
  }

  private parseData912Rows(data: unknown): Data912RawRow[] {
    if (!Array.isArray(data)) {
      return [];
    }
    const rows: Data912RawRow[] = [];
    for (const item of data) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const symbol = readStr(item, ['symbol', 'ticker', 'Symbol', 'especie'])?.toUpperCase();
      if (symbol === undefined || symbol === '') {
        continue;
      }
      const last = readNum(item, ['c', 'close', 'last', 'px_last', 'mark', 'trade', 'settlementPrice']);
      const bid = readNum(item, ['px_bid', 'bid', 'bidPrice', 'ars_bid']);
      const ask = readNum(item, ['px_ask', 'ask', 'askPrice', 'ars_ask']);
      const prevClose = readNum(item, ['prev_close', 'previousClose', 'closingPrice', 'open', 'o']);
      const nominalVol = readNum(item, ['v', 'q_op', 'volume', 'nominalVolume']);
      const volumeArs = readNum(item, ['v_ars', 'volumeAmount', 'monto', 'amount']);
      const days = readNum(item, ['days', 'plazo', 'dias']);
      const tna = readNum(item, ['tna', 'rate', 'tir', 'caucion_tna']);
      const rawDate = readStr(item, ['date', 'timestamp', 'updated_at']);
      rows.push({
        symbol,
        bid,
        ask,
        last,
        prevClose,
        nominalVol,
        volumeArs,
        days,
        tna,
        rawDate,
      });
    }
    return rows;
  }

  private parseData912History(data: unknown): HistoricalPriceSeriesPoint[] {
    const arr = Array.isArray(data)
      ? data
      : isPlainRecord(data) && Array.isArray(data['results'])
        ? data['results']
        : [];
    const seen = new Set<string>();
    const out: HistoricalPriceSeriesPoint[] = [];
    for (const item of arr) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const d = parseUtcDateKey(readStr(item, ['date', 'd', 'fecha', 't', 'time']));
      const close = readNum(item, ['c', 'close', 'last', 'cierre']);
      if (d === null || close === null || !Number.isFinite(close) || close <= 0 || seen.has(d.date)) {
        continue;
      }
      seen.add(d.date);
      out.push({ date: d.date, time: d.time, close });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  private parseBcraCerHistory(data: unknown): CerObservation[] {
    if (!isPlainRecord(data) || !Array.isArray(data['results'])) {
      return [];
    }
    const seen = new Set<string>();
    const out: CerObservation[] = [];
    const pushObservation = (entry: unknown): void => {
      if (!isPlainRecord(entry)) {
        return;
      }
      const rawFecha = readStr(entry, ['fecha', 'date', 'ultFechaInformada']);
      const val = readNum(entry, ['valor', 'value', 'ultValorInformado']);
      const parsed = parseUtcDateKey(rawFecha);
      if (parsed === null || val === null || !Number.isFinite(val) || val <= 0 || seen.has(parsed.date)) {
        return;
      }
      seen.add(parsed.date);
      out.push({ date: parsed.date, value: val });
    };

    for (const item of data['results']) {
      if (!isPlainRecord(item)) {
        continue;
      }
      // BCRA v4.0 devuelve { results: [{ idVariable, detalle: [{ fecha, valor }, ...] }] }
      if (Array.isArray(item['detalle'])) {
        for (const detailRow of item['detalle']) {
          pushObservation(detailRow);
        }
      }
      pushObservation(item);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  private async resolveBcraCerVariableId(): Promise<number> {
    if (this.resolvedCerVarId !== null) {
      return this.resolvedCerVarId;
    }
    const catalogRes = await this.fetchJsonSafe(
      `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias?Limit=3000`,
    );
    if (catalogRes.ok && isPlainRecord(catalogRes.data) && Array.isArray(catalogRes.data['results'])) {
      let bestId: number | null = null;
      for (const item of catalogRes.data['results']) {
        if (!isPlainRecord(item)) {
          continue;
        }
        const idVal = readNum(item, ['idVariable', 'id']);
        const desc = readStr(item, ['descripcion', 'nombre', 'description']) ?? '';
        if (idVal === null || !Number.isInteger(idVal) || idVal <= 0 || desc.trim() === '') {
          continue;
        }
        const norm = desc.trim();
        const excludedSeries = /\b(?:no\s+ajustables?|dep[oó]sitos|plazo|pr[eé]stamos|tasas?)\b/i.test(norm);
        const isExactCer =
          /^cer$/i.test(norm) ||
          /coeficiente\s+de\s+estabilizaci[oó]n\s+de\s+referencia/i.test(norm) ||
          /^cer\b/i.test(norm);
        const hasTokenCer = /\bcer\b/i.test(norm) && !excludedSeries;
        if (isExactCer) {
          bestId = idVal;
          break;
        }
        if (hasTokenCer && bestId === null) {
          bestId = idVal;
        }
      }
      if (bestId !== null) {
        this.resolvedCerVarId = bestId;
        return bestId;
      }
    }
    return 30;
  }

  private async loadHistories(asOfUtcSec: number, forceRefresh: boolean) {
    const nowMs = this.nowMsFn();
    if (!forceRefresh && this.historyCache !== null && nowMs - this.historyCache.fetchedAtMs < HISTORY_CACHE_TTL_MS) {
      return this.historyCache.value;
    }
    if (!forceRefresh && this.historyInFlight !== null) {
      return this.historyInFlight;
    }

    const work = (async () => {
      const toDate = getBuenosAiresParts(asOfUtcSec).dateKey;
      const fromSec = Math.max(0, asOfUtcSec - 365 * 86_400);
      const fromDate = getBuenosAiresParts(fromSec).dateKey;
      const cerVarId = await this.resolveBcraCerVariableId();

      const [al30Res, al30cRes, gd30Res, gd30cRes, cerRes] = await Promise.all([
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/AL30`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/AL30C`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/GD30`),
        this.fetchJsonSafe(`${this.data912BaseUrl}/historical/bonds/GD30C`),
        this.fetchJsonSafe(
          `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias/${String(cerVarId)}?desde=${fromDate}&hasta=${toDate}&Limit=3000`,
        ),
      ]);

      let effectiveCerVarId = cerVarId;
      let cerHistory = cerRes.ok ? this.parseBcraCerHistory(cerRes.data) : [];
      if (cerHistory.length === 0 && cerVarId !== 30) {
        const fbRes = await this.fetchJsonSafe(
          `${this.bcraBaseUrl}/estadisticas/v4.0/Monetarias/30?desde=${fromDate}&hasta=${toDate}&Limit=3000`,
        );
        if (fbRes.ok) {
          const parsedFb = this.parseBcraCerHistory(fbRes.data);
          if (parsedFb.length > 0) {
            cerHistory = parsedFb;
            effectiveCerVarId = 30;
          }
        }
      }

      const value = {
        al30History: al30Res.ok ? this.parseData912History(al30Res.data) : [],
        al30cHistory: al30cRes.ok ? this.parseData912History(al30cRes.data) : [],
        gd30History: gd30Res.ok ? this.parseData912History(gd30Res.data) : [],
        gd30cHistory: gd30cRes.ok ? this.parseData912History(gd30cRes.data) : [],
        cerHistory,
        cerVarId: effectiveCerVarId,
      };
      this.historyCache = { fetchedAtMs: nowMs, value };
      return value;
    })();

    this.historyInFlight = work;
    try {
      return await work;
    } finally {
      this.historyInFlight = null;
    }
  }

  private async loadMarketBundle(forceRefresh = false): Promise<MarketBundle> {
    const nowMs = this.nowMsFn();
    if (!forceRefresh && this.bundleCache !== null && nowMs - this.bundleCache.fetchedAtMs < this.cacheTtlMs) {
      return this.bundleCache.value;
    }
    if (!forceRefresh && this.bundleInFlight !== null) {
      return this.bundleInFlight;
    }

    const work = (async (): Promise<MarketBundle> => {
      const errors: string[] = [];
      const asOfUtcSec = Math.floor(this.nowMsFn() / 1_000);

      const [overview, macro, monitoring, ggalDetail, ggalOptions] = await Promise.all([
        this.arRuntime.getOverview(forceRefresh),
        this.arRuntime.getMacro(forceRefresh),
        this.arRuntime.getMonitoring('bonos', forceRefresh),
        this.arRuntime.getStockDetail('GGAL', forceRefresh),
        this.arRuntime.getOptionsChain('GGAL', forceRefresh),
      ]);

      const [usSnapshotRes, usBarsRes, stocksRes, bondsRes, notesRes, caucionesRes, histories] =
        await Promise.all([
          this.runtime
            .getSnapshot('GGAL', forceRefresh ? { forceRefresh: true } : undefined)
            .catch((err: unknown): null => {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(redactSecrets(`Massive Snapshot GGAL: ${msg}`, this.secrets));
              return null;
            }),
          this.runtime
            .getBars('GGAL', '1D', { visibleBars: 240, forceRefresh })
            .catch((err: unknown): null => {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(redactSecrets(`Massive Bars GGAL 1D: ${msg}`, this.secrets));
              return null;
            }),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_stocks`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_bonds`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/arg_notes`),
          this.fetchJsonSafe(`${this.data912BaseUrl}/live/cauciones`),
          this.loadHistories(asOfUtcSec, forceRefresh),
        ]);

      let usDailyCloseBars: readonly { readonly time: number; readonly close: number }[] =
        usBarsRes !== null
          ? usBarsRes.bars.map((b) => ({ time: b.time, close: b.close }))
          : [];
      if (usDailyCloseBars.length < 75) {
        const cached1d = await this.runtime.getCachedDailyBars1d('GGAL', 240, forceRefresh).catch(() => null);
        if (cached1d !== null && cached1d.bars.length > usDailyCloseBars.length) {
          usDailyCloseBars = cached1d.bars.map((b) => ({ time: b.time, close: b.close }));
        }
      }

      const bundle: MarketBundle = {
        asOfUtcSec,
        overview,
        macro,
        monitoring,
        ggalDetail,
        ggalOptions,
        usSnapshot: usSnapshotRes,
        usBars: usBarsRes,
        usDailyCloseBars,
        liveStocks: stocksRes.ok ? this.parseData912Rows(stocksRes.data) : [],
        liveBonds: bondsRes.ok ? this.parseData912Rows(bondsRes.data) : [],
        liveNotes: notesRes.ok ? this.parseData912Rows(notesRes.data) : [],
        liveCauciones: caucionesRes.ok ? this.parseData912Rows(caucionesRes.data) : [],
        al30History: histories.al30History,
        al30cHistory: histories.al30cHistory,
        gd30History: histories.gd30History,
        gd30cHistory: histories.gd30cHistory,
        cerHistory: histories.cerHistory,
        cerVarId: histories.cerVarId,
        errors,
      };

      this.bundleCache = { fetchedAtMs: nowMs, value: bundle };
      const lastSnap = this.recorderSnapshots[this.recorderSnapshots.length - 1];
      const minStepSec = Math.max(1, Math.floor(this.recorderIntervalMs / 1_000));
      if (lastSnap === undefined || bundle.asOfUtcSec - lastSnap.asOfUtcSec >= minStepSec) {
        this.appendRecorderObservation(bundle);
      }
      return bundle;
    })();

    this.bundleInFlight = work;
    try {
      return await work;
    } finally {
      this.bundleInFlight = null;
    }
  }

  private resolveTelemetryMode(
    bundle: MarketBundle,
    executionPriceBasis: ExecutionPriceBasis,
    paritySignal?: ParityGapOutput['signal'],
    overrideAnexoBLag?: number | null,
  ): GgalTelemetryHeaderDto {
    const asOfUtcSec = bundle.asOfUtcSec;
    const isClosedSession = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosedSession;

    const parity = evaluateParityGap({
      asOfUtcSec,
      data912TimestampSec: bundle.overview.asOfUtcSec,
      massiveTimestampSec: bundle.usSnapshot?.asOfUtcSec ?? bundle.overview.asOfUtcSec,
      marketMode: isEodMode ? 'EOD_CIERRE' : 'LIVE',
      byma24h: { bid: Number.NaN, ask: Number.NaN },
      adr: { bid: Number.NaN, ask: Number.NaN },
      sofrRateAnnual: Number.NaN,
      caucionArsRateTna: Number.NaN,
      sovereignBonds: [],
      spreadHistory: [],
      arHolidays: this.arHolidays,
      usHolidays: this.usHolidays,
    });

    const d912Ts = bundle.overview.asOfUtcSec;
    const massiveTs = bundle.usSnapshot?.asOfUtcSec ?? bundle.usBars?.asOfUtcSec ?? null;
    const data912AgeSec = asOfUtcSec - d912Ts;
    const massiveAgeSec = massiveTs !== null ? asOfUtcSec - massiveTs : null;

    const anexoBStatus: 'T-1 ANEXO B' | 'NO_DATA' =
      this.anexoBStore !== null ? 'T-1 ANEXO B' : 'NO_DATA';

    let feedStatus: GgalBadgeMode;
    if (paritySignal === 'STALE_DATA_LOCK') {
      feedStatus = 'STALE_DATA_LOCK';
    } else if (isEodMode) {
      feedStatus = 'EOD_CIERRE';
    } else if (bundle.overview.feedStatus === 'DIFERIDO_20M') {
      feedStatus = 'DIFERIDO_20M';
    } else if (bundle.overview.feedStatus === 'LIVE' || bundle.overview.feedStatus === 'PARTIAL') {
      feedStatus = bundle.overview.feedStatus === 'LIVE' ? 'LIVE' : 'DIFERIDO_20M';
    } else {
      feedStatus = 'NO_DATA';
    }

    const badges: GgalBadgeMode[] = [feedStatus];
    if (anexoBStatus === 'T-1 ANEXO B') {
      badges.push('T-1 ANEXO B');
    }

    const allErrors = Array.from(
      new Set([...bundle.overview.providerErrors, ...bundle.ggalOptions.providerErrors, ...bundle.errors]),
    );
    const hideClosedOpenByma = isClosedSession || parity.sessionRegime === 'CLOSED';
    const visibleErrors = hideClosedOpenByma
      ? allErrors.filter((err) => !/open\.bymadata\.com\.ar/i.test(err))
      : allErrors;

    return {
      asOfUtcSec,
      timestampUtc: formatIsoUtcFromSec(asOfUtcSec),
      sessionRegime: parity.sessionRegime,
      dstMode: parity.dstMode,
      marketMode: isEodMode ? 'EOD_CIERRE' : 'LIVE',
      feedStatus,
      feedBadges: badges,
      executionPriceBasis,
      data912TimestampSec: d912Ts,
      massiveTimestampSec: massiveTs,
      data912AgeSec: sanitizeFinite(data912AgeSec),
      massiveAgeSec: massiveAgeSec !== null ? sanitizeFinite(massiveAgeSec) : null,
      anexoBStatus,
      anexoBAsOfDate: this.anexoBStore?.asOfDate ?? null,
      anexoBLagTradingDays: overrideAnexoBLag ?? null,
      recorder: this.getRecorderStatus(),
      providerErrors: visibleErrors,
      sourceDiagnostics: allErrors,
    };
  }

  private buildSovereignBondQuotes(
    bundle: MarketBundle,
    allowEodReference: boolean,
  ): { readonly quotes: SovereignBondCclQuote[]; readonly displayRows: GgalSovereignBondLegDto[] } {
    const displayRows: GgalSovereignBondLegDto[] = [];
    const quotes: SovereignBondCclQuote[] = [];
    const pairs = [
      { ticker: 'AL30', usdCSymbol: 'AL30C' },
      { ticker: 'GD30', usdCSymbol: 'GD30C' },
    ] as const;

    for (const pair of pairs) {
      const arsLive = bundle.liveBonds.find((b) => b.symbol === pair.ticker);
      const usdCLive = bundle.liveBonds.find((b) => b.symbol === pair.usdCSymbol);
      const bondSummary = bundle.monitoring.bonds.find((b) => b.ticker === pair.ticker);

      const arsBuilt = makeBidAskQuote(
        arsLive?.bid,
        arsLive?.ask,
        arsLive?.last ?? bondSummary?.priceArs,
        allowEodReference,
      );

      // En OpenBYMA/Data912, si bondSummary tiene priceArs y cclImplicit, podemos derivar usdCMid real solo cuando ambos están reportados
      const derivedUsdC =
        bondSummary?.priceArs !== null &&
        bondSummary?.priceArs !== undefined &&
        bondSummary.cclImplicit !== null &&
        bondSummary.cclImplicit !== undefined &&
        bondSummary.cclImplicit > 0
          ? (bondSummary.priceArs / bondSummary.cclImplicit) * 100 / 100
          : null;

      const usdCBuilt = makeBidAskQuote(
        usdCLive?.bid,
        usdCLive?.ask,
        usdCLive?.last ?? derivedUsdC,
        allowEodReference,
      );

      const arsMid =
        Number.isFinite(arsBuilt.quote.bid) && Number.isFinite(arsBuilt.quote.ask)
          ? 0.5 * (arsBuilt.quote.bid + arsBuilt.quote.ask)
          : Number.NaN;
      const usdCMid =
        Number.isFinite(usdCBuilt.quote.bid) && Number.isFinite(usdCBuilt.quote.ask)
          ? 0.5 * (usdCBuilt.quote.bid + usdCBuilt.quote.ask)
          : Number.NaN;

      const nominalVol = arsLive?.volumeArs ?? bondSummary?.volumeM ?? null;

      if (Number.isFinite(arsMid) && Number.isFinite(usdCMid) && arsMid > 0 && usdCMid > 0) {
        quotes.push({
          ticker: pair.ticker,
          ars24h: arsBuilt.quote,
          usdC24h: usdCBuilt.quote,
          arsNominalBase: 100,
          usdCNominalBase: 100,
          ...(nominalVol !== null && Number.isFinite(nominalVol) && nominalVol >= 0
            ? { nominalVolumeArs: nominalVol }
            : {}),
        });
      }

      displayRows.push({
        ticker: pair.ticker,
        arsBid: sanitizeFinite(arsBuilt.quote.bid),
        arsAsk: sanitizeFinite(arsBuilt.quote.ask),
        arsMid: sanitizeFinite(arsMid),
        usdCBid: sanitizeFinite(usdCBuilt.quote.bid),
        usdCAsk: sanitizeFinite(usdCBuilt.quote.ask),
        usdCMid: sanitizeFinite(usdCMid),
        cclImplied:
          Number.isFinite(arsMid) && Number.isFinite(usdCMid) && usdCMid > 0
            ? sanitizeFinite(arsMid / usdCMid)
            : sanitizeFinite(bondSummary?.cclImplicit ?? Number.NaN),
        nominalVolumeArs: sanitizeFinite(nominalVol ?? Number.NaN),
      });
    }

    return { quotes, displayRows };
  }

  private buildCausalSpreadHistory(bundle: MarketBundle): {
    readonly observations: CausalSpreadObservation[];
    readonly points: GgalHistoricalSpreadPointDto[];
  } {
    const arByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const bar of bundle.ggalDetail.historicalBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        arByDate.set(bar.date, { time: bar.time, close: bar.close });
      }
    }

    const adrByDate = new Map<string, number>();
    if (bundle.usBars !== null) {
      for (const bar of bundle.usBars.bars) {
        if (Number.isFinite(bar.close) && bar.close > 0) {
          const dk = formatIsoUtcFromSec(bar.time).slice(0, 10);
          adrByDate.set(dk, bar.close);
        }
      }
    }

    const al30ByDate = new Map(bundle.al30History.map((p) => [p.date, p.close]));
    const al30cByDate = new Map(bundle.al30cHistory.map((p) => [p.date, p.close]));
    const gd30ByDate = new Map(bundle.gd30History.map((p) => [p.date, p.close]));
    const gd30cByDate = new Map(bundle.gd30cHistory.map((p) => [p.date, p.close]));

    const points: GgalHistoricalSpreadPointDto[] = [];
    const observations: CausalSpreadObservation[] = [];

    const sortedDates = [...arByDate.keys()].sort();
    for (const date of sortedDates) {
      const ar = arByDate.get(date);
      const adrClose = adrByDate.get(date);
      if (ar === undefined || adrClose === undefined || adrClose <= 0) {
        continue;
      }
      const cclGgal = (GGAL_ADR_RATIO * ar.close) / adrClose;

      const al30 = al30ByDate.get(date);
      const al30c = al30cByDate.get(date);
      const gd30 = gd30ByDate.get(date);
      const gd30c = gd30cByDate.get(date);

      const bondCcls: number[] = [];
      if (al30 !== undefined && al30c !== undefined && al30 > 0 && al30c > 0) {
        bondCcls.push(al30 / al30c);
      }
      if (gd30 !== undefined && gd30c !== undefined && gd30 > 0 && gd30c > 0) {
        bondCcls.push(gd30 / gd30c);
      }
      if (bondCcls.length === 0) {
        continue;
      }
      const cclSovereign = bondCcls.reduce((a, b) => a + b, 0) / bondCcls.length;
      if (!Number.isFinite(cclGgal) || cclGgal <= 0 || !Number.isFinite(cclSovereign) || cclSovereign <= 0) {
        continue;
      }

      const spreadLogBps = (Math.log(cclGgal) - Math.log(cclSovereign)) * 10_000;
      observations.push({
        time: ar.time,
        cclGgal24h: cclGgal,
        cclSovereign,
      });
      points.push({
        time: ar.time,
        date,
        cclGgal24h: cclGgal,
        cclSovereign,
        spreadLogBps,
      });
    }

    return { observations, points };
  }

  private resolveSofrAndRateBenchmarks(bundle: MarketBundle): {
    readonly sofrPct: number;
    readonly sofrRateAnnual: number;
    readonly sofrSource: string | null;
    readonly rateCurveArs: ContinuousRateCurvePoint[];
    readonly caucion1dTnaPct: number;
    readonly caucionSource: string | null;
    readonly lecapMatchedTnaPct: number;
  } {
    let sofrPct = Number.NaN;
    let sofrSource: string | null = null;
    const usSofr = bundle.usSnapshot?.marketContext.treasury.sofr ?? null;
    const arSofr = bundle.macro.variables.sofrUsdTna ?? null;
    if (usSofr !== null && Number.isFinite(usSofr) && usSofr >= 0) {
      sofrPct = usSofr;
      sofrSource = 'NY Fed / Massive Treasury';
    } else if (arSofr !== null && Number.isFinite(arSofr) && arSofr >= 0) {
      sofrPct = arSofr;
      sofrSource = 'NY Fed SOFR (AR Loader)';
    }

    const arsRates = buildArsRateCurveAndBenchmarks(
      bundle.macro,
      bundle.ggalOptions,
      bundle.liveCauciones,
      bundle.liveNotes,
      bundle.monitoring,
    );

    return {
      sofrPct,
      sofrRateAnnual: Number.isFinite(sofrPct) ? sofrPct / 100 : Number.NaN,
      sofrSource,
      ...arsRates,
    };
  }

  private resolveSpotQuotes(bundle: MarketBundle, isEodMode: boolean) {
    const ggalLive = bundle.liveStocks.find((s) => s.symbol === 'GGAL');
    const ggalOverview = bundle.overview.mervalStocks.find((s) => s.ticker === 'GGAL');
    const bymaLast = ggalLive?.last ?? ggalOverview?.last ?? bundle.ggalOptions.spot ?? null;
    const bymaBuilt = makeBidAskQuote(
      ggalLive?.bid ?? ggalOverview?.bid,
      ggalLive?.ask ?? ggalOverview?.ask,
      bymaLast,
      isEodMode,
    );

    // CI si aparece explícita en Data912 (ej. GGAL.CI / GGAL_CI)
    const ggalCiRow = bundle.liveStocks.find(
      (s) => s.symbol === 'GGAL.CI' || s.symbol === 'GGAL_CI' || s.symbol === 'GGALCI',
    );
    const bymaCiBuilt =
      ggalCiRow !== undefined
        ? makeBidAskQuote(ggalCiRow.bid, ggalCiRow.ask, ggalCiRow.last, isEodMode)
        : null;

    // ADR NASDAQ desde Massive snapshot / bars o Data912 usa_adrs reflejado en ggalOverview.adrPrice
    const lastAdrBarClose =
      bundle.usBars !== null && bundle.usBars.bars.length > 0
        ? (bundle.usBars.bars[bundle.usBars.bars.length - 1]?.close ?? null)
        : null;
    const adrSpot =
      bundle.usSnapshot?.envelope.snapshot.metrics.spot ??
      lastAdrBarClose ??
      ggalOverview?.adrPrice ??
      null;
    const adrBuilt = makeBidAskQuote(null, null, adrSpot, true);

    const basis: ExecutionPriceBasis =
      bymaBuilt.basis === 'LIVE_BID_ASK'
        ? 'LIVE_BID_ASK'
        : bymaBuilt.basis === 'EOD_CLOSE_REFERENCE'
          ? 'EOD_CLOSE_REFERENCE'
          : 'NONE';

    return {
      byma24hQuote: bymaBuilt.quote,
      bymaCiQuote: bymaCiBuilt?.quote,
      bymaPrevClose: ggalLive?.prevClose ?? ggalOverview?.prevClose ?? null,
      adrQuote: adrBuilt.quote,
      lastAdrBarClose,
      basis,
    };
  }

  private computeParityGapCore(bundle: MarketBundle): {
    readonly output: ParityGapOutput;
    readonly marketMode: 'LIVE' | 'EOD_CIERRE';
    readonly executionPriceBasis: ExecutionPriceBasis;
    readonly sovereignBonds: readonly GgalSovereignBondLegDto[];
    readonly historicalSpreads: readonly GgalHistoricalSpreadPointDto[];
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const marketMode: 'LIVE' | 'EOD_CIERRE' = isEodMode ? 'EOD_CIERRE' : 'LIVE';

    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const bonds = this.buildSovereignBondQuotes(bundle, isEodMode);
    const spreadHist = this.buildCausalSpreadHistory(bundle);

    const preMarketBars = bundle.usBars?.bars ?? [];
    const adrPrevClose =
      preMarketBars.length >= 2
        ? (preMarketBars[preMarketBars.length - 2]?.close ?? spots.lastAdrBarClose)
        : spots.lastAdrBarClose;

    const spyU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'SPY');
    const qqqU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'QQQ');
    const vixU = bundle.usSnapshot?.marketContext.unifiedQuotes.find((q) => q.ticker === 'VIX');
    const logRetFromPct = (pct: number | null | undefined): number | undefined => {
      if (pct === null || pct === undefined || !Number.isFinite(pct) || 1 + pct / 100 <= 0) {
        return undefined;
      }
      return Math.log(1 + pct / 100);
    };

    const spyLogRet = logRetFromPct(spyU?.changePct);
    const qqqLogRet = logRetFromPct(qqqU?.changePct);
    const vixLogChg = logRetFromPct(vixU?.changePct);

    const preOpenInput: PreOpenMacroPredictorInput | undefined =
      spots.bymaPrevClose !== null &&
      spots.bymaPrevClose > 0 &&
      adrPrevClose !== null &&
      adrPrevClose > 0
        ? {
            bymaPrevClose24hArs: spots.bymaPrevClose,
            adrPrev1700ArtUsd: adrPrevClose,
            ...(spyLogRet !== undefined
              ? { spyOvernightLogReturn: spyLogRet }
              : {}),
            ...(qqqLogRet !== undefined
              ? { qqqOvernightLogReturn: qqqLogRet }
              : {}),
            ...(vixLogChg !== undefined
              ? { vixOvernightLogChange: vixLogChg }
              : {}),
          }
        : undefined;

    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const preOpenOptions: LocalOptionPreOpenInput[] = [];
    if (front !== null) {
      for (const c of [...front.calls, ...front.puts].slice(0, 12)) {
        const refPrice = c.mark ?? c.last ?? (c.bid !== null && c.ask !== null ? 0.5 * (c.bid + c.ask) : null);
        if (
          refPrice !== null &&
          refPrice > 0 &&
          c.delta !== null &&
          c.gamma !== null &&
          c.thetaDaily !== null &&
          c.vegaPer1Pct !== null
        ) {
          preOpenOptions.push({
            tickerByma: c.symbol,
            prevCloseArs: refPrice,
            delta: c.delta,
            gamma: c.gamma,
            vega: c.vegaPer1Pct * 100,
            theta: c.thetaDaily * 365,
          });
        }
      }
    }

    const input: ParityGapInput = {
      asOfUtcSec: bundle.asOfUtcSec,
      data912TimestampSec: bundle.overview.asOfUtcSec,
      massiveTimestampSec: bundle.usSnapshot?.asOfUtcSec ?? bundle.usBars?.asOfUtcSec ?? bundle.overview.asOfUtcSec,
      marketMode,
      maxData912StalenessSec: this.maxData912StalenessSec,
      maxMassiveStalenessSec: this.maxMassiveStalenessSec,
      maxSyncSkewSec: this.maxSyncSkewSec,
      arHolidays: this.arHolidays,
      usHolidays: this.usHolidays,
      byma24h: spots.byma24hQuote,
      ...(spots.bymaCiQuote !== undefined ? { bymaCi: spots.bymaCiQuote } : {}),
      adr: spots.adrQuote,
      sofrRateAnnual: rates.sofrRateAnnual,
      caucionArsRateTna: Number.isFinite(rates.caucion1dTnaPct) ? rates.caucion1dTnaPct / 100 : Number.NaN,
      sovereignBonds: bonds.quotes,
      spreadHistory: spreadHist.observations,
      ...(spots.bymaPrevClose !== null ? { bymaPrevClose24hArs: spots.bymaPrevClose } : {}),
      ...(preOpenInput !== undefined ? { preOpen: preOpenInput } : {}),
      ...(preOpenOptions.length > 0 ? { preOpenOptions } : {}),
    };

    const output = evaluateParityGap(input);
    return {
      output,
      marketMode,
      executionPriceBasis: spots.basis,
      sovereignBonds: bonds.displayRows,
      historicalSpreads: spreadHist.points,
      rates,
    };
  }

  public async getParityGap(forceRefresh = false): Promise<GgalParityGapResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.computeParityGapCore(bundle);
    const telemetry = this.resolveTelemetryMode(
      bundle,
      core.executionPriceBasis,
      core.output.signal,
    );
    return {
      telemetry,
      result: toJsonSafe(core.output),
      sovereignBonds: core.sovereignBonds,
      historicalSpreads: core.historicalSpreads,
      rateInputs: {
        sofrPct: sanitizeFinite(core.rates.sofrPct),
        sofrSource: core.rates.sofrSource,
        caucion1dTnaPct: sanitizeFinite(core.rates.caucion1dTnaPct),
        caucionSource: core.rates.caucionSource,
      },
    };
  }

  private evaluateExtrapolatedVolTriangleSmile(params: {
    readonly output: CrossCurrencyVolOutput | null;
    readonly front: ArOptionExpiryDto | null;
    readonly spot24hArs: number;
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
    readonly opraSlices: readonly OpraMaturitySliceInput[];
    readonly asOfUtcSec: number;
  }): {
    readonly smileComparison: GgalSmileComparisonPointDto[];
    readonly enrichedOutput: CrossCurrencyVolOutput | null;
    readonly impliedCclVolWingsPct: number | null;
    readonly impliedCclMinFloorPct: number | null;
    readonly atmCompressionPts: number | null;
  } {
    const { output, front, spot24hArs, rates, opraSlices, asOfUtcSec } = params;
    if (front === null) {
      return {
        smileComparison: [],
        enrichedOutput: output,
        impliedCclVolWingsPct: null,
        impliedCclMinFloorPct: null,
        atmCompressionPts: null,
      };
    }

    const computeBymaEval =
      Number.isFinite(spot24hArs) && spot24hArs > 0 && rates.rateCurveArs.length > 0
        ? computeBymaOptionEvalParams({
            asOfUtcSec,
            spot24hArs,
            expiryDateKey: front.expirationDate,
            expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
            arHolidays: this.arHolidays,
            rateCurve: rates.rateCurveArs,
          })
        : null;

    // Preconstruir curvas OPRA ordenadas por z estandarizado para interpolación y extrapolación suave en alas
    interface OpraZCurve {
      readonly timeToExpiryYears: number;
      readonly atmIvDecimal: number;
      readonly nodes: readonly { readonly z: number; readonly iv: number }[];
    }
    const opraCurves: OpraZCurve[] = [];
    for (const sl of opraSlices) {
      if (
        !Number.isFinite(sl.forwardUsd) ||
        sl.forwardUsd <= 0 ||
        !Number.isFinite(sl.atmIvDecimal) ||
        sl.atmIvDecimal <= 0 ||
        !Number.isFinite(sl.timeToExpiryYears) ||
        sl.timeToExpiryYears <= 0
      ) {
        continue;
      }
      const denom = sl.atmIvDecimal * Math.sqrt(sl.timeToExpiryYears);
      if (!Number.isFinite(denom) || denom <= 0) {
        continue;
      }
      // Replicar exactamente build/interpolateSliceIvAtZ de volTriangle.ts para continuidad C0 en los extremos
      const byStrike = new Map<number, { z: number; iv: number }>();
      for (const q of sl.quotes) {
        if (!Number.isFinite(q.strike) || q.strike <= 0 || !Number.isFinite(q.ivDecimal) || q.ivDecimal <= 0.02 || q.ivDecimal > 4.0) {
          continue;
        }
        const z = Math.log(q.strike / sl.forwardUsd) / denom;
        if (!Number.isFinite(z)) {
          continue;
        }
        const isOtm =
          (q.strike >= sl.forwardUsd && q.contractType === 'call') ||
          (q.strike < sl.forwardUsd && q.contractType === 'put');
        if (!byStrike.has(q.strike) || isOtm) {
          byStrike.set(q.strike, { z, iv: q.ivDecimal });
        }
      }
      const nodes = Array.from(byStrike.values()).sort((a, b) => a.z - b.z);
      if (nodes.length >= 2) {
        opraCurves.push({
          timeToExpiryYears: sl.timeToExpiryYears,
          atmIvDecimal: sl.atmIvDecimal,
          nodes,
        });
      }
    }
    opraCurves.sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);

    const evalSingleCurve = (curve: OpraZCurve, zTarget: number): number => {
      const nodes = curve.nodes;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) {
        return Number.NaN;
      }
      if (nodes.length === 1) {
        return first.iv;
      }
      const minIv = Math.max(0.05, Math.min(...nodes.map((n) => n.iv)) * 0.45);
      const maxIv = Math.min(2.5, Math.max(1.2, Math.max(...nodes.map((n) => n.iv)) * 2.1));

      if (zTarget < first.z) {
        let anchorIdx = 1;
        for (let i = 1; i < nodes.length; i += 1) {
          if ((nodes[i]?.z ?? first.z) - first.z >= 0.15) {
            anchorIdx = i;
            break;
          }
        }
        const anchor = nodes[anchorIdx] ?? nodes[1] ?? first;
        const dzBase = anchor.z - first.z;
        const rawSlope = dzBase > 1e-5 ? (anchor.iv - first.iv) / dzBase : 0;
        // Acotar pendiente de ala izquierda para evitar volúmenes negativos o explosivos
        const clampedSlope = Math.max(-0.18, Math.min(0.08, rawSlope));
        const dz = zTarget - first.z;
        const dampedDz = dz / (1 + 0.35 * Math.abs(dz));
        return Math.max(minIv, Math.min(maxIv, first.iv + clampedSlope * dampedDz));
      }

      if (zTarget > last.z) {
        let anchorIdx = nodes.length - 2;
        for (let i = nodes.length - 2; i >= 0; i -= 1) {
          if (last.z - (nodes[i]?.z ?? last.z) >= 0.15) {
            anchorIdx = i;
            break;
          }
        }
        const anchor = nodes[anchorIdx] ?? nodes[nodes.length - 2] ?? last;
        const dzBase = last.z - anchor.z;
        const rawSlope = dzBase > 1e-5 ? (last.iv - anchor.iv) / dzBase : 0;
        const clampedSlope = Math.max(-0.08, Math.min(0.18, rawSlope));
        const dz = zTarget - last.z;
        const dampedDz = dz / (1 + 0.35 * Math.abs(dz));
        return Math.max(minIv, Math.min(maxIv, last.iv + clampedSlope * dampedDz));
      }

      for (let i = 0; i < nodes.length - 1; i += 1) {
        const a = nodes[i];
        const b = nodes[i + 1];
        if (a !== undefined && b !== undefined && zTarget >= a.z && zTarget <= b.z) {
          const span = b.z - a.z;
          if (span <= 1e-9) {
            return a.iv;
          }
          const w = (zTarget - a.z) / span;
          const varA = a.iv * a.iv * curve.timeToExpiryYears;
          const varB = b.iv * b.iv * curve.timeToExpiryYears;
          const varInterp = varA + w * (varB - varA);
          return varInterp > 0 ? Math.sqrt(varInterp / curve.timeToExpiryYears) : a.iv;
        }
      }
      return last.iv;
    };

    const evalOpraIvAtZ = (zTarget: number): number => {
      if (opraCurves.length === 0 || !Number.isFinite(zTarget)) {
        return Number.NaN;
      }
      const targetT = computeBymaEval?.tExpYears ?? front.days / 365;
      // Igual que interpolateOpraTotalVarIv(..., singleSliceDayTolerance=5): si existe slice cercano en plazo, usarlo directamente
      const nearest = opraCurves
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetT) - Math.abs(b.timeToExpiryYears - targetT))[0];
      if (nearest !== undefined && Math.abs(nearest.timeToExpiryYears - targetT) * 365 <= 5) {
        return evalSingleCurve(nearest, zTarget);
      }
      const firstCurve = opraCurves[0];
      const lastCurve = opraCurves[opraCurves.length - 1];
      if (firstCurve === undefined || lastCurve === undefined) {
        return Number.NaN;
      }
      if (opraCurves.length === 1 || targetT <= firstCurve.timeToExpiryYears) {
        return evalSingleCurve(firstCurve, zTarget);
      }
      if (targetT >= lastCurve.timeToExpiryYears) {
        return evalSingleCurve(lastCurve, zTarget);
      }
      for (let i = 0; i < opraCurves.length - 1; i += 1) {
        const c0 = opraCurves[i];
        const c1 = opraCurves[i + 1];
        if (c0 !== undefined && c1 !== undefined && targetT >= c0.timeToExpiryYears && targetT <= c1.timeToExpiryYears) {
          const iv0 = evalSingleCurve(c0, zTarget);
          const iv1 = evalSingleCurve(c1, zTarget);
          if (!Number.isFinite(iv0) || !Number.isFinite(iv1)) {
            return Number.isFinite(iv0) ? iv0 : iv1;
          }
          const spanT = c1.timeToExpiryYears - c0.timeToExpiryYears;
          if (spanT <= 1e-9) {
            return iv0;
          }
          const alpha = (targetT - c0.timeToExpiryYears) / spanT;
          const var0 = iv0 * iv0 * c0.timeToExpiryYears;
          const var1 = iv1 * iv1 * c1.timeToExpiryYears;
          const varT = var0 + alpha * (var1 - var0);
          return varT > 0 && targetT > 0 ? Math.sqrt(varT / targetT) : iv0;
        }
      }
      return evalSingleCurve(lastCurve, zTarget);
    };

    const corr = output?.realizedCorrEwma ?? Number.NaN;
    const harRvCclAnnual =
      output !== null && Number.isFinite(output.harRvCclPct) && output.harRvCclPct > 0
        ? output.harRvCclPct / 100
        : Number.NaN;
    const bymaAtmAnnual =
      output !== null && Number.isFinite(output.bymaAtmIvPct) && output.bymaAtmIvPct > 0
        ? output.bymaAtmIvPct / 100
        : front.ivAtm ?? Number.NaN;

    const anomalyMap = new Map((output?.anomalies ?? []).map((a) => [a.strikeBymaArs, a]));
    const smileComparison: GgalSmileComparisonPointDto[] = [];
    const enrichedAnomalies: CrossCurrencyVolOutput['anomalies'][number][] = [];
    const putWingCclRoots: number[] = [];
    const callWingCclRoots: number[] = [];

    for (const strike of front.strikes) {
      const call = front.calls.find((c) => c.strike === strike);
      const put = front.puts.find((p) => p.strike === strike);
      const anom = anomalyMap.get(strike);
      const oi =
        (call?.openInterest ?? 0) + (put?.openInterest ?? 0) > 0
          ? (call?.openInterest ?? 0) + (put?.openInterest ?? 0)
          : null;

      const bymaCallPct = call?.iv !== null && call?.iv !== undefined && Number.isFinite(call.iv) && call.iv > 0 ? call.iv * 100 : null;
      const bymaPutPct = put?.iv !== null && put?.iv !== undefined && Number.isFinite(put.iv) && put.iv > 0 ? put.iv * 100 : null;

      let z = anom !== undefined && Number.isFinite(anom.standardizedMoneynessZ) ? anom.standardizedMoneynessZ : Number.NaN;
      if (!Number.isFinite(z) && computeBymaEval !== null && Number.isFinite(bymaAtmAnnual) && bymaAtmAnnual > 0 && computeBymaEval.tExpYears > 0) {
        z = Math.log(strike / computeBymaEval.forwardArs) / (bymaAtmAnnual * Math.sqrt(computeBymaEval.tExpYears));
      }

      const fwdArs = computeBymaEval?.forwardArs ?? spot24hArs;
      const isOtmCall = Number.isFinite(fwdArs) ? strike >= fwdArs : true;
      const obsBymaPct =
        anom !== undefined && Number.isFinite(anom.bymaMidIvPct) && anom.bymaMidIvPct > 0
          ? anom.bymaMidIvPct
          : isOtmCall
            ? (bymaCallPct ?? bymaPutPct)
            : (bymaPutPct ?? bymaCallPct);

      let theorPct =
        anom !== undefined && Number.isFinite(anom.theoreticalBymaIvPct) && anom.theoreticalBymaIvPct > 0
          ? anom.theoreticalBymaIvPct
          : Number.NaN;
      let spreadPct =
        anom !== undefined && Number.isFinite(anom.relValVolSpreadPct)
          ? anom.relValVolSpreadPct
          : Number.NaN;

      const opraIvAtZ = Number.isFinite(z) ? evalOpraIvAtZ(z) : Number.NaN;
      if (
        !Number.isFinite(theorPct) &&
        obsBymaPct !== null &&
        Number.isFinite(opraIvAtZ) &&
        opraIvAtZ > 0 &&
        Number.isFinite(harRvCclAnnual) &&
        Number.isFinite(corr)
      ) {
        const varTheor =
          opraIvAtZ * opraIvAtZ +
          harRvCclAnnual * harRvCclAnnual +
          2 * corr * opraIvAtZ * harRvCclAnnual;
        if (varTheor > 0) {
          theorPct = Math.sqrt(varTheor) * 100;
          spreadPct = obsBymaPct - theorPct;
        }
      } else if (!Number.isFinite(spreadPct) && obsBymaPct !== null && Number.isFinite(theorPct)) {
        spreadPct = obsBymaPct - theorPct;
      }

      let sideBias = anom?.sideBias ?? null;
      if (Number.isFinite(spreadPct) && (anom === undefined || !Number.isFinite(anom.theoreticalBymaIvPct))) {
        sideBias = spreadPct <= -4.0 ? 'CHEAP_BYMA' : spreadPct >= 4.0 ? 'RICH_BYMA' : 'FAIR';
      }
      const arbFlag = anom?.arbFlag ?? (obsBymaPct !== null ? 'OK' : null);

      if (
        Number.isFinite(z) &&
        Number.isFinite(opraIvAtZ) &&
        opraIvAtZ > 0 &&
        Number.isFinite(corr)
      ) {
        if (z <= -0.5 && Math.abs(z) <= 3.5 && bymaPutPct !== null) {
          const putAnn = bymaPutPct / 100;
          if (putAnn > opraIvAtZ) {
            const disc = putAnn * putAnn - (1 - corr * corr) * opraIvAtZ * opraIvAtZ;
            if (disc >= 0) {
              const root = -corr * opraIvAtZ + Math.sqrt(disc);
              if (Number.isFinite(root) && root > 0) {
                putWingCclRoots.push(root * 100);
              }
            }
          }
        } else if (z >= 0.5 && Math.abs(z) <= 3.5 && bymaCallPct !== null) {
          const callAnn = bymaCallPct / 100;
          if (callAnn > opraIvAtZ) {
            const disc = callAnn * callAnn - (1 - corr * corr) * opraIvAtZ * opraIvAtZ;
            if (disc >= 0) {
              const root = -corr * opraIvAtZ + Math.sqrt(disc);
              if (Number.isFinite(root) && root > 0) {
                callWingCclRoots.push(root * 100);
              }
            }
          }
        }
      }

      smileComparison.push({
        strikeArs: strike,
        standardizedMoneynessZ: sanitizeFinite(z),
        bymaCallMidIvPct: bymaCallPct,
        bymaPutMidIvPct: bymaPutPct,
        theoreticalBymaIvPct: sanitizeFinite(theorPct),
        relValVolSpreadPct: sanitizeFinite(spreadPct),
        sideBias,
        arbFlag,
        openInterestNom: oi,
      });

      if (obsBymaPct !== null && Number.isFinite(z) && Number.isFinite(theorPct) && Number.isFinite(spreadPct)) {
        enrichedAnomalies.push({
          strikeBymaArs: strike,
          standardizedMoneynessZ: z,
          bymaMidIvPct: obsBymaPct,
          theoreticalBymaIvPct: theorPct,
          relValVolSpreadPct: spreadPct,
          sideBias: sideBias ?? 'FAIR',
          arbFlag: arbFlag ?? 'OK',
        });
      }
    }

    const computeMedian = (vals: readonly number[]): number | null => {
      if (vals.length === 0) {
        return null;
      }
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) {
        return sorted[mid] ?? null;
      }
      const lo = sorted[mid - 1];
      const hi = sorted[mid];
      return lo !== undefined && hi !== undefined ? 0.5 * (lo + hi) : null;
    };

    const wingCcl = computeMedian(putWingCclRoots.length > 0 ? putWingCclRoots : callWingCclRoots);
    const minFloor =
      output !== null && Number.isFinite(output.realizedCorrEwma) && Number.isFinite(output.opraAdrAtmIvPct)
        ? Math.max(0, -output.realizedCorrEwma * output.opraAdrAtmIvPct)
        : Number.NaN;
    const compressionPts =
      output !== null && Number.isFinite(output.bymaAtmIvPct) && Number.isFinite(output.opraAdrAtmIvPct)
        ? output.bymaAtmIvPct - output.opraAdrAtmIvPct
        : Number.NaN;

    const enrichedOutput: CrossCurrencyVolOutput | null =
      output !== null
        ? {
            ...output,
            anomalies: enrichedAnomalies.length > 0 ? enrichedAnomalies : output.anomalies,
          }
        : null;

    return {
      smileComparison,
      enrichedOutput,
      impliedCclVolWingsPct: sanitizeFinite(wingCcl),
      impliedCclMinFloorPct: sanitizeFinite(minFloor),
      atmCompressionPts: sanitizeFinite(compressionPts),
    };
  }

  private buildVolTriangleCore(bundle: MarketBundle): {
    readonly front: ArOptionExpiryDto | null;
    readonly opraMatchedExpiryDate: string | null;
    readonly output: CrossCurrencyVolOutput | null;
    readonly returnObservationsUsed: number;
    readonly executionPriceBasis: ExecutionPriceBasis;
    readonly spot24hArs: number;
    readonly rates: ReturnType<GgalSpecialistRuntime['resolveSofrAndRateBenchmarks']>;
    readonly opraSlices: readonly OpraMaturitySliceInput[];
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;

    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;

    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      rates.rateCurveArs.length === 0
    ) {
      return {
        front,
        opraMatchedExpiryDate: null,
        output: null,
        returnObservationsUsed: 0,
        executionPriceBasis: spots.basis,
        spot24hArs,
        rates,
        opraSlices: [],
      };
    }

    const bymaOptions: BymaOptionQuoteInput[] = [];
    let optBasis: ExecutionPriceBasis = spots.basis;
    for (const c of [...front.calls, ...front.puts]) {
      const built = makeBidAskQuote(c.bid, c.ask, c.mark ?? c.last, isEodMode);
      if (built.basis === 'LIVE_BID_ASK') {
        optBasis = 'LIVE_BID_ASK';
      }
      if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
        bymaOptions.push({
          strike: c.strike,
          contractType: c.contractType,
          quote: built.quote,
          ...(c.openInterest !== null && Number.isFinite(c.openInterest) && c.openInterest >= 0
            ? { openInterestNom: c.openInterest }
            : {}),
        });
      }
    }

    // Construir OPRA slices desde Massive GGAL snapshot
    const opraSlices: OpraMaturitySliceInput[] = [];
    const volSummary = bundle.usSnapshot?.volSurfaceSummary ?? null;
    if (volSummary !== null) {
      for (const sl of volSummary.slices) {
        if (sl.forward === null || sl.ivAtm === null || sl.forward <= 0 || sl.ivAtm <= 0) {
          continue;
        }
        const sliceQuotes: OpraSliceQuoteInput[] = [];
        for (const c of volSummary.contracts) {
          if (c.expirationDate !== sl.expirationDate) {
            continue;
          }
          const iv = c.ownIv ?? c.providerIv;
          if (iv !== null && Number.isFinite(iv) && iv > 0) {
            sliceQuotes.push({
              strike: c.strike,
              contractType: c.contractType,
              ivDecimal: iv,
              ...(c.delta !== null && Number.isFinite(c.delta) ? { delta: c.delta } : {}),
            });
          }
        }
        if (sliceQuotes.length > 0) {
          opraSlices.push({
            timeToExpiryYears: sl.timeToExpiryYears,
            forwardUsd: sl.forward,
            atmIvDecimal: sl.ivAtm,
            quotes: sliceQuotes,
          });
        }
      }

      if (opraSlices.length === 0 && volSummary.contracts.length > 0) {
        const spotAdrUsd =
          Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask) && spots.adrQuote.ask > 0
            ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
            : Number.NaN;
        if (Number.isFinite(spotAdrUsd) && spotAdrUsd > 0) {
          const byExp = new Map<
            string,
            { expiryUtcSec: number; quotes: OpraSliceQuoteInput[] }
          >();
          for (const c of volSummary.contracts) {
            if (c.expiryUtcSec <= bundle.asOfUtcSec) {
              continue;
            }
            const iv = c.ownIv ?? c.providerIv;
            if (iv === null || !Number.isFinite(iv) || iv <= 0) {
              continue;
            }
            const bucket = byExp.get(c.expirationDate) ?? {
              expiryUtcSec: c.expiryUtcSec,
              quotes: [],
            };
            bucket.quotes.push({
              strike: c.strike,
              contractType: c.contractType,
              ivDecimal: iv,
              ...(c.delta !== null && Number.isFinite(c.delta) ? { delta: c.delta } : {}),
            });
            byExp.set(c.expirationDate, bucket);
          }
          const sofrAnnual = Number.isFinite(rates.sofrRateAnnual) ? rates.sofrRateAnnual : 0;
          for (const [, grp] of byExp) {
            if (grp.quotes.length < 2) {
              continue;
            }
            const tYears = Math.max(1 / 365, (grp.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
            const forwardUsd = spotAdrUsd * Math.exp((sofrAnnual - 0.012) * tYears);
            const sortedNear = [...grp.quotes].sort(
              (a, b) => Math.abs(a.strike - forwardUsd) - Math.abs(b.strike - forwardUsd),
            );
            const atmSample = sortedNear.slice(0, 2);
            const atmIvDecimal =
              atmSample.reduce((acc, q) => acc + q.ivDecimal, 0) / Math.max(1, atmSample.length);
            if (Number.isFinite(atmIvDecimal) && atmIvDecimal > 0) {
              opraSlices.push({
                timeToExpiryYears: tYears,
                forwardUsd,
                atmIvDecimal,
                quotes: grp.quotes,
              });
            }
          }
        }
      }
    }

    // Series causales de retornos ADR USD y CCL GGAL
    const arByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const bar of bundle.ggalDetail.historicalBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        arByDate.set(bar.date, { time: bar.time, close: bar.close });
      }
    }
    const adrByDate = new Map<string, number>();
    for (const bar of bundle.usDailyCloseBars) {
      if (Number.isFinite(bar.close) && bar.close > 0) {
        adrByDate.set(formatIsoUtcFromSec(bar.time).slice(0, 10), bar.close);
      }
    }

    const alignedDates = [...arByDate.keys()].filter((d) => adrByDate.has(d)).sort();
    const returnHistory: { readonly time: number; readonly adrLogReturn: number; readonly cclLogReturn: number }[] = [];
    const cclReturnHistory: { readonly time: number; readonly logReturn: number }[] = [];

    for (let i = 1; i < alignedDates.length; i += 1) {
      const prevD = alignedDates[i - 1];
      const currD = alignedDates[i];
      if (prevD === undefined || currD === undefined) {
        continue;
      }
      const arPrev = arByDate.get(prevD);
      const arCurr = arByDate.get(currD);
      const adrPrev = adrByDate.get(prevD);
      const adrCurr = adrByDate.get(currD);
      if (
        arPrev === undefined ||
        arCurr === undefined ||
        adrPrev === undefined ||
        adrCurr === undefined ||
        adrPrev <= 0 ||
        adrCurr <= 0 ||
        arPrev.close <= 0 ||
        arCurr.close <= 0
      ) {
        continue;
      }
      const cclPrev = (GGAL_ADR_RATIO * arPrev.close) / adrPrev;
      const cclCurr = (GGAL_ADR_RATIO * arCurr.close) / adrCurr;
      if (cclPrev <= 0 || cclCurr <= 0) {
        continue;
      }
      const rAdr = Math.log(adrCurr / adrPrev);
      const rCcl = Math.log(cclCurr / cclPrev);
      returnHistory.push({ time: arCurr.time, adrLogReturn: rAdr, cclLogReturn: rCcl });
      cclReturnHistory.push({ time: arCurr.time, logReturn: rCcl });
    }

    if (bymaOptions.length === 0 || opraSlices.length === 0 || returnHistory.length < 10) {
      return {
        front,
        opraMatchedExpiryDate: volSummary?.slices[0]?.expirationDate ?? null,
        output: null,
        returnObservationsUsed: returnHistory.length,
        executionPriceBasis: optBasis,
        spot24hArs,
        rates,
        opraSlices,
      };
    }

    const expiryDateKey = front.expirationDate;
    const output = evaluateCrossCurrencyVolTriangle({
      asOfUtcSec: bundle.asOfUtcSec,
      bymaEval: {
        asOfUtcSec: bundle.asOfUtcSec,
        spot24hArs,
        expiryDateKey,
        expiry1530UtcSec: computeExpiration1530ArtUtcSec(expiryDateKey),
        arHolidays: this.arHolidays,
        rateCurve: rates.rateCurveArs,
      },
      bymaOptions,
      opraSlices,
      returnHistory,
      cclReturnHistory,
      minCorrObs: 10,
      minHarObs: 22,
    });

    const targetYears = front.days / 365;
    const matchedSlice =
      volSummary?.slices
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetYears) - Math.abs(b.timeToExpiryYears - targetYears))[0] ??
      null;

    return {
      front,
      opraMatchedExpiryDate: matchedSlice?.expirationDate ?? null,
      output,
      returnObservationsUsed: returnHistory.length,
      executionPriceBasis: optBasis,
      spot24hArs,
      rates,
      opraSlices,
    };
  }

  public async getVolTriangle(forceRefresh = false): Promise<GgalVolTriangleResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.buildVolTriangleCore(bundle);
    const telemetry = this.resolveTelemetryMode(bundle, core.executionPriceBasis);

    const ext = this.evaluateExtrapolatedVolTriangleSmile({
      output: core.output,
      front: core.front,
      spot24hArs: core.spot24hArs,
      rates: core.rates,
      opraSlices: core.opraSlices,
      asOfUtcSec: bundle.asOfUtcSec,
    });

    return {
      telemetry,
      frontExpiryCode: core.front?.expiryCode ?? null,
      frontExpiryDate: core.front?.expirationDate ?? null,
      frontDteCalendar: core.front?.days ?? null,
      opraMatchedExpiryDate: core.opraMatchedExpiryDate,
      result: ext.enrichedOutput !== null ? toJsonSafe(ext.enrichedOutput) : null,
      smileComparison: ext.smileComparison,
      returnObservationsUsed: core.returnObservationsUsed,
      impliedCclVolWingsPct: ext.impliedCclVolWingsPct,
      impliedCclMinFloorPct: ext.impliedCclMinFloorPct,
      atmCompressionPts: ext.atmCompressionPts,
    };
  }

  private buildDualDensityCore(bundle: MarketBundle): {
    readonly front: ArOptionExpiryDto | null;
    readonly cerSource: string | null;
    readonly expectedCerGrowthOverHorizon: number;
    readonly historicalSeries: HistoricalDualObservation[];
    readonly output: DualProbabilityOutput | null;
    readonly executionPriceBasis: ExecutionPriceBasis;
  } {
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);

    const spotByma24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;
    const spotAdrUsd =
      Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask)
        ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
        : Number.NaN;

    const arByDate = new Map(bundle.ggalDetail.historicalBars.map((b) => [b.date, b]));
    const adrByDate = new Map<string, { readonly time: number; readonly close: number }>();
    for (const b of bundle.usDailyCloseBars) {
      if (Number.isFinite(b.close) && b.close > 0) {
        adrByDate.set(formatIsoUtcFromSec(b.time).slice(0, 10), { time: b.time, close: b.close });
      }
    }

    // CCL soberano por fecha desde AL30/AL30C y GD30/GD30C para complementar feriados locales
    const al30ByDate = new Map(bundle.al30History.map((p) => [p.date, p.close]));
    const al30cByDate = new Map(bundle.al30cHistory.map((p) => [p.date, p.close]));
    const gd30ByDate = new Map(bundle.gd30History.map((p) => [p.date, p.close]));
    const gd30cByDate = new Map(bundle.gd30cHistory.map((p) => [p.date, p.close]));
    const bondCclByDate = new Map<string, number>();
    for (const date of adrByDate.keys()) {
      const ratios: number[] = [];
      const a = al30ByDate.get(date);
      const ac = al30cByDate.get(date);
      if (a !== undefined && ac !== undefined && a > 0 && ac > 0) {
        ratios.push(a / ac);
      }
      const g = gd30ByDate.get(date);
      const gc = gd30cByDate.get(date);
      if (g !== undefined && gc !== undefined && g > 0 && gc > 0) {
        ratios.push(g / gc);
      }
      if (ratios.length > 0) {
        bondCclByDate.set(date, ratios.reduce((acc, v) => acc + v, 0) / ratios.length);
      }
    }

    // Alinear BCRA CER (exacta o último día hábil publicado <= fecha de barra)
    const cerSorted = bundle.cerHistory;
    const findCerOnOrBefore = (date: string): number | null => {
      let latest: number | null = null;
      for (const c of cerSorted) {
        if (c.date <= date) {
          latest = c.value;
        } else {
          break;
        }
      }
      return latest;
    };

    const historicalSeries: HistoricalDualObservation[] = [];
    for (const date of [...adrByDate.keys()].sort()) {
      const arBar = arByDate.get(date);
      const adrEntry = adrByDate.get(date);
      const cerVal = findCerOnOrBefore(date);
      if (adrEntry === undefined || cerVal === null || adrEntry.close <= 0 || cerVal <= 0) {
        continue;
      }
      const cclVal =
        arBar !== undefined && arBar.close > 0
          ? (GGAL_ADR_RATIO * arBar.close) / adrEntry.close
          : bondCclByDate.get(date);
      if (cclVal === undefined || !Number.isFinite(cclVal) || cclVal <= 0) {
        continue;
      }
      historicalSeries.push({
        time: arBar?.time ?? adrEntry.time,
        adrCloseUsd: adrEntry.close,
        cclGgal: cclVal,
        cerIndex: cerVal,
      });
    }

    let expectedCerGrowth = Number.NaN;
    let cerSource: string | null =
      cerSorted.length > 0 ? `BCRA v4.0 Variable ${String(bundle.cerVarId)} (CER)` : null;
    if (front !== null) {
      const dte = front.days;
      const infM = bundle.macro.variables.inflacionMensualPct;
      if (infM !== null && Number.isFinite(infM) && infM > -99) {
        expectedCerGrowth = Math.pow(1 + infM / 100, dte / 30) - 1;
        cerSource = cerSource ?? 'ArgentinaDatos IPC Mensual';
      } else if (cerSorted.length >= 25) {
        const tail = cerSorted[cerSorted.length - 1];
        const ref = cerSorted[Math.max(0, cerSorted.length - 22)];
        if (tail !== undefined && ref !== undefined && ref.value > 0) {
          const monthlyFactor = tail.value / ref.value;
          expectedCerGrowth = Math.pow(monthlyFactor, dte / 30) - 1;
        }
      }
    }

    if (
      front === null ||
      !Number.isFinite(spotByma24hArs) ||
      spotByma24hArs <= 0 ||
      !Number.isFinite(spotAdrUsd) ||
      spotAdrUsd <= 0 ||
      !Number.isFinite(expectedCerGrowth) ||
      rates.rateCurveArs.length === 0
    ) {
      return {
        front,
        cerSource,
        expectedCerGrowthOverHorizon: expectedCerGrowth,
        historicalSeries,
        output: null,
        executionPriceBasis: spots.basis,
      };
    }

    const bymaEval = computeBymaOptionEvalParams({
      asOfUtcSec: bundle.asOfUtcSec,
      spot24hArs: spotByma24hArs,
      expiryDateKey: front.expirationDate,
      expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
      arHolidays: this.arHolidays,
      rateCurve: rates.rateCurveArs,
    });

    const bymaNodes: OptionSliceIvNode[] = [];
    const bymaFwdRef = bymaEval?.forwardArs ?? spotByma24hArs;
    for (const strike of front.strikes) {
      const c = front.calls.find((x) => x.strike === strike);
      const p = front.puts.find((x) => x.strike === strike);
      const callIv = c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv >= 0.03 && c.iv <= 3.0 ? c.iv : null;
      const putIv = p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv >= 0.03 && p.iv <= 3.0 ? p.iv : null;
      const otmIv = strike >= bymaFwdRef ? (callIv ?? putIv) : (putIv ?? callIv);
      if (otmIv !== null) {
        bymaNodes.push({ strike, ivDecimal: otmIv });
      }
    }
    if (bymaNodes.length < 5) {
      bymaNodes.length = 0;
      for (const strike of front.strikes) {
        const c = front.calls.find((x) => x.strike === strike);
        const p = front.puts.find((x) => x.strike === strike);
        const ivs = [c?.iv, p?.iv].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0.01);
        if (ivs.length > 0) {
          bymaNodes.push({
            strike,
            ivDecimal: ivs.reduce((a, b) => a + b, 0) / ivs.length,
          });
        }
      }
    }

    const slices = bundle.usSnapshot?.volSurfaceSummary?.slices ?? [];
    const targetYears = front.days / 365;
    const matchedSlice =
      slices
        .slice()
        .sort((a, b) => Math.abs(a.timeToExpiryYears - targetYears) - Math.abs(b.timeToExpiryYears - targetYears))[0] ??
      null;

    const opraNodes: OptionSliceIvNode[] = [];
    if (matchedSlice !== null) {
      for (const node of matchedSlice.nodes) {
        if (node.iv !== null && Number.isFinite(node.iv) && node.iv >= 0.03 && node.iv <= 3.0) {
          opraNodes.push({ strike: node.strike, ivDecimal: node.iv });
        }
      }
    }

    let opraForwardPrice = matchedSlice?.forward ?? null;
    let opraTimeToExpiryYears = matchedSlice?.timeToExpiryYears ?? null;
    let opraRiskFreeContinuous = matchedSlice?.rate ?? null;

    if (opraNodes.length < 5) {
      const contracts = bundle.usSnapshot?.volSurfaceSummary?.contracts ?? [];
      const validByExp = new Map<
        string,
        { expiryUtcSec: number; byStrike: Map<number, { calls: number[]; puts: number[] }> }
      >();
      for (const c of contracts) {
        if (c.expiryUtcSec <= bundle.asOfUtcSec) {
          continue;
        }
        const iv = c.ownIv ?? c.providerIv;
        if (iv === null || !Number.isFinite(iv) || iv < 0.03 || iv > 3.0) {
          continue;
        }
        const grp = validByExp.get(c.expirationDate) ?? {
          expiryUtcSec: c.expiryUtcSec,
          byStrike: new Map<number, { calls: number[]; puts: number[] }>(),
        };
        const bucket = grp.byStrike.get(c.strike) ?? { calls: [], puts: [] };
        if (c.contractType === 'call') {
          bucket.calls.push(iv);
        } else {
          bucket.puts.push(iv);
        }
        grp.byStrike.set(c.strike, bucket);
        validByExp.set(c.expirationDate, grp);
      }
      const bestExp = [...validByExp.values()]
        .filter((g) => g.byStrike.size >= 3)
        .sort((a, b) => {
          const tA = Math.max(1 / 365, (a.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
          const tB = Math.max(1 / 365, (b.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
          return Math.abs(tA - targetYears) - Math.abs(tB - targetYears);
        })[0];

      if (bestExp !== undefined) {
        opraNodes.length = 0;
        const tYears = Math.max(1 / 365, (bestExp.expiryUtcSec - bundle.asOfUtcSec) / (365 * 86_400));
        const rFree = Number.isFinite(rates.sofrRateAnnual) ? rates.sofrRateAnnual : 0;
        const estForward = spotAdrUsd * Math.exp((rFree - 0.012) * tYears);
        const strikesSorted = [...bestExp.byStrike.keys()].sort((a, b) => a - b);
        for (const k of strikesSorted) {
          const bucket = bestExp.byStrike.get(k);
          if (bucket === undefined) {
            continue;
          }
          const primary = k >= estForward ? bucket.calls : bucket.puts;
          const fallback = k >= estForward ? bucket.puts : bucket.calls;
          const ivArr = primary.length > 0 ? primary : fallback;
          if (ivArr.length > 0) {
            opraNodes.push({
              strike: k,
              ivDecimal: ivArr.reduce((acc, v) => acc + v, 0) / ivArr.length,
            });
          }
        }
        opraTimeToExpiryYears = tYears;
        opraRiskFreeContinuous = rFree;
        opraForwardPrice = estForward;
      }
    }

    if (
      bymaEval === null ||
      bymaNodes.length < 5 ||
      opraForwardPrice === null ||
      opraTimeToExpiryYears === null ||
      opraRiskFreeContinuous === null ||
      opraNodes.length < 3 ||
      historicalSeries.length < 25
    ) {
      return {
        front,
        cerSource,
        expectedCerGrowthOverHorizon: expectedCerGrowth,
        historicalSeries,
        output: null,
        executionPriceBasis: spots.basis,
      };
    }

    const output = evaluateDualProbabilityDensity({
      asOfUtcSec: bundle.asOfUtcSec,
      expiryDate: front.expirationDate,
      dteCalendar: front.days,
      spotByma24hArs,
      spotAdrUsd,
      expectedCerGrowthOverHorizon: expectedCerGrowth,
      historicalSeries,
      bymaMarket: {
        forwardPrice: bymaEval.forwardArs,
        timeToExpiryYears: bymaEval.tExpYears,
        riskFreeContinuous: bymaEval.rEff,
        timeToSettleYears: bymaEval.tSettleYears,
        nodes: bymaNodes,
      },
      opraMarket: {
        forwardPrice: opraForwardPrice,
        timeToExpiryYears: opraTimeToExpiryYears,
        riskFreeContinuous: opraRiskFreeContinuous,
        timeToSettleYears: opraTimeToExpiryYears,
        nodes: opraNodes,
      },
      minHistoricalObs: 25,
    });

    return {
      front,
      cerSource,
      expectedCerGrowthOverHorizon: expectedCerGrowth,
      historicalSeries,
      output,
      executionPriceBasis: spots.basis,
    };
  }

  public async getDualDensity(forceRefresh = false): Promise<GgalDualDensityResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const core = this.buildDualDensityCore(bundle);
    const telemetry = this.resolveTelemetryMode(bundle, core.executionPriceBasis);

    return {
      telemetry,
      frontExpiryCode: core.front?.expiryCode ?? null,
      frontExpiryDate: core.front?.expirationDate ?? null,
      dteCalendar: core.front?.days ?? null,
      cerSource: core.cerSource,
      expectedCerGrowthOverHorizonPct: Number.isFinite(core.expectedCerGrowthOverHorizon)
        ? sanitizeFinite(core.expectedCerGrowthOverHorizon * 100)
        : null,
      historicalObsUsed: core.historicalSeries.length,
      cerSeriesCount: bundle.cerHistory.length,
      result: core.output !== null ? toJsonSafe(core.output) : null,
    };
  }

  public async getStructurePinning(forceRefresh = false): Promise<GgalStructurePinningResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);

    const data912TotalOiFallback: GgalData912OiFallbackItemDto[] = [];
    if (front !== null) {
      for (const strike of front.strikes) {
        const c = front.calls.find((x) => x.strike === strike);
        const p = front.puts.find((x) => x.strike === strike);
        data912TotalOiFallback.push({
          strikeArs: strike,
          callTotalOiNom: c?.openInterest ?? null,
          putTotalOiNom: p?.openInterest ?? null,
          callIvPct: c?.iv !== null && c?.iv !== undefined ? sanitizeFinite(c.iv * 100) : null,
          putIvPct: p?.iv !== null && p?.iv !== undefined ? sanitizeFinite(p.iv * 100) : null,
        });
      }
    }

    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;

    const computeEodPrevSessionFlows = (): {
      readonly bymaNetSignedArs: number;
      readonly adrNetSignedUsd: number;
    } => {
      let bymaNetSignedArs = 0;
      if (front !== null) {
        for (const opt of [...front.calls, ...front.puts]) {
          const vol = opt.volume !== null && Number.isFinite(opt.volume) && opt.volume > 0 ? opt.volume : 0;
          const price =
            opt.last !== null && Number.isFinite(opt.last) && opt.last > 0
              ? opt.last
              : opt.mark !== null && Number.isFinite(opt.mark) && opt.mark > 0
                ? opt.mark
                : 0;
          const varPct =
            opt.changePct !== null && opt.changePct !== undefined && Number.isFinite(opt.changePct)
              ? opt.changePct
              : 0;
          const sign = varPct > 0 ? 1 : varPct < 0 ? -1 : 0;
          if (vol > 0 && price > 0 && sign !== 0) {
            bymaNetSignedArs += vol * price * 100 * sign;
          }
        }
      }

      let adrNetSignedUsd = 0;
      const usBars = bundle.usBars?.bars ?? [];
      const lastBar = usBars.length > 0 ? usBars[usBars.length - 1] : undefined;
      if (lastBar !== undefined) {
        const range = lastBar.high - lastBar.low;
        const vwap =
          lastBar.vw !== null && Number.isFinite(lastBar.vw) && lastBar.vw > 0
            ? lastBar.vw
            : (lastBar.high + lastBar.low + lastBar.close) / 3;
        if (
          Number.isFinite(range) &&
          range > 0 &&
          Number.isFinite(lastBar.volume) &&
          lastBar.volume > 0 &&
          Number.isFinite(vwap) &&
          vwap > 0
        ) {
          adrNetSignedUsd = ((lastBar.close - lastBar.open) / range) * lastBar.volume * vwap;
        }
      }

      return { bymaNetSignedArs, adrNetSignedUsd };
    };

    const applyEodFlowIfClosedZero = (
      out: StructurePinningOutput,
    ): { readonly output: StructurePinningOutput; readonly flowBasis: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT' } => {
      if (
        isClosed &&
        out.intradayFlow.bymaNetSignedArs === 0 &&
        out.intradayFlow.adrNetSignedUsd === 0
      ) {
        const eod = computeEodPrevSessionFlows();
        return {
          output: {
            ...out,
            intradayFlow: {
              ...out.intradayFlow,
              bymaNetSignedArs: eod.bymaNetSignedArs,
              adrNetSignedUsd: eod.adrNetSignedUsd,
            },
          },
          flowBasis: 'EOD_PREV_SESSION',
        };
      }
      return {
        output: out,
        flowBasis: isClosed ? 'EOD_PREV_SESSION' : 'INTRADAY_SNAPSHOT',
      };
    };

    if (this.anexoBStore === null) {
      let proxyOut: StructurePinningOutput | null = null;
      let flowBasis: 'EOD_PREV_SESSION' | 'INTRADAY_SNAPSHOT' = isClosed
        ? 'EOD_PREV_SESSION'
        : 'INTRADAY_SNAPSHOT';
      if (
        front !== null &&
        Number.isFinite(spot24hArs) &&
        spot24hArs > 0 &&
        rates.rateCurveArs.length > 0 &&
        front.ivAtm !== null &&
        Number.isFinite(front.ivAtm) &&
        front.ivAtm > 0
      ) {
        const proxyStrikes: AnexoBStrikeChainInput[] = [];
        for (const strike of front.strikes) {
          const c = front.calls.find((x) => x.strike === strike);
          const p = front.puts.find((x) => x.strike === strike);
          const rawCallLots = Math.max(0, c?.openInterest ?? c?.volume ?? 0);
          const rawPutLots = Math.max(0, p?.openInterest ?? p?.volume ?? 0);
          const callIv =
            c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv > 0
              ? c.iv
              : front.ivAtm;
          const putIv =
            p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv > 0
              ? p.iv
              : front.ivAtm;
          if ((rawCallLots > 0 || rawPutLots > 0) && Number.isFinite(callIv) && Number.isFinite(putIv)) {
            proxyStrikes.push({
              strikeArs: strike,
              callOi: { coveredNom: 0, uncoveredNom: rawCallLots * 100, oppositeNom: 0, crossedNom: 0 },
              putOi: { coveredNom: 0, uncoveredNom: rawPutLots * 100, oppositeNom: 0, crossedNom: 0 },
              callIvDecimal: callIv,
              putIvDecimal: putIv,
            });
          }
        }
        if (proxyStrikes.length > 0) {
          const rawProxyOut = evaluateStructureAndPinning({
            asOfUtcSec: bundle.asOfUtcSec,
            anexoBAsOfDate: formatIsoUtcFromSec(bundle.asOfUtcSec).slice(0, 10),
            bymaEval: {
              asOfUtcSec: bundle.asOfUtcSec,
              spot24hArs,
              expiryDateKey: front.expirationDate,
              expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
              arHolidays: this.arHolidays,
              rateCurve: rates.rateCurveArs,
            },
            atmIvDecimal: front.ivAtm,
            strikes: proxyStrikes,
            weights: DEFAULT_ANEXO_B_WEIGHTS,
            arHolidays: this.arHolidays,
            ...(this.bymaFlowSnapshots.length >= 2 ? { bymaSnapshots: this.bymaFlowSnapshots } : {}),
          });
          const resolved = applyEodFlowIfClosedZero(rawProxyOut);
          proxyOut = resolved.output;
          flowBasis = resolved.flowBasis;
        }
      }
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        anexoBSummary: null,
        result: null,
        proxyResult: proxyOut !== null ? toJsonSafe(proxyOut) : null,
        proxySource: proxyOut !== null ? ('PROXY DATA912 (SIN ANEXO B)' as const) : null,
        flowBasis,
        data912TotalOiFallback,
        notice:
          proxyOut !== null
            ? 'Modo PROXY DATA912 (SIN ANEXO B): GEX/Zero-Gamma/Pinning calculados sobre volumen/OI activo de Data912. Ingesta Anexo B IAMC para desglose oficial Cubierta/Descubierta/Opuesta/Cruzada.'
            : 'Sin matriz Anexo B IAMC cargada. Ingresa las columnas Cubierta / Descubierta / Opuesta / Cruzada (en acciones nominales) para activar GEX/Vanna/Charm y Zero-Gamma Brent.',
      };
    }

    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      rates.rateCurveArs.length === 0
    ) {
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        anexoBSummary: this.anexoBStore.totals,
        result: null,
        proxyResult: null,
        proxySource: null,
        flowBasis: isClosed ? 'EOD_PREV_SESSION' : 'INTRADAY_SNAPSHOT',
        data912TotalOiFallback,
        notice: 'Falta cadena líquida o curva de tasas ARS para evaluar Anexo B contra BS02.',
      };
    }

    const fallbackAtmIv = front.ivAtm ?? 0.45;
    const strikesInput: AnexoBStrikeChainInput[] = [];
    for (const row of this.anexoBStore.rows) {
      const c = front.calls.find((x) => x.strike === row.strikeArs);
      const p = front.puts.find((x) => x.strike === row.strikeArs);
      const callIv = c?.iv !== null && c?.iv !== undefined && Number.isFinite(c.iv) && c.iv > 0 ? c.iv : fallbackAtmIv;
      const putIv = p?.iv !== null && p?.iv !== undefined && Number.isFinite(p.iv) && p.iv > 0 ? p.iv : fallbackAtmIv;
      strikesInput.push({
        strikeArs: row.strikeArs,
        callOi: row.callOi,
        putOi: row.putOi,
        callIvDecimal: callIv,
        putIvDecimal: putIv,
      });
    }

    const rawOut = evaluateStructureAndPinning({
      asOfUtcSec: bundle.asOfUtcSec,
      anexoBAsOfDate: this.anexoBStore.asOfDate,
      bymaEval: {
        asOfUtcSec: bundle.asOfUtcSec,
        spot24hArs,
        expiryDateKey: front.expirationDate,
        expiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
        arHolidays: this.arHolidays,
        rateCurve: rates.rateCurveArs,
      },
      atmIvDecimal: front.ivAtm ?? Number.NaN,
      strikes: strikesInput,
      weights: DEFAULT_ANEXO_B_WEIGHTS,
      arHolidays: this.arHolidays,
      ...(this.bymaFlowSnapshots.length >= 2 ? { bymaSnapshots: this.bymaFlowSnapshots } : {}),
    });
    const resolvedOut = applyEodFlowIfClosedZero(rawOut);
    const out = resolvedOut.output;

    const telemetry = this.resolveTelemetryMode(
      bundle,
      spots.basis,
      undefined,
      out.anexoBLagTradingDays,
    );

    return {
      telemetry,
      frontExpiryCode: front.expiryCode,
      frontExpiryDate: front.expirationDate,
      anexoBSummary: this.anexoBStore.totals,
      result: toJsonSafe(out),
      proxyResult: null,
      proxySource: null,
      flowBasis: resolvedOut.flowBasis,
      data912TotalOiFallback,
      notice: null,
    };
  }

  public async runStrategySelector(
    reqBody: GgalStrategySelectorRequest = {},
    forceRefresh = false,
  ): Promise<GgalStrategySelectorResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const isClosed = bundle.overview.marketState === 'CERRADO';
    const isEodMode =
      bundle.overview.feedStatus === 'EOD_CIERRE' ||
      bundle.usSnapshot?.feedMode === 'EOD_CIERRE' ||
      isClosed;
    const spots = this.resolveSpotQuotes(bundle, isEodMode);
    const rates = this.resolveSofrAndRateBenchmarks(bundle);
    const { front, back } = selectLiquidFrontAndBackExpiries(bundle.ggalOptions);
    const dual = this.buildDualDensityCore(bundle);

    const feeSchedule: BymaFeeSchedule = {
      ...BYMA_FEE_SCHEDULE,
      ...(reqBody.bymaFeeSchedule ?? {}),
    };
    const usFeeSchedule: UsFeeSchedule = {
      ...DEFAULT_US_FEE_SCHEDULE,
      ...(reqBody.usFeeSchedule ?? {}),
    };

    const spot24hArs =
      Number.isFinite(spots.byma24hQuote.bid) && Number.isFinite(spots.byma24hQuote.ask)
        ? 0.5 * (spots.byma24hQuote.bid + spots.byma24hQuote.ask)
        : Number.NaN;
    const spotAdrUsd =
      Number.isFinite(spots.adrQuote.bid) && Number.isFinite(spots.adrQuote.ask)
        ? 0.5 * (spots.adrQuote.bid + spots.adrQuote.ask)
        : Number.NaN;

    const physicalNodes = dual.output?.simulatedNodes ?? [];
    if (
      front === null ||
      !Number.isFinite(spot24hArs) ||
      spot24hArs <= 0 ||
      !Number.isFinite(spotAdrUsd) ||
      spotAdrUsd <= 0 ||
      physicalNodes.length === 0 ||
      rates.rateCurveArs.length === 0
    ) {
      const telemetry = this.resolveTelemetryMode(bundle, spots.basis);
      return {
        telemetry,
        frontExpiryCode: front?.expiryCode ?? null,
        frontExpiryDate: front?.expirationDate ?? null,
        backExpiryCode: back?.expiryCode ?? null,
        backExpiryDate: back?.expirationDate ?? null,
        feeScheduleUsed: toJsonSafe(feeSchedule),
        physicalNodesCount: physicalNodes.length,
        result: null,
      };
    }

    const anexoOiByStrike = new Map<number, { readonly callNom: number; readonly putNom: number }>();
    if (this.anexoBStore !== null) {
      for (const row of this.anexoBStore.rows) {
        anexoOiByStrike.set(row.strikeArs, {
          callNom:
            row.callOi.coveredNom +
            row.callOi.uncoveredNom +
            row.callOi.oppositeNom +
            row.callOi.crossedNom,
          putNom:
            row.putOi.coveredNom +
            row.putOi.uncoveredNom +
            row.putOi.oppositeNom +
            row.putOi.crossedNom,
        });
      }
    }

    const bymaChain: BymaStrategyOptionQuote[] = [];
    let optBasis: ExecutionPriceBasis = spots.basis;
    const selectedExpiries = back !== null ? [front, back] : [front];
    for (const exp of selectedExpiries) {
      const anexoAppliesToExp =
        this.anexoBStore !== null &&
        exp.expiryCode === front.expiryCode &&
        (this.anexoBStore.expiryCode === null || this.anexoBStore.expiryCode === exp.expiryCode);
      for (const c of [...exp.calls, ...exp.puts]) {
        const built = makeBidAskQuote(c.bid, c.ask, c.mark ?? c.last, isEodMode);
        if (built.basis === 'LIVE_BID_ASK') {
          optBasis = 'LIVE_BID_ASK';
        }
        const baseOi =
          c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0;
        const anexoRow = anexoAppliesToExp ? anexoOiByStrike.get(c.strike) : undefined;
        const anexoNom =
          anexoRow !== undefined ? (c.contractType === 'call' ? anexoRow.callNom : anexoRow.putNom) : 0;
        const effectiveOiNom = Math.max(baseOi, anexoNom);
        if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
          bymaChain.push({
            ticker: c.symbol,
            contractType: c.contractType,
            strikeArs: c.strike,
            expiryDateKey: exp.expirationDate,
            expiry1530UtcSec: computeExpiration1530ArtUtcSec(exp.expirationDate),
            bidArs: built.quote.bid,
            askArs: built.quote.ask,
            openInterestNom: effectiveOiNom,
            ...(c.iv !== null && Number.isFinite(c.iv) && c.iv > 0 ? { ivDecimal: c.iv } : {}),
          });
        }
      }
    }

    const opraChain: OpraStrategyOptionQuote[] = [];
    for (const c of bundle.usSnapshot?.volSurfaceSummary?.contracts ?? []) {
      const built = makeBidAskQuote(c.bid, c.ask, c.mid ?? c.lastPrice, isEodMode);
      const iv = c.ownIv ?? c.providerIv;
      if (Number.isFinite(built.quote.bid) && Number.isFinite(built.quote.ask) && built.quote.bid > 0) {
        opraChain.push({
          ticker: c.ticker,
          contractType: c.contractType,
          strikeUsd: c.strike,
          expiryDateKey: c.expirationDate,
          expiryUtcSec: c.expiryUtcSec,
          bidUsd: built.quote.bid,
          askUsd: built.quote.ask,
          openInterestContracts: c.openInterest !== null && Number.isFinite(c.openInterest) ? Math.max(0, c.openInterest) : 0,
          ...(iv !== null && Number.isFinite(iv) && iv > 0 ? { ivDecimal: iv } : {}),
        });
      }
    }

    const selectorInput: StrategySelectorInput = {
      asOfUtcSec: bundle.asOfUtcSec,
      spotByma24hArs: spot24hArs,
      spotByma24hQuote: spots.byma24hQuote,
      spotAdrUsd,
      spotAdrQuote: spots.adrQuote,
      frontExpiryDateKey: front.expirationDate,
      frontExpiry1530UtcSec: computeExpiration1530ArtUtcSec(front.expirationDate),
      ...(back !== null
        ? {
            backExpiryDateKey: back.expirationDate,
            backExpiry1530UtcSec: computeExpiration1530ArtUtcSec(back.expirationDate),
          }
        : {}),
      arHolidays: this.arHolidays,
      caucion1dTnaPct: rates.caucion1dTnaPct,
      lecapMatchedTnaPct: rates.lecapMatchedTnaPct,
      sofrPct: rates.sofrPct,
      rateCurveArs: rates.rateCurveArs,
      bymaChain,
      opraChain,
      physicalNodes,
      feeSchedule,
      usFeeSchedule,
      filterThresholds: {
        ...(reqBody.minBymaOiNominals !== undefined
          ? { minBymaOiNominals: reqBody.minBymaOiNominals }
          : this.anexoBStore === null || isEodMode
            ? { minBymaOiNominals: 0 }
            : {}),
        ...(reqBody.minOpraOiContracts !== undefined
          ? { minOpraOiContracts: reqBody.minOpraOiContracts }
          : this.anexoBStore === null || isEodMode
            ? { minOpraOiContracts: 0 }
            : {}),
        ...(reqBody.minEvToCostMultiple !== undefined ? { minEvToRoundTripCostMultiple: reqBody.minEvToCostMultiple } : {}),
        enforceThresholds: reqBody.enforceThresholds ?? false,
        maxCandidates: reqBody.maxCandidates ?? 30,
      },
    };

    const rawOut = evaluateStrategySelector(selectorInput);
    const filtered =
      reqBody.familyFilter !== undefined && reqBody.familyFilter !== 'ALL'
        ? {
            ...rawOut,
            rankedStrategies: rawOut.rankedStrategies.filter(
              (s) => s.family === reqBody.familyFilter,
            ),
          }
        : rawOut;

    const telemetry = this.resolveTelemetryMode(bundle, optBasis);
    return {
      telemetry,
      frontExpiryCode: front.expiryCode,
      frontExpiryDate: front.expirationDate,
      backExpiryCode: back?.expiryCode ?? null,
      backExpiryDate: back?.expirationDate ?? null,
      feeScheduleUsed: toJsonSafe(feeSchedule),
      physicalNodesCount: physicalNodes.length,
      result: toJsonSafe(filtered),
    };
  }

  public async getOverview(forceRefresh = false): Promise<GgalSpecialistOverviewResponse> {
    const bundle = await this.loadMarketBundle(forceRefresh);
    const parity = this.computeParityGapCore(bundle);
    const vol = this.buildVolTriangleCore(bundle);
    const dual = this.buildDualDensityCore(bundle);
    const structure = await this.getStructurePinning(false);
    const strat = await this.runStrategySelector({ maxCandidates: 3, enforceThresholds: false }, false);

    const telemetry = this.resolveTelemetryMode(
      bundle,
      parity.executionPriceBasis,
      parity.output.signal,
      structure.telemetry.anexoBLagTradingDays,
    );

    const strRes = structure.result ?? structure.proxyResult ?? null;

    return {
      telemetry,
      spot: {
        byma24hArs: sanitizeFinite(parity.output.spot.byma24hArs),
        bymaCiArs: sanitizeFinite(parity.output.spot.bymaCiArs),
        adrMidUsd: sanitizeFinite(parity.output.spot.adrMidUsd),
        fairBymaOpenArs: sanitizeFinite(parity.output.spot.fairBymaOpenArs),
        fairAdrUsd: sanitizeFinite(parity.output.spot.fairAdrUsd),
        gapPctVsPrevClose: sanitizeFinite(parity.output.spot.gapPctVsPrevClose),
        cclGgal24h: sanitizeFinite(parity.output.ccl.cclGgal24h),
        cclSovereignBenchmark: sanitizeFinite(parity.output.ccl.cclSovereignBenchmark),
        parityZScore: sanitizeFinite(parity.output.ccl.zScore),
        paritySignal: parity.output.signal,
      },
      volatility: {
        bymaAtmIvPct: vol.output !== null ? sanitizeFinite(vol.output.bymaAtmIvPct) : null,
        opraAdrAtmIvPct: vol.output !== null ? sanitizeFinite(vol.output.opraAdrAtmIvPct) : null,
        impliedCclVolPct: vol.output?.impliedCclVolPct ?? null,
        boundaryRegime: vol.output?.boundaryRegime ?? null,
        anomaliesCount: vol.output?.anomalies.length ?? 0,
      },
      density: {
        status: dual.output !== null ? dual.output.physicalMetricsUsd.status : 'NO_DATA',
        studentTCopulaDof:
          dual.output !== null ? sanitizeFinite(dual.output.physicalMetricsUsd.studentTCopulaDof) : null,
        klBymaPvsQ:
          dual.output !== null ? sanitizeFinite(dual.output.riskNeutralBymaArs.klDivergencePvsQ) : null,
        tailSignal: dual.output !== null ? dual.output.tailDislocationSignal : null,
      },
      structure: {
        regime: strRes?.regime ?? 'NO_DATA',
        zeroGammaLevelArs: strRes?.zeroGammaLevelArs ?? null,
        callWallArs: strRes?.callWallArs ?? null,
        putWallArs: strRes?.putWallArs ?? null,
        peakPinStrikeArs: strRes?.peakPinStrikeArs ?? null,
        bymaNetSignedArs: strRes?.intradayFlow.bymaNetSignedArs ?? null,
        adrNetSignedUsd: strRes?.intradayFlow.adrNetSignedUsd ?? null,
      },
      topStrategies: strat.result?.rankedStrategies ?? [],
    };
  }
}
