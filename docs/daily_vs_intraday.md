# Diaria de Massive frente a la derivada de 1m (análisis)

**Fecha:** 2026-11-10 · **Alcance:** solo lectura; ningún cambio de código.
**Pregunta de origen:** el volumen diario de SPY del 2026-11-06 (58,98 M) no
coincide con la suma intradía 04:00-20:00 (56,36 M) ni con la RTH (48,54 M):
quedan 2,62 M sin explicar. Y la barra diaria del día en curso no existe
durante la sesión, así que el motor tendrá que construirla desde 1m.

## 1. Datos y método

Muestras crudas ya sanitizadas en `fixtures/samples/` (lectura única):

| símbolo | perfil | fuentes 1m | días comparables RTH | EXT |
|---|---|---|---|---|
| SPY | líquida | 2 capturas (2026-11-06, 2026-11-09) | 61 | 60 |
| QQQ | líquida | 1 captura (2026-11-09, 100 000 filas) | 109 | 109 |
| CSCO | media | 1 captura (2026-11-09, 89 953 filas) | 181 | 181 |
| BGS | poco líquida | 1 captura (2026-11-09, 67 503 filas) | 181 | 181 |

GLDD se descartó como muestra ilíquida: dejó de negociar (última diaria
2026-03-31); se sustituyó por BGS. Las capturas de QQQ/CSCO/BGS se hicieron
con un script desechable (fuera del repo) que reutiliza el cliente y el
scrubber de `tools/capture_samples.py`; el escaneo de secretos sobre los 89
ficheros da `key_found False`, `apiKey_param_found False`.

**Derivación diaria desde 1m** para cada fecha ET y cada ventana:

- RTH: minutos ET en [09:30, 16:00).
- Extendido (EXT): minutos ET en [04:00, 20:00).
- `open` de la primera barra cronológica, `close` de la última, `high`/`low`
  extremos, `volume` = Σv, `vw` = Σ(vw·v)/Σv solo sobre barras con vw
  utilizable (finito y > 0).
- Comparación con la diaria de Massive (t = 00:00 ET) por fecha.
- Dif. relativa = (derivada − diaria)/diaria.

**Completitud:** un día se excluye de una ventana solo si la respuesta de
origen terminó truncada por paginación (`has_next_url_after_last_page=true`)
y la última barra de la unión cae dentro de esa ventana. Los minutos finales
sin operaciones (nombres ilíquidos: CSCO mediana 487 de 960, BGS 584) son
silencio real, no truncamiento: la suma no pierde nada. SPY: truncadas las
ventanas que acaban en 2026-05-06, 2026-05-08 y 2026-11-04; el resto queda
completo por unión de capturas.

**Estabilidad entre capturas:** los 1m de 2026-11-06 corrigieron su `vw` entre
la captura del sábado y la del martes (903 barras, mediana 0,0021 %, máx
1,28 %); `o/h/l/c/v/n` idénticos y las diarias sin un solo conflicto. En la
unión gana la captura más reciente.

## 2. Resultados: mediana de |dif. relativa| por campo

| campo | SPY RTH | SPY EXT | QQQ RTH | QQQ EXT | CSCO RTH | CSCO EXT | BGS RTH | BGS EXT |
|---|---|---|---|---|---|---|---|---|
| open | **0,0000 %** | 0,2452 % | **0,0000 %** | 0,3340 % | **0,0000 %** | 0,5013 % | **0,0000 %** | 0,6536 % |
| high | **0,0000 %** | 0,0558 % | **0,0000 %** | 0,0595 % | **0,0000 %** | 0,0000 % | **0,0000 %** | 0,0000 % |
| low | **0,0000 %** | 0,1094 % | **0,0000 %** | 0,0623 % | **0,0000 %** | 0,0000 % | **0,0000 %** | 0,0000 % |
| close | 0,0068 % | 0,1387 % | 0,0086 % | 0,1825 % | 0,0166 % | 0,1788 % | 0,1309 % | 0,5291 % |
| volume | 16,28 % | 2,96 % | 12,42 % | 2,52 % | 32,00 % | 29,16 % | 10,60 % | 9,79 % |
| vw | 0,0208 % | 0,0063 % | 0,0206 % | 0,0055 % | 0,1248 % | 0,1107 % | 0,0633 % | 0,0591 % |

Peores extremos EXT (p95/máx de |dif.|): open SPY 0,81 %/2,30 %, QQQ
0,99 %/2,49 %, CSCO 1,59 %/3,66 %, BGS 2,74 %/6,90 %; el 2026-03-23 (SPY,
−2,30 % en open) es un día de gap pre-market grande. En los ilíquidos los
extremos EXT de high/low/close alcanzan máximos de 10-28 % en días con gaps
pre/post-market fuertes (mediana 0,0000 %: la mayoría de días no los supera).

## 3. Veredictos con evidencia

### 3.1 El OHLC diario de Massive es la sesión regular (RTH)

- `open`, `high` y `low`: mediana **0,0000 %** en los cuatro símbolos y en los
  532 días comparables (SPY máx low 0,0049 % en un día de 61).
- La diaria `open` es la apertura de la barra de 09:30, no la de 04:00:

| fecha | diaria o | 1m 04:00 o | 1m 09:30 o |
|---|---|---|---|
| 2026-11-09 | 741,95 | 738,37 | **741,95** |
| 2026-11-06 | 734,82 | 734,63 | **734,82** |
| 2026-11-05 | 765,47 | 765,70 | **765,47** |
| 2026-11-03 | 752,73 | 750,30 | **752,73** |
| 2026-11-02 | 759,45 | 758,72 | **759,45** |

- El extendido se desvía (mediana open 0,25-0,65 %) porque incluye el
  pre-market: el 2026-03-23 el open extendido (642,95) difiere 2,30 % del
  oficial (658,07).

### 3.2 El `close` diario es el cierre oficial consolidado

| fecha | diaria c | 1m 15:59 c | 1m 16:00 c |
|---|---|---|---|
| 2026-11-09 | 752,69 | 752,65 | 752,67 |
| 2026-11-06 | 735,29 | 735,34 | 735,24 |
| 2026-11-05 | 733,00 | 733,13 | 732,53 |
| 2026-11-03 | 754,35 | 754,40 | 754,17 |
| 2026-11-02 | 752,10 | 752,12 | 752,40 |

No coincide exactamente ni con la última barra RTH ni con la barra de 16:00:
mediana 0,0068 % (SPY), 0,0086 % (QQQ), 0,0166 % (CSCO), 0,1309 % (BGS); el
oficial no es reproducible de forma exacta desde el feed intradía (diferencia
de ticks).

### 3.3 El `volume` diario es el consolidado de todo el día, y el feed intradía excluye operaciones grandes

El extendido (04:00-20:00) es mucho más cercano que la RTH (2,5-3,0 % frente a
12-16 % en SPY/QQQ), pero siempre **por debajo** de la diaria:

| símbolo | ausentes mediana (acciones) | % del volumen diario | % máx | n ausente (% de n) |
|---|---|---|---|---|
| SPY | 1 883 068 | 2,96 % | 6,00 % | 0,054 % |
| QQQ | 1 142 624 | 2,52 % | 6,04 % | 0,046 % |
| CSCO | 5 345 157 | 29,16 % | 60,97 % | 0,538 % |
| BGS | 190 613 | 9,79 % | 49,35 % | 3,131 % |

Descarte de causas, con evidencia:

1. **No son las subastas.** La barra 1m de 09:30 (mediana 49,1× la mediana de
   minuto en SPY) y la de 16:00 (20,3×) ya contienen la apertura y el cierre
   subastados dentro de la suma extendida. En BGS la barra de 16:00 es 0,5× la
   mediana (subasta pequeña y no siempre en esa barra).
2. **No son los minutos sin operaciones.** Correlación (ausentes %, minutos
   sin operaciones) = 0,356 en SPY: débil. Los días peores de CSCO tienen
   473-522 minutos sin operaciones, pero también los días normales (~487).
3. **No depende de la granularidad.** Σ1m == Σ5m al céntimo en los días
   solapados (2026-11-02: 49 198 027 en ambos; 2026-11-09: 47 262 713 en
   ambos) y la brecha se repite en la ventana 2023-24 medida con 5m
   (mediana 2,45 %, 72 días). La exclusión ocurre antes de agregar barras.
4. **Son pocas operaciones, grandes.** El tamaño medio de las operaciones
   ausentes frente al típico: SPY 58,6× (mediana), QQQ 47,1×, CSCO 77,0×,
   BGS 3,6×. En SPY faltan 488 transacciones de mediana (0,054 % de n) para
   1,88 M de acciones.

**Hipótesis (no verificable con estas muestras):** la diaria consolida el
volumen de todo el día incluyendo operaciones que el agregado intradía
excluye — bloque/cruces y reportes tardíos o fuera de secuencia con
condiciones de venta (p. ej. imprimirse después del cierre en su hora real).
Verificaría con datos tick o comparando por condiciones de venta; fuera del
alcance de estas muestras.

Caso de contexto (SPY 2026-11-06): diaria 58 978 818,62; Σ1m EXT
56 361 931,11 → **2 616 887,51 (4,44 %)**; Σ1m RTH 48 543 478,62 →
10 435 340,00 (17,69 %); n diaria 826 775 vs Σn EXT 825 943 → 832 (0,10 %).
El 4,44 % está en la parte alta de la distribución (mediana 2,96 %), no es
anómalo.

### 3.4 El `vw` diario es el VWAP del día completo

El derivado EXT coincide mejor que el RTH en SPY/QQQ (mediana 0,006 % frente
a 0,021 %) y queda igual en CSCO/BGS (~0,11 % / ~0,06 %): la diaria calcula su
vw sobre el día completo consolidado.

### 3.5 La diaria del día en curso no existe durante la sesión

- El fichero 1D capturado el sábado 15:07 ET posterior a la sesión ya contiene
  la diaria del viernes 2026-11-06. No hay captura 1D intra-sesión que fije el
  instante exacto de publicación (¿cierre 20:00 ET?, ¿medianoche ET?): la
  afirmación «hasta medianoche» es plausible pero **no verificable** con estas
  muestras.
- Verificado que la diaria de cada día de referencia existe en las capturas
  posteriores (los ficheros del 2026-11-06 y del 2026-11-09 contienen la
  diaria de su día); el instante de publicación dentro del día no es
  verificable con capturas post-cierre.

## 4. Recomendación: construir la diaria del día en curso

Regla propuesta (día D sin diaria del proveedor), con 1m ya en el buffer:

| campo | fuente | error frente a la diaria histórica |
|---|---|---|
| open, high, low | 1m RTH (09:30-16:00 ET) | exacto (mediana 0,0000 %) |
| close | última barra RTH cerrada | mediana 0,007-0,13 % según liquidez |
| volume | Σ1m 04:00-20:00 ET | −2,5 % a −3 % (SPY/QQQ); mayor en ilíquidos |
| vw | Σ(vw·v)/Σv sobre 1m 04:00-20:00 ET | mediana 0,006 % |

Demostración con SPY 2026-11-09 (construido durante la sesión vs lo que
Massive publicó después):

| | o | h | l | c | v | vw |
|---|---|---|---|---|---|---|
| Massive (después) | 741,95 | 755,42 | 741,025 | 752,69 | 50 281 221 | 750,5732 |
| build RTH | 741,95 | 755,42 | 741,025 | 752,65 | 39 958 693 | 750,4613 |
| build EXT | 738,37 | 755,42 | 734,05 | 752,51 | 47 262 713 | 750,4631 |

El build RTH clava OHLC pero pierde el 20,5 % del volumen; el build EXT
aproxima volumen/vw pero falsea open/low. **La regla mixta es la única
comparable con la diaria histórica:**

1. **Para EMA diaria** solo importa el `close`: derivar RTH. El sesgo frente
   al oficial (≤0,13 % mediana, de ticks) se corrige solo cuando la diaria del
   proveedor reemplace a la construida.
2. **Para AVWAP diario** importan `vw` y `volume`: derivar EXT (la diaria
   histórica de Massive es full-day en v/vw, mediana 0,006 %).
3. Al aparecer la diaria del proveedor (existe en capturas del día siguiente),
   **sustituir** la barra construida; los umbrales de este documento sirven
   como verificación del reemplazo.
4. No inventar el `close` oficial ni el volumen faltante (~3 %): rellenarlos
   introduciría un dato fabricado (SPEC: prohibido).

## 5. Limitaciones

- No hay muestras fuera de 04:00-20:00 ET: las operaciones 20:00-04:00 no se
  pueden medir (parte de la brecha podría vivir ahí).
- La causa exacta de la exclusión intradía es hipótesis (3.3).
- El instante de publicación de la diaria del día en curso no es verificable
  con capturas post-cierre.
- GLDD delisted (última diaria 2026-03-31): excluido; BGS lo sustituye.
- Los scripts de captura/análisis de este documento son desechables (fuera del
  repo); las muestras crudas quedan en `fixtures/samples/` y el método está
  descrito en §1 para reproducirlo.

## 6. Decisiones pendientes

1. ¿Commitear las muestras nuevas (QQQ/CSCO/BGS/GLDD, ~27 MB en 1m)? Sin ellas
   los números del documento no son reproducibles offline.
2. ¿Añadir `--symbol` a `tools/capture_samples.py` (pieza futura con tests)
   para reproducir estas capturas con la herramienta oficial?
3. ¿Convertir la regla de §4 en pieza del motor (SPEC) cuando toque la diaria
   del día en curso?
