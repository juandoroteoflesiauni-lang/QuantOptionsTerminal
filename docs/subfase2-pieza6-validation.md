# S2-3 — Validación de Pieza 6 / Cierre de Sub-fase 2

Fecha de trabajo: 2026-11-25. Entorno aislado: `C:\dev\QuantOptionsTerminal-subfase1`, rama `subfase1/pieza2-s1-4`, base `b524d8ce007e6cdb18c50a7ec26b5eec1684df0d`.

## Implementación y contratos cerrados (`S2-3`)

- **`src/core/microstructure/intradayTriggers.ts`:**
  - Motor 100 % puro sin red, sin UI y sin mutación de argumentos; preserva intactos `src/core/microstructure/fvgFobEngine.ts` (`amtFvgLeeReady.test.ts`), `src/core/microstructure/volumeProfileAmt.ts`, `GgalDualChartView.tsx` y `SyncedLowerPaneChart.tsx`.
  - Alcance estricto: exclusivamente temporalidades intradiarias **`1m` y `5m`** sobre barras cerradas (`bar.time + barSeconds <= asOfUtcSec`); en `15m`/`1h`/`4h`/`1D`/`1W` devuelve `status: 'UNSUPPORTED_TIMEFRAME'` sin cómputo.
  - Exclusión cerrada explícita: **sin Order Blocks (`OB`) ni Optimal Trade Entry (`OTE`)**.
  - Máquina de estados finitos **FVG / IFVG (6 estados exactos):**
    1. `ACTIVE_UNMITIGATED`
    2. `ACTIVE_PARTIALLY_MITIGATED`
    3. `MITIGATED_FILLED`
    4. `INVERTED_IFVG_ACTIVE`
    5. `IFVG_MITIGATED`
    6. `EXPIRED`
    con filtro determinista de tamaño/cuerpo de desplazamiento, contigüidad intradiaria y **tope máximo de 3 zonas activas visibles** ordenadas por distancia al precio de referencia, remanente no mitigado y recencia.
  - Detector causal de **Liquidity Sweeps** (`methodology: 'OHLCV'`, `provenanceLabel: 'OHLCV_WICK_CLOSE_RECOVERY'`) contra niveles existentes definitivos `PDH/PDL`, `PMH/PML`, `ORH/ORL` (`bar.time >= level.endExclusive`) y `CALL_WALL / PUT_WALL`, con cooldown por nivel y degradación honesta ante `NaN`/`null`/`UNAVAILABLE`/`PROVISIONAL` sin fabricar niveles.
  - Avance incremental `advanceIntradayTriggersLiveOnClosed1m` únicamente al cierre de barra `1m` o bucket `5m`.
- **Frontend (`PanoramicBandsPrimitive.ts`, `StockDetailView.tsx`, `liveTypes.ts`):**
  - Estado en memoria de sesión **apagado por defecto (`OFF`)** sin `localStorage`.
  - Chip `Sweeps/FVG` visible solo cuando `effectiveChartTimeframe === '1m' || effectiveChartTimeframe === '5m'`.
  - Renderizado dentro de `PanoramicBandsPrimitive` (`ISeriesPrimitive<Time>`) con **`autoscaleInfo(): null`** obligatorio, diferenciando `FVG ↑ · OHLCV`, `FVG ↓ · OHLCV`, `IFVG ↑/↓ · OHLCV` y marcadores discretos `SWP <NIVEL>`.
  - Cero impacto en `flushLiveTick` / `rAF` y preservación integral de las guardias `Perf-1/2/3`, `setOverlays` (=1), `15` series, `16` `IPriceLine` slots y `tests/yAxisAutoscaleProtection.test.ts` (`9/9` sobre `SeriesPrimitiveWrapper` + `Series` de LWC 5.3.0).

## Oráculo independiente y reproducibilidad

- Generador: `tools/generate_intraday_triggers_fixture.py` (`Decimal(prec=50)`).
- Fixture: `fixtures/intraday_triggers_sweeps_fvg_ifvg.json`.
- SHA-256 corrida 1: `2937BF8104294987FA39A0BB1E60AD84C0F986EA3F738E96FF8F8094D9417588`
- SHA-256 corrida 2: `2937BF8104294987FA39A0BB1E60AD84C0F986EA3F738E96FF8F8094D9417588`

## Evidencia previa al gate final (`npm run verify`)

- `python tools/generate_intraday_triggers_fixture.py` (2 corridas): exit `0`, SHA-256 idéntico, `6/6` estados FSM presentes.
- `npm run typecheck`: exit `0` (PASS).
- `npm --prefix web run typecheck`: exit `0` (PASS).
- `npm --prefix web run build`: exit `0` (`2620` módulos en `1.57s`, PASS).
- `node node_modules/vitest/vitest.mjs run --config tools/vitest.options-audit.mts`: exit `0` (`6/6` tests PASS).

## Checklist visual pendiente (usuario)

- [ ] Chip `Sweeps/FVG` apagado por defecto (`OFF`) y visible únicamente en `1m` / `5m` (oculto en `15m`, `1H`, `4H`, `1D`, `1W`).
- [ ] Al activarlo, máximo 3 zonas `FVG`/`IFVG` etiquetadas explícitamente con `OHLCV` y marcadores `SWP` discretos.
- [ ] Cero distorsión del eje Y derecho (`autoscaleInfo(): null`) y cero aparición de Order Blocks (`OB`) u `OTE`.
- [ ] Símbolos AR/BYMA sin `PMH/PML` ni walls degradan limpio sin falsos sweeps.
