import assert from 'node:assert/strict';
import test from 'node:test';
import { splitCssLayers } from '../src/settings/cssLayerList.ts';

test('splits multi-layer SVG data URLs only at the comma between layers', () => {
  const first = 'url("data:image/svg+xml,%3Csvg%3E%3Cpath%20d%3D%22M0%2C0%22%2F%3E%3C%2Fsvg%3E")';
  const second = 'url("data:image/svg+xml,%3Csvg%3E%3Ccircle%20cx%3D%221%22%2F%3E%3C%2Fsvg%3E")';
  assert.deepEqual(splitCssLayers(`${first}, ${second}`), [first, second]);
});

test('also splits ordinary comma-separated surface values', () => {
  assert.deepEqual(splitCssLayers('right top, left bottom'), ['right top', 'left bottom']);
  assert.deepEqual(splitCssLayers('760px 760px, 760px 760px'), ['760px 760px', '760px 760px']);
});
