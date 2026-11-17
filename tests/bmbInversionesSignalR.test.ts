import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  BMB_LEGACY_SCRIPT,
  BMB_SIGNALR_SCRIPT,
  BmbFeedAdapter,
  ingestLiveL2Line,
  ingestLiveL2Record,
  mergeLiveL2IntoSnapshot,
  resolveBmbBridgeScriptPath,
} from '../src/server/bmbFeedAdapter.js';
import {
  isBmbInversionesSignalRConfigured,
  redactHubQueryCredentials,
  type BmbBridgeSnapshotDto,
} from '../src/server/primaryRofexLoader.js';

interface FixtureHubTokenSection {
  readonly htmlCases: readonly { readonly name: string }[];
  readonly resolveCases: readonly unknown[];
  readonly urlCases: readonly unknown[];
  readonly negotiateResponses: readonly unknown[];
  readonly handshake: Readonly<Record<string, unknown>>;
  readonly wsHandshakeErrorCases: readonly unknown[];
}

interface FixtureL2LineCase {
  readonly name: string;
  readonly line: string;
  readonly expectedBook: Readonly<Record<string, unknown>> | null;
}

interface FixtureRedactionCase {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

interface FixtureRoot {
  readonly hubToken: FixtureHubTokenSection;
  readonly frames: Readonly<Record<string, unknown>>;
  readonly redactionCases: readonly FixtureRedactionCase[];
  readonly l2UpdateLines: readonly FixtureL2LineCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/bmb_inversiones_sendprices.json', import.meta.url), 'utf-8'),
) as FixtureRoot;

// UUIDs y datos 100% sintéticos (nunca credenciales reales).
const SYNTH_HUB_TOKEN = '11111111-2222-3333-4444-555555555555';
const SYNTH_CONNECTION_TOKEN = '22222222-3333-4444-5555-666666666666';
const SYNTH_SESSION_COOKIE = 'fake_session_cookie=44444444-5555-6666-7777-888888888888';

describe('Pieza 38 — modo conector SignalR Core (selección de script y configuración)', () => {
  it('isBmbInversionesSignalRConfigured: token, cookie, ambos o ninguno', () => {
    expect(isBmbInversionesSignalRConfigured({ BMB_HUB_TOKEN: SYNTH_HUB_TOKEN })).toBe(true);
    expect(isBmbInversionesSignalRConfigured({ BMB_SESSION_COOKIE: SYNTH_SESSION_COOKIE })).toBe(true);
    expect(
      isBmbInversionesSignalRConfigured({
        BMB_HUB_TOKEN: ` ${SYNTH_HUB_TOKEN} `,
        BMB_SESSION_COOKIE: SYNTH_SESSION_COOKIE,
      }),
    ).toBe(true);
    expect(isBmbInversionesSignalRConfigured({ BMB_HUB_TOKEN: '   ' })).toBe(false);
    expect(isBmbInversionesSignalRConfigured({})).toBe(false);
  });

  it('resolveBmbBridgeScriptPath elige el conector SignalR con token o cookie y el legacy sin ellos', () => {
    expect(resolveBmbBridgeScriptPath({ BMB_HUB_TOKEN: SYNTH_HUB_TOKEN })).toBe(BMB_SIGNALR_SCRIPT);
    expect(resolveBmbBridgeScriptPath({ BMB_SESSION_COOKIE: SYNTH_SESSION_COOKIE })).toBe(BMB_SIGNALR_SCRIPT);
    expect(
      resolveBmbBridgeScriptPath({
        BMB_DNI: '20123456789',
        BMB_USER: 'fake_user',
        BMB_PASSWORD: 'fake_password',
        BMB_BROKER_ID: '153',
      }),
    ).toBe(BMB_LEGACY_SCRIPT);
    expect(resolveBmbBridgeScriptPath({})).toBe(BMB_LEGACY_SCRIPT);
  });
});

describe('Pieza 38 — redacción de query strings token/id (referencia Python independiente)', () => {
  it('coincide con los casos de la referencia', () => {
    for (const caseItem of fixture.redactionCases) {
      expect(redactHubQueryCredentials(caseItem.input)).toBe(caseItem.expected);
    }
  });

  it('no muta cadenas sin token/id y no expone el valor crudo', () => {
    const withToken = `negotiate failed: https://hub/x/negotiate?token=${SYNTH_HUB_TOKEN}&negotiateVersion=1`;
    const redacted = redactHubQueryCredentials(withToken);
    expect(redacted).not.toContain(SYNTH_HUB_TOKEN);
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('negotiateVersion=1');
  });
});

describe('Pieza 38 — ingesta JSONL L2_UPDATE (mapeo de 5 puntas al DTO L2)', () => {
  it('coincide con los casos de la referencia para cada línea', () => {
    for (const caseItem of fixture.l2UpdateLines) {
      const books = ingestLiveL2Line(caseItem.line, {});
      if (caseItem.expectedBook === null) {
        expect(Object.keys(books)).toHaveLength(0);
        continue;
      }
      const book = books['GGAL'] ?? books['PAMP'] ?? books['SUPV'];
      expect(book).toBeDefined();
      expect(book).toEqual(caseItem.expectedBook);
    }
  });

  it('invariante pura: registros inválidos devuelven los mismos libros', () => {
    const existing = {
      GGAL: {
        symbol: 'GGAL',
        settlement: '24hs',
        bids: [{ price: 1, size: 1, orderCount: null }],
        asks: [{ price: 2, size: 1, orderCount: null }],
        asOfUtcSec: 1794925805,
        source: 'BMB_HOMEBROKER',
      },
    } as const;
    expect(ingestLiveL2Line('not-json', existing)).toBe(existing);
    expect(ingestLiveL2Record({ event: 'OTHER' }, existing)).toBe(existing);
    expect(ingestLiveL2Record({ event: 'L2_UPDATE', record: { symbol: 'GGAL', settlement: 'CI' } }, existing)).toBe(
      existing,
    );
  });

  it('mergeLiveL2IntoSnapshot toma la entrada más reciente por asOfUtcSec', () => {
    const liveBook = {
      GGAL: {
        symbol: 'GGAL',
        settlement: '24hs',
        bids: [{ price: 6450.5, size: 1200, orderCount: null }],
        asks: [{ price: 6451, size: 900, orderCount: null }],
        asOfUtcSec: 1794925806,
        source: 'BMB_HOMEBROKER',
      },
    } as const;
    const olderHttp = {
      health: {
        status: 'READY',
        brokerId: 153,
        accountLabel: null,
        pyhomebrokerInstalled: true,
        passwordConfigured: true,
        connected: true,
        lastUpdateUtcSec: 1794925805,
        counts: { cauciones: 0, orderBooks: 0, options: 0 },
        error: null,
      },
      cauciones: [],
      orderBooksBySymbol: {
        GGAL: {
          symbol: 'GGAL',
          settlement: '24hs',
          bids: [{ price: 6400, size: 10, orderCount: null }],
          asks: [{ price: 6401, size: 10, orderCount: null }],
          asOfUtcSec: 1794925805,
          source: 'BMB_HOMEBROKER',
        },
      },
      options: [],
      tradesBySymbol: {},
    } as BmbBridgeSnapshotDto;
    const merged = mergeLiveL2IntoSnapshot(olderHttp, liveBook);
    expect(merged.orderBooksBySymbol['GGAL']?.asOfUtcSec).toBe(1794925806);
    // Sin libros vivos, el snapshot no cambia (misma referencia).
    expect(mergeLiveL2IntoSnapshot(olderHttp, {})).toBe(olderHttp);
    // Un libro HTTP más nuevo que el live gana.
    const ggalHttpBook = olderHttp.orderBooksBySymbol['GGAL'];
    if (ggalHttpBook === undefined) {
      throw new Error('GGAL book esperado en el snapshot del test');
    }
    const newerHttp = {
      ...olderHttp,
      orderBooksBySymbol: {
        GGAL: { ...ggalHttpBook, asOfUtcSec: 1794925900 },
      },
    } as BmbBridgeSnapshotDto;
    expect(mergeLiveL2IntoSnapshot(newerHttp, liveBook).orderBooksBySymbol['GGAL']?.asOfUtcSec).toBe(1794925900);
  });
});

describe('Pieza 38 — adapter: stderr con token/id/cookie queda redactado en lastError', () => {
  it('sanaliza query strings y secretos ante errores del subproceso', async () => {
    const nowMs = Date.UTC(2026, 10, 17, 14, 0, 0);

    function makeFakeStream(): EventEmitter & { setEncoding: (encoding?: string) => void } {
      const stream = new EventEmitter() as EventEmitter & { setEncoding: (encoding?: string) => void };
      stream.setEncoding = () => undefined;
      return stream;
    }

    const fakeStdout = makeFakeStream();
    const fakeStderr = makeFakeStream();
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    (child as unknown as { stdout: unknown }).stdout = fakeStdout;
    (child as unknown as { stderr: unknown }).stderr = fakeStderr;

    const spawnFn = (): ChildProcess => {
      queueMicrotask(() => {
        fakeStderr.emit(
          'data',
          `negotiate failed https://hub/stock-prices-hub/negotiate?token=${SYNTH_HUB_TOKEN}&id=${SYNTH_CONNECTION_TOKEN} cookie=${SYNTH_SESSION_COOKIE}\n`,
        );
        fakeStdout.emit('data', `${JSON.stringify({ event: 'LISTENING' })}\n`);
      });
      return child;
    };

    const adapter = new BmbFeedAdapter({
      env: {
        BMB_HUB_TOKEN: SYNTH_HUB_TOKEN,
        BMB_SESSION_COOKIE: SYNTH_SESSION_COOKIE,
      },
      manageProcess: true,
      spawnFn: spawnFn as unknown as typeof spawn,
      nowMsFn: () => nowMs,
      fetchFn: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: JSON.stringify({
            status: 'DISCONNECTED',
            brokerId: 153,
            accountLabel: null,
            pyhomebrokerInstalled: null,
            passwordConfigured: false,
            asOfUtcSec: null,
            error: null,
            cauciones: [],
            orderBooksBySymbol: {},
            options: [],
          }),
          headers: {},
        }),
    });

    const snapshot = await adapter.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SYNTH_HUB_TOKEN);
    expect(serialized).not.toContain(SYNTH_CONNECTION_TOKEN);
    expect(serialized).not.toContain(SYNTH_SESSION_COOKIE);
    expect(snapshot.health.error).toContain('token=[REDACTED]');
    expect(snapshot.health.error).toContain('id=[REDACTED]');
    adapter.stop();
  });
});
