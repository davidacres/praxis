import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

test('window state remembers previous position, width, and height across restarts', async () => {
  let app: TestApp = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });

  try {
    const targetBounds = { x: 120, y: 140, width: 1024, height: 768 };

    // Set custom bounds on the main BrowserWindow
    await app.electronApp.evaluate(async ({ BrowserWindow }, bounds) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds(bounds);
    }, targetBounds);

    // Wait for the debounced save or trigger close
    await app.electronApp.close();

    // Relaunch the app reusing the same userDataDir profile
    app = await launchTestApp(
      undefined,
      { userDataDir: app.userDataDir, settingsPath: app.settingsPath },
      undefined,
      { openNewSession: false }
    );

    // Read restored bounds
    const restoredBounds = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.getBounds();
    });

    expect(restoredBounds.x).toBe(targetBounds.x);
    expect(restoredBounds.y).toBe(targetBounds.y);
    expect(restoredBounds.width).toBe(targetBounds.width);
    expect(restoredBounds.height).toBe(targetBounds.height);
  } finally {
    await closeTestApp(app);
  }
});
