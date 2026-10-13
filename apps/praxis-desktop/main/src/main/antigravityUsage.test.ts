import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuotaResponse } from './antigravityUsage';

test('parseQuotaResponse maps groups and buckets into ProviderUsageWindow objects', () => {
  const sampleResponse = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 0.16105285,
              resetTime: '2026-10-14T22:18:03Z'
            },
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remainingFraction: 0.8838056,
              resetTime: '2026-10-13T12:07:57Z'
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1,
              resetTime: '2026-10-19T23:15:17Z'
            },
            {
              bucketId: '3p-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remainingFraction: 1,
              resetTime: '2026-10-13T13:03:36Z'
            }
          ]
        }
      ]
    }
  };

  const snapshot = parseQuotaResponse(sampleResponse, '2026-10-13T09:00:00.000Z');

  assert.equal(snapshot.provider, 'antigravity-cli');
  assert.equal(snapshot.fetchedAt, '2026-10-13T09:00:00.000Z');
  assert.equal(snapshot.windows.length, 4);

  // Check 5h windows
  const gemini5h = snapshot.windows.find(w => w.label === 'Gemini Models (5h)');
  assert.ok(gemini5h);
  assert.equal(gemini5h.period, 'hour');
  assert.equal(gemini5h.windowDurationMinutes, 300);
  assert.equal(gemini5h.usedPercent, 12); // Math.round((1 - 0.8838056) * 100) = 12%
  assert.equal(gemini5h.resetsAt, '2026-10-13T12:07:57Z');

  const geminiWeekly = snapshot.windows.find(w => w.label === 'Gemini Models (Weekly)');
  assert.ok(geminiWeekly);
  assert.equal(geminiWeekly.period, 'week');
  assert.equal(geminiWeekly.windowDurationMinutes, 10080);
  assert.equal(geminiWeekly.usedPercent, 84); // Math.round((1 - 0.16105285) * 100) = 84%
  assert.equal(geminiWeekly.resetsAt, '2026-10-14T22:18:03Z');

  const claude5h = snapshot.windows.find(w => w.label === 'Claude and GPT models (5h)');
  assert.ok(claude5h);
  assert.equal(claude5h.period, 'hour');
  assert.equal(claude5h.usedPercent, 0);

  const claudeWeekly = snapshot.windows.find(w => w.label === 'Claude and GPT models (Weekly)');
  assert.ok(claudeWeekly);
  assert.equal(claudeWeekly.period, 'week');
  assert.equal(claudeWeekly.usedPercent, 0);
});

test('parseQuotaResponse handles empty or missing groups gracefully', () => {
  const emptySnapshot = parseQuotaResponse({}, '2026-10-13T09:00:00.000Z');
  assert.equal(emptySnapshot.provider, 'antigravity-cli');
  assert.deepEqual(emptySnapshot.windows, []);
});
