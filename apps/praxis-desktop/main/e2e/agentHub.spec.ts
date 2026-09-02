import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-009 — the Agent Hub catalog.
 *
 * Seeds the throwaway user-data profile with a valid agent, an invalid agent,
 * and a skill, then drives the Agents sidebar route: the catalog groups by
 * scope, detail shows the manifest, and an invalid manifest fails closed.
 */

test.slow();

let app: TestApp;

function seedAgent(userDataDir: string, id: string, manifest: Record<string, unknown>): void {
  const dir = path.join(userDataDir, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2));
}

function seedSkill(userDataDir: string, name: string, body: string): void {
  const dir = path.join(userDataDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  seedAgent(app.userDataDir, 'praxis-reviewer', {
    schemaVersion: 1,
    id: 'praxis-reviewer',
    name: 'Praxis Reviewer',
    type: 'acp',
    entry: { command: 'node', args: ['review.js'] },
    activation: 'onDemand'
  });
  seedAgent(app.userDataDir, 'broken-agent', {
    schemaVersion: 1,
    id: 'broken-agent',
    name: 'Broken Agent',
    type: 'telepathy',
    entry: 'run.js'
  });
  seedSkill(
    app.userDataDir,
    'code-audit',
    '---\nname: code-audit\ndescription: Audits a diff for risky changes.\ntriggers: review, audit\n---\nInstructions.'
  );
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('lists discovered agents and skills by scope with fail-closed detail', async () => {
  const page = app.window;

  await page.getByTestId('nav-agents').click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();

  // Discovery ran before the seed for the profile's first list(); Refresh picks it up.
  await page.getByRole('button', { name: /Refresh/ }).click();

  const catalog = page.getByRole('navigation', { name: 'Agent catalog' });
  await expect(catalog.getByRole('heading', { name: 'Global' })).toBeVisible();
  const reviewerRow = catalog.getByRole('button', { name: /Praxis Reviewer/ });
  const brokenRow = catalog.getByRole('button', { name: /Broken Agent/ });
  await expect(reviewerRow).toBeVisible();
  await expect(brokenRow).toBeVisible();
  await expect(catalog.getByRole('button', { name: /code-audit/ })).toBeVisible();

  // The valid agent's detail shows the manifest and can be started.
  await reviewerRow.click();
  const detail = page.getByRole('region', { name: 'Details' });
  await expect(detail.getByRole('heading', { name: 'Praxis Reviewer' })).toBeVisible();
  await expect(detail.getByText('praxis-reviewer', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start host' })).toBeEnabled();
  await expect(page.getByRole('main')).toHaveScreenshot('agent-hub-detail.png');

  // The invalid agent fails closed: Start is disabled and the reason is shown.
  await brokenRow.click();
  await expect(detail.getByRole('heading', { name: 'Broken Agent' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Start host' })).toBeDisabled();
  await expect(detail.getByText(/Manifest is invalid/)).toBeVisible();

  // The skill detail lists its triggers and offers activation against the agent.
  await catalog.getByRole('button', { name: /code-audit/ }).click();
  await expect(detail.getByRole('heading', { name: 'code-audit' })).toBeVisible();
  await expect(detail.getByText('Audits a diff for risky changes.')).toBeVisible();
  await expect(detail.getByRole('button', { name: /Activate with Praxis Reviewer/ })).toBeEnabled();
});
