# Phase 2 Integration Specification — Institutional AVWAP Context & Confluence Engine

**Status:** Phase 1 Empirical Research Closed (`Prompt #1–#7`) · Ready for Phase 2 TypeScript Implementation (post Sub-fase 1 stabilization)
**Policy File:** [`avwap_context_policy.json`](./avwap_context_policy.json)
**TS Contracts Draft:** [`avwapInstitutionalTypes.draft.ts`](./avwapInstitutionalTypes.draft.ts)
**Golden Fixtures:** [`golden_fixtures/avwap_phase2_golden_fixtures.json`](./golden_fixtures/avwap_phase2_golden_fixtures.json)

---

## 1. Empirical Mandate from 56-Symbol Falsification (`B = 2000`)

The 56-symbol Monte Carlo + Romano-Wolf + Deflated Sharpe falsification study (`Prompt #6`, `oracle_axis5_v2_sealed_2026_11_25`) produced an unambiguous scientific conclusion:

- **0 / 14 families pass `PROMOTE_TIER_1`** after volatility/year/gap matching, BH FDR (`q <= 0.05`), 20 bps round-trip costs, and `DSR >= 0.95`.
- **All 3 negative controls (`EARNINGS_INLINE`, `SWING_NO_RVOL`, `EX_DIVIDEND_REGULAR`) passed falsification cleanly** (`NEGATIVE_CONTROL_PASS`, `p_raw >= 0.65`, `q_BH = 0.9995`).
- **`CALENDAR_YTD`** was the strongest macro structure (`8/8` positive Walk-Forward OOS folds, `H=3 z_lift = +2.518, p_raw = 0.0085`, `H=5 p_raw = 0.0380`) -> classified `TIER_2_CONTEXT_ONLY`.
- **`EARNINGS_BLOWOUT`** (`|r_ern| / impliedEarningsMove >= 1.25` via isolated 1-day `orats_summaries.impliedEarningsMove`) outperformed `EARNINGS_INLINE` by `+0.255 ATR` / `+39 bps` -> retained as `CORE_CONTEXT` for institutional cost-basis anchoring, NOT as a blind directional signal.
- **`POST_OPEX`** was **statistically refuted** as a standalone support/resistance level (`z_lift = -3.271`, `p_raw = 0.9995`, `n = 3,485`) -> disabled by default as an S/R level (`showOpexResetMarker: false`).
- **Gamma & Vol regimes carry structural signal for confluence:**
  - `NEGATIVE_GAMMA` drops `2:1 Win Rate` from `35.1%` (`POSITIVE_GAMMA`) to `26.7%` (`-65.4 bps`) -> must emit `SHORT_GAMMA_BOUNCE_HAZARD`, attenuate `BounceConfluence`, and boost `BreakoutConfluence`.
  - `SPY iv30d > 0.25` (`HIGH_VOL_TREND`) raised touch mean AER to `+0.7922` (`+59.5 bps` net).

Therefore, Phase 2 operates strictly under **`mode = "INSTITUTIONAL_CONTEXT_AND_CONFLUENCE_ONLY"`**: AVWAPs provide objective institutional cost-basis anchors, dispersion bands, `PINCH_PAIR` corridors, and spatial confluence scores anchored against Option Walls, Zero Gamma, Volume Profile (`POC/VAH/VAL/HVN/LVN`), and `CVD` absorption — never autonomous Tier-1 entry signals on `1D`.

---

## 2. Read-Only Repository Coupling Map (Audited on `HEAD b4ce753` + `f7aa019`)

### 2.1 Existing Modules Reused Directly (Zero Duplication)

| Existing Module | Audited Exports / Types Reused | Phase 2 Responsibility |
| --- | --- | --- |
| `src/core/types.ts` | `Bar` (`time` UTC s, `open`, `high`, `low`, `close`, `volume`, `vw?`) | Canonical OHLCV+vw bar contract (strictly UTC seconds, never ms) |
| `src/core/welford.ts` | `WelfordState`, `WelfordOutput`, `createInitialWelfordState`, `getWelfordOutput`, `updateWelford`, `combineWelfordStates`, `welfordFromSeed` | Immutable shifted-origin Welford updates + 7-FLOP parallel Chan/Pebay live merge |
| `src/core/avwapCanonicalMonth.ts` | `AvwapSeedContract`, `CanonicalMonthDto`, `CanonicalMonthLiveState`, `canonicalBarPrice`, `buildCanonicalMonthAccumulator`, `createCanonicalMonthLiveState`, `updateCanonicalMonthLive`, `projectCanonicalMonthLive`, `quoteCanonicalMonthLive` | Reference pattern & `MONTHLY` canonical 1m seed/live reducer already wired into `/api/bars` |
| `src/core/usHistorical.ts` | `UsSession`, `usHistoricalSession`, `HistoricalObservation`, `historicalObservation`, `mergeHistoricalSegments`, `historicalMomentsSince`, `rollupUsHistorical`, `planUsHistorical` | Exact NYSE 2020–2028 RTH/Early-close bounds, session-aligned rollups, and historical cache planning |
| `src/server/usHistoricalService.ts` | `UsHistoricalService.load`, `invalidate`, `adjustmentRevision(symbol)` | Cached 1m/multi-TF history & split-revision cache invalidation (`adjSig`) |
| `src/server/massiveKeyPool.ts` | `MassiveRestDomain` (`STOCKS_REST`, `OPTIONS_REST`), `MassiveKeyRouter`, `SharedOptionsQuotaGuard` | Enforces domain pool segregation; keeps Massive WS disabled (`STANDBY_TRADIER_FMP_PRIMARY`) |
| `src/server/tradierAdapter.ts` & `src/server/tradierStream.ts` | `TradierStocksStream`, `TradierStreamTick`, `TradierHistoricalClient`, `TRADIER_CORE_US_SYMBOLS` | Exclusive real-time equities tick/quote feed driving the live O(1) accumulator |
| `src/core/options/blackScholes.ts` | Analytical BSM `vanna`, `charm` (`-dDelta/dT`) | Second-order dealer sensitivity alongside OPRA/Tradier/ORATS inputs |
| `src/core/microstructure/multiHorizonVolumeProfile.ts` | `HorizonVolumeProfile`, `VolumeProfileNodeZone`, `MultiHorizonVpLiveState` | Supplies `poc`, `vah`, `val`, `hvn`, `lvn` zones for `BounceConfluence` / `BreakoutConfluence` |
| `src/core/microstructure/cvdAbsorption.ts` | `CvdBarEvaluation`, `PassiveAbsorptionEvent`, `AbsorbingSide` | Supplies `cvd_absorption_score` and directional CVD slope alignment |
| `src/core/sessionKeyLevels.ts` | `SessionLevelsDto` (`PDH/PDL/PMH/PML/ORH/ORL`) | Context co-projection alongside AVWAP anchors |
| `web/src/data/liveTypes.ts` | `UsTerminalBarsResponseDto`, `UsSnapshotResponseDto` (`exposureSummary.callWallStrike`, `putWallStrike`, `gammaFlipSpot`, `netGex`) | HTTP/WS transport DTOs extended cleanly without breaking existing charts |
| `src/core/options/usOptionsIntelligenceExportTypes.ts` (`f7aa019`) | `UsOptionsIntelligenceSnapshotV1`, `ExportAvwapReference`, `ExportFlowSummaryBlock` | Receives compact `UsOptionsAvwapContextExportPayload` inside options markdown/PDF intelligence snapshots |

### 2.2 New Modules Planned for Phase 2 (`src/` & `tests/`)

1. `src/core/avwap/corpActionsO1.ts` — Pure O(1) split (`W/k, k*mu, k*M2`) & special-dividend (`>= 1.5%`, `(W, d*mu, d^2*M2)`) transforms with conflict quarantine.
2. `src/core/avwap/causalDetectors.ts` — Causal `EARNINGS_BLOWOUT`, `CALENDAR_YTD/QTD`, `VOLUME_CLIMAX`, `BREAKAWAY_GAP`, `SWING_CAUSAL`, `MACRO_SHOCK` (using `orats_summaries.impliedEarningsMove`, never `impErnMv`).
3. `src/core/avwap/iassEngine.ts` — Sealed IASS v2 (`M/D/F/S = 0.30/0.30/0.20/0.20`, `d_subweights = 0.45/0.25/0.20/0.10`, Bayesian `dataCoverage` shrinkage toward prior, excluding non-PIT floats via `FLOAT_NON_PIT_SNAPSHOT`).
4. `src/core/avwap/lifecycleFsm.ts` — Eje 4.2 FSM (`72/68 dwell=2`, `PINCH_PAIR` + `PINCH_BREAKOUT > 0.35 ATR`, resurrection `>= 1.0 ATR`, `chop < 2`, `|s_norm| >= 0.08`, archival `5` sessions `1D` / `2` intraday or `dist > 6.0 ATR & S_cohort < 0.30`, O(1) spatial dedup, strict visual budget).
5. `src/core/avwap/confluenceEngine.ts` — Eje 4.4 spatial Gaussian kernel `K(delta)` (`sigma=0.35 ATR`), Net GEX normalization `tanh(NetGEX / (0.01 * DollarVol_20d))`, `BounceConfluence`, `BreakoutConfluence`, and hazard/degradation flags.
6. `src/core/avwap/liveAccumulator.ts` — Pure O(1) dual state engine (`committedState` + single `liveBarState` + 7-FLOP parallel Pébay merge via `combineWelfordStates`).
7. `src/server/avwapContextService.ts` — Server coordinator wiring ORATS `/live/summaries` + `/live/strikes` + Massive/FMP history + Tradier WS + 50ms UI broadcast throttle.

---

## 3. Dual O(1) Live Engine Architecture over `Tradier WS`

Massive WS (`MASSIVE_KEY_*` WebSockets) remains **explicitly disabled** (`wsStocks.policyState = 'STANDBY_TRADIER_FMP_PRIMARY'`). All live updates run over `TradierStocksStream` (`TradierStreamTick` with `event in {'trade', 'quote', 'timesale', 'summary'}`):

1. **Immutable `committedState` per active anchor:**
   - Hydrated from `UsHistoricalService` 1m canonical history up to `confirmedThrough` (using `adjSig = UsHistoricalService.adjustmentRevision(symbol)`).
   - Never mutated mid-minute. Advances strictly when an authoritative 1m RTH bar closes (never inferred from stale quote timestamps).
2. **Single `liveBarAccumulator` per symbol:**
   - Keyed by current ET minute boundary `floor(asOfUtcSec / 60) * 60` within valid `usHistoricalSession(t)` RTH bounds.
   - On `TradierStreamTick` (`event === 'trade' | 'timesale'` with valid `price > 0` and delta volume computed from non-decreasing `cumulativeVolume` or positive `size`):
     - Updates `provisionalPv += price * dV`, centered running `provisionalM2` via `updateWelford`, `provisionalMinuteVolume += dV`, OHLC bounds, and `lastTickUtcSec`.
   - On `event === 'quote'` (`quoteCanonicalMonthLive` contract): updates live mark-to-market price for distance/band alerts **without** synthesizing trade volume.
   - Absence of Level-2 / NOI imbalance feed explicitly attaches `NO_NOI_IMBALANCE_FEED` and `NO_NBBO_AGGRESSOR_SIDE` (`OPTIONS_FLOW_SHOCK`) rather than fabricating order-flow aggression.
3. **7-FLOP Parallel Chan/Pébay Merge across Active Anchors (50ms throttle):**
   - On throttled projection tick (every `50 ms` or bar close), combine each anchor's `committedState` with the symbol's single `liveBarAccumulator` `WeightedMomentState` using `combineWelfordStates(committed, liveBar)` — 7 floating-point ops per anchor regardless of anchor history length (`O(N_anchors)` per 50ms frame, `N_anchors <= 4` visible + bounded hidden set).
4. **Minute-Close Reconciliation & Corporate-Action Revision:**
   - When the next canonical 1m bar confirms via REST/stream rollover, replace the provisional state cleanly (`committedState <- updateWelford(committedState, canonicalBarPrice(bar1m), bar1m.volume)`), avoiding double-counting.
   - If `UsHistoricalService.adjustmentRevision(symbol)` advances (split/dividend backfill), discard stale `committedState` and `liveBarAccumulator` immediately (`needsRefresh`) and re-hydrate causally.

---

## 4. Definitive Production Endpoint & Data Hygiene Matrix

Verified empirically across Prompts #1–#6 (strictly enforced in Phase 2):

| Provider / Endpoint | Pool / Secret Rule | Verified Live Behaviour & Scale | Mandatory Production Guardrail |
| --- | --- | --- | --- |
| **ORATS Live Summaries** (`/datav2/live/summaries` or `/live/summaries`) | ORATS Claves `#1/#2` (**NEVER Clave `#3`**) | HTTP `200`; provides isolated 1d `impliedEarningsMove`, `iv30d`, `exErnIv30d`, `contango`, `riskFree30` as decimals | Primary source for 1d `impliedEarningsMove`; NEVER fuse multi-day `impErnMv`. Use as live fallback since `/live/cores` returns `403`. |
| **ORATS Live Cores** (`/datav2/live/cores`) | Excluded | HTTP **`403`** on active subscription | **Banned in live path**; read historical `/datav2/cores` EOD (follow `302` CDN redirect via `Authorization`/sanitized client) + `/live/summaries` intraday. |
| **ORATS Hist Cores & Strikes** (`/datav2/hist/cores`, `/hist/strikes`) | ORATS `#1/#2` | Follow `302` redirect cleanly (do NOT leak token on redirect); `impErnMv` is percent-points (`10.04 -> 0.1004`), `orIvXern20d` is decimal (`0.40`). Batches up to 10 tickers work (`hist/strikes`) with 1-ticker fallback | Explicitly **block `stockPrice` and `pxAtmIv`** from ORATS (`_orats_ref_px_blocked_*`); price authority always belongs to Massive/Tradier. |
| **ORATS WHAM** (`/datav2/hist/wham`) | ORATS `#1/#2` | Live coverage ONLY on **`SPY`, `QQQ`, `IWM`** (`DIA/XLK/XLF` return 0 rows); returns intraday snapshots | Restrict `MACRO_SHOCK` WHAM parsing to ETFs; deduplicate strictly by **latest EOD `quoteDate`** per `(ticker, tradeDate)`; emit `MISSING_WHAM_COVERAGE` on `DIA/XLK/XLF`. |
| **Massive `STOCKS_REST`** (`/v2/aggs`, `/stocks/v1/splits`, `/dividends`, `/stocks/vX/float`) | `MASSIVE_KEY_2`, `KEY_3`, failover `KEY_1` | 1m bars have millisecond `t` -> normalize immediately to UTC seconds `Bar.time`. Float snapshots are non-PIT (`is_point_in_time=False`) | Never feed non-PIT float into causal Pillar M or cohort decay (`FLOAT_NON_PIT_SNAPSHOT`). Cross-check splits & dividends with FMP; quarantine mismatches with `CORP_ACTION_CONFLICT_QUARANTINED` (`safe_to_apply=false`). |
| **Massive `OPTIONS_REST`** (`/options/v1/open-interest/underlying`, `/unusual-trades`) | **ONLY `MASSIVE_API_KEY`** | `open-interest/underlying` repairs ORATS sporadic `oi=0` glitches (e.g. `SPY 2025-10-06 = 16,786,351`). `unusual-trades` lacks NBBO side and ignores `min_premium` | Apply `ORATS_OI_FALLBACK_MASSIVE` when ORATS OI is 0 and Massive > 0; emit `NO_NBBO_AGGRESSOR_SIDE` (`net_directional_premium = null`). |
| **FMP Enterprise** (`/stable/earnings`, `/sec-filings-search/symbol`, `/splits`, `/dividends`) | `FMP_API_KEY` | `earnings` `time` is often `RETROSPECTIVE_NOT_PIT`; SEC `S-3`/`S-3ASR` shelf filings are NOT offerings | Anchor `SECONDARY_OFFERING` strictly on SEC `acceptedDate` ET with `424B5` market-placement evidence; exclude bare `S-3`/`S-3ASR`. Reconcile earnings TOD with ORATS `anncTod` + `MASSIVE_ETH_INFERRED` fallback. |
| **Tradier Live WS / REST** (`/markets/events/session`, `/markets/timesales`, `/options/chains`) | `TRADIER_*` tokens | Tradier returns `0` for absent quotes/sizes | Zero Silent Fallbacks: convert `0` bid/ask/last to `NaN` (`null` DTO); never use Massive WS. |

---

## 5. Phase 2 Implementation & Vitest Verification Plan

1. **Sequence:** Complete Sub-fase 1 stabilization (`Pieza 0B + S1-4..S2-3`) -> implement the 7 Phase 2 TypeScript modules in strict TDD order per `AGENTS.md` (pure core math first, then live accumulator, then server/UI wiring).
2. **Mandatory Golden Fixture Parity (`tests/avwapPhase2GoldenParity.test.ts` in Vitest):**
   - Load `research/avwap_oracle/spec/golden_fixtures/avwap_phase2_golden_fixtures.json` and assert strict parity (`tol <= 1e-9` on all AVWAP/moments/Greeks/IASS/confluence floats and exact string match on FSM states, tiers, and degradation flags) across all 5 golden cases:
     1. `NVDA` 10:1 split (`2024-06-10`) rollups + `EARNINGS_BLOWOUT` (`2024-02-21`) vs `EARNINGS_INLINE` (`2024-11-20`).
     2. `SPY` `CALENDAR_YTD` (`2024-01-02`) hybrid bands + `OI` fallback (`2025-10-06`) + `POSITIVE_GAMMA` vs `NEGATIVE_GAMMA` confluence + BSM Vanna & Charm.
     3. `MELI` `US_ADR` Bayesian shrinkage (`dataCoverage = 0.70`, prior `35.0`).
     4. `COST` `$15` special dividend (`2023-12-27`) O(1) adjustment vs `$1.47` regular dividend no-op.
     5. FSM 15/20-bar `PINCH_PAIR`, `PINCH_BREAKOUT (> 0.35 ATR)`, `COHORT_DECAY`, `CHOP_SATURATION`, `BREAKOUT_RESURRECTION`, and `ARCHIVED`.
3. **Final Gate per Piece:** Commit atomically per piece after passing Python fixture generator check and `npm run verify`.
