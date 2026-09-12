import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewFindings,
  deduplicateReviewFindings,
  mapReviewFindingToInlineComment,
  formatTicketReviewSummaryComment
} from '../ai/aiReviewService';
import type { CheckFinding } from './workflowTypes';

test('parseReviewFindings extracts structured findings and metrics from fenced JSON block', () => {
  const content = `Here is my code review analysis:

\`\`\`json
{
  "summary": "Found 1 security vulnerability and 1 code quality issue.",
  "findings": [
    {
      "file": "src/auth/token.ts",
      "line": 42,
      "severity": "critical",
      "category": "security",
      "message": "Hardcoded JWT secret key",
      "suggestion": "Read secret from environment variable process.env.JWT_SECRET"
    },
    {
      "file": "src/utils/math.ts",
      "line": 15,
      "severity": "low",
      "category": "quality",
      "message": "Missing null check on input array"
    }
  ],
  "metrics": {
    "filesReviewed": 3,
    "issuesFound": 2
  }
}
\`\`\`

Overall code looks solid aside from the hardcoded secret.`;

  const result = parseReviewFindings(content);
  assert.strictEqual(result.findings.findings.length, 2);
  assert.strictEqual(result.findings.metrics.filesReviewed, 3);
  assert.strictEqual(result.findings.metrics.issuesFound, 2);
  assert.strictEqual(result.summary, 'Found 1 security vulnerability and 1 code quality issue.');

  const critical = result.findings.findings[0];
  assert.strictEqual(critical.severity, 'critical');
  assert.strictEqual(critical.file, 'src/auth/token.ts');
  assert.strictEqual(critical.line, 42);
  assert.ok(critical.fingerprint && critical.fingerprint.length === 64, 'should have sha256 fingerprint');
});

test('parseReviewFindings throws error when reviewer returns only prose without JSON block', () => {
  const proseOnly = `I reviewed your code. Everything looks okay, but please consider renaming variable foo to bar on line 10.`;
  assert.throws(
    () => parseReviewFindings(proseOnly),
    /Reviewer output did not contain a valid structured JSON findings block/
  );
});

test('parseReviewFindings throws error when findings array is missing in JSON', () => {
  const badJson = `\`\`\`json
{
  "summary": "Looks good",
  "status": "ready"
}
\`\`\``;
  assert.throws(
    () => parseReviewFindings(badJson),
    /must contain a "findings" array/
  );
});

test('deduplicateReviewFindings splits new vs previously seen findings by fingerprint', () => {
  const finding1: CheckFinding = {
    fingerprint: 'fp-1',
    severity: 'high',
    category: 'bug',
    message: 'NPE on empty collection'
  };
  const finding2: CheckFinding = {
    fingerprint: 'fp-2',
    severity: 'low',
    category: 'style',
    message: 'Unused import'
  };

  const previous = new Set(['fp-1']);
  const { newFindings, existingFindings } = deduplicateReviewFindings([finding1, finding2], previous);

  assert.strictEqual(newFindings.length, 1);
  assert.strictEqual(newFindings[0].fingerprint, 'fp-2');
  assert.strictEqual(existingFindings.length, 1);
  assert.strictEqual(existingFindings[0].fingerprint, 'fp-1');
});

test('mapReviewFindingToInlineComment formats clear markdown review comment', () => {
  const finding: CheckFinding = {
    fingerprint: 'fp-1',
    severity: 'high',
    category: 'security',
    message: 'Unescaped parameter passed to raw SQL query',
    suggestion: 'Use parameterized query with ? placeholder'
  };

  const comment = mapReviewFindingToInlineComment(finding);
  assert.ok(comment.includes('**[HIGH]** security'));
  assert.ok(comment.includes('Unescaped parameter'));
  assert.ok(comment.includes('**Suggestion:**'));
  assert.ok(comment.includes('Use parameterized query'));
});

test('formatTicketReviewSummaryComment groups findings by severity', () => {
  const findings: CheckFinding[] = [
    {
      fingerprint: 'fp-1',
      file: 'src/api.ts',
      line: 12,
      severity: 'critical',
      category: 'security',
      message: 'Missing auth check'
    },
    {
      fingerprint: 'fp-2',
      file: 'src/db.ts',
      line: 99,
      severity: 'medium',
      category: 'perf',
      message: 'Unindexed query'
    }
  ];

  const summaryComment = formatTicketReviewSummaryComment(findings, 'Automated code review summary');
  assert.ok(summaryComment.includes('## Code Review Findings'));
  assert.ok(summaryComment.includes('Automated code review summary'));
  assert.ok(summaryComment.includes('### CRITICAL (1)'));
  assert.ok(summaryComment.includes('`src/api.ts:12`'));
  assert.ok(summaryComment.includes('### MEDIUM (1)'));
  assert.ok(summaryComment.includes('`src/db.ts:99`'));
});
