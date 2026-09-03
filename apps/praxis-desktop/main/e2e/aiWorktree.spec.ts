import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A full-tools session can run in a dedicated git worktree branched off the
 * working folder's current branch, and the console can tear that worktree down
 * again once the session is finished.
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
let repo: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-ai-worktree-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Praxis Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'praxis@example.test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

test('a worktree session creates the branch + checkout and the console can remove it', async () => {
  repo = initRepo();
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'Nothing to change.' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  const record = await win.evaluate(async workingDirectory => {
    return window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      toolMode: 'full',
      workingDirectory,
      runInWorktree: true,
      task: { goal: 'Look around, no changes needed.' }
    });
  }, repo);

  expect(record.worktreePath).toBeTruthy();
  expect(record.worktreeBranch).toContain('SESSION-');
  expect(fs.existsSync(record.worktreePath!)).toBe(true);
  expect(fs.existsSync(path.join(repo, '.worktrees', record.worktreeName!))).toBe(true);

  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-worktree"]')).toContainText(record.worktreeBranch!);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  await win.locator('[data-testid="session-remove-worktree"]').click();
  await win.getByRole('dialog', { name: 'Remove the git worktree?' }).getByRole('button', { name: 'Remove worktree' }).click();

  await expect(win.locator('[data-testid="session-worktree"]')).toHaveCount(0);
  await expect.poll(() => fs.existsSync(record.worktreePath!)).toBe(false);
});
