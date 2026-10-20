/**
 * Wall-clock <-> instant conversion for a schedule's start time (FX-BE-147 /
 * TASK-383).
 *
 * The schedule stores one absolute instant; the editor works in a date, a time
 * and a zone. Converting between them is where daylight saving bites, so both
 * directions are explicit about the two awkward cases:
 *
 * - a wall time that **does not exist** (clocks go forward) has no instant, and
 *   `zonedTimeToInstant` says so with `undefined` rather than guessing;
 * - a wall time that **happens twice** (clocks go back) resolves to the first
 *   occurrence, the one a person who typed "01:30" would reach first.
 *
 * The renderer cannot import core values, so `renderer/src/schedule/zonedTime.ts`
 * carries a copy of these two functions; the tests here are the reference.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export interface ZonedParts {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:mm`, 24-hour */
  time: string;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function wallParts(utcMs: number, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** How far `timezone` is ahead of UTC at that instant, in ms. */
function offsetMs(utcMs: number, timezone: string): number {
  const p = wallParts(utcMs, timezone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000;
}

export function instantToZonedParts(instant: string, timezone: string): ZonedParts | undefined {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return undefined;
  try {
    const p = wallParts(ms, timezone);
    return { date: `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}` };
  } catch {
    return undefined;
  }
}

/** The ISO instant for a wall-clock date and time in `timezone`, or `undefined` if it is invalid or does not exist. */
export function zonedTimeToInstant(date: string, time: string, timezone: string): string | undefined {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return undefined;
  const [y, mo, day, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59) return undefined;

  const asIfUtc = Date.UTC(y, mo - 1, day, h, mi);
  // Reject 31 Feb and friends: Date.UTC rolls over, so the parts will not match.
  const check = new Date(asIfUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== day) return undefined;

  try {
    // The zone's offset a day either side brackets any change that could land on this wall time.
    const DAY = 24 * 60 * 60 * 1000;
    const candidates = new Set([asIfUtc - offsetMs(asIfUtc - DAY, timezone), asIfUtc - offsetMs(asIfUtc + DAY, timezone)]);
    const valid = [...candidates]
      .filter(ms => {
        const p = wallParts(ms, timezone);
        return p.y === y && p.mo === mo && p.d === day && p.h === h && p.mi === mi;
      })
      .sort((a, b) => a - b);
    return valid.length > 0 ? new Date(valid[0]).toISOString() : undefined;
  } catch {
    return undefined;
  }
}
