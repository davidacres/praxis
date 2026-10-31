import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The smoke set: one or two spec files per product area, run by `npm test` and
 * so by unattended governed-workflow test stages. It trades depth for speed and
 * stability. Every file here must avoid hover, `page.mouse`, drag and
 * `toHaveScreenshot` assertions. Those depend on the real pointer and pixels,
 * and they fail when the suite shares a desktop with a person or with other
 * test windows. Plain `screenshot({ path })` evidence captures are fine.
 *
 * The full functional suite (`npm run test:desktop`) is still the gate for a UI
 * change.
 */
const SMOKE_SPECS = [
  // App shell and settings
  'app', 'commandPalette', 'keyboardFocus', 'settingsReset', 'windowState', 'terminal', 'backgroundTasks',
  // Boards and backends (folder/edit/new is the folder-compatibility gate)
  'folder', 'folderMulti', 'editIssue', 'newIssue', 'journey', 'boardFilters', 'issueDetail',
  'github', 'gitlab', 'jira',
  // Workspaces and projects
  'savedWorkspaces', 'workspaceFile', 'importProjects',
  // AI sessions and providers
  'aiSessionMode', 'aiMcpServers', 'aiSessionTasks', 'aiSpendLimit', 'aiWorktree', 'cancelTurn',
  'sessionRecovery', 'standaloneConversations', 'quickSession', 'aiProviderTabs', 'aiWorkflows',
  // Workflow runs and scheduled runs
  'workflowLoops', 'workflowAgentStage', 'workflowBuildStage', 'workflowInstallDeps', 'workflowRetryFailed',
  'workflowPolicy', 'workflowReviewDiff', 'workflowTemplateAddon', 'scheduledProviderHandover', 'securityReviewRun',
  // Code intelligence, git and other surfaces
  'codeIntelligence', 'codeSearchDialog', 'gitGraph', 'gitOnboarding', 'quickCapture', 'whatChanged', 'mobileAccess'
].map(name => `${name}.spec.ts`);

// A renamed or deleted spec would silently drop out of the set, so fail loudly instead.
const missingSmokeSpecs = SMOKE_SPECS.filter(file => !fs.existsSync(path.join(__dirname, 'e2e', file)));
if (missingSmokeSpecs.length > 0) {
  throw new Error(`playwright.config.ts: smoke spec(s) not found in e2e/: ${missingSmokeSpecs.join(', ')}`);
}

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
      name: 'smoke',
      testMatch: SMOKE_SPECS.map(file => `**/${file}`),
      grepInvert: /@theme/,
      // One retry so a single slow Electron launch doesn't fail an unattended run.
      // A test that fails twice is still a failure.
      retries: 1
    },
    {
      name: 'themes',
      testMatch: [
        '**/appearanceSettings.spec.ts',
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
