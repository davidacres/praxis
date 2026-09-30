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

  // A global agent + skill so Agent Runtime shows real content, not the empty state.
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
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('agent records and the Workflow designer sit inside the normal app shell', async () => {
  const page = app.window;

  // Agent Runtime settings owns catalog navigation; the centre carries records
  // and the right pane the runtime, without an Agent Hub sidebar entry.
  await page.evaluate(async () => window.praxis.agentRuntime.refresh());
  await page.reload();
  await expect(page.getByTestId('nav-agents')).toHaveCount(0);
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-agent-runtime').click();
  await page.getByTestId('agent-runtime-profile-praxis-reviewer').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Praxis Reviewer', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent runtime' })).toBeVisible();
  // Give the centre/right panes a moment to settle before a whole-page screenshot.
  await page.waitForTimeout(300);
  // The catalog source path is a per-run temp directory, so it is masked out.
  await expect(page).toHaveScreenshot('app-shell-agents.png', { mask: [page.locator('.agent-path')] });

  // Workflow designer — created from the project's Workflows tree section, with
  // the stage inspector filling the shell's right pane.
  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  // The dialog's footer carries one "Use" button naming the selected template
  // (it spans the whole footer now, not one per list item — see
  // NewWorkflowDialog.tsx's footer-bar comment).
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).click();
  await dialog.getByRole('button', { name: 'Use "Governed delivery"' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('application', { name: 'Workflow canvas' }).getByRole('button', { name: /^Plan \(agent-task\)/ })
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stage inspector' })).toBeVisible();
  await expect(page).toHaveScreenshot('app-shell-workflows.png');
});
