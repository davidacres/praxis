/** Split Codex CLI thought chunks that are formatted as separate status updates. */
export function parseCodexActivityUpdates(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map(update => update.trim())
    .filter(Boolean)
    .map(update => update
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^__(.+)__$/, '$1')
      .replace(/^\*(.+)\*$/, '$1')
      .replace(/^_(.+)_$/, '$1')
      .trim())
    .filter(Boolean);
}

export function latestCodexActivity(text: string): string | undefined {
  return parseCodexActivityUpdates(text).at(-1);
}
