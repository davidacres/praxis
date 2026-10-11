import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/**
 * FX-BE-159 What Changed, against a real folder-backed project in a real git repository:
 * every v1 source (items, plan files, agent sessions, commits), who made each change,
 * day grouping, one-click navigation, and reaching the view from anywhere.
 */
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'ticketReviewAcpAgent.mjs');
const DAY = 86_400_000;
let app: TestApp | undefined;
let folder: string | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function seedRepository(): { root: string; featurePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-what-changed-'));
  const featureDir = path.join(root, 'docs', 'plans', 'features', 'feature-01-intake');
  fs.mkdirSync(featureDir, { recursive: true });
  const featurePath = path.join(featureDir, 'feature.md');
  fs.writeFileSync(featurePath, '# Intake\n\n**Status:** Proposed\n**Type:** Feature\n\n## Description\nIntake.\n');
  fs.writeFileSync(path.join(featureDir, 'task-01-1-wire-the-form.md'), '# Wire the form\n\n**Status:** To Do\n**Type:** Task\n**Parent:** WC-F01\n\n## Description\nForm.\n');
  const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...env } });
  git(['init', '-q']);
  git(['config', 'user.email', 'me@example.com']);
  git(['config', 'user.name', 'Me']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'Plan the intake'], { GIT_AUTHOR_DATE: twoDaysAgo, GIT_COMMITTER_DATE: twoDaysAgo });
  git(['commit', '-q', '--allow-empty', '-m', 'Agent pairing\n\nCo-authored-by: Claude <noreply@anthropic.com>']);
  git(['commit', '-q', '--allow-empty', '-m', 'Teammate fix', '--author', 'Sam Lee <sam@example.com>']);
  return { root, featurePath };
}

test('What Changed records every source, says who made each change, and opens each in one click', async () => {
  test.setTimeout(120_000);
  const seeded = seedRepository();
  folder = seeded.root;
  app = await launchTestApp(
    { ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: FIXTURE_PATH } } } },
    undefined,
    { AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined, FROSTY_VERCEL_API_KEY: undefined }
  );
  const win = app.window;
  const project = await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create({
      name: 'What Changed Demo', key: 'WC', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath, storage: 'folder',
      workflowStages: [
        { id: 'stage-backlog', name: 'Backlog', category: 'todo' }, { id: 'stage-to-do', name: 'To Do', category: 'todo' },
        { id: 'stage-in-progress', name: 'In Progress', category: 'indeterminate' }, { id: 'stage-blocked', name: 'Blocked', category: 'indeterminate' },
        { id: 'stage-done', name: 'Done', category: 'done' }
      ], starterTickets: [], defaultAiToolMode: 'read-only'
    }, workspace.id);
  }, folder);
  const connectionId = `project:${project.id}`;
  // Opening the project loads its board, which starts the plan-folder watcher.
  await win.reload();
  await win.getByTestId('project-tree').filter({ hasText: 'What Changed Demo' }).getByTestId('project-nav-item').click();
  const review = win.getByTestId('project-review-panel');
  await expect(review).toBeVisible();
  const taskKey = await win.evaluate(async id => {
    const { issues } = await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 100, id);
    return issues.find(issue => issue.summary === 'Wire the form')!.key;
  }, connectionId);

  // You: a status change through the ordinary board path.
  await win.evaluate(async ([key, id]) => {
    const details = await window.praxis.issue.get(key, id);
    const transition = details.transitions!.find(candidate => (candidate.toStatus ?? candidate.name) === 'In Progress')!;
    await window.praxis.issue.transition(key, transition.id, id);
  }, [taskKey, connectionId] as const);
  // Outside Praxis: the feature's plan file is edited in another editor.
  fs.appendFileSync(seeded.featurePath, '\nEdited in another editor.\n');
  const entries = () => win.evaluate(id => window.praxis.activity.list(id), project.id).then(snapshot => snapshot.entries);
  await expect.poll(async () => (await entries()).filter(entry => entry.kind === 'plan').length, { timeout: 15_000 }).toBe(1);

  // Agent: a ticket review session, then the update it proposed, applied.
  await win.reload();
  await win.getByTestId('project-tree').filter({ hasText: 'What Changed Demo' }).getByTestId('project-nav-item').click();
  await review.getByRole('button', { name: 'What Changed', exact: true }).click();
  await review.getByTestId('project-review-change').filter({ hasText: 'Status changed · Wire the form' }).getByRole('button', { name: 'Open item', exact: true }).click();
  await win.locator('[data-testid="issue-ai-section"]').waitFor();
  await chooseOption(win.locator('[data-testid="issue-detail-ai-provider"]'), 'claude-code-cli');
  await win.locator('[data-testid="issue-ai-review-btn"]').click();
  await win.locator('[data-testid="ai-review-run"]').click();
  const findings = win.locator('[data-testid="gadget-choice"]');
  await expect(findings).toContainText('Which of these should go into the ticket?', { timeout: 20_000 });
  await findings.getByText('Add acceptance criterion: empty state').click();
  await findings.locator('[data-testid="gadget-action-apply-selected"]').click();
  const form = win.locator('[data-testid="gadget-form"]');
  await expect(form).toContainText('Review the ticket update', { timeout: 20_000 });
  await form.locator('[data-testid="gadget-action-apply"]').click();
  await expect(form.locator('[data-testid="gadget-result"]')).toContainText(`Applied to ${taskKey}`);
  await expect.poll(async () => (await entries()).some(entry => entry.kind === 'issue' && entry.action === 'Updated'), { timeout: 15_000 }).toBe(true);

  const stored = await entries();
  // Praxis's own writes to the task file are items, never also "plan edited outside Praxis".
  expect(stored.filter(entry => entry.kind === 'plan').map(entry => entry.targetKey)).toEqual(['features/feature-01-intake/feature.md']);
  expect(stored.find(entry => entry.kind === 'issue' && entry.action === 'Status changed')?.actor).toBe('you');
  expect(stored.find(entry => entry.kind === 'issue' && entry.action === 'Updated')?.actor).toBe('agent');
  expect(stored.filter(entry => entry.kind === 'session').length).toBeGreaterThan(0);
  expect(stored.filter(entry => entry.kind === 'session').every(entry => entry.actor === 'agent')).toBe(true);

  // Reachable in one interaction from somewhere else entirely (AC8): the Overview page, no project selected.
  await win.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
  await win.getByTestId('nav-overview').click();
  await expect(review).toHaveCount(0);
  await win.getByTestId('titlebar-what-changed').click();
  await expect(review.getByRole('button', { name: 'What Changed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(review).toBeInViewport();

  // Grouped by day, newest first (AC1); the two-day-old commit sits in its own, last group.
  const changes = review.getByTestId('project-review-change');
  await expect(changes.filter({ hasText: 'Plan the intake' })).toHaveCount(1);
  const headings = await review.locator('.project-review-day h3').allTextContents();
  expect(headings[0]).toBe('Today');
  expect(headings.length).toBeGreaterThanOrEqual(2);
  expect(headings.at(-1)).not.toMatch(/^(Today|Yesterday)$/);
  await expect(review.locator('.project-review-day').last()).toContainText('Plan the intake');
  const times = await review.locator('[data-testid="project-review-change"] time').evaluateAll(nodes => nodes.map(node => Date.parse(node.getAttribute('datetime')!)));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  // Relative, not clock, time inside a day group.
  await expect(changes.filter({ hasText: 'Teammate fix' }).locator('time')).toHaveText(/ago|just now/);

  // Who (AC6): you, an agent, a named teammate, an edit outside Praxis — each badged differently.
  const actorOf = (text: string) => changes.filter({ hasText: text }).first().getAttribute('data-actor');
  expect(await actorOf('Status changed · Wire the form')).toBe('you');
  expect(await actorOf('Updated · Wire the form')).toBe('agent');
  expect(await actorOf('Agent pairing')).toBe('agent');
  expect(await actorOf('Plan the intake')).toBe('you');
  expect(await actorOf('Teammate fix')).toBe('external');
  await expect(changes.filter({ hasText: 'Teammate fix' }).locator('.project-review-actor')).toHaveText('Sam Lee');
  await expect(changes.filter({ hasText: 'Plan file edited · Intake' }).locator('.project-review-actor')).toHaveText('Outside Praxis');
  const fills = await review.locator('.project-review-actor').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.className, `${getComputedStyle(node).backgroundColor}|${getComputedStyle(node).borderStyle}`])));
  expect(new Set(Object.values(fills)).size).toBe(3);
  const artifacts = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await review.screenshot({ path: path.join(artifacts, 'what-changed-sources.png') });

  // Source filters (AC4), every v1 source present (AC2).
  for (const [kind, expected] of [['plan', 'Plan file edited · Intake'], ['commit', 'Teammate fix'], ['session', 'Session'], ['issue', 'Status changed · Wire the form']] as const) {
    await chooseOption(review.getByTestId('project-review-source'), kind);
    await expect(changes.filter({ hasText: expected }).first()).toBeVisible();
    expect(new Set(await changes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-kind'))))).toEqual(new Set([kind]));
  }
  await chooseOption(review.getByTestId('project-review-source'), 'all');

  // One click to each subject (AC3): a plan file, a commit.
  await changes.filter({ hasText: 'Plan file edited · Intake' }).getByRole('button', { name: 'Open file', exact: true }).click();
  await expect(win.getByTestId('project-document-preview')).toContainText('Edited in another editor.');
  await changes.filter({ hasText: 'Teammate fix' }).getByRole('button', { name: 'Open commit', exact: true }).click();
  await expect(win.locator('.git-commit-row.selected, .git-horizontal-commit.selected').filter({ hasText: 'Teammate fix' })).toHaveCount(1);
  // ...and back again from the graph, still without a page load.
  await win.getByTestId('titlebar-what-changed').click();
  await expect(review.getByRole('button', { name: 'What Changed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await win.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
});

test('a week of several hundred changes renders and filters without a long main-thread task', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const win = app.window;
  const project = await win.evaluate(async () => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    return window.praxis.projects.create({
      name: 'Busy Project', key: 'BUSY', type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'Explore', category: 'todo' }, { id: 'done', name: 'Published', category: 'done' }],
      starterTickets: [{ summary: 'Shipped', description: '', issueType: 'Task', status: 'Published' }], defaultAiToolMode: 'project-only'
    }, workspaceId);
  });
  // Seed the store directly while the app is stopped: 600 entries across seven days, oldest first as stored.
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const now = Date.now();
  const kinds = ['issue', 'session', 'plan'] as const;
  const seeded = Array.from({ length: 600 }, (_, index) => {
    const timestamp = new Date(now - (600 - index) * (6.9 * DAY / 600)).toISOString();
    return { id: `${timestamp}:${index}`, projectId: project.id, kind: kinds[index % 3], targetKey: `BUSY-${index}`, summary: `Change number ${index}`, action: 'Updated', timestamp, actor: index % 2 ? 'agent' : 'you' };
  });
  fs.writeFileSync(path.join(reuse.userDataDir, 'project-activity.json'), JSON.stringify({ [`activity:${project.id}`]: { startedAt: new Date(now - 8 * DAY).toISOString(), entries: seeded } }));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByTestId('project-tree').filter({ hasText: 'Busy Project' }).getByTestId('project-nav-item').click();
  const review = page.getByTestId('project-review-panel');
  await expect(review.getByRole('button', { name: 'What Changed', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const longest = { value: 0 };
    (window as unknown as { __longest: typeof longest }).__longest = longest;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) longest.value = Math.max(longest.value, entry.duration); }).observe({ type: 'longtask' });
  });
  await review.getByRole('button', { name: 'What Changed', exact: true }).click();
  await expect(review.getByTestId('project-review-change')).toHaveCount(600);
  await chooseOption(review.getByTestId('project-review-source'), 'session');
  await expect(review.getByTestId('project-review-change')).toHaveCount(200);
  await chooseOption(review.getByTestId('project-review-window'), '24h');
  await chooseOption(review.getByTestId('project-review-source'), 'all');
  await chooseOption(review.getByTestId('project-review-window'), '7d');
  await expect(review.getByTestId('project-review-change')).toHaveCount(600);
  // Let the observer flush the last frame's tasks.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50))));
  const longest = await page.evaluate(() => (window as unknown as { __longest: { value: number } }).__longest.value);
  expect(longest, `longest main-thread task while rendering 600 changes: ${longest}ms`).toBeLessThan(100);
});
