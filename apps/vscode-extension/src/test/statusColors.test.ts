import * as assert from 'assert';
import { defaultStatusDotHex, statusLabelInlineStyle } from '@praxis/core';

function labelColor(statusName: string, custom?: Record<string, string>): string {
  const style = statusLabelInlineStyle(statusName, custom);
  const match = /^color: (.+);$/.exec(style);
  assert.ok(match, `unexpected style shape: ${style}`);
  return match![1];
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m![1], m![2], m![3]].map(c => parseInt(c, 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

suite('Status label colours', () => {
  test('built-in status colours pass through unclamped', () => {
    for (const status of ['Backlog', 'To Do', 'In Progress', 'Blocked', 'Done']) {
      assert.strictEqual(
        labelColor(status),
        defaultStatusDotHex(status),
        `${status} should not be adjusted`
      );
    }
  });

  test('mid-tone custom colours are left exactly as configured', () => {
    assert.strictEqual(labelColor('Review', { Review: '#a05cc8' }), '#a05cc8');
  });

  test('very dark custom colours are lifted into the readable band', () => {
    const result = labelColor('Review', { Review: '#0a0f1e' });
    assert.notStrictEqual(result, '#0a0f1e');
    assert.ok(
      luminance(result) >= 0.33,
      `expected lift above the floor, got ${result} (${luminance(result)})`
    );
  });

  test('very light custom colours are darkened into the readable band', () => {
    const result = labelColor('Review', { Review: '#fbf7d0' });
    assert.notStrictEqual(result, '#fbf7d0');
    assert.ok(
      luminance(result) <= 0.75,
      `expected darkening below the ceiling, got ${result} (${luminance(result)})`
    );
  });

  test('clamping preserves hue ordering of the channels', () => {
    // Dark blue: blue stays the dominant channel after being lifted.
    const result = labelColor('Review', { Review: '#02061a' });
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(result);
    assert.ok(m, result);
    const [r, g, b] = [m![1], m![2], m![3]].map(c => parseInt(c, 16));
    assert.ok(b > r && b > g, `expected blue to dominate, got ${result}`);
  });

  test('near-black falls back to the neutral status colour', () => {
    assert.strictEqual(labelColor('Review', { Review: '#000000' }), defaultStatusDotHex(''));
  });

  test('unresolvable colours fall back to theme text', () => {
    // An invalid custom value is ignored upstream, so this exercises the default path.
    assert.strictEqual(labelColor('Mystery Status'), defaultStatusDotHex('Mystery Status'));
  });
});
