import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnabledModelCuration } from '../src/ai/modelProviders';
import type { ModelOptions } from '@praxis/core';

const catalog = (values: string[]): ModelOptions => ({
  options: values.map(value => ({ value, name: value })),
});

test('unset curation offers the whole catalog', () => {
  const options = catalog(['a', 'b', 'c']);
  assert.deepEqual(applyEnabledModelCuration(options, undefined).options.map(o => o.value), ['a', 'b', 'c']);
});

test('curation keeps only enabled models', () => {
  const result = applyEnabledModelCuration(catalog(['a', 'b', 'c']), ['a', 'c']);
  assert.deepEqual(result.options.map(o => o.value), ['a', 'c']);
});

test('an explicit empty list hides everything', () => {
  assert.deepEqual(applyEnabledModelCuration(catalog(['a', 'b']), []).options, []);
});

test('curation preserves other catalog fields', () => {
  const options: ModelOptions = { ...catalog(['a', 'b']), currentValue: 'a' };
  const result = applyEnabledModelCuration(options, ['b']);
  assert.equal(result.currentValue, 'a');
  assert.equal(result.options.length, 1);
});

test('curation does not mutate the source catalog', () => {
  const options = catalog(['a', 'b']);
  applyEnabledModelCuration(options, ['a']);
  assert.equal(options.options.length, 2);
});
