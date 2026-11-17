import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectIcebergReload, computeL2Microstructure } from '../src/core/ggal/l2AndRegimeEngines.js';
import {
  mergeBmbOptionQuotes,
  type NormalizedQuoteRow,
} from '../src/server/argentinaMarketLoader.js';
import {
  ArFeedRouter,
  type ArFeedRuntimeTelemetryInput,
} from '../src/server/arFeedRouter.js';
import {
  BmbFeedAdapter,
  BMB_MIN_POLL_INTERVAL_MS,
  bmbTradesToVpinInput,
  buildBmbIcebergTrackingResult,
  isBymaL2SessionUtcSec,
  type BmbBestQuoteObservation,
} from '../src/server/bmbFeedAdapter.js';
import type {
  BmbOptionRowDto,
  BmbTradeRowDto,
  OrderBook5LevelsDto,
} from '../src/server/primaryRofexLoader.js';

interface ReferenceFixture {
  readonly sessionCases: readonly { readonly utcSec: number; readonly expected: boolean }[];
  readonly optionMergeCase: {
    readonly nowUtcSec: number;
    readonly spotHint: number;
    readonly underlying: string;
    readonly rows: readonly NormalizedQuoteRow[];
    readonly quotes: readonly BmbOptionRowDto[];
    readonly expected: readonly NormalizedQuoteRow[];
  };
  readonly tradeCases: readonly BmbTradeRowDto[];
  readonly expectedVpinTrades: readonly unknown[];
  readonly icebergCase: {
    readonly previous: BmbBestQuoteObservation;
    readonly current: {
      readonly bidPrice: number;
      readonly bidSize: number;
      readonly askPrice: number;
      readonly askSize: number;
    };
    readonly expectedTracking: {
      readonly executedVolumeAtBid: number;
      readonly executedVolumeAtAsk: number;
      readonly lastTradeSequence: number;
    };
    readonly expectedSignal: unknown;
  };
  readonly bookCase: {
    readonly bids: OrderBook5LevelsDto['bids'];
    readonly asks: OrderBook5LevelsDto['asks'];
    readonly decayAlpha: number;
    readonly expected: {
      readonly obiL1: number;
      readonly obiMultiLevel: number;
      readonly micropriceL1: number;
      readonly micropriceMultiLevel: number;
      readonly totalBidDepth5: number;
      readonly totalAskDepth5: number;
    };
  };
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'fixtures/bmb_feed_reference.json'), 'utf8'),
) as ReferenceFixture;

const ENV = {
  BMB_DNI: 'fake_dni_774',
  BMB_USER: 'fake_user_775',
  BMB_PASS: 'fake_pass_776',
  BMB_COMITENTE: 'fake_account_777',
  BMB_BROKER_ID: '153',
} as const satisfies NodeJS.ProcessEnv;

function telemetry(asOfUtcSec: number): ArFeedRuntimeTelemetryInput {
  return {
    asOfUtcSec,
    primaryConfigured: true,
    primaryConnected: true,
    primaryLastMsgUtcSec: asOfUtcSec,
    primaryError: null,
    bmbConfigured: true,
    bmbConnected: true,
    bmbLastMsgUtcSec: asOfUtcSec,
    bmbError: null,
    bmbOutOfSession: false,
    ppiConfigured: false,
    ppiHealthy: false,
    ppiLastMsgUtcSec: null,
    ppiError: null,
    iolConfigured: false,
    iolHealthy: false,
    iolLastMsgUtcSec: null,
    iolError: null,
    maeConfigured: false,
    maeHealthy: false,
    maeLastMsgUtcSec: null,
    maeError: null,
    bymaClearingConfigured: false,
    bymaClearingHealthy: false,
    bymaClearingLastMsgUtcSec: null,
    bymaClearingError: null,
    anexoBLoaded: false,
    anexoBLastMsgUtcSec: null,
    anexoBError: null,
    data912Reachable: true,
    data912LastMsgUtcSec: asOfUtcSec,
    data912Error: null,
  };
}

function referenceBook(asOfUtcSec: number): OrderBook5LevelsDto {
  return {
    symbol: 'GGAL',
    marketSymbol: 'GGAL - 24hs',
    settlement: '24hs',
    marketState: 'LIVE',
    source: 'BMB_HOMEBROKER',
    asOfUtcSec,
    bids: fixture.bookCase.bids,
    asks: fixture.bookCase.asks,
    bestBid: fixture.bookCase.bids[0]?.price ?? null,
    bestAsk: fixture.bookCase.asks[0]?.price ?? null,
    mid: 6400,
    spreadArs: 2,
    spreadPct: 2 / 6400,
    bidDepthSize: 3000,
    askDepthSize: 5500,
    vwapBid5: null,
    vwapAsk5: null,
    vwapBook5: null,
    obi5: null,
    last: 6400,
    open: null,
    high: null,
    low: null,
    close: null,
    settlementPrice: null,
    nominalVolume: null,
  };
}

function bridgePayload(nowUtcSec: number): Record<string, unknown> {
  const book = referenceBook(nowUtcSec);
  return {
    status: 'READY',
    brokerId: 153,
    accountLabel: null,
    pyhomebrokerInstalled: true,
    passwordConfigured: true,
    asOfUtcSec: nowUtcSec,
    error: null,
    cauciones: [],
    orderBooksBySymbol: {
      GGAL: {
        symbol: 'GGAL',
        settlement: '24hs',
        bids: book.bids,
        asks: book.asks,
        asOfUtcSec: nowUtcSec,
        source: 'BMB_HOMEBROKER',
      },
    },
    options: [],
    tradesBySymbol: { GGAL: fixture.tradeCases },
  };
}

describe('BMB feed adapter independent reference parity', () => {
  it('matches ART session boundaries, option BBO overlay, real-trade VPIN inputs and iceberg tracking', () => {
    for (const testCase of fixture.sessionCases) {
      expect(isBymaL2SessionUtcSec(testCase.utcSec)).toBe(testCase.expected);
    }

    const c = fixture.optionMergeCase;
    const inputSnapshot = JSON.stringify(c.rows);
    const merged = mergeBmbOptionQuotes({
      rows: c.rows,
      underlying: c.underlying,
      spotHint: c.spotHint,
      nowUtcSec: c.nowUtcSec,
      bmbSnapshot: {
        health: {
          status: 'CONNECTED_L2',
          brokerId: 153,
          accountLabel: null,
          pyhomebrokerInstalled: true,
          passwordConfigured: true,
          connected: true,
          lastUpdateUtcSec: c.nowUtcSec,
          counts: { cauciones: 0, orderBooks: 1, options: c.quotes.length },
          error: null,
        },
        cauciones: [],
        orderBooksBySymbol: {},
        options: c.quotes,
      },
    });
    expect(JSON.stringify(c.rows)).toBe(inputSnapshot);
    expect(merged).toEqual(c.expected);
    expect(merged[0]?.openInterest).toBe(987654);
    expect(merged[2]?.openInterest).toBeNull();

    expect(bmbTradesToVpinInput(fixture.tradeCases)).toEqual(fixture.expectedVpinTrades);
    const tracked = buildBmbIcebergTrackingResult(
      fixture.icebergCase.previous,
      fixture.icebergCase.current,
      fixture.tradeCases,
    );
    expect(tracked.lastTradeSequence).toBe(fixture.icebergCase.expectedTracking.lastTradeSequence);
    expect(tracked.input?.executedVolumeAtBid).toBe(fixture.icebergCase.expectedTracking.executedVolumeAtBid);
    expect(tracked.input?.executedVolumeAtAsk).toBe(fixture.icebergCase.expectedTracking.executedVolumeAtAsk);
    expect(tracked.input === null ? null : detectIcebergReload(tracked.input)).toEqual(
      fixture.icebergCase.expectedSignal,
    );
  });

  it('prioritizes BMB over configured Primary and feeds exact five-level Motor 8 microprices', () => {
    const now = Math.floor(Date.UTC(2026, 10, 16, 15, 0, 0) / 1_000);
    const router = new ArFeedRouter({
      env: {
        ...ENV,
        PRIMARY_WS_URL: 'wss://primary.invalid',
        PRIMARY_PASSWORD: 'fake_primary_password',
      },
      nowMsFn: () => now * 1_000,
    });
    router.updateFromRuntimeTelemetry(telemetry(now));
    const status = router.getStatusSnapshot(now);
    expect(status.activePrimaryEquityProvider).toBe('BMB_HOMEBROKER_BRIDGE');
    expect(status.l2Available).toBe(true);
    const ladder = router.resolveL2LadderState('GGAL', referenceBook(now), now);
    expect(ladder.available).toBe(true);
    if (!ladder.available) {
      throw new Error('Expected BMB ladder');
    }
    expect(ladder.activeProvider).toBe('BMB_HOMEBROKER_BRIDGE');
    expect(ladder.bids).toHaveLength(5);
    expect(ladder.asks).toHaveLength(5);
    expect(ladder.bids[0]?.orderCount).toBe(8);
    const motor8 = computeL2Microstructure({
      ladder,
      decayAlpha: fixture.bookCase.decayAlpha,
      icebergInput: buildBmbIcebergTrackingResult(
        fixture.icebergCase.previous,
        fixture.icebergCase.current,
        fixture.tradeCases,
      ).input,
      vpinInput: null,
    });
    expect(motor8.status).toBe('OPERATIONAL');
    if (motor8.status !== 'OPERATIONAL') {
      throw new Error('Expected operational Motor 8');
    }
    for (const key of [
      'obiL1',
      'obiMultiLevel',
      'micropriceL1',
      'micropriceMultiLevel',
      'totalBidDepth5',
      'totalAskDepth5',
    ] as const) {
      expect(Math.abs(motor8[key] - fixture.bookCase.expected[key])).toBeLessThanOrEqual(1e-9);
    }
    expect(motor8.iceberg).toEqual(fixture.icebergCase.expectedSignal);
  });

  it('fails closed outside the session and degrades explicitly to Data912 EOD', () => {
    const sunday = Math.floor(Date.UTC(2026, 10, 15, 15, 0, 0) / 1_000);
    const router = new ArFeedRouter({ env: ENV, nowMsFn: () => sunday * 1_000 });
    router.updateFromRuntimeTelemetry({
      ...telemetry(sunday),
      primaryConnected: false,
      primaryLastMsgUtcSec: null,
      bmbConnected: false,
      bmbLastMsgUtcSec: null,
      bmbOutOfSession: true,
      bmbError: 'ARMED_OUT_OF_SESSION',
    });
    const status = router.getStatusSnapshot(sunday);
    const provider = status.providers.find((p) => p.provider === 'BMB_HOMEBROKER_BRIDGE');
    expect(provider?.configured).toBe(true);
    expect(provider?.errorReason).toBe('ARMED_OUT_OF_SESSION');
    expect(status.activePrimaryEquityProvider).toBe('DATA912_EOD_CONTINGENCY');
    const ladder = router.resolveL2LadderState('GGAL', null, sunday);
    expect(ladder).toMatchObject({ available: false, reason: 'OUT_OF_SESSION' });
  });

  it('enforces >=1.5s global polling, normalizes CONNECTED_L2 and emits no live book out of session', async () => {
    let nowMs = Date.UTC(2026, 10, 16, 15, 0, 0);
    let requests = 0;
    const adapter = new BmbFeedAdapter({
      env: ENV,
      manageProcess: false,
      nowMsFn: () => nowMs,
      fetchFn: () => {
        requests += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify(bridgePayload(Math.floor(nowMs / 1_000))),
          headers: {},
        });
      },
    });
    const first = await adapter.getSnapshot('GGAL');
    expect(first.health.status).toBe('CONNECTED_L2');
    expect(first.orderBooksBySymbol['GGAL']?.bids).toHaveLength(5);
    expect(first.tradesBySymbol?.['GGAL']).toHaveLength(4);
    await adapter.getSnapshot('GGAL', null, true);
    expect(requests).toBe(1);
    nowMs += BMB_MIN_POLL_INTERVAL_MS - 1;
    await adapter.getSnapshot('GGAL', null, true);
    expect(requests).toBe(1);
    nowMs += 1;
    await adapter.getSnapshot('GGAL', null, true);
    expect(requests).toBe(2);

    nowMs = Date.UTC(2026, 10, 15, 15, 0, 0);
    const closed = await adapter.getSnapshot('GGAL', null, true);
    expect(requests).toBe(2);
    expect(closed.health.status).toBe('OUT_OF_SESSION');
    expect(closed.health.error).toBe('ARMED_OUT_OF_SESSION');
    expect(closed.orderBooksBySymbol).toEqual({});
    expect(closed.options).toEqual([]);
    adapter.stop();
  });

  it('redacts every BMB credential alias in Node snapshots', async () => {
    const adapter = new BmbFeedAdapter({
      env: ENV,
      manageProcess: false,
      nowMsFn: () => Date.UTC(2026, 10, 16, 15, 0, 0),
      fetchFn: () => Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          status: 'ERROR',
          asOfUtcSec: null,
          error: `login failed ${ENV.BMB_USER} ${ENV.BMB_PASS} ${ENV.BMB_DNI} ${ENV.BMB_COMITENTE}`,
          cauciones: [],
          orderBooksBySymbol: {},
          options: [],
        }),
        headers: {},
      }),
    });
    const snapshot = await adapter.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    for (const secret of [ENV.BMB_USER, ENV.BMB_PASS, ENV.BMB_DNI]) {
      expect(serialized).not.toContain(secret);
    }
    expect(snapshot.health.error).not.toContain(ENV.BMB_COMITENTE);
  });

  it('surfaces bridge-reported STANDBY_2FA as an explicit non-connected status', async () => {
    const standbyMessage =
      'BMB requiere 2FA interactivo (SMS/App); usando IOL_REST_V2 + Primary DLR como fuente activa';
    const adapter = new BmbFeedAdapter({
      env: ENV,
      manageProcess: false,
      nowMsFn: () => Date.UTC(2026, 10, 16, 15, 0, 0),
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'STANDBY_2FA',
            brokerId: 153,
            accountLabel: null,
            pyhomebrokerInstalled: true,
            passwordConfigured: true,
            asOfUtcSec: null,
            error: standbyMessage,
            cauciones: [],
            orderBooksBySymbol: {},
            options: [],
          }),
          headers: {},
        }),
    });
    const snapshot = await adapter.getSnapshot();
    expect(snapshot.health.status).toBe('STANDBY_2FA');
    expect(snapshot.health.connected).toBe(false);
    expect(snapshot.health.error).toBe(standbyMessage);
    expect(adapter.getSafeHealthStatus().status).toBe('STANDBY_2FA');
    adapter.stop();
  });
});
