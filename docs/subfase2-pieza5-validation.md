# S2-1 + S2-2 — Validación de Pieza 5 (Sub-fase 2)

Fecha de trabajo: 2026-11-25. Entorno aislado: `C:\dev\QuantOptionsTerminal-subfase1`, rama `subfase1/pieza2-s1-4`, base `d68679e175d37750dd2f0d33228531139a3e67f4`.
Pieza 6 (`S2-3` · Liquidity Sweeps y FVG/IFVG) permanece **BLOQUEADA**.

## Implementación y contratos

- **`src/core/microstructure/multiHorizonVolumeProfile.ts` (`S2-1` + `S2-2`):**
  - Motor 100 % puro sin red, sin UI y sin mutación de argumentos; preserva intacto `src/core/microstructure/volumeProfileAmt.ts`.
  - Reutiliza `priceToBinIndex`, `selectPocIndex`, `expandValueAreaIndices`, distribución uniforme `bar.volume / countBins` en `[bar.low, bar.high]` y escalado entero bajo `MAX_PROFILE_BINS = 4_000`.
  - Horizontes agregados por rueda efectiva (`sessions.ts` + calendario NYSE 2020–2028 de `usHistorical.ts` con feriados, cierres anticipados `13:00 ET` y DST):
    - `1D`: 1 rueda efectiva desde `1m`; actualización incremental $O(B_{\text{bar}})$ al cerrar barra `1m`.
    - `5D`: últimas 5 ruedas efectivas desde `1m` (4 cerradas inmutables cacheadas + `1D` viva).
    - `20D`: últimas 20 ruedas efectivas desde `5m` (19 cerradas inmutables cacheadas + sesión actual; actualización únicamente al cerrar barra `5m`).
    - `252R`: últimas 252 ruedas efectivas cerradas desde `1D` (`1Y · 252R`), reutilizando el perfil `252R` existente de `/api/snapshot`.
  - Invariantes verificadas: conservación exacta `|Σ binVol - totalVolume| <= 1e-9 * max(1, totalVolume)`, procedencia explícita `methodology: 'OHLCV_UNIFORM_BIN'` (`VP (OHLCV uniforme)` en UI), y degradación honesta `UNAVAILABLE` (`NaN` / `null`) cuando faltan ruedas acreditadas (ej. AR/BYMA sin intradiario).
  - `detectVolumeProfileNodes`: recorte al soporte activo `[i_min, i_max]` (cero bins exteriores clasificados), suavizado topológico simétrico `[1,2,3,2,1]/9` con bordes reflejados reportando siempre volumen crudo $V_i$, máximos locales `HVN` (`w ∈ [2, 12]`, `S_i/S_poc >= 0.35`, prominencia `>= 0.15 * S_poc`, expansión `>= 0.75 * S_{i*}`, fusión a `<= 1` bin), valles `LVN` interiores flanqueados (`S_peak >= 0.30 * S_poc`, `S_i/min(peakL,peakR) <= 0.35`) + consolidación de gaps internos (`V = 0`) con `isPriceGap: true`, separación mínima `>= w` bins, ranking por prominencia y cercanía al precio de referencia, y tope `3 HVN + 3 LVN` (`nodesMethodology: 'OHLCV_UNIFORM_SMOOTHED_PROMINENCE'`).
- **Backend (`usHistoricalService.ts`, `marketRuntime.ts`, `argentinaMarketLoader.ts`, `httpWsServer.ts`):**
  - `DailySessionHistogramCache` LRU acotada (512 entradas) con invalidación automática ante cambio de `adjustmentRevision` o revisión OHLCV observada en sesiones cerradas.
  - Reutilización de barras `1m`/`5m` cacheadas en `UsHistoricalService.resolveVpIntradaySources` con cero requests HTTP redundantes y sin abrir Massive WS `/stocks` ni `/futures`.
  - Exposición JSON-safe `volumeProfilesByHorizon` en `/api/snapshot`, `/api/bars` (US y AR) y `/api/ar/stock`.
- **Frontend (`PanoramicBandsPrimitive.ts`, `StockDetailView.tsx`, `stockDetailTypes.ts`, `liveTypes.ts`, `liveRuntimeBridge.ts`):**
  - `PanoramicBandsPrimitive` implementando `ISeriesPrimitive<Time>` con **`autoscaleInfo(): null`**, bandas `HVN` (`rgba(56, 189, 248, 0.09)`) y `LVN` (`rgba(245, 158, 11, 0.08)`).
  - Selector de horizonte `1D | 5D | 20D | 1Y · 252R` y toggle independiente `HVN/LVN` exclusivamente en memoria de sesión (cero `localStorage`), actualizando in-place los slots `IPriceLine` (`POC/VAH/VAL`) y bandas sin `setData()` ni recálculo en `flushLiveTick`.

## Oráculo independiente y reproducibilidad

- Generador: `tools/generate_multi_horizon_vp_nodes_fixture.py` (`Decimal(prec=50)`, `zoneinfo.ZoneInfo("America/New_York")`).
- Fixture: `fixtures/multi_horizon_vp_hvn_lvn.json`.
- SHA-256 corrida 1: `E745F71EACC718A4B06689F07AA771F5D33CBD5909B05FF81A70605B9BA48BCE`
- SHA-256 corrida 2: `E745F71EACC718A4B06689F07AA771F5D33CBD5909B05FF81A70605B9BA48BCE`
- Paridad medida `<= 1e-9` en todas las métricas de `1D`, `5D`, `20D`, `252R`, empates POC/VA, escalado `MAX_PROFILE_BINS = 4_000` y los 9 escenarios topológicos `HVN`/`LVN`.

## Gate de validación observado

| Validación | Exit | Resultado |
|---|---:|---|
| Generador Python (2 corridas) | 0 / 0 | SHA-256 idéntico |
| `npm run typecheck` | 0 | PASS |
| `npm --prefix web run typecheck` | 0 | PASS |
| `npm --prefix web run build` | 0 | PASS (`2619` módulos, `1.02s`, sin advertencias) |
| Auditoría de opciones (`vitest.options-audit.mts`) | 0 | `6/6` PASS (1 suite) |
| `npm run verify` | 0 | `97/97` suites, `1514/1514` tests PASS (incluye `multiHorizonVolumeProfile.test.ts` `4/4`, `volumeProfileNodesHvnLvn.test.ts` `11/11`, `yAxisAutoscaleProtection.test.ts` `7/7`) |

## Preservación de guardas y archivos protegidos

- Intactos sin cambios respecto a `HEAD`: `src/core/microstructure/volumeProfileAmt.ts`, `web/src/components/ggal/GgalDualChartView.tsx`, `web/src/components/stock-detail/SyncedLowerPaneChart.tsx`, `package.json`, `package-lock.json`, `web/package.json`, `web/package-lock.json`, y todos los tests legacy salvo la ampliación aditiva en `tests/yAxisAutoscaleProtection.test.ts` (que conserva intactas todas sus aserciones originales y valida `PanoramicBandsPrimitive.autoscaleInfo() === null` contra `SeriesPrimitiveWrapper` + `Series` de LWC 5.3.0).

## Checklist visual pendiente (usuario)

- [ ] Selector `1D | 5D | 20D | 1Y · 252R` y etiqueta `VP (OHLCV uniforme)` visibles en la barra de `PanoramicPriceChart`.
- [ ] Toggle independiente `HVN/LVN` enciende/apaga las bandas sin ocultar `POC/VAH/VAL`.
- [ ] Eje Y derecho inalterado ante bandas HVN/LVN distantes o zoom/pan.
- [ ] Degradación `n/d` honesta en símbolos AR/BYMA para horizontes intradiarios.
