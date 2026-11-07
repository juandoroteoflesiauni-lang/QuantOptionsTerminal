/**
 * Formato único de barra del proyecto (AGENTS.md y SPEC punto 8).
 *
 * `time` es el instante de APERTURA de la barra, en segundos UTC enteros.
 * Nunca se mezclan milisegundos.
 */
export interface Bar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /**
   * VWAP de las operaciones de la barra: sum(precio * volumen) / volumen.
   *
   * Puede faltar, ser 0 o no ser finito. El VWAP de sesión lo trata como
   * ausente y usa (H+L+C)/3 solo para esa barra, tal como exige el SPEC.
   */
  readonly vw?: number;
}
