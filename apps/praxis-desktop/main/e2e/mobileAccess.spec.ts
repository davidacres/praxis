import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp();
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

async function openMobileAccess(): Promise<void> {
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-mobile"]').click();
  await expect(window.locator('.settings-section-title')).toHaveText('Mobile access');
}

test('mobile access pairing controls stay off until the listener is enabled', async () => {
  await openMobileAccess();
  await expect(window.locator('[data-testid="mobile-access-mode"]')).toHaveValue('off');
  await expect(window.locator('[data-testid="mobile-create-pairing"]')).toBeDisabled();
  await expect(window.locator('[data-testid="mobile-listener-status"]')).toContainText('Not listening');
  await expect(window.locator('[data-testid="mobile-discovery-status"]')).toContainText('not advertised');
  await expect(window.locator('[data-testid="mobile-paired-devices"]')).toContainText('No paired phones yet.');
});

test('creating a pairing code shows a single-use token and never a private key', async () => {
  await openMobileAccess();
  await window.locator('[data-testid="mobile-access-mode"]').selectOption('local-only');
  await expect(window.locator('[data-testid="mobile-listener-status"]')).toContainText('Listening');
  await expect(window.locator('[data-testid="mobile-discovery-status"]')).toContainText('advertised as');
  await expect(window.locator('[data-testid="mobile-create-pairing"]')).toBeEnabled();
  await window.locator('[data-testid="mobile-create-pairing"]').click();
  const code = window.locator('[data-testid="mobile-pairing-code"]');
  await expect(code).toBeVisible();
  await expect(code).toHaveText(/^[0-9a-f]{12}$/);
  await expect(window.locator('[data-testid="mobile-pairing-qr"]')).toBeVisible();
  await expect(window.locator('[data-testid="mobile-host-fingerprint"]')).toHaveText(/^[0-9a-f]{16}$/);
  await expect(window.locator('[data-testid="mobile-copy-invitation"]')).toBeVisible();
});

test('resetting the host key asks for confirmation in-app', async () => {
  await openMobileAccess();
  await window.locator('[data-testid="mobile-reset-host-key"]').click();
  const dialog = window.getByRole('dialog', { name: 'Reset host key?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
