import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { computeInitialVisibleLogicalRange, resolveChartFitKey, resolveChartViewportTransition, type ChartLogicalRange, type InitialLogicalRangeOptions } from '../src/core/stockDetailChartNavigation.js';

const reference = JSON.parse(readFileSync('fixtures/subfase1_pieza1_reference.json','utf8')) as {
  zooms: { count:number; options:InitialLogicalRangeOptions; expected:ChartLogicalRange|null }[];
};
const source = readFileSync('web/src/components/StockDetailView.tsx','utf8');

/** Execute the real hydration effect with a mocked Chart API; no copied decision logic. */
function effectCallback(marker: string): string {
  const ast = ts.createSourceFile('StockDetailView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(ast)==='useEffect') {
      const candidate = node.arguments[0];
      if (candidate !== undefined && candidate.getText(ast).includes(marker)) callback=candidate.getText(ast);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  if (callback===undefined) throw new Error('Historical hydration effect missing');
  return ts.transpileModule(`(${callback})`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText;
}

describe('Pieza 1 — initial logical zoom and existing hydration lifecycle',()=>{
  it('matches every independent integer range, target clamp and single right offset',()=>{
    for(const c of reference.zooms) expect(computeInitialVisibleLogicalRange(c.count,Object.freeze(c.options))).toEqual(c.expected);
    for(const n of [-1,Number.NaN,Infinity,1.5]) expect(computeInitialVisibleLogicalRange(n)).toBeNull();
    expect(computeInitialVisibleLogicalRange(500,{minBars:200,maxBars:120})).toBeNull();
    expect(computeInitialVisibleLogicalRange(500,{rightOffsetBars:Infinity})).toBeNull();
  });

  it('applies the real effect once per instrument/TF, preserves manual context on corrections, and ignores stale hydration',()=>{
    const setRange=vi.fn(); const setData=vi.fn();
    const ctx: Record<string,unknown> = {
      chartRef:{current:{timeScale:()=>({setVisibleLogicalRange:setRange})}},candleRef:{current:{setData}},
      ticker:'AMD',timeframe:'1m',
      lastFitStateRef:{current:{key:null,barCount:0,firstBarTime:null,lastBarTime:null}},
      initialViewportKeyRef:{current:null},lastRenderedBarsRef:{current:[]},formingBarRef:{current:null},
      emaBaseBeforeFormingRef:{current:{}},emaEndOfFormingRef:{current:{}},emaRefs:{current:[]},vwapRef:{current:null},avwapRefs:{current:{}},
      computeInitialVisibleLogicalRange,resolveChartFitKey,resolveChartViewportTransition,
    };
    const effect=runInNewContext(effectCallback('const nextKey = resolveChartFitKey'),ctx) as ()=>void;
    const hydrate=(count:number,first=1000):void=>{
      ctx['bundle']={barsAvailable:count>0,bars:Array.from({length:count},(_,i)=>({time:first+i*60,open:100,high:101,low:99,close:100,volume:1})),
        ema9:[],ema21:[],ema50:[],ema200:[],sessionVwap:[],autoAvwapLines:[],isAutoAvwapMode:false};
      effect();
    };
    hydrate(0); expect(setRange).not.toHaveBeenCalled();
    hydrate(500); expect(setRange).toHaveBeenLastCalledWith({from:350,to:502});
    // A corrected first timestamp and a larger history must preserve the user's viewport.
    hydrate(501); hydrate(550,940); hydrate(550,940);
    expect(setRange).toHaveBeenCalledTimes(1);
    ctx['timeframe']='5m'; hydrate(500); expect(setRange).toHaveBeenCalledTimes(2);
    ctx['ticker']='NVDA'; hydrate(80); expect(setRange).toHaveBeenLastCalledWith({from:0,to:82});
    expect(setRange).toHaveBeenCalledTimes(3);
  });

  it('executes the actual REST effect: aborts superseded requests and publishes only the current generation', async()=>{
    const publish=vi.fn(); const pending: ((value:unknown)=>void)[]=[];
    const signals: AbortSignal[]=[];
    const ctx:Record<string,unknown>={
      AbortController, runtime:{hasOverview:true},hasOverviewRef:{current:true}, loadingRequestIdRef:{current:0},
      clickedAnchorStockKeyRef:{current:'US:AMD'},currentStockKey:'US:AMD',cleanTicker:'AMD',timeframe:'1m',isArMarket:false,
      arBarsByKey:{},usBarsByKey:{},stockDetail:null,
      setLoading:vi.fn(),setLoadError:vi.fn(),setHighlightedLevel:vi.fn(),setClickedAnchorTimeSec:vi.fn(),setArFallbackNotice:vi.fn(),
      setUsBarsByKey:publish,requestUsSnapshot:()=>Promise.resolve(null),
      requestTerminalBars:(_symbol:string,_tf:string,options:{signal:AbortSignal})=>{
        signals.push(options.signal); return new Promise<unknown>((resolve)=>pending.push(resolve));
      },
    };
    const effect=runInNewContext(effectCallback('const isCurrent = (): boolean'),ctx) as ()=>()=>void;
    const cleanup=effect();
    cleanup(); expect(signals[0]?.aborted).toBe(true);
    ctx['currentStockKey']='US:NVDA';ctx['cleanTicker']='NVDA';effect();
    pending[0]?.({bars:[{time:1}]}); await Promise.resolve();await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    pending[1]?.({bars:[{time:2}]}); await Promise.resolve();await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    const update=publish.mock.calls[0]?.[0] as (prev:Record<string,unknown>)=>Record<string,unknown>;
    expect(update({})).toEqual({'US:NVDA:1m':{bars:[{time:2}]}});
  });

  it('leaves ticks/toggles on their incremental paths and keeps backend default transmission unambiguous',()=>{
    const tick=source.slice(source.indexOf('const flushLiveTick'),source.indexOf('const flushLiveTick')+10000);
    expect(tick).not.toContain('setVisibleLogicalRange('); expect(tick).not.toContain('.setData(');
    const visibility=source.slice(source.indexOf('// Visibilidad de overlays'),source.indexOf('// Visibilidad de overlays')+2400);
    expect(visibility).not.toContain('setVisibleLogicalRange('); expect(visibility).not.toContain('.setData(');
    expect(source).not.toContain('.fitContent()');
    const request=source.slice(source.indexOf('const barsPromise = requestTerminalBars'),source.indexOf('const barsPromise = requestTerminalBars')+420);
    expect(request).toContain('adaptiveWindow: true'); expect(request).not.toMatch(/visibleBars:\s*\d/);
    const bridge=readFileSync('web/src/data/liveRuntimeBridge.ts','utf8');
    expect(bridge).toContain("const visibleParam = adaptiveWindow ? ''");
    expect(source).not.toContain('rightOffset:'); expect(source).not.toContain('rightOffsetPixels:');
    // Installed LWC applies this range directly; it does not add rightOffset again.
    const lwc=readFileSync('web/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs','utf8');
    expect(lwc).toContain('const barRange = new RangeImpl(range.from, range.to);');
  });
});
