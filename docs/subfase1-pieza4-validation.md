# S1-8 — Validación de Pieza 4

Fecha de trabajo: 2026-11-25. Entorno exclusivo: `C:\dev\QuantOptionsTerminal-subfase1`, rama `subfase1/pieza2-s1-4`, base `12c471ddefddcdb0a17039e7d90eca48b34293a7`. Inicialmente sólo `?? .cache/`; dependencias físicas locales, sin junctions. No se abrió ni intervino el workspace principal. El gate final se registra al finalizar los comandos requeridos.

## Implementación y contratos

- `src/core/movingAverages.ts`: presets, overrides puros, ventanas VWMA inmutables, cálculo/serialización antes del recorte, fuente semanal nativa y proyección EMA20 causal. Algoritmos históricos EMA/SMA existentes sin modificaciones.
- Anillo indexado persistente de capacidad fija: cada confirmación copia únicamente el camino de profundidad acotada (5 para 9/21, 6/8 para ventanas SMA unitarias 50/200). Memoria activa O(n). Para los períodos soportados el costo ordinario es constante; para n arbitrario el camino sería O(log n). La reconstrucción VWMA cada 512 confirmaciones visita O(n), acotado a 9/21. La proyección no avanza ni resincroniza. Sumatorias Neumaier aproximadas en Number, sin promesa de exactitud binaria. Desbordamientos se reparan desde la ventana vigente durante confirmación, no durante ticks.
- SMA histórica reutiliza `computeSmaSeries` sobre todo el buffer. Live usa el núcleo de ventana con volumen unitario, sin duplicar el algoritmo histórico. La EMA live respeta la semilla SMA al alcanzar exactamente n observaciones.
- El DTO mantiene tiempos y valores alineados, semilla antes de la última barra y cola confirmada acotada a 200 observaciones. Los campos inválidos de esa cola estadística se codifican individualmente como null, conservando su posición y sin perder un close válido cuando sólo el volumen es inválido; no se inventa un precio. Semanal resamplea el buffer diario completo antes del recorte por semana de la primera diaria visible. AR sigue limitado a sus 1.250 ruedas realmente disponibles; no se inventan 199 semanas previas cuando no existen.
- `marketRuntime.ts`: campos aditivos `movingAverages`, `weeklyMovingAverages`, `ema20_5m`. La rama compacta recibe indicadores calentados aunque los campos legacy opcionales sigan vacíos. La rama completa reutiliza las mismas matrices, evitando recalcularlas. Massive 1D solicita su warm-up real; no cambia la política intradiaria de Pieza 0B.
- `usHistoricalService.ts`: conserva un único dueño de caché y los single-flights existentes. Preferencia: 5m válido cacheado, rollup exacto 1m, adquisición nativa 5m opcional. La clave existente ya separa proveedor/símbolo/sesión/ajuste/resolución; el intervalo solicitado y la generación de revisión completan la compatibilidad. TTL de cola 8 s y prefijo 15 min existentes. Minutos omitidos sin evidencia de no-negociación no se certifican: se usa fuente nativa o indisponibilidad. Páginas y requests son conteos de transporte, no equivalentes a adquisiciones lógicas.
- EMA20 5m exige 250 previas al primer punto visible, objetivo 300. Sólo contribuye un cierre <= cierre 1m y <= evaluación efectiva, que viaja explícitamente en el DTO. Recorrido de dos punteros O(N+M), normalización aparte. Faltantes elegibles, incluyendo el primer bucket de una nueva sesión, degradan a GAP. El calendario distingue noches/feriados/cierre anticipado de faltantes reales.
- `movingAverageRuntime.ts`: controlador del gráfico con transiciones estadísticas puras; snapshots acumulativos no se suman entre sí. El único bloque existente de rotación confirma una vez. El flush procesa confirmaciones encoladas para no descartar barras intermedias. Corrección tardía de la última confirmación restaura su prefijo inmutable y reemplaza esa confirmación desde la suscripción, fuera del flush. Revisiones arbitrarias/backfill/split/contexto reconstruyen al hidratar un nuevo bundle, fuera del live.
- Buffer live acotado del gráfico conserva ambas familias rápidas para cambiar EMA/VWMA sin perder puntos confirmados y sin recalcular indicadores ajenos. El efecto real sólo escribe los dos slots rápidos; opciones iguales no se reaplican a los otros slots.
- `maPresetsByTimeframe` usa memoria React exclusivamente. Preferencias separadas del estado estadístico, que se reconstruye por contexto. No se utiliza almacenamiento persistente externo. 4h preexistente preserva cuatro EMA; no se inventa una fila nueva del plan.
- Se mantienen 4 slots MA, 8 AVWAP y 1 VWAP; sólo se agrega 1 LineSeries EMA20 5m, `LineType.WithSteps` (enum 1 de LWC instalado 5.3.0). Las 14 secundarias excluidas del autoscale; velas únicas contribuyentes. Se conservan los 16 IPriceLine. La línea MTF recibe sólo confirmaciones: ticks provisionales no escriben en ella. Confirmación tardía usa historicalUpdate en su punto 1m correcto; no escribe información provisional en puntos pasados.
- `5m EMA20 (prov)` se calcula siempre desde la misma última base confirmada y vive únicamente en la leyenda/metadato. Sin base, cobertura o dato válido: null/—. Adquisición MTF opt-in separada del efecto REST ordinario, jamás por tick.

## Única ampliación legacy autorizada

`tests/yAxisAutoscaleProtection.test.ts`: total de LineSeries 13→14 (total de series 14→15), manteniendo un chequeo explícito de las trece originales y del nuevo slot escalonado. Se agrega el enum WithSteps al contexto que evalúa opciones reales. Los bucles originales de comportamiento se aplican ahora a las catorce series, usando la implementación instalada de LWC, y conservan ambos extremos USD/ARS y todos los IPriceLine. Ninguna aserción se debilita, ningún caso se elimina. Los demás tests legacy y lockfiles deben conservar sus hashes de preflight.

## Oráculo y evidencia

`tools/generate_ma_vwma_mtf_fixture.py` genera `fixtures/ma_vwma_mtf_reference.json`. Decimal de precisión 50 desde strings, ventanas directas independientes sin anillo incremental. EMA con semilla SMA explícita compatible con el contrato existente. Cuatro series USD/ARS/constante/inválidos de más de mil puntos; todos los valores de cada ventana y límites 511/512/513/1023/1024/1025, snapshots/revisión/confirmaciones coalescidas. Semanas derivadas independientemente de 2.300 observaciones diarias, y SMA antes del recorte. Cinco escenarios MTF: objetivo, mínimo, insuficiente, apertura y cierre efectivos, revisión/deduplicación, futuro extremo/NaN, provisional; pruebas de feriados y cierre anticipado independientes.

Métricas reales y logs se conservan localmente en `.cache/pieza4-*` y no forman parte del commit. No son un ensayo de mercado en vivo ni una aceptación visual del usuario.

## Límites y cierre

Una cola de datos insuficiente o un intervalo ausente conserva NaN/null y no se presenta como completo. La disponibilidad de un período en la UI no garantiza profundidad de un instrumento particular. No se amplían fuentes de datos ni se mezclan regímenes de ajuste. La validación visual del usuario queda pendiente; Sub-fase 2 BLOQUEADA. No hay push ni integración al workspace principal.

## Gate final observado

Estado: PASS técnico. Validación visual del usuario pendiente.

| Validación | Exit | Resultado |
|---|---:|---|
| Generador Python (dos ejecuciones) | 0 / 0 | Fixture idéntico |
| SHA-256 | 0 | Igualdad exacta |
| npm run typecheck | 0 | PASS |
| npm --prefix web run typecheck | 0 | PASS |
| npm --prefix web run build | 0 | PASS, 2616 módulos, sin advertencias |
| Auditoría opciones | 0 | 6/6, 1 suite |
| npm run verify | 0 | 1497/1497, 95/95 suites, sin omitidos |

Todos ejecutados exclusivamente desde el worktree indicado. El lint final está incluido en verify, con exit 0; el lint de desarrollo anterior detectó un campo faltante en el tipo del fixture nuevo, corregido antes del gate final. No se modificó ningún test legacy para resolver fallos.

SHA-256 primera generación: `9B775D377E5DA89738E3B4D06959053B623B120B74DD2C7AAF3ACAD98354A3CB`.

SHA-256 segunda generación: `9B775D377E5DA89738E3B4D06959053B623B120B74DD2C7AAF3ACAD98354A3CB`.

Hashes de bytes locales reproducibles; Git normaliza CRLF/LF al almacenar el blob.

| Algoritmo S1-8 | Máximo error absoluto observado | Tolerancia |
|---|---:|---:|
| EMA | 4.3655745685100555e-10 | 1e-9 |
| SMA50 | 2.9103830456733704e-11 | 1e-9 |
| SMA200 | 2.9103830456733704e-11 | 1e-9 |
| VWMA9 | 1.4551915228366852e-11 | 1e-9 |
| VWMA21 | 1.4551915228366852e-11 | 1e-9 |
| VWMA_provisional | 1.4551915228366852e-11 | 1e-9 |
| MTF_EMA20 | 1.1368683772161603e-13 | 1e-9 |
| MTF_EMA20_provisional | 5.6843418860808015e-14 | 1e-9 |

Suite nueva: 32/32 tests. Se comparan todas las ventanas de 4.750 observaciones USD/ARS y 461 semanas obtenidas de 2.300 diarias, 108 casos de snapshots intravela, cinco escenarios MTF con revisiones independientes, y confirmaciones/correcciones coalescidas. Deriva máxima VWMA en series largas: 1.4551915228366852e-11. Contaminación futura y cambio de la línea por ticks provisionales: 0 en las pruebas diferenciales ejecutadas.

Instrumentación: 10.000 proyecciones, máximo 21 lecturas de estado/anillo por tick, 0 avances y 0 resync durante esos ticks. Flujo real de confirmaciones encoladas: dos confirmaciones, ninguna duplicada, 0 setData; corrección autoritativa posterior conserva el contador. El efecto real del selector escribe sólo los dos slots rápidos. Adquisición Massive concurrente: 1 adquisición lógica / 3 páginas HTTP; caché caliente 0 requests, rollup exacto 0 requests extra, rollup incompleto deriva a 3 páginas nativas reales. Estos conteos provienen del transporte offline instrumentado, no de credenciales ni mercado productivo.

Blindaje instalado LWC: 14/14 secundarias excluidas, 1 contribuyente de eje, 16 IPriceLine persistentes, sin recreaciones ni duplicados. La comprobación ejecuta las opciones efectivas y la implementación instalada; no sustituye la aceptación visual.

Se verificaron hashes de los 94 archivos legacy: sólo cambió la excepción autorizada de autoscale. Ambos lockfiles, `GgalDualChartView.tsx` y `SyncedLowerPaneChart.tsx` coinciden con HEAD. Estado previo al staging: los 16 paths propios de S1-8 y `.cache/` preexistente; índice inicialmente vacío. No se incluye `.cache/`, dist, node_modules ni archivos ajenos.

## Inventario del commit

| Path | Finalidad |
|---|---|
| `SPEC.md` | Contrato aprobado S1-8 |
| `src/core/movingAverages.ts` | Motor puro y DTO |
| `src/server/marketRuntime.ts` | MA calentadas y MTF aditivo |
| `src/server/usHistoricalService.ts` | Reutilización/adquisición nativa single-flight |
| `src/server/httpWsServer.ts` | Opt-in aditivo ema20_5m |
| `src/server/argentinaMarketLoader.ts` | Profundidad AR diaria/semanal real |
| `web/src/data/liveRuntimeBridge.ts` | Opción y clave de request MTF |
| `web/src/data/liveTypes.ts` | DTO aditivo compartido |
| `web/src/components/StockDetailView.tsx` | Controles, slots e integración incremental |
| `web/src/components/stock-detail/stockDetailTypes.ts` | Bundle aditivo |
| `web/src/components/stock-detail/movingAverageRuntime.ts` | Estado y buffer acotados del gráfico |
| `tools/generate_ma_vwma_mtf_fixture.py` | Oráculo independiente |
| `fixtures/ma_vwma_mtf_reference.json` | Referencia Decimal reproducible |
| `tests/movingAveragePresetsVwmaMtf.test.ts` | 32 tests nuevos |
| `tests/yAxisAutoscaleProtection.test.ts` | Ampliación aditiva autorizada |
| `docs/subfase1-pieza4-validation.md` | Evidencia y límites |

## Historia acumulada verificada

| Pieza | Commit | Tests de su cierre |
|---|---|---:|
| 1 | 89a05fb7e661e6b58c78d7945791f3f45a393c81 | 1305 |
| 2 S1-4 | c299b5b1eb615b43ca9caed842b3cc7459e09352 | 1320 |
| 3 S1-5/6/7 | 12c471ddefddcdb0a17039e7d90eca48b34293a7 | 1465 |
| 4 S1-8 | Este commit atómico | 1497 |

Los tres commits previos son ancestros comprobados de la rama. Total acumulado vigente: 1497 tests distintos de la suite principal; los conteos de cierres anteriores no se suman entre sí. Auditoría separada de opciones: 6/6.

## Checklist de aceptación visual del usuario (pendiente)

- [ ] Preset correcto en 1m.
- [ ] Preset correcto en 5m.
- [ ] Preset correcto en 15m.
- [ ] Presets SMA correctos en 1H, 1D y 1W.
- [ ] Selector EMA/VWMA funcional.
- [ ] Overrides independientes al alternar timeframes.
- [ ] SMA válida desde la primera barra visible cuando existe warm-up suficiente.
- [ ] Toggle EMA20 5m exclusivamente en 1m.
- [ ] Línea EMA20 visualmente escalonada.
- [ ] Provisional actualizado sin modificar la línea confirmada.
- [ ] Sin compresión del eje Y por indicadores distantes.
- [ ] Sin flicker, duplicados ni recreaciones visuales.
- [ ] AVWAP canónico mensual intacto.
- [ ] Auto-AVWAP Institucional intacto.
- [ ] Niveles de sesión intactos.
- [ ] Max Pain y demás niveles persistentes intactos.
- [ ] Navegación, zoom y cambios de timeframe sin regresiones.

Verificación final tras la corrección de semillas por campo: 95/95 suites, 1497/1497 tests, exit 0; 27.99 s de duración Vitest y 144.79 s de tiempo agregado de tests. La ejecución anterior también pasó (1496 tests), antes de agregar el test independiente de cierre válido/volumen inválido. Se repitieron root/web typecheck, build y auditoría después del cambio; todos exit 0. No se modificó código después de esta última verificación.
