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
  reporter: 'list'
});
