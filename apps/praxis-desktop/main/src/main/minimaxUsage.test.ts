import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomProviderConfig } from '@praxis/core';
import { isMiniMaxEndpoint, parseMiniMaxRemains } from './minimaxUsage';

const ENDPOINT = 'custom:minimax' as const;

const payload = {
  base_resp: { status_code: 0, status_msg: 'success' },
  data: {
    current_subscribe_title: 'Token Plan Plus',
    points_balance: '14000',
    model_remains: [
      {
        model_name: 'general',
        current_interval_total_count: 2000,
        // Remaining, not consumed — the naming trap this adapter has to get right.
        current_interval_usage_count: 1500,
        start_time: 1780279200000,
        end_time: 1780297200000,
        current_weekly_total_count: 10000,
        current_weekly_usage_count: 4000,
        weekly_start_time: 1780243200000,
        weekly_end_time: 1780848000000
      }
    ]
  }
};

test('usage counts are read as remaining, so used = total - remaining', () => {
  const snapshot = parseMiniMaxRemains(ENDPOINT, payload);
  assert.equal(snapshot.provider, ENDPOINT);
  assert.equal(snapshot.unavailableReason, undefined);
  const [interval, weekly] = snapshot.windows;
  assert.equal(interval.period, 'hour');
  assert.equal(interval.usedPercent, 25);
  assert.equal(interval.windowDurationMinutes, 300);
  assert.equal(interval.resetsAt, new Date(1780297200000).toISOString());
  assert.equal(weekly.period, 'week');
  assert.equal(weekly.usedPercent, 60);
  assert.equal(weekly.resetsAt, new Date(1780848000000).toISOString());
  assert.deepEqual(snapshot.credits, { remaining: 14000, currency: 'points' });
});

test('remaining percent wins when the counts are absent', () => {
  const snapshot = parseMiniMaxRemains(ENDPOINT, {
    base_resp: { status_code: 0 },
    data: {
      current_subscribe_title: 'Token Plan',
      model_remains: [{
        model_name: 'general',
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: '96',
        current_weekly_remaining_percent: '99',
        end_time: 1780297200000
      }]
    }
  });
  assert.deepEqual(snapshot.windows.map(window => window.usedPercent), [4, 1]);
  assert.equal(snapshot.windows[0].label, 'Token Plan · 5-hour window');
  assert.equal(snapshot.credits, undefined);
});

test('the most consumed model row wins when a plan reports several', () => {
  const snapshot = parseMiniMaxRemains(ENDPOINT, {
    data: {
      model_remains: [
        { model_name: 'idle', current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
        { model_name: 'busy', current_interval_remaining_percent: 40, current_weekly_remaining_percent: 90 }
      ]
    }
  });
  assert.deepEqual(snapshot.windows.map(window => window.usedPercent), [60, 10]);
});

test('an error status and an empty plan are reported, not shown as zero usage', () => {
  const failed = parseMiniMaxRemains(ENDPOINT, { base_resp: { status_code: 1004, status_msg: 'invalid api key' } });
  assert.equal(failed.windows.length, 0);
  assert.match(failed.unavailableReason ?? '', /invalid api key/);

  const empty = parseMiniMaxRemains(ENDPOINT, { base_resp: { status_code: 0 }, data: { model_remains: [] } });
  assert.equal(empty.windows.length, 0);
  assert.match(empty.unavailableReason ?? '', /pay-as-you-go/);

  const garbage = parseMiniMaxRemains(ENDPOINT, 'nope');
  assert.equal(garbage.windows.length, 0);
  assert.match(garbage.unavailableReason ?? '', /could not read/);
});

test('only endpoints created from the minimax preset are treated as MiniMax', () => {
  const minimax = { presetId: 'minimax' } as CustomProviderConfig;
  const openrouter = { presetId: 'openrouter' } as CustomProviderConfig;
  assert.equal(isMiniMaxEndpoint(ENDPOINT, minimax), true);
  assert.equal(isMiniMaxEndpoint(ENDPOINT, openrouter), false);
  assert.equal(isMiniMaxEndpoint(ENDPOINT, undefined), false);
  assert.equal(isMiniMaxEndpoint('openai', undefined), false);
});
