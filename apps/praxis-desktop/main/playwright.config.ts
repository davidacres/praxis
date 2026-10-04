import { defineConfig } from '@playwright/test';

function configuredWorkers(): number {
  const explicit = Number.parseInt(process.env.PRAXIS_E2E_WORKERS ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return process.env.CI ? 1 : 4;
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2
    }
  },
  /**
   * Every test launches its own Electron app, and each launch is already fully
   * isolated — a throwaway `--user-data-dir` (which is also what scopes the
   * single-instance lock), its own settings file, and mock servers on
   * ephemeral ports — so tests can safely run side by side. Electron is heavy,
   * a whole Chromium per worker, so this stays well under the core count to
   * leave headroom rather than thrash.
   */
  // Concurrent Electron launches on macOS CI eventually fail its framework
  // signature validation, so CI runs desktop suites serially. A local governed
  // workflow still sets CI for unattended test-runner behaviour, but supplies
  // PRAXIS_E2E_WORKERS explicitly so its isolated Electron tests stay parallel.
  workers: configuredWorkers(),
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
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
