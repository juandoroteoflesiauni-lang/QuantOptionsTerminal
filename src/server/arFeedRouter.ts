/**
 * Explicit priority router for Argentine market feeds (Pieza 28).
 *
 * Provider priority hierarchy:
 *   1. PRIMARY_MATRIZ_WS       -> REALTIME_L2_TICK (L1-L5 order book, trades, DLR/* futures)
 *   2. PPI_REST                -> POLLING_L1_REST
 *   3. IOL_REST                -> POLLING_L1_REST
 *   4. BMB_HOMEBROKER_BRIDGE   -> REALTIME_L2_TICK (HomeBroker L1-L5 + BYMA options)
 *   5. MAE_MARKETDATA_V1       -> POLLING_L1_REST (official/wholesale FX rates)
 *   6. BYMA_CLEARING           -> Clearing margins & haircuts
 *   7. IAMC_ANEXO_B_PDF        -> Daily Open Interest (pre-09:00 ART PDF/JSON)
 *   8. DATA912_EOD_CONTINGENCY -> EOD_CONTINGENCY ONLY (never L2, never silently promoted)
 *
 * Zero Silent Fallbacks: whenever neither `PRIMARY_MATRIZ_WS` nor a configured
 * `BMB_HOMEBROKER_BRIDGE` has a fresh real book, L2 ladder state fails closed.
 */

import type {
  ArFeedProviderId,
  ArFeedRouterStatusSnapshot,
  ArMarketFeedRouterConfig,
  ArProviderHealthEntry,
  FeedQualityTier,
  GgalL2LadderState,
  GgalL2OrderLevel,
} from '../core/ggal/institutionalContracts.js';
import type { OrderBook5LevelsDto } from './primaryRofexLoader.js';
import { BMB_OUT_OF_SESSION_REASON, isBmbFeedConfigured } from './bmbFeedAdapter.js';
import { redactSecrets } from './runtimeCache.js';

export type ArRouterHttpFn = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}>;

export const DEFAULT_AR_MARKET_FEED_ROUTER_CONFIG: ArMarketFeedRouterConfig = {
  providerOrder: [
    {
      provider: 'PRIMARY_MATRIZ_WS',
      priority: 1,
      role: 'L2_EQUITY_FX_WS',
      supportsL2OrderBook: true,
      staleThresholdSec: 15,
    },
    {
      provider: 'PPI_REST',
      priority: 2,
      role: 'REST_L1_QUOTES',
      supportsL2OrderBook: false,
      staleThresholdSec: 45,
    },
    {
      provider: 'IOL_REST',
      priority: 3,
      role: 'REST_L1_QUOTES',
      supportsL2OrderBook: false,
      staleThresholdSec: 60,
    },
    {
      provider: 'BMB_HOMEBROKER_BRIDGE',
      priority: 4,
      role: 'L2_EQUITY_OPTIONS_WS',
      supportsL2OrderBook: true,
      staleThresholdSec: 20,
    },
    {
      provider: 'MAE_MARKETDATA_V1',
      priority: 5,
      role: 'MAE_FX_RATES',
      supportsL2OrderBook: false,
      staleThresholdSec: 120,
    },
    {
      provider: 'BYMA_CLEARING',
      priority: 6,
      role: 'CLEARING_MARGINS',
      supportsL2OrderBook: false,
      staleThresholdSec: 900,
    },
    {
      provider: 'IAMC_ANEXO_B_PDF',
      priority: 7,
      role: 'ANEXO_B_OI',
      supportsL2OrderBook: false,
      staleThresholdSec: 86400,
    },
    {
      provider: 'DATA912_EOD_CONTINGENCY',
      priority: 8,
      role: 'EOD_CONTINGENCY',
      supportsL2OrderBook: false,
      staleThresholdSec: 86400,
    },
  ],
  maxClockSkewSec: 15,
  disallowSyntheticL2: true,
  allowData912OnlyAsEodContingency: true,
};

const ROLE_LABELS: Readonly<Record<ArFeedProviderId, string>> = {
  PRIMARY_MATRIZ_WS: 'Primary / Matriz WS (L2 Order Book 5 Puntas & DLR Futuros)',
  PPI_REST: 'PPI REST API (L1 Polling Contingencia)',
  IOL_REST: 'IOL REST API (L1 Polling Respaldo)',
  BMB_HOMEBROKER_BRIDGE: 'Bull Market Brokers HomeBroker Bridge (GGAL L2 5 Puntas & Opciones BYMA)',
  MAE_MARKETDATA_V1: 'MAE MarketData v1 (FX Mayorista & Curva)',
  BYMA_CLEARING: 'BYMA Clearing (Garantías & Aforos)',
  IAMC_ANEXO_B_PDF: 'IAMC Anexo B PDF Diario (<09:00 ART)',
  DATA912_EOD_CONTINGENCY: 'Data912 (Solo Contingencia / Cierre EOD)',
};

export interface ArFeedRuntimeTelemetryInput {
  readonly asOfUtcSec: number;
  readonly primaryConnected: boolean;
  readonly primaryConfigured: boolean;
  readonly primaryLastMsgUtcSec: number | null;
  readonly primaryError: string | null;
  readonly primaryFuturesLive?: boolean;
  readonly primaryFuturesLastMsgUtcSec?: number | null;
  readonly primaryFuturesCount?: number;
  readonly primaryEnvironment?: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX' | null;
  readonly bmbConfigured?: boolean;
  readonly bmbConnected?: boolean;
  readonly bmbLastMsgUtcSec?: number | null;
  readonly bmbError?: string | null;
  readonly bmbOutOfSession?: boolean;
  readonly ppiConfigured: boolean;
  readonly ppiHealthy: boolean;
  readonly ppiLastMsgUtcSec: number | null;
  readonly ppiError: string | null;
  readonly iolConfigured: boolean;
  readonly iolHealthy: boolean;
  readonly iolLastMsgUtcSec: number | null;
  readonly iolError: string | null;
  readonly maeConfigured: boolean;
  readonly maeHealthy: boolean;
  readonly maeLastMsgUtcSec: number | null;
  readonly maeError: string | null;
  readonly bymaClearingConfigured: boolean;
  readonly bymaClearingHealthy: boolean;
  readonly bymaClearingLastMsgUtcSec: number | null;
  readonly bymaClearingError: string | null;
  readonly anexoBLoaded: boolean;
  readonly anexoBLastMsgUtcSec: number | null;
  readonly anexoBError: string | null;
  readonly data912Reachable: boolean;
  readonly data912LastMsgUtcSec: number | null;
  readonly data912Error: string | null;
}

export interface ArProviderEndpointsConfig {
  readonly matrizWsConfigured: boolean;
  readonly bmbConfigured: boolean;
  readonly ppiBaseUrl: string | null;
  readonly ppiApiKey: string | null;
  readonly ppiApiSecret: string | null;
  readonly iolBaseUrl: string | null;
  readonly iolToken: string | null;
  readonly maeBaseUrl: string | null;
  readonly maeApiKey: string | null;
  readonly bymaClearingUrl: string | null;
  readonly bymaClearingToken: string | null;
  readonly data912BaseUrl: string | null;
}

export function collectArFeedSecrets(env: NodeJS.ProcessEnv): readonly string[] {
  const keys = [
    'MATRIZ_TOKEN',
    'MATRIZ_PASSWORD',
    'MATRIZ_USER',
    'PRIMARY_PASSWORD',
    'PRIMARY_USERNAME',
    'BMB_CLIENT_SECRET',
    'BMB_PASSWORD',
    'BMB_PASS',
    'BMB_USERNAME',
    'BMB_USER',
    'BMB_DNI',
    'BMB_ACCOUNT',
    'BMB_COMITENTE',
    'PPI_API_KEY',
    'PPI_API_SECRET',
    'IOL_TOKEN',
    'IOL_PASSWORD',
    'MAE_API_KEY',
    'BYMA_CLEARING_TOKEN',
  ] as const;
  const out: string[] = [];
  for (const key of keys) {
    const val = env[key]?.trim();
    if (val !== undefined && val.length > 0) {
      out.push(val);
    }
  }
  return out;
}

export function loadArProviderEndpointsFromEnv(env: NodeJS.ProcessEnv): ArProviderEndpointsConfig {
  const clean = (v: string | undefined): string | null => {
    const trimmed = v?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  };

  const matrizUrl =
    clean(env['MATRIZ_WS_URL']) ??
    clean(env['PRIMARY_WS_URL']) ??
    clean(env['PRIMARY_BASE_URL']);
  const matrizCred =
    clean(env['MATRIZ_TOKEN']) ??
    clean(env['PRIMARY_PASSWORD']);

  return {
    matrizWsConfigured: matrizUrl !== null && matrizCred !== null,
    bmbConfigured: isBmbFeedConfigured(env),
    ppiBaseUrl: clean(env['PPI_BASE_URL']),
    ppiApiKey: clean(env['PPI_API_KEY']),
    ppiApiSecret: clean(env['PPI_API_SECRET']),
    iolBaseUrl: clean(env['IOL_BASE_URL']),
    iolToken: clean(env['IOL_TOKEN']) ?? clean(env['IOL_PASSWORD']),
    maeBaseUrl: clean(env['MAE_BASE_URL']),
    maeApiKey: clean(env['MAE_API_KEY']),
    bymaClearingUrl: clean(env['BYMA_CLEARING_URL']),
    bymaClearingToken: clean(env['BYMA_CLEARING_TOKEN']),
    data912BaseUrl: clean(env['DATA912_BASE_URL']) ?? 'https://data912.com',
  };
}

function defaultHealthEntry(
  provider: ArFeedProviderId,
  priority: number,
  configured: boolean,
): ArProviderHealthEntry {
  return {
    provider,
    priority,
    configured,
    connected: false,
    qualityTier: 'UNAVAILABLE',
    lastMessageUtcSec: null,
    latencyMs: configured ? null : 0,
    stale: true,
    errorReason: configured ? 'AWAITING_FIRST_SYNC' : 'NOT_CONFIGURED',
    roleDescription: ROLE_LABELS[provider],
  };
}

export interface ArFeedRouterStatusSnapshotExt extends ArFeedRouterStatusSnapshot {
  readonly futuresDlrLive: 'CONNECTED' | 'DISCONNECTED';
  readonly futuresDlrProvider: 'PRIMARY_MATRIZ_WS' | 'PRIMARY_ECO_XOMS_WS' | 'PRIMARY_REMARKETS_SANDBOX' | null;
  readonly futuresDlrLastMsgUtcSec: number | null;
  readonly futuresDlrCount: number;
}

export class ArFeedRouter {
  private readonly config: ArMarketFeedRouterConfig;
  private readonly secrets: readonly string[];
  private readonly endpoints: ArProviderEndpointsConfig;
  private readonly nowMsFn: () => number;
  private readonly providerHealth = new Map<ArFeedProviderId, ArProviderHealthEntry>();
  private futuresDlrLive = false;
  private futuresDlrLastMsgUtcSec: number | null = null;
  private futuresDlrCount = 0;
  private futuresDlrProvider:
    | 'PRIMARY_MATRIZ_WS'
    | 'PRIMARY_ECO_XOMS_WS'
    | 'PRIMARY_REMARKETS_SANDBOX'
    | null = null;

  public constructor(opts?: {
    readonly config?: ArMarketFeedRouterConfig;
    readonly env?: NodeJS.ProcessEnv;
    readonly nowMsFn?: () => number;
    readonly secrets?: readonly string[];
  }) {
    this.config = opts?.config ?? DEFAULT_AR_MARKET_FEED_ROUTER_CONFIG;
    const env = opts?.env ?? {};
    this.endpoints = loadArProviderEndpointsFromEnv(env);
    this.secrets = opts?.secrets ?? collectArFeedSecrets(env);
    this.nowMsFn = opts?.nowMsFn ?? (() => Date.now());

    for (const item of this.config.providerOrder) {
      const configured = this.isConfiguredFromEnv(item.provider);
      this.providerHealth.set(item.provider, defaultHealthEntry(item.provider, item.priority, configured));
    }
  }

  private isConfiguredFromEnv(provider: ArFeedProviderId): boolean {
    switch (provider) {
      case 'PRIMARY_MATRIZ_WS':
        return this.endpoints.matrizWsConfigured;
      case 'PPI_REST':
        return this.endpoints.ppiBaseUrl !== null && this.endpoints.ppiApiKey !== null && this.endpoints.ppiApiSecret !== null;
      case 'IOL_REST':
        return this.endpoints.iolBaseUrl !== null && this.endpoints.iolToken !== null;
      case 'BMB_HOMEBROKER_BRIDGE':
        return this.endpoints.bmbConfigured;
      case 'MAE_MARKETDATA_V1':
        return this.endpoints.maeBaseUrl !== null && this.endpoints.maeApiKey !== null;
      case 'BYMA_CLEARING':
        return this.endpoints.bymaClearingUrl !== null;
      case 'IAMC_ANEXO_B_PDF':
        return true;
      case 'DATA912_EOD_CONTINGENCY':
        return this.endpoints.data912BaseUrl !== null;
    }
  }

  public getEndpointsConfig(): ArProviderEndpointsConfig {
    return this.endpoints;
  }

  public updateFromRuntimeTelemetry(input: ArFeedRuntimeTelemetryInput): void {
    const asOf = input.asOfUtcSec;
    this.futuresDlrLive = input.primaryFuturesLive === true;
    this.futuresDlrLastMsgUtcSec = input.primaryFuturesLastMsgUtcSec ?? null;
    this.futuresDlrCount = input.primaryFuturesCount ?? 0;
    this.futuresDlrProvider = input.primaryEnvironment ?? null;
    const priorityMap = new Map(this.config.providerOrder.map((p) => [p.provider, p]));

    const buildEntry = (
      provider: ArFeedProviderId,
      configured: boolean,
      connected: boolean,
      tier: FeedQualityTier,
      lastMsgUtcSec: number | null,
      errorRaw: string | null,
    ): ArProviderHealthEntry => {
      const cfg = priorityMap.get(provider);
      const priority = cfg?.priority ?? 99;
      const staleThreshold = cfg?.staleThresholdSec ?? 60;
      const ageSec = lastMsgUtcSec !== null && asOf >= lastMsgUtcSec ? asOf - lastMsgUtcSec : null;
      const stale = lastMsgUtcSec === null || ageSec === null || ageSec > staleThreshold;
      const cleanError = errorRaw !== null ? redactSecrets(errorRaw, this.secrets) : null;

      return {
        provider,
        priority,
        configured,
        connected: configured && connected && !stale,
        qualityTier: configured && connected && !stale ? tier : 'UNAVAILABLE',
        lastMessageUtcSec: lastMsgUtcSec,
        latencyMs: !configured
          ? 0
          : ageSec !== null
            ? Math.max(0, ageSec * 1000)
            : null,
        stale,
        errorReason:
          !configured
            ? 'NOT_CONFIGURED'
            : cleanError !== null
              ? cleanError
              : !connected
                ? 'DISCONNECTED'
                : stale
                  ? 'STALE_MESSAGE_AGE'
                  : null,
        roleDescription: ROLE_LABELS[provider],
      };
    };

    this.providerHealth.set(
      'PRIMARY_MATRIZ_WS',
      buildEntry(
        'PRIMARY_MATRIZ_WS',
        input.primaryConfigured || this.endpoints.matrizWsConfigured,
        input.primaryConnected,
        'REALTIME_L2_TICK',
        input.primaryLastMsgUtcSec,
        input.primaryError,
      ),
    );
    this.providerHealth.set(
      'BMB_HOMEBROKER_BRIDGE',
      buildEntry(
        'BMB_HOMEBROKER_BRIDGE',
        input.bmbConfigured ?? this.endpoints.bmbConfigured,
        input.bmbOutOfSession === true ? false : (input.bmbConnected ?? false),
        'REALTIME_L2_TICK',
        input.bmbOutOfSession === true ? null : (input.bmbLastMsgUtcSec ?? null),
        input.bmbOutOfSession === true
          ? BMB_OUT_OF_SESSION_REASON
          : (input.bmbError ?? null),
      ),
    );
    this.providerHealth.set(
      'PPI_REST',
      buildEntry(
        'PPI_REST',
        input.ppiConfigured ||
          (this.endpoints.ppiBaseUrl !== null &&
            this.endpoints.ppiApiKey !== null &&
            this.endpoints.ppiApiSecret !== null),
        input.ppiHealthy,
        'POLLING_L1_REST',
        input.ppiLastMsgUtcSec,
        input.ppiError,
      ),
    );
    this.providerHealth.set(
      'IOL_REST',
      buildEntry(
        'IOL_REST',
        input.iolConfigured || (this.endpoints.iolBaseUrl !== null && this.endpoints.iolToken !== null),
        input.iolHealthy,
        'POLLING_L1_REST',
        input.iolLastMsgUtcSec,
        input.iolError,
      ),
    );
    this.providerHealth.set(
      'MAE_MARKETDATA_V1',
      buildEntry(
        'MAE_MARKETDATA_V1',
        input.maeConfigured || (this.endpoints.maeBaseUrl !== null && this.endpoints.maeApiKey !== null),
        input.maeHealthy,
        'POLLING_L1_REST',
        input.maeLastMsgUtcSec,
        input.maeError,
      ),
    );
    this.providerHealth.set(
      'BYMA_CLEARING',
      buildEntry(
        'BYMA_CLEARING',
        input.bymaClearingConfigured || this.endpoints.bymaClearingUrl !== null,
        input.bymaClearingHealthy,
        'POLLING_L1_REST',
        input.bymaClearingLastMsgUtcSec,
        input.bymaClearingError,
      ),
    );
    this.providerHealth.set(
      'IAMC_ANEXO_B_PDF',
      buildEntry(
        'IAMC_ANEXO_B_PDF',
        true,
        input.anexoBLoaded,
        'EOD_CONTINGENCY',
        input.anexoBLastMsgUtcSec,
        input.anexoBError,
      ),
    );
    this.providerHealth.set(
      'DATA912_EOD_CONTINGENCY',
      buildEntry(
        'DATA912_EOD_CONTINGENCY',
        this.endpoints.data912BaseUrl !== null,
        input.data912Reachable,
        'EOD_CONTINGENCY',
        input.data912LastMsgUtcSec,
        input.data912Error,
      ),
    );
  }

  public getStatusSnapshot(asOfUtcSecOverride?: number): ArFeedRouterStatusSnapshotExt {
    const asOfUtcSec = asOfUtcSecOverride ?? Math.floor(this.nowMsFn() / 1000);
    const providers = this.config.providerOrder
      .map((cfg) => this.providerHealth.get(cfg.provider) ?? defaultHealthEntry(cfg.provider, cfg.priority, false))
      .slice()
      .sort((a, b) => a.priority - b.priority);

    const byId = new Map(providers.map((p) => [p.provider, p]));
    const primary = byId.get('PRIMARY_MATRIZ_WS');
    const bmb = byId.get('BMB_HOMEBROKER_BRIDGE');
    const ppi = byId.get('PPI_REST');
    const iol = byId.get('IOL_REST');
    const mae = byId.get('MAE_MARKETDATA_V1');
    const bymaClearing = byId.get('BYMA_CLEARING');
    const anexoB = byId.get('IAMC_ANEXO_B_PDF');
    const data912 = byId.get('DATA912_EOD_CONTINGENCY');

    let activePrimaryEquityProvider: ArFeedProviderId | null = null;
    let activeQualityTier: FeedQualityTier = 'UNAVAILABLE';
    let l2Available = false;
    let isContingencyEod = false;
    let degradationReason: string | null = null;

    if (bmb !== undefined && bmb.connected && !bmb.stale && bmb.qualityTier === 'REALTIME_L2_TICK') {
      activePrimaryEquityProvider = 'BMB_HOMEBROKER_BRIDGE';
      activeQualityTier = 'REALTIME_L2_TICK';
      l2Available = true;
    } else if (primary !== undefined && primary.connected && !primary.stale && primary.qualityTier === 'REALTIME_L2_TICK') {
      activePrimaryEquityProvider = 'PRIMARY_MATRIZ_WS';
      activeQualityTier = 'REALTIME_L2_TICK';
      l2Available = true;
      degradationReason = bmb?.configured ? 'BMB_HOMEBROKER_BRIDGE_UNAVAILABLE_USING_PRIMARY_MATRIZ_WS' : null;
    } else if (ppi !== undefined && ppi.connected && !ppi.stale) {
      activePrimaryEquityProvider = 'PPI_REST';
      activeQualityTier = 'POLLING_L1_REST';
      degradationReason = bmb?.errorReason === BMB_OUT_OF_SESSION_REASON
        ? 'BMB_HOMEBROKER_BRIDGE_OUT_OF_SESSION_DEGRADED_TO_PPI_REST'
        : 'PRIMARY_MATRIZ_WS_UNAVAILABLE_DEGRADED_TO_PPI_REST';
    } else if (iol !== undefined && iol.connected && !iol.stale) {
      activePrimaryEquityProvider = 'IOL_REST';
      activeQualityTier = 'POLLING_L1_REST';
      degradationReason = bmb?.errorReason === BMB_OUT_OF_SESSION_REASON
        ? 'BMB_HOMEBROKER_BRIDGE_OUT_OF_SESSION_DEGRADED_TO_IOL_REST'
        : 'PRIMARY_MATRIZ_WS_UNAVAILABLE_DEGRADED_TO_IOL_REST';
    } else if (data912 !== undefined && data912.connected && !data912.stale) {
      activePrimaryEquityProvider = 'DATA912_EOD_CONTINGENCY';
      activeQualityTier = 'EOD_CONTINGENCY';
      isContingencyEod = true;
      degradationReason = bmb?.errorReason === BMB_OUT_OF_SESSION_REASON
        ? 'BMB_HOMEBROKER_BRIDGE_OUT_OF_SESSION_DEGRADED_TO_DATA912_EOD'
        : 'DEGRADED_TO_DATA912_EOD_CONTINGENCY_NO_L2';
    } else {
      activePrimaryEquityProvider = null;
      activeQualityTier = 'UNAVAILABLE';
      degradationReason = bmb?.errorReason === BMB_OUT_OF_SESSION_REASON
        ? BMB_OUT_OF_SESSION_REASON
        : (bmb?.configured ? bmb.errorReason : null) ?? primary?.errorReason ?? 'NO_AR_EQUITY_FEED_OPERATIONAL';
    }

    const activeFxFuturesProvider: ArFeedProviderId | null =
      (primary !== undefined && primary.connected) || this.futuresDlrLive
        ? 'PRIMARY_MATRIZ_WS'
        : mae !== undefined && mae.connected
          ? 'MAE_MARKETDATA_V1'
          : null;

    const activeSovereignProvider: ArFeedProviderId | null =
      bymaClearing !== undefined && bymaClearing.connected
        ? 'BYMA_CLEARING'
        : data912 !== undefined && data912.connected
          ? 'DATA912_EOD_CONTINGENCY'
          : null;

    const activeAnexoBProvider: ArFeedProviderId | null =
      anexoB !== undefined && anexoB.connected ? 'IAMC_ANEXO_B_PDF' : null;

    return {
      asOfUtcSec,
      activePrimaryEquityProvider,
      activeQualityTier,
      l2Available,
      activeFxFuturesProvider,
      activeSovereignProvider,
      activeAnexoBProvider,
      isContingencyEod,
      degradationReason,
      providers,
      futuresDlrLive: this.futuresDlrLive ? 'CONNECTED' : 'DISCONNECTED',
      futuresDlrProvider: this.futuresDlrProvider,
      futuresDlrLastMsgUtcSec: this.futuresDlrLastMsgUtcSec,
      futuresDlrCount: this.futuresDlrCount,
    };
  }

  /**
   * Resolves explicit 5-level L2 book state for Primary or BMB.
   * Zero Silent Fallbacks: non-L2, stale, crossed-source and out-of-session states
   * never borrow Data912 or another provider's levels.
   */
  public resolveL2LadderState(
    symbol: string,
    rawBook: OrderBook5LevelsDto | null,
    asOfUtcSecOverride?: number,
  ): GgalL2LadderState {
    const status = this.getStatusSnapshot(asOfUtcSecOverride);
    const asOfUtcSec = status.asOfUtcSec;
    const bmb = status.providers.find((p) => p.provider === 'BMB_HOMEBROKER_BRIDGE');

    const toLevels = (
      sideLevels: readonly { readonly price: number; readonly size: number; readonly orderCount?: number | null }[],
    ): readonly GgalL2OrderLevel[] => {
      const out: GgalL2OrderLevel[] = [];
      for (let i = 0; i < Math.min(5, sideLevels.length); i++) {
        const lvl = sideLevels[i];
        if (lvl === undefined || !Number.isFinite(lvl.price) || !Number.isFinite(lvl.size)) {
          continue;
        }
        const levelNum = (i + 1) as 1 | 2 | 3 | 4 | 5;
        out.push({
          level: levelNum,
          price: lvl.price,
          size: lvl.size,
          orderCount:
            lvl.orderCount !== null &&
            lvl.orderCount !== undefined &&
            Number.isInteger(lvl.orderCount) &&
            lvl.orderCount >= 0
              ? lvl.orderCount
              : null,
        });
      }
      return out;
    };

    // Pieza 44: si Primary XOMS/MERV aportó caja L2 5 puntas (en vivo o último snapshot EOD/CIERRE),
    // servirla explícitamente aunque BMB esté OUT_OF_SESSION o el tick tenga >15 s sin cambio.
    if (
      rawBook !== null &&
      rawBook.source === 'PRIMARY_MERV' &&
      (rawBook.bids.length > 0 || rawBook.asks.length > 0) &&
      !(status.activePrimaryEquityProvider === 'BMB_HOMEBROKER_BRIDGE' && status.l2Available)
    ) {
      const primaryBids = toLevels(rawBook.bids);
      const primaryAsks = toLevels(rawBook.asks);
      if (primaryBids.length > 0 || primaryAsks.length > 0) {
        const isEodCached =
          rawBook.isEodCached === true ||
          rawBook.bookStatus === 'EOD_CIERRE' ||
          rawBook.marketState === 'WEEKEND_CLOSED';
        return {
          available: true,
          activeProvider: 'PRIMARY_MATRIZ_WS',
          qualityTier: 'REALTIME_L2_TICK',
          asOfUtcSec: rawBook.asOfUtcSec ?? asOfUtcSec,
          symbol,
          bids: primaryBids,
          asks: primaryAsks,
          bookStatus: isEodCached ? 'EOD_CIERRE' : 'LIVE',
          isEodCached,
        };
      }
    }

    if (
      bmb?.configured === true &&
      bmb.errorReason === BMB_OUT_OF_SESSION_REASON
    ) {
      return {
        available: false,
        reason: 'OUT_OF_SESSION',
        activeProvider: status.activePrimaryEquityProvider,
        qualityTier: status.activeQualityTier,
        asOfUtcSec,
        symbol,
      };
    }

    if (
      status.activeQualityTier !== 'REALTIME_L2_TICK' ||
      (status.activePrimaryEquityProvider !== 'PRIMARY_MATRIZ_WS' &&
        status.activePrimaryEquityProvider !== 'BMB_HOMEBROKER_BRIDGE') ||
      !status.l2Available
    ) {
      return {
        available: false,
        reason: 'NON_L2_FEED_ACTIVE',
        activeProvider: status.activePrimaryEquityProvider,
        qualityTier: status.activeQualityTier,
        asOfUtcSec,
        symbol,
      };
    }

    if (
      rawBook === null ||
      rawBook.source === 'BYMA_L1_ONLY' ||
      (status.activePrimaryEquityProvider === 'BMB_HOMEBROKER_BRIDGE' && rawBook.source !== 'BMB_HOMEBROKER') ||
      (status.activePrimaryEquityProvider === 'PRIMARY_MATRIZ_WS' && rawBook.source !== 'PRIMARY_MERV') ||
      rawBook.bids.length === 0 ||
      rawBook.asks.length === 0
    ) {
      return {
        available: false,
        reason: 'INVALID_BOOK_STATE',
        activeProvider: status.activePrimaryEquityProvider,
        qualityTier: 'REALTIME_L2_TICK',
        asOfUtcSec,
        symbol,
      };
    }

    const bids = toLevels(rawBook.bids);
    const asks = toLevels(rawBook.asks);

    if (bids.length === 0 || asks.length === 0) {
      return {
        available: false,
        reason: 'INVALID_BOOK_STATE',
        activeProvider: status.activePrimaryEquityProvider,
        qualityTier: 'REALTIME_L2_TICK',
        asOfUtcSec,
        symbol,
      };
    }

    return {
      available: true,
      activeProvider: status.activePrimaryEquityProvider,
      qualityTier: 'REALTIME_L2_TICK',
      asOfUtcSec,
      symbol,
      bids,
      asks,
      bookStatus:
        rawBook.isEodCached === true || rawBook.bookStatus === 'EOD_CIERRE'
          ? 'EOD_CIERRE'
          : 'LIVE',
      isEodCached: rawBook.isEodCached === true || rawBook.bookStatus === 'EOD_CIERRE',
    };
  }
}
