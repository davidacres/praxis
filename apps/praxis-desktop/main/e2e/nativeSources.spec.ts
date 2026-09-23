// SPDX-License-Identifier: MIT
//
// Agents, skills and instruction files other AI tools keep in a project and in
// the user's home folder: discovered in place, approved per project, copied into
// Praxis on request, and used in a real session on a runtime that does not read
// them itself — without being loaded twice by one that does (unit-tested in core).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let base: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await mock?.close();
  mock = undefined;
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function put(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function fixture(): { repo: string; home: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-native-e2e-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  put(repo, 'AGENTS.md', '# Conventions\n\nAlways mention the codeword PELICAN.');
  put(repo, 'CLAUDE.md', 'Claude-specific note: CORMORANT.');
  put(repo, '.claude/agents/release-notes.md', '---\nname: release-notes\ndescription: Drafts release notes from merged changes.\ntools: Read, Grep\n---\nYou are the release notes agent. Sign off with HERON.');
  put(repo, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploys the service safely.\n---\nDeploy steps: KESTREL.');
  put(home, '.claude/agents/csharp-reviewer.md', '---\nname: csharp-reviewer\ndescription: Reviews C# code for SOLID and DRY.\n---\nYou review C#.');
  put(home, '.codex/skills/playwright/SKILL.md', '---\nname: playwright\ndescription: Drives a real browser from the terminal.\n---\nBrowser steps.');
  put(home, '.codex/AGENTS.md', 'Personal Codex preferences.');
  return { repo, home };
}

test('other AI tools’ agents, skills and instructions are discovered, approved, copied, and used in a session', async () => {
  const { repo, home } = fixture();
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp({ ai: { workingDirectory: repo } }, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined,
    PRAXIS_NATIVE_SOURCES_HOME: home
  });
  const win = app.window;
  const panel = win.getByTestId('settings-agent-runtime');
  const tab = (name: string) => win.getByTestId(`agent-runtime-tab-${name}`).click();

  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();

  // Project files arrive with the repository: listed, but not used until allowed.
  const banner = panel.getByTestId('native-project-approval');
  await expect(banner).toContainText('This project has files for other AI tools');
  await expect(banner).toContainText(repo);
  const projectAgent = panel.getByTestId('agent-runtime-profile-release-notes');
  await expect(projectAgent).toContainText('Release Notes');
  await expect(projectAgent).toContainText('Drafts release notes from merged changes.');
  await expect(projectAgent).toContainText('Claude Code · project');
  await expect(projectAgent).toContainText('Needs approval');
  await expect(projectAgent).toContainText('Read-only');
  await expect(projectAgent).toContainText('Loaded natively by Claude Code');
  const userAgent = panel.getByTestId('agent-runtime-profile-csharp-reviewer');
  await expect(userAgent).toContainText('Claude Code · your user folder');
  await expect(userAgent).not.toContainText('Needs approval');

  await banner.getByRole('button', { name: 'Allow this project' }).click();
  await expect(banner).toHaveCount(0);
  await expect(projectAgent).not.toContainText('Needs approval');

  // Skills: copy a Codex skill into Praxis; the copy takes over and remembers the original.
  await tab('skills');
  await expect(panel.getByTestId('agent-runtime-skill-deploy')).toContainText('Claude Code · project');
  const codexSkill = panel.getByTestId('agent-runtime-skill-playwright');
  await expect(codexSkill).toContainText('Codex · your user folder');
  await codexSkill.getByRole('button', { name: 'Copy to Praxis' }).click();
  await expect(codexSkill.locator('.badge', { hasText: 'Codex' })).toHaveCount(0);
  await expect(codexSkill).toContainText('Also in Codex · your user folder');
  expect(fs.existsSync(path.join(app.userDataDir, 'skills', 'playwright', 'SKILL.md'))).toBe(true);

  // Instructions: who reads each file, and what Praxis does with it.
  await tab('instructions');
  const agentsMd = panel.getByTestId('native-instruction-AGENTS.md');
  await expect(agentsMd).toContainText('Loaded natively by Codex and GitHub Copilot.');
  await expect(agentsMd).toContainText('Added to sessions on the other runtimes.');
  await expect(panel.getByTestId('native-instruction-~/.codex/AGENTS.md')).toContainText('Personal files stay with their own tool');
  await win.mouse.move(0, 0);
  await win.screenshot({ path: 'output/playwright/native-sources-instructions.png' });
  await win.getByRole('button', { name: 'Done' }).click();

  // A session bound to the Claude agent, on an API runtime that reads none of these
  // files itself: the project's instructions, the agent and its skill all arrive.
  const session = await win.evaluate(
    async ({ cwd }) => window.praxis.ai.delegate({
      goal: 'Draft the release notes.',
      workingDirectory: cwd,
      toolMode: 'read-only',
      profileId: 'release-notes',
      hostId: 'release-notes',
      skillNames: ['deploy'],
      task: { goal: 'Draft the release notes.', maxSteps: 2, timeoutMs: 30000 }
    }),
    { cwd: repo }
  );
  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(list => list.find(s => s.issueKey === k)?.state), session.issueKey), { timeout: 20000 })
    .toBe('completed');
  const sent = mock.requests.map(request => request.body).join('\n');
  expect(sent).toContain('PELICAN'); // AGENTS.md
  expect(sent).toContain('CORMORANT'); // CLAUDE.md — an API runtime does not read it either
  expect(sent).toContain('HERON'); // the Claude agent's own instructions
  expect(sent).toContain('KESTREL'); // its skill, supplied by Praxis
  expect(sent).not.toContain('Personal Codex preferences'); // user files stay with their tool

  // Turning a tool off removes what came from it.
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-agent-runtime').click();
  await tab('advanced');
  await panel.getByTestId('native-ecosystem-claude').click();
  await tab('agents');
  await expect(panel.getByTestId('agent-runtime-profile-release-notes')).toHaveCount(0);
  await expect(panel.getByTestId('agent-runtime-profile-csharp-reviewer')).toHaveCount(0);
});

test('an agent from another AI tool can be placed on a workflow stage and bound to its skill', async () => {
  const { repo, home } = fixture();
  app = await launchTestApp({ ai: { workingDirectory: repo } }, undefined, { PRAXIS_NATIVE_SOURCES_HOME: home }, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Delivery Project',
        key: 'DELIV',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await page.reload();

  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByRole('listitem').filter({ hasText: 'Quick change' }).click();
  await dialog.getByRole('button', { name: /^Use/ }).click();
  await expect(dialog).toBeHidden();

  // The user-folder Claude agent (trusted) and the Codex skill are in the palette.
  const palette = page.getByLabel('Workflow stages').getByLabel('Build with agents and skills');
  const reviewer = palette.getByTestId('wf-palette-agent-csharp-reviewer');
  const skill = palette.getByTestId('wf-palette-skill-playwright');
  await expect(reviewer).toBeVisible();
  await expect(skill).toBeVisible();

  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await reviewer.dragTo(canvas, { targetPosition: { x: 330, y: 180 } });
  const stage = canvas.getByRole('button', { name: /^Csharp Reviewer \(agent-task\).*agent Csharp Reviewer/ });
  await expect(stage).toBeVisible();
  await skill.dragTo(stage);
  await expect(stage).toContainText('playwright');
});
