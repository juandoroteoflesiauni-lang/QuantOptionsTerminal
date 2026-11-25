# Pieza 3 · S1-5 / S1-6 / S1-7 · Validación

Estado: PASS — PIEZA 3 CERRADA tras gate completo; commit exclusivo autorizado.
Validación final: 25/11/2026 ART. No se inició S1-8 ni Sub-fase 2; sin push.

## Aislamiento

Único worktree utilizado: C:\dev\QuantOptionsTerminal-subfase1.
Rama conservada: subfase1/pieza2-s1-4.
HEAD inicial: c299b5b1eb615b43ca9caed842b3cc7459e09352.
Estado inicial: únicamente ?? .cache/; ningún archivo staged.

Las dos junctions heredadas se desvincularon mediante Directory.Delete(path,false),
comprobando previamente ambos reparse points y sin recorrer sus destinos.
`npm ci` y `npm --prefix web ci`, con caché explícita dentro de .cache/npm,
terminaron con exit 0. Las dependencias resuelven físicamente dentro del worktree.
Ambos lockfiles conservan sus hashes de preflight y permanecen iguales a HEAD.
No se inspeccionó ni se ejecutaron comandos dirigidos al workspace principal.
Las operaciones de archivos, generación, compilación, tests y staging de esta
pieza quedan dentro del worktree autorizado; Git usa solo sus metadatos compartidos.
No se cambió de rama, creó otro worktree, hizo merge/rebase/cherry-pick ni push.

## S1-6: datos, cobertura y causalidad

Una única implementación pura construye seis ventanas acotadas desde intervalos
fuente ya descargados: PD, PM, OR5, OR15, OR30 y un checkpoint RTH para rollover.
UsHistoricalService entrega referencias efímeras a esos intervalos originales,
sin nuevo caché, nuevas descargas ni modificación de monthStartCanonicalAvwap.
El uso de fuentes anteriores al rollup evita que una vela 5m aparente cubrir un
minuto ausente. La prueba de integración detecta específicamente ese caso.

US usa calendario 2020–2028 publicado de 0B y America/New_York con DST, feriados
y cierre anticipado. PDH/PDL usan solo la última rueda RTH efectiva anterior.
PM usa [04:00,09:30); OR usa [apertura,apertura+5/15/30m), acotado al cierre.
Una barra histórica contribuye únicamente si su intervalo íntegro ya cerró al
instante explícito evalTimeSec y no cruza los límites de la ventana.
La cobertura se acredita mediante continuidad de intervalos fuente, no dos
extremos ni el mero transcurso del tiempo. Una ausencia de operaciones que no
pueda distinguirse de información faltante se mantiene conservadoramente sin
certificar. Cero volumen observado no implica por sí solo ausencia temporal.

Ventanas abiertas con observaciones son PROVISIONAL. Ventanas cerradas solo son
DEFINITIVE si su cobertura es suficiente; las incompletas son UNAVAILABLE.
NaN en matemática y null explícito en el DTO; no hay precio de respaldo.
Snapshots acumulativos reemplazan su contribución provisional. Quotes refinan
solo un minuto ya observado y no crean minutos ni volumen. La confirmación y
la revisión del último cierre reconstruyen desde un checkpoint fijo previo,
sin recorrer el histórico. Eventos obsoletos no deshacen observaciones nuevas.
US cambia de sesión localmente, conservando solo la RTH de fecha correcta para
la rueda anterior, incluso a través de fines de semana, feriados y DST.

AR usa America/Argentina/Buenos_Aires. El motor acepta sesiones de calendario
explícitamente acreditadas (OR 11:00 ART y excepciones), verificadas en fixtures.
El backend AR actual solo tiene histórico diario y no acredita calendario local
intradiario: entrega UNAVAILABLE, incluido PM siempre inexistente para BYMA.
No se fabricó un calendario ni se agregaron consultas para resolver esa carencia.

## S1-5: proximidad y representación

Se preservan los tres roles, anclas, categorías y currentAvwap del backend.
Solo 1m/5m agregan filtro y proyección: ancla anterior al buffer implica IPriceLine
horizontal y trayectoria vacía; dentro del buffer conserva trayectoria; igualdad
con la primera barra pertenece al buffer. Trayectoria/proyección/marcadores se
ocultan coherentemente ante filtrado, invalidez o falta de contexto.
Otros marcos conservan el camino legacy y permanecen exactamente ocho slots AVWAP.

PCT_1_5 es default explícito, dado que el plan no define otro. Entrada inclusiva
1.50%, permanencia inclusiva 1.65%; ATR usa 1.50/1.65 del ATR diario existente.
La memoria depende de símbolo, sesión, TF, ajuste, modo, rol y ancla. La zona
intermedia conserva el estado anterior. Comparación decimal exacta de los números
públicos para los límites inclusivos, sin epsilon ni cambio de tolerancias.
ATR toma exclusivamente engines.atr14d/atr14 diario, con timestamp causal y
fecha civil compatible. Si falta, es inválido o incompatible, oculta y muestra
ATR n/d; no usa el fallback intradiario legacy ni cambia a porcentaje.
SHOW_ALL omite distancia, pero exige valores válidos y anclas vigentes.
Se reutiliza el formato monetario y de fechas de mercado existente.

## S1-7: autoscale y ciclo de vida

Las 13 LineSeries secundarias reciben efectivamente autoscaleInfoProvider:()=>null.
CandlestickSeries mantiene su autoescalado normal como única contribución al eje
derecho. Se conservan escalas y gráficos inferiores. No se fijaron límites Y.
El registro único crea 16 IPriceLine una sola vez y aplica diffs in-place:
POC/VAH/VAL, Call/Put Wall, Zero-Gamma, Max Pain, tres proyecciones y seis niveles.
Provisional dotted con (prov), definitivo dashed e indisponible oculto.
Los estilos legacy originales se conservan en sus slots.

Max Pain reutiliza exclusivamente el valor del vencimiento líquido AR ya
entregado por el contrato, con símbolo/vencimiento/contexto válido. El contrato
US actual no expone ese valor: el slot queda oculto; no se recalcula ni inventa.
Los controles están en memoria: Sesión OFF inicial, OR15 inicial y selector
5/15/30, modos de proximidad. No se usa localStorage ni se altera setOverlays.
El controlador imperativo de overlays usa rAF y estado de tamaño fijo, separado
del callback canónico intacto. No hace setData, crea slots, reconstruye historia
ni hace requests durante ticks. Los marcadores también se actualizan por diff.

## Oráculo y resultados observados

Generador Python estándar con ZoneInfo para ambas zonas y Decimal precisión 50.
Se reutilizan como datos las fechas publicadas del fixture independiente de 0B;
los resultados se calculan mediante conjuntos de minutos y extremos, sin TS.
63 evaluaciones de sesión x tres OR; 65 casos de proximidad y dos secuencias
ordenadas de seis pasos. Incluye límites exactos, huecos, DST, feriados, cierre
13:00 ET, AR, agregados abiertos o cruzando límites y barras futuras extremas.

- 820 valores finitos contra Python: error absoluto máximo 0 (umbral <=1e-9).
- Estados e indefinidos exactos; prueba metamórfica causal en las 63 evaluaciones.
- Proximidad: 77 transiciones de fixture, sin fallback ATR a porcentaje.
- Requests adicionales en el flujo OR/caché probado: 0.
- Representaciones simultáneas observadas: 0.
- Series secundarias excluidas: 13/13; contribuyentes eje derecho: 1.
- Slots persistentes: 16; recreaciones durante live: 0; setData durante live: 0.
- Las tres suites nuevas: 145/145. Suite global final: 1465/1465, 94/94 suites.
- Tests/fixtures legacy y los dos gráficos protegidos: intactos.

La prueba de autoscale ejecuta las opciones reales del chart y los métodos Series,
PriceRangeImpl y AutoscaleInfoImpl de Lightweight Charts 5.3.0 instalado localmente.
Compara velas solas con todas las series secundarias y líneas distantes en USD/ARS.
No se presenta como E2E de navegador: esa validación visual no fue ejecutada.
Los transportes de integración usan mocks offline, sin consultas reales a feeds.

## Gates y trazabilidad del fallo transitorio

| Comando | Exit | Resultado |
|---|---:|---|
| python tools/generate_session_levels_fixture.py + SHA-256 antes/después | 0 | Reproducible |
| npm run typecheck | 0 | PASS |
| npm --prefix web run typecheck | 0 | PASS |
| npm --prefix web run build | 0 | PASS |
| node node_modules/vitest/vitest.mjs run --config tools/vitest.options-audit.mts | 0 | 6/6 PASS |
| npm run verify (primer intento, mismo código) | 1 | 1464 PASS, 1 fallo WS |
| node node_modules/vitest/vitest.mjs run tests/realtimePropagation.test.ts | 0 | 2/2 PASS |
| npm run verify (integral final, mismo código y configuración) | 0 | 1465/1465 PASS |

El primer verify falló en realtimePropagation.test.ts:307: no había market_batch
recibidos al terminar su espera fija. Su test, servidor WS y propagación no se
modificaron; el escenario no ejecuta el nuevo cálculo de /api/bars. No se reprodujo
ni aislado ni en el segundo verify. Compatible con una carrera de timers bajo
carga; causa raíz no confirmada. Se conserva como nota pendiente, sin atribuir
una solución WS ni tocar timeouts/configuración/aserciones.

Logs literales: .cache/pieza3-verify.log (primer fallo),
.cache/pieza3-realtime-diagnostic.log y .cache/pieza3-verify-final.log (gate verde).
La suite final tardó 43.08 s; suma de tiempos de tests 226.28 s.
No se hicieron cambios productivos después del gate final: solo este informe,
verificación de hashes, staging explícito y commit.

Fixture local SHA-256: FEFED43B59017F0B71015C8D94AD4168763C2311EB58456D3C85BDFB5D8EB6DC
Log integral final SHA-256: 8D34D631330F0E4E34F091D6AC1E98E4C754C51D4850D2106F3805D969FAF659

La .cache preexistente permanece fuera del commit; las validaciones generan
reportes locales, incluidos los que reescriben suites de piezas anteriores.
No se incorporan dependencias, lockfiles, configuraciones globales ni artefactos.
Pieza 4 y Sub-fase 2 permanecen sin iniciar.
