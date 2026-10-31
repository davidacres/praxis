/**
 * Reads a test runner's own summary out of a check's output so a failed QA
 * stage can say what failed instead of showing the last few kilobytes of log.
 *
 * The tail alone was misleading: Playwright prints `83 failed` once, above the
 * list of failed titles, and with a big failure list (or an evidence log capped
 * at its head) the tail began part-way down that list — a column of test names
 * with nothing saying they had failed. This finds the counts and the titles,
 * groups them, and names the most common cause, so the stage error reads as a
 * verdict. The whole log stays in the stage's evidence artifact.
 *
 * Deliberately pure (no fs, no electron) so it runs under plain `node --test`.
 */

export interface TestRunSummary {
  failed: number;
  passed: number;
  flaky: number;
  skipped: number;
  didNotRun: number;
  /** Failed test titles as the runner listed them, decoration stripped. */
  failures: string[];
  /** What the failures were waiting for (or their first error), most common first. */
  causes: Array<{ cause: string; count: number }>;
}

const ANSI = /\u001b\[[0-9;]*m/g;
const COUNT_LINE = /^ {2}(\d+) (failed|flaky|passed|skipped|did not run|interrupted)\b/;
const LISTED_TEST = /^ {4}(?:\[[^\]]+\] › )?(.+?)\s*─*\s*$/;
const FAILURE_HEADER = /^ {2}\d+\) /;

export function summarizeTestRun(output: string): TestRunSummary | undefined {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const summary: TestRunSummary = { failed: 0, passed: 0, flaky: 0, skipped: 0, didNotRun: 0, failures: [], causes: [] };
  let sawCount = false;
  let listing: 'failed' | undefined;

  for (const line of lines) {
    const count = line.match(COUNT_LINE);
    if (count) {
      sawCount = true;
      const n = Number(count[1]);
      switch (count[2]) {
        case 'failed': summary.failed = n; break;
        case 'interrupted': summary.failed += n; break;
        case 'flaky': summary.flaky = n; break;
        case 'passed': summary.passed = n; break;
        case 'skipped': summary.skipped = n; break;
        case 'did not run': summary.didNotRun = n; break;
      }
      listing = count[2] === 'failed' || count[2] === 'interrupted' ? 'failed' : undefined;
      continue;
    }
    if (listing === 'failed') {
      const listed = line.match(LISTED_TEST);
      if (listed && listed[1].includes(' › ')) summary.failures.push(listed[1].trim());
      else listing = undefined;
    }
  }

  // node:test's spec reporter: `ℹ pass 12` / `ℹ fail 2`, then `✖ failing tests:`.
  if (!sawCount) {
    const pass = output.match(/^ℹ pass (\d+)$/m);
    const fail = output.match(/^ℹ fail (\d+)$/m);
    if (!pass && !fail) return undefined;
    summary.passed = Number(pass?.[1] ?? 0);
    summary.failed = Number(fail?.[1] ?? 0);
  }

  summary.causes = commonCauses(lines);
  return summary;
}

/**
 * Each Playwright failure block runs from its `  12) ` header to the next. A
 * block's cause is the locator it was waiting for when one is named — that is
 * what tells "every spec lost the same sidebar row" apart from 80 unrelated
 * bugs — otherwise its first error line. Retries repeat a block, which only
 * weights the count, never changes the order.
 */
function commonCauses(lines: string[]): Array<{ cause: string; count: number }> {
  const counts = new Map<string, number>();
  let inBlock = false;
  let error: string | undefined;
  let waiting: string | undefined;
  const flush = () => {
    const cause = waiting ? `waiting for ${waiting}` : error;
    if (inBlock && cause) counts.set(cause, (counts.get(cause) ?? 0) + 1);
    error = undefined;
    waiting = undefined;
  };
  for (const line of lines) {
    if (FAILURE_HEADER.test(line) || COUNT_LINE.test(line)) {
      flush();
      inBlock = FAILURE_HEADER.test(line);
      continue;
    }
    if (!inBlock) continue;
    const trimmed = line.trim();
    if (!error && /^(?:\w*Error:|Test timeout of)/.test(trimmed)) error = trimmed.slice(0, 160);
    const wait = trimmed.match(/^- waiting for (.+)$/);
    if (!waiting && wait) waiting = locatorKey(wait[1]);
  }
  flush();
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

/**
 * Specs narrow the same element differently (`.first()`, `.filter({ hasText })`), so
 * a raw locator splits one shared cause into many. Group by the test id it targets.
 */
function locatorKey(locator: string): string {
  const id = locator.match(/getByTestId\('([^']+)'\)|data-testid="([^"]+)"/);
  return id ? `test id "${id[1] ?? id[2]}"` : locator.slice(0, 160);
}

/** A few short lines a person can act on; undefined when the output has no summary to read. */
export function formatTestRunSummary(summary: TestRunSummary): string | undefined {
  if (summary.failed === 0) return undefined;
  const total = summary.failed + summary.passed + summary.flaky + summary.skipped + summary.didNotRun;
  const extra = [
    `${summary.passed} passed`,
    summary.flaky ? `${summary.flaky} flaky` : '',
    summary.skipped ? `${summary.skipped} skipped` : '',
    summary.didNotRun ? `${summary.didNotRun} did not run` : ''
  ].filter(Boolean).join(', ');
  const out = [`${summary.failed} of ${total} tests failed (${extra}).`];

  if (summary.failures.length > 10) {
    const bySpec = new Map<string, number>();
    for (const title of summary.failures) {
      const spec = title.split(' › ')[0].replace(/:\d+(?::\d+)?$/, '').replace(/^.*\//, '');
      bySpec.set(spec, (bySpec.get(spec) ?? 0) + 1);
    }
    const specs = [...bySpec.entries()].sort((a, b) => b[1] - a[1]);
    out.push('', `Failed in ${specs.length} spec file${specs.length === 1 ? '' : 's'}: ${specs.map(([spec, n]) => `${spec} (${n})`).join(', ')}.`);
  } else if (summary.failures.length) {
    out.push('', 'Failed:', ...summary.failures.map(title => `• ${title.replace(/:(\d+):\d+ › /, ':$1 › ')}`));
  }

  if (summary.causes.length) {
    out.push('', summary.causes.length === 1 ? 'Most common cause:' : 'Most common causes:', ...summary.causes.map(({ cause, count }) => `• ${count}× ${cause}`));
  }
  return out.join('\n');
}
