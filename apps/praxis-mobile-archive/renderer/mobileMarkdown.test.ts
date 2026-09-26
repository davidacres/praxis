import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineText, isSafeLink, parseBlocks, parseInline } from './mobileMarkdown';

test('headings, paragraphs and rules', () => {
  const blocks = parseBlocks('# Title\n\nFirst line\nsecond line\n\n---\n\n### Small');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'rule', 'heading']);
  assert.equal(blocks[0].type === 'heading' && blocks[0].level, 1);
  assert.equal(blocks[1].type === 'paragraph' && inlineText(blocks[1].children), 'First line\nsecond line');
});

test('fenced code keeps its text and language verbatim, including markdown inside it', () => {
  const [code] = parseBlocks('```ts\nconst a = **b**;\n# not a heading\n```');
  assert.deepEqual(code, { type: 'code', language: 'ts', text: 'const a = **b**;\n# not a heading' });
});

test('an unclosed fence (still streaming) is code to the end', () => {
  const blocks = parseBlocks('Look:\n```\nline 1\nline 2');
  assert.deepEqual(blocks.map(block => block.type), ['paragraph', 'code']);
  assert.equal(blocks[1].type === 'code' && blocks[1].text, 'line 1\nline 2');
});

test('bullet, numbered, task and nested lists', () => {
  const [bullets, numbers] = parseBlocks('- one\n- [x] two\n  - nested\n- three\n\n3. c\n4. d');
  assert.equal(bullets.type, 'list');
  if (bullets.type !== 'list' || numbers.type !== 'list') return;
  assert.equal(bullets.ordered, false);
  assert.deepEqual(bullets.items.map(item => inlineText(item.children)), ['one', 'two', 'three']);
  assert.equal(bullets.items[1].checked, true);
  assert.equal(bullets.items[1].sublist && inlineText(bullets.items[1].sublist.items[0].children), 'nested');
  assert.equal(numbers.ordered, true);
  assert.equal(numbers.start, 3);
});

test('tables with alignment and escaped pipes', () => {
  const [table] = parseBlocks('| File | Lines |\n| :--- | ---: |\n| `a\\|b.ts` | 12 |\n| c.ts | 3 |');
  assert.equal(table.type, 'table');
  if (table.type !== 'table') return;
  assert.deepEqual(table.align, ['left', 'right']);
  assert.equal(inlineText(table.rows[0][0]), 'a|b.ts');
  assert.equal(table.rows.length, 2);
});

test('block quotes hold blocks', () => {
  const [quote] = parseBlocks('> **Note**\n> keep going');
  assert.equal(quote.type, 'quote');
  if (quote.type !== 'quote') return;
  assert.equal(quote.blocks[0].type, 'paragraph');
});

test('inline bold, italic, code, strikethrough and links', () => {
  const spans = parseInline('**bold** and *it* and `x*y` and ~~old~~ [site](https://praxis.dev)');
  assert.deepEqual(spans.map(span => span.type), ['strong', 'text', 'em', 'text', 'code', 'text', 'strike', 'text', 'link']);
  const code = spans[4];
  assert.equal(code.type === 'code' && code.text, 'x*y');
});

test('snake_case and unclosed markers stay as text', () => {
  assert.equal(inlineText(parseInline('call my_long_name now')), 'call my_long_name now');
  assert.deepEqual(parseInline('call my_long_name now').map(span => span.type), ['text']);
  assert.deepEqual(parseInline('2 * 3 = 6').map(span => span.type), ['text']);
});

test('unsafe links become plain text', () => {
  assert.equal(isSafeLink('javascript:alert(1)'), false);
  assert.equal(isSafeLink('https://example.com'), true);
  const spans = parseInline('[click](javascript:alert(1))');
  assert.equal(spans.some(span => span.type === 'link'), false);
});
