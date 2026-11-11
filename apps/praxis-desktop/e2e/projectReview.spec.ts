import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption, chipOptionValues } from './chipSelect';
import { openProjectPage } from './navigation';

let app: TestApp;
test.afterEach(async () => { if (app) await closeTestApp(app); });

// A project's Daily Review is one of its own palette destinations.
async function openProjectHome(page: Page, name: string): Promise<void> {
  await openProjectPage(page, name, 'Daily Review');
}

test('project review scopes history, surfaces blocked and stale work, and acts through the board rules', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const result = await page.evaluate(async () => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    const create = (name: string, key: string) => window.praxis.projects.create({
      name, key, type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'Explore', category: 'todo' }, { id: 'blocked', name: 'Blocked', category: 'indeterminate' }, { id: 'done', name: 'Published', category: 'done' }],
      // Finished starter work must never be flagged as inactive.
      starterTickets: [{ summary: `${name} kickoff`, description: '', issueType: 'Task', status: 'Published' }], defaultAiToolMode: 'project-only'
    }, workspaceId);
    const first = await create('Review Alpha', 'REVA');
    const second = await create('Review Beta', 'REVB');
    // Only finished work: the review's empty state.
    await create('Review Gamma', 'REVG');
    await window.praxis.activity.list(first.id);
    const issue = await window.praxis.issue.create({ projectKey: first.key, issueType: 'Task', summary: 'Revisit the research', description: '' }, `project:${first.id}`);
    const waiting = await window.praxis.issue.create({ projectKey: first.key, issueType: 'Task', summary: 'Waiting on data', description: '' }, `project:${first.id}`);
    await window.praxis.issue.transition(waiting.key, 'blocked', `project:${first.id}`);
    await window.praxis.issue.create({ projectKey: second.key, issueType: 'Task', summary: 'Private beta research', description: '' }, `project:${second.id}`);
    return { first, second, issue };
  });
  await expect.poll(async () => (await page.evaluate(id => window.praxis.activity.list(id), result.first.id)).entries.length).toBe(3);
  const secondHistory = await page.evaluate(id => window.praxis.activity.list(id), result.second.id);
  expect(secondHistory.entries.map(entry => entry.summary)).toEqual(['Private beta research']);
  await page.clock.install({ time: new Date(Date.now() + 8 * 86_400_000) });
  await page.reload();
  await openProjectHome(page, 'Review Alpha');
  const review = page.getByTestId('project-review-panel');
  await expect(review).toContainText('1 blocked · 2 inactive for at least 7 days');
  await expect(review).not.toContainText('Private beta research');
  await expect(review).not.toContainText('Review Alpha kickoff');
  const rows = review.getByTestId('project-review-item');
  // Blocked work leads, with its reason stated.
  await expect(rows.first()).toContainText('Waiting on data');
  await expect(rows.first().getByTestId('project-review-reason')).toHaveText(['Blocked', 'Aging']);
  await expect(rows.first()).toContainText('Stage: Blocked · 8 days since last activity');
  // No reason was recorded for this blocker, and the row says so rather than leaving a gap.
  await expect(rows.first().getByTestId('project-review-blocker')).toHaveText('No blocker reason recorded');

  // What Changed: the eight-day-old history sits outside the default 7-day window until widened.
  await review.getByRole('button', { name: 'What Changed', exact: true }).click();
  await expect(review).toContainText('No recorded changes in this window');
  await review.getByRole('button', { name: 'Show last 30 days', exact: true }).click();
  await expect(review).toContainText('Created · Revisit the research');
  await expect(review).toContainText('Status changed · Waiting on data');
  await chooseOption(review.getByTestId('project-review-source'), 'session');
  await expect(review).toContainText('No recorded changes in this window');
  await chooseOption(review.getByTestId('project-review-source'), 'all');
  const artifacts = path.resolve('../../..', '.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await review.screenshot({ path: path.join(artifacts, 'project-what-changed.png') });

  await review.getByRole('button', { name: 'Daily Review', exact: true }).click();
  const revisit = rows.filter({ hasText: 'Revisit the research' });
  // A backend that cannot take the note refuses it by name and keeps the text.
  await revisit.getByRole('button', { name: 'Add note', exact: true }).click();
  await revisit.getByLabel(`Note for ${result.issue.key}`).fill('Check with the data team');
  await revisit.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(revisit.getByRole('alert')).toHaveText('Comments are not available on local project tickets yet.');
  await expect(revisit.getByLabel(`Note for ${result.issue.key}`)).toHaveValue('Check with the data team');
  await review.screenshot({ path: path.join(artifacts, 'project-daily-review.png') });
  // Moving through the board's own transition resolves the item out of the review.
  // Driven by hand rather than chooseOption: the row (and its chip) unmounts once the move lands,
  // which races that helper's closed-check.
  const move = revisit.getByTestId('project-review-move');
  await move.click();
  await page.locator(`[id="${await move.getAttribute('aria-controls')}"] [role="option"][data-value="done"]`).click();
  await expect(revisit).toHaveCount(0);
  await expect(review).toContainText('1 blocked · 1 inactive for at least 7 days');

  // Done reviewing holds for the day, across a reload.
  await review.getByRole('button', { name: 'Done reviewing', exact: true }).click();
  await expect(review.getByTestId('project-review-reviewed')).toBeVisible();
  await page.reload();
  await openProjectHome(page, 'Review Alpha');
  await expect(review.getByTestId('project-review-reviewed')).toBeVisible();
  await review.getByRole('button', { name: 'Show 1 item', exact: true }).click();
  await rows.first().getByRole('button', { name: 'Open item', exact: true }).click();
  await expect(page.getByText('Waiting on data', { exact: true }).first()).toBeVisible();

  await openProjectHome(page, 'Review Gamma');
  await expect(review).toContainText('Nothing overdue or blocked.');
  // The empty state's link really leaves for the board.
  await review.getByRole('button', { name: 'Open board', exact: true }).click();
  await expect(review).toHaveCount(0);
});

/** Moves one review row through its own "Move to" chip by transition id; driven by hand because the row may unmount on success. */
async function moveRow(page: TestApp['window'], row: ReturnType<TestApp['window']['locator']>, transitionId: string) {
  const move = row.getByTestId('project-review-move');
  await move.click();
  await page.locator(`[id="${await move.getAttribute('aria-controls')}"] [role="option"][data-value="${transitionId}"]`).click();
}

test('daily review: a configurable aging rule, a re-opened review for new blockers, board-only moves, and a ten-item pass with no page load', async () => {
  test.setTimeout(120_000);
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const project = await page.evaluate(async () => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    return window.praxis.projects.create({
      name: 'Review Ten', key: 'TEN', type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'Explore', category: 'todo' }, { id: 'blocked', name: 'Blocked', category: 'indeterminate' }, { id: 'done', name: 'Published', category: 'done' }],
      starterTickets: Array.from({ length: 10 }, (_, index) => ({ summary: `Stale item ${index + 1}`, description: '', issueType: 'Task', status: 'Explore' })),
      defaultAiToolMode: 'project-only'
    }, workspaceId);
  });
  const connectionId = `project:${project.id}`;
  await page.clock.install({ time: new Date(Date.now() + 8 * 86_400_000) });
  await page.reload();
  const openProject = () => openProjectHome(page, 'Review Ten');
  await openProject();
  const review = page.getByTestId('project-review-panel');
  const rows = review.getByTestId('project-review-item');
  await expect(review).toContainText('0 blocked · 10 inactive for at least 7 days');

  // AC1: the aging rule is the user's to set, and it sticks.
  await chooseOption(review.getByTestId('project-review-aging'), '14');
  await expect(review).toContainText('0 blocked · 0 inactive for at least 14 days');
  await expect(review).toContainText('Nothing overdue or blocked.');
  await page.reload();
  await openProject();
  await expect(review.getByTestId('project-review-aging')).toHaveAttribute('data-value', '14');
  await chooseOption(review.getByTestId('project-review-aging'), '7');
  await expect(rows).toHaveCount(10);

  // AC8: "Move to" offers exactly the board's own transitions for the item, never its current stage.
  const firstKey = (await rows.first().locator('strong').textContent())!.split(' · ')[0];
  const boardTransitions = await page.evaluate(([key, id]) => window.praxis.issue.get(key, id).then(details => details.transitions!.map(transition => transition.id)), [firstKey, connectionId] as const);
  await expect.poll(() => chipOptionValues(rows.first().getByTestId('project-review-move'))).toEqual(boardTransitions);
  expect(boardTransitions).not.toContain('todo');

  // AC4: done for today...
  await review.getByRole('button', { name: 'Done reviewing', exact: true }).click();
  await expect(review.getByTestId('project-review-reviewed')).toBeVisible();
  // ...until something new is blocked elsewhere (AC5: the list is rebuilt from the board on open).
  await page.evaluate(async ([key, id]) => {
    const created = await window.praxis.issue.create({ projectKey: key, issueType: 'Task', summary: 'Newly blocked elsewhere', description: '' }, id);
    await window.praxis.issue.transition(created.key, 'blocked', id);
  }, [project.key, connectionId] as const);
  await page.getByTestId('titlebar-home').click();
  await expect(review).toHaveCount(0);
  await openProject();
  await expect(review.getByTestId('project-review-reviewed')).toHaveCount(0);
  await expect(rows.first()).toContainText('Newly blocked elsewhere');
  await expect(rows).toHaveCount(11);

  // AC6: a typical review — act on every item — well inside two minutes, without a page load.
  await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true; });
  const started = Date.now();
  // Resolving the one new item leaves only what was already reviewed today, so the review folds away again (AC4).
  await moveRow(page, rows.first(), 'done');
  await expect(review.getByTestId('project-review-reviewed')).toBeVisible();
  await review.getByRole('button', { name: 'Show 10 items', exact: true }).click();
  for (let remaining = 10; remaining > 0; remaining--) {
    await moveRow(page, rows.first(), 'done');
    await expect(rows).toHaveCount(remaining - 1);
  }
  const elapsed = Date.now() - started;
  expect(elapsed, `eleven review actions took ${elapsed}ms`).toBeLessThan(60_000);
  await expect(review).toContainText('Nothing overdue or blocked.');
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
});

test('moving an item to Blocked from the review asks why, and the reason is kept with the item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-review-blocker-'));
  const featureDir = path.join(root, 'docs', 'plans', 'features', 'feature-01-intake');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.md'), '# Intake\n\n**Status:** Proposed\n**Type:** Feature\n\n## Description\nIntake.\n');
  const taskPath = path.join(featureDir, 'task-01-1-wire-the-form.md');
  fs.writeFileSync(taskPath, '# Wire the form\n\n**Status:** To Do\n**Type:** Task\n**Parent:** BLK-F01\n\n## Description\nForm.\n');
  try {
    app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
    const page = app.window;
    await page.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      await window.praxis.projects.create({
        name: 'Review Blocker', key: 'BLK', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, storage: 'folder',
        workflowStages: [
          { id: 'stage-backlog', name: 'Backlog', category: 'todo' }, { id: 'stage-to-do', name: 'To Do', category: 'todo' },
          { id: 'stage-in-progress', name: 'In Progress', category: 'indeterminate' }, { id: 'stage-blocked', name: 'Blocked', category: 'indeterminate' },
          { id: 'stage-done', name: 'Done', category: 'done' }
        ], starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspaceId);
    }, root);
    await page.clock.install({ time: new Date(Date.now() + 8 * 86_400_000) });
    await page.reload();
    const openProject = () => openProjectHome(page, 'Review Blocker');
    await openProject();
    const review = page.getByTestId('project-review-panel');
    const task = review.getByTestId('project-review-item').filter({ hasText: 'Wire the form' });
    await expect(task.getByTestId('project-review-reason')).toHaveText(['Aging']);

    await chooseOption(task.getByTestId('project-review-move'), { label: 'Blocked' });
    const reason = task.getByRole('textbox', { name: /^Blocker reason for / });
    await expect(reason).toBeFocused();
    await reason.fill('Waiting on API keys');
    await task.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(task.getByTestId('project-review-blocker')).toHaveText('Blocker: Waiting on API keys');
    await expect(task.getByTestId('project-review-reason')).toHaveText(['Blocked', 'Aging']);
    await expect.poll(() => fs.readFileSync(taskPath, 'utf8')).toContain('Blocked: Waiting on API keys');

    // The reason is the item's, not the page's: it survives a reload.
    await page.reload();
    await openProject();
    await expect(task.getByTestId('project-review-blocker')).toHaveText('Blocker: Waiting on API keys');
    // Still actionable after the reload: the reason travels with the item's transitions, not instead of them.
    await expect(task.getByTestId('project-review-move')).toBeEnabled();
    fs.mkdirSync(path.resolve(__dirname, '../../../../.praxis/session-artifacts'), { recursive: true });
    await review.screenshot({ path: path.resolve(__dirname, '../../../../.praxis/session-artifacts/daily-review-blocker.png') });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('daily review previews only the five most recently active unfinished project sessions', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const projectId = await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({
      name: 'Recent sessions review', key: 'REC', type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Completed kickoff', description: '', issueType: 'Task', status: 'Done' }], defaultAiToolMode: 'read-only'
    }, workspace.id)).id;
  });
  await app.electronApp.evaluate(({ ipcMain }, projectId) => {
    const records = Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      const at = new Date(Date.now() - (10 - number) * 3_600_000).toISOString();
      return {
        issueKey: `SESSION-recent-${number}`, sessionId: `recent-${number}`, title: `Pending session ${number}`,
        projectId: number === 9 ? 'other-project' : projectId, state: number === 8 ? 'completed' : 'waiting_for_input',
        provider: 'claude', startedAt: at, taskDefinition: { goal: `Review session ${number}`, sessionMode: 'task' },
        events: number === 2 ? [{ type: 'text', text: 'Recent activity', timestamp: new Date().toISOString() }] : []
      };
    });
    ipcMain.removeHandler('ai:listSessions');
    ipcMain.handle('ai:listSessions', () => records);
  }, projectId);
  await page.reload();
  await openProjectHome(page, 'Recent sessions review');
  const review = page.getByTestId('project-review-panel');
  await expect(review).toContainText('7 unfinished sessions');
  const sessions = review.getByTestId('project-review-sessions').locator('li');
  await expect(sessions).toHaveCount(5);
  await expect(sessions.locator('strong')).toHaveText(['Pending session 2', 'Pending session 7', 'Pending session 6', 'Pending session 5', 'Pending session 4']);
  await expect(review).toContainText('Showing the 5 most recently active of 7 unfinished sessions.');
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await review.screenshot({ path: path.join(artifacts, 'project-review-recent-sessions.png') });
  await review.getByRole('button', { name: 'View all sessions', exact: true }).click();
  await expect(review).toHaveCount(0);
  // The sidebar's session list collapses to the most recent few; expanding it shows every one.
  await page.getByTestId('easymode-sessions-show-more').click();
  await expect(page.getByTestId('easymode-sessions-list').locator('[data-testid^="easymode-session-card-"]')).toHaveCount(8);
});
