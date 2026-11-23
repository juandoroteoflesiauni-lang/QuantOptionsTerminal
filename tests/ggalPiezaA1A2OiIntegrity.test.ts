import { afterEach, describe, expect, it, vi } from 'vitest';
import reference from '../fixtures/ggal_pieza_a1_a2_reference.json' with { type: 'json' };
import {
  buildCanonicalOptionKey,
  isIsoContractDate,
  resolveBymaContractualExpiry,
  selectAnexoBPartition,
} from '../src/core/ggal/anexoBIdentity.js';
import {
  classifyRawOiValue,
  explicitVolumeOi,
  mergeOptionFieldProvenance,
  missingOi,
  resolveContractMultiplier,
  resolveOiSourcePrecedence,
  type OiFieldProvenance,
} from '../src/core/options/oiProvenance.js';
import { evaluateStructureAndPinning } from '../src/core/ggal/structurePinning.js';
import { resolveArExposureOiQuality } from '../src/core/exposureTrace.js';
import { computeDealerExposure } from '../src/core/options/exposure.js';
import {
  ArgentinaMarketRuntime,
  mergeBmbOptionQuotes,
  normalizeData912Rows,
  parseBymaOptionSymbol,
} from '../src/server/argentinaMarketLoader.js';
import {
  GgalSpecialistRuntime,
  adaptScraperAnexoBJsonToIngestRequest,
  parseAnexoBIamcInput,
} from '../src/server/ggalSpecialistRuntime.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import { BmbBridgeClient, type BmbBridgeSnapshotDto } from '../src/server/primaryRofexLoader.js';

vi.mock('../src/server/envBootstrap.js', () => ({}));
afterEach(() => vi.restoreAllMocks());

const now = reference.asOfUtcSec;
const isolation = reference.a1ExpiryIsolation;
const reportDate = isolation.reportDate;
const [december = '', february = ''] = Object.keys(isolation.byExpiry);
const zeroBuckets = { coveredNom: 0, uncoveredNom: 0, crossedNom: 0, oppositeNom: 0 };
const standardMultiplier = resolveContractMultiplier(100, 'BYMA_STANDARD_TABLE');

function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-9, Math.abs(expected) * 1e-9));
}

function offlineRuntime(options: readonly Record<string, unknown>[], overlayVolume?: number) {
  const nowMsFn = () => now * 1_000;
  const bmbClient = new BmbBridgeClient({ env: {}, nowMsFn });
  if (overlayVolume !== undefined) {
    const snapshot: BmbBridgeSnapshotDto = {
      health: {
        status: 'READY', connected: true, passwordConfigured: true, brokerId: 153, accountLabel: null,
        pyhomebrokerInstalled: null, lastUpdateUtcSec: now,
        counts: { cauciones: 0, orderBooks: 0, options: 1 }, error: null,
      },
      cauciones: [], orderBooksBySymbol: {},
      options: [{
        symbol: 'GFGC6000DI', underlying: 'GGAL', last: 410, bid: 400, ask: 420,
        bidSize: 12, askSize: 14, volume: overlayVolume, turnover: null, varPct: null, asOfUtcSec: now,
      }],
    };
    vi.spyOn(bmbClient, 'getSafeHealthStatus').mockReturnValue(snapshot.health);
    vi.spyOn(bmbClient, 'getSnapshot').mockResolvedValue(snapshot);
  }
  const fetchFn = (url: string) => {
    const { hostname, pathname } = new URL(url);
    let payload: unknown = [];
    if (pathname === '/live/arg_options') payload = options;
    if (pathname === '/live/arg_stocks') {
      payload = [{ symbol: 'GGAL', c: 6000, px_bid: 5995, px_ask: 6005, prev_close: 5940, v: 2000 }];
    }
    if (hostname.includes('bcra.gob.ar')) {
      payload = { results: [{ idVariable: 7, descripcion: 'BADLAR Bancos Privados TNA', valor: 32, fecha: reportDate }] };
    }
    return Promise.resolve({ ok: true, status: 200, text: JSON.stringify(payload), headers: {} });
  };
  const arRuntime = new ArgentinaMarketRuntime({ env: {}, fetchFn, nowMsFn, bmbClient, minData912IntervalMs: 0 });
  return { arRuntime, fetchFn, nowMsFn };
}

function quote(symbol = 'GFGC6000DI', volume = reference.a2BmbL1MergeNoContamination.feedVolume) {
  return { symbol, v: volume, c: 410, px_bid: 400, px_ask: 420 };
}

describe('A1 · IAMC Anexo B', () => {
  it('projects DI and FE independently and keeps multi-expiry results partitioned', () => {
    const projected = parseAnexoBIamcInput({ rawText: isolation.rawText, asOfDate: reportDate, expiryCode: 'DI' }, now);
    const unprojected = parseAnexoBIamcInput({ rawText: isolation.rawText, asOfDate: reportDate }, now);
    expect(projected.rows[0]?.callOi.uncoveredNom).toBe(isolation.byExpiry[december as keyof typeof isolation.byExpiry]);
    expect(unprojected.rows).toEqual([]);
    expect(unprojected.totals.callUncoveredNom).toBe(0);
    expect(Object.fromEntries(Object.entries(unprojected.byExpiry).map(([key, row]) => [key, row.totals.callUncoveredNom])))
      .toEqual(isolation.byExpiry);
    expect(selectAnexoBPartition(unprojected, { contractualExpiry: february, expiryCode: 'FE' }).partition?.appliedMultiplier).toBe(1);
    expect(selectAnexoBPartition(unprojected, { contractualExpiry: february, expiryCode: 'DI' }).status).toBe('EXPIRY_NOT_FOUND');
  });

  it('preserves side, report date and canonical identity and rejects incoherent rows', () => {
    const { rawText, uncoveredByExpiry } = reference.a1CallPutSameStrikeAndExpiry;
    const bothSides = parseAnexoBIamcInput({ rawText, asOfDate: reportDate }, now);
    expect(Object.fromEntries(Object.entries(bothSides.byExpiry).map(([key, row]) => [
      key, [row.totals.callUncoveredNom, row.totals.putUncoveredNom],
    ]))).toEqual(uncoveredByExpiry);
    const dates = reference.a1MultiDateAndSeries;
    const keys = dates.reportDates.map((date) => {
      const result = parseAnexoBIamcInput({
        rawText: `${rawText}\n${dates.foreignLine}`, asOfDate: date,
        rows: [{ strikeArs: 6000, contractualExpiry: december, reportDate: '2026-11-15', callOi: zeroBuckets, putOi: zeroBuckets }],
      }, now);
      expect(result.diagnostics.rejectedRows.map((row) => row.code)).toEqual(dates.errors);
      expect(selectAnexoBPartition(result, { contractualExpiry: december, reportDate: '2026-11-15' }).status)
        .toBe('REPORT_DATE_MISMATCH');
      const identity = result.byExpiry[december]?.identities.find((entry) => entry.side === 'call');
      expect(identity).toBeDefined();
      return identity === undefined ? null : buildCanonicalOptionKey(identity);
    });
    expect(keys).toEqual(dates.canonicalKeys);
  });

  it('rejects ambiguous series and never substitutes a requested expiry', () => {
    const invalid = reference.a1MissingOrAmbiguousExpiry;
    const result = parseAnexoBIamcInput({ rawText: invalid.rawText, asOfDate: reportDate, targetExpiry: invalid.unknownTarget }, now);
    expect(result.diagnostics.rejectedRows.map((row) => row.code)).toEqual(invalid.errors);
    expect(result.targetExpiryMatchStatus).toBe('NOT_FOUND');
    expect(result.rows).toEqual([]);
    expect(selectAnexoBPartition(result, { expiryCode: invalid.unknownTarget }).status).toBe('EXPIRY_NOT_FOUND');
    expect(resolveBymaContractualExpiry({ reportDate, expiryCode: 'DI', arHolidays: [december] }))
      .toMatchObject({ contractualExpiry: '2026-12-17' });
    expect(resolveBymaContractualExpiry({
      reportDate, expiryCode: 'DI',
      knownExpiries: [december, '2027-12-17'].map((expirationDate) => ({ expiryCode: 'DI', expirationDate })),
    })).toMatchObject({ code: 'AMBIGUOUS_EXPIRY_YEAR' });
    expect(isIsoContractDate('2026-02-30')).toBe(false);
    expect(() => parseAnexoBIamcInput({ rawText: invalid.rawText, strictReportDate: true }, now))
      .toThrow('MISSING_REPORT_DATE');
  });

  it('deduplicates exact rows and excludes contradictory copies', () => {
    const fixture = reference.a1Duplicates;
    const result = parseAnexoBIamcInput({ rawText: fixture.identical, asOfDate: reportDate }, now);
    expect(result.rows[0]?.callOi.uncoveredNom).toBe(fixture.nominal);
    expect(result.diagnostics.exactDuplicateRows).toBe(fixture.duplicateCount);
    expect(() => parseAnexoBIamcInput({ rawText: fixture.conflicting, asOfDate: reportDate }, now))
      .toThrow('ANEXO_B_DUPLICATE_CONFLICT');
    const nonStrict = parseAnexoBIamcInput({
      rawText: `${fixture.conflicting}\nGFGV6000DI 0 10 0 0`, asOfDate: reportDate, strictDuplicates: false,
    }, now);
    expect(nonStrict.diagnostics.conflictingDuplicates.map((row) => row.code)).toEqual([fixture.conflictCode]);
    expect(nonStrict.rows[0]?.callOi.uncoveredNom).toBe(0);
  });

  it('keeps IAMC snapshots isolated in the specialist and publishes exact matching shares to AR exposure', async () => {
    const { arRuntime, fetchFn, nowMsFn } = offlineRuntime([
      { ...quote(), open_interest: reference.a2SourceConflictPrecedence.data912Contracts },
      quote('GFGC6000FE'),
    ]);
    const runtime = new MarketRuntime({ fetchFn, nowMsFn });
    const specialist = new GgalSpecialistRuntime({ runtime, arRuntime, fetchFn, nowMsFn });
    const newest = parseAnexoBIamcInput({ asOfDate: reportDate, rawText: isolation.rawText }, now);
    const ingested = specialist.ingestAnexoB({ asOfDate: reportDate, rawText: isolation.rawText });
    specialist.ingestAnexoB({ asOfDate: '2026-11-15', rawText: reference.a1Duplicates.identical });
    expect(ingested.record.byExpiry).toEqual(newest.byExpiry);
    expect(Object.keys(specialist.getAnexoBByExpiry())).toEqual([december, february]);
    expect(Object.keys(specialist.getAnexoBByExpiry('2026-11-15'))).toEqual([december]);
    const chain = await arRuntime.getOptionsChain();
    expect(chain.expiries.map((expiry) => expiry.calls[0]?.oiProvenance)).toMatchObject([
      { status: 'IAMC_ANEXO_B', nominalShares: isolation.totalNominalByExpiry['2026-12-18'], contractualExpiry: december, appliedMultiplier: 1,
        conflict: { alternateValue: reference.a2SourceConflictPrecedence.data912Shares } },
      { status: 'IAMC_ANEXO_B', nominalShares: isolation.totalNominalByExpiry['2027-02-19'], contractualExpiry: february, appliedMultiplier: 1 },
    ]);
    const missing = await specialist.getStructurePinning(false, { targetExpiry: 'AB' });
    expect(missing).toMatchObject({ result: null, proxyResult: null, gexStatus: 'UNAVAILABLE_MISSING_OI' });
  });

  it('preserves sibling FE expiry in byExpiry when projecting by contractualExpiry', () => {
    const proj = reference.a1ContractualExpiryProjectionDelta;
    const result = parseAnexoBIamcInput({
      rawText: proj.rawText, asOfDate: reportDate, contractualExpiry: proj.contractualExpiry,
    }, now);
    expect(result.rows[0]?.callOi.uncoveredNom).toBe(proj.projectedUncovered);
    expect(result.byExpiry[february]?.totals.callUncoveredNom).toBe(proj.byExpiryUncovered[february as keyof typeof proj.byExpiryUncovered]);
    expect(result.byExpiry[december]?.totals.callUncoveredNom).toBe(proj.byExpiryUncovered[december as keyof typeof proj.byExpiryUncovered]);
    expect(result.diagnostics.rejectedRows).toEqual([]);
    const mismatch = parseAnexoBIamcInput({
      rawText: proj.rawText, asOfDate: reportDate,
      rows: [{ strikeArs: 6100, nativeSeries: 'GFGC6100FE', contractualExpiry: december, callOi: zeroBuckets, putOi: zeroBuckets }],
    }, now);
    expect(mismatch.diagnostics.rejectedRows.map((row) => row.code)).toEqual(['EXPIRY_DATE_MISMATCH']);
  });

  it('aligns holiday-shifted contractualExpiry between Anexo B and parseBymaOptionSymbol and rejects truncated suffixes', async () => {
    const h = reference.a1HolidayAlignedExpiryDelta;
    expect(resolveBymaContractualExpiry({ reportDate, expiryCode: 'DI', arHolidays: [h.holiday] }))
      .toMatchObject({ contractualExpiry: h.shiftedExpiry, expiryCode: 'DI' });
    expect(parseBymaOptionSymbol('GFGC6000DI', 6000, now, false, [h.holiday]))
      .toMatchObject({ expirationDate: h.shiftedExpiry, expiryCode: 'DI' });
    for (const badSymbol of h.rejectedSymbols) {
      expect(parseBymaOptionSymbol(badSymbol, 6000, now, false, [h.holiday])).toBeNull();
    }
    const { arRuntime, fetchFn, nowMsFn } = offlineRuntime([quote('GFGC6000DI')]);
    const runtime = new MarketRuntime({ fetchFn, nowMsFn });
    const specialist = new GgalSpecialistRuntime({ runtime, arRuntime, fetchFn, nowMsFn, arHolidays: [h.holiday] });
    specialist.ingestAnexoB({ asOfDate: reportDate, rawText: 'GFGC6000DI 100 200 0 0' });
    const chain = await arRuntime.getOptionsChain();
    expect(chain.expiries[0]?.calls[0]?.oiProvenance).toMatchObject({
      status: 'IAMC_ANEXO_B', contractualExpiry: h.shiftedExpiry, nominalShares: 300,
    });
  });

  it('rejects single malformed rawText line and contradictory structured side without aborting valid rows', () => {
    const partial = reference.a1PartialMalformedRawTextAndSideMismatchDelta;
    const rawRes = parseAnexoBIamcInput({ rawText: partial.rawText, asOfDate: reportDate }, now);
    expect(rawRes.rows[0]?.callOi.uncoveredNom).toBe(partial.validUncovered);
    expect(rawRes.diagnostics.rejectedRows.map((row) => row.code)).toEqual([partial.rawRejectedCode]);
    const sideRes = parseAnexoBIamcInput({
      rawText: 'GFGC6000DI 100 200 0 0',
      asOfDate: reportDate,
      rows: [{
        strikeArs: 6100, nativeSeries: 'GFGC6100DI', callOi: zeroBuckets,
        putOi: { coveredNom: 0, uncoveredNom: 50, oppositeNom: 0, crossedNom: 0 },
      }],
    }, now);
    expect(sideRes.rows[0]?.callOi.uncoveredNom).toBe(partial.validUncovered);
    expect(sideRes.diagnostics.rejectedRows.map((row) => row.code)).toEqual([partial.rowRejectedCode]);
    const adapted = adaptScraperAnexoBJsonToIngestRequest({
      tradeDate: reportDate,
      records: [
        { series: 'GFGC6000DI', coveredNom: 100, uncoveredNom: 200, crossedNom: 0, flag: 'FRESH' },
        { series: 'GFGC6200DI', coveredNom: null, uncoveredNom: null, crossedNom: null, flag: 'MISSING_UNAVAILABLE' },
        { series: 'GFGC6400DI', coveredNom: 10, uncoveredNom: 20, crossedNom: 0, flag: 'CARRY_FORWARD_NO_TRADE', sourceReportDate: '2026-11-15' },
      ],
    });
    if (adapted === null) throw new Error('Expected adapted request');
    const parsedFromScraper = parseAnexoBIamcInput(adapted, now);
    expect(parsedFromScraper.totals.callUncoveredNom).toBe(200);
    expect(parsedFromScraper.rows).toHaveLength(1);
  });

  it('scopes telemetry.anexoBStatus to matched expiry and reports VolTriangle openInterestNom in shares', async () => {
    const vtRef = reference.a1VolTriangleNominalSharesDelta;
    const diOnlyQuotes = [
      { symbol: 'GFGC5800DI', v: 50, c: 450, px_bid: 440, px_ask: 460, open_interest: 0 },
      { symbol: 'GFGC6000DI', v: 80, c: 340, px_bid: 330, px_ask: 350, open_interest: vtRef.contracts },
      { symbol: 'GFGC6200DI', v: 40, c: 230, px_bid: 220, px_ask: 240 },
    ];
    const scopeMock = offlineRuntime([...diOnlyQuotes, quote('GFGC6000FE')]);
    const scopeSpec = new GgalSpecialistRuntime({
      runtime: new MarketRuntime({ fetchFn: scopeMock.fetchFn, nowMsFn: scopeMock.nowMsFn }),
      arRuntime: scopeMock.arRuntime, fetchFn: scopeMock.fetchFn, nowMsFn: scopeMock.nowMsFn,
    });
    scopeSpec.ingestAnexoB({ asOfDate: reportDate, rawText: 'GFGC6000DI 100 200 0 0' });
    const unmatchedFe = await scopeSpec.getStructurePinning(false, { targetExpiry: 'FE' });
    expect(unmatchedFe.telemetry.anexoBStatus).toBe('NO_DATA');
    expect(unmatchedFe.telemetry.anexoBAsOfDate).toBeNull();
    expect(unmatchedFe.telemetry.feedBadges).not.toContain('T-1 ANEXO B');

    const vtMock = offlineRuntime(diOnlyQuotes);
    const vtSpec = new GgalSpecialistRuntime({
      runtime: new MarketRuntime({ fetchFn: vtMock.fetchFn, nowMsFn: vtMock.nowMsFn }),
      arRuntime: vtMock.arRuntime, fetchFn: vtMock.fetchFn, nowMsFn: vtMock.nowMsFn,
    });
    const volTriangle = await vtSpec.getVolTriangle();
    expect(volTriangle.smileComparison.find((pt) => pt.strikeArs === 6000)?.openInterestNom)
      .toBe(vtRef.expectedOpenInterestNom);
    expect(volTriangle.smileComparison.find((pt) => pt.strikeArs === 5800)?.openInterestNom).toBe(0);
    expect(volTriangle.smileComparison.find((pt) => pt.strikeArs === 6200)?.openInterestNom).toBeNull();
  });
});

describe('A2 · provenance and GEX', () => {
  it('computes signed GEX per 1% with one explicit multiplier', () => {
    for (const sample of [reference.a1IamcSharesUnitNoDoubleMult, ...reference.a2DirectContractOiMultiplier]) {
      const side = sample.side === 'call' ? 'call' : 'put';
      const oi = classifyRawOiValue(sample.count, 'DATA912', now, resolveContractMultiplier(sample.multiplier, 'EXCHANGE_CONTRACT_SPEC'));
      expect(oi).toMatchObject({ status: 'DIRECT_CONTRACT_OI', nominalShares: sample.nominalShares });
      const exposure = computeDealerExposure([{
        contractType: side, strike: sample.strike, openInterest: sample.count, sharesPerContract: sample.multiplier,
        expiryUtcSec: now + sample.years * 31_536_000, iv: sample.volatility,
      }], { spot: sample.spot, nowUtcSec: now, rate: 0, dividendYield: 0 }, { model: 'bsm' });
      near(exposure.netGex, sample.gex);
    }
    expect(classifyRawOiValue(250, 'DATA912', now, resolveContractMultiplier(100, 'UNVERIFIED')))
      .toMatchObject({ status: 'INVALID_OI', reason: 'UNVERIFIED_MULTIPLIER' });
  });

  it('keeps BMB L1 separate from observed OI and requires request-scoped proxy opt-in', async () => {
    const sample = reference.a2BmbL1MergeNoContamination;
    const { arRuntime } = offlineRuntime([quote()], sample.overlayVolume);
    const standard = await arRuntime.getOptionsChain();
    const c = standard.expiries[0]?.calls[0];
    expect(c).toMatchObject({
      volume: sample.overlayVolume, openInterest: sample.openInterest, oiProvenance: { status: 'MISSING_OI' },
      fieldProvenance: { volume: { source: 'BMB_HOMEBROKER_BRIDGE', value: sample.overlayVolume } },
    });
    expect(standard.exposureSummary).toMatchObject({
      netGex: sample.netGex, gexStatus: sample.gexStatus,
      trace: { directOiInputs: sample.direct, proxyOiInputs: sample.proxy, oiProxy: sample.oiProxy },
    });
    const proxy = reference.a2ExplicitProxyOptIn;
    const estimated = await arRuntime.getOptionsChain('GGAL', false, { allowProxyOi: true });
    expect(estimated.expiries[0]?.calls[0]).toMatchObject({
      openInterest: null, oiProvenance: { status: 'EXPLICIT_PROXY', nominalShares: proxy.nominalShares },
    });
    expect(estimated.exposureSummary).toMatchObject({
      gexStatus: proxy.gexStatus, trace: { directOiInputs: proxy.direct, proxyOiInputs: proxy.proxy, oiProxy: proxy.oiProxy },
    });
    expect((await arRuntime.getOptionsChain()).exposureSummary?.netGex).toBeNull();
    const surface = offlineRuntime([quote(), quote('GFGV6000DI'), quote('GFGC6200DI'), quote('GFGV5800DI')]);
    const withSurface = await surface.arRuntime.getOptionsChain();
    expect(withSurface.expiries[0]?.ivAtm).toEqual(expect.any(Number));
    expect(withSurface.exposureSummary?.netGex).toBeNull();
  });

  it.each(reference.a2ObservedZeroOiVsMissing)('distinguishes observed OI $value from unknown', async (sample) => {
    const { arRuntime } = offlineRuntime([{ ...quote(), open_interest: sample.value }]);
    const chain = await arRuntime.getOptionsChain();
    expect(chain.expiries[0]?.calls[0]).toMatchObject({ openInterest: sample.value, oiProvenance: { status: sample.status } });
    expect(chain.exposureSummary).toMatchObject({
      netGex: sample.netGex, gexStatus: sample.gexStatus,
      trace: { directOiInputs: sample.direct, observedZeroOiInputs: sample.zero, missingOiInputs: sample.missing },
      callWallStrike: null, putWallStrike: null,
    });
  });

  it('discloses partial coverage, rejected OI, and conflicts in comparable units', async () => {
    const sample = reference.gexPartialAndInvalid;
    const { arRuntime } = offlineRuntime([
      { ...quote(), open_interest: 150 },
      { ...quote('GFGV6000DI'), open_interest: 120 },
      quote('GFGC6200DI'),
      quote('GFGV6200DI'),
    ]);
    const partial = await arRuntime.getOptionsChain();
    expect(partial.exposureSummary).toMatchObject({
      gexStatus: sample.partial.gexStatus, oiCoverageRatio: sample.partial.coverage, isPartial: true,
      trace: { directOiInputs: sample.partial.direct, missingOiInputs: sample.partial.missing },
    });
    const invalid = classifyRawOiValue(sample.invalid.value, 'DATA912', now, standardMultiplier);
    expect(invalid).toMatchObject({ status: 'INVALID_OI', reason: sample.invalid.reason });
    expect(resolveArExposureOiQuality([{ oi: invalid, used: false }]).gexStatus).toBe(sample.invalid.gexStatus);
    const iamc: Extract<OiFieldProvenance, { status: 'IAMC_ANEXO_B' }> = {
      status: 'IAMC_ANEXO_B', source: 'IAMC_ANEXO_B', quality: 'OBSERVED', unit: 'SHARES', appliedMultiplier: 1,
      nominalShares: reference.a2SourceConflictPrecedence.iamc, contractualExpiry: december, reportDate, asOfUtcSec: now,
    };
    const direct = classifyRawOiValue(reference.a2SourceConflictPrecedence.data912Contracts, 'DATA912', now, standardMultiplier);
    if (direct.status !== 'DIRECT_CONTRACT_OI') throw new Error('Expected a valid reference OI observation');
    expect(resolveOiSourcePrecedence(direct, iamc)).toMatchObject({
      status: 'IAMC_ANEXO_B', conflict: { alternateValue: reference.a2SourceConflictPrecedence.data912Shares, unit: 'SHARES' },
    });
    expect(resolveOiSourcePrecedence(direct, { ...direct, nominalShares: direct.nominalShares + 100, contracts: direct.contracts + 1 }))
      .toMatchObject({ status: 'INVALID_OI', reason: 'SOURCE_CONFLICT' });
    const absent = missingOi('FIELD_ABSENT_IN_FEED');
    const before = mergeOptionFieldProvenance(absent, { volume: 250, ask: 420 }, 'DATA912', now);
    const after = mergeOptionFieldProvenance(absent, { volume: 5 }, 'BMB_HOMEBROKER_BRIDGE', now, before);
    expect(after.openInterest).toBe(before.openInterest);
    expect(after.ask).toBe(before.ask);
    expect(explicitVolumeOi(after.volume, standardMultiplier)?.nominalShares)
      .toBe(reference.a2ExplicitProxyOptIn.nominalShares);
  });

  it('preserves OPEN_BYMA source, avoids contradictory BMB provenance, and separates model failure from INVALID_OI', () => {
    const qRef = reference.a2OpenBymaAndModelFailQualityDelta;
    const openBymaRows = normalizeData912Rows([{ symbol: 'GGAL', c: 6000, timestamp: now }], 'OPEN_BYMA');
    expect(openBymaRows[0]).toMatchObject({ quoteSource: qRef.openBymaSource, quoteAsOfUtcSec: now });

    const bmbSnap: BmbBridgeSnapshotDto = {
      health: {
        status: 'READY', connected: true, passwordConfigured: true, brokerId: 153, accountLabel: null,
        pyhomebrokerInstalled: null, lastUpdateUtcSec: now, counts: { cauciones: 0, orderBooks: 0, options: 2 }, error: null,
      },
      cauciones: [], orderBooksBySymbol: {},
      options: [
        { symbol: 'GFGC6000DI', underlying: 'GGAL', last: 410, bid: 405, ask: 415, bidSize: 10, askSize: 10, volume: 12, turnover: null, varPct: null, asOfUtcSec: now },
        { symbol: 'GFGV6000DI', underlying: 'GGAL', last: 310, bid: 305, ask: 315, bidSize: 10, askSize: 10, volume: 8, turnover: null, varPct: null, asOfUtcSec: now },
      ],
    };
    const merged = mergeBmbOptionQuotes({
      trackFieldProvenance: true, underlying: 'GGAL', spotHint: 6000, nowUtcSec: now, bmbSnapshot: bmbSnap,
      rows: [
        {
          symbol: 'GFGC6000DI', last: 400, bid: 395, bidSize: 5, ask: 405, askSize: 5, prevClose: null, deltaPct: null,
          low: null, high: null, vwap: null, volumeArs: null, nominalVol: 20, mark: 400, impliedUsdArs: null,
          arsBid: null, arsAsk: null, usdBid: null, usdAsk: null, openInterest: 150, quoteSource: 'DATA912', quoteAsOfUtcSec: now,
        },
        {
          symbol: 'GFGV6000DI', last: 300, bid: 295, bidSize: 5, ask: 305, askSize: 5, prevClose: null, deltaPct: null,
          low: null, high: null, vwap: null, volumeArs: null, nominalVol: 15, mark: 300, impliedUsdArs: null,
          arsBid: null, arsAsk: null, usdBid: null, usdAsk: null, openInterest: null, quoteSource: 'DATA912', quoteAsOfUtcSec: now,
        },
      ],
    });
    expect(merged[0]).toMatchObject({ openInterest: 150, fieldProvenance: { openInterest: { status: 'DIRECT_CONTRACT_OI', contracts: 150 } } });
    expect(merged[1]).toMatchObject({ openInterest: null, fieldProvenance: { openInterest: { status: 'MISSING_OI' } } });

    const validDirect = classifyRawOiValue(150, 'DATA912', now, standardMultiplier);
    expect(resolveArExposureOiQuality([{ oi: validDirect, used: false }, { oi: validDirect, used: false }])).toMatchObject({
      gexStatus: qRef.modelFailGexStatus, oiQuality: qRef.modelFailOiQuality,
    });
    const proxyObs = explicitVolumeOi({ value: 5, source: 'BMB_HOMEBROKER_BRIDGE', asOfUtcSec: now, quality: 'OBSERVED' }, standardMultiplier);
    if (proxyObs === null) throw new Error('Expected proxy observation');
    const invalidObs = classifyRawOiValue(-5, 'DATA912', now, standardMultiplier);
    expect(resolveArExposureOiQuality([{ oi: proxyObs, used: true }, { oi: invalidObs, used: false }])).toMatchObject({
      gexStatus: qRef.proxyWithInvalidGexStatus, oiQuality: qRef.proxyWithInvalidOiQuality,
    });
  });

  it('isolates exposureSummaryByExpiry, per-expiry quantEngines, and chain-universe coverage in structurePinning', async () => {
    const gexRef = reference.gexPerExpiryIsolationDelta;
    for (const sample of [gexRef.di, gexRef.fe]) {
      const exp = computeDealerExposure([{
        contractType: 'call', strike: sample.strike, openInterest: sample.count, sharesPerContract: sample.multiplier,
        expiryUtcSec: now + sample.years * 31_536_000, iv: sample.volatility,
      }], { spot: sample.spot, nowUtcSec: now, rate: 0, dividendYield: 0 }, { model: 'bsm' });
      near(exp.netGex, sample.gex);
    }

    const buildChainQuotes = (feOi: number) => [
      { symbol: 'GFGC5800DI', v: 40, c: 450, px_bid: 440, px_ask: 460 },
      { symbol: 'GFGC6000DI', v: 80, c: 340, px_bid: 330, px_ask: 350, open_interest: gexRef.diContracts },
      { symbol: 'GFGC6200DI', v: 30, c: 230, px_bid: 220, px_ask: 240 },
      { symbol: 'GFGC5800FE', v: 25, c: 790, px_bid: 780, px_ask: 800 },
      { symbol: 'GFGC6000FE', v: 60, c: 670, px_bid: 660, px_ask: 680, open_interest: feOi },
      { symbol: 'GFGC6200FE', v: 20, c: 560, px_bid: 550, px_ask: 570 },
    ];
    const baseRun = offlineRuntime(buildChainQuotes(gexRef.feContracts));
    const baseChain = await baseRun.arRuntime.getOptionsChain();
    const diSummary = baseChain.exposureSummaryByExpiry?.['DI'];
    const feSummary = baseChain.exposureSummaryByExpiry?.['FE'];
    expect(diSummary?.trace?.engineExpirationDates).toEqual([december]);
    expect(feSummary?.trace?.engineExpirationDates).toEqual([february]);
    expect(diSummary?.quality?.usableOpenInterest).toBe(gexRef.diContracts);
    expect(feSummary?.quality?.usableOpenInterest).toBe(gexRef.feContracts);
    expect(diSummary?.netGex).not.toBe(baseChain.exposureSummary?.netGex);

    const altRun = offlineRuntime(buildChainQuotes(gexRef.feContracts * 3));
    const altChain = await altRun.arRuntime.getOptionsChain();
    expect(altChain.exposureSummaryByExpiry?.['DI']?.netGex).toBe(diSummary?.netGex);
    expect(altChain.quantEnginesByExpiry?.['DI']?.flowAdjustedGex?.totalSignedDollarGex)
      .toBe(baseChain.quantEnginesByExpiry?.['DI']?.flowAdjustedGex?.totalSignedDollarGex);
    expect(altChain.quantEnginesByExpiry?.['FE']?.flowAdjustedGex?.totalSignedDollarGex)
      .not.toBe(baseChain.quantEnginesByExpiry?.['FE']?.flowAdjustedGex?.totalSignedDollarGex);
    expect(altChain.quantEnginesByExpiry?.['DI']?.flowAdjustedGex?.totalSignedDollarGex).toEqual(expect.any(Number));

    const specialist = new GgalSpecialistRuntime({
      runtime: new MarketRuntime({ fetchFn: baseRun.fetchFn, nowMsFn: baseRun.nowMsFn }),
      arRuntime: baseRun.arRuntime, fetchFn: baseRun.fetchFn, nowMsFn: baseRun.nowMsFn,
    });
    specialist.ingestAnexoB({ asOfDate: reportDate, rawText: 'GFGC6000DI 100 200 0 0' });
    const pinning = await specialist.getStructurePinning(false, { targetExpiry: 'DI' });
    expect(pinning.gexStatus).toBe('PARTIAL_COVERAGE');
    near(pinning.oiCoverageRatio, gexRef.partialCoverageRatio);

    const failGamma = evaluateStructureAndPinning({
      asOfUtcSec: now, anexoBAsOfDate: reportDate,
      bymaEval: {
        asOfUtcSec: now, spot24hArs: 6000, expiryDateKey: december,
        expiry1530UtcSec: Date.UTC(2026, 11, 18, 18, 30) / 1_000,
        rateCurve: [{ days: 30, continuousRateAnnual: 0.28 }],
      },
      atmIvDecimal: 0.44,
      strikes: [{
        strikeArs: 6000, callOi: { coveredNom: 0, uncoveredNom: 200, oppositeNom: 0, crossedNom: 0 },
        putOi: zeroBuckets, callIvDecimal: Number.NaN, putIvDecimal: 0.44,
      }],
    });
    expect(failGamma.regime).toBe('NO_DATA');
    expect(Number.isNaN(failGamma.netEffectiveGexArsPer1Pct)).toBe(true);

    const allZero = evaluateStructureAndPinning({
      asOfUtcSec: now, anexoBAsOfDate: reportDate,
      bymaEval: {
        asOfUtcSec: now, spot24hArs: 6000, expiryDateKey: december,
        expiry1530UtcSec: Date.UTC(2026, 11, 18, 18, 30) / 1_000,
        rateCurve: [{ days: 30, continuousRateAnnual: 0.28 }],
      },
      atmIvDecimal: 0.44,
      strikes: [{
        strikeArs: 6000, callOi: zeroBuckets, putOi: zeroBuckets,
        callIvDecimal: 0.44, putIvDecimal: 0.44,
      }],
    });
    expect(allZero.regime).toBe('NO_DATA');
    expect(allZero.netEffectiveGexArsPer1Pct).toBe(0);
    expect(Number.isNaN(allZero.zeroGammaLevelArs)).toBe(true);
  });
});
