import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { OptionsUnderlyingMetaDto } from '../data/liveTypes';
import { OPTIONS_FAVORITE_KEYS } from '../data/optionsUnderlying';
import { fmtNum } from '../data/marketData';
import { CompanyLogo } from './common/CompanyLogo';

const normalizeSearchText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

export interface OptionsSymbolSelectorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (key: string) => void;
  readonly selectedKey: string;
  readonly underlyings: readonly OptionsUnderlyingMetaDto[];
  readonly status: 'IDLE' | 'LOADING' | 'OK' | 'NO_DATA';
  readonly selectedName: string;
  readonly selectedPrice: number;
  readonly selectedChangePct: number;
  readonly selectedFlash: 'up' | 'down' | null;
}

const favoriteRankByKey = new Map(OPTIONS_FAVORITE_KEYS.map((key, idx) => [key, idx]));

export const OptionsSymbolSelector: React.FC<OptionsSymbolSelectorProps> = ({
  open,
  onClose,
  onSelect,
  selectedKey,
  underlyings,
  status,
  selectedName,
  selectedPrice,
  selectedChangePct,
  selectedFlash,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const normalized = normalizeSearchText(query);
    const matches = underlyings.filter((meta) => {
      if (normalized === '') return true;
      return (
        normalizeSearchText(meta.symbol).includes(normalized) ||
        normalizeSearchText(meta.name).includes(normalized) ||
        normalizeSearchText(meta.sector).includes(normalized) ||
        normalizeSearchText(meta.key).includes(normalized)
      );
    });
    return [...matches].sort((a, b) => {
      const rankA = favoriteRankByKey.get(a.key);
      const rankB = favoriteRankByKey.get(b.key);
      const favA = rankA === undefined ? Number.MAX_SAFE_INTEGER : rankA;
      const favB = rankB === undefined ? Number.MAX_SAFE_INTEGER : rankB;
      if (favA !== favB) return favA - favB;
      return a.symbol.localeCompare(b.symbol) || a.key.localeCompare(b.key);
    });
  }, [query, underlyings]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const selectedIdx = filtered.findIndex((meta) => meta.key === selectedKey);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, selectedKey, filtered]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((idx) => Math.min(filtered.length - 1, idx + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const meta = filtered[activeIndex];
        if (meta) {
          onSelect(meta.key);
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, filtered, onClose, onSelect, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  if (!open) return null;

  const activeMeta = filtered[activeIndex];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh] bg-[rgba(13,17,23,0.92)]"
      role="presentation"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Selector institucional de subyacentes de opciones"
        className="w-full max-w-2xl overflow-hidden rounded-[16px] border border-[#232733] bg-[#0D1017] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-center gap-3 border-b border-[#1E222D] bg-[#101218] px-4 py-3">
          <CompanyLogo
            ticker={parseKeySymbol(selectedKey)}
            name={selectedName}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 truncate text-[13px] font-bold text-white">
              <span>{selectedName}</span>
              <span className="rounded-full border border-[#232733] bg-[#0B0E14] px-1.5 py-0.5 font-mono-num text-[10px] text-[#9CA3AF]">
                {selectedMarketLabel(selectedKey)}
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono-num text-[11px] text-[#787B86]">
              <span
                className="rounded px-1 transition-colors duration-[400ms]"
                style={{
                  backgroundColor:
                    selectedFlash === null
                      ? 'transparent'
                      : selectedFlash === 'up'
                        ? 'rgba(34,197,94,0.15)'
                        : 'rgba(239,68,68,0.15)',
                }}
              >
                {Number.isFinite(selectedPrice) ? `$ ${fmtNum(selectedPrice, 2)}` : '—'}
              </span>
              <span className={selectedChangePct >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'}>
                {Number.isFinite(selectedChangePct)
                  ? `${selectedChangePct >= 0 ? '+' : ''}${fmtNum(selectedChangePct, 2)} %`
                  : '—'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[#787B86] hover:bg-[#161A25] hover:text-white cursor-pointer"
            aria-label="Cerrar selector"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[#1E222D] px-4 py-2.5">
          <Search className="h-4 w-4 text-[#8B7CF6]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por ticker, empresa o sector…"
            aria-label="Buscar subyacente de opciones"
            className="w-full bg-transparent font-mono-num text-[13px] text-white outline-none placeholder:text-[#6D7282]"
          />
          <kbd className="rounded border border-[#232733] bg-[#0B0E14] px-1.5 py-0.5 font-mono-num text-[10px] text-[#787B86]">
            {filtered.length}
          </kbd>
        </div>

        <div
          ref={listRef}
          className="max-h-[52vh] overflow-y-auto p-2"
          role="listbox"
          aria-label="Subyacentes disponibles"
        >
          {status === 'NO_DATA' && (
            <div className="px-3 py-6 text-center text-[12.5px] text-[#787B86]">
              Universo de subyacentes no disponible (endpoint sin respuesta).
            </div>
          )}
          {status !== 'NO_DATA' && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-[#787B86]">
              Sin coincidencias en ticker, empresa o sector.
            </div>
          )}
          {filtered.map((meta, idx) => (
            <button
              key={meta.key}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => {
                onSelect(meta.key);
                onClose();
              }}
              className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors cursor-pointer ${
                idx === activeIndex ? 'bg-[#211B3A]' : 'hover:bg-[#161A25]'
              }`}
            >
              <CompanyLogo ticker={meta.symbol} name={meta.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono-num text-[13px] font-bold text-white">{meta.symbol}</span>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 font-mono-num text-[9.5px] font-semibold ${
                      meta.market === 'US'
                        ? 'border-[#38BDF8]/35 bg-[#38BDF8]/10 text-[#38BDF8]'
                        : 'border-[#EAB308]/35 bg-[#EAB308]/10 text-[#EAB308]'
                    }`}
                  >
                    {meta.market} · {meta.venue}
                  </span>
                  {meta.key === selectedKey && (
                    <span className="rounded-full border border-[#8B7CF6]/40 bg-[#8B7CF6]/10 px-1.5 py-0.5 font-mono-num text-[9.5px] text-[#C4B5FD]">
                      activo
                    </span>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-[#9CA3AF]">{meta.name}</div>
              </div>
              <div className="hidden shrink-0 text-right font-mono-num text-[10.5px] text-[#787B86] sm:block">
                {meta.sector}
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[#1E222D] px-4 py-2 text-[10.5px] font-mono-num text-[#6D7282]">
          <span>{activeMeta ? `${activeMeta.symbol} · ${activeMeta.currency}` : '—'}</span>
          <span>↑↓ navegar · Enter seleccionar · Esc cerrar</span>
        </div>
      </div>
    </div>
  );
};

function parseKeySymbol(key: string): string {
  return key === 'US:GGAL' ? 'GGAL' : key;
}

function selectedMarketLabel(key: string): string {
  if (key === 'US:GGAL') return 'US · OPRA';
  if (key === 'GGAL') return 'AR · BYMA';
  return 'US · OPRA';
}
