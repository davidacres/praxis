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

test('toggling EasyMode via titlebar button switches between standard sidebar and EasyModeSidebar', async () => {
  app = await launchTestApp({
    preview: { enableEasyMode: false }
  });
  const win = app.window;

  // EasyMode sidebar is not rendered initially
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);
  const toggleBtn = win.locator('[data-testid="mode-easymode"]');
  await expect(toggleBtn).toBeVisible();
  await expect(toggleBtn).toHaveAttribute('aria-label', /Switch to EasyMode/);
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-titlebar-classic.png') });

  // Click titlebar button to enable EasyMode
  await toggleBtn.click();
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // Button now indicates advance switch and has active styling
  const classicBtn = win.locator('[data-testid="mode-classic"]');
  await expect(classicBtn).toBeVisible();
  await expect(classicBtn).toHaveAttribute('aria-label', /Switch to (Advance|Classic) mode/);
  await expect(classicBtn).toHaveClass(/active/);
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-titlebar-active.png') });

  // Click again to switch back
  await classicBtn.click();
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);
});

test('opening a folder from Getting Started enables EasyMode', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-folder-easymode-'));
  try {
    app = await launchTestApp(
      { preview: { enableEasyMode: false } },
      undefined,
      undefined,
      { workspace: false }
    );
    const win = app.window;

    await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
    await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);

    // Mock dialog:pickFolder to select our folder
    await app.electronApp.evaluate(({ ipcMain }, targetFolder) => {
      ipcMain.removeHandler('dialog:pickFolder');
      ipcMain.handle('dialog:pickFolder', () => targetFolder);
    }, folder);

    // Click "Open Folder"
    await win.getByRole('button', { name: 'Open Folder' }).click();

    // Verify EasyMode sidebar is enabled and displayed
    await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();
    await expect(win.locator('[data-testid="mode-classic"]')).toBeVisible();
    await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-opened-folder.png') });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('opening a folder from TitleBar workspace menu enables EasyMode', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-folder-menu-easymode-'));
  try {
    app = await launchTestApp({
      preview: { enableEasyMode: false }
    });
    const win = app.window;

    await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);

    // Mock dialog:pickFolder to select our folder
    await app.electronApp.evaluate(({ ipcMain }, targetFolder) => {
      ipcMain.removeHandler('dialog:pickFolder');
      ipcMain.handle('dialog:pickFolder', () => targetFolder);
    }, folder);

    // Open workspace dropdown in titlebar
    await win.getByRole('button', { name: 'Select workspace' }).click();
    await expect(win.locator('[data-testid="workspace-menu-open-folder"]')).toBeVisible();
    await win.locator('[data-testid="workspace-menu-open-folder"]').click();

    // Verify EasyMode is now enabled
    await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();
    await expect(win.locator('[data-testid="mode-classic"]')).toBeVisible();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('global keyboard shortcut Cmd+Shift+E / Ctrl+Shift+E toggles EasyMode', async () => {
  app = await launchTestApp({
    preview: { enableEasyMode: false }
  });
  const win = app.window;

  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);

  // Press Ctrl+Shift+E / Meta+Shift+E
  const isMac = process.platform === 'darwin';
  await win.keyboard.press(isMac ? 'Meta+Shift+E' : 'Control+Shift+E');

  // Verify EasyMode is now active
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();
  await expect(win.locator('[data-testid="mode-classic"]')).toBeVisible();

  // Press again to toggle off
  await win.keyboard.press(isMac ? 'Meta+Shift+E' : 'Control+Shift+E');
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toHaveCount(0);
});

test('EasyMode canvas renders on project root with prompt hero, starter chips, and theme switch', async () => {
  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  // EasyMode sidebar is visible
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // EasyMode canvas should be rendered in the centre pane
  const canvas = win.locator('[data-testid="easymode-canvas"]');
  await expect(canvas).toBeVisible();

  // Check prompt input hero and starter chips
  await expect(win.locator('[data-testid="easymode-prompt-input"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-starter-explain-codebase"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-starter-review-git-changes"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-starter-run-test-suite"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-launch-btn"]')).toBeVisible();

  // Check snapshot chips
  await expect(win.locator('[data-testid="easymode-chip-sessions"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-chip-theme"]')).toBeVisible();

  // Click Simple Theme chip to toggle theme
  await win.locator('[data-testid="easymode-chip-theme"]').click();
  await expect(win.locator('[data-testid="easymode-chip-theme"]')).toHaveText(/Simple Dark Active/);

  // Take screenshot of EasyMode Canvas with Simple Dark Theme active
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-canvas-simple.png') });

  // Click starter action "Explain codebase" - should navigate to session composer with goal pre-filled
  await win.locator('[data-testid="easymode-starter-explain-codebase"]').click();
  await expect(win.locator('[data-testid="new-session-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="new-session-view"] textarea')).toHaveValue(/Explain the architecture/);
});

test('EasyMode sidebar displays onboarding empty cards when lists are empty', async () => {
  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // Empty state cards should be visible
  await expect(win.locator('[data-testid="easymode-sessions-empty-card"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-automations-empty-card"]')).toBeVisible();

  // Action buttons inside cards should be present
  await expect(win.locator('[data-testid="easymode-empty-new-session"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-empty-new-run"]')).toBeVisible();

  // Clicking "Start a session" button opens session composer
  await win.locator('[data-testid="easymode-empty-new-session"]').click();
  await expect(win.locator('[data-testid="new-session-view"]')).toBeVisible();
});

test('EasyMode session card displays live ticker, hover actions, and automations show stage badge', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-easymode-card-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  const now = new Date().toISOString();

  const seededSessions: Record<string, unknown> = {
    'SESSION-RUNNING': {
      issueKey: 'SESSION-RUNNING',
      sessionId: 'sess-running',
      title: 'Active Code Analysis',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Analyzing codebase.' },
      tokenUsage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      events: []
    },
    'SESSION-COMPLETED': {
      issueKey: 'SESSION-COMPLETED',
      sessionId: 'sess-completed',
      title: 'Completed Task',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'gpt-4o',
      taskDefinition: { goal: 'Finished.' },
      events: []
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    { userDataDir, settingsPath },
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // Broadcast live executing state to simulate active running turn
  await app.electronApp.evaluate(({ BrowserWindow }, record) => {
    for (const electronWin of BrowserWindow.getAllWindows()) {
      electronWin.webContents.send('ai:sessionChanged', record);
    }
  }, {
    issueKey: 'SESSION-RUNNING',
    sessionId: 'sess-running',
    title: 'Active Code Analysis',
    state: 'executing',
    startedAt: now,
    model: 'claude-3-5-sonnet',
    taskDefinition: { goal: 'Analyzing codebase.' },
    events: [
      {
        timestamp: now,
        type: 'message',
        summary: 'Indexing project files…'
      }
    ]
  });

  // Running session card should display live ticker with the summary
  const runningCard = win.locator('[data-testid="easymode-session-card-SESSION-RUNNING"]');
  await expect(runningCard).toBeVisible();
  await expect(runningCard.locator('.easymode-ticker-text')).toHaveText('Indexing project files…');

  // Hover actions should be present on running card: stop (abort) and delete
  await expect(runningCard.locator('[data-testid="easymode-session-abort-SESSION-RUNNING"]')).toBeVisible();
  await expect(runningCard.locator('[data-testid="easymode-session-delete-SESSION-RUNNING"]')).toBeVisible();

  // Completed card should only have delete button
  const completedCard = win.locator('[data-testid="easymode-session-card-SESSION-COMPLETED"]');
  await expect(completedCard).toBeVisible();
  await expect(completedCard.locator('[data-testid="easymode-session-delete-SESSION-COMPLETED"]')).toBeVisible();
  await expect(completedCard.locator('[data-testid="easymode-session-abort-SESSION-COMPLETED"]')).toHaveCount(0);
});

test('opening a folder in EasyMode scopes sessions to that folder and excludes unrelated sessions', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-easymode-scope-test-'));
  const targetFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-target-folder-'));
  const unrelatedFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-unrelated-folder-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');

  const now = new Date().toISOString();
  const seededSessions: Record<string, unknown> = {
    'SESSION-FOLDER': {
      issueKey: 'SESSION-FOLDER',
      sessionId: 'sess-folder',
      title: 'Target Folder Session',
      workingDirectory: targetFolder,
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Work in target folder.' },
      tokenUsage: { totalTokens: 400 },
      events: []
    },
    'SESSION-UNRELATED': {
      issueKey: 'SESSION-UNRELATED',
      sessionId: 'sess-unrelated',
      title: 'Unrelated Folder Session',
      workingDirectory: unrelatedFolder,
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'gpt-4o',
      taskDefinition: { goal: 'Work in unrelated folder.' },
      tokenUsage: { totalTokens: 300 },
      events: []
    },
    'SESSION-STANDALONE': {
      issueKey: 'SESSION-STANDALONE',
      sessionId: 'sess-standalone',
      title: 'Global Standalone Chat',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'gpt-4o',
      taskDefinition: { goal: 'Global chat.' },
      tokenUsage: { totalTokens: 200 },
      events: []
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  try {
    app = await launchTestApp(
      { preview: { enableEasyMode: false } },
      { userDataDir, settingsPath },
      undefined,
      { workspace: false }
    );
    const win = app.window;

    // Mock dialog:pickFolder to select our target folder
    await app.electronApp.evaluate(({ ipcMain }, folder) => {
      ipcMain.removeHandler('dialog:pickFolder');
      ipcMain.handle('dialog:pickFolder', () => folder);
    }, targetFolder);

    // Click "Open Folder"
    await win.getByRole('button', { name: 'Open Folder' }).click();

    // Verify EasyMode sidebar is visible
    const sidebar = win.locator('[data-testid="easymode-sidebar"]');
    await expect(sidebar).toBeVisible();

    // Verify only the target folder's session is present
    await expect(win.locator('[data-testid="easymode-session-card-SESSION-FOLDER"]')).toBeVisible();
    await expect(win.locator('[data-testid="easymode-session-card-SESSION-UNRELATED"]')).toHaveCount(0);
    await expect(win.locator('[data-testid="easymode-session-card-SESSION-STANDALONE"]')).toHaveCount(0);

    // Verify recent sessions on canvas only contains SESSION-FOLDER
    await expect(win.locator('[data-testid="easymode-recent-session-SESSION-FOLDER"]')).toBeVisible();
    await expect(win.locator('[data-testid="easymode-recent-session-SESSION-UNRELATED"]')).toHaveCount(0);

    // Capture visual verification screenshot
    await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-scoped-sessions.png') });
  } finally {
    fs.rmSync(targetFolder, { recursive: true, force: true });
    fs.rmSync(unrelatedFolder, { recursive: true, force: true });
  }
});

test('automation stage sessions appear nested under automation and are excluded from sessions list', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-automation-stages-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');

  const now = new Date().toISOString();
  const seededSessions: Record<string, unknown> = {
    'SESSION-USER-CHAT': {
      issueKey: 'SESSION-USER-CHAT',
      sessionId: 'sess-user',
      title: 'Database Schema Design',
      state: 'idle',
      startedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Design user and auth schema.' },
      events: []
    },
    'WF-run-999-stage-audit': {
      issueKey: 'WF-run-999-stage-audit',
      sessionId: 'sess-audit',
      title: 'Security Audit Stage',
      workflowRunId: 'run-999',
      workflowNodeId: 'node-audit',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Run security scanner.' },
      events: []
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    { userDataDir, settingsPath },
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  // Create a project so runsByProjectId queries listRuns
  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Deployment Project',
        key: 'DEPL',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'todo', name: 'Todo' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'Initial setup', description: '', issueType: 'Task', status: 'Todo' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    await window.praxis.ai.assignSessionToProject('SESSION-USER-CHAT', project.id);
    await window.praxis.ai.assignSessionToProject('WF-run-999-stage-audit', project.id);
    return project.id;
  });

  // Mock listRuns on ipcMain to return our test workflow run
  await app.electronApp.evaluate(({ ipcMain }, projId) => {
    ipcMain.removeHandler('workflows:listRuns');
    ipcMain.handle('workflows:listRuns', () => [
      {
        runId: 'run-999',
        projectId: projId,
        workflowName: 'Deployment & Audit Pipeline',
        status: 'completed',
        explanation: 'Auditing security and compiling artifacts',
        stages: [
          {
            nodeId: 'node-audit',
            name: 'Security Audit',
            type: 'agent',
            lane: 'done',
            attempts: 1,
            sessionKey: 'WF-run-999-stage-audit',
            chosenModel: 'claude-3-5-sonnet'
          },
          {
            nodeId: 'node-build',
            name: 'Compile & Package',
            type: 'agent',
            lane: 'running',
            attempts: 1,
            sessionKey: 'WF-run-999-stage-build',
            chosenModel: 'claude-3-5-sonnet'
          }
        ],
        startedAt: new Date().toISOString()
      }
    ]);
    ipcMain.removeHandler('workflows:cancelRun');
    ipcMain.handle('workflows:cancelRun', () => undefined);
  }, projectId);

  // Reload page to re-trigger workspace and run loading
  await win.reload();
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // 1. Verify user chat session is present in SESSIONS
  await expect(win.locator('[data-testid="easymode-session-card-SESSION-USER-CHAT"]')).toBeVisible();

  // 2. Verify internal automation stage session is NOT in SESSIONS
  await expect(win.locator('[data-testid="easymode-session-card-WF-run-999-stage-audit"]')).toHaveCount(0);

  // 3. Verify automation card is present in AUTOMATIONS
  const automationCard = win.locator('[data-testid="easymode-run-run-999"]');
  await expect(automationCard).toBeVisible();

  // Expand automation stages
  const expandBtn = automationCard.locator('[data-testid="easymode-run-expand-run-999"]');
  await expect(expandBtn).toBeVisible();
  await expandBtn.click();

  // 4. Verify internal stage session is nested under automation card
  const stageSessionRow = automationCard.locator('[data-testid="easymode-stage-node-audit"]');
  await expect(stageSessionRow).toBeVisible();
  await expect(stageSessionRow).toContainText('Security Audit');
  await expect(stageSessionRow).toContainText('Completed');

  // Take screenshot showing clean nesting and separation
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-automation-nested-stages.png') });
});

test('classic mode: automation stage sessions appear nested under automation run and are excluded from sessions tree', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-classic-stages-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');

  const now = new Date().toISOString();
  const seededSessions: Record<string, unknown> = {
    'SESSION-CLASSIC-USER': {
      issueKey: 'SESSION-CLASSIC-USER',
      sessionId: 'sess-classic-user',
      title: 'API Authentication Spec',
      state: 'idle',
      startedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Design OAuth endpoints.' },
      events: []
    },
    'WF-run-classic-stage-lint': {
      issueKey: 'WF-run-classic-stage-lint',
      sessionId: 'sess-classic-lint',
      title: 'Lint Codebase Stage',
      workflowRunId: 'run-888',
      workflowNodeId: 'node-lint',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Run ESLint across packages.' },
      events: []
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  app = await launchTestApp(
    { preview: { enableEasyMode: false } },
    { userDataDir, settingsPath },
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  // Create project and assign sessions
  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Backend API Project',
        key: 'BACK',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'todo', name: 'Todo' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'Backend setup', description: '', issueType: 'Task', status: 'Todo' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    await window.praxis.ai.assignSessionToProject('SESSION-CLASSIC-USER', project.id);
    await window.praxis.ai.assignSessionToProject('WF-run-classic-stage-lint', project.id);
    return project.id;
  });

  // Mock listRuns on ipcMain
  await app.electronApp.evaluate(({ ipcMain }, projId) => {
    ipcMain.removeHandler('workflows:listRuns');
    ipcMain.handle('workflows:listRuns', () => [
      {
        runId: 'run-888',
        projectId: projId,
        workflowName: 'Nightly CI Pipeline',
        status: 'completed',
        explanation: 'Nightly verification run',
        stages: [
          {
            nodeId: 'node-lint',
            name: 'Lint Codebase',
            type: 'agent',
            lane: 'done',
            attempts: 1,
            sessionKey: 'WF-run-classic-stage-lint',
            chosenModel: 'claude-3-5-sonnet'
          }
        ],
        startedAt: new Date().toISOString()
      }
    ]);
    ipcMain.removeHandler('workflows:cancelRun');
    ipcMain.handle('workflows:cancelRun', () => undefined);
  }, projectId);

  await win.reload();

  // 1. Verify standard Classic sidebar is visible
  const standardSidebar = win.locator('.sidebar');
  await expect(standardSidebar).toBeVisible();

  // 2. Standalone user session appears in the project's sessions tree
  const userSessionNode = win.locator('.session-nav-row', { hasText: 'API Authentication Spec' });
  await expect(userSessionNode).toBeVisible();

  // 3. Stage session does NOT appear as a standalone session in the sessions tree
  const stageSessionStandalone = win.locator('.session-nav-row', { hasText: 'Lint Codebase Stage' });
  await expect(stageSessionStandalone).toHaveCount(0);

  // 4. In Automations, Nightly CI Pipeline run is visible
  const runRow = win.locator('[data-testid="project-workflow-run-row"]', { hasText: 'Nightly CI Pipeline' });
  await expect(runRow).toBeVisible();

  // Expand run stages by clicking the automation run
  const runOpenBtn = runRow.locator('[data-testid="automation-run-open"]');
  await expect(runOpenBtn).toBeVisible();
  await runOpenBtn.click();

  // 5. Nested stage session is visible under the automation run
  const stageRow = runRow.locator('.automation-run-stage-row', { hasText: 'Lint Codebase' });
  await expect(stageRow).toBeVisible();

  // Take screenshot of classic mode nested stages
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/classic-automation-nested-stages.png') });
});


