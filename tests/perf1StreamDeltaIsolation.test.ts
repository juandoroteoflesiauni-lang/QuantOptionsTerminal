import { afterEach, describe, expect, it } from 'vitest';
import { FmpEnterpriseClient } from '../src/server/fmpClient.js';

interface MarketViewScopeLike {
  readonly view: string;
  readonly focusSymbol: string | null;
  readonly focusMarket: 'AR' | 'US' | null;
  readonly ggalMode?: 'ADR' | 'ARS' | 'CCL' | null;
  readonly ggalTimeframe?: string | null;
}

interface StreamSnapshotLike {
  readonly quotesBySymbol: Readonly<Record<string, { readonly price: number } | undefined>>;
}

interface StreamApiLike {
  readonly __testApplyMarketStreamFrame: (rawFrame: Record<string, unknown>) => boolean;
  readonly __testGetMarketStreamStateSnapshot: () => StreamSnapshotLike;
  readonly __testResetMarketStreamState: () => void;
  readonly __testSubscribeStateCommits: (listener: () => void) => () => void;
  readonly getCurrentMarketViewScope: () => MarketViewScopeLike | null;
  readonly setMarketViewScope: (scope: MarketViewScopeLike) => void;
}

const streamSpecifier = '../web/src/api/useMarketLiveStream';
const {
  __testApplyMarketStreamFrame,
  __testGetMarketStreamStateSnapshot,
  __testResetMarketStreamState,
  __testSubscribeStateCommits,
  getCurrentMarketViewScope,
  setMarketViewScope,
} = (await import(/* @vite-ignore */ streamSpecifier)) as unknown as StreamApiLike;

describe('Perf-1 Stream Delta Isolation & Bounded FMP Pagination', () => {
  afterEach(() => {
    __testResetMarketStreamState();
  });

  it('seed de 200 símbolos: 20 deltas vacíos producen 0 commits y 1 quote cambiada actualiza solo ese símbolo', () => {
    __testResetMarketStreamState();

    const seedQuotes = Array.from({ length: 200 }, (_, idx) => ({
      market: idx < 40 ? 'AR' : 'US',
      symbol: `SYM${String(idx).padStart(3, '0')}`,
      price: 100 + idx,
      previousClose: 100 + idx,
      changePct: 0,
      volume: 1_000 + idx,
      asOfUtcSec: 1_760_000_000,
    }));

    const seeded = __testApplyMarketStreamFrame({
      type: 'MARKET_TICK_BATCH',
      sequence: 1,
      serverTimeSec: 1_760_000_000,
      arSourceMode: 'LIVE_PRIMARY',
      usSourceMode: 'TRADIER_WS',
      cclMedian: 1_200,
      mepMedian: 1_180,
      quotes: seedQuotes,
    });
    expect(seeded).toBe(true);
    const baselineSnapshot = __testGetMarketStreamStateSnapshot();
    expect(Object.keys(baselineSnapshot.quotesBySymbol)).toHaveLength(200);

    let commitCount = 0;
    const unsub = __testSubscribeStateCommits(() => {
      commitCount += 1;
    });
    try {
      // 20 TICK_DELTA vacíos
      for (let rev = 1; rev <= 20; rev += 1) {
        const ok = __testApplyMarketStreamFrame({
          type: 'TICK_DELTA',
          deltaRevision: rev,
          serverTimeSec: 1_760_000_000 + rev,
          arSourceMode: 'LIVE_PRIMARY',
          usSourceMode: 'TRADIER_WS',
          cclMedian: 1_200,
          mepMedian: 1_180,
          quotes: [],
          removed: [],
        });
        expect(ok).toBe(true);
      }

      // 20 market_batch vacíos (applyTickDeltaSequence)
      for (let rev = 21; rev <= 40; rev += 1) {
        const ok = __testApplyMarketStreamFrame({
          type: 'market_batch',
          serverTimeSec: 1_760_000_000 + rev,
          events: [],
          delta: {
            type: 'TICK_DELTA',
            deltaRevision: rev,
            serverTimeSec: 1_760_000_000 + rev,
            arSourceMode: 'LIVE_PRIMARY',
            usSourceMode: 'TRADIER_WS',
            cclMedian: 1_200,
            mepMedian: 1_180,
            quotes: [],
            removed: [],
          },
        });
        expect(ok).toBe(true);
      }

      expect(commitCount).toBe(0);
      expect(__testGetMarketStreamStateSnapshot()).toBe(baselineSnapshot);

      // 1 delta real sobre un símbolo actualiza solo ese símbolo con 1 commit.
      const updated = __testApplyMarketStreamFrame({
        type: 'TICK_DELTA',
        deltaRevision: 41,
        serverTimeSec: 1_760_000_041,
        arSourceMode: 'LIVE_PRIMARY',
        usSourceMode: 'TRADIER_WS',
        cclMedian: 1_200,
        mepMedian: 1_180,
        quotes: [
          {
            market: 'US',
            symbol: 'SYM050',
            price: 255.75,
            previousClose: 150,
            changePct: 70.5,
            volume: 2_500,
            asOfUtcSec: 1_760_000_041,
          },
        ],
      });
      expect(updated).toBe(true);
      expect(commitCount).toBe(1);

      const afterSnapshot = __testGetMarketStreamStateSnapshot();
      expect(afterSnapshot.quotesBySymbol['US:SYM050']?.price).toBe(255.75);
      expect(afterSnapshot.quotesBySymbol['US:SYM051']).toBe(baselineSnapshot.quotesBySymbol['US:SYM051']);
      expect(afterSnapshot.quotesBySymbol['AR:SYM000']).toBe(baselineSnapshot.quotesBySymbol['AR:SYM000']);
    } finally {
      unsub();
    }
  });

  it('setMarketViewScope preserva ggalMode/ggalTimeframe cuando ggalMode es undefined dentro de ggal_specialist y limpia al salir', () => {
    setMarketViewScope({
      view: 'ggal_specialist',
      focusSymbol: 'GGAL',
      focusMarket: 'AR',
      ggalMode: 'ADR',
      ggalTimeframe: '5m',
    });
    expect(getCurrentMarketViewScope()).toEqual({
      view: 'ggal_specialist',
      focusSymbol: 'GGAL',
      focusMarket: 'AR',
      ggalMode: 'ADR',
      ggalTimeframe: '5m',
    });

    // App.tsx re-emitiendo scope sin ggalMode/ggalTimeframe dentro de ggal_specialist
    setMarketViewScope({
      view: 'ggal_specialist',
      focusSymbol: 'GGAL',
      focusMarket: 'AR',
    });
    expect(getCurrentMarketViewScope()).toEqual({
      view: 'ggal_specialist',
      focusSymbol: 'GGAL',
      focusMarket: 'AR',
      ggalMode: 'ADR',
      ggalTimeframe: '5m',
    });

    // Al cambiar de vista, limpia ggalMode/ggalTimeframe
    setMarketViewScope({
      view: 'home',
      focusSymbol: null,
      focusMarket: null,
    });
    expect(getCurrentMarketViewScope()).toEqual({
      view: 'home',
      focusSymbol: null,
      focusMarket: null,
    });
  });

  it('FmpEnterpriseClient.fetchHistoricalPaginated mantiene concurrencia acotada <= 3 y orden temporal estricto', async () => {
    const toUtcSec = Math.floor(Date.UTC(2025, 6, 1, 18, 0, 0) / 1_000);
    const fromUtcSec = toUtcSec - 300 * 86_400; // >= 9 ventanas de 1h
    let active = 0;
    let maxActive = 0;
    let totalCalls = 0;

    const client = new FmpEnterpriseClient({
      config: {
        apiKey: 'TEST_FMP_KEY',
        quotesApiKey: null,
        marketApiKey: null,
        etfApiKey: null,
        macroApiKey: null,
        calendarsApiKey: null,
        configured: true,
        baseUrl: 'https://financialmodelingprep.com/stable',
      },
      nowMsFn: () => toUtcSec * 1_000,
      secrets: ['TEST_FMP_KEY'],
      fetchFn: async (url) => {
        totalCalls += 1;
        active += 1;
        if (active > maxActive) maxActive = active;
        try {
          const parsedUrl = new URL(url);
          const fromDate = parsedUrl.searchParams.get('from') ?? '2025-01-01';
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return {
            ok: true,
            status: 200,
            text: JSON.stringify([
              {
                date: `${fromDate} 10:00:00`,
                open: 100,
                high: 102,
                low: 99,
                close: 101,
                volume: 5_000,
              },
            ]),
          };
        } finally {
          active -= 1;
        }
      },
    });

    const result = await client.fetchHistoricalPaginated({
      symbol: 'SPY',
      timeframe: '1h',
      fromUtcSec,
      toUtcSec,
      includeExtended: false,
      maxEmptyWindows: 20,
    });

    expect(totalCalls).toBeGreaterThanOrEqual(4);
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(result.bars.length).toBeGreaterThan(1);
    for (let i = 1; i < result.bars.length; i += 1) {
      const cur = result.bars[i];
      const prev = result.bars[i - 1];
      if (cur === undefined || prev === undefined) {
        throw new Error(`Expected bars at index ${String(i)}`);
      }
      expect(cur.time).toBeGreaterThan(prev.time);
    }
  });
});
