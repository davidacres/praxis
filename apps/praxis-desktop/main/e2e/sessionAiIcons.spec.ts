import * as path from 'node:path';
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test('session list displays single and multiple pixel-perfect AI brand icons beside each session', async () => {
  // Launch initial app to obtain test profile directory
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();

  // Seed sessions directly into ai-sessions.json:
  // 1. Single AI session (Claude Code) -> 1 icon
  // 2. Multi-AI session (Claude Code + OpenAI Codex via runtimeEpochs) -> 2 icons
  // 3. Multi-AI conversation (Anthropic + Gemini via conversation participants) -> 2 icons
  const now = new Date().toISOString();
  const session1 = 'SESSION-SINGLE';
  const session2 = 'SESSION-MULTI-EPOCH';
  const session3 = 'SESSION-MULTI-CONV';

  fs.writeFileSync(
    path.join(profile.userDataDir, 'ai-sessions.json'),
    JSON.stringify({
      'praxis.agentSessions': {
        [session1]: {
          issueKey: session1,
          sessionId: 'single-ai-session',
          title: 'Single AI Session',
          state: 'completed',
          startedAt: now,
          completedAt: now,
          provider: 'claude-code-cli',
          taskDefinition: { goal: 'Investigate architecture', sessionMode: 'chat' },
          events: []
        },
        [session2]: {
          issueKey: session2,
          sessionId: 'multi-epoch-session',
          title: 'Multi Epoch Session',
          state: 'completed',
          startedAt: now,
          completedAt: now,
          provider: 'claude-code-cli',
          runtimeEpochs: [
            { id: 'epoch-1', provider: 'claude-code-cli', startedAt: now, reason: 'started' },
            { id: 'epoch-2', provider: 'codex-cli', startedAt: now, reason: 'model_change' }
          ],
          taskDefinition: { goal: 'Collaborative code refactor', sessionMode: 'chat' },
          events: []
        },
        [session3]: {
          issueKey: session3,
          sessionId: 'multi-conv-session',
          title: 'Multi Conversation Session',
          state: 'completed',
          startedAt: now,
          completedAt: now,
          provider: 'anthropic',
          conversation: {
            mode: 'debate',
            currentSpeakerId: 'speaker-1',
            toolOwnerId: 'speaker-1',
            originalToolMode: 'full',
            turnCap: 6,
            turnsUsed: 2,
            state: 'idle',
            participants: [
              { id: 'speaker-1', provider: 'anthropic', role: 'host', displayLabel: 'Claude' },
              { id: 'speaker-2', provider: 'gemini', role: 'guest', displayLabel: 'Gemini' }
            ]
          },
          taskDefinition: { goal: 'Cross-model debate', sessionMode: 'chat' },
          events: []
        }
      }
    })
  );

  // Relaunch app with seeded sessions
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  const win = app.window;
  await win.locator('[data-testid="session-list-row"]').first().waitFor({ timeout: 15000 });

  // Open Sessions section if collapsed
  const sessionsToggle = win.getByTestId('nav-conversations-toggle');
  if (await sessionsToggle.isVisible()) {
    const isExpanded = await sessionsToggle.getAttribute('aria-expanded');
    if (isExpanded === 'false') {
      await sessionsToggle.click();
    }
  }

  // 1. Single AI session: exactly 1 icon badge (Claude)
  const singleRow = win.locator('[data-testid="session-list-row"]', { hasText: 'Single AI Session' });
  await expect(singleRow).toBeVisible({ timeout: 10000 });
  const singleIcons = singleRow.locator('[data-testid="session-ai-icons"]');
  await expect(singleIcons).toBeVisible();
  await expect(singleIcons.locator('.session-ai-icon-badge')).toHaveCount(1);
  await expect(singleIcons.locator('[data-provider="claude-code-cli"]')).toBeVisible();

  // 2. Multi-epoch session: 2 icon badges (Claude + OpenAI)
  const multiRow = win.locator('[data-testid="session-list-row"]', { hasText: 'Multi Epoch Session' });
  await expect(multiRow).toBeVisible();
  const multiIcons = multiRow.locator('[data-testid="session-ai-icons"]');
  await expect(multiIcons).toBeVisible();
  await expect(multiIcons.locator('.session-ai-icon-badge')).toHaveCount(2);
  await expect(multiIcons.locator('[data-provider="claude-code-cli"]')).toBeVisible();
  await expect(multiIcons.locator('[data-provider="codex-cli"]')).toBeVisible();

  // 3. Multi-conversation session: 2 icon badges (Anthropic + Gemini)
  const convRow = win.locator('[data-testid="session-list-row"]', { hasText: 'Multi Conversation Session' });
  await expect(convRow).toBeVisible();
  const convIcons = convRow.locator('[data-testid="session-ai-icons"]');
  await expect(convIcons).toBeVisible();
  await expect(convIcons.locator('.session-ai-icon-badge')).toHaveCount(2);
  await expect(convIcons.locator('[data-provider="anthropic"]')).toBeVisible();
  await expect(convIcons.locator('[data-provider="gemini"]')).toBeVisible();

  // Capture verification artifact screenshot of the sidebar session list showing the AI brand icons
  const sidebar = win.locator('.sidebar, nav[aria-label="Workspace"]').first();
  fs.mkdirSync('.praxis/session-artifacts', { recursive: true });
  await sidebar.screenshot({
    path: '.praxis/session-artifacts/session-list-ai-icons.png'
  });

  // Switch to EasyMode to verify EasyMode session card icons
  const easyModeSwitchBtn = win.getByRole('button', { name: /Switch to EasyMode/i });
  if (await easyModeSwitchBtn.isVisible()) {
    await easyModeSwitchBtn.click();
    await expect(win.locator('[data-testid="easymode-sessions-list"]')).toBeVisible({ timeout: 10000 });

    // Verify EasyMode single AI card
    const easySingleCard = win.locator(`[data-testid="easymode-session-card-${session1}"]`);
    await expect(easySingleCard).toBeVisible();
    const easySingleIcons = easySingleCard.locator('[data-testid="session-ai-icons"]');
    await expect(easySingleIcons).toBeVisible();
    await expect(easySingleIcons.locator('.session-ai-icon-badge')).toHaveCount(1);
    await expect(easySingleIcons.locator('[data-provider="claude-code-cli"]')).toBeVisible();

    // Verify EasyMode multi-AI card (epoch)
    const easyMultiCard = win.locator(`[data-testid="easymode-session-card-${session2}"]`);
    await expect(easyMultiCard).toBeVisible();
    const easyMultiIcons = easyMultiCard.locator('[data-testid="session-ai-icons"]');
    await expect(easyMultiIcons).toBeVisible();
    await expect(easyMultiIcons.locator('.session-ai-icon-badge')).toHaveCount(2);
    await expect(easyMultiIcons.locator('[data-provider="claude-code-cli"]')).toBeVisible();
    await expect(easyMultiIcons.locator('[data-provider="codex-cli"]')).toBeVisible();

    // Capture EasyMode verification screenshot
    const easySidebar = win.locator('.easymode-sidebar');
    await easySidebar.screenshot({
      path: '.praxis/session-artifacts/easymode-session-list-ai-icons.png'
    });
  }
});
