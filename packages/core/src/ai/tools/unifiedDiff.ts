/**
 * Minimal unified-diff generator for reviewing agent file writes.
 *
 * Trims the common leading/trailing lines and emits the changed span as a single
 * hunk with a few lines of context. This is intentionally not a full Myers diff —
 * agent edits are almost always localized, and a one-hunk before/after view is
 * enough to review them without pulling in a diff dependency (the runtime `diff`
 * package in this repo is a types-less v7 transitive dev dep).
 */
export function createUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  context = 3
): string {
  if (before === after) {
    return '';
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let start = 0;
  const maxStart = Math.min(beforeLines.length, afterLines.length);
  while (start < maxStart && beforeLines[start] === afterLines[start]) {
    start += 1;
  }

  let endBefore = beforeLines.length;
  let endAfter = afterLines.length;
  while (
    endBefore > start &&
    endAfter > start &&
    beforeLines[endBefore - 1] === afterLines[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const ctxStart = Math.max(0, start - context);
  const ctxEndBefore = Math.min(beforeLines.length, endBefore + context);
  const ctxEndAfter = Math.min(afterLines.length, endAfter + context);

  const oldCount = ctxEndBefore - ctxStart;
  const newCount = ctxEndAfter - ctxStart;

  const lines: string[] = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`
  ];

  for (let i = ctxStart; i < start; i += 1) {
    lines.push(` ${beforeLines[i]}`);
  }
  for (let i = start; i < endBefore; i += 1) {
    lines.push(`-${beforeLines[i]}`);
  }
  for (let i = start; i < endAfter; i += 1) {
    lines.push(`+${afterLines[i]}`);
  }
  // Trailing context is a shared suffix, so `beforeLines` and `afterLines` agree here.
  for (let i = endBefore; i < ctxEndBefore; i += 1) {
    lines.push(` ${beforeLines[i]}`);
  }

  return `${lines.join('\n')}\n`;
}

function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  // A trailing newline produces a final empty element; drop it so it is not shown as a line.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
