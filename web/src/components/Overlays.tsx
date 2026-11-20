import React, { useState, useEffect } from 'react';
import {
  Search,
  X,
  Send,
  Bell,
  Keyboard,
  ArrowRight,
  CheckCircle2,
  Sparkles,
  Layers,
  TrendingUp,
} from 'lucide-react';
import { AR_STOCKS, BONDS_DATA, US_MARKET_DATA, AlertItem, fmtNum } from '../data/marketData';
import { DeltaPill } from './DesignSystem';

export interface OrderTicketPreset {
  ticker: string;
  side: 'Compra' | 'Venta';
  price: number;
  qty: number;
  instrumentLabel: string;
}

export const OrderTicketDrawer: React.FC<{
  open: boolean;
  preset: OrderTicketPreset | null;
  onClose: () => void;
  onSubmitOrder: (order: {
    ticker: string;
    side: 'Compra' | 'Venta';
    qty: number;
    price: number;
    settlement: 'CI' | '24hs';
    orderType: 'Límite' | 'Mercado';
  }) => void;
}> = ({ open, preset, onClose, onSubmitOrder }) => {
  const [ticker, setTicker] = useState('GGAL');
  const [side, setSide] = useState<'Compra' | 'Venta'>('Compra');
  const [price, setPrice] = useState(6480);
  const [qty, setQty] = useState(100);
  const [settlement, setSettlement] = useState<'CI' | '24hs'>('24hs');
  const [orderType, setOrderType] = useState<'Límite' | 'Mercado'>('Límite');
  const [label, setLabel] = useState('Grupo Financiero Galicia (Contado)');

  useEffect(() => {
    if (preset) {
      setTicker(preset.ticker);
      setSide(preset.side);
      setPrice(preset.price);
      setQty(preset.qty);
      setLabel(preset.instrumentLabel);
    }
  }, [preset]);

  if (!open) return null;

  const isOption = ticker.length >= 8 && (ticker.includes('C') || ticker.includes('V'));
  const multiplier = isOption ? 100 : 1;
  const grossAmount = price * qty * multiplier;
  const fees = grossAmount * 0.0058; // 0.58% comisión + derechos BYMA
  const totalAmount = side === 'Compra' ? grossAmount + fees : grossAmount - fees;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(13,17,23,0.92)]">
      <div
        className="w-full max-w-[380px] h-full bg-[var(--bg-sidebar)] border-l border-[var(--border-strong)] p-5 flex flex-col justify-between overflow-y-auto"
        style={{ boxShadow: 'var(--elev-3)' }}
      >
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-bold text-[var(--text-primary)]">
                  Ticket de Orden Simulada
                </span>
                <span className="text-[10px] font-mono-num uppercase px-1.5 py-0.5 rounded bg-[#35280F] text-[#F5B544]">
                  DMA BYMA
                </span>
              </div>
              <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{label}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-[8px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Selector Compra / Venta */}
          <div className="grid grid-cols-2 gap-2 p-1 rounded-[10px] bg-[var(--surface-1)] border border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => setSide('Compra')}
              style={side === 'Compra' ? { boxShadow: 'var(--glow-pos)' } : undefined}
              className={`py-2 rounded-[8px] font-bold text-[13px] transition-all cursor-pointer ${
                side === 'Compra'
                  ? 'bg-[#2EDC7E] text-[#08080D]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              COMPRAR
            </button>
            <button
              type="button"
              onClick={() => setSide('Venta')}
              style={side === 'Venta' ? { boxShadow: 'var(--glow-neg)' } : undefined}
              className={`py-2 rounded-[8px] font-bold text-[13px] transition-all cursor-pointer ${
                side === 'Venta'
                  ? 'bg-[#FF5C63] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              VENDER / LANZAR
            </button>
          </div>

          {/* Especie + Liquidación */}
          <div className="grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                Especie / Ticker
              </label>
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] font-mono-num font-bold text-[var(--text-primary)]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--text-secondary)] mb-1">
                Plazo Liquidación
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-subtle)]">
                {(['CI', '24hs'] as const).map((pl) => (
                  <button
                    key={pl}
                    type="button"
                    onClick={() => setSettlement(pl)}
                    className={`py-1 rounded text-[11px] font-mono-num font-semibold cursor-pointer ${
                      settlement === pl
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {pl}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Tipo de Orden */}
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-[var(--text-secondary)] font-medium">Tipo de Orden:</span>
            <div className="flex gap-1.5">
              {(['Límite', 'Mercado'] as const).map((ot) => (
                <button
                  key={ot}
                  type="button"
                  onClick={() => setOrderType(ot)}
                  className={`px-3 py-1 rounded-[8px] text-[12px] font-semibold cursor-pointer ${
                    orderType === ot
                      ? 'bg-[var(--surface-3)] text-[var(--text-primary)] border border-[var(--accent-primary)]'
                      : 'bg-[var(--surface-2)] text-[var(--text-secondary)]'
                  }`}
                >
                  {ot}
                </button>
              ))}
            </div>
          </div>

          {/* Cantidad con Stepper */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="font-semibold text-[var(--text-secondary)]">
                Cantidad ({isOption ? 'Lotes × 100 acc.' : 'Nominales'})
              </span>
              <span className="font-mono-num text-[var(--text-tertiary)]">
                Poder de compra: $ 45.200.000
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 10))}
                className="w-9 h-9 rounded-[8px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-strong)] font-mono-num font-bold cursor-pointer"
              >
                −
              </button>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                className="flex-1 h-9 px-3 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] text-right font-mono-num font-bold text-[14px] text-[var(--text-primary)]"
              />
              <button
                type="button"
                onClick={() => setQty((q) => q + 10)}
                className="w-9 h-9 rounded-[8px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-strong)] font-mono-num font-bold cursor-pointer"
              >
                +
              </button>
            </div>
          </div>

          {/* Precio Límite con Stepper */}
          <div>
            <div className="flex justify-between text-[11px] mb-1">
              <span className="font-semibold text-[var(--text-secondary)]">Precio Límite ($ ARS)</span>
              <span className="font-mono-num text-[#4BA3FF]">Punta actual: $ {fmtNum(price, 2)}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPrice((p) => +(Math.max(0.5, p - 5)).toFixed(2))}
                className="w-9 h-9 rounded-[8px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-strong)] font-mono-num font-bold cursor-pointer"
              >
                −
              </button>
              <input
                type="number"
                step="0.5"
                value={price}
                onChange={(e) => setPrice(Math.max(0.1, Number(e.target.value)))}
                className="flex-1 h-9 px-3 rounded-[8px] bg-[var(--surface-2)] border border-[var(--border-strong)] text-right font-mono-num font-bold text-[14px] text-[var(--text-primary)]"
              />
              <button
                type="button"
                onClick={() => setPrice((p) => +(p + 5).toFixed(2))}
                className="w-9 h-9 rounded-[8px] bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border-strong)] font-mono-num font-bold cursor-pointer"
              >
                +
              </button>
            </div>
          </div>

          {/* Desglose de Costos e Impacto */}
          <div className="p-3.5 rounded-[10px] bg-[var(--surface-1)] border border-[var(--border-subtle)] space-y-2 font-mono-num text-[12px]">
            <div className="flex justify-between text-[var(--text-secondary)]">
              <span>Monto Bruto ({isOption ? `${qty} lotes × 100` : `${qty} vn`})</span>
              <span>$ {fmtNum(grossAmount, 2)}</span>
            </div>
            <div className="flex justify-between text-[var(--text-tertiary)] text-[11px]">
              <span>Arancel + Derechos BYMA (0,58 %)</span>
              <span>$ {fmtNum(fees, 2)}</span>
            </div>
            <div className="pt-2 border-t border-[var(--border-subtle)] flex justify-between font-bold text-[14px] text-[var(--text-primary)]">
              <span>Total Estimado ({settlement})</span>
              <span className={side === 'Compra' ? 'text-[#2EDC7E]' : 'text-[#FF5C63]'}>
                $ {fmtNum(totalAmount, 2)}
              </span>
            </div>
          </div>
        </div>

        {/* Botón Confirmar */}
        <div className="pt-4 border-t border-[var(--border-subtle)] space-y-2">
          <button
            type="button"
            onClick={() => {
              onSubmitOrder({ ticker, side, qty, price, settlement, orderType });
              onClose();
            }}
            style={
              side === 'Compra'
                ? { boxShadow: 'var(--glow-pos)' }
                : { boxShadow: 'var(--glow-neg)' }
            }
            className={`w-full py-2.5 rounded-[10px] font-bold text-[13px] inline-flex items-center justify-center gap-2 cursor-pointer transition-all ${
              side === 'Compra'
                ? 'bg-[#2EDC7E] text-[#08080D] hover:brightness-110'
                : 'bg-[#FF5C63] text-white hover:brightness-110'
            }`}
          >
            <Send className="w-4 h-4" />
            {side === 'Compra' ? 'Enviar Orden de Compra' : 'Enviar Orden de Venta'} ({ticker})
          </button>
          <p className="text-[10px] text-center text-[var(--text-tertiary)]">
            Simulador de ejecución v1 · Sin ruteo real al mercado · Atajo rápido: tecla N
          </p>
        </div>
      </div>
    </div>
  );
};

/* PALETA DE COMANDOS (CTRL + K) */
export const CommandPaletteModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onSelectStock: (ticker: string) => void;
  onNavigate: (page: string) => void;
  onOpenNewOrder: () => void;
  onToggleTheme: () => void;
}> = ({ open, onClose, onSelectStock, onNavigate, onOpenNewOrder, onToggleTheme }) => {
  const [query, setQuery] = useState('');

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const matchedStocks = AR_STOCKS.filter(
    (s) => s.ticker.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
  ).slice(0, 5);

  const quickPages = [
    { id: 'inicio', label: 'Ir a Inicio / Resumen General', shortcut: 'G I' },
    { id: 'opciones', label: 'Ir a Opciones (Cadena Completa y Volatilidad)', shortcut: 'G O' },
    { id: 'monitoreo', label: 'Ir a Monitoreo en Vivo (Acciones, Bonos, Cauciones)', shortcut: 'G M' },
    { id: 'macro', label: 'Ir a Macro Argentina (Brecha, Reservas, Inflación)', shortcut: 'G A' },
    { id: 'eeuu', label: 'Ir a Mercado EE.UU. y CEDEARs', shortcut: 'G U' },
    { id: 'bonos', label: 'Ir a Curva de Bonos Soberanos', shortcut: 'G B' },
    { id: 'relaciones', label: 'Ir a Relaciones y Arbitrajes (Z-Score)', shortcut: 'G R' },
  ].filter((p) => p.label.toLowerCase().includes(q));

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-[rgba(13,17,23,0.92)]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-[16px] bg-[var(--surface-1)] border border-[var(--border-strong)] overflow-hidden"
        style={{ boxShadow: 'var(--elev-4)' }}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--surface-2)]">
          <Search className="w-4 h-4 text-[var(--accent-primary)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar ticker (GGAL, YPFD, AL30...), ir a módulo o ejecutar comando..."
            className="flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono-num bg-[var(--surface-3)] text-[var(--text-tertiary)]">
            ESC
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto p-2 space-y-3">
          {/* Tickers */}
          {matchedStocks.length > 0 && (
            <div>
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                Especies / Papeles
              </div>
              {matchedStocks.map((s) => (
                <button
                  key={s.ticker}
                  type="button"
                  onClick={() => {
                    onSelectStock(s.ticker);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-[10px] hover:bg-[var(--surface-2)] text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ backgroundColor: s.color }}
                    >
                      {s.ticker.slice(0, 2)}
                    </span>
                    <span className="font-mono-num font-bold text-[13px] text-[var(--text-primary)]">
                      {s.ticker}
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)]">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono-num">
                    <span className="text-[12px] text-[var(--text-primary)]">$ {fmtNum(s.last, 2)}</span>
                    <DeltaPill value={s.deltaPct} size="sm" />
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Navegación rápida */}
          <div>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              Páginas y Módulos
            </div>
            {quickPages.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onNavigate(p.id);
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-[10px] hover:bg-[var(--surface-2)] text-left text-[12px] text-[var(--text-primary)] cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
                  {p.label}
                </span>
                <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono-num bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                  {p.shortcut}
                </kbd>
              </button>
            ))}
          </div>

          {/* Acciones */}
          <div>
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              Acciones Directas
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenNewOrder();
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-[10px] hover:bg-[var(--surface-2)] text-left text-[12px] text-[#2EDC7E] font-semibold cursor-pointer"
            >
              <span>+ Nueva Operación Simulada (Ticket DMA)</span>
              <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono-num bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                N
              </kbd>
            </button>
            <button
              type="button"
              onClick={() => {
                onToggleTheme();
                onClose();
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-[10px] hover:bg-[var(--surface-2)] text-left text-[12px] text-[var(--text-secondary)] cursor-pointer"
            >
              <span>Alternar modo de color Dark / Light</span>
              <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono-num bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                T
              </kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* MODAL DE ATAJOS DE TECLADO (?) */
export const ShortcutsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  if (!open) return null;
  const list = [
    { key: 'Ctrl K / /', desc: 'Abrir paleta de comandos y buscador universal' },
    { key: 'N', desc: 'Abrir Ticket de Nueva Operación (380 px)' },
    { key: '[', desc: 'Colapsar o expandir barra lateral (232 px ↔ 64 px)' },
    { key: '?', desc: 'Mostrar / ocultar ayuda de atajos de teclado' },
    { key: '1 – 6', desc: 'Cambiar rápidamente entre las 6 vistas de Opciones' },
  ];
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(13,17,23,0.92)]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[14px] bg-[var(--surface-1)] border border-[var(--border-strong)] p-5 space-y-4"
        style={{ boxShadow: 'var(--elev-4)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-[var(--accent-primary)]" />
            <h3 className="text-[15px] font-bold text-[var(--text-primary)]">
              Atajos de Teclado de Quant Core Terminal
            </h3>
          </div>
          <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-2 text-[12px]">
          {list.map((it) => (
            <div
              key={it.key}
              className="flex items-center justify-between py-2 px-3 rounded-[8px] bg-[var(--surface-2)]"
            >
              <span className="text-[var(--text-secondary)]">{it.desc}</span>
              <kbd className="px-2 py-0.5 rounded font-mono-num text-[11px] bg-[var(--surface-3)] text-[var(--text-primary)] border border-[var(--border-strong)]">
                {it.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
