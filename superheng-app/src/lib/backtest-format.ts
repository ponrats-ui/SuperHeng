/**
 * Number formatting shared by every backtest surface.
 *
 * Extracted rather than duplicated: the "—" rule in `percent` is load-bearing (see
 * below), and two copies of it would eventually disagree — putting a `0.0%` on one
 * screen and an em dash on another for the same missing rate.
 */

/**
 * One decimal percentage, or an em dash when the backend sent no rate.
 *
 * Never `0.0%`: a missing rate means nothing was scored, and printing zero would
 * read as a model that scored nothing right. That distinction is the whole point
 * of the backtest, so it survives into the formatting.
 */
export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}%`;
}

/** A signed percentage, for ROI, where the sign is the message. */
export function signedPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** A p-value: three decimals, or `< 0.001` rather than a misleading `0.000`. */
export function formatP(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.001) return '< 0.001';
  return value.toFixed(3);
}
