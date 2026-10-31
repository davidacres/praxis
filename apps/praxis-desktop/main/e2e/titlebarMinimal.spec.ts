import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { launchTestApp, closeTestApp, dismissSplash } from './launchTestApp';

test('themed titlebar switches projects and exposes panel controls', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-titlebar-visual-'));
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
    'SESSION-titlebar-review': { issueKey: 'SESSION-titlebar-review', sessionId: 'titlebar-review', title: 'Titlebar visual review',
      state: 'completed', startedAt: timestamp, completedAt: timestamp, provider: 'openai', model: 'mock/model',
      taskDefinition: { goal: 'Review the Monolith titlebar.' }, events: [] }
  } }));
  const app = await launchTestApp({ appearance: { themeId: 'tm-default-2', themeMode: 'dark' } },
    { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  // Deterministic Hybrid status: no real index/model download or service is needed.
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request) => {
      if (request.action === 'owner-status') return { data: { running: true, hasIndex: true } };
      if (request.action === 'list') return { data: [{ id: 'visual-index', root: '/test/titlebar', state: 'ready' }] };
      if (request.tool === 'get_index_status') return { data: { models: [{ state: 'active' }] } };
      return { data: {} };
    });
  });
  const page = app.window;
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  try {
    const bar = page.locator('.titlebar');
    await expect(page.getByTestId('titlebar-views')).toHaveCount(0);
    for (const id of ['new-menu', 'quick-capture', 'quick-session', 'titlebar-reload', 'titlebar-zoom-in', 'titlebar-zoom-out']) {
      await expect(bar.getByTestId(id)).toBeVisible();
    }
    await expect(bar.getByRole('button', { name: 'New AI session', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(bar.getByRole('searchbox')).toHaveCount(0);
    const projects = await page.evaluate(async () => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const result = [];
      for (const [key, name] of [['ALPHA', 'Alpha project'], ['BETA', 'Beta project']]) {
        result.push(await window.praxis.projects.create({ name, key, type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage', starterTickets: [{ summary: 'Example task', description: '', issueType: 'Task', status: 'To do' }],
          workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }] }, workspace.id));
      }
      return result;
    });
    await page.reload();
    await dismissSplash(page);
    await expect(bar.getByLabel('Select project', { exact: true })).toBeVisible();
    const picker = bar.getByLabel('Select project');
    await chooseOption(picker, projects[0].id);
    await expect(picker).toContainText('Alpha project');
    await expect(page.getByTestId('easymode-sidebar').getByLabel('Select project')).toHaveCount(0);
    await chooseOption(picker, projects[1].id);
    await expect(picker).toContainText('Beta project');
    await page.getByTestId('session-focus-new').click();
    await expect(picker).toContainText('Beta project');
    // Proven by moving Back after the project picker: the order assertion failed.
    const order = await bar.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
    const expectedOrder = ['Back', 'Forward', 'Home', 'Select workspace', 'Select project', 'New AI session', 'New', 'Quick Capture', 'Quick session', 'Scheduled runs', 'What Changed', 'Reload window', 'Toggle sidebar', 'Toggle panel', 'Toggle secondary sidebar', 'Toggle virtual team assistant', 'Zoom out application', 'Zoom in application', 'Settings'];
    const relevant = order.filter(label => expectedOrder.includes(label ?? ''));
    expect(relevant).toEqual(expectedOrder);
    await expect(bar.getByRole('button', { name: "What's new", exact: true })).toHaveCount(0);
    const rightmost = await bar.evaluate(node => {
      const panels = node.querySelector('.titlebar-layout-toggles')!.getBoundingClientRect();
      const settings = node.querySelector('[data-testid="titlebar-settings"]')!.getBoundingClientRect();
      const zoom = node.querySelector('[data-testid="titlebar-zoom-controls"]')!.getBoundingClientRect();
      return zoom.left >= panels.right && settings.left >= zoom.right;
    });
    expect(rightmost).toBe(true);
    const panel = page.getByRole('button', { name: 'Toggle panel', exact: true });
    const wasOpen = await panel.getAttribute('aria-pressed');
    await panel.click();
    await expect(panel).toHaveAttribute('aria-pressed', wasOpen === 'true' ? 'false' : 'true');
    await panel.click();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Go to' });
    await palette.getByRole('textbox').fill('SESSION-titlebar-review');
    await palette.getByRole('option').filter({ hasText: 'Titlebar visual review' }).click();
    await expect(page.getByTestId('toggle-focus-mode')).toBeVisible();
    await expect(page.getByTestId('titlebar-code-intel')).toHaveText('Hybrid');
    const darkBackground = await bar.evaluate(node => getComputedStyle(node).backgroundColor);
    await expect(page.getByLabel('Toggle sidebar', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'monolith-titlebar.png') });
    for (const width of [1100, 1400]) {
      await page.setViewportSize({ width, height: 900 });
      const settings = bar.getByTestId('titlebar-settings');
      await expect(settings).toBeInViewport();
      const fits = await bar.evaluate(node => {
        const crumb = node.querySelector('.titlebar-crumb')!.getBoundingClientRect();
        const actions = node.querySelector('.titlebar-right')!.getBoundingClientRect();
        const center = node.querySelector('.titlebar-center')!.getBoundingClientRect();
        const project = node.querySelector('.titlebar-project .chip-select')!.getBoundingClientRect();
        const workspace = node.querySelector('.workspace-switcher-name')!.getBoundingClientRect();
        const separator = node.querySelector('.titlebar-crumb-sep')!.getBoundingClientRect();
        return project.right <= center.left && workspace.right <= separator.left && crumb.right <= center.left && center.right <= actions.left && actions.right <= innerWidth && Math.abs((center.left + center.right) / 2 - innerWidth / 2) < 1;
      });
      expect(fits, `titlebar controls fit at ${width}px`).toBe(true);
    }
    await page.getByLabel('Toggle sidebar', { exact: true }).click();
    await expect(page.getByTestId('session-shelf')).toBeVisible();
    await page.mouse.move(600, 200);
    await bar.screenshot({ path: path.join(artifacts, 'right-zoom-settings-dark.png') });
    for (const name of ['Home', 'New AI session', 'Quick Capture', 'Quick session']) {
      const control = bar.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toHaveText('');
      await expect(control).toHaveAttribute('title', /.+/);
    }
    for (const control of [bar.getByTestId('quick-capture'), bar.getByTestId('titlebar-settings'), bar.getByTestId('titlebar-code-intel')]) {
      expect(await control.evaluate(node => getComputedStyle(node).borderRadius)).toBe('0px');
    }
    const capture = page.getByTestId('quick-capture');
    const defaultFill = await capture.evaluate(node => getComputedStyle(node).borderBottomColor);
    await capture.hover();
    await expect.poll(() => capture.evaluate(node => getComputedStyle(node).borderBottomColor)).not.toBe(defaultFill);
    await bar.screenshot({ path: path.join(artifacts, 'right-zoom-settings-hover.png') });
    await page.mouse.move(600, 200);
    await capture.focus();
    await page.keyboard.press('Tab');
    const focused = page.getByTestId('quick-session');
    await expect(focused).toBeFocused();
    expect(await focused.evaluate(node => { const style = getComputedStyle(node); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0; })).toBe(true);
    await bar.screenshot({ path: path.join(artifacts, 'right-zoom-settings-keyboard.png') });
    const focus = page.getByTestId('toggle-focus-mode');
    await focus.click();
    await expect(focus).toHaveAttribute('aria-pressed', 'true');
    await bar.screenshot({ path: path.join(artifacts, 'right-zoom-settings-focus.png') });
    await focus.click();
    await page.getByTestId('new-menu').click();
    await expect(page.getByRole('menuitem', { name: /Add Project/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-light', themeMode: 'light' } }));
    await page.reload();
    await dismissSplash(page);
    await expect.poll(() => bar.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(darkBackground);
    await bar.screenshot({ path: path.join(artifacts, 'right-zoom-settings-light.png') });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Go to' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('session-focus-new').click();
    await expect(page.getByTestId('new-session-view')).toBeVisible();
  } finally { await closeTestApp(app); }
});
