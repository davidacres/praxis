import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

/**
 * Opt-in capture of the README screenshots: sessions, focus mode and scheduled runs. Writes PNGs to PRAXIS_SHOTS_OUT (default `.praxis/session-artifacts/readme-shots`);
 * asserts almost nothing. Run with PRAXIS_SHOTS=1.
 */
test.slow();
test.skip(!process.env.PRAXIS_SHOTS, 'screenshots are opt-in: set PRAXIS_SHOTS=1');

const out = process.env.PRAXIS_SHOTS_OUT ?? path.resolve(__dirname, '../../../.praxis/session-artifacts/readme-shots');
const SIZE = { width: 1600, height: 1000 };

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let oai: MockOpenAiCompatibleServer | undefined;
const tempDirs: string[] = [];

test.beforeAll(() => fs.mkdirSync(out, { recursive: true }));
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  if (oai) await oai.close();
  oai = undefined;
  app = undefined;
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const REPLY = `I traced the flaky pager to the page-size reset, and fixed it.

**What was wrong**

- \`SessionList\` rebuilt its cursor whenever the filter changed, so page 2 silently turned into page 1.
- The cursor was never cleared when a session was archived, which left a dangling "next" link.

**What I changed**

\`\`\`ts
// usePager.ts
const [cursor, setCursor] = useState<string | null>(null);
useEffect(() => setCursor(null), [filter.key]); // reset only when the filter really changes
\`\`\`

| File | Change |
| --- | --- |
| \`usePager.ts\` | Keyed the cursor reset on the filter |
| \`SessionList.tsx\` | Drops the cursor on archive |
| \`pager.spec.ts\` | Two regression tests |

All 14 pager tests pass. Review the diff beside this chat, then commit or discard it.`;

async function dark(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.setViewportSize(SIZE);
  await page.evaluate(appearance => window.praxis.settings.set({ appearance: { themeId: 'simple', themeMode: 'dark', accentColor: '#3a88fe', surfacePackId: 'flat', displayMode: 'large', ...appearance } } as never), extra);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
}

async function seedSessions(): Promise<{ userDataDir: string; keys: string[] }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-readme-'));
  tempDirs.push(userDataDir);
  const now = Date.now();
  const rows = [
    { title: 'Fix the flaky session pager', state: 'completed', minutesAgo: 6, provider: 'claude-code',
      changeSummary: { files: [{ path: 'src/usePager.ts', added: 12, removed: 4 }, { path: 'src/SessionList.tsx', added: 6, removed: 1 }, { path: 'src/pager.spec.ts', added: 38, removed: 0 }], added: 56, removed: 5 } },
    { title: 'Re-run the UI gate', state: 'executing', minutesAgo: 2, provider: 'codex',
      events: [{ type: 'tool_start', summary: 'Running tool', data: { argsSummary: 'npx playwright test themes.spec.ts' } }],
      taskList: [{ content: 'Build the renderer', status: 'completed', priority: 'high' }, { content: 'Run themes.spec.ts', status: 'in_progress', priority: 'high' }, { content: 'Report the diff', status: 'pending', priority: 'low' }] },
    { title: 'Tidy the shelf CSS', state: 'awaiting_approval', minutesAgo: 9, provider: 'claude-code',
      events: [{ type: 'permission_requested', summary: 'Run npm run build:renderer', detail: 'in apps/praxis-desktop' }] },
    { title: 'Explain the notes store', state: 'awaiting_input', minutesAgo: 25, provider: 'github-copilot',
      events: [{ type: 'message', summary: 'Share the same draft, or keep its own?' }] },
    { title: 'Add export CSV to usage panel', state: 'completed', minutesAgo: 80, provider: 'claude-code',
      changeSummary: { files: [{ path: 'src/usagePanel.tsx', added: 31, removed: 6 }], added: 31, removed: 6 } },
    { title: 'API migration', state: 'failed', minutesAgo: 60 * 26, provider: 'codex', events: [{ type: 'error', summary: 'Codex exited: rate limit reached' }] },
    { title: 'Theme token audit', state: 'completed', minutesAgo: 60 * 50, provider: 'gemini-cli' }
  ];
  const records = rows.map((row, index) => {
    const at = new Date(now - row.minutesAgo * 60_000).toISOString();
    const { events = [], ...rest } = row as { events?: object[] } & Record<string, unknown>;
    return {
      issueKey: `SESSION-rm${index}`, sessionId: `rm-${index}`, state: row.state, startedAt: at, lastActivityAt: at, model: ({ 'claude-code': 'claude-sonnet-4.6', codex: 'gpt-5.5', 'github-copilot': 'gpt-5.5', 'gemini-cli': 'gemini-3-pro' } as Record<string, string>)[row.provider as string] ?? 'claude-sonnet-4.6', stepCount: 1,
      taskDefinition: { goal: row.title }, events: events.map(event => ({ timestamp: at, ...event })), ...rest
    } as Record<string, unknown>;
  });
  const stored = Object.fromEntries(records.map(record => [record.issueKey, { ...record, state: record.state === 'failed' ? 'failed' : 'completed', completedAt: record.startedAt }]));
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': stored }));
  (seedSessions as unknown as { records: Record<string, unknown>[] }).records = records;
  return { userDataDir, keys: records.map(r => r.issueKey as string) };
}

test('sessions and focus mode', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: REPLY });
  const { userDataDir } = await seedSessions();
  app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, {
    AI_GATEWAY_API_KEY: 'readme-shots-key', AI_GATEWAY_URL: mock.baseUrl
  }, { openNewSession: false });
  const page = app.window;
  await dark(page);
  for (const record of (seedSessions as unknown as { records: Record<string, unknown>[] }).records) await app.emitEvent('ai:sessionChanged', record);

  // A real conversation through the mock gateway: the thread the shots lead with.
  const repo = await seedRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/usePager.ts'), "import { useEffect, useState } from 'react';\n\nexport function usePager(filter: { key: string }) {\n  const [cursor, setCursor] = useState<string | null>(null);\n  useEffect(() => setCursor(null), []);\n  return { cursor, setCursor };\n}\n");
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '-q', '-m', 'add pager'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src/usePager.ts'), "import { useEffect, useState } from 'react';\n\nexport function usePager(filter: { key: string }) {\n  const [cursor, setCursor] = useState<string | null>(null);\n  // reset only when the filter really changes\n  useEffect(() => setCursor(null), [filter.key]);\n  return { cursor, setCursor };\n}\n");
  const key = await page.evaluate(async workingDirectory => {
    const session = await window.praxis.ai.delegate({ provider: 'vercel-gateway', toolMode: 'full', workingDirectory, task: { goal: 'Why does the session list jump back to page one when I filter?' } });
    await window.praxis.ai.renameSession(session.issueKey, 'Debug the session pager');
    return session.issueKey;
  }, repo);
  await expect.poll(() => page.evaluate(k => window.praxis.ai.listSessions().then(r => r.find(s => s.issueKey === k)?.state), key), { timeout: 20000 }).toBe('completed');

  await openSession(page, 'Debug the session pager');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(out, 'session.png') });

  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.getByRole('button', { name: 'Toggle secondary sidebar' }).click();
  await expect(page.getByTestId('session-shelf').getByTestId('session-shelf-spine').first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'focus-mode.png') });
});

async function seedRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-readme-repo-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  return repo;
}

test('scheduled runs', async () => {
  const repo = await seedRepo();
  const titles = ['Fix pager bug on session list', 'Add export CSV to usage panel', 'Log retention setting', 'Workflow designer undo', 'Theme token audit', 'Settings search index'];
  oai = await startMockOpenAiCompatibleServer({ reply: () => 'ok' });
  const aiSeed = {
    ai: {
      activeProvider: 'custom:mock',
      customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: oai.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }],
      providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } }
    }
  };
  app = await launchTestApp(aiSeed as never, undefined, undefined, { openNewSession: false });
  let page = app.window;
  const projectId = await page.evaluate(async ({ repoPath, titles }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Praxis', key: 'PRX', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: titles.map(summary => ({ summary, description: '', issueType: 'Task', status: 'Backlog' })),
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'schedules' }));
    return project.id;
  }, { repoPath: repo, titles });
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await dark(page);

  await page.getByTestId('schedule-new').click();
  for (const title of titles.slice(0, 4)) await page.getByTestId('schedule-hopper-card').filter({ hasText: title }).press('Enter');
  await page.getByTestId('schedule-name').fill('Nightly API cleanup');
  await page.getByTestId('schedule-date').fill('2030-10-21');
  await page.getByTestId('schedule-time').fill('22:00');
  await expect(page.getByTestId('schedule-ready')).toBeVisible();
  await page.getByTestId('schedule-name').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'schedule-composer.png') });

  const keys = await page.getByTestId('schedule-hopper-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-issue') as string));
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.backendApp.close();
  const conn = `project:${projectId}`;
  const at = new Date().toISOString();
  const entry = (i: number, n: number, outcome?: Record<string, unknown>) => ({ id: `e-${n}-${i}`, sequence: i + 1, ticket: { connectionId: conn, issueKey: keys[i], title: titles[i] }, ...(outcome ? { outcome } : {}) });
  const run = (id: string, name: string, status: string, startMs: number, count: number, outcomes: Array<Record<string, unknown> | undefined> = []) => ({
    schemaVersion: 1, id, projectId, name, scheduledStartAt: new Date(Date.now() + startMs).toISOString(), timezone: 'Europe/London', policy: { mode: 'sequential' },
    entries: Array.from({ length: count }, (_, i) => entry(i, id.length, outcomes[i])), status, attempts: [], createdAt: at, updatedAt: at, events: []
  });
  const H = 3_600_000;
  fs.writeFileSync(path.join(reuse.userDataDir, 'scheduled-runs.json'), JSON.stringify({ 'praxis.scheduledRuns.v1': [
    run('a', 'Sprint 42 batch', 'running', -72 * 60_000, 5, [{ status: 'done' }, { status: 'done' }, { status: 'running' }, undefined, undefined]),
    run('b', 'Nightly API cleanup', 'scheduled', 11.8 * H, 3),
    run('c', 'Export spike', 'paused', -2 * H, 1, [{ status: 'paused', reason: 'Waiting at the Review gate' }]),
    run('d', 'Docs sweep', 'missed', -30 * H, 2),
    run('e', 'Release notes', 'draft', 40 * H, 4),
    run('f', 'Hotfix batch', 'completed', -50 * H, 4, [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }])
  ] }));
  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  page = app.window;
  await page.setViewportSize(SIZE);
  if (!(await page.getByTestId('schedule-sidebar').isVisible())) await page.getByTestId('titlebar-scheduled-runs').click();
  await expect(page.getByTestId('schedule-card')).toHaveCount(6, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'schedule-lineup.png') });
});
