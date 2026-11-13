import React, { useId, useState } from 'react';
import { AlertTriangle, HelpCircle, RefreshCw, Sparkles } from 'lucide-react';
import { NULL_DISPLAY, fmtNum, isFiniteNum } from '../api/terminalClient';

export const HelpTooltip: React.FC<{
  readonly title?: string;
  readonly text: string;
  readonly formula?: string;
}> = ({ title, text, formula }) => {
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

export const StatusBadge: React.FC<{
  readonly status: 'OK' | 'PARTIAL' | 'NO_DATA';
  readonly label?: string;
}> = ({ status, label }) => {
  const style =
    status === 'OK'
      ? 'bg-[#0E2F20] text-[#2EDC7E] border-[#1C5C3C]'
      : status === 'PARTIAL'
        ? 'bg-[#35280F] text-[#F5B544] border-[#F5B544]/35'
        : 'bg-[#331519] text-[#FF5C63] border-[#6C2931]';

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono-num font-bold uppercase tracking-wider ${style}`}
    >
      {label ?? status}
    </span>
  );
};

export const NoDataPanel: React.FC<{
  readonly reason: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}> = ({ reason, detail, onRetry }) => {
  return (
    <div className="p-6 rounded-[12px] bg-[#131722] border border-[#6C2931]/70 flex flex-col items-center justify-center text-center gap-3">
      <div className="inline-flex items-center gap-2 text-[#FF5C63]">
        <AlertTriangle className="w-4 h-4" />
        <StatusBadge status="NO_DATA" label={`NO_DATA · ${reason}`} />
      </div>
      <p className="text-[13px] text-[#A4A4BA] max-w-xl font-mono-num">{detail}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[8px] bg-[#171722] border border-[#30303F] text-[12px] text-[#F3F3F9] hover:border-[#8B7CF6] cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reintentar
        </button>
      )}
    </div>
  );
};

export const InsightBanner: React.FC<{
  readonly children: React.ReactNode;
  readonly tag?: string;
  readonly variant?: 'default' | 'pos' | 'neg' | 'warn' | 'call';
}> = ({ children, tag = 'Lectura cuantitativa', variant = 'default' }) => {
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
  readonly value: number | null | undefined;
  readonly decimals?: number;
  readonly suffix?: string;
  readonly size?: 'sm' | 'md';
  readonly showArrow?: boolean;
}> = ({ value, decimals = 2, suffix = '%', size = 'md', showArrow = true }) => {
  if (!isFiniteNum(value)) {
    return (
      <span
        className={`inline-flex items-center font-mono-num font-semibold text-[#6D6D84] ${
          size === 'sm' ? 'text-[12px] leading-[16px]' : 'text-[13px] leading-[18px]'
        }`}
      >
        {NULL_DISPLAY}
      </span>
    );
  }

  const abs = Math.abs(value);
  const isPos = value > 0.0001;
  const isNeg = value < -0.0001;

  const colorClass = isPos
    ? 'text-[#22C55E]'
    : isNeg
      ? 'text-[#F23645]'
      : 'text-[#6D6D84]';

  const sign = isPos ? '+' : isNeg ? '-' : '';
  const arrow = showArrow ? (isPos ? '↗ ' : isNeg ? '↘ ' : '') : '';
  const formatted = `${sign}${abs.toFixed(decimals)}${suffix === '%' ? '%' : ` ${suffix}`}`;

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
  readonly value: number | null | undefined;
  readonly decimals?: number;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly flashDirection?: 'up' | 'down' | null;
  readonly className?: string;
}> = ({ value, decimals = 2, prefix = '$', suffix = '', flashDirection = null, className = '' }) => {
  if (!isFiniteNum(value)) {
    return (
      <span className={`inline-flex items-center justify-end font-mono-num text-[#6D6D84] ${className}`}>
        {NULL_DISPLAY}
      </span>
    );
  }

  const flashClass =
    flashDirection === 'up'
      ? 'tick-up text-[var(--pos-fg)]'
      : flashDirection === 'down'
        ? 'tick-down text-[var(--neg-fg)]'
        : '';

  return (
    <span
      className={`inline-flex items-center justify-end px-1.5 py-0.5 rounded-[6px] font-mono-num transition-colors ${flashClass} ${className}`}
    >
      <span>
        {prefix}
        {fmtNum(value, decimals)}
        {suffix}
      </span>
    </span>
  );
};

export const RangeBar: React.FC<{
  readonly low: number | null | undefined;
  readonly high: number | null | undefined;
  readonly current: number | null | undefined;
  readonly prevClose?: number | null;
  readonly widthClass?: string;
}> = ({ low, high, current, prevClose, widthClass = 'w-28' }) => {
  if (!isFiniteNum(low) || !isFiniteNum(high) || !isFiniteNum(current) || high <= low) {
    return (
      <div className={`text-[11px] font-mono-num text-[#6D6D84] ${widthClass}`}>
        {NULL_DISPLAY}
      </div>
    );
  }

  const span = high - low;
  const pct = Math.min(100, Math.max(0, ((current - low) / span) * 100));
  const hasPrev = isFiniteNum(prevClose);
  const prevPct = hasPrev ? Math.min(100, Math.max(0, ((prevClose - low) / span) * 100)) : null;
  const isAbovePrev = !hasPrev || current >= prevClose;
  const barStartPct = prevPct !== null ? Math.min(pct, prevPct) : pct;
  const barWidthPct = prevPct !== null ? Math.max(4, Math.abs(pct - prevPct)) : 4;

  return (
    <div className={`flex flex-col gap-1 ${widthClass}`}>
      <div className="relative h-1.5 rounded-full bg-[var(--surface-3)] overflow-visible">
        <div
          className="absolute top-0 bottom-0 rounded-full"
          style={{
            left: `${String(barStartPct)}%`,
            width: `${String(barWidthPct)}%`,
            backgroundColor: isAbovePrev ? 'var(--pos-fg)' : 'var(--neg-fg)',
            opacity: 0.75,
          }}
        />
        {prevPct !== null && hasPrev && (
          <div
            title={`Prev Close: $${fmtNum(prevClose, 2)}`}
            className="absolute -top-0.5 w-0.5 h-2.5 bg-[var(--text-tertiary)]"
            style={{ left: `${String(prevPct)}%` }}
          />
        )}
        <div
          className="absolute -top-0.5 w-2 h-2.5 rounded-full border border-[var(--bg-app)]"
          style={{
            left: `calc(${String(pct)}% - 4px)`,
            backgroundColor: isAbovePrev ? 'var(--pos-fg)' : 'var(--neg-fg)',
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono-num text-[var(--text-tertiary)] leading-none">
        <span>{fmtNum(low, 2)}</span>
        <span>{fmtNum(high, 2)}</span>
      </div>
    </div>
  );
};

export const MiniSparkline: React.FC<{
  readonly data: readonly (number | null)[];
  readonly positive?: boolean;
  readonly color?: string;
  readonly width?: number;
  readonly height?: number;
}> = ({ data, positive = true, color, width = 88, height = 28 }) => {
  const reactId = useId();
  const clean = data.filter((v): v is number => isFiniteNum(v));
  if (clean.length < 2) {
    return (
      <span className="text-[11px] font-mono-num text-[#6D6D84]">
        {NULL_DISPLAY}
      </span>
    );
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = Math.max(max - min, 1e-6);
  const strokeColor = color ?? (positive ? 'var(--pos-fg)' : 'var(--neg-fg)');
  const gradId = `spark-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const pts = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * (width - 4) + 2;
    const y = height - 4 - ((v - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polylineStr = pts.join(' ');
  const areaStr = `2,${String(height - 2)} ${polylineStr} ${String(width - 2)},${String(height - 2)}`;

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
  readonly ticker: string;
  readonly color?: string;
  readonly selected?: boolean;
  readonly sub?: string;
  readonly onClick?: () => void;
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
        {ticker.replace('I:', '').slice(0, 2)}
      </span>
      <span className="font-mono-num tracking-tight">{ticker}</span>
      {sub && <span className="text-[10px] text-[var(--text-tertiary)] font-mono-num">{sub}</span>}
    </button>
  );
};

export const KPICard: React.FC<{
  readonly title: string;
  readonly heroValue: string;
  readonly isNullValue?: boolean;
  readonly deltaPct?: number | null;
  readonly subtitle?: string;
  readonly helpText?: string;
  readonly helpFormula?: string;
  readonly badge?: string;
  readonly onClick?: () => void;
}> = ({
  title,
  heroValue,
  isNullValue = false,
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
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] font-medium text-[#9CA3AF] truncate">{title}</span>
          {helpText && <HelpTooltip title={title} text={helpText} formula={helpFormula} />}
        </div>
        {badge && (
          <span className="text-[10px] font-mono-num font-semibold uppercase tracking-wider text-[#787B86]">
            {badge}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-2.5 pt-0.5">
        <div
          className={`font-mono-num text-[22px] leading-[28px] font-bold tracking-tight ${
            isNullValue || heroValue === NULL_DISPLAY ? 'text-[#6D6D84]' : 'text-[#FFFFFF]'
          }`}
        >
          {heroValue}
        </div>
        {deltaPct !== undefined && <DeltaPill value={deltaPct} size="md" />}
      </div>

      {subtitle && (
        <div className="text-[11.5px] text-[#787B86] leading-snug truncate">{subtitle}</div>
      )}
    </div>
  );
};

export const HeatTile: React.FC<{
  readonly ticker: string;
  readonly deltaPct: number | null | undefined;
  readonly price?: string;
  readonly subtitle?: string;
  readonly color?: string;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}> = ({ ticker, deltaPct, price, subtitle, color = '#3B82F6', selected = false, onClick }) => {
  const validDelta = isFiniteNum(deltaPct);
  const isPos = validDelta && deltaPct > 0.0001;
  const isNeg = validDelta && deltaPct < -0.0001;

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

  const pctColor = !validDelta
    ? 'text-[#6D6D84]'
    : isPos
      ? 'text-[#22C55E]'
      : isNeg
        ? 'text-[#F23645]'
        : 'text-[#787B86]';

  const sign = isPos ? '+' : isNeg ? '-' : '';
  const formattedPct = validDelta ? `${sign}${Math.abs(deltaPct).toFixed(2)}%` : NULL_DISPLAY;

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
      <div className="flex items-center justify-between gap-2 w-full">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-[24px] h-[24px] rounded-full inline-flex items-center justify-center text-[9.5px] font-extrabold text-white shrink-0 shadow-sm"
            style={{ backgroundColor: color }}
          >
            {ticker.replace('I:', '').slice(0, 2)}
          </span>
          <span className="font-bold text-[13.5px] text-[#FFFFFF] tracking-tight truncate">
            {ticker}
          </span>
        </div>
        {price && (
          <span
            className={`font-mono-num text-[11px] shrink-0 ${
              price === NULL_DISPLAY ? 'text-[#6D6D84]' : 'text-[#9CA3AF] group-hover:text-[#D1D4DC]'
            }`}
          >
            {price}
          </span>
        )}
      </div>

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
