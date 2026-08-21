import { parseHexRgb } from '../ui/hexColor';

/** Maps normalized status names (lowercase) to default column dot colors (same as board panel CSS). */
const DEFAULT_HEX_BY_NORMALIZED: Record<string, string> = {
  backlog: '#2ea043',
  'to do': '#1f6feb',
  todo: '#1f6feb',
  'in progress': '#d18616',
  blocked: '#d1242f',
  done: '#2ea043'
};

/** Fallback for statuses with no default and no configured colour. */
const NEUTRAL_HEX = '#8b949e';

export function normalizeStatusNameKey(statusName: string): string {
  return statusName.trim().toLowerCase();
}

export function defaultStatusDotHex(statusName: string): string {
  const key = normalizeStatusNameKey(statusName);
  return DEFAULT_HEX_BY_NORMALIZED[key] ?? NEUTRAL_HEX;
}

export function resolveStatusDotColor(
  statusName: string,
  customByStatus?: Record<string, string>
): string {
  const custom = customByStatus?.[statusName]?.trim();
  if (custom && parseHexRgb(custom)) {
    const rgb = parseHexRgb(custom)!;
    return `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;
  }
  return defaultStatusDotHex(statusName);
}

/**
 * Text colour for a flat (Jira-style) board column label — a tinted hint of the
 * configured status colour rather than a filled pill.
 *
 * Unlike the dot/pill treatments, this hex is used as 11px text directly on the
 * column background, so a colour that reads fine as a filled swatch can become
 * illegible as type. `legibleLabelHex` decides that policy.
 */
export function statusLabelInlineStyle(
  statusName: string,
  customByStatus?: Record<string, string>
): string {
  const hex = resolveStatusDotColor(statusName, customByStatus);
  return `color: ${legibleLabelHex(hex)};`;
}

/**
 * Luminance band left untouched. Chosen so every colour in
 * DEFAULT_HEX_BY_NORMALIZED passes through unchanged (the darkest, #d1242f, sits
 * at ~0.349); only user-picked extremes are pulled in.
 */
const MIN_LABEL_LUMINANCE = 0.34;
const MAX_LABEL_LUMINANCE = 0.74;

/** Perceived brightness, 0 (black) to 1 (white). */
function perceivedLuminance(rgb: { r: number; g: number; b: number }): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/**
 * Adjust a status hex so it stays readable as small uppercase text on the column
 * background, in both light and dark themes.
 *
 * Colours inside the mid-tone band are returned verbatim — a deliberate choice
 * stays a deliberate choice. Only the extremes are scaled toward the nearest
 * edge of the band, multiplying all three channels by a single factor so the hue
 * survives even though the brightness moves.
 */
function legibleLabelHex(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) {
    return 'var(--vscode-descriptionForeground)';
  }

  const luminance = perceivedLuminance(rgb);

  // Near-black has no hue to preserve; scaling it would divide by ~zero.
  if (luminance < 0.02) {
    return NEUTRAL_HEX;
  }

  const target = Math.min(Math.max(luminance, MIN_LABEL_LUMINANCE), MAX_LABEL_LUMINANCE);
  if (target === luminance) {
    return hex;
  }

  const factor = target / luminance;
  const scale = (channel: number): string =>
    Math.round(Math.min(255, Math.max(0, channel * factor)))
      .toString(16)
      .padStart(2, '0');

  return `#${scale(rgb.r)}${scale(rgb.g)}${scale(rgb.b)}`;
}

export function sanitizeStatusColors(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [status, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!status.trim()) {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const t = value.trim();
    if (parseHexRgb(t)) {
      out[status] = t;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
