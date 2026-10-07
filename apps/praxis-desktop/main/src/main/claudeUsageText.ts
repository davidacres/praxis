import type { ProviderUsageWindow } from '@praxis/core';

/**
 * Parser for the plan-usage lines Claude Code prints for `/usage`, e.g.
 *
 *   Current session: 23% used · resets Oct 7 at 4am (Europe/London)
 *   Current week (all models): 35% used · resets Oct 7 at 9am (Europe/London)
 *
 * Kept free of `electron` so `node --test` can load it. The CLI is the only
 * source: Praxis never touches the login token, it asks the CLI to say it.
 */

const LINE = /^\s*Current (session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets?\s+(.+?))?\s*$/i;
const RESET = /^(?:(?<month>[A-Za-z]{3,9})\s+(?<day>\d{1,2})\s*(?:,?\s*at\s+)?)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)\s*(?:\((?<zone>[^)]+)\))?\s*$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function zoneParts(instant: number, zone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(new Date(instant));
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}

/** The instant at which `zone`'s wall clock reads the given date and time. */
function wallClockToInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = asUtc;
  // Two passes settle the offset across a daylight-saving boundary.
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zoneParts(instant, zone);
    const shown = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    instant += asUtc - shown;
  }
  return instant;
}

/** A reset such as "Oct 7 at 4am (Europe/London)" as an ISO instant, or undefined if it does not parse. */
export function parseClaudeReset(text: string, now: number): string | undefined {
  const match = RESET.exec(text.trim());
  if (!match?.groups) return undefined;
  const { month, day, hour, minute, meridiem, zone } = match.groups;
  try {
    let hours = Number(hour) % 12;
    if (meridiem.toLowerCase() === 'pm') hours += 12;
    const today = zoneParts(now, zone);
    let instant: number;
    if (month) {
      const monthIndex = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
      if (monthIndex < 0) return undefined;
      instant = wallClockToInstant(today.year, monthIndex + 1, Number(day), hours, Number(minute ?? 0), zone);
      // A date earlier than now means the next year's occurrence (a late-December read of "Jan 2").
      if (instant < now - 24 * 3600 * 1000) instant = wallClockToInstant(today.year + 1, monthIndex + 1, Number(day), hours, Number(minute ?? 0), zone);
    } else {
      instant = wallClockToInstant(today.year, today.month, today.day, hours, Number(minute ?? 0), zone);
      if (instant < now) instant += 24 * 3600 * 1000;
    }
    return new Date(instant).toISOString();
  } catch {
    // An unknown time zone name throws RangeError; the window is still useful without a reset.
    return undefined;
  }
}

/** Windows named in a `/usage` reply. Empty when the text is not a plan-usage report (API-key logins have none). */
export function parseClaudeUsageText(text: string, now: number = Date.now()): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, kind, qualifier, percent, reset] = match;
    const isSession = kind.toLowerCase() === 'session';
    const scope = qualifier?.trim();
    const allModels = !scope || /^all models$/i.test(scope);
    windows.push({
      period: isSession ? 'hour' : 'week',
      label: isSession ? '5-hour window' : allModels ? 'Weekly window' : `Weekly · ${scope.replace(/\s+only$/i, '')}`,
      usedPercent: Math.min(100, Math.round(Number(percent))),
      windowDurationMinutes: isSession ? 300 : 7 * 24 * 60,
      resetsAt: reset ? parseClaudeReset(reset, now) : undefined
    });
  }
  return windows;
}
