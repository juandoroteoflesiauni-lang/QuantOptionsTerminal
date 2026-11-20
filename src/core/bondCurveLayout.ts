/**
 * Pieza 44 — Motor puro de anti-colisión determinística para etiquetas de la curva soberana.
 *
 * Funciones puras en TypeScript: sin DOM, sin red, sin mutación de argumentos.
 * Detecta colisiones 2D en coordenadas SVG entre cajas de texto y marcadores de puntos,
 * reubicando cada etiqueta sobre un conjunto ordenado de desplazamientos con línea guía sutil.
 */

export interface CurveLabelInputPoint {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

export interface CurveLabelBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface CurveLabelLayoutOptions {
  readonly bounds?: CurveLabelBounds;
  readonly pointRadius?: number;
  readonly charWidthPx?: number;
  readonly labelHeightPx?: number;
  readonly paddingPx?: number;
  readonly leaderThresholdPx?: number;
}

export type CurveLabelTextAnchor = 'start' | 'middle' | 'end';

export interface CurveLabelBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface CurveLabelPlacement {
  readonly id: string;
  readonly label: string;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly labelX: number;
  readonly labelY: number;
  readonly textAnchor: CurveLabelTextAnchor;
  readonly box: CurveLabelBox;
  readonly needsLeader: boolean;
  readonly leaderEndX: number;
  readonly leaderEndY: number;
  readonly overlapCount: number;
}

interface CandidateOffset {
  readonly dx: number;
  readonly dy: number;
  readonly textAnchor: CurveLabelTextAnchor;
}

const DEFAULT_BOUNDS: CurveLabelBounds = {
  minX: 40,
  maxX: 554,
  minY: 10,
  maxY: 192,
};

const CANDIDATE_OFFSETS: readonly CandidateOffset[] = [
  // Anillo 1: arriba/abajo/costados inmediatos (sin línea guía)
  { dx: 0, dy: -11, textAnchor: 'middle' },
  { dx: 0, dy: 17, textAnchor: 'middle' },
  { dx: 10, dy: 3, textAnchor: 'start' },
  { dx: -10, dy: 3, textAnchor: 'end' },
  // Anillo 2: diagonales cercanas y escalón vertical
  { dx: 12, dy: -13, textAnchor: 'start' },
  { dx: -12, dy: -13, textAnchor: 'end' },
  { dx: 12, dy: 19, textAnchor: 'start' },
  { dx: -12, dy: 19, textAnchor: 'end' },
  { dx: 0, dy: -25, textAnchor: 'middle' },
  { dx: 0, dy: 31, textAnchor: 'middle' },
  // Anillo 3: desplazamiento medio con línea guía
  { dx: 18, dy: -22, textAnchor: 'start' },
  { dx: -18, dy: -22, textAnchor: 'end' },
  { dx: 18, dy: 28, textAnchor: 'start' },
  { dx: -18, dy: 28, textAnchor: 'end' },
  { dx: 0, dy: -39, textAnchor: 'middle' },
  { dx: 0, dy: 45, textAnchor: 'middle' },
  { dx: 30, dy: -14, textAnchor: 'start' },
  { dx: -30, dy: -14, textAnchor: 'end' },
  { dx: 30, dy: 20, textAnchor: 'start' },
  { dx: -30, dy: 20, textAnchor: 'end' },
  // Anillo 4: escalón amplio para clústeres densos (AE38 / AL35 / GD35 / AL41)
  { dx: 34, dy: -32, textAnchor: 'start' },
  { dx: -34, dy: -32, textAnchor: 'end' },
  { dx: 34, dy: 38, textAnchor: 'start' },
  { dx: -34, dy: 38, textAnchor: 'end' },
  { dx: 0, dy: -53, textAnchor: 'middle' },
  { dx: 0, dy: 59, textAnchor: 'middle' },
  { dx: 48, dy: -22, textAnchor: 'start' },
  { dx: -48, dy: -22, textAnchor: 'end' },
  { dx: 48, dy: 28, textAnchor: 'start' },
  { dx: -48, dy: 28, textAnchor: 'end' },
  { dx: 0, dy: -67, textAnchor: 'middle' },
  { dx: 0, dy: 73, textAnchor: 'middle' },
];

export function computeLabelBox(
  labelX: number,
  labelY: number,
  textAnchor: CurveLabelTextAnchor,
  labelLength: number,
  charWidthPx: number,
  labelHeightPx: number,
): CurveLabelBox {
  const width = Math.max(8, labelLength * charWidthPx + 4);
  let left = labelX;
  let right = labelX + width;
  if (textAnchor === 'middle') {
    left = labelX - width / 2;
    right = labelX + width / 2;
  } else if (textAnchor === 'end') {
    left = labelX - width;
    right = labelX;
  }
  return {
    left,
    top: labelY - labelHeightPx,
    right,
    bottom: labelY + 2,
  };
}

export function boxesOverlap(a: CurveLabelBox, b: CurveLabelBox, paddingPx = 0): boolean {
  return (
    a.left < b.right + paddingPx &&
    a.right + paddingPx > b.left &&
    a.top < b.bottom + paddingPx &&
    a.bottom + paddingPx > b.top
  );
}

function overlapArea(a: CurveLabelBox, b: CurveLabelBox, paddingPx = 0): number {
  const ox = Math.max(0, Math.min(a.right + paddingPx, b.right + paddingPx) - Math.max(a.left, b.left));
  const oy = Math.max(0, Math.min(a.bottom + paddingPx, b.bottom + paddingPx) - Math.max(a.top, b.top));
  return ox * oy;
}

/**
 * Calcula posiciones determinísticas sin superposición para las etiquetas de la curva de bonos.
 */
export function layoutCurveLabels(
  points: readonly CurveLabelInputPoint[],
  options: CurveLabelLayoutOptions = {},
): readonly CurveLabelPlacement[] {
  const bounds = options.bounds ?? DEFAULT_BOUNDS;
  const pointRadius = options.pointRadius ?? 6.5;
  const charWidthPx = options.charWidthPx ?? 6.0;
  const labelHeightPx = options.labelHeightPx ?? 12;
  const paddingPx = options.paddingPx ?? 2.5;
  const leaderThresholdPx = options.leaderThresholdPx ?? 14;

  const validPoints = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .slice()
    .sort((a, b) => {
      if (a.x !== b.x) return a.x - b.x;
      if (a.y !== b.y) return a.y - b.y;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const markerBoxes: CurveLabelBox[] = validPoints.map((p) => ({
    left: p.x - pointRadius,
    top: p.y - pointRadius,
    right: p.x + pointRadius,
    bottom: p.y + pointRadius,
  }));

  const placedBoxes: CurveLabelBox[] = [];
  const placements: CurveLabelPlacement[] = [];

  for (const pt of validPoints) {
    let bestScore:
      | {
          readonly oob: number;
          readonly labelOverlaps: number;
          readonly markerOverlaps: number;
          readonly overlapAreaSum: number;
          readonly distance: number;
          readonly candidateIdx: number;
          readonly labelX: number;
          readonly labelY: number;
          readonly textAnchor: CurveLabelTextAnchor;
          readonly box: CurveLabelBox;
        }
      | null = null;

    for (let idx = 0; idx < CANDIDATE_OFFSETS.length; idx += 1) {
      const cand = CANDIDATE_OFFSETS[idx];
      if (cand === undefined) continue;
      const labelX = pt.x + cand.dx;
      const labelY = pt.y + cand.dy;
      const box = computeLabelBox(
        labelX,
        labelY,
        cand.textAnchor,
        pt.label.length,
        charWidthPx,
        labelHeightPx,
      );

      const oob =
        box.left < bounds.minX ||
        box.right > bounds.maxX ||
        box.top < bounds.minY ||
        box.bottom > bounds.maxY
          ? 1
          : 0;

      let labelOverlaps = 0;
      let overlapAreaSum = 0;
      for (const prevBox of placedBoxes) {
        if (boxesOverlap(box, prevBox, paddingPx)) {
          labelOverlaps += 1;
          overlapAreaSum += overlapArea(box, prevBox, paddingPx);
        }
      }

      let markerOverlaps = 0;
      for (const markerBox of markerBoxes) {
        if (boxesOverlap(box, markerBox, 1)) {
          markerOverlaps += 1;
          overlapAreaSum += overlapArea(box, markerBox, 1);
        }
      }

      const distance = Math.hypot(cand.dx, cand.dy);
      const isBetter =
        bestScore === null ||
        oob < bestScore.oob ||
        (oob === bestScore.oob && labelOverlaps < bestScore.labelOverlaps) ||
        (oob === bestScore.oob &&
          labelOverlaps === bestScore.labelOverlaps &&
          markerOverlaps < bestScore.markerOverlaps) ||
        (oob === bestScore.oob &&
          labelOverlaps === bestScore.labelOverlaps &&
          markerOverlaps === bestScore.markerOverlaps &&
          overlapAreaSum < bestScore.overlapAreaSum - 1e-9) ||
        (oob === bestScore.oob &&
          labelOverlaps === bestScore.labelOverlaps &&
          markerOverlaps === bestScore.markerOverlaps &&
          Math.abs(overlapAreaSum - bestScore.overlapAreaSum) <= 1e-9 &&
          distance < bestScore.distance - 1e-9);

      if (isBetter) {
        bestScore = {
          oob,
          labelOverlaps,
          markerOverlaps,
          overlapAreaSum,
          distance,
          candidateIdx: idx,
          labelX,
          labelY,
          textAnchor: cand.textAnchor,
          box,
        };
      }
    }

    const chosen = bestScore ?? {
      oob: 0,
      labelOverlaps: 0,
      markerOverlaps: 0,
      overlapAreaSum: 0,
      distance: 11,
      candidateIdx: 0,
      labelX: pt.x,
      labelY: pt.y - 11,
      textAnchor: 'middle' as const,
      box: computeLabelBox(pt.x, pt.y - 11, 'middle', pt.label.length, charWidthPx, labelHeightPx),
    };

    placedBoxes.push(chosen.box);
    const needsLeader = chosen.distance > leaderThresholdPx;
    const leaderEndX = Math.max(chosen.box.left, Math.min(chosen.box.right, pt.x));
    const leaderEndY = Math.max(chosen.box.top, Math.min(chosen.box.bottom, pt.y));

    placements.push({
      id: pt.id,
      label: pt.label,
      anchorX: pt.x,
      anchorY: pt.y,
      labelX: chosen.labelX,
      labelY: chosen.labelY,
      textAnchor: chosen.textAnchor,
      box: chosen.box,
      needsLeader,
      leaderEndX,
      leaderEndY,
      overlapCount: chosen.labelOverlaps,
    });
  }

  return placements;
}
