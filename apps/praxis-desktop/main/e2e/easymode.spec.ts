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

/** Computed opacity of a row's action overlay — `toBeVisible` ignores opacity, so it cannot tell hidden from shown. */
const opacityOf = (locator: import('@playwright/test').Locator) =>
  locator.evaluate(element => getComputedStyle(element).opacity);

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
  await expect(win.locator('[data-testid="session-chat-live-turn"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-activity-status"]')).toBeVisible();

  // 6. Navigate to primary agent using the subagents bar
  const primaryNavBtn = win.locator('[data-testid="subagent-nav-primary"]');
  await expect(primaryNavBtn).toBeVisible();
  await primaryNavBtn.click();

  await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Auth Refactor Feature');
  await expect(win.locator('[data-testid="agent-details-role-badge"]')).toContainText('Primary Agent');
  await expect(win.locator('[data-testid="agent-details-status"]')).toContainText('Completed');

  // Check activity timeline in conversation mode: prompt is visible, tools and thoughts are filtered out
  await expect(win.locator('[data-testid="agent-timeline-prompt"]')).toBeVisible();
  await expect(win.locator('[data-testid="agent-timeline-thought"]')).not.toBeVisible();
  await expect(win.locator('[data-testid="tool-execution-card"]')).not.toBeVisible();

  // Activity & Tools lives in the right sidebar, not as a tab in the chat
  await expect(win.locator('[data-testid="agent-details-tab-activity"]')).toHaveCount(0);

  // 7. Click back button to exit agent details
  await win.locator('[data-testid="agent-details-back-btn"]').click();
  await expect(agentDetailsPage).not.toBeVisible();

  // 8. Session container selection highlight (rounded corners, 20% white background) and opens details in center
  await sessionCard.locator('.easymode-session-card__head').click();
  await expect(sessionCard).toHaveClass(/is-selected/);
  await expect(agentDetailsPage).toBeVisible();
  await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Auth Refactor Feature');

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

  // The actions are a hover-only overlay: invisible at rest and after a click once the pointer leaves
  const runningActions = runningCard.locator('.easymode-card-actions');
  const runningTitle = runningCard.locator('.easymode-session-card__title');
  await win.mouse.move(0, 0);
  await expect.poll(() => opacityOf(runningActions)).toBe('0');
  const restingTitleWidth = (await runningTitle.boundingBox())!.width;
  await runningCard.hover();
  await expect.poll(() => opacityOf(runningActions)).toBe('1');
  // ...and they take no room from the title, so showing them does not re-truncate it
  expect((await runningTitle.boundingBox())!.width).toBeCloseTo(restingTitleWidth, 0);

  // Every card offers rename, archive and delete (parity with classic mode)
  for (const action of ['rename', 'archive', 'delete']) {
    await expect(runningCard.locator(`[data-testid="easymode-session-${action}-SESSION-RUNNING"]`)).toBeVisible();
  }

  // Completed card has no stop button
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

    // Clicking recent session opens details in the center
    await win.locator('[data-testid="easymode-recent-session-SESSION-FOLDER"]').click();
    await expect(win.locator('[data-testid="agent-details-page"]')).toBeVisible();
    await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Target Folder Session');

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

test('automation rows have rename, archive, delete and run actions like a session row', async () => {
  app = await launchTestApp({ preview: { enableEasyMode: true } }, undefined, undefined, { openNewSession: false });
  const win = app.window;

  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Automation Actions Project',
        key: 'AUTO',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Initial setup', description: '', issueType: 'Task', status: 'Todo' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    return project.id;
  });

  // Serve one finished run and record every run operation the sidebar asks for.
  await app.electronApp.evaluate(({ ipcMain }, projId) => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    (globalThis as { __runCalls?: typeof calls }).__runCalls = calls;
    ipcMain.removeHandler('workflows:listRuns');
    ipcMain.handle('workflows:listRuns', () => [
      {
        runId: 'run-actions',
        projectId: projId,
        workflowName: 'Nightly Audit',
        status: 'succeeded',
        explanation: 'Done',
        stages: [],
        startedAt: new Date().toISOString()
      }
    ]);
    for (const name of ['renameRun', 'archiveRun', 'deleteRun']) {
      ipcMain.removeHandler(`workflows:${name}`);
      ipcMain.handle(`workflows:${name}`, (_event, ...args: unknown[]) => {
        calls.push({ name, args });
        return undefined;
      });
    }
    ipcMain.removeHandler('workflows:inspectRunWork');
    ipcMain.handle('workflows:inspectRunWork', () => ({ hasWork: false, commitCount: 0, commits: [], uncommittedFiles: 0 }));
  }, projectId);
  const recordedCalls = () => app!.electronApp.evaluate(() => (globalThis as { __runCalls?: unknown[] }).__runCalls ?? []);

  await win.reload();
  const row = win.locator('[data-testid="easymode-run-run-actions"]');
  await expect(row).toBeVisible();

  // Hover-only overlay: hidden at rest, no room taken from the title, hidden again after a click once the pointer leaves
  const rowActions = row.locator('.easymode-automation-row__actions');
  const rowTitle = row.locator('.easymode-automation-row__title');
  await win.mouse.move(0, 0);
  await expect.poll(() => opacityOf(rowActions)).toBe('0');
  const restingTitleWidth = (await rowTitle.boundingBox())!.width;
  await row.hover();
  await expect.poll(() => opacityOf(rowActions)).toBe('1');
  expect((await rowTitle.boundingBox())!.width).toBeCloseTo(restingTitleWidth, 0);
  await row.locator('.easymode-automation-row').click({ position: { x: 20, y: 10 } });
  await win.mouse.move(0, 0);
  await expect.poll(() => opacityOf(rowActions)).toBe('0');
  await row.hover();

  // The same four actions a session row has, run last
  for (const action of ['rename', 'archive', 'delete', 'action']) {
    await expect(win.locator(`[data-testid="easymode-run-${action}-run-actions"]`)).toBeVisible();
  }

  await expect.poll(() => opacityOf(rowActions)).toBe('1');
  await win.locator('[data-testid="easymode-sidebar"]').screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-automation-row-actions.png') });

  // Rename edits the title in place and saves on Enter
  await win.locator('[data-testid="easymode-run-rename-run-actions"]').click();
  const titleInput = win.locator('[data-testid="easymode-run-title-input-run-actions"]');
  await expect(titleInput).toHaveValue('Nightly Audit');
  await titleInput.fill('Weekly Audit');
  await titleInput.press('Enter');
  await expect.poll(recordedCalls).toContainEqual({ name: 'renameRun', args: ['run-actions', 'Weekly Audit'] });

  // Archive is immediate, like a session
  await row.hover();
  await win.locator('[data-testid="easymode-run-archive-run-actions"]').click();
  await expect.poll(recordedCalls).toContainEqual({ name: 'archiveRun', args: ['run-actions', true] });

  // Delete asks first, and only deletes once confirmed
  await row.hover();
  await win.locator('[data-testid="easymode-run-delete-run-actions"]').click();
  await expect(win.getByText('Delete this run?')).toBeVisible();
  expect((await recordedCalls() as Array<{ name: string }>).some(call => call.name === 'deleteRun')).toBe(false);
  await win.getByRole('dialog').getByRole('button', { name: 'Delete run' }).click();
  await expect.poll(recordedCalls).toContainEqual({ name: 'deleteRun', args: ['run-actions', { deleteWork: false }] });
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

test('in EasyMode selecting a session opens details in the center', async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-easymode-select-details-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');

  const now = new Date().toISOString();
  const seededSessions: Record<string, unknown> = {
    'SESSION-FOCUS-1': {
      issueKey: 'SESSION-FOCUS-1',
      sessionId: 'sess-focus-1',
      title: 'Performance Optimization Session',
      state: 'completed',
      startedAt: now,
      completedAt: now,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Optimize database queries.' },
      tokenUsage: { totalTokens: 1500 },
      purpose: {
        issueKey: 'PERF-42',
        title: 'Optimize database queries',
        goal: 'Optimize database queries and add table indexes.',
        scope: 'Database layer and schema definitions',
        definitionOfDone: 'All queries benchmark under 10ms'
      },
      handoverBrief: {
        progress: 'Indexed database foreign keys and optimized table joins.',
        changes: 'Added migration index to user_id.',
        touchedFiles: ['src/db/schema.ts', 'src/db/migrate.ts'],
        nextSteps: 'Run benchmark suite against production volume.'
      },
      events: [
        {
          timestamp: now,
          type: 'user_input_completed',
          summary: 'You',
          detail: 'Please index the slow foreign keys first.'
        },
        {
          timestamp: now,
          type: 'message',
          summary: 'Indexed foreign key columns for fast lookups.',
          detail: 'Created index on `user_id` and benchmarked response times down to 4ms.\n\n- [x] Create database index on user_id\n- [ ] Run benchmark regression suite',
          durationMs: 4200,
          tokenUsage: { inputTokens: 1000, outputTokens: 512, totalTokens: 1512 },
          cost: { amount: 0.0123, currency: 'USD' }
        }
      ]
    }
  };

  fs.writeFileSync(
    path.join(userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': seededSessions }, null, 2)
  );

  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    { userDataDir, settingsPath }
  );
  const win = app.window;

  // 1. EasyMode sidebar is visible with session
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();
  const sessionCard = win.locator('[data-testid="easymode-session-card-SESSION-FOCUS-1"]');
  await expect(sessionCard).toBeVisible();

  // 2. Click the session in the sidebar
  await sessionCard.locator('.easymode-session-card__head').click();

  // 3. Details open in the center with Ticket Card, Tabs, and Composer
  const agentDetailsPage = win.locator('[data-testid="agent-details-page"]');
  await expect(agentDetailsPage).toBeVisible();
  await expect(win.locator('[data-testid="agent-details-session-link"]')).toContainText('Sessions');
  await expect(win.locator('[data-testid="agent-details-title"]')).toContainText('Performance Optimization Session');
  await expect(win.locator('[data-testid="agent-details-role-badge"]')).not.toBeVisible();
  await expect(win.locator('[data-testid="agent-details-status"]')).toContainText('Completed');

  // Verify Ticket Details Card
  await expect(win.locator('[data-testid="session-ticket-card"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-ticket-key"]')).toContainText('PERF-42');
  await expect(win.locator('[data-testid="session-ticket-goal"]')).toContainText('Optimize database queries');
  await expect(win.locator('[data-testid="session-ticket-outcome"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-ticket-progress"]')).toContainText('Indexed database foreign keys');
  await expect(win.locator('[data-testid="session-ticket-files"]')).toContainText('schema.ts');

  // Verify Conversation content (no tab bar)
  await expect(win.locator('[data-testid="agent-details-tab-conversation"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="agent-timeline-message"]')).toBeVisible();

  // The user's own message shows what they typed, not the speaker label stored in `summary`
  const userPrompt = win.locator('[data-testid="agent-timeline-prompt"]').first();
  await expect(userPrompt).toContainText('Please index the slow foreign keys first.');
  await expect(userPrompt.locator('[data-testid="session-chat-markdown"]')).not.toHaveText('You');

  // Workflows belong to automations in easy mode: the session composer has no workflow chip
  await expect(win.locator('[data-testid="agent-details-composer-dock"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-workflow-chips"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-workflow-add"]')).toHaveCount(0);

  // Each reply carries its turn's duration, tokens and cost, like the classic chat
  const telemetry = win.locator('[data-testid="agent-timeline-message"]').first().locator('[data-testid="session-chat-telemetry"]');
  await expect(telemetry).toContainText('1,512 tok');
  await expect(telemetry).toContainText('$0.01');
  await expect(telemetry).toContainText('4.2s');

  // Verify Task Checklist Progress inside Assistant message (Feature 4)
  await expect(win.locator('[data-testid="session-chat-tasks-progress"]')).toBeVisible();
  await expect(win.locator('.session-chat-tasks-count')).toContainText('50%');

  // Verify Quote and Branch buttons (Feature 5)
  await expect(win.locator('[data-testid="session-chat-quote-btn"]').first()).toBeVisible();
  await expect(win.locator('[data-testid="session-chat-branch-btn"]').first()).toBeVisible();

  // Test Quote action inserts blockquote into composer input
  await win.locator('[data-testid="session-chat-quote-btn"]').first().click();
  const composerInput = win.locator('[data-testid="session-follow-up-input"]');
  await expect(composerInput).toHaveValue(/> Please index the slow foreign keys first\./);

  // Verify standard session composer
  await expect(win.locator('[data-testid="agent-details-composer-dock"]')).toBeVisible();
  await expect(win.locator('.session-chat-composer')).toBeVisible();
  await expect(win.locator('[data-testid="session-follow-up-input"]')).toBeVisible();

  // The thread follows the latest message: the last one sits inside the
  // scroll body's visible area rather than below the fold under the ticket card.
  // Polled: the follow runs after layout settles (ResizeObserver + a frame), so a single read can race it.
  await expect.poll(() => win.evaluate(() => {
    const body = document.querySelector('[data-testid="agent-details-body"]');
    const messages = document.querySelectorAll('[data-testid="agent-timeline-message"]');
    const last = messages[messages.length - 1];
    if (!body || !last) return false;
    return last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1;
  })).toBe(true);

  // Take screenshot for visual inspection
  await win.screenshot({ path: path.resolve(__dirname, '../.praxis/session-artifacts/easymode-session-ticket-details.png') });

  // 4. Close details to return to canvas
  await win.locator('[data-testid="agent-details-back-btn"]').click();
  await expect(agentDetailsPage).not.toBeVisible();
  await expect(win.locator('[data-testid="easymode-canvas"]')).toBeVisible();

  // 5. Click the session from Recent Sessions on canvas
  const recentItem = win.locator('[data-testid="easymode-recent-session-SESSION-FOCUS-1"]');
  await expect(recentItem).toBeVisible();
  await recentItem.click();

  // 6. Details reopen in the center
  await expect(agentDetailsPage).toBeVisible();
  await expect(win.locator('[data-testid="session-ticket-card"]')).toBeVisible();
});

test('capture visual verification of redesigned EasyMode sidebar in real Electron app', async () => {
  app = await launchTestApp(
    { preview: { enableEasyMode: true }, appearance: { theme: 'dark', look: 'obsidian' } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'praxis-desktop',
        key: 'PRX',
        type: 'product',
        purpose: 'Desktop application and developer environment',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Auth refactor', description: '', issueType: 'Task', status: 'Todo' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    return project.id;
  });

  const now = new Date().toISOString();

  // Mock listRuns to return multi-stage pipeline runs with segmented gauges
  await app.electronApp.evaluate(({ ipcMain }, { projId, nowTime }) => {
    ipcMain.removeHandler('workflows:cancelRun');
    ipcMain.handle('workflows:cancelRun', () => undefined);
    ipcMain.removeHandler('workflows:listRuns');
    ipcMain.handle('workflows:listRuns', () => [
      {
        runId: 'run-sec-release',
        projectId: projId,
        workflowName: 'Security & Release',
        status: 'running',
        explanation: 'Auditing security and publishing release',
        stages: [
          {
            nodeId: 'node-lint',
            name: 'Lint & Types',
            type: 'agent',
            lane: 'done',
            attempts: 1,
            sessionKey: 'WF-run-sec-stage-lint',
            chosenModel: 'claude-3-5-sonnet'
          },
          {
            nodeId: 'node-audit',
            name: 'Security Audit',
            type: 'agent',
            lane: 'running',
            attempts: 1,
            sessionKey: 'WF-run-sec-stage-audit',
            chosenModel: 'claude-3-5-sonnet'
          },
          {
            nodeId: 'node-release',
            name: 'Package Release',
            type: 'agent',
            lane: 'idle',
            attempts: 0
          }
        ],
        startedAt: nowTime
      },
      {
        runId: 'run-nightly-ci',
        projectId: projId,
        workflowName: 'Nightly CI & Audit',
        status: 'succeeded',
        explanation: 'All 3 stages completed successfully',
        stages: [
          {
            nodeId: 'node-lint-2',
            name: 'Lint & Types',
            type: 'agent',
            lane: 'done',
            attempts: 1
          },
          {
            nodeId: 'node-audit-2',
            name: 'Security Audit',
            type: 'agent',
            lane: 'done',
            attempts: 1
          },
          {
            nodeId: 'node-pkg-2',
            name: 'Package Release',
            type: 'agent',
            lane: 'done',
            attempts: 1
          }
        ],
        startedAt: nowTime
      }
    ]);
  }, { projId: projectId, nowTime: now });

  await win.reload();
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // Send live agent sessions: one running with subagent & ticker, one awaiting approval gate, one completed
  await app.electronApp.evaluate(({ BrowserWindow }, { projId, nowTime }) => {
    const parentKey = 'SESSION-AUTH-REFACTOR';
    const subagentKey = 'SUBAGENT-TOKEN-VALIDATOR';

    const parentRecord = {
      issueKey: parentKey,
      sessionId: 'sess-auth',
      projectId: projId,
      title: 'Refactor Auth Middleware',
      state: 'executing',
      startedAt: nowTime,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Refactor auth middleware.' },
      events: [
        {
          timestamp: nowTime,
          type: 'message',
          summary: 'jwtBearer.ts enforcing token expiry…'
        }
      ]
    };

    const subagentRecord = {
      issueKey: subagentKey,
      parentSessionKey: parentKey,
      sessionId: 'sess-token-sub',
      projectId: projId,
      title: 'TokenValidator',
      state: 'executing',
      startedAt: nowTime,
      model: 'claude-3-5-haiku',
      taskDefinition: { goal: 'Validate token expiry logic' }
    };

    const gateRecord = {
      issueKey: 'SESSION-REVIEW-GATE',
      sessionId: 'sess-gate',
      projectId: projId,
      title: 'API Route Security Review',
      state: 'awaiting_approval',
      startedAt: nowTime,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Review API route changes' }
    };

    const completedRecord = {
      issueKey: 'SESSION-DB-MIGRATION',
      sessionId: 'sess-db',
      projectId: projId,
      title: 'Database Schema Migration',
      state: 'completed',
      startedAt: nowTime,
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'Apply schema migration' }
    };

    for (const electronWin of BrowserWindow.getAllWindows()) {
      electronWin.webContents.send('ai:sessionChanged', parentRecord);
      electronWin.webContents.send('ai:sessionChanged', subagentRecord);
      electronWin.webContents.send('ai:sessionChanged', gateRecord);
      electronWin.webContents.send('ai:sessionChanged', completedRecord);
    }
  }, { projId: projectId, nowTime: now });

  await expect(win.locator('[data-testid="easymode-session-card-SESSION-AUTH-REFACTOR"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-subagent-SUBAGENT-TOKEN-VALIDATOR"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-session-gate-SESSION-REVIEW-GATE"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-run-run-sec-release"]')).toBeVisible();
  await expect(win.locator('[data-testid="easymode-gauge-run-sec-release"]')).toBeVisible();

  // Dark Theme Captures
  const dirs = [
    path.resolve(__dirname, '../../.praxis/session-artifacts'),
    path.resolve(__dirname, '../../../.praxis/session-artifacts'),
    path.resolve(__dirname, '../.praxis/session-artifacts')
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await win.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'praxis-dark');
    document.documentElement.setAttribute('data-look', 'obsidian');
  });
  await win.waitForTimeout(800);
  const darkFull = await win.screenshot();
  const darkClose = await win.locator('[data-testid="easymode-sidebar"]').screenshot();

  for (const dir of dirs) {
    fs.writeFileSync(path.join(dir, 'easymode-sidebar-redesign.png'), darkFull);
    fs.writeFileSync(path.join(dir, 'easymode-sidebar-closeup-dark.png'), darkClose);
  }

  // Light Theme Captures
  await win.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'praxis-light');
    document.documentElement.setAttribute('data-look', 'parchment');
  });
  await win.waitForTimeout(400);

  const lightFull = await win.screenshot();
  const lightClose = await win.locator('[data-testid="easymode-sidebar"]').screenshot();

  for (const dir of dirs) {
    fs.writeFileSync(path.join(dir, 'easymode-sidebar-redesign-light.png'), lightFull);
    fs.writeFileSync(path.join(dir, 'easymode-sidebar-closeup-light.png'), lightClose);
  }
});





test('a long session list folds behind "Show more" and leaves the Runs section on screen', async () => {
  app = await launchTestApp(
    { preview: { enableEasyMode: true } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  const win = app.window;

  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'overflow-demo',
        key: 'OVF',
        type: 'product',
        purpose: 'Overflow check',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'Todo' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    return project.id;
  });

  const now = new Date().toISOString();
  await app.electronApp.evaluate(({ ipcMain }, { projId, nowTime }) => {
    ipcMain.removeHandler('workflows:cancelRun');
    ipcMain.handle('workflows:cancelRun', () => undefined);
    ipcMain.removeHandler('workflows:listRuns');
    ipcMain.handle('workflows:listRuns', () => [
      {
        runId: 'run-overflow',
        projectId: projId,
        workflowName: 'Nightly CI',
        status: 'succeeded',
        explanation: 'done',
        stages: [{ nodeId: 'n1', name: 'Lint', type: 'agent', lane: 'done', attempts: 1 }],
        startedAt: nowTime
      }
    ]);
  }, { projId: projectId, nowTime: now });

  await win.reload();
  await expect(win.locator('[data-testid="easymode-sidebar"]')).toBeVisible();

  // 14 finished sessions, newest first, plus one older session that is still running.
  await app.electronApp.evaluate(({ BrowserWindow }, { projId }) => {
    const records = [];
    for (let i = 0; i < 14; i += 1) {
      records.push({
        issueKey: `SESSION-DONE-${i}`,
        sessionId: `sess-done-${i}`,
        projectId: projId,
        title: `Finished session ${i}`,
        state: 'completed',
        startedAt: new Date(Date.now() - i * 60_000).toISOString(),
        model: 'claude-3-5-sonnet',
        taskDefinition: { goal: 'done' }
      });
    }
    records.push({
      issueKey: 'SESSION-OLD-LIVE',
      sessionId: 'sess-old-live',
      projectId: projId,
      title: 'Old but still running',
      state: 'executing',
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      model: 'claude-3-5-sonnet',
      taskDefinition: { goal: 'long task' }
    });
    for (const electronWin of BrowserWindow.getAllWindows()) {
      for (const record of records) electronWin.webContents.send('ai:sessionChanged', record);
    }
  }, { projId: projectId });

  const cards = win.locator('[data-testid^="easymode-session-card-"]');
  const showMore = win.locator('[data-testid="easymode-sessions-show-more"]');
  await expect(showMore).toBeVisible();

  // The cap (5) plus the older-but-live session, which must never be folded away.
  await expect(cards).toHaveCount(6);
  await expect(win.locator('[data-testid="easymode-session-card-SESSION-OLD-LIVE"]')).toBeVisible();

  // Runs stays inside the sidebar's visible area however long the session list is.
  const sidebarBox = await win.locator('[data-testid="easymode-sidebar"]').boundingBox();
  const runsBox = await win.locator('[data-testid="easymode-run-run-overflow"]').boundingBox();
  expect(sidebarBox && runsBox).toBeTruthy();
  expect(runsBox!.y + runsBox!.height).toBeLessThanOrEqual(sidebarBox!.y + sidebarBox!.height + 1);

  await showMore.click();
  await expect(cards).toHaveCount(15);
  await expect(showMore).toHaveText('Show fewer');
  // Even fully expanded, the Runs card is still on screen.
  const runsAfter = await win.locator('[data-testid="easymode-run-run-overflow"]').boundingBox();
  expect(runsAfter!.y + runsAfter!.height).toBeLessThanOrEqual(sidebarBox!.y + sidebarBox!.height + 1);

  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/easymode-sessions-overflow.png') });
});
