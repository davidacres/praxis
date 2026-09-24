import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runWorkflowMerge } from './workflowMergeRunner';
import type { WorkflowMergeNode, WorkflowRun } from '@praxis/core';

function setupRepo(): { repo: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-merge-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Praxis Test');
  git('config', 'user.email', 'test@praxis.local');

  fs.writeFileSync(path.join(dir, 'README.md'), '# Main\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initial commit');

  return {
    repo: dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('runWorkflowMerge performs a clean merge of delivery branch into target branch', async () => {
  const { repo, cleanup } = setupRepo();
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const runId = 'abcd1234ef567890';
    const branchName = `WF-ABCD1234`;

    // Create delivery branch with a commit
    git('checkout', '-b', branchName);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'new feature work\n');
    git('add', 'feature.txt');
    git('commit', '-m', 'Add feature');

    // Switch back to main
    git('checkout', 'main');

    const node: WorkflowMergeNode = {
      type: 'merge',
      id: 'merge-step',
      name: 'Merge to main',
      targetBranch: 'main',
      x: 0,
      y: 0,
      inputs: []
    };

    const now = new Date().toISOString();
    const mockRun: WorkflowRun = {
      runId,
      projectId: 'proj-1',
      workflowId: 'wf-1',
      workflowVersion: 1,
      definition: {
        id: 'wf-1',
        name: 'Delivery Workflow',
        scope: 'project',
        version: 1,
        schemaVersion: 1,
        entryNodeId: 'merge-step',
        createdAt: now,
        updatedAt: now,
        nodes: [node],
        edges: []
      },
      status: 'running',
      schemaVersion: 1,
      startedAt: now,
      events: [],
      nodes: {
        'merge-step': {
          nodeId: 'merge-step',
          outcome: 'running',
          artifacts: [],
          attempts: [{ attempt: 1, startedAt: now, outcome: 'running' }]
        }
      },
      gateDecisions: []
    };

    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
    const outcome = await runWorkflowMerge(node, { run: mockRun }, repo, evidenceRoot);

    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.exitCode, 0);

    // Verify feature.txt is now in main
    assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true);
    assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'new feature work\n');
  } finally {
    cleanup();
  }
});

test('runWorkflowMerge detects conflicts and aborts cleanly when onConflict is fail', async () => {
  const { repo, cleanup } = setupRepo();
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const runId = 'deadbeef12345678';
    const branchName = `WF-DEADBEEF`;

    // Create delivery branch modifying README
    git('checkout', '-b', branchName);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Feature edit\n');
    git('add', 'README.md');
    git('commit', '-m', 'Feature edit');

    // Main also modifies README
    git('checkout', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Conflicting main edit\n');
    git('add', 'README.md');
    git('commit', '-m', 'Main edit');

    const node: WorkflowMergeNode = {
      type: 'merge',
      id: 'merge-step',
      name: 'Merge to main',
      targetBranch: 'main',
      onConflict: 'fail',
      x: 0,
      y: 0,
      inputs: []
    };

    const now = new Date().toISOString();
    const mockRun: WorkflowRun = {
      runId,
      projectId: 'proj-1',
      workflowId: 'wf-1',
      workflowVersion: 1,
      definition: {
        id: 'wf-1',
        name: 'Delivery Workflow',
        scope: 'project',
        version: 1,
        schemaVersion: 1,
        entryNodeId: 'merge-step',
        createdAt: now,
        updatedAt: now,
        nodes: [node],
        edges: []
      },
      status: 'running',
      schemaVersion: 1,
      startedAt: now,
      events: [],
      nodes: {
        'merge-step': {
          nodeId: 'merge-step',
          outcome: 'running',
          artifacts: [],
          attempts: [{ attempt: 1, startedAt: now, outcome: 'running' }]
        }
      },
      gateDecisions: []
    };

    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
    const outcome = await runWorkflowMerge(node, { run: mockRun }, repo, evidenceRoot);

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /conflict/i);

    // Verify merge was aborted cleanly (no uncommitted conflicts left in repo)
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally {
    cleanup();
  }
});
