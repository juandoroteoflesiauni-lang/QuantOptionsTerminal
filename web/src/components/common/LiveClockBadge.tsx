import { memo } from 'react';
import { useMarketStreamClock } from '../../api/useMarketLiveStream';

export const LiveClockBadge = memo(function LiveClockBadge({
  enabled = true,
  extended = null,
  showClosed = false,
}: {
  readonly enabled?: boolean;
  readonly extended?: 'PRE' | 'AH' | null;
  readonly showClosed?: boolean;
}) {
  const { clock } = useMarketStreamClock();
  const visible = enabled && clock !== null;
  if (!visible && showClosed) {
    return (
      <span className="inline-flex min-w-[130px] items-center rounded-full border border-[#F5B544]/35 bg-[#F5B544]/10 px-2 py-0.5 font-mono-num text-[10px] font-semibold text-[#F5B544]">
        ● CIERRE EOD
      </span>
    );
  }
  return (
    <span
      aria-hidden={!visible}
      className={`inline-flex min-w-[130px] items-center gap-1 rounded-full border px-2 py-0.5 font-mono-num text-[10px] font-semibold ${
        extended ? 'border-[#F5B544]/35 bg-[#F5B544]/10 text-[#F5B544]' : 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#22C55E]'
      } ${visible ? '' : 'invisible'}`}
    >
      ● {extended ?? 'Tiempo real'} {clock}
    </span>
  );
});
