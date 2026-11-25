/**
 * Suite Vitest S2-2 — Detector topológico determinista de nodos `HVN` / `LVN`,
 * primitiva `PanoramicBandsPrimitive` (`autoscaleInfo(): null`) y guardas UI en `StockDetailView.tsx`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectVolumeProfileNodes,
  type VolumeProfileNodeZone,
  type VolumeProfileNodesResult,
} from '../src/core/microstructure/multiHorizonVolumeProfile.js';
import {
  HVN_BAND_FILL_COLOR,
  LVN_BAND_FILL_COLOR,
  PanoramicBandsPrimitive,
} from '../web/src/components/stock-detail/PanoramicBandsPrimitive.js';

interface NodeCaseFixture {
  readonly name: string;
  readonly minBinIndex: number;
  readonly tickSize: number;
  readonly referencePrice: number | null;
  readonly maxHvnZones: number;
  readonly maxLvnZones: number;
  readonly binVolumes: readonly number[];
  readonly expected: {
    readonly activeStartIndex: number;
    readonly activeEndIndex: number;
    readonly activeBinCount: number;
    readonly neighborhoodRadius: number;
    readonly smoothedPocVolume: number | null;
    readonly totalVolume: number;
    readonly hvnZones: readonly VolumeProfileNodeZone[];
    readonly lvnZones: readonly VolumeProfileNodeZone[];
  };
}

interface Fixture {
  readonly meta: { readonly tolerance: number };
  readonly nodeCases: readonly NodeCaseFixture[];
}

const fixturePath = join(process.cwd(), 'fixtures', 'multi_horizon_vp_hvn_lvn.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;
const TOL = fixture.meta.tolerance;

function expectClose(actual: number, expected: number, label: string): void {
  expect(Number.isFinite(actual), `${label} must be finite`).toBe(true);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(TOL * Math.max(1, Math.abs(expected)));
}

function compareZoneArrays(
  actual: readonly VolumeProfileNodeZone[],
  expected: readonly VolumeProfileNodeZone[],
  label: string,
): void {
  expect(actual.length, `${label}.length`).toBe(expected.length);
  actual.forEach((z, idx) => {
    const exp = expected[idx];
    if (exp === undefined) throw new Error(`Missing zone ${label}[${String(idx)}]`);
    expect(z.kind, `${label}[${String(idx)}].kind`).toBe(exp.kind);
    expect(z.startBinIndex, `${label}[${String(idx)}].startBinIndex`).toBe(exp.startBinIndex);
    expect(z.endBinIndex, `${label}[${String(idx)}].endBinIndex`).toBe(exp.endBinIndex);
    expect(z.isPriceGap, `${label}[${String(idx)}].isPriceGap`).toBe(exp.isPriceGap);
    expectClose(z.lowPrice, exp.lowPrice, `${label}[${String(idx)}].lowPrice`);
    expectClose(z.highPrice, exp.highPrice, `${label}[${String(idx)}].highPrice`);
    expectClose(z.centerPrice, exp.centerPrice, `${label}[${String(idx)}].centerPrice`);
    expectClose(z.volume, exp.volume, `${label}[${String(idx)}].volume`);
    expectClose(z.volumeSharePct, exp.volumeSharePct, `${label}[${String(idx)}].volumeSharePct`);
    expectClose(z.prominence, exp.prominence, `${label}[${String(idx)}].prominence`);
    expectClose(z.prominenceRatio, exp.prominenceRatio, `${label}[${String(idx)}].prominenceRatio`);
  });
}

describe('S2-2 — Detector determinista HVN/LVN vs oráculo Python (<= 1e-9)', () => {
  for (const nc of fixture.nodeCases) {
    it(`${nc.name}: coincide exactamente en soporte activo, zonas, volumen crudo y ranking`, () => {
      const frozen = Object.freeze([...nc.binVolumes]);
      const actual: VolumeProfileNodesResult = detectVolumeProfileNodes(frozen, {
        minBinIndex: nc.minBinIndex,
        tickSize: nc.tickSize,
        ...(nc.referencePrice === null ? {} : { referencePrice: nc.referencePrice }),
        maxHvnZones: nc.maxHvnZones,
        maxLvnZones: nc.maxLvnZones,
      });

      expect(actual.methodology).toBe('OHLCV_UNIFORM_SMOOTHED_PROMINENCE');
      expect(actual.activeStartIndex).toBe(nc.expected.activeStartIndex);
      expect(actual.activeEndIndex).toBe(nc.expected.activeEndIndex);
      expect(actual.activeBinCount).toBe(nc.expected.activeBinCount);
      expect(actual.neighborhoodRadius).toBe(nc.expected.neighborhoodRadius);
      if (nc.expected.smoothedPocVolume === null) {
        expect(Number.isNaN(actual.smoothedPocVolume)).toBe(true);
      } else {
        expectClose(actual.smoothedPocVolume, nc.expected.smoothedPocVolume, `${nc.name}.smoothedPoc`);
      }
      expectClose(actual.totalVolume, nc.expected.totalVolume, `${nc.name}.totalVolume`);
      compareZoneArrays(actual.hvnZones, nc.expected.hvnZones, `${nc.name}.hvnZones`);
      compareZoneArrays(actual.lvnZones, nc.expected.lvnZones, `${nc.name}.lvnZones`);
    });
  }

  it('garantiza invariantes estructurales: 0 bins exteriores como LVN, gaps consolidados y tope 3+3', () => {
    // 1) Padding de ceros exteriores no altera las zonas detectadas ni produce LVN en bordes vacíos.
    const core = [30, 150, 380, 500, 380, 120, 20, 10, 20, 130, 350, 440, 350, 140, 30];
    const unpadded = detectVolumeProfileNodes(core, { minBinIndex: 1000, tickSize: 0.1 });
    const padded = detectVolumeProfileNodes([0, 0, 0, 0, ...core, 0, 0, 0, 0], { minBinIndex: 996, tickSize: 0.1 });
    expect(padded.hvnZones).toEqual(unpadded.hvnZones);
    expect(padded.lvnZones).toEqual(unpadded.lvnZones);
    for (const z of padded.lvnZones) {
      expect(z.startBinIndex).toBeGreaterThan(1000);
      expect(z.endBinIndex).toBeLessThan(1000 + core.length - 1);
    }

    // 2) Gap interno multi-bin consolidado en 1 única banda LVN con isPriceGap = true y volumen = 0.
    const gapRes = detectVolumeProfileNodes(
      [40, 160, 380, 480, 360, 140, 0, 0, 0, 0, 150, 370, 450, 340, 120, 30],
      { minBinIndex: 1000, tickSize: 0.1 },
    );
    expect(gapRes.lvnZones).toHaveLength(1);
    expect(gapRes.lvnZones[0]?.isPriceGap).toBe(true);
    expect(gapRes.lvnZones[0]?.volume).toBe(0);
    expect(gapRes.lvnZones[0]?.startBinIndex).toBe(1006);
    expect(gapRes.lvnZones[0]?.endBinIndex).toBe(1009);

    // 3) Tope por defecto 3 + 3 y separación mínima >= w bins.
    const multiModal = [
      20, 120, 420, 120, 10, 5, 5, 5, 10,
      130, 460, 130, 10, 4, 4, 4, 10,
      140, 500, 140, 10, 3, 3, 3, 10,
      125, 440, 125, 10, 6, 6, 6, 10,
      110, 390, 110, 20,
    ];
    const capped = detectVolumeProfileNodes(multiModal, { minBinIndex: 1000, tickSize: 0.5 });
    expect(capped.hvnZones.length).toBeLessThanOrEqual(3);
    expect(capped.lvnZones.length).toBeLessThanOrEqual(3);
    expect(capped.hvnZones).toHaveLength(3);
    expect(capped.lvnZones).toHaveLength(3);

    // 4) Entradas inválidas devuelven resultado vacío sin lanzar excepción ni NaN oculto.
    const invalid = detectVolumeProfileNodes([10, -1, 20], { minBinIndex: 100, tickSize: 0.1 });
    expect(invalid.hvnZones).toEqual([]);
    expect(invalid.lvnZones).toEqual([]);
    expect(Number.isNaN(invalid.smoothedPocVolume)).toBe(true);
  });

  it('PanoramicBandsPrimitive devuelve autoscaleInfo() === null, usa colores exactos y respeta guardas UI', () => {
    expect(HVN_BAND_FILL_COLOR).toBe('rgba(56, 189, 248, 0.09)');
    expect(LVN_BAND_FILL_COLOR).toBe('rgba(245, 158, 11, 0.08)');
    const primitive = new PanoramicBandsPrimitive({
      enabled: true,
      tickSize: 0.5,
      hvnZones: [
        {
          kind: 'HVN',
          startBinIndex: 100,
          endBinIndex: 105,
          lowPrice: 50,
          highPrice: 52.5,
          centerPrice: 51.25,
          volume: 100_000,
          volumeSharePct: 35,
          prominence: 50_000,
          prominenceRatio: 0.8,
          isPriceGap: false,
        },
      ],
      lvnZones: [],
    });
    expect(primitive.autoscaleInfo()).toBeNull();

    const viewSrc = readFileSync(join(process.cwd(), 'web/src/components/StockDetailView.tsx'), 'utf-8');
    expect(viewSrc).toContain('PanoramicBandsPrimitive');
    expect(viewSrc).toContain('VP (OHLCV uniforme)');
    expect(viewSrc).toContain('aria-label="Horizonte VP"');
    expect(viewSrc).toContain('label="HVN/LVN"');
    expect(viewSrc).toContain('1Y · 252R');
    expect(viewSrc).not.toContain('localStorage');
  });
});
