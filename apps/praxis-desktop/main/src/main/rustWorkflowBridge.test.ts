import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowSchedule,
  type WorkflowRunStatus,
  createWorkflowRun,
  applyWorkflowRunCommand,
  scheduleWorkflowRun,
  advanceJoins,
  deriveRunStatus
} from '@praxis/core';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';

function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-workflow-parity-'));
  const bridge = new RustHostBridge({
    transport: new StdioRustHostTransport({
      userDataDir: dir,
      settingsPath: path.join(dir, 'settings.json')
    })
  });
  t.after(async () => {
    await bridge.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bridge };
}

const sampleWorkflow: WorkflowDefinition = {
  schemaVersion: 1,
  id: 'delivery-pipeline',
  name: 'Delivery Pipeline',
  scope: 'global',
  version: 1,
  entryNodeId: 'build',
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  nodes: [
    {
      type: 'check',
      id: 'build',
      name: 'Build',
      x: 0,
      y: 0,
      inputs: [],
      command: 'npm run build',
      outputs: []
    },
    {
      type: 'check',
      id: 'test',
      name: 'Unit Tests',
      x: 200,
      y: 0,
      inputs: [],
      command: 'npm test',
      outputs: []
    },
    {
      type: 'approval',
      id: 'approval',
      name: 'Release Gate',
      x: 400,
      y: 0,
      inputs: [],
      prompt: 'Approve release',
      requiredGates: ['qa'],
      allowBypass: true
    }
  ],
  edges: [
    { id: 'e1', from: 'build', to: 'test', on: 'success', required: true },
    { id: 'e2', from: 'test', to: 'approval', on: 'success', required: true }
  ]
};

test('Rust workflow bridge: createRun and applyCommand parity', async t => {
  const { bridge } = setup(t);

  const input = {
    runId: 'run-001',
    projectId: 'proj-alpha',
    definition: sampleWorkflow,
    at: '2026-11-09T10:00:00.000Z'
  };

  const tsRun = createWorkflowRun(input);
  const rustRun = await bridge.invoke<WorkflowRun>('workflows:createRun', input);

  assert.equal(rustRun.runId, tsRun.runId);
  assert.equal(rustRun.projectId, tsRun.projectId);
  assert.equal(rustRun.status, tsRun.status);
  assert.deepEqual(Object.keys(rustRun.nodes), Object.keys(tsRun.nodes));

  // Test applyCommand: node-started
  const startCmd = {
    kind: 'node-started' as const,
    nodeId: 'build',
    at: '2026-11-09T10:01:00.000Z',
    sessionId: 'session-build-1'
  };

  const tsStarted = applyWorkflowRunCommand(tsRun, startCmd);
  const rustStarted = await bridge.invoke<WorkflowRun>('workflows:applyCommand', rustRun, startCmd);

  assert.equal(rustStarted.status, tsStarted.status);
  assert.equal(rustStarted.nodes['build'].outcome, tsStarted.nodes['build'].outcome);

  // Test applyCommand: node-failed and canRetry
  const failCmd = {
    kind: 'node-failed' as const,
    nodeId: 'build',
    at: '2026-11-09T10:02:00.000Z',
    error: 'Compilation error'
  };
  const rustFailed = await bridge.invoke<WorkflowRun>('workflows:applyCommand', rustStarted, failCmd);
  const canRetry = await bridge.invoke<boolean>('workflows:canRetry', rustFailed, 'build');
  assert.equal(typeof canRetry, 'boolean');
});

test('Rust workflow bridge: schedule, advanceJoins, and deriveStatus', async t => {
  const { bridge } = setup(t);

  const run = createWorkflowRun({
    runId: 'run-002',
    projectId: 'proj-beta',
    definition: sampleWorkflow,
    at: '2026-11-09T10:00:00.000Z'
  });

  const tsSchedule = scheduleWorkflowRun(run);
  const rustSchedule = await bridge.invoke<WorkflowSchedule>('workflows:schedule', run);

  assert.deepEqual(rustSchedule.ready, tsSchedule.ready);

  const tsAdvanced = advanceJoins(run, '2026-11-09T10:02:00.000Z');
  const rustAdvanced = await bridge.invoke<WorkflowRun>('workflows:advanceJoins', run, '2026-11-09T10:02:00.000Z');

  assert.equal(rustAdvanced.status, tsAdvanced.status);

  const tsStatus = deriveRunStatus(run);
  const rustStatus = await bridge.invoke<WorkflowRunStatus>('workflows:deriveStatus', run);

  assert.equal(rustStatus, tsStatus);
});

test('Rust workflow bridge: cronNext and cronOverdue scheduling calculations', async t => {
  const { bridge } = setup(t);

  const next = await bridge.invoke<string | null>(
    'workflows:cronNext',
    '0 12 * * *',
    'UTC',
    '2026-11-09T10:00:00.000Z'
  );
  assert.ok(next);
  assert.equal(next, '2026-11-09T12:00:00.000Z');

  const overdue = await bridge.invoke<string[]>(
    'workflows:cronOverdue',
    '0 12 * * *',
    'UTC',
    '2026-11-07T12:00:00.000Z',
    '2026-11-09T13:00:00.000Z'
  );
  assert.ok(Array.isArray(overdue));
  assert.equal(overdue.length, 2);
  assert.deepEqual(overdue, [
    '2026-11-08T12:00:00.000Z',
    '2026-11-09T12:00:00.000Z'
  ]);
});
