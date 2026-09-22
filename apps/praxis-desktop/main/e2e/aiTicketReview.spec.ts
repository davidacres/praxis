import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

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
  await win.locator('[data-testid="issue-detail-ai-provider"]').selectOption('claude-code-cli');

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

test('the composer shows Cancel while the reviewer is working, and cancelling ends the turn', async () => {
  const { win } = await openReview({ TICKET_REVIEW_FIXTURE_MODE: 'hang' });

  // Mid-turn the box is disabled and the send arrow is the red close-icon Cancel.
  const box = win.locator('[data-testid="ai-review-followup"]');
  await expect(box).toBeDisabled({ timeout: 20000 });
  await expect(box).toHaveAttribute('placeholder', 'The reviewer is working…');
  // Collapsed to the controls row with an activity chip, as in the console.
  await expect(win.locator('[data-testid="ai-review-activity"]')).toContainText('Reviewing');
  expect((await box.boundingBox())?.height ?? 0).toBeLessThan(4);
  await expect(win.locator('[data-testid="ai-review-followup-send"]')).toHaveCount(0);
  await win.screenshot({ path: 'output/playwright/ticket-review-working.png', fullPage: true });

  await win.locator('[data-testid="ai-review-followup-cancel"]').click();
  await expect(win.locator('[data-testid="ai-review-followup-cancel"]')).toHaveCount(0, { timeout: 20000 });
  await expect(win.locator('[data-testid="ai-review-run"]')).toHaveText(/Run review again/);
});
