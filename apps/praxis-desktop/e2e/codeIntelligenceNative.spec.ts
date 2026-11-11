import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

test('packaged service supports desktop search, source navigation and repository recovery', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE;
  test.skip(!executable, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a self-contained host package.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pci-ui-'));
  const data = path.join(temporary, 'data');
  const source = path.join(temporary, 'original');
  const relocated = path.join(temporary, 'moved');
  fs.mkdirSync(source); fs.mkdirSync(relocated);
  fs.writeFileSync(path.join(source, 'Example.cs'), 'public class NativeSmoke { public int Compute() => 42; }\n');
  fs.writeFileSync(path.join(relocated, 'Moved.cs'), 'public class NativeMoved { public int Compute() => 43; }\n');
  const owner = spawn(executable!, ['serve', '--data', data], { stdio: 'ignore' });
  let startupError: Error | undefined;
  owner.on('error', error => { startupError = error; });
  let app: TestApp | undefined;
  try {
    await expect.poll(() => {
      if (startupError) throw startupError;
      if (owner.exitCode !== null) throw new Error(`Fixture owner exited: ${owner.exitCode}`);
      return fs.existsSync(path.join(data, 'owner.json'));
    }).toBe(true);
    app = await launchTestApp(undefined, undefined, {
      AI_GATEWAY_API_KEY: 'gateway-fixture-key',
      PRAXIS_CODE_INTELLIGENCE_EXE: executable,
      PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY: data
    });
    const win = app.window;
    // Settings manages repositories; searching and reading source live in the Cmd+Shift+F
    // dialog. Registration is the request a project or session sends for its folder.
    const registered = await win.evaluate(root => window.praxis.ai.codeIntelligence({ action: 'register', root }), source);
    expect(registered.error).toBeUndefined();
    const openPanel = async () => {
      await win.getByTestId('titlebar-settings').click();
      await win.getByTestId('settings-nav-code-intelligence').click();
      const panel = win.getByTestId('code-intelligence-panel');
      await expect(panel.getByTestId('code-intel-index-btn')).toBeEnabled();
      return panel;
    };
    const closePanel = async () => {
      await win.keyboard.press('Escape');
      await expect(win.getByTestId('code-intelligence-panel')).toHaveCount(0);
    };
    const search = async (query: string) => {
      await win.keyboard.press('ControlOrMeta+Shift+F');
      const dialog = win.getByTestId('code-search-dialog');
      await expect(dialog).toBeVisible();
      await chooseOption(dialog.getByRole('button', { name: 'Search mode' }), 'lexical');
      await dialog.getByTestId('code-search-input').fill(query);
      await dialog.getByTestId('code-search-submit-btn').click();
      return dialog;
    };

    let panel = await openPanel();
    await panel.getByTestId('code-intel-index-btn').click();
    await expect(panel).toContainText('Generation 1');
    await closePanel();

    let dialog = await search('NativeSmoke');
    const typeMatch = dialog.locator('[data-testid^="code-search-item-"]').filter({ hasText: /^NativeSmoke/ });
    await expect(typeMatch).toHaveCount(1);
    await typeMatch.click();
    await expect(dialog.getByTestId('code-search-source-view')).toContainText('public class NativeSmoke');
    await win.screenshot({ path: testInfo.outputPath('native-source.png') });
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    panel = await openPanel();
    await panel.getByTestId('code-intel-rebuild-btn').click();
    await expect(panel).toContainText('Generation 2', { timeout: 15_000 });
    await panel.getByRole('button', { name: 'Pause indexing', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Resume indexing', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Resume indexing', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Pause indexing', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Relocate', exact: true }).click();
    const relocate = win.getByRole('dialog', { name: 'Relocate repository', exact: true });
    await relocate.getByRole('textbox').fill(relocated);
    await win.screenshot({ path: testInfo.outputPath('native-relocate-dialog.png') });
    await relocate.getByRole('button', { name: 'Relocate repository', exact: true }).click();
    await expect(relocate).toHaveCount(0);
    await panel.getByTestId('code-intel-index-btn').click();
    await expect(panel).toContainText(relocated);
    await closePanel();

    dialog = await search('NativeMoved');
    await expect(dialog.locator('[data-testid^="code-search-item-"]').filter({ hasText: /^NativeMoved/ })).toHaveCount(1);
    await expect(dialog.getByTestId('code-search-results-list')).not.toContainText('NativeSmoke');
    await win.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    panel = await openPanel();
    await panel.getByTestId('code-intel-unregister-btn').click();
    await win.getByRole('dialog', { name: 'Unregister repository?', exact: true }).getByRole('button', { name: 'Unregister', exact: true }).click();
    await expect(panel).toContainText('No repositories indexed yet');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  } finally {
    try { if (app) await closeTestApp(app); }
    finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const closed = once(owner, 'close'); owner.kill('SIGINT');
        const force = setTimeout(() => owner.kill('SIGKILL'), 3000);
        try { await closed; } finally { clearTimeout(force); }
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});
