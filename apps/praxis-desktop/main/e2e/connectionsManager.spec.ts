import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/** Same fixture shape as liveFolder.spec.ts: one feature with one task. */
function writeFixturePlansFolder(root: string): void {
  const featureDir = path.join(root, 'features', 'feature-01-demo-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    ['# Demo Feature', '', '**Status:** 📋 Proposed', '**Type:** Feature', '', '## Description', '', 'A demo feature for e2e testing.', ''].join(
      '\n'
    )
  );
}

/** Launches the app and opens a blank new-connection form. */
async function openNewConnectionForm(): Promise<void> {
  app = await launchTestApp();
  window = app.window;
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="add-connection-btn"]').click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();
}

test('the new-connection form renders the per-mode field sets', async () => {
  await openNewConnectionForm();
  const modeSelect = window.locator('[data-testid="conn-field-mode"]');

  // demo is the default mode.
  await expect(window.locator('[data-testid="conn-mode-note"]')).toContainText('sample data');

  await modeSelect.selectOption('folder');
  await expect(window.locator('[data-testid="conn-field-root-0"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-browse-root-0"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-projectKey"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-projectName"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-allowIssueCreation"]')).toBeVisible();

  await modeSelect.selectOption('jiracloud');
  // The default jira sub-mode for a new connection is Cloud (recommended); the
  // Advanced controls (connectionType / stdioArgs / httpUrl / boardJql …) stay
  // hidden behind the "Advanced" radio until the user opts in.
  await expect(window.locator('[data-testid="conn-field-url"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-connectionType"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="conn-field-boardJql"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="conn-field-httpUrl"]')).toHaveCount(0);
  // OAuth is the default Cloud sign-in method — switching to API Token reveals
  // the email + token fields.
  await expect(window.locator('[data-testid="jira-auth-oauth"]')).toBeChecked();
  await expect(window.locator('[data-testid="jira-api-email"]')).toHaveCount(0);
  // The "bring your own Atlassian OAuth app" section is rendered in OAuth mode…
  await expect(window.locator('[data-testid="jira-byo-oauth"]')).toHaveCount(1);
  await window.locator('[data-testid="jira-auth-token"]').click();
  await expect(window.locator('[data-testid="jira-api-email"]')).toBeVisible();
  await expect(window.locator('[data-testid="jira-api-token"]')).toBeVisible();
  // …and absent in token mode (its keys and secret would not be used).
  await expect(window.locator('[data-testid="jira-byo-oauth"]')).toHaveCount(0);
  // Flipping to Advanced reveals the original MCP-server controls, including
  // the httpUrl field once connectionType is "http".
  await window.locator('[data-testid="conn-field-mode"]').selectOption('jiracloud'); // (no-op keeps mode)
  await window.locator('[data-testid="jira-setup-mode-advanced"]').click();
  await expect(window.locator('[data-testid="conn-field-connectionType"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-boardJql"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-httpUrl"]')).toHaveCount(0);
  await window.locator('[data-testid="conn-field-connectionType"]').selectOption('http');
  await expect(window.locator('[data-testid="conn-field-httpUrl"]')).toBeVisible();

  await modeSelect.selectOption('gitlab');
  await expect(window.locator('[data-testid="conn-field-url"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-projectPath"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-field-secret-apiKey"]')).toBeVisible();

  await modeSelect.selectOption('github');
  await expect(window.locator('[data-testid="conn-mode-note"]')).toContainText('not implemented');
});

test('saving a live folder connection auto-tracks its board', async () => {
  const plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-conn-live-'));
  try {
    writeFixturePlansFolder(plansDir);
    await openNewConnectionForm();

    await window.locator('[data-testid="conn-field-name"]').fill('e2e-live-manager');
    await window.locator('[data-testid="conn-field-mode"]').selectOption('folder');
    await window.locator('[data-testid="conn-field-root-0"]').fill(plansDir);
    await window.locator('[data-testid="conn-field-projectKey"]').fill('E2EL');
    await window.locator('[data-testid="conn-field-projectName"]').fill('E2E Live');
    await window.locator('[data-testid="conn-save-btn"]').click();

    // The synthesized tracked board appears in the detail pane…
    const trackedRow = window.locator('[data-testid="tracked-board-row"]', { hasText: 'E2E Live' });
    await expect(trackedRow).toBeVisible();
    await expect(trackedRow).toContainText('folder-e2el');

    // …and the board itself is listed in the sidebar.
    await expect(
      window.locator('[data-testid="board-nav-item"]', { hasText: 'E2E Live' })
    ).toBeVisible();
  } finally {
    fs.rmSync(plansDir, { recursive: true, force: true });
  }
});

test('testing an unconfigured Jira connection surfaces the stub error', async () => {
  await openNewConnectionForm();

  await window.locator('[data-testid="conn-field-name"]').fill('e2e-jira-stub');
  await window.locator('[data-testid="conn-field-mode"]').selectOption('jiracloud');
  // Cloud is the default sub-mode and writes a fixed httpUrl on save, which
  // is enough for the resolver to pick an endpoint. Switch to Advanced and
  // leave its fields empty to exercise the "no MCP server configured" stub.
  await window.locator('[data-testid="jira-setup-mode-advanced"]').click();
  await window.locator('[data-testid="conn-test-btn"]').click();

  const result = window.locator('[data-testid="conn-test-result"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText('ERROR');
  await expect(result).toContainText('Jira is not configured');

  // Testing persists the connection (the backend registry resolves services by
  // connection id, so the form materializes before checking) — the row shows
  // up without the form closing or the result disappearing.
  await expect(window.locator('[data-testid="connection-row"]', { hasText: 'e2e-jira-stub' })).toBeVisible();
  await expect(result).toBeVisible();
});

test('saving a demo connection synthesizes its tracked board', async () => {
  await openNewConnectionForm();

  const name = `e2e-demo-${Date.now()}`;
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  // Mode defaults to demo.
  await window.locator('[data-testid="conn-save-btn"]').click();

  await expect(window.locator('[data-testid="tracked-board-row"]', { hasText: name })).toBeVisible();
});

test('connection rows edit names, lock backend type, and require boards to be removed first', async () => {
  await openNewConnectionForm();

  const name = `e2e-delete-connection-${Date.now()}`;
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  await window.locator('[data-testid="conn-save-btn"]').click();

  const row = window.locator('[data-testid="connection-row"]', { hasText: name });
  await expect(row).toBeVisible();
  await row.click();
  await expect(window.locator('[data-testid="conn-field-mode"]')).toBeDisabled();

  const renamed = `${name}-renamed`;
  await window.locator('[data-testid="conn-field-name"]').fill(renamed);
  await window.locator('[data-testid="conn-save-btn"]').click();
  await expect(window.locator('[data-testid="connection-row"]', { hasText: renamed })).toBeVisible();

  const renamedRow = window.locator('[data-testid="connection-row"]', { hasText: renamed });
  const removeButton = renamedRow.getByRole('button', { name: `Remove ${renamed}` });
  await expect(removeButton).toBeDisabled();

  await window.locator('[data-testid="tracked-board-row"]', { hasText: renamed }).getByRole('button').click();
  await expect(removeButton).toBeEnabled();

  await removeButton.click();
  await window.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(window.locator('[data-testid="connection-row"]', { hasText: renamed })).toHaveCount(0);
});

test('a saved GitLab API key shows as saved when the connection is re-opened', async () => {
  await openNewConnectionForm();

  await window.locator('[data-testid="conn-field-name"]').fill('e2e-gitlab-secret');
  await window.locator('[data-testid="conn-field-mode"]').selectOption('gitlab');
  await window.locator('[data-testid="conn-field-url"]').fill('http://127.0.0.1:9');
  await window.locator('[data-testid="conn-field-secret-apiKey"]').fill('glpat-e2e-secret');
  await window.locator('[data-testid="conn-save-btn"]').click();

  // gitlab has discoverable boards, so save chains into the picker. Port 9
  // (discard) refuses fast and offline-safely — the real GitLab backend
  // surfaces the fetch failure in the picker's error state.
  await expect(window.locator('[data-testid="board-picker"]')).toBeVisible();
  await expect(window.locator('[data-testid="board-picker-error"]')).toBeVisible();
  await window.locator('[data-testid="board-picker-cancel"]').click();

  // Re-open the connection — the secret field shows a saved indicator without
  // the value ever leaving the main process.
  await window.locator('[data-testid="connection-row"]', { hasText: 'e2e-gitlab-secret' }).click();
  await expect(window.locator('[data-testid="conn-form"]')).toContainText('A key is saved');
});

test('saving a Jira Cloud connection in API-token mode writes the expected on-disk shape', async () => {
  app = await launchTestApp();
  window = app.window;
  const settingsPath = app.settingsPath;
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="add-connection-btn"]').click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();

  const name = `e2e-jira-cloud-token-${Date.now()}`;
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  await window.locator('[data-testid="conn-field-mode"]').selectOption('jiracloud');

  // Cloud is the default jira sub-mode; OAuth is the default sign-in method.
  await expect(window.locator('[data-testid="jira-setup-mode-cloud"]')).toBeChecked();
  await expect(window.locator('[data-testid="jira-auth-oauth"]')).toBeChecked();

  await window.locator('[data-testid="conn-field-url"]').fill('https://e2e-team.atlassian.net');
  await window.locator('[data-testid="jira-auth-token"]').click();
  await window.locator('[data-testid="jira-api-email"]').fill('e2e@example.com');
  await window.locator('[data-testid="jira-api-token"]').fill('e2e-jira-token-secret');
  await window.locator('[data-testid="conn-save-btn"]').click();

  // The connection is materialized on disk before we read it. Read the
  // per-test settings file (a snapshot of what the app persisted) BEFORE
  // closeTestApp deletes the throwaway user-data directory.
  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).toBeVisible();
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(raw) as { connections?: Array<Record<string, unknown>> };
  const saved = settings.connections?.find(entry => entry['name'] === name);
  expect(saved).toBeDefined();
  const savedSettings = saved?.['settings'] as Record<string, unknown>;
  expect(savedSettings['connectionType']).toBe('http');
  expect(savedSettings['httpUrl']).toBe('https://mcp.atlassian.com/v1/mcp');
  expect(savedSettings['jiraAuthMethod']).toBe('api-token');
  expect(savedSettings['jiraApiEmail']).toBe('e2e@example.com');
  expect(savedSettings['url']).toBe('https://e2e-team.atlassian.net');
  // None of the Advanced-only keys should leak through into Cloud mode.
  for (const staleKey of [
    'stdioCommand',
    'stdioArgs',
    'stdioCwd',
    'env',
    'httpHeaders',
    'headers',
    'workspaceMcpServerName',
    'userMcpServerRef'
  ]) {
    expect(staleKey in savedSettings).toBe(false);
  }
});

test('saving a Jira Cloud connection with a BYO OAuth app writes the client id', async () => {
  app = await launchTestApp();
  window = app.window;
  const settingsPath = app.settingsPath;
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="add-connection-btn"]').click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();

  const name = `e2e-jira-cloud-oauth-byo-${Date.now()}`;
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  await window.locator('[data-testid="conn-field-mode"]').selectOption('jiracloud');

  // Cloud + OAuth is the default sub-mode/sign-in method for a new
  // connection; the BYO section is collapsed by default, so expand it
  // before filling the client id.
  await expect(window.locator('[data-testid="jira-setup-mode-cloud"]')).toBeChecked();
  await expect(window.locator('[data-testid="jira-auth-oauth"]')).toBeChecked();
  await expect(window.locator('[data-testid="jira-byo-oauth"]')).toHaveCount(1);
  await window.locator('[data-testid="jira-byo-oauth-summary"]').click();
  await window.locator('[data-testid="jira-oauth-client-id"]').fill('my-3lo-client-id');
  await window.locator('[data-testid="conn-field-url"]').fill('https://e2e-team.atlassian.net');
  await window.locator('[data-testid="conn-save-btn"]').click();

  // The connection is materialized on disk before we read it. Read the
  // per-test settings file (a snapshot of what the app persisted) BEFORE
  // closeTestApp deletes the throwaway user-data directory.
  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).toBeVisible();
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(raw) as { connections?: Array<Record<string, unknown>> };
  const saved = settings.connections?.find(entry => entry['name'] === name);
  expect(saved).toBeDefined();
  const savedSettings = saved?.['settings'] as Record<string, unknown>;
  expect(savedSettings['connectionType']).toBe('http');
  expect(savedSettings['httpUrl']).toBe('https://mcp.atlassian.com/v1/mcp');
  expect(savedSettings['jiraAuthMethod']).toBe('oauth');
  expect(savedSettings['jiraOAuthClientId']).toBe('my-3lo-client-id');
  expect(savedSettings['url']).toBe('https://e2e-team.atlassian.net');
  // Token-mode-only key should not leak through into OAuth-mode settings.
  expect('jiraApiEmail' in savedSettings).toBe(false);
  // None of the Advanced-only keys should leak through into Cloud mode.
  for (const staleKey of [
    'stdioCommand',
    'stdioArgs',
    'stdioCwd',
    'env',
    'httpHeaders',
    'headers',
    'workspaceMcpServerName',
    'userMcpServerRef'
  ]) {
    expect(staleKey in savedSettings).toBe(false);
  }
});
