/**
 * Pure real-time propagation math shared by the server tick bus, the reactive
 * frontend store and the live chart projections.
 *
 * Zero silent fallbacks:
 *  - every non-computable scalar is `NaN` or `null`, never replaced by a demo value;
 *  - timestamps are always integer UTC seconds (never milliseconds);
 *  - inputs are never mutated.
 */

export type LiveMarket = 'AR' | 'US';

export interface PropagationQuote {
  readonly market: LiveMarket;
  readonly symbol: string;
  readonly price: number;
  readonly previousClose?: number | null;
  readonly asOfUtcSec?: number | null;
  readonly volume?: number | null;
  readonly turnover?: number | null;
  readonly currency?: 'ARS' | 'USD' | null;
  readonly kind?: 'stock' | 'index' | 'bond' | 'note' | 'corp';
  readonly source?: string;
}

export interface LiveFxSnapshot {
  readonly mepMedian: number | null;
  readonly cclMedian: number | null;
  readonly cclImplicitGgal: number | null;
  readonly canjePct: number | null;
}

export interface LiveTapeTick {
  readonly market: LiveMarket;
  readonly symbol: string;
  readonly price: number;
  readonly size: number | null;
  readonly side: 'BUY' | 'SELL' | null;
  readonly timeSec: number;
}

export interface LiveChartBar {
  readonly timeSec: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface LiveTickProjectionInput {
  readonly price: number;
  readonly timeSec: number;
  readonly volumeDelta?: number | null;
}

export interface LiveVwapPoint {
  readonly timeSec: number;
  readonly value: number;
}

const MEP_BOND_PAIRS: readonly { readonly local: string; readonly foreign: string }[] = [
  { local: 'AL30', foreign: 'AL30D' },
  { local: 'GD30', foreign: 'GD30D' },
  { local: 'AE38', foreign: 'AE38D' },
  { local: 'AL35', foreign: 'AL35D' },
  { local: 'GD35', foreign: 'GD35D' },
];

const CCL_BOND_PAIRS: readonly { readonly local: string; readonly foreign: string }[] = [
  { local: 'AL30', foreign: 'AL30C' },
  { local: 'GD30', foreign: 'GD30C' },
  { local: 'AE38', foreign: 'AE38C' },
  { local: 'AL35', foreign: 'AL35C' },
  { local: 'GD35', foreign: 'GD35C' },
];

const ADR_RATIO_BY_AR_SYMBOL: Readonly<Record<string, number>> = {
  GGAL: 10,
  YPFD: 1,
  PAMP: 25,
  BMA: 10,
  BBAR: 3,
  SUPV: 5,
};

const LIVE_TAPE_MAX_TICKS_PER_SYMBOL = 200;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function quoteKey(market: LiveMarket, symbol: string): string {
  return `${market}:${symbol.trim().toUpperCase()}`;
}

function buildQuoteIndex(quotes: readonly PropagationQuote[]): Map<string, PropagationQuote> {
  const index = new Map<string, PropagationQuote>();
  for (const quote of quotes) {
    if (!isFinitePositive(quote.price)) continue;
    const key = quoteKey(quote.market, quote.symbol);
    index.set(key, quote);
  }
  return index;
}

function computeMedian(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  const lower = finite[middle - 1];
  const upper = finite[middle];
  if (finite.length % 2 === 1) {
    return upper !== undefined ? upper : null;
  }
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

function bondImpliedRate(
  index: Map<string, PropagationQuote>,
  localSymbol: string,
  foreignSymbol: string,
): number | null {
  const local = index.get(quoteKey('AR', localSymbol));
  const foreign = index.get(quoteKey('AR', foreignSymbol));
  if (local === undefined || foreign === undefined) return null;
  if (!isFinitePositive(local.price) || !isFinitePositive(foreign.price)) return null;
  const implied = local.price / foreign.price;
  return isFinitePositive(implied) ? implied : null;
}

function adrImpliedRate(
  index: Map<string, PropagationQuote>,
  arSymbol: string,
  ratio: number,
): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const local = index.get(quoteKey('AR', arSymbol));
  const foreign = index.get(quoteKey('US', arSymbol));
  if (local === undefined || foreign === undefined) return null;
  if (!isFinitePositive(local.price) || !isFinitePositive(foreign.price)) return null;
  const implied = (local.price * ratio) / foreign.price;
  return isFinitePositive(implied) ? implied : null;
}

/**
 * Recomputes the institutional FX matrix from the latest live quotes.
 * `MEP` uses local bonds versus their `D` legislation. `CCL Mediano` combines
 * local bonds versus their `C` legislation and the liquid ADR ratios.
 */
export function computeLiveFxFromQuotes(
  quotes: readonly PropagationQuote[],
): LiveFxSnapshot {
  const index = buildQuoteIndex(quotes);
  const mepValues = MEP_BOND_PAIRS.map((pair) => bondImpliedRate(index, pair.local, pair.foreign)).filter(
    (value): value is number => value !== null,
  );
  const cclBondValues = CCL_BOND_PAIRS.map((pair) => bondImpliedRate(index, pair.local, pair.foreign)).filter(
    (value): value is number => value !== null,
  );
  const cclAdrValues = Object.entries(ADR_RATIO_BY_AR_SYMBOL)
    .map(([arSymbol, ratio]) => adrImpliedRate(index, arSymbol, ratio))
    .filter((value): value is number => value !== null);
  const mepMedian = computeMedian(mepValues);
  const cclMedian = computeMedian([...cclBondValues, ...cclAdrValues]);

  const ggalLocal = index.get(quoteKey('AR', 'GGAL'));
  const ggalForeign = index.get(quoteKey('US', 'GGAL'));
  let cclImplicitGgal: number | null = null;
  if (ggalLocal !== undefined && ggalForeign !== undefined) {
    const implied = (ggalLocal.price * 10) / ggalForeign.price;
    cclImplicitGgal = isFinitePositive(implied) ? implied : null;
  }

  let canjePct: number | null = null;
  if (mepMedian !== null && cclMedian !== null) {
    const value = ((cclMedian / mepMedian) - 1) * 100;
    canjePct = Number.isFinite(value) ? value : null;
  }

  return {
    mepMedian,
    cclMedian,
    cclImplicitGgal,
    canjePct,
  };
}

/**
 * Projects the forming candle with `high = max(high, price)`,
 * `low = min(low, price)`, `close = price` and `volume += volumeDelta`.
 * A new bucket starts when the tick leaves the current bucket.
 */
export function projectLiveCandle(
  bar: LiveChartBar,
  input: LiveTickProjectionInput,
  barSeconds: number,
): LiveChartBar | null {
  if (!Number.isInteger(barSeconds) || barSeconds <= 0) return null;
  if (!Number.isInteger(input.timeSec) || input.timeSec < 0) return null;
  if (!isFinitePositive(input.price)) return null;
  if (!Number.isInteger(bar.timeSec) || bar.timeSec < 0) return null;

  const bucketStart = Math.floor(input.timeSec / barSeconds) * barSeconds;
  const volumeDelta =
    input.volumeDelta !== null && input.volumeDelta !== undefined && Number.isFinite(input.volumeDelta) && input.volumeDelta >= 0
      ? input.volumeDelta
      : 0;
  if (bucketStart === bar.timeSec) {
    return {
      timeSec: bar.timeSec,
      open: bar.open,
      high: Math.max(bar.high, input.price),
      low: Math.min(bar.low, input.price),
      close: input.price,
      volume: bar.volume + volumeDelta,
    };
  }
  if (bucketStart < bar.timeSec) return null;
  return {
    timeSec: bucketStart,
    open: input.price,
    high: input.price,
    low: input.price,
    close: input.price,
    volume: volumeDelta,
  };
}

/**
 * Projects the session VWAP point for the forming bar. Previous bars of the
 * same session are accumulated exactly once; the forming bar is represented by
 * its current OHLC state, not by repeated tick additions.
 */
export function projectLiveSessionVwap(
  closedBars: readonly LiveChartBar[],
  formingBar: LiveChartBar,
  marketTz: string,
): LiveVwapPoint | null {
  if (!Number.isInteger(formingBar.timeSec) || formingBar.timeSec < 0) return null;
  if (!isFinitePositive(formingBar.close)) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: marketTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sessionKey = formatter.format(new Date(formingBar.timeSec * 1_000));
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of closedBars) {
    if (!Number.isInteger(bar.timeSec) || bar.timeSec < 0) continue;
    if (bar.timeSec >= formingBar.timeSec) continue;
    if (formatter.format(new Date(bar.timeSec * 1_000)) !== sessionKey) continue;
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    if (!Number.isFinite(typicalPrice) || !Number.isFinite(bar.volume) || bar.volume <= 0) continue;
    cumulativePriceVolume += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
  }
  const formingTypicalPrice = (formingBar.high + formingBar.low + formingBar.close) / 3;
  if (!Number.isFinite(formingTypicalPrice) || !Number.isFinite(formingBar.volume) || formingBar.volume <= 0) {
    return null;
  }
  const totalVolume = cumulativeVolume + formingBar.volume;
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return null;
  const value = (cumulativePriceVolume + formingTypicalPrice * formingBar.volume) / totalVolume;
  return Number.isFinite(value) ? { timeSec: formingBar.timeSec, value } : null;
}

/**
 * Projects the cumulative volume delta from real tape prints. Unprintable or
 * unclassified trades contribute exactly zero; no sign is invented from price.
 */
export function projectLiveCvd(
  lastCvd: number,
  ticks: readonly LiveTapeTick[],
): number {
  if (!Number.isFinite(lastCvd)) return Number.NaN;
  let cvd = lastCvd;
  for (const tick of ticks) {
    if (!isFinitePositive(tick.price)) continue;
    if (!Number.isInteger(tick.timeSec) || tick.timeSec < 0) continue;
    if (tick.size === null || !Number.isFinite(tick.size) || tick.size <= 0) continue;
    if (tick.side === 'BUY') {
      cvd += tick.size;
    } else if (tick.side === 'SELL') {
      cvd -= tick.size;
    }
  }
  return Number.isFinite(cvd) ? cvd : Number.NaN;
}

export function appendLiveTapeTick(
  tape: readonly LiveTapeTick[],
  tick: LiveTapeTick,
): readonly LiveTapeTick[] {
  if (!isFinitePositive(tick.price)) return tape;
  if (!Number.isInteger(tick.timeSec) || tick.timeSec < 0) return tape;
  const sameSymbol = tape.filter((existing) => existing.market === tick.market && existing.symbol === tick.symbol);
  const nextSameSymbol = [...sameSymbol, tick].slice(-LIVE_TAPE_MAX_TICKS_PER_SYMBOL);
  const otherSymbols = tape.filter(
    (existing) => !(existing.market === tick.market && existing.symbol === tick.symbol),
  );
  return [...otherSymbols, ...nextSameSymbol];
}

export const LIVE_TAPE_LIMIT = LIVE_TAPE_MAX_TICKS_PER_SYMBOL;
