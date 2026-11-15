import test from 'node:test';
import assert from 'node:assert/strict';
import { stripCommandQuery, filterStripCommands, applyStripCommand, estimateStripTokens, stripToolsExpanded } from '../src/ai/commandStrip.ts';

const commands = [
  { name: '/plan', description: 'Switch to plan mode' },
  { name: 'compact', description: 'Compact the context' },
  { name: '/model', description: 'Pick a model' }
];

test('palette opens only for a bare /word draft', () => {
  assert.equal(stripCommandQuery('/'), '');
  assert.equal(stripCommandQuery('/pl'), 'pl');
  assert.equal(stripCommandQuery('/plan '), undefined);
  assert.equal(stripCommandQuery('run /plan'), undefined);
  assert.equal(stripCommandQuery('hello'), undefined);
});

test('filtering is prefix-based and slash-tolerant on both sides', () => {
  assert.deepEqual(filterStripCommands(commands, 'pl').map(c => c.name), ['/plan']);
  assert.deepEqual(filterStripCommands(commands, '/m').map(c => c.name), ['/model']);
  assert.equal(filterStripCommands(commands, '').length, 3);
  assert.deepEqual(filterStripCommands(commands, 'zz'), []);
});

test('picking a command produces plain prompt text with a trailing space', () => {
  assert.equal(applyStripCommand('/plan'), '/plan ');
  assert.equal(applyStripCommand('compact'), '/compact ');
});

test('token estimate matches the mockup and is zero when empty', () => {
  assert.equal(estimateStripTokens(''), 0);
  assert.equal(estimateStripTokens('abcd'), 1);
  assert.equal(estimateStripTokens('abcde'), 2);
});

test('tools row expands for a real draft but never beside the palette', () => {
  assert.equal(stripToolsExpanded(''), false);
  assert.equal(stripToolsExpanded('   '), false);
  assert.equal(stripToolsExpanded('/plan'), false);
  assert.equal(stripToolsExpanded('/plan do the thing'), true);
  assert.equal(stripToolsExpanded('hello'), true);
});
