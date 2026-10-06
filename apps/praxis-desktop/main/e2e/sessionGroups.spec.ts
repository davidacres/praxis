import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Locator } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

const sessionKey = (kind: string, index: number) => `SESSION-${({ chat: 'aaaaa', general: 'bbbbb', ticket: 'ccccc' } as Record<string, string>)[kind]}${index}`;
let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

// Real HTML drag events, including target geometry: centre groups, edges reorder.
async function drag(source: Locator, target: Locator, edge = false) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('Missing drop target');
  await source.dragTo(target, { targetPosition: { x: box.width / 2, y: edge ? 2 : box.height / 2 } });
}

test('chat and project session groups reorder, rename inline, and persist', async () => {
  test.setTimeout(90000);
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1664, 1200);
  });
  const projectId = await app.window.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({ name: 'Grouped sessions', key: 'GRP', type: 'product', purpose: '', brief: {},
      startingPoint: 'app-storage', planningMode: 'files', workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'read-only' }, workspace.id);
    return project.id;
  });
  await app.window.evaluate(() => localStorage.setItem('tm-pane-sidebar-praxis', '550'));
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const now = new Date().toISOString();
  const records = Object.fromEntries(['chat', 'general', 'ticket'].flatMap(kind => [1, 2, 3].map(index => {
    const issueKey = sessionKey(kind, index);
    return [issueKey, { issueKey, sessionId: issueKey, title: `${kind} ${index}`, state: 'completed', startedAt: now, completedAt: now,
      provider: 'claude', projectId: kind === 'chat' ? undefined : projectId, linkedIssueKey: kind === 'ticket' ? `GRP-${index}` : undefined,
      taskDefinition: { goal: `${kind} ${index}`, sessionMode: kind === 'chat' ? 'chat' : 'task' }, events: [] }];
  })));
  fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': records }));
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1664, 1200); });
  let page = app.window;
  await page.getByTestId('nav-conversations').click();
  // Fault injection proves the reorder guard fails when native dragging is disabled.
  if (process.env.PRAXIS_GROUP_DRAG_FAULT === '1') {
    await page.evaluate(() => document.addEventListener('dragstart', event => event.preventDefault(), true));
  }
  for (const kind of ['chat', 'general', 'ticket']) {
    const scope = kind === 'chat' ? 'nav-conversations' : `project:${projectId}:${kind}`;
    const list = page.locator(`[data-testid="session-organizer"][data-scope="${scope}"]`);
    await expect(list).toHaveAttribute('data-scope', scope);
    const row = (index: number) => list.locator(`[data-session-order-id="${sessionKey(kind, index)}"]`);
    await drag(row(3), row(1), true);
    await expect(list.locator(':scope > .session-organizer-item').first()).toHaveAttribute('data-session-order-id', sessionKey(kind, 3));
    await drag(row(1), row(2));
    const input = list.getByTestId('session-group-name-input');
    await expect(input).toBeVisible();
    await input.fill(`${kind} research`);
    await input.press('Enter');
    const group = list.getByTestId('session-custom-group');
    await expect(group).toContainText(`${kind} research`);
    await expect(list.locator('.session-organizer-members > .session-organizer-item')).toHaveCount(2);
    await drag(row(3), group);
    await expect(list.locator('.session-organizer-members > .session-organizer-item')).toHaveCount(3);
    await drag(row(3), group, true);
    await expect(list.locator('.session-organizer-members > .session-organizer-item')).toHaveCount(2);
    await drag(group, row(3), true);
    await expect(list.locator(':scope > [data-session-order-id]').first()).toHaveAttribute('data-testid', 'session-custom-group');
    await drag(row(3), group);
    await expect(list.locator('.session-organizer-members > .session-organizer-item')).toHaveCount(3);
    await group.getByRole('button', { name: `Rename group ${kind} research` }).click();
    await input.fill('Cancelled name');
    await input.press('Escape');
    await expect(group).toContainText(`${kind} research`);
    await group.getByRole('button', { name: `Collapse group ${kind} research` }).click();
    await expect(row(1)).toHaveCount(0);
    await group.getByRole('button', { name: `Expand group ${kind} research` }).click();
  }
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1664, 1200); });
  page = app.window;
  await expect(page.getByTestId('session-custom-group')).toHaveCount(3);
  await expect(page.getByTestId('session-custom-group').filter({ hasText: 'chat research' })).toBeVisible();
  await page.locator('[data-scope="nav-conversations"] [data-session-order-id="SESSION-aaaaa1"] [data-testid="session-list-row"]').click();
  await expect(page.getByTestId('sessions-view')).toBeVisible();
  fs.mkdirSync(path.resolve(__dirname, '../../.praxis/session-artifacts'), { recursive: true });
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/session-groups.png') });
  const chatList = page.locator('[data-scope="nav-conversations"]');
  // Moving an individual row out preserves the other group members.
  const source = chatList.locator('[data-session-order-id="SESSION-aaaaa1"]');
  await source.hover();
  const box = await source.boundingBox();
  if (!box) throw new Error('Missing source row');
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + box.height / 2, { steps: 5 });
  const end = chatList.getByTestId('session-ungroup-drop');
  await expect(end).toBeVisible();
  await end.scrollIntoViewIfNeeded();
  const endBox = await end.boundingBox();
  if (!endBox) throw new Error('Missing ungroup target');
  await page.mouse.move(endBox.x + 40, endBox.y + endBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(chatList.locator('.session-organizer-members > .session-organizer-item')).toHaveCount(2);
  await chatList.getByRole('button', { name: 'Ungroup chat research' }).click();
  await expect(chatList.getByTestId('session-custom-group')).toHaveCount(0);
  await expect(chatList.locator(':scope > .session-organizer-item')).toHaveCount(3);
});
