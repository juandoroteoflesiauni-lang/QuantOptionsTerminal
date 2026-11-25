import type {
  InstitutionalAvwapAnchor,
  UsOptionsAvwapContextExportPayload,
} from '../../core/avwap/index.js';

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
 * Backward compatible: returns `''` when `payload` is `undefined`.
 */
export function renderInstitutionalAvwapContextMarkdown(
  payload: UsOptionsAvwapContextExportPayload | undefined,
): string {
  if (payload === undefined) {
    return '';
  }

  const primary =
    payload.activeAnchors.find((a) => a.visibleOnChart) ??
    payload.activeAnchors[0];

  const lines: string[] = [
    '### Institutional AVWAP Context',
    '',
    `- **Role:** Context Only (\`${payload.role}\`) · **Timeframe:** \`${payload.timeframe}\` · **Policy:** \`${payload.policyVersion}\``,
  ];

  if (primary !== undefined) {
    const hazardAlert = primary.confluence.flags.includes('SHORT_GAMMA_BOUNCE_HAZARD')
      ? ' · **ALERT: `SHORT_GAMMA_BOUNCE_HAZARD`**'
      : '';
    lines.push(
      `- **Regime:** \`${primary.confluence.gammaRegime}\` / \`${primary.confluence.volRegime}\`${hazardAlert}`,
      `- **Confluence Scores:** Bounce \`${formatFinite(primary.confluence.bounceConfluenceScore, 1)}\` vs Breakout \`${formatFinite(primary.confluence.breakoutConfluenceScore, 1)}\``,
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
