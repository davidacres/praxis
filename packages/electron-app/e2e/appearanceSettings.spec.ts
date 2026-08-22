import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { DEFAULT_APP_SETTINGS } from '@ticket-manager/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * The suite runs fully isolated (see launchTestApp.ts): each test gets its own
 * settings file via `TICKET_MANAGER_SETTINGS_PATH`, seeded here with the
 * shipped appearance defaults so assertions do not depend on any local
 * customisation. The developer's real settings file is never touched.
 */
let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp({ appearance: DEFAULT_APP_SETTINGS.appearance });
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

async function openAppearance(): Promise<void> {
  await window.locator('[data-testid="nav-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance"]').click();
  await window.locator('.priority-color-list').waitFor({ state: 'visible' });
}

test('gradient priorities expose a picker per stop plus a direction control', async () => {
  await openAppearance();

  // Highest ships as `linear-gradient(to bottom, #DC2626, #EA580C)`.
  await expect(window.getByLabel('Highest gradient start color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Highest gradient end color')).toHaveValue('#ea580c');
  await expect(window.getByLabel('Highest gradient direction')).toHaveValue('to bottom');

  // Solid priorities get a single picker and no direction control.
  await expect(window.getByLabel('Lowest priority color')).toHaveValue('#22c55e');
  await expect(window.getByLabel('Lowest gradient direction')).toHaveCount(0);
});

test('solid and gradient round trip through the mode toggle and survive a reload', async () => {
  await openAppearance();

  const criticalRow = window.locator('.priority-color-row', { hasText: 'Critical' });
  await expect(window.getByLabel('Critical priority color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient start color')).toHaveCount(0);

  await criticalRow.getByRole('button', { name: 'Gradient' }).click();

  // The second stop is seeded 35% darker so the new gradient reads as a gradient.
  await expect(window.getByLabel('Critical gradient start color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient end color')).toHaveValue('#8f1919');

  await window.getByLabel('Critical gradient direction').selectOption('to right');
  await window.waitForTimeout(300);

  await window.reload();
  await openAppearance();
  await expect(window.getByLabel('Critical gradient direction')).toHaveValue('to right');
  await expect(window.getByLabel('Critical gradient start color')).toHaveValue('#dc2626');

  // Back to solid: the first stop becomes the solid color.
  await criticalRow.getByRole('button', { name: 'Solid' }).click();
  await expect(window.getByLabel('Critical priority color')).toHaveValue('#dc2626');
  await expect(window.getByLabel('Critical gradient start color')).toHaveCount(0);
});
