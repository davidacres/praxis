/**
 * Does a change weaken the tests that judge it? (FX-BE-166 / TASK-433)
 *
 * An agent asked to make a number go up has an easy way to do it: make the
 * measurement easier to pass. This reads what a mutating stage changed and
 * reports the ways that happens — a deleted test, a skipped one, assertions
 * removed, a coverage threshold lowered, or (unless the stage was told tests are
 * its job) an existing test edited at all. Adding a new test is always fine.
 *
 * Deliberately lexical: it reads diffs, not ASTs, across every language the
 * templates target. It errs toward flagging — a false alarm costs a retry; a
 * missed one ships a loop that "converged" by cheating.
 */

import { computeFindingFingerprint, type CheckFinding } from './workflowTypes';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Unified diff of the file, when it has one (not for a deleted or binary file). */
  patch?: string;
}

export interface TestGuard {
  /** Tests are this stage's job, so editing existing ones is allowed (weakening still is not). */
  testsInScope?: boolean;
  /** More paths to treat as tests: a prefix (`spec/`) or a glob with `*` and `**`. */
  paths?: string[];
}

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|tests?|e2e|specs?)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rb)$/i,
  /Tests?\.cs$/,
  /\.feature$/i
];

const COVERAGE_CONFIG = /(^|\/)((jest|vitest|karma|playwright)\.config\.[cm]?[jt]s|\.nycrc(\.json)?|\.c8rc(\.json)?|codecov\.ya?ml|\.coveragerc|setup\.cfg|pyproject\.toml|coverlet\.runsettings|[^/]+\.runsettings)$/i;

const ASSERTION = /\b(expect\s*\(|assert(?:\.\w+)?\s*\(|assert\s|should\.|\.toBe\w*\(|\.toEqual\(|\.toMatch\w*\(|\.toHave\w*\(|\.toThrow\w*\(|Assert\.\w+\(|self\.assert\w*\()/;
const SKIP = /(\b(it|test|describe|context)\.skip\s*\(|\bx(it|describe|test)\s*\(|\b(it|test)\.todo\s*\(|@Ignore\b|\[Ignore\]|\[Fact\(Skip\s*=|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|\bskip\s*\(\s*['"])/;
const THRESHOLD_LINE = /(threshold|fail_under|minimum|branches|lines|functions|statements|coverage)\D{0,40}?(\d+(?:\.\d+)?)/i;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${escaped}${glob.endsWith('/') ? '' : '$'}`);
}

/** Whether a path is a test (or a test-config) file, by convention or the guard's own paths. */
export function isTestPath(path: string, guard?: TestGuard): boolean {
  const normal = path.replace(/\\/g, '/');
  if (TEST_PATH_PATTERNS.some(pattern => pattern.test(normal))) return true;
  return (guard?.paths ?? []).some(entry => (entry.includes('*') ? globToRegExp(entry).test(normal) : normal.startsWith(entry)));
}

/** Whether the guard reads this path at all: a test, or a coverage configuration. */
export function isGuardedPath(path: string, guard?: TestGuard): boolean {
  return isTestPath(path, guard) || COVERAGE_CONFIG.test(path.replace(/\\/g, '/'));
}

function linesOf(patch: string | undefined, sign: '+' | '-'): string[] {
  return (patch ?? '')
    .split('\n')
    .filter(line => line.startsWith(sign) && !line.startsWith(`${sign}${sign}${sign}`))
    .map(line => line.slice(1));
}

function finding(path: string, ruleId: string, message: string, suggestion: string): CheckFinding {
  return {
    fingerprint: computeFindingFingerprint({ ruleId, file: path, message }),
    ruleId,
    file: path,
    severity: 'high',
    category: 'test-integrity',
    message,
    suggestion
  };
}

/** Findings for every way `changes` weakens the tests; empty when it does not. */
export function assessTestChanges(changes: readonly ChangedFile[], guard: TestGuard = {}): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const change of changes) {
    const path = change.path.replace(/\\/g, '/');

    if (COVERAGE_CONFIG.test(path) && change.status !== 'added') {
      const removed = linesOf(change.patch, '-').map(line => THRESHOLD_LINE.exec(line)).filter((match): match is RegExpExecArray => !!match);
      const added = linesOf(change.patch, '+').map(line => THRESHOLD_LINE.exec(line)).filter((match): match is RegExpExecArray => !!match);
      for (const before of removed) {
        const after = added.find(candidate => candidate[1].toLowerCase() === before[1].toLowerCase());
        if (after && Number(after[2]) < Number(before[2])) {
          findings.push(finding(path, 'test-guard/threshold-lowered', `Lowered the ${before[1]} threshold from ${before[2]} to ${after[2]}.`, 'Restore the threshold and meet it with tests.'));
        }
      }
    }

    if (!isTestPath(path, guard)) continue;

    if (change.status === 'deleted') {
      findings.push(finding(path, 'test-guard/deleted', 'Deleted a test file.', 'Restore the test, and fix the code it checks instead.'));
      continue;
    }

    const added = linesOf(change.patch, '+');
    const removed = linesOf(change.patch, '-');

    const skips = added.filter(line => SKIP.test(line)).length - removed.filter(line => SKIP.test(line)).length;
    if (skips > 0) {
      findings.push(finding(path, 'test-guard/skipped', `Skipped ${skips} test${skips === 1 ? '' : 's'}.`, 'Remove the skip and make the test pass.'));
    }

    if (change.status === 'added') continue;

    const lostAssertions = removed.filter(line => ASSERTION.test(line)).length - added.filter(line => ASSERTION.test(line)).length;
    if (lostAssertions > 0) {
      findings.push(finding(path, 'test-guard/assertions-removed', `Removed ${lostAssertions} assertion${lostAssertions === 1 ? '' : 's'}.`, 'Keep what the test checked; change the code, not the expectation.'));
    }

    if (!guard.testsInScope && (added.length > 0 || removed.length > 0) && skips <= 0 && lostAssertions <= 0) {
      findings.push(finding(path, 'test-guard/edited', 'Edited an existing test, which this stage was not asked to do.', 'Leave existing tests as they are; add a new test if more coverage is needed.'));
    }
  }
  return findings;
}
