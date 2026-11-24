"""Local Chromium canvas check using the installed LWC build, no provider access.
Run through pieza1_browser_check.mts, which supplies the actual compiled TS helper.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
helper = json.load(sys.stdin)['helper']
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True, args=['--no-proxy-server'])
    page = browser.new_page(viewport={'width':1100,'height':600}, device_scale_factor=1)
    page.set_content('<html><body style="background:#101018;color:white"><p>Pieza 1 · Chromium local · 150 velas + margen 3</p><div id="chart" style="width:1000px;height:480px"></div></body></html>')
    page.add_script_tag(content=(root/'web/node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js').read_text())
    page.evaluate(f'window.initialRange = ({helper})')
    results = page.evaluate('''async () => {
      const chart = LightweightCharts.createChart(document.getElementById('chart'), {
        width:1000,height:480,layout:{background:{color:'#101018'},textColor:'#aaa'},
        timeScale:{enableConflation:true,precomputeConflationOnInit:false}});
      const candles = chart.addSeries(LightweightCharts.CandlestickSeries);
      const bars = Array.from({length:2880},(_,i)=>({time:1700000040+i*60,open:100+i/100,high:101+i/100,low:99+i/100,close:100.5+i/100}));
      candles.setData(bars);
      chart.timeScale().setVisibleLogicalRange(window.initialRange(bars.length));
      const settle = () => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await settle(); const initial = chart.timeScale().getVisibleLogicalRange();
      chart.timeScale().setVisibleLogicalRange({from:2000,to:2152}); await settle();
      const manual = chart.timeScale().getVisibleLogicalRange();
      candles.update({...bars[bars.length-1],close:130}); await settle();
      const afterTick = chart.timeScale().getVisibleLogicalRange();
      candles.update({time:bars[bars.length-1].time+60,open:130,high:131,low:129,close:130}); await settle();
      const afterRollover = chart.timeScale().getVisibleLogicalRange();
      candles.applyOptions({visible:true}); await settle();
      const afterToggle = chart.timeScale().getVisibleLogicalRange();
      candles.update({...bars[2050],close:121},true); await settle();
      const afterHistoricalCorrection = chart.timeScale().getVisibleLogicalRange();
      chart.timeScale().setVisibleLogicalRange(window.initialRange(bars.length)); await settle();
      return {initial,manual,afterTick,afterRollover,afterToggle,afterHistoricalCorrection,canvasCount:document.querySelectorAll('canvas').length};
    }''')
    assert abs(results['initial']['from']-2730)<1e-9, results
    assert abs(results['initial']['to']-2882)<1e-9, results
    for key in ['afterTick','afterRollover','afterToggle','afterHistoricalCorrection']:
        assert results[key] == results['manual'], results
    assert results['canvasCount'] > 0
    results['kind'] = 'REAL_HEADLESS_CHROMIUM_LOCAL_LWC_CANVAS_NO_PROVIDER'
    artifact = root/'.cache/pieza1-browser-viewport.json'
    artifact.write_text(json.dumps(results,indent=2))
    page.screenshot(path=str(root/'.cache/pieza1-browser-viewport.png'))
    browser.close()
    print(json.dumps(results,indent=2))
