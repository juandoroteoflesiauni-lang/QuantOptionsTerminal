import React from 'react';

export type FallbackLayoutVariant =
  | 'chart-deck'
  | 'options-suite'
  | 'dual-chart'
  | 'table-grid'
  | 'options-subview';

export const ModuleViewFallback: React.FC<{
  readonly moduleId: string;
  readonly variant: FallbackLayoutVariant;
}> = ({ moduleId, variant }) => {
  if (variant === 'chart-deck' || variant === 'dual-chart') {
    return (
      <div
        data-qot-module-fallback={moduleId}
        className="space-y-4 font-mono-num tabular-nums"
        aria-busy="true"
        aria-label={`Cargando módulo ${moduleId}`}
      >
        <div className="h-[76px] rounded-[10px] bg-[#131722] border border-[#232733] px-4 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-[#9CA3AF]">
            Inicializando motor gráfico ({moduleId})…
          </span>
          <span className="text-[11px] text-[#787B86]">—</span>
        </div>
        <div className="min-h-[560px] rounded-[10px] bg-[#131722] border border-[#232733] p-4 flex items-center justify-center">
          <span className="text-[12px] text-[#787B86]">Preparando lienzo y series…</span>
        </div>
        <div className="min-h-[180px] rounded-[10px] bg-[#131722] border border-[#232733] p-4 flex items-center justify-between">
          <span className="text-[11px] text-[#787B86]">Panel analítico inferior</span>
          <span className="text-[11px] text-[#787B86]">—</span>
        </div>
      </div>
    );
  }

  if (variant === 'options-suite') {
    return (
      <div
        data-qot-module-fallback={moduleId}
        className="space-y-4 font-mono-num tabular-nums"
        aria-busy="true"
        aria-label={`Cargando módulo ${moduleId}`}
      >
        <div className="h-[108px] rounded-[10px] bg-[#131722] border border-[#232733] px-5 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-[#9CA3AF]">
            Cargando suite cuantitativa de opciones…
          </span>
          <span className="text-[11px] text-[#787B86]">—</span>
        </div>
        <div className="min-h-[620px] rounded-[10px] bg-[#131722] border border-[#232733] p-5 flex items-center justify-center">
          <span className="text-[12px] text-[#787B86]">Preparando cadenas y motores Bjerksund-Stensland…</span>
        </div>
      </div>
    );
  }

  if (variant === 'options-subview') {
    return (
      <div
        data-qot-module-fallback={moduleId}
        className="min-h-[540px] rounded-[10px] bg-[#131722] border border-[#232733] p-5 flex items-center justify-center font-mono-num tabular-nums"
        aria-busy="true"
        aria-label={`Cargando subvista ${moduleId}`}
      >
        <span className="text-[12px] text-[#787B86]">Cargando vista especializada ({moduleId})…</span>
      </div>
    );
  }

  return (
    <div
      data-qot-module-fallback={moduleId}
      className="space-y-4 font-mono-num tabular-nums"
      aria-busy="true"
      aria-label={`Cargando módulo ${moduleId}`}
    >
      <div className="h-[46px] rounded-[10px] bg-[#131722] border border-[#232733] px-4 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-[#9CA3AF]">
          Inicializando vista ({moduleId})…
        </span>
        <span className="text-[11px] text-[#787B86]">—</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 h-[104px]">
        {[0, 1, 2, 3].map((slot) => (
          <div
            key={slot}
            className="rounded-[10px] bg-[#131722] border border-[#232733] px-4 py-3 flex flex-col justify-between"
          >
            <span className="text-[11px] text-[#787B86]">Indicador</span>
            <span className="text-[18px] font-bold text-[#9CA3AF]">—</span>
          </div>
        ))}
      </div>
      <div className="min-h-[540px] rounded-[10px] bg-[#131722] border border-[#232733] p-5 flex items-center justify-center">
        <span className="text-[12px] text-[#787B86]">Preparando filas y métricas…</span>
      </div>
    </div>
  );
};
