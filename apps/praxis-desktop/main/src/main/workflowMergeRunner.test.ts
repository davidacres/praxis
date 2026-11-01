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

// ── Out-of-scope changes (FX-BE-094 / TASK-265) ───────────────────────────

function runFor(node: WorkflowMergeNode, runId: string): WorkflowRun {
  const now = new Date().toISOString();
  return {
    runId,
    projectId: 'proj-1',
    workflowId: 'wf-1',
    workflowVersion: 1,
    definition: { id: 'wf-1', name: 'Delivery Workflow', scope: 'project', version: 1, schemaVersion: 1, entryNodeId: node.id, createdAt: now, updatedAt: now, nodes: [node], edges: [] },
    status: 'running',
    schemaVersion: 1,
    startedAt: now,
    events: [],
    nodes: { [node.id]: { nodeId: node.id, outcome: 'running', artifacts: [], attempts: [{ attempt: 1, startedAt: now, outcome: 'running' }] } },
    gateDecisions: []
  } as WorkflowRun;
}

function branchTouching(repo: string, branch: string, files: string[]): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('checkout', '-b', branch);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), `${file}\n`);
  }
  git('add', '-A');
  git('commit', '-m', 'run work');
  git('checkout', 'main');
}

test('an undeclared change is held back from the merge under a block policy', async () => {
  const { repo, cleanup } = setupRepo();
  try {
    branchTouching(repo, 'WF-SCOPE001', ['src/pay/card.ts', 'src/auth.ts']);
    const node: WorkflowMergeNode = { type: 'merge', id: 'merge-step', name: 'Merge', targetBranch: 'main', declaredPaths: ['src/pay'], outOfScope: 'block', x: 0, y: 0, inputs: [] };
    const outcome = await runWorkflowMerge(node, { run: runFor(node, 'scope0010000000') }, repo, fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')));
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /Held back: 1 changed path outside what this session claimed \(src\/auth\.ts\)/);
    assert.deepEqual(outcome.findings?.findings.map(finding => [finding.file, finding.severity]), [['src/auth.ts', 'high']]);
    assert.equal(fs.existsSync(path.join(repo, 'src/pay/card.ts')), false, 'nothing merged');
  } finally {
    cleanup();
  }
});

test('an undeclared change is merged but flagged under the default escalate policy; in-scope work merges quietly', async () => {
  const { repo, cleanup } = setupRepo();
  try {
    branchTouching(repo, 'WF-SCOPE002', ['src/pay/card.ts', 'package.json']);
    const node: WorkflowMergeNode = { type: 'merge', id: 'merge-step', name: 'Merge', targetBranch: 'main', declaredPaths: ['src/pay'], x: 0, y: 0, inputs: [] };
    const escalated = await runWorkflowMerge(node, { run: runFor(node, 'scope0020000000') }, repo, fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')));
    assert.equal(escalated.status, 'succeeded');
    assert.deepEqual(escalated.findings?.findings.map(finding => [finding.file, finding.ruleId, finding.severity]), [['package.json', 'out-of-scope-change', 'medium']]);

    branchTouching(repo, 'WF-SCOPE003', ['src/pay/refund.ts']);
    const quiet = await runWorkflowMerge(node, { run: runFor(node, 'scope0030000000') }, repo, fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')));
    assert.equal(quiet.status, 'succeeded');
    assert.equal(quiet.findings, undefined);
  } finally {
    cleanup();
  }
});

test('Praxis metadata in the base checkout does not block a merge, but real uncommitted work still does', async () => {
  const { repo, cleanup } = setupRepo();
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    const runId = 'feed1234ef567890';
    git('checkout', '-b', 'WF-FEED1234');
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'work\n');
    git('add', 'feature.txt');
    git('commit', '-m', 'Add feature');
    git('checkout', 'main');
    const node: WorkflowMergeNode = { type: 'merge', id: 'merge', name: 'Merge', targetBranch: 'main', x: 0, y: 0, inputs: [], onConflict: 'fail' };
    const now = new Date().toISOString();
    const run = {
      runId, projectId: 'p', workflowId: 'wf', workflowVersion: 1, status: 'running', schemaVersion: 1, startedAt: now, events: [], gateDecisions: [],
      definition: { id: 'wf', name: 'W', scope: 'project', version: 1, schemaVersion: 1, entryNodeId: 'merge', createdAt: now, updatedAt: now, nodes: [node], edges: [] },
      nodes: { merge: { nodeId: 'merge', outcome: 'running', artifacts: [], attempts: [{ attempt: 1, startedAt: now, outcome: 'running' }] } }
    } as unknown as WorkflowRun;
    const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));

    // A tracked file with uncommitted edits is work the merge could lose: refused.
    fs.writeFileSync(path.join(repo, 'README.md'), '# Edited\n');
    const refused = await runWorkflowMerge(node, { run }, repo, evidenceRoot);
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /uncommitted changes/);
    git('checkout', '--', 'README.md');

    // Praxis's own files, uncommitted, are not: the merge goes ahead.
    fs.mkdirSync(path.join(repo, '.praxis', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.praxis', 'workflows', 'wf.json'), '{}');
    fs.writeFileSync(path.join(repo, 'project.praxis.md'), '# Brief\n');
    const merged = await runWorkflowMerge(node, { run }, repo, evidenceRoot);
    assert.equal(merged.status, 'succeeded', merged.error);
    assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true);
  } finally {
    cleanup();
  }
});

// ── AI conflict resolution ────────────────────────────────────────────────

/** main and the run's branch (checked out in its own worktree) both rewrite README.md. */
function conflictingRun(): { repo: string; worktree: string; branch: string; cleanup: () => void } {
  const { repo, cleanup } = setupRepo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const branch = 'WF-C0FFEE12-notes';
  git('checkout', '-b', branch);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Main\nRun line\n');
  git('commit', '-am', 'Run edit');
  git('checkout', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Main\nMain line\n');
  git('commit', '-am', 'Main edit');
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-merge-wt-'));
  fs.rmSync(worktree, { recursive: true });
  git('worktree', 'add', worktree, branch);
  return { repo, worktree, branch, cleanup: () => { fs.rmSync(worktree, { recursive: true, force: true }); cleanup(); } };
}

const aiNode: WorkflowMergeNode = { type: 'merge', id: 'merge', name: 'Merge to main', targetBranch: 'main', onConflict: 'ai-resolve', x: 0, y: 0, inputs: [] };

test('ai-resolve settles the conflict on the run branch, then merges cleanly into main', async () => {
  const { repo, worktree, branch, cleanup } = conflictingRun();
  try {
    const asked: string[][] = [];
    const outcome = await runWorkflowMerge(
      aiNode,
      { run: runFor(aiNode, 'c0ffee1234567890'), worktreePath: worktree },
      repo,
      fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')),
      async ({ worktreePath, files }) => {
        asked.push(files);
        // While the resolver works, main itself is not left half-merged.
        assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
        assert.match(fs.readFileSync(path.join(worktreePath, 'README.md'), 'utf8'), /<<<<<<< /);
        fs.writeFileSync(path.join(worktreePath, 'README.md'), '# Main\nMain line\nRun line\n');
        execFileSync('git', ['add', 'README.md'], { cwd: worktreePath });
        return { ok: true };
      }
    );
    assert.equal(outcome.status, 'succeeded', outcome.error);
    assert.deepEqual(asked, [['README.md']]);
    assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), '# Main\nMain line\nRun line\n');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
    // The resolution is on the run's branch, so the delivered history shows it.
    assert.match(execFileSync('git', ['log', '--format=%s', branch], { cwd: repo, encoding: 'utf8' }), /Merge main into the run branch to resolve conflicts/);
  } finally {
    cleanup();
  }
});

test('ai-resolve that leaves conflict markers is refused: main untouched, run branch put back', async () => {
  const { repo, worktree, branch, cleanup } = conflictingRun();
  try {
    const mainBefore = execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim();
    const branchBefore = execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim();
    const outcome = await runWorkflowMerge(
      aiNode,
      { run: runFor(aiNode, 'c0ffee1234567890'), worktreePath: worktree },
      repo,
      fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')),
      // Claims success but only stages the file, markers and all.
      async ({ worktreePath }) => {
        execFileSync('git', ['add', 'README.md'], { cwd: worktreePath });
        return { ok: true };
      }
    );
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /AI resolution did not settle it: Conflict markers were left in README\.md\./);
    assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim(), mainBefore);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
    assert.equal(execFileSync('git', ['rev-parse', branch], { cwd: repo, encoding: 'utf8' }).trim(), branchBefore);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).trim(), '');
  } finally {
    cleanup();
  }
});

test('ai-resolve with no resolver available fails and names why, leaving main clean', async () => {
  const { repo, worktree, cleanup } = conflictingRun();
  try {
    const outcome = await runWorkflowMerge(aiNode, { run: runFor(aiNode, 'c0ffee1234567890'), worktreePath: worktree }, repo, fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-')));
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /AI resolution could not start/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
  } finally {
    cleanup();
  }
});
