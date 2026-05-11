import { buildMetaPillInlineStyle } from '../ui/hexColor';

const KNOWN_HEX: Record<string, string> = {
  bug: '#e5534b',
  story: '#3fb950',
  task: '#58a6ff',
  epic: '#a371f7',
  feature: '#3fbccd',
  idea: '#f59e0b',
  subtask: '#8b949e',
  'sub-task': '#8b949e',
  improvement: '#79c0ff',
  spike: '#d29922'
};

const FALLBACK = ['#58a6ff', '#a371f7', '#3fbccd', '#d29922', '#79c0ff', '#ff7b72', '#56d364', '#db61a2'];

function hashPick(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  return FALLBACK[h % FALLBACK.length];
}

export function issueTypeHex(issueType: string): string {
  const key = issueType.trim().toLowerCase();
  return KNOWN_HEX[key] ?? hashPick(issueType);
}

/** Inline CSS for a tinted issue-type pill (same pattern as project/meta pills). */
export function issueTypePillInlineStyle(issueType: string): string {
  return buildMetaPillInlineStyle(issueTypeHex(issueType)) ?? 'color: var(--vscode-editor-foreground);';
}
