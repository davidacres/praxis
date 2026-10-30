import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promptCheckFailure, promptCheckDiagnostic } from './promptClarityDiagnostics';

test('distinguishes response validation from provider, timeout and local storage failures', () => {
  assert.match(promptCheckDiagnostic('response-validation', new Error('Ungrounded evidence for target.')), /invalid clarity assessment.*Ungrounded evidence for target/);
  assert.match(promptCheckFailure('provider-request', new Error('HTTP 401')), /authentication/);
  assert.match(promptCheckFailure('provider-request', new Error('HTTP 429')), /Rate limit reached/);
  assert.match(promptCheckFailure('provider-request', new DOMException('aborted', 'TimeoutError')), /Analysis unavailable/);
  assert.match(promptCheckFailure('provider-request', new Error('fetch failed')), /Analysis unavailable/);
  assert.match(promptCheckFailure('cache-write', new Error('ENOSPC')), /disk space/);
});

test('does not expose model replies or arbitrary provider payloads in diagnostic reasons', () => {
  const sensitive = 'private prompt and credential';
  for (const stage of ['provider-request', 'response-validation', 'cache-write'] as const) {
    assert.ok(!promptCheckFailure(stage, new SyntaxError(sensitive)).includes(sensitive));
  }
});


test('composer errors use concise copy and provider-specific authentication recovery', () => {
  const timeout = new Error('Analysis cancelled'); timeout.name = 'AnalysisCancelledError';
  assert.equal(promptCheckFailure('provider-request', timeout), 'Analysis unavailable. Please retry.');
  assert.equal(promptCheckFailure('provider-request', new Error('HTTP 429')), 'Rate limit reached.');
  assert.match(promptCheckFailure('provider-request', new Error('Authentication required'), true), /CLI agent and sign in/);
  assert.match(promptCheckFailure('provider-request', new Error('HTTP 401')), /Update its API key/);
});
