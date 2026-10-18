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

  // "All projects" is the only preference a chip menu carries, so it is always
  // present and reports state through aria-checked rather than its label.
  const globalToggle = win.getByTestId('new-session-code-intel-global-toggle');
  await expect(globalToggle).toHaveAttribute('aria-checked', 'true');

  // The per-project override only appears when it can change something: here
  // there is no override set and the global default is on, so it is absent
  // rather than showing a switch that does nothing.
  await expect(win.getByTestId('new-session-code-intel-project-toggle')).toHaveCount(0);

  // Search is a field carrying the shortcut as a badge rather than baking it
  // into the button label, and rebuild is cost-labelled as destructive.
  await expect(win.getByTestId('new-session-code-intel-search-btn')).toContainText('Search');
  await expect(win.getByTestId('new-session-code-intel-rebuild-btn')).toBeVisible();
  await expect(menu).toContainText('Advanced settings');

  // Turning the global default off pauses this project, and the per-project
  // switch now appears because it is the only way to opt this folder back in.
  await globalToggle.click();
  await expect(globalToggle).toHaveAttribute('aria-checked', 'false');
  const projectToggle = win.getByTestId('new-session-code-intel-project-toggle');
  await expect(projectToggle).toBeVisible();
  await expect(projectToggle).toHaveAttribute('aria-checked', 'false');

  // Close panel by clicking outside
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

test('composer code intelligence chip allows searching directly and changing search mode', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  const win = app.window;

  // Mock code intelligence IPC with search_code response
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') {
        return { data: [{ id: 'pci:repo:fixture', root: '/test/workspace', state: 'ready', generation: 2 }] };
      }
      if (request.action === 'query') {
        if (request.tool === 'search_code') {
          return {
            data: {
              matches: [
                {
                  symbol: {
                    symbolId: 'pci:sym:auth-handler',
                    qualifiedName: 'MyApp.Auth.AuthenticationHandler',
                    kind: 'class'
                  },
                  score: 0.95
                }
              ]
            }
          };
        }
        return {
          indexGeneration: 2,
          freshness: { state: 'current' },
          data: {
            contexts: [],
            models: [{ id: 'bge-small', state: 'active', coverage: { current: 100, eligible: 100 } }]
          }
        };
      }
      return { data: {} };
    });
  });

  await win.waitForSelector('[data-testid="new-session-view"]');
  const chip = win.getByTestId('new-session-code-intel-chip');
  await expect(chip).toBeVisible();

  // Click chip to open popover
  await chip.click();
  const menu = win.getByTestId('new-session-code-intel-menu');
  await expect(menu).toBeVisible();

  // Mode buttons are present: Hybrid, Keyword, Semantic
  const hybridPill = menu.getByRole('radio', { name: 'Hybrid' });
  const keywordPill = menu.getByRole('radio', { name: 'Keyword' });
  const semanticPill = menu.getByRole('radio', { name: 'Semantic' });
  await expect(hybridPill).toBeVisible();
  await expect(keywordPill).toBeVisible();
  await expect(semanticPill).toBeVisible();

  // Initially Hybrid is selected
  await expect(hybridPill).toHaveAttribute('aria-checked', 'true');

  // Switch mode to Keyword
  await keywordPill.click();
  await expect(keywordPill).toHaveAttribute('aria-checked', 'true');
  await expect(hybridPill).toHaveAttribute('aria-checked', 'false');
  await expect(chip).toContainText('Keyword Intel');

  // Switch mode to Semantic
  await semanticPill.click();
  await expect(semanticPill).toHaveAttribute('aria-checked', 'true');
  await expect(chip).toContainText('Semantic Intel');

  // Search input is present and typeable
  const searchInput = win.getByTestId('new-session-code-intel-search-input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Auth');

  // Results do not appear in the chip popover (clean popover)
  await expect(menu.locator('.session-code-intel-result-item')).toHaveCount(0);

  // Clicking search button or pressing Enter opens CodeSearchDialog with the query and mode
  const searchBtn = win.getByTestId('new-session-code-intel-search-btn');
  await searchBtn.click();

  // Popover closes, CodeSearchDialog opens with the searched query
  await expect(menu).toHaveCount(0);
  const searchDialog = win.getByTestId('code-search-dialog');
  await expect(searchDialog).toBeVisible();
  const dialogInput = win.getByTestId('code-search-input');
  await expect(dialogInput).toHaveValue('Auth');
});


