/**
 * Verificación en vivo de solo lectura de punta a punta (Piezas 1 a 8) contra Massive.
 *
 * Aislamiento y seguridad:
 *  - Envuelto en `describe.runIf(process.env['RUN_LIVE_SMOKE'] === '1')` y sufijo `.smoke.ts`:
 *    `npm run verify` (`vitest run`) no lo colecciona y mantiene el 100 % de sus 420 tests offline.
 *  - Lee `MASSIVE_API_KEY` (o `MASSIVE_KEY` / `MASSIVE_KEY_OPTIONS`) de `process.env` / `.env`
 *    solo en memoria en tiempo de ejecución. Nunca imprime ni expone credenciales o URLs
 *    con parámetros `apiKey=`/`apikey=`; toda traza y error pasa por `redact`.
 *  - No modifica `.env`, `src/core/*` ni `src/data/*`.
 *
 * Ejecución manual:
 *   RUN_LIVE_SMOKE=1 npx vitest run tests/livePipeline.smoke.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAnchoredVwap } from '../src/core/avwap.js';
import { calculateEma } from '../src/core/ema.js';
import { getMarketParts } from '../src/core/sessions.js';
import { computeSessionVwap } from '../src/core/sessionVwap.js';
import type { Bar } from '../src/core/types.js';
import { solveImpliedVolAmerican } from '../src/core/options/american.js';
import { timeToExpiryYears } from '../src/core/options/blackScholes.js';
import {
  computeDealerExposure,
  type DealerExposureResult,
  type ExposureContractInput,
} from '../src/core/options/exposure.js';
import {
  impliedDividendYieldFromForward,
  inferForwardFromParityDetailed,
  type ParityOptionPair,
} from '../src/core/options/forward.js';
import { solveImpliedVolBsm } from '../src/core/options/impliedVol.js';
import {
  computeSliceVolMetrics,
  type VolSliceMetrics,
} from '../src/core/options/volMetrics.js';
import {
  buildVolSlice,
  validateSliceButterflyArbitrage,
  type VolQuoteInput,
  type VolSlice,
} from '../src/core/options/volSurface.js';
import {
  createLiveBarState,
  ingestWsEvents,
  projectLiveIndicators,
} from '../src/data/liveBarConsolidator.js';
import { loadBars } from '../src/data/loader.js';
import {
  loadFundingConditions,
  loadTreasuryYields,
  loadUnifiedSnapshot,
} from '../src/data/macroLoader.js';
import type {
  TreasuryYieldObservation,
  UnifiedIndexSnapshot,
  UnifiedStockSnapshot,
} from '../src/data/macroTypes.js';
import {
  interpolateTreasuryYield,
  TREASURY_TENORS,
} from '../src/data/normalizeMacro.js';
import { redact, toErrorMessage } from '../src/data/normalizeShared.js';
import { loadOptionChain, loadOptionContracts } from '../src/data/optionsLoader.js';
import type {
  OptionContract,
  OptionSnapshotContract,
  OptionUnderlyingSnapshot,
} from '../src/data/optionsTypes.js';
import type { FetchFn } from '../src/data/types.js';
import {
  loadUnusualTrades,
  type UnusualTradeRecord,
} from '../src/data/unusualTradesLoader.js';
import { MassiveWsClient } from '../src/data/wsClient.js';
import type {
  LiveBarState,
  LiveProjectionInputs,
  LiveProjectionResult,
  WsClientError,
  WsNormalizedEvent,
} from '../src/data/wsTypes.js';

const KEY_ENV_NAMES: readonly string[] = [
  'MASSIVE_API_KEY',
  'MASSIVE_KEY',
  'MASSIVE_KEY_OPTIONS',
  'MASSIVE_OPTIONS',
];

const EXTRA_SECRET_ENV_NAMES: readonly string[] = [
  ...KEY_ENV_NAMES,
  'MASSIVE_KEY_FUTURES',
  'BINGX_API_KEY',
];

const UNIFIED_TICKERS: readonly string[] = [
  'SPY',
  'QQQ',
  'I:SPX',
  'I:VIX',
  'I:SKEW',
  'I:NDX',
];

const STAGE_5A_DURATION_MS = 12_000;
const STAGE_5B_DURATION_MS = 20_000;
const LIVE_TEST_TIMEOUT_MS = 240_000;

interface ResolvedAuth {
  readonly apiKey: string;
  readonly secrets: readonly string[];
}

interface HttpCallMetric {
  readonly endpoint: string;
  readonly status: number;
  readonly elapsedMs: number;
}

interface ExpiryParityEvaluation {
  readonly expirySec: number;
  readonly expirationDate: string;
  readonly timeToExpiry: number;
  readonly rate: number;
  readonly forward: number;
  readonly dividendYield: number;
  readonly validPairsCount: number;
  readonly usedPairsCount: number;
}

interface LiquidSliceSelection {
  readonly parity: ExpiryParityEvaluation;
  readonly slice: VolSlice;
  readonly metrics: VolSliceMetrics;
  readonly butterflyViolationCount: number;
  readonly butterflyMinDensity: number;
  readonly ownIvSolvedCount: number;
  readonly maxIvDiffVsProvider: number;
}

interface ExposureRunSummary {
  readonly underlying: 'SPY' | 'I:SPX';
  readonly exposure: DealerExposureResult;
  readonly ownSolvedIvContracts: number;
  readonly providerFallbackIvContracts: number;
  readonly parityDividendExpiries: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseEnvFile(path: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return values;
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      value.length >= 2 &&
      (value.startsWith("'") || value.startsWith('"'))
    ) {
      const quote = value.charAt(0);
      if (value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    if (key !== '') {
      values.set(key, value);
    }
  }
  return values;
}

function resolveMassiveAuth(): ResolvedAuth {
  const envFile = parseEnvFile(resolve(process.cwd(), '.env'));
  const secretSet = new Set<string>();

  for (const keyName of EXTRA_SECRET_ENV_NAMES) {
    for (const candidate of [process.env[keyName], envFile.get(keyName)]) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed !== '') {
          secretSet.add(trimmed);
          secretSet.add(encodeURIComponent(trimmed));
        }
      }
    }
  }

  let apiKey = '';
  for (const keyName of KEY_ENV_NAMES) {
    const val = (process.env[keyName] ?? envFile.get(keyName) ?? '').trim();
    if (val !== '') {
      apiKey = val;
      break;
    }
  }

  return {
    apiKey,
    secrets: [...secretSet],
  };
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  return redact(text, secrets).replace(
    /([?&](?:api_?key|token|secret)=)[^&\s]+/gi,
    '$1[REDACTED]',
  );
}

function addCalendarDaysEt(nowUtcSec: number, deltaDays: number): string {
  const parts = getMarketParts(nowUtcSec, 'EQUITY');
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return d.toISOString().slice(0, 10);
}

function fmtNum(value: number, decimals = 4): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'NaN';
}

function fmtPct(value: number, decimals = 2): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(decimals)}%` : 'NaN';
}

function fmtUsd(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) {
    return 'NaN';
  }
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function createLiveFetch(
  secrets: readonly string[],
  metrics: HttpCallMetric[],
): FetchFn {
  return async (url: string) => {
    const parsedUrl = new URL(url);
    const endpoint = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const maxNetworkAttempts = 3;

    for (let attempt = 1; attempt <= maxNetworkAttempts; attempt += 1) {
      const t0 = Date.now();
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        const elapsedMs = Date.now() - t0;
        const headersRecord: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headersRecord[name.toLowerCase()] = value;
        });

        metrics.push({
          endpoint,
          status: response.status,
          elapsedMs,
        });

        return {
          ok: response.ok,
          status: response.status,
          text: redactSecrets(text, secrets),
          headers: headersRecord,
        };
      } catch (err: unknown) {
        if (attempt < maxNetworkAttempts) {
          await sleep(250 * attempt);
          continue;
        }
        throw new Error(
          redactSecrets(
            `HTTP GET ${endpoint} failed after ${String(attempt)} attempts: ${toErrorMessage(err, 'network error')}`,
            secrets,
          ),
        );
      }
    }

    throw new Error(`HTTP GET ${endpoint} failed unexpectedly`);
  };
}

function resolveUnifiedStockPrice(stock: UnifiedStockSnapshot | undefined): number {
  if (stock === undefined) {
    return Number.NaN;
  }
  const candidates: readonly (number | undefined)[] = [
    stock.lastTrade?.price,
    stock.lastQuote?.midpoint,
    stock.session.price,
    stock.session.close,
    stock.session.previousClose,
  ];
  for (const c of candidates) {
    if (c !== undefined && Number.isFinite(c) && c > 0) {
      return c;
    }
  }
  return Number.NaN;
}

function resolveUnifiedIndexLevel(indexSnap: UnifiedIndexSnapshot | undefined): number {
  if (indexSnap === undefined) {
    return Number.NaN;
  }
  const candidates: readonly number[] = [
    indexSnap.value,
    indexSnap.session.price,
    indexSnap.session.close,
    indexSnap.session.previousClose,
  ];
  for (const c of candidates) {
    if (Number.isFinite(c) && c > 0) {
      return c;
    }
  }
  return Number.NaN;
}

function resolveChainSpot(
  underlying: OptionUnderlyingSnapshot | null,
  unifiedFallback: number,
): number {
  if (underlying !== null && Number.isFinite(underlying.price) && underlying.price > 0) {
    return underlying.price;
  }
  return unifiedFallback;
}

function resolveQuoteMid(contract: OptionSnapshotContract): number {
  const { bid, ask, midpoint } = contract.lastQuote;
  if (Number.isFinite(midpoint) && midpoint > 0) {
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) {
      const tol = 1e-9 * Math.max(1, midpoint);
      if (midpoint >= bid - tol && midpoint <= ask + tol) {
        return midpoint;
      }
    } else {
      return midpoint;
    }
  }
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
    return 0.5 * (bid + ask);
  }
  return Number.NaN;
}

function interpolateLiveRate(
  treasuryObs: TreasuryYieldObservation,
  sofrRate: number,
  tenorYears: number,
): number {
  const allowMissing = treasuryObs.finiteTenors < TREASURY_TENORS.length;
  return interpolateTreasuryYield(treasuryObs, tenorYears, {
    allowMissingTenors: allowMissing,
    ...(Number.isFinite(sofrRate) ? { overnightRate: sofrRate } : {}),
    method: 'linear',
    extrapolation: 'clamp',
  });
}

function groupContractsByExpiry(
  contracts: readonly OptionSnapshotContract[],
  nowSec: number,
): Map<number, OptionSnapshotContract[]> {
  const byExpiry = new Map<number, OptionSnapshotContract[]>();
  for (const contract of contracts) {
    if (contract.expirationTime <= nowSec + 60) {
      continue;
    }
    const existing = byExpiry.get(contract.expirationTime);
    if (existing !== undefined) {
      existing.push(contract);
    } else {
      byExpiry.set(contract.expirationTime, [contract]);
    }
  }
  return byExpiry;
}

function buildParityPairsForExpiry(
  expiryContracts: readonly OptionSnapshotContract[],
): ParityOptionPair[] {
  interface PairAccum {
    call?: OptionSnapshotContract;
    put?: OptionSnapshotContract;
  }
  const byStrike = new Map<number, PairAccum>();
  for (const c of expiryContracts) {
    let slot = byStrike.get(c.strikePrice);
    if (slot === undefined) {
      slot = {};
      byStrike.set(c.strikePrice, slot);
    }
    if (c.contractType === 'call' && slot.call === undefined) {
      slot.call = c;
    } else if (c.contractType === 'put' && slot.put === undefined) {
      slot.put = c;
    }
  }

  const pairs: ParityOptionPair[] = [];
  for (const [strike, slot] of byStrike.entries()) {
    if (slot.call === undefined || slot.put === undefined) {
      continue;
    }
    const callMid = resolveQuoteMid(slot.call);
    const putMid = resolveQuoteMid(slot.put);
    if (!Number.isFinite(callMid) || !Number.isFinite(putMid)) {
      continue;
    }
    const callBid = slot.call.lastQuote.bid;
    const callAsk = slot.call.lastQuote.ask;
    const putBid = slot.put.lastQuote.bid;
    const putAsk = slot.put.lastQuote.ask;
    const callOi = slot.call.openInterest;
    const putOi = slot.put.openInterest;
    const liqWeight =
      Number.isFinite(callOi) &&
      Number.isFinite(putOi) &&
      callOi > 0 &&
      putOi > 0
        ? Math.min(callOi, putOi)
        : 1;

    pairs.push({
      strike,
      callMid,
      putMid,
      ...(Number.isFinite(callBid) ? { callBid } : {}),
      ...(Number.isFinite(callAsk) ? { callAsk } : {}),
      ...(Number.isFinite(putBid) ? { putBid } : {}),
      ...(Number.isFinite(putAsk) ? { putAsk } : {}),
      liquidityWeight: liqWeight,
    });
  }
  return pairs;
}

function evaluateParityForExpiry(
  expirySec: number,
  expiryContracts: readonly OptionSnapshotContract[],
  nowSec: number,
  spot: number,
  treasuryObs: TreasuryYieldObservation,
  sofrRate: number,
): ExpiryParityEvaluation | null {
  const first = expiryContracts[0];
  if (first === undefined) {
    return null;
  }
  const timeToExpiry = timeToExpiryYears(nowSec, expirySec);
  if (!Number.isFinite(timeToExpiry) || timeToExpiry <= 0) {
    return null;
  }
  const rate = interpolateLiveRate(treasuryObs, sofrRate, timeToExpiry);
  if (!Number.isFinite(rate)) {
    return null;
  }

  const discountFactor = Math.exp(-rate * timeToExpiry);
  const pairs = buildParityPairsForExpiry(expiryContracts);
  if (pairs.length === 0) {
    return null;
  }

  const parity = inferForwardFromParityDetailed(pairs, discountFactor, {
    method: 'median',
    nearAtmCount: 5,
    maxRelativeSpread: 0.35,
    requirePositiveBid: true,
    minValidPairs: 3,
  });
  if (!Number.isFinite(parity.forward) || parity.forward <= 0) {
    return null;
  }

  const dividendYield = impliedDividendYieldFromForward({
    spot,
    forward: parity.forward,
    timeToExpiry,
    rate,
  });
  if (!Number.isFinite(dividendYield)) {
    return null;
  }

  return {
    expirySec,
    expirationDate: first.expirationDate,
    timeToExpiry,
    rate,
    forward: parity.forward,
    dividendYield,
    validPairsCount: parity.validPairsCount,
    usedPairsCount: parity.usedPairsCount,
  };
}

function solveContractOwnIv(
  contract: OptionSnapshotContract,
  spot: number,
  timeToExpiry: number,
  rate: number,
  dividendYield: number,
  isIndex: boolean,
): number {
  const mid = resolveQuoteMid(contract);
  const bid = contract.lastQuote.bid;
  const ask = contract.lastQuote.ask;
  if (
    !Number.isFinite(mid) ||
    mid <= 0 ||
    !Number.isFinite(bid) ||
    bid <= 0 ||
    !Number.isFinite(ask) ||
    ask < bid
  ) {
    return Number.NaN;
  }
  const spreadRatio = (ask - bid) / mid;
  if (!Number.isFinite(spreadRatio) || spreadRatio > 0.5) {
    return Number.NaN;
  }

  return isIndex
    ? solveImpliedVolBsm({
        spot,
        strike: contract.strikePrice,
        timeToExpiry,
        rate,
        dividendYield,
        contractType: contract.contractType,
        price: mid,
      })
    : solveImpliedVolAmerican({
        spot,
        strike: contract.strikePrice,
        timeToExpiry,
        rate,
        dividendYield,
        contractType: contract.contractType,
        marketPrice: mid,
      });
}

function selectFirstLiquidVolSlice(
  contracts: readonly OptionSnapshotContract[],
  nowSec: number,
  spot: number,
  treasuryObs: TreasuryYieldObservation,
  sofrRate: number,
  isIndex: boolean,
): LiquidSliceSelection {
  const byExpiry = groupContractsByExpiry(contracts, nowSec);
  const sortedExpiries = [...byExpiry.keys()].sort((a, b) => a - b);

  for (const expirySec of sortedExpiries) {
    const expiryContracts = byExpiry.get(expirySec);
    if (expiryContracts === undefined) {
      continue;
    }

    const parity = evaluateParityForExpiry(
      expirySec,
      expiryContracts,
      nowSec,
      spot,
      treasuryObs,
      sofrRate,
    );
    if (parity === null) {
      continue;
    }

    let ownIvSolvedCount = 0;
    let maxIvDiffVsProvider = 0;
    const quotes: VolQuoteInput[] = [];

    for (const c of expiryContracts) {
      const bid = c.lastQuote.bid;
      const ask = c.lastQuote.ask;
      const mid = resolveQuoteMid(c);
      if (
        !Number.isFinite(bid) ||
        bid <= 0 ||
        !Number.isFinite(ask) ||
        ask < bid ||
        !Number.isFinite(mid)
      ) {
        continue;
      }

      const ownIv = solveContractOwnIv(
        c,
        spot,
        parity.timeToExpiry,
        parity.rate,
        parity.dividendYield,
        isIndex,
      );
      if (Number.isFinite(ownIv) && ownIv > 0) {
        ownIvSolvedCount += 1;
        if (Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0) {
          maxIvDiffVsProvider = Math.max(
            maxIvDiffVsProvider,
            Math.abs(ownIv - c.impliedVolatility),
          );
        }
      }

      quotes.push({
        strike: c.strikePrice,
        contractType: c.contractType,
        iv: ownIv,
        bid,
        ask,
        mid,
        openInterest: Number.isFinite(c.openInterest) ? c.openInterest : 0,
      });
    }

    const slice = buildVolSlice(
      {
        timeToExpiry: parity.timeToExpiry,
        expirySec,
        forward: parity.forward,
        spot,
        rate: parity.rate,
        dividendYield: parity.dividendYield,
        quotes,
      },
      {
        requirePositiveBid: true,
        maxSpreadRatio: 0.35,
        minOpenInterest: 1,
        minPoints: 6,
        quoteSelection: 'otm',
      },
    );

    if (!slice.isValid) {
      continue;
    }

    const metrics = computeSliceVolMetrics(slice, {
      spot,
      rate: parity.rate,
      dividendYield: parity.dividendYield,
      deltaConvention: 'spotBsm',
    });

    if (
      !Number.isFinite(metrics.ivAtm) ||
      !Number.isFinite(metrics.delta25PutIv) ||
      !Number.isFinite(metrics.delta25CallIv)
    ) {
      continue;
    }

    const butterfly = validateSliceButterflyArbitrage(slice);
    return {
      parity,
      slice,
      metrics,
      butterflyViolationCount: butterfly.violations.length,
      butterflyMinDensity: butterfly.minDensity,
      ownIvSolvedCount,
      maxIvDiffVsProvider,
    };
  }

  throw new Error(
    `No liquid expiry with valid put-call parity + 25-delta PCHIP smile found (isIndex=${String(isIndex)})`,
  );
}

function runExposureOnChain(params: {
  readonly underlying: 'SPY' | 'I:SPX';
  readonly isIndex: boolean;
  readonly contracts: readonly OptionSnapshotContract[];
  readonly spot: number;
  readonly nowSec: number;
  readonly treasuryObs: TreasuryYieldObservation;
  readonly sofrRate: number;
  readonly liquidSelection: LiquidSliceSelection;
}): ExposureRunSummary {
  const {
    underlying,
    isIndex,
    contracts,
    spot,
    nowSec,
    treasuryObs,
    sofrRate,
    liquidSelection,
  } = params;

  const byExpiry = groupContractsByExpiry(contracts, nowSec);
  const expiryParityMap = new Map<number, ExpiryParityEvaluation>();
  for (const [expSec, expContracts] of byExpiry.entries()) {
    const ev = evaluateParityForExpiry(
      expSec,
      expContracts,
      nowSec,
      spot,
      treasuryObs,
      sofrRate,
    );
    if (ev !== null) {
      expiryParityMap.set(expSec, ev);
    }
  }

  let ownSolvedIvContracts = 0;
  let providerFallbackIvContracts = 0;

  const exposureInputs: ExposureContractInput[] = [];
  for (const c of contracts) {
    const expParity = expiryParityMap.get(c.expirationTime);
    const tExp = timeToExpiryYears(nowSec, c.expirationTime);
    const rateExp =
      expParity !== undefined
        ? expParity.rate
        : Number.isFinite(tExp) && tExp > 0
          ? interpolateLiveRate(treasuryObs, sofrRate, tExp)
          : liquidSelection.parity.rate;
    const divExp =
      expParity !== undefined
        ? expParity.dividendYield
        : liquidSelection.parity.dividendYield;

    const mid = resolveQuoteMid(c);
    const bid = c.lastQuote.bid;
    const ask = c.lastQuote.ask;

    const ownIv =
      Number.isFinite(tExp) && tExp > 0 && Number.isFinite(rateExp) && Number.isFinite(divExp)
        ? solveContractOwnIv(c, spot, tExp, rateExp, divExp, isIndex)
        : Number.NaN;

    let ivToUse = Number.NaN;
    if (Number.isFinite(ownIv) && ownIv > 0) {
      ivToUse = ownIv;
      ownSolvedIvContracts += 1;
    } else if (Number.isFinite(c.impliedVolatility) && c.impliedVolatility > 0) {
      ivToUse = c.impliedVolatility;
      providerFallbackIvContracts += 1;
    }

    exposureInputs.push({
      contractType: c.contractType,
      strike: c.strikePrice,
      expiryUtcSec: c.expirationTime,
      openInterest: c.openInterest,
      ...(Number.isFinite(c.day.volume) && c.day.volume >= 0
        ? { volume: c.day.volume }
        : {}),
      sharesPerContract: c.sharesPerContract,
      spot,
      ...(expParity !== undefined ? { forward: expParity.forward } : {}),
      ...(Number.isFinite(rateExp) ? { rate: rateExp } : {}),
      ...(Number.isFinite(divExp) ? { dividendYield: divExp } : {}),
      ...(Number.isFinite(ivToUse) && ivToUse > 0 ? { iv: ivToUse } : {}),
      ...(Number.isFinite(mid) && mid > 0 ? { midPrice: mid } : {}),
      ...(Number.isFinite(bid) && bid >= 0 ? { bid } : {}),
      ...(Number.isFinite(ask) && ask > 0 ? { ask } : {}),
    });
  }

  const exposure = computeDealerExposure(
    exposureInputs,
    {
      spot,
      nowUtcSec: nowSec,
      rate: liquidSelection.parity.rate,
      dividendYield: liquidSelection.parity.dividendYield,
      forward: liquidSelection.parity.forward,
    },
    {
      model: isIndex ? 'bsm' : 'american',
      wallCriterion: 'gex',
      wallScope: 'all',
      gammaFlipHalfWidth: 0.15,
      gammaFlipGridSteps: 80,
      gammaFlipMultiRootPolicy: 'nearestSpot',
      ivResolutionMode: 'ivThenMidPrice',
      expectedMoveExpirySec: liquidSelection.parity.expirySec,
      expectedMoveIvAtmOverride: liquidSelection.metrics.ivAtm,
    },
  );

  return {
    underlying,
    exposure,
    ownSolvedIvContracts,
    providerFallbackIvContracts,
    parityDividendExpiries: expiryParityMap.size,
  };
}

function summarizeLatencies(samples: readonly number[]): {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly maxMs: number;
} {
  if (samples.length === 0) {
    return {
      count: 0,
      minMs: Number.NaN,
      p50Ms: Number.NaN,
      maxMs: Number.NaN,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const minMs = sorted[0] ?? Number.NaN;
  const maxMs = sorted[sorted.length - 1] ?? Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  const p50Ms = sorted[mid] ?? Number.NaN;
  return {
    count: sorted.length,
    minMs,
    p50Ms,
    maxMs,
  };
}

function selectAtmLiquidContracts(
  contracts: readonly OptionSnapshotContract[],
  spot: number,
  nowSec: number,
  limit: number,
): readonly OptionSnapshotContract[] {
  const candidates = contracts.filter(
    (c) =>
      c.expirationTime > nowSec + 60 &&
      Math.abs(c.strikePrice - spot) / spot <= 0.04,
  );

  const sortedExpiries = [
    ...new Set(candidates.map((c) => c.expirationTime)),
  ].sort((a, b) => a - b);
  const nearExpiries = new Set(sortedExpiries.slice(0, 2));

  const ranked = candidates
    .filter((c) => nearExpiries.has(c.expirationTime))
    .sort((a, b) => {
      const volA = Number.isFinite(a.day.volume) ? a.day.volume : 0;
      const volB = Number.isFinite(b.day.volume) ? b.day.volume : 0;
      const oiA = Number.isFinite(a.openInterest) ? a.openInterest : 0;
      const oiB = Number.isFinite(b.openInterest) ? b.openInterest : 0;
      const scoreA = volA * 10 + oiA;
      const scoreB = volB * 10 + oiB;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return Math.abs(a.strikePrice - spot) - Math.abs(b.strikePrice - spot);
    });

  return ranked.slice(0, limit);
}

function computeStockClosedInputs(bars: readonly Bar[]): LiveProjectionInputs {
  const closes = bars.map((b) => b.close);
  const ema21 = calculateEma(closes, 21);
  const lastClosedEma = ema21[ema21.length - 1] ?? Number.NaN;
  const sessionVwap = computeSessionVwap(bars, {
    market: 'EQUITY',
    barSeconds: 60,
  });
  const avwap = computeAnchoredVwap(bars, 'SESSION', {
    market: 'EQUITY',
  });

  return {
    ema: {
      lastClosedEma,
      period: 21,
    },
    sessionVwap: {
      closedState: sessionVwap.state,
      options: { market: 'EQUITY', barSeconds: 60 },
    },
    avwap: {
      closedState: avwap.state,
    },
  };
}

function analyzeUnusualBatch(
  label: string,
  trades: readonly UnusualTradeRecord[],
  received?: number,
  filteredOut?: number,
): string {
  const rootCounts = new Map<string, number>();
  let maxTrade: UnusualTradeRecord | null = null;
  let invalidTimestampCount = 0;

  for (const t of trades) {
    rootCounts.set(t.root, (rootCounts.get(t.root) ?? 0) + 1);
    if (
      !Number.isInteger(t.time) ||
      t.time <= 1_000_000_000 ||
      t.subsecond.nanoseconds < 0 ||
      t.subsecond.nanoseconds >= 1_000_000_000 ||
      BigInt(t.subsecond.timestampNs) !==
        BigInt(t.time) * 1_000_000_000n + BigInt(t.subsecond.nanoseconds)
    ) {
      invalidTimestampCount += 1;
    }
    if (
      Number.isFinite(t.notional) &&
      (maxTrade === null || t.notional > maxTrade.notional)
    ) {
      maxTrade = t;
    }
  }

  expect(invalidTimestampCount).toBe(0);

  const rootsSummary = [...rootCounts.entries()]
    .map(([r, cnt]) => `${r}:${String(cnt)}`)
    .join(', ');
  const topLine =
    maxTrade !== null
      ? `${maxTrade.ticker} (root=${maxTrade.root}, t=${String(maxTrade.time)}, ns=${maxTrade.subsecond.timestampNs}, px=${fmtNum(maxTrade.price, 2)}, sz=${String(maxTrade.size)}, notional=${fmtUsd(maxTrade.notional, 0)}, flags=[${maxTrade.flags.raw.join(',')}])`
      : 'sin nocional finito';
  const recvText =
    received !== undefined && filteredOut !== undefined
      ? `received=${String(received)} accepted=${String(trades.length)} filteredOut=${String(filteredOut)}`
      : `accepted=${String(trades.length)}`;

  return `  ${label}: ${recvText} roots=[${rootsSummary || 'none'}] top=${topLine}`;
}

describe.runIf(process.env['RUN_LIVE_SMOKE'] === '1')(
  'Live Pipeline End-to-End Smoke Verification (Piezas 1-8)',
  () => {
    it(
      'executes all 5 stages read-only against Massive without leaking secrets',
      async () => {
        const auth = resolveMassiveAuth();
        expect(
          auth.apiKey,
          'MASSIVE_API_KEY (o alias en .env / entorno) debe estar configurada',
        ).not.toBe('');

        const { apiKey, secrets } = auth;
        const callMetrics: HttpCallMetric[] = [];
        const fetchFn = createLiveFetch(secrets, callMetrics);
        const nowSec = Math.floor(Date.now() / 1_000);
        const logLines: string[] = [];
        const emit = (line: string): void => {
          const safeLine = redactSecrets(line, secrets);
          logLines.push(safeLine);
          console.log(safeLine);
        };

        // ===================================================================
        // ETAPA 1: Macro & Unified Snapshot (Pieza 4)
        // ===================================================================
        const macroDateGte = addCalendarDaysEt(nowSec, -35);
        const [treasuryRes, fundingRes, unifiedRes] = await Promise.all([
          loadTreasuryYields({
            apiKey,
            fetchFn,
            dateGte: macroDateGte,
            limit: 100,
            maxPages: 1,
          }),
          loadFundingConditions({
            apiKey,
            fetchFn,
            dateGte: macroDateGte,
            limit: 100,
            maxPages: 1,
          }),
          loadUnifiedSnapshot({
            apiKey,
            fetchFn,
            tickers: UNIFIED_TICKERS,
            limit: 250,
            maxPages: 1,
          }),
        ]);

        expect(treasuryRes.report.providerError).toBeNull();
        expect(treasuryRes.observations.length).toBeGreaterThan(0);
        expect(fundingRes.report.providerError).toBeNull();
        expect(fundingRes.observations.length).toBeGreaterThan(0);
        expect(unifiedRes.report.providerError).toBeNull();

        const latestTreasury =
          [...treasuryRes.observations]
            .reverse()
            .find((obs) => obs.finiteTenors === TREASURY_TENORS.length) ??
          treasuryRes.observations[treasuryRes.observations.length - 1];
        if (latestTreasury === undefined) {
          throw new Error('No Treasury yield observations returned');
        }

        const latestFunding = [...fundingRes.observations]
          .reverse()
          .find((obs) => Number.isFinite(obs.sofr));
        const sofrRate = latestFunding?.sofr ?? Number.NaN;

        const r7d = interpolateLiveRate(latestTreasury, sofrRate, 7 / 365);
        const r30d = interpolateLiveRate(latestTreasury, sofrRate, 30 / 365);
        expect(Number.isFinite(r30d)).toBe(true);

        const stockByTicker = new Map(
          unifiedRes.stocks.map((s) => [s.ticker, s]),
        );
        const indexByTicker = new Map(
          unifiedRes.indices.map((idx) => [idx.ticker, idx]),
        );

        const unifiedSpySpot = resolveUnifiedStockPrice(stockByTicker.get('SPY'));
        const unifiedQqqSpot = resolveUnifiedStockPrice(stockByTicker.get('QQQ'));
        const unifiedSpxSpot = resolveUnifiedIndexLevel(indexByTicker.get('I:SPX'));
        const unifiedVixLevel = resolveUnifiedIndexLevel(indexByTicker.get('I:VIX'));
        const unifiedSkewLevel = resolveUnifiedIndexLevel(indexByTicker.get('I:SKEW'));
        const unifiedNdxLevel = resolveUnifiedIndexLevel(indexByTicker.get('I:NDX'));

        expect(Number.isFinite(unifiedSpySpot) && unifiedSpySpot > 0).toBe(true);
        expect(Number.isFinite(unifiedSpxSpot) && unifiedSpxSpot > 0).toBe(true);

        emit('=== ETAPA 1: Macro & Unified Snapshot (Pieza 4) ===');
        emit(
          `  Treasury (${latestTreasury.date}, finiteTenors=${String(latestTreasury.finiteTenors)}/11): 1M=${fmtPct(latestTreasury.yield1Month)} 3M=${fmtPct(latestTreasury.yield3Month)} 1Y=${fmtPct(latestTreasury.yield1Year)} 10Y=${fmtPct(latestTreasury.yield10Year)}`,
        );
        emit(
          `  SOFR (${latestFunding?.date ?? 'n/a'}): ${fmtPct(sofrRate)} | Interp r(7d)=${fmtPct(r7d)} r(30d)=${fmtPct(r30d)}`,
        );
        emit(
          `  Stocks: SPY=${fmtNum(unifiedSpySpot, 2)} (${stockByTicker.get('SPY')?.marketStatus ?? 'unknown'}), QQQ=${fmtNum(unifiedQqqSpot, 2)} (${stockByTicker.get('QQQ')?.marketStatus ?? 'unknown'})`,
        );
        emit(
          `  Indices: I:SPX=${fmtNum(unifiedSpxSpot, 2)} (${indexByTicker.get('I:SPX')?.marketStatus ?? 'unknown'}), I:VIX=${fmtNum(unifiedVixLevel, 2)}, I:SKEW=${fmtNum(unifiedSkewLevel, 2)}, I:NDX=${fmtNum(unifiedNdxLevel, 2)}`,
        );
        emit(
          `  TickerErrors (${String(unifiedRes.tickerErrors.length)}): ${
            unifiedRes.tickerErrors.length === 0
              ? 'ninguno'
              : unifiedRes.tickerErrors
                  .map((e) => `${e.ticker}:${e.error}`)
                  .join(', ')
          }`,
        );

        // ===================================================================
        // ETAPA 2: Contratos y Cadenas de Opciones (Pieza 1)
        // ===================================================================
        const spyMinStrike = Math.floor(unifiedSpySpot * 0.85 * 100) / 100;
        const spyMaxStrike = Math.ceil(unifiedSpySpot * 1.15 * 100) / 100;
        const spxMinStrike = Math.floor(unifiedSpxSpot * 0.85);
        const spxMaxStrike = Math.ceil(unifiedSpxSpot * 1.15);

        const [spyContractsRes, spxContractsRes] = await Promise.all([
          loadOptionContracts({
            underlying: 'SPY',
            isIndex: false,
            apiKey,
            fetchFn,
            minDte: 0,
            maxDte: 30,
            now: nowSec,
            minStrike: spyMinStrike,
            maxStrike: spyMaxStrike,
            excludeBinary: false,
            excludeAdjusted: false,
            limit: 1_000,
            maxPages: 30,
          }),
          loadOptionContracts({
            underlying: 'I:SPX',
            isIndex: true,
            apiKey,
            fetchFn,
            minDte: 0,
            maxDte: 30,
            now: nowSec,
            minStrike: spxMinStrike,
            maxStrike: spxMaxStrike,
            excludeBinary: false,
            excludeAdjusted: false,
            limit: 1_000,
            maxPages: 50,
          }),
        ]);

        expect(spyContractsRes.report.providerError).toBeNull();
        expect(spyContractsRes.report.referenceUnderlyingTicker).toBe('SPY');
        expect(spyContractsRes.contracts.length).toBeGreaterThan(0);

        expect(spxContractsRes.report.providerError).toBeNull();
        expect(spxContractsRes.report.referenceUnderlyingTicker).toBe('SPX');
        expect(spxContractsRes.contracts.length).toBeGreaterThan(0);

        const [spyChainRes, spxChainRes] = await Promise.all([
          loadOptionChain({
            underlying: 'SPY',
            isIndex: false,
            apiKey,
            fetchFn,
            minDte: 0,
            maxDte: 30,
            now: nowSec,
            minStrike: spyMinStrike,
            maxStrike: spyMaxStrike,
            excludeBinary: true,
            excludeAdjusted: true,
            referenceContracts: spyContractsRes.contracts,
            snapshotLimit: 250,
            maxPages: 60,
          }),
          loadOptionChain({
            underlying: 'SPX',
            isIndex: true,
            apiKey,
            fetchFn,
            minDte: 0,
            maxDte: 30,
            now: nowSec,
            minStrike: spxMinStrike,
            maxStrike: spxMaxStrike,
            excludeBinary: true,
            excludeAdjusted: true,
            referenceContracts: spxContractsRes.contracts,
            snapshotLimit: 250,
            maxPages: 120,
          }),
        ]);

        expect(spyChainRes.report.providerError).toBeNull();
        expect(spyChainRes.report.snapshotUnderlyingAsset).toBe('SPY');
        expect(spyChainRes.contracts.length).toBeGreaterThan(0);

        expect(spxChainRes.report.providerError).toBeNull();
        expect(spxChainRes.report.snapshotUnderlyingAsset).toBe('I:SPX');
        expect(spxChainRes.contracts.length).toBeGreaterThan(0);

        const spySpot = resolveChainSpot(spyChainRes.underlying, unifiedSpySpot);
        const spxSpot = resolveChainSpot(spxChainRes.underlying, unifiedSpxSpot);

        emit('=== ETAPA 2: Contratos y Cadenas de Opciones (Pieza 1) ===');
        emit(
          `  Ref Contracts SPY (ticker="${spyContractsRes.report.referenceUnderlyingTicker}"): received=${String(spyContractsRes.report.received)} accepted=${String(spyContractsRes.report.accepted)} binaryDetected=${String(spyContractsRes.report.binaryDetected)} adjustedDetected=${String(spyContractsRes.report.adjustedDetected)} pages=${String(spyContractsRes.report.pages)} stop=${spyContractsRes.report.stoppedReason}`,
        );
        emit(
          `  Ref Contracts SPX (input="I:SPX" -> query="${spxContractsRes.report.referenceUnderlyingTicker}"): received=${String(spxContractsRes.report.received)} accepted=${String(spxContractsRes.report.accepted)} binaryDetected=${String(spxContractsRes.report.binaryDetected)} adjustedDetected=${String(spxContractsRes.report.adjustedDetected)} pages=${String(spxContractsRes.report.pages)} stop=${spxContractsRes.report.stoppedReason}`,
        );
        emit(
          `  Chain SPY (${spyChainRes.report.snapshotUnderlyingAsset}, spot=${fmtNum(spySpot, 2)}): received=${String(spyChainRes.report.received)} accepted=${String(spyChainRes.report.accepted)} discarded=${String(spyChainRes.report.discarded)} (binExcl=${String(spyChainRes.report.binaryExcluded)} adjExcl=${String(spyChainRes.report.adjustedExcluded)} filterExcl=${String(spyChainRes.report.filterExcluded)}) emptyGreeks=${String(spyChainRes.report.emptyGreeks)} ivMissing=${String(spyChainRes.report.ivMissing)} pages=${String(spyChainRes.report.snapshotPages)} stop=${spyChainRes.report.stoppedReason}`,
        );
        emit(
          `  Chain I:SPX (${spxChainRes.report.snapshotUnderlyingAsset}, spot=${fmtNum(spxSpot, 2)}): received=${String(spxChainRes.report.received)} accepted=${String(spxChainRes.report.accepted)} discarded=${String(spxChainRes.report.discarded)} (binExcl=${String(spxChainRes.report.binaryExcluded)} adjExcl=${String(spxChainRes.report.adjustedExcluded)} filterExcl=${String(spxChainRes.report.filterExcluded)}) emptyGreeks=${String(spxChainRes.report.emptyGreeks)} ivMissing=${String(spxChainRes.report.ivMissing)} pages=${String(spxChainRes.report.snapshotPages)} stop=${spxChainRes.report.stoppedReason}`,
        );

        // ===================================================================
        // ETAPA 3: Valuación Propia, Superficie PCHIP y Exposición (Piezas 2,3,5,6)
        // ===================================================================
        const spySliceSel = selectFirstLiquidVolSlice(
          spyChainRes.contracts,
          nowSec,
          spySpot,
          latestTreasury,
          sofrRate,
          false,
        );
        const spxSliceSel = selectFirstLiquidVolSlice(
          spxChainRes.contracts,
          nowSec,
          spxSpot,
          latestTreasury,
          sofrRate,
          true,
        );

        expect(spySliceSel.slice.isValid).toBe(true);
        expect(Number.isFinite(spySliceSel.metrics.ivAtm)).toBe(true);
        expect(spxSliceSel.slice.isValid).toBe(true);
        expect(Number.isFinite(spxSliceSel.metrics.ivAtm)).toBe(true);

        const spyExposureRun = runExposureOnChain({
          underlying: 'SPY',
          isIndex: false,
          contracts: spyChainRes.contracts,
          spot: spySpot,
          nowSec,
          treasuryObs: latestTreasury,
          sofrRate,
          liquidSelection: spySliceSel,
        });
        const spxExposureRun = runExposureOnChain({
          underlying: 'I:SPX',
          isIndex: true,
          contracts: spxChainRes.contracts,
          spot: spxSpot,
          nowSec,
          treasuryObs: latestTreasury,
          sofrRate,
          liquidSelection: spxSliceSel,
        });

        expect(Number.isFinite(spyExposureRun.exposure.netGex)).toBe(true);
        expect(Number.isFinite(spyExposureRun.exposure.callWallStrike)).toBe(true);
        expect(Number.isFinite(spyExposureRun.exposure.putWallStrike)).toBe(true);

        expect(Number.isFinite(spxExposureRun.exposure.netGex)).toBe(true);
        expect(Number.isFinite(spxExposureRun.exposure.callWallStrike)).toBe(true);
        expect(Number.isFinite(spxExposureRun.exposure.putWallStrike)).toBe(true);

        emit('=== ETAPA 3: Paridad, Superficie PCHIP y Exposición (Piezas 2, 3, 5 y 6) ===');
        for (const [label, spotVal, sel, expRun] of [
          ['SPY (American Bjerksund-Stensland 2002)', spySpot, spySliceSel, spyExposureRun],
          ['I:SPX (European BSM)', spxSpot, spxSliceSel, spxExposureRun],
        ] as const) {
          const { parity, slice, metrics } = sel;
          const e = expRun.exposure;
          emit(
            `  [${label}] expiry=${parity.expirationDate} T=${fmtNum(parity.timeToExpiry * 365, 2)}d | S=${fmtNum(spotVal, 2)} F=${fmtNum(parity.forward, 2)} r=${fmtPct(parity.rate)} q_imp=${fmtPct(parity.dividendYield)} (pairs=${String(parity.usedPairsCount)}/${String(parity.validPairsCount)})`,
          );
          emit(
            `    VolSlice: nodes=${String(slice.nodes.length)} ownIV=${String(sel.ownIvSolvedCount)} max|own-prov|=${fmtPct(sel.maxIvDiffVsProvider, 3)} | ivAtm=${fmtPct(metrics.ivAtm)} 25dPut=${fmtPct(metrics.delta25PutIv)} 25dCall=${fmtPct(metrics.delta25CallIv)} RR25=${fmtPct(metrics.riskReversal25)} BF25=${fmtPct(metrics.butterfly25)} | butterflyFree=${String(metrics.isButterflyArbitrageFree)} (violations=${String(sel.butterflyViolationCount)}, minDens=${fmtNum(sel.butterflyMinDensity, 4)})`,
          );
          emit(
            `    Exposures: DollarGEX=${fmtUsd(e.netGex)} | SpotShareGamma=${fmtUsd(e.netSpotGamma)} | DEX=${fmtUsd(e.netDex)} | Vanna=${fmtUsd(e.netVannaExposure)} | Charm=${fmtUsd(e.netCharmExposure)}`,
          );
          emit(
            `    Levels: CallWall=${fmtNum(e.callWallStrike, 2)} PutWall=${fmtNum(e.putWallStrike, 2)} GammaFlip=${fmtNum(e.gammaFlipSpot, 2)} (status=${e.gammaFlipStatus}, roots=${String(e.gammaFlipCandidates.length)})`,
          );
          emit(
            `    ExpectedMove (${parity.expirationDate}): Formula=${fmtUsd(e.expectedMove.formulaMove, 2)} (${fmtPct(e.expectedMove.formulaMovePct)}) | ATM Straddle (K=${fmtNum(e.expectedMove.straddleStrike, 2)}): ${fmtUsd(e.expectedMove.straddleMove, 2)} (${fmtPct(e.expectedMove.straddleMovePct)})`,
          );
          emit(
            `    Quality: active=${String(e.quality.activeContracts)} usable=${String(e.quality.usableContracts)} ownIV=${String(expRun.ownSolvedIvContracts)} provFallbackIV=${String(expRun.providerFallbackIvContracts)} skipped=${String(e.quality.skippedContracts)} skippedOiShare=${fmtPct(e.quality.skippedOiShare, 3)} parityExpiries=${String(expRun.parityDividendExpiries)}`,
          );
        }

        // ===================================================================
        // ETAPA 4: Unusual Options Activity (Pieza 8)
        // ===================================================================
        const sharesMap = new Map<string, number>();
        const addRefContracts = (contracts: readonly OptionContract[]): void => {
          for (const rc of contracts) {
            if (!rc.isAdjusted && !rc.isBinary && Number.isFinite(rc.sharesPerContract)) {
              sharesMap.set(rc.ticker, rc.sharesPerContract);
            }
          }
        };
        addRefContracts(spyContractsRes.contracts);
        addRefContracts(spxContractsRes.contracts);

        const spyUnusualRes = await loadUnusualTrades({
          apiKey,
          fetchFn,
          underlyingTicker: 'SPY',
          limit: 25,
          maxPages: 1,
          sharesPerContractByTicker: sharesMap,
          defaultSharesPerContract: 100,
        });

        const spxUnusualRes = await loadUnusualTrades({
          apiKey,
          fetchFn,
          underlyingTicker: 'SPX',
          limit: 25,
          maxPages: 1,
          sharesPerContractByTicker: sharesMap,
          defaultSharesPerContract: 100,
        });

        expect(spyUnusualRes.report.providerError).toBeNull();
        expect(spxUnusualRes.report.providerError).toBeNull();
        expect(spyUnusualRes.trades.length).toBeGreaterThan(0);
        expect(spxUnusualRes.trades.length).toBeGreaterThan(0);

        emit('=== ETAPA 4: Unusual Options Activity (Pieza 8) ===');
        emit(
          analyzeUnusualBatch(
            'SPY (limit=25)',
            spyUnusualRes.trades,
            spyUnusualRes.report.received,
            spyUnusualRes.report.filteredOut,
          ),
        );
        emit(
          analyzeUnusualBatch(
            'SPX (limit=25)',
            spxUnusualRes.trades,
            spxUnusualRes.report.received,
            spxUnusualRes.report.filteredOut,
          ),
        );

        // ===================================================================
        // ETAPA 5: WebSocket Streaming & Barra en Formación (Pieza 7)
        // ===================================================================
        emit('=== ETAPA 5: WebSocket Streaming (Pieza 7) ===');

        // --- 5A: /options (12 s) ---
        const wsOptContracts = selectAtmLiquidContracts(
          spyChainRes.contracts,
          spySpot,
          nowSec,
          20,
        );
        expect(wsOptContracts.length).toBeGreaterThan(0);
        expect(wsOptContracts.length).toBeLessThanOrEqual(20);

        const optChannels: string[] = [];
        for (const c of wsOptContracts) {
          optChannels.push(`T.${c.ticker}`, `Q.${c.ticker}`);
        }
        const primaryOptSymbol = wsOptContracts[0]?.ticker ?? '';
        let optLiveState: LiveBarState = createLiveBarState([], 60);
        let optTradeCount = 0;
        let optQuoteCount = 0;
        let optStatusCount = 0;
        const optTradeLatencies: number[] = [];
        const optQuoteLatencies: number[] = [];
        const optErrors: WsClientError[] = [];

        const optClient = new MassiveWsClient({
          apiKey,
          cluster: 'options',
          initialSubscriptions: optChannels,
          autoReconnect: false,
          onEvents: (events: readonly WsNormalizedEvent[]) => {
            const recvMs = Date.now();
            for (const ev of events) {
              if (ev.ev === 'T') {
                optTradeCount += 1;
                optTradeLatencies.push(recvMs - ev.eventTimeMs);
              } else if (ev.ev === 'Q') {
                optQuoteCount += 1;
                optQuoteLatencies.push(recvMs - ev.eventTimeMs);
              } else if (ev.ev === 'status') {
                optStatusCount += 1;
              }
            }
            optLiveState = ingestWsEvents(optLiveState, events, {
              symbol: primaryOptSymbol,
              maxClosedBars: 60,
            });
          },
          onError: (err) => {
            optErrors.push(err);
          },
        });

        await optClient.connect();
        expect(optClient.getSnapshot().activeQuoteSubscriptionCount).toBeLessThanOrEqual(20);
        const optStartMs = Date.now();
        await sleep(STAGE_5A_DURATION_MS);
        const optElapsedMs = Date.now() - optStartMs;
        optClient.close(1000, 'smoke_5a_done');
        await sleep(300);

        const optSnap = optClient.getSnapshot();
        expect(optSnap.state).toBe('closed');
        const optTLat = summarizeLatencies(optTradeLatencies);
        const optQLat = summarizeLatencies(optQuoteLatencies);

        emit(
          `  [5A /options] contratos=${String(wsOptContracts.length)} Q_subs=${String(optSnap.activeQuoteSubscriptionCount)} duration=${fmtNum(optElapsedMs / 1_000, 2)}s state=${optSnap.state} msgs=${String(optSnap.totalMessagesReceived)} T=${String(optTradeCount)} (p50=${fmtNum(optTLat.p50Ms, 0)}ms, max=${fmtNum(optTLat.maxMs, 0)}ms) Q=${String(optQuoteCount)} (p50=${fmtNum(optQLat.p50Ms, 0)}ms, max=${fmtNum(optQLat.maxMs, 0)}ms) status=${String(optStatusCount)} discards=${String(optLiveState.metrics.discardedEvents)} errors=${String(optErrors.length)}`,
        );

        // --- 5B: /stocks (20 s) ---
        const spyBarsRes = await loadBars({
          provider: 'massive',
          symbol: 'SPY',
          timeframe: '1m',
          visibleBars: 400,
          warmupBars: 100,
          rthOnly: true,
          maxPages: 3,
          apiKey,
          fetchFn,
        });
        expect(spyBarsRes.report.providerError).toBeNull();
        expect(spyBarsRes.bars.length).toBeGreaterThanOrEqual(21);

        let stockLiveState: LiveBarState = createLiveBarState(spyBarsRes.bars, 60);
        let closedInputs = computeStockClosedInputs(stockLiveState.closedBars);
        const stockRuntime: {
          latestProjection: LiveProjectionResult | null;
          maxConnDetectedAtMs: number | null;
          startMs: number;
        } = {
          latestProjection: null,
          maxConnDetectedAtMs: null,
          startMs: 0,
        };

        let stkTradeCount = 0;
        let stkSecBarCount = 0;
        let stkMinBarCount = 0;
        let stkStatusCount = 0;
        const stkTradeLatencies: number[] = [];
        const stkSecBarLatencies: number[] = [];
        const stkErrors: WsClientError[] = [];

        const stockClient = new MassiveWsClient({
          apiKey,
          cluster: 'stocks',
          initialSubscriptions: ['T.SPY', 'A.SPY', 'AM.SPY'],
          autoReconnect: false,
          onEvents: (events: readonly WsNormalizedEvent[]) => {
            const recvMs = Date.now();
            for (const ev of events) {
              if (ev.ev === 'T') {
                stkTradeCount += 1;
                stkTradeLatencies.push(recvMs - ev.eventTimeMs);
              } else if (ev.ev === 'A') {
                stkSecBarCount += 1;
                stkSecBarLatencies.push(recvMs - ev.endMs);
              } else if (ev.ev === 'AM') {
                stkMinBarCount += 1;
              } else if (ev.ev === 'status') {
                stkStatusCount += 1;
              }
            }

            const prevClosedLen = stockLiveState.closedBars.length;
            const prevLastClosedBar = stockLiveState.closedBars[prevClosedLen - 1];
            const prevRebroadcasts = stockLiveState.metrics.rebroadcastOverwrites;

            stockLiveState = ingestWsEvents(stockLiveState, events, {
              symbol: 'SPY',
              maxClosedBars: 600,
            });

            const currLastClosedBar =
              stockLiveState.closedBars[stockLiveState.closedBars.length - 1];
            const closedSeriesMutated =
              stockLiveState.closedBars.length !== prevClosedLen ||
              currLastClosedBar?.time !== prevLastClosedBar?.time ||
              currLastClosedBar?.close !== prevLastClosedBar?.close ||
              currLastClosedBar?.volume !== prevLastClosedBar?.volume ||
              stockLiveState.metrics.rebroadcastOverwrites !== prevRebroadcasts;

            if (closedSeriesMutated) {
              closedInputs = computeStockClosedInputs(stockLiveState.closedBars);
            }

            if (stockLiveState.formingBar !== null) {
              stockRuntime.latestProjection = projectLiveIndicators(
                stockLiveState,
                closedInputs,
              );
            }
          },
          onError: (err) => {
            stkErrors.push(err);
            if (err.code === 'max_connections' && stockRuntime.startMs > 0) {
              stockRuntime.maxConnDetectedAtMs = Date.now() - stockRuntime.startMs;
            }
          },
        });

        let stockConnectFailedReason: string | null = null;
        try {
          await stockClient.connect();
          stockRuntime.startMs = Date.now();
          while (Date.now() - stockRuntime.startMs < STAGE_5B_DURATION_MS) {
            const snapNow = stockClient.getSnapshot();
            if (snapNow.state === 'error' || snapNow.state === 'closed') {
              break;
            }
            await sleep(250);
          }
        } catch (err: unknown) {
          stockConnectFailedReason = redactSecrets(
            toErrorMessage(err, 'stock ws connect failed'),
            secrets,
          );
        }

        const stockElapsedMs =
          stockRuntime.startMs > 0 ? Date.now() - stockRuntime.startMs : 0;
        if (stockClient.getSnapshot().state !== 'closed') {
          stockClient.close(1000, 'smoke_5b_done');
          await sleep(250);
        }

        const stockSnap = stockClient.getSnapshot();
        const receivedMaxConnections =
          stockRuntime.maxConnDetectedAtMs !== null ||
          stkErrors.some((e) => e.code === 'max_connections');
        const stableFull20s =
          stockConnectFailedReason === null &&
          !receivedMaxConnections &&
          stockElapsedMs >= STAGE_5B_DURATION_MS;

        expect(
          stableFull20s || receivedMaxConnections,
          `5B debe completar 20s estables o reportar max_connections explícito (error=${stockConnectFailedReason ?? stockSnap.lastError?.message ?? 'none'})`,
        ).toBe(true);

        const stkTLat = summarizeLatencies(stkTradeLatencies);
        const stkALat = summarizeLatencies(stkSecBarLatencies);
        const formingDesc =
          stockLiveState.formingBar !== null
            ? `t=${String(stockLiveState.formingBar.time)} O=${fmtNum(stockLiveState.formingBar.open, 2)} H=${fmtNum(stockLiveState.formingBar.high, 2)} L=${fmtNum(stockLiveState.formingBar.low, 2)} C=${fmtNum(stockLiveState.formingBar.close, 2)} V=${String(stockLiveState.formingBar.volume)}`
            : 'null';
        const proj = stockRuntime.latestProjection;
        const projDesc =
          proj !== null
            ? `EMA21=${fmtNum(proj.ema, 4)} SessionVWAP=${proj.sessionVwap !== null ? `${fmtNum(proj.sessionVwap.vwap, 4)} (${proj.sessionVwap.source}, frozen=${String(proj.sessionVwap.frozen)})` : 'null'} AVWAP=${proj.avwap !== null ? `${fmtNum(proj.avwap.vwap, 4)} [±1σ=${fmtNum(proj.avwap.lower1, 2)}..${fmtNum(proj.avwap.upper1, 2)}]` : 'null'}`
            : 'null (sin formingBar en ventana)';

        emit(
          `  [5B /stocks] seedBars=${String(spyBarsRes.bars.length)} duration=${fmtNum(stockElapsedMs / 1_000, 2)}s stable20s=${String(stableFull20s)} max_connections=${String(receivedMaxConnections)}${stockRuntime.maxConnDetectedAtMs !== null ? ` (at ${fmtNum(stockRuntime.maxConnDetectedAtMs / 1_000, 2)}s)` : ''} state=${stockSnap.state}`,
        );
        emit(
          `    Events: msgs=${String(stockSnap.totalMessagesReceived)} T.SPY=${String(stkTradeCount)} (p50=${fmtNum(stkTLat.p50Ms, 0)}ms) A.SPY=${String(stkSecBarCount)} (p50=${fmtNum(stkALat.p50Ms, 0)}ms) AM.SPY=${String(stkMinBarCount)} status=${String(stkStatusCount)} | tradesFolded=${String(stockLiveState.metrics.tradesFolded)} rebroadcasts=${String(stockLiveState.metrics.rebroadcastOverwrites)}`,
        );
        emit(`    FormingBar: ${formingDesc}`);
        emit(`    Projection: ${projDesc}`);
        emit(
          `  HTTP calls totals: ${String(callMetrics.length)} GETs (${callMetrics.map((m) => m.status).every((s) => s === 200) ? 'all 200 OK' : 'mixed statuses'})`,
        );

        // ===================================================================
        // Auditoría final de no-exposición de credenciales
        // ===================================================================
        const fullAuditText = JSON.stringify({
          logs: logLines,
          optSnap,
          stockSnap,
          optErrors,
          stkErrors,
          treasuryReport: treasuryRes.report,
          fundingReport: fundingRes.report,
          unifiedReport: unifiedRes.report,
          spyContractsReport: spyContractsRes.report,
          spxContractsReport: spxContractsRes.report,
          spyChainReport: spyChainRes.report,
          spxChainReport: spxChainRes.report,
          spyUnusualReport: spyUnusualRes.report,
          spxUnusualReport: spxUnusualRes.report,
        });

        for (const secret of secrets) {
          expect(fullAuditText).not.toContain(secret);
        }
        const authQueryPattern = ['api', 'key='].join('');
        expect(fullAuditText.toLowerCase()).not.toContain(authQueryPattern);
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  },
);
