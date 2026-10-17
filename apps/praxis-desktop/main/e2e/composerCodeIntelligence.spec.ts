import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('composer code intelligence control shows in new session, toggles preferences, and inspects status', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  const win = app.window;

  // Mock code intelligence IPC so it returns predictable fixture repository data
  await app.electronApp.evaluate(({ ipcMain }) => {
    let generation = 1;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') {
        return { data: [{ id: 'pci:repo:fixture', root: '/test/workspace', state: 'ready', generation }] };
      }
      if (request.action === 'index') {
        generation++;
        return { data: { indexed: true } };
      }
      if (request.action === 'query') {
        return { indexGeneration: generation, freshness: { state: 'current' }, data: { contexts: [] } };
      }
      return { data: {} };
    });
  });

  // New Session is the default view
  await win.waitForSelector('[data-testid="new-session-view"]');
  const chip = win.getByTestId('new-session-code-intel-chip');
  await expect(chip).toBeVisible();

  // Click chip to open popover
  await chip.click();
  const menu = win.getByTestId('new-session-code-intel-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Code Intelligence');

  // Check global toggle
  const globalToggle = win.getByTestId('new-session-code-intel-global-toggle');
  await expect(globalToggle).toBeChecked();

  // Toggle global default
  await globalToggle.click();
  await expect(globalToggle).not.toBeChecked();

  // Close menu by clicking outside
  await win.mouse.click(10, 10);
  await expect(menu).toHaveCount(0);
});

test('virtual team assistant composer displays code intelligence chip and control', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  const win = app.window;

  // Open Virtual Team Assistant
  const assistantButton = win.getByTestId('titlebar-assistant');
  if (await assistantButton.count() > 0) {
    await assistantButton.click();
    const assistantChip = win.getByTestId('assistant-code-intel-chip');
    await expect(assistantChip).toBeVisible();
    await assistantChip.click();
    const menu = win.getByTestId('assistant-code-intel-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('Code Intelligence');
  }
});

test('existing session follow-up composer shows code intelligence chip and status', async () => {
  const path = await import('node:path');
  const fixture = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');
  app = await launchTestApp(
    { ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: fixture } } } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') {
        return { data: [{ id: 'pci:repo:fixture', root: '/repo/fixture', state: 'ready', generation: 2 }] };
      }
      if (request.action === 'query') {
        return { indexGeneration: 2, freshness: { state: 'current' }, data: { contexts: [] } };
      }
      return { data: {} };
    });
  });

  await win.getByTestId('conversations-new-btn').click();
  await win.getByPlaceholder('Ask anything, brainstorm, or get something done…').fill('Test code intel follow-up');
  await win.getByTestId('new-session-submit').click();
  await expect.poll(() => win.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.state)).toBe('completed');

  const chip = win.getByTestId('session-code-intel-chip');
  await expect(chip).toBeVisible();
  await chip.click();
  const menu = win.getByTestId('session-code-intel-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Code Intelligence');
});

