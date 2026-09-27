import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let userDataDir: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    userDataDir = undefined;
  }
});

test('default sidebar is standard when enableEasyMode is false', async () => {
  app = await launchTestApp({
    preview: { enableEasyMode: false }
  });
  const win = app.window;

  // The EasyMode sidebar should not be rendered
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);
});

test('toggling EasyMode in settings switches to EasyModeSidebar', async () => {
  app = await launchTestApp({
    preview: { enableEasyMode: false }
  });
  const win = app.window;

  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);

  // Open Settings
  await win.locator('[data-testid="titlebar-settings"]').click();
  const settingsDialog = win.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();

  // Navigate to Preview category
  await win.locator('[data-testid="settings-nav-preview"]').click();

  // Find the EasyMode toggle and toggle it on
  const easyModeToggle = win.locator('[data-testid="toggle-enable-easymode"]');
  await expect(easyModeToggle).toBeVisible();
  await expect(easyModeToggle).toHaveAttribute('aria-checked', 'false');

  await easyModeToggle.click();
  await expect(easyModeToggle).toHaveAttribute('aria-checked', 'true');

  // Close Settings dialog
  await settingsDialog.getByRole('button', { name: 'Done' }).click();
  await expect(settingsDialog).not.toBeVisible();

  // EasyMode sidebar should now be active
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();
});

test('EasyMode sidebar renders Sessions and Automations with + buttons and handles selection and navigation', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-easymode-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');

  const now = new Date().toISOString();
  const seededSessions: Record<string, unknown> = {
    'SESSION-101': {
      issueKey: 'SESSION-101',
      sessionId: 'sess-101',
      title: 'Auth Refactor Feature',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Refactor authentication module with subagents.' },
      tokenUsage: { inputTokens: 1200, outputTokens: 800, totalTokens: 2000 },
      cost: { amount: 0.04, currency: 'USD' },
      events: [
        {
          timestamp: now,
          type: 'user_input_completed',
          summary: 'Please refactor auth and verify token issuance.'
        },
        {
          timestamp: now,
          type: 'message',
          summary: 'Analyzing security requirements...',
          reasoning: 'First check passport strategy and migration scripts.'
        },
        {
          timestamp: now,
          type: 'tool_start',
          summary: 'Running tool: invoke_subagent',
          data: {
            callId: 'live-worker-1',
            toolName: 'invoke_subagent',
            argsSummary: 'Live Worker Subagent'
          }
        },
        {
          timestamp: now,
          type: 'tool_start',
          summary: 'Running tool: write_to_file',
          data: {
            callId: 'tool-call-1',
            toolName: 'write_to_file',
            kind: 'write',
            argsSummary: 'src/auth/token.ts'
          }
        },
        {
          timestamp: now,
          type: 'tool_complete',
          summary: 'Tool completed: write_to_file',
          detail: 'File updated successfully.',
          data: {
            callId: 'tool-call-1',
            toolName: 'write_to_file',
            kind: 'write',
            ok: true,
            diff: '@@ -1,3 +1,4 @@\n+// New JWT helper\n export function signToken() {}\n'
          }
        }
      ]
    },
    'SESSION-102': {
      issueKey: 'SESSION-102',
      parentSessionKey: 'SESSION-101',
      sessionId: 'sess-102',
      title: 'Token Tests Subagent',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'gpt-4o',
      taskDefinition: { goal: 'Run test suite on generated tokens.' },
      tokenUsage: { totalTokens: 500 },
      events: [
        {
          timestamp: now,
          type: 'tool_complete',
          summary: 'Tool completed: run_command',
          detail: 'Tests passed: 12/12',
          data: { toolName: 'run_command', kind: 'shell', ok: true }
        }
      ]
    },
    'SESSION-103': {
      issueKey: 'SESSION-103',
      parentSessionKey: 'SESSION-101',
      sessionId: 'sess-103',
      title: 'Lint Checker Subagent',
      state: 'failed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Run linter across repo.' },
      events: [
        {
          timestamp: now,
          type: 'error',
          summary: 'ESLint failed with 3 errors'
        }
      ]
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  app = await launchTestApp(
    {
      preview: { enableEasyMode: true },
      appearance: { themeId: 'simple', themeMode: 'dark' }
    },
    { userDataDir, settingsPath }
  );

  const win = app.window;

  // 1. EasyMode sidebar is visible
  const sidebar = win.locator('[data-testid="easymode-sidebar"]');
  await expect(sidebar).toBeVisible();

  // 2. Simple theme is applied
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'simple');

  // 3. Section headers
  const sessionsHeader = win.locator('[data-testid="section-header-sessions"]');
  await expect(sessionsHeader).toBeVisible();
  await expect(win.locator('[data-testid="section-header-add-sessions"]')).toBeVisible();

  const automationsHeader = win.locator('[data-testid="section-header-automations"]');
  await expect(automationsHeader).toBeVisible();
  await expect(win.locator('[data-testid="section-header-add-automations"]')).toBeVisible();

  // 4. Session card exists and shows primary agent and child subagents
  const sessionCard = win.locator('[data-testid="easymode-session-card-SESSION-101"]');
  await expect(sessionCard).toBeVisible();

  // Primary agent item (completed)
  const primaryAgent = win.locator('[data-testid="easymode-agent-SESSION-101"]');
  await expect(primaryAgent).toBeVisible();
  await expect(primaryAgent.locator('.easymode-status--success')).toBeVisible();

  // Running subagent item (glowing)
  const runningSubagent = win.locator('[data-testid="easymode-subagent-live-worker-1"]');
  await expect(runningSubagent).toBeVisible();
  await expect(runningSubagent.locator('.easymode-status--running')).toBeVisible();

  // Completed subagent item (green)
  const completedSubagent = win.locator('[data-testid="easymode-subagent-SESSION-102"]');
  await expect(completedSubagent).toBeVisible();
  await expect(completedSubagent.locator('.easymode-status--success')).toBeVisible();

  // Failed subagent item (red)
  const failedSubagent = win.locator('[data-testid="easymode-subagent-SESSION-103"]');
  await expect(failedSubagent).toBeVisible();
  await expect(failedSubagent.locator('.easymode-status--failed')).toBeVisible();

  // 5. Click running subagent row to navigate to dedicated Agent Details page
  await runningSubagent.click();

  // Agent Details page is rendered in center
  const agentDetailsPage = win.locator('[data-testid="agent-details-page"]');
  await expect(agentDetailsPage).toBeVisible();

  // Top bar checks for running agent
  await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Live Worker Subagent');
  await expect(win.locator('[data-testid="agent-details-status"]')).toContainText('Executing');
  await expect(win.locator('[data-testid="agent-details-stop-btn"]')).toBeVisible();

  // 6. Navigate to primary agent using the subagents bar
  const primaryNavBtn = win.locator('[data-testid="subagent-nav-primary"]');
  await expect(primaryNavBtn).toBeVisible();
  await primaryNavBtn.click();

  await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Auth Refactor Feature');
  await expect(win.locator('[data-testid="agent-details-role-badge"]')).toContainText('Primary Agent');
  await expect(win.locator('[data-testid="agent-details-status"]')).toContainText('Completed');

  // Check activity timeline has prompt, thought, and tool execution card
  await expect(win.locator('[data-testid="agent-timeline-prompt"]')).toBeVisible();
  await expect(win.locator('[data-testid="agent-timeline-thought"]')).toBeVisible();
  await expect(win.locator('[data-testid="tool-execution-card"]').first()).toBeVisible();

  // Check tool execution details
  const toolCard = win.locator('[data-testid="tool-execution-card"]').last();
  await expect(toolCard.locator('.tool-execution-card__name')).toContainText('write_to_file');

  // 7. Click back button to exit agent details
  await win.locator('[data-testid="agent-details-back-btn"]').click();
  await expect(agentDetailsPage).not.toBeVisible();

  // 8. Session container selection highlight (rounded corners, 20% white background)
  await sessionCard.click();
  await expect(sessionCard).toHaveClass(/is-selected/);

  // 9. Click + on Sessions opens New Session composer
  await win.locator('[data-testid="section-header-add-sessions"]').click();
  await expect(win.getByRole('textbox', { name: /What's the goal/i })).toBeVisible();
});

