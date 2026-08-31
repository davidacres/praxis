import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  /**
   * Every test launches its own Electron app, and each launch is already fully
   * isolated — a throwaway `--user-data-dir` (which is also what scopes the
   * single-instance lock), its own settings file, and mock servers on
   * ephemeral ports — so tests can safely run side by side. Electron is heavy,
   * a whole Chromium per worker, so this stays well under the core count to
   * leave headroom rather than thrash.
   */
  workers: process.env.CI ? 2 : 4,
  reporter: 'list',
  projects: [
    {
      name: 'functional',
      // Appearance has its own opt-in project below. Keep the default desktop
      // run focused on product behavior and persistence.
      testIgnore: [
        '**/appearanceSettings.spec.ts',
        '**/brandIcons.spec.ts',
        '**/overview.spec.ts',
        '**/surfacePacks.spec.ts',
        '**/themeLooks.spec.ts'
      ],
      grepInvert: /@theme/
    },
    {
      name: 'themes',
      testMatch: [
        '**/appearanceSettings.spec.ts',
        '**/brandIcons.spec.ts',
        '**/overview.spec.ts',
        '**/surfacePacks.spec.ts',
        '**/themeLooks.spec.ts'
      ]
    },
    {
      name: 'theme-regressions',
      // Keeps the occasional theme-specific assertion embedded in a broader
      // flow opt-in without duplicating the whole source test file.
      testMatch: '**/*.spec.ts',
      grep: /@theme/
    }
  ]
});
