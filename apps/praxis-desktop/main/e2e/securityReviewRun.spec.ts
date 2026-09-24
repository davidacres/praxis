import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The Security Review marketplace workflow (`addons/workflows/security-review`), run for real on a
 * folder-backed project. Only the LLM endpoint is mocked — it answers each stage in turn — so the
 * scanners, stage briefs, findings parsing, run page, approval and board publishing are all the
 * production path. Approving writes the remediation plan into the project's plans folder and the
 * run names the plan's id; skipping ends the run without one.
 */

test.slow();

const TEMPLATE = path.resolve(__dirname, '../../../../addons/workflows/security-review/addon/template.json');

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const RECON = '# Attack surface\n\n1. System overview — a small Node service.\n7. Review priorities — `src/orders.ts` builds SQL from input.';

const REPORT = [
  '# Security Review Report',
  '## Executive summary',
  'Overall risk: **High**. 1 critical, 1 medium.',
  '## Findings',
  '### SEC-001 SQL injection in order search (Critical, CWE-89)',
  '```ts',
  'db.query(`SELECT * FROM orders WHERE id = ${id}`);',
  '```',
  '### SEC-002 Missing rate limit on login (Medium, CWE-307)',
  '## Scanner triage',
  // Real reports run far past the inline cap; this one does too, so the plan stage must be
  // handed the whole report as a file.
  ...Array.from({ length: 400 }, (_, index) => `- Semgrep result ${index + 1} in test fixtures: dismissed, not reachable from any entry point.`),
  '## Findings register',
  '| ID | Severity | Title | CWE | Location | Effort |',
  '|---|---|---|---|---|---|',
  '| SEC-001 | Critical | SQL injection in order search | CWE-89 | src/orders.ts:12 | S |',
  '| SEC-002 | Medium | Missing rate limit on login | CWE-307 | src/auth.ts:40 | M |',
  '```json',
  JSON.stringify({
    summary: 'One critical injection and one medium brute-force risk.',
    findings: [
      { file: 'src/orders.ts', line: 12, severity: 'critical', category: 'CWE-89', message: 'SEC-001 SQL injection in order search', suggestion: 'Use a parameterised query.' },
      { file: 'src/auth.ts', line: 40, severity: 'medium', category: 'CWE-307', message: 'SEC-002 Missing rate limit on login', suggestion: 'Rate-limit failed logins per account and IP.' }
    ]
  }),
  '```'
].join('\n');

const PLAN = [
  'Two work items: the injection first, then login hardening.',
  '```praxis-plan',
  JSON.stringify({
    feature: { title: 'Security remediation — 2026-09-24', description: '## Summary\nP0: 1 · P2: 1.\n\n## Coverage\n| Finding | Item |\n|---|---|\n| SEC-001 | Parameterise the order search query |\n| SEC-002 | Rate-limit login attempts |' },
    items: [
      { type: 'Task', priority: 'P2', title: 'Rate-limit login attempts', description: '### Findings\nSEC-002\n### Verification\nA test proves the 6th failed login is refused.' },
      {
        type: 'Bug',
        priority: 'P0',
        severity: 'Critical',
        title: 'Parameterise the order search query',
        description: '### Findings\nSEC-001 (src/orders.ts:12)\n### Change\nUse a bound parameter.',
        steps: '1. Request `/orders?id=1 OR 1=1`.',
        expected: 'Only order 1 is returned.',
        actual: 'Every order is returned.'
      }
    ]
  }),
  '```'
].join('\n');

/** The whole report as the plan stage could read it from its worktree, captured while it ran. */
let reportFileDuringPlan: string | undefined;
let repoUnderTest = '';

/** Each stage is answered by name, as its brief opens with `You are running the "<name>" stage`. */
function replyFor(body: string): string | undefined {
  const text = JSON.stringify(JSON.parse(body).messages ?? []);
  if (text.includes('running the \\"Attack surface\\" stage')) return RECON;
  if (text.includes('running the \\"Security review\\" stage')) return REPORT;
  if (text.includes('running the \\"Remediation plan\\" stage')) {
    const worktrees = path.join(repoUnderTest, '.worktrees');
    for (const name of fs.existsSync(worktrees) ? fs.readdirSync(worktrees) : []) {
      const file = path.join(worktrees, name, '.praxis-run', 'security-report.md');
      if (fs.existsSync(file)) reportFileDuringPlan = fs.readFileSync(file, 'utf8');
    }
    return PLAN;
  }
  return undefined;
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-security-review-'));
  tempDirs.push(root);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'orders.ts'), 'export const find = (db, id) => db.query(`SELECT * FROM orders WHERE id = ${id}`);\n');
  const feature = path.join(root, 'docs', 'plans', 'features', 'feature-01-existing');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'feature.md'), '# Existing work\n\n**Status:** 📋 To Do\n**Type:** Feature\n');
  // The board file names another key; a project board keeps its project's, and the plan is filed under whichever the board uses.
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'board.praxis.json'), JSON.stringify({ projectKey: 'SEC', projectName: 'Audit Target', allowIssueCreation: true }));
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

async function startSecurityReview(page: Page, repo: string): Promise<{ runId: string; projectId: string }> {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));
  return page.evaluate(
    async ({ repoPath, definition }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Audit Target',
          key: 'AUDIT',
          type: 'software',
          purpose: '',
          brief: {},
          startingPoint: 'existing-folder',
          folderPath: repoPath,
          storage: 'folder',
          workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
          starterTickets: [],
          defaultAiToolMode: 'read-only'
        },
        workspace.id
      );
      await window.praxis.agentRuntime.refresh();
      await window.praxis.workflows.save(project.id, { ...definition, id: `security-review-${project.id}`, scope: 'project', projectId: project.id } as never);
      const summary = await window.praxis.workflows.startRun(project.id, `security-review-${project.id}`, 'Security Review', undefined, undefined, undefined, {
        uncommittedChanges: 'omit'
      });
      localStorage.setItem(
        `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
        JSON.stringify({ projectId: project.id, feature: 'workflows', workflowView: 'runs', workflowRunId: summary.runId })
      );
      return { runId: summary.runId, projectId: project.id };
    },
    { repoPath: repo, definition: template }
  );
}

async function launch(): Promise<{ page: Page; repo: string }> {
  mock = await startMockGatewayServer({ mode: 'complete', replyFor });
  const repo = createRepository();
  repoUnderTest = repo;
  reportFileDuringPlan = undefined;
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', workingDirectory: repo } },
    undefined,
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  return { page: app.window, repo };
}

const runStatus = (page: Page, runId: string) => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId);

test('Security Review: findings, readable report, and an approved plan created on the board with its id', async () => {
  const { page, repo } = await launch();
  const { runId } = await startSecurityReview(page, repo);

  await expect.poll(() => runStatus(page, runId), { timeout: 120000, message: 'the review should reach the plan decision on its own' }).toBe('awaiting-approval');

  // The reviewer was handed the scanner output inline, not a path it cannot open.
  const reviewRequest = mock!.requests.find(request => request.body.includes('running the \\"Security review\\" stage'));
  expect(reviewRequest?.body).toContain('Output of earlier check stages');
  expect(reviewRequest?.body).toContain('secrets-log');

  await page.reload();
  const panel = page.getByTestId('wf-run-panel');
  await panel.getByTestId('wf-vpipe-step-review').click();
  // A report that recommends rate limiting is not an AI provider limit.
  await expect(page.getByTestId('session-error-banner')).toHaveCount(0);

  // Structured findings, grouped by severity, with location and fix.
  await expect(panel.getByTestId('wf-findings-group-critical')).toContainText('src/orders.ts:12');
  await expect(panel.getByTestId('wf-findings-group-medium')).toContainText('SEC-002 Missing rate limit on login');
  await expect(panel.getByTestId('wf-finding-row')).toHaveCount(2);

  // The whole report reads as a document.
  await panel.getByTestId('wf-read-report').click();
  const dialog = page.getByTestId('wf-report-dialog');
  await expect(dialog.getByRole('heading', { name: 'Security Review Report' })).toBeVisible();
  await expect(dialog).toContainText('SEC-001 SQL injection in order search');
  await page.screenshot({ path: path.resolve(__dirname, '../../../../.praxis/session-artifacts/security-review-report.png') });

  // …and saves as Markdown where the person chooses.
  const savedPath = path.join(repo, 'security-report.md');
  await app!.electronApp.evaluate(({ dialog: electronDialog }, chosen) => {
    electronDialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
  }, savedPath);
  await dialog.getByRole('button', { name: 'Save as Markdown…' }).click();
  await expect.poll(() => fs.existsSync(savedPath)).toBe(true);
  expect(fs.readFileSync(savedPath, 'utf8')).toContain('## Findings register');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Approve → the plan is created on the board, and the run names it.
  await panel.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => runStatus(page, runId), { timeout: 60000 }).toBe('succeeded');
  const plan = await page.evaluate(
    id => window.praxis.workflows.getRun(id).then(run => run?.stages.find(stage => stage.nodeId === 'remediation-plan')?.artifacts[0]?.reference),
    runId
  );
  expect(plan?.key).toMatch(/^AUDIT-F\d+$/);
  expect(plan?.itemKeys).toHaveLength(2);

  await panel.getByTestId('wf-vpipe-step-remediation-plan').click();
  await expect(panel.getByTestId('wf-published-plan')).toContainText(`Plan ${plan!.key} created on the board — Security remediation — 2026-09-24 · 2 items`);
  await page.screenshot({ path: path.resolve(__dirname, '../../../../.praxis/session-artifacts/security-review-plan-created.png') });

  // Physical, Praxis-readable plan files: a feature folder with the P0 item first.
  const features = path.join(repo, 'docs', 'plans', 'features');
  const planDir = fs.readdirSync(features).find(name => name !== 'feature-01-existing');
  expect(planDir).toBeTruthy();
  const planFiles = fs.readdirSync(path.join(features, planDir!), { recursive: true }).map(String).sort();
  expect(planFiles).toContain('feature.md');
  expect(fs.readFileSync(path.join(features, planDir!, 'feature.md'), 'utf8')).toContain('# Security remediation — 2026-09-24');
  const itemTexts = planFiles.filter(file => file.endsWith('.md') && !file.endsWith('feature.md')).map(file => fs.readFileSync(path.join(features, planDir!, file), 'utf8'));
  expect(itemTexts.some(text => text.includes('[P0] Parameterise the order search query') && text.includes(`Part of plan ${plan!.key}`))).toBe(true);
  expect(itemTexts.some(text => text.includes('[P2] Rate-limit login attempts'))).toBe(true);

  // The bug reads as a bug report on the board: its priority, severity and reproduction are filled.
  const bug = itemTexts.find(text => text.includes('[P0] Parameterise the order search query'))!;
  expect(bug).toContain('**Priority:** Highest');
  expect(bug).toContain('**Severity:** Critical');
  expect(bug).toMatch(/## Steps to Reproduce\n1\. Request `\/orders\?id=1 OR 1=1`\./);
  expect(bug).toMatch(/## Actual Behavior\nEvery order is returned\./);

  // The report was too long to inline, so the plan stage was pointed at the whole of it in its
  // worktree, and the file was gone once the stage finished.
  const planRequest = mock!.requests.find(request => request.body.includes('running the \\"Remediation plan\\" stage'));
  expect(planRequest?.body).toContain('.praxis-run/security-report.md');
  expect(reportFileDuringPlan).toContain('Semgrep result 400 in test fixtures');
  const worktrees = path.join(repo, '.worktrees');
  for (const name of fs.existsSync(worktrees) ? fs.readdirSync(worktrees) : []) {
    expect(fs.existsSync(path.join(worktrees, name, '.praxis-run'))).toBe(false);
  }

  // The plan opens on the project's board.
  await panel.getByRole('button', { name: 'Open on board' }).click();
  await expect(page.getByText('Security remediation — 2026-09-24').first()).toBeVisible();
});

test('Security Review: skipping the plan ends the run as succeeded with no plan created', async () => {
  const { page, repo } = await launch();
  const { runId } = await startSecurityReview(page, repo);
  await expect.poll(() => runStatus(page, runId), { timeout: 120000 }).toBe('awaiting-approval');

  await page.reload();
  await page.getByTestId('wf-run-panel').getByTestId('wf-skip-approval').click();
  await expect.poll(() => runStatus(page, runId), { timeout: 30000 }).toBe('succeeded');
  const outcomes = await page.evaluate(
    id => window.praxis.workflows.getRun(id).then(run => Object.fromEntries((run?.stages ?? []).map(stage => [stage.nodeId, stage.outcome]))),
    runId
  );
  expect(outcomes['plan-decision']).toBe('skipped');
  expect(outcomes['remediation-plan']).toBe('skipped');
  expect(fs.readdirSync(path.join(repo, 'docs', 'plans', 'features'))).toEqual(['feature-01-existing']);
  expect(mock!.requests.some(request => request.body.includes('running the \\"Remediation plan\\" stage'))).toBe(false);
});
