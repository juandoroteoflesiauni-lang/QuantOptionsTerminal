import { describe, expect, it } from 'vitest';
import type { FetchResponse } from '../src/data/types.js';
import {
  DEFAULT_CONNECTION_LIMIT_COOLDOWN_MS,
  MIN_RECONNECT_BACKOFF_MS,
  WS_CLUSTER_URLS,
  type WsClientError,
  type WsCluster,
  type WsSocketFactory,
  type WsSocketLike,
} from '../src/data/wsTypes.js';
import type { FmpConfig } from '../src/server/fmpClient.js';
import type { TradierConfig } from '../src/server/tradierAdapter.js';
import { MassiveWsClient, isConnectionLimitMessage } from '../src/data/wsClient.js';
import { MarketRuntime } from '../src/server/marketRuntime.js';
import {
  MASSIVE_WS_EXCLUDED_KEY_ENVS,
  MASSIVE_WS_STOCKS_FUTURE_CANDIDATE_ENV,
  MassiveKeyRouter,
  MassivePoolExhaustedError,
  collectMassiveSecretsFromSource,
  isMassivePoolExhaustedError,
  verifyMassiveEndpointForDomain,
  type MassiveEnvSource,
} from '../src/server/massiveKeyPool.js';
import { collectBrokerSecretsFromEnv } from '../src/server/primaryRofexLoader.js';
import {
  formatRedactedError,
  redactErrorDeep,
  redactHeaders,
  redactSecrets,
} from '../src/server/runtimeCache.js';

const SYNTH_API_KEY = 'SYNTH_OPT_PRIMARY_AAA111';
const SYNTH_KEY_1 = 'SYNTH_STK_BACKUP_BBB222';
const SYNTH_KEY_2 = 'SYNTH_STK_PRIM2_CCC333';
const SYNTH_KEY_3 = 'SYNTH_STK_PRIM3_DDD444';
const SYNTH_KEY_FUT = 'SYNTH_FUT_ONLY_EEE555';
const SYNTH_WS_STOCKS = 'SYNTH_WS_LEGACY_FFF666';
const SYNTH_LEGACY_REST = 'SYNTH_LEGACY_SINGLE_GGG777';
const SYNTH_LEGACY_LIST_A = 'SYNTH_LEGACY_LISTA_HHH888';
const SYNTH_LEGACY_LIST_B = 'SYNTH_LEGACY_LISTB_III999';

function makeMassiveEnv(overrides: Readonly<Record<string, string | undefined>> = {}): MassiveEnvSource {
  const env: NodeJS.ProcessEnv = {
    MASSIVE_API_KEY: SYNTH_API_KEY,
    MASSIVE_KEY_1: SYNTH_KEY_1,
    MASSIVE_KEY_2: SYNTH_KEY_2,
    MASSIVE_KEY_3: SYNTH_KEY_3,
    MASSIVE_KEY_FUTURES: SYNTH_KEY_FUT,
    MASSIVE_WS_STOCKS_KEY: SYNTH_WS_STOCKS,
    MASSIVE_REST_KEY: SYNTH_LEGACY_REST,
    MASSIVE_REST_KEYS: `${SYNTH_LEGACY_LIST_A}, ${SYNTH_LEGACY_LIST_B}`,
    ...overrides,
  };
  return { env, fileValues: new Map<string, string>() };
}

function jsonOk(payload: unknown): FetchResponse {
  return { ok: true, status: 200, text: JSON.stringify(payload) };
}

const DISABLED_TRADIER_CONFIG: TradierConfig = {
  accessToken: null,
  tokenEnvName: null,
  apiEnv: 'prod',
  restBaseUrl: 'https://api.tradier.com',
  wsBaseUrl: 'wss://ws.tradier.com',
  configured: false,
  tokenIsGeneric: false,
  sandboxFallbackAllowed: false,
};

const DISABLED_FMP_CONFIG: FmpConfig = {
  apiKey: null,
  quotesApiKey: null,
  marketApiKey: null,
  etfApiKey: null,
  macroApiKey: null,
  configured: false,
  baseUrl: 'https://financialmodelingprep.com/stable',
};

function makeControlledClock(initialMs = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = initialMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface MockSocketHandle {
  readonly url: string;
  readonly sentFrames: string[];
  readonly closedWith: Array<{ readonly code: number | undefined; readonly reason: string | undefined }>;
  readonly socket: WsSocketLike;
  triggerOpen: () => void;
  triggerMessage: (payload: unknown) => void;
  triggerClose: (code: number, reason?: string, wasClean?: boolean) => void;
  triggerError: (err: unknown) => void;
}

function createMockWsHarness(): {
  readonly sockets: MockSocketHandle[];
  readonly factory: WsSocketFactory;
} {
  const sockets: MockSocketHandle[] = [];
  const factory: WsSocketFactory = (url: string): WsSocketLike => {
    const sentFrames: string[] = [];
    const closedWith: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
    const socket: WsSocketLike = {
      send: (data: string) => {
        sentFrames.push(data);
      },
      close: (code?: number, reason?: string) => {
        closedWith.push({ code, reason });
      },
      onOpen: null,
      onMessage: null,
      onClose: null,
      onError: null,
    };
    const handle: MockSocketHandle = {
      url,
      sentFrames,
      closedWith,
      socket,
      triggerOpen: () => {
        socket.onOpen?.();
      },
      triggerMessage: (payload: unknown) => {
        socket.onMessage?.(typeof payload === 'string' ? payload : JSON.stringify(payload));
      },
      triggerClose: (code: number, reason = '', wasClean = false) => {
        socket.onClose?.({ code, reason, wasClean });
      },
      triggerError: (err: unknown) => {
        socket.onError?.(err);
      },
    };
    sockets.push(handle);
    return socket;
  };
  return { sockets, factory };
}

function createControlledSleep(): {
  readonly delays: number[];
  sleep: (ms: number) => Promise<void>;
  releaseNext: () => void;
} {
  const delays: number[] = [];
  const waiters: Array<() => void> = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    releaseNext: () => {
      const fn = waiters.shift();
      fn?.();
    },
  };
}

function extractApiKeyFromUrl(url: string): string {
  const parsed = new URL(url, 'https://api.massive.com');
  return parsed.searchParams.get('apikey') ?? parsed.searchParams.get('apiKey') ?? '';
}

function assertNoSecretLeak(text: string, secrets: readonly string[]): void {
  for (const s of secrets) {
    if (s.length >= 6) {
      expect(text).not.toContain(s);
      expect(text).not.toContain(encodeURIComponent(s));
      expect(text).not.toContain(s.slice(0, 6));
      expect(text).not.toContain(s.slice(-4));
    }
  }
}

describe('Pieza 0A — §5.1 Integral secret redaction', () => {
  it('collects all Massive & broker secrets including comma-split MASSIVE_REST_KEYS', () => {
    const source = makeMassiveEnv();
    const collected = collectMassiveSecretsFromSource(source);
    const allExpected = [
      SYNTH_API_KEY,
      SYNTH_KEY_1,
      SYNTH_KEY_2,
      SYNTH_KEY_3,
      SYNTH_KEY_FUT,
      SYNTH_WS_STOCKS,
      SYNTH_LEGACY_REST,
      SYNTH_LEGACY_LIST_A,
      SYNTH_LEGACY_LIST_B,
    ];
    for (const secret of allExpected) {
      expect(collected).toContain(secret);
    }

    const brokerSecrets = collectBrokerSecretsFromEnv({
      ...source.env,
      MASSIVE_KEY: 'SYNTH_BROKER_EXTRA_111',
      FMP_API_KEY: 'SYNTH_FMP_SECRET_222',
    });
    expect(brokerSecrets).toContain(SYNTH_LEGACY_LIST_A);
    expect(brokerSecrets).toContain(SYNTH_LEGACY_LIST_B);
    expect(brokerSecrets).toContain(SYNTH_KEY_2);
    expect(brokerSecrets).toContain(SYNTH_KEY_FUT);
    expect(brokerSecrets).toContain('SYNTH_BROKER_EXTRA_111');
  });

  it('redacts secrets in URLs, auth query params, headers, nested/circular Error.cause and AggregateError', () => {
    const secrets = [SYNTH_API_KEY, SYNTH_KEY_2, SYNTH_LEGACY_LIST_A, SYNTH_LEGACY_LIST_B];

    const dirtyUrl =
      `https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/1/2?apikey=${encodeURIComponent(SYNTH_KEY_2)}&access_token=TOK_XYZ_999&Authorization=Bearer%20${SYNTH_API_KEY}`;
    const cleanedUrl = redactSecrets(dirtyUrl, secrets);
    assertNoSecretLeak(cleanedUrl, secrets);
    expect(cleanedUrl).not.toContain('TOK_XYZ_999');

    const headersOut = redactHeaders(
      {
        Authorization: `Bearer ${SYNTH_API_KEY}`,
        'X-Api-Key': SYNTH_KEY_2,
        'x-auth-token': 'SECRET_HDR_TOKEN_123',
        'content-type': 'application/json',
      },
      secrets,
    );
    expect(headersOut['Authorization']).toBe('[REDACTED]');
    expect(headersOut['X-Api-Key']).toBe('[REDACTED]');
    expect(headersOut['x-auth-token']).toBe('[REDACTED]');
    expect(headersOut['content-type']).toBe('application/json');

    const rootCause = new Error(`upstream rejected key=${SYNTH_LEGACY_LIST_B}`);
    const middleCause = new Error(`middle Authorization: Bearer ${SYNTH_KEY_2}`, {
      cause: rootCause,
    });
    const topErr = new Error(`GET https://api.massive.com/x?apiKey=${SYNTH_API_KEY}`, {
      cause: middleCause,
    });
    // Induce a cycle to ensure WeakSet cycle protection works safely
    (rootCause as Error & { cause?: unknown }).cause = topErr;

    const formatted = formatRedactedError(topErr, secrets);
    assertNoSecretLeak(formatted, secrets);
    expect(formatted).toContain('<redacted>');

    const deepClone = redactErrorDeep(topErr, secrets);
    assertNoSecretLeak(deepClone.message, secrets);
    assertNoSecretLeak(deepClone.stack ?? '', secrets);

    const aggErr = new AggregateError(
      [new Error(`branch1 ${SYNTH_KEY_2}`), new Error(`branch2 ${SYNTH_API_KEY}`)],
      `aggregate failure ${SYNTH_LEGACY_LIST_A}`,
    );
    const formattedAgg = formatRedactedError(aggErr, secrets);
    assertNoSecretLeak(formattedAgg, secrets);
  });

  it('exposes only logical slotIds and never secret prefixes or suffixes in status() or MassivePoolExhaustedError', async () => {
    const router = new MassiveKeyRouter(makeMassiveEnv());
    const secrets = router.getSecrets();
    const statusJson = JSON.stringify(router.status());
    assertNoSecretLeak(statusJson, secrets);
    expect(statusJson).toContain('STOCKS_SLOT_2');
    expect(statusJson).toContain('STOCKS_SLOT_3');
    expect(statusJson).toContain('STOCKS_SLOT_1');
    expect(statusJson).toContain('STOCKS_SHARED_OPTIONS_FALLBACK');
    expect(statusJson).toContain('OPTIONS_SLOT_1');
    expect(statusJson).toContain('FUTURES_SLOT_1');

    let caught: unknown = null;
    try {
      await router.executeRest({
        domain: 'OPTIONS_REST',
        url: 'https://api.massive.com/v3/snapshot/options/SPY',
        fetchFn: () => Promise.resolve({ ok: false, status: 403, text: `bad key ${SYNTH_API_KEY}` }),
      });
    } catch (err: unknown) {
      caught = err;
    }

    expect(isMassivePoolExhaustedError(caught)).toBe(true);
    const exhausted = caught as MassivePoolExhaustedError;
    assertNoSecretLeak(exhausted.message, secrets);
    assertNoSecretLeak(JSON.stringify(exhausted.attempts), secrets);
    expect(exhausted.attempts[0]?.slotId).toBe('OPTIONS_SLOT_1');
  });
});

describe('Pieza 0A — §5.2 Domain REST segregation, SharedOptionsQuotaGuard & legacy isolation', () => {
  it('routes STOCKS_REST primary KEY_2/KEY_3 round-robin and ordered fallback KEY_1 -> API_KEY', async () => {
    const clock = makeControlledClock();
    const router = new MassiveKeyRouter(makeMassiveEnv(), { nowMsFn: clock.now });
    const usedKeys: string[] = [];

    const mockFetch = (url: string): Promise<FetchResponse> => {
      const k = extractApiKeyFromUrl(url);
      usedKeys.push(k);
      if (k === SYNTH_KEY_2 || k === SYNTH_KEY_3) {
        return Promise.resolve({ ok: false, status: 429, text: 'rate limited', retryAfterSeconds: 30 });
      }
      return Promise.resolve(jsonOk({ results: [] }));
    };

    // Call 1: primaries KEY_2, KEY_3 fail with 429 -> falls back to KEY_1 (STOCKS_SLOT_1) and succeeds
    await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/AAPL/range/1/minute/1/2',
      fetchFn: mockFetch,
    });
    expect(usedKeys.slice(0, 3)).toEqual([SYNTH_KEY_2, SYNTH_KEY_3, SYNTH_KEY_1]);

    // Call 2 when KEY_1 also fails -> reaches emergency fallback SYNTH_API_KEY
    usedKeys.length = 0;
    await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/MSFT/range/1/minute/1/2',
      fetchFn: (url) => {
        const k = extractApiKeyFromUrl(url);
        usedKeys.push(k);
        if (k === SYNTH_KEY_1) {
          return Promise.resolve({ ok: false, status: 503, text: 'unavailable' });
        }
        return Promise.resolve(jsonOk({ ok: true }));
      },
    });
    expect(usedKeys).toEqual([SYNTH_KEY_1, SYNTH_API_KEY]);

    // Advance past 30s -> KEY_2 & KEY_3 recover and round-robin alternating first slot
    clock.advance(31_000);
    usedKeys.length = 0;
    await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/NVDA/range/1/minute/1/2',
      fetchFn: mockFetch,
    });
    await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/1/2',
      fetchFn: (url) => {
        usedKeys.push(extractApiKeyFromUrl(url));
        return Promise.resolve(jsonOk({ results: [] }));
      },
    });
    expect(usedKeys).toContain(SYNTH_KEY_2);
    expect(usedKeys).toContain(SYNTH_KEY_3);
    // Healthy normal calls never hit FUTURES or LEGACY keys
    expect(usedKeys).not.toContain(SYNTH_KEY_FUT);
    expect(usedKeys).not.toContain(SYNTH_LEGACY_REST);
    expect(usedKeys).not.toContain(SYNTH_LEGACY_LIST_A);
  });

  it('strictly locks OPTIONS_REST to MASSIVE_API_KEY only and FUTURES_REST to MASSIVE_KEY_FUTURES', async () => {
    const router = new MassiveKeyRouter(makeMassiveEnv());
    const optionsKeys: string[] = [];

    await expect(
      router.executeRest({
        domain: 'OPTIONS_REST',
        url: 'https://api.massive.com/v3/snapshot/options/SPY',
        fetchFn: (url) => {
          optionsKeys.push(extractApiKeyFromUrl(url));
          return Promise.resolve({ ok: false, status: 429, text: 'options limit' });
        },
      }),
    ).rejects.toBeInstanceOf(MassivePoolExhaustedError);

    // Must attempt ONLY OPTIONS_SLOT_1 (SYNTH_API_KEY) and NEVER touch KEY_2/KEY_3/KEY_1/FUTURES
    expect(optionsKeys).toEqual([SYNTH_API_KEY]);

    const futKeys: string[] = [];
    await router.executeRest({
      domain: 'FUTURES_REST',
      url: 'https://api.massive.com/futures/vX/contracts',
      fetchFn: (url) => {
        futKeys.push(extractApiKeyFromUrl(url));
        return Promise.resolve(jsonOk({ ok: true }));
      },
    });
    expect(futKeys).toEqual([SYNTH_KEY_FUT]);

    // Domain endpoint mismatch check rejects non-futures paths on FUTURES_REST
    expect(verifyMassiveEndpointForDomain('https://api.massive.com/futures/vX/contracts', 'FUTURES_REST')).toBe(true);
    expect(verifyMassiveEndpointForDomain('https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/1/2', 'FUTURES_REST')).toBe(false);
    await expect(
      router.executeRest({
        domain: 'FUTURES_REST',
        url: 'https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/1/2',
        fetchFn: () => Promise.resolve(jsonOk({})),
      }),
    ).rejects.toMatchObject({ reason: 'DOMAIN_ENDPOINT_MISMATCH' });

    // Ignore legacy MASSIVE_REST_KEY / MASSIVE_REST_KEYS as routing pools
    const legacyOnlyRouter = new MassiveKeyRouter(
      makeMassiveEnv({
        MASSIVE_API_KEY: undefined,
        MASSIVE_KEY_1: undefined,
        MASSIVE_KEY_2: undefined,
        MASSIVE_KEY_3: undefined,
        MASSIVE_KEY_FUTURES: undefined,
        MASSIVE_WS_STOCKS_KEY: undefined,
      }),
    );
    expect(legacyOnlyRouter.status().configured).toBe(false);
    expect(legacyOnlyRouter.status().legacySharedEnvIgnored).toEqual({
      massiveRestKeyPresent: true,
      massiveRestKeysPresent: true,
    });
    expect(legacyOnlyRouter.getSecrets()).toContain(SYNTH_LEGACY_REST);
    expect(legacyOnlyRouter.getSecrets()).toContain(SYNTH_LEGACY_LIST_A);
    expect(legacyOnlyRouter.getSecrets()).toContain(SYNTH_LEGACY_LIST_B);
  });

  it('isolates cursors/penalties between domains and activates SharedOptionsQuotaGuard when Options hits 429', async () => {
    const clock = makeControlledClock();
    const router = new MassiveKeyRouter(makeMassiveEnv(), {
      nowMsFn: clock.now,
      optionsPriorityWindowMs: 60_000,
    });

    // Options hits 429 -> SharedOptionsQuotaGuard reserves SYNTH_API_KEY for Options
    await expect(
      router.executeRest({
        domain: 'OPTIONS_REST',
        url: 'https://api.massive.com/v3/reference/options/contracts?underlying_ticker=SPY',
        fetchFn: () => Promise.resolve({ ok: false, status: 429, text: 'options quota', retryAfterSeconds: 10 }),
      }),
    ).rejects.toBeInstanceOf(MassivePoolExhaustedError);

    // Exhaust dedicated Stocks keys (KEY_2, KEY_3, KEY_1) with 429 -> must NOT touch shared SYNTH_API_KEY
    const stocksSeen: string[] = [];
    await expect(
      router.executeRest({
        domain: 'STOCKS_REST',
        url: 'https://api.massive.com/v2/aggs/ticker/QQQ/range/1/minute/1/2',
        fetchFn: (url) => {
          stocksSeen.push(extractApiKeyFromUrl(url));
          return Promise.resolve({ ok: false, status: 429, text: 'stocks rate limit', retryAfterSeconds: 10 });
        },
      }),
    ).rejects.toMatchObject({ reason: 'SHARED_FALLBACK_RESERVED_FOR_OPTIONS' });

    expect(stocksSeen).toEqual([SYNTH_KEY_2, SYNTH_KEY_3, SYNTH_KEY_1]);
    expect(stocksSeen).not.toContain(SYNTH_API_KEY);

    // After priority window expires, Options succeeds without interference from Stocks penalties
    clock.advance(65_000);
    const optOk: string[] = [];
    await router.executeRest({
      domain: 'OPTIONS_REST',
      url: 'https://api.massive.com/v3/snapshot/options/SPY',
      fetchFn: (url) => {
        optOk.push(extractApiKeyFromUrl(url));
        return Promise.resolve(jsonOk({ results: [] }));
      },
    });
    expect(optOk).toEqual([SYNTH_API_KEY]);
  });

  it('handles disabled slots, duplicate secrets across env vars, and zero duplicate requests', async () => {
    const router = new MassiveKeyRouter(
      makeMassiveEnv({
        MASSIVE_KEY_2: SYNTH_KEY_1, // Duplicate credential across KEY_2 and KEY_1
        MASSIVE_KEY_3: undefined,
      }),
      { disabledSlots: ['OPTIONS_SLOT_1'] },
    );

    expect(router.status().domains.OPTIONS_REST.configured).toBe(false);

    const attempts: string[] = [];
    await expect(
      router.executeRest({
        domain: 'STOCKS_REST',
        url: 'https://api.massive.com/v2/aggs/ticker/AAPL/range/1/minute/1/2',
        fetchFn: (url) => {
          attempts.push(extractApiKeyFromUrl(url));
          return Promise.resolve({ ok: false, status: 500, text: 'server err' });
        },
      }),
    ).rejects.toBeInstanceOf(MassivePoolExhaustedError);

    // Must deduplicate identical credential SYNTH_KEY_1 and then try SYNTH_API_KEY only once each
    expect(attempts).toEqual([SYNTH_KEY_1, SYNTH_API_KEY]);
  });
});

describe('Pieza 0A — §5.3 HTTP failover, non-retryable 4xx, deadlines, AbortSignal & concurrency', () => {
  it('fails over across 403, 503 and attempt timeout, without retrying 400/404 or abort', async () => {
    const clock = makeControlledClock();
    const router = new MassiveKeyRouter(makeMassiveEnv(), {
      nowMsFn: clock.now,
      perAttemptTimeoutMs: 50,
    });

    // 403 on KEY_2 -> PENALIZED_AUTH, fails over to KEY_3 (200) without re-sending KEY_2
    const seenAuthFailover: string[] = [];
    const authRes = await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/AAPL/range/1/minute/1/2',
      fetchFn: (url) => {
        const k = extractApiKeyFromUrl(url);
        seenAuthFailover.push(k);
        if (k === SYNTH_KEY_2) {
          return Promise.resolve({ ok: false, status: 403, text: 'forbidden' });
        }
        return Promise.resolve(jsonOk({ ok: true }));
      },
    });
    expect(authRes.status).toBe(200);
    expect(seenAuthFailover).toEqual([SYNTH_KEY_2, SYNTH_KEY_3]);
    const key2Status = router
      .status()
      .domains.STOCKS_REST.slots.find((s) => s.slotId === 'STOCKS_SLOT_2');
    expect(key2Status?.state).toBe('PENALIZED_AUTH');

    // Timeout on KEY_3 -> COOLDOWN_NETWORK -> fails over to KEY_1 (200)
    const seenTimeoutFailover: string[] = [];
    const timeoutRes = await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/MSFT/range/1/minute/1/2',
      fetchFn: (url) => {
        const k = extractApiKeyFromUrl(url);
        seenTimeoutFailover.push(k);
        if (k === SYNTH_KEY_3) {
          return new Promise<FetchResponse>(() => {
            // Never resolves -> hits perAttemptTimeoutMs
          });
        }
        return Promise.resolve(jsonOk({ ok: true }));
      },
    });
    expect(timeoutRes.status).toBe(200);
    expect(seenTimeoutFailover).toEqual([SYNTH_KEY_3, SYNTH_KEY_1]);

    // Non-retryable 404 returns immediately on 1st attempt with zero failure penalty
    clock.advance(2_000);
    const seen404: string[] = [];
    const res404 = await router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/ZZZZ/range/1/minute/1/2',
      fetchFn: (url) => {
        seen404.push(extractApiKeyFromUrl(url));
        return Promise.resolve({ ok: false, status: 404, text: 'not found' });
      },
    });
    expect(res404.status).toBe(404);
    expect(seen404).toHaveLength(1);

    // AbortSignal aborts cleanly without penalizing slot failureCount
    const ac = new AbortController();
    const beforeAbortSlot = router
      .status()
      .domains.STOCKS_REST.slots.find((s) => s.slotId === 'STOCKS_SLOT_1');
    const priorFailures = beforeAbortSlot?.failureCount ?? 0;

    const abortPromise = router.executeRest({
      domain: 'STOCKS_REST',
      url: 'https://api.massive.com/v2/aggs/ticker/NVDA/range/1/minute/1/2',
      signal: ac.signal,
      fetchFn: () =>
        new Promise<FetchResponse>(() => {
          // Wait for abort signal
        }),
    });
    ac.abort();
    await expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' });
    const afterAbortSlot = router
      .status()
      .domains.STOCKS_REST.slots.find((s) => s.slotId === 'STOCKS_SLOT_1');
    expect(afterAbortSlot?.failureCount).toBe(priorFailures);
  });

  it('absorbs 20 concurrent requests without retry storm and enforces totalDeadlineMs', async () => {
    const clock = makeControlledClock();
    const router = new MassiveKeyRouter(makeMassiveEnv(), {
      nowMsFn: clock.now,
      maxSharedFallbackCallsPerMinute: 100,
      maxSharedFallbackConcurrency: 25,
    });
    let totalFetchCalls = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_v, idx) =>
        router.executeRest({
          domain: 'STOCKS_REST',
          url: `https://api.massive.com/v2/aggs/ticker/SYM${String(idx)}/range/1/minute/1/2`,
          fetchFn: (url) => {
            totalFetchCalls += 1;
            const k = extractApiKeyFromUrl(url);
            if (k === SYNTH_KEY_2 || k === SYNTH_KEY_3) {
              return Promise.resolve({ ok: false, status: 429, text: 'rate limited', retryAfterSeconds: 60 });
            }
            return Promise.resolve(jsonOk({ idx }));
          },
        }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Wave 1 concurrent batch transitions cooled primaries rapidly (well below 80 unguarded attempts)
    expect(totalFetchCalls).toBeLessThanOrEqual(45);

    // Wave 2 while KEY_2/KEY_3 remain in cooldown executes zero wasted primary retries (10 requests = 10 calls)
    let wave2FetchCalls = 0;
    const wave2 = await Promise.all(
      Array.from({ length: 10 }, (_v, idx) =>
        router.executeRest({
          domain: 'STOCKS_REST',
          url: `https://api.massive.com/v2/aggs/ticker/W2S${String(idx)}/range/1/minute/1/2`,
          fetchFn: (url) => {
            wave2FetchCalls += 1;
            expect(extractApiKeyFromUrl(url)).toBe(SYNTH_KEY_1);
            return Promise.resolve(jsonOk({ idx }));
          },
        }),
      ),
    );
    expect(wave2.every((r) => r.status === 200)).toBe(true);
    expect(wave2FetchCalls).toBe(10);

    // totalDeadlineMs cap stops multi-attempt waits
    clock.advance(70_000);
    await expect(
      router.executeRest({
        domain: 'STOCKS_REST',
        url: 'https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/1/2',
        totalDeadlineMs: 60,
        perAttemptTimeoutMs: 40,
        fetchFn: () => {
          clock.advance(70);
          return Promise.resolve({ ok: false, status: 503, text: 'slow fail' });
        },
      }),
    ).rejects.toMatchObject({ reason: 'OPERATION_DEADLINE_EXCEEDED' });
  });
});

describe('Pieza 0A — §6 WS connection-limit circuit breaker & cluster policy', () => {
  it('blocks /futures WS cluster at construction time and documents candidate/excluded envs', () => {
    expect(MASSIVE_WS_STOCKS_FUTURE_CANDIDATE_ENV).toBe('MASSIVE_KEY_2');
    expect(MASSIVE_WS_EXCLUDED_KEY_ENVS).toContain('MASSIVE_KEY_1');
    expect(MASSIVE_WS_EXCLUDED_KEY_ENVS).toContain('MASSIVE_KEY_3');

    const harness = createMockWsHarness();
    expect(
      () =>
        new MassiveWsClient({
          apiKey: SYNTH_KEY_FUT,
          cluster: 'stocks',
          url: 'wss://socket.massive.com/futures',
          socketFactory: harness.factory,
        }),
    ).toThrow(/futures.*disabled/i);
    expect(
      () =>
        new MassiveWsClient({
          apiKey: SYNTH_KEY_FUT,
          cluster: 'futures' as WsCluster,
          socketFactory: harness.factory,
        }),
    ).toThrow(/futures.*disabled/i);
    expect(harness.sockets).toHaveLength(0);
    expect(WS_CLUSTER_URLS.options).toBe('wss://socket.massive.com/options');
  });

  it('trips circuit breaker immediately on max_connections & 1008 with 0 pending timers and duplicate-event idempotency', async () => {
    expect(isConnectionLimitMessage('Maximum number of connections exceeded')).toBe(true);
    expect(isConnectionLimitMessage('max_connections')).toBe(true);

    const clock = makeControlledClock();
    const sleep = createControlledSleep();
    const harness = createMockWsHarness();
    const errors: WsClientError[] = [];

    const client = new MassiveWsClient({
      apiKey: SYNTH_API_KEY,
      cluster: 'options',
      autoReconnect: true,
      nowMsFn: clock.now,
      connectionLimitCooldownMs: DEFAULT_CONNECTION_LIMIT_COOLDOWN_MS,
      socketFactory: harness.factory,
      sleep: sleep.sleep,
      onError: (e) => {
        errors.push(e);
      },
    });

    const connectP = client.connect();
    const sock1 = harness.sockets[0];
    expect(sock1).toBeDefined();
    if (sock1 === undefined) {
      throw new Error('sock1 missing');
    }
    sock1.triggerOpen();
    sock1.triggerMessage([
      { ev: 'status', status: 'max_connections', message: `Maximum concurrent connections reached for ${SYNTH_API_KEY}` },
    ]);
    await expect(connectP).rejects.toThrow();

    // Duplicate error & close frames after breaker already opened must stay completely idempotent
    sock1.triggerError(new Error('Maximum number of connections exceeded'));
    sock1.triggerClose(1008, 'Maximum number of connections exceeded', false);

    const snap = client.getSnapshot();
    expect(snap.circuitBreakerOpen).toBe(true);
    expect(snap.circuitBreakerReason).toBe('max_connections');
    expect(snap.pendingReconnectTimers).toBe(0);
    expect(sleep.delays).toEqual([]);
    expect(harness.sockets).toHaveLength(1);
    expect(errors.filter((e) => e.code === 'max_connections')).toHaveLength(1);
    assertNoSecretLeak(JSON.stringify(errors), [SYNTH_API_KEY]);

    // Recovery blocked while cooldown active, succeeds once cooldown elapses
    expect(() => {
      client.authorizeCircuitRecovery();
    }).toThrow(/cooldown/i);
    clock.advance(DEFAULT_CONNECTION_LIMIT_COOLDOWN_MS + 1_000);
    client.authorizeCircuitRecovery();
    expect(client.getSnapshot().circuitBreakerOpen).toBe(false);

    // Policy violation close 1008 (non-limit) emits ws_policy_violation_1008 with 0 timers
    const harness2 = createMockWsHarness();
    const sleep2 = createControlledSleep();
    const err2: WsClientError[] = [];
    const c2 = new MassiveWsClient({
      apiKey: SYNTH_API_KEY,
      cluster: 'options',
      autoReconnect: true,
      nowMsFn: clock.now,
      socketFactory: harness2.factory,
      sleep: sleep2.sleep,
      onError: (e) => {
        err2.push(e);
      },
    });
    const p2 = c2.connect();
    const s2 = harness2.sockets[0];
    if (s2 === undefined) {
      throw new Error('s2 missing');
    }
    s2.triggerOpen();
    s2.triggerMessage([{ ev: 'status', status: 'connected' }, { ev: 'status', status: 'auth_success' }]);
    await p2;
    s2.triggerClose(1008, 'Policy Violation', false);

    expect(c2.getSnapshot().circuitBreakerReason).toBe('policy_violation_1008');
    expect(c2.getSnapshot().pendingReconnectTimers).toBe(0);
    expect(sleep2.delays).toEqual([]);
    expect(err2.some((e) => e.code === 'ws_policy_violation_1008')).toBe(true);

    // /stocks cluster recovery is explicitly blocked by policy even without cooldown wait
    const harness3 = createMockWsHarness();
    const c3 = new MassiveWsClient({
      apiKey: SYNTH_KEY_2,
      cluster: 'stocks',
      autoReconnect: true,
      socketFactory: harness3.factory,
      sleep: createControlledSleep().sleep,
    });
    void c3.connect().catch(() => undefined);
    harness3.sockets[0]?.triggerClose(1008, 'Maximum number of connections exceeded');
    expect(() => {
      c3.authorizeCircuitRecovery({ force: true });
    }).toThrow(/stocks.*(?:disabled|standby|closed)/i);
  });

  it('preserves >= 15s exponential backoff on transient 1006 close without false circuit break', async () => {
    const harness = createMockWsHarness();
    const sleep = createControlledSleep();
    const client = new MassiveWsClient({
      apiKey: SYNTH_API_KEY,
      cluster: 'options',
      autoReconnect: true,
      socketFactory: harness.factory,
      sleep: sleep.sleep,
    });

    const p = client.connect();
    const s1 = harness.sockets[0];
    if (s1 === undefined) {
      throw new Error('s1 missing');
    }
    s1.triggerOpen();
    s1.triggerMessage([{ ev: 'status', status: 'connected' }, { ev: 'status', status: 'auth_success' }]);
    await p;

    s1.triggerClose(1006, 'network_drop', false);
    expect(client.getSnapshot().circuitBreakerOpen).toBe(false);
    expect(sleep.delays).toEqual([MIN_RECONNECT_BACKOFF_MS]);

    client.close();
    sleep.releaseNext();
  });
});

describe('Pieza 0A — MarketRuntime end-to-end integration (pools, WS standby & Tradier intact)', () => {
  it('routes MarketRuntime /stocks WS standby, /options WS on MASSIVE_API_KEY, getUnusual on OPTIONS_REST only, and Tradier untouched', async () => {
    const fixedNowMs = 1_700_000_000_000;
    const requestedUrls: string[] = [];
    const wsClustersOpened: string[] = [];
    const env = makeMassiveEnv().env;

    const runtime = new MarketRuntime({
      massiveEnv: env,
      nowMsFn: () => fixedNowMs,
      enableWs: true,
      createWsClientFn: (opts) => {
        wsClustersOpened.push(`${opts.cluster}:${opts.apiKey}`);
        const snap = {
          cluster: opts.cluster,
          url: WS_CLUSTER_URLS[opts.cluster],
          state: 'ready' as const,
          subscriptions: [],
          activeQuoteSubscriptionCount: 0,
          queueDepth: 0,
          droppedQueueMessages: 0,
          reconnectAttempts: 0,
          totalMessagesReceived: 0,
          discardedPayloads: 0,
          lastError: null,
          circuitBreakerOpen: false,
          circuitBreakerReason: null,
          circuitBreakerOpenedAtMs: null,
          circuitBreakerCooldownUntilMs: null,
          pendingReconnectTimers: 0,
        };
        return {
          connect: () => Promise.resolve(),
          subscribe: () => undefined,
          unsubscribe: () => undefined,
          drainInboundQueue: () => [],
          getSnapshot: () => snap,
          close: () => undefined,
        };
      },
      fetchFn: (url) => {
        requestedUrls.push(url);
        const path = new URL(url, 'https://api.massive.com').pathname;
        if (path === '/v3/snapshot') {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [
                {
                  ticker: 'SPY',
                  type: 'stocks',
                  market_status: 'open',
                  session: {
                    price: 595,
                    close: 595,
                    previous_close: 592,
                    change: 3,
                    change_percent: 0.5,
                    volume: 1_000_000,
                  },
                },
              ],
            }),
          );
        }
        if (path === '/fed/v1/treasury-yields') {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [
                {
                  date: '2023-11-14',
                  yield_1_month: 5.35,
                  yield_3_month: 5.4,
                  yield_6_month: 5.38,
                  yield_1_year: 5.2,
                  yield_2_year: 4.85,
                  yield_5_year: 4.5,
                  yield_10_year: 4.55,
                  yield_30_year: 4.7,
                },
              ],
            }),
          );
        }
        if (path === '/fed/v1/funding-conditions') {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [{ date: '2023-11-14', sofr: 5.31, effective_fed_funds_rate: 5.33 }],
            }),
          );
        }
        if (path === '/v3/reference/options/contracts') {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [
                {
                  ticker: 'O:SPY231215C00595000',
                  underlying_ticker: 'SPY',
                  contract_type: 'call',
                  strike_price: 595,
                  expiration_date: '2023-12-15',
                  shares_per_contract: 100,
                },
                {
                  ticker: 'O:SPY231215P00595000',
                  underlying_ticker: 'SPY',
                  contract_type: 'put',
                  strike_price: 595,
                  expiration_date: '2023-12-15',
                  shares_per_contract: 100,
                },
              ],
            }),
          );
        }
        if (path.startsWith('/v3/snapshot/options/')) {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [
                {
                  details: {
                    ticker: 'O:SPY231215C00595000',
                    contract_type: 'call',
                    strike_price: 595,
                    expiration_date: '2023-12-15',
                    shares_per_contract: 100,
                  },
                  day: { volume: 500 },
                  open_interest: 5_000,
                  implied_volatility: 0.2,
                  last_quote: { bid: 14.5, ask: 14.7, midpoint: 14.6 },
                  last_trade: { price: 14.6, sip_timestamp: '1700000000000000000' },
                  underlying_asset: { ticker: 'SPY', price: 595 },
                },
                {
                  details: {
                    ticker: 'O:SPY231215P00595000',
                    contract_type: 'put',
                    strike_price: 595,
                    expiration_date: '2023-12-15',
                    shares_per_contract: 100,
                  },
                  day: { volume: 450 },
                  open_interest: 4_500,
                  implied_volatility: 0.2,
                  last_quote: { bid: 12.1, ask: 12.3, midpoint: 12.2 },
                  last_trade: { price: 12.2, sip_timestamp: '1700000000000000000' },
                  underlying_asset: { ticker: 'SPY', price: 595 },
                },
              ],
            }),
          );
        }
        if (path.startsWith('/v2/aggs/ticker/')) {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              ticker: 'SPY',
              resultsCount: 2,
              results: [
                { t: 1_699_913_600_000, o: 592, h: 594, l: 591, c: 593, v: 500_000 },
                { t: 1_699_999_200_000, o: 593, h: 596, l: 592.5, c: 595, v: 600_000 },
              ],
            }),
          );
        }
        return Promise.resolve(jsonOk({ status: 'OK', results: [] }));
      },
      tradierConfig: DISABLED_TRADIER_CONFIG,
      fmpConfig: DISABLED_FMP_CONFIG,
    });

    await runtime.startWs();

    // startWs never opens /stocks or /futures WS under STANDBY_TRADIER_FMP_PRIMARY
    expect(wsClustersOpened).toEqual([]);
    expect(() => runtime.reconnectMassiveStocksWs()).toThrow(/MASSIVE_WS_STOCKS_STANDBY_TRADIER_FMP_PRIMARY/);

    // Router status contains zero secret material
    const routerStatus = runtime.getMassiveKeyRouterStatus();
    assertNoSecretLeak(JSON.stringify(routerStatus), [
      SYNTH_API_KEY,
      SYNTH_KEY_1,
      SYNTH_KEY_2,
      SYNTH_KEY_3,
      SYNTH_KEY_FUT,
      SYNTH_WS_STOCKS,
      SYNTH_LEGACY_REST,
    ]);
    expect(routerStatus.wsStocks.policyState).toBe('STANDBY_TRADIER_FMP_PRIMARY');
    expect(routerStatus.wsFutures.policyState).toBe('CLOSED_DISABLED');
    expect(routerStatus.wsOptions.envName).toBe('MASSIVE_API_KEY');

    // Tradier health method remains completely functional
    expect(runtime.getTradierFeedHealth().configured).toBe(false);

    // getSnapshot subscribes /options WS using exclusively SYNTH_API_KEY
    await runtime.getSnapshot('SPY', { forceRefresh: true, prefetch: false });
    await Promise.resolve();
    await new Promise<void>((r) => {
      setTimeout(r, 15);
    });
    expect(wsClustersOpened).toEqual([`options:${SYNTH_API_KEY}`]);

    // getUnusualTrades (OPTIONS_REST) uses ONLY SYNTH_API_KEY
    requestedUrls.length = 0;
    await runtime.getUnusualTrades({ symbol: 'SPY', limit: 10 });
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const u of requestedUrls) {
      expect(extractApiKeyFromUrl(u)).toBe(SYNTH_API_KEY);
    }

    // getBars (STOCKS_REST) routes via KEY_2 / KEY_3 / KEY_1 (never FUTURES or LEGACY keys)
    requestedUrls.length = 0;
    await runtime.getBars('AAPL', '1D', { visibleBars: 30, includeOverlays: false }).catch(() => undefined);
    const stocksKeysUsed = requestedUrls.map(extractApiKeyFromUrl);
    expect(stocksKeysUsed.some((k) => k === SYNTH_KEY_2 || k === SYNTH_KEY_3)).toBe(true);
    expect(stocksKeysUsed).not.toContain(SYNTH_KEY_FUT);
    expect(stocksKeysUsed).not.toContain(SYNTH_LEGACY_REST);

    runtime.stopWs();
  });

  it('never falls back from OPTIONS_REST to STOCKS_REST keys during MarketRuntime.getSnapshot when MASSIVE_API_KEY fails with 429', async () => {
    const optionsUrls: string[] = [];
    const stocksUrls: string[] = [];

    const runtime = new MarketRuntime({
      massiveEnv: makeMassiveEnv().env,
      nowMsFn: () => 1_700_000_000_000,
      enableWs: false,
      fetchFn: (url) => {
        const parsed = new URL(url, 'https://api.massive.com');
        const path = parsed.pathname;
        if (url.includes('/options') || url.includes('/v3/snapshot/options')) {
          optionsUrls.push(url);
          return Promise.resolve({ ok: false, status: 429, text: 'options quota exceeded', retryAfterSeconds: 30 });
        }
        if (parsed.hostname.endsWith('massive.com')) {
          stocksUrls.push(url);
        }
        if (path === '/v3/snapshot') {
          return Promise.resolve(
            jsonOk({
              status: 'OK',
              results: [
                {
                  ticker: 'SPY',
                  type: 'stocks',
                  market_status: 'open',
                  session: {
                    price: 595,
                    close: 595,
                    previous_close: 592,
                    change: 3,
                    change_percent: 0.5,
                    volume: 1_000_000,
                  },
                },
              ],
            }),
          );
        }
        return Promise.resolve(jsonOk({ status: 'OK', results: [] }));
      },
      tradierConfig: DISABLED_TRADIER_CONFIG,
      fmpConfig: DISABLED_FMP_CONFIG,
    });

    await runtime.getSnapshot('SPY', { forceRefresh: true, prefetch: false }).catch(() => undefined);

    expect(optionsUrls.length).toBeGreaterThan(0);
    for (const url of optionsUrls) {
      const k = extractApiKeyFromUrl(url);
      expect(k).toBe(SYNTH_API_KEY);
      expect(k).not.toBe(SYNTH_KEY_2);
      expect(k).not.toBe(SYNTH_KEY_3);
      expect(k).not.toBe(SYNTH_KEY_1);
      expect(k).not.toBe(SYNTH_KEY_FUT);
    }
    for (const url of stocksUrls) {
      expect([SYNTH_KEY_2, SYNTH_KEY_3, SYNTH_KEY_1]).toContain(extractApiKeyFromUrl(url));
    }
  });
});
