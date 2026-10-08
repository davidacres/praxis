import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseIndependentStage, chooseStageModel, defaultTierForStage, escalateTier } from './stageModel';

const tiers = { gw: { fast: 'small', standard: 'mid', strong: 'big' } };

test('an exact stage model beats tiers and the run model', () => {
  const choice = chooseStageModel({ node: { model: 'exact', modelTier: 'fast' }, provider: 'gw', tiers, runModel: 'run', attemptsSpent: 0 });
  assert.equal(choice.model, 'exact');
});

test('a tier resolves through the provider mapping', () => {
  assert.equal(chooseStageModel({ node: { modelTier: 'fast' }, provider: 'gw', tiers, runModel: 'run', attemptsSpent: 0 }).model, 'small');
});

test('an unmapped tier falls back to the run model instead of guessing an id', () => {
  const choice = chooseStageModel({ node: { modelTier: 'fast' }, provider: 'other', tiers, runModel: 'run', attemptsSpent: 0 });
  assert.equal(choice.model, 'run');
  assert.match(choice.reason, /no model is mapped/);
  assert.equal(chooseStageModel({ node: { modelTier: 'fast' }, provider: 'other', tiers, attemptsSpent: 0 }).model, undefined);
});

test('no tier and no exact model uses the run model, then the provider default', () => {
  assert.equal(chooseStageModel({ node: {}, provider: 'gw', tiers, runModel: 'run', attemptsSpent: 3 }).model, 'run');
  assert.equal(chooseStageModel({ node: {}, provider: 'gw', tiers, attemptsSpent: 0 }).model, undefined);
});

test('each spent attempt moves one tier up, capped at strong', () => {
  const at = (attemptsSpent: number) => chooseStageModel({ node: { modelTier: 'fast' }, provider: 'gw', tiers, attemptsSpent });
  assert.equal(at(0).model, 'small');
  assert.equal(at(1).model, 'mid');
  assert.match(at(1).reason, /raised from fast after 1 failed attempt/);
  assert.equal(at(2).model, 'big');
  assert.equal(at(5).model, 'big');
  assert.equal(escalateTier('strong', 3), 'strong');
});

test('escalation can be turned off per stage', () => {
  const choice = chooseStageModel({ node: { modelTier: 'fast', escalateOnRetry: false }, provider: 'gw', tiers, attemptsSpent: 2 });
  assert.equal(choice.model, 'small');
});

test('default tiers follow what the stage does', () => {
  assert.equal(defaultTierForStage({ name: 'Implement', mutatesWorktree: true }), 'strong');
  assert.equal(defaultTierForStage({ name: 'Review', mutatesWorktree: false, satisfiesGate: 'review' }), 'standard');
  assert.equal(defaultTierForStage({ name: 'Summary', mutatesWorktree: false }), 'fast');
});

// ── Independent verification (FX-BE-164 / TASK-427) ─────────────────────────

test('chooseIndependentStage: a different provider is independent as it stands', () => {
  const choice = chooseIndependentStage({ provider: 'openai', author: { name: 'Implement', provider: 'claude' }, chosenByPerson: false, usableProviders: ['openai', 'claude'] });
  assert.equal(choice.provider, 'openai');
  assert.equal(choice.independent, true);
});

test('chooseIndependentStage: on the author\'s provider, it moves to another set-up provider with that provider\'s tier model', () => {
  const choice = chooseIndependentStage({
    provider: 'claude', model: 'claude-x', author: { name: 'Implement', provider: 'claude', model: 'claude-x' }, chosenByPerson: false,
    usableProviders: ['claude', 'openai'], tiers: { openai: { standard: 'gpt-y' } }, tier: 'standard'
  });
  assert.deepEqual([choice.provider, choice.model, choice.independent], ['openai', 'gpt-y', true]);
  assert.match(choice.reason, /Moved to openai/);
});

test('chooseIndependentStage: with one provider, a different mapped model is used', () => {
  const choice = chooseIndependentStage({
    provider: 'claude', model: 'claude-strong', author: { name: 'Implement', provider: 'claude', model: 'claude-strong' }, chosenByPerson: false,
    usableProviders: ['claude'], tiers: { claude: { strong: 'claude-strong', standard: 'claude-standard' } }
  });
  assert.deepEqual([choice.provider, choice.model, choice.independent], ['claude', 'claude-standard', true]);
});

test('chooseIndependentStage: with one provider and one model it says it is not independent', () => {
  const choice = chooseIndependentStage({ provider: 'claude', author: { name: 'Implement', provider: 'claude' }, chosenByPerson: false, usableProviders: ['claude'] });
  assert.equal(choice.independent, false);
  assert.match(choice.reason, /^Not independent/);
});

test('chooseIndependentStage: a person\'s choice is respected and reported honestly', () => {
  const choice = chooseIndependentStage({ provider: 'claude', author: { name: 'Implement', provider: 'claude' }, chosenByPerson: true, usableProviders: ['claude', 'openai'] });
  assert.deepEqual([choice.provider, choice.independent], ['claude', false]);
});

test('chooseIndependentStage: an author that has not run is nothing to be independent of', () => {
  const choice = chooseIndependentStage({ provider: 'claude', author: { name: 'Implement' }, chosenByPerson: false, usableProviders: ['claude', 'openai'] });
  assert.deepEqual([choice.provider, choice.independent], ['claude', true]);
});
