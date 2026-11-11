import * as path from 'node:path';
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { chooseOption } from './chipSelect';
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
  // Standalone chats live under General conversations in the sidebar.
  await chooseOption(win.getByTestId('sidebar-project-select'), 'conversations');
  await expect(win.locator('[data-testid="easymode-sessions-list"]')).toBeVisible({ timeout: 10000 });
  const icons = (key: string) => win.locator(`[data-testid="easymode-session-card-${key}"]`).locator('[data-testid="session-ai-icons"]');

  // 1. Single AI session: exactly 1 icon badge (Claude)
  await expect(icons(session1)).toBeVisible();
  await expect(icons(session1).locator('.session-ai-icon-badge')).toHaveCount(1);
  await expect(icons(session1).locator('[data-provider="claude-code-cli"]')).toBeVisible();

  // 2. Multi-epoch session: 2 icon badges (Claude + Codex)
  await expect(icons(session2).locator('.session-ai-icon-badge')).toHaveCount(2);
  await expect(icons(session2).locator('[data-provider="claude-code-cli"]')).toBeVisible();
  await expect(icons(session2).locator('[data-provider="codex-cli"]')).toBeVisible();

  // 3. Multi-conversation session: 2 icon badges (Anthropic + Gemini)
  await expect(icons(session3).locator('.session-ai-icon-badge')).toHaveCount(2);
  await expect(icons(session3).locator('[data-provider="anthropic"]')).toBeVisible();
  await expect(icons(session3).locator('[data-provider="gemini"]')).toBeVisible();

  fs.mkdirSync('.praxis/session-artifacts', { recursive: true });
  await win.locator('.easymode-sidebar').screenshot({
    path: '.praxis/session-artifacts/easymode-session-list-ai-icons.png'
  });
});
