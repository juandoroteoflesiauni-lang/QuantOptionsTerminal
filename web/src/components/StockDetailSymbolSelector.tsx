import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { fmtNum } from '../data/marketData';
import { CompanyLogo } from './common/CompanyLogo';

export type StockDetailCategory = 'US_STOCKS' | 'PANEL_LIDER' | 'PANEL_GENERAL' | 'CEDEARS';

export interface StockDetailSelectorItem {
  readonly key: string;
  /** Pieza 41: identidad calificada AR:/US: propagada al callback. */
  readonly selectionKey: string;
  readonly ticker: string;
  readonly name: string;
  readonly category: StockDetailCategory;
  readonly categoryLabel: string;
  readonly venue: 'OPRA' | 'BYMA';
  readonly currency: 'USD' | 'ARS';
  readonly sector: string;
  readonly price: number;
  readonly changePct: number;
  readonly ratio: number | null;
  readonly cclImplicit: number | null;
}

export interface StockDetailSymbolSelectorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (ticker: string) => void;
  readonly selectedTicker: string;
  readonly items: readonly StockDetailSelectorItem[];
  readonly status: 'IDLE' | 'LOADING' | 'OK' | 'NO_DATA';
  readonly selectedName: string;
  readonly selectedPrice: number;
  readonly selectedChangePct: number;
  readonly selectedFlash: 'up' | 'down' | null;
}

const CATEGORY_TABS: readonly {
  readonly id: StockDetailCategory;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: 'US_STOCKS', label: 'US Stocks', hint: 'NYSE · NASDAQ · USD' },
  { id: 'PANEL_LIDER', label: 'Panel Líder', hint: 'BYMA · ARS' },
  { id: 'PANEL_GENERAL', label: 'Panel General', hint: 'BYMA · ARS' },
  { id: 'CEDEARS', label: 'CEDEARs', hint: 'BYMA · Ratio · CCL' },
];

const CATEGORY_RANK: Readonly<Record<StockDetailCategory, number>> = {
  US_STOCKS: 0,
  PANEL_LIDER: 1,
  PANEL_GENERAL: 2,
  CEDEARS: 3,
};

const normalizeSearchText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

function categoryForTicker(
  ticker: string,
  items: readonly StockDetailSelectorItem[],
): StockDetailCategory {
  const match = items.find((item) => item.selectionKey === ticker || item.ticker === ticker);
  return match?.category ?? 'US_STOCKS';
}

export const StockDetailSymbolSelector: React.FC<StockDetailSymbolSelectorProps> = ({
  open,
  onClose,
  onSelect,
  selectedTicker,
  items,
  status,
  selectedName,
  selectedPrice,
  selectedChangePct,
  selectedFlash,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeCategory, setActiveCategory] = useState<StockDetailCategory>(() =>
    categoryForTicker(selectedTicker, items),
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveCategory(categoryForTicker(selectedTicker, items));
  }, [items, open, selectedTicker]);

  const categoryItems = useMemo(
    () => items.filter((item) => item.category === activeCategory),
    [activeCategory, items],
  );

  const filtered = useMemo(() => {
    const q = normalizeSearchText(query);
    if (q === '') return categoryItems;
    return categoryItems.filter(
      (item) =>
        normalizeSearchText(item.ticker).includes(q) ||
        normalizeSearchText(item.name).includes(q) ||
        normalizeSearchText(item.sector).includes(q),
    );
  }, [categoryItems, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [activeCategory, query]);

  useEffect(() => {
    if (!open) return;
    const idx = filtered.findIndex((item) => item.ticker === selectedTicker);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [filtered, open, selectedTicker]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((idx) => Math.min(filtered.length - 1, idx + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((idx) => Math.max(0, idx - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const item = filtered[activeIndex];
        if (item) {
          onSelect(item.selectionKey);
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeIndex, filtered, onClose, onSelect, open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open) return null;

  const activeItem = filtered[activeIndex];

  return (
    <div
      onClick={onClose}
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh] bg-black/65 backdrop-blur-[4px]"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Selector unificado de acciones y CEDEARs"
        className="w-full max-w-3xl overflow-hidden rounded-[16px] border border-[#1C1C24] bg-[#0A0A0D] shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
      >
        <div className="flex items-center gap-3 border-b border-[#1C1C24] bg-[#111116] px-4 py-3">
          <CompanyLogo
            ticker={selectedTicker}
            name={selectedName}
            size="sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 truncate text-[13px] font-bold text-[#F3F4F6]">
              <span>{selectedTicker}</span>
              <span className="rounded-full border border-[#252532] bg-[#16161D] px-1.5 py-0.5 font-mono-num text-[10px] text-[#9CA3AF]">
                {categoryForTicker(selectedTicker, items)}
              </span>
            </div>
            <div className="truncate text-[11.5px] text-[#9CA3AF]">{selectedName}</div>
          </div>
          <div className="text-right font-mono-num text-[12px]">
            <div
              className="rounded px-1 text-[#F9FAFB] transition-colors duration-[400ms]"
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
            </div>
            <div className={selectedChangePct >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'}>
              {Number.isFinite(selectedChangePct)
                ? `${selectedChangePct >= 0 ? '+' : ''}${fmtNum(selectedChangePct, 2)} %`
                : '—'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar selector"
            className="rounded p-1 text-[#787B86] transition-colors hover:bg-[#161A25] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-[#1C1C24] bg-[#0A0A0D] px-4 py-2">
          {CATEGORY_TABS.map((tab) => {
            const count = items.filter((item) => item.category === tab.id).length;
            const active = activeCategory === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveCategory(tab.id)}
                title={tab.hint}
                className={`rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#8B7CF6]/20 text-white border border-[#8B7CF6]/60'
                    : 'border border-[#252532] bg-[#111116] text-[#9CA3AF] hover:text-white hover:border-[#2E3446]'
                }`}
              >
                {tab.label}
                <span className="ml-1.5 font-mono-num text-[10px] text-[#787B86]">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-b border-[#1C1C24] bg-[#0A0A0D] px-4 py-2.5">
          <Search className="h-4 w-4 text-[#8B7CF6]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por ticker, empresa o sector…"
            aria-label="Buscar acción o CEDEAR"
            className="w-full bg-transparent font-mono-num text-[13px] text-white outline-none placeholder:text-[#6D7282]"
          />
          <kbd className="rounded border border-[#232733] bg-[#111116] px-1.5 py-0.5 font-mono-num text-[10px] text-[#787B86]">
            {filtered.length}
          </kbd>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="Acciones disponibles"
          className="max-h-[50vh] overflow-y-auto p-2"
        >
          {status === 'NO_DATA' && (
            <div className="px-3 py-6 text-center text-[12.5px] text-[#787B86]">
              Universo de acciones no disponible (sin respuesta del runtime).
            </div>
          )}
          {status !== 'NO_DATA' && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-[#787B86]">
              Sin coincidencias en ticker, empresa o sector.
            </div>
          )}
          {filtered.map((item, idx) => (
            <button
              key={`${item.category}:${item.key}`}
              type="button"
              role="option"
              aria-selected={idx === activeIndex}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => {
                onSelect(item.selectionKey);
                onClose();
              }}
              className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors cursor-pointer ${
                idx === activeIndex ? 'bg-[#211B3A]' : 'hover:bg-[#161A25]'
              }`}
            >
              <CompanyLogo ticker={item.ticker} name={item.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono-num text-[13px] font-bold text-white">{item.ticker}</span>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 font-mono-num text-[9.5px] font-semibold ${
                      item.venue === 'OPRA'
                        ? 'border-[#38BDF8]/35 bg-[#38BDF8]/10 text-[#38BDF8]'
                        : 'border-[#EAB308]/35 bg-[#EAB308]/10 text-[#EAB308]'
                    }`}
                  >
                    {item.venue === 'OPRA' ? 'US · OPRA' : 'AR · BYMA'}
                  </span>
                  {item.ticker === selectedTicker && (
                    <span className="rounded-full border border-[#8B7CF6]/40 bg-[#8B7CF6]/10 px-1.5 py-0.5 font-mono-num text-[9.5px] text-[#C4B5FD]">
                      activo
                    </span>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-[#9CA3AF]">{item.name}</div>
              </div>
              <div className="shrink-0 text-right font-mono-num text-[11px]">
                <div className={item.changePct >= 0 ? 'text-[#22C55E]' : 'text-[#F23645]'}>
                  {Number.isFinite(item.price) ? `$ ${fmtNum(item.price, 2)}` : '—'}
                </div>
                <div className="text-[#787B86]">
                  {Number.isFinite(item.changePct)
                    ? `${item.changePct >= 0 ? '+' : ''}${fmtNum(item.changePct, 2)} %`
                    : '—'}
                </div>
                {item.category === 'CEDEARS' && (
                  <div className="text-[9.5px] text-[#9CA3AF]">
                    {item.ratio !== null ? `${fmtNum(item.ratio, 0)}:1` : '—'} · CCL{' '}
                    {item.cclImplicit !== null ? fmtNum(item.cclImplicit, 2) : '—'}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[#1C1C24] px-4 py-2 font-mono-num text-[10.5px] text-[#6D7282]">
          <span>
            {activeItem
              ? `${activeItem.categoryLabel} · ${activeItem.sector} · ${activeItem.currency}`
              : '—'}
          </span>
          <span>↑↓ navegar · Enter seleccionar · Esc cerrar</span>
        </div>
      </div>
    </div>
  );
};

export function stockDetailCategoryRank(category: StockDetailCategory): number {
  return CATEGORY_RANK[category];
}
