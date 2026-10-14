/** Small display formatters shared across SuperHeng screens. */

import type { Language } from '@/lib/i18n';

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

/** "12 Oct 2026" — the Gregorian form every non-Thai locale uses here. */
function formatEnglishDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Formats an ISO date as a compact "12 Oct 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatEnglishDate(date);
}

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

/** Years between the Buddhist Era and the Gregorian calendar. */
const BUDDHIST_ERA_OFFSET = 543;

/**
 * Formats a date in Thai with a Buddhist Era year: `16 ตุลาคม 2569`.
 *
 * Month names are held as literal strings rather than delegated to
 * `Intl`/`toLocaleDateString('th-TH-u-ca-buddhist')` because Hermes ships
 * without full ICU data on some platforms — an Intl version would look correct
 * on web while silently falling back to Gregorian + English on device.
 */
export function formatThaiDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const month = THAI_MONTHS[date.getMonth()];
  return `${date.getDate()} ${month} ${date.getFullYear() + BUDDHIST_ERA_OFFSET}`;
}

/**
 * Formats a date for the language currently in use.
 *
 * This is the one to reach for in screens: English reads "16 Oct 2026" while Thai
 * reads "16 ตุลาคม 2569" — the same day, in the Buddhist Era and with Thai month
 * names. A date is locale data, not a string to translate, so it is formatted here
 * rather than run through the dictionary.
 *
 * Accepts an ISO string or a `Date` so call sites do not have to convert, and
 * returns the input unchanged if it cannot be parsed — the same tolerant behaviour
 * as `formatDate`.
 */
export function formatLocalizedDate(value: string | Date, language: Language): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  return language === 'th' ? formatThaiDate(date) : formatEnglishDate(date);
}
