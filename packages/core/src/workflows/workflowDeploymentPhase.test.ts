import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_NODE_PHASE_DEPLOYING,
  DEPLOYMENT_NODE_PHASE_VERIFYING,
  deploymentNodeDisplayPhase,
  deploymentNodeDisplayPhaseLabel
} from './workflowDeploymentPhase';

test('a pending or ready node reads as not started', () => {
  assert.equal(deploymentNodeDisplayPhase('pending', undefined), 'not-started');
  assert.equal(deploymentNodeDisplayPhase('ready', undefined), 'not-started');
});

test('a running node with no reported phase defaults to deploying', () => {
  assert.equal(deploymentNodeDisplayPhase('running', undefined), 'deploying');
});

test('a running node reporting the deploying phase reads as deploying', () => {
  assert.equal(deploymentNodeDisplayPhase('running', DEPLOYMENT_NODE_PHASE_DEPLOYING), 'deploying');
});

test('a running node reporting the verifying phase reads as verifying, not just "running"', () => {
  assert.equal(deploymentNodeDisplayPhase('running', DEPLOYMENT_NODE_PHASE_VERIFYING), 'verifying');
});

test('an unrecognized phase string falls back to deploying rather than surfacing as undefined', () => {
  assert.equal(deploymentNodeDisplayPhase('running', 'some-future-phase'), 'deploying');
});

test('terminal outcomes map straight through, independent of any leftover phase', () => {
  assert.equal(deploymentNodeDisplayPhase('succeeded', DEPLOYMENT_NODE_PHASE_VERIFYING), 'succeeded');
  assert.equal(deploymentNodeDisplayPhase('failed', DEPLOYMENT_NODE_PHASE_DEPLOYING), 'failed');
  assert.equal(deploymentNodeDisplayPhase('skipped', undefined), 'cancelled');
  assert.equal(deploymentNodeDisplayPhase('cancelled', undefined), 'cancelled');
});

test('every display phase has a label', () => {
  const phases = ['not-started', 'deploying', 'verifying', 'succeeded', 'failed', 'cancelled'] as const;
  for (const phase of phases) {
    assert.equal(typeof deploymentNodeDisplayPhaseLabel(phase), 'string');
    assert.notEqual(deploymentNodeDisplayPhaseLabel(phase).length, 0);
  }
});

test('the deploying and verifying labels are visibly distinct from each other and from a generic outcome word', () => {
  assert.equal(deploymentNodeDisplayPhaseLabel('deploying'), 'Deploying');
  assert.equal(deploymentNodeDisplayPhaseLabel('verifying'), 'Verifying');
  assert.notEqual(deploymentNodeDisplayPhaseLabel('deploying'), deploymentNodeDisplayPhaseLabel('verifying'));
});
