import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

async function openOverviewSettings(): Promise<void> {
  await app.window.locator('[data-testid="titlebar-settings"]').click();
  await expect(app.window.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Reset to defaults' })).toBeVisible();
}

test('reset to defaults asks separately before clearing saved AI session data', async () => {
  fs.writeFileSync(path.join(app.userDataDir, 'ai-sessions.json'), '{"sessions":"sentinel"}');
  fs.writeFileSync(path.join(app.userDataDir, 'ai-analysis.json'), '{"analysis":"sentinel"}');

  await openOverviewSettings();
  await app.window.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(app.window.getByRole('dialog', { name: 'Reset settings to defaults?' })).toBeVisible();
  await app.window.getByRole('button', { name: 'Reset settings' }).click();
  await expect(app.window.getByRole('dialog', { name: 'Clear saved session data too?' })).toBeVisible();
  await app.window.getByRole('button', { name: 'Clear session data' }).click();
  await expect.poll(() => fs.existsSync(path.join(app.userDataDir, 'ai-sessions.json'))).toBe(false);
  await expect.poll(() => fs.existsSync(path.join(app.userDataDir, 'ai-analysis.json'))).toBe(false);
});

test('clears app-owned project, workspace, and board data without deleting shared connections', async () => {
  const userDataFiles = [
    'workspaces.json',
    'workspace-locations.json',
    'projects.json',
    'board-preferences.json',
    'task-designer.json'
  ];
  for (const file of userDataFiles) fs.writeFileSync(path.join(app.userDataDir, file), '{"sentinel":true}');
  fs.mkdirSync(path.join(app.userDataDir, 'projects', 'sentinel'), { recursive: true });
  fs.writeFileSync(path.join(app.userDataDir, 'projects', 'sentinel', 'state.json'), '{}');
  fs.writeFileSync(app.settingsPath, '{"connections":{"sentinel":true}}');

  await openOverviewSettings();
  await app.window.getByTestId('clear-project-workspace-board-data').click();
  await expect(app.window.getByRole('dialog', { name: 'Clear project data?' })).toBeVisible();
  await app.window.getByRole('button', { name: 'Clear project data' }).click();

  await expect.poll(() => userDataFiles.some(file => fs.existsSync(path.join(app.userDataDir, file)))).toBe(false);
  await expect.poll(() => fs.existsSync(path.join(app.userDataDir, 'projects'))).toBe(false);
  expect(fs.readFileSync(app.settingsPath, 'utf8')).toContain('sentinel');
});
