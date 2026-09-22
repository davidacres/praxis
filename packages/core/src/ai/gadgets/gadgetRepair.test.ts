import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatBlocks } from './blockParser';
import { parseLenientJson, repairJsonStrings } from './jsonRepair';
import { coerceGadgetBlock } from './validation';

const OPTIONS = {
  scope: { hostId: 'host-1', sessionId: 'session-1', workId: 'APP-1' },
  issuedAt: '2026-09-22T10:00:00.000Z',
  idPrefix: 'msg-0'
};

const choice = (description: string) => ({
  version: 1,
  kind: 'choice',
  gadgetId: 'review-findings',
  payload: {
    question: 'Which of these should go into the ticket?',
    multiple: true,
    options: [{ value: 'f1', label: 'Restore missing sections', description }]
  },
  actions: [{ actionId: 'apply-selected', label: 'Continue with selected', effect: 'informational' }]
});

test('strict JSON is left exactly as parsed', () => {
  const result = parseLenientJson('{"a":"say \\"hi\\"","b":[1,2]}');
  assert.deepEqual(result, { ok: true, value: { a: 'say "hi"', b: [1, 2] }, repaired: false });
});

test('an unescaped quote inside a string is repaired to the text the model meant', () => {
  const broken = '{"description":"a "System One LLM wrapper" for Python, and ("gives up string generation"); done"}';
  assert.throws(() => JSON.parse(broken));
  const result = parseLenientJson(broken);
  assert.ok(result.ok && result.repaired);
  assert.deepEqual((result as { value: unknown }).value, {
    description: 'a "System One LLM wrapper" for Python, and ("gives up string generation"); done'
  });
});

test('a raw newline or tab inside a string is escaped, and structure outside strings is untouched', () => {
  const result = parseLenientJson('{\n  "a": "line one\nline two\tend",\n  "b": true\n}');
  assert.ok(result.ok && result.repaired);
  assert.deepEqual((result as { value: unknown }).value, { a: 'line one\nline two\tend', b: true });
});

test('a valid escape sequence is never double-escaped', () => {
  assert.equal(repairJsonStrings('{"a":"x\\ny \\"q\\" z"}'), '{"a":"x\\ny \\"q\\" z"}');
});

test('broken structure is still refused, not guessed at', () => {
  assert.equal(parseLenientJson('{"a": ').ok, false);
  assert.equal(parseLenientJson('{ not json at all').ok, false);
});

test('a fence glued to the end of a sentence still becomes a gadget, and the sentence survives', () => {
  const text = `Here is the one actionable finding.\`\`\`praxis-gadget\n${JSON.stringify(choice('short'))}\n\`\`\``;
  const parsed = parseChatBlocks(text, OPTIONS);
  assert.equal(parsed.malformed, 0);
  assert.equal(parsed.blocks.map(block => block.type).join(','), 'markdown,gadget');
  assert.equal((parsed.blocks[0] as { markdown: string }).markdown, 'Here is the one actionable finding.');
});

test('a closing fence glued to the JSON still closes the block', () => {
  const text = `\`\`\`praxis-gadget\n${JSON.stringify(choice('short'))}\`\`\``;
  const parsed = parseChatBlocks(text, OPTIONS);
  assert.equal(parsed.blocks.filter(block => block.type === 'gadget').length, 1);
});

test('a triple backtick inside a JSON string does not end the block early', () => {
  const text = `\`\`\`praxis-gadget\n${JSON.stringify(choice('Add a ```bash\nnpm test\n``` step to the description.'))}\n\`\`\``;
  const parsed = parseChatBlocks(text, OPTIONS);
  assert.equal(parsed.malformed, 0);
  const block = parsed.blocks.find(candidate => candidate.type === 'gadget') as { gadget: { payload: { options: { description: string }[] } } };
  assert.ok(block.gadget.payload.options[0].description.includes('```bash'));
});

test('the reported failure — glued fence, unescaped quotes and an over-long description — renders as a gadget', () => {
  // Shape of the review that came back as raw text: prose running straight into
  // the fence, `"System One LLM wrapper"` unescaped inside a string, and a
  // description far past the 2000-character field limit.
  const long = 'x'.repeat(3_500);
  const json = JSON.stringify(choice(`Access: a "System One LLM wrapper" for Python. ${long}`))
    .replace('\\"System One LLM wrapper\\"', '"System One LLM wrapper"');
  assert.throws(() => JSON.parse(json), 'the fixture really is invalid JSON');
  const text = `Here's the one actionable finding.\`\`\`praxis-gadget\n${json}\n\`\`\``;

  const parsed = parseChatBlocks(text, OPTIONS);
  const raw = parsed.blocks.find(block => block.type === 'gadget') as { blockId: string; gadget: unknown } | undefined;
  assert.ok(raw, 'the fence was found and its JSON repaired');

  const coerced = coerceGadgetBlock(raw.gadget, raw.blockId);
  assert.equal(coerced.type, 'gadget', coerced.type === 'fallback' ? coerced.reason?.message : '');
  const description = (coerced as { gadget: { payload: { options: { description: string }[] } } }).gadget.payload.options[0].description;
  assert.ok(description.length <= 2_000, 'clamped to the field limit');
  assert.ok(description.endsWith('…'));
  assert.ok(description.startsWith('Access: a "System One LLM wrapper" for Python.'));
});

test('an option that is already within its limits is not altered', () => {
  const parsed = parseChatBlocks(`\`\`\`praxis-gadget\n${JSON.stringify(choice('exactly this'))}\n\`\`\``, OPTIONS);
  const block = parsed.blocks.find(candidate => candidate.type === 'gadget') as { gadget: { payload: { options: { description: string }[] } } };
  assert.equal(block.gadget.payload.options[0].description, 'exactly this');
});
