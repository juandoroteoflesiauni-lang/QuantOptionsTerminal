import { expect, it, vi } from 'vitest';
import reference from '../fixtures/ggal_options_audit.json';
import { computeBuilderAnalytics } from '../web/src/components/options/optionsDerived';
import { GgalTickStreamEngine, type GgalBarTickEvent } from '../src/server/ggalTickStream';
import { MarketRuntime } from '../src/server/marketRuntime';
import { parseAnexoBIamcInput } from '../src/server/ggalSpecialistRuntime';
import { normalizeOptionChainSnapshot } from '../src/data/normalizeOptions';

vi.mock('../src/server/envBootstrap.js', () => ({}));

it('incluye S=0 en la pérdida máxima de una put vendida', () => {
  const { strike, premium, qty, fee, loss } = reference.put;
  const leg = { id: 'put', side: 'Venta', type: 'Put', strike, premium, qty, iv: 20, delta: -0.5, theta: 0 } as const;
  const result = computeBuilderAnalytics([leg], strike, 30, 0, 0, strike, 30, []);
  expect(result.totalCommission).toBeCloseTo(fee, 9);
  expect(result.maxLoss).toBeCloseTo(loss, 9);
});

it.each(reference.atmGamma)('publica gamma con $seconds segundos de vida', ({ seconds, gamma }) => {
  const ticker = 'O:SPXW261218C00100000';
  const normalized = normalizeOptionChainSnapshot({ results: [{
    details: { ticker, expiration_date: '2026-12-18', contract_type: 'call', exercise_style: 'european',
      strike_price: 100, shares_per_contract: 100 }, implied_volatility: 0.2, open_interest: 100,
    last_quote: { bid: 0.02, ask: 0.03, midpoint: 0.025 }, day: { volume: 1 },
  }] });
  const parity = { expirySec: reference.expiry, expirationDate: '2026-12-18', timeToExpiry: seconds / 31536000,
    rate: 0, forward: 100, dividendYield: 0 };
  const rows = MarketRuntime.prototype['serializeExpiryContractRows']({
    selected: normalized.contracts, spot: 100, nowSec: reference.expiry - seconds, isIndex: true,
    expiryParityMap: new Map([[reference.expiry, parity]]), fallbackParity: parity,
    contractOwnIvMap: new Map([[ticker, 0.2]]), expiryAtmIvMap: new Map([[reference.expiry, 0.2]]),
    otmIvByExpiryStrike: new Map(),
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.gamma).toBeCloseTo(gamma, 9);
});

it('mantiene el cierre y volumen del minuto cuando llega un trade del minuto anterior', () => {
  const events: GgalBarTickEvent[] = [];
  let clock = reference.ticks[0]!.timeSec * 1000;
  const engine = new GgalTickStreamEngine({ nowMsFn: () => clock, emit: e => events.push(e) });
  for (const tick of reference.ticks) {
    clock += 1000;
    engine.applyAdrTick(tick);
  }
  const current = events.filter(e => e.mode === 'ADR' && e.timeframe === '1m' && e.bar.timeSec === reference.ticks[0]!.timeSec).at(-1);
  expect(current?.bar).toMatchObject({ close: reference.currentClose, volume: reference.currentVolume });
});

it('convierte ARS/ADR contemporáneos a CCL en ARS por USD', () => {
  const events: GgalBarTickEvent[] = [];
  const adr = reference.ticks[0]!;
  const engine = new GgalTickStreamEngine({ nowMsFn: () => adr.timeSec * 1000, emit: e => events.push(e) });
  engine.applyArsTick({ price: reference.ars, size: 1, timeSec: adr.timeSec });
  engine.applyAdrTick(adr);
  expect(events.find(e => e.mode === 'CCL' && e.timeframe === '1m')?.bar.close).toBe(reference.simultaneousCcl);
});

it('excluye los nominales de febrero al interpretar un Anexo B de diciembre', () => {
  const result = parseAnexoBIamcInput({ rawText: reference.anexoText, expiryCode: 'DI', asOfDate: '2026-11-16' }, reference.ticks[0]!.timeSec);
  expect(result.rows[0]?.callOi.uncoveredNom).toBe(reference.decemberUncovered);
});
