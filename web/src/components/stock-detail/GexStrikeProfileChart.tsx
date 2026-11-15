import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, fmtPct } from '../../data/marketData';
import type {
  ChartCoordinateMapper,
  ChartKeyLevels,
  ExpectedMoveOverlayInfo,
  GexStrikeProfileItem,
} from './stockDetailTypes';

type ProfileMetricMode = 'GEX' | 'OI';

export const GexStrikeProfileChart: React.FC<{
  readonly ticker: string;
  readonly spot: number | null;
  readonly currencySymbol: 'ARS' | 'USD';
  readonly strikes: readonly GexStrikeProfileItem[];
  readonly expectedMove: ExpectedMoveOverlayInfo | null;
  readonly keyLevels: ChartKeyLevels;
  readonly mapper: ChartCoordinateMapper | null;
  readonly hideHeader?: boolean;
}> = ({
  spot,
  currencySymbol,
  strikes,
  expectedMove,
  keyLevels,
  mapper,
  hideHeader = false,
}) => {
  const [mode, setMode] = useState<ProfileMetricMode>('GEX');
  const [hovered, setHovered] = useState<{
    readonly strike: GexStrikeProfileItem;
    readonly y: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const visibleStrikes = useMemo(() => {
    const clean = strikes.filter((s) => Number.isFinite(s.strike) && s.strike > 0);
    clean.sort((a, b) => a.strike - b.strike);
    return clean;
  }, [strikes]);

  const hasOptionsChain = visibleStrikes.length > 0;
  const pxPrefix = currencySymbol === 'USD' ? 'US$ ' : '$ ';

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      if (width <= 0 || height <= 0) return;

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Fondo sólido consistente Dark Mode Quant Core
      ctx.fillStyle = '#08080D';
      ctx.fillRect(0, 0, width, height);

      if (!hasOptionsChain) {
        return;
      }

      const plotH = mapper?.plotHeight ?? Math.max(0, height - 28);
      const axisPadL = 12;
      const axisPadR = 54;
      const usableW = Math.max(40, width - axisPadL - axisPadR);
      const centerX = axisPadL + usableW * 0.5;

      // Resolver mapeo Y sincronizado exactamente con Chart 1; si Chart 1 aún no reportó coord, fallback proporcional de strikes
      const minStrike = visibleStrikes[0]?.strike ?? 0;
      const maxStrike = visibleStrikes[visibleStrikes.length - 1]?.strike ?? 1;
      const priceToY = (price: number): number | null => {
        if (mapper !== null) {
          const y = mapper.priceToY(price);
          if (y !== null && Number.isFinite(y)) return y;
        }
        if (maxStrike <= minStrike) return plotH * 0.5;
        const frac = (maxStrike - price) / (maxStrike - minStrike);
        return 16 + frac * Math.max(20, plotH - 32);
      };

      // Línea separadora fondo del pane de precio vs espacio de time axis de Chart 1
      ctx.strokeStyle = '#1E1E2B';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, plotH + 0.5);
      ctx.lineTo(width, plotH + 0.5);
      ctx.stroke();

      // 1) Cono / Banda Expected Move (±1σ) sincronizada
      if (expectedMove?.upper1Sigma && expectedMove?.lower1Sigma) {
        const yUp = priceToY(expectedMove.upper1Sigma);
        const yDn = priceToY(expectedMove.lower1Sigma);
        if (yUp !== null && yDn !== null) {
          const topY = Math.max(0, Math.min(yUp, yDn));
          const botY = Math.min(plotH, Math.max(yUp, yDn));
          if (botY > topY) {
            ctx.fillStyle = 'rgba(139, 124, 246, 0.10)';
            ctx.fillRect(0, topY, width - axisPadR, botY - topY);

            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(139, 124, 246, 0.72)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, yUp);
            ctx.lineTo(width, yUp);
            ctx.moveTo(0, yDn);
            ctx.lineTo(width, yDn);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.font = '600 9px "Geist Mono", monospace';
            ctx.fillStyle = '#C4B8FF';
            if (yUp > 10 && yUp < plotH - 4) {
              ctx.fillText(`+1σ ${fmtNum(expectedMove.upper1Sigma, 0)}`, 8, yUp - 3);
            }
            if (yDn > 12 && yDn < plotH - 4) {
              ctx.fillText(`-1σ ${fmtNum(expectedMove.lower1Sigma, 0)}`, 8, yDn + 10);
            }
          }
        }
      }

      // 2) Eje vertical central cero
      ctx.strokeStyle = '#252536';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(centerX + 0.5, 4);
      ctx.lineTo(centerX + 0.5, plotH - 4);
      ctx.stroke();

      // Máximo absoluto en el rango visible para escalar barras
      let maxMag = 0;
      for (const s of visibleStrikes) {
        if (mode === 'GEX') {
          const net = Math.abs(s.netGex ?? 0);
          const cg = Math.abs(s.callGex ?? 0);
          const pg = Math.abs(s.putGex ?? 0);
          maxMag = Math.max(maxMag, net, cg, pg);
        } else {
          maxMag = Math.max(maxMag, s.callOi ?? 0, s.putOi ?? 0);
        }
      }
      if (maxMag <= 0) maxMag = 1;

      const halfBarMax = usableW * 0.45;
      const barH = Math.max(
        3,
        Math.min(11, Math.floor((plotH * 0.7) / Math.max(visibleStrikes.length, 6))),
      );

      // 3) Barras horizontales por Strike
      let lastLabelY = Number.POSITIVE_INFINITY;
      for (const s of visibleStrikes) {
        const y = priceToY(s.strike);
        if (y === null || y < 2 || y > plotH - 2) continue;

        if (mode === 'GEX') {
          const net = s.netGex ?? 0;
          const wNet = (Math.abs(net) / maxMag) * halfBarMax;
          if (wNet >= 1) {
            ctx.fillStyle = net >= 0 ? 'rgba(46, 220, 126, 0.85)' : 'rgba(255, 84, 104, 0.85)';
            const x = net >= 0 ? centerX : centerX - wNet;
            ctx.fillRect(x, y - barH * 0.5, wNet, barH);
          }
        } else {
          const cOi = s.callOi ?? 0;
          const pOi = s.putOi ?? 0;
          const wCall = (cOi / maxMag) * halfBarMax;
          const wPut = (pOi / maxMag) * halfBarMax;
          if (wCall >= 1) {
            ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
            ctx.fillRect(centerX, y - barH * 0.5, wCall, barH);
          }
          if (wPut >= 1) {
            ctx.fillStyle = 'rgba(245, 181, 68, 0.85)';
            ctx.fillRect(centerX - wPut, y - barH * 0.5, wPut, barH);
          }
        }

        // Etiqueta compacta de strike en columna derecha (sin solapamiento vertical)
        if (Math.abs(y - lastLabelY) >= 13) {
          ctx.font = '500 9px "Geist Mono", monospace';
          ctx.fillStyle = '#6F7592';
          ctx.textAlign = 'right';
          ctx.fillText(fmtNum(s.strike, 0), width - 6, y + 3);
          lastLabelY = y;
        }
      }
      ctx.textAlign = 'left';

      // 4) Guías horizontales Call Wall, Put Wall, Zero-Gamma & Spot
      const drawGuide = (p: number | null, color: string, label: string) => {
        if (p === null || !Number.isFinite(p)) return;
        const y = priceToY(p);
        if (y === null || y < 2 || y > plotH - 2) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width - axisPadR, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 9px "Geist Mono", monospace';
        ctx.fillStyle = color;
        ctx.fillText(label, 6, Math.max(10, y - 3));
      };

      drawGuide(keyLevels.callWall, '#2EDC7E', 'CW');
      drawGuide(keyLevels.putWall, '#FF5468', 'PW');
      drawGuide(keyLevels.zeroGamma, '#A78BFA', 'ZG');
      drawGuide(spot, '#F8FAFC', 'SPOT');
    };

    const raf = window.requestAnimationFrame(draw);
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(draw));
    resizeObserver.observe(wrap);
    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, [hasOptionsChain, visibleStrikes, mode, expectedMove, keyLevels, mapper, spot]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasOptionsChain || !wrapRef.current) {
      setHovered(null);
      return;
    }
    const rect = wrapRef.current.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    let best: GexStrikeProfileItem | null = null;
    let bestDist = 18;
    let bestY = mouseY;

    const plotH = mapper?.plotHeight ?? Math.max(0, rect.height - 28);
    const minStrike = visibleStrikes[0]?.strike ?? 0;
    const maxStrike = visibleStrikes[visibleStrikes.length - 1]?.strike ?? 1;

    for (const s of visibleStrikes) {
      const y =
        mapper?.priceToY(s.strike) ??
        (maxStrike > minStrike
          ? 16 + ((maxStrike - s.strike) / (maxStrike - minStrike)) * Math.max(20, plotH - 32)
          : plotH * 0.5);
      if (y === null || !Number.isFinite(y)) continue;
      const dist = Math.abs(y - mouseY);
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
        bestY = y;
      }
    }
    setHovered(best ? { strike: best, y: bestY } : null);
  };

  return (
    <div className="flex flex-col h-full border-l border-[#1E1E2B]">
      {!hideHeader && (
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-[#1E1E2B] bg-[#0D0D14]">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#CBD0E4]">
            Perfil GEX / OI · Cono ±1σ
          </span>
          {expectedMove?.oneSigmaPct !== null &&
            expectedMove?.oneSigmaPct !== undefined &&
            Number.isFinite(expectedMove.oneSigmaPct) && (
              <span className="px-1.5 py-0.5 rounded bg-[#8B7CF6]/18 text-[#C8BEFF] font-mono-num text-[10px] font-semibold">
                ±{fmtNum(expectedMove.oneSigmaPct, 1)}%{' '}
                {expectedMove.expiryCode ? `(${expectedMove.expiryCode})` : ''}
              </span>
            )}
        </div>
      </div>
      )}

      {/* Barra fija 28px sincronizada exactamente con leyenda de Chart 1 */}
      <div className="flex items-center justify-between gap-2 px-3 h-[28px] overflow-hidden bg-[#0A0A10] border-b border-[#171722] text-[10px] font-mono-num text-[#7E85A3]">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-0.5 bg-[#161622] p-0.5 rounded-[5px] border border-[#252536]">
            <button
              type="button"
              onClick={() => setMode('GEX')}
              className={`px-1.5 py-0.2 rounded-[4px] text-[9px] font-mono-num font-semibold transition-colors ${
                mode === 'GEX' ? 'bg-[#8B7CF6] text-white' : 'text-[#848BA8] hover:text-white'
              }`}
            >
              GEX Neto
            </button>
            <button
              type="button"
              onClick={() => setMode('OI')}
              className={`px-1.5 py-0.2 rounded-[4px] text-[9px] font-mono-num font-semibold transition-colors ${
                mode === 'OI' ? 'bg-[#8B7CF6] text-white' : 'text-[#848BA8] hover:text-white'
              }`}
            >
              OI Strikes
            </button>
          </div>
          {mode === 'GEX' ? (
            <span className="hidden sm:inline text-[#8E95B3]">
              <span className="text-[#2EDC7E]">+GEX</span> / <span className="text-[#FF5468]">-GEX</span>
            </span>
          ) : (
            <span className="hidden sm:inline text-[#8E95B3]">
              <span className="text-[#38BDF8]">Call OI</span> / <span className="text-[#F5B544]">Put OI</span>
            </span>
          )}
        </div>
        <div className="truncate">
          {expectedMove?.upper1Sigma && expectedMove?.lower1Sigma ? (
            <span className="text-[#B8ACF8]">
              ±1σ{expectedMove.oneSigmaPct !== null ? ` (±${fmtNum(expectedMove.oneSigmaPct, 1)}%)` : ''}:{' '}
              {pxPrefix}
              {fmtNum(expectedMove.lower1Sigma, 0)}–{fmtNum(expectedMove.upper1Sigma, 0)}
            </span>
          ) : (
            <span>±1σ: —</span>
          )}
        </div>
      </div>

      {/* Canvas Vertical Sincronizado */}
      <div ref={wrapRef} className="relative flex-1 min-h-[390px]">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHovered(null)}
          className="w-full h-[390px] block"
        />

        {!hasOptionsChain && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-5 text-center bg-[#08080D]/80">
            <span className="text-[12px] font-semibold text-[#C5CAE0]">
              Sin cadena de opciones activa
            </span>
            <span className="mt-1 text-[11px] text-[#737996]">
              No hay contratos cotizados con OI/GEX para este subyacente en la sesión actual.
            </span>
          </div>
        )}

        {hovered && (
          <div
            className="pointer-events-none absolute left-2 z-20 px-2.5 py-1.5 rounded-[8px] bg-[#141422]/95 border border-[#2F2F48] shadow-xl font-mono-num text-[10px] text-[#E8ECF8]"
            style={{ top: Math.max(8, Math.min(300, hovered.y - 28)) }}
          >
            <div className="font-bold text-white mb-0.5">
              Strike {pxPrefix}
              {fmtNum(hovered.strike.strike, 2)}
            </div>
            <div className="flex justify-between gap-3 text-[#38BDF8]">
              <span>Call OI:</span>
              <span>{fmtNum(hovered.strike.callOi, 0)}</span>
            </div>
            <div className="flex justify-between gap-3 text-[#F5B544]">
              <span>Put OI:</span>
              <span>{fmtNum(hovered.strike.putOi, 0)}</span>
            </div>
            <div className="flex justify-between gap-3 text-[#2EDC7E]">
              <span>Net GEX:</span>
              <span>{fmtNum(hovered.strike.netGex, 0)}</span>
            </div>
            {spot !== null && spot > 0 && (
              <div className="mt-0.5 pt-0.5 border-t border-[#26263A] text-[#8E95B3]">
                Dist. Spot: {fmtPct(((hovered.strike.strike - spot) / spot) * 100, 1)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
