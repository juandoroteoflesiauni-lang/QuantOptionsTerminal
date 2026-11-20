import React, { useMemo, useState } from 'react';
import { ArrowUpRight, Layers, Radar, ShieldAlert } from 'lucide-react';
import { fmtNum, fmtPct } from '../../data/marketData';
import {
  computeAtrPositionSize,
  computeCi24hImpliedCarry,
  computeSpatialProximityList,
  type SpatialLevelInputPoint,
} from './stockDetailMath';
import type {
  ChartKeyLevels,
  HighlightLevelId,
  StockExecutionDeckData,
} from './stockDetailTypes';
import { normalizeStockDetailOrderBook } from '../../../../src/core/stockDetailStability';

export const ExecutionBottomDeck: React.FC<{
  readonly deck: StockExecutionDeckData;
  readonly keyLevels: ChartKeyLevels;
  readonly onHighlightLevel: (id: Exclude<HighlightLevelId, null>) => void;
  readonly onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
  readonly onGoToOptions: (ticker: string) => void;
}> = ({
  deck,
  keyLevels,
  onHighlightLevel,
  onOpenOrderTicket,
  onGoToOptions,
}) => {
  const [equityInput, setEquityInput] = useState<string>(
    deck.market === 'US' ? '25000' : '10000000',
  );
  const [riskPctInput, setRiskPctInput] = useState<string>('1.0');
  const [atrMultInput, setAtrMultInput] = useState<string>('1.5');
  const [orderSide, setOrderSide] = useState<'Compra' | 'Venta'>('Compra');

  const pxPrefix = deck.currencySymbol === 'USD' ? 'US$ ' : '$ ';

  // Columna 1: Order Book L2 / L1 normalizado (`price > 0` estricto y spread válido)
  const book = useMemo(() => {
    const rawBook = deck.orderBook24h;
    if (rawBook === null) return null;
    const norm = normalizeStockDetailOrderBook(rawBook.bids, rawBook.asks, 5);
    return {
      ...rawBook,
      bids: norm.bids,
      asks: norm.asks,
      bestBid: norm.bestBid,
      bestAsk: norm.bestAsk,
      mid: Number.isFinite(norm.mid) ? norm.mid : null,
      spreadArs: Number.isFinite(norm.spreadAbs) ? norm.spreadAbs : null,
      spreadPct: Number.isFinite(norm.spreadPct) ? norm.spreadPct : null,
      obi5: Number.isFinite(norm.obi5) ? norm.obi5 : null,
    };
  }, [deck.orderBook24h]);
  const isL2Depth =
    book !== null &&
    (book.bids.some((b) => b.size > 0) || book.asks.some((a) => a.size > 0)) &&
    (book.bids.length > 1 || book.asks.length > 1);
  const maxLevelSize = useMemo(() => {
    if (!book) return 1;
    let m = 1;
    for (const b of book.bids) m = Math.max(m, b.size);
    for (const a of book.asks) m = Math.max(m, a.size);
    return m;
  }, [book]);

  // Columna 2: Radar de Confluencia Espacial (< 0.15 ATR)
  const proximityItems = useMemo(() => {
    if (deck.spot === null || deck.atr14 === null) return [];
    const pts: { readonly pt: SpatialLevelInputPoint; readonly highlightId?: Exclude<HighlightLevelId, null> }[] = [];
    const pushIfValid = (
      name: string,
      category: string,
      price: number | null,
      highlightId?: Exclude<HighlightLevelId, null>,
    ) => {
      if (price !== null && Number.isFinite(price) && price > 0) {
        pts.push({ pt: { name, category, price }, highlightId });
      }
    };
    pushIfValid('POC', 'AMT', keyLevels.poc, 'POC');
    pushIfValid('VAH', 'AMT', keyLevels.vah, 'VAH');
    pushIfValid('VAL', 'AMT', keyLevels.val, 'VAL');
    pushIfValid('Call Wall', 'OPTIONS', keyLevels.callWall, 'CALL_WALL');
    pushIfValid('Put Wall', 'OPTIONS', keyLevels.putWall, 'PUT_WALL');
    pushIfValid('Zero-Gamma', 'OPTIONS', keyLevels.zeroGamma, 'ZERO_GAMMA');
    for (const np of keyLevels.nakedPocs.slice(0, 3)) {
      pushIfValid(`nPOC ${np.sessionDate.slice(5)}`, 'AMT', np.price);
    }
    for (const ob of keyLevels.orderBlocks.slice(0, 2)) {
      pushIfValid(
        ob.type === 'BULLISH_FOB' ? 'FOB Demanda' : 'FOB Oferta',
        'ICT',
        ob.anchorPrice,
      );
    }
    for (const fvg of keyLevels.fvgs.slice(0, 2)) {
      pushIfValid(
        fvg.type === 'BULLISH_FVG' ? 'FVG+ CE' : 'FVG- CE',
        'ICT',
        fvg.consequentEncroachment,
      );
    }

    const highlightByName = new Map<string, Exclude<HighlightLevelId, null>>();
    for (const entry of pts) {
      if (entry.highlightId) highlightByName.set(entry.pt.name, entry.highlightId);
    }
    return computeSpatialProximityList(
      deck.spot,
      deck.atr14,
      pts.map((x) => x.pt),
      0.15,
    ).map((item) => ({ ...item, highlightId: highlightByName.get(item.name) }));
  }, [deck.spot, deck.atr14, keyLevels]);

  const clusters = deck.confluenceClusters?.clusters ?? [];

  // Columna 3: Tasa implícita CI <-> 24hs + Position Sizing ATR
  const ciPrice =
    deck.orderBookCi?.mid ??
    deck.orderBookCi?.bestAsk ??
    deck.orderBookCi?.last ??
    Number.NaN;
  const hs24Price =
    deck.orderBook24h?.mid ??
    deck.orderBook24h?.bestBid ??
    deck.orderBook24h?.last ??
    Number.NaN;
  const ci24hCarry = computeCi24hImpliedCarry(ciPrice, hs24Price, 1);

  const equityNum = Number(equityInput.replace(',', '.'));
  const riskPctNum = Number(riskPctInput.replace(',', '.'));
  const atrMultNum = Number(atrMultInput.replace(',', '.'));
  const atrSizing = computeAtrPositionSize({
    equity: Number.isFinite(equityNum) ? equityNum : Number.NaN,
    riskPct: Number.isFinite(riskPctNum) ? riskPctNum : Number.NaN,
    entryPrice: deck.spot ?? Number.NaN,
    atr14: deck.atr14 ?? Number.NaN,
    atrMultiple: Number.isFinite(atrMultNum) ? atrMultNum : Number.NaN,
  });

  const canSubmitOrder =
    deck.spot !== null &&
    Number.isFinite(deck.spot) &&
    deck.spot > 0 &&
    Number.isFinite(atrSizing.suggestedQty) &&
    atrSizing.suggestedQty > 0;

  return (
    <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* COLUMNA 1: Libro de Órdenes L2 (5 Niveles) / L1 NBBO */}
      <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#CBD0E4]">
              {isL2Depth ? 'Libro de Órdenes L2 (5 Niveles)' : 'Puntas L1 / NBBO'}
            </h3>
            <span className="text-[10px] font-mono-num text-[#7E85A3]">
              Fuente: {book?.source ?? 'Sin puntas'} · Liq. {book?.settlement ?? '24hs'}
            </span>
          </div>
          {book?.obi5 !== null && book?.obi5 !== undefined && Number.isFinite(book.obi5) && (
            <span
              className={`px-2 py-0.5 rounded-full font-mono-num text-[10px] font-semibold ${
                book.obi5 >= 0.1
                  ? 'bg-[#2EDC7E]/15 text-[#2EDC7E]'
                  : book.obi5 <= -0.1
                  ? 'bg-[#FF5468]/15 text-[#FF5468]'
                  : 'bg-[#1D1D2B] text-[#A2A8C2]'
              }`}
            >
              OBI: {book.obi5 >= 0 ? '+' : ''}
              {fmtNum(book.obi5 * 100, 1)}%
            </span>
          )}
        </div>

        {/* Spread & VWAP Book */}
        <div className="grid grid-cols-3 gap-2 text-[11px] font-mono-num">
          <div className="px-2.5 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
            <div className="text-[9px] uppercase text-[#767C99]">Mejor Bid</div>
            <div className="font-semibold text-[#2EDC7E]">
              {book?.bestBid ? `${pxPrefix}${fmtNum(book.bestBid, 2)}` : '—'}
            </div>
          </div>
          <div className="px-2.5 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
            <div className="text-[9px] uppercase text-[#767C99]">Spread</div>
            <div className="font-semibold text-[#F0F2FA]">
              {book?.spreadPct !== null && book?.spreadPct !== undefined && Number.isFinite(book.spreadPct)
                ? `${fmtNum(book.spreadPct, 3)} %`
                : '—'}
              {book?.spreadArs !== null && book?.spreadArs !== undefined && Number.isFinite(book.spreadArs)
                ? ` · ${pxPrefix}${fmtNum(book.spreadArs, 2)}`
                : ''}
            </div>
          </div>
          <div className="px-2.5 py-1.5 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
            <div className="text-[9px] uppercase text-[#767C99]">Mejor Ask</div>
            <div className="font-semibold text-[#FF5468]">
              {book?.bestAsk ? `${pxPrefix}${fmtNum(book.bestAsk, 2)}` : '—'}
            </div>
          </div>
        </div>

        {/* Tabla L2 5 Puntas */}
        {book && (book.bids.length > 0 || book.asks.length > 0) ? (
          <div className="perf-table-viewport grid grid-cols-2 gap-2 font-mono-num tabular-nums text-[11px]">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-[9px] uppercase text-[#6D738E] px-1">
                <span>Vol.</span>
                <span>Bid</span>
              </div>
              {Array.from({ length: 5 }, (_, i) => {
                const row = book.bids[i];
                const fillPct = row ? Math.min(100, (row.size / maxLevelSize) * 100) : 0;
                return (
                  <div
                    key={`bid-${i}`}
                    className="relative flex justify-between items-center px-2 py-1 rounded-[5px] bg-[#0B0B12] overflow-hidden"
                  >
                    <div
                      className="absolute right-0 top-0 bottom-0 bg-[#2EDC7E]/14 pointer-events-none"
                      style={{ width: `${fillPct}%` }}
                    />
                    <span className="relative z-10 text-[#9DA4C2] text-[10px]">
                      {row ? (row.size > 0 ? fmtNum(row.size, 0) : 'L1') : '—'}
                    </span>
                    <span className="relative z-10 font-semibold text-[#2EDC7E]">
                      {row ? fmtNum(row.price, 2) : '—'}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-[9px] uppercase text-[#6D738E] px-1">
                <span>Ask</span>
                <span>Vol.</span>
              </div>
              {Array.from({ length: 5 }, (_, i) => {
                const row = book.asks[i];
                const fillPct = row ? Math.min(100, (row.size / maxLevelSize) * 100) : 0;
                return (
                  <div
                    key={`ask-${i}`}
                    className="relative flex justify-between items-center px-2 py-1 rounded-[5px] bg-[#0B0B12] overflow-hidden"
                  >
                    <div
                      className="absolute left-0 top-0 bottom-0 bg-[#FF5468]/14 pointer-events-none"
                      style={{ width: `${fillPct}%` }}
                    />
                    <span className="relative z-10 font-semibold text-[#FF5468]">
                      {row ? fmtNum(row.price, 2) : '—'}
                    </span>
                    <span className="relative z-10 text-[#9DA4C2] text-[10px]">
                      {row ? (row.size > 0 ? fmtNum(row.size, 0) : 'L1') : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center rounded-[9px] bg-[#0B0B12] border border-[#1B1B28] px-3 py-6 text-center text-[11px] text-[#7E85A3]">
            Sin puntas Bid/Ask en vivo para esta rueda o fuera de horario operativo.
          </div>
        )}
      </div>

      {/* COLUMNA 2: Radar de Confluencia Espacial (< 0.15 ATR) */}
      <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Radar className="w-4 h-4 text-[#8B7CF6]" />
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#CBD0E4]">
                Radar de Confluencia (&lt; 0.15 ATR)
              </h3>
              <span className="text-[10px] font-mono-num text-[#7E85A3]">
                ATR(14): {deck.atr14 ? `${pxPrefix}${fmtNum(deck.atr14, 2)}` : '—'} · Banda ±
                {deck.atr14 ? `${pxPrefix}${fmtNum(deck.atr14 * 0.15, 2)}` : '—'}
              </span>
            </div>
          </div>
          {clusters.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-[#2EDC7E]/15 text-[#2EDC7E] font-mono-num text-[10px] font-semibold">
              {clusters.length} Cluster{clusters.length > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Clusters multicapa si el motor los detectó */}
        {clusters.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {clusters.slice(0, 2).map((cl, idx) => (
              <div
                key={`cl-${idx}`}
                className="px-2.5 py-2 rounded-[8px] bg-[#8B7CF6]/12 border border-[#8B7CF6]/35 flex flex-col gap-1"
              >
                <div className="flex items-center justify-between text-[11px] font-mono-num">
                  <span className="font-bold text-[#DCD4FF]">
                    {cl.levels.map((l) => l.name).join(' + ')}
                  </span>
                  <span className="text-[#2EDC7E] font-semibold">
                    {cl.distanceToSpotAtr !== null ? `${fmtNum(cl.distanceToSpotAtr, 2)} ATR` : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#9BA2C0]">
                  <span>
                    Centroide: {pxPrefix}
                    {fmtNum(cl.centroidPrice, 2)}
                  </span>
                  <span>{cl.distinctCategories.join(' · ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Lista ordenada de proximidad de niveles */}
        <div className="flex-1 flex flex-col gap-1 overflow-y-auto max-h-[210px] pr-0.5">
          {proximityItems.length > 0 ? (
            proximityItems.map((item, idx) => (
              <button
                key={`${item.name}-${idx}`}
                type="button"
                disabled={!item.highlightId}
                onClick={() => item.highlightId && onHighlightLevel(item.highlightId)}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-[7px] border text-left font-mono-num text-[11px] transition-colors ${
                  item.withinBand
                    ? 'bg-[#2EDC7E]/10 border-[#2EDC7E]/40 text-white'
                    : 'bg-[#0B0B12] border-[#1A1A26] text-[#CBD0E4] hover:border-[#2E2E42]'
                } ${item.highlightId ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                      item.category === 'OPTIONS'
                        ? 'bg-[#8B7CF6]/20 text-[#C8BCFF]'
                        : item.category === 'AMT'
                        ? 'bg-[#60A5FA]/20 text-[#93C5FD]'
                        : 'bg-[#F5B544]/20 text-[#FCD34D]'
                    }`}
                  >
                    {item.category}
                  </span>
                  <span className="truncate font-sans font-medium">{item.name}</span>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="text-[#E5E8F5]">{fmtNum(item.price, 2)}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      item.withinBand
                        ? 'bg-[#2EDC7E]/25 text-[#2EDC7E]'
                        : item.distanceAtr <= 0.35
                        ? 'bg-[#F5B544]/18 text-[#F5B544]'
                        : 'bg-[#171724] text-[#7E85A3]'
                    }`}
                  >
                    {fmtNum(item.distanceAtr, 2)} ATR
                  </span>
                </div>
              </button>
            ))
          ) : (
            <div className="flex-1 flex items-center justify-center rounded-[9px] bg-[#0B0B12] border border-[#1B1B28] px-3 py-6 text-center text-[11px] text-[#7E85A3]">
              Sin niveles estructurales o ATR(14) suficientes para calcular proximidad.
            </div>
          )}
        </div>
      </div>

      {/* COLUMNA 3: Arbitraje / Catalizadores & Quick Ticket ATR */}
      <div className="rounded-[12px] bg-[#11111A] border border-[#1E1E2B] p-4 flex flex-col gap-3">
        <div>
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[#CBD0E4]">
            Arbitraje, Catalizadores &amp; Quick Ticket
          </h3>
        </div>

        {/* Contexto Carry / MTF / Catalizador */}
        <div className="grid grid-cols-2 gap-2 font-mono-num text-[11px]">
          {deck.market === 'AR' ? (
            <>
              <div className="px-2.5 py-2 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
                <div className="text-[9px] uppercase text-[#767C99]">Pase Implícito CI↔24hs</div>
                <div className="font-semibold text-[#F0F2FA]">
                  {Number.isFinite(ci24hCarry.impliedTnaPct)
                    ? `${fmtNum(ci24hCarry.impliedTnaPct, 1)} % TNA`
                    : '—'}
                </div>
                <div className="text-[9px] text-[#6D738E]">
                  {Number.isFinite(ci24hCarry.spreadPct)
                    ? `Spread ${fmtPct(ci24hCarry.spreadPct, 2)}`
                    : 'Requiere CI y 24hs'}
                </div>
              </div>
              <div className="px-2.5 py-2 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
                <div className="text-[9px] uppercase text-[#767C99]">
                  {deck.nextExpiry ? `Vto. ${deck.nextExpiry.expiryCode}` : 'DLR Front ROFEX'}
                </div>
                <div className="font-semibold text-[#F0F2FA]">
                  {deck.nextExpiry && deck.nextExpiry.daysToExpiry !== null
                    ? `${deck.nextExpiry.daysToExpiry} DTE (${deck.nextExpiry.expirationDate.slice(5)})`
                    : deck.rofexFrontContract?.price
                    ? `$ ${fmtNum(deck.rofexFrontContract.price, 2)}`
                    : '—'}
                </div>
                <div className="text-[9px] text-[#6D738E]">
                  {deck.rofexFrontContract?.implicitTnaPct
                    ? `ROFEX TNA ${fmtNum(deck.rofexFrontContract.implicitTnaPct, 1)}%`
                    : 'Sin vencimientos activos'}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="px-2.5 py-2 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
                <div className="text-[9px] uppercase text-[#767C99]">Cascada MTF</div>
                <div className="font-semibold text-[#F0F2FA] truncate">
                  {deck.mtfSummary?.regime ?? '—'}
                </div>
                <div className="text-[9px] text-[#6D738E] truncate">
                  Setup: {deck.mtfSummary?.setupStatus ?? '—'}
                </div>
              </div>
              <div className="px-2.5 py-2 rounded-[8px] bg-[#0B0B12] border border-[#1B1B28]">
                <div className="text-[9px] uppercase text-[#767C99]">Catalizador / OPEX</div>
                <div className="font-semibold text-[#F0F2FA]">
                  {deck.relativeStrength?.hoursToEarnings !== null &&
                  deck.relativeStrength?.hoursToEarnings !== undefined
                    ? `Bal. en ${fmtNum(deck.relativeStrength.hoursToEarnings, 0)}h`
                    : deck.nextExpiry && deck.nextExpiry.daysToExpiry !== null
                    ? `OPEX ${deck.nextExpiry.daysToExpiry} DTE`
                    : 'Sin evento inminente'}
                </div>
                {deck.relativeStrength?.entryBlocked && (
                  <div className="inline-flex items-center gap-1 text-[9px] text-[#F5B544]">
                    <ShieldAlert className="w-3 h-3" /> Bloqueo Earnings
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Sizing por ATR y Botón Enviar a /posiciones */}
        <div className="rounded-[9px] bg-[#0B0B12] border border-[#1B1B28] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[#9DA4C2]">
              Quick Ticket · Sizing por ATR
            </span>
            <div className="inline-flex rounded-[6px] bg-[#161622] border border-[#252536] p-0.5 text-[10px] font-semibold">
              <button
                type="button"
                onClick={() => setOrderSide('Compra')}
                className={`px-2 py-0.5 rounded-[5px] ${
                  orderSide === 'Compra' ? 'bg-[#2EDC7E] text-[#08080D]' : 'text-[#848BA8]'
                }`}
              >
                Compra
              </button>
              <button
                type="button"
                onClick={() => setOrderSide('Venta')}
                className={`px-2 py-0.5 rounded-[5px] ${
                  orderSide === 'Venta' ? 'bg-[#FF5468] text-white' : 'text-[#848BA8]'
                }`}
              >
                Venta
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-[10px] font-mono-num">
            <label className="flex flex-col gap-0.5 text-[#7E85A3]">
              Capital ({deck.currencySymbol})
              <input
                type="text"
                value={equityInput}
                onChange={(e) => setEquityInput(e.target.value)}
                className="px-2 py-1 rounded-[6px] bg-[#14141F] border border-[#252536] text-white focus:border-[#8B7CF6] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[#7E85A3]">
              Riesgo %
              <input
                type="text"
                value={riskPctInput}
                onChange={(e) => setRiskPctInput(e.target.value)}
                className="px-2 py-1 rounded-[6px] bg-[#14141F] border border-[#252536] text-white focus:border-[#8B7CF6] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[#7E85A3]">
              Stop × ATR
              <input
                type="text"
                value={atrMultInput}
                onChange={(e) => setAtrMultInput(e.target.value)}
                className="px-2 py-1 rounded-[6px] bg-[#14141F] border border-[#252536] text-white focus:border-[#8B7CF6] focus:outline-none"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] font-mono-num">
            <div>
              <span className="text-[9px] uppercase text-[#767C99] block">Stop Loss</span>
              <span className="text-[#FF5468] font-semibold">
                {Number.isFinite(atrSizing.stopLossPrice)
                  ? `${pxPrefix}${fmtNum(atrSizing.stopLossPrice, 2)}`
                  : '—'}
              </span>
            </div>
            <div>
              <span className="text-[9px] uppercase text-[#767C99] block">Riesgo Máx.</span>
              <span className="text-[#CBD0E4] font-semibold">
                {Number.isFinite(atrSizing.riskBudget)
                  ? `${pxPrefix}${fmtNum(atrSizing.riskBudget, 0)}`
                  : '—'}
              </span>
            </div>
            <div>
              <span className="text-[9px] uppercase text-[#767C99] block">Cantidad Sug.</span>
              <span className="text-[#2EDC7E] font-bold">
                {Number.isFinite(atrSizing.suggestedQty)
                  ? `${fmtNum(atrSizing.suggestedQty, 0)} nom.`
                  : '—'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!canSubmitOrder}
              onClick={() => {
                if (!canSubmitOrder || deck.spot === null) return;
                onOpenOrderTicket({
                  ticker: deck.ticker,
                  side: orderSide,
                  price: deck.spot,
                  qty: atrSizing.suggestedQty,
                  instrumentLabel:
                    deck.market === 'AR'
                      ? `${deck.ticker} · BYMA 24hs (${orderSide})`
                      : `${deck.ticker} · US Equities (${orderSide})`,
                });
              }}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-[8px] text-[12px] font-semibold transition-colors ${
                canSubmitOrder
                  ? 'bg-[#8B7CF6] hover:bg-[#7A6AE8] text-white cursor-pointer'
                  : 'bg-[#1A1A26] text-[#5D637A] cursor-not-allowed'
              }`}
            >
              Enviar Orden a /posiciones
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onGoToOptions(deck.ticker)}
              className="inline-flex items-center gap-1 px-2.5 py-2 rounded-[8px] bg-[#161622] border border-[#252536] text-[11px] font-semibold text-[#C5CAE0] hover:text-white hover:border-[#3A3A54] transition-colors"
            >
              <Layers className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
