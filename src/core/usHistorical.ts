import type { Bar } from './types.js';
import { getMarketParts } from './sessions.js';
import { etWallTimeToUtc } from '../data/alignment.js';
import { resolveAdaptiveVisibleBars, restHistoricalFromUtcSec } from '../data/restHistoricalWindow.js';

export type HistoricalPriceSource = 'REAL_VW' | 'HLC3_PROXY' | 'MIXED_VW_HLC3';
export type HistoricalProvider = 'MASSIVE_REST' | 'FMP';
export type UsHistoricalTimeframe = '1m' | '5m' | '15m' | '1h';
export interface HistoricalMoments {
  readonly PV: number;
  readonly V: number;
  /** Second moment of source bar prices, NOT individual trade prices. */
  readonly P2V: number;
}
export interface HistoricalObservation {
  readonly bar: Bar;
  readonly endExclusive: number;
  readonly historicalProvider: HistoricalProvider;
  readonly priceSource: HistoricalPriceSource;
  readonly price: number;
  readonly moments: HistoricalMoments;
  readonly sourceMinutes: number;
  readonly realVwBars: number;
  readonly proxyBars: number;
  readonly quality: 'SOURCE_BAR_MOMENTS' | 'CANONICAL_1M_MOMENTS';
  readonly adjustment: 'SPLIT_ADJUSTED' | 'FMP_NATIVE_UNVERIFIED';
}
export interface UsSession {
  readonly dateKey: string;
  readonly open: number;
  readonly close: number;
  readonly extendedOpen: number;
  readonly extendedClose: number;
}

/** Exchange-published schedule. Unknown years fail closed rather than invent sessions.
 * NYSE Group calendars 2020–2028; Juneteenth starts in 2022 and 2025-01-09
 * national day of mourning is included. Independent oracle enumerates every date.
 */
const CLOSED = new Set([
  '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10', '2020-05-25', '2020-07-03', '2020-09-07', '2020-11-26', '2020-12-25',
  '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31', '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
  '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20', '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);
const EARLY = new Set(['2020-11-27', '2020-12-24', '2021-11-26', '2022-11-25', '2023-07-03', '2023-11-24', '2024-07-03', '2024-11-29', '2024-12-24',
  '2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

export function usHistoricalSession(time: number): UsSession | null {
  const p = getMarketParts(time, 'EQUITY');
  if (p.year < 2020 || p.year > 2028) throw new Error('HISTORICAL_CALENDAR_OUT_OF_COVERAGE: published 2020–2028');
  if (p.weekday > 5 || CLOSED.has(p.dateKey)) return null;
  const wall = (minutes: number): number => etWallTimeToUtc(p.year, p.month, p.day, minutes);
  return { dateKey: p.dateKey, open: wall(570), close: wall(EARLY.has(p.dateKey) ? 780 : 960), extendedOpen: wall(240), extendedClose: wall(EARLY.has(p.dateKey) ? 1020 : 1200) };
}

/** OHLCV validity is independent of optional VW; preserve numeric VW verbatim. */
export function historicalObservation(bar: Bar, provider: HistoricalProvider, sourceMinutes: number): HistoricalObservation {
  if (!Number.isSafeInteger(bar.time) || bar.time <= 0 || bar.time > 100_000_000_000 ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
      Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0 ||
      bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) ||
      !Number.isInteger(sourceMinutes) || sourceMinutes <= 0) throw new Error('Invalid historical OHLCV or resolution');
  const validVW = provider === 'MASSIVE_REST' && typeof bar.vw === 'number' && Number.isFinite(bar.vw) && bar.vw > 0;
  const price = validVW ? bar.vw : (bar.high + bar.low + bar.close) / 3;
  return {
    bar: { ...bar }, endExclusive: bar.time + sourceMinutes * 60, historicalProvider: provider,
    priceSource: validVW ? 'REAL_VW' : 'HLC3_PROXY', price,
    moments: { PV: price * bar.volume, V: bar.volume, P2V: price * price * bar.volume },
    sourceMinutes, realVwBars: validVW ? 1 : 0, proxyBars: validVW ? 0 : 1,
    quality: sourceMinutes === 1 ? 'CANONICAL_1M_MOMENTS' : 'SOURCE_BAR_MOMENTS',
    adjustment: provider === 'MASSIVE_REST' ? 'SPLIT_ADJUSTED' : 'FMP_NATIVE_UNVERIFIED',
  };
}

/** Half-open source partition; duplicate identities are errors, never counted twice. */
export function mergeHistoricalSegments(segments: readonly (readonly HistoricalObservation[])[]): readonly HistoricalObservation[] {
  const result = segments.flat().sort((a, b) => a.bar.time - b.bar.time);
  for (let i = 1; i < result.length; i += 1) {
    const previous = result[i - 1];
    const current = result[i];
    if (previous !== undefined && current !== undefined && previous.endExclusive > current.bar.time) throw new Error('Overlapping historical segments');
  }
  return result;
}

/** Exact source moments; data before the monthly anchor never seed monthly AVWAP. */
export function historicalMomentsSince(rows: readonly HistoricalObservation[], anchor: number, endExclusive: number): HistoricalMoments {
  let PV = 0; let V = 0; let P2V = 0;
  for (const row of mergeHistoricalSegments([rows])) {
    if (row.bar.time < anchor || row.endExclusive > endExclusive) continue;
    PV += row.moments.PV; V += row.moments.V; P2V += row.moments.P2V;
  }
  return { PV, V, P2V };
}

/** Session-aligned buckets: intermediates cannot cross an output bucket or session. */
export function rollupUsHistorical(rows: readonly HistoricalObservation[], minutes: number, rthOnly: boolean, now: number): readonly HistoricalObservation[] {
  if (![1, 5, 15, 60].includes(minutes)) throw new Error('Unsupported historical rollup');
  const groups = new Map<number, HistoricalObservation[]>();
  const ends = new Map<number, number>();
  const sessions = new Map<string, UsSession | null>();
  const result: HistoricalObservation[] = [];
  let activeSession: UsSession | null = null;
  for (const row of mergeHistoricalSegments([rows])) {
    if (activeSession === null || row.bar.time < activeSession.extendedOpen || row.bar.time >= activeSession.extendedClose) {
      const dateKey = getMarketParts(row.bar.time, 'EQUITY').dateKey;
      if (!sessions.has(dateKey)) sessions.set(dateKey, usHistoricalSession(row.bar.time));
      activeSession = sessions.get(dateKey) ?? null;
    }
    const session = activeSession;
    if (session === null) continue;
    const start = rthOnly ? session.open : session.extendedOpen;
    const close = rthOnly ? session.close : session.extendedClose;
    if (row.bar.time < start || row.bar.time >= close) continue;
    const bucket = start + Math.floor((row.bar.time - start) / (minutes * 60)) * minutes * 60;
    const end = Math.min(bucket + minutes * 60, close);
    if (row.endExclusive > end) throw new Error('Source aggregate crosses historical bucket/session');
    if (end > now) continue;
    if (minutes === 1) {
      result.push({ ...row, bar: { ...row.bar }, endExclusive: end });
      continue;
    }
    const group = groups.get(bucket) ?? [];
    group.push(row); groups.set(bucket, group); ends.set(bucket, end);
  }
  for (const [time, group] of groups) {
    const first = group[0]; const last = group[group.length - 1]; const endExclusive = ends.get(time);
    if (first === undefined || last === undefined || endExclusive === undefined) continue;
    if (group.some((row) => row.historicalProvider !== first.historicalProvider)) throw new Error('Mixed provider within historical bucket');
    const moments = historicalMomentsSince(group, time, endExclusive);
    const realVwBars = group.reduce((sum, row) => sum + row.realVwBars, 0);
    const proxyBars = group.reduce((sum, row) => sum + row.proxyBars, 0);
    const price = moments.V > 0 ? moments.PV / moments.V : Number.NaN;
    const bar: Bar = { time, open: first.bar.open, high: Math.max(...group.map((row) => row.bar.high)), low: Math.min(...group.map((row) => row.bar.low)), close: last.bar.close, volume: moments.V,
      ...(proxyBars === 0 && moments.V > 0 ? { vw: price } : {}) };
    result.push({ bar, endExclusive, historicalProvider: first.historicalProvider,
      priceSource: proxyBars === 0 ? 'REAL_VW' : realVwBars === 0 ? 'HLC3_PROXY' : 'MIXED_VW_HLC3', price, moments,
      sourceMinutes: first.sourceMinutes, realVwBars, proxyBars,
      adjustment: first.adjustment,
      quality: group.every((row) => row.quality === 'CANONICAL_1M_MOMENTS') ? 'CANONICAL_1M_MOMENTS' : 'SOURCE_BAR_MOMENTS' });
  }
  return result;
}

export interface HistoricalPlan {
  readonly historicalProvider: HistoricalProvider;
  readonly historyFrom: number;
  readonly monthAnchor: number;
  readonly requiredBars: number;
  readonly visibleBars: number;
  readonly warmupBars: number;
  /** Adaptive defaults cover actual sessions; nominal budget never pulls warm-up into view. */
  readonly visibleFrom?: number;
  readonly expectedVisibleBars?: number;
  readonly segments: readonly { readonly from: number; readonly to: number; readonly sourceMinutes: number }[];
}

/** Count actual session buckets backwards, keeping the monthly prefix independent. */
export function planUsHistorical(tf: UsHistoricalTimeframe, now: number, rthOnly: boolean, explicitVisible?: number, adaptiveWindow = false): HistoricalPlan {
  if (explicitVisible !== undefined && (!Number.isInteger(explicitVisible) || explicitVisible < 1)) throw new Error('Invalid historical visibleBars');
  const p = getMarketParts(now, 'EQUITY');
  const monthStart = etWallTimeToUtc(p.year, p.month, 1, 0);
  let monthAnchor = monthStart;
  let mtd = 0;
  for (let time = monthStart + 12 * 3600; time <= now + 86400; time += 86400) {
    const session = usHistoricalSession(time);
    if (session !== null && session.open <= now && session.open >= monthStart) {
      if (mtd === 0) monthAnchor = rthOnly ? session.open : session.extendedOpen;
      mtd += 1;
    }
  }
  const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 }[tf];
  const windowSessions = tf === '5m' ? Math.min(23, Math.max(22, mtd)) : tf === '15m' ? 40 : tf === '1m' ? rthOnly ? 5 : 3 : 0;
  const warmupBars = 1000;
  let from = now; let available = 0; let visible = 0; let sessions = 0; let requiredBars = 0;
  let visibleFrom: number | undefined;
  for (let day = 0; ; day += 1) {
    const session = usHistoricalSession(now - day * 86400);
    if (session === null) continue;
    const open = rthOnly ? session.open : session.extendedOpen;
    const close = Math.min(rthOnly ? session.close : session.extendedClose, now);
    const count = Math.max(0, Math.floor((close - open) / (minutes * 60))) + (close === session.close && rthOnly && minutes === 60 ? 1 : 0);
    if (count === 0) continue;
    sessions += 1;
    if (sessions <= windowSessions) visible += count;
    if (sessions === windowSessions) visibleFrom = open;
    available += count; from = open;
    const targetVisible = explicitVisible ?? (tf === '1h' ? 1000 : visible);
    // 1H explicitly requests visibleBars + 1000; its default visibleBars is 1000.
    // Other TFs retain the approved session window independently of rendering depth.
    if ((tf === '1h' || sessions >= windowSessions) && available >= Math.max(targetVisible, visible) + warmupBars) {
      requiredBars = Math.max(targetVisible, visible) + warmupBars;
      visible = targetVisible; break;
    }
  }
  const to = Math.floor(now / 60) * 60;
  // 5m remains canonical 1m even before this month. 15m/1h use native older history.
  const canonicalFrom = tf === '1m' || tf === '5m' ? Math.min(from, monthAnchor) : monthAnchor;
  const segments: { from: number; to: number; sourceMinutes: number }[] = [];
  if (from < canonicalFrom) segments.push({ from, to: canonicalFrom, sourceMinutes: tf === '15m' ? 15 : 30 });
  segments.push({ from: canonicalFrom, to, sourceMinutes: 1 });
  const sessionCoverage = adaptiveWindow && visibleFrom !== undefined
    ? { visibleFrom, expectedVisibleBars: visible } : {};
  return { historicalProvider: 'MASSIVE_REST', historyFrom: from, monthAnchor,
    visibleBars: adaptiveWindow ? resolveAdaptiveVisibleBars(tf, rthOnly ? 'RTH' : 'EXTENDED', mtd) : visible,
    warmupBars, requiredBars, segments, ...sessionCoverage };
}

/** Current ET month, exchange sessions whose open has occurred (never server-local days). */
export function usHistoricalMtdSessions(now: number): number {
  const p = getMarketParts(now, 'EQUITY');
  let count = 0;
  for (let day = 1; day <= p.day; day += 1) {
    const session = usHistoricalSession(etWallTimeToUtc(p.year, p.month, day, 720));
    if (session !== null && session.open <= now) count += 1;
  }
  return count;
}

/** FMP floor is deliberately independent of Massive's optimized session lookback. */
export function planUsFmpHistorical(tf: UsHistoricalTimeframe, now: number, rthOnly: boolean, visibleBars: number, additionalFrom?: number): HistoricalPlan {
  const p = getMarketParts(now, 'EQUITY');
  let monthAnchor = etWallTimeToUtc(p.year, p.month, 1, 0);
  for (let day = 1; day <= p.day; day += 1) {
    const session = usHistoricalSession(etWallTimeToUtc(p.year, p.month, day, 720));
    if (session !== null) { monthAnchor = rthOnly ? session.open : session.extendedOpen; break; }
  }
  const requiredBars = visibleBars + 1000;
  const nativeFrom = restHistoricalFromUtcSec({ toUtcSec: now, provider: 'FMP_ENTERPRISE_REST', timeframe: tf, includeExtended: !rthOnly, targetBars: requiredBars });
  if (!Number.isFinite(nativeFrom) || (additionalFrom !== undefined && !Number.isSafeInteger(additionalFrom))) throw new Error('Invalid FMP historical window');
  const floor = tf === '1m' ? Math.min(nativeFrom, monthAnchor) : nativeFrom;
  const historyFrom = additionalFrom === undefined ? floor : Math.min(floor, additionalFrom);
  const sourceMinutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 }[tf];
  return { historicalProvider: 'FMP', historyFrom, monthAnchor, visibleBars, warmupBars: 1000, requiredBars, segments: [{ from: historyFrom, to: now, sourceMinutes }] };
}
