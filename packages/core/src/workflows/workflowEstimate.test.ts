import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWorkflowRun, MIN_STAGE_SAMPLES, stageUsageSample } from './workflowEstimate';
import { governedDeliveryTemplate } from './workflowTemplates';
import type { AiUsageEvent } from '../ai/aiUsageLog';

function usage(sessions: Array<{ tokens: number; cost?: { amount: number; currency: string } }>): AiUsageEvent[] {
  return sessions.map((session, index) => ({
    id: `e${index}`,
    timestamp: '2026-10-08T00:00:00.000Z',
    source: 'session',
    sessionId: `s${index}`,
    totalTokens: session.tokens,
    workflowRunId: 'run-1',
    workflowNodeId: `node-${index}`,
    ...(session.cost ? { cost: session.cost } : {})
  }));
}

test('governed delivery: the first pass and the worst case with both fix loops spent', () => {
  const estimate = estimateWorkflowRun(governedDeliveryTemplate());
  const byId = new Map(estimate.stages.map(stage => [stage.nodeId, stage]));
  // Implement sits in the review loop (2) and the security loop (1): up to 3 × 2 passes, 2 attempts each.
  assert.equal(byId.get('implement')?.firstPass, 1);
  assert.equal(byId.get('implement')?.worstCase, 12);
  // Plan is upstream of every loop: one pass.
  assert.equal(byId.get('plan')?.worstCase, 1);
  // The QA repair stage runs only when QA fails.
  assert.equal(byId.get('qa-repair-agent')?.firstPass, 0);
  assert.deepEqual(estimate.loops.map(loop => [loop.edgeId, loop.budget]), [['e-review-fix', 2], ['e-security-fix', 1]]);
  assert.equal(estimate.firstPassAgentLaunches, 4);
  assert.ok(estimate.worstCaseAgentLaunches > estimate.firstPassAgentLaunches);
});

test('with too few measured stage sessions there is no token figure, and it says so', () => {
  assert.equal(stageUsageSample(usage([{ tokens: 100 }, { tokens: 200 }])), undefined);
  const estimate = estimateWorkflowRun(governedDeliveryTemplate());
  assert.equal(estimate.tokens, undefined);
  assert.equal(estimate.spend, undefined);
  assert.match(estimate.notEstimable ?? '', new RegExp(`fewer than ${MIN_STAGE_SAMPLES}`));
});

test('a measured range scales by first-pass and worst-case launches; spend only from one reported currency', () => {
  const sample = stageUsageSample(usage([{ tokens: 1000, cost: { amount: 0.1, currency: 'USD' } }, { tokens: 2000, cost: { amount: 0.2, currency: 'USD' } }, { tokens: 4000, cost: { amount: 0.4, currency: 'USD' } }, { tokens: 8000, cost: { amount: 0.8, currency: 'USD' } }]));
  assert.ok(sample);
  assert.equal(sample.sessions, 4);
  const estimate = estimateWorkflowRun(governedDeliveryTemplate(), { usage: sample });
  assert.equal(estimate.tokens?.low, sample.tokens.low * estimate.firstPassAgentLaunches);
  assert.equal(estimate.tokens?.high, sample.tokens.high * estimate.worstCaseAgentLaunches);
  assert.equal(estimate.spend?.currency, 'USD');
  assert.equal(estimate.basedOnSessions, 4);

  const mixed = stageUsageSample(usage([{ tokens: 1000, cost: { amount: 1, currency: 'USD' } }, { tokens: 1000, cost: { amount: 1, currency: 'EUR' } }, { tokens: 1000 }]));
  assert.equal(mixed?.cost, undefined, 'never sums across currencies or fills a gap');
});

test('a run parameter bound to a loop changes the ceiling, and a large one needs a confirm', () => {
  const definition = {
    ...governedDeliveryTemplate(),
    parameters: [{ id: 'reviewRounds', label: 'Review rounds', kind: 'integer' as const, bindsLoopEdge: 'e-review-fix' }]
  };
  const small = estimateWorkflowRun(definition, { parameters: { reviewRounds: 1 } });
  const large = estimateWorkflowRun(definition, { parameters: { reviewRounds: 10 }, threshold: 25 });
  assert.ok(large.worstCaseAgentLaunches > small.worstCaseAgentLaunches);
  assert.equal(large.needsConfirm, true);
});
