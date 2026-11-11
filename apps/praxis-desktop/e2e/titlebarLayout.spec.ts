import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, dismissSplash, launchTestApp } from './launchTestApp';

test('titlebar scheduled-runs shortcut stays clickable at medium window widths', async () => {
  const app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  try {
    await page.evaluate(async () => {
      const workspace = (await window.praxis.workspaces.list())[0];
      await window.praxis.projects.create({
        name: 'P', key: 'P', type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: [{ summary: 'Example ticket', description: '', issueType: 'Task', status: 'To do' }], defaultAiToolMode: 'read-only'
      }, workspace.id);
    });
    await page.reload();
    await dismissSplash(page);
    for (const width of [1100, 1400]) {
      await page.setViewportSize({ width, height: 700 });
      const shortcut = page.getByTestId('titlebar-scheduled-runs');
      await expect(shortcut).toBeVisible();
      await expect(page.getByTestId('titlebar-what-changed')).toBeVisible();
      const doesNotOverlap = await page.evaluate(() => {
        const center = document.querySelector('.titlebar-crumb')?.getBoundingClientRect();
        const scheduled = document.querySelector('[data-testid="titlebar-scheduled-runs"]')?.getBoundingClientRect();
        return !!center && !!scheduled && (center.right <= scheduled.left || scheduled.right <= center.left);
      });
      expect(doesNotOverlap, `titlebar groups overlap at ${width}px`).toBe(true);
      if (width === 1100) {
        const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
        fs.mkdirSync(artifacts, { recursive: true });
        await page.screenshot({ path: path.join(artifacts, 'scheduled-runs-titlebar.png') });
      }
      await shortcut.click();
      await expect(page.getByTestId('scheduled-runs-page')).toBeVisible();
      await page.getByRole('button', { name: 'Back to project', exact: true }).click();
    }
  } finally {
    await closeTestApp(app);
  }
});
