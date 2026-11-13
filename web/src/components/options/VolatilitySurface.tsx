import React, { useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  NULL_DISPLAY,
  fmtCompactInt,
  fmtDecimalPct,
  fmtNum,
  fmtPct,
  isFiniteNum,
  type SerializedVolSliceNode,
  type SerializedVolSliceSummary,
  type SerializedVolSurfaceSummary,
} from '../../api/terminalClient';
import { StatusBadge } from '../DesignSystem';

const SLICE_COLORS = ['#38BDF8', '#8B7CF6', '#2EDC7E', '#F5B544', '#E5558F', '#34D3C7'] as const;

export interface VolatilitySurfaceProps {
  readonly symbol: string;
  readonly spot: number | null;
  readonly volSurface: SerializedVolSurfaceSummary | null;
  readonly realizedVol: number | null;
}

export const VolatilitySurface: React.FC<VolatilitySurfaceProps> = ({
  symbol,
  spot,
  volSurface,
  realizedVol,
}) => {
  const [hiddenExpiries, setHiddenExpiries] = useState<ReadonlySet<string>>(() => new Set());
  const [xAxisMode, setXAxisMode] = useState<'strike' | 'k'>('strike');
  const [hoverInfo, setHoverInfo] = useState<{
    readonly expiry: string;
    readonly color: string;
    readonly node: SerializedVolSliceNode;
  } | null>(null);

  const activeSlices = useMemo(() => {
    if (volSurface === null) {
      return [] as readonly SerializedVolSliceSummary[];
    }
    return volSurface.slices.filter((s) => s.nodes.some((n) => isFiniteNum(n.iv)));
  }, [volSurface]);

  const toggleExpiry = (exp: string): void => {
    setHiddenExpiries((prev) => {
      const next = new Set(prev);
      if (next.has(exp)) {
        next.delete(exp);
      } else {
        next.add(exp);
      }
      return next;
    });
  };

  if (volSurface === null || activeSlices.length === 0) {
    return (
      <div className="p-8 rounded-[12px] bg-[#131722] border border-[#232733] text-center space-y-2">
        <StatusBadge status="NO_DATA" label="NO_DATA · VOL SURFACE" />
        <p className="text-[13px] text-[#A4A4BA] font-mono-num">
          Sin slices de volatilidad calculables para {symbol}.
        </p>
      </div>
    );
  }

  const visibleSlices = activeSlices.filter((s) => !hiddenExpiries.has(s.expirationDate));

  // Calcular limites del plano cartesiano exclusivamente desde datos finitos reales
  const allFiniteNodes: SerializedVolSliceNode[] = [];
  for (const s of visibleSlices) {
    for (const n of s.nodes) {
      if (isFiniteNum(n.iv)) {
        allFiniteNodes.push(n);
      }
    }
  }

  const xs = allFiniteNodes.map((n) => (xAxisMode === 'strike' ? n.strike : n.k));
  const ys = allFiniteNodes.map((n) => (n.iv as number) * 100);
  if (isFiniteNum(realizedVol)) {
    ys.push(realizedVol * 100);
  }

  const xMin = xs.length > 0 ? Math.min(...xs) : 0;
  const xMax = xs.length > 0 ? Math.max(...xs) : 1;
  const xSpan = Math.max(xMax - xMin, 1e-4);

  const yMinRaw = ys.length > 0 ? Math.min(...ys) : 0;
  const yMaxRaw = ys.length > 0 ? Math.max(...ys) : 1;
  const yPad = Math.max((yMaxRaw - yMinRaw) * 0.14, 1.5);
  const yMin = Math.max(0, yMinRaw - yPad);
  const yMax = yMaxRaw + yPad;
  const ySpan = Math.max(yMax - yMin, 1e-4);

  const W = 920;
  const H = 340;
  const PL = 58;
  const PR = 24;
  const PT = 20;
  const PB = 42;

  const mapX = (xVal: number): number => PL + ((xVal - xMin) / xSpan) * (W - PL - PR);
  const mapY = (ivPct: number): number => H - PB - ((ivPct - yMin) / ySpan) * (H - PT - PB);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMin + t * (yMax - yMin));
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => xMin + t * (xMax - xMin));

  const front = volSurface.frontSlice;

  return (
    <div className="space-y-4">
      {/* Encabezado de validacion sin arbitraje y metricas frontales */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">IV 30D (Interpolada)</div>
          <div className="mt-1 font-mono-num text-[18px] font-bold text-[#F3F3F9]">
            {fmtDecimalPct(volSurface.iv30d, 2)}
          </div>
        </div>
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">Front ATM IV</div>
          <div className="mt-1 font-mono-num text-[18px] font-bold text-[#38BDF8]">
            {fmtDecimalPct(front?.ivAtm, 2)}
          </div>
        </div>
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">25D Risk Reversal</div>
          <div className="mt-1 font-mono-num text-[18px] font-bold text-[#F3F3F9]">
            {fmtDecimalPct(front?.riskReversal25, 2, true)}
          </div>
        </div>
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">25D Butterfly</div>
          <div className="mt-1 font-mono-num text-[18px] font-bold text-[#F3F3F9]">
            {fmtDecimalPct(front?.butterfly25, 2, true)}
          </div>
        </div>
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">RV 5m RTH (Anual.)</div>
          <div className="mt-1 font-mono-num text-[18px] font-bold text-[#A4A4BA]">
            {fmtDecimalPct(realizedVol, 2)}
          </div>
        </div>
        <div className="p-3.5 rounded-[10px] bg-[#131722] border border-[#232733]">
          <div className="text-[11px] text-[#787B86] font-medium">Validacion Arbitraje</div>
          <div className="mt-1.5 flex items-center gap-1.5">
            {volSurface.isArbitrageFree ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#0E2F20] text-[#2EDC7E] border border-[#1C5C3C] text-[11px] font-mono-num font-bold">
                <ShieldCheck className="w-3.5 h-3.5" /> ARB-FREE
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#35280F] text-[#F5B544] border border-[#F5B544]/40 text-[11px] font-mono-num font-bold">
                <ShieldAlert className="w-3.5 h-3.5" /> {!volSurface.butterflyArbitrageFree ? 'BFLY' : ''}{' '}
                {!volSurface.calendarArbitrageFree ? 'CAL' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Grafico interactivo de Smile por vencimiento */}
      <div className="p-5 rounded-[12px] bg-[#131722] border border-[#232733] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-bold text-[#F3F3F9]">
              Sonrisa de Volatilidad Implicita ({symbol})
            </h3>
            <p className="text-[12px] text-[#787B86]">
              IV calculada por inversion propia BSM / BAW sobre mid-price de cadena real
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-[7px] bg-[#0D1017] border border-[#1E1E2B] p-0.5 text-[11px] font-mono-num">
              <button
                type="button"
                onClick={() => setXAxisMode('strike')}
                className={`px-2.5 py-1 rounded-[5px] cursor-pointer ${
                  xAxisMode === 'strike' ? 'bg-[#241F48] text-[#F3F3F9]' : 'text-[#787B86]'
                }`}
              >
                Strike ($)
              </button>
              <button
                type="button"
                onClick={() => setXAxisMode('k')}
                className={`px-2.5 py-1 rounded-[5px] cursor-pointer ${
                  xAxisMode === 'k' ? 'bg-[#241F48] text-[#F3F3F9]' : 'text-[#787B86]'
                }`}
              >
                ln(K/F)
              </button>
            </div>
            {activeSlices.slice(0, 6).map((s, idx) => {
              const color = SLICE_COLORS[idx % SLICE_COLORS.length] as string;
              const isHidden = hiddenExpiries.has(s.expirationDate);
              return (
                <button
                  key={s.expirationDate}
                  type="button"
                  onClick={() => toggleExpiry(s.expirationDate)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] border text-[11px] font-mono-num cursor-pointer ${
                    isHidden
                      ? 'bg-[#0D1017] text-[#6D6D84] border-[#1E1E2B]'
                      : 'bg-[#171722] text-[#F3F3F9] border-[#30303F]'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: color, opacity: isHidden ? 0.3 : 1 }}
                  />
                  {s.expirationDate} ({fmtNum(s.timeToExpiryDays, 0)}d)
                </button>
              );
            })}
          </div>
        </div>

        <div className="relative w-full">
          <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="w-full h-auto select-none">
            {yTicks.map((yVal, i) => {
              const y = mapY(yVal);
              return (
                <g key={`y-${String(i)}`}>
                  <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="rgba(255,255,255,0.06)" />
                  <text
                    x={PL - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    fill="#6D6D84"
                    fontSize="10.5"
                    className="font-mono-num"
                  >
                    {fmtPct(yVal, 1)}
                  </text>
                </g>
              );
            })}

            {xTicks.map((xVal, i) => {
              const x = mapX(xVal);
              return (
                <g key={`x-${String(i)}`}>
                  <line x1={x} y1={PT} x2={x} y2={H - PB} stroke="rgba(255,255,255,0.04)" />
                  <text
                    x={x}
                    y={H - PB + 16}
                    textAnchor="middle"
                    fill="#6D6D84"
                    fontSize="10.5"
                    className="font-mono-num"
                  >
                    {xAxisMode === 'strike' ? fmtNum(xVal, 1) : fmtNum(xVal, 3)}
                  </text>
                </g>
              );
            })}

            {/* Referencia Spot / Forward ATM */}
            {xAxisMode === 'strike' && isFiniteNum(spot) && spot >= xMin && spot <= xMax && (
              <g>
                <line
                  x1={mapX(spot)}
                  y1={PT}
                  x2={mapX(spot)}
                  y2={H - PB}
                  stroke="#F5B544"
                  strokeDasharray="4 4"
                  strokeOpacity="0.6"
                />
                <text
                  x={mapX(spot) + 4}
                  y={PT + 12}
                  fill="#F5B544"
                  fontSize="10.5"
                  className="font-mono-num"
                >
                  Spot ${fmtNum(spot, 2)}
                </text>
              </g>
            )}
            {xAxisMode === 'k' && xMin <= 0 && xMax >= 0 && (
              <line
                x1={mapX(0)}
                y1={PT}
                x2={mapX(0)}
                y2={H - PB}
                stroke="#F5B544"
                strokeDasharray="4 4"
                strokeOpacity="0.6"
              />
            )}

            {/* Referencia Volatilidad Realizada */}
            {isFiniteNum(realizedVol) && (
              <g>
                <line
                  x1={PL}
                  y1={mapY(realizedVol * 100)}
                  x2={W - PR}
                  y2={mapY(realizedVol * 100)}
                  stroke="#94A3B8"
                  strokeDasharray="6 4"
                  strokeOpacity="0.65"
                />
                <text
                  x={W - PR - 4}
                  y={mapY(realizedVol * 100) - 6}
                  textAnchor="end"
                  fill="#94A3B8"
                  fontSize="10.5"
                  className="font-mono-num"
                >
                  RV 5m RTH: {fmtDecimalPct(realizedVol, 2)}
                </text>
              </g>
            )}

            {/* Curvas por slice */}
            {activeSlices.slice(0, 6).map((slice, idx) => {
              if (hiddenExpiries.has(slice.expirationDate)) {
                return null;
              }
              const color = SLICE_COLORS[idx % SLICE_COLORS.length] as string;
              const finiteNodes = slice.nodes.filter((n) => isFiniteNum(n.iv));
              const pathD = finiteNodes
                .map((n, j) => {
                  const x = mapX(xAxisMode === 'strike' ? n.strike : n.k);
                  const y = mapY((n.iv as number) * 100);
                  return `${j === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(' ');

              return (
                <g key={slice.expirationDate}>
                  <path d={pathD} fill="none" stroke={color} strokeWidth={2} />
                  {finiteNodes.map((n) => {
                    const x = mapX(xAxisMode === 'strike' ? n.strike : n.k);
                    const y = mapY((n.iv as number) * 100);
                    const isHovered =
                      hoverInfo?.expiry === slice.expirationDate &&
                      hoverInfo.node.strike === n.strike;
                    return (
                      <circle
                        key={`${slice.expirationDate}-${String(n.strike)}`}
                        cx={x}
                        cy={y}
                        r={isHovered ? 5.5 : 3.2}
                        fill="#0D1017"
                        stroke={color}
                        strokeWidth={2}
                        className="cursor-pointer"
                        onMouseEnter={() =>
                          setHoverInfo({ expiry: slice.expirationDate, color, node: n })
                        }
                        onMouseLeave={() => setHoverInfo(null)}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>

          {hoverInfo !== null && (
            <div className="mt-2 px-3 py-2 rounded-[8px] bg-[#0D1017] border border-[#30303F] flex flex-wrap items-center gap-4 text-[11.5px] font-mono-num">
              <span className="font-bold" style={{ color: hoverInfo.color }}>
                Exp {hoverInfo.expiry}
              </span>
              <span className="text-[#A4A4BA]">
                Strike <strong className="text-[#F3F3F9]">${fmtNum(hoverInfo.node.strike, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                ln(K/F) <strong className="text-[#F3F3F9]">{fmtNum(hoverInfo.node.k, 4)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                IV <strong className="text-[#2EDC7E]">{fmtDecimalPct(hoverInfo.node.iv, 2)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                w=IV^2*T <strong className="text-[#F3F3F9]">{fmtNum(hoverInfo.node.totalVariance, 4)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                Spread/Mid{' '}
                <strong className="text-[#F3F3F9]">{fmtDecimalPct(hoverInfo.node.spreadRatio, 1)}</strong>
              </span>
              <span className="text-[#A4A4BA]">
                OI <strong className="text-[#F3F3F9]">{fmtCompactInt(hoverInfo.node.openInterest)}</strong>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Tabla de Estructura Temporal y Diagnostico por Vencimiento */}
      <div className="rounded-[12px] bg-[#131722] border border-[#232733] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#232733] flex items-center justify-between">
          <h4 className="text-[13.5px] font-bold text-[#F3F3F9]">
            Estructura Temporal y Skew por Vencimiento (Paridad F / r / q)
          </h4>
          <span className="text-[11px] font-mono-num text-[#6D6D84]">
            {volSurface.slices.length} vencimientos · {volSurface.contracts.length} contratos
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px] font-mono-num">
            <thead className="bg-[#0D1017] text-[#6D6D84] border-b border-[#1E1E2B]">
              <tr>
                <th className="py-2 px-3">Vencimiento</th>
                <th className="py-2 px-3 text-right">DTE</th>
                <th className="py-2 px-3 text-right">Forward F</th>
                <th className="py-2 px-3 text-right">r</th>
                <th className="py-2 px-3 text-right">q</th>
                <th className="py-2 px-3 text-right">ATM IV</th>
                <th className="py-2 px-3 text-right">25D Put IV</th>
                <th className="py-2 px-3 text-right">25D Call IV</th>
                <th className="py-2 px-3 text-right">RR25</th>
                <th className="py-2 px-3 text-right">BF25</th>
                <th className="py-2 px-3 text-center">Butterfly</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E1E2B]">
              {volSurface.slices.map((s) => (
                <tr key={s.expirationDate} className="hover:bg-[#171722]/60">
                  <td className="py-2 px-3 font-semibold text-[#F3F3F9]">{s.expirationDate}</td>
                  <td className="py-2 px-3 text-right text-[#A4A4BA]">{fmtNum(s.timeToExpiryDays, 1)}d</td>
                  <td className="py-2 px-3 text-right text-[#F3F3F9]">{fmtNum(s.forward, 2)}</td>
                  <td className="py-2 px-3 text-right text-[#4BA3FF]">{fmtDecimalPct(s.rate, 2)}</td>
                  <td className="py-2 px-3 text-right text-[#34D3C7]">{fmtDecimalPct(s.dividendYield, 2)}</td>
                  <td className="py-2 px-3 text-right text-[#38BDF8] font-semibold">
                    {fmtDecimalPct(s.ivAtm, 2)}
                  </td>
                  <td className="py-2 px-3 text-right text-[#FF5C63]">{fmtDecimalPct(s.delta25PutIv, 2)}</td>
                  <td className="py-2 px-3 text-right text-[#2EDC7E]">{fmtDecimalPct(s.delta25CallIv, 2)}</td>
                  <td className="py-2 px-3 text-right text-[#F3F3F9]">{fmtDecimalPct(s.riskReversal25, 2, true)}</td>
                  <td className="py-2 px-3 text-right text-[#F3F3F9]">{fmtDecimalPct(s.butterfly25, 2, true)}</td>
                  <td className="py-2 px-3 text-center">
                    {s.isButterflyArbitrageFree ? (
                      <span className="text-[#2EDC7E]">OK</span>
                    ) : (
                      <span className="text-[#F5B544]">WARN</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
