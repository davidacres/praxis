import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let workspaceDir: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (workspaceDir) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = undefined;
  }
});

function createWorkspaceWithSkill(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-feedback-e2e-'));
  const skillDir = path.join(dir, '.agents', 'skills', 'plan-authoring');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: plan-authoring',
      'description: Write markdown plan items (features, stories, tasks, bugs) in docs/plans that a folder-backed Praxis board can parse.',
      '---',
      '',
      '# Plan Authoring Skill',
      'Use this skill whenever creating or updating markdown plan files under docs/plans.'
    ].join('\n')
  );
  return dir;
}

test('pre-send composer prompt check scores deterministically and applies one-click fixes', async () => {
  workspaceDir = createWorkspaceWithSkill();
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(
    {
      ai: {
        workingDirectory: workspaceDir,
        mcpServers: [
          {
            id: 'code-intelligence',
            name: 'code-intelligence',
            transport: 'stdio',
            command: 'node',
            enabled: true
          }
        ]
      }
    },
    undefined,
    {
      AI_GATEWAY_API_KEY: 'e2e-gateway-key',
      AI_GATEWAY_URL: mock.baseUrl,
      VERCEL_OIDC_TOKEN: undefined
    }
  );
  const win = app.window;

  // Switch tool mode to read-only to trigger a deterministic tool-mode conflict when asking to update files
  await chooseOption(win.locator('[data-testid="new-session-tool-mode"]'), 'read-only');

  const composerInput = win.locator('.composer-input');
  await composerInput.fill('update the plan in docs/plans/feature.md');

  const scoreBtn = win.getByTestId('composer-score-prompt-btn');
  await expect(scoreBtn).toBeEnabled();
  await scoreBtn.click();

  const popover = win.getByTestId('prompt-feedback-popover');
  await expect(popover).toBeVisible();
  await expect(win.getByTestId('prompt-feedback-digest')).toContainText('Rubric v1');

  // Verify the 3 pre-send dimensions are rendered
  await expect(win.getByTestId('prompt-dim-prompt-clarity')).toBeVisible();
  await expect(win.getByTestId('prompt-dim-skill-agent-alignment')).toBeVisible();
  await expect(win.getByTestId('prompt-dim-mcp-leverage')).toBeVisible();

  // Verify deterministic findings are surfaced
  await expect(win.getByTestId('prompt-finding-prompt-tool-mode-conflict')).toBeVisible();
  await expect(win.getByTestId('prompt-finding-skill-missed-plan-authoring')).toBeVisible();
  await expect(win.getByTestId('prompt-finding-prompt-missing-verification')).toBeVisible();

  const initialScoreText = await win.getByTestId('prompt-feedback-score').innerText();
  const initialScore = Number.parseInt(initialScoreText, 10);
  expect(initialScore).toBeLessThan(80);

  // Capture live visual verification screenshot of the composer prompt readiness popover
  const artifactPath = path.resolve(
    __dirname,
    '../../../../.praxis/session-artifacts/live-composer-prompt-check.png'
  );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  await win.screenshot({ path: artifactPath });

  // Click Apply All Fixes and verify deterministic score upgrade
  await win.getByTestId('prompt-feedback-apply-all-btn').click();

  await expect(win.getByTestId('prompt-feedback-attached-skills')).toContainText('plan-authoring');
  await expect
    .poll(async () => {
      const text = await win.getByTestId('prompt-feedback-score').innerText();
      return Number.parseInt(text, 10);
    })
    .toBeGreaterThanOrEqual(85);
  await expect(win.getByTestId('prompt-feedback-grade')).toHaveText('A');
});

test('post-session inspector scorecard audits tools/skills/MCPs, persists human feedback, and populates follow-up', async () => {
  workspaceDir = createWorkspaceWithSkill();
  mock = await startMockGatewayServer({ mode: 'complete' });
  const env = {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined,
    FROSTY_VERCEL_API_KEY: undefined
  };

  app = await launchTestApp(
    {
      ai: {
        workingDirectory: workspaceDir,
        mcpServers: [
          {
            id: 'code-intelligence',
            name: 'code-intelligence',
            transport: 'stdio',
            command: 'node',
            enabled: true
          }
        ]
      }
    },
    undefined,
    env,
    { openNewSession: false }
  );
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();

  const issueKey = 'SESSION-feedback-1';
  const now = new Date().toISOString();
  const seededRecord = {
    issueKey,
    sessionId: issueKey,
    title: 'Update plan feature item',
    provider: 'vercel-gateway',
    model: 'openai/gpt-4o-mini',
    state: 'completed',
    startedAt: now,
    completedAt: now,
    workingDirectory: workspaceDir,
    toolMode: 'full',
    mode: 'chat',
    stepCount: 5,
    activeSkills: [],
    taskDefinition: {
      kind: 'general',
      goal: 'update docs/plans/feature.md',
      scope: '',
      definitionOfDone: ''
    },
    events: [
      {
        timestamp: now,
        type: 'user_input_completed',
        summary: 'User prompt',
        detail: 'update docs/plans/feature.md'
      },
      {
        timestamp: now,
        type: 'tool_complete',
        summary: 'Ran grep',
        data: {
          toolName: 'run_command',
          callId: 'call-1',
          ok: true,
          args: { command: 'grep -rn "Status" docs/plans' }
        }
      },
      {
        timestamp: now,
        type: 'tool_complete',
        summary: 'Edit failed',
        data: {
          toolName: 'edit_file',
          callId: 'call-2',
          ok: false,
          args: { path: 'docs/plans/feature.md' }
        }
      },
      {
        timestamp: now,
        type: 'tool_complete',
        summary: 'Edit failed again',
        data: {
          toolName: 'edit_file',
          callId: 'call-3',
          ok: false,
          args: { path: 'docs/plans/feature.md' }
        }
      },
      {
        timestamp: now,
        type: 'tool_complete',
        summary: 'Edited file',
        data: {
          toolName: 'edit_file',
          callId: 'call-4',
          ok: true,
          args: { path: 'docs/plans/feature.md' }
        }
      },
      {
        timestamp: now,
        type: 'message',
        summary: 'Updated docs/plans/feature.md.',
        detail: 'I have updated `docs/plans/feature.md` with the requested changes.'
      }
    ]
  };

  fs.writeFileSync(
    path.join(profile.userDataDir, 'ai-sessions.json'),
    JSON.stringify({ 'praxis.agentSessions': { [issueKey]: seededRecord } })
  );

  app = await launchTestApp(undefined, profile, env, { openNewSession: false });
  const win = app.window;

  await openSession(win, issueKey);

  // Open Scorecard via the per-turn shortcut button on the assistant message
  const turnScoreBtn = win.getByTestId('session-chat-score-turn-btn');
  await expect(turnScoreBtn).toBeVisible();
  await turnScoreBtn.click();

  const panel = win.getByTestId('session-feedback-panel');
  await expect(panel).toBeVisible();
  await expect(win.getByTestId('feedback-turn-scope-banner')).toContainText('Scoped to Turn #1');

  // Switch to Full Session scope
  await win.getByTestId('feedback-turn-scope-banner').getByRole('button', { name: 'Show Full Session' }).click();
  await expect(win.getByTestId('feedback-turn-scope-banner')).toHaveCount(0);

  // Verify all 5 deterministic dimensions and capability audit rows
  await expect(win.getByTestId('session-dim-prompt-clarity')).toBeVisible();
  await expect(win.getByTestId('session-dim-tool-efficiency')).toBeVisible();
  await expect(win.getByTestId('session-dim-skill-agent-alignment')).toBeVisible();
  await expect(win.getByTestId('session-dim-mcp-leverage')).toBeVisible();
  await expect(win.getByTestId('session-dim-outcome-verification')).toBeVisible();

  await expect(win.getByTestId('audit-skills-missed')).toContainText('plan-authoring');
  await expect(win.getByTestId('audit-tools-called')).toContainText('2 failed');
  await expect(win.getByTestId('audit-mcp-leverage')).toContainText('1 raw shell grep');

  // Submit human feedback (Needs Work + Missed Skill + notes)
  await win.getByTestId('feedback-verdict-needs-work').click();
  await win.getByTestId('feedback-tag-missed-skill').click();
  await win.getByTestId('session-feedback-notes').fill('Should have loaded plan-authoring and verified the markdown plan parser.');
  await win.getByTestId('session-feedback-save-btn').click();

  await expect(win.getByTestId('session-feedback-saved-notice')).toBeVisible();
  await expect(win.getByTestId('session-feedback-badge')).toBeVisible();
  await expect(win.getByTestId('session-tab-scorecard-badge')).toBeVisible();

  // Verify persistence in SessionFeedbackStore
  const stored = await win.evaluate(key => window.praxis.ai.getSessionFeedback(key), issueKey);
  expect(stored).toBeDefined();
  expect(stored?.userFeedback?.verdict).toBe('needs-work');
  expect(stored?.userFeedback?.frictionTags).toContain('missed-skill');

  // Scroll inspector body to top so the scorecard hero, 5 dimensions, and capability audit are visible in the capture
  await win.locator('[data-testid="session-panel-scorecard"]').evaluate(el => {
    el.scrollTop = 0;
  });

  // Capture live visual verification screenshot of the Session Inspector Scorecard tab
  const scorecardArtifactPath = path.resolve(
    __dirname,
    '../../../../.praxis/session-artifacts/live-session-scorecard.png'
  );
  fs.mkdirSync(path.dirname(scorecardArtifactPath), { recursive: true });
  await win.screenshot({ path: scorecardArtifactPath });

  // Click Apply Improvements to Follow-Up and verify composer is populated
  await win.getByTestId('session-feedback-apply-followup-btn').click();
  const followUpValue = await win.getByTestId('session-follow-up-input').inputValue();
  expect(followUpValue.length).toBeGreaterThan(20);
});
