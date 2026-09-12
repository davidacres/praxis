import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWaiverActive,
  filterUnwaivedFindings,
  validateFindingWaiver,
  composeWaiverRegisters,
  type FindingWaiver,
  type WaiverRegister
} from './waiverRegister';
import type { CheckFinding } from './workflowTypes';

test('validateFindingWaiver rejects missing or blank required fields', () => {
  assert.throws(
    () => validateFindingWaiver({ fingerprint: '', reason: 'ok', actor: 'alice', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z' }),
    /fingerprint is required/
  );
  assert.throws(
    () => validateFindingWaiver({ fingerprint: 'fp1', reason: '   ', actor: 'alice', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z' }),
    /reason is required/
  );
  assert.throws(
    () => validateFindingWaiver({ fingerprint: 'fp1', reason: 'False positive', actor: '', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z' }),
    /actor is required/
  );
  assert.throws(
    () => validateFindingWaiver({ fingerprint: 'fp1', reason: 'ok', actor: 'alice', createdAt: '2026-09-10T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' }),
    /expiresAt must be in the future/
  );
});

test('validateFindingWaiver enforces maxLifetimeDays cap', () => {
  // 15 days lifetime
  const waiver: FindingWaiver = {
    fingerprint: 'fp1',
    reason: 'Temporary test waiver',
    actor: 'alice',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-16T00:00:00Z'
  };

  assert.doesNotThrow(() => validateFindingWaiver(waiver, 30));
  assert.throws(() => validateFindingWaiver(waiver, 10), /exceeds maximum allowed lifetime of 10 days/);
});

test('isWaiverActive respects expiration date', () => {
  const waiver: FindingWaiver = {
    fingerprint: 'fp1',
    reason: 'Approved exemption',
    actor: 'security-team',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-10T00:00:00Z'
  };

  assert.strictEqual(isWaiverActive(waiver, '2026-09-05T00:00:00Z'), true);
  assert.strictEqual(isWaiverActive(waiver, '2026-09-10T00:00:00Z'), false);
  assert.strictEqual(isWaiverActive(waiver, '2026-09-15T00:00:00Z'), false);
});

test('isWaiverActive respects snapshot binding when present', () => {
  const waiverWithSnapshot: FindingWaiver = {
    fingerprint: 'fp1',
    reason: 'Approved for release branch commit',
    actor: 'lead-dev',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-10T00:00:00Z',
    snapshotRef: 'commit-sha-123'
  };

  assert.strictEqual(isWaiverActive(waiverWithSnapshot, '2026-09-05T00:00:00Z', 'commit-sha-123'), true);
  assert.strictEqual(isWaiverActive(waiverWithSnapshot, '2026-09-05T00:00:00Z', 'commit-sha-999'), false);
});

test('filterUnwaivedFindings filters out findings with active matching waivers', () => {
  const finding1: CheckFinding = {
    fingerprint: 'fp-critical-1',
    severity: 'critical',
    category: 'security',
    message: 'Hardcoded secret'
  };
  const finding2: CheckFinding = {
    fingerprint: 'fp-high-2',
    severity: 'high',
    category: 'security',
    message: 'SQL Injection'
  };

  const activeWaiver: FindingWaiver = {
    fingerprint: 'fp-critical-1',
    reason: 'Test dummy key',
    actor: 'lead-dev',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-10T00:00:00Z'
  };

  const { activeFindings, waivedFindings } = filterUnwaivedFindings(
    [finding1, finding2],
    [activeWaiver],
    '2026-09-05T00:00:00Z'
  );

  assert.strictEqual(activeFindings.length, 1);
  assert.strictEqual(activeFindings[0].fingerprint, 'fp-high-2');
  assert.strictEqual(waivedFindings.length, 1);
  assert.strictEqual(waivedFindings[0].fingerprint, 'fp-critical-1');
});

test('composeWaiverRegisters enforces strictest-wins lifetime cap', () => {
  const org: WaiverRegister = { waivers: [], maxLifetimeDays: 30 };
  const validProject: WaiverRegister = { waivers: [], maxLifetimeDays: 14 };
  const invalidProject: WaiverRegister = { waivers: [], maxLifetimeDays: 60 };

  const composed = composeWaiverRegisters(org, validProject);
  assert.strictEqual(composed.maxLifetimeDays, 14);

  assert.throws(
    () => composeWaiverRegisters(org, invalidProject),
    /exceeds organization ceiling/
  );
});
