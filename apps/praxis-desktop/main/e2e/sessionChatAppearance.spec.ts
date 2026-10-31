import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp } from './launchTestApp';

for (const scenario of ['empty', 'recorded', 'follow-up']) {
test(`free-form chat preserves the initial request: ${scenario}`, async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-chat-appearance-'));
  const timestamp = new Date().toISOString();
  const issueKey = 'SESSION-appearance';
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
    [issueKey]: { issueKey, sessionId: 'appearance', title: 'Discuss the next steps', state: 'completed',
      provider: 'openai', startedAt: timestamp, completedAt: timestamp,
      taskDefinition: { goal: 'Help me outline the next steps.', sessionMode: 'chat' },
      events: scenario === 'empty' ? [] : [
        { timestamp, type: 'user_input_completed', summary: scenario === 'recorded' ? 'Help me outline the next steps.' : 'Please expand the second step.' },
        { timestamp, type: 'message', summary: 'Start with the smallest useful change, then check the result.' }
      ] }
  } }));
  const app = await launchTestApp({ preview: { enableEasyMode: true } }, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, undefined, { openNewSession: false });
  try {
    const page = app.window;
    const recent = page.getByTestId(`easymode-recent-session-${issueKey}`);
    await expect(recent).toBeVisible();
    await recent.click();
    await expect(page.getByTestId('agent-details-page')).toBeVisible();
    await expect(page.getByTestId('session-ticket-card')).toHaveCount(0);
    await expect(page.getByText('Goal & Purpose', { exact: true })).toHaveCount(0);
    const initialRequest = page.getByTestId('agent-timeline-prompt').filter({ hasText: 'Help me outline the next steps.' });
    await expect(initialRequest).toHaveCount(1);
    await expect(page.getByTestId('agent-timeline-prompt').first()).toContainText('Help me outline the next steps.');
    const messages = page.locator('.session-chat-message');
    await expect(messages.first()).toBeVisible();
    for (const message of await messages.all()) {
      expect(await message.evaluate(node => getComputedStyle(node).borderTopWidth)).toBe('0px');
      expect(await message.evaluate(node => getComputedStyle(node).borderRightWidth)).toBe('0px');
      expect(await message.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px');
    }
    fs.mkdirSync(path.resolve(__dirname, '../../.praxis/session-artifacts'), { recursive: true });
    if (scenario === 'follow-up') await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/session-initial-request.png') });
  } finally { await closeTestApp(app); }
});
}
