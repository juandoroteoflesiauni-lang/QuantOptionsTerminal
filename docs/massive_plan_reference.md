# Referencia del Plan Massive (Stocks, Options e Índices/Macro)

> **Fecha de verificación:** 2026-11-13  
> **Modo de obtención:** Inspección en solo lectura de la documentación oficial Markdown de Massive (`https://massive.com/docs/llms.txt` y endpoints individuales) más una campaña mínima de verificación en vivo (**19 peticiones REST GET** y **3 conexiones WebSocket**, `0` cambios en código fuente).  
> **Nota de seguridad:** No se incluyen API keys ni credenciales. Los hallazgos empíricos de latencia WebSocket están corregidos por el desfase medido del reloj local Windows (`+408 ms` respecto a `time.windows.com`, es decir, `reloj_local = UTC_real - 408 ms`).

---

## 1. Diagnóstico del plan activo en la cuenta

En `.env`, `MASSIVE_API_KEY`, `MASSIVE_KEY` y `MASSIVE_KEY_OPTIONS` comparten exactamente la misma clave de 32 caracteres; existe además `MASSIVE_KEY_FUTURES` como clave separada (no sondeada en vivo).

### Evidencia empírica (19 REST + 3 WS) y precios de catálogo
De acuerdo con la matriz pública de precios (`https://massive.com/pricing` y `https://massive.com/pricing?product=options`) y las sondas ejecutadas en vivo durante RTH (`2026-11-13`):

1. **Stocks Advanced ($199/mes, nivel Individual) — CONFIRMADO EN VIVO:**
   - `/v3/quotes/SPY?limit=1` (`200 OK`), `/v3/trades/SPY?limit=1` (`200 OK`), `/v2/snapshot/.../SPY` con `lastQuote` y `lastTrade` en tiempo real (`200 OK`).
   - `/stocks/financials/v1/ratios` (exclusivo de Stocks Advanced o del add-on *Financials & Ratios*, `200 OK`).
   - Historia diaria de `SPY` verificada desde enero de 2004 (superando el tope de 10 años de Developer; el suelo documentado para Stocks Advanced es `2003-09-10`, verificado en `results.underlying.url` de `/v1/indicators/ema/SPY`).
   - Canal `A` (por segundo) y `Q`/`T` en `wss://socket.massive.com/stocks` autenticados y transmitiendo en tiempo real (`Q` y `T` cada milisegundo, `A` cada segundo).
   - Ausencia de campo `fmv` en snapshots (exclusivo de planes *Business*).

2. **Options Advanced ($199/mes, nivel Individual) — CONFIRMADO EN VIVO:**
   - `/v3/snapshot/options/SPY` (`200 OK`) entregando `last_quote`, `last_trade` y `underlying_asset` marcados como `timeframe: "REAL-TIME"` (~0.7–1.4 s de frescura), más `greeks`, `implied_volatility` y `open_interest`, y sin `fmv`/`fmv_last_updated`.
   - `/v3/quotes/O:SPY261113C00760000` (`200 OK`, exclusivo de Options Advanced frente a Starter/Developer) y `/v3/trades/O:SPY261113C00760000` (`200 OK`).
   - `/options/v1/open-interest` y `/options/v1/unusual-trades` (`200 OK` en ambos; exclusivos de Options Advanced en planes individuales).
   - Agregados de opciones en `2021-01` (5+ años atrás, superando el tope de 4 años de Developer; suelo documentado `2014-06-02`).
   - WebSocket `wss://socket.massive.com/options` transmitiendo `A`, `AM`, `T` y `Q` sin cortes durante 150 s.

3. **Derechos adicionales observados en la misma clave (fuera de Stocks/Options):**
   - `GET /v3/snapshot?ticker.any_of=I:SPX,I:VIX,I:SKEW,I:NDX,X:BTCUSD,C:EURUSD` devolvió `200 OK` con `timeframe: "REAL-TIME"` para los **4 índices** (`I:SPX`, `I:VIX`, `I:SKEW`, `I:NDX`), **`X:BTCUSD`** (`last_trade`) y **`C:EURUSD`** (`last_quote`).
   - `GET /v3/snapshot/options/I:SPX` y `GET /v3/snapshot/options/I:VIX` devolvieron `200 OK` con `underlying_asset.timeframe: "REAL-TIME"` y griegas/IV calculadas.
   - **[HIPÓTESIS — PENDIENTE CONFIRMAR EN DASHBOARD]:** La presencia de `REAL-TIME` en índices sugiere que la cuenta también tiene activo **Indices Advanced ($99/mes)** (Indices Starter es 15-min delayed) y algún plan de **Currencies ($49/mes Starter+)**; además `.env` contiene `MASSIVE_KEY_FUTURES`. No se probaron WebSockets ni historia completa de Indices, Forex, Crypto ni Futures.
   - **[PENDIENTE OPERATIVO — S3 FLAT FILES]:** `.env` no contiene todavía claves S3 (`Access Key` / `Secret Key`). Aunque Stocks Advanced y Options Advanced incluyen Flat Files por contrato, su descarga práctica requiere generar esas credenciales en `https://massive.com/dashboard/keys`.

---

## 2. Cobertura por producto (Stocks, Options y extras incluidos)

Fuente transversal de límites y acceso:
- Precios y matriz: `https://massive.com/pricing` y `https://massive.com/pricing?product=options`
- Límite de peticiones REST: `https://massive.com/knowledge-base/article/what-is-the-request-limit-for-massives-restful-apis`
- Quickstart REST: `https://massive.com/docs/rest/quickstart.md`
- Quickstart WebSocket: `https://massive.com/docs/websocket/quickstart.md`
- Quickstart Flat Files: `https://massive.com/docs/flat-files/quickstart.md`

### 2.1 Resumen comparativo Stocks Advanced vs Options Advanced

| Dimensión | Stocks Advanced ($199/mes) | Options Advanced ($199/mes) | URL de respaldo |
| --- | --- | --- | --- |
| **Latencia / Recencia** | **Tiempo real** (trades, quotes, snapshots, aggs, WS) | **Tiempo real** (OPRA trades, quotes, snapshots, aggs, WS, unusual trades) | `https://massive.com/pricing` |
| **Límite de peticiones REST** | **Ilimitado** (sin tope por minuto; el límite de 5 RPM aplica solo por *asset class* no suscrita) | **Ilimitado** (contabilizado de forma independiente por *asset class*) | `https://massive.com/knowledge-base/article/what-is-the-request-limit-for-massives-restful-apis` |
| **Tamaño máximo de página (`limit`)** | `50_000` en `/v2/aggs`, `/v3/trades`, `/v3/quotes`; `1_000` en `/v3/reference/*` | `50_000` en `/v2/aggs`, `/v3/trades`, `/v3/quotes`, `/options/v1/*`; `1_000` en `/v3/reference/options/contracts`; **`250`** en `/v3/snapshot/options/{underlyingAsset}` | Endpoints individuales abajo |
| **Historia disponible** | `20+ años` (barras/trades/quotes/indicadores/tickers desde **`2003-09-10`**; dividendos desde `2000-01-15`; splits desde `1978-10-25`; noticias desde `2016-06-22`) | `5+ años` (**`2014-06-02`** para contratos, aggs, trades e indicadores; **`2022-03-07`** para quotes; **`2022-09-01`** para open interest histórico y unusual trades) | `https://massive.com/docs/rest/options/aggregates/custom-bars.md`, `.../quotes.md`, `.../open-interest-by-contract.md` |
| **Conexiones WebSocket simultáneas** | **`1` por cuenta** en `wss://socket.massive.com/stocks` (compartida entre todas las API keys; **la nueva conexión expulsa a la anterior**) | **`1` por cuenta** en `wss://socket.massive.com/options` (compartida entre todas las API keys; **la nueva conexión es rechazada en `auth`**) | `https://massive.com/knowledge-base/article/how-many-massive-websocket-connections-can-i-use-at-one-time` |
| **Flat Files (S3 CSV.gz)** | Incluidos (`day_aggs_v1`, `minute_aggs_v1`, `trades_v1`, `quotes_v1` desde `2003-09-10`, **sin ajustar por splits**) | Incluidos (`day_aggs`, `minute_aggs`, `trades` desde `2014-06-02`; `quotes` desde `2022-03-07`) | `https://massive.com/docs/flat-files/stocks/overview.md`, `.../options/overview.md` |
| **Formación de barras REST** | Solo agregados ya calculados (la barra `1m` aparece 1–11 s post-cierre) | Igual mecánica de agregación basada en trades calificados OPRA (`1m` al cerrar el minuto) | `https://massive.com/knowledge-base/article/how-does-massive-create-aggregate-bars` |
| **Host REST** | Canónico `https://api.massive.com` (`https://api.polygon.io` sigue operativo como dominio histórico) | Igual (`api.massive.com` / `api.polygon.io`) | `https://massive.com/docs/rest/quickstart.md` |

### 2.2 Detalle de Endpoints REST incluidos en Stocks Advanced
- **Agregados (OHLCV + `vw` + `n`):**
  - `GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}` (timespans: `second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`; `adjusted` true por defecto; `from`/`to` YYYY-MM-DD o Unix ms) — `https://massive.com/docs/rest/stocks/aggregates/custom-bars.md`
  - `GET /v1/open-close/{stocksTicker}/{date}` (OHLC + `preMarket`, `afterHours`) — `https://massive.com/docs/rest/stocks/aggregates/daily-ticker-summary.md`
  - `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` — `https://massive.com/docs/rest/stocks/aggregates/daily-market-summary.md`
  - `GET /v2/aggs/ticker/{stocksTicker}/prev` — `https://massive.com/docs/rest/stocks/aggregates/previous-day-bar.md`
- **Snapshots:**
  - `GET /v3/snapshot` (**Unified Snapshot**, hasta **250 tickers** con `ticker.any_of`, mezcla `stocks`, `options`, `indices`, `fx`, `crypto`; devuelve `session`, `last_minute`, `last_quote`, `last_trade`, `market_status`; **nota de cambio inminente documentado:** el valor `market_status: "overnight_trading"` entra en vigencia el **`2026-12-07`** para SIP 23/5). Durante `early_trading`, `session.open/high/low/close/vwap` se omiten hasta las 09:30 ET; solo `price` y `volume` avanzan en vivo — `https://massive.com/docs/rest/stocks/snapshots/unified-snapshot.md` y KB `why-is-the-stocks-snapshots-day-bar-zero-before-the-open-and-how-do-i-get-the-pre-market-change`.
  - `GET /v2/snapshot/locale/us/markets/stocks/tickers/{stocksTicker}` (Single Ticker; `day`, `min`, `prevDay`, `lastQuote`, `lastTrade`; sin `fmv`) — `https://massive.com/docs/rest/stocks/snapshots/single-ticker-snapshot.md`
  - `GET /v2/snapshot/locale/us/markets/stocks/tickers` (Full Market, 10k+ tickers, cleared ~03:30 EST, repopula ~04:00 EST) — `https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot.md`
  - `GET /v2/snapshot/locale/us/markets/stocks/{direction}` (`gainers` / `losers`) — `https://massive.com/docs/rest/stocks/snapshots/top-market-movers.md`
- **Trades y Quotes:**
  - `GET /v3/trades/{stockTicker}`, `GET /v2/last/trade/{stocksTicker}`, `GET /v3/quotes/{stockTicker}`, `GET /v2/last/nbbo/{stocksTicker}` (timestamps en **nanosegundos**; NBBO real-time desde `2003-09-10`) — `https://massive.com/docs/rest/stocks/trades-quotes/trades.md`, `.../quotes.md`
- **Indicadores técnicos (cross-check):**
  - `GET /v1/indicators/{sma|ema|macd|rsi}/{stockTicker}` (`timespan`, `window`, `series_type`, `adjusted`, `expand_underlying`) — `https://massive.com/docs/rest/stocks/technical-indicators/exponential-moving-average.md`
- **Acciones corporativas y referencia:**
  - `GET /stocks/v1/dividends` (nuevo v1 con `ex_dividend_date`, `cash_amount`, `frequency`, `distribution_type`, `historical_adjustment_factor`, `split_adjusted_cash_amount`; también `/v3/reference/dividends`), `GET /stocks/v1/splits` (con `adjustment_type`, `execution_date`, `historical_adjustment_factor`; también `/v3/reference/splits`), `/v3/reference/tickers`, `/v3/reference/tickers/{ticker}`, `/stocks/v1/ticker-events` (`ticker-events` IPO/cambios ticker), `/v3/reference/conditions`, `/v3/reference/exchanges`, `/v1/marketstatus/now`, `/v1/marketstatus/upcoming`.
- **Fundamentales, Filings EDGAR y Noticias (incluidos en Stocks Advanced):**
  - Financials & Ratios: `GET /stocks/financials/v1/balance-sheets`, `cash-flow-statements`, `income-statements` (desde `2009-03-29`) y `GET /stocks/financials/v1/ratios` (verificado `200 OK` en `probe3`, exclusivo de Stocks Advanced frente a Basic/Starter/Developer/Business base).
  - Short Interest (`GET /stocks/v1/short-interest`, quincenal desde `2017-12-29`), Short Volume (`GET /stocks/v1/short-volume`, diario desde `2024-02-06`), Float (`GET /stocks/vX/float`), Filings EDGAR (`10-K`, `8-K`, `13-F`, `Form 3`, `Form 4`, `insiders`), y News (`GET /v2/reference/news`, desde `2016-06-22`).
- **Macro / Tasas libres de riesgo (Economy API — Incluido en TODOS los planes individuales):**
  - `GET /fed/v1/treasury-yields` (curva US Treasury `yield_1_month` a `yield_30_year`, diario desde `1962-01-02`) — `https://massive.com/docs/rest/economy/treasury-yields.md`
  - `GET /fed/v1/funding-conditions` (`secured_overnight_financing_rate` = **SOFR**, `effective_fed_funds_rate`, percentiles, desde `1954-07-01`) — `https://massive.com/docs/rest/economy/funding-conditions.md`
  - También `inflation`, `inflation-expectations`, `labor-market` en `/fed/v1/*`. *(No sondeados en vivo; acceso documentado como `All Stocks plans / All Options plans: Included` -> marcar lectura práctica como verificación trivial cuando se integre).*

### 2.3 Flat Files S3 (Stocks y Options)
- **Endpoint S3:** `https://files.massive.com` | **Bucket:** `flatfiles` — `https://massive.com/docs/flat-files/quickstart.md`
- **Publicación y reemplazos:** Disponibles alrededor de las **11:00 AM ET** del día hábil siguiente (`End-of-day`), aunque archivos ligeros de stocks aparecen antes y los archivos masivos de **Options Quotes** pueden llegar después de las 11:00 AM ET; Massive puede reemplazar un archivo ya publicado (verificar `LastModified` / `ETag`, no fiarse del reloj) — KB `what-time-are-massives-flat-files-ready-each-day`.
- **Rutas documentadas:**
  - Stocks (`https://massive.com/docs/flat-files/stocks/overview.md`): `us_stocks_sip/day_aggs_v1`, `minute_aggs_v1`, `trades_v1`, `quotes_v1` (todo desde `2003-09-10`). **Atención:** todos los Flat Files de acciones contienen precios y volúmenes **SIN ajustar por splits**; los timestamps `window_start` y `sip_timestamp` son **Unix en nanosegundos** (a diferencia de REST aggs en milisegundos). Además, `minute_aggs` de Flat Files **NO** trae columna `vw` (solo `ticker,volume,open,close,high,low,window_start,transactions`).
  - Options (`https://massive.com/docs/flat-files/options/overview.md`): `S3 /options/day-aggregates`, `/options/minute-aggregates`, `/options/trades` (desde `2014-06-02`) y `/options/quotes` (desde `2022-03-07`). Columnas de agregados: `ticker,volume,open,close,high,low,window_start,transactions` (sin `vw`, sin griegas, sin IV, sin open interest). **No** se reescalan por splits de acciones.

---

## 3. Opciones en detalle (contratos, cadena, griegas, OI, horarios y trampas)

| Dato de Opciones | Endpoint / Canal | Campos principales | Frecuencia / Recencia | Aplica al plan | URL de documentación |
| --- | --- | --- | --- | --- | --- |
| **Contratos de referencia (lista y detalle)** | `GET /v3/reference/options/contracts` y `/{options_ticker}` (`limit <= 1000`, filtros `underlying_ticker`, `expiration_date.*`, `strike_price.*`, `contract_type`, `expired`, `as_of`) | `ticker`, `underlying_ticker`, `contract_type` (`call`/`put`/`other`), `exercise_style` (`american`/`european`/`bermudan`), `expiration_date`, `strike_price`, `shares_per_contract`, `primary_exchange`, `cfi`, `correction`, `additional_underlyings`, `type` (`standard`/`binary`), `underlying_type` (`kpi`/`equity`) | Actualización **diaria**; historia `2014-06-02` | **Sí** (Options Advanced) | `https://massive.com/docs/rest/options/contracts/all-contracts.md`, `.../contract-overview.md` |
| **Cadena / Snapshot de contrato / Unificado** | `GET /v3/snapshot/options/{underlyingAsset}` (`limit <= 250` + `next_url`), `/{optionContract}`, `GET /v3/snapshot` | `break_even_price`, `day` (`o/h/l/c/v/vwap/previous_close/change`), `details` (`ticker`, `contract_type`, `exercise_style`, `expiration_date`, `shares_per_contract`, `strike_price`), `greeks` (`delta/gamma/theta/vega`), `implied_volatility`, `open_interest`, `last_quote` (`bid/ask/midpoint/sizes/exchanges/last_updated`), `last_trade`, `underlying_asset` (`price` o `value` en índices). **Sin `fmv`/`fmv_last_updated`** | **Tiempo real** en `last_quote`, `last_trade`, `underlying_asset` (sujeto a plan del subyacente); `open_interest` EOD | **Sí** (Options Advanced + Stocks/Indices Advanced) | `https://massive.com/docs/rest/options/snapshots/option-chain-snapshot.md`, `.../option-contract-snapshot.md` |
| **Griegas e IV del proveedor** | Dentro de `/v3/snapshot/options/...` y `/v3/snapshot` únicamente | `greeks.{delta, gamma, theta, vega}`, `implied_volatility` | En demanda en cada snapshot (tiempo real); **ausentes en historia, `/v2/aggs` y Flat Files** | **Sí** (con defectos medidos, ver §3.1) | `https://massive.com/blog/greeks-and-implied-volatility/` |
| **Open Interest histórico** | `GET /options/v1/open-interest` (`limit <= 50_000`, `ticker`, `root`, `date.*`, `expiration_date.*`, `contract_type`; JSON y Apache Arrow) | `ticker`, `root`, `underlying_ticker`, `date`, `expiration_date`, `strike_price`, `contract_type`, `open_interest` | **Diario** cada mañana para la sesión previa; historia desde **`2022-09-01`** | **Sí** (exclusivo Options Advanced en individuales) | `https://massive.com/docs/rest/options/analytics/open-interest-by-contract.md` |
| **Unusual Options Activity** | `GET /options/v1/unusual-trades` (`limit <= 50_000`, filtros `ticker`, `underlying_ticker`, `root`, `flags`, `sip_timestamp.*`, `min_premium`) | `ticker`, `underlying_ticker`, `root`, `price`, `size`, `exchange`, `conditions`, `flags` (`block_premium >= $100k`, `block_size >= 1000`, `iso` cond `219`), `sip_timestamp`, `sequence_number` | **Tiempo real**; historia desde **`2022-09-01`** | **Sí** (exclusivo Options Advanced en individuales) | `https://massive.com/docs/rest/options/unusual-options-activity/unusual-trades.md` |
| **Agregados por contrato** | `GET /v2/aggs/ticker/{optionsTicker}/range/{mult}/{timespan}/{from}/{to}`, `/v1/open-close/{optionsTicker}/{date}`, `/v2/aggs/ticker/{optionsTicker}/prev` | `o`, `h`, `l`, `c`, `v`, `vw`, `n`, `t` (Unix ms) | **Tiempo real** (incl. `1/second`); historia desde **`2014-06-02`** | **Sí** | `https://massive.com/docs/rest/options/aggregates/custom-bars.md` |
| **Trades y Quotes OPRA** | `GET /v3/trades/{optionsTicker}`, `GET /v2/last/trade/{optionsTicker}`, `GET /v3/quotes/{optionsTicker}` | Trades: `price`, `size`, `decimal_size`, `exchange`, `conditions`, `correction`, `sip_timestamp` (ns). Quotes: `bid_price/size/exchange`, `ask_price/size/exchange`, `sip_timestamp` (ns), `sequence_number` | **Tiempo real**; trades desde `2014-06-02`, quotes desde **`2022-03-07`** | **Sí** (quotes exclusivo Advanced) | `https://massive.com/docs/rest/options/trades-quotes/trades.md`, `.../quotes.md` |
| **Expiraciones** | Campo `expiration_date` en `/v3/reference/options/contracts` y `/v3/snapshot/options/...` (y dentro del ticker OCC `YYMMDD`) | `expiration_date` (`YYYY-MM-DD`); expiradas requieren `expired=true` o `as_of=YYYY-MM-DD` en `/v3/reference/options/contracts` | Diario; Snapshot elimina contratos vencidos | **Sí** | KB `why-does-the-options-contracts-endpoint-return-nothing-for-a-past-expiration-date` |
| **Acciones corporativas y contratos ajustados** | `GET /v3/reference/options/contracts` (`additional_underlyings`, `correction`, `root` en `/options/v1/*`) + `/stocks/v1/splits`, `/stocks/v1/dividends` | `additional_underlyings` (`[{type, underlying, amount}]`), `correction`, raíz `root+dígito` (p. ej. `O:GME1...` vs `O:GME...`) | Diario; series ajustadas conviven en paralelo sin fusionarse | **Sí** | KB `how-does-massive-handle-adjusted-options-contracts` |
| **Contratos binarios / no estándar** | `GET /v3/reference/options/contracts` (`type`, `underlying_type`, `cfi`, `additional_underlyings`) y `WS /options/AD` (`FLEX`) | `type: "binary"`, `underlying_type: "equity" \| "kpi"`, `shares_per_contract != 100`, `AD.*` para mensajes administrativos **OPRA FLEX** en vivo | Diario en REST; **tiempo real** en `WS /options` `AD` | **Sí** (`AD` exclusivo Options Advanced en individuales) | `.../contract-overview.md` y `https://massive.com/docs/websocket/options/admins.md` |

### 3.1 Trampas críticas verificadas en Opciones (evidencia de sondas + KB)

1. **Defectos numéricos medidos en griegas/IV del proveedor (`probe4`):**
   - Massive calcula sus griegas en el snapshot usando árbol binomial **Cox-Ross-Rubinstein (CRR)** + **Brent** sobre `last_quote.midpoint`, con tasa libre de riesgo derivada de **SOFR** y dividend yield continuo (`https://massive.com/blog/greeks-and-implied-volatility/`).
   - **Casos patológicos medidos en vivo (`probe4_result.json`):**
     - En `O:SPXW261113C03000000` (0DTE europeo muy ITM), Massive devolvió **`gamma: -8.382775764976022e-09`** (Gamma **negativo**, imposible en BSM clásico para una call estándar).
     - En `O:VIX261118C00010000` y `O:VIX261118C00010500`, devolvió **`gamma: 3.297e-9` / `-3.297e-9`**, **`vega: -1.0875e-5` / `-1.631e-5`** (Vega y Gamma negativos) e **`IV: 0.000877`**, porque Massive evalúa contra el índice spot `I:VIX` (`18.8`) en lugar del **futuro VIX** correspondiente al vencimiento (modelo Black-76).
   - **Valores faltantes por diseño:** Cuando una opción americana ITM tiene `midpoint < valor intrínseco`, o una opción de índice OTM tiene `bid = 0`, Massive devuelve `greeks: {}` (objeto vacío presente en el JSON) y omite `implied_volatility` (`why-are-greeks-and-implied-volatility-missing-from-the-options-snapshot`). **Regla obligatoria:** jamás leer `greeks.delta ?? 0` ni tratar `{}` como cero; si falta o es no finito debe mapearse a `NaN`.

2. **Contratos binarios y ajustados mezclados en búsquedas por subyacente:**
   - En `probe1`, `GET /v3/reference/options/contracts?underlying_ticker=SPY&limit=1` devolvió en primera posición **`O:B1SPY261113C00710000`**, con **`type: "binary"`**, **`cfi: "OCESCS"`** y **`additional_underlyings: [{"type": "currency", "underlying": "USD", "amount": 100}]`**.
   - Asimismo, los contratos ajustados tras splits/spinoffs/dividendos extraordinarios (p. ej. `O:GME1...`) devuelven **`shares_per_contract: 100`** igual que los estándar; la prueba fiable es revisar **`additional_underlyings`** (presente y no vacío -> excluir de cadenas estándar) además de `type === 'binary'` o `shares_per_contract !== 100`.
   - En `/options/v1/open-interest` y `/options/v1/unusual-trades`, el campo `underlying_ticker` agrupa semanales y ajustados (`SPXW` -> `SPX`, `AMCR1` -> `AMCR`); usa `root` para distinguirlos (`SPXW` vs `SPX`, `AMCR1` vs `AMCR`).

3. **Asimetría de prefijo `I:` en opciones sobre índices:**
   - `/v3/snapshot/options/I:SPX` **exige `I:`** (sin prefijo devuelve contratos con `greeks: {}` y sin `implied_volatility`), e incluye `underlying_asset.value` en lugar de `underlying_asset.price`.
   - `/v3/reference/options/contracts?underlying_ticker=SPX` **exige el símbolo sin `I:`** (con `I:SPX` devuelve lista vacía). Verificado en `probe4` y KB `does-massive-support-options-data-for-index-contracts`.

4. **Contratos vencidos en `/v3/reference/options/contracts`:**
   - Por defecto `expired=false` y `as_of=hoy`. Para consultar historia vencida es obligatorio pasar `expired=true` o `as_of=YYYY-MM-DD` anterior al vencimiento. Para OI histórico de contratos ya vencidos, `/options/v1/open-interest` conserva registros desde `2022-09-01`.

5. **Horarios extendidos de opciones (`07:30 ET` y `16:15–17:00 ET`):**
   - Desde octubre 2026, Cboe/opra operan sesión temprana **`07:30–09:25 ET`** en ~29+ clases seleccionadas (ETF `SPY`, `QQQ`, `IWM`, `GLD`, `XLF` + acciones seleccionadas), con trades marcados con código de condición **`248`** (*Extended Hours Trade*) y quotes reales desde las 07:30 ET.
   - Sesión regular: `09:30–16:00 ET` (`16:15 ET` en productos como `SPY`, `SPX`). Algunas acciones/ETFs operan **Curb** `16:00–16:15 ET` y `SPXW` llega hasta `~17:00 ET`. En `/v3/snapshot`, las opciones sobre índices solo calculan cambio de sesión regular.

---

## 4. WebSocket en profundidad y solución al lag REST (barra en formación)

URLs de producción en tiempo real (`wss://delayed.massive.com/...` solo si no tienes plan real-time):
- Stocks: `wss://socket.massive.com/stocks`
- Options: `wss://socket.massive.com/options`
- Indices: `wss://socket.massive.com/indices` (acceso incluido según sonda de snapshots, no sondeado vía WS)

### 4.1 Flujo de conexión, autenticación, suscripción y reconexión
1. Al abrir TLS WebSocket, el servidor envía `[{"ev":"status","status":"connected","message":"Connected Successfully"}]`.
2. El cliente envía `{"action":"auth","params":"YOUR_API_KEY"}` y espera `[{"ev":"status","status":"auth_success","message":"authenticated"}]`.
3. Solo tras `auth_success` envía `{"action":"subscribe","params":"AM.SPY,A.SPY"}` (soporta múltiples mensajes `subscribe` separados o listas separadas por coma). Responde un objeto `status: "success"` por cada entrada.
4. **Reset nocturno diario:** Todos los clusters (salvo Futures, que reinicia sábados) **se desconectan poco después de la medianoche ET**. Al desconectarse, el servidor tarda **~10 a 30 s** en liberar el cupo; reconectar al instante puede provocar un `max_connections` falso. Implementar backoff con espera inicial >= 15–30 s ante reset de medianoche (`why-do-massive-websocket-disconnects-happen`).
5. **Consumidor lento (*Slow Consumer*):** Desconexión abrupta **sin** mensaje `status` previo al llenarse el buffer del servidor (muy probable con `Q.*` en Stocks o grandes listas de `Q` en Options). Regla obligatoria de arquitectura: separar lectura del socket + cola en memoria del parseo/cálculo pesado en el consumidor.

### 4.2 Canales útiles para Stocks y Options

| Canal | Cluster | Plan | Wildcard `*` / Límite | Timestamp | Campos clave |
| --- | --- | --- | --- | --- | --- |
| **`A`** (1-sec aggs) | `/stocks`, `/options` | Stocks Adv / Options Adv | `A.*` permitido (`120k+` tickers probados en KB) | `s`, `e` en **Unix ms** | `ev`, `sym`, `o`, `h`, `l`, `c`, `v`, `vw`, `av`, `op`, `a` (VWAP del día), `z`, (+ `dv`, `dav`, `otc` en stocks) |
| **`AM`** (1-min aggs) | `/stocks`, `/options` | Stocks Adv / Options Adv | `AM.*` permitido | `s`, `e` en **Unix ms** | Mismos campos que `A`, ventana de 1 minuto |
| **`T`** (Trades) | `/stocks`, `/options` | Stocks Adv / Options Adv | `T.*` permitido | `t` en **Unix ms** (`pt`, `trft` ms en stocks) | Stocks: `sym`, `p`, `s`, `ds`, `c`, `x`, `i`, `z`, `q`, `trfi`. Options: `sym`, `p`, `s`, `c`, `x`, `t`, `q` |
| **`Q`** (Quotes) | `/stocks`, `/options` | Stocks Adv / Options Adv | En `/stocks` `Q.*` permitido (alto volumen). En **`/options` MÁXIMO `1,000` contratos** por conexión | `t` en **Unix ms** (`pt` ms en stocks) | Stocks: `bp`, `ap`, `bs`, `as`, `bx`, `ax`, `c`, `i`, `z`, `q`. Options: `bp`, `ap`, `bs`, `as`, `bx`, `ax`, `t`, `q` |
| **`LULD`** | `/stocks` | Stocks Adv | `LULD.*` | `t` en **Unix ms** | `T`, `h`, `l`, `i`, `z`, `q` (bandas LULD y halts) |
| **`AD`** (Admin/FLEX) | `/options` | Options Adv | `AD.*` (por `exchange_id`) | `t` en **Unix ns** | `i`, `x`, `m` (texto OPRA FLEX), `q`, `rt` |
| `FMV` / `NOI` | Business / Expansion | **NO incluido** | — | — | Exclusivos de Business (`FMV`) e Imbalances Expansion (`NOI`) |

### 4.3 Hallazgo operativo crítico en `/stocks` (`max_connections`)
- En las 2 pruebas a `wss://socket.massive.com/stocks` (`probe1` y `probe2`), la conexión autenticó, suscribió `A/AM/T/Q`, recibió datos en tiempo real y fue expulsada a los **~8.9 s** por `status: "max_connections"`.
- Verificación local: `0` conexiones salientes hacia Massive en Windows. Combinado con la regla documentada por Massive (en `/stocks`, una nueva conexión **cierra a la antigua**; en `/options`, la rechaza al autenticar — y `/options` corrió 150 s sin problemas), **existe un proceso externo usando la misma cuenta/clave en un bucle de reconexión cada ~9–10 s en `/stocks`**.
- **Consecuencia:** Ningún cliente WebSocket de `/stocks` será estable mientras ese proceso siga vivo (o hasta solicitar/contratar una segunda conexión para `/stocks`).

### 4.4 Mediciones de latencia real y cómo resuelve la barra en formación (vs REST 1–11 s)
Con reloj local corregido (`+408 ms`):

| Canal medido | Muestra (`probe1`/`probe2`) | Latencia real medida (p50) | Rango observado corregido | Comportamiento observado |
| --- | --- | --- | --- | --- |
| **`/stocks` `Q.SPY`** | `n = 1_815` (en ~8.9 s) | **~125 ms** | `~72 ms` a `~270 ms` | Flujo tick a tick continuo |
| **`/stocks` `T.SPY`** | `n = 142` (en ~8.9 s) | **~137 ms** | `~89 ms` a `~291 ms` | Flujo tick a tick continuo |
| **`/stocks` `A.SPY`** | `n = 7` / `n = 7` | **~2.10 s** (post cierre `e`) | `~2.08 s` a `~2.10 s` | Espera fija de **+2 s** por ventana FINRA TRF (`late-trade window`), documentada en KB |
| **`/options` `Q`** | `n = 2_335` (150 s) | **~381 ms** | `~90 ms` a `~783 ms` | NBBO opciones continuo |
| **`/options` `T`** | `n = 872` (150 s) | **~425 ms** | `~168 ms` a `~839 ms` | Trades OPRA en vivo |
| **`/options` `A`** | `n = 146` (150 s) | **~2.11 s** (post cierre `e`) | `~2.08 s` a `~2.18 s` | 1 mensaje por segundo con trades |
| **`/options` `AM`** | `n = 2` (150 s) | **~2.10 s** (post cierre `e`) | `~2.09 s` a `~2.11 s` | En `/options` solo emitió al cerrar el minuto (sin barra intra-minuto cada segundo); en minuto completo (`1794580680000`), la suma de los 58 `A` (`v=2258, o=0.87, h=0.9, l=0.78, c=0.83`) fue **100 % idéntica** a `AM` |

**Cómo resuelve el WebSocket la barra en formación y las limitaciones medidas del REST (`docs/forming_bar_live.md` y `daily_vs_intraday.md`):**
1. **Eliminación de latencia intra-barra (`~0.13 s` / `~2.1 s` vs `1–11 s` + ausencia en REST):**
   - El REST jamás entrega el minuto en curso y publica el minuto cerrado con `1–11 s` de retraso.
   - Con WebSocket, la barra de `1m` (y `5m`/`15m`/`1h`) **en formación** se construye localmente en vivo acumulando **`T`** (~137 ms) o **`A`** (~2.1 s, filtrando ya los trades no elegibles!) sobre una **proyección inmutable** desde el estado de la última barra cerrada (`projectLiveEma`, `projectLiveSessionVwap`, `projectLiveAvwap` ya existentes en `src/core/`).
2. **Regla obligatoria de `upsert` / reemplazo por timestamp `s` (y ventana de trades tardíos):**
   - Massive documenta explícitamente (`why-am-i-receiving-a-late-aggregate-bar...`) que `A` y `AM` en Stocks permanecen abiertos a trades tardíos (FINRA TRF hasta 10 s) y **se retransmiten durante 15 minutos** desde el inicio del intervalo (`s`). Si llega otro `AM` o `A` con un `s` ya visto, **SE SOBRESCRIBE completo; NUNCA se suman sus volúmenes ni se duplica la barra**.
   - Cancelaciones o correcciones posteriores a 15 min solo se reflejan en REST / Flat Files (y el campo `av` / barra diaria sigue recalculándose toda la sesión).
3. **Resolución parcial de la brecha intradía vs `1D` (`daily_vs_intraday.md`):**
   - `AM`/`A` WS siguen la misma elegibilidad intradía (sin el 3–18 % de impresiones bloque/especiales fuera de barra de minuto), pero `op` (official open), `av` (today's accumulated volume) y `a` (today's VWAP) en mensajes `A`/`AM` — y `/v3/snapshot` `session` — **sí** exponen el volumen/precio diario acumulado oficial sin esperar al cierre de medianoche ET que mostraba `/v2/aggs/.../1/day`.

---

## 5. Tabla consolidada: Qué cubre y qué NO cubre mi plan

| Categoría / Capacidad | Estado en el plan actual | Cobertura exacta / Límite | Fuente / Evidencia |
| --- | --- | --- | --- |
| **Stocks REST (Bars, Trades, NBBO Quotes, Snapshots, Corporativos, Indicadores)** | **CUBIERTO (Tiempo real)** | Peticiones **ilimitadas**; historia desde `2003-09-10` (splits `1978`, divs `2000`); `50_000` filas/página | `pricing`, `probe1`, `probe3` |
| **Stocks Fundamentals, Filings EDGAR, News, Short Interest/Volume** | **CUBIERTO** | `balance-sheets`, `income-statements`, `cash-flow-statements`, `ratios`, `10-K/8-K/13-F/Form 4`, `news` | `rest_stocks_*_md`, `probe3` (`ratios`) |
| **Options REST (Contracts, Chain/Contract Snapshots, Trades, Quotes, Bars, OI histórico, Unusual Trades)** | **CUBIERTO (Tiempo real)** | Peticiones **ilimitadas**; contratos/bars/trades `2014-06-02`; quotes `2022-03-07`; OI & unusual `2022-09-01`; chain `limit <= 250` | `pricing?product=options`, `probe1`, `probe3` |
| **Griegas e IV del proveedor (`/v3/snapshot/options/...`)** | **CUBIERTO (con salvedades)** | Solo en snapshot (no históricas); CRR + Brent + midpoint; vacías si ITM `< intrínseco` u OTM bid `0`; **fallos en `I:VIX` e ITM `SPXW`** | `probe1`, `probe4`, KB `greeks` |
| **WebSocket Stocks (`A`, `AM`, `T`, `Q`, `LULD`)** | **CUBIERTO (`1` conexión, bloqueada externamente hoy)** | Real-time; `*` permitido. **Hoy expulsa a los ~8.9 s por `max_connections` (consumidor externo activo)** | `probe1`, `probe2`, KB WS |
| **WebSocket Options (`A`, `AM`, `T`, `Q`, `AD` FLEX)** | **CUBIERTO (`1` conexión, operativa 100 %)** | Real-time; `A/AM/T/AD` con `*`; **`Q` máximo `1,000` contratos/conexión** | `probe1`, `websocket_options_*_md` |
| **Flat Files S3 (`files.massive.com/flatfiles`) Stocks y Options** | **CUBIERTO por contrato [PENDIENTE CLAVES S3]** | CSV.gz EOD (~11:00 ET día +1); `us_stocks_sip/*` **sin ajustar por splits** y sin `vw`; requiere crear S3 keys en dashboard | `flat_files_*_md`, `.env` |
| **Economy / Tasas Fed & Treasury (`/fed/v1/treasury-yields`, `funding-conditions` SOFR)** | **CUBIERTO** | Incluido en todos los planes; diario (Treasury desde `1962`, SOFR/Fed Funds desde `1954`) **[HIPÓTESIS operativa: no sondeado aún con `GET`]** | `rest/economy/*.md` |
| **Índices (`I:SPX`, `I:VIX`, `I:SKEW`, `I:NDX`) y Currencies (`X:BTCUSD`, `C:EURUSD`)** | **CUBIERTO EN SNAPSHOT REAL-TIME [TIER EXACTO POR CONFIRMAR]** | Confirmado `200 OK` + `REAL-TIME` en `/v3/snapshot` y cadenas de opciones `I:SPX` / `I:VIX`. Profundidad histórica y WS **[HIPÓTESIS: confirmar en dashboard si es Indices Advanced + Currencies]** | `probe4` |
| **Fair Market Value (`fmv`, `WS /business/*/FMV`)** | **NO CUBIERTO** | Exclusivo de planes *Business*; campo omitido en todos los snapshots | `probe1`, `probe3`, docs WS/REST |
| **NYSE Order Imbalances (`WS /stocks/NOI`)** | **NO CUBIERTO** | Add-on separado (*Imbalances Expansion*, `$49/mes`) | `websocket_stocks_imbalances_md` |
| **Múltiples conexiones WS simultáneas por cluster (> 1)** | **NO CUBIERTO** | Planes individuales incluyen exactamente **`1` conexión por cluster** | KB `how-many-massive-websocket...` |
| **Datos Partner Benzinga (Earnings, Ratings, News Benzinga)** | **NO CUBIERTO [HIPÓTESIS]** | Endpoints de terceros (`/benzinga/*`) habitualmente requieren suscripción partner adicional; usar `/stocks/v1/*`, `/v2/reference/news` y EDGAR en su lugar | `docs/llms.txt` (`rest/partners/benzinga`) |
| **Griegas históricas / Open Interest intradía en vivo / OI por snapshot histórico** | **NO EXISTE EN EL PROVEEDOR** | Ningún endpoint histórico o de Flat Files de Massive entrega griegas/IV ni OI intradía; OI histórico solo diario EOD vía `/options/v1/open-interest` | KB `does-massive-have-historical-open-interest...` |
