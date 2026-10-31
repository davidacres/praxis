import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, dismissSplash } from './launchTestApp';
import { chooseOption } from './chipSelect';

test('What Changed ledger keeps home intact and opens recorded evidence', async () => {
  const app = await launchTestApp({ appearance: { themeId: 'tm-default-2', themeMode: 'dark' } }, undefined, undefined, { openNewSession: false });
  const page = app.window;
  try {
    const project = await page.evaluate(async () => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const p = await window.praxis.projects.create({ name: 'Praxis Desktop', key: 'LEDGER', type: 'product', purpose: 'Make agent work visible and easy to review.', brief: {}, startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'blocked', name: 'Blocked', category: 'indeterminate' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: [{ summary: 'Workspace improvements', description: '', issueType: 'Task', status: 'Done' }], defaultAiToolMode: 'read-only' }, workspace.id);
      await window.praxis.activity.list(p.id);
      const ticket = await window.praxis.issue.create({ projectKey: p.key, issueType: 'Task', summary: 'Confirm recovery behaviour after restart', description: '' }, `project:${p.id}`);
      await window.praxis.issue.transition(ticket.key, 'blocked', `project:${p.id}`);
      await window.praxis.issue.create({ projectKey: p.key, issueType: 'Task', summary: 'Review session shelf dismissal', description: '' }, `project:${p.id}`);
      return p;
    });
    await page.reload(); await dismissSplash(page);
    await chooseOption(page.getByTestId('sidebar-project-select'), project.id);
    await expect(page.getByTestId('easymode-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'What Changed', exact: true }).click();
    const ledger = page.getByTestId('project-review-panel');
    await expect(ledger).toHaveClass(/outcome-ledger/);
    await expect(ledger.getByTestId('project-review-change')).toHaveCount(3);
    await expect(ledger.getByRole('complementary')).toContainText('Confirm recovery behaviour');
    await expect(ledger).toContainText('Resume context');
    await chooseOption(ledger.getByTestId('project-review-source'), 'commit');
    await expect(ledger).toContainText('No recorded changes');
    await chooseOption(ledger.getByTestId('project-review-source'), 'all');
    const dir = path.resolve(__dirname, '../../.praxis/session-artifacts'); fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'outcome-ledger-dark.png') });
    await page.reload(); await dismissSplash(page);
    await expect(page.getByTestId('project-review-panel')).toHaveClass(/outcome-ledger/);
    await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 820); });
    await page.screenshot({ path: path.join(dir, 'outcome-ledger-compact.png') });
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByTestId('project-review-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'What Changed', exact: true }).click();
    await page.getByTestId('project-review-change').first().getByRole('button', { name: 'Open item' }).click();
    await expect(page.getByTestId('project-review-panel')).toHaveCount(0);
  } finally { await closeTestApp(app); }
});
