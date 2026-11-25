/**
 * Pieza EXPORT-1: serializador determinista Markdown UTF-8 (8 secciones §6).
 *
 * Reglas:
 * - Cero NaN, Infinity, undefined ni fallbacks silenciosos -> siempre `N/D`.
 * - Punto decimal `.` para parseo automático.
 * - `OI === 0` se imprime `0`; `OI === null/NaN` se imprime `N/D`.
 * - Cero truncado silencioso: mide bytes UTF-8 exactos e informa si excede 15 KB.
 * - Ejecuta `assertNoSecretsInExportText()` antes de devolver.
 */

import { assertNoSecretsInExportText } from './usOptionsIntelligenceExport.js';
import {
  PRECISION_POLICY,
  TARGET_MARKDOWN_BUDGET_BYTES,
  type FilteredUsOptionsSnapshotV1,
  type MarkdownRenderOutput,
  type SnapshotIntegrityReport,
  type UnifiedContractCalcResult,
} from './usOptionsIntelligenceExportTypes.js';

export function escapeMarkdownCell(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'");
}

function fmtNum(value: number, decimals: number, signed = false): string {
  if (!Number.isFinite(value)) return 'N/D';
  const normalized = Object.is(value, -0) ? 0 : value;
  const fixed = normalized.toFixed(decimals);
  if (signed && normalized > 0) return `+${fixed}`;
  return fixed;
}

function fmtPremium(value: number): string {
  if (!Number.isFinite(value)) return 'N/D';
  const dec =
    Math.abs(value) > 0 && Math.abs(value) < PRECISION_POLICY.lowPremiumThreshold
      ? PRECISION_POLICY.lowPremiumUsd
      : PRECISION_POLICY.optionPremiumUsd;
  return fmtNum(value, dec);
}

function fmtGamma(value: number): string {
  if (!Number.isFinite(value)) return 'N/D';
  const dec =
    Math.abs(value) > 0 && Math.abs(value) < PRECISION_POLICY.smallGammaThreshold
      ? PRECISION_POLICY.smallGamma
      : PRECISION_POLICY.gamma;
  return fmtNum(value, dec);
}

function fmtPct(value: number, signed = false): string {
  const s = fmtNum(value, PRECISION_POLICY.percent, signed);
  return s === 'N/D' ? 'N/D' : `${s}%`;
}

function fmtUsd(value: number, decimals: number = PRECISION_POLICY.spotAndLevelUsd, signed = false): string {
  const s = fmtNum(value, decimals, signed);
  return s === 'N/D' ? 'N/D' : `${s} USD`;
}

function fmtCountKnown(value: number, known: boolean): string {
  if (!known || !Number.isFinite(value)) return 'N/D';
  return String(Math.round(value));
}

function renderChainTableRows(rows: readonly UnifiedContractCalcResult[]): string[] {
  if (rows.length === 0) {
    return ['| Sin contratos elegibles bajo filtro activo | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |'];
  }
  return rows.map((r) =>
    `| ${fmtNum(r.strike, 2)} | ${fmtPremium(r.bid)} | ${fmtPremium(r.ask)} | ${fmtPremium(r.mid)} | ${fmtPremium(r.spreadUsd)} | ${fmtPct(r.spreadPct)} | ${fmtNum(r.delta, PRECISION_POLICY.delta)} | ${fmtGamma(r.gamma)} | ${fmtNum(r.thetaDaily, PRECISION_POLICY.thetaDaily)} | ${fmtNum(r.vegaPer1Pct, PRECISION_POLICY.vegaPer1Pct)} | ${fmtPct(r.ivPct)} | ${fmtPremium(r.intrinsic)} | ${fmtPremium(r.timeValue)} | ${fmtCountKnown(r.volume, r.volumeKnown)} | ${fmtCountKnown(r.openInterest, r.openInterestKnown)} | ${fmtNum(r.gex, PRECISION_POLICY.exposureUsd, true)} | ${fmtPct(r.distanceSpotPct, true)} |`,
  );
}

export function renderUsOptionsSnapshotMarkdown(
  filtered: FilteredUsOptionsSnapshotV1,
  integrity: SnapshotIntegrityReport,
): MarkdownRenderOutput {
  const s = filtered.snapshot;
  const tech = s.technical;
  const fg = s.flowGlobal;
  const vol = s.volatility;
  const allWarnings = [
    ...integrity.blockingErrors.map((e) => `ERROR: ${e}`),
    ...integrity.clockSkewWarnings,
    ...integrity.warnings,
  ];

  const lines: string[] = [];

  lines.push(`# SNAPSHOT INSTITUCIONAL OPCIONES US — ${escapeMarkdownCell(s.meta.ticker)}`);
  lines.push('');
  lines.push(`- Snapshot ID: ${escapeMarkdownCell(s.snapshotId)}`);
  lines.push(`- Schema: ${s.schemaVersion}`);
  lines.push(`- Capturado: ${s.meta.capturedAt.artFormatted} / ${s.meta.capturedAt.etFormatted} (UTC: ${s.meta.capturedAt.isoUtc})`);
  lines.push(`- Sesión: ${s.meta.sessionRegime}`);
  lines.push(`- Modo: ${s.meta.mode.toUpperCase()}`);
  lines.push(`- Vencimientos: ${s.meta.selectedExpirations.map((e) => {
    const m = s.metadataByExpiry[e];
    return m ? `${e} (${String(m.daysToExpiry)} DTE)` : e;
  }).join(' | ')}`);
  lines.push(`- Evento en ventana: ${escapeMarkdownCell(s.meta.catalystWindow.badgeLabel)} (${escapeMarkdownCell(s.meta.catalystWindow.detailLabel)})`);
  lines.push(`- Calidad global: ${integrity.globalQuality}`);
  lines.push(`- Advertencias: ${allWarnings.length > 0 ? escapeMarkdownCell(allWarnings.join(' ; ')) : 'Ninguna'}`);
  lines.push('');

  // ## 1. Spot y estructura técnica
  lines.push('## 1. Spot y estructura técnica');
  lines.push('');
  lines.push(`- Spot: ${fmtUsd(tech.valuationSpot)} (valuationSpot anclado${Number.isFinite(tech.spotDriftPct) && Math.abs(tech.spotDriftPct) > 0.01 ? `; live al exportar: ${fmtUsd(tech.liveSpotAtCapture)}, drift ${fmtPct(tech.spotDriftPct, true)}` : ''}; moneda: USD)`);
  lines.push(`- Variación diaria: ${fmtUsd(tech.changeAbs, 2, true)} (${fmtPct(tech.changePct, true)})`);
  lines.push(`- Apertura / cierre previo: ${fmtUsd(tech.dayOpen)} / ${fmtUsd(tech.previousClose)}`);
  lines.push(`- Día H/L: ${fmtUsd(tech.dayHigh)} / ${fmtUsd(tech.dayLow)} (Rango: ${fmtUsd(tech.sessionRangeUsd)})`);
  lines.push(`- Bid / Ask Spot NBBO: ${Number.isFinite(tech.spotBid) && Number.isFinite(tech.spotAsk) ? `${fmtNum(tech.spotBid, 2)} / ${fmtNum(tech.spotAsk, 2)} USD (spread ${fmtPct(tech.spotSpreadPct)})` : 'N/D'}`);
  lines.push(`- ATR(14): ${fmtUsd(tech.atr14d)} (1D Wilder) | % ATR recorrido: ${fmtPct(tech.atrTravelledPct)} [fórmula: ${tech.atrTravelledFormula}]`);
  lines.push(`- EMAs / SMAs por timeframe: ${[
    ...tech.emas.map((e) => `EMA${String(e.period)}[${e.timeframe}]=${fmtUsd(e.value)} (${fmtPct(e.distanceSpotPct, true)})`),
    'EMA20=N/D (no implementado)',
    ...tech.smas.map((m) => `SMA${String(m.period)}[${m.timeframe}]=${fmtUsd(m.value)} (${fmtPct(m.distanceSpotPct, true)})`),
  ].join(' | ')}`);
  lines.push(`- Tendencia / Estructura MTF: 1D=${tech.mtfStructure.regime1d ?? 'N/D'} | 4H aligned=${tech.mtfStructure.aligned4h === null ? 'N/D' : String(tech.mtfStructure.aligned4h)} | Macro=${tech.mtfStructure.effectiveMacroRegime ?? 'N/D'} | Setup=${tech.mtfStructure.setupStatus ?? 'N/D'} | Sesgo=${tech.mtfStructure.directionalBias ?? 'N/D'} (${fmtNum(tech.mtfStructure.confluenceScore, 1)} pts)`);
  lines.push(`- VWAP Sesión (${tech.sessionVwap.timeframe}): ${tech.sessionVwap.supported ? `${fmtUsd(tech.sessionVwap.value)} (${fmtPct(tech.sessionVwap.distanceSpotPct, true)})` : 'N/D (no aplica al timeframe)'}`);
  lines.push(`- AVWAP Inicio Mes: ${tech.avwapMonthStart ? `${fmtUsd(tech.avwapMonthStart.value)} (${fmtPct(tech.avwapMonthStart.distanceSpotPct, true)}, ancla ${tech.avwapMonthStart.anchorDate ?? 'N/D'}, cobertura ${tech.avwapMonthStart.coverage})` : 'N/D'}`);
  lines.push(`- AVWAP SUP / RES / EVT: ${tech.autoAvwaps.length > 0 ? tech.autoAvwaps.map((a) => `${escapeMarkdownCell(a.label)}[${a.anchorDate ?? 'N/D'}]=${fmtUsd(a.value)} (${fmtPct(a.distanceSpotPct, true)})`).join(' | ') : 'N/D'}`);
  lines.push(`- POC / VAH / VAL (Perfil 1Y ${String(tech.volumeProfile1y.lookbackDays)}R): POC=${fmtUsd(tech.volumeProfile1y.poc)} (${fmtPct(Number.isFinite(tech.volumeProfile1y.poc) ? ((tech.volumeProfile1y.poc - tech.valuationSpot) / tech.valuationSpot) * 100 : Number.NaN, true)}) | VAH=${fmtUsd(tech.volumeProfile1y.vah)} | VAL=${fmtUsd(tech.volumeProfile1y.val)} | Overnight ON_POC=${fmtUsd(tech.overnightProfile.onPoc)} / ON_VAH=${fmtUsd(tech.overnightProfile.onVah)} / ON_VAL=${fmtUsd(tech.overnightProfile.onVal)}`);
  lines.push(`- Naked POC próximos: ${tech.nakedPocs.length > 0 ? tech.nakedPocs.map((n) => `${n.sessionDate}=${fmtUsd(n.price)} (${fmtPct(n.distanceSpotPct, true)})`).join(' | ') : 'N/D'}`);
  lines.push(`- POC 1Y: ${fmtUsd(tech.volumeProfile1y.poc)} (${escapeMarkdownCell(tech.volumeProfile1y.methodology)})`);
  lines.push(`- HVN / LVN relevantes: HVN=[${tech.volumeProfile1y.hvnPrices.length > 0 ? tech.volumeProfile1y.hvnPrices.map((p) => fmtUsd(p)).join(', ') : 'N/D'}] | LVN=[${tech.volumeProfile1y.lvnPrices.length > 0 ? tech.volumeProfile1y.lvnPrices.map((p) => fmtUsd(p)).join(', ') : 'N/D'}]`);
  lines.push(`- PDH / PDL / PMH / PML: PDH=${fmtUsd(tech.keyLevels.pdh)} | PDL=${fmtUsd(tech.keyLevels.pdl)} | PMH=${fmtUsd(tech.keyLevels.pmh)} | PML=${fmtUsd(tech.keyLevels.pml)}`);
  lines.push(`- Opening Range (Initial Balance 09:30–10:30 ET): IBH=${fmtUsd(tech.keyLevels.ibh)} | IBL=${fmtUsd(tech.keyLevels.ibl)} | Ancho=${fmtUsd(tech.keyLevels.ibWidth)} | Clasificación=${escapeMarkdownCell(tech.keyLevels.ibClassification)} (ORB 5m/15m separado: N/D no implementado)`);
  lines.push(`- FVG / IFVG activos: FVG=[${tech.activeFvgs.length > 0 ? tech.activeFvgs.map((f) => `${f.type === 'BULLISH_FVG' ? 'Bull' : 'Bear'} ${fmtNum(f.gapLow, 2)}-${fmtNum(f.gapHigh, 2)} USD (CE ${fmtNum(f.consequentEncroachment, 2)}, ${fmtPct(f.distanceSpotPct, true)})`).join(' | ') : 'Ninguno activo'}] | IFVG: N/D (no implementado) | Liquidity Sweeps: N/D (no implementado)`);
  lines.push(`- CVD aproximado (CLV): ${fmtNum(tech.cvdApprox.value, 0, true)} acc. (${tech.cvdApprox.bias} · ${escapeMarkdownCell(tech.cvdApprox.label)})`);
  lines.push('');

  // ## 2. Flujo y régimen GEX
  lines.push('## 2. Flujo y régimen GEX');
  lines.push('');
  lines.push(`- Régimen (Global): ${fg.regimeLabel} (${fg.regime}) | Posición vs Zero Gamma: ${fg.spotVsZeroGamma} (${fmtPct(fg.distanceToZeroGammaPct, true)}) | Señal estructura: ${fg.creditStrategySignal}`);
  lines.push(`- GEX global (${fg.engineExpirationDates.length > 0 ? fg.engineExpirationDates.join(',') : 'universo'}): Net=${fmtNum(fg.netGex, 0, true)} USD/1% | Call=${fmtNum(fg.callGex, 0, true)} USD/1% | Put=${fmtNum(fg.putGex, 0, true)} USD/1% (modelo teórico dealers calls +1 / puts -1 sobre OI T-1; no inventario real observado)`);
  lines.push(`- GEX por vencimiento seleccionado: ${s.meta.selectedExpirations.map((e) => {
    const fl = filtered.flowByExpiry[e];
    return `${e}: Net=${fmtNum(fl?.netGex ?? Number.NaN, 0, true)} USD/1% (${fl?.regime ?? 'NO_DATA'})`;
  }).join(' | ')}`);
  lines.push(`- Net VEX (Global): ${fmtNum(fg.netVex, 0, true)} USD delta/1% IV | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=${fmtNum(filtered.flowByExpiry[e]?.netVex ?? Number.NaN, 0, true)}`).join(' | ')}`);
  lines.push(`- Net CEX (Global): ${fmtNum(fg.netCex, 0, true)} USD delta/día | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=${fmtNum(filtered.flowByExpiry[e]?.netCex ?? Number.NaN, 0, true)}`).join(' | ')}`);
  lines.push(`- Call Wall / Put Wall (Global): ${fmtUsd(fg.callWallStrike)} / ${fmtUsd(fg.putWallStrike)} | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=${fmtUsd(filtered.flowByExpiry[e]?.callWallStrike ?? Number.NaN)}/${fmtUsd(filtered.flowByExpiry[e]?.putWallStrike ?? Number.NaN)}`).join(' | ')}`);
  lines.push(`- Zero Gamma (Global): ${fmtUsd(fg.zeroGammaSpot)} (${fg.zeroGammaStatus}) | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=${fmtUsd(filtered.flowByExpiry[e]?.zeroGammaSpot ?? Number.NaN)}`).join(' | ')}`);
  lines.push(`- Max Pain / Pin (Global): MaxPain=${fmtUsd(fg.maxPainStrike)} | CharmPin=${fmtUsd(fg.charmPinStrike)} | GEX/Charm Pin=${fmtUsd(fg.gexCharmPinStrike)} | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=MP ${fmtUsd(filtered.flowByExpiry[e]?.maxPainStrike ?? Number.NaN)} / Pin ${fmtUsd(filtered.flowByExpiry[e]?.charmPinStrike ?? Number.NaN)}`).join(' | ')}`);
  lines.push(`- Ratio P/C Vol / OI (Global universo completo): Vol=${fmtNum(fg.putCallRatioVol, 2)}x | OI=${fmtNum(fg.putCallRatioOi, 2)}x | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=Vol ${fmtNum(filtered.flowByExpiry[e]?.putCallRatioVol ?? Number.NaN, 2)}x / OI ${fmtNum(filtered.flowByExpiry[e]?.putCallRatioOi ?? Number.NaN, 2)}x`).join(' | ')}`);
  lines.push(`- Lotes negociados (Global universo completo): ${fmtNum(fg.totalLots, 0)} contratos | por vto: ${s.meta.selectedExpirations.map((e) => `${e}=${fmtNum(filtered.flowByExpiry[e]?.totalLots ?? Number.NaN, 0)}`).join(' | ')}`);
  lines.push(`- Flujo monetario (aprox. snapshot): ${fmtUsd(fg.netDirectionalPremiumUsd, 0, true)} (no cinta OPRA tick-a-tick)`);
  lines.push(`- Agresión / Delta Flow (aprox. snapshot): ${fg.aggressionDirection} (${fmtPct(fg.aggressionNetBiasPct, true)}, método=${fg.aggressionMethod ?? 'N/D'}) | Delta Flow=${fmtNum(fg.deltaFlowShares, 0, true)} acc. equiv.`);
  lines.push('');

  for (const expDate of s.meta.selectedExpirations) {
    const fl = filtered.flowByExpiry[expDate];
    lines.push(`### Perfil por Strike — ${expDate}`);
    lines.push('');
    if (fl?.windowStats && fl.windowStats.outOfWindowStructuralLevels.length > 0) {
      lines.push(`- Niveles estructurales fuera del recorte tabular: ${escapeMarkdownCell(fl.windowStats.outOfWindowStructuralLevels.join(' | '))}`);
      lines.push('');
    }
    lines.push('| Strike | Tag | Call OI | Put OI | Call Vol | Put Vol | Call GEX | Put GEX | Net GEX | VEX | CEX |');
    lines.push('|---:|:---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    const wRows = fl?.strikesWindow ?? [];
    if (wRows.length === 0) {
      lines.push('| N/D | — | N/D | N/D | N/D | N/D | N/D | N/D | N/D | N/D | N/D |');
    } else {
      for (const r of wRows) {
        lines.push(
          `| ${fmtNum(r.strike, 2)} | ${r.tags.length > 0 ? r.tags.join(',') : '—'} | ${fmtCountKnown(r.callOi, r.callOiKnown)} | ${fmtCountKnown(r.putOi, r.putOiKnown)} | ${fmtCountKnown(r.callVolume, r.callVolKnown)} | ${fmtCountKnown(r.putVolume, r.putVolKnown)} | ${fmtNum(r.callGex, 0, true)} | ${fmtNum(r.putGex, 0, true)} | ${fmtNum(r.netGex, 0, true)} | ${fmtNum(r.vex, 0, true)} | ${fmtNum(r.cex, 0, true)} |`,
        );
      }
    }
    lines.push('');
  }

  // ## 3. Volatilidad, cono y curva temporal
  lines.push('## 3. Volatilidad, cono y curva temporal');
  lines.push('');
  const primExp = s.meta.selectedExpirations[0] ?? '';
  const primVol = vol.byExpiry[primExp];
  lines.push(`- IV ATM (${primExp || 'N/D'}): ${fmtPct(primVol?.ivAtmPct ?? Number.NaN)} (fuente: ${primVol?.ivAtmSource ?? 'N/D'} | IV30d global: ${fmtPct(vol.iv30dPct)})`);
  lines.push(`- RV20 / RV60 / RV120: ${fmtPct(vol.rv20Pct)} / ${fmtPct(vol.rv60Pct)} / ${fmtPct(vol.rv120Pct)}`);
  lines.push(`- IV/RV20: ${fmtNum(primVol?.ivRv20Ratio ?? Number.NaN, 2)}x`);
  lines.push(`- VRP (${primVol?.vrpRvRefLabel ?? 'RV23d'}, dif. volatilidad IV - RV): ${fmtNum(primVol?.vrpPts ?? Number.NaN, 2, true)} pts`);
  lines.push(`- IV Rank / Percentile: ${fmtPct(primVol?.ivRank ?? Number.NaN)} (${escapeMarkdownCell(primVol?.ivRankSource ?? 'N/D')}) / ${fmtPct(primVol?.ivPercentile ?? Number.NaN)} (${escapeMarkdownCell(primVol?.ivPercentileSource ?? 'N/D')})`);
  lines.push(`- Skew 25Δ (IV_25P - IV_25C): ${s.meta.selectedExpirations.map((e) => {
    const ev = vol.byExpiry[e];
    return `${e}: ${fmtNum(ev?.skew25PutMinusCallPts ?? Number.NaN, 2, true)} pts [25P=${fmtPct(ev?.iv25PutPct ?? Number.NaN)} vs 25C=${fmtPct(ev?.iv25CallPct ?? Number.NaN)}]`;
  }).join(' | ')}`);
  lines.push(`- Expected Move ±1σ: ${s.meta.selectedExpirations.map((e) => {
    const ev = vol.byExpiry[e];
    return `${e}: ±${fmtUsd(ev?.em1SigmaUsd ?? Number.NaN)} (±${fmtPct(ev?.em1SigmaPct ?? Number.NaN)}; rango ${fmtNum(ev?.lower1Sigma ?? Number.NaN, 2)}–${fmtNum(ev?.upper1Sigma ?? Number.NaN, 2)} USD; straddle=${fmtUsd(ev?.emStraddleUsd ?? Number.NaN)})`;
  }).join(' | ')}`);
  lines.push(`- Expected Move ±2σ: ${s.meta.selectedExpirations.map((e) => {
    const ev = vol.byExpiry[e];
    return `${e}: ±${fmtUsd(ev?.em2SigmaUsd ?? Number.NaN)} (±${fmtPct(ev?.em2SigmaPct ?? Number.NaN)}; rango ${fmtNum(ev?.lower2Sigma ?? Number.NaN, 2)}–${fmtNum(ev?.upper2Sigma ?? Number.NaN, 2)} USD)`;
  }).join(' | ')}`);
  lines.push(`- Curva temporal: ${vol.termRegime} (spread largo-corto: ${fmtNum(vol.termSpreadPp, 2, true)} pp)`);
  lines.push(`- Colas Q vs P (vencimiento front = ${primVol?.qAndP.frontExpiryDate ?? 'N/D'}, ${Number.isFinite(primVol?.qAndP.frontDte ?? Number.NaN) ? `${String(primVol?.qAndP.frontDte)} DTE` : 'N/D'}): ${s.meta.mode === 'swing' ? '**Nota:** las densidades Q y P corresponden exclusivamente al vencimiento `front`, no al vencimiento Swing seleccionado salvo coincidencia explícita. ' : ''}Q(mean=${fmtUsd(primVol?.qAndP.qMean ?? Number.NaN)}, std=${fmtUsd(primVol?.qAndP.qStdDev ?? Number.NaN)}, skew=${fmtNum(primVol?.qAndP.qSkewness ?? Number.NaN, 2, true)}) | P(H=${String(primVol?.qAndP.pHorizonDays ?? 0)}d, n=${String(primVol?.qAndP.pSamples ?? 0)}, cola>3σ=${fmtPct(primVol?.qAndP.pTailFreqPct ?? Number.NaN)}, ON share=${fmtPct(primVol?.qAndP.pOvernightSharePct ?? Number.NaN)}) | ${primVol?.qAndP.comparableHorizon ? primVol.qAndP.comparisons.map((c) => `${escapeMarkdownCell(c.label)}(${fmtNum(c.price, 2)}): P=${fmtPct(c.probP * 100)} vs Q=${fmtPct(c.probQ * 100)} [${c.classification}]`).join(' ; ') : `Comparación Q vs P = N/D (${escapeMarkdownCell(primVol?.qAndP.note ?? 'horizonte no equivalente')})`}`);
  lines.push(`- Quintil actual: ${vol.currentQuintile ? `${escapeMarkdownCell(vol.currentQuintile.label)} (${escapeMarkdownCell(vol.currentQuintile.rangeLabel)}, n=${String(vol.currentQuintile.occurrences)}, Δvol+30d=${fmtNum(vol.currentQuintile.avgVolChange30dPts, 2, true)} pts, ret+30d=${fmtPct(vol.currentQuintile.avgUnderlyingReturn30dPct, true)}, prob. caída vol=${fmtPct(vol.currentQuintile.pctVolDecreased)})` : 'N/D'}`);
  lines.push(`- Estacionalidad del mes actual (${vol.currentMonthSeasonality?.monthLabel ?? 'N/D'}): ${vol.currentMonthSeasonality ? `ret. prom=${fmtPct(vol.currentMonthSeasonality.avgMonthlyReturnPct, true)}, vol=${fmtPct(vol.currentMonthSeasonality.annualizedVolPct)}, meses positivos=${fmtPct(vol.currentMonthSeasonality.positiveMonthRatePct)} (${String(vol.currentMonthSeasonality.monthsSampled)} años)` : 'N/D'}`);
  lines.push(`- Costo relativo de estructuras (BS2002): ${primVol && primVol.relativeStructureCosts.length > 0 ? primVol.relativeStructureCosts.map((c) => `${escapeMarkdownCell(c.name)}=${fmtPct(c.costPctOfMaxProfit)} del máx. beneficio (P${fmtNum(c.historicalPercentile, 0)} vs mediana ${fmtPct(c.historicalMedianPct)}, n=${String(c.obs)})`).join(' | ') : 'N/D'}`);
  lines.push('');
  lines.push('### Estructura temporal');
  lines.push('');
  lines.push('| Vto | DTE | IV ATM | EM 1σ USD | EM 1σ % | Skew | Calidad |');
  lines.push('|:---|---:|---:|---:|---:|---:|:---|');
  if (vol.termStructureTop6.length === 0) {
    lines.push('| N/D | N/D | N/D | N/D | N/D | N/D | NO_DATA |');
  } else {
    for (const pt of vol.termStructureTop6) {
      lines.push(`| ${pt.expirationDate} | ${String(pt.daysToExpiry)} | ${fmtPct(pt.ivAtmPct)} | ${fmtUsd(pt.em1SigmaUsd)} | ${fmtPct(pt.em1SigmaPct)} | ${fmtNum(pt.skew25Pts, 2, true)} pts | ${pt.quality} |`);
    }
  }
  lines.push('');

  // ## 4. Cadena de opciones unificada
  lines.push('## 4. Cadena de opciones unificada');
  lines.push('');
  lines.push(`- Filtro aplicado: ${s.meta.mode === 'intraday' ? 'Intraday (0.45 <= |delta| <= 0.85 + libro bilateral válido no cruzado)' : `Swing (${filtered.swingChainFilter ?? 'DELTA_005_055'} + libro bilateral válido no cruzado)`}`);
  lines.push('');

  for (const expDate of s.meta.selectedExpirations) {
    const ch = filtered.chainsByExpiry[expDate];
    const sampleRow = ch?.calls.rows[0] ?? ch?.puts.rows[0] ?? null;
    if (sampleRow) {
      lines.push(`- Metadatos contractuales ${expDate}: OPRA ejemplo=${escapeMarkdownCell(sampleRow.ticker)} | Estilo=${sampleRow.exerciseStyle} (${sampleRow.settlementType}) | Modelo=${sampleRow.valuationModel} | Multiplicador=${sampleRow.sharesPerContractKnown ? String(sampleRow.sharesPerContract) : 'N/D'} | Fuente quote=${sampleRow.quoteSource ?? 'N/D'}`);
      lines.push('');
    }
    lines.push(`### CALLS — ${expDate} (${String(ch?.calls.included ?? 0)}/${String(ch?.calls.totalAvailable ?? 0)})`);
    lines.push('');
    lines.push('| Strike | Bid | Ask | Mid | Spread USD | Spread % | Delta | Gamma | Theta | Vega | IV | Intrínseco | Valor Tiempo | Vol | OI | GEX | Distancia Spot % |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    lines.push(...renderChainTableRows(ch?.calls.rows ?? []));
    lines.push('');
    lines.push(`### PUTS — ${expDate} (${String(ch?.puts.included ?? 0)}/${String(ch?.puts.totalAvailable ?? 0)})`);
    lines.push('');
    lines.push('| Strike | Bid | Ask | Mid | Spread USD | Spread % | Delta | Gamma | Theta | Vega | IV | Intrínseco | Valor Tiempo | Vol | OI | GEX | Distancia Spot % |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    lines.push(...renderChainTableRows(ch?.puts.rows ?? []));
    lines.push('');
  }

  // ## 5. Spreads precalculados — Solo Swing
  lines.push('## 5. Spreads precalculados — Solo Swing');
  lines.push('');
  if (s.meta.mode === 'intraday') {
    lines.push('- Estado: Desactivado en modo Intraday (0DTE / 1DTE).');
    lines.push('');
  } else {
    for (const expDate of s.meta.selectedExpirations) {
      const sp = filtered.spreadsByExpiry[expDate];
      if (!sp) continue;
      lines.push(`- Estrategias habilitadas (${expDate}): ${sp.enabled ? 'Bull Put Spread, Bear Call Spread, Iron Condor' : `BLOQUEADAS (${escapeMarkdownCell(sp.disabledReason ?? sp.shortPremiumBreakerStatus)})`}`);
      lines.push(`- Filtros: anchos monetarios reales ${String(sp.widthFilterUsd.min)}–${String(sp.widthFilterUsd.max)} USD | top ${String(sp.candidates.length)} del ranking existente (sin reordenar ni crear combinaciones nuevas)`);
      lines.push(`- Candidatos evaluados / exportados: ${String(sp.evaluatedCount)} evaluados / ${String(sp.candidates.length)} exportados (excluidos por ancho USD=${String(sp.excludedCount)})`);
      if (sp.zeroGammaOperationalNote !== null) {
        lines.push(`- Aviso Zero Gamma / Short Gamma: ${escapeMarkdownCell(sp.zeroGammaOperationalNote)}`);
      }
      lines.push('');
      lines.push('| Estrategia | Vencimiento | Piernas | Ancho | Crédito Mid | Crédito Conserv. | Max Profit | Max Loss | Breakeven(s) | P(ITM) | R/B | Dist. BE vs EM | Liquidez |');
      lines.push('|:---|:---|:---|---:|---:|---:|---:|---:|:---|---:|---:|---:|:---|');
      if (sp.candidates.length === 0) {
        lines.push(`| Sin candidatos | ${expDate} | — | N/D | N/D | N/D | N/D | N/D | N/D | N/D | N/D | N/D | NO_DATA |`);
      } else {
        for (const c of sp.candidates) {
          lines.push(
            `| ${c.strategy} | ${c.expirationDate} | ${escapeMarkdownCell(c.legsSummary)} (x${String(c.contractMultiplier)}) | ${fmtUsd(c.widthUsd)} | ${fmtPremium(c.midCreditPerShare)} (${fmtUsd(c.midCreditContractUsd)}) | ${fmtPremium(c.conservativeCreditPerShare)} (${fmtUsd(c.conservativeCreditContractUsd)}) | ${fmtUsd(c.maxProfitContractUsd)} | ${fmtUsd(c.maxLossContractUsd)} | ${c.breakevens.length > 0 ? c.breakevens.map((b) => fmtNum(b, 2)).join(' / ') : 'N/D'} | ${fmtPct(c.pItmPct)} | ${fmtNum(c.riskRewardRatio, 2)}x | ${fmtNum(c.distBeVsEmSigma, 2)}σ | ${c.liquiditySemaphore} (${fmtPct(c.bidAskPctOfMid)}) |`,
          );
        }
      }
      lines.push('');
    }
  }

  // ## 6. Comparación de vencimientos — Si corresponde
  lines.push('## 6. Comparación de vencimientos — Si corresponde');
  lines.push('');
  if (filtered.expiryComparison.length < 2) {
    lines.push('- No aplicable (solo se seleccionó 1 vencimiento).');
    lines.push('');
  } else {
    lines.push('| Vencimiento | DTE | IV ATM | EM | Skew | GEX | Max Pain | Theta | Candidatos válidos | Crédito conservador | Riesgo |');
    lines.push('|:---|---:|---:|:---|---:|---:|---:|---:|---:|:---|:---|');
    for (const row of filtered.expiryComparison) {
      lines.push(
        `| ${row.expirationDate} | ${String(row.daysToExpiry)} | ${fmtPct(row.ivAtmPct)} | ±${fmtUsd(row.em1SigmaUsd)} (±${fmtPct(row.em1SigmaPct)}) | ${fmtNum(row.skew25Pts, 2, true)} pts | ${fmtNum(row.netGex, 0, true)} USD/1% | ${fmtUsd(row.maxPainStrike)} | ${fmtNum(row.atmThetaDaily, 4)} | ${String(row.validSpreadCandidates)} | ${row.bestSpreadSummary ? `${fmtUsd(row.bestConservativeCreditUsd)} [${escapeMarkdownCell(row.bestSpreadSummary)}, ancho ${fmtUsd(row.bestWidthUsd)}, x${String(row.bestMultiplier)}]` : 'N/D'} | ${row.bestSpreadSummary ? fmtUsd(row.bestRiskUsd) : 'N/D'} |`,
      );
    }
    lines.push('');
  }

  // ## 7. Procedencia y calidad
  lines.push('## 7. Procedencia y calidad');
  lines.push('');
  lines.push('| Bloque | Fuente | AsOf | Estado | Cobertura |');
  lines.push('|:---|:---|:---|:---|:---|');
  for (const p of integrity.provenanceTable) {
    lines.push(`| ${escapeMarkdownCell(p.block)} | ${escapeMarkdownCell(p.source)} | ${escapeMarkdownCell(p.asOf)} | ${p.status} | ${escapeMarkdownCell(p.coverage)} |`);
  }
  lines.push('');
  lines.push(`- Metodología de GEX: ${escapeMarkdownCell(integrity.gexMethodology)}`);
  lines.push(`- Metodología de volatilidad: ${escapeMarkdownCell(integrity.volatilityMethodology)}`);
  lines.push(`- Campos no disponibles: ${escapeMarkdownCell(integrity.unavailableFields.join(' ; '))}`);
  lines.push(`- Filas excluidas: ${escapeMarkdownCell(filtered.excludedRowsSummary.join(' ; ') || 'Ninguna')}`);
  lines.push(`- Limitaciones relevantes: ${escapeMarkdownCell(integrity.limitations.join(' ; '))}`);
  lines.push('');

  // ## 8. Gráficos adjuntos — Opcional
  lines.push('## 8. Gráficos adjuntos — Opcional');
  lines.push('');
  lines.push('- No incluidos en EXPORT-1 (la captura PNG aislada `chart_precio_niveles.png`, `chart_gex_por_base.png`, `chart_cono_smile.png` y el PDF diferido se habilitan en Pieza EXPORT-2).');
  lines.push('');

  const markdown = lines.join('\n');
  assertNoSecretsInExportText(markdown);

  const byteLengthUtf8 = new TextEncoder().encode(markdown).byteLength;
  return {
    markdown,
    byteLengthUtf8,
    exceedsTargetBudget: byteLengthUtf8 > TARGET_MARKDOWN_BUDGET_BYTES,
    targetBudgetBytes: TARGET_MARKDOWN_BUDGET_BYTES,
    truncationApplied: false,
  };
}
