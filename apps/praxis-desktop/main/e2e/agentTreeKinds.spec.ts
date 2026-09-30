import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/** Agent and skill catalog navigation and management live in Agent Runtime settings. */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function seed(userDataDir: string): void {
  const agent = path.join(userDataDir, 'agents', 'code-reviewer');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(
    path.join(agent, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id: 'code-reviewer', name: 'Code Reviewer', type: 'acp', entry: { command: 'node', args: ['agent.js'] } })
  );
  fs.writeFileSync(path.join(agent, 'AGENT.md'), '---\nid: code-reviewer\nname: Code Reviewer\ndescription: Reviews changes.\nskills: code-audit\n---\nReview the change.');
  for (const name of ['code-audit', 'test-writing']) {
    const skill = path.join(userDataDir, 'skills', name);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} guidance.\ntriggers: ${name}\n---\nDo ${name}.`);
  }
}

test('Agent Hub is absent from the sidebar and Agent Runtime owns agent and skill options', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-agent-tree-'));
  tempDirs.push(workdir);
  const projectSkill = path.join(workdir, '.praxis', 'skills', 'project-only');
  fs.mkdirSync(projectSkill, { recursive: true });
  fs.writeFileSync(path.join(projectSkill, 'SKILL.md'), '---\nname: project-only\ndescription: Only this project.\ntriggers: project\n---\nDo the project thing.');
  app = await launchTestApp({ ai: { workingDirectory: workdir } }, undefined, undefined, { openNewSession: false });
  seed(app.userDataDir);
  const page = app.window;
  await page.evaluate(async () => window.praxis.agentRuntime.refresh());
  await page.reload();

  await expect(page.getByTestId('nav-agents')).toHaveCount(0);
  await expect(page.getByTestId('nav-agents-toggle')).toHaveCount(0);
  await expect(page.getByTestId('nav-agents-new')).toHaveCount(0);
  await expect(page.getByTestId('agent-nav-kind-agents')).toHaveCount(0);
  await expect(page.getByTestId('agent-nav-kind-skills')).toHaveCount(0);
  await expect(page.getByTestId('profile-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('skill-nav-item')).toHaveCount(0);

  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'sidebar-without-agent-hub.png') });

  await page.getByTestId('titlebar-settings').click();
  await page.getByTestId('settings-nav-agent-runtime').click();
  const runtime = page.getByTestId('settings-agent-runtime');
  await expect(runtime.getByTestId('agent-runtime-new-profile')).toBeVisible();
  await expect(runtime.getByTestId('agent-runtime-import-profile')).toBeVisible();
  await expect(runtime.getByTestId('agent-runtime-refresh')).toBeVisible();

  await runtime.getByTestId('agent-runtime-tab-skills').click();
  await expect(runtime.getByTestId('agent-runtime-new-skill')).toBeVisible();
  await expect(runtime.getByTestId('agent-runtime-import-skill')).toBeVisible();
  await expect(runtime.getByTestId('agent-runtime-skill-project-only')).toContainText('Project');
  await expect(runtime.getByTestId('agent-runtime-skill-code-audit')).toBeVisible();
  await expect(runtime.getByTestId('agent-runtime-skill-test-writing')).toBeVisible();

  await runtime.getByTestId('agent-runtime-skill-project-only').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'agent-runtime-catalog.png') });

  await runtime.getByTestId('agent-runtime-skill-project-only').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Project Only', level: 1 })).toBeVisible();
});
