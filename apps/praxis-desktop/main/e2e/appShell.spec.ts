import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * Full-window captures of the new features inside the normal app shell —
 * titlebar with the panel toggles, the left project tree, and the centre pane.
 * The feature specs snapshot only the content pane; this one shows the whole
 * window so the shell integration is visible at a glance.
 */

test.slow();

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });

  // A global agent + skill so the Agent Hub shows real content, not the empty state.
  const agentDir = path.join(app.userDataDir, 'agents', 'praxis-reviewer');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id: 'praxis-reviewer', name: 'Praxis Reviewer', type: 'acp', entry: { command: 'node', args: ['review.js'] } }, null, 2)
  );
  const skillDir = path.join(app.userDataDir, 'skills', 'code-audit');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: code-audit\ndescription: Audits a diff for risky changes.\ntriggers: review, audit\n---\nInstructions.');

  await app.window.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Delivery Project',
        key: 'DELIV',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'backlog', name: 'Backlog' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('the Agent Hub and Workflow designer sit inside the normal app shell', async () => {
  const page = app.window;

  // Agent Hub — reached from the Agents entry in the features list.
  await page.getByTestId('nav-agents').click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Refresh/ }).click();
  await expect(page.getByRole('navigation', { name: 'Agent catalog' }).getByRole('button', { name: /Praxis Reviewer/ })).toBeVisible();
  await expect(page).toHaveScreenshot('app-shell-agents.png');

  // Workflow designer — created from the project's Workflows tree section, with
  // the stage inspector filling the shell's right pane.
  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).getByRole('button', { name: 'Use' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('application', { name: 'Workflow canvas' }).getByRole('button', { name: /^Plan \(agent-task\)/ })
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stage inspector' })).toBeVisible();
  await expect(page).toHaveScreenshot('app-shell-workflows.png');
});
