/**
 * Output-panel log filtering. Every whitespace-separated term must appear in
 * the line (case-insensitive), so `ai failed` finds `[ai] request failed`, and
 * the `[tag]` prefix is searchable like any other text.
 */
export function filterLogLines(lines: readonly string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...lines];
  return lines.filter(line => {
    const haystack = line.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
