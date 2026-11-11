import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The smoke set: one or two spec files per product area, run by `npm test` and
 * so by unattended governed-workflow test stages.
 */
const SMOKE_SPECS = [
  // App shell and settings
  'app', 'commandPalette', 'keyboardFocus', 'settingsReset', 'windowState', 'terminal', 'backgroundTasks', 'easymode', 'appShell',
  // Boards and backends (folder/edit/new is the folder-compatibility gate)
  'folder', 'folderMulti', 'editIssue', 'newIssue', 'journey', 'boardFilters', 'issueDetail',
  'github', 'gitlab', 'jira',
  // Workspaces and projects
  'savedWorkspaces', 'workspaceFile', 'importProjects',
  // AI sessions and providers
  'aiSessionMode', 'aiMcpServers', 'aiSessionTasks', 'aiSpendLimit', 'aiWorktree', 'cancelTurn',
  'sessionRecovery', 'noteSessionHandoff', 'notesPersistence', 'standaloneConversations', 'quickSession', 'durableTeamChat', 'aiProviderTabs', 'aiWorkflows',
  // Workflow runs and scheduled runs
  'workflowLoops', 'workflowAgentStage', 'workflowBuildStage', 'workflowInstallDeps', 'workflowRetryFailed',
  'workflowPolicy', 'workflowReviewDiff', 'workflowTemplateAddon', 'scheduledProviderHandover', 'securityReviewRun',
  // Code intelligence, git and other surfaces
  'codeIntelligence', 'codeSearchDialog', 'gitGraph', 'gitOnboarding', 'quickCapture', 'whatChanged', 'mobileAccess'
].map(name => `${name}.spec.ts`);

/** Each parallel checkout (agent worktree) serves its own renderer on its own port. */
const rendererPort = Number.parseInt(process.env.PRAXIS_E2E_PORT ?? '', 10) || 5173;

function configuredWorkers(): number {
  const explicit = Number.parseInt(process.env.PRAXIS_E2E_WORKERS ?? '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return process.env.CI ? 1 : 2;
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  workers: configuredWorkers(),
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${rendererPort}`,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `npx vite preview --port ${rendererPort} --strictPort --outDir dist`,
    cwd: path.resolve(__dirname, 'renderer'),
    port: rendererPort,
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  },
  projects: [
    {
      name: 'functional',
      testIgnore: [
        '**/appearanceSettings.spec.ts',
        '**/overview.spec.ts',
        '**/surfacePacks.spec.ts',
        '**/themeLooks.spec.ts',
        '**/*.live.spec.ts'
      ],
      grepInvert: /@theme/
    },
    {
      name: 'smoke',
      testMatch: SMOKE_SPECS.map(file => `**/${file}`),
      grepInvert: /@theme/
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
      name: 'live-agent',
      testMatch: '**/*.live.spec.ts',
      timeout: 600000,
      workers: 1
    }
  ]
});
