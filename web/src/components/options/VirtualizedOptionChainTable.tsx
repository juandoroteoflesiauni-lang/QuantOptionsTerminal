import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { normalizeOptionContractKey } from '../../../../src/core/atomicQuoteStore';
import { setVisibleMarketSymbols, useAtomicOptionQuote } from '../../api/useMarketLiveStream';
import { fmtNum } from '../../data/marketData';
import { ImperativePriceCell } from '../ImperativePriceCell';
import {
  type EnrichedChainRow,
  type InlineAxisMarker,
  safeAnalyticalBsmGamma,
} from './optionsDerived';

export type OptionChainColMode = 'completa' | 'griegas' | 'valortiempo' | 'liquidez';

type ChainVirtualEntry =
  | { readonly kind: 'marker'; readonly key: string; readonly marker: InlineAxisMarker }
  | { readonly kind: 'row'; readonly key: string; readonly item: EnrichedChainRow };

const HEADER_GRID_CLASSES: Readonly<Record<OptionChainColMode, string>> = {
  completa:
    'grid grid-cols-[minmax(58px,0.8fr)_minmax(56px,0.8fr)_minmax(66px,0.9fr)_minmax(66px,0.9fr)_minmax(60px,0.8fr)_minmax(86px,1.15fr)_minmax(86px,1.15fr)_minmax(64px,0.8fr)_94px_minmax(64px,0.8fr)_minmax(86px,1.15fr)_minmax(86px,1.15fr)_minmax(60px,0.8fr)_minmax(66px,0.9fr)_minmax(66px,0.9fr)_minmax(56px,0.8fr)_minmax(58px,0.8fr)]',
  griegas: 'grid grid-cols-[repeat(5,minmax(78px,1fr))_94px_repeat(5,minmax(78px,1fr))]',
  valortiempo: 'grid grid-cols-[repeat(5,minmax(78px,1fr))_94px_repeat(5,minmax(78px,1fr))]',
  liquidez: 'grid grid-cols-[repeat(5,minmax(78px,1fr))_94px_repeat(5,minmax(78px,1fr))]',
};

const MARKER_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)_94px_minmax(0,1fr)]';

const MIN_WIDTH_CLASSES: Readonly<Record<OptionChainColMode, string>> = {
  completa: 'min-w-[1160px]',
  griegas: 'min-w-[920px]',
  valortiempo: 'min-w-[920px]',
  liquidez: 'min-w-[920px]',
};

const ROW_HEIGHT_PX_BY_DENSITY: Readonly<Record<'densa' | 'normal' | 'comoda', number>> = {
  densa: 28,
  normal: 34,
  comoda: 42,
};

function resolvePriceOrFallback(live: number | null | undefined, fallback: number): number {
  return typeof live === 'number' && Number.isFinite(live) && live > 0 ? live : fallback;
}

const HoldingsCell: React.FC<{ readonly holdings: number; readonly ticker: string }> = ({
  holdings,
  ticker,
}) => (
  <div
    title={holdings !== 0 ? `${ticker}: tenencia neta ${holdings > 0 ? '+' : ''}${holdings} lotes` : `${ticker}: sin tenencia`}
    className={`flex h-full items-center justify-center px-2 font-mono-num tabular-nums text-[11.5px] ${
      holdings > 0
        ? 'text-[#22C55E] font-semibold'
        : holdings < 0
          ? 'text-[#EF4444] font-semibold'
          : 'text-[#374151]'
    }`}
  >
    {holdings > 0 ? `+${fmtNum(holdings, 0)}` : holdings < 0 ? fmtNum(holdings, 0) : ''}
  </div>
);

const VarCell: React.FC<{ readonly valPct: number }> = ({ valPct }) => {
  if (!Number.isFinite(valPct)) {
    return (
      <div className="flex h-full items-center justify-end px-2 font-mono-num tabular-nums text-[11.5px] text-[#6B7280]">
        —
      </div>
    );
  }
  const cls = valPct > 0 ? 'text-[#22C55E]' : valPct < 0 ? 'text-[#EF4444]' : 'text-[#6B7280]';
  return (
    <div className={`flex h-full items-center justify-end px-2 font-mono-num tabular-nums text-[11.5px] ${cls}`}>
      {valPct > 0 ? '+' : ''}
      {fmtNum(valPct, 1)}%
    </div>
  );
};

const TheoCell: React.FC<{ readonly theo: number; readonly ask: number }> = ({ theo, ask }) => {
  const isCheap =
    Number.isFinite(ask) && ask > 0 && Number.isFinite(theo) && theo > 0 && ask < theo * 0.98;
  return (
    <div
      className={`flex h-full items-center justify-end px-2 font-mono-num tabular-nums text-[12px] ${
        !Number.isFinite(theo) || theo < 0
          ? 'text-[#6B7280]'
          : isCheap
            ? 'text-[#4ADE80]'
            : 'text-[#9CA3AF]'
      }`}
    >
      {Number.isFinite(theo) && theo >= 0 ? fmtNum(theo, 2) : '—'}
    </div>
  );
};

const BidAskCell: React.FC<{
  readonly strike: number;
  readonly optType: 'Call' | 'Put';
  readonly isBid: boolean;
  readonly px: number;
  readonly size: number;
  readonly ticker: string;
}> = ({ strike, optType, isBid, px, size, ticker }) => {
  const cellRef = useRef<HTMLDivElement | null>(null);
  const hasPx = Number.isFinite(px) && px > 0;
  const hasSize = Number.isFinite(size) && size > 0;
  const actionSide: 'Compra' | 'Venta' = isBid ? 'Venta' : 'Compra';
  const contractSym = normalizeOptionContractKey(ticker);
  const handleMutate = useCallback(
    (nextVal: number, formatted: string) => {
      const el = cellRef.current;
      if (el === null) return;
      if (Number.isFinite(nextVal) && nextVal > 0) {
        el.dataset['px'] = String(nextVal);
        el.dataset['quoteId'] = `${String(strike)}:${optType}:${actionSide}`;
        el.dataset['strike'] = String(strike);
        el.dataset['optType'] = optType;
        el.dataset['side'] = actionSide;
        el.dataset['ticker'] = ticker;
        el.title = `${ticker} · Click para ${actionSide.toLowerCase()} a ${formatted} (Shift+Click envía a Armado a mano)`;
      } else {
        delete el.dataset['px'];
        delete el.dataset['quoteId'];
      }
    },
    [actionSide, optType, strike, ticker],
  );
  return (
    <div
      ref={cellRef}
      data-quote-id={hasPx ? `${String(strike)}:${optType}:${actionSide}` : undefined}
      data-strike={hasPx ? String(strike) : undefined}
      data-opt-type={hasPx ? optType : undefined}
      data-side={hasPx ? actionSide : undefined}
      data-px={hasPx ? String(px) : undefined}
      data-ticker={hasPx ? ticker : undefined}
      title={
        hasPx
          ? `${ticker} · Click para ${actionSide.toLowerCase()} a ${fmtNum(px, 2)} (Shift+Click envía a Armado a mano)`
          : `${ticker} · Sin punta`
      }
      className={`flex h-full items-center justify-end px-2 font-mono-num tabular-nums text-[12px] ${
        hasPx ? 'hover:bg-[#16161F] cursor-pointer' : ''
      }`}
    >
      <span className="inline-flex items-center justify-end gap-1">
        <ImperativePriceCell
          cellKey={`OPT:${contractSym}:${isBid ? 'BID' : 'ASK'}`}
          symbol={contractSym}
          field={isBid ? 'bid' : 'ask'}
          pulseTier="table"
          value={hasPx ? px : Number.NaN}
          decimals={2}
          className="h-5 w-[56px] shrink-0 rounded-[4px] px-0.5"
          textClassName={
            hasPx
              ? isBid
                ? 'text-[#22C55E] font-medium'
                : 'text-[#EF4444] font-medium'
              : 'text-[#6B7280]'
          }
          onMutate={handleMutate}
        />
        {hasPx && hasSize && (
          <span className="text-[10.5px] text-[#6B7280]">×{fmtNum(size, 0)}</span>
        )}
      </span>
    </div>
  );
};

const OptionChainVirtualRow = memo(function OptionChainVirtualRow({
  item,
  colMode,
  displaySpot,
  daysToExpiry,
  effectiveRateDec,
}: {
  readonly item: EnrichedChainRow;
  readonly colMode: OptionChainColMode;
  readonly displaySpot: number;
  readonly daysToExpiry: number;
  readonly effectiveRateDec: number;
}) {
  const { row } = item;
  const callContractSym = normalizeOptionContractKey(row.callTicker);
  const putContractSym = normalizeOptionContractKey(row.putTicker);
  const liveCall = useAtomicOptionQuote(row.callTicker, 250);
  const livePut = useAtomicOptionQuote(row.putTicker, 250);

  const callBid = resolvePriceOrFallback(liveCall?.bid, row.callBid);
  const callAsk = resolvePriceOrFallback(liveCall?.ask, row.callAsk);
  const callLast = resolvePriceOrFallback(liveCall?.last ?? liveCall?.mid, row.callLast);
  const callBidSize =
    liveCall !== null && liveCall.size !== null && Number.isFinite(liveCall.size) && liveCall.size > 0
      ? liveCall.size
      : item.callBidSize;
  const putBid = resolvePriceOrFallback(livePut?.bid, row.putBid);
  const putAsk = resolvePriceOrFallback(livePut?.ask, row.putAsk);
  const putLast = resolvePriceOrFallback(livePut?.last ?? livePut?.mid, row.putLast);
  const putBidSize =
    livePut !== null && livePut.size !== null && Number.isFinite(livePut.size) && livePut.size > 0
      ? livePut.size
      : item.putBidSize;

  const spotValid = Number.isFinite(displaySpot) && displaySpot > 0;
  const callGammaSafe = Number.isFinite(row.callGamma)
    ? row.callGamma
    : safeAnalyticalBsmGamma(displaySpot, row.strike, row.callIV, daysToExpiry, effectiveRateDec);
  const putGammaSafe = Number.isFinite(row.putGamma)
    ? row.putGamma
    : safeAnalyticalBsmGamma(displaySpot, row.strike, row.putIV, daysToExpiry, effectiveRateDec);
  const callOiRatio =
    Number.isFinite(row.callOpenInterest) && row.callOpenInterest > 0
      ? (row.callVolumeLots / row.callOpenInterest) * 100
      : Number.NaN;
  const putOiRatio =
    Number.isFinite(row.putOpenInterest) && row.putOpenInterest > 0
      ? (row.putVolumeLots / row.putOpenInterest) * 100
      : Number.NaN;

  return (
    <div
      className={`${HEADER_GRID_CLASSES[colMode]} h-full w-full items-center border-b border-[#1C1C24] bg-[#0A0A0D] hover:bg-[#13131A] text-right font-mono-num tabular-nums text-[12px]`}
    >
      {/* CALL SIDE */}
      {colMode === 'completa' && (
        <>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(row.callDelta, 2)}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.callIV) ? `${fmtNum(row.callIV, 1)}%` : '—'}
          </div>
          <TheoCell theo={item.callTheoreticalPrice} ask={callAsk} />
          <ImperativePriceCell
            cellKey={`OPT:${callContractSym}:LAST:completa`}
            symbol={callContractSym}
            field="last"
            pulseTier="table"
            value={Number.isFinite(callLast) ? callLast : Number.NaN}
            decimals={2}
            title={row.callTicker}
            className="w-full h-full px-2 rounded-[4px]"
            textClassName="text-[#E5E7EB]"
          />
          <VarCell valPct={item.callChangePct} />
          <BidAskCell
            strike={row.strike}
            optType="Call"
            isBid
            px={callBid}
            size={callBidSize}
            ticker={row.callTicker}
          />
          <BidAskCell
            strike={row.strike}
            optType="Call"
            isBid={false}
            px={callAsk}
            size={item.callAskSize}
            ticker={row.callTicker}
          />
          <HoldingsCell holdings={item.callHoldings} ticker={row.callTicker} />
        </>
      )}

      {colMode === 'griegas' && (
        <>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(callGammaSafe, 5)}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#EF4444]">
            {Number.isFinite(row.callTheta) ? `-${fmtNum(Math.abs(row.callTheta), 2)}` : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.callVega) ? fmtNum(row.callVega, 2) : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.callIV) ? `${fmtNum(row.callIV, 1)}%` : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {fmtNum(row.callDelta, 2)}
          </div>
        </>
      )}

      {colMode === 'valortiempo' && (
        <>
          <TheoCell theo={item.callTheoreticalPrice} ask={callAsk} />
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {spotValid ? fmtNum(Math.max(0, displaySpot - row.strike), 2) : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {Number.isFinite(row.callTimeValue) ? fmtNum(row.callTimeValue, 2) : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.callTimeValuePct) ? `${fmtNum(row.callTimeValuePct, 2)}%` : '—'}
          </div>
          <ImperativePriceCell
            cellKey={`OPT:${callContractSym}:LAST:valortiempo`}
            symbol={callContractSym}
            field="last"
            pulseTier="table"
            value={Number.isFinite(callLast) ? callLast : Number.NaN}
            decimals={2}
            title={row.callTicker}
            className="w-full h-full px-2 rounded-[4px]"
            textClassName="text-[#E5E7EB]"
          />
        </>
      )}

      {colMode === 'liquidez' && (
        <>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(callOiRatio) ? `${fmtNum(callOiRatio, 1)}%` : '—'}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(row.callOpenInterest, 0)}
          </div>
          <div title={row.callTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {fmtNum(row.callVolumeLots, 0)}
          </div>
          <BidAskCell
            strike={row.strike}
            optType="Call"
            isBid
            px={callBid}
            size={callBidSize}
            ticker={row.callTicker}
          />
          <BidAskCell
            strike={row.strike}
            optType="Call"
            isBid={false}
            px={callAsk}
            size={item.callAskSize}
            ticker={row.callTicker}
          />
        </>
      )}

      {/* BASE CENTRAL */}
      <div
        title={`Call: ${row.callTicker} · Put: ${row.putTicker}`}
        className="flex h-full flex-col items-center justify-center border-x border-[#1C1C24] bg-[#111116] px-2 leading-none"
      >
        <span className="font-bold text-[#F3F4F6] text-[12px]">
          {fmtNum(row.strike, row.strike % 1 === 0 ? 0 : 2)}
        </span>
        <span className="mt-0.5 text-[9.5px] font-normal text-[#6B7280]">
          {Number.isFinite(row.distancePct)
            ? `${row.distancePct > 0 ? '+' : ''}${fmtNum(row.distancePct, 1)}%`
            : '—'}
        </span>
      </div>

      {/* PUT SIDE */}
      {colMode === 'completa' && (
        <>
          <HoldingsCell holdings={item.putHoldings} ticker={row.putTicker} />
          <BidAskCell
            strike={row.strike}
            optType="Put"
            isBid
            px={putBid}
            size={putBidSize}
            ticker={row.putTicker}
          />
          <BidAskCell
            strike={row.strike}
            optType="Put"
            isBid={false}
            px={putAsk}
            size={item.putAskSize}
            ticker={row.putTicker}
          />
          <VarCell valPct={item.putChangePct} />
          <ImperativePriceCell
            cellKey={`OPT:${putContractSym}:LAST:completa`}
            symbol={putContractSym}
            field="last"
            pulseTier="table"
            value={Number.isFinite(putLast) ? putLast : Number.NaN}
            decimals={2}
            title={row.putTicker}
            className="w-full h-full px-2 rounded-[4px]"
            textClassName="text-[#E5E7EB]"
          />
          <TheoCell theo={item.putTheoreticalPrice} ask={putAsk} />
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.putIV) ? `${fmtNum(row.putIV, 1)}%` : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(row.putDelta, 2)}
          </div>
        </>
      )}

      {colMode === 'griegas' && (
        <>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {fmtNum(row.putDelta, 2)}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.putIV) ? `${fmtNum(row.putIV, 1)}%` : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.putVega) ? fmtNum(row.putVega, 2) : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#EF4444]">
            {Number.isFinite(row.putTheta) ? `-${fmtNum(Math.abs(row.putTheta), 2)}` : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(putGammaSafe, 5)}
          </div>
        </>
      )}

      {colMode === 'valortiempo' && (
        <>
          <ImperativePriceCell
            cellKey={`OPT:${putContractSym}:LAST:valortiempo`}
            symbol={putContractSym}
            field="last"
            pulseTier="table"
            value={Number.isFinite(putLast) ? putLast : Number.NaN}
            decimals={2}
            title={row.putTicker}
            className="w-full h-full px-2 rounded-[4px]"
            textClassName="text-[#E5E7EB]"
          />
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(row.putTimeValuePct) ? `${fmtNum(row.putTimeValuePct, 2)}%` : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {Number.isFinite(row.putTimeValue) ? fmtNum(row.putTimeValue, 2) : '—'}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {spotValid ? fmtNum(Math.max(0, row.strike - displaySpot), 2) : '—'}
          </div>
          <TheoCell theo={item.putTheoreticalPrice} ask={putAsk} />
        </>
      )}

      {colMode === 'liquidez' && (
        <>
          <BidAskCell
            strike={row.strike}
            optType="Put"
            isBid
            px={putBid}
            size={putBidSize}
            ticker={row.putTicker}
          />
          <BidAskCell
            strike={row.strike}
            optType="Put"
            isBid={false}
            px={putAsk}
            size={item.putAskSize}
            ticker={row.putTicker}
          />
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#E5E7EB]">
            {fmtNum(row.putVolumeLots, 0)}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {fmtNum(row.putOpenInterest, 0)}
          </div>
          <div title={row.putTicker} className="flex h-full items-center justify-end px-2 text-[#9CA3AF]">
            {Number.isFinite(putOiRatio) ? `${fmtNum(putOiRatio, 1)}%` : '—'}
          </div>
        </>
      )}
    </div>
  );
});

export interface VirtualizedOptionChainTableProps {
  readonly filteredRows: readonly EnrichedChainRow[];
  readonly beforeFirst: readonly InlineAxisMarker[];
  readonly afterIndex: ReadonlyMap<number, readonly InlineAxisMarker[]>;
  readonly colMode: OptionChainColMode;
  readonly density: 'densa' | 'normal' | 'comoda';
  readonly sigmaMultiplier: 1 | 1.5 | 2;
  readonly displaySpot: number;
  readonly daysToExpiry: number;
  readonly effectiveRateDec: number;
  readonly onQuoteClick: (
    e: React.MouseEvent,
    item: EnrichedChainRow,
    optType: 'Call' | 'Put',
    side: 'Compra' | 'Venta',
    price: number,
    ticker: string,
  ) => void;
}

export const VirtualizedOptionChainTable: React.FC<VirtualizedOptionChainTableProps> = memo(
  function VirtualizedOptionChainTable({
    filteredRows,
    beforeFirst,
    afterIndex,
    colMode,
    density,
    sigmaMultiplier,
    displaySpot,
    daysToExpiry,
    effectiveRateDec,
    onQuoteClick,
  }) {
    const parentRef = useRef<HTMLDivElement | null>(null);
    const onQuoteClickRef = useRef(onQuoteClick);
    onQuoteClickRef.current = onQuoteClick;

    const { entries, rowsByStrike } = useMemo(() => {
      const list: ChainVirtualEntry[] = [];
      const map = new Map<number, EnrichedChainRow>();
      for (const m of beforeFirst) {
        list.push({ kind: 'marker', key: `marker:${m.id}`, marker: m });
      }
      for (let idx = 0; idx < filteredRows.length; idx += 1) {
        const item = filteredRows[idx]!;
        map.set(item.row.strike, item);
        list.push({ kind: 'row', key: `row:${String(item.row.strike)}`, item });
        const trailing = afterIndex.get(idx);
        if (trailing !== undefined) {
          for (const m of trailing) {
            list.push({ kind: 'marker', key: `marker:${m.id}`, marker: m });
          }
        }
      }
      return { entries: list, rowsByStrike: map };
    }, [afterIndex, beforeFirst, filteredRows]);

    const rowsByStrikeRef = useRef(rowsByStrike);
    rowsByStrikeRef.current = rowsByStrike;

    const rowHeightPx = ROW_HEIGHT_PX_BY_DENSITY[density];

    const rowVirtualizer = useVirtualizer({
      count: entries.length,
      getScrollElement: () => parentRef.current,
      estimateSize: () => rowHeightPx,
      overscan: 6,
      getItemKey: (index) => entries[index]?.key ?? index,
    });

    const handleDelegatedClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-quote-id]');
      if (!cell) return;
      const strike = Number(cell.dataset['strike']);
      const px = Number(cell.dataset['px']);
      const optTicker = cell.dataset['ticker'] ?? '';
      const optType = cell.dataset['optType'] === 'Put' ? 'Put' : 'Call';
      const side = cell.dataset['side'] === 'Compra' ? 'Compra' : 'Venta';
      const item = rowsByStrikeRef.current.get(strike);
      if (item === undefined || !Number.isFinite(px) || px <= 0 || optTicker === '') return;
      onQuoteClickRef.current(e, item, optType, side, px, optTicker);
    }, []);

    const virtualItems = rowVirtualizer.getVirtualItems();
    const totalHeight = rowVirtualizer.getTotalSize();

    useEffect(() => {
      const visibleSyms: string[] = [];
      for (let i = 0; i < virtualItems.length; i += 1) {
        const vr = virtualItems[i];
        if (vr === undefined) continue;
        const entry = entries[vr.index];
        if (entry === undefined || entry.kind !== 'row') continue;
        const callKey = normalizeOptionContractKey(entry.item.row.callTicker);
        const putKey = normalizeOptionContractKey(entry.item.row.putTicker);
        if (callKey !== '') visibleSyms.push(callKey);
        if (putKey !== '') visibleSyms.push(putKey);
      }
      setVisibleMarketSymbols(visibleSyms, 'option-chain');
    }, [entries, virtualItems]);

    useEffect(() => {
      return () => {
        setVisibleMarketSymbols([], 'option-chain');
      };
    }, []);

    return (
      <div
        ref={parentRef}
        className="perf-table-viewport max-h-[66vh] overflow-auto bg-[#0A0A0D]"
      >
        <div className={MIN_WIDTH_CLASSES[colMode]}>
          {/* Encabezado fijo de 2 niveles */}
          <div className="sticky top-0 z-20 bg-[#0D0D12]">
            <div
              className={`${MARKER_GRID_CLASS} border-b border-[#1C1C24] text-[10.5px] font-bold uppercase tracking-[0.08em]`}
            >
              <div
                style={{ backgroundColor: 'rgba(229, 199, 107, 0.08)', color: '#E5C76B' }}
                className="py-1.5 px-3 text-center"
              >
                CALL
              </div>
              <div className="py-1.5 px-3 text-center bg-[#111116] text-[#9CA3AF] border-x border-[#1C1C24]">
                BASE
              </div>
              <div
                style={{ backgroundColor: 'rgba(183, 148, 244, 0.08)', color: '#B794F4' }}
                className="py-1.5 px-3 text-center"
              >
                PUT
              </div>
            </div>

            <div
              className={`${HEADER_GRID_CLASSES[colMode]} border-b border-[#1C1C24] bg-[#0D0D12] text-right text-[10.5px] font-medium text-[#6B7280]`}
            >
              {colMode === 'completa' && (
                <>
                  <div className="py-2 px-2">Delta Δ</div>
                  <div className="py-2 px-2">VI %</div>
                  <div className="py-2 px-2">teórico</div>
                  <div className="py-2 px-2">últ.</div>
                  <div className="py-2 px-2">var%</div>
                  <div className="py-2 px-2">compra</div>
                  <div className="py-2 px-2">venta</div>
                  <div className="py-2 px-2 text-center">tenencia</div>
                </>
              )}
              {colMode === 'griegas' && (
                <>
                  <div className="py-2 px-2">Gamma Γ</div>
                  <div className="py-2 px-2">Theta Θ (d)</div>
                  <div className="py-2 px-2">Vega ν</div>
                  <div className="py-2 px-2">VI %</div>
                  <div className="py-2 px-2">Delta Δ</div>
                </>
              )}
              {colMode === 'valortiempo' && (
                <>
                  <div className="py-2 px-2">teórico</div>
                  <div className="py-2 px-2">Val. Intrínseco</div>
                  <div className="py-2 px-2">Val. Tiempo $</div>
                  <div className="py-2 px-2">Tasa % s/Spot</div>
                  <div className="py-2 px-2">últ.</div>
                </>
              )}
              {colMode === 'liquidez' && (
                <>
                  <div className="py-2 px-2">Rotación OI</div>
                  <div className="py-2 px-2">Int. Abierto</div>
                  <div className="py-2 px-2">Lotes Hoy</div>
                  <div className="py-2 px-2">compra</div>
                  <div className="py-2 px-2">venta</div>
                </>
              )}

              <div className="py-2 px-3 text-center bg-[#111116] text-[#9CA3AF] border-x border-[#1C1C24]">
                BASE
              </div>

              {colMode === 'completa' && (
                <>
                  <div className="py-2 px-2 text-center">tenencia</div>
                  <div className="py-2 px-2">compra</div>
                  <div className="py-2 px-2">venta</div>
                  <div className="py-2 px-2">var%</div>
                  <div className="py-2 px-2">últ.</div>
                  <div className="py-2 px-2">teórico</div>
                  <div className="py-2 px-2">VI %</div>
                  <div className="py-2 px-2">Delta Δ</div>
                </>
              )}
              {colMode === 'griegas' && (
                <>
                  <div className="py-2 px-2">Delta Δ</div>
                  <div className="py-2 px-2">VI %</div>
                  <div className="py-2 px-2">Vega ν</div>
                  <div className="py-2 px-2">Theta Θ (d)</div>
                  <div className="py-2 px-2">Gamma Γ</div>
                </>
              )}
              {colMode === 'valortiempo' && (
                <>
                  <div className="py-2 px-2">últ.</div>
                  <div className="py-2 px-2">Tasa % s/Spot</div>
                  <div className="py-2 px-2">Val. Tiempo $</div>
                  <div className="py-2 px-2">Val. Intrínseco</div>
                  <div className="py-2 px-2">teórico</div>
                </>
              )}
              {colMode === 'liquidez' && (
                <>
                  <div className="py-2 px-2">compra</div>
                  <div className="py-2 px-2">venta</div>
                  <div className="py-2 px-2">Lotes Hoy</div>
                  <div className="py-2 px-2">Int. Abierto</div>
                  <div className="py-2 px-2">Rotación OI</div>
                </>
              )}
            </div>
          </div>

          {/* Cuerpo virtualizado con altura fija estricta */}
          {filteredRows.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-[#6B7280]">
              Ninguna base dentro de la banda ±{sigmaMultiplier}σ seleccionada. Desactivá el filtro o ampliá a ±2σ.
            </div>
          ) : (
            <div
              onClick={handleDelegatedClick}
              className="relative w-full"
              style={{ height: `${String(totalHeight)}px` }}
            >
              {virtualItems.map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (entry === undefined) return null;
                return (
                  <div
                    key={virtualRow.key}
                    className="perf-virtual-row absolute left-0 top-0 w-full"
                    style={{
                      height: `${String(rowHeightPx)}px`,
                      transform: `translateY(${String(virtualRow.start)}px)`,
                    }}
                  >
                    {entry.kind === 'marker' ? (
                      <div className={`${MARKER_GRID_CLASS} h-full items-center bg-[#0A0A0D]`}>
                        <div className="flex items-center">
                          <div
                            className={
                              entry.marker.kind === 'spot'
                                ? 'h-[1px] w-full bg-[#38BDF8]/35'
                                : 'h-[1px] w-full bg-[#1C1C24]'
                            }
                          />
                        </div>
                        <div className="flex h-full items-center justify-center bg-[#111116] border-x border-[#1C1C24] px-1">
                          <span
                            title={entry.marker.tooltip}
                            className={
                              entry.marker.kind === 'spot'
                                ? 'inline-block rounded-full bg-[#38BDF8] text-[#08080D] font-bold font-mono-num text-[10px] px-2 py-0.5 leading-tight'
                                : 'inline-block rounded-full bg-[#1E1E2B] text-[#9CA3AF] font-mono-num text-[9.5px] font-semibold px-2 py-0.5 leading-tight'
                            }
                          >
                            {entry.marker.label}
                          </span>
                        </div>
                        <div className="flex items-center">
                          <div
                            className={
                              entry.marker.kind === 'spot'
                                ? 'h-[1px] w-full bg-[#38BDF8]/35'
                                : 'h-[1px] w-full bg-[#1C1C24]'
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <OptionChainVirtualRow
                        item={entry.item}
                        colMode={colMode}
                        displaySpot={displaySpot}
                        daysToExpiry={daysToExpiry}
                        effectiveRateDec={effectiveRateDec}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  },
);
