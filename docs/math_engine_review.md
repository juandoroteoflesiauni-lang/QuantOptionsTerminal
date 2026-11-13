# Revisión del núcleo de matemática contra el SPEC (solo lectura)

Fecha: 2026-11-12 · Alcance: `src/core/{ema,sessionVwap,avwap,welford,sessions}.ts` contra `SPEC.md` (puntos 1-5, 8 y 9), sobre la serie en horario extendido (premarket + RTH + after-hours) en 1m/5m/15m/30m/1h/4h/1D.

**Método.** Lectura del core y del SPEC, más sondas Python independientes (reglas del SPEC reimplementadas desde cero, sin copiar el TypeScript) ejecutadas sobre las muestras reales de `fixtures/samples/`. Todos los números de este documento salen de esas sondas. Este documento NO modifica código: las propuestas quedan sin implementar y lo no verificado va marcado **[HIPÓTESIS]**.

## Correcciones (2026-11-12, tras revisión del dueño)

**La diaria parcial del día en curso SÍ la devuelve el proveedor, y el cargador la excluye.** Las secciones a) y c) analizan la parcial como evidencia de lo que el proveedor puede entregar (fila 2026-11-10 del 1D: v=19,629,075 con la sesión abierta), pero por la ruta del cargador esa parcial nunca llega al core:

- La petición 1D usa `to = dateKey(now)` (día en curso incluido; `src/data/loader.ts`, `massiveWindow`, líneas 993-996), de modo que el proveedor SÍ devuelve la diaria parcial.
- El normalizador la detecta como barra en formación con un caso diario explícito (`src/data/normalizeMassive.ts`, `detectFormingBar`, líneas 48-58: «Las barras diarias de Massive abren a 00:00 ET. La barra en formación es la de la fecha ET actual… se compara la clave de sesión») y `excludeFormingBar` la elimina antes de exponer `bars` (`src/data/loader.ts`, líneas 755-762).
- Consecuencia: el repintado de la EMA diaria (±1.4936 por ±1% del cierre parcial) y el AVWAP SESSION 1D con parcial (747.9400) documentados arriba no pueden ocurrir vía `loadBars`; siguen siendo válidos como evidencia de capacidad del proveedor y como análisis de rutas alternativas. La pieza futura del motor queda reducida a la proyección en vivo contra la serie de diarias cerradas (`projectLiveEma`), no al filtrado de la parcial (ya filtrado).

## Muestras usadas

El nombre NO es la fecha de captura: `*_2026-11-09.json` se capturó el 2026-11-10 entre 17:47Z y 17:56Z, con la sesión del 11-10 en curso (por eso la última fila de cada timeframe es una barra en formación y el 1D contiene la diaria parcial del 11-10).

| muestra | filas únicas | rango ET | captura |
|---|---|---|---|
| `SPY_1m_2026-11-09.json` | 52,797 | 2026-02-23 04:00 → 2026-11-10 12:47 | 17:47:51Z |
| `SPY_5m_2026-11-09.json` | 13,202 | 2023-11-06 04:00 → 2026-11-10 12:45 | 17:48:58Z |
| `SPY_15m_2026-11-09.json` | 4,375 | 2018-08-23 04:00 → 2026-11-10 12:51 | 17:50:54Z |
| `SPY_30m_2026-11-09.json` | — | hasta 2026-11-10 12:23 | 17:53:15Z |
| `SPY_1h_2026-11-09.json` | 1,262 | 2003-09-10 08:00 → 2026-11-10 12:00 | 17:53:27Z |
| `SPY_4h_2026-11-09.json` | — | hasta 2026-11-10 12:00 | 17:55:47Z |
| `SPY_1D_2026-11-09.json` | 5,830 | 2003-09-10 → 2026-11-10 | 17:56:00Z |
| `BTC-USDT_1m_2026-11-06.json` | 2,632 | 2026-11-05 19:00 → 2026-11-07 14:51 | — |

- `vw` utilizable en SPY 1m: 52,797/52,797 (0 barras con `v==0`, 0 con `vw` no utilizable). Lo mismo en 5m/15m/1h/1D.
- BTC viene en filas array `[t, o, h, l, c, v, endTime, quoteVolume]`: sin `vw` (correcto: el VWAP de cripto usa HLC3), y 0 barras con `v==0` en 2,632.

---

## a) EMA (`src/core/ema.ts`, SPEC punto 2)

### Reglas del código

`calculateEma(closes, period)`: NaN en los índices 0..period-2; semilla = SMA de los primeros `period` cierres en el índice period-1; después `ema = alpha*close + (1-alpha)*emaPrevio` con `alpha = 2/(period+1)`. Un cierre no finito deja ese índice y TODOS los siguientes en NaN (sin arrastrar último valor válido ni reiniciar). `computeEmaSuite` calcula 9/21/50/200. `emaWarmupWeight(200, 1000) ≈ 4.54e-5` (testeado en `tests/ema.test.ts`), y la muestra 1m (52,797 barras) cubre de sobra el calentamiento de 1,000 velas del SPEC; también el 1D (5,829 diarias cerradas).

### Salto premarket → RTH (1m, 2026-11-09)

No hay salto estructural: la EMA no distingue fases de sesión, trata la serie como índices consecutivos.

| hora ET | close | ema9 | Δ ema9 |
|---|---|---|---|
| 09:28 | 742.38 | 741.9030 | +0.1192 |
| 09:29 | 742.03 | 741.9284 | +0.0254 |
| 09:30 | 741.34 | 741.8107 | −0.1177 |
| 09:31 | 741.68 | 741.7846 | −0.0261 |
| 09:32 | 742.60 | 741.9477 | +0.1631 |

Los deltas en 09:30-09:32 son del mismo orden que los de 09:28-09:29: la frontera de sesión no produce discontinuidad. Contexto de volatilidad por minuto ese día: mediana de |Δclose| premarket 0.1050 (n=312), RTH 0.1016 (n=389), after-hours 0.0600 (n=223) — el extendido se mueve por minuto casi igual que el RTH, así que una EMA sobre serie extendida reacciona igual antes y después de las 09:30.

### Entre días sin relleno

Viernes 2026-11-06 19:59 (close 736.53, ema9 736.3620) → lunes 2026-11-09 04:00 (close 738.31, ema9 736.7516). El hueco de fin de semana (56.0 h sin barras) se trata como índices consecutivos: el valor no expira ni se re-ancla; la primera barra del lunes entra con el mismo alpha. Con semilla años atrás el peso residual de la semilla es despreciable (`emaWarmupWeight`).

### Proyección en vivo: `projectLiveEma`

Firma: `projectLiveEma(lastClosedEma, livePrice, period) = alpha*livePrice + (1-alpha)*lastClosedEma` (NaN si alguna entrada no es finita; periodo inválido lanza). Es pura y NO lee barras: el precio vivo lo pasa el motor (aún no construido) y la semilla debe ser la EMA de la última barra CERRADA, nunca la proyección del tick anterior (documentado en el propio código y fijado por tests: directo vs encadenado, casos NaN, periodo inválido — `tests/ema.test.ts` líneas 227-276).

La responsabilidad de que la semilla sea la EMA de la última CERRADA es del motor: si le pasa la EMA calculada sobre una serie que ya incluye la barra parcial, encadena dos veces la parcial (números abajo).

### La barra 1D del día en curso

El proveedor SÍ devuelve la diaria parcial del día en curso: el escenario `latest` del 1D trae la fila 2026-11-10 (o=747.94, h=752.139, l=744.86, c=746.821, v=19,629,075, n=390,231), capturada a las 12:56 ET con la sesión abierta; los escenarios `day`/`max` terminan en el 11-09 cerrado.

Con la serie de diarias CERRADAS (5,829 barras, 2003-09-10 → 2026-11-09):

| magnitud | valor |
|---|---|
| EMA9 diaria @ 2026-11-09 (cerrada) | 752.4468 |
| EMA21 diaria @ 2026-11-09 (cerrada) | 759.3232 |
| EMA9 @ 11-10 con la parcial añadida a la serie | 751.3217 |
| EMA21 @ 11-10 con la parcial añadida | 758.1867 |
| `projectLiveEma` correcto (semilla = EMA cerrada 11-09, precio vivo = 746.821) | ema9 = 751.3217, ema21 = 758.1867 |
| Variante INCORRECTA (semilla = EMA que ya incluyó la parcial) | ema9 = 750.4215 |

Dos observaciones importantes:

1. Añadir la parcial a la serie y leer el ÚLTIMO valor es matemáticamente idéntico a la proyección correcta del SPEC (en el último índice la recurrencia es `alpha*c_parcial + (1-alpha)*EMA_11-09`). El peligro no es la parcial en sí, sino (i) leer ese valor como punto de HISTORIA: repinta durante toda la sesión (un ±1% en el cierre parcial mueve la EMA9 del día ±1.4936 = alpha×Δcierre = 0.2×7.47), y (ii) encadenar otra proyección encima de la EMA-con-parcial: doble recuento (750.4215 vs 751.3217; diferencia = alpha(1-alpha)×(precio_vivo − EMA_cerrada) = −0.9002).
2. La misma pauta se repite en los demás timeframes (última cerrada → parcial de las ~12:47 ET del 11-10):

| timeframe | última cerrada | EMA9/21 cerrada | parcial (stamp, close) | EMA9/21 con parcial |
|---|---|---|---|---|
| 5m | 12:40 | 749.4747 / 751.3313 | 12:45, 745.86 | 748.7518 / 750.8339 |
| 15m | 12:36 | 749.1643 / 750.9049 | 12:51*, 745.64 | 748.4595 / 750.4263 |
| 1h | 11:00 | 748.4787 / 737.4938 | 12:00, 746.1818 | 748.0193 / 738.2837 |

\* stamp desplazado por el hallazgo de cuadrículas (ver sección d, caso 6).

La regla de qué hacer con la diaria del día en curso (excluirla de la serie cerrada y proyectarla en vivo, o incluirla con la marca de parcial) ya está registrada como pieza futura del motor (ver Correcciones: el cargador ya excluye la parcial); el core hoy no filtra nada: `calculateEma` calcula sobre lo que reciba.

---

## b) sessionVwap (`src/core/sessionVwap.ts`, SPEC puntos 4 y 8)

### Confirmación: solo RTH, congelado fuera

En EQUITY acumula únicamente con `isRthFromParts` (09:30 ≤ t < 16:00 ET, lunes a viernes); el reset diario es por `dateKey` (línea 193-196); fuera de RTH emite `frozen=true` con el último valor de la sesión (`source='NONE'`), o NaN con `cumVolume=0` si la sesión aún no tiene ninguna barra RTH (premarket de la mañana). CRIPTO acumula todo y reinicia a medianoche UTC, nunca congela.

Números del 11-09 con 1m (sonda independiente):

- Primera barra RTH 09:30: vwap = 741.8939.
- Última barra RTH 15:59: vwap = 750.4613, cumVolume = 39,958,693 (= suma exacta del volumen RTH 1m: premarket 1,382,980 + RTH 39,958,693 + AH 5,921,041 = 47,262,713 extendido).
- Fuente de precio: `VW` en las 390/390 barras RTH (todas con `vw` finito > 0); el fallback HLC3 por barra no se usó ni una vez en esta muestra.
- Desde 16:00 en adelante: vwap congelado en 750.4613 con `frozen=true` y cumVolume sin cambios; en premarket (04:00-09:29): vwap = NaN congelado.
- Validaciones: `barSeconds` debe dividir 1800 en EQUITY (SPEC punto 8) → 1m/5m/15m/30m aceptados; 1h/1D rechazados. El cargador construye el 1h de acciones agregando 30m (`aggregateRth1h`), con la ventana RTH recortada por intersección temporal (ver `tests/dataAlignment.test.ts` 598-626).

### Propuesta SIN implementar: VWAP de premarket y de after-hours por separado

Motivo: las EMA usan la serie extendida (decisión vigente) pero el VWAP de sesión solo cubre RTH; quien mira 04:00-20:00 no tiene precio medio ponderado antes de las 09:30 ni después de las 16:00. Volumen disponible por fase el 11-09: PRE 1,382,980 (313 barras), RTH 39,958,693 (390), POST 5,921,041 (224) — fases con señal propia.

Diseño esbozado (decisión del dueño; no implementado):

- **Opción A — parámetro de fase**: extender `calculateSessionVwap` con `sessionPhase?: 'RTH' | 'PRE' | 'POST'` (solo EQUITY; CRYPTO lo ignora). Ventanas ET: PRE = 04:00 ≤ t < 09:30, RTH = 09:30 ≤ t < 16:00 (igual que hoy), POST = 16:00 ≤ t < 20:00. El reset diario sigue siendo por cambio de `dateKey`; fuera de la ventana de la fase se emite `frozen` con el último valor de ESA fase del día (NaN antes de su primera barra). La regla `barSeconds | 1800` no cambia: 04:00 y 20:00 caen en fronteras de 30 m.
- **Opción B — una pasada, tres series**: función nueva que devuelva `{ rth, pre, post }` con estados Welford independientes; evita recorrer tres veces pero cambia el contrato de retorno (no reutiliza `SessionVwapSeries`).
- **[HIPÓTESIS]** 04:00 ET como inicio del extendido y 20:00 como fin del AH son las ventanas del proveedor (evidencia: los días completos de las muestras van de 04:00 a 19:59). Confirmar con el dueño antes de implementar.

### Advertencia de datos (pertenece a la capa de datos, no al core)

Si la serie 15m/30m llega con la cuadrícula de sellos desplazada (caso 6 de la sección d), la atribución RTH se desplaza hasta una barra: la ventana [09:21, 09:36) sellada 09:21 se clasifica premarket y sus ~6 min de volumen RTH quedan fuera del VWAP de sesión; simétricamente [15:51, 16:06) sellada 15:51 entra como RTH con ~6 min de AH. El core no tiene forma de detectarlo (no valida sellos ≡ 0 mod barSeconds).

---

## c) AVWAP (`src/core/avwap.ts`, SPEC puntos 5 y 9)

### Dónde se puede anclar y qué acumula

- El anclaje NO filtra horario: acumula todas las barras recibidas desde el ancla (precio HLC3 = (h+l+c)/3, peso `bar.volume`; NUNCA usa `vw`).
- `SESSION` (EQUITY) = primera barra RTH de la última fecha del buffer; si esa fecha aún no tiene barra RTH, −1. `WEEK/MONTH/YTD` = primera barra de la clave de periodo retrocediendo desde la última barra. `HIGH_VOLUME_BAR` y `FULL_HISTORY` se evalúan solo sobre el rango visible.

Consecuencia práctica con la serie extendida:

- `SESSION` nunca ancla en premarket (usa la primera RTH). Pero una vez anclado a las 09:30, acumula TAMBIÉN el AH: 15:59 → 751.1861 (cumV 39,958,693), 16:13 → 751.3622, 19:59 → 751.4258 (cumV 45,879,733 = RTH 39,958,693 + AH 5,921,041, consistente con la descomposición por fases).
- `WEEK/MONTH/YTD` SÍ pueden anclar en una barra de premarket: la semana del 11-09 arranca en la barra de 04:00 (o=738.37, h=738.94, l=734.37, c=738.31, v=10,493): avwap WEEK 09:30 = 740.9931 (cumV 2,049,952 — ya incluye 2.05M de premarket), 15:59 = 750.8368, 19:59 = 751.1132.
- `HIGH_VOLUME_BAR` del 11-09 en 1m cae en AFTER-HOURS: 16:13 ET, v=3,351,360. Un ancla "máximo volumen" puede quedar fuera del RTH.
- Fuente de precio: AVWAP usa HLC3 por barra; sessionVwap usa `vw` por barra (TRADE_VWAP). En 15:59 del 11-09: 751.1861 vs 750.4613 = **+0.0966%**. Ambas fuentes están autorizadas por el SPEC (punto 4 TRADE_VWAP con fallback HLC3; punto 5 HLC3); la diferencia es estructural, no un defecto. Nota: no existe un test que fije que AVWAP ignora `vw` aunque las barras lo traigan (ver d, caso 4).

### 1m frente a 1D

La diaria oficial del 11-09: o=741.95, h=755.42, l=741.025, c=752.69, v=50,281,221, vw=750.5732, n=726,313.

1. **Composición del precio**: o/h/l oficiales coinciden EXACTAMENTE con la ventana RTH del 1m (741.95/755.42/741.025; el mínimo premarket 734.05 de las 04:01 queda excluido), pero el cierre oficial (752.69) supera el cierre de la barra 15:59 (752.65) — **[HIPÓTESIS]** incluye la subasta de cierre de las 16:00.
2. **Volumen**: el oficial (50,281,221) EXCEDE la suma 1m extendida 04:00-20:00 (47,262,713) en +3,018,508 (+6.00%). La descomposición cuadra RTH+PRE+AH con el extendido, así que el excedente no está en la muestra — **[HIPÓTESIS]**: sellos fuera de 04:00-20:00 o diferencias de agregación del consolidado; remite a `docs/daily_vs_intraday.md`.
3. **Consecuencia para el anclaje**: un AVWAP anclado en 1m usa la composición real por minuto (y puede anclar en premarket/AH, ver arriba); anclado en 1D usa la diaria oficial (precio de ventana RTH, volumen mayor). `SESSION` resuelta sobre 1D es el HLC3 de UNA barra: 749.7117 con la serie cerrada (11-09: (755.42+741.025+752.69)/3, v=50.28M) o 747.9400 si la serie incluye la parcial del 11-10 (v=19.63M). Un lunes, `SESSION == WEEK == MONTH == YTD` (todas resuelven a la misma barra).

### Advertencia de datos

Con cuadrícula desplazada, el ancla SESSION salta a la primera barra SELLADA ≥ 09:30 (p.ej. 09:36) y el volumen de 09:30-09:36 queda fuera del AVWAP; en 4h desplazada el ancla caería en el sello 12:00 (2.5 h tarde). Caso 6 de la sección d.

---

## d) Casos límite no cubiertos por tests

| # | caso | qué existe hoy | hueco concreto |
|---|---|---|---|
| 1 | Medias sesiones / cierre anticipado | `isRth` modela 09:30-16:00 incondicional (el comportamiento con feriado está fijado por test, `tests/sessions.test.ts:187`; la clave de semana sí cubre lunes feriado, :175-184) | Sin test de `sessionVwap`/AVWAP en un día de cierre anticipado. Caso concreto: 2026-11-27 (cierre 13:00 ET): `sessionVwap` seguiría acumulando sellos 13:00-15:59 como RTH; **[HIPÓTESIS]** el feed emitiría volumen AH desde las 13:00 y contaminaría el VWAP. No hay muestra de un día así (pedirla como pieza futura). |
| 2 | DST | Cubierto a nivel `sessions` (barrido contra Python) y en loaders (lm19/lm29) | Falta un test de acumulación (`sessionVwap`/AVWAP) que cruce un cambio de hora con barras a ambos lados. Por construcción (reset por `dateKey` + partes ET) debería ser benigno — **[HIPÓTESIS]**, sin test que lo fije. |
| 3 | Barras con volumen 0 | Welford a nivel unidad: V ≤ 0 o no finito no cambia el estado; primera barra con V>0 inicializa; sin emisión con cumWeight 0 (fixtures) | Sin test de integración de una sesión completa con v==0 (AVWAP no emitiría nada, `sessionVwap` NaN congelado) ni del ancla `HIGH_VOLUME_BAR` con rango visible de solo volumen 0. Sin muestra real: SPY 1m 0/52,797 y BTC 0/2,632 barras con v==0. |
| 4 | `vw` ausente | `sessionVwap`: fallback HLC3 por barra testeado (`tests/sessionVwap.test.ts:155`); cripto ignora `vw` (:189) | AVWAP no usa `vw` por diseño pero no hay test que lo fije (las barras del fixture con `vw` distinto de HLC3 deberían dar el mismo AVWAP). Riesgo bajo, costo del test bajo. |
| 5 | Símbolo suspendido | AVWAP: array vacío → −1 y [] (testeado); EMA: serie corta → NaN; `sessionVwap`: sin barras RTH → NaN congelado | **Corrección (2026-11-13)**: las respuestas del cargador viven en el fixture JSON (`fixtures/data_layer_reference.json`), no en el `.ts` — la búsqueda original grepeó el archivo equivocado. `results: []` YA tenía test (`lm9`, `lb4`; desde `cb17f43` también `lm44`, la clave `results` ausente) y HTTP 404 quedó cubierto en `cb17f43` (`lm46`/`lb18`). Sigue sin test el motor: la proyección en vivo sobre símbolo sin datos no existe aún. |
| 6 | **Cuadrícula de sellos desplazada** (hallazgo nuevo) | Nada lo detecta hoy, ni core ni (por confirmar) cargador | Ver detalle abajo. Caso concreto en las propias muestras. |

### Caso 6 en detalle: cuadrículas de sellos desplazadas

Hechos medidos en las muestras (todas capturadas el mismo día, escenarios `latest` con `to` = instante de captura, no alineado):

| timeframe | `to` de la petición | sellos de las filas del 11-10 | fase (mod timespan) |
|---|---|---|---|
| 1m | 17:48:45.927Z | 12:45/12:46/12:47 | 0 (alineada) |
| 5m | 17:50:03.759Z | …12:40/12:45 | 0 (alineada; el minuto :50 ≡ 0 mod 5) |
| 15m | 17:51:58.618Z | 11:51/12:06/12:21/12:36/12:51 | **6 min (desplazada)** |
| 30m | 17:53:15.228Z | …11:53/12:23 | **23 min (desplazada)** |
| 1h | 17:54:31.833Z | 10:00/11:00/12:00 | 0 (alineada) |
| 4h | 17:55:47.934Z | 04:00/08:00/12:00 | **+1 h (desplazada)** |
| 1D | 2026-11-10 (fecha) | 11-06/11-09/11-10 | 0 (alineada) |

La fila 15m sellada 12:51 es la barra en formación (v=186,835): bajo la cuadrícula desplazada su ventana es [12:51, 13:06), de la que habían transcurrido 58.6 s en el `to` de la petición (12:51:58.618 ET); alineada, esa misma ventana se sellaría 12:45. La cuadrícula completa está desplazada +6 min respecto de la época. Las filas del 11-09 del MISMO archivo (peticiones con `from/to` en fronteras de día) están alineadas (fase 0, sellos 04:00…19:45).

**[HIPÓTESIS — RECHAZADA el 2026-11-12 por la sonda `c7ec318`; ver Resolución abajo]** regla unificada que explica los siete casos: la cuadrícula se ancla a `floor(to, unidad)` (minuto para timespans de minutos, hora para timespans de horas). Cualquier petición cuyo `to` no esté alineado al timespan A ESA unidad produce cuadrícula desplazada: 5m sale alineada solo cuando el minuto de `to` es múltiplo de 5; 15m/30m/4h casi siempre desplazadas. No se pudo distinguir offline si el ancla es `from` o `to` (en las muestras ambos comparten fase: 7 días exactos entre extremos).

**Relevancia de producción**: el cargador envía `from` alineado (`alignDown`) pero `to = Math.floor(Date.now()/1000)*1000` (`src/data/loader.ts`, líneas ~321 y ~1006). Si el ancla resulta ser `to`, las cuadrículas en vivo de 5m (80% de las peticiones), 15m (~93%), 30m (~97%) y 4h (75% de las horas) saldrían desplazadas, y el core atribuiría mal las fronteras de sesión hasta una barra (sección b/c). Si el ancla es `from`, producción está a salvo y el sesgo solo afectaría peticiones con `from` sin alinear (como el capturador de muestras). Piezas futuras propuestas (a decisión del dueño, NO implementadas aquí): (1) sonda en vivo de 2 peticiones (`from` alineado + `to` alineado vs `to` crudo) para determinar el ancla; (2) chequeo de sellos en el cargador (`bar.time % barSeconds === 0` para Massive/acciones) o estrategia de petición que garantice cuadrícula alineada.

**Resolución (2026-11-12, sonda `tools/probe_grid_anchor.py`, commit `c7ec318`).** La sonda ejecutó el experimento discriminante del dueño (8 peticiones × 13,001 s, 0×429, todas HTTP 200): `from` fijo alineado a 04:00 ET (2026-11-11 09:00:00Z) y `to` fijo en un segundo arbitrario no alineado (13:34:56 ET = 18:34:56Z), para 5m/15m/30m/4h con sort=asc y sort=desc. Resultado: **las 8 respuestas salen con la fase de `from`** — 5m/15m/30m con fase (0, 0) UTC/ET; 4h con sellos 04:00/08:00/12:00 ET (fase UTC 3,600,000 ms = la hora de `from`; fase ET 0) — y no con la de `to` (240,000 ms en los timespans de minutos; 7,200,000/3,600,000 en 4h) ni con la de la época (0 / 10,800,000 en 4h). Separación exactamente igual al timespan, sin huecos; asc y desc idénticos; la última cubeta de cada serie está en formación con sello de INICIO sobre la rejilla de `from` (la 5m de 13:30 en curso a las 13:34:56 ET). **La hipótesis «se ancla a floor(to, unidad)» queda RECHAZADA: la rejilla se ancla a `from`, alineado a la unidad.**

**Aclaración para producción**: el cargador SIEMPRE envía `from` alineado (`alignDown` en intradía, la ruta de ventanas 1800 en rthOnly+1h, cadenas de fecha en 1D), así que las rejillas en vivo están alineadas y el chequeo de sellos propuesto como pieza (2) NO hace falta. En cambio, una petición con `from` SIN alinear — como las del escenario `latest` del capturador de muestras (sort=desc, `from = to − 7 días` con segundo arbitrario) — SÍ sale con la rejilla desplazada al ancla `floor(from, unidad)`: es exactamente lo medido en las muestras (15m +6 min, 30m +23 min, 4h +1 h; tabla de arriba). Esas filas valen como EVIDENCIA, no para construir velas: cualquier construcción de velas debe partir de peticiones con `from` alineado (o agregarse desde 1m).

---

## Conclusión

- El core cumple el SPEC en todos los casos concretos examinados: EMA (semilla SMA, NaN estrictos, proyección en vivo pura), sessionVwap (RTH-only con reset diario y congelado documentado), AVWAP (HLC3 + volumen, anclas de periodo y visibles), Welford (recurrencia del punto 1) y sessions (partes ET/UTC, claves de semana/mes/año).
- Las diferencias numéricas observadas (AVWAP vs sessionVwap +0.0966% el 11-09) provienen de fuentes de precio distintas AUTORIZADAS por el SPEC, no de defectos.
- El hallazgo relevante no es del core sino de datos: cuadrículas de sellos desplazadas en peticiones con extremos sin alinear (15m/30m/4h en las muestras), con impacto potencial en la atribución de sesiones. Requiere sonda en vivo antes de cualquier cambio. **Resuelto el 2026-11-12** (sonda `c7ec318`): el ancla es `from`; producción (que envía `from` alineado) está a salvo — ver «Caso 6 en detalle».
- Piezas futuras registradas (ninguna implementada aquí): regla de la diaria del día en curso (motor), sonda del ancla de cuadrícula (**ejecutada**: commit `c7ec318`, ancla = `from`; chequeo de sellos descartado por innecesario), VWAP por fases (propuesta b), muestra de cierre anticipado + test de integración, test de independencia de `vw` en AVWAP, tests de serie vacía/suspendido en el cargador.
