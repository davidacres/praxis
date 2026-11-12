import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * QA runs the tests for the run's change, and only those.
 *
 * TASK-498 to TASK-502 each merged with notes tests failing, because QA ran only `npm test` (units
 * and a smoke set) and the notes specs were not in it. QA's contract since then (5e359403) is the
 * ticket's own changed tests: a QA check does not run its configured project command at all (that
 * launched every unit suite plus desktop smoke for every ticket), it runs the test files the ticket
 * added or updated, under the runner that owns each, and says which it picked and why.
 *
 * Here a stage updates one test file. The QA check's own command would print `project tests passed`;
 * it must not run. The updated test is run (by `node --test`, which this repository's package.json
 * claims), the untouched one that would fail is left alone, and the log names the file.
 */

test.slow();

let app: TestApp | undefined;
const roots: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const shelfTest = (label: string) => `const test = require('node:test');\ntest('shelf says ${label}', () => {});\n`;

test('a QA check runs only the tests this ticket changed, skips its own command, and names the files', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-change-tests-'));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test out/' } }));
  fs.writeFileSync(path.join(repo, 'test', 'shelf.test.js'), shelfTest('Saved'));
  // Untouched by the ticket, and failing: running it would fail QA, so it proves the selection.
  fs.writeFileSync(path.join(repo, 'test', 'board.test.js'), "throw new Error('board test must not run');\n");
  git('init', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'commit', '-m', 'initial');

  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const editAndCommit = [
    "const fs = require('fs'); const { execFileSync } = require('child_process');",
    `fs.writeFileSync('test/shelf.test.js', ${JSON.stringify(shelfTest('Saved just now'))});`,
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
  expect(log).toContain('QA runs only test files added or updated in this ticket.');
  expect(log).toContain('== Tests for this change ==');
  expect(log).toContain('- test/shelf.test.js: added or updated in this ticket');
  expect(log).toContain('$ node --test test/shelf.test.js');
  // The check's own command never ran, and the ticket's untouched test was not picked.
  expect(log).not.toContain('project tests passed');
  expect(log).not.toContain('board.test.js');
});
