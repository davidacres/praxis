import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, showProjectBoard, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

/**
 * FX-BF-047 / FX-BE-147: scheduled ticket runs. Definitions only — nothing here
 * starts a run (the runner is FX-BE-148). Covers the composer (hopper, belt, order),
 * saving, surviving a restart, editing, arming and holding, the missed-start
 * decision, and the preview gate.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
const tempDirs: string[] = [];
const shots = path.resolve(__dirname, '../../.praxis/session-artifacts');

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

interface Launched { page: Page; projectId: string; repo: string }

async function launch(options: { preview?: boolean; provider?: boolean; titles?: string[] } = {}): Promise<Launched> {
  const { preview = true, provider = true, titles = ['Fix pager bug', 'Add export CSV', 'Log retention'] } = options;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-schedule-repo-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');

  mock = provider ? await startMockOpenAiCompatibleServer({ reply: () => 'ok' }) : undefined;
  app = await launchTestApp({
    preview: { enableScheduledRuns: preview },
    ...(mock
      ? {
          ai: {
            activeProvider: 'custom:mock',
            customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }],
            providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } }
          }
        }
      : {})
  }, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const projectId = await page.evaluate(async ({ repoPath, titles }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Schedule Project', key: 'SCH', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: titles.map(summary => ({ summary, description: '', issueType: 'Task', status: 'Backlog' })),
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'schedules' }));
    return project.id;
  }, { repoPath: repo, titles });
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  return { page, projectId, repo };
}

const beltOrder = (page: Page) => page.getByTestId('schedule-belt-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue')));
const miniOrder = (card: ReturnType<Page['locator']>) => card.getByTestId('schedule-mini-belt').locator('li').evaluateAll(items => items.map(item => item.getAttribute('data-issue')));

test('builds a schedule on the belt, saves it, and it survives a restart in the same order', async () => {
  const { page } = await launch();

  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
  await expect(page.getByTestId('schedule-preview-note')).toContainText('cannot start them yet');
  await expect(page.getByTestId('schedule-empty')).toBeVisible();

  await page.getByTestId('schedule-new').click();
  const composer = page.getByTestId('schedule-composer');
  await expect(composer).toBeVisible();
  await expect(page.getByTestId('schedule-hopper-card')).toHaveCount(3);

  // Click adds to the end of the belt; the card in the hopper dims.
  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Log retention' }).click();
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Fix pager bug' }).click();
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Add export CSV' }).click();
  expect(await beltOrder(page)).toHaveLength(3);
  await expect(page.getByTestId('schedule-count')).toHaveText('3 tickets');
  await expect(page.getByTestId('schedule-hopper-card').filter({ hasText: 'Log retention' })).toBeDisabled();

  // The order is ours to change, by button (the keyboard path), and says nothing about the board.
  const first = (await beltOrder(page))[0] as string;
  await page.getByRole('button', { name: `Move ${first} later` }).click();
  const reordered = await beltOrder(page);
  expect(reordered[1]).toBe(first);
  await page.getByRole('button', { name: `Remove ${reordered[2]} from the run` }).click();
  await expect(page.getByTestId('schedule-count')).toHaveText('2 tickets');
  const expected = (await beltOrder(page)) as string[];

  await page.getByTestId('schedule-name').fill('Nightly cleanup');
  await page.getByTestId('schedule-date').fill('2030-01-15');
  await page.getByTestId('schedule-time').fill('22:00');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  // Readiness follows the form after a short debounce: wait until it reflects two tickets, not the three before.
  await expect(page.getByTestId('schedule-readiness').locator('[data-code="no-acceptance-criteria"]')).toContainText('2 tickets');
  await page.screenshot({ path: path.join(shots, 'scheduled-run-composer.png') });
  await page.getByTestId('schedule-save-draft').click();

  const card = page.getByTestId('schedule-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('schedule-card-name')).toHaveText('Nightly cleanup');
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  expect(await miniOrder(card)).toEqual(expected);
  expect(keys.length).toBe(3);

  // Restart: same start, same tickets, same order.
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  const reopened = app.window.getByTestId('schedule-card');
  await expect(reopened).toHaveCount(1, { timeout: 20000 });
  await expect(reopened.getByTestId('schedule-card-name')).toHaveText('Nightly cleanup');
  expect(await miniOrder(reopened)).toEqual(expected);
  await expect(reopened.getByTestId('schedule-start')).toContainText('15 Jan');
  await expect(reopened.getByTestId('schedule-start')).toContainText('22:00');
  await app.window.screenshot({ path: path.join(shots, 'scheduled-run-lineup-draft.png') });
});

test('edit, schedule, hold and delete a schedule', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().click();
  await page.getByTestId('schedule-date').fill('2030-02-01');
  await page.getByTestId('schedule-time').fill('09:30');
  await page.getByTestId('schedule-name').fill('Morning batch');
  // Arming needs a ready run, and this one is: a ticket, a future start, a folder and a provider.
  await expect(page.getByTestId('schedule-save')).toBeEnabled();
  await page.getByTestId('schedule-save').click();

  const card = page.getByTestId('schedule-card');
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');
  await expect(page.getByTestId('schedule-group-upNext')).toBeVisible();

  // Edit adds a second ticket and keeps it scheduled.
  await card.getByTestId('schedule-edit').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await page.getByTestId('schedule-hopper-card').filter({ hasNotText: 'on belt' }).first().click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await page.getByTestId('schedule-save').click();
  await expect(card.getByTestId('schedule-mini-belt').locator('li')).toHaveCount(2);
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');

  await card.getByTestId('schedule-hold').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  await card.getByTestId('schedule-arm').click();
  await expect(card.getByTestId('schedule-status')).toHaveText('Scheduled');

  // Deleting asks first, in the app's own dialog, and leaves the tickets alone.
  await card.getByTestId('schedule-delete').click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(page.getByTestId('schedule-card')).toHaveCount(0);
  await expect(page.getByTestId('schedule-empty')).toBeVisible();
});

test('a start that passed while Praxis was closed is missed, and only a choice resolves it', async () => {
  const { page, projectId } = await launch();
  // Arm a far-future run through the real path, then rewind its start while the app is stopped.
  await page.evaluate(async id => {
    const issues = await window.praxis.issue.list({ projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 10, `project:${id}`);
    const tickets = issues.issues.slice(0, 2).map(issue => ({ connectionId: `project:${id}`, issueKey: issue.key, title: issue.summary }));
    for (const name of ['Missed one', 'Missed two']) {
      await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-03-01', time: '10:00', timezone: 'UTC', tickets, arm: true });
    }
  }, projectId);

  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const run of stored['praxis.scheduledRuns.v1']) run.scheduledStartAt = '2020-01-01T10:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(stored));

  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  const cards = app.window.getByTestId('schedule-card');
  await expect(cards).toHaveCount(2, { timeout: 20000 });
  await expect(cards.getByTestId('schedule-status')).toHaveText(['Missed', 'Missed']);
  await expect(app.window.getByTestId('schedule-group-attention')).toBeVisible();

  // Nothing started on its own: both are still waiting for the user's decision.
  const one = cards.filter({ hasText: 'Missed one' });
  const two = cards.filter({ hasText: 'Missed two' });
  await one.getByTestId('schedule-skip').click();
  await expect(one.getByTestId('schedule-status')).toHaveText('Skipped');
  await two.getByTestId('schedule-start-now').click();
  await expect(two.getByTestId('schedule-status')).toHaveText('Scheduled');
  await expect(two.getByTestId('schedule-start')).not.toContainText('2020');
  // A run started late is due, not invalid: it must not be flagged as having a start in the past.
  await expect(two.locator('[data-code="start-in-past"]')).toHaveCount(0);
  await expect(two).toContainText('due now');
  await app.window.screenshot({ path: path.join(shots, 'scheduled-run-lineup-missed.png') });
});

test('a run with no usable provider cannot be scheduled, and says why', async () => {
  const { page } = await launch({ provider: false });
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().click();
  await expect(page.getByTestId('schedule-readiness')).toContainText('No AI provider is enabled');
  await expect(page.getByTestId('schedule-save')).toBeDisabled();
  // A draft can still be kept while that is fixed.
  await page.getByTestId('schedule-date').fill('2030-04-01');
  await page.getByTestId('schedule-save-draft').click();
  const card = page.getByTestId('schedule-card');
  await expect(card.getByTestId('schedule-status')).toHaveText('Draft');
  await expect(card.getByTestId('schedule-arm')).toBeDisabled();
});

test('the whole surface is hidden until the preview is switched on', async () => {
  const { page } = await launch({ preview: false });
  await expect(page.getByTestId('project-schedules-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('schedules-disabled')).toBeVisible();
  await expect(page.getByTestId('scheduled-runs-page')).toHaveCount(0);
});

test('the board toolbar offers a shortcut to the scheduled runs of its project, only while the preview is on', async () => {
  const { page } = await launch();
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  await page.getByTestId('board-schedule-btn').click();
  await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
});

test('selected board tickets are saved in a new schedule', async () => {
  const { page } = await launch();
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  const cards = page.getByTestId('issue-card');
  await expect(cards).toHaveCount(3);
  await cards.nth(0).click({ modifiers: ['Meta'] });
  await cards.nth(1).click({ modifiers: ['Meta'] });
  await expect(cards.nth(1)).toHaveClass(/selected-for-schedule/);
  await cards.nth(1).click({ button: 'right' });
  await page.screenshot({ path: path.join(shots, 'board-multiselect-schedule-menu.png') });
  await page.getByTestId('board-issue-menu-schedule').click();
  await expect(page.getByRole('heading', { name: 'Add 2 selected tickets' })).toBeVisible();
  await page.getByRole('button', { name: 'Create new schedule' }).click();
  const saved = page.getByTestId('schedule-card');
  await expect(saved).toHaveCount(1);
  await expect(saved.getByTestId('schedule-card-name')).toHaveText('Scheduled run');
  await expect(saved.getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
  await page.screenshot({ path: path.join(shots, 'board-multiselect-new-schedule.png') });
});

test('selected board tickets are appended directly to an existing schedule', async () => {
  const { page, projectId } = await launch();
  await page.evaluate(async id => {
    await window.praxis.scheduledRuns.save({
      projectId: id,
      name: 'Existing schedule',
      date: '2030-01-15',
      time: '22:00',
      timezone: 'UTC',
      tickets: [{ connectionId: `project:${id}`, issueKey: 'SCH-3', title: 'Log retention' }],
      arm: false
    });
  }, projectId);
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  const card = page.locator('[data-testid="issue-card"][data-issue-key="SCH-1"]');
  await card.click({ modifiers: ['Meta'] });
  await card.click({ button: 'right' });
  await page.getByTestId('board-issue-menu-schedule').click();
  await page.getByRole('button', { name: 'Add to “Existing schedule”' }).click();
  const saved = page.getByTestId('schedule-card');
  await expect(saved).toHaveCount(1);
  await expect(saved.getByTestId('schedule-card-name')).toHaveText('Existing schedule');
  await expect(saved.getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
});

test('without the preview the board toolbar has no schedule shortcut', async () => {
  const { page } = await launch({ preview: false });
  if (await page.getByTestId('schedule-sidebar').isVisible()) await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await showProjectBoard(page);
  await page.locator('.project-board-row').first().click();
  await expect(page.getByTestId('board-view')).toBeVisible();
  await expect(page.getByTestId('board-schedule-btn')).toHaveCount(0);
});

test('tickets can be dragged from the hopper onto the belt and reordered on it', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  const hopper = (text: string) => page.getByTestId('schedule-hopper-card').filter({ hasText: text });

  // Dropping on the empty belt appends; dropping on a card inserts before it.
  await hopper('Fix pager bug').dragTo(page.getByTestId('schedule-belt-slot'));
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await hopper('Add export CSV').dragTo(page.getByTestId('schedule-belt-slot'));
  await hopper('Log retention').dragTo(page.getByTestId('schedule-belt-card').first());
  const order = await beltOrder(page) as string[];
  expect(order).toHaveLength(3);
  const titleOf = async (key: string) => page.getByTestId('schedule-belt-card').filter({ has: page.locator(`.schedule-belt-key:text-is("${key}")`) }).locator('.schedule-belt-title').textContent();
  expect(await titleOf(order[0])).toBe('Log retention');
  expect(await titleOf(order[1])).toBe('Fix pager bug');
  expect(await titleOf(order[2])).toBe('Add export CSV');

  // Reorder on the belt: drag the last card onto the first.
  // Let the entry animation of the card just dropped finish, so its position is settled.
  await page.waitForTimeout(800);
  await page.getByTestId('schedule-belt-card').nth(2).dragTo(page.getByTestId('schedule-belt-card').first());
  expect(await titleOf((await beltOrder(page) as string[])[0])).toBe('Add export CSV');
  // A dragged-in ticket cannot be added twice.
  await expect(hopper('Add export CSV')).toBeDisabled();
});

test('dragging a group ticket from the scheduler sidebar adds its unfinished child tickets', async () => {
  const { page, projectId } = await launch();
  const groupKey = await page.evaluate(async id => {
    const connection = `project:${id}`;
    const group = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Feature', summary: 'Release group', description: '' }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Grouped work', description: '', parentKey: group.key }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Other grouped work', description: '', parentKey: group.key }, connection);
    return group.key;
  }, projectId);
  await page.reload();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await page.getByTestId('schedule-new').click();

  const groupTicket = page.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`);
  await expect(groupTicket).toBeVisible();
  await groupTicket.dragTo(page.getByTestId('schedule-belt-slot'));

  const belt = page.getByTestId('schedule-belt');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(belt).toContainText('Grouped work');
  await expect(belt).toContainText('Other grouped work');
  await expect(belt).not.toContainText('Release group');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-dragged-group.png') });
});

/**
 * Opt-in capture of the real screens in the dark theme, for comparing against the mockups in
 * `.praxis/session-artifacts/scheduled-runs-v2/`. Writes PNGs only; it asserts nothing.
 * Run with PRAXIS_SHOTS=1.
 */
test('capture the composer and lineup for visual review (opt-in)', async () => {
  test.skip(!process.env.PRAXIS_SHOTS, 'screenshots are opt-in: set PRAXIS_SHOTS=1');
  const out = path.join(shots, 'scheduled-runs-actual');
  fs.mkdirSync(out, { recursive: true });
  const titles = ['Fix pager bug on session list', 'Add export CSV to usage panel', 'Log retention setting', 'Workflow designer undo', 'Theme token audit', 'Settings search index'];
  const { page, projectId } = await launch({ titles });
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } } as never));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');

  await page.getByTestId('schedule-new').click();
  for (const title of titles.slice(0, 4)) await page.getByTestId('schedule-hopper-card').filter({ hasText: title }).click();
  await page.getByTestId('schedule-name').fill('Nightly API cleanup');
  await page.getByTestId('schedule-date').fill('2030-10-21');
  await page.getByTestId('schedule-time').fill('22:00');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await expect(page.getByTestId('schedule-readiness').locator('[data-code="no-acceptance-criteria"]')).toContainText('4 tickets');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'composer.png') });
  // The processor close-up at two moments of its spin, to see that the rings stay centred.
  await page.getByTestId('schedule-processor').screenshot({ path: path.join(out, 'processor-a.png') });
  await page.waitForTimeout(3500);
  await page.getByTestId('schedule-processor').screenshot({ path: path.join(out, 'processor-b.png') });

  // A realistic lineup: write the runs while the app is stopped, then relaunch.
  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  const conn = `project:${projectId}`;
  const at = new Date().toISOString();
  const entry = (i: number, n: number, outcome?: Record<string, unknown>) => ({ id: `e-${n}-${i}`, sequence: i + 1, ticket: { connectionId: conn, issueKey: keys[i], title: titles[i] }, ...(outcome ? { outcome } : {}) });
  const run = (id: string, name: string, status: string, startMs: number, count: number, outcomes: Array<Record<string, unknown> | undefined> = []) => ({
    schemaVersion: 1, id, projectId, name, scheduledStartAt: new Date(Date.now() + startMs).toISOString(), timezone: 'Europe/London', policy: { mode: 'sequential' },
    entries: Array.from({ length: count }, (_, i) => entry(i, id.length, outcomes[i])), status, attempts: [], createdAt: at, updatedAt: at, events: []
  });
  const H = 3_600_000;
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  fs.writeFileSync(file, JSON.stringify({ 'praxis.scheduledRuns.v1': [
    run('a', 'Sprint 42 batch', 'running', -72 * 60_000, 5, [{ status: 'done' }, { status: 'done' }, { status: 'running' }, undefined, undefined].map(o => o as Record<string, unknown> | undefined)),
    run('b', 'Nightly API cleanup', 'scheduled', 11.8 * H, 3),
    run('c', 'Export spike', 'paused', -2 * H, 1, [{ status: 'paused', reason: 'Waiting at the Review gate' }]),
    run('d', 'Docs sweep', 'missed', -30 * H, 2),
    run('e', 'Release notes', 'draft', 40 * H, 4),
    run('f', 'Hotfix batch', 'completed', -50 * H, 4, [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }])
  ] }));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  if (!(await app.window.getByTestId('schedule-sidebar').isVisible())) await app.window.getByTestId('titlebar-scheduled-runs').click();
  await expect(app.window.getByTestId('schedule-card')).toHaveCount(6, { timeout: 20000 });
  await app.window.waitForTimeout(800);
  await app.window.screenshot({ path: path.join(out, 'lineup.png') });
});

test('the armed processor rings stay concentric while they spin', async () => {
  const { page } = await launch();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().click();
  const centres = () => page.getByTestId('schedule-processor').evaluate(root => {
    const centre = (selector: string) => {
      const box = (root.querySelector(selector) as SVGGraphicsElement).getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    };
    return ['.schedule-proc-track', '.schedule-proc-arc', '.schedule-proc-dots', '.schedule-proc-gear', '.schedule-proc-core'].map(centre);
  });
  // The rings spin for ever, so sample at several moments: a ring that rotates about the wrong point drifts away.
  for (let sample = 0; sample < 4; sample += 1) {
    const all = await centres();
    for (const [x, y] of all) {
      expect(Math.abs(x - all[0][0])).toBeLessThan(1.5);
      expect(Math.abs(y - all[0][1])).toBeLessThan(1.5);
    }
    await page.waitForTimeout(700);
  }
});

test('scheduled runs have a grouped sidebar and project tickets stay outside the main pane', async () => {
  const { page, projectId } = await launch();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await expect(page.locator('.pane-main').getByTestId('schedule-hopper')).toHaveCount(0);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-hopper-card')).toHaveCount(3);
  await page.evaluate(async id => {
    for (const name of ['First schedule', 'Second schedule']) await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-01-15', time: '22:00', timezone: 'UTC', tickets: [], arm: false });
  }, projectId);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.locator('.pane-aux').getByTestId('schedule-nav-run')).toHaveCount(0);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-new')).toHaveCount(1);
  await expect(page.getByTestId('schedule-bucket-today').getByTestId('schedule-nav-run')).toHaveCount(2);
  const runList = await page.locator('.schedule-sidebar-runs').boundingBox();
  const ticketList = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(runList!.y + runList!.height).toBeLessThanOrEqual(ticketList!.y);
  const divider = page.getByRole('separator', { name: 'Resize project tickets section' });
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
  const handle = await divider.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  const expandedTickets = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(expandedTickets!.height).toBeCloseTo(ticketList!.height + 80, 0);
  await divider.focus();
  await divider.press('ArrowDown');
  const resizedTickets = await page.locator('.schedule-sidebar-tickets').boundingBox();
  expect(resizedTickets!.height).toBeCloseTo(expandedTickets!.height - 10, 0);
  await page.reload();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(2);
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(resizedTickets!.height, 0);
  await page.getByTestId('schedule-nav-run').filter({ hasText: 'First schedule' }).click();
  await expect(page.getByTestId('schedule-card')).toHaveCount(1);
  await expect(page.getByTestId('schedule-card-name')).toHaveText('First schedule');
  await page.getByTestId('schedule-hopper-card').filter({ hasText: 'Fix pager bug' }).click();
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  // The secondary pane must not hide the left run list or reset the draft.
  await page.getByTestId('titlebar-aux-toggle').click();
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.getByTestId('schedule-hopper')).toBeVisible();
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await page.getByTestId('titlebar-aux-toggle').click();
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(2);
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await expect(page.locator('.pane-main').getByTestId('schedule-hopper')).toHaveCount(0);
  const ticketHeight = (await page.locator('.schedule-sidebar-tickets').boundingBox())!.height;
  await page.getByRole('button', { name: 'Collapse project tickets section', exact: true }).click();
  await expect(page.getByTestId('schedule-hopper')).toBeHidden();
  await expect(divider).toHaveCount(0);
  await expect(page.getByTestId('schedule-name')).toHaveValue('First schedule');
  await page.screenshot({ path: path.join(shots, 'scheduled-run-tickets-collapsed.png') });
  await page.getByRole('button', { name: 'Expand project tickets section', exact: true }).click();
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(ticketHeight, 0);
  await page.getByRole('button', { name: 'Use full sidebar', exact: true }).click();
  await expect(page.locator('.schedule-sidebar-runs')).toBeHidden();
  await expect(page.getByTestId('schedule-hopper')).toBeVisible();
  await expect(divider).toHaveCount(0);
  const maximized = await page.locator('.schedule-sidebar-tickets').boundingBox();
  const sidebarBounds = await page.getByTestId('schedule-sidebar').boundingBox();
  expect(maximized!.height).toBeGreaterThan(sidebarBounds!.height - 3);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-tickets-maximized.png') });
  await page.getByRole('button', { name: 'Restore sidebar', exact: true }).click();
  await expect(page.locator('.schedule-sidebar-runs')).toBeVisible();
  expect((await page.locator('.schedule-sidebar-tickets').boundingBox())!.height).toBeCloseTo(ticketHeight, 0);
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Filter tickets' }).fill('export');
  await expect(page.getByTestId('schedule-hopper-card')).toHaveCount(1);
  await page.getByTestId('schedule-hopper-card').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await page.getByTestId('schedule-save-draft').click();
  await expect(page.getByTestId('schedule-card').getByTestId('schedule-mini-belt').locator('li[data-issue]')).toHaveCount(2);
  // Apply persisted theme preferences on reload, as the app does at startup.
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } } as never));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.getByTestId('schedule-new').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(0);
  await page.getByTestId('schedule-hopper-card').first().click();
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await page.waitForTimeout(800); // Let the ticket entry animation settle for visual review.
  await page.screenshot({ path: path.join(shots, 'scheduled-run-sidebar-composer.png') });
  await page.getByTestId('schedule-save-draft').click();
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-light', themeMode: 'light' } } as never));
  await page.reload();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-hopper-card').first().click();
  await page.setViewportSize({ width: 1100, height: 650 });
  const tickets = page.getByTestId('schedule-sidebar').getByTestId('schedule-hopper');
  await expect(tickets).toBeVisible();
  const bounds = await tickets.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
  await page.getByRole('textbox', { name: 'Filter tickets' }).fill('retention');
  await page.getByTestId('schedule-hopper-card').click();
  await expect(page.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  const belt = await page.getByTestId('schedule-belt').boundingBox();
  const card = await page.getByTestId('schedule-belt-card').first().boundingBox();
  expect(card!.x + card!.width).toBeLessThanOrEqual(belt!.x + belt!.width);
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, 'scheduled-run-sidebar-light-short.png') });
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await expect(page.getByTestId('schedule-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('project-schedules-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('titlebar-what-changed')).toHaveCount(0);
  await expect(page.getByTestId('titlebar-scheduled-runs')).toHaveCount(1);
  await page.getByTestId('titlebar-scheduled-runs').click();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(3);
  await page.getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.evaluate(() => window.praxis.settings.set({ preview: { enableEasyMode: true } }));
  await expect(page.getByTestId('easymode-sidebar')).toBeVisible();
  await page.getByTestId('titlebar-aux-toggle').click();
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await expect(page.locator('.pane-sidebar')).toHaveCount(0);
  // The titlebar shortcut restores access even when both sidebars were hidden.
  await page.getByTestId('titlebar-scheduled-runs').click();
  await expect(page.getByTestId('schedule-sidebar')).toBeVisible();
  await expect(page.getByTestId('schedule-nav-run')).toHaveCount(3);
  await expect(page.locator('.pane-sidebar').getByTestId('schedule-nav-run')).toHaveCount(3);
  await expect(page.locator('.pane-aux').getByTestId('schedule-nav-run')).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.screenshot({ path: path.join(shots, 'scheduled-run-titlebar-navigation.png') });
});

test('sidebar uses classic recency groups and expands group tickets', async () => {
  const { page, projectId } = await launch();
  const groupKey = await page.evaluate(async id => {
    const connection = `project:${id}`;
    const group = await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Feature', summary: 'Release group', description: '' }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Grouped work', description: '', parentKey: group.key }, connection);
    await window.praxis.issue.create({ projectKey: 'SCH', issueType: 'Task', summary: 'Other grouped work', description: '', parentKey: group.key }, connection);
    for (const name of ['Today run', 'Recent run', 'Old run']) await window.praxis.scheduledRuns.save({ projectId: id, name, date: '2030-01-15', time: '22:00', timezone: 'UTC', tickets: [], arm: false });
    return group.key;
  }, projectId);
  const reuse = { userDataDir: app!.userDataDir, settingsPath: app!.settingsPath };
  await app!.electronApp.close();
  const file = path.join(reuse.userDataDir, 'scheduled-runs.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const run of stored['praxis.scheduledRuns.v1']) {
    if (run.name === 'Recent run') run.updatedAt = new Date(today.getTime() - 2 * 86400000).toISOString();
    if (run.name === 'Old run') run.updatedAt = new Date(today.getTime() - 10 * 86400000).toISOString();
  }
  fs.writeFileSync(file, JSON.stringify(stored));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const reopened = app.window;
  if (!(await reopened.getByTestId('schedule-sidebar').isVisible())) await reopened.getByTestId('titlebar-scheduled-runs').click();
  await expect(reopened.getByTestId('schedule-bucket-today')).toContainText('Today run');
  await expect(reopened.getByTestId('schedule-bucket-this-week')).toContainText('Recent run');
  await expect(reopened.getByTestId('schedule-bucket-last-week')).toContainText('Old run');
  await reopened.getByTestId('schedule-bucket-this-week').getByRole('button', { name: 'This week' }).click();
  await expect(reopened.getByTestId('schedule-bucket-this-week').getByTestId('schedule-nav-run')).toHaveCount(0);
  await reopened.getByTestId('schedule-new').click();
  await reopened.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`).click();
  await expect(reopened.getByTestId('schedule-belt-card')).toHaveCount(2);
  await expect(reopened.getByTestId('schedule-belt')).toContainText('Grouped work');
  await expect(reopened.getByTestId('schedule-belt')).toContainText('Other grouped work');
  await expect(reopened.getByTestId('schedule-ready')).toBeVisible();
  await reopened.waitForTimeout(800);
  const parent = reopened.locator(`[data-testid="schedule-hopper-card"][data-issue="${groupKey}"]`);
  await expect(parent).toHaveClass(/issue-card-parent/);
  const stack = reopened.getByTestId('schedule-ticket-stack');
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await stack.focus();
  await stack.press('Enter');
  await expect(stack).toHaveAttribute('aria-expanded', 'true');
  await expect(stack).toBeFocused();
  await expect(stack).toHaveCSS('outline-style', 'none');
  await expect(stack.locator('.board-child-stack-label')).toHaveCSS('text-decoration-line', 'underline');
  const children = reopened.locator(`[data-testid="schedule-hopper-card"][data-child-of="${groupKey}"]`);
  await expect(children).toHaveCount(2);
  await expect(children.first()).toHaveClass(/issue-card-child/);
  await expect(children.last()).toHaveClass(/issue-card-child-last/);
  // The type badge shares the title row; short compact cards no longer need a metadata row.
  for (const card of [parent, children.first()]) {
    const title = await card.locator('.issue-card-title').boundingBox();
    const badge = await card.locator('.issue-card-context').boundingBox();
    const bounds = await card.boundingBox();
    expect(badge!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
    expect(Math.abs(badge!.y - title!.y)).toBeLessThan(2);
    expect(bounds!.height).toBeLessThan(70);
  }
  await children.last().scrollIntoViewIfNeeded();
  await reopened.waitForTimeout(400);
  await reopened.screenshot({ path: path.join(shots, 'scheduled-run-left-restored-groups.png') });
  await reopened.getByTestId('schedule-hopper').screenshot({ path: path.join(shots, 'scheduled-run-sidebar-clean-seam.png') });
  // Searching for a child retains and reveals its parent context.
  await reopened.getByRole('textbox', { name: 'Filter tickets' }).fill('Other grouped');
  await expect(parent).toBeVisible();
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: 'Other grouped work' })).toBeVisible();
  await stack.click();
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await expect(reopened.getByTestId('schedule-hopper-card').filter({ hasText: 'Other grouped work' })).toHaveCount(0);
});
