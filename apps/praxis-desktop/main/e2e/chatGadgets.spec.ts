import { test, expect, type Locator } from '@playwright/test';
import {
  buildExpiredGadgetFixture,
  buildGadgetFailureFixtures,
  buildGadgetFenceMessage,
  buildGadgetFixtures,
  GADGET_KINDS
} from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Interactive chat gadgets (FX-BF-036), end to end.
 *
 * These drive the **real** producer path: the mock gateway returns a message
 * containing `praxis-gadget` fences, exactly as a provider would, and the app
 * parses, validates, stamps scope, renders, and records the answer through the
 * ledger. Nothing here hand-builds an envelope in the renderer, because doing
 * so would skip the two steps most likely to break — parsing and host-side
 * validation.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

/** Scope is stripped by `buildGadgetFenceMessage`; these only satisfy the builder. */
const FIXTURE_OPTIONS = {
  scope: { hostId: 'fixture-host', sessionId: 'fixture-session' },
  issuedAt: '2026-09-13T10:00:00.000Z'
};

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

/** Start a session whose single provider reply is `reply`, and open Sessions. */
async function sessionWithReply(
  reply: string,
  options: {
    toolCall?: { name: string; arguments: Record<string, unknown> };
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  } = {}
) {
  mock = await startMockGatewayServer({ mode: 'complete', reply, ...options });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gadget-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  // No `issueKey`: a free-form session, so nothing is looked up on a board.
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Demonstrate interactive chat gadgets.' }
    });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  return win;
}

test('tool activity is grouped into one completion gadget', async () => {
  const win = await sessionWithReply('The file is ready.', {
    toolCall: { name: 'list_dir', arguments: { path: '.' } }
  });

  await win.locator('[data-testid="session-tab-activity"]').click();
  const gadget = win.locator('[data-testid="tool-completion-gadget"]');
  await expect(gadget).toBeVisible();
  await expect(gadget.locator('[data-testid="tool-completion-item"]')).toHaveCount(1);
  await expect(gadget).toContainText('list_dir');
  await expect(gadget).toContainText('1 completed');
  await expect(win.locator('[data-testid="session-chat-tool"]')).toHaveCount(0);

  // The activity log no longer exposes the same invocation as separate start
  // and completion rows.
  await expect(win.locator('[data-testid="session-events"]')).not.toContainText('Running tool:');
  await expect(win.locator('[data-testid="session-events"]')).not.toContainText('Tool completed:');
  expect(mock!.requests).toHaveLength(2);
});

test('a long tool history is grouped into family summaries with one detail view', async () => {
  const win = await sessionWithReply('The directory scan is complete.', {
    toolCalls: Array.from({ length: 12 }, (_, index) => ({
      name: 'list_dir',
      arguments: { path: index % 2 === 0 ? '.' : 'renderer' }
    }))
  });

  await win.locator('[data-testid="session-tab-activity"]').click();
  const gadget = win.locator('[data-testid="tool-completion-gadget"]');
  await expect(gadget).toContainText('12 runs');
  const group = gadget.locator('[data-testid="tool-completion-group"]');
  await expect(group).toHaveCount(1);
  await expect(gadget.locator('[data-testid="tool-completion-item"]')).toHaveCount(12);
  await expect(gadget.locator('[data-testid="tool-completion-selected-detail"]')).toHaveCount(1);
  // The sole group does not restate the header's counts. With one group those
  // are the same numbers twice, which is most of the column in the inspector's
  // rail; the header keeps them because it is always visible.
  await expect(group.locator('.tool-completion-group-count')).toHaveCount(0);
  // Every invocation remains available, but the UI has only one expanded
  // detail surface instead of twelve nested disclosure panels.
  await expect(gadget.locator('details.tool-completion-item')).toHaveCount(0);
});

test('assistant Markdown renders tables and emphasis in the chat bubble', async () => {
  const win = await sessionWithReply([
    '| Story | Scope | State |',
    '|---|---|---|',
    '| FX-BE-097 | Versioned contracts, validation, fallback | To Do |',
    '| FX-BE-098 | Renderer registry; table/chart/progress/diff/handoff surfaces | To Do |',
    '| FX-BE-099 | Command ledger, scope auth, expiry/stale/dedupe | To Do |',
    '| FX-BE-100 | Workflow gates, provider handoffs, run monitor | To Do |',
    '| FX-BE-101 | A11y, mobile, fixtures, e2e proof | To Do |',
    '',
    'Plan statuses, `PLAN_MAP.md` and the roadmap reflect this honestly: 097/098/099 Done, 100/101 In progress.'
  ].join('\n'));

  const assistant = win.locator('[data-testid="session-chat-assistant"]').last();
  await expect(assistant.locator('[data-testid="session-chat-markdown"] table')).toBeVisible();
  await expect(assistant.locator('th')).toHaveCount(3);
  await expect(assistant.locator('tbody tr')).toHaveCount(5);
  await expect(assistant.locator('td').first()).toHaveText('FX-BE-097');
  await expect(assistant.locator('td').nth(1)).toContainText('Versioned contracts, validation, fallback');
  await expect(assistant).not.toContainText('|---|---|');

  // The inspector deliberately does not echo the reply — it is the session's
  // state, not a second transcript.
  await expect(win.locator('[data-testid="session-last-message"]')).toHaveCount(0);

  // The Activity log is for lifecycle/tool events, not a second plain-text
  // copy of the conversation. Message details must not leak raw Markdown here.
  // Asserted against the panel, not the event list: a session with no tool
  // runs renders an empty state instead, and `not.toContainText` against a
  // missing element fails rather than passing vacuously.
  await win.locator('[data-testid="session-tab-activity"]').click();
  const activityPanel = win.locator('[data-testid="session-panel-activity"]');
  await expect(activityPanel).not.toContainText('| Story | Scope | State |');
  await expect(activityPanel).not.toContainText('FX-BE-097 |');
});

test('chat producers receive the choice-gadget policy for genuine decisions', async () => {
  await sessionWithReply('There is no decision to make in this fixture.');

  const request = JSON.parse(mock!.requests[0]!.body) as {
    messages: Array<{ role: string; content: string }>;
  };
  const systemPrompt = request.messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n');
  expect(systemPrompt).toContain('## Interactive response surfaces');
  expect(systemPrompt).toContain('include a single explicit `praxis-gadget` choice block');
  expect(systemPrompt).toContain('Do not turn every numbered list into controls.');
  expect(systemPrompt).toContain('"kind":"choice"');
  expect(systemPrompt).toContain('The host adds scope and issuedAt.');
});

test('Settings lists each built-in gadget with its purpose', async () => {
  app = await launchTestApp(undefined, undefined, NO_GATEWAY_ENV);
  const win = app.window;

  await win.locator('[data-testid="titlebar-settings"]').click();
  await expect(win.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await win.locator('[data-testid="settings-nav-gadgets"]').click();

  const section = win.locator('[data-testid="settings-gadgets"]');
  await expect(section.locator('[data-testid^="settings-gadget-"]')).toHaveCount(12);
  await expect(section.locator('[data-testid="settings-gadget-tool-completion"]')).toContainText('Tool completion');
  await expect(section.locator('[data-testid="settings-gadget-tool-completion"]')).toContainText('one expandable activity entry');
  await expect(section.locator('[data-testid="settings-gadget-choice"]')).toContainText('clear decision');
});

test('a provider message asking for gadgets renders every kind in place', async () => {
  const message = buildGadgetFenceMessage(buildGadgetFixtures(FIXTURE_OPTIONS), 'Here is the current state of the run.');
  const win = await sessionWithReply(message);

  // The prose survives; the raw JSON does not leak into the transcript.
  const assistant = win.locator('[data-testid="session-chat-assistant"]').last();
  await expect(assistant).toContainText('Here is the current state of the run.');
  await expect(assistant).not.toContainText('praxis-gadget');
  await expect(assistant).not.toContainText('"actions"');

  for (const kind of GADGET_KINDS) {
    await expect(win.locator(`[data-testid="gadget-${kind}"]`), `${kind} did not render`).toBeVisible();
  }

  // Gadgets are attributed to Praxis, not to the model that asked for them.
  await expect(win.locator('.gadget-kicker').first()).toContainText('Praxis');

  // The rail carries the session's state, not a second copy of the reply — so
  // there is no message block here, and no fence can leak into one.
  await expect(win.locator('[data-testid="session-last-message"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-inspector"]')).not.toContainText('praxis-gadget');
  await win.screenshot({ path: 'output/playwright/chat-gadgets-catalogue.png', fullPage: true });

  // One provider turn — rendering a gadget must never cost a second request.
  expect(mock!.requests).toHaveLength(1);
});

test('answering a choice records it through the ledger and leaves it answered', async () => {
  const [choice] = buildGadgetFixtures(FIXTURE_OPTIONS);
  const win = await sessionWithReply(buildGadgetFenceMessage([choice], 'Pick a provider to carry on with.'));

  const gadget = win.locator('[data-testid="gadget-choice"]');
  await expect(gadget).toBeVisible();
  await expect(gadget).toHaveAttribute('data-gadget-state', 'active');

  // An option the host marked unavailable stays visible with its reason.
  await expect(gadget).toContainText('no CLI found on this machine');
  await expect(gadget.getByRole('radio', { name: /Copilot/ })).toBeDisabled();

  // The submit button is inert until a choice has actually been made.
  const submit = gadget.locator('[data-testid="gadget-action-pick"]');
  await expect(submit).toBeDisabled();

  await gadget.getByRole('radio', { name: /Claude/ }).check();
  await expect(submit).toBeEnabled();
  await win.screenshot({ path: 'output/playwright/chat-gadget-choice-selected.png', fullPage: true });
  await submit.click();

  await expect(gadget.locator('[data-testid="gadget-result"]')).toContainText('Recorded');
  // The host settles this action in the same turn, so it goes straight to
  // `completed` rather than resting in `submitted` — which is only reached when
  // the host has real work still to do.
  await expect(gadget).toHaveAttribute('data-gadget-state', 'completed');
  await expect(gadget.locator('[data-testid="gadget-inert-note"]')).toContainText('This decision has been made');
  await expect(submit).toBeDisabled();

  // Answering a `choice` gadget also reports the answer back to the agent as
  // a follow-up turn — the same path a typed reply takes — so the model that
  // asked actually learns what was picked. Wait for that second turn to
  // settle before asserting on request counts.
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  expect(mock!.requests).toHaveLength(2);
  const followUp = JSON.parse(mock!.requests[1]!.body) as { messages: Array<{ role: string; content: string }> };
  expect(followUp.messages.at(-1)).toMatchObject({ role: 'user' });
  expect(followUp.messages.at(-1)!.content).toContain('Claude');

  // The gadget is durable, not a transient renderer detail. Reloading the
  // selected session restores the completed choice without triggering another
  // provider request.
  await win.reload();
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="gadget-choice"]')).toHaveAttribute('data-gadget-state', 'completed');
  await expect(win.locator('[data-testid="gadget-choice"]')).toContainText('This decision has been made');
  expect(mock!.requests).toHaveLength(2);

  // The decision is in the durable ledger, with the evidence of what was asked.
  const record = await win.evaluate(async () => {
    const events = await window.praxis.gadgets.replay(0);
    return events.map(event => ({ status: event.status, gadgetId: event.gadgetId }));
  });
  expect(record).toEqual([{ status: 'accepted', gadgetId: 'fx-choice' }, { status: 'completed', gadgetId: 'fx-choice' }]);
  expect(mock!.requests).toHaveLength(2);
});

test('a second answer to the same gadget is refused, not applied twice', async () => {
  const [choice] = buildGadgetFixtures(FIXTURE_OPTIONS);
  const win = await sessionWithReply(buildGadgetFenceMessage([choice]));

  const gadget = win.locator('[data-testid="gadget-choice"]');
  await gadget.getByRole('radio', { name: /Claude/ }).check();
  await gadget.locator('[data-testid="gadget-action-pick"]').click();
  await expect(gadget).toHaveAttribute('data-gadget-state', 'completed');

  // Re-submitting the identical decision replays the recorded outcome rather
  // than running it again; a *different* answer is refused as already settled.
  const [replayed, changed] = await win.evaluate(async () => {
    const sessionId = (await window.praxis.ai.listSessions())[0].sessionId;
    const base = { sessionId, gadgetId: 'fx-choice', actionId: 'pick' } as const;
    return [
      await window.praxis.gadgets.submit({
        ...base,
        value: { kind: 'choice', selected: 'claude' },
        idempotencyKey: `${sessionId}:fx-choice:pick`
      }),
      await window.praxis.gadgets.submit({
        ...base,
        value: { kind: 'choice', selected: 'codex' },
        idempotencyKey: `${sessionId}:fx-choice:pick-2`
      })
    ];
  });

  expect(replayed.replay).toBe(true);
  expect(replayed.status).toBe('completed');
  expect(changed.status).toBe('rejected');
  expect(changed.error?.code).toBe('already-submitted');
});

test('a malformed, unknown or unsafe gadget degrades to readable text', async () => {
  const failures = buildGadgetFailureFixtures(FIXTURE_OPTIONS);
  const win = await sessionWithReply(buildGadgetFenceMessage(failures, 'Some of these are broken on purpose.'));

  const fallbacks = win.locator('[data-testid="gadget-block-fallback"]');
  await expect(fallbacks).toHaveCount(failures.length);

  // Each one says *why*, and none of them renders an interactive surface.
  await expect(fallbacks.filter({ hasText: 'not a gadget kind' })).toHaveCount(1);
  await expect(fallbacks.filter({ hasText: 'contract version' })).toHaveCount(1);
  await expect(fallbacks.filter({ hasText: 'limit is' })).toHaveCount(1);
  await expect(fallbacks.filter({ hasText: 'workflow gate' })).toHaveCount(1);
  await expect(fallbacks.filter({ hasText: 'traverse outside the workspace' })).toHaveCount(1);
  await expect(win.locator('[data-testid="gadget-choice"]')).toHaveCount(0);

  // When the producer supplied no fallback text of its own, the refusal reason
  // is the body — it must not also be repeated underneath as a detail line.
  const versionFailure = fallbacks.filter({ hasText: 'contract version' });
  await expect(versionFailure.locator('.gadget-fallback-detail')).toHaveCount(0);
  // The one fixture that *did* supply its own text keeps both: its words, and
  // the reason its surface could not be drawn.
  const unknownKind = fallbacks.filter({ hasText: 'a surface this build does not have' });
  await expect(unknownKind.locator('.gadget-fallback-detail')).toContainText('not a gadget kind');

  await win.screenshot({ path: 'output/playwright/chat-gadgets-fallbacks.png', fullPage: true });
});

test('an expired gadget says so and refuses an answer', async () => {
  const win = await sessionWithReply('Deciding.');
  const expired = buildExpiredGadgetFixture(FIXTURE_OPTIONS);

  const result = await win.evaluate(async fixture => {
    const sessionId = (await window.praxis.ai.listSessions())[0].sessionId;
    // Publish through the host so scope is real; the fixture's own expiry has
    // already passed by the time it is read back.
    await window.praxis.gadgets.publish(sessionId, [
      {
        ...fixture,
        blockId: 'msg-0-expired',
        gadget: {
          ...(fixture.gadget as Record<string, unknown>),
          scope: { hostId: 'unused', sessionId },
          issuedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 30_000).toISOString()
        }
      }
    ]);
    return window.praxis.gadgets.submit({
      sessionId,
      gadgetId: 'fx-expired',
      actionId: 'pick',
      value: { kind: 'choice', selected: 'a' },
      idempotencyKey: 'expired-attempt'
    });
  }, expired);

  expect(result.status).toBe('rejected');
  expect(result.error?.code).toBe('gadget-expired');

  const gadget = win.locator('[data-testid="gadget-choice"]');
  await expect(gadget).toHaveAttribute('data-gadget-state', 'expired');
  await expect(gadget.locator('[data-testid="gadget-inert-note"]')).toContainText('expired');
  await expect(gadget.locator('[data-testid="gadget-action-pick"]')).toBeDisabled();
});

test('an action aimed at another session is refused by scope', async () => {
  const [choice] = buildGadgetFixtures(FIXTURE_OPTIONS);
  const win = await sessionWithReply(buildGadgetFenceMessage([choice]));

  const result = await win.evaluate(async () =>
    window.praxis.gadgets.submit({
      sessionId: 'a-session-that-does-not-exist',
      gadgetId: 'fx-choice',
      actionId: 'pick',
      value: { kind: 'choice', selected: 'claude' },
      idempotencyKey: 'wrong-session'
    })
  );
  expect(result.status).toBe('rejected');
  expect(result.error?.code).toBe('scope-mismatch');
});

test('gadget surfaces are keyboard reachable and carry their semantics', async () => {
  const catalogue = buildGadgetFixtures(FIXTURE_OPTIONS);
  const win = await sessionWithReply(buildGadgetFenceMessage(catalogue));

  // Radio groups are real groups, labelled by the question they belong to.
  const choice = win.locator('[data-testid="gadget-choice"]');
  const group = choice.getByRole('radiogroup');
  await expect(group).toHaveAttribute('aria-labelledby', /fx-choice-title/);
  await expect(choice.getByRole('radio')).toHaveCount(3);

  // Keyboard: focus the first enabled option and choose it without a pointer.
  const first = choice.getByRole('radio', { name: /Claude/ });
  // `:focus-visible` only engages for a real keyboard interaction, so focus is
  // moved away and back with Tab — the same approach keyboardFocus.spec.ts uses.
  await first.focus();
  await win.keyboard.press('Tab');
  await win.keyboard.press('Shift+Tab');
  await expect(first).toBeFocused();
  // The global focus ring must actually paint — a control that shows nothing
  // when focused is invisible to anyone driving the app from the keyboard.
  const outline = await first.evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style, 'the focused option painted no ring').not.toBe('none');
  expect(outline.width).not.toBe('0px');
  await win.keyboard.press('Space');
  await expect(first).toBeChecked();

  // Progress exposes its value rather than faking one.
  const progress = win.locator('[data-testid="gadget-progress"]').getByRole('progressbar');
  await expect(progress).toHaveAttribute('aria-valuenow', '60');
  await expect(progress).toHaveAttribute('aria-label', 'Delivery run');

  // A table is a real table with scoped headers.
  const table = win.locator('[data-testid="gadget-table"] table');
  await expect(table.locator('th[scope="col"]')).toHaveCount(3);
  await expect(table.locator('tbody tr')).toHaveCount(3);

  // A chart is never only a picture — the numbers are always present too.
  const chart = win.locator('[data-testid="gadget-chart"]');
  await expect(chart.getByRole('img')).toHaveAttribute('aria-label', /trending down/);
  await expect(chart.locator('details summary')).toContainText('Chart data');

  // Form labels are associated with their controls.
  const form = win.locator('[data-testid="gadget-form"]');
  await expect(form.getByLabel('Summary')).toBeVisible();
  await expect(form.getByLabel('Contains breaking changes')).toBeVisible();

  // The approval gadget names the gate it opens rather than hiding it.
  await expect(win.locator('[data-testid="gadget-approval"]')).toContainText('deployment.staging');
});

test('a form will not submit until its required fields are filled', async () => {
  const form = buildGadgetFixtures(FIXTURE_OPTIONS).find(
    block => block.type === 'gadget' && (block.gadget as { kind: string }).kind === 'form'
  )!;
  const win = await sessionWithReply(buildGadgetFenceMessage([form]));

  const gadget: Locator = win.locator('[data-testid="gadget-form"]');
  const save = gadget.locator('[data-testid="gadget-action-save"]');
  await expect(save).toBeDisabled();
  await expect(gadget).toContainText('Still needed: Summary');

  await gadget.getByLabel('Summary').fill('Ship the gadget work');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(gadget.locator('[data-testid="gadget-result"]')).toContainText('Recorded');
});

test('a conflict gadget refuses to resolve until every side is chosen', async () => {
  const conflict = buildGadgetFixtures(FIXTURE_OPTIONS).find(
    block => block.type === 'gadget' && (block.gadget as { kind: string }).kind === 'conflict'
  )!;
  const win = await sessionWithReply(buildGadgetFenceMessage([conflict]));

  const gadget = win.locator('[data-testid="gadget-conflict"]');
  const resolve = gadget.locator('[data-testid="gadget-action-resolve"]');
  await expect(resolve).toBeDisabled();
  await expect(gadget).toContainText('2 conflicts still to resolve');

  // Praxis never preselects a side, so both have to be answered deliberately.
  await gadget.getByRole('radiogroup').first().getByRole('radio').first().check();
  await expect(resolve).toBeDisabled();
  await expect(gadget).toContainText('1 conflict still to resolve');

  await gadget.getByRole('radiogroup').nth(1).getByRole('radio').nth(1).check();
  await expect(resolve).toBeEnabled();
  await resolve.click();
  await expect(gadget.locator('[data-testid="gadget-result"]')).toContainText('Recorded');
});
