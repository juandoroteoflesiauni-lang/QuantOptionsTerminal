import { describe, expect, it } from 'vitest';
import { loadBars } from '../src/data/loader.js';
import type { FetchFn } from '../src/data/types.js';

/**
 * Instante fijo divisible entre 60: los dos minutos previos quedan cerrados
 * y la barra en formación (la del minuto en curso) no está en las filas.
 */
const NOW = 1_760_000_020;
const T1 = NOW - 120;
const T2 = NOW - 60;
const BASE = 'https://api.polygon.io';

const RATE_LIMIT_BODY = JSON.stringify({
  status: 'ERROR',
  error: "You've exceeded the maximum requests per minute",
});

function massiveRow(timeSeconds: number): Record<string, number> {
  return {
    t: timeSeconds * 1_000,
    o: 100,
    h: 101,
    l: 99,
    c: 100.5,
    v: 10,
    vw: 100.4,
  };
}

function massivePage(
  rows: readonly Record<string, number>[],
  nextUrl?: string,
): string {
  return JSON.stringify({
    status: 'OK',
    results: rows,
    ...(nextUrl === undefined ? {} : { next_url: nextUrl }),
  });
}

function bingxPage(rows: readonly (readonly number[])[]): string {
  return JSON.stringify({ code: 0, data: rows, timestamp: NOW * 1_000 });
}

function bingxRow(timeSeconds: number): readonly number[] {
  return [timeSeconds * 1_000, 100, 101, 99, 100.5, 10];
}

interface QueueEntry {
  readonly ok?: boolean;
  readonly status?: number;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number | null;
}

/** Cada llamada consume la siguiente entrada encolada. */
function queuedFetch(entries: readonly QueueEntry[], calls: string[]): FetchFn {
  return (url: string) => {
    calls.push(url);
    const entry = entries[calls.length - 1];
    if (entry === undefined) {
      return Promise.reject(new Error('unexpected request'));
    }
    return Promise.resolve({
      ok: entry.ok ?? true,
      status: entry.status ?? 200,
      text: entry.text,
      ...(entry.headers === undefined ? {} : { headers: entry.headers }),
      ...(entry.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: entry.retryAfterSeconds }),
    });
  };
}

function spySleep(sleeps: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
}

const FOUR_TWENTY_NINE = { ok: false, status: 429, text: RATE_LIMIT_BODY };

describe('loadBars: ritmo y reintentos ante 429', () => {
  it('reintenta un 429 con Retry-After y completa la carga (sin espaciado por defecto)', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [
        { ok: false, status: 429, text: RATE_LIMIT_BODY, retryAfterSeconds: 1 },
        { text: massivePage([massiveRow(T1), massiveRow(T2)]) },
      ],
      calls,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 2,
    });

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(result.report.providerError).toBeNull();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('agotados los reintentos (retry429MaxAttempts: 2) corta con providerError 429', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [FOUR_TWENTY_NINE, FOUR_TWENTY_NINE, FOUR_TWENTY_NINE],
      calls,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 2,
    });

    expect(result.report.stoppedReason).toBe('providerError');
    expect(result.report.providerError?.code).toBe(429);
    expect(result.report.providerError?.message).toContain('exceeded');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('interpreta Retry-After de la cabecera cuando el transporte no lo trae parsedo', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [
        {
          ok: false,
          status: 429,
          text: RATE_LIMIT_BODY,
          headers: { 'retry-after': '9' },
        },
        { text: massivePage([massiveRow(T1), massiveRow(T2)]) },
      ],
      calls,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 2,
    });

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(sleeps).toEqual([9_000]);
  });

  it('recorta la espera de Retry-After a retry429MaxDelayMs', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [
        { ok: false, status: 429, text: RATE_LIMIT_BODY, retryAfterSeconds: 120 },
        { text: massivePage([massiveRow(T1), massiveRow(T2)]) },
      ],
      calls,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 2,
      retry429MaxDelayMs: 5_000,
    });

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(sleeps).toEqual([5_000]);
  });

  it('por defecto (sin retry429MaxAttempts) no reintenta HTTP 429 (opt-in)', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch([FOUR_TWENTY_NINE], calls);
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
    });

    expect(result.report.stoppedReason).toBe('providerError');
    expect(result.report.providerError?.code).toBe(429);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retry429MaxAttempts = 0 desactiva el reintento (comportamiento previo)', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch([FOUR_TWENTY_NINE], calls);
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 0,
    });

    expect(result.report.stoppedReason).toBe('providerError');
    expect(result.report.providerError?.code).toBe(429);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('minRequestIntervalMs añade una pausa fija entre páginas (default 0 no duerme)', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [
        { text: massivePage([massiveRow(T1)], `${BASE}/v2/aggs/ticker/SPY/range/1/minute/0/0`) },
        { text: massivePage([massiveRow(T2)]) },
      ],
      calls,
    );
    const result = await loadBars({
      provider: 'massive',
      symbol: 'SPY',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn,
      sleepFn: spySleep(sleeps),
      minRequestIntervalMs: 250,
    });

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it('BingX comparte el mismo reintento ante 429', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchFn = queuedFetch(
      [
        { ok: false, status: 429, text: RATE_LIMIT_BODY, retryAfterSeconds: 2 },
        { text: bingxPage([bingxRow(T1), bingxRow(T2)]) },
      ],
      calls,
    );
    const result = await loadBars({
      provider: 'bingx',
      symbol: 'BTC-USDT',
      timeframe: '1m',
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      fetchFn,
      sleepFn: spySleep(sleeps),
      retry429MaxAttempts: 2,
    });

    expect(result.report.stoppedReason).toBe('targetReached');
    expect(result.report.providerError).toBeNull();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2_000]);
  });

  it('valida las opciones nuevas', async () => {
    const base = {
      provider: 'massive' as const,
      symbol: 'SPY',
      timeframe: '1m' as const,
      visibleBars: 1,
      warmupBars: 1,
      now: NOW,
      apiKey: 'test-key',
      fetchFn: () => Promise.reject(new Error('no request expected')),
    };
    await expect(
      loadBars({ ...base, minRequestIntervalMs: -1 }),
    ).rejects.toThrow('minRequestIntervalMs must be a non-negative integer');
    await expect(
      loadBars({ ...base, retry429MaxAttempts: 1.5 }),
    ).rejects.toThrow('retry429MaxAttempts must be a non-negative integer');
    await expect(
      loadBars({ ...base, retry429BaseDelayMs: -5 }),
    ).rejects.toThrow('retry429BaseDelayMs must be a non-negative integer');
    await expect(
      loadBars({ ...base, retry429MaxDelayMs: 2.5 }),
    ).rejects.toThrow('retry429MaxDelayMs must be a non-negative integer');
  });
});
