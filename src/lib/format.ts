/** Small display formatters shared across SuperHeng screens. */

/** Formats an integer with thousands separators (1234 -> "1,234"). */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Formats a 0-1 ratio as a percentage ("0.924" -> "92.4%"). */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Formats a signed delta with an explicit + / - ("+2.4", "-1.1"). */
export function formatDelta(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

/** Formats an ISO date as a compact "12 Oct 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Relative "3 Days ago" style label. */
export function formatRelativeDays(daysAgo: number): string {
  if (daysAgo <= 0) return 'Today';
  if (daysAgo === 1) return '1 day ago';
  return `${daysAgo} days ago`;
}
