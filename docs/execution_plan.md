# Plan de Ejecución Técnico — Terminal Cuantitativo US Stocks & Opciones

> **Destinatario operativo:** Agente de código **"Argon 4 Hydrogen"** (prompts listos para copiar y pegar pieza por pieza).  
> **Restricción base del proyecto:** El núcleo ya implementado en `src/core/` (`types.ts`, `welford.ts`, `ema.ts`, `sessions.ts`, `sessionVwap.ts`, `avwap.ts`) y la lógica de BingX están **CONGELADOS**. Toda matemática nueva debe vivir en funciones puras TypeScript sin red, sin UI, sin mutación de argumentos y con valores `NaN` explícitos ante datos no calculables (nunca fallbacks con `||` o `??`).  
> **Compilador (`tsconfig.json`):** `NodeNext` (imports relativos con extensión `.js`), `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noPropertyAccessFromIndexSignature: true`, `verbatimModuleSyntax: true`.

---

## (a) Auditoría del sistema actual frente al plan Massive

### Alerta previa obligatoria sobre el working tree actual (`2026-11-13`)
Al ejecutar `npm run verify` en el estado actual del repositorio antes de iniciar nuevas piezas:
- `tsc --noEmit` y `eslint .`: **pasan** sin errores.
- `vitest run`: **335 pasan / 2 fallan de 337 tests** (`10` archivos en verde, `1` en rojo: `tests/dataLoader.test.ts`).
- **Los 2 fallos concretos:** `lm47_provider_error_http_429` y `lb19_provider_error_http_429_non_json`.
- **Causa exacta verificada en el diff sin commitear:** `src/data/loader.ts` fija `retry429MaxAttempts ?? 2` por defecto en lugar de `0` (opt-in), haciendo que los casos simulados de un único HTTP 429 en `fixtures/data_layer_reference.json` reintenten y reciban `"unexpected request"` del mock. Además existen archivos sin commitear del paso de retry (`src/data/retry.ts`, `tests/retry.test.ts`, `tests/dataRetry.test.ts`, `tools/gen_retry_reference.py`, `fixtures/retry_reference.json`). **La Pieza 0 debe sanear esto antes de continuar.**

### Tabla de mejoras desbloqueadas por el plan (Stocks Advanced + Options Advanced + Indices)

| Área / Capacidad disponible | Situación actual en el repo | Mejora concreta posible | Beneficio | Riesgo | Coste |
| --- | --- | --- | --- | --- | --- |
| **1. Ritmo y reintento REST (`src/data/loader.ts`, `tests/dataLoader.smoke.ts`, `tools/capture_samples.py`)** | `smoke:next-url` espera `13_001 ms` entre páginas y `capture_samples.py` `12 s` (pensado para 5 RPM gratis). `loader.ts` ya tiene `minRequestIntervalMs = 0`, pero dejó `retry429MaxAttempts = 2` rompiendo 2 tests. | Hacer `retry429MaxAttempts = 0` por defecto (opt-in) para recuperar 337/337 verdes; usar `minRequestIntervalMs = 0` en producción/smoke para activos pagados y reservar throttle lento únicamente para activos Basic (5 RPM). | Recupera verde de CI y acelera cargas multipágina ~10x sin falsos sleeps. | **Bajo:** riesgo mínimo si el smoke mantiene opción configurable vía variable/flag para pruebas en plan Basic. | **S** |
| **2. Host REST canónico (`api.massive.com`)** | `src/data/loader.ts` usa `MASSIVE_BASE_URL = 'https://api.polygon.io'` (aunque la whitelist `MASSIVE_NEXT_URL_ORIGINS` acepta ambos). | Permitir o migrar el host por defecto a `https://api.massive.com` manteniendo ambos en `MASSIVE_NEXT_URL_ORIGINS`. | Consistencia directa con endpoints nuevos (`/options/v1/*`, `/stocks/v1/*`, `/fed/v1/*`). | **Bajo:** requiere verificar qué pruebas unitarias de URL en `tests/dataLoader.test.ts` esperan `api.polygon.io`. | **S** |
| **3. WebSocket en vivo (`A`, `AM`, `T`, `Q`) para barra en formación (`docs/forming_bar_live.md`)** | REST jamás entrega el minuto en curso y publica el minuto cerrado con `1–11 s` de demora; `loadBars` excluye la barra en formación. | Conectar `wss://socket.massive.com/options` (operativo) y `/stocks` (**tras eliminar el conflicto `max_connections` de ~8.9 s**); consolidar ticks `T` (~137 ms stocks / ~425 ms options) o `A` (~2.1 s) como barra viva sobre el estado cerrado usando `projectLiveEma`, `projectLiveSessionVwap`, `projectLiveAvwap`, haciendo *upsert* al llegar `AM`. | Elimina el hueco de `1–11 s` y habilita velas/indicadores/Greeks realmente en vivo. | **Alto hoy en `/stocks`:** hay un consumidor externo compitiendo cada ~9 s. Además, riesgo de *slow consumer* si se suscribe `Q.*` sin cola asíncrona, y desfase hasta 15 min por rebroadcasts FINRA TRF. | **L** |
| **4. Unified Snapshot (`GET /v3/snapshot`) y Single Ticker Snapshot** | Para barra `1D` en curso, `/v2/aggs/.../1/day` omite o parcializa el día actual; el pre-market (`04:00–09:30`) no tiene `1D`. | Consultar `GET /v3/snapshot?ticker.any_of=...` (hasta 250 activos en **1 request**): entrega `SPY`, `QQQ`, `I:SPX`, `I:VIX`, `I:SKEW`, `I:NDX`, estado `market_status` y volumen/precio pre-market vivo. | Cero polleo pesado para Watchlist + índices macro; resuelve contexto pre-market y brecha diaria parcial (`session.volume` / `op` / `av`). | **Medio:** el **`2026-12-07`** Massive introduce `market_status: "overnight_trading"` (SIP 23/5), y en pre-market `session.open/high/low/close/vwap` se omiten hasta las 09:30 ET. | **M** |
| **5. Indicadores técnicos REST (`/v1/indicators/ema/...`)** | Cálculo 100 % propio en `src/core/ema.ts` (congelado). | Usar `/v1/indicators/ema` **SOLO como herramienta de auditoría offline** en `tools/` (nunca en producción ni reemplazo de `src/core/ema.ts`). | Permite comparar divergencias entre cierres de sesión extendida vs RTH o ajustes por split sin tocar el core. | **Bajo** si queda estrictamente confinado a `tools/` de lectura. | **S** |
| **6. Flat Files S3 (`https://files.massive.com`)** | Todo histórico hoy depende de paginación REST (`/v2/aggs`). `.env` aún no tiene claves S3. | Incorporar un ingestor/cache local en `tools/` o capa offline para descargar CSV.gz diarios (`minute_aggs`, `trades`, `quotes` de Stocks y Options) tras generar S3 keys. | Backtesting multi-año de cadenas de opciones e historia masiva de 20 años sin saturar paginación REST. | **Medio:** los archivos de acciones **NO están ajustados por splits** ni incluyen columna `vw`; archivos pesados de Quotes Options pueden publicarse después de las 11:00 ET y ser reemplazados luego (`ETag`/`LastModified`). | **M/L** |
| **7. Agregados `1/second` + Trades/Quotes NBBO `/v3/`** | Solo se ingieren barras >= `1m` OHLCV. | Usar `quotes` para medir liquidez real del spread bid-ask en opciones y `trades` + `conditions` cuando se avance hacia CVD/absorción o flujo institucional. | Evita calibrar IV/Greeks sobre contratos ilíquidos con spread roto o bid=0. | **Medio:** volumen de datos alto en símbolos activos; requiere filtrar códigos de condición (`conditions`). | **M** |
| **8. Rendimiento del cargador (`A7` en `docs/audit_data_layer.md`)** | `loadBars` ejecuta `normalizeMassiveAggs` completo en cada iteración de página (`O(pages * N log N)`). | Mantener sin cambios hasta necesitar > 10 páginas frecuentes (500k+ filas por llamada). | Ahorra latencia solo en cargas históricas gigantes. | **Bajo:** riesgo de introducir regresiones en reporte de huecos/recorte si se toca prematuramente. | **S** |

---

## (b) Alcance del motor de opciones por etapas

Separar estrictamente la **ingesta/adaptación dependiente de Massive** (`src/data/`) de la **matemática cuantitativa pura** (`src/core/options/`, 100 % sin red ni proveedor):

```
[Etapa 1: Capa de Datos Massive]  --->  [Etapa 2: Valuación Pura + IV]  --->  [Etapa 3: Superficie & Term]  --->  [Etapa 4: GEX / Skew / Walls]
   Contratos, Cadenas, OI, Trades,         BSM / Black-76 / Bjerksund,          Paridad Put-Call (Forward F),      Net GEX/DEX/Vanna/Charm,
   Tasas /fed/v1, Dividendos               Griegas 1°/2° orden, Brent IV        w(k, T) libre arbitraje, IV_ATM      Zero Gamma, Skew 25d, Exp. Move
```

### Etapa 1 — Datos de Opciones, Tasas y Dividendos *(Dependiente de Massive)*
- **Contratos (`/v3/reference/options/contracts`):** normalización a formato propio con filtrado explícito de **`type === 'binary'`** (ej. `O:B1SPY...`), detección/separación de series ajustadas (**`additional_underlyings`** no vacío o `shares_per_contract !== 100`), normalización de timestamps a **segundos UTC enteros** y regla de símbolo (`SPX` para `/contracts`, `I:SPX` para `/snapshot`).
- **Cadena en vivo (`/v3/snapshot/options/{underlyingAsset}`):** paginación completa (`limit=250`), extracción separada de `bid`, `ask`, `midpoint`, `last_trade`, `open_interest` y `underlying_asset` (`price` o `value`). **Regla anti-fallback:** `greeks: {}` vacío y campos faltantes entran como `NaN` o `null` tipado, nunca como `0`.
- **Insumos macro y corporativos:** adaptador de curva libre de riesgo (`GET /fed/v1/treasury-yields` + SOFR en `/fed/v1/funding-conditions`), calendario/monto de dividendos (`GET /stocks/v1/dividends`), OI histórico EOD (`GET /options/v1/open-interest`) y flujo inusual (`GET /options/v1/unusual-trades`).

### Etapa 2 — Matemática pura de valuación, griegas e IV *(Sin red — `src/core/options/`)*
- **Por qué no usar las griegas del snapshot de Massive como verdad:** en `probe4` se midió Gamma negativo en `O:SPXW` ITM (`-8.38e-9`) y Gamma/Vega negativos + `IV=0.00088` en `O:VIX` por usar spot `I:VIX` en lugar de futuro VIX en el árbol CRR del proveedor; además no existen griegas históricas en REST ni Flat Files.
- **Modelos puros a implementar:**
  1. **Black-Scholes-Merton (BSM) europeo** con dividendo continuo `q` (para índices europeos `I:SPX`, `I:NDX`, `I:RUT` y cálculo base con forward implícito).
  2. **Black-76 sobre futuro `F`** (imprescindible para `I:VIX` y futuras opciones sobre futuros).
  3. **Modelo americano (Bjerksund-Stensland 2002 analítico rápido + árbol binomial CRR con dividendos discretos opcional)** para acciones y ETFs (`SPY`, `QQQ`, single stocks).
  4. **Griegas de 1er y 2do orden analíticas:** `Delta`, `Gamma`, `Theta` (anualizada y por día calendario/252 parametrizable), `Vega` (por 1 % = 0.01 o unitaria documentada), `Rho`, **`Vanna`** ($\partial\Delta/\partial\sigma$) y **`Charm`** ($-\partial\Delta/\partial t$).
  5. **Inversión numérica de IV:** Brent acotado + Newton-Raphson con validación estricta de cotas de no arbitraje ($\max(0, P_{intrínseco}) \le C \le S e^{-qT}$). Si el precio/midpoint viola la cota inferior, hay `bid <= 0` (si se exige bid válido) o `T <= 0`, devuelve **`NaN`**, nunca un fallback numérico.
- **Validación independiente (`tools/`):** script en Python usando distribución normal exacta (`math.erf`), diferenciación de paso complejo o `decimal`/bisección-Brent de alta precisión para generar fixtures con tolerancia `< 1e-9` (y tolerancia explícita documentada si se compara un árbol CRR discreto vs continuo).

### Etapa 3 — Superficie de Volatilidad y Estructura Temporal *(Matemática pura)*
- Filtrado puro por calidad de cotización (spread relativo `(ask - bid) / mid`, `bid > 0`, `mid > 0`, `OI` mínimo configurable).
- Extracción de **precio Forward implícito `F(T)` y dividendo implícito `q(T)`** por vencimiento mediante pares Call-Put ATM (`C - P = D * (F - K)`), eliminando errores por dividendos esperados inciertos.
- Transformación a log-moneyness $k = \ln(K / F)$ y varianza total $w(k, T) = \sigma_{\text{IV}}^2(k, T) \cdot T$.
- Ajuste/interpolación por vencimiento (spline monótono o SVI con chequeo de ausencia de arbitraje calendario $\partial w/\partial T \ge 0$ y mariposa $g(k) \ge 0$), entregando `ivAtm(T)`, estructura temporal (`T` -> `IV_ATM`) y función de consulta `ivAt(strike, expiry)` (con `NaN` fuera de rango o sin soporte).

### Etapa 4 — Métricas derivadas de posicionamiento y régimen *(Matemática pura)*
- **Skew y Term Structure:** `25-delta Risk Reversal` (`IV_25d_Put - IV_25d_Call`), `25-delta Butterfly`, pendiente de skew ATM y pendiente temporal (`IV_30d - IV_90d`, contango/backwardation) cruzable en capas superiores con `I:VIX` y `I:SKEW`.
- **Exposición de Dealers por strike y neta** *(bajo supuesto estándar de signo de posicionamiento documentado: dealers largos calls / cortos puts o convención explícita parametrizable)*: **GEX**, **DEX**, **Vanna Exposure** y **Charm Exposure**, usando `open_interest`, `shares_per_contract` y **nuestras griegas propias**.
- **Niveles clave:** **Call Wall** (máximo OI/GEX de calls), **Put Wall** (máximo OI/GEX de puts), **Gamma Flip / Zero Gamma** (raíz de GEX neto acumulado al variar `S`) y **Expected Move** (`S * IV_ATM * sqrt(T)` y straddle ATM `(C_ATM + P_ATM)`).

---

## (c) Preguntas cerradas para decisiones exclusivas del dueño

Responde estas 7 definiciones antes (o durante) la activación de las piezas dependientes:

| ID | Decisión requerida | Opciones cerradas | Recomendación |
| --- | --- | --- | --- |
| **D1** | **Fuente de verdad de Griegas e IV** | **A)** Cálculo propio puro (`BSM`/`Black-76`/`Bjerksund-Stensland`) como verdad del sistema, dejando Massive solo para auditoría. <br>**B)** Usar griegas de Massive en vivo y cálculo propio solo en histórico. | **Opción A.** Massive dio Gamma/Vega negativos en `SPXW` y `VIX` (`probe4`) y devuelve `{}` vacío en ITM. El cálculo propio es consistente en vivo e histórico. |
| **D2** | **Valuación de americanas con dividendos (`SPY`, stocks)** | **A)** Paridad Put-Call para `F(T)` + BSM/Bjerksund-Stensland 2002 analítico rápido (y árbol CRR con dividendos discretos solo para auditoría/ex-date). <br>**B)** Árbol binomial CRR de N pasos en cada contrato de la cadena. | **Opción A.** Es órdenes de magnitud más rápido en TS para cadenas de 2,000+ contratos y evita ruido numérico de malla CRR en Gamma/Vanna. |
| **D3** | **Fuente de tasa `r` y dividendo `q`** | **A)** Automática desde Massive: curva `GET /fed/v1/treasury-yields` + SOFR (`/fed/v1/funding-conditions`) y `q` vía paridad Put-Call / `/stocks/v1/dividends`. <br>**B)** Parámetros fijos ingresados manualmente por configuración. | **Opción A** con override manual opcional: ya está incluida en tu plan (`All Plans`) sin APIs externas. |
| **D4** | **Convención de tiempo `T` hasta expiración** | **A)** Tiempo calendario continuo `ACT/365` exacto en segundos UTC hasta el cierre oficial de liquidación (`16:00 ET` para PM-settled / `09:30 ET` para `SPX` AM-settled). <br>**B)** Días hábiles de bolsa (`252`). | **Opción A** (`ACT/365` hasta timestamp exacto de expiración), pasando la base `secondsPerYear` como parámetro limpio en las funciones puras para comparar si hace falta. |
| **D5** | **Universo inicial y filtro de liquidez en cadenas** | **A)** Empezar por `SPY`, `QQQ` e `I:SPX` (±25 % del spot, `DTE <= 90`, `bid > 0`, `spreadRel <= 0.35`, sin binarias ni ajustadas). <br>**B)** Descargar la cadena completa de cada subyacente sin filtro previo (todos los vencimientos LEAPS incluidos). | **Opción A.** Reduce páginas `/v3/snapshot/options` (`limit=250`), mantiene `Q` WebSocket muy debajo del tope de **1,000 contratos** y limpia la superficie de volatilidad. *(Para `I:VIX` opciones, posponer hasta integrar fuente de futuro VIX si `MASSIVE_KEY_FUTURES` lo incluye).* |
| **D6** | **Resolución de bloqueos operativos externos (`/stocks` WS, S3 y plan Índices)** | Confirmar: **(1)** Qué proceso externo está consumiendo `wss://socket.massive.com/stocks` cada ~9 s (y si se puede apagar o ampliar cupo). **(2)** Si vas a generar las claves S3 Flat Files en el dashboard. **(3)** Confirmar en dashboard si `Indices Advanced` y `Currencies` están activos de forma permanente. | **Detener el consumidor externo de `/stocks`** antes de ejecutar la Pieza 7, y generar claves S3 antes de la Pieza 8. |
| **D7** | **Cómo cerrar las 2 fallas del working tree actual (`retry 429`)** | **A)** Cambiar el valor por defecto de `retry429MaxAttempts` en `src/data/loader.ts` de `2` a `0` (opt-in real), recuperando `337/337` sin tocar los tests existentes (`AGENTS.md`). <br>**B)** Dejar default `2` y modificar las expectativas de `lm47` y `lb19` (requiere tu aprobación explícita por `AGENTS.md`). | **Opción A.** Respeta la especificación original ("retry 429 opt-in") y la regla de `AGENTS.md` de no modificar tests existentes para hacerlos pasar. |

---

## (d) Plan Ejecutable — Prompts listos para "Argon 4 Hydrogen"

Cada pieza corresponde a **1 commit** siguiendo `AGENTS.md` (implementación TS pura + script Python independiente en `tools/` + fixture en `fixtures/` + tests Vitest + salida literal de `npm run verify` + espera de confirmación).

---

### Pieza 0 — Saneamiento del working tree (`retry 429` opt-in + baseline verde)
- **Dependencias:** Decisión `D7` (Opción A recomendada) | **Paralelizable con:** Ninguna (prerequisito limpio) | **Tamaño:** S | **Riesgo:** Bajo | **Tipo:** **Imprescindible**

```text
Actúa como desarrollador senior de TypeScript siguiendo estrictamente AGENTS.md y SPEC.md.

TAREA: Pieza 0 — Sanear el diff pendiente de reintento 429 para recuperar npm run verify en verde sin debilitar ni modificar tests existentes.

CONTEXTO MEDIDO:
Hoy npm run verify falla exactamente en 2 de 337 tests (tests/dataLoader.test.ts: lm47_provider_error_http_429 y lb19_provider_error_http_429_non_json) porque src/data/loader.ts tiene `retry429MaxAttempts = options.retry429MaxAttempts ?? 2` en vez de opt-in (0), mientras tests/dataRetry.test.ts y tests/retry.test.ts sí existen para el modo opt-in.

ARCHIVOS PERMITIDOS:
- src/data/loader.ts (solo valor por defecto y JSDoc de retry429MaxAttempts)
- src/data/types.ts (solo JSDoc de retry429MaxAttempts)
- tests/dataRetry.test.ts (solo si algún test asumía default 2: revisar y reportar antes si requiere ajuste o pasar explícitamente retry429MaxAttempts: 2; NO tocar tests/dataLoader.test.ts)

ARCHIVOS PROHIBIDOS:
- src/core/* (congelado)
- tests/dataLoader.test.ts y fixtures/data_layer_reference.json (no debilitar ni editar tests existentes)
- .env y archivos de datos en fixtures/samples/

REQUISITOS:
1. Inspecta src/data/loader.ts, src/data/types.ts y tests/dataRetry.test.ts antes de editar.
2. Haz que `retry429MaxAttempts` sea opt-in (`0` por defecto), manteniendo exactamente el comportamiento probado por `tests/dataRetry.test.ts` cuando el caller pasa `retry429MaxAttempts > 0`.
3. Comprueba si hay secretos en el diff (`apiKey` o valores de `.env`).

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega la salida literal completa (todos los archivos y los 337+ tests en verde).
- Lista `git status --short` y el hash del commit de esta pieza. No avances a otra pieza sin mi confirmación.
```

---

### Pieza 1 — Adaptador REST y Normalizador de Contratos y Cadena de Opciones (`Massive`)
- **Dependencias:** Pieza 0 | **Paralelizable con:** Piezas 2, 3 y 4 | **Tamaño:** M | **Riesgo:** Medio | **Tipo:** **Imprescindible**

```text
Actúa como desarrollador senior de TypeScript siguiendo estrictamente AGENTS.md, SPEC.md y tsconfig.json (NodeNext con imports .js, exactOptionalPropertyTypes, noUncheckedIndexedAccess, noPropertyAccessFromIndexSignature).

TAREA: Pieza 1 — Adaptador de datos para Contratos de Referencia y Snapshot de Cadena de Opciones de Massive.

REGLAS DEL PROVEEDOR VERIFICADAS (docs/massive_plan_reference.md):
- Endpoints:
  1) GET /v3/reference/options/contracts (limit max 1000, paginado con next_url). TRAMPA: si underlying es índice (ej. SPX), este endpoint requiere `SPX` SIN prefijo `I:`, mientras snapshot EXIGE `I:SPX`.
  2) GET /v3/snapshot/options/{underlyingAsset} (limit max 250, paginado con next_url; acepta I:SPX, SPY, etc.).
- Contratos no estándar a detectar y filtrar (flag o exclusión parametrizable):
  - `type === 'binary'` (ej. O:B1SPY... con additional_underlyings USD 100).
  - Contratos ajustados: tienen `additional_underlyings` no vacío (O:GME1... tiene shares_per_contract=100 igual que estándar!).
- Timestamps de entrada: snapshot usa nanosegundos (`last_updated`, `sip_timestamp`) y `expiration_date` (`YYYY-MM-DD`); el adaptador convierte timestamps numéricos a **segundos UTC enteros** o **ms -> segundos** en la entrada y valida finitud.
- `greeks: {}` vacío o `implied_volatility` ausente o valores no finitos -> DEBEN normalizarse a `Number.NaN` (prohibido `?? 0` o `|| 0`).
- Seguridad `next_url`: reutilizar la misma validación de origen espejo (`api.polygon.io` / `api.massive.com`) y redacción de secretos que `src/data/normalizeShared.ts` (`redact`) y `src/data/loader.ts`.

ARCHIVOS PERMITIDOS:
- src/data/optionsTypes.ts
- src/data/normalizeOptions.ts
- src/data/optionsLoader.ts
- tools/gen_options_data_fixture.py
- fixtures/options_data_reference.json
- tests/optionsData.test.ts

ARCHIVOS PROHIBIDOS:
- src/core/* (congelado)
- src/data/loader.ts, normalizeMassive.ts, normalizeBingx.ts (no alterar el cargador de barras)
- Cualquier llamada de red real en tests unitarios (usar `FetchFn` inyectado de `src/data/types.ts`).

REQUISITOS DE SALIDA:
1. Funciones puras de normalización: `normalizeOptionContracts(raw, options)` y `normalizeOptionChainSnapshot(raw, options)` sin mutar entrada ni filtrar silenciosamente fallos en reporte. Reporte detallado (recibidos, aceptados, descartes binarias/ajustadas/malformadas, griegas vacías).
2. Cargador asíncrono `loadOptionChain(options)` con `FetchFn`, paginación `next_url` segura (redacción de secretos) y filtro opcional (`excludeBinary = true`, `excludeAdjusted = true`, rango DTE/strikes).
3. Script Python independiente `tools/gen_options_data_fixture.py` generando `fixtures/options_data_reference.json` cubriendo: binaria `O:B1SPY...`, ajustada con `additional_underlyings`, `greeks: {}` vacío -> `NaN`, índice `I:SPX` (`underlying_asset.value`) vs equity (`underlying_asset.price`), rechazo de `next_url` a host externo, y paginación multipágina.
4. Tests Vitest en `tests/optionsData.test.ts` verificando todos los casos del fixture, inmutabilidad y ausencia total de `apiKey`/secretos en reportes o errores.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega la salida literal completa.
- Lista `git diff --stat`, máxima diferencia / verificación de fixture y hash del commit. Espera confirmación antes de avanzar.
```

---

### Pieza 2 — Motor Matemático Puro: Black-Scholes-Merton, Black-76, Griegas (1°/2° orden) y Solver IV
- **Dependencias:** Ninguna directa (solo decisiones `D1`, `D4`) | **Paralelizable con:** Piezas 1, 3 y 4 | **Tamaño:** M | **Riesgo:** Medio | **Tipo:** **Imprescindible**

```text
Actúa como ingeniero cuantitativo senior en TypeScript siguiendo estrictamente AGENTS.md y SPEC.md.

TAREA: Pieza 2 — Matemática pura de opciones europeas (BSM), futuros/VIX (Black-76), griegas de 1er y 2do orden e inversión numérica de volatilidad implícita (IV).

REGLAS ESTRICTAS:
- CERO red, CERO E/S, CERO interfaz, CERO mutación de argumentos.
- Todas las entradas temporales `t` / `T` en unidades coherentes en segundos UTC (ej. `timeToExpiryYears(nowUtcSec, expiryUtcSec, secondsPerYear)`), rechazando o devolviendo `NaN` según contrato explícito sin inventar valores por defecto (`?? 0` prohibido si un parámetro es `NaN` o inválido).
- `sigma <= 0`, `S <= 0`, `K <= 0`, `T <= 0`, o entradas no finitas -> devolver `NaN` en griegas/IV (o valor terminal exacto documentado en expiración solo si se define explícitamente `evaluateOptionAtExpiry`, nunca mezclado con griegas continuas).
- Motivo del motor propio (docs/massive_plan_reference.md §3.1): Massive entrega griegas CRR con Gamma negativo en SPXW ITM y Gamma/Vega negativos en VIX por usar spot en lugar del futuro. Nuestro motor debe ser estable y monótono respecto a volatilidad (vega >= 0).

ARCHIVOS PERMITIDOS:
- src/core/options/types.ts
- src/core/options/math.ts (CDF/PDF normal estándar de alta precisión, ej. Hart / Cody erfc sin dependencias npm)
- src/core/options/blackScholes.ts (`priceBsm`, `greeksBsm`, `priceBlack76`, `greeksBlack76`, `timeToExpiryYears`)
- src/core/options/impliedVol.ts (`solveImpliedVolBsm`, `solveImpliedVolBlack76`)
- tools/gen_options_bsm_fixture.py
- fixtures/options_bsm_reference.json
- tests/optionsBsm.test.ts

ARCHIVOS PROHIBIDOS:
- Cualquier archivo existente en `src/core/*.ts` o `src/data/*.ts`
- Dependencias npm nuevas en `package.json` (cero runtime dependencies)

REQUISITOS DE IMPLEMENTACIÓN:
1. Griegas obligatorias (con unidades explícitas documentadas en JSDoc): `delta`, `gamma`, `theta` (anual y diaria `/365`), `vega` (por +1.00 = +100% vol y/o helper explícito por 1%), `rho`, `vanna` ($\partial\Delta/\partial\sigma$), `charm` ($-\partial\Delta/\partial t$).
2. `impliedVol.ts`: verificar estrictamente cotas de no-arbitraje europeo antes de invertir (ej. Call BSM en `[max(0, S*e^{-qT} - K*e^{-rT}), S*e^{-qT}]`, Call Black-76 en `[max(0, e^{-rT}(F - K)), e^{-rT}*F]`). Si el precio cae debajo de la cota o supera el techo o tiene `vega` casi nulo sin convergencia -> devolver `NaN`. Resolver con método híbrido Newton-Raphson + bisección/Brent garantizando convergencia determinista sin bucles infinitos.
3. Referencia Python INDEPENDIENTE en `tools/gen_options_bsm_fixture.py` (sin copiar el código TS): usa `math.erf`/`math.erfc` de Python y diferenciación numérica central de orden 4 o `decimal` de alta precisión + bisección pura en Python para generar `fixtures/options_bsm_reference.json` con:
   - Casos ATM, ITM profundo (`O:SPXW` estilo 0DTE), OTM extremo, `T` muy corto (minutos antes del cierre), `r` y `q` no nulos, calls y puts, BSM y Black-76 (estilo VIX futuro).
   - Casos degenerados / violación de arbitraje / precio bajo intrínseco -> `NaN` esperado.
4. Tolerancia relativa `< 1e-9` contra el fixture (documentar piso absoluto cerca de cero para griegas de cola donde el valor real es ~0).

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega la salida literal completa.
- Reporta máxima diferencia relativa/absoluta observada contra el fixture y el hash del commit. Espera confirmación antes de avanzar.
```

---

### Pieza 3 — Matemática Pura: Forward por Paridad Put-Call y Valuación Americana (`SPY` / Acciones)
- **Dependencias:** Pieza 2 (para tipos compartidos de `src/core/options/types.ts` y `math.ts`, o coordinar interfaz) y decisiones `D1`, `D2`, `D4` | **Paralelizable con:** Piezas 1 y 4 | **Tamaño:** M/L | **Riesgo:** Medio-Alto | **Tipo:** **Imprescindible** (si se operan americanas `SPY`/`QQQ`/stocks; opcional si solo índices europeos)

```text
Actúa como ingeniero cuantitativo senior en TypeScript siguiendo estrictamente AGENTS.md y SPEC.md.

TAREA: Pieza 3 — Paridad Put-Call para inferencia de Forward/Dividendo implícito y modelo americano puro (Bjerksund-Stensland 2002 + verificador CRR con dividendos discretos opcional).

ARCHIVOS PERMITIDOS:
- src/core/options/forward.ts (`inferForwardFromParity`, `impliedDividendYieldFromForward`)
- src/core/options/american.ts (`priceAmericanBjerksund2002`, `greeksAmericanFiniteDiffOrAnalytical`, `priceAmericanCrrDiscrete`, `solveImpliedVolAmerican`)
- tools/gen_options_american_fixture.py
- fixtures/options_american_reference.json
- tests/optionsAmerican.test.ts

ARCHIVOS PROHIBIDOS:
- Todo archivo existente fuera de `src/core/options/` y los 3 archivos propios de esta pieza.
- Dependencias npm nuevas.

REQUISITOS:
1. `inferForwardFromParity(pairs, discountFactor)`: dado un conjunto de pares `(strike, callMid, putMid)` válidos del mismo vencimiento, estima `F(T) = K + (C - P) / exp(-rT)` mediante mediana o promedio ponderado por liquidez de pares cercanos al dinero; devuelve `NaN` si no hay pares válidos o con spread inválido (sin fallbacks a spot!).
2. Bjerksund-Stensland 2002 puro para americanas (Call con `q > 0` y Put mediante simetría `P(S, K, T, r, q) = C(K, S, T, q, r)`), cumpliendo estrictamente `precio_americano >= precio_europeo` y `precio >= valor_intrínseco`.
3. `priceAmericanCrrDiscrete` (árbol Cox-Ross-Rubinstein con dividendos cash discretos en fechas exactas antes de expiración) acotando número máximo de pasos explícito para mantener pureza y determinismo, y devolviendo `NaN` ante parámetros inválidos.
4. Referencia Python INDEPENDIENTE (`tools/gen_options_american_fixture.py`): árbol binomial CRR independiente de alta resolución (ej. `N = 1000`–`2000` pasos o Richardson extrapolation en Python) para verificar Bjerksund-Stensland y CRR contra `fixtures/options_american_reference.json`. Tolerancia: `< 1e-9` para CRR vs CRR (mismos pasos) y tolerancia numérica explícita documentada entre analítico Bjerksund y CRR continuo de alta resolución (típicamente `< 1e-3` o `< 1e-4` en precio; documentar en SPEC/test).
5. Inversión de IV americana (Brent puro) devolviendo `NaN` si `precio < intrínseco americano`.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Reporta desviaciones medidas y hash del commit. Espera confirmación.
```

---

### Pieza 4 — Datos Auxiliares de Contexto: Tasas Fed (`/fed/v1`), Dividendos, OI Histórico y Unified Snapshot
- **Dependencias:** Pieza 0 (y decisión `D3`) | **Paralelizable con:** Piezas 1, 2 y 3 | **Tamaño:** M | **Riesgo:** Bajo | **Tipo:** **Imprescindible** (tasas `r` + Unified Snapshot `I:SPX/I:VIX/I:SKEW`); **Mejora** (OI histórico multi-día si no se usa solo hoy)

```text
Actúa como desarrollador senior de TypeScript siguiendo AGENTS.md y SPEC.md.

TAREA: Pieza 4 — Adaptadores REST puros + loaders paginados para:
1) Curva de tasas US Treasury y SOFR: `GET /fed/v1/treasury-yields` y `GET /fed/v1/funding-conditions` (documentados como incluidos en todos los planes; tolerar 403/401 como `providerError` limpio sin secretos si el plan difiriera).
2) Dividendos corporativos: `GET /stocks/v1/dividends` (para dividendos discretos futuros/pasados y frecuencia).
3) Open Interest histórico diario: `GET /options/v1/open-interest` (limit max 50_000, desde 2022-09-01).
4) Unified Snapshot multi-activo: `GET /v3/snapshot?ticker.any_of=...` (max 250 tickers: stocks + I:SPX, I:VIX, I:SKEW, I:NDX; soportar estado `market_status` incluyendo próximo `overnight_trading` 2026-12-07 y omisión normal de OHLC en `early_trading`).

ARCHIVOS PERMITIDOS:
- src/data/macroTypes.ts
- src/data/normalizeMacro.ts
- src/data/macroLoader.ts
- tools/gen_macro_data_fixture.py
- fixtures/macro_data_reference.json
- tests/macroData.test.ts

ARCHIVOS PROHIBIDOS:
- src/core/* (congelado), src/data/loader.ts, normalizeMassive.ts.
- Red real en `tests/macroData.test.ts` (inyectar `FetchFn`).

REQUISITOS:
1. Interpolación pura lineal/log-lineal de curva Treasury por plazo `T` en años (`yield_1_month`..`yield_30_year`) + respaldo explícito `NaN` si la curva viene vacía o con puntos no finitos (prohibido inventar `r = 0.05`). Convertir porcentajes (`4.31`) a decimales (`0.0431`) de manera explícita y documentada.
2. En `/v3/snapshot`: separar `stocks`, `indices` (`value`, `session`) y `options`; manejar errores parciales por ticker (`error: "NOT_ENTITLED" | "NOT_FOUND"`) sin abortar el lote válido y sin perder seguridad con `apiKey`.
3. Fixture Python independiente y suite Vitest completa.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Lista `git diff --stat` y hash del commit. Espera confirmación.
```

---

### Pieza 5 — Superficie de Volatilidad, Estructura Temporal y Skew (`src/core/options/`)
- **Dependencias:** Pieza 2 y Pieza 3 | **Paralelizable con:** Piezas 4 y 6 (si 6 usa IVs directas de contratos; 5 alimenta interpolados) | **Tamaño:** L | **Riesgo:** Alto | **Tipo:** **Mejora prioritaria** (necesaria para `IV_ATM` limpio, `25d Skew`, `Term Structure` y limpieza de superficies)

```text
Actúa como ingeniero cuantitativo senior en TypeScript siguiendo estrictamente AGENTS.md y SPEC.md.

TAREA: Pieza 5 — Construcción pura de Superficie de Volatilidad por vencimiento (`slice`), validación de arbitraje estático, `IV_ATM(T)`, `25-delta Risk Reversal`, `25-delta Butterfly` y Estructura Temporal.

ARCHIVOS PERMITIDOS:
- src/core/options/volSurface.ts
- src/core/options/volMetrics.ts
- tools/gen_vol_surface_fixture.py
- fixtures/vol_surface_reference.json
- tests/volSurface.test.ts

ARCHIVOS PROHIBIDOS:
- Módulos existentes fuera de `src/core/options/` y esta pieza.

REQUISITOS:
1. Filtro de calidad de cotizaciones en puro TS (parametrizable: `minBid`, `maxSpreadRatio`, `minOpenInterest`, exclusión automática si IV es `NaN`).
2. Para cada expiración `T`: construir `k = ln(K / F)` y varianza total `w(k) = sigma^2 * T`. Implementar interpolador cúbico/PCHIP monótono (o SVI calibrado determinista con verificación de condición libre de arbitraje de mariposa y calendario `w(k, T2) >= w(k, T1)` en nodos). Si hay < N puntos válidos (configurable), devolver `NaN` y reportar razón sin inventar curva plana.
3. Métricas puras derivadas:
   - `ivAtm` (en `k = 0`, es decir `K = F`)
   - `delta25PutIv`, `delta25CallIv` (encontrados resolviendo el strike correspondiente al delta BS $\pm 0.25$ sobre la propia sonrisa)
   - `riskReversal25 = iv25Put - iv25Call` y `butterfly25 = 0.5 * (iv25Put + iv25Call) - ivAtm`
   - `termStructure`: arreglo ordenado de `(T, expirySec, ivAtm, expectedMovePct)` + pendiente `termSlope(T1, T2)`.
4. Script Python independiente usando cálculo puro en `tools/gen_vol_surface_fixture.py` (con PCHIP / ecuaciones explícitas sin copiar TS), tolerancia `1e-9` contra el interpolador exacto y tests de monotonía / no-mutación / `NaN` en ausencia de liquidez.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Reporta máxima diferencia contra fixture y hash del commit. Espera confirmación.
```

---

### Pieza 6 — Motor de Exposición de Dealers (GEX, DEX, Vanna, Charm, Call/Put Walls, Gamma Flip y Expected Move)
- **Dependencias:** Pieza 2 (y opcionalmente Pieza 3 para americanas, Pieza 5 para `IV_ATM`) | **Paralelizable con:** Piezas 4 y 5 (si recibe cadena con IVs ya resueltas o resueltas con Pieza 2) | **Tamaño:** M | **Riesgo:** Medio | **Tipo:** **Imprescindible** (corazón del terminal de opciones)

```text
Actúa como ingeniero cuantitativo senior en TypeScript siguiendo estrictamente AGENTS.md y SPEC.md.

TAREA: Pieza 6 — Motor puro de Exposición de Dealers por strike y agregado (GEX, DEX, Vanna Exposure, Charm Exposure), Call/Put Walls, Zero Gamma (Gamma Flip) y Expected Move.

ARCHIVOS PERMITIDOS:
- src/core/options/exposure.ts
- tools/gen_options_exposure_fixture.py
- fixtures/options_exposure_reference.json
- tests/optionsExposure.test.ts

ARCHIVOS PROHIBIDOS:
- Todo código existente fuera de `src/core/options/` y esta pieza; cero red o E/S.

REQUISITOS MATEMÁTICOS Y DE DISEÑO:
1. Cada contrato en la entrada trae: `contractType`, `strike`, `expiryUtcSec`, `openInterest`, `volume`, `sharesPerContract`, e insumos para griegas propias (`S` o `F`, `r`, `q`, `iv` o `midPrice`). Contratos con `openInterest` no finito / `<= 0` no aportan exposición; si un contrato activo tiene `iv` `NaN`, reportarlo explícitamente en métricas de calidad (`skippedContracts`, `skippedOiShare`) sin rellenar con `0` ni IV vecina oculta.
2. Convenciones explícitas y documentadas en JSDoc (parametrizables via `dealerPositionSign` si hace falta, con signo estándar `+1` call / `-1` put para dealers largo call / corto put):
   - **Dollar GEX ($ por movimiento de 1 % del spot):** `sign * OI * sharesPerContract * gamma * S^2 * 0.01`
   - **Spot-share Gamma (por $1):** `sign * OI * sharesPerContract * gamma * S`
   - **DEX ($):** `sign * OI * sharesPerContract * delta * S`
   - **Vanna Exposure y Charm Exposure:** calculados usando `vanna` y `charm` de Pieza 2 con unidades claras.
3. Agrupación por strike (`byStrike`) y totales netos/absolutos:
   - `callWallStrike` (mayor Call GEX / Call OI — soportar criterio configurable `'oi' | 'gex'`), `putWallStrike` (mayor Put OI o |Put GEX|).
   - `gammaFlipSpot`: evaluación pura de `netGex(S_grid)` sobre rejilla centrada en `S` y refinamiento por bisección donde `netGex` cruza `0`; si no hay cruce único o es indefinible en rango, devolver `NaN`.
   - `expectedMove`: por fórmula `S * ivAtm * sqrt(T)` y por straddle ATM `C + P` cuando exista en la cadena.
4. Script Python independiente `tools/gen_options_exposure_fixture.py` generando `fixtures/options_exposure_reference.json` con cadena sintética realista y casos degenerados (OI=0, IV=NaN, ausencia de cruce Zero Gamma -> `NaN`). Tolerancia `1e-9`.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Reporta máxima diferencia contra fixture y hash del commit. Espera confirmación.
```

---

### Pieza 7 — Cliente WebSocket (`/options` y `/stocks`) + Consolidación de Barra en Formación
- **Dependencias:** Piezas 0, 1 y decisión `D6` (indispensable resolver consumidor externo en `/stocks` antes de prueba en vivo) | **Paralelizable con:** Piezas 5 y 6 | **Tamaño:** L | **Riesgo:** Alto (estado en vivo, rebroadcasts 15 min, *slow consumer*, reset medianoche ET) | **Tipo:** **Imprescindible** (live terminal) / **Mejora** sobre REST

```text
Actúa como desarrollador senior de TypeScript siguiendo AGENTS.md y SPEC.md.

TAREA: Pieza 7 — Máquina de estados pura de barras en formación / rebroadcasts + adaptador WebSocket desacoplado para `wss://socket.massive.com/options` y `/stocks`.

HALLAZGOS VERIFICADOS QUE DEBES RESPETAR (docs/massive_plan_reference.md):
- Protocolo: `connected` -> enviar `{"action":"auth","params":key}` -> esperar `auth_success` -> enviar `subscribe`. NUNCA loggear `apiKey`.
- Límite duro en `/options` `Q`: **máximo 1,000 contratos** por conexión (lanzar error explícito si la suscripción supera 1000 en `Q.*` o `Q` en opciones; prohibido `Q.*` en options).
- En `stocks`, `A` llega ~2.1 s tras el cierre del segundo y tanto `A` como `AM` tienen ventana de **rebroadcast de 15 minutos** por trades tardíos FINRA TRF: una barra WS con `s` (timestamp ms -> segundos UTC) ya visto DEBE **sobrescribir** la barra previa de ese mismo timestamp; **PROHIBIDO sumar volúmenes o duplicar barras**.
- Reset diario poco después de medianoche ET + liberación del servidor de 10–30 s: implementar reconexión con backoff mínimo >= 15 s ante cierre nocturno o `max_connections` (nunca martillar en loop de < 1 s).
- Separar la **máquina de estados pura de consolidación de barras y proyección en vivo** (testeable 100 % sin socket real ni timers reales) del **transporte WebSocket inyectable**.

ARCHIVOS PERMITIDOS:
- src/data/wsTypes.ts
- src/data/liveBarConsolidator.ts (puro: ingiere eventos `AM`, `A`, `T` normalizados; mantiene serie cerrada + barra viva actual sin mutar el array pasado; invocable junto a `projectLiveEma`, `projectLiveSessionVwap`, `projectLiveAvwap` sin modificar `src/core/*`)
- src/data/wsClient.ts (cliente inyectable con cola y reconexión segura, redacción de secretos)
- tools/gen_live_bar_fixture.py
- fixtures/live_bar_reference.json
- tests/liveWs.test.ts

ARCHIVOS PROHIBIDOS:
- src/core/* (congelado)
- Tests automáticos que abran WebSockets reales a Massive en `npm run verify` (todo mockeado/inyectado determinísticamente; las pruebas reales viven solo en scripts manuales tipo `.smoke.ts`).

REQUISITOS:
1. `liveBarConsolidator.ts` puro: convierte `s` (ms) a apertura en segundos UTC enteros; distingue `A`/`T` dentro del minuto en curso como proyección de barra en formación; al llegar `AM` del minuto, sella/actualiza la barra cerrada por timestamp `time` (upsert idempotente ante rebroadcast tardío dentro de 15 min!).
2. Validación de entrada igual de estricta que `normalizeMassive.ts` (precios `<= 0` o no finitos o `high < low` se descartan y contabilizan; sin `||` ni `??` ocultando NaN).
3. En `wsClient.ts`: validación del tope de 1,000 contratos en `Q` de opciones, manejo de mensajes `status` (`max_connections`, `auth_failed`, etc.) redactando credenciales, y sin bloquear la recepción.
4. Referencia Python independiente en `tools/gen_live_bar_fixture.py` verificando consolidación de ticks `T` -> barra viva -> cierre `AM` -> rebroadcast `AM` tardío.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Reporta máxima diferencia contra fixture y hash del commit. Espera confirmación.
```

---

### Pieza 8 — Flujo Inusual (`/options/v1/unusual-trades`) y Backfill Offline vía S3 Flat Files
- **Dependencias:** Piezas 1 y 4 (y generación previa de S3 keys por el dueño para el uso real de S3 en `D6`) | **Paralelizable con:** Piezas 5, 6 y 7 | **Tamaño:** M/L | **Riesgo:** Medio | **Tipo:** **Mejora** (escala histórica & flujo institucional)

```text
Actúa como desarrollador senior de TypeScript / Python siguiendo AGENTS.md y SPEC.md.

TAREA: Pieza 8 — (A) Normalizador y loader paginado para `/options/v1/unusual-trades` en TypeScript; y (B) Script offline en `tools/` para ingesta/ajuste por splits de Flat Files CSV.gz de Massive (`us_stocks_sip/*` y `/options/*`).

ADVERTENCIAS DE DATOS PROVEEDOR VERIFICADAS:
- `GET /options/v1/unusual-trades`: limit max 50_000, `sip_timestamp` en **nanosegundos** (convertir a segundos/sub-estructura en entrada), `flags` (`block_premium`, `block_size`, `iso`). Usar `root` para distinguir semanales/ajustados (`SPXW` vs `SPX`, `GME1` vs `GME`).
- Flat Files Stocks (`S3 us_stocks_sip/minute_aggs_v1` y `day_aggs_v1`): vienen **SIN ajustar por splits** (`historical_adjustment_factor` en `GET /stocks/v1/splits`) y **NO traen columna `vw`** (`window_start` en nanosegundos!). No mezclar barras de Flat Files sin ajustar con barras REST ajustadas de `loader.ts`.

ARCHIVOS PERMITIDOS:
- src/data/unusualTradesLoader.ts y src/data/normalizeUnusualTrades.ts
- tools/ingest_flat_files.py (CLI offline para leer CSV.gz locales/S3 con `ETag`/`LastModified` cache + aplicación opcional explícita de `/stocks/v1/splits` con bandera `--adjusted`)
- tools/gen_unusual_trades_fixture.py
- fixtures/unusual_trades_reference.json
- tests/unusualTrades.test.ts

ARCHIVOS PROHIBIDOS:
- src/core/* (congelado), `.env` (solo lectura en runtime del script Python, nunca imprimir claves S3 ni API key).

REQUISITOS:
1. Normalizador puro TS + paginador `next_url` seguro para `unusual-trades`, filtrando por flags (`block_premium`, `block_size`, `iso`), notacional real (`price * size * sharesPerContract`), orden temporal estricto y cero secretos en logs/reportes.
2. En `tools/ingest_flat_files.py`: validación estricta de ausencia de `vw` (marcar `None`/ausente, nunca rellenar con HLC3 silenciosamente en el ingestor sin declararlo), conversión explícita de `window_start` ns -> segundos UTC enteros, verificación de no filtrar credenciales S3 en stdout/archivos.
3. Fixture Python independiente + tests Vitest para el módulo TS.

ENTREGABLE Y CIERRE:
- Ejecuta `npm run verify` y pega salida literal.
- Lista `git diff --stat` y hash del commit. Espera confirmación.
```

---

## (e) Ruta crítica y orden recomendado de ejecución

### Ruta crítica de 1 línea (camino más rápido al motor de Opciones/GEX funcionando)
```text
Pieza 0 (Sanear retry -> 337/337 verdes) -> Pieza 1 (Datos Opciones) || Pieza 2 (BSM/Black-76/IV) || Pieza 4 (Tasas/Unified Snapshot) -> Pieza 3 (Americanas/Paridad F) -> Pieza 6 (GEX/DEX/Walls/Zero-Gamma) -> Pieza 7 (WS Live Barra en Formación, tras resolver conflicto /stocks)
```

### Clasificación por oleadas: Imprescindible vs Mejora

| Oleada | Piezas en paralelo | Clasificación | Qué desbloquea al terminar |
| --- | --- | --- | --- |
| **Oleada 0 (Bloqueante)** | **Pieza 0** | **Imprescindible** | `npm run verify` limpio en `337/337` antes de escribir código nuevo. |
| **Oleada 1 (Base paralela)** | **Pieza 1** + **Pieza 2** + **Pieza 4** | **Imprescindible** | Datos de cadenas limpias (sin binarias ni ajustadas ocultas) + curvas `r` (`treasury-yields`/SOFR) + motor BSM/Black-76/IV independiente de Massive + Unified Snapshot (`SPY`, `I:SPX`, `I:VIX`, `I:SKEW`). |
| **Oleada 2 (Exactitud americana)** | **Pieza 3** | **Imprescindible** (si operas `SPY`/`QQQ`/acciones); **Opcional** si arrancas solo con `I:SPX` | Forward implícito `F(T)` por paridad Put-Call (elimina incertidumbre de `q`) + valuación e IV americana exacta. |
| **Oleada 3 (Terminal Opciones + Live)** | **Pieza 6** + **Pieza 7** *(tras D6)* | **Imprescindible** (Pieza 6 GEX/Walls); **Mejora/Live** (Pieza 7 WS) | Motor GEX/DEX/Vanna/Charm/Gamma Flip/Expected Move + streaming real sub-segundo sin el retraso de `1–11 s` de REST. |
| **Oleada 4 (Profundidad cuantitativa)** | **Pieza 5** + **Pieza 8** | **Mejora** | Superficie de volatilidad completa sin arbitraje (`IV_ATM`, `Skew 25d`, `Term Structure`), alertas de bloques `unusual-trades` y backfill histórico masivo vía Flat Files S3. |
