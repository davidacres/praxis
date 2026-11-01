import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * QA runs the tests for the run's change, not only the project's own test command.
 *
 * TASK-498 to TASK-502 each merged with notes tests failing, because QA ran only `npm test` (units
 * and a smoke set) and the notes specs were not in it. Here a stage changes an element's text; the
 * QA check's own command passes, and QA also picks the one test that drives that element by its
 * test id — and not the one that does not — and says why.
 */

test.slow();

let app: TestApp | undefined;
const roots: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const shelf = (label: string) => `export function Shelf() {\n  return <span data-testid="note-save-state">${label}</span>;\n}\n`;

test('a QA check also picks the tests that drive what the change touched, and names why', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-change-tests-'));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'e2e'));
  fs.writeFileSync(path.join(repo, 'src', 'Shelf.tsx'), shelf('Saved'));
  fs.writeFileSync(path.join(repo, 'e2e', 'shelfNotes.spec.ts'), "test('saves', async () => { await page.getByTestId('note-save-state').waitFor(); });\n");
  fs.writeFileSync(path.join(repo, 'e2e', 'board.spec.ts'), "test('board', async () => { await page.getByTestId('board-column').waitFor(); });\n");
  git('init', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-m', 'initial');

  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const editAndCommit = [
    "const fs = require('fs'); const { execFileSync } = require('child_process');",
    `fs.writeFileSync('src/Shelf.tsx', ${JSON.stringify(shelf('Saved just now'))});`,
    "execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-qam', 'Change the save state']);"
  ].join(' ');

  const runId = await page.evaluate(async ({ repoPath, node, script }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Change tests', key: 'CHT', type: 'software', purpose: '', brief: {},
      startingPoint: 'existing-folder', folderPath: repoPath,
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [], defaultAiToolMode: 'read-only'
    }, workspace.id);
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: `cht-${project.id}`, name: 'Change then QA', scope: 'project', projectId: project.id,
      version: 1, entryNodeId: 'change', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'change', name: 'Change', x: 0, y: 0, inputs: [], command: node, args: ['-e', script], successExitCodes: [0], mutatesWorktree: true, outputs: [{ id: 'change-log', kind: 'log', required: false }] },
        { type: 'check', id: 'qa', name: 'QA', x: 200, y: 0, inputs: [], command: node, args: ['-e', "console.log('project tests passed')"], successExitCodes: [0], satisfiesGate: 'qa', outputs: [{ id: 'qa-log', kind: 'log', required: true }] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 400, y: 0, inputs: ['qa-log'], prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false }
      ],
      edges: [
        { id: 'e1', from: 'change', to: 'qa', on: 'success', required: true },
        { id: 'e2', from: 'qa', to: 'approve', on: 'success', required: true }
      ]
    } as never);
    return (await window.praxis.workflows.startRun(project.id, `cht-${project.id}`, 'Change', undefined, undefined, undefined, { uncommittedChanges: 'omit' })).runId;
  }, { repoPath: repo, node: process.execPath, script: editAndCommit });

  await expect
    .poll(() => page.evaluate(id => window.praxis.workflows.getRun(id).then(run => run?.stages.find(stage => stage.nodeId === 'qa')?.outcome), runId), { timeout: 60000 })
    .toBe('succeeded');
  const evidence = await page.evaluate(id => window.praxis.workflows.getEvidence(id, 'qa', 1), runId);
  const log = JSON.stringify(evidence);
  expect(log).toContain('project tests passed');
  expect(log).toContain('== Tests for this change ==');
  expect(log).toContain('e2e/shelfNotes.spec.ts: uses \\"note-save-state\\" from src/Shelf.tsx');
  expect(log).not.toContain('board.spec.ts');
  // No Playwright, Vitest, Jest or pytest setup in this repository, so the file is named, not run.
  expect(log).toContain('Not run here');
});
