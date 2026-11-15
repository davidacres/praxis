import { expect, test } from '@playwright/test';
import { closeTestApp, dismissSplash, launchTestApp } from './launchTestApp';

/**
 * The macOS traffic lights are native views positioned by the shell, not DOM, so
 * their centring cannot be asserted from Chromium. What the renderer owns — and
 * what this guards — is the measurement channel the centring depends on: the
 * title bar reports its real height through `window:setTitlebarHeight` on mount
 * and whenever display size changes it, and the shell accepts the value.
 *
 * Proven against the broken state: with the TitleBar ResizeObserver effect
 * disabled, no measurement is ever recorded and the poll below times out.
 */
test('titlebar reports its measured height so the shell can centre the traffic lights', async () => {
  const app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  try {
    // Record every measurement the renderer sends; the production call still runs,
    // so the shell's acceptance of the channel is exercised too.
    await page.addInitScript(() => {
      const install = () => {
        const praxis = (window as unknown as { praxis?: { window: { setTitlebarHeight(h: number): Promise<void> } } }).praxis;
        if (!praxis) { setTimeout(install, 5); return; }
        const w = window as unknown as { __titlebarHeights: number[] };
        w.__titlebarHeights = [];
        const original = praxis.window.setTitlebarHeight.bind(praxis.window);
        praxis.window.setTitlebarHeight = (height: number) => {
          w.__titlebarHeights.push(height);
          return original(height);
        };
      };
      install();
    });
    await page.reload();
    await dismissSplash(page);

    const barHeight = () => page.evaluate(() =>
      document.querySelector('.titlebar')!.getBoundingClientRect().height
    );
    const reported = () => page.evaluate(() =>
      (window as unknown as { __titlebarHeights?: number[] }).__titlebarHeights ?? []
    );

    // On mount the bar reports its real height.
    const height = await barHeight();
    expect(height).toBeGreaterThan(0);
    await expect.poll(async () => (await reported()).length).toBeGreaterThan(0);
    expect(Math.abs((await reported())[0] - height)).toBeLessThan(1);

    // Large display size grows the bar (40px → 46.4px) and a new measurement follows.
    await page.evaluate(() =>
      window.praxis.settings.set({ appearance: { displayMode: 'large' } })
    );
    await expect.poll(barHeight).toBeGreaterThan(height);
    const largeHeight = await barHeight();
    await expect
      .poll(async () => (await reported()).some(h => Math.abs(h - largeHeight) < 1))
      .toBe(true);
  } finally {
    await closeTestApp(app);
  }
});
