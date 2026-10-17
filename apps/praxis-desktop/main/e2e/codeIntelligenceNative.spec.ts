import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

test('packaged service supports desktop source navigation and repository recovery', async ({}, testInfo) => {
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
    await win.getByTestId('titlebar-settings').click();
    await win.getByTestId('settings-nav-code-intelligence').click();
    const panel = win.getByTestId('code-intelligence-panel');
    await panel.getByLabel('Repository folder', { exact: true }).fill(source);
    await panel.getByRole('button', { name: 'Register repository', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Index now', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Index now', exact: true }).click();
    await expect(panel).toContainText('Generation 1');
    await panel.getByLabel('Search source').fill('NativeSmoke');
    await panel.getByRole('button', { name: 'Search code', exact: true }).click();
    const typeMatch = panel.locator('.code-intelligence-match').filter({ has: win.getByText('NativeSmoke', { exact: true }) });
    await expect(typeMatch).toHaveCount(1);
    await typeMatch.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(panel).toContainText('Hash verified:');
    await expect(panel.locator('article pre')).toContainText('public class NativeSmoke');
    await panel.getByText('Hash verified:', { exact: false }).scrollIntoViewIfNeeded();
    await win.screenshot({ path: testInfo.outputPath('native-source.png') });
    await panel.getByRole('button', { name: 'Rebuild index', exact: true }).click();
    await expect(panel).toContainText('Generation 2', { timeout: 15_000 });
    await panel.getByRole('button', { name: 'Pause indexing', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Resume indexing', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Resume indexing', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Pause indexing', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Relocate repository', exact: true }).click();
    const dialog = win.getByRole('dialog', { name: 'Relocate repository', exact: true });
    await dialog.getByRole('textbox').fill(relocated);
    await win.screenshot({ path: testInfo.outputPath('native-relocate-dialog.png') });
    await dialog.getByRole('button', { name: 'Relocate repository', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await panel.getByRole('button', { name: 'Index now', exact: true }).click();
    await panel.getByLabel('Search source').fill('NativeMoved');
    await panel.getByRole('button', { name: 'Search code', exact: true }).click();
    await expect(panel.locator('.code-intelligence-match strong').filter({ hasText: /^NativeMoved$/ })).toHaveText('NativeMoved');
    await expect(panel).not.toContainText('NativeSmoke');
    await panel.getByRole('button', { name: 'Unregister', exact: true }).click();
    await win.getByRole('dialog', { name: 'Unregister repository?', exact: true }).getByRole('button', { name: 'Unregister', exact: true }).click();
    await expect(panel.getByLabel('Search source')).toHaveCount(0);
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
