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
        '**/themeLooks.spec.ts',
        // Live-agent tests spend real model calls on a real account. They are
        // never part of an ordinary run — see the `live-agent` project below.
        '**/*.live.spec.ts'
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
      testIgnore: '**/*.live.spec.ts',
      grep: /@theme/
    },
    {
      /**
       * Drives a real CLI agent against a real model. These spend money on
       * whoever's account the agent is signed in to and take minutes, not
       * seconds, so they are their own project, excluded from every other one,
       * and additionally refuse to run without PRAXIS_LIVE_AGENT=1:
       *
       *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent
       *
       * Nothing here should ever be added to `npm run test:desktop`.
       */
      name: 'live-agent',
      testMatch: '**/*.live.spec.ts',
      timeout: 600000,
      workers: 1
    }
  ]
});
