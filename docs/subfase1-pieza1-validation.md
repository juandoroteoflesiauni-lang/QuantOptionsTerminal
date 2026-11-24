# Sub-fase 1 · Pieza 1

Baseline: `9c8ca5d7f6d18d112d34f19d9d390312f1a8dcfc` (0B), con sus
contratos de proveedores, segmentación y procedencia preservados.

| TF | EXTENDED nominal | RTH nominal |
|---|---:|---:|
| 1m | 2880 (3 ruedas) | 1950 (5 ruedas) |
| 5m | 4224–4416 (22–23 ruedas) | 1716–1794 (22–23 ruedas) |
| 15m | 2560 (40 ruedas) | 1040 (40 ruedas) |
| 1h | 1000 | 1000 |
| 1D | 1250 | 1250 |

`visibleBars` explícito prevalece; el resolver no agrega warm-up. El planificador
mantiene las 1000 barras previas y separa el tramo visible por sesiones mediante
`visibleFrom`. Cierres anticipados y barras ausentes no se rellenan con barras de
otras ruedas. En el mock de RTH posterior al cierre reducido de 2025-11-28,
el visible real es 1770 frente al nominal 1950; con negociación discontinua es
590 y el warm-up insuficiente se declara. La caché caliente evita llamadas HTTP.
El histórico diario nativo permite consultar fechas previas a 2020 sin extender
ni inventar el calendario intradiario.

S1-2 SIN CAMBIOS — optimización no justificada por compatibilidad legacy.
El candidato de 14/28 días, evaluado mediante el override existente, reduce
requests, pero rompe `tests/pieza44GgalDlrFixes.test.ts:188`: el fixture exige
33 ventanas de 14 días en `15m` y recibe 16 de 28 días. Se descartó el cambio
de constantes; producción conserva 7/14 días sin cambiar el test ni su fixture.
Los cuatro mocks del candidato, con límite de 5000 filas, conservan exactamente
la unión ordenada, cobertura, volumen y deduplicación de bordes:

| TF / sesión | Requests vigentes | Requests candidato descartado | Barras recuperadas |
|---|---:|---:|---:|
| 5m EXT | 9 | 4 | 7104 |
| 5m RTH | 11 | 5 | 3510 |
| 15m EXT | 8 | 4 | 4288 |
| 15m RTH | 10 | 5 | 2392 |

Referencia independiente: `tools/generate_subfase1_pieza1_reference.py` produce
108 presupuestos, 72 planes, 40 zooms y 4 escenarios de paginación; reutiliza
como datos el calendario generado por el oráculo Python verificado de 0B.
Las operaciones de conteos, timestamps e índices son enteras exactas.

Los mocks ejecutan los callbacks reales de carga REST y de hidratación de
`StockDetailView` extraídos mediante AST, verificando cancelación/generación,
invocaciones de la Chart API y ausencia de reinicios ante correcciones del
histórico. No representan una medición de renderizado React completo.

`tools/pieza1_browser_check.mts` reutiliza Playwright/Chrome local y el build
instalado de Lightweight Charts. El canvas real confirma el rango inicial
`2730..2882` para 2880 barras y preserva el rango manual `2000..2152` ante
tick, nueva vela, toggle y corrección histórica. Es una comprobación aislada
del chart en Chromium, sin conexión a proveedores ni recorrido de toda la app.
Los perfiles HTTP y de latencia son mocks, no mediciones de proveedores reales.
Artefactos reproducibles locales: `.cache/pieza1-*-metrics.json`,
`.cache/pieza1-browser-viewport.json` y `.cache/pieza1-browser-viewport.png`.

Archivos protegidos (solo inspección; hashes iniciales preservados):

- `GgalDualChartView.tsx`: renombra CVD como aproximación CLV y agrega badge/tooltip de estimación por barras; ajuste de zoom diferido.
- `SyncedLowerPaneChart.tsx`: renombra el modo CVD como aproximación CLV y agrega el mismo badge/tooltip.

No se implementan S1-4/AVWAP mensual, las restantes piezas ni Sub-fase 2.

Gates finales: suites nuevas 11/11; histórico legacy 20/20 intacto; auditoría
de opciones 6/6 intacta; typecheck raíz/web y build web con exit code 0;
`npm run verify` 1305/1305 en 90 archivos, exit code 0 (42.84 s de duración,
206.51 s acumulados de tests). El fixture regenerado conserva SHA-256
`F3605200EB9AABA8127F248E97DB1CFE02B0BDFB0A290C52771EBF779BC98B4A`.
Los presupuestos estructurales de Perf-3 pasan: Worker 23.82 kB, chunk Detalle
114.76 kB y runtime compartido 253.06 kB en el build local (tamaños sin gzip).
