/**
 * Funciones matemáticas puras de alta precisión sin dependencias externas (Pieza 2).
 *
 * Implementa la función error complementaria `erfc` mediante las aproximaciones
 * racionales de Chebyshev de W. J. Cody (1969), logrando ~15 dígitos decimales
 * en toda la recta real, incluida la cola profunda donde `normCdf(x)` debe
 * evitar cancelación catastrófica (`0.5 * erfc(-x / sqrt(2))`).
 */

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
const INV_SQRT_2 = Math.SQRT1_2;
const SQRPI = 1 / Math.sqrt(Math.PI);
const THRESH = 0.46875;
const XBIG = 26.543;

// Coeficientes de Cody (1969) para |x| <= 0.46875 (exact IEEE-754 shortest decimal form)
const A_COEFFS: readonly [number, number, number, number, number] = [
  3.1611237438705655,
  113.86415415105016,
  377.485237685302,
  3209.3775891384694,
  0.18577770618460315,
];

const B_COEFFS: readonly [number, number, number, number] = [
  23.601290952344122,
  244.02463793444417,
  1282.6165260773723,
  2844.236833439171,
];

// Coeficientes de Cody (1969) para 0.46875 < |x| <= 4.0
const C_COEFFS: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] = [
  0.5641884969886701,
  8.883149794388377,
  66.11919063714163,
  298.6351381974001,
  881.952221241769,
  1712.0476126340707,
  2051.0783778260716,
  1230.3393547979972,
  2.1531153547440383e-8,
];

const D_COEFFS: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] = [
  15.744926110709835,
  117.6939508913125,
  537.1811018620099,
  1621.3895745666903,
  3290.7992357334597,
  4362.619090143247,
  3439.3676741437216,
  1230.3393548037495,
];

// Coeficientes de Cody (1969) para |x| > 4.0
const P_COEFFS: readonly [number, number, number, number, number, number] = [
  0.30532663496123236,
  0.36034489994980445,
  0.12578172611122926,
  0.016083785148742275,
  0.0006587491615298378,
  0.016315387137302097,
];

const Q_COEFFS: readonly [number, number, number, number, number] = [
  2.568520192289822,
  1.8729528499234604,
  0.5279051029514285,
  0.06051834131244132,
  0.0023352049762686918,
];

/**
 * Función error complementaria `erfc(x) = 2/sqrt(pi) * integral_x^inf exp(-t^2) dt`.
 */
export function erfcCody(x: number): number {
  if (Number.isNaN(x)) {
    return Number.NaN;
  }
  const y = Math.abs(x);

  let result: number;
  if (y <= THRESH) {
    const ysq = y > 1e-10 ? y * y : 0;
    let xnum = A_COEFFS[4] * ysq;
    let xden = ysq;
    for (let i = 0; i < 3; i += 1) {
      xnum = (xnum + (A_COEFFS[i] ?? 0)) * ysq;
      xden = (xden + (B_COEFFS[i] ?? 0)) * ysq;
    }
    const erfVal = (x * (xnum + A_COEFFS[3])) / (xden + B_COEFFS[3]);
    return 1 - erfVal;
  } else if (y <= 4.0) {
    let xnum = C_COEFFS[8] * y;
    let xden = y;
    for (let i = 0; i < 7; i += 1) {
      xnum = (xnum + (C_COEFFS[i] ?? 0)) * y;
      xden = (xden + (D_COEFFS[i] ?? 0)) * y;
    }
    result = (xnum + C_COEFFS[7]) / (xden + D_COEFFS[7]);
    const xsq = Math.trunc(y * 16) / 16;
    const del = (y - xsq) * (y + xsq);
    result *= Math.exp(-xsq * xsq) * Math.exp(-del);
  } else {
    if (y >= XBIG) {
      return x < 0 ? 2 : 0;
    }
    const ysq = 1 / (y * y);
    let xnum = P_COEFFS[5] * ysq;
    let xden = ysq;
    for (let i = 0; i < 4; i += 1) {
      xnum = (xnum + (P_COEFFS[i] ?? 0)) * ysq;
      xden = (xden + (Q_COEFFS[i] ?? 0)) * ysq;
    }
    result = (ysq * (xnum + P_COEFFS[4])) / (xden + Q_COEFFS[4]);
    result = (SQRPI - result) / y;
    const xsq = Math.trunc(y * 16) / 16;
    const del = (y - xsq) * (y + xsq);
    result *= Math.exp(-xsq * xsq) * Math.exp(-del);
  }

  if (x < 0) {
    return 2 - result;
  }
  return result;
}

/** Función de densidad normal estándar `phi(x) = exp(-x^2 / 2) / sqrt(2 * pi)`. */
export function normPdf(x: number): number {
  if (Number.isNaN(x)) {
    return Number.NaN;
  }
  if (!Number.isFinite(x)) {
    return 0;
  }
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/** Función de distribución acumulada normal estándar `Phi(x)`. */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) {
    return Number.NaN;
  }
  if (x === Number.POSITIVE_INFINITY) {
    return 1;
  }
  if (x === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  return 0.5 * erfcCody(-x * INV_SQRT_2);
}
