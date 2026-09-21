import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Model tiers for workflow stages, the authoring-time suggestion, and grouping a run's stage sessions.
 *
 * - A stage names a tier; Settings maps each tier to a model per provider; the stage's session is
 *   launched on the mapped model (the in-process mock gateway records what it was asked for).
 * - "Suggest model tiers" asks the AI once for the whole workflow and only fills the draft.
 * - Two or more stage sessions of one run with no controller gather under one run header.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/** The gateway records raw bodies; the model a request asked for. */
function modelOf(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { model?: string }).model;
  } catch {
    return undefined;
  }
}

const TIERS = { fast: 'tier/fast-model', standard: 'tier/standard-model', strong: 'tier/strong-model' };

function profileWithAgent(): { userDataDir: string; settingsPath: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-tier-'));
  tempDirs.push(userDataDir);
  const agentDir = path.join(userDataDir, 'agents', 'wf-reviewer');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id: 'wf-reviewer', name: 'Workflow Reviewer', type: 'gateway', entry: 'noop' })
  );
  return { userDataDir, settingsPath: path.join(userDataDir, 'test-settings.json') };
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-tier-repo-'));
  tempDirs.push(root);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  // A run's worktree lives here; without this a second run sees it as an uncommitted file.
  fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

async function launch(reply: string): Promise<{ page: Page; projectId: string; workflowId: string }> {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply,
    models: [...Object.values(TIERS), 'tier/other-model'].map(id => ({ id }))
  });
  const repo = createRepository();
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', gatewayUrl: mock.baseUrl, workingDirectory: repo, modelTiers: { 'vercel-gateway': TIERS } } },
    profileWithAgent(),
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;
  const seeded = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Tier Delivery',
        key: 'TIR',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    await window.praxis.agentRuntime.refresh();
    const now = new Date().toISOString();
    const workflowId = `tier-${project.id}`;
    const agent = (id: string, name: string, extra: Record<string, unknown>, x: number, inputs: string[] = []) => ({
      type: 'agent-task', id, name, x, y: 0, inputs,
      agent: { agentId: 'wf-reviewer', scope: 'global', toolMode: 'read-only' },
      instructions: `Do the ${name} work.`,
      outputs: [{ id: `${id}-report`, kind: 'report', required: true }],
      mutatesWorktree: false,
      ...extra
    });
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: 'Tiered review', scope: 'project', projectId: project.id,
      version: 1, entryNodeId: 'first', createdAt: now, updatedAt: now,
      nodes: [
        agent('first', 'First look', { modelTier: 'fast' }, 0),
        agent('second', 'Second look', { modelTier: 'strong' }, 240, ['first-report']),
        { type: 'approval', id: 'approve', name: 'Approve', x: 480, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'first', to: 'second', on: 'success', required: true },
        { id: 'e2', from: 'second', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    return { projectId: project.id, workflowId };
  }, repo);
  return { page, ...seeded };
}

test('a stage runs on the model its tier maps to, and its report reaches the next stage', async () => {
  const { page, projectId, workflowId } = await launch('First look found no problems: the change is correct.');
  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Tiered'),
    { projectId, workflowId }
  );
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.status), run.runId), { timeout: 60000 })
    .toBe('awaiting-approval');

  // Two agent stages ran; each asked the gateway for its own tier's model.
  const models = mock!.requests
    .map(request => modelOf(request.body))
    .filter((model): model is string => typeof model === 'string' && model.startsWith('tier/'));
  expect(models).toContain(TIERS.fast);
  expect(models).toContain(TIERS.strong);
  expect(models.indexOf(TIERS.fast)).toBeLessThan(models.indexOf(TIERS.strong));

  // The second stage was handed the first stage's report inline instead of being left to find it.
  const secondPrompts = mock!.requests
    .filter(request => modelOf(request.body) === TIERS.strong)
    .map(request => request.body);
  expect(secondPrompts.some(body => body.includes('Reports from earlier stages') && body.includes('the change is correct'))).toBe(true);
});

test('two stage sessions of one run with no controller gather under one run header', async () => {
  const { page, projectId, workflowId } = await launch('Looks fine.');
  const run = await page.evaluate(
    async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, 'Grouped'),
    { projectId, workflowId }
  );
  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.status), run.runId), { timeout: 60000 })
    .toBe('awaiting-approval');

  await page.evaluate(
    ids => localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: ids.projectId, feature: 'workflows' })
    ),
    { projectId }
  );
  await page.reload();
  await page.getByTestId('nav-sessions').click();

  const group = page.getByTestId('session-run-group');
  await expect(group).toHaveCount(1);
  await expect(group).toContainText('Tiered review');
  const rows = page.getByTestId('session-list-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveClass(/session-nav-row--child/);

  await page.screenshot({
    path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'sessions-run-group.png'),
    fullPage: true
  });

  await page.getByTestId('session-run-toggle').click();
  await expect(rows).toHaveCount(0);
  await expect(group).toBeVisible();
});

test('Suggest model tiers fills only unset stages of the draft, and settings maps each tier', async () => {
  const reply = '```json\n' + JSON.stringify({ stages: { first: { tier: 'standard', rationale: 'routine' }, second: { tier: 'fast', rationale: 'x' } } }) + '\n```';
  const { page, projectId, workflowId } = await launch(reply);

  // The suggestion is one call over the whole workflow and does not save anything.
  const suggestion = await page.evaluate(async ids => {
    const definition = await window.praxis.workflows.get(ids.projectId, ids.workflowId);
    return window.praxis.workflows.recommendModelTiers(ids.projectId, definition!);
  }, { projectId, workflowId });
  expect(suggestion.stages.first).toMatchObject({ tier: 'standard', defaulted: false });
  expect(suggestion.stages.second).toMatchObject({ tier: 'fast', defaulted: false });
  const stored = await page.evaluate(ids => window.praxis.workflows.get(ids.projectId, ids.workflowId), { projectId, workflowId });
  expect((stored!.nodes.find(node => node.id === 'first') as { modelTier?: string }).modelTier).toBe('fast');

  // The tier mapping is persisted and shown in Settings → AI → Defaults.
  const settings = await page.evaluate(() => window.praxis.settings.get());
  expect(settings.ai.modelTiers?.['vercel-gateway']).toEqual(TIERS);
});

test('a provider row maps tiers by picking its models, and the designer sets a stage tier that survives a save', async () => {
  const { page, projectId, workflowId } = await launch('ok');
  const shot = (name: string) => path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', name);

  // Settings → AI Provider → Providers: the mapping lives in the provider's own row and is a pick from
  // that provider's model list, not a free-text box.
  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-ai').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const head = dialog.getByTestId('ai-provider-row-vercel-gateway').locator('.ai-provider-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  const tiers = dialog.getByTestId('ai-model-tiers-vercel-gateway');
  await expect(tiers.getByLabel('fast tier model')).toHaveValue(TIERS.fast);
  await expect(tiers.getByLabel('strong tier model')).toHaveValue(TIERS.strong);
  // The choices are the provider's real models, plus "the run's model" and a way to type another id.
  const options = await tiers.getByLabel('standard tier model').locator('option').allTextContents();
  expect(options).toEqual(expect.arrayContaining(["The run's model", TIERS.standard, 'tier/other-model', 'Other model id…']));
  await tiers.getByLabel('standard tier model').selectOption('tier/other-model');
  await expect
    .poll(async () => (await page.evaluate(() => window.praxis.settings.get())).ai.modelTiers?.['vercel-gateway']?.standard)
    .toBe('tier/other-model');
  // Choosing "the run's model" clears the tier rather than storing an empty id.
  await tiers.getByLabel('fast tier model').selectOption('');
  await expect
    .poll(async () => (await page.evaluate(() => window.praxis.settings.get())).ai.modelTiers?.['vercel-gateway']?.fast)
    .toBeUndefined();
  // A model outside the list can still be typed.
  await tiers.getByLabel('strong tier model').selectOption('__custom__');
  await tiers.getByLabel('strong tier model').fill('vendor/not-listed');
  await expect
    .poll(async () => (await page.evaluate(() => window.praxis.settings.get())).ai.modelTiers?.['vercel-gateway']?.strong)
    .toBe('vendor/not-listed');
  await page.screenshot({ path: shot('settings-model-tiers.png') });

  // The same mapping can be set from the model side: Manage models shows each model's tier and sets it.
  await dialog.getByTestId('ai-manage-models-btn').click();
  await expect(dialog.getByTestId(`model-manager-tier-${TIERS.standard}`)).toHaveValue('');
  await expect(dialog.getByTestId('model-manager-tier-tier/other-model')).toHaveValue('standard');
  // Giving another model the Standard tier takes it from the one that held it.
  await dialog.getByTestId(`model-manager-tier-${TIERS.standard}`).selectOption('standard');
  await expect(dialog.getByTestId('model-manager-tier-tier/other-model')).toHaveValue('');
  await expect
    .poll(async () => (await page.evaluate(() => window.praxis.settings.get())).ai.modelTiers?.['vercel-gateway']?.standard)
    .toBe(TIERS.standard);
  await page.screenshot({ path: shot('model-manager-tiers.png') });
  await dialog.getByTestId('model-manager-back').click();
  await expect(dialog.getByTestId('ai-model-tier-vercel-gateway-standard')).toHaveValue(TIERS.standard);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The designer: pick a stage, change its tier, save, reload, and it is still there.
  await page.evaluate(
    ids => localStorage.setItem(
      `praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`,
      JSON.stringify({ projectId: ids.projectId, feature: 'workflows' })
    ),
    { projectId }
  );
  await page.reload();
  await page.getByRole('button', { name: 'Tiered review' }).first().click();
  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await canvas.getByRole('button', { name: /^First look \(agent-task\)/ }).click();
  const select = page.getByTestId('wf-node-model-tier');
  await expect(select).toHaveValue('fast');
  await expect(page.getByTestId('wf-node-escalate')).toBeChecked();
  await select.selectOption('standard');
  await page.getByTestId('wf-node-escalate').uncheck();
  await page.screenshot({ path: shot('designer-model-tier.png') });
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  const stored = await page.evaluate(ids => window.praxis.workflows.get(ids.projectId, ids.workflowId), { projectId, workflowId });
  expect(stored!.nodes.find(node => node.id === 'first')).toMatchObject({ modelTier: 'standard', escalateOnRetry: false });

  // Clearing the tier ("run's model") removes it rather than storing an empty value.
  await select.selectOption('');
  await expect(page.getByTestId('wf-node-escalate')).toHaveCount(0);
});

test('a run header in Sessions archives or deletes all of its stage sessions, and leaves the run itself alone', async () => {
  const { page, projectId, workflowId } = await launch('Looks fine.');
  const stageSessions = (runId: string) =>
    page.evaluate(async id => (await window.praxis.ai.listSessions()).filter(s => s.workflowRunId === id).map(s => ({ key: s.issueKey, archived: !!s.archived })), runId);
  const startAndWait = async (label: string): Promise<string> => {
    const run = await page.evaluate(
      async ids => window.praxis.workflows.startRun(ids.projectId, ids.workflowId, ids.label),
      { projectId, workflowId, label }
    );
    await expect
      .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.status), run.runId), { timeout: 60000 })
      .toBe('awaiting-approval');
    return run.runId;
  };
  const openSessions = async () => {
    await page.reload();
    await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
    await page.getByTestId('nav-sessions').click();
  };

  // Archive: the header has the same buttons a session row has, and takes both stage sessions with it.
  const archivedRun = await startAndWait('To archive');
  expect((await stageSessions(archivedRun)).length).toBe(2);
  await openSessions();
  const group = page.getByTestId('session-run-group');
  await expect(group).toHaveCount(1);
  await expect(group.getByTestId('session-run-archive-btn')).toBeVisible();
  await expect(group.getByTestId('session-run-delete-btn')).toBeVisible();
  // Like a session row's, the header's buttons stay inside the row even with the sidebar this narrow.
  const inside = await group.evaluate(row => {
    const box = row.getBoundingClientRect();
    return [...row.querySelectorAll('button')].every(button => button.getBoundingClientRect().right <= box.right + 0.5);
  });
  expect(inside).toBe(true);
  await group.getByTestId('session-run-archive-btn').click();
  await expect.poll(async () => (await stageSessions(archivedRun)).every(s => s.archived)).toBe(true);
  await expect(page.getByTestId('session-run-group')).toHaveCount(0);
  await expect(page.getByTestId('session-list-row')).toHaveCount(0);

  // Delete: asks first (naming the count), then removes every stage session — but not the run.
  const deletedRun = await startAndWait('To delete');
  await openSessions();
  await expect(page.getByTestId('session-run-group')).toHaveCount(1);
  await page.getByTestId('session-run-delete-btn').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('all 2 sessions');
  await expect(dialog).toContainText('The run itself stays');
  // Cancelling changes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await stageSessions(deletedRun)).length).toBe(2);
  await page.getByTestId('session-run-delete-btn').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete sessions' }).click();
  await expect.poll(async () => (await stageSessions(deletedRun)).length).toBe(0);
  await expect(page.getByTestId('session-run-group')).toHaveCount(0);
  const runStillThere = await page.evaluate(id => window.praxis.workflows.getRun(id).then(r => r?.runId), deletedRun);
  expect(runStillThere).toBe(deletedRun);
});
