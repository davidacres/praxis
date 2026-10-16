import { expect, test } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

async function openPanel() {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' });
  // Mock only this local capability: no repository, SDK evaluation, model download
  // or provider invocation is performed by the UI regression fixture.
  await app.electronApp.evaluate(({ ipcMain }) => {
    let root = '/fixture/original'; let generation = 1;
    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') return { data: [{ id: 'pci:repo:fixture', root, state: 'ready', generation }] };
      if (request.action === 'rebuild') { generation++; return { data: { queued: true } }; }
      if (request.action === 'relocate') { root = String(request.root); generation++; return { data: { relocated: true, grantsRevoked: true } }; }
      if (request.action === 'query') {
        const args = request.arguments as Record<string, unknown>;
        if (request.tool === 'get_index_status') return { indexGeneration: generation, freshness: { state: 'current' }, data: { contexts: [], diagnostics: [], models: [], jobsByState: {} } };
        if (request.tool === 'search_code' && args.query === 'mode probe')
          return { data: { matches: [
            { symbol: { symbolId: 'probe', qualifiedName: `Mode ${String(args.mode)}`, signature: 'void Run()', resolution: 'resolved' } },
            // Real qualified names and signatures are long and unbroken.
            { symbol: { symbolId: 'long', qualifiedName: 'Maze.Authorization.MazePermissionAuthorizationHandler.HandleRequirementAsync(Microsoft.AspNetCore.Authorization.AuthorizationHandlerContext,Maze.Authorization.MazePermissionRequirement)',
              signature: 'protected override System.Threading.Tasks.Task Maze.Authorization.MazePermissionAuthorizationHandler.HandleRequirementAsync(Microsoft.AspNetCore.Authorization.AuthorizationHandlerContext context, Maze.Authorization.MazePermissionRequirement requirement)', resolution: 'resolved' } }] } };
        if (request.tool === 'search_code') {
          const next = args.cursor === 'next-page';
          return { truncated: !next, nextCursor: next ? null : 'next-page', data: { matches: [{ symbol: { symbolId: next ? 'second' : 'first', qualifiedName: next ? 'SecondResult' : 'FirstResult', signature: 'void Run()', resolution: 'resolved' } }] } };
        }
      }
      return { error: { code: 'FIXTURE_UNEXPECTED_REQUEST', message: JSON.stringify(request) } };
    });
  });
  const win = app.window;
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-tab-tools').click();
  const panel = win.getByTestId('code-intelligence-panel');
  await expect(panel).toContainText('Generation 1');
  await expect(panel).toContainText('Search uses saved files; unsaved editor changes are not indexed.');
  return { win, panel };
}

test('rebuild and relocation use the themed recovery flow and refresh status', async ({}, testInfo) => {
  const { win, panel } = await openPanel();
  await panel.getByText('Index C# locally', { exact: false }).scrollIntoViewIfNeeded();
  await win.screenshot({ path: testInfo.outputPath('code-intelligence-saved-files.png') });
  win.on('dialog', () => { throw new Error('Recovery must use an in-app dialog.'); });
  await panel.getByRole('button', { name: 'Rebuild index', exact: true }).click();
  await expect(panel).toContainText('Generation 2');
  await panel.getByRole('button', { name: 'Relocate repository', exact: true }).click();
  const dialog = win.getByRole('dialog', { name: 'Relocate repository', exact: true });
  await expect(dialog).toContainText('revokes all provider access');
  await dialog.getByRole('textbox').fill('/fixture/moved');
  await dialog.getByRole('button', { name: 'Relocate repository', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('/fixture/moved');
  await expect(panel).toContainText('Generation 3');
  await panel.screenshot({ path: testInfo.outputPath('code-intelligence-recovery.png') });
});

test('search sends the chosen mode, defaulting to hybrid', async () => {
  const { panel } = await openPanel();
  await expect(panel).toContainText('nothing in the repository is built, restored or run');
  await panel.getByLabel('Search source').fill('mode probe');
  await panel.getByRole('button', { name: 'Search code', exact: true }).click();
  await expect(panel.locator('.code-intelligence-match strong').first()).toHaveText('Mode hybrid');
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'long names must wrap, not widen the panel').toBe(true);
  for (const [value, expected] of [['vector', 'Mode vector'], ['lexical', 'Mode lexical']] as const) {
    await chooseOption(panel.getByRole('button', { name: 'Search mode' }), value);
    await panel.getByRole('button', { name: 'Search code', exact: true }).click();
    await expect(panel.locator('.code-intelligence-match strong').first()).toHaveText(expected);
  }
});

test('budget-truncated search offers the returned cursor and shows the next page', async () => {
  const { panel } = await openPanel();
  await panel.getByLabel('Search source').fill('parser');
  await panel.getByRole('button', { name: 'Search code', exact: true }).click();
  await expect(panel).toContainText('FirstResult');
  await expect(panel).toContainText('More results are available.');
  await panel.getByRole('button', { name: 'More search results', exact: true }).click();
  await expect(panel).toContainText('SecondResult');
  await expect(panel).not.toContainText('FirstResult');
  await expect(panel.getByRole('button', { name: 'More search results', exact: true })).toHaveCount(0);
});

test('source search and recovery remain keyboard accessible in light and dark themes', async ({}, testInfo) => {
  const { win, panel } = await openPanel();
  await win.setViewportSize({ width: 1000, height: 800 });
  for (const mode of ['light', 'dark']) {
    await win.evaluate(mode => {
      document.documentElement.setAttribute('data-mode', mode);
      document.documentElement.setAttribute('data-theme', `praxis-${mode}`);
      document.documentElement.style.setProperty('--ui-scale', '1.25');
    }, mode);
    const search = panel.getByLabel('Search source');
    await search.fill('parser');
    await search.press('Tab');
    const submit = panel.getByRole('button', { name: 'Search code', exact: true });
    await expect(submit).toBeFocused();
    expect(await submit.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
    await submit.press('Enter');
    await expect(panel).toContainText('FirstResult');
    const relocate = panel.getByRole('button', { name: 'Relocate repository', exact: true });
    await relocate.focus();
    await relocate.press('Enter');
    const dialog = win.getByRole('dialog', { name: 'Relocate repository', exact: true });
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await expect(dialog).toContainText('revokes all provider access');
    await dialog.getByRole('button', { name: 'Relocate repository', exact: true }).focus();
    await win.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await win.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Relocate repository', exact: true })).toBeFocused();
    await win.screenshot({ path: testInfo.outputPath(`code-intelligence-${mode}-keyboard-dialog.png`) });
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(relocate).toBeEnabled();
    await expect(relocate).toBeFocused();
    await relocate.press('Enter');
    await expect(dialog.getByRole('textbox')).toBeFocused();
    await dialog.getByRole('textbox').press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(panel).toContainText('/fixture/original');
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await search.scrollIntoViewIfNeeded();
    await win.screenshot({ path: testInfo.outputPath(`code-intelligence-${mode}-search.png`) });
  }
});
