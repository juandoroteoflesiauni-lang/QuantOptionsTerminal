/**
 * Suite Vitest 100% offline para estabilidad de navegación del gráfico en Stock Detail:
 *  1) Paridad estricta contra referencia Python independiente
 *     (`fixtures/stock_detail_chart_navigation_reference.json`).
 *  2) Preservación de zoom/pan ante ticks en vivo, toggles de overlays y cambios
 *     de modo del panel inferior.
 *  3) Supresión de eco bidireccional en sincronización de rangos lógicos y rechazo
 *     estricto de valores NaN / infinitos / rangos invertidos.
 *  4) Aislamiento de `subscribeCrosshairMove` respecto de estado React (`CLICKED_CANDLE`
 *     exclusivo de `subscribeClick`).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  areLogicalRangesClose,
  resolveAvwapClickAnchor,
  resolveChartFitKey,
  resolveChartViewportTransition,
  shouldApplyExternalLogicalRange,
  shouldEmitLogicalRangeSync,
  type ChartLogicalRange,
  type ChartViewportTransitionInput,
  type ChartViewportTransitionOutput,
} from '../src/core/stockDetailChartNavigation.js';

interface NavigationFixture {
  readonly meta: { readonly precisionTolerance: number };
  readonly fitKeyCases: readonly {
    readonly name: string;
    readonly ticker: string;
    readonly timeframe: string;
    readonly barsAvailable: boolean;
    readonly firstBarTime: number | null;
    readonly expected: string | null;
  }[];
  readonly viewportCases: readonly {
    readonly name: string;
    readonly input: ChartViewportTransitionInput;
    readonly expected: ChartViewportTransitionOutput;
  }[];
  readonly rangeApplyCases: readonly {
    readonly name: string;
    readonly current: ChartLogicalRange | null;
    readonly incoming: ChartLogicalRange | null;
    readonly tolerance: number;
    readonly expected: boolean;
  }[];
  readonly rangeEmitCases: readonly {
    readonly name: string;
    readonly emitted: ChartLogicalRange | null;
    readonly isSuppressed: boolean;
    readonly pendingExternal: ChartLogicalRange | null;
    readonly tolerance: number;
    readonly expected: boolean;
  }[];
  readonly avwapClickCases: readonly {
    readonly name: string;
    readonly mode: string;
    readonly clicked: number | null;
    readonly current: number | null;
    readonly expected: number | null;
  }[];
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL('../fixtures/stock_detail_chart_navigation_reference.json', import.meta.url),
    'utf-8',
  ),
) as NavigationFixture;

describe('Stock Detail Chart Navigation vs Python reference', () => {
  it('genera claves de dataset coherentes sin incluir ticks ni overlays', () => {
    for (const c of FIXTURE.fitKeyCases) {
      expect(
        resolveChartFitKey(c.ticker, c.timeframe, c.barsAvailable, c.firstBarTime),
        c.name,
      ).toBe(c.expected);
    }
  });

  it('decide fitContent solo al cargar/cambiar dataset y preserva pan/zoom en ticks en vivo', () => {
    for (const c of FIXTURE.viewportCases) {
      expect(resolveChartViewportTransition(c.input), c.name).toEqual(c.expected);
    }
  });

  it('evita re-aplicar rangos equivalentes y filtra ecos de sincronización bidireccional', () => {
    for (const c of FIXTURE.rangeApplyCases) {
      expect(
        shouldApplyExternalLogicalRange(c.current, c.incoming, c.tolerance),
        c.name,
      ).toBe(c.expected);
    }
    for (const c of FIXTURE.rangeEmitCases) {
      expect(
        shouldEmitLogicalRangeSync(c.emitted, c.isSuppressed, c.pendingExternal, c.tolerance),
        c.name,
      ).toBe(c.expected);
    }
  });

  it('actualiza ancla AVWAP únicamente por clic en modo CLICKED_CANDLE', () => {
    for (const c of FIXTURE.avwapClickCases) {
      expect(resolveAvwapClickAnchor(c.mode, c.clicked, c.current), c.name).toBe(c.expected);
    }
  });

  it('rechaza valores NaN, Infinity, tolerancias negativas o conteos inválidos', () => {
    expect(resolveChartFitKey('QQQ', '1D', true, Number.NaN)).toBeNull();
    expect(resolveChartFitKey('QQQ', '1D', true, Number.POSITIVE_INFINITY)).toBeNull();

    expect(
      areLogicalRangesClose(
        { from: Number.NaN, to: 100 },
        { from: 0, to: 100 },
      ),
    ).toBe(false);
    expect(areLogicalRangesClose({ from: 10, to: 20 }, { from: 10, to: 20 }, -1)).toBe(false);
    expect(areLogicalRangesClose({ from: 10, to: 20 }, { from: 10, to: 20 }, Number.NaN)).toBe(false);

    expect(
      shouldApplyExternalLogicalRange(null, { from: Number.POSITIVE_INFINITY, to: 200 }),
    ).toBe(false);
    expect(
      shouldEmitLogicalRangeSync({ from: 200, to: 100 }, false, null),
    ).toBe(false);

    expect(resolveAvwapClickAnchor('CLICKED_CANDLE', Number.NaN, 1_794_000_000)).toBe(
      1_794_000_000,
    );
    expect(resolveAvwapClickAnchor('CLICKED_CANDLE', Number.NaN, Number.NaN)).toBeNull();
  });

  it('mantiene desacoplado subscribeCrosshairMove del estado React y evita fitContent incondicional en UI', () => {
    const stockDetailSrc = readFileSync(
      new URL('../web/src/components/StockDetailView.tsx', import.meta.url),
      'utf-8',
    );
    const lowerPaneSrc = readFileSync(
      new URL('../web/src/components/stock-detail/SyncedLowerPaneChart.tsx', import.meta.url),
      'utf-8',
    );

    expect(stockDetailSrc).not.toContain('onCrosshairTime={setClickedAnchorTimeSec}');
    expect(stockDetailSrc).toContain('chart.subscribeClick(handleChartClick)');
    expect(stockDetailSrc).toContain('if (transition.shouldFitContent)');
    expect(lowerPaneSrc).toContain('shouldEmitLogicalRangeSync');
    expect(lowerPaneSrc).toContain('shouldApplyExternalLogicalRange');
  });
});
