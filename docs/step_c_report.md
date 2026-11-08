# Paso C — Evidencia de las muestras REST

**Objetivo**: documentar, con fragmentos literales de las muestras crudas, las respuestas a las preguntas del Paso C antes de implementar el cargador (Paso D).

**Fuentes**: los 12 archivos de `fixtures/samples/` (Massive SPY y BingX BTC-USDT spot, capturados el 2026-11-06/07). Los cuerpos JSON se guardan crudos, sin normalizar.

**Seguridad**: este informe no contiene claves. Las URLs de Massive están sanitizadas; la búsqueda de la clave y de su parámetro de URL en los 21 archivos del Paso B dio `key_found=False`, `apiKey_param_found=False`.

**Método**: leer los cuerpos crudos, convertir `t`/`openTime` de milisegundos a segundos/UTC solo para el informe, y calcular sumas y conteos con Python. No se normaliza, no se rellena y no se corrige ningún valor.

---

## 1. Massive: hora de la barra diaria y día ET

Fragmentos literales de `SPY_1D_2026-11-06.json`, escenario `day`:

```json
{"v": 77696475.732216, "vw": 757.4429, "o": 761.38, "c": 755.72, "h": 761.46, "l": 750.36, "t": 1793332800000, "n": 1023757}
```

`t=1793332800000` → `2026-10-30 00:00:00 EDT` / `2026-10-30 04:00:00Z`.

```json
{"v": 50804340.37703, "vw": 756.5208, "o": 759.45, "c": 752.1, "h": 763.86, "l": 751.6, "t": 1793595600000, "n": 759714}
```

`t=1793595600000` → `2026-11-02 00:00:00 EST` / `2026-11-02 05:00:00Z`.

```json
{"v": 58978818.623761, "vw": 737.4009, "o": 734.82, "c": 735.29, "h": 742.2104, "l": 734.58, "t": 1793941200000, "n": 826775}
```

`t=1793941200000` → `2026-11-06 00:00:00 EST` / `2026-11-06 05:00:00Z`.

Conclusiones:

- La barra diaria de Massive abre a las 00:00 ET, no a medianoche UTC.
- El offset UTC cambia con el horario de verano: 04:00Z en EDT y 05:00Z en EST.
- El día ET de la barra es la fecha de `t` en `America/New_York`; para `t=1793941200000` es `2026-11-06`, aunque en UTC abra a las 05:00Z.
- El volumen diario de 2026-11-06 es `58978818.623761`.
- El escenario `dst` de `SPY_5m_2026-11-06.json` incluye una página diaria con el mismo patrón: `2026-10-22 00:00 EDT` (04:00Z) … `2026-11-06 00:00 EST` (05:00Z). No es casual: la rejilla diaria es ET.

---

## 2. Massive: alineación de 1h y 4h

### 1h

`SPY_1h_2026-11-06.json`, escenario `day`, 16 barras:

```json
{"v": 313608.52383499994, "vw": 735.1485, "o": 734.63, "c": 736.3, "h": 738.03, "l": 730.64, "t": 1793955600000, "n": 8363}
```

`t=1793955600000` → `2026-11-06 04:00:00 EST` / `2026-11-06 09:00:00Z`.

```json
{"v": 30610.583091, "vw": 736.2177, "o": 736.1091, "c": 736.53, "h": 736.53, "l": 736, "t": 1794009600000, "n": 804}
```

`t=1794009600000` → `2026-11-06 19:00:00 EST` / `2026-11-07 00:00:00Z`.

- Las 16 barras del día abren a las 04:00, 05:00, …, 19:00 ET.
- En el escenario `max` (1192 barras), los minutos ET únicos son `[0]`; no hay barras a `:30` ni a otros minutos. La 1h está alineada a la hora.

### 4h

`SPY_4h_2026-11-06.json`, escenario `day`, 4 barras:

```json
{"v": 944312.2839650002, "vw": 735.2983, "o": 734.63, "c": 734.24, "h": 738.03, "l": 730.64, "t": 1793955600000, "n": 19861}
```

`t=1793955600000` → `2026-11-06 04:00:00 EST` / `2026-11-06 09:00:00Z`.

```json
{"v": 21976621.32076301, "vw": 738.5884, "o": 734.07, "c": 740.46, "h": 742.2104, "l": 732.43, "t": 1793970000000, "n": 408186}
```

`t=1793970000000` → `2026-11-06 08:00:00 EST` / `2026-11-06 13:00:00Z`.

```json
{"v": 28021877.100459993, "vw": 737.0815, "o": 740.44, "c": 735.34, "h": 740.5, "l": 735.07, "t": 1793984400000, "n": 384583}
```

`t=1793984400000` → `2026-11-06 12:00:00 EST` / `2026-11-06 17:00:00Z`.

```json
{"v": 5419120.401439001, "vw": 735.623, "o": 735.37, "c": 736.53, "h": 738.3235, "l": 735.1, "t": 1793998800000, "n": 13313}
```

`t=1793998800000` → `2026-11-06 16:00:00 EST` / `2026-11-06 21:00:00Z`.

- En este escenario, las 4h abren a 04:00, 08:00, 12:00 y 16:00 ET, que es 00:00 ET + 4h.
- **Matiz importante**: el escenario `max` de 4h (334 barras, 2003-2004) tiene horas ET únicas `[5, 8, 9, 12, 13, 16, 17]`, no `[0, 4, 8, 12, 16, 20]`. La primera barra es `t=1063184400000` → `2003-09-10 05:00:00 EDT` / `09:00:00Z`; la última es `t=1075899600000` → `2004-02-04 08:00:00 EST` / `13:00:00Z`. El escenario `max` pidió `from=2003-01-01T05:00:00Z` (00:00 EST) y el proveedor alineó las barras de 4h a ese instante de inicio, sumando 4h en UTC. Por eso, durante EDT las barras caen a las 05:00, 09:00, 13:00 y 17:00 ET; durante EST, a las 04:00, 08:00, 12:00 y 16:00 ET.
- Consecuencia: la rejilla de 4h de Massive es relativa al `from` de la petición, no una rejilla fija de 00:00 ET. Para obtener 00:00 ET + 4h hay que pedir `from` en un límite alineado (00:00 ET + 4h). `alignDown` de `src/data/alignment.ts` hace exactamente eso; el cargador debe usarlo antes de construir la URL.
- El escenario `max` de 4h está truncado: `has_next_url_after_last_page=true` y solo 334 filas. No es una historia completa; es evidencia de alineación.
- El escenario `dst` de `SPY_5m_2026-11-06.json` muestra el cambio de offset para 5m: `2026-10-30 04:00 EDT` = `08:00Z`; `2026-11-02 04:00 EST` = `09:00Z`. La página diaria del mismo escenario muestra `2026-10-22 00:00 EDT` = `04:00Z` y `2026-11-06 00:00 EST` = `05:00Z`. El escenario `dst` mezcla dos páginas de 5m y una página diaria; no se debe normalizar como una sola serie de 5m.

---

## 3. Volumen: diario vs 04:00-20:00 y 09:30-16:00

Barra diaria de 2026-11-06 (literal):

```json
{"v": 58978818.623761, "vw": 737.4009, "o": 734.82, "c": 735.29, "h": 742.2104, "l": 734.58, "t": 1793941200000, "n": 826775}
```

1m, primera y última barra del día:

```json
{"v": 11551.796366, "vw": 734.2961, "o": 734.63, "c": 735.17, "h": 735.4, "l": 731.4198, "t": 1793955600000, "n": 1391}
```

`t=1793955600000` → `2026-11-06 04:00:00 EST` / `09:00:00Z`.

```json
{"v": 374, "vw": 736.4589, "o": 736.41, "c": 736.53, "h": 736.53, "l": 736.41, "t": 1794013140000, "n": 24}
```

`t=1794013140000` → `2026-11-06 19:59:00 EST` / `2026-11-07 00:59:00Z`.

Cálculos literales:

- 1m: 922 barras; 960 minutos esperados en 04:00-20:00; 38 minutos ausentes.
- Suma 04:00-20:00: `56361931.106627`.
- Diario − 04:00-20:00: `58978818.623761 - 56361931.106627 = 2616887.517133996`.
- RTH 09:30-16:00: 390 barras (390/390, completo); suma `48543478.61995`.
- Diario − RTH: `58978818.623761 - 48543478.61995 = 10435340.003811002`.
- Volumen solo extendido (04:00-09:30 + 16:00-20:00): `56361931.106627 - 48543478.61995 = 7818452.486677006`.

Lectura:

- El volumen diario no coincide con la suma 04:00-20:00; la diferencia es `2616887.517133996`.
- Tampoco coincide con RTH; la diferencia es `10435340.003811002`.
- No se puede atribuir toda la diferencia a los 38 minutos ausentes: la muestra 1m cubre 04:00-19:59 y el volumen diario puede incluir operaciones fuera de esa ventana. No se rellena ni se escala; se reportan los números literales.
- La ventana RTH está completa (390/390), así que el VWAP de sesión RTH no depende de los huecos extendidos.

---

## 4. Barras 1m ausentes: 922 de 960

- Esperadas: 960 minutos (04:00-20:00 ET).
- Presentes: 922.
- Ausentes: 38, en 23 huecos.
- Primeros 10 ausentes ET: `05:39`, `06:16`, `16:52`, `17:18`, `18:03`, `18:09`, `18:10`, `18:16`, `18:17`, `18:18`.
- Últimos 10 ausentes ET: `19:07`, `19:08`, `19:11`, `19:14`, `19:20`, `19:23`, `19:28`, `19:35`, `19:44`, `19:46`.

Primer hueco, filas adyacentes literales:

```json
{"v": 1762.4171, "vw": 735.6781, "o": 735.69, "c": 735.8, "h": 735.8, "l": 735.65, "t": 1793961480000, "n": 28}
```

`t=1793961480000` → `2026-11-06 05:38:00 EST`.

```json
{"v": 3873.274405, "vw": 735.9349, "o": 736, "c": 735.9, "h": 736, "l": 735.89, "t": 1793961600000, "n": 65}
```

`t=1793961600000` → `2026-11-06 05:40:00 EST`.

- `t=1793961540000` (`05:39:00 EST`) no está en la muestra: `present in sample: False`.
- Massive omite la barra; no devuelve una fila con `null`, `0` o un precio de relleno.
- El normalizador detecta el hueco (`missingBars=1`) y no lo rellena. Los 38 ausentes están fuera de RTH (pre/post mercado); RTH está completo.

---

## 5. Massive: `vw` dentro/fuera de `[low, high]`, ausente y cero

Tabla por archivo y escenario. `outside` = `vw < low || vw > high`; `within` = `low <= vw <= high`. Los conteos suman filas de todos los escenarios; un mismo instante puede aparecer en más de un escenario.

| Archivo | Escenario | total | missing | zero | nonfinite | outside | within |
|---|---:|---:|---:|---:|---:|---:|---:|
| SPY_1m | day | 922 | 0 | 0 | 0 | 104 | 818 |
| SPY_1m | range | 2000 | 0 | 0 | 0 | 799 | 1201 |
| SPY_1m | max | 50000 | 0 | 0 | 0 | 13959 | 36041 |
| SPY_1m | latest | 5 | 0 | 0 | 0 | 1 | 4 |
| SPY_1m | **ALL** | **52927** | **0** | **0** | **0** | **14863** | **38064** |
| SPY_5m | day | 192 | 0 | 0 | 0 | 20 | 172 |
| SPY_5m | range | 646 | 0 | 0 | 0 | 260 | 386 |
| SPY_5m | max | 11942 | 0 | 0 | 0 | 1556 | 10386 |
| SPY_5m | latest | 1 | 0 | 0 | 0 | 0 | 1 |
| SPY_5m | dst | 396 | 0 | 0 | 0 | 150 | 246 |
| SPY_5m | **ALL** | **13177** | **0** | **0** | **0** | **1986** | **11191** |
| SPY_15m | ALL | 4401 | 0 | 0 | 0 | 284 | 4117 |
| SPY_1h | ALL | 1257 | 0 | 0 | 0 | 3 | 1254 |
| SPY_4h | ALL | 352 | 0 | 0 | 0 | 0 | 352 |
| SPY_1D | ALL | 7865 | 0 | 0 | 0 | 1 | 7864 |
| **Total** | | **79979** | **0** | **0** | **0** | **17137** | **62842** |

Notas:

- SPY_5m `ALL` incluye el escenario `dst` (396 filas: dos páginas de 5m de 192 filas y una página diaria de 12). Sin `dst`, el agregado de 5m es 12781 filas, 1836 outside y 10945 within. El `dst` no es una serie coherente de 5m; se incluye solo para evidencia de alineación.
- SPY_4h `max` son 334 filas de 2003-2004, truncadas (`next_url`); el agregado de 4h no es una historia reciente completa.
- `missing=0`, `zero=0`, `nonfinite=0` en todas las muestras: Massive siempre entrega `vw` presente, finito y distinto de 0 en estas muestras.

Ejemplos literales de `vw` fuera de rango (SPY_1m, `day`):

```json
{"v": 387.237499, "vw": 736.2907, "o": 736.22, "c": 736.22, "h": 736.22, "l": 736.22, "t": 1793956320000, "n": 38}
```

`t=1793956320000` → `2026-11-06 04:12:00 EST`; `vw=736.2907 > high=736.22`.

```json
{"v": 134.498, "vw": 735.4834, "o": 735.56, "c": 735.56, "h": 735.56, "l": 735.56, "t": 1793960520000, "n": 20}
```

`t=1793960520000` → `2026-11-06 05:22:00 EST`; `vw=735.4834 < low=735.56`.

Ejemplo en 1D (SPY_1D, `max`):

```json
{"v": 285898129.0, "vw": 100.8775, "o": 91.95, "c": 90.51, "h": 92.8, "l": 90.41, "t": 1242792000000, "n": 622470}
```

`t=1242792000000` → `2009-05-20 00:00:00 EDT` / `04:00:00Z`; `vw=100.8775 > high=92.8`. Es un outlier antiguo; el normalizador lo reporta como `vwOutsideRange=1` y no lo corrige.

Conclusión: Massive no garantiza `low <= vw <= high`. El normalizador conserva `vw` (si es finito) y reporta `vwOutsideRange`; no lo recorta ni lo sustituye. El VWAP de sesión usará `vw` según el SPEC y el conteo queda auditado.

---

## 6. Barra en formación: Massive vs BingX

### Massive

`SPY_1m_2026-11-06.json`, escenario `latest`:

- `params`: `{"adjusted":"true","sort":"desc","limit":"5","from":"1793476830782","to":"1794081630782"}`
- `capture_date_utc`: `2026-11-07T19:59:23.908595Z`
- `captured_at_utc`: `2026-11-07T20:00:30.783070Z`
- Filas (descendentes):

```json
{"v": 374, "vw": 736.4589, "o": 736.41, "c": 736.53, "h": 736.53, "l": 736.41, "t": 1794013140000, "n": 24}
{"v": 343, "vw": 736.3612, "o": 736.3337, "c": 736.4, "h": 736.4, "l": 736.3337, "t": 1794013080000, "n": 12}
{"v": 7267.805091, "vw": 736.3106, "o": 736.2906, "c": 736.31, "h": 736.32, "l": 736.2906, "t": 1794013020000, "n": 25}
{"v": 234.411628, "vw": 736.2924, "o": 736.2706, "c": 736.3, "h": 736.3, "l": 736.2706, "t": 1794012960000, "n": 13}
{"v": 233.399236, "vw": 736.3151, "o": 736.32, "c": 736.34, "h": 736.34, "l": 736.32, "t": 1794012900000, "n": 15}
```

- La última barra (19:59 ET) abre en `2026-11-07 00:59:00Z` y cierra en `01:00:00Z`; el `capture` es `2026-11-07T19:59:23.908595Z` (epoch `1794081563.908595`), muy fuera del intervalo. No hay barra en formación: `formingBar=null`.
- El mercado estaba cerrado (sábado). El escenario `latest` de 15m/1h/4h devolvió 0 filas con el rango de 7 días; el de 1D devolvió 7 barras diarias (2026-10-29 a 2026-11-06) y tampoco incluye la barra del sábado 2026-11-07. No se usa para formación.

### BingX 1m

`BTC-USDT_1m_2026-11-06.json`, escenario `latest`:

- `params`: `{"symbol":"BTC-USDT","interval":"1m","limit":"5"}`
- `server timestamp`: `1794081083574` → `2026-11-07 19:51:23Z`.
- Primera fila (descendente):

```json
[1794081060000, 75772.31, 75772.82, 75772.31, 75772.34, 0.063815, 1794081119999, 4835.42]
```

`open=2026-11-07 19:51:00Z`, `close=2026-11-07 19:51:59.999Z`; el server timestamp `19:51:23Z` cae dentro → **forming: True**.

- La segunda fila `[1794081000000, ..., 1794081059999, ...]` abre 19:50:00Z y cierra 19:50:59.999Z; el server timestamp no cae dentro → closed.
- El normalizador reporta `formingBar={time:1794081060, reason:'closeTimeContainsServerTime'}`.

### BingX 1D

`BTC-USDT_1D_2026-11-06.json`, escenario `latest`:

- `params`: `{"symbol":"BTC-USDT","interval":"1d","limit":"5"}`
- `server timestamp`: `1794081103676` → `2026-11-07 19:51:43Z`.
- Primera fila:

```json
[1794067200000, 75758.03, 75894.19, 75695.9, 75772.62, 62.897841, 1794153599999, 4767507.91]
```

`open=2026-11-07 16:00:00Z`, `close=2026-11-08 15:59:59.999Z`; el server timestamp cae dentro → **forming: True**. La barra diaria de BingX abre a las 16:00Z (00:00 UTC+8), no a medianoche UTC.

- La segunda fila `[1793980800000, ..., 1794067199999, ...]` abre 2026-11-06 16:00Z y cierra 2026-11-07 15:59:59.999Z; el server timestamp no cae dentro → closed.

### Distinción

- Massive `latest` no incluye la barra en formación en esta muestra porque el mercado está cerrado; BingX `latest` sí la incluye porque el endpoint devuelve el intervalo actual y el server timestamp cae dentro de `openTime..closeTime`.
- El normalizador no elimina la barra: la reporta (`formingBar`). El cargador (Paso D) debe excluirla del resultado y reportar `formingExcluded`.
- Para Massive, `now` debe ser el instante de la petición/captura en segundos UTC; para BingX, el `timestamp` del cuerpo de la respuesta (o el instante de la petición) es la referencia. El normalizador usa `now`; el cargador lo pasa.

---

## 7. BingX: spot vs swap

URL literal (sin clave; endpoint público):

```text
https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=BTC-USDT&interval=1m&limit=1000&startTime=1793923200000&endTime=1794009599999
```

- El endpoint es **spot**: `/openApi/spot/v2/market/kline`.
- Campos de cada fila: `[openTime, open, high, low, close, volume, closeTime, quoteVolume]`.
- `volume` es volumen en base (BTC); `quoteVolume` es volumen en cotización (USDT).
- La muestra no usa el endpoint de swap (`/openApi/swap/...`); no se mezclan volúmenes spot y de contrato.
- La nota de la muestra: "BingX klines publicas: no requieren clave." El endpoint spot público no requiere API key. La clave de BingX del `.env` no se usa en estas muestras.
- La URL de 1D es la misma ruta spot con `interval=1d`.
- Límite observado: la segunda página del escenario `range` de 1D devolvió:

```json
{"code": 100204, "msg": "The maximum query range for BTC_USDT K-lines is 380 days and 0 hours.", "timestamp": 1794081103206}
```

No trae `data` (0 filas). El cargador debe tratar `code != 0` como error de proveedor y usar rangos máximos conservadores (1D ≤ 380 días).

---

## 8. BingX: `quoteVolume/volume` dentro de `[low, high]`

Tabla por archivo/escenario. `candidate = quoteVolume / volume`; `outside` = `candidate < low || candidate > high`; solo se consideran filas con `volume > 0` y `quoteVolume` finito.

| Archivo | Escenario | total | zeroVolume | missing | candidate | outside |
|---|---:|---:|---:|---:|---:|---:|
| BTC-USDT 1m | day | 1440 | 0 | 0 | 1440 | 10 |
| BTC-USDT 1m | range | 2000 | 0 | 0 | 2000 | 175 |
| BTC-USDT 1m | latest | 5 | 0 | 0 | 5 | 0 |
| BTC-USDT 1m | **ALL** | **3445** | **0** | **0** | **3445** | **185** |
| BTC-USDT 5m | ALL | 2293 | 0 | 0 | 2293 | 0 |
| BTC-USDT 15m | ALL | 2101 | 0 | 0 | 2101 | 0 |
| BTC-USDT 1h | ALL | 2029 | 0 | 0 | 2029 | 0 |
| BTC-USDT 4h | ALL | 2011 | 0 | 0 | 2011 | 0 |
| BTC-USDT 1D | ALL | 1006 | 0 | 0 | 1006 | 0 |

- 1m: 185 de 3445 candidatos fuera = **5,37%**. No es 100%.
- 5m/15m/1h/4h/1D: 0 fuera en estas muestras; el candidato cae dentro de `[low, high]` en el 100% de las filas muestreadas.
- `zeroVolume=0`, `missing=0` en todas las muestras.

Ejemplos literales de 1m fuera de rango (BTC-USDT 1m, `day`):

```json
[1794009000000, 75982.15, 75982.16, 75982.14, 75982.15, 0.060828, 1794009059999, 4621.84]
```

`candidate = 4621.84 / 0.060828 = 75982.11350036168`; `low=75982.14`, `high=75982.16` → **below low**.

```json
[1794008940000, 75982.14, 75982.15, 75982.14, 75982.15, 0.046542, 1794008999999, 3536.36]
```

`candidate = 3536.36 / 0.046542 = 75982.12367324138`; `low=75982.14`, `high=75982.15` → **below low**.

```json
[1794008160000, 75959.14, 75959.15, 75959.13, 75959.14, 0.372109, 1794008219999, 28265.07]
```

`candidate = 28265.07 / 0.372109 = 75959.11413053701`; `low=75959.13`, `high=75959.15` → **below low**.

- Las diferencias son pequeñas (por ejemplo, `75982.1135` vs `75982.14`), pero están fuera del intervalo. El SPEC exige que quede entre `low` y `high`; no se admite "casi".
- Decisión: el normalizador **nunca expone `vw` para BingX** (`vwExposed=false`). Reporta `vwCandidateBars`, `vwCandidateMissing`, `vwCandidateZeroVolume`, `vwCandidateOutsideRange` para auditoría. Aunque 5m+ tenga 0 fuera en estas muestras, la verificación de 1m falla y la condición del SPEC no se cumple de forma general; no se expone `vw` en ninguna temporalidad.

---

## 9. Resumen de respuestas

| Pregunta | Respuesta literal |
|---|---|
| Hora de la barra diaria de Massive | 00:00 ET (04:00Z EDT / 05:00Z EST); el día ET es la fecha de apertura. |
| Alineación 1h | A la hora exacta; minutos ET únicos `[0]` en 1192 barras. |
| Alineación 4h | Relativa al `from` de la petición: con `from=09:00Z` (04:00 ET) da 04:00/08:00/12:00/16:00 ET; con `from=00:00 EST` da 05:00/09:00/13:00/17:00 ET en EDT. Pedir desde 00:00 ET + 4h para la rejilla deseada. |
| Volumen diario 2026-11-06 | `58978818.623761`. |
| Suma 1m 04:00-20:00 | `56361931.106627` (922 barras; 38 ausentes); diferencia `2616887.517133996`. |
| Suma 1m 09:30-16:00 | `48543478.61995` (390/390); diferencia `10435340.003811002`. |
| 1m esperadas/presentes/ausentes | 960 / 922 / 38, en 23 huecos. |
| Massive omite las barras ausentes | Sí: no hay fila para 05:39; no hay null/0; el normalizador detecta el hueco y no rellena. |
| Massive `vw` fuera de `[low, high]` | 1m day 104/922; 1m all 14863/52927; 5m all 1986/13177; 15m 284/4401; 1h 3/1257; 4h 0/352; 1D 1/7865. `missing=0`, `zero=0`. |
| Barra en formación Massive | No en la muestra `latest`: última barra 19:59 ET del viernes; captura sábado; `formingBar=null`. |
| Barra en formación BingX | Sí: 1m 19:51Z (server 19:51:23Z) y 1D 16:00Z (server 19:51:43Z) caen dentro de `openTime..closeTime`; `formingBar` reportada. |
| BingX spot o swap | Spot: `/openApi/spot/v2/market/kline`; 8 campos; sin clave. No es swap. |
| `quoteVolume/volume` dentro de `[low, high]` al 100% | No en 1m: 185/3445 fuera (5,37%). Sí en las muestras 5m/15m/1h/4h/1D (0 fuera), pero la condición global falla; `vwExposed=false`. |

---

## 10. Seguridad

- Búsqueda en los 21 archivos del Paso B (12 muestras, fixture, `src/data`, test, generador): `key_found=False`, `apiKey_param_found=False`.
- Las URLs de Massive en las muestras están sanitizadas; no incluyen el parámetro de clave en ninguna variante de mayúsculas.
- Este informe no contiene claves. La clave Massive no se imprime ni se escribe.
- BingX spot público no requiere clave; las muestras no usan `BINGX_API_KEY`.

---

## 11. Observaciones para el Paso D (loader)

Estas son consecuencias de la evidencia, no cambios de código:

- Massive: usar `sort=desc` para obtener las barras más recientes; seguir `next_url`; `limit` máximo observado 50000; `from`/`to` en milisegundos; la rejilla de 4h depende del `from`, así que alinear el inicio con `alignDown` (00:00 ET + 4h); las diarias abren a 00:00 ET; pasar `now` en segundos UTC para detectar la formación; excluir la formación del resultado; no rellenar huecos.
- BingX: endpoint spot; `limit=1000`; paginar hacia atrás con `endTime = oldest openTime - 1`; 1D máximo 380 días (`code 100204`); usar el `timestamp` del cuerpo para la formación; excluir la formación; no exponer `vw`; reportar las estadísticas del candidato; no rellenar huecos.
- Tests: usar las páginas de muestra como `fetchFn` simulado, con `now` determinista en segundos UTC; verificar que las URLs no contienen la clave y que los reportes no la contienen.
- `visibleStart = max(0, bars.length - visibleBars)`; `requestedBars = visibleBars + warmupBars`; reportar requested/received/first/last/discards; no inventar barras.
