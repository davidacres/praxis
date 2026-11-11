import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A read-only review stage is handed the implementation's diff as a file it can read.
 *
 * A `diff` input is only a commit ref, and a read-only reviewer is told not to run shell
 * commands — so before this, it could not see the change at all and went looking for a diff
 * tool that does not exist ("linear_get_diff … unknown-tool"). Only the LLM endpoint is
 * mocked: the implement stage's change is real, frozen as a real commit, and the review stage
 * must be pointed at the whole patch since the run branched.
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

let repoUnderTest = '';
let patchDuringReview: string | undefined;

function worktreeDirs(): string[] {
  const root = path.join(repoUnderTest, '.worktrees');
  return fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name)) : [];
}

function replyFor(body: string): string | undefined {
  const text = JSON.stringify(JSON.parse(body).messages ?? []);
  if (text.includes('running the \\"Implement\\" stage')) {
    // Stand in for the agent's edits: two commits' worth, so the patch must span both.
    for (const dir of worktreeDirs()) {
      fs.writeFileSync(path.join(dir, 'src', 'pager.ts'), 'export const first = 0;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'agent: fix pager'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'src', 'extra.ts'), 'export const extra = true;\n');
    }
    return 'Fixed the pager.';
  }
  if (text.includes('running the \\"Review\\" stage')) {
    for (const dir of worktreeDirs()) {
      const file = path.join(dir, '.praxis-run', 'change-diff.patch');
      if (fs.existsSync(file)) patchDuringReview = fs.readFileSync(file, 'utf8');
    }
    return 'Reviewed the patch: the change is correct.';
  }
  return undefined;
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-review-diff-'));
  tempDirs.push(root);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'pager.ts'), 'export const first = 1;\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

test('a read-only review stage is handed the whole implementation patch as a file', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', replyFor });
  const repo = createRepository();
  repoUnderTest = repo;
  patchDuringReview = undefined;
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', workingDirectory: repo } },
    undefined,
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;

  const { runId } = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Diff Target', key: 'DIFF', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    await window.praxis.agentRuntime.refresh();
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: `diff-${project.id}`, name: 'Implement and review', scope: 'project', projectId: project.id,
      version: 1, entryNodeId: 'implement', createdAt: now, updatedAt: now,
      nodes: [
        {
          type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: [],
          agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full' },
          instructions: 'Fix the pager.', outputs: [{ id: 'change-diff', kind: 'diff', required: true }], mutatesWorktree: true
        },
        {
          type: 'agent-task', id: 'review', name: 'Review', x: 240, y: 0, inputs: ['change-diff'],
          agent: { agentId: 'praxis-reviewer', profileId: 'praxis-reviewer', hostId: 'praxis-reviewer', scope: 'global', toolMode: 'read-only' },
          instructions: 'Review the change. Do not run shell commands.',
          outputs: [{ id: 'review-report', kind: 'report', required: true }], mutatesWorktree: false, satisfiesGate: 'review'
        },
        { type: 'approval', id: 'approve', name: 'Approve', x: 480, y: 0, inputs: ['review-report'], prompt: 'Ship?', requiredGates: ['review'], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'implement', to: 'review', on: 'success', required: true },
        { id: 'e2', from: 'review', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    const summary = await window.praxis.workflows.startRun(project.id, `diff-${project.id}`, 'Review diff', undefined, undefined, undefined, { uncommittedChanges: 'omit' });
    return { runId: summary.runId };
  }, repo);

  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.status), runId), { timeout: 90000, message: 'the run should reach approval on its own' })
    .toBe('awaiting-approval');

  // The brief points at a file, not at a bare commit the reviewer cannot open.
  const reviewRequest = mock.requests.find(request => request.body.includes('running the \\"Review\\" stage'));
  expect(reviewRequest?.body).toContain('.praxis-run/change-diff.patch');
  expect(reviewRequest?.body).toContain('there is no diff tool');

  // The patch spans the agent's own commit and the stage freeze, not just the last commit.
  expect(patchDuringReview).toContain('-export const first = 1;');
  expect(patchDuringReview).toContain('+export const first = 0;');
  expect(patchDuringReview).toContain('+export const extra = true;');

  // …and is gone once the stage ends, so it can never land in a change.
  for (const dir of worktreeDirs()) expect(fs.existsSync(path.join(dir, '.praxis-run'))).toBe(false);
});
