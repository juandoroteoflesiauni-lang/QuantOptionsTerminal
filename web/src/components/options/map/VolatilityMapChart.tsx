import React, { memo, useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { Market, MapGoal, Evaluation, HIST_VOL, atmIv, dateAt, fk, money, pct } from '../engine';
import { MapGeometry, PointerStore } from './mapShared';
import { MapCrosshair } from './MapTooltip';

export const HISTORY_DAYS = 60;

export interface MapLayers {
  gain: boolean;
  loss: boolean;
  cone: boolean;
  hist: boolean;
}

export type MapTiming = 'vto' | 'antes';

export function useMapGeometry(mkt: Market, history: number[], zoom: number): MapGeometry {
  return useMemo(() => {
    const W = 1000;
    const H = 430;
    const L = 8;
    const T = 14;
    const B = 388;
    const xExp = 884;
    const xStrip = 910;
    const xAxis = 994;
    const xToday = L + 0.36 * (xExp - L);
    const days = Number.isFinite(mkt.days) && mkt.days > 0 ? mkt.days : 1;
    const rawSig = atmIv(days);
    const sig = Number.isFinite(rawSig) && rawSig > 0 ? rawSig : 0.4;
    const safeSpot = Number.isFinite(mkt.spot) && mkt.spot > 0 ? mkt.spot : 1;
    const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const sT = sig * Math.sqrt(days / 365);
    const half = Math.max(0.05, (2.6 * sT) / safeZoom);
    let yMin = safeSpot * Math.exp(-half);
    let yMax = safeSpot * Math.exp(half);
    const validHist = history.filter((p) => Number.isFinite(p) && p > 0);
    if (safeZoom <= 1 && validHist.length > 0) {
      yMin = Math.min(yMin, ...validHist) * 0.98;
      yMax = Math.max(yMax, ...validHist) * 1.02;
    }
    if (!(yMax > yMin)) {
      yMin = safeSpot * 0.85;
      yMax = safeSpot * 1.15;
    }
    const pToY = (p: number) => B - ((p - yMin) / (yMax - yMin)) * (B - T);
    const yToP = (y: number) => yMin + ((B - y) / (B - T)) * (yMax - yMin);
    const dayToX = (d: number) =>
      d <= 0 ? L + ((d + HISTORY_DAYS) / HISTORY_DAYS) * (xToday - L) : xToday + (d / days) * (xExp - xToday);
    const xToDay = (x: number) =>
      x <= xToday ? ((x - L) / (xToday - L)) * HISTORY_DAYS - HISTORY_DAYS : ((x - xToday) / (xExp - xToday)) * days;
    return { W, H, L, T, B, xToday, xExp, xStrip, xAxis, yMin, yMax, pToY, yToP, dayToX, xToDay };
  }, [mkt, history, zoom]);
}

function niceStep(range: number, target = 6) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
}

const AMBER = '#F59E0B';
const zoneEase = { duration: 0.18, ease: 'easeOut' as const };

const AxisBadge: React.FC<{ x: number; y: number; text: string; tone: 'amber' | 'spot' }> = ({ x, y, text, tone }) => (
  <g transform={`translate(${x - 58}, ${y - 10})`} pointerEvents="none">
    <rect
      width="58"
      height="20"
      rx="5"
      fill={tone === 'amber' ? AMBER : '#0B0E14'}
      stroke={tone === 'amber' ? 'none' : 'rgba(255,255,255,0.28)'}
    />
    <text
      x="29"
      y="14"
      textAnchor="middle"
      fill={tone === 'amber' ? '#0B0E14' : '#FFFFFF'}
      fontSize="11.5"
      fontWeight="800"
      className="font-mono-num"
    >
      {text}
    </text>
  </g>
);

const GoalPin: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <g pointerEvents="none">
    <motion.circle
      cx={x}
      cy={y}
      fill="none"
      stroke={AMBER}
      strokeWidth="1.5"
      initial={{ r: 8, opacity: 0.55 }}
      animate={{ r: 22, opacity: 0 }}
      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
    />
    <circle cx={x} cy={y} r="13" fill={AMBER} fillOpacity="0.14" />
    <circle cx={x} cy={y} r="7" fill="#0B0E14" stroke={AMBER} strokeWidth="2.5" />
    <circle cx={x} cy={y} r="2.6" fill={AMBER} />
  </g>
);

export const VolatilityMapChart: React.FC<{
  mkt: Market;
  geo: MapGeometry;
  history: number[];
  goal: MapGoal;
  timing: MapTiming;
  targetDate: number;
  showPayoff: boolean;
  layers: MapLayers;
  ev: Evaluation | null;
  units: number;
  store: PointerStore;
  onGoal: (g: MapGoal) => void;
  onTargetDate: (d: number) => void;
}> = memo(
  ({ mkt, geo, history, goal, timing, targetDate, showPayoff, layers, ev, units, store, onGoal, onTargetDate }) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const goalRef = useRef(goal);
    goalRef.current = goal;
    const timingRef = useRef(timing);
    timingRef.current = timing;
    const drag = useRef<null | { kind: 'precio' | 'mueve' | 'new' | 'lo' | 'hi'; anchor: number }>(null);
    const rangeTap = useRef<number | null>(null);
    const frame = useRef(0);
    const latest = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => () => cancelAnimationFrame(frame.current), []);

    const { L, T, B, xToday, xExp, xStrip, xAxis, yMin, yMax, pToY, dayToX } = geo;
    const sigma = atmIv(mkt.days);

    /* ------------------------------ Interacción ------------------------------ */
    const toSvg = (cx: number, cy: number) => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = cx;
      pt.y = cy;
      return pt.matrixTransform(ctm.inverse());
    };
    const snapStep = mkt.market === 'US' || mkt.spot < 1000 ? (mkt.spot < 50 ? 0.5 : 1) : 10;
    const priceAt = (y: number) =>
      Math.round(Math.max(yMin, Math.min(yMax, geo.yToP(Math.max(T, Math.min(B, y))))) / snapStep) * snapStep;
    const dayAt = (x: number) =>
      Math.max(1, Math.min(mkt.days, Math.round(geo.xToDay(Math.max(xToday, Math.min(xExp, x))))));

    const apply = (x: number, y: number) => {
      const d = drag.current;
      if (!d) return;
      const g = goalRef.current;
      const price = priceAt(y);
      if (d.kind === 'precio') {
        onGoal({ ...g, price });
        if (timingRef.current === 'antes') onTargetDate(dayAt(x));
      } else if (d.kind === 'mueve') {
        onGoal({ ...g, move: Math.max(snapStep, Math.abs(price - mkt.spot)) });
      } else if (d.kind === 'new') {
        onGoal({ ...g, range: [Math.min(d.anchor, price), Math.max(d.anchor, price)] });
      } else if (d.kind === 'lo' && g.range) {
        onGoal({ ...g, range: [Math.min(price, g.range[1] - snapStep), g.range[1]] });
      } else if (d.kind === 'hi' && g.range) {
        onGoal({ ...g, range: [g.range[0], Math.max(price, g.range[0] + snapStep)] });
      }
    };

    // Un update de estado por frame durante el arrastre (60/120 FPS sin encolar trabajo)
    const schedule = (x: number, y: number) => {
      latest.current = { x, y };
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (latest.current) apply(latest.current.x, latest.current.y);
      });
    };

    const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
      const p = toSvg(e.clientX, e.clientY);
      if (!p || p.x < xToday - 2 || p.y < T || p.y > B) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const g = goalRef.current;
      const price = priceAt(p.y);
      drag.current = null;
      if (g.mode === 'precio') drag.current = { kind: 'precio', anchor: price };
      else if (g.mode === 'mueve') drag.current = { kind: 'mueve', anchor: price };
      else {
        if (g.range && g.range[1] > g.range[0]) {
          if (Math.abs(pToY(g.range[0]) - p.y) < 12) drag.current = { kind: 'lo', anchor: price };
          else if (Math.abs(pToY(g.range[1]) - p.y) < 12) drag.current = { kind: 'hi', anchor: price };
        }
        if (!drag.current) {
          const a = rangeTap.current ?? price;
          rangeTap.current = null;
          drag.current = { kind: 'new', anchor: a };
        }
      }
      apply(p.x, p.y);
    };

    const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      const p = toSvg(e.clientX, e.clientY);
      if (!p) return;
      if (drag.current) schedule(p.x, p.y);
      if (p.x >= xToday && p.x <= xStrip && p.y >= T && p.y <= B) {
        store.set({
          x: p.x,
          y: p.y,
          price: geo.yToP(p.y),
          elapsed: timing === 'vto' ? mkt.days : dayAt(p.x),
        });
      } else store.set(null);
    };

    const onPointerUp = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.kind === 'new') {
        const g = goalRef.current;
        // Un toque suelto marca el primer borde; el siguiente toque cierra el rango
        if (!g.range || g.range[1] - g.range[0] < mkt.step / 4) rangeTap.current = d.anchor;
      }
    };

    /* ------------------------------ Derivados ------------------------------ */
    const marketReady =
      Number.isFinite(mkt.spot) &&
      mkt.spot > 0 &&
      Number.isFinite(mkt.days) &&
      mkt.days > 0 &&
      Number.isFinite(sigma) &&
      sigma > 0 &&
      Number.isFinite(mkt.rate) &&
      Number.isFinite(yMin) &&
      Number.isFinite(yMax) &&
      yMax > yMin;

    const ticks = useMemo(() => {
      if (!marketReady) return [];
      const st = niceStep(yMax - yMin);
      if (!Number.isFinite(st) || st <= 0) return [];
      const out: number[] = [];
      for (let v = Math.ceil(yMin / st) * st; v <= yMax && out.length < 32; v += st) out.push(v);
      return out;
    }, [marketReady, yMin, yMax]);

    const histPath = useMemo(() => {
      const valid = history.filter((p) => Number.isFinite(p) && p > 0).slice(-(HISTORY_DAYS + 1));
      if (valid.length < 2) return '';
      return valid
        .map((p, i) => `${dayToX(i - (valid.length - 1)).toFixed(1)},${pToY(p).toFixed(1)}`)
        .join(' ');
    }, [history, dayToX, pToY]);

    const cone = (k: number, sig: number) => {
      if (!marketReady || !Number.isFinite(sig) || sig <= 0) return '';
      const up: string[] = [];
      const dn: string[] = [];
      for (let d = 0; d <= mkt.days; d++) {
        const s = sig * Math.sqrt(d / 365);
        up.push(`${dayToX(d).toFixed(1)},${pToY(mkt.spot * Math.exp(k * s)).toFixed(1)}`);
        dn.unshift(`${dayToX(d).toFixed(1)},${pToY(mkt.spot * Math.exp(-k * s)).toFixed(1)}`);
      }
      return [...up, ...dn].join(' ');
    };
    const coneLayers = useMemo(
      () => [3, 2.5, 2, 1.5, 1, 0.5].map((k) => ({ k, pts: cone(k, sigma) })),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [geo, sigma, mkt.spot, mkt.days, marketReady]
    );
    const histCone = useMemo(
      () => {
        if (!marketReady || !Number.isFinite(HIST_VOL) || HIST_VOL <= 0) {
          return { up: '', dn: '' };
        }
        const up: string[] = [];
        const dn: string[] = [];
        for (let d = 0; d <= mkt.days; d++) {
          const s = HIST_VOL * Math.sqrt(d / 365);
          up.push(`${dayToX(d).toFixed(1)},${pToY(mkt.spot * Math.exp(s)).toFixed(1)}`);
          dn.push(`${dayToX(d).toFixed(1)},${pToY(mkt.spot * Math.exp(-s)).toFixed(1)}`);
        }
        return { up: up.join(' '), dn: dn.join(' ') };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [geo, mkt.spot, mkt.days, marketReady]
    );

    // Campana de densidad log-normal al vencimiento, pegada al eje
    const bell = useMemo(() => {
      if (!marketReady) return { line: '', area: '' };
      const t = mkt.days / 365;
      const mu = Math.log(mkt.spot) + (mkt.rate - (sigma * sigma) / 2) * t;
      const sd = sigma * Math.sqrt(t);
      if (!Number.isFinite(sd) || sd <= 0) return { line: '', area: '' };
      const pts: { y: number; f: number }[] = [];
      for (let i = 0; i <= 90; i++) {
        const p = yMin + ((yMax - yMin) * i) / 90;
        if (!(p > 0)) continue;
        const z = (Math.log(p) - mu) / sd;
        const f = Math.exp((-z * z) / 2) / p;
        if (Number.isFinite(f)) pts.push({ y: pToY(p), f });
      }
      if (pts.length === 0) return { line: '', area: '' };
      const fmax = Math.max(...pts.map((q) => q.f));
      if (!(fmax > 0)) return { line: '', area: '' };
      const line = pts.map((q) => `${(xExp - (q.f / fmax) * 86).toFixed(1)},${q.y.toFixed(1)}`).join(' ');
      return { line, area: `${xExp},${B} ${line} ${xExp},${T}` };
    }, [marketReady, mkt.days, mkt.spot, mkt.rate, sigma, yMin, yMax, pToY, xExp, B, T]);

    const payoff = useMemo(() => {
      if (!ev) return null;
      const gain = ev.zones
        .map((z) => ({ lo: Math.max(z.lo, yMin), hi: Math.min(z.hi, yMax) }))
        .filter((z) => z.hi > z.lo);
      const loss: { lo: number; hi: number }[] = [];
      let cur = yMin;
      for (const z of gain) {
        if (z.lo > cur) loss.push({ lo: cur, hi: z.lo });
        cur = Math.max(cur, z.hi);
      }
      if (cur < yMax) loss.push({ lo: cur, hi: yMax });
      const biggest = (zs: { lo: number; hi: number }[]) =>
        [...zs].sort((a, b) => b.hi - b.lo - (a.hi - a.lo))[0];

      // Dónde se alcanza la ganancia máxima
      let gainText = 'Ganás sin techo';
      let peak: number | null = null;
      if (ev.maxGain != null) {
        const lim = ev.maxGain * 0.995;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i <= 300; i++) {
          const p = yMin + ((yMax - yMin) * i) / 300;
          if (ev.pnl(p) >= lim) {
            lo = Math.min(lo, p);
            hi = Math.max(hi, p);
          }
        }
        const base = `Ganás hasta ${money(ev.maxGain * units)}`;
        const r10 = (v: number) => fk(Math.round(v / 10) * 10);
        if (!isFinite(lo)) gainText = base;
        else if (lo <= yMin + 1) gainText = `${base} abajo de ${r10(hi)}`;
        else if (hi >= yMax - 1) gainText = `${base} arriba de ${r10(lo)}`;
        else {
          gainText = `${base} en ${r10((lo + hi) / 2)}`;
          if (hi - lo < (yMax - yMin) * 0.05) peak = (lo + hi) / 2;
        }
      }
      const paid = ev.commission - ev.cash;
      const lossText =
        ev.maxLoss == null
          ? 'La pérdida no tiene techo'
          : ev.cash < 0 && Math.abs(ev.maxLoss - paid) < paid * 0.02
          ? `Perdés los ${money(ev.maxLoss * units)} que pagaste`
          : `Perdés hasta ${money(ev.maxLoss * units)}`;
      return {
        gain,
        loss,
        gz: biggest(gain),
        lz: biggest(loss),
        gainText,
        lossText,
        peak,
        bes: ev.breakevens.filter((b) => b > yMin && b < yMax),
      };
    }, [ev, units, yMin, yMax]);

    const showZones = showPayoff && payoff != null;

    // Badges del eje: se separan si se pisan y ocultan los niveles que quedarían tapados
    const badges = useMemo(() => {
      if (!marketReady) return [];
      const list: { y: number; text: string; tone: 'amber' | 'spot' }[] = [
        { y: pToY(mkt.spot), text: fk(mkt.spot), tone: 'spot' },
      ];
      if (goal.mode === 'precio' && goal.price != null) list.push({ y: pToY(goal.price), text: fk(goal.price), tone: 'amber' });
      if (goal.mode === 'mueve' && goal.move != null) {
        list.push({ y: pToY(mkt.spot + goal.move), text: fk(mkt.spot + goal.move), tone: 'amber' });
        list.push({ y: pToY(mkt.spot - goal.move), text: fk(mkt.spot - goal.move), tone: 'amber' });
      }
      if (goal.mode === 'rango' && goal.range) {
        list.push({ y: pToY(goal.range[1]), text: fk(goal.range[1]), tone: 'amber' });
        if (goal.range[1] > goal.range[0]) list.push({ y: pToY(goal.range[0]), text: fk(goal.range[0]), tone: 'amber' });
      }
      const sorted = [...list].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) {
        const curr = sorted[i];
        const prev = sorted[i - 1];
        if (curr && prev && curr.y - prev.y < 22) sorted[i] = { ...curr, y: prev.y + 22 };
      }
      return sorted;
    }, [marketReady, goal, mkt.spot, pToY]);
    const tickHidden = (v: number) => badges.some((b) => Math.abs(b.y - pToY(v)) < 15);
    const spotY = pToY(mkt.spot);
    const pinX = goal.mode === 'precio' && timing === 'antes' ? dayToX(targetDate) : xExp;

    if (!marketReady) {
      return (
        <div className="h-[340px] flex items-center justify-center rounded-[12px] bg-[#0B0E14] border border-[#1E222D] text-[13px] text-[#9CA3AF]">
          Sincronizando cotizaciones reales de opciones para {mkt.ticker}...
        </div>
      );
    }

    return (
      <svg
        ref={svgRef}
        viewBox={`0 0 ${geo.W} ${geo.H}`}
        className="w-full h-auto select-none touch-none"
        style={{ cursor: 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => store.set(null)}
      >
        <defs>
          <pattern id="vm-grid" width="14" height="14" patternUnits="userSpaceOnUse">
            <path d="M 14 0 L 0 0 0 14" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
          </pattern>
          <pattern id="vm-stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(239,68,68,0.32)" strokeWidth="2" />
          </pattern>
          <clipPath id="vm-plot">
            <rect x={L} y={T} width={xStrip - L} height={B - T} />
          </clipPath>
          <clipPath id="vm-future">
            <rect x={xToday} y={T} width={xExp - xToday} height={B - T} />
          </clipPath>
          <clipPath id="vm-gainclip">
            {(payoff?.gain ?? []).map((z, i) => (
              <rect key={i} x={xToday} y={pToY(z.hi)} width={xExp - xToday} height={Math.max(0, pToY(z.lo) - pToY(z.hi))} />
            ))}
          </clipPath>
          <filter id="vm-shadow" x="-5%" y="-10%" width="110%" height="120%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.7" />
          </filter>
        </defs>

        {/* Rejilla milimétrica + niveles */}
        <rect x={L} y={T} width={xStrip - L} height={B - T} fill="url(#vm-grid)" />
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} y1={pToY(v)} x2={xStrip} y2={pToY(v)} stroke="rgba(255,255,255,0.05)" />
            {!tickHidden(v) && (
              <text x={xAxis} y={pToY(v) + 4} textAnchor="end" fill="#6B7280" fontSize="11" className="font-mono-num">
                {fk(v)}
              </text>
            )}
          </g>
        ))}

        <g clipPath="url(#vm-plot)">
          {/* Columna del vencimiento */}
          <rect x={xExp} y={T} width={xStrip - xExp} height={B - T} fill="rgba(255,255,255,0.035)" />

          {/* Cono de probabilidad (capas monocromáticas 4%–18%) */}
          {layers.cone &&
            coneLayers.map((c, i) => (
              <polygon key={c.k} points={c.pts} fill="#FFFFFF" fillOpacity={i === 0 ? 0.04 : 0.028} />
            ))}

          {/* Zonas de payoff */}
          {showZones && layers.gain &&
            payoff!.gain.map((z, i) => (
              <g key={`g-${i}`} clipPath="url(#vm-future)">
                <motion.rect
                  x={xToday}
                  width={xExp - xToday}
                  initial={{ opacity: 0, y: pToY(z.hi), height: Math.max(0, pToY(z.lo) - pToY(z.hi)) }}
                  animate={{ opacity: 1, y: pToY(z.hi), height: Math.max(0, pToY(z.lo) - pToY(z.hi)) }}
                  transition={zoneEase}
                  fill="#10B981"
                  fillOpacity="0.2"
                />
                <motion.line
                  x1={xToday}
                  x2={xExp}
                  initial={false}
                  animate={{ y1: pToY(z.hi), y2: pToY(z.hi) }}
                  transition={zoneEase}
                  stroke="#10B981"
                  strokeWidth="1.4"
                />
              </g>
            ))}
          {showZones && layers.loss &&
            payoff!.loss.map((z, i) => {
              const y = pToY(z.hi);
              const h = Math.max(0, pToY(z.lo) - y);
              return (
                <g key={`l-${i}`} clipPath="url(#vm-future)">
                  <motion.rect
                    x={xToday}
                    width={xExp - xToday}
                    initial={{ opacity: 0, y, height: h }}
                    animate={{ opacity: 1, y, height: h }}
                    transition={zoneEase}
                    fill="#EF4444"
                    fillOpacity="0.14"
                  />
                  <motion.rect
                    x={xToday}
                    width={xExp - xToday}
                    initial={{ opacity: 0, y, height: h }}
                    animate={{ opacity: 1, y, height: h }}
                    transition={zoneEase}
                    fill="url(#vm-stripes)"
                  />
                </g>
              );
            })}
          {showZones && layers.gain && payoff!.peak != null && (
            <line x1={xToday} y1={pToY(payoff!.peak)} x2={xExp} y2={pToY(payoff!.peak)} stroke="#34D399" strokeWidth="2.5" />
          )}

          {/* Cono según la historia */}
          {layers.hist && histCone.up !== '' && histCone.dn !== '' && (
            <g fill="none" stroke="rgba(255,255,255,0.55)" strokeDasharray="4 4" strokeWidth="1.1">
              <polyline points={histCone.up} />
              <polyline points={histCone.dn} />
            </g>
          )}

          {/* Campana de densidad al vencimiento */}
          {layers.cone && bell.line !== '' && (
            <g pointerEvents="none">
              <polygon points={bell.area} fill="#FFFFFF" fillOpacity="0.05" />
              {showZones && layers.gain && (
                <polygon points={bell.area} fill="#10B981" fillOpacity="0.55" clipPath="url(#vm-gainclip)" />
              )}
              <polyline points={bell.line} fill="none" stroke="rgba(255,255,255,0.75)" strokeDasharray="3 3" strokeWidth="1.2" />
            </g>
          )}

          {/* Empates */}
          {showZones &&
            payoff!.bes.map((b, i) => (
              <motion.line
                key={`be-${i}`}
                x1={xToday}
                x2={xExp}
                initial={false}
                animate={{ y1: pToY(b), y2: pToY(b) }}
                transition={zoneEase}
                stroke="rgba(255,255,255,0.7)"
                strokeWidth="1"
              />
            ))}

          {/* Spot e histórico */}
          <line x1={L} y1={spotY} x2={xToday} y2={spotY} stroke="rgba(255,255,255,0.32)" strokeDasharray="2 3" />
          {histPath !== '' && (
            <polyline
              points={histPath}
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="1.5"
              strokeLinejoin="round"
              filter="url(#vm-shadow)"
            />
          )}

          {/* Trazas desde hoy hasta el objetivo */}
          {goal.mode === 'precio' && goal.price != null && (
            <line x1={xToday} y1={spotY} x2={pinX} y2={pToY(goal.price)} stroke={AMBER} strokeWidth="1.4" strokeDasharray="3 4" />
          )}
          {goal.mode === 'mueve' && goal.move != null &&
            [1, -1].map((s) => (
              <line
                key={s}
                x1={xToday}
                y1={spotY}
                x2={xExp}
                y2={pToY(mkt.spot + s * goal.move!)}
                stroke={AMBER}
                strokeWidth="1.4"
                strokeDasharray="3 4"
              />
            ))}
        </g>

        {/* Líneas de tiempo */}
        <line x1={xToday} y1={T} x2={xToday} y2={B} stroke="rgba(255,255,255,0.18)" />
        <line x1={xExp} y1={T - 6} x2={xExp} y2={B} stroke="#FFFFFF" strokeOpacity="0.85" strokeWidth="2" />
        {goal.mode === 'precio' && timing === 'antes' && goal.price != null && (
          <line x1={pinX} y1={T} x2={pinX} y2={B} stroke={AMBER} strokeOpacity="0.35" strokeDasharray="2 4" />
        )}

        {/* Textos de zonas (siguen el centro de cada área) y pills de empate */}
        {showZones && layers.gain && payoff!.gz && pToY(payoff!.gz.lo) - pToY(payoff!.gz.hi) > 16 && (
          <motion.text
            x={xToday + 12}
            initial={false}
            animate={{ y: (pToY(payoff!.gz.lo) + pToY(payoff!.gz.hi)) / 2 + 4 }}
            transition={zoneEase}
            fill="#34D399"
            fontSize="12.5"
            fontWeight="700"
            stroke="#0B0E14"
            strokeWidth="4"
            strokeLinejoin="round"
            paintOrder="stroke"
            pointerEvents="none"
          >
            {payoff!.gainText}
          </motion.text>
        )}
        {showZones && layers.loss && payoff!.lz && pToY(payoff!.lz.lo) - pToY(payoff!.lz.hi) > 16 && (
          <motion.text
            x={xToday + 12}
            initial={false}
            animate={{ y: (pToY(payoff!.lz.lo) + pToY(payoff!.lz.hi)) / 2 + 4 }}
            transition={zoneEase}
            fill="#FF6B78"
            fontSize="12.5"
            fontWeight="700"
            stroke="#0B0E14"
            strokeWidth="4"
            strokeLinejoin="round"
            paintOrder="stroke"
            pointerEvents="none"
          >
            {payoff!.lossText}
          </motion.text>
        )}
        {showZones &&
          payoff!.bes.map((b, i) => (
            <motion.g key={`bp-${i}`} initial={false} animate={{ y: pToY(b) - 10 }} transition={zoneEase} pointerEvents="none">
              <rect x={xToday + 8} y="0" width="98" height="20" rx="10" fill="#0B0E14" stroke="rgba(245,158,11,0.7)" />
              <text x={xToday + 57} y="14" textAnchor="middle" fill={AMBER} fontSize="11" fontWeight="700" className="font-mono-num">
                Empate ${fk(Math.round(b))}
              </text>
            </motion.g>
          ))}
        {showZones && layers.cone && ev && (
          <text x={xExp - 8} y={B - 8} textAnchor="end" fill="#FFFFFF" fontSize="11" fontWeight="700" pointerEvents="none">
            {pct(ev.pop)} de ganar
          </text>
        )}

        {/* Marcadores del objetivo */}
        {goal.mode === 'precio' && goal.price != null && (
          <>
            <text x={pinX - 14} y={pToY(goal.price) - 14} textAnchor="end" fill="#FFFFFF" fontSize="11" fontWeight="700" pointerEvents="none">
              Tu objetivo{timing === 'antes' ? ` · ${dateAt(mkt, targetDate)}` : ''}
            </text>
            <GoalPin x={pinX} y={pToY(goal.price)} />
          </>
        )}
        {goal.mode === 'mueve' && goal.move != null && (
          <>
            <text x={xExp - 14} y={pToY(mkt.spot + goal.move) - 14} textAnchor="end" fill="#FFFFFF" fontSize="11" fontWeight="700" pointerEvents="none">
              Tu movida
            </text>
            <GoalPin x={xExp} y={pToY(mkt.spot + goal.move)} />
            <GoalPin x={xExp} y={pToY(mkt.spot - goal.move)} />
          </>
        )}
        {goal.mode === 'rango' && goal.range && (
          <g>
            {goal.range[1] > goal.range[0] && (
              <>
                <rect
                  x={xExp - 4}
                  y={pToY(goal.range[1])}
                  width="8"
                  height={Math.max(0, pToY(goal.range[0]) - pToY(goal.range[1]))}
                  rx="2"
                  fill={AMBER}
                  fillOpacity="0.85"
                />
                <rect x={xToday} y={pToY(goal.range[1])} width={xExp - xToday} height={Math.max(0, pToY(goal.range[0]) - pToY(goal.range[1]))} fill={AMBER} fillOpacity="0.05" pointerEvents="none" />
                <text x={xExp - 14} y={pToY(goal.range[1]) - 10} textAnchor="end" fill="#FFFFFF" fontSize="11" fontWeight="700" pointerEvents="none">
                  Tu rango
                </text>
              </>
            )}
            {[goal.range[0], goal.range[1]].map((v, i) => (
              <rect key={i} x={xExp - 11} y={pToY(v) - 3} width="22" height="6" rx="3" fill={AMBER} stroke="#0B0E14" strokeWidth="1" style={{ cursor: 'ns-resize' }} />
            ))}
          </g>
        )}

        {/* Badges del eje */}
        {badges.map((bd, i) => (
          <AxisBadge key={`${bd.tone}-${i}`} x={xAxis} y={bd.y} text={bd.text} tone={bd.tone} />
        ))}

        {/* Mira desacoplada */}
        <MapCrosshair store={store} geo={geo} />

        {/* Eje de tiempo */}
        <text x={xToday} y={B + 22} textAnchor="middle" fill="#9CA3AF" fontSize="11">
          hoy
        </text>
        <g transform={`translate(${xExp - 48}, ${B + 9})`}>
          <rect width="96" height="22" rx="6" fill="#F3F4F6" />
          <text x="48" y="15" textAnchor="middle" fill="#0B0E14" fontSize="11.5" fontWeight="700">
            {mkt.expiryLabel} · {mkt.days} d
          </text>
        </g>
      </svg>
    );
  }
);
VolatilityMapChart.displayName = 'VolatilityMapChart';
