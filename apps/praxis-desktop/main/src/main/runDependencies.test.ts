import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkflowCheckNode, WorkflowDefinition } from '@praxis/core';
import { ensureRunDependencies, installStageOf } from './runDependencies';

const install = { type: 'check', id: 'install', name: 'Install dependencies', command: 'npm', args: ['ci'], successExitCodes: [0] } as WorkflowCheckNode;
const build = { type: 'check', id: 'build', name: 'Build', command: 'npm', args: ['run', 'build', '--if-present'] } as WorkflowCheckNode;
const withInstall = { nodes: [build, install] } as unknown as WorkflowDefinition;

function worktree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-run-deps-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('the install stage is the check that runs a package manager install, not any npm check', () => {
  assert.equal(installStageOf(withInstall)?.id, 'install');
  assert.equal(installStageOf({ nodes: [build] } as unknown as WorkflowDefinition), undefined);
});

test('an empty worktree is installed and built with the workflow\'s own commands, once, before a stage works in it', async () => {
  const root = worktree({ 'package.json': '{}' });
  const ran: string[] = [];
  const ports = {
    spawn: async (node: WorkflowCheckNode, cwd: string) => {
      ran.push(`${node.command} ${node.args?.join(' ')} in ${path.basename(cwd)}`);
      if (node.id === 'build') return { code: 0, output: '', timedOut: false };
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', '.package-lock.json'), '{}');
      return { code: 0, output: 'added 1 package', timedOut: false };
    }
  };
  const [first, second] = await Promise.all([ensureRunDependencies(withInstall, root, ports), ensureRunDependencies(withInstall, root, ports)]);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(await ensureRunDependencies(withInstall, root, ports), undefined);
  assert.deepEqual(ran, [`npm ci in ${path.basename(root)}`, `npm run build --if-present in ${path.basename(root)}`], 'one install and build, shared, and none once installed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a failed install stops the stage with what npm said', async () => {
  const root = worktree({ 'package.json': '{}' });
  const error = await ensureRunDependencies(withInstall, root, {
    spawn: async () => ({ code: 1, output: 'npm ERR! code EUSAGE\nnpm ERR! lockfile out of sync', timedOut: false })
  });
  assert.match(error ?? '', /Could not install this run's dependencies \(npm ci\): it exited with code 1\./);
  assert.match(error ?? '', /lockfile out of sync/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('nothing is installed for a workflow with no install stage, or a folder that is not a package', async () => {
  const spawn = async () => { throw new Error('should not run'); };
  const pkg = worktree({ 'package.json': '{}' });
  const plain = worktree({ 'README.md': '#' });
  assert.equal(await ensureRunDependencies({ nodes: [build] } as unknown as WorkflowDefinition, pkg, { spawn }), undefined);
  assert.equal(await ensureRunDependencies(withInstall, plain, { spawn }), undefined);
  for (const root of [pkg, plain]) fs.rmSync(root, { recursive: true, force: true });
});

test('a failed build is reported, and the stage still starts', async () => {
  const root = worktree({ 'package.json': '{}' });
  const reported: string[] = [];
  const error = await ensureRunDependencies(withInstall, root, {
    spawn: async node => ({ code: node.id === 'build' ? 2 : 0, output: node.id === 'build' ? 'error TS2307' : '', timedOut: false }),
    report: message => reported.push(message)
  });
  assert.equal(error, undefined);
  assert.match(reported.at(-1) ?? '', /The build failed \(npm run build --if-present\): it exited with code 2\.\nerror TS2307/);
  fs.rmSync(root, { recursive: true, force: true });
});
