import { buildMetaPillInlineStyle } from '../ui/hexColor';

const KNOWN_HEX: Record<string, string> = {
  bug: '#e5534b',
  story: '#3fb950',
  task: '#db61a2',
  epic: '#a371f7',
  feature: '#3fbccd',
  idea: '#f59e0b',
  subtask: '#db61a2',
  'sub-task': '#db61a2',
  improvement: '#79c0ff',
  spike: '#d29922'
};

const FALLBACK = ['#58a6ff', '#a371f7', '#3fbccd', '#d29922', '#79c0ff', '#ff7b72', '#56d364', '#db61a2'];

export function normalizeIssueTypeColorKey(issueType: string): string {
  const key = issueType.trim().toLowerCase();
  if (key === 'sub-task') {
    return 'subtask';
  }
  return key;
}

function hashPick(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  return FALLBACK[h % FALLBACK.length];
}

export function defaultIssueTypeHex(issueType: string): string {
  const key = normalizeIssueTypeColorKey(issueType);
  return KNOWN_HEX[key] ?? hashPick(issueType);
}

export function issueTypeHex(issueType: string, overrideColors?: Record<string, string>): string {
  const trimmed = issueType.trim();
  const override = overrideColors?.[trimmed] ?? overrideColors?.[normalizeIssueTypeColorKey(trimmed)];
  return override ?? defaultIssueTypeHex(trimmed);
}

export function sanitizeIssueTypeColors(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const sanitized: Record<string, string> = {};
  for (const [issueType, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmedType = issueType.trim();
    const trimmedValue = value.trim();
    if (!trimmedType || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmedValue)) {
      continue;
    }
    sanitized[normalizeIssueTypeColorKey(trimmedType)] = trimmedValue;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/** Inline CSS for a tinted issue-type pill (same pattern as project/meta pills). */
export function issueTypePillInlineStyle(issueType: string, overrideColors?: Record<string, string>): string {
  return buildMetaPillInlineStyle(issueTypeHex(issueType, overrideColors)) ?? 'color: var(--vscode-editor-foreground);';
}
