# Hallazgos de datos RTH — Massive (acciones US)

Fecha: 2026-11-09. Alcance: solo acciones US con Massive (SPY). Método: muestras
REST crudas guardadas en `fixtures/samples/SPY_*.json` (día de referencia
2026-11-06, capturadas 2026-11-07), repeticiones manuales de peticiones
idénticas, y análisis offline con `tools/analyze_samples.py`. Sin datos
simulados; todos los fragmentos son literales de respuestas del proveedor.
Herramienta de captura: `tools/capture_samples.py` (la clave nunca se imprime
ni se escribe; escaneo previo a cada commit: `key_found False`,
`apiKey_param_found False`).

Cambios en `tools/` (un commit por pieza):

| Commit | Contenido |
| --- | --- |
| `81ae169` | fix(tools): escalar el `limit` del escenario latest a barras base escaneadas |
| `9b61885` | feat(tools): modo live para sondear la barra en formación |
| `4e49767` | feat(tools): temporalidad 30m y filtro `--timeframes` |
| `c76f705` | test(fixtures): muestras SPY 30m (day/range/max/latest) |
| `81c3f7f` | feat(tools): analizador offline de muestras (vw-excess, warmup) |

---

## 1. Anomalía del "latest": diagnóstico y corrección

### Parámetros exactos que usaba el script en cada temporalidad

El escenario `latest` pedía en todas las temporalidades `sort=desc` con
`limit=5` ("las últimas 5 barras") y una ventana de 7 días (1D: 10 días por
fecha). Parámetros y respuesta literal guardada en las muestras:

```text
=== 1m ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/1793476830782/1794081630782?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "1793476830782", "to": "1794081630782"}
captured_at_utc: 2026-11-07T20:00:30.783070Z | http: 200 | queryCount: 5 | resultsCount: 5 | rows_total: 5 | requested_limit: 5

=== 5m ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/5/minute/1793476912889/1794081712889?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "1793476912889", "to": "1794081712889"}
captured_at_utc: 2026-11-07T20:01:52.889747Z | http: 200 | queryCount: 5 | resultsCount: 1 | rows_total: 1 | requested_limit: 5

=== 15m ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/15/minute/1793477034477/1794081834477?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "1793477034477", "to": "1794081834477"}
captured_at_utc: 2026-11-07T20:03:54.478246Z | http: 200 | queryCount: 5 | resultsCount: 0 | rows_total: 0 | requested_limit: 5

=== 1h ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/1/hour/1793477120967/1794081920967?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "1793477120967", "to": "1794081920967"}
captured_at_utc: 2026-11-07T20:05:20.968211Z | http: 200 | queryCount: 5 | resultsCount: 0 | rows_total: 0 | requested_limit: 5

=== 4h ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/4/hour/1793477212826/1794082012826?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "1793477212826", "to": "1794082012826"}
captured_at_utc: 2026-11-07T20:06:52.827009Z | http: 200 | queryCount: 5 | resultsCount: 0 | rows_total: 0 | requested_limit: 5

=== 1D ===
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/2026-10-28/2026-11-07?adjusted=true&sort=desc&limit=5
params: {"adjusted": "true", "sort": "desc", "limit": "5", "from": "2026-10-28", "to": "2026-11-07"}
captured_at_utc: 2026-11-07T20:07:57.893870Z | http: 200 | queryCount: 7 | resultsCount: 7 | rows_total: 7 | requested_limit: 5
```

Resultados 5/1/0/0/0 para 1m/5m/15m/1h/4h y `queryCount: 5` en las cuatro
intradías. Pista clave: en 1D el motor devolvió **7 filas con `limit=5`**.
Otra pista: la única fila "5m" devuelta abre en `19:56 ET` (no alineada a 5m)
con `n=74`, y las escenas ascendentes guardadas muestran `queryCount=922`
(minutos base del día ET) para 192 barras de 5m.

### Repetición manual de peticiones idénticas

Se repitieron a mano las peticiones guardadas (mismos `from`/`to` en ms,
mismos params) con la clave por entorno; respuestas crudas en
`%TEMP%\opencode\latest_recheck\recheck_*.json`:

```text
recheck_5m.json  queryCount= 5 resultsCount= 1 n_results= 1
recheck_15m.json queryCount= 5 resultsCount= 0 n_results= 0
recheck_1h.json  queryCount= 5 resultsCount= 0 n_results= 0
recheck_4h.json  queryCount= 5 resultsCount= 0 n_results= 0
```

Reproducen el resultado 1/0/0/0 de forma determinista: no es un error
transitorio ni de rate limit. Fila devuelta en 5m:

```text
--- recheck_5m [5m] status=200 queryCount=5 resultsCount=1 resultados=1
    t=1794012960000 (2026-11-07T00:56:00Z | 2026-11-06 19:56:00 ET) o=736.2706 h=736.53 l=736.2706 c=736.53 v=8219.216719 n=74 vw=736.428
```

### Sondas que confirman el modelo

Con el mismo `from`/`to` y `limit` escalado (5×multiplicador):

```text
probe_5m_limit25   (limit=25):   queryCount=25  -> 5 filas, t = 00:56/00:51/00:46/00:41/00:36Z (19:56/19:51/19:46/19:41/19:36 ET)
probe_15m_limit75  (limit=75):   queryCount=75  -> 7 filas, t = 00:48/00:33/00:18/00:03/23:48/23:33/23:18Z (19:48/19:33/... ET)
probe_4h_limit1200 (limit=1200): queryCount=1200 -> 6 filas, t = 00:00Z(7-nov)/20:00Z/16:00Z/12:00Z/08:00Z/00:00Z(6-nov) (19:00/15:00/11:00/07:00/03:00/19:00 ET)
```

En cada sonda `queryCount` es exactamente el `limit` pedido.

### Diagnóstico

**El `limit` de Massive acota las barras BASE escaneadas por petición (1-minute
en todo intradía; 1-day en 1D), no las barras de salida.** Con `limit=5` y
`sort=desc`, el motor escanea solo los 5 minutos más recientes:

- 1m: 5 minutos → 5 barras (coincidencia: multiplicador 1).
- 5m: 5 minutos llenan una cubeta de 5m solo si están alineados; aquí la cubeta
  más nueva queda parcial y descentrada (abre 19:56 ET, n=74, sin el minuto de
  19:55) → 1 fila.
- 15m/1h/4h: 5 minutos no llenan ni una cubeta → 0 filas.
- 1D: las barras base son diarias; el motor devuelve la ventana completa
  (7 días de bolsa → 7 filas aunque `limit=5`).

Además, en `desc` las rejillas de 5m/15m/30m quedan ancladas a la petición
(offset = minuto de la petición) y la cubeta más nueva es parcial: por eso la
fila 5m abre en 19:56 y no en 19:55. En `asc` la rejilla se ancla a `from`
(cuando `from` es medianoche ET, como en los escenarios `day`, las barras sí
quedan alineadas a la rejilla estándar). En 4h `desc` la muestra cayó sobre la
rejilla UTC estándar 00:00/04:00/…Z (19:00/15:00/… ET), coherente con el
hallazgo A9 del informe de auditoría: la rejilla 4h no se puede asumir fija.

**Era un error del script** (pedía "últimas 5 barras" con `limit=5` literal).
Corrección en commit `81ae169`: `MASSIVE_LATEST_LIMIT` = 5×multiplicador en
minutos base (1m:5, 5m:25, 15m:75, 30m:150, 1h:300, 4h:1200, 1D:5).

Validación posterior en 30m con el fix aplicado (captura `c76f705`):

```text
massive SPY 30m latest: 5 filas, ultima pagina 5 resultados
url: https://api.polygon.io/v2/aggs/ticker/SPY/range/30/minute/1793664512723/1794269312723?adjusted=true&sort=desc&limit=150
queryCount: 150 | resultsCount: 5
```

### Implicaciones para el cargador

1. El cargador usa `sort=desc` con `limit=50000` (barras base): una página
   cubre ≈50000 minutos base (≈34.7 días de sesión extendida de 960 min). Con
   `DEFAULT_MAX_PAGES=10` caben ≈500k minutos base ≈ 520 días de bolsa: 1m/5m/
   15m del objetivo caben en 1 página, 1h ≈ 2 páginas, 4h ≈ 3-7 páginas.
2. El motor corta la paginación en fronteras de cubeta limpias: en las 3
   temporalidades con `range` multipágina guardadas no hay ningún `t`
   compartido entre páginas consecutivas (0 solapes; p. ej. 5m p0 termina
   `1793007600000` y p1 empieza `1793007900000`).
3. Con `sort=desc`, la cubeta más nueva de cada agregación es parcial y la
   rejilla de 5m/15m/30m queda anclada a la petición (no a la estándar
   :00/:15/:30/:45): el cargador no debe asumir alineación de rejilla al
   ingerir; la asignación de sesión por hora ET (A9) es la que manda.
4. El `limit` de salida real por página es ≤ `limit` pedido dividido por el
   multiplicador; las tablas `MASSIVE_BARS_PER_DAY` del cargador (estimación de
   barras de salida) no se ven afectadas, pero cualquier estimación de
   "barras por página" debe contar barras base, no de salida.

---

## 2. Magnitud del vw fuera de rango (offline, muestras guardadas)

Definición: `exceso = max(low - vw, vw - high, 0) / vw`. Cero cuando `vw` está
dentro de `[low, high]`. Salida literal de
`python tools/analyze_samples.py vw-excess` (muestras SPY_*.json; 80 006
barras únicas temporalidad+instante):

```text
EXCESO DE vw FUERA DE RANGO: exceso = max(low - vw, vw - high, 0) / vw
Umbrales: >0, >0.1%, >0.5%, >2%   (sin red; muestras SPY_*.json)

--- SPY 1m ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day     922     922       0     104      18       3       0      65       39   0.016406   0.000000   0.003661
    range    2000    2000       0     799     202      22       0      45      754   0.019033   0.000000   0.005413
      max   50000   50000       0   13959    3260     618       9    1135    12824   0.064936   0.000000   0.005571
   latest       5       5       0       1       0       0       0       1        0   0.000007   0.000000   0.000006

--- SPY 5m ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day     192     192       0      20       8       0       0      19        1   0.003045   0.000000   0.002306
    range     646     646       0     260      59       3       0      13      247   0.006892   0.000000   0.003407
      max   11942   11942       0    1556     430      36       0     906      650   0.016542   0.000000   0.002714
   latest       1       1       0       0       0       0       0       0        0   0.000000   0.000000   0.000000

--- SPY 15m ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day      64      64       0       6       2       0       0       5        1   0.001365   0.000000   0.001184
    range     216     216       0      54      10       1       0       5       49   0.006485   0.000000   0.002036
      max    4121    4121       0     224      99       4       0     135       89   0.006667   0.000000   0.001897

--- SPY 30m ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day      32      32       0       5       0       0       0       1        4   0.000611   0.000000   0.000542
    range     107     107       0      19       2       0       0       5       14   0.001259   0.000000   0.001050
      max    2321    2321       0      11       8       0       0       3        8   0.003370   0.000000   0.000000
   latest       5       5       0       0       0       0       0       0        0   0.000000   0.000000   0.000000

--- SPY 1h ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day      16      16       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
    range      49      49       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
      max    1192    1192       0       3       2       0       0       1        2   0.002330   0.000000   0.000000

--- SPY 4h ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day       4       4       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
    range      14      14       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
      max     334     334       0       0       0       0       0       0        0   0.000000   0.000000   0.000000

--- SPY 1D ---
escenario  barras  con vw  sin vw      >0   >0.1%   >0.5%     >2%  vw<low  vw>high        max        p50        p99
      day      30      30       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
    range    2000    2000       0       0       0       0       0       0        0   0.000000   0.000000   0.000000
      max    5828    5828       0       1       1       1       1       0        1   0.080072   0.000000   0.000000
   latest       7       7       0       0       0       0       0       0        0   0.000000   0.000000   0.000000

TOP 10 MAYOR EXCESO (sin duplicar por temporalidad+instante):
 #     exceso   exceso%   tf         t (ms)               hora ET escenario
 1   0.080072   8.0072%   1D  1242792000000 2009-05-20 00:00:00 ET max
 2   0.064936   6.4936%   1m  1773179040000 2026-03-10 17:44:00 ET max
 3   0.041731   4.1731%   1m  1773436920000 2026-03-13 17:22:00 ET max
 4   0.040683   4.0683%   1m  1773697980000 2026-03-16 17:53:00 ET max
 5   0.029295   2.9295%   1m  1773783420000 2026-03-17 17:37:00 ET max
 6   0.028522   2.8522%   1m  1773697380000 2026-03-16 17:43:00 ET max
 7   0.027099   2.7099%   1m  1774988520000 2026-03-31 16:22:00 ET max
 8   0.024405   2.4405%   1m  1775682420000 2026-04-08 17:07:00 ET max
 9   0.022747   2.2747%   1m  1775679180000 2026-04-08 16:13:00 ET max
10   0.020977   2.0977%   1m  1775679060000 2026-04-08 16:11:00 ET max

barras candidatas al top (unicas por tf+t): 80006 (NaN: 0)
```

### Lectura del patrón

- El exceso existe en ambas direcciones (columnas `vw<low` y `vw>high`: p. ej.
  1m max: 1135 vs 12824; 5m max: 906 vs 650) y su magnitud típica es mínima:
  p50 = 0.000000 en todos los escenarios y p99 ≤ 0.56 % incluso en 1m.
- Los excesos grandes se concentran en 1m fuera de RTH (16:xx-17:xx ET:
  after-hours con poquísimas operaciones por minuto) y en un único daily
  histórico de 2009. En 4h no hay ni un solo caso en 352 barras.
- 9 barras de 50000 en 1m superan el 2 % (0.018 % de las barras) y todas
  pertenecen al escenario `max` (historia antigua/after-hours).

### Veredicto

El patrón **apoya** que el `vw` de Massive se calcula sobre un conjunto de
operaciones más amplio que el que define el OHLC de la barra (p. ej. lotes
pequeños u operaciones con condición excluidas del high/low), no que haya
datos erróneos: el exceso es pequeño, bidireccional, frecuente en barras de
poca liquidez y nulo en la gran mayoría de barras líquidas. Datos corruptos
darían excesos enormes, unidireccionales o garbage (valores no finitos); no se
observa ningún caso (0 barras sin `vw`, 0 NaN). La excepción a vigilar es el
daily de 2009-05-20 (8 %), aislado y en historia antigua: como el volumen
sesiona dentro de su `[low, high]` con p99 ≤ 0.6 %, el impacto en la banda de
VWAP (SPEC punto 1/4, que usa `sum(vw·V)/sum(V)`) es marginal, y la interfaz ya
muestra "—" cuando un valor no es calculable (no hay valores de respaldo).

---

## 3. Captura en sesión: modo `live` (la ejecuta el usuario en RTH)

Commit `9b61885` añade el modo `live` a `tools/capture_samples.py`. El comando
(ejecutar **durante RTH, 09:30-16:00 ET**):

```text
python tools/capture_samples.py live
```

Qué hace:

- Pide SPY 1m y 5m, últimas 5 barras de salida (`sort=desc`, ventana de 3 días,
  `limit` escalado al multiplicador: 5 en 1m y 25 en 5m, según el hallazgo de
  la sección 1).
- Dos rondas separadas por 90 s; guarda la hora UTC exacta de cada petición
  (`captured_at_utc`) junto con el cuerpo completo y `queryCount`/`resultsCount`.
- Escribe `fixtures/samples/SPY_live_<fecha UTC>.json`.

Con esa muestra se responde: ¿incluye Massive la barra en formación (comparar
la primera barra desc de cada ronda con `captured_at_utc`)?, ¿cambia entre
rondas (mismo `t` con `v`/`c`/`vw` distintos = estaba en formación)?, y ¿cómo
se distingue de una cerrada (estabilidad entre rondas y cierre exacto en la
frontera de la rejilla)? Nota: la cubeta más nueva en `desc` puede estar
parcial por la rejilla anclada a la petición (sección 1), por eso importa
comparar la evolución de la misma barra `t` entre rondas.

---

## 4. SPY 30m: rejilla, barras 09:30/15:30 y consistencia de volumen

Captura `c76f705` (`python tools/capture_samples.py massive --timeframes 30m --day 2026-11-06`):
day=32 filas (1 página, `queryCount: 922`), range=107 filas (3 páginas),
max=2321 filas, latest=5 filas.

### Alineación a :00/:30 ET y existencia de 09:30 y 15:30

Escenario `day` (sort=asc, `from`=00:00 ET del 2026-11-06). Minutos de apertura
ET distintos de las 32 barras:

```text
['00:00', '00:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30']
todas las aperturas alineadas a :00/:30 ET: True
```

Barra de 09:30 ET presente (apertura de RTH):

```json
{"v": 8380299.920314, "vw": 737.9852, "o": 734.82, "c": 740.57, "h": 742.2104, "l": 734.58, "t": 1793975400000, "n": 129835}
```

Barra de 15:30 ET presente (última de RTH):

```json
{"v": 9770688.361994, "vw": 736.2105, "o": 737.96, "c": 735.34, "h": 738.03, "l": 735.07, "t": 1793997000000, "n": 101299}
```

(RTH completo: barras de 09:30 a 15:30 = 13 barras de 30m; el resto del día
cubre extendido 04:00-19:59 ET.)

### Suma de dos 30m vs la 1h correspondiente (día 2026-11-06, extendido)

```text
--- hora 10:00 ET ---
  30m A: {"v": 3957850.930314999, ..., "t": 1793977200000, "n": 78827}
  30m B: {"v": 3187324.875327, ..., "t": 1793979000000, "n": 67132}
  1h  : {"v": 7145175.805641998, ..., "t": 1793977200000, "n": 145959}
  suma30m=7145175.8056419995 | v1h=7145175.805641998 | dif_abs=1.862645149230957e-09
  n: 30m 78827+67132 = 145959 vs 1h 145959

--- hora 11:00 ET ---
  30m A: {"v": 2687930.1804530006, ..., "t": 1793980800000, "n": 57543}
  30m B: {"v": 2308195.6130810003, ..., "t": 1793982600000, "n": 53820}
  1h  : {"v": 4996125.793534002, ..., "t": 1793980800000, "n": 111363}
  suma30m=4996125.793534001 | v1h=4996125.793534002 | dif_abs=-9.313225746154785e-10
  n: 30m 57543+53820 = 111363 vs 1h 111363
```

**Diferencia: 1.9e-09 y -9.3e-10 de volumen** (ruido de coma flotante IEEE-754,
≈2.6e-16 relativo; el `n` de operaciones coincide exactamente). Las barras 30m
son agregaciones consistentes de las mismas operaciones que la 1h. El `vw`
ponderado por volumen de las dos 30m (739.3957) difiere de la 1h (739.393) solo
por el redondeo a 4 decimales del `vw` por barra.

### Paginación y latest

`range` (limit=1000 barras base=1000 minutos → ~33-36 barras de salida por
página), 3 páginas sin solape y corte limpio en frontera de cubeta:

```text
  pagina 0: queryCount=1000 resultsCount=36 | ultima=2026-07-10 05:30 ET
  pagina 1: queryCount=1000 resultsCount=36 | primera=2026-07-10 06:00 ET
  pagina 2: queryCount=1000 resultsCount=35 | ultima=2026-07-14 09:00 ET
  solape p0/p1: 0 ts compartidos | solape p1/p2: 0 ts compartidos
```

El escenario `latest` con el fix (limit=150) devuelve 5 barras pero en rejilla
anclada a la petición (18:38/18:08/… ET, fuera de :00/:30) — la página 1 de
este informe lo detalla; el cargador no debe asumir rejilla estándar en desc.

---

## 5. Calentamiento: barras por día y días de calendario

Salida literal de `python tools/analyze_samples.py warmup`
(500 visibles + 1000 de calentamiento = 1500 barras; el recuento "day" usa el
escenario de un día ET completo; la mediana usa días completos de `range`+`max`
deduplicados; fórmula: `dias_bolsa = ceil(1500/barras_dia)`,
`dias_calendario = ceil(dias_bolsa × 365.25/251)`, donde 5/7 es el factor de
fin de semana y 251 sesiones/año descuenta ~10 feriados US):

```text
CALENTAMIENTO: objetivo 500 visibles + 1000 de calentamiento = 1500 barras
Factor calendario: 5 sesiones/7 dias (fin de semana) y ~251 sesiones/365.25 dias (feriados US)
  dias_calendario = ceil(dias_de_bolsa * 365.25 / 251), dias_de_bolsa = ceil(needed / barras_por_dia)

  tf | day: ext    RTH | range: dias mediana ext mediana RTH |  cal ext  cal RTH
  1m |      922    390 |          57       931.0       390.0 |        3        6
     dias ext min/max completos: 867/958 | RTH min/max: 390/390
  5m |      192     78 |          69       187.0        78.0 |       12       30
     dias ext min/max completos: 176/192 | RTH min/max: 78/78
 15m |       64     26 |          69        64.0        26.0 |       35       85
     dias ext min/max completos: 63/64 | RTH min/max: 26/26
 30m |       32     13 |         106        32.0        13.0 |       69      169
     dias ext min/max completos: 32/32 | RTH min/max: 13/13
  1h |       16      6 |         106        16.0         6.0 |      137      364
     dias ext min/max completos: 16/16 | RTH min/max: 6/6
  4h |        4      1 |         106         4.0         1.0 |      546     2183
     dias ext min/max completos: 4/4 | RTH min/max: 1/1
  1D |        -      - |        5828         1.0         0.0 |     2183        -

Estimacion del cargador (loader.ts, solo lectura) para comparar:
  extendido: {"1m": 960, "5m": 192, "15m": 64, "1h": 16, "4h": 4, "1D": 1}
  RTH      : {"1m": 390, "5m": 78, "15m": 26, "1h": 6, "4h": 1}
```

### Lectura

- Las barras medidas por día cuadran con las tablas del cargador (extendido
  960/192/64/16/4/1 estimado vs 922/192/64/16/4/1 medido el 2026-11-06; en 1m
  faltan minutos sin operaciones: 922-958 observados vs 960 teóricos).
- En RTH la mediana es exactamente 390/78/26/6/1 (SPY opera cada minuto de
  RTH): las estimaciones del cargador son exactas.
- Días de calendario para 1500 barras: en extendido, 1m basta con 3 días
  (1 semana de margen basta), 5m 12, 15m 35, 30m 69, 1h 137, 4h 546, 1D 2183.
  En `rthOnly` (1D se rechaza por diseño, ninguna barra diaria abre en RTH):
  1m 6, 5m 30, 15m 85, 30m 169, 1h 364, 4h 2183 días calendario. En 4h
  `rthOnly` el coste se dispara porque solo 1 de las 4-5 barras diarias abre
  dentro de RTH.

---

## 6. Resumen de implicaciones para el cargador (Massive)

1. `limit` = barras base escaneadas por petición (1-minute intradía, 1-day en
   1D); el número de barras de salida es ≈ limit/multiplicador como máximo.
2. Con `sort=desc`, la cubeta más nueva es parcial y las rejillas 5m/15m/30m se
   anclan a la petición (4h cayó sobre la rejilla UTC estándar): no asumir
   alineación estándar; la sesión se asigna por hora ET (A9).
3. Con `sort=asc`, la rejilla se ancla a `from`: pedir `from` en frontera
   estándar (medianoche ET) produce barras alineadas a :00/:30.
4. La paginación corta en fronteras de cubeta limpias (0 solapes verificados en
   1m/5m/15m/1h/30m); con `limit=50000` y `maxPages=10` el objetivo de
   500 visibles + 1000 de calentamiento cabe en todas las temporalidades.
5. El `vw` puede salirse del `[low, high]` de la barra en magnitudes pequeñas
   (p99 ≤ 0.6 % en 1m): la verificación de sesión VWAP (SPEC 6/8) debe tolerar
   este margen del proveedor en la entrada, sin ocultar NaN con valores de
   respaldo.
6. 30m es válido para sesión VWAP: 30·60 s divide 1800 exactamente (SPEC 8).

---

## 7. Verificación del repo

Salida literal de `npm run verify` (2026-11-09):

```text

> quant-options-terminal@0.1.0 verify
> npm run typecheck && npm run lint && npm run test


> quant-options-terminal@0.1.0 typecheck
> tsc --noEmit


> quant-options-terminal@0.1.0 lint
> eslint .


> quant-options-terminal@0.1.0 test
> vitest run


 RUN  v3.2.7 C:/dev/QuantOptionsTerminal

  ✓ tests/setup.test.ts (1 test) 4ms
  ✓ tests/dataAlignment.test.ts (13 tests) 37ms
stdout | tests/ema.test.ts > EMA (SPEC punto 2) > Referencia independiente (fixtures) > reporta la máxima diferencia relativa observada contra el fixture
[EMA Fixture Reference Report] Max relative difference: 5.6762e-15

  ✓ tests/dataLoader.test.ts (62 tests) 285ms
  ✓ tests/dataNormalize.test.ts (38 tests) 333ms
stdout | tests/ema.test.ts > EMA (SPEC punto 2) > Comprobación cruzada con pandas (segundo fixture) > coincide con pandas.ewm(span=N, adjust=False) desde la barra 1000
[EMA pandas Cross-Check Report] pandas 3.0.2, desde índice 1000: max relative difference 1.0432e-7

stdout | tests/ema.test.ts > EMA (SPEC punto 2) > projectLiveEma > encadenar la EMA del tick anterior NO da el mismo resultado (error que se evita)
[projectLiveEma] directo=119.800000, encadenado=195.000000, diferencia=75.200000

stdout | tests/ema.test.ts > EMA (SPEC punto 2) > emaWarmupWeight > emaWarmupWeight(200, 1000) es aproximadamente 4.54e-5
[emaWarmupWeight] (199/201)^1000 = 4.539615e-5

stdout | tests/ema.test.ts > EMA (SPEC punto 2) > Rendimiento > procesa 5.000 cierres para los 4 periodos y reporta el tiempo medido
[EMA Performance Benchmark] 5.000 cierres x 4 periodos (9, 21, 50, 200) en 0.447 ms

  ✓ tests/ema.test.ts (34 tests) 575ms
stdout | tests/welford.test.ts > Welford ponderado (AVWAP y bandas) > Referencia independiente (fixtures) > reporta la máxima diferencia relativa observada contra el fixture
[Fixture Reference Report] Max relative difference -> vwap: 1.4488e-15, stdDev: 3.7973e-13

stdout | tests/welford.test.ts > Welford ponderado (AVWAP y bandas) > Rendimiento (5.000 barras en menos de 50 ms) > procesa 5.000 barras midiendo el tiempo de ejecución
[Performance Benchmark] 5.000 barras procesadas en 1.303 ms (límite orientativo: 50 ms)

  ✓ tests/welford.test.ts (16 tests) 693ms
   ✓ Welford ponderado (AVWAP y bandas) > Referencia independiente (fixtures) > verifica contra fixture independiente: case_a_large_prices_large_volumes (5.000 barras con precios ~60.000 y volúmenes grandes (semilla fija)) 657ms
stdout | tests/sessionVwap.test.ts > VWAP de sesión (SPEC punto 4) > Referencia independiente (fixtures) > reporta la máxima diferencia relativa observada contra el fixture
[Session VWAP Fixture Reference] Max relative difference -> vwap: 6.9949e-16, cumVolume: 0.0000e+0

stdout | tests/sessionVwap.test.ts > VWAP de sesión (SPEC punto 4) > Rendimiento > mide 4.000 barras y una proyección en vivo sin aserción de tiempo
[Session VWAP Performance] 4.000 barras en 28.807 ms; proyección en vivo en 0.0151 ms

  ✓ tests/sessionVwap.test.ts (35 tests) 939ms
stdout | tests/sessions.test.ts > Gestor de sesiones (SPEC punto 3) > Barrido de 5 minutos (2025-01-01 a 2026-12-31) > coincide con Python en los 5000 puntos muestreados
[Sessions Sweep] 5000 puntos de 210240 verificados contra Python (2025-01-01T00:00:00Z a 2026-12-31T23:55:00Z)

stdout | tests/sessions.test.ts > Gestor de sesiones (SPEC punto 3) > Caché de Intl.DateTimeFormat > 10.000 llamadas no crean 10.000 formateadores
[Sessions Formatter Cache] formateadores antes=2, después=2

stdout | tests/sessions.test.ts > Gestor de sesiones (SPEC punto 3) > Rendimiento > mide 10.000 llamadas a getMarketParts y reporta el tiempo
[Sessions Performance Benchmark] 10.000 llamadas a getMarketParts en 62.920 ms

  ✓ tests/sessions.test.ts (36 tests) 1166ms
   ✓ Gestor de sesiones (SPEC punto 3) > Barrido de 5 minutos (2025-01-01 a 2026-12-31) > coincide con Python en los 5000 puntos muestreados 984ms
stdout | tests/avwap.test.ts > AVWAP anclado (SPEC puntos 5 y 9) > Referencia independiente (fixtures) > reporta la máxima diferencia relativa observada contra el fixture
[AVWAP Fixture Reference] Max relative difference -> vwap: 1.8163e-15, stdDev: 1.4661e-11, cumVolume: 0.0000e+0, bands: 2.7397e-15

stdout | tests/avwap.test.ts > AVWAP anclado (SPEC puntos 5 y 9) > Rendimiento > mide 4.000 barras y una proyección en vivo con 500 y 5.000 barras previas
[AVWAP Performance] 4.000 barras en 28.374 ms; proyección en vivo: 0.2767 µs/call con 500 barras y 0.3106 µs/call con 5.000 barras

  ✓ tests/avwap.test.ts (33 tests) 2162ms
   ✓ AVWAP anclado (SPEC puntos 5 y 9) > Referencia independiente (fixtures) > verifica contra fixture independiente: e_large_5000_bars FULL_HISTORY visibleStart=0 544ms

 Test Files  9 passed (9)
      Tests  268 passed (268)
   Start at  21:15:24
   Duration  3.43s (transform 1.53s, setup 0ms, collect 2.83s, tests 6.19s, environment 4ms, prepare 4.47s)
```

Estado del árbol antes del commit del documento (escaneo previo:
`key_found False`, `apiKey_param_found False`, 67 archivos):

```text
?? docs/data_findings_rth.md
```
