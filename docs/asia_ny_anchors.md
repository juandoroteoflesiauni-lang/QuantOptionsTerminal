# Anclas «apertura de Asia» y «apertura de NY» (solo lectura, 2026-11-13)

**Método.** Lectura de `src/core/avwap.ts`, `src/core/sessions.ts`, `src/data/alignment.ts` y `SPEC.md`, más una sonda Python independiente (temporal, fuera del repo) sobre las muestras reales `fixtures/samples/SPY_1m_2026-11-06.json` y `SPY_1m_2026-11-09.json` (días normales, 04:00-19:59 ET). La sonda reimplementa el Welford ponderado del SPEC punto 1 con precio HLC3 y compara dos AVWAP anclados a 04:00 ET y 09:30 ET sobre la MISMA serie 1m. Este documento NO modifica código ni propone cambios sin caso numérico.

---

## 1. ¿Cómo se define hoy el ancla del AVWAP?

**Solo seis tipos, ningún timestamp arbitrario.** `AvwapAnchor = 'SESSION' | 'WEEK' | 'MONTH' | 'YTD' | 'HIGH_VOLUME_BAR' | 'FULL_HISTORY'` (`src/core/avwap.ts:41-47`). La API tipada `computeAnchoredVwap(bars, anchor: AvwapAnchor, options)` (`avwap.ts:418-439`) resuelve el índice con `resolveAnchorIndex` (`avwap.ts:279-317`), que solo acepta esos seis valores y lanza error en cualquier otro (`avwap.ts:314-315`).

**Matiz: índice sí, timestamp no.** La función de nivel inferior `calculateAnchoredVwap(bars, anchorIndex)` (`avwap.ts:405-413`) acepta un índice entero CUALQUIERA (inválido → `[]`), pero un índice no es un timestamp: el llamador tendría que resolver «primera barra con time ≥ T» por su cuenta. No existe hoy ninguna ancla por instante arbitrario.

**Resolución respecto de la ÚLTIMA barra** (SPEC punto 9, `SPEC.md:11`): SESSION/WEEK/MONTH/YTD caminan hacia atrás mientras la clave del periodo coincida (`resolveSessionAnchorIndex`, `avwap.ts:147-190`; `resolvePeriodAnchorIndex`, `avwap.ts:195-237`). SESSION en EQUITY es la primera barra RTH (09:30 ET) de la última fecha; si esa fecha aún no tiene barra RTH, ancla inválida (−1). SESSION en CRYPTO es la primera barra de la fecha UTC. HIGH_VOLUME_BAR y FULL_HISTORY se evalúan solo sobre `bars[visibleStart..]` (`avwap.ts:243-267`, `310-313`). Si el buffer empieza a mitad de periodo, el ancla es la primera barra del buffer (AVWAP parcial, límite documentado; `avwap.ts:16-21`, `175-178`).

**SPEC citado** (`SPEC.md:7`, punto 5): «AVWAP anclado: Welford sobre HLC3. Anclas: SESSION, WEEK (primera barra de la semana), MONTH, YTD, HIGH_VOLUME_BAR y FULL_HISTORY (estas dos solo sobre el tramo visible, para no depender del calentamiento). Ancla inválida (índice <0, >= largo o no entero) devuelve []. Bandas ±1, ±2 y ±2.5 sigma con el mismo sigma, sin recalcular.» Y punto 9 (`SPEC.md:11`): «la función no filtra horario; acumula todas las barras recibidas desde el ancla (si se quiere solo RTH, la capa de datos filtra antes)… Si el buffer empieza a mitad de un periodo, el ancla es la primera barra del buffer (AVWAP parcial, límite documentado).»

**¿Dos AVWAP con anclas distintas sobre el mismo buffer a la vez? SÍ.** Cada llamada es pura y sin estado compartido: `computeAnchoredVwap` crea `createInitialAvwapState()` por llamada (`avwap.ts:384`, `429`) y acumula desde su propio `anchorIndex` (`calculateFromAnchor`, `avwap.ts:379-399`); N anclas = N recorridos independientes del mismo array inmutable (coste O(buffer) por ancla). En vivo, cada ancla lleva su propio `closedState` y la regla es no encadenar el estado de una proyección como entrada de la siguiente (`projectLiveAvwap`, `avwap.ts:442-459`). La sonda del punto 4 computa exactamente eso: dos AVWAP sobre el mismo buffer.

---

## 2. Cripto (solo describir; BingX congelado)

**Día cripto hoy = 00:00 UTC.** `sessions.ts` resuelve las partes en la zona del mercado: EQUITY → `America/New_York` (con horario de verano), CRYPTO → `UTC` (`sessions.ts:61-70`; docstring `sessions.ts:4-7`; SPEC punto 3, `SPEC.md:5`). `dateKey`, `sessionKey`, `weekKey` (lunes de la semana), `monthKey` y `yearKey` son, para CRYPTO, claves UTC (`sessions.ts:264-290`). El VWAP de sesión cripto acumula TODAS las barras con reinicio a las 00:00 UTC y sin congelar (`sessionVwap.ts:1-16`; SPEC punto 4, `SPEC.md:6`).

**No existe noción de apertura de NY para cripto.** Las constantes RTH (`RTH_START_MINUTES`/`RTH_END_MINUTES`, `sessions.ts:34-35`) y `isRthFromParts` (`sessions.ts:247-254`) son semántica EQUITY (09:30-16:00 ET, lunes a viernes); nada del core mapea una hora civil ET para el mercado CRYPTO.

**Si el ancla fuera «09:30 ET» para cripto, el DST se manejaría así:**

- El instante del evento cambia por día: 13:30 UTC (EDT, −4h) o 14:30 UTC (EST, −5h). La conversión inversa hora-civil→UTC NO existe en el core: solo la capa de datos la tiene, `etWallTimeToUtc` (`src/data/alignment.ts:50-74`), que prueba los dos desfases y acepta el que reproduce la hora civil pedida; en el salto de otoño la hora duplicada resuelve a la PRIMERA ocurrencia (EDT se prueba primero) y la hora inexistente de primavera cae en el respaldo EST defensivo.
- La lectura (UTC→partes ET) sí es DST-correcta en el core vía `Intl` (`getMarketParts`, `sessions.ts:215-238`); lo que falta es la escritura (ET→UTC) para FIJAR el evento.
- Granularidad de BingX: rejillas alineadas a la época UTC en 1m/5m/15m/1h/4h y **1D abriendo a las 16:00 UTC (00:00 UTC+8)** (`alignment.ts:16-18`, `29`). Un ancla 13:30/14:30 UTC cae DENTRO de la barra 1h (13:00 o 14:00), dentro de la 4h (12:00-16:00) y a mitad de la diaria cripto → un ancla de evento en cripto gruesa necesita definir si ancla la barra que CONTIENE el evento o la primera que COMIENZA después.

---

## 3. Dos opciones para anclas de evento diario (sin implementar)

**Opción A — ancla de evento resuelta en el core (nuevo tipo), con la mecánica de SESSION.** Definir «primera barra de la última fecha cuya `minutesOfDay` ≥ evento en la zona del mercado», caminando hacia atrás mientras la clave de fecha coincida (el mismo bucle de `resolveSessionAnchorIndex`, `avwap.ts:175-178`). Para EQUITY, curiosamente, «apertura de Asia» sobre el feed real ES «primera barra de la última fecha» (la primera barra del día ET es la 04:00 — ver punto 4): ese índice ya se calcula hoy dentro de `resolveSessionAnchorIndex` antes del filtro RTH. «Apertura de NY» es literalmente el ancla SESSION actual (09:30 ET). Para CRYPTO el evento se definiría en UTC (Asia = 00:00 UTC+8 = 16:00 UTC fija, que coincide con la apertura de la diaria BingX; NY = 13:30/14:30 UTC variable por DST) o delegando la conversión en la capa de datos.
- **Pros:** coherente con el patrón existente (claves por barra, sin API de timestamps); DST gratis vía `getMarketParts` para EQUITY; semántica de buffer parcial ya documentada (SPEC punto 9); funciona en 1m/5m/15m/30m de acciones (04:00 y 09:30 caen en la rejilla; en 1h/4h el ancla es la primera barra cuyo open ≥ evento, p. ej. 10:00 en 1h — el mismo comportamiento que SESSION ya tiene hoy en 1h).
- **Contras:** cambia la unión/firma del core → exige actualización del SPEC (puntos 5 y 9); para CRYPTO falta la conversión ET→UTC en el core (habría que definirla o importar la noción de la capa de datos); en 1D degenera (ver abajo); el «evento Asia» para cripto exige elegir zona y hora (decisión del dueño, hoy no existe).

**Opción B — la app resuelve el instante y pasa un ÍNDICE (cero cambios de core).** `calculateAnchoredVwap(bars, anchorIndex)` (`avwap.ts:405-413`) ya acepta cualquier índice: el motor/buscador de la app convierte el evento del día a instante (con `etWallTimeToUtc` de la capa de datos o `Intl` propio) y busca la primera barra con `time ≥ T` (búsqueda binaria) antes de llamar.
- **Pros:** el core queda intacto (el SPEC no cambia); cualquier evento en cualquier zona (Shanghai 09:30 CST y Tokio 09:00 JST son UTC+8/+9 FIJOS, sin DST; solo NY requiere DST); la conversión vive donde ya vive el conocimiento de calendario (capa de datos); reutilizable para eventos futuros sin tocar tipos.
- **Contras:** se sale de la API tipada (la app no pasa por `resolveAnchorIndex` ni por la validación de tiempos de `validateTimesThroughSessions`, `avwap.ts:126-140` — el llamador debe garantizar segundos enteros); un índice fuera de rango devuelve `[]` (vacío, «—») y NO el comportamiento de AVWAP parcial del punto 9 → modo de fallo distinto que hay que aceptar/documentar; la proyección en vivo necesita re-resolver el índice en cada recarga del buffer.

**Efectos en warmup, sessionStartCovered y 1D (ambas opciones):**

- **Warmup (cargador):** los eventos son INTRADÍA (04:00 y 09:30 ET del día en curso) → el alcance necesario es ≤ 1 día extendido, cubierto por el lookback actual (13 días en 1m) **siempre que `rthOnly` sea false** (con `rthOnly` el filtro descarta el premarket y el ancla 04:00 es inalcanzable). Variantes periódicas («primera Asia de la semana/mes») agrandan el alcance: semanal ~5-6 días hábiles (cubierto), mensual ~23 hábiles (el lookback de 1m NO lo cubre → AVWAP parcial o cambio de lookback), anual ≈ 250 hábiles (hoy solo alcanzable con buffer 1D o FULL_HISTORY).
- **sessionStartCovered:** ese flag existe solo en el reporte de `sessionVwap`; AVWAP no tiene equivalente — su noción es el AVWAP parcial documentado (punto 9). Un ancla de evento diario se beneficiaría de un flag análogo («el buffer alcanzó el evento»): concepto NUEVO para el core en ambas opciones, y en la B además con el fallo `[]` fuera de rango.
- **1D:** ambos eventos degeneran — la diaria ES el día (ancla = la propia barra → AVWAP de 1 punto, sigma 0). En acciones 1D los anclas naturales ya existen (WEEK/MONTH/YTD). En cripto 1D (BingX, abre 16:00 UTC) la «apertura de Asia» (00:00 UTC+8 = 16:00 UTC) **coincide con la apertura de la propia diaria** → sería equivalente a SESSION-cripto en 1D; «NY open» queda a mitad de barra. Conclusión: los anclas de evento diario tienen sentido en 1m/5m/15m/30m (y con matices en 1h/4h), no en 1D.

---

## 4. Datos SPY: no hay tramo de Asia; anclas equivalentes y divergencia medida

**No existe tramo de Asia en el feed.** La ventana extendida de Massive es 04:00-20:00 ET: la primera barra 1m es 04:00 y la última 19:59 en ambos días normales (2026-11-06: 922 barras; 2026-11-09: 927). La ventana oscura 20:00-03:59 ET (5 h) es el hueco entre fechas que `detectGaps` salta. El horario asiático (Tokio 09:00-15:00 JST ≈ 19:00-02:00 ET; Shanghai 09:30-15:00 CST ≈ 22:30-04:00 ET) cae dentro de esa ventana oscura o del tape extendido YA en curso (16:00-19:59): la tarde es un único tape AH continuo (204/240 y 224/240 barras presentes) sin estructura separada de «sesión Asia». El feed de acciones no distingue quién opera, solo cuándo hay impresiones: «Asia» no es un segmento de datos para SPY, y sí lo sería (como evento horario) solo para cripto 24/7.

**Anclas equivalentes que SÍ existen en el feed:** apertura extendida/premarket **04:00 ET** (la barra 04:00 existe en ambos días) y apertura RTH **09:30 ET** (el ancla SESSION actual). Ambas sobre el mismo buffer sin filtro RTH (el AVWAP no filtra; el ancla decide el alcance).

**Divergencia medida (sonda independiente; vwap04 = anclado 04:00, vwap0930 = anclado 09:30; HLC3, Welford poblacional del SPEC punto 1):**

| Día | Minuto | vwap04 | vwap0930 | Δvwap | Δvwap % | σ04 | σ0930 | Δ banda ±2.5 |
|---|---|---|---|---|---|---|---|---|
| 2026-11-06 | 09:30 | 735.0549 | 735.3733 | −0.3184 | −0.0433% | 0.6763 | 0.0000 | +1.3722 |
| 2026-11-06 | 12:00 | 738.4600 | 738.8740 | −0.4141 | −0.0560% | 2.0470 | 1.7224 | +0.3975 |
| 2026-11-06 | 14:00 | 738.2997 | 738.5571 | −0.2574 | −0.0349% | 1.8185 | 1.6041 | +0.2787 |
| 2026-11-06 | 15:59 | 737.8958 | 738.0435 | −0.1477 | −0.0200% | 1.7045 | 1.5988 | +0.1165 |
| 2026-11-09 | 09:30 | 740.9931 | 741.5083 | −0.5152 | −0.0695% | 1.3362 | 0.0000 | +2.8252 |
| 2026-11-09 | 12:00 | 747.5509 | 748.1033 | −0.5524 | −0.0738% | 3.2240 | 2.6407 | +0.9058 |
| 2026-11-09 | 14:00 | 748.6737 | 749.1578 | −0.4840 | −0.0646% | 3.4848 | 2.9432 | +0.8698 |
| 2026-11-09 | 15:59 | 750.8368 | 751.1861 | −0.3493 | −0.0465% | 3.7226 | 3.2565 | +0.8158 |

Volumen: el premarket pesa **4.94 %** (11-06) y **3.46 %** (11-09) del acumulado del ancla 04:00 al cierre RTH (2.399.332 y 1.382.980 acciones vs 48.543.479 y 39.958.693). La divergencia es máxima al mediodía (−0.056 % / −0.074 %) y se diluye hacia el cierre (−0.020 % / −0.047 %); el ancla 04:00 arranca con σ premarket > 0 y el ancla 09:30 con σ = 0 (una sola barra). Ambos AVWAP se calcularon sobre el MISMO array de barras sin ningún estado compartido.

---

## Conclusión

- Hoy NO hay ancla por timestamp; el índice arbitrario ya existe a nivel de `calculateAnchoredVwap`, y las anclas tipadas son solo las seis del SPEC. Dos o más AVWAP con anclas distintas conviven sin problema (pureza por llamada).
- Para cripto no hay apertura de NY definida; el día es 00:00 UTC y una ancla 09:30 ET requeriría la conversión ET→UTC de la capa de datos (`etWallTimeToUtc`) y una decisión de granularidad en barras gruesas.
- La vía B (app resuelve índice) no toca el core; la vía A (tipo nuevo con mecánica SESSION) toca el core y el SPEC. Ninguna se implementa sin que el dueño pida la pieza; el caso numérico de referencia ya está medido: **Δvwap entre anclas 04:00 y 09:30 de −0.02 % a −0.07 % del precio en días normales** (tabla del punto 4), con el premarket pesando 3-5 % del volumen.

---

## Decisiones (2026-11-13)

- **Anclas Asia/NY: diferidas hasta trabajar cripto.** Cuando toque, se usará la **opción B** (la app resuelve el instante y pasa el índice), con una función propia y testeada «primera barra con `time >= T`» que no devuelva `[]` silencioso si el instante cae fuera del buffer.
- **Captura del 2026-11-27: descartada.** Cierres anticipados verificados con 2025-11-28 y 2025-12-24 (sonda `tools/probe_early_close.py`, commit `72369a1`).
- **Cierre anticipado: sin contaminación de `sessionVwap`** (delta +0.000000 % con datos reales). El falso hueco de ~179 min queda como cosmético; sin calendario de cierres anticipados por ahora.
