import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_PERSONAS, parseAssistantMention, TEAM_REVIEW_ORDER } from './assistantPersonas';
import { parseAssistantReply, runAssistantTurn, runTeamReview, serializePageContext, MAX_CONTEXT_CHARS, type AssistantCompletion } from './assistantEngine';
import { TeamChatStore } from './teamChatStore';
import type { PageAssistantContext } from './assistantTypes';

const context: PageAssistantContext = { pageType: 'issue', title: 'Issue PRX-1', summary: 'Login bug', data: 'details' };

function recorder(reply = 'ok') {
  const calls: Array<{ systemPrompt: string; userPrompt: string; allowMutations: boolean }> = [];
  const complete: AssistantCompletion = async input => { calls.push(input); return reply; };
  return { calls, complete };
}

test('persona registry is complete with prompts and icons', () => {
  assert.deepEqual(ASSISTANT_PERSONAS.map(p => p.id).sort(), ['dev', 'lead', 'product', 'qa', 'security']);
  for (const persona of ASSISTANT_PERSONAS) {
    assert.ok(persona.systemPrompt.length > 50);
    assert.ok(persona.icon && persona.name && persona.badge);
  }
});

test('mentions match leading and embedded tokens, not email-like text', () => {
  assert.equal(parseAssistantMention('@qa what to test?').personaId, 'qa');
  assert.equal(parseAssistantMention('ask @Security about this').personaId, 'security');
  assert.equal(parseAssistantMention('mail a@dev.com').personaId, undefined);
  assert.equal(parseAssistantMention('plain').personaId, undefined);
});

test('a turn routes to the mentioned persona and injects page context', async () => {
  const { calls, complete } = recorder();
  const result = await runAssistantTurn({ message: '@qa edge cases?', context }, complete);
  assert.equal(result.messages[0].role, 'qa');
  assert.match(calls[0].systemPrompt, /QA SPECIALIST/);
  assert.match(calls[0].userPrompt, /\[Current Page Context: Issue PRX-1\]/);
});

test('a turn defaults to the lead and honours the selected persona', async () => {
  assert.equal((await runAssistantTurn({ message: 'hi' }, recorder().complete)).messages[0].role, 'lead');
  assert.equal((await runAssistantTurn({ message: 'hi', personaId: 'dev' }, recorder().complete)).messages[0].role, 'dev');
});

test('oversized page context is truncated, not thrown', () => {
  const block = serializePageContext({ ...context, data: 'x'.repeat(MAX_CONTEXT_CHARS * 3) });
  assert.ok(block.length < MAX_CONTEXT_CHARS + 500);
  assert.match(block, /truncated/);
});

test('a provider error becomes an error message, not a rejection', async () => {
  const result = await runAssistantTurn({ message: 'hi' }, async () => { throw new Error('No API key'); });
  assert.equal(result.messages[0].error, true);
  assert.match(result.messages[0].text, /No API key/);
});

test('an empty message is rejected', async () => {
  await assert.rejects(runAssistantTurn({ message: '   ' }, recorder().complete), /Ask the team/);
});

test('team review runs dev, qa, security then lead, each seeing earlier replies', async () => {
  const calls: string[] = [];
  let n = 0;
  const result = await runTeamReview({ context }, async input => { calls.push(input.userPrompt); n += 1; return `reply ${n}`; });
  assert.deepEqual(result.messages.map(m => m.role), [...TEAM_REVIEW_ORDER]);
  assert.match(calls[3], /Senior Dev: reply 1/);
  assert.match(calls[3], /Security Engineer: reply 3/);
});

test('team review stops at the first failure', async () => {
  let n = 0;
  const result = await runTeamReview({}, async () => { n += 1; if (n === 2) throw new Error('boom'); return 'ok'; });
  assert.deepEqual(result.messages.map(m => m.role), ['dev', 'qa']);
  assert.equal(result.messages[1].error, true);
});

test('reply footer yields choices and actions; a bad footer is ignored', () => {
  const footer = '```praxis-assistant\n{"choices":[{"label":"Go","prompt":"do it"}],"action":{"kind":"delegate-session","label":"Open","summary":"s","prompt":"p"}}\n```';
  const parsed = parseAssistantReply(`Answer\n${footer}`);
  assert.equal(parsed.text, 'Answer');
  assert.equal(parsed.choices?.[0].label, 'Go');
  assert.equal(parsed.proposedAction?.kind, 'delegate-session');
  assert.equal(parseAssistantReply('Answer\n```praxis-assistant\nnot json\n```').text, 'Answer');
});

test('a workflow proposal is dropped outside the workflow page', async () => {
  const reply = 'x\n```praxis-assistant\n{"action":{"kind":"update-workflow","label":"A","summary":"s","workflow":{"id":"w"}}}\n```';
  const off = await runAssistantTurn({ message: 'hi', context }, recorder(reply).complete);
  assert.equal(off.messages[0].proposedAction, undefined);
  const on = await runAssistantTurn({ message: 'hi', context: { ...context, pageType: 'workflow' } }, recorder(reply).complete);
  assert.equal(on.messages[0].proposedAction?.kind, 'update-workflow');
});

test('team chat store persists, titles from the first message, renames and deletes', async () => {
  const data: Record<string, unknown> = {};
  const store = new TeamChatStore({ get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => { data[k] = v; } } as never);
  const chat = await store.create('p1', 'PRX-1');
  await store.create('p2');
  await store.saveMessages(chat.id, [{ id: '1', role: 'user', text: 'Review the login flow', createdAt: 'x' }, { id: '2', role: 'qa', text: 'ok', createdAt: 'y' }]);
  const [summary] = store.list('p1');
  assert.equal(summary.title, 'Review the login flow');
  assert.deepEqual(summary.personas, ['qa']);
  assert.equal(store.list('p1').length, 1);
  await store.rename(chat.id, 'Login review');
  assert.equal(store.get(chat.id)?.title, 'Login review');
  await store.remove(chat.id);
  assert.equal(store.list('p1').length, 0);
});
