import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicThinkingBudget, anthropicThinkingConfig, anthropicThinkingMode, detectReasoningFamily, geminiThinkingBudget, reasoningAvailability, supportsReasoningEffort } from './reasoningSupport';

test('detects reasoning family from the model id regardless of which provider is routing it', () => {
  // The registry's actual default models — see PROVIDER_DESCRIPTORS.
  assert.equal(detectReasoningFamily('anthropic/claude-sonnet-4.6'), 'anthropic'); // vercel-gateway's default
  assert.equal(detectReasoningFamily('claude-sonnet-4-6'), 'anthropic'); // anthropic's own default
  assert.equal(detectReasoningFamily('gemini-2.5-flash'), 'gemini'); // gemini's default
  assert.equal(detectReasoningFamily('gpt-4o-mini'), undefined); // openai's default — not a reasoning model
  assert.equal(detectReasoningFamily('glm-5.3'), undefined); // z-ai's default
  assert.equal(detectReasoningFamily('o3'), 'openai');
  assert.equal(detectReasoningFamily('gpt-5.1'), 'openai');
  // GPT-6 reasoning models take OpenAI's shape too. They never return reasoning
  // *text* over HTTP, but they do accept `reasoning_effort` and do report a
  // reasoning token count — which is the only evidence thinking happened.
  assert.equal(detectReasoningFamily('gpt-6-luna'), 'openai');
  assert.equal(detectReasoningFamily('gpt-6-codex'), 'openai');
  assert.equal(detectReasoningFamily(undefined), undefined);
});

test('maps every Claude generation to the thinking mode its API accepts', () => {
  // Claude 4.7+ reject `type: 'enabled'` with a 400 error, so they need adaptive.
  // Anthropic's per-model table names these aliases explicitly.
  assert.equal(anthropicThinkingMode('claude-fable-5.1'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-mythos-5.1'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-sonnet-5'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-sonnet-5.5'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-opus-5.5'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-haiku-5.5'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-opus-4-8'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-opus-4-7'), 'adaptive');
  // 4.6 accepts both; adaptive is the recommended one.
  assert.equal(anthropicThinkingMode('claude-opus-4-6'), 'adaptive');
  assert.equal(anthropicThinkingMode('claude-sonnet-4-6'), 'adaptive');
  // 4.5 and earlier reject `type: 'adaptive'`, so they must keep extended.
  assert.equal(anthropicThinkingMode('claude-opus-4-5'), 'extended');
  assert.equal(anthropicThinkingMode('claude-sonnet-4-5'), 'extended');
  assert.equal(anthropicThinkingMode('claude-haiku-4-5'), 'extended');
  assert.equal(anthropicThinkingMode('claude-3-7-sonnet'), 'extended');
  // The provider prefix a gateway adds must not change the answer.
  assert.equal(anthropicThinkingMode('anthropic/claude-fable-5.1'), 'adaptive');
  // Non-Claude and unrecognizable ids get no mode, so no thinking parameter is
  // sent — guessing wrong is a 400 error either way.
  assert.equal(anthropicThinkingMode('gpt-6-luna'), undefined);
  assert.equal(anthropicThinkingMode('claude-internal-preview'), undefined);
  assert.equal(anthropicThinkingMode(undefined), undefined);
});

test('adaptive thinking always asks for summarized display', () => {
  // On Claude 4.7+ `display` defaults to 'omitted': the request succeeds, the
  // reasoning tokens are billed, and the thinking field comes back empty. The
  // chat pane would show nothing, so the opt-in has to be explicit.
  for (const level of ['low', 'medium', 'high'] as const) {
    const config = anthropicThinkingConfig('claude-fable-5.1', level);
    assert.deepEqual(config?.thinking, { type: 'adaptive', display: 'summarized' }, level);
    assert.deepEqual(config?.outputConfig, { effort: level }, level);
  }
});

test('extended thinking keeps its token budget and no output_config', () => {
  const config = anthropicThinkingConfig('claude-sonnet-4-5', 'high');
  assert.deepEqual(config?.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.equal(config?.outputConfig, undefined);
});

test('thinking stays opt-in: off sends nothing on either mode', () => {
  // Claude 4.6-4.8 default to thinking *off*, so sending them a thinking
  // parameter at 'off' would silently switch reasoning on.
  assert.equal(anthropicThinkingConfig('claude-opus-4-6', 'off'), undefined);
  assert.equal(anthropicThinkingConfig('claude-fable-5.1', 'off'), undefined);
  assert.equal(anthropicThinkingConfig('claude-sonnet-4-5', 'off'), undefined);
  assert.equal(anthropicThinkingConfig('claude-fable-5.1', undefined), undefined);
  assert.equal(anthropicThinkingConfig('claude-internal-preview', 'high'), undefined);
});

test('supportsReasoningEffort exposes every selectable provider model', () => {
  assert.equal(supportsReasoningEffort('vercel-gateway', 'anthropic/claude-sonnet-4.6'), true);
  assert.equal(supportsReasoningEffort('anthropic', 'claude-sonnet-4-6'), true);
  assert.equal(supportsReasoningEffort('gemini', 'gemini-2.5-flash'), true);
  assert.equal(supportsReasoningEffort('openai', 'gpt-4o-mini'), true);
  assert.equal(supportsReasoningEffort('z-ai', 'glm-5.3'), true);
  assert.equal(supportsReasoningEffort('codex-cli', 'gpt-5.6-codex'), true);
  assert.equal(supportsReasoningEffort('openai', undefined), true);
  assert.equal(supportsReasoningEffort(undefined, 'gpt-5.1'), false);
});

test('thinking budgets scale with level and are undefined for off', () => {
  assert.equal(anthropicThinkingBudget('off'), undefined);
  assert.equal(anthropicThinkingBudget(undefined), undefined);
  assert.equal(anthropicThinkingBudget('low'), 1024);
  assert.equal(anthropicThinkingBudget('medium'), 4096);
  assert.equal(anthropicThinkingBudget('high'), 8192);
  assert.equal(geminiThinkingBudget('off'), undefined);
  assert.equal(geminiThinkingBudget('high'), 8192);
});

test('reasoning availability depends on the route, not the model id', () => {
  // The same GPT-6 model returns reasoning through a CLI agent and none
  // through OpenAI's own HTTP endpoint — which is why the id alone can't say.
  assert.equal(reasoningAvailability('codex-cli', 'gpt-6-luna', 'high'), 'text');
  assert.equal(reasoningAvailability('openai', 'gpt-6-luna', 'high'), 'opaque');
  // A non-reasoning model over HTTP has nothing to hide; absence is just absence.
  assert.equal(reasoningAvailability('openai', 'gpt-4o-mini', 'high'), 'text');
  assert.equal(reasoningAvailability('anthropic', 'claude-fable-5.1', 'high'), 'text');
  assert.equal(reasoningAvailability('z-ai', 'glm-5.3', 'high'), 'text');
});

test('reasoning is reported as not-requested when the session opted out', () => {
  assert.equal(reasoningAvailability('anthropic', 'claude-fable-5.1', 'off'), 'not-requested');
  assert.equal(reasoningAvailability('openai', 'gpt-6-luna', 'off'), 'not-requested');
  // `undefined` is the unset slider, which the hosts resolve to a real level
  // (per-model default, then 'medium') — so reasoning *is* requested.
  assert.equal(reasoningAvailability('anthropic', 'claude-fable-5.1', undefined), 'text');
  assert.equal(reasoningAvailability('openai', 'gpt-6-luna', undefined), 'opaque');
  // A CLI agent still relays thinking when the level is unset: the host, not
  // Praxis, decides whether it thinks.
  assert.equal(reasoningAvailability('claude-code-cli', 'claude-fable-5.1', undefined), 'text');
});
