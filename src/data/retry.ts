/**
 * Ayudas puras para el ritmo y el reintento de peticiones del cargador.
 *
 * `parseRetryAfterSeconds` interpreta la cabecera `Retry-After` (RFC 7231):
 * segundos enteros o decimales con signo opcional, o fecha HTTP; devuelve
 * null cuando falta, no es interpretable o no impone una espera positiva.
 * `retryDelayMs` decide la espera de un reintento: si hay `Retry-After`
 * positivo manda él (segundos × 1000); si no, un backoff exponencial
 * `baseDelayMs × 2^attempt`. Toda espera se recorta a `maxDelayMs`.
 *
 * La espera real la ejecuta el sleep inyectable del cargador; aquí solo hay
 * matemática pura, verificada contra la referencia independiente de Python
 * (`tools/gen_retry_reference.py`, fixture `fixtures/retry_reference.json`).
 */

/**
 * Segundos de espera de una cabecera `Retry-After`, o null cuando falta,
 * no es interpretable o no impone una espera positiva.
 */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  nowMs: number,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const whenMs = Date.parse(trimmed);
  if (Number.isNaN(whenMs)) {
    return null;
  }
  const seconds = (whenMs - nowMs) / 1_000;
  return seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Espera en ms de un reintento: `Retry-After` si es positivo, si no un
 * backoff exponencial `baseDelayMs × 2^attempt`; recortada a `maxDelayMs`.
 */
export function retryDelayMs(input: {
  readonly attempt: number;
  readonly retryAfterSeconds: number | null | undefined;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}): number {
  const { attempt, retryAfterSeconds, baseDelayMs, maxDelayMs } = input;
  const hasRetryAfter =
    retryAfterSeconds !== null &&
    retryAfterSeconds !== undefined &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0;
  const rawMs = hasRetryAfter
    ? retryAfterSeconds * 1_000
    : baseDelayMs * 2 ** attempt;
  return Math.min(rawMs, maxDelayMs);
}
