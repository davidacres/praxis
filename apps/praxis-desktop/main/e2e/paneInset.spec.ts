import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * The centre pane is an inset card: a 4px gap (`--pane-main-inset`) on every side, a full border, and all
 * four corners rounded — not a panel docked flush to the window edge.
 */

test.slow();

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('the centre pane is inset by 4px on every side and rounded on all four corners', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  const pane = page.getByTestId('main-content-pane');
  await expect(pane).toBeVisible();

  const geometry = await pane.evaluate(el => {
    const row = el.parentElement as HTMLElement;
    const p = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      top: Math.round(p.top - r.top),
      bottom: Math.round(r.bottom - p.bottom),
      left: Math.round(p.left - r.left),
      right: Math.round(r.right - p.right),
      corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(parseFloat),
      borderBottom: parseFloat(style.borderBottomWidth),
      insetToken: getComputedStyle(document.documentElement).getPropertyValue('--pane-main-inset').trim()
    };
  });
  expect(geometry.insetToken).toBe('4px');
  expect(geometry.top, JSON.stringify(geometry)).toBe(4);
  expect(geometry.bottom, JSON.stringify(geometry)).toBe(4);
  expect(geometry.left, JSON.stringify(geometry)).toBe(4);
  // With no right pane the card also floats off the window's right edge.
  expect(geometry.right, JSON.stringify(geometry)).toBe(4);
  expect(geometry.borderBottom).toBe(1);
  for (const radius of geometry.corners) expect(radius).toBeGreaterThan(0);

  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'pane-inset-overview.png') });
});
