import * as path from 'node:path';
import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

/**
 * Interactive ticket review.
 *
 * "Review ticket" runs a real read-only agent session and asks what to do about
 * each finding as gadgets. The agent here is `ticketReviewAcpAgent.mjs` — a real
 * ACP subprocess with a fixed script — so the session, the gadget pipeline, the
 * answer travelling back as a follow-up turn, and the apply action reaching the
 * tracker are all the production path; only the model's words are canned.
 */

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'ticketReviewAcpAgent.mjs');
/** Mirrors `UPDATED_DESCRIPTION` in the fixture. */
const UPDATED_DESCRIPTION = 'Reviewed description.\n\n- [ ] Acceptance criterion added by the review.';

let app: TestApp | undefined;

test('ticket reviews retain project ownership and recover older records into the project sidebar', async () => {
  app = await launchTestApp({ ai: {
    activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: FIXTURE_PATH } }
  } });
  let win = app.window;
  const folderPath = path.join(app.userDataDir, 'review-project');
  fs.mkdirSync(folderPath);
  const project = await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create({
      name: 'Review ownership', key: 'REVIEW', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath,
      workflowStages: [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'done', name: 'Done', category: 'done' }
      ],
      starterTickets: [{ summary: 'Review this ticket', description: 'Original details.', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
  }, folderPath);
  const review = await win.evaluate(async project => window.praxis.ai.startTicketReview({
    issueKey: project.workItems[0].key, connectionId: `project:${project.id}`,
    provider: 'claude-code-cli'
  }), project);
  expect(review.projectId).toBe(project.id);
  expect(review.workingDirectory).toBe(folderPath);
  await expect.poll(() => win.evaluate(async key => (await window.praxis.ai.listSessions()).find(s => s.issueKey === key)?.state, review.issueKey))
    .toBe('completed');

  // Reproduce a legacy record while the isolated app is stopped, then restart.
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const sessionPath = path.join(reuse.userDataDir, 'ai-sessions.json');
  const legacy = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  delete legacy['praxis.agentSessions'][review.issueKey].projectId;
  fs.writeFileSync(sessionPath, JSON.stringify(legacy));
  app = await launchTestApp(undefined, reuse);
  win = app.window;
  const row = win.getByTestId('project-session-nav-item').filter({ hasText: 'Review this ticket' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(win.getByTestId('session-console-title')).toContainText('Review');
  const recovered = await win.evaluate(async key => (await window.praxis.ai.listSessions()).find(s => s.issueKey === key), review.issueKey);
  expect(recovered?.projectId).toBe(project.id);
  expect(recovered?.sessionId).toBe(review.sessionId);
  expect(recovered?.workingDirectory).toBe(review.workingDirectory);
  const stored = JSON.parse(fs.readFileSync(path.join(app.userDataDir, 'ai-sessions.json'), 'utf8'));
  expect(stored['praxis.agentSessions'][review.issueKey].projectId).toBe(project.id);
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/ticket-review-project-ownership.png') });
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/** Boots on a Claude Code CLI provider backed by the fixture and opens the first demo ticket's review page. */
async function openReview(env: Record<string, string> = {}): Promise<{ win: TestApp['window']; issueKey: string }> {
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    FROSTY_VERCEL_API_KEY: undefined,
    ...env
  });
  const win = app.window;
  await win.evaluate(
    async ({ cliPath }) => {
      await window.praxis.settings.set({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath } } } });
    },
    { cliPath: FIXTURE_PATH }
  );
  await win.reload();
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('[data-testid="board-nav-item"]').first().click();
  const card = win.locator('[data-testid="issue-card"]').first();
  const issueKey = (await card.getAttribute('data-issue-key')) ?? '';
  await card.click();
  await win.locator('[data-testid="issue-ai-section"]').waitFor();
  await chooseOption(win.locator('[data-testid="issue-detail-ai-provider"]'), 'claude-code-cli');

  await win.locator('[data-testid="issue-ai-review-btn"]').click();
  await win.locator('[data-testid="ai-review-page"]').waitFor();
  await win.locator('[data-testid="ai-review-run"]').click();
  return { win, issueKey };
}

async function ticketDescription(win: TestApp['window'], issueKey: string): Promise<string> {
  return win.evaluate(async key => (await window.praxis.issue.get(key)).description ?? '', issueKey);
}

test('a review offers its findings as choices, and applying the chosen update writes the ticket', async () => {
  const { win, issueKey } = await openReview();
  expect(issueKey).not.toBe('');
  const originalDescription = await ticketDescription(win, issueKey);
  expect(originalDescription).not.toBe(UPDATED_DESCRIPTION);

  // The verdict is prose; the findings are a decision the user makes.
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText('Verdict: Needs work', { timeout: 20000 });
  // The verdict mentions "rate limits" and "quota". A review that merely discusses
  // limits is not a provider failure: the session completes, there is no error
  // banner, and the findings render as controls rather than raw JSON.
  await expect(win.locator('[data-testid="ai-review-error"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="ai-review-thread"]')).not.toContainText('praxis-gadget');
  const findings = win.locator('[data-testid="gadget-choice"]');
  await expect(findings).toContainText('Which of these should go into the ticket?');
  await expect(findings.locator('input[type="checkbox"]')).toHaveCount(3);
  await win.screenshot({ path: 'output/playwright/ticket-review-findings.png', fullPage: true });

  // Nothing is offered until something is chosen.
  await expect(findings.locator('[data-testid="gadget-action-apply-selected"]')).toBeDisabled();
  await findings.getByText('Add acceptance criterion: empty state').click();
  await findings.getByText('Clarify scope: export formats').click();
  await findings.locator('[data-testid="gadget-action-apply-selected"]').click();

  // The answer travels back to the agent as a turn of the same session, and the
  // agent replies with the update to review — editable, not yet applied.
  await expect(win.locator('[data-testid="ai-review-you"]')).toContainText('Add acceptance criterion: empty state, Clarify scope: export formats');
  const form = win.locator('[data-testid="gadget-form"]');
  await expect(form).toContainText('Review the ticket update', { timeout: 20000 });
  const description = form.getByLabel('Description');
  await expect(description).toHaveValue(UPDATED_DESCRIPTION);
  await win.screenshot({ path: 'output/playwright/ticket-review-apply.png', fullPage: true });
  expect(await ticketDescription(win, issueKey)).toBe(originalDescription);

  await form.locator('[data-testid="gadget-action-apply"]').click();
  await expect(form.locator('[data-testid="gadget-result"]')).toContainText(`Applied to ${issueKey}`);
  await win.screenshot({ path: 'output/playwright/ticket-review-applied.png', fullPage: true });

  // The write went through the tracker service: description and comment.
  expect(await ticketDescription(win, issueKey)).toBe(UPDATED_DESCRIPTION);
  const comments = await win.evaluate(async key => (await window.praxis.issue.get(key)).comments?.map(comment => comment.body) ?? [], issueKey);
  expect(comments).toContain('Posted by the review.');

  // The open detail pane refetched: it must not keep showing (and let a later Save
  // overwrite from) the description the review just replaced.
  await expect(win.locator('.detail-inline-description').first()).toContainText('Reviewed description.');

  // The review lives in its own session; the ticket's own key was never taken.
  const reviews = await win.evaluate(async () => (await window.praxis.ai.listSessions()).filter(session => session.issueKey.startsWith('review~')).map(session => ({ key: session.issueKey, state: session.state })));
  expect(reviews).toEqual([{ key: `review~${issueKey}`, state: 'completed' }]);
  const sessions = await win.evaluate(async () => (await window.praxis.ai.listSessions()).map(session => session.issueKey));
  expect(sessions).toContain(`review~${issueKey}`);
  expect(sessions).not.toContain(issueKey);
});

test('applying is refused when the ticket was edited after the review started', async () => {
  const { win, issueKey } = await openReview();

  const findings = win.locator('[data-testid="gadget-choice"]');
  await expect(findings).toBeVisible({ timeout: 20000 });
  await findings.getByText('Rewrite the summary').click();
  await findings.locator('[data-testid="gadget-action-apply-selected"]').click();
  const form = win.locator('[data-testid="gadget-form"]');
  await expect(form).toContainText('Review the ticket update', { timeout: 20000 });

  // Someone else edits the ticket while the review is open.
  await win.evaluate(async key => {
    await window.praxis.issue.update(key, { description: 'Edited by someone else.' });
  }, issueKey);

  await form.locator('[data-testid="gadget-action-apply"]').click();
  await expect(form.locator('[data-testid="gadget-error"]')).toContainText('was edited after this review started');
  // Their edit survives; the stale rewrite was not applied over it.
  expect(await ticketDescription(win, issueKey)).toBe('Edited by someone else.');
});

test('a follow-up is an ordinary turn of the review session, and the review can be posted as a comment', async () => {
  const { win, issueKey } = await openReview();
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText('Verdict: Needs work', { timeout: 20000 });

  // The box is the Sessions console's own composer card, not a lookalike.
  await expect(win.locator('[data-testid="ai-review-followup-composer"]')).toHaveClass(/\bcomposer\b.*\bsession-follow-up-composer\b/);
  await expect(win.locator('[data-testid="ai-review-followup"]')).toHaveClass(/\bcomposer-input\b.*\bsession-follow-up-input\b/);
  const box = win.locator('[data-testid="ai-review-followup"]');
  await expect(win.locator('[data-testid="ai-review-followup-send"]')).toBeDisabled();
  // Enter sends, as in Sessions; Shift+Enter would add a line instead.
  await box.fill('FOLLOW_UP_NOTE please reconsider');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(win.locator('[data-testid="ai-review-message"]').last()).toContainText('Understood', { timeout: 20000 });

  // "Post as comment" posts the review's own text, marked so it is recognised later.
  await win.locator('[data-testid="ai-review-post-comment"]').click();
  await expect(win.locator('[data-testid="ai-review-post-comment"]')).toHaveText('Attached to ticket');
  const comments = await win.evaluate(async key => (await window.praxis.issue.get(key)).comments?.map(comment => comment.body) ?? [], issueKey);
  expect(comments.some(body => body.startsWith('<!-- praxis-ai-review:v1 -->') && body.includes('Verdict: Needs work'))).toBe(true);

  // Re-running replaces the review: the earlier gadgets are gone, not left answerable.
  await win.locator('[data-testid="ai-review-run"]').click();
  await expect(win.locator('[data-testid="ai-review-you"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="gadget-choice"]')).toHaveCount(1, { timeout: 20000 });
});

test('a sloppily formatted gadget — glued fence, unescaped quote, over-long text — still renders as a gadget', async () => {
  const { win } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'sloppy' });

  // The block is invalid JSON and over its field limit; the host repairs the
  // one and shortens the other, so the user gets the control, not the wreckage.
  const findings = win.locator('[data-testid="gadget-choice"]');
  await expect(findings).toContainText('Which of these should go into the ticket?', { timeout: 20000 });
  await expect(findings).toContainText('Restore missing sections');
  await expect(findings).toContainText('"System One LLM wrapper"');
  await expect(win.locator('[data-testid="ai-review-thread"]')).not.toContainText('praxis-gadget');
  await expect(win.locator('[data-testid="ai-review-error"]')).toHaveCount(0);
  // The sentence the fence was glued to is still shown, and nothing was re-asked.
  await expect(win.locator('[data-testid="ai-review-content"]')).toContainText('Here is the one actionable finding.');
  await expect(win.locator('[data-testid="ai-review-you"]')).toHaveCount(0);

  // And it is a working decision.
  await findings.getByText('Restore missing sections').click();
  await findings.locator('[data-testid="gadget-action-apply-selected"]').click();
  await expect(win.locator('[data-testid="gadget-form"]')).toContainText('Review the ticket update', { timeout: 20000 });
});

test('a gadget that cannot be repaired is asked for again, and the second attempt renders', async () => {
  const { win } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'broken' });

  // The first reply is truncated JSON; the page asks the agent to send it again.
  const findings = win.locator('[data-testid="gadget-choice"]');
  await expect(findings).toContainText('Which of these should go into the ticket?', { timeout: 30000 });
  await expect(findings.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(win.locator('[data-testid="ai-review-you"]')).toHaveCount(1);
  await expect(win.locator('[data-testid="ai-review-you"]')).toContainText('could not be displayed');
});

test('an agent that never fixes its gadget is asked at most twice, not forever', async () => {
  const { win } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'stubborn' });

  await expect(win.locator('[data-testid="ai-review-you"]')).toHaveCount(2, { timeout: 40000 });
  // Give a third request every chance to appear; the cap must hold.
  await win.waitForTimeout(4000);
  await expect(win.locator('[data-testid="ai-review-you"]')).toHaveCount(2);
  await expect(win.locator('[data-testid="gadget-choice"]')).toHaveCount(0);
});

// These interactions fail against the former lightweight review composer:
// it had no Ask action, queue editing, or image clipboard/drop handling.
const COMPOSER_ARTIFACTS = path.resolve(__dirname, '../../../../.praxis/session-artifacts');

async function composerScreenshot(win: TestApp['window'], name: string): Promise<void> {
  fs.mkdirSync(COMPOSER_ARTIFACTS, { recursive: true });
  if (name === 'running') {
    await expect.poll(async () => (await win.getByTestId('ai-review-followup').boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
  }
  await win.screenshot({ path: path.join(COMPOSER_ARTIFACTS, `shared-session-composer-${name}.png`), fullPage: true });
}

test('the review composer can queue, edit and cancel a follow-up while the reviewer is working', async () => {
  const { win } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'hang' });
  const box = win.getByTestId('ai-review-followup');
  await expect(win.getByTestId('session-composer-ask-btn')).toBeVisible({ timeout: 20000 });
  await expect(win.getByTestId('ai-review-activity')).toBeVisible();
  await win.getByTestId('session-composer-ask-btn').click();
  await expect(box).toBeEnabled();
  await box.fill('FOLLOW_UP_NOTE original queued question');
  await win.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  const queued = win.getByTestId('session-queued-pill');
  await expect(queued).toContainText('original queued');
  await queued.locator('.session-runtime-chip-label').click();
  await expect(box).toHaveValue('FOLLOW_UP_NOTE original queued question');
  await expect(queued).toHaveCount(0);
  await box.fill('FOLLOW_UP_NOTE edited question');
  await win.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect(queued).toContainText('edited question');
  await composerScreenshot(win, 'running');
  await win.getByRole('button', { name: 'Cancel queued message', exact: true }).click();
  await expect(queued).toHaveCount(0);
  await expect(win.getByTestId('ai-review-you')).toHaveCount(0);
  await win.getByRole('button', { name: 'Cancel response', exact: true }).click();
  await expect(win.getByRole('button', { name: 'Cancel response', exact: true })).toHaveCount(0, { timeout: 20000 });
  await expect(win.getByTestId('ai-review-run')).toHaveText(/Run review again/);
  await expect(win.getByTestId('ai-review-you')).toHaveCount(0);
});

test('a queued review follow-up is sent exactly once when the current turn completes', async () => {
  const { win, issueKey } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'slow' });
  await win.getByTestId('session-composer-ask-btn').click();
  const message = 'FOLLOW_UP_NOTE automatically delivered queue';
  await win.getByTestId('ai-review-followup').fill(message);
  await win.getByRole('button', { name: 'Queue follow-up', exact: true }).click();
  await expect(win.getByTestId('session-queued-pill')).toBeVisible();
  await expect(win.getByTestId('ai-review-message').last()).toContainText('Understood', { timeout: 20000 });
  await expect(win.getByTestId('session-queued-pill')).toHaveCount(0);
  await expect(win.getByTestId('ai-review-you')).toHaveCount(1);
  await expect.poll(() => win.evaluate(async ({ issueKey, message }) => {
    const records = await window.praxis.ai.listSessions();
    return records.find(record => record.issueKey === `review~${issueKey}`)?.events.filter(turn => turn.type === 'user_input_completed' && turn.detail === message).length;
  }, { issueKey, message })).toBe(1);
});

test('the review composer pastes and drops images, removes one and sends the retained image to the agent', async () => {
  const { win, issueKey } = await openReview();
  await expect(win.getByTestId('ai-review-content')).toContainText('Verdict: Needs work', { timeout: 20000 });
  const input = win.getByTestId('ai-review-followup');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  await input.evaluate((node, encoded) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'paste.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, png);
  await expect(win.getByTestId('session-image-chip')).toHaveCount(1);
  await win.getByTestId('ai-review-followup-composer').evaluate((node, encoded) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], 'drop.png', { type: 'image/png' }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, png);
  await expect(win.getByTestId('session-image-chip')).toHaveCount(2);
  await win.getByRole('button', { name: 'Remove image 1', exact: true }).click();
  await expect(win.getByTestId('session-image-chip')).toHaveCount(1);
  await input.fill('FOLLOW_UP_NOTE inspect the retained screenshot');
  await composerScreenshot(win, 'ready');
  await input.press('Enter');
  await expect(win.getByTestId('ai-review-message').last()).toContainText('Images received: 1', { timeout: 20000 });
  await expect(win.getByTestId('session-image-chip')).toHaveCount(0);
  const retained = await win.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(record => record.issueKey === `review~${key}`);
    return session?.events.filter(event => event.type === 'user_input_completed').at(-1)?.attachments;
  }, issueKey);
  expect(retained).toHaveLength(1);
  expect(retained?.[0].mimeType).toBe('image/png');
});

test('review exposes shared runtime controls while preserving its review boundaries', async () => {
  const { win, issueKey } = await openReview();
  await expect(win.getByTestId('ai-review-content')).toContainText('Verdict: Needs work', { timeout: 20000 });
  const composer = win.getByTestId('ai-review-followup-composer');
  await expect(composer.getByTestId('session-provider')).toContainText('Claude');
  await composer.getByTestId('session-provider').click();
  await expect(win.locator('[data-testid^="session-provider-add-"]')).toHaveCount(0);
  // Close the provider menu before opening the model catalog.
  await composer.getByTestId('session-provider').click();
  await win.evaluate(() => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { defaultModel: 'sonnet' } } } }));
  await composer.getByTestId('session-model').click();
  await expect(win.getByTestId('session-model-menu')).toBeVisible();
  await expect(win.getByTestId('session-model-option-default')).toBeVisible();
  await win.getByTestId('session-model-option-default').click();
  await expect.poll(() => win.evaluate(async key => (await window.praxis.ai.listSessions()).find(record => record.issueKey === `review~${key}`)?.model, issueKey)).toBe('sonnet');
  await expect(win.getByTestId('review-runtime')).toContainText('sonnet');

  const reasoning = composer.getByTestId('session-reasoning');
  await expect(reasoning).toBeVisible();
  await reasoning.locator('input[type="range"]').focus();
  await reasoning.locator('input[type="range"]').press('End');
  await expect(reasoning).toHaveAttribute('data-value', 'high');
  await win.getByTestId('session-permission-chip').click();
  await win.getByTestId('session-permission-option-auto').click();
  await expect(win.getByTestId('session-permission-chip')).toContainText('Auto');
  await expect.poll(() => win.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(record => record.issueKey === `review~${key}`);
    return { reasoning: session?.reasoningEffort, permission: session?.permissionMode, toolMode: session?.toolMode };
  }, issueKey)).toEqual({ reasoning: 'high', permission: 'auto', toolMode: 'read-only' });

  await expect(composer.getByTestId('session-tool-mode')).toBeDisabled();
  await expect(composer.locator('[data-testid="session-working-directory"], [data-testid="session-attach-folder"]')).toBeDisabled();
  await expect(composer.locator('[data-testid^="session-switch-mode-"]')).toHaveCount(0);
  await expect(composer.getByTestId('session-workflow-chips')).toHaveCount(0);
  await expect(composer.getByTestId('session-workflow-add')).toHaveCount(0);
  await expect(win.getByTestId('session-workflow-trigger')).toHaveCount(0);
  await expect(win.getByTestId('session-chat-thread')).toHaveCount(0);
  await expect(composer.getByTestId('session-conversation-target')).toHaveCount(0);
  await expect(win.getByTestId('session-conversation-dialog')).toHaveCount(0);

  await win.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } }));
  await win.reload();
  await expect(win.locator('html')).toHaveAttribute('data-mode', 'dark');
  await win.getByTestId('board-nav-item').first().click();
  await win.locator(`[data-testid="issue-card"][data-issue-key="${issueKey}"]`).click();
  await win.getByTestId('issue-ai-review-btn').click();
  await expect(composer).toBeVisible();
  await app!.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 800));
  await expect.poll(() => composer.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return Array.from(node.querySelectorAll<HTMLElement>('button, input[type=range]')).filter(control => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
    }).length;
  })).toBe(0);
  await composerScreenshot(win, 'dark-narrow');
});


test('a pending read permission is answered directly in the review composer', async () => {
  const { win, issueKey } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'permission' });
  const card = win.getByTestId('session-permission-card');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('read');
  await win.getByTestId('session-permission-allow-once').click();
  await expect(win.getByTestId('ai-review-content')).toContainText('Verdict: Needs work', { timeout: 20000 });
  await expect(card).toHaveCount(0);
  await expect.poll(() => win.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(record => record.issueKey === `review~${key}`);
    return { toolMode: session?.toolMode, permissions: session?.events.filter(event => event.type === 'permission_completed').length };
  }, issueKey)).toEqual({ toolMode: 'read-only', permissions: 1 });
  await expect(win.getByTestId('ai-review-page')).toBeVisible();
  await expect(win.getByTestId('session-chat-thread')).toHaveCount(0);
});
