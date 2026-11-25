/**
 * Suite focalizada — Micro-ajuste visual del gráfico panorámico (`main` post-Sub-fase 2):
 *  1) Proyección `AVWAP Auto Institucional` (`SUP`/`RES`/`EVT`) en `15m` y `1h` con
 *     exclusión mutua trayectoria/proyección y selector de proximidad intradiario.
 *  2) Corte transparente del salto vertical de `Session VWAP` en transiciones de sesión
 *     validado contra `walkLine` real de `lightweight-charts@5.3.0`.
 *  3) Clampeo vertical de etiquetas `HVN`/`LVN` en `PanoramicBandsPrimitive` cuando la
 *     banda corta el borde superior (`yTop < 0`) o inferior (`yBottom > height`), sin
 *     alterar `autoscaleInfo(): null`.
 *  4) Ocultamiento del contenedor vacío superior izquierdo (`crosshairLegendRef`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { institutionalRepresentation } from '../src/core/sessionKeyLevels.js';
import {
  PanoramicBandsPrimitive,
  computeClippedBandLabelY,
} from '../web/src/components/stock-detail/PanoramicBandsPrimitive.js';
import {
  SESSION_VWAP_BREAK_COLOR,
  buildSessionVwapLinePoints,
  type MinimalOhlcvBar,
} from '../web/src/components/stock-detail/stockDetailMath.js';

function makeBar(time: number, close = 100): MinimalOhlcvBar {
  return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 };
}

describe('Ajustes visuales quirúrgicos del gráfico panorámico', () => {
  it('proyecta SUP/RES/EVT en 15m y 1h cuando anchorTimeSec < bars[0].time y mantiene exclusión mutua', () => {
    for (const tf of ['1m', '5m', '15m', '1h'] as const) {
      expect(
        institutionalRepresentation({
          timeframe: tf,
          firstBarTime: 1_780_000_000,
          evalTimeSec: 1_780_050_000,
          anchorTimeSec: 1_779_000_000,
          currentAvwap: 615.25,
          visible: true,
          legacyInRange: false,
        }),
        `${tf} anterior al buffer`,
      ).toBe('PROJECTION');

      expect(
        institutionalRepresentation({
          timeframe: tf,
          firstBarTime: 1_780_000_000,
          evalTimeSec: 1_780_050_000,
          anchorTimeSec: 1_780_000_000,
          currentAvwap: 615.25,
          visible: true,
          legacyInRange: true,
        }),
        `${tf} exactamente en bars[0].time`,
      ).toBe('TRAJECTORY');

      expect(
        institutionalRepresentation({
          timeframe: tf,
          firstBarTime: 1_780_000_000,
          evalTimeSec: 1_780_050_000,
          anchorTimeSec: 1_780_010_000,
          currentAvwap: 615.25,
          visible: true,
          legacyInRange: true,
        }),
        `${tf} dentro del buffer`,
      ).toBe('TRAJECTORY');
    }

    const viewSrc = readFileSync(
      join(process.cwd(), 'web/src/components/StockDetailView.tsx'),
      'utf-8',
    );
    expect(viewSrc).toContain(
      "effectiveChartTimeframe==='1m'||effectiveChartTimeframe==='5m'||effectiveChartTimeframe==='15m'||effectiveChartTimeframe==='1h'",
    );
    expect(viewSrc).toContain(
      "const intraday = timeframe==='1m'||timeframe==='5m'||timeframe==='15m'||timeframe==='1h';",
    );
  });

  it('corta el segmento de Session VWAP exactamente en el cambio de sesión y ejecuta walkLine real de LWC 5.3.0', () => {
    // 2026-11-24 (EST -05:00): RTH = 14:30..21:00 UTC
    // 2026-11-24 15:50 ET = 20:50 UTC (1795553400)
    // 2026-11-24 15:55 ET = 20:55 UTC (1795553700)
    // 2026-11-24 16:00 ET = 21:00 UTC (1795554000) -> AH frozen (misma sesión 2026-11-24)
    // 2026-11-25 09:20 ET = 14:20 UTC (1795616400) -> PM frozen (misma sesión 2026-11-24)
    // 2026-11-25 09:25 ET = 14:25 UTC (1795616700) -> ÚLTIMO punto sesión previa (debe cortar aquí)
    // 2026-11-25 09:30 ET = 14:30 UTC (1795617000) -> PRIMER punto RTH nueva sesión (color normal)
    // 2026-11-25 09:35 ET = 14:35 UTC (1795617300) -> segundo punto nueva sesión (color normal)
    const bars: readonly MinimalOhlcvBar[] = [
      makeBar(1795553400),
      makeBar(1795553700),
      makeBar(1795554000),
      makeBar(1795616400),
      makeBar(1795616700),
      makeBar(1795617000),
      makeBar(1795617300),
    ];
    const values: readonly (number | null)[] = [637.4, 637.5, 637.5, 637.5, 637.5, 614.0, 614.3];
    const points = buildSessionVwapLinePoints(bars, values, 'US');

    expect(points).toHaveLength(7);
    // Solo el último punto antes de 09:30 ET (índice 4, 14:25 UTC) recibe color transparente.
    expect(points[0]?.color).toBeUndefined();
    expect(points[1]?.color).toBeUndefined();
    expect(points[2]?.color).toBeUndefined();
    expect(points[3]?.color).toBeUndefined();
    expect(points[4]?.color).toBe(SESSION_VWAP_BREAK_COLOR);
    expect(points[5]?.color).toBeUndefined();
    expect(points[6]?.color).toBeUndefined();

    // Verifica contra el `walkLine` real instalado en lightweight-charts@5.3.0
    const libSrc = readFileSync(
      join(
        process.cwd(),
        'web/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs',
      ),
      'utf-8',
    );
    const libAst = ts.createSourceFile(
      'lwc.mjs',
      libSrc,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const walkLineFn = libAst.statements.find(
      (stmt): stmt is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'walkLine',
    );
    if (walkLineFn === undefined) throw new Error('walkLine not found in LWC 5.3.0');

    const strokedSegments: { readonly style: string; readonly fromX: number; readonly toX: number }[] = [];
    const runWalk = runInNewContext(`(() => {
      ${walkLineFn.getText(libAst)}
      return (items, cb) => {
        const ctx = {
          beginPath() {},
          moveTo() {},
          lineTo() {},
          bezierCurveTo() {},
          lineDashOffset: 0,
        };
        walkLine(
          { context: ctx, horizontalPixelRatio: 1, verticalPixelRatio: 1 },
          items,
          0,
          { from: 0, to: items.length },
          10,
          (_scope, item) => item.color,
          (_scope, style, first, last) => cb(style, first._internal_x, last._internal_x),
          0,
        );
      };
    })()`) as (
      items: readonly { _internal_x: number; _internal_y: number; color: string }[],
      cb: (style: string, fromX: number, toX: number) => void,
    ) => void;

    const lwcItems = points.map((pt, idx) => ({
      _internal_x: idx * 10,
      _internal_y: pt.value,
      color: pt.color ?? '#FACC15',
    }));
    runWalk(lwcItems, (style, fromX, toX) => {
      strokedSegments.push({ style, fromX, toX });
    });

    expect(strokedSegments).toEqual([
      { style: '#FACC15', fromX: 0, toX: 40 },
      { style: SESSION_VWAP_BREAK_COLOR, fromX: 40, toX: 50 },
      { style: '#FACC15', fromX: 50, toX: 60 },
    ]);

    // Caso AR (-10_800): corte exacto al cambiar de día civil ART
    const arBars: readonly MinimalOhlcvBar[] = [
      makeBar(1795543200), // 2026-11-24 15:00 ART
      makeBar(1795546800), // 2026-11-24 16:00 ART (último de sesión 1)
      makeBar(1795615200), // 2026-11-25 11:00 ART (primero de sesión 2)
      makeBar(1795618800), // 2026-11-25 12:00 ART
    ];
    const arPts = buildSessionVwapLinePoints(arBars, [8000, 8010, 8150, 8170], 'AR');
    expect(arPts.map((p) => p.color)).toEqual([
      undefined,
      SESSION_VWAP_BREAK_COLOR,
      undefined,
      undefined,
    ]);
  });

  it('clampea etiquetas HVN/LVN al viewport visible en PanoramicBandsPrimitive y mantiene autoscaleInfo() === null', () => {
    expect(computeClippedBandLabelY(-50, 40, 400)).toBe(11);
    expect(computeClippedBandLabelY(375, 450, 400)).toBe(386);
    expect(computeClippedBandLabelY(390, 450, 400)).toBeNull(); // solo 10px visibles (< 14)
    expect(computeClippedBandLabelY(-40, 10, 400)).toBeNull(); // solo 10px visibles (< 14)

    const primitive = new PanoramicBandsPrimitive({
      enabled: true,
      tickSize: 0,
      hvnZones: [
        {
          kind: 'HVN',
          startBinIndex: 1,
          endBinIndex: 2,
          lowPrice: 520,
          highPrice: 560, // yHigh = -40, yLow = 40 -> corta borde superior
          centerPrice: 540,
          volume: 1000,
          volumeSharePct: 40,
          prominence: 500,
          prominenceRatio: 0.8,
          isPriceGap: false,
        },
      ],
      lvnZones: [
        {
          kind: 'LVN',
          startBinIndex: 3,
          endBinIndex: 4,
          lowPrice: 440,
          highPrice: 480, // yHigh = 375, yLow = 460 -> corta borde inferior
          centerPrice: 460,
          volume: 10,
          volumeSharePct: 1,
          prominence: 300,
          prominenceRatio: 0.5,
          isPriceGap: false,
        },
      ],
    });
    expect(primitive.autoscaleInfo()).toBeNull();

    const coords = new Map<number, number>([
      [560, -40],
      [520, 40],
      [480, 375],
      [440, 460],
    ]);
    type AttachedParam = Parameters<PanoramicBandsPrimitive['attached']>[0];
    primitive.attached({
      chart: {},
      series: {
        priceToCoordinate: (p: number) => coords.get(p) ?? null,
      },
      requestUpdate: vi.fn(),
    } as unknown as AttachedParam);

    const drawnLabels: { readonly text: string; readonly x: number; readonly y: number }[] = [];
    const fakeCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn((text: string, x: number, y: number) => {
        drawnLabels.push({ text, x, y });
      }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
    };

    const views = primitive.paneViews();
    expect(views).toHaveLength(1);
    const renderer = views[0]?.renderer();
    expect(renderer).not.toBeNull();
    type DrawFn = NonNullable<typeof renderer>['draw'];
    type DrawTarget = Parameters<DrawFn>[0];
    const fakeTarget: DrawTarget = {
      useMediaCoordinateSpace: (
        fn: (scope: { readonly context: unknown; readonly mediaSize: { readonly width: number; readonly height: number } }) => void,
      ) => {
        fn({
          context: fakeCtx,
          mediaSize: { width: 800, height: 400 },
        });
      },
      useBitmapCoordinateSpace: vi.fn(),
    } as unknown as DrawTarget;
    renderer?.draw(fakeTarget);

    expect(drawnLabels).toEqual([
      { text: 'HVN', x: 6, y: 11 },
      { text: 'LVN', x: 6, y: 386 },
    ]);
    for (const lbl of drawnLabels) {
      expect(lbl.y).toBeGreaterThanOrEqual(0);
      expect(lbl.y).toBeLessThanOrEqual(400);
    }
  });

  it('oculta el contenedor vacío superior izquierdo (crosshairLegendRef) cuando no hay texto', () => {
    const viewSrc = readFileSync(
      join(process.cwd(), 'web/src/components/StockDetailView.tsx'),
      'utf-8',
    );
    expect(viewSrc).toContain('ref={crosshairLegendRef}');
    expect(viewSrc).toContain('legendEl.hidden = false;');
    expect(viewSrc).toContain('legendEl.hidden = true;');
    expect(viewSrc).toContain('empty:hidden');
    expect(viewSrc).not.toContain('localStorage');
  });
});
