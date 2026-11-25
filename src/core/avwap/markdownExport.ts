import { DEFAULT_AVWAP_CONTEXT_POLICY } from './policy.js';
import type {
  AvwapDegradationFlag,
  AvwapEmpiricalRole,
  AvwapGammaRegime,
  AvwapTimeframe,
  AvwapVolRegime,
  InstitutionalAvwapAnchor,
  UsOptionsAvwapContextExportPayload,
} from './types.js';

export interface InstitutionalAvwapConfluenceSummary {
  readonly gammaRegime: AvwapGammaRegime;
  readonly volRegime: AvwapVolRegime;
  readonly bounceConfluenceScore: number;
  readonly breakoutConfluenceScore: number;
  readonly flags: readonly AvwapDegradationFlag[];
}

export type InstitutionalAvwapMarkdownInput = UsOptionsAvwapContextExportPayload & {
  readonly confluenceSummary?: InstitutionalAvwapConfluenceSummary | null;
};

export interface InstitutionalAvwapDtoLike {
  readonly role: AvwapEmpiricalRole;
  readonly bounceConfluenceScore: number | null;
  readonly breakoutConfluenceScore: number | null;
  readonly gammaRegime: AvwapGammaRegime;
  readonly volRegime: AvwapVolRegime;
  readonly hazardFlags: readonly AvwapDegradationFlag[];
  readonly flags: readonly AvwapDegradationFlag[];
}

/**
 * Adapts a serialized `InstitutionalAvwapConfluenceContextDto` from the market snapshot
 * into the compact export payload expected by `renderInstitutionalAvwapContextMarkdown`.
 */
export function toInstitutionalAvwapMarkdownInput(
  dto: InstitutionalAvwapDtoLike | InstitutionalAvwapMarkdownInput | null | undefined,
  barsTimeframe: '15m' | '1h' | null,
): InstitutionalAvwapMarkdownInput | undefined {
  if (dto === null || dto === undefined) {
    return undefined;
  }
  if ('activeAnchors' in dto) {
    return dto;
  }
  const mergedFlags = Array.from(new Set<AvwapDegradationFlag>([...dto.flags, ...dto.hazardFlags]));
  const timeframe: AvwapTimeframe =
    barsTimeframe === '15m' ? '15m' : barsTimeframe === '1h' ? '1H' : '1D';
  return {
    role: dto.role,
    policyVersion: DEFAULT_AVWAP_CONTEXT_POLICY.policyVersion,
    timeframe,
    activeAnchors: [],
    opexResetMarkerDates: [],
    degradationFlags: mergedFlags,
    confluenceSummary: {
      gammaRegime: dto.gammaRegime,
      volRegime: dto.volRegime,
      bounceConfluenceScore: dto.bounceConfluenceScore ?? Number.NaN,
      breakoutConfluenceScore: dto.breakoutConfluenceScore ?? Number.NaN,
      flags: mergedFlags,
    },
  };
}

function formatFinite(value: number, decimals: number): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : '—';
}

function formatAnchorRow(anchor: InstitutionalAvwapAnchor): string {
  const mu = formatFinite(anchor.moments.mean, 2);
  const dist = `${formatFinite(anchor.distanceToSpotAtr, 2)} ATR`;
  const iass = formatFinite(anchor.iass.scoreConservative, 1);
  return `| \`${anchor.anchorId}\` | ${anchor.family} | ${mu} | ${dist} | ${iass} | ${anchor.lifecycleState} |`;
}

/**
 * Renders the compact `### Institutional AVWAP Context` Markdown section for options snapshots.
 * Backward compatible: returns `''` when `payload` is `undefined` or `null`.
 */
export function renderInstitutionalAvwapContextMarkdown(
  payload: InstitutionalAvwapMarkdownInput | null | undefined,
): string {
  if (payload === undefined || payload === null) {
    return '';
  }

  const primary =
    payload.activeAnchors.find((a) => a.visibleOnChart) ??
    payload.activeAnchors[0];
  const confluence = primary?.confluence ?? payload.confluenceSummary ?? null;

  const lines: string[] = [
    '### Institutional AVWAP Context',
    '',
    `- **Role:** Context Only (\`${payload.role}\`) · **Timeframe:** \`${payload.timeframe}\` · **Policy:** \`${payload.policyVersion}\``,
  ];

  if (confluence !== null) {
    const hazardAlert = confluence.flags.includes('SHORT_GAMMA_BOUNCE_HAZARD')
      ? ' · **ALERT: `SHORT_GAMMA_BOUNCE_HAZARD`**'
      : '';
    lines.push(
      `- **Regime:** \`${confluence.gammaRegime}\` / \`${confluence.volRegime}\`${hazardAlert}`,
      `- **Confluence Scores:** Bounce \`${formatFinite(confluence.bounceConfluenceScore, 1)}\` vs Breakout \`${formatFinite(confluence.breakoutConfluenceScore, 1)}\``,
    );
  } else {
    lines.push('- **Regime:** Unavailable (no active eligible anchors)');
  }

  if (payload.activeAnchors.length > 0) {
    lines.push(
      '',
      '| Anchor | Family | AVWAP | Dist (ATR) | IASS | Lifecycle |',
      '| --- | --- | --- | --- | --- | --- |',
      ...payload.activeAnchors.slice(0, 4).map(formatAnchorRow),
    );
  }

  const flagText =
    payload.degradationFlags.length > 0
      ? payload.degradationFlags.map((f) => `\`${f}\``).join(', ')
      : '`NONE`';
  lines.push('', `- **Degradation Flags:** ${flagText}`);

  return lines.join('\n');
}
