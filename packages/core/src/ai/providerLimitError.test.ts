import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderLimitError, extractProviderLimitMessage } from './providerLimitError';

test('isProviderLimitError detects Claude Code session limits', () => {
  const msg = "Internal error: You've hit your session limit · resets 12:50pm (Europe/London)";
  assert.equal(isProviderLimitError(msg), true);
  assert.equal(
    extractProviderLimitMessage(msg),
    "Provider limit reached: You've hit your session limit · resets 12:50pm (Europe/London)"
  );
});

test('isProviderLimitError detects ACP errorKind rate_limit', () => {
  const error = {
    code: -32603,
    data: { errorKind: 'rate_limit' },
    message: 'Internal error: rate limit'
  };
  assert.equal(isProviderLimitError(error), true);
});

test('isProviderLimitError detects OpenAI and Anthropic quota and credit errors', () => {
  assert.equal(isProviderLimitError('Your credit balance is too low to continue'), true);
  assert.equal(isProviderLimitError('You exceeded your current quota, please check your plan and billing details'), true);
  assert.equal(isProviderLimitError('insufficient_quota'), true);
  assert.equal(isProviderLimitError('rate_limit_error'), true);
  assert.equal(isProviderLimitError('RESOURCE_EXHAUSTED'), true);
  assert.equal(isProviderLimitError('credits exhausted'), true);
  assert.equal(isProviderLimitError('out of credits'), true);
  assert.equal(isProviderLimitError('You have run out of credits for this billing period'), true);
});

test('isProviderLimitError returns false for normal failures', () => {
  assert.equal(isProviderLimitError('File not found'), false);
  assert.equal(isProviderLimitError('SyntaxError: Unexpected token'), false);
  assert.equal(isProviderLimitError('Connection refused'), false);
  assert.equal(isProviderLimitError(''), false);
  assert.equal(isProviderLimitError(undefined), false);
});
