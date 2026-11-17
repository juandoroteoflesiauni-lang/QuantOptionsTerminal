/** AR realtime composition: BMB L2/real trades first, IOL REST v2 L1 fallback. */

import type { BmbFeedAdapter } from './bmbFeedAdapter.js';
import type { IolCaucionQuote, IolFeedAdapter } from './iolFeedAdapter.js';
import type { MarketTickQuote } from './massiveStocksStream.js';
import type { PrimaryDlrContractDto, PrimaryRofexClient } from './primaryRofexLoader.js';

export function realtimeQuoteKey(symbol: string, settlement?: string | null): string {
  const cleanSettlement = typeof settlement === 'string' ? settlement.trim().toUpperCase() : '';
  return cleanSettlement === '' || cleanSettlement === '24HS' || cleanSettlement === 'T1'
    ? `${symbol.trim().toUpperCase()}|24`
    : `${symbol.trim().toUpperCase()}|${cleanSettlement}`;
}

export type ArRealtimeSourceMode = 'LIVE_PRIMARY' | 'LIVE_BMB' | 'LIVE_IOL' | 'NO_DATA';

export interface ArRealtimeBusCaucion extends IolCaucionQuote {
  readonly source: 'IOL_REST' | 'PRIMARY_ECO_WS';
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
  private readonly injectedQuotes = new Map<string, MarketTickQuote>();
  private readonly injectedFutures = new Map<string, PrimaryDlrContractDto>();
  private readonly injectedCauciones = new Map<string, ArRealtimeBusCaucion>();

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

  /** Explicit ingestion point for normalized AR ticks (test harnesses and adapters). */
  public ingestQuotes(quotes: readonly MarketTickQuote[]): void {
    for (const quote of quotes) {
      if (quote.market !== 'AR' || typeof quote.symbol !== 'string' || quote.symbol.trim() === '') continue;
      if (!Number.isFinite(quote.price) || quote.price <= 0) continue;
      const symbol = quote.symbol.trim().toUpperCase();
      this.injectedQuotes.set(realtimeQuoteKey(symbol, quote.settlement), { ...quote, symbol });
    }
  }

  /** Pieza 41: cauciones primarias por plazo; nunca inventa turnover/tasa. */
  public ingestCauciones(rows: readonly ArRealtimeBusCaucion[]): void {
    for (const row of rows) {
      if (!Number.isFinite(row.termDays) || row.termDays <= 0) continue;
      if (row.tnaWeighted === null || !Number.isFinite(row.tnaWeighted)) continue;
      const key = `${row.currency}:${String(row.termDays)}`;
      this.injectedCauciones.set(key, { ...row, source: 'PRIMARY_ECO_WS' });
    }
  }

  /** Explicit ingestion point for normalized DLR futures derived from real WS ticks. */
  public ingestFutures(futures: readonly PrimaryDlrContractDto[]): void {
    for (const contract of futures) {
      if (typeof contract.contract !== 'string' || contract.contract.trim() === '') continue;
      const key = contract.contract.trim().toUpperCase();
      this.injectedFutures.set(key, { ...contract, contract: key });
    }
  }

  public getQuotes(): readonly MarketTickQuote[] {
    const nowSec = Math.floor(this.nowMsFn() / 1_000);
    const byKey = new Map<string, MarketTickQuote>();
    const setQuote = (quote: MarketTickQuote): void => {
      byKey.set(realtimeQuoteKey(quote.symbol, quote.settlement), quote);
    };
    for (const quote of this.iolClient.getQuotes()) {
      setQuote(quote);
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
        const base = byKey.get(realtimeQuoteKey(symbol, null));
        setQuote({
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
    for (const quote of this.injectedQuotes.values()) {
      const existing = byKey.get(realtimeQuoteKey(quote.symbol, quote.settlement));
      // Una observación primaria no pisa una trade BMB más nueva.
      if (
        existing?.source === 'BMB_HOMEBROKER' &&
        existing.asOfUtcSec !== null &&
        quote.asOfUtcSec !== null &&
        quote.asOfUtcSec < existing.asOfUtcSec
      ) {
        continue;
      }
      setQuote(quote);
    }
    return [...byKey.values()].map((quote) => ({ ...quote }));
  }

  public getCauciones(): readonly ArRealtimeBusCaucion[] {
    const byKey = new Map<string, ArRealtimeBusCaucion>();
    for (const row of this.injectedCauciones.values()) {
      byKey.set(`${row.currency}:${String(row.termDays)}`, row);
    }
    for (const row of this.iolClient.getCauciones()) {
      const key = `${row.currency}:${String(row.termDays)}`;
      if (!byKey.has(key)) byKey.set(key, { ...row, source: 'IOL_REST' });
    }
    return [...byKey.values()].map((row) => ({ ...row }));
  }

  /** DLR/* futures derived from the last Primary WS `Md` ticks (empty until first tick). */
  public getFutures(): readonly PrimaryDlrContractDto[] {
    const byContract = new Map<string, PrimaryDlrContractDto>();
    for (const contract of this.injectedFutures.values()) {
      byContract.set(contract.contract, contract);
    }
    for (const contract of this.primaryClient?.getLiveDlrFutures() ?? []) {
      if (!byContract.has(contract.contract)) {
        byContract.set(contract.contract, contract);
      }
    }
    return [...byContract.values()];
  }

  public getBmbSnapshot(): ReturnType<BmbFeedAdapter['getCachedSnapshot']> {
    return this.bmbClient?.getCachedSnapshot() ?? null;
  }

  public getSourceMode(): ArRealtimeSourceMode {
    const quotes = this.getQuotes();
    if (quotes.some((quote) => quote.source === 'PRIMARY_ECO_WS')) return 'LIVE_PRIMARY';
    if (this.injectedCauciones.size > 0) return 'LIVE_PRIMARY';
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
