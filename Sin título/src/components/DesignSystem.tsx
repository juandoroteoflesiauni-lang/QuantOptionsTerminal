import React, { useState } from 'react';
import { HelpCircle, Sparkles } from 'lucide-react';
import { fmtNum } from '../data/marketData';

export const HelpTooltip: React.FC<{ title?: string; text: string; formula?: string }> = ({
  title,
  text,
  formula,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Ayuda contextual"
        className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors cursor-help"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 rounded-[10px] bg-[var(--surface-2)] border border-[var(--border-strong)] text-left z-50 pointer-events-none"
          style={{ boxShadow: 'var(--elev-3)' }}
        >
          {title && (
            <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-primary)] mb-1">
              {title}
            </div>
          )}
          <p className="text-[12px] leading-[17px] text-[var(--text-secondary)] font-normal">
            {text}
          </p>
          {formula && (
            <div className="mt-2 pt-1.5 border-t border-[var(--border-subtle)] font-mono-num text-[11px] text-[var(--accent-primary)]">
              {formula}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const InsightBanner: React.FC<{
  children: React.ReactNode;
  tag?: string;
  variant?: 'default' | 'pos' | 'neg' | 'warn' | 'call';
}> = ({ children, tag = 'Lectura en vivo', variant = 'default' }) => {
  const borderMap = {
    default: 'border-l-[var(--accent-primary)] bg-[var(--surface-2)]/70',
    pos: 'border-l-[var(--pos-fg)] bg-[var(--pos-bg)]/35',
    neg: 'border-l-[var(--neg-fg)] bg-[var(--neg-bg)]/35',
    warn: 'border-l-[var(--warn-fg)] bg-[var(--warn-bg)]/35',
    call: 'border-l-[var(--call-fg)] bg-[var(--call-tint)]/60',
  };

  return (
    <div
      className={`flex items-center gap-2.5 px-3.5 py-2 rounded-r-[10px] rounded-l-[4px] border border-[var(--border-subtle)] border-l-[3px] ${borderMap[variant]} text-[13px] leading-[20px] text-[var(--text-secondary)]`}
    >
      <Sparkles className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--text-primary)] shrink-0">
        {tag}
      </span>
      <div className="truncate">{children}</div>
    </div>
  );
};

export const DeltaPill: React.FC<{
  value: number;
  decimals?: number;
  suffix?: string;
  size?: 'sm' | 'md';
  showArrow?: boolean;
}> = ({ value, decimals = 2, suffix = '%', size = 'md', showArrow = true }) => {
  const abs = Math.abs(value);
  const isPos = value > 0.001;
  const isNeg = value < -0.001;

  const colorClass = isPos
    ? 'text-[#22C55E]'
    : isNeg
    ? 'text-[#F23645]'
    : 'text-[#787B86]';

  const sign = isPos ? '+' : isNeg ? '-' : '';
  const arrow = showArrow ? (isPos ? '↗ ' : isNeg ? '↘ ' : '') : '';
  const formatted = `${sign}${abs.toFixed(decimals).replace('.', ',')}${suffix === '%' ? ' %' : ` ${suffix}`}`;

  return (
    <span
      className={`inline-flex items-center font-mono-num font-semibold whitespace-nowrap ${
        size === 'sm' ? 'text-[12px] leading-[16px]' : 'text-[13px] leading-[18px]'
      } ${colorClass}`}
    >
      {arrow}
      {formatted}
    </span>
  );
};

export const PriceCell: React.FC<{
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  flashDirection?: 'up' | 'down' | null;
  className?: string;
}> = ({ value, decimals = 2, prefix = '$ ', suffix = '', flashDirection = null, className = '' }) => {
  const flashClass =
    flashDirection === 'up' ? 'tick-up text-[var(--pos-fg)]' : flashDirection === 'down' ? 'tick-down text-[var(--neg-fg)]' : '';

  return (
    <span
      className={`inline-flex items-center justify-end px-1.5 py-0.5 rounded-[6px] font-mono-num transition-colors ${flashClass} ${className}`}
    >
      <span key={value} className={flashDirection ? 'num-roll' : ''}>
        {prefix}
        {fmtNum(value, decimals)}
        {suffix}
      </span>
    </span>
  );
};

export const RangeBar: React.FC<{
  low: number;
  high: number;
  current: number;
  prevClose?: number;
  widthClass?: string;
}> = ({ low, high, current, prevClose, widthClass = 'w-28' }) => {
  const span = Math.max(high - low, 0.0001);
  const pct = Math.min(100, Math.max(0, ((current - low) / span) * 100));
  const prevPct =
    prevClose !== undefined ? Math.min(100, Math.max(0, ((prevClose - low) / span) * 100)) : null;
  const isAbovePrev = prevClose === undefined || current >= prevClose;

  return (
    <div className={`flex flex-col gap-1 ${widthClass}`}>
      <div className="relative h-1.5 rounded-full bg-[var(--surface-3)] overflow-visible">
        <div
          className="absolute top-0 bottom-0 rounded-full"
          style={{
            left: `${Math.min(pct, prevPct ?? 0)}%`,
            width: `${Math.max(6, Math.abs(pct - (prevPct ?? 0)))}%`,
            backgroundColor: isAbovePrev ? 'var(--pos-fg)' : 'var(--neg-fg)',
            opacity: 0.75,
          }}
        />
        {prevPct !== null && (
          <div
            title={`Cierre previo: $ ${fmtNum(prevClose!, 2)}`}
            className="absolute -top-0.5 w-0.5 h-2.5 bg-[var(--text-tertiary)]"
            style={{ left: `${prevPct}%` }}
          />
        )}
        <div
          className="absolute -top-0.5 w-2 h-2.5 rounded-full border border-[var(--bg-app)]"
          style={{
            left: `calc(${pct}% - 4px)`,
            backgroundColor: isAbovePrev ? 'var(--pos-fg)' : 'var(--neg-fg)',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono-num text-[var(--text-tertiary)] leading-none">
        <span>{fmtNum(low, 0)}</span>
        <span>{fmtNum(high, 0)}</span>
      </div>
    </div>
  );
};

export const ValuationGauge: React.FC<{
  rank: 'barata' | 'rango' | 'cara';
  percentile?: number;
}> = ({ rank, percentile }) => {
  const config = {
    barata: { label: 'Barata', color: '#3F9B5F', bg: 'rgba(63, 155, 95, 0.18)', pos: percentile ?? 22 },
    rango: { label: 'En su rango', color: '#8B7CF6', bg: 'rgba(74, 74, 92, 0.35)', pos: percentile ?? 50 },
    cara: { label: 'Cara', color: '#F5B544', bg: 'rgba(168, 138, 42, 0.25)', pos: percentile ?? 82 },
  }[rank];

  return (
    <div className="inline-flex items-center gap-2">
      <div className="w-12 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden flex">
        <div className="w-1/3 h-full bg-[#3F9B5F]/50" />
        <div className="w-1/3 h-full bg-[#4A4A5C]/60" />
        <div className="w-1/3 h-full bg-[#A88A2A]/60" />
      </div>
      <span
        className="text-[11px] font-medium px-1.5 py-0.5 rounded"
        style={{ color: config.color, backgroundColor: config.bg }}
      >
        {config.label}
        {percentile !== undefined ? ` · P${percentile}` : ''}
      </span>
    </div>
  );
};

export const MiniSparkline: React.FC<{
  data: number[];
  positive?: boolean;
  color?: string;
  width?: number;
  height?: number;
}> = ({ data, positive = true, color, width = 88, height = 28 }) => {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = Math.max(max - min, 0.0001);
  const strokeColor = color ?? (positive ? 'var(--pos-fg)' : 'var(--neg-fg)');
  const gradId = `spark-${Math.random().toString(36).substring(2, 8)}`;

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - 4) + 2;
    const y = height - 4 - ((v - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylineStr = pts.join(' ');
  const areaStr = `2,${height - 2} ${polylineStr} ${width - 2},${height - 2}`;

  return (
    <svg width={width} height={height} className="overflow-visible shrink-0">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <polygon points={areaStr} fill={`url(#${gradId})`} />
      <polyline
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polylineStr}
      />
    </svg>
  );
};

export const TickerChip: React.FC<{
  ticker: string;
  color?: string;
  selected?: boolean;
  sub?: string;
  onClick?: () => void;
}> = ({ ticker, color = '#8B7CF6', selected = false, sub, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-[8px] text-[12px] font-semibold transition-all cursor-pointer ${
        selected
          ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)] border border-[var(--accent-primary)]'
          : 'bg-[var(--surface-2)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]'
      }`}
      style={selected ? { boxShadow: 'var(--glow-accent)' } : undefined}
    >
      <span
        className="w-4 h-4 rounded-full inline-flex items-center justify-center text-[9px] font-bold text-white shrink-0"
        style={{ backgroundColor: color }}
      >
        {ticker.slice(0, 2)}
      </span>
      <span className="font-mono-num tracking-tight">{ticker}</span>
      {sub && <span className="text-[10px] text-[var(--text-tertiary)] font-mono-num">{sub}</span>}
    </button>
  );
};

export const KPICard: React.FC<{
  title: string;
  heroValue: string;
  deltaPct?: number;
  subtitle?: string;
  helpText?: string;
  helpFormula?: string;
  sparkline?: number[];
  gauge?: 'barata' | 'rango' | 'cara';
  gaugePercentile?: number;
  badge?: string;
  onClick?: () => void;
}> = ({
  title,
  heroValue,
  deltaPct,
  subtitle,
  helpText,
  helpFormula,
  badge,
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={`px-5 py-4 rounded-[10px] bg-[#131722] border border-[#232733] hover:border-[#343B4F] transition-all flex flex-col justify-between gap-2 ${
        onClick ? 'cursor-pointer hover:bg-[#161B28]' : ''
      }`}
    >
      {/* Nivel 1: Header de la card */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] font-medium text-[#9CA3AF] truncate">
            {title}
          </span>
          {helpText && <HelpTooltip title={title} text={helpText} formula={helpFormula} />}
        </div>
        {badge && (
          <span className="text-[10px] font-mono-num font-semibold uppercase tracking-wider text-[#787B86]">
            {badge}
          </span>
        )}
      </div>

      {/* Nivel 2: Métrica central + Variación limpia inmediata a la derecha */}
      <div className="flex items-baseline gap-2.5 pt-0.5">
        <div className="font-mono-num text-[23px] leading-[28px] font-bold text-[#FFFFFF] tracking-tight">
          {heroValue}
        </div>
        {deltaPct !== undefined && <DeltaPill value={deltaPct} size="md" />}
      </div>

      {/* Nivel 3: Submétrica secundaria única y concisa */}
      {subtitle && (
        <div className="text-[11.5px] text-[#787B86] leading-snug truncate">
          {subtitle}
        </div>
      )}
    </div>
  );
};

export const HeatTile: React.FC<{
  ticker: string;
  deltaPct: number;
  price?: string;
  subtitle?: string;
  color?: string;
  selected?: boolean;
  onClick?: () => void;
}> = ({ ticker, deltaPct, price, subtitle, color = '#3B82F6', selected = false, onClick }) => {
  const isPos = deltaPct > 0.001;
  const isNeg = deltaPct < -0.001;

  // Color de fondo condicional según rendimiento (Heatmap sobrio)
  let bgStyle = 'bg-[#1A1E29] border-[#262B3B]';
  if (isPos) {
    bgStyle =
      deltaPct >= 2.5
        ? 'bg-[#0E382B]/90 border-[#165B43]/70'
        : 'bg-[#0D281E]/85 border-[#144634]/60';
  } else if (isNeg) {
    bgStyle =
      deltaPct <= -2.0
        ? 'bg-[#381419]/90 border-[#63222B]/70'
        : 'bg-[#2D1418]/85 border-[#4D1E26]/60';
  }

  const pctColor = isPos
    ? 'text-[#22C55E]'
    : isNeg
    ? 'text-[#F23645]'
    : 'text-[#787B86]';

  const sign = isPos ? '+' : isNeg ? '-' : '';
  const formattedPct = `${sign}${Math.abs(deltaPct).toFixed(2).replace('.', ',')} %`;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative px-3.5 py-2.5 rounded-[8px] text-left transition-all duration-150 cursor-pointer flex flex-col justify-between min-h-[64px] border ${bgStyle} ${
        selected
          ? 'ring-1 ring-[#3B82F6] border-[#3B82F6]'
          : 'hover:border-[#3B82F6]/80 hover:brightness-110'
      }`}
    >
      {/* Fila Superior: Avatar circular 24x24 + Ticker en bold blanco + Precio */}
      <div className="flex items-center justify-between gap-2 w-full">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-[24px] h-[24px] rounded-full inline-flex items-center justify-center text-[9.5px] font-extrabold text-white shrink-0 shadow-sm"
            style={{ backgroundColor: color }}
          >
            {ticker.slice(0, 2)}
          </span>
          <span className="font-bold text-[13.5px] text-[#FFFFFF] tracking-tight truncate">
            {ticker}
          </span>
        </div>
        {price && (
          <span className="font-mono-num text-[11px] text-[#9CA3AF] group-hover:text-[#D1D4DC] transition-colors shrink-0">
            {price}
          </span>
        )}
      </div>

      {/* Fila Inferior: Variación porcentual directa + Micro-indicador de volumen relativo */}
      <div className="mt-1.5 flex items-center justify-between w-full">
        <span className={`font-mono-num text-[12.5px] font-semibold ${pctColor}`}>
          {formattedPct}
        </span>
        {subtitle && (
          <span className="font-mono-num text-[10.5px] text-[#787B86] group-hover:text-[#9CA3AF]">
            {subtitle}
          </span>
        )}
      </div>
    </button>
  );
};
