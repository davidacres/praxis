import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * The Agent Hub node in the sidebar holds two collapsible sub-headers, Agents and Skills. Where an item
 * comes from is not a tree level: a project's own items sort first and carry a "project" tag, everything
 * else is untagged, and there is no "Global" label anywhere.
 */

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

const padLeft = (page: Page, testId: string) =>
  page.getByTestId(testId).first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));

test('Agent Hub holds Agents and Skills sub-headers, tags project items and has no Global level', async () => {
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

  const agents = page.getByTestId('agent-nav-kind-agents');
  const skills = page.getByTestId('agent-nav-kind-skills');
  await expect(agents).toBeVisible();
  await expect(skills).toBeVisible();
  await expect(skills).toContainText('3');
  await expect(page.getByTestId('skill-nav-item')).toHaveCount(3);

  // The root is named Agent Hub, and no scope label ("Global" or the project's name) is a level.
  await expect(page.getByTestId('nav-agents')).toContainText('Agent Hub');
  await expect(page.getByText('Global', { exact: true })).toHaveCount(0);

  // A project's own skill sorts first and is tagged; the user's own are untagged.
  const skillRows = page.getByTestId('skill-nav-item');
  await expect(skillRows.first()).toContainText('Project Only');
  await expect(skillRows.first().getByTestId('agent-nav-project-tag')).toBeVisible();
  await expect(skillRows.nth(1).getByTestId('agent-nav-project-tag')).toHaveCount(0);
  // The tag must not crowd the name out: the whole name stays readable even with an "approval" badge beside it.
  const nameBox = await skillRows.first().locator('.tree-label').evaluate(el => ({ shown: el.clientWidth, needed: el.scrollWidth }));
  expect(nameBox.needed).toBeLessThanOrEqual(nameBox.shown);

  // Agent Hub row (18) → sub-header (30) → row (42): each level steps in, none flush or reversed.
  const kindPad = await padLeft(page, 'agent-nav-kind-skills');
  const rowPad = await padLeft(page, 'skill-nav-item');
  expect(rowPad).toBeGreaterThan(kindPad);
  expect(kindPad).toBe(30);
  expect(rowPad).toBe(42);
  // The reload replays the startup splash; capture the app, not the splash.
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await page.getByTestId('skill-nav-item').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'agent-tree-kinds.png') });

  // Folding Skills hides its rows and leaves Agents alone; reopening restores them.
  await skills.click();
  await expect(skills).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('skill-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('profile-nav-item').first()).toBeVisible();
  await skills.click();
  await expect(page.getByTestId('skill-nav-item')).toHaveCount(3);

  // A row still opens its record.
  await page.getByTestId('skill-nav-item').first().click();
  await expect(page.getByTestId('skill-nav-item').first()).toHaveClass(/active/);
});
