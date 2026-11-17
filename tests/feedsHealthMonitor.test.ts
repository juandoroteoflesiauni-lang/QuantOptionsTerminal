import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FeedsHealthMonitor,
  RollingFeedTelemetry,
  emptyFeedTelemetrySnapshot,
  getArFeedSessionMode,
  getUsFeedSessionMode,
  isBmbProviderReconnectable,
  isMassiveWsSocketLive,
  resolveBmbProviderState,
  type FeedTelemetrySnapshot,
  type FeedsHealthMonitorDeps,
  type BmbFeedHealthSource,
  type MassiveWsFeedHealthSource,
} from '../src/server/feedsHealthMonitor.js';
import { parseFeedsHealth, parseGgalDualChart, renderFeedsHealthTable } from '../tools/check_live_feeds.js';

interface FixtureTelemetryCase {
  readonly name: string;
  readonly events: readonly {
    readonly atMs: number;
    readonly latencyMs?: number | null;
    readonly httpStatus?: number | null;
    readonly isValidTick?: boolean;
  }[];
  readonly nowMs: number;
  readonly expected: {
    readonly startedAtMs: number | null;
    readonly totalMessages: number;
    readonly messagesPerMinute: number | null;
    readonly averageLatencyMs: number | null;
    readonly latencySamples: number;
    readonly lastMessageAtMs: number | null;
    readonly lastTickAtMs: number | null;
    readonly lastHttpSuccessAtMs: number | null;
    readonly lastHttpFailureAtMs: number | null;
    readonly lastHttp429AtMs: number | null;
    readonly http429PerMinute: number | null;
  };
}

interface FixtureStateCase {
  readonly name: string;
  readonly configured: boolean;
  readonly connected: boolean | null;
  readonly sessionMode: 'IN_SESSION' | 'OUT_OF_SESSION';
  readonly expected: 'CONNECTED' | 'ARMED_OUT_OF_SESSION' | 'DEGRADED' | 'NOT_CONFIGURED';
}

interface FixtureSessionCase {
  readonly name: string;
  readonly utcSec: number;
  readonly market: 'US' | 'AR';
  readonly expected: 'IN_SESSION' | 'OUT_OF_SESSION';
}

interface FixtureAgeCase {
  readonly name: string;
  readonly atMs: number | null;
  readonly nowMs: number;
  readonly expected: number | null;
}

interface FixtureMassiveWsLivenessCase {
  readonly name: string;
  readonly connected: boolean;
  readonly messagesPerMinute: number | null;
  readonly lastMessageAgeMs: number | null;
  readonly usUtcSec: number;
  readonly expectedConnected: boolean;
  readonly expectedState: 'CONNECTED' | 'ARMED_OUT_OF_SESSION' | 'DEGRADED' | 'NOT_CONFIGURED';
}

interface FixtureBmbStandbyCase {
  readonly name: string;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly sessionMode: 'IN_SESSION' | 'OUT_OF_SESSION';
  readonly healthStatus: string;
  readonly signalRMode: boolean;
  readonly expectedState: 'CONNECTED' | 'ARMED_OUT_OF_SESSION' | 'DEGRADED' | 'NOT_CONFIGURED';
  readonly expectedReconnectable: boolean;
}

interface FixtureRoot {
  readonly telemetry: readonly FixtureTelemetryCase[];
  readonly state: readonly FixtureStateCase[];
  readonly sessions: readonly FixtureSessionCase[];
  readonly age: readonly FixtureAgeCase[];
  readonly massiveWsLiveness: readonly FixtureMassiveWsLivenessCase[];
  readonly bmbStandby2fa: {
    readonly cases: readonly FixtureBmbStandbyCase[];
    readonly signalRModeCases?: readonly FixtureBmbStandbyCase[];
  };
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/feeds_health_monitor.json', import.meta.url), 'utf-8'),
) as FixtureRoot;

describe('Pieza 33 — ventana móvil de telemetría (referencia Python independiente)', () => {
  for (const telemetryCase of fixture.telemetry) {
    it(`coincide con la referencia: ${telemetryCase.name}`, () => {
      const telemetry = new RollingFeedTelemetry({ latencyKind: 'HTTP_ROUND_TRIP' });
      for (const event of telemetryCase.events) {
        telemetry.record({
          atMs: event.atMs,
          ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
          ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
          ...(event.isValidTick === undefined ? {} : { isValidTick: event.isValidTick }),
        });
      }
      const actual = telemetry.snapshot(telemetryCase.nowMs);
      expect(actual.startedAtMs).toBe(telemetryCase.expected.startedAtMs);
      expect(actual.totalMessages).toBe(telemetryCase.expected.totalMessages);
      expect(actual.messagesPerMinute).toBe(telemetryCase.expected.messagesPerMinute);
      expect(actual.latencySamples).toBe(telemetryCase.expected.latencySamples);
      expect(actual.lastMessageAtMs).toBe(telemetryCase.expected.lastMessageAtMs);
      expect(actual.lastTickAtMs).toBe(telemetryCase.expected.lastTickAtMs);
      expect(actual.lastHttpSuccessAtMs).toBe(telemetryCase.expected.lastHttpSuccessAtMs);
      expect(actual.lastHttpFailureAtMs).toBe(telemetryCase.expected.lastHttpFailureAtMs);
      expect(actual.lastHttp429AtMs).toBe(telemetryCase.expected.lastHttp429AtMs);
      expect(actual.http429PerMinute).toBe(telemetryCase.expected.http429PerMinute);
      if (telemetryCase.expected.averageLatencyMs === null) {
        expect(actual.averageLatencyMs).toBeNull();
      } else {
        expect(actual.averageLatencyMs).not.toBeNull();
        expect(actual.averageLatencyMs).toBeCloseTo(telemetryCase.expected.averageLatencyMs, 9);
      }
    });
  }

  it('snapshot vacío no inventa mensajes ni latencia', () => {
    expect(emptyFeedTelemetrySnapshot()).toEqual({
      startedAtMs: null,
      totalMessages: 0,
      messagesPerMinute: null,
      averageLatencyMs: null,
      latencySamples: 0,
      lastMessageAtMs: null,
      lastTickAtMs: null,
      lastHttpSuccessAtMs: null,
      lastHttpFailureAtMs: null,
      lastHttp429AtMs: null,
      http429PerMinute: null,
    });
  });
});

describe('Pieza 33 — sesión y edad (referencia Python independiente)', () => {
  for (const sessionCase of fixture.sessions) {
    it(`${sessionCase.name} => ${sessionCase.expected}`, () => {
      const actual =
        sessionCase.market === 'US'
          ? getUsFeedSessionMode(sessionCase.utcSec * 1_000)
          : getArFeedSessionMode(sessionCase.utcSec);
      expect(actual).toBe(sessionCase.expected);
    });
  }

  for (const ageCase of fixture.age) {
    it(`age ${ageCase.name}`, () => {
      const providers = createMonitor({
        nowMs: ageCase.nowMs,
        massiveWs: {
          configured: true,
          connected: false,
          telemetry: {
            ...emptyFeedTelemetrySnapshot(),
            ...(ageCase.atMs === null ? {} : { lastTickAtMs: ageCase.atMs }),
          },
        },
      }).getSnapshot();
      expect(providers.providers[0]?.lastTickAgeMs).toBe(ageCase.expected);
    });
  }
});

describe('Pieza 33 — máquina de estados y resumen', () => {
  for (const stateCase of fixture.state) {
    it(`estado ${stateCase.name} => ${stateCase.expected}`, () => {
      const providers = createMonitor({
        ...(stateCase.expected === 'ARMED_OUT_OF_SESSION'
          ? { nowMs: Date.UTC(2026, 10, 14, 8, 0, 0) }
          : stateCase.expected === 'DEGRADED'
            ? { nowMs: Date.UTC(2026, 10, 16, 15, 0, 0) }
            : {}),
        massiveWs: {
          configured: stateCase.configured,
          connected: stateCase.connected ?? false,
          telemetry: emptyFeedTelemetrySnapshot(),
        },
      }).getSnapshot();
      expect(providers.providers[0]?.state).toBe(stateCase.expected);
    });
  }

  it('resume siete proveedores sin duplicar IDs ni filtrar no configurados', () => {
    const snapshot = createMonitor({}).getSnapshot();
    expect(snapshot.status).toBe('OK');
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      'MASSIVE_WS_STOCKS',
      'MASSIVE_REST_POOL',
      'TRADIER_LIVE_WS',
      'ORATS_API',
      'PRIMARY_REMARKETS_DLR',
      'BMB_HOMEBROKER_L2',
      'IOL_REST_V2',
    ]);
    expect(snapshot.summary.totalProviders).toBe(7);
    expect(snapshot.summary.activeCount).toBe(0);
    expect(snapshot.summary.configuredCount).toBe(0);
    expect(snapshot.summary.notConfiguredCount).toBe(7);
  });

  it('redacta material sensible en errores y en fallos de reconnect', async () => {
    const canary = 'SECRET_CANARY_TOKEN';
    const monitor = createMonitor({
      secrets: [canary],
      massiveWs: {
        configured: true,
        connected: false,
        lastError: `auth failed ${canary}`,
        telemetry: emptyFeedTelemetrySnapshot(),
      },
      reconnectMassiveWsError: `boom ${canary}`,
    });
    const provider = monitor.getSnapshot().providers[0];
    expect(provider?.lastError).not.toContain(canary);
    expect(provider?.lastError).toContain('<redacted>');
    const result = await monitor.reconnect('MASSIVE_WS_STOCKS');
    expect(result.ok).toBe(false);
    expect(result.action).toBe('RECONNECT');
    expect(result.detail).not.toContain(canary);
    expect(result.detail).toContain('<redacted>');
    expect(result.providerAfter).toBeNull();
  });

  it('pulso ligero mantiene los siete IDs y sólo métricas comunes', () => {
    const pulse = createMonitor({}).getPulse();
    expect(pulse.type).toBe('FEEDS_HEALTH_PULSE');
    expect(pulse.providers.map((provider) => provider.id)).toHaveLength(7);
    for (const provider of pulse.providers) {
      expect(Object.keys(provider).sort()).toEqual([
        'id',
        'lastTickAgeMs',
        'latencyMs',
        'messagesPerMinute',
        'sessionMode',
        'state',
      ]);
    }
  });
});

describe('Pieza 33 hotfix — liveness MASSIVE_WS_STOCKS (referencia Python independiente)', () => {
  it('isMassiveWsSocketLive coincide con la referencia', () => {
    for (const livenessCase of fixture.massiveWsLiveness) {
      expect(
        isMassiveWsSocketLive({
          connected: livenessCase.connected,
          messagesPerMinute: livenessCase.messagesPerMinute,
          lastMessageAgeMs: livenessCase.lastMessageAgeMs,
        }),
      ).toBe(livenessCase.expectedConnected);
    }
  });

  for (const livenessCase of fixture.massiveWsLiveness) {
    it(`estado ${livenessCase.name} => ${livenessCase.expectedState}`, () => {
      const providers = createMonitor({
        nowMs: livenessCase.usUtcSec * 1_000,
        massiveWs: {
          configured: true,
          connected: livenessCase.connected,
          telemetry: {
            ...emptyFeedTelemetrySnapshot(),
            messagesPerMinute: livenessCase.messagesPerMinute,
          },
          lastWsMessageAgeMs: livenessCase.lastMessageAgeMs,
        },
      }).getSnapshot();
      const provider = providers.providers[0];
      expect(provider?.state).toBe(livenessCase.expectedState);
      expect(provider?.connected).toBe(livenessCase.expectedConnected);
    });
  }
});

describe('Pieza 33 hotfix — BMB STANDBY_2FA (referencia Python independiente)', () => {
  const bmbFixture = JSON.parse(
    readFileSync(new URL('../fixtures/bmb_2fa_standby.json', import.meta.url), 'utf-8'),
  ) as { standby2faMessage: string };

  for (const caseItem of fixture.bmbStandby2fa.cases) {
    it(`resolveBmbProviderState ${caseItem.name} => ${caseItem.expectedState}`, () => {
      expect(
        resolveBmbProviderState({
          configured: caseItem.configured,
          connected: caseItem.connected,
          sessionMode: caseItem.sessionMode,
          healthStatus: caseItem.healthStatus,
        }),
      ).toBe(caseItem.expectedState);
      expect(isBmbProviderReconnectable(caseItem.healthStatus, caseItem.signalRMode)).toBe(
        caseItem.expectedReconnectable,
      );
    });
  }

  for (const caseItem of fixture.bmbStandby2fa.signalRModeCases ?? []) {
    it(`isBmbProviderReconnectable (SignalR Core) ${caseItem.name}`, () => {
      // Pieza 38.1: con SignalR Core el bridge local responde 202 en
      // POST /reconnect -> siempre reconectable (CONNECTING/ERROR/STANDBY_2FA).
      expect(isBmbProviderReconnectable(caseItem.healthStatus, caseItem.signalRMode)).toBe(
        caseItem.expectedReconnectable,
      );
    });
  }

  it('proveedor BMB con STANDBY_2FA: DEGRADED suave, no reconectable y mensaje informativo fijo', () => {
    const provider = createMonitor({
      nowMs: Date.UTC(2026, 10, 16, 15, 0, 0), // lunes 12:00 ART → IN_SESSION
      bmb: {
        configured: true,
        healthStatus: 'STANDBY_2FA',
        connected: false,
        lastError: bmbFixture.standby2faMessage,
      },
    })
      .getSnapshot()
      .providers.find((item) => item.id === 'BMB_HOMEBROKER_L2');
    expect(provider?.state).toBe('DEGRADED');
    expect(provider?.reconnectable).toBe(false);
    expect(provider?.connected).toBe(false);
    expect(provider?.bmb?.status).toBe('STANDBY_2FA');
    expect(provider?.lastError).toBe(bmbFixture.standby2faMessage);
  });

  it('proveedor BMB CONNECTED_L2 sigue siendo reconectable', () => {
    const provider = createMonitor({
      nowMs: Date.UTC(2026, 10, 16, 15, 0, 0),
      bmb: { configured: true, healthStatus: 'CONNECTED_L2', connected: true },
    })
      .getSnapshot()
      .providers.find((item) => item.id === 'BMB_HOMEBROKER_L2');
    expect(provider?.state).toBe('CONNECTED');
    expect(provider?.reconnectable).toBe(true);
  });

  it('STANDBY_2FA fuera de sesión también es DEGRADED informativo, sin ARMED', () => {
    const provider = createMonitor({
      nowMs: Date.UTC(2026, 10, 15, 21, 0, 0), // domingo 18:00 ART → OUT_OF_SESSION
      bmb: { configured: true, healthStatus: 'STANDBY_2FA', connected: false },
    })
      .getSnapshot()
      .providers.find((item) => item.id === 'BMB_HOMEBROKER_L2');
    expect(provider?.state).toBe('DEGRADED');
    expect(provider?.sessionMode).toBe('OUT_OF_SESSION');
  });
});

describe('Pieza 33 — parser/render del CLI', () => {
  it('parsea y renderiza el snapshot de salud sin inventar valores', () => {
    const raw = {
      status: 'OK',
      asOfUtcSec: 1_700_000_000,
      summary: {
        totalProviders: 7,
        configuredCount: 2,
        activeCount: 1,
        degradedCount: 1,
        notConfiguredCount: 5,
        armedOutOfSessionCount: 0,
      },
      providers: [
        {
          id: 'MASSIVE_WS_STOCKS',
          region: 'US',
          role: 'Spot NBBO / Trades US',
          state: 'CONNECTED',
          sessionMode: 'IN_SESSION',
          configured: true,
          connected: true,
          latencyMs: 12.4,
          latencyKind: 'PROVIDER_EVENT_AGE',
          lastTickAgeMs: 250,
          messagesPerMinute: 38,
          lastError: null,
          activeSymbolCount: 3,
          subscribedSymbols: ['SPY', 'QQQ', 'I:SPX'],
          reconnectAction: 'RECONNECT',
          reconnectable: true,
        },
        {
          id: 'ORATS_API',
          region: 'US',
          role: 'Superficie de Volatilidad',
          state: 'DEGRADED',
          sessionMode: 'IN_SESSION',
          configured: true,
          connected: false,
          latencyMs: null,
          latencyKind: 'HTTP_ROUND_TRIP',
          lastTickAgeMs: null,
          messagesPerMinute: null,
          lastError: null,
          activeSymbolCount: null,
          subscribedSymbols: [],
          reconnectAction: 'RESYNC',
          reconnectable: true,
        },
      ],
    };
    const audit = parseFeedsHealth(raw);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]?.symbols).toBe('3 activos / 3 suscriptos');
    expect(audit.rows[1]?.latency).toBe('—');
    const rendered = renderFeedsHealthTable(audit);
    expect(rendered).toContain('MASSIVE_WS_STOCKS');
    expect(rendered).toContain('38/min');
    expect(rendered).toContain('—');
  });

  it('EMA 200 queda lista sólo con serie finita y 200+ velas', () => {
    const bars = Array.from({ length: 201 }, (_, index) => ({
      timeSec: 1_700_000_000 + index,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1_000,
    }));
    const ema200 = Array.from({ length: 201 }, (_, index) => ({
      timeSec: 1_700_000_000 + index,
      value: 100 + index,
    }));
    const audit = parseGgalDualChart({
      dualChart: {
        status: 'OPERATIONAL',
        reason: null,
        bars,
        ema200,
        l2Ladder: { available: true, bids: [{ price: 100, size: 1 }], asks: [{ price: 101, size: 1 }] },
      },
    });
    expect(audit.ema200Ready).toBe(true);
    expect(audit.ema200Last).toBe(300);
    expect(audit.l2Available).toBe(true);
    expect(audit.l2BidLevels).toBe(1);
    expect(audit.l2AskLevels).toBe(1);
  });
});

/* ============================================================================
   Helper: monitor estructural con dependencias mínimas.
   ============================================================================ */
interface MonitorOverrides {
  readonly massiveWs?: Partial<MassiveWsFeedHealthSource> & {
    readonly telemetry?: FeedTelemetrySnapshot;
  };
  readonly bmb?: Partial<BmbFeedHealthSource> & {
    readonly telemetry?: FeedTelemetrySnapshot;
  };
  readonly secrets?: readonly string[];
  readonly reconnectMassiveWsError?: string;
  readonly nowMs?: number;
}

function createMonitor(overrides: MonitorOverrides = {}): FeedsHealthMonitor {
  const telemetry = overrides.massiveWs?.telemetry ?? emptyFeedTelemetrySnapshot();
  const massiveWs = {
    configured: overrides.massiveWs?.configured ?? false,
    connected: overrides.massiveWs?.connected ?? false,
    keySlot: null,
    lastError: overrides.massiveWs?.lastError ?? null,
    telemetry,
    subscribedSymbols: [],
    activeSymbolCount: 0,
    subscribedOptionQuotes: 0,
    lastWsMessageAgeMs: overrides.massiveWs?.lastWsMessageAgeMs ?? null,
  };
  const deps: FeedsHealthMonitorDeps = {
    getMassiveWs: () => massiveWs,
    getMassiveRest: () => ({
      configured: false,
      poolSize: 0,
      slots: [],
      lastSlotIndex: null,
      roundRobinRequests: 0,
      telemetry: emptyFeedTelemetrySnapshot(),
    }),
    getTradier: () => ({
      configured: false,
      connected: false,
      sessionCreated: false,
      reconnectAttempts: 0,
      subscribedSymbols: [],
      lastError: null,
      telemetry: emptyFeedTelemetrySnapshot(),
    }),
    getOrats: () => ({
      configured: false,
      connected: false,
      lastFetchAtUtcSec: null,
      lastStatus: null,
      planTier: null,
      quotaRemaining: null,
      quotaLimit: null,
      quotaResetAtUtcSec: null,
      circuitBreaker: { state: 'CLOSED', consecutiveFailures: 0, openedAtMs: null },
      telemetry: emptyFeedTelemetrySnapshot(),
    }),
    getPrimary: () => ({
      configured: false,
      authenticated: false,
      wsConnected: false,
      tokenValidUntilUtcSec: null,
      tokenRenewCount: 0,
      wsEnvironment: 'PRIMARY_REMARKETS_SANDBOX',
      dlrSubscribedCount: 0,
      liveDlrCount: 0,
      liveDlrLastUpdateUtcSec: null,
      lastError: null,
      telemetry: emptyFeedTelemetrySnapshot(),
    }),
    getBmb: () => ({
      configured: false,
      healthStatus: 'DISABLED_NO_PASSWORD',
      connected: false,
      lastUpdateUtcSec: null,
      orderBookCount: 0,
      caucionCount: 0,
      optionCount: 0,
      lastError: null,
      signalRMode: overrides.bmb?.signalRMode ?? false,
      telemetry: emptyFeedTelemetrySnapshot(),
      ...overrides.bmb,
    }),
    getIol: () => ({
      configured: false,
      connected: false,
      authMethod: null,
      passwordAuthCount: 0,
      refreshAuthCount: 0,
      tokenExpiresAtUtcSec: null,
      lastAuthAtUtcSec: null,
      quoteCount: 0,
      lastError: null,
      telemetry: emptyFeedTelemetrySnapshot(),
    }),
    reconnectMassiveWs: (): Promise<string> =>
      overrides.reconnectMassiveWsError !== undefined
        ? Promise.reject(new Error(overrides.reconnectMassiveWsError))
        : Promise.resolve('OK'),
    resyncMassiveRest: (): Promise<string> => Promise.resolve('OK'),
    reconnectTradier: (): Promise<string> => Promise.resolve('OK'),
    resyncOrats: (): Promise<string> => Promise.resolve('OK'),
    reconnectPrimary: (): Promise<string> => Promise.resolve('OK'),
    reconnectBmb: (): Promise<string> => Promise.resolve('OK'),
    reconnectIol: (): Promise<string> => Promise.resolve('OK'),
    ...(overrides.secrets === undefined ? {} : { secrets: overrides.secrets }),
    ...(overrides.nowMs === undefined ? {} : { nowMsFn: (): number => overrides.nowMs as number }),
  };
  return new FeedsHealthMonitor(deps);
}
