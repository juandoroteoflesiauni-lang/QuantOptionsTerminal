# Auditoría de la capa de datos — cierre

**Fecha**: 2026-11-09
**Base auditada**: `9c1b8d2` (Paso D) contra SPEC.md puntos 6, 8 y 9.
**Estado final**: los 10 hallazgos identificados están tratados; 9 cerrados con commit y A7 (rendimiento) queda abierto a demanda.

## 1. Método y seguridad

- Lectura de código, contraste con las muestras reales (`fixtures/samples/`) y el fixture independiente (`tools/gen_data_layer_fixture.py`).
- Cada pieza siguió el flujo del proyecto: una pieza, un commit, referencia Python explícita + fixture + tests, y `npm run verify` literal.
- Antes de cada commit se escanearon los archivos a commitear (más los tracked) contra la clave real de `.env` y el parámetro de autenticación de URL: `key_found=False`, `apiKey_param_found=False` en todas las ejecuciones. Nunca se imprimió ni escribió la clave real.

## 2. Veredicto por hallazgo

| ID | Hallazgo | Severidad | Estado | Commit |
|---|---|---|---|---|
| A1 | `next_url` de host arbitrario recibía la clave (exfiltración/SSRF) | Alta | Cerrado | `991b3c4` |
| A2 | Código BingX no numérico se interpretaba como éxito vacío | Media | Cerrado | `f5498b0` |
| A3 | BingX 1D no puede cumplir el warmup por defecto (1000) | Media | Cerrado (reporte) | `2572b55` |
| A4 | Timestamps fuera de rango aceptados y luego `sessionKey` lanzaba | Media | Cerrado | `28c2e8e` |
| A5 | Filtro RTH ausente (SPEC punto 9 lo asigna a la capa de datos) | Media | Cerrado | `159c0c1` |
| A6 | `oldestOpenTime`/`closeTime`/`timestamp` sin validación de unidad | Baja | Cerrado | `7e3bb32` |
| A7 | Renormalización completa de filas por página (rendimiento) | Baja | Abierto, a demanda | — |
| A8 | Semántica ambigua del reporte (accepted/gaps/first/last) | Baja | Cerrado (docs) | `b3b2022` |
| A9 | Rejilla 4h ET documentada como fija; el proveedor ancla en UTC | Baja | Cerrado (docs+tests) | `c5681cd` |
| A10 | Sesión que empieza a mitad de buffer no resuelta ni reportada | Baja | Cerrado (flag) | `1056948` |

## 3. Qué se hizo en cada pieza

### A1 — `next_url` restringido al origen configurado (`991b3c4`)
- `allowedNextUrl` valida mismo origen (esquema+host+puerto) contra `baseUrl`, esquema http/https y sin credenciales inline; un `next_url` rechazado es `malformedResponse` conservando las filas ya recibidas, y la clave nunca sale hacia otro host.
- Casos: host externo, relativo del mismo origen, http-vs-https, credenciales inline.

### A2 — `code` de BingX (`f5498b0`)
- Helper compartido `parseBingxCode`: ausente/null se tolera; número o string decimal finito se interpreta (distinto de 0 = `providerError`); cualquier otro valor presente = `malformedResponse`. La gramática decimal explícita evita divergencias con hex/inf.

### A4 — límite de timestamps (`28c2e8e`)
- `parseMilliseconds` rechaza resultados en segundos por encima de `MAX_TIME_SECONDS` (1e11, exportado de `sessions.ts`): la fila imposible se descarta como `invalidTime` y el hueco se calcula con las barras válidas; antes `loadBars` lanzaba.
- Frontera inclusiva: `1e14` ms = `1e11` s se acepta.

### A6 — unidades y cotas (`7e3bb32`)
- `oldestOpenTimeSeconds`: solo `openTime` en ms válidos participa en la paginación (un valor en segundos ya no para la paginación antes de tiempo).
- `closeTime` válido solo como entero ms dentro de `(apertura, apertura + duración)`; inválido se ignora y la barra usa el fallback por intervalo (corrige formación oculta y formación falsa).
- `timestamp` del servidor plausible solo como entero en `[1e12, 1e14]` ms; inválido cae al reloj de la petición (no a 1970). Cubierto con tests de reloj simulado (`vi.useFakeTimers`, `toFake: ['Date']`).
- Cota de `now` (opción y `assertNormalizeOptions`): `1..MAX_TIME_SECONDS`, error `now must be within the supported seconds range`.

### A8 — contrato del reporte (`b3b2022`, docs)
- `accepted` incluye la barra en formación; `normalizedBars` la excluye; `gaps` se calcula antes del filtro RTH (si aplica) y del recorte; `firstTime`/`lastTime` describen el buffer devuelto y no acotan los huecos. Documentado en `types.ts` y en la cabecera del loader.

### A9 — alineación 4h/DST (`c5681cd`)
- Decisión aprobada: aceptar la rejilla del proveedor (anclada al `from` en UTC) y documentarla; sin re-anclaje por segmentos.
- `alignment.ts` corregido; sección `alignment` en el fixture (12 casos con DST de 2026 y ramas de época de Massive/BingX) con tests directos (`tests/dataAlignment.test.ts`: nunca sube, idempotente); `lm19` fija el ancla con desfase EDT del inicio de la ventana.

### A5 — `rthOnly` (`159c0c1`)
- Nueva opción solo Massive (error con BingX y con 1D): el buffer devuelto solo contiene barras cuya apertura está en RTH (predicado del core `isRth`); objetivo y recorte se aplican sobre barras RTH y el lookback se escala con `MASSIVE_RTH_BARS_PER_DAY` (390/78/26/6/1). Los huecos se calculan sobre el buffer cerrado completo, antes del filtro. Con la opción ausente el comportamiento es idéntico al anterior.

### A3 — `warmupSatisfied` (`2572b55`)
- Decisión aprobada: reportar la insuficiencia, sin cambiar la paginación. `warmupSatisfied` es true solo si el buffer alcanzó `requestedBars`. Techo de BingX 1D (~380 días, `code 100204`) documentado: el warmup por defecto de 1000 no es alcanzable y el flag lo muestra (`lb15`).

### A10 — `sessionStartCovered` (`1056948`)
- Decisión aprobada: flag en el reporte sobre el buffer devuelto. true si contiene la primera barra de la sesión de la primera barra visible (09:30 ET en acciones vía `RTH_START_MINUTES` exportado del core; 00:00 UTC en cripto). false con buffer vacío/sin tramo visible, barra de inicio ausente (mitad de sesión o hueco) o temporalidad sin barra en el inicio de sesión (1h/4h/1D acciones — donde `sessionVwap` lanza por el SPEC punto 8 — y 1D cripto, que abre a las 16:00 UTC).

## 4. Cambios de comportamiento intencionales (registro)

- `code` BingX string numérico distinto de 0 → `providerError`; no numérico → `malformedResponse` (antes: éxito silencioso con 0 barras).
- Timestamp de fila fuera de `[1, 1e14]` ms → `invalidTime` (antes: aceptado y luego excepción).
- `next_url` de otro origen → `malformedResponse` sin enviar la clave (antes: se seguía y recibía la clave).
- `now` fuera de `[1, 1e11]` → error de opciones (antes: aceptado y luego excepción posible).
- `closeTime`/`timestamp` con unidades implausibles → ignorados (fallback por intervalo / reloj de petición).
- Campos nuevos en el reporte de ambos proveedores: `warmupSatisfied` y `sessionStartCovered`; opción nueva `rthOnly`. Ningún test existente fue modificado ni debilitado durante la auditoría.

## 5. Estado de verificación al cierre

- `npm run verify`: 9 archivos de test, **268 tests**, typecheck y lint sin errores.
- Fixture (`fixtures/data_layer_reference.json`, generado por `tools/gen_data_layer_fixture.py`): 99 casos — `alignment` 12, normalizadores 30 (Massive 13, BingX 17), cargador 57 (Massive 25, BingX 17, validación 15).
- Archivos de test: `dataLoader` (62), `dataNormalize` (38), `dataAlignment` (13), más los existentes de core (ema, welford, sessionVwap, sessions, avwap, setup).

## 6. Observaciones que quedan abiertas (no bloqueantes, sin commit)

- **A7**: renormalización completa de filas acumuladas en cada página (`O(páginas × n log n)`). Solo abordar si se mide un problema real; la vía sería normalización incremental o una única normalización final con chequeo barato del objetivo.
- **Massive `vw` fuera de `[low, high]`**: se conserva y se cuenta (`vwOutsideRange`); el SPEC punto 4 no exige que esté dentro del rango. Sin acción.
- **Validación OHLC**: solo `high < low`; no se comprueba que `open`/`close` estén dentro de `[low, high]`. El SPEC punto 6 no lo exige; decidir si se endurece.
- **Normalizadores usados directamente no redactan** mensajes de error del proveedor (el loader sí redacta en su ruta HTTP). Documentar el contrato o aceptar un redactor.
- **`baseUrl` inválida lanza antes del reporte** (error de configuración, no de proveedor). Podría validarse como URL absoluta https en `resolveOptions`.
- **Massive 1D excluye toda la fecha ET actual**, incluso después del cierre (16:00/20:00 ET): la barra del día falta hasta medianoche ET. Confirmar con el proveedor la hora de finalización si se quiere relajar.
- **`visibleBars=0` con éxito** no tiene caso de fixture propio (menor).

## 7. Commits de la auditoría (desde `9c1b8d2`)

```
991b3c4 fix(data): restrict massive next_url to the baseUrl origin
f5498b0 fix(data): treat bingx numeric-string code as provider error
28c2e8e fix(data): reject timestamps beyond the session time bound
7e3bb32 fix(data): validate bingx time units and bound now
b3b2022 docs(data): document load report contract semantics
c5681cd test(data): pin alignment behavior across DST transitions
159c0c1 feat(data): filter equity bars to RTH with rthOnly option
2572b55 feat(data): report warmupSatisfied and document bingx 1D ceiling
1056948 feat(data): report sessionStartCovered for the visible session
```
