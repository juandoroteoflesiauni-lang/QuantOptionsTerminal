# Pieza 2 · S1-4 · AVWAP Inicio Mes

Baseline: `89a05fb7e661e6b58c78d7945791f3f45a393c81` (1305 tests).
Alcance exclusivo: S1-4. No se implementan S1-5/6/7 ni Sub-fase 2.

## Datos y matemática

Se reutiliza `UsHistoricalService.canonicalMonth` y su caché, paginación,
single-flight, cancelación y segregación de proveedores. No hay un segundo
almacén histórico. El motor puro crea checkpoints efímeros sobre esos datos.
El DTO contiene puntos de la resolución solicitada y dos estados compactos;
no retransmite el buffer canónico completo.

Se agregan `combineWelfordStates` (Chan ponderado) y `welfordFromSeed`.
`updateWelford`, `getWelfordOutput` y los demás cálculos legacy no se cambian.
El repositorio usa `getWelfordOutput` para sigma; no existe una función llamada
`welfordStdDevPop`. El nuevo motor centra los precios antes de llamar la misma
recurrencia Welford, lo que evita acumular errores sobre el nivel ARS 80000.
`seedMean/seedM2` son autoritativos; `seedP2V` es únicamente auditable.

El prefijo y la continuación son disjuntos, con corte en el primer minuto del
buffer de cálculo local del mes, nunca en el viewport. El servidor proyecta
todas las resoluciones desde una sola secuencia de checkpoints. La continuación
pura desde semilla se valida en distintas particiones del mismo histórico.
No se acumulan los precios de velas superiores para reconstruir el canónico.

El oráculo `tools/generate_avwap_canonical_fixture.py` usa Decimal con 50 dígitos,
sumas exactas ponderadas independientes de Welford y una auditoría separada de
varianza en dos pasadas. Genera seis escenarios y 26585 filas de entrada,
con todos los cierres de 1m y sus equivalentes en 5m/15m/1H. Incluye feriado en
el día 1, primer día hábil, marzo/noviembre DST, cierre anticipado, cero volumen,
VW fuera de OHLC, proxies HLC3, mezclas, picos y precios altos de dispersión mínima.

Máximos medidos contra Python (centro, +1σ, -1σ, +2σ, -2σ):
`1.4551915228366852e-11`, `1.4551915228366852e-11`,
`1.4551915228366852e-11`, `2.9103830456733704e-11`,
`1.4551915228366852e-11`. Todos son <= 1e-9.
En 238940 comparaciones finitas, error absoluto y relativo entre marcos: 0.
Esto satisface también el criterio absoluto < 1e-12 del plan, sin relajar
el umbral monetario <= 0.02. Se comparan las cinco curvas en todos los cierres.

## Cobertura y coherencia

La completitud se demuestra sobre la rejilla de minutos elegibles del calendario
NYSE ya verificado 2020–2028, no a partir de dos extremos. No se rellenan huecos.
Una ausencia fuera de sesión, un feriado o un cierre reglamentario no cuenta
como hueco. Si no es posible distinguir un minuto sin operaciones de un dato
ausente, se conserva una clasificación parcial. HLC3 puede tener cobertura
temporal completa; procedencia y cobertura se exponen por separado.

El diario AR/BYMA se entrega como `APPROX_AGGREGATED` y HLC3, sin agregar llamadas
Data912 ni inventar prefijos. Fuentes agregadas de otros caminos nativos también
se declaran aproximadas; sin datos utilizables se entrega `UNAVAILABLE`.
El alcance canónico demostrado es 1m/5m/15m/1H con observaciones equivalentes.
El camino semanal legacy se conserva y no se presenta como canónico 1m.
La varianza es de precios de barras 1m, no de cada operación individual.

El mismo dueño histórico registra generaciones por símbolo, acotadas a 16,
y las incorpora a `adjSig` y a la identidad del DTO cacheado. Cambios observados
en OHLC/VW/volumen invalidan entradas y vuelos incompatibles del símbolo.
La edad del prefijo de 15 minutos se conserva aunque la cola se refresque.
Las revisiones fuera del rango observado no se adivinan: se detectan cuando el
proveedor las devuelve en el solapamiento o en la recarga completa del prefijo.
FMP sigue identificado como `FMP_NATIVE_UNVERIFIED`; no se presume igualdad
de sus ajustes con Massive `SPLIT_ADJUSTED`.

## Frontend y live

`MONTH_START` consume exclusivamente el DTO cuando es utilizable. Los demás
modos conservan las funciones y slots legacy, incluida una sola llamada Auto
a `computeAnchoredVwapWithAnchor`. El aviso mensual solo se oculta si la calidad
es `COMPLETE_CANONICAL_1M`. Los valores null siguen el renderizado sin dato.

El estado live tiene tamaño constante. `formingBar` acumulativa reemplaza la
contribución provisional; `lastClosedBar` añade solo minutos nuevos posteriores
al checkpoint REST. Nunca se suma repetidamente el volumen del mismo snapshot.
Quotes no inventan volumen ni confirman cierres; si no hay minuto autoritativo,
se conserva el último estado conocido hasta recibirlo. Símbolo, TF, ancla, mes
y ajuste/generación reinicializan el estado incompatible. Cinco updates escalares
pintan centro/bandas sin setData, sin recomputar historia ni prefijo.

Los tests ejecutan los callbacks reales `flushLiveTick` y `paintFormingBar`
extraídos por AST, con Chart API mock: 0 llamadas a setData y 5 updates por evento.
Se verifica además el estado tras snapshots repetidos y confirmación posterior.
La medición CPU usa 1000 eventos con estados derivados de 500 y 5000 barras:
el estado mantiene 15 campos y ningún array histórico. Es una medición local
del motor y un mock de Chart API; no equivale a un benchmark de proveedor ni
a una sesión completa del navegador.

Artefacto de métricas reproducible: `.cache/pieza2-canonical-metrics.json`.
No se abren conexiones reales a proveedores ni sockets Massive.

## Gate de cierre en worktree aislado: PASS

Autorización explícita posterior: aislar S1-4 sin modificar el workspace principal.
Worktree: `C:\dev\QuantOptionsTerminal-subfase1`.
Rama: `subfase1/pieza2-s1-4`, creada desde el baseline indicado.
Dependencias resueltas con junctions a node_modules raíz y web ya instalados;
no se copiaron archivos .env ni se instalaron dependencias nuevas.

Se transfirieron 12 archivos exclusivos y solo los hunks canónicos de
StockDetailView.tsx/liveTypes.ts. La revisión detectó además campos concurrentes
de opciones en marketRuntime.ts y los excluyó: quedaron solo sus seis hunks S1-4.
No se transfirieron archivos del exportador, módulos de opciones, su caché de
barras ni cambios de vite.config.ts. Los tests legacy y fixtures previos
permanecen idénticos al baseline. updateWelford/getWelfordOutput se preservaron.

Validación del 24/11/2026 ART sobre el diff productivo definitivo:

| Comando | Exit code | Resultado |
|---|---:|---|
| npm run typecheck | 0 | PASS |
| npm --prefix web run typecheck | 0 | PASS |
| npm --prefix web run build | 0 | PASS |
| node node_modules/vitest/vitest.mjs run --config tools/vitest.options-audit.mts | 0 | 6/6 PASS |
| python tools/generate_avwap_canonical_fixture.py + SHA-256 antes/después | 0 | Reproducible |
| npm run verify | 0 | 91/91 suites, 1320/1320 tests PASS |

La suite completa terminó en 32.51 s; suma de tiempos de tests: 164.65 s.
Incluye guardias 50.7, StockDetail, Auto, Perf-1/2/3, WS, 0B y Pieza 1.
No se elevaron timeouts, modificaron aserciones ni omitieron tests.
Después del gate solo se actualizó este informe y se realizó staging/commit.
Salida literal completa: `.cache/pieza2-verify.log` del worktree aislado.
SHA-256 del log: `9EC9F645BEF4BBE18B9610AEF18AD14F881BB90B9BE18B52A3E327B1214CF181`.

Fixture reproducible SHA-256:
`C17D96BF8705734F5CC3923EDE77D77583B1937535995E9ACAA39793F1763162`.
Las métricas matemáticas anteriores se reprodujeron durante verify.
Live: 0 setData, cinco updates/evento, snapshots reemplazados; cero descargas
redundantes del prefijo con caché válida en Massive y FMP. TTL independiente
comprobado: refrescar la cola no prolonga la vida del prefijo cerrado.
Medición local de 1000 eventos: 218.2447 ms desde 500 barras y 178.4666 ms desde
5000 barras; 15 campos en ambos estados, sin arrays históricos ni umbral temporal
artificial. Estos tiempos no son un benchmark integral de navegador/proveedor.

El workspace principal no recibió escrituras, staging ni reversiones de este
trabajo. Los cuatro archivos protegidos conservaron sus hashes iniciales.
Se registraron 107 archivos antes del aislamiento. Antes de iniciar Vitest
completo aquí se observaron cambios concurrentes de métricas en dos archivos
.cache del principal (21:17), que no se restauraron ni se tocaron. Todas las
validaciones de este cierre se ejecutaron en el worktree y sus propios reportes.
No se incorpora ninguna .cache al commit ni se altera su exclusión global.

Sin bloqueos pendientes para S1-4. Permanecen las limitaciones de cobertura,
metodología y calendario documentadas arriba. El worktree queda disponible con
su rama y dependencias para continuar únicamente tras autorización explícita.
No se inició Pieza 3 ni Sub-fase 2; no se ejecutó push.
