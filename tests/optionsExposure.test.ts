import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeContractExposure,
  computeDealerExposure,
  computeExpectedMoveForExpiry,
  computeWallsFromStrikes,
  evaluateNetGexAtSpot,
  findGammaFlipSpot,
  type ExposureContractInput,
  type ExposureMarketInputs,
  type ExposureOptions,
} from '../src/core/options/exposure.js';

type JsonNumber = number | 'NaN';

interface RawStrikeExposureRef {
  readonly strike: number;
  readonly callOpenInterest: number;
  readonly putOpenInterest: number;
  readonly totalOpenInterest: number;
  readonly callVolume: JsonNumber;
  readonly putVolume: JsonNumber;
  readonly totalVolume: JsonNumber;
  readonly callGex: number;
  readonly putGex: number;
  readonly netGex: number;
  readonly absGex: number;
  readonly callSpotGamma: number;
  readonly putSpotGamma: number;
  readonly netSpotGamma: number;
  readonly callDex: number;
  readonly putDex: number;
  readonly netDex: number;
  readonly callVannaExposure: number;
  readonly putVannaExposure: number;
  readonly netVannaExposure: number;
  readonly callCharmExposure: number;
  readonly putCharmExposure: number;
  readonly netCharmExposure: number;
}

interface ExpectedMoveRef {
  readonly expiryUtcSec: number;
  readonly timeToExpiry: number;
  readonly ivAtm: JsonNumber;
  readonly formulaMove: JsonNumber;
  readonly formulaMovePct: JsonNumber;
  readonly straddleStrike: JsonNumber;
  readonly straddleCallPrice: JsonNumber;
  readonly straddlePutPrice: JsonNumber;
  readonly straddleMove: JsonNumber;
  readonly straddleMovePct: JsonNumber;
}

interface ExposureSummaryRef {
  readonly callGex: number;
  readonly putGex: number;
  readonly netGex: number;
  readonly absGex: number;
  readonly netSpotGamma: number;
  readonly callDex: number;
  readonly putDex: number;
  readonly netDex: number;
  readonly callVannaExposure: number;
  readonly putVannaExposure: number;
  readonly netVannaExposure: number;
  readonly callCharmExposure: number;
  readonly putCharmExposure: number;
  readonly netCharmExposure: number;
  readonly callWallStrike: JsonNumber;
  readonly putWallStrike: JsonNumber;
  readonly gammaFlipSpot: JsonNumber;
  readonly gammaFlipStatus: string;
  readonly gammaFlipCandidates: readonly number[];
  readonly expectedMoveByExpiry: readonly ExpectedMoveRef[];
  readonly byStrike: readonly RawStrikeExposureRef[];
  readonly quality: {
    readonly activeContracts: number;
    readonly usableContracts: number;
    readonly zeroOiContracts: number;
    readonly invalidOiContracts: number;
    readonly skippedContracts: number;
    readonly totalActiveOpenInterest: number;
    readonly skippedOpenInterest: number;
    readonly skippedOiShare: number;
  };
}

interface RawContractFixture {
  readonly contractType: 'call' | 'put';
  readonly strike: number;
  readonly expiryUtcSec: number;
  readonly openInterest: JsonNumber;
  readonly volume?: JsonNumber;
  readonly sharesPerContract: number;
  readonly iv?: JsonNumber;
  readonly midPrice?: number;
  readonly bid?: number;
  readonly ask?: number;
}

interface ExposureFixtureFile {
  readonly generator: string;
  readonly tolerance: number;
  readonly scenario1_realisticSpy: {
    readonly market: ExposureMarketInputs;
    readonly contracts: readonly RawContractFixture[];
    readonly expectedDefault: ExposureSummaryRef;
    readonly expectedWallsOi: {
      readonly callWallStrike: number;
      readonly putWallStrike: number;
    };
    readonly netGexAtSpot95Pct: number;
  };
  readonly scenario2_qualityDegraded: {
    readonly market: ExposureMarketInputs;
    readonly contracts: readonly RawContractFixture[];
    readonly expected: ExposureSummaryRef;
  };
  readonly scenario3_flipAndSigns: {
    readonly market: ExposureMarketInputs;
    readonly noCrossingCallsOnly: {
      readonly contracts: readonly RawContractFixture[];
      readonly expected: ExposureSummaryRef;
    };
    readonly doubleCrossing: {
      readonly contracts: readonly RawContractFixture[];
      readonly expectedDefault: ExposureSummaryRef;
      readonly expectedNearestRoot: number;
    };
    readonly invertedSign: {
      readonly contracts: readonly RawContractFixture[];
      readonly expectedStd: ExposureSummaryRef;
      readonly expectedInverted: ExposureSummaryRef;
    };
  };
  readonly scenario4_black76: {
    readonly market: ExposureMarketInputs;
    readonly contracts: readonly RawContractFixture[];
    readonly expected: ExposureSummaryRef;
  };
}

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/options_exposure_reference.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ExposureFixtureFile;
const TOLERANCE = FIXTURE.tolerance;

let maxRelDiff = 0;
let maxNearZeroAbsDiff = 0;

function decodeJsonNumber(v: JsonNumber): number {
  return v === 'NaN' ? Number.NaN : v;
}

function hydrateContracts(raws: readonly RawContractFixture[]): ExposureContractInput[] {
  return raws.map((c) => {
    const out: {
      contractType: 'call' | 'put';
      strike: number;
      expiryUtcSec: number;
      openInterest: number;
      sharesPerContract: number;
      volume?: number;
      iv?: number;
      midPrice?: number;
      bid?: number;
      ask?: number;
    } = {
      contractType: c.contractType,
      strike: c.strike,
      expiryUtcSec: c.expiryUtcSec,
      openInterest: decodeJsonNumber(c.openInterest),
      sharesPerContract: c.sharesPerContract,
    };
    if (c.volume !== undefined) {
      out.volume = decodeJsonNumber(c.volume);
    }
    if (c.iv !== undefined) {
      out.iv = decodeJsonNumber(c.iv);
    }
    if (c.midPrice !== undefined) {
      out.midPrice = c.midPrice;
    }
    if (c.bid !== undefined) {
      out.bid = c.bid;
    }
    if (c.ask !== undefined) {
      out.ask = c.ask;
    }
    return out;
  });
}

function expectClose(actual: number, expectedRaw: JsonNumber, tol = TOLERANCE): void {
  const expected = decodeJsonNumber(expectedRaw);
  if (Number.isNaN(expected)) {
    expect(actual).toBeNaN();
    return;
  }
  expect(Number.isFinite(actual)).toBe(true);
  const absDiff = Math.abs(actual - expected);
  const scale = Math.abs(expected);
  if (scale <= 1) {
    if (absDiff > maxNearZeroAbsDiff) {
      maxNearZeroAbsDiff = absDiff;
    }
    expect(absDiff).toBeLessThanOrEqual(tol);
  } else {
    const rel = absDiff / scale;
    if (rel > maxRelDiff) {
      maxRelDiff = rel;
    }
    expect(rel).toBeLessThanOrEqual(tol);
  }
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.freeze(obj);
    for (const val of Object.values(obj as Record<string, unknown>)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function verifySummaryAgainstRef(
  actual: ReturnType<typeof computeDealerExposure>,
  expected: ExposureSummaryRef,
): void {
  expectClose(actual.callGex, expected.callGex);
  expectClose(actual.putGex, expected.putGex);
  expectClose(actual.netGex, expected.netGex);
  expectClose(actual.absGex, expected.absGex);
  expectClose(actual.netSpotGamma, expected.netSpotGamma);
  expectClose(actual.callDex, expected.callDex);
  expectClose(actual.putDex, expected.putDex);
  expectClose(actual.netDex, expected.netDex);
  expectClose(actual.callVannaExposure, expected.callVannaExposure);
  expectClose(actual.putVannaExposure, expected.putVannaExposure);
  expectClose(actual.netVannaExposure, expected.netVannaExposure);
  expectClose(actual.callCharmExposure, expected.callCharmExposure);
  expectClose(actual.putCharmExposure, expected.putCharmExposure);
  expectClose(actual.netCharmExposure, expected.netCharmExposure);

  expectClose(actual.callWallStrike, expected.callWallStrike);
  expectClose(actual.putWallStrike, expected.putWallStrike);
  expectClose(actual.gammaFlipSpot, expected.gammaFlipSpot);
  expect(actual.gammaFlipStatus).toBe(expected.gammaFlipStatus);
  expect(actual.gammaFlipCandidates.length).toBe(expected.gammaFlipCandidates.length);
  for (let i = 0; i < expected.gammaFlipCandidates.length; i += 1) {
    const a = actual.gammaFlipCandidates[i];
    const e = expected.gammaFlipCandidates[i];
    if (a !== undefined && e !== undefined) {
      expectClose(a, e);
    }
  }

  expect(actual.quality.activeContracts).toBe(expected.quality.activeContracts);
  expect(actual.quality.usableContracts).toBe(expected.quality.usableContracts);
  expect(actual.quality.zeroOiContracts).toBe(expected.quality.zeroOiContracts);
  expect(actual.quality.invalidOiContracts).toBe(expected.quality.invalidOiContracts);
  expect(actual.quality.skippedContracts).toBe(expected.quality.skippedContracts);
  expect(actual.quality.totalActiveOpenInterest).toBe(
    expected.quality.totalActiveOpenInterest,
  );
  expect(actual.quality.skippedOpenInterest).toBe(expected.quality.skippedOpenInterest);
  expectClose(actual.quality.skippedOiShare, expected.quality.skippedOiShare);

  expect(actual.byStrike.length).toBe(expected.byStrike.length);
  for (let i = 0; i < expected.byStrike.length; i += 1) {
    const aRow = actual.byStrike[i];
    const eRow = expected.byStrike[i];
    expect(aRow).toBeDefined();
    expect(eRow).toBeDefined();
    if (aRow === undefined || eRow === undefined) {
      continue;
    }
    expectClose(aRow.strike, eRow.strike);
    expectClose(aRow.callOpenInterest, eRow.callOpenInterest);
    expectClose(aRow.putOpenInterest, eRow.putOpenInterest);
    expectClose(aRow.callVolume, eRow.callVolume);
    expectClose(aRow.putVolume, eRow.putVolume);
    expectClose(aRow.totalVolume, eRow.totalVolume);
    expectClose(aRow.callGex, eRow.callGex);
    expectClose(aRow.putGex, eRow.putGex);
    expectClose(aRow.netGex, eRow.netGex);
    expectClose(aRow.absGex, eRow.absGex);
    expectClose(aRow.netSpotGamma, eRow.netSpotGamma);
    expectClose(aRow.netDex, eRow.netDex);
    expectClose(aRow.netVannaExposure, eRow.netVannaExposure);
    expectClose(aRow.netCharmExposure, eRow.netCharmExposure);
    // Spot-share gamma exact algebraic identity: spotShareGamma * S * 0.01 === dollarGex
    expectClose(aRow.netSpotGamma * actual.spot * 0.01, aRow.netGex);
  }

  expect(actual.expectedMoveByExpiry.length).toBe(expected.expectedMoveByExpiry.length);
  for (let i = 0; i < expected.expectedMoveByExpiry.length; i += 1) {
    const aEm = actual.expectedMoveByExpiry[i];
    const eEm = expected.expectedMoveByExpiry[i];
    expect(aEm).toBeDefined();
    expect(eEm).toBeDefined();
    if (aEm === undefined || eEm === undefined) {
      continue;
    }
    expect(aEm.expiryUtcSec).toBe(eEm.expiryUtcSec);
    expectClose(aEm.timeToExpiry, eEm.timeToExpiry);
    expectClose(aEm.ivAtm, eEm.ivAtm);
    expectClose(aEm.formulaMove, eEm.formulaMove);
    expectClose(aEm.formulaMovePct, eEm.formulaMovePct);
    expectClose(aEm.straddleStrike, eEm.straddleStrike);
    expectClose(aEm.straddleCallPrice, eEm.straddleCallPrice);
    expectClose(aEm.straddlePutPrice, eEm.straddlePutPrice);
    expectClose(aEm.straddleMove, eEm.straddleMove);
    expectClose(aEm.straddleMovePct, eEm.straddleMovePct);
  }
}

describe('Dealer Exposure Engine (Pieza 6)', () => {
  afterAll(() => {
    console.info(
      `[optionsExposure.test] maxRelDiff=${maxRelDiff.toExponential(3)}, maxNearZeroAbsDiff=${maxNearZeroAbsDiff.toExponential(3)}`,
    );
  });

  it('Scenario 1: matches SPY multi-expiry GEX, Spot-share Gamma, DEX, Vanna, Charm, Walls (GEX vs OI), Gamma Flip, and Expected Move within 1e-9', () => {
    const sc1 = FIXTURE.scenario1_realisticSpy;
    const contracts = deepFreeze(hydrateContracts(sc1.contracts));
    const market = deepFreeze({ ...sc1.market });

    const resDefault = computeDealerExposure(contracts, market);
    verifySummaryAgainstRef(resDefault, sc1.expectedDefault);

    // Check netGex at Gamma Flip is essentially zero.
    const gexAtFlip = evaluateNetGexAtSpot(contracts, market, resDefault.gammaFlipSpot);
    expect(Math.abs(gexAtFlip)).toBeLessThan(1e-2);
    expectClose(
      evaluateNetGexAtSpot(contracts, market, market.spot * 0.95),
      sc1.netGexAtSpot95Pct,
    );

    // OI wall criterion picks high-OI far wings (545/630) whereas GEX picks 565/605.
    const resOi = computeDealerExposure(contracts, market, { wallCriterion: 'oi' });
    expectClose(resOi.callWallStrike, sc1.expectedWallsOi.callWallStrike);
    expectClose(resOi.putWallStrike, sc1.expectedWallsOi.putWallStrike);

    // Headline expectedMove corresponds to earliest expiry (7 DTE), and second expiry selectable explicitly.
    const exp30 = resDefault.expectedMoveByExpiry[1]?.expiryUtcSec ?? Number.NaN;
    const res30 = computeDealerExposure(contracts, market, {
      expectedMoveExpirySec: exp30,
    });
    expect(res30.expectedMove.expiryUtcSec).toBe(exp30);
    expectClose(
      res30.expectedMove.formulaMove,
      sc1.expectedDefault.expectedMoveByExpiry[1]?.formulaMove ?? 'NaN',
    );
  });

  it('Scenario 2: excludes OI<=0/NaN without penalty and tracks active iv=NaN / expired contracts via skippedContracts & skippedOiShare without masking volume NaN', () => {
    const sc2 = FIXTURE.scenario2_qualityDegraded;
    const contracts = deepFreeze(hydrateContracts(sc2.contracts));
    const market = deepFreeze({ ...sc2.market });

    const res = computeDealerExposure(contracts, market);
    verifySummaryAgainstRef(res, sc2.expected);
    expect(res.quality.countsByReason.invalidIv).toBe(2);
    expect(res.quality.countsByReason.expired).toBe(1);
    expect(res.quality.skippedDetails.length).toBe(3);

    // Single-contract quality inspection
    const firstContract = contracts[0];
    expect(firstContract).toBeDefined();
    if (firstContract !== undefined) {
      const zeroOiSingle = computeContractExposure(firstContract, market);
      expect(zeroOiSingle.isActive).toBe(false);
      expect(zeroOiSingle.dollarGex).toBe(0);
    }

    const nanIvContract = contracts[3];
    expect(nanIvContract).toBeDefined();
    if (nanIvContract !== undefined) {
      const nanIvSingle = computeContractExposure(nanIvContract, market);
      expect(nanIvSingle.isActive).toBe(true);
      expect(nanIvSingle.isUsable).toBe(false);
      expect(nanIvSingle.skipReason).toBe('invalidIv');
      expect(nanIvSingle.dollarGex).toBeNaN();
    }
  });

  it('Scenario 3: handles no Zero-Gamma crossing (NaN), multi-crossing policy (NaN default vs nearestSpot), and custom dealerPositionSign', () => {
    const sc3 = FIXTURE.scenario3_flipAndSigns;
    const market = deepFreeze({ ...sc3.market });

    const callsOnly = deepFreeze(hydrateContracts(sc3.noCrossingCallsOnly.contracts));
    const resNoCross = computeDealerExposure(callsOnly, market);
    verifySummaryAgainstRef(resNoCross, sc3.noCrossingCallsOnly.expected);
    expect(resNoCross.gammaFlipSpot).toBeNaN();
    expect(resNoCross.gammaFlipStatus).toBe('no_crossing');

    const doubleContracts = deepFreeze(hydrateContracts(sc3.doubleCrossing.contracts));
    const resMultiDefault = computeDealerExposure(doubleContracts, market);
    verifySummaryAgainstRef(resMultiDefault, sc3.doubleCrossing.expectedDefault);
    expect(resMultiDefault.gammaFlipSpot).toBeNaN();
    expect(resMultiDefault.gammaFlipStatus).toBe('multiple_crossings');

    const flipNearest = findGammaFlipSpot(doubleContracts, market, {
      gammaFlipMultiRootPolicy: 'nearestSpot',
    });
    expect(flipNearest.status).toBe('multiple_crossings');
    expectClose(flipNearest.gammaFlipSpot, sc3.doubleCrossing.expectedNearestRoot);

    const mixedContracts = deepFreeze(hydrateContracts(sc3.invertedSign.contracts));
    const resStd = computeDealerExposure(mixedContracts, market);
    const resInv = computeDealerExposure(mixedContracts, market, {
      dealerPositionSign: { call: -1, put: 1 },
    });
    verifySummaryAgainstRef(resStd, sc3.invertedSign.expectedStd);
    verifySummaryAgainstRef(resInv, sc3.invertedSign.expectedInverted);
    expectClose(resInv.netGex, -resStd.netGex);
    expectClose(resInv.netDex, -resStd.netDex);
    expectClose(resInv.netVannaExposure, -resStd.netVannaExposure);
    expectClose(resInv.netCharmExposure, -resStd.netCharmExposure);
    expectClose(resInv.absGex, resStd.absGex);
  });

  it('Scenario 4: supports Black-76 futures/VIX option chains cleanly with positive Gamma and Vanna', () => {
    const sc4 = FIXTURE.scenario4_black76;
    const contracts = deepFreeze(hydrateContracts(sc4.contracts));
    const market = deepFreeze({ ...sc4.market });

    const opts: ExposureOptions = deepFreeze({
      model: 'black76',
      gammaFlipHalfWidth: 0.4,
    });
    const res = computeDealerExposure(contracts, market, opts);
    verifySummaryAgainstRef(res, sc4.expected);

    // Every Black-76 option call has positive dollar GEX (callSign = +1, gamma > 0).
    for (const row of res.byStrike) {
      if (row.callOpenInterest > 0) {
        expect(row.callGex).toBeGreaterThan(0);
      }
      if (row.putOpenInterest > 0) {
        expect(row.putGex).toBeLessThan(0);
      }
    }
  });

  it('Edge invariants: rejects missing dividendYield without fallback, blocks ms timestamps, honors wallScope otm, validates empty/all-zero-OI chains, and handles American + parity forward', () => {
    const now = 1770000000;
    const exp = now + 15 * 86400;

    // 1. Missing dividendYield without forward must NOT fall back to q=0 under BSM.
    const noDivMarket: ExposureMarketInputs = { spot: 100, nowUtcSec: now, rate: 0.04 };
    const singleCall: ExposureContractInput = {
      contractType: 'call',
      strike: 100,
      expiryUtcSec: exp,
      openInterest: 100,
      volume: 10,
      sharesPerContract: 100,
      iv: 0.2,
    };
    const missingDivRes = computeContractExposure(singleCall, noDivMarket);
    expect(missingDivRes.isActive).toBe(true);
    expect(missingDivRes.isUsable).toBe(false);
    expect(missingDivRes.skipReason).toBe('invalidRates');
    expect(missingDivRes.dollarGex).toBeNaN();

    // 2. Providing market.forward without market.dividendYield infers q via Put-Call parity cleanly.
    const fwdMarket: ExposureMarketInputs = {
      spot: 100,
      nowUtcSec: now,
      rate: 0.04,
      forward: 100 * Math.exp((0.04 - 0.015) * (15 / 365)),
    };
    const inferredRes = computeContractExposure(singleCall, fwdMarket);
    expect(inferredRes.isUsable).toBe(true);
    expectClose(inferredRes.dividendYield, 0.015, 1e-12);

    // 3. Millisecond timestamp must be caught cleanly (never mixed with seconds).
    const msContract: ExposureContractInput = { ...singleCall, expiryUtcSec: exp * 1000 };
    expect(computeContractExposure(msContract, { ...noDivMarket, dividendYield: 0 }).skipReason).toBe(
      'invalidExpiry',
    );
    expect(
      computeDealerExposure([singleCall], { ...noDivMarket, nowUtcSec: now * 1000, dividendYield: 0 })
        .netGex,
    ).toBeNaN();

    // 4. Empty chain -> all totals NaN; 100% active iv=NaN -> skippedOiShare=1 & NaN totals; valid all-zero-OI -> 0 totals & NaN walls/flip.
    const cleanMarket = { spot: 100, nowUtcSec: now, rate: 0.04, dividendYield: 0.01 };
    expect(computeDealerExposure([], cleanMarket).netGex).toBeNaN();

    const allSkipped = computeDealerExposure(
      [{ ...singleCall, iv: Number.NaN }],
      cleanMarket,
    );
    expect(allSkipped.quality.skippedOiShare).toBe(1);
    expect(allSkipped.netGex).toBeNaN();

    const allZeroOi = computeDealerExposure(
      [{ ...singleCall, openInterest: 0 }],
      cleanMarket,
    );
    expect(allZeroOi.netGex).toBe(0);
    expect(allZeroOi.callWallStrike).toBeNaN();
    expect(allZeroOi.putWallStrike).toBeNaN();
    expect(allZeroOi.gammaFlipSpot).toBeNaN();

    // 5. wallScope: 'otm' restricts Call Wall to K >= S and Put Wall to K <= S.
    const itmHeavy = computeDealerExposure(
      [
        { ...singleCall, strike: 95, contractType: 'call', openInterest: 5000, iv: 0.25 },
        { ...singleCall, strike: 105, contractType: 'call', openInterest: 1000, iv: 0.2 },
        { ...singleCall, strike: 110, contractType: 'put', openInterest: 4000, iv: 0.22 },
        { ...singleCall, strike: 92, contractType: 'put', openInterest: 800, iv: 0.26 },
      ],
      cleanMarket,
    );
    expect(itmHeavy.callWallStrike).toBe(95);
    expect(itmHeavy.putWallStrike).toBe(110);
    const otmWalls = computeWallsFromStrikes(itmHeavy.byStrike, 100, {
      wallCriterion: 'gex',
      wallScope: 'otm',
    });
    expect(otmWalls.callWallStrike).toBe(105);
    expect(otmWalls.putWallStrike).toBe(92);

    // 6. Expected Move straddle missing put or explicit NaN midPrice returns NaN cleanly.
    const onlyCallAtm = computeExpectedMoveForExpiry(
      [
        { ...singleCall, strike: 95, contractType: 'put', iv: 0.24 },
        { ...singleCall, strike: 100, contractType: 'call', iv: 0.21, midPrice: Number.NaN },
        { ...singleCall, strike: 100, contractType: 'put', iv: 0.21, midPrice: 2.0 },
        { ...singleCall, strike: 105, contractType: 'call', iv: 0.19 },
      ],
      cleanMarket,
      exp,
    );
    expect(Number.isFinite(onlyCallAtm.formulaMove)).toBe(true);
    expect(onlyCallAtm.straddleMove).toBeNaN();

    // 7. American option exposure model runs cleanly without NaN.
    const amRes = computeDealerExposure(
      [
        { ...singleCall, contractType: 'put', strike: 95, iv: 0.24 },
        { ...singleCall, contractType: 'call', strike: 105, iv: 0.2 },
      ],
      cleanMarket,
      { model: 'american' },
    );
    expect(amRes.model).toBe('american');
    expect(amRes.callGex).toBeGreaterThan(0);
    expect(amRes.putGex).toBeLessThan(0);
    expect(Number.isFinite(amRes.netVannaExposure)).toBe(true);
    expect(Number.isFinite(amRes.netCharmExposure)).toBe(true);
  });
});
