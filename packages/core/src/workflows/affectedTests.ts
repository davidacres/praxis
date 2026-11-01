/**
 * Which existing tests cover a change, for any project.
 *
 * TASK-498 to TASK-502 each changed the notes shelf and merged with earlier tickets' notes tests
 * failing, because QA ran only the project's test command (unit tests and a smoke set) and none of
 * those specs were in it. A QA check now also runs the tests for the change: the ones the plan
 * listed, and the ones that refer to what the diff touched.
 *
 * End-to-end tests are the hard case. They never import the UI they drive; they find it by strings —
 * a `data-testid`, an aria-label, a role's name. So beyond the usual "a test that mentions this
 * file or export", this collects those UI hooks from the changed files and looks for tests that
 * use them. Everything here is pure; reading files and running the tests lives in the desktop app.
 */

/** Test files, by the conventions of the common runners. */
export function isTestFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(normalized)) return false;
  const base = normalized.split('/').pop() ?? '';
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(base) ||
    /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/.test(normalized) ||
    /^test_.+\.py$|_test\.py$/.test(base) ||
    /_test\.go$/.test(base)
  );
}

/** The heading a plan lists the tests it expects to keep passing under. */
export const PLANNED_TESTS_HEADING = 'Tests to keep passing';

/** Test file paths a plan listed under its `Tests to keep passing` heading. */
export function parsePlannedTests(planText: string | undefined): string[] {
  const lines = (planText ?? '').split('\n');
  const start = lines.findIndex(line => /^\s*(#{1,6}\s*|\*\*)?\s*tests to keep passing\b/i.test(line));
  if (start < 0) return [];
  const found = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(Plan status|Stage status):/i.test(line) || /^\s*```/.test(line)) break;
    for (const match of line.matchAll(/`([^`\s]+)`|((?:[\w.@-]+\/)*[\w.@-]+\.(?:spec|test)\.[cm]?[jt]sx?|(?:[\w.@-]+\/)*(?:test_[\w-]+|[\w-]+_test)\.(?:py|go))/g)) {
      const candidate = (match[1] ?? match[2] ?? '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '');
      if (candidate && isTestFile(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

/** What a changed source file exposes that a test could find it by. */
export interface SourceHooks {
  /** `data-testid`, aria-label, title and placeholder values: what UI tests look elements up by. */
  uiHooks: string[];
  /** Distinctive CSS class names (`session-shelf__rail`), which UI tests also select by. */
  classNames: string[];
  /** Exported names: what unit tests import and call. */
  exports: string[];
}

const UI_ATTRIBUTE = /\b(?:data-testid|data-test-id|data-test|aria-label|title|placeholder)\s*=\s*(?:\{\s*)?(["'`])([^"'`{}$\n]{2,80})\1/g;
const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*=\s*(?:\{\s*)?(["'`])([^"'`{}$\n]{3,200})\1/g;
const EXPORTED_NAME = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]+)\}/g;

/** The UI hooks and exported names in one source file. */
export function sourceHooks(source: string): SourceHooks {
  const uiHooks = new Set<string>();
  for (const match of source.matchAll(UI_ATTRIBUTE)) {
    const value = match[2].trim();
    // A test id is distinctive by design; a label must be more than one common word ("Close").
    const isTestId = /^data-test/.test(match[0]);
    if (isTestId ? value.length >= 3 : value.length >= 6 && (/\s/.test(value) || /[-_]/.test(value))) uiHooks.add(value);
  }
  const classNames = new Set<string>();
  for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
    // Only distinctive names: a BEM-style or hyphenated class, not `row` or `active`.
    for (const name of match[2].split(/\s+/)) if (/^[a-z][\w-]*[-_][\w-]+$/i.test(name) && name.length >= 6) classNames.add(name);
  }
  const exports = new Set<string>();
  for (const match of source.matchAll(EXPORTED_NAME)) if (match[1].length >= 4) exports.add(match[1]);
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]{3,}$/.test(name)) exports.add(name);
    }
  }
  return { uiHooks: [...uiHooks], classNames: [...classNames], exports: [...exports] };
}

/**
 * The text of a unified diff's hunks (changed lines and the context around them), for `sourceHooks`.
 * Hooks are read from what the change touched, not the whole file: one edit to a large component
 * otherwise selects every test that uses any part of it.
 */
export function changedHunkText(unifiedDiff: string): string {
  return unifiedDiff
    .split('\n')
    .filter(line => /^[ +-]/.test(line) && !/^(\+\+\+|---) /.test(line))
    .map(line => line.slice(1))
    .join('\n');
}

/** Why a test file was picked: one line per reason. */
export interface AffectedTest {
  file: string;
  reasons: string[];
}

/** Names too generic to say anything about which test covers which code. */
const GENERIC_NAMES = new Set(['index', 'main', 'types', 'utils', 'util', 'helpers', 'constants', 'config', 'default', 'Props', 'State', 'Options']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The reasons a test file refers to the changed sources, if it does: a UI hook it uses, an export
 * it names, or the source file's name in an import.
 */
export function testReferences(
  testText: string,
  changed: ReadonlyArray<{ file: string; hooks: SourceHooks }>
): string[] {
  const reasons: string[] = [];
  for (const { file, hooks } of changed) {
    const base = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
    for (const hook of hooks.uiHooks) {
      if (testText.includes(`'${hook}'`) || testText.includes(`"${hook}"`) || testText.includes(`\`${hook}\``) || testText.includes(`=${hook}]`) || testText.includes(`="${hook}"]`)) {
        reasons.push(`uses "${hook}" from ${file}`);
      }
    }
    for (const name of hooks.classNames) {
      if (new RegExp(`\\.${escapeRegExp(name)}(?![\\w-])`).test(testText)) reasons.push(`selects .${name} from ${file}`);
    }
    // A name alone (`menu`, `flush`) matches too much; a test that imports the module and uses the
    // changed export is the unit-test link that matters.
    const imports = !GENERIC_NAMES.has(base) && new RegExp(`from\\s+['"][^'"]*/${escapeRegExp(base)}(?:\\.[cm]?[jt]sx?)?['"]|require\\(['"][^'"]*/${escapeRegExp(base)}(?:\\.[cm]?[jt]sx?)?['"]\\)`).test(testText);
    if (!imports) continue;
    const used = hooks.exports.filter(name => !GENERIC_NAMES.has(name) && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(testText));
    reasons.push(used.length ? `imports ${file} and uses ${used.slice(0, 3).join(', ')}` : `imports ${file}`);
  }
  return [...new Set(reasons)];
}

/**
 * Test files changed in the same commits as these sources, at least `minCommits` times.
 * `commits` is each commit's file list, newest first. A commit touching very many files says
 * nothing about which tests go with which code, so it is skipped.
 */
export function coChangedTests(commits: ReadonlyArray<readonly string[]>, sources: readonly string[], minCommits = 3, maxFilesPerCommit = 15): AffectedTest[] {
  const wanted = new Set(sources);
  const counts = new Map<string, number>();
  for (const files of commits) {
    if (files.length > maxFilesPerCommit || !files.some(file => wanted.has(file))) continue;
    for (const file of files) if (isTestFile(file) && !wanted.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= minCommits)
    .sort((a, b) => b[1] - a[1])
    .map(([file, count]) => ({ file, reasons: [`changed with these files in ${count} commits`] }));
}

/** Merges selections, keeping every reason a file was picked for. */
export function mergeAffectedTests(...lists: ReadonlyArray<readonly AffectedTest[]>): AffectedTest[] {
  const byFile = new Map<string, Set<string>>();
  for (const list of lists) {
    for (const entry of list) {
      const reasons = byFile.get(entry.file) ?? new Set<string>();
      for (const reason of entry.reasons) reasons.add(reason);
      byFile.set(entry.file, reasons);
    }
  }
  return [...byFile].sort((a, b) => a[0].localeCompare(b[0])).map(([file, reasons]) => ({ file, reasons: [...reasons] }));
}
