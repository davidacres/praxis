import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseStageModel, defaultTierForStage, escalateTier } from './stageModel';

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
