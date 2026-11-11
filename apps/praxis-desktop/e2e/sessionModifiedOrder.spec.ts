import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp } from './launchTestApp';

test('session shelf follows latest activity despite an earlier completion', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-session-order-'));
  const old = new Date(Date.now() - 3600_000).toISOString();
  const recent = new Date().toISOString();
  const records = ['older', 'recent'].map(name => ({
    issueKey: `SESSION-order-${name}`, sessionId: name, title: `Order ${name}`,
    state: 'completed', provider: 'claude', startedAt: old, completedAt: old,
    taskDefinition: { goal: name, sessionMode: 'chat' },
    events: name === 'recent' ? [{ timestamp: recent, type: 'message', summary: 'Latest activity' }] : []
  }));
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({
    'praxis.agentSessions': Object.fromEntries(records.map(record => [record.issueKey, record]))
  }));
  const app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  try {
    const page = app.window;
    await page.evaluate(() => localStorage.setItem('praxis-session-layout:nav-conversations', JSON.stringify([
      { id: 'SESSION-order-older' }, { id: 'SESSION-order-recent' }
    ])));
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    await page.keyboard.press('Escape');
    const rows = page.getByTestId('session-shelf-spine');
    await expect(rows.first()).toHaveAttribute('data-session-key', 'SESSION-order-recent');
    const updated = { ...records[0], events: [{ timestamp: new Date(Date.now() + 1000).toISOString(), type: 'message', summary: 'Updated again' }] };
    await app.electronApp.evaluate(({ BrowserWindow }, record) => {
      BrowserWindow.getAllWindows()[0].webContents.send('ai:sessionChanged', record);
    }, updated);
    await expect(rows.first()).toHaveAttribute('data-session-key', 'SESSION-order-older');
    fs.mkdirSync(path.resolve(__dirname, '../../.praxis/session-artifacts'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/session-modified-order.png') });
  } finally {
    await closeTestApp(app);
  }
});
