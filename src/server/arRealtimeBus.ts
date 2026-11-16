/** AR realtime composition: BMB L2/real trades first, IOL REST v2 L1 fallback. */

import type { BmbFeedAdapter } from './bmbFeedAdapter.js';
import type { IolCaucionQuote, IolFeedAdapter } from './iolFeedAdapter.js';
import type { MarketTickQuote } from './massiveStocksStream.js';
import type { PrimaryDlrContractDto, PrimaryRofexClient } from './primaryRofexLoader.js';

export type ArRealtimeSourceMode = 'LIVE_BMB' | 'LIVE_IOL' | 'NO_DATA';

export interface ArRealtimeBusCaucion extends IolCaucionQuote {
  readonly source: 'IOL_REST';
}

export interface ArRealtimeBusDeps {
  readonly bmbClient: BmbFeedAdapter | null;
  readonly iolClient: IolFeedAdapter;
  readonly primaryClient?: PrimaryRofexClient | null;
  readonly nowMsFn?: () => number;
}

export class ArRealtimeBus {
  private readonly bmbClient: BmbFeedAdapter | null;
  private readonly iolClient: IolFeedAdapter;
  private readonly primaryClient: PrimaryRofexClient | null;
  private readonly nowMsFn: () => number;

  public constructor(deps: ArRealtimeBusDeps) {
    this.bmbClient = deps.bmbClient;
    this.iolClient = deps.iolClient;
    this.primaryClient = deps.primaryClient ?? null;
    this.nowMsFn = deps.nowMsFn ?? (() => Date.now());
  }

  public start(symbols: readonly string[]): void {
    this.bmbClient?.startLiveLoop(symbols);
    this.iolClient.start();
  }

  public stop(): void {
    this.bmbClient?.stop();
    this.iolClient.stop();
  }

  public getQuotes(): readonly MarketTickQuote[] {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const bySymbol = new Map<string, MarketTickQuote>();
    for (const quote of this.iolClient.getQuotes()) {
      bySymbol.set(quote.symbol, quote);
    }
    const snapshot = this.bmbClient?.getCachedSnapshot() ?? null;
    if (snapshot !== null && snapshot.health.connected) {
      for (const [rawSymbol, trades] of Object.entries(snapshot.tradesBySymbol ?? {})) {
        const symbol = rawSymbol.toUpperCase();
        let latest: (typeof trades)[number] | null = null;
        for (const trade of trades) {
          if (
            !Number.isInteger(trade.timeSec) ||
            trade.timeSec <= 0 ||
            nowSec < trade.timeSec ||
            nowSec - trade.timeSec > 20 ||
            !Number.isFinite(trade.price) ||
            trade.price <= 0
          ) {
            continue;
          }
          if (latest === null || trade.timeSec > latest.timeSec || (trade.timeSec === latest.timeSec && trade.sequence > latest.sequence)) {
            latest = trade;
          }
        }
        if (latest === null) continue;
        const base = bySymbol.get(symbol);
        bySymbol.set(symbol, {
          market: 'AR',
          symbol,
          kind: base?.kind ?? 'stock',
          currency: base?.currency ?? 'ARS',
          price: latest.price,
          previousClose: base?.previousClose ?? null,
          changePct:
            base?.previousClose !== null && base?.previousClose !== undefined && base.previousClose > 0
              ? ((latest.price - base.previousClose) / base.previousClose) * 100
              : null,
          dayLow: base?.dayLow !== null && base?.dayLow !== undefined ? Math.min(base.dayLow, latest.price) : null,
          dayHigh: base?.dayHigh !== null && base?.dayHigh !== undefined ? Math.max(base.dayHigh, latest.price) : null,
          volume: base?.volume ?? null,
          turnover: base?.turnover ?? null,
          asOfUtcSec: latest.timeSec,
          source: 'BMB_HOMEBROKER',
        });
      }
    }
    return [...bySymbol.values()].map((quote) => ({ ...quote }));
  }

  public getCauciones(): readonly ArRealtimeBusCaucion[] {
    return this.iolClient.getCauciones().map((row) => ({ ...row, source: 'IOL_REST' }));
  }

  /** DLR/* futures derived from the last Primary WS `Md` ticks (empty until first tick). */
  public getFutures(): readonly PrimaryDlrContractDto[] {
    return this.primaryClient?.getLiveDlrFutures() ?? [];
  }

  public getBmbSnapshot(): ReturnType<BmbFeedAdapter['getCachedSnapshot']> {
    return this.bmbClient?.getCachedSnapshot() ?? null;
  }

  public getSourceMode(): ArRealtimeSourceMode {
    const quotes = this.getQuotes();
    if (quotes.some((quote) => quote.source === 'BMB_HOMEBROKER')) return 'LIVE_BMB';
    if (quotes.some((quote) => quote.source === 'IOL_REST')) return 'LIVE_IOL';
    return 'NO_DATA';
  }

  public getHealth(): {
    readonly bmb: ReturnType<BmbFeedAdapter['getSafeHealthStatus']> | null;
    readonly iol: ReturnType<IolFeedAdapter['getHealth']>;
  } {
    return {
      bmb: this.bmbClient?.getSafeHealthStatus() ?? null,
      iol: this.iolClient.getHealth(),
    };
  }
}
