import React, { useState } from 'react';
import { ArrowLeft, Layers, ChevronDown } from 'lucide-react';
import { AR_STOCKS, fmtNum, fmtMoneyCompact } from '../data/marketData';
import { HelpTooltip, DeltaPill, TickerChip } from './DesignSystem';

export const StockDetailView: React.FC<{
  ticker: string;
  onSelectTicker: (t: string) => void;
  onGoToOptions: (t: string) => void;
  onBackToMonitor: () => void;
  onOpenOrderTicket: (preset: {
    ticker: string;
    side: 'Compra' | 'Venta';
    price: number;
    qty: number;
    instrumentLabel: string;
  }) => void;
}> = ({ ticker, onSelectTicker, onGoToOptions, onBackToMonitor, onOpenOrderTicket }) => {
  const [timeframe, setTimeframe] = useState<'1m' | '5m' | '15m'>('5m');
  const [chartType, setChartType] = useState<'Línea' | 'Velas'>('Línea');
  const [plazaState, setPlazaState] = useState<'ABIERTO' | 'CERRADO'>('ABIERTO');

  const stock = AR_STOCKS.find((s) => s.ticker === ticker) || AR_STOCKS[0];

  // Libro de 5 puntas (Level 2 / DOM)
  const step = stock.last > 10000 ? 25 : stock.last > 2000 ? 5 : 1;
  const orderBook = [1, 2, 3, 4, 5].map((lvl) => {
    const bidPrice = stock.last - lvl * step;
    const askPrice = stock.last + (lvl - 1) * step;
    const bidSize = Math.round((2400 + ((lvl * 890) % 4200)) * (6500 / stock.last));
    const askSize = Math.round((1950 + ((lvl * 970) % 3800)) * (6500 / stock.last));
    return { lvl, bidSize, bidPrice, askPrice, askSize };
  });

  const maxBookSize = Math.max(...orderBook.flatMap((r) => [r.bidSize, r.askSize]), 1);

  // Serie intradiaria dual (Precio + Media Móvil 45m + Volumen por minuto verde/rojo)
  const intradayBars = [
    { t: '11:00', p: 6225, ma: 6220, o: 6220, h: 6250, l: 6210, v: 44, side: 'buy' as const },
    { t: '11:30', p: 6265, ma: 6235, o: 6225, h: 6280, l: 6220, v: 62, side: 'buy' as const },
    { t: '12:00', p: 6250, ma: 6245, o: 6265, h: 6275, l: 6240, v: 38, side: 'sell' as const },
    { t: '12:30', p: 6310, ma: 6265, o: 6250, h: 6325, l: 6248, v: 78, side: 'buy' as const, momentum: '+2σ vol' },
    { t: '13:00', p: 6355, ma: 6295, o: 6310, h: 6370, l: 6305, v: 85, side: 'buy' as const },
    { t: '13:30', p: 6340, ma: 6318, o: 6355, h: 6365, l: 6330, v: 46, side: 'sell' as const },
    { t: '14:00', p: 6395, ma: 6342, o: 6340, h: 6415, l: 6338, v: 92, side: 'buy' as const, momentum: 'Breakout' },
    { t: '14:30', p: 6425, ma: 6368, o: 6395, h: 6440, l: 6390, v: 68, side: 'buy' as const },
    { t: '15:00', p: 6410, ma: 6385, o: 6425, h: 6432, l: 6400, v: 51, side: 'sell' as const },
    { t: '15:30', p: 6455, ma: 6408, o: 6410, h: 6475, l: 6408, v: 89, side: 'buy' as const },
    { t: '16:00', p: 6442, ma: 6422, o: 6455, h: 6462, l: 6435, v: 54, side: 'sell' as const },
    { t: '16:30', p: 6480, ma: 6438, o: 6442, h: 6520, l: 6440, v: 98, side: 'buy' as const, momentum: 'Máx rueda' },
  ];

  const hourlyBuckets = [
    { slot: 'Hasta las 12', volM: 3120, buyPct: 64 },
    { slot: '12 a 13 hs', volM: 3840, buyPct: 68 },
    { slot: '13 a 14 hs', volM: 2950, buyPct: 52 },
    { slot: '14 a 15 hs', volM: 4210, buyPct: 71 },
    { slot: '15 a 17 hs', volM: 4300, buyPct: 61 },
  ];

  const adrRatio = stock.ticker === 'YPFD' ? 1 : stock.ticker === 'PAMP' ? 25 : 10;
  const adrUsd = stock.adrPrice ?? 55.45;
  const cclGeneral = 1168.80;
  const cclSpecific = stock.cclImplicit ?? 1168.60;
  const adrTheoreticalArs = (adrUsd * cclGeneral) / adrRatio;

  return (
    <div className="space-y-4 animate-module">
      {/* =====================================================================
          1. ENCABEZADO DE PLAZA / FICHA TÉCNICA INTRADIARIA
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Izquierda: Selector rápido + Título "GGAL - Grupo Financiero Galicia" + Estado */}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onBackToMonitor}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-semibold bg-[#1A1F2C] hover:bg-[#23293A] text-[#D1D4DC] border border-[#2A2E3D] cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Panel Acciones
            </button>

            <div className="flex items-center gap-3">
              <span
                className="w-9 h-9 rounded-full inline-flex items-center justify-center text-[12px] font-extrabold text-white shadow"
                style={{ backgroundColor: stock.color }}
              >
                {stock.ticker.slice(0, 2)}
              </span>
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-[19px] font-extrabold text-[#FFFFFF] tracking-tight">
                    {stock.ticker} - {stock.name}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setPlazaState((s) => (s === 'ABIERTO' ? 'CERRADO' : 'ABIERTO'))}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono-num font-bold uppercase cursor-pointer ${
                      plazaState === 'ABIERTO'
                        ? 'bg-[#0D281E] text-[#22C55E] border border-[#164E3F]'
                        : 'bg-[#1F2433] text-[#9CA3AF] border border-[#2E3446]'
                    }`}
                  >
                    {plazaState}
                  </button>
                </div>
                <div className="text-[11.5px] font-mono-num text-[#787B86] mt-0.5">
                  Plaza BYMA Contado Normal (T+1) · Última rueda 17:00 hs · 15:42:18 AR
                </div>
              </div>
            </div>
          </div>

          {/* Derecha: Precio actual + Variación limpia + Link a Opciones */}
          <div className="flex flex-wrap items-center gap-5">
            <div className="text-right">
              <div className="text-[10px] font-mono-num uppercase tracking-wider text-[#787B86]">
                PRECIO PLAZA ARS
              </div>
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono-num text-[24px] font-extrabold text-[#FFFFFF]">
                  $ {fmtNum(stock.last, 2)}
                </span>
                <DeltaPill value={stock.deltaPct} size="md" />
              </div>
            </div>

            <button
              type="button"
              onClick={() => onGoToOptions(stock.ticker)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[8px] text-[12px] font-bold bg-[#1A1F2C] hover:bg-[#252C3F] text-[#38BDF8] border border-[#2A364F] cursor-pointer transition-colors"
            >
              <Layers className="w-3.5 h-3.5" /> Cadena de Opciones ({stock.ticker})
            </button>
          </div>
        </div>

        {/* Tira de cambio rápido de papel */}
        <div className="pt-3 border-t border-[#232733] flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {AR_STOCKS.slice(0, 8).map((s) => (
              <TickerChip
                key={s.ticker}
                ticker={s.ticker}
                color={s.color}
                selected={s.ticker === stock.ticker}
                onClick={() => onSelectTicker(s.ticker)}
              />
            ))}
          </div>

          {/* Métrica cuantitativa de desviación diaria respecto de las primas */}
          <div className="text-[12.5px] text-[#D1D4DC] bg-[#0B0E14] px-3.5 py-1.5 rounded-[8px] border border-[#232733]">
            Hoy se movió <strong className="text-[#FFFFFF] font-mono-num">0,9 veces</strong> lo que esperaban las
            primas · <span className="text-[#9CA3AF]">pasa 1 de cada 3 ruedas</span>
          </div>
        </div>
      </div>

      {/* =====================================================================
          2. GRÁFICO INTRADIARIO DUAL + CAJA DE PUNTAS LEVEL 2 (DOM)
          ===================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* GRÁFICO INTRADIARIO DUAL (8 columnas) */}
        <div className="lg:col-span-8 rounded-[12px] bg-[#131722] border border-[#232733] p-5 flex flex-col justify-between gap-4">
          {/* Controles del gráfico: 1m, 5m, 15m + Línea / Velas */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                Evolución Intradiaria & Flujo Agresivo por Minuto
              </h3>
              <span className="text-[11px] font-mono-num text-[#EAB308]">
                ── Media 45 min ($ {fmtNum(stock.vwap, 1)})
              </span>
              <span className="text-[11px] font-mono-num text-[#787B86]">
                - - Cierre ant. ($ {fmtNum(stock.prevClose, 1)})
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Temporalidad: 1m, 5m, 15m */}
              <div className="flex items-center gap-1 bg-[#0B0E14] p-1 rounded-[8px] border border-[#232733]">
                {(['1m', '5m', '15m'] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={`px-2.5 py-1 rounded-[6px] text-[11.5px] font-mono-num font-bold cursor-pointer ${
                      timeframe === tf
                        ? 'bg-[#EAECEF] text-[#0B0E14]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              {/* Tipo de gráfico: Línea vs Velas */}
              <div className="flex items-center gap-1 bg-[#0B0E14] p-1 rounded-[8px] border border-[#232733]">
                {(['Línea', 'Velas'] as const).map((ct) => (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setChartType(ct)}
                    className={`px-2.5 py-1 rounded-[6px] text-[11.5px] font-bold cursor-pointer ${
                      chartType === ct
                        ? 'bg-[#1F2637] text-[#FFFFFF]'
                        : 'text-[#787B86] hover:text-white'
                    }`}
                  >
                    {ct}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Lienzo SVG Dual: Serie Superior (Cotización + MA45 + Cierre Ant.) y Serie Inferior (Volumen Verde/Rojo) */}
          <div className="h-72 w-full">
            <svg viewBox="0 0 680 265" className="w-full h-full overflow-visible">
              {/* Grilla horizontal superior (Precios) */}
              {[6220, 6310, 6400, 6490].map((lvl, idx) => {
                const y = 160 - idx * 44;
                const scaledVal = Math.round((lvl / 6480) * stock.last);
                return (
                  <g key={lvl}>
                    <line x1="52" y1={y} x2="655" y2={y} stroke="#1E222D" strokeWidth="1" />
                    <text
                      x="44"
                      y={y + 3}
                      textAnchor="end"
                      fill="#787B86"
                      fontSize="10"
                      className="font-mono-num"
                    >
                      ${fmtNum(scaledVal, 0)}
                    </text>
                  </g>
                );
              })}

              {/* Línea punteada de Cierre Anterior */}
              <line
                x1="52"
                y1="158"
                x2="655"
                y2="158"
                stroke="#6D7282"
                strokeWidth="1.2"
                strokeDasharray="4 4"
              />

              {/* Modo LÍNEA: Curva de cotización + Área sombreada + Media Móvil 45m */}
              {chartType === 'Línea' && (
                <>
                  <polygon
                    points={`72,162 ${intradayBars
                      .map((b, i) => {
                        const x = 72 + i * 51;
                        const y = 160 - ((b.p - 6200) / 310) * 135;
                        return `${x},${y.toFixed(1)}`;
                      })
                      .join(' ')} ${72 + (intradayBars.length - 1) * 51},162`}
                    fill="#22C55E"
                    fillOpacity="0.12"
                  />
                  <polyline
                    fill="none"
                    stroke="#22C55E"
                    strokeWidth="2.4"
                    points={intradayBars
                      .map((b, i) => {
                        const x = 72 + i * 51;
                        const y = 160 - ((b.p - 6200) / 310) * 135;
                        return `${x},${y.toFixed(1)}`;
                      })
                      .join(' ')}
                  />
                </>
              )}

              {/* Modo VELAS */}
              {chartType === 'Velas' &&
                intradayBars.map((b, i) => {
                  const x = 72 + i * 51;
                  const isBull = b.p >= b.o;
                  const color = isBull ? '#22C55E' : '#F23645';
                  const yH = 160 - ((b.h - 6200) / 310) * 135;
                  const yL = 160 - ((b.l - 6200) / 310) * 135;
                  const yO = 160 - ((b.o - 6200) / 310) * 135;
                  const yC = 160 - ((b.p - 6200) / 310) * 135;
                  return (
                    <g key={b.t}>
                      <line x1={x} y1={yH} x2={x} y2={yL} stroke={color} strokeWidth="1.5" />
                      <rect
                        x={x - 8}
                        y={Math.min(yO, yC)}
                        width="16"
                        height={Math.max(4, Math.abs(yC - yO))}
                        fill={color}
                        rx="2"
                      />
                    </g>
                  );
                })}

              {/* Media Móvil de 45 minutos */}
              <polyline
                fill="none"
                stroke="#EAB308"
                strokeWidth="1.8"
                strokeDasharray="4 3"
                points={intradayBars
                  .map((b, i) => {
                    const x = 72 + i * 51;
                    const y = 160 - ((b.ma - 6200) / 310) * 135;
                    return `${x},${y.toFixed(1)}`;
                  })
                  .join(' ')}
              />

              {/* Marcadores de Momentum y Serie Inferior de Volumen por Minuto */}
              <line x1="52" y1="182" x2="655" y2="182" stroke="#232733" strokeWidth="1" />
              {intradayBars.map((b, i) => {
                const x = 72 + i * 51;
                const yPrice = 160 - ((b.p - 6200) / 310) * 135;
                const volH = (b.v / 100) * 52;
                const barColor = b.side === 'buy' ? '#22C55E' : '#F23645';
                return (
                  <g key={`vol-${b.t}`}>
                    {b.momentum && (
                      <g>
                        <circle cx={x} cy={yPrice} r="4" fill="#FFFFFF" />
                        <text
                          x={x}
                          y={yPrice - 9}
                          textAnchor="middle"
                          fill="#EAECEF"
                          fontSize="9"
                          fontWeight="bold"
                          className="font-mono-num"
                        >
                          {b.momentum}
                        </text>
                      </g>
                    )}
                    <rect
                      x={x - 9}
                      y={240 - volH}
                      width="18"
                      height={volH}
                      fill={barColor}
                      fillOpacity="0.8"
                      rx="2"
                    />
                    <text
                      x={x}
                      y="256"
                      textAnchor="middle"
                      fill="#787B86"
                      fontSize="9.5"
                      className="font-mono-num"
                    >
                      {b.t}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Acumulados de volumen por franjas horarias */}
          <div className="pt-3 border-t border-[#232733] grid grid-cols-2 sm:grid-cols-5 gap-2.5">
            {hourlyBuckets.map((hb) => (
              <div
                key={hb.slot}
                className="p-2.5 rounded-[8px] bg-[#0B0E14] border border-[#1E222D] space-y-1.5"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#9CA3AF] font-medium">{hb.slot}</span>
                  <span className="font-mono-num font-bold text-[#FFFFFF]">
                    $ {fmtNum(hb.volM, 0)}M
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full overflow-hidden flex bg-[#232733]">
                  <div style={{ width: `${hb.buyPct}%` }} className="bg-[#22C55E] h-full" />
                  <div style={{ width: `${100 - hb.buyPct}%` }} className="bg-[#F23645] h-full" />
                </div>
                <div className="flex justify-between text-[10px] font-mono-num text-[#787B86]">
                  <span className="text-[#22C55E]">Compra {hb.buyPct}%</span>
                  <span className="text-[#F23645]">{100 - hb.buyPct}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CAJA DE PUNTAS LEVEL 2 / DOM + RESUMEN ESTADÍSTICO (4 columnas) */}
        <div className="lg:col-span-4 rounded-[12px] bg-[#131722] border border-[#232733] p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
                  Caja de Puntas (Level 2 / DOM)
                </h3>
                <HelpTooltip
                  title="Profundidad de Libro"
                  text="5 niveles de compra y venta en BYMA. Click en cualquier precio para precargar orden."
                />
              </div>
              <span className="text-[11px] font-mono-num text-[#22C55E]">
                Spread $ {fmtNum(step, 2)}
              </span>
            </div>

            <table className="w-full font-mono-num text-[12px] border-collapse">
              <thead>
                <tr className="text-[10px] uppercase text-[#787B86] border-b border-[#232733]">
                  <th className="py-2 text-left">Vol. Compra</th>
                  <th className="py-2 text-right pr-2.5 text-[#22C55E]">Precio Compra</th>
                  <th className="py-2 text-left pl-2.5 text-[#F23645]">Precio Venta</th>
                  <th className="py-2 text-right">Vol. Venta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E222D]">
                {orderBook.map((r) => {
                  const bidPct = Math.round((r.bidSize / maxBookSize) * 100);
                  const askPct = Math.round((r.askSize / maxBookSize) * 100);
                  return (
                    <tr key={r.lvl} className="h-9">
                      <td className="text-left text-[#9CA3AF]">
                        {r.bidSize.toLocaleString('es-AR')}
                      </td>
                      <td
                        onClick={() =>
                          onOpenOrderTicket({
                            ticker: stock.ticker,
                            side: 'Venta',
                            price: r.bidPrice,
                            qty: 100,
                            instrumentLabel: `${stock.name} Contado`,
                          })
                        }
                        style={{
                          background: `linear-gradient(270deg, rgba(34, 197, 94, 0.22) ${bidPct}%, transparent ${bidPct}%)`,
                        }}
                        className="text-right pr-2.5 font-bold text-[#22C55E] cursor-pointer hover:brightness-125"
                      >
                        $ {fmtNum(r.bidPrice, 2)}
                      </td>
                      <td
                        onClick={() =>
                          onOpenOrderTicket({
                            ticker: stock.ticker,
                            side: 'Compra',
                            price: r.askPrice,
                            qty: 100,
                            instrumentLabel: `${stock.name} Contado`,
                          })
                        }
                        style={{
                          background: `linear-gradient(90deg, rgba(242, 54, 69, 0.22) ${askPct}%, transparent ${askPct}%)`,
                        }}
                        className="text-left pl-2.5 font-bold text-[#F23645] cursor-pointer hover:brightness-125 border-l border-[#232733]"
                      >
                        $ {fmtNum(r.askPrice, 2)}
                      </td>
                      <td className="text-right text-[#9CA3AF]">
                        {r.askSize.toLocaleString('es-AR')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Resumen estadístico de la rueda */}
          <div className="pt-3 border-t border-[#232733] space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#787B86]">
              Resumen Estadístico de Rueda
            </div>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-[12px]">
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Mínimo del día</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">$ {fmtNum(stock.low, 2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Máximo del día</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">$ {fmtNum(stock.high, 2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Volumen total</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">
                  {fmtMoneyCompact(stock.volumeM)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">Operaciones</span>
                <span className="font-mono-num font-bold text-[#FFFFFF]">14.820</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">VWAP del día</span>
                <span className="font-mono-num font-bold text-[#EAB308]">$ {fmtNum(stock.vwap, 2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#9CA3AF]">vs. Habitual</span>
                <span className="font-mono-num font-bold text-[#22C55E]">
                  {fmtNum(stock.volMultiple, 1)}x
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          3. MONITOR DE ARBITRAJE ADR & FX
          ===================================================================== */}
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[14.5px] font-bold text-[#FFFFFF]">
            Monitor de Arbitraje ADR & FX ({stock.ticker})
          </h3>
          <span className="text-[11px] font-mono-num text-[#787B86]">
            Factor conversión ADR: {adrRatio} acc. locales = 1 ADR NYSE
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">ADR Wall Street (USD)</div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
                US$ {fmtNum(adrUsd, 2)}
              </span>
              <DeltaPill value={stock.adrDeltaPct ?? stock.deltaPct + 0.35} size="sm" />
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">ADR Teórico en ARS</div>
            <div className="font-mono-num text-[17px] font-bold text-[#38BDF8]">
              $ {fmtNum(adrTheoreticalArs, 2)}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#787B86]">
              Dif. local: {fmtNum(((stock.last - adrTheoreticalArs) / adrTheoreticalArs) * 100, 2)} %
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">CCL {stock.ticker} vs. General</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              $ {fmtNum(cclSpecific, 2)}
            </div>
            <div className="text-[10.5px] font-mono-num text-[#22C55E]">
              Canasta CCL: $ {fmtNum(cclGeneral, 2)}
            </div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">Dólar MEP (AL30)</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              $ 1.142,50
            </div>
            <div className="text-[10.5px] font-mono-num text-[#787B86]">Canje CCL/MEP: 2,30 %</div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">Dólar Oficial Mayorista</div>
            <div className="font-mono-num text-[17px] font-bold text-[#FFFFFF]">
              $ 1.078,20
            </div>
            <div className="text-[10.5px] font-mono-num text-[#22C55E]">Brecha CCL: 8,4 %</div>
          </div>

          <div className="p-3.5 rounded-[10px] bg-[#0B0E14] border border-[#1E222D] space-y-1">
            <div className="text-[11px] text-[#787B86]">DLR Futuro Rofex Prox.</div>
            <div className="font-mono-num text-[17px] font-bold text-[#EAB308]">
              $ 1.108,00
            </div>
            <div className="text-[10.5px] font-mono-num text-[#9CA3AF]">Tasa impl.: 26,7 % TNA</div>
          </div>
        </div>
      </div>
    </div>
  );
};
