import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

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
  await expect(window.locator('[data-testid="mobile-access-mode"]')).toHaveAttribute('data-value', 'off');
  await expect(window.locator('[data-testid="mobile-create-pairing"]')).toBeDisabled();
  await expect(window.locator('[data-testid="mobile-listener-status"]')).toContainText('Not listening');
  await expect(window.locator('[data-testid="mobile-discovery-status"]')).toContainText('not advertised');
  await expect(window.locator('[data-testid="mobile-paired-devices"]')).toContainText('No paired phones yet.');
});

test('creating a pairing code shows a single-use token and never a private key', async () => {
  await openMobileAccess();
  await chooseOption(window.locator('[data-testid="mobile-access-mode"]'), 'local-only');
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

test('an allowed-subnet entry the policy cannot match is rejected inline, and a legacy prefix migrates', async () => {
  await openMobileAccess();
  const subnets = window.getByRole('textbox', { name: 'Allowed mobile subnets' });
  const error = window.locator('[data-testid="mobile-subnets-error"]');
  await subnets.fill('192.168.1');
  await expect(error).toContainText('IP addresses or CIDRs');
  await expect(error).not.toContainText('Error invoking remote method');
  expect((await window.evaluate(() => window.praxis.settings.get())).mobileAccess.allowedSubnets).toEqual([]);
  await window.locator('.settings-field-row', { has: subnets }).screenshot({ path: 'output/playwright/mobile-subnet-rejected.png' });
  await subnets.fill('192.168.1.');
  await expect(error).toHaveCount(0);
  await expect(subnets).toHaveValue('192.168.1.0/24');
});
