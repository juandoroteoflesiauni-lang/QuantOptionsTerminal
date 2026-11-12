# Barra en formación: sondeo en vivo (Massive 1m)

**Fecha:** sondeo 2026-11-12, 17:00:00-17:03:54 UTC (12:00-12:04 ET, 14:00 ART) ·
**Alcance:** solo observación. La detección de barra en formación NO cambia:
se mantiene la regla por reloj en todas las temporalidades (decisión del
dueño). Este documento registra lo que el proveedor hace en vivo para que
la decisión quede fundamentada.

## 1. Método y evidencia

- Herramienta: `tools/capture_samples.py --mode live-poll` (commit `a4eb591`),
  con `--poll-interval` por defecto 13 s (commit `490209a`, ~4,6 peticiones
  por minuto para respetar el plan gratuito de 5/min; con 10 s eran 6/min y
  se excedía).
- Evidencia cruda: `fixtures/samples/SPY_livepoll_2026-11-12.json`
  (commit `d43d33a`). Misma consulta que el modo live
  (`sort=desc&limit=5`, ventana de 3 días), `captured_at_utc` exacto por
  petición y seguimientos +5 min y +30 min del rango observado.
- Cadencia: 19 rondas con entre 12,999 y 13,001 s entre capturas
  consecutivas (nominal 13 s; desvío máximo 1,3 ms), las 19 con HTTP 200,
  0 rondas retrasadas más de 0,5 s y ningún 429. 21 peticiones en total
  (19 + 2 seguimientos).
- Ventana: RTH en calma, lejos de apertura y cierre; 8 minutos observados
  (aperturas 11:55-12:02 ET).

## 2. Hallazgos

### (a) La barra de 1m aparece 1-11 s tras cerrar

Primer avistamiento de cada minuto fresco frente a su cierre
(`captured_at_utc` de la primera ronda que la contiene, cierre = t + 60 s):

| apertura (ET) | cierre (ET) | primera aparición (UTC) | retardo desde el cierre |
|---|---|---|---|
| 11:59 | 12:00 | 17:00:00.761259Z | +0,76 s |
| 12:00 | 12:01 | 17:01:05.762150Z | +5,76 s |
| 12:01 | 12:02 | 17:02:10.761712Z | +10,76 s |
| 12:02 | 12:03 | 17:03:02.762607Z | +2,76 s |

Los minutos 11:55-11:58 ya estaban publicados cuando empezó el sondeo (la
primera ronda los trae desde 17:00:00.761259Z), así que su retardo exacto es
anterior al arranque y no se mide. En las 19 rondas nunca hubo una barra
cuyo cierre fuera posterior a `captured_at_utc` (chequeo directo: 0 casos):
el minuto en formación no aparece mientras se forma.

### (b) Un caso pareció llegar antes de cerrar

La barra 12:01 ET (cierre 17:02:00Z) estuvo ausente en la ronda de
17:01:57.761909Z y apareció en la de 17:02:10.761712Z. El intervalo
[17:01:57.761909Z, 17:02:10.761712Z) cruza el cierre 17:02:00Z: con la
cadencia de 13 s no se puede distinguir "publicada en el cierre" de
"publicada unos segundos antes del cierre". Es el caso más saliente porque
su retardo (+10,76 s) es el mayor observado y atípico frente al perfil
0,76-5,76 s del resto; los intervalos de 12:00 y 12:02 también cruzan el
cierre por construcción de la cadencia.

Es una apariencia, no una observación: 0 rondas contienen una barra formándose.
Si alguna respuesta llegara a incluir una barra con cierre posterior a
`captured_at_utc`, la cuestión se reabre con ese dato.

### (c) Sin revisiones de barras cerradas en ventana de calma

Última versión del sondeo frente al seguimiento a +5 min (17:09:00.761719Z)
y a +30 min (17:34:00.762281Z) sobre los 8 minutos observados
(11:55-12:02 ET):

- 8/8 minutos presentes en ambos seguimientos.
- Volumen: dv máximo 0,0000 % (idéntico en las tres tomas).
- OHLC: 0 barras con algún cambio entre tomas.

## 3. Implicación para el cargador (sin cambios)

El proveedor publica cada minuto completo entre 1 y 11 s después del cierre
y no revisa las cerradas (en calma). El cargador considera cerrada una barra
cuando `t + barSeconds <= now` por reloj: en el peor caso observado el
cierre ya pasó cuando la barra existe, así que la regla por reloj no puede
clasificar como cerrada una barra que el proveedor aún no sirve, y una barra
que el proveedor sirve siempre está completa. La decisión del dueño es
mantener la regla por reloj en todas las temporalidades.
