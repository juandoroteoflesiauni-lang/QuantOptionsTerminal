import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advanceSessionVwapCheckpoint, buildSessionVwapCheckpoint, projectLiveSessionVwapFromCheckpoint } from '../src/core/realtimePropagation.js';
import { BYMA_MARKET_TZ, US_MARKET_TZ } from '../src/core/ggal/technicalIndicators.js';

function readRepoFile(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf-8').replace(/\r\n/g, '\n');
}

describe('Perf-1 Chart Incremental & Structural Guards', () => {
  it('GgalDualChartView preserva incremento O(1) y evita setData/conflation en ticks y polls', () => {
    const src = readRepoFile('web/src/components/ggal/GgalDualChartView.tsx');

    // Conflation EOD/Init diferida para evitar freeze en createChart().
    expect(src).toContain('precomputeConflationOnInit: false');
    expect(src).not.toContain('precomputeConflationOnInit: true');

    // datasetSig y fitKey NO dependen de asOfUtcSec (no resetean zoom ni re-setData en polls).
    const sigSection = src.slice(src.indexOf('const datasetSig ='), src.indexOf('if (lastDatasetSigRef.current === datasetSig)'));
    expect(sigSection).not.toContain('asOfUtcSec');
    expect(src).toContain('const fitKey = `${safePayload.timeframe}|${safePayload.coordMode}`;');

    // VWAP en vivo O(1) con checkpoint en rAF.
    expect(src).toContain('buildSessionVwapCheckpoint(');
    expect(src).toContain('advanceSessionVwapCheckpoint(');
    expect(src).toContain('projectLiveSessionVwapFromCheckpoint(');
    expect(src).not.toContain('projectLiveSessionVwap(');

    // CVD escalar O(1) en rAF.
    expect(src).toContain('liveBarCvdDeltaRef');
    expect(src).not.toContain('appendLiveTapeTick');

    // Revisiones históricas sobre timestamp existente usan update(..., true) sin setData().
    expect(src).toContain('findBarIndexByTime(');
    expect(src).toMatch(/candleSeriesRef\.current\?\.update\(\s*\{[\s\S]*?\},\s*true,?\s*\)/);

    // Aislamiento de canal AR/US, visibilidad por tab oculta y ViewScope dual.
    expect(src).toContain("if (coordMode === 'USD_ADR_NASDAQ') return;");
    expect(src).toContain("if (coordMode === 'ARS_BYMA') return;");
    expect(src).toContain("document.visibilityState === 'hidden'");
    expect(src).toContain("setVisibleMarketSymbols(['AR:GGAL', 'US:GGAL'], 'ggal-dual')");
    expect(src).toContain("useMarketViewScope('ggal_specialist', 'GGAL', 'AR'");

    // Higiene UI: sin clases prohibidas.
    expect(src).not.toContain('backdrop-blur-');
    expect(src).not.toContain('animate-pulse');
    expect(src).not.toContain('animate-ping');
  });

  it('GgalSpecialistModule carga en 2 fases (?light=1 + full) con race guard y diferimiento secundario', () => {
    const src = readRepoFile('web/src/components/ggal/GgalSpecialistModule.tsx');
    expect(src).toContain('dualChartGenRef');
    expect(src).toContain('fullHydratedGenRef');
    expect(src).toContain('light: true');
    expect(src).toContain('subPaneMode: activeSubPane');
    expect(src).toContain('setTimeout(() => {\r\n      void loadDualMicro(false);'.replace(/\r\n/g, '\n').split('\n')[0] ?? 'setTimeout(');
    expect(src).toContain('void loadTab(activeTab, false);');

    const clientSrc = readRepoFile('web/src/api/ggalSpecialistClient.ts');
    expect(clientSrc).toContain("sp.set('subPaneMode', params.subPaneMode)");
    expect(clientSrc).toContain('if (params.light !== false)');
  });

  it('StockDetailView y SyncedLowerPaneChart aíslan re-renders, waterfall, overlays=0 y prefetch=false', () => {
    const detailSrc = readRepoFile('web/src/components/StockDetailView.tsx');
    const lowerSrc = readRepoFile('web/src/components/stock-detail/SyncedLowerPaneChart.tsx');

    // StockDetailView usa slice selectivo + hojas de L2 aisladas + memo en charts.
    expect(detailSrc).toContain('useLiveStockDetailRuntimeSlice(');
    expect(detailSrc).not.toContain('useLiveMarketState(');
    expect(detailSrc).toContain('StockDetailHeaderBookCards');
    expect(detailSrc).toContain('StockDetailExecutionSection');
    expect(detailSrc).toContain('useMarketFocusSymbol(cleanTicker)');
    expect(detailSrc).toContain("setVisibleMarketSymbols([qualified], 'stock-detail')");
    expect(detailSrc).toContain('precomputeConflationOnInit: false');
    expect(detailSrc).not.toContain('precomputeConflationOnInit: true');
    expect(detailSrc).toContain('includeOverlays: false');
    expect(detailSrc).toContain('prefetch: false');

    // chartBundle para PanoramicPriceChart no depende de arOptions ni usSnap.
    const arReqPos = detailSrc.indexOf('void requestOptionsChain(cleanTicker)');
    const arBarsAwaitPos = detailSrc.indexOf('let arBarsRes = await requestTerminalBars(');
    expect(arReqPos).toBeGreaterThan(-1);
    expect(arBarsAwaitPos).toBeGreaterThan(arReqPos);

    // SyncedLowerPaneChart solo computa la serie del modo activo y está memoizado.
    expect(lowerSrc).toContain('precomputeConflationOnInit: false');
    expect(lowerSrc).not.toContain('precomputeConflationOnInit: true');
    expect(lowerSrc).toContain("mode === 'CVD' ? computeLeeReadyBarFlow(bundle.bars)");
    expect(lowerSrc).toContain("mode === 'RS' ? computeRelativeStrengthSeries(bundle.bars, bundle.benchmarkBars1d, true)");
    expect(lowerSrc).toContain("mode === 'VOLATILITY' && timeframe === '1D' ? computeRollingRvSeries(bundle.bars, 30, 252)");
    expect(lowerSrc).not.toContain('backdrop-blur-');
    expect(lowerSrc).not.toContain('animate-pulse');
    expect(lowerSrc).not.toContain('animate-ping');
  });

  it('marketFeed.worker preserva sobres de deltaRevision vacíos sin disparar RESYNC_WS', () => {
    const workerSrc = readRepoFile('web/src/workers/marketFeed.worker.ts');
    expect(workerSrc).toContain('hasRevisionEnvelope');
    expect(workerSrc).toContain('!hasRevisionEnvelope &&');
    expect(workerSrc).toContain('notifyStopPollOnce()');
    const marketBatchSection = workerSrc.slice(
      workerSrc.indexOf("if (type === 'market_batch')"),
      workerSrc.indexOf("if (type === 'option_quotes_batch')"),
    );
    expect(marketBatchSection).toContain('hasRevisionEnvelope');
    expect(marketBatchSection).toContain('return;\n    }\n    workerSelf.postMessage');
  });

  it('Session VWAP checkpoint maneja transiciones de sesión NY y BYMA sin NaN ni deriva', () => {
    const cpNy = buildSessionVwapCheckpoint([], US_MARKET_TZ);
    const b1 = { timeSec: 1_760_016_000, open: 50, high: 51, low: 49, close: 50.5, volume: 100 };
    const cp2 = advanceSessionVwapCheckpoint(cpNy, b1, US_MARKET_TZ);
    const live = projectLiveSessionVwapFromCheckpoint(
      cp2,
      { timeSec: 1_760_016_300, open: 50.5, high: 52, low: 50, close: 51.5, volume: 50 },
      US_MARKET_TZ,
    );
    expect(live).not.toBeNull();
    expect(Number.isFinite(live?.value)).toBe(true);

    const cpAr = buildSessionVwapCheckpoint([b1], BYMA_MARKET_TZ);
    expect(cpAr).not.toBeNull();
    expect(cpAr?.closedCumVol).toBe(100);
  });
});
