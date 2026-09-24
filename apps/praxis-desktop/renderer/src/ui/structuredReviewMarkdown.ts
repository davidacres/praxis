export interface StructuredReviewFinding {
  file?: string;
  line?: number;
  severity?: string;
  category?: string;
  message?: string;
  suggestion?: string;
}

interface StructuredReview {
  summary: string;
  findings: StructuredReviewFinding[];
  metrics?: { filesReviewed?: number; issuesFound?: number };
}

/**
 * Turns the structured reviewer contract into readable chat Markdown.
 *
 * Review agents are instructed to return a JSON fence, but providers sometimes
 * emit a two-backtick ``json fence or a labelled JSON block. Chat should still
 * be useful in those cases; workflow parsing remains independently strict.
 */
export function normalizeStructuredReviewMarkdown(text: string): string {
  const match = text.match(/`{2,3}\s*json\s*\r?\n([\s\S]*?)\r?\n\s*`{2,3}/i);
  if (match) {
    const review = parseReview(match[1]);
    if (!review) return text;
    return replaceMatch(text, match[0], renderReview(review));
  }

  const labelled = text.match(/^\s*`{0,2}\s*json\s*\r?\n([\s\S]*)$/i);
  if (labelled) {
    const review = parseReview(labelled[1]);
    if (review) return renderReview(review);
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const review = parseReview(text.slice(start, end + 1));
    if (review) return replaceMatch(text, text.slice(start, end + 1), renderReview(review));
  }

  return text;
}

function parseReview(value: string): StructuredReview | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.summary !== 'string' || !Array.isArray(candidate.findings)) return undefined;

  const findings = candidate.findings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))).map(item => ({
    ...(typeof item.file === 'string' ? { file: item.file } : {}),
    ...(typeof item.line === 'number' ? { line: item.line } : {}),
    ...(typeof item.severity === 'string' ? { severity: item.severity } : {}),
    ...(typeof item.category === 'string' ? { category: item.category } : {}),
    ...(typeof item.message === 'string' ? { message: item.message } : {}),
    ...(typeof item.suggestion === 'string' ? { suggestion: item.suggestion } : {})
  }));
  const metrics = candidate.metrics && typeof candidate.metrics === 'object' && !Array.isArray(candidate.metrics)
    ? candidate.metrics as Record<string, unknown>
    : undefined;
  return {
    summary: candidate.summary,
    findings,
    ...(metrics ? {
      metrics: {
        ...(typeof metrics.filesReviewed === 'number' ? { filesReviewed: metrics.filesReviewed } : {}),
        ...(typeof metrics.issuesFound === 'number' ? { issuesFound: metrics.issuesFound } : {})
      }
    } : {})
  };
}

function renderReview(review: StructuredReview): string {
  const lines = [
    '### Structured findings',
    '',
    review.summary.trim(),
    '',
    ...(review.metrics ? [`**Files reviewed:** ${review.metrics.filesReviewed ?? 0} · **Issues found:** ${review.metrics.issuesFound ?? review.findings.length}`, ''] : []),
    '#### Findings',
    ''
  ];
  if (review.findings.length === 0) {
    lines.push('_No findings reported._');
  } else {
    for (const finding of review.findings) {
      const location = finding.file ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''})` : '';
      const severity = finding.severity ? `**${finding.severity}** ` : '';
      lines.push(`- ${severity}${finding.message ?? 'Review finding'}${location}`);
      if (finding.suggestion) lines.push(`  - Suggestion: ${finding.suggestion}`);
    }
  }
  return lines.join('\n');
}

function replaceMatch(text: string, matched: string, replacement: string): string {
  const index = text.indexOf(matched);
  if (index < 0) return text;
  return `${text.slice(0, index)}${replacement}${text.slice(index + matched.length)}`;
}
