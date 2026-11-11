import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp } from './launchTestApp';

test('normal teardown exits Electron and removes its isolated profile', async () => {
  const app = await launchTestApp();
  const child = app.electronApp.process();
  await closeTestApp(app);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(fs.existsSync(app.userDataDir)).toBe(false);
  // Cleanup remains safe if a finally block and afterEach both call it.
  await closeTestApp(app);
});

test('stalled renderer cleanup is bounded and reported after terminating its app', async () => {
  const app = await launchTestApp();
  const child = app.electronApp.process();
  try {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('projects:list');
      ipcMain.handle('projects:list', () => new Promise(() => {}));
    });
    await expect(closeTestApp(app, { timeoutMs: 1000 })).rejects.toThrow(/stopping test-owned work/);
    expect(child.signalCode).toBe('SIGKILL');
    expect(fs.existsSync(app.userDataDir)).toBe(false);
  } finally {
    await closeTestApp(app);
  }
});

test('vetoed Electron shutdown is bounded and remains a failure', async () => {
  const app = await launchTestApp();
  const child = app.electronApp.process();
  try {
    await app.electronApp.evaluate(({ app }) => {
      app.on('before-quit', event => event.preventDefault());
    });
    await expect(closeTestApp(app, { timeoutMs: 1000 })).rejects.toThrow(/closing Electron/);
    expect(child.signalCode).toBe('SIGKILL');
    expect(fs.existsSync(app.userDataDir)).toBe(false);
  } finally {
    await closeTestApp(app);
  }
});
