import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  changedHunkText,
  coChangedTests,
  isTestFile,
  mergeAffectedTests,
  parsePlannedTests,
  sourceHooks,
  testReferences,
  type AffectedTest,
  type WorkflowCheckNode
} from '@praxis/core';
import type { CheckProcessResult } from './workflowCheckProcess';

/**
 * Picks and runs the tests for a run's change, for a QA check (see core's `affectedTests.ts`).
 *
 * Selection reads git in the run's worktree: the tests the change itself touched, the tests that use
 * a UI hook or import a module the diff changed, tests that history says move with those files, and
 * the plan's `Tests to keep passing`. Each test file then runs under the runner that owns it —
 * Playwright, Vitest, Jest or pytest — found from the nearest config or package. A file no runner
 * claims is listed, not run: the project's own test command is what covers it.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go)$/;
const MAX_TEST_FILE_BYTES = 512 * 1024;
/** Above this many, the selection has stopped being "the tests for this change". */
export const MAX_AFFECTED_TESTS = 40;

export interface AffectedTestSelection {
  tests: AffectedTest[];
  /** Selected tests left out because the selection ran past `MAX_AFFECTED_TESTS`. */
  dropped: number;
}

/** The tests for the change between `baseCommit` and the worktree's HEAD. */
export async function selectAffectedTests(worktreePath: string, baseCommit: string, planText?: string): Promise<AffectedTestSelection> {
  const changed = (await git(worktreePath, ['diff', '--name-only', '--diff-filter=ACMR', `${baseCommit}..HEAD`]))
    .split('\n')
    .map(line => line.trim())
    .filter(file => file && !file.startsWith('.praxis/') && !file.startsWith('.praxis-run/'));
  const tracked = (await git(worktreePath, ['ls-files'])).split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);

  const direct: AffectedTest[] = changed.filter(isTestFile).map(file => ({ file, reasons: ['changed by this run'] }));
  const planned: AffectedTest[] = parsePlannedTests(planText)
    .filter(file => trackedSet.has(file))
    .map(file => ({ file, reasons: ['listed in the plan'] }));

  const sources = await Promise.all(
    changed
      .filter(file => !isTestFile(file) && SOURCE_FILE.test(file))
      .map(async file => {
        const hunks = sourceHooks(changedHunkText(await git(worktreePath, ['diff', '-U3', `${baseCommit}..HEAD`, '--', file])));
        const whole = await fs.readFile(path.join(worktreePath, file), 'utf8').catch(() => '');
        return { file, hooks: { ...hunks, exports: sourceHooks(whole).exports } };
      })
  );

  const referencing: AffectedTest[] = [];
  if (sources.length > 0) {
    for (const file of tracked.filter(isTestFile)) {
      const absolute = path.join(worktreePath, file);
      const stat = await fs.stat(absolute).catch(() => undefined);
      if (!stat || stat.size > MAX_TEST_FILE_BYTES) continue;
      const reasons = testReferences(await fs.readFile(absolute, 'utf8'), sources);
      if (reasons.length) referencing.push({ file, reasons });
    }
  }

  let coChanged: AffectedTest[] = [];
  if (sources.length > 0) {
    const log = await git(worktreePath, ['log', '--format=%x1e', '--name-only', '-n', '500', baseCommit]).catch(() => '');
    const commits = log.split('\x1e').map(block => block.split('\n').map(line => line.trim()).filter(Boolean));
    coChanged = coChangedTests(commits, sources.map(source => source.file)).filter(test => trackedSet.has(test.file));
  }

  // Strongest evidence first, so a cap drops the weakest picks.
  const ranked = mergeAffectedTests(direct, planned, referencing, coChanged).sort((a, b) => strength(b) - strength(a) || a.file.localeCompare(b.file));
  return { tests: ranked.slice(0, MAX_AFFECTED_TESTS), dropped: Math.max(0, ranked.length - MAX_AFFECTED_TESTS) };
}

function strength(test: AffectedTest): number {
  return test.reasons.reduce((sum, reason) =>
    sum + (reason === 'changed by this run' || reason === 'listed in the plan' ? 100 : /^(uses|selects|imports)/.test(reason) ? 10 : 1), 0);
}

export interface TestRunPorts {
  spawn(node: WorkflowCheckNode, cwd: string, signal?: AbortSignal): Promise<CheckProcessResult>;
}

interface RunnerGroup {
  runner: 'playwright' | 'vitest' | 'jest' | 'pytest';
  /** Directory the runner is started in. */
  cwd: string;
  /** Test files, relative to `cwd`. */
  files: string[];
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/** The runner that owns a test file, from the nearest config or package up to the worktree root. */
async function runnerFor(worktreePath: string, file: string): Promise<{ runner: RunnerGroup['runner']; cwd: string } | undefined> {
  if (/\.py$/.test(file)) return { runner: 'pytest', cwd: worktreePath };
  let dir = path.dirname(path.join(worktreePath, file));
  const root = path.resolve(worktreePath);
  while (dir.startsWith(root)) {
    for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']) {
      if (await exists(path.join(dir, name))) return { runner: 'playwright', cwd: dir };
    }
    for (const name of ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vite.config.ts']) {
      if (name.startsWith('vitest') && await exists(path.join(dir, name))) return { runner: 'vitest', cwd: dir };
    }
    const pkgPath = path.join(dir, 'package.json');
    if (await exists(pkgPath)) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8').catch(() => '{}')) as Record<string, Record<string, string> | undefined>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return { runner: 'vitest', cwd: dir };
      if (deps.jest) return { runner: 'jest', cwd: dir };
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** Each file in the first of its config's projects that includes it, so no file runs twice. */
async function playwrightProjects(group: RunnerGroup, ports: TestRunPorts, signal?: AbortSignal): Promise<Map<string, string[]> | undefined> {
  const listed = await ports.spawn(
    { type: 'check', id: 'affected-tests-list', name: 'List tests', x: 0, y: 0, inputs: [], outputs: [], command: 'npx', args: ['playwright', 'test', '--list', '--reporter=json', ...group.files], timeoutMs: 120000 },
    group.cwd,
    signal
  );
  const json = listed.output.slice(listed.output.indexOf('{'));
  let report: { config?: { projects?: Array<{ name: string }> }; suites?: unknown[] };
  try {
    report = JSON.parse(json);
  } catch {
    return undefined;
  }
  const order = (report.config?.projects ?? []).map(project => project.name);
  const projectsByFile = new Map<string, Set<string>>();
  const walk = (suite: { file?: string; specs?: Array<{ file?: string; tests?: Array<{ projectName?: string }> }>; suites?: unknown[] }) => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file;
      if (!file) continue;
      for (const run of spec.tests ?? []) if (run.projectName) (projectsByFile.get(file) ?? projectsByFile.set(file, new Set()).get(file)!).add(run.projectName);
    }
    for (const child of (suite.suites ?? []) as typeof suite[]) walk(child);
  };
  for (const suite of (report.suites ?? []) as Parameters<typeof walk>[0][]) walk(suite);
  const byProject = new Map<string, string[]>();
  for (const file of group.files) {
    // The JSON report names files relative to the config's test directory.
    const listed = [...projectsByFile].find(([name]) => file === name || file.endsWith(`/${name}`));
    const chosen = order.find(name => listed?.[1].has(name));
    if (!chosen) continue;
    byProject.set(chosen, [...(byProject.get(chosen) ?? []), file]);
  }
  return byProject;
}

function commandFor(group: RunnerGroup, project?: string): { command: string; args: string[] } {
  switch (group.runner) {
    case 'playwright':
      return { command: 'npx', args: ['playwright', 'test', ...(project ? [`--project=${project}`] : []), ...group.files] };
    case 'vitest':
      return { command: 'npx', args: ['vitest', 'run', ...group.files] };
    case 'jest':
      return { command: 'npx', args: ['jest', '--runTestsByPath', ...group.files] };
    case 'pytest':
      return { command: 'python3', args: ['-m', 'pytest', ...group.files] };
  }
}

/**
 * Runs the selected tests and reports them as one check result: every runner's output in turn, and
 * a non-zero code when any of them failed.
 */
export async function runAffectedTests(
  worktreePath: string,
  selection: AffectedTestSelection,
  ports: TestRunPorts,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<CheckProcessResult> {
  const lines: string[] = ['== Tests for this change =='];
  if (selection.tests.length === 0) {
    lines.push('No existing tests refer to what this change touched, and the plan listed none.');
    return { code: 0, output: lines.join('\n'), timedOut: false };
  }
  for (const test of selection.tests) lines.push(`- ${test.file}: ${test.reasons.slice(0, 3).join('; ')}`);
  if (selection.dropped) lines.push(`(${selection.dropped} more matched less strongly and were left out.)`);

  const groups = new Map<string, RunnerGroup>();
  const unclaimed: string[] = [];
  for (const test of selection.tests) {
    const owner = await runnerFor(worktreePath, test.file);
    if (!owner) {
      unclaimed.push(test.file);
      continue;
    }
    const key = `${owner.runner}\0${owner.cwd}`;
    const group = groups.get(key) ?? { ...owner, files: [] };
    group.files.push(path.relative(owner.cwd, path.join(worktreePath, test.file)));
    groups.set(key, group);
  }
  if (unclaimed.length) lines.push(`Not run here (no Playwright, Vitest, Jest or pytest setup claims them; the project's own test command covers them): ${unclaimed.join(', ')}`);

  let failed = false;
  let timedOut = false;
  for (const group of groups.values()) {
    const runs: Array<{ project?: string; files: string[] }> = group.runner === 'playwright'
      ? [...((await playwrightProjects(group, ports, options.signal)) ?? new Map([[undefined as unknown as string, group.files]]))].map(([project, files]) => ({ project, files }))
      : [{ files: group.files }];
    for (const run of runs) {
      if (options.signal?.aborted) break;
      const { command, args } = commandFor({ ...group, files: run.files }, run.project);
      lines.push('', `$ ${command} ${args.join(' ')}  (in ${path.relative(worktreePath, group.cwd) || '.'})`);
      const result = await ports.spawn(
        { type: 'check', id: 'affected-tests', name: 'Tests for this change', x: 0, y: 0, inputs: [], outputs: [], command, args, timeoutMs: options.timeoutMs ?? 1800000 },
        group.cwd,
        options.signal
      );
      lines.push(result.output.trimEnd());
      if (result.timedOut) timedOut = true;
      if (result.code !== 0) failed = true;
    }
  }
  return { code: failed || timedOut ? 1 : 0, output: lines.join('\n'), timedOut };
}
