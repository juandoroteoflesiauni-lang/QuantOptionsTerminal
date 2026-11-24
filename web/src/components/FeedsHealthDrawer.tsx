import React, { useEffect, useRef } from 'react';
import { X, RefreshCw, Activity } from 'lucide-react';
import {
  reconnectProvider,
  useFeedsHealthDrawerState,
  type FeedProviderHealth,
  type FeedProviderId,
  type FeedProviderState,
} from '../data/feedsHealthStore';

export * from '../data/feedsHealthStore';

/* ============================================================================
   4. FORMATEADORES (NULL => "—", NUNCA 0 FALSO)
   ============================================================================ */
function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  return `${String(Math.round(value))} ms`;
}

function formatAgeMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${String(Math.round(value))} ms`;
}

function formatCount(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : String(Math.round(value));
}

function formatUtcSec(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  return new Date(value * 1_000).toLocaleTimeString('es-AR', { hour12: false });
}

/** Host REST del entorno Primary conectado (p. ej. `api.eco.xoms.com.ar`); sin protocolo ni credenciales. */
function primaryApiHost(apiUrl: string): string {
  if (typeof apiUrl !== 'string' || apiUrl.trim() === '') return '—';
  return apiUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '') || '—';
}

/** Host REST Tradier (p. ej. `api.tradier.com/v1`), sin protocolo ni credenciales. */
function tradierHost(restBaseUrl: string): string {
  if (typeof restBaseUrl !== 'string' || restBaseUrl.trim() === '') return '—';
  return restBaseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '') || '—';
}

function stateStyles(state: FeedProviderState): { readonly bg: string; readonly text: string; readonly border: string } {
  if (state === 'CONNECTED') {
    return { bg: 'bg-[#0D221E]', text: 'text-[#22C55E]', border: 'border-[#164E3F]' };
  }
  if (state === 'ARMED_OUT_OF_SESSION') {
    return { bg: 'bg-[#281E0E]', text: 'text-[#F5B544]', border: 'border-[#59411A]' };
  }
  if (state === 'STANDBY_TRADIER_FMP_PRIMARY') {
    return { bg: 'bg-[#101B33]', text: 'text-[#60A5FA]', border: 'border-[#22406F]' };
  }
  if (state === 'AUTH_INVALID') {
    return { bg: 'bg-[#2B1F0E]', text: 'text-[#F5B544]', border: 'border-[#664A1D]' };
  }
  if (state === 'NOT_CONFIGURED') {
    return { bg: 'bg-[#131722]', text: 'text-[#787B86]', border: 'border-[#2A2E3D]' };
  }
  return { bg: 'bg-[#1A1318]', text: 'text-[#F23645]', border: 'border-[#4A2229]' };
}

/* ============================================================================
   5. TARJETA POR PROVEEDOR
   ============================================================================ */
const DetailRow: React.FC<{ readonly label: string; readonly value: string }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[10.5px] uppercase tracking-wide text-[#787B86]">{label}</span>
    <span className="font-mono-num text-[11.5px] font-semibold text-[#D1D4DC]">{value}</span>
  </div>
);

const ProviderCard: React.FC<{
  readonly provider: FeedProviderHealth;
  readonly reconnecting: boolean;
  readonly onReconnect: (provider: FeedProviderId) => void;
}> = ({ provider, reconnecting, onReconnect }) => {
  const styles = stateStyles(provider.state);
  const latencyLabel =
    provider.latencyMs === null
      ? '—'
      : `${formatMs(provider.latencyMs)}${provider.latencyKind === null ? '' : provider.latencyKind === 'PROVIDER_EVENT_AGE' ? ' · evento' : ' · HTTP'}`;
  const symbolsLabel =
    provider.activeSymbolCount === null
      ? `${String(provider.subscribedSymbols.length)} suscriptos`
      : `${String(provider.activeSymbolCount)} activos · ${String(provider.subscribedSymbols.length)} suscriptos`;

  return (
    <section className="rounded-[10px] border border-[#1C1C24] bg-[#111116] p-3">
      <header className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[12.5px] font-bold text-[#ECEDF2]">{provider.id}</h3>
          <p className="truncate text-[11px] text-[#8A8F9E]">{provider.role}</p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-bold ${styles.bg} ${styles.text} ${styles.border}`}
        >
          {provider.state}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <DetailRow label="Región / Sesión" value={`${provider.region} · ${provider.sessionMode}`} />
        <DetailRow label="Conectado" value={provider.connected === null ? '—' : provider.connected ? 'SÍ' : 'NO'} />
        <DetailRow label="Latencia" value={latencyLabel} />
        <DetailRow label="Último tick" value={formatAgeMs(provider.lastTickAgeMs)} />
        <DetailRow label="Mensajes/min" value={formatCount(provider.messagesPerMinute)} />
        <DetailRow label="Símbolos" value={symbolsLabel} />
      </div>

      {provider.massiveWs !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Key slot" value={provider.massiveWs.keySlot === null ? '—' : `${provider.massiveWs.keySlot.envName}[${String(provider.massiveWs.keySlot.slotIndex)}]`} />
          <DetailRow label="Opciones suscriptas" value={formatCount(provider.massiveWs.subscribedOptionQuotes)} />
          <DetailRow label="WS sin datos" value={formatAgeMs(provider.massiveWs.lastWsMessageAgeMs)} />
        </div>
      )}

      {provider.massiveRest !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Pool / Último slot" value={`${String(provider.massiveRest.poolSize)} / ${provider.massiveRest.lastSlotIndex === null ? '—' : String(provider.massiveRest.lastSlotIndex)}`} />
          <DetailRow label="Round-robin" value={formatCount(provider.massiveRest.roundRobinRequests)} />
          <DetailRow label="429/min" value={formatCount(provider.massiveRest.http429PerMinute)} />
          <DetailRow label="Último 429" value={formatAgeMs(provider.massiveRest.lastHttp429AgeMs)} />
        </div>
      )}

      {provider.tradier !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Sesión creada" value={provider.tradier.sessionCreated ? 'SÍ' : 'NO'} />
          <DetailRow label="Entorno / REST" value={`${provider.tradier.environment} · ${tradierHost(provider.tradier.restBaseUrl)}`} />
          {(provider.state === 'AUTH_INVALID' || provider.tradier.authInvalid === true) && (
            <DetailRow label="Auth" value="INVÁLIDA (401 · fallback FMP)" />
          )}
          <DetailRow label="Reconnects" value={formatCount(provider.tradier.reconnectAttempts)} />
        </div>
      )}

      {provider.orats !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="ORATS / Fecha" value={`${provider.orats.healthStatus ?? '—'} · ${provider.orats.providerTradeDate ?? '—'}`} />
          {(['cores', 'strikes', 'ivrank'] as const).map(name => {
            const e = provider.orats?.endpoints?.[name];
            return <DetailRow key={name} label={'/' + name} value={e?.ok == null ? '—' : `${e.httpStatus ?? '—'} · ${e.errorKind ?? e.payloadState} · ${e.circuitState}`} />;
          })}
          <DetailRow label="Tier / Cuota" value={`${provider.orats.planTier ?? '—'} · ${provider.orats.quotaRemaining === null || provider.orats.quotaLimit === null ? '—' : `${String(provider.orats.quotaRemaining)}/${String(provider.orats.quotaLimit)}`}`} />
          <DetailRow label="Circuit breaker" value={`${provider.orats.circuitBreaker.state} · ${String(provider.orats.circuitBreaker.consecutiveFailures)} fallos`} />
          <DetailRow label="Último fetch" value={formatAgeMs(provider.orats.lastFetchAgeMs)} />
        </div>
      )}

      {provider.primary !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Entorno conectado" value={primaryApiHost(provider.primary.apiUrl)} />
          <DetailRow label="WS / Token" value={`${provider.primary.wsEnvironment} · ${provider.primary.authenticated ? 'OK' : '—'}`} />
          <DetailRow label="Suscriptos BYMA L2 / ROFEX" value={`${String(provider.primary.mervSubscribedCount)} / ${String(provider.primary.dlrSubscribedCount)}`} />
          <DetailRow label="Libros L2 activos" value={formatCount(provider.primary.liveMervBookCount + provider.primary.liveDlrCount)} />
          <DetailRow label="Renovaciones token" value={formatCount(provider.primary.tokenRenewCount)} />
          <DetailRow label="Último DLR" value={formatAgeMs(provider.primary.liveDlrLastUpdateAgeMs)} />
        </div>
      )}

      {provider.bmb !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Estado bridge" value={provider.bmb.status} />
          <DetailRow label="Libros / Opciones" value={`${String(provider.bmb.orderBookCount)} / ${String(provider.bmb.optionCount)}`} />
          <DetailRow label="Cauciones" value={formatCount(provider.bmb.caucionCount)} />
          <DetailRow label="Última actualización" value={formatAgeMs(provider.bmb.lastUpdateAgeMs)} />
        </div>
      )}

      {provider.iol !== undefined && (
        <div className="mt-2.5 border-t border-[#1C1C24] pt-2">
          <DetailRow label="Auth" value={provider.iol.authMethod ?? '—'} />
          <DetailRow label="Password / Refresh" value={`${String(provider.iol.passwordAuthCount)} / ${String(provider.iol.refreshAuthCount)}`} />
          <DetailRow label="Token expira" value={formatUtcSec(provider.iol.tokenExpiresAtUtcSec)} />
          <DetailRow label="Quotes vivos" value={formatCount(provider.iol.quoteCount)} />
        </div>
      )}

      {provider.lastError !== null && (
        <p className="mt-2.5 rounded-[6px] border border-[#4A2229] bg-[#1A1318] px-2 py-1.5 text-[11px] text-[#F23645]">
          {provider.lastError}
        </p>
      )}

      <button
        type="button"
        onClick={() => onReconnect(provider.id)}
        disabled={reconnecting || !provider.reconnectable}
        title={provider.reconnectAction === 'RESYNC' ? 'Forzar resincronización real' : 'Forzar reconexión real'}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-[8px] border border-[#2A2E3D] bg-[#131722] px-3 py-2 text-[11.5px] font-semibold text-[#D1D4DC] transition-colors hover:border-[#3D4358] hover:bg-[#1A1F2C] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${reconnecting ? 'animate-spin' : ''}`} />
        {reconnecting ? 'Sincronizando…' : 'Forzar Re-sincronización'}
      </button>
    </section>
  );
};

/* ============================================================================
   6. DRAWER
   ============================================================================ */
export interface FeedsHealthDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export const FeedsHealthDrawer: React.FC<FeedsHealthDrawerProps> = ({
  open,
  onClose,
}) => {
  const health = useFeedsHealthDrawerState(open);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previousActive instanceof HTMLElement) previousActive.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const summary = health.snapshot?.summary ?? null;
  const providers = health.snapshot?.providers ?? [];

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Cerrar telemetría de feeds"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Monitor unificado de salud, latencia y ticks de proveedores"
        className="absolute right-0 top-0 flex h-full w-[480px] max-w-full flex-col border-l border-[#1C1C24] bg-[#0A0A0D] shadow-2xl"
      >
        <header className="flex h-[54px] shrink-0 items-center justify-between border-b border-[#1C1C24] bg-[#111116] px-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#8B7CF6]" />
            <div>
              <h2 className="text-[13px] font-bold text-[#ECEDF2]">Feeds en vivo</h2>
              <p className="text-[10.5px] tabular-nums text-[#787B86]">
                {summary === null
                  ? 'Sin snapshot válido'
                  : `${String(summary.activeCount)}/${String(summary.totalProviders)} activos · ${String(summary.configuredCount)} armados${summary.standbyCount !== undefined && summary.standbyCount > 0 ? ` · ${String(summary.standbyCount)} standby` : ''}`}
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            title="Cerrar (Escape)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-transparent text-[#8A8F9E] transition-colors hover:border-[#2A2E3D] hover:bg-[#131722] hover:text-[#D1D4DC]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center justify-between border-b border-[#1C1C24] bg-[#0A0A0D] px-4 py-2 text-[10.5px] text-[#787B86]">
          <span>Canal WS dedicado: {health.socketStatus}</span>
          <span>Pulso: {health.lastPulseAtMs === null ? '—' : formatAgeMs(Date.now() - health.lastPulseAtMs)}</span>
        </div>

        <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
          {health.snapshot === null ? (
            <div className="rounded-[10px] border border-[#1C1C24] bg-[#111116] p-4 text-center text-[12px] text-[#8A8F9E]">
              Consultando telemetría real…
            </div>
          ) : (
            providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                reconnecting={health.reconnectingProvider === provider.id}
                onReconnect={reconnectProvider}
              />
            ))
          )}
        </div>

        {health.lastReconnectDetail !== null && (
          <footer
            className={`shrink-0 border-t px-4 py-2 text-[11px] ${
              health.lastReconnectOk === true
                ? 'border-[#164E3F] bg-[#0D221E] text-[#22C55E]'
                : 'border-[#4A2229] bg-[#1A1318] text-[#F23645]'
            }`}
          >
            {health.lastReconnectDetail}
          </footer>
        )}
      </aside>
    </div>
  );
};

export default FeedsHealthDrawer;
