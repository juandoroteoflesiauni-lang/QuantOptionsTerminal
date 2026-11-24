# Nota pendiente detectada durante el cierre de Pieza 0B

El servidor WS preexistente usa dos temporizadores: el general cada 100 ms y
el enfocado cada 50 ms. Ambos pueden emitir `market_batch` al cliente enfocado
(`src/server/httpWsServer.ts`, `flushGeneralMarketBatches` y
`flushFocusedMarketBatches`).

Una ejecución integral encontró 15 batches frente al máximo de 14 de
`tests/wsCoalescerAndStability.test.ts:283`. La repetición aislada posterior
pasó sus 9 tests sin cambiar el servidor ni las expectativas. Esta observación
queda registrada como un problema intermitente de la cadencia preexistente,
separado de los históricos REST de Pieza 0B.

La siguiente ejecución completa de `npm run verify` pasó 1294/1294 tests en
88 archivos, con exit code 0, incluido el coalescer. No se modificaron tests
legacy, timeouts ni código WS entre ambas ejecuciones.

Una eventual corrección debe ir en un commit separado:
`fix(ws): align general 10Hz and focused 20Hz cadence on single 50ms scheduler`.
La propuesta pendiente es usar un temporizador de 50 ms, emitir enfocado en
cada tick y general cada dos ticks, conservando deltas, eventos y backpressure.
Debe preservar `perfPhase1WsScopeAndBackpressure.test.ts`, los demás tests
legacy y sus límites de tiempo. Esta nota no implementa esa corrección ni
inicia Pieza 1 de Sub-fase 1.
