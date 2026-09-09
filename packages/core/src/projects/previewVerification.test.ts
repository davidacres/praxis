import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAssertions,
  renderVerificationFailureContext,
  screenshotsMatch,
  summarizeOutcome,
  type PreviewAssertion,
  type PreviewVerificationCheck,
  type PreviewVerificationSnapshot
} from './previewVerification';

function snapshot(over: Partial<PreviewVerificationSnapshot> = {}): PreviewVerificationSnapshot {
  return { pageText: 'Welcome to the store', console: [], network: [], ...over };
}

function check(over: Partial<PreviewVerificationCheck> = {}): PreviewVerificationCheck {
  return { id: 'checkout-flow', name: 'Checkout flow', serviceId: 'web', path: '/checkout', interactions: [], assertions: [], ...over };
}

test('text-present passes when the text is on the page, fails when it is not', () => {
  const [present] = evaluateAssertions([{ kind: 'text-present', text: 'Welcome' }], snapshot());
  assert.equal(present.passed, true);
  const [missing] = evaluateAssertions([{ kind: 'text-present', text: 'Goodbye' }], snapshot());
  assert.equal(missing.passed, false);
});

test('text-absent is the inverse of text-present', () => {
  const [absent] = evaluateAssertions([{ kind: 'text-absent', text: 'Error 500' }], snapshot());
  assert.equal(absent.passed, true);
  const [present] = evaluateAssertions([{ kind: 'text-absent', text: 'Welcome' }], snapshot());
  assert.equal(present.passed, false);
});

test('no-console-errors passes with warnings/logs present but no errors, fails with an error', () => {
  const clean = snapshot({ console: [{ level: 'log', message: 'booting' }, { level: 'warning', message: 'slow' }] });
  assert.equal(evaluateAssertions([{ kind: 'no-console-errors' }], clean)[0].passed, true);
  const dirty = snapshot({ console: [{ level: 'error', message: 'TypeError: x is undefined' }] });
  const [result] = evaluateAssertions([{ kind: 'no-console-errors' }], dirty);
  assert.equal(result.passed, false);
  assert.match(result.detail, /TypeError: x is undefined/);
});

test('no-failed-requests passes with an empty network list, fails otherwise', () => {
  assert.equal(evaluateAssertions([{ kind: 'no-failed-requests' }], snapshot())[0].passed, true);
  const withFailure = snapshot({ network: [{ url: 'http://127.0.0.1:5000/api/orders', method: 'GET', status: 500 }] });
  const [result] = evaluateAssertions([{ kind: 'no-failed-requests' }], withFailure);
  assert.equal(result.passed, false);
  assert.match(result.detail, /orders/);
});

test('http-status passes when no matching failure is captured — a request that never failed leaves no trace to check', () => {
  const [result] = evaluateAssertions([{ kind: 'http-status', urlContains: '/api/orders', expectedStatus: 200 }], snapshot());
  assert.equal(result.passed, true);
  assert.match(result.detail, /assumed to have succeeded/);
});

test('http-status passes when the captured failure matches the expected status, fails otherwise', () => {
  const captured = snapshot({ network: [{ url: 'http://127.0.0.1:5000/api/orders', method: 'POST', status: 400 }] });
  const expected400 = evaluateAssertions([{ kind: 'http-status', urlContains: '/api/orders', expectedStatus: 400 }], captured);
  assert.equal(expected400[0].passed, true);
  const expected200 = evaluateAssertions([{ kind: 'http-status', urlContains: '/api/orders', expectedStatus: 200 }], captured);
  assert.equal(expected200[0].passed, false);
});

test('summarizeOutcome.passed is true only when every assertion passed', () => {
  const allPass = summarizeOutcome({
    checkId: 'c1',
    serviceId: 'web',
    capturedAt: '2026-09-09T00:00:00.000Z',
    results: [
      { assertion: { kind: 'no-console-errors' }, passed: true, detail: 'ok' },
      { assertion: { kind: 'no-failed-requests' }, passed: true, detail: 'ok' }
    ]
  });
  assert.equal(allPass.passed, true);

  const onePasses = summarizeOutcome({
    checkId: 'c1',
    serviceId: 'web',
    capturedAt: '2026-09-09T00:00:00.000Z',
    results: [
      { assertion: { kind: 'no-console-errors' }, passed: true, detail: 'ok' },
      { assertion: { kind: 'no-failed-requests' }, passed: false, detail: 'failed' }
    ]
  });
  assert.equal(onePasses.passed, false);
});

test('a screenshot that "differs" from the baseline never flips passed on its own', () => {
  const outcome = summarizeOutcome({
    checkId: 'c1',
    serviceId: 'web',
    capturedAt: '2026-09-09T00:00:00.000Z',
    results: [{ assertion: { kind: 'no-console-errors' }, passed: true, detail: 'ok' }],
    screenshot: { path: 'screenshot-1.png', baselineComparison: 'differs' }
  });
  assert.equal(outcome.passed, true, 'a differing screenshot must not fail an otherwise-passing check');
});

test('an outcome with zero assertions passes vacuously — a check with only interactions and no assertions is not a failure', () => {
  const outcome = summarizeOutcome({ checkId: 'c1', serviceId: 'web', capturedAt: '2026-09-09T00:00:00.000Z', results: [] });
  assert.equal(outcome.passed, true);
});

test('screenshotsMatch is a byte-identity check, not a similarity score', () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 4]);
  const c = Buffer.from([1, 2, 3, 5]);
  assert.equal(screenshotsMatch(a, b), true);
  assert.equal(screenshotsMatch(a, c), false);
});

test('screenshotsMatch treats different-length buffers as non-matching without throwing', () => {
  assert.equal(screenshotsMatch(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3, 4])), false);
});

test('renderVerificationFailureContext reports a pass plainly', () => {
  const outcome = summarizeOutcome({
    checkId: 'c1',
    serviceId: 'web',
    capturedAt: '2026-09-09T00:00:00.000Z',
    results: [{ assertion: { kind: 'no-console-errors' }, passed: true, detail: 'ok' }]
  });
  assert.match(renderVerificationFailureContext(check(), outcome), /passed — no failure context/);
});

test('renderVerificationFailureContext lists only the failed assertions, with their own detail', () => {
  const assertions: PreviewAssertion[] = [{ kind: 'no-console-errors' }, { kind: 'no-failed-requests' }];
  const results = evaluateAssertions(
    assertions,
    snapshot({ console: [{ level: 'error', message: 'boom' }], network: [] })
  );
  const outcome = summarizeOutcome({ checkId: 'c1', serviceId: 'web', capturedAt: '2026-09-09T00:00:00.000Z', results });
  const text = renderVerificationFailureContext(check({ assertions }), outcome);
  assert.match(text, /failed \(service: web, path: \/checkout\)/);
  assert.match(text, /1 of 2 assertion\(s\) failed/);
  assert.match(text, /no console errors: .*boom/);
  assert.doesNotMatch(text, /no failed requests:/); // the passing assertion is not listed as a failure
});

test('renderVerificationFailureContext notes a differing screenshot without treating it as the failure reason', () => {
  const results = [{ assertion: { kind: 'no-console-errors' as const }, passed: false, detail: 'boom' }];
  const outcome = summarizeOutcome({
    checkId: 'c1',
    serviceId: 'web',
    capturedAt: '2026-09-09T00:00:00.000Z',
    results,
    screenshot: { path: 'screenshot-1.png', baselineComparison: 'differs' }
  });
  const text = renderVerificationFailureContext(check(), outcome);
  assert.match(text, /differs from the stored baseline/);
});
