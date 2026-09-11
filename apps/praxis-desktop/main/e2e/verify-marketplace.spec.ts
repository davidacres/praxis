import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
});

test('VERIFY: Marketplace loads and displays real GitHub packages', async () => {
  // Launch with REAL GitHub config and token
  app = await launchTestApp({
    marketplace: {
      enabled: true,
      owner: 'davidacres',
      ownerType: 'user',
      packageNamePrefix: 'praxis-addon-',
      apiBaseUrl: 'https://api.github.com',
      registryBaseUrl: 'https://npm.pkg.github.com',
      checkOnLaunch: false
    }
  }, undefined, {
    PRAXIS_MARKETPLACE_TOKEN: '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'
  });
  const window = app.window;

  // Open settings
  await window.getByRole('button', { name: /settings/i }).first().click();
  
  // Navigate to Themes
  await window.getByRole('button', { name: /appearance/i }).click();
  await window.getByRole('button', { name: /themes/i }).click();

  // Get marketplace section
  const marketplace = window.locator('[data-testid="theme-marketplace"]');
  await expect(marketplace).toBeVisible();

  // Screenshot 1: Show marketplace loaded
  await marketplace.scrollIntoViewIfNeeded();
  await window.waitForTimeout(2000); // Let it fully load
  await expect(window).toHaveScreenshot('verify-marketplace-loaded.png');

  // Verify content
  const marketplaceText = await marketplace.textContent();
  console.log('Marketplace content:', marketplaceText);

  // Check for "available" text showing packages loaded
  await expect(marketplace).toContainText('available');

  // Check filter buttons exist
  await expect(marketplace.locator('[data-testid="theme-marketplace-filter-all"]')).toBeVisible();
  await expect(marketplace.locator('[data-testid="theme-marketplace-filter-installed"]')).toBeVisible();

  // Check theme cards exist
  const themeCards = marketplace.locator('[data-testid^="theme-card-"]');
  const cardCount = await themeCards.count();
  console.log(`Found ${cardCount} theme cards in marketplace`);
  
  if (cardCount === 0) {
    throw new Error('No theme cards found in marketplace!');
  }

  // Screenshot 2: Show marketplace with filter buttons
  await expect(marketplace).toHaveScreenshot('verify-marketplace-with-filters.png');

  console.log('✅ MARKETPLACE VERIFIED - Packages are loading from GitHub!');
});
