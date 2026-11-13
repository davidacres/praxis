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

const TEST_DIRECTORY = '__tests__/';
const SCRIPT_EXTENSION_AT_END = /\.[cm]?[jt]sx?$/;

/**
 * `/(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/` without its quadratic `.+\.` scan: a script file somewhere
 * below a `__tests__/` directory (a name before the extension, no line breaks in the path).
 */
function isUnderTestsDirectory(normalized: string): boolean {
  const extension = SCRIPT_EXTENSION_AT_END.exec(normalized);
  if (!extension) return false;
  let lastLineBreak = -1;
  for (let i = normalized.length - 1; i >= 0 && lastLineBreak < 0; i--) {
    if ('\n\r\u2028\u2029'.includes(normalized[i])) lastLineBreak = i;
  }
  for (let at = normalized.indexOf(TEST_DIRECTORY); at >= 0; at = normalized.indexOf(TEST_DIRECTORY, at + 1)) {
    if (at !== 0 && normalized[at - 1] !== '/') continue;
    const restStart = at + TEST_DIRECTORY.length;
    if (extension.index >= restStart + 1 && lastLineBreak < restStart) return true;
  }
  return false;
}

/** Test files, by the conventions of the common runners. */
export function isTestFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(normalized)) return false;
  const base = normalized.split('/').pop() ?? '';
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(base) ||
    isUnderTestsDirectory(normalized) ||
    /^test_.+\.py$|_test\.py$/.test(base) ||
    /_test\.go$/.test(base)
  );
}

/** The heading a plan lists the tests it expects to keep passing under. */
export const PLANNED_TESTS_HEADING = 'Tests to keep passing';

const PATH_CHAR = /[\w.@/-]/;
const WORD_OR_DASH = /[\w-]/;
const SCRIPT_EXTENSION = /[cm]?[jt]sx?/y;

interface PathCandidate {
  start: number;
  end: number;
  /** 1 = `*.spec.*` / `*.test.*`; 2 = `test_*.py`, `*_test.py`, `*_test.go`. */
  alt: 1 | 2;
  segment: number;
  /** For alt 2: the word-and-dash run the name sits in, so a clamped retry can look again. */
  word?: [number, number];
}

/** Where `test_x` / `x_test` starts within the word-and-dash run `run[from, to)`, or -1. */
function scriptNameStart(run: string, from: number, to: number): number {
  const word = run.slice(from, to);
  const prefixed = word.indexOf('test_');
  let start = prefixed >= 0 && prefixed + 5 < word.length ? from + prefixed : -1;
  if (word.length > 5 && word.endsWith('_test')) start = start < 0 ? from : Math.min(start, from);
  return start;
}

/**
 * The test-looking paths in one run of path characters. This is the linear form of
 * `(?:[\w.@-]+\/)*[\w.@-]+\.(?:spec|test)\.[cm]?[jt]sx?|(?:[\w.@-]+\/)*(?:test_[\w-]+|[\w-]+_test)\.(?:py|go)`,
 * whose nested quantifiers over a class that includes `.` backtracked quadratically.
 */
function testPathsInRun(run: string): string[] {
  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at <= run.length; ) {
    const slash = run.indexOf('/', at);
    const end = slash < 0 ? run.length : slash;
    starts.push(at);
    ends.push(end);
    at = end + 1;
  }
  const markers: Array<{ at: number; length: number }> = [];
  for (const needle of ['.spec.', '.test.']) {
    for (let at = run.indexOf(needle); at >= 0; at = run.indexOf(needle, at + 1)) markers.push({ at, length: needle.length });
  }
  markers.sort((x, y) => x.at - y.at);
  let markerIndex = 0;
  const chainStart: number[] = [];
  const candidates: PathCandidate[] = [];
  for (let t = 0; t < starts.length; t++) {
    const a = starts[t];
    const b = ends[t];
    chainStart.push(t > 0 && ends[t - 1] > starts[t - 1] ? chainStart[t - 1] : a);
    if (b <= a) continue;
    // `name.spec.ts` / `name.test.ts`: the last marker with a name before it and a script extension after.
    let bestEnd = -1;
    while (markerIndex < markers.length && markers[markerIndex].at < a) markerIndex++;
    for (let m = markerIndex; m < markers.length && markers[m].at < b; m++) {
      const { at, length } = markers[m];
      if (at <= a) continue;
      SCRIPT_EXTENSION.lastIndex = at + length;
      if (SCRIPT_EXTENSION.test(run)) bestEnd = SCRIPT_EXTENSION.lastIndex;
    }
    if (bestEnd >= 0) candidates.push({ start: chainStart[t], end: bestEnd, alt: 1, segment: t });
    // `test_name.py`, `name_test.py`, `name_test.go`: inside a word-and-dash run followed by .py or .go.
    for (let w = a; w < b; ) {
      if (!WORD_OR_DASH.test(run[w])) { w++; continue; }
      let wordEnd = w + 1;
      while (wordEnd < b && WORD_OR_DASH.test(run[wordEnd])) wordEnd++;
      if (run.startsWith('.py', wordEnd) || run.startsWith('.go', wordEnd)) {
        const start = scriptNameStart(run, w, wordEnd);
        if (start >= 0) candidates.push({ start: start === a ? chainStart[t] : start, end: wordEnd + 3, alt: 2, segment: t, word: [w, wordEnd] });
      }
      w = wordEnd;
    }
  }
  candidates.sort((x, y) => x.start - y.start || x.alt - y.alt || y.segment - x.segment);
  const paths: string[] = [];
  let position = 0;
  for (const candidate of candidates) {
    let { start } = candidate;
    if (start < position && candidate.word && candidate.word[1] > position) {
      // The previous match ended inside this name's word: the next one can still start after it.
      start = scriptNameStart(run, Math.max(candidate.word[0], position), candidate.word[1]);
    }
    if (start < position) continue;
    paths.push(run.slice(start, candidate.end));
    position = candidate.end;
  }
  return paths;
}

/**
 * What a plan line mentions as a test: a backticked token, or a bare path shaped like a test file.
 * A scanner over backticks and path runs rather than one global regex with nested quantifiers.
 */
function plannedTestMentions(line: string): string[] {
  const mentions: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      const close = line.indexOf('`', i + 1);
      if (close > i + 1 && !/\s/.test(line.slice(i + 1, close))) {
        mentions.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        i++;
      }
    } else if (PATH_CHAR.test(line[i])) {
      let end = i + 1;
      while (end < line.length && PATH_CHAR.test(line[end])) end++;
      mentions.push(...testPathsInRun(line.slice(i, end)));
      i = end;
    } else {
      i++;
    }
  }
  return mentions;
}

/** Test file paths a plan listed under its `Tests to keep passing` heading. */
export function parsePlannedTests(planText: string | undefined): string[] {
  const lines = (planText ?? '').split('\n');
  const start = lines.findIndex(line => /^\s*(?:(?:#{1,6}|\*\*)\s*)?tests to keep passing\b/i.test(line));
  if (start < 0) return [];
  const found = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(Plan status|Stage status):/i.test(line) || /^\s*```/.test(line)) break;
    for (const mention of plannedTestMentions(line)) {
      const candidate = mention.replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '');
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

/**
 * `/^[a-z][\w-]*[-_][\w-]+$/i`: a letter first, then word characters and dashes, with a `-` or `_`
 * somewhere after the first character and before the last.
 */
function isDistinctiveClassName(name: string): boolean {
  if (name.length < 3 || !/^[a-z][\w-]+$/i.test(name)) return false;
  for (let i = 1; i < name.length - 1; i++) if (name[i] === '-' || name[i] === '_') return true;
  return false;
}

/** The exported name in an `export { a as b }` entry: what follows its last `as` (`.split(/\s+as\s+/).pop()`). */
function exportedAlias(part: string): string | undefined {
  const tokens = part.trim().split(/\s+/);
  let alias = 0;
  for (let i = 1; i < tokens.length - 1; ) {
    if (tokens[i] === 'as') { alias = i + 1; i += 2; } else i++;
  }
  return tokens.slice(alias).join(' ').trim() || undefined;
}

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
    for (const name of match[2].split(/\s+/)) if (isDistinctiveClassName(name) && name.length >= 6) classNames.add(name);
  }
  const exports = new Set<string>();
  for (const match of source.matchAll(EXPORTED_NAME)) if (match[1].length >= 4) exports.add(match[1]);
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const part of match[1].split(',')) {
      const name = exportedAlias(part);
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
