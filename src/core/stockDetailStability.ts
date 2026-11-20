/**
 * Pieza 43: utilidades puras de estabilidad UI, libro L2, normalización BID/ASK
 * y estado global de conectividad.
 *
 * Sin red, sin UI y sin mutar argumentos; verificado contra referencia Python
 * independiente en `tools/gen_stock_detail_stability_reference.py` (< 1e-9).
 */

export type StockPickerCategory = 'US_STOCKS' | 'PANEL_LIDER' | 'PANEL_GENERAL' | 'CEDEARS';

export interface StockPickerTransitionInput {
  readonly wasOpen: boolean;
  readonly isOpen: boolean;
  readonly currentCategory: StockPickerCategory;
  readonly selectedCategory: StockPickerCategory;
  readonly currentQuery: string;
  readonly currentActiveIndex: number;
  readonly filteredLength: number;
  readonly selectedItemIndex: number;
}

export interface StockPickerTransitionOutput {
  readonly activeCategory: StockPickerCategory;
  readonly query: string;
  readonly activeIndex: number;
  readonly shouldFocusInput: boolean;
}

/**
 * Sincroniza la pestaña activa del selector de acciones únicamente en la
 * transición `closed -> open`. Con el modal abierto, las actualizaciones en
 * vivo nunca resetean la pestaña elegida por el usuario ni borran la búsqueda.
 */
export function resolveStockPickerOnOpenTransition(
  input: StockPickerTransitionInput,
): StockPickerTransitionOutput {
  if (!input.wasOpen && input.isOpen) {
    return {
      activeCategory: input.selectedCategory,
      query: '',
      activeIndex: input.selectedItemIndex >= 0 ? input.selectedItemIndex : 0,
      shouldFocusInput: true,
    };
  }
  if (input.wasOpen && input.isOpen) {
    const safeIndex =
      input.filteredLength > 0
        ? Math.min(Math.max(0, Math.floor(input.currentActiveIndex)), input.filteredLength - 1)
        : 0;
    return {
      activeCategory: input.currentCategory,
      query: input.currentQuery,
      activeIndex: safeIndex,
      shouldFocusInput: false,
    };
  }
  return {
    activeCategory: input.currentCategory,
    query: '',
    activeIndex: 0,
    shouldFocusInput: false,
  };
}

export interface RawOrderBookLevelInput {
  readonly price?: number | null;
  readonly size?: number | null;
  readonly orderCount?: number | null;
}

export interface NormalizedStockDetailL2Level {
  readonly price: number;
  readonly size: number;
  readonly orderCount?: number;
}

export interface NormalizedStockDetailBook {
  readonly bids: readonly NormalizedStockDetailL2Level[];
  readonly asks: readonly NormalizedStockDetailL2Level[];
  readonly bestBid: number | null;
  readonly bestBidSize: number | null;
  readonly bestAsk: number | null;
  readonly bestAskSize: number | null;
  readonly spreadAbs: number;
  readonly spreadPct: number;
  readonly mid: number;
  readonly obi5: number;
}

function posFiniteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function normalizeL2Side(
  raw: readonly RawOrderBookLevelInput[],
  direction: 'BID' | 'ASK',
  limit: number,
): readonly NormalizedStockDetailL2Level[] {
  const clean: NormalizedStockDetailL2Level[] = [];
  for (const level of raw) {
    const price = posFiniteOrNull(level.price);
    if (price === null) continue;
    const size =
      level.size !== null &&
      level.size !== undefined &&
      Number.isFinite(level.size) &&
      level.size >= 0
        ? level.size
        : 0;
    const orderCount =
      level.orderCount !== null &&
      level.orderCount !== undefined &&
      Number.isInteger(level.orderCount) &&
      level.orderCount >= 0
        ? level.orderCount
        : null;
    clean.push({
      price,
      size,
      ...(orderCount !== null ? { orderCount } : {}),
    });
  }
  clean.sort((a, b) => (direction === 'BID' ? b.price - a.price : a.price - b.price));
  return clean.slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Filtra niveles sin precio válido (`price > 0`), ordena 5 puntas (Bid desc,
 * Ask asc) y calcula Spread en moneda y `% = ((bestAsk - bestBid) / bestAsk) * 100`.
 */
export function normalizeStockDetailOrderBook(
  bidsRaw: readonly RawOrderBookLevelInput[],
  asksRaw: readonly RawOrderBookLevelInput[],
  maxLevels = 5,
): NormalizedStockDetailBook {
  const bids = normalizeL2Side(bidsRaw, 'BID', maxLevels);
  const asks = normalizeL2Side(asksRaw, 'ASK', maxLevels);

  const topBid = bids[0];
  const topAsk = asks[0];
  const bestBid = topBid?.price ?? null;
  const bestBidSize = topBid !== undefined && topBid.size > 0 ? topBid.size : null;
  const bestAsk = topAsk?.price ?? null;
  const bestAskSize = topAsk !== undefined && topAsk.size > 0 ? topAsk.size : null;

  const hasValidTwoSided =
    bestBid !== null && bestAsk !== null && bestAsk >= bestBid && bestAsk > 0;
  const spreadAbs = hasValidTwoSided ? bestAsk - bestBid : Number.NaN;
  const spreadPct = hasValidTwoSided ? ((bestAsk - bestBid) / bestAsk) * 100 : Number.NaN;
  const mid = hasValidTwoSided ? 0.5 * (bestBid + bestAsk) : Number.NaN;

  const bidDepth = bids.reduce((acc, lvl) => acc + lvl.size, 0);
  const askDepth = asks.reduce((acc, lvl) => acc + lvl.size, 0);
  const totalDepth = bidDepth + askDepth;
  const obi5 = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : Number.NaN;

  return {
    bids,
    asks,
    bestBid,
    bestBidSize,
    bestAsk,
    bestAskSize,
    spreadAbs,
    spreadPct,
    mid,
    obi5,
  };
}

export interface NormalizedStockDetailHeaderQuotesInput {
  readonly quoteBid?: number | null;
  readonly quoteBidSize?: number | null;
  readonly quoteAsk?: number | null;
  readonly quoteAskSize?: number | null;
  readonly book: NormalizedStockDetailBook | null;
}

export interface NormalizedStockDetailHeaderQuotes {
  readonly bid: number | null;
  readonly bidSize: number | null;
  readonly ask: number | null;
  readonly askSize: number | null;
  readonly spreadAbs: number;
  readonly spreadPct: number;
}

/**
 * Normaliza puntas de cabecera desde el snapshot L1 + fallback al mejor nivel
 * válido L2. Nunca conserva cantidades huérfanas cuando el precio falta.
 */
export function normalizeStockDetailHeaderQuotes(
  input: NormalizedStockDetailHeaderQuotesInput,
): NormalizedStockDetailHeaderQuotes {
  const rawBid = posFiniteOrNull(input.quoteBid);
  const rawBidSize = posFiniteOrNull(input.quoteBidSize);
  let bid: number | null = null;
  let bidSize: number | null = null;
  if (rawBid !== null) {
    bid = rawBid;
    bidSize =
      rawBidSize ??
      (input.book !== null &&
      input.book.bestBid !== null &&
      Math.abs(input.book.bestBid - rawBid) <= 1e-9
        ? input.book.bestBidSize
        : null);
  } else if (input.book !== null && input.book.bestBid !== null) {
    bid = input.book.bestBid;
    bidSize = input.book.bestBidSize;
  }

  const rawAsk = posFiniteOrNull(input.quoteAsk);
  const rawAskSize = posFiniteOrNull(input.quoteAskSize);
  let ask: number | null = null;
  let askSize: number | null = null;
  if (rawAsk !== null) {
    ask = rawAsk;
    askSize =
      rawAskSize ??
      (input.book !== null &&
      input.book.bestAsk !== null &&
      Math.abs(input.book.bestAsk - rawAsk) <= 1e-9
        ? input.book.bestAskSize
        : null);
  } else if (input.book !== null && input.book.bestAsk !== null) {
    ask = input.book.bestAsk;
    askSize = input.book.bestAskSize;
  }

  let spreadAbs = Number.NaN;
  let spreadPct = Number.NaN;
  if (bid !== null && ask !== null && ask >= bid && ask > 0) {
    spreadAbs = ask - bid;
    spreadPct = ((ask - bid) / ask) * 100;
  }

  return {
    bid,
    bidSize: bid === null ? null : bidSize,
    ask,
    askSize: ask === null ? null : askSize,
    spreadAbs,
    spreadPct,
  };
}

/**
 * Formatea un lado BID/ASK garantizando que jamás se muestre `— 50 u.` cuando
 * falta el precio válido.
 */
export function formatHeaderSideQuote(
  price: number | null,
  size: number | null,
  formatPrice: (n: number) => string,
  formatSize: (n: number) => string,
): string {
  const validPrice = posFiniteOrNull(price);
  if (validPrice === null) {
    return '—';
  }
  const validSize = posFiniteOrNull(size);
  if (validSize !== null) {
    return `${formatPrice(validPrice)} (${formatSize(validSize)} u.)`;
  }
  return formatPrice(validPrice);
}

export type GlobalConnectivityTone = 'LIVE' | 'EOD' | 'PARTIAL' | 'OFFLINE';

export interface GlobalConnectivityProviderInput {
  readonly id: string;
  readonly state: string;
  readonly configured: boolean;
}

export interface GlobalConnectivityStatusInput {
  readonly isBackendConnected: boolean;
  readonly feedStatus: 'LIVE' | 'EOD_CIERRE' | 'DIFERIDO_20M' | 'PARTIAL' | 'NO_DATA';
  readonly streamFresh?: boolean;
  readonly providers?: readonly GlobalConnectivityProviderInput[];
}

export interface GlobalConnectivityStatusOutput {
  readonly tone: GlobalConnectivityTone;
  readonly label: string;
  readonly operationalActiveCount: number;
  readonly degradedOperationalCount: number;
}

/**
 * Resuelve el estado global de conectividad del header sin degradarlo por
 * proveedores en standby legítimo (`STANDBY_TRADIER_FMP_PRIMARY`) ni por
 * `TRADIER_LIVE_WS` en `AUTH_INVALID` cuando los motores operativos (FMP,
 * Massive REST, Eco Primary) siguen conectados.
 */
export function resolveGlobalConnectivityStatus(
  input: GlobalConnectivityStatusInput,
): GlobalConnectivityStatusOutput {
  const providers = input.providers ?? [];
  let operationalActiveCount = 0;
  let degradedOperationalCount = 0;
  let hasCoreOperationalProvider = false;

  for (const p of providers) {
    if (p.state === 'CONNECTED') {
      operationalActiveCount += 1;
      if (
        p.id === 'FMP_ENTERPRISE_REST' ||
        p.id === 'MASSIVE_REST_POOL' ||
        p.id === 'PRIMARY_REMARKETS_DLR'
      ) {
        hasCoreOperationalProvider = true;
      }
    } else if (
      p.state === 'DEGRADED'
    ) {
      degradedOperationalCount += 1;
    }
  }

  const hasCoreOperationalFeed = hasCoreOperationalProvider || operationalActiveCount > 0;

  if (!input.isBackendConnected) {
    return {
      tone: 'OFFLINE',
      label: 'DESCONECTADO',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (input.feedStatus === 'LIVE') {
    return {
      tone: 'LIVE',
      label: 'LIVE',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (input.feedStatus === 'EOD_CIERRE') {
    return {
      tone: 'EOD',
      label: 'EOD · ÚLTIMO CIERRE',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (input.streamFresh === true) {
    return {
      tone: 'LIVE',
      label: 'LIVE',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (hasCoreOperationalFeed && degradedOperationalCount === 0) {
    if (input.feedStatus === 'DIFERIDO_20M') {
      return {
        tone: 'PARTIAL',
        label: 'DIFERIDO_20M',
        operationalActiveCount,
        degradedOperationalCount,
      };
    }
    return {
      tone: 'LIVE',
      label: 'LIVE',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (input.feedStatus === 'DIFERIDO_20M' || input.feedStatus === 'PARTIAL') {
    return {
      tone: 'PARTIAL',
      label: input.feedStatus,
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  if (hasCoreOperationalFeed) {
    return {
      tone: 'LIVE',
      label: 'LIVE',
      operationalActiveCount,
      degradedOperationalCount,
    };
  }
  return {
    tone: 'OFFLINE',
    label: 'NO_DATA',
    operationalActiveCount,
    degradedOperationalCount,
  };
}
