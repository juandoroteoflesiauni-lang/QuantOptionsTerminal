import React from 'react';
import { Activity, ShieldAlert } from 'lucide-react';
import {
  NULL_DISPLAY,
  fmtDecimalPct,
  fmtNum,
  fmtPct,
  fmtUtcTimeET,
  isFiniteNum,
  type SerializedMarketContext,
  type WsConnectionStatus,
} from '../api/terminalClient';

export interface MarketTickerBarProps {
  readonly activeSymbol: string;
  readonly marketContext: SerializedMarketContext | null;
  readonly asOfUtcSec: number | null;
  readonly wsStatus: WsConnectionStatus;
  readonly onSelectSymbol?: (symbol: string) => void;
}

export const MarketTickerBar: React.FC<MarketTickerBarProps> = ({
  activeSymbol,
  marketContext,
  asOfUtcSec,
  wsStatus,
  onSelectSymbol,
}) => {
  const quotes = marketContext?.unifiedQuotes ?? [];

  const wsBadge =
    wsStatus === 'connected'
      ? { dot: 'bg-[#2EDC7E]', text: 'WS LIVE', color: 'text-[#2EDC7E]' }
      : wsStatus === 'connecting'
        ? { dot: 'bg-[#F5B544] animate-pulse', text: 'WS SYNC', color: 'text-[#F5B544]' }
        : { dot: 'bg-[#FF5C63]', text: 'WS OFFLINE', color: 'text-[#FF5C63]' };

  return (
    <div className="w-full h-9 bg-[#090B10] border-b border-[#1E1E2B] px-3 flex items-center justify-between gap-4 overflow-x-auto no-scrollbar select-none">
      {/* Live Unified Snapshots + Macro Benchmarks */}
      <div className="flex items-center gap-4 shrink-0">
        {quotes.length === 0 ? (
          <span className="text-[11px] font-mono-num text-[#6D6D84]">
            Quotes en espera ({activeSymbol}): {NULL_DISPLAY}
          </span>
        ) : (
          quotes.map((q) => {
            const isSelected = q.ticker === activeSymbol;
            const validChange = isFiniteNum(q.changePct);
            const changeColor = !validChange
              ? 'text-[#6D6D84]'
              : q.changePct > 0.0001
                ? 'text-[#2EDC7E]'
                : q.changePct < -0.0001
                  ? 'text-[#FF5C63]'
                  : 'text-[#A4A4BA]';

            return (
              <button
                key={q.ticker}
                type="button"
                onClick={() => onSelectSymbol?.(q.ticker)}
                className={`inline-flex items-center gap-2 px-2 py-0.5 rounded-[6px] text-[11.5px] font-mono-num transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[#241F48] border border-[#8B7CF6]/50 text-[#F3F3F9]'
                    : 'hover:bg-[#171722] text-[#A4A4BA]'
                }`}
              >
                <span className="font-bold text-[#F3F3F9]">{q.ticker}</span>
                <span className={isFiniteNum(q.price) ? 'text-[#F3F3F9]' : 'text-[#6D6D84]'}>
                  {fmtNum(q.price, 2)}
                </span>
                <span className={changeColor}>
                  {fmtPct(q.changePct, 2, true)}
                </span>
              </button>
            );
          })
        )}

        <span className="h-3.5 w-px bg-[#1E1E2B]" />

        {/* VIX / SKEW / US10Y / SOFR */}
        <div className="flex items-center gap-3 text-[11px] font-mono-num">
          <span className="text-[#6D6D84]">
            VIX{' '}
            <strong
              className={
                isFiniteNum(marketContext?.vixLevel) ? 'text-[#F5B544]' : 'text-[#6D6D84]'
              }
            >
              {fmtNum(marketContext?.vixLevel, 2)}
            </strong>
          </span>
          <span className="text-[#6D6D84]">
            SKEW{' '}
            <strong
              className={
                isFiniteNum(marketContext?.skewLevel) ? 'text-[#F3F3F9]' : 'text-[#6D6D84]'
              }
            >
              {fmtNum(marketContext?.skewLevel, 1)}
            </strong>
          </span>
          <span className="text-[#6D6D84]">
            US10Y{' '}
            <strong
              className={
                isFiniteNum(marketContext?.treasury.yield10Y) ? 'text-[#4BA3FF]' : 'text-[#6D6D84]'
              }
            >
              {fmtDecimalPct(marketContext?.treasury.yield10Y, 2)}
            </strong>
          </span>
          <span className="text-[#6D6D84]">
            SOFR{' '}
            <strong
              className={
                isFiniteNum(marketContext?.treasury.sofr) ? 'text-[#34D3C7]' : 'text-[#6D6D84]'
              }
            >
              {fmtDecimalPct(marketContext?.treasury.sofr, 2)}
            </strong>
          </span>
          {marketContext?.tailRiskAlert === true && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#331519] border border-[#6C2931] text-[#FF5C63] font-bold text-[10px]">
              <ShieldAlert className="w-3 h-3" />
              TAIL RISK
            </span>
          )}
        </div>
      </div>

      {/* Estado de conexion WS + Timestamp ET */}
      <div className="flex items-center gap-3 shrink-0 text-[11px] font-mono-num">
        <div className={`inline-flex items-center gap-1.5 ${wsBadge.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${wsBadge.dot}`} />
          <Activity className="w-3 h-3" />
          <span className="font-semibold">{wsBadge.text}</span>
        </div>
        <span className="text-[#6D6D84]">
          AsOf:{' '}
          <strong className={asOfUtcSec ? 'text-[#A4A4BA]' : 'text-[#6D6D84]'}>
            {fmtUtcTimeET(asOfUtcSec)}
          </strong>
        </span>
      </div>
    </div>
  );
};
