import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEventSummary } from '../ai/agentTypes';
import type { AiUsageEvent } from '../ai/aiUsageLog';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun, type WorkflowRunEvent } from '../workflows/workflowRun';
import { summarizeWorkflowRun } from '../workflows/workflowRunSummary';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowNode } from '../workflows/workflowTypes';
import { createScheduledRun, type ScheduledRun } from './scheduledRun';
import { describeToolEvent, orderedWorkflowStages, scheduledEntryDetail, stageActivityLine } from './scheduledRunDetail';
import { MIN_FORECAST_RUNS, estimateScheduledTicket, forecastScheduledRun } from './scheduledRunForecast';

/*
 * FX-BE-193: what the Spotlight monitor, the Line composer and the run report read
 * about each ticket's workflow — its agent tasks in order (TASK-504), the "now"
 * line (TASK-505) and the forecast (TASK-506).
 */

const agent = (id: string, name: string, y: number, x = 0): WorkflowNode => ({
  id, name, type: 'agent-task', x, y, inputs: [], outputs: [], instructions: name, mutatesWorktree: false,
  agent: { agentId: 'test-agent', scope: 'global', toolMode: 'read-only' }
} as WorkflowNode);
const check = (id: string, name: string, y: number, x = 0): WorkflowNode => ({
  id, name, type: 'check', x, y, inputs: [], outputs: [], command: 'npm', args: ['run', id], successExitCodes: [0]
} as WorkflowNode);

/** The shape of Governed delivery: a join, a parallel security branch, a failure-only repair stage. */
function governed(): WorkflowDefinition {
  const now = '2026-11-01T00:00:00.000Z';
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION, id: 'governed', name: 'Governed delivery', scope: 'project', version: 1,
    entryNodeId: 'plan', createdAt: now, updatedAt: now,
    nodes: [
      // Declared out of order on purpose: the display order comes from the edges.
      agent('review', 'Review', 360),
      agent('plan', 'Plan', 40),
      agent('implement', 'Implement', 200),
      check('install', 'Install', 680, 40),
      check('security', 'Security scan', 680, 280),
      check('qa', 'QA', 840, 40),
      agent('repair', 'Repair QA failures', 1000, 280),
      { id: 'gates', name: 'Gates', type: 'join', x: 160, y: 1160, inputs: [], mode: 'all' } as WorkflowNode,
      { id: 'approve', name: 'Approve', type: 'approval', x: 160, y: 1320, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false } as WorkflowNode
    ],
    edges: [
      { id: 'a', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'b', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'c', from: 'review', to: 'install', on: 'success', required: true },
      { id: 'd', from: 'review', to: 'security', on: 'success', required: true },
      { id: 'e', from: 'install', to: 'qa', on: 'success', required: true },
      { id: 'f', from: 'qa', to: 'repair', on: 'failure', required: false },
      { id: 'g', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'h', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'i', from: 'gates', to: 'approve', on: 'success', required: true },
      { id: 'loop', from: 'review', to: 'implement', on: 'findings', required: true, loop: { maxIterations: 2 } }
    ]
  } as WorkflowDefinition;
}

function started(definition: WorkflowDefinition, runId = 'run-1'): WorkflowRun {
  let run = createWorkflowRun({ runId, projectId: 'p', definition, at: '2026-11-01T22:00:00.000Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'plan', at: '2026-11-01T22:00:00.000Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'plan', artifacts: [], at: '2026-11-01T22:02:00.000Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-11-01T22:02:05.000Z' });
  return run;
}

const usage = (nodeId: string, tokens: number, cost?: number): AiUsageEvent => ({
  id: `${nodeId}-${tokens}`, timestamp: '2026-11-01T22:01:00.000Z', source: 'workflow', workflowRunId: 'run-1', workflowNodeId: nodeId, totalTokens: tokens,
  ...(cost !== undefined ? { cost: { amount: cost, currency: 'USD' } } : {})
} as unknown as AiUsageEvent);

test('agent tasks are shown in run order, without the join, and a repair step only once it has run', () => {
  const names = orderedWorkflowStages(governed()).map(node => node.name);
  assert.deepEqual(names, ['Plan', 'Implement', 'Review', 'Install', 'Security scan', 'QA', 'Approve']);
  const withRepair = orderedWorkflowStages(governed(), nodeId => nodeId === 'repair').map(node => node.name);
  assert.ok(withRepair.includes('Repair QA failures'));
  assert.ok(!withRepair.includes('Gates'));
});

test('an entry lists every agent task with its state, time, tokens and the running task\'s start', () => {
  const run = started(governed());
  const summary = summarizeWorkflowRun(run);
  const detail = scheduledEntryDetail({ entryId: 'e1', run, summary, usage: [usage('plan', 1200, 0.4), usage('plan', 300, 0.1), usage('implement', 5000)] });
  assert.equal(detail.workflowRunId, 'run-1');
  const plan = detail.stages.find(stage => stage.nodeId === 'plan')!;
  assert.equal(plan.lane, 'done');
  assert.equal(plan.durationMs, 120000);
  assert.equal(plan.totalMs, 120000);
  assert.equal(plan.tokens, 1500);
  assert.equal(plan.cost, 0.5);
  const implement = detail.stages.find(stage => stage.nodeId === 'implement')!;
  assert.equal(implement.lane, 'running');
  assert.equal(implement.startedAt, '2026-11-01T22:02:05.000Z');
  assert.equal(implement.durationMs, undefined);
  // A stage nothing was recorded against carries no tokens, not 0.
  const review = detail.stages.find(stage => stage.nodeId === 'review')!;
  assert.equal(review.tokens, undefined);
  assert.equal(review.attempts, 0);
});

test('two entries in two lanes each keep their own tasks', () => {
  const one = started(governed(), 'run-1');
  const two = createWorkflowRun({ runId: 'run-2', projectId: 'p', definition: governed(), at: '2026-11-01T22:00:00.000Z' });
  const a = scheduledEntryDetail({ entryId: 'a', run: one, summary: summarizeWorkflowRun(one), usage: [] });
  const b = scheduledEntryDetail({ entryId: 'b', run: two, summary: summarizeWorkflowRun(two), usage: [] });
  assert.equal(a.stages.find(stage => stage.nodeId === 'implement')!.lane, 'running');
  assert.notEqual(b.stages.find(stage => stage.nodeId === 'implement')!.lane, 'running');
});

test('a failed stage keeps its error and attempt count', () => {
  let run = started(governed());
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', error: 'The stage session was aborted.', at: '2026-11-01T22:05:00.000Z' });
  const implement = scheduledEntryDetail({ entryId: 'e', run, summary: summarizeWorkflowRun(run), usage: [] }).stages.find(stage => stage.nodeId === 'implement')!;
  assert.equal(implement.lane, 'failed');
  assert.equal(implement.lastError, 'The stage session was aborted.');
  assert.equal(implement.attempts, 1);
});

test('the running agent task\'s "now" line comes from its session\'s latest tool call', () => {
  const run = started(governed());
  const events: AgentEventSummary[] = [
    { timestamp: '2026-11-01T22:00:30.000Z', type: 'tool_start', summary: 'Running tool', data: { kind: 'read', args: { path: 'old.ts' } } },
    { timestamp: '2026-11-01T22:03:00.000Z', type: 'tool_start', summary: 'Running tool: write_file', data: { kind: 'write', fileChanges: [{ path: 'src/turnCoordinator.ts' }] } as never }
  ];
  const summary = summarizeWorkflowRun(run);
  // No session recorded for the stage: nothing to read, so no line.
  const without = scheduledEntryDetail({ entryId: 'e', run, summary, usage: [], sessionEvents: () => events });
  assert.equal(without.stages.find(stage => stage.nodeId === 'implement')!.activity, undefined);
  // With its session key, the latest tool call of this attempt is the line; the older read is ignored.
  const asked: string[] = [];
  const withSession = { ...summary, stages: summary.stages.map(stage => stage.nodeId === 'implement' ? { ...stage, sessionKey: 'run-1:implement' } : stage) };
  const detail = scheduledEntryDetail({ entryId: 'e', run, summary: withSession, usage: [], sessionEvents: key => { asked.push(key); return events; } });
  assert.deepEqual(asked, ['run-1:implement']);
  assert.deepEqual(detail.stages.find(stage => stage.nodeId === 'implement')!.activity, { text: 'Editing src/turnCoordinator.ts', at: '2026-11-01T22:03:00.000Z', source: 'tool' });
});

const row = (over: Partial<Parameters<typeof stageActivityLine>[0]>) => ({ nodeId: 'n', type: 'agent-task' as const, lane: 'running' as const, startedAt: '2026-11-01T22:00:00.000Z', ...over });
const event = (at: string, message: string, nodeId = 'n'): WorkflowRunEvent => ({ id: at, at, kind: 'node-progress', nodeId, message });

test('the "now" line: a check shows its command, or its own progress message', () => {
  assert.deepEqual(stageActivityLine(row({ type: 'check', command: 'npm run test:desktop:smoke' }), []), { text: 'npm run test:desktop:smoke', at: '2026-11-01T22:00:00.000Z', source: 'command' });
  assert.equal(stageActivityLine(row({ type: 'check', command: 'npm ci' }), [event('2026-11-01T22:00:05.000Z', 'Installing dependencies')])?.text, 'Installing dependencies');
});

test('the "now" line: progress for this attempt only, the newer of progress and tool wins, paused shows why', () => {
  const stale = event('2026-11-01T21:59:00.000Z', 'From the previous attempt');
  assert.equal(stageActivityLine(row({}), [stale]), undefined);
  const tool: AgentEventSummary = { timestamp: '2026-11-01T22:01:00.000Z', type: 'tool_start', summary: 'x', data: { kind: 'shell', argsSummary: 'npm test' } };
  assert.equal(stageActivityLine(row({}), [event('2026-11-01T22:00:30.000Z', 'Older progress')], [tool])?.text, 'Running npm test');
  assert.equal(stageActivityLine(row({}), [event('2026-11-01T22:02:00.000Z', 'Newer progress')], [tool])?.text, 'Newer progress');
  assert.deepEqual(stageActivityLine(row({ lane: 'paused', lastError: 'This project has no "lint" script.' }), []), { text: 'This project has no "lint" script.', source: 'pause' });
  assert.equal(stageActivityLine(row({ lane: 'done' }), [event('2026-11-01T22:02:00.000Z', 'Done')]), undefined);
});

test('the "now" line is one line of at most 120 characters', () => {
  const long = `Editing ${'a/'.repeat(100)}file.ts`;
  const text = stageActivityLine(row({}), [event('2026-11-01T22:00:05.000Z', `${long}\nsecond line`)])!.text;
  assert.ok(text.length <= 120);
  assert.ok(!text.includes('\n'));
  assert.ok(text.endsWith('…'));
});

test('tool calls read as plain verbs', () => {
  const tool = (data: AgentEventSummary['data'], summary = 'Running tool'): AgentEventSummary => ({ timestamp: 't', type: 'tool_start', summary, data });
  assert.equal(describeToolEvent(tool({ kind: 'read', args: { file_path: 'a.ts' } })), 'Reading a.ts');
  assert.equal(describeToolEvent(tool({ kind: 'search', argsSummary: 'turnCoordinator' })), 'Searching turnCoordinator');
  assert.equal(describeToolEvent(tool({ toolName: 'Skill', argsSummary: 'praxis-test-contracts' })), 'Skill: praxis-test-contracts');
  assert.equal(describeToolEvent(tool(undefined, 'Running subagent')), 'Running subagent');
  assert.equal(describeToolEvent({ timestamp: 't', type: 'message', summary: 'hi' }), undefined);
});

// ── Forecast (TASK-506) ────────────────────────────────────────────────

function finishedRun(runId: string, seconds: Record<string, number>): WorkflowRun {
  const definition = governed();
  let run = createWorkflowRun({ runId, projectId: 'p', definition, at: '2026-10-01T00:00:00.000Z' });
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  for (const nodeId of ['plan', 'implement', 'review', 'install', 'security', 'qa']) {
    const s = seconds[nodeId] ?? 10;
    run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId, at: new Date(clock).toISOString() });
    clock += s * 1000;
    run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId, artifacts: [], at: new Date(clock).toISOString() });
  }
  return { ...run, status: 'succeeded' };
}

const history = [
  finishedRun('h1', { plan: 100, implement: 200, review: 40, install: 10, security: 5, qa: 300 }),
  finishedRun('h2', { plan: 120, implement: 260, review: 50, install: 12, security: 5, qa: 320 }),
  finishedRun('h3', { plan: 140, implement: 900, review: 60, install: 14, security: 5, qa: 340 })
];
const cost = (runId: string, amount: number): AiUsageEvent => ({ id: runId, timestamp: 't', source: 'workflow', workflowRunId: runId, cost: { amount, currency: 'USD' } } as unknown as AiUsageEvent);

test('a ticket estimate needs enough finished runs of the same workflow', () => {
  assert.deepEqual(estimateScheduledTicket(governed(), history.slice(0, MIN_FORECAST_RUNS - 1), []), { basedOnRuns: 2 });
  const other = history.map(run => ({ ...run, workflowId: 'something-else' }));
  assert.equal(estimateScheduledTicket(governed(), other, []).basedOnRuns, 0);
});

test('a ticket takes its stages\' median times along the longest path, and costs what earlier runs cost', () => {
  const estimate = estimateScheduledTicket(governed(), history, [cost('h1', 3), cost('h2', 4), cost('h2', 0.5), cost('h3', 6)]);
  // plan 120 + implement 260 + review 50 + max(install 12 + qa 320, security 5) = 762
  assert.equal(estimate.durationSec?.likely, 762);
  assert.ok(estimate.durationSec!.slow >= 762);
  assert.deepEqual(estimate.spend, { likely: 4.5, low: 4.5, high: 6, currency: 'USD' });
  assert.equal(estimate.basedOnRuns, 3);
});

function schedule(steps: string[][], lanes = 1): ScheduledRun {
  const tickets = steps.flat().map(key => ({ connectionId: 'c', issueKey: key, title: key }));
  const withPrevious = steps.flatMap(step => step.slice(1).map(key => `c\u0000${key}`));
  return createScheduledRun({ name: 'Night', scheduledStartAt: '2026-11-03T22:00:00.000Z', timezone: 'UTC', tickets, withPrevious, maxConcurrency: lanes, at: '2026-11-02T10:00:00.000Z' });
}
const estimate = { durationSec: { likely: 600, slow: 1200 }, spend: { likely: 4, low: 3, high: 7, currency: 'USD' }, basedOnRuns: 5 };

test('a sequential schedule runs one ticket after another from its start time', () => {
  const run = schedule([['A'], ['B'], ['C']]);
  const forecast = forecastScheduledRun(run, estimate, governed(), '2026-11-02T12:00:00.000Z');
  assert.equal(forecast.likelyFinishAt, '2026-11-03T22:30:00.000Z');
  assert.equal(forecast.slowFinishAt, '2026-11-03T23:00:00.000Z');
  assert.deepEqual(forecast.entries.map(entry => entry.startAt.slice(11, 16)), ['22:00', '22:10', '22:20']);
  assert.deepEqual(forecast.spend, { likely: 12, low: 9, high: 21, currency: 'USD' });
  assert.deepEqual(forecast.stages.map(stage => stage.name), ['Plan', 'Implement', 'Review', 'Install', 'Security scan', 'QA', 'Approve']);
});

test('lanes run a step side by side, and the next step waits for all of it', () => {
  const run = schedule([['A', 'B', 'C'], ['D']], 2);
  const forecast = forecastScheduledRun(run, estimate, governed(), '2026-11-02T12:00:00.000Z');
  const by = new Map(forecast.entries.map(entry => [run.entries.find(item => item.id === entry.entryId)!.ticket.issueKey, entry] as const));
  assert.equal(by.get('A')!.startAt.slice(11, 16), '22:00');
  assert.equal(by.get('B')!.startAt.slice(11, 16), '22:00');
  assert.equal(by.get('C')!.startAt.slice(11, 16), '22:10');
  assert.notEqual(by.get('A')!.lane, by.get('B')!.lane);
  assert.equal(by.get('D')!.startAt.slice(11, 16), '22:20');
  assert.equal(forecast.likelyFinishAt, '2026-11-03T22:30:00.000Z');
});

test('a run already going keeps what happened and forecasts the rest from now', () => {
  const run = schedule([['A'], ['B'], ['C']]);
  run.status = 'running';
  run.attempts = [{ id: 'x', trigger: 'schedule', startedAt: '2026-11-03T22:00:00.000Z' }];
  run.entries[0].outcome = { status: 'done', startedAt: '2026-11-03T22:00:00.000Z', endedAt: '2026-11-03T22:25:00.000Z', spend: { cost: 5, currency: 'USD' } };
  // Running well past its estimate: it is given a tenth of the estimate still to go, never a negative.
  run.entries[1].outcome = { status: 'running', startedAt: '2026-11-03T22:25:00.000Z' };
  const forecast = forecastScheduledRun(run, estimate, governed(), '2026-11-03T22:45:00.000Z');
  const [a, b, c] = forecast.entries;
  assert.equal(a.state, 'done');
  assert.equal(a.endAt, '2026-11-03T22:25:00.000Z');
  assert.equal(b.state, 'running');
  assert.equal(b.endAt, '2026-11-03T22:46:00.000Z');
  assert.equal(c.state, 'waiting');
  assert.equal(c.startAt, '2026-11-03T22:46:00.000Z');
  assert.equal(forecast.likelyFinishAt, '2026-11-03T22:56:00.000Z');
  // Finished tickets count what they reported; the rest the per-ticket estimate.
  assert.equal(forecast.spend?.likely, 5 + 2 * 4);
});

test('with nothing measured there is no time forecast, and it says why', () => {
  const forecast = forecastScheduledRun(schedule([['A']]), { basedOnRuns: 1 }, governed(), '2026-11-02T12:00:00.000Z');
  assert.equal(forecast.likelyFinishAt, undefined);
  assert.equal(forecast.entries.length, 0);
  assert.match(forecast.notEstimable ?? '', /Needs 3 finished runs of this workflow to forecast; 1 so far/);
  assert.equal(forecast.stages.length, 7);
});
