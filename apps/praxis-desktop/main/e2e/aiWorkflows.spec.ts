import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { startMockGitLabApi, type MockGitLabServer } from './mockGitLabApi';

/**
 * Phase F — AI workflows. Exercises the desktop ports of the extension's AI
 * tooling against the mock gateway (no live key):
 *
 * 1. Workflow-pack picker lists packs discovered under
 *    `<workingDirectory>/.github/skills` and assigns one to an issue.
 * 2. The review page streams the review markdown and posts it as a comment.
 * 3. The analysis chat answers, confirms, and the analysis gate then lets
 *    delegation through (before confirmation the delegate action is blocked).
 * 4. A delivery run completes and the completion watcher finalizes it from the
 *    agent's DELIVERY_RESULT block.
 * 5. Feature decomposition creates the sub-task issues and lists them.
 * 6. Merge requests list (empty) and create against the mock GitLab API after
 *    a delivery recorded a branch.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let gitlab: MockGitLabServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (gitlab) {
    await gitlab.close();
    gitlab = undefined;
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function gatewayEnv(baseUrl: string): Record<string, string | undefined> {
  return { ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: baseUrl };
}

/** Temp dir posing as a repo with one workflow pack under .github/skills. */
function makeWorkspaceWithPack(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-'));
  tempDirs.push(dir);
  const skillDir = path.join(dir, '.github', 'skills', 'dotnet-api');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: dotnet-api',
      'description: Build .NET Web APIs',
      '---',
      '',
      '# .NET Web API',
      '',
      'Follow the API controller conventions.',
      ''
    ].join('\n')
  );
  return dir;
}

const DELIVERY_RESULT_REPLY = [
  'Implementation finished and published.',
  '',
  'DELIVERY_RESULT',
  '```json',
  JSON.stringify({
    status: 'success',
    summary: 'Implemented and published the change.',
    branch: 'feature/demo-1',
    commitHash: 'abc123',
    pushedRef: 'origin/feature/demo-1',
    buildIdentifier: '01',
    artifactPaths: ['dist/app-01.msi']
  }),
  '```'
].join('\n');

const DECOMPOSITION_REPLY = [
  'The feature splits cleanly into two tasks.',
  '',
  'FEATURE_DECOMPOSITION_RESULT',
  '```json',
  JSON.stringify({
    status: 'decomposed',
    summary: 'Split into two tasks.',
    featureBranch: 'feature/live-feature-thing',
    subTasks: [
      { summary: 'First subtask', description: 'Do part one.', issueType: 'Task', suggestedWorkflow: '', order: 1 },
      { summary: 'Second subtask', description: 'Do part two.', issueType: 'Task', suggestedWorkflow: '', order: 2 }
    ]
  }),
  '```'
].join('\n');

/** Open the first demo board's first issue in the aux detail pane. */
async function openFirstDemoIssue(win: import('playwright').Page): Promise<void> {
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('[data-testid="board-nav-item"]').first().click();
  await win.locator('[data-testid="issue-card"]').first().click();
  await win.locator('[data-testid="issue-ai-section"]').waitFor();
}

test('workflow pack picker lists discovered packs and assigns one', async () => {
  const workingDirectory = makeWorkspaceWithPack();
  app = await launchTestApp({ ai: { workingDirectory } }, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  await openFirstDemoIssue(win);
  await expect(win.locator('[data-testid="workflow-assignment-label"]')).toHaveText(
    'No workflow pack assigned'
  );

  await win.locator('[data-testid="workflow-assignment-change"]').click();
  const picker = win.locator('[data-testid="workflow-picker"]');
  await picker.waitFor();
  await expect(win.locator('[data-testid="workflow-pack-dotnet-api"]')).toContainText(
    '.NET Web API'
  );

  await win.locator('[data-testid="workflow-pack-dotnet-api"]').click();
  await expect(win.locator('[data-testid="workflow-assignment-label"]')).toHaveText(
    'Workflow pack: .NET Web API'
  );

  // Clearing via "No workflow pack" restores the unassigned label.
  await win.locator('[data-testid="workflow-assignment-change"]').click();
  await win.locator('[data-testid="workflow-pack-none"]').click();
  await expect(win.locator('[data-testid="workflow-assignment-label"]')).toHaveText(
    'No workflow pack assigned'
  );
});

test('review page streams the review markdown and posts it as a comment', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, gatewayEnv(mock.baseUrl));
  const win = app.window;

  await openFirstDemoIssue(win);
  await win.locator('[data-testid="issue-expand-btn"]').click();
  await win.locator('[data-testid="issue-ai-review-btn"]').click();
  await win.locator('[data-testid="ai-review-page"]').waitFor();
  await expect(win.locator('[data-testid="main-content-pane"]')).toBeVisible();

  await win.locator('[data-testid="ai-review-run"]').click();
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText(
    'Mock gateway reply',
    { timeout: 15000 }
  );

  await win.locator('[data-testid="ai-review-post-comment"]').click();
  await expect(win.locator('[data-testid="ai-review-post-comment"]')).toHaveText(
    'Posted as comment'
  );

  // The comment round-trips into the issue's comment list. The aux detail
  // pane keeps its initially-loaded comments, so reselect the issue to force
  // a remount before asserting.
  await win.locator('[aria-label="Close review"]').click();
  const cards = win.locator('[data-testid="issue-card"]');
  await cards.nth(1).click();
  await cards.nth(0).click();
  await expect(win.locator('.comment-bubble').last()).toContainText('Mock gateway reply');
});

test('analysis uses the selected runtime and continues implementation in the same session', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [
      { id: 'mock/fast', name: 'Mock Fast' },
      { id: 'mock/thorough', name: 'Mock Thorough' }
    ]
  });
  app = await launchTestApp(
    { ai: { analysisPrompt: 'You are a senior engineer assessing readiness.', analysisGateEnabled: true } },
    undefined,
    gatewayEnv(mock.baseUrl)
  );
  const win = app.window;

  await openFirstDemoIssue(win);

  // Runtime provider/model selection stays visible on the ticket details and
  // is passed to the analysis call — it is not hidden in the delegation modal.
  const provider = win.locator('[data-testid="issue-detail-ai-provider"]');
  const model = win.locator('[data-testid="issue-detail-ai-model"]');
  await expect(provider).toHaveValue('vercel-gateway');
  // Analysis gating must not silently remove configured implementation agents
  // from the provider list. Copilot's bundled runtime is always available.
  await expect(provider.locator('option[value="copilot-cli"]')).toHaveText('GitHub Copilot');
  await provider.selectOption('copilot-cli');
  await expect(provider).toHaveValue('copilot-cli');
  await provider.selectOption('vercel-gateway');
  await expect(model).toHaveValue('mock/fast');
  await model.selectOption('mock/thorough');

  // The gate turns the primary header action into Analyze ticket. It starts a
  // normal ticket session whose first turn is the configured read-only analysis.
  const primaryAi = win.locator('[data-testid="issue-primary-ai-btn"]');
  await expect(primaryAi).toHaveAttribute('data-ai-mode', 'analysis');
  await primaryAi.click();
  await win.locator('[data-testid="sessions-view"]').waitFor();
  await expect(win.locator('[data-testid="session-provider"]')).toContainText('Vercel AI Gateway');
  await expect(win.locator('[data-testid="session-model"]')).toContainText('mock/thorough');
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toContainText(
    'Mock gateway reply',
    { timeout: 15000 }
  );
  expect(JSON.parse(mock.requests[0].body).model).toBe('mock/thorough');
  expect(mock.requests[0].body).toContain('You are a senior engineer assessing readiness.');
  await expect(win.locator('[data-testid="session-analysis-banner"]')).toContainText(
    'Review the analysis below'
  );

  // Confirmation is a second turn in the same recorded conversation, not a
  // separate analysis view followed by a replacement implementation session.
  const originalTitle = await win.locator('[data-testid="session-console-title"]').textContent();
  await win.locator('[data-testid="session-analysis-confirm"]').click();
  await expect.poll(() => mock!.requests.length, { timeout: 15000 }).toBe(2);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-analysis-banner"]')).toContainText(
    'Implementation is continuing in this conversation.'
  );
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText(originalTitle ?? '');
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText(
    'I confirm the analysis and implementation plan'
  );
  expect(mock.requests[1].body).toContain('I confirm the analysis and implementation plan');
});

test('configured CLI agents remain available in ticket details when analysis is gated', async () => {
  app = await launchTestApp(
    { ai: { analysisPrompt: 'Assess this ticket.', analysisGateEnabled: true } },
    undefined,
    { ...NO_GATEWAY_ENV }
  );
  const win = app.window;

  await openFirstDemoIssue(win);
  await expect(win.locator('[data-testid="issue-ai-runtime-options"]')).toBeVisible();
  await expect(win.locator('[data-testid="issue-detail-ai-provider"]')).toHaveValue(/-cli$/);
  await win.locator('[data-testid="issue-ai-configure-btn"]').click();
  await expect(win.locator('[data-testid="settings-nav-ai"]')).toHaveClass(/active/);
  await expect(win.locator('.settings-section-title')).toHaveText('AI Provider');
});

test('analysis runs through the selected OpenAI provider and model', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [{ id: 'gpt-e2e-analysis', name: 'GPT E2E Analysis' }]
  });
  app = await launchTestApp(
    {
      ai: {
        analysisPrompt: 'Assess this ticket using the selected runtime.',
        analysisGateEnabled: true,
        activeProvider: 'openai',
        providers: { openai: { baseUrl: mock.baseUrl } }
      }
    },
    undefined,
    { ...NO_GATEWAY_ENV }
  );
  const win = app.window;
  await win.evaluate(() => window.praxis.ai.setProviderApiKey('openai', 'openai-e2e-key'));

  await openFirstDemoIssue(win);
  await expect(win.locator('[data-testid="issue-detail-ai-provider"]')).toHaveValue('openai');
  await expect(win.locator('[data-testid="issue-detail-ai-model"]')).toHaveValue('gpt-e2e-analysis');
  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toContainText(
    'Mock gateway reply',
    { timeout: 15000 }
  );

  expect(mock.requests).toHaveLength(1);
  expect(mock.requests[0].authorization).toBe('Bearer openai-e2e-key');
  expect(JSON.parse(mock.requests[0].body).model).toBe('gpt-e2e-analysis');
});

test('delivery run completes and the watcher finalizes it from the DELIVERY_RESULT block', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: DELIVERY_RESULT_REPLY });
  const workingDirectory = makeWorkspaceWithPack();
  app = await launchTestApp(
    {
      ai: { workingDirectory },
      delivery: {
        enabled: true,
        publishCommand: 'publish.ps1',
        artifactPattern: 'dist/*.msi',
        defaultBaseBranch: 'main'
      }
    },
    undefined,
    gatewayEnv(mock.baseUrl)
  );
  const win = app.window;

  await openFirstDemoIssue(win);
  await win.locator('[data-testid="issue-ai-delivery-btn"]').click();

  await expect(win.locator('[data-testid="issue-ai-state"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="issue-ai-delivery-phase"]')).toHaveText(
    'implementation · completed'
  );
  await expect(win.locator('[data-testid="issue-ai-finalization-message"]')).toHaveText(
    'Implemented and published the change.'
  );
});

test('delivery refuses to start when the workflow is disabled in settings', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, gatewayEnv(mock.baseUrl));
  const win = app.window;

  await openFirstDemoIssue(win);
  await expect(win.locator('[data-testid="issue-ai-delivery-btn"]')).toBeDisabled();
  await expect(win.locator('[data-testid="issue-ai-delivery-btn"]')).toHaveAttribute(
    'title',
    'Configure and enable the delivery workflow in Settings first'
  );
});

test('feature decomposition creates the sub-task issues and lists them', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: DECOMPOSITION_REPLY });
  const workingDirectory = makeWorkspaceWithPack();

  // Live-folder fixture: the decomposition finalizer creates real sub-task
  // markdown files, so this backend proves the whole chain.
  const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-decomp-'));
  tempDirs.push(plansDir);
  const featureDir = path.join(plansDir, 'features', 'feature-01-demo-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    [
      '# Demo Feature',
      '',
      '**Status:** 📋 Proposed',
      '**Type:** Feature',
      '',
      '## Description',
      '',
      'A demo feature for e2e testing.',
      ''
    ].join('\n')
  );

  app = await launchTestApp(
    {
      ai: { workingDirectory },
      delivery: {
        enabled: true,
        publishCommand: 'publish.ps1',
        artifactPattern: 'dist/*.msi',
        defaultBaseBranch: 'main'
      },
      connections: [
        {
          id: 'e2e-live-decomp',
          name: 'e2e-folder-decomp',
          mode: 'folder',
          settings: {
            path: plansDir,
            projectKey: 'LIVE',
            projectName: 'Live E2E',
            allowIssueCreation: true
          }
        }
      ]
    },
    undefined,
    gatewayEnv(mock.baseUrl)
  );
  const win = app.window;

  // Create the feature-request ticket through the normal New Issue flow.
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Live E2E' }).click();
  await win.locator('[data-testid="board-new-issue-btn"]').click();
  await win.locator('[data-testid="new-issue-type"]').selectOption('Feature');
  await win.locator('[data-testid="new-issue-summary"]').fill('e2e feature request');
  await win.locator('[data-testid="new-issue-description"]').fill('Feature request: split me.');
  await win.locator('[data-testid="new-issue-submit"]').click();

  // Open the created feature and decompose it.
  await win.locator('[data-testid="issue-card"]', { hasText: 'e2e feature request' }).click();
  await win.locator('[data-testid="issue-ai-section"]').waitFor();
  await win.locator('[data-testid="issue-ai-decompose-btn"]').click();

  await expect(win.locator('[data-testid="issue-ai-state"]')).toHaveText('Completed', {
    timeout: 15000
  });
  const subtasks = win.locator('[data-testid="decomposition-subtasks"]');
  await subtasks.waitFor({ timeout: 15000 });
  await expect(subtasks).toContainText('First subtask');
  await expect(subtasks).toContainText('Second subtask');
  await expect(subtasks).toContainText('feature/live-feature-thing');
});

test('local peer review runs the three sections against the gateway', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, gatewayEnv(mock.baseUrl));
  const win = app.window;

  await openFirstDemoIssue(win);
  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  await win.locator('[data-testid="issue-session-start"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await win.locator('[data-testid="board-nav-item"]').first().click();
  await win.locator('[data-testid="issue-card"]').first().click();
  await win.locator('[data-testid="issue-ai-lpr-btn"]').click();
  await win.locator('[data-testid="lpr-page"]').waitFor();

  // The review auto-runs on open (mirroring the extension's LPR command) —
  // the ticket summary is visible while the sections stream in.
  await expect(win.locator('[data-testid="lpr-ticket"]')).toBeVisible();

  // Code + security run first, then the summary verdict over both.
  await expect(win.locator('[data-testid="lpr-code-review"]')).toContainText(
    'Mock gateway reply',
    { timeout: 15000 }
  );
  await expect(win.locator('[data-testid="lpr-security-review"]')).toContainText(
    'Mock gateway reply'
  );
  await expect(win.locator('[data-testid="lpr-summary"]')).toContainText('Mock gateway reply');

  // Delegation establishes the completed implementation first; the final three
  // prompts are the code review, security review, and summary verdict.
  expect(mock.requests).toHaveLength(4);
  const peerReviewRequests = mock.requests.slice(-3);
  expect(peerReviewRequests.every(request => request.authorization === 'Bearer e2e-gateway-key')).toBe(true);
  expect(peerReviewRequests[0].body).toContain('senior software engineer');
  expect(peerReviewRequests[1].body).toContain('security engineer');
  expect(peerReviewRequests[2].body).toContain('technical lead');
});

test('merge requests list empty, then create after a delivery recorded a branch', async () => {
  gitlab = await startMockGitLabApi();
  mock = await startMockGatewayServer({ mode: 'complete', reply: DELIVERY_RESULT_REPLY });
  const workingDirectory = makeWorkspaceWithPack();
  app = await launchTestApp(
    {
      ai: { workingDirectory },
      delivery: {
        enabled: true,
        publishCommand: 'publish.ps1',
        artifactPattern: 'dist/*.msi',
        defaultBaseBranch: 'main'
      },
      connections: [
        {
          id: 'e2e-gitlab-mr',
          name: 'e2e-gitlab-mr',
          mode: 'gitlab',
          settings: {
            url: gitlab.baseUrl,
            projectPath: 'group/demo',
            apiKey: 'glpat-test'
          }
        }
      ]
    },
    undefined,
    gatewayEnv(mock.baseUrl)
  );
  const win = app.window;

  // Open the first issue on the mock GitLab board.
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Demo Board' }).first().click();
  await win.locator('[data-testid="issue-card"]').first().click();
  await win.locator('[data-testid="issue-ai-section"]').waitFor();

  // List: the mock has no MRs for the issue.
  await win.locator('[data-testid="issue-mr-load-btn"]').click();
  await expect(win.locator('[data-testid="issue-mr-section"]')).toContainText(
    'No merge requests reference'
  );

  // Deliver so a branch is recorded, then create the MR against the mock.
  await win.locator('[data-testid="issue-ai-delivery-btn"]').click();
  await expect(win.locator('[data-testid="issue-ai-state"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await win.locator('[data-testid="issue-mr-create-btn"]').click();
  await expect(win.locator('[data-testid="mr-1"]')).toContainText('mock-mr', { timeout: 10000 });
});
