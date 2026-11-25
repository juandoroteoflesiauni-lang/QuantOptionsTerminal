# Backlog

## Pieza futura — Cinta real para Lee-Ready (Opción 1)

Estado: **NO implementada**. Prioridad menor que el enrutador de órdenes de Alpaca y los ajustes de gráficos/AVWAP.

Contexto (auditoría 2026-11-24): hoy ningún CVD/Lee-Ready de la UI usa cinta tick a tick.

| Ruta | Fuente real actual | Etiqueta/badge en UI |
|---|---|---|
| Stock Detail (`computeLeeReadyBarFlow`) | Barras OHLCV (volumen × CLV) | `CVD aprox. (CLV)` · `CLV · Barras` |
| GGAL sub-panel (`buildSubPaneSeries`) | Barras OHLCV (volumen × CLV) | `CVD aprox. (CLV)` · `CLV · Barras` |
| Opciones US (`computeUsOptionsTickAggression` / order flow) | Print sintético del snapshot (último trade + BBO) | `Flujo aprox. (Snapshot)` · `SNAPSHOT` |

Alcance de la pieza:
1. Alimentar `adrTrades` / `adrQuotes` de `classifyTradesLeeReady` (`src/core/ggal/structurePinning.ts`) con Tradier WS `trade`/`timesale` + quote NBBO. Hoy ningún llamador los pasa, por lo que `leeReadyConfidence = 'TICK_TAPE'` es inalcanzable.
2. Conectar `handleOptionWsEvents` (Massive OPRA T/Q) al order flow de opciones (`computeSignedOptionsOrderFlow`) en vez del print sintético del snapshot.
3. Al existir cinta real, mostrar el badge `TICK_TAPE` y retirar la etiqueta "aprox." solo en las rutas realmente alimentadas por cinta.
4. Fixture de referencia independiente en Python (`tools/`) → `fixtures/`, tolerancia 1e-9 (regla AGENTS.md).
