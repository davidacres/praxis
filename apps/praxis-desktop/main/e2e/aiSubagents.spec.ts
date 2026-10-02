import { openSession } from './sessionNavigation';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

test('parent session displays subagents with status, tokens, and model across inspector, header, and agent runtime', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-subagents-'));
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'Subagent coordinator task completed.' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined
  });
  const win = app.window;

  // 1. Delegate parent coordinator agent session
  const parent = await win.evaluate(
    async ({ cwd }) => window.praxis.ai.delegate({
      issueKey: 'APP-101',
      provider: 'vercel-gateway',
      model: 'gpt-4o',
      agentId: 'praxis-implementer',
      workingDirectory: cwd,
      task: { goal: 'Coordinate primary feature delivery with subagents.' }
    }),
    { cwd: repo }
  );

  // 2. Delegate child subagent session linked via parentSessionKey
  const child = await win.evaluate(
    async ({ cwd, parentKey }) => window.praxis.ai.delegate({
      issueKey: 'APP-102',
      provider: 'vercel-gateway',
      model: 'claude-3-5-sonnet',
      parentSessionKey: parentKey,
      workingDirectory: cwd,
      task: { goal: 'Perform code analysis subagent task.' }
    }),
    { cwd: repo, parentKey: parent.issueKey }
  );

  // Wait for both sessions to complete
  await expect.poll(() => win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), parent.issueKey
  ), { timeout: 20000 }).toBe('completed');

  await expect.poll(() => win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), child.issueKey
  ), { timeout: 20000 }).toBe('completed');

  // Navigate to Sessions view and select parent session
  await openSession(win, parent.issueKey);

  // 3. Header bar subagents chip
  const headerChip = win.locator('[data-testid="session-header-subagents-chip"]');
  await expect(headerChip).toBeVisible();
  await expect(headerChip).toContainText('1 subagent');

  // 4. Inspector Summary block shows subagent with status badge, model, tokens
  const summaryBlock = win.locator('[data-testid="session-subagents-summary-block"]');
  await expect(summaryBlock).toBeVisible();
  await expect(summaryBlock).toContainText('Subagents (1)');

  const subagentStatus = summaryBlock.locator('[data-testid="subagent-status-badge"]').first();
  await expect(subagentStatus).toBeVisible();
  await expect(subagentStatus).toHaveText('Completed');

  const subagentModel = summaryBlock.locator('[data-testid="subagent-model"]').first();
  await expect(subagentModel).toBeVisible();
  await expect(subagentModel).toContainText('claude-3-5-sonnet');

  const subagentTokens = summaryBlock.locator('[data-testid="subagent-tokens"]').first();
  await expect(subagentTokens).toBeVisible();

  // 5. Inspector Subagents Tab
  const subagentsTab = win.locator('[data-testid="session-tab-subagents"]');
  await expect(subagentsTab).toBeVisible();
  await expect(subagentsTab.locator('[data-testid="session-tab-subagents-count"]')).toHaveText('1');

  // Click Subagents tab to open detailed view
  await subagentsTab.click();
  const subagentsPanel = win.locator('[data-testid="session-panel-subagents"]');
  await expect(subagentsPanel).toBeVisible();

  // Verify aggregate summary metrics cards
  const metrics = win.locator('[data-testid="session-subagents-metrics"]');
  await expect(metrics).toBeVisible();
  await expect(metrics).toContainText('1 completed');

  // Verify subagent detail card
  const subagentCard = win.locator('[data-testid="session-subagent-card"]').first();
  await expect(subagentCard).toBeVisible();
  await expect(subagentCard.locator('[data-testid="subagent-status-badge"]')).toHaveText('Completed');
  await expect(subagentCard.locator('[data-testid="subagent-model"]')).toContainText('claude-3-5-sonnet');
  await expect(subagentCard.locator('[data-testid="subagent-tokens"]')).toBeVisible();

  // 6. Click open session button on subagent card to navigate to the child session
  const openBtn = subagentCard.locator('[data-testid="subagent-open-session-btn"]');
  await expect(openBtn).toBeVisible();
  await openBtn.click();
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toContainText('Perform code analysis subagent task');

  // Verify parent link banner on child session
  const parentBanner = win.locator('[data-testid="session-parent-banner"]');
  await expect(parentBanner).toBeVisible();
  await expect(parentBanner).toContainText('Subagent of');

  const parentLink = win.locator('[data-testid="session-parent-link"]');
  await expect(parentLink).toBeVisible();

  // Click parent link to return to parent session
  await parentLink.click();
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toContainText('Coordinate primary feature delivery');

  // 7. Open the profile from Agent Runtime to inspect its runtime subagents.
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await win.getByTestId('agent-runtime-profile-praxis-implementer').getByRole('button', { name: 'Open' }).click();

  // Verify sessions list in Agent Hub includes subagents section
  const hubSubagents = win.locator('[data-testid="agent-runtime-subagents"]');
  await expect(hubSubagents.first()).toBeVisible();
  await expect(hubSubagents.first().locator('[data-testid="agent-runtime-subagent-item"]')).toHaveCount(1);
  await expect(hubSubagents.first().locator('[data-testid="subagent-model"]')).toContainText('claude-3-5-sonnet');
});
