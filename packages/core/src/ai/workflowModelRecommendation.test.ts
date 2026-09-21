import test from 'node:test';
import assert from 'node:assert/strict';
import { governedDeliveryTemplate } from '../workflows/workflowTemplates';
import { isAgentTaskNode } from '../workflows/workflowTypes';
import { parseTierSuggestions, recommendModelTiers } from './workflowModelRecommendation';

const definition = governedDeliveryTemplate();
const agents = definition.nodes.filter(isAgentTaskNode);

test('a valid answer is used verbatim and marked as not defaulted', () => {
  const text = '```json\n' + JSON.stringify({ stages: Object.fromEntries(agents.map(n => [n.id, { tier: 'fast', rationale: 'simple' }])) }) + '\n```';
  const result = parseTierSuggestions(text, definition);
  assert.deepEqual(Object.keys(result).sort(), agents.map(n => n.id).sort());
  assert.ok(Object.values(result).every(s => s.tier === 'fast' && !s.defaulted && s.rationale === 'simple'));
});

test('a stage the model omits or mislabels gets the deterministic default, so the answer is always complete', () => {
  const [first, second] = agents;
  const text = JSON.stringify({ stages: { [first.id]: { tier: 'ultra', rationale: 'x' }, unknown: { tier: 'fast' } } });
  const result = parseTierSuggestions(text, definition);
  assert.equal(result[first.id].defaulted, true);
  assert.equal(result[second.id].defaulted, true);
  assert.equal(result.unknown, undefined, 'ids that are not stages are ignored');
});

test('non-JSON or a missing stages object is rejected', () => {
  assert.throws(() => parseTierSuggestions('nope', definition), /not valid JSON/);
  assert.throws(() => parseTierSuggestions('{"a":1}', definition), /"stages" object/);
});

test('recommendModelTiers runs one prompt through the runner and reports its model', async () => {
  let calls = 0;
  const result = await recommendModelTiers(definition, {
    provider: 'vercel-gateway',
    promptRunner: async prompt => {
      calls += 1;
      assert.ok(agents.every(n => prompt.includes(n.id)), 'every agent stage is in the prompt');
      return { text: JSON.stringify({ stages: {} }), model: 'test-model' };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.model, 'test-model');
  assert.equal(Object.keys(result.stages).length, agents.length);
});

test('a workflow with no agent stages is refused before any call', async () => {
  const noAgents = { ...definition, nodes: definition.nodes.filter(n => !isAgentTaskNode(n)) };
  await assert.rejects(() => recommendModelTiers(noAgents, { provider: 'vercel-gateway', promptRunner: async () => { throw new Error('should not run'); } }), /no agent stages/);
});
