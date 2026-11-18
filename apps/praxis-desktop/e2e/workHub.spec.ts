import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { createProject, seedNotes } from './notesTestKit';
import { chooseOption } from './chipSelect';
import { openSession } from './sessionNavigation';
import { openStartRunDialog } from './navigation';

test.slow();
let app: TestApp;
let projectId: string;
const artifacts = path.resolve(__dirname, '../.praxis/session-artifacts/improvements');
const fixture = (projectId: string, state = 'completed') => ({
  issueKey: 'SESSION-hub', sessionId: 'hub', projectId, title: 'Search and review delivery', provider: 'vercel-gateway',
  state, taskDefinition: { kind: 'general', goal: 'Implement review', scope: '', definitionOfDone: '' }, stepCount: 1,
  eventsLoaded: true, startedAt: '2026-11-14T12:00:00Z',
  handoverBrief: { schemaVersion: 1, revision: 2, updatedAt: '2026-11-14T12:01:00Z', freshness: 'stale', sourceEventCount: 1,
    progress: 'Implemented the search view.', changes: 'Added search.ts', nextSteps: 'Verify keyboard navigation.', openQuestions: 'Should archived work be searchable?', risks: 'Remote board may be offline.', decisions: '', userNotes: '', touchedFiles: ['search.ts'] },
  events: [
    { type: 'user_input_completed', timestamp: '2026-11-14T12:00:00Z', summary: 'Find the launch decision', detail: 'Remember the cobalt launch decision.' },
    { type: 'tool_complete', timestamp: '2026-11-14T12:01:00Z', summary: 'npm test', data: { kind: 'shell', argsSummary: 'npm test', exitCode: 1, output: 'One keyboard test failed.' } },
    { type: 'tool_complete', timestamp: '2026-11-14T12:02:00Z', summary: 'npm run build', data: { kind: 'shell', exitCode: 0, output: 'Build completed.' } },
    { type: 'message', timestamp: '2026-11-14T12:03:00Z', summary: 'Search implemented', detail: 'The cobalt launch decision is recorded. Keyboard verification remains.' }
  ], responseText: 'The cobalt launch decision is recorded. Keyboard verification remains.'
});

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  projectId = await createProject(app.window, 'Hub Project', 'HUB');
  fs.mkdirSync(artifacts, { recursive: true });
});
test.afterEach(async () => { if (app) await closeTestApp(app); });

async function seedSession(state = 'completed') {
  const record = fixture(projectId, state);
  await app.overrideChannel('ai:listSessions', () => [record]);
  await app.overrideChannel('ai:getSession', () => record);
  await app.window.reload();
  await expect(app.window.getByTestId('titlebar-attention')).toBeVisible();
  return record;
}

test('attention shows a question and opens its session without sending a reply', async () => {
  await seedSession('awaiting_input');
  const page = app.window;
  let sends = 0;
  await app.overrideChannel('ai:continueSession', () => { sends++; });
  await page.getByTestId('titlebar-attention').click();
  const hub = page.getByRole('dialog', { name: 'Your work' });
  await expect(hub).toContainText('Search and review delivery');
  await expect(hub.getByRole('button', { name: 'Answer question' })).toBeVisible();
  await expect(hub).not.toContainText('Loading runs…');
  await page.screenshot({ path: path.join(artifacts, 'attention.png') });
  await hub.getByRole('button', { name: 'Answer question' }).click();
  await expect(hub).toHaveCount(0);
  await expect(page.getByTestId('session-chat-thread')).toBeVisible();
  expect(sends).toBe(0);
});

test('content search finds deep note and conversation passages with project filtering', async () => {
  await seedNotes(app.window, projectId, [{ title: 'Release notes', body: `${'Context. '.repeat(80)}The cobalt launch decision needs QA.` }]);
  const otherId = await createProject(app.window, 'Other Project', 'OTHER');
  await seedNotes(app.window, otherId, [{ title: 'Other release', body: 'Another cobalt launch decision.' }]);
  await seedSession();
  const page = app.window;
  await page.getByTestId('titlebar-search-work').click();
  const hub = page.getByRole('dialog', { name: 'Your work' });
  await hub.getByRole('textbox', { name: 'Search work content' }).fill('cobalt');
  await expect(hub.getByRole('button').filter({ hasText: 'Release notes' })).toBeVisible();
  await expect(hub.getByRole('button').filter({ hasText: 'Search and review delivery' })).toBeVisible();
  await chooseOption(hub.getByRole('button', { name: 'Filter by project' }), projectId);
  await expect(hub.getByRole('button').filter({ hasText: 'Other release' })).toHaveCount(0);
  await hub.getByRole('button').filter({ hasText: 'Release notes' }).click();
  await expect(hub.locator('mark')).toHaveText('cobalt');
  await page.screenshot({ path: path.join(artifacts, 'search-passage.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('titlebar-search-work')).toBeFocused();
});

test('recap separates command failure from build success and retains stale-brief warning', async () => {
  await seedSession();
  const page = app.window;
  await openSession(page, 'SESSION-hub');
  const review = page.getByTestId('session-review');
  await expect(review).not.toHaveAttribute('open', '');
  await review.locator(':scope > summary').click();
  await expect(review).toContainText('Verify keyboard navigation.');
  await expect(review).toContainText('stale');
  await expect(review).toContainText('Newer activity may not be covered.');
  const evidence = review.getByTestId('session-evidence');
  await evidence.locator(':scope > summary').click();
  await expect(evidence).toContainText('Failed (1) · npm test');
  await expect(evidence).toContainText('Succeeded (0) · npm run build');
  await evidence.locator('summary').filter({ hasText: 'Failed (1)' }).click();
  await expect(evidence).toContainText('One keyboard test failed.');
  await page.screenshot({ path: path.join(artifacts, 'session-review.png') });
});

test('partial-source failures are visible and refresh recovers the attention view', async () => {
  await seedSession();
  await app.overrideChannel('scheduledRuns:list', () => { throw new Error('offline'); });
  const page = app.window;
  await page.getByTestId('titlebar-attention').click();
  const hub = page.getByRole('dialog', { name: 'Your work' });
  await expect(hub).toContainText('This view is incomplete');
  await app.overrideChannel('scheduledRuns:list', () => []);
  await hub.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(hub).not.toContainText('This view is incomplete');
  await expect(hub).toContainText('No loaded items need your attention');
  await hub.getByRole('button', { name: 'Close your work' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(hub.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
});

test('workflow policies and delivery defaults are disclosed on demand without changing saved values', async () => {
  const page = app.window;
  await page.evaluate(async projectId => {
    await window.praxis.workflows.instantiate(projectId, 'governed-delivery');
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId, feature: 'workflows' }));
  }, projectId);
  await page.reload();
  await openStartRunDialog(page);
  const dialog = page.getByTestId('wf-runstart-dialog');
  await dialog.getByRole('tab', { name: 'AI & permissions' }).click();
  const policies = dialog.getByTestId('workflow-advanced-policies');
  await expect(policies).not.toHaveAttribute('open', '');
  await policies.locator(':scope > summary').click();
  await expect(policies.getByTestId('wf-runstart-limit-ask')).toBeVisible();
  await expect(policies.getByTestId('wf-runstart-limit-ask')).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill('delivery');
  await palette.getByRole('option').filter({ hasText: 'Delivery' }).filter({ hasText: 'Settings' }).click();
  const advanced = page.getByTestId('delivery-advanced-settings');
  await expect(advanced).not.toHaveAttribute('open', '');
  await advanced.locator(':scope > summary').click();
  await expect(page.getByRole('textbox', { name: 'Default base branch' })).toBeVisible();
});


test('a completed session with an unanswered choice stays in attention until the host resolves it', async () => {
  await seedSession();
  let active = true;
  await app.overrideChannel('gadgets:getBlocks', () => active ? [{ type: 'gadget', blockId: 'decision', gadget: { version: 1, kind: 'choice', gadgetId: 'decision', state: 'active', payload: { question: 'Which launch approach should we use?' }, actions: [{ actionId: 'pick', label: 'Continue', effect: 'informational' }] } }] : []);
  const page = app.window;
  await page.getByTestId('titlebar-attention').click();
  const hub = page.getByRole('dialog', { name: 'Your work' });
  await expect(hub).toContainText('Which launch approach should we use?');
  active = false;
  await app.emitEvent('gadgets:changed', 'hub');
  await expect(hub.getByRole('button', { name: 'Answer question' })).toHaveCount(0);
});

test('attention opens the selected missed schedule instead of an unrelated schedule', async () => {
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.backendApp.close();
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(reuse.userDataDir, 'scheduled-runs.json'), JSON.stringify({ 'praxis.scheduledRuns.v1': ['release', 'docs'].map(id => ({
    schemaVersion: 1, id, projectId, name: `${id} missed run`, scheduledStartAt: '2026-01-01T12:00:00Z', timezone: 'Europe/London',
    policy: { mode: 'sequential' }, entries: [], status: 'missed', attempts: [], createdAt: at, updatedAt: at, events: []
  })) }));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const page = app.window;
  await page.getByTestId('titlebar-attention').click();
  const hub = page.getByRole('dialog', { name: 'Your work' });
  await hub.locator('article').filter({ hasText: 'docs missed run' }).getByRole('button', { name: 'Resolve missed start' }).click();
  await expect(hub).toHaveCount(0);
  await expect(page.getByTestId('schedule-card')).toHaveCount(1);
  await expect(page.getByTestId('schedule-card')).toHaveAttribute('data-run-id', 'docs');
});

test('a long reopened conversation keeps its compact recap visible beside the transcript', async () => {
  const record = await seedSession();
  record.events[record.events.length - 1].detail = 'A long recorded implementation update.\n\n'.repeat(180);
  record.responseText = record.events[record.events.length - 1].detail!;
  await app.window.reload();
  await openSession(app.window, 'SESSION-hub');
  await expect(app.window.getByTestId('session-review')).toBeInViewport();
  await expect(app.window.getByTestId('session-follow-up-input')).toBeVisible();
});
