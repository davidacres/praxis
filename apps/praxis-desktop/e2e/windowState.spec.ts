import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp, notReproducible } from './launchTestApp';

test('window state remembers previous position, width, and height across restarts', async () => {
  let app: TestApp = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });

  try {
    const targetBounds = { x: 120, y: 140, width: 1024, height: 768 };

    // Set custom bounds on the main BrowserWindow
    await notReproducible('native window bounds (BrowserWindow.setBounds/getBounds) and their persistence belong to the Tauri shell; the Chromium page stands in for the window');

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
    const restoredBounds = await notReproducible('native window bounds (BrowserWindow.setBounds/getBounds) and their persistence belong to the Tauri shell; the Chromium page stands in for the window');

    expect(restoredBounds.x).toBe(targetBounds.x);
    expect(restoredBounds.y).toBe(targetBounds.y);
    expect(restoredBounds.width).toBe(targetBounds.width);
    expect(restoredBounds.height).toBe(targetBounds.height);
  } finally {
    await closeTestApp(app);
  }
});
