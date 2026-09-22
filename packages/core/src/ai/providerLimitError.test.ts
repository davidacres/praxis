import test from 'node:test';
import assert from 'node:assert/strict';
import { isProviderLimitError, isLimitNoticeReply, extractProviderLimitMessage } from './providerLimitError';

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
  assert.equal(isProviderLimitError('{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}'), true);
  assert.equal(
    extractProviderLimitMessage('{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}'),
    'Provider limit reached: Insufficient balance or no resource package. Please recharge.'
  );
});

test('isProviderLimitError detects budget limits and Codex usage limits', () => {
  assert.equal(isProviderLimitError('The AI has exceeded its budget'), true);
  assert.equal(isProviderLimitError('exceeded budget'), true);
  assert.equal(isProviderLimitError('out of budget'), true);
  assert.equal(isProviderLimitError('insufficient budget'), true);
  assert.equal(isProviderLimitError('budget limit reached'), true);
  assert.equal(isProviderLimitError('budget exhausted'), true);
  assert.equal(isProviderLimitError('over budget'), true);

  const codexMsg = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:24 PM.\n\n";
  assert.equal(isProviderLimitError(codexMsg), true);
  assert.equal(
    extractProviderLimitMessage(codexMsg),
    "Provider limit reached: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:24 PM."
  );

  const nested = {
    error: {
      message: 'The model has exceeded its budget limit.'
    }
  };
  assert.equal(isProviderLimitError(nested), true);
});

test('isProviderLimitError returns false for normal failures', () => {
  assert.equal(isProviderLimitError('File not found'), false);
  assert.equal(isProviderLimitError('SyntaxError: Unexpected token'), false);
  assert.equal(isProviderLimitError('Connection refused'), false);
  assert.equal(isProviderLimitError(''), false);
  assert.equal(isProviderLimitError(undefined), false);
});

test('GatewayHttpError formats error JSON into a clean user-facing message', async () => {
  const { GatewayHttpError, formatGatewayErrorMessage } = await import('./gateway/gatewayClient.js');
  const body = '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}';
  assert.equal(
    formatGatewayErrorMessage(429, body),
    'Insufficient balance or no resource package. Please recharge. (Code 1113 · HTTP 429)'
  );
  const err = new GatewayHttpError(429, body);
  assert.equal(
    err.message,
    'Insufficient balance or no resource package. Please recharge. (Code 1113 · HTTP 429)'
  );
});

test('isLimitNoticeReply still recognises a CLI agent reporting a hit limit as its reply', () => {
  assert.equal(isLimitNoticeReply("You've hit your session limit · resets 12:50pm (Europe/London)"), true);
  assert.equal(isLimitNoticeReply('Your credit balance is too low to continue'), true);
  assert.equal(isLimitNoticeReply('{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}'), true);
  assert.equal(isLimitNoticeReply('  \n Usage limit reached. Try again later.\n'), true);
});

test('isLimitNoticeReply does not mistake a long answer that discusses limits for a failure', () => {
  // A ticket review whose subject mentions rate limits and quotas: the words
  // match, but it is a multi-paragraph answer that ends in a gadget.
  const review = [
    '## Verdict: Needs work',
    '',
    'The description is truncated. Risks: API shape, auth, rate limits, data retention and training-use terms are undocumented.',
    '',
    '**Stated limits:** maximum cardinality of 255; no image input.',
    '',
    '```praxis-gadget',
    '{"version":1,"kind":"choice","gadgetId":"review-findings"}',
    '```'
  ].join('\n');
  assert.equal(isProviderLimitError(review), true, 'the raw matcher is deliberately broad');
  assert.equal(isLimitNoticeReply(review), false);
  // Length alone is enough: long prose is not a notice even without structure.
  assert.equal(isLimitNoticeReply(`We should add rate limiting to the export endpoint. ${'More detail. '.repeat(60)}`), false);
  // So is a gadget fence in an otherwise short reply.
  assert.equal(isLimitNoticeReply('Add a quota check.\n```praxis-gadget\n{}\n```'), false);
});

test('isLimitNoticeReply ignores empty replies', () => {
  assert.equal(isLimitNoticeReply(''), false);
  assert.equal(isLimitNoticeReply(undefined), false);
});
