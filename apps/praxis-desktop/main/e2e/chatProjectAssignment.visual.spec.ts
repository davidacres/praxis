import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test('assign chat picker and project session placement', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const win = app.window;
  const project = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Research Project', key: 'RSP', type: 'product', purpose: '', brief: {},
      startingPoint: 'app-storage', planningMode: 'files',
      workflowStages: [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'done', name: 'Done', category: 'done' }
      ],
      starterTickets: [{ summary: 'Explore assignment', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
    return { ...project, ticketKey: project.workItems[0]?.key };
  });
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const now = new Date().toISOString();
  const sessionKey = 'SESSION-abc123';
  const ticketSessionKey = 'SESSION-def456';
  fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
    [sessionKey]: { issueKey: sessionKey, sessionId: 'assignment-chat', title: 'Research notes', state: 'completed', startedAt: now,
      completedAt: now, provider: 'claude', taskDefinition: { goal: 'Research notes', sessionMode: 'chat' }, events: [] },
    [ticketSessionKey]: { issueKey: ticketSessionKey, sessionId: 'assignment-ticket-chat', title: 'Ticket research notes', state: 'completed', startedAt: now,
      completedAt: now, provider: 'claude', taskDefinition: { goal: 'Ticket research notes', sessionMode: 'chat' }, events: [] }
  } }));
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  await app.window.evaluate(async issueKey => {
    const workspace = (await window.praxis.workspaces.list())[0];
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ feature: 'conversations', sessionKey: issueKey }));
  }, sessionKey);
  await app.window.reload();
  const page = app.window;
  const generalChatRow = page.getByTestId('session-list-row').filter({ hasText: /^Research notes/ });
  await generalChatRow.hover();
  await expect(generalChatRow.getByTestId('session-actions-menu')).toBeVisible();
  await generalChatRow.getByTestId('session-actions-menu').click();
  await expect(page.getByTestId('session-actions-menu-popover')).toBeVisible();
  await page.getByTestId('session-assign-project-menu-item').click();
  await expect(page.getByTestId('assign-chat-dialog')).toBeVisible();
  await expect(page.getByText('Project', { exact: true })).toBeVisible();
  await expect(page.getByText('Ticket (optional)', { exact: true })).toBeVisible();
  const projectSelector = page.getByTestId('assign-chat-project-select');
  await projectSelector.click();
  await page.getByRole('option', { name: project.name }).click();
  const ticketSelector = page.getByTestId('assign-chat-ticket-select');
  await expect(projectSelector).toContainText(project.name);
  await expect(ticketSelector).toContainText('General');
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/chat-project-assignment-dialog.png') });
  await page.getByTestId('assign-chat-confirm').click();
  const projectTree = page.getByTestId('project-tree').filter({ hasText: project.name });
  const generalSessions = projectTree.getByTestId('project-general-sessions-nav-item');
  await expect(generalSessions).toContainText('1');
  const generalSession = projectTree.getByTestId('project-session-nav-item').filter({ hasText: 'Research notes' });
  await expect(generalSession).toBeVisible();
  await expect(generalSession.locator('.tree-icon')).toHaveAttribute('title', 'General chat session');
  await generalSession.click();
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/chat-project-assigned-general.png') });

  const ticketChatRow = page.getByTestId('session-list-row').filter({ hasText: 'Ticket research notes' });
  await expect(ticketChatRow).toBeVisible();
  await ticketChatRow.hover();
  await expect(ticketChatRow.getByTestId('session-assign-btn')).toBeVisible();
  await expect(ticketChatRow.getByTestId('session-assign-btn')).toHaveAttribute('title', 'Assign to ticket');
  await ticketChatRow.getByTestId('session-actions-menu').click();
  await page.getByTestId('session-assign-project-menu-item').click();
  await expect(page.getByTestId('assign-chat-dialog')).toBeVisible();
  await page.getByTestId('assign-chat-project-select').click();
  await page.getByRole('option', { name: project.name }).click();
  const ticketKey = project.ticketKey!;
  await ticketSelector.click();
  await page.getByRole('option', { name: new RegExp(ticketKey) }).click();
  await expect(ticketSelector).toContainText(ticketKey);
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/chat-project-assignment-ticket-selected.png') });
  await page.getByTestId('assign-chat-confirm').click();
  await expect(projectTree.getByTestId('project-ticket-sessions-nav-item')).toContainText('1');
  const ticketSession = projectTree.getByTestId('project-session-nav-item').filter({ hasText: 'Ticket research notes' });
  await expect(ticketSession).toBeVisible();
  await expect(ticketSession).toContainText(ticketKey);
  await expect(ticketSession.locator('.tree-icon')).toHaveAttribute('title', `Linked to ${ticketKey}`);
  await ticketSession.click();
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/chat-project-assigned-ticket.png') });
});

/**
 * Regression coverage for `storage: 'folder'` projects: `project.workItems` is
 * always empty there (the plans tree is the source of truth, served by
 * `FolderService`), so the Ticket field must fetch tickets through
 * `issue.list` on the project's own connection rather than reading
 * `project.workItems` directly, or it silently only ever offers "General".
 */
test('assign chat ticket field lists tickets for a folder-backed project', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-assign-folder-project-'));
  const featureFolder = path.join(folder, 'docs', 'plans', 'features', 'feature-01-imported');
  fs.mkdirSync(featureFolder, { recursive: true });
  fs.writeFileSync(path.join(featureFolder, 'feature.md'), [
    '# Imported planning work', '', '**Status:** 🚧 In Progress', '**Type:** Feature', '',
    '## Description', '', 'This should appear in the ticket picker.', ''
  ].join('\n'));
  try {
    app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
    const project = await app.window.evaluate(async folderPath => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create({
        name: 'Imported Folder Project', key: 'IFP', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath, storage: 'folder',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspace.id);
      return project;
    }, folder);
    const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
    await app.electronApp.close();
    const now = new Date().toISOString();
    const sessionKey = 'SESSION-folder-chat';
    fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
      [sessionKey]: { issueKey: sessionKey, sessionId: 'assignment-folder-chat', title: 'Folder project notes', state: 'completed', startedAt: now,
        completedAt: now, provider: 'claude', taskDefinition: { goal: 'Folder project notes', sessionMode: 'chat' }, events: [] }
    } }));
    app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
    await app.window.evaluate(async issueKey => {
      const workspace = (await window.praxis.workspaces.list())[0];
      localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ feature: 'conversations', sessionKey: issueKey }));
    }, sessionKey);
    await app.window.reload();
    const page = app.window;
    const chatRow = page.getByTestId('session-list-row').filter({ hasText: 'Folder project notes' });
    await chatRow.hover();
    await chatRow.getByTestId('session-actions-menu').click();
    await page.getByTestId('session-assign-project-menu-item').click();
    await expect(page.getByTestId('assign-chat-dialog')).toBeVisible();
    await page.getByTestId('assign-chat-project-select').click();
    await page.getByRole('option', { name: project.name }).click();
    const ticketSelector = page.getByTestId('assign-chat-ticket-select');
    await ticketSelector.click();
    await expect(page.getByRole('option', { name: /Imported planning work/ })).toBeVisible();
    await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/chat-project-assignment-folder-tickets.png') });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
