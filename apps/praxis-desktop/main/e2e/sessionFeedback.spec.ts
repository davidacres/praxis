import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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

/**
 * A git workspace whose state the Composer Coach grounds its fixes in: a
 * modified `src/PromptScoreBar.tsx`, a committed e2e spec named after it, and
 * npm scripts — so the chips must name those real files, not generic advice.
 */
function createGitWorkspace(): string {
  const dir = createWorkspaceWithSkill();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'coach-fixture', scripts: { test: 'node --test', 'check-types': 'tsc --noEmit' } }));
  fs.writeFileSync(path.join(dir, 'src', 'PromptScoreBar.tsx'), 'export const PromptScoreBar = () => null;\n');
  fs.writeFileSync(path.join(dir, 'e2e', 'promptScoreBar.spec.ts'), '// spec\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  fs.appendFileSync(path.join(dir, 'src', 'PromptScoreBar.tsx'), '// headline tweak\n');
  // A second changed file that also matches "prompt score bar", so the pin suggestion has an alternative
  fs.writeFileSync(path.join(dir, 'src', 'PromptScoreBarStyles.tsx'), 'export {};\n');
  return dir;
}

/** Fixed structured replies exercise transport/scoring, not semantic model quality. */
/**
 * Uncertain phrases are drawn behind the real textarea, which keeps every pointer event,
 * so a user's click lands on the textarea at the phrase — do the same here.
 */
async function clickComposerPhrase(win: Page, id: string): Promise<void> {
  const box = await win.getByTestId(`prompt-phrase-${id}`).boundingBox();
  expect(box, `prompt-phrase-${id} has no box`).toBeTruthy();
  await win.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

function clarityReply(body: string): string | undefined {
  const request = JSON.parse(body);
  if (!JSON.stringify(request.messages).includes('fixed checklist')) return undefined;
  const user = request.messages.find((m: { role: string }) => m.role === 'user')?.content ?? '';
  const prompt = String(user).split('<<<\n')[1]?.split('\n>>>')[0] ?? '';
  const question = prompt.startsWith('how ');
  const vague = prompt.includes('thing in the box');
  const checks = Object.fromEntries(['target', 'outcome', 'done', 'context-gap', 'ambiguity'].map(id => [id, {
    answer: id === 'context-gap' || id === 'ambiguity' ? 'no' : 'yes', evidence: '', fix: ''
  }]));
  if (!question && !/run the e2e|summary line/.test(prompt)) {
    if (!prompt.includes('@') || vague) checks.target = { answer: vague ? 'no' : 'partial', evidence: vague ? 'The thing' : '', fix: vague ? 'Name the object to move and the destination box.' : 'Name the file or component to change.' };
    if (!prompt.includes('verify')) checks.done = { answer: 'no', evidence: '', fix: 'Describe how to confirm the result.' };
  }
  if (vague) {
    checks.outcome = { answer: 'no', evidence: 'put', fix: 'Describe the expected behaviour after moving the object.' };
    checks.ambiguity = { answer: 'yes', evidence: 'the box', fix: 'Identify which box and what goes inside it.' };
  }
  for (const [id, check] of Object.entries(checks)) {
    Object.assign(check, { question: id === 'target' ? (vague ? 'Which object should be moved?' : 'Which file or component should change?') : id === 'done' ? 'How should the result be checked?' : 'What result do you want?' });
  }
  const unknown = { text: '', evidence: '', source: 'unknown' };
  const interpretation = {
    target: !vague && prompt.includes('prompt score bar') ? { text: 'Prompt score bar', evidence: 'prompt score bar', source: 'prompt' } : unknown,
    change: prompt.includes('fix the truncated headline') ? { text: 'Fix the truncated headline', evidence: 'fix the truncated headline', source: 'prompt' } : unknown,
    result: prompt.includes('truncated headline') ? { text: 'The headline is readable without truncation', evidence: 'truncated headline', source: 'prompt' } : unknown
  };
  return JSON.stringify({ kind: question ? 'question' : 'instruction', checks, interpretation });
}

const ARTIFACT_DIR = path.resolve(__dirname, '../../.praxis/session-artifacts');

test('composer coach grounds fixes in the workspace, previews text, and steps aside when ready', async () => {
  workspaceDir = createGitWorkspace();
  mock = await startMockGatewayServer({ mode: 'complete', replyFor: clarityReply });
  app = await launchTestApp(
    { ai: { workingDirectory: workspaceDir, gatewayUrl: mock.baseUrl, defaultModel: 'mock/model' } },
    undefined,
    {
      AI_GATEWAY_API_KEY: 'e2e-gateway-key',
      AI_GATEWAY_URL: mock.baseUrl,
      VERCEL_OIDC_TOKEN: undefined
    }
  );
  const win = app.window;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  await chooseOption(win.locator('[data-testid="new-session-tool-mode"]'), 'read-only');
  await expect(win.getByTestId('composer-score-prompt-btn')).toHaveCount(0);
  await expect(win.getByTestId('session-prompt-score-wrapper')).toHaveCount(0);

  const composerInput = win.locator('.composer-input');
  await composerInput.fill('fix the truncated headline in the prompt score bar');

  // Read-only + an edit verb is a hard blocker, so the coach appears without waiting for a typing pause
  const coach = win.getByTestId('session-prompt-score-wrapper');
  const strip = win.getByTestId('session-prompt-strip');
  const accept = win.getByTestId('prompt-strip-accept');
  await expect(coach).toHaveAttribute('data-state', 'open');
  await expect(strip).toHaveAttribute('data-suggestion', 'prompt-tool-mode-conflict');
  await expect(win.getByTestId('session-prompt-score-headline')).toHaveText(/session is Read-only/i);
  await expect(accept).toContainText('Switch to Full Access');

  // Once clarity is checked, the strip holds one suggestion at a time: the setting first,
  // then the file to pin and the check to run — both from this workspace, no boilerplate
  await expect(win.getByTestId('prompt-strip-position')).toHaveText('1 of 3', { timeout: 5000 });
  await expect(win.getByTestId('session-prompt-score-value')).toHaveText(/\d+/);
  expect(Number.parseInt(await win.getByTestId('session-prompt-score-value').innerText(), 10)).toBeLessThan(100);
  await composerInput.press('Alt+ArrowDown');
  await expect(strip).toHaveAttribute('data-suggestion', 'clarity-target');
  await expect(composerInput).toBeFocused();
  // The insertion is drawn in place as ghost text; nothing is in the draft until it is accepted
  const ghost = win.getByTestId('prompt-ghost-text');
  await expect(ghost).toHaveText(' in @src/PromptScoreBar.tsx.');
  expect(await ghost.evaluate(el => el.closest('.composer-input-shell') !== null)).toBe(true);
  await expect(composerInput).toHaveValue('fix the truncated headline in the prompt score bar');
  // ⌥] cycles to the other matching file and back
  await expect(win.getByTestId('prompt-strip-cycle')).toContainText('1/2');
  await composerInput.press('Alt+BracketRight');
  await expect(ghost).toHaveText(' in @src/PromptScoreBarStyles.tsx.');
  await composerInput.press('Alt+BracketLeft');
  await expect(ghost).toHaveText(' in @src/PromptScoreBar.tsx.');
  const coachCard = win.locator('.composer:has([data-testid="session-prompt-score-wrapper"])');
  await coachCard.scrollIntoViewIfNeeded();
  await win.waitForTimeout(300);
  const coachBox = await coachCard.boundingBox();
  await win.screenshot({ path: path.join(ARTIFACT_DIR, 'composer-coach-v2-live.png'), clip: coachBox! });

  // The rest of the coach lives behind "details"
  await expect(win.getByTestId('prompt-coach-details')).toHaveCount(0);
  await win.getByTestId('prompt-strip-details-toggle').click();
  await expect(win.getByTestId('session-prompt-intent')).toHaveText(/Intent: Bugfix \/ Edit/);
  await expect(win.getByTestId('prompt-understanding-target')).toContainText('Prompt score bar');
  const sessionsBeforePreview = await win.evaluate(() => window.praxis.ai.listSessions());
  await win.getByTestId('prompt-rehearsal-toggle').click();
  await expect(win.getByTestId('prompt-rehearsal')).toContainText('Proposed approach · nothing executed');
  await expect(win.getByTestId('prompt-rehearsal')).toContainText('Full access would be required');
  expect((await win.evaluate(() => window.praxis.ai.listSessions())).length).toBe(sessionsBeforePreview.length);
  await win.getByTestId('prompt-strip-details-toggle').click();

  // Tab accepts the suggestion in focus and moves straight on; the caret stays in the draft
  await composerInput.focus();
  await composerInput.press('Tab');
  await expect(composerInput).toHaveValue('fix the truncated headline in the prompt score bar in @src/PromptScoreBar.tsx.');
  await expect(composerInput).toBeFocused();
  await expect(coach).toHaveAttribute('data-state', 'open');
  await expect(strip).toHaveAttribute('data-suggestion', 'clarity-done');
  await expect(ghost).toContainText('and verify with `npx playwright test e2e/promptScoreBar.spec.ts`');
  await composerInput.press('Tab');
  await expect(composerInput).toHaveValue(
    'fix the truncated headline in the prompt score bar in @src/PromptScoreBar.tsx and verify with `npx playwright test e2e/promptScoreBar.spec.ts`.'
  );
  await expect(strip).toHaveAttribute('data-suggestion', 'prompt-tool-mode-conflict');
  await expect(ghost).toHaveCount(0);
  await composerInput.press('Tab');
  await expect(win.locator('[data-testid="new-session-tool-mode"]')).toHaveAttribute('data-value', 'full');

  // With nothing left, it says so briefly and steps aside
  await expect(win.getByTestId('session-prompt-ready-banner')).toContainText('All 3 handled', { timeout: 5000 });
  await expect(coach).toHaveCount(0, { timeout: 5000 });
  await win.getByTestId('prompt-coach-open').click();
  await expect(win.getByTestId('prompt-rehearsal')).toContainText('npx playwright test e2e/promptScoreBar.spec.ts');
  await expect(composerInput).toHaveValue(/verify with/);
  await win.getByTestId('session-prompt-dismiss-btn').click();
  await expect(coach).toHaveCount(0);

  // A question is never graded on files or tests — and once the check passes, the
  // composer frame itself settles to green; editing the draft drops it back until re-checked
  const composerCard = win.locator('.composer:has(.composer-input)');
  await composerInput.fill('how does the prompt score bar decide when to appear?');
  await win.waitForTimeout(1600);
  await expect(coach).toHaveCount(0);
  await expect(composerCard).toHaveAttribute('data-prompt-analysis', 'ok');
  await win.waitForTimeout(700);
  const okBorder = await composerCard.evaluate(el => getComputedStyle(el).borderTopColor);
  const okBox = await composerCard.boundingBox();
  await win.screenshot({ path: path.join(ARTIFACT_DIR, 'composer-analysis-ok.png'), clip: okBox! });
  await composerInput.press('End');
  await composerInput.pressSequentially(' x');
  await expect(composerCard).toHaveAttribute('data-prompt-analysis', 'idle');
  await win.waitForTimeout(300);
  expect(await composerCard.evaluate(el => getComputedStyle(el).borderTopColor)).not.toBe(okBorder);

  // A prompt made of placeholders fails, and the coach says how to rewrite it even
  // when no one-click fix exists (regression: it used to score 100 · A and stay hidden)
  await composerInput.fill('put the thing in the box');
  await expect(coach).toHaveAttribute('data-state', 'open', { timeout: 4000 });
  await expect(win.getByTestId('session-prompt-score-value')).toHaveText('40');
  await expect(win.getByTestId('prompt-phrase-target')).toHaveText('the thing');
  await expect(win.getByTestId('prompt-phrase-ambiguity')).toHaveText('the box');
  await expect(composerCard).toHaveAttribute('data-prompt-analysis', 'issues');
  // The marks are drawn in the composer input itself, not in a copy inside the coach
  const inputBox = (await composerInput.boundingBox())!;
  const phraseBox = (await win.getByTestId('prompt-phrase-target').boundingBox())!;
  expect(phraseBox.y).toBeGreaterThanOrEqual(inputBox.y);
  expect(phraseBox.y + phraseBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height + 1);
  expect(await win.getByTestId('prompt-phrase-target').evaluate(el => el.closest('.composer-input-shell') !== null)).toBe(true);
  await expect(win.getByTestId('session-prompt-projected-pill')).toHaveCount(0);
  // Phrases come first in reading order; the one in focus is drawn strongest, the rest fade
  await expect(win.getByTestId('prompt-strip-position')).toHaveText('1 of 4');
  await expect(strip).toHaveAttribute('data-suggestion', 'clarity-outcome');
  await expect(win.getByTestId('prompt-phrase-outcome')).toHaveClass(/is-active/);
  await expect(win.getByTestId('prompt-phrase-target')).toHaveClass(/is-dim/);
  // An Undo left over from an earlier draft's edit must not offer to restore that draft
  await expect(win.getByTestId('session-prompt-undo-btn')).toHaveCount(0);
  await win.waitForTimeout(400);
  const vagueBox = await win.locator('.composer:has([data-testid="session-prompt-score-wrapper"])').boundingBox();
  await win.screenshot({ path: path.join(ARTIFACT_DIR, 'composer-coach-vague-prompt.png'), clip: vagueBox! });

  await win.getByTestId('prompt-strip-details-toggle').click();
  await expect(win.getByTestId('prompt-understanding-target')).toContainText('Not identified');
  await win.getByTestId('prompt-rehearsal-toggle').click();
  await expect(win.getByTestId('prompt-rehearsal')).toContainText('Clarify target, change, result');
  await win.getByTestId('prompt-strip-details-toggle').click();

  // Clicking a phrase in the draft brings its question into the strip without taking the caret
  await clickComposerPhrase(win, 'target');
  await expect(strip).toHaveAttribute('data-suggestion', 'clarity-target');
  await expect(win.getByTestId('session-prompt-score-headline')).toContainText('Which object should be moved?');
  await expect(win.getByTestId('prompt-phrase-target')).toHaveClass(/is-active/);
  await expect(composerInput).toBeFocused();
  // A phrase needs the user's own words: Tab moves to the answer, Enter replaces the phrase
  await composerInput.press('Tab');
  const answer = win.getByTestId('prompt-strip-answer');
  await expect(answer).toBeFocused();
  await answer.fill('the settings toggle');
  await expect(composerInput).toHaveValue('put the thing in the box');
  await answer.press('Enter');
  await expect(composerInput).toHaveValue('put the settings toggle in the box');
  await expect(composerInput).toBeFocused();
  await expect(coach).toHaveAttribute('data-state', 'open');
  await expect(win.getByTestId('session-prompt-undo-btn')).toBeVisible();
  await win.getByTestId('session-prompt-undo-btn').click();
  await expect(composerInput).toHaveValue('put the thing in the box');
  await expect(win.getByTestId('session-prompt-score-value')).toHaveText('40', { timeout: 5000 });

  await win.getByTestId('prompt-strip-details-toggle').click();
  await win.getByTestId('prompt-review-quality').locator('summary').click();
  await win.getByTestId('finding-review-clarity-target-wrong').click();
  await expect(win.getByTestId('finding-review-clarity-target-wrong')).toHaveAttribute('aria-pressed', 'true');
  const digest = await coach.getAttribute('data-input-digest');
  const labelled = await win.evaluate(key => window.praxis.ai.getFindingFeedback(key), digest!);
  await expect(win.getByTestId('session-prompt-score-value')).toHaveText('40');
  expect(labelled.reviews.some(review => review.findingId === 'clarity-target' && review.verdict === 'wrong')).toBe(true);
  await win.getByTestId('finding-mute-clarity-target').click();
  await expect(win.getByTestId('prompt-phrase-target')).toHaveCount(0);
  await expect(win.getByTestId('prompt-strip-position')).toHaveText(/of 3/);
  await win.getByRole('button', { name: 'Show 1 muted checks' }).click();
  await win.getByTestId('finding-mute-clarity-target').click();
  await expect(win.getByTestId('prompt-phrase-target')).toBeVisible();
  const reviewIds = ['clarity-target', 'clarity-outcome', 'clarity-ambiguity', 'clarity-done'];
  for (const id of reviewIds) {
    await win.getByTestId(`finding-review-${id}-wrong`).click();
    await win.getByTestId(`finding-mute-${id}`).click();
  }
  await expect(coach).toContainText('4 checks muted');
  await expect(win.getByTestId('prompt-understanding')).toHaveCount(0);
  await win.getByRole('button', { name: 'Review muted checks' }).click();
  for (const id of reviewIds) await win.getByTestId(`finding-mute-${id}`).click();
  await expect(win.getByTestId('session-prompt-score-value')).toHaveText('40');
  await win.getByTestId('prompt-review-quality').locator('summary').click();
  const fiveBox = await win.locator('.composer:has([data-testid="session-prompt-score-wrapper"])').boundingBox();
  await win.screenshot({ path: path.join(ARTIFACT_DIR, 'prompt-coach-five-improvements.png'), clip: fiveBox! });

  // A non-blocking suggestion waits for a typing pause, and Snooze hides it
  await composerInput.fill('add a dark mode toggle to the prompt score bar');
  await expect(coach).toHaveAttribute('data-state', 'open', { timeout: 4000 });
  // Snooze applies to the findings on screen, so wait for this draft's own findings
  await expect(accept).toContainText('Pin @PromptScoreBar.tsx');
  await win.getByTestId('session-prompt-dismiss-btn').click();
  await expect(coach).toHaveCount(0, { timeout: 2000 });
});

test('post-session inspector scorecard audits tools/skills/MCPs, persists human feedback, and populates follow-up', async () => {
  workspaceDir = createWorkspaceWithSkill();
  let delayOldSave = false;
  mock = await startMockGatewayServer({ mode: 'complete', replyFor: clarityReply,
    responseDelayFor: body => delayOldSave && JSON.parse(body).messages.some((message: { role: string; content: string }) =>
      message.role === 'user' && message.content.includes('<<<\nupdate docs/plans/feature.md\n>>>')) ? 6000 : 0
  });
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
        gatewayUrl: mock.baseUrl,
        defaultModel: 'mock/model',
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
  const later = new Date(Date.now() + 60_000).toISOString();
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
          args: { path: 'docs/plans/feature.md' },
          fileChanges: [{ path: 'docs/plans/feature.md' }]
        }
      },
      {
        timestamp: now,
        type: 'message',
        summary: 'Updated docs/plans/feature.md.',
        detail: 'I have updated `docs/plans/feature.md` with the requested changes.'
      },
      // A second turn, so each reply's score button must open its own turn
      {
        timestamp: later,
        type: 'user_input_completed',
        summary: 'User prompt',
        detail: 'also add a summary line'
      },
      {
        timestamp: later,
        type: 'message',
        summary: 'Added the summary line.',
        detail: 'Added a one-line summary to the top of `docs/plans/feature.md`.'
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

  // Each reply's score button scopes the scorecard to that reply's own turn
  // (regression: every button used to open Turn #1)
  const turnScoreBtns = win.getByTestId('session-chat-score-turn-btn');
  await expect(turnScoreBtns).toHaveCount(2);
  await turnScoreBtns.last().click();
  const panel = win.getByTestId('session-feedback-panel');
  await expect(panel).toBeVisible();
  await expect(win.getByTestId('feedback-turn-scope-banner')).toContainText('Scoped to Turn #2');
  await win.evaluate(key => window.praxis.ai.evaluateSession({ issueKey: key, turnIndex: 1 }), issueKey);
  const scopedRequest = mock.requests.map(request => JSON.parse(request.body))
    .flatMap(request => request.messages ?? [])
    .find(message => message.role === 'user' && message.content.includes('<<<\nalso add a summary line\n>>>'));
  expect(scopedRequest).toBeTruthy();
  expect(scopedRequest.content).toContain('I have updated');
  expect(scopedRequest.content).not.toContain('Added a one-line summary');

  await turnScoreBtns.first().click();
  await expect(win.getByTestId('feedback-turn-scope-banner')).toContainText('Scoped to Turn #1');

  // Switch to Full Session scope
  await win.getByTestId('feedback-turn-scope-banner').getByRole('button', { name: 'Show Full Session' }).click();
  await expect(win.getByTestId('feedback-turn-scope-banner')).toHaveCount(0);

  // Executive diagnosis names the root causes, not symptom counts
  await expect(win.getByTestId('session-feedback-diagnosis')).toHaveText(/^Completed with/);

  // Five dimensions, each carrying its own capability facts
  for (const dim of ['prompt-clarity', 'tool-efficiency', 'skill-agent-alignment', 'mcp-leverage', 'outcome-verification']) {
    await expect(win.getByTestId(`session-dim-${dim}`)).toBeVisible();
  }
  await expect(win.getByTestId('session-dim-signals-skill-agent-alignment')).toContainText('Missed skill: plan-authoring');
  await expect(win.getByTestId('session-dim-signals-tool-efficiency')).toContainText('2 failed edits');
  await expect(win.getByTestId('session-dim-signals-mcp-leverage')).toContainText('1 shell grep vs code_intelligence');

  await expect(win.getByTestId('feedback-turning-point')).toContainText('Blind edit failed 2×');
  await expect(win.getByTestId('feedback-turning-point')).toContainText('A better sequence · proposed');
  await win.getByTestId('feedback-turning-point').locator('summary').click();
  await win.getByTestId('feedback-turning-point').screenshot({ path: path.join(ARTIFACT_DIR, 'session-turning-point-five.png') });

  // Root-cause finding: two blind edits on the plan file, with a jump into the thread
  const blindFinding = win.getByTestId('session-finding-tool-blind-edit-loop:feature.md');
  await expect(blindFinding).toContainText('Blind edit failed 2× on feature.md');
  await win.getByTestId('session-finding-jump-tool-blind-edit-loop:feature.md').click();
  const focus = win.getByTestId('session-chat-feedback-focus');
  await expect(focus).toBeVisible();
  await expect(focus).toContainText('edit_file(docs/plans/feature.md)');
  await expect(win.getByTestId('session-finding-jump-tool-blind-edit-loop:feature.md')).toContainText('Viewing');

  // One click on a verdict saves it — no separate Save step
  await win.getByTestId('feedback-verdict-needs-work').click();
  await expect(win.getByTestId('session-feedback-saved-notice')).toBeVisible();
  await win.getByTestId('feedback-tag-missed-skill').click();
  await expect(win.getByTestId('feedback-tag-missed-skill')).toHaveAttribute('aria-pressed', 'true');
  await win.getByTestId('session-feedback-add-note-btn').click();
  await win.getByTestId('session-feedback-notes').fill('Should have loaded plan-authoring and verified the markdown plan parser.');
  await win.getByTestId('session-feedback-save-btn').click();
  await expect(win.getByTestId('session-feedback-saved-notice')).toBeVisible();
  await expect(win.getByTestId('session-feedback-badge')).toBeVisible();
  await expect(win.getByTestId('session-tab-scorecard-badge')).toBeVisible();

  const stored = await win.evaluate(key => window.praxis.ai.getSessionFeedback(key), issueKey);
  expect(stored?.rubricVersion).toBe(3);
  expect(stored?.userFeedback?.verdict).toBe('needs-work');
  expect(stored?.userFeedback?.frictionTags).toContain('missed-skill');

  // The staged follow-up lists exactly what will be carried into the next turn, once each —
  // advice about the original prompt (prompt-clarity) is not carried into a follow-up
  await expect(win.getByTestId('session-feedback-staged-skill-missed-plan-authoring')).toContainText('Skill: plan-authoring');
  await win.getByTestId('finding-review-skill-missed-plan-authoring-wrong').click();
  await win.getByTestId('finding-mute-skill-missed-plan-authoring').click();
  await expect(win.getByTestId('session-feedback-staged-skill-missed-plan-authoring')).toHaveCount(0);
  await win.getByText('Muted checks · score still includes their evidence').click();
  await win.getByTestId('finding-mute-skill-missed-plan-authoring').click();
  await expect(win.getByTestId('session-feedback-staged-skill-missed-plan-authoring')).toBeVisible();

  await expect(win.getByTestId('session-feedback-staged-tool-blind-edit-loop:feature.md')).toContainText('Pin @feature.md');
  await expect(win.getByTestId('session-feedback-staged-prompt-missing-verification')).toHaveCount(0);
  const stagedLabels = await win.getByTestId('session-feedback-staged-chips').locator('button').allInnerTexts();
  expect(new Set(stagedLabels).size).toBe(stagedLabels.length);

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  await win.locator('[data-testid="session-panel-scorecard"]').evaluate(el => {
    el.scrollTop = 0;
  });
  await win.screenshot({ path: path.join(ARTIFACT_DIR, 'session-scorecard-v2-live.png') });

  await win.getByTestId('session-feedback-apply-followup-btn').click();
  const followUpInput = win.getByTestId('session-follow-up-input');
  await expect(followUpInput).toHaveValue(/^Follow up on the previous turn:\n- Read @docs\/plans\/feature\.md before editing it\./);
  await expect(followUpInput).toHaveValue(/Address my feedback: Should have loaded plan-authoring/);

  // No suggestions means silence, including context-aware follow-ups.
  await followUpInput.fill('run the e2e test again and commit all changes if it passes');
  const checkedFollowUp = await win.evaluate(key => window.praxis.ai.evaluatePrompt({
    promptText: 'run the e2e test again and commit all changes if it passes',
    toolMode: 'full', followUpOfIssueKey: key, checkClarity: true
  }), issueKey);
  expect(checkedFollowUp.clarity?.status).toBe('checked');
  const followUpRequest = mock.requests.map(request => JSON.parse(request.body))
    .flatMap(request => request.messages ?? [])
    .find(message => message.role === 'user' && message.content.includes('<<<\nrun the e2e test again and commit all changes if it passes\n>>>'));
  expect(followUpRequest.content).toContain('Added a one-line summary');
  expect(followUpRequest.content).not.toContain('Ran grep');

  await expect(win.getByTestId('session-prompt-score-wrapper')).toHaveCount(0, { timeout: 5000 });
  // A delayed verdict save from full-session scope must not overwrite a newer turn.
  delayOldSave = true;
  await win.evaluate(() => window.praxis.settings.set({ ai: { defaultModel: 'mock/delayed-save' } }));
  const beforeSave = mock.requests.length;
  await win.getByTestId('feedback-verdict-helpful').click();
  await expect.poll(() => mock!.requests.length).toBeGreaterThan(beforeSave);
  await turnScoreBtns.last().click();
  await expect(panel).toHaveAttribute('data-evaluation-scope', '1');
  await win.waitForTimeout(6500);
  await expect(panel).toHaveAttribute('data-evaluation-scope', '1');

});

test('checklist caches validated answers and falls back without a score when the provider fails', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', replyFor: clarityReply });
  app = await launchTestApp({ ai: { gatewayUrl: mock.baseUrl, defaultModel: 'mock/model' } }, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined
  });
  const win = app.window;
  const evaluate = (promptText: string, checkClarity: boolean) => win.evaluate(
    input => window.praxis.ai.evaluatePrompt(input), { promptText, toolMode: 'full' as const, checkClarity }
  );
  const before = mock.requests.length;
  const pending = await evaluate('put the thing in the box', false);
  expect(pending.clarity?.status).toBe('pending');
  expect(mock.requests.length).toBe(before);
  const first = await evaluate('put the thing in the box', true);
  expect(first.clarity?.status, JSON.stringify(first.clarity)).toBe('checked');
  expect(first.overallScore).toBe(40);
  await win.evaluate(report => window.praxis.ai.reviewFinding({ inputDigest: report.inputDigest, findingId: 'clarity-target', verdict: 'context-clear' }), first);
  const count = mock.requests.length;
  const cached = await evaluate('put the thing in the box', true);
  expect(cached.clarity?.cached).toBe(true);
  expect(cached.inputDigest).toBe(first.inputDigest);
  expect(mock.requests.length).toBe(count);
  // Persisted cache survives a real app restart.
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, { AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined });
  const restarted = await app.window.evaluate(() => window.praxis.ai.evaluatePrompt({ promptText: 'put the thing in the box', toolMode: 'full', checkClarity: true }));
  expect(restarted.clarity?.cached, JSON.stringify(restarted.clarity)).toBe(true);
  expect(restarted.clarity?.answers).toEqual(first.clarity?.answers);
  const reloadedLabels = await app.window.evaluate(digest => window.praxis.ai.getFindingFeedback(digest), first.inputDigest);
  expect(reloadedLabels.reviews[0].verdict).toBe('context-clear');
  expect(reloadedLabels.reviews[0].assessment?.checklistVersion).toBe(2);
  expect(restarted.overallScore).toBe(first.overallScore);
  mock.setMode('error');
  const input = app.window.locator('.composer-input');
  await input.fill('change an unrelated screen');
  await expect(app.window.getByTestId('session-prompt-check-status')).toContainText('Clarity unavailable', { timeout: 10000 });
  await expect(app.window.getByTestId('session-prompt-score-value')).toHaveCount(0);
  await expect(app.window.getByTestId('session-prompt-check-unavailable')).toBeVisible();
  mock.setMode('complete');
  await app.window.getByTestId('session-prompt-retry').click();
  await expect(app.window.getByTestId('session-prompt-score-value')).toBeVisible();
  await input.fill('');
  await expect(app.window.getByTestId('session-prompt-score-wrapper')).toHaveCount(0);
});


// Proven by disabling the response guard: the old question hides the new draft's score.
test('a slow check for an old draft cannot replace the latest suggestions', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', replyFor: clarityReply,
    responseDelayFor: body => body.includes('how does the sidebar work') ? 4000 : 0 });
  app = await launchTestApp({ ai: { gatewayUrl: mock.baseUrl, defaultModel: 'mock/model' } }, undefined,
    { AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined });
  const input = app.window.locator('.composer-input');
  await input.fill('how does the sidebar work?');
  await expect.poll(() => mock!.requests.length).toBeGreaterThan(0);
  await input.fill('put the thing in the box');
  await expect(app.window.getByTestId('session-prompt-score-value')).toHaveText('40');
  // Wait until the older call has completed; it is a valid no-findings answer.
  await app.window.waitForTimeout(4300);
  await expect(app.window.getByTestId('session-prompt-score-value')).toHaveText('40');
  await expect(app.window.getByTestId('prompt-phrase-target')).toHaveText('the thing');
});
