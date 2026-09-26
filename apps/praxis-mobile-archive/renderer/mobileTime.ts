/**
 * Times for people, without leaning on the JS engine's `Date` string parsing or
 * `Intl` — both are uneven on Hermes, where `toLocaleTimeString` rendered
 * "Invalid Date" for a pairing invitation's expiry.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Milliseconds since the epoch for an ISO-8601 instant, or undefined when it is not one. */
export function parseInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = ISO.exec(value.trim());
  if (!match) {
    const fallback = Date.parse(value);
    return Number.isFinite(fallback) ? fallback : undefined;
  }
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = match;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(frac.padEnd(3, '0').slice(0, 3)));
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return Number.isFinite(ms) ? ms : undefined;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "14:05" in the phone's local time; empty when the instant cannot be read. */
export function formatClock(value: string | undefined): string {
  const ms = parseInstant(value);
  if (ms === undefined) return '';
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Sep 23, 14:05" in the phone's local time; undefined when the instant cannot be read. */
export function formatDayAndClock(value: string | undefined): string | undefined {
  const ms = parseInstant(value);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
