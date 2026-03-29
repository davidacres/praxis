import { buildMetaPillInlineStyle, parseHexRgb } from '../ui/hexColor';

/** Maps normalized status names (lowercase) to default column dot colors (same as board panel CSS). */
const DEFAULT_HEX_BY_NORMALIZED: Record<string, string> = {
  backlog: '#2ea043',
  'to do': '#1f6feb',
  todo: '#1f6feb',
  'in progress': '#d18616',
  blocked: '#d1242f',
  done: '#2ea043'
};

export function normalizeStatusNameKey(statusName: string): string {
  return statusName.trim().toLowerCase();
}

export function defaultStatusDotHex(statusName: string): string {
  const key = normalizeStatusNameKey(statusName);
  return DEFAULT_HEX_BY_NORMALIZED[key] ?? '#8b949e';
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

/** Inline CSS for a status pill using the same hex as column dots and card status indicators. */
export function statusPillInlineStyle(
  statusName: string,
  customByStatus?: Record<string, string>
): string {
  const hex = resolveStatusDotColor(statusName, customByStatus);
  return buildMetaPillInlineStyle(hex) ?? 'color: var(--vscode-editor-foreground);';
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
