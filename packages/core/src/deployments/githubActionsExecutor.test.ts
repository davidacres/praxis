import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubActionsDeploymentExecutor,
  GitHubActionsDispatchError,
  parseDeclaredInputs,
  validateDispatchRequest,
  type WorkflowDispatchInputDeclaration
} from './githubActionsExecutor';
import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';

function config(overrides?: Partial<GitHubActionsConfig>): GitHubActionsConfig {
  return { baseUrl: 'https://api.github.com', owner: 'acme', repo: 'demo', token: 'ghp-test', ...overrides };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

// ── listWorkflows ────────────────────────────────────────────────────────

test('listWorkflows normalizes id/name/path/state, including disabled workflows', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      workflows: [
        { id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' },
        { id: 2, name: 'Legacy deploy', path: '.github/workflows/legacy.yml', state: 'disabled_manually' }
      ]
    });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  const workflows = await executor.listWorkflows();
  assert.equal(workflows.length, 2);
  assert.deepEqual(workflows[1], { id: 2, name: 'Legacy deploy', path: '.github/workflows/legacy.yml', state: 'disabled_manually' });
});

// ── getDeclaredInputs / parseDeclaredInputs ─────────────────────────────

test('getDeclaredInputs fetches, base64-decodes, and parses a real workflow_dispatch input block', async () => {
  const yaml = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      environment:',
    '        description: Environment to deploy to',
    '        required: true',
    '        type: choice',
    '        options:',
    '          - staging',
    '          - production',
    '      version:',
    '        required: false',
    '        default: latest'
  ].join('\n');
  const fakeFetch: typeof fetch = async () => jsonResponse({ content: Buffer.from(yaml).toString('base64'), encoding: 'base64' });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  const inputs = await executor.getDeclaredInputs('.github/workflows/deploy.yml');
  assert.deepEqual(inputs, [
    { name: 'environment', description: 'Environment to deploy to', required: true, type: 'choice', options: ['staging', 'production'] },
    { name: 'version', required: false, default: 'latest', type: 'string' }
  ]);
});

test('parseDeclaredInputs returns no inputs for a workflow with no workflow_dispatch trigger', () => {
  assert.deepEqual(parseDeclaredInputs('on: push\n', 'x.yml'), []);
  assert.deepEqual(parseDeclaredInputs('on:\n  - push\n  - workflow_dispatch\n', 'x.yml'), [], 'array form declares no inputs even though it lists workflow_dispatch');
  assert.deepEqual(parseDeclaredInputs('on:\n  push: {}\n', 'x.yml'), []);
});

test('parseDeclaredInputs returns no inputs for workflow_dispatch declared with no config', () => {
  assert.deepEqual(parseDeclaredInputs('on:\n  workflow_dispatch:\n', 'x.yml'), []);
});

test('parseDeclaredInputs rejects unparsable YAML with a clear error rather than silently returning nothing', () => {
  assert.throws(() => parseDeclaredInputs('on: [unclosed', 'broken.yml'), /Could not parse "broken.yml"/);
});

// ── dispatchWorkflow: success carries no run id ─────────────────────────

test('a successful dispatch returns only a timestamp — never a run id, since GitHub does not give one', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  };
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  const result = await executor.dispatchWorkflow({ workflowId: 1, ref: 'main', inputs: { environment: 'staging' } });
  assert.ok(result.dispatchedAt);
  assert.deepEqual(Object.keys(result), ['dispatchedAt']);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/demo/actions/workflows/1/dispatches');
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { environment: 'staging' } });
});

// ── dispatchWorkflow: GitHub-refused failures are classified ────────────

test('an invalid workflow (404) is classified as invalid-workflow', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 999, ref: 'main', inputs: {} }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubActionsDispatchError);
      assert.equal(error.kind, 'invalid-workflow');
      assert.equal(error.status, 404);
      return true;
    }
  );
});

test('an unprocessable ref/inputs (422) is classified as invalid-workflow', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Unprocessable"}', { status: 422 });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 1, ref: 'no-such-branch', inputs: {} }),
    (error: unknown) => error instanceof GitHubActionsDispatchError && error.kind === 'invalid-workflow'
  );
});

test('insufficient permission (403, no rate-limit signal) is classified as insufficient-permission', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Forbidden"}', { status: 403 });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 1, ref: 'main', inputs: {} }),
    (error: unknown) => error instanceof GitHubActionsDispatchError && error.kind === 'insufficient-permission'
  );
});

test('a rate limit signalled via 403 + X-RateLimit-Remaining: 0 is classified as rate-limited, not insufficient-permission', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 1, ref: 'main', inputs: {} }),
    (error: unknown) => error instanceof GitHubActionsDispatchError && error.kind === 'rate-limited'
  );
});

test('a plain 429 is classified as rate-limited', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Too Many Requests"}', { status: 429 });
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 1, ref: 'main', inputs: {} }),
    (error: unknown) => error instanceof GitHubActionsDispatchError && error.kind === 'rate-limited'
  );
});

// ── dispatchWorkflow: a lost dispatch response is never swallowed ───────

test('a network-level failure during dispatch propagates unchanged — never mistaken for a confirmed refusal', async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error('socket hang up');
  };
  const executor = new GitHubActionsDeploymentExecutor(config(), fakeFetch);
  await assert.rejects(
    () => executor.dispatchWorkflow({ workflowId: 1, ref: 'main', inputs: {} }),
    (error: unknown) => error instanceof Error && !(error instanceof GitHubActionsDispatchError) && error.message === 'socket hang up'
  );
});

// ── validateDispatchRequest ──────────────────────────────────────────────

const ENV_INPUT: WorkflowDispatchInputDeclaration = {
  name: 'environment',
  required: true,
  type: 'choice',
  options: ['staging', 'production']
};
const TOKEN_INPUT: WorkflowDispatchInputDeclaration = { name: 'correlation_token', required: false, type: 'string' };

test('a missing ref is refused', () => {
  const issues = validateDispatchRequest({ declaredInputs: [], ref: '', inputs: {} });
  assert.ok(issues.some(issue => issue.path === 'ref'));
});

test('a missing required input is refused', () => {
  const issues = validateDispatchRequest({ declaredInputs: [ENV_INPUT], ref: 'main', inputs: {} });
  assert.ok(issues.some(issue => issue.path === 'inputs.environment'));
});

test('a value outside a declared choice input\'s options is refused', () => {
  const issues = validateDispatchRequest({ declaredInputs: [ENV_INPUT], ref: 'main', inputs: { environment: 'sandbox' } });
  assert.ok(issues.some(issue => issue.path === 'inputs.environment' && /not one of the declared options/.test(issue.message)));
});

test('an input the workflow never declared is refused rather than silently dispatched', () => {
  const issues = validateDispatchRequest({ declaredInputs: [ENV_INPUT], ref: 'main', inputs: { environment: 'staging', mystery: 'x' } });
  assert.ok(issues.some(issue => issue.path === 'inputs.mystery'));
});

test('a well-formed request with every required input satisfied has no issues', () => {
  const issues = validateDispatchRequest({ declaredInputs: [ENV_INPUT], ref: 'main', inputs: { environment: 'staging' } });
  assert.deepEqual(issues, []);
});

test('a correlation input that is not declared by the workflow is refused', () => {
  const issues = validateDispatchRequest({
    declaredInputs: [ENV_INPUT],
    ref: 'main',
    inputs: { environment: 'staging' },
    correlationInputName: 'correlation_token'
  });
  assert.ok(issues.some(issue => issue.path === 'correlationInputName'));
});

test('a declared correlation input with no supplied value is refused — dispatching without it would lose the ability to identify the run afterward', () => {
  const issues = validateDispatchRequest({
    declaredInputs: [ENV_INPUT, TOKEN_INPUT],
    ref: 'main',
    inputs: { environment: 'staging' },
    correlationInputName: 'correlation_token'
  });
  assert.ok(issues.some(issue => issue.path === 'inputs.correlation_token'));
});

test('a correlation input that is declared and supplied has no issue', () => {
  const issues = validateDispatchRequest({
    declaredInputs: [ENV_INPUT, TOKEN_INPUT],
    ref: 'main',
    inputs: { environment: 'staging', correlation_token: 'abc123' },
    correlationInputName: 'correlation_token'
  });
  assert.deepEqual(issues, []);
});
